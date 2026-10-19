import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import { SCHEMA_DIR, buildSchemas } from "../scripts/gen-schema.ts";
import { defaultRegistry } from "./config.ts";

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
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => (e.instancePath || "/") + " " + e.message);
}

function walk(dir: string, hit: (path: string) => void) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, hit);
    else hit(full);
  }
}

describe("published JSON Schemas", () => {
  test("checked-in schema files match every registered version", () => {
    for (const [file, expected] of Object.entries(buildSchemas())) {
      const actual = readFileSync(join(SCHEMA_DIR, file), "utf8");
      expect(actual, file + " is stale — run: bun run schema:gen").toBe(expected);
    }
  });

  test("every version has deploy/accessory/group schemas", () => {
    for (const module of defaultRegistry.all()) {
      for (const kind of ["deploy", "accessory", "group"]) {
        const loaded = load("v" + module.version + "/" + kind + ".schema.json");
        expect(loaded.$id).toContain("/v" + module.version + "/" + kind + ".schema.json");
      }
    }
  });

  test("every version pins its integer version field", () => {
    for (const module of defaultRegistry.all()) {
      const deploy = load("v" + module.version + "/deploy.schema.json");
      const group = load("v" + module.version + "/group.schema.json");
      expect(deploy.properties.version.const).toBe(module.version);
      expect(group.properties.version.const).toBe(module.version);
    }
  });

  test("every example deploy.yml/accessory.yml validates against v1", () => {
    const files: string[] = [];
    walk(join(ROOT, "examples"), (p) => {
      if (/\.ya?ml$/.test(p) && !p.endsWith("group.yml")) files.push(p);
    });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = parseYaml(readFileSync(file, "utf8"));
      expect(errorsFor("v1/deploy.schema.json", doc), file).toEqual([]);
    }
  });

  test("every example group.yml validates against v1", () => {
    const files: string[] = [];
    walk(join(ROOT, "examples"), (p) => {
      if (p.endsWith("group.yml")) files.push(p);
    });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = parseYaml(readFileSync(file, "utf8"));
      expect(errorsFor("v1/group.schema.json", doc), file).toEqual([]);
    }
  });

  test("the schema rejects what zod rejects (negative control)", () => {
    const badName = { service: "API_Service", image: "x" };
    expect(errorsFor("v1/deploy.schema.json", badName).join(" ")).toContain("pattern");
    const typo = { service: "api", image: "x", healthchek: { path: "/" } };
    expect(errorsFor("v1/deploy.schema.json", typo).join(" ")).toContain("additional properties");
    const missingFile = { group: "shop", services: [{ name: "api" }] };
    expect(errorsFor("v1/group.schema.json", missingFile).join(" ")).toContain("required property 'file'");
    const groupTypo = { group: "shop", services: [{ name: "api", file: "./api/deploy.yml" }], servicez: [] };
    expect(errorsFor("v1/group.schema.json", groupTypo).join(" ")).toContain("additional properties");
    const wrongVersion = { version: 2, service: "api", image: "x" };
    expect(errorsFor("v1/deploy.schema.json", wrongVersion).join(" ")).toContain("must be equal to constant");
  });

  test("each version's schema mirrors its zod field set exactly", () => {
    for (const module of defaultRegistry.all()) {
      const deploy = load("v" + module.version + "/deploy.schema.json") as {
        properties: Record<string, unknown>;
      };
      const deployShape = (module.deploySchema as unknown as {
        innerType(): { shape: Record<string, unknown> };
      }).innerType().shape;
      expect(Object.keys(deploy.properties).sort()).toEqual(Object.keys(deployShape).sort());

      const group = load("v" + module.version + "/group.schema.json") as {
        properties: Record<string, unknown>;
      };
      const groupShape = (module.groupSchema as unknown as {
        innerType(): { shape: Record<string, unknown> };
      }).innerType().shape;
      expect(Object.keys(group.properties).sort()).toEqual(Object.keys(groupShape).sort());
    }
  });

  test("accessory-only fields are described for editor hints", () => {
    const schema = load("v1/deploy.schema.json") as {
      properties: {
        kind: { description: string; enum: string[] };
        volumes: { description: string };
        healthcheck: { properties: { tcp: { description: string } } };
      };
    };
    expect(schema.properties.kind.description).toContain("accessory");
    expect(schema.properties.kind.enum).toEqual(["service", "accessory"]);
    expect(schema.properties.volumes.description).toContain("accessory");
    expect(schema.properties.healthcheck.properties.tcp.description).toContain("TCP");
  });
});
