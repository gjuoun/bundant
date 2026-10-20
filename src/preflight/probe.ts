import { runtimeFor, type Runtime } from "../runtime.ts";
import { parsePlatform, type Platform } from "../platform.ts";
import { localImagePlatform } from "../transfer/layers.ts";
import type { Executor } from "../types.ts";
import { LocalExecutor } from "../exec/local.ts";
import { binfmtPath, checkArch, type ArchVerdict } from "./arch.ts";

/**
 * The I/O half of the arch preflight. It uses exactly two cheap reads: the
 * local image inspect and `uname` over the existing ssh session. No engine
 * socket and no deploy lock are touched before the verdict.
 */

export interface ArchPreflightContext {
  image: string;
  /** --local-image: the local engine already holds the bytes. */
  isLocal: boolean;
  allowEmulation: boolean;
  /** The primary ssh executor (the host is already reachable). */
  exec: Executor;
  rt: Runtime;
  /** Test seam: local image inspection. */
  local?: Executor;
}

export interface ArchPreflightResult {
  emulated: boolean;
  /** The target's platform, reused for the post-transfer registry check. */
  hostPlatform?: Platform;
  verdict?: ArchVerdict;
}

export type ArchPreflight = (
  ctx: ArchPreflightContext,
) => Promise<ArchPreflightResult | undefined>;

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** `uname -s -m` is the one host fact that needs no engine. */
export async function probeHostPlatform(exec: Executor): Promise<Platform | undefined> {
  const r = await exec.run("uname -s -m");
  if (r.code !== 0) return undefined;
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  return parsePlatform(parts[0], parts[1]);
}

export async function probeBinfmtPresent(exec: Executor, arch: string): Promise<boolean> {
  const path = binfmtPath(arch);
  const r = await exec.run("test -e " + shellQuote(path) + " && echo yes || echo no");
  return r.code === 0 && r.stdout.trim() === "yes";
}

/** The production probe: local image platform + uname + binfmt, all read-only. */
export const defaultArchPreflight: ArchPreflight = async (ctx) => {
  const host = await probeHostPlatform(ctx.exec);
  if (host === undefined) return undefined;

  // A registry ref is not inspectable before the pull; the deploy path repeats
  // the comparison on the image the host actually received.
  if (!ctx.isLocal) return { emulated: false, hostPlatform: host };

  // The local image may live in the other engine than the host runs (a docker
  // build pushed to a podman host is normal), so probe both, exactly like the
  // transfer path does.
  const local = ctx.local ?? new LocalExecutor();
  const other = runtimeFor(ctx.rt.kind === "docker" ? "podman" : "docker");
  let image = await localImagePlatform(ctx.image, ctx.rt, local);
  if (image === undefined) image = await localImagePlatform(ctx.image, other, local);
  if (image === undefined) return { emulated: false, hostPlatform: host };

  const needsEmulation = image.os !== host.os || image.arch !== host.arch;
  const binfmtPresent = needsEmulation && ctx.allowEmulation
    ? await probeBinfmtPresent(ctx.exec, image.arch)
    : false;

  const verdict = checkArch({
    image: ctx.image,
    imagePlatform: image,
    hostPlatform: host,
    allowEmulation: ctx.allowEmulation,
    binfmtPresent,
  });
  return { emulated: verdict.emulated, hostPlatform: host, verdict };
};
