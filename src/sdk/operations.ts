import { Effect } from "effect";
import { buildDeployPlan } from "../planner.ts";
import { deploy as runDeploy, type DeployOptions, type DeployOutcome } from "../deploy.ts";
import { rollback as runRollback } from "../rollback.ts";
import { scale as runScale } from "../scale.ts";
import { NotFoundError, UnknownError, UsageError, toAppError, type AppError } from "../effect/errors.ts";
import type { PullPolicy } from "../ops/index.ts";
import { readConfig } from "../select/read-config.ts";
import { withFlatUnits } from "../select/with-units.ts";
import { statusRows, type StatusRow } from "../status-rows.ts";
import { SdkServices } from "./layer.ts";
import type { ServiceSpec, UnitSpec } from "./spec.ts";

export interface DeployResult {
  readonly status: "deployed";
  readonly revision: string;
}

export interface RollbackResult {
  /** Revision the CLI was asked for; undefined means "the previous one". */
  readonly toRevision?: string;
}

export interface ScaleResult {
  readonly replicas: number;
}

export interface DeployOperationOptions {
  /** Skip git resolution and carry this revision. */
  readonly revision?: string;
  /** Deploy a locally built image by transferring it (no registry). */
  readonly localImage?: string;
  readonly pull?: PullPolicy;
  readonly allowEmulation?: boolean;
}

export interface RollbackOperationOptions {
  readonly toRevision?: string;
}

export interface ScaleOperationOptions {
  readonly replicas: number;
  readonly dryRun?: boolean;
}

/**
 * The cores still print progress for the CLI, so an SDK call silences stdout
 * and stderr for its duration - the same swap `deploy --json` already does.
 * Host locks serialise real deployments, so one quiet section at a time.
 */
async function quiet<A>(run: () => Promise<A>): Promise<A> {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Non-zero cores become typed failures; success carries structure, not an exit code. */
export function operationFailure(
  operation: "deploy" | "rollback" | "scale",
  path: string,
  code: number,
  toRevision?: string,
): AppError {
  if (operation === "rollback") {
    return new NotFoundError({
      message: "no revision to roll back to for " + path,
      ...(toRevision === undefined ? {} : { target: toRevision }),
    });
  }
  if (operation === "scale" && code === 2) {
    return new UsageError({ message: "scale rejected for " + path + " (exit " + code + ")" });
  }
  return new UnknownError({ message: operation + " failed for " + path + " (exit " + code + ")" });
}

function accessoryGuard(spec: UnitSpec): AppError | undefined {
  if (spec.kind === "accessory") {
    return new UsageError({
      message: spec.path + " is an accessory - stateful members are started explicitly, not deployed",
    });
  }
  return undefined;
}

/** Plan and deploy one service spec. */
export function deploy(
  spec: ServiceSpec,
  options: DeployOperationOptions = {},
): Effect.Effect<DeployResult, AppError, SdkServices> {
  return Effect.gen(function* () {
    const blocked = accessoryGuard(spec);
    if (blocked !== undefined) return yield* Effect.fail(blocked);

    const services = yield* SdkServices;
    const revision = options.revision !== undefined
      ? options.revision
      : yield* Effect.tryPromise({
        try: () => services.revision(spec.loaded.path),
        catch: toAppError,
      });
    const plan = yield* Effect.try({
      try: () => buildDeployPlan(spec.loaded.config, revision, { localImage: options.localImage }),
      catch: toAppError,
    });
    const outcome: DeployOutcome = {};
    const deployOptions: DeployOptions = {
      ...services.deployOptions,
      ...(options.pull === undefined ? {} : { pullPolicy: options.pull }),
      ...(options.allowEmulation === undefined ? {} : { allowEmulation: options.allowEmulation }),
      outcome,
    };
    const code = yield* Effect.tryPromise({
      try: () => quiet(() => runDeploy(plan, spec.loaded, deployOptions)),
      catch: toAppError,
    });
    if (code !== 0) return yield* Effect.fail(operationFailure("deploy", spec.path, code));
    return { status: "deployed" as const, revision };
  });
}

/** Roll one service back to the previous revision (or the one named). */
export function rollback(
  spec: ServiceSpec,
  options: RollbackOperationOptions = {},
): Effect.Effect<RollbackResult, AppError, SdkServices> {
  return Effect.gen(function* () {
    const blocked = accessoryGuard(spec);
    if (blocked !== undefined) return yield* Effect.fail(blocked);

    yield* SdkServices;
    const code = yield* Effect.tryPromise({
      try: () => quiet(() => runRollback(spec.loaded, { toRevision: options.toRevision })),
      catch: toAppError,
    });
    if (code !== 0) {
      return yield* Effect.fail(
        operationFailure("rollback", spec.path, code, options.toRevision),
      );
    }
    return options.toRevision === undefined ? {} : { toRevision: options.toRevision };
  });
}

/** Change the replica count of the revision that is already running. */
export function scale(
  spec: ServiceSpec,
  options: ScaleOperationOptions,
): Effect.Effect<ScaleResult, AppError, SdkServices> {
  return Effect.gen(function* () {
    const blocked = accessoryGuard(spec);
    if (blocked !== undefined) return yield* Effect.fail(blocked);

    yield* SdkServices;
    const code = yield* Effect.tryPromise({
      try: () =>
        quiet(() =>
          runScale(spec.loaded, { replicas: options.replicas, dryRun: options.dryRun === true }),
        ),
      catch: toAppError,
    });
    if (code !== 0) {
      return yield* Effect.fail(operationFailure("scale", spec.path, code));
    }
    return { replicas: options.replicas };
  });
}

export interface StatusOperationOptions {
  /** Override the layer hosts (default: SdkServices.hosts). */
  readonly hosts?: readonly string[];
  readonly replica?: number;
  readonly revision?: string;
  readonly allRevisions?: boolean;
}

/** Read the units matching a selector (`shop.**`, `shop.api.web`, `*`). */
export function status(
  pattern: string,
  options: StatusOperationOptions = {},
): Effect.Effect<StatusRow[], AppError, SdkServices> {
  return Effect.gen(function* () {
    const services = yield* SdkServices;
    const loaded = readConfig(options.hosts ?? services.hosts, services.runtime);
    return yield* Effect.tryPromise({
      try: () =>
        withFlatUnits(
          loaded,
          pattern,
          {
            ...(options.replica === undefined ? {} : { replica: options.replica }),
            ...(options.revision === undefined ? {} : { revision: options.revision }),
            ...(options.allRevisions === undefined ? {} : { allRevisions: options.allRevisions }),
          },
          async (ctx) => statusRows(ctx.units, loaded.config),
          services.openOps,
        ),
      catch: toAppError,
    });
  });
}

