import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundantConfig } from "./config.ts";
import {
  buildDeleteSteps,
  deleteGuardError,
  remove,
  selectDeleteVictims,
  selectVictims,
} from "./delete.ts";
import { LocalExecutor } from "./exec/local.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    version: 2,
    service: "hello",
    image: "traefik/whoami:v1.10",
    role: "web",
    replicas: 1,
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

const opts = { yes: false, images: false, dryRun: true };

function step(config: BundantConfig, o = opts, phase = "containers") {
  const s = buildDeleteSteps(config, o).find((x) => x.phase === phase);
  if (!s) throw new Error("missing phase " + phase);
  return s;
}

describe("selectDeleteVictims", () => {
  const row = (name: string, kind: string, service = "hello") => ({
    id: name,
    name,
    image: "x:1",
    state: "running",
    status: "Up",
    labels: { "bundant.kind": kind, "bundant.service": service, "bundant.group": "default" },
    created: 0,
    ports: "",
  });

  test("never selects an accessory, even with the service prefix", () => {
    const rows = [row("default.hello.web.r1", "service"), row("default.hello.web.db", "accessory"), row("default.other.web.r1", "service")];
    expect(selectDeleteVictims(rows, cfg(), true).map((r) => r.name)).toEqual(["default.hello.web.r1"]);
  });

  test("group sweep selects by label but still skips accessories", () => {
    const rows = [row("default.hello.web.r1", "service"), row("default.hello.db", "accessory")];
    expect(selectDeleteVictims(rows, cfg(), false).map((r) => r.name)).toEqual(["default.hello.web.r1"]);
  });
});

describe("buildDeleteSteps", () => {
  test("proxy on: tolerant route removal comes first", () => {
    const steps = buildDeleteSteps(cfg(), opts);
    expect(steps[0].phase).toBe("proxy-remove");
    const cmd = steps[0].cmds[0];
    expect(cmd).toContain("docker inspect -f \"{{.State.Running}}\" kamal-proxy");
    expect(cmd).toContain("grep -q true");
    expect(cmd).toContain("kamal-proxy remove default.hello.web");
    expect(cmd).toContain("|| true");
  });

  test("proxy off: no proxy step at all", () => {
    const steps = buildDeleteSteps(
      cfg({
        proxy: {
          enabled: false,
          port: 80,
          tls: false,
          image: "docker.io/basecamp/kamal-proxy:latest",
        },
      }),
      opts,
    );
    expect(steps.map((s) => s.phase)).toEqual(["containers", "env-remove"]);
  });

  test("containers step stops and removes the service-role prefix", () => {
    const cmd = step(cfg(), opts).cmds[0];
    expect(cmd).toContain('docker ps -a --filter "name=default.hello.web."');
    expect(cmd).toContain('grep "^default.hello.web."');
    expect(cmd).toContain('docker stop -t 10 "$c"');
    expect(cmd).toContain('docker rm -f "$c"');
  });

  test("env file removal is always present and tolerant", () => {
    expect(step(cfg(), opts, "env-remove").cmds[0]).toBe(
      "rm -f ~/.bundant/env/hello-web.env",
    );
  });

  test("images left alone by default, removed with --images", () => {
    expect(step(cfg(), opts).cmds.join(" ")).not.toContain("rmi");
    const withImages = step(cfg(), { ...opts, images: true }).cmds[0];
    expect(withImages).toContain("{{.Config.Image}}");
    expect(withImages).toContain('docker rmi "$img"');
    // image refs must be collected before the containers are removed
    expect(withImages.indexOf("{{.Config.Image}}")).toBeLessThan(
      withImages.indexOf('docker rm -f "$c"'),
    );
  });

  test("podman runtime uses podman everywhere", () => {
    const config = cfg({ runtime: "podman" });
    const json = JSON.stringify(buildDeleteSteps(config, { ...opts, images: true }));
    expect(json).not.toMatch(/(^|[\s|;(])docker\s/);
    expect(json).toContain("podman exec kamal-proxy");
    expect(json).toContain("podman ps -a");
  });
});

describe("deleteGuardError", () => {
  test("without --yes it refuses and never touches a host", () => {
    const err = deleteGuardError({ yes: false, images: false, dryRun: false });
    expect(err).toContain("--yes");
    expect(err).toContain("destructive");
  });

  test("--dry-run and --yes both pass the guard", () => {
    expect(deleteGuardError({ yes: false, images: false, dryRun: true })).toBeNull();
    expect(deleteGuardError({ yes: true, images: false, dryRun: false })).toBeNull();
  });
});

describe("selectVictims", () => {
  test("keeps only this service-role's containers", () => {
    const listing = [
      "hello-web-abc1234",
      "hello-web-def5678",
      "other-web-abc1234",
      "helloweb-x",
    ].join("\n");
    expect(selectVictims(listing, "hello", "web")).toEqual(["hello-web-abc1234", "hello-web-def5678"]);
    expect(selectVictims("", "hello", "web")).toEqual([]);
  });
});

describe("remove() with a runtime that has nothing on the host", () => {
  test("dry-run prints the plan and returns 0", async () => {
    const loaded = { config: cfg(), envContent: null, envCount: 0, path: "/tmp/x/deploy.yml" };
    expect(await remove(loaded, { yes: false, images: false, dryRun: true })).toBe(0);
  });

  test("without --yes it returns 2 (no ssh attempted)", async () => {
    const loaded = { config: cfg(), envContent: null, envCount: 0, path: "/tmp/x/deploy.yml" };
    expect(await remove(loaded, { yes: false, images: false, dryRun: false })).toBe(2);
  });
});

describe("tolerant-missing behaviour (fake runtime that fails everything)", () => {
  test("every delete command still exits 0 when the proxy and containers are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-del-"));
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // A runtime with nothing installed: every subcommand fails, ps prints nothing.
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const exec = new LocalExecutor();
    for (const s of buildDeleteSteps(cfg(), { yes: true, images: true, dryRun: false })) {
      for (const cmd of s.cmds) {
        const r = await exec.run('export PATH="' + bin + ':$PATH"; ' + cmd);
        expect({ phase: s.phase, code: r.code }).toEqual({ phase: s.phase, code: 0 });
      }
    }
  });
});
