import { DEFAULT_GROUP, type BundantConfig } from "./config.ts";

/**
 * Group-scoped names. The rule is one line: the default group never prefixes.
 *
 *   ungrouped service   <service>-<role>-<rev>     proxy <service>-<role>
 *   grouped service     <group>-<service>-<role>-<rev>   proxy <group>-<service>-<role>
 *   grouped accessory   <group>-<service>
 *
 * Replica suffixes, labels, env paths and lock keys are unchanged.
 */

export function isGrouped(config: Pick<BundantConfig, "group">): boolean {
  const group = config.group;
  return group !== undefined && group !== "" && group !== DEFAULT_GROUP;
}

/** "" for the default group, "<group>-" for a real one. */
export function groupPrefix(config: Pick<BundantConfig, "group">): string {
  return isGrouped(config) ? config.group + "-" : "";
}

/** The container/proxy-id prefix: <group>-<service>-<role> (or legacy shape). */
export function servicePrefix(config: Pick<BundantConfig, "group" | "service" | "role">): string {
  return groupPrefix(config) + config.service + "-" + config.role;
}

/** Container prefix including the trailing dash: <prefix>-<rev>. */
export function containerPrefix(config: Pick<BundantConfig, "group" | "service" | "role">): string {
  return servicePrefix(config) + "-";
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
  return isGrouped(config) ? config.group + "-" + config.service : config.service;
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
