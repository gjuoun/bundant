import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { normalizeLayerId } from "./layers.ts";

/**
 * Turn a local `docker save` / `podman save` stream into an OCI-layout archive
 * that references every layer of the image but carries blob files only for the
 * layers the destination engine lacks. The engine resolves the omitted blobs
 * from its own store by diffID (proven on docker 29 and podman 5.7).
 *
 * The tar is produced as it is read: layers are spooled one at a time (so a
 * layer can be measured before its bytes are emitted), metadata is emitted last
 * because the OCI tar reader seeks by member name.
 */

export interface DeltaBuildOptions {
  /** Layer diffIDs the host already holds. */
  have: ReadonlySet<string> | readonly string[];
  /** Image ref used for the index annotations ("app:t1"). */
  ref: string;
}

export interface DeltaStats {
  layersTotal: number;
  layersReused: number;
  /** diffIDs of the layer blobs actually written. */
  missingLayers: string[];
  /** Bytes produced on the delta tar stream (headers, blobs and metadata). */
  bytesSent: number;
}

export interface DeltaArchive {
  /** Consume this with the engine's image load. */
  stream: Readable;
  /**
   * The exact tar length. Resolves after the save stream has been read and
   * spooled (before the first output byte), so the load request can carry a
   * Content-Length - docker 29 does not answer a chunked image load.
   */
  length: Promise<number>;
  /** Resolves after the stream ends; rejects when the archive is invalid. */
  result: Promise<DeltaStats>;
}

const BLOCK = 512;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

interface TarEntryHeader {
  name: string;
  size: number;
  type: string;
}

function cstring(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function parseOctal(buf: Buffer, start: number, length: number): number {
  const text = cstring(buf, start, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseHeader(block: Buffer): TarEntryHeader | null {
  if (block.length < BLOCK) return null;
  let zero = true;
  for (const byte of block) {
    if (byte !== 0) {
      zero = false;
      break;
    }
  }
  if (zero) return null;
  const prefix = cstring(block, 345, 155);
  const base = cstring(block, 0, 100);
  return {
    name: prefix === "" ? base : prefix + "/" + base,
    size: parseOctal(block, 124, 12),
    type: String.fromCharCode(block[156] ?? 48),
  };
}

function padding(size: number): number {
  const rest = size % BLOCK;
  return rest === 0 ? 0 : BLOCK - rest;
}

class ByteReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffer = Buffer.alloc(0);
  private ended = false;

  constructor(input: NodeJS.ReadableStream) {
    this.iterator = (input as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  }

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done === true) {
      this.ended = true;
      return false;
    }
    const chunk = next.value;
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    ]);
    return true;
  }

  async readUpTo(n: number): Promise<Buffer> {
    while (this.buffer.length < n && !this.ended) await this.pull();
    const take = Math.min(n, this.buffer.length);
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  async readExactly(n: number): Promise<Buffer> {
    const out: Buffer[] = [];
    let left = n;
    while (left > 0) {
      const piece = await this.readUpTo(left);
      if (piece.length === 0) throw new Error("delta archive: save stream ended mid-entry");
      out.push(piece);
      left -= piece.length;
    }
    return Buffer.concat(out);
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const piece = await this.readUpTo(Math.min(left, 64 * 1024));
      if (piece.length === 0) throw new Error("delta archive: save stream ended mid-entry");
      left -= piece.length;
    }
  }
}

class TarBody {
  private remaining: number;
  private prefix = Buffer.alloc(0);
  private readonly reader: ByteReader;

  constructor(reader: ByteReader, size: number) {
    this.reader = reader;
    this.remaining = size;
  }

  async peek(n: number): Promise<Buffer> {
    const want = Math.min(n, this.remaining);
    if (this.prefix.length < want) {
      const extra = await this.reader.readUpTo(want - this.prefix.length);
      this.prefix = Buffer.concat([this.prefix, extra]);
    }
    return this.prefix;
  }

  async *chunks(): AsyncGenerator<Buffer> {
    if (this.prefix.length > 0) {
      const first = this.prefix;
      this.prefix = Buffer.alloc(0);
      this.remaining -= first.length;
      yield first;
    }
    while (this.remaining > 0) {
      const chunk = await this.reader.readUpTo(Math.min(64 * 1024, this.remaining));
      if (chunk.length === 0) throw new Error("delta archive: save stream ended mid-layer");
      this.remaining -= chunk.length;
      yield chunk;
    }
  }

