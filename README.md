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
| `deploy [--dry-run] [--local-image n:t] [--rev ID] [-f path]` | full deploy; `--dry-run` prints every command without executing |
| `rollback [--to-revision rev]` | previous revision, or the exact one named by `--to-revision`: re-gate then re-swap |
| `history` | revisions newest-first with state, current one marked |
| `status` | per-host containers, proxy targets, live health probe |
| `prune [--keep k]` | drop stopped revisions beyond the newest k (default 3) + dangling layers |
| `delete [--yes] [--images]` | remove the service everywhere: proxy route, `<service>-<role>-*` containers, rendered env file (images kept unless `--images`); prints the plan and refuses without `--yes` |

Env hooks: `BUNDANT_HOSTS=a,b` overrides hosts, `BUNDANT_LOCK_TTL_S` sets the stale-lock
threshold.

## Requirements

- Deploying machine: bun ≥ 1.2 (preferred) or node ≥ 22.6 / 24 recommended, plus
  `docker` if you use `--local-image`. Node users run the sources directly:
  `node src/cli.ts deploy -f deploy.yml` (add `--experimental-strip-types` on node 22.6-22.x).
- Target host: sshd + docker or podman, ports 80/443 free, passwordless ssh login.
  That is all — anything in `~/.ssh/config` is used as-is.

## More

- [`docs/deploy-yml.md`](docs/deploy-yml.md) — every field, env handling, revisions
- [`docs/podman.md`](docs/podman.md) — rootless podman, LXC nesting, boot persistence
- [`docs/architecture.md`](docs/architecture.md) — internals, proxy integration, design rules
- [`examples/hello`](examples/hello) — runnable fixture

## Development

```sh
bun run typecheck && bun test    # unit suites, no docker needed

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
