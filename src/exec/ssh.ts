import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Runtime } from "../runtime.ts";
import type { Executor, ExecResult } from "../types.ts";
import { runProcess } from "./process.ts";

/**
 * SSH backend using the native ssh binary (decision Q1=A):
 * honors ~/.ssh/config (ProxyJump, IdentityFile, Tailscale), authenticates once
 * via ControlMaster multiplexing, and is debuggable with plain ssh -v.
 */

export const CONTROL_DIR = tmpdir() + "/bundant-cm";

export interface SshConnectOptions {
  host: string;
  connectTimeoutSec?: number;
  controlPersistSec?: number;
}

/** ssh argv prefix incl. multiplexing; cmd (when given) is the final single argument. */
export function buildSshArgs(opts: SshConnectOptions, cmd?: string): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=" + (opts.connectTimeoutSec ?? 10),
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=" + CONTROL_DIR + "/cm-%r@%h-%p",
    "-o", "ControlPersist=" + (opts.controlPersistSec ?? 60),
    opts.host,
  ];
  if (cmd !== undefined) args.push(cmd);
  return args;
}

/** The same option set as a flat string, for inline ssh use inside shell pipelines. */
export function sshOptsStr(opts: Partial<SshConnectOptions> = {}): string {
  return buildSshArgs({ ...opts, host: "" }).filter((a) => a !== "").join(" ");
}

/**
 * Zero-registry image transport: a local runtime save piped through gzip and
 * the multiplexed ssh connection into a runtime load on the host. Podman
 * saves with an explicit docker-archive format so the archive stays portable.
 * The literal {HOST} token is substituted per host by the planner / deploy.
 *
 * The pipeline streams: the caller spawns one shell whose processes pipe into
 * each other (docker save | gzip | ssh "gunzip | docker load"), so image bytes
 * never pass through this process's memory.
 */
export function pushImagePipeline(image: string, rt: Runtime): string {
  const fmt = rt.saveFormatArgs.length > 0 ? " " + rt.saveFormatArgs.join(" ") : "";
  return rt.bin + " save" + fmt + " " + image + " | gzip -1 | ssh " + sshOptsStr() +
    ' {HOST} "gunzip | ' + rt.bin + ' load"';
}

export class SshExecutor implements Executor {
  readonly kind = "ssh";
  private readonly opts: SshConnectOptions;

  constructor(opts: SshConnectOptions) {
    this.opts = opts;
  }

  /** Ensure the multiplex socket dir exists (cheap, idempotent). */
  private async ensureControlDir(): Promise<void> {
    await mkdir(CONTROL_DIR, { recursive: true });
  }

  async run(cmd: string): Promise<ExecResult> {
    await this.ensureControlDir();
    return runProcess(["ssh", ...buildSshArgs(this.opts, cmd)]);
  }

  async putFile(localPath: string, destPath: string, mode?: string): Promise<void> {
    await this.ensureControlDir();
    const scpArgs = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ControlMaster=auto",
      "-o", "ControlPath=" + CONTROL_DIR + "/cm-%r@%h-%p",
      localPath,
      this.opts.host + ":" + destPath,
    ];
    const r = await runProcess(["scp", ...scpArgs]);
    if (r.code !== 0) {
      throw new Error(
        "scp " + localPath + " -> " + this.opts.host + ":" + destPath + " failed: " + r.stderr,
      );
    }
    if (mode) {
      const c = await this.run("chmod " + mode + " " + destPath);
      if (c.code !== 0) throw new Error("chmod " + mode + " " + destPath + " failed: " + c.stderr);
    }
  }

  /** Tear down the multiplexed connection. */
  async close(): Promise<void> {
    await runProcess([
      "ssh",
      "-o", "ControlPath=" + CONTROL_DIR + "/cm-%r@%h-%p",
      "-O", "exit",
      this.opts.host,
    ]);
  }
}
