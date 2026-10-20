---
title: "Agent contract"
description: "Machine-readable fields an agent can rely on: errors, arch preflight and sessiond."
slug: "agent"
---

# Agent contract

This page pins the fields scripts and agents switch on. Everything here is
additive: a client must ignore unknown keys.

## Errors

`bundant errors --json` is the source of truth (`schema/errors.json` is generated
from the same catalog). Arch preflight adds one code:

| code | exit | when |
|---|---|---|
| `ARCH_MISMATCH` | 1 | the image os/arch differs from the target host, or `--allow-emulation` was passed without a matching binfmt entry |

The message names the image ref, the image platform and the host platform:

```text
arch mismatch: image app:t1 is linux/arm64 but host linux/amd64 (pass --allow-emulation to run under qemu)
```

`details` carries `image`, `imagePlatform` and `hostPlatform`.

## Arch preflight

- The check runs after the ssh session exists (it needs `uname`) but **before**
  the deploy lock and before any engine call. A local image is checked there; a
  registry ref is checked on the image the host actually received, before the
  first container create, so a foreign tag fails as `ARCH_MISMATCH`, not as an
  engine error.
- `--allow-emulation` downgrades the failure only when
  `/proc/sys/fs/binfmt_misc/qemu-<image-arch>` exists on the target. Otherwise
  the deploy is still refused.
- An emulated deploy prints a warning, stamps `bundant.emulated=true` on the
  containers, adds `"emulated": true` to `deploy --json`, and `status` reports
  the unit with `emulated: true` (human output appends `(emulated)`).

`deploy --json` gains:

```json
{"ok":true,"command":"deploy","data":{"status":"deployed","emulated":true,"phases":{},"totalMs":1234}}
```

`status --json` units gain the same optional key:

```json
[{"path":"default.hello.web","kind":"service","revision":"r1","expected":1,"live":1,"containers":["default-hello-web-r1"],"emulated":true}]
```

## sessiond

`bundant sessiond install|status|remove [--hosts a,b] [--json] [--from <tar>] [--image <ref>]`

- `install` picks `bundant/sessiond:0.1.0-<host-arch>` unless `--image` is given,
  transfers it over the incremental image path (or loads `--from <tar>`
  offline), runs the arch preflight, then recreates the container idempotently.
- `remove` stops and removes the container but keeps the event log.
- Logs live at `/var/lib/bundant/sessions.ndjson`; the socket at
  `/run/bundant/sessiond.sock`.

`sessiond status --json`:

```json
{
  "ok": true,
  "command": "sessiond",
  "data": {
    "hosts": [
      {
        "host": "root@docker01",
        "container": "bundant-sessiond",
        "running": true,
        "state": "running",
        "image": "bundant/sessiond:0.1.0-amd64",
        "degraded": false,
        "mode": "pidfd",
        "sessions": [
          {"session":"s-1","agent":"claude","pid":4242,"mode":"pidfd","openedAt":"2026-10-20T12:00:00Z"}
        ],
        "events": 12,
        "logPath": "/var/lib/bundant/sessions.ndjson"
      }
    ]
  }
}
```

`mode` is the last watch mechanism seen (`pidfd`, `cgroupv2`, `poll`, or
`unknown`). `degraded` is true when the container is not running or any open
session used a fallback. A session that has no `session.closed` line is still
open.

### Event shape

One signed ndjson object per line:

```json
{"v":1,"time":"2026-10-20T12:00:00Z","event":"session.open","session":"s-1","agent":"claude","pid":4242,"mode":"pidfd","host":"docker01","pub":"<ed25519 pub, base64>","sig":"<base64>"}
```

`event` is `session.open` or `session.closed`. `pid` is always the kernel
`SO_PEERCRED` value, never the pid the client claimed. `sig` is the ed25519
signature over the same object serialized without `sig`; `pub` repeats the
signing key on every line. The seed is `/var/lib/bundant/sessiond.key` (0600),
created on first start.
