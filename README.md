# bundant

**Zero-downtime single-host deploys over SSH.** docker or podman + kamal-proxy + a thin
Bun control plane. No Kubernetes, no scheduler, no daemon on the host, **no registry
required**: bundant can stream a locally built image straight to the host over the same
ssh connection it uses for everything else.

```sh
npm install -g bundant      # or: bun add -g bundant
bundant deploy -f deploy.yml
```

## Install

```sh
bun add -g bundant          # preferred
npm install -g bundant      # works too
bundant --help
```

- The machine you deploy **from** needs [Bun](https://bun.sh) ≥ 1.2 (the CLI is
  TypeScript, run by Bun) and `docker` if you use `--local-image`.
- The **target host** needs nothing but sshd + docker or podman. Ports 80/443 must be
  free (kamal-proxy owns them).
- A passwordless ssh login to the host (`ssh box.example.com docker version` should
  work without a prompt); anything in `~/.ssh/config` — including tailscale MagicDNS
  names — is honoured as-is.

## 60-second quickstart

```sh
# 1. a deploy.yml (this is the whole contract — see reference below)
cat > deploy.yml <<'YAML'
service: hello
image: traefik/whoami:v1.10
hosts: [box.example.com]
proxy:
  host: hello.example.com
YAML

# 2. see the exact command sequence, no host contact
bundant deploy --dry-run -f deploy.yml

# 3. ship it — zero downtime, health-gated, rollback-ready
bundant deploy -f deploy.yml

# 4. verify (kamal-proxy routes by Host header)
curl -H 'Host: hello.example.com' http://box.example.com/

# 5. back out in one command
bundant rollback 1 -f deploy.yml
```

No registry? Add `--local-image <name:tag>` and bundant streams the image from your
machine (`docker save | gzip | ssh 'gunzip | docker load'`) before deploying.

## Architecture

```
                      deploy.yml (git) + image = truth; hosts are cattle

  +------------------+
  |  your laptop     |    bundant deploy (--local-image: docker save | gzip | ssh)
  |  bundant (CLI)   |---------------------------+
  +------------------+                           |
        |  tailscale SSH (MagicDNS names)        |  atomic mkdir lock
        |  native ssh + ControlMaster            |  (~/.bundant/locks/<svc>.lock)
        v                                        v
  +------------------------------------------------------------+
  |  target host (single docker host via ts.net MagicDNS)      |
  |                                                            |
  |   docker network 'bundant' (internal; no published ports)  |
  |                                                            |
  |        80/443                                              |
  |          |                                                 |
  |   +------v---------+        swap via docker exec           |
  |   |  kamal-proxy   |---------------------------------+     |
  |   |  (data plane)  |  kamal-proxy deploy <svc-role>  |     |
  |   +------+---------+      --target <c>:<port>        |     |
  |          |                    (healthy + drained)    |     |
  |          v                                          v     |
  |   +--------------+     +--------------+     +--------------+
  |   | hello-web-   |     | hello-web-   | ... |  old revision|
  |   | <new rev>    |     | <old rev>    |     |  (stopped,   |
  |   | restart:     |     | draining     |     |   kept for   |
  |   | unless-stoppd|     | connections  |     |   rollback)  |
  |   +--------------+     +--------------+     +--------------+
  |                                                            |
  |   self-healing = --restart unless-stopped (no daemon)      |
  +------------------------------------------------------------+
```

**Deploy flow (per host):** image transfer ([--local-image] `docker save | gzip | ssh
"gunzip | docker load"`, or a plain registry pull) -> ensure network -> run the new
container (`<service>-<role>-<rev>`, revision-named, restart policy, no published
ports) -> health gate (throwaway curl sidecar probes the container by name; failure
aborts, removes the container, never touches traffic) -> kamal-proxy swap (blocks
until the new target is healthy and old connections drained) -> stop old revision
(kept for rollback).

**Rollback:** `rollback [n]` = start the nth-previous revision container, re-gate
health, re-point kamal-proxy, stop the current one.

## Quickstart — zero registry (recommended)

Prereqs: a docker host reachable over tailscale SSH by MagicDNS name
(`ssh you@box.tail1234.ts.net docker version` works), ports 80/443 free, and docker
on this machine for the image transfer.

