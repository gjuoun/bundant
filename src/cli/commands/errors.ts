import { Effect } from "effect";
import { Command } from "effect/cli";
import { errorCatalog } from "../../agent/errors.ts";
import { rootCommand } from "../root.ts";
import { finish } from "./common.ts";

/** bundant errors: the stable catalog, so a client can discover codes. */
export const errors = Command.make("errors", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const catalog = errorCatalog();
    if (!g.json) {
      console.log("code                      exit  when");
      for (const entry of catalog) {
        console.log(
          entry.code.padEnd(26) + String(entry.exitCode).padEnd(6) + entry.when,
        );
      }
    }
    yield* finish(0, catalog);
  }),
).pipe(Command.withDescription("print the stable error catalog (code + exit status)"));
