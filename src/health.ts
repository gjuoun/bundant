import type { Executor } from "./types.ts";

export class HealthGateError extends Error {
  constructor(
    public readonly probeCmd: string,
    public readonly attempts: number,
    public readonly lastCode: string,
  ) {
    super(
      "health gate failed after " + attempts + " attempt(s); last status [" +
      lastCode + "] from: " + probeCmd,
    );
    this.name = "HealthGateError";
  }
}

export interface HealthOptions {
  timeoutMs: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HealthResult {
  attempts: number;
  elapsedMs: number;
}

/**
 * Poll the curl-sidecar probe until it prints 200. The orchestrator aborts
 * (and removes the new container) when this throws — no traffic ever swaps
 * to an unhealthy target.
 */
export async function waitUntilHealthy(
  exec: Executor,
  probeCmd: string,
  opts: HealthOptions,
): Promise<HealthResult> {
  const interval = opts.intervalMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = Date.now();
  let attempts = 0;
  let lastCode = "";

  while (Date.now() - start <= opts.timeoutMs) {
    const r = await exec.run(probeCmd);
    attempts++;
    lastCode = r.stdout.trim();
    if (r.code === 0 && lastCode === "200") {
      return { attempts, elapsedMs: Date.now() - start };
    }
    await sleep(interval);
  }
  throw new HealthGateError(probeCmd, attempts, lastCode);
}
