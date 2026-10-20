import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { runtimeFor, type Runtime } from "../runtime.ts";
import type { Executor } from "../types.ts";
import { LocalExecutor } from "../exec/local.ts";
import { localLayers, missingLayers } from "./layers.ts";
import { buildOciDelta } from "./oci.ts";

/**
 * `--local-image` over the engine API: send only the layers the host lacks as
 * an OCI-layout delta. If the engine cannot resolve an omitted blob, fall back
 * to the full save stream exactly once. The legacy `--via cli` pipeline never
 * enters this module.
 */

export interface TransferReport {
  mode: "delta" | "full";
  /** Bytes written to the load request (delta tar or full save stream). */
  bytesSent: number;
  layersReused: number;
  layersTotal: number;
  missingLayers: number;
  /** Why the full archive was sent, when mode is "full". */
  fallback?: string;
}

export interface TransferOps {
  imageLayers(): Promise<ReadonlySet<string> | readonly string[]>;
  loadImage(stream: NodeJS.ReadableStream): Promise<void>;
}

export interface SaveStream {
  stream: Readable;
  /** Resolves when the local save process exits successfully. */
  done: Promise<void>;
}

export interface TransferOptions {
  rt: Runtime;
  /** Test seam: local image inspection (defaults to the local shell). */
  local?: Executor;
  /** Test seam: produce a save stream for a ref. */
  openSave?: (ref: string, rt: Runtime) => SaveStream;
}

export interface LocalImage {
  rt: Runtime;
  layers: string[];
}

/**
 * The local image may live in the other engine than the host runs (a docker
 * build pushed to a podman host is the normal case). Prefer the configured
 * runtime, then the other one; the save stream must come from the same engine
 * that answered the layer inventory.
 */
export async function resolveLocalImage(
  ref: string,
  rt: Runtime,
  exec: Executor = new LocalExecutor(),
): Promise<LocalImage> {
  const other = runtimeFor(rt.kind === "docker" ? "podman" : "docker");
  let last: unknown;
  for (const candidate of [rt, other]) {
    try {
      const layers = await localLayers(ref, candidate, exec);
      if (layers.length > 0) return { rt: candidate, layers };
      last = new Error("image has no layers");
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    "local image not found in docker or podman: " + ref +
      (last instanceof Error ? " (" + last.message + ")" : ""),
  );
}

/** Spawn `<runtime> save [--format ...] <ref>` and expose its stdout as a stream. */
export function spawnSaveStream(ref: string, rt: Runtime): SaveStream {
  const args = ["save", ...rt.saveFormatArgs, ref];
  const child = spawn(rt.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdout === null) throw new Error("cannot capture " + rt.bin + " save output");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            "local image save failed (exit " + String(code) + ")" +
              (stderr.trim() !== "" ? ": " + stderr.trim() : ""),
          ),
        );
      }
    });
  });
  done.catch(() => child.stdout?.destroy());
  return { stream: child.stdout, done };
}

export interface CountedStream {
  stream: Readable;
  bytes(): number;
}

/** Pass a stream through while counting what was actually sent. */
export function countStream(source: Readable): CountedStream {
  let sent = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      cb(null, chunk);
    },
  });
  source.pipe(tap);
  source.once("error", (err) => tap.destroy(err));
  return { stream: tap, bytes: () => sent };
}

/** A missing blob is the one engine error we retry with the full archive. */
export function isMissingBlobError(err: unknown): boolean {
  const text = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (text.includes("config references layer")) return true;
  const subject = /(blob|layer|content digest|digest)/.test(text);
  const absent = /(not ?found|missing|absent|no such)/.test(text);
  return subject && absent;
}

export async function transferLocalImage(
  ops: TransferOps,
  ref: string,
  opts: TransferOptions,
): Promise<TransferReport> {
  const local = opts.local ?? new LocalExecutor();
  const resolved = await resolveLocalImage(ref, opts.rt, local);
  const localIds = resolved.layers;
  const host = await ops.imageLayers();
  const delta = missingLayers(localIds, host);
  const openSave =
    opts.openSave ?? ((image: string, localRt: Runtime) => spawnSaveStream(image, localRt));

  const first = openSave(ref, resolved.rt);
  const built = buildOciDelta(first.stream, { have: host, ref });
  try {
    await ops.loadImage(built.stream);
    const stats = await built.result;
    await first.done;
    return {
      mode: "delta",
      bytesSent: stats.bytesSent,
      layersReused: stats.layersReused,
      layersTotal: stats.layersTotal,
      missingLayers: stats.missingLayers.length,
    };
  } catch (err) {
    const settled = built.result.catch(() => undefined);
    built.stream.destroy();
    first.stream.destroy();
    await first.done.catch(() => undefined);
    await settled;
    if (!isMissingBlobError(err)) throw err;

    // The host refused an omitted blob: send the complete archive once.
    const full = openSave(ref, resolved.rt);
    const counted = countStream(full.stream);
    await ops.loadImage(counted.stream);
    await full.done;
    return {
      mode: "full",
      bytesSent: counted.bytes(),
      layersReused: 0,
      layersTotal: delta.total,
      missingLayers: delta.total,
      fallback: err instanceof Error ? err.message : String(err),
    };
  }
}
