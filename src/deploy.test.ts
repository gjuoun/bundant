import { describe, expect, test } from "bun:test";
import type { ContainerSpec } from "./adapters/types.ts";
import { ArchMismatchError } from "./agent/errors.ts";
import { DEFAULT_GROUP, type BundantConfig, type LoadedConfig } from "./config.ts";
import { deploy, deployOnHost } from "./deploy.ts";
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

/**
 * The real local-image path: local inspect answers arm64, ssh uname answers
 * amd64, and the transfer hook must never run. This is the regression the
 * injected-probe test could not see.
 */
function localImageExec(calls: string[]): {
  kind: "local";
  run(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  putFile(): Promise<void>;
  close(): Promise<void>;
} {
  return {
    kind: "local",
    async run(cmd: string) {
      calls.push(cmd);
      if (cmd.includes("RootFS.Layers")) {
        return { code: 0, stdout: JSON.stringify(["sha256:" + "a".repeat(64)]), stderr: "" };
      }
      if (cmd.includes("Architecture")) {
        return { code: 0, stdout: "arm64 linux\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async putFile() {},
    async close() {},
  };
}

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

  test("the real local-image path refuses before any transfer", async () => {
    const localCalls: string[] = [];
    const sshCalls: string[] = [];
    let transfers = 0;
    let openedOps = 0;
    let mutations = 0;
    const ssh = {
      kind: "local" as const,
      async run(cmd: string) {
        sshCalls.push(cmd);
        if (cmd === "uname -s -m") return { code: 0, stdout: "Linux x86_64\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async putFile() {},
      async close() {},
    };
    const localPlan = buildDeployPlan(cfg({ runtime: "podman" }), "r0", {
      localImage: "app:arm",
    });
    await expect(
      deploy(localPlan, loadedFor(cfg({ runtime: "podman" })), {
        openPrimary: () => ssh as never,
        localExec: localImageExec(localCalls),
        localImageTransfer: async () => {
          transfers += 1;
          return {
            mode: "delta" as const,
            bytesSent: 0,
            layersReused: 0,
            layersTotal: 0,
            missingLayers: 0,
          };
        },
        openOps: async () => {
          openedOps += 1;
          return {
            steps: [],
            async listContainers() {
              return [];
            },
            async putEnv() {},
            async hostPrereqs() {},
            async imagePresent() {
              return true;
            },
            async imageId() {
              return "sha256:abc";
            },
            async imagePlatform() {
              return { os: "linux", arch: "arm64" };
            },
            async hostPlatform() {
              return { os: "linux", arch: "amd64" };
            },
            async binfmtPresent() {
              return false;
            },
            async close() {},
            async removeContainer() {
              mutations += 1;
            },
            async createContainer() {
              mutations += 1;
              return "id";
            },
          } as unknown as RuntimeOps;
        },
      }),
    ).rejects.toBeInstanceOf(ArchMismatchError);
    expect(transfers).toBe(0);
    expect(openedOps).toBe(0);
    expect(mutations).toBe(0);
    expect(sshCalls).toEqual(["uname -s -m"]);
    expect(localCalls.some((cmd) => cmd.includes("Architecture"))).toBe(true);
  });

  test("a foreign image without --allow-emulation fails before create", async () => {
    const { ops, created } = fakeOps({ imageArch: "arm64", hostArch: "amd64", binfmt: true });
    await expect(deployOnHost(ops, plan, loadedFor(cfg()), { host: "host1" })).rejects.toThrow(
      /arch mismatch/,
    );
    expect(created).toHaveLength(0);
  });
});
