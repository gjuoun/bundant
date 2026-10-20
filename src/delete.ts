import type { BundantConfig, LoadedConfig } from "./config.ts";
import type { ContainerSummary } from "./adapters/types.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { ServiceIdentity } from "./domain/identity.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, lockKey, releaseLock } from "./lock.ts";
import { envRemotePath, LABEL_KIND, KIND_ACCESSORY } from "./planner.ts";
import { belongsToService, containerPrefix, isGrouped, legacyPrefix, serviceLabels } from "./naming.ts";
import { runtimeFor } from "./runtime.ts";
import type { CmdStep } from "./types.ts";
import { openOps, type OpsVia } from "./ops/index.ts";
import { preflightGate } from "./validation.ts";

export interface DeleteOptions {
  /** Required for the destructive path; without it delete only prints the plan. */
  yes: boolean;
  /** Also remove the image refs the deleted revisions used (default: leave images). */
  images: boolean;
  /** Print exactly what would be removed and never open ssh. */
  dryRun: boolean;
  /** Mutations through the engine API (default) or the legacy CLI strings. */
  via?: OpsVia;
}

/** Pure: the containers that belong to this service-role (running or stopped). */
export function selectVictims(stdout: string, service: string, role: string): string[] {
  const prefix = service + "-" + role + "-";
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((n) => n.startsWith(prefix));
}

/** Pure: names the labelled sweep will remove (any state, no prefix guessing). */
export function selectSweepVictims(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((n) => n !== "");
}

export function deleteGuardError(opts: DeleteOptions): string | null {
  if (opts.dryRun || opts.yes) return null;
  return "delete is destructive and removes containers and the env file on every host: pass --yes (or --dry-run to preview)";
}

function prefix(config: BundantConfig): string {
  return containerPrefix(config);
}

/** Pure selection shared by delete and the group sweep; accessories are never victims. */
export function selectDeleteVictims(
  rows: ContainerSummary[],
  config: Pick<BundantConfig, "service" | "role" | "group">,
  filterService: boolean,
): ContainerSummary[] {
  return rows.filter(
    (row) =>
      row.labels["bundant.kind"] !== KIND_ACCESSORY &&
      (!filterService || belongsToService(row.name, config)),
  );
}

/** Proxy route removal, shared by delete and the group sweep. */
function proxyRemoveStep(config: BundantConfig, rt: ReturnType<typeof runtimeFor>): CmdStep[] {
  if (!config.proxy.enabled) return [];
  const svcId = ServiceIdentity.from(config).proxyId();
  return [
    {
      phase: "proxy-remove",
      desc:
        "remove the kamal-proxy route for " + svcId +
        " (tolerated when the proxy is absent or stopped)",
      cmds: [
        rt.bin + ' inspect -f "{{.State.Running}}" ' + proxy.PROXY_CONTAINER +
          " 2>/dev/null | grep -q true && " + rt.bin + " exec " + proxy.PROXY_CONTAINER +
          " kamal-proxy remove " + svcId + " || true",
      ],
    },
  ];
}

function envRemoveStep(config: BundantConfig): CmdStep {
  return {
    phase: "env-remove",
    desc: "remove the rendered env file (tolerated when absent)",
    cmds: ["rm -f " + envRemotePath(config)],
  };
}

/**
 * Pure plan. The container removal is a single runtime loop, so the plan is
 * exact without any ssh call (which is what lets --dry-run stay print-only).
 */
