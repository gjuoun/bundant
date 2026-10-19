import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_GROUP,
  GROUP_NAME_RE,
  ROLE_NAME_RE,
  SERVICE_NAME_RE,
  ConfigError,
  GroupFileSchema,
  RawConfigSchema,
  loadConfig,
  loadGroup,
  zodIssues,
  type GroupMember,
  type LoadedConfig,
  type LoadedGroup,
} from "./config.ts";
import {
  REVISION_RE,
  SEGMENT_NAME_RULE,
  composeContainerName,
  parseContainerName,
  roundTrips,
  type NameIdentity,
} from "./name-grammar.ts";
import { serviceId } from "./commands/proxy.ts";
import { envRemotePath } from "./planner.ts";
import { lockKey } from "./lock.ts";
import { resolveRevision } from "./revision.ts";

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ServiceIdentity {
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
  members: ServiceIdentity[];
}

export type ValidationIdentity = ServiceIdentity | GroupIdentity;

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  identity?: ValidationIdentity;
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

/** The revision is not a config field; --rev and the fallback go through here. */
export function validateRevision(revision: string): ValidationIssue | null {
  if (REVISION_RE.test(revision)) return null;
  return issue("revision", 'revision "' + revision + '" ' + SEGMENT_NAME_RULE);
}

function safeParse(name: string, group: string): NameIdentity | null {
  try {
    return parseContainerName(name, group);
  } catch {
    return null;
  }
}

/** The identity a config resolves to once defaults are applied. */
export function buildServiceIdentity(
  loaded: LoadedConfig,
  revision: string,
  revisionSource: string,
): ServiceIdentity {
  const config = loaded.config;
  const group = config.group ?? DEFAULT_GROUP;
  const kind = config.kind ?? "service";
  const role = config.role;
  const replicas = Math.max(1, config.replicas ?? 1);

  if (kind === "accessory") {
    const composed = group === DEFAULT_GROUP ? config.service : group + "-" + config.service;
    const service = group === DEFAULT_GROUP ? composed : composed.slice(group.length + 1);
    return {
      kind,
      group,
      service: config.service,
      composedName: composed,
      containerNamePattern: composed,
      lockKey: lockKey(config.group, config.service),
      revision,
      revisionSource,
      roundTrip: GROUP_NAME_RE.test(group) && SERVICE_NAME_RE.test(service),
      replicas: 1,
    };
  }

  const identity: NameIdentity = {
    group,
    service: config.service,
    role,
    revision,
    replica: replicas > 1 ? 1 : undefined,
  };
  const composed = composeContainerName(identity);
  const base = composeContainerName({ ...identity, replica: undefined });
  const parsed = safeParse(composed, group);
  const roundTrip =
    parsed !== null &&
    (parsed.group ?? DEFAULT_GROUP) === group &&
    parsed.service === config.service &&
    parsed.role === role &&
    parsed.revision === revision;

  return {
    kind,
    group,
    service: config.service,
    role,
    composedName: composed,
    containerNamePattern: replicas > 1 ? base + "-<i>" : composed,
    proxyId: config.proxy.enabled ? serviceId(config.service, role, config.group) : undefined,
    envPath: envRemotePath(config),
    lockKey: lockKey(config.group, config.service),
    revision,
    revisionSource,
    roundTrip,
    replicas,
  };
}

/** Every cross-field rule that is not expressible as a single zod field. */
export function collectLoadedIssues(loaded: LoadedConfig): ValidationIssue[] {
  const config = loaded.config;
  const errors: ValidationIssue[] = [];
  const group = config.group ?? DEFAULT_GROUP;

  if (!SERVICE_NAME_RE.test(config.service)) {
    errors.push(issue("service", 'service "' + config.service + '" is not a valid service name'));
  }
  if (!GROUP_NAME_RE.test(group)) {
    errors.push(issue("group", 'group "' + group + '" is not a valid group name'));
  }
  if (!ROLE_NAME_RE.test(config.role)) {
    errors.push(issue("role", 'role "' + config.role + '" is not a valid role name'));
  }
  if (config.image.trim() === "") errors.push(issue("image", "image must not be empty"));
  if (config.hosts.length === 0) {
    errors.push(issue("hosts", "hosts must not be empty (set it here or in the referenced ssh file)"));
  }
  if (config.proxy.enabled && (config.proxy.host === undefined || config.proxy.host === "")) {
    errors.push(issue("proxy.host", "proxy.host is required when proxy.enabled is true"));
  }
  if (!config.healthcheck.path.startsWith("/")) {
    errors.push(issue("healthcheck.path", "healthcheck.path must start with /"));
  }
  if (config.healthcheck.timeout <= 0) {
    errors.push(issue("healthcheck.timeout", "healthcheck.timeout must be > 0"));
  }
  if (config.healthcheck.port < 1 || config.healthcheck.port > 65535) {
    errors.push(issue("healthcheck.port", "healthcheck.port must be 1..65535"));
  }
  const tcp = config.healthcheck.tcp;
  if (tcp !== undefined && (tcp < 1 || tcp > 65535)) {
    errors.push(issue("healthcheck.tcp", "healthcheck.tcp must be 1..65535"));
  }
  if (config.kind === "accessory") {
    if (config.replicas !== 1) {
      errors.push(issue("replicas", "replicas is not allowed on kind: accessory"));
    }
    if (config.proxy.enabled) {
      errors.push(issue("proxy", "proxy is not allowed on kind: accessory (set proxy.enabled: false)"));
    }
  }
  if (config.replicas > 1 && !config.proxy.enabled) {
    errors.push(issue("replicas", "replicas > 1 requires proxy.enabled: true"));
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
      SERVICE_NAME_RE.test(config.service) &&
      ROLE_NAME_RE.test(config.role) &&
      GROUP_NAME_RE.test(group) &&
      !roundTrips(identity)
    ) {
      errors.push(
        issue(
          "name",
          'composed name "' + composeContainerName(identity) +
            '" does not round-trip to the declared identity',
        ),
      );
    }
  }
  return errors;
}

