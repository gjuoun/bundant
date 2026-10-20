# bundant

**Zero-downtime single-host deploys over SSH.** docker or podman + kamal-proxy + a thin
Bun/TypeScript control plane. No Kubernetes, no scheduler, no daemon on the host, and
**no registry required** — bundant can stream a locally built image to the host over the
same ssh connection it uses for everything else.

```sh
npm install -g bundant          # installs the node launcher: bundant
bun  add -g bundant              # bun users also get bundant-bun (runs the TS sources)
```

Both entry points ship in the package: `bundant` runs on node (a small bundle built from
the same sources at pack time, so no type stripping is needed inside `node_modules`) and
`bundant-bun` runs the TypeScript sources directly under bun. They are the same CLI.

Runs on **bun or node** — one implementation, two entry points: bun ≥ 1.2 (preferred,
no build step) or node ≥ 22.6 (24 recommended). Node runs the packed bundle; developing
from a checkout you can also run the sources directly with `node src/cli.ts …` (add
`--experimental-strip-types` on node 22.6-22.x).

## Quickstart

```sh
cat > deploy.yml <<'YAML'
version: 2
service: hello
image: traefik/whoami:v1.10
hosts: [root@box.example.com]   # user@host for an IP or a different login
proxy:
  host: hello.example.com
YAML

bundant deploy --dry-run -f deploy.yml   # print the exact command sequence
bundant deploy -f deploy.yml             # health-gated, zero downtime
curl -H 'Host: hello.example.com' http://box.example.com/
bundant rollback -f deploy.yml           # back to the previous revision
```

Anything ssh can reach works — LAN, VPN, cloud, tailscale. The login user comes from
the host itself (`root@10.0.0.5`) or from a top-level `user: root`; a per-host prefix
wins. Use `--local-image
<name:tag>` when the image lives only on your machine (it is streamed, not pushed to a
registry).

## How it works

- **Control plane = ssh + docker/podman.** The CLI runs, finishes and exits; nothing
  stays resident on the host.
