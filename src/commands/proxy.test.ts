import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "../exec/local.ts";
import { runtimeFor, type RuntimeKind } from "../runtime.ts";
import { ensure, PROXY_IMAGE } from "./proxy.ts";

const FAKE = "#!/bin/sh\necho \"$*\" >> \"$STATE_DIR/calls.log\"\ncase \"$1\" in\n  inspect)\n    st=$(cat \"$STATE_DIR/proxy-state\" 2>/dev/null || echo absent)\n    if [ \"$st\" = \"running\" ]; then echo true; exit 0; fi\n    if [ \"$st\" = \"stopped\" ]; then echo false; exit 0; fi\n    echo \"Error: no container with name or ID kamal-proxy found: no such container\" >&2\n    exit 1 ;;\n  start)\n    st=$(cat \"$STATE_DIR/proxy-state\" 2>/dev/null || echo absent)\n    if [ \"$st\" = \"absent\" ]; then\n      echo \"Error: no container with name or ID kamal-proxy found: no such container\" >&2\n      exit 1\n    fi\n    echo running > \"$STATE_DIR/proxy-state\"\n    exit 0 ;;\n  run)\n    echo running > \"$STATE_DIR/proxy-state\"\n    exit 0 ;;\nesac\nexit 0\n";

const exec = new LocalExecutor();

function makeFake(state: string): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "bundant-proxy-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["podman", "docker"]) {
    writeFileSync(join(bin, name), FAKE, { mode: 0o755 });
  }
  if (state !== "absent") writeFileSync(join(dir, "proxy-state"), state);
  return { dir, bin };
}

function envPrefix(dir: string, bin: string): string {
  return 'export STATE_DIR="' + dir + '"; export PATH="' + bin + ':$PATH"; ';
}

function calls(dir: string): string {
  const p = join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

async function runEnsure(dir: string, bin: string, kind: RuntimeKind, image?: string) {
  const cmd = image ? ensure(runtimeFor(kind), image) : ensure(runtimeFor(kind));
  const r = await exec.run(envPrefix(dir, bin) + cmd);
  return { r, log: calls(dir) };
}

describe("proxy ensure (three-state, behavioral)", () => {
  test("running proxy: inspect only, no start, no run", async () => {
    const { dir, bin } = makeFake("running");
    const { r, log } = await runEnsure(dir, bin, "podman");
    expect(r.code).toBe(0);
    expect(log).toContain("inspect");
    expect(log).not.toContain("start kamal-proxy");
    expect(log).not.toContain("run -d --name kamal-proxy");
  });

  test("stopped proxy: inspect then start, no run", async () => {
    const { dir, bin } = makeFake("stopped");
    const { r, log } = await runEnsure(dir, bin, "podman");
    expect(r.code).toBe(0);
    expect(log).toContain("start kamal-proxy");
    expect(log).not.toContain("run -d --name kamal-proxy");
    expect(readFileSync(join(dir, "proxy-state"), "utf8").trim()).toBe("running");
  });

  test("absent proxy on podman: start fails, run creates it with the port sysctl", async () => {
    const { dir, bin } = makeFake("absent");
    const { r, log } = await runEnsure(dir, bin, "podman");
    expect(r.code).toBe(0);
    expect(log).toContain("start kamal-proxy");
    expect(log).toContain(
      "run -d --name kamal-proxy --restart unless-stopped --network bundant -p 80:80 -p 443:443 " +
        "--sysctl net.ipv4.ip_unprivileged_port_start=0 " + PROXY_IMAGE,
    );
    expect(readFileSync(join(dir, "proxy-state"), "utf8").trim()).toBe("running");
  });

  test("absent proxy on docker: run has no sysctl flag", async () => {
    const { dir, bin } = makeFake("absent");
    const { log } = await runEnsure(dir, bin, "docker");
    expect(log).toContain(
      "run -d --name kamal-proxy --restart unless-stopped --network bundant -p 80:80 -p 443:443 " +
        PROXY_IMAGE,
    );
    expect(log).not.toContain("--sysctl");
  });

  test("proxy.image override appears in the run command", async () => {
    const { dir, bin } = makeFake("absent");
    const custom = "docker.io/basecamp/kamal-proxy:offline-2026-10";
    const { log } = await runEnsure(dir, bin, "podman", custom);
    expect(log).toContain(custom);
  });
});