  async discard(): Promise<void> {
    this.remaining -= this.prefix.length;
    this.prefix = Buffer.alloc(0);
    await this.reader.skip(this.remaining);
    this.remaining = 0;
  }
}

function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length).toString("utf8").replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset += length;
  }
  return undefined;
}

async function readTar(
  input: NodeJS.ReadableStream,
  onFile: (header: TarEntryHeader, body: TarBody) => Promise<void>,
): Promise<void> {
  const reader = new ByteReader(input);
  let longName: string | undefined;
  let pendingPath: string | undefined;
  for (;;) {
    const block = await reader.readUpTo(BLOCK);
    if (block.length === 0) return;
    if (block.length < BLOCK) throw new Error("delta archive: truncated tar header");
    const header = parseHeader(block);
    if (header === null) return;
    const body = new TarBody(reader, header.size);
    const type = header.type;
    if (type === "x" || type === "X") {
      const data = await reader.readExactly(header.size);
      const path = paxPath(data);
      if (path !== undefined) pendingPath = path;
      await reader.skip(padding(header.size));
      continue;
    }
    if (type === "L") {
      const data = await reader.readExactly(header.size);
      longName = data.toString("utf8").replace(/\0+$/, "").replace(/\n$/, "");
      await reader.skip(padding(header.size));
      continue;
    }
    if (type === "g") {
      await body.discard();
      await reader.skip(padding(header.size));
      continue;
    }
    const name = pendingPath ?? longName ?? header.name;
    pendingPath = undefined;
    longName = undefined;
    if (type === "0" || type === "\0" || type === "7" || type === "") {
      await onFile({ name, size: header.size, type }, body);
    }
    await body.discard();
    await reader.skip(padding(header.size));
  }
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(name: string, size: number, mode = 0o644): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "utf8");
  header.write(octal(0, 8), 108, 8, "utf8");
  header.write(octal(0, 8), 116, 8, "utf8");
  header.write(octal(size, 13), 124, 13, "utf8");
  header.write(octal(0, 13), 136, 13, "utf8");
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // regular file
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  header.write("root", 265, 32, "utf8");
  header.write("root", 297, 32, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "utf8");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

class TarWriter {
  private readonly out: PassThrough;
  private readonly count = { bytes: 0 };

  constructor(out: PassThrough, count: { bytes: number }) {
    this.out = out;
    this.count = count;
  }

  private async write(buf: Buffer): Promise<void> {
    if (this.out.destroyed) throw new Error("delta archive consumer closed");
    this.count.bytes += buf.length;
    // The write callback fires when the chunk is flushed (or fails). Unlike a
    // drain listener it cannot hang if the consumer destroyed the stream.
    await new Promise<void>((resolve, reject) => {
      this.out.write(buf, (err) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve();
      });
    });
  }

  async addBuffer(name: string, data: Buffer, mode = 0o644): Promise<void> {
    await this.write(tarHeader(name, data.length, mode));
    await this.write(data);
    const pad = padding(data.length);
    if (pad > 0) await this.write(Buffer.alloc(pad, 0));
  }

  async addFile(name: string, path: string, size: number, mode = 0o644): Promise<void> {
    await this.write(tarHeader(name, size, mode));
    let written = 0;
    for await (const chunk of createReadStream(path)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      written += buf.length;
      await this.write(buf);
    }
    if (written !== size) throw new Error("delta archive: layer temp file changed size");
    const pad = padding(size);
    if (pad > 0) await this.write(Buffer.alloc(pad, 0));
  }

  async end(): Promise<void> {
    await this.write(Buffer.alloc(BLOCK * 2, 0));
    // Standard tar records are padded to 10 KiB; containers/image is happy
    // without it, but the canonical layout is friendlier to other readers.
    const rest = this.count.bytes % (20 * BLOCK);
    if (rest !== 0) await this.write(Buffer.alloc(20 * BLOCK - rest, 0));
  }
}

