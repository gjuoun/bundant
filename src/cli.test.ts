import { afterEach, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Command } from "effect/cli";
import { rootCommand } from "./cli/root.ts";
import { command } from "./cli/index.ts";

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

  test("validate accepts the example file", async () => {
    await run(["validate", "-f", "examples/hello/deploy.yml"]);
    expect(process.exitCode).toBe(0);
  });
});
