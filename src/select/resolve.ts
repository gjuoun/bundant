import type { ContainerSummary } from "../adapters/types.ts";
import { v1Grammar } from "../config/v1/grammar.ts";
import { v2Grammar } from "../config/v2/grammar.ts";
import type { RuntimeOps } from "../ops/types.ts";
import { NoMatchError, parseSelector, type ParsedSelector } from "./selector.ts";

export interface UnitContainer {
  host: string;
  name: string;
  image: string;
  state: string;
  revision: string;
  replica: number;
}

export interface Unit {
  path: string;
  kind: "service" | "accessory";
  revision: string;
  replicas: number[];
  containers: UnitContainer[];
  created: number;
}

export interface UnitSource {
  host: string;
  ops: Pick<RuntimeOps, "listContainers">;
}

export interface ResolveOptions {
  sources: UnitSource[];
  replica?: number;
  revision?: string;
  allRevisions?: boolean;
}

export interface ResolvedUnit {
  path: string;
  kind: "service" | "accessory";
  revision: string;
  containers: UnitContainer[];
}

function identityOf(row: ContainerSummary): {
  path: string;
  kind: "service" | "accessory";
  revision: string;
  replica: number;
} | undefined {
  const labels = row.labels;
  const group = labels["bundant.group"] ?? "default";
  const service = labels["bundant.service"];
  const kind = labels["bundant.kind"] === "accessory" ? "accessory" : "service";
  const replica = Number(labels["bundant.replica"] ?? "1");

  if (service === undefined) {
    // No labels at all: recover the path from the name grammar. The legacy
    // fallback revision is "rev-<base36>", so its second-to-last segment is
    // "rev" and the role is the segment before it.
    if (!row.name.includes(".")) {
      const parts = row.name.split("-");
      if (parts.length >= 4 && parts[parts.length - 2] === "rev") {
        const revision = "rev-" + parts[parts.length - 1]!;
        const role = parts[parts.length - 3]!;
        const serviceName = parts.slice(0, -3).join("-");
        return {
          path: "default." + serviceName + "." + role,
          kind: "service",
          revision,
          replica: 1,
        };
      }
    }
    const grammar = row.name.includes(".") ? v2Grammar : v1Grammar;
    try {
      const parsed = grammar.parse(row.name, row.name.includes(".") ? undefined : group);
      return {
        path:
          parsed.role === ""
            ? group + "." + parsed.service
            : group + "." + parsed.service + "." + parsed.role,
        kind: parsed.role === "" ? "accessory" : "service",
        revision: parsed.revision,
        replica: parsed.replica ?? 1,
      };
    } catch {
      return undefined;
    }
  }

  if (kind === "accessory") {
    return { path: group + "." + service, kind, revision: "", replica: 1 };
  }

  // Labelled v2 service name: the dotted grammar has the role.
  if (row.name.includes(".")) {
    try {
      const parsed = v2Grammar.parse(row.name, group);
      return {
        path: group + "." + service + "." + parsed.role,
        kind,
        revision: labels["bundant.revision"] ?? parsed.revision,
        replica,
      };
    } catch {
      // fall through to the legacy name derivation
    }
  }

  // Pre-label / legacy v1 name: strip <group>-<service>- or <service>-, the
  // first remaining segment is the role (roles never contain '-') and the rest
  // is the revision, including the old rev-<base36> form.
  const groupPrefix = group + "-" + service + "-";
  const servicePrefix = service + "-";
  const rest = row.name.startsWith(groupPrefix)
    ? row.name.slice(groupPrefix.length)
    : row.name.startsWith(servicePrefix)
      ? row.name.slice(servicePrefix.length)
      : "";
  if (rest === "") return { path: group + "." + service, kind: "accessory", revision: "", replica: 1 };
  const dash = rest.indexOf("-");
  if (dash <= 0) return undefined;
  const role = rest.slice(0, dash);
  const revision = labels["bundant.revision"] ?? rest.slice(dash + 1);
  return { path: group + "." + service + "." + role, kind, revision, replica };
}

/** Fold container rows into units, one per (path, revision). */
export function foldUnits(rows: Array<{ host: string; row: ContainerSummary }>): Unit[] {
  const units = new Map<string, Unit>();
  for (const { host, row } of rows) {
    const identity = identityOf(row);
    if (identity === undefined) continue;
    const key = identity.path + "|" + identity.revision;
    const unit = units.get(key) ?? {
      path: identity.path,
      kind: identity.kind,
      revision: identity.revision,
      replicas: [],
      containers: [],
      created: 0,
    };
    if (!unit.replicas.includes(identity.replica)) unit.replicas.push(identity.replica);
    unit.replicas.sort((a, b) => a - b);
    unit.containers.push({
      host,
      name: row.name,
      image: row.image,
      state: row.state,
      revision: identity.revision,
      replica: identity.replica,
    });
    unit.created = Math.max(unit.created, row.created);
    units.set(key, unit);
  }
  return [...units.values()];
}

export async function listUnits(sources: UnitSource[]): Promise<Unit[]> {
  const rows: Array<{ host: string; row: ContainerSummary }> = [];
  for (const source of sources) {
    for (const row of await source.ops.listContainers({ all: true })) {
      rows.push({ host: source.host, row });
    }
  }
  return foldUnits(rows);
}

function failed(pattern: string, sources: UnitSource[]): NoMatchError {
  const hosts = sources.map((source) => source.host).join(", ");
  return new NoMatchError(
    pattern,
    "searched labels bundant.group/bundant.service" + (hosts !== "" ? " on " + hosts : ""),
  );
}

/** Resolve a pattern to the containers the flat verbs should act on. */
export async function resolve(
  pattern: string,
  opts: ResolveOptions,
): Promise<ResolvedUnit[]> {
  const parsed: ParsedSelector = parseSelector(pattern);
  const units = await listUnits(opts.sources);
  const paths = [...new Set(units.map((unit) => unit.path))];
  const matchedPaths = paths.filter((path) => parsed.match(path));
  if (matchedPaths.length === 0) throw failed(pattern, opts.sources);

  const out: ResolvedUnit[] = [];
  for (const path of matchedPaths) {
    let candidates = units.filter((unit) => unit.path === path);
    if (opts.revision !== undefined) {
      candidates = candidates.filter((unit) => unit.revision === opts.revision);
    } else if (opts.allRevisions !== true) {
      const running = candidates.filter((unit) =>
        unit.containers.some((container) => container.state === "running"),
      );
      const pool = running.length > 0 ? running : candidates;
      const newest = pool.reduce((a, b) => (b.created > a.created ? b : a));
      candidates = [newest];
    }
    for (const unit of candidates) {
      let containers = unit.containers;
      if (opts.replica !== undefined) {
        containers = containers.filter((container) => container.replica === opts.replica);
      }
      if (containers.length === 0) continue;
      out.push({
        path: unit.path,
        kind: unit.kind,
        revision: unit.revision,
        containers,
      });
    }
  }
  if (out.length === 0) throw failed(pattern, opts.sources);
  return out;
}
