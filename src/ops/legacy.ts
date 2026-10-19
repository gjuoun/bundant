import * as docker from "../commands/docker.ts";
import * as proxy from "../commands/proxy.ts";
import type { ContainerSpec } from "../adapters/types.ts";
import type { BundantConfig } from "../config.ts";
import type { Executor } from "../types.ts";
import { waitUntilHealthy } from "../health.ts";
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

  constructor(exec: Executor, rt: Runtime, opts: { envRemotePath?: string } = {}) {
    this.exec = exec;
    this.rt = rt;
    this.envRemotePath = opts.envRemotePath;
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

  async pruneImages(): Promise<void> {
    this.steps.push("prune-images");
    await this.run("image prune", docker.imagePrune(this.rt));
  }

  async close(): Promise<void> {
    await this.exec.close();
  }
}
