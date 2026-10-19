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
  config: Pick<BundantConfig, "group" | "service" | "role">,
): string {
  const identity = ServiceIdentity.from({
    group: config.group,
    service: config.service,
    role: config.role,
  } as BundantConfig);
  return identity.servicePrefix() + "-";
}

/** Pre-grouping name prefix, still found on hosts upgraded in place. */
export function legacyPrefix(config: Pick<BundantConfig, "service" | "role">): string {
  return config.service + "-" + config.role + "-";
}

/** True when the name is this service-role in either the new or legacy shape. */
export function belongsToService(
  name: string,
  config: Pick<BundantConfig, "group" | "service" | "role">,
): boolean {
  if (name.startsWith(containerPrefix(config))) return true;
  return isGrouped(config) && name.startsWith(legacyPrefix(config));
}

/** Stable accessory container name: grouped accessories carry the group prefix. */
export function accessoryContainerName(config: Pick<BundantConfig, "group" | "service">): string {
  const identity = ServiceIdentity.from({
    group: config.group,
    service: config.service,
    role: "web",
    kind: "accessory",
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
