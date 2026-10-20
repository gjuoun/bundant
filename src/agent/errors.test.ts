import { describe, expect, test } from "bun:test";
import {
  ERROR_CATALOG,
  ERROR_CODES,
  errorCatalog,
  exitCodeFor,
  exitCodeForCode,
  failureFor,
  UsageError,
  LockError,
  NoMatchError,
  HealthError,
  NotFoundError,
  UnknownError,
} from "../agent/errors.ts";
import { failureEnvelope, renderEnvelope, successEnvelope } from "../agent/envelope.ts";
import { commandName, wantsJson } from "../agent/emit.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildErrorsSchema } from "../../scripts/gen-errors.ts";

const EXPECTED: Record<string, number> = {
  OK: 0,
  USAGE: 4,
  CONFIG_INVALID: 1,
  CONFIG_VERSION_UNSUPPORTED: 1,
  VALIDATION_FAILED: 1,
  NO_MATCH: 3,
  LOCK_HELD: 2,
  ENGINE_UNAVAILABLE: 1,
  API_DRIFT: 1,
  HEALTH_TIMEOUT: 1,
  PROXY_SWAP_FAILED: 1,
  TRANSPORT_ERROR: 1,
  NOT_FOUND: 1,
  INTERNAL: 1,
};

describe("error catalog", () => {
  test("every code is unique and carries the contract exit status", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const [code, exit] of Object.entries(EXPECTED)) {
      expect(ERROR_CATALOG[code as keyof typeof ERROR_CATALOG].exitCode as number).toBe(exit);
      expect(exitCodeForCode(code as keyof typeof ERROR_CATALOG)).toBe(exit);
    }
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test("the catalog lists every code with its status", () => {
    const entries = errorCatalog();
    expect(entries.length).toBe(ERROR_CODES.length);
    expect(entries.find((entry) => entry.code === "NO_MATCH")).toEqual({
      code: "NO_MATCH",
      exitCode: 3,
      when: ERROR_CATALOG.NO_MATCH.when,
    });
  });

  test("tagged failures carry code, message and details", () => {
    const usage = failureFor(new UsageError({ message: "missing --replicas" }));
    expect(usage).toEqual({ code: "USAGE", message: "missing --replicas", details: {} });
    const lock = failureFor(new LockError({ message: "held", service: "shop/api" }));
    expect(lock.code).toBe("LOCK_HELD");
    expect(lock.details).toEqual({ service: "shop/api" });
    expect(exitCodeFor(new LockError({ message: "held" }))).toBe(2);
    expect(exitCodeFor(new NoMatchError({ message: "none", pattern: "x.**" }))).toBe(3);
    expect(exitCodeFor(new HealthError({ message: "timeout" }))).toBe(1);
    expect(exitCodeFor(new NotFoundError({ message: "missing" }))).toBe(1);
    const internal = failureFor(new UnknownError({ message: "defect" }));
    expect(internal.code).toBe("INTERNAL");
    expect(internal.details).toEqual({ tag: "UnknownError" });
  });

  test("the envelope is one line and both directions are stable", () => {
    const ok = renderEnvelope(successEnvelope("status", [{ path: "default.hello.web" }]));
    expect(ok.endsWith("\n")).toBe(true);
    expect(ok.trimEnd().split("\n").length).toBe(1);
    expect(JSON.parse(ok)).toEqual({
      ok: true,
      command: "status",
      data: [{ path: "default.hello.web" }],
    });

    const failed = renderEnvelope(failureEnvelope("deploy", new HealthError({ message: "timeout" })));
    expect(failed.trimEnd().split("\n").length).toBe(1);
    expect(JSON.parse(failed)).toEqual({
      ok: false,
      command: "deploy",
      error: { code: "HEALTH_TIMEOUT", message: "timeout", details: {} },
    });
  });

  test("schema/errors.json is generated from the catalog", () => {
    const onDisk = readFileSync(join(import.meta.dir, "../../schema/errors.json"), "utf8");
    expect(onDisk).toBe(buildErrorsSchema());
  });

  test("command naming skips flags, their values and -- passthrough", () => {
    expect(commandName(["--file", "deploy.yml", "status", "--json"])).toBe("status");
    expect(commandName(["-f", "x.yml", "deploy"])).toBe("deploy");
    expect(commandName(["--json", "history"])).toBe("history");
    expect(commandName(["--", "status"])).toBe("bundant");
    expect(wantsJson(["status", "--json"])).toBe(true);
    expect(wantsJson(["exec", "--", "sh", "--json"])).toBe(false);
  });
});
