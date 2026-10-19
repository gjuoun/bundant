import type { LoadedConfig } from "./config.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { resolveConnections, type HostConnection } from "./hosts.ts";
import type { Executor } from "./types.ts";
import type { RuntimeKind } from "./runtime.ts";
import { openAdapter } from "./adapters/index.ts";
import { socketServiceState } from "./adapters/service.ts";

/**
 * Host bootstrap: make any mainstream Linux box able to run this deployment —
 * install podman when it is missing, enable the boot-time restart unit and give
 * podman a registry search path. Everything is idempotent and converging: a host
 * that is already ready costs one probe and no changes.
 *
 * Output is deliberately quiet: a step's own output (apt/dpkg is loud) is shown
 * only when the step fails; passing steps emit a single `bundant:` note.
 */

export interface OsRelease {
  id: string;
  idLike: string[];
  versionId: string;
  prettyName: string;
}

export type PackageFamily = "apt" | "dnf" | "yum" | "apk" | "pacman" | "zypper" | "unknown";

export interface BootstrapStep {
  label: string;
  cmd: string;
  /** Print the step's whole output even when it succeeds (version probes). */
  show?: boolean;
}

export interface BootstrapProbe {
  os: OsRelease;
  family: PackageFamily;
  hasPodman: boolean;
  /** docker binary present (informational on a docker host). */
  hasDocker?: boolean;
  hasSystemd: boolean;
  /** container=lxc shows up in PID 1's environment: podman needs nesting=1 there. */
  inContainer: string;
  /** Numeric uid of the ssh login (0 = rootful). */
  uid?: string;
}

export interface BootstrapRunOptions {
  dryRun?: boolean;
  smoke?: boolean;
  /** Engine from deploy.yml: controls which prerequisites are converged. */
  runtime?: RuntimeKind;
}

/** Distro id (and ID_LIKE) to the package manager family that ships podman. */
const FAMILY_OF_ID: Record<string, PackageFamily> = {
  debian: "apt",
  ubuntu: "apt",
  linuxmint: "apt",
  raspbian: "apt",
  pop: "apt",
  neon: "apt",
  kali: "apt",
  devuan: "apt",
  fedora: "dnf",
  rhel: "dnf",
  centos: "dnf",
  rocky: "dnf",
  almalinux: "dnf",
  ol: "dnf",
  amzn: "dnf",
  cloudlinux: "dnf",
  alpine: "apk",
  postmarketos: "apk",
  arch: "pacman",
  archarm: "pacman",
  manjaro: "pacman",
  endeavouros: "pacman",
  garuda: "pacman",
  cachyos: "pacman",
  opensuse: "zypper",
  "opensuse-leap": "zypper",
  "opensuse-tumbleweed": "zypper",
  sles: "zypper",
  sled: "zypper",
  suse: "zypper",
};

const PKG_BIN: Record<Exclude<PackageFamily, "unknown">, string> = {
  apt: "apt-get",
  dnf: "dnf",
  yum: "yum",
  apk: "apk",
  pacman: "pacman",
  zypper: "zypper",
};
const PKG_BIN_ORDER = ["apt-get", "dnf", "yum", "apk", "pacman", "zypper"];

/** Probe command: one round trip that returns os-release plus the tools we care about. */
export function probeCommand(): string {
  const bins = ["podman", "docker", "systemctl", "loginctl", ...PKG_BIN_ORDER].join(" ");
  return [
    ". /etc/os-release 2>/dev/null || true",
    "printf 'BUNDANT_OS ID=%s\\n' \"${ID:-}\"",
    "printf 'BUNDANT_OS ID_LIKE=%s\\n' \"${ID_LIKE:-}\"",
    "printf 'BUNDANT_OS VERSION_ID=%s\\n' \"${VERSION_ID:-}\"",
    "printf 'BUNDANT_OS PRETTY_NAME=%s\\n' \"${PRETTY_NAME:-}\"",
    "printf 'BUNDANT_OS container=%s\\n' \"$(tr '\\0' '\\n' < /proc/1/environ 2>/dev/null | sed -n 's/^container=//p')\"",
    "printf 'BUNDANT_UID %s\n' \"$(id -u)\"",
    "for b in " + bins + "; do command -v $b >/dev/null 2>&1 && printf 'BUNDANT_BIN %s\\n' $b; done",
    "true",
  ].join("; ");
}

