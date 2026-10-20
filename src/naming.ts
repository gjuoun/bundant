import { DEFAULT_GROUP, type BundantConfig } from "./config.ts";
import { ServiceIdentity } from "./domain/identity.ts";

/**
 * Group-scoped name helpers. The derivation itself lives in ServiceIdentity;
 * these functions keep the historical call shape for matching/sweeping code.
 */

export function isGrouped(config: Pick<BundantConfig, "group">): boolean {
  const group = config.group;
  return group !== undefined && group !== "" && group !== DEFAULT_GROUP;
}

/** Container/proxy-id prefix including the trailing dash. */
export function containerPrefix(
  config: Pick<BundantConfig, "group" | "service" | "role"> & { version?: number },
): string {
  const identity = ServiceIdentity.from({
    group: config.group,
    service: config.service,
    role: config.role,
    version: config.version,
  } as BundantConfig);
  // containerName() ends in the sentinel revision "r0"; keep the separator.
  return identity.containerName().slice(0, -2);
}

/** Pre-grouping name prefix, still found on hosts upgraded in place. */
export function legacyPrefix(config: Pick<BundantConfig, "service" | "role">): string {
  return config.service + "-" + config.role + "-";
}

/** True when the name is this service-role in either the new or legacy shape. */
export function belongsToService(
  name: string,
  config: Pick<BundantConfig, "group" | "service" | "role"> & { version?: number },
): boolean {
  // Labels already scope the group; the legacy hyphen prefix is always safe to
  // recognise as well (v1 names survive a v1 -> v2 migration).
  if (name.startsWith(containerPrefix(config))) return true;
  return name.startsWith(legacyPrefix(config));
}

/** Stable accessory container name: grouped accessories carry the group prefix. */
export function accessoryContainerName(
  config: Pick<BundantConfig, "group" | "service"> & { version?: number },
): string {
  const identity = ServiceIdentity.from({
    group: config.group,
    service: config.service,
    role: "web",
    kind: "accessory",
    version: config.version,
  } as BundantConfig);
  return identity.containerName();
}

/** Labels that identify one service-role set (role is not a label). */
export function serviceLabels(
  config: Pick<BundantConfig, "group" | "service" | "kind">,
): Record<string, string> {
  return {
    "bundant.service": config.service,
    "bundant.group": config.group ?? DEFAULT_GROUP,
    "bundant.kind": config.kind ?? "service",
  };
}
