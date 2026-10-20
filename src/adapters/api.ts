import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";

/**
 * One HTTP client for both engines. The ladder lives here and nowhere else:
 * dockerode when it can be resolved at runtime (absent by default), otherwise
 * node:http over the forwarded unix socket. The native path is the contract -
 * it works under bun and node with zero new dependencies.
 */

export type ApiDriver = "dockerode" | "native";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, body: unknown) {
    const detail =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message?: unknown }).message ?? "")
        : "";
    super("engine API " + method + " " + path + " -> " + status + (detail !== "" ? ": " + detail : ""));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
  }
}

export type QueryValue = string | number | boolean | undefined | string[];
export type ApiQuery = Record<string, QueryValue>;

export interface ApiResponse {
  status: number;
  json: unknown;
  /** Always null for buffered requests; streaming endpoints use requestStream(). */
  stream: Readable | null;
}

export interface ApiClientOptions {
  socketPath: string;
  /** Set false to force the native path (tests, or when dockerode is suspect). */
  preferDockerode?: boolean;
}

interface DockerodeCtor {
  new (opts: { socketPath: string }): unknown;
}

const REQUIRE = createRequire(import.meta.url);

/**
 * Resolve dockerode without making it a dependency. A variable specifier keeps
 * bundlers from trying to resolve it at build time, so the packed CLI works
 * with dockerode absent.
 */
async function resolveDockerode(socketPath: string): Promise<unknown | null> {
  if (process.env.BUNDANT_NO_DOCKERODE === "1") return null;
  try {
    REQUIRE.resolve("dockerode");
    const specifier = "dockerode";
    const mod = (await import(specifier)) as { default?: unknown };
    const Ctor = (mod.default ?? mod) as DockerodeCtor;
    return new Ctor({ socketPath });
  } catch {
    return null;
  }
}

function buildQuery(query?: ApiQuery): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : "?" + text;
}

