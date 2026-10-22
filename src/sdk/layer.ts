import { Context, Layer } from "effect";
import type { BundantConfig } from "../config/types.ts";
import type { DeployOptions } from "../deploy.ts";
import { openOps } from "../ops/index.ts";
import { resolveRevision } from "../revision.ts";

/**
 * What every SDK operation reads from the context.
 *
 * The defaults are the production ones (real git revision, real SSH sessions);
 * a test or an embedding program replaces them through `makeSdkLayer`.
 */
export interface SdkServicesShape {
  /** Hosts used by read operations and by specs that omit `hosts`. */
  readonly hosts: readonly string[];
  /** Engine the read operations should assume when no spec is involved. */
  readonly runtime: BundantConfig["runtime"];
  /** Resolve the revision a deploy should carry (default: git short sha in `dir`). */
  readonly revision: (dir: string) => Promise<string>;
  /** Passed through to `deploy` (transfer/pull/preflight seams). */
  readonly deployOptions: DeployOptions;
  /** Opens the per-host runtime session; tests substitute a fake. */
  readonly openOps: typeof openOps;
}

export class SdkServices extends Context.Service<SdkServices, SdkServicesShape>()(
  "bundant/SdkServices",
) {}

export interface SdkLayerOptions {
  readonly hosts?: readonly string[];
  readonly runtime?: BundantConfig["runtime"];
  readonly revision?: (dir: string) => Promise<string>;
  readonly deployOptions?: DeployOptions;
  readonly openOps?: typeof openOps;
}

function envHosts(): string[] {
  return (process.env.BUNDANT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

/** Build the SDK layer. No connection is opened and no file is read here. */
export function makeSdkLayer(options: SdkLayerOptions = {}): Layer.Layer<SdkServices> {
  return Layer.succeed(SdkServices, {
    hosts: options.hosts ?? envHosts(),
    runtime: options.runtime ?? "docker",
    revision: options.revision ?? ((dir: string) => resolveRevision(dir)),
    deployOptions: options.deployOptions ?? {},
    openOps: options.openOps ?? openOps,
  });
}
