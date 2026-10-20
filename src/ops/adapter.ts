import { z } from "zod";
import type {
  ContainerInfo,
  ContainerSpec,
  ContainerSummary,
  RuntimeAdapter,
} from "../adapters/types.ts";
import { CURL_IMAGE, NETWORK, TCP_IMAGE } from "../commands/docker.ts";
import type { BundantConfig } from "../config.ts";
import type { Executor } from "../types.ts";
import { belongsToService, serviceLabels } from "../naming.ts";
import { revisionOf, type RevisionEntry } from "../revisions.ts";
import { portGuardCommand, runtimeCheckCommands, type Runtime } from "../runtime.ts";
import { PROXY_CONTAINER } from "../commands/proxy.ts";
import { loadHostLayers } from "../transfer/layers.ts";
import type { HealthGateOptions, ProxyDeployOptions, RuntimeOps } from "./types.ts";

const containerSpecSchema = z.object({
  image: z.string().min(1),
  name: z.string().min(1),
  env: z.array(z.string()),
  labels: z.record(z.string()),
  volumes: z.array(z.string()).optional(),
  restart: z.enum(["no", "always", "unless-stopped", "on-failure"]).optional(),
  network: z.string().optional(),
  ports: z.array(z.string()).optional(),
  cmd: z.array(z.string()).optional(),
  sysctl: z.record(z.string()).optional(),
});

const targetsSchema = z.array(z.string().min(1)).min(1);

const PROBE_IMAGE = CURL_IMAGE;
const PROXY_SYSCTL = { "net.ipv4.ip_unprivileged_port_start": "0" };

let probeCounter = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The same semantic operations, executed through the engine API. Container
 * lifecycle, images and the network are HTTP calls; only the two host-side
 * facts the API cannot express (systemd units, sysctls) stay on ssh.
 */
export class ApiOps implements RuntimeOps {
  readonly via = "api" as const;
  readonly steps: string[] = [];
  private readonly adapter: RuntimeAdapter;
  private readonly exec: Executor;
  private readonly rt: Runtime;
  private readonly closeAdapter: () => Promise<void>;
  private readonly disposeSession?: () => Promise<void>;

  constructor(
    adapter: RuntimeAdapter,
    exec: Executor,
    rt: Runtime,
    closeAdapter: () => Promise<void>,
    disposeSession?: () => Promise<void>,
  ) {
    this.adapter = adapter;
    this.exec = exec;
    this.rt = rt;
    this.closeAdapter = closeAdapter;
    this.disposeSession = disposeSession;
  }

  private async hostRun(phase: string, cmd: string): Promise<void> {
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
    for (const cmd of cmds) await this.hostRun("host prereq", cmd);
  }

  async putEnv(_localFile: string | null, remotePath: string | undefined, count: number): Promise<void> {
    // No remote env file: ContainerSpec.env carries the values, so there is
    // nothing to write (and nothing for delete to clean up any more).
    if (remotePath === undefined) return;
    this.steps.push("env:" + count);
  }

  async imagePresent(image: string): Promise<boolean> {
    return await this.adapter.imagePresent(image);
  }

  async pull(image: string): Promise<void> {
    this.steps.push("pull:" + image);
    await this.adapter.pull(image);
  }

  async imageLayers(): Promise<Set<string>> {
    this.steps.push("image-layers");
    return await loadHostLayers(this.adapter);
  }

  async loadImage(
    stream: NodeJS.ReadableStream,
    opts: { contentLength?: number } = {},
  ): Promise<void> {
    this.steps.push("image-load");
    await this.adapter.loadImage(stream, opts);
  }

  async ensureNetwork(): Promise<void> {
    this.steps.push("network");
    await this.adapter.ensureNetwork(NETWORK);
  }

  async removeContainer(name: string, opts: { force?: boolean } = {}): Promise<void> {
    this.steps.push("remove:" + name);
    await this.adapter.remove(name, { force: opts.force === true });
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const parsed = containerSpecSchema.parse(spec);
    this.steps.push("create:" + parsed.name);
    const { id } = await this.adapter.create(parsed);
    return id;
  }

  async startContainer(name: string): Promise<void> {
    this.steps.push("start:" + name);
    await this.adapter.start(name);
  }

  async stopContainers(names: string[]): Promise<void> {
    for (const name of names) {
      this.steps.push("stop:" + name);
      await this.adapter.stop(name);
    }
  }

  async listContainers(opts: {
    all?: boolean;
    labels?: Record<string, string>;
    namePrefix?: string;
  }): Promise<ContainerSummary[]> {
    return await this.adapter.list(opts);
  }

