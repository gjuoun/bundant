import type { LoadedConfig } from "./config.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { resolveConnections } from "./hosts.ts";
import { summarizeRevisions } from "./revisions.ts";
import { listRevisions } from "./rollback.ts";

/**
 * `history` — the kubectl rollout history equivalent, grouped by revision:
 * one row per revision (not per container) with its replica count, state and
 * the revision currently serving traffic.
 */
export async function history(loaded: LoadedConfig): Promise<number> {
  for (const conn of resolveConnections(loaded.config)) {
    const host = conn.sshTarget;
    const exec = new SshExecutor(connectOptionsFor(conn));
    try {
      const entries = await listRevisions(exec, loaded);
      const summaries = summarizeRevisions(
        entries,
        loaded.config.service,
        loaded.config.role,
      );
      console.log(
        "== " + host + " (" + loaded.config.service + "-" + loaded.config.role + ") ==",
      );
      if (summaries.length === 0) {
        console.log("  no revisions");
        continue;
      }
      for (const summary of summaries) {
        const marker = summary.running ? "*" : " ";
        const replicas =
          summary.containers.length === 1
            ? "1 replica"
            : summary.containers.length + " replicas";
        console.log(
          " " + marker + " " + summary.revision.padEnd(14) + " " +
            replicas.padEnd(12) + " " + summary.state.padEnd(24) + " " + summary.createdAt,
        );
      }
      console.log("  * = running revision");
    } catch (e) {
      console.error("[" + host + "] " + (e as Error).message);
      return 1;
    } finally {
      await exec.close();
    }
  }
  return 0;
}
