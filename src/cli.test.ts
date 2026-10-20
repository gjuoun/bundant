import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Argument, Command } from "effect/cli";
import { rootCommand } from "./cli/root.ts";
import { command } from "./cli/index.ts";
import { LockError } from "./effect/errors.ts";
import { runMain } from "./effect/runtime.ts";
import { findCaseCollision } from "./deploy.ts";
import { ACCESSORY_DEFAULT_ACTION } from "./cli/commands/accessory.ts";
import { GROUP_DEFAULT_ACTION } from "./cli/commands/group.ts";

const TestLayer = Layer.mergeAll(
  Stdio.layerTest({}),
  Path.layer,
  FileSystem.layerNoop({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

function run(args: ReadonlyArray<string>, app = command): Promise<void> {
  return Effect.runPromise(
    Command.runWith(app, { version: "0.0.0", renderErrors: false })(args).pipe(
      Effect.provide(TestLayer),
    ),
  );
}

afterEach(() => {
  process.exitCode = 0;
});

describe("effect/cli parsing", () => {
  test("global defaults are unchanged", async () => {
    let seen = "";
    const probe = Command.make("probe", {}, () =>
      Effect.gen(function* () {
        const g = yield* rootCommand;
        seen = [g.keep, g.tail, g.since, g.port, g.via, g["dry-run"], g.follow].join("|");
      }),
    );
    const app = rootCommand.pipe(Command.withSubcommands([probe]));
    await run(["probe"], app);
    expect(seen).toBe("3|200|2h|8787|api|false|false");
  });

  test("-f alias and long flag both parse", async () => {
    const files: string[] = [];
    const probe = Command.make("probe", {}, () =>
      Effect.gen(function* () {
        const g = yield* rootCommand;
        if (g.file._tag === "Some") files.push(g.file.value);
      }),
    );
    const app = rootCommand.pipe(Command.withSubcommands([probe]));
    await run(["probe", "-f", "one.yml"], app);
    await run(["probe", "--file", "two.yml"], app);
    expect(files).toEqual(["one.yml", "two.yml"]);
  });

  test("deploy on an accessory refuses with today's message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-cli-"));
    const file = join(dir, "accessory.yml");
    writeFileSync(
      file,
      [
        "kind: accessory",
        "service: db",
        "image: postgres:16",
        "hosts: [box.test]",
        "proxy: { enabled: false }",
      ].join("\n"),
    );
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await run(["deploy", "-f", file]);
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(2);
    expect(lines[0]).toContain("is an accessory — use `bundant accessory boot`");
  });

  test("scale on an accessory refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-cli-"));
    const file = join(dir, "accessory.yml");
    writeFileSync(
      file,
      [
        "kind: accessory",
        "service: db2",
        "image: postgres:16",
        "hosts: [box.test]",
        "proxy: { enabled: false }",
      ].join("\n"),
    );
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await run(["scale", "-f", file, "--replicas", "2"]);
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(2);
    expect(lines[0]).toContain("is an accessory — a stateful member is one of one");
  });

  test("lock contention maps to exit 2", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const code = await runMain(Effect.fail(new LockError({ message: "lock held" })));
      expect(code).toBe(2);
    } finally {
      console.error = original;
    }
  });

  test("case-only duplicates fail with the case-collision message", () => {
    const collision = findCaseCollision(
      ["Shop.Api-Web-r1"],
      ["shop.Api-Web-r1"],
    );
    expect(collision).toBe(
      "Shop.Api-Web-r1 and shop.Api-Web-r1 both resolve to shop.api-web-r1",
    );
  });

  test("group defaults to install and accessory defaults to status", () => {
    expect(GROUP_DEFAULT_ACTION).toBe("install");
    expect(ACCESSORY_DEFAULT_ACTION).toBe("status");
  });

  test("an invalid accessory action is a parse error", async () => {
    await expect(run(["accessory", "bogus"])).rejects.toBeDefined();
  });

  test("-- passthrough keeps --version for the remote command", async () => {
    let captured: ReadonlyArray<string> = [];
    const probe = Command.make(
      "execprobe",
      { argv: Argument.String("cmd").pipe(Argument.variadic({ min: 0 })) },
      ({ argv }) =>
        Effect.sync(() => {
          captured = argv;
        }),
    );
    const app = rootCommand.pipe(Command.withSubcommands([probe]));
    await run(["execprobe", "--container", "c", "--", "sh", "--version"], app);
    expect(captured).toEqual(["sh", "--version"]);
  });

  test("the command inventory is complete", () => {
    const names = command.subcommands.flatMap((group) =>
      group.commands.map((entry) => String(entry.name)),
    );
    for (const name of [
      "validate", "deploy", "scale", "rollback", "history", "status", "delete", "prune",
      "bootstrap", "runtime", "ps", "stats", "inspect", "logs", "events", "exec", "ui",
      "group", "accessory",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("validate accepts the example file", async () => {
    await run(["validate", "-f", "examples/hello/deploy.yml"]);
    expect(process.exitCode).toBe(0);
  });
});
