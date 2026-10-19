import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { revisionOf } from "./revisions.ts";
import { runtimeFor } from "./runtime.ts";

export interface PruneEntry {
  name: string;
  createdAt: string;
}

/** Parse "name createdAt" listing, newest first. */
export function parsePruneListing(stdout: string): PruneEntry[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const sp = line.indexOf(" ");
      return { name: line.slice(0, sp), createdAt: line.slice(sp + 1).trim() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** One revision and all the container entries that belong to it. */
export interface PruneGroup {
  revision: string;
  /** Newest createdAt in the group (the ordering key). */
  newest: string;
  entries: PruneEntry[];
}

/** Group container entries by revision, newest revision first. */
export function groupByRevision(
  entries: PruneEntry[],
  service?: string,
  role?: string,
): PruneGroup[] {
  const groups = new Map<string, PruneGroup>();
  for (const entry of entries) {
    const revision = revisionOf(entry.name, service, role);
    const group = groups.get(revision) ?? { revision, newest: entry.createdAt, entries: [] };
    group.entries.push(entry);
    if (entry.createdAt > group.newest) group.newest = entry.createdAt;
    groups.set(revision, group);
  }
  return [...groups.values()].sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0));
}

/**
 * Pure selection: keep the newest K *revisions* with all of their replicas,
 * and remove every stopped container of the older revisions. Running
 * containers are never pruned (a draining old revision waits for a later run).
 */
export function selectPrune(
  entries: PruneEntry[],
  running: Set<string>,
  keep: number,
  service?: string,
  role?: string,
): string[] {
  const victims: string[] = [];
  for (const group of groupByRevision(entries, service, role).slice(keep)) {
    for (const entry of group.entries) {
      if (!running.has(entry.name)) victims.push(entry.name);
    }
  }
  return victims;
}

/**
 * Remove stopped revision containers beyond the newest K, then dangling
 * image layers. dryRun prints the exact commands instead of executing.
 */
export async function prune(
  loaded: LoadedConfig,
  opts: { keep: number; dryRun: boolean },
): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);

  for (const host of hostTargets(config)) {
    if (opts.dryRun) {
      console.log("== " + host + " ==");
      console.log("  (dry-run) " + docker.listForSelection(rt, config.service, config.role));
      console.log(
        "  (dry-run) " + rt.bin + " rm <stopped " + config.service + "-" + config.role +
        "-* revisions beyond the newest " + opts.keep + ", never running ones>",
      );
      console.log("  (dry-run) " + docker.imagePrune(rt));
      continue;
    }

    const exec = new SshExecutor(connectOptionsFor(connectionForTarget(config, host)));
    try {
      console.log("== " + host + " ==");
      const all = await exec.run(docker.listForSelection(rt, config.service, config.role));
      if (all.code !== 0) {
        console.error("  cannot list revisions: " + all.stderr.trim());
        return 1;
      }
      const running = await exec.run(docker.listRunning(rt, config.service, config.role));
      const entries = parsePruneListing(all.stdout);
      const runSet = new Set(
        running.stdout.trim().split("\n").filter((l) => l.trim() !== ""),
      );
      const groups = groupByRevision(entries, config.service, config.role);
      const victims = selectPrune(entries, runSet, opts.keep, config.service, config.role);

      console.log(
        "  revisions: " + groups.length + " (" + entries.length + " containers), " +
        runSet.size + " running, keeping newest " + opts.keep + " revision(s)",
      );

      if (victims.length === 0) {
        console.log("  nothing to prune");
      }
      for (const v of victims) {
        const cmd = rt.bin + " rm " + v;
        const r = await exec.run(cmd);
        if (r.code !== 0) {
          console.error("  rm failed: " + v + " — " + r.stderr.trim());
          return 1;
        }
        console.log("  removed " + v);
      }

      const imgCmd = docker.imagePrune(rt);
      const img = await exec.run(imgCmd);
      if (img.code !== 0) {
        console.error("  image prune failed: " + img.stderr.trim());
        return 1;
      }
      console.log("  dangling images pruned");
    } finally {
      await exec.close();
    }
  }
  return 0;
}
