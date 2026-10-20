import { Effect } from "effect";
import { Command } from "effect/cli";
import { Accessory } from "../../accessory.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise, value } from "./common.ts";

type Action = "boot" | "reboot" | "stop" | "logs" | "status" | "remove";
export const ACCESSORY_DEFAULT_ACTION: Action = "status";
export const ACCESSORY_ALIASES: Record<Action, string> = {
  boot: "start",
  reboot: "restart",
  stop: "stop",
  logs: "logs",
  status: "status",
  remove: "rm",
};
const DEPRECATED = "deprecated: use bundant start/stop/restart/logs/status/rm";

function runAction(action: Action) {
  return Effect.gen(function* () {
    console.error(DEPRECATED);
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g, "accessory.yml"));
    const tail = Number(g.tail);
    if (!Number.isInteger(tail) || tail <= 0) {
      console.error("bundant: --tail must be a positive integer");
      return yield* finish(2);
    }
    const via = opsVia(g.via);
    if (via === null) return yield* finish(2);
    const code = yield* runPromise(() =>
      new Accessory(loaded).run(action, {
        yes: g.yes,
        volumes: g.volumes,
        tail,
        dryRun: g["dry-run"],
        via,
      }),
    );
    yield* finish(code);
  });
}

function actionCommand(action: Action) {
  return Command.make(action, {}, () => runAction(action));
}

export const accessory = Command.make("accessory", {}, () =>
  runAction(ACCESSORY_DEFAULT_ACTION),
).pipe(
  Command.withDescription("stateful member lifecycle: boot, reboot, stop, logs, status, remove"),
  Command.withSubcommands([
    actionCommand("boot"),
    actionCommand("reboot"),
    actionCommand("stop"),
    actionCommand("logs"),
    actionCommand("status"),
    actionCommand("remove"),
  ]),
);
