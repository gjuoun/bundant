import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ConfigError,
  ConfigVersionError,
  DEFAULT_GROUP,
  defaultRegistry,
  loadConfig,
  loadGroup,
  moduleForVersion,
  zodIssues,
  type ConfigRegistry,
  type GroupMember,
  type LoadedConfig,
  type LoadedGroup,
  type ValidationIssue,
  type VersionModule,
} from "./config.ts";
import type { NameGrammar, NameIdentity } from "./config/grammar.ts";
import { ServiceIdentity } from "./domain/identity.ts";
import { resolveRevision } from "./revision.ts";

export type { ValidationIssue } from "./config.ts";

export interface ServiceIdentityView {
  kind: "service" | "accessory";
  group: string;
  service: string;
  role?: string;
  composedName: string;
  containerNamePattern: string;
  proxyId?: string;
  envPath?: string;
  lockKey: string;
  revision: string;
  revisionSource: string;
  roundTrip: boolean;
  replicas: number;
}

export interface GroupIdentity {
  kind: "group";
  group: string;
  lockKey: string;
  revision: string;
  revisionSource: string;
  order: string[];
  members: ServiceIdentityView[];
}

export type ValidationIdentity = ServiceIdentityView | GroupIdentity;

export interface ValidationReport {
  ok: boolean;
  version?: number;
  versionExplicit?: boolean;
  notes: string[];
  errors: ValidationIssue[];
  identity?: ValidationIdentity;
}

export interface ValidateOptions {
  /** Missing version is always an error. */
  strict?: boolean;
  /** Test seam: an isolated registry (e.g. with a dummy v2). */
  registry?: ConfigRegistry;
}

export class PreflightError extends Error {
  readonly errors: ValidationIssue[];
  constructor(errors: ValidationIssue[]) {
    super(errors.map((e) => e.field + ": " + e.message).join("; "));
    this.name = "PreflightError";
    this.errors = errors;
  }
}

function issue(field: string, message: string): ValidationIssue {
  return { field, message };
}

/** The revision rule also comes from the resolved version's grammar. */
export function validateRevision(
  revision: string,
  grammar: NameGrammar = moduleForVersion(undefined).grammar,
): ValidationIssue | null {
  if (grammar.revision.test(revision)) return null;
  return issue("revision", 'revision "' + revision + '" ' + grammar.segmentRule);
}

/** The identity a config resolves to once defaults are applied. */
export function buildServiceIdentity(
  loaded: LoadedConfig,
  revision: string,
  revisionSource: string,
  grammar: NameGrammar = moduleForVersion(loaded.version).grammar,
): ServiceIdentityView {
  const config = loaded.config;
  const identity = ServiceIdentity.from(config, grammar, revision);
  const group = identity.group === "" ? grammar.defaultGroup : identity.group;
  const replicas = identity.replicas;
  const composed = identity.containerName(replicas > 1 ? 1 : undefined);
  const base = identity.compose();

  let roundTrip = false;
  if (identity.kind === "accessory") {
    if (grammar.accessoryCompose !== undefined) {
      try {
        const parsed = grammar.parse(composed, group);
        const kind = (parsed as { kind?: string }).kind;
        roundTrip = kind === "accessory" && parsed.service === config.service;
      } catch {
        roundTrip = false;
      }
    } else {
      roundTrip = grammar.group.test(identity.group) && grammar.service.test(identity.service);
    }
  } else {
    try {
      const parsed = grammar.parse(composed, group);
      roundTrip =
        (parsed.group ?? grammar.defaultGroup) === group &&
        parsed.service === config.service &&
        parsed.role === config.role &&
        parsed.revision === revision;
    } catch {
      roundTrip = false;
    }
  }

  return {
    kind: identity.kind,
    group,
    service: config.service,
    role: config.role,
    composedName: composed,
    containerNamePattern:
      replicas > 1 ? base + (grammar.replicaSeparator ?? "-") + "<i>" : composed,
    proxyId: config.proxy.enabled ? identity.proxyId() : undefined,
    envPath: identity.envPath(),
    lockKey: identity.lockKey(),
    revision,
    revisionSource,
    roundTrip,
    replicas,
  };
}

/** Cross-field rules of the file's declared version. */
export function collectLoadedIssues(
  loaded: LoadedConfig,
  module: VersionModule = moduleForVersion(loaded.version),
): ValidationIssue[] {
  return module.preflight(loaded);
}

/** Throw unless the fully-loaded config is valid. No host is contacted. */
export function assertPreflight(loaded: LoadedConfig, revision = "r0"): void {
  const module = moduleForVersion(loaded.version);
  const errors = module.preflight(loaded);
  const identity = buildServiceIdentity(loaded, revision, "preflight", module.grammar);
  if (!identity.roundTrip) {
    errors.push(issue("name", "composed name does not round-trip to the declared identity"));
  }
  if (errors.length > 0) throw new PreflightError(errors);
}

