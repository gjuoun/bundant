import type { BundantConfig } from "./config.ts";
import { ServiceIdentity } from "./domain/identity.ts";

/**
 * Container naming for replicas. The rules live in ServiceIdentity; these
 * wrappers keep the historical call shape (and the replicas: 1 migration
 * boundary: one replica keeps the unsuffixed name).
 */

/** Container name for one replica. replicas: 1 keeps <prefix><rev>. */
export function containerName(
  config: BundantConfig,
  revision: string,
  replica = 1,
): string {
  const identity = ServiceIdentity.from(config, undefined, revision);
  return identity.containerName((config.replicas ?? 1) > 1 ? replica : undefined);
}

/** The indexed name, unconditionally: <prefix><rev>-<i>. */
export function indexedContainerName(
  config: BundantConfig,
  revision: string,
  index: number,
): string {
  const identity = ServiceIdentity.from(config, undefined, revision);
  return identity.containerName(index);
}

/** Every container name this deploy runs on one host, in replica order. */
export function containerNames(config: BundantConfig, revision: string): string[] {
  const count = config.kind === "accessory" ? 1 : Math.max(1, config.replicas ?? 1);
  const names: string[] = [];
  for (let i = 1; i <= count; i++) names.push(containerName(config, revision, i));
  return names;
}
