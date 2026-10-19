#!/usr/bin/env bun
/**
 * Generate the typed engine API surface from the archived official specs.
 *
 * Inputs (checked in under specs/, never re-cloned here):
 *   specs/docker-moby.swagger.yaml     Swagger 2.0, Docker Engine API 1.57
 *   specs/podman-v5.7.0.swagger.yaml   Swagger 2.0, Podman 5.7 (generated as
 *                                      described in the adapters design doc)
 *
 * Swagger 2.0 -> OpenAPI 3 (swagger2openapi) -> openapi-typescript, with a
 * curated allowlist so the checked-in file stays reviewable. JSDoc is stripped
 * from the generated text: the descriptions are huge and are not part of the
 * type contract. Shapes still come only from the official spec.
 *
 *   bun run api:gen           rewrite src/adapters/generated/*.d.ts
 *   bun run api:gen --check   fail when the checked-in files drift
 *
 * To refresh the Podman spec for a new tag (do this outside CI, never here):
 *   docker run --rm -v "$PWD/out:/out" -e PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin \
 *     golang:1.24-bookworm bash -c '
 *       git clone -q --depth 1 --branch v5.7.0 https://github.com/containers/podman /src
 *       cd /src && unset GOFLAGS && make -C test/tools build/swagger
 *       cd pkg/api && GOFLAGS=-mod=mod ../../test/tools/build/swagger \
 *         generate spec -x github.com/sigstore/rekor -x github.com/docker/docker/api/types/network \
 *         -o /out/swagger-v5.7.0.yaml -i tags.yaml -w ./ -m
 *     '
 * Then replace specs/podman-v5.7.0.swagger.yaml and adjust the allowlist.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_DIR = join(ROOT, "specs");
export const GENERATED_DIR = join(ROOT, "src", "adapters", "generated");

/** Path + methods we call. Anything absent here is not generated. */
export type Allowlist = Record<string, readonly ("get" | "post" | "delete" | "put" | "patch")[]>;

export const DOCKER_ALLOWLIST: Allowlist = {
  "/version": ["get"],
  "/containers/json": ["get"],
  "/containers/create": ["post"],
  "/containers/{id}/json": ["get"],
  "/containers/{id}/start": ["post"],
  "/containers/{id}/stop": ["post"],
  "/containers/{id}": ["delete"],
  "/containers/{id}/logs": ["get"],
  "/containers/{id}/stats": ["get"],
  "/containers/{id}/exec": ["post"],
  "/exec/{id}/start": ["post"],
  "/volumes/create": ["post"],
  "/volumes/{name}": ["get", "delete"],
  "/networks/create": ["post"],
  "/images/create": ["post"],
  "/images/load": ["post"],
  "/images/{name}": ["delete"],
  "/events": ["get"],
};

/**
 * Podman's compat paths spell the container/volume parameter {name} where
 * Docker says {id}; the libpod endpoints we need are allowlisted explicitly.
 */
export const PODMAN_ALLOWLIST: Allowlist = {
  "/version": ["get"],
  "/containers/json": ["get"],
  "/containers/create": ["post"],
  "/containers/{name}/json": ["get"],
  "/containers/{name}/start": ["post"],
  "/containers/{name}/stop": ["post"],
  "/containers/{name}": ["delete"],
  "/containers/{name}/logs": ["get"],
  "/containers/{name}/stats": ["get"],
  "/containers/{name}/exec": ["post"],
  "/exec/{id}/start": ["post"],
  "/volumes/create": ["post"],
  "/volumes/{name}": ["get", "delete"],
  "/networks/create": ["post"],
  "/images/create": ["post"],
  "/images/load": ["post"],
  "/images/{name}": ["delete"],
  "/events": ["get"],
  "/libpod/volumes/create": ["post"],
  "/libpod/volumes/{name}/json": ["get"],
  "/libpod/volumes/{name}": ["delete"],
  "/libpod/networks/create": ["post"],
};

interface OpenApiDocument {
  paths: Record<string, Record<string, unknown> & { parameters?: unknown }>;
  components?: Record<string, Record<string, Record<string, unknown>>>;
  [key: string]: unknown;
}

interface ConverterResult {
  openapi: OpenApiDocument;
}

interface Converter {
  convertObj(
    spec: unknown,
    options: { patch?: boolean; warnOnly?: boolean },
    callback: (err: unknown, result: ConverterResult) => void,
  ): void;
}

const REQUIRE = createRequire(import.meta.url);

function convertSpec(source: string): Promise<OpenApiDocument> {
  const converter = REQUIRE("swagger2openapi") as Converter;
  const swagger: unknown = parseYaml(source);
  return new Promise((resolve, reject) => {
    converter.convertObj(swagger, { patch: true, warnOnly: true }, (err, result) => {
      if (err !== null && err !== undefined) reject(err);
      else resolve(result.openapi);
    });
  });
}

