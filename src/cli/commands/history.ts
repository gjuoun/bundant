import { Effect } from "effect";
import { Command } from "effect/cli";
import { history as runHistory } from "../../history.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";

export const history = Command.make("history", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const code = yield* runPromise(() => runHistory(loaded));
    yield* finish(code);
  }),
).pipe(Command.withDescription("revisions newest-first, with state and the current one"));
