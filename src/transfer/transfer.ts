import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { runtimeFor, type Runtime } from "../runtime.ts";
import type { Executor } from "../types.ts";
import { LocalExecutor } from "../exec/local.ts";
import { localLayers, missingLayers } from "./layers.ts";
import { buildOciDelta, type DeltaStats } from "./oci.ts";

/**
 * `--local-image` over the engine API: send only the layers the host lacks as
 * an OCI-layout delta. If the engine cannot resolve an omitted blob, fall back
 * to the complete OCI archive exactly once. The full-archive pipeline
 * never enters this module.
 */

export interface TransferReport {
  mode: "delta" | "full";
  /** Bytes written to the load request (delta tar or complete OCI archive). */
  bytesSent: number;
  layersReused: number;
  layersTotal: number;
  missingLayers: number;
  /** Why the complete archive was sent, when mode is "full". */
  fallback?: string;
  /** The engine id the deploy creates containers from (create-by-tag can 404). */
  imageId?: string;
}

export interface TransferOps {
  imageLayers(): Promise<ReadonlySet<string> | readonly string[]>;
  loadImage(
    stream: NodeJS.ReadableStream,
    opts?: { contentLength?: number },
  ): Promise<void>;
  /** Optional readiness probe: some engines acknowledge load before the tag is visible. */
  imagePresent?(ref: string): Promise<boolean>;
  /** Optional id lookup; docker 29 can list a tag it refuses to resolve by name. */
  imageId?(ref: string): Promise<string | undefined>;
}

/**
 * Wait for the tag to be visible, then resolve its engine id. The id is what
 * container creation must use: docker 29 with the containerd store lists the
 * short tag but answers 404 for GET /images/<tag>/json and create by tag.
 */
async function waitForImage(ops: TransferOps, ref: string): Promise<string | undefined> {
  let visible = ops.imagePresent === undefined;
  const deadline = Date.now() + 5_000;
  while (!visible && Date.now() < deadline) {
    if (await ops.imagePresent!(ref)) visible = true;
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!visible) throw new Error("image load completed but the engine never exposed " + ref);
  return ops.imageId === undefined ? undefined : await ops.imageId(ref);
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

/** A missing blob is the one engine error we retry with the complete archive. */
export function isMissingBlobError(err: unknown): boolean {
  const text = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (text.includes("config references layer")) return true;
  const subject = /(blob|layer|content digest|digest)/.test(text);
  const absent = /(not ?found|missing|absent|no such)/.test(text);
  return subject && absent;
}

const EMPTY_STATS: DeltaStats = {
  layersTotal: 0,
  layersReused: 0,
  missingLayers: [],
  bytesSent: 0,
};

interface LoadResult {
  stats: DeltaStats;
  imageId?: string;
  failure?: unknown;
}

/** One load attempt: build an OCI archive for `have`, stream it with its length. */
async function loadArchive(
  ops: TransferOps,
  ref: string,
  save: SaveStream,
  have: ReadonlySet<string> | readonly string[],
): Promise<LoadResult> {
  const built = buildOciDelta(save.stream, { have, ref });
  try {
    const contentLength = await built.length;
    await ops.loadImage(built.stream, { contentLength });
    const stats = await built.result;
    // The tar reader stops at the archive's first zero block; drain whatever
    // padding remains so the save process is not left blocked on a full pipe.
    save.stream.resume();
    await save.done;
    const imageId = await waitForImage(ops, ref);
    return { stats, imageId };
  } catch (err) {
    const settled = built.result.catch(() => undefined);
    built.length.catch(() => undefined);
    built.stream.destroy(new Error("transfer aborted"));
    save.stream.destroy();
    await save.done.catch(() => undefined);
    await settled;
    return { stats: EMPTY_STATS, failure: err };
  }
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

  const first = await loadArchive(ops, ref, openSave(ref, resolved.rt), host);
  if (first.failure === undefined) {
    return {
      mode: "delta",
      bytesSent: first.stats.bytesSent,
      layersReused: first.stats.layersReused,
      layersTotal: first.stats.layersTotal,
      missingLayers: first.stats.missingLayers.length,
      ...(first.imageId !== undefined ? { imageId: first.imageId } : {}),
    };
  }
  if (!isMissingBlobError(first.failure)) throw first.failure;

  // The host refused an omitted blob: send every layer once, through the same
  // builder (so the request still carries an exact Content-Length).
  const full = await loadArchive(ops, ref, openSave(ref, resolved.rt), []);
  if (full.failure !== undefined) throw full.failure;
  return {
    mode: "full",
    bytesSent: full.stats.bytesSent,
    layersReused: 0,
    layersTotal: full.stats.layersTotal || delta.total,
    missingLayers: full.stats.missingLayers.length || delta.total,
    fallback: first.failure instanceof Error ? first.failure.message : String(first.failure),
    ...(full.imageId !== undefined ? { imageId: full.imageId } : {}),
  };
}
