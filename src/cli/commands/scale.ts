import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { scale as runScale } from "../../scale.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise, value } from "./common.ts";

export const scale = Command.make(
  "scale",
  { positional: Argument.String("replicas").pipe(Argument.optional) },
  ({ positional }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const raw = value(g.replicas) ?? (Option.isSome(positional) ? positional.value : undefined);
      if (raw === undefined) {
        console.error("bundant: scale needs --replicas <n>");
        return yield* finish(2);
      }
      const replicas = Number(raw);
      if (!Number.isInteger(replicas) || replicas < 1) {
        console.error("bundant: --replicas must be an integer >= 1");
        return yield* finish(2);
      }
      const loaded = yield* runPromise(async () => loadedFor(g));
      if (loaded.config.kind === "accessory") {
        console.error(
          "bundant: " + loaded.config.service +
            " is an accessory - a stateful member is one of one",
        );
        return yield* finish(2);
      }
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const code = yield* runPromise(() =>
        runScale(loaded, { replicas, dryRun: g["dry-run"], via }),
      );
      yield* finish(code);
    }),
).pipe(Command.withDescription("add/remove replicas of the running revision (no drops)"));
