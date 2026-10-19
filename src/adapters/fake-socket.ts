import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A tiny HTTP/1.1 server on a unix socket — test support for the adapter
 * layer, written on node:net so it behaves identically under bun and node.
 */

export interface FakeRequest {
  method: string;
  /** Path plus query string, as sent. */
  url: string;
  headers: Record<string, string>;
  body: string;
}

const STATUS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  304: "Not Modified",
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};

export class FakeResponse {
  private status = 200;
  private readonly headers: Record<string, string> = {};
  private started = false;
  private ended = false;
  private chunked = false;

  constructor(private readonly socket: Socket) {}

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    for (const [key, value] of Object.entries(headers)) this.headers[key] = value;
    return this;
  }

  write(chunk: string | Buffer): void {
    if (this.ended) return;
    this.start();
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) return;
    if (this.chunked) {
      this.socket.write(buf.length.toString(16) + "\r\n");
      this.socket.write(buf);
      this.socket.write("\r\n");
    } else {
      this.socket.write(buf);
    }
  }

  end(chunk?: string | Buffer): void {
    if (this.ended) return;
    if (chunk !== undefined) this.write(chunk);
    this.start();
    if (this.chunked) this.socket.write("0\r\n\r\n");
    this.ended = true;
    this.socket.end();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const hasLength = this.headers["content-length"] !== undefined;
    if (!hasLength) {
      this.headers["Transfer-Encoding"] = "chunked";
      this.chunked = true;
    }
    this.headers["Connection"] = "close";
    const lines = ["HTTP/1.1 " + this.status + " " + (STATUS[this.status] ?? "OK")];
    for (const [key, value] of Object.entries(this.headers)) lines.push(key + ": " + value);
    this.socket.write(lines.join("\r\n") + "\r\n\r\n");
  }
}

export type FakeHandler = (req: FakeRequest, res: FakeResponse) => void | Promise<void>;

export class FakeDockerSocket {
  readonly socketPath: string;
  private readonly dir: string;
  private readonly server: Server;
  private readonly handler: FakeHandler;

  private constructor(dir: string, handler: FakeHandler) {
    this.dir = dir;
    this.socketPath = join(dir, "d.sock");
    this.handler = handler;
    this.server = createServer((socket) => this.accept(socket));
  }

  static async create(handler: FakeHandler): Promise<FakeDockerSocket> {
    const dir = await mkdtemp(join(tmpdir(), "bundant-fake-"));
    const fake = new FakeDockerSocket(dir, handler);
    await fake.listen();
    return fake;
  }

  /** Drop the listener but keep a plain file at the path (stale socket case). */
  static async staleFile(): Promise<{ socketPath: string; close: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "bundant-stale-"));
    const socketPath = join(dir, "d.sock");
    await writeFile(socketPath, "");
    return {
      socketPath,
      close: async () => {
        await unlink(socketPath).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  private accept(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString("utf8");
      const [requestLine = "", ...headerLines] = head.split("\r\n");
      const [method = "GET", url = "/"] = requestLine.split(" ");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const length = Number(headers["content-length"] ?? "0");
      if (buffer.length < end + 4 + length) return;
      const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      socket.off("data", onData);
      const res = new FakeResponse(socket);
      void Promise.resolve(this.handler({ method, url, headers, body }, res)).catch(() => {
        res.writeHead(500).end();
      });
    };
    socket.on("data", onData);
    socket.on("error", () => undefined);
  }
}

/** Convenience for JSON fixtures. */
export function json(res: FakeResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}
