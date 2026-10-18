import { describe, expect, test } from "bun:test";
import { Monitor, parseContainers, parseInspect, parseStats, pickContainer } from "./monitor.ts";
import { runtimeFor } from "./runtime.ts";
import type { ExecResult, Executor } from "./types.ts";

const PS = [
  "kamal-proxy|docker.io/basecamp/kamal-proxy:latest|Up 11 hours|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp|2026-10-18 11:08:37.701961569 +0000 UTC",
  "hello-web-rev-mvdqbk9l|docker.io/traefik/whoami:v1.10|Exited (2) 11 hours ago|80/tcp|2026-10-18 11:08:50.229652756 +0000 UTC",
].join("\n");

const STATS = ["kamal-proxy|0.00%|2.601MB / 24.53GB|0.01%|7", "hello-web-rev-mvdqbk9l|0.00%|2.605MB / 24.53GB|0.01%|5"].join(
  "\n",
);

const INSPECT =
  "/kamal-proxy|running|0|2026-10-18 11:48:54.941992695 +0000 UTC|-|docker.io/basecamp/kamal-proxy:latest|unless-stopped|journald|0";

describe("parsers", () => {
  test("containers: five fields, host attached, blank lines dropped", () => {
    const rows = parseContainers("box", PS + "\n");
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      host: "box",
      name: "kamal-proxy",
      image: "docker.io/basecamp/kamal-proxy:latest",
      status: "Up 11 hours",
      ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp",
      createdAt: "2026-10-18 11:08:37.701961569 +0000 UTC",
    });
  });

  test("stats: cpu / mem / mem% / pids", () => {
    const rows = parseStats("box", STATS);
    expect(rows[1]).toEqual({
      host: "box",
      name: "hello-web-rev-mvdqbk9l",
      cpu: "0.00%",
      mem: "2.605MB / 24.53GB",
      memPct: "0.01%",
      pids: "5",
    });
  });

  test("inspect: leading slash stripped, '-' health kept, fields aligned", () => {
    const row = parseInspect("box", INSPECT);
    expect(row?.name).toBe("kamal-proxy");
    expect(row?.state).toBe("running");
    expect(row?.restarts).toBe("0");
    expect(row?.health).toBe("-");
    expect(row?.restartPolicy).toBe("unless-stopped");
    expect(row?.logDriver).toBe("journald");
    expect(row?.exitCode).toBe("0");
  });

  test("inspect: empty output is null, not a half-filled row", () => {
    expect(parseInspect("box", "")).toBeNull();
  });

  test("selector: exact name wins over prefix, prefix still resolves", () => {
    const names = ["hello-web-rev-aaa", "hello-web-rev-aaa-b", "api-web-rev-ccc"];
    expect(pickContainer(names, "api-web-rev-ccc")).toBe("api-web-rev-ccc");
    expect(pickContainer(names, "hello-web")).toBe("hello-web-rev-aaa");
    expect(pickContainer(names, "nope")).toBeUndefined();
  });
});

type StreamImpl = (cmd: string, opts?: { tty?: boolean; onLine?: (line: string) => void }) => Promise<number>;

