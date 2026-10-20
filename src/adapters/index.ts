import { SshExecutor, connectOptionsFor } from "../exec/ssh.ts";
import type { HostConnection } from "../hosts.ts";
import type { RuntimeKind } from "../runtime.ts";
import { ApiClient } from "./api.ts";
import {
  detectRuntime,
  formatCandidates,
  parseEngineVersion,
  socketCandidates,
  type RuntimeDetection,
  type SocketProbe,
  type VersionPayload,
} from "./detect.ts";
import { DockerAdapter } from "./docker.ts";
import { PodmanAdapter } from "./podman.ts";
import { parseOrDrift, versionSchema } from "./schemas/index.ts";
import { SshSocketForward, defaultForwardDir } from "./transport.ts";
import type { RuntimeAdapter } from "./types.ts";

/**
 * Detection -> transport -> client -> adapter, in that order, in one place.
 * Commands call openAdapter(); they never choose a driver or build ssh strings.
 */

export class NoRuntimeSocketError extends Error {
  readonly detection: RuntimeDetection;
  readonly hint: string;

  constructor(
    connection: HostConnection,
    detection: RuntimeDetection,
    expected: RuntimeKind,
    localDir: string,
    uid: string,
  ) {
    super(
      "no " + expected + " socket on " + connection.sshTarget + " (probed " +
        formatCandidates(detection.candidates) + ", forward dir " + localDir + ")",
    );
    this.name = "NoRuntimeSocketError";
    this.detection = detection;
    this.hint = enableSocketHint(connection, expected, uid);
  }
}

/** The exact host-side command a user can run to make the socket available. */
export function enableSocketHint(
  connection: HostConnection,
  expected: RuntimeKind,
  uid: string,
): string {
  if (expected === "podman") {
    const systemctl = uid === "0" ? "systemctl" : "systemctl --user";
    return "ssh " + connection.sshTarget + " '" + systemctl + " enable --now podman.socket'";
  }
  return "ssh " + connection.sshTarget + " 'systemctl enable --now docker'";
}

export interface OpenAdapterOptions {
  /** Forward-socket directory (defaults to the profile cache dir). */
  cacheDir?: string;
  /** Reuse an existing ssh executor (shares its ControlMaster). */
  exec?: SshExecutor;
}

export interface OpenedAdapter {
  adapter: RuntimeAdapter;
  detection: RuntimeDetection;
  client: ApiClient;
  forward: SshSocketForward;
  close(): Promise<void>;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function missingSocket(path: string): NodeJS.ErrnoException {
  const err = new Error("no socket at " + path) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

async function socketExists(exec: SshExecutor, path: string): Promise<boolean> {
  const r = await exec.run("test -S " + shellQuote(path) + " && echo yes || echo no");
  if (r.code !== 0) {
    throw new Error("ssh " + (r.stderr.trim() !== "" ? r.stderr.trim() : "exit " + r.code));
  }
  return r.stdout.trim() === "yes";
}

/** Build one probe per candidate: absent paths fail fast, present ones forward. */
async function probesFor(
  connection: HostConnection,
  exec: SshExecutor,
  uid: string,
  localDir: string | undefined,
  expected: RuntimeKind,
): Promise<SocketProbe[]> {
  const probes: SocketProbe[] = [];
  for (const socketPath of socketCandidates(uid)) {
    if (!(await socketExists(exec, socketPath))) {
      probes.push({
        socketPath,
        probe: async () => {
          throw missingSocket(socketPath);
        },
      });
      continue;
    }
    const forward = new SshSocketForward({ connection, remoteSocket: socketPath, localDir });
    probes.push({
      socketPath,
      probe: async (): Promise<VersionPayload> => {
        await forward.start();
        const client = await ApiClient.create({
          socketPath: forward.localSocket,
          preferDockerode: false,
        });
        try {
          const res = await client.request("GET", "/version");
          return parseOrDrift(versionSchema, res.json, {
            engine: expected,
            method: "GET",
            path: "/version",
          });
        } finally {
          await client.close();
        }
      },
      dispose: async () => {
        await forward.close();
      },
    });
  }
  return probes;
}

export async function openAdapter(
  connection: HostConnection,
  expected: RuntimeKind,
  opts: OpenAdapterOptions = {},
): Promise<OpenedAdapter> {
  const localDir = opts.cacheDir ?? defaultForwardDir();
  const exec = opts.exec ?? new SshExecutor(connectOptionsFor(connection));

  // Fast path: deploy.yml already says which engine this host runs. Try its
  // canonical socket once and reuse that same forward for the adapter, instead
  // of probing every candidate and opening a second forward.
  const preferred =
    expected === "docker" ? "/var/run/docker.sock" : "/run/podman/podman.sock";
  {
    const forward = new SshSocketForward({
      connection,
      remoteSocket: preferred,
      localDir,
      startTimeoutMs: 1_500,
    });
    try {
      await forward.start();
      const client = await ApiClient.create({ socketPath: forward.localSocket });
      try {
        const res = await client.request("GET", "/version");
        const payload = parseOrDrift(versionSchema, res.json, {
          engine: expected,
          method: "GET",
          path: "/version",
        });
        const engine = parseEngineVersion(payload);
        if (engine.kind === expected) {
          const detection: RuntimeDetection = {
            found: true,
            kind: engine.kind,
            engineVersion: engine.version,
            apiVersion: engine.apiVersion,
            socketPath: preferred,
            state: "active",
            candidates: [{ socketPath: preferred, state: "active", engine }],
          };
          const adapter: RuntimeAdapter =
            engine.kind === "podman"
              ? new PodmanAdapter(client, engine.version, engine.apiVersion)
              : new DockerAdapter(client, engine.version, engine.apiVersion);
          return {
            adapter,
            detection,
            client,
            forward,
            close: async () => {
              await client.close();
              await forward.close();
            },
          };
        }
      } finally {
        await client.close();
      }
    } catch {
      // fall back to the full candidate probe below
    }
    await forward.close();
  }

  const uidResult = await exec.run("id -u");
  if (uidResult.code !== 0) {
    throw new Error(
      "cannot reach " + connection.sshTarget + ": " +
        (uidResult.stderr.trim() !== "" ? uidResult.stderr.trim() : "ssh exit " + uidResult.code),
    );
  }
  const uid = uidResult.stdout.trim();
  if (!/^[0-9]+$/.test(uid)) {
    throw new Error("unexpected id -u output from " + connection.sshTarget + ": " + uid);
  }

  const probes = await probesFor(connection, exec, uid, localDir, expected);
  const detection = await detectRuntime({ probes, expect: expected });
  if (!detection.found || detection.socketPath === undefined) {
    throw new NoRuntimeSocketError(connection, detection, expected, localDir, uid);
  }

  const forward = new SshSocketForward({
    connection,
    remoteSocket: detection.socketPath,
    localDir,
  });
  await forward.start();
  const client = await ApiClient.create({ socketPath: forward.localSocket });
  const adapter: RuntimeAdapter =
    detection.kind === "podman"
      ? new PodmanAdapter(client, detection.engineVersion ?? "unknown", detection.apiVersion ?? "unknown")
      : new DockerAdapter(client, detection.engineVersion ?? "unknown", detection.apiVersion ?? "unknown");

  return {
    adapter,
    detection,
    client,
    forward,
    close: async () => {
      await client.close();
      await forward.close();
    },
  };
}
