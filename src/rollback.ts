import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { waitUntilHealthy } from "./health.ts";
import { resolveConnections } from "./hosts.ts";
import {
  type RevisionEntry,
  RevisionNotFoundError,
  parseHistory,
  selectPreviousRevision,
  selectRevision,
  summarizeRevisions,
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
 * Stop new, start old — by revision, never by container. Every replica the
 * target revision was deployed with is started and gated, the whole target set
 * swaps in one proxy deploy, and only then are the current replicas stopped.
 */
export async function rollback(loaded: LoadedConfig, opts: RollbackOptions = {}): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const svcId = proxy.serviceId(config.service, config.role);

  for (const conn of resolveConnections(config)) {
    const host = conn.sshTarget;
    const exec = new SshExecutor(connectOptionsFor(conn));
    try {
      const entries = await listRevisions(exec, loaded);
      const summaries = summarizeRevisions(entries, config.service, config.role);

      let sel;
      try {
        sel =
          opts.toRevision !== undefined
            ? selectRevision(summaries, opts.toRevision)
            : selectPreviousRevision(summaries);
      } catch (e) {
        if (e instanceof RevisionNotFoundError) {
          console.error("[" + host + "] " + e.message);
          return 1;
        }
        throw e;
      }

      if (!sel) {
        console.error(
          "[" + host + "] nothing to roll back to (found " + summaries.length + " revision" +
            (summaries.length === 1 ? "" : "s") + ")",
        );
        return 1;
      }

      const target = sel.target;
      const current = sel.current;
      const targetNames = target.containers.map((c) => c.name);

      if (target.revision === current.revision) {
        console.log(
          "[" + host + "] " + target.revision + " is already the current revision",
        );
        return 0;
      }

      console.log(
        "[" + host + "] rollback: " + current.revision + " -> " + target.revision +
        " (" + targetNames.length + " replica(s) as deployed)",
      );

      for (const name of targetNames) {
        const startRes = await exec.run(docker.start(rt, name));
        if (startRes.code !== 0) {
          console.error("[" + host + "] start failed for " + name + ": " + startRes.stderr.trim());
          return 1;
        }
      }
      for (const name of targetNames) {
        await waitUntilHealthy(
          exec,
          docker.probe(rt, name, config.healthcheck.port, config.healthcheck.path),
          { timeoutMs: config.healthcheck.timeout * 1000 },
        );
      }
      console.log("[" + host + "] health gate passed on " + targetNames.join(", "));

      if (config.proxy.enabled) {
        const swap = await exec.run(
          proxy.deploy(
            rt,
            svcId,
            targetNames.map((n) => n + ":" + config.proxy.port),
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
        );
        if (swap.code !== 0) {
          console.error("[" + host + "] proxy swap failed: " + swap.stderr.trim());
          return 1;
        }
      }

      for (const container of current.containers) {
        if (targetNames.includes(container.name)) continue;
        await exec.run(docker.stop(rt, container.name));
      }
      console.log(
        "[" + host + "] rolled back to " + target.revision + " (" +
          targetNames.length + " replica(s))",
      );
    } catch (e) {
      console.error("[" + host + "] " + (e as Error).message);
      return 1;
    } finally {
      await exec.close();
    }
  }
  return 0;
}
