# CLI

bundant's command tree is declared with `effect/cli`. The root command owns the
shared flags; every subcommand handler returns an Effect and surfaces the typed
errors from `src/effect/errors.ts`.

## Commands

```text
validate  deploy  scale  rollback  history  status  delete  prune
bootstrap runtime  ps  stats  inspect  logs  events  exec  ui
group      { install | uninstall | status | rollback }
accessory  { boot | reboot | stop | logs | status | remove }
```

- `group` with no action defaults to `install`.
- `accessory` with no action defaults to `status`.
- `exec … -- <cmd…>` forwards everything after `--` to the remote command.
- `logs --follow` keeps the old SIGINT behaviour and closes its forwards.

## Global flags

```text
-f, --file <path>      config path (deploy.yml; accessory.yml/group.yml for those commands)
    --dry-run           print the plan without executing
    --rev <id>          override the revision
    --local-image <n:t> stream a local image
    --keep <k>          prune: revisions to keep (default 3)
    --replicas <n>      scale target
    --yes / --images / --volumes
    --to-revision <rev> rollback/group rollback target
    --skip-smoke        bootstrap: skip the smoke container
    --host / --container
    --tail <n>          default 200
    --follow            logs: stream
    --since <dur>       default 2h
    --port <n>          ui: default 8787
    --json / --hosts
    --via cli|api       default api
    --strict            validate: require an explicit version
```

## Help, version and completions

```sh
bundant --help
bundant group --help
bundant deploy --help
bundant --version
bundant --completions bash    # bash|zsh|fish|powershell|sh|pwsh
```

`--completions` is provided by `effect/cli` itself (the generated script is
printed to stdout). Help/version/error rendering is owned by `effect/cli`; all
command names, flags, defaults, output text and exit codes are unchanged.

## Exit codes

`0` success, `1` configuration/validation/transport/engine/health failures,
`2` lock contention.
