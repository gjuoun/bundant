import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { Accessory } from "../../accessory.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise, value } from "./common.ts";
import { opsFor, withFlatUnits } from "./flat-common.ts";

export const restart = Command.make(
  "restart",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const pattern = path._tag === "Some" ? path.value : undefined;
      if (pattern === undefined) {
        console.error("bundant: restart needs a unit path");
        return yield* finish(2);
      }
      const loaded = yield* runPromise(async () => loadedFor(g));
      if (loaded.config.kind === "accessory") {
        const code = yield* runPromise(() =>
          new Accessory(loaded).run("reboot", {
            yes: g.yes,
            volumes: g.volumes,
            tail: Number(g.tail),
            dryRun: g["dry-run"],
            via,
          }),
        );
        return yield* finish(code);
      }
      yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, {
          replica: g.replica === undefined ? undefined : Number(g.replica),
          revision: value(g["to-revision"]),
          allRevisions: g["all-revisions"],
        }, async (ctx) => {
          for (const unit of ctx.units) {
            for (const container of unit.containers) {
              const ops = opsFor(ctx, container.host);
              await ops.stopContainers([container.name]);
              await ops.startContainer(container.name);
            }
          }
        }),
      );
      yield* finish(0);
    }),
).pipe(Command.withDescription("restart a unit (accessory: recreate; service: stop/start)"));
