import { Effect } from "effect";
import { Command } from "effect/cli";
import { rollback as runRollback } from "../../rollback.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise, value } from "./common.ts";

export const rollback = Command.make("rollback", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const code = yield* runPromise(() =>
      runRollback(loaded, { toRevision: value(g["to-revision"]) }),
    );
    yield* finish(code);
  }),
).pipe(Command.withDescription("previous revision, or the one named by --to-revision"));
