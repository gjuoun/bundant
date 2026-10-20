import { Effect } from "effect";
import { Command } from "effect/cli";
import { remove } from "../../delete.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise } from "./common.ts";

export const del = Command.make("delete", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    const via = opsVia(g.via);
    if (via === null) return yield* finish(2);
    const code = yield* runPromise(() =>
      remove(loaded, { yes: g.yes, images: g.images, dryRun: g["dry-run"], via }),
    );
    yield* finish(code);
  }),
).pipe(Command.withDescription("remove the service: proxy route, containers, env file"));