export function parseProbe(output: string): BootstrapProbe {
  const fields = new Map<string, string>();
  const bins = new Set<string>();
  let uid = "";
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("BUNDANT_OS ")) {
      const rest = line.slice("BUNDANT_OS ".length);
      const eq = rest.indexOf("=");
      if (eq > 0) fields.set(rest.slice(0, eq), rest.slice(eq + 1));
    } else if (line.startsWith("BUNDANT_BIN ")) {
      bins.add(line.slice("BUNDANT_BIN ".length).trim());
    } else if (line.startsWith("BUNDANT_UID ")) {
      uid = line.slice("BUNDANT_UID ".length).trim();
    }
  }
  const os: OsRelease = {
    id: (fields.get("ID") ?? "").toLowerCase(),
    idLike: (fields.get("ID_LIKE") ?? "").split(/\s+/).filter((s) => s !== "").map((s) => s.toLowerCase()),
    versionId: fields.get("VERSION_ID") ?? "",
    prettyName: fields.get("PRETTY_NAME") || fields.get("ID") || "unknown",
  };
  const available = [...bins];
  return {
    os,
    family: packageFamily(os, available),
    hasPodman: bins.has("podman"),
    hasDocker: bins.has("docker"),
    hasSystemd: bins.has("systemctl"),
    inContainer: fields.get("container") ?? "",
    uid,
  };
}

/** Which package manager to use: distro id first, then ID_LIKE, then whatever exists. */
export function packageFamily(os: OsRelease, available: string[]): PackageFamily {
  const ordered: Array<Exclude<PackageFamily, "unknown">> = [];
  const push = (f: PackageFamily | undefined): void => {
    if (f === undefined || f === "unknown" || ordered.includes(f)) return;
    ordered.push(f);
  };
  push(FAMILY_OF_ID[os.id]);
  for (const like of os.idLike) push(FAMILY_OF_ID[like]);
  for (const f of ["apt", "dnf", "yum", "apk", "pacman", "zypper"] as const) push(f);

  for (const family of ordered) {
    if (family === "dnf" && !available.includes("dnf") && available.includes("yum")) return "yum";
    if (available.includes(PKG_BIN[family])) return family;
  }
  return "unknown";
}

/** Commands that install podman for a family (run as root). */
export function installCommands(family: PackageFamily): string[] {
  switch (family) {
    case "apt":
      return ["apt-get update", "DEBIAN_FRONTEND=noninteractive apt-get install -y podman"];
    case "dnf":
      return ["dnf install -y podman"];
    case "yum":
      return ["yum install -y podman"];
    case "apk":
      return ["apk add --no-cache podman"];
    case "pacman":
      return ["pacman -Sy --noconfirm podman"];
    case "zypper":
      return ["zypper --non-interactive install podman"];
    case "unknown":
      return [];
  }
}

/**
 * Podman needs a search path for short image names; Ubuntu's default config has
 * none, so `podman run alpine` fails with "short-name ... did not resolve".
 * Written once, never overwritten.
 */
export const REGISTRIES_CONF = "/etc/containers/registries.conf.d/999-bundant.conf";
export const REGISTRIES_BODY = 'unqualified-search-registries = ["docker.io"]\nshort-name-mode = "enforcing"\n';

/**
 * Enable the API socket idempotently. The unit scope is derived from the login
 * uid inside the shell, so the same command works for rootful and rootless.
 */
