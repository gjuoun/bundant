#!/usr/bin/env bun
/**
 * Generate schema/errors.json from the error catalog. The catalog in
 * src/agent/errors.ts is the source of truth; this script only projects it to
 * a draft-07 schema so a client can validate envelopes and codes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CATALOG, ERROR_CODES, errorCatalog } from "../src/agent/errors.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_PATH = join(ROOT, "schema/errors.json");

export function buildErrorsSchema(): string {
  const catalog = errorCatalog();
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://bundant.dev/schema/errors.json",
    title: "bundant agent surface",
    description:
      "The one JSON object bundant writes to stdout with --json, plus the stable error catalog.",
    oneOf: [
      {
        type: "object",
        required: ["ok", "command", "data"],
        properties: {
          ok: { const: true },
          command: { type: "string" },
          data: {},
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["ok", "command", "error"],
        properties: {
          ok: { const: false },
          command: { type: "string" },
          error: { $ref: "#/definitions/error" },
        },
        additionalProperties: false,
      },
    ],
    definitions: {
      errorCode: { enum: ERROR_CODES },
      error: {
        type: "object",
        required: ["code", "message", "details"],
        properties: {
          code: { $ref: "#/definitions/errorCode" },
          message: { type: "string" },
          details: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
      catalogEntry: {
        type: "object",
        required: ["code", "exitCode", "when"],
        properties: {
          code: { $ref: "#/definitions/errorCode" },
          exitCode: { enum: [...new Set(Object.values(ERROR_CATALOG).map((entry) => entry.exitCode))] },
          when: { type: "string" },
        },
        additionalProperties: false,
      },
      catalog: {
        type: "array",
        items: { $ref: "#/definitions/catalogEntry" },
      },
    },
    "x-bundant-exit-codes": Object.fromEntries(
      catalog.map((entry) => [entry.code, entry.exitCode]),
    ),
  };
  return JSON.stringify(schema, null, 2) + "\n";
}

export function writeErrorsSchema(): string {
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  writeFileSync(SCHEMA_PATH, buildErrorsSchema());
  return "schema/errors.json";
}

if (import.meta.main) console.log("wrote " + writeErrorsSchema());
