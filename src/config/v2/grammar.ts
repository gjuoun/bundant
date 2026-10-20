import {
  DEFAULT_GROUP,
  NameParseError,
  type NameGrammar,
  type NameIdentity,
} from "../grammar.ts";

/** v2 identifier: letters/digits plus single, non-edge '-' or '_'. No dots. */
export const IDENTIFIER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9]))*$/;
export const REVISION_RE = /^[A-Za-z0-9]+$/;
export const IDENTIFIER_RULE =
  "must match [A-Za-z0-9]([A-Za-z0-9]|[-_][A-Za-z0-9])* (letters, digits, '-' and '_'; no leading/trailing/consecutive separators, no '.')";
export const REVISION_RULE = "must match [A-Za-z0-9]+";

function groupOf(identity: NameIdentity): string {
  return identity.group !== undefined && identity.group !== "" ? identity.group : DEFAULT_GROUP;
}

export function composeDotted(identity: NameIdentity): string {
  const group = groupOf(identity);
  const base = group + "." + identity.service + "." + identity.role + "." + identity.revision;
  return identity.replica === undefined ? base : base + "." + identity.replica;
}

export function composeAccessory(identity: NameIdentity): string {
  return groupOf(identity) + "." + identity.service;
}

/** Parse 2 segments (accessory), 4 (service), 5 (service+replica). */
export function parseDotted(name: string, group?: string): NameIdentity {
  const parts = name.split(".");
  if (parts.some((part) => part === "")) {
    throw new NameParseError(name, "empty segment");
  }
  for (const part of parts.slice(0, -1)) {
    if (!IDENTIFIER_RE.test(part)) {
      throw new NameParseError(name, 'identifier "' + part + '" ' + IDENTIFIER_RULE);
    }
  }
  const last = parts[parts.length - 1]!;
  if (parts.length === 2) {
    if (!IDENTIFIER_RE.test(last)) {
      throw new NameParseError(name, 'service "' + last + '" ' + IDENTIFIER_RULE);
    }
    if (group !== undefined && group !== parts[0]) {
      throw new NameParseError(name, 'group segment "' + parts[0] + '" is not "' + group + '"');
    }
    return { group: parts[0]!, service: last, role: "", revision: "", kind: "accessory" } as NameIdentity;
  }
  if (parts.length !== 4 && parts.length !== 5) {
    throw new NameParseError(name, "expected group.name / group.service.role.revision[.replica]");
  }
  const [parsedGroup, service, role, revision, replica] = parts;
  if (!REVISION_RE.test(revision!)) {
    throw new NameParseError(name, 'revision "' + revision + '" ' + REVISION_RULE);
  }
  if (replica !== undefined && !/^[0-9]+$/.test(replica)) {
    throw new NameParseError(name, 'replica "' + replica + '" must be digits');
  }
  if (group !== undefined && group !== parsedGroup) {
    throw new NameParseError(name, 'group segment "' + parsedGroup + '" is not "' + group + '"');
  }
  const identity: NameIdentity = {
    group: parsedGroup!,
    service: service!,
    role: role!,
    revision: revision!,
  };
  if (replica !== undefined) identity.replica = Number(replica);
  return identity;
}

export function roundTripsDotted(identity: NameIdentity): boolean {
  const kind = (identity as NameIdentity & { kind?: string }).kind;
  try {
    const composed = kind === "accessory" ? composeAccessory(identity) : composeDotted(identity);
    const parsed = parseDotted(composed, identity.group);
    return (
      (parsed.group ?? DEFAULT_GROUP) === (identity.group ?? DEFAULT_GROUP) &&
      parsed.service === identity.service &&
      (kind === "accessory" || (parsed.role === identity.role && parsed.revision === identity.revision)) &&
      parsed.replica === identity.replica
    );
  } catch {
    return false;
  }
}

export const v2Grammar: NameGrammar = {
  service: IDENTIFIER_RE,
  group: IDENTIFIER_RE,
  role: IDENTIFIER_RE,
  revision: REVISION_RE,
  serviceRule: IDENTIFIER_RULE,
  segmentRule: IDENTIFIER_RULE,
  defaultGroup: DEFAULT_GROUP,
  compose: composeDotted,
  parse: parseDotted,
  roundTrips: roundTripsDotted,
  accessoryCompose: composeAccessory,
  replicaSeparator: ".",
};
