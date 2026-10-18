import type { LoadedConfig } from "./config.ts";
import type { Runtime } from "./runtime.ts";
import type { Executor } from "./types.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { resolveConnections } from "./hosts.ts";
import { runtimeFor } from "./runtime.ts";

/**
 * Pull-based monitoring: every query is one ssh round trip per host, executed
 * in parallel, and nothing is installed or left running on the host. History is
 * whatever the current session collected — by design (see docs/monitoring.md).
 */

export interface HostTarget {
  host: string;
  exec: Executor;
}

export interface ContainerRow {
  host: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  createdAt: string;
}

export interface StatRow {
  host: string;
  name: string;
  cpu: string;
  mem: string;
  memPct: string;
  pids: string;
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

/** name|image|status|ports|createdAt, one container per line. */
export function parseContainers(host: string, stdout: string): ContainerRow[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const [name = "", image = "", status = "", ports = "", createdAt = ""] = line.split("|");
      return { host, name, image, status, ports, createdAt };
    });
}

/** name|cpu%|mem|mem%|pids. */
export function parseStats(host: string, stdout: string): StatRow[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const [name = "", cpu = "", mem = "", memPct = "", pids = ""] = line.split("|");
      return { host, name, cpu, mem, memPct, pids };
    });
}

/** The inspectLine field order; returns null for empty output. */
export function parseInspect(host: string, stdout: string): InspectRow | null {
  const line = stdout.trim().split("\n")[0];
  if (line === undefined || line === "") return null;
  const parts = line.split("|");
  const at = (i: number): string => parts[i] ?? "";
  return {
    host,
    name: at(0).replace(/^\//, ""),
    state: at(1),
    restarts: at(2),
    startedAt: at(3),
    health: at(4),
    image: at(5),
    restartPolicy: at(6),
    logDriver: at(7),
    exitCode: at(8),
  };
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

  private target(host: string): HostTarget {
    const found = this.targets.find((t) => t.host === host);
    if (!found) throw new Error("unknown host: " + host + " (known: " + this.hosts.join(", ") + ")");
    return found;
  }

  /** Containers of every host, in parallel. A dead host does not fail the rest. */
  async containers(): Promise<HostResult<ContainerRow>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        const r = await t.exec.run(docker.listAll(this.rt));
        if (r.code !== 0) return fail<ContainerRow>(t.host, r.stderr.trim() || "exit " + r.code);
        return { host: t.host, ok: true, rows: parseContainers(t.host, r.stdout) };
      }),
    );
  }

  async stats(): Promise<HostResult<StatRow>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        const r = await t.exec.run(docker.statsSnapshot(this.rt));
        if (r.code !== 0) return fail<StatRow>(t.host, r.stderr.trim() || "exit " + r.code);
        return { host: t.host, ok: true, rows: parseStats(t.host, r.stdout) };
      }),
    );
  }

  async inspect(selector: string): Promise<HostResult<InspectRow>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        const name = await this.resolve(t, selector);
        if (name === undefined) return fail<InspectRow>(t.host, "no container matches " + selector);
        const r = await t.exec.run(docker.inspectLine(this.rt, name));
        if (r.code !== 0) return fail<InspectRow>(t.host, r.stderr.trim() || "exit " + r.code);
        const row = parseInspect(t.host, r.stdout);
        return row === null
          ? fail<InspectRow>(t.host, "empty inspect output")
          : { host: t.host, ok: true, rows: [row] };
      }),
    );
  }

  /** Static tail of one container's logs; host-qualified in the CLI/UI. */
  async logs(host: string, selector: string, tail: number): Promise<string> {
    const t = this.target(host);
    const name = await this.resolve(t, selector);
    if (name === undefined) throw new Error(host + ": no container matches " + selector);
    const r = await t.exec.run(docker.logsTail(this.rt, name, tail));
    return r.stdout + r.stderr;
  }

  async events(host: string, since: string): Promise<string[]> {
    const t = this.target(host);
    const r = await t.exec.run(docker.eventsSince(this.rt, since));
    return (r.stdout + r.stderr)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("time="));
  }

  async proxyRoutes(): Promise<HostResult<string>[]> {
    return await Promise.all(
      this.targets.map(async (t) => {
        const up = await t.exec.run(docker.inspectRunning(this.rt, proxy.PROXY_CONTAINER));
        if (up.stdout.trim() !== "true") return fail<string>(t.host, "proxy not running");
        const r = await t.exec.run(proxy.list(this.rt));
        if (r.code !== 0) return fail<string>(t.host, r.stderr.trim() || "exit " + r.code);
        const rows = r.stdout
          .split("\n")
          .map((l) => l.trim().replace(/\u001b\[[0-9;]*m/g, ""))
          .filter((l) => l !== "");
        return { host: t.host, ok: true, rows };
      }),
    );
  }

  /** Follow logs on every host (or one), prefixing each line with its host. */
  async followLogs(opts: { host?: string; container?: string; tail: number }): Promise<number> {
    const targets = opts.host === undefined ? this.targets : this.targets.filter((t) => t.host === opts.host);
    if (targets.length === 0) throw new Error("unknown host: " + opts.host);
    const codes = await Promise.all(
      targets.map(async (t) => {
        const picked = await this.resolve(t, opts.container);
        if (picked === undefined) {
          process.stderr.write(t.host + ": no container to follow\n");
          return 1;
        }
        const tag = targets.length === 1 ? "" : t.host.padEnd(16) + " │ ";
        if (t.exec.stream === undefined) {
          process.stderr.write(t.host + ": this executor cannot stream\n");
          return 1;
        }
        return await t.exec.stream(docker.logsTail(this.rt, picked, opts.tail, true), {
          onLine: (line) => process.stdout.write(tag + line + "\n"),
        });
      }),
    );
    return codes.some((c) => c !== 0) ? 1 : 0;
  }

  /** Interactive shell inside a container (PTY through ssh). */
  async execShell(host: string, selector: string, argv: string[]): Promise<number> {
    const t = this.target(host);
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
    const namesOf = async (cmd: string): Promise<string[]> => {
      const r = await t.exec.run(cmd);
      if (r.code !== 0) return [];
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    };
    const running = await namesOf(docker.containerNames(this.rt));
    if (selector === undefined) {
      if (running.length > 0) return running[0];
      const all = await namesOf(docker.allContainerNames(this.rt));
      return all.length > 0 ? all[0] : undefined;
    }
    const live = pickContainer(running, selector);
    if (live !== undefined) return live;
    const all = await namesOf(docker.allContainerNames(this.rt));
    return pickContainer(all, selector);
  }
}

/** Build a Monitor from deploy.yml: one SshExecutor per host, runtime from config. */
export function monitorFor(loaded: LoadedConfig): Monitor {
  const rt = runtimeFor(loaded.config.runtime);
  const targets: HostTarget[] = resolveConnections(loaded.config).map((c) => ({
    host: c.sshTarget,
    exec: new SshExecutor(connectOptionsFor(c)),
  }));
  return new Monitor(targets, rt);
}
