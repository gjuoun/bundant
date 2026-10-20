import { spawn } from "node:child_process";

export interface RawProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
}

/**
 * Runtime-neutral process runner (node:child_process, works identically under
 * bun). Uses spawn with pipes rather than execFile on purpose: there is no
 * maxBuffer ceiling, and a shell pipeline - the image transfer
 * (save | gzip | ssh "gunzip | load"), for example - streams between the
 * child processes instead of being buffered in the caller. Only the command's
 * own stdout/stderr (small for every command bundant emits) is accumulated.
 */
export function runProcess(
  argv: readonly string[],
  opts: RunOptions = {},
): Promise<RawProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RawProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e: Error) => {
      // Missing binary, permission denied, ... - report like a shell would.
      done({ code: 127, stdout: Buffer.concat(out).toString("utf8"), stderr: e.message + "\n" });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      const tail = signal ? "terminated by signal " + signal + "\n" : "";
      done({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + tail,
      });
    });
  });
}
