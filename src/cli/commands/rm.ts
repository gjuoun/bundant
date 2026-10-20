import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise, value } from "./common.ts";
import { opsFor, withFlatUnits } from "./flat-common.ts";
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
        console.error("bundant: rm needs a unit path");
        return yield* finish(2);
      }
      if (!g.yes && !g["dry-run"]) {
        console.error("bundant: rm is destructive: pass --yes (or --dry-run to preview)");
        return yield* finish(2);
      }
      const via = opsVia(g.via);
      if (via === null) return yield* finish(2);
      const loaded = yield* runPromise(async () => loadedFor(g));
      yield* runPromise(() =>
        withFlatUnits(loaded, via, pattern, {
          replica: value(g.replica) === undefined ? undefined : Number(value(g.replica)),
          revision: value(g.revision) ?? value(g["to-revision"]),
          allRevisions: g["all-revisions"],
        }, async (ctx) => {
          console.log("resolved " + ctx.units.length + " unit(s):");
          for (const unit of ctx.units) {
            console.log(
              "  " + unit.path + " rev=" + unit.revision + " -> " +
                unit.containers.map((c) => c.name).join(", "),
            );
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
                  console.log("  volume " + name + " belongs to " + got + " — left alone");
                  continue;
                }
                await ops.removeVolume(name);
                console.log("  removed volume " + name);
              }
            }
          }
        }),
      );
      yield* finish(0);
    }),
).pipe(Command.withDescription("remove matched units (containers; --route/--env/--images/--volumes)"));
