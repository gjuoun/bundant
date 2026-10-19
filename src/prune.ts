import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { hostTargets, connectionForTarget } from "./hosts.ts";
import { parseHistory, revisionOf, type RevisionEntry } from "./revisions.ts";
import { runtimeFor } from "./runtime.ts";
import { belongsToService, serviceLabels } from "./naming.ts";
import { openOps, type OpsVia } from "./ops/index.ts";

export interface PruneEntry {
  name: string;
  createdAt: string;
}

export interface PruneOptions {
  keep: number;
  dryRun: boolean;
  /** Mutations through the engine API (default) or the legacy CLI strings. */
  via?: OpsVia;
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
  group?: string,
): PruneGroup[] {
  const groups = new Map<string, PruneGroup>();
  for (const entry of entries) {
    const revision = revisionOf(entry.name, service, role, group);
    const bucket = groups.get(revision) ?? { revision, newest: entry.createdAt, entries: [] };
    bucket.entries.push(entry);
    if (entry.createdAt > bucket.newest) bucket.newest = entry.createdAt;
    groups.set(revision, bucket);
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
  group?: string,
): string[] {
  const victims: string[] = [];
  for (const bucket of groupByRevision(entries, service, role, group).slice(keep)) {
    for (const entry of bucket.entries) {
      if (!running.has(entry.name)) victims.push(entry.name);
    }
  }
  return victims;
}

function labelsFor(config: LoadedConfig["config"]): Record<string, string> {
  return serviceLabels(config);
}

function entriesOf(history: RevisionEntry[]): PruneEntry[] {
  return history.map((e) => ({ name: e.name, createdAt: e.createdAt }));
}

/**
 * Remove stopped revision containers beyond the newest K, then dangling
 * image layers. dryRun prints the calls/commands instead of executing.
 */
export async function prune(loaded: LoadedConfig, opts: PruneOptions): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const via: OpsVia = opts.via ?? "api";

  for (const host of hostTargets(config)) {
    console.log("== " + host + " ==");
    if (opts.dryRun) {
      if (via === "cli") {
        console.log("  (dry-run) " + docker.listHistoryByLabels(rt, labelsFor(config)));
        console.log(
          "  (dry-run) " + rt.bin + " rm <stopped " + config.service + "-" + config.role +
          "-* revisions beyond the newest " + opts.keep + ", never running ones>",
        );
        console.log("  (dry-run) " + docker.imagePrune(rt));
      } else {
        const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labelsFor(config)).map(([k, v]) => k + "=" + v) }));
        console.log("  (dry-run) GET /containers/json?all=1&filters=" + filters);
        console.log(
          "  (dry-run) DELETE /containers/<stopped " + config.service + "-" + config.role +
          "-* revisions beyond the newest " + opts.keep + ", never running ones>?force=1",
        );
        console.log("  (dry-run) POST /images/prune?filters=" + encodeURIComponent(JSON.stringify({ dangling: { "true": true } })));
      }
      continue;
    }

    const ops = await openOps(via, connectionForTarget(config, host), config);
    try {
      const history = await ops.history(labelsFor(config), config);
      const entries = entriesOf(history);
      const runSet = new Set(history.filter((e) => e.state.startsWith("Up")).map((e) => e.name));
      const groups = groupByRevision(entries, config.service, config.role, config.group);
      const victims = selectPrune(entries, runSet, opts.keep, config.service, config.role, config.group);

      console.log(
        "  revisions: " + groups.length + " (" + entries.length + " containers), " +
        runSet.size + " running, keeping newest " + opts.keep + " revision(s)",
      );

      if (victims.length === 0) console.log("  nothing to prune");
      for (const v of victims) {
        await ops.removeContainer(v);
        console.log("  removed " + v);
      }

      await ops.pruneImages();
      console.log("  dangling images pruned");
    } catch (e) {
      console.error("  " + (e as Error).message);
      return 1;
    } finally {
      await ops.close();
    }
  }
  return 0;
}
