import { Effect } from "effect";
import { Command } from "effect/cli";
import { ui as runUi } from "../../ui.ts";
import { UsageError } from "../../agent/errors.ts";
import { recordData } from "../../agent/emit.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";

export const ui = Command.make("ui", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const port = Number(g.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new UsageError({ message: "--port must be a valid port number" });
    }
    const loaded = yield* runPromise(async () => loadedFor(g));
    if (g.json) recordData({ status: "running", port });
    const code = yield* runPromise(() => runUi(loaded, { port }));
    yield* finish(code);
  }),
).pipe(Command.withDescription("local read-only monitoring page (pull-on-demand)"));
