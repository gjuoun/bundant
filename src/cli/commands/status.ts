import { Effect } from "effect";
import { Command } from "effect/cli";
import { status as runStatus } from "../../status.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";

export const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const code = yield* runPromise(() => runStatus(loaded));
    yield* finish(code);
  }),
).pipe(Command.withDescription("per-host containers, proxy targets, health"));
