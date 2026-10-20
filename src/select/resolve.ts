import type { ContainerSummary } from "../adapters/types.ts";
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
  /** The deploy ran this image under qemu (bundant.emulated label). */
  emulated?: boolean;
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

  if (service !== undefined && kind === "accessory") {
    return { path: group + "." + service, kind, revision: "", replica: 1 };
  }

  try {
    const parsed = v2Grammar.parse(row.name, group);
    const parsedKind = parsed.kind ?? "service";
    return {
      path:
        parsedKind === "accessory"
          ? group + "." + parsed.service
          : group + "." + parsed.service + "." + parsed.role,
      kind: parsedKind,
      revision: labels["bundant.revision"] ?? parsed.revision,
      replica: parsed.replica ?? 1,
    };
  } catch {
    return undefined;
  }
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
      ...(row.labels["bundant.emulated"] === "true" ? { emulated: true } : {}),
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
