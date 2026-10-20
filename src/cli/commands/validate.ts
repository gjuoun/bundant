import { Effect } from "effect";
import { Command } from "effect/cli";
import { validateCommand } from "../../effect/commands.ts";
import { rootCommand } from "../root.ts";
import { finish, value } from "./common.ts";

export const validate = Command.make("validate", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const code = yield* validateCommand({
      file: value(g.file) ?? "deploy.yml",
      json: g.json,
      strict: g.strict,
    });
    yield* finish(code);
  }),
).pipe(Command.withDescription("parse and validate deploy.yml / group.yml / accessory.yml"));
