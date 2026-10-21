import { describe, expect, test } from "bun:test";
import { ApiClient } from "./api.ts";
import {
  DetectionError,
  detectRuntime,
  parseEngineVersion,
  socketCandidates,
  type SocketProbe,
  type VersionPayload,
} from "./detect.ts";
import { FakeDockerSocket, json } from "./fake-socket.ts";

const DOCKER_VERSION: VersionPayload = {
  Version: "29.1.3",
  ApiVersion: "1.52",
  MinAPIVersion: "1.24",
  Components: [
    { Name: "Engine", Version: "29.1.3" },
    { Name: "Docker Engine", Version: "29.1.3" },
  ],
};

const PODMAN_VERSION: VersionPayload = {
  Version: "5.7.0",
  ApiVersion: "1.41",
  MinAPIVersion: "1.24",
  Components: [{ Name: "Podman Engine", Version: "5.7.0", Details: { APIVersion: "5.7.0", MinAPIVersion: "4.0.0" } }],
};

async function probeAt(socketPath: string): Promise<SocketProbe> {
  const client = await ApiClient.create({ socketPath, preferDockerode: false });
  return {
    socketPath,
    probe: async () => {
      const res = await client.request("GET", "/version");
      return res.json as VersionPayload;
    },
    dispose: async () => client.close(),
  };
}

async function fakeVersion(payload: VersionPayload): Promise<FakeDockerSocket> {
  return await FakeDockerSocket.create((req, res) => {
    if (req.url === "/version") json(res, 200, payload);
    else json(res, 404, { message: "not found" });
  });
}

describe("parseEngineVersion", () => {
  test("docker-shaped response", () => {
    expect(parseEngineVersion(DOCKER_VERSION)).toEqual({
      kind: "docker",
      version: "29.1.3",
      apiVersion: "1.52",
      minApiVersion: "1.24",
    });
  });

  test("keeps arch, os and kernel from /version", () => {
    const engine = parseEngineVersion({
      ...DOCKER_VERSION,
      Arch: "aarch64",
      Os: "linux",
      KernelVersion: "6.8.0-45-generic",
    });
    expect(engine.arch).toBe("aarch64");
    expect(engine.os).toBe("linux");
    expect(engine.kernelVersion).toBe("6.8.0-45-generic");
  });

  test("a payload without platform fields keeps the old shape", () => {
    expect(parseEngineVersion(DOCKER_VERSION)).not.toHaveProperty("arch");
  });

  test("podman-shaped response wins on the component name", () => {
    const engine = parseEngineVersion(PODMAN_VERSION);
    expect(engine.kind).toBe("podman");
    expect(engine.version).toBe("5.7.0");
    expect(engine.apiVersion).toBe("5.7.0");
  });
});

describe("detectRuntime", () => {
  test("docker socket answering /version", async () => {
    const server = await fakeVersion(DOCKER_VERSION);
    try {
      const probe = await probeAt(server.socketPath);
      const detection = await detectRuntime({ probes: [probe], expect: "docker" });
      expect(detection.found).toBe(true);
      expect(detection.kind).toBe("docker");
      expect(detection.engineVersion).toBe("29.1.3");
      expect(detection.apiVersion).toBe("1.52");
      expect(detection.socketPath).toBe(server.socketPath);
      expect(detection.state).toBe("active");
    } finally {
      await server.close();
    }
  });

  test("podman socket answering /version", async () => {
    const server = await fakeVersion(PODMAN_VERSION);
    try {
      const detection = await detectRuntime({
        probes: [await probeAt(server.socketPath)],
        expect: "podman",
      });
      expect(detection.kind).toBe("podman");
      expect(detection.engineVersion).toBe("5.7.0");
      expect(detection.apiVersion).toBe("5.7.0");
    } finally {
      await server.close();
    }
  });

  test("no socket at all is reported, not thrown", async () => {
    const detection = await detectRuntime({ probes: [await probeAt("/tmp/bundant-no-such.sock")] });
    expect(detection.found).toBe(false);
    expect(detection.state).toBe("absent");
    expect(detection.candidates[0]?.state).toBe("absent");
  });

  test("socket file present but nothing listening is inactive, distinct from absent", async () => {
    const stale = await FakeDockerSocket.staleFile();
    try {
      const detection = await detectRuntime({ probes: [await probeAt(stale.socketPath)] });
      expect(detection.found).toBe(false);
      expect(detection.state).toBe("inactive");
      expect(detection.candidates[0]?.state).toBe("inactive");
    } finally {
      await stale.close();
    }
  });

  test("config runtime is authoritative: a mismatch throws a clear error", async () => {
    const server = await fakeVersion(DOCKER_VERSION);
    try {
      const err = await detectRuntime({
        probes: [await probeAt(server.socketPath)],
        expect: "podman",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DetectionError);
      expect((err as Error).message).toContain("host has docker 29.1.3");
      expect((err as Error).message).toContain("deploy.yml says podman");
    } finally {
      await server.close();
    }
  });

  test("candidate order matches the design doc", () => {
    expect(socketCandidates(1000)).toEqual([
      "/var/run/docker.sock",
      "/run/podman/podman.sock",
      "/run/user/1000/podman/podman.sock",
    ]);
  });
});
