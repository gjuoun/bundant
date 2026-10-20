import { Data } from "effect";

/**
 * The machine contract: one code per failure kind, one exit status per code.
 * This table is the single source for `bundant errors`, docs/agent.md and
 * schema/errors.json; adding a member here is the only way to add a code.
 */
export interface ErrorSpec {
  readonly exitCode: number;
  readonly when: string;
}

export const ERROR_CATALOG = {
  OK: { exitCode: 0, when: "success" },
  USAGE: { exitCode: 4, when: "unknown flag, missing argument, bad selector syntax" },
  CONFIG_INVALID: { exitCode: 1, when: "YAML does not parse or violates the v2 schema" },
  CONFIG_VERSION_UNSUPPORTED: { exitCode: 1, when: "version: names a module we do not ship" },
  VALIDATION_FAILED: { exitCode: 1, when: "preflight rejected the plan (collision, missing host, bad reference)" },
  ARCH_MISMATCH: { exitCode: 1, when: "the image's os/arch differs from the target host (or emulation was not proven)" },
  NO_MATCH: { exitCode: 3, when: "a selector matched zero units" },
  LOCK_HELD: { exitCode: 2, when: "another deploy holds the group lock" },
  ENGINE_UNAVAILABLE: { exitCode: 1, when: "the engine socket cannot be reached or started" },
  API_DRIFT: { exitCode: 1, when: "the engine's response does not match the generated types" },
  HEALTH_TIMEOUT: { exitCode: 1, when: "the new revision never became healthy" },
  PROXY_SWAP_FAILED: { exitCode: 1, when: "the proxy rejected the target swap" },
  TRANSPORT_ERROR: { exitCode: 1, when: "ssh failed or the connection dropped" },
  NOT_FOUND: { exitCode: 1, when: "the named unit, revision or container does not exist" },
  INTERNAL: { exitCode: 1, when: "a defect; message plus a short tag" },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

export interface CatalogEntry {
  code: ErrorCode;
  exitCode: number;
  when: string;
}

/** The catalog as data, for `bundant errors --json` and the docs generator. */
export function errorCatalog(): CatalogEntry[] {
  return ERROR_CODES.map((code) => ({
    code,
    exitCode: ERROR_CATALOG[code].exitCode,
    when: ERROR_CATALOG[code].when,
  }));
}

export function exitCodeForCode(code: ErrorCode): number {
  return ERROR_CATALOG[code].exitCode;
}

/** One tagged union member per failure kind. Messages match the human text. */
export class UsageError extends Data.TaggedError("UsageError")<{ message: string }> {}
export class ConfigError extends Data.TaggedError("ConfigError")<{ message: string; file?: string }> {}
export class ConfigVersionError extends Data.TaggedError("ConfigVersionError")<{
  message: string;
  file?: string;
}> {}
export class ValidationError extends Data.TaggedError("ValidationError")<{
  message: string;
  field?: string;
}> {}
export class ArchMismatchError extends Data.TaggedError("ArchMismatchError")<{
  message: string;
  image?: string;
  host?: string;
  imagePlatform?: string;
  hostPlatform?: string;
}> {}
export class NoMatchError extends Data.TaggedError("NoMatchError")<{
  message: string;
  pattern?: string;
}> {}
export class LockError extends Data.TaggedError("LockError")<{
  message: string;
  service?: string;
}> {}
export class EngineUnavailableError extends Data.TaggedError("EngineUnavailableError")<{
  message: string;
  host?: string;
}> {}
export class ApiDriftError extends Data.TaggedError("ApiDriftError")<{
  message: string;
  engine?: string;
  method?: string;
  path?: string;
}> {}
export class HealthError extends Data.TaggedError("HealthError")<{ message: string; target?: string }> {}
export class ProxyError extends Data.TaggedError("ProxyError")<{ message: string; service?: string }> {}
export class TransportError extends Data.TaggedError("TransportError")<{
  message: string;
  host?: string;
}> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  message: string;
  target?: string;
}> {}
export class UnknownError extends Data.TaggedError("UnknownError")<{ message: string }> {}

export type AppError =
  | UsageError
  | ConfigError
  | ConfigVersionError
  | ValidationError
  | ArchMismatchError
  | NoMatchError
  | LockError
  | EngineUnavailableError
  | ApiDriftError
  | HealthError
  | ProxyError
  | TransportError
  | NotFoundError
  | UnknownError;

const CODE_BY_TAG = {
  UsageError: "USAGE",
  ConfigError: "CONFIG_INVALID",
  ConfigVersionError: "CONFIG_VERSION_UNSUPPORTED",
  ValidationError: "VALIDATION_FAILED",
  ArchMismatchError: "ARCH_MISMATCH",
  NoMatchError: "NO_MATCH",
  LockError: "LOCK_HELD",
  EngineUnavailableError: "ENGINE_UNAVAILABLE",
  ApiDriftError: "API_DRIFT",
  HealthError: "HEALTH_TIMEOUT",
  ProxyError: "PROXY_SWAP_FAILED",
  TransportError: "TRANSPORT_ERROR",
  NotFoundError: "NOT_FOUND",
  UnknownError: "INTERNAL",
} as const satisfies Record<AppError["_tag"], ErrorCode>;

export function codeFor(error: AppError): ErrorCode {
  return CODE_BY_TAG[error._tag];
}

/** Exit status is read from the catalog, never pattern-matched at call sites. */
export function exitCodeFor(error: AppError): number {
  return exitCodeForCode(codeFor(error));
}

export interface AgentFailure {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/** Every extra field of the tagged error becomes machine-readable details. */
export function failureFor(error: AppError): AgentFailure {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
    if (key === "_tag" || key === "message" || value === undefined) continue;
    details[key] = value;
  }
  if (codeFor(error) === "INTERNAL") details.tag = error._tag;
  return { code: codeFor(error), message: error.message, details };
}
