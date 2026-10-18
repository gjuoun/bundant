import { describe, expect, test } from "bun:test";
import { parsePruneListing, selectPrune } from "./prune.ts";

function entries(names: string[]): ReturnType<typeof parsePruneListing> {
  return names.map((n, i) => ({ name: n, createdAt: "2026-10-18 1" + i + ":00:00 +0000 UTC" }));
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
