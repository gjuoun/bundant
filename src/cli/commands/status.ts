import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { statusRows } from "../../status-rows.ts";
import { recordData } from "../../agent/emit.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise } from "./common.ts";
import { flatLoadedFor, resolutionOptions, selectorFor, withFlatUnits } from "./flat-common.ts";

export const status = Command.make(
  "status",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const pattern = selectorFor(
        g,
        loaded,
        path._tag === "Some" ? path.value : undefined,
      );
      const units = yield* runPromise(() =>
        withFlatUnits(loaded, pattern, resolutionOptions(g), async (ctx) =>
          statusRows(ctx.units, loaded.config),
        ),
      );
      if (g.json) {
        recordData(units);
      } else {
        for (const unit of units) {
          console.log(
            unit.path + " rev=" + unit.revision + " live=" + unit.live + "/" + unit.expected +
              (unit.emulated === true ? " (emulated)" : "") +
              " [" + unit.containers.join(", ") + "]",
          );
        }
      }
      yield* finish(0);
    }),
).pipe(Command.withDescription("unit status by path (no path = every unit; --json for scripts)"));
