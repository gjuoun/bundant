#!/usr/bin/env bun
/**
 * Host smoke probe: proves ssh transport + container runtime + kamal-proxy
 * availability and captures the live kamal-proxy flag surface for drift checks.
 *
 * usage: bun run src/probe/ssh-smoke.ts <host> [docker|podman]
 */
import { SshExecutor } from "../exec/ssh.ts";
import { ensure as ensureProxy, PROXY_CONTAINER } from "../commands/proxy.ts";
import { ensureNetwork } from "../commands/docker.ts";
import { runtimeFor, type RuntimeKind } from "../runtime.ts";

const host = process.argv[2];
if (!host) {
  console.error("usage: bun run src/probe/ssh-smoke.ts <host> [docker|podman]");
  process.exit(2);
}
const runtimeArg = (process.argv[3] ?? "docker") as RuntimeKind;
if (runtimeArg !== "docker" && runtimeArg !== "podman") {
  console.error("usage: runtime must be docker or podman");
  process.exit(2);
}
const rt = runtimeFor(runtimeArg);

const HELP_PATH = "/tmp/jun/bundant-mvp/proxy-live-help.txt";
const exec = new SshExecutor({ host });
let failed = 0;

const version = await exec.run(rt.bin + " version --format '{{.Server.Version}}'");
if (version.code !== 0) {
  console.error(host + ": " + rt.kind + " unreachable — " + version.stderr.trim());
  process.exit(1);
}
console.log(rt.kind + "-server " + version.stdout.trim());

const net = await exec.run(ensureNetwork(rt));
if (net.code !== 0) {
  console.error("network create failed: " + net.stderr.trim());
  failed = 1;
}

const ensure = await exec.run(ensureProxy(rt));
if (ensure.code !== 0) {
  console.error("kamal-proxy ensure failed: " + ensure.stderr.trim());
  process.exit(1);
}

const help = await exec.run(
  rt.bin + " exec " + PROXY_CONTAINER + " kamal-proxy help deploy",
);
if (help.code !== 0) {
  console.error("kamal-proxy help failed: " + help.stderr.trim());
  process.exit(1);
}
await Bun.write(HELP_PATH, help.stdout);
const lines = help.stdout.trim().split("\n").length;
const hasHealthFlag = help.stdout.includes("--health-check-path");
console.log("proxy-help captured: " + lines + " lines -> " + HELP_PATH);
console.log(
  hasHealthFlag
    ? "flag-check ok: --health-check-path present"
    : "flag-check DRIFT: --health-check-path missing — update src/commands/proxy.ts",
);

await exec.close();
process.exit(failed);
