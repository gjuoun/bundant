---
title: "Scale and groups"
description: "Run several replicas, then deploy a group with a stateful accessory."
slug: "tutorial/04-scale-and-groups"
sidebar:
  order: 4
  label: "04 · Scale and groups"
---

# Scale and groups

**What you get:** several copies of one service behind the proxy, and a group whose web service
waits for a stateful database before it starts.

**Why it matters:** most "high availability" stories need a load balancer, a shared database and a
scheduler. Here the proxy already distributes requests, a **replica** is just a numbered copy of
the same revision, and an **accessory** is a stateful member that keeps its name and its data.

Three words on this page:

- **replica** — one of N copies of the same revision on a host; `replicas: 3` names them
  `.1`, `.2`, `.3` and the proxy balances across all of them.
- **accessory** — a stateful group member (a database, a queue): stable name, named volumes (a
  volume is storage that outlives the container), no revision, no proxy, and never recreated by a
  deploy.
- **group** — a directory with a `group.yml` that lists members and their `needs` edges; the
  install order is the topological sort of those edges.

## More than one replica 📈

This is the complete `deploy.yml` with `replicas: 3` added. Commit it and deploy:

```yaml
version: 2
service: hello
role: web
image: traefik/whoami:v1.10
hosts: [root@box.example.com]
replicas: 3
env:
  vars:
    BUNDANT_DEMO: "2"
healthcheck:
  path: /
  timeout: 30
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
```

```sh
git add deploy.yml
git commit -m 'run three replicas'
bundant deploy -f deploy.yml
```

```text
deploy hello/web rev=7db591d -> root@box.example.com
[root@box.example.com] deploying default.hello.web.7db591d.1, default.hello.web.7db591d.2, default.hello.web.7db591d.3
[root@box.example.com] pull skipped (present, policy=missing)
[root@box.example.com] network ok
[root@box.example.com] run ok: default.hello.web.7db591d.1, default.hello.web.7db591d.2, default.hello.web.7db591d.3
[root@box.example.com] health gate passed (3 target(s))
[root@box.example.com] proxy-ensure ok
[root@box.example.com] proxy-swap ok
[root@box.example.com] stop-old ok
deployed default.hello.web.7db591d.1, default.hello.web.7db591d.2, default.hello.web.7db591d.3 on 1 host(s)
```

```sh
bundant status '*' -f deploy.yml
```

```text
default.hello.web rev=7db591d live=3/3 [default.hello.web.7db591d.3, default.hello.web.7db591d.2, default.hello.web.7db591d.1]
```

`scale` changes the running revision without a deploy. It never pulls an image and never edits
your file:

```sh
bundant scale --replicas 5 -f deploy.yml
```

```text
== root@box.example.com ==
  revision 7db591d: 3 running (1, 2, 3) -> 5
  run ok (default.hello.web.7db591d.4, default.hello.web.7db591d.5)
  health ok (2 target(s))
  proxy-swap ok
  scaled to 5 replica(s)
bundant: scale is temporary - deploy.yml replicas: stays authoritative; the next `bundant deploy` re-applies it.
```

`deploy.yml` still says 3, so `status` shows the drift:

```sh
bundant status '*' -f deploy.yml
```

```text
default.hello.web rev=7db591d live=5/3 [default.hello.web.7db591d.5, default.hello.web.7db591d.4, default.hello.web.7db591d.3, default.hello.web.7db591d.2, default.hello.web.7db591d.1]
```

Scale back down. The proxy loses the two targets before the containers stop, so no in-flight
request is cut off:

```sh
bundant scale --replicas 3 -f deploy.yml
```

```text
== root@box.example.com ==
  revision 7db591d: 5 running (1, 2, 3, 4, 5) -> 3
  proxy-swap ok
  stop-old ok (default.hello.web.7db591d.4, default.hello.web.7db591d.5)
  scaled to 3 replica(s)
bundant: scale is temporary - deploy.yml replicas: stays authoritative; the next `bundant deploy` re-applies it.
```

The topology below shows both shapes: three replicas behind one proxy route, and a group whose
web member depends on an accessory that owns a volume.

```mermaid
flowchart TD
  subgraph svc["hello · replicas 3"]
    direction LR
    P1["proxy<br/>hello.bundant.test"] -- "one proxy route" --> H1["replicas .1 · .2 · .3"]
  end
  subgraph grp["group shop"]
    direction TB
    P2["proxy<br/>shop.bundant.test"] -- "health gate" --> W["shop.web.web.e05b32b"]
    W -. "needs: db" .-> D["shop.db<br/>accessory"]
    D -- "named volume" --> V[("pgdata")]
  end
  H1 -- "same host" --> BRIDGE["two routes, one host"] -- "same host" --> P2
  subgraph notes["notes"]
    direction LR
    N2["accessory keeps<br/>its name and data"]
    N1["replicas share<br/>one proxy route"]
    N3["needs: db<br/>is an install order"]
    N2 ~~~ N1 ~~~ N3
  end
  V -. "deploy never recreates it" .-> N2
  H1 -. "three containers" .-> N1
  W -. "tcp 5432" .-> N3
  classDef local fill:#143038,color:#40c4ff,stroke:#494848;
  classDef ok fill:#0f2a17,color:#00c853,stroke:#494848;
  classDef storage fill:#211a33,color:#ae81ff,stroke:#494848;
  classDef neutral fill:#2e332e,color:#d9d9d4,stroke:#494848;
  class P1,P2 local;
  class H1,W ok;
  class D,V storage;
  class BRIDGE,N1,N2,N3 neutral;
```