```sh
# 1. build (or pull) the image locally — nothing is pushed anywhere
docker build -t hello:local .          # your app
docker pull traefik/whoami:v1.10       # or the bundled example, no Dockerfile needed

# 2. see exactly what will run (no host contact, shows the save|gzip|ssh|load step)
bun run src/cli.ts deploy --dry-run --local-image hello:local -f examples/hello/deploy.yml

# 3. deploy: the image streams over ssh, then the normal zero-downtime plan runs
BUNDANT_HOSTS=box.tail1234.ts.net bun run src/cli.ts deploy --local-image hello:local \
  -f examples/hello/deploy.yml

# 4. verify from outside: whoami echoes the container hostname
curl -H 'Host: hello.bundant.test' http://box.tail1234.ts.net/

# 5. roll back, inspect, clean up old revisions
BUNDANT_HOSTS=box.tail1234.ts.net bun run src/cli.ts rollback 1 -f examples/hello/deploy.yml
BUNDANT_HOSTS=box.tail1234.ts.net bun run src/cli.ts status -f examples/hello/deploy.yml
BUNDANT_HOSTS=box.tail1234.ts.net bun run src/cli.ts prune --keep 3 -f examples/hello/deploy.yml
```

Deploy twice and the Host-header curl keeps returning 200 while the backend
hostname changes — that is the zero-downtime proof.

## Registry path

If the image already lives in a registry, drop `--local-image` and let the host pull
it — the plan has one step fewer:

```sh
BUNDANT_HOSTS=box.tail1234.ts.net bun run src/cli.ts deploy -f examples/hello/deploy.yml
```

Registry credentials are preconfigured on the host (`docker login`); bundant does not
manage them (MVP scope).

## Podman quickstart (rootless)

Set `runtime: podman` and every emitted step switches binary — `podman pull`, `podman
network create`, `podman run`, `podman exec`, `podman ps`, and `podman save --format
docker-archive` for `--local-image`. No shim, no docker compatibility layer.

```yaml
service: hello
image: traefik/whoami:v1.10
runtime: podman
hosts: [box.tail1234.ts.net]
proxy: { enabled: true, host: hello-podman.bundant.test, port: 80 }
```

```sh
# dry-run first: shows podman-prefixed steps plus the runtime-check and port-guard
bun run src/cli.ts deploy --dry-run -f examples/hello-podman/deploy.yml
BUNDANT_HOSTS=box.tail1234.ts.net bun run src/cli.ts deploy -f examples/hello-podman/deploy.yml
curl -H 'Host: hello-podman.bundant.test' http://box.tail1234.ts.net/
```

Two podman-only steps are added ahead of the deploy, both idempotent:

1. **`[runtime-check]`** — rootless boot persistence: enables `podman-restart.service`
   (`systemctl --user enable --now podman-restart.service`) and lingering for the SSH
   user (`loginctl enable-linger $USER`), each behind a guard so a second deploy does
   nothing. Without these, `--restart unless-stopped` containers would not come back
   after a reboot. Docker emits no such step.
2. **`[port-guard]`** — an informational host check (never aborts): it prints a note
   when the host's `net.ipv4.ip_unprivileged_port_start` is above 80. It is only a
   note because the bind is fixed inside the container: the kamal-proxy image runs
   as a non-root user, so on podman the proxy container is created with
   `--sysctl net.ipv4.ip_unprivileged_port_start=0` (verified live on the target
   host — without it, :80 dies with `bind: permission denied`). Docker never gets
   that flag. Hosts using slirp4netns (rather than pasta) bind host-side, so the
   note still names the `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80`
   fix for them.

### The proxy image (Docker Hub) and air-gapped hosts

The proxy runs `docker.io/basecamp/kamal-proxy:latest` — Docker Hub is the source
(no alternate mirror exists; Docker Hub serves v0.10.2 as `:latest`). The tag is used
only when the proxy container is created: a host that already runs a `kamal-proxy`
container keeps it (started, never recreated), because recreating it would drop live
connections. To switch images, remove the container first
(`podman rm -f kamal-proxy` / `docker rm -f kamal-proxy`) — the next deploy recreates
it with the configured tag.

A host that cannot reach Docker Hub needs no build: pull the image anywhere that can,
then move it with the same save | ssh | load pipeline bundant uses for `--local-image`:

```sh
docker pull docker.io/basecamp/kamal-proxy:latest      # or podman pull
docker save docker.io/basecamp/kamal-proxy:latest | gzip -1 \
  | ssh you@box.tail1234.ts.net "gunzip | podman load"
```

Podman's default pull policy is `missing`, so once that tag exists on the host the
deploy uses it as-is. If you retag the image on the host, point `proxy.image` at your
tag (the override is only consulted when the container is created):

```yaml
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
  image: docker.io/basecamp/kamal-proxy:latest   # or your own tag
```

