import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConfigRegistry, ConfigVersionError, loadConfig, v2Module, type VersionModule } from "./config.ts";
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

/** A minimal version 3 whose schema and normalize are observably different. */
function dummyV3(): VersionModule {
  const schema = z
    .object({
      version: z.literal(3),
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
      v3Only: z.boolean().optional(),
    })
    .strict();
  return {
    version: 3,
    grammar: v2Module.grammar,
    deploySchema: schema,
    accessorySchema: schema,
    groupSchema: schema,
    normalize: (raw, hosts) => ({
      ...v2Module.normalize(raw, hosts),
      image: "v3-normalized",
    }),
    preflight: v2Module.preflight,
  };
}

describe("config versions", () => {
  test("a file without a version is rejected", async () => {
    const path = write("implicit.yml", base);
    expect(() => loadConfig(path)).toThrow(ConfigVersionError);
    expect(() => loadConfig(path)).toThrow(/version: missing config version/);
    const report = await validatePath(path);
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.field).toBe("version");
  });

  test("version 1 is unsupported with the stable exit contract", async () => {
    const path = write("v1.yml", "version: " + 1 + "\n" + base);
    expect(() => loadConfig(path)).toThrow(ConfigVersionError);
    expect(() => loadConfig(path)).toThrow(/unsupported config version 1 \(supported: 2\)/);
    const report = await validatePath(path);
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.field).toBe("version");
    expect(report.errors[0]?.message).toContain("(supported: 2)");
  });

  test("explicit version: 2 is accepted", async () => {
    const path = write("explicit.yml", "version: 2\n" + base);
    const loaded = loadConfig(path);
    expect(loaded.version).toBe(2);
    const report = await validatePath(path);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(2);
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
      expect(report.errors[0]?.message).toContain("(supported: 2)");
      expect(() => loadConfig(path)).toThrow(/version: unsupported config version/);
    }
  });

  test("a dummy version 3 can be registered without touching version 2", () => {
    const oldVersion = 1;
    const v3 = dummyV3();
    const registry = new ConfigRegistry([v2Module, v3]);

    expect(registry.supported()).toEqual([2, 3]);
    expect(registry.resolve({ version: 2 }).module).toBe(v2Module);
    expect(registry.resolve({ version: 3 }).module).toBe(v3);
    expect(registry.get(2)).toBe(v2Module);

    expect(() => registry.resolve({ version: oldVersion })).toThrow(ConfigVersionError);
    expect(() => registry.resolve({ version: oldVersion })).toThrow(/supported: 2, 3/);
  });

  test("loadConfig dispatches a registered version through the real loader entry point", () => {
    const registry = new ConfigRegistry([v2Module, dummyV3()]);
    const file = write(
      "load-v3.yml",
      [
        "version: 3",
        "service: hello",
        "image: x:1",
        "hosts: [box.test]",
        "proxy: { enabled: false }",
        "v3Only: true",
      ].join("\n"),
    );

    const loaded = loadConfig(file, { registry });
    expect(loaded.version).toBe(3);
    expect(loaded.config.image).toBe("v3-normalized");

    const v2Only = new ConfigRegistry([v2Module]);
    expect(() => loadConfig(file, { registry: v2Only })).toThrow(ConfigVersionError);
    expect(() => loadConfig(file, { registry: v2Only })).toThrow(
      /unsupported config version 3 \(supported: 2\)/,
    );
  });

  test("group.yml carries its own version", async () => {
    const groupDir = mkdtempSync(join(dir, "grp-"));
    writeFileSync(join(groupDir, "deploy.yml"), "version: 2\n" + base);
    const manifest = join(groupDir, "group.yml");
    writeFileSync(
      manifest,
      ["version: 2", "group: shop", "services:", "  - name: hello", "    file: ./deploy.yml"].join("\n"),
    );
    const report = await validatePath(manifest);
    expect(report.ok).toBe(true);
    expect(report.version).toBe(2);
    expect(report.versionExplicit).toBe(true);
  });
});
