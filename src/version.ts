import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of this module, resolved identically under bun and node.
 * The Bun-only module-dirname property and node's newer module-dirname field
 * each exist on only one runtime, so the URL form is the portable one.
 */
const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

/** CLI version, read from the package root that contains src/. */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(SRC_DIR, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
