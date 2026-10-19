import { openAdapter } from "../adapters/index.ts";
import type { BundantConfig } from "../config.ts";
import { SshExecutor, connectOptionsFor } from "../exec/ssh.ts";
import type { HostConnection } from "../hosts.ts";
import { runtimeFor } from "../runtime.ts";
import { ApiOps } from "./adapter.ts";
import { LegacyOps } from "./legacy.ts";
import type { OpsVia, RuntimeOps } from "./types.ts";

export type { HealthGateOptions, OpsVia, ProxyDeployOptions, RuntimeOps } from "./types.ts";
export { ApiOps } from "./adapter.ts";
export { LegacyOps } from "./legacy.ts";

export interface OpenOpsOptions {
  /** Per-host env file path used by the legacy implementation only. */
  envRemotePath?: string;
}

/**
 * One place that decides how a mutating command executes. \`api\` is the
 * default; \`cli\` keeps the previous ssh command-string path available for one
 * release (and is forced when --local-image is in play, because image
 * streaming is still stage 4 work).
 */
export async function openOps(
  via: OpsVia,
  connection: HostConnection,
  config: Pick<BundantConfig, "runtime">,
  opts: OpenOpsOptions = {},
): Promise<RuntimeOps> {
  const rt = runtimeFor(config.runtime);
  if (via === "cli") {
    const exec = new SshExecutor(connectOptionsFor(connection));
    return new LegacyOps(exec, rt, { envRemotePath: opts.envRemotePath });
  }
  const exec = new SshExecutor(connectOptionsFor(connection));
  const opened = await openAdapter(connection, config.runtime);
  return new ApiOps(opened.adapter, exec, rt, opened.close);
}
