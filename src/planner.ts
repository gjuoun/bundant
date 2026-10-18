import type { BundantConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { pushImagePipeline } from "./exec/ssh.ts";
import { hostTargets } from "./hosts.ts";
import { acquireCmd, releaseCmd } from "./lock.ts";
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
    revision: string;
    image: string;
    localImage?: string;
    runtime: RuntimeKind;
    containerName: string;
    serviceId: string;
    hosts: string[];
    envRemotePath?: string;
    envCount: number;
    envHasFile: boolean;
    healthcheck: BundantConfig["healthcheck"];
  };
  lockStep: CmdStep;
  unlockStep: CmdStep;
  /** Sequence executed on every host, in order. */
  hostSteps: CmdStep[];
}

export function containerName(config: BundantConfig, revision: string): string {
  return config.service + "-" + config.role + "-" + revision;
}

export function envRemotePath(config: BundantConfig): string | undefined {
  return "~/.bundant/env/" + config.service + "-" + config.role + ".env";
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
  const name = containerName(config, revision);
  const svcId = proxy.serviceId(config.service, config.role);
  const hasEnv = Object.keys(config.env.vars).length > 0 || config.env.file !== undefined;
  const envPath = hasEnv ? envRemotePath(config) : undefined;

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
      cmds: [pushImagePipeline(opts.localImage, rt)],
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

  hostSteps.push({
    phase: "run",
    desc:
      "run " + name + " (" + rt.kind + ", restart unless-stopped" +
      (envPath ? ", env: redacted" : "") + ")",
    cmds: [
      docker.removeForce(rt, name),
      docker.run(rt, { container: name, image, envFile: envPath }),
    ],
  });

  hostSteps.push({
    phase: "health",
    desc:
      "health gate: GET " + config.healthcheck.path + " on " + name + ":" +
      config.healthcheck.port + " until 200 (timeout " + config.healthcheck.timeout + "s)",
    cmds: [docker.probe(rt, name, config.healthcheck.port, config.healthcheck.path)],
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
        rt.kind + " exec kamal-proxy deploy " + svcId + " -> " + name + ":" + config.proxy.port +
        (config.proxy.host ? " (host " + config.proxy.host + ")" : "") +
        " [blocks until healthy + old drained]",
      cmds: [
        proxy.deploy(rt, svcId, name + ":" + config.proxy.port, {
          host: config.proxy.host,
          tls: config.proxy.tls,
          healthCheckPath: config.healthcheck.path,
          healthCheckPort:
            config.healthcheck.port === config.proxy.port ? undefined : config.healthcheck.port,
        }),
      ],
    });
  }

  hostSteps.push({
    phase: "stop-old",
    desc:
      "stop previous " + config.service + "-" + config.role + "-* containers (keep " + name + ")",
    cmds: [docker.stopOld(rt, config.service, config.role, name)],
  });

  return {
    meta: {
      service: config.service,
      role: config.role,
      revision,
      image,
      localImage: opts.localImage,
      runtime: config.runtime,
      containerName: name,
      serviceId: svcId,
      hosts: targets,
      envRemotePath: envPath,
      envCount: Object.keys(config.env.vars).length,
      envHasFile: config.env.file !== undefined,
      healthcheck: config.healthcheck,
    },
    lockStep: {
      phase: "lock",
      desc: "acquire deploy lock for " + config.service + " on " + targets[0],
      cmds: [acquireCmd(config.service)],
    },
    unlockStep: {
      phase: "unlock",
      desc: "release deploy lock for " + config.service,
      cmds: [releaseCmd(config.service)],
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
