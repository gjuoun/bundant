import { Effect } from "effect";
import { Command } from "effect/cli";
import { dirname } from "node:path";
import { buildDeployPlan, renderPlan } from "../../planner.ts";
import { renderApiPlan } from "../../plan-render.ts";
import { resolveRevision, sanitizeRevision } from "../../revision.ts";
import { deploy as runDeploy } from "../../deploy.ts";
import { rootCommand } from "../root.ts";
import { finish, loadedFor, opsVia, runPromise, value } from "./common.ts";

export const deploy = Command.make("deploy", {}, () =>
  Effect.gen(function* () {
    const g = yield* rootCommand;
    const loaded = yield* runPromise(async () => loadedFor(g));
    if (loaded.config.kind === "accessory") {
      console.error(
        "bundant: " + loaded.config.service + " is an accessory — use \`bundant accessory boot\`",
      );
      return yield* finish(2);
    }
    const revision = value(g.rev)
      ? sanitizeRevision(value(g.rev)!)
      : yield* runPromise(() => resolveRevision(dirname(loaded.path)));
    const localImage = value(g["local-image"]);
    if (localImage !== undefined && localImage.trim() === "") {
      console.error("bundant: --local-image requires a name:tag value");
      return yield* finish(2);
    }
    const plan = buildDeployPlan(loaded.config, revision, { localImage });
    const via = opsVia(g.via);
    if (via === null) return yield* finish(2);
    if (g["dry-run"]) {
      console.log(
        via === "api" && localImage === undefined
          ? renderApiPlan(plan, { envCount: loaded.envCount })
          : renderPlan(plan),
      );
      return yield* finish(0);
    }
    const code = yield* runPromise(() =>
      runDeploy(plan, loaded, { via, allowCaseCollision: g["allow-case-collision"] }),
    );
    yield* finish(code);
  }),
).pipe(Command.withDescription("deploy the current revision to every host"));
