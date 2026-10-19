import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RuntimeKind } from "./runtime.ts";
import { PROXY_IMAGE } from "./commands/proxy.ts";
import {
  DEFAULT_GROUP,
  GROUP_NAME_RE,
  REVISION_RE,
  ROLE_NAME_RE,
  SEGMENT_NAME_RULE,
  SERVICE_NAME_RE,
  SERVICE_NAME_RULE,
  composeContainerName,
  roundTrips,
} from "./name-grammar.ts";

export {
  DEFAULT_GROUP,
  GROUP_NAME_RE,
  REVISION_RE,
  ROLE_NAME_RE,
  SERVICE_NAME_RE,
  SERVICE_NAME_RULE,
  SEGMENT_NAME_RULE,
} from "./name-grammar.ts";

/** Historical alias: every config name used to share one grammar. */
export const NAME_RE = SERVICE_NAME_RE;

export class ConfigError extends Error {}

/**
 * Value-specific zod string. `.regex` keeps the pattern in the generated JSON
 * schema; the `superRefine` adds the exact field/value message the CLI prints.
 * Reports dedupe the two by field (see `zodIssues`), keeping the value-specific one.
 */
export function namedString(label: string, re: RegExp, rule: string, description?: string) {
  const schema = z
    .string()
    .regex(re, rule)
    .superRefine((value, ctx) => {
      if (re.test(value)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: label + ' "' + value + '" ' + rule,
      });
    });
  return description === undefined ? schema : schema.describe(description);
}

export interface ConfigIssue {
  field: string;
  message: string;
}

/** Collapse duplicate issues for one field, preferring the value-specific message. */
export function zodIssues(error: z.ZodError): ConfigIssue[] {
  const byField = new Map<string, ConfigIssue>();
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "(root)";
    const current = byField.get(field);
    const better = issue.message.includes('"') || current === undefined;
    if (better) byField.set(field, { field, message: issue.message });
  }
  return [...byField.values()];
}

function defaultIdentity(raw: { service?: unknown; role?: unknown }) {
  const service = typeof raw.service === "string" ? raw.service : "";
  const role = typeof raw.role === "string" ? raw.role : "web";
  return { group: DEFAULT_GROUP, service, role, revision: "r0" };
}

const EnvSchema = z.object({
  file: z.string().describe("local KEY=VAL file (gitignored); uploaded to the host as mode 0600").optional(),
  vars: z
    .record(z.string())
    .describe("inline values; merged over file keys. Never printed by bundant")
    .optional(),
}).strict();

const HealthSchema = z.object({
  path: z.string().regex(/^\/\S*$/, "must start with /").describe("HTTP path the gate probes (default /)").optional(),
  port: z.number().int().positive().describe("container port to probe (default proxy.port)").optional(),
  timeout: z.number().int().positive().describe("seconds before the gate gives up (default 30)").optional(),
  /** Accessory readiness: a bare TCP connect to this port must succeed. */
  tcp: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe("accessory readiness: a bare TCP connect to this port must succeed")
    .optional(),
}).strict();

const ProxySchema = z.object({
  enabled: z.boolean().describe("swap traffic at deploy (default true)").optional(),
  host: z.string().min(1).describe("Host header this service answers on (required when enabled)").optional(),
  port: z.number().int().positive().describe("container port kamal-proxy targets (default 80)").optional(),
  tls: z.boolean().describe("pass --tls to kamal-proxy (ACME certificates)").optional(),
  /** Override for hosts that cannot reach Docker Hub: your own kamal-proxy tag. */
  image: z.string().min(1).describe("proxy image override for air-gapped hosts").optional(),
}).strict();

/** ssh block: enough to reach a host without any ~/.ssh/config entry. */
export const SshSchema = z.object({
  user: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a plain ssh user name").describe("default login user; a per-host user@ wins").optional(),
  port: z.number().int().min(1).max(65535).describe("default port; a per-host :port wins").optional(),
  identity: z.string().min(1).describe("private key path; ~ is expanded").optional(),
  options: z.array(z.string()).describe('extra ssh flags, e.g. ["-o","StrictHostKeyChecking=accept-new"]').optional(),
}).strict();

/** A shared ssh file may also carry the default host pool. */
export const SshFileSchema = SshSchema.extend({
  hosts: z.array(z.string().min(1)).describe("default host pool for deployments that reference this file").optional(),
}).strict();