interface LayerRecord {
  diffId: string;
  digest: string;
  size: number;
  gzip: boolean;
  tempPath: string;
  kept: boolean;
}

function tagOf(ref: string): string {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(colon + 1) : "latest";
}

function readJsonConfig(bytes: Buffer): { diffIds: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rootfs = (parsed as { rootfs?: { diff_ids?: unknown } }).rootfs;
  if (typeof rootfs !== "object" || rootfs === null || !Array.isArray(rootfs.diff_ids)) return null;
  const diffIds = rootfs.diff_ids.filter((id): id is string => typeof id === "string");
  return diffIds.length === 0 ? null : { diffIds: diffIds.map(normalizeLayerId) };
}

function isLayerName(name: string): boolean {
  if (name.startsWith("blobs/sha256/")) return true;
  if (/^[0-9a-f]{64}\.tar$/.test(name)) return true;
  if (/^[0-9a-f]{64}\/layer\.tar$/.test(name)) return true;
  return false;
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      stream.off("drain", onDrain);
      reject(err);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function spoolLayer(
  body: TarBody,
  dir: string,
  index: number,
): Promise<LayerRecord> {
  const head = await body.peek(2);
  const gzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const tempPath = join(dir, "layer-" + index + ".blob");
  const compressedHash = createHash("sha256");
  const plainHash = createHash("sha256");
  let compressedSize = 0;

  const file = createWriteStream(tempPath, { mode: 0o600 });
  const gunzip = gzip ? createGunzip() : null;
  let plainDone: Promise<void> = Promise.resolve();
  if (gunzip !== null) {
    gunzip.on("data", (chunk: Buffer) => plainHash.update(chunk));
    plainDone = new Promise<void>((resolve, reject) => {
      gunzip.once("end", resolve);
      gunzip.once("error", reject);
    });
  }

  for await (const chunk of body.chunks()) {
    compressedHash.update(chunk);
    compressedSize += chunk.length;
    await writeChunk(file, chunk);
    if (gunzip !== null) await writeChunk(gunzip, chunk);
  }
  await new Promise<void>((resolve, reject) => {
    file.once("error", reject);
    file.end(resolve);
  });
  if (gunzip !== null) {
    gunzip.end();
    await plainDone;
  }

  const digest = "sha256:" + compressedHash.digest("hex");
  return {
    diffId: gzip ? "sha256:" + plainHash.digest("hex") : digest,
    digest,
    size: compressedSize,
    gzip,
    tempPath,
    kept: false,
  };
}

async function assemble(
  input: NodeJS.ReadableStream,
  out: PassThrough,
  opts: DeltaBuildOptions,
  lengthSignal: { resolve: (value: number) => void; reject: (err: Error) => void },
): Promise<DeltaStats> {
  const have = opts.have instanceof Set
    ? (opts.have as ReadonlySet<string>)
    : new Set((opts.have as readonly string[]).map(normalizeLayerId));

  const dir = await mkdtemp(join(tmpdir(), "bundant-delta-"));
  const counter = { bytes: 0 };
  const writer = new TarWriter(out, counter);
  const layers: LayerRecord[] = [];
  const captured: { configBytes: Buffer | null; configDigest: string } = {
    configBytes: null,
    configDigest: "",
  };
  let layerIndex = 0;

  try {
    await readTar(input, async (header, body) => {
      const name = header.name;
      if (name === "manifest.json" || name === "index.json" || name === "oci-layout") {
        return; // regenerated below; the legacy path would demand every layer file
      }
      if (name === "repositories" || name === "VERSION" || header.size === 0) return;

      const head = await body.peek(1);
      const isJson = head.length > 0 && head[0] === 0x7b;
      const layerCandidate = (isLayerName(name) || name.endsWith(".tar")) && !isJson;
      if (layerCandidate) {
        const record = await spoolLayer(body, dir, layerIndex++);
        record.kept = !have.has(record.diffId);
        layers.push(record);
        return;
      }

      // A JSON payload is metadata (image config, index, manifest, attestation);
      // only the image config carries rootfs.diff_ids and is kept.
      if (header.size > MAX_METADATA_BYTES) return;
      const chunks: Buffer[] = [];
      for await (const chunk of body.chunks()) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) return;
      const parsed = readJsonConfig(bytes);
      if (parsed !== null) {
        captured.configBytes = bytes;
        captured.configDigest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      }
    });

    const configBytes: Buffer | null = captured.configBytes;
    const configDigest = captured.configDigest;
    if (configBytes === null) {
      throw new Error("delta archive: save stream carried no image config (rootfs.diff_ids)");
    }
    const config = readJsonConfig(configBytes);
    if (config === null) throw new Error("delta archive: image config has no rootfs diff ids");

    const byDiffId = new Map<string, LayerRecord>();
    for (const layer of layers) byDiffId.set(layer.diffId, layer);
    const ordered: LayerRecord[] = [];
    for (const diffId of config.diffIds) {
      const record = byDiffId.get(diffId);
      if (record === undefined) {
        throw new Error(
          "delta archive: config references layer " + diffId +
            " that the save stream did not contain",
        );
      }
      ordered.push(record);
    }

    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: configBytes.length,
      },
      layers: ordered.map((layer) => ({
        mediaType: layer.gzip
          ? "application/vnd.oci.image.layer.v1.tar+gzip"
          : "application/vnd.oci.image.layer.v1.tar",
        digest: layer.digest,
        size: layer.size,
      })),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestDigest = "sha256:" + createHash("sha256").update(manifestBytes).digest("hex");
    const tag = tagOf(opts.ref);
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: manifest.mediaType,
          digest: manifestDigest,
          size: manifestBytes.length,
          annotations: {
            "io.containerd.image.name": opts.ref,
            "org.opencontainers.image.ref.name": tag,
          },
        },
      ],
    };

    const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
    const layoutBytes = Buffer.from(
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
      "utf8",
    );
    const keptLayers = layers.filter((layer) => layer.kept);
    const padded = (n: number): number => n + (n % BLOCK === 0 ? 0 : BLOCK - (n % BLOCK));
    let dataBytes = 0;
    for (const layer of keptLayers) dataBytes += BLOCK + padded(layer.size);
    for (const meta of [configBytes, manifestBytes, indexBytes, layoutBytes]) {
      dataBytes += BLOCK + padded(meta.length);
    }
    const bodyBytes = dataBytes + BLOCK * 2;
    const endPad = (20 * BLOCK - (bodyBytes % (20 * BLOCK))) % (20 * BLOCK);
    const totalBytes = bodyBytes + endPad;
    lengthSignal.resolve(totalBytes);

    for (const layer of keptLayers) {
      await writer.addFile(
        "blobs/sha256/" + layer.digest.slice(7),
        layer.tempPath,
        layer.size,
      );
    }
    await writer.addBuffer("blobs/sha256/" + configDigest.slice(7), configBytes);
    await writer.addBuffer("blobs/sha256/" + manifestDigest.slice(7), manifestBytes);
    await writer.addBuffer("index.json", indexBytes);
    await writer.addBuffer("oci-layout", layoutBytes);
    await writer.end();
    out.end();
    if (counter.bytes !== totalBytes) {
      throw new Error(
        "delta archive: computed length " + totalBytes + " but wrote " + counter.bytes,
      );
    }

    const missing = ordered.filter((layer) => layer.kept).map((layer) => layer.diffId);
    return {
      layersTotal: ordered.length,
      layersReused: ordered.length - missing.length,
      missingLayers: missing,
      bytesSent: counter.bytes,
    };
  } catch (err) {
    lengthSignal.reject(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function buildOciDelta(
  input: NodeJS.ReadableStream,
  opts: DeltaBuildOptions,
): DeltaArchive {
  const stream = new PassThrough();
  // A consumer that aborts (load error) destroys the stream; keep that error
  // from becoming an unhandled emitter event - result still rejects.
  stream.on("error", () => undefined);
  let resolveLength: (value: number) => void = () => undefined;
  let rejectLength: (err: Error) => void = () => undefined;
  const length = new Promise<number>((resolve, reject) => {
    resolveLength = resolve;
    rejectLength = reject;
  });
  const result = assemble(input, stream, opts, { resolve: resolveLength, reject: rejectLength })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!stream.destroyed) stream.destroy(error);
      rejectLength(error);
      throw error;
    });
  return { stream, length, result };
}

