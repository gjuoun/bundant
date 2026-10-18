import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Monitor } from "./monitor.ts";
import { runtimeFor } from "./runtime.ts";
import type { ExecResult, Executor } from "./types.ts";
import { uiHandler } from "./ui.ts";

const PS =
  "kamal-proxy|docker.io/basecamp/kamal-proxy:latest|Up 11 hours|0.0.0.0:80->80/tcp|2026-10-18 11:08:37 +0000 UTC\n" +
  "hello-web-rev-aaa|docker.io/traefik/whoami:v1.10|Up 11 hours|80/tcp|2026-10-18 11:08:50 +0000 UTC\n";

class FakeExecutor implements Executor {
  readonly kind = "fake";
  constructor(private readonly handler: (cmd: string) => ExecResult) {}
  async run(cmd: string): Promise<ExecResult> {
    return this.handler(cmd);
  }
  async putFile(): Promise<void> {}
  async close(): Promise<void> {}
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

/** One host that answers every query the monitoring surface can emit. */
function fakeHost(): Executor {
  return new FakeExecutor((cmd) => {
    if (cmd.startsWith("podman ps -a --format")) {
      return cmd.includes("{{.Names}}|") ? ok(PS) : ok("kamal-proxy\nhello-web-rev-aaa\n");
    }
    if (cmd.startsWith("podman stats")) return ok("kamal-proxy|0.00%|2.6MB / 24GB|0.01%|7\n");
    if (cmd.startsWith("podman logs")) return ok("line one\nline two\n");
    if (cmd.startsWith("podman inspect -f")) return ok("true\n");
    if (cmd.startsWith("podman inspect")) {
      return ok("/kamal-proxy|running|0|2026-10-18T11:48:54Z|-|docker.io/basecamp/kamal-proxy:latest|unless-stopped|journald|0\n");
    }
    if (cmd.includes("kamal-proxy list")) return ok("service  host                  target\ndemo     demo.example.com      web-rev-aaa:80\n");
    if (cmd.includes("podman events")) return ok("1760000000|container|start|web-rev-aaa\n");
    return ok("");
  });
}

async function withUi(fn: (base: string) => Promise<void>): Promise<void> {
  const monitor = new Monitor([{ host: "docker01", exec: fakeHost() }], runtimeFor("podman"));
  const server: Server = createServer(uiHandler(monitor));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    await fn("http://127.0.0.1:" + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("bundant ui (behavioral)", () => {
  test("serves the page", async () => {
    await withUi(async (base) => {
      const r = await fetch(base + "/");
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("bundant monitor");
      expect(html).toContain("/api/snapshot");
    });
  });

  test("/api/snapshot: per-host container rows", async () => {
    await withUi(async (base) => {
      const body = (await (await fetch(base + "/api/snapshot")).json()) as {
        hosts: { host: string; ok: boolean; rows: { name: string }[] }[];
      };
      expect(body.hosts.length).toBe(1);
      expect(body.hosts[0]?.host).toBe("docker01");
      expect(body.hosts[0]?.rows.map((r) => r.name)).toEqual(["kamal-proxy", "hello-web-rev-aaa"]);
    });
  });

  test("/api/hosts: names per host, for the log picker", async () => {
    await withUi(async (base) => {
      const body = (await (await fetch(base + "/api/hosts")).json()) as {
        hosts: string[];
        containers: Record<string, string[]>;
      };
      expect(body.hosts).toEqual(["docker01"]);
      expect(body.containers["docker01"]).toContain("kamal-proxy");
    });
  });

  test("/api/logs: text on success, ok:false on a missing host", async () => {
    await withUi(async (base) => {
      const good = (await (await fetch(base + "/api/logs?host=docker01&container=kamal-proxy&tail=20")).json()) as {
        ok: boolean;
        text: string;
      };
      expect(good.ok).toBe(true);
      expect(good.text).toContain("line one");
      const bad = (await (await fetch(base + "/api/logs")).json()) as { ok: boolean; error: string };
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain("host is required");
    });
  });

  test("/api/stats, /api/proxy, /api/inspect and /api/events", async () => {
    await withUi(async (base) => {
      const stats = (await (await fetch(base + "/api/stats")).json()) as { hosts: { rows: unknown[] }[] };
      expect(stats.hosts[0]?.rows.length).toBe(1);

      const proxy = (await (await fetch(base + "/api/proxy")).json()) as { hosts: { ok: boolean; rows: string[] }[] };
      expect(proxy.hosts[0]?.ok).toBe(true);
      expect(proxy.hosts[0]?.rows.join(" ")).toContain("demo.example.com");

      const inspect = (await (await fetch(base + "/api/inspect?container=kamal-proxy")).json()) as {
        hosts: { rows: { logDriver: string }[] }[];
      };
      expect(inspect.hosts[0]?.rows[0]?.logDriver).toBe("journald");

      const events = (await (await fetch(base + "/api/events?host=docker01&since=2h")).json()) as {
        ok: boolean;
        lines: string[];
      };
      expect(events.ok).toBe(true);
      expect(events.lines.length).toBe(1);
    });
  });

  test("unknown route is a 404, not a silent 200", async () => {
    await withUi(async (base) => {
      const r = await fetch(base + "/api/nope");
      expect(r.status).toBe(404);
    });
  });
});
