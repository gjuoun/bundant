import type { LoadedConfig } from "./config.ts";
import type { RuntimeKind } from "./runtime.ts";
import type { HostConnection } from "./hosts.ts";
import { resolveConnections } from "./hosts.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { DetectionError } from "./adapters/detect.ts";
import { NoRuntimeSocketError, openAdapter } from "./adapters/index.ts";

/**
 * bundant runtime: prove detection end to end. Per host it reports what the
 * engine says about itself, which socket was used, the local forward, and
 * whether the socket service is enabled or merely running.
 */

export type SocketServiceState = "enabled" | "active" | "inactive" | "absent";

export interface RuntimeCandidateReport {
  socketPath: string;
  state: string;
  error?: string;
}

export interface RuntimeHostReport {
  host: string;
  ok: boolean;
  engine?: string;
  version?: string;
  apiVersion?: string;
  socketPath?: string;
  forward?: string;
  service?: SocketServiceState;
  error?: string;
  hint?: string;
  candidates?: RuntimeCandidateReport[];
}

export interface RuntimeReportOptions {
  /** --hosts a,b override. */
  hosts?: string[];
  cacheDir?: string;
}

/** systemd is the only ssh-level step runtime needs; the socket itself is API. */
async function socketServiceState(
  connection: HostConnection,
  expected: RuntimeKind,
): Promise<SocketServiceState> {
  if (expected !== "podman") return "active";
  try {
    const exec = new SshExecutor(connectOptionsFor(connection));
    const r = await exec.run("systemctl is-enabled podman.socket 2>/dev/null || true");
    const state = r.stdout.trim();
    if (state === "enabled" || state === "enabled-runtime" || state === "static" || state === "indirect") {
      return "enabled";
    }
    return "active";
  } catch {
    return "active";
  }
}

async function reportFor(
  connection: HostConnection,
  expected: RuntimeKind,
  cacheDir: string | undefined,
): Promise<RuntimeHostReport> {
  try {
    const opened = await openAdapter(connection, expected, { cacheDir });
    try {
      const service = await socketServiceState(connection, expected);
      return {
        host: connection.sshTarget,
        ok: true,
        engine: opened.adapter.kind,
        version: opened.adapter.engineVersion,
        apiVersion: opened.adapter.apiVersion,
        socketPath: opened.detection.socketPath,
        forward: opened.forward.localSocket,
        service,
      };
    } finally {
      await opened.close();
    }
  } catch (err) {
    if (err instanceof NoRuntimeSocketError) {
      return {
        host: connection.sshTarget,
        ok: false,
        error: err.message,
        hint: err.hint,
        candidates: err.detection.candidates.map((c) => ({
          socketPath: c.socketPath,
          state: c.state,
          error: c.error,
        })),
      };
    }
    if (err instanceof DetectionError) {
      return {
        host: connection.sshTarget,
        ok: false,
        error: err.message,
        candidates: err.detection.candidates.map((c) => ({
          socketPath: c.socketPath,
          state: c.state,
          error: c.error,
        })),
      };
    }
    return {
      host: connection.sshTarget,
      ok: false,
      error: connection.sshTarget + ": " + (err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function runtimeReport(
  loaded: LoadedConfig,
  opts: RuntimeReportOptions = {},
): Promise<RuntimeHostReport[]> {
  const config = { ...loaded.config, hosts: opts.hosts ?? loaded.config.hosts };
  const expected = loaded.config.runtime;
  const connections = resolveConnections(config);
  return await Promise.all(connections.map((c) => reportFor(c, expected, opts.cacheDir)));
}

export function renderRuntimeReport(reports: RuntimeHostReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    if (report.ok) {
      lines.push(
        report.host +
          " engine=" + report.engine +
          " version=" + report.version +
          " api=" + report.apiVersion +
          " socket=" + report.socketPath +
          " service=" + report.service,
      );
      lines.push("  forward=" + report.forward);
    } else {
      lines.push("bundant: " + report.error);
      if (report.candidates !== undefined && report.candidates.length > 0) {
        lines.push(
          "  candidates: " +
            report.candidates.map((c) => c.socketPath + "=" + c.state).join(", "),
        );
      }
      if (report.hint !== undefined) lines.push("  enable: " + report.hint);
    }
  }
  return lines.join("\n");
}
