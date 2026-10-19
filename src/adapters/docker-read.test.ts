import { describe, expect, test } from "bun:test";
import { ApiClient } from "./api.ts";
import { DockerAdapter } from "./docker.ts";
import { FakeDockerSocket, json } from "./fake-socket.ts";
import { ApiSchemaDriftError } from "./schemas/drift.ts";

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

describe("adapter streaming and drift", () => {
  test("logs --follow streams frames and splits lines across frame boundaries", async () => {
    let follow = "";
    const { adapter, close } = await adapterOn((req, res) => {
      follow = new URL(req.url, "http://localhost").searchParams.get("follow") ?? "";
      res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      res.write(frame(1, "hel"));
      res.write(frame(1, "lo\nwor"));
      res.write(frame(2, "ld\n"));
      res.end();
    });
    try {
      const lines: string[] = [];
      for await (const line of adapter.logs("abc", { follow: true, tail: 5 })) lines.push(line);
      expect(follow).toBe("1");
      expect(lines).toEqual(["hello", "world"]);
    } finally {
      await close();
    }
  });

  test("events sends the label filter and validates every line", async () => {
    let filters: string | null = null;
    const { adapter, close } = await adapterOn((req, res) => {
      filters = new URL(req.url, "http://localhost").searchParams.get("filters");
      res.writeHead(200, { "content-type": "application/json" });
      res.write(
        JSON.stringify({
          Type: "container",
          Action: "start",
          time: 3,
          Actor: { ID: "abc", Attributes: { name: "alpha-api-web-rev-1" } },
        }) + "\n",
      );
      res.end();
    });
    try {
      const events = [];
      for await (const event of adapter.events({ since: "1h", labels: { "bundant.group": "alpha" } })) {
        events.push(event);
      }
      expect(JSON.parse(filters ?? "{}")).toEqual({ label: ["bundant.group=alpha"] });
      expect(events[0]?.actor?.attributes?.name).toBe("alpha-api-web-rev-1");
    } finally {
      await close();
    }
  });

  test("a mutated inspect payload raises ApiSchemaDriftError", async () => {
    const { adapter, close } = await adapterOn((_req, res) => {
      json(res, 200, { Idd: "abc", Name: "/api", State: { Status: "running" } });
    });
    try {
      const err = await adapter.inspect("abc").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      const drift = err as ApiSchemaDriftError;
      expect(drift.pointer).toBe("/Id");
      expect(drift.message).toContain("engine API schema drift: docker GET /containers/abc/json");
    } finally {
      await close();
    }
  });

  test("a mutated stats field is drift, not a silent zero", async () => {
    const { adapter, close } = await adapterOn((_req, res) => {
      json(res, 200, {
        read: "2026-10-19T00:00:00Z",
        cpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 2 },
        memory_stats: { usage: 1, limit: 2 },
        pids_stats: { current: "seven" },
      });
    });
    try {
      const err = await adapter.stats("abc").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/pids_stats/current");
    } finally {
      await close();
    }
  });
});
