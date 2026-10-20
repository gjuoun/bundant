# Validation and preflight

`bundant validate` parses **one** file — `deploy.yml`, `accessory.yml` or
`group.yml` (detected by shape) — and reports what it resolved **without
contacting a host**.

```sh
bundant validate -f deploy.yml
bundant validate -f group.yml --json
bundant validate -f deploy.yml --strict     # require an explicit version
```

Exit code is `0` when valid and `1` with the full error list otherwise.

## Version 2

Every config declares `version: 2` at the top level. The version pins all four
things together:

1. the zod **schema** (fields, types, unknown-key rules);
2. the **naming grammar** (dotted identity composition and parse);
3. the **defaults** (role `web`, proxy port `80`, …);
4. the **preflight rules** (cross-field and composed-name round-trip).

`--strict` rejects a file that does not declare the version explicitly, so CI
can require pinned configs. Any other value (`3`, `"2"`, `2.5`) is rejected with
the supported list: `unsupported config version 3 (supported: 2)`.

## What is checked

| area | rule |
|---|---|
| grammar | `service`/`group`/`role` = `[A-Za-z0-9]([A-Za-z0-9]|[-_][A-Za-z0-9])*`; `revision` = `[A-Za-z0-9]+` |
| composed name | `compose(identity)` must parse back to the same identity (superRefine + report) |
| required | `image` non-empty, `hosts` non-empty (directly or via a shared ssh file) |
| proxy | `proxy.enabled: true` requires `proxy.host` |
| replicas | `> 1` requires `proxy.enabled: true` |
| accessory | rejects `replicas` and any enabled proxy |
| healthcheck | path starts with `/`; port/timeout/tcp are in range |
| group | member `name` equals the member file's `service`; `needs` names a declared member; no self-needs, duplicates or cycles |
| unknown keys | rejected by strict zod objects |

The resolved version supplies the grammar to identity composition and to the
round-trip. `schema:check` fails if a checked-in JSON Schema drifts from its
version.

## Preflight gate

Every mutating command calls the same preflight **before creating an ssh
executor or taking a lock**:

`deploy`, `rollback`, `prune`, `delete`, `scale`, `group install`,
`group uninstall`, `group rollback`, and every `accessory` action.
An invalid config therefore produces zero host contact; the unit test asserts
zero executor calls.

On success the report prints the resolved identity:

```text
bundant validate: OK
  version: 2
  group: default
  service: hello
  role: web
  revision: 4f3c1ab (git short sha of ...)
  container: default.hello.web.4f3c1ab
  proxy id: default.hello.web
  env path: ~/.bundant/env/default/hello-web.env
  lock key: default/hello
  round-trip: ok
```

`--json` includes the version and the same identity:

```json
{
  "ok": true,
  "version": 2,
  "versionExplicit": true,
  "notes": [],
  "errors": [],
  "identity": { "kind": "service", "group": "default", "service": "hello" }
}
```

Group reports use `identity.kind = "group"` with an ordered `members` array.
On failure `ok` is `false`, `errors` is `[{ "field", "message" }]`, and
`identity` is omitted.
