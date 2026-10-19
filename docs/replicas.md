# Replicas on one host, and `bundant scale`

Run N copies of one service on one host and let kamal-proxy round-robin between
them; add or remove copies at will without dropping a request.

The load balancer is not ours: kamal-proxy v0.10.2 already accepts any number of
`--target` flags and rotates over them. bundant only has to run N containers and
hand the proxy the whole set in one call.

```yaml
service: echoes
image: traefik/whoami:v1.10
replicas: 3            # default 1; > 1 requires proxy.enabled: true
proxy:
  enabled: true
  host: echoes.example.com
```

## Naming

| replicas | container name |
|---|---|
| 1 | `<service>-<role>-<rev>` — identical to a pre-replicas deployment |
| N > 1 | `<service>-<role>-<rev>-1` … `-<N>` |

Inside a real group both rows gain the group prefix
(`<group>-<service>-<role>-<rev>[-<i>]`); the `default` group never prefixes.

A single-replica deployment is byte-identical to what bundant did before the
feature existed, so no migration is involved. Every service container also
carries `bundant.revision=<rev>` and `bundant.replica=<i>`; `scale`, `status`
and `rollback` read the truth from those labels, not from a local file.

## Deploying N replicas

`bundant deploy` pulls/builds once, runs all N containers, health-gates each one,
and then makes **one** `kamal-proxy deploy` call carrying every target. That call
is an atomic set replacement: kamal-proxy health-checks all targets, swaps, and
drains the old ones. A failed gate removes the containers this run started and
leaves traffic exactly where it was (fail-static).

```sh
bundant deploy -f echoes/deploy.yml
bundant status -f echoes/deploy.yml     # per replica: state, health, live vs expected
```

## Manual scaling

```sh
bundant scale --replicas 5 -f echoes/deploy.yml
bundant scale 2 -f echoes/deploy.yml          # `scale N` is the same command
```

`scale` adjusts the **revision that is already running**: it never pulls an image,
never changes the revision or the env file, and takes the same per-service deploy
lock as `deploy`. It is idempotent — scaling to the current count is a no-op.

### The ordering invariant

The proxy target set is the only thing that decides traffic, so the order of
operations is the whole design:

| direction | order |
|---|---|
| up | start the missing replicas → health-gate each → **one** proxy deploy with the full set |
| down | **proxy deploy with the survivors first** (drain) → then stop + rm the removed containers |

Scaling down in the other order drops in-flight requests to containers the proxy
still believes in. Never reverse it. Measured on a live host, a `3 → 5 → 1` scale
while a curl loop ran produced only 200s, zero failures.

## deploy.yml stays authoritative

`scale` prints this reminder and never writes files: the next `bundant deploy`
re-applies `replicas:` from deploy.yml. That keeps one visible desired state
instead of a hidden one that only exists on the host. To make a change permanent,
edit the file; `scale` is for a temporary bump (a traffic spike, a debugging
session).

`status` shows both numbers and marks the drift:

```
  replicas: live 2 / expected 3  <- drift (deploy.yml says 3)
```

## What else is replica-aware

- **history** — one row per revision with its replica count, not one row per container.
- **prune --keep k** — keeps the newest k *revisions* with all of their replicas;
  older revisions lose every replica at once.
- **rollback** — restores the target revision with the replica count it was deployed
  with: all its replicas are started and gated, the whole set swaps, then the
  current replicas stop.
- **delete** — prefix/label scans already cover every replica.

## Constraints

- `replicas > 1` requires `proxy.enabled: true`. Without a proxy nothing distributes
  requests, and containers do not publish ports.
- `replicas` is rejected on `kind: accessory`: a stateful member is one of one.
  Accessories keep their stable name and are never touched by deploy/scale/rollback/prune.
- N copies means N resident heaps on the host. Replicas buy process redundancy and
  more cores, not less memory.
- Ports need no thought: containers do not publish ports; the proxy reaches them by
  container name over the `bundant` network.
