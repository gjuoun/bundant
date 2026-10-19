import * as docker from "../commands/docker.ts";
import * as proxy from "../commands/proxy.ts";
import type { ContainerInfo, ContainerSpec, ContainerSummary } from "../adapters/types.ts";
import type { BundantConfig } from "../config.ts";
import type { Executor } from "../types.ts";
import { waitUntilHealthy, waitUntilSucceeds } from "../health.ts";
import { belongsToService } from "../naming.ts";
import { parseHistory, type RevisionEntry } from "../revisions.ts";
import { portGuardCommand, runtimeCheckCommands, type Runtime } from "../runtime.ts";
import type { HealthGateOptions, ProxyDeployOptions, RuntimeOps } from "./types.ts";

/**
 * The pre-stage-3 command-string implementation. Output is unchanged: this is
 * the \`--via cli\` fallback for one release and the source of the legacy
 * dry-run rendering.
 */
export class LegacyOps implements RuntimeOps {
  readonly via = "cli" as const;
  readonly steps: string[] = [];
  private readonly exec: Executor;
  private readonly rt: Runtime;
  private readonly envRemotePath?: string;

  private readonly closeSession?: () => Promise<void>;

  constructor(
    exec: Executor,
    rt: Runtime,
    opts: { envRemotePath?: string; close?: () => Promise<void> } = {},
  ) {
    this.exec = exec;
    this.rt = rt;
    this.envRemotePath = opts.envRemotePath;
    this.closeSession = opts.close;
  }

  private async run(phase: string, cmd: string): Promise<void> {
    const r = await this.exec.run(cmd);
    if (r.code !== 0) {
      throw new Error(phase + " failed: cmd=" + cmd + " err=" + (r.stderr.trim() || r.stdout.trim()));
    }
  }

  async hostPrereqs(): Promise<void> {
    this.steps.push("prereqs");
    const cmds = runtimeCheckCommands(this.rt);
    const guard = portGuardCommand(this.rt);
    if (guard !== null) cmds.push(guard);
    for (const cmd of cmds) await this.run("host prereq", cmd);
  }

  async putEnv(localFile: string | null, remotePath: string | undefined, count: number): Promise<void> {
    if (localFile === null || remotePath === undefined) return;
    this.steps.push("env:" + count);
    const dir = remotePath.slice(0, remotePath.lastIndexOf("/"));
    await this.run("env dir", "mkdir -p " + dir);
    await this.exec.putFile(localFile, remotePath, "600");
  }

  async pull(image: string): Promise<void> {
    this.steps.push("pull:" + image);
    await this.run("pull", docker.pull(this.rt, image));
  }

  async ensureNetwork(): Promise<void> {
    this.steps.push("network");
    await this.run("network", docker.ensureNetwork(this.rt));
  }

  async removeContainer(name: string, opts: { force?: boolean } = {}): Promise<void> {
    this.steps.push("remove:" + name);
    if (opts.force === true) {
      await this.run("remove", docker.removeForce(this.rt, name));
      return;
    }
    await this.run("remove", this.rt.bin + " rm " + name);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    this.steps.push("create:" + spec.name);
    const cmd = docker.run(this.rt, {
      container: spec.name,
      image: spec.image,
      envFile: this.envRemotePath,
      labels: spec.labels,
      volumes: spec.volumes,
      restart: spec.restart !== "no",
    });
    await this.run("create", cmd);
    return spec.name;
  }

  async startContainer(name: string): Promise<void> {
    // \`docker run -d\` has already started it; keep the semantic step.
    this.steps.push("start:" + name);
  }

  async stopContainers(names: string[]): Promise<void> {
    for (const name of names) {
      this.steps.push("stop:" + name);
      await this.run("stop", docker.stop(this.rt, name));
    }
  }

  async listContainers(opts: {
    all?: boolean;
    labels?: Record<string, string>;
    namePrefix?: string;
  }): Promise<ContainerSummary[]> {
    const format =
      '{{.Names}}|{{.Image}}|{{.Status}}|{{.Label "bundant.revision"}}|' +
      '{{.Label "bundant.replica"}}|{{.Label "bundant.kind"}}|' +
      '{{.Label "bundant.group"}}|{{.Label "bundant.service"}}';
    let cmd = this.rt.bin + (opts.all === false ? " ps" : " ps -a");
    if (opts.labels !== undefined) cmd += docker.labelFilters(opts.labels);
    if (opts.namePrefix !== undefined) {
      cmd += ' --filter "name=' + opts.namePrefix + '"';
    }
    cmd += " --format '" + format + "'";
    const r = await this.exec.run(cmd);
    if (r.code !== 0) throw new Error("cannot list containers: " + r.stderr.trim());
    return parseList(r.stdout);
  }

