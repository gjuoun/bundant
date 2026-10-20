import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ConfigError } from "./config/errors.ts";
import {
  ConfigVersionError,
  defaultRegistry,
  moduleForVersion,
  type ConfigRegistry,
  type VersionModule,
} from "./config/registry.ts";
import {
  RawConfigSchema,
  SshFileSchema,
  SshSchema,
  namedString,
  normalize,
  zodIssues,
} from "./config/v1/deploy.ts";
import { GroupFileSchema, GroupServiceSchema } from "./config/v1/group.ts";
import {
  DEFAULT_GROUP,
  GROUP_NAME_RE,
  REVISION_RE,
  ROLE_NAME_RE,
  SEGMENT_NAME_RULE,
  SERVICE_NAME_RE,
  SERVICE_NAME_RULE,
} from "./config/v1/grammar.ts";
import type {
  BundantConfig,
  GroupMember,
  LoadedConfig,
  LoadedGroup,
  RawConfig,
  ValidationIssue,
} from "./config/types.ts";

export {
  ConfigRegistry,
  ConfigVersionError,
  defaultRegistry,
  moduleForVersion,
  v1Module,
  v2Module,
  type VersionModule,
} from "./config/registry.ts";

export { ConfigError } from "./config/errors.ts";

export {
  DEFAULT_GROUP,
  GROUP_NAME_RE,
  REVISION_RE,
  ROLE_NAME_RE,
  SEGMENT_NAME_RULE,
  SERVICE_NAME_RE,
  SERVICE_NAME_RULE,
} from "./config/v1/grammar.ts";

export {
  RawConfigSchema,
  SshFileSchema,
  SshSchema,
  namedString,
  normalize,
  zodIssues,
} from "./config/v1/deploy.ts";
export { GroupFileSchema, GroupServiceSchema } from "./config/v1/group.ts";
export { AccessorySchema } from "./config/v1/accessory.ts";
export type { GroupFile } from "./config/v1/group.ts";

export type {
  BundantConfig,
  GroupMember,
  LoadedConfig,
  LoadedGroup,
  RawConfig,
  ValidationIssue,
} from "./config/types.ts";

/** Historical alias: every config name used to share one grammar. */
export const NAME_RE = SERVICE_NAME_RE;

export interface ConfigIssue {
  field: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ConfigIssue[] {
  return zodIssues(error);
}

function versionError(file: string, abs: string, e: ConfigVersionError): ConfigVersionError {
  return new ConfigVersionError("invalid " + file + " (" + abs + "): version: " + e.message);
}

/** Injectable loading context: tests can supply a registry with a dummy v2. */
export interface LoadOptions {
  env?: Record<string, string | undefined>;
  registry?: ConfigRegistry;
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
 * Resolve 'ssh:' into defaults plus an optional host pool: inline mapping, or a
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

export function loadConfig(path: string, options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const registry = options.registry ?? defaultRegistry;
  const abs = resolve(path);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError("cannot read deploy.yml at " + abs + ": " + (e as Error).message);
  }

  let resolved;
  try {
    resolved = registry.resolve(doc);
  } catch (e) {
    if (e instanceof ConfigVersionError) throw versionError("deploy.yml", abs, e);
    throw e;
  }
  // Resolve through the same injectable function the rest of the code uses.
  const module: VersionModule = moduleForVersion(resolved.version, registry);
  const parsed = module.deploySchema.safeParse(doc);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error).map((i) => i.field + ": " + i.message).join("; ");
    throw new ConfigError("invalid deploy.yml (" + abs + "): " + issues);
  }
  const raw = parsed.data as RawConfig;
  const { sshDefaults, fileHosts } = resolveSshBlock(raw.ssh, dirname(abs));
  const hosts = raw.hosts ?? fileHosts;
  if (!hosts || hosts.length === 0) {
    throw new ConfigError(
      "invalid deploy.yml (" + abs + "): hosts is required (set it here or in the referenced ssh file)",
    );
  }
  const merged: RawConfig = { ...raw, hosts, ssh: sshDefaults };
  let config = {
    ...module.normalize(merged, hosts),
    group: DEFAULT_GROUP,
    version: resolved.version,
  };
  const inferredGroup = inferGroupForMember(abs);
  if (inferredGroup !== undefined) config = { ...config, group: inferredGroup };

  const override = env.BUNDANT_HOSTS;
  if (override !== undefined && override.trim() !== "") {
    const overrideHosts = override.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (overrideHosts.length === 0) throw new ConfigError("BUNDANT_HOSTS is set but empty");
    config = { ...config, hosts: overrideHosts };
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

  return { config, envContent, envCount: entries.size, path: abs, version: resolved.version };
}

/**
 * '<group>/<member>/deploy.yml' -> the group named by '<group>/group.yml',
 * only when that manifest actually lists this file. Undefined otherwise.
 */
export function inferGroupForMember(path: string): string | undefined {
  const abs = resolve(path);
  for (const manifest of [resolve(dirname(dirname(abs)), "group.yml"), resolve(dirname(abs), "group.yml")]) {
    if (!existsSync(manifest)) continue;
    try {
      const doc = parseYaml(readFileSync(manifest, "utf8"));
      const resolved = defaultRegistry.resolve(doc);
      const parsed = resolved.module.groupSchema.safeParse(doc);
      if (!parsed.success) continue;
      const data = parsed.data as z.infer<typeof GroupFileSchema>;
      const dir = dirname(manifest);
      const listed = data.services.some((s) => resolve(dir, s.file) === abs);
      if (listed) return data.group;
    } catch {
      // A malformed manifest is not an inference failure; fall through.
    }
  }
  return undefined;
}

/** Parse and load a group manifest plus every member file it names. */
export function loadGroup(path: string, options: LoadOptions = {}): LoadedGroup {
  const env = options.env ?? process.env;
  const registry = options.registry ?? defaultRegistry;
  const abs = resolve(path);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError("cannot read group.yml at " + abs + ": " + (e as Error).message);
  }

  let resolved;
  try {
    resolved = registry.resolve(doc);
  } catch (e) {
    if (e instanceof ConfigVersionError) throw versionError("group.yml", abs, e);
    throw e;
  }
  const module: VersionModule = moduleForVersion(resolved.version, registry);
  const parsed = module.groupSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error).map((i) => i.field + ": " + i.message).join("; ");
    throw new ConfigError("invalid group.yml (" + abs + "): " + issues);
  }
  const groupFile = parsed.data as z.infer<typeof GroupFileSchema>;

  const dir = dirname(abs);
  const names = new Set<string>();
  for (const s of groupFile.services) {
    if (names.has(s.name)) {
      throw new ConfigError("invalid group.yml (" + abs + "): duplicate member '" + s.name + "'");
    }
    names.add(s.name);
  }

  const members: GroupMember[] = groupFile.services.map((s) => {
    const file = resolve(dir, s.file);
    const loaded = loadConfig(file, { env, registry });
    if (loaded.config.service !== s.name) {
      throw new ConfigError(
        "invalid group.yml (" + abs + "): member '" + s.name + "' declares service '" +
          loaded.config.service + "' in " + file,
      );
    }
    loaded.config = { ...loaded.config, group: groupFile.group };
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

  return { group: groupFile.group, path: abs, dir, version: resolved.version, members };
}
