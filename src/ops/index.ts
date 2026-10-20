import type { BundantConfig } from "../config.ts";
import type { HostConnection } from "../hosts.ts";
import { HostSession } from "../host/session.ts";
import { runtimeFor } from "../runtime.ts";
import { ApiOps } from "./adapter.ts";
import type { RuntimeOps } from "./types.ts";

export type {
  HealthGateOptions,
  ProxyDeployOptions,
  PullPolicy,
  RuntimeOps,
} from "./types.ts";
export { ApiOps } from "./adapter.ts";

/**
 * One place that decides how a mutating command executes. Each call owns one
 * HostSession; closing the ops closes the session (and every forward it made).
 */
export async function openOps(
  connection: HostConnection,
  config: Pick<BundantConfig, "runtime">,
): Promise<RuntimeOps> {
  const rt = runtimeFor(config.runtime);
  const session = new HostSession(connection, { persistControl: true });
  const adapter = await session.open(config.runtime);
  return new ApiOps(adapter, session.executor, rt, async () => {}, () => session.dispose());
}
