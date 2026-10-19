import { z } from "zod";
import { namedString } from "../zod.ts";
import {
  DEFAULT_GROUP,
  GROUP_NAME_RE,
  SERVICE_NAME_RE,
  SEGMENT_NAME_RULE,
  SERVICE_NAME_RULE,
  v1Grammar,
  type NameIdentity,
} from "./grammar.ts";

/** group.yml schema for version 1. */
export const GroupServiceSchema = z.object({
  name: namedString("member", SERVICE_NAME_RE, SERVICE_NAME_RULE, "member identity; must equal the member file's service (single hyphens allowed)"),
  file: z.string().min(1).describe("path to deploy.yml/accessory.yml, relative to the group directory"),
  needs: z
    .array(namedString("dependency", SERVICE_NAME_RE, SERVICE_NAME_RULE))
    .describe("members that must be ready first; the install order is their topological sort")
    .optional(),
}).strict();

export const GroupFileSchema = z.object({
  version: z.literal(1).describe("config schema version; omitted = 1 (implicit)").optional(),
  group: namedString("group", GROUP_NAME_RE, SEGMENT_NAME_RULE, "namespace name; no hyphens (they are separators): scopes the env directory and the lock key"),
  services: z.array(GroupServiceSchema).min(1).describe("members; array order only breaks ties, needs decides the real order"),
})
  .strict()
  .superRefine((raw, ctx) => {
    if (!GROUP_NAME_RE.test(raw.group)) return;
    raw.services.forEach((member, index) => {
      if (!SERVICE_NAME_RE.test(member.name)) return;
      const identity: NameIdentity = {
        group: raw.group === DEFAULT_GROUP ? undefined : raw.group,
        service: member.name,
        role: "web",
        revision: "r0",
      };
      if (v1Grammar.roundTrips(identity)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services", index, "name"],
        message:
          'composed name "' + v1Grammar.compose(identity) +
          '" does not round-trip to the declared identity',
      });
    });
  });

export type GroupFile = z.infer<typeof GroupFileSchema>;
