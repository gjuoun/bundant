---
title: "Operate"
description: "The day-two loop: status, logs, revisions and rollback."
slug: "tutorial/03-operate"
sidebar:
  order: 3
  label: "03 · Operate"
---

# Operate

**Goal:** by the end of this page you can answer "what is running?", read its logs, and put the
previous revision back without editing a file.

## Ship a second revision

Change one value in `deploy.yml`:

```yaml
env:
  vars:
    BUNDANT_DEMO: "2"
```

Every commit is a revision, because the revision is the git short sha of the directory holding
`deploy.yml`. Commit and deploy:

```sh
git add deploy.yml
git commit -m 'change the demo env'
bundant deploy -f deploy.yml
```

```text
deploy hello/web rev=8de4a23 -> root@192.168.2.104
[root@192.168.2.104] deploying default.hello.web.8de4a23
[root@192.168.2.104] pull skipped (present, policy=missing)
[root@192.168.2.104] network ok
[root@192.168.2.104] run ok: default.hello.web.8de4a23
[root@192.168.2.104] health gate passed (1 target(s))
[root@192.168.2.104] proxy-ensure ok
[root@192.168.2.104] proxy-swap ok
[root@192.168.2.104] stop-old ok
deployed default.hello.web.8de4a23 on 1 host(s)
```

## Read it back

```sh
bundant status '*' -f deploy.yml
```

```text
default.hello.web rev=8de4a23 live=1/1 [default.hello.web.8de4a23]
```

```sh
bundant logs '*' -f deploy.yml --tail 5
```

```text
default.hello.web.8de4a23 | 2026/10/20 20:57:31 Starting up on port 80
```

Each line is prefixed with the container it came from, which matters once a service has more than
one replica. `bundant history` lists every retained revision, newest first:

```sh
bundant history -f deploy.yml
```

```text
== root@192.168.2.104 (hello-web) ==
 * default.hello.web.8de4a23 1 replica    Up                       2026-10-20 20:57:31 +0000 UTC
   default.hello.web.0f2c8cc 1 replica    Exited (2) 1 second ago  2026-10-20 20:57:28 +0000 UTC
   default.hello.web.11a45b2 1 replica    Exited (2) 4 seconds ago 2026-10-20 20:57:25 +0000 UTC
  * = running revision
```

## Roll back

`bundant rollback` with no target goes to the previous revision. It starts the old container,
runs the same health gate, swaps the proxy, and stops the current one:

```sh
bundant rollback -f deploy.yml
```

```text
[root@192.168.2.104] rollback: default.hello.web.8de4a23 -> default.hello.web.0f2c8cc (1 replica(s) as deployed)
[root@192.168.2.104] health gate passed on default.hello.web.0f2c8cc
[root@192.168.2.104] rolled back to default.hello.web.0f2c8cc (1 replica(s))
```

```sh
bundant status '*' -f deploy.yml
```

```text
default.hello.web rev=0f2c8cc live=1/1 [default.hello.web.0f2c8cc]
```

```sh
bundant history -f deploy.yml
```

```text
== root@192.168.2.104 (hello-web) ==
   default.hello.web.8de4a23 1 replica    Exited (2) Less than a second ago 2026-10-20 20:57:31 +0000 UTC
 * default.hello.web.0f2c8cc 1 replica    Up                       2026-10-20 20:57:28 +0000 UTC
   default.hello.web.11a45b2 1 replica    Exited (2) 6 seconds ago 2026-10-20 20:57:25 +0000 UTC
```

To pick an exact revision, use `bundant rollback --to-revision <sha> -f deploy.yml`. A revision
is retained until `bundant prune` removes it or you delete the service.

You should see `rolled back to default.hello.web.0f2c8cc` and, in `status`, the revision
after `rev=` change from `8de4a23` back to `0f2c8cc`.

## Did it fail?

- **`no unit matches "shop.nope.**"`** — a selector that matches nothing is an error with
  exit status 3, not a silent success:

  ```text
  bundant: no unit matches "shop.nope.**" (searched labels bundant.group/bundant.service on root@192.168.2.104)
  ```

  Check the pattern and remember that revision and replica are flags, not path segments.
- **`deploy lock for default/hello is held`** — another run owns the lock. Wait for it, or let
  `BUNDANT_LOCK_TTL_S` reclaim a stale lock:

  ```text
  bundant: deploy lock for default/hello is held by tutorial (age 0s; BUNDANT_LOCK_TTL_S reclaims stale locks)
  ```

Next: [Chapter 4 — Scale and groups](/bundant/docs/tutorial/04-scale-and-groups/).
