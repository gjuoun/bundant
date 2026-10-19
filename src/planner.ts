import { DEFAULT_GROUP, type BundantConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { pushImagePipeline } from "./exec/ssh.ts";
import { expandHome, hostTargets } from "./hosts.ts";
import { acquireCmd, lockKey, releaseCmd } from "./lock.ts";
import {
  PORT_FLOOR_KEY,
  portGuardCommand,
  runtimeCheckCommands,
  runtimeFor,
  type RuntimeKind,
} from "./runtime.ts";
import type { CmdStep } from "./types.ts";

export interface DeployPlanOptions {
  /** Stream this locally built image to each host instead of pulling from a registry. */
  localImage?: string;
}

export interface DeployPlan {
  meta: {
    service: string;
    role: string;
    /** Group namespace when the service is deployed as part of one. */
    group?: string;
    revision: string;
    image: string;
    localImage?: string;
    runtime: RuntimeKind;
    /** First container of the set (replicas: 1 = the only one). */
    containerName: string;
    /** Every container this revision runs on a host, in replica order. */
    containerNames: string[];
    /** Replica count this plan deploys (1 unless replicas: N). */
    replicas: number;
    serviceId: string;
    hosts: string[];
    envRemotePath?: string;
    envCount: number;
    envHasFile: boolean;
    healthcheck: BundantConfig["healthcheck"];
    /** Lock key actually used: `<group>/<service>` when grouped, else `<service>`. */
    lockKey: string;
  };
  lockStep: CmdStep;
  unlockStep: CmdStep;
  /** Sequence executed on every host, in order. */
  hostSteps: CmdStep[];
}

/**
 * Container name for one replica. replicas: 1 keeps the historical
 * `<service>-<role>-<rev>` (no migration); N > 1 appends `-<i>` for i = 1..N.
 * Accessories carry no revision and no replicas: one stable name forever.
 */
export function containerName(
  config: BundantConfig,
  revision: string,
  replica = 1,
): string {
  if (config.kind === "accessory") return config.service;
  const base = config.service + "-" + config.role + "-" + revision;
  return (config.replicas ?? 1) > 1 ? base + "-" + replica : base;
}

/** The indexed name, unconditionally: `<service>-<role>-<rev>-<i>`. */
export function indexedContainerName(
  config: BundantConfig,
  revision: string,
  index: number,
): string {
  if (config.kind === "accessory") return config.service;
  return config.service + "-" + config.role + "-" + revision + "-" + index;
}

/** Every container name this deploy runs on one host, in replica order. */
export function containerNames(config: BundantConfig, revision: string): string[] {
  const count = config.kind === "accessory" ? 1 : Math.max(1, config.replicas ?? 1);
  const names: string[] = [];
  for (let i = 1; i <= count; i++) names.push(containerName(config, revision, i));
  return names;
}

export function envRemotePath(config: BundantConfig): string | undefined {
  const base = "~/.bundant/env" + (config.group ? "/" + config.group : "");
  return config.kind === "accessory"
    ? base + "/" + config.service + ".env"
    : base + "/" + config.service + "-" + config.role + ".env";
}

/** Label keys every bundant container carries — the object describes itself. */
export {
  LABEL_SERVICE,
  LABEL_GROUP,
  LABEL_KIND,
  LABEL_VOLUMES,
  LABEL_OWNER,
  LABEL_MANAGED,
  LABEL_REVISION,
  LABEL_REPLICA,
  KIND_SERVICE,
  KIND_ACCESSORY,
} from "./labels.ts";
import {
  LABEL_SERVICE,
  LABEL_GROUP,
  LABEL_KIND,
  LABEL_VOLUMES,
  LABEL_OWNER,
  LABEL_MANAGED,
  LABEL_REVISION,
  LABEL_REPLICA,
  KIND_ACCESSORY,
  KIND_SERVICE,
} from "./labels.ts";

/**
 * Exact labels every container carries. kind=accessory is what makes a stateful
 * member recognisable on the host — sweeps and `delete` refuse to touch it, and a
 * human can enumerate them with `ps --filter label=bundant.kind=accessory`.
 */
export function groupLabels(
  config: BundantConfig,
  revision?: string,
  replica = 1,
): Record<string, string> {
  const kind = config.kind ?? KIND_SERVICE;
  const labels: Record<string, string> = {
    [LABEL_SERVICE]: config.service,
    [LABEL_GROUP]: config.group ?? DEFAULT_GROUP,
    [LABEL_KIND]: kind,
  };
  // Revision + replica make the running set self-describing: `scale` and
  // `status` read the truth from here, never from a local file.
  if (kind === KIND_SERVICE && revision !== undefined) {
    labels[LABEL_REVISION] = revision;
    labels[LABEL_REPLICA] = String(replica);
  }
  const volumes = (config.volumes ?? []).map((v) => v.split(":")[0]!.trim()).filter((n) => n !== "");
  if (kind === KIND_ACCESSORY && volumes.length > 0) labels[LABEL_VOLUMES] = volumes.join(",");
  return labels;
}

/** Labels stamped on the named volumes an accessory declares. */
export function volumeLabels(config: BundantConfig): Record<string, string> {
  return {
    [LABEL_KIND]: KIND_ACCESSORY,
    [LABEL_OWNER]: (config.group ?? DEFAULT_GROUP) + "/" + config.service,
    [LABEL_MANAGED]: "true",
  };
}

/**
 * Pure: turns a config + revision into the exact command sequence for the
 * configured runtime. dry-run renders this; the orchestrators execute it.
 */
export function buildDeployPlan(
  config: BundantConfig,
  revision: string,
  opts: DeployPlanOptions = {},
): DeployPlan {
  const rt = runtimeFor(config.runtime);
  const targets = hostTargets(config);
  const image = opts.localImage ?? config.image;
  const names = containerNames(config, revision);
  const name = names[0]!;
  const svcId = proxy.serviceId(config.service, config.role);
  const hasEnv = Object.keys(config.env.vars).length > 0 || config.env.file !== undefined;
  const envPath = hasEnv ? envRemotePath(config) : undefined;
  const key = lockKey(config.group, config.service);

  const hostSteps: CmdStep[] = [];

  const runtimeChecks = runtimeCheckCommands(rt);
  if (runtimeChecks.length > 0) {
    hostSteps.push({
      phase: "runtime-check",
      desc:
        "rootless " + rt.kind + " boot persistence: podman-restart.service + linger" +
        " (idempotent, no-op when already enabled)",
      cmds: runtimeChecks,
    });
  }

  const guard = portGuardCommand(rt);
  if (guard) {
    hostSteps.push({
      phase: "port-guard",
      desc:
        "low-port check (" + rt.kind + "): host " + PORT_FLOOR_KEY +
        " is informational — the proxy container sets its own floor to 0",
      cmds: [guard],
    });
  }

  if (opts.localImage) {
    hostSteps.push({
      phase: "push-image",
      desc:
        "push local image " + opts.localImage +
        " to host (" + rt.kind + " save | gzip | ssh | load, no registry)",
      cmds: [
        pushImagePipeline(opts.localImage, rt, {
          port: config.ssh?.port,
          identity: config.ssh?.identity ? expandHome(config.ssh.identity) : undefined,
          options: config.ssh?.options,
        }),
      ],
    });
  } else {
    hostSteps.push({
      phase: "pull",
      desc: "pull " + config.image + " with " + rt.kind,
      cmds: [docker.pull(rt, config.image)],
    });
  }

  hostSteps.push({
    phase: "network",
    desc: "ensure " + rt.kind + " network " + docker.NETWORK,
    cmds: [docker.ensureNetwork(rt)],
  });

  const runCmds: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const replicaName = names[i]!;
    runCmds.push(docker.removeForce(rt, replicaName));
    runCmds.push(
      docker.run(rt, {
        container: replicaName,
        image,
        envFile: envPath,
        labels: groupLabels(config, revision, i + 1),
      }),
    );
  }
  hostSteps.push({
    phase: "run",
    desc:
      "run " + (names.length === 1 ? name : names.length + " replicas (" + names.join(", ") + ")") +
      " (" + rt.kind + ", restart unless-stopped" +
      (envPath ? ", env: redacted" : "") + ")",
    cmds: runCmds,
  });

  hostSteps.push({
    phase: "health",
    desc:
      "health gate: GET " + config.healthcheck.path + " on each of " +
      names.join(", ") + ":" + config.healthcheck.port + " until 200 (timeout " +
      config.healthcheck.timeout + "s)",
    cmds: names.map((n) =>
      docker.probe(rt, n, config.healthcheck.port, config.healthcheck.path),
    ),
  });

  if (config.proxy.enabled) {
    hostSteps.push({
      phase: "proxy-ensure",
      desc:
        "ensure kamal-proxy container (" + rt.kind + ", owns 80/443, image " +
        config.proxy.image + ")",
      cmds: [proxy.ensure(rt, config.proxy.image)],
    });
    hostSteps.push({
      phase: "proxy-swap",
      desc:
        rt.kind + " exec kamal-proxy deploy " + svcId + " -> " +
        names.map((n) => n + ":" + config.proxy.port).join(", ") +
        (config.proxy.host ? " (host " + config.proxy.host + ")" : "") +
        " [one atomic set swap; blocks until healthy + old drained]",
      cmds: [
        proxy.deploy(
          rt,
          svcId,
          names.map((n) => n + ":" + config.proxy.port),
          {
          host: config.proxy.host,
          tls: config.proxy.tls,
          healthCheckPath: config.healthcheck.path,
            healthCheckPort:
              config.healthcheck.port === config.proxy.port
                ? undefined
                : config.healthcheck.port,
          },
        ),
      ],
    });
  }

  hostSteps.push({
    phase: "stop-old",
    desc:
      "stop previous " + config.service + "-" + config.role + "-* containers (keep " +
      names.join(", ") + ")",
    cmds: [docker.stopOld(rt, config.service, config.role, names)],
  });

  return {
    meta: {
      service: config.service,
      role: config.role,
      group: config.group,
      revision,
      image,
      localImage: opts.localImage,
      runtime: config.runtime,
      containerName: name,
      containerNames: names,
      replicas: names.length,
      serviceId: svcId,
      hosts: targets,
      envRemotePath: envPath,
      envCount: Object.keys(config.env.vars).length,
      envHasFile: config.env.file !== undefined,
      healthcheck: config.healthcheck,
      lockKey: key,
    },
    lockStep: {
      phase: "lock",
      desc: "acquire deploy lock for " + key + " on " + targets[0],
      cmds: [acquireCmd(key)],
    },
    unlockStep: {
      phase: "unlock",
      desc: "release deploy lock for " + key,
      cmds: [releaseCmd(key)],
    },
    hostSteps,
  };
}