export function buildDeleteSteps(config: BundantConfig, opts: DeleteOptions): CmdStep[] {
  const rt = runtimeFor(config.runtime);
  const p = prefix(config);

  const steps: CmdStep[] = [...proxyRemoveStep(config, rt)];

  const skipAccessory =
    'k=$(' + docker.inspectLabel(rt, '"$c"', LABEL_KIND) + '); ' +
    'if [ "$k" = "' + KIND_ACCESSORY + '" ]; then echo "skip accessory $c (stateful: use bundant accessory remove)" >&2; continue; fi; ';
  const sweep = (namePrefix: string, guard: string, collect: boolean): string => {
    const names =
      "for c in $(" + rt.bin + ' ps -a --filter "name=' + namePrefix + '" --format "{{.Names}}"' +
      ' | grep "^' + namePrefix + '"); do ';
    return names + guard + skipAccessory + (collect
      ? rt.bin + ' inspect -f "{{.Config.Image}}" "$c" 2>/dev/null; done'
      : rt.bin + ' stop -t 10 "$c" 2>/dev/null; ' + rt.bin + ' rm -f "$c"; done');
  };
  // New shape first; a real group also sweeps pre-grouping names, but only
  // containers carrying this group label (another group may use the service name).
  const grouped = isGrouped(config);
  const guard =
    'g=$(' + docker.inspectLabel(rt, '"$c"', 'bundant.group') + '); ' +
    '[ "$g" = "' + (config.group ?? "") + '" ] || continue; ';
  const prefixes = grouped
    ? [{ prefix: p, guard: "" }, { prefix: legacyPrefix(config), guard }]
    : [{ prefix: p, guard: "" }];
  const stopAndRemove = prefixes.map((t) => sweep(t.prefix, t.guard, false)).join("; ");
  const collectImages = grouped
    ? "(" + prefixes.map((t) => sweep(t.prefix, t.guard, true)).join("; ") + ") | sort -u"
    : sweep(p, "", true) + " | sort -u";

  if (opts.images) {
    steps.push({
      phase: "containers",
      desc:
        "stop and remove every " + p + "* container, then remove the images they used",
      cmds: [
        "imgs=$(" + collectImages + "); " + stopAndRemove +
          '; for img in $imgs; do [ -n "$img" ] && ' + rt.bin + ' rmi "$img"; done',
      ],
    });
  } else {
    steps.push({
      phase: "containers",
      desc: "stop and remove every " + p + "* container (running or stopped)",
      cmds: [stopAndRemove],
    });
  }

  steps.push(envRemoveStep(config));
  return steps;
}

/**
 * Pure labelled-sweep plan for a group member: exact label selection instead of
 * a name prefix. `group uninstall` builds this per **service** member only, so
 * accessory containers (stateful, unlabelled by this filter) are never touched.
 */
export function buildSweepSteps(
  config: BundantConfig,
  labels: Record<string, string>,
  opts: DeleteOptions,
): CmdStep[] {
  const rt = runtimeFor(config.runtime);
  const steps: CmdStep[] = [...proxyRemoveStep(config, rt)];

  const names =
    "for c in $(" + rt.bin + " ps -a" + docker.labelFilters(labels) + ' --format "{{.Names}}"); do ';
  const stopAndRemove = names + rt.bin + ' stop -t 10 "$c" 2>/dev/null; ' + rt.bin + ' rm -f "$c"; done';
  const collectImages =
    names + rt.bin + ' inspect -f "{{.Config.Image}}" "$c" 2>/dev/null; done | sort -u';

  if (opts.images) {
    steps.push({
      phase: "containers",
      desc: "stop and remove labelled containers, then remove the images they used",
      cmds: [
        "imgs=$(" + collectImages + "); " + stopAndRemove +
          '; for img in $imgs; do [ -n "$img" ] && ' + rt.bin + ' rmi "$img"; done',
      ],
    });
  } else {
    steps.push({
      phase: "containers",
      desc: "stop and remove every container labelled " + JSON.stringify(labels),
      cmds: [stopAndRemove],
    });
  }

  steps.push(envRemoveStep(config));
  return steps;
}

interface DeleteSelection {
  labels?: Record<string, string>;
  namePrefix?: string;
  /** Keep only names that belong to this service-role (delete, not group sweep). */
  filterService: boolean;
}

