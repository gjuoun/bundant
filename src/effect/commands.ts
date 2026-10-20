import { Effect } from "effect";
import type { LoadedConfig } from "../config.ts";
import {
  monitorFor,
  type HostResult,
  type InspectRow,
  type Monitor,
} from "../monitor.ts";
import {
  renderContainers,
  renderInspect,
  renderStats,
} from "../monitor-render.ts";
import {
  runtimeExitCode,
  runtimeReport,
  renderRuntimeReport,
} from "../runtime-report.ts";
import {
  renderValidationReport,
  validatePath,
} from "../validation.ts";
import { toAppError, type AppError } from "./errors.ts";

export interface ValidateCommandOptions {
  file: string;
  json: boolean;
  strict: boolean;
}

/** bundant validate as an Effect program. */
export function validateCommand(
  opts: ValidateCommandOptions,
): Effect.Effect<number, AppError> {
  return Effect.gen(function* () {
    const report = yield* Effect.tryPromise({
      try: () => validatePath(opts.file, process.env, { strict: opts.strict }),
      catch: toAppError,
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderValidationReport(report));
    }
    return report.ok ? 0 : 1;
  });
}

export interface RuntimeCommandOptions {
  loaded: LoadedConfig;
  json: boolean;
  hosts?: string[];
}

/** bundant runtime as an Effect program. */
export function runtimeCommand(
  opts: RuntimeCommandOptions,
): Effect.Effect<number, AppError> {
  return Effect.gen(function* () {
    const reports = yield* Effect.tryPromise({
      try: () => runtimeReport(opts.loaded, { hosts: opts.hosts }),
      catch: toAppError,
    });
    if (opts.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      console.log(renderRuntimeReport(reports));
    }
    return runtimeExitCode(reports);
  });
}

export type ReadCommand = "ps" | "stats" | "inspect" | "events" | "logs";

export interface ReadCommandOptions {
  loaded: LoadedConfig;
  command: ReadCommand;
  host?: string;
  container?: string;
  selector?: string;
  tail: number;
  since: string;
}

/** Open one monitor, run one read on it, always close it. */
function withMonitor<A>(
  loaded: LoadedConfig,
  run: (monitor: Monitor) => Promise<A>,
): Effect.Effect<A, AppError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const monitor = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => monitorFor(loaded), catch: toAppError }),
        (m) => Effect.promise(() => m.close()),
      );
      return yield* Effect.tryPromise({ try: () => run(monitor), catch: toAppError });
    }),
  );
}

/** ps / stats / inspect / events / logs --tail, as an Effect program. */
export function readCommand(
  opts: ReadCommandOptions,
): Effect.Effect<number, AppError> {
  const { loaded, command } = opts;
  return withMonitor(loaded, async (monitor) => {
    if (command === "ps") {
      console.log(renderContainers(await monitor.containers()));
      return 0;
    }
    if (command === "stats") {
      console.log(renderStats(await monitor.stats()));
      return 0;
    }
    if (command === "inspect") {
      const selector = opts.selector ?? opts.container;
      if (selector === undefined) {
        console.error("bundant: inspect needs a container name (or --container)");
        return 2;
      }
      console.log(renderInspect(await monitor.inspect(selector)));
      return 0;
    }
    if (command === "logs") {
      const hosts = opts.host === undefined ? monitor.hosts : [opts.host];
      for (const h of hosts) {
        process.stdout.write("== " + h + " ==\n");
        process.stdout.write(await monitor.logs(h, opts.container ?? "", opts.tail));
      }
      return 0;
    }
    const since = opts.since;
    const hosts = opts.host === undefined ? monitor.hosts : [opts.host];
    for (const h of hosts) {
      const lines = await monitor.events(h, since, { windowSeconds: 3 });
      console.log("== " + h + " ==");
      for (const line of lines.slice(-80)) console.log("  " + line);
    }
    return 0;
  });
}

/** Kept for the CLI's type import; no behaviour in this module. */
export type ReadHostResult = HostResult<InspectRow>;