class FakeExecutor implements Executor {
  readonly kind = "fake";
  readonly calls: string[] = [];
  readonly streamImpl: StreamImpl | undefined;
  constructor(private readonly handle: (cmd: string) => ExecResult, streamImpl?: StreamImpl) {
    this.streamImpl = streamImpl;
  }
  get stream(): StreamImpl | undefined {
    return this.streamImpl;
  }
  async run(cmd: string): Promise<ExecResult> {
    this.calls.push(cmd);
    return this.handle(cmd);
  }
  async putFile(): Promise<void> {}
  async close(): Promise<void> {}
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

describe("Monitor (behavioral, fake ssh)", () => {
  const rt = runtimeFor("podman");

  function monitorForTwo(second: FakeExecutor): Monitor {
    const first = new FakeExecutor(() => ok(PS));
    return new Monitor(
      [
        { host: "docker01", exec: first },
        { host: "docker02", exec: second },
      ],
      rt,
    );
  }

  test("fan-out: a dead host is reported, the healthy one still returns rows", async () => {
    const dead = new FakeExecutor(() => ({ code: 255, stdout: "", stderr: "ssh: connect failed" }));
    const result = await monitorForTwo(dead).containers();
    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.rows.length).toBe(2);
    expect(result[1]?.ok).toBe(false);
    expect(result[1]?.error).toBe("ssh: connect failed");
  });

  test("grep-free host grouping: queries are per host and read-only", async () => {
    const second = new FakeExecutor(() => ok(PS));
    const monitor = monitorForTwo(second);
    await monitor.containers();
    expect(second.calls.every((c) => c.startsWith("podman ps -a"))).toBe(true);
    await monitor.stats();
    expect(second.calls.some((c) => c.startsWith("podman stats --no-stream"))).toBe(true);
  });

  test("logs: container resolved by prefix, output returned verbatim", async () => {
    const exec = new FakeExecutor((cmd) => {
      if (cmd.startsWith("podman ps -a --format")) return ok("hello-web-rev-aaa\napi-web-rev-bbb\n");
      return ok("log line 1\nlog line 2\n");
    });
    const monitor = new Monitor([{ host: "box", exec }], rt);
    const text = await monitor.logs("box", "hello-web", 50);
    expect(text).toBe("log line 1\nlog line 2\n");
    expect(exec.calls.some((c) => c === "podman logs --tail 50 hello-web-rev-aaa")).toBe(true);
  });

  test("logs: unknown host throws with the known list", async () => {
    const exec = new FakeExecutor(() => ok(""));
    const monitor = new Monitor([{ host: "box", exec }], rt);
    await expect(monitor.logs("other", "x", 10)).rejects.toThrow(/unknown host: other/);
  });

  test("selector prefers the running revision over a retained stopped one", async () => {
    const exec = new FakeExecutor((cmd) => {
      if (cmd === 'podman ps --format "{{.Names}}"') return ok("app-web-rev-new\n");
      if (cmd.startsWith("podman ps -a --format")) return ok("app-web-rev-old\napp-web-rev-new\n");
      return ok("streamed\n");
    });
    const monitor = new Monitor([{ host: "box", exec }], rt);
    await monitor.logs("box", "app-web", 10);
    expect(exec.calls.some((c) => c.startsWith("podman logs --tail 10 app-web-rev-new"))).toBe(true);
    expect(exec.calls.some((c) => c.includes("app-web-rev-old"))).toBe(false);
  });

  test("follow: prefixes each line with its host, one stream per host", async () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const mk = (host: string): FakeExecutor =>
        new FakeExecutor(
          () => ok(host + "-container\n"),
          async (_cmd, opts) => {
            opts?.onLine?.("hello from " + host);
            return 0;
          },
        );
      const monitor = new Monitor(
        [
          { host: "docker01", exec: mk("docker01") },
          { host: "docker02", exec: mk("docker02") },
        ],
        rt,
      );
      expect(await monitor.followLogs({ tail: 10 })).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const joined = lines.join("");
    expect(joined).toContain("docker01");
    expect(joined).toContain("hello from docker02");
  });

  test("exec: requires a streaming executor and quotes nothing away", async () => {
    const seen: string[] = [];
    const exec = new FakeExecutor(
      () => ok("web-rev-xyz\n"),
      async (cmd) => {
        seen.push(cmd);
        return 0;
      },
    );
    const monitor = new Monitor([{ host: "box", exec }], rt);
    expect(await monitor.execShell("box", "web", ["sh", "-c", "echo hi"])).toBe(0);
    expect(seen[0]).toBe("podman exec -it web-rev-xyz sh -c echo hi");
  });
});
