import type { AppError, ErrorCode } from "./errors.ts";
import { failureFor } from "./errors.ts";

/** The one object written to stdout in --json mode. */
export interface AgentSuccess<T = unknown> {
  ok: true;
  command: string;
  data: T;
}

export interface AgentErrorBody {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export interface AgentFailure {
  ok: false;
  command: string;
  error: AgentErrorBody;
}

export type AgentEnvelope<T = unknown> = AgentSuccess<T> | AgentFailure;

export function successEnvelope<T>(command: string, data: T): AgentSuccess<T> {
  return { ok: true, command, data };
}

export function failureEnvelope(command: string, error: AppError): AgentFailure {
  return { ok: false, command, error: failureFor(error) };
}

/** One object, one line: the only thing a JSON client ever parses. */
export function renderEnvelope(envelope: AgentEnvelope): string {
  return JSON.stringify(envelope) + "\n";
}
