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
  type RuntimeHostReport,
} from "../runtime-report.ts";
import {
  renderValidationReport,
  validatePath,
  type ValidationReport,
} from "../validation.ts";
import { recordData } from "../agent/emit.ts";
import { UsageError } from "../agent/errors.ts";
import { toAppError, type AppError } from "./errors.ts";

export interface ValidateCommandOptions {
  file: string;
  json: boolean;
  strict: boolean;
}

/** bundant validate as an Effect program; the caller renders/finishes. */
export function validateCommand(
  opts: ValidateCommandOptions,
): Effect.Effect<{ code: number; report: ValidationReport }, AppError> {
  return Effect.gen(function* () {
    const report = yield* Effect.tryPromise({
      try: () => validatePath(opts.file, process.env, { strict: opts.strict }),
      catch: toAppError,
    });
    if (!opts.json) console.log(renderValidationReport(report));
    return { code: report.ok ? 0 : 1, report };
  });
}

export interface RuntimeCommandOptions {
  loaded: LoadedConfig;
  json: boolean;
  hosts?: string[];
}

/** bundant runtime as an Effect program; the caller renders/finishes. */
export function runtimeCommand(
  opts: RuntimeCommandOptions,
): Effect.Effect<{ code: number; reports: RuntimeHostReport[] }, AppError> {
  return Effect.gen(function* () {
    const reports = yield* Effect.tryPromise({
      try: () => runtimeReport(opts.loaded, { hosts: opts.hosts }),
      catch: toAppError,
    });
    if (!opts.json) console.log(renderRuntimeReport(reports));
    return { code: runtimeExitCode(reports), reports };
  });
}

export type ReadCommand = "ps" | "stats" | "inspect" | "events" | "logs";

export interface ReadCommandOptions {
  loaded: LoadedConfig;
  command: ReadCommand;
  json: boolean;
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
  const { loaded, command, json } = opts;
  return withMonitor(loaded, async (monitor) => {
    if (command === "ps") {
      const data = await monitor.containers();
      if (json) recordData(data);
      else console.log(renderContainers(data));
      return 0;
    }
    if (command === "stats") {
      const data = await monitor.stats();
      if (json) recordData(data);
      else console.log(renderStats(data));
      return 0;
    }
    if (command === "inspect") {
      const selector = opts.selector ?? opts.container;
      if (selector === undefined) {
        throw new UsageError({ message: "inspect needs a container name (or --container)" });
      }
      const data = await monitor.inspect(selector);
      if (json) recordData(data);
      else console.log(renderInspect(data));
      return 0;
    }
    if (command === "logs") {
      const hosts = opts.host === undefined ? monitor.hosts : [opts.host];
      const entries: { host: string; container: string; lines: string[] }[] = [];
      for (const h of hosts) {
        const text = await monitor.logs(h, opts.container ?? "", opts.tail);
        entries.push({
          host: h,
          container: opts.container ?? "",
          lines: text.split("\n").filter((line) => line !== ""),
        });
        if (!json) {
          process.stdout.write("== " + h + " ==\n");
          process.stdout.write(text);
        }
      }
      if (json) recordData(entries);
      return 0;
    }
    const since = opts.since;
    const hosts = opts.host === undefined ? monitor.hosts : [opts.host];
    const entries: { host: string; lines: string[] }[] = [];
    for (const h of hosts) {
      const lines = await monitor.events(h, since, { windowSeconds: 3 });
      entries.push({ host: h, lines: lines.slice(-80) });
      if (!json) {
        console.log("== " + h + " ==");
        for (const line of lines.slice(-80)) console.log("  " + line);
      }
    }
    if (json) recordData(entries);
    return 0;
  });
}

/** Kept for the CLI's type import; no behaviour in this module. */
export type ReadHostResult = HostResult<InspectRow>;
