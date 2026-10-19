import type { RuntimeKind } from "../runtime.ts";

/**
 * Runtime detection: probe the known unix sockets, ask GET /version, and let
 * the response's components say which engine answers. deploy.yml's runtime:
 * stays authoritative — a disagreement is an error, never a silent override.
 */

export interface VersionComponent {
  Name?: string;
  Version?: string;
  /** Podman reports its REST API version here, not in the top-level ApiVersion. */
  Details?: { APIVersion?: string; MinAPIVersion?: string };
}

export interface VersionPayload {
  Version?: string;
  ApiVersion?: string;
  MinAPIVersion?: string;
  Components?: VersionComponent[];
}

export interface EngineVersion {
  kind: RuntimeKind;
  version: string;
  apiVersion: string;
  minApiVersion?: string;
}

export type SocketState = "active" | "inactive" | "absent";

export interface CandidateResult {
  socketPath: string;
  state: SocketState;
  engine?: EngineVersion;
  error?: string;
}

export interface RuntimeDetection {
  found: boolean;
  kind?: RuntimeKind;
  engineVersion?: string;
  apiVersion?: string;
  socketPath?: string;
  state: SocketState;
  candidates: CandidateResult[];
}

export interface SocketProbe {
  socketPath: string;
  probe(): Promise<VersionPayload>;
  /** Release the transport created for this probe (forward socket). */
  dispose?(): Promise<void>;
}

export interface DetectOptions {
  probes: SocketProbe[];
  /** deploy.yml runtime: — when set, detection must agree. */
  expect?: RuntimeKind;
}

export class DetectionError extends Error {
  readonly detection: RuntimeDetection;

  constructor(message: string, detection: RuntimeDetection) {
    super(message);
    this.name = "DetectionError";
    this.detection = detection;
  }
}

/** Probe order from the design doc: docker, system podman, rootless podman. */
export function socketCandidates(uid: number | string = 0): string[] {
  return ["/var/run/docker.sock", "/run/podman/podman.sock", "/run/user/" + uid + "/podman/podman.sock"];
}

export function parseEngineVersion(payload: VersionPayload): EngineVersion {
  const components = Array.isArray(payload.Components) ? payload.Components : [];
  const names = components.map((c) => String(c.Name ?? "").toLowerCase());
  const kind: RuntimeKind = names.some((n) => n.includes("podman")) ? "podman" : "docker";
  const engineComponent = components.find((c) => String(c.Name ?? "").toLowerCase().includes("engine"));
  // Podman's compat /version carries the Docker-compat ApiVersion (1.41) at
  // the top level and Podman's own REST API version in the engine component's
  // Details. Report the engine's API version, which is what "podman api" means.
  const apiVersion =
    kind === "podman"
      ? engineComponent?.Details?.APIVersion ?? payload.ApiVersion ?? "unknown"
      : payload.ApiVersion ?? "unknown";
  return {
    kind,
    version: payload.Version ?? engineComponent?.Version ?? "unknown",
    apiVersion,
    minApiVersion: engineComponent?.Details?.MinAPIVersion ?? payload.MinAPIVersion,
  };
}

function classifyError(err: unknown): { state: SocketState; error: string } {
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT") return { state: "absent", error: message };
  // ECONNREFUSED / EACCES / a refused remote streamlocal forward: the path is
  // there (or the host says it is), but no service answers on it.
  return { state: "inactive", error: message };
}

export function formatCandidates(candidates: CandidateResult[]): string {
  return candidates.map((c) => c.socketPath + "=" + c.state).join(", ");
}

export async function detectRuntime(opts: DetectOptions): Promise<RuntimeDetection> {
  const candidates: CandidateResult[] = [];

  for (const probe of opts.probes) {
    try {
      const payload = await probe.probe();
      const engine = parseEngineVersion(payload);
      candidates.push({ socketPath: probe.socketPath, state: "active", engine });
    } catch (err) {
      const classified = classifyError(err);
      candidates.push({ socketPath: probe.socketPath, state: classified.state, error: classified.error });
    } finally {
      await probe.dispose?.().catch(() => undefined);
    }
  }

  const active = candidates.filter((c) => c.state === "active" && c.engine !== undefined);
  const matching =
    opts.expect === undefined ? active[0] : active.find((c) => c.engine?.kind === opts.expect);

  if (matching !== undefined) {
    const engine = matching.engine!;
    return {
      found: true,
      kind: engine.kind,
      engineVersion: engine.version,
      apiVersion: engine.apiVersion,
      socketPath: matching.socketPath,
      state: "active",
      candidates,
    };
  }

  if (opts.expect !== undefined && active.length > 0) {
    const found = active[0]!;
    const engine = found.engine!;
    const detection: RuntimeDetection = {
      found: false,
      state: "active",
      candidates,
    };
    throw new DetectionError(
      "runtime mismatch: host has " + engine.kind + " " + engine.version + " at " + found.socketPath +
        " but deploy.yml says " + opts.expect,
      detection,
    );
  }

  return {
    found: false,
    state: candidates.every((c) => c.state === "absent") ? "absent" : "inactive",
    candidates,
  };
}
