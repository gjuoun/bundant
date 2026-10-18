/** Strip anything docker container names / DNS labels reject. */
export function sanitizeRevision(rev: string): string {
  return rev.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
}

/**
 * Deployment revision: git short sha of the repo containing deploy.yml.
 * Falls back to rev-<base36 epoch> when HEAD does not exist yet
 * (bundant's own repo starts with zero commits).
 */
export async function resolveRevision(dir: string, now: number = Date.now()): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--short", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code === 0) {
    const sha = sanitizeRevision(stdout.trim());
    if (sha.length >= 7) return sha;
  }
  return "rev-" + now.toString(36);
}
