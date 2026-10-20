import { z } from "zod";
import type { components, operations } from "../generated/docker-api.d.ts";
import type { components as PodmanComponents } from "../generated/podman-api.d.ts";

/**
 * Wire schemas for exactly the payloads the adapters consume.
 *
 * Every schema is annotated with a type derived from the generated official
 * spec. A field that the schema accepts but the spec does not declare, or a
 * field name that drifts, is a compile error:
 *
 *   export const inspectSchema = z.object({
 *     // @ts-expect-error "Idd" is not a field of ContainerInspectResponse
 *     Idd: z.string(),
 *   });
 *
 * Podman's Docker-compatible endpoints answer the Docker shapes (verified on
 * 5.7.0), so the same schemas validate both engines. Its spec declares the
 * compat stats body as `Record<string, never>` and omits the compat events
 * body; the Docker contract is the only official shape available there.
 */

type Schemas = components["schemas"];

export type VersionPayload = PodmanComponents["schemas"]["SystemComponentVersion"];

export const versionSchema = z.object({
  Version: z.string().optional(),
  ApiVersion: z.string().optional(),
  MinAPIVersion: z.string().optional(),
  Components: z
    .array(
      z.object({
        Name: z.string().optional(),
        Version: z.string().optional(),
        Details: z.record(z.string()).optional(),
      }),
    )
    .optional(),
});

type InspectResponse = Schemas["ContainerInspectResponse"];
type InspectConfig = NonNullable<InspectResponse["Config"]>;
type InspectState = NonNullable<InspectResponse["State"]>;
type InspectHostConfig = NonNullable<InspectResponse["HostConfig"]>;

export type InspectWire = Pick<InspectResponse, "Id" | "Name" | "RestartCount"> & {
  Config?: Pick<InspectConfig, "Image" | "Env" | "Labels">;
  // Podman's compat API adds "stopping"; the generated Docker wire type omits it.
  State?: Pick<InspectState, "Running" | "ExitCode" | "StartedAt" | "Health"> & {
    Status?: InspectState["Status"] | "stopping";
  };
  HostConfig?: Pick<InspectHostConfig, "RestartPolicy" | "Binds" | "NetworkMode" | "LogConfig">;
};

const restartPolicyName = z.enum(["", "no", "always", "unless-stopped", "on-failure"]);