/** deploy.yml as written (sections optional); defaults are applied by normalize(). */
export const RawConfigSchema = z.object({
  service: namedString("service", SERVICE_NAME_RE, SERVICE_NAME_RULE, "service name; also the identity in container names (single hyphens allowed)"),
  image: z.string().min(1).describe("registry ref to run; --local-image overrides it"),
  role: namedString("role", ROLE_NAME_RE, SEGMENT_NAME_RULE, "variant within the service (default web); no hyphens: containers are <service>-<role>-<rev>").optional(),
  /** Copies of one service on a single host; the proxy round-robins between them. */
  replicas: z
    .number()
    .int()
    .min(1)
    .describe("running copies of this service on each host (default 1); >1 requires proxy.enabled: true")
    .optional(),
  /** service (stateless, deployed by bundant) or accessory (stateful, explicit). */
  kind: z
    .enum(["service", "accessory"])
    .describe("service (default) deploys/rolls back; accessory is stateful: stable name, named volumes, only touched by `bundant accessory`")
    .optional(),
  /** Named volumes for an accessory: "name:/path/in/container". */
  volumes: z
    .array(z.string().min(1))
    .describe('accessory named volumes, "name:/path/in/container" — survive container recreation')
    .optional(),
  hosts: z
    .array(z.string().min(1))
    .describe("user@host[:port] entries; BUNDANT_HOSTS=a,b overrides at deploy time")
    .optional(),
  /**
   * ssh connection defaults: an inline block, or a path to a shared YAML file
   * (multiple deployments can reference the same one).
   */
  ssh: z
    .union([SshSchema, z.string().min(1)])
    .describe("inline ssh defaults, or a path to a shared ssh YAML file")
    .optional(),
  /** Legacy alias for ssh.user (still honoured when ssh.user is absent). */
  user: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a plain ssh user name").describe("legacy alias for ssh.user").optional(),
  runtime: z.enum(["docker", "podman"]).describe("container runtime on the hosts (default docker)").optional(),
  env: EnvSchema.optional(),
  healthcheck: HealthSchema.optional(),
  proxy: ProxySchema.optional(),
})
  .strict()
  .superRefine((raw, ctx) => {
    const identity = defaultIdentity(raw);
    if (!SERVICE_NAME_RE.test(identity.service) || !ROLE_NAME_RE.test(identity.role)) return;
    if (roundTrips(identity)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message:
        'composed name "' + composeContainerName(identity) +
        '" does not round-trip to the declared identity',
    });
  });

export type RawConfig = z.infer<typeof RawConfigSchema>;

