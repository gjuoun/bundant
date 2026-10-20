import type { z } from "zod";
import { ConfigError } from "./errors.ts";
import type { BundantConfig, LoadedConfig, RawConfig, ValidationIssue } from "./types.ts";
import type { NameGrammar } from "./grammar.ts";
import { v2Grammar } from "./v2/grammar.ts";
import { RawConfigSchema as RawConfigSchemaV2, normalize as normalizeV2, preflight as preflightV2 } from "./v2/deploy.ts";
import { GroupFileSchema as GroupFileSchemaV2 } from "./v2/group.ts";
import { AccessorySchema as AccessorySchemaV2 } from "./v2/accessory.ts";

/**
 * A version is a closed bundle: schema, grammar, defaults and preflight rules.
 * Adding version 3 = a new src/config/v3 directory plus ONE entry here; nothing
 * in src/config/v2 changes.
 */
export interface VersionModule {
  version: number;
  grammar: NameGrammar;
  deploySchema: z.ZodTypeAny;
  accessorySchema: z.ZodTypeAny;
  groupSchema: z.ZodTypeAny;
  normalize(raw: RawConfig, hosts?: string[]): BundantConfig;
  preflight(loaded: LoadedConfig): ValidationIssue[];
}

export class ConfigVersionError extends ConfigError {
  readonly field = "version";
  constructor(message: string) {
    super(message);
    this.name = "ConfigVersionError";
  }
}

export interface VersionResolution {
  version: number;
  explicit: boolean;
  module: VersionModule;
}

/**
 * Version -> module registry. The class (rather than a module-global map) is
 * what lets a test register a dummy module without mutating production state.
 */
export class ConfigRegistry {
  private readonly modules: Map<number, VersionModule>;

  constructor(modules: VersionModule[] = [v2Module]) {
    this.modules = new Map(modules.map((m) => [m.version, m]));
  }

  supported(): number[] {
    return [...this.modules.keys()].sort((a, b) => a - b);
  }

  /** Every registered module, for the versioned schema generator. */
  all(): VersionModule[] {
    return [...this.modules.values()].sort((a, b) => a.version - b.version);
  }

  resolve(doc: unknown): VersionResolution {
    const raw =
      typeof doc === "object" && doc !== null
        ? (doc as Record<string, unknown>).version
        : undefined;
    if (raw === undefined) {
      throw new ConfigVersionError(
        'missing config version: add "version: ' + this.supported()[0] +
          '" (supported: ' + this.supported().join(", ") + ")",
      );
    }
    const version = typeof raw === "number" && Number.isInteger(raw) ? raw : null;
    if (version === null || !this.modules.has(version)) {
      throw new ConfigVersionError(
        "unsupported config version " + JSON.stringify(raw) +
          " (supported: " + this.supported().join(", ") + ")",
      );
    }
    return { version, explicit: true, module: this.get(version) };
  }

  get(version: number): VersionModule {
    const found = this.modules.get(version);
    if (found === undefined) {
      throw new ConfigVersionError(
        "unsupported config version " + JSON.stringify(version) +
          " (supported: " + this.supported().join(", ") + ")",
      );
    }
    return found;
  }
}

export const v2Module: VersionModule = {
  version: 2,
  grammar: v2Grammar,
  deploySchema: RawConfigSchemaV2,
  accessorySchema: AccessorySchemaV2,
  groupSchema: GroupFileSchemaV2,
  normalize: (raw, hosts) => normalizeV2(raw, hosts),
  preflight: (loaded) => preflightV2(loaded, v2Grammar),
};

export const defaultRegistry = new ConfigRegistry([v2Module]);

/**
 * Version module for an already-loaded file.
 * The registry is injectable so a caller/test can exercise a non-production
 * registry through the same resolution path the loaders use.
 */
export function moduleForVersion(
  version: number | undefined,
  registry: ConfigRegistry = defaultRegistry,
): VersionModule {
  return registry.get(version ?? v2Module.version);
}
