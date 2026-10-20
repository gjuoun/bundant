import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ApiDriftError,
  ConfigError,
  ConfigVersionError,
  EngineUnavailableError,
  HealthError,
  LockError,
  NoMatchError,
  NotFoundError,
  ProxyError,
  TransportError,
  UnknownError,
  UsageError,
  ValidationError,
  codeFor,
  errorCatalog,
  exitCodeFor,
} from "./errors.ts";

const repo = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "bundant-agent-exit-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; json: any; stdout: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "BUNDANT_HOSTS") env[key] = value;
  }
  env.HOME = root;
  const proc = Bun.spawn(["bun", "run", join(repo, "src/cli.ts"), ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = stdout.trimEnd().split("\n");
  expect(lines.length).toBe(1);
  return { code, json: JSON.parse(lines[0]!), stdout };
}

function fixture(name: string, lines: string[]): string {
  const path = join(root, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("exit status contract", () => {
  test("usage failures exit 4", async () => {
    const result = await cli(["scale", "--json"]);
    expect(result.code).toBe(4);
    expect(result.json.error.code).toBe("USAGE");
  });

  test("bad YAML exits 1 with CONFIG_INVALID", async () => {
    const file = fixture("broken.yml", ["version: 1", "service: [unclosed"]);
    const result = await cli(["deploy", "-f", file, "--json"]);
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe("CONFIG_INVALID");
  });

  test("an unsupported version exits 1 with CONFIG_VERSION_UNSUPPORTED", async () => {
    const file = fixture("v99.yml", [
      "version: 99",
      "service: smoke",
      "image: alpine",
      "hosts: [box.test]",
      "proxy: { enabled: false }",
    ]);
    const result = await cli(["deploy", "-f", file, "--json"]);
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe("CONFIG_VERSION_UNSUPPORTED");
  });

  test("a preflight rejection exits 1 with VALIDATION_FAILED", async () => {
    const dir = join(root, "cycle");
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    const member = (name: string): string[] => [
      "version: 1",
      "service: " + name,
      "image: alpine",
      "hosts: [box.test]",
      "proxy: { enabled: false }",
    ];
    writeFileSync(join(dir, "a", "deploy.yml"), member("a").join("\n") + "\n");
    writeFileSync(join(dir, "b", "deploy.yml"), member("b").join("\n") + "\n");
    const manifest = join(dir, "group.yml");
    writeFileSync(
      manifest,
      [
        "version: 1",
        "group: smoke",
        "services:",
        "  - name: a",
        "    file: ./a/deploy.yml",
        "    needs: [b]",
        "  - name: b",
        "    file: ./b/deploy.yml",
        "    needs: [a]",
      ].join("\n") + "\n",
    );
    const result = await cli(["group", "-f", manifest, "--json"]);
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe("VALIDATION_FAILED");
  });

  test("every catalog code maps from its tagged failure", () => {
    const cases = [
      [new UsageError({ message: "x" }), "USAGE", 4],
      [new ConfigError({ message: "x" }), "CONFIG_INVALID", 1],
      [new ConfigVersionError({ message: "x" }), "CONFIG_VERSION_UNSUPPORTED", 1],
      [new ValidationError({ message: "x" }), "VALIDATION_FAILED", 1],
      [new NoMatchError({ message: "x" }), "NO_MATCH", 3],
      [new LockError({ message: "x" }), "LOCK_HELD", 2],
      [new EngineUnavailableError({ message: "x" }), "ENGINE_UNAVAILABLE", 1],
      [new ApiDriftError({ message: "x" }), "API_DRIFT", 1],
      [new HealthError({ message: "x" }), "HEALTH_TIMEOUT", 1],
      [new ProxyError({ message: "x" }), "PROXY_SWAP_FAILED", 1],
      [new TransportError({ message: "x" }), "TRANSPORT_ERROR", 1],
      [new NotFoundError({ message: "x" }), "NOT_FOUND", 1],
      [new UnknownError({ message: "x" }), "INTERNAL", 1],
    ] as const;
    expect(cases.length as number).toBe(errorCatalog().length - 1);
    for (const [error, code, exit] of cases) {
      expect(codeFor(error)).toBe(code);
      expect(exitCodeFor(error)).toBe(exit);
    }
  });
});
