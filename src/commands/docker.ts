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

/** name|createdAt|state — the full picture `history` and `rollback` need. */
export function listHistory(rt: Runtime, service: string, role: string): string {
  return (
    rt.bin + ' ps -a --filter "name=' + service + "-" + role +
    '-" --format "{{.Names}}|{{.CreatedAt}}|{{.Status}}"'
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

/**
 * Monitoring surface — read-only queries, all pull-based over the same ssh
 * connection. Field sets were verified live on podman 5.7 and docker 29.
 */

/** Every container on the host: name|image|status|ports|createdAt. */
export function listAll(rt: Runtime): string {
  return rt.bin + ' ps -a --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}"';
}

/** One-shot resource snapshot: name|cpu%|mem used/limit|mem%|pids. */
export function statsSnapshot(rt: Runtime): string {
  return rt.bin + ' stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}"';
}

export function logsTail(rt: Runtime, container: string, tail: number, follow = false): string {
  return rt.bin + " logs" + (follow ? " -f" : "") + " --tail " + tail + " " + container;
}

export function containerNames(rt: Runtime): string {
  return rt.bin + ' ps --format "{{.Names}}"';
}

/** Every container name, running or not — the fallback for selectors. */
export function allContainerNames(rt: Runtime): string {
  return rt.bin + ' ps -a --format "{{.Names}}"';
}

/** State line for one container: see parseInspect for the field order. */
export function inspectLine(rt: Runtime, container: string): string {
  return (
    rt.bin + " inspect " + container + ' --format "' +
    "{{.Name}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|" +
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.Config.Image}}|" +
    '{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.LogConfig.Type}}|{{.State.ExitCode}}"'
  );
}

/**
 * Events since an RFC3339 timestamp or a duration (journald/json-file backend).
 * `events` streams forever by default, so it is bounded by `timeout` and the
 * exit code is neutralised: the caller wants the window, not a follow stream.
 */
export function eventsSince(rt: Runtime, since: string): string {
  return (
    "timeout 3 " + rt.bin + ' events --since ' + since +
    ' --format "{{.Time}}|{{.Type}}|{{.Status}}|{{.Name}}" 2>/dev/null || true'
  );
}
