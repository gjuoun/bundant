import { existsSync } from "node:fs";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEFAULT_GROUP, loadGroup, type BundantConfig, type LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { NETWORK } from "./commands/docker.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, lockKey, releaseLock } from "./lock.ts";
import { envRemotePath, groupLabels, volumeLabels, LABEL_OWNER } from "./planner.ts";
import { runtimeFor, type Runtime } from "./runtime.ts";
import { accessoryContainerName, serviceLabels } from "./naming.ts";
import { envArray } from "./deploy.ts";
import { openOps, type OpsVia } from "./ops/index.ts";
import { assertPreflight, preflightGate } from "./validation.ts";

/**
 * Accessory lifecycle — the stateful half of a group. An accessory is created
 * once (stable container name, named volumes) and is *never* touched by
 * deploy/rollback/prune/group install. Every action here is explicit.
 */

export type AccessoryAction = "boot" | "reboot" | "stop" | "logs" | "status" | "remove";

export interface AccessoryOptions {
  /** Required for \`remove\` (destructive). */
  yes: boolean;
  /** \`remove\`: also delete the declared named volumes. */
  volumes: boolean;
  /** \`logs\`: tail length. */
  tail: number;
  /** Print the commands without touching a host. */
  dryRun: boolean;
  /** Mutations through the engine API (default) or the legacy CLI strings. */
  via?: OpsVia;
}

export class AccessoryError extends Error {}

/**
 * An accessory file lives inside its group directory, so when it is addressed
 * directly (\`bundant accessory boot -f shop/db/accessory.yml\`) the sibling
 * \`../group.yml\` names its namespace. This keeps \`bundant accessory\` and
 * \`bundant group\` agreeing on labels and the env path.
 */
export function inferAccessoryGroup(path: string): string | undefined {
  const file = resolve(path);
  const groupPath = resolve(dirname(dirname(file)), "group.yml");
  if (!existsSync(groupPath)) return undefined;
  try {
    const group = loadGroup(groupPath);
    return group.members.find((m) => resolve(m.file) === file)?.loaded.config.group;
  } catch {
    return undefined;
  }
}

export function accessoryContainer(config: BundantConfig): string {
  // No revision, no role: clients, ports and volumes stay valid across app deploys.
  // A grouped accessory carries the group prefix: <group>-<service>.
  return accessoryContainerName(config);
}

/** Named volumes declared as "name:/path" — the part before the first colon. */
export function accessoryVolumeNames(config: BundantConfig): string[] {
  return (config.volumes ?? [])
    .map((v) => v.split(":")[0]!.trim())
    .filter((n) => n !== "");
}

/**
 * Declare the volumes before the container starts so each one carries ownership
 * labels (\`bundant.owner=<group>/<service>\`). A volume created implicitly by
 * \`-v name:/path\` has no labels, which is exactly the case we want to avoid.
 */
export function buildVolumeCreates(config: BundantConfig, rt: Runtime): string[] {
  const labels = volumeLabels(config);
  return accessoryVolumeNames(config).map((v) => docker.volumeCreate(rt, v, labels));
}

export function buildAccessoryRun(config: BundantConfig, rt: Runtime): string {
  const hasEnv = Object.keys(config.env.vars).length > 0 || config.env.file !== undefined;
  return docker.run(rt, {
    container: accessoryContainer(config),
    image: config.image,
    envFile: hasEnv ? envRemotePath(config) : undefined,
    labels: groupLabels(config),
    volumes: config.volumes ?? [],
  });
}

/** TCP readiness probe (\`healthcheck.tcp\`): busybox nc from a throwaway sidecar. */
export function tcpReadinessProbe(config: BundantConfig, rt: Runtime): string {
  const port = config.healthcheck.tcp;
  if (port === undefined) {
    throw new AccessoryError(
      "accessory " + config.service + " needs healthcheck.tcp for its readiness probe",
    );
  }
  return docker.tcpProbe(rt, accessoryContainer(config), port, 3);
}

function statusCmd(rt: Runtime, name: string): string {
  return rt.bin + ' ps -a --filter "name=^' + name + '$" --format "{{.Names}} {{.Status}}"';
}

export class Accessory {
  private readonly loaded: LoadedConfig;
  private readonly rt: Runtime;

