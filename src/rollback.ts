import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor } from "./exec/ssh.ts";
import { waitUntilHealthy } from "./health.ts";
import { hostTargets } from "./hosts.ts";
import {
  type RevisionEntry,
  RevisionNotFoundError,
  parseHistory,
  selectByRevision,
  selectPrevious,
} from "./revisions.ts";
import { runtimeFor } from "./runtime.ts";

export interface RollbackOptions {
  /** Exact revision id (the kubectl --to-revision equivalent); omitted = previous revision. */
  toRevision?: string;
}

/** Read this service's revisions on one host, newest first. */
export async function listRevisions(
  exec: SshExecutor,
  loaded: LoadedConfig,
): Promise<RevisionEntry[]> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const listing = await exec.run(docker.listHistory(rt, config.service, config.role));
  if (listing.code !== 0) {
    throw new Error("cannot list revisions: " + listing.stderr.trim());
  }
  return parseHistory(listing.stdout);
}

/**
 * Stop new, start old: start the target revision, re-gate its health, re-point
 * the proxy, then stop the revision that was serving.
 */
export async function rollback(loaded: LoadedConfig, opts: RollbackOptions = {}): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const svcId = proxy.serviceId(config.service, config.role);

  for (const host of hostTargets(config)) {
    const exec = new SshExecutor({ host });
    try {
      const entries = await listRevisions(exec, loaded);

      let sel;
      try {
        sel = opts.toRevision !== undefined
          ? selectByRevision(entries, opts.toRevision)
          : selectPrevious(entries);
      } catch (e) {
        if (e instanceof RevisionNotFoundError) {
          console.error("[" + host + "] " + e.message);
          return 1;
        }
        throw e;
      }

      if (!sel) {
        console.error(
          "[" + host + "] nothing to roll back to (found " + entries.length + " revision" +
            (entries.length === 1 ? "" : "s") + ")",
        );
        return 1;
      }

      if (sel.target.name === sel.current.name) {
        console.log("[" + host + "] " + sel.target.name + " is already the current revision");
        return 0;
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

      await exec.run(docker.stop(rt, sel.current.name));
      console.log("[" + host + "] rolled back to " + sel.target.name);
    } catch (e) {
      console.error("[" + host + "] " + (e as Error).message);
      return 1;
    } finally {
      await exec.close();
    }
  }
  return 0;
}
