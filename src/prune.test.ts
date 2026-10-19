import { describe, expect, test } from "bun:test";
import { groupByRevision, parsePruneListing, selectPrune } from "./prune.ts";

/** Fixture list: the given order is newest-first, as the runtime reports it. */
function entries(names: string[]): ReturnType<typeof parsePruneListing> {
  return names.map((n, i) => ({
    name: n,
    createdAt: "2026-10-18 " + String(20 - i).padStart(2, "0") + ":00:00 +0000 UTC",
  }));
}

describe("selectPrune", () => {
  test("removes stopped containers beyond the newest K", () => {
    const list = entries(["r5", "r4", "r3", "r2", "r1"]);
    expect(selectPrune(list, new Set(), 3)).toEqual(["r2", "r1"]);
  });

  test("never removes running containers even beyond K", () => {
    const list = entries(["r5", "r4", "r3", "r2", "r1"]);
    expect(selectPrune(list, new Set(["r2"]), 3)).toEqual(["r1"]);
    expect(selectPrune(list, new Set(["r1", "r2"]), 3)).toEqual([]);
  });

  test("clamps when there are fewer revisions than K", () => {
    expect(selectPrune(entries(["r2", "r1"]), new Set(), 3)).toEqual([]);
    expect(selectPrune([], new Set(), 3)).toEqual([]);
  });

  test("keep=0 prunes every stopped revision", () => {
    expect(selectPrune(entries(["r2", "r1"]), new Set(["r2"]), 0)).toEqual(["r1"]);
  });

  test("groups by revision: keeping a revision keeps all of its replicas", () => {
    const list: ReturnType<typeof parsePruneListing> = [
      { name: "api-web-rev3-1", createdAt: "2026-10-18 13:00:00 +0000 UTC" },
      { name: "api-web-rev3-2", createdAt: "2026-10-18 13:00:01 +0000 UTC" },
      { name: "api-web-rev2-1", createdAt: "2026-10-18 12:00:00 +0000 UTC" },
      { name: "api-web-rev2-2", createdAt: "2026-10-18 12:00:01 +0000 UTC" },
      { name: "api-web-rev1", createdAt: "2026-10-18 11:00:00 +0000 UTC" },
    ];
    // keep 2 revisions -> rev1 (all its one container) goes
    expect(selectPrune(list, new Set(), 2, "api", "web")).toEqual(["api-web-rev1"]);
    // keep 1 -> rev2's two replicas go together, rev3's two stay
    expect(selectPrune(list, new Set(), 1, "api", "web")).toEqual([
      "api-web-rev2-1",
      "api-web-rev2-2",
      "api-web-rev1",
    ]);
  });

  test("a running replica never gets pruned even if its revision is beyond K", () => {
    const list: ReturnType<typeof parsePruneListing> = [
      { name: "api-web-rev2-1", createdAt: "2026-10-18 12:00:00 +0000 UTC" },
      { name: "api-web-rev1-1", createdAt: "2026-10-18 11:00:00 +0000 UTC" },
    ];
    expect(selectPrune(list, new Set(["api-web-rev1-1"]), 1, "api", "web")).toEqual([]);
  });
});

describe("groupByRevision", () => {
  test("one group per revision, newest first", () => {
    const groups = groupByRevision(
      [
        { name: "api-web-rev1-1", createdAt: "2026-10-18 11:00:00 +0000 UTC" },
        { name: "api-web-rev1-2", createdAt: "2026-10-18 11:00:01 +0000 UTC" },
        { name: "api-web-rev2-1", createdAt: "2026-10-18 12:00:00 +0000 UTC" },
      ],
      "api",
      "web",
    );
    expect(groups.map((g) => g.revision)).toEqual(["rev2", "rev1"]);
    expect(groups[1]!.entries).toHaveLength(2);
  });
});

describe("parsePruneListing", () => {
  test("sorts newest-first regardless of input order", () => {
    const out = [
      "hello-web-a 2026-10-18 10:00:00 +0000 UTC",
      "hello-web-c 2026-10-18 12:00:00 +0000 UTC",
      "hello-web-b 2026-10-18 11:00:00 +0000 UTC",
    ].join("\n");
    expect(parsePruneListing(out).map((e) => e.name)).toEqual([
      "hello-web-c",
      "hello-web-b",
      "hello-web-a",
    ]);
  });
});
