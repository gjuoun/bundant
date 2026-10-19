import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { resolveConnections } from "./hosts.ts";
import { parseHistory, replicaOf, revisionOf } from "./revisions.ts";
import { runtimeFor } from "./runtime.ts";
import { belongsToService, serviceLabels } from "./naming.ts";

/** One line of `ps -a` output, reduced to what status reports. */
export interface StatusLine {
  name: string;
  state: string;
}

/** Running replicas of one revision, in index order. */
export interface LiveReplica {
  index: number;
  name: string;
}

export function parseStatusLines(stdout: string): StatusLine[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const sp = line.indexOf(" ");
      return sp === -1
        ? { name: line, state: "" }
        : { name: line.slice(0, sp), state: line.slice(sp + 1).trim() };
    });
}

/**
 * Live replicas of the revision that is actually running. The newest running
 * revision wins; within it, replicas are ordered by their index.
 */
export function liveReplicas(
  lines: StatusLine[],
  service: string,
  role: string,
  group?: string,
): { revision: string | undefined; replicas: LiveReplica[] } {
  const running = lines.filter((l) => l.state.startsWith("Up"));
  const counts = new Map<string, number>();
  for (const line of running) {
    const rev = revisionOf(line.name, service, role, group);
    counts.set(rev, (counts.get(rev) ?? 0) + 1);
  }
  const revision = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (revision === undefined) return { revision: undefined, replicas: [] };
  const replicas = running
    .filter((l) => revisionOf(l.name, service, role, group) === revision)
    .map((l) => ({ index: replicaOf(l.name, service, role, group) ?? 1, name: l.name }))
    .sort((a, b) => a.index - b.index);
  return { revision, replicas };
}

/** Human line: "live 3 / expected 3" plus a drift marker. */
export function replicaSummary(live: number, expected: number): string {
  const drift = live === expected ? "" : "  <- drift (deploy.yml says " + expected + ")";
  return "replicas: live " + live + " / expected " + expected + drift;
}

/** Per-host truth: every replica of the running revision, proxy routing, live health. */
export async function status(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  const expected = config.replicas ?? 1;
  let exit = 0;

  for (const conn of resolveConnections(config)) {
    const exec = new SshExecutor(connectOptionsFor(conn));
    console.log("== " + conn.sshTarget + " ==");

    const ps = await exec.run(docker.listHistoryByLabels(rt, serviceLabels(config)));
    if (ps.code !== 0) {
      console.log("  containers: query failed — " + ps.stderr.trim());
      exit = 1;
    } else {
      const lines: StatusLine[] = parseHistory(ps.stdout)
        .filter((e) => belongsToService(e.name, config))
        .map((e) => ({ name: e.name, state: e.state }));
      if (lines.length === 0) console.log("  containers: none");
      for (const line of lines) {
        const index = replicaOf(line.name, config.service, config.role, config.group);
        console.log(
          "  " + line.name +
            (index !== undefined ? " [replica " + index + "]" : "") + "  " + line.state,
        );
      }

      const live = liveReplicas(lines, config.service, config.role, config.group);
      console.log("  " + replicaSummary(live.replicas.length, expected));
      if (live.revision !== undefined) {
        console.log("  revision: " + live.revision);
      }

      for (const replica of live.replicas) {
        const probe = await exec.run(
          docker.probe(rt, replica.name, config.healthcheck.port, config.healthcheck.path),
        );
        console.log(
          "  health(" + replica.name + "): HTTP " + (probe.stdout.trim() || "err"),
        );
      }
      if (live.replicas.length === 0) console.log("  health: no running container");
    }

    const proxyUp = await exec.run(docker.inspectRunning(rt, proxy.PROXY_CONTAINER));
    if (proxyUp.stdout.trim() === "true") {
      const list = await exec.run(proxy.list(rt));
      const rows = list.stdout.trim().split("\n").filter((l) => l !== "");
      console.log("  proxy (" + proxy.PROXY_CONTAINER + "):");
      for (const row of rows) console.log("    " + row);
    } else {
      console.log("  proxy: not running");
    }

    await exec.close();
  }
  return exit;
}
