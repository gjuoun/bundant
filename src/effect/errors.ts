import { ConfigError as LegacyConfigError } from "../config/errors.ts";
import { ConfigVersionError as LegacyConfigVersionError } from "../config/registry.ts";
import { PreflightError } from "../validation.ts";
import { LockHeldError } from "../lock.ts";
import { HealthGateError } from "../health.ts";
import { ApiError } from "../adapters/api.ts";
import { ApiSchemaDriftError } from "../adapters/schemas/drift.ts";
import { DetectionError } from "../adapters/detect.ts";
import { NoRuntimeSocketError } from "../adapters/index.ts";
import { NoMatchError as LegacyNoMatchError, SelectorError } from "../select/selector.ts";
import { RevisionNotFoundError } from "../revisions.ts";
import { GroupError } from "../group.ts";
import { AccessoryError } from "../accessory.ts";
import { ScaleError } from "../scale-plan.ts";
import { HostParseError } from "../hosts.ts";
import {
  ConfigError,
  ConfigVersionError,
  ValidationError,
  NoMatchError,
  LockError,
  EngineUnavailableError,
  ApiDriftError,
  HealthError,
  ProxyError,
  TransportError,
  NotFoundError,
  UnknownError,
  UsageError,
  exitCodeFor as catalogExitCodeFor,
  failureFor,
  type AgentFailure,
  type AppError,
} from "../agent/errors.ts";

export {
  ConfigError,
  ConfigVersionError,
  ValidationError,
  NoMatchError,
  LockError,
  EngineUnavailableError,
  ApiDriftError,
  HealthError,
  ProxyError,
  TransportError,
  NotFoundError,
  UnknownError,
  UsageError,
  type AgentFailure,
  type AppError,
};

/**
 * Typed application errors. Messages are built to match the pre-Effect text
 * exactly; only the process exit mapping lives here.
 */

/** Adapter boundary: exceptions become one tagged error, message unchanged. */
export function toAppError(error: unknown): AppError {
  if (isTagged(error)) return error;
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof LegacyConfigVersionError) {
    return new ConfigVersionError({ message });
  }
  if (error instanceof LegacyConfigError) {
    return new ConfigError({ message });
  }
  if (error instanceof PreflightError) {
    return new ValidationError({ message, field: error.errors[0]?.field });
  }
  if (error instanceof SelectorError) {
    return new UsageError({ message });
  }
  if (error instanceof LegacyNoMatchError) {
    return new NoMatchError({ message, pattern: error.pattern });
  }
  if (error instanceof LockHeldError) {
    return new LockError({ message, service: error.service });
  }
  if (error instanceof HealthGateError) {
    return new HealthError({ message, target: error.probeCmd });
  }
  if (error instanceof ApiSchemaDriftError) {
    return new ApiDriftError({ message });
  }
  if (error instanceof ApiError) {
    return new EngineUnavailableError({ message });
  }
  if (error instanceof NoRuntimeSocketError) {
    return new EngineUnavailableError({ message });
  }
  if (error instanceof DetectionError) {
    return new EngineUnavailableError({ message });
  }
  if (error instanceof RevisionNotFoundError) {
    return new NotFoundError({ message, target: error.revisions.join(",") });
  }
  if (error instanceof GroupError || error instanceof AccessoryError || error instanceof ScaleError) {
    return new ValidationError({ message });
  }
  if (error instanceof HostParseError) {
    return new ConfigError({ message });
  }
  return new UnknownError({ message });
}

/** One formatter for runMain and the still-Promise paths. */
export function formatError(error: AppError): string {
  return error.message;
}

/** Lock contention keeps its own code; everything else follows the catalog. */
export function exitCodeFor(error: AppError): number {
  return catalogExitCodeFor(error);
}

/** JSON failure body for the envelope. */
export function agentFailure(error: AppError): AgentFailure {
  return failureFor(error);
}

/** Effect predicates use the _tag discriminator; plain Errors do not. */
function isTagged(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as { _tag?: unknown })._tag === "string" &&
    "message" in value
  );
}
