/**
 * Label keys that make a bundant object describe itself on the host.
 *
 * These are the contract between the writer (run/volume create) and every reader
 * (sweeps, delete, prune, a human with `docker ps --filter`). Nothing here may be
 * renamed without a migration: they live on the hosts.
 */
export const LABEL_SERVICE = "bundant.service";
export const LABEL_GROUP = "bundant.group";
export const LABEL_KIND = "bundant.kind";
/** Deployment revision the container belongs to (services only). */
export const LABEL_REVISION = "bundant.revision";
/** Replica index within the revision, 1-based (services only; 1 for a single). */
export const LABEL_REPLICA = "bundant.replica";
export const LABEL_VOLUMES = "bundant.volumes";
/** Volume ownership: `<group>/<service>`. */
export const LABEL_OWNER = "bundant.owner";
export const LABEL_MANAGED = "bundant.managed";
/** The deploy ran a foreign-arch image under qemu (set only when true). */
export const LABEL_EMULATED = "bundant.emulated";

/** Values for LABEL_KIND. */
export const KIND_SERVICE = "service";
export const KIND_ACCESSORY = "accessory";
