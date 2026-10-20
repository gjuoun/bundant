import { describe, expect, test } from "bun:test";
import {
  HostLayerCache,
  loadHostLayers,
  localLayers,
  missingLayers,
  normalizeLayerId,
  parseRootfsLayers,
} from "./layers.ts";
import type { RuntimeAdapter } from "../adapters/types.ts";
import { runtimeFor } from "../runtime.ts";

const L1 = "sha256:" + "1".repeat(64);
const L2 = "sha256:" + "2".repeat(64);
const L3 = "sha256:" + "3".repeat(64);

describe("layer inventory", () => {
  test("normalizes ids and reads RootFS.Layers tolerantly", () => {
    expect(normalizeLayerId("abc")).toBe("sha256:abc");
    expect(normalizeLayerId("sha256:abc")).toBe("sha256:abc");
    expect(normalizeLayerId("  ")).toBe("");
    expect(parseRootfsLayers({ RootFS: { Type: "layers", Layers: [L1, "2".repeat(64)] } }))
      .toEqual([L1, L2]);
    expect(parseRootfsLayers({})).toEqual([]);
    expect(parseRootfsLayers({ RootFS: { Layers: [L1, 7] } })).toEqual([L1]);
  });

  test("missing set: empty host sends every layer in order", () => {
    expect(missingLayers([L1, L2, L3], new Set())).toEqual({
      missing: [L1, L2, L3],
      reused: 0,
      total: 3,
    });
  });

  test("missing set: identical host sends nothing", () => {
    expect(missingLayers([L1, L2], new Set([L1, L2]))).toEqual({
      missing: [],
      reused: 2,
      total: 2,
    });
  });

  test("missing set: one new layer keeps the image order", () => {
    const delta = missingLayers([L1, L2, L3], new Set([L3, L1]));
    expect(delta.missing).toEqual([L2]);
    expect(delta.reused).toBe(2);
    expect(delta.total).toBe(3);
  });

  test("missing set: unordered host input and bare ids are equivalent", () => {
    expect(missingLayers([L1, L2, L3], ["3".repeat(64), L1]).missing).toEqual([L2]);
    expect(missingLayers([L1, L2, L3], new Set([L1, L2, L3])).missing).toEqual([]);
  });

  test("duplicate local ids count once", () => {
    expect(missingLayers([L1, L1, L2], new Set([L1]))).toEqual({
      missing: [L2],
      reused: 1,
      total: 2,
    });
  });
});

describe("local and host reads", () => {
  test("localLayers parses the inspect output and quotes the ref", async () => {
    const calls: string[] = [];
    const exec = {
      kind: "local" as const,
      async run(cmd: string) {
        calls.push(cmd);
        return { code: 0, stdout: JSON.stringify([L1, "2".repeat(64)]), stderr: "" };
      },
      async putFile() {},
      async close() {},
    };
    const layers = await localLayers("app:t'1", runtimeFor("docker"), exec);
    expect(layers).toEqual([L1, L2]);
    expect(calls[0]).toContain("'app:t'\\''1'");
  });

  test("localLayers surfaces the engine error", async () => {
    const exec = {
      kind: "local" as const,
      async run() {
        return { code: 1, stdout: "", stderr: "no such image" };
      },
      async putFile() {},
      async close() {},
    };
    await expect(localLayers("nope:t1", runtimeFor("docker"), exec)).rejects.toThrow(
      "no such image",
    );
  });

  test("host layers fold every image and the cache is reusable until refreshed", async () => {
    let listCalls = 0;
    const layersById: Record<string, string[]> = {
      a: [L1],
      b: [L2, L3],
    };
    const adapter = {
      async imageIds() {
        listCalls += 1;
        return Object.keys(layersById);
      },
      async imageLayers(id: string) {
        return layersById[id] ?? [];
      },
    } as unknown as RuntimeAdapter;

    const set = await loadHostLayers(adapter);
    expect([...set]).toEqual([L1, L2, L3]);

    const cache = new HostLayerCache(adapter);
    expect(await cache.get()).toEqual(set);
    expect(await cache.get()).toEqual(set);
    expect(listCalls).toBe(2); // loadHostLayers + one cached fetch
    layersById.c = [L1];
    await cache.get(true);
    expect(listCalls).toBe(3);
  });
});
