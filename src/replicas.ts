import type { BundantConfig } from "./config.ts";

/**
 * Container naming for replicas. This is the migration boundary: a deployment
 * with replicas: 1 keeps the historical name, so nothing has to move.
 */

/**
 * Container name for one replica. replicas: 1 keeps the historical
 * `<service>-<role>-<rev>`; N > 1 appends `-<i>` for i = 1..N.
 * Accessories carry no revision and no replicas: one stable name forever.
 */
export function containerName(
  config: BundantConfig,
  revision: string,
  replica = 1,
): string {
  if (config.kind === "accessory") return config.service;
  const base = config.service + "-" + config.role + "-" + revision;
  return (config.replicas ?? 1) > 1 ? base + "-" + replica : base;
}

/** The indexed name, unconditionally: `<service>-<role>-<rev>-<i>`. */
export function indexedContainerName(
  config: BundantConfig,
  revision: string,
  index: number,
): string {
  if (config.kind === "accessory") return config.service;
  return config.service + "-" + config.role + "-" + revision + "-" + index;
}

/** Every container name this deploy runs on one host, in replica order. */
export function containerNames(config: BundantConfig, revision: string): string[] {
  const count = config.kind === "accessory" ? 1 : Math.max(1, config.replicas ?? 1);
  const names: string[] = [];
  for (let i = 1; i <= count; i++) names.push(containerName(config, revision, i));
  return names;
}
