import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliVersion } from "./version.ts";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PKG = JSON.parse(readFileSync(join(SRC_DIR, "..", "package.json"), "utf8")) as {
  version: string;
};

describe("cliVersion", () => {
  test("resolves the package root without a Bun-only dirname API", () => {
    expect(cliVersion()).toBe(PKG.version);
    expect(cliVersion()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
