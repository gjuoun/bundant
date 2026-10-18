import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
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

/**
 * Pure selection: stop-worthy container names = entries beyond the newest
 * keep count that are NOT currently running. Running containers are never
 * pruned (a draining old revision waits for a later run).
 */
export function selectPrune(entries: PruneEntry[], running: Set<string>, keep: number): string[] {
  return entries
    .slice(keep)
    .filter((e) => !running.has(e.name))
    .map((e) => e.name);
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
      const victims = selectPrune(entries, runSet, opts.keep);

      console.log(
        "  revisions: " + entries.length + " total, " + runSet.size +
        " running, keeping newest " + opts.keep,
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
