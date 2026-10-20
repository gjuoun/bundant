import { Command } from "effect/cli";
import { rootCommand } from "./root.ts";
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
import { bootstrap } from "./commands/bootstrap.ts";
import { runtime } from "./commands/runtime.ts";
import { ui } from "./commands/ui.ts";
import { exec } from "./commands/exec.ts";
import { ps } from "./commands/ps.ts";
import { stats } from "./commands/stats.ts";
import { events } from "./commands/events.ts";
import { inspect } from "./commands/inspect.ts";
import { logs } from "./commands/logs.ts";
import { errors } from "./commands/errors.ts";

/** The complete command tree, importable without running the CLI. */
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
    bootstrap,
    runtime,
    ui,
    exec,
    ps,
    stats,
    inspect,
    logs,
    events,
    errors,
  ]),
);
