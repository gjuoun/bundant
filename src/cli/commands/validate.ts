import { Effect } from "effect";
import { Command } from "effect/cli";
import { validateCommand } from "../../effect/commands.ts";
import { recordFailure } from "../../agent/emit.ts";
import { ConfigVersionError, ConfigError } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish, value } from "./common.ts";

export const validate = Command.make("validate", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const result = yield* validateCommand({
      file: value(g.file) ?? "deploy.yml",
      json: g.json,
      strict: g.strict,
    });
    if (g.json) {
      if (result.code !== 0) {
        const versionIssue = result.report.errors.some((issue) => issue.field === "version");
        const message = result.report.errors.map((issue) => issue.field + ": " + issue.message).join("; ");
        recordFailure(
          versionIssue
            ? new ConfigVersionError({ message })
            : new ConfigError({ message }),
        );
      }
    }
    yield* finish(result.code, result.report);
  }),
).pipe(Command.withDescription("parse and validate deploy.yml / group.yml / accessory.yml"));
