import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { UsageError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, resolutionOptions, withFlatUnits } from "./flat-common.ts";

export const stop = Command.make(
  "stop",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const pattern = path._tag === "Some" ? path.value : undefined;
      if (pattern === undefined) {
        throw new UsageError({ message: "stop needs a unit path" });
      }
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const stopped = yield* runPromise(() =>
        withFlatUnits(loaded, pattern, resolutionOptions(g), async (ctx) => {
          const names: string[] = [];
          for (const unit of ctx.units) {
            for (const container of unit.containers) {
              await opsFor(ctx, container.host).stopContainers([container.name]);
              names.push(container.name);
            }
          }
          return names;
        }),
      );
      yield* finish(0, { stopped });
    }),
).pipe(Command.withDescription("stop every replica matched by the path"));
