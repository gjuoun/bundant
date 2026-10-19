import { SshExecutor, connectOptionsFor } from "../exec/ssh.ts";
import type { HostConnection } from "../hosts.ts";
import type { RuntimeKind } from "../runtime.ts";

/**
 * systemd state of the engine socket service. This is the one runtime fact the
 * API cannot answer — it stays on ssh, and both bootstrap and the runtime
 * report use it.
 */
export type SocketServiceState = "enabled" | "active" | "inactive" | "absent";

const ENABLED = new Set(["enabled", "enabled-runtime", "static", "indirect", "generated"]);

export async function socketServiceState(
  connection: HostConnection,
  expected: RuntimeKind,
): Promise<SocketServiceState> {
  // Docker's socket is part of dockerd; bootstrap leaves it alone, so "active"
  // is the honest report and matches the old runtime output.
  if (expected !== "podman") return "active";
  try {
    const exec = new SshExecutor(connectOptionsFor(connection));
    const r = await exec.run(
      'if [ "$(id -u)" = "0" ]; then s=""; else s="--user"; fi; ' +
        "printf 'enabled=%s\\n' \"$(systemctl $s is-enabled podman.socket 2>/dev/null || true)\"; " +
        "printf 'active=%s\\n' \"$(systemctl $s is-active podman.socket 2>/dev/null || true)\"; " +
        "printf 'uid=%s\\n' \"$(id -u)\"",
    );
    if (r.code !== 0) return "active";
    const fields = new Map<string, string>();
    for (const line of r.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    const enabled = fields.get("enabled") ?? "";
    if (ENABLED.has(enabled)) return "enabled";
    const active = fields.get("active") ?? "";
    if (active === "active") return "active";
    if (active === "inactive") return "inactive";
    return "absent";
  } catch {
    return "active";
  }
}
