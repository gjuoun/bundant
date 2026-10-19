import { chmod, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { LoadedConfig } from "./config.ts";
import type { DeployPlan } from "./planner.ts";
import type { ContainerSpec } from "./adapters/types.ts";
import { groupLabels } from "./planner.ts";
import { NETWORK } from "./commands/docker.ts";
import { LocalExecutor } from "./exec/local.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget } from "./hosts.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { openOps, type OpsVia, type RuntimeOps } from "./ops/index.ts";
import { preflightGate } from "./validation.ts";

export interface DeployOptions {
  /** Execution path for mutations: API (default) or the legacy CLI strings. */
  via?: OpsVia;
  /** Test seam: the factory runs only after preflight passes. */
  openPrimary?: () => SshExecutor;
}

export interface DeployOnHostOptions {
  host: string;
  /** Local merged env file (legacy uploads it; the API path does not). */
  envLocalFile?: string | null;
  /** Legacy --local-image pipeline, when the CLI path is forced. */
  localPushPipeline?: string;
}

/** Turn a merged KEY=VAL file into the engine's Env array (values stay redacted in logs). */
export function envArray(content: string | null): string[] {
  if (content === null || content.trim() === "") return [];
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq <= 0) continue;
    out.push(text.slice(0, eq) + "=" + text.slice(eq + 1));
  }
  return out;
}

/**
 * One host's deploy on top of RuntimeOps. The ordering is the zero-downtime
 * contract: create + start the new revision, gate it, swap the proxy target
 * set once, then stop the old revision. Any failure removes only what this
 * run started and leaves traffic on the old revision.
 */
export async function deployOnHost(
  ops: RuntimeOps,
  plan: DeployPlan,
  loaded: LoadedConfig,
  opts: DeployOnHostOptions,
): Promise<void> {
  const m = plan.meta;
  const host = opts.host;
  const env = envArray(loaded.envContent);

  await ops.putEnv(opts.envLocalFile ?? null, m.envRemotePath, loaded.envCount);
  if (
    ops.via === "cli" &&
    opts.envLocalFile !== undefined &&
    opts.envLocalFile !== null &&
    m.envRemotePath !== undefined
  ) {
    console.log("[" + host + "] env uploaded (" + loaded.envCount + " vars, redacted)");
  }

  await ops.hostPrereqs();
  if (opts.localPushPipeline !== undefined) {
    const r = await new LocalExecutor().run(opts.localPushPipeline.replaceAll("{HOST}", host));
    if (r.code !== 0) {
      throw new Error("[" + host + "] push-image failed: " + (r.stderr.trim() || r.stdout.trim()));
    }
    console.log("[" + host + "] push-image ok: " + r.stdout.trim());
  } else {
    await ops.pull(m.image);
    console.log("[" + host + "] pull ok");
  }

  await ops.ensureNetwork();
  console.log("[" + host + "] network ok");

  const created: string[] = [];
  try {
    for (let i = 0; i < m.containerNames.length; i++) {
      const name = m.containerNames[i]!;
      const spec: ContainerSpec = {
        image: m.image,
        name,
        env,
        labels: groupLabels(loaded.config, m.revision, i + 1),
        network: NETWORK,
        restart: "unless-stopped",
      };
      created.push(name);
      await ops.removeContainer(name, { force: true });
      const id = await ops.createContainer(spec);
      await ops.startContainer(id);
    }
    console.log("[" + host + "] run ok: " + m.containerNames.join(", "));

    await ops.healthGate(m.containerNames, {
      path: m.healthcheck.path,
      port: m.healthcheck.port,
      timeoutMs: m.healthcheck.timeout * 1000,
    });
    console.log("[" + host + "] health gate passed (" + m.containerNames.length + " target(s))");

    if (loaded.config.proxy.enabled) {
      await ops.proxyEnsure(loaded.config.proxy.image);
      console.log("[" + host + "] proxy-ensure ok");
      await ops.proxyDeploy(
        m.serviceId,
        m.containerNames.map((n) => n + ":" + loaded.config.proxy.port),
        {
          host: loaded.config.proxy.host,
          tls: loaded.config.proxy.tls,
          healthCheckPath: loaded.config.healthcheck.path,
          healthCheckPort:
            loaded.config.healthcheck.port === loaded.config.proxy.port
              ? undefined
              : loaded.config.healthcheck.port,
        },
      );
      console.log("[" + host + "] proxy-swap ok");
    }

    await ops.stopOld(loaded.config, m.containerNames);
    console.log("[" + host + "] stop-old ok");
  } catch (e) {
    for (const name of created) {
      try {
        await ops.removeContainer(name, { force: true });
      } catch {
        // best-effort cleanup; the original failure is the useful error
      }
    }
    console.log(
      "[" + host + "] aborted, removed containers started by this run (" +
        created.join(", ") + ")",
    );
    throw e;
  }
}

