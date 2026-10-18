import { chmod, copyFile } from "node:fs/promises";
import type { Executor, ExecResult } from "../types.ts";
import { runProcess } from "./process.ts";

/** Runs commands through the local shell (tests, probes, local-docker setups). */
export class LocalExecutor implements Executor {
  readonly kind = "local";

  async run(cmd: string): Promise<ExecResult> {
    return runProcess(["sh", "-c", cmd]);
  }

  async putFile(localPath: string, destPath: string, mode?: string): Promise<void> {
    await copyFile(localPath, destPath);
    if (mode) {
      // copyFile does not carry the source mode; set it explicitly.
      await chmod(destPath, Number.parseInt(mode, 8));
    }
  }

  async close(): Promise<void> {}
}
