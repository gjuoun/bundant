import type { BundantConfig } from "./config.ts";
import { ServiceIdentity } from "./domain/identity.ts";
import type { ResolvedUnit } from "./select/resolve.ts";
import { unitPath } from "./select/selector.ts";

/** One row of `bundant status`, shared by the CLI renderer and the SDK operation. */
export interface StatusRow {
  path: string;
  kind: "service" | "accessory";
  revision: string;
  expected: number;
  live: number;
  containers: string[];
  emulated?: true;
}

/**
 * Resolved units -> status rows.
 *
 * `expected` is the declared replica count only for the unit this config owns;
 * every other unit (other revisions, other members) reports what is actually
 * there, because the config says nothing about them.
 */
export function statusRows(units: ResolvedUnit[], config: BundantConfig): StatusRow[] {
  const identity = ServiceIdentity.from(config);
  const configPath = unitPath({
    group: identity.group,
    service: identity.service,
    role: identity.role,
    kind: identity.kind,
  });
  return units.map((unit) => {
    const live = unit.containers.filter((container) => container.state === "running").length;
    const emulated = unit.containers.some((container) => container.emulated === true);
    const expected = unit.path === configPath ? identity.replicas : unit.containers.length;
    return {
      path: unit.path,
      kind: unit.kind,
      revision: unit.revision,
      expected,
      live,
      containers: unit.containers.map((container) => container.name),
      ...(emulated ? { emulated: true as const } : {}),
    };
  });
}
