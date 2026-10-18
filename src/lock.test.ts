import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "./exec/local.ts";
import { acquireLock, LockHeldError, lockDir, releaseLock } from "./lock.ts";

const base = mkdtempSync(join(tmpdir(), "bundant-lock-"));
const exec = new LocalExecutor();

beforeAll(() => {
  process.env.BUNDANT_LOCK_BASE = base;
});
afterAll(() => {
  delete process.env.BUNDANT_LOCK_BASE;
});

describe("deploy lock (LocalExecutor against a temp dir)", () => {
  test("acquire succeeds and writes owner info", async () => {
    await acquireLock(exec, "svc");
    const ownerPath = lockDir("svc").replace(/^~/, process.env.HOME ?? "~") + "/owner";
    expect(existsSync(ownerPath)).toBe(true);
  });

  test("second acquire is rejected with owner info", async () => {
    try {
      await acquireLock(exec, "svc");
      throw new Error("expected LockHeldError");
    } catch (e) {
      expect(e).toBeInstanceOf(LockHeldError);
      expect((e as LockHeldError).ageSeconds).toBeGreaterThanOrEqual(0);
      expect((e as LockHeldError).message).toContain("held by");
    }
  });

  test("stale lock is reclaimed after the TTL", async () => {
    const dir = lockDir("svc2");
    mkdirSync(dir.replace(/^~/, process.env.HOME ?? "~"), { recursive: true });
    const old = Math.floor(Date.now() / 1000) - 1000;
    writeFileSync(dir.replace(/^~/, process.env.HOME ?? "~") + "/owner", "someone " + old + "\n");
    await acquireLock(exec, "svc2", { ttlSeconds: 100 });
    expect(existsSync(dir.replace(/^~/, process.env.HOME ?? "~") + "/owner")).toBe(true);
  });

  test("release then re-acquire works", async () => {
    await releaseLock(exec, "svc");
    await acquireLock(exec, "svc");
    await releaseLock(exec, "svc");
  });
});
