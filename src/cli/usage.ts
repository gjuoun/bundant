import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import { CliLayer } from "./layer.ts";

type AnyCommand = Command.Command<any, any, any, any, any>;

/** Tags effect/cli uses for parse failures. ShowHelp with no errors is --help. */
const PARSE_TAGS = new Set([
  "UnrecognizedOption",
  "DuplicateOption",
  "MissingOption",
  "MissingArgument",
  "UnexpectedArgument",
  "InvalidValue",
  "UnknownSubcommand",
]);

const noop = (): void => undefined;
const NOOP_CONSOLE = {
  assert: noop,
  clear: noop,
  count: noop,
  countReset: noop,
  debug: noop,
  dir: noop,
  dirxml: noop,
  error: noop,
  group: noop,
  groupCollapsed: noop,
  groupEnd: noop,
  info: noop,
  log: noop,
  table: noop,
  time: noop,
  timeEnd: noop,
  timeLog: noop,
  trace: noop,
  warn: noop,
} as unknown as Console.Console;

/**
 * Clone the tree with every handler replaced by a no-op. Parsing still runs
 * exactly as the real command would, but a valid command can never execute.
 */
export function parseOnlyTree(command: AnyCommand): AnyCommand {
  const impl = command as unknown as Record<string, unknown> & {
    subcommands?: ReadonlyArray<{ group?: string; commands: ReadonlyArray<AnyCommand> }>;
  };
  const clone = Object.assign(Object.create(Object.getPrototypeOf(command)), impl);
  clone.handle = () => Effect.void;
  clone.subcommands = (impl.subcommands ?? []).map((group) => ({
    ...group,
    commands: group.commands.map((child) => parseOnlyTree(child)),
  }));
  return clone as AnyCommand;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "invalid command line";
}

/** One-line usage message for any effect/cli parse error, null otherwise. */
export function usageMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const error = value as { _tag?: unknown; message?: unknown; errors?: unknown[] };
  if (error._tag === "ShowHelp") {
    const errors = Array.isArray(error.errors) ? error.errors : [];
    return errors.length === 0 ? null : usageMessage(errors[0]);
  }
  if (typeof error._tag !== "string" || !PARSE_TAGS.has(error._tag)) return null;
  if (typeof error.message === "string") return firstLine(error.message);
  return firstLine(String(value));
}

/**
 * Run the real parser over a no-op tree before any command executes. Returns
 * the one-line reason for a parse failure, or null when the command line is
 * valid (including explicit --help / --version).
 */
export async function usageFailure(
  command: AnyCommand,
  args: ReadonlyArray<string>,
  version: string,
): Promise<string | null> {
  const program = Command.runWith(parseOnlyTree(command), {
    version,
    renderErrors: false,
  })(args).pipe(
    Effect.provide(CliLayer),
    Effect.provideService(Console.Console, NOOP_CONSOLE),
    Effect.as<string | null>(null),
    Effect.catch((error: unknown) => Effect.succeed(usageMessage(error))),
  );
  try {
    return await Effect.runPromise(program as Effect.Effect<string | null>);
  } catch {
    // A defect in the preflight must never block a valid command.
    return null;
  }
}
