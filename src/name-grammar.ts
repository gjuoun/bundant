/**
 * The single source of the name grammar. Config schemas, the revision
 * sanitizer, the composed-name round-trip and the validators all import these.
 *
 *   <group>-<service>-<role>-<rev>[-<i>]
 *
 * Only the service may contain a hyphen, and only between non-empty lowercase
 * segments. Group, role and revision are [a-z0-9]+, so the split is injective:
 * group = first segment, revision = right-most, role = second from right,
 * service = everything between.
 */

export const SERVICE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const GROUP_NAME_RE = /^[a-z0-9]+$/;
export const ROLE_NAME_RE = /^[a-z0-9]+$/;
export const REVISION_RE = /^[a-z0-9]+$/;

export const SERVICE_NAME_RULE =
  "must match [a-z0-9]+(-[a-z0-9]+)* (lowercase segments separated by single hyphens; no leading/trailing/double hyphen)";
export const SEGMENT_NAME_RULE =
  "must match [a-z0-9]+ (lowercase letters and digits only; hyphens are reserved as separators)";

export const DEFAULT_GROUP = "default";

export interface NameIdentity {
  group?: string;
  service: string;
  role: string;
  revision: string;
  /** 1-based replica index; omitted for the unsuffixed single-replica name. */
  replica?: number;
}

export class NameParseError extends Error {
  readonly containerName: string;
  constructor(containerName: string, reason: string) {
    super('cannot parse container name "' + containerName + '": ' + reason);
    this.name = "NameParseError";
    this.containerName = containerName;
  }
}

function isGrouped(group: string | undefined): boolean {
  return group !== undefined && group !== "" && group !== DEFAULT_GROUP;
}

/** Compose the canonical container name for an identity (default group never prefixes). */
export function composeContainerName(identity: NameIdentity): string {
  const prefix = isGrouped(identity.group) ? identity.group + "-" : "";
  const base = prefix + identity.service + "-" + identity.role + "-" + identity.revision;
  return identity.replica === undefined ? base : base + "-" + identity.replica;
}

/**
 * Parse a composed name. \`group\` is the namespace the caller expects: grouped
 * names must start with it; the default group means the legacy ungrouped shape.
 */
export function parseContainerName(name: string, group?: string): NameIdentity {
  const replicaMatch = /^(.*)-([0-9]+)$/.exec(name);
  const replica = replicaMatch ? Number(replicaMatch[2]) : undefined;
  const rest = replicaMatch ? replicaMatch[1]! : name;
  const parts = rest.split("-");
  const grouped = isGrouped(group);

  if (grouped) {
    if (parts.length < 4) {
      throw new NameParseError(name, "a grouped name needs at least group-service-role-rev");
    }
    if (parts[0] !== group) {
      throw new NameParseError(name, 'group segment "' + parts[0] + '" is not "' + group + '"');
    }
  } else if (parts.length < 3) {
    throw new NameParseError(name, "needs at least service-role-rev");
  }

  const offset = grouped ? 1 : 0;
  const service = parts.slice(offset, -2).join("-");
  const role = parts[parts.length - 2]!;
  const revision = parts[parts.length - 1]!;
  const identity: NameIdentity = { service, role, revision };
  if (grouped) identity.group = group;
  if (replica !== undefined) identity.replica = replica;

  if (!SERVICE_NAME_RE.test(service)) {
    throw new NameParseError(name, 'service "' + service + '" ' + SERVICE_NAME_RULE);
  }
  if (!ROLE_NAME_RE.test(role)) {
    throw new NameParseError(name, 'role "' + role + '" ' + SEGMENT_NAME_RULE);
  }
  if (!REVISION_RE.test(revision)) {
    throw new NameParseError(name, 'revision "' + revision + '" ' + SEGMENT_NAME_RULE);
  }
  return identity;
}

/** True when compose(identity) parses back to the same identity. */
export function roundTrips(identity: NameIdentity): boolean {
  try {
    const parsed = parseContainerName(composeContainerName(identity), identity.group);
    return (
      (parsed.group ?? DEFAULT_GROUP) === (identity.group ?? DEFAULT_GROUP) &&
      parsed.service === identity.service &&
      parsed.role === identity.role &&
      parsed.revision === identity.revision &&
      parsed.replica === identity.replica
    );
  } catch {
    return false;
  }
}
