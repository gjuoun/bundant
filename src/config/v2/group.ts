import { z } from "zod";
import { namedString } from "../zod.ts";
import { IDENTIFIER_RE, IDENTIFIER_RULE, v2Grammar } from "./grammar.ts";

export const GroupServiceSchema = z.object({
  name: namedString("member", IDENTIFIER_RE, IDENTIFIER_RULE, "member identity (v2 identifier)"),
  file: z.string().min(1),
  needs: z.array(namedString("dependency", IDENTIFIER_RE, IDENTIFIER_RULE)).optional(),
}).strict();

export const GroupFileSchema = z.object({
  version: z.literal(2),
  group: namedString("group", IDENTIFIER_RE, IDENTIFIER_RULE, "namespace name (v2 identifier)"),
  services: z.array(GroupServiceSchema).min(1),
})
  .strict()
  .superRefine((raw, ctx) => {
    if (!IDENTIFIER_RE.test(raw.group)) return;
    raw.services.forEach((member, index) => {
      if (!IDENTIFIER_RE.test(member.name)) return;
      const identity = { group: raw.group, service: member.name, role: "web", revision: "r0" };
      if (v2Grammar.roundTrips(identity)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services", index, "name"],
        message: 'composed name "' + v2Grammar.compose(identity) + '" does not round-trip',
      });
    });
  });

export type GroupFile = z.infer<typeof GroupFileSchema>;
