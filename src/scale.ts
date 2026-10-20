import type { LoadedConfig } from "./config.ts";
import { NETWORK } from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, lockKey, releaseLock } from "./lock.ts";
import { groupLabels, indexedContainerName } from "./planner.ts";
import { computeScalePlan, currentRevision } from "./scale-plan.ts";
import { runtimeFor } from "./runtime.ts";
import { belongsToService, serviceLabels } from "./naming.ts";
import { replicaOf, revisionOf } from "./revisions.ts";
import { openOps } from "./ops/index.ts";
import { envArray } from "./deploy.ts";
import { preflightGate } from "./validation.ts";
import { ServiceIdentity } from "./domain/identity.ts";

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
 * The pure plan lives in scale-plan.ts; this module executes it through
 * RuntimeOps.
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
    return "replicas > 1 requires proxy.enabled: true - without a proxy nothing distributes traffic";
  }
  return null;
}

/**
 * Change the replica count of the running revision on every host, under the
 * deploy lock. The proxy target set changes before containers are removed.
 */
export async function scale(loaded: LoadedConfig, opts: ScaleOptions): Promise<number> {
  const { config } = loaded;
  runtimeFor(config.runtime);
  const error = assertTarget(config, opts.replicas);
  if (error) {
    console.error("bundant: " + error);
    return 2;
  }

  const targets = hostTargets(config);
  if (opts.dryRun) {
    console.log(
      "bundant scale (dry-run) - " + config.service + "/" + config.role + " -> " +
        opts.replicas + " replicas on " + targets.join(", "),
    );
    console.log(
      "  up:   start missing -> health-gate each -> one proxy deploy with the full set",
    );
    console.log("  down: one proxy deploy with the survivors (drain) -> stop + rm removed");
    console.log("  (dry-run: no host contacted)");
    return 0;
  }

  const primary = preflightGate(loaded, () =>
    new SshExecutor(connectOptionsFor(connectionForTarget(config, targets[0]!))),
  );
  let locked = false;
  const env = envArray(loaded.envContent);

  try {
    await acquireLock(primary, lockKey(config.group, config.service));
    locked = true;

    for (const host of targets) {
      console.log("== " + host + " ==");
      const ops = await openOps(connectionForTarget(config, host), config);
      try {
        const rows = await ops.listContainers({ all: false, labels: serviceLabels(config) });
        const lines = rows
          .filter((row) => belongsToService(row.name, config))
          .map((row) => ({
            name: row.name,
            revision:
              row.labels["bundant.revision"] ||
              revisionOf(row.name, config.service, config.role, config.group),
            index:
              row.labels["bundant.replica"] !== undefined
                ? Number(row.labels["bundant.replica"])
                : (replicaOf(row.name, config.service, config.role, config.group) ?? 1),
            image: row.image,
          }));

        const revision = currentRevision(lines);
        if (revision === undefined) {
          console.error(
            "  nothing running for " + config.service + "/" + config.role + " - deploy first",
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
          console.log("  already at " + opts.replicas + " replica(s) - no-op");
          continue;
        }

        const names = new Map(forRevision.map((l) => [l.index, l.name]));
        const nameOf = (i: number): string =>
          names.get(i) ?? indexedContainerName(config, revision, i);

        if (plan.up.length > 0) {
          for (const i of plan.up) {
            const name = nameOf(i);
            await ops.removeContainer(name, { force: true });
            await ops.createContainer({
              image,
              name,
              env,
              labels: groupLabels(config, revision, i),
              network: NETWORK,
              restart: "unless-stopped",
            });
            await ops.startContainer(name);
          }
          console.log("  run ok (" + plan.up.map(nameOf).join(", ") + ")");
          await ops.healthGate(plan.up.map(nameOf), {
            path: config.healthcheck.path,
            port: config.healthcheck.port,
            timeoutMs: config.healthcheck.timeout * 1000,
          });
          console.log("  health ok (" + plan.up.length + " target(s))");
        }

        // The down direction must drain traffic BEFORE removing containers.
        if (config.proxy.enabled) {
          await ops.proxyDeploy(
            ServiceIdentity.from(config).proxyId(),
            plan.keep.map((i) => nameOf(i) + ":" + config.proxy.port),
            {
              host: config.proxy.host,
              tls: config.proxy.tls,
              healthCheckPath: config.healthcheck.path,
              healthCheckPort:
                config.healthcheck.port === config.proxy.port
                  ? undefined
                  : config.healthcheck.port,
            },
          );
          console.log("  proxy-swap ok");
        }

        if (plan.remove.length > 0) {
          for (const i of plan.remove) {
            const name = nameOf(i);
            await ops.stopContainers([name]);
            await ops.removeContainer(name, { force: true });
          }
          console.log("  stop-old ok (" + plan.remove.map(nameOf).join(", ") + ")");
        }
        console.log("  scaled to " + opts.replicas + " replica(s)");
      } catch (e) {
        console.error("  scale failed: " + (e as Error).message);
        return 1;
      } finally {
        await ops.close();
      }
    }

    console.log(
      "bundant: scale is temporary - deploy.yml replicas: stays authoritative; " +
        "the next \`bundant deploy\` re-applies it.",
    );
    return 0;
  } finally {
    if (locked) await releaseLock(primary, lockKey(config.group, config.service));
    await primary.close();
  }
}
