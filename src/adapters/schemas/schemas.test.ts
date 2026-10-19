import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiSchemaDriftError, parseOrDrift } from "./drift.ts";
import {
  createContainerSchema,
  eventSchema,
  inspectSchema,
  statsSchema,
  summarySchema,
  versionSchema,
  volumeSchema,
} from "./payloads.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const ctx = { engine: "docker" as const, method: "GET", path: "/fixtures" };

function driftOf(body: unknown): ApiSchemaDriftError {
  try {
    parseOrDrift(inspectSchema, body, ctx);
  } catch (err) {
    if (err instanceof ApiSchemaDriftError) return err;
    throw err;
  }
  throw new Error("expected ApiSchemaDriftError");
}

describe("schemas accept the recorded real payloads", () => {
  for (const engine of ["docker", "podman"] as const) {
    test(engine + " version", () => {
      const payload = parseOrDrift(versionSchema, fixture(engine + "-version.json"), {
        ...ctx,
        engine,
      });
      expect(payload.Version).toBeString();
      expect(payload.ApiVersion).toBeString();
      expect(payload.Components?.some((c) => c.Name?.includes("Engine") || c.Name?.includes("Podman"))).toBe(true);
    });

    test(engine + " container summary", () => {
      const row = parseOrDrift(summarySchema, fixture(engine + "-containers.json"), {
        ...ctx,
        engine,
      });
      expect(row.Id).toBeString();
      expect(row.Names?.length).toBeGreaterThan(0);
      expect(row.State).toBeString();
      expect(row.Labels).toBeObject();
    });

    test(engine + " inspect", () => {
      const payload = parseOrDrift(inspectSchema, fixture(engine + "-inspect.json"), {
        ...ctx,
        engine,
      });
      expect(payload.Id).toBeString();
      expect(payload.Name).toBeString();
      expect(payload.State?.Running).toBeBoolean();
      expect(payload.HostConfig?.RestartPolicy?.Name).toBeString();
    });

    test(engine + " stats", () => {
      const sample = parseOrDrift(statsSchema, fixture(engine + "-stats.json"), {
        ...ctx,
        engine,
      });
      expect(sample.read).toBeString();
      expect(sample.cpu_stats.cpu_usage.total_usage).toBeNumber();
      expect(sample.memory_stats.limit).toBeNumber();
      expect(sample.pids_stats.current).toBeNumber();
    });

    test(engine + " volume", () => {
      const volume = parseOrDrift(volumeSchema, fixture(engine + "-volume.json"), {
        ...ctx,
        engine,
      });
      expect(volume.Name).toBeString();
      expect(volume.Labels).toBeObject();
    });

    test(engine + " event", () => {
      const event = parseOrDrift(eventSchema, fixture(engine + "-event.json"), {
        ...ctx,
        engine,
      });
      expect(event.Type).toBeString();
      expect(event.Action).toBeString();
      expect(event.time).toBeNumber();
    });
  }

  test("docker volume Labels:null is normalized to an empty record", () => {
    expect(fixture("docker-volume.json")).toMatchObject({ Labels: null });
    const volume = parseOrDrift(volumeSchema, fixture("docker-volume.json"), ctx);
    expect(volume.Labels).toEqual({});
  });
});

describe("mutated payloads raise ApiSchemaDriftError", () => {
  test("wrong type names the pointer and shows only the offending value", () => {
    const body = fixture("docker-inspect.json") as Record<string, unknown>;
    body.State = { ...(body.State as object), Running: "yes" };
    const err = driftOf(body);
    expect(err.pointer).toBe("/State/Running");
    expect(err.excerpt).toBe('"yes"');
    expect(err.message).toContain("docker GET /fixtures at /State/Running");
    expect(err.message).toContain("Expected boolean");
  });

  test("missing required field reports the root pointer", () => {
    const body = fixture("docker-inspect.json") as Record<string, unknown>;
    delete body.Id;
    const err = driftOf(body);
    expect(err.pointer).toBe("/Id");
    expect(err.issue).toBe("Required");
  });

  test("an unexpected enum value is drift, not a silent default", () => {
    const body = fixture("docker-containers.json") as Record<string, unknown>;
    body.State = "ghost";
    try {
      parseOrDrift(summarySchema, body, ctx);
      throw new Error("expected drift");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/State");
      expect((err as ApiSchemaDriftError).excerpt).toBe('"ghost"');
    }
  });

  test("a malformed stats body is drift", () => {
    const body = fixture("podman-stats.json") as Record<string, unknown>;
    delete body.cpu_stats;
    try {
      parseOrDrift(statsSchema, body, { engine: "podman", method: "GET", path: "/containers/x/stats" });
      throw new Error("expected drift");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/cpu_stats");
    }
  });

  test("a malformed event is drift", () => {
    const body = fixture("docker-event.json") as Record<string, unknown>;
    delete body.Action;
    try {
      parseOrDrift(eventSchema, body, ctx);
      throw new Error("expected drift");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/Action");
    }
  });

  test("error text never echoes env values from the payload", () => {
    const body = fixture("docker-inspect.json") as Record<string, unknown>;
    body.Config = { ...(body.Config as object), Env: ["TOKEN=super-secret-value"] };
    body.State = { ...(body.State as object), Running: "yes" };
    const err = driftOf(body);
    expect(err.message).not.toContain("super-secret-value");
    expect(err.excerpt).toBe('"yes"');
  });
});

describe("outbound create body reuses the generated request type", () => {
  test("accepts the shape stage 3 will send", () => {
    const body = parseOrDrift(
      createContainerSchema,
      {
        Image: "example/api:1",
        Env: ["A=1"],
        Labels: { "bundant.service": "api" },
        HostConfig: {
          Binds: ["vol:/data"],
          NetworkMode: "bundant",
          RestartPolicy: { Name: "unless-stopped" },
        },
      },
      ctx,
    );
    expect(body.HostConfig?.RestartPolicy?.Name).toBe("unless-stopped");
  });

  test("rejects an unknown restart policy before it reaches the engine", () => {
    try {
      parseOrDrift(
        createContainerSchema,
        { Image: "x", HostConfig: { RestartPolicy: { Name: "sometimes" } } },
        ctx,
      );
      throw new Error("expected drift");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiSchemaDriftError);
      expect((err as ApiSchemaDriftError).pointer).toBe("/HostConfig/RestartPolicy/Name");
    }
  });
});
