import type { Runtime } from "../runtime.ts";

/**
 * Pure kamal-proxy command builders. The proxy is a container on the same
 * runtime as the app, so every command is emitted through the runtime binary.
 * Flags grounded from basecamp/kamal-proxy README@main and re-verified against
 * the live binary by src/probe/ssh-smoke.ts before the first live deploy.
 */

export const PROXY_CONTAINER = "kamal-proxy";
/** Docker Hub is the only source for this image (no alternate mirror exists). */
export const PROXY_IMAGE = "docker.io/basecamp/kamal-proxy:latest";

/**
 * Idempotent three-branch ensure:
 *   running  -> inspect prints true, the || chain short-circuits (no-op)
 *   stopped  -> inspect fails, start succeeds (no recreation, no traffic loss)
 *   absent   -> inspect and start fail, run creates the container
 * Podman additionally gets the container-level port-floor sysctl so the
 * non-root proxy can bind :80/:443.
 */
export function ensure(rt: Runtime, image: string = PROXY_IMAGE): string {
  const sysctl =
    rt.proxySysctlArgs.length > 0 ? " " + rt.proxySysctlArgs.join(" ") : "";
  return (
    rt.bin + ' inspect -f "{{.State.Running}}" ' + PROXY_CONTAINER + " 2>/dev/null | grep -q true" +
    " || " + rt.bin + " start " + PROXY_CONTAINER + " 2>/dev/null" +
    " || " + rt.bin + " run -d --name " + PROXY_CONTAINER + " --restart unless-stopped" +
    " --network bundant -p 80:80 -p 443:443" + sysctl + " " + image
  );
}

export interface DeployTargetOpts {
  host?: string;
  tls?: boolean;
  healthCheckPath?: string;
  healthCheckPort?: number;
}

/**
 * Register/swap the target set. kamal-proxy health-checks every target before
 * routing and blocks until the old target set has drained, so the caller may
 * stop the old containers as soon as this returns 0. One `--target` per entry;
 * a one-element list is the single-target call path.
 */
export function deploy(
  rt: Runtime,
  svcId: string,
  targets: string[],
  opts: DeployTargetOpts = {},
): string {
  const parts = [rt.bin + " exec", PROXY_CONTAINER, "kamal-proxy deploy", svcId];
  for (const target of targets) parts.push("--target " + target);
  if (opts.host) parts.push("--host " + opts.host);
  if (opts.tls) parts.push("--tls");
  if (opts.healthCheckPath) parts.push("--health-check-path " + opts.healthCheckPath);
  if (opts.healthCheckPort !== undefined) parts.push("--health-check-port " + opts.healthCheckPort);
  return parts.join(" ");
}

export function list(rt: Runtime): string {
  return rt.bin + " exec " + PROXY_CONTAINER + " kamal-proxy list";
}
