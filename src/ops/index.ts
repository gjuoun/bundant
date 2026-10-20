import type { BundantConfig } from "../config.ts";
import type { HostConnection } from "../hosts.ts";
import { HostSession } from "../host/session.ts";
import { runtimeFor } from "../runtime.ts";
import { ApiOps } from "./adapter.ts";
import { LegacyOps } from "./legacy.ts";
import type { OpsVia, RuntimeOps } from "./types.ts";

export type {
  HealthGateOptions,
  OpsVia,
  ProxyDeployOptions,
  PullPolicy,
  RuntimeOps,
} from "./types.ts";
export { ApiOps } from "./adapter.ts";
export { LegacyOps } from "./legacy.ts";

export interface OpenOpsOptions {
  /** Per-host env file path used by the legacy implementation only. */
  envRemotePath?: string;
}

/**
 * One place that decides how a mutating command executes. Each call owns one
 * HostSession; closing the ops closes the session (and every forward it made).
 */
export async function openOps(
  via: OpsVia,
  connection: HostConnection,
  config: Pick<BundantConfig, "runtime">,
  opts: OpenOpsOptions = {},
): Promise<RuntimeOps> {
  const rt = runtimeFor(config.runtime);
  const session = new HostSession(connection, { persistControl: true });
  if (via === "cli") {
    return new LegacyOps(session.executor, rt, {
      envRemotePath: opts.envRemotePath,
      close: () => session.dispose(),
    });
  }
  const adapter = await session.open(config.runtime);
  return new ApiOps(adapter, session.executor, rt, async () => {}, () => session.dispose());
}
