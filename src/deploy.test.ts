import { describe, expect, test } from "bun:test";
import type { ContainerSpec } from "./adapters/types.ts";
import { DEFAULT_GROUP, type BundantConfig, type LoadedConfig } from "./config.ts";
import { deployOnHost } from "./deploy.ts";
import { LABEL_EMULATED } from "./labels.ts";
import type { RuntimeOps } from "./ops/types.ts";
import { buildDeployPlan } from "./planner.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    version: 2,
    service: "hello",
    image: "app:t1",
    role: "web",
    replicas: 1,
    kind: "service",
    group: DEFAULT_GROUP,
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: false, port: 80, tls: false, image: "kamal-proxy" },
    ...over,
  };
}

function loadedFor(config: BundantConfig): LoadedConfig {
  return { config, envContent: null, envCount: 0, path: "/tmp/deploy.yml", version: 2 };
}

/** Only the methods deployOnHost touches; the rest never run in this path. */
function fakeOps(input: {
  imageArch: string;
  hostArch: string;
  binfmt: boolean;
}): { ops: RuntimeOps; created: ContainerSpec[] } {
  const created: ContainerSpec[] = [];
  const ops = {
    steps: [] as string[],
    async listContainers() {
      return [];
    },
    async putEnv() {},
    async hostPrereqs() {},
    async imagePresent() {
      return true;
    },
    async pull() {},
    async imageId() {
      return "sha256:abc";
    },
    async imagePlatform() {
      return { os: "linux", arch: input.imageArch };
    },
    async hostPlatform() {
      return { os: "linux", arch: input.hostArch };
    },
    async binfmtPresent() {
      return input.binfmt;
    },
    async ensureNetwork() {},
    async removeContainer() {},
    async createContainer(spec: ContainerSpec) {
      created.push(spec);
      return spec.name;
    },
    async startContainer() {},
    async healthGate() {},
    async stopOld() {},
    async close() {},
  } as unknown as RuntimeOps;
  return { ops, created };
}

const plan = buildDeployPlan(cfg(), "r0");

describe("emulated deploys", () => {
  test("a native deploy carries no emulated label", async () => {
    const { ops, created } = fakeOps({ imageArch: "amd64", hostArch: "amd64", binfmt: false });
    await deployOnHost(ops, plan, loadedFor(cfg()), { host: "host1" });
    expect(created[0]!.labels[LABEL_EMULATED]).toBeUndefined();
  });

  test("a foreign image with binfmt is labelled and reported", async () => {
    const { ops, created } = fakeOps({ imageArch: "arm64", hostArch: "amd64", binfmt: true });
    const seen: string[] = [];
    await deployOnHost(ops, plan, loadedFor(cfg()), {
      host: "host1",
      allowEmulation: true,
      onEmulation: (verdict) => seen.push(verdict.image.arch + ":" + verdict.host.arch),
    });
    expect(created[0]!.labels[LABEL_EMULATED]).toBe("true");
    expect(seen).toEqual(["arm64:amd64"]);
  });

  test("a foreign image without --allow-emulation fails before create", async () => {
    const { ops, created } = fakeOps({ imageArch: "arm64", hostArch: "amd64", binfmt: true });
    await expect(deployOnHost(ops, plan, loadedFor(cfg()), { host: "host1" })).rejects.toThrow(
      /arch mismatch/,
    );
    expect(created).toHaveLength(0);
  });
});
