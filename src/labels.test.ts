import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, type BundantConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { buildSweepSteps, buildDeleteSteps, selectSweepVictims } from "./delete.ts";
import { buildVolumeCreates } from "./accessory.ts";
import { volumeLabels } from "./planner.ts";
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

  test("a deploy with no group lands in the default namespace", () => {
    const plan = buildDeployPlan(cfg({ group: "default" }), "abc1234");
    const run = plan.hostSteps.find((s) => s.phase === "run")!.cmds[1]!;
    expect(run).toContain("--label bundant.service=api");
    expect(run).toContain("--label bundant.group=default");
    expect(plan.meta.group).toBe("default");
    expect(envRemotePath(cfg({ group: "default" }))).toBe("~/.bundant/env/default/api-web.env");
    expect(plan.lockStep.cmds[0]).toContain("~/.bundant/locks/default/api.lock");
  });

  test("loadConfig puts an ungrouped deploy.yml into the default group", () => {
    const loaded = loadConfig(join(import.meta.dir, "..", "examples/hello/deploy.yml"));
    expect(loaded.config.group).toBe("default");
  });

  test("grouped env path and lock key are namespaced", () => {
    expect(envRemotePath(cfg({ group: "shop" }))).toBe("~/.bundant/env/shop/api-web.env");
    const plan = buildDeployPlan(cfg({ group: "shop" }), "abc1234");
    expect(plan.lockStep.cmds[0]).toContain("mkdir ~/.bundant/locks/shop/api.lock");
    expect(plan.unlockStep.cmds[0]).toBe("rm -rf ~/.bundant/locks/shop/api.lock");
  });

  test("the default group namespaces the env path and lock key like any other", () => {
    expect(envRemotePath(cfg({ group: "default" }))).toBe("~/.bundant/env/default/api-web.env");
    expect(buildDeployPlan(cfg({ group: "default" }), "abc1234").lockStep.cmds[0]).toContain(
      "~/.bundant/locks/default/api.lock",
    );
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

describe("metadata that makes an accessory self-describing", () => {
  test("every container says what kind it is", () => {
    const service = buildDeployPlan(cfg({ group: "shop" }), "abc1234");
    const runService = service.hostSteps.find((s) => s.phase === "run")!.cmds[1]!;
    expect(runService).toContain("--label bundant.kind=service");

    const acc = buildDeployPlan(
      cfg({ group: "shop", kind: "accessory", volumes: ["pgdata:/var/lib/postgresql/data"], proxy: { enabled: false, port: 80, tls: false, image: "x" } }),
      "abc1234",
    );
    const runAcc = acc.hostSteps.find((s) => s.phase === "run")!.cmds[1]!;
    expect(runAcc).toContain("--label bundant.kind=accessory");
    expect(runAcc).toContain("--label bundant.volumes=pgdata");
  });

  test("declared volumes are created with ownership labels, not implicitly", () => {
    const acc = cfg({
      service: "db",
      group: "shop",
      kind: "accessory",
      volumes: ["pgdata:/var/lib/postgresql/data", "cache:/cache"],
      proxy: { enabled: false, port: 80, tls: false, image: "x" },
    });
    expect(volumeLabels(acc)).toEqual({
      "bundant.kind": "accessory",
      "bundant.owner": "shop/db",
      "bundant.managed": "true",
    });
    const cmds = buildVolumeCreates(acc, rt);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toBe(
      'docker volume create --label bundant.kind=accessory --label bundant.owner=shop/db --label bundant.managed=true pgdata 2>/dev/null || true',
    );
  });

  test("a sweep skips a container that labels itself an accessory", () => {
    const steps = buildSweepSteps(
      cfg({ group: "shop" }),
      { "bundant.service": "api", "bundant.group": "shop", "bundant.kind": "service" },
      { yes: true, images: false, dryRun: true },
    );
    const containers = steps.find((s) => s.phase === "containers")!.cmds[0]!;
    // positive filter: accessories never match a service sweep
    expect(containers).toContain('label=bundant.kind=service');
  });

  test("service delete refuses an accessory even if the name prefix matches", () => {
    const steps = buildDeleteSteps(cfg({ group: "shop" }), { yes: true, images: false, dryRun: true });
    const containers = steps.find((s) => s.phase === "containers")!.cmds[0]!;
    expect(containers).toContain('{{index .Config.Labels "bundant.kind"}}');
    expect(containers).toContain('"$k" = "accessory"');
    expect(containers).toContain("continue");
  });

  test("deploy stop-old skips accessories too", () => {
    const plan = buildDeployPlan(cfg({ group: "shop" }), "abc1234");
    const stop = plan.hostSteps.find((s) => s.phase === "stop-old")!.cmds[0]!;
    expect(stop).toContain('{{index .Config.Labels "bundant.kind"}}');
    expect(stop).toContain('"$k" = "accessory"');
  });
});
