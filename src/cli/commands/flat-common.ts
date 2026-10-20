import type { LoadedConfig } from "../../config.ts";
import { resolveConnections } from "../../hosts.ts";
import { openOps, type OpsVia, type RuntimeOps } from "../../ops/index.ts";
import { resolve, type ResolvedUnit, type UnitSource } from "../../select/resolve.ts";

export interface FlatUnits {
  units: ResolvedUnit[];
  ops: Map<string, RuntimeOps>;
  close(): Promise<void>;
}

/** Open one RuntimeOps per host, resolve the pattern, and keep the ops open. */
export async function withFlatUnits(
  loaded: LoadedConfig,
  via: OpsVia,
  pattern: string,
  opts: { replica?: number; revision?: string; allRevisions?: boolean },
  run: (ctx: FlatUnits) => Promise<void>,
): Promise<void> {
  const ops = new Map<string, RuntimeOps>();
  try {
    const sources: UnitSource[] = [];
    for (const connection of resolveConnections(loaded.config)) {
      const hostOps = await openOps(via, connection, loaded.config);
      ops.set(connection.sshTarget, hostOps);
      sources.push({ host: connection.sshTarget, ops: hostOps });
    }
    const units = await resolve(pattern, { sources, ...opts });
    await run({ units, ops, close: async () => undefined });
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

export function opsFor(ctx: FlatUnits, host: string): RuntimeOps {
  const found = ctx.ops.get(host);
  if (found === undefined) throw new Error("no runtime session for host " + host);
  return found;
}