Notes for hosts that are themselves containers (Proxmox/LXC): enable `nesting=1`
(and `keyctl=1`) for the container — podman needs those to create nested cgroups and
keyrings; on some hosts also check the storage driver (`fuse-overlayfs` or `vfs`) if
overlay mounts are refused. The image transfer stays `save | gzip | ssh | gunzip |
load`, and because podman saves as `docker-archive` you can freely switch a host
between docker and podman later.

## deploy.yml

```yaml
service: hello            # [a-z0-9-]
image: traefik/whoami:v1.10   # used as-is, or overridden by --local-image
role: web                 # default: web
hosts: [box.tail1234.ts.net]
runtime: docker          # or podman (rootless; see the podman quickstart)
env:                      # optional; rendered remotely, values never printed
  file: ./hello.env       # local file (gitignored), KEY=VAL lines
  vars: { BUNDANT_DEMO: "1" }
healthcheck:
  path: /                 # default: /
  port: 80                # default: proxy.port
  timeout: 30             # seconds
proxy:
  enabled: true           # swap traffic at deploy (default: true)
  host: hello.bundant.test  # kamal-proxy Host-header routing (required when enabled)
  port: 80                # container port the proxy targets
  tls: false              # pass --tls (ACME via kamal-proxy)
  image: docker.io/basecamp/kamal-proxy:latest   # override for air-gapped hosts
```

Secrets live in env files, not git. Container names are `<service>-<role>-<rev>`
where rev is the git short sha of the deploy.yml repo (fallback `rev-<base36>` before
the first commit).

## Commands

| command | what it does |
|---|---|
| `deploy [--dry-run] [--local-image n:t] [--rev ID] [-f path]` | full deploy sequence; `--dry-run` prints every docker/proxy command (including the save/load pipeline) without executing; `--local-image` streams a locally built image instead of pulling from a registry |
| `rollback [n]` | stop new, start the nth-previous revision (default 1), re-gate, re-swap |
| `status` | per-host: service containers, kamal-proxy targets, live health probe |
| `prune [--keep k] [--dry-run]` | remove stopped revision containers beyond the newest k (default 3) plus dangling image layers; `--dry-run` prints the commands |

Env hooks: `BUNDANT_HOSTS=a,b` overrides hosts (E2E/testing), `BUNDANT_LOCK_TTL_S`
sets the stale-lock reclaim threshold (default 900). `--rev` overrides the revision id
— a testing hook for repeated deploys without new commits.

## Pruning old revisions

Each deploy keeps its revision container (stopped) so rollback is instant. `prune`
reaps them: it keeps the newest `--keep` revisions per service-role, removes the rest
**only if they are stopped** (a running or draining container is never removed), then
runs `docker image prune -f` for dangling layers. Cloud images removed from the host
are not re-pulled until the next registry deploy.

## kamal-proxy integration

One `kamal-proxy` container per host (`--restart unless-stopped`, publishes 80/443,
internal network only). Control path is `docker exec kamal-proxy kamal-proxy <cmd>` —
no host socket mounts. Routing is service-based with a stable id `<service>-<role>`;
each deploy sets `--target <container>:<port>` and `--host <proxy.host>` for
Host-header routing. kamal-proxy health-checks targets itself before routing
(`--health-check-path` from your config, so no app needs `/up`), and its `deploy`
command blocks until the old target has drained — which is why bundant stops the old
container immediately after.

## Design principles (locked)

- No runtime daemon: the CLI executes and exits; control plane is ssh + docker.
- One transport: image transfer, commands and locks all ride the same multiplexed
  ssh connection — no registry, no agent, no extra channel.
- Runtime is a config value: `runtime: docker | podman` threads a single binary name
  through every step, including the image transfer and the proxy.
- Self-healing = `--restart unless-stopped`; no health-polling daemon.
- Zero downtime via kamal-proxy (Go, MIT) — never a hand-rolled proxy.
- Service discovery = tailscale MagicDNS (`name.<tailnet>.ts.net`).
- Atomicity = per-service mkdir deploy lock on the first host.
- Machines are cattle; truth lives in deploy.yml + the image.

## Development

```sh
bun run typecheck   # tsc --noEmit
bun test            # unit suites (no docker needed)
```

E2E proof scripts (need a real target host):
`~/.notebook/project/gjuoun/bundant/plan/scripts/e2e-zero-downtime.sh`,
`rollback-check.sh`, `reboot-recovery.sh` — all take `TARGET_HOST=<magicdns-name>`.
