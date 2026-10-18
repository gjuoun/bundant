/**
 * Host parsing and connection resolution.
 *
 * deploy.yml may name hosts as:
 *
 *   box.example.com            root@box.example.com
 *   root@box.example.com:2222  root@[2001:db8::1]:2222
 *
 * The `ssh:` block supplies defaults for the whole deployment:
 *
 *   ssh:
 *     user: deploy
 *     port: 22
 *     identity: ~/.ssh/prod_deploy
 *     options: ["-o", "StrictHostKeyChecking=accept-new"]
 *
 * Precedence: per-host (user@, :port) > ssh block > ssh defaults (~/.ssh/config).
 */

import { homedir } from "node:os";

export class HostParseError extends Error {}

export interface SshDefaults {
  user?: string;
  port?: number;
  identity?: string;
  options?: string[];
}

export interface HostConfigLike {
  hosts: string[];
  user?: string;
  ssh?: SshDefaults;
}

/** Everything needed to reach one host: one object, one ssh argv. */
export interface HostConnection {
  /** Login user from user@ (or ssh.user); undefined = ssh config default. */
  user?: string;
  /** Hostname or IP, IPv6 brackets removed. */
  host: string;
  /** Port from host:port (or ssh.port); undefined = ssh default 22. */
  port?: number;
  /** Private key path (ssh.identity), ~ expanded; undefined = agent/config. */
  identity?: string;
  /** Extra raw ssh args (ssh.options). */
  options: string[];
  /** user@host, for ssh argv and plan display. */
  sshTarget: string;
}

const USER_RE = /^[A-Za-z0-9._-]+$/;

export function parseHost(entry: string): { user?: string; host: string; port?: number } {
  const trimmed = entry.trim();
  if (trimmed === "") throw new HostParseError("empty host entry");

  let user: string | undefined;
  let rest = trimmed;
  const at = rest.indexOf("@");
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (user === "" || rest === "") {
      throw new HostParseError("malformed host entry (expected user@host): " + entry);
    }
    if (!USER_RE.test(user)) throw new HostParseError("invalid ssh user in host entry: " + entry);
  }

  let host = rest;
  let port: number | undefined;

  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) throw new HostParseError("unterminated IPv6 bracket in host entry: " + entry);
    host = rest.slice(1, close);
    if (host === "") throw new HostParseError("empty IPv6 bracket in host entry: " + entry);
    const after = rest.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) {
        throw new HostParseError("unexpected text after IPv6 address: " + entry);
      }
      port = parsePort(after.slice(1), entry);
    }
  } else {
    const colon = rest.lastIndexOf(":");
    // A bare IPv6 address contains several colons: only a single-colon form is host:port.
    if (rest.split(":").length === 2 && colon !== -1 && /^[0-9]+$/.test(rest.slice(colon + 1))) {
      host = rest.slice(0, colon);
      port = parsePort(rest.slice(colon + 1), entry);
      if (host === "") throw new HostParseError("empty host in entry: " + entry);
    }
  }

  return { user, host, port };
}

function parsePort(raw: string, entry: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostParseError("invalid port in host entry: " + entry);
  }
  return port;
}

/** Expand a leading ~ so the ssh child gets a usable path. */
export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/** Resolve every configured host into a complete connection descriptor. */
export function resolveConnections(config: HostConfigLike): HostConnection[] {
  const ssh = config.ssh ?? {};
  const fallbackUser = ssh.user ?? config.user;
  return config.hosts.map((raw) => {
    const parsed = parseHost(raw);
    const user =
      parsed.user ?? (fallbackUser !== undefined && fallbackUser !== "" ? fallbackUser : undefined);
    const port = parsed.port ?? ssh.port;
    return {
      user,
      host: parsed.host,
      port,
      identity: ssh.identity !== undefined ? expandHome(ssh.identity) : undefined,
      options: ssh.options ?? [],
      sshTarget: user ? user + "@" + parsed.host : parsed.host,
    };
  });
}

/** Just the ssh targets (plan rendering, log prefixes). */
export function hostTargets(config: HostConfigLike): string[] {
  return resolveConnections(config).map((c) => c.sshTarget);
}

/**
 * Look up the full connection for a target string that came out of a plan
 * ({HOST} substituted to user@host). Falls back to a bare connection so an
 * unknown target still yields a usable (if under-specified) ssh argv.
 */
export function connectionForTarget(config: HostConfigLike, target: string): HostConnection {
  const found = resolveConnections(config).find((c) => c.sshTarget === target);
  if (found) return found;
  return { host: target, options: [], sshTarget: target };
}
