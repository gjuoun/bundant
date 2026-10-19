import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import { SCHEMA_DIR, buildSchemas } from "../scripts/gen-schema.ts";
import { RawConfigSchema, GroupFileSchema } from "./config.ts";

const ROOT = join(import.meta.dir, "..");
const ajv = new Ajv({ allErrors: true, strict: false });

function load(name: string) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

/** ajv registers schemas by $id, so each file may only be compiled once. */
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

function errorsFor(schemaFile: string, doc: unknown): string[] {
  let validate = compiled.get(schemaFile);
  if (!validate) {
    validate = ajv.compile(load(schemaFile));
    compiled.set(schemaFile, validate);
  }
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

function walk(dir: string, hit: (path: string) => void) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, hit);
    else hit(full);
  }
}

describe("published JSON Schemas", () => {
  test("checked-in schema/*.json match what the zod source generates", () => {
    for (const [file, expected] of Object.entries(buildSchemas())) {
      const actual = readFileSync(join(SCHEMA_DIR, file), "utf8");
      expect(actual, `${file} is stale — run: bun run schema:gen`).toBe(expected);
    }
  });

  test("every example deploy.yml/accessory.yml validates", () => {
    const files: string[] = [];
    walk(join(ROOT, "examples"), (p) => {
      if (/\.ya?ml$/.test(p) && !p.endsWith("group.yml")) files.push(p);
    });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = parseYaml(readFileSync(file, "utf8"));
      expect(errorsFor("deploy.schema.json", doc), file).toEqual([]);
    }
  });

  test("every example group.yml validates", () => {
    const files: string[] = [];
    walk(join(ROOT, "examples"), (p) => {
      if (p.endsWith("group.yml")) files.push(p);
    });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = parseYaml(readFileSync(file, "utf8"));
      expect(errorsFor("group.schema.json", doc), file).toEqual([]);
    }
  });

  test("the schema rejects what zod rejects (negative control)", () => {
    const badName = { service: "API_Service", image: "x" };
    expect(errorsFor("deploy.schema.json", badName).join(" ")).toContain("pattern");
    const typo = { service: "api", image: "x", healthchek: { path: "/" } };
    expect(errorsFor("deploy.schema.json", typo).join(" ")).toContain("additional properties");
    const missingFile = { group: "shop", services: [{ name: "api" }] };
    expect(errorsFor("group.schema.json", missingFile).join(" ")).toContain("required property 'file'");
    const groupTypo = { group: "shop", services: [{ name: "api", file: "./api/deploy.yml" }], servicez: [] };
    expect(errorsFor("group.schema.json", groupTypo).join(" ")).toContain("additional properties");
  });

  test("deploy schema mirrors the zod field set exactly", () => {
    const schema = load("deploy.schema.json") as { properties: Record<string, unknown> };
    const zodKeys = Object.keys(RawConfigSchema.shape).sort();
    expect(Object.keys(schema.properties).sort()).toEqual(zodKeys);
    const groupSchema = load("group.schema.json") as { properties: Record<string, unknown> };
    expect(Object.keys(groupSchema.properties).sort()).toEqual(Object.keys(GroupFileSchema.shape).sort());
  });

  test("accessory-only fields are described for editor hints", () => {
    const schema = load("deploy.schema.json") as any;
    expect(schema.properties.kind.description).toContain("accessory");
    expect(schema.properties.kind.enum).toEqual(["service", "accessory"]);
    expect(schema.properties.volumes.description).toContain("accessory");
    expect(schema.properties.healthcheck.properties.tcp.description).toContain("TCP");
  });
});
