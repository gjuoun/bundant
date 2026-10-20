import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { runRead } from "./read-common.ts";

export const inspect = Command.make(
  "inspect",
  { selector: Argument.String("selector").pipe(Argument.optional) },
  ({ selector }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const loaded = yield* runPromise(async () => loadedFor(g));
      const value = Option.isSome(selector) ? selector.value : undefined;
      yield* finish(yield* runRead(g, loaded, "inspect", value));
    }),
).pipe(Command.withDescription("state, restarts, health, image, restart policy"));
