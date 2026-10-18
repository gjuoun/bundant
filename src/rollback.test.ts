import { describe, expect, test } from "bun:test";
import { parseListing, selectRollbackTarget } from "./rollback.ts";

const LISTING = [
  "hello-web-rev3 2026-10-18 12:00:00 +0000 UTC",
  "hello-web-rev1 2026-10-18 10:00:00 +0000 UTC",
  "hello-web-rev2 2026-10-18 11:00:00 +0000 UTC",
].join("\n");

describe("rollback selection", () => {
  test("parses and sorts newest-first regardless of listing order", () => {
    const entries = parseListing(LISTING);
    expect(entries.map((e) => e.name)).toEqual([
      "hello-web-rev3",
      "hello-web-rev2",
      "hello-web-rev1",
    ]);
  });

  test("rollback 1 selects the previous revision", () => {
    const sel = selectRollbackTarget(parseListing(LISTING), 1);
    expect(sel?.current.name).toBe("hello-web-rev3");
    expect(sel?.target.name).toBe("hello-web-rev2");
  });

  test("rollback 2 skips one", () => {
    expect(selectRollbackTarget(parseListing(LISTING), 2)?.target.name).toBe("hello-web-rev1");
  });

  test("returns null when there is nothing to roll back to", () => {
    expect(
      selectRollbackTarget(parseListing("hello-web-only 2026-10-18 12:00:00 +0000 UTC"), 1),
    ).toBeNull();
    expect(selectRollbackTarget(parseListing(LISTING), 3)).toBeNull();
    expect(selectRollbackTarget(parseListing(""), 1)).toBeNull();
  });
});
