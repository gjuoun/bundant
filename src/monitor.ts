import type { LoadedConfig } from "./config.ts";
import type { Executor } from "./types.ts";
import type { RuntimeAdapter } from "./adapters/types.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { resolveConnections } from "./hosts.ts";
import { openAdapter } from "./adapters/index.ts";
import { runtimeFor, type Runtime } from "./runtime.ts";
import { formatEvent, statRow, type StatRow } from "./monitor-format.ts";

export { formatBytes, formatEvent, statRow, type StatRow } from "./monitor-format.ts";

/**
 * Pull-based monitoring: every query is one engine-API round trip per host,
 * executed in parallel, and nothing is installed or left running on the host.
 * History is whatever the current session collected — by design.
 *
 * The read surface (containers, stats, logs, inspect, events) goes through the
 * RuntimeAdapter; only the interactive shell and kamal-proxy (a CLI inside a
 * container, no HTTP API) still use ssh.
 */

/** The read half of RuntimeAdapter — what monitoring actually needs. */
export type MonitorRuntime = Pick<
  RuntimeAdapter,
  "list" | "stats" | "logs" | "inspect" | "events"
>;

export interface HostTarget {
  host: string;
  runtime?: MonitorRuntime;
  /** Set when the adapter could not be opened on this host. */
  error?: string;
  /** ssh executor for the paths that stay on ssh (exec, kamal-proxy). */
  exec?: Executor;
  close?: () => Promise<void>;
}

export interface ContainerRow {
  host: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  createdAt: string;
}

export interface InspectRow {
  host: string;
  name: string;
  state: string;
  restarts: string;
  startedAt: string;
  health: string;
  image: string;
  restartPolicy: string;
  logDriver: string;
  exitCode: string;
}

export interface HostResult<T> {
  host: string;
  ok: boolean;
  error?: string;
  rows: T[];
}

