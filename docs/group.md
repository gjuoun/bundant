# Groups and accessories

A **group** is a namespace: it collects several services so the whole set can be
installed, inspected, rolled back and uninstalled with one command. A **service**
is one deployment — one `deploy.yml` — and an **accessory** is a stateful group
member (a database, a queue) that is created once and never touched by a normal
deploy. Groups group; services deploy.

```
shop/                          # the directory *is* the group
├── group.yml                  # member list + explicit needs
├── db/   accessory.yml        # stateful: stable name, named volume, no revision
├── api/  deploy.yml           # stateless service
└── web/  deploy.yml           # stateless service
```

## group.yml

```yaml
group: shop
services:                       # order breaks ties; needs: decides the real order
  - name: db
    file: ./db/accessory.yml
  - name: api
    file: ./api/deploy.yml
    needs: [db]                 # api starts only after db answers its TCP probe
  - name: web
    file: ./web/deploy.yml
    needs: [api]
```

Each `file` is resolved relative to the group directory, and `name` must equal
that file's `service:`. `needs` names other members of the same group; the
install order is the topological sort (`db → api → web`), and a cycle is an
error.

## Naming and scope

Inside a group the deployment identity stays **per service**: the container is
`<service>-<role>-<rev>`, the proxy id is `<service>-<role>`, and the git sha
of the group repo is the release id for the whole set. Group membership only
changes where bundant puts things:

| item | ungrouped | grouped |
|---|---|---|
| env file | `~/.bundant/env/<service>-<role>.env` | `~/.bundant/env/<group>/<service>-<role>.env` |
| lock key | `<service>` | `<group>/<service>` (one outer `<group>` lock per group run) |
| labels | none | `bundant.service=<service>`, `bundant.group=<group>` |

The labels make filtering exact: `ps` and the delete sweep select by
`label=bundant.service=…` (and `label=bundant.group=…`), never by name prefix.

## Accessories

An accessory is stateful: it keeps a stable container name (no revision) and
named volumes, so clients, ports and data survive app deploys.

```yaml
# shop/db/accessory.yml
kind: accessory
service: db
image: docker.io/library/postgres:16-alpine
runtime: podman
hosts: [root@docker01]
env: { file: ./db.env }         # POSTGRES_PASSWORD etc. (gitignored, 0600 remote)
volumes:
  - "pgdata:/var/lib/postgresql/data"
healthcheck: { tcp: 5432, timeout: 60 }
proxy: { enabled: false }
```

Rules enforced by bundant:

- **`group install` never creates an accessory.** If a required accessory is
  missing it stops and prints the exact command to start it.
- **`group uninstall` never touches an accessory.** The labelled sweep selects
  service members only; accessories keep their data.
- **`deploy` / `rollback` / `prune` never match an accessory** — its container
  name has no `-<role>-<rev>` suffix.

Lifecycle (explicit only):

```sh
bundant accessory boot   -f shop/db/accessory.yml            # create if absent
bundant accessory reboot -f shop/db/accessory.yml            # recreate, keep volumes
bundant accessory stop   -f shop/db/accessory.yml
bundant accessory logs   -f shop/db/accessory.yml
bundant accessory status -f shop/db/accessory.yml
bundant accessory remove -f shop/db/accessory.yml --yes             # keep volumes
bundant accessory remove -f shop/db/accessory.yml --yes --volumes   # delete data
```

When an accessory file sits inside a group directory, `bundant accessory`
resolves the sibling `../group.yml` automatically, so its container carries the
same `bundant.group` label and its env file lands under the group directory.

## Commands

```sh
bundant group install   -f shop/group.yml                    # group lock, then members in order
bundant group status    -f shop/group.yml                    # aggregated per member
bundant group rollback  -f shop/group.yml --to-revision 4f3c1ab   # every service, same sha
bundant group uninstall -f shop/group.yml --yes              # labelled sweep, accessories untouched
```

`group install` acquires one `<group>` lock, then each service takes its own
`<group>/<service>` lock as it deploys. A failure stops the run and reports
`applied / failed / skipped`, leaving the already-deployed members serving.

## Readiness

Before a dependent starts, its dependencies must be ready:

- a **service** dependency waits for the existing health gate of its deploy;
- an **accessory** dependency is probed by `healthcheck.tcp` — a bare TCP
  connect from a throwaway busybox sidecar on the `bundant` network
  (`pg_isready`-style, image-agnostic).
