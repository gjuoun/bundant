import type { Runtime } from "../runtime.ts";
import { KIND_ACCESSORY, LABEL_KIND } from "../labels.ts";

/** Pure container-runtime command builders — every string runs verbatim on the target host. */

export const NETWORK = "bundant";
export const CURL_IMAGE = "curlimages/curl:8.11.1";
/** Tiny image whose busybox `nc` does the TCP readiness probe for accessories. */
export const TCP_IMAGE = "docker.io/library/busybox:1.37";

export function pull(rt: Runtime, image: string): string {
  return rt.bin + " pull " + image;
}

export function ensureNetwork(rt: Runtime): string {
  return rt.bin + " network create " + NETWORK + " 2>/dev/null || true";
}

export function removeForce(rt: Runtime, container: string): string {
  return rt.bin + " rm -f " + container + " 2>/dev/null || true";
}

/** `--label k=v` per entry, in insertion order (exact-match filters rely on these). */
export function labelArgs(labels?: Record<string, string>): string[] {
  if (!labels) return [];
  return Object.entries(labels).map(([k, v]) => "--label " + k + "=" + v);
}

/** `--filter label=k=v` per entry; multiple filters AND together. */
export function labelFilters(labels?: Record<string, string>): string {
  if (!labels) return "";
  return Object.entries(labels)
    .map(([k, v]) => ' --filter "label=' + k + "=" + v + '"')
    .join("");
}

export function run(
  rt: Runtime,
  opts: {
    container: string;
    image: string;
    envFile?: string;
    labels?: Record<string, string>;
    volumes?: string[];
    restart?: boolean;
  },
): string {
  const parts = [
    rt.bin + " run -d",
    "--name " + opts.container,
    "--network " + NETWORK,
  ];
  if (opts.restart !== false) parts.push("--restart unless-stopped");
  if (opts.envFile) parts.push("--env-file " + opts.envFile);
  parts.push(...labelArgs(opts.labels));
  for (const v of opts.volumes ?? []) parts.push("--volume " + v);
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

/**
 * Throwaway busybox `nc` sidecar on the bundant network: a bare TCP connect is
 * the accessory readiness probe (postgres `pg_isready`-style, image-agnostic).
 */
export function tcpProbe(rt: Runtime, container: string, port: number, maxTime = 3): string {
  return (
    rt.bin + " run --rm --network " + NETWORK + " " + TCP_IMAGE +
    " sh -c 'nc -z -w " + maxTime + " " + container + " " + port + "'"
  );
}

/** Exactly one container by name, running or stopped (empty output when absent). */
export function findByName(rt: Runtime, container: string): string {
  return rt.bin + ' ps -a --filter "name=^' + container + '$" --format "{{.Names}}"';
}

export function volumeRemove(rt: Runtime, volume: string): string {
  return rt.bin + " volume rm " + volume;
}

/**
 * Create a named volume with its ownership labels. Idempotent on both runtimes:
 * podman fails with 125 when the volume already exists, docker returns 0.
 */
export function volumeCreate(
  rt: Runtime,
  volume: string,
  labels?: Record<string, string>,
): string {
  const labelArgsText = labelArgs(labels).map((a) => " " + a).join("");
  return rt.bin + " volume create" + labelArgsText + " " + volume + " 2>/dev/null || true";
}

/**
 * Shell guard: print the value of one label on a container, empty when absent.
 * Used to skip accessories during a sweep instead of guessing from the name.
 */
export function inspectLabel(rt: Runtime, container: string, key: string): string {
  return (
    rt.bin + ' inspect -f \'{{index .Config.Labels "' + key + '"}}\' ' + container + " 2>/dev/null || true"
  );
}

/** Shell guard: print the value of one label on a volume (empty when absent). */
export function volumeLabel(rt: Runtime, volume: string, key: string): string {
  return (
    rt.bin + " volume inspect -f '{{index .Labels \"" + key + "\"}}' " + volume + " 2>/dev/null || true"
  );
}

/** Stop every container of this service-role except the freshly deployed set. */
export function stopOld(
  rt: Runtime,
  service: string,
  role: string,
  keep: string | string[],
  timeout = 10,
): string {
  const prefix = service + "-" + role + "-";
  const keepSet = new Set(typeof keep === "string" ? [keep] : keep);
  const keepFilter =
    keepSet.size === 1
      ? 'grep -v "^' + [...keepSet][0] + '$"'
      : "grep -v -E '^(" + [...keepSet].join("|") + ")$'";
  return (
    'for c in $(' + rt.bin + ' ps -a --filter "name=' + prefix + '" --format "{{.Names}}"' +
    ' | grep "^' + prefix + '" | ' + keepFilter + '); do ' +
    'k=$(' + inspectLabel(rt, '"$c"', LABEL_KIND) + '); ' +
    'if [ "$k" = "' + KIND_ACCESSORY + '" ]; then continue; fi; ' +
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

/** Containers (any state) with status; label filter is exact when given. */
export function listForStatus(
  rt: Runtime,
  service: string,
  role: string,
  labels?: Record<string, string>,
): string {
  return labels
    ? rt.bin + " ps -a" + labelFilters(labels) + ' --format "{{.Names}} {{.Status}}"'
    : rt.bin + ' ps -a --filter "name=' + service + "-" + role +
        '-" --format "{{.Names}} {{.Status}}"';
}

/**
 * Currently RUNNING containers (names only). With `labels` the filter is an
 * exact label match (bundant.service / bundant.group) instead of a name prefix.
 */
export function listRunning(
  rt: Runtime,
  service: string,
  role: string,
  labels?: Record<string, string>,
): string {
  return labels
    ? rt.bin + " ps" + labelFilters(labels) + ' --format "{{.Names}}"'
    : rt.bin + ' ps --filter "name=' + service + "-" + role + '-" --format "{{.Names}}"';
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
