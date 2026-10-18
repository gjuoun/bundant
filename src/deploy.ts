import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { LoadedConfig } from "./config.ts";
import type { DeployPlan } from "./planner.ts";
import { LocalExecutor } from "./exec/local.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget } from "./hosts.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { waitUntilHealthy } from "./health.ts";
import { runtimeFor } from "./runtime.ts";

/**
 * Orchestrates the planned sequence per host under the hosts[0] deploy lock.
 * Failure path: the new container is removed, remaining hosts are skipped,
 * the previously deployed revision keeps serving, and the lock is released.
 */
export async function deploy(plan: DeployPlan, loaded: LoadedConfig): Promise<number> {
  const m = plan.meta;
  const rt = runtimeFor(m.runtime);
  const primary = new SshExecutor(connectOptionsFor(connectionForTarget(loaded.config, m.hosts[0]!)));
  const execs = new Set<SshExecutor>([primary]);
  let locked = false;

  let envLocalFile: string | null = null;
  if (loaded.envContent && m.envRemotePath) {
    envLocalFile = tmpdir() + "/bundant-" + m.service + "-" + m.role + ".env";
    // The merged env file may carry secrets: create it 0600 and chmod afterwards
    // (writeFile mode only applies when the file is created).
    await writeFile(envLocalFile, loaded.envContent, { mode: 0o600 });
    await chmod(envLocalFile, 0o600);
  }

  const local = m.localImage ? new LocalExecutor() : null;

  try {
    if (m.localImage && local) {
      const check = await local.run(rt.bin + " image inspect " + m.localImage + " >/dev/null 2>&1");
      if (check.code !== 0) {
        throw new Error(
          "local image not found: " + m.localImage + " — build or pull it first (" +
            rt.bin + " images)",
        );
      }
    }

    await acquireLock(primary, m.service);
    locked = true;
    console.log(
      "deploy " + m.service + "/" + m.role + " rev=" + m.revision + " -> " + m.hosts.join(", "),
    );

    for (const host of m.hosts) {
      const exec = new SshExecutor(connectOptionsFor(connectionForTarget(loaded.config, host)));
      execs.add(exec);
      console.log("[" + host + "] deploying " + m.containerName);
      let containerStarted = false;

      try {
        if (envLocalFile && m.envRemotePath) {
          await exec.run("mkdir -p ~/.bundant/env");
          await exec.putFile(envLocalFile, m.envRemotePath, "600");
          console.log("[" + host + "] env uploaded (" + loaded.envCount + " vars, redacted)");
        }

        for (const step of plan.hostSteps) {
          if (step.phase === "push-image" && local) {
            const pipeline = step.cmds[0].replaceAll("{HOST}", host);
            const r = await local.run(pipeline);
            if (r.code !== 0) {
              throw new Error(
                "[" + host + "] push-image failed: " + (r.stderr.trim() || r.stdout.trim()),
              );
            }
            console.log("[" + host + "] push-image ok: " + r.stdout.trim());
            continue;
          }
          if (step.phase === "health") {
            await waitUntilHealthy(exec, step.cmds[0], {
              timeoutMs: m.healthcheck.timeout * 1000,
            });
            console.log("[" + host + "] health gate passed");
            continue;
          }
          for (const cmd of step.cmds) {
            const r = await exec.run(cmd);
            if (r.code !== 0) {
              throw new Error(
                "[" + host + "] " + step.phase + " failed: cmd=" + cmd + " err=" +
                  (r.stderr.trim() || r.stdout.trim()),
              );
            }
            if (step.phase === "run") containerStarted = true;
          }
          console.log("[" + host + "] " + step.phase + " ok");
        }
      } catch (e) {
        if (containerStarted) {
          const rm = await exec.run(rt.bin + " rm -f " + m.containerName);
          console.log(
            "[" + host + "] aborted, removed failed container " + m.containerName +
            (rm.code === 0 ? "" : " (rm failed: " + rm.stderr.trim() + ")"),
          );
        } else {
          console.log("[" + host + "] aborted before container start");
        }
        throw e;
      }
    }

    console.log("deployed " + m.containerName + " on " + m.hosts.length + " host(s)");
    return 0;
  } finally {
    if (locked) await releaseLock(primary, m.service);
    for (const e of execs) await e.close();
  }
}
