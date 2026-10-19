import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApiTypes, GENERATED_DIR } from "../../scripts/api-gen.ts";

describe("generated API types", () => {
  test("checked-in files match the archived specs + allowlist", async () => {
    for (const generated of await buildApiTypes()) {
      const current = readFileSync(join(GENERATED_DIR, generated.file), "utf8");
      expect(current, generated.file + " is stale; run bun run api:gen").toBe(generated.text);
    }
  });
});