function detectCycle(members: GroupMember[]): string | undefined {
  const byName = new Map(members.map((m) => [m.name, m]));
  const state = new Map<string, 0 | 1 | 2>();
  let cycle: string | undefined;
  const visit = (m: GroupMember): void => {
    if (cycle !== undefined) return;
    const s = state.get(m.name) ?? 0;
    if (s === 1) {
      cycle = m.name;
      return;
    }
    if (s === 2) return;
    state.set(m.name, 1);
    for (const need of m.needs) {
      const dep = byName.get(need);
      if (dep) visit(dep);
    }
    state.set(m.name, 2);
  };
  for (const m of members) visit(m);
  return cycle;
}

function topoOrder(members: GroupMember[]): string[] {
  const byName = new Map(members.map((m) => [m.name, m]));
  const state = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];
  const visit = (m: GroupMember): void => {
    const s = state.get(m.name) ?? 0;
    if (s === 2) return;
    if (s === 1) return;
    state.set(m.name, 1);
    for (const need of m.needs) {
      const dep = byName.get(need);
      if (dep) visit(dep);
    }
    state.set(m.name, 2);
    order.push(m.name);
  };
  for (const m of members) visit(m);
  return order;
}

/** Validate a whole group before any group mutation. */
export function assertGroupPreflight(group: LoadedGroup): void {
  const module = moduleForVersion(group.version);
  const errors: ValidationIssue[] = [];
  if (!module.grammar.group.test(group.group)) {
    errors.push(issue("group", 'group "' + group.group + '" is not a valid group name'));
  }
  const cycle = detectCycle(group.members);
  if (cycle !== undefined) {
    errors.push(issue("services", "dependency cycle through '" + cycle + "'"));
  }
  for (const member of group.members) {
    for (const e of collectLoadedIssues(member.loaded)) {
      errors.push(issue("services." + member.name + "." + e.field, e.message));
    }
  }
  if (errors.length > 0) throw new PreflightError(errors);
}

/** The gate commands use before creating an executor: validate, then open. */
export function preflightGate<T>(loaded: LoadedConfig, open: () => T): T {
  assertPreflight(loaded);
  return open();
}

function dedupe(errors: ValidationIssue[]): ValidationIssue[] {
  const byField = new Map<string, ValidationIssue>();
  for (const e of errors) byField.set(e.field, e);
  return [...byField.values()];
}

function errorField(e: ConfigError): string {
  const match = /(?:^|\s)([A-Za-z0-9_.]+)\s*:/.exec(e.message);
  return match ? match[1]! : "config";
}

async function revisionFor(dir: string): Promise<{ revision: string; source: string }> {
  const revision = await resolveRevision(dir);
  return { revision, source: "git short sha of " + dir };
}

function versionNote(version: number, explicit: boolean): string[] {
  return explicit ? [] : ['version: ' + version + ' (implicit - add "version: ' + version + '" to pin it)'];
}

/** Validate one deploy.yml/accessory.yml/group.yml without touching a host. */
export async function validatePath(
  path: string,
  env: Record<string, string | undefined> = process.env,
  opts: ValidateOptions = {},
): Promise<ValidationReport> {
  const abs = resolve(path);
  const registry = opts.registry ?? defaultRegistry;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(abs, "utf8"));
  } catch (e) {
    return { ok: false, notes: [], errors: [issue("file", "cannot read " + abs + ": " + (e as Error).message)] };
  }

  let resolved;
  try {
    resolved = registry.resolve(doc);
  } catch (e) {
    if (e instanceof ConfigVersionError) {
      return {
        ok: false,
        notes: [],
        errors: [issue(e.field, e.message)],
      };
    }
    throw e;
  }

  const isGroup =
    typeof doc === "object" && doc !== null && Array.isArray((doc as Record<string, unknown>).services);
  return isGroup
    ? await validateGroup(abs, doc, env, resolved.version, resolved.explicit, resolved.module, registry)
    : await validateDeploy(abs, doc, env, resolved.version, resolved.explicit, resolved.module, registry);
}

