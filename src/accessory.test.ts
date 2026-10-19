import { describe, expect, test } from "bun:test";
import { Accessory, AccessoryError, accessoryContainer, accessoryVolumeNames, buildAccessoryRun, tcpReadinessProbe } from "./accessory.ts";
import type { BundantConfig, LoadedConfig } from "./config.ts";
import { runtimeFor } from "./runtime.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "db",
    image: "docker.io/library/postgres:16-alpine",
    role: "web",
    replicas: 1,
    kind: "accessory",
    volumes: ["pgdata:/var/lib/postgresql/data"],
    group: "shop",
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 60, tcp: 5432 },
    proxy: { enabled: false, port: 80, tls: false, image: "docker.io/basecamp/kamal-proxy:latest" },
    ...over,
  };
}

const rt = runtimeFor("docker");

describe("accessory naming + volumes", () => {
  test("container name is the stable service name (no role, no revision)", () => {
    expect(accessoryContainer(cfg())).toBe("db");
    expect(accessoryContainer(cfg())).not.toContain("web");
  });

  test("named volumes parse to their name before the first colon", () => {
    expect(accessoryVolumeNames(cfg())).toEqual(["pgdata"]);
    expect(accessoryVolumeNames(cfg({ volumes: [] }))).toEqual([]);
  });
});

describe("buildAccessoryRun", () => {
  test("carries exact labels and named volumes, and no revision in the name", () => {
    const cmd = buildAccessoryRun(cfg(), rt);
    expect(cmd).toContain("--name db ");
    expect(cmd).toContain("--label bundant.service=db");
    expect(cmd).toContain("--label bundant.group=shop");
    expect(cmd).toContain("--volume pgdata:/var/lib/postgresql/data");
    expect(cmd).not.toContain("db-web");
  });

  test("a standalone accessory lands in default and says it is an accessory", () => {
    const cmd = buildAccessoryRun(cfg({ group: undefined }), rt);
    expect(cmd).toContain("--label bundant.kind=accessory");
    expect(cmd).toContain("--label bundant.group=default");
    expect(cmd).toContain("--label bundant.volumes=");
  });
});

describe("tcp readiness probe", () => {
  test("runs busybox nc against the accessory container and port", () => {
    const cmd = tcpReadinessProbe(cfg(), rt);
    expect(cmd).toContain("docker run --rm --network bundant docker.io/library/busybox");
    expect(cmd).toContain("nc -z -w 3 db 5432");
  });

  test("a missing healthcheck.tcp is a clear error", () => {
    expect(() => tcpReadinessProbe(cfg({ healthcheck: { path: "/", port: 80, timeout: 30 } }), rt)).toThrow(
      AccessoryError,
    );
  });
});

describe("Accessory guard + confirmation", () => {
  test("running an accessory action against a service is an error", async () => {
    const loaded = { config: cfg({ kind: "service" }), envContent: null, envCount: 0, path: "/tmp/deploy.yml" } as LoadedConfig;
    await expect(new Accessory(loaded).run("boot", { yes: false, volumes: false, tail: 10, dryRun: true })).rejects.toThrow(
      AccessoryError,
    );
  });

  test("remove without --yes returns 2 and never opens ssh", async () => {
    const loaded = { config: cfg(), envContent: null, envCount: 0, path: "/tmp/accessory.yml" } as LoadedConfig;
    expect(await new Accessory(loaded).run("remove", { yes: false, volumes: false, tail: 10, dryRun: false })).toBe(2);
  });
});
