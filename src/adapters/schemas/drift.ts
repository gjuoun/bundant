import type { z } from "zod";
import type { RuntimeKind } from "../../runtime.ts";

/** Engine, request, and the first failing JSON pointer for a payload mismatch. */
export interface ParseContext {
  engine: RuntimeKind;
  method: string;
  path: string;
}

function pointerFor(path: (string | number)[]): string {
  if (path.length === 0) return "";
  return "/" + path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

/**
 * Describe the value at the failing pointer without ever copying the body:
 * object shapes become key lists, so env vars and labels cannot leak.
 */
function excerptAt(body: unknown, path: (string | number)[]): string {
  let current: unknown = body;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") current = current[part];
    else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[String(part)];
    } else {
      current = undefined;
    }
  }
  if (current === undefined) return "undefined";
  if (current === null) return "null";
  if (typeof current === "string") return JSON.stringify(current.slice(0, 80));
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  if (Array.isArray(current)) return "[array length " + current.length + "]";
  const keys = Object.keys(current as Record<string, unknown>).slice(0, 8);
  return "{object keys: " + keys.join(", ") + (keys.length === 8 ? ", ..." : "") + "}";
}

export class ApiSchemaDriftError extends Error {
  readonly engine: RuntimeKind;
  readonly method: string;
  readonly path: string;
  readonly pointer: string;
  readonly excerpt: string;
  readonly issue: string;

  constructor(context: ParseContext, issue: z.ZodIssue, body: unknown) {
    const pointer = pointerFor(issue.path as (string | number)[]);
    const excerpt = excerptAt(body, issue.path as (string | number)[]);
    super(
      "engine API schema drift: " + context.engine + " " + context.method + " " + context.path +
        " at " + (pointer === "" ? "<root>" : pointer) + " — " + issue.message +
        " (payload: " + excerpt + ")",
    );
    this.name = "ApiSchemaDriftError";
    this.engine = context.engine;
    this.method = context.method;
    this.path = context.path;
    this.pointer = pointer;
    this.excerpt = excerpt;
    this.issue = issue.message;
  }
}

/**
 * Validate one inbound payload at the adapter boundary. Success returns the
 * parsed value; failure throws ApiSchemaDriftError with the first issue only.
 */
export function parseOrDrift<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  context: ParseContext,
): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data as z.infer<T>;
  const issue = result.error.issues[0];
  if (issue === undefined) throw new ApiSchemaDriftError(context, { code: "custom", path: [], message: "payload did not validate" }, body);
  throw new ApiSchemaDriftError(context, issue, body);
}
