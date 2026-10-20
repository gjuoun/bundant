import type { BundantConfig } from "../config.ts";
import { moduleForVersion } from "../config/registry.ts";
import type { NameGrammar } from "../config/grammar.ts";
import {
  KIND_ACCESSORY,
  KIND_SERVICE,
  LABEL_GROUP,
  LABEL_KIND,
  LABEL_REPLICA,
  LABEL_REVISION,
  LABEL_SERVICE,
  LABEL_VOLUMES,
} from "../labels.ts";

/** The grammar for a config, taken from the version module it was loaded with. */
export function grammarForConfig(config: Pick<BundantConfig, "version">): NameGrammar {
  return moduleForVersion(config.version).grammar;
}

export interface ServiceIdentityFields {
  group: string;
  service: string;
  role: string;
  revision: string;
  kind: "service" | "accessory";
  replicas: number;
  volumes: string[];
}

/**
 * One deployment identity. All name/path/label derivations live here; call
 * sites pass the grammar from the resolved config version, so nothing is
 * hard-coded to one grammar.
 */
export class ServiceIdentity {
  readonly group: string;
  readonly service: string;
  readonly role: string;
  readonly revision: string;
  readonly kind: "service" | "accessory";
  readonly replicas: number;
  readonly volumes: string[];
  /** Replica index carried by parse(); from() leaves it undefined. */
  readonly replica?: number;
  private readonly grammar: NameGrammar;

  constructor(grammar: NameGrammar, fields: ServiceIdentityFields) {
    this.grammar = grammar;
    this.group = fields.group;
    this.service = fields.service;
    this.role = fields.role;
    this.revision = fields.revision;
    this.kind = fields.kind;
    this.replicas = fields.replicas;
    this.volumes = fields.volumes;
    this.replica = (fields as ServiceIdentityFields & { replica?: number }).replica;
  }

  static from(
    config: BundantConfig,
    grammar: NameGrammar = grammarForConfig(config),
    revision = "r0",
  ): ServiceIdentity {
    return new ServiceIdentity(grammar, {
      group: config.group ?? "",
      service: config.service,
      role: config.role,
      revision,
      kind: config.kind ?? "service",
      replicas: Math.max(1, config.replicas ?? 1),
      volumes: (config.volumes ?? [])
        .map((v) => v.split(":")[0]!.trim())
        .filter((v) => v !== ""),
    });
  }

  /** Parse a composed service name; an optional group disambiguates grouped names. */
  static parse(
    composed: string,
    grammar: NameGrammar,
    group?: string,
  ): ServiceIdentity | undefined {
    const groups = group !== undefined ? [group] : candidateGroups(composed, grammar);
    for (const candidate of groups) {
      try {
        const parsed = grammar.parse(composed, candidate === "" ? undefined : candidate);
        const kind = (parsed as { kind?: "service" | "accessory" }).kind ?? "service";
        return new ServiceIdentity(grammar, {
          group: candidate === "" ? (parsed.group ?? "") : candidate,
          service: parsed.service,
          role: parsed.role,
          revision: parsed.revision,
          kind,
          replicas: parsed.replica !== undefined ? 2 : 1,
          volumes: [],
          ...(parsed.replica !== undefined ? { replica: parsed.replica } : {}),
        } as ServiceIdentityFields);
      } catch {
        // try the next interpretation
      }
    }
    return undefined;
  }

  private isGrouped(): boolean {
    return this.group !== "" && this.group !== this.grammar.defaultGroup;
  }

  /** <group>.service.role / <group>-service-role, without the revision. */
  servicePrefix(): string {
    return this.proxyId();
  }

  containerName(replica?: number): string {
    if (this.kind === "accessory") {
      const fields = {
        group: this.group,
        service: this.service,
        role: this.role,
        revision: this.revision,
      };
      if (this.grammar.accessoryCompose !== undefined) {
        return this.grammar.accessoryCompose(fields);
      }
      return this.isGrouped() ? this.group + "-" + this.service : this.service;
    }
    return this.grammar.compose({
      group: this.group,
      service: this.service,
      role: this.role,
      revision: this.revision,
      replica: replica ?? this.replica,
    });
  }

  proxyId(): string {
    if (this.kind === "accessory") return this.containerName();
    const composed = this.grammar.compose({
      group: this.group,
      service: this.service,
      role: this.role,
      revision: this.revision,
    });
    const suffix = this.revision.length + 1;
    return composed.slice(0, Math.max(0, composed.length - suffix));
  }

  envPath(): string {
    const base = "~/.bundant/env" + (this.group !== "" ? "/" + this.group : "");
    return this.kind === "accessory"
      ? base + "/" + this.service + ".env"
      : base + "/" + this.service + "-" + this.role + ".env";
  }

  lockKey(): string {
    return this.group !== "" ? this.group + "/" + this.service : this.service;
  }

  compose(): string {
    return this.containerName();
  }

  labels(extra: Record<string, string> = {}, replica = 1): Record<string, string> {
    const labels: Record<string, string> = {
      [LABEL_SERVICE]: this.service,
      [LABEL_GROUP]: this.group === "" ? this.grammar.defaultGroup : this.group,
      [LABEL_KIND]: this.kind,
      ...extra,
    };
    if (this.kind === KIND_SERVICE) {
      labels[LABEL_REVISION] = this.revision;
      labels[LABEL_REPLICA] = String(replica);
    }
    if (this.kind === KIND_ACCESSORY && this.volumes.length > 0) {
      labels[LABEL_VOLUMES] = this.volumes.join(",");
    }
    return labels;
  }

  withRevision(revision: string): ServiceIdentity {
    return new ServiceIdentity(this.grammar, { ...this.fields(), revision });
  }

  private fields(): ServiceIdentityFields {
    return {
      group: this.group,
      service: this.service,
      role: this.role,
      revision: this.revision,
      kind: this.kind,
      replicas: this.replicas,
      volumes: this.volumes,
      ...(this.replica !== undefined ? { replica: this.replica } : {}),
    } as ServiceIdentityFields;
  }
}

/** Grouped names get their first segment as a candidate; ungrouped is last. */
function candidateGroups(composed: string, grammar: NameGrammar): string[] {
  const parts = composed.split("-");
  if (parts.length >= 4 && grammar.group.test(parts[0]!)) {
    return [parts[0]!, ""];
  }
  return [""];
}
