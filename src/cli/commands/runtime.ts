import { Effect } from "effect";
import { Command } from "effect/cli";
import { runtimeCommand } from "../../effect/commands.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, runPromise, value } from "./common.ts";

export const runtime = Command.make("runtime", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const hosts = value(g.hosts)
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const code = yield* runtimeCommand({ loaded, json: g.json, hosts });
    yield* finish(code);
  }),
).pipe(Command.withDescription("per-host engine/API detection: socket, forward, service state"));
