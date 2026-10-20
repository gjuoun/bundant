import { Effect } from "effect";
import { Command } from "effect/cli";
import { cliVersion } from "../version.ts";
import { runMain } from "../effect/runtime.ts";
import { toAppError, type AppError } from "../effect/errors.ts";
import { rootCommand } from "./root.ts";
import { CliLayer } from "./layer.ts";
import { validate } from "./commands/validate.ts";

export const command = rootCommand.pipe(Command.withSubcommands([validate]));

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
