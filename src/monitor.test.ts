import { describe, expect, test } from "bun:test";
import { Monitor, pickContainer, type HostTarget, type MonitorRuntime } from "./monitor.ts";
import type {
  ContainerInfo,
  ContainerSummary,
  RuntimeEvent,
  StatsSample,
} from "./adapters/types.ts";
import { runtimeFor } from "./runtime.ts";
import type { ExecResult, Executor } from "./types.ts";

function summary(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "id-" + (over.name ?? "x"),
    name: "app-web-rev-1",
    image: "example/app:1",
    state: "running",
    status: "Up 2 hours",
    labels: {},
    created: 1700000000,
    ports: "0.0.0.0:8080->80/tcp",
    ...over,
  };
}

class FakeRuntime implements MonitorRuntime {
  readonly rows: ContainerSummary[];
  readonly listCalls: { all?: boolean; labels?: Record<string, string>; namePrefix?: string }[] = [];
  readonly eventCalls: { since?: number | string; until?: number | string; labels?: Record<string, string> }[] = [];
  readonly logCalls: { id: string; follow?: boolean; tail?: number }[] = [];
  readonly inspectCalls: string[] = [];

  constructor(rows: ContainerSummary[]) {
    this.rows = rows;
  }

  async list(opts: { all?: boolean; labels?: Record<string, string>; namePrefix?: string } = {}): Promise<ContainerSummary[]> {
    this.listCalls.push(opts);
    return this.rows
      .filter((r) => opts.all === true || r.state === "running")
      .filter((r) => opts.namePrefix === undefined || r.name.startsWith(opts.namePrefix))
      .filter((r) =>
        Object.entries(opts.labels ?? {}).every(([k, v]) => r.labels[k] === v),
      );
  }

  async stats(id: string): Promise<StatsSample> {
    return {
      readAt: "2026-10-19T00:00:00Z",
      cpuPercent: id.endsWith("slow") ? 12.5 : 0,
      memoryUsageBytes: id.endsWith("slow") ? 1536 : 1024,
      memoryLimitBytes: 2048,
      pids: 7,
      networks: {},
    };
  }

  async *logs(id: string, opts: { tail?: number; follow?: boolean } = {}): AsyncIterable<string> {
    this.logCalls.push({ id, follow: opts.follow, tail: opts.tail });
    yield "line one";
    yield "line two";
  }

  async inspect(id: string): Promise<ContainerInfo> {
    this.inspectCalls.push(id);
    return {
      id,
      name: id,
      image: "example/app:1",
      state: { status: "running", running: true, exitCode: 0, startedAt: "2026-10-19T00:00:00Z", restarts: 2, health: "healthy" },
      labels: {},
      env: [],
      restartPolicy: "unless-stopped",
      logDriver: "journald",
      binds: [],
      networkMode: "bundant",
      raw: {},
    };
  }

  async *events(opts: { since?: number | string; until?: number | string; labels?: Record<string, string> } = {}): AsyncIterable<RuntimeEvent> {
    this.eventCalls.push(opts);
    yield { type: "container", action: "start", id: "abc", time: 1760000000, actor: { id: "abc", attributes: { name: "app-web-rev-1" } } };
  }
}

type StreamImpl = (cmd: string, opts?: { tty?: boolean; onLine?: (line: string) => void }) => Promise<number>;

class FakeExecutor implements Executor {
  readonly kind = "fake";
  readonly streamImpl: StreamImpl | undefined;
  constructor(streamImpl?: StreamImpl) {
    this.streamImpl = streamImpl;
  }
  get stream(): StreamImpl | undefined {
    return this.streamImpl;
  }
  async run(_cmd: string): Promise<ExecResult> {
    return { code: 0, stdout: "", stderr: "" };
  }
  async putFile(): Promise<void> {}
  async close(): Promise<void> {}
}

function monitorWith(runtime: MonitorRuntime, host = "docker01"): Monitor {
  const target: HostTarget = { host, runtime };
  return new Monitor([target], runtimeFor("podman"));
}

