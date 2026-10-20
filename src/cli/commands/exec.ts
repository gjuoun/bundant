import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { monitorFor } from "../../monitor.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise, value } from "./common.ts";

export const exec = Command.make(
  "exec",
  { argv: Argument.String("cmd").pipe(Argument.variadic({ min: 0 })) },
  ({ argv }) =>
    Effect.gen(function* () {
      const g = yield* rootCommand;
      const host = value(g.host);
      if (host === undefined) {
        console.error("bundant: exec needs --host <host>");
        return yield* finish(2);
      }
      const loaded = yield* runPromise(async () => loadedFor(g));
      const monitor = yield* runPromise(() => monitorFor(loaded));
      try {
        const code = yield* runPromise(() =>
          monitor.execShell(host, value(g.container) ?? "", [...argv]),
        );
        yield* finish(code);
      } finally {
        yield* runPromise(() => monitor.close());
      }
    }),
).pipe(Command.withDescription("shell into a container (--host required, PTY through ssh)"));
