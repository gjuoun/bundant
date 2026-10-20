---
title: "deploy.yml reference"
description: "Every field, default and rule in deploy.yml, accessory.yml and group.yml."
slug: "deploy-yml"
sidebar:
  order: 1
---

# deploy.yml reference

Read this after [chapter 2](/bundant/docs/tutorial/02-first-service/) and
[chapter 4](/bundant/docs/tutorial/04-scale-and-groups/).

One file per service. It is the contract: bundant turns it into docker/podman commands
and never stores state of its own on the host.

```yaml
version: 2                     # required; the only config version in use
service: hello                 # identifier: letters/digits with single - or _
image: traefik/whoami:latest   # registry ref, or overridden by --local-image
role: web                      # identifier; default: web
replicas: 1                    # copies per host; > 1 needs proxy.enabled: true
hosts: [box.example.com]       # user@host:port forms allowed; BUNDANT_HOSTS=a,b overrides

ssh:                           # optional: reach a host with NO ~/.ssh/config entry
  user: deploy                 # default login user (per-host user@ wins)
  port: 22                     # default port (per-host :port wins)
  identity: ~/.ssh/prod_deploy # private key; ~ is expanded
  options: ["-o", "StrictHostKeyChecking=accept-new"]
runtime: docker                # or podman (see podman.md)

env:                           # optional; rendered remotely as mode-0600 file
  file: ./hello.env            # local, gitignored, KEY=VAL lines
  vars: { BUNDANT_DEMO: "1" }  # inline; merged over the file

healthcheck:
  path: /                      # default: /
  port: 80                     # default: proxy.port
  timeout: 30                  # seconds

proxy:
  enabled: true                # swap traffic at deploy (default: true)
  host: hello.bundant.test     # Host-header routing (required when enabled)
  port: 80                     # container port the proxy targets
  tls: false                   # pass --tls to kamal-proxy (ACME)
  image: docker.io/basecamp/kamal-proxy:latest   # override for air-gapped hosts
```

## Hosts and ssh

Hosts accept `root@box.example.com`, `root@box.example.com:2222` and
`root@[2001:db8::1]:2222`. Precedence is **per-host > `ssh:` block > ssh
defaults**, so a deployment can be fully self-describing and does not depend on
`~/.ssh/config` having an alias for the machine. The same connection parameters
are used for control commands, the env-file upload and the `--local-image`
pipeline.

## Field notes

- **user / hosts** — the ssh login user, resolved with this precedence:
  `user@host` on a hosts entry › `ssh.user` › whatever `~/.ssh/config`
  provides (the local username when nothing is configured). Use it for hosts where
  the login name differs from your local one — the classic case is a bare IP:
  `hosts: [root@box.example.com]` instead of an `ssh junguo@box.example.com` denial.
  IPv6 literals go in brackets (`root@[2001:db8::1]`); a port goes after the
  host (`root@box.example.com:2222`, `root@[2001:db8::1]:2222`). `IdentityFile`
  and `ProxyJump` still belong in `~/.ssh/config`, which ssh itself reads.
- **revision** — container names are `<group>.<service>.<role>.<rev>` (the
  default group is always present, so an ungrouped service is
  `default.hello.web.<rev>`), where `rev` is the git short sha of the repo
  holding `deploy.yml` (fallback `r<base36>` before the first commit). `--rev ID`
  overrides it as a testing hook. Identifiers use letters, digits, `-` and `_`;
  dots separate segments. A `role` such as `web.api` or a service containing a
  dot is rejected with the exact rule.
