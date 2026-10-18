import { describe, expect, test } from "bun:test";
import { runProcess } from "./process.ts";

describe("runProcess (node:child_process shim used by both runtimes)", () => {
  test("captures exit code and stdout", async () => {
    const r = await runProcess(["sh", "-c", "echo hi"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).toBe("");
  });

  test("captures stderr and a non-zero exit code", async () => {
    const r = await runProcess(["sh", "-c", "echo oops >&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("oops\n");
  });

  test("a missing binary reports 127 with a message", async () => {
    const r = await runProcess(["bundant-no-such-binary-xyz"]);
    expect(r.code).toBe(127);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("a shell pipeline round-trips through gzip inside one spawn", async () => {
    const r = await runProcess(["sh", "-c", "printf 'bundant\\n' | gzip -1 | gunzip"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("bundant\n");
  });

  test("no maxBuffer ceiling: 2 MB of output is captured intact", async () => {
    const r = await runProcess(["sh", "-c", "yes x | head -c 2000000"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(2000000);
  });
});
