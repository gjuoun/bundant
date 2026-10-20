---
title: "Architecture (internals)"
description: "Internals: the deploy sequence, proxy integration and design rules."
slug: "architecture"
sidebar:
  order: 9
---

# Architecture

> **Internals.** Read the tutorial first. This page is for people changing bundant, not for
> people deploying with it.

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

## Engine API

`deploy`, `rollback`, `prune`, `delete`, `scale` and `group` program against a
semantic `RuntimeOps` layer (`src/ops/`). Every mutating command runs the zod
preflight gate first (see [validation](/bundant/docs/validation/)). Pull, network, container
create/start/stop/remove, exec and image prune are engine-API calls over the
forwarded unix socket.

The invariants: accessory containers are never selected by
deploy/rollback/prune/delete (label check, not a name guess), and `scale` updates
the proxy target set **before** removing containers on the way down.

What stays on ssh: the deploy lock, rootless-podman systemd/linger and sysctl
checks, and `--local-image` streaming. The proxy is a CLI inside a container, so
its path is `adapter.exec`.

The merged environment rides `ContainerSpec.Env` in the create request, so no
plaintext env file is written to the host. `--dry-run` renders the API call
bodies with env values rendered as a redacted count.
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

## Typed engine API

The engine client types under `src/adapters/generated/*.d.ts` are generated, never hand-written:

```text
specs/docker-moby.swagger.yaml      Swagger 2.0, Docker Engine API 1.57
specs/podman-v5.7.0.swagger.yaml    Swagger 2.0, Podman 5.7.0
        │ swagger2openapi
        ▼
   OpenAPI 3 + curated allowlist (scripts/api-gen.ts)
        │ openapi-typescript
        ▼
src/adapters/generated/{docker,podman}-api.d.ts
```

```sh
bun run api:gen      # rewrite the two .d.ts files
bun run api:check    # fail when they drift from the specs + allowlist
```

The allowlists in `scripts/api-gen.ts` are the only operations generated, so the files stay
reviewable (~55 KB each). Adding an endpoint means adding it there, regenerating, and committing
the result. Podman compat paths spell the parameter `{name}` where Docker says `{id}`; the
allowlists keep both spellings.

Every inbound payload the adapters read is validated with zod in
`src/adapters/schemas/payloads.ts`. Each schema is annotated with a type picked from the generated
definitions, so a schema that drifts from the official spec does not compile. `parseOrDrift`
throws `ApiSchemaDriftError` with the engine, method + path, the first failing JSON pointer, and a
short excerpt (object shapes are reduced to key lists, so env values are never echoed).

Fixtures under `src/adapters/schemas/fixtures/` are recorded real payloads from docker02
(Docker 29.1.3) and docker01 (Podman 5.7.0). Mutated copies drive the drift tests. Podman 5.7
declares the Docker-compatible stats body as `Record<string, never>` and omits the compat events
body; those two are validated against Docker's official contract, which is what Podman's compat
API actually returns on the hosts.