export function socketStep(): BootstrapStep {
  return {
    label: "podman API socket",
    cmd:
      'if [ "$(id -u)" = "0" ]; then s=""; else s="--user"; fi; ' +
      "if systemctl $s is-enabled podman.socket >/dev/null 2>&1 && " +
      "systemctl $s is-active podman.socket >/dev/null 2>&1; then " +
      "echo 'bundant: podman.socket already enabled and active'; " +
      "else systemctl $s enable --now podman.socket && echo 'bundant: podman.socket enabled'; fi",
  };
}

export function lingerStep(): BootstrapStep {
  return {
    label: "rootless linger",
    cmd:
      'if [ "$(id -u)" = "0" ]; then ' +
      "echo 'bundant: rootful podman — linger not needed'; " +
      'else u="$(id -un)"; ' +
      'if loginctl show-user "$u" -p Linger --value 2>/dev/null | grep -q yes; then ' +
      "echo \"bundant: linger already enabled for $u\"; " +
      "else loginctl enable-linger \"$u\" && echo \"bundant: linger enabled for $u\"; fi; fi",
  };
}

function isRootful(probe: BootstrapProbe): boolean {
  return probe.uid === undefined || probe.uid === "" || probe.uid === "0";
}

export function planBootstrap(probe: BootstrapProbe, opts: BootstrapRunOptions = {}): BootstrapStep[] {
  const runtime = opts.runtime ?? "podman";
  const steps: BootstrapStep[] = [];

  if (runtime === "docker") {
    steps.push({
      label: "docker reachability",
      cmd:
        "if docker info >/dev/null 2>&1; then " +
        "echo 'bundant: docker socket reachable'; else " +
        "echo 'bundant: docker socket not reachable — start dockerd on the host; bundant leaves it alone' >&2; exit 1; fi",
    });
    steps.push({ label: "docker version", cmd: "docker --version", show: true });
    return steps;
  }

  if (!probe.hasPodman) {
    const install = installCommands(probe.family);
    if (install.length === 0) {
      steps.push({
        label: "install podman",
        cmd:
          "echo 'bundant: no supported package manager for " + probe.os.prettyName +
          " — install podman manually' >&2; exit 1",
      });
    } else {
      install.forEach((cmd, i) => {
        const last = i === install.length - 1;
        steps.push({
          label: "install podman (" + probe.family + ")",
          cmd: cmd + (last ? "; echo 'bundant: podman installed via " + probe.family + "'" : ""),
        });
      });
    }
  }
  steps.push({
    label: "registry search path",
    cmd:
      "mkdir -p /etc/containers/registries.conf.d; " +
      "if [ -f " + REGISTRIES_CONF + " ]; then echo 'bundant: registry search path already configured'; " +
      "else printf '" + REGISTRIES_BODY.replace(/\n/g, "\\n") + "' > " + REGISTRIES_CONF +
      " && echo 'bundant: wrote " + REGISTRIES_CONF + "'; fi",
  });
  if (probe.hasSystemd) {
    steps.push({
      label: "boot-time restart unit",
      cmd:
        "if systemctl list-unit-files 2>/dev/null | grep -q '^podman-restart.service'; then " +
        "if systemctl is-enabled podman-restart.service >/dev/null 2>&1; then " +
        "echo 'bundant: podman-restart.service already enabled'; " +
        "else systemctl enable --now podman-restart.service >/dev/null 2>&1 && " +
        "echo 'bundant: podman-restart.service enabled'; fi; " +
        "else echo 'bundant: no podman-restart unit on this host'; fi",
    });
    steps.push(socketStep());
    if (!isRootful(probe)) steps.push(lingerStep());
  }
  steps.push({ label: "podman version", cmd: "podman --version", show: true });
  if (opts.smoke !== false) {
    steps.push({
      label: "smoke test (pull + run)",
      cmd:
        "if podman run --rm docker.io/library/hello-world >/dev/null 2>&1; then " +
        "echo 'bundant: smoke test passed'; else " +
        "echo 'bundant: smoke test FAILED" +
        (probe.inContainer === "lxc" ? " — inside LXC the container needs nesting=1" : "") +
        "' >&2; exit 1; fi",
    });
  }
  return steps;
}

