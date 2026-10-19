import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { waitUntilHealthy } from "./health.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, lockKey, releaseLock } from "./lock.ts";
import { envRemotePath, groupLabels, indexedContainerName } from "./planner.ts";
import { replicaOf, revisionOf } from "./revisions.ts";
import { runtimeFor } from "./runtime.ts";
import type { CmdStep } from "./types.ts";

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
 */

/** One running container of the service, as the host reports it. */
export interface ReplicaLine {
  name: string;
  revision: string;
  index: number;
  image: string;
}

/** A scale action and the index sets it touches. */
export interface ScalePlan {
  action: "noop" | "up" | "down";
  /** Indices running before the change. */
  current: number[];
  /** Indices serving after the change (the full proxy target set). */
  keep: number[];
  /** Indices to start (up). */
  up: number[];
  /** Indices to stop + remove (down, after the proxy dropped them). */
  remove: number[];
}

export class ScaleError extends Error {}

/**
 * Pure index arithmetic. Up fills the smallest free indices; down removes
 * the largest ones, keeping the surviving set contiguous from the bottom.
 */
export function computeScalePlan(current: number[], target: number): ScalePlan {
  const sorted = [...new Set(current)].sort((a, b) => a - b);
  if (target === sorted.length) {
    return { action: "noop", current: sorted, keep: sorted, up: [], remove: [] };
  }
  if (target > sorted.length) {
    const used = new Set(sorted);
    const up: number[] = [];
    for (let i = 1; up.length < target - sorted.length; i++) {
      if (!used.has(i)) up.push(i);
    }
    return {
      action: "up",
      current: sorted,
      keep: [...sorted, ...up].sort((a, b) => a - b),
      up,
      remove: [],
    };
  }
  return {
    action: "down",
    current: sorted,
    keep: sorted.slice(0, target),
    up: [],
    remove: sorted.slice(target),
  };
}

export interface ScaleStepOptions {
  /** Image of the running revision (scale never pulls; reuse what is there). */
  image: string;
  /** Remote env file already on the host, when the service declares env. */
  envFile?: string;
  /**
   * Existing container name per replica index. A revision deployed with
   * replicas: 1 is named without a suffix, so the surviving replica 1 keeps
   * its historical name; anything new is `<service>-<role>-<rev>-<i>`.
   */
  nameOf?: (index: number) => string;
}

/**
 * Pure command sequence for one host. The phase order is the invariant the
 * E2E proves: up = run, health, proxy-swap; down = proxy-swap, stop-old.
 */
export function buildScaleSteps(
  config: LoadedConfig["config"],
  revision: string,
  plan: ScalePlan,
  opts: ScaleStepOptions,
): CmdStep[] {
  const rt = runtimeFor(config.runtime);
  const svcId = proxy.serviceId(config.service, config.role);
  const steps: CmdStep[] = [];
  const nameOf = (i: number): string =>
    opts.nameOf ? opts.nameOf(i) : indexedContainerName(config, revision, i);

  if (plan.up.length > 0) {
    const cmds: string[] = [];
    for (const i of plan.up) {
      const name = nameOf(i);
      cmds.push(docker.removeForce(rt, name));
      cmds.push(
        docker.run(rt, {
          container: name,
          image: opts.image,
          envFile: opts.envFile,
          labels: groupLabels(config, revision, i),
        }),
      );
    }
    steps.push({
      phase: "run",
      desc: "start missing replica(s) " + plan.up.map(nameOf).join(", "),
      cmds,
    });
    steps.push({
      phase: "health",
      desc: "health-gate every new replica before any traffic moves",
      cmds: plan.up.map((i) =>
        docker.probe(rt, nameOf(i), config.healthcheck.port, config.healthcheck.path),
      ),
    });
  }

  if (config.proxy.enabled && plan.action !== "noop") {
    steps.push({
      phase: "proxy-swap",
      desc:
        "kamal-proxy deploy " + svcId + " -> " +
        plan.keep.map((i) => nameOf(i)).join(", ") +
        (plan.action === "down" ? " (drain first, then remove)" : " (union, then remove nothing)"),
      cmds: [
        proxy.deploy(
          rt,
          svcId,
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
        ),
      ],
    });
  }

  if (plan.remove.length > 0) {
    const cmds: string[] = [];
    for (const i of plan.remove) {
      cmds.push(docker.stop(rt, nameOf(i)));
      cmds.push(rt.bin + " rm -f " + nameOf(i));
    }
    steps.push({
      phase: "stop-old",
      desc: "stop + remove drained replica(s) " + plan.remove.map(nameOf).join(", "),
      cmds,
    });
  }

  return steps;
}

/** Parse one `ps` line: name|revision|replica|image. */
export function parseReplicaInventory(
  stdout: string,
  service: string,
  role: string,
): ReplicaLine[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", revLabel = "", replicaLabel = "", image = ""] = line.split("|");
      return {
        name,
        revision: revLabel || revisionOf(name, service, role),
        index: replicaLabel !== "" ? Number(replicaLabel) : replicaOf(name, service, role) ?? 1,
        image,
      };
    })
    .filter((line) => line.name !== "");
}

/** The revision the majority of running replicas report (they should agree). */
export function currentRevision(lines: ReplicaLine[]): string | undefined {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.revision, (counts.get(line.revision) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

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
      const lines = parseReplicaInventory(list.stdout, config.service, config.role);
      const revision = currentRevision(lines);
      if (revision === undefined) {
        console.error("  nothing running for " + config.service + "/" + config.role + " — deploy first");
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
