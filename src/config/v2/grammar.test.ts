import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "../../validation.ts";
import { v1Grammar } from "../v1/grammar.ts";
import {
  IDENTIFIER_RE,
  composeAccessory,
  composeDotted,
  parseDotted,
  v2Grammar,
} from "./grammar.ts";

describe("v2 identifiers", () => {
  const valid = ["api", "shop-api", "camelCase", "snake_case", "A1", "Shop.Api_Test".replace(".", "-")];
  const invalid = ["has space", "a..b", "-lead", "trail-", "a--b", "a__b", "a/b", "a.b", "_lead"];

  test("accepts kebab, camel, snake and uppercase identifiers", () => {
    for (const value of valid) expect(IDENTIFIER_RE.test(value), value).toBe(true);
  });

  test("rejects spaces, dots and edge/consecutive separators", () => {
    for (const value of invalid) expect(IDENTIFIER_RE.test(value), value).toBe(false);
  });
});

describe("v2 dotted composition", () => {
  test("service and replica round-trip", () => {
    const identity = {
      group: "Shop",
      service: "api",
      role: "Web",
      revision: "r2026a",
      replica: 2,
    };
    const name = composeDotted(identity);
    expect(name).toBe("Shop.api.Web.r2026a.2");
    expect(parseDotted(name, "Shop")).toEqual(identity);
    expect(v2Grammar.roundTrips(identity)).toBe(true);
  });

  test("ungrouped service still carries the default group (4 segments)", () => {
    const identity = { group: "default", service: "api", role: "web", revision: "r1" };
    expect(composeDotted(identity)).toBe("default.api.web.r1");
    expect(parseDotted(composeDotted(identity))).toEqual(identity);
  });

  test("accessory is exactly two segments", () => {
    const identity = { group: "shop", service: "db", role: "", revision: "", kind: "accessory" };
    expect(composeAccessory(identity)).toBe("shop.db");
    expect(parseDotted("shop.db")).toEqual(identity);
  });

  test("wrong segment counts and invalid identifiers are rejected", () => {
    expect(() => parseDotted("shop.api.web")).toThrow(/expected/);
    expect(() => parseDotted("shop.api.web.r1.2.3")).toThrow(/expected/);
    expect(() => parseDotted("shop..web.r1")).toThrow(/empty/);
    expect(() => parseDotted("shop.api/x.web.r1")).toThrow(/identifier/);
  });

  test("v1 grammar is unchanged", () => {
    expect(v1Grammar.compose({ group: "shop", service: "api", role: "web", revision: "r1" })).toBe(
      "shop-api-web-r1",
    );
  });
});

describe("v2 validation", () => {
  test("validatePath reports version 2 and a dotted container", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-v2-"));
    const file = join(dir, "deploy.yml");
    writeFileSync(
      file,
      [
        "version: 2",
        "service: Shop-Api",
        "image: x:1",
        "role: Web",
        "hosts: [box.test]",
        "proxy: { enabled: true, host: box.test }",
      ].join("\n"),
    );
    const report = await validatePath(file);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(2);
    expect(report.identity?.kind).toBe("service");
    if (report.identity?.kind === "service") {
      expect(report.identity.containerNamePattern).toContain("default.Shop-Api.Web.");
    }
  });
});
