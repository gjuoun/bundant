import type { RuntimeOps } from "../ops/types.ts";
import {
  SESSIOND_CONTAINER,
  SESSIOND_LOG,
  foldSessionEvents,
  type SessiondHostStatus,
} from "./plan.ts";

/**
 * One host's status: container truth from the engine, open sessions and the
 * degradation mode from the append-only log. A down container is degraded by
 * definition, even when the last event said pidfd.
 */
export async function statusOnHost(host: string, ops: RuntimeOps): Promise<SessiondHostStatus> {
  const rows = await ops.listContainers({ all: true });
  const row = rows.find((entry) => entry.name === SESSIOND_CONTAINER);
  const folded = foldSessionEvents(await ops.readFile(SESSIOND_LOG));
  const running = row?.state === "running";
  return {
    host,
    container: SESSIOND_CONTAINER,
    running,
    state: row?.state ?? "absent",
    image: row?.image ?? "",
    degraded: !running || folded.degraded,
    mode: folded.mode,
    sessions: folded.sessions,
    events: folded.events,
    logPath: SESSIOND_LOG,
  };
}

export function renderStatus(status: SessiondHostStatus): string {
  const lines: string[] = [];
  lines.push("== " + status.host + " ==");
  lines.push("  container: " + status.container + " (" + status.state + ")");
  lines.push("  image: " + (status.image === "" ? "-" : status.image));
  lines.push(
    "  watch: " + status.mode + (status.degraded ? " (degraded)" : " (pidfd)"),
  );
  lines.push("  sessions: " + status.sessions.length + " open / " + status.events + " events");
  for (const session of status.sessions) {
    lines.push(
      "    " + session.session + " agent=" + (session.agent ?? "-") + " pid=" +
        (session.pid ?? "-") + " mode=" + session.mode,
    );
  }
  return lines.join("\n");
}
