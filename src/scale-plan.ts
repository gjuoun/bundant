import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import type { BundantConfig } from "./config.ts";
import { groupLabels, indexedContainerName } from "./planner.ts";
import { replicaOf, revisionOf } from "./revisions.ts";
import { runtimeFor } from "./runtime.ts";
import { ServiceIdentity } from "./domain/identity.ts";
import type { CmdStep } from "./types.ts";

/**
 * Pure scale arithmetic and command rendering. The orchestrator in scale.ts
 * executes these steps; keeping them pure is what lets the ordering invariant
 * (down = proxy first, containers after) be unit-tested without a host.
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
  config: BundantConfig,
  revision: string,
  plan: ScalePlan,
  opts: ScaleStepOptions,
): CmdStep[] {
  const rt = runtimeFor(config.runtime);
  const svcId = ServiceIdentity.from(config, undefined, revision).proxyId();
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
  group?: string,
): ReplicaLine[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", revLabel = "", replicaLabel = "", image = ""] = line.split("|");
      return {
        name,
        revision: revLabel || revisionOf(name, service, role, group),
        index: replicaLabel !== "" ? Number(replicaLabel) : replicaOf(name, service, role, group) ?? 1,
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
