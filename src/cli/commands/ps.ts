import { Effect } from "effect";
import { Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { runRead } from "./read-common.ts";

export const ps = Command.make("ps", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    yield* finish(yield* runRead(g, loaded, "ps"));
  }),
).pipe(Command.withDescription("every container on every host, with state and ports"));
