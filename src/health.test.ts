import { describe, expect, test } from "bun:test";
import type { ExecResult, Executor } from "./types.ts";
import { HealthGateError, waitUntilHealthy } from "./health.ts";

class FakeExecutor implements Executor {
  readonly kind = "fake";
  public calls: string[] = [];
  private results: ExecResult[];
  constructor(results: ExecResult[]) {
    this.results = results;
  }
  run(cmd: string): Promise<ExecResult> {
    this.calls.push(cmd);
    const r = this.results.shift() ?? { code: 1, stdout: "000", stderr: "" };
    return Promise.resolve(r);
  }
  putFile(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const noSleep = () => Promise.resolve();

describe("waitUntilHealthy", () => {
  test("recovers after two failing probes", async () => {
    const exec = new FakeExecutor([
      { code: 0, stdout: "503", stderr: "" },
      { code: 0, stdout: "503", stderr: "" },
      { code: 0, stdout: "200", stderr: "" },
    ]);
    const r = await waitUntilHealthy(exec, "probe-cmd", { timeoutMs: 5000, sleep: noSleep });
    expect(r.attempts).toBe(3);
    expect(exec.calls.length).toBe(3);
  });

  test("times out and aborts with structured error", async () => {
    const exec = new FakeExecutor([]);
    try {
      await waitUntilHealthy(exec, "probe-cmd", { timeoutMs: 30, intervalMs: 5, sleep: noSleep });
      throw new Error("expected HealthGateError");
    } catch (e) {
      expect(e).toBeInstanceOf(HealthGateError);
      expect((e as HealthGateError).lastCode).toBe("000");
      expect((e as HealthGateError).attempts).toBeGreaterThanOrEqual(1);
    }
  });
});
