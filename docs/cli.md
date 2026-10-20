# CLI

bundant's command tree is declared with `effect/cli`. The root command owns the
shared flags; every subcommand handler returns an Effect and surfaces the typed
errors from `src/effect/errors.ts`.

## Commands

```text
validate  deploy  rollback  scale  prune  delete  history
start  stop  restart  rm
status  logs  stats  inspect  exec  ps  events  runtime  bootstrap  ui
group      { install | uninstall | status | rollback }
```

- `group` with no action defaults to `install`.
- An accessory is driven by the flat verbs (`start`, `restart`, `stop`, `logs`, `status`, `rm`).
- `exec … -- <cmd…>` forwards everything after `--` to the remote command.
- `logs --follow` keeps the old SIGINT behaviour and closes its forwards.

## Unit paths and globs

Every flat verb addresses units by a path:

```text
service    group.service.role     shop.api.web
accessory  group.name             shop.db
```

The path is matched with picomatch after mapping `.` to `/`:

| pattern | meaning |
|---|---|
| `shop.api.web` | one unit |
| `shop.api.*` | every role of `shop.api` |
| `shop.**` | everything in the group |
| `**.web` | every `web` role anywhere |
| `*` | all units (shorthand for `**`) |

Revision and replica are flags, never path segments: `--revision REV`,
`--replica N`, `--all-revisions`. A trailing numeric segment is rejected with a
hint. Zero matches is an error, not a silent success.

Per-verb scope:

| verb | no path | `-f` only | path |
|---|---|---|---|
| `status/logs/stats/inspect/exec` | every unit | that file's unit | the pattern |
| `start/stop/restart/rm` | error (path required) | — | the pattern |

`status --json` emits one object per unit with at least
`{path, kind, revision, expected, live, containers}`.

```sh
bundant status '*' --json | jq -r '.[].path'
bundant status 'shop.**' --json | jq '.[] | select(.live < .expected)'
bundant logs '**.web' --tail 50
bundant rm 'shop.**' --yes --dry-run
```

## Global flags

```text
-f, --file <path>      config path (hosts/runtime; also filters read verbs to one unit)
    --dry-run           print the plan without executing
    --rev <id>          override the revision (file-driven deploys)
    --revision <rev>    flat verbs: select a revision
    --replica <n>       flat verbs: select one replica
    --all-revisions     flat verbs: include stopped revisions
    --local-image <n:t> stream a local image (only missing layers are sent)
    --keep <k>          prune: revisions to keep (default 3)
    --replicas <n>      scale target
    --yes / --images / --volumes
    --route / --env     rm: also remove the proxy route / env file
    --to-revision <rev> rollback/group rollback target
    --skip-smoke        bootstrap: skip the smoke container
    --host / --container
    --tail <n>          default 200
    --follow            logs: stream
    --since <dur>       default 2h
    --port <n>          ui: default 8787
    --json / --hosts
    --strict            validate: require an explicit version
    --allow-case-collision  deploy v2: permit case-only duplicate units
```

## Help, version and completions

```sh
bundant --help
bundant group --help
bundant status --help
bundant --version
bundant --completions bash    # bash|zsh|fish|powershell|sh|pwsh
```

`--completions` is provided by `effect/cli` itself (the generated script is
printed to stdout). Help/version/error rendering is owned by `effect/cli`; all
command names, flags, defaults, output text and exit codes are unchanged for the
file-driven commands.

## Exit codes

`0` success, `1` configuration/validation/transport/engine/health failures or a
selector with no matches, `2` lock contention.
