import type { ContainerInfo, ContainerSpec, ContainerSummary } from "../adapters/types.ts";
import type { BundantConfig } from "../config.ts";
import type { RevisionEntry } from "../revisions.ts";

/** Execution backend for a mutating command: the engine API (default) or the legacy CLI strings. */
export type OpsVia = "api" | "cli";

/** Image pull policy: missing (default), always, never. */
export type PullPolicy = "missing" | "always" | "never";

export interface HealthGateOptions {
  /** HTTP path the gate probes. */
  path: string;
  /** Container port the gate probes. */
  port: number;
  /** Give up after this long. */
  timeoutMs: number;
  /** Gap between attempts (default 500ms). */
  intervalMs?: number;
}

export interface ProxyDeployOptions {
  host?: string;
  tls: boolean;
  healthCheckPath?: string;
  healthCheckPort?: number;
}

/**
 * Semantic operations the deploy/rollback/prune orchestrators program against.
 * Implementations decide *how* (API calls or ssh CLI strings); callers never
 * build a command and never choose a driver.
 *
 * \`steps\` is the semantic trace of what happened. It is what the equivalence
 * test compares between the two implementations, and it is also what makes a
 * dry-run honest.
 */
export interface RuntimeOps {
  readonly via: OpsVia;
  readonly steps: string[];

  /** Host-side prerequisites the engine API cannot express (systemd, sysctl). */
  hostPrereqs(): Promise<void>;
  /** Upload the merged env file (legacy) or note that Env rides the API call. */
  putEnv(localFile: string | null, remotePath: string | undefined, count: number): Promise<void>;

  /** Whether the image ref is already on the host. */
  imagePresent(image: string): Promise<boolean>;
  pull(image: string): Promise<void>;
  /** Every layer diffID present in any image on the host. */
  imageLayers(): Promise<Set<string>>;
  /** Stream a save/OCI archive into the engine's POST /images/load. */
  loadImage(stream: NodeJS.ReadableStream): Promise<void>;
  ensureNetwork(): Promise<void>;

  removeContainer(name: string, opts?: { force?: boolean }): Promise<void>;
  createContainer(spec: ContainerSpec): Promise<string>;
  startContainer(name: string): Promise<void>;
  stopContainers(names: string[]): Promise<void>;
  listContainers(opts: {
    all?: boolean;
    labels?: Record<string, string>;
    namePrefix?: string;
  }): Promise<ContainerSummary[]>;
  inspectContainer(name: string): Promise<ContainerInfo>;
  removeImage(ref: string): Promise<void>;

  healthGate(names: string[], opts: HealthGateOptions): Promise<void>;
  proxyEnsure(image: string): Promise<void>;
  proxyDeploy(serviceId: string, targets: string[], opts: ProxyDeployOptions): Promise<void>;

  /** Stop every revision of this service-role except \`keep\` (accessories are never touched). */
  stopOld(
    config: Pick<BundantConfig, "service" | "role" | "group">,
    keep: string[],
  ): Promise<void>;

  /** Label-selected revision history, newest first, filtered to this service-role. */
  history(
    labels: Record<string, string>,
    config: Pick<BundantConfig, "service" | "role" | "group">,
  ): Promise<RevisionEntry[]>;

  /** Service ids currently registered with kamal-proxy (empty when absent). */
  proxyList(): Promise<string[]>;
  /** kamal-proxy remove, tolerated when the proxy or the route is absent. */
  proxyRemove(serviceId: string): Promise<void>;
  /** Delete a legacy rendered env file (API path never writes one). */
  removeEnv(remotePath: string): Promise<void>;
  /** Accessory logs (static tail). */
  logs(name: string, tail: number): Promise<string>;
  /** A bare TCP connect from a sidecar must succeed (accessory readiness). */
  tcpGate(name: string, port: number, opts: HealthGateOptions): Promise<void>;

  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  inspectVolume(name: string): Promise<{ labels: Record<string, string> }>;

  pruneImages(): Promise<void>;
  close(): Promise<void>;
}
