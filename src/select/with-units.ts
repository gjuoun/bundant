import type { LoadedConfig } from "../config/types.ts";
import { resolveConnections } from "../hosts.ts";
import { openOps, type RuntimeOps } from "../ops/index.ts";
import { resolve, type ResolvedUnit, type UnitSource } from "./resolve.ts";

export interface FlatUnits {
  units: ResolvedUnit[];
  ops: Map<string, RuntimeOps>;
  close(): Promise<void>;
}

/**
 * Open one RuntimeOps per host, resolve the pattern, and keep the ops open.
 *
 * `opener` is the seam: the CLI passes the real one implicitly, the SDK passes
 * `SdkServices.openOps` so a test can answer without a host.
 */
export async function withFlatUnits<T>(
  loaded: LoadedConfig,
  pattern: string,
  opts: { replica?: number; revision?: string; allRevisions?: boolean },
  run: (ctx: FlatUnits) => Promise<T>,
  opener: typeof openOps = openOps,
): Promise<T> {
  const ops = new Map<string, RuntimeOps>();
  try {
    const sources: UnitSource[] = [];
    for (const connection of resolveConnections(loaded.config)) {
      const hostOps = await opener(connection, loaded.config);
      ops.set(connection.sshTarget, hostOps);
      sources.push({ host: connection.sshTarget, ops: hostOps });
    }
    const units = await resolve(pattern, { sources, ...opts });
    return await run({ units, ops, close: async () => undefined });
  } finally {
    for (const hostOps of ops.values()) {
      try {
        await hostOps.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}
