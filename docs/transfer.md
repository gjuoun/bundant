# Local image transfer

`bundant deploy --local-image <name:tag>` sends a locally built image to each host over the
existing ssh connection. There is no registry and no daemon on the host beyond the engine
socket.

## Transport

bundant reads the local image's `RootFS.Layers` (diffIDs), folds every layer of
every image on the host into one set, and streams an OCI-layout tar that references
**all** layers of the image while carrying blob files only for the layers the host
lacks. Sizes and digests in the manifest stay truthful, and the index entry carries
the image's platform. The tar goes to `POST /images/load` through the forwarded
engine socket.

A redeploy that changes one layer of a large image therefore sends kilobytes instead of the
whole image. The saving is measured on the wire, not inferred from the layer count.

## When a delta is possible

The delta needs two engines that agree on layer identity:

- the host must already hold the unchanged layers (same diffIDs) in **some** image, not
  necessarily the same tag;
- the local save must expose a config with `rootfs.diff_ids` and each layer blob
  (docker's OCI save and podman's docker-archive save both do).

If a layer cannot be resolved, the first load reports it and bundant retries once with a
complete OCI archive (every layer blob).

## Fallback rules

1. Delta load succeeds: report `mode: "delta"`.
2. The engine reports a missing blob/layer (docker 29 reports it as an error record on a
   `200` load stream; podman answers `500`): rebuild with an empty host set and load every
   layer once. Report `mode: "full"` plus `fallback`.
3. Any other load failure is surfaced as-is; there is no blind retry.

After a load bundant waits until the engine exposes the tag (docker can acknowledge a load
before the tag is visible) and resolves the image id for container creation. Docker 29 with
the containerd image store may refuse a short tag by name even though it lists it, so
creation uses the resolved image id; this is internal and does not affect naming.

Each host's layer inventory is recomputed per deploy. Nothing is cached across runs, so a
pruned layer is never assumed present.

## Reporting

`--json` adds one `transfer` object (the first host's report):

```json
{
  "transfer": {
    "mode": "delta",
    "bytesSent": 18432,
    "layersReused": 7,
    "layersTotal": 8,
    "missingLayers": 1
  }
}
```

`mode: "full"` additionally carries `fallback` with the engine's missing-blob message.
`--timings` adds a `transfer` phase per host.
