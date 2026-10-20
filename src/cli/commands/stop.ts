import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, opsVia, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, resolutionOptions, withFlatUnits } from "./flat-common.ts";

export const stop = Command.make(
  "stop",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const pattern = path._tag === "Some" ? path.value : undefined;
      if (pattern === undefined) {
        console.error("bundant: stop needs a unit path");
        return yield* finish(2);
      }
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, resolutionOptions(g), async (ctx) => {
          for (const unit of ctx.units) {
            for (const container of unit.containers) {
              await opsFor(ctx, container.host).stopContainers([container.name]);
            }
          }
        }),
      );
      yield* finish(0);
    }),
).pipe(Command.withDescription("stop every replica matched by the path"));