export const inspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  RestartCount: z.number().optional(),
  Config: z
    .object({
      Image: z.string().optional(),
      Env: z.array(z.string()).nullish().transform((value) => value ?? []),
      Labels: z.record(z.string()).nullish().transform((value) => value ?? {}),
    })
    .optional(),
  State: z
    .object({
      Status: z.enum(["created", "running", "paused", "restarting", "stopping", "removing", "exited", "dead"]),
      Running: z.boolean().optional(),
      ExitCode: z.number().optional(),
      StartedAt: z.string().optional(),
      Health: z
        .object({ Status: z.enum(["none", "starting", "healthy", "unhealthy"]).optional() })
        .nullish(),
    })
    .optional(),
  HostConfig: z
    .object({
      RestartPolicy: z
        .object({
          Name: restartPolicyName.optional(),
          MaximumRetryCount: z.number().optional(),
        })
        .optional(),
      Binds: z.array(z.string()).nullish().transform((value) => value ?? []),
      NetworkMode: z.string().optional(),
      LogConfig: z
        .object({
          Type: z
            .enum(["local", "json-file", "syslog", "journald", "gelf", "fluentd", "awslogs", "splunk", "etwlogs", "none"])
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Live compile-time guard: this block is never executed, but tsc type-checks
 * it. The @ts-expect-error is consumed by the mismatch; if the schema ever
 * stops rejecting an undeclared field, tsc reports an unused directive and
 * `bun run typecheck` fails. Removing the directive in a scratch copy makes
 * the wrong field a hard error (demonstrated in the card evidence).
 */
if (false) {
  // @ts-expect-error "Idd" is not a field of ContainerInspectResponse
  const driftedInspect: z.ZodType<InspectWire> = z.object({ Idd: z.string() });
  void driftedInspect;
}

type Summary = Schemas["ContainerSummary"];

export type SummaryWire = Pick<
  Summary,
  "Id" | "Names" | "Image" | "Status" | "Labels" | "Created" | "Ports"
> & {
  // Podman reports "stopping" while a container drains; Docker's spec does not.
  State?: Summary["State"] | "stopping";
};

export const summarySchema = z.object({
  Id: z.string(),
  Names: z.array(z.string()),
  Image: z.string(),
  State: z.enum(["created", "running", "paused", "restarting", "stopping", "removing", "exited", "dead"]),
  Status: z.string(),
  Labels: z.record(z.string()),
  Created: z.number(),
  Ports: z
    .array(
      z.object({
        IP: z.string().optional(),
        PrivatePort: z.number(),
        PublicPort: z.number().optional(),
        Type: z.enum(["tcp", "udp", "sctp"]),
      }),
    )
    .nullish()
    .transform((value) => value ?? []),
});

export const summaryListSchema = z.array(summarySchema);

type StatsResponse = Schemas["ContainerStatsResponse"];
type CpuStats = NonNullable<StatsResponse["cpu_stats"]>;
type CpuUsage = NonNullable<CpuStats["cpu_usage"]>;
type MemoryStats = NonNullable<StatsResponse["memory_stats"]>;
type PidsStats = NonNullable<StatsResponse["pids_stats"]>;
type NetworkStats = NonNullable<NonNullable<StatsResponse["networks"]>[string]>;

export type StatsWire = Pick<StatsResponse, "read"> & {
  cpu_stats: Pick<CpuStats, "system_cpu_usage" | "online_cpus"> & {
    cpu_usage: Pick<CpuUsage, "total_usage" | "percpu_usage">;
  };
  precpu_stats?: Pick<CpuStats, "system_cpu_usage"> & {
    cpu_usage?: Pick<CpuUsage, "total_usage">;
  };
  memory_stats: Pick<MemoryStats, "usage" | "limit">;
  pids_stats: Pick<PidsStats, "current">;
  networks?: Record<string, Pick<NetworkStats, "rx_bytes" | "tx_bytes">>;
};

export const statsSchema = z.object({
  read: z.string(),
  cpu_stats: z.object({
    cpu_usage: z.object({
      total_usage: z.number(),
      percpu_usage: z.array(z.number()).nullish(),
    }),
    system_cpu_usage: z.number(),
    online_cpus: z.number().nullish(),
  }),
  precpu_stats: z
    .object({
      cpu_usage: z.object({ total_usage: z.number() }).optional(),
      system_cpu_usage: z.number().optional(),
    })
    .optional(),
  memory_stats: z.object({
    usage: z.number(),
    limit: z.number(),
  }),
  pids_stats: z.object({
    current: z.number(),
  }),
  networks: z
    .record(
      z.object({
        rx_bytes: z.number(),
        tx_bytes: z.number(),
      }),
    )
    .optional(),
});

type Volume = Schemas["Volume"];

export type VolumeWire = Pick<Volume, "Name"> & {
  Labels: Record<string, string>;
};

/** Docker answers `Labels: null` for an unlabelled volume; normalize it. */
export const volumeSchema = z.object({
  Name: z.string(),
  Labels: z.preprocess(
    (value) => (value === null || value === undefined ? {} : value),
    z.record(z.string()),
  ),
});

type EventMessage = Schemas["EventMessage"];
type EventActor = NonNullable<EventMessage["Actor"]>;

export type EventWire = {
  Type: NonNullable<EventMessage["Type"]>;
  Action: NonNullable<EventMessage["Action"]>;
  time: NonNullable<EventMessage["time"]>;
  timeNano?: number;
  Actor?: Pick<EventActor, "ID" | "Attributes">;
};

export const eventSchema = z.object({
  Type: z.enum([
    "builder",
    "config",
    "container",
    "daemon",
    "image",
    "network",
    "node",
    "plugin",
    "secret",
    "service",
    "volume",
  ]),
  Action: z.string(),
  time: z.number(),
  timeNano: z.number().optional(),
  Actor: z
    .object({
      ID: z.string().optional(),
      Attributes: z.record(z.string()).optional(),
    })
    .optional(),
});

type CreateBody = operations["ContainerCreate"]["requestBody"]["content"]["application/json"];

type CreateHostConfig = NonNullable<CreateBody["HostConfig"]>;

export type CreateWire = Pick<CreateBody, "Image" | "Env" | "Labels"> & {
  HostConfig?: Pick<CreateHostConfig, "Binds" | "NetworkMode" | "RestartPolicy">;
};

export const createContainerSchema = z.object({
  Image: z.string(),
  Env: z.array(z.string()).optional(),
  Labels: z.record(z.string()).optional(),
  HostConfig: z
    .object({
      Binds: z.array(z.string()).optional(),
      NetworkMode: z.string().optional(),
      RestartPolicy: z
        .object({
          Name: restartPolicyName,
          MaximumRetryCount: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

type StopQuery = NonNullable<operations["ContainerStop"]["parameters"]["query"]>;
export const stopQuerySchema = z.object({
  t: z.number().optional(),
});

type DeleteQuery = NonNullable<operations["ContainerDelete"]["parameters"]["query"]>;
export const removeQuerySchema = z.object({
  force: z.boolean().optional(),
  v: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Compile-time guards (see ./exact.ts):
//  * assertAssignable: the schema's output must fit the generated wire type
//  * assertNoExtraKeys: the schema must not declare a field the spec lacks,
//    which is the failure mode a bare annotation misses (spec properties are
//    almost all optional, so a renamed field still "fits").
// Renaming `Id` to `Idd` below makes `tsc` fail.
// ---------------------------------------------------------------------------
import { assertAssignable, assertNoExtraKeys, type ShapeKeys } from "./exact.ts";

assertAssignable<z.infer<typeof versionSchema>, VersionPayload>(true);
assertAssignable<z.infer<typeof inspectSchema>, InspectWire>(true);
assertAssignable<z.infer<typeof summarySchema>, SummaryWire>(true);
assertAssignable<z.infer<typeof statsSchema>, StatsWire>(true);
assertAssignable<z.infer<typeof volumeSchema>, VolumeWire>(true);
assertAssignable<z.infer<typeof eventSchema>, EventWire>(true);
assertAssignable<z.infer<typeof createContainerSchema>, CreateWire>(true);

assertNoExtraKeys<ShapeKeys<typeof versionSchema>, VersionPayload>(true);
assertNoExtraKeys<ShapeKeys<typeof inspectSchema>, InspectWire>(true);
assertNoExtraKeys<ShapeKeys<typeof summarySchema>, SummaryWire>(true);
assertNoExtraKeys<ShapeKeys<typeof statsSchema>, StatsWire>(true);
assertNoExtraKeys<ShapeKeys<typeof volumeSchema>, VolumeWire>(true);
assertNoExtraKeys<ShapeKeys<typeof eventSchema>, EventWire>(true);
