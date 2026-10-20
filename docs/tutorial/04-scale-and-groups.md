---
title: "Scale and groups"
description: "Run several replicas, then deploy a group with a stateful accessory."
slug: "tutorial/04-scale-and-groups"
sidebar:
  order: 4
  label: "04 · Scale and groups"
---

# Scale and groups

**Goal:** by the end of this page you can run several copies of one service, and install a group
whose web service waits for a stateful database.

## More than one replica

Set `replicas: 3` in `deploy.yml`, commit, and deploy:

```sh
git add deploy.yml
git commit -m 'run three replicas'
bundant deploy -f deploy.yml
```

```text
deploy hello/web rev=7db591d -> root@192.168.2.104
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
  revision 7db591d: 3 running (1, 2, 3) -> 5
  scaled to 5 replica(s)
```

`deploy.yml` still says 3, so `status` shows the drift:

```text
default.hello.web rev=7db591d live=5/3 [default.hello.web.7db591d.5, ...]
```

Scale back down. The proxy loses the two targets before the containers stop, so no in-flight
request is cut off:

```sh
bundant scale --replicas 3 -f deploy.yml
```

```text
  revision 7db591d: 5 running (1, 2, 3, 4, 5) -> 3
  scaled to 3 replica(s)
```

## A group with an accessory

A group is a directory. `shop/group.yml` lists the members; each member has its own file:

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
hosts: [root@192.168.2.104]
env: { vars: { POSTGRES_DB: shop, POSTGRES_USER: shop, POSTGRES_PASSWORD: tutorial } }
volumes: ["pgdata:/var/lib/postgresql/data"]
healthcheck: { tcp: 5432, timeout: 60 }
proxy: { enabled: false }
```

Create `shop/web/deploy.yml` exactly like chapter 2's file, with
`proxy.host: shop.bundant.test` and `service: web`. Validate the group, then install it:

```sh
bundant validate -f shop/group.yml
```

```text
bundant validate: OK
  group: shop
  revision: e05b32b (git short sha of ~/bundant-tutorial/app/shop)
  order: db -> web
  member db: shop.db round-trip=true
  member web: shop.web.web.e05b32b round-trip=true
```

`group install` deliberately refuses to create the database for you:

```text
bundant group install - shop rev=e05b32b order=db -> web
  shop.db: absent on root@192.168.2.104
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
booted shop.db on 1 host(s)
group install report: applied [db, web]
```

```sh
bundant group status -f shop/group.yml | grep -E '===|volumes:|replicas:|revision:|health'
curl -s -H 'Host: shop.bundant.test' http://192.168.2.104/
```

```text
=== shop/db (accessory) ===
  volumes: pgdata
=== shop/web (service) ===
  replicas: live 1 / expected 1
  revision: shop.web.web.e05b32b
  health(shop.web.web.e05b32b): HTTP 200
Hostname: 92abc6dd6c9e
```

You should see `order: db -> web` from validation and `group install report: applied [db, web]`
after the accessory is running. `needs: [db]` is why web waits for the TCP probe on 5432.

## Did it fail?

- **`replicas > 1 requires proxy.enabled: true`** — without a proxy nothing distributes
  traffic between the copies. Add `proxy: { enabled: true, host: ... }`.
- **The accessory is absent** — `group install` stops and prints the exact `bundant start -f`
  command. Accessories are never created by a group install, so their data is never surprising.

Next: [Chapter 5 — Observe and debug](/bundant/docs/tutorial/05-observe/).
