import { z } from "zod";
import type { ValidationIssue } from "./types.ts";

/**
 * Value-specific zod string. \`.regex\` keeps the pattern in the generated JSON
 * schema; the \`superRefine\` adds the exact field/value message the CLI prints.
 * Reports dedupe the two by field, keeping the value-specific one.
 */
export function namedString(label: string, re: RegExp, rule: string, description?: string) {
  const schema = z
    .string()
    .regex(re, rule)
    .superRefine((value, ctx) => {
      if (re.test(value)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: label + ' "' + value + '" ' + rule,
      });
    });
  return description === undefined ? schema : schema.describe(description);
}

/** Collapse duplicate issues for one field, preferring the value-specific message. */
export function zodIssues(error: z.ZodError): ValidationIssue[] {
  const byField = new Map<string, ValidationIssue>();
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "(root)";
    const current = byField.get(field);
    const better = issue.message.includes('"') || current === undefined;
    if (better) byField.set(field, { field, message: issue.message });
  }
  return [...byField.values()];
}
