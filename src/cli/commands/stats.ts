import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { renderStats } from "../../monitor-render.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";
import { selectorFor, withFlatUnits } from "./flat-common.ts";
import { opsVia } from "./common.ts";

export const stats = Command.make(
  "stats",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => loadedFor(g));
      const pattern = selectorFor(g, loaded, path._tag === "Some" ? path.value : undefined);
      const names = yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, {}, async (ctx) =>
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
        console.log(renderStats(filtered));
        yield* finish(0);
      } finally {
        yield* runPromise(() => monitor.close());
      }
    }),
).pipe(Command.withDescription("one resource snapshot for the matched units"));
