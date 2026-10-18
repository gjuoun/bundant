import type { BundantConfig, LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget, hostTargets } from "./hosts.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { runtimeFor } from "./runtime.ts";
import type { CmdStep } from "./types.ts";

export interface DeleteOptions {
  /** Required for the destructive path; without it delete only prints the plan. */
  yes: boolean;
  /** Also remove the image refs the deleted revisions used (default: leave images). */
  images: boolean;
  /** Print exactly what would be removed and never open ssh. */
  dryRun: boolean;
}

/** Pure: the containers that belong to this service-role (running or stopped). */
export function selectVictims(stdout: string, service: string, role: string): string[] {
  const prefix = service + "-" + role + "-";
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((n) => n.startsWith(prefix));
}

export function deleteGuardError(opts: DeleteOptions): string | null {
  if (opts.dryRun || opts.yes) return null;
  return "delete is destructive and removes containers and the env file on every host: pass --yes (or --dry-run to preview)";
}

function prefix(config: BundantConfig): string {
  return config.service + "-" + config.role + "-";
}

/**
 * Pure plan. The container removal is a single runtime loop, so the plan is
 * exact without any ssh call (which is what lets --dry-run stay print-only).
 */
export function buildDeleteSteps(config: BundantConfig, opts: DeleteOptions): CmdStep[] {
  const rt = runtimeFor(config.runtime);
  const svcId = proxy.serviceId(config.service, config.role);
  const p = prefix(config);

  const steps: CmdStep[] = [];

  if (config.proxy.enabled) {
    steps.push({
      phase: "proxy-remove",
      desc:
        "remove the kamal-proxy route for " + svcId +
        " (tolerated when the proxy is absent or stopped)",
      cmds: [
        rt.bin + ' inspect -f "{{.State.Running}}" ' + proxy.PROXY_CONTAINER +
          " 2>/dev/null | grep -q true && " + rt.bin + " exec " + proxy.PROXY_CONTAINER +
          " kamal-proxy remove " + svcId + " || true",
      ],
    });
  }

  const names =
    "for c in $(" + rt.bin + ' ps -a --filter "name=' + p + '" --format "{{.Names}}"' +
    ' | grep "^' + p + '"); do ';
  const stopAndRemove = names + rt.bin + ' stop -t 10 "$c" 2>/dev/null; ' + rt.bin + ' rm -f "$c"; done';
  const collectImages =
    names + rt.bin + ' inspect -f "{{.Config.Image}}" "$c" 2>/dev/null; done | sort -u';

  if (opts.images) {
    steps.push({
      phase: "containers",
      desc:
        "stop and remove every " + p + "* container, then remove the images they used",
      cmds: [
        "imgs=$(" + collectImages + "); " + stopAndRemove +
          '; for img in $imgs; do [ -n "$img" ] && ' + rt.bin + ' rmi "$img"; done',
      ],
    });
  } else {
    steps.push({
      phase: "containers",
      desc: "stop and remove every " + p + "* container (running or stopped)",
      cmds: [stopAndRemove],
    });
  }

  steps.push({
    phase: "env-remove",
    desc: "remove the rendered env file (tolerated when absent)",
    cmds: ["rm -f ~/.bundant/env/" + config.service + "-" + config.role + ".env"],
  });

  return steps;
}

/**
 * Remove a service-role from every host: proxy route, containers, env file
 * (and images with --images). Prints the plan first; without --yes it stops
 * there and never opens ssh.
 */
export async function remove(loaded: LoadedConfig, opts: DeleteOptions): Promise<number> {
  const { config } = loaded;
  const steps = buildDeleteSteps(config, opts);
  const targets = hostTargets(config);

  console.log(
    "bundant delete — " + config.service + "/" + config.role + " on " + targets.join(", "),
  );
  console.log(
    "runtime=" + config.runtime + " | images=" + (opts.images ? "remove" : "leave alone"),
  );
  for (const step of steps) {
    console.log("  [" + step.phase + "] " + step.desc);
    for (const cmd of step.cmds) console.log("     " + cmd);
  }

  const guard = deleteGuardError(opts);
  if (guard) {
    console.error("bundant: " + guard);
    return 2;
  }
  if (opts.dryRun) {
    console.log("(dry-run: nothing executed, no host contacted)");
    return 0;
  }

  const primary = new SshExecutor(connectOptionsFor(connectionForTarget(config, targets[0]!)));
  const execs = new Set<SshExecutor>([primary]);
  let locked = false;
  try {
    await acquireLock(primary, config.service);
    locked = true;

    for (const host of targets) {
      const exec = host === targets[0]
        ? primary
        : new SshExecutor(connectOptionsFor(connectionForTarget(config, host)));
      execs.add(exec);
      console.log("== " + host + " ==");
      for (const step of steps) {
        for (const cmd of step.cmds) {
          const r = await exec.run(cmd);
          const detail = r.stdout.trim() || r.stderr.trim();
          console.log(
            "  " + step.phase + (r.code === 0 ? " ok" : " failed") + (detail ? ": " + detail : ""),
          );
          if (r.code !== 0) {
            console.error("bundant: delete failed on " + host + " at " + step.phase + " (" + cmd + ")");
            return 1;
          }
        }
      }
    }

    console.log("deleted " + config.service + "/" + config.role + " on " + targets.length + " host(s)");
    return 0;
  } finally {
    if (locked) await releaseLock(primary, config.service);
    for (const e of execs) await e.close();
  }
}
