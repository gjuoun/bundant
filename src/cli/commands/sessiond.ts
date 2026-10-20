import { Effect } from "effect";
import { Command } from "effect/cli";
import type { LoadedConfig } from "../../config.ts";
import { resolveConnections } from "../../hosts.ts";
import { openOps } from "../../ops/index.ts";
import { runtimeFor } from "../../runtime.ts";
import { recordData } from "../../agent/emit.ts";
import { rootCommand } from "../root.ts";
import { finish, runPromise, value } from "./common.ts";
import { flatLoadedFor } from "./flat-common.ts";
import { installOnHost, removeOnHost } from "../../sessiond/install.ts";
import { renderStatus, statusOnHost } from "../../sessiond/status.ts";
import type { SessiondHostStatus } from "../../sessiond/plan.ts";

type Action = "install" | "status" | "remove";

async function eachHost<T>(
  loaded: LoadedConfig,
  run: (host: string, ops: Awaited<ReturnType<typeof openOps>>) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const connection of resolveConnections(loaded.config)) {
    const ops = await openOps(connection, loaded.config);
    try {
      results.push(await run(connection.sshTarget, ops));
    } finally {
      await ops.close();
    }
  }
  return results;
}

function statusEffect() {
  return Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => flatLoadedFor(g));
    const statuses: SessiondHostStatus[] = yield* runPromise(() =>
      eachHost(loaded, (host, ops) => statusOnHost(host, ops)),
    );
    if (g.json) recordData({ hosts: statuses });
    else for (const status of statuses) console.log(renderStatus(status));
    yield* finish(0);
  });
}

function actionCommand(action: Action) {
  if (action === "status") return Command.make("status", {}, statusEffect);
  return Command.make(action, {}, () =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const loaded = yield* runPromise(async () => flatLoadedFor(g));
      const rt = runtimeFor(loaded.config.runtime);
      const from = value(g.from);
      const image = value(g.image);

      if (action === "remove") {
        const removed = yield* runPromise(() =>
          eachHost(loaded, (host, ops) => removeOnHost(host, ops)),
        );
        if (g.json) recordData({ hosts: removed });
        else {
          for (const entry of removed) {
            console.log(
              "[" + entry.host + "] sessiond " + (entry.removed ? "removed" : "not installed"),
            );
          }
        }
        yield* finish(0);
        return;
      }

      const installed = yield* runPromise(() =>
        eachHost(loaded, (host, ops) =>
          installOnHost({
            host,
            ops,
            rt,
            allowEmulation: g["allow-emulation"],
            ...(image !== undefined ? { image } : {}),
            ...(from !== undefined ? { from } : {}),
          }),
        ),
      );
      if (g.json) recordData({ hosts: installed });
      else {
        for (const entry of installed) {
          console.log(
            "[" + entry.host + "] sessiond installed " + entry.image + " (" + entry.arch +
              (entry.emulated ? ", emulated" : "") + ")",
          );
        }
      }
      yield* finish(0);
    }),
  );
}

export const sessiond = Command.make("sessiond", {}, statusEffect).pipe(
  Command.withDescription("host-side session observer: install, status, remove"),
  Command.withSubcommands([
    actionCommand("install"),
    actionCommand("status"),
    actionCommand("remove"),
  ]),
);
