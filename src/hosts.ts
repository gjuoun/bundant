/**
 * Host parsing and precedence for ssh targets.
 *
 * deploy.yml may name hosts as "box.example.com", "root@box.example.com" or
 * "root@[2001:db8::1]". A top-level user: applies to every host that does not
 * carry its own prefix:
 *
 *   per-host user@  >  top-level user  >  ssh config default
 */

export class HostParseError extends Error {}

export interface ParsedHost {
  /** Login user from a user@ prefix (or the top-level user after resolution). */
  user?: string;
  /** Host alone, IPv6 brackets removed. */
  host: string;
  /** The value that goes on the ssh command line: user@host when a user is set. */
  sshTarget: string;
}

export interface HostConfigLike {
  hosts: string[];
  user?: string;
}

const USER_RE = /^[A-Za-z0-9._-]+$/;

export function parseHost(entry: string): ParsedHost {
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
    if (!USER_RE.test(user)) {
      throw new HostParseError("invalid ssh user in host entry: " + entry);
    }
  }

  let host = rest;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) throw new HostParseError("unterminated IPv6 bracket in host entry: " + entry);
    host = rest.slice(1, close);
    if (host === "") throw new HostParseError("empty IPv6 bracket in host entry: " + entry);
    const after = rest.slice(close + 1);
    if (after !== "") {
      throw new HostParseError(
        "ports are not supported in hosts entries (use ~/.ssh/config): " + entry,
      );
    }
  } else if (/:[0-9]+$/.test(rest) && rest.split(":").length === 2) {
    throw new HostParseError(
      "ports are not supported in hosts entries (use ~/.ssh/config): " + entry,
    );
  }

  return { user, host, sshTarget: user ? user + "@" + host : host };
}

/** Apply the precedence chain to every configured host. */
export function resolveHosts(config: HostConfigLike): ParsedHost[] {
  const fallback = config.user !== undefined && config.user !== "" ? config.user : undefined;
  return config.hosts.map((raw) => {
    const parsed = parseHost(raw);
    if (parsed.user === undefined && fallback !== undefined) {
      return { ...parsed, user: fallback, sshTarget: fallback + "@" + parsed.host };
    }
    return parsed;
  });
}

/** Just the ssh targets, ready for SshExecutor({ host }) and plan rendering. */
export function hostTargets(config: HostConfigLike): string[] {
  return resolveHosts(config).map((h) => h.sshTarget);
}
