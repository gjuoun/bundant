import { describe, expect, test } from "bun:test";
import { ApiClient } from "./api.ts";
import { DockerAdapter } from "./docker.ts";
import { PodmanAdapter } from "./podman.ts";
import { FakeDockerSocket, json } from "./fake-socket.ts";
import { NotImplementedInStage1 } from "./types.ts";

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
}

async function adapterOn(
  handler: Parameters<typeof FakeDockerSocket.create>[0],
): Promise<{ adapter: DockerAdapter; close: () => Promise<void> }> {
  const server = await FakeDockerSocket.create(handler);
  const client = await ApiClient.create({ socketPath: server.socketPath, preferDockerode: false });
  return {
    adapter: new DockerAdapter(client, "29.1.3", "1.52"),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("DockerAdapter read-only surface", () => {
  test("list sends both label and name filters and maps summary rows", async () => {
    let filters: string | null = null;
    const { adapter, close } = await adapterOn((req, res) => {
      const url = new URL(req.url, "http://localhost");
      filters = url.searchParams.get("filters");
      expect(url.searchParams.get("all")).toBe("1");
      json(res, 200, [
        {
          Id: "abc",
          Names: ["/api-web-rev-1"],
          Image: "example/api:1",
          State: "running",
          Status: "Up 2 hours",
          Labels: { "bundant.service": "api" },
          Created: 1700000000,
          Ports: [
            { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
            { PrivatePort: 443, Type: "tcp" },
          ],
        },
      ]);
    });
    try {
      const rows = await adapter.list({
        all: true,
        labels: { "bundant.service": "api" },
        namePrefix: "api-",
      });
      expect(JSON.parse(filters ?? "{}")).toEqual({
        label: ["bundant.service=api"],
        name: ["api-"],
      });
      expect(rows).toEqual([
        {
          id: "abc",
          name: "api-web-rev-1",
          image: "example/api:1",
          state: "running",
          status: "Up 2 hours",
          labels: { "bundant.service": "api" },
          created: 1700000000,
          ports: "0.0.0.0:8080->80/tcp, 443/tcp",
        },
      ]);
    } finally {
      await close();
    }
  });

  test("inspect maps state, labels, env and restart policy", async () => {
    const { adapter, close } = await adapterOn((_req, res) => {
      json(res, 200, {
        Id: "abc",
        Name: "/api-web-rev-1",
        RestartCount: 2,
        Config: { Image: "example/api:1", Env: ["A=1"], Labels: { "bundant.service": "api" } },
        State: {
          Status: "running",
          Running: true,
          ExitCode: 0,
          StartedAt: "2026-10-19T00:00:00Z",
          Health: { Status: "healthy" },
        },
        HostConfig: {
          RestartPolicy: { Name: "unless-stopped" },
          Binds: ["vol:/data"],
          NetworkMode: "bundant",
          LogConfig: { Type: "journald" },
        },
      });
    });
    try {
      const info = await adapter.inspect("api-web-rev-1");
      expect(info.name).toBe("api-web-rev-1");
      expect(info.state.running).toBe(true);
      expect(info.env).toEqual(["A=1"]);
      expect(info.restartPolicy).toBe("unless-stopped");
      expect(info.binds).toEqual(["vol:/data"]);
      expect(info.networkMode).toBe("bundant");
      expect(info.state.restarts).toBe(2);
      expect(info.state.health).toBe("healthy");
      expect(info.logDriver).toBe("journald");
    } finally {
      await close();
    }
  });

  test("logs streams and demultiplexes stdout/stderr frames", async () => {
    const seen: { query: URL | null } = { query: null };
    const { adapter, close } = await adapterOn((req, res) => {
      seen.query = new URL(req.url, "http://localhost");
      res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      res.write(frame(1, "hello\n"));
      res.write(frame(2, "warn\n"));
      res.end();
    });
    try {
      const lines: string[] = [];
      for await (const line of adapter.logs("abc", { tail: 20 })) lines.push(line);
      expect(lines).toEqual(["hello", "warn"]);
      expect(seen.query?.searchParams.get("tail")).toBe("20");
      expect(seen.query?.searchParams.get("stdout")).toBe("1");
      expect(seen.query?.searchParams.get("follow")).toBe("0");
    } finally {
      await close();
    }
  });

  test("events parses one JSON event per line", async () => {
    const { adapter, close } = await adapterOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(
        JSON.stringify({ Type: "container", Action: "start", time: 1, Actor: { ID: "abc" } }) + "\n" +
          JSON.stringify({ Type: "container", Action: "die", time: 2, Actor: { ID: "abc" } }) + "\n",
      );
      res.end();
    });
    try {
      const events = [];
      for await (const event of adapter.events({ since: "1h" })) events.push(event);
      expect(events.map((e) => e.action)).toEqual(["start", "die"]);
    } finally {
      await close();
    }
  });

  test("stats computes cpu percent from deltas", async () => {
    const { adapter, close } = await adapterOn((_req, res) => {
      json(res, 200, {
        read: "2026-10-19T00:00:00Z",
        cpu_stats: {
          cpu_usage: { total_usage: 300, percpu_usage: [100, 200] },
          system_cpu_usage: 4000,
          online_cpus: 2,
        },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 3000 },
        memory_stats: { usage: 1024, limit: 2048 },
        pids_stats: { current: 7 },
        networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
      });
    });
    try {
      const sample = await adapter.stats("abc");
      expect(sample.cpuPercent).toBe(40);
      expect(sample.memoryUsageBytes).toBe(1024);
      expect(sample.memoryLimitBytes).toBe(2048);
      expect(sample.pids).toBe(7);
      expect(sample.networks.eth0).toEqual({ rxBytes: 10, txBytes: 20 });
    } finally {
      await close();
    }
  });

  test("mutations outside stage 3 still throw NotImplementedInStage1", async () => {
    const { adapter, close } = await adapterOn((_req, res) => json(res, 200, {}));
    try {
      await expect(adapter.createVolume("v", {})).rejects.toBeInstanceOf(NotImplementedInStage1);
      await expect(adapter.loadImage(null as never)).rejects.toBeInstanceOf(NotImplementedInStage1);
    } finally {
      await close();
    }
  });

  test("podman keeps the same surface with kind=podman", async () => {
    const server = await FakeDockerSocket.create((_req, res) => json(res, 200, []));
    try {
      const client = await ApiClient.create({ socketPath: server.socketPath, preferDockerode: false });
      const adapter = new PodmanAdapter(client, "5.7.0", "5.7.0");
      expect(adapter.kind).toBe("podman");
      expect(await adapter.list({})).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
