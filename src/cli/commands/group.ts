import { Effect } from "effect";
import { Command } from "effect/cli";
import { loadGroup } from "../../config.ts";
import { GroupRunner } from "../../group.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise, value } from "./common.ts";

type Action = "install" | "uninstall" | "status" | "rollback";
export const GROUP_DEFAULT_ACTION: Action = "install";
export const GROUP_STATUS_ALIAS = "status '<group>.**'";

function actionCommand(action: Action) {
  return Command.make(action, {}, () =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const loadedGroup = yield* runPromise(async () =>
        loadGroup(value(g.file) ?? "group.yml"),
      );
      const runner = new GroupRunner(loadedGroup);
      if (action === "status") {
        yield* finish(yield* runPromise(() => runner.status()));
        return;
      }
      const opts = {
        dryRun: g["dry-run"],
        yes: g.yes,
        toRevision: value(g["to-revision"]),
        rev: value(g.rev),
      };
      const code =
        action === "install"
          ? yield* runPromise(() => runner.install(opts))
          : action === "uninstall"
            ? yield* runPromise(() => runner.uninstall(opts))
            : yield* runPromise(() => runner.rollback(opts));
      yield* finish(code);
    }),
  );
}

export const group = Command.make("group", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loadedGroup = yield* runPromise(async () =>
      loadGroup(value(g.file) ?? "group.yml"),
    );
    const runner = new GroupRunner(loadedGroup);
    const code = yield* runPromise(() =>
      runner.install({
        dryRun: g["dry-run"],
        yes: g.yes,
        rev: value(g.rev),
      }),
    );
    yield* finish(code);
  }),
).pipe(
  Command.withDescription("namespace lifecycle: install, uninstall, status, rollback"),
  Command.withSubcommands([
    actionCommand("install"),
    actionCommand("uninstall"),
    actionCommand("status"),
    actionCommand("rollback"),
  ]),
);
