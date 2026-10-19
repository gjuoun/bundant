import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEFAULT_GROUP, loadGroup, type BundantConfig, type LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { waitUntilSucceeds } from "./health.ts";
import { acquireLock, lockKey, releaseLock } from "./lock.ts";
import { envRemotePath, groupLabels } from "./planner.ts";
import { runtimeFor, type Runtime } from "./runtime.ts";

/**
 * Accessory lifecycle — the stateful half of a group. An accessory is created
 * once (stable container name, named volumes) and is *never* touched by
 * deploy/rollback/prune/group install. Every action here is explicit.
 */

export type AccessoryAction = "boot" | "reboot" | "stop" | "logs" | "status" | "remove";

export interface AccessoryOptions {
  /** Required for `remove` (destructive). */
  yes: boolean;
  /** `remove`: also delete the declared named volumes. */
  volumes: boolean;
  /** `logs`: tail length. */
  tail: number;
  /** Print the commands without touching a host. */
  dryRun: boolean;
}

export class AccessoryError extends Error {}

/**
 * An accessory file lives inside its group directory, so when it is addressed
 * directly (`bundant accessory boot -f shop/db/accessory.yml`) the sibling
 * `../group.yml` names its namespace. This keeps `bundant accessory` and
 * `bundant group` agreeing on labels and the env path.
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
  return config.service;
}

/** Named volumes declared as "name:/path" — the part before the first colon. */
export function accessoryVolumeNames(config: BundantConfig): string[] {
  return (config.volumes ?? [])
    .map((v) => v.split(":")[0]!.trim())
    .filter((n) => n !== "");
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

/** TCP readiness probe (`healthcheck.tcp`): busybox nc from a throwaway sidecar. */
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
    // wins, so `bundant accessory boot -f shop/db/accessory.yml` keeps the shop namespace.
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
          ") — use `bundant deploy`",
      );
    }
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
        return await this.status();
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
    const verb = force ? "reboot" : "boot";
    console.log(
      "bundant accessory " + verb + " — " + name + " on " + targets.join(", ") +
      " (image " + config.image + ", runtime " + config.runtime + ")",
    );
    if (opts.dryRun) {
      console.log("  " + docker.ensureNetwork(this.rt));
      console.log("  " + docker.removeForce(this.rt, name));
      console.log("  " + buildAccessoryRun(config, this.rt));
      console.log("  " + tcpReadinessProbe(config, this.rt));
      return 0;
    }

    let envLocalFile: string | null = null;
    if (this.loaded.envContent && envRemotePath(config)) {
      envLocalFile = tmpdir() + "/bundant-accessory-" + name + ".env";
      await writeFile(envLocalFile, this.loaded.envContent, { mode: 0o600 });
      await chmod(envLocalFile, 0o600);
    }

    const primary = new SshExecutor(connectOptionsFor(connectionForTarget(config, targets[0]!)));
    const execs = new Set<SshExecutor>([primary]);
    let locked = false;
    try {
      await acquireLock(primary, lockKey(config.group, config.service));
      locked = true;

      for (const host of targets) {
        const exec = host === targets[0]
          ? primary
          : new SshExecutor(connectOptionsFor(connectionForTarget(config, host)));
        execs.add(exec);
        console.log("== " + host + " ==");

        const existing = await exec.run(docker.findByName(this.rt, name));
        const present = existing.stdout.trim() !== "";
        if (present && !force) {
          console.log("  already exists — " + name + " (use `accessory reboot` to recreate)");
        } else {
          await exec.run(docker.ensureNetwork(this.rt));
          if (present) {
            await exec.run(docker.removeForce(this.rt, name));
            console.log("  removed old " + name + " (volumes kept)");
          }
          if (envLocalFile && envRemotePath(config)) {
            const envPath = envRemotePath(config)!;
            const envDir = envPath.slice(0, envPath.lastIndexOf("/"));
            await exec.run("mkdir -p " + envDir);
            await exec.putFile(envLocalFile, envPath, "600");
          }
          const run = await exec.run(buildAccessoryRun(config, this.rt));
          if (run.code !== 0) {
            console.error("  run failed: " + (run.stderr.trim() || run.stdout.trim()));
            return 1;
          }
          console.log("  container " + name + " started");
        }

        if (config.healthcheck.tcp !== undefined) {
          const probe = tcpReadinessProbe(config, this.rt);
          try {
            const res = await waitUntilSucceeds(exec, probe, {
              timeoutMs: config.healthcheck.timeout * 1000,
            });
            console.log("  tcp readiness ok on :" + config.healthcheck.tcp + " (" + res.attempts + " attempt(s))");
          } catch (e) {
            console.error("  readiness failed: " + (e as Error).message);
            return 1;
          }
        }
      }

      console.log(verb + "ed " + name + " on " + targets.length + " host(s)");
      return 0;
    } finally {
      if (locked) await releaseLock(primary, lockKey(config.group, config.service));
      for (const e of execs) await e.close();
    }
  }

  private async stopAccessory(opts: AccessoryOptions): Promise<number> {
    const name = accessoryContainer(this.config);
    for (const host of hostTargets(this.config)) {
      const exec = new SshExecutor(connectOptionsFor(connectionForTarget(this.config, host)));
      try {
        if (opts.dryRun) {
          console.log("== " + host + " == (dry-run) " + docker.stop(this.rt, name));
          continue;
        }
        console.log("== " + host + " ==");
        const r = await exec.run(docker.stop(this.rt, name));
        if (r.code !== 0) {
          console.error("  stop failed: " + (r.stderr.trim() || r.stdout.trim()));
          return 1;
        }
        console.log("  stopped " + name);
      } finally {
        await exec.close();
      }
    }
    return 0;
  }

  private async logs(opts: AccessoryOptions): Promise<number> {
    const name = accessoryContainer(this.config);
    for (const host of hostTargets(this.config)) {
      const exec = new SshExecutor(connectOptionsFor(connectionForTarget(this.config, host)));
      try {
        console.log("== " + host + " ==");
        if (opts.dryRun) continue;
        const r = await exec.run(docker.logsTail(this.rt, name, opts.tail));
        process.stdout.write(r.stdout + r.stderr);
      } finally {
        await exec.close();
      }
    }
    return 0;
  }

  private async status(): Promise<number> {
    const name = accessoryContainer(this.config);
    let exit = 0;
    for (const host of hostTargets(this.config)) {
      const exec = new SshExecutor(connectOptionsFor(connectionForTarget(this.config, host)));
      try {
        console.log("== " + host + " ==");
        const r = await exec.run(statusCmd(this.rt, name));
        if (r.code !== 0) {
          console.log("  status query failed — " + r.stderr.trim());
          exit = 1;
          continue;
        }
        const line = r.stdout.trim();
        console.log(line === "" ? "  " + name + ": absent" : "  " + line);
        console.log(
          "  volumes: " +
            (accessoryVolumeNames(this.config).length > 0
              ? accessoryVolumeNames(this.config).join(", ")
              : "none"),
        );
      } finally {
        await exec.close();
      }
    }
    return exit;
  }

  /** remove [--yes] [--volumes]: stop + rm the container, optionally its volumes. */
  private async remove(opts: AccessoryOptions): Promise<number> {
    const config = this.config;
    const name = accessoryContainer(config);
    console.log(
      "bundant accessory remove — " + name +
      " (volumes: " + (opts.volumes ? "delete" : "keep") + ")",
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

    for (const host of hostTargets(config)) {
      const exec = new SshExecutor(connectOptionsFor(connectionForTarget(config, host)));
      try {
        console.log("== " + host + " ==");
        const r = await exec.run(docker.removeForce(this.rt, name));
        if (r.code !== 0) {
          console.error("  remove failed: " + (r.stderr.trim() || r.stdout.trim()));
          return 1;
        }
        console.log("  removed container " + name);
        if (opts.volumes) {
          for (const v of accessoryVolumeNames(config)) {
            const vr = await exec.run(docker.volumeRemove(this.rt, v) + " 2>/dev/null || true");
            console.log("  volume " + v + (vr.code === 0 ? " removed" : " not removed"));
          }
        }
      } finally {
        await exec.close();
      }
    }
    return 0;
  }
}
