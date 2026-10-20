import { Effect } from "effect";
import { Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { runRead } from "./read-common.ts";

export const events = Command.make("events", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    yield* finish(yield* runRead(g, loaded, "events"));
  }),
).pipe(Command.withDescription("runtime events since a duration (default 2h)"));
