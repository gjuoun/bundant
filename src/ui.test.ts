import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Monitor, type MonitorRuntime } from "./monitor.ts";
import type { ContainerInfo, ContainerSummary, RuntimeEvent, StatsSample } from "./adapters/types.ts";
import { runtimeFor } from "./runtime.ts";
import type { ExecResult, Executor } from "./types.ts";
import { uiHandler } from "./ui.ts";

const ROWS: ContainerSummary[] = [
  {
    id: "proxy",
    name: "kamal-proxy",
    image: "docker.io/basecamp/kamal-proxy:latest",
    state: "running",
    status: "Up 11 hours",
    labels: {},
    created: 1700000000,
    ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp",
  },
  {
    id: "app",
    name: "hello-web-rev-aaa",
    image: "docker.io/traefik/whoami:v1.10",
    state: "running",
    status: "Up 11 hours",
    labels: {},
    created: 1700000001,
    ports: "80/tcp",
  },
];

class FakeRuntime implements MonitorRuntime {
  async list(opts: { all?: boolean } = {}): Promise<ContainerSummary[]> {
    return opts.all === true ? ROWS : ROWS;
  }
  async stats(_id: string): Promise<StatsSample> {
    return { readAt: "2026-10-19T00:00:00Z", cpuPercent: 0, memoryUsageBytes: 1024, memoryLimitBytes: 2048, pids: 7, networks: {} };
  }
  async *logs(): AsyncIterable<string> {
    yield "line one";
    yield "line two";
  }
  async inspect(id: string): Promise<ContainerInfo> {
    return {
      id,
      name: id,
      image: "docker.io/basecamp/kamal-proxy:latest",
      state: { status: "running", running: true, exitCode: 0, restarts: 0, health: "healthy" },
      labels: {},
      env: [],
      restartPolicy: "unless-stopped",
      logDriver: "journald",
      binds: [],
      networkMode: "bundant",
      raw: {},
    };
  }
  async *events(): AsyncIterable<RuntimeEvent> {
    yield { type: "container", action: "start", time: 1760000000, actor: { id: "app", attributes: { name: "hello-web-rev-aaa" } } };
  }
}

class FakeExecutor implements Executor {
  readonly kind = "fake";
  async run(cmd: string): Promise<ExecResult> {
    if (cmd.includes("kamal-proxy list")) {
      return { code: 0, stdout: "service  host                  target\ndemo     demo.example.com      web-rev-aaa:80\n", stderr: "" };
    }
    return { code: 0, stdout: "true\n", stderr: "" };
  }
  async putFile(): Promise<void> {}
  async close(): Promise<void> {}
}

async function withUi(fn: (base: string) => Promise<void>): Promise<void> {
  const monitor = new Monitor(
    [{ host: "docker01", runtime: new FakeRuntime(), exec: new FakeExecutor() }],
    runtimeFor("podman"),
  );
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
      expect(stats.hosts[0]?.rows.length).toBe(2);

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
