import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Option, Path, Stdio, Terminal } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Argument, Command } from "effect/cli";
import { rootCommand } from "./cli/root.ts";
import { command } from "./cli/tree.ts";
import { LockError } from "./effect/errors.ts";
import { runMain } from "./effect/runtime.ts";
import { findCaseCollision } from "./deploy.ts";
import { ACCESSORY_ALIASES, ACCESSORY_DEFAULT_ACTION } from "./cli/commands/accessory.ts";
import { GROUP_DEFAULT_ACTION, GROUP_STATUS_ALIAS } from "./cli/commands/group.ts";
import { flatLoadedFor, resolutionOptions, selectorFor } from "./cli/commands/flat-common.ts";
import { loadConfig } from "./config.ts";

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
        seen = [
          g.keep,
          g.tail,
          g.since,
          g.port,
          g.via,
          g["dry-run"],
          g.follow,
          g["all-revisions"],
          g.route,
          g.env,
          g.pull,
          g.timings,
        ].join("|");
      }),
    );
    const app = rootCommand.pipe(Command.withSubcommands([probe]));
    await run(["probe"], app);
    expect(seen).toBe("3|200|2h|8787|api|false|false|false|false|false|missing|false");
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
    await expect(run(["deploy", "-f", file])).rejects.toThrow(
      "is an accessory - use `bundant accessory boot`",
    );
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
    await expect(run(["scale", "-f", file, "--replicas", "2"])).rejects.toThrow(
      "is an accessory - a stateful member is one of one",
    );
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
      [
        {
          name: "default.ShopApi.web.r1",
          labels: { "bundant.group": "default", "bundant.service": "ShopApi" },
        },
      ],
      { group: "default", service: "shopapi" },
    );
    expect(collision).toBe(
      "default/ShopApi and default/shopapi both resolve to default/shopapi",
    );
  });

  test("group defaults to install and accessory defaults to status", () => {
    expect(GROUP_DEFAULT_ACTION).toBe("install");
    expect(ACCESSORY_DEFAULT_ACTION).toBe("status");
    expect(GROUP_STATUS_ALIAS).toBe("status '<group>.**'");
    expect(ACCESSORY_ALIASES).toEqual({
      boot: "start",
      reboot: "restart",
      stop: "stop",
      logs: "logs",
      status: "status",
      remove: "rm",
    });
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
      "validate", "start", "stop", "restart", "rm",
      "deploy", "scale", "rollback", "history", "status", "delete", "prune",
      "bootstrap", "runtime", "ps", "stats", "inspect", "logs", "events", "exec", "ui",
      "group", "accessory",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("flat verbs take hosts from --hosts or BUNDANT_HOSTS, never deploy.yml", () => {
    delete process.env.BUNDANT_HOSTS;
    expect(
      flatLoadedFor({ file: Option.none(), hosts: Option.some("root@a,root@b") }).config.hosts,
    ).toEqual(["root@a", "root@b"]);
    process.env.BUNDANT_HOSTS = "root@c";
    try {
      expect(flatLoadedFor({ file: Option.none(), hosts: Option.none() }).config.hosts).toEqual([
        "root@c",
      ]);
    } finally {
      delete process.env.BUNDANT_HOSTS;
    }
    expect(() => flatLoadedFor({ file: Option.none(), hosts: Option.none() })).toThrow(
      /no hosts: pass -f <config>, --hosts <a,b> or set BUNDANT_HOSTS/,
    );
  });

  test("every flat verb shares one resolution option mapping", () => {
    const g = {
      replica: Option.none<string>(),
      revision: Option.none<string>(),
      "all-revisions": false,
    };
    const verbs = ["status", "stop", "restart", "rm"].map(() => resolutionOptions(g));
    expect(new Set(verbs.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(verbs[0]).toEqual({ replica: undefined, revision: undefined, allRevisions: false });
    expect(
      resolutionOptions({
        replica: Option.some("2"),
        revision: Option.some("r1"),
        "all-revisions": true,
      }),
    ).toEqual({ replica: 2, revision: "r1", allRevisions: true });
  });

  test("status with no path means every unit; -f filters to its unit", () => {
    const loaded = loadConfig("examples/hello/deploy.yml");
    expect(selectorFor({ file: Option.none() }, loaded, undefined)).toBe("*");
    expect(selectorFor({ file: Option.some("examples/hello/deploy.yml") }, loaded, undefined)).toBe(
      "default.hello.web",
    );
    expect(selectorFor({ file: Option.some("x") }, loaded, "shop.**")).toBe("shop.**");
  });

  test("validate accepts the example file", async () => {
    await run(["validate", "-f", "examples/hello/deploy.yml"]);
    expect(process.exitCode).toBe(0);
  });
});
