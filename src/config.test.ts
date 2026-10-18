import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const tmp = mkdtempSync(join(tmpdir(), "bundant-cfg-"));
afterAll(() => {
  delete process.env.BUNDANT_HOSTS;
});

function writeYml(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
}

const minimal = [
  "service: hello",
  "image: traefik/whoami:v1.10",
  "hosts:",
  "  - box.tail1234.ts.net",
  "proxy:",
  "  host: hello.bundant.test",
].join("\n");

describe("loadConfig", () => {
  test("fills defaults for role/proxy/healthcheck/env", () => {
    const { config } = loadConfig(writeYml("minimal.yml", minimal));
    expect(config.role).toBe("web");
    expect(config.proxy.enabled).toBe(true);
    expect(config.proxy.port).toBe(80);
    expect(config.proxy.tls).toBe(false);
    expect(config.healthcheck.path).toBe("/");
    expect(config.healthcheck.timeout).toBe(30);
    expect(config.healthcheck.port).toBe(80);
    expect(config.env.vars).toEqual({});
  });

  test("BUNDANT_HOSTS overrides the hosts list", () => {
    process.env.BUNDANT_HOSTS = "a.ts.net, b.ts.net";
    const { config } = loadConfig(writeYml("hosts.yml", minimal));
    expect(config.hosts).toEqual(["a.ts.net", "b.ts.net"]);
    delete process.env.BUNDANT_HOSTS;
  });

  test("merges env file and vars (vars win) and reports content", () => {
    writeFileSync(join(tmp, "hello.env"), "FROM_FILE=1\nSHARED=file\n");
    const { envContent, envCount } = loadConfig(
      writeYml(
        "env.yml",
        [minimal, "env:", "  file: ./hello.env", "  vars:", "    SHARED: vars"].join("\n"),
      ),
    );
    expect(envCount).toBe(2);
    expect(envContent).toContain("SHARED=vars");
    expect(envContent).not.toContain("SHARED=file");
  });

  test("rejects an invalid service name", () => {
    const bad = minimal.replace("service: hello", "service: Hello!");
    expect(() => loadConfig(writeYml("badsvc.yml", bad))).toThrow();
  });

  test("rejects proxy enabled without a host", () => {
    const noHost = [
      "service: hello",
      "image: traefik/whoami:v1.10",
      "hosts:",
      "  - box.tail1234.ts.net",
      "proxy:",
      "  enabled: true",
    ].join("\n");
    expect(() => loadConfig(writeYml("nohost.yml", noHost))).toThrow(/proxy\.host/);
  });

  test("healthcheck.port defaults to proxy.port when set", () => {
    const { config } = loadConfig(
      writeYml("ports.yml", [minimal, "  port: 8080"].join("\n")),
    );
    expect(config.healthcheck.port).toBe(8080);
  });

  test("runtime defaults to docker, accepts podman, rejects anything else", () => {
    expect(loadConfig(writeYml("rt1.yml", minimal)).config.runtime).toBe("docker");
    const podman = loadConfig(writeYml("rt2.yml", [minimal, "runtime: podman"].join("\n")));
    expect(podman.config.runtime).toBe("podman");
    expect(() =>
      loadConfig(writeYml("rt3.yml", [minimal, "runtime: nerdctl"].join("\n"))),
    ).toThrow(/runtime/);
  });

  test("proxy.image defaults to the Docker Hub proxy and accepts an offline tag", () => {
    const def = loadConfig(writeYml("pi1.yml", minimal));
    expect(def.config.proxy.image).toBe("docker.io/basecamp/kamal-proxy:latest");
    const offline = loadConfig(
      writeYml(
        "pi2.yml",
        [minimal, "  image: docker.io/basecamp/kamal-proxy:offline-2026-10"].join("\n"),
      ),
    );
    expect(offline.config.proxy.image).toBe("docker.io/basecamp/kamal-proxy:offline-2026-10");
  });

  test("missing env file is a clear error", () => {
    expect(() =>
      loadConfig(
        writeYml("noenv.yml", [minimal, "env:", "  file: ./does-not-exist.env"].join("\n")),
      ),
    ).toThrow(/does-not-exist\.env/);
  });
});
