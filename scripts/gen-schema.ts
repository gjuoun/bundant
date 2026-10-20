#!/usr/bin/env bun
/**
 * Generate the versioned JSON Schemas that editors use for autocomplete and
 * inline errors. Every registered config version gets its own directory; the
 * root files remain stable aliases for the current version.
 *
 * The zod modules in src/config/v<version>/ are the source of truth. This
 * script only projects them to draft-07. src/schema.test.ts fails on drift.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import { defaultRegistry } from "../src/config.ts";
import type { VersionModule } from "../src/config/registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(ROOT, "schema");

const DRAFT = "http://json-schema.org/draft-07/schema#";

/** Inline $refs so each schema file stands alone (no resolver in the editor). */
function inline(defs: Record<string, unknown>, root: unknown): unknown {
  const seen = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const key = obj.$ref.split("/").pop() as string;
      if (defs[key] && !seen.has(key)) {
        seen.add(key);
        return walk(structuredClone(defs[key]));
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    return out;
  };
  return walk(root);
}

export function project(
  schema: z.ZodTypeAny,
  name: string,
  title: string,
  description: string,
  id: string,
): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    name,
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  const defs = (json.definitions ?? {}) as Record<string, unknown>;
  const body = inline(defs, defs[name] ?? json) as Record<string, unknown>;
  return {
    $schema: DRAFT,
    $id: id,
    title,
    description,
    ...body,
  };
}

/** The exact bytes for one version, keyed by path relative to schema/. */
export function buildVersionSchemas(module: VersionModule): Record<string, string> {
  const base = "v" + module.version;
  const id = (kind: string) => "https://bundant.dev/schema/" + base + "/" + kind + ".schema.json";
  const files: Record<string, Record<string, unknown>> = {
    [base + "/deploy.schema.json"]: project(
      module.deploySchema,
      "DeployFile",
      "bundant deploy.yml (v" + module.version + ")",
      "One file per service. Version " + module.version + " pins this schema, its grammar and its defaults.",
      id("deploy"),
    ),
    [base + "/accessory.schema.json"]: project(
      module.accessorySchema,
      "AccessoryFile",
      "bundant accessory.yml (v" + module.version + ")",
      "Stateful member: stable name, named volumes, proxy disabled. Version " + module.version + ".",
      id("accessory"),
    ),
    [base + "/group.schema.json"]: project(
      module.groupSchema,
      "GroupFile",
      "bundant group.yml (v" + module.version + ")",
      "A namespace: members in install order plus explicit needs. Version " + module.version + ".",
      id("group"),
    ),
  };
  return Object.fromEntries(
    Object.entries(files).map(([file, content]) => [file, JSON.stringify(content, null, 2) + "\n"]),
  );
}

/** Every generated file, versioned plus the stable root aliases. */
export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const module of defaultRegistry.all()) {
    Object.assign(out, buildVersionSchemas(module));
  }
  const current = "v" + defaultRegistry.supported().at(-1)!;
  out["deploy.schema.json"] = out[current + "/deploy.schema.json"]!;
  out["group.schema.json"] = out[current + "/group.schema.json"]!;
  return out;
}

export function writeSchemas(): string[] {
  const written: string[] = [];
  for (const [file, text] of Object.entries(buildSchemas())) {
    const absolute = join(SCHEMA_DIR, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
    written.push("schema/" + file);
  }
  return written;
}

if (import.meta.main) {
  for (const f of writeSchemas()) console.log("wrote " + f);
}
