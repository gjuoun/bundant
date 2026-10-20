# sessiond

Small host-side liveness observer, shipped as an image so a target host needs
neither internet nor a Go toolchain.

## Protocol

Connect to the unix socket and write one ndjson line:

```json
{"session":"s-1","agent":"claude","pid":4242}
```

The claimed pid is ignored; the kernel's SO_PEERCRED pid is used instead. The
daemon replies nothing. It appends two ed25519-signed lines to
`/var/lib/bundant/sessions.ndjson`:

```json
{"v":1,"time":"...","event":"session.open","session":"s-1","agent":"claude","pid":4242,"mode":"pidfd","host":"box","pub":"...","sig":"..."}
{"v":1,"time":"...","event":"session.closed","session":"s-1","agent":"claude","pid":4242,"mode":"pidfd","host":"box","pub":"...","sig":"..."}
```

`sig` is the ed25519 signature over the same object serialized without `sig`.
The key seed is `/var/lib/bundant/sessiond.key` (0600), created on first start.

## Modes

- `pidfd` - raw SYS_PIDFD_OPEN (434 on amd64/arm64) + select.
- `cgroupv2` - `/proc/<pid>/cgroup` -> `cgroup.events`, `populated 0`.
- `poll` - `kill(pid,0)` every 500 ms (also treats a zombie as gone).

Anything other than `pidfd` is degradation and is reported by
`bundant sessiond status` as `degraded: true`.

## Build

```sh
./build.sh          # both binaries + both images (needs a podman machine)
./build.sh bin      # binaries only
```

## Run

```sh
podman run -d --name bundant-sessiond --network=none --pid=host \
  --cgroupns=host --read-only --security-opt no-new-privileges \
  -v /run/bundant:/run/bundant -v /var/lib/bundant:/var/lib/bundant \
  -v /sys/fs/cgroup:/sys/fs/cgroup:ro bundant/sessiond:0.1.0
```
