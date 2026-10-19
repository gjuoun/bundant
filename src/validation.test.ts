import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GROUP,
  GroupFileSchema,
  RawConfigSchema,
  zodIssues,
  type BundantConfig,
  type LoadedConfig,
} from "./config.ts";
import {
  DEFAULT_GROUP as GRAMMAR_DEFAULT,
  GROUP_NAME_RE,
  REVISION_RE,
  roundTrips,
} from "./name-grammar.ts";
import { buildDeployPlan } from "./planner.ts";
import { deploy } from "./deploy.ts";
import {
  PreflightError,
  assertPreflight,
  validatePath,
  validateRevision,
} from "./validation.ts";

const SERVICE_RULE =
  "must match [a-z0-9]+(-[a-z0-9]+)* (lowercase segments separated by single hyphens; no leading/trailing/double hyphen)";
const SEGMENT_RULE =
  "must match [a-z0-9]+ (lowercase letters and digits only; hyphens are reserved as separators)";

function deployDoc(over: Record<string, unknown> = {}) {
  return { service: "hello", image: "x:1", ...over };
}

function groupDoc(over: Record<string, unknown> = {}) {
  return {
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
    { label: "ApiVersion", schema: "deploy", doc: deployDoc({ service: "ApiVersion" }), field: "service", message: 'service "ApiVersion" ' + SERVICE_RULE },
    { label: "API", schema: "deploy", doc: deployDoc({ service: "API" }), field: "service", message: 'service "API" ' + SERVICE_RULE },
    { label: "b_c", schema: "deploy", doc: deployDoc({ service: "b_c" }), field: "service", message: 'service "b_c" ' + SERVICE_RULE },
    { label: "b.c", schema: "deploy", doc: deployDoc({ service: "b.c" }), field: "service", message: 'service "b.c" ' + SERVICE_RULE },
    { label: "-lead", schema: "deploy", doc: deployDoc({ service: "-lead" }), field: "service", message: 'service "-lead" ' + SERVICE_RULE },
    { label: "trail-", schema: "deploy", doc: deployDoc({ service: "trail-" }), field: "service", message: 'service "trail-" ' + SERVICE_RULE },
    { label: "a--b", schema: "deploy", doc: deployDoc({ service: "a--b" }), field: "service", message: 'service "a--b" ' + SERVICE_RULE },
    { label: "group a-b", schema: "group", doc: groupDoc({ group: "a-b" }), field: "group", message: 'group "a-b" ' + SEGMENT_RULE },
    { label: "group Alpha", schema: "group", doc: groupDoc({ group: "Alpha" }), field: "group", message: 'group "Alpha" ' + SEGMENT_RULE },
    { label: "role with hyphen", schema: "deploy", doc: deployDoc({ role: "web-api" }), field: "role", message: 'role "web-api" ' + SEGMENT_RULE },
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
      message: 'revision "rev-abc" ' + SEGMENT_RULE,
    });
  });

  test("valid controls pass: my-service, web, default, r9x2k", () => {
    expect(RawConfigSchema.safeParse(deployDoc({ service: "my-service", role: "web" })).success).toBe(true);
    expect(GROUP_NAME_RE.test(DEFAULT_GROUP)).toBe(true);
    expect(REVISION_RE.test("r9x2k")).toBe(true);
    expect(validateRevision("r9x2k")).toBeNull();
    expect(roundTrips({ group: DEFAULT_GROUP, service: "my-service", role: "web", revision: "r9x2k" })).toBe(true);
  });

  test("ambiguous pair: group a-b/service c is rejected; group a/service b-c round-trips", () => {
    const bad = GroupFileSchema.safeParse(groupDoc({
      group: "a-b",
      services: [{ name: "c", file: "./c/deploy.yml" }],
    }));
    expect(bad.success).toBe(false);

    const good = GroupFileSchema.safeParse(groupDoc({
      group: "a",
      services: [{ name: "b-c", file: "./bc/deploy.yml" }],
    }));
    expect(good.success).toBe(true);
    expect(roundTrips({ group: "a", service: "b-c", role: "web", revision: "r0" })).toBe(true);
  });
});

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
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
  return { config, envContent: null, envCount: 0, path: "/tmp/deploy.yml" };
}

describe("preflight gate", () => {
  test("an invalid config produces zero executor calls", async () => {
    const config = cfg({ role: "Web_Api" });
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
    writeFileSync(file, ["service: Bad_Name", "image: x:1", "hosts: [box.test]"].join("\n"));
    const report = await validatePath(file);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.field === "service" && e.message.includes('"Bad_Name"'))).toBe(true);
  });

  test("a group with a hyphen is rejected", async () => {
    const file = join(dir, "group.yml");
    writeFileSync(file, ["group: a-b", "services:", "  - name: c", "    file: ./c.yml"].join("\n"));
    const report = await validatePath(file);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.field === "group")).toBe(true);
  });
});
