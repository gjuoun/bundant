import { Effect } from "effect";
import { Command } from "effect/cli";
import { prune as runPrune } from "../../prune.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise } from "./common.ts";

export const prune = Command.make("prune", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const keep = Number(g.keep);
    if (!Number.isInteger(keep) || keep < 0) {
      console.error("bundant: --keep must be a non-negative integer");
      return yield* finish(2);
    }
    const loaded = yield* runPromise(async () => loadedFor(g));
    const via = opsVia(g.via);
    if (via === null) return yield* finish(2);
    const code = yield* runPromise(() =>
      runPrune(loaded, { keep, dryRun: g["dry-run"], via }),
    );
    yield* finish(code);
  }),
).pipe(Command.withDescription("remove stopped revisions beyond the newest K (--keep, default 3)"));
