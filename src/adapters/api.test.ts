import { describe, expect, test } from "bun:test";
import { ApiClient, ApiError, DockerStreamDemuxer, demuxDockerStream } from "./api.ts";
import { FakeDockerSocket, json } from "./fake-socket.ts";

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
}

describe("ApiClient ladder", () => {
  test("native node:http over socketPath needs no dockerode", async () => {
    const server = await FakeDockerSocket.create((req, res) => {
      if (req.url === "/version") {
        json(res, 200, { Version: "29.1.3", ApiVersion: "1.52" });
        return;
      }
      json(res, 404, { message: "not found" });
    });
    try {
      const client = await ApiClient.create({ socketPath: server.socketPath, preferDockerode: false });
      expect(client.driver).toBe("native");
      const res = await client.request("GET", "/version");
      expect(res.status).toBe(200);
      expect((res.json as { Version: string }).Version).toBe("29.1.3");
      expect(res.stream).toBeNull();
      await client.close();
    } finally {
      await server.close();
    }
  });

  test("JSON error bodies become typed ApiErrors", async () => {
    const server = await FakeDockerSocket.create((_req, res) => {
      json(res, 404, { message: "No such container: api-1" });
    });
    try {
      const client = await ApiClient.create({ socketPath: server.socketPath, preferDockerode: false });
      const err = await client.request("GET", "/containers/api-1/json").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      const api = err as ApiError;
      expect(api.status).toBe(404);
      expect(api.message).toContain("No such container: api-1");
      expect(api.body).toEqual({ message: "No such container: api-1" });
    } finally {
      await server.close();
    }
  });
});

describe("docker stream demux", () => {
  test("round-trips hand-built frames", () => {
    const buf = Buffer.concat([frame(1, "hello\n"), frame(2, "oops\n"), frame(1, "bye\n")]);
    const frames = demuxDockerStream(buf);
    expect(frames.map((f) => f.stream)).toEqual(["stdout", "stderr", "stdout"]);
    expect(frames.map((f) => f.data.toString())).toEqual(["hello\n", "oops\n", "bye\n"]);
  });

  test("non-multiplexed output is one stdout frame", () => {
    const frames = demuxDockerStream(Buffer.from("plain tty output\n"));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.stream).toBe("stdout");
    expect(frames[0]?.data.toString()).toBe("plain tty output\n");
  });

  test("incremental demuxer survives a split header and split payload", () => {
    const whole = Buffer.concat([frame(1, "first line\n"), frame(2, "second line\n")]);
    const demuxer = new DockerStreamDemuxer();
    const out = [
      ...demuxer.push(whole.subarray(0, 3)),
      ...demuxer.push(whole.subarray(3, 12)),
      ...demuxer.push(whole.subarray(12, 21)),
      ...demuxer.push(whole.subarray(21)),
      ...demuxer.flush(),
    ];
    expect(out.map((f) => f.stream)).toEqual(["stdout", "stderr"]);
    expect(out.map((f) => f.data.toString())).toEqual(["first line\n", "second line\n"]);
  });
});
