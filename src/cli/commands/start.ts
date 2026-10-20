import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { Accessory } from "../../accessory.ts";
import { NoMatchError } from "../../select/selector.ts";
import { rootCommand } from "../root.ts";
import { finish, opsVia, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, withFlatUnits } from "./flat-common.ts";

export const start = Command.make(
  "start",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const pattern = path._tag === "Some" ? path.value : undefined;
      if (pattern === undefined) {
        console.error("bundant: start needs a unit path");
        return yield* finish(2);
      }
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      try {
        yield* runPromise(() =>
          withFlatUnits(loaded, via, pattern, {}, async (ctx) => {
            for (const unit of ctx.units) {
              for (const container of unit.containers) {
                await opsFor(ctx, container.host).startContainer(container.name);
              }
            }
          }),
        );
      } catch (error) {
        if (!(error instanceof NoMatchError) || loaded.config.kind !== "accessory") throw error;
        const code = yield* runPromise(() =>
          new Accessory(loaded).run("boot", {
            yes: g.yes,
            volumes: g.volumes,
            tail: Number(g.tail),
            dryRun: g["dry-run"],
            via,
          }),
        );
        return yield* finish(code);
      }
      yield* finish(0);
    }),
).pipe(Command.withDescription("start a unit (or create an accessory from -f)"));