- **replicas** — how many copies of this service run on **each** host (default 1).
  `replicas: 1` keeps the exact container name above; `N > 1` appends
  `.<i>` for `i = 1 … N` and every container carries `bundant.revision` +
  `bundant.replica`. `N > 1` requires `proxy.enabled: true` (the proxy is what
  distributes requests) and is rejected on `kind: accessory` (a stateful member
  is one of one). See [Replicas](#replicas) above and `bundant scale`.
- **env** — values are never printed; the merged result rides `ContainerSpec.Env` in
  the engine create request, so no env file is written to the host.
  Secrets belong in that local file (gitignored), not in git.
- **healthcheck** — the gate probes the container by name from a throwaway curl sidecar
  on the `bundant` network. A failed gate aborts, removes the new container, and never
  touches traffic. The same path is handed to kamal-proxy as `--health-check-path`, so
  your app never needs a `/up` endpoint.
- **proxy.enabled: false** — no proxy steps at all; the container is expected to publish
  its own ports (worker roles, internal tools).
- **proxy.image** — only consulted when the proxy container is created. To switch it,
  remove the container (`docker rm -f kamal-proxy`) and deploy again; an existing proxy
  is restarted, never recreated, because recreating drops live connections.

## Registry vs local image

Default: the host pulls `image` from its registry (`docker login` is the host's
business; bundant does not manage registry credentials).

`--local-image <name:tag>`: the image is streamed from your machine over the same ssh
connection and loaded into the host's runtime before the plan runs.

## Shared ssh config

Several deployments can point at one file instead of repeating the connection
details (and, optionally, the host pool):

```yaml
# ssh/prod.yaml
user: deploy
port: 2222
identity: ~/.ssh/prod_deploy
options: ["-o", "StrictHostKeyChecking=accept-new"]
hosts: [10.0.0.5, 10.0.0.6]     # optional default pool
```

```yaml
# api/deploy.yml          # worker/deploy.yml — same line, same host pool
version: 2
service: api
image: registry.internal/api:1.2.3
ssh: ./ssh/prod.yaml
```

`ssh:` takes an inline block or a path (resolved relative to the deploy.yml
that names it). Hosts declared in deploy.yml win over the file's pool; a
per-host `user@host:port` wins over both.


## Replicas

`replicas: N` runs N copies of the service on **each** host (default 1). The proxy is what
distributes requests, so `N > 1` requires `proxy.enabled: true`.

| replicas | container name |
|---|---|
| 1 | `<group>.<service>.<role>.<rev>` — e.g. `default.echoes.web.r2026a` |
| N > 1 | `<group>.<service>.<role>.<rev>.1` … `.<N>` |

Every service container carries `bundant.revision=<rev>` and `bundant.replica=<i>`;
`scale`, `status` and `rollback` read the truth from those labels, not from a local file.

`deploy` runs all N containers, health-gates each one, and makes **one** proxy call carrying
every target. A failed gate removes the containers this run started and leaves traffic where it
was.

```sh
bundant scale --replicas 5 -f deploy.yml
bundant scale 2 -f deploy.yml          # the same command
```

`scale` adjusts the revision that is already running: it never pulls an image, never changes the
revision or the env, and takes the same per-service lock as `deploy`. It is idempotent.

The ordering invariant is the whole design:

| direction | order |
|---|---|
| up | start the missing replicas → health-gate each → **one** proxy deploy with the full set |
| down | **proxy deploy with the survivors first** (drain) → then stop + remove the removed containers |

Scaling down in the other order drops in-flight requests. `deploy.yml` stays authoritative:
`scale` only prints a reminder and never writes the file, so the next `deploy` re-applies
`replicas:`. `status` marks the drift:

```text
replicas: live 2 / expected 3  <- drift (deploy.yml says 3)
```

## group.yml

A group is a namespace. The directory is the group; `group.yml` lists the members and their
dependencies.

```yaml
version: 2
group: shop
services:                       # order breaks ties; needs decides the real order
  - name: db
    file: ./db/accessory.yml
  - name: api
    file: ./api/deploy.yml
    needs: [db]                 # api starts only after db answers its TCP probe
  - name: web
    file: ./web/deploy.yml
    needs: [api]
```

Each `file` is resolved relative to the group directory, and `name` must equal that file's
`service:`. `needs` names other members; the install order is the topological sort, and a cycle
is an error. `group install` acquires one group lock, then each service takes its own lock.

```sh
bundant group install   -f shop/group.yml
bundant group status    -f shop/group.yml
bundant group rollback  -f shop/group.yml --to-revision 4f3c1ab
bundant group uninstall -f shop/group.yml --yes
```

A group run that fails stops and reports `applied / failed / skipped`, leaving the members that
did deploy serving.

## accessory.yml

An accessory is a stateful group member: a stable container name (`<group>.<service>`), named
volumes, no revision, no proxy. It is created once and never touched by deploy, rollback, prune or
scale.

```yaml
version: 2
kind: accessory
service: db
image: docker.io/library/postgres:16-alpine
hosts: [root@docker01]
env: { file: ./db.env }         # POSTGRES_PASSWORD etc. (gitignored, 0600 remote)
volumes:
  - "pgdata:/var/lib/postgresql/data"
healthcheck: { tcp: 5432, timeout: 60 }
proxy: { enabled: false }
```

Every object says what it is: the container carries `bundant.kind=accessory` (services carry
`bundant.kind=service`) and `bundant.volumes=<name,name>`; each volume carries
`bundant.kind=accessory`, `bundant.owner=<group>/<service>` and `bundant.managed=true`.
Selection uses those labels, not a name guess.

- `group install` never creates an accessory. If a required one is missing it stops and prints the
  exact `bundant start -f` command.
- `group uninstall` and `delete` select services only; accessories keep their data.
- `rm --volumes` only deletes a volume whose `bundant.owner` is this accessory.

Lifecycle is explicit:

```sh
bundant start   -f shop/db/accessory.yml          # create if absent
bundant restart -f shop/db/accessory.yml          # recreate, keep volumes
bundant stop    shop.db
bundant logs    shop.db
bundant status  shop.db
bundant rm      shop.db --yes                     # keep volumes
bundant rm      shop.db --yes --volumes           # delete data
```

Before a dependent service starts, a service dependency waits for its normal health gate; an
accessory dependency is probed by `healthcheck.tcp` — a bare TCP connect from a throwaway
busybox sidecar on the `bundant` network.
