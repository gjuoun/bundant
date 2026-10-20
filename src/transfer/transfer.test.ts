import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { runtimeFor } from "../runtime.ts";
import {
  countStream,
  isMissingBlobError,
  transferLocalImage,
  type SaveStream,
  type TransferOps,
} from "./transfer.ts";

const BLOCK = 512;
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}
function header(name: string, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, "utf8");
  buf.write(octal(0o644, 8), 100, 8, "utf8");
  buf.write(octal(size, 13), 124, 13, "utf8");
  buf.fill(0x20, 148, 156);
  buf[156] = 0x30;
  buf.write("ustar\0", 257, 6, "latin1");
  buf.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "utf8");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}
function makeTar(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry.name, entry.data.length), entry.data);
    const pad = entry.data.length % BLOCK;
    if (pad !== 0) parts.push(Buffer.alloc(BLOCK - pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
function sha(data: Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}
function fixture(): { tar: Buffer; diff1: string; diff2: string } {
  const one = Buffer.from("layer one");
  const two = Buffer.from("layer two ".repeat(50));
  const gz1 = gzipSync(one);
  const gz2 = gzipSync(two);
  const config = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: [sha(one), sha(two)] },
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: sha(config),
      size: config.length,
    },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha(gz1), size: gz1.length },
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha(gz2), size: gz2.length },
    ],
  }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [] }));
  return {
    tar: makeTar([
      { name: "blobs/sha256/" + sha(gz1).slice(7), data: gz1 },
      { name: "blobs/sha256/" + sha(gz2).slice(7), data: gz2 },
      { name: "blobs/sha256/" + sha(config).slice(7), data: config },
      { name: "blobs/sha256/" + sha(manifest).slice(7), data: manifest },
      { name: "index.json", data: index },
      { name: "oci-layout", data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
    ]),
    diff1: sha(one),
    diff2: sha(two),
  };
}

const rt = runtimeFor("docker");

function localExec() {
  return {
    kind: "local" as const,
    async run() {
      return { code: 0, stdout: "[]", stderr: "" };
    },
    async putFile() {},
    async close() {},
  };
}

function save(tar: Buffer): SaveStream {
  return { stream: Readable.from([tar]), done: Promise.resolve() };
}

describe("local image delta transfer", () => {
  test("a host holding one layer gets a delta with the other layer only", async () => {
    const { tar, diff1, diff2 } = fixture();
    const loads: Buffer[] = [];
    const ops: TransferOps = {
      async imageLayers() {
        return new Set([diff1]);
      },
      async loadImage(stream) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        loads.push(Buffer.concat(chunks));
      },
    };
    const report = await transferLocalImage(ops, "app:t2", {
      rt,
      local: {
        ...localExec(),
        async run() {
          return { code: 0, stdout: JSON.stringify([diff1, diff2]), stderr: "" };
        },
      },
      openSave: () => save(tar),
    });

    expect(report.mode).toBe("delta");
    expect(report.layersTotal).toBe(2);
    expect(report.layersReused).toBe(1);
    expect(report.missingLayers).toBe(1);
    expect(report.bytesSent).toBeGreaterThan(0);
    expect(loads).toHaveLength(1);
  });

  test("a missing-blob refusal retries once with the full archive", async () => {
    const { tar, diff1, diff2 } = fixture();
    const loads: Buffer[] = [];
    let call = 0;
    const ops: TransferOps = {
      async imageLayers() {
        return new Set([diff1]);
      },
      async loadImage(stream) {
        call += 1;
        if (call === 1) {
          stream.resume();
          throw new Error(
            "engine image load failed: apply layer error: NotFound: failed to get reader from content store: content digest not found",
          );
        }
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        loads.push(Buffer.concat(chunks));
      },
    };
    const report = await transferLocalImage(ops, "app:t2", {
      rt,
      local: {
        ...localExec(),
        async run() {
          return { code: 0, stdout: JSON.stringify([diff1, diff2]), stderr: "" };
        },
      },
      openSave: () => save(tar),
    });

    expect(call).toBe(2);
    expect(loads).toHaveLength(1);
    expect(loads[0]).toEqual(tar);
    expect(report.mode).toBe("full");
    expect(report.fallback).toContain("not found");
    expect(report.bytesSent).toBe(tar.length);
  });

  test("a non-blob load error is not retried", async () => {
    const { tar, diff1, diff2 } = fixture();
    let call = 0;
    const ops: TransferOps = {
      async imageLayers() {
        return new Set<string>();
      },
      async loadImage(stream) {
        call += 1;
        stream.resume();
        throw new Error("engine API POST /images/load -> 500: disk full");
      },
    };
    await expect(
      transferLocalImage(ops, "app:t2", {
        rt,
        local: {
          ...localExec(),
          async run() {
            return { code: 0, stdout: JSON.stringify([diff1, diff2]), stderr: "" };
          },
        },
        openSave: () => save(tar),
      }),
    ).rejects.toThrow("disk full");
    expect(call).toBe(1);
  });

  test("countStream reports the bytes that pass through", async () => {
    const counted = countStream(Readable.from([Buffer.from("abc"), Buffer.from("de")]));
    for await (const _chunk of counted.stream) {
      // drain
    }
    expect(counted.bytes()).toBe(5);
  });

  test("missing-blob classification", () => {
    expect(isMissingBlobError(new Error("NotFound: content digest not found"))).toBe(true);
    expect(isMissingBlobError(new Error("manifest references layer absent"))).toBe(true);
    expect(isMissingBlobError(new Error("config references layer x"))).toBe(true);
    expect(isMissingBlobError(new Error("permission denied"))).toBe(false);
    expect(isMissingBlobError(new Error("load -> 500: disk full"))).toBe(false);
  });
});
