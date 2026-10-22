import { z } from "zod";
import { ConfigError } from "../config/errors.ts";
import { DEFAULT_GROUP } from "../config/grammar.ts";
import { normalize } from "../config/deploy-base.ts";
import { zodIssues } from "../config/zod.ts";
import { RawConfigSchema } from "../config/v2/deploy.ts";
import { GroupCycleError, GroupError, topoSortMembers } from "../group.ts";
import { assertPreflight } from "../validation.ts";
import type { BundantConfig, GroupMember, LoadedConfig, RawConfig } from "../config/types.ts";
import { unitPath } from "../select/selector.ts";

/**
 * The SDK spec surface: deployments are TS values, not YAML files.
 *
 * Every builder validates at construction time by running the same v2 zod
 * schema, the same `normalize()` defaults and the same `assertPreflight()`
 * rules the YAML loader used - one contract, one set of error messages. A
 * spec carries the fully-normalized config, so operations never re-derive it.
 */

export interface SshInput {
  readonly user?: string;
  readonly port?: number;
  readonly identity?: string;
  readonly options?: readonly string[];
}

/** HTTP probe for services, raw TCP readiness for accessories (same fields as v2 YAML). */
export interface HealthcheckInput {
  readonly http?: { readonly path?: string; readonly port?: number };
  readonly tcp?: number;
  readonly timeout?: number;
}

export interface ProxyInput {
  readonly enabled?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly tls?: boolean;
  readonly image?: string;
}

interface BaseInput {
  /** Namespace; defaults to "default". */
  readonly group?: string;
  readonly image: string;
  /** SSH targets (`~/.ssh/config` names work as-is). Defaults to BUNDANT_HOSTS. */
  readonly hosts?: readonly string[];
  readonly ssh?: SshInput;
  readonly runtime?: "docker" | "podman";
  /** Inline KEY=VAL values. Values come from your code - bundant resolves no secrets (D3). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly healthcheck?: HealthcheckInput;
  /** Container port: fills proxy.port and the healthcheck port when they are not given. */
  readonly port?: number;
}

export interface DeploymentInput extends BaseInput {
  readonly service: string;
  readonly role?: string;
  /** Running copies per host; > 1 requires a proxy. */
  readonly replicas?: number;
  /** Omit for a proxy-less service (the SDK default is no proxy; YAML defaulted to enabled). */
  readonly proxy?: ProxyInput;
}

export interface AccessoryInput extends BaseInput {
  /** Member name inside the group; the container is named `<group>.<name>`. */
  readonly name: string;
  /** Named volumes as `{ name: "/path/in/container" }`; they survive recreation. */
  readonly volumes?: Readonly<Record<string, string>>;
}

/** A validated, fully-normalized unit. `loaded` is what operations consume. */
export interface ServiceSpec {
  readonly kind: "service";
  /** Addressable path: `<group>.<service>.<role>`. */
  readonly path: string;
  readonly group: string;
  readonly name: string;
  readonly loaded: LoadedConfig;
}

export interface AccessorySpec {
  readonly kind: "accessory";
  /** Addressable path: `<group>.<name>`. */
  readonly path: string;
  readonly group: string;
  readonly name: string;
  readonly loaded: LoadedConfig;
}

export type UnitSpec = ServiceSpec | AccessorySpec;

export interface GroupInput {
  readonly members: readonly UnitSpec[];
  /** Dependency edges by member name: `{ api: ["db"] }` installs db first. */
  readonly needs?: Readonly<Record<string, readonly string[]>>;
}

export interface GroupSpec {
  readonly kind: "group";
  readonly group: string;
  /** Keyed by member name, so `shop.members.api` is the spec. */
  readonly members: Readonly<Record<string, UnitSpec>>;
  readonly needs: Readonly<Record<string, readonly string[]>>;
  /** Topological install order (dependencies first). */
  readonly order: readonly string[];
}

function envHosts(): string[] {
  return (process.env.BUNDANT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

function hostsOf(input: BaseInput): string[] {
  const inline = input.hosts === undefined ? [] : [...input.hosts];
  return inline.length > 0 ? inline : envHosts();
}

function sshOf(ssh: SshInput | undefined): RawConfig["ssh"] {
  if (ssh === undefined) return undefined;
  return {
    user: ssh.user,
    port: ssh.port,
    identity: ssh.identity,
    options: ssh.options === undefined ? undefined : [...ssh.options],
  };
}

function envVars(env: BaseInput["env"]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      throw new ConfigError(
        "invalid SDK spec: env " + key +
          " is undefined - bundant resolves no secrets (D3); pass the value from your code",
      );
    }
    vars[key] = value;
  }
  return vars;
}

function invalid(error: z.ZodError): ConfigError {
  const issues = zodIssues(error).map((issue) => issue.field + ": " + issue.message).join("; ");
  return new ConfigError("invalid SDK spec: " + issues);
}

