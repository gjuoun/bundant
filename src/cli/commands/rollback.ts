import { Effect } from "effect";
import { Command } from "effect/cli";
import { rollback as runRollback } from "../../rollback.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise, value } from "./common.ts";

export const rollback = Command.make("rollback", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const via = opsVia(g.via);
    if (via === null) return yield* finish(2);
    const code = yield* runPromise(() =>
      runRollback(loaded, { toRevision: value(g["to-revision"]), via }),
    );
    yield* finish(code);
  }),
).pipe(Command.withDescription("previous revision, or the one named by --to-revision"));
