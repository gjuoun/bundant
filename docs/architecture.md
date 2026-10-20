# Architecture

```
deploy.yml (git) + image = truth; hosts are cattle

  your machine                         target host (any ssh-reachable box)
  ┌──────────────┐                     ┌──────────────────────────────────────┐
  │ bundant CLI  │── ssh (one ────────▶│  docker/podman network "bundant"     │
  └──────────────┘   multiplexed       │                                      │
                    connection)        │   80/443                             │
                                       │     │                                │
                                       │  kamal-proxy  ──swap──┐              │
                                       │     │                 │              │
                                       │  new container    old container      │
                                       │  (healthy)        (stopped, kept     │
                                       │                    for rollback)     │
                                       └──────────────────────────────────────┘
```

## Deploy sequence (per host)

1. **image** — `--local-image` streams (`save | gzip | ssh 'gunzip | load'`) or the host
   pulls from its registry
2. **network** — ensure the `bundant` network exists
3. **run** — start `<group>.<service>.<role>.<rev>` with `--restart unless-stopped`; no
   published ports
4. **health gate** — throwaway curl sidecar probes the container by name; failure
   aborts, removes the container, never touches traffic
5. **proxy swap** — `kamal-proxy deploy` points the service at the new target and
   blocks until the old connections have drained
6. **stop old** — the previous revision is stopped, not removed: that is the rollback
   material

`rollback` walks the same sequence backwards: start the previous (or the exact
`--to-revision`) container, re-gate it, re-point the proxy, stop the running one.
`history` lists every retained revision newest-first with its state.

## kamal-proxy integration

One [kamal-proxy](https://github.com/basecamp/kamal-proxy) container per host
(`--restart unless-stopped`, publishes 80/443, internal network only). Control path is
`docker exec kamal-proxy kamal-proxy <cmd>` — no host socket mounts. Routing is
service-based with a stable id `<group>.<service>.<role>`; each deploy sets
`--target <container>:<port>` and `--host <proxy.host>`. The proxy health-checks targets
itself before routing, and its `deploy` blocks until the old target drains — which is
why stopping the old container immediately after is safe.

## Execution paths: API vs legacy CLI

`deploy`, `rollback`, `prune`, `delete`, `scale`, `group` and `accessory`
program against a semantic `RuntimeOps` layer (`src/ops/`). Every mutating
command runs the zod preflight gate first (see [validation.md](validation.md)). The default is **`--via api`**: pull, network, container
create/start/stop/remove, exec and image prune are engine-API calls over the
forwarded unix socket. `--via cli` keeps the previous ssh command strings for
one release:

```sh
bundant deploy   -f deploy.yml                 # via api (default)
bundant deploy   -f deploy.yml --via cli       # legacy command-string path
bundant rollback -f deploy.yml --via cli       # same choices for rollback/prune
bundant scale --replicas 3 -f deploy.yml --via cli
bundant delete -f deploy.yml --yes --via cli
bundant group uninstall -f group.yml --yes --via cli
bundant accessory boot -f accessory.yml --via cli
```

The invariants are unchanged on both paths: accessory containers are never
selected by deploy/rollback/prune/delete (label check, not a name guess), and
`scale` updates the proxy target set **before** removing containers on the way
down.

What stays on ssh either way: the deploy lock, rootless-podman systemd/linger
and sysctl checks, and `--local-image` streaming (stage 4 moves images). The
proxy is a CLI inside a container, so its API path is `adapter.exec`.

**Env handling changed on the API path**: the merged environment rides
`ContainerSpec.Env` in the create request, so no plaintext env file is written
to the host. The legacy path still uploads `~/.bundant/env/...` as before.
`--dry-run` renders exactly which path will run: API call bodies (with env
rendered as a redacted count) or the legacy command strings.

## Design rules (locked)

- No runtime daemon: the CLI executes and exits; control plane is ssh + docker/podman.
- One transport: commands, image transfer and locks ride the same multiplexed ssh
  connection — no registry, no agent, no extra channel.
- Runtime is a config value: `runtime: docker | podman` threads one binary name through
  every step, including the image transfer and the proxy.
- Self-healing = `--restart unless-stopped`; no health-polling daemon.
- Zero downtime via kamal-proxy (Go, MIT) — never a hand-rolled proxy.
- Atomicity = per-service mkdir lock on the first host (`BUNDANT_LOCK_TTL_S` reclaim).
- Machines are cattle; truth lives in `deploy.yml` + the image.

## Pruning

Each deploy keeps its revision container (stopped) so rollback is instant. `prune` keeps
the newest `--keep` revisions per service-role, removes the rest **only if stopped** (a
running or draining container is never removed), then runs `image prune -f` for dangling
layers.
