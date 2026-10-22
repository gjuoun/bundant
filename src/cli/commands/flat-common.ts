import { loadConfig, type LoadedConfig } from "../../config.ts";
import { readConfig } from "../../select/read-config.ts";
import { withFlatUnits, type FlatUnits } from "../../select/with-units.ts";
import { unitPath } from "../../select/selector.ts";
import { ServiceIdentity } from "../../domain/identity.ts";
import { UsageError } from "../../agent/errors.ts";
import type { RuntimeOps } from "../../ops/index.ts";
import { value, type GlobalConfig } from "./common.ts";

export { withFlatUnits, type FlatUnits };


/** Flat verbs: -f wins; otherwise --hosts or BUNDANT_HOSTS; no silent deploy.yml. */
export function flatLoadedFor(g: Pick<GlobalConfig, "file" | "hosts">): LoadedConfig {
  const file = value(g.file);
  if (file !== undefined) return loadConfig(file);
  const hosts = (value(g.hosts) ?? process.env.BUNDANT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
  if (hosts.length === 0) {
    throw new UsageError({ message: "no hosts: pass -f <config>, --hosts <a,b> or set BUNDANT_HOSTS" });
  }
  return readConfig(hosts);
}

/** One option mapping shared by every flat verb. */
export function resolutionOptions(
  g: Pick<GlobalConfig, "replica" | "revision" | "all-revisions">,
): { replica?: number; revision?: string; allRevisions?: boolean } {
  const replica = value(g.replica);
  const revision = value(g.revision);
  return {
    replica: replica === undefined ? undefined : Number(replica),
    revision,
    allRevisions: g["all-revisions"],
  };
}

/** Path argument, else the -f unit as a filter, else everything. */
export function selectorFor(
  g: Pick<GlobalConfig, "file">,
  loaded: LoadedConfig,
  path: string | undefined,
): string {
  if (path !== undefined) return path;
  if (g.file._tag === "Some") {
    const identity = ServiceIdentity.from(loaded.config);
    return unitPath({
      group: identity.group,
      service: identity.service,
      role: identity.role,
      kind: identity.kind,
    });
  }
  return "*";
}

export function opsFor(ctx: FlatUnits, host: string): RuntimeOps {
  const found = ctx.ops.get(host);
  if (found === undefined) throw new Error("no runtime session for host " + host);
  return found;
}
