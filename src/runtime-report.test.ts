import { describe, expect, test } from "bun:test";
import { ApiSchemaDriftError } from "./adapters/schemas/drift.ts";
import { renderRuntimeReport, runtimeExitCode } from "./runtime-report.ts";

describe("bundant runtime drift reporting", () => {
  test("a drift error is a failed host, rendered with the drift message, exit 1", () => {
    const drift = new ApiSchemaDriftError(
      { engine: "podman", method: "GET", path: "/containers/api-1/json" },
      { code: "invalid_type", path: ["State", "Running"], expected: "boolean", received: "string", message: "Expected boolean, received string" },
      { State: { Running: "yes" } },
    );
    const reports = [
      { host: "root@docker01", ok: false, error: drift.message },
    ];

    expect(runtimeExitCode(reports)).toBe(1);
    const rendered = renderRuntimeReport(reports);
    expect(rendered).toContain("bundant: engine API schema drift: podman GET /containers/api-1/json at /State/Running");
    expect(rendered).toContain('payload: "yes"');
  });

  test("all-ok reports exit 0", () => {
    expect(runtimeExitCode([{ host: "root@docker02", ok: true }])).toBe(0);
  });
});
