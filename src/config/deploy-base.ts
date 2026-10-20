import { z } from "zod";
import { PROXY_IMAGE } from "../commands/proxy.ts";
import type { RuntimeKind } from "../runtime.ts";
import { ConfigError } from "./errors.ts";
import { namedString, zodIssues } from "./zod.ts";
import type { BundantConfig, LoadedConfig, RawConfig, ValidationIssue } from "./types.ts";
import type { NameGrammar, NameIdentity } from "./grammar.ts";

export { namedString, zodIssues };

/** Shared config sections every schema version reuses. */
export const EnvSchema = z.object({
  file: z.string().describe("local KEY=VAL file (gitignored); uploaded to the host as mode 0600").optional(),
  vars: z
    .record(z.string())
    .describe("inline values; merged over file keys. Never printed by bundant")
    .optional(),
}).strict();

export const HealthSchema = z.object({
  path: z.string().regex(/^\/\S*$/, "must start with /").describe("HTTP path the gate probes (default /)").optional(),
  port: z.number().int().positive().describe("container port to probe (default proxy.port)").optional(),
  timeout: z.number().int().positive().describe("seconds before the gate gives up (default 30)").optional(),
  tcp: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe("accessory readiness: a bare TCP connect to this port must succeed")
    .optional(),
}).strict();

export const ProxySchema = z.object({
  enabled: z.boolean().describe("swap traffic at deploy (default true)").optional(),
  host: z.string().min(1).describe("Host header this service answers on (required when enabled)").optional(),
  port: z.number().int().positive().describe("container port kamal-proxy targets (default 80)").optional(),
  tls: z.boolean().describe("pass --tls to kamal-proxy (ACME certificates)").optional(),
  image: z.string().min(1).describe("proxy image override for air-gapped hosts").optional(),
}).strict();

export const SshSchema = z.object({
  user: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a plain ssh user name").describe("default login user; a per-host user@ wins").optional(),
  port: z.number().int().min(1).max(65535).describe("default port; a per-host :port wins").optional(),
  identity: z.string().min(1).describe("private key path; ~ is expanded").optional(),
  options: z.array(z.string()).describe('extra ssh flags, e.g. ["-o","StrictHostKeyChecking=accept-new"]').optional(),
}).strict();

export const SshFileSchema = SshSchema.extend({
  hosts: z.array(z.string().min(1)).describe("default host pool for deployments that reference this file").optional(),
}).strict();

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
      "invalid deploy.yml: replicas > 1 requires proxy.enabled: true - without a proxy nothing distributes traffic between the copies",
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
    ssh: typeof raw.ssh === "object" ? raw.ssh ?? {} : {},
    runtime: (raw.runtime ?? "docker") as RuntimeKind,
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

/** Cross-field rules shared by every version; the grammar supplies the names. */
export function preflight(loaded: LoadedConfig, grammar: NameGrammar): ValidationIssue[] {
  const config = loaded.config;
  const errors: ValidationIssue[] = [];
  const group = config.group ?? grammar.defaultGroup;

  if (!grammar.service.test(config.service)) {
    errors.push({ field: "service", message: 'service "' + config.service + '" is not a valid service name' });
  }
  if (!grammar.group.test(group)) {
    errors.push({ field: "group", message: 'group "' + group + '" is not a valid group name' });
  }
  if (!grammar.role.test(config.role)) {
    errors.push({ field: "role", message: 'role "' + config.role + '" is not a valid role name' });
  }
  if (config.image.trim() === "") errors.push({ field: "image", message: "image must not be empty" });
  if (config.hosts.length === 0) {
    errors.push({ field: "hosts", message: "hosts must not be empty (set it here or in the referenced ssh file)" });
  }
  if (config.proxy.enabled && (config.proxy.host === undefined || config.proxy.host === "")) {
    errors.push({ field: "proxy.host", message: "proxy.host is required when proxy.enabled is true" });
  }
  if (!config.healthcheck.path.startsWith("/")) {
    errors.push({ field: "healthcheck.path", message: "healthcheck.path must start with /" });
  }
  if (config.healthcheck.timeout <= 0) {
    errors.push({ field: "healthcheck.timeout", message: "healthcheck.timeout must be > 0" });
  }
  if (config.healthcheck.port < 1 || config.healthcheck.port > 65535) {
    errors.push({ field: "healthcheck.port", message: "healthcheck.port must be 1..65535" });
  }
  const tcp = config.healthcheck.tcp;
  if (tcp !== undefined && (tcp < 1 || tcp > 65535)) {
    errors.push({ field: "healthcheck.tcp", message: "healthcheck.tcp must be 1..65535" });
  }
  if (config.kind === "accessory") {
    if (config.replicas !== 1) {
      errors.push({ field: "replicas", message: "replicas is not allowed on kind: accessory" });
    }
    if (config.proxy.enabled) {
      errors.push({ field: "proxy", message: "proxy is not allowed on kind: accessory (set proxy.enabled: false)" });
    }
  }
  if (config.replicas > 1 && !config.proxy.enabled) {
    errors.push({ field: "replicas", message: "replicas > 1 requires proxy.enabled: true" });
  }

  if (config.kind !== "accessory") {
    const identity: NameIdentity = {
      group,
      service: config.service,
      role: config.role,
      revision: "r0",
      replica: config.replicas > 1 ? 1 : undefined,
    };
    if (
      grammar.service.test(config.service) &&
      grammar.role.test(config.role) &&
      grammar.group.test(group) &&
      !grammar.roundTrips(identity)
    ) {
      errors.push({
        field: "name",
        message:
          'composed name "' + grammar.compose(identity) +
          '" does not round-trip to the declared identity',
      });
    }
  }
  return errors;
}
