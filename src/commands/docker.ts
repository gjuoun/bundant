import type { Runtime } from "../runtime.ts";

/** Pure container-runtime command builders — every string runs verbatim on the target host. */

export const NETWORK = "bundant";
export const CURL_IMAGE = "curlimages/curl:8.11.1";

export function pull(rt: Runtime, image: string): string {
  return rt.bin + " pull " + image;
}

export function ensureNetwork(rt: Runtime): string {
  return rt.bin + " network create " + NETWORK + " 2>/dev/null || true";
}

export function removeForce(rt: Runtime, container: string): string {
  return rt.bin + " rm -f " + container + " 2>/dev/null || true";
}

export function run(
  rt: Runtime,
  opts: { container: string; image: string; envFile?: string },
): string {
  const parts = [
    rt.bin + " run -d",
    "--name " + opts.container,
    "--network " + NETWORK,
    "--restart unless-stopped",
  ];
  if (opts.envFile) parts.push("--env-file " + opts.envFile);
  parts.push(opts.image);
  return parts.join(" ");
}

/** Throwaway curl sidecar on the bundant network probes the container by name. */
export function probe(
  rt: Runtime,
  container: string,
  port: number,
  path: string,
  maxTime = 3,
): string {
  return (
    rt.bin + " run --rm --network " + NETWORK + " " + CURL_IMAGE +
    " -sS -o /dev/null -w '%{http_code}' --max-time " + maxTime +
    " http://" + container + ":" + port + path
  );
}

export function stop(rt: Runtime, container: string, timeout = 10): string {
  return rt.bin + " stop -t " + timeout + " " + container;
}

/** Stop every container of this service-role except the freshly deployed one. */
export function stopOld(
  rt: Runtime,
  service: string,
  role: string,
  keep: string,
  timeout = 10,
): string {
  const prefix = service + "-" + role + "-";
  return (
    'for c in $(' + rt.bin + ' ps -a --filter "name=' + prefix + '" --format "{{.Names}}"' +
    ' | grep "^' + prefix + '" | grep -v "^' + keep + '$"); do ' +
    rt.bin + " stop -t " + timeout + ' "$c"; done'
  );
}

/** Listing used by rollback selection: "<name> <createdAt>" per line. */
export function listForSelection(rt: Runtime, service: string, role: string): string {
  return (
    rt.bin + ' ps -a --filter "name=' + service + "-" + role +
    '-" --format "{{.Names}} {{.CreatedAt}}"'
  );
}

export function listForStatus(rt: Runtime, service: string, role: string): string {
  return (
    rt.bin + ' ps -a --filter "name=' + service + "-" + role +
    '-" --format "{{.Names}} {{.Status}}"'
  );
}

/** Currently RUNNING containers of this service-role (names only). */
export function listRunning(rt: Runtime, service: string, role: string): string {
  return rt.bin + ' ps --filter "name=' + service + "-" + role + '-" --format "{{.Names}}"';
}

export function inspectRunning(rt: Runtime, container: string): string {
  return rt.bin + ' inspect -f "{{.State.Running}}" ' + container;
}

export function imageExists(rt: Runtime, image: string): string {
  return rt.bin + " image inspect " + image + " >/dev/null 2>&1";
}

export function imagePrune(rt: Runtime): string {
  return rt.bin + " image prune -f";
}

export function start(rt: Runtime, container: string): string {
  return rt.bin + " start " + container;
}
