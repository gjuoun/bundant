import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildOciDelta, type DeltaStats } from "./oci.ts";

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "utf8");
  header.write(octal(0, 8), 108, 8, "utf8");
  header.write(octal(0, 8), 116, 8, "utf8");
  header.write(octal(size, 13), 124, 13, "utf8");
  header.write(octal(0, 13), 136, 13, "utf8");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "utf8");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function makeTar(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.name, entry.data.length), entry.data);
    const pad = entry.data.length % BLOCK;
    if (pad !== 0) parts.push(Buffer.alloc(BLOCK - pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function parseTar(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0",
      8,
    );
    offset += BLOCK;
    out.set(name, tar.subarray(offset, offset + size));
    offset += size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
  }
  return out;
}

function sha(data: Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

interface FixtureLayer {
  plain: Buffer;
  gzip: boolean;
}

function ociFixture(layers: FixtureLayer[], tag = "app:t2"): Buffer {
  const blobs: { name: string; data: Buffer }[] = [];
  const manifestLayers: { mediaType: string; digest: string; size: number }[] = [];
  const diffIds: string[] = [];
  for (const layer of layers) {
    const stored = layer.gzip ? gzipSync(layer.plain) : layer.plain;
    blobs.push({ name: "blobs/sha256/" + sha(stored).slice(7), data: stored });
    manifestLayers.push({
      mediaType: layer.gzip
        ? "application/vnd.oci.image.layer.v1.tar+gzip"
        : "application/vnd.oci.image.layer.v1.tar",
      digest: sha(stored),
      size: stored.length,
    });
    diffIds.push(sha(layer.plain));
  }
  const config = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: diffIds },
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: sha(config),
      size: config.length,
    },
    layers: manifestLayers,
  }));
  const index = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha(manifest), size: manifest.length }],
  }));
  return makeTar([
    ...blobs,
    { name: "blobs/sha256/" + sha(config).slice(7), data: config },
    { name: "blobs/sha256/" + sha(manifest).slice(7), data: manifest },
    { name: "index.json", data: index },
    { name: "oci-layout", data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
  ]);
}

function dockerArchiveFixture(layers: FixtureLayer[], tag = "app:t2"): Buffer {
  const entries: { name: string; data: Buffer }[] = [];
  const layerNames: string[] = [];
  const diffIds: string[] = [];
  for (const layer of layers) {
    const id = sha(layer.plain).slice(7);
    diffIds.push(sha(layer.plain));
    layerNames.push(id + ".tar");
    entries.push({ name: id + ".tar", data: layer.plain });
  }
  const config = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: diffIds },
  }));
  const configName = sha(config).slice(7) + ".json";
  entries.push({ name: configName, data: config });
  entries.push({
    name: "manifest.json",
    data: Buffer.from(JSON.stringify([{ Config: configName, RepoTags: [tag], Layers: layerNames }])),
  });
  return makeTar(entries);
}

async function build(
  tar: Buffer,
  have: string[],
  ref = "app:t2",
): Promise<{ members: Map<string, Buffer>; stats: DeltaStats }> {
  const built = buildOciDelta(Readable.from([tar]), { have, ref });
  const chunks: Buffer[] = [];
  for await (const chunk of built.stream) chunks.push(chunk as Buffer);
  const stats = await built.result;
  return { members: parseTar(Buffer.concat(chunks)), stats };
}

/** A fake engine: resolve every manifest layer from the archive or the host store. */
function fakeEngineLoad(members: Map<string, Buffer>, hostStore: Map<string, Buffer>): string[][] {
  const index = JSON.parse(members.get("index.json")!.toString("utf8"));
  const manifestEntry = index.manifests[0];
  const manifest = JSON.parse(
    members.get("blobs/sha256/" + manifestEntry.digest.slice(7))!.toString("utf8"),
  );
  const config = JSON.parse(
    members.get("blobs/sha256/" + manifest.config.digest.slice(7))!.toString("utf8"),
  );
  const diffIds: string[] = [];
  for (const layer of manifest.layers) {
    const shipped = members.get("blobs/sha256/" + layer.digest.slice(7));
    const host = hostStore.get(layer.digest);
    const blob = shipped ?? host;
    if (blob === undefined) throw new Error("fake engine: missing blob " + layer.digest);
    if (sha(blob) !== layer.digest || blob.length !== layer.size) {
      throw new Error("fake engine: manifest lies about " + layer.digest);
    }
    const plain = layer.mediaType.endsWith("+gzip") ? gunzipSync(blob) : blob;
    diffIds.push(sha(plain));
  }
  return [diffIds, config.rootfs.diff_ids];
}

