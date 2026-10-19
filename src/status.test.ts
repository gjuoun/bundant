import { describe, expect, test } from "bun:test";
import { liveReplicas, parseStatusLines, replicaSummary } from "./status.ts";

const PS = [
  "echoes-web-rev3-1 Up 3 minutes",
  "echoes-web-rev3-2 Up 3 minutes",
  "echoes-web-rev3-3 Up 2 minutes",
  "echoes-web-rev2-1 Exited (0) 1 hour ago",
  "echoes-web-rev1 Exited (0) 2 hours ago",
].join("\n");

describe("status replica view", () => {
  test("parses name + state", () => {
    const lines = parseStatusLines(PS);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({ name: "echoes-web-rev3-1", state: "Up 3 minutes" });
  });

  test("live replicas are the running ones of the running revision, index-ordered", () => {
    const live = liveReplicas(parseStatusLines(PS), "echoes", "web");
    expect(live.revision).toBe("rev3");
    expect(live.replicas.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(live.replicas.map((r) => r.name)).toEqual([
      "echoes-web-rev3-1",
      "echoes-web-rev3-2",
      "echoes-web-rev3-3",
    ]);
  });

  test("a single-replica deployment reports one live replica", () => {
    const live = liveReplicas(parseStatusLines("echoes-web-rev3 Up 3 minutes"), "echoes", "web");
    expect(live.replicas).toHaveLength(1);
    expect(live.replicas[0]!.index).toBe(1);
  });

  test("nothing running reports no revision", () => {
    const live = liveReplicas(parseStatusLines("echoes-web-rev3 Exited (0) 1 hour ago"), "echoes", "web");
    expect(live.revision).toBeUndefined();
    expect(live.replicas).toEqual([]);
  });

  test("summary marks drift between live and expected", () => {
    expect(replicaSummary(3, 3)).toBe("replicas: live 3 / expected 3");
    expect(replicaSummary(2, 3)).toContain("drift");
  });
});
