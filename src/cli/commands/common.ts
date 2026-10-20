import { Effect, Option } from "effect";
import type { Command } from "effect/cli";
import { loadConfig, type LoadedConfig } from "../../config.ts";
import { toAppError, type AppError } from "../../effect/errors.ts";
import type { OpsVia } from "../../ops/index.ts";
import { globalFlags } from "../options.ts";
import { isJsonMode, recordData, recordFailure } from "../../agent/emit.ts";
import { UnknownError } from "../../agent/errors.ts";

export type GlobalConfig = Command.Command.Config.Infer<typeof globalFlags>;

export function value(option: Option.Option<string>): string | undefined {
  return Option.isSome(option) ? option.value : undefined;
}

export function opsVia(raw: string): OpsVia | null {
  if (raw === "api") return "api";
  if (raw === "cli") return "cli";
  console.error("bundant: --via must be 'api' or 'cli'");
  return null;
}

export function runPromise<A>(fn: () => Promise<A>): Effect.Effect<A, AppError> {
  return Effect.tryPromise({ try: fn, catch: toAppError });
}

/**
 * Handlers set the process code; Command.run itself returns void. In JSON mode
 * the payload is recorded here and emitted as the single stdout object.
 */
export function finish(code: number, data?: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    if (isJsonMode()) {
      if (code === 0) recordData(data ?? null);
      else recordFailure(new UnknownError({ message: "command failed with exit code " + code }));
    }
    process.exitCode = code;
  });
}

export function loadedFor(g: GlobalConfig, fallback = "deploy.yml"): LoadedConfig {
  return loadConfig(value(g.file) ?? fallback);
}
