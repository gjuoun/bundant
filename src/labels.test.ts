import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { buildSweepSteps, selectSweepVictims } from "./delete.ts";
import { buildDeployPlan, envRemotePath } from "./planner.ts";
import { runtimeFor } from "./runtime.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "api",
    image: "traefik/whoami:v1.10",
    role: "web",
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: true, host: "api.test", port: 80, tls: false, image: "docker.io/basecamp/kamal-proxy:latest" },
    ...over,
  };
}

const rt = runtimeFor("docker");

describe("label rendering (grouped run)", () => {
  test("grouped run carries the exact service and group labels", () => {
    const plan = buildDeployPlan(cfg({ group: "shop" }), "abc1234");
    const run = plan.hostSteps.find((s) => s.phase === "run")!.cmds[1]!;
    expect(run).toContain("--label bundant.service=api");
    expect(run).toContain("--label bundant.group=shop");
    expect(plan.meta.group).toBe("shop");
  });

  test("ungrouped run is byte-identical to the pre-groups plan", () => {
    const plan = buildDeployPlan(cfg(), "abc1234");
    const run = plan.hostSteps.find((s) => s.phase === "run")!.cmds[1]!;
    expect(run).toBe(
      "docker run -d --name api-web-abc1234 --network bundant --restart unless-stopped traefik/whoami:v1.10",
    );
    expect(plan.meta.group).toBeUndefined();
  });

  test("grouped env path and lock key are namespaced", () => {
    expect(envRemotePath(cfg({ group: "shop" }))).toBe("~/.bundant/env/shop/api-web.env");
    const plan = buildDeployPlan(cfg({ group: "shop" }), "abc1234");
    expect(plan.lockStep.cmds[0]).toContain("mkdir ~/.bundant/locks/shop/api.lock");
    expect(plan.unlockStep.cmds[0]).toBe("rm -rf ~/.bundant/locks/shop/api.lock");
  });

  test("ungrouped env path and lock key are unchanged", () => {
    expect(envRemotePath(cfg())).toBe("~/.bundant/env/api-web.env");
    expect(buildDeployPlan(cfg(), "abc1234").lockStep.cmds[0]).toContain("~/.bundant/locks/api.lock");
  });
});

describe("docker label builders", () => {
  test("labelArgs renders --label per entry; labelFilters renders exact filters", () => {
    expect(docker.labelArgs({ a: "1", b: "2" })).toEqual(["--label a=1", "--label b=2"]);
    expect(docker.labelArgs(undefined)).toEqual([]);
    expect(docker.labelFilters({ "bundant.service": "api", "bundant.group": "shop" })).toBe(
      ' --filter "label=bundant.service=api" --filter "label=bundant.group=shop"',
    );
    expect(docker.labelFilters(undefined)).toBe("");
  });

  test("listRunning switches from name prefix to exact label filters", () => {
    expect(docker.listRunning(rt, "api", "web")).toContain('--filter "name=api-web-"');
    const byLabel = docker.listRunning(rt, "api", "web", { "bundant.service": "api" });
    expect(byLabel).toContain('--filter "label=bundant.service=api"');
    expect(byLabel).not.toContain("name=api-web-");
    expect(docker.listForStatus(rt, "api", "web", { "bundant.group": "shop" })).toContain(
      '--filter "label=bundant.group=shop"',
    );
  });
});

describe("uninstall sweep selection", () => {
  test("buildSweepSteps selects containers by exact labels and removes the group env file", () => {
    const steps = buildSweepSteps(
      cfg({ group: "shop" }),
      { "bundant.service": "api", "bundant.group": "shop" },
      { yes: true, images: false, dryRun: true },
    );
    const containers = steps.find((s) => s.phase === "containers")!.cmds[0]!;
    expect(containers).toContain('--filter "label=bundant.service=api"');
    expect(containers).toContain('--filter "label=bundant.group=shop"');
    expect(steps.find((s) => s.phase === "env-remove")!.cmds[0]).toBe(
      "rm -f ~/.bundant/env/shop/api-web.env",
    );
  });

  test("selectSweepVictims keeps every listed name", () => {
    expect(selectSweepVictims("api-web-ab12\napi-web-cd34\n")).toEqual([
      "api-web-ab12",
      "api-web-cd34",
    ]);
    expect(selectSweepVictims("")).toEqual([]);
  });
});
