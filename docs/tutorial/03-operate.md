---
title: "Operate"
description: "The day-two loop: status, logs, revisions and rollback."
slug: "tutorial/03-operate"
sidebar:
  order: 3
  label: "03 · Operate"
---

# Operate

**What you get:** you can answer "what is running?", read its logs, and put the previous revision
back without editing a file.

**Why it matters:** deploys are the easy part. The cost shows up on day two, when a new revision
looks healthy but behaves badly and you need the old one back in seconds.

## Ship a second revision 🚀

Change one value in the complete `deploy.yml` from chapter 2:

```yaml
version: 2
service: hello
role: web
image: traefik/whoami:v1.10
hosts: [root@box.example.com]
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

Every commit is a revision, because the revision is the git short sha of the directory holding
`deploy.yml`. Commit and deploy:

```sh
git add deploy.yml
git commit -m 'change the demo env'
bundant deploy -f deploy.yml
```

```text
deploy hello/web rev=8de4a23 -> root@box.example.com
[root@box.example.com] deploying default.hello.web.8de4a23
[root@box.example.com] pull skipped (present, policy=missing)
[root@box.example.com] network ok
[root@box.example.com] run ok: default.hello.web.8de4a23
[root@box.example.com] health gate passed (1 target(s))
[root@box.example.com] proxy-ensure ok
[root@box.example.com] proxy-swap ok
[root@box.example.com] stop-old ok
deployed default.hello.web.8de4a23 on 1 host(s)
```

## Read it back 📊

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
default.hello.web.8de4a23 | 2026/10/20 21:31:47 Starting up on port 80
```

Each line is prefixed with the container it came from, which matters once a service has more than
one copy (a **replica**, covered in chapter 4). `bundant history` lists every retained revision,
newest first — the timestamps and the `Up`/`Exited` ages are from the run that produced this page,
so yours will show different ones:

```sh
bundant history -f deploy.yml
```

```text
== root@box.example.com (hello-web) ==
 * default.hello.web.8de4a23 1 replica    Up                       2026-10-20 21:31:47 +0000 UTC
   default.hello.web.0f2c8cc 1 replica    Exited (2) 1 second ago  2026-10-20 21:31:44 +0000 UTC
   default.hello.web.11a45b2 1 replica    Exited (2) 3 seconds ago 2026-10-20 21:31:42 +0000 UTC
  * = running revision
```

## Roll back ⏪

**Rollback** means starting a retained revision and pointing the proxy back at it. `bundant
rollback` with no target goes to the previous revision: it starts the old container, runs the same
health gate, swaps the proxy, and stops the current one:

```sh
bundant rollback -f deploy.yml
```

```text
[root@box.example.com] rollback: default.hello.web.8de4a23 -> default.hello.web.0f2c8cc (1 replica(s) as deployed)
[root@box.example.com] health gate passed on default.hello.web.0f2c8cc
[root@box.example.com] rolled back to default.hello.web.0f2c8cc (1 replica(s))
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
== root@box.example.com (hello-web) ==
   default.hello.web.8de4a23 1 replica    Exited (2) Less than a second ago 2026-10-20 21:31:47 +0000 UTC
 * default.hello.web.0f2c8cc 1 replica    Up                       2026-10-20 21:31:44 +0000 UTC
   default.hello.web.11a45b2 1 replica    Exited (2) 6 seconds ago 2026-10-20 21:31:42 +0000 UTC
```

The timeline is the point of the design: the old container is stopped, never removed, so rollback
is a **start**, not a rebuild. The stopped revisions wait until `bundant prune` keeps the newest
`--keep` (default 3) and removes the rest.

```mermaid
flowchart TD
  r1["11a45b2 · first revision<br/>stopped, kept"] -- "deploy" --> r2["0f2c8cc · second revision<br/>healthy, live"]
  r2 -- "deploy" --> r3["8de4a23 · third revision<br/>live"]
  r3 -- "rollback, no target" --> r4["0f2c8cc · live again"]
  subgraph notes["notes"]
    direction LR
    kept["older revisions<br/>stay stopped"]
    n1["starts the old one;<br/>old stays live<br/>until the swap"]
    kept ~~~ n1
  end
  r1 -. "prune keeps newest 3" .-> kept
  r4 -. "rollback starts it again" .-> n1
  classDef ok fill:#0f2a17,color:#00c853,stroke:#494848;
  classDef risk fill:#2e1a12,color:#fc5d23,stroke:#494848;
  classDef storage fill:#211a33,color:#ae81ff,stroke:#494848;
  classDef neutral fill:#2e332e,color:#d9d9d4,stroke:#494848;
  class r2,r3 ok;
  class r4 risk;
  class kept storage;
  class r1,n1 neutral;
```

To pick an exact revision, use `bundant rollback --to-revision <sha> -f deploy.yml`. A revision
is retained until `bundant prune` removes it or you delete the service.

You should see `rolled back to default.hello.web.0f2c8cc` and, in `status`, the revision
after `rev=` change from `8de4a23` back to `0f2c8cc`.

## What actually happens ⚙️

`deploy` takes a per-service `mkdir` **lock** on the first host — `~/.bundant/locks/default/hello.lock`,
holding an owner line and reclaimed after `BUNDANT_LOCK_TTL_S` — so two deploys cannot interleave.
Each container carries `bundant.revision` and `bundant.replica` labels; `status`, `history`,
`scale` and `rollback` read those labels rather than a local file. `rollback` selects the
previous revision (or `--to-revision`), starts the stopped container, re-runs the health gate, does
one proxy deploy, then stops the revision that was live. Commands and exit codes are in the
[CLI reference](/bundant/docs/cli/); the sequence is in
[Architecture](/bundant/docs/architecture/).

## Did it fail? ⚠️

A **unit** is one addressable thing bundant manages: a service or an accessory. A **selector** is
the unit path you pass to a flat verb — `group.service.role` for a service, `group.service` for an
accessory — matched as a glob, where `*` is one segment and `**` is any number.

- **`no unit matches "shop.nope.**"`** — a selector that matches nothing is an error with
  exit status 3, not a silent success:

  ```text
  bundant: no unit matches "shop.nope.**" (searched labels bundant.group/bundant.service on root@box.example.com)
  ```

  Check the pattern and remember that revision and replica are flags, not path segments.
- **`deploy lock for default/hello is held`** — another run owns the lock. Wait for it, or let
  `BUNDANT_LOCK_TTL_S` reclaim a stale lock:

  ```text
  bundant: deploy lock for default/hello is held by tutorial (age 0s; BUNDANT_LOCK_TTL_S reclaims stale locks)
  ```

Next: [Chapter 4 — Scale and groups](/bundant/docs/tutorial/04-scale-and-groups/).
