import { Effect } from "effect";
import type { LoadedConfig } from "../../config.ts";
import { readCommand } from "../../effect/commands.ts";
import { monitorFor } from "../../monitor.ts";
import { runPromise, value } from "./common.ts";
import type { GlobalConfig } from "./common.ts";

export type ReadName = "ps" | "stats" | "inspect" | "events" | "logs";

export function runRead(
  g: GlobalConfig,
  loaded: LoadedConfig,
  name: ReadName,
  selector?: string,
): Effect.Effect<number, import("../../effect/errors.ts").AppError> {
  return readCommand({
    loaded,
    command: name,
    json: g.json,
    host: value(g.host),
    container: value(g.container),
    selector,
    tail: Number(g.tail),
    since: g.since,
  });
}

/** The follow path keeps the old SIGINT behaviour and closes its monitor. */
export function runFollow(
  loaded: LoadedConfig,
  g: GlobalConfig,
  tail: number,
): Effect.Effect<number, import("../../effect/errors.ts").AppError> {
  return runPromise(async () => {
    const monitor = await monitorFor(loaded);
    const onSignal = (): void => {
      void monitor.close().finally(() => process.exit(130));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await monitor.followLogs({
        host: value(g.host),
        container: value(g.container),
        tail,
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await monitor.close();
    }
  });
}