  async inspectContainer(name: string): Promise<ContainerInfo> {
    const r = await this.exec.run(this.rt.bin + " inspect " + name);
    if (r.code !== 0) throw new Error("cannot inspect " + name + ": " + r.stderr.trim());
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    const raw = rows[0] ?? {};
    const state = (raw.State ?? {}) as Record<string, unknown>;
    const config = (raw.Config ?? {}) as Record<string, unknown>;
    const host = (raw.HostConfig ?? {}) as Record<string, unknown>;
    return {
      id: String(raw.Id ?? name),
      name: String(raw.Name ?? name).replace(/^\//, ""),
      image: String(config.Image ?? ""),
      state: {
        status: String(state.Status ?? "unknown"),
        running: state.Running === true,
        exitCode: Number(state.ExitCode ?? 0),
        startedAt: typeof state.StartedAt === "string" ? state.StartedAt : undefined,
        restarts: Number(raw.RestartCount ?? 0),
      },
      labels: (config.Labels ?? {}) as Record<string, string>,
      env: (config.Env ?? []) as string[],
      restartPolicy: String((host.RestartPolicy as Record<string, unknown> | undefined)?.Name ?? "no"),
      logDriver: "",
      binds: (host.Binds ?? []) as string[],
      networkMode: String(host.NetworkMode ?? ""),
      raw,
    };
  }

  async removeImage(ref: string): Promise<void> {
    this.steps.push("rmi:" + ref);
    await this.run("rmi", this.rt.bin + " rmi " + ref);
  }

  async healthGate(names: string[], opts: HealthGateOptions): Promise<void> {
    this.steps.push("health:" + names.join(","));
    for (const name of names) {
      await waitUntilHealthy(
        this.exec,
        docker.probe(this.rt, name, opts.port, opts.path),
        { timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs },
      );
    }
  }

  async proxyEnsure(image: string): Promise<void> {
    this.steps.push("proxy-ensure");
    await this.run("proxy-ensure", proxy.ensure(this.rt, image));
  }

  async proxyDeploy(
    serviceId: string,
    targets: string[],
    opts: ProxyDeployOptions,
  ): Promise<void> {
    this.steps.push("proxy-deploy:" + targets.join(","));
    await this.run(
      "proxy-swap",
      proxy.deploy(this.rt, serviceId, targets, {
        host: opts.host,
        tls: opts.tls,
        healthCheckPath: opts.healthCheckPath,
        healthCheckPort: opts.healthCheckPort,
      }),
    );
  }

  async stopOld(
    config: Pick<BundantConfig, "service" | "role" | "group">,
    keep: string[],
  ): Promise<void> {
    this.steps.push("stop-old:" + keep.join(","));
    await this.run("stop-old", docker.stopOld(this.rt, config, keep));
  }

  async history(
    labels: Record<string, string>,
    config: Pick<BundantConfig, "service" | "role" | "group">,
  ): Promise<RevisionEntry[]> {
    const r = await this.exec.run(docker.listHistoryByLabels(this.rt, labels));
    if (r.code !== 0) throw new Error("cannot list revisions: " + r.stderr.trim());
    return parseHistory(r.stdout).filter((e) => belongsToService(e.name, config));
  }

  async proxyRemove(serviceId: string): Promise<void> {
    this.steps.push("proxy-remove:" + serviceId);
    await this.run(
      "proxy-remove",
      this.rt.bin + ' inspect -f "{{.State.Running}}" ' + proxy.PROXY_CONTAINER +
        " 2>/dev/null | grep -q true && " + this.rt.bin + " exec " + proxy.PROXY_CONTAINER +
        " kamal-proxy remove " + serviceId + " || true",
    );
  }

  async removeEnv(remotePath: string): Promise<void> {
    this.steps.push("env-remove:" + remotePath);
    await this.run("env-remove", "rm -f " + remotePath);
  }

  async logs(name: string, tail: number): Promise<string> {
    const r = await this.exec.run(docker.logsTail(this.rt, name, tail));
    return r.stdout + r.stderr;
  }

  async tcpGate(name: string, port: number, opts: HealthGateOptions): Promise<void> {
    this.steps.push("tcp:" + name + ":" + port);
    await waitUntilSucceeds(this.exec, docker.tcpProbe(this.rt, name, port), {
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs,
    });
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.steps.push("volume-create:" + name);
    await this.run("volume-create", docker.volumeCreate(this.rt, name, labels));
  }

  async removeVolume(name: string): Promise<void> {
    this.steps.push("volume-remove:" + name);
    await this.run("volume-remove", this.rt.bin + " volume rm " + name + " 2>/dev/null || true");
  }

  async inspectVolume(name: string): Promise<{ labels: Record<string, string> }> {
    const r = await this.exec.run(
      this.rt.bin + " volume inspect --format '{{json .Labels}}' " + name + " 2>/dev/null || true",
    );
    if (r.stdout.trim() === "") return { labels: {} };
    try {
      return { labels: JSON.parse(r.stdout) as Record<string, string> };
    } catch {
      return { labels: {} };
    }
  }

  async pruneImages(): Promise<void> {
    this.steps.push("prune-images");
    await this.run("image prune", docker.imagePrune(this.rt));
  }

  async close(): Promise<void> {
    if (this.closeSession !== undefined) {
      await this.closeSession();
      return;
    }
    await this.exec.close();
  }
}

/** Parse the legacy ps format into ContainerSummary rows. */
export function parseList(stdout: string): ContainerSummary[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", image = "", status = "", revision = "", replica = "", kind = "", group = "", service = ""] =
        line.split("|");
      const labels: Record<string, string> = {};
      if (revision !== "") labels["bundant.revision"] = revision;
      if (replica !== "") labels["bundant.replica"] = replica;
      if (kind !== "") labels["bundant.kind"] = kind;
      if (group !== "") labels["bundant.group"] = group;
      if (service !== "") labels["bundant.service"] = service;
      return {
        id: name,
        name,
        image,
        state: status.startsWith("Up") ? "running" : "exited",
        status,
        labels,
        created: 0,
        ports: "",
      };
    });
}

