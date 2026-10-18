import type { LoadedConfig } from "./config.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { resolveConnections } from "./hosts.ts";
import { runningEntry } from "./revisions.ts";
import { listRevisions } from "./rollback.ts";

/**
 * `history` — the kubectl rollout history equivalent: every retained revision
 * of this service, newest first, with its state and the revision currently
 * serving traffic.
 */
export async function history(loaded: LoadedConfig): Promise<number> {
  for (const conn of resolveConnections(loaded.config)) {
    const host = conn.sshTarget;
    const exec = new SshExecutor(connectOptionsFor(conn));
    try {
      const entries = await listRevisions(exec, loaded);
      const running = runningEntry(entries);
      console.log("== " + host + " (" + loaded.config.service + "-" + loaded.config.role + ") ==");
      if (entries.length === 0) {
        console.log("  no revisions");
        continue;
      }
      entries.forEach((entry) => {
        const marker = entry === running ? "*" : " ";
        console.log(
          " " + marker + " " + entry.revision.padEnd(14) + " " + entry.state.padEnd(28) +
            " " + entry.createdAt,
        );
      });
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
