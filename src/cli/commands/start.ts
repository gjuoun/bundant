import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { Accessory } from "../../accessory.ts";
import { NoMatchError } from "../../select/selector.ts";
import { UsageError } from "../../agent/errors.ts";
import { recordData } from "../../agent/emit.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, withFlatUnits } from "./flat-common.ts";

export const start = Command.make(
  "start",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const pattern = path._tag === "Some" ? path.value : undefined;
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      if (pattern === undefined) {
        if (loaded.config.kind !== "accessory") {
          throw new UsageError({ message: "start needs a unit path" });
        }
        const code = yield* runPromise(() =>
          new Accessory(loaded).run("boot", {
            yes: g.yes,
            volumes: g.volumes,
            tail: Number(g.tail),
            dryRun: g["dry-run"],
          }),
        );
        return yield* finish(code);
      }
      try {
        const started = yield* runPromise(() =>
          withFlatUnits(loaded, pattern, {}, async (ctx) => {
            const names: string[] = [];
            for (const unit of ctx.units) {
              for (const container of unit.containers) {
                await opsFor(ctx, container.host).startContainer(container.name);
                names.push(container.name);
              }
            }
            return names;
          }),
        );
        if (g.json) recordData({ started });
      } catch (error) {
        if (!(error instanceof NoMatchError) || loaded.config.kind !== "accessory") throw error;
        const code = yield* runPromise(() =>
          new Accessory(loaded).run("boot", {
            yes: g.yes,
            volumes: g.volumes,
            tail: Number(g.tail),
            dryRun: g["dry-run"],
          }),
        );
        return yield* finish(code);
      }
      yield* finish(0);
    }),
).pipe(Command.withDescription("start a unit (or create an accessory from -f)"));
