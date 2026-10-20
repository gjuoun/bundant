---
title: "CLI reference"
description: "Every command, flag, selector and exit status."
slug: "cli"
sidebar:
  order: 2
---

# CLI reference

Read this after [chapter 3](/bundant/docs/tutorial/03-operate/) and
[chapter 5](/bundant/docs/tutorial/05-observe/).

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


## Machine-readable output

Every command accepts `--json`: stdout then carries exactly one JSON object, while progress and
human logs stay on stderr.

```json
{"ok":true,"command":"status","data":[{"path":"default.hello.web","live":1}]}
```

```json
{"ok":false,"command":"deploy","error":{"code":"HEALTH_TIMEOUT","message":"new revision never became healthy","details":{"unit":"default.hello.web","timeoutMs":30000}}}
```

- One object, one line, on stdout. Nothing else is written there in JSON mode.
- `command` is the top-level command that ran.
- `data` is the command's payload; unknown keys may be added, so clients ignore them.
- `error.details` carries the tagged error's extra fields (host, service, target, …).
- A bad command line is rejected before any command runs: unknown flag, unknown subcommand, missing
  value or a bad choice is `USAGE` + exit 4. Help text is never dumped for a usage failure;
  `--help` still prints help.

### Error catalog

The catalog is the public contract. Codes never change meaning across minor versions; a client may
switch on `code` alone.

| code | exit | when |
|---|---|---|
| `OK` | 0 | success |
| `USAGE` | 4 | unknown flag, missing argument, bad selector syntax |
| `CONFIG_INVALID` | 1 | YAML does not parse or violates the v2 schema |
| `CONFIG_VERSION_UNSUPPORTED` | 1 | `version:` names a module we do not ship |
| `VALIDATION_FAILED` | 1 | preflight rejected the plan (collision, missing host, bad reference) |
| `NO_MATCH` | 3 | a selector matched zero units |
| `LOCK_HELD` | 2 | another deploy holds the group lock |
| `ENGINE_UNAVAILABLE` | 1 | the engine socket cannot be reached or started |
| `API_DRIFT` | 1 | the engine's response does not match the generated types |
| `HEALTH_TIMEOUT` | 1 | the new revision never became healthy |
| `PROXY_SWAP_FAILED` | 1 | the proxy rejected the target swap |
| `TRANSPORT_ERROR` | 1 | ssh failed or the connection dropped |
| `NOT_FOUND` | 1 | the named unit, revision or container does not exist |
| `INTERNAL` | 1 | a defect; message plus a short tag |

`bundant errors --json` prints the catalog itself:

```sh
bundant errors --json | jq -r '.data[] | "\(.code) \(.exitCode)"'
```

### Exit status

| status | meaning |
|---|---|
| 0 | `OK` |
| 2 | `LOCK_HELD` |
| 3 | `NO_MATCH` |
| 4 | `USAGE` |
| 1 | every other failure |

A JSON client checks both the envelope and the status: `ok:false` and the table always agree.

### Data shapes

| command | `data` |
|---|---|
| `status` | array of `{path, kind, revision, expected, live, containers}` |
| `validate` | the validation report, including the resolved identity |
| `runtime` | array of per-host detection reports |
| `ps` / `stats` / `inspect` | array of `{host, ok, error?, rows}` |
| `events` | array of `{host, lines}` |
| `logs` | array of `{host, container, lines}` |
| `deploy` | `{status, phases, totalMs}`, or `{status:"dry-run", plan}` |
| `start` / `stop` / `restart` | `{started|stopped|restarted: [container...]}` |
| `rm` | `{units: [container...]}` |
| `exec` | `{containers, exitCode}` |
| `errors` | the catalog array `{code, exitCode, when}` |
| other action verbs | `null` on success |

`schema/errors.json` is generated from the catalog by `bun run errors:gen`; a client can
validate a response before switching on `code`. The test suite fails if the file drifts.

The envelope, codes, statuses and command names are stable across minor versions. Human output is
not a machine interface and may change.
