# Validation and preflight

\`bundant validate\` parses **one** file — \`deploy.yml\`, \`accessory.yml\` or
\`group.yml\` (detected by shape) — and reports what it resolved **without
contacting a host**.

\`\`\`sh
bundant validate -f deploy.yml
bundant validate -f group.yml --json
\`\`\`

Exit code is \`0\` when valid and \`1\` with the full error list otherwise.

## What is checked

| area | rule |
|---|---|
| grammar | \`service\` = \`[a-z0-9]+(-[a-z0-9]+)*\`; \`group\`/\`role\`/\`revision\` = \`[a-z0-9]+\` (no uppercase, \`_\`, \`.\`, leading/trailing/double hyphen) |
| composed name | \`compose(identity)\` must parse back to the same identity (superRefine + report) |
| required | \`image\` non-empty, \`hosts\` non-empty (directly or via a shared ssh file) |
| proxy | \`proxy.enabled: true\` requires \`proxy.host\` |
| replicas | \`> 1\` requires \`proxy.enabled: true\` |
| accessory | rejects \`replicas\` and any enabled proxy |
| healthcheck | path starts with \`/\`; port/timeout/tcp are in range |
| group | member \`name\` equals the member file's \`service\`; \`needs\` names a declared member; no self-needs, duplicates or cycles |
| unknown keys | rejected by strict zod objects |

The grammar constants live once in \`src/name-grammar.ts\` and are re-exported by
\`src/config.ts\`; the JSON schemas keep the identical patterns (\`schema:check\`
fails on drift).

## Preflight gate

Every mutating command calls the same preflight **before creating an ssh
executor or taking a lock**:

\`deploy\`, \`rollback\`, \`prune\`, \`delete\`, \`scale\`, \`group install\`,
\`group uninstall\`, \`group rollback\`, and every \`accessory\` action.
An invalid config therefore produces zero host contact; the unit test asserts
zero executor calls.

On success the report prints the resolved identity:

\`\`\`text
bundant validate: OK
  group: default
  service: hello
  role: web
  revision: 4f3c1ab (git short sha of ...)
  container: hello-web-4f3c1ab
  proxy id: hello-web
  env path: ~/.bundant/env/default/hello-web.env
  lock key: default/hello
  round-trip: ok
\`\`\`

\`--json\` prints exactly:

\`\`\`json
{
  "ok": true,
  "errors": [],
  "identity": { "kind": "service", "group": "default", "service": "hello" }
}
\`\`\`

Group reports use \`identity.kind = "group"\` with an ordered \`members\` array.
On failure \`ok\` is \`false\`, \`errors\` is \`[{ "field", "message" }]\`, and
\`identity\` is omitted.
