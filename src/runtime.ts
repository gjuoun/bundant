/** Container runtime abstraction - the single place the binary name is decided. */

export type RuntimeKind = "docker" | "podman";

export interface Runtime {
  kind: RuntimeKind;
  /** Binary name emitted into every command string. */
  bin: string;
  /** Extra args for the image-archive save command (podman needs an explicit format). */
  saveFormatArgs: string[];
  /** Rootless podman needs boot-persistence and low-port checks. */
  needsRootlessChecks: boolean;
  /**
   * Extra args for the proxy container only. The upstream kamal-proxy image
   * runs as a non-root user, which rootless podman cannot let bind :80
   * unless the container netns floor is 0 (verified live on docker01).
   */
  proxySysctlArgs: string[];
}

export function runtimeFor(kind: RuntimeKind): Runtime {
  if (kind === "podman") {
    return {
      kind,
      bin: "podman",
      saveFormatArgs: ["--format", "docker-archive"],
      needsRootlessChecks: true,
      proxySysctlArgs: ["--sysctl", "net.ipv4.ip_unprivileged_port_start=0"],
    };
  }
  return {
    kind: "docker",
    bin: "docker",
    saveFormatArgs: [],
    needsRootlessChecks: false,
    proxySysctlArgs: [],
  };
}

export const PORT_FLOOR_KEY = "net.ipv4.ip_unprivileged_port_start";

const PODMAN_RESTART = "podman-restart.service";

/**
 * Rootless boot persistence for podman, as an idempotent guarded pair:
 * the check comes first, enable runs only when the check says otherwise.
 * Non-podman runtimes emit nothing at all (true no-op for docker).
 */
export function runtimeCheckCommands(rt: Runtime): string[] {
  if (!rt.needsRootlessChecks) return [];
  const enableRestart =
    "systemctl --user is-enabled " + PODMAN_RESTART + " >/dev/null 2>&1" +
    " || systemctl --user enable --now " + PODMAN_RESTART +
    ' || { echo "bundant: could not enable ' + PODMAN_RESTART +
    ' for rootless boot persistence; run: systemctl --user enable --now ' + PODMAN_RESTART +
    '" >&2; exit 1; }';
  const linger =
    'loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null | grep -q yes' +
    ' || loginctl enable-linger "$(id -un)"' +
    ' || { echo "bundant: could not enable linger for $(id -un);' +
    ' run: sudo loginctl enable-linger $(id -un)" >&2; exit 1; }';
  return [enableRestart, linger];
}

/**
 * Informational host-floor check for rootless podman. It never aborts: the
 * proxy container sets its own netns floor to 0 via --sysctl, which is what
 * actually lets the non-root proxy bind 80/443 (verified live on docker01).
 * The note stays because slirp4netns-based hosts bind host-side and still
 * need the host floor lowered.
 */
export function portGuardCommand(rt: Runtime): string | null {
  if (!rt.needsRootlessChecks) return null;
  const note =
    "bundant: note: host " + PORT_FLOOR_KEY + " is \u0024{p:-unreadable} (>80 or unreadable). " +
    "The proxy container sets its own floor to 0 via --sysctl, so rootless binds work with " +
    "pasta-based " + rt.kind + "; if this host uses slirp4netns and port publishing fails: " +
    "sudo sysctl -w " + PORT_FLOOR_KEY + "=80";
  return (
    "p=$(sysctl -n " + PORT_FLOOR_KEY + ' 2>/dev/null); [ -n "$p" ] && [ "$p" -le 80 ] || echo "' +
    note + '"; exit 0'
  );
}
