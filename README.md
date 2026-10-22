# bundant

**Zero-downtime single-host deploys over SSH.** docker or podman + kamal-proxy + a thin
Bun/TypeScript control plane. No Kubernetes, no scheduler, no daemon on the host, and
**no registry required** — bundant can stream a locally built image to the host over the
same ssh connection it uses for everything else.

The npm package is not published yet; install from a checkout:

```sh
git clone https://github.com/gjuoun/bundant.git
cd bundant
bun install
bun run build
bun link                # puts bundant and bundant-bun on PATH
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
image: traefik/whoami:latest
hosts: [root@box.example.com]   # user@host for an IP or a different login
proxy:
  host: hello.example.com
YAML

bundant deploy --dry-run -f deploy.yml   # print the exact command sequence
bundant deploy -f deploy.yml             # health-gated, zero downtime
curl -H 'Host: hello.example.com' http://box.example.com/
bundant rollback -f deploy.yml           # back to the previous revision
```

### The same deployment as code

`src/sdk/` is the public surface: a spec is a validated TS value, and every operation is an
`Effect` with a one-line bridge for plain programs.

```ts
import { bundant, defineDeployment, runSdk } from "bundant";

const api = defineDeployment({
  group: "shop", service: "api", image: "traefik/whoami:v1.10",
  hosts: ["root@box.example.com"], port: 80, proxy: { host: "api.shop.test" },
});

await runSdk(bundant.deploy(api));      // deploy, status, scale, rollback
```

`examples/sdk-usage` runs deploy → rollback → scale against a real host.

Anything ssh can reach works — LAN, VPN, cloud, tailscale. The login user comes from
the host itself (`root@10.0.0.5`) or from `ssh.user`; a per-host prefix wins. Use `--local-image
<name:tag>` when the image lives only on your machine (it is streamed, not pushed to a
registry; the API path sends only the layers the host lacks — see
[`docs/transfer.md`](docs/transfer.md)).

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
| `deploy [--dry-run] [--local-image n:t] [--rev ID] [-f path]` | full deploy; `--dry-run` prints every command without executing |
| `scale --replicas n [-f path]` (or `scale n`) | add/remove replicas of the running revision without dropping requests (proxy target set changes before containers are removed) |
| `rollback [--to-revision rev]` | previous revision, or the exact one named by `--to-revision`: re-gate then re-swap |
| `history` | revisions newest-first with state, current one marked |
| `start <path>` / `stop <path>` / `restart <path>` | flat lifecycle verbs over one unit or a glob path (`shop.**`, `**.web`, `*`); `start` can create an accessory from `-f` |
| `rm <path> [--yes] [--revision rev] [--all-revisions] [--volumes] [--route] [--env] [--images]` | remove every matched unit; prints what it resolved first; accessories keep volumes unless `--volumes` |
| `status [path] [--json]` | unit status `{path,kind,revision,expected,live,containers}`; no path = every unit; `-f` filters to that file's unit |
| `prune [--keep k]` | drop stopped revisions beyond the newest k (default 3) + dangling layers |
| `delete [--yes] [--images]` | remove the service everywhere: proxy route, this service-role's containers, rendered env file (images kept unless `--images`); prints the plan and refuses without `--yes` |
| `group <install\|uninstall\|status\|rollback> -f group.yml` | namespace lifecycle: ordered install (`needs:` topo-sorted), labelled-sweep uninstall that leaves accessories alone, aggregated status, whole-group rollback to one shared sha |
| `bootstrap [--dry-run] [--skip-smoke]` | make each host ready: install podman when missing (apt/dnf/yum/apk/pacman/zypper), enable `podman-restart.service`, set the registry search path, smoke-test one container |
| `runtime [--json] [--hosts a,b]` | per-host engine detection over the forwarded socket: engine, engine/API version, socket path, forward path, and socket-service state |
| `ps` / `stats` / `events [--since 2h]` | read-only monitoring: every container with state and ports, one resource snapshot per host, a bounded runtime-event window |
| `logs [path] [--tail n] [--follow]` | tail logs for matched units, each line prefixed with its replica; `--follow` streams |
| `inspect [path]` | state, restarts, health, image, restart policy of the first matched replica |
| `exec [path] [--replica n] [--all] -- <cmd...>` | exec in the first running replica (or every replica with `--all`) |
| `ui [--port 8787]` | local read-only monitoring page; binds 127.0.0.1 (tunnel or tailnet for remote) |
| `errors [--json]` | print the stable error catalog (code + exit status) |

Every command accepts `--json`: stdout then carries exactly one object,
`{"ok":true,"command":…,"data":…}` or `{"ok":false,"command":…,"error":{…}}`, while
progress and logs stay on stderr. Exit statuses follow the catalog (`USAGE` 4,
`NO_MATCH` 3, `LOCK_HELD` 2, everything else 1). See [docs/agent.md](docs/agent.md)
for the envelope, the code table and the generated `schema/errors.json`.

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

## Documentation

Start with the five-chapter tutorial; every command and output in it was captured from a real host.

- [Quick start](docs/tutorial/01-quickstart.md) — install, host, one deploy, status
- [Your first service](docs/tutorial/02-first-service.md) — `deploy.yml` field by field
- [Operate](docs/tutorial/03-operate.md) — status, logs, revisions and rollback
- [Scale and groups](docs/tutorial/04-scale-and-groups.md) — replicas, `scale`, accessories
- [Observe and debug](docs/tutorial/05-observe.md) — ps, stats, events, ui, exec, failures

Reference, in the order you are likely to need it:

- [`docs/reference/deploy-yml.md`](docs/reference/deploy-yml.md) — every field, replicas, `group.yml`, accessories
- [`docs/reference/cli.md`](docs/reference/cli.md) — commands, flags, selectors, `--json` envelope and error codes
- [`docs/reference/naming.md`](docs/reference/naming.md) — dotted container names and case collisions
- [`docs/reference/schema.md`](docs/reference/schema.md) — `schema/*.json` for editor autocomplete
- [`docs/reference/transfer.md`](docs/reference/transfer.md) — `--local-image`: OCI layer deltas and fallback
- [`docs/reference/podman.md`](docs/reference/podman.md) — rootless podman, LXC nesting, boot persistence
- [`docs/reference/validation.md`](docs/reference/validation.md) — preflight and the `--json` shape
- [`docs/reference/monitoring.md`](docs/reference/monitoring.md) — CLI + local UI monitoring
- [`docs/reference/architecture.md`](docs/reference/architecture.md) — internals, proxy integration, design rules
- [`examples/hello`](examples/hello) — runnable fixture
- [`examples/shop`](examples/shop) — a group: db (accessory) + api + web
- [`examples/replicas`](examples/replicas) — three copies of one service behind the proxy

## Development

```sh
bun run typecheck && bun test    # unit suites, no docker needed
bun run schema:gen               # regenerate schema/*.json after editing src/config.ts
bun run api:gen                  # regenerate engine API types from specs/ + the allowlist

# product site (site/): one Bigface dark theme, tokens derived from site/src/data/bigface.json
# palette upstream: https://github.com/gjuoun/bigface-theme
cd site && bun run build

# theme: https://github.com/gjuoun/bigface-theme (linked from the site footer)

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
