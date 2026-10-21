import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerSpec } from "../adapters/types.ts";
import type { RuntimeOps } from "../ops/types.ts";
import { runtimeFor } from "../runtime.ts";
import { installOnHost } from "./install.ts";
import {
  SESSIOND_CONTAINER,
  foldSessionEvents,
  sessiondImageFor,
  sessiondRunArgs,
  sessiondSpec,
} from "./plan.ts";

function event(over: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    time: "2026-10-20T12:00:00Z",
    event: "session.open",
    session: "s-1",
    mode: "pidfd",
    ...over,
  });
}

function fakeOps(options: { imageArch?: string; hostArch?: string } = {}): {
  ops: RuntimeOps;
  calls: string[];
  created: ContainerSpec[];
  loaded: () => number;
} {
  const calls: string[] = [];
  const created: ContainerSpec[] = [];
  let loaded = 0;
  const ops = {
    steps: [],
    async hostPlatform() {
      return { os: "linux", arch: options.hostArch ?? "amd64" };
    },
    async imagePlatform() {
      return { os: "linux", arch: options.imageArch ?? "amd64" };
    },
    async binfmtPresent() {
      return false;
    },
    async loadImage(stream: NodeJS.ReadableStream) {
      loaded += 1;
      for await (const chunk of stream) void chunk;
    },
    async imagePresent() {
      return false;
    },
    async imageLayers() {
      return new Set<string>();
    },
    async imageId() {
      return undefined;
    },
    async removeContainer(name: string) {
      calls.push("remove:" + name);
    },
    async createContainer(spec: ContainerSpec) {
      created.push(spec);
      return spec.name;
    },
    async startContainer(name: string) {
      calls.push("start:" + name);
    },
    async readFile() {
      return "";
    },
  } as unknown as RuntimeOps;
  return { ops, calls, created, loaded: () => loaded };
}

describe("sessiond plan", () => {
  test("the spec carries the documented isolation flags", () => {
    const spec = sessiondSpec("bundant/sessiond:test");
    expect(spec.name).toBe(SESSIOND_CONTAINER);
    expect(spec.network).toBe("none");
    expect(spec.pidMode).toBe("host");
    expect(spec.cgroupns).toBe("host");
    expect(spec.readonly).toBe(true);
    expect(spec.securityOpt).toEqual(["no-new-privileges"]);
    expect(spec.volumes).toContain("/run/bundant:/run/bundant");
    expect(spec.volumes).toContain("/var/lib/bundant:/var/lib/bundant");
    expect(sessiondRunArgs("i")[0]).toBe("run");
    expect(sessiondRunArgs("i")).toContain("--cgroupns=host");
  });

  test("the image tag follows the host arch", () => {
    expect(sessiondImageFor("amd64")).toBe("bundant/sessiond:0.1.0-amd64");
    expect(sessiondImageFor("arm64", "x/y:1")).toBe("x/y:1-arm64");
  });

  test("open and closed events fold to the open set and a mode", () => {
    const folded = foldSessionEvents([
      event({}),
      event({ session: "s-2", agent: "a2", pid: 7, mode: "cgroupv2" }),
      event({ event: "session.closed", session: "s-1", mode: "cgroupv2" }),
      "not json",
    ].join("\n"));
    expect(folded.events).toBe(3);
    expect(folded.malformed).toBe(1);
    expect(folded.sessions.map((s) => s.session)).toEqual(["s-2"]);
    expect(folded.mode).toBe("cgroupv2");
    expect(folded.degraded).toBe(true);
  });

  test("pidfd-only history is not degraded", () => {
    const folded = foldSessionEvents(event({}));
    expect(folded.degraded).toBe(false);
    expect(folded.mode).toBe("pidfd");
  });

  test("install is idempotent and uses the per-arch tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-sessiond-"));
    try {
      const archive = join(dir, "sessiond.tar");
      writeFileSync(archive, "tar-bytes");
      const { ops, calls, created } = fakeOps();
      const result = await installOnHost({
        host: "root@docker01",
        ops,
        rt: runtimeFor("docker"),
        allowEmulation: false,
        from: archive,
      });
      expect(result.image).toBe("bundant/sessiond:0.1.0-amd64");
      expect(calls).toEqual(["remove:" + SESSIOND_CONTAINER, "start:" + SESSIOND_CONTAINER]);
      expect(created[0]!.pidMode).toBe("host");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--from loads an archive instead of transferring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-sessiond-"));
    try {
      const archive = join(dir, "sessiond.tar");
      writeFileSync(archive, "tar-bytes");
      const { ops, loaded } = fakeOps();
      const result = await installOnHost({
        host: "root@docker01",
        ops,
        rt: runtimeFor("docker"),
        allowEmulation: false,
        from: archive,
        image: "bundant/sessiond:local",
      });
      expect(result.fromArchive).toBe(true);
      expect(loaded()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
