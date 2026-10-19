import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "./config.ts";
import { runtimeFor } from "./runtime.ts";
import {
  ScaleError,
  buildScaleSteps,
  computeScalePlan,
  currentRevision,
  parseReplicaInventory,
} from "./scale-plan.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "echoes",
    image: "traefik/whoami:v1.10",
    role: "web",
    replicas: 1,
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: {
      enabled: true,
      host: "echoes.test",
      port: 80,
      tls: false,
      image: "docker.io/basecamp/kamal-proxy:latest",
    },
    ...over,
  };
}

describe("computeScalePlan", () => {
  test("up fills the smallest free indices and serves the union", () => {
    const plan = computeScalePlan([1, 2], 5);
    expect(plan.action).toBe("up");
    expect(plan.up).toEqual([3, 4, 5]);
    expect(plan.keep).toEqual([1, 2, 3, 4, 5]);
    expect(plan.remove).toEqual([]);
  });

  test("up from a gap fills the hole, not the tail", () => {
    expect(computeScalePlan([1, 3], 3).up).toEqual([2]);
  });

  test("down removes the largest indices", () => {
    const plan = computeScalePlan([1, 2, 3, 4, 5], 2);
    expect(plan.action).toBe("down");
    expect(plan.keep).toEqual([1, 2]);
    expect(plan.remove).toEqual([3, 4, 5]);
  });

  test("scaling to the current count is a no-op", () => {
    const plan = computeScalePlan([1, 2], 2);
    expect(plan.action).toBe("noop");
    expect(plan.up).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  test("single -> N uses the indexed names", () => {
    expect(computeScalePlan([1], 3).up).toEqual([2, 3]);
  });
});

describe("buildScaleSteps ordering", () => {
  test("up: run, gate, then one proxy swap with the full set", () => {
    const steps = buildScaleSteps(cfg(), "abc1234", computeScalePlan([1, 2], 3), {
      image: "traefik/whoami:v1.10",
    });
    expect(steps.map((s) => s.phase)).toEqual(["run", "health", "proxy-swap"]);
    expect(steps[0]!.cmds).toHaveLength(2);
    expect(steps[0]!.cmds[1]).toContain("--name echoes-web-abc1234-3");
    expect(steps[0]!.cmds[1]).toContain("--label bundant.replica=3");
    expect(steps[1]!.cmds).toHaveLength(1);
    const swap = steps[2]!.cmds[0]!;
    expect(swap.split("--target ").length - 1).toBe(3);
    expect(swap).toContain("--target echoes-web-abc1234-3:80");
  });

  test("down: the proxy drops the victims BEFORE any container is stopped", () => {
    const steps = buildScaleSteps(cfg(), "abc1234", computeScalePlan([1, 2, 3, 4, 5], 2), {
      image: "traefik/whoami:v1.10",
    });
    expect(steps.map((s) => s.phase)).toEqual(["proxy-swap", "stop-old"]);
    const swap = steps[0]!.cmds[0]!;
    expect(swap.split("--target ").length - 1).toBe(2);
    expect(swap).not.toContain("echoes-web-abc1234-3");
    // stop + rm per removed replica, after the swap
    expect(steps[1]!.cmds).toEqual([
      "docker stop -t 10 echoes-web-abc1234-3",
      "docker rm -f echoes-web-abc1234-3",
      "docker stop -t 10 echoes-web-abc1234-4",
      "docker rm -f echoes-web-abc1234-4",
      "docker stop -t 10 echoes-web-abc1234-5",
      "docker rm -f echoes-web-abc1234-5",
    ]);
  });

  test("a surviving legacy replica keeps its unsuffixed name", () => {
    const names = new Map([[1, "echoes-web-abc1234"]]);
    const steps = buildScaleSteps(cfg(), "abc1234", computeScalePlan([1], 2), {
      image: "traefik/whoami:v1.10",
      nameOf: (i) => names.get(i) ?? "echoes-web-abc1234-" + i,
    });
    expect(steps[0]!.cmds[1]).toContain("--name echoes-web-abc1234-2");
    const swap = steps[2]!.cmds[0]!;
    expect(swap).toContain("--target echoes-web-abc1234:80");
    expect(swap).toContain("--target echoes-web-abc1234-2:80");
  });

  test("podman renders through podman", () => {
    const steps = buildScaleSteps(
      cfg({ runtime: "podman" }),
      "abc1234",
      computeScalePlan([1], 2),
      { image: "traefik/whoami:v1.10" },
    );
    expect(steps[2]!.cmds[0]).toContain("podman exec kamal-proxy");
  });
});

describe("parseReplicaInventory", () => {
  test("reads labels when present", () => {
    const lines = parseReplicaInventory(
      [
        "echoes-web-abc1234-1|abc1234|1|traefik/whoami:v1.10",
        "echoes-web-abc1234-2|abc1234|2|traefik/whoami:v1.10",
      ].join("\n"),
      "echoes",
      "web",
    );
    expect(lines.map((l) => l.index)).toEqual([1, 2]);
    expect(lines[0]!.revision).toBe("abc1234");
  });

  test("falls back to the name for legacy containers without labels", () => {
    const lines = parseReplicaInventory("echoes-web-abc1234|||traefik/whoami:v1.10", "echoes", "web");
    expect(lines[0]!.revision).toBe("abc1234");
    expect(lines[0]!.index).toBe(1);
  });

  test("currentRevision picks the majority revision", () => {
    const lines = parseReplicaInventory(
      ["a|rev2|1|x", "b|rev2|2|x", "c|rev1|1|x"].join("\n"),
      "svc",
      "web",
    );
    expect(currentRevision(lines)).toBe("rev2");
  });
});

describe("ScaleError surface", () => {
  test("ScaleError is an Error subclass", () => {
    const e = new ScaleError("nope");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("nope");
  });
});
