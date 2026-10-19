import { runProcess } from "./exec/process.ts";
import { REVISION_RE } from "./config.ts";

/**
 * Strip anything the revision segment rejects. A revision cannot contain a
 * hyphen: hyphens separate group/service/role/revision, so keeping one here
 * would make the composed name ambiguous.
 */
export function sanitizeRevision(rev: string): string {
  return rev.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

/**
 * Deployment revision: git short sha of the repo containing deploy.yml.
 * Falls back to r<base36 epoch> when HEAD does not exist yet (bundant's own
 * repo starts with zero commits). The fallback is hyphen-free like every new
 * revision; legacy rev-<base36> containers stay selectable by name.
 */
export async function resolveRevision(dir: string, now: number = Date.now()): Promise<string> {
  const r = await runProcess(["git", "-C", dir, "rev-parse", "--short", "HEAD"]);
  if (r.code === 0) {
    const sha = sanitizeRevision(r.stdout.trim());
    if (sha.length >= 7) return sha;
  }
  const fallback = "r" + now.toString(36);
  return REVISION_RE.test(fallback) ? fallback : sanitizeRevision(fallback);
}
