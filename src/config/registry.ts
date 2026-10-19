import type { z } from "zod";
import type { BundantConfig, LoadedConfig, RawConfig, ValidationIssue } from "./types.ts";
import { normalize, preflight, RawConfigSchema } from "./v1/deploy.ts";
import { GroupFileSchema } from "./v1/group.ts";
import { AccessorySchema } from "./v1/accessory.ts";
import { v1Grammar, type NameGrammar } from "./v1/grammar.ts";

/**
 * A version is a closed bundle: schema, grammar, defaults and preflight rules.
 * Adding v2 = a new src/config/v2 directory plus ONE entry here; nothing in
 * src/config/v1 changes.
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

export class ConfigVersionError extends Error {
  readonly field = "version";
  constructor(message: string) {
    super(message);
    this.name = "ConfigVersionError";
  }
}

export const v1Module: VersionModule = {
  version: 1,
  grammar: v1Grammar,
  deploySchema: RawConfigSchema,
  accessorySchema: AccessorySchema,
  groupSchema: GroupFileSchema,
  normalize,
  preflight: (loaded) => preflight(loaded, v1Grammar),
};

export interface VersionResolution {
  version: number;
  explicit: boolean;
  module: VersionModule;
}

export interface ResolveOptions {
  /** Missing version is an error instead of implicit v1. */
  strict?: boolean;
}

/**
 * Version -> module registry. The class (rather than a module-global map) is
 * what lets a test register a dummy v2 without mutating production state.
 */
export class ConfigRegistry {
  private readonly modules: Map<number, VersionModule>;

  constructor(modules: VersionModule[] = [v1Module]) {
    this.modules = new Map(modules.map((m) => [m.version, m]));
  }

  supported(): number[] {
    return [...this.modules.keys()].sort((a, b) => a - b);
  }

  /** Every registered module, for the versioned schema generator. */
  all(): VersionModule[] {
    return [...this.modules.values()].sort((a, b) => a.version - b.version);
  }

  resolve(doc: unknown, opts: ResolveOptions = {}): VersionResolution {
    const raw =
      typeof doc === "object" && doc !== null
        ? (doc as Record<string, unknown>).version
        : undefined;
    if (raw === undefined) {
      if (opts.strict === true) {
        throw new ConfigVersionError(
          'missing config version (strict mode): add "version: ' + this.supported()[0] +
            '" (supported: ' + this.supported().join(", ") + ")",
        );
      }
      return { version: 1, explicit: false, module: this.get(1) };
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

export const defaultRegistry = new ConfigRegistry();

/** Version module for an already-loaded file (defaults to implicit v1). */
export function moduleForVersion(version: number | undefined): VersionModule {
  return defaultRegistry.get(version ?? 1);
}
