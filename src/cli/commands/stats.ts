import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { renderStats } from "../../monitor-render.ts";
import { recordData } from "../../agent/emit.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { flatLoadedFor, resolutionOptions, selectorFor, withFlatUnits } from "./flat-common.ts";

export const stats = Command.make(
  "stats",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const pattern = selectorFor(g, loaded, path._tag === "Some" ? path.value : undefined);
      const names = yield* runPromise(() =>
        withFlatUnits(loaded, pattern, resolutionOptions(g), async (ctx) =>
          ctx.units.flatMap((unit) => unit.containers.map((c) => c.name)),
        ),
      );
      const monitor = yield* runPromise(() => monitorFor(loaded));
      try {
        const all = yield* runPromise(() => monitor.stats());
        const filtered = all.map((host) => ({
          ...host,
          rows: host.rows.filter((row) => names.includes(row.name)),
        }));
        if (g.json) recordData(filtered);
        else console.log(renderStats(filtered));
        yield* finish(0);
      } finally {
        yield* runPromise(() => monitor.close());
      }
    }),
).pipe(Command.withDescription("one resource snapshot for the matched units"));
