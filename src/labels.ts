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
export const LABEL_VOLUMES = "bundant.volumes";
/** Volume ownership: `<group>/<service>`. */
export const LABEL_OWNER = "bundant.owner";
export const LABEL_MANAGED = "bundant.managed";

/** Values for LABEL_KIND. */
export const KIND_SERVICE = "service";
export const KIND_ACCESSORY = "accessory";
