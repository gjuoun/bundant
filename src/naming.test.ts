import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "./config.ts";
import { containerName, indexedContainerName } from "./replicas.ts";
import { buildDeleteSteps } from "./delete.ts";
import { stopOld } from "./commands/docker.ts";
import { runtimeFor } from "./runtime.ts";
import { accessoryContainerName, belongsToService, isGrouped } from "./naming.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    version: 2,
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
    expect(containerName(cfg(), "abc1234")).toBe("default.api.web.abc1234");
    expect(containerName(cfg({ replicas: 2 }), "abc1234", 2)).toBe("default.api.web.abc1234.2");
    expect(containerName(cfg({ group: "alpha" }), "abc1234")).toBe("alpha.api.web.abc1234");
    expect(containerName(cfg({ group: "alpha", replicas: 2 }), "abc1234", 2)).toBe(
      "alpha.api.web.abc1234.2",
    );
    expect(indexedContainerName(cfg({ group: "alpha" }), "abc1234", 2)).toBe(
      "alpha.api.web.abc1234.2",
    );
  });

  test("accessories: grouped gets <group>.<service>, standalone carries the default group", () => {
    expect(accessoryContainerName(cfg({ kind: "accessory", service: "db", group: "alpha" }))).toBe("alpha.db");
    expect(accessoryContainerName(cfg({ kind: "accessory", group: "default" }))).toBe("default.api");
    expect(accessoryContainerName(cfg({ kind: "accessory", group: undefined }))).toBe("default.api");
  });

  test("composition is injective: a hyphen in the service cannot alias a group split", () => {
    const grouped = containerName(cfg({ group: "ab", service: "c" }), "1234");
    const otherSplit = containerName(cfg({ group: "a", service: "b-c" }), "1234");
    expect(grouped).toBe("ab.c.web.1234");
    expect(otherSplit).toBe("a.b-c.web.1234");
    expect(grouped).not.toBe(otherSplit);
  });

  test("belongsToService matches the composed prefix only", () => {
    expect(belongsToService("alpha.api.web.abc1234", cfg({ group: "alpha" }))).toBe(true);
    expect(belongsToService("alpha.api.web.abc1234.2", cfg({ group: "alpha" }))).toBe(true);
    expect(belongsToService("api-web-abc1234", cfg({ group: "alpha" }))).toBe(false);
    expect(belongsToService("beta.api.web.abc1234", cfg({ group: "alpha" }))).toBe(false);
  });

  test("delete sweeps the composed prefix", () => {
    const steps = buildDeleteSteps(cfg({ group: "alpha" }), {
      yes: true,
      images: false,
      dryRun: true,
    });
    const containers = steps.find((s) => s.phase === "containers");
    expect(containers?.cmds[0]).toContain('name=alpha.api.web.');
    expect(containers?.cmds[0]).not.toContain('name=api-web-');
  });

  test("stop-old uses the scoped prefix for a real group", () => {
    const cmd = stopOld(runtimeFor("docker"), cfg({ group: "alpha" }), ["alpha.api.web.abc"]);
    expect(cmd).toContain('name=alpha-api-web-');
    expect(cmd).not.toContain('name=api-web-');
  });

  test("ungrouped delete keeps the single-prefix command", () => {
    const steps = buildDeleteSteps(cfg(), { yes: true, images: false, dryRun: true });
    const containers = steps.find((s) => s.phase === "containers");
    expect(containers?.cmds[0]).toContain('name=default.api.web.');
  });

  test("isGrouped ignores the default namespace", () => {
    expect(isGrouped(cfg())).toBe(false);
    expect(isGrouped(cfg({ group: undefined }))).toBe(false);
    expect(isGrouped(cfg({ group: "alpha" }))).toBe(true);
  });
});
