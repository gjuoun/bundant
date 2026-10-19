import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "../api.ts";
import { DockerAdapter } from "../docker.ts";
import { FakeDockerSocket, json } from "../fake-socket.ts";
import { ApiSchemaDriftError } from "./index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
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

describe("adapter boundary validation", () => {
  test("inspect accepts the recorded docker payload", async () => {
    const { adapter, close } = await adapterOn((_req, res) => json(res, 200, fixture("docker-inspect.json")));
    try {
      const info = await adapter.inspect("api-1");
      expect(info.id).toBeString();
      expect(info.labels).toBeObject();
      expect(info.state.running).toBeBoolean();
    } finally {
      await close();
    }
  });

  test("inspect rejects a mutated payload with engine + pointer", async () => {
    const body = fixture("docker-inspect.json") as Record<string, unknown>;
    body.State = { ...(body.State as object), Running: "yes" };
    const { adapter, close } = await adapterOn((_req, res) => json(res, 200, body));
    try {
      const err = await adapter.inspect("api-1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      const drift = err as ApiSchemaDriftError;
      expect(drift.engine).toBe("docker");
      expect(drift.path).toBe("/containers/api-1/json");
      expect(drift.pointer).toBe("/State/Running");
    } finally {
      await close();
    }
  });

  test("list rejects a row whose state is not one of the spec values", async () => {
    const row = fixture("docker-containers.json") as Record<string, unknown>;
    row.State = "ghost";
    const { adapter, close } = await adapterOn((_req, res) => json(res, 200, [row]));
    try {
      const err = await adapter.list({ all: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/0/State");
    } finally {
      await close();
    }
  });

  test("stats rejects a sample without cpu_stats", async () => {
    const body = fixture("docker-stats.json") as Record<string, unknown>;
    delete body.cpu_stats;
    const { adapter, close } = await adapterOn((_req, res) => json(res, 200, body));
    try {
      const err = await adapter.stats("api-1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/cpu_stats");
    } finally {
      await close();
    }
  });

  test("inspectVolume normalizes Labels:null and rejects a non-record", async () => {
    const good = await adapterOn((_req, res) => json(res, 200, fixture("docker-volume.json")));
    try {
      expect(await good.adapter.inspectVolume("v")).toEqual({ labels: {} });
    } finally {
      await good.close();
    }

    const bad = await adapterOn((_req, res) => json(res, 200, { Name: "v", Labels: 42 }));
    try {
      const err = await bad.adapter.inspectVolume("v").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/Labels");
    } finally {
      await bad.close();
    }
  });

  test("events validates each event and maps it to RuntimeEvent", async () => {
    const event = fixture("docker-event.json") as Record<string, unknown>;
    const { adapter, close } = await adapterOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(JSON.stringify(event) + "\n");
      res.end();
    });
    try {
      const seen = [];
      for await (const item of adapter.events({ since: "1h" })) seen.push(item);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.type).toBeString();
      expect(seen[0]?.action).toBeString();
      expect(seen[0]?.id).toBeString();
      expect(seen[0]?.time).toBeNumber();
    } finally {
      await close();
    }
  });

  test("events drift is fatal instead of silently skipped", async () => {
    const event = fixture("docker-event.json") as Record<string, unknown>;
    delete event.Action;
    const { adapter, close } = await adapterOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(JSON.stringify(event) + "\n");
      res.end();
    });
    try {
      const err = await (async () => {
        for await (const _item of adapter.events({ since: "1h" })) {
          // consume
        }
      })().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/Action");
    } finally {
      await close();
    }
  });
});
