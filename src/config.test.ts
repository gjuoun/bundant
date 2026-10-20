import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadGroup } from "./config.ts";

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
  "version: 2",
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
    expect(config.replicas).toBe(1);
  });

  test("replicas defaults to 1 and accepts N with the proxy enabled", () => {
    const { config } = loadConfig(writeYml("rep1.yml", [minimal, "replicas: 3"].join("\n")));
    expect(config.replicas).toBe(3);
  });

  test("replicas > 1 without a proxy is a configuration error", () => {
    const noProxy = [
      "version: 2",
      "service: hello",
      "image: traefik/whoami:v1.10",
      "hosts:",
      "  - box.tail1234.ts.net",
      "replicas: 2",
      "proxy:",
      "  enabled: false",
    ].join("\n");
    expect(() => loadConfig(writeYml("rep2.yml", noProxy))).toThrow(/replicas > 1 requires proxy\.enabled/);
  });

  test("replicas is rejected on an accessory (stateful members are one of one)", () => {
    const acc = [
      "version: 2",
      "service: db",
      "image: postgres:16",
      "kind: accessory",
      "replicas: 2",
      "hosts:",
      "  - box.tail1234.ts.net",
      "proxy:",
      "  enabled: false",
    ].join("\n");
    expect(() => loadConfig(writeYml("rep3.yml", acc))).toThrow(/not allowed on kind: accessory/);
  });

  test("replicas must be an integer >= 1", () => {
    for (const bad of ["0", "-1", "1.5"]) {
      expect(() =>
        loadConfig(writeYml("repbad-" + bad + ".yml", [minimal, "replicas: " + bad].join("\n"))),
      ).toThrow(/replicas/);
    }
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

  test("service and role accept kebab, camel and snake identifiers", () => {
    const hyphenService = minimal.replace("service: hello", "service: hello-world");
    expect(loadConfig(writeYml("svc-hyphen.yml", hyphenService)).config.service).toBe("hello-world");
    for (const role of ["web-1", "Web", "web_api"]) {
      const path = writeYml("role-" + role.replace(/\W/g, "_") + ".yml", [minimal, "role: " + role].join("\n"));
      expect(loadConfig(path).config.role).toBe(role);
    }
  });

  test("a dot in an identifier is rejected with the exact rule", () => {
    const path = writeYml("role-dot.yml", [minimal, "role: web.api"].join("\n"));
    expect(() => loadConfig(path)).toThrow(/role "web\.api" must match/);
    expect(() => loadConfig(path)).toThrow(/no '\.'/);
  });

  test("rejects proxy enabled without a host", () => {
    const noHost = [
      "version: 2",
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

describe("collision-proof group naming", () => {
  function groupFixture(group: string, member: string): string {
    const dir = mkdtempSync(join(tmp, "grp-"));
    writeFileSync(
      join(dir, "deploy.yml"),
      ["version: 2", "service: " + member, "image: x:1", "hosts: [box.test]", "proxy: {enabled: false}"].join("\n"),
    );
    const manifest = join(dir, "group.yml");
    writeFileSync(
      manifest,
      ["version: 2", "group: " + group, "services:", "  - name: " + member, "    file: ./deploy.yml"].join("\n"),
    );
    return manifest;
  }

  test("a hyphenated group and service are unambiguous in dotted names", () => {
    const loaded = loadGroup(groupFixture("a-b", "c-d"));
    expect(loaded.group).toBe("a-b");
    expect(loaded.members[0]!.name).toBe("c-d");
    expect(loaded.members[0]!.loaded.config.service).toBe("c-d");
  });

  test("a dot in a group is rejected", () => {
    expect(() => loadGroup(groupFixture("a.b", "c"))).toThrow(/group "a\.b" must match/);
  });
});

describe("shared ssh file", () => {
  test("ssh: <path> loads defaults and inherits the host pool", () => {
    writeFileSync(
      join(tmp, "prod-ssh.yaml"),
      ["user: deploy", "port: 2222", "identity: ~/.ssh/prod", "hosts:", "  - a.example.com", "  - b.example.com"].join("\n"),
    );
    const cfg = loadConfig(
      writeYml(
        "shared1.yml",
        ["version: 2", "service: api", "image: x:1", "ssh: ./prod-ssh.yaml", "proxy: {enabled: false}"].join("\n"),
      ),
    );
    expect(cfg.config.hosts).toEqual(["a.example.com", "b.example.com"]);
    expect(cfg.config.ssh?.user).toBe("deploy");
    expect(cfg.config.ssh?.port).toBe(2222);
    expect(cfg.config.ssh?.identity).toBe("~/.ssh/prod");
  });

  test("explicit hosts in deploy.yml win over the ssh file pool", () => {
    writeFileSync(join(tmp, "pool-only.yaml"), ["user: deploy", "hosts: [ignored.example.com]"].join("\n"));
    const cfg = loadConfig(
      writeYml(
        "shared2.yml",
        [
          "version: 2",
          "service: api",
          "image: x:1",
          "ssh: ./pool-only.yaml",
          "hosts: [chosen.example.com]",
          "proxy: {enabled: false}",
        ].join("\n"),
      ),
    );
    expect(cfg.config.hosts).toEqual(["chosen.example.com"]);
    expect(cfg.config.ssh?.user).toBe("deploy");
  });

  test("a missing ssh file names the resolved path", () => {
    expect(() =>
      loadConfig(writeYml("shared3.yml", ["version: 2", "service: api", "image: x:1", "ssh: ./nope.yaml"].join("\n"))),
    ).toThrow(/nope\.yaml/);
  });

  test("a malformed ssh file reports the field path", () => {
    writeFileSync(join(tmp, "bad-ssh.yaml"), ["port: 99999"].join("\n"));
    expect(() =>
      loadConfig(writeYml("shared4.yml", ["version: 2", "service: api", "image: x:1", "ssh: ./bad-ssh.yaml"].join("\n"))),
    ).toThrow(/ssh file.*port/);
  });

  test("no hosts anywhere is a clear error", () => {
    writeFileSync(join(tmp, "hostless.yaml"), ["user: deploy"].join("\n"));
    expect(() =>
      loadConfig(writeYml("shared5.yml", ["version: 2", "service: api", "image: x:1", "ssh: ./hostless.yaml"].join("\n"))),
    ).toThrow(/hosts is required/);
  });
});
