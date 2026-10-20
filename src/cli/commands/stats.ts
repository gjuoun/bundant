import { Effect } from "effect";
import { Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { runRead } from "./read-common.ts";

export const stats = Command.make("stats", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    yield* finish(yield* runRead(g, loaded, "stats"));
  }),
).pipe(Command.withDescription("one resource snapshot per host (cpu / mem / pids)"));
