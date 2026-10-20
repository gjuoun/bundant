import { describe, expect, test } from "bun:test";
import { NoMatchError, SelectorError, parseSelector, selectUnits, unitPath } from "./selector.ts";

const paths = [
  "shop/db",
  "shop/api/web",
  "shop/api/admin",
  "other/api/web",
  "archive/old/web",
];

describe("selector matching", () => {
  const table: Array<[string, string[]]> = [
    ["shop.db", ["shop/db"]],
    ["shop.*", ["shop/db"]],
    ["shop.**", ["shop/db", "shop/api/web", "shop/api/admin"]],
    ["**.web", ["shop/api/web", "other/api/web", "archive/old/web"]],
    ["shop.[ad]*", ["shop/db"]],
    ["shop.api.?eb", ["shop/api/web"]],
    ["*", paths],
  ];

  for (const [pattern, expected] of table) {
    test(pattern, () => {
      const parsed = parseSelector(pattern);
      expect(paths.filter((path) => parsed.match(path))).toEqual(expected);
    });
  }

  test("unit paths for services and accessories", () => {
    expect(unitPath({ group: "shop", service: "api", role: "web" })).toBe("shop.api.web");
    expect(
      unitPath({ group: "shop", service: "db", role: "", kind: "accessory" }),
    ).toBe("shop.db");
  });
});

describe("selector rejections and no-match", () => {
  test("trailing numeric segment is rejected with a hint", () => {
    expect(() => parseSelector("shop.api.2")).toThrow(/--replica N or --revision REV/);
    expect(() => parseSelector("shop.api.web.2")).toThrow(/--replica N or --revision REV/);
  });

  test("empty and empty-segment patterns are rejected", () => {
    expect(() => parseSelector("")).toThrow(SelectorError);
    expect(() => parseSelector("a..b")).toThrow(/empty path segment/);
  });

  test("zero matches raises NoMatchError with the searched context", () => {
    const units = paths.map((path) => ({ path }));
    expect(() => selectUnits("nothing.**", units, "labels bundant.group=nothing")).toThrow(
      'no unit matches "nothing.**" (labels bundant.group=nothing)',
    );
    try {
      selectUnits("nothing.**", units);
    } catch (error) {
      expect(error).toBeInstanceOf(NoMatchError);
    }
  });
});
