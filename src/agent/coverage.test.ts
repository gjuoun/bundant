import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../cli/tree.ts";
import { ERROR_CODES } from "./errors.ts";

const repo = resolve(import.meta.dir, "../..");
const cwd = mkdtempSync(join(tmpdir(), "bundant-agent-coverage-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function topLevel(): string[] {
  return command.subcommands.flatMap((group) =>
    group.commands.map((entry) => String(entry.name)),
  );
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "BUNDANT_HOSTS") env[key] = value;
  }
  env.HOME = cwd;
  const proc = Bun.spawn(["bun", "run", join(repo, "src/cli.ts"), ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** One parseable object on stdout, command echoed, code from the catalog. */
function assertEnvelope(run: Run, label: string): Record<string, unknown> {
  const lines = run.stdout.split("\n");
  expect({ label, trailing: lines.at(-1) }).toEqual({ label, trailing: "" });
  const body = lines.slice(0, -1);
  expect({ label, lines: body.length }).toEqual({ label, lines: 1 });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body[0]!) as Record<string, unknown>;
  } catch {
    throw new Error(label + ": stdout is not JSON: " + JSON.stringify(run.stdout));
  }
  expect({ label, okType: typeof parsed.ok }).toEqual({ label, okType: "boolean" });
  if (parsed.ok === true) {
    expect({ label, data: "data" in parsed }).toEqual({ label, data: true });
  } else {
    const error = parsed.error as { code?: string } | undefined;
    expect({ label, code: error?.code }).toEqual({
      label,
      code: expect.stringMatching(new RegExp("^(" + ERROR_CODES.join("|") + ")$")),
    });
  }
  return parsed;
}

describe("agent surface coverage", () => {
  test("the tree matches --help and covers at least the 23 shipped commands", async () => {
    const names = topLevel();
    expect(names.length).toBeGreaterThanOrEqual(23);
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    const advertised = help.stdout
      .split("\n")
      .map((line) => /^  ([a-z][a-z-]+)\s{2,}/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(new Set(advertised)).toEqual(new Set(names));
  });

  test("every top-level command accepts --json and emits one object", async () => {
    for (const name of topLevel()) {
      const result = await run([name, "--json"]);
      const parsed = assertEnvelope(result, name);
      expect({ name, command: parsed.command }).toEqual({ name, command: name });
    }
  }, 60_000);

  test("nested actions share the same contract", async () => {
    for (const args of [["group", "status"], ["accessory", "status"], ["group", "rollback"]]) {
      const result = await run([...args, "--json"]);
      const parsed = assertEnvelope(result, args.join(" "));
      expect(parsed.command).toBe(args[0]!);
    }
  }, 20_000);

  test("errors --json exposes the catalog", async () => {
    const result = await run(["errors", "--json"]);
    const parsed = assertEnvelope(result, "errors");
    expect(parsed.ok).toBe(true);
    const data = parsed.data as { code: string; exitCode: number }[];
    expect(data.map((entry) => entry.code)).toEqual(ERROR_CODES);
  });
});
