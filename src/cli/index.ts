import { Effect } from "effect";
import { Command } from "effect/cli";
import { cliVersion } from "../version.ts";
import { runMain } from "../effect/runtime.ts";
import { toAppError, type AppError } from "../effect/errors.ts";
import { rootCommand } from "./root.ts";
import { CliLayer } from "./layer.ts";
import { validate } from "./commands/validate.ts";
import { start } from "./commands/start.ts";
import { stop } from "./commands/stop.ts";
import { restart } from "./commands/restart.ts";
import { rm } from "./commands/rm.ts";
import { deploy } from "./commands/deploy.ts";
import { rollback } from "./commands/rollback.ts";
import { history } from "./commands/history.ts";
import { status } from "./commands/status.ts";
import { scale } from "./commands/scale.ts";
import { prune } from "./commands/prune.ts";
import { del } from "./commands/delete.ts";
import { group } from "./commands/group.ts";
import { accessory } from "./commands/accessory.ts";
import { bootstrap } from "./commands/bootstrap.ts";
import { runtime } from "./commands/runtime.ts";
import { ui } from "./commands/ui.ts";
import { exec } from "./commands/exec.ts";
import { ps } from "./commands/ps.ts";
import { stats } from "./commands/stats.ts";
import { events } from "./commands/events.ts";
import { inspect } from "./commands/inspect.ts";
import { logs } from "./commands/logs.ts";

export const command = rootCommand.pipe(
  Command.withSubcommands([
    validate,
    start,
    stop,
    restart,
    rm,
    deploy,
    scale,
    rollback,
    history,
    status,
    del,
    prune,
    group,
    accessory,
    bootstrap,
    runtime,
    ui,
    exec,
    ps,
    stats,
    inspect,
    logs,
    events,
  ]),
);

const program = Command.run(command, {
  version: cliVersion(),
  renderErrors: true,
}).pipe(
  Effect.catch((error) => {
    if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ShowHelp") {
      const errors = "errors" in error && Array.isArray(error.errors) ? error.errors : [];
      return Effect.sync(() => {
        process.exitCode = errors.length > 0 ? 1 : 0;
      });
    }
    return Effect.fail(toAppError(error));
  }),
);

const code = await runMain(program as Effect.Effect<void, AppError, never>, {
  layer: CliLayer,
});
process.exitCode = process.exitCode ?? code;