async function readBody(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseBody(buf: Buffer, contentType: string | undefined): unknown {
  const text = buf.toString("utf8");
  if (text === "") return null;
  if (contentType !== undefined && contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ApiClient {
  readonly socketPath: string;
  readonly driver: ApiDriver;
  /**
   * The dockerode handle when the ladder chose it. Stage 1's generic request()
   * stays on node:http either way - dockerode exposes no generic HTTP request,
   * so the typed client is surfaced for later stages that use its model API.
   */
  readonly dockerode: unknown;

  private constructor(socketPath: string, driver: ApiDriver, dockerode: unknown) {
    this.socketPath = socketPath;
    this.driver = driver;
    this.dockerode = dockerode;
  }

  static async create(opts: ApiClientOptions): Promise<ApiClient> {
    if (opts.preferDockerode === false) {
      return new ApiClient(opts.socketPath, "native", null);
    }
    const dockerode = await resolveDockerode(opts.socketPath);
    return dockerode === null
      ? new ApiClient(opts.socketPath, "native", null)
      : new ApiClient(opts.socketPath, "dockerode", dockerode);
  }

  /** Buffered JSON request. Non-2xx JSON bodies become typed ApiErrors. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    query?: ApiQuery,
  ): Promise<ApiResponse> {
    const res = await this.send(method, path, body, query, true);
    const buf = await readBody(res);
    const json = parseBody(buf, res.headers["content-type"]);
    if (res.statusCode === undefined || res.statusCode >= 400) {
      throw new ApiError(method, path, res.statusCode ?? 0, json);
    }
    return { status: res.statusCode, json, stream: null };
  }

  /** Streaming request (logs, events, image load) - the caller owns the stream. */
  async requestStream(
    method: string,
    path: string,
    body?: unknown,
    query?: ApiQuery,
  ): Promise<IncomingMessage> {
    const res = await this.send(method, path, body, query, false);
    if (res.statusCode !== undefined && res.statusCode >= 400) {
      const buf = await readBody(res);
      throw new ApiError(method, path, res.statusCode, parseBody(buf, res.headers["content-type"]));
    }
    return res;
  }

  /**
   * Streaming request whose body is a readable stream (image load). The body
   * is sent chunked, so the caller does not need to know its length first.
   */
  async requestBody(
    method: string,
    path: string,
    body: Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<Readable> {
    const res = await rawBodyRequest(
      this.socketPath,
      method,
      path,
      body,
      contentType,
      contentLength,
    );
    if (res.status >= 400) {
      const buf = await readBody(res.stream as unknown as IncomingMessage);
      throw new ApiError(method, path, res.status, parseBody(buf, res.headers["content-type"]));
    }
    return res.stream;
  }

  async close(): Promise<void> {
    const handle = this.dockerode as { destroy?: () => void } | null;
    try {
      handle?.destroy?.();
    } catch {
      // Closing the typed client is best-effort; the socket forward owns the fd.
    }
  }

  private send(
    method: string,
    path: string,
    body: unknown,
    query: ApiQuery | undefined,
    buffered: boolean,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = {};
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      const req = http.request(
        { socketPath: this.socketPath, method, path: path + buildQuery(query), headers },
        (res) => resolve(res),
      );
      req.on("error", (err) => {
        void normalizeConnectError(err, this.socketPath).then(reject);
      });
      if (buffered) {
        req.setTimeout(30_000, () => req.destroy(new Error("engine API timeout: " + method + " " + path)));
      }
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

/**
 * Bun reports every unix-socket connect failure as "FailedToOpenSocket", which
 * cannot distinguish "no socket" from "nobody listening". Stat the path so the
 * detector can tell absent from inactive on both runtimes.
 */
async function normalizeConnectError(err: Error, socketPath: string): Promise<Error> {
  const coded = err as NodeJS.ErrnoException;
  if (coded.code !== undefined && coded.code !== "FailedToOpenSocket") return err;
  try {
    await stat(socketPath);
    coded.code = "ECONNREFUSED";
  } catch {
    coded.code = "ENOENT";
  }
  return err;
}

export interface DemuxFrame {
  stream: "stdout" | "stderr";
  data: Buffer;
}

const FRAME_HEADER = 8;

function frameHeader(chunk: Buffer, offset: number): DemuxFrame | null {
  if (offset + FRAME_HEADER > chunk.length) return null;
  const type = chunk[offset] ?? 0;
  if (type !== 0 && type !== 1 && type !== 2) return null;
  const size = chunk.readUInt32BE(offset + 4);
  if (offset + FRAME_HEADER + size > chunk.length) return null;
  const data = chunk.subarray(offset + FRAME_HEADER, offset + FRAME_HEADER + size);
  return { stream: type === 2 ? "stderr" : "stdout", data };
}

/**
 * Round-trip the 8-byte Docker stream frames ([type,0,0,0,size:uint32be]).
 * Non-multiplexed output (a TTY-attached stream) is returned as one stdout frame.
 */
export function demuxDockerStream(buf: Buffer): DemuxFrame[] {
  const frames: DemuxFrame[] = [];
  let offset = 0;
  while (offset + FRAME_HEADER <= buf.length) {
    if (buf[offset] !== 0 && buf[offset] !== 1 && buf[offset] !== 2) {
      return [{ stream: "stdout", data: buf.subarray(offset) }];
    }
    const frame = frameHeader(buf, offset);
    if (frame === null) break;
    frames.push(frame);
    offset += FRAME_HEADER + frame.data.length;
  }
  if (frames.length === 0) return buf.length === 0 ? [] : [{ stream: "stdout", data: buf }];
  return frames;
}

/** Incremental demuxer for chunked stdout/stderr streams (logs -f). */
export class DockerStreamDemuxer {
  private buffer = Buffer.alloc(0);
  private raw = false;

  push(chunk: Buffer): DemuxFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DemuxFrame[] = [];
    if (this.raw) {
      if (this.buffer.length > 0) frames.push({ stream: "stdout", data: this.buffer });
      this.buffer = Buffer.alloc(0);
      return frames;
    }
    while (this.buffer.length >= FRAME_HEADER) {
      const type = this.buffer[0] ?? 0;
      if (type !== 0 && type !== 1 && type !== 2) {
        this.raw = true;
        frames.push({ stream: "stdout", data: this.buffer });
        this.buffer = Buffer.alloc(0);
        return frames;
      }
      const size = this.buffer.readUInt32BE(4);
      if (this.buffer.length < FRAME_HEADER + size) break;
      const data = this.buffer.subarray(FRAME_HEADER, FRAME_HEADER + size);
      frames.push({ stream: type === 2 ? "stderr" : "stdout", data });
      this.buffer = this.buffer.subarray(FRAME_HEADER + size);
    }
    return frames;
  }

  flush(): DemuxFrame[] {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest.length === 0 ? [] : [{ stream: "stdout", data: rest }];
  }
}

/** Adapt a multiplexed response body to frames, buffering partial headers. */
export async function* demuxStream(source: Readable): AsyncGenerator<DemuxFrame> {
  const demuxer = new DockerStreamDemuxer();
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    for (const frame of demuxer.push(buf)) yield frame;
  }
  for (const frame of demuxer.flush()) yield frame;
}

export const DOCKER_FRAME_HEADER_BYTES = FRAME_HEADER;

// ---------------------------------------------------------------------------
// Streaming request bodies (image load)
//
// node:http under bun buffers a piped readable before it sends, which defeats
// a streamed image transfer. This raw HTTP/1.1 request writes real chunked
// frames as the producer yields, and decodes a chunked response back into a
// Readable. It is deliberately narrow: one request/response pair, Connection:
// close, no keep-alive.

async function writeAll(socket: net.Socket, buf: Buffer): Promise<void> {
  if (socket.write(buf)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off("drain", onDrain);
      reject(err);
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
  });
}

interface ResponseHead {
  status: number;
  headers: Record<string, string>;
}

function parseResponseHead(buf: Buffer): { head: ResponseHead; rest: Buffer } | null {
  const end = buf.indexOf("\r\n\r\n");
  if (end === -1) return null;
  const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
  const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? "");
  if (match === null) throw new Error("malformed HTTP response from engine");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { head: { status: Number(match[1]), headers }, rest: buf.subarray(end + 4) };
}

class ChunkDecoder {
  private buffer = Buffer.alloc(0);
  private remaining = 0;
  private done = false;

  push(chunk: Buffer, out: PassThrough): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.done) return;
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, this.buffer.length);
        if (take > 0) {
          out.write(this.buffer.subarray(0, take));
          this.buffer = this.buffer.subarray(take);
          this.remaining -= take;
        }
        if (this.remaining > 0) return;
        if (this.buffer.length >= 2) this.buffer = this.buffer.subarray(2);
        continue;
      }
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd === -1) return;
      const size = Number.parseInt(this.buffer.subarray(0, lineEnd).toString("latin1").split(";")[0] ?? "", 16);
      this.buffer = this.buffer.subarray(lineEnd + 2);
      if (!Number.isFinite(size) || size < 0) {
        out.destroy(new Error("malformed chunked response from engine"));
        return;
      }
      if (size === 0) {
        this.done = true;
        out.end();
        return;
      }
      this.remaining = size;
    }
  }
}

