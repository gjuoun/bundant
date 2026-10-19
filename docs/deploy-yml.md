# deploy.yml reference

One file per service. It is the contract: bundant turns it into docker/podman commands
and never stores state of its own on the host.

```yaml
service: hello                 # [a-z0-9-]
image: traefik/whoami:v1.10    # registry ref, or overridden by --local-image
role: web                      # default: web (containers are <service>-<role>-<rev>)
hosts: [box.example.com]       # user@host:port forms allowed; BUNDANT_HOSTS=a,b overrides

ssh:                           # optional: reach a host with NO ~/.ssh/config entry
  user: deploy                 # default login user (per-host user@ wins)
  port: 22                     # default port (per-host :port wins)
  identity: ~/.ssh/prod_deploy # private key; ~ is expanded
  options: ["-o", "StrictHostKeyChecking=accept-new"]
runtime: docker                # or podman (see podman.md)

env:                           # optional; rendered remotely as mode-0600 file
  file: ./hello.env            # local, gitignored, KEY=VAL lines
  vars: { BUNDANT_DEMO: "1" }  # inline; merged over the file

healthcheck:
  path: /                      # default: /
  port: 80                     # default: proxy.port
  timeout: 30                  # seconds

proxy:
  enabled: true                # swap traffic at deploy (default: true)
  host: hello.bundant.test     # Host-header routing (required when enabled)
  port: 80                     # container port the proxy targets
  tls: false                   # pass --tls to kamal-proxy (ACME)
  image: docker.io/basecamp/kamal-proxy:latest   # override for air-gapped hosts
```

## Hosts and ssh

Hosts accept `root@box.example.com`, `root@box.example.com:2222` and
`root@[2001:db8::1]:2222`. Precedence is **per-host > `ssh:` block > ssh
defaults**, so a deployment can be fully self-describing and does not depend on
`~/.ssh/config` having an alias for the machine. The same connection parameters
are used for control commands, the env-file upload and the `--local-image`
pipeline.

## Field notes

- **user / hosts** — the ssh login user, resolved with this precedence:
  `user@host` on a hosts entry › top-level `user:` › whatever `~/.ssh/config`
  provides (the local username when nothing is configured). Use it for hosts where
  the login name differs from your local one — the classic case is a bare IP:
  `hosts: [root@192.168.2.104]` instead of an `ssh junguo@192.168.2.104` denial.
  IPv6 literals go in brackets (`root@[2001:db8::1]`); a port goes after the
  host (`root@box.example.com:2222`, `root@[2001:db8::1]:2222`). `IdentityFile`
  and `ProxyJump` still belong in `~/.ssh/config`, which ssh itself reads.
- **revision** — container names are `<service>-<role>-<rev>`, where `rev` is the git
  short sha of the repo holding `deploy.yml` (fallback `rev-<base36>` before the first
  commit). `--rev ID` overrides it as a testing hook.
- **env** — values are never printed; the merged result is uploaded to
  `~/.bundant/env/<group>/<service>-<role>.env` (`default` when the file is in no group) with
  mode 0600 and passed with `--env-file`.
  Secrets belong in that local file (gitignored), not in git.
- **healthcheck** — the gate probes the container by name from a throwaway curl sidecar
  on the `bundant` network. A failed gate aborts, removes the new container, and never
  touches traffic. The same path is handed to kamal-proxy as `--health-check-path`, so
  your app never needs a `/up` endpoint.
- **proxy.enabled: false** — no proxy steps at all; the container is expected to publish
  its own ports (worker roles, internal tools).
- **proxy.image** — only consulted when the proxy container is created. To switch it,
  remove the container (`docker rm -f kamal-proxy`) and deploy again; an existing proxy
  is restarted, never recreated, because recreating drops live connections.

## Registry vs local image

Default: the host pulls `image` from its registry (`docker login` is the host's
business; bundant does not manage registry credentials).

`--local-image <name:tag>`: the image is streamed from your machine over the same ssh
connection and loaded into the host's runtime before the plan runs.

## Shared ssh config

Several deployments can point at one file instead of repeating the connection
details (and, optionally, the host pool):

```yaml
# ssh/prod.yaml
user: deploy
port: 2222
identity: ~/.ssh/prod_deploy
options: ["-o", "StrictHostKeyChecking=accept-new"]
hosts: [10.0.0.5, 10.0.0.6]     # optional default pool
```

```yaml
# api/deploy.yml          # worker/deploy.yml — same line, same host pool
service: api
image: registry.internal/api:1.2.3
ssh: ./ssh/prod.yaml
```

`ssh:` takes an inline block or a path (resolved relative to the deploy.yml
that names it). Hosts declared in deploy.yml win over the file's pool; a
per-host `user@host:port` wins over both.
