import { describe, expect, test } from "bun:test";
import {
  planBootstrap,
  parseProbe,
  socketStep,
  lingerStep,
  type BootstrapProbe,
  type OsRelease,
} from "./bootstrap.ts";

function os(id: string): OsRelease {
  return { id, idLike: [], versionId: "", prettyName: id };
}

const ready: BootstrapProbe = {
  os: os("ubuntu"),
  family: "apt",
  hasPodman: true,
  hasDocker: false,
  hasSystemd: true,
  inContainer: "",
  uid: "0",
};

describe("bootstrap runtime awareness", () => {
  test("probe output carries the uid", () => {
    const probe = parseProbe("BUNDANT_OS ID=ubuntu\nBUNDANT_BIN podman\nBUNDANT_UID 0\n");
    expect(probe.uid).toBe("0");
    expect(probe.hasDocker).toBe(false);
  });

  test("docker hosts: reachability only, no podman install/socket steps", () => {
    const steps = planBootstrap(ready, { runtime: "docker" });
    expect(steps.map((s) => s.label)).toEqual(["docker reachability", "docker version"]);
    expect(steps.some((s) => s.label.includes("podman"))).toBe(false);
    expect(steps[0]?.cmd).toContain("bundant leaves it alone");
  });

  test("podman hosts: socket step runs after the restart unit", () => {
    const labels = planBootstrap(ready).map((s) => s.label);
    expect(labels).toContain("podman API socket");
    expect(labels.indexOf("podman API socket")).toBeGreaterThan(labels.indexOf("boot-time restart unit"));
  });

  test("rootful has no linger step, rootless does", () => {
    expect(planBootstrap({ ...ready, uid: "0" }).some((s) => s.label === "rootless linger")).toBe(false);
    expect(planBootstrap({ ...ready, uid: "1000" }).some((s) => s.label === "rootless linger")).toBe(true);
  });

  test("socket step is idempotent and says so on the second run", () => {
    const cmd = socketStep().cmd;
    expect(cmd).toContain("is-enabled podman.socket");
    expect(cmd).toContain("enable --now podman.socket");
    expect(cmd).toContain("already enabled and active");
    expect(cmd).toContain('s="--user"');
  });

  test("linger step checks Linger before enabling", () => {
    const cmd = lingerStep().cmd;
    expect(cmd).toContain("loginctl show-user");
    expect(cmd).toContain("enable-linger");
    expect(cmd).toContain("already enabled");
  });
});
