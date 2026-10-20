import {
  Effect,
  FileSystem,
  Layer,
  Path,
  Sink,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { AppLayer, type AppLayerType } from "../effect/runtime.ts";

function write(stream: NodeJS.WriteStream): Sink.Sink<void, string | Uint8Array> {
  return Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      stream.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
    }),
  );
}

const StdioLayer = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.succeed(process.argv.slice(2)),
    stdout: () => write(process.stdout),
    stderr: () => write(process.stderr),
    stdin: Stream.empty,
    stdinIsTerminal: Effect.succeed(process.stdin.isTTY === true),
    stdoutIsTerminal: Effect.succeed(process.stdout.isTTY === true),
    stderrIsTerminal: Effect.succeed(process.stderr.isTTY === true),
  }),
);

const TerminalLayer = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(process.stdout.columns ?? 80),
    rows: Effect.succeed(process.stdout.rows ?? 24),
    readInput: Effect.die("no interactive input in bundant"),
    readLine: Effect.die("no interactive input in bundant"),
    display: () => Effect.void,
  }),
);

/** The core services effect/cli needs, alongside the app's Logger/Clock layer. */
export const CliLayer = Layer.mergeAll(
  AppLayer,
  StdioLayer,
  TerminalLayer,
  Path.layer,
  FileSystem.layerNoop({}),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
) as unknown as AppLayerType;
