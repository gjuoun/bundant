import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { recordData } from "../../agent/emit.ts";
import { UsageError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, opsVia, runPromise } from "./common.ts";
import { flatLoadedFor, opsFor, resolutionOptions, withFlatUnits } from "./flat-common.ts";
import type { RuntimeOps } from "../../ops/index.ts";

function envPath(path: string, kind: "service" | "accessory"): string {
  const parts = path.split(".");
  const group = parts[0]!;
  if (kind === "accessory") return "~/.bundant/env/" + group + "/" + parts[1] + ".env";
  return "~/.bundant/env/" + group + "/" + parts[1] + "-" + parts[2] + ".env";
}

async function removeRoute(ops: RuntimeOps, path: string): Promise<void> {
  await ops.proxyRemove(path);
  const legacy = path.replaceAll(".", "-");
  if (legacy !== path) await ops.proxyRemove(legacy);
}

export const rm = Command.make(
  "rm",
  { path: Argument.String("path").pipe(Argument.optional) },
  ({ path }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const pattern = path._tag === "Some" ? path.value : undefined;
      if (pattern === undefined) {
        throw new UsageError({ message: "rm needs a unit path" });
      }
      if (!g.yes && !g["dry-run"]) {
        throw new UsageError({ message: "rm is destructive: pass --yes (or --dry-run to preview)" });
      }
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const removed: string[] = [];
      yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, resolutionOptions(g), async (ctx) => {
          if (!g.json) {
            console.log("resolved " + ctx.units.length + " unit(s):");
            for (const unit of ctx.units) {
              console.log(
                "  " + unit.path + " rev=" + unit.revision + " -> " +
                  unit.containers.map((c) => c.name).join(", "),
              );
            }
          }
          if (g["dry-run"]) return;
          for (const unit of ctx.units) {
            const host = unit.containers[0]?.host;
            if (host === undefined) continue;
            const ops = opsFor(ctx, host);
            if (g.route) await removeRoute(ops, unit.path);
            if (g.env) await ops.removeEnv(envPath(unit.path, unit.kind));
            const images = [...new Set(unit.containers.map((c) => c.image))];
            for (const container of unit.containers) {
              await ops.removeContainer(container.name, { force: true });
              removed.push(container.name);
            }
            if (g.images) {
              for (const image of images) {
                if (image !== "") await ops.removeImage(image);
              }
            }
            if (unit.kind === "accessory" && g.volumes) {
              for (const volume of loaded.config.volumes ?? []) {
                const name = volume.split(":")[0]!.trim();
                if (name === "") continue;
                const owner = unit.path.replaceAll(".", "/");
                const found = await ops.inspectVolume(name);
                const got = found.labels["bundant.owner"] ?? "";
                if (got !== "" && got !== owner) {
                  console.log("  volume " + name + " belongs to " + got + " - left alone");
                  continue;
                }
                await ops.removeVolume(name);
                console.log("  removed volume " + name);
              }
            }
          }
        }),
      );
      yield* finish(0, { units: removed });
    }),
).pipe(Command.withDescription("remove matched units (containers; --route/--env/--images/--volumes)"));
