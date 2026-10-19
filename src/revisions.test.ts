import { describe, expect, test } from "bun:test";
import {
  RevisionNotFoundError,
  parseHistory,
  replicaOf,
  revisionOf,
  selectByRevision,
  selectPrevious,
} from "./revisions.ts";

const LISTING = [
  "hello-web-rev3|2026-10-18 12:00:00 +0000 UTC|Up 2 minutes",
  "hello-web-rev1|2026-10-18 10:00:00 +0000 UTC|Exited (0) 2 hours ago",
  "hello-web-rev2|2026-10-18 11:00:00 +0000 UTC|Exited (0) 1 hour ago",
].join("\n");

describe("history parsing", () => {
  test("parses name|createdAt|state and sorts newest-first", () => {
    const entries = parseHistory(LISTING);
    expect(entries.map((e) => e.revision)).toEqual(["rev3", "rev2", "rev1"]);
    expect(entries[0]!.state).toBe("Up 2 minutes");
  });

  test("ignores blank lines", () => {
    expect(parseHistory("\n\n")).toEqual([]);
  });

  test("revisionOf strips the service-role prefix", () => {
    expect(revisionOf("hello-web-abc1234", "hello", "web")).toBe("abc1234");
    expect(revisionOf("api-worker-9f8e7d6")).toBe("9f8e7d6");
  });

  test("revisionOf strips a trailing replica suffix", () => {
    expect(revisionOf("hello-web-abc1234-1", "hello", "web")).toBe("abc1234");
    expect(revisionOf("hello-web-abc1234-12", "hello", "web")).toBe("abc1234");
    expect(revisionOf("hello-web-abc1234", "hello", "web")).toBe("abc1234");
    // a numeric revision is kept whole when the prefix is given
    expect(revisionOf("hello-web-1234", "hello", "web")).toBe("1234");
    expect(revisionOf("hello-web-1234-3", "hello", "web")).toBe("1234");
  });

  test("replicaOf reads the index; the single-replica name has none", () => {
    expect(replicaOf("hello-web-abc1234-2", "hello", "web")).toBe(2);
    expect(replicaOf("hello-web-abc1234", "hello", "web")).toBeUndefined();
  });

  test("replicas of one revision group into that revision", () => {
    const entries = parseHistory(
      [
        "hello-web-rev3-1|2026-10-18 12:00:00 +0000 UTC|Up 2 minutes",
        "hello-web-rev3-2|2026-10-18 12:00:00 +0000 UTC|Up 2 minutes",
        "hello-web-rev2|2026-10-18 11:00:00 +0000 UTC|Exited (0) 1 hour ago",
      ].join("\n"),
    );
    expect(entries.map((e) => e.revision)).toEqual(["rev3", "rev3", "rev2"]);
  });
});

describe("rollback selection", () => {
  test("selectPrevious picks the revision right below the current one", () => {
    const sel = selectPrevious(parseHistory(LISTING));
    expect(sel?.current.revision).toBe("rev3");
    expect(sel?.target.revision).toBe("rev2");
  });

  test("selectPrevious is null with fewer than two revisions", () => {
    expect(selectPrevious(parseHistory("hello-web-rev1|2026-10-18 10:00:00 UTC|Up"))).toBeNull();
    expect(selectPrevious([])).toBeNull();
  });

  test("selectByRevision finds an exact revision id", () => {
    const sel = selectByRevision(parseHistory(LISTING), "rev1");
    expect(sel.target.revision).toBe("rev1");
    expect(sel.current.revision).toBe("rev3");
  });

  test("selectByRevision accepts the full container name", () => {
    expect(selectByRevision(parseHistory(LISTING), "hello-web-rev2").target.revision).toBe("rev2");
  });

  test("selectByRevision reports the available revisions when the id is unknown", () => {
    try {
      selectByRevision(parseHistory(LISTING), "nope");
      throw new Error("expected a RevisionNotFoundError");
    } catch (e) {
      expect(e).toBeInstanceOf(RevisionNotFoundError);
      expect((e as RevisionNotFoundError).message).toContain("rev1, rev2, rev3");
    }
  });

  test("selectByRevision on the current revision selects itself (rolled forward = no-op)", () => {
    const sel = selectByRevision(parseHistory(LISTING), "rev3");
    expect(sel.target.revision).toBe(sel.current.revision);
  });

  test("after a rollback the running revision is the anchor, so undo keeps walking back", () => {
    // rev2 was rolled back to: it is Up, rev3 (newer) is Exited.
    const afterRollback = [
      "hello-web-rev3|2026-10-18 12:00:00 +0000 UTC|Exited (0) 1 minute ago",
      "hello-web-rev2|2026-10-18 11:00:00 +0000 UTC|Up 30 seconds",
      "hello-web-rev1|2026-10-18 10:00:00 +0000 UTC|Exited (0) 2 hours ago",
    ].join("\n");
    const sel = selectPrevious(parseHistory(afterRollback));
    expect(sel?.current.revision).toBe("rev2");
    expect(sel?.target.revision).toBe("rev1");
  });
});
