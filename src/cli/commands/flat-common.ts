import type { LoadedConfig } from "../../config.ts";
import { resolveConnections } from "../../hosts.ts";
import { openOps, type OpsVia, type RuntimeOps } from "../../ops/index.ts";
import { resolve, type ResolvedUnit, type UnitSource } from "../../select/resolve.ts";
import { unitPath } from "../../select/selector.ts";
import { ServiceIdentity } from "../../domain/identity.ts";
import type { GlobalConfig } from "./common.ts";

export interface FlatUnits {
  units: ResolvedUnit[];
  ops: Map<string, RuntimeOps>;
  close(): Promise<void>;
}

/** Open one RuntimeOps per host, resolve the pattern, and keep the ops open. */
export async function withFlatUnits<T>(
  loaded: LoadedConfig,
  via: OpsVia,
  pattern: string,
  opts: { replica?: number; revision?: string; allRevisions?: boolean },
  run: (ctx: FlatUnits) => Promise<T>,
): Promise<T> {
  const ops = new Map<string, RuntimeOps>();
  try {
    const sources: UnitSource[] = [];
    for (const connection of resolveConnections(loaded.config)) {
      const hostOps = await openOps(via, connection, loaded.config);
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

/** Path argument, else the -f unit as a filter, else everything. */
export function selectorFor(
  g: Pick<GlobalConfig, "file">,
  loaded: LoadedConfig,
  path: string | undefined,
): string {
  if (path !== undefined) return path;
  if (g.file._tag === "Some") {
    const identity = ServiceIdentity.from(loaded.config);
    return unitPath({
      group: identity.group,
      service: identity.service,
      role: identity.role,
      kind: identity.kind,
    });
  }
  return "*";
}

export function opsFor(ctx: FlatUnits, host: string): RuntimeOps {
  const found = ctx.ops.get(host);
  if (found === undefined) throw new Error("no runtime session for host " + host);
  return found;
}
