# podman (rootless) and container-in-container hosts

Set `runtime: podman` and every emitted step switches binary — `podman pull`,
`podman network create`, `podman run`, `podman exec`, `podman ps`, and `podman save
--format docker-archive` for `--local-image`. No docker shim, no compatibility layer.

```yaml
service: hello
image: traefik/whoami:v1.10
runtime: podman
hosts: [box.example.com]
proxy: { enabled: true, host: hello-podman.example.com, port: 80 }
```

## Two podman-only steps (both idempotent)

1. **`[runtime-check]`** — rootless boot persistence. Enables
   `systemctl --user enable --now podman-restart.service` and
   `loginctl enable-linger $USER`, each behind a guard, so `--restart unless-stopped`
   containers actually come back after a reboot. Docker emits no such step.
2. **`[port-guard]`** — informational host check of
   `net.ipv4.ip_unprivileged_port_start`, plus the note naming the fix. It never aborts:
   the bind is fixed inside the container, because the kamal-proxy image runs as a
   non-root user and is created with
   `--sysctl net.ipv4.ip_unprivileged_port_start=0` on podman. Docker never gets that
   flag.

## Hosts that are themselves containers (Proxmox / LXC)

- Create the LXC with **`nesting=1`** (and `keyctl=1` for rootless) — podman needs them
  for nested cgroups and keyrings.
- If overlay mounts are refused, check the storage driver (`fuse-overlayfs` or `vfs`).
- Nothing else: the image transfer stays `save | gzip | ssh | gunzip | load`, and since
  podman saves as `docker-archive` a host can switch between docker and podman freely.

## Air-gapped hosts and the proxy image

The proxy runs `docker.io/basecamp/kamal-proxy:latest` (Docker Hub is the only source).
A host that cannot reach it needs no build — pull the image somewhere that can and move
it with the same pipeline:

```sh
docker pull docker.io/basecamp/kamal-proxy:latest
docker save docker.io/basecamp/kamal-proxy:latest | gzip -1 \
  | ssh you@box.example.com "gunzip | podman load"
```

Podman's pull policy is `missing`, so once the tag exists locally it is used as-is;
point `proxy.image` at your own tag if you retag it.
