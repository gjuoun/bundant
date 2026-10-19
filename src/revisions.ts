/**
 * Revision listing and selection.
 *
 * A revision container is named <service>-<role>-<rev>. The listing carries the
 * created timestamp and container state so both `history` (what exists, newest
 * first) and `rollback` (which one to bring back) read the same source.
 */

export interface RevisionEntry {
  /** Full container name, e.g. hello-web-abc1234. */
  name: string;
  /** Short revision id parsed from the name. */
  revision: string;
  /** "2026-10-18 11:20:33 +0000 UTC" as reported by the runtime. */
  createdAt: string;
  /** "Up 2 hours" / "Exited (0) 5 minutes ago". */
  state: string;
}

export interface Selection {
  current: RevisionEntry;
  target: RevisionEntry;
}

export class RevisionNotFoundError extends Error {
  readonly revisions: string[];
  constructor(revision: string, revisions: string[]) {
    super(
      "no revision '" + revision + "' for this service (have: " +
        (revisions.length > 0 ? [...revisions].sort().join(", ") : "none") + ")",
    );
    this.name = "RevisionNotFoundError";
    this.revisions = revisions;
  }
}

/** "name|createdAt|state" per line, sorted newest-first. */
export function parseHistory(stdout: string): RevisionEntry[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name, createdAt = "", state = ""] = line.split("|");
      return { name, revision: revisionOf(name), createdAt: createdAt.trim(), state: state.trim() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Drop a trailing replica suffix (`-<digits>`) from a name or revision. */
export function stripReplicaSuffix(value: string): string {
  const match = /^(.*)-[0-9]+$/.exec(value);
  return match ? match[1]! : value;
}

/**
 * Revision id is the name minus the <service>-<role>- prefix and minus the
 * replica suffix: `api-web-abc1234` and `api-web-abc1234-2` are both abc1234.
 * The prefix is required to tell a numeric revision from a replica index.
 */
export function revisionOf(name: string, service?: string, role?: string): string {
  if (service !== undefined && role !== undefined) {
    const prefix = service + "-" + role + "-";
    if (name.startsWith(prefix)) return stripReplicaSuffix(name.slice(prefix.length));
  }
  const base = stripReplicaSuffix(name);
  const firstDash = base.indexOf("-");
  return firstDash === -1 ? base : base.slice(base.lastIndexOf("-") + 1);
}

/** Replica index from a container name (undefined for the single-replica name). */
export function replicaOf(name: string, service?: string, role?: string): number | undefined {
  let rest = name;
  if (service !== undefined && role !== undefined) {
    const prefix = service + "-" + role + "-";
    if (name.startsWith(prefix)) rest = name.slice(prefix.length);
  }
  const match = /-([0-9]+)$/.exec(rest);
  return match ? Number(match[1]) : undefined;
}

/** The revision currently serving traffic: the first entry whose state says Up. */
export function runningEntry(entries: RevisionEntry[]): RevisionEntry | undefined {
  return entries.find((e) => e.state.startsWith("Up"));
}

/**
 * Current = the running revision (falling back to newest when nothing reports
 * Up); target = the next older revision below it, so repeated rollbacks keep
 * walking back instead of toggling between the two newest entries.
 */
export function selectPrevious(entries: RevisionEntry[]): Selection | null {
  if (entries.length === 0) return null;
  const current = runningEntry(entries) ?? entries[0]!;
  const index = entries.indexOf(current);
  const target = entries[index + 1];
  if (!target) return null;
  return { current, target };
}

/**
 * Target an exact revision id. Any retained revision is addressable, including
 * one newer than the running container (that is a roll-forward).
 */
export function selectByRevision(entries: RevisionEntry[], revision: string): Selection {
  const target = entries.find((e) => e.revision === revision || e.name === revision);
  if (!target) {
    throw new RevisionNotFoundError(revision, entries.map((e) => e.revision));
  }
  const current = runningEntry(entries) ?? entries[0]!;
  return { current, target };
}