const POINTER_PREFIX = "#/components/";

function refsIn(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) refsIn(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") out.add(ref);
  for (const value of Object.values(record)) refsIn(value, out);
  return out;
}

function componentKey(ref: string): { group: string; key: string } | null {
  if (!ref.startsWith(POINTER_PREFIX)) return null;
  const rest = ref.slice(POINTER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const decode = (text: string): string => text.replace(/~1/g, "/").replace(/~0/g, "~");
  return { group: decode(rest.slice(0, slash)), key: decode(rest.slice(slash + 1)) };
}

/** Keep only the allowlisted operations, then prune components to reachable refs. */
export function curate(document: OpenApiDocument, allow: Allowlist): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const [path, methods] of Object.entries(allow)) {
    const item = document.paths[path];
    if (item === undefined) throw new Error("allowlisted path missing from spec: " + path);
    const kept: Record<string, unknown> = {};
    for (const method of methods) {
      if (item[method] === undefined) throw new Error("allowlisted operation missing: " + method.toUpperCase() + " " + path);
      kept[method] = item[method];
    }
    paths[path] = kept;
  }

  const refs = refsIn(paths, new Set<string>());
  const components = document.components ?? {};
  let grew = true;
  while (grew) {
    grew = false;
    for (const ref of [...refs]) {
      const target = componentKey(ref);
      if (target === null) continue;
      const entry = components[target.group]?.[target.key];
      if (entry === undefined) continue;
      const before = refs.size;
      refsIn(entry, refs);
      if (refs.size !== before) grew = true;
    }
  }

  const pruned: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [group, entries] of Object.entries(components)) {
    const kept: Record<string, Record<string, unknown>> = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (refs.has(POINTER_PREFIX + group + "/" + key)) kept[key] = entry;
    }
    if (Object.keys(kept).length > 0) pruned[group] = kept;
  }

  return { ...document, paths, components: pruned };
}

/** Descriptions dominate the output; the type contract does not need them. */
export function stripDocComments(text: string): string {
  return text
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

const HEADER = (name: string, source: string): string =>
  "// Generated by scripts/api-gen.ts from " + source + " — do not edit.\n" +
  "// Run `bun run api:gen` after changing the allowlist or refreshing " + name + ".\n\n";

async function generate(specFile: string, allow: Allowlist, outputName: string, sourceLabel: string): Promise<string> {
  const source = readFileSync(join(SPEC_DIR, specFile), "utf8");
  const document = curate(await convertSpec(source), allow);
  // curate() only touches paths/components; the converter guarantees the rest.
  const ast = await openapiTS(document as unknown as OpenAPI3, { alphabetize: true });
  return HEADER(specFile, sourceLabel) + stripDocComments(astToString(ast));
}

export interface GeneratedFile {
  file: string;
  text: string;
}

/** The exact bytes that belong under src/adapters/generated/. */
export async function buildApiTypes(): Promise<GeneratedFile[]> {
  const docker = await generate(
    "docker-moby.swagger.yaml",
    DOCKER_ALLOWLIST,
    "docker-api.d.ts",
    "specs/docker-moby.swagger.yaml (Docker Engine API 1.57)",
  );
  const podman = await generate(
    "podman-v5.7.0.swagger.yaml",
    PODMAN_ALLOWLIST,
    "podman-api.d.ts",
    "specs/podman-v5.7.0.swagger.yaml (Podman 5.7.0)",
  );
  return [
    { file: "docker-api.d.ts", text: docker },
    { file: "podman-api.d.ts", text: podman },
  ];
}

export async function writeApiTypes(): Promise<string[]> {
  mkdirSync(GENERATED_DIR, { recursive: true });
  const written: string[] = [];
  for (const generated of await buildApiTypes()) {
    writeFileSync(join(GENERATED_DIR, generated.file), generated.text);
    written.push("src/adapters/generated/" + generated.file);
  }
  return written;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    const { readFileSync: read } = await import("node:fs");
    const drift: string[] = [];
    for (const generated of await buildApiTypes()) {
      let current = "";
      try {
        current = read(join(GENERATED_DIR, generated.file), "utf8");
      } catch {
        current = "";
      }
      if (current !== generated.text) drift.push(generated.file);
    }
    if (drift.length > 0) {
      console.error("generated API types are stale: " + drift.join(", "));
      console.error("run: bun run api:gen");
      process.exit(1);
    }
    console.log("generated API types are current");
  } else {
    for (const file of await writeApiTypes()) console.log("wrote " + file);
  }
}