*Colour legend: blue = an action on your machine or a normal step · green = healthy or live · orange = the one irreversible step · purple = storage and state.*

## A group with an accessory 🧩

A group is a directory. `shop/group.yml` lists the members; each member has its own complete file:

```yaml
# shop/group.yml
version: 2
group: shop
services:
  - name: db
    file: ./db/accessory.yml
  - name: web
    file: ./web/deploy.yml
    needs: [db]
```

The database is an accessory: no revision, no proxy, a stable name and a named volume.

```yaml
# shop/db/accessory.yml
version: 2
kind: accessory
service: db
image: docker.io/library/postgres:16-alpine
hosts: [root@box.example.com]
env:
  vars:
    POSTGRES_DB: shop
    POSTGRES_USER: shop
    POSTGRES_PASSWORD: tutorial
volumes:
  - "pgdata:/var/lib/postgresql/data"
healthcheck:
  tcp: 5432
  timeout: 60
proxy:
  enabled: false
```

`shop/web/deploy.yml` is a normal service file. It names the service `web` and routes to
`shop.bundant.test`:

```yaml
# shop/web/deploy.yml
version: 2
service: web
image: traefik/whoami:v1.10
hosts: [root@box.example.com]
healthcheck:
  path: /
  timeout: 30
proxy:
  enabled: true
  host: shop.bundant.test
  port: 80
```

Validate the group, then install it:

```sh
bundant validate -f shop/group.yml
```

```text
bundant validate: OK
  version: 2
  group: shop
  revision: e05b32b (git short sha of ~/bundant-tutorial/app/shop)
  order: db -> web
  member db: shop.db round-trip=true
  member web: shop.web.web.e05b32b round-trip=true
```

`group install` deliberately refuses to create the database for you:

```sh
bundant group install -f shop/group.yml
```

```text
bundant group install - shop rev=e05b32b order=db -> web
  shop.db: absent on root@box.example.com
bundant: accessory 'db' is not ready - start it first:
  bundant start -f ~/bundant-tutorial/app/shop/db/accessory.yml
group install report: applied [] failed [db] skipped [db, web]
```

Start it explicitly, then install the group again:

```sh
bundant start -f shop/db/accessory.yml
bundant group install -f shop/group.yml
```

```text
bundant accessory boot - shop.db on root@box.example.com (image docker.io/library/postgres:16-alpine, runtime docker)
== root@box.example.com ==
  container shop.db started
  tcp readiness ok on :5432
booted shop.db on 1 host(s)
bundant group install - shop rev=e05b32b order=db -> web
  shop.db: ready (tcp:5432) on root@box.example.com
deploy web/web rev=e05b32b -> root@box.example.com
[root@box.example.com] deploying shop.web.web.e05b32b
[root@box.example.com] pull skipped (present, policy=missing)
[root@box.example.com] network ok
[root@box.example.com] run ok: shop.web.web.e05b32b
[root@box.example.com] health gate passed (1 target(s))
[root@box.example.com] proxy-ensure ok
[root@box.example.com] proxy-swap ok
[root@box.example.com] stop-old ok
deployed shop.web.web.e05b32b on 1 host(s)
group install report: applied [db, web]
```

```sh
bundant group status -f shop/group.yml | grep -E '===|volumes:|replicas:|revision:|health'
curl -s -H 'Host: shop.bundant.test' http://box.example.com/
```

```text
=== shop/db (accessory) ===
  volumes: pgdata
=== shop/web (service) ===
  replicas: live 1 / expected 1
  revision: shop.web.web.e05b32b
  health(shop.web.web.e05b32b): HTTP 200
Hostname: 7f047f6dcc1a
IP: 127.0.0.1
IP: ::1
```

You should see `order: db -> web` from validation and `group install report: applied [db, web]`
after the accessory is running. `needs: [db]` is why web waits for the TCP probe on 5432.

## What actually happens ⚙️

Each replica is a separate container named `<group>.<service>.<role>.<rev>.<i>` and labelled
`bundant.replica=<i>`, all carrying the same `bundant.revision`. Deploy gates each one, then makes
**one** proxy call with the full target set. Scaling down reverses the safety order: proxy first
(drain), then stop and remove. A group install takes one group lock, then each service's own lock;
an accessory dependency is checked by a bare TCP connect from a throwaway busybox sidecar on the
`bundant` network. The rules are in the
[deploy.yml reference](/bundant/docs/deploy-yml/#replicas), including
[group.yml](/bundant/docs/deploy-yml/#groupyml) and
[accessory.yml](/bundant/docs/deploy-yml/#accessoryyml).

## Did it fail? ⚠️

- **`replicas > 1 requires proxy.enabled: true`** — without a proxy nothing distributes
  traffic between the copies. Add `proxy: { enabled: true, host: ... }`.
- **The accessory is absent** — `group install` stops and prints the exact `bundant start -f`
  command. Accessories are never created by a group install, so their data is never surprising.

Next: [Chapter 5 — Observe and debug](/bundant/docs/tutorial/05-observe/).
