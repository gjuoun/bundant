import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { ServiceIdentity } from "../../domain/identity.ts";
import { unitPath } from "../../select/selector.ts";
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
          ctx.units.map((unit) => {
            const live = unit.containers.filter((c) => c.state === "running").length;
            const emulated = unit.containers.some((c) => c.emulated === true);
            const identity = ServiceIdentity.from(loaded.config);
            const configPath = unitPath({
              group: identity.group,
              service: identity.service,
              role: identity.role,
              kind: identity.kind,
            });
            const expected =
              unit.path === configPath ? identity.replicas : unit.containers.length;
            return {
              path: unit.path,
              kind: unit.kind,
              revision: unit.revision,
              expected,
              live,
              containers: unit.containers.map((c) => c.name),
              ...(emulated ? { emulated: true } : {}),
            };
          }),
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