export interface HostBootstrapReport {
  target: string;
  probe: BootstrapProbe;
  executed: boolean;
  failures: string[];
}

/** One host: probe, plan, converge. */
export class HostBootstrap {
  private readonly exec: Executor;
  private readonly target: string;

  constructor(exec: Executor, target: string) {
    this.exec = exec;
    this.target = target;
  }

  async describe(): Promise<BootstrapProbe> {
    const probe = await this.exec.run(probeCommand());
    if (probe.code !== 0) {
      throw new Error("probe failed: " + (probe.stderr.trim() || "exit " + probe.code));
    }
    return parseProbe(probe.stdout);
  }

  async converge(probe: BootstrapProbe, opts: BootstrapRunOptions = {}): Promise<HostBootstrapReport> {
    const failures: string[] = [];
    for (const step of planBootstrap(probe, opts)) {
      console.log("  - " + step.label);
      if (opts.dryRun) {
        console.log("    $ " + step.cmd);
        continue;
      }
      const r = await this.exec.run(step.cmd);
      const lines = (r.stdout + "\n" + r.stderr)
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l !== "");
      if (r.code !== 0) {
        failures.push(step.label);
        for (const l of lines.slice(-15)) console.log("    " + l); // failures speak in full
        console.log("    failed (exit " + r.code + ")");
        continue;
      }
      const notes = lines.filter((l) => l.startsWith("bundant:"));
      const out = step.show ? lines : notes;
      for (const l of out) console.log("    " + l.replace(/^bundant: /, ""));
    }
    return { target: this.target, probe, executed: opts.dryRun !== true, failures };
  }
}

/** Prove the socket through the adapter — the same path every command takes. */
export async function verifyEndpoint(
  connection: HostConnection,
  runtime: RuntimeKind,
): Promise<{ engine: string; version: string; socket: string; service: string }> {
  const opened = await openAdapter(connection, runtime);
  try {
    const service = await socketServiceState(connection, runtime);
    return {
      engine: opened.adapter.kind,
      version: opened.adapter.engineVersion,
      socket: opened.detection.socketPath ?? "unknown",
      service,
    };
  } finally {
    await opened.close();
  }
}

/** The bootstrap command: converge every host in deploy.yml. */
export async function bootstrap(loaded: LoadedConfig, opts: BootstrapRunOptions): Promise<number> {
  let exit = 0;
  const runtime = loaded.config.runtime;
  for (const conn of resolveConnections(loaded.config)) {
    console.log("== " + conn.sshTarget + " ==");
    const host = new HostBootstrap(new SshExecutor(connectOptionsFor(conn)), conn.sshTarget);
    try {
      const probe = await host.describe();
      console.log(
        "  os: " + probe.os.prettyName + "  family: " + probe.family + "  runtime: " + runtime + "  podman: " +
          (probe.hasPodman ? "present" : "missing") + (probe.inContainer ? "  container: " + probe.inContainer : ""),
      );
      const report = await host.converge(probe, { ...opts, runtime });
      if (report.failures.length > 0) {
        console.log("  failed: " + report.failures.join(", "));
        exit = 1;
        continue;
      }
      if (!report.executed) continue;
      const endpoint = await verifyEndpoint(conn, runtime);
      console.log(
        "  engine: " + endpoint.engine + " " + endpoint.version +
          "  socket: " + endpoint.socket + "  service: " + endpoint.service,
      );
      console.log("  ready");
    } catch (e) {
      console.log("  " + (e as Error).message);
      exit = 1;
    }
  }
  return exit;
}

