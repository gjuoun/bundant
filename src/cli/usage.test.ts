import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { command } from "./tree.ts";
import { parseOnlyTree, usageFailure, usageMessage } from "./usage.ts";

const VERSION = "0.0.0";

describe("usage preflight", () => {
  test("unknown flag is a one-line usage message", async () => {
    expect(await usageFailure(command, ["deploy", "--bogus"], VERSION)).toBe(
      "Unrecognized flag: --bogus in command bundant deploy",
    );
  });

  test("unknown subcommand is a one-line usage message", async () => {
    expect(await usageFailure(command, ["bogus"], VERSION)).toBe(
      'Unknown subcommand "bogus" for "bundant"',
    );
    expect(await usageFailure(command, ["group", "bogus"], VERSION)).toBe(
      'Unknown subcommand "bogus" for "bundant group"',
    );
  });

  test("a missing flag value is a usage message", async () => {
    expect(await usageFailure(command, ["deploy", "--file"], VERSION)).toBe(
      "Missing value for flag --file. Expected: string",
    );
  });

  test("a bad choice value is a usage message", async () => {
    const message = await usageFailure(command, ["deploy", "--completions", "bogus"], VERSION);
    expect(message).toContain('Invalid value for flag --completions: "bogus"');
  });

  test("a missing required argument is caught generically", async () => {
    const needs = Command.make(
      "needs",
      { value: Argument.String("value") },
      () => Effect.void,
    );
    const tree = Command.make("bundant").pipe(Command.withSubcommands([needs]));
    const message = await usageFailure(tree, ["needs"], VERSION);
    expect(message).toContain("Missing required argument");
  });

  test("--help and valid commands pass without writing anything", async () => {
    const lines: unknown[] = [];
    const writes: unknown[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWrite = process.stdout.write;
    console.log = (...args: unknown[]) => lines.push(args);
    console.error = (...args: unknown[]) => lines.push(args);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await usageFailure(command, ["--help"], VERSION)).toBeNull();
      expect(await usageFailure(command, ["deploy", "--help"], VERSION)).toBeNull();
      expect(await usageFailure(command, ["errors", "--json"], VERSION)).toBeNull();
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalWrite;
    }
    expect(lines).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("parseOnlyTree never executes the real handler", async () => {
    let ran = false;
    const probe = Command.make("probe", {}, () =>
      Effect.sync(() => {
        ran = true;
      }),
    );
    const tree = Command.make("bundant").pipe(Command.withSubcommands([probe]));
    expect(await usageFailure(tree, ["probe"], VERSION)).toBeNull();
    expect(ran).toBe(false);
    expect(parseOnlyTree(tree)).toBeDefined();
  });

  test("usageMessage ignores non-parse errors", () => {
    expect(usageMessage(new Error("boom"))).toBeNull();
    expect(usageMessage({ _tag: "ShowHelp", errors: [] })).toBeNull();
  });
});
