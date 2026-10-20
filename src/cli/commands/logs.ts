import { Effect } from "effect";
import { Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { runFollow, runRead } from "./read-common.ts";

export const logs = Command.make("logs", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const tail = Number(g.tail);
    if (!Number.isInteger(tail) || tail <= 0) {
      console.error("bundant: --tail must be a positive integer");
      return yield* finish(2);
    }
    const loaded = yield* runPromise(async () => loadedFor(g));
    if (g.follow) {
      yield* finish(yield* runFollow(loaded, g, tail));
      return;
    }
    yield* finish(yield* runRead(g, loaded, "logs"));
  }),
).pipe(Command.withDescription("tail logs (all hosts in parallel; --follow streams them)"));
