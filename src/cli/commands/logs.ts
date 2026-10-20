import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { rootCommand } from "../root.ts";
import { finish, opsVia, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, resolutionOptions, selectorFor, withFlatUnits } from "./flat-common.ts";

export const logs = Command.make(
  "logs",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const tail = Number(g.tail);
      if (!Number.isInteger(tail) || tail <= 0) {
        console.error("bundant: --tail must be a positive integer");
        return yield* finish(2);
      }
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const pattern = selectorFor(g, loaded, path._tag === "Some" ? path.value : undefined);
      if (g.follow) {
        const monitor = yield* runPromise(() => monitorFor(loaded));
        const onSignal = (): void => {
          void monitor.close().finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        try {
          const code = yield* runPromise(() =>
            withFlatUnits(loaded, via, pattern, resolutionOptions(g), async (ctx) => {
              const first = ctx.units[0]?.containers[0];
              if (first === undefined) return 1;
              return await monitor.followLogs({
                host: first.host,
                container: first.name,
                tail,
              });
            }),
          );
          yield* finish(code);
        } finally {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          yield* runPromise(() => monitor.close());
        }
        return;
      }
      yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, resolutionOptions(g), async (ctx) => {
          for (const unit of ctx.units) {
            for (const container of unit.containers) {
              const text = await opsFor(ctx, container.host).logs(container.name, tail);
              for (const line of text.split("\n")) {
                if (line === "") continue;
                console.log(container.name + " | " + line);
              }
            }
          }
        }),
      );
      yield* finish(0);
    }),
).pipe(Command.withDescription("logs by path, each line prefixed with the replica"));
