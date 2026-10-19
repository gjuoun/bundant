import type { RuntimeKind } from "../runtime.ts";

/** One issue a versioned validator reports; the CLI renders field + message. */
export interface ValidationIssue {
  field: string;
  message: string;
}

/** Fully-defaulted config. This shape is v1-compatible and version-agnostic. */
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

/** Raw deploy.yml shape shared by every v1 schema (inferred T is checked in v1). */
export interface RawConfig {
  version?: number;
  service: string;
  image: string;
  role?: string;
  replicas?: number;
  kind?: "service" | "accessory";
  volumes?: string[];
  hosts?: string[];
  ssh?:
    | { user?: string; port?: number; identity?: string; options?: string[] }
    | string;
  user?: string;
  runtime?: RuntimeKind;
  env?: { file?: string; vars?: Record<string, string> };
  healthcheck?: { path?: string; port?: number; timeout?: number; tcp?: number };
  proxy?: { enabled?: boolean; host?: string; port?: number; tls?: boolean; image?: string };
}

export interface LoadedConfig {
  config: BundantConfig;
  /** Merged env file+vars rendered as KEY=VAL lines (null when no env configured). */
  envContent: string | null;
  envCount: number;
  path: string;
  /** Declared (or implicit) config version that produced this file. */
  version?: number;
}

export interface GroupMember {
  /** Identity inside the group; must equal the member file's \`service\`. */
  name: string;
  /** Absolute path to the member's deploy.yml/accessory.yml. */
  file: string;
  /** In-group dependency names (default: none). */
  needs: string[];
  /** Fully-loaded config, with \`group\` already set. */
  loaded: LoadedConfig;
}

export interface LoadedGroup {
  group: string;
  path: string;
  dir: string;
  /** Config version declared by group.yml. */
  version?: number;
  /** Manifest order; use topoSortMembers() for install order. */
  members: GroupMember[];
}