function fail<T>(host: string, error: string): HostResult<T> {
  return { host, ok: false, error, rows: [] };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Which container satisfies a selector: exact name first, then a name prefix. */
export function pickContainer(names: string[], selector: string): string | undefined {
  if (names.includes(selector)) return selector;
  return names.find((n) => n.startsWith(selector));
}

export class Monitor {
  private readonly targets: HostTarget[];
  private readonly rt: Runtime;

  constructor(targets: HostTarget[], rt: Runtime) {
    this.targets = targets;
    this.rt = rt;
  }

  get hosts(): string[] {
    return this.targets.map((t) => t.host);
  }

  /** Release every adapter (the ssh forward socket dies with it). */
  async close(): Promise<void> {
    await Promise.all(
      this.targets.map(async (t) => {
        try {
          await t.close?.();
        } catch {
          // A host that never opened has nothing to release.
        }
      }),
    );
  }

  private target(host: string): HostTarget {
    const found = this.targets.find((t) => t.host === host);
    if (!found) throw new Error("unknown host: " + host + " (known: " + this.hosts.join(", ") + ")");
    return found;
  }

  private runtimeOf(t: HostTarget): MonitorRuntime {
    if (t.runtime === undefined) throw new Error(t.error ?? "runtime adapter unavailable");
    return t.runtime;
  }

  /** Containers of every host, in parallel. A dead host does not fail the rest. */
  async containers(): Promise<HostResult<ContainerRow>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        if (t.runtime === undefined) return fail<ContainerRow>(t.host, t.error ?? "runtime unavailable");
        try {
          const rows = await t.runtime.list({ all: true });
          return {
            host: t.host,
            ok: true,
            rows: rows.map((row) => ({
              host: t.host,
              name: row.name,
              image: row.image,
              status: row.status,
              ports: row.ports,
              createdAt: row.created > 0 ? new Date(row.created * 1000).toISOString() : "",
            })),
          };
        } catch (err) {
          return fail<ContainerRow>(t.host, message(err));
        }
      }),
    );
  }

  async stats(): Promise<HostResult<StatRow>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        if (t.runtime === undefined) return fail<StatRow>(t.host, t.error ?? "runtime unavailable");
        try {
          const running = await t.runtime.list({});
          const samples = await Promise.all(
            running.map(async (row) => statRow(t.host, row.name, await t.runtime!.stats(row.id))),
          );
          return { host: t.host, ok: true, rows: samples };
        } catch (err) {
          return fail<StatRow>(t.host, message(err));
        }
      }),
    );
  }

  async inspect(selector: string): Promise<HostResult<InspectRow>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        if (t.runtime === undefined) return fail<InspectRow>(t.host, t.error ?? "runtime unavailable");
        try {
          const name = await this.resolve(t, selector);
          if (name === undefined) return fail<InspectRow>(t.host, "no container matches " + selector);
          const info = await t.runtime.inspect(name);
          const row: InspectRow = {
            host: t.host,
            name: info.name,
            state: info.state.status,
            restarts: String(info.state.restarts),
            startedAt: info.state.startedAt ?? "",
            health: info.state.health ?? "-",
            image: info.image,
            restartPolicy: info.restartPolicy,
            logDriver: info.logDriver,
            exitCode: String(info.state.exitCode),
          };
          return { host: t.host, ok: true, rows: [row] };
        } catch (err) {
          return fail<InspectRow>(t.host, message(err));
        }
      }),
    );
  }

  /** Static tail of one container's logs; host-qualified in the CLI/UI. */
  async logs(host: string, selector: string, tail: number): Promise<string> {
    const t = this.target(host);
    const runtime = this.runtimeOf(t);
    const name = await this.resolve(t, selector);
    if (name === undefined) throw new Error(host + ": no container matches " + selector);
    const lines: string[] = [];
    for await (const line of runtime.logs(name, { tail })) lines.push(line);
    return lines.length === 0 ? "" : lines.join("\n") + "\n";
  }

  async events(host: string, since: string, labels?: Record<string, string>): Promise<string[]> {
    const t = this.target(host);
    const runtime = this.runtimeOf(t);
    const lines: string[] = [];
    for await (const event of runtime.events({ since, labels })) lines.push(formatEvent(event));
    return lines;
  }

  async proxyRoutes(): Promise<HostResult<string>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        if (t.exec === undefined) return fail<string>(t.host, t.error ?? "executor unavailable");
        try {
          const up = await t.exec.run(docker.inspectRunning(this.rt, proxy.PROXY_CONTAINER));
          if (up.stdout.trim() !== "true") return fail<string>(t.host, "proxy not running");
          const r = await t.exec.run(proxy.list(this.rt));
          if (r.code !== 0) return fail<string>(t.host, r.stderr.trim() || "exit " + r.code);
          const rows = r.stdout
            .split("\n")
            .map((l) => l.trim().replace(/\u001b\[[0-9;]*m/g, ""))
            .filter((l) => l !== "");
          return { host: t.host, ok: true, rows };
        } catch (err) {
          return fail<string>(t.host, message(err));
        }
      }),
    );
  }

  /** Follow logs on every host (or one), prefixing each line with its host. */
  async followLogs(opts: { host?: string; container?: string; tail: number }): Promise<number> {
    const targets = opts.host === undefined ? this.targets : this.targets.filter((t) => t.host === opts.host);
    if (targets.length === 0) throw new Error("unknown host: " + opts.host);
    const codes = await Promise.all(
      targets.map(async (t) => {
        if (t.runtime === undefined) {
          process.stderr.write(t.host + ": " + (t.error ?? "runtime unavailable") + "\n");
          return 1;
        }
        const picked = await this.resolve(t, opts.container);
        if (picked === undefined) {
          process.stderr.write(t.host + ": no container to follow\n");
          return 1;
        }
        const tag = targets.length === 1 ? "" : t.host.padEnd(16) + " │ ";
        try {
          for await (const line of t.runtime.logs(picked, { tail: opts.tail, follow: true })) {
            process.stdout.write(tag + line + "\n");
          }
          return 0;
        } catch (err) {
          process.stderr.write(t.host + ": " + message(err) + "\n");
          return 1;
        }
      }),
    );
    return codes.some((c) => c !== 0) ? 1 : 0;
  }

  /** Interactive shell inside a container (PTY through ssh — stays on ssh). */
  async execShell(host: string, selector: string, argv: string[]): Promise<number> {
    const t = this.target(host);
    if (t.exec === undefined) throw new Error(host + ": executor unavailable");
    const name = await this.resolve(t, selector);
    if (name === undefined) throw new Error(host + ": no container matches " + selector);
    const inner = argv.length > 0 ? argv.join(" ") : "sh";
    if (t.exec.stream === undefined) throw new Error("this executor cannot open a tty");
    return await t.exec.stream(this.rt.bin + " exec -it " + name + " " + inner, { tty: true });
  }

  /**
   * Resolve a selector to one container: running containers first (so a service
   * with several retained revisions picks the live one), then all containers.
   */
  private async resolve(t: HostTarget, selector: string | undefined): Promise<string | undefined> {
    const runtime = this.runtimeOf(t);
    const running = (await runtime.list({})).map((row) => row.name);
    if (selector === undefined) {
      if (running.length > 0) return running[0];
      const all = (await runtime.list({ all: true })).map((row) => row.name);
      return all.length > 0 ? all[0] : undefined;
    }
    const live = pickContainer(running, selector);
    if (live !== undefined) return live;
    const all = (await runtime.list({ all: true })).map((row) => row.name);
    return pickContainer(all, selector);
  }
}

/**
 * Build a Monitor from deploy.yml: open one adapter per host (detect -> forward
 * -> client) and keep it for the caller's lifetime; close() releases it.
 * A host that cannot be reached is reported per query instead of failing all.
 */
export async function monitorFor(loaded: LoadedConfig): Promise<Monitor> {
  const conns = resolveConnections(loaded.config);
  const targets = await Promise.all(
    conns.map(async (conn): Promise<HostTarget> => {
      const exec = new SshExecutor(connectOptionsFor(conn));
      try {
        const opened = await openAdapter(conn, loaded.config.runtime);
        return { host: conn.sshTarget, runtime: opened.adapter, exec, close: opened.close };
      } catch (err) {
        return { host: conn.sshTarget, error: message(err), exec };
      }
    }),
  );
  return new Monitor(targets, runtimeFor(loaded.config.runtime));
}
