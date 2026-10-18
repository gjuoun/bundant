import type { Executor, ExecResult } from "../types.ts";

/** Runs commands through the local shell (tests, probes, local-docker setups). */
export class LocalExecutor implements Executor {
  readonly kind = "local";

  async run(cmd: string): Promise<ExecResult> {
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  async putFile(localPath: string, destPath: string, mode?: string): Promise<void> {
    await Bun.write(destPath, Bun.file(localPath));
    if (mode) {
      const r = await this.run("chmod " + mode + " " + destPath);
      if (r.code !== 0) throw new Error("chmod failed on " + destPath + ": " + r.stderr);
    }
  }

  async close(): Promise<void> {}
}