  async inspectContainer(name: string): Promise<ContainerInfo> {
    return await this.adapter.inspect(name);
  }

  async removeImage(ref: string): Promise<void> {
    this.steps.push("rmi:" + ref);
    await this.adapter.removeImage(ref);
  }

  async healthGate(names: string[], opts: HealthGateOptions): Promise<void> {
    this.steps.push("health:" + names.join(","));
    for (const name of names) await this.waitForHttp(name, opts);
  }

  /**
   * The health gate stays a curl request, executed by a throwaway sidecar on
   * the bundant network (the app image cannot be assumed to carry curl, and
   * the host's HTTP view is not the container network's). The sidecar is
   * created/started/read/removed entirely through the API.
   */
  private async waitForHttp(name: string, opts: HealthGateOptions): Promise<void> {
    const interval = opts.intervalMs ?? 500;
    const deadline = Date.now() + opts.timeoutMs;
    const endpoint = "http://" + name + ":" + opts.port + opts.path;
    let last = "";
    while (Date.now() <= deadline) {
      const probe = await this.runProbe(endpoint);
      last = probe.body === "" ? "exit " + probe.code : probe.body;
      if (probe.code === 0 && probe.body.trim() === "200") return;
      await sleep(interval);
    }
    throw new Error(
      "health gate failed: GET " + endpoint + " never returned 200 (last: " + last + ")",
    );
  }

  private async runProbe(endpoint: string): Promise<{ code: number; body: string }> {
    const name = "bundant-probe-" + process.pid.toString(36) + "-" + (++probeCounter).toString(36);
    const spec: ContainerSpec = {
      image: PROBE_IMAGE,
      name,
      env: [],
      labels: { "bundant.kind": "probe" },
      network: NETWORK,
      restart: "no",
      cmd: [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "3",
        endpoint,
      ],
    };
    const { id } = await this.adapter.create(spec);
    try {
      await this.adapter.start(id);
      const until = Date.now() + 5000;
      let info = await this.adapter.inspect(id);
      while (info.state.running && Date.now() < until) {
        await sleep(25);
        info = await this.adapter.inspect(id);
      }
      let body = "";
      for await (const line of this.adapter.logs(id, { tail: 20 })) body += line + "\n";
      return { code: info.state.exitCode, body: body.trim() };
    } finally {
      await this.adapter.remove(id, { force: true });
    }
  }

  async proxyEnsure(image: string): Promise<void> {
    this.steps.push("proxy-ensure");
    let running = false;
    let exists = true;
    try {
      const info = await this.adapter.inspect(PROXY_CONTAINER);
      running = info.state.running;
    } catch {
      exists = false;
    }
    if (running) return;
    if (exists) {
      await this.adapter.start(PROXY_CONTAINER);
      return;
    }
    const spec: ContainerSpec = {
      image,
      name: PROXY_CONTAINER,
      env: [],
      labels: {},
      network: NETWORK,
      restart: "unless-stopped",
      ports: ["80:80", "443:443"],
      sysctl: this.rt.kind === "podman" ? PROXY_SYSCTL : undefined,
    };
    const { id } = await this.adapter.create(spec);
    await this.adapter.start(id);
  }

  async proxyDeploy(
    serviceId: string,
    targets: string[],
    opts: ProxyDeployOptions,
  ): Promise<void> {
    const parsed = targetsSchema.parse(targets);
    this.steps.push("proxy-deploy:" + parsed.join(","));
    const argv = ["kamal-proxy", "deploy", serviceId];
    for (const target of parsed) argv.push("--target", target);
    if (opts.host !== undefined) argv.push("--host", opts.host);
    if (opts.tls) argv.push("--tls");
    if (opts.healthCheckPath !== undefined) argv.push("--health-check-path", opts.healthCheckPath);
    if (opts.healthCheckPort !== undefined) {
      argv.push("--health-check-port", String(opts.healthCheckPort));
    }
    // kamal-proxy has no HTTP API: it is a CLI inside a container, so the API
    // path for it is exec (which the engine API does expose).
    const r = await this.adapter.exec(PROXY_CONTAINER, argv);
    if (r.code !== 0) {
      throw new Error(
        "proxy-swap failed: exit " + r.code + " err=" + (r.stderr.trim() || r.stdout.trim()),
      );
    }
  }

