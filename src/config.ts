import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RuntimeKind } from "./runtime.ts";
import { PROXY_IMAGE } from "./commands/proxy.ts";

/** Identifiers that end up inside docker container/network names. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class ConfigError extends Error {}

const EnvSchema = z.object({
  file: z.string().optional(),
  vars: z.record(z.string()).optional(),
});

const HealthSchema = z.object({
  path: z.string().regex(/^\/\S*$/, "must start with /").optional(),
  port: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
});

const ProxySchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  tls: z.boolean().optional(),
  /** Override for hosts that cannot reach Docker Hub: your own kamal-proxy tag. */
  image: z.string().min(1).optional(),
});

/** ssh block: enough to reach a host without any ~/.ssh/config entry. */
export const SshSchema = z.object({
  user: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a plain ssh user name").optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identity: z.string().min(1).optional(),
  options: z.array(z.string()).optional(),
});

/** A shared ssh file may also carry the default host pool. */
export const SshFileSchema = SshSchema.extend({
  hosts: z.array(z.string().min(1)).optional(),
});

/** deploy.yml as written (sections optional); defaults are applied by normalize(). */
export const RawConfigSchema = z.object({
  service: z.string().regex(NAME_RE, "must match [a-z0-9-]"),
  image: z.string().min(1),
  role: z.string().regex(NAME_RE, "must match [a-z0-9-]").optional(),
  hosts: z.array(z.string().min(1)).optional(),
  /**
   * ssh connection defaults: an inline block, or a path to a shared YAML file
   * (multiple deployments can reference the same one).
   */
  ssh: z.union([SshSchema, z.string().min(1)]).optional(),
  /** Legacy alias for ssh.user (still honoured when ssh.user is absent). */
  user: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a plain ssh user name").optional(),
  runtime: z.enum(["docker", "podman"]).optional(),
  env: EnvSchema.optional(),
  healthcheck: HealthSchema.optional(),
  proxy: ProxySchema.optional(),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

/** Fully-defaulted config. */
export interface BundantConfig {
  service: string;
  image: string;
  role: string;
  hosts: string[];
  /** ssh connection defaults (user/port/identity/options); per-host entries win. */
  ssh?: { user?: string; port?: number; identity?: string; options?: string[] };
  /** Legacy alias for ssh.user. */
  user?: string;
  /** Container runtime on the target hosts (default: docker). */
  runtime: RuntimeKind;
  env: { file?: string; vars: Record<string, string> };
  healthcheck: { path: string; port: number; timeout: number };
  proxy: { enabled: boolean; host?: string; port: number; tls: boolean; image: string };
}

export function normalize(raw: RawConfig, hosts?: string[]): BundantConfig {
  const proxy = {
    enabled: raw.proxy?.enabled ?? true,
    host: raw.proxy?.host,
    port: raw.proxy?.port ?? 80,
    tls: raw.proxy?.tls ?? false,
    image: raw.proxy?.image ?? PROXY_IMAGE,
  };
  if (proxy.enabled && !proxy.host) {
    throw new ConfigError(
      "invalid deploy.yml: proxy.host is required when proxy.enabled is true (set enabled: false for proxy-less roles)",
    );
  }
  return {
    service: raw.service,
    image: raw.image,
    role: raw.role ?? "web",
    hosts: hosts ?? raw.hosts ?? [],
    user: raw.user,
    ssh: typeof raw.ssh === "object" ? raw.ssh ?? {} : {},
    runtime: raw.runtime ?? "docker",
    env: { file: raw.env?.file, vars: raw.env?.vars ?? {} },
    healthcheck: {
      path: raw.healthcheck?.path ?? "/",
      port: raw.healthcheck?.port ?? proxy.port,
      timeout: raw.healthcheck?.timeout ?? 30,
    },
    proxy,
  };
}

export interface LoadedConfig {
  config: BundantConfig;
  /** Merged env file+vars rendered as KEY=VAL lines (null when no env configured). */
  envContent: string | null;
  envCount: number;
  path: string;
}

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1));
  }
  return out;
}

/**
 * Resolve `ssh:` into defaults plus an optional host pool: inline mapping, or a
 * path (relative to deploy.yml) to a shared ssh YAML file.
 */
export function resolveSshBlock(
  ssh: RawConfig["ssh"],
  configDir: string,
): { sshDefaults: z.infer<typeof SshSchema>; fileHosts?: string[] } {
  if (ssh === undefined) return { sshDefaults: {} };
  if (typeof ssh !== "string") return { sshDefaults: ssh };

  const path = resolve(configDir, ssh);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError("cannot read ssh file " + path + ": " + (e as Error).message);
  }
  const parsed = SshFileSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ");
    throw new ConfigError("invalid ssh file (" + path + "): " + issues);
  }
  const { hosts, ...defaults } = parsed.data;
  return { sshDefaults: defaults, fileHosts: hosts };
}

export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LoadedConfig {
  const abs = resolve(path);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError("cannot read deploy.yml at " + abs + ": " + (e as Error).message);
  }
  const parsed = RawConfigSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ");
    throw new ConfigError("invalid deploy.yml (" + abs + "): " + issues);
  }
  const { sshDefaults, fileHosts } = resolveSshBlock(parsed.data.ssh, dirname(abs));
  const hosts = parsed.data.hosts ?? fileHosts;
  if (!hosts || hosts.length === 0) {
    throw new ConfigError(
      "invalid deploy.yml (" + abs + "): hosts is required (set it here or in the referenced ssh file)",
    );
  }
  const merged: RawConfig = { ...parsed.data, hosts, ssh: sshDefaults };
  let config = normalize(merged, hosts);

  const override = env.BUNDANT_HOSTS;
  if (override !== undefined && override.trim() !== "") {
    const hosts = override.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (hosts.length === 0) throw new ConfigError("BUNDANT_HOSTS is set but empty");
    config = { ...config, hosts };
  }

  const entries = new Map<string, string>();
  if (config.env.file) {
    const envPath = resolve(dirname(abs), config.env.file);
    let text: string;
    try {
      text = readFileSync(envPath, "utf8");
    } catch {
      throw new ConfigError("env.file not found: " + envPath);
    }
    for (const [k, v] of parseEnvFile(text)) entries.set(k, v);
  }
  for (const [k, v] of Object.entries(config.env.vars)) entries.set(k, v);
  const envContent =
    entries.size > 0 ? [...entries].map(([k, v]) => k + "=" + v).join("\n") + "\n" : null;

  return { config, envContent, envCount: entries.size, path: abs };
}