function rawBodyRequest(
  socketPath: string,
  method: string,
  path: string,
  body: Readable,
  contentType: string,
  contentLength?: number,
): Promise<{ status: number; headers: Record<string, string>; stream: Readable }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const framing = contentLength === undefined
      ? "Transfer-Encoding: chunked\r\n"
      : "Content-Length: " + contentLength + "\r\n";
    const head =
      method + " " + path + " HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Content-Type: " + contentType + "\r\n" +
      framing +
      "Connection: close\r\n\r\n";
    let settled = false;
    let headerBuffer = Buffer.alloc(0);
    let out: PassThrough | null = null;
    let decoder: ChunkDecoder | null = null;
    let contentLeft: number | undefined;

    const fail = (err: Error): void => {
      out?.destroy(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
      socket.destroy();
    };

    socket.on("error", fail);
    socket.on("data", (chunk: Buffer) => {
      if (out === null) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        let parsed: { head: ResponseHead; rest: Buffer };
        try {
          const headOnly = parseResponseHead(headerBuffer);
          if (headOnly === null) return;
          parsed = headOnly;
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        out = new PassThrough();
        const encoding = (parsed.head.headers["transfer-encoding"] ?? "").toLowerCase();
        if (encoding.includes("chunked")) decoder = new ChunkDecoder();
        const length = parsed.head.headers["content-length"];
        if (decoder === null && length !== undefined) contentLeft = Number(length);
        settled = true;
        resolve({ status: parsed.head.status, headers: parsed.head.headers, stream: out });
        if (parsed.rest.length > 0) feed(parsed.rest);
        return;
      }
      feed(chunk);
    });
    socket.on("end", () => {
      if (out !== null) out.end();
    });

    const feed = (chunk: Buffer): void => {
      if (out === null) return;
      if (decoder !== null) {
        decoder.push(chunk, out);
        return;
      }
      if (contentLeft !== undefined) {
        const take = Math.min(contentLeft, chunk.length);
        if (take > 0) out.write(chunk.subarray(0, take));
        contentLeft -= take;
        if (contentLeft === 0) out.end();
        return;
      }
      out.write(chunk);
    };

    void (async () => {
      try {
        await writeAll(socket, Buffer.from(head, "latin1"));
        let written = 0;
        for await (const chunk of body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          if (buf.length === 0) continue;
          written += buf.length;
          if (contentLength === undefined) {
            await writeAll(socket, Buffer.from(buf.length.toString(16) + "\r\n", "latin1"));
            await writeAll(socket, buf);
            await writeAll(socket, Buffer.from("\r\n", "latin1"));
          } else {
            await writeAll(socket, buf);
          }
        }
        if (contentLength !== undefined && written !== contentLength) {
          throw new Error(
            "stream body length mismatch: promised " + contentLength + " bytes, wrote " + written,
          );
        }
        if (contentLength === undefined) {
          await writeAll(socket, Buffer.from("0\r\n\r\n", "latin1"));
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}
