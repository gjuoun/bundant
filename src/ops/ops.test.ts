import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
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
import { deployOnHost, pullForPolicy } from "../deploy.ts";
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
  /** Containers the host already has (case-collision guard tests). */
  existing: ContainerSummary[] = [];
  /** Whether the image is already present (pull-policy tests). */
  imageAvailable = false;
  /** Host layer inventory, keyed by image id. */
  imageLayerMap: Record<string, string[]> = {};
  /** Bodies received by loadImage. */
  readonly loadCalls: Buffer[] = [];

  async imagePresent(): Promise<boolean> {
    return this.imageAvailable;
  }
  async pull(ref: string): Promise<void> {
    this.steps.push("pull:" + ref);
  }
  async loadImage(stream: NodeJS.ReadableStream): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    this.loadCalls.push(Buffer.concat(chunks));
  }
  async imageIds(): Promise<string[]> {
    return Object.keys(this.imageLayerMap);
  }
  async imageLayers(ref: string): Promise<string[]> {
    return this.imageLayerMap[ref] ?? [];
  }
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
    return this.existing;
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
    adapter.imageAvailable = true;
    const { legacy, api } = opsPair(adapter);

    await deployOnHost(legacy, plan, loadedFor(config), { host: "box.test" });
    await deployOnHost(api, plan, loadedFor(config), { host: "box.test" });

    expect(api.steps).toEqual(legacy.steps);
    expect(legacy.steps).toEqual([
      "prereqs",
      "network",
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

describe("pull policy", () => {
  const table: Array<{
    present: boolean;
    policy: "missing" | "always" | "never";
    pulls: number;
    error: boolean;
  }> = [
    { present: true, policy: "missing", pulls: 0, error: false },
    { present: true, policy: "always", pulls: 1, error: false },
    { present: true, policy: "never", pulls: 0, error: false },
    { present: false, policy: "missing", pulls: 1, error: false },
    { present: false, policy: "always", pulls: 1, error: false },
    { present: false, policy: "never", pulls: 0, error: true },
  ];

  for (const row of table) {
    test("present=" + row.present + " policy=" + row.policy, async () => {
      const adapter = new FakeAdapter();
      adapter.imageAvailable = row.present;
      if (row.error) {
        await expect(pullForPolicy(adapter, "x:1", row.policy)).rejects.toThrow(/--pull never/);
      } else {
        await pullForPolicy(adapter, "x:1", row.policy);
      }
      expect(adapter.steps.filter((s) => s.startsWith("pull:")).length).toBe(row.pulls);
    });
  }
});

describe("case-collision guard on the real deploy path", () => {
  function row(service: string, group = "default"): ContainerSummary {
    return {
      id: service,
      name: group + "." + service + ".web.cc1",
      image: "traefik/whoami:v1.10",
      state: "running",
      status: "Up",
      labels: { "bundant.group": group, "bundant.service": service, "bundant.kind": "service" },
      created: 0,
      ports: "",
    };
  }

  function v2Config(over: Partial<BundantConfig> = {}): BundantConfig {
    return cfg({ version: 2, service: "ShopApi", ...over });
  }

  test("forward and reverse case-only duplicates fail before create", async () => {
    for (const existing of ["ShopApi", "shopapi"]) {
      const config = v2Config({ service: existing === "ShopApi" ? "shopapi" : "ShopApi" });
      const plan = buildDeployPlan(config, "cc2");
      const adapter = new FakeAdapter();
      adapter.existing = [row(existing)];
      const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});
      await expect(
        deployOnHost(ops, plan, loadedFor(config), { host: "box.test" }),
      ).rejects.toThrow(/case-collision: default\//);
      expect(adapter.steps.some((s) => s.startsWith("create:"))).toBe(false);
    }
  });

  test("--allow-case-collision lets the deploy proceed", async () => {
    const config = v2Config({ service: "shopapi" });
    const plan = buildDeployPlan(config, "cc2");
    const adapter = new FakeAdapter();
    adapter.existing = [row("ShopApi")];
    const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});
    await deployOnHost(ops, plan, loadedFor(config), {
      host: "box.test",
      allowCaseCollision: true,
    });
    expect(adapter.steps.some((s) => s.startsWith("create:"))).toBe(true);
  });

  test("the same service in a different group does not collide", async () => {
    const config = v2Config({ group: "Other", service: "ShopApi" });
    const plan = buildDeployPlan(config, "cc2");
    const adapter = new FakeAdapter();
    adapter.existing = [row("ShopApi", "default")];
    const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});
    await deployOnHost(ops, plan, loadedFor(config), { host: "box.test" });
    expect(adapter.steps.some((s) => s.startsWith("create:"))).toBe(true);
  });
});

describe("incremental image transfer wiring", () => {
  test("deployOnHost reports one transfer and never pulls a local image", async () => {
    const config = cfg();
    const plan = buildDeployPlan(config, "abc1234", { localImage: "app:t1" });
    const adapter = new FakeAdapter();
    const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});
    const reports: { host: string; report: unknown }[] = [];
    await deployOnHost(ops, plan, loadedFor(config), {
      host: "box.test",
      localImageTransfer: async (target) => {
        await target.loadImage(Readable.from([Buffer.from("delta-tar")]));
        return {
          mode: "delta",
          bytesSent: 1234,
          layersReused: 2,
          layersTotal: 3,
          missingLayers: 1,
        };
      },
      onTransfer: (host, report) => reports.push({ host, report }),
    });
    expect(adapter.steps.some((step) => step.startsWith("pull:"))).toBe(false);
    expect(adapter.loadCalls).toHaveLength(1);
    expect(adapter.loadCalls[0]!.toString("utf8")).toBe("delta-tar");
    expect(reports).toEqual([
      { host: "box.test", report: { mode: "delta", bytesSent: 1234, layersReused: 2, layersTotal: 3, missingLayers: 1 } },
    ]);
  });

  test("the CLI fallback path still invokes the legacy pipeline", async () => {
    const config = cfg();
    const plan = buildDeployPlan(config, "abc1234", { localImage: "app:t1" });
    const adapter = new FakeAdapter();
    const ops = new ApiOps(adapter, new FakeExecutor(), runtimeFor("docker"), async () => {});
    const reports: unknown[] = [];
    await deployOnHost(ops, plan, loadedFor(config), {
      host: "box.test",
      localImageTransfer: async () => ({
        mode: "full",
        bytesSent: 9000,
        layersReused: 0,
        layersTotal: 1,
        missingLayers: 1,
      }),
      onTransfer: (_host, report) => reports.push(report),
    });
    expect(reports).toHaveLength(1);
    expect((reports[0] as { mode: string }).mode).toBe("full");
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
    // A new revision skips the pre-create rm; exactly one removal proves the
    // failure cleanup ran.
    expect(adapter.removed.filter((n) => n === "hello-web-abc1234")).toHaveLength(1);
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
