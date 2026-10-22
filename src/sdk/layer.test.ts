import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { makeSdkLayer, SdkServices } from "./layer.ts";

describe("makeSdkLayer", () => {
  it("provides the configured hosts", async () => {
    const hosts = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return (yield* SdkServices).hosts;
        }),
        makeSdkLayer({ hosts: ["h1", "h2"] }),
      ),
    );
    expect(hosts).toEqual(["h1", "h2"]);
  });

  it("falls back to BUNDANT_HOSTS and a git revision resolver", async () => {
    const previous = process.env.BUNDANT_HOSTS;
    process.env.BUNDANT_HOSTS = "a,b";
    try {
      const services = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            return yield* SdkServices;
          }),
          makeSdkLayer(),
        ),
      );
      expect(services.hosts).toEqual(["a", "b"]);
      expect(typeof services.revision).toBe("function");
      expect(typeof services.openOps).toBe("function");
    } finally {
      if (previous === undefined) delete process.env.BUNDANT_HOSTS;
      else process.env.BUNDANT_HOSTS = previous;
    }
  });
});
