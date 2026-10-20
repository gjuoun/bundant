import { Effect } from "effect";
import { Command } from "effect/cli";
import { cliVersion } from "../version.ts";
import { runMain } from "../effect/runtime.ts";
import { toAppError, type AppError } from "../effect/errors.ts";
import { beginJson, commandName, finishJson, recordFailure, wantsJson } from "../agent/emit.ts";
import { UsageError, exitCodeFor } from "../agent/errors.ts";
import { command } from "./tree.ts";
import { CliLayer } from "./layer.ts";
import { usageFailure, usageMessage } from "./usage.ts";

const args = process.argv.slice(2);
const json = wantsJson(args);
const version = cliVersion();

// Parse before any command runs: a bad command line is USAGE on both paths,
// never a success envelope and never a full help dump.
const usage = await usageFailure(command, args, version);
if (usage !== null) {
  const error = new UsageError({ message: usage });
  if (json) {
    beginJson(commandName(args));
    recordFailure(error);
    process.exitCode = finishJson(exitCodeFor(error));
  } else {
    console.error("bundant: " + usage);
    process.exitCode = exitCodeFor(error);
  }
} else {
  if (json) beginJson(commandName(args));

  const program = Command.run(command, {
    version,
    renderErrors: true,
  }).pipe(
    Effect.catch((error) => {
      if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ShowHelp") {
        const message = usageMessage(error);
        if (message !== null) return Effect.fail(new UsageError({ message }));
        return Effect.sync(() => {
          process.exitCode = 0;
        });
      }
      const message = usageMessage(error);
      if (message !== null) return Effect.fail(new UsageError({ message }));
      return Effect.fail(toAppError(error));
    }),
  );

  const code = await runMain(program as Effect.Effect<void, AppError, never>, {
    layer: CliLayer,
  });
  process.exitCode = json ? finishJson(code) : (process.exitCode ?? code);
}
