import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { rootCommand } from "../root.ts";
import { finish, opsVia, runPromise } from "./common.ts";
import { flatLoadedFor, resolutionOptions, selectorFor, withFlatUnits } from "./flat-common.ts";

export const exec = Command.make(
  "exec",
  {
    path: Argument.String("path").pipe(Argument.optional),
    argv: Argument.String("cmd").pipe(Argument.variadic({ min: 0 })),
  },
  ({ path, argv }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const pattern = selectorFor(g, loaded, path._tag === "Some" ? path.value : undefined);
      const containers = yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, resolutionOptions(g), async (ctx) => {
          const all = ctx.units.flatMap((unit) => unit.containers);
          const running = all.filter((c) => c.state === "running");
          const pool = running.length > 0 ? running : all;
          return g.all ? pool : pool.slice(0, 1);
        }),
      );
      if (containers.length === 0) {
        console.error("bundant: exec found no container");
        return yield* finish(1);
      }
      const monitor = yield* runPromise(() => monitorFor(loaded));
      try {
        for (const container of containers) {
          const code = yield* runPromise(() =>
            monitor.execShell(container.host, container.name, [...argv]),
          );
          if (code !== 0) return yield* finish(code);
        }
        yield* finish(0);
      } finally {
        yield* runPromise(() => monitor.close());
      }
    }),
).pipe(Command.withDescription("exec in the first running replica (--all for every replica)"));
