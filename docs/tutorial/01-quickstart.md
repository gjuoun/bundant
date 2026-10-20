---
title: "Quick start"
description: "Install bundant, prepare a host and deploy one service in five minutes."
slug: "tutorial/01-quickstart"
sidebar:
  order: 1
  label: "01 · Quick start"
---

# Quick start

**Goal:** by the end of this page you have bundant installed, a host checked, and one service
running behind the proxy.

## 1. Install the CLI

bundant is not on npm yet. Install it from a checkout:

```sh
git clone https://github.com/gjuoun/bundant.git
cd bundant
bun install
bun run build
bun link
bundant --version
```

`bun run build` writes the node bundle, and `bun link` puts the `bundant` command on your
PATH. Bun users also get `bundant-bun`, which runs the TypeScript sources directly and needs no
build.

You should see `bundant v0.1.0`.

## 2. Write a deploy.yml

A service is one small file. Create a directory for it, put the file in git, and commit:

```sh
mkdir -p ~/bundant-tutorial/app
cd ~/bundant-tutorial/app
git init

cat > deploy.yml <<'YAML'
version: 2
service: hello
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
YAML

git add deploy.yml
git commit -m 'first service'
git rev-parse --short HEAD
```

The short sha is the revision. Ours was `11a45b2`; yours will differ.

## 3. Check the host

`bundant runtime` asks the host which engine it has, over the same ssh connection a deploy
uses. It changes nothing:

```sh
bundant runtime -f deploy.yml
```

```text
root@192.168.2.104 engine=docker version=29.1.3 api=1.52 socket=/var/run/docker.sock service=active
  forward=~/.cache/bundant/forward/fwd-11154-1-mvh5zkk3.sock
```

## 4. Validate, then deploy

Validation never contacts the host. It prints the resolved identity and the names a deploy will
use:

```sh
bundant validate -f deploy.yml
```

```text
bundant validate: OK
  version: 2
  group: default
  service: hello
  role: web
  revision: 11a45b2 (git short sha of ~/bundant-tutorial/app)
  container: default.hello.web.11a45b2
  proxy id: default.hello.web
  env path: ~/.bundant/env/default/hello-web.env
  round-trip: ok
```

Now deploy:

```sh
bundant deploy -f deploy.yml
```

```text
deploy hello/web rev=11a45b2 -> root@192.168.2.104
[root@192.168.2.104] deploying default.hello.web.11a45b2
[root@192.168.2.104] pull skipped (present, policy=missing)
[root@192.168.2.104] network ok
[root@192.168.2.104] run ok: default.hello.web.11a45b2
[root@192.168.2.104] health gate passed (1 target(s))
[root@192.168.2.104] proxy-ensure ok
[root@192.168.2.104] proxy-swap ok
[root@192.168.2.104] stop-old ok
deployed default.hello.web.11a45b2 on 1 host(s)
```

The container is not published on a host port. The proxy reaches it by name, and the `Host`
header picks the service:

```sh
curl -s -H 'Host: hello.bundant.test' http://192.168.2.104/
```

```text
Hostname: 41a1a5e56eee
IP: 127.0.0.1
```

## 5. Read the state back

```sh
bundant status '*' -f deploy.yml
```

```text
default.hello.web rev=11a45b2 live=1/1 [default.hello.web.11a45b2]
```

`live=1/1` means one container is running and the file asks for one.

You should see `deployed default.hello.web.11a45b2 on 1 host(s)` followed by
`live=1/1` — one running container, serving through the proxy.

## Did it fail?

- **`bundant: command not found`** — `bun link` wrote the command under Bun's global bin,
  which may not be on PATH. Fix it with `export PATH="$HOME/.bun/bin:$PATH"` and run
  `bundant --version` again.
- **`unsupported config version 3 (supported: 2)`** — the file must start with
  `version: 2`. This is what validation says:

  ```text
  bundant validate: FAILED (1 error(s))
    - version: unsupported config version 3 (supported: 2)
  ```

- **`ssh: connect to host ... port 22: Connection refused`** — `bundant runtime` is the
  quickest way to see it. Check that the host is reachable and that passwordless ssh works:
  `ssh root@192.168.2.104 true`.

Next: [Chapter 2 — Your first service](/bundant/docs/tutorial/02-first-service/).
