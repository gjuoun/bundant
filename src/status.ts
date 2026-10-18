import type { LoadedConfig } from "./config.ts";
import * as docker from "./commands/docker.ts";
import * as proxy from "./commands/proxy.ts";
import { SshExecutor } from "./exec/ssh.ts";
import { hostTargets } from "./hosts.ts";
import { runtimeFor } from "./runtime.ts";

/** Per-host truth: containers of this service, proxy routing, live health probe. */
export async function status(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  const rt = runtimeFor(config.runtime);
  let exit = 0;

  for (const host of hostTargets(config)) {
    const exec = new SshExecutor({ host });
    console.log("== " + host + " ==");

    const ps = await exec.run(docker.listForStatus(rt, config.service, config.role));
    if (ps.code !== 0) {
      console.log("  containers: query failed — " + ps.stderr.trim());
      exit = 1;
    } else {
      const lines = ps.stdout.trim().split("\n").filter((l) => l !== "");
      if (lines.length === 0) console.log("  containers: none");
      for (const line of lines) console.log("  " + line);

      const current = lines.find((l) => l.includes(" Up "));
      if (current) {
        const name = current.split(" ")[0];
        const probe = await exec.run(
          docker.probe(rt, name, config.healthcheck.port, config.healthcheck.path),
        );
        console.log("  health(" + name + "): HTTP " + (probe.stdout.trim() || "err"));
      } else {
        console.log("  health: no running container");
      }
    }

    const proxyUp = await exec.run(docker.inspectRunning(rt, proxy.PROXY_CONTAINER));
    if (proxyUp.stdout.trim() === "true") {
      const list = await exec.run(proxy.list(rt));
      const rows = list.stdout.trim().split("\n").filter((l) => l !== "");
      console.log("  proxy (" + proxy.PROXY_CONTAINER + "):");
      for (const row of rows) console.log("    " + row);
    } else {
      console.log("  proxy: not running");
    }

    await exec.close();
  }
  return exit;
}