  constructor(loaded: LoadedConfig) {
    // A file loaded on its own sits in DEFAULT_GROUP; a sibling ../group.yml still
    // wins, so \`bundant accessory boot -f shop/db/accessory.yml\` keeps the shop namespace.
    if (loaded.config.kind === "accessory" && loaded.config.group === DEFAULT_GROUP) {
      const inferred = inferAccessoryGroup(loaded.path);
      if (inferred !== undefined) loaded.config = { ...loaded.config, group: inferred };
    }
    this.loaded = loaded;
    this.rt = runtimeFor(loaded.config.runtime);
  }

  async run(action: AccessoryAction, opts: AccessoryOptions): Promise<number> {
    const config = this.loaded.config;
    if (config.kind !== "accessory") {
      throw new AccessoryError(
        "not an accessory: " + config.service + " (kind: " + (config.kind ?? "service") +
          ") — use \`bundant deploy\`",
      );
    }
    // Preflight before any host contact, for every accessory action.
    assertPreflight(this.loaded);
    switch (action) {
      case "boot":
        return await this.create(false, opts);
      case "reboot":
        return await this.create(true, opts);
      case "stop":
        return await this.stopAccessory(opts);
      case "logs":
        return await this.logs(opts);
      case "status":
        return await this.status(opts);
      case "remove":
        return await this.remove(opts);
    }
  }

  private get config(): BundantConfig {
    return this.loaded.config;
  }

  /** boot (create if absent) / reboot (recreate, keep volumes). */
  private async create(force: boolean, opts: AccessoryOptions): Promise<number> {
    const config = this.config;
    const name = accessoryContainer(config);
    const targets = hostTargets(config);
    const via: OpsVia = opts.via ?? "api";
    const verb = force ? "reboot" : "boot";
    console.log(
      "bundant accessory " + verb + " — " + name + " on " + targets.join(", ") +
      " (image " + config.image + ", runtime " + config.runtime + ", via " + via + ")",
    );
    if (opts.dryRun) {
      console.log("  " + docker.ensureNetwork(this.rt));
      console.log("  " + docker.removeForce(this.rt, name));
      for (const cmd of buildVolumeCreates(config, this.rt)) console.log("  " + cmd);
      console.log("  " + buildAccessoryRun(config, this.rt));
      console.log("  " + tcpReadinessProbe(config, this.rt));
      return 0;
    }

    const hasEnv = Object.keys(config.env.vars).length > 0 || config.env.file !== undefined;
    let envLocalFile: string | null = null;
    if (via === "cli" && this.loaded.envContent && envRemotePath(config)) {
      envLocalFile = tmpdir() + "/bundant-accessory-" + name + ".env";
      await writeFile(envLocalFile, this.loaded.envContent, { mode: 0o600 });
      await chmod(envLocalFile, 0o600);
    }
    const env = envArray(this.loaded.envContent);

    const primary = preflightGate(this.loaded, () =>
      new SshExecutor(connectOptionsFor(connectionForTarget(config, targets[0]!))),
    );
    let locked = false;
    try {
      await acquireLock(primary, lockKey(config.group, config.service));
      locked = true;

      for (const host of targets) {
        console.log("== " + host + " ==");
        const ops = await openOps(via, connectionForTarget(config, host), config, {
          envRemotePath: hasEnv ? envRemotePath(config) : undefined,
        });
        try {
          const rows = await ops.listContainers({ all: true, namePrefix: name });
          const present = rows.some((row) => row.name === name);
          if (present && !force) {
            console.log("  already exists — " + name + " (use \`accessory reboot\` to recreate)");
          } else {
            await ops.ensureNetwork();
            if (present) {
              await ops.removeContainer(name, { force: true });
              console.log("  removed old " + name + " (volumes kept)");
            }
            await ops.putEnv(envLocalFile, envRemotePath(config), this.loaded.envCount);
            for (const volume of accessoryVolumeNames(config)) {
              await ops.createVolume(volume, volumeLabels(config));
            }
            const id = await ops.createContainer({
              image: config.image,
              name,
              env,
              labels: groupLabels(config),
              volumes: config.volumes ?? [],
              network: NETWORK,
              restart: "unless-stopped",
            });
            await ops.startContainer(id);
            console.log("  container " + name + " started");
          }

          if (config.healthcheck.tcp !== undefined) {
            await ops.tcpGate(name, config.healthcheck.tcp, {
              path: "/",
              port: config.healthcheck.tcp,
              timeoutMs: config.healthcheck.timeout * 1000,
            });
            console.log("  tcp readiness ok on :" + config.healthcheck.tcp);
          }
        } catch (e) {
          console.error("  " + (e as Error).message);
          return 1;
        } finally {
          await ops.close();
        }
      }

      console.log(verb + "ed " + name + " on " + targets.length + " host(s)");
      return 0;
    } finally {
      if (locked) await releaseLock(primary, lockKey(config.group, config.service));
      await primary.close();
      if (envLocalFile !== null) await unlink(envLocalFile).catch(() => {});
    }
  }

