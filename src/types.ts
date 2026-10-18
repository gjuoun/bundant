/** Result of executing one shell command through an Executor. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Execution backend: local shell, remote ssh, dry-run printer, or test fake. */
export interface Executor {
  readonly kind: string;
  run(cmd: string): Promise<ExecResult>;
  putFile(localPath: string, remotePath: string, mode?: string): Promise<void>;
  close(): Promise<void>;
}

/** Lifecycle phase of a planned command — consumed by the dry-run renderer and orchestrators. */
export type Phase =
  | "lock"
  | "unlock"
  | "env-upload"
  | "pull"
  | "push-image"
  | "runtime-check"
  | "port-guard"
  | "network"
  | "run"
  | "health"
  | "proxy-ensure"
  | "proxy-swap"
  | "stop-old"
  | "status"
  | "proxy-remove"
  | "containers"
  | "env-remove";

/** One planned action: description plus the exact host-shell commands that implement it. */
export interface CmdStep {
  phase: Phase;
  desc: string;
  cmds: string[];
}
