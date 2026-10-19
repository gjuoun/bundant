import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSshArgs, connectOptionsFor } from "../exec/ssh.ts";
import type { HostConnection } from "../hosts.ts";

/**
 * Transport for the engine API: OpenSSH streamlocal forwarding carries the
 * remote docker/podman unix socket to a local socket that node:http can dial.
 * No new ssh dependency — bundant already spawns the ssh binary.
 */

/** Profile cache dir; the forward sockets live in a subdirectory of it. */
export function defaultForwardDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.BUNDANT_CACHE_DIR !== undefined && env.BUNDANT_CACHE_DIR !== ""
      ? env.BUNDANT_CACHE_DIR
      : env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== ""
        ? join(env.XDG_CACHE_HOME, "bundant")
        : join(homedir(), ".cache", "bundant");
  return join(base, "forward");
}

export function buildForwardArgs(
  connection: HostConnection,
  localSocket: string,
  remoteSocket: string,
): string[] {
  const base = buildSshArgs(connectOptionsFor(connection));
  const target = base[base.length - 1] ?? connection.sshTarget;
  return [
    "ssh",
    ...base.slice(0, -1),
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    localSocket + ":" + remoteSocket,
    target,
  ];
}

/** Injectable spawn so tests can fake the ssh child. */
export type SpawnProcess = (argv: readonly string[]) => ChildProcess;
const defaultSpawn: SpawnProcess = (argv) =>
  spawn(argv[0] ?? "ssh", argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });

export interface SshForwardOptions {
  connection: HostConnection;
  remoteSocket: string;
  localDir?: string;
  /** How long to wait for the local socket to appear. */
  startTimeoutMs?: number;
  spawnProcess?: SpawnProcess;
}

let counter = 0;

/** A unique local socket name: pid + monotonic counter + clock. */
export function forwardSocketPath(localDir: string): string {
  counter += 1;
  const name = "fwd-" + process.pid + "-" + counter + "-" + Date.now().toString(36) + ".sock";
  return join(localDir, name);
}

export class SshSocketForward {
  readonly localSocket: string;
  private readonly opts: SshForwardOptions;
  private readonly dir: string;
  private child: ChildProcess | null = null;
  private started = false;

  constructor(opts: SshForwardOptions) {
    this.opts = opts;
    this.dir = opts.localDir ?? defaultForwardDir();
    this.localSocket = forwardSocketPath(this.dir);
  }

  /** Spawn ssh -N -L and wait until the local socket is dialable (file exists). */
  async start(): Promise<string> {
    if (this.started) return this.localSocket;
    await mkdir(this.dir, { recursive: true });
    await unlink(this.localSocket).catch(() => undefined);

    const argv = buildForwardArgs(this.opts.connection, this.localSocket, this.opts.remoteSocket);
    const child = (this.opts.spawnProcess ?? defaultSpawn)(argv);
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stderr = "";
      const timer = setInterval(() => {
        void stat(this.localSocket).then(
          () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          },
          () => undefined,
        );
      }, 20);
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(
          new Error(
            "ssh forward " + this.opts.connection.sshTarget + ":" + this.opts.remoteSocket + " timed out",
          ),
        );
      }, this.opts.startTimeoutMs ?? 8_000);
      const cleanup = (): void => {
        clearInterval(timer);
        clearTimeout(deadline);
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("ssh forward failed: " + err.message));
      });
      child.once("exit", (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            "ssh forward exited (" + String(code) + ")" +
              (stderr.trim() !== "" ? ": " + stderr.trim() : ""),
          ),
        );
      });
    });

    this.started = true;
    return this.localSocket;
  }

  /** Kill the forward child and remove its local socket. */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.started = false;
    if (child !== null && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, 1_500);
        child.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    await unlink(this.localSocket).catch(() => undefined);
  }
}

export interface ForwardRequest {
  connection: HostConnection;
  remoteSocket: string;
  localDir?: string;
}

/** One forward per host+socket for the life of a command. */
export class SshForwardPool {
  private readonly pending = new Map<string, Promise<SshSocketForward>>();
  private readonly spawnProcess: SpawnProcess | undefined;

  constructor(spawnProcess?: SpawnProcess) {
    this.spawnProcess = spawnProcess;
  }

  acquire(req: ForwardRequest): Promise<SshSocketForward> {
    const key = req.connection.sshTarget + "|" + req.remoteSocket;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const forward = new SshSocketForward({
      connection: req.connection,
      remoteSocket: req.remoteSocket,
      localDir: req.localDir,
      spawnProcess: this.spawnProcess,
    });
    const started = forward.start().then(() => forward);
    this.pending.set(key, started);
    started.catch(() => this.pending.delete(key));
    return started;
  }

  async closeAll(): Promise<void> {
    const forwards = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(
      forwards.map(async (p) => {
        try {
          await (await p).close();
        } catch {
          // A forward that never started has nothing to close.
        }
      }),
    );
  }
}