describe("Monitor over the adapter", () => {
  test("containers: API rows become names/image/status/ports", async () => {
    const monitor = monitorWith(new FakeRuntime([summary()]));
    const result = await monitor.containers();
    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.rows[0]).toEqual({
      host: "docker01",
      name: "app-web-rev-1",
      image: "example/app:1",
      status: "Up 2 hours",
      ports: "0.0.0.0:8080->80/tcp",
      createdAt: "2023-11-14T22:13:20.000Z",
    });
  });

  test("a host whose adapter failed is reported, not thrown", async () => {
    const monitor = new Monitor([{ host: "docker02", error: "no podman socket" }], runtimeFor("podman"));
    const result = await monitor.containers();
    expect(result[0]).toEqual({ host: "docker02", ok: false, error: "no podman socket", rows: [] });
  });

  test("stats: one sample per running container, CPU/mem/pids mapped", async () => {
    const monitor = monitorWith(new FakeRuntime([summary({ id: "slow", name: "app-web-slow" })]));
    const result = await monitor.stats();
    expect(result[0]?.rows[0]).toEqual({
      host: "docker01",
      name: "app-web-slow",
      cpu: "12.50%",
      mem: "1.50KiB / 2.00KiB",
      memPct: "75.00%",
      pids: "7",
    });
  });

  test("logs: selector resolves by prefix and lines are joined", async () => {
    const runtime = new FakeRuntime([summary({ name: "app-web-rev-1" })]);
    const monitor = monitorWith(runtime);
    expect(await monitor.logs("docker01", "app-web", 50)).toBe("line one\nline two\n");
    expect(runtime.logCalls[0]).toEqual({ id: "app-web-rev-1", follow: undefined, tail: 50 });
  });

  test("inspect: state, restarts, health, image, policy and log driver", async () => {
    const monitor = monitorWith(new FakeRuntime([summary({ name: "app-web-rev-1" })]));
    const row = (await monitor.inspect("app-web"))[0]?.rows[0];
    expect(row).toEqual({
      host: "docker01",
      name: "app-web-rev-1",
      state: "running",
      restarts: "2",
      startedAt: "2026-10-19T00:00:00Z",
      health: "healthy",
      image: "example/app:1",
      restartPolicy: "unless-stopped",
      logDriver: "journald",
      exitCode: "0",
    });
  });

  test("events: label filter is passed to the adapter and lines keep the old shape", async () => {
    const runtime = new FakeRuntime([]);
    const monitor = monitorWith(runtime);
    const lines = await monitor.events("docker01", "1h", { labels: { "bundant.group": "alpha" } });
    expect(runtime.eventCalls[0]?.since).toBe("1h");
    expect(runtime.eventCalls[0]?.labels).toEqual({ "bundant.group": "alpha" });
    expect(typeof runtime.eventCalls[0]?.until).toBe("number");
    expect(lines).toEqual(["1760000000|container|start|app-web-rev-1"]);
  });

  test("follow: streams through the adapter and prefixes a multi-host tag", async () => {
    const runtime = new FakeRuntime([summary({ name: "app-web-rev-1" })]);
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const monitor = new Monitor(
        [
          { host: "docker01", runtime },
          { host: "docker02", runtime },
        ],
        runtimeFor("podman"),
      );
      expect(await monitor.followLogs({ tail: 10 })).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(runtime.logCalls.every((c) => c.follow === true && c.tail === 10)).toBe(true);
    expect(lines.join("")).toContain("docker01");
    expect(lines.join("")).toContain("line two");
  });

  test("execShell stays on ssh and quotes nothing away", async () => {
    const seen: string[] = [];
    const exec = new FakeExecutor(async (cmd) => {
      seen.push(cmd);
      return 0;
    });
    const monitor = new Monitor(
      [{ host: "box", runtime: new FakeRuntime([summary({ name: "web-rev-xyz" })]), exec }],
      runtimeFor("podman"),
    );
    expect(await monitor.execShell("box", "web", ["sh", "-c", "echo hi"])).toBe(0);
    expect(seen[0]).toBe("podman exec -it web-rev-xyz sh -c echo hi");
  });

  test("selector: exact name wins over prefix", () => {
    const names = ["hello-web-rev-aaa", "hello-web-rev-aaa-b", "api-web-rev-ccc"];
    expect(pickContainer(names, "api-web-rev-ccc")).toBe("api-web-rev-ccc");
    expect(pickContainer(names, "hello-web")).toBe("hello-web-rev-aaa");
    expect(pickContainer(names, "nope")).toBeUndefined();
  });
});
