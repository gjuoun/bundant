import { Effect } from "effect";
import { Command } from "effect/cli";
import { dirname } from "node:path";
import { buildDeployPlan, renderPlan } from "../../planner.ts";
import { renderApiPlan } from "../../plan-render.ts";
import type { PullPolicy } from "../../ops/index.ts";
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
        "bundant: " + loaded.config.service + " is an accessory - use \`bundant accessory boot\`",
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
    if (!["missing", "always", "never"].includes(g.pull)) {
      console.error("bundant: --pull must be 'missing', 'always' or 'never'");
      return yield* finish(2);
    }
    const phases: Record<string, number> = {};
    // CLI startup is part of the wall time an operator sees.
    phases.startup = performance.now();
    const started = performance.now();
    const originalLog = console.log;
    if (g.json) console.log = () => undefined;
    let code = 0;
    try {
      code = yield* runPromise(() =>
        runDeploy(plan, loaded, {
          via,
          allowCaseCollision: g["allow-case-collision"],
          pullPolicy: g.pull as PullPolicy,
          phases,
        }),
      );
    } finally {
      console.log = originalLog;
    }
    const totalMs = performance.now() - started;
    if (g.timings) {
      for (const [phase, ms] of Object.entries(phases)) {
        console.log("  " + phase + " " + Math.round(ms));
      }
      // The external wall measurement is the denominator; no total row here."
    }
    if (g.json) {
      console.log(
        JSON.stringify(
          { status: code === 0 ? "deployed" : "failed", phases, totalMs: Math.round(totalMs) },
          null,
          2,
        ),
      );
    }
    yield* finish(code);
  }),
).pipe(Command.withDescription("deploy the current revision to every host"));
