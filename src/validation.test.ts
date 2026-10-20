import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GROUP,
  GroupFileSchema,
  IDENTIFIER_RULE,
  RawConfigSchema,
  zodIssues,
  type BundantConfig,
  type LoadedConfig,
} from "./config.ts";
import { IDENTIFIER_RE, REVISION_RE } from "./config/v2/grammar.ts";
import { buildDeployPlan } from "./planner.ts";
import { deploy } from "./deploy.ts";
import {
  PreflightError,
  assertPreflight,
  validatePath,
  validateRevision,
} from "./validation.ts";

const doc = (over: Record<string, unknown> = {}) => ({
  version: 2,
  service: "hello",
  image: "x:1",
  ...over,
});

function groupDoc(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    group: "shop",
    services: [{ name: "api", file: "./api/deploy.yml" }],
    ...over,
  };
}

describe("name grammar matrix", () => {
  const cases: Array<{
    label: string;
    schema: "deploy" | "group";
    doc: Record<string, unknown>;
    field: string;
    message: string;
  }> = [
    { label: "dot in service", schema: "deploy", doc: doc({ service: "b.c" }), field: "service", message: 'service "b.c" ' + IDENTIFIER_RULE },
    { label: "leading hyphen", schema: "deploy", doc: doc({ service: "-lead" }), field: "service", message: 'service "-lead" ' + IDENTIFIER_RULE },
    { label: "trailing hyphen", schema: "deploy", doc: doc({ service: "trail-" }), field: "service", message: 'service "trail-" ' + IDENTIFIER_RULE },
    { label: "double hyphen", schema: "deploy", doc: doc({ service: "a--b" }), field: "service", message: 'service "a--b" ' + IDENTIFIER_RULE },
    { label: "space in service", schema: "deploy", doc: doc({ service: "a b" }), field: "service", message: 'service "a b" ' + IDENTIFIER_RULE },
    { label: "group with dot", schema: "group", doc: groupDoc({ group: "a.b" }), field: "group", message: 'group "a.b" ' + IDENTIFIER_RULE },
    { label: "role with dot", schema: "deploy", doc: doc({ role: "web.api" }), field: "role", message: 'role "web.api" ' + IDENTIFIER_RULE },
  ];

  for (const c of cases) {
    test('rejects ' + c.label + " with the exact message", () => {
      const schema = c.schema === "deploy" ? RawConfigSchema : GroupFileSchema;
      const parsed = schema.safeParse(c.doc);
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const found = zodIssues(parsed.error).find((i) => i.field === c.field);
      expect(found?.message).toBe(c.message);
    });
  }

  test("rejects a revision with a hyphen", () => {
    expect(validateRevision("rev-abc")).toEqual({
      field: "revision",
      message: 'revision "rev-abc" ' + IDENTIFIER_RULE,
    });
  });

  test("valid controls pass: kebab-case, camelCase, snake_case and UPPERCASE", () => {
    expect(RawConfigSchema.safeParse(doc({ service: "my-service", role: "web" })).success).toBe(true);
    expect(RawConfigSchema.safeParse(doc({ service: "camelCase", role: "Web" })).success).toBe(true);
    expect(RawConfigSchema.safeParse(doc({ service: "snake_case", role: "web_api" })).success).toBe(true);
    expect(RawConfigSchema.safeParse(doc({ service: "SHOP", role: "WEB" })).success).toBe(true);
    expect(IDENTIFIER_RE.test(DEFAULT_GROUP)).toBe(true);
    expect(REVISION_RE.test("r9x2k")).toBe(true);
    expect(validateRevision("r9x2k")).toBeNull();
  });

  test("group and service may both use hyphens without ambiguity", () => {
    const parsed = GroupFileSchema.safeParse(groupDoc({
      group: "a-b",
      services: [{ name: "c-d", file: "./c/deploy.yml" }],
    }));
    expect(parsed.success).toBe(true);
  });
});

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    version: 2,
    service: "hello",
    image: "traefik/whoami:v1.10",
    role: "web",
    replicas: 1,
    kind: "service",
    group: DEFAULT_GROUP,
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: true, host: "hello.test", port: 80, tls: false, image: "kamal-proxy" },
    ...over,
  };
}

function loadedFor(config: BundantConfig): LoadedConfig {
  return { config, envContent: null, envCount: 0, path: "/tmp/deploy.yml", version: 2 };
}

describe("preflight gate", () => {
  test("an invalid config produces zero executor calls", async () => {
    const config = cfg({ role: "Web.Api" });
    const loaded = loadedFor(config);
    const plan = buildDeployPlan(config, "r0");
    let calls = 0;
    await expect(
      deploy(plan, loaded, {
        openPrimary: () => {
          calls++;
          throw new Error("executor must not be opened");
        },
      }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(calls).toBe(0);
    expect(() => assertPreflight(loaded)).toThrow(PreflightError);
  });

  test("accessory proxy/replicas are preflight errors", () => {
    const accessory = cfg({
      kind: "accessory",
      proxy: { enabled: true, port: 80, tls: false, image: "x" },
    });
    expect(() => assertPreflight(loadedFor(accessory))).toThrow(/proxy is not allowed/);
  });
});

describe("validatePath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundant-val-"));
  });

  test("accepts examples/hello, examples/shop and examples/replicas", async () => {
    for (const path of ["examples/hello/deploy.yml", "examples/shop/group.yml", "examples/replicas/deploy.yml"]) {
      const report = await validatePath(join(import.meta.dir, "..", path));
      expect(report.ok, path + " " + JSON.stringify(report.errors)).toBe(true);
      expect(report.identity).toBeDefined();
    }
  });

  test("a broken deploy returns listed errors with the exact field", async () => {
    const file = join(dir, "deploy.yml");
    writeFileSync(file, ["version: 2", "service: Bad@Name", "image: x:1", "hosts: [box.test]"].join("\n"));
    const report = await validatePath(file);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.field === "service" && e.message.includes('"Bad@Name"'))).toBe(true);
  });

  test("a group with a dot is rejected", async () => {
    const file = join(dir, "group.yml");
    writeFileSync(file, ["version: 2", "group: a.b", "services:", "  - name: c", "    file: ./c.yml"].join("\n"));
    const report = await validatePath(file);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.field === "group")).toBe(true);
  });
});
