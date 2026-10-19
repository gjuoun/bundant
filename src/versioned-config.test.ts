import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConfigRegistry, ConfigVersionError, loadConfig, v1Module, type VersionModule } from "./config.ts";
import { validatePath } from "./validation.ts";

const dir = mkdtempSync(join(tmpdir(), "bundant-ver-"));
afterAll(() => {});

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const base = [
  "service: hello",
  "image: traefik/whoami:v1.10",
  "hosts: [box.test]",
  "proxy: { enabled: false }",
].join("\n");

describe("config versions", () => {
  test("missing version is accepted as implicit v1", async () => {
    const path = write("implicit.yml", base);
    const loaded = loadConfig(path);
    expect(loaded.version).toBe(1);
    const report = await validatePath(path);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(1);
    expect(report.versionExplicit).toBe(false);
    expect(report.notes[0]).toContain('version: 1 (implicit — add "version: 1" to pin it)');
  });

  test("explicit version: 1 is accepted without a note", async () => {
    const path = write("explicit.yml", "version: 1\n" + base);
    const loaded = loadConfig(path);
    expect(loaded.version).toBe(1);
    const report = await validatePath(path);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(1);
    expect(report.versionExplicit).toBe(true);
    expect(report.notes).toEqual([]);
  });

  test("unknown versions list the supported ones", async () => {
    for (const [label, value] of [
      ["two", "2"],
      ["v2", '"v2"'],
      ["fraction", "1.5"],
    ] as const) {
      const path = write("bad-" + label + ".yml", "version: " + value + "\n" + base);
      const report = await validatePath(path);
      expect(report.ok).toBe(false);
      expect(report.errors[0]?.field).toBe("version");
      expect(report.errors[0]?.message).toContain("(supported: 1)");
      expect(() => loadConfig(path)).toThrow(/version: unsupported config version/);
    }
  });

  test("--strict rejects an implicit version", async () => {
    const path = write("strict.yml", base);
    const report = await validatePath(path, process.env, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.field).toBe("version");
    expect(report.errors[0]?.message).toBe(
      'missing config version (strict mode): add "version: 1" (supported: 1)',
    );
    const explicit = await validatePath(write("strict-ok.yml", "version: 1\n" + base), process.env, {
      strict: true,
    });
    expect(explicit.ok).toBe(true);
  });

  test("a dummy v2 can be registered without touching v1", () => {
    const v2Schema = z
      .object({
        version: z.literal(2),
        service: z.string().min(1),
        image: z.string().min(1),
      })
      .strict();
    const dummyV2: VersionModule = {
      version: 2,
      grammar: v1Module.grammar,
      deploySchema: v2Schema,
      accessorySchema: v2Schema,
      groupSchema: v2Schema,
      normalize: v1Module.normalize,
      preflight: v1Module.preflight,
    };
    const registry = new ConfigRegistry([v1Module, dummyV2]);

    expect(registry.supported()).toEqual([1, 2]);
    expect(registry.resolve({ version: 1 }).module).toBe(v1Module);
    expect(registry.resolve({ version: 2 }).module.version).toBe(2);
    expect(registry.resolve({}).version).toBe(1);

    // v1 behaviour is untouched by the extra registration.
    const before = v1Module.deploySchema.safeParse({ version: 1, service: "Bad_Name", image: "x" });
    const after = registry.get(1).deploySchema.safeParse({ version: 1, service: "Bad_Name", image: "x" });
    expect(before.success).toBe(false);
    expect(after.success).toBe(false);
    expect(registry.get(1)).toBe(v1Module);

    expect(() => registry.resolve({ version: 3 })).toThrow(ConfigVersionError);
    expect(() => registry.resolve({ version: 3 })).toThrow(/supported: 1, 2/);
  });

  test("group.yml carries its own version", async () => {
    const groupDir = mkdtempSync(join(dir, "grp-"));
    writeFileSync(join(groupDir, "deploy.yml"), base);
    const manifest = join(groupDir, "group.yml");
    writeFileSync(
      manifest,
      ["version: 1", "group: shop", "services:", "  - name: hello", "    file: ./deploy.yml"].join("\n"),
    );
    const report = await validatePath(manifest);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(1);
    expect(report.versionExplicit).toBe(true);
  });
});