/** Shared executor: prints the plan, guards on --yes, then runs it host by host. */
async function executeDelete(
  loaded: LoadedConfig,
  steps: CmdStep[],
  opts: DeleteOptions,
  header: string,
  selection: DeleteSelection,
): Promise<number> {
  const { config } = loaded;
  const targets = hostTargets(config);

  console.log("bundant delete — " + header + " on " + targets.join(", "));
  console.log(
    "runtime=" + config.runtime + " | images=" + (opts.images ? "remove" : "leave alone"),
  );
  for (const step of steps) {
    console.log("  [" + step.phase + "] " + step.desc);
    for (const cmd of step.cmds) console.log("     " + cmd);
  }

  const guard = deleteGuardError(opts);
  if (guard) {
    console.error("bundant: " + guard);
    return 2;
  }
  if (opts.dryRun) {
    console.log("(dry-run: nothing executed, no host contacted)");
    return 0;
  }

  const via: OpsVia = opts.via ?? "api";
  const primary = preflightGate(loaded, () =>
    new SshExecutor(connectOptionsFor(connectionForTarget(config, targets[0]!))),
  );
  let locked = false;
  try {
    await acquireLock(primary, lockKey(config.group, config.service));
    locked = true;

    for (const host of targets) {
      console.log("== " + host + " ==");
      const ops = await openOps(via, connectionForTarget(config, host), config);
      try {
        if (config.proxy.enabled) {
          const newId = ServiceIdentity.from(config).proxyId();
          await ops.proxyRemove(newId);
          const legacyId = proxy.serviceId(config.service, config.role, config.group);
          if (legacyId !== newId) await ops.proxyRemove(legacyId);
          console.log("  proxy-remove ok");
        }
        const rows = await ops.listContainers({
          all: true,
          labels: selection.labels,
          namePrefix: selection.namePrefix,
        });
        const victims = selectDeleteVictims(rows, config, selection.filterService);
        const images = opts.images
          ? [...new Set(victims.map((row) => row.image).filter((image) => image !== ""))]
          : [];
        for (const row of victims) {
          await ops.stopContainers([row.name]);
          await ops.removeContainer(row.name, { force: true });
          console.log("  removed " + row.name);
        }
        if (victims.length === 0) console.log("  nothing to remove");
        console.log(
          "  containers ok" + (victims.length > 0 ? ": " + victims.map((r) => r.name).join(" ") : ""),
        );
        for (const image of images) {
          await ops.removeImage(image);
          console.log("  removed image " + image);
        }
        const envPath = envRemotePath(config);
        if (envPath !== undefined) {
          await ops.removeEnv(envPath);
          console.log("  env-remove ok");
        }
      } catch (e) {
        console.error("  delete failed: " + (e as Error).message);
        return 1;
      } finally {
        await ops.close();
      }
    }

    console.log("deleted " + header + " on " + targets.length + " host(s)");
    return 0;
  } finally {
    if (locked) await releaseLock(primary, lockKey(config.group, config.service));
    await primary.close();
  }
}

/**
 * Remove a service-role from every host: proxy route, containers, env file
 * (and images with --images). Prints the plan first; without --yes it stops
 * there and never opens ssh.
 */
export async function remove(loaded: LoadedConfig, opts: DeleteOptions): Promise<number> {
  const { config } = loaded;
  return executeDelete(
    loaded,
    buildDeleteSteps(config, opts),
    opts,
    config.service + "/" + config.role,
    { labels: serviceLabels(config), filterService: true },
  );
}

/** Remove one group member by its exact labels (accessories are never selected). */
export async function removeSweep(
  loaded: LoadedConfig,
  labels: Record<string, string>,
  opts: DeleteOptions,
): Promise<number> {
  return executeDelete(
    loaded,
    buildSweepSteps(loaded.config, labels, opts),
    opts,
    "labels " + JSON.stringify(labels),
    { labels, filterService: false },
  );
}