/** Throw unless the fully-loaded config is valid. No host is contacted. */
export function assertPreflight(loaded: LoadedConfig, revision = "r0"): void {
  const errors = collectLoadedIssues(loaded);
  const identity = buildServiceIdentity(loaded, revision, "preflight");
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
  const errors: ValidationIssue[] = [];
  if (!GROUP_NAME_RE.test(group.group)) {
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

/** Validate one deploy.yml/accessory.yml/group.yml without touching a host. */
export async function validatePath(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ValidationReport> {
  const abs = resolve(path);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(abs, "utf8"));
  } catch (e) {
    return { ok: false, errors: [issue("file", "cannot read " + abs + ": " + (e as Error).message)] };
  }
  const isGroup =
    typeof doc === "object" && doc !== null && Array.isArray((doc as Record<string, unknown>).services);
  return isGroup ? await validateGroup(abs, doc, env) : await validateDeploy(abs, doc, env);
}

async function validateDeploy(
  abs: string,
  doc: unknown,
  env: Record<string, string | undefined>,
): Promise<ValidationReport> {
  const errors: ValidationIssue[] = [];
  const parsed = RawConfigSchema.safeParse(doc);
  if (!parsed.success) errors.push(...zodIssues(parsed.error));
  const rev = await revisionFor(dirname(abs));
  let loaded: LoadedConfig | undefined;
  if (parsed.success) {
    try {
      loaded = loadConfig(abs, env);
    } catch (e) {
      if (e instanceof ConfigError) errors.push(issue(errorField(e), e.message));
      else throw e;
    }
  }
  if (loaded !== undefined) errors.push(...collectLoadedIssues(loaded));
  const unique = dedupe(errors);
  if (loaded === undefined || unique.length > 0) return { ok: false, errors: unique };
  const identity = buildServiceIdentity(loaded, rev.revision, rev.source);
  if (!identity.roundTrip) {
    unique.push(issue("name", "composed name does not round-trip to the declared identity"));
  }
  return { ok: unique.length === 0, errors: unique, identity };
}

async function validateGroup(
  abs: string,
  doc: unknown,
  env: Record<string, string | undefined>,
): Promise<ValidationReport> {
  const errors: ValidationIssue[] = [];
  const parsed = GroupFileSchema.safeParse(doc);
  if (!parsed.success) errors.push(...zodIssues(parsed.error));
  const rev = await revisionFor(dirname(abs));
  let group: LoadedGroup | undefined;
  if (parsed.success) {
    try {
      group = loadGroup(abs, env);
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
      errors.push(...collectLoadedIssues(member.loaded));
    }
  }
  const unique = dedupe(errors);
  if (group === undefined || unique.length > 0) return { ok: false, errors: unique };
  const identity: GroupIdentity = {
    kind: "group",
    group: group.group,
    lockKey: group.group,
    revision: rev.revision,
    revisionSource: rev.source,
    order: topoOrder(group.members),
    members: group.members.map((m) => buildServiceIdentity(m.loaded, rev.revision, rev.source)),
  };
  return { ok: true, errors: [], identity };
}

/** Human-readable report for \`bundant validate\`. */
export function renderValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  if (!report.ok) {
    lines.push("bundant validate: FAILED (" + report.errors.length + " error(s))");
    for (const e of report.errors) lines.push("  - " + e.field + ": " + e.message);
    return lines.join("\n");
  }
  lines.push("bundant validate: OK");
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
