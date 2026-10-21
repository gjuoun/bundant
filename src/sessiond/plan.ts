import type { ContainerSpec } from "../adapters/types.ts";
import { LABEL_KIND, LABEL_MANAGED, LABEL_SERVICE } from "../labels.ts";

/**
 * Pure sessiond facts: the container it runs in, the paths it owns and the
 * fold from signed ndjson to a status view. No I/O lives here.
 */

export const SESSIOND_CONTAINER = "bundant-sessiond";
export const SESSIOND_SOCKET_DIR = "/run/bundant";
export const SESSIOND_SOCKET = SESSIOND_SOCKET_DIR + "/sessiond.sock";
export const SESSIOND_LOG_DIR = "/var/lib/bundant";
export const SESSIOND_LOG = SESSIOND_LOG_DIR + "/sessions.ndjson";
export const SESSIOND_IMAGE = "bundant/sessiond:0.1.0";
export const SESSIOND_SERVICE = "sessiond";

/** The per-arch tags build.sh produces. */
export function sessiondImageFor(arch: string, base = SESSIOND_IMAGE): string {
  return base + "-" + arch;
}

export const SESSIOND_LABELS: Record<string, string> = {
  [LABEL_MANAGED]: "true",
  [LABEL_KIND]: SESSIOND_SERVICE,
  // Not bundant.service: a service label would make selector/deploy paths
  // treat the sidecar as a deployable unit.
};

/**
 * The hardening the card pins: no network, host pid namespace (pidfd/SO_PEERCRED
 * must see agent pids), host cgroup namespace (the cgroup v2 fallback reads the
 * host hierarchy), read-only root, no privileges, and only the two state dirs
 * writable.
 */
export function sessiondSpec(image: string): ContainerSpec {
  return {
    image,
    name: SESSIOND_CONTAINER,
    env: [],
    labels: SESSIOND_LABELS,
    volumes: [
      SESSIOND_SOCKET_DIR + ":" + SESSIOND_SOCKET_DIR,
      SESSIOND_LOG_DIR + ":" + SESSIOND_LOG_DIR,
      "/sys/fs/cgroup:/sys/fs/cgroup:ro",
    ],
    restart: "unless-stopped",
    network: "none",
    pidMode: "host",
    cgroupns: "host",
    readonly: true,
    securityOpt: ["no-new-privileges"],
  };
}

/** "hostPort:containerPort/proto" is irrelevant here; exported for the plan. */
export function sessiondRunArgs(image: string): string[] {
  const spec = sessiondSpec(image);
  return [
    "run",
    "-d",
    "--name",
    spec.name,
    "--network=none",
    "--pid=host",
    "--cgroupns=host",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    ...spec.volumes!.flatMap((bind) => ["-v", bind]),
    image,
  ];
}

export interface SessionEvent {
  v?: number;
  time: string;
  event: string;
  session: string;
  agent?: string;
  pid?: number;
  mode?: string;
  host?: string;
  pub?: string;
  sig?: string;
  raw?: string;
}

export interface OpenSession {
  session: string;
  agent?: string;
  pid?: number;
  mode: string;
  openedAt: string;
}

export interface SessiondEvents {
  events: number;
  /** Closed events remove the session; a repeatedly re-opened id stays open. */
  sessions: OpenSession[];
  /** The most recent mode reported, or "unknown" before the first event. */
  mode: string;
  /** pidfd is the only non-degraded watch mechanism. */
  degraded: boolean;
  malformed: number;
}

function parseLine(line: string): SessionEvent | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.event !== "string" || typeof value.session !== "string") return undefined;
    return {
      v: typeof value.v === "number" ? value.v : undefined,
      time: typeof value.time === "string" ? value.time : "",
      event: value.event,
      session: value.session,
      ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
      ...(typeof value.sig === "string" ? { sig: value.sig } : {}),
      raw: line,
    };
  } catch {
    return undefined;
  }
}

/** Fold the append-only log. Order is the log's order (no clock sorting). */
export function foldSessionEvents(text: string): SessiondEvents {
  const open = new Map<string, OpenSession>();
  let events = 0;
  let malformed = 0;
  let mode = "unknown";
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLine(line);
    if (entry === undefined) {
      malformed += 1;
      continue;
    }
    events += 1;
    if (entry.mode !== undefined && entry.mode !== "") mode = entry.mode;
    if (entry.event === "session.open") {
      open.set(entry.session, {
        session: entry.session,
        ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        mode: entry.mode ?? "unknown",
        openedAt: entry.time,
      });
    } else if (entry.event === "session.closed") {
      open.delete(entry.session);
    }
  }
  const sessions = [...open.values()];
  const degraded = sessions.some((session) => session.mode !== "pidfd") || mode === "poll" ||
    mode === "cgroupv2";
  return { events, sessions, mode, degraded, malformed };
}

export interface SessiondHostStatus {
  host: string;
  container: string;
  running: boolean;
  state: string;
  image: string;
  degraded: boolean;
  mode: string;
  sessions: OpenSession[];
  events: number;
  logPath: string;
}