/** Orchestrates the planned sequence per host under the hosts[0] deploy lock. */
export async function deploy(
  plan: DeployPlan,
  loaded: LoadedConfig,
  opts: DeployOptions = {},
): Promise<number> {
  const m = plan.meta;
  // Image streaming is still stage 4 work: keep the whole run on the CLI path.
  const via: OpsVia = m.localImage !== undefined ? "cli" : (opts.via ?? "api");
  if (m.localImage !== undefined && opts.via === "api") {
    console.log("note: --local-image still uses the CLI path (stage 4 moves image streaming)");
  }

  // Preflight first: an invalid config must never create a connection or a lock.
  const primary = preflightGate(loaded, () =>
    opts.openPrimary !== undefined
      ? opts.openPrimary()
      : new SshExecutor(connectOptionsFor(connectionForTarget(loaded.config, m.hosts[0]!))),
  );
  const execs = new Set<SshExecutor>([primary]);
  let locked = false;

  let envLocalFile: string | null = null;
  // The API path sends Env in the create request; only the legacy path needs a
  // local staging file (and therefore a host-side upload).
  if (via === "cli" && loaded.envContent && m.envRemotePath) {
    envLocalFile = tmpdir() + "/bundant-" + m.service + "-" + m.role + ".env";
    await writeFile(envLocalFile, loaded.envContent, { mode: 0o600 });
    await chmod(envLocalFile, 0o600);
  }

  const local = m.localImage ? new LocalExecutor() : null;
  const pushStep = plan.hostSteps.find((s) => s.phase === "push-image");

  try {
    if (m.localImage && local) {
      const rt = loaded.config.runtime;
      const check = await local.run(rt + " image inspect " + m.localImage + " >/dev/null 2>&1");
      if (check.code !== 0) {
        throw new Error(
          "local image not found: " + m.localImage + " — build or pull it first (" + rt + " images)",
        );
      }
    }

    await acquireLock(primary, m.lockKey);
    locked = true;
    console.log(
      "deploy " + m.service + "/" + m.role + " rev=" + m.revision + " -> " +
        m.hosts.join(", ") + " (via " + via + ")",
    );

    for (const host of m.hosts) {
      console.log("[" + host + "] deploying " + m.containerNames.join(", "));
      const ops = await openOps(via, connectionForTarget(loaded.config, host), loaded.config, {
        envRemotePath: m.envRemotePath,
      });
      try {
        await deployOnHost(ops, plan, loaded, {
          host,
          envLocalFile,
          localPushPipeline: pushStep?.cmds[0],
        });
      } finally {
        await ops.close();
      }
    }

    console.log(
      "deployed " + m.containerNames.join(", ") + " on " + m.hosts.length + " host(s)",
    );
    return 0;
  } finally {
    if (locked) await releaseLock(primary, m.lockKey);
    for (const e of execs) await e.close();
    if (envLocalFile !== null) await unlink(envLocalFile).catch(() => {});
  }
}
