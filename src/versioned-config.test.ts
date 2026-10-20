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

/** A minimal v2 whose schema and normalize are observably different from v1. */
function dummyV2(): VersionModule {
  const schema = z
    .object({
      version: z.literal(2),
      service: z.string().min(1),
      image: z.string().min(1),
      hosts: z.array(z.string()).optional(),
      proxy: z
        .object({
          enabled: z.boolean().optional(),
          host: z.string().optional(),
          port: z.number().optional(),
        })
        .optional(),
      v2Only: z.boolean().optional(),
    })
    .strict();
  return {
    version: 2,
    grammar: v1Module.grammar,
    deploySchema: schema,
    accessorySchema: schema,
    groupSchema: schema,
    normalize: (raw, hosts) => ({
      ...v1Module.normalize(raw, hosts),
      image: "v2-normalized",
    }),
    preflight: v1Module.preflight,
  };
}

describe("config versions", () => {
  test("missing version is accepted as implicit v1", async () => {
    const path = write("implicit.yml", base);
    const loaded = loadConfig(path);
    expect(loaded.version).toBe(1);
    const report = await validatePath(path);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(1);
    expect(report.versionExplicit).toBe(false);
    expect(report.notes[0]).toContain('version: 1 (implicit - add "version: 1" to pin it)');
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
      ["three", "3"],
      ["v3", '"v3"'],
      ["fraction", "1.5"],
    ] as const) {
      const path = write("bad-" + label + ".yml", "version: " + value + "\n" + base);
      const report = await validatePath(path);
      expect(report.ok).toBe(false);
      expect(report.errors[0]?.field).toBe("version");
      expect(report.errors[0]?.message).toContain("(supported: 1, 2)");
      expect(() => loadConfig(path)).toThrow(/version: unsupported config version/);
    }
  });

  test("--strict rejects an implicit version", async () => {
    const path = write("strict.yml", base);
    const report = await validatePath(path, process.env, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.field).toBe("version");
    expect(report.errors[0]?.message).toBe(
      'missing config version (strict mode): add "version: 1" (supported: 1, 2)',
    );
    const explicit = await validatePath(write("strict-ok.yml", "version: 1\n" + base), process.env, {
      strict: true,
    });
    expect(explicit.ok).toBe(true);
  });

  test("a dummy v2 can be registered without touching v1", () => {
    const v2 = dummyV2();
    const registry = new ConfigRegistry([v1Module, v2]);

    expect(registry.supported()).toEqual([1, 2]);
    expect(registry.resolve({ version: 1 }).module).toBe(v1Module);
    expect(registry.resolve({ version: 2 }).module.version).toBe(2);
    expect(registry.resolve({ version: 2 }).module).toBe(v2);
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

  test("loadConfig dispatches v2 through the real loader entry point", () => {
    const registry = new ConfigRegistry([v1Module, dummyV2()]);
    const file = write(
      "load-v2.yml",
      [
        "version: 2",
        "service: hello",
        "image: x:1",
        "hosts: [box.test]",
        "proxy: { enabled: false }",
        "v2Only: true",
      ].join("\n"),
    );

    const loaded = loadConfig(file, { registry });
    expect(loaded.version).toBe(2);
    expect(loaded.config.image).toBe("v2-normalized");

    // The same file with a v1-only registry fails in the real loader.
    const v1Only = new ConfigRegistry([v1Module]);
    expect(() => loadConfig(file, { registry: v1Only })).toThrow(ConfigVersionError);
    expect(() => loadConfig(file, { registry: v1Only })).toThrow(
      /unsupported config version 2 \(supported: 1\)/,
    );
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
