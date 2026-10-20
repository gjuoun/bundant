import { describe, expect, test } from "bun:test";
import type { ContainerSummary } from "../adapters/types.ts";
import { NoMatchError } from "./selector.ts";
import { foldUnits, resolve, type UnitSource } from "./resolve.ts";

function row(
  name: string,
  labels: Record<string, string>,
  created = 0,
  state = "running",
): ContainerSummary {
  return { id: name, name, image: "x", state, status: "Up", labels, created, ports: "" };
}

const service = (
  group: string,
  name: string,
  role: string,
  revision: string,
  replica = 1,
  created = 100,
): ContainerSummary =>
  row(
    group + "." + name + "." + role + "." + revision + (replica > 1 ? "." + replica : ""),
    {
      "bundant.group": group,
      "bundant.service": name,
      "bundant.kind": "service",
      "bundant.revision": revision,
      "bundant.replica": String(replica),
    },
    created,
  );

const rows = [
  service("shop", "api", "web", "r2", 1, 300),
  service("shop", "api", "web", "r2", 2, 300),
  service("shop", "api", "web", "r2", 3, 300),
  service("shop", "api", "web", "r1", 1, 100),
  service("shop", "web", "web", "r2", 1, 300),
  service("other", "api", "web", "r2", 1, 300),
  row("shop.db", { "bundant.group": "shop", "bundant.service": "db", "bundant.kind": "accessory" }, 300),
];

function source(host = "root@h"): UnitSource {
  return {
    host,
    ops: { listContainers: async () => rows },
  };
}

describe("foldUnits", () => {
  test("folds by path and revision, including accessory and replicas", () => {
    const units = foldUnits(rows.map((row) => ({ host: "h", row })));
    const api = units.filter((u) => u.path === "shop.api.web");
    expect(api.map((u) => u.revision).sort()).toEqual(["r1", "r2"]);
    expect(api.find((u) => u.revision === "r2")?.replicas).toEqual([1, 2, 3]);
    expect(units.find((u) => u.path === "shop.db")?.kind).toBe("accessory");
  });
});

describe("resolve patterns", () => {
  test("shop.api.* -> one unit with three replicas", async () => {
    const out = await resolve("shop.api.*", { sources: [source()] });
    expect(out.map((u) => u.path)).toEqual(["shop.api.web"]);
    expect(out[0]!.containers).toHaveLength(3);
  });

  test("shop.** includes services and the accessory", async () => {
    const out = await resolve("shop.**", { sources: [source()] });
    expect(out.map((u) => u.path).sort()).toEqual(["shop.api.web", "shop.db", "shop.web.web"]);
  });

  test("**.web matches every web role", async () => {
    const out = await resolve("**.web", { sources: [source()] });
    expect(out.map((u) => u.path).sort()).toEqual(["other.api.web", "shop.api.web", "shop.web.web"]);
  });

  test("* matches every unit", async () => {
    const out = await resolve("*", { sources: [source()] });
    expect(out.map((u) => u.path).sort()).toEqual([
      "other.api.web",
      "shop.api.web",
      "shop.db",
      "shop.web.web",
    ]);
  });

  test("--replica 2 selects one container", async () => {
    const out = await resolve("shop.api.*", { sources: [source()], replica: 2 });
    expect(out[0]!.containers.map((c) => c.name)).toEqual(["shop.api.web.r2.2"]);
  });

  test("--all-revisions keeps old revisions", async () => {
    const out = await resolve("shop.api.*", { sources: [source()], allRevisions: true });
    expect(out.map((u) => u.revision).sort()).toEqual(["r1", "r2"]);
  });

  test("zero matches throws NoMatchError with host context", async () => {
    await expect(resolve("nothing.**", { sources: [source("root@box")] })).rejects.toThrow(
      NoMatchError,
    );
    await expect(resolve("nothing.**", { sources: [source("root@box")] })).rejects.toThrow(
      /root@box/,
    );
  });
});