async function validateDeploy(
  abs: string,
  doc: unknown,
  env: Record<string, string | undefined>,
  version: number,
  explicit: boolean,
  module: VersionModule,
  registry: ConfigRegistry,
): Promise<ValidationReport> {
  const notes = versionNote(version, explicit);
  const errors: ValidationIssue[] = [];
  const kind = typeof doc === "object" && doc !== null
    ? (doc as Record<string, unknown>).kind
    : undefined;
  const schema = kind === "accessory" ? module.accessorySchema : module.deploySchema;
  const parsed = schema.safeParse(doc);
  if (!parsed.success) errors.push(...zodIssues(parsed.error));
  const rev = await revisionFor(dirname(abs));
  let loaded: LoadedConfig | undefined;
  if (parsed.success) {
    try {
      loaded = loadConfig(abs, { env, registry });
    } catch (e) {
      if (e instanceof ConfigError) errors.push(issue(errorField(e), e.message));
      else throw e;
    }
  }
  if (loaded !== undefined) errors.push(...collectLoadedIssues(loaded, module));
  const unique = dedupe(errors);
  if (loaded === undefined || unique.length > 0) {
    return { ok: false, version, versionExplicit: explicit, notes, errors: unique };
  }
  const identity = buildServiceIdentity(loaded, rev.revision, rev.source, module.grammar);
  if (!identity.roundTrip) {
    unique.push(issue("name", "composed name does not round-trip to the declared identity"));
  }
  return {
    ok: unique.length === 0,
    version,
    versionExplicit: explicit,
    notes,
    errors: unique,
    identity,
  };
}

async function validateGroup(
  abs: string,
  doc: unknown,
  env: Record<string, string | undefined>,
  version: number,
  explicit: boolean,
  module: VersionModule,
  registry: ConfigRegistry,
): Promise<ValidationReport> {
  const notes = versionNote(version, explicit);
  const errors: ValidationIssue[] = [];
  const parsed = module.groupSchema.safeParse(doc);
  if (!parsed.success) errors.push(...zodIssues(parsed.error));
  const rev = await revisionFor(dirname(abs));
  let group: LoadedGroup | undefined;
  if (parsed.success) {
    try {
      group = loadGroup(abs, { env, registry });
    } catch (e) {
      if (e instanceof ConfigError) errors.push(issue(errorField(e), e.message));
      else throw e;
    }
  }
  if (group !== undefined) {
    const cycle = detectCycle(group.members);
    if (cycle !== undefined) {
      errors.push(issue("services", "dependency cycle through '" + cycle + "'"));
    }
    for (const member of group.members) {
      // Each member file declares its own version, independent of the manifest.
      errors.push(
        ...collectLoadedIssues(member.loaded, moduleForVersion(member.loaded.version, registry)),
      );
    }
  }
  const unique = dedupe(errors);
  if (group === undefined || unique.length > 0) {
    return { ok: false, version, versionExplicit: explicit, notes, errors: unique };
  }
  const identity: GroupIdentity = {
    kind: "group",
    group: group.group,
    lockKey: group.group,
    revision: rev.revision,
    revisionSource: rev.source,
    order: topoOrder(group.members),
    members: group.members.map((m) =>
      buildServiceIdentity(
        m.loaded,
        rev.revision,
        rev.source,
        moduleForVersion(m.loaded.version, registry).grammar,
      ),
    ),
  };
  return { ok: true, version, versionExplicit: explicit, notes, errors: [], identity };
}

/** Human-readable report for 'bundant validate'. */
export function renderValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  if (!report.ok) {
    lines.push("bundant validate: FAILED (" + report.errors.length + " error(s))");
    if (report.version !== undefined) {
      lines.push(
        "  version: " + report.version +
          (report.notes.length > 0 ? " (implicit - add \"version: " + report.version + "\" to pin it)" : ""),
      );
    }
    for (const e of report.errors) lines.push("  - " + e.field + ": " + e.message);
    return lines.join("\n");
  }
  lines.push("bundant validate: OK");
  if (report.version !== undefined) {
    lines.push(
      "  version: " + report.version +
        (report.notes.length > 0 ? " (implicit - add \"version: " + report.version + "\" to pin it)" : ""),
    );
  }
  const id = report.identity;
  if (id === undefined) return lines.join("\n");
  if (id.kind === "group") {
    lines.push("  group: " + id.group);
    lines.push("  revision: " + id.revision + " (" + id.revisionSource + ")");
    lines.push("  order: " + id.order.join(" -> "));
    for (const m of id.members) {
      lines.push("  member " + m.service + ": " + m.composedName + " round-trip=" + m.roundTrip);
    }
    return lines.join("\n");
  }
  lines.push("  group: " + id.group);
  lines.push("  service: " + id.service);
  if (id.role !== undefined) lines.push("  role: " + id.role);
  lines.push("  revision: " + id.revision + " (" + id.revisionSource + ")");
  lines.push("  container: " + id.containerNamePattern);
  if (id.proxyId !== undefined) lines.push("  proxy id: " + id.proxyId);
  if (id.envPath !== undefined) lines.push("  env path: " + id.envPath);
  lines.push("  lock key: " + id.lockKey);
  lines.push("  round-trip: " + (id.roundTrip ? "ok" : "FAILED"));
  return lines.join("\n");
}