  private async stopAccessory(opts: AccessoryOptions): Promise<number> {
    const config = this.config;
    const name = accessoryContainer(config);
    const via: OpsVia = opts.via ?? "api";
    for (const host of hostTargets(config)) {
      if (opts.dryRun) {
        console.log("== " + host + " == (dry-run) " + docker.stop(this.rt, name));
        continue;
      }
      console.log("== " + host + " ==");
      const ops = await openOps(via, connectionForTarget(config, host), config);
      try {
        await ops.stopContainers([name]);
        console.log("  stopped " + name);
      } catch (e) {
        console.error("  stop failed: " + (e as Error).message);
        return 1;
      } finally {
        await ops.close();
      }
    }
    return 0;
  }

  private async logs(opts: AccessoryOptions): Promise<number> {
    const config = this.config;
    const name = accessoryContainer(config);
    const via: OpsVia = opts.via ?? "api";
    for (const host of hostTargets(config)) {
      console.log("== " + host + " ==");
      if (opts.dryRun) continue;
      const ops = await openOps(via, connectionForTarget(config, host), config);
      try {
        process.stdout.write(await ops.logs(name, opts.tail));
      } finally {
        await ops.close();
      }
    }
    return 0;
  }

  private async status(opts: AccessoryOptions): Promise<number> {
    const config = this.config;
    const name = accessoryContainer(config);
    const via: OpsVia = opts.via ?? "api";
    let exit = 0;
    for (const host of hostTargets(config)) {
      console.log("== " + host + " ==");
      if (opts.dryRun) {
        console.log("  (dry-run) " + statusCmd(this.rt, name));
        continue;
      }
      const ops = await openOps(via, connectionForTarget(config, host), config);
      try {
        const rows = await ops.listContainers({ all: true, namePrefix: name });
        const row = rows.find((r) => r.name === name);
        console.log(row === undefined ? "  " + name + ": absent" : "  " + name + " " + row.status);
        console.log(
          "  volumes: " +
            (accessoryVolumeNames(config).length > 0
              ? accessoryVolumeNames(config).join(", ")
              : "none"),
        );
      } catch (e) {
        console.log("  status query failed — " + (e as Error).message);
        exit = 1;
      } finally {
        await ops.close();
      }
    }
    return exit;
  }

  /** remove [--yes] [--volumes]: stop + rm the container, optionally its volumes. */
  private async remove(opts: AccessoryOptions): Promise<number> {
    const config = this.config;
    const name = accessoryContainer(config);
    const via: OpsVia = opts.via ?? "api";
    console.log(
      "bundant accessory remove — " + name +
      " (volumes: " + (opts.volumes ? "delete" : "keep") + ", via " + via + ")",
    );
    if (!opts.yes) {
      console.error("bundant: accessory remove is destructive: pass --yes" +
        (opts.volumes ? " (and --volumes to also delete the named volumes)" : ""));
      return 2;
    }
    if (opts.dryRun) {
      for (const host of hostTargets(config)) {
        console.log("  " + host + ": " + docker.removeForce(this.rt, name));
        for (const v of accessoryVolumeNames(config)) {
          console.log("    " + docker.volumeRemove(this.rt, v));
        }
      }
      return 0;
    }

    const owner = (config.group ?? DEFAULT_GROUP) + "/" + config.service;
    for (const host of hostTargets(config)) {
      console.log("== " + host + " ==");
      const ops = await openOps(via, connectionForTarget(config, host), config);
      try {
        await ops.removeContainer(name, { force: true });
        console.log("  removed container " + name);
        if (opts.volumes) {
          for (const v of accessoryVolumeNames(config)) {
            // Labels are the contract: never delete a volume another accessory owns.
            const found = await ops.inspectVolume(v);
            const got = found.labels[LABEL_OWNER] ?? "";
            if (got !== "" && got !== owner) {
              console.log("  volume " + v + " belongs to " + got + " — left alone");
              continue;
            }
            await ops.removeVolume(v);
            console.log("  volume " + v + " removed");
          }
        }
      } catch (e) {
        console.error("  remove failed: " + (e as Error).message);
        return 1;
      } finally {
        await ops.close();
      }
    }
    return 0;
  }
}
