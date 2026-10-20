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

## Versions

Every config file may declare `version: 1` or `version: 2` (an integer) at the top level.

- **v1** keeps the historical hyphen names (`<service>-<role>-<rev>`).
- **v2** uses dotted names and a wider identifier charset — see [naming.md](naming.md).

- **Explicit** — `version: 1` pins the file to v1.
- **Implicit** — no `version` means v1, and the report says
  `version: 1 (implicit — add "version: 1" to pin it)`.
- **Strict** — `--strict` turns the implicit case into an error so CI can demand
  pinned files.
- **Unknown** — any unregistered value (`3`, `"v3"`, `1.5`) is rejected with the
  supported list: `unsupported config version 3 (supported: 1, 2)`.

A version pins all four things together:

1. the zod **schema** (fields, types, unknown-key rules);
2. the **naming grammar** (identity composition and parse);
3. the **defaults** (role `web`, proxy port `80`, …);
4. the **preflight rules** (cross-field and composed-name round-trip).

### How to add v2

1. Add `src/config/vN/{deploy,group,accessory}.ts` plus its grammar module.
2. Add one entry to the production registry (`src/config/registry.ts`).
3. Run `bun run schema:gen` to write `schema/vN/*`.
4. The drift test iterates every registered version, so a missing schema fails.

**No file inside `src/config/v1/` changes.** The registry test registers a dummy
v2 and asserts v1's schema and identity behaviour are byte-identical.

### Support policy

A version is removed only by an explicit release note. Existing files keep
working through the version they declare; bumping a file is a deliberate edit.

## What is checked

The rules below are v1's; each version brings its own.

| area | rule |
|---|---|
| grammar | `service` = `[a-z0-9]+(-[a-z0-9]+)*`; `group`/`role`/`revision` = `[a-z0-9]+` (no uppercase, `_`, `.`, leading/trailing/double hyphen) |
| composed name | `compose(identity)` must parse back to the same identity (superRefine + report) |
| required | `image` non-empty, `hosts` non-empty (directly or via a shared ssh file) |
| proxy | `proxy.enabled: true` requires `proxy.host` |
| replicas | `> 1` requires `proxy.enabled: true` |
| accessory | rejects `replicas` and any enabled proxy |
| healthcheck | path starts with `/`; port/timeout/tcp are in range |
| group | member `name` equals the member file's `service`; `needs` names a declared member; no self-needs, duplicates or cycles |
| unknown keys | rejected by strict zod objects |

The grammar lives with the version (`src/config/v1/grammar.ts` for v1); the
resolved version supplies it to identity composition and to the round-trip.
`schema:check` fails if a checked-in JSON Schema drifts from its version.

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
  version: 1 (implicit — add "version: 1" to pin it)
  group: default
  service: hello
  role: web
  revision: 4f3c1ab (git short sha of ...)
  container: hello-web-4f3c1ab
  proxy id: hello-web
  env path: ~/.bundant/env/default/hello-web.env
  lock key: default/hello
  round-trip: ok
```

`--json` includes the version and the same identity:

```json
{
  "ok": true,
  "version": 1,
  "versionExplicit": false,
  "notes": ["version: 1 (implicit — add \"version: 1\" to pin it)"],
  "errors": [],
  "identity": { "kind": "service", "group": "default", "service": "hello" }
}
```

Group reports use `identity.kind = "group"` with an ordered `members` array.
On failure `ok` is `false`, `errors` is `[{ "field", "message" }]`, and
`identity` is omitted.
