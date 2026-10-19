import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { waitUntilHealthy } from "./health.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, lockKey, releaseLock } from "./lock.ts";
import { envRemotePath, indexedContainerName } from "./planner.ts";
import {
  buildScaleSteps,
  computeScalePlan,
  currentRevision,
  parseReplicaInventory,
} from "./scale-plan.ts";
import { runtimeFor } from "./runtime.ts";
import { belongsToService } from "./naming.ts";

/**
 * Manual capacity change for the revision that is already running.
 *
 *   bundant scale --replicas 5 -f deploy.yml
 *
 * The proxy target set is the single source of truth for traffic, so the
 * ordering is the whole trick:
 *   up   -> start + gate the new replicas, then one proxy deploy with the union
 *   down -> proxy deploy with the survivors FIRST (drain), then stop + rm
 * Reversing the down order drops in-flight requests; never do it.
 *
 * scale never pulls an image, never changes the revision or env, and never
 * writes deploy.yml: the file stays authoritative for the next deploy.
 * The pure plan lives in scale-plan.ts; this module only executes it.
 */

export {
  ScaleError,
  buildScaleSteps,
  computeScalePlan,
  currentRevision,
  parseReplicaInventory,
} from "./scale-plan.ts";
export type { ReplicaLine, ScalePlan, ScaleStepOptions } from "./scale-plan.ts";

export interface ScaleOptions {
  replicas: number;
  dryRun: boolean;
}

function assertTarget(config: LoadedConfig["config"], target: number): string | null {
  if (!Number.isInteger(target) || target < 1) {
    return "scale needs --replicas <integer >= 1>";
  }
  if (config.kind === "accessory") {
    return "scale does not apply to an accessory (stateful members are one of one)";
  }
  if (target > 1 && !config.proxy.enabled) {
    return "replicas > 1 requires proxy.enabled: true — without a proxy nothing distributes traffic";
  }
  return null;
}

/**
 * Change the replica count of the running revision on every host, under the
 * deploy lock. The proxy target set changes before containers are removed.
 */
export async function scale(loaded: LoadedConfig, opts: ScaleOptions): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const error = assertTarget(config, opts.replicas);
  if (error) {
    console.error("bundant: " + error);
    return 2;
  }

  const targets = hostTargets(config);

  if (opts.dryRun) {
    console.log(
      "bundant scale (dry-run) — " + config.service + "/" + config.role + " -> " +
        opts.replicas + " replicas on " + targets.join(", "),
    );
    console.log(
      "  up:   start missing -> health-gate each -> one proxy deploy with the full set",
    );
    console.log("  down: one proxy deploy with the survivors (drain) -> stop + rm removed");
    console.log("  (dry-run: no host contacted)");
    return 0;
  }

  const primary = new SshExecutor(connectOptionsFor(connectionForTarget(config, targets[0]!)));
  const execs = new Set<SshExecutor>([primary]);
  let locked = false;

  try {
    await acquireLock(primary, lockKey(config.group, config.service));
    locked = true;

    for (const host of targets) {
      const exec =
        host === targets[0]
          ? primary
          : new SshExecutor(connectOptionsFor(connectionForTarget(config, host)));
      execs.add(exec);
      console.log("== " + host + " ==");

      const list = await exec.run(
        docker.listRunningReplicas(rt, {
          "bundant.service": config.service,
          "bundant.group": config.group ?? "default",
          "bundant.kind": "service",
        }),
      );
      if (list.code !== 0) {
        console.error("  cannot list running replicas: " + list.stderr.trim());
        return 1;
      }
      const lines = parseReplicaInventory(list.stdout, config.service, config.role, config.group)
        .filter((l) => belongsToService(l.name, config));
      const revision = currentRevision(lines);
      if (revision === undefined) {
        console.error(
          "  nothing running for " + config.service + "/" + config.role + " — deploy first",
        );
        return 1;
      }
      const forRevision = lines.filter((l) => l.revision === revision);
      const current = [...new Set(forRevision.map((l) => l.index))].sort((a, b) => a - b);
      const image = forRevision[0]!.image;
      const plan = computeScalePlan(current, opts.replicas);

      console.log(
        "  revision " + revision + ": " + current.length + " running (" +
          current.join(", ") + ") -> " + opts.replicas,
      );

      if (plan.action === "noop") {
        console.log("  already at " + opts.replicas + " replica(s) — no-op");
        continue;
      }

      const hasEnv =
        Object.keys(config.env.vars).length > 0 || config.env.file !== undefined;
      const names = new Map(forRevision.map((l) => [l.index, l.name]));
      const steps = buildScaleSteps(config, revision, plan, {
        image,
        envFile: hasEnv ? envRemotePath(config) : undefined,
        nameOf: (i) => names.get(i) ?? indexedContainerName(config, revision, i),
      });

      for (const step of steps) {
        if (step.phase === "health") {
          for (const probeCmd of step.cmds) {
            await waitUntilHealthy(exec, probeCmd, {
              timeoutMs: config.healthcheck.timeout * 1000,
            });
          }
          console.log("  " + step.phase + " ok (" + step.cmds.length + " target(s))");
          continue;
        }
        for (const cmd of step.cmds) {
          const r = await exec.run(cmd);
          if (r.code !== 0) {
            console.error(
              "  " + step.phase + " failed: cmd=" + cmd + " err=" +
                (r.stderr.trim() || r.stdout.trim()),
            );
            return 1;
          }
        }
        console.log("  " + step.phase + " ok");
      }
      console.log("  scaled to " + opts.replicas + " replica(s)");
    }

    console.log(
      "bundant: scale is temporary — deploy.yml replicas: stays authoritative; " +
        "the next `bundant deploy` re-applies it.",
    );
    return 0;
  } finally {
    if (locked) await releaseLock(primary, lockKey(config.group, config.service));
    for (const e of execs) await e.close();
  }
}
