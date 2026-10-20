import { Effect } from "effect";
import { Command } from "effect/cli";
import { bootstrap as runBootstrap } from "../../bootstrap.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise } from "./common.ts";

export const bootstrap = Command.make("bootstrap", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const code = yield* runPromise(() =>
      runBootstrap(loaded, { dryRun: g["dry-run"], smoke: !g["skip-smoke"] }),
    );
    yield* finish(code);
  }),
).pipe(Command.withDescription("install/verify podman and its host prerequisites on every host"));
