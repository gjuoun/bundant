#!/usr/bin/env bun
/**
 * Generate the JSON Schemas that editors use for autocomplete + inline errors.
 *
 * The zod schemas in src/config.ts stay the single source of truth; this script
 * only projects them to draft-07 so `# yaml-language-server: $schema=...` works.
 * `bun run schema:gen` rewrites schema/*.json; src/schema.test.ts fails when the
 * checked-in files drift from the code.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RawConfigSchema, GroupFileSchema } from "../src/config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(ROOT, "schema");

const DRAFT = "http://json-schema.org/draft-07/schema#";

/** Inline `$ref`s so each schema file stands alone (no resolver in the editor). */
function inline(defs: Record<string, any>, root: any): any {
  const seen = new Set<string>();
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const key = node.$ref.split("/").pop() as string;
      if (defs[key] && !seen.has(key)) {
        seen.add(key);
        return walk(structuredClone(defs[key]));
      }
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    return out;
  };
  return walk(root);
}

export function project(schema: any, name: string, title: string, description: string) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: "none", target: "jsonSchema7" }) as any;
  const defs = json.definitions ?? {};
  const body = inline(defs, defs[name] ?? json);
  return {
    $schema: DRAFT,
    $id: `https://bundant.dev/schema/${name}.json`,
    title,
    description,
    ...body,
  };
}

/** The exact bytes that belong in schema/*.json, keyed by filename. */
export function buildSchemas(): Record<string, string> {
  const files = {
    "deploy.schema.json": project(
      RawConfigSchema,
      "DeployFile",
      "bundant deploy.yml / accessory.yml",
      "One file per service (kind: accessory = stateful member: stable name, named volumes, only touched by `bundant accessory`).",
    ),
    "group.schema.json": project(
      GroupFileSchema,
      "GroupFile",
      "bundant group.yml",
      "A group is a namespace: members in install order plus explicit needs. The install order is the topological sort; a cycle is an error.",
    ),
  };
  return Object.fromEntries(
    Object.entries(files).map(([file, content]) => [file, JSON.stringify(content, null, 2) + "\n"]),
  );
}

export function writeSchemas(): string[] {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const written: string[] = [];
  for (const [file, text] of Object.entries(buildSchemas())) {
    writeFileSync(join(SCHEMA_DIR, file), text);
    written.push(`schema/${file}`);
  }
  return written;
}

if (import.meta.main) {
  for (const f of writeSchemas()) console.log(`wrote ${f}`);
}
