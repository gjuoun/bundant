import { Clock, Effect, Layer, Logger } from "effect";
import type { Context } from "effect";
import {
  exitCodeFor,
  formatError,
  toAppError,
  type AppError,
} from "./errors.ts";

/**
 * Runtime skeleton: one layer per process, one error formatter, and a bridge
 * for the still-Promise command paths.
 *
 * Clock is Effect's built-in live Clock reference; the explicit Logger layer is
 * what this app configures today.
 */
export type AppLayerType = Layer.Layer<never, never, never>;

export const AppLayer = Layer.merge(
  Logger.layer([Logger.defaultLogger]),
  Layer.succeed(Clock.Clock, Clock.Clock.defaultValue()),
) as unknown as AppLayerType;

const built = new WeakMap<object, Promise<Context.Context<unknown>>>();

async function contextFor(layer: AppLayerType): Promise<Context.Context<unknown>> {
  const key = layer as unknown as object;
  const existing = built.get(key);
  if (existing !== undefined) return await existing;
  const building = Effect.runPromise(Effect.scoped(Layer.build(layer))) as Promise<
    Context.Context<unknown>
  >;
  built.set(key, building);
  return await building;
}

export interface RunMainOptions {
  /** Override the application layer (tests use a counting layer). */
  layer?: AppLayerType;
}

/**
 * Run one program with the application layer. Returns the process exit code:
 * the existing error text on stderr, 2 for lock contention, 1 otherwise.
 */
export async function runMain<A, E extends AppError>(
  effect: Effect.Effect<A, E, never>,
  opts: RunMainOptions = {},
): Promise<number> {
  const layer = opts.layer ?? AppLayer;
  try {
    const context = await contextFor(layer);
    const value = await Effect.runPromise(Effect.provide(effect, context));
    return typeof value === "number" ? value : 0;
  } catch (error) {
    const mapped = toAppError(error);
    console.error("bundant: " + formatError(mapped));
    return exitCodeFor(mapped);
  }
}

/** Bridge for command paths that are still Promise-based. */
export async function toPromise<A, E extends AppError>(
  effect: Effect.Effect<A, E, never>,
  layer: AppLayerType = AppLayer,
): Promise<A> {
  const context = await contextFor(layer);
  return await Effect.runPromise(Effect.provide(effect, context));
}

/** Same bridge, for effects that need a Scope (acquireRelease/streams). */
export async function runScoped<A, E extends AppError>(
  effect: Effect.Effect<A, E, never>,
  layer: AppLayerType = AppLayer,
): Promise<A> {
  return await toPromise(Effect.scoped(effect), layer);
}
