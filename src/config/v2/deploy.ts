import { z } from "zod";
import { namedString } from "../zod.ts";
import {
  EnvSchema,
  HealthSchema,
  ProxySchema,
  SshSchema,
  normalize,
  preflight,
} from "../deploy-base.ts";
import { IDENTIFIER_RE, IDENTIFIER_RULE, v2Grammar } from "./grammar.ts";

/** Version 2 deploy schema: shared sections plus the dotted naming grammar. */
export const RawConfigSchema = z.object({
  version: z.literal(2),
  service: namedString("service", IDENTIFIER_RE, IDENTIFIER_RULE, "service name (v2 identifier)"),
  image: z.string().min(1),
  role: namedString("role", IDENTIFIER_RE, IDENTIFIER_RULE, "role name (v2 identifier)").optional(),
  replicas: z.number().int().min(1).optional(),
  kind: z
    .enum(["service", "accessory"])
    .describe("service (default) deploys/rolls back; accessory is stateful: stable name, named volumes, flat lifecycle verbs")
    .optional(),
  volumes: z
    .array(z.string().min(1))
    .describe('accessory named volumes, "name:/path/in/container" - survive container recreation')
    .optional(),
  hosts: z.array(z.string().min(1)).optional(),
  ssh: z.union([SshSchema, z.string().min(1)]).optional(),
  runtime: z.enum(["docker", "podman"]).optional(),
  env: EnvSchema.optional(),
  healthcheck: HealthSchema.optional(),
  proxy: ProxySchema.optional(),
})
  .strict()
  .superRefine((raw, ctx) => {
    const identity = {
      group: "default",
      service: raw.service,
      role: raw.role ?? "web",
      revision: "r0",
      kind: raw.kind ?? "service",
    };
    if (!IDENTIFIER_RE.test(identity.service) || !IDENTIFIER_RE.test(identity.role)) return;
    if (v2Grammar.roundTrips(identity)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: 'composed name "' + v2Grammar.compose(identity) + '" does not round-trip',
    });
  });

export { normalize, preflight };
