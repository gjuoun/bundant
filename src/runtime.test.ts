import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "./exec/local.ts";
import { portGuardCommand, runtimeCheckCommands, runtimeFor } from "./runtime.ts";

const exec = new LocalExecutor();

const SYSTEMCTL = [
  "#!/bin/sh",
  'echo "systemctl $*" >> "$STATE_DIR/calls.log"',
  'if [ "$1" = "--user" ] && [ "$2" = "is-enabled" ]; then',
  '  [ -f "$STATE_DIR/restart-enabled" ] && exit 0 || exit 1',
  "fi",
  'if [ "$1" = "--user" ] && [ "$2" = "enable" ]; then',
  '  touch "$STATE_DIR/restart-enabled"',
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n");

const LOGINCTL = [
  "#!/bin/sh",
  'echo "loginctl $*" >> "$STATE_DIR/calls.log"',
  'if [ "$1" = "show-user" ]; then',
  '  if [ -f "$STATE_DIR/linger" ]; then echo yes; else echo no; fi',
  "  exit 0",
  "fi",
  'if [ "$1" = "enable-linger" ]; then',
  '  touch "$STATE_DIR/linger"',
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n");

const SYSCTL = [
  "#!/bin/sh",
  'echo "sysctl $*" >> "$STATE_DIR/calls.log"',
  'if [ "$1" = "-n" ] && [ "$2" = "net.ipv4.ip_unprivileged_port_start" ]; then',
  '  echo "$FAKE_PORT_FLOOR"',
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n");

function makeState(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "bundant-rt-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["systemctl", SYSTEMCTL],
    ["loginctl", LOGINCTL],
    ["sysctl", SYSCTL],
  ] as const) {
    const p = join(bin, name);
    writeFileSync(p, body, { mode: 0o755 });
  }
  return { dir, bin };
}

function calls(dir: string): string {
  const p = join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Exported, not inline: inline VAR=... only binds the first command of a || chain. */
function envPrefix(dir: string, bin: string, extra = ""): string {
  return (
    'export STATE_DIR="' + dir + '"; export PATH="' + bin + ':$PATH"; ' + extra + " "
  );
}

describe("runtimeCheckCommands (rootless podman boot persistence)", () => {
  test("docker emits nothing at all", () => {
    expect(runtimeCheckCommands(runtimeFor("docker"))).toEqual([]);
    expect(portGuardCommand(runtimeFor("docker"))).toBeNull();
  });

  test("first run enables podman-restart.service and linger", async () => {
    const { dir, bin } = makeState();
    for (const cmd of runtimeCheckCommands(runtimeFor("podman"))) {
      const r = await exec.run(envPrefix(dir, bin) + cmd);
      expect(r.code).toBe(0);
    }
    expect(existsSync(join(dir, "restart-enabled"))).toBe(true);
    expect(existsSync(join(dir, "linger"))).toBe(true);
    const log = calls(dir);
    expect(count(log, "systemctl --user enable --now podman-restart.service")).toBe(1);
    expect(count(log, "loginctl enable-linger")).toBe(1);
  });

  test("second run is a no-op: checks run, enables do not", async () => {
    const { dir, bin } = makeState();
    const cmds = runtimeCheckCommands(runtimeFor("podman"));
    for (const cmd of cmds) {
      await exec.run(envPrefix(dir, bin) + cmd);
    }
    const afterFirst = calls(dir);
    for (const cmd of cmds) {
      const r = await exec.run(envPrefix(dir, bin) + cmd);
      expect(r.code).toBe(0);
    }
    const log = calls(dir);
    expect(count(log, "systemctl --user is-enabled podman-restart.service")).toBe(2);
    expect(count(log, "loginctl show-user")).toBe(2);
    expect(count(log, "systemctl --user enable --now")).toBe(1);
    expect(count(log, "loginctl enable-linger")).toBe(1);
    expect(count(afterFirst, "systemctl --user enable --now")).toBe(1);
    expect(count(afterFirst, "loginctl enable-linger")).toBe(1);
    expect(count(afterFirst, "systemctl --user is-enabled")).toBe(1);
  });
});

describe("portGuardCommand (informational host floor check)", () => {
  test("never aborts: a high floor prints a note and exits 0", async () => {
    const { dir, bin } = makeState();
    const guard = portGuardCommand(runtimeFor("podman"))!;
    const r = await exec.run(
      envPrefix(dir, bin, "export FAKE_PORT_FLOOR=1024;") + guard,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("net.ipv4.ip_unprivileged_port_start is 1024");
    expect(r.stdout).toContain("--sysctl");
  });

  test("floor 80 is silent and exits 0", async () => {
    const { dir, bin } = makeState();
    const guard = portGuardCommand(runtimeFor("podman"))!;
    const r = await exec.run(
      envPrefix(dir, bin, "export FAKE_PORT_FLOOR=80;") + guard,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("note");
  });

  test("an unreadable floor notes it and exits 0", async () => {
    const { dir, bin } = makeState();
    const guard = portGuardCommand(runtimeFor("podman"))!;
    const r = await exec.run(
      envPrefix(dir, bin, "export FAKE_PORT_FLOOR=;") + guard,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unreadable");
  });
});
