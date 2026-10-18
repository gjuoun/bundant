import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "./config.ts";
import { buildDeployPlan, renderPlan } from "./planner.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "hello",
    image: "traefik/whoami:v1.10",
    role: "web",
    hosts: ["box.tail1234.ts.net"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: {
      enabled: true,
      host: "hello.bundant.test",
      port: 80,
      tls: false,
      image: "docker.io/basecamp/kamal-proxy:latest",
    },
    ...over,
  };
}

const REV = "abc1234";

function step(plan: ReturnType<typeof buildDeployPlan>, phase: string) {
  const s = plan.hostSteps.find((x) => x.phase === phase);
  if (!s) throw new Error("missing phase " + phase);
  return s;
}

describe("buildDeployPlan", () => {
  test("hello fixture: exact pull/run/proxy-swap/stop-old commands", () => {
    const plan = buildDeployPlan(cfg(), REV);
    expect(step(plan, "pull").cmds[0]).toBe("docker pull traefik/whoami:v1.10");
    expect(step(plan, "run").cmds[0]).toBe("docker rm -f hello-web-abc1234 2>/dev/null || true");
    expect(step(plan, "run").cmds[1]).toBe(
      "docker run -d --name hello-web-abc1234 --network bundant --restart unless-stopped traefik/whoami:v1.10",
    );
    expect(step(plan, "health").cmds[0]).toBe(
      "docker run --rm --network bundant curlimages/curl:8.11.1 -sS -o /dev/null -w '%{http_code}' --max-time 3 http://hello-web-abc1234:80/",
    );
    expect(step(plan, "proxy-swap").cmds[0]).toBe(
      "docker exec kamal-proxy kamal-proxy deploy hello-web --target hello-web-abc1234:80 --host hello.bundant.test --health-check-path /",
    );
    expect(step(plan, "stop-old").cmds[0]).toContain('grep -v "^hello-web-abc1234$"');
    expect(plan.meta.containerName).toBe("hello-web-abc1234");
    expect(plan.meta.serviceId).toBe("hello-web");
  });

  test("env vars present: run gets --env-file, values never appear anywhere", () => {
    const plan = buildDeployPlan(cfg({ env: { vars: { SECRET_TOKEN: "s3cr3t" } } }), REV);
    expect(step(plan, "run").cmds[1]).toContain("--env-file ~/.bundant/env/hello-web.env");
    const all = JSON.stringify([plan.hostSteps, plan.lockStep, plan.unlockStep]);
    expect(all).not.toContain("s3cr3t");
    expect(step(plan, "run").desc).toContain("env: redacted");
  });

  test("proxy disabled: no proxy-ensure/proxy-swap steps", () => {
    const plan = buildDeployPlan(
      cfg({
        proxy: { enabled: false, port: 80, tls: false, image: "docker.io/basecamp/kamal-proxy:latest" },
        healthcheck: { path: "/definitely-not-here", port: 80, timeout: 5 },
      }),
      REV,
    );
    expect(plan.hostSteps.filter((s) => s.phase.startsWith("proxy"))).toHaveLength(0);
    expect(step(plan, "health").cmds[0]).toContain("http://hello-web-abc1234:80/definitely-not-here");
    expect(step(plan, "health").desc).toContain("timeout 5s");
  });

  test("healthcheck on a different port passes --health-check-port", () => {
    const plan = buildDeployPlan(
      cfg({ healthcheck: { path: "/", port: 8081, timeout: 30 } }),
      REV,
    );
    expect(step(plan, "proxy-swap").cmds[0]).toContain("--health-check-path /");
    expect(step(plan, "proxy-swap").cmds[0]).toEndWith("--health-check-port 8081");
  });

  test("tls config passes --tls", () => {
    const plan = buildDeployPlan(cfg({
        proxy: { enabled: true, host: "h.test", port: 80, tls: true, image: "docker.io/basecamp/kamal-proxy:latest" },
      }), REV);
    expect(step(plan, "proxy-swap").cmds[0]).toContain("--tls");
  });

  test("lock and unlock wrap the plan with the service name", () => {
    const plan = buildDeployPlan(cfg(), REV);
    expect(plan.lockStep.cmds[0]).toContain("mkdir ~/.bundant/locks/hello.lock");
    expect(plan.unlockStep.cmds[0]).toBe("rm -rf ~/.bundant/locks/hello.lock");
  });

  test("renderPlan prints the full command sequence per host", () => {
    const plan = buildDeployPlan(cfg({ hosts: ["a.ts.net", "b.ts.net"] }), REV);
    const text = renderPlan(plan);
    expect(text).toContain("hosts: a.ts.net, b.ts.net");
    expect(text).toContain("host a.ts.net");
    expect(text).toContain("host b.ts.net");
    expect(text).toContain("docker pull traefik/whoami:v1.10");
    expect(text).toContain("kamal-proxy deploy hello-web --target hello-web-abc1234:80");
    expect(text.split("docker pull traefik/whoami:v1.10").length - 1).toBe(2);
  });

  test("local-image replaces the pull step with a save|gzip|ssh|load pipeline", () => {
    const plan = buildDeployPlan(cfg(), REV, { localImage: "hello:local" });
    expect(plan.hostSteps.find((s) => s.phase === "pull")).toBeUndefined();
    const push = plan.hostSteps.find((s) => s.phase === "push-image");
    expect(push).toBeDefined();
    expect(push!.cmds[0]).toContain("docker save hello:local | gzip -1 | ssh");
    expect(push!.cmds[0]).toContain('"gunzip | docker load"');
    expect(push!.cmds[0]).toContain("{HOST}");
    expect(step(plan, "run").cmds[1]).toEndWith("hello:local");
    expect(step(plan, "run").cmds[1]).toContain("--restart unless-stopped");
    expect(plan.meta.image).toBe("hello:local");
    expect(plan.meta.localImage).toBe("hello:local");
  });

  test("renderPlan substitutes {HOST} and shows the save/load step per host", () => {
    const plan = buildDeployPlan(cfg({ hosts: ["a.ts.net", "b.ts.net"] }), REV, {
      localImage: "hello:local",
    });
    const text = renderPlan(plan);
    expect(text).not.toContain("{HOST}");
    expect(text.split("docker save hello:local | gzip -1 | ssh").length - 1).toBe(2);
    expect(text).toContain('a.ts.net "gunzip | docker load"');
    expect(text).not.toContain("docker pull");
    expect(text).toContain("image=hello:local");
  });

  test("podman plan: every step uses podman and adds runtime-check + port-guard", () => {
    const plan = buildDeployPlan(cfg({ runtime: "podman" }), REV);
    const phases = plan.hostSteps.map((s) => s.phase);
    expect(phases).toContain("runtime-check");
    expect(phases).toContain("port-guard");
    expect(plan.meta.runtime).toBe("podman");
    const json = JSON.stringify([plan.hostSteps, plan.lockStep, plan.unlockStep]);
    // No docker BINARY invocation anywhere (the proxy image legitimately lives at docker.io/*).
    expect(json).not.toMatch(/(^|[\s|;(])docker\s/);
    for (const phase of [
      "pull",
      "network",
      "run",
      "health",
      "proxy-ensure",
      "proxy-swap",
      "stop-old",
    ]) {
      expect(step(plan, phase).cmds.join(" ")).toContain("podman");
    }
    expect(step(plan, "runtime-check").cmds[0]).toContain("systemctl --user is-enabled podman-restart.service");
    expect(step(plan, "runtime-check").cmds[1]).toContain("loginctl show-user");
    expect(step(plan, "port-guard").cmds[0]).toContain("net.ipv4.ip_unprivileged_port_start");
    expect(step(plan, "pull").cmds[0]).toBe("podman pull traefik/whoami:v1.10");
    expect(step(plan, "network").cmds[0]).toContain("podman network create bundant");
    expect(step(plan, "run").cmds[0]).toBe("podman rm -f hello-web-abc1234 2>/dev/null || true");
    expect(step(plan, "run").cmds[1]).toContain("podman run -d --name hello-web-abc1234");
    expect(step(plan, "health").cmds[0]).toContain("podman run --rm --network bundant curlimages/curl");
    expect(step(plan, "proxy-ensure").cmds[0]).toContain("podman inspect");
    expect(step(plan, "proxy-swap").cmds[0]).toContain("podman exec kamal-proxy kamal-proxy deploy hello-web");
    expect(step(plan, "stop-old").cmds[0]).toContain("podman ps -a --filter");
    expect(renderPlan(plan)).toContain("runtime=podman");
  });

  test("docker plan: docker-prefixed, no podman runtime steps", () => {
    const plan = buildDeployPlan(cfg(), REV);
    const phases = plan.hostSteps.map((s) => s.phase);
    expect(phases).not.toContain("runtime-check");
    expect(phases).not.toContain("port-guard");
    const json = JSON.stringify(plan.hostSteps);
    expect(json).toMatch(/\bdocker\b/);
    expect(json).not.toMatch(/\bpodman\b/);
  });

  test("podman local-image transfer uses an explicit docker-archive format", () => {
    const plan = buildDeployPlan(cfg({ runtime: "podman" }), REV, { localImage: "hello:local" });
    const push = plan.hostSteps.find((s) => s.phase === "push-image")!;
    expect(push.cmds[0]).toContain("podman save --format docker-archive hello:local | gzip -1 | ssh");
    expect(push.cmds[0]).toContain('"gunzip | podman load"');
    expect(step(plan, "run").cmds[1]).toEndWith("hello:local");
  });

  test("podman proxy-ensure carries the sysctl that lets the non-root proxy bind :80", () => {
    const plan = buildDeployPlan(cfg({ runtime: "podman" }), REV);
    const ensure = step(plan, "proxy-ensure").cmds[0];
    expect(ensure).toContain("--sysctl net.ipv4.ip_unprivileged_port_start=0");
    expect(ensure).toContain("docker.io/basecamp/kamal-proxy:latest");
    expect(ensure).toContain("podman run -d --name kamal-proxy");
  });

  test("docker proxy-ensure has no sysctl flag", () => {
    const plan = buildDeployPlan(cfg(), REV);
    expect(step(plan, "proxy-ensure").cmds[0]).not.toContain("--sysctl");
  });

  test("proxy.image config reaches the ensure command (offline tag)", () => {
    const plan = buildDeployPlan(
      cfg({
        runtime: "podman",
        proxy: {
          enabled: true,
          host: "hello.bundant.test",
          port: 80,
          tls: false,
          image: "docker.io/basecamp/kamal-proxy:offline-2026-10",
        },
      }),
      REV,
    );
    const ensure = step(plan, "proxy-ensure").cmds[0];
    expect(ensure).toContain("docker.io/basecamp/kamal-proxy:offline-2026-10");
    expect(ensure).not.toContain(":latest");
  });

  test("per-host and top-level ssh users reach the plan and the transfer pipeline", () => {
    const plan = buildDeployPlan(cfg({ user: "root", hosts: ["admin@a.ts.net", "b.ts.net"] }), REV, {
      localImage: "hello:local",
    });
    expect(plan.meta.hosts).toEqual(["admin@a.ts.net", "root@b.ts.net"]);
    expect(plan.lockStep.desc).toContain("on admin@a.ts.net");
    const text = renderPlan(plan);
    expect(text).toContain("hosts: admin@a.ts.net, root@b.ts.net");
    expect(text).toContain("host root@b.ts.net:");
    expect(text).toContain('root@b.ts.net "gunzip | docker load"');
  });

  test("registry path unchanged when no local image is given", () => {
    const plan = buildDeployPlan(cfg(), REV);
    expect(step(plan, "pull").cmds[0]).toBe("docker pull traefik/whoami:v1.10");
    expect(plan.hostSteps.find((s) => s.phase === "push-image")).toBeUndefined();
    expect(plan.meta.localImage).toBeUndefined();
  });
});
