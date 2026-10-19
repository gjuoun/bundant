import { SshExecutor, connectOptionsFor } from "../exec/ssh.ts";
import type { HostConnection } from "../hosts.ts";
import type { RuntimeKind } from "../runtime.ts";
import { ApiClient } from "./api.ts";
import {
  detectRuntime,
  formatCandidates,
  socketCandidates,
  type RuntimeDetection,
  type SocketProbe,
  type VersionPayload,
} from "./detect.ts";
import { DockerAdapter } from "./docker.ts";
import { PodmanAdapter } from "./podman.ts";
import { SshSocketForward } from "./transport.ts";
import type { RuntimeAdapter } from "./types.ts";

/**
 * Detection -> transport -> client -> adapter, in that order, in one place.
 * Commands call openAdapter(); they never choose a driver or build ssh strings.
 */

export class NoRuntimeSocketError extends Error {
  readonly detection: RuntimeDetection;
  readonly hint: string;

  constructor(connection: HostConnection, detection: RuntimeDetection, expected: RuntimeKind, localDir: string) {
    super(
      "no " + expected + " socket on " + connection.sshTarget + " (probed " +
        formatCandidates(detection.candidates) + ", forward dir " + localDir + ")",
    );
    this.name = "NoRuntimeSocketError";
    this.detection = detection;
    this.hint = enableSocketHint(connection, expected, detection);
  }
}

/** The exact host-side command a user can run to make the socket available. */
export function enableSocketHint(
  connection: HostConnection,
  expected: RuntimeKind,
  detection: RuntimeDetection,
): string {
  if (expected === "podman") {
    const rootless = detection.candidates.some((c) => c.socketPath.startsWith("/run/user/"));
    const systemctl = rootless ? "systemctl --user" : "systemctl";
    return "ssh " + connection.sshTarget + " '" + systemctl + " enable --now podman.socket'";
  }
  return "ssh " + connection.sshTarget + " 'systemctl enable --now docker'";
}

export interface OpenAdapterOptions {
  /** Forward-socket directory (defaults to the profile cache dir). */
  cacheDir?: string;
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
          return res.json as VersionPayload;
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
  const localDir = opts.cacheDir;
  const exec = new SshExecutor(connectOptionsFor(connection));

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

  const probes = await probesFor(connection, exec, uid, localDir);
  const detection = await detectRuntime({ probes, expect: expected });
  if (!detection.found || detection.socketPath === undefined) {
    throw new NoRuntimeSocketError(connection, detection, expected, localDir ?? "(default)");
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
