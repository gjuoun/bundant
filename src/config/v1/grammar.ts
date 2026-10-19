/**
 * v1 naming grammar. It lives WITH the version: a future v2 supplies its own
 * grammar through the registry, and composition/parsing takes it as a value.
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

export interface NameGrammar {
  service: RegExp;
  group: RegExp;
  role: RegExp;
  revision: RegExp;
  serviceRule: string;
  segmentRule: string;
  defaultGroup: string;
  compose(identity: NameIdentity): string;
  parse(name: string, group?: string): NameIdentity;
  roundTrips(identity: NameIdentity): boolean;
}

function isGrouped(group: string | undefined, defaultGroup: string): boolean {
  return group !== undefined && group !== "" && group !== defaultGroup;
}

export function composeContainerName(identity: NameIdentity): string {
  const prefix = isGrouped(identity.group, DEFAULT_GROUP) ? identity.group + "-" : "";
  const base = prefix + identity.service + "-" + identity.role + "-" + identity.revision;
  return identity.replica === undefined ? base : base + "-" + identity.replica;
}

export function parseContainerName(name: string, group?: string): NameIdentity {
  const replicaMatch = /^(.*)-([0-9]+)$/.exec(name);
  const replica = replicaMatch ? Number(replicaMatch[2]) : undefined;
  const rest = replicaMatch ? replicaMatch[1]! : name;
  const parts = rest.split("-");
  const grouped = isGrouped(group, DEFAULT_GROUP);

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

export const v1Grammar: NameGrammar = {
  service: SERVICE_NAME_RE,
  group: GROUP_NAME_RE,
  role: ROLE_NAME_RE,
  revision: REVISION_RE,
  serviceRule: SERVICE_NAME_RULE,
  segmentRule: SEGMENT_NAME_RULE,
  defaultGroup: DEFAULT_GROUP,
  compose: composeContainerName,
  parse: parseContainerName,
  roundTrips,
};