- **Self-healing** is `--restart unless-stopped` — no health-polling daemon.
- **Zero downtime** comes from [kamal-proxy](https://github.com/basecamp/kamal-proxy):
  the new container starts unpublished, passes a health gate, the proxy swaps traffic
  and drains old connections, then the old container is stopped — kept for rollback.
- **Truth is `deploy.yml` + the image**; hosts are cattle.

## Commands

| command | what it does |
|---|---|
| `validate [-f path] [--json]` | parse one deploy/accessory/group file, print the resolved identity and the full error list; never touches a host |
| `deploy [--dry-run] [--local-image n:t] [--rev ID] [--via cli\|api] [-f path]` | full deploy; `--dry-run` prints every command without executing |
| `scale --replicas n [--via cli\|api] [-f path]` (or `scale n`) | add/remove replicas of the running revision without dropping requests (proxy target set changes before containers are removed) |
| `rollback [--to-revision rev]` | previous revision, or the exact one named by `--to-revision`: re-gate then re-swap |
| `history` | revisions newest-first with state, current one marked |
| `start <path>` / `stop <path>` / `restart <path>` | flat lifecycle verbs over one unit or a glob path (`shop.**`, `**.web`, `*`); `start` can create an accessory from `-f` |
| `rm <path> [--yes] [--revision rev] [--all-revisions] [--volumes] [--route] [--env] [--images]` | remove every matched unit; prints what it resolved first; accessories keep volumes unless `--volumes` |
| `status [path] [--json]` | unit status `{path,kind,revision,expected,live,containers}`; no path = every unit; `-f` filters to that file's unit |
| `prune [--keep k]` | drop stopped revisions beyond the newest k (default 3) + dangling layers |
| `delete [--yes] [--images]` | remove the service everywhere: proxy route, this service-role's containers, rendered env file (images kept unless `--images`); prints the plan and refuses without `--yes` |
| `group <install\|uninstall\|status\|rollback> -f group.yml` | namespace lifecycle: ordered install (`needs:` topo-sorted), labelled-sweep uninstall that leaves accessories alone, aggregated status, whole-group rollback to one shared sha |
| `accessory <boot\|reboot\|stop\|logs\|status\|remove> -f accessory.yml` | deprecated aliases for the flat verbs; stable name + named volumes, `healthcheck.tcp` readiness, `remove --yes [--volumes]` |
| `bootstrap [--dry-run] [--skip-smoke]` | make each host ready: install podman when missing (apt/dnf/yum/apk/pacman/zypper), enable `podman-restart.service`, set the registry search path, smoke-test one container |
| `runtime [--json] [--hosts a,b]` | per-host engine detection over the forwarded socket: engine, engine/API version, socket path, forward path, and socket-service state |
| `ps` / `stats` / `events [--since 2h]` | read-only monitoring: every container with state and ports, one resource snapshot per host, a bounded runtime-event window |
| `logs [path] [--tail n] [--follow]` | tail logs for matched units, each line prefixed with its replica; `--follow` streams |
| `inspect [path]` | state, restarts, health, image, restart policy of the first matched replica |
| `exec [path] [--replica n] [--all] -- <cmd...>` | exec in the first running replica (or every replica with `--all`) |
| `ui [--port 8787]` | local read-only monitoring page; binds 127.0.0.1 (tunnel or tailnet for remote) |

Env hooks: `BUNDANT_HOSTS=a,b` overrides hosts, `BUNDANT_LOCK_TTL_S` sets the stale-lock
threshold.

## Requirements

- Deploying machine: bun ≥ 1.2 (preferred) or node ≥ 22.6 / 24 recommended, plus
  `docker` if you use `--local-image`. Node users run the sources directly:
  `node src/cli.ts deploy -f deploy.yml` (add `--experimental-strip-types` on node 22.6-22.x).
- Target host: sshd + docker or podman, ports 80/443 free, passwordless ssh login.
  `~/.ssh/config` is used when present, but a deploy can also carry its own
  `ssh:` block (user/port/identity/options) and need no local ssh setup at all.
  Nothing installed yet? `bundant bootstrap` installs podman on Debian/Ubuntu, Fedora/RHEL/
  CentOS/Rocky/Alma/Amazon Linux, Alpine, Arch and openSUSE, then enables the boot-time
  restart unit and smoke-tests a container.

## More

- [`docs/deploy-yml.md`](docs/deploy-yml.md) — every field, env handling, revisions
- [`docs/naming.md`](docs/naming.md) — dotted container names, selectors and case collisions
- [`docs/cli.md`](docs/cli.md) — the effect/cli command tree, shared flags and completions
- [`docs/validation.md`](docs/validation.md) — preflight, what is checked, and the `--json` shape
- [`docs/group.md`](docs/group.md) — group namespaces, `needs:` ordering, accessories and their lifecycle
- [`docs/schema.md`](docs/schema.md) — `schema/*.json` for editor autocomplete + inline errors
- [`docs/api-types.md`](docs/api-types.md) — generated engine API types + zod validation at the adapter boundary
- [`docs/podman.md`](docs/podman.md) — rootless podman, LXC nesting, boot persistence, `bundant bootstrap`
- [`docs/replicas.md`](docs/replicas.md) — N copies on one host, `bundant scale`, the drain ordering invariant
- [`docs/monitoring.md`](docs/monitoring.md) — CLI + local UI monitoring, and what it deliberately leaves out
- [`docs/architecture.md`](docs/architecture.md) — internals, proxy integration, design rules
- [`docs/design.md`](docs/design.md) — the site's Bigface palette, token mapping and re-sync steps
- [`examples/hello`](examples/hello) — runnable fixture
- [`examples/shop`](examples/shop) — a group: db (accessory) + api + web
- [`examples/replicas`](examples/replicas) — three copies of one service behind the proxy

## Development

```sh
bun run typecheck && bun test    # unit suites, no docker needed
bun run schema:gen               # regenerate schema/*.json after editing src/config.ts
bun run api:gen                  # regenerate engine API types from specs/ + the allowlist

# product site (site/): one Bigface dark theme, tokens derived from site/src/data/bigface.json
# palette upstream: https://github.com/gjuoun/bigface-theme (see docs/design.md)
cd site && bun run build

# dual-runtime smoke: everything below must work (same sources, both runtimes)
bun  src/cli.ts --version
bun  src/cli.ts deploy --dry-run -f examples/hello/deploy.yml
node src/cli.ts --help
node src/cli.ts --version
node src/cli.ts deploy --dry-run -f examples/hello/deploy.yml
```

CI (`.github/workflows/ci.yml`) runs two jobs: **bun** (install, typecheck, tests,
dry-run) and **node** (`actions/setup-node` 24, `node --version`, then `--help`,
`--version`, `deploy --dry-run`).

MIT.
