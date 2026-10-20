---
title: "Observe and debug"
description: "Inspect the host, read events, open the UI and diagnose a failed deploy."
slug: "tutorial/05-observe"
sidebar:
  order: 5
  label: "05 · Observe and debug"
---

# Observe and debug

**Goal:** by the end of this page you can see what every host is running, read its events, open
the local UI, and explain why a deploy failed.

## Look at the host

All monitoring is read-only and pull-on-demand: one ssh round trip per host, nothing installed
there.

```sh
bundant ps -f deploy.yml | grep -E 'hello|shop|kamal'
```

```text
  shop.web.web.e05b32b         traefik/whoami:v1.10                   Up 3 seconds   80/tcp
  shop.db                      docker.io/library/postgres:16-alpine   Up 7 seconds   5432/tcp
  default.hello.web.7db591d.3  traefik/whoami:v1.10                   Up 17 seconds  80/tcp
  kamal-proxy                  docker.io/basecamp/kamal-proxy:latest  Up 2 days      0.0.0.0:80->80/tcp
```

```sh
bundant stats '*' -f deploy.yml | sed -n '1,8p'
bundant events --since 5m -f deploy.yml | sed -n '1,8p'
```

```text
== root@192.168.2.104 ==
  shop.web.web.e05b32b         0.00%  1.45MiB / 8.00GiB   0.02%  5
  shop.db                      0.00%  66.85MiB / 8.00GiB  0.82%  6
  default.hello.web.7db591d.3  0.00%  2.47MiB / 8.00GiB   0.03%  5
== root@192.168.2.104 ==
  1792529941|container|die|default.hello.web.0f2c8cc
  1792529942|container|create|default.hello.web.7db591d.4
  1792529943|container|start|default.hello.web.7db591d.4
```

`inspect` reads one container's state. `exec` runs a command inside a unit; everything after
`--` is passed through untouched:

```sh
bundant inspect '*' -f deploy.yml
bundant exec 'shop.db' -f shop/db/accessory.yml -- hostname
```

```text
== root@192.168.2.104 ==
  name          shop.web.web.e05b32b
  state         running
  restarts      0  exitCode=0
  image         traefik/whoami:v1.10
c22a56960f06
```

## The local UI

`bundant ui` serves one read-only page from your machine. It binds `127.0.0.1` by default, so
the host exposes no new port:

```sh
bundant ui -f deploy.yml
```

```text
bundant ui - http://127.0.0.1:8787
  hosts: root@192.168.2.104
  read-only, pull-on-demand: every query is one ssh round trip per host; nothing runs on them
  remote access: ssh -L 8787:127.0.0.1:8787 <host> (or tailscale)
```

It returns `200` on `http://127.0.0.1:8787/`; the containers, stats, logs, proxy and events
tabs fill in as the page polls.

## Diagnose a failed deploy

A config can be valid and still fail on the host. This one asks the health gate to probe a port
nothing listens on:

```yaml
# broken/deploy.yml
version: 2
service: broken
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
healthcheck: { path: /, port: 59999, timeout: 5 }
proxy: { enabled: false }
```

```sh
bundant deploy -f broken/deploy.yml
```

```text
deploy broken/web rev=e05b32b -> root@192.168.2.104
[root@192.168.2.104] run ok: default.broken.web.e05b32b
[root@192.168.2.104] aborted, removed containers started by this run (default.broken.web.e05b32b)
bundant: health gate failed: GET http://default.broken.web.e05b32b:59999/ never returned 200
(last: curl: (7) Failed to connect to default.broken.web.e05b32b port 59999 after 0 ms: Could not connect to server
000)
```

The failed container is gone, and the previous revision kept serving:

```sh
bundant ps -f broken/deploy.yml | grep broken || echo 'no broken container left'
```

```text
no broken container left
```

A held lock stops a second deploy before it touches the host:

```text
bundant: deploy lock for default/hello is held by tutorial (age 0s; BUNDANT_LOCK_TTL_S reclaims stale locks)
```

## When the host has nothing

On a host with only sshd, bootstrap installs podman, configures the registry search path, enables
the restart unit and runs a smoke container. Every step is idempotent:

```sh
bundant bootstrap -f hello-podman.yml
```

```text
  - podman version
    podman version 5.7.0
  - smoke test (pull + run)
    smoke test passed
  engine: podman 5.7.0  socket: /run/podman/podman.sock  service: enabled
  ready
```

You should see `health gate failed` with the probe URL for a broken health check,
`no broken container left` afterwards, and `ready` from bootstrap. The deploy that failed
never swapped the proxy, so the previous revision keeps serving.

## Did it fail?

- **`health gate failed`** — the URL and the port are in the message. Fix
  `healthcheck.port` (the port your app listens on) or the path, then redeploy.
- **`deploy lock ... is held`** — another deploy owns the service lock. Wait, or set
  `BUNDANT_LOCK_TTL_S` to reclaim a stale lock; check `bundant history` for what is running.
- **`engine=docker ... service=inactive`** from `bundant runtime` — the host has no running
  engine. On a podman host run `bundant bootstrap -f deploy.yml`; on docker, start the daemon.
- **`Failed to start server. Is port 8787 in use?`** — another `bundant ui` is still open.
  Use `bundant ui --port 8788` or close the old one.

Next: the reference starts at [deploy.yml](/bundant/docs/deploy-yml/); the internals are in
[Architecture](/bundant/docs/architecture/).
