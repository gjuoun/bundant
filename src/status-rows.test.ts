import { describe, expect, it } from "bun:test";
import { normalize } from "./config/deploy-base.ts";
import type { BundantConfig } from "./config/types.ts";
import type { ResolvedUnit, UnitContainer } from "./select/resolve.ts";
import { statusRows } from "./status-rows.ts";

function config(overrides: Partial<ReturnType<typeof normalize>> = {}): BundantConfig {
  return {
    ...normalize(
      {
        version: 2,
        service: "api",
        image: "img",
        hosts: ["h"],
        replicas: 2,
        proxy: { enabled: true, host: "api.test" },
      },
      ["h"],
    ),
    group: "shop",
    ...overrides,
  };
}

function container(name: string, state: string, emulated?: true): UnitContainer {
  return { host: "h", name, image: "img", state, revision: "r1", replica: 1, ...(emulated ? { emulated } : {}) };
}

function unit(path: string, containers: UnitContainer[]): ResolvedUnit {
  return { path, kind: path.split(".").length === 2 ? "accessory" : "service", revision: "r1", containers };
}

describe("statusRows", () => {
  it("uses the declared replica count for the unit the config owns", () => {
    const rows = statusRows(
      [unit("shop.api.web", [container("a", "running"), container("b", "running")])],
      config(),
    );
    expect(rows).toEqual([
      {
        path: "shop.api.web",
        kind: "service",
        revision: "r1",
        expected: 2,
        live: 2,
        containers: ["a", "b"],
      },
    ]);
  });

  it("reports other units by what is actually there", () => {
    const rows = statusRows(
      [
        unit("shop.api.web", [container("a", "running")]),
        unit("shop.db", [container("db", "running"), container("db2", "exited")]),
      ],
      config(),
    );
    expect(rows.map((row) => row.expected)).toEqual([2, 2]);
    expect(rows[1]!.live).toBe(1);
    expect(rows[1]!.kind).toBe("accessory");
  });

  it("propagates the emulated marker", () => {
    const rows = statusRows(
      [unit("shop.api.web", [container("a", "running", true)])],
      config(),
    );
    expect(rows[0]!.emulated).toBe(true);
  });
});
