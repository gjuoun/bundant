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
import { containerNames } from "./replicas.ts";
import { ServiceIdentity } from "./domain/identity.ts";
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
    /** Container port kamal-proxy targets (dry-run rendering). */
    proxyPort: number;
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

/** Container naming lives in replicas.ts; re-exported for plan callers. */
export { containerName, containerNames, indexedContainerName } from "./replicas.ts";

export function envRemotePath(config: BundantConfig): string | undefined {
  return ServiceIdentity.from(config).envPath();
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
  const identity = ServiceIdentity.from(config, undefined, revision ?? "r0");
  const labels = identity.labels({}, replica);
  // The helper historically omits revision/replica when no revision is given.
  if (revision === undefined) {
    delete labels[LABEL_REVISION];
    delete labels[LABEL_REPLICA];
  }
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
  const identity = ServiceIdentity.from(config, undefined, revision);
  const names = containerNames(config, revision);
  const name = names[0]!;
  const svcId = identity.proxyId();
  const hasEnv = Object.keys(config.env.vars).length > 0 || config.env.file !== undefined;
  const envPath = hasEnv ? identity.envPath() : undefined;
  const key = identity.lockKey();

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
        labels: identity.labels({}, i + 1),
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
      "stop previous " +
      ((config.group !== undefined && config.group !== "" && config.group !== "default")
        ? config.group + "-" + config.service + "-" + config.role + "-* and legacy "
        : "") +
      config.service + "-" + config.role + "-* containers (keep " + names.join(", ") + ")",
    cmds: [docker.stopOld(rt, config, names)],
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
      proxyPort: config.proxy.port,
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

/** Render a plan for humans (dry-run) — implemented in plan-render.ts. */
export { renderPlan } from "./plan-render.ts";
