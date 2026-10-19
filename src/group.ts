import type { LoadedConfig, LoadedGroup, GroupMember } from "./config.ts";
import { Accessory, AccessoryError, tcpReadinessProbe } from "./accessory.ts";
import * as docker from "./commands/docker.ts";
import { deploy } from "./deploy.ts";
import { removeSweep, buildSweepSteps } from "./delete.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { buildDeployPlan, renderPlan } from "./planner.ts";
import { resolveRevision, sanitizeRevision } from "./revision.ts";
import { rollback } from "./rollback.ts";
import { runtimeFor } from "./runtime.ts";
import { status as serviceStatus } from "./status.ts";
import { accessoryContainerName } from "./naming.ts";

/**
 * Group orchestration: a group is a namespace with one lifecycle. Install walks
 * the manifest in topological order, verifies accessories (never creates them),
 * then deploys each service. Uninstall is a labelled sweep over services only —
 * accessories hold data and are left strictly alone.
 */

export class GroupError extends Error {}
export class GroupCycleError extends GroupError {}

export function isAccessory(member: GroupMember): boolean {
  return member.loaded.config.kind === "accessory";
}

/** Install order: dependencies (needs:) first; manifest order breaks ties. Cycle = error. */
export function topoSortMembers(members: GroupMember[]): GroupMember[] {
  const byName = new Map(members.map((m) => [m.name, m]));
  const state = new Map<string, 0 | 1 | 2>();
  const order: GroupMember[] = [];

  const visit = (m: GroupMember): void => {
    const s = state.get(m.name) ?? 0;
    if (s === 2) return;
    if (s === 1) throw new GroupCycleError("group dependency cycle through '" + m.name + "'");
    state.set(m.name, 1);
    for (const need of m.needs) {
      const dep = byName.get(need);
      if (!dep) throw new GroupError("member '" + m.name + "' needs unknown member '" + need + "'");
      visit(dep);
    }
    state.set(m.name, 2);
    order.push(m);
  };

  for (const m of members) visit(m);
  return order;
}

/**
 * Group rollback mapping: one repo per group means every service rolls to the
 * same git sha; accessories are excluded (explicit commands only).
 */
export function groupRollbackPlan(
  members: GroupMember[],
  toRevision: string,
): { member: GroupMember; revision: string }[] {
  return members
    .filter((m) => !isAccessory(m))
    .map((m) => ({ member: m, revision: toRevision }));
}

export interface GroupRunOptions {
  dryRun: boolean;
  yes: boolean;
  toRevision?: string;
  /** install: testing hook for the revision id. */
  rev?: string;
}

