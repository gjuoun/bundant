import { openAdapter, type OpenedAdapter } from "../adapters/index.ts";
import { defaultForwardDir, SshSocketForward } from "../adapters/transport.ts";
import type { RuntimeAdapter } from "../adapters/types.ts";
import { SshExecutor, connectOptionsFor } from "../exec/ssh.ts";
import { parseHost, type HostConnection } from "../hosts.ts";
import type { ExecResult } from "../types.ts";

/** The forward surface the session owns (injectable for tests). */
export interface SessionForward {
  readonly localSocket: string;
  start(): Promise<string>;
  close(): Promise<void>;
}

export type ForwardFactory = (
  connection: HostConnection,
  remoteSocket: string,
  localDir: string,
) => SessionForward;

export interface HostSessionOptions {
  forwardDir?: string;
  forwardFactory?: ForwardFactory;
  openAdapterFn?: typeof openAdapter;
  /** Test seam: replace the ssh executor. */
  executor?: SshExecutor;
}

export class HostSession {
  readonly host: string;
  private readonly connection: HostConnection;
  private readonly forwardDir: string;
  private readonly forwardFactory: ForwardFactory;
  private readonly openAdapterFn: typeof openAdapter;
  private readonly ssh: SshExecutor;
  private readonly forwards: SessionForward[] = [];
  private readonly opened: OpenedAdapter[] = [];
  private disposed = false;

  constructor(host: HostConnection | string, opts: HostSessionOptions = {}) {
    this.connection = typeof host === "string" ? connectionFrom(host) : host;
    this.host = this.connection.sshTarget;
    this.forwardDir = opts.forwardDir ?? defaultForwardDir();
    this.forwardFactory =
      opts.forwardFactory ??
      ((connection, remoteSocket, localDir) => {
        const forward = new SshSocketForward({ connection, remoteSocket, localDir });
        return {
          localSocket: forward.localSocket,
          start: () => forward.start(),
          close: () => forward.close(),
        };
      });
    this.openAdapterFn = opts.openAdapterFn ?? openAdapter;
    this.ssh = opts.executor ?? new SshExecutor(connectOptionsFor(this.connection));
  }

  get executor(): SshExecutor {
    return this.ssh;
  }

  async exec(command: string): Promise<ExecResult> {
    return await this.ssh.run(command);
  }

  stream(command: string): AsyncIterable<string> {
    const ssh = this.ssh;
    return (async function* () {
      const lines: string[] = [];
      let done = false;
      let wake: (() => void) | undefined;
      const notify = (): void => {
        const resolve = wake;
        wake = undefined;
        resolve?.();
      };
      const finished = ssh
        .stream(command, {
          onLine: (line) => {
            lines.push(line);
            notify();
          },
        })
        .then(
          () => {
            done = true;
            notify();
          },
          (err: unknown) => {
            done = true;
            notify();
            throw err;
          },
        );
      while (!done || lines.length > 0) {
        if (lines.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        while (lines.length > 0) yield lines.shift()!;
      }
      await finished;
    })();
  }

  /** Establish a streamlocal forward; the session owns its lifetime. */
  async forwardSocket(remotePath: string, localDir = this.forwardDir): Promise<string> {
    const forward = this.forwardFactory(this.connection, remotePath, localDir);
    const socket = await forward.start();
    this.forwards.push(forward);
    return socket;
  }

  /** Open one runtime adapter; the session disposes it too. */
  async open(engine: "docker" | "podman"): Promise<RuntimeAdapter> {
    const opened = await this.openAdapterFn(this.connection, engine, {
      cacheDir: this.forwardDir,
    });
    this.opened.push(opened);
    return opened.adapter;
  }

  /** Close every owned adapter/forward; idempotent and tolerant of dead ones. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const opened of this.opened.splice(0)) {
      try {
        await opened.close();
      } catch {
        // a forward that already died is not an error
      }
    }
    for (const forward of this.forwards.splice(0)) {
      try {
        await forward.close();
      } catch {
        // a forward that already died is not an error
      }
    }
    try {
      await this.ssh.close();
    } catch {
      // closing the multiplex master is best-effort
    }
  }
}

/** Run fn with one session; dispose on success and on throw. */
export async function withHostSession<T>(
  host: HostConnection | string,
  fn: (session: HostSession) => Promise<T>,
  opts: HostSessionOptions = {},
): Promise<T> {
  const session = new HostSession(host, opts);
  try {
    return await fn(session);
  } finally {
    await session.dispose();
  }
}

function connectionFrom(target: string): HostConnection {
  const parsed = parseHost(target);
  return {
    user: parsed.user,
    host: parsed.host,
    port: parsed.port,
    options: [],
    sshTarget: parsed.user ? parsed.user + "@" + parsed.host : parsed.host,
  };
}
