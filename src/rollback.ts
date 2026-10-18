import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor } from "./exec/ssh.ts";
import { waitUntilHealthy } from "./health.ts";
import { runtimeFor } from "./runtime.ts";

export interface RevisionEntry {
  name: string;
  createdAt: string;
}

/** Parse docker ps -a listing output ("name createdAt" per line). */
export function parseListing(stdout: string): RevisionEntry[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const sp = line.indexOf(" ");
      return { name: line.slice(0, sp), createdAt: line.slice(sp + 1).trim() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // same host TZ -> consistent order
}

/**
 * Pure selection: entries sorted newest-first; current = entries[0],
 * rollback target = entries[n] (n = 1 means the previous revision).
 */
export function selectRollbackTarget(
  entries: RevisionEntry[],
  n: number,
): { current: RevisionEntry; target: RevisionEntry } | null {
  if (entries.length < 2 || n >= entries.length) return null;
  return { current: entries[0], target: entries[n] };
}

/** Stop new, start old: docker start on the stopped revision, re-gate, re-swap. */
export async function rollback(loaded: LoadedConfig, n: number): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const svcId = proxy.serviceId(config.service, config.role);

  for (const host of config.hosts) {
    const exec = new SshExecutor({ host });
    try {
      const listing = await exec.run(docker.listForSelection(rt, config.service, config.role));
      if (listing.code !== 0) {
        console.error("[" + host + "] cannot list revisions: " + listing.stderr.trim());
        return 1;
      }
      const entries = parseListing(listing.stdout);
      const sel = selectRollbackTarget(entries, n);
      if (!sel) {
        console.error(
          "[" + host + "] nothing to roll back to (need " + (n + 1) +
            "+ revisions, found " + entries.length + ")",
        );
        return 1;
      }

      console.log("[" + host + "] rollback: " + sel.current.name + " -> " + sel.target.name);

      const startRes = await exec.run(docker.start(rt, sel.target.name));
      if (startRes.code !== 0) {
        console.error("[" + host + "] start failed: " + startRes.stderr.trim());
        return 1;
      }

      await waitUntilHealthy(
        exec,
        docker.probe(rt, sel.target.name, config.healthcheck.port, config.healthcheck.path),
        { timeoutMs: config.healthcheck.timeout * 1000 },
      );
      console.log("[" + host + "] health gate passed on " + sel.target.name);

      if (config.proxy.enabled) {
        const swap = await exec.run(
          proxy.deploy(rt, svcId, sel.target.name + ":" + config.proxy.port, {
            host: config.proxy.host,
            tls: config.proxy.tls,
            healthCheckPath: config.healthcheck.path,
            healthCheckPort:
              config.healthcheck.port === config.proxy.port ? undefined : config.healthcheck.port,
          }),
        );
        if (swap.code !== 0) {
          console.error("[" + host + "] proxy swap failed: " + swap.stderr.trim());
          return 1;
        }
      }

      if (sel.current.name !== sel.target.name) {
        await exec.run(docker.stop(rt, sel.current.name));
      }
      console.log("[" + host + "] rolled back to " + sel.target.name);
    } finally {
      await exec.close();
    }
  }
  return 0;
}
