import type { ExecResult } from "../types.ts";
import type { RuntimeKind } from "../runtime.ts";

export type { ExecResult, RuntimeKind };

/** Everything needed to create one container. Env is an array - no remote env file. */
export interface ContainerSpec {
  image: string;
  name: string;
  env: string[];
  labels: Record<string, string>;
  /** "volume:/path/in/container" entries. */
  volumes?: string[];
  /** Docker restart policy name (default unless-stopped). */
  restart?: "no" | "always" | "unless-stopped" | "on-failure";
  network?: string;
  /** Published ports, "hostPort:containerPort[/proto]". */
  ports?: string[];
  /** Command/args appended to the image entrypoint (health probes). */
  cmd?: string[];
  /** Container-level sysctls (rootless podman needs the proxy port floor). */
  sysctl?: Record<string, string>;
}

/** One row of GET /containers/json. */
export interface ContainerSummary {
  id: string;
  /** Leading slash stripped. */
  name: string;
  image: string;
  /** created | running | paused | restarting | removing | exited | dead. */
  state: string;
  /** Human status line ("Up 2 hours"). */
  status: string;
  labels: Record<string, string>;
  created: number;
  /** Published ports in CLI form: "0.0.0.0:80->80/tcp, 443/tcp". */
  ports: string;
}

/** The subset of GET /containers/{id}/json the CLI programs against. */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: {
    status: string;
    running: boolean;
    exitCode: number;
    startedAt?: string;
    restarts: number;
    /** Container health status; undefined when the container has no healthcheck. */
    health?: string;
  };
  labels: Record<string, string>;
  env: string[];
  restartPolicy: string;
  logDriver: string;
  binds: string[];
  networkMode: string;
  /** The engine's untouched inspect payload for fields the subset omits. */
  raw: unknown;
}

/** One point-in-time resource sample (GET /containers/{id}/stats?stream=false). */
export interface StatsSample {
  readAt: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
  networks: Record<string, { rxBytes: number; txBytes: number }>;
}

/** One line of GET /events. */
export interface RuntimeEvent {
  type: string;
  action: string;
  status?: string;
  id?: string;
  time: number;
  timeNano?: number;
  actor?: { id?: string; attributes?: Record<string, string> };
}

/**
 * The runtime contract. Stage 2 implements the read half; stage 3 fills the
 * container lifecycle + network mutations the deploy path needs.
 */
export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  /** From GET /version. */
  readonly engineVersion: string;
  readonly apiVersion: string;
  // images
  pull(ref: string): Promise<void>;
  /** True when the image ref is present locally (GET /images/{ref}/json). */
  imagePresent(ref: string): Promise<boolean>;
  /** Every image id the engine holds (GET /images/json). */
  imageIds(): Promise<string[]>;
  /** One image's ordered layer diffIDs (GET /images/{ref}/json RootFS.Layers). */
  imageLayers(ref: string): Promise<string[]>;
  loadImage(stream: NodeJS.ReadableStream, opts?: { contentLength?: number }): Promise<void>;
  removeImage(ref: string): Promise<void>;
  /** Remove dangling image layers (the old `image prune -f`). */
  pruneImages(): Promise<void>;
  // containers
  create(spec: ContainerSpec): Promise<{ id: string }>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSeconds?: number): Promise<void>;
  remove(id: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void>;
  inspect(id: string): Promise<ContainerInfo>;
  list(opts: { all?: boolean; labels?: Record<string, string>; namePrefix?: string }): Promise<ContainerSummary[]>;
  logs(id: string, opts?: { tail?: number; follow?: boolean }): AsyncIterable<string>;
  stats(id: string): Promise<StatsSample>;
  exec(id: string, argv: string[], opts?: { tty?: boolean }): Promise<ExecResult>;
  // volumes / networks
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  inspectVolume(name: string): Promise<{ labels: Record<string, string> }>;
  ensureNetwork(name: string): Promise<void>;
  // events
  events(opts?: { since?: number | string; until?: number | string; labels?: Record<string, string> }): AsyncIterable<RuntimeEvent>;
}

/** A mutating method reached before its stage. */
export class NotImplementedInStage1 extends Error {
  constructor(method: string) {
    super("RuntimeAdapter." + method + " is not implemented in stage 1 (read-only)");
    this.name = "NotImplementedInStage1";
  }
}
