import { Effect } from "effect";
import { makeSdkLayer, type SdkLayerOptions, type SdkServices } from "./layer.ts";
import { deploy, rollback, scale, status } from "./operations.ts";

/**
 * bundant SDK - deploy in code, not YAML.
 *
 *   import { bundant, defineDeployment, runSdk } from "bundant";
 *
 *   const api = defineDeployment({ group: "shop", service: "api", image: "app:t1",
 *     hosts: ["root@host"], proxy: { host: "api.shop.test" }, port: 3000 });
 *
 *   await runSdk(bundant.deploy(api));
 *
 * Every operation is an `Effect`; `runSdk` is the one-line bridge for programs
 * that do not use Effect themselves. Values are provided by your code - bundant
 * resolves no secrets, runs no daemon, and keeps no local state.
 */

export { defineAccessory, defineDeployment, defineGroup } from "./spec.ts";
export { makeSdkLayer, SdkServices } from "./layer.ts";
export { deploy, rollback, scale, status } from "./operations.ts";

export type {
  SdkLayerOptions,
  SdkServicesShape,
} from "./layer.ts";
export type {
  DeployOperationOptions,
  DeployResult,
  RollbackOperationOptions,
  RollbackResult,
  ScaleOperationOptions,
  ScaleResult,
  StatusOperationOptions,
} from "./operations.ts";
export type {
  AccessoryInput,
  AccessorySpec,
  DeploymentInput,
  GroupInput,
  GroupSpec,
  HealthcheckInput,
  ProxyInput,
  ServiceSpec,
  SshInput,
  UnitSpec,
} from "./spec.ts";
export type { StatusRow } from "../status-rows.ts";
export type { AppError as BundantError } from "../effect/errors.ts";

/** The whole surface as one object, for programs that prefer `bundant.deploy`. */
export const bundant = { deploy, rollback, scale, status } as const;

/**
 * Run an SDK effect with a freshly built layer - the bridge for non-Effect code.
 * Callers that already run Effect can `Effect.provide(effect, makeSdkLayer())`
 * instead and keep their own runtime.
 */
export function runSdk<A, E>(
  effect: Effect.Effect<A, E, SdkServices>,
  options: SdkLayerOptions = {},
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, makeSdkLayer(options)));
}
