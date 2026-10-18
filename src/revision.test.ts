import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRevision, sanitizeRevision } from "./revision.ts";

function git(dir: string, ...args: string[]): void {
  execSync(["git", "-C", dir, ...args].join(" "), { stdio: "pipe" });
}

describe("resolveRevision", () => {
  test("returns the short sha when HEAD exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-rev-"));
    git(dir, "init", "-q");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x");
    const rev = await resolveRevision(dir);
    expect(rev).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("falls back to rev-<base36> in a repo with no commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-rev-"));
    git(dir, "init", "-q");
    const rev = await resolveRevision(dir, 1760000000000);
    expect(rev).toBe("rev-" + (1760000000000).toString(36));
    expect(rev).toMatch(/^[a-z0-9-]+$/);
  });

  test("sanitizeRevision strips characters docker names reject", () => {
    expect(sanitizeRevision("AbC_123.X")).toBe("abc123x");
    expect(sanitizeRevision("---")).toMatch(/^[a-z0-9-]*$/);
  });
});
