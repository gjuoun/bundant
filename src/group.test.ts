import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inferAccessoryGroup } from "./accessory.ts";
import { loadGroup, type GroupMember } from "./config.ts";
import {
  GroupCycleError,
  groupRollbackPlan,
  memberLabels,
  topoSortMembers,
} from "./group.ts";

const tmp = mkdtempSync(join(tmpdir(), "bundant-group-"));

function write(rel: string, body: string): string {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

const accessory = [
  "kind: accessory",
  "service: db",
  "image: docker.io/library/postgres:16-alpine",
  "hosts: [root@host1]",
  "volumes: [\"pgdata:/var/lib/postgresql/data\"]",
  "healthcheck: { tcp: 5432, timeout: 60 }",
  "proxy: { enabled: false }",
].join("\n");

function service(name: string, host = "root@host1"): string {
  return [
    "service: " + name,
    "image: traefik/whoami:v1.10",
    "hosts: [" + host + "]",
    "proxy: { host: " + name + ".test, port: 80 }",
  ].join("\n");
}

const manifest = [
  "group: shop",
  "services:",
  "  - name: db",
  "    file: ./db/accessory.yml",
  "  - name: api",
  "    file: ./api/deploy.yml",
  "    needs: [db]",
  "  - name: web",
  "    file: ./web/deploy.yml",
  "    needs: [api]",
].join("\n");

function shop(): ReturnType<typeof loadGroup> {
  write("shop/group.yml", manifest);
  write("shop/db/accessory.yml", accessory);
  write("shop/api/deploy.yml", service("api"));
  write("shop/web/deploy.yml", service("web"));
  return loadGroup(join(tmp, "shop/group.yml"));
}

describe("loadGroup", () => {
  test("parses the manifest, resolves files, and tags every member with the group", () => {
    const g = shop();
    expect(g.group).toBe("shop");
    expect(g.members.map((m) => m.name)).toEqual(["db", "api", "web"]);
    expect(g.members[0]!.loaded.config.kind).toBe("accessory");
    expect(g.members[1]!.loaded.config.kind).toBe("service");
    expect(g.members[1]!.loaded.config.group).toBe("shop");
    expect(g.members[0]!.file.endsWith("shop/db/accessory.yml")).toBe(true);
    expect(g.members[1]!.needs).toEqual(["db"]);
    expect(g.members[2]!.needs).toEqual(["api"]);
  });

  test("rejects a duplicate member name", () => {
    const dup = manifest.replace("  - name: web", "  - name: api");
    write("dup/group.yml", dup);
    expect(() => loadGroup(join(tmp, "dup/group.yml"))).toThrow(/duplicate member/);
  });

  test("rejects a member whose file declares a different service", () => {
    write("mismatch/group.yml", manifest.replace("file: ./web/deploy.yml", "file: ./web/deploy.yml"));
    write("mismatch/db/accessory.yml", accessory);
    write("mismatch/api/deploy.yml", service("api"));
    write("mismatch/web/deploy.yml", service("not-web"));
    expect(() => loadGroup(join(tmp, "mismatch/group.yml"))).toThrow(/declares service/);
  });

  test("rejects a need that names no member", () => {
    write("unknown/group.yml", manifest.replace("needs: [db]", "needs: [ghost]"));
    write("unknown/db/accessory.yml", accessory);
    write("unknown/api/deploy.yml", service("api"));
    write("unknown/web/deploy.yml", service("web"));
    expect(() => loadGroup(join(tmp, "unknown/group.yml"))).toThrow(/unknown member 'ghost'/);
  });
});

describe("topoSortMembers", () => {
  test("dependencies come first even when the manifest lists dependents first", () => {
    const g = shop();
    const reversed = [...g.members].reverse();
    expect(topoSortMembers(reversed).map((m) => m.name)).toEqual(["db", "api", "web"]);
  });

  test("independent members keep manifest order", () => {
    const g = shop();
    const flat = g.members.map((m) => ({ ...m, needs: [] as string[] })) as GroupMember[];
    expect(topoSortMembers(flat).map((m) => m.name)).toEqual(["db", "api", "web"]);
  });

  test("a cycle is an error", () => {
    const g = shop();
    const cyclic = g.members.map((m) => ({ ...m }));
    cyclic[1]!.needs = ["web"];
    cyclic[2]!.needs = ["api"];
    expect(() => topoSortMembers(cyclic)).toThrow(GroupCycleError);
  });
});

describe("groupRollbackPlan", () => {
  test("maps every service to the same shared revision and skips accessories", () => {
    const g = shop();
    const plan = groupRollbackPlan(g.members, "4f3c1ab");
    expect(plan.map((p) => p.member.name)).toEqual(["api", "web"]);
    expect(plan.every((p) => p.revision === "4f3c1ab")).toBe(true);
  });
});

describe("inferAccessoryGroup", () => {
  test("a standalone accessory file resolves the namespace from its sibling group.yml", () => {
    const g = shop();
    expect(inferAccessoryGroup(g.members[0]!.file)).toBe("shop");
    expect(inferAccessoryGroup(join(tmp, "no-group/accessory.yml"))).toBeUndefined();
  });
});

describe("memberLabels", () => {
  test("carries the exact service + group labels", () => {
    expect(memberLabels("shop", "api")).toEqual({
      "bundant.service": "api",
      "bundant.kind": "service",
      "bundant.group": "shop",
    });
  });
});