/** Fully-defaulted config. */
export interface BundantConfig {
  service: string;
  image: string;
  role: string;
  /** Running copies of this service on each host (default 1; accessories are one of one). */
  replicas: number;
  /** service (default) or accessory — accessories are never deployed/rolled/pruned. */
  kind?: "service" | "accessory";
  /** Named volumes (accessory only). */
  volumes?: string[];
  /** Namespace this service belongs to (set by loadGroup); undefined = ungrouped. */
  group?: string;
  hosts: string[];
  /** ssh connection defaults (user/port/identity/options); per-host entries win. */
  ssh?: { user?: string; port?: number; identity?: string; options?: string[] };
  /** Legacy alias for ssh.user. */
  user?: string;
  /** Container runtime on the target hosts (default: docker). */
  runtime: RuntimeKind;
  env: { file?: string; vars: Record<string, string> };
  healthcheck: { path: string; port: number; timeout: number; tcp?: number };
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
  const kind = raw.kind ?? "service";
  const replicas = raw.replicas ?? 1;
  if (kind === "accessory" && raw.replicas !== undefined) {
    throw new ConfigError(
      "invalid deploy.yml: replicas is not allowed on kind: accessory (a stateful member is one of one)",
    );
  }
  if (kind === "accessory" && proxy.enabled) {
    throw new ConfigError(
      "invalid deploy.yml: proxy is not allowed on kind: accessory (stateful members are not routed; set proxy.enabled: false)",
    );
  }
  if (replicas > 1 && !proxy.enabled) {
    throw new ConfigError(
      "invalid deploy.yml: replicas > 1 requires proxy.enabled: true — without a proxy nothing distributes traffic between the copies",
    );
  }
  return {
    service: raw.service,
    image: raw.image,
    role: raw.role ?? "web",
    replicas,
    kind,
    volumes: raw.volumes ?? [],
    hosts: hosts ?? raw.hosts ?? [],
    user: raw.user,
    ssh: typeof raw.ssh === "object" ? raw.ssh ?? {} : {},
    runtime: raw.runtime ?? "docker",
    env: { file: raw.env?.file, vars: raw.env?.vars ?? {} },
    healthcheck: {
      path: raw.healthcheck?.path ?? "/",
      port: raw.healthcheck?.port ?? proxy.port,
      timeout: raw.healthcheck?.timeout ?? 30,
      tcp: raw.healthcheck?.tcp,
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
    const issues = zodIssues(parsed.error).map((i) => i.field + ": " + i.message).join("; ");
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
    const issues = zodIssues(parsed.error).map((i) => i.field + ": " + i.message).join("; ");
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
  // Every deployment lives in a namespace: an ungrouped file lands in DEFAULT_GROUP,
  // so labels, the env path and the lock key keep one shape everywhere.
  let config = { ...normalize(merged, hosts), group: DEFAULT_GROUP };
  // A member file addressed directly still belongs to its sibling group.yml, so
  // delete/prune/scale/rollback resolve the same names as `group install`.
  const inferredGroup = inferGroupForMember(abs);
  if (inferredGroup !== undefined) config = { ...config, group: inferredGroup };

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

/**
 * group.yml — the namespace manifest. A group is a directory: the manifest lists
 * members in install order and their explicit dependencies. One repo per group,
 * so its git sha is the release id for the whole set.
 */
export const GroupServiceSchema = z.object({
  name: namedString("member", SERVICE_NAME_RE, SERVICE_NAME_RULE, "member identity; must equal the member file's service (single hyphens allowed)"),
  /** deploy.yml or accessory.yml, resolved relative to the group directory. */
  file: z.string().min(1).describe("path to deploy.yml/accessory.yml, relative to the group directory"),
  /** In-group member names this member requires to be ready first. */
  needs: z
    .array(namedString("dependency", SERVICE_NAME_RE, SERVICE_NAME_RULE))
    .describe("members that must be ready first; the install order is their topological sort")
    .optional(),
}).strict();

export const GroupFileSchema = z.object({
  group: namedString("group", GROUP_NAME_RE, SEGMENT_NAME_RULE, "namespace name; no hyphens (they are separators): scopes the env directory and the lock key"),
  services: z.array(GroupServiceSchema).min(1).describe("members; array order only breaks ties, needs decides the real order"),
})
  .strict()
  .superRefine((raw, ctx) => {
    if (!GROUP_NAME_RE.test(raw.group)) return;
    raw.services.forEach((member, index) => {
      if (!SERVICE_NAME_RE.test(member.name)) return;
      const identity = {
        group: raw.group,
        service: member.name,
        role: "web",
        revision: "r0",
      };
      if (roundTrips(identity)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services", index, "name"],
        message:
          'composed name "' + composeContainerName(identity) +
          '" does not round-trip to the declared identity',
      });
    });
  });

export type GroupFile = z.infer<typeof GroupFileSchema>;

/**
 * `<group>/<member>/deploy.yml` -> the group named by `<group>/group.yml`,
 * only when that manifest actually lists this file. Undefined otherwise.
 */
export function inferGroupForMember(path: string): string | undefined {
  const abs = resolve(path);
  // Two layouts exist: <group>/<member>/deploy.yml (manifest one level up) and
  // <group>/deploy.yml beside its manifest. Try the member layout first.
  for (const manifest of [resolve(dirname(dirname(abs)), "group.yml"), resolve(dirname(abs), "group.yml")]) {
    if (!existsSync(manifest)) continue;
    try {
      const parsed = GroupFileSchema.safeParse(parseYaml(readFileSync(manifest, "utf8")));
      if (!parsed.success) continue;
      const dir = dirname(manifest);
      const listed = parsed.data.services.some((s) => resolve(dir, s.file) === abs);
      if (listed) return parsed.data.group;
    } catch {
      // A malformed manifest is not an inference failure; fall through.
    }
  }
  return undefined;
}

export interface GroupMember {
  /** Identity inside the group; must equal the member file's `service`. */
  name: string;
  /** Absolute path to the member's deploy.yml/accessory.yml. */
  file: string;
  /** In-group dependency names (default: none). */
  needs: string[];
  /** Fully-loaded config, with `group` already set. */
  loaded: LoadedConfig;
}

export interface LoadedGroup {
  group: string;
  path: string;
  dir: string;
  /** Manifest order; use topoSortMembers() for install order. */
  members: GroupMember[];
}

/** Parse and load a group manifest plus every member file it names. */
export function loadGroup(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LoadedGroup {
  const abs = resolve(path);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError("cannot read group.yml at " + abs + ": " + (e as Error).message);
  }
  const parsed = GroupFileSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error).map((i) => i.field + ": " + i.message).join("; ");
    throw new ConfigError("invalid group.yml (" + abs + "): " + issues);
  }

  const dir = dirname(abs);
  const names = new Set<string>();
  for (const s of parsed.data.services) {
    if (names.has(s.name)) {
      throw new ConfigError("invalid group.yml (" + abs + "): duplicate member '" + s.name + "'");
    }
    names.add(s.name);
  }

  const members: GroupMember[] = parsed.data.services.map((s) => {
    const file = resolve(dir, s.file);
    const loaded = loadConfig(file, env);
    if (loaded.config.service !== s.name) {
      throw new ConfigError(
        "invalid group.yml (" + abs + "): member '" + s.name + "' declares service '" +
          loaded.config.service + "' in " + file,
      );
    }
    loaded.config = { ...loaded.config, group: parsed.data.group };
    const needs = s.needs ?? [];
    for (const need of needs) {
      if (need === s.name) {
        throw new ConfigError(
          "invalid group.yml (" + abs + "): member '" + s.name + "' cannot need itself",
        );
      }
      if (!names.has(need)) {
        throw new ConfigError(
          "invalid group.yml (" + abs + "): member '" + s.name + "' needs unknown member '" +
            need + "'",
        );
      }
    }
    return { name: s.name, file, needs, loaded };
  });

  return { group: parsed.data.group, path: abs, dir, members };
}
