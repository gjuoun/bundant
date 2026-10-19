import type { Executor } from "./types.ts";

/**
 * Deploy lock: atomic mkdir on the first host. Concurrent deploys of the same
 * service are rejected with owner info; locks older than the TTL are reclaimed
 * (a crashed deploy cannot block forever). BUNDANT_LOCK_BASE overrides the
 * directory (used by tests).
 */

export const DEFAULT_LOCK_BASE = "~/.bundant/locks";

export function lockBase(): string {
  return process.env.BUNDANT_LOCK_BASE ?? DEFAULT_LOCK_BASE;
}

/**
 * Service-level lock key, namespaced by the group when one is in play:
 * `<group>/<service>` or just `<service>` for an ungrouped deploy.
 */
export function lockKey(group: string | undefined, service: string): string {
  return group !== undefined && group !== "" ? group + "/" + service : service;
}

export function lockDir(key: string): string {
  return lockBase() + "/" + key + ".lock";
}

/** Atomic acquire: mkdir succeeds for exactly one concurrent deploy. */
export function acquireCmd(key: string): string {
  const dir = lockDir(key);
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  return (
    "mkdir -p " + parent + " && mkdir " + dir +
    ' && echo "$(id -un) $(date +%s)" > ' + dir + "/owner"
  );
}

export function readOwnerCmd(key: string): string {
  return "cat " + lockDir(key) + "/owner 2>/dev/null || true";
}

export function forceReleaseCmd(key: string): string {
  return "rm -rf " + lockDir(key);
}

export function releaseCmd(key: string): string {
  return "rm -rf " + lockDir(key);
}

// Plain field assignments (see health.ts): parameter properties are not
// supported by node's strip-only type stripping.
export class LockHeldError extends Error {
  readonly service: string;
  readonly owner: string;
  readonly ageSeconds: number;

  constructor(service: string, owner: string, ageSeconds: number) {
    super(
      "deploy lock for " + service + " is held by " + owner +
      " (age " + ageSeconds + "s; BUNDANT_LOCK_TTL_S reclaims stale locks)",
    );
    this.name = "LockHeldError";
    this.service = service;
    this.owner = owner;
    this.ageSeconds = ageSeconds;
  }
}

export interface LockOptions {
  ttlSeconds?: number;
  now?: () => number;
}

export function lockTtlSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BUNDANT_LOCK_TTL_S;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 900;
}

/** Acquire or fail with LockHeldError; stale locks (age >= TTL) are reclaimed. */
export async function acquireLock(
  exec: Executor,
  service: string,
  opts: LockOptions = {},
): Promise<void> {
  const ttl = opts.ttlSeconds ?? lockTtlSeconds();
  const now = opts.now ?? Date.now;

  const first = await exec.run(acquireCmd(service));
  if (first.code === 0) return;

  const ownerLine = (await exec.run(readOwnerCmd(service))).stdout.trim();
  const [user, tsRaw] = ownerLine.split(/\s+/);
  const ts = Number(tsRaw);
  const age = Number.isFinite(ts) && ts > 0 ? Math.floor(now() / 1000 - ts) : Number.POSITIVE_INFINITY;

  if (age < ttl) {
    throw new LockHeldError(service, user ?? "unknown", age);
  }

  await exec.run(forceReleaseCmd(service));
  const retry = await exec.run(acquireCmd(service));
  if (retry.code !== 0) {
    throw new LockHeldError(service, user ?? "unknown", age);
  }
}

export async function releaseLock(exec: Executor, service: string): Promise<void> {
  await exec.run(releaseCmd(service));
}
