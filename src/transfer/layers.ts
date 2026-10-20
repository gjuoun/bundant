import type { RuntimeAdapter } from "../adapters/types.ts";
import type { Runtime } from "../runtime.ts";
import type { Executor } from "../types.ts";

/**
 * Layer inventory for an incremental image transfer. Everything in this file
 * is either a pure set operation or one bounded read; the deploy path decides
 * what to do with the result.
 */

/** Engine layer ids are "sha256:<hex>"; tolerate a bare hex from older payloads. */
export function normalizeLayerId(id: string): string {
  const text = id.trim();
  if (text === "") return "";
  return text.startsWith("sha256:") ? text : "sha256:" + text;
}

/**
 * RootFS.Layers from an image inspect payload. Docker and podman's compat API
 * both answer { RootFS: { Type: "layers", Layers: [...] } }; an image without
 * one contributes no layers instead of failing the whole inventory.
 */
export function parseRootfsLayers(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const rootfs = (value as { RootFS?: unknown }).RootFS;
  if (typeof rootfs !== "object" || rootfs === null) return [];
  const raw = (rootfs as { Layers?: unknown }).Layers;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const id = normalizeLayerId(entry);
    if (id !== "") out.push(id);
  }
  return out;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The local image's own layer list, in image order. This is the authoritative
 * side of the comparison: the host only tells us what it already has.
 */
export async function localLayers(ref: string, rt: Runtime, exec: Executor): Promise<string[]> {
  const r = await exec.run(
    rt.bin + " image inspect --format '{{json .RootFS.Layers}}' " + shellQuote(ref),
  );
  if (r.code !== 0) {
    throw new Error(
      "cannot read local image layers for " + ref + ": " +
        (r.stderr.trim() !== "" ? r.stderr.trim() : "exit " + r.code),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    throw new Error("local image inspect returned no layer list for " + ref);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("local image inspect returned no layer list for " + ref);
  }
  return parsed.map((entry) => normalizeLayerId(String(entry))).filter((id) => id !== "");
}

/** Fold every layer of every image the host holds into one set. */
export async function loadHostLayers(adapter: RuntimeAdapter): Promise<Set<string>> {
  const ids = await adapter.imageIds();
  const lanes = await Promise.all(ids.map((id) => adapter.imageLayers(id)));
  const set = new Set<string>();
  for (const lane of lanes) {
    for (const id of lane) {
      const normalized = normalizeLayerId(id);
      if (normalized !== "") set.add(normalized);
    }
  }
  return set;
}

/**
 * One host's layer inventory for the life of a deploy session. A deploy sends
 * at most one image per host, so the cache is refreshed explicitly (once after
 * a load) rather than expiring on a timer.
 */
export class HostLayerCache {
  private readonly adapter: RuntimeAdapter;
  private cached: Promise<Set<string>> | null = null;

  constructor(adapter: RuntimeAdapter) {
    this.adapter = adapter;
  }

  get(refresh = false): Promise<Set<string>> {
    if (refresh || this.cached === null) this.cached = loadHostLayers(this.adapter);
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export interface LayerDelta {
  /** Missing layer ids in the image's own order, deduplicated. */
  missing: string[];
  /** Layers the host already has (of the local image's layers). */
  reused: number;
  /** Local image layer count (deduplicated). */
  total: number;
}

/**
 * Pure set maths: which of the local image's layers the host lacks. Input
 * order never matters for the host side; the result always follows the image.
 */
export function missingLayers(
  local: readonly string[],
  host: ReadonlySet<string> | readonly string[],
): LayerDelta {
  const have: ReadonlySet<string> = host instanceof Set
    ? (host as ReadonlySet<string>)
    : new Set((host as readonly string[]).map(normalizeLayerId));
  const missing: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of local) {
    const id = normalizeLayerId(raw);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    total += 1;
    if (!have.has(id)) missing.push(id);
  }
  return { missing, reused: total - missing.length, total };
}