export function memberLabels(group: string, name: string): Record<string, string> {
  return { "bundant.service": name, "bundant.group": group, "bundant.kind": "service" };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class GroupRunner {
  private readonly loaded: LoadedGroup;

  constructor(loaded: LoadedGroup) {
    this.loaded = loaded;
  }

  private primary(): LoadedConfig {
    const first = this.loaded.members[0];
    if (!first) throw new GroupError("group '" + this.loaded.group + "' has no members");
    return first.loaded;
  }

  /** install: group lock once, then accessory verification + ordered service deploys. */
  async install(opts: GroupRunOptions): Promise<number> {
    const order = topoSortMembers(this.loaded.members);
    const revision = opts.rev
      ? sanitizeRevision(opts.rev)
      : await resolveRevision(this.loaded.dir);
    console.log(
      "bundant group install — " + this.loaded.group + " rev=" + revision + " order=" +
        order.map((m) => m.name).join(" -> "),
    );

    if (opts.dryRun) {
      for (const m of order) {
        if (isAccessory(m)) {
          console.log("  [accessory] verify " + m.name + " is ready (" + this.probeLabel(m) + ")");
          console.log("     if absent: bundant accessory boot -f " + m.file);
        } else {
          console.log("");
          console.log(renderPlan(buildDeployPlan(m.loaded.config, revision)));
        }
      }
      return 0;
    }

    const cfg = this.primary().config;
    const primary = new SshExecutor(connectOptionsFor(connectionForTarget(cfg, cfg.hosts[0]!)));
    let locked = false;
    const applied: string[] = [];
    let failed: string | undefined;
    try {
      await acquireLock(primary, this.loaded.group);
      locked = true;

      for (const m of order) {
        if (isAccessory(m)) {
          if (!(await this.accessoryReady(m))) {
            console.error(
              "bundant: accessory '" + m.name + "' is not ready — start it first:\n" +
                "  bundant accessory boot -f " + m.file,
            );
            failed = m.name;
            break;
          }
          applied.push(m.name);
          continue;
        }
        const rc = await deploy(buildDeployPlan(m.loaded.config, revision), m.loaded);
        if (rc !== 0) {
          failed = m.name;
          break;
        }
        applied.push(m.name);
      }
    } finally {
      if (locked) await releaseLock(primary, this.loaded.group);
      await primary.close();
    }

    const skipped = order.map((m) => m.name).filter((n) => !applied.includes(n));
    console.log(
      "group install report: applied [" + applied.join(", ") + "]" +
        (failed ? " failed [" + failed + "]" : "") +
        (skipped.length > 0 ? " skipped [" + skipped.join(", ") + "]" : ""),
    );
    return failed ? 1 : 0;
  }

  /** uninstall: labelled sweep over service members; accessories are never selected. */
  async uninstall(opts: GroupRunOptions): Promise<number> {
    const members = this.loaded.members.filter((m) => !isAccessory(m));
    console.log(
      "bundant group uninstall — " + this.loaded.group + " (accessories untouched: " +
        this.loaded.members.filter(isAccessory).map((m) => m.name).join(", ").replace(/^$/, "none") +
        ")",
    );
    if (opts.dryRun) {
      for (const m of members) {
        console.log("");
        for (const step of buildSweepSteps(m.loaded.config, memberLabels(this.loaded.group, m.name), {
          yes: true,
          images: false,
          dryRun: true,
        })) {
          console.log("  [" + step.phase + "] " + step.desc);
          for (const cmd of step.cmds) console.log("     " + cmd);
        }
      }
      return 0;
    }
    for (const m of members) {
      const rc = await removeSweep(m.loaded, memberLabels(this.loaded.group, m.name), {
        yes: opts.yes,
        images: false,
        dryRun: false,
      });
      if (rc !== 0) return rc;
    }
    return 0;
  }

  /** aggregated status: one block per member, accessories via the accessory view. */
  async status(): Promise<number> {
    let exit = 0;
    for (const m of this.loaded.members) {
      console.log("");
      console.log(
        "=== " + this.loaded.group + "/" + m.name + " (" +
          (isAccessory(m) ? "accessory" : "service") + ") ===",
      );
      const rc = isAccessory(m)
        ? await new Accessory(m.loaded).run("status", { yes: false, volumes: false, tail: 200, dryRun: false })
        : await serviceStatus(m.loaded);
      if (rc !== 0) exit = 1;
    }
    return exit;
  }

  /** rollback: every service deploys the same git sha; accessories untouched. */
  async rollback(opts: GroupRunOptions): Promise<number> {
    if (opts.toRevision === undefined || opts.toRevision === "") {
      console.error("bundant: group rollback needs --to-revision <sha>");
      return 2;
    }
    const plan = groupRollbackPlan(this.loaded.members, opts.toRevision);
    for (const { member, revision } of plan) {
      const rc = await rollback(member.loaded, { toRevision: revision });
      if (rc !== 0) return rc;
    }
    return 0;
  }

  private probeLabel(member: GroupMember): string {
    const tcp = member.loaded.config.healthcheck.tcp;
    return tcp === undefined ? "no tcp probe" : "tcp:" + tcp;
  }

  /** Accessory readiness: container present and its declared TCP probe answers. */
  private async accessoryReady(member: GroupMember): Promise<boolean> {
    const config = member.loaded.config;
    const rt = runtimeFor(config.runtime);
    const name = accessoryContainerName(config);
    for (const host of hostTargets(config)) {
      const exec = new SshExecutor(connectOptionsFor(connectionForTarget(config, host)));
      try {
        const exists = await exec.run(docker.findByName(rt, name));
        if (exists.stdout.trim() === "") {
          console.error("  " + name + ": absent on " + host);
          return false;
        }
        if (config.healthcheck.tcp === undefined) {
          console.log("  " + name + ": present on " + host);
          continue;
        }
        const probe = tcpReadinessProbe(config, rt);
        const res = await exec.run(probe);
        if (res.code !== 0) {
          console.error("  " + name + ": tcp:" + config.healthcheck.tcp + " not ready on " + host);
          return false;
        }
        console.log("  " + name + ": ready (tcp:" + config.healthcheck.tcp + ") on " + host);
      } finally {
        await exec.close();
      }
    }
    return true;
  }
}
