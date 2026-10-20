import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { UsageError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, resolutionOptions, selectorFor, withFlatUnits } from "./flat-common.ts";

export const logs = Command.make(
  "logs",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const tail = Number(g.tail);
      if (!Number.isInteger(tail) || tail <= 0) {
        throw new UsageError({ message: "--tail must be a positive integer" });
      }
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
            withFlatUnits(loaded, pattern, resolutionOptions(g), async (ctx) => {
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
      const entries: { host: string; container: string; lines: string[] }[] = [];
      yield* runPromise(() =>
        withFlatUnits(loaded, pattern, resolutionOptions(g), async (ctx) => {
          for (const unit of ctx.units) {
            for (const container of unit.containers) {
              const text = await opsFor(ctx, container.host).logs(container.name, tail);
              const lines = text.split("\n").filter((line) => line !== "");
              entries.push({ host: container.host, container: container.name, lines });
              if (!g.json) {
                for (const line of lines) console.log(container.name + " | " + line);
              }
            }
          }
        }),
      );
      yield* finish(0, entries);
    }),
).pipe(Command.withDescription("logs by path, each line prefixed with the replica"));
