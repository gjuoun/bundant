import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { renderInspect } from "../../monitor-render.ts";
import { recordData } from "../../agent/emit.ts";
import { NotFoundError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, opsVia, runPromise } from "./common.ts";
import { flatLoadedFor, resolutionOptions, selectorFor, withFlatUnits } from "./flat-common.ts";

export const inspect = Command.make(
  "inspect",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const pattern = selectorFor(g, loaded, path._tag === "Some" ? path.value : undefined);
      const first = yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, resolutionOptions(g), async (ctx) => {
          const unit = ctx.units[0];
          return unit?.containers.find((c) => c.state === "running") ?? unit?.containers[0];
        }),
      );
      if (first === undefined) {
        throw new NotFoundError({ message: "inspect found no running container" });
      }
      const monitor = yield* runPromise(() => monitorFor(loaded));
      try {
        const rows = yield* runPromise(() => monitor.inspect(first.name));
        if (g.json) recordData(rows);
        else console.log(renderInspect(rows));
        yield* finish(0);
      } finally {
        yield* runPromise(() => monitor.close());
      }
    }),
).pipe(Command.withDescription("inspect the first running replica matched by the path"));
