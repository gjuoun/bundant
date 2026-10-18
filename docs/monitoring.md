# Monitoring: CLI + local UI

bundant's monitoring surface is **pull-on-demand and read-only**. Starting to
watch is what pulls data: every query is one ssh round trip per host, executed in
parallel over the same multiplexed connection the deploys use. Nothing is
installed on the host, nothing stays resident, and no port is opened on it.

```sh
bundant ps                       # every container on every host
bundant stats                    # one cpu/mem/pids snapshot per host
bundant logs --container hello   # tail, all hosts in parallel (host-prefixed)
bundant logs --follow            # stream logs (host-prefixed when >1 host)
bundant inspect hello-web        # state, restarts, health, image, restart policy
bundant exec --host docker01 --container hello-web -- sh   # PTY through ssh
bundant events --since 2h        # runtime events window (bounded, never follows)
bundant ui                       # local read-only page at http://127.0.0.1:8787
```

All of them take `-f deploy.yml` (default `./deploy.yml`) and honour
`BUNDANT_HOSTS`; `--host` narrows a command to one host. `logs` accepts
`--container <selector>` — an exact container name or a prefix, resolved against
running containers first so a service with retained old revisions picks the live
one (falling back to stopped ones when nothing is running).

## The local UI

`bundant ui` serves one page (no build step, no dependencies) with five tabs:
containers, stats, logs, proxy routing, and events. It binds `127.0.0.1` by
default, so only your machine can reach it:

- **containers / proxy / events** — refreshed on demand (auto every 5s)
- **stats** — a snapshot plus a sparkline built from the samples *this page*
  collected while it was open; there is no host-side history (see below)
- **logs** — pick host + container, tail, optional auto-refresh

Remote access is a tunnel, not an exposed port:
`ssh -L 8787:127.0.0.1:8787 <some-host>` then open `http://127.0.0.1:8787`, or
reach the laptop's tailnet address.

## What this deliberately does not do

- **No host-side agent, no daemon, no hub.** Progressive adoption: start with the
  pull path (this), add a reporter later only if we need it.
- **No retention.** History is what the current session observed, and it dies with
  it. Container events are bounded by the runtime: podman keeps them in the
  journal (small by default), docker keeps a ring buffer. Once a revision is
  pruned its logs are gone — `bundant ps`/`logs` cannot answer "why did the
  previous version die at 03:00".
- **No push alerts.** You find out by looking (or by the deploy/CI path failing).
- If we ever want durable retention, offline windows, or alerting, the design that fits
  is the one discussed in `docs/architecture.md`: a small read-only collector per
  host reporting to one hub, with actions (exec/deploy) staying on the ssh path.

## Notes from the field

- `podman events` streams forever; bundant bounds it with `timeout 3` and
  neutralises the exit code, so `events` always returns a window.
- The kamal-proxy routing table is printed with ANSI colours by the proxy itself;
  bundant strips them before rendering.
- `exec` runs `-- <cmd>` after a `--` separator, which is also where global flag
  parsing stops: `bundant exec --container c -- sh --version` runs `sh --version`
  instead of printing bundant's version.
