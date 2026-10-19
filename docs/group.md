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

Every deployment lives in a namespace. A `deploy.yml` that sits outside any group is not a
special case: it loads with `group: default`, so the same shape applies everywhere.

| item | in `default` (no group directory) | in a group |
|---|---|---|
| container | `<service>-<role>-<rev>` | `<group>-<service>-<role>-<rev>` (groups and roles take no hyphens) |
| replicas | `<service>-<role>-<rev>-<i>` | `<group>-<service>-<role>-<rev>-<i>` |
| proxy id | `<service>-<role>` | `<group>-<service>-<role>` |
| accessory container | `<service>` | `<group>-<service>` |
| env file | `~/.bundant/env/default/<service>-<role>.env` | `~/.bundant/env/<group>/<service>-<role>.env` |
| lock key | `default/<service>` | `<group>/<service>` (one outer `<group>` lock per group run) |
| labels | `bundant.service=<service>`, `bundant.group=default` | `bundant.service=<service>`, `bundant.group=<group>` |

### Name grammar (collision-proof)

Only the service segment may contain a hyphen; every other segment is
lowercase alphanumeric. That is what makes the composition injective and the
parse deterministic:

| segment | pattern | why |
|---|---|---|
| group | `[a-z0-9]+` | first segment; no hyphen |
| service | `[a-z0-9][a-z0-9-]*` | the only multi-word segment |
| role | `[a-z0-9]+` | split before the revision; no hyphen |
| revision | `[a-z0-9]+` | right-most segment before an optional replica index |
| replica | `\d+` | optional last segment |

So `a-b-c-web-1234` can only be group `a`, service `b-c`; a group named
`a-b` is rejected rather than silently colliding. Uppercase, underscores and
dots are rejected too (`CamelCase`, `snake_case`, `dot.case` are all
configuration errors that name the field and the rule).

**The default group never prefixes.** Ungrouped names are byte-for-byte what they were,
so existing deployments need no migration. A real group puts its name in front of the
container and the proxy id, which is what lets two groups both contain a service called
`api`: they stay `alpha-api-web-<rev>` and `beta-api-web-<rev>`, with proxy ids
`alpha-api-web` and `beta-api-web`. The role segment stays in the proxy id, so two roles
of one service do not fight over a route.

The git sha of the group repo is still the release id for the whole set. Env paths, lock
keys and labels are unchanged — only names change.

Selection understands both shapes: `stop-old`, `prune`, `rollback`, `delete` and the
`group uninstall` sweep also find pre-grouping containers (`<service>-<role>-<rev>` with
`bundant.group=<group>`), so an in-place upgrade leaves no orphans. Where an old prefix is
ambiguous, `bundant.group` is checked before anything is removed.

## Accessories

An accessory is stateful: it keeps a stable container name (no revision) and
named volumes, so clients, ports and data survive app deploys.

**Every object says what it is.** The container carries
`bundant.kind=accessory` (services carry `bundant.kind=service`), plus
`bundant.volumes=<name,name>`; the declared volumes are created *before* the
container with `bundant.kind=accessory`, `bundant.owner=<group>/<service>` and
`bundant.managed=true`. So a host is self-describing even to someone who only has
the runtime CLI:

```sh
docker ps -a --filter label=bundant.kind=accessory
docker volume inspect pgdata --format '{{json .Labels}}'
# {"bundant.kind":"accessory","bundant.managed":"true","bundant.owner":"shop/db"}
```

That metadata is what the safety rules are built on, not a name convention:

- `delete` and the `group uninstall` sweep select by `bundant.kind=service`, and
  each candidate is re-checked — a container that says `accessory` is skipped with
  `skip accessory <name> (stateful: use bundant accessory remove)`, even if its
  name happens to match a service prefix.
- `deploy`'s stop-old pass skips accessories the same way.
- `accessory remove --volumes` only deletes a volume whose `bundant.owner` is this
  accessory; a volume owned by someone else is reported and left alone.

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
same `bundant.group` label and its env file lands under the group directory. A
standalone accessory file (no group directory) lands in `default`.

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
