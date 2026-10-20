import { describe, expect, test } from "bun:test";
import type {
  ContainerInfo,
  ContainerSpec,
  ContainerSummary,
  ExecResult,
  RuntimeAdapter,
  StatsSample,
} from "../adapters/types.ts";
import type { BundantConfig, LoadedConfig } from "../config.ts";
import { buildDeployPlan } from "../planner.ts";
import { runtimeFor } from "../runtime.ts";
import type { Executor } from "../types.ts";
import { deployOnHost } from "../deploy.ts";
import { ApiOps } from "./adapter.ts";
import { LegacyOps } from "./legacy.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "hello",
    image: "traefik/whoami:v1.10",
    role: "web",
    replicas: 1,
    kind: "service",
    group: "default",
    hosts: ["box.test"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 1 },
    proxy: {
      enabled: true,
      host: "hello.bundant.test",
      port: 80,
      tls: false,
      image: "kamal-proxy:latest",
    },
    ...over,
  };
}

function loadedFor(config: BundantConfig): LoadedConfig {
  return { config, envContent: null, envCount: 0, path: "/tmp/deploy.yml" };
}

class FakeExecutor implements Executor {
  readonly kind = "fake";
  readonly commands: string[] = [];
  probe = "200";
  async run(cmd: string): Promise<ExecResult> {
    this.commands.push(cmd);
    if (cmd.includes("curlimages/curl")) {
      return { code: this.probe === "200" ? 0 : 0, stdout: this.probe, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  async putFile(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeAdapter implements RuntimeAdapter {
  readonly kind = "docker" as const;
  readonly engineVersion = "29.1.3";
  readonly apiVersion = "1.52";
  readonly steps: string[] = [];
  readonly execCalls: string[][] = [];
  readonly removed: string[] = [];
  /** What the health sidecar prints. */
  probeBody = "200";

  async pull(ref: string): Promise<void> {
    this.steps.push("pull:" + ref);
  }
  async loadImage(): Promise<void> {}
  async pruneImages(): Promise<void> {
    this.steps.push("prune-images");
  }
  async create(spec: ContainerSpec): Promise<{ id: string }> {
    this.steps.push("create:" + spec.name);
    return { id: spec.name };
  }
  async start(id: string): Promise<void> {
    this.steps.push("start:" + id);
  }
  async stop(id: string): Promise<void> {
    this.steps.push("stop:" + id);
  }
  async remove(id: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void> {
    this.steps.push("remove:" + id);
    this.removed.push(id);
  }
  async inspect(id: string): Promise<ContainerInfo> {
    const probe = id.startsWith("bundant-probe");
    return {
      id,
      name: id,
      image: "x",
      state: {
        status: probe ? "exited" : "running",
        running: probe ? false : true,
        exitCode: 0,
        restarts: 0,
      },
      labels: {},
      env: [],
      restartPolicy: "unless-stopped",
      logDriver: "json-file",
      binds: [],
      networkMode: "bundant",
      raw: {},
    };
  }
  async list(): Promise<ContainerSummary[]> {
    return [];
  }
  async listContainers(): Promise<ContainerSummary[]> {
    return [];
  }
  async inspectContainer(id: string): Promise<ContainerInfo> {
    return await this.inspect(id);
  }
  async removeImage(): Promise<void> {}
  async proxyList(): Promise<string[]> {
    return [];
  }
  async proxyRemove(): Promise<void> {}
  async removeEnv(): Promise<void> {}
  async tcpGate(): Promise<void> {}
  logs(): AsyncIterable<string> {
    const body = this.probeBody;
    return (async function* () {
      yield body;
    })();
  }
  async stats(): Promise<StatsSample> {
    throw new Error("unused");
  }
  async exec(_id: string, argv: string[]): Promise<ExecResult> {
    this.execCalls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  }
  async inspectVolume(): Promise<{ labels: Record<string, string> }> {
    return { labels: {} };
  }
  async createVolume(): Promise<void> {
    this.steps.push("volume-create");
  }
  async removeVolume(): Promise<void> {
    this.steps.push("volume-remove");
  }
  async ensureNetwork(): Promise<void> {
    this.steps.push("network");
  }
  events(): AsyncIterable<never> {
    return (async function* () {})();
  }
}

function opsPair(adapter: FakeAdapter) {
  const config = cfg();
  const exec = new FakeExecutor();
  return {
    legacy: new LegacyOps(exec, runtimeFor("docker")),
    api: new ApiOps(adapter, exec, runtimeFor("docker"), async () => {}),
  };
}

describe("RuntimeOps equivalence", () => {
  test("legacy and adapter implementations produce the same semantic sequence", async () => {
    const config = cfg();
    const plan = buildDeployPlan(config, "abc1234");
    const adapter = new FakeAdapter();
    const { legacy, api } = opsPair(adapter);

    await deployOnHost(legacy, plan, loadedFor(config), { host: "box.test" });
    await deployOnHost(api, plan, loadedFor(config), { host: "box.test" });

    expect(api.steps).toEqual(legacy.steps);
    expect(legacy.steps).toEqual([
      "prereqs",
      "pull:traefik/whoami:v1.10",
      "network",
      "remove:hello-web-abc1234",
      "create:hello-web-abc1234",
      "start:hello-web-abc1234",
      "health:hello-web-abc1234",
      "proxy-ensure",
      "proxy-deploy:hello-web-abc1234:80",
      "stop-old:hello-web-abc1234",
    ]);
  });

  test("the API path passes Env directly and writes no remote env file", async () => {
    const config = cfg({ env: { vars: { SECRET: "s3cr3t" } } });
    const plan = buildDeployPlan(config, "abc1234");
    const adapter = new FakeAdapter();
    const exec = new FakeExecutor();
    const ops = new ApiOps(adapter, exec, runtimeFor("docker"), async () => {});
    const loaded = { ...loadedFor(config), envContent: "SECRET=s3cr3t\n", envCount: 1 };

    await deployOnHost(ops, plan, loaded, { host: "box.test", envLocalFile: null });
    expect(ops.steps[0]).toBe("env:1");
    expect(exec.commands.some((c) => c.includes("putFile"))).toBe(false);
    expect(adapter.steps).not.toContain("env:1");
  });
});

describe("zero-downtime contract on the ops layer", () => {
  test("a failing health gate removes the new container and never swaps the proxy", async () => {
    const config = cfg();
    const plan = buildDeployPlan(config, "abc1234");
    const adapter = new FakeAdapter();
    adapter.probeBody = "500";
    const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});

    await expect(deployOnHost(ops, plan, loadedFor(config), { host: "box.test" })).rejects.toThrow(
      /health gate failed/,
    );
    // Once before create (rm -f) and once by the failure cleanup: a single
    // removal would mean the cleanup loop never ran.
    expect(adapter.removed.filter((n) => n === "hello-web-abc1234")).toHaveLength(2);
    expect(adapter.execCalls).toHaveLength(0);
  });

  test("the proxy swap receives one target set (all replicas, one exec)", async () => {
    const config = cfg({ replicas: 2 });
    const plan = buildDeployPlan(config, "abc1234");
    const adapter = new FakeAdapter();
    const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});

    await deployOnHost(ops, plan, loadedFor(config), { host: "box.test" });
    const swaps = adapter.execCalls.filter((argv) => argv[0] === "kamal-proxy" && argv[1] === "deploy");
    expect(swaps).toHaveLength(1);
    expect(swaps[0]!.filter((a) => a === "--target")).toHaveLength(2);
    expect(swaps[0]!).toContain("hello-web-abc1234-1:80");
    expect(swaps[0]!).toContain("hello-web-abc1234-2:80");
  });
});
