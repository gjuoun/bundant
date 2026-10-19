import { describe, expect, test } from "bun:test";
import { durationToSeconds, toEpochSeconds } from "./time.ts";

describe("engine time arguments", () => {
  test("durations become seconds", () => {
    expect(durationToSeconds("30s")).toBe(30);
    expect(durationToSeconds("15m")).toBe(900);
    expect(durationToSeconds("2h")).toBe(7200);
    expect(durationToSeconds("1d")).toBe(86400);
    expect(durationToSeconds("1h30m")).toBe(5400);
    expect(durationToSeconds("")).toBeUndefined();
    expect(durationToSeconds("soon")).toBeUndefined();
  });

  test("durations are relative to now; timestamps pass through", () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    const nowSeconds = Math.floor(now / 1000);
    expect(toEpochSeconds("1h", now)).toBe(nowSeconds - 3600);
    expect(toEpochSeconds("1700000000", now)).toBe(1700000000);
    expect(toEpochSeconds(1700000000, now)).toBe(1700000000);
    expect(toEpochSeconds(new Date(now), now)).toBe(nowSeconds);
  });

  test("garbage is rejected instead of silently sending NaN", () => {
    expect(() => toEpochSeconds("last tuesday")).toThrow(/cannot read/);
  });
});
