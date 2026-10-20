/** Shared naming contract: a version module supplies the grammar. */

export const DEFAULT_GROUP = "default";

export interface NameIdentity {
  group?: string;
  service: string;
  role: string;
  revision: string;
  /** 1-based replica index; omitted for the unsuffixed single-replica name. */
  replica?: number;
  /** Set by the grammar when parsing an accessory name. */
  kind?: "service" | "accessory";
}

export class NameParseError extends Error {
  readonly containerName: string;
  constructor(containerName: string, reason: string) {
    super('cannot parse container name "' + containerName + '": ' + reason);
    this.name = "NameParseError";
    this.containerName = containerName;
  }
}

export interface NameGrammar {
  service: RegExp;
  group: RegExp;
  role: RegExp;
  revision: RegExp;
  serviceRule: string;
  segmentRule: string;
  defaultGroup: string;
  compose(identity: NameIdentity): string;
  parse(name: string, group?: string): NameIdentity;
  roundTrips(identity: NameIdentity): boolean;
  /** Accessory naming; a grammar without it composes accessories itself. */
  accessoryCompose?(identity: NameIdentity): string;
  /** Separator before the replica index. */
  replicaSeparator?: string;
}
