import { describe, expect, test } from "bun:test";
import { DEFAULT_GROUP, type BundantConfig, type LoadedConfig } from "../config.ts";
import { buildDeployPlan } from "../planner.ts";
import { deploy } from "../deploy.ts";
import { ArchMismatchError, codeFor } from "../agent/errors.ts";
import { normalizeArch } from "../platform.ts";
import { runtimeFor } from "../runtime.ts";
import type { Executor } from "../types.ts";
import { binfmtPath, checkArch } from "./arch.ts";
import { defaultArchPreflight, probeBinfmtPresent } from "./probe.ts";

const IMAGE = "app:t1";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    version: 2,
    service: "hello",
    image: IMAGE,
    role: "web",
    replicas: 1,
    kind: "service",
    group: DEFAULT_GROUP,
    hosts: ["root@host1"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: false, port: 80, tls: false, image: "kamal-proxy" },
    ...over,
  };
}

function loadedFor(config: BundantConfig): LoadedConfig {
  return { config, envContent: null, envCount: 0, path: "/tmp/deploy.yml", version: 2 };
}

function fakeExec(outputs: Record<string, string> = {}): { exec: Executor; calls: string[] } {
  const calls: string[] = [];
  const exec: Executor = {
    kind: "local",
    async run(cmd: string) {
      calls.push(cmd);
      const key = Object.keys(outputs).find((k) => cmd.includes(k));
      return { code: key === undefined ? 0 : 0, stdout: key === undefined ? "" : outputs[key]!, stderr: "" };
    },
    async putFile() {},
    async close() {},
  };
  return { exec, calls };
}

describe("platform normalization", () => {
  test("folds uname and OCI spellings", () => {
    expect(normalizeArch("x86_64")).toBe("amd64");
    expect(normalizeArch("aarch64")).toBe("arm64");
    expect(normalizeArch("armv7l")).toBe("arm");
    expect(normalizeArch("AMD64")).toBe("amd64");
  });
});

describe("checkArch", () => {
  const linuxAmd64 = { os: "linux", arch: "amd64" };
  const linuxArm64 = { os: "linux", arch: "arm64" };

  test("matching platforms are native", () => {
    expect(
      checkArch({
        image: IMAGE,
        imagePlatform: linuxAmd64,
        hostPlatform: linuxAmd64,
        allowEmulation: false,
        binfmtPresent: false,
      }).emulated,
    ).toBe(false);
  });

  test("a mismatch is ARCH_MISMATCH naming both sides and the ref", () => {
    try {
      checkArch({
        image: IMAGE,
        imagePlatform: linuxArm64,
        hostPlatform: linuxAmd64,
        allowEmulation: false,
        binfmtPresent: false,
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArchMismatchError);
      expect(codeFor(err as ArchMismatchError)).toBe("ARCH_MISMATCH");
      const message = (err as ArchMismatchError).message;
      expect(message).toContain(IMAGE);
      expect(message).toContain("linux/arm64");
      expect(message).toContain("linux/amd64");
    }
  });

  test("--allow-emulation without a binfmt entry is still an error", () => {
    expect(() =>
      checkArch({
        image: IMAGE,
        imagePlatform: linuxArm64,
        hostPlatform: linuxAmd64,
        allowEmulation: true,
        binfmtPresent: false,
      }),
    ).toThrow(ArchMismatchError);
  });

  test("--allow-emulation with the matching binfmt entry is a warning-grade verdict", () => {
    const verdict = checkArch({
      image: IMAGE,
      imagePlatform: linuxArm64,
      hostPlatform: linuxAmd64,
      allowEmulation: true,
      binfmtPresent: true,
    });
    expect(verdict.emulated).toBe(true);
    expect(binfmtPath("arm64")).toBe("/proc/sys/fs/binfmt_misc/qemu-arm64");
  });
});

describe("arch preflight in the deploy path", () => {
  test("a local image mismatch stops before lock and before any engine/ssh call", async () => {
    const calls: string[] = [];
    const exec = {
      kind: "local" as const,
      async run(cmd: string) {
        calls.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      },
      async putFile() {},
      async close() {},
    };
    const plan = buildDeployPlan(cfg(), "r0", { localImage: IMAGE });
    await expect(
      deploy(plan, loadedFor(cfg()), {
        openPrimary: () => exec as never,
        archPreflight: async () => {
          throw new ArchMismatchError({ message: "arch mismatch: injected" });
        },
      }),
    ).rejects.toBeInstanceOf(ArchMismatchError);
    expect(calls).toEqual([]);
  });

  test("the default probe reads uname and the local image inspect only", async () => {
    const host = fakeExec({ "uname -s -m": "Linux x86_64\n" });
    const local = fakeExec({ "image inspect": "aarch64 linux \n" });
    await expect(
      defaultArchPreflight({
        image: IMAGE,
        isLocal: true,
        allowEmulation: false,
        exec: host.exec,
        rt: runtimeFor("docker"),
        local: local.exec,
      }),
    ).rejects.toBeInstanceOf(ArchMismatchError);
    expect(host.calls).toEqual(["uname -s -m"]);
    expect(local.calls).toHaveLength(1);
  });

  test("the default probe falls through to the other local engine", async () => {
    const host = fakeExec({ "uname -s -m": "Linux x86_64\n" });
    const local: Executor = {
      kind: "local",
      async run(cmd: string) {
        // podman does not have the image; docker does (a cross-engine build).
        if (cmd.startsWith("podman")) return { code: 1, stdout: "", stderr: "no such image" };
        return { code: 0, stdout: "aarch64 linux \n", stderr: "" };
      },
      async putFile() {},
      async close() {},
    };
    await expect(
      defaultArchPreflight({
        image: IMAGE,
        isLocal: true,
        allowEmulation: false,
        exec: host.exec,
        rt: runtimeFor("podman"),
        local,
      }),
    ).rejects.toBeInstanceOf(ArchMismatchError);
  });

  test("binfmt is read from the image arch path, not the host arch", async () => {
    const host = fakeExec({ "test -e": "yes\n" });
    expect(await probeBinfmtPresent(host.exec, "arm64")).toBe(true);
    expect(host.calls[0]).toContain("qemu-arm64");
  });
});
