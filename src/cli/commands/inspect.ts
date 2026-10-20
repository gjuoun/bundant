import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { renderInspect } from "../../monitor-render.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise } from "./common.ts";
import { selectorFor, withFlatUnits } from "./flat-common.ts";

export const inspect = Command.make(
  "inspect",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => loadedFor(g));
      const pattern = selectorFor(g, loaded, path._tag === "Some" ? path.value : undefined);
      const first = yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, {
          replica: g.replica._tag === "Some" ? Number(g.replica.value) : undefined,
        }, async (ctx) => {
          const unit = ctx.units[0];
          return unit?.containers.find((c) => c.state === "running") ?? unit?.containers[0];
        }),
      );
      if (first === undefined) {
        console.error("bundant: inspect found no running container");
        return yield* finish(1);
      }
      const monitor = yield* runPromise(() => monitorFor(loaded));
      try {
        const rows = yield* runPromise(() => monitor.inspect(first.name));
        console.log(renderInspect(rows));
        yield* finish(0);
      } finally {
        yield* runPromise(() => monitor.close());
      }
    }),
).pipe(Command.withDescription("inspect the first running replica matched by the path"));
