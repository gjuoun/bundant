import { Effect } from "effect";
import { Command } from "effect/cli";
import { runtimeCommand } from "../../effect/commands.ts";
import { recordData, recordFailure } from "../../agent/emit.ts";
import { EngineUnavailableError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise, value } from "./common.ts";

export const runtime = Command.make("runtime", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const hosts = value(g.hosts)
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const result = yield* runtimeCommand({ loaded, json: g.json, hosts });
    if (g.json) {
      if (result.code === 0) recordData(result.reports);
      else {
        const failed = result.reports.find((report) => !report.ok);
        recordFailure(
          new EngineUnavailableError({
            message: failed?.error ?? "runtime is not available on every host",
            host: failed?.host,
          }),
        );
      }
    }
    yield* finish(result.code);
  }),
).pipe(Command.withDescription("per-host engine/API detection: socket, forward, service state"));
