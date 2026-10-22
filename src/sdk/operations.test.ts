import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import type { ContainerSpec } from "../adapters/types.ts";
import type { RuntimeOps } from "../ops/types.ts";
import { makeSdkLayer } from "./layer.ts";
import { deploy, operationFailure, status } from "./operations.ts";
import { defineAccessory, defineDeployment, type ServiceSpec } from "./spec.ts";

const HOSTS = ["root@host1"];

const api = defineDeployment({
  group: "sdk",
  service: "api",
  image: "app:t1",
  hosts: HOSTS,
  env: { A: "1", B: "2" },
});

function fakeSsh() {
  return {
    kind: "local" as const,
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
    async putFile() {},
    async close() {},
  };
}

function fakeOps() {
  const created: ContainerSpec[] = [];
  const envCounts: number[] = [];
  const ops = {
    steps: [] as string[],
    async listContainers() {
      return [];
    },
    async putEnv(_path: string | undefined, count: number) {
      envCounts.push(count);
    },
    async hostPrereqs() {},
    async imagePresent() {
      return true;
    },
    async pull() {},
    async imageId() {
      return "sha256:abc";
    },
    async imagePlatform() {
      return { os: "linux", arch: "amd64" };
    },
    async hostPlatform() {
      return { os: "linux", arch: "amd64" };
    },
    async binfmtPresent() {
      return false;
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
  return { ops, created, envCounts };
}

describe("deploy operation", () => {
  it("deploys a spec, prints nothing, and reports the revision", async () => {
    const fake = fakeOps();
    const layer = makeSdkLayer({
      hosts: HOSTS,
      deployOptions: {
        openPrimary: () => fakeSsh() as never,
        archPreflight: async () => undefined,
        openOps: async () => fake.ops,
      },
    });
    const printed: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      printed.push(args);
    };
    try {
      const result = await Effect.runPromise(
        Effect.provide(deploy(api, { revision: "sdkrev" }), layer),
      );
      expect(result).toEqual({ status: "deployed", revision: "sdkrev" });
    } finally {
      console.log = original;
    }
    expect(printed).toEqual([]);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.name).toBe("sdk.api.web.sdkrev");
    expect(fake.envCounts).toEqual([2]);
    expect(fake.created[0]!.env).toEqual(["A=1", "B=2"]);
  });

  it("refuses an accessory", async () => {
    const db = defineAccessory({ group: "sdk", name: "db", image: "img", hosts: HOSTS });
    const exit = await Effect.runPromiseExit(
      Effect.provide(deploy(db as unknown as ServiceSpec), makeSdkLayer({ hosts: HOSTS })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("is an accessory");
    }
  });
});

describe("operationFailure", () => {
  it("maps exit codes to the existing error catalog", () => {
    expect(operationFailure("deploy", "sdk.api.web", 1)).toMatchObject({
      _tag: "UnknownError",
    });
    expect(operationFailure("rollback", "sdk.api.web", 1, "r1")).toMatchObject({
      _tag: "NotFoundError",
      target: "r1",
    });
    expect(operationFailure("scale", "sdk.api.web", 2)).toMatchObject({
      _tag: "UsageError",
    });
  });
});

describe("status operation", () => {
  function summary(name: string, labels: Record<string, string>) {
    return {
      id: name,
      name,
      image: "img",
      state: "running",
      status: "Up",
      labels,
      created: 1,
      ports: "",
    };
  }

  it("returns the status rows the CLI renders", async () => {
    const opened: string[] = [];
    const layer = makeSdkLayer({
      hosts: ["root@host1"],
      openOps: (async (connection: { sshTarget: string }) => {
        opened.push(connection.sshTarget);
        return {
          async listContainers() {
            return [
              summary("sdk.api.web.r1", {
                "bundant.group": "sdk",
                "bundant.service": "api",
                "bundant.kind": "service",
                "bundant.revision": "r1",
              }),
              summary("sdk.db", {
                "bundant.group": "sdk",
                "bundant.service": "db",
                "bundant.kind": "accessory",
              }),
            ];
          },
          async close() {},
        } as never;
      }) as never,
    });
    const rows = await Effect.runPromise(Effect.provide(status("sdk.**"), layer));
    expect(opened).toEqual(["root@host1"]);
    expect(rows.map((row) => row.path).sort()).toEqual(["sdk.api.web", "sdk.db"]);
    expect(rows.every((row) => row.live === 1)).toBe(true);
  });
});

