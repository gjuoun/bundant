import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { ServiceIdentity } from "./domain/identity.ts";
import { SshExecutor } from "./exec/ssh.ts";
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
import { belongsToService, serviceLabels } from "./naming.ts";
import { openOps } from "./ops/index.ts";
import { assertPreflight } from "./validation.ts";
import { isJsonMode, recordFailure } from "./agent/emit.ts";
import { NotFoundError } from "./agent/errors.ts";
import { toAppError } from "./effect/errors.ts";

export interface RollbackOptions {
  /** Exact revision id (the kubectl --to-revision equivalent); omitted = previous revision. */
  toRevision?: string;
}

/** Read this service's revisions on one host, newest first (used by \`history\`). */
export async function listRevisions(
  exec: SshExecutor,
  loaded: LoadedConfig,
): Promise<RevisionEntry[]> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const listing = await exec.run(docker.listHistoryByLabels(rt, serviceLabels(config)));
  if (listing.code !== 0) {
    throw new Error("cannot list revisions: " + listing.stderr.trim());
  }
  return parseHistory(listing.stdout).filter((e) => belongsToService(e.name, config));
}

/**
 * Stop new, start old - by revision, never by container. Every replica the
 * target revision was deployed with is started and gated, the whole target set
 * swaps in one proxy deploy, and only then are the current replicas stopped.
 */
export async function rollback(loaded: LoadedConfig, opts: RollbackOptions = {}): Promise<number> {
  const { config } = loaded;
  assertPreflight(loaded);
  for (const conn of resolveConnections(config)) {
    const host = conn.sshTarget;
    const ops = await openOps(conn, config);
    try {
      const entries = await ops.history(serviceLabels(config), config);
      const summaries = summarizeRevisions(entries, config.service, config.role, config.group);

      let sel;
      try {
        sel =
          opts.toRevision !== undefined
            ? selectRevision(summaries, opts.toRevision)
            : selectPreviousRevision(summaries);
      } catch (e) {
        if (e instanceof RevisionNotFoundError) {
          if (isJsonMode()) {
            recordFailure(new NotFoundError({ message: e.message, target: opts.toRevision }));
          } else {
            console.error("[" + host + "] " + e.message);
          }
          return 1;
        }
        throw e;
      }

      if (!sel) {
        const message =
          "[" + host + "] nothing to roll back to (found " + summaries.length + " revision" +
          (summaries.length === 1 ? "" : "s") + ")";
        if (isJsonMode()) recordFailure(new NotFoundError({ message, target: opts.toRevision }));
        else console.error(message);
        return 1;
      }

      const target = sel.target;
      const current = sel.current;
      const targetNames = target.containers.map((c) => c.name);

      if (target.revision === current.revision) {
        console.log("[" + host + "] " + target.revision + " is already the current revision");
        return 0;
      }

      console.log(
        "[" + host + "] rollback: " + current.revision + " -> " +
          target.revision + " (" + targetNames.length + " replica(s) as deployed)",
      );

      for (const name of targetNames) await ops.startContainer(name);
      await ops.healthGate(targetNames, {
        path: config.healthcheck.path,
        port: config.healthcheck.port,
        timeoutMs: config.healthcheck.timeout * 1000,
      });
      console.log("[" + host + "] health gate passed on " + targetNames.join(", "));

      if (config.proxy.enabled) {
        await ops.proxyDeploy(
          ServiceIdentity.from(config).proxyId(),
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
        );
      }

      const stopNames = current.containers
        .map((c) => c.name)
        .filter((name) => !targetNames.includes(name));
      await ops.stopContainers(stopNames);
      console.log(
        "[" + host + "] rolled back to " + target.revision + " (" +
          targetNames.length + " replica(s))",
      );
    } catch (e) {
      if (isJsonMode()) recordFailure(toAppError(e));
      else console.error("[" + host + "] " + (e as Error).message);
      return 1;
    } finally {
      await ops.close();
    }
  }
  return 0;
}