/** Build the LoadedConfig operations consume: same shape the YAML loader produced. */
function loadedFrom(raw: RawConfig, hosts: string[], group: string): LoadedConfig {
  const config: BundantConfig = { ...normalize(raw, hosts), group, version: 2 };
  const vars = Object.entries(config.env.vars);
  const envContent =
    vars.length > 0 ? vars.map(([key, value]) => key + "=" + value).join("\n") + "\n" : null;
  const loaded: LoadedConfig = {
    config,
    envContent,
    envCount: vars.length,
    // Specs are code, so the "config file" location is the process cwd; this is
    // what a bare `deploy` uses to resolve the git revision.
    path: process.cwd(),
    version: 2,
  };
  assertPreflight(loaded);
  return loaded;
}

export function defineDeployment(input: DeploymentInput): ServiceSpec {
  const group = input.group ?? DEFAULT_GROUP;
  const hosts = hostsOf(input);
  if (hosts.length === 0) {
    throw new ConfigError(
      "invalid SDK spec: hosts is empty - pass hosts or set BUNDANT_HOSTS",
    );
  }
  const proxyPort = input.proxy?.port ?? input.port;
  const raw: RawConfig = {
    version: 2,
    service: input.service,
    image: input.image,
    role: input.role,
    replicas: input.replicas,
    kind: "service",
    hosts,
    ssh: sshOf(input.ssh),
    runtime: input.runtime,
    env: { vars: envVars(input.env) },
    healthcheck: {
      path: input.healthcheck?.http?.path,
      port: input.healthcheck?.http?.port ?? input.port,
      timeout: input.healthcheck?.timeout,
      tcp: input.healthcheck?.tcp,
    },
    proxy: input.proxy === undefined
      ? { enabled: false }
      : {
        enabled: input.proxy.enabled ?? true,
        host: input.proxy.host,
        port: proxyPort,
        tls: input.proxy.tls,
        image: input.proxy.image,
      },
  };
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const loaded = loadedFrom(parsed.data as RawConfig, hosts, group);
  const role = loaded.config.role;
  return {
    kind: "service",
    group,
    name: loaded.config.service,
    path: unitPath({ group, service: loaded.config.service, role, kind: "service" }),
    loaded,
  };
}

export function defineAccessory(input: AccessoryInput): AccessorySpec {
  const group = input.group ?? DEFAULT_GROUP;
  const hosts = hostsOf(input);
  if (hosts.length === 0) {
    throw new ConfigError(
      "invalid SDK spec: hosts is empty - pass hosts or set BUNDANT_HOSTS",
    );
  }
  const volumes = Object.entries(input.volumes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, path]) => name + ":" + path);
  const raw = {
    version: 2,
    service: input.name,
    image: input.image,
    kind: "accessory",
    volumes,
    replicas: (input as AccessoryInput & { replicas?: number }).replicas,
    hosts,
    ssh: sshOf(input.ssh),
    runtime: input.runtime,
    env: { vars: envVars(input.env) },
    healthcheck: {
      path: input.healthcheck?.http?.path,
      port: input.healthcheck?.http?.port ?? input.port,
      timeout: input.healthcheck?.timeout,
      tcp: input.healthcheck?.tcp,
    },
    proxy: { enabled: false },
  } satisfies RawConfig;
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const loaded = loadedFrom(parsed.data as RawConfig, hosts, group);
  return {
    kind: "accessory",
    group,
    name: loaded.config.service,
    path: unitPath({ group, service: loaded.config.service, role: loaded.config.role, kind: "accessory" }),
    loaded,
  };
}

function asMember(spec: UnitSpec, needs: readonly string[]): GroupMember {
  return { name: spec.name, file: spec.path, needs: [...needs], loaded: spec.loaded };
}

export function defineGroup(input: GroupInput): GroupSpec {
  if (input.members.length === 0) {
    throw new ConfigError("invalid SDK group: members must not be empty");
  }
  const needs = input.needs ?? {};
  const byName = new Map<string, UnitSpec>();
  const group = input.members[0]!.group;
  for (const member of input.members) {
    if (byName.has(member.name)) {
      throw new ConfigError("invalid SDK group: duplicate member \"" + member.name + "\"");
    }
    if (member.group !== group) {
      throw new ConfigError(
        "invalid SDK group: member \"" + member.name + "\" belongs to group \"" +
          member.group + "\", not \"" + group + "\"",
      );
    }
    byName.set(member.name, member);
  }
  for (const [name, deps] of Object.entries(needs)) {
    if (!byName.has(name)) {
      throw new ConfigError("invalid SDK group: needs names unknown member \"" + name + "\"");
    }
    for (const dep of deps) {
      if (dep === name) {
        throw new ConfigError("invalid SDK group: member \"" + name + "\" cannot need itself");
      }
      if (!byName.has(dep)) {
        throw new ConfigError(
          "invalid SDK group: member \"" + name + "\" needs unknown member \"" + dep + "\"",
        );
      }
    }
  }
  const members = Object.fromEntries(
    [...byName].map(([name, spec]) => [name, spec]),
  ) as Record<string, UnitSpec>;
  let order: string[];
  try {
    order = topoSortMembers(
      [...byName].map(([name, spec]) => asMember(spec, needs[name] ?? [])),
    ).map((member) => member.name);
  } catch (error) {
    if (error instanceof GroupError || error instanceof GroupCycleError) {
      throw new ConfigError("invalid SDK group: " + error.message);
    }
    throw error;
  }
  return { kind: "group", group, members, needs, order };
}
