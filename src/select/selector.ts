import picomatch from "picomatch";

/** A unit's addressable path: group.service.role or group.name. */
export interface UnitPathIdentity {
  group?: string;
  service: string;
  role: string;
  kind?: "service" | "accessory";
}

export function unitPath(identity: UnitPathIdentity): string {
  const group = identity.group !== undefined && identity.group !== "" ? identity.group : "default";
  return identity.kind === "accessory"
    ? group + "." + identity.service
    : group + "." + identity.service + "." + identity.role;
}

export class SelectorError extends Error {
  readonly pattern: string;
  constructor(pattern: string, reason: string) {
    super('invalid selector "' + pattern + '": ' + reason);
    this.name = "SelectorError";
    this.pattern = pattern;
  }
}

export class NoMatchError extends Error {
  readonly pattern: string;
  constructor(pattern: string, searched?: string) {
    super('no unit matches "' + pattern + '"' + (searched !== undefined ? " (" + searched + ")" : ""));
    this.name = "NoMatchError";
    this.pattern = pattern;
  }
}

export interface ParsedSelector {
  readonly raw: string;
  readonly replica?: number;
  match(path: string): boolean;
}

/**
 * picomatch over a path where '.' maps to '/': '*' is one segment, '**' is any
 * number. A bare '*' means everything. Revision/replica are flags, never
 * segments, so a trailing numeric segment is rejected.
 */
export function parseSelector(pattern: string): ParsedSelector {
  const raw = pattern.trim();
  if (raw === "") throw new SelectorError(pattern, "selector must not be empty");
  const segments = raw.split(".");
  if (segments.some((segment) => segment === "")) {
    throw new SelectorError(pattern, "empty path segment");
  }
  const last = segments[segments.length - 1]!;
  if (/^[0-9]+$/.test(last)) {
    throw new SelectorError(
      pattern,
      "a trailing numeric segment is ambiguous; use --replica N or --revision REV",
    );
  }
  const normalized = raw === "*" ? "**" : raw;
  const matcher = picomatch(normalized.replaceAll(".", "/"));
  return {
    raw,
    match: (path: string) => matcher(path.replaceAll(".", "/")),
  };
}

export function selectUnits<T extends { path: string }>(
  selector: string | ParsedSelector,
  units: ReadonlyArray<T>,
  searched?: string,
): T[] {
  const parsed = typeof selector === "string" ? parseSelector(selector) : selector;
  const matches = units.filter((unit) => parsed.match(unit.path));
  if (matches.length === 0) throw new NoMatchError(parsed.raw, searched);
  return matches;
}
