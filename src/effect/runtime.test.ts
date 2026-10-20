import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Layer, Schedule } from "effect";
import { z } from "zod";
import { TestClock } from "effect/testing";
import { ApiSchemaDriftError } from "../adapters/schemas/drift.ts";
import {
  ConfigError,
  LockError,
  UnknownError,
  toAppError,
} from "./errors.ts";
import { runMain, type AppLayerType } from "./runtime.ts";

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { code: await fn(), lines };
  } finally {
    console.error = original;
  }
}

describe("runMain", () => {
  test("maps ConfigError to exit 1 with the existing message", async () => {
    const result = await capture(() =>
      runMain(Effect.fail(new ConfigError({ message: "invalid deploy.yml: nope" }))),
    );
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(["bundant: invalid deploy.yml: nope"]);
  });

  test("maps LockError to its existing exit code 2", async () => {
    const result = await capture(() =>
      runMain(Effect.fail(new LockError({ message: "lock held", service: "api" }))),
    );
    expect(result.code).toBe(2);
    expect(result.lines).toEqual(["bundant: lock held"]);
  });

  test("builds the layer once per process", async () => {
    let built = 0;
    const counting = Layer.effectDiscard(
      Effect.sync(() => {
        built += 1;
      }),
    ) as unknown as AppLayerType;
    expect(await runMain(Effect.succeed(0), { layer: counting })).toBe(0);
    expect(await runMain(Effect.succeed(0), { layer: counting })).toBe(0);
    expect(built).toBe(1);
  });

  test("adapter drift becomes ApiDriftError with the same wording", () => {
    const original = new ApiSchemaDriftError(
      { engine: "docker", method: "GET", path: "/containers/json" },
      {
        code: z.ZodIssueCode.custom,
        path: ["Id"],
        message: "Required",
      },
      {},
    );
    const mapped = toAppError(original);
    expect(mapped._tag).toBe("ApiDriftError");
    expect(mapped.message).toBe(original.message);
  });

  test("unknown values still render their message", async () => {
    const result = await capture(() =>
      runMain(Effect.fail(new UnknownError({ message: "boom" }))),
    );
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(["bundant: boom"]);
  });
});

describe("TestClock retry/timeout plumbing", () => {
  test("retry waits on virtual time and succeeds", async () => {
    let attempts = 0;
    const flaky = Effect.suspend(() => {
      attempts += 1;
      return attempts < 3
        ? Effect.fail(new UnknownError({ message: "retry me" }))
        : Effect.succeed(attempts);
    });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        flaky.pipe(Effect.retry(Schedule.spaced("100 millis"))),
      );
      yield* TestClock.adjust("1 second");
      return yield* Fiber.join(fiber);
    });
    const value = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
    expect(value).toBe(3);
    expect(attempts).toBe(3);
  });

  test("timeout fires on virtual time", async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.sleep("60 seconds").pipe(Effect.timeout("5 seconds")),
      );
      yield* TestClock.adjust("5 seconds");
      const exit = yield* Fiber.await(fiber);
      return Exit.isFailure(exit);
    });
    const timedOut = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
    expect(timedOut).toBe(true);
  });
});
