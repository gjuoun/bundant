import { Data } from "effect";
import { ConfigError as LegacyConfigError } from "../config/errors.ts";
import { ConfigVersionError as LegacyConfigVersionError } from "../config/registry.ts";
import { PreflightError } from "../validation.ts";
import { LockHeldError } from "../lock.ts";
import { HealthGateError } from "../health.ts";
import { ApiError } from "../adapters/api.ts";
import { ApiSchemaDriftError } from "../adapters/schemas/drift.ts";
import { DetectionError } from "../adapters/detect.ts";
import { NoRuntimeSocketError } from "../adapters/index.ts";

/**
 * Typed application errors. Messages are built to match the pre-Effect text
 * exactly; only the process exit mapping lives here.
 */

export class ConfigError extends Data.TaggedError("ConfigError")<{
  message: string;
  file?: string;
}> {}

export class ConfigVersionError extends Data.TaggedError("ConfigVersionError")<{
  message: string;
  file?: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  message: string;
  field?: string;
}> {}

export class TransportError extends Data.TaggedError("TransportError")<{
  message: string;
  host?: string;
}> {}

export class EngineError extends Data.TaggedError("EngineError")<{
  message: string;
  host?: string;
  phase?: string;
}> {}

export class ApiDriftError extends Data.TaggedError("ApiDriftError")<{
  message: string;
  engine?: string;
  method?: string;
  path?: string;
}> {}

export class HealthError extends Data.TaggedError("HealthError")<{
  message: string;
  target?: string;
}> {}

export class ProxyError extends Data.TaggedError("ProxyError")<{
  message: string;
  service?: string;
}> {}

export class LockError extends Data.TaggedError("LockError")<{
  message: string;
  service?: string;
}> {}

export class UnknownError extends Data.TaggedError("UnknownError")<{
  message: string;
}> {}

export type AppError =
  | ConfigError
  | ConfigVersionError
  | ValidationError
  | TransportError
  | EngineError
  | ApiDriftError
  | HealthError
  | ProxyError
  | LockError
  | UnknownError;

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
    return new ValidationError({ message });
  }
  if (error instanceof LockHeldError) {
    return new LockError({ message, service: error.service });
  }
  if (error instanceof HealthGateError) {
    return new HealthError({ message });
  }
  if (error instanceof ApiSchemaDriftError) {
    return new ApiDriftError({ message });
  }
  if (error instanceof ApiError) {
    return new EngineError({ message });
  }
  if (error instanceof NoRuntimeSocketError || error instanceof DetectionError) {
    return new TransportError({ message });
  }
  return new UnknownError({ message });
}

/** One formatter for runMain and the still-Promise paths. */
export function formatError(error: AppError): string {
  return error.message;
}

/** Lock contention keeps its own code; everything else is a failure (1). */
export function exitCodeFor(error: AppError): number {
  return error._tag === "LockError" ? 2 : 1;
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
