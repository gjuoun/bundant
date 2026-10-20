import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { Accessory } from "../../accessory.ts";
import { UsageError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, resolutionOptions, withFlatUnits } from "./flat-common.ts";

export const restart = Command.make(
  "restart",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const pattern = path._tag === "Some" ? path.value : undefined;
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      if (pattern === undefined && loaded.config.kind !== "accessory") {
        throw new UsageError({ message: "restart needs a unit path" });
      }
      if (loaded.config.kind === "accessory") {
        const code = yield* runPromise(() =>
          new Accessory(loaded).run("reboot", {
            yes: g.yes,
            volumes: g.volumes,
            tail: Number(g.tail),
            dryRun: g["dry-run"],
          }),
        );
        return yield* finish(code);
      }
      const restarted = yield* runPromise(() =>
        withFlatUnits(loaded, pattern!, resolutionOptions(g), async (ctx) => {
          const names: string[] = [];
          for (const unit of ctx.units) {
            for (const container of unit.containers) {
              const ops = opsFor(ctx, container.host);
              await ops.stopContainers([container.name]);
              await ops.startContainer(container.name);
              names.push(container.name);
            }
          }
          return names;
        }),
      );
      yield* finish(0, { restarted });
    }),
).pipe(Command.withDescription("restart a unit (accessory: recreate; service: stop/start)"));
