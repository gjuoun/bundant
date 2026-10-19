import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "./config.ts";
import { containerName, indexedContainerName } from "./replicas.ts";
import { replicaOf, revisionOf } from "./revisions.ts";
import { serviceId } from "./commands/proxy.ts";
import { buildDeleteSteps } from "./delete.ts";
import { stopOld } from "./commands/docker.ts";
import { runtimeFor } from "./runtime.ts";
import { accessoryContainerName, belongsToService, isGrouped } from "./naming.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "api",
    image: "traefik/whoami",
    role: "web",
    replicas: 1,
    kind: "service",
    group: "default",
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: true, host: "x.test", port: 80, tls: false, image: "kamal-proxy" },
    ...over,
  };
}

describe("group-scoped names", () => {
  test("all four rules: ungrouped/grouped x single/replicas", () => {
    expect(containerName(cfg(), "abc1234")).toBe("api-web-abc1234");
    expect(containerName(cfg({ replicas: 2 }), "abc1234", 2)).toBe("api-web-abc1234-2");
    expect(containerName(cfg({ group: "alpha" }), "abc1234")).toBe("alpha-api-web-abc1234");
    expect(containerName(cfg({ group: "alpha", replicas: 2 }), "abc1234", 2)).toBe(
      "alpha-api-web-abc1234-2",
    );
    expect(indexedContainerName(cfg({ group: "alpha" }), "abc1234", 2)).toBe(
      "alpha-api-web-abc1234-2",
    );
  });

  test("proxy id keeps the role segment, default never prefixes", () => {
    expect(serviceId("api", "web")).toBe("api-web");
    expect(serviceId("api", "web", "default")).toBe("api-web");
    expect(serviceId("api", "web", "alpha")).toBe("alpha-api-web");
  });

  test("accessories: grouped gets <group>-<service>, standalone stays stable", () => {
    expect(accessoryContainerName(cfg({ kind: "accessory", service: "db", group: "alpha" }))).toBe("alpha-db");
    expect(accessoryContainerName(cfg({ kind: "accessory", group: "default" }))).toBe("api");
    expect(accessoryContainerName(cfg({ kind: "accessory", group: undefined }))).toBe("api");
  });

  test("revisionOf and replicaOf understand the group prefix", () => {
    expect(revisionOf("alpha-api-web-abc1234", "api", "web", "alpha")).toBe("abc1234");
    expect(revisionOf("alpha-api-web-abc1234-2", "api", "web", "alpha")).toBe("abc1234");
    expect(replicaOf("alpha-api-web-abc1234-2", "api", "web", "alpha")).toBe(2);
    expect(replicaOf("alpha-api-web-abc1234", "api", "web", "alpha")).toBeUndefined();
  });

  test("legacy grouped names still parse to the same revision", () => {
    // Pre-JW-174 containers were <service>-<role>-<rev> but carried the group label.
    expect(revisionOf("api-web-abc1234", "api", "web", "alpha")).toBe("abc1234");
    expect(replicaOf("api-web-abc1234-3", "api", "web", "alpha")).toBe(3);
    expect(belongsToService("api-web-abc1234", cfg({ group: "alpha" }))).toBe(true);
    expect(belongsToService("alpha-api-web-abc1234", cfg({ group: "alpha" }))).toBe(true);
    expect(belongsToService("api-web-abc1234", cfg({ group: "default" }))).toBe(true);
    expect(belongsToService("api-web-abc1234", cfg({ group: "beta" }))).toBe(true);
  });

  test("delete sweeps the new prefix and legacy names guarded by the group label", () => {
    const steps = buildDeleteSteps(cfg({ group: "alpha" }), {
      yes: true,
      images: false,
      dryRun: true,
    });
    const containers = steps.find((s) => s.phase === "containers");
    expect(containers?.cmds[0]).toContain('name=alpha-api-web-');
    expect(containers?.cmds[0]).toContain('name=api-web-');
    expect(containers?.cmds[0]).toContain("bundant.group");
    expect(containers?.cmds[0]).toContain('"alpha"');
  });

  test("stop-old sweeps the new prefix and legacy names for a real group", () => {
    const cmd = stopOld(runtimeFor("docker"), cfg({ group: "alpha" }), ["alpha-api-web-abc"]);
    expect(cmd).toContain('name=alpha-api-web-');
    expect(cmd).toContain('name=api-web-');
    expect(cmd).toContain("bundant.group");
    expect(cmd).toContain('"alpha"');
    expect(cmd).toContain("alpha-api-web-abc");
  });

  test("ungrouped delete keeps the historical single-prefix command", () => {
    const steps = buildDeleteSteps(cfg(), { yes: true, images: false, dryRun: true });
    const containers = steps.find((s) => s.phase === "containers");
    expect(containers?.cmds[0]).not.toContain("bundant.group");
    expect(containers?.cmds[0]).toContain('name=api-web-');
  });

  test("isGrouped ignores the default namespace", () => {
    expect(isGrouped(cfg())).toBe(false);
    expect(isGrouped(cfg({ group: undefined }))).toBe(false);
    expect(isGrouped(cfg({ group: "alpha" }))).toBe(true);
  });
});