describe("OCI delta builder", () => {
  test("ships only missing blobs while the manifest references every layer", async () => {
    const base = Buffer.from("base layer");
    const filler = Buffer.from("filler layer ".repeat(100));
    const version = Buffer.from("version 2");
    const tar = ociFixture([
      { plain: base, gzip: false },
      { plain: filler, gzip: true },
      { plain: version, gzip: true },
    ]);
    const hostStore = new Map<string, Buffer>([
      [sha(base), base],
      [sha(gzipSync(filler)), gzipSync(filler)],
    ]);
    const { members, stats } = await build(tar, [sha(base), sha(filler)]);

    const manifest = JSON.parse(
      members.get("blobs/sha256/" + JSON.parse(members.get("index.json")!.toString()).manifests[0].digest.slice(7))!.toString(),
    );
    expect(manifest.layers).toHaveLength(3);
    const versionDigest = sha(gzipSync(version));
    const fillerDigest = sha(gzipSync(filler));
    expect(members.has("blobs/sha256/" + versionDigest.slice(7))).toBe(true);
    expect(members.has("blobs/sha256/" + fillerDigest.slice(7))).toBe(false);
    const shipped = [...members.keys()].filter(
      (name) => name === "blobs/sha256/" + versionDigest.slice(7),
    );
    expect(shipped).toHaveLength(1);
    expect(stats.layersTotal).toBe(3);
    expect(stats.layersReused).toBe(2);
    expect(stats.missingLayers).toEqual([sha(version)]);
    expect(stats.bytesSent).toBeGreaterThan(0);

    const [resolved, configDiffIds] = fakeEngineLoad(members, hostStore);
    expect(resolved).toEqual(configDiffIds);
    expect(resolved[2]).toBe(sha(version));
  });

  test("accepts a docker-archive save stream (flat diffID layer members)", async () => {
    const one = Buffer.from("one ".repeat(20));
    const two = Buffer.from("two ".repeat(20));
    const tar = dockerArchiveFixture([
      { plain: one, gzip: false },
      { plain: two, gzip: false },
    ]);
    const { members, stats } = await build(tar, [sha(one)]);
    expect(stats.layersTotal).toBe(2);
    expect(stats.missingLayers).toEqual([sha(two)]);
    const manifest = JSON.parse(
      members.get("blobs/sha256/" + JSON.parse(members.get("index.json")!.toString()).manifests[0].digest.slice(7))!.toString(),
    );
    expect(manifest.layers[0].mediaType).toBe("application/vnd.oci.image.layer.v1.tar");
    expect(manifest.layers[0].digest).toBe(sha(one));
    const [resolved, configDiffIds] = fakeEngineLoad(members, new Map([[sha(one), one]]));
    expect(resolved).toEqual(configDiffIds);
  });

  test("emits the oci-layout marker and an index annotation for the tag", async () => {
    const layer = Buffer.from("only");
    const { members } = await build(ociFixture([{ plain: layer, gzip: true }]), []);
    expect(members.has("oci-layout")).toBe(true);
    const index = JSON.parse(members.get("index.json")!.toString());
    expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe("t2");
    expect(index.manifests[0].annotations["io.containerd.image.name"]).toBe("app:t2");
  });

  test("a manifest referencing a layer absent from the stream is a documented error", async () => {
    const layer = Buffer.from("present");
    const full = dockerArchiveFixture([{ plain: layer, gzip: false }]);
    const withoutLayer = makeTar(
      [...parseTar(full).entries()]
        .filter(([name]) => !name.endsWith(".tar"))
        .map(([name, data]) => ({ name, data })),
    );
    const built = buildOciDelta(Readable.from([withoutLayer]), { have: [], ref: "app:t2" });
    built.stream.on("error", () => undefined);
    await expect(built.length).rejects.toThrow("config references layer");
    await expect(built.result).rejects.toThrow("config references layer");
  });
});