  async stopOld(
    config: Pick<BundantConfig, "service" | "role" | "group">,
    keep: string[],
  ): Promise<void> {
    this.steps.push("stop-old:" + keep.join(","));
    const keepSet = new Set(keep);
    const rows = await this.adapter.list({
      all: true,
      labels: serviceLabels({ service: config.service, group: config.group }),
    });
    for (const row of rows) {
      if (keepSet.has(row.name)) continue;
      if (!belongsToService(row.name, config)) continue;
      if (row.labels["bundant.kind"] === "accessory") continue;
      await this.adapter.stop(row.name);
    }
  }

  async history(
    labels: Record<string, string>,
    config: Pick<BundantConfig, "service" | "role" | "group">,
  ): Promise<RevisionEntry[]> {
    const rows = await this.adapter.list({ all: true, labels });
    return rows
      .filter((row) => belongsToService(row.name, config))
      .map((row) => ({
        name: row.name,
        revision: revisionOf(row.name, config.service, config.role, config.group),
        createdAt: row.created > 0 ? new Date(row.created * 1000).toISOString() : "",
        state: row.status !== "" ? row.status : row.state,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async proxyList(): Promise<string[]> {
    const r = await this.adapter.exec(PROXY_CONTAINER, ["kamal-proxy", "list"]);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
      .filter((line) => line !== "")
      .map((line) => line.split(/\s+/)[0] ?? "")
      .filter((id) => id !== "" && id !== "Service");
  }

  async proxyRemove(serviceId: string): Promise<void> {
    this.steps.push("proxy-remove:" + serviceId);
    const r = await this.adapter.exec(PROXY_CONTAINER, ["kamal-proxy", "remove", serviceId]);
    // Removing an absent route is a no-op for delete's "tolerated" contract.
    if (r.code !== 0 && !/not found|no such|unknown/i.test(r.stderr + r.stdout)) {
      throw new Error("proxy-remove failed: " + (r.stderr.trim() || r.stdout.trim()));
    }
  }

  async removeEnv(remotePath: string): Promise<void> {
    this.steps.push("env-remove:" + remotePath);
    // The API path writes no env file; this removes one left by an older release.
    await this.hostRun("env-remove", "rm -f " + remotePath);
  }

  async logs(name: string, tail: number): Promise<string> {
    const lines: string[] = [];
    for await (const line of this.adapter.logs(name, { tail })) lines.push(line);
    return lines.length === 0 ? "" : lines.join("\n") + "\n";
  }

  async tcpGate(name: string, port: number, opts: HealthGateOptions): Promise<void> {
    this.steps.push("tcp:" + name + ":" + port);
    const interval = opts.intervalMs ?? 500;
    const deadline = Date.now() + opts.timeoutMs;
    let last = "";
    while (Date.now() <= deadline) {
      const code = await this.runTcpProbe(name, port);
      last = "exit " + code;
      if (code === 0) return;
      await sleep(interval);
    }
    throw new Error("tcp readiness failed: " + name + ":" + port + " (" + last + ")");
  }

  private async runTcpProbe(name: string, port: number): Promise<number> {
    const probeName = "bundant-probe-tcp-" + process.pid.toString(36) + "-" + (++probeCounter).toString(36);
    const spec: ContainerSpec = {
      image: TCP_IMAGE,
      name: probeName,
      env: [],
      labels: { "bundant.kind": "probe" },
      network: NETWORK,
      restart: "no",
      cmd: ["sh", "-c", "nc -z -w 3 " + name + " " + port],
    };
    const { id } = await this.adapter.create(spec);
    try {
      await this.adapter.start(id);
      const until = Date.now() + 5000;
      let info = await this.adapter.inspect(id);
      while (info.state.running && Date.now() < until) {
        await sleep(25);
        info = await this.adapter.inspect(id);
      }
      return info.state.exitCode;
    } finally {
      await this.adapter.remove(id, { force: true });
    }
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.steps.push("volume-create:" + name);
    await this.adapter.createVolume(name, labels);
  }

  async removeVolume(name: string): Promise<void> {
    this.steps.push("volume-remove:" + name);
    await this.adapter.removeVolume(name);
  }

  async inspectVolume(name: string): Promise<{ labels: Record<string, string> }> {
    return await this.adapter.inspectVolume(name);
  }

  async pruneImages(): Promise<void> {
    this.steps.push("prune-images");
    await this.adapter.pruneImages();
  }

  async close(): Promise<void> {
    if (this.disposeSession !== undefined) {
      await this.disposeSession();
      return;
    }
    await this.closeAdapter();
    await this.exec.close();
  }
}