/** Render a plan for humans (dry-run). Env values never appear here. */
export function renderPlan(plan: DeployPlan): string {
  const lines: string[] = [];
  const m = plan.meta;
  lines.push(
    "bundant deploy plan — " + m.service + "/" + m.role + " rev=" + m.revision +
    " runtime=" + m.runtime + " image=" + m.image,
  );
  if (m.envRemotePath) {
    lines.push(
      "env: " + m.envCount + " inline vars" + (m.envHasFile ? " + env file (values redacted)" : "") +
      " -> " + m.envRemotePath,
    );
  }
  lines.push("hosts: " + m.hosts.join(", "));
  lines.push("");
  lines.push("lock (" + m.hosts[0] + "):");
  lines.push("  " + plan.lockStep.cmds[0]);
  if (m.envRemotePath) {
    lines.push("");
    lines.push("env upload (each host, putFile, values redacted):");
    lines.push("  local merged env -> " + m.envRemotePath + " (mode 0600)");
  }
  for (const host of m.hosts) {
    lines.push("");
    lines.push("host " + host + ":");
    let i = 1;
    for (const step of plan.hostSteps) {
      lines.push("  " + i + ") [" + step.phase + "] " + step.desc);
      for (const c of step.cmds) lines.push("     " + c.replaceAll("{HOST}", host));
      i++;
    }
  }
  lines.push("");
  lines.push("unlock:");
  lines.push("  " + plan.unlockStep.cmds[0]);
  return lines.join("\n");
}
