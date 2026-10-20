---
title: "Troubleshooting"
description: "The errors a deploy can produce: the message, the cause and the fix."
slug: "troubleshooting"
sidebar:
  order: 10
---

# Troubleshooting

Every message below comes from a real run. Find the line that matches yours; the cause and the fix
sit under it. Read this after the tutorial chapter that hit the failure — the happy path stays in
the tutorial.

## The command is not found

```text
bundant: command not found
```

**Cause:** `bun link` wrote the command under Bun's global bin, which is not on `PATH`.

**Fix:** add it and check the version:

```sh
export PATH="$HOME/.bun/bin:$PATH"
bundant --version
```

## Unsupported config version

```text
bundant validate: FAILED (1 error(s))
  - version: unsupported config version 3 (supported: 2)
```

**Cause:** the file must start with `version: 2`.

**Fix:** set `version: 2` at the top of `deploy.yml` and validate again.

## Unrecognized key

```text
bundant validate: FAILED (1 error(s))
  version: 2
  - (root): Unrecognized key(s) in object: 'helthcheck'
```

**Cause:** a field name is misspelled; unknown keys are rejected rather than ignored.

**Fix:** rename it to `healthcheck` and validate again.

## proxy.host is missing

```text
proxy.host is required when proxy.enabled is true
```

**Cause:** the proxy is enabled without a `Host` name for the service.

**Fix:** add `proxy.host`, or set `proxy: { enabled: false }` for a worker that publishes no
route.

## Replicas without a proxy

```text
replicas > 1 requires proxy.enabled: true
```

**Cause:** without a proxy nothing distributes traffic between the copies.

**Fix:** add `proxy: { enabled: true, host: ... }` or run a single replica.

## The image cannot be pulled

**Cause:** the tag does not exist, or the host is not logged in to a private registry.

**Fix:** check the image tag and, on a private registry, log the host in first. Without a
registry, stream a local image with `--local-image`.

## ssh connection refused

```text
ssh: connect to host ... port 22: Connection refused
```

**Cause:** the host is unreachable, or passwordless ssh is not set up.

**Fix:** check the address and that passwordless ssh works:

```sh
ssh root@box.example.com true
```

## The accessory is not ready

```text
bundant group install - shop rev=e05b32b order=db -> web
  shop.db: absent on root@box.example.com
bundant: accessory 'db' is not ready - start it first:
  bundant start -f ~/bundant-tutorial/app/shop/db/accessory.yml
group install report: applied [] failed [db] skipped [db, web]
```

**Cause:** accessories are never created by a group install, so their data is never surprising.

**Fix:** start it with the printed `bundant start -f` command, then install the group again.

## No unit matches the selector

```text
bundant: no unit matches "shop.nope.**" (searched labels bundant.group/bundant.service on root@box.example.com)
```

**Cause:** a selector that matches nothing is an error with exit status 3, not a silent success.

**Fix:** check the pattern; revision and replica are flags, not path segments.

## The deploy lock is held

```text
bundant: deploy lock for default/hello is held by tutorial (age 0s; BUNDANT_LOCK_TTL_S reclaims stale locks)
```

**Cause:** another run owns the per-service lock, or a stale lock was left behind.

**Fix:** wait for the other run, or set `BUNDANT_LOCK_TTL_S` to reclaim a stale lock. Check
`bundant history` for what is running.

## The health gate failed

```text
bundant: health gate failed: GET http://default.broken.web.e05b32b:59999/ never returned 200 (last: curl: (7) Failed to connect to default.broken.web.e05b32b port 59999 after 0 ms: Could not connect to server
000)
```

**Cause:** the probe cannot reach the port or path the app answers on.

**Fix:** correct `healthcheck.port` (the port your app listens on) or `healthcheck.path`, then
redeploy. The failed container has already been removed and the previous revision still serves.

## The runtime reports no engine

```text
root@box.example.com engine=docker version=... api=... socket=... service=inactive
```

**Cause:** `bundant runtime` found an engine but its service is not running.

**Fix:** on a podman host run `bundant bootstrap -f deploy.yml`; on docker, start the daemon.

## The UI port is taken

```text
Failed to start server. Is port 8787 in use?
```

**Cause:** another `bundant ui` is still open.

**Fix:** use `bundant ui --port 8788`, or close the old one.
