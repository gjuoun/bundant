import { failureEnvelope, renderEnvelope, successEnvelope } from "./envelope.ts";
import type { AppError } from "./errors.ts";
import { exitCodeFor } from "./errors.ts";

/**
 * Process-wide JSON mode. While active every stdout write (console.log and
 * direct process.stdout.write) is forwarded to stderr, so progress and logs
 * stay on stderr and exactly one envelope reaches stdout at the end.
 */
interface JsonState {
  command: string;
  hasData: boolean;
  data: unknown;
  failure: AppError | null;
}

let state: JsonState | null = null;
let savedLog: typeof console.log | null = null;
let savedInfo: typeof console.info | null = null;
let savedWrite: typeof process.stdout.write | null = null;

export function beginJson(command: string): void {
  if (state !== null) return;
  state = { command, hasData: false, data: null, failure: null };
  savedWrite = process.stdout.write;
  savedLog = console.log;
  savedInfo = console.info;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = console.log;
}

export function isJsonMode(): boolean {
  return state !== null;
}

/** Commands call this with their command-specific payload instead of printing it. */
export function recordData(data: unknown): void {
  if (state === null) return;
  state.data = data;
  state.hasData = true;
}

/** A failure discovered by a handler that did not throw. */
export function recordFailure(error: AppError): void {
  if (state === null) return;
  state.failure = error;
}

export function hasFailure(): boolean {
  return state !== null && state.failure !== null;
}

export function hasData(): boolean {
  return state !== null && state.hasData;
}

function restore(): void {
  if (savedWrite !== null) process.stdout.write = savedWrite;
  if (savedLog !== null) console.log = savedLog;
  if (savedInfo !== null) console.info = savedInfo;
  savedWrite = null;
  savedLog = null;
  savedInfo = null;
}

/**
 * Close JSON mode: restore stdio, write exactly one object to stdout and
 * return the process exit status the catalog prescribes.
 */
export function finishJson(code: number): number {
  if (state === null) return code;
  const active = state;
  state = null;
  restore();

  const write = savedWrite ?? process.stdout.write.bind(process.stdout);
  if (active.failure !== null) {
    write(renderEnvelope(failureEnvelope(active.command, active.failure)));
    return exitCodeFor(active.failure);
  }
  if (code !== 0) {
    const fallback = {
      ok: false as const,
      command: active.command,
      error: {
        code: "INTERNAL" as const,
        message: "command failed with exit code " + code,
        details: { exitCode: code },
      },
    };
    write(renderEnvelope(fallback));
    return 1;
  }
  write(renderEnvelope(successEnvelope(active.command, active.hasData ? active.data : null)));
  return 0;
}

/** The command path for the envelope, from argv (flags and their values skipped). */
export function commandName(argv: ReadonlyArray<string>): string {
  const withValue = new Set([
    "--file", "-f", "--rev", "--local-image", "--pull", "--keep", "--replicas",
    "--to-revision", "--host", "--container", "--tail", "--since", "--port",
    "--hosts", "--replica", "--revision",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (withValue.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return "bundant";
}

/** True when argv asks for JSON before any `--` passthrough. */
export function wantsJson(argv: ReadonlyArray<string>): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--json") return true;
  }
  return false;
}
