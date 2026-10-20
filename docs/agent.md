# The agent surface

bundant is drivable by another program. Every command accepts `--json`, writes
exactly one JSON object to stdout, and maps every failure to a stable code and
exit status. Progress and human logs always go to stderr. Without `--json` the
existing human output is unchanged, byte for byte.

## Envelope

```json
{"ok":true,"command":"status","data":[{"path":"default.hello.web","live":1}]}
```

```json
{"ok":false,"command":"deploy","error":{"code":"HEALTH_TIMEOUT","message":"new revision never became healthy","details":{"unit":"default.hello.web","timeoutMs":30000}}}
```

- One object, one line, on stdout. Nothing else is ever written there in JSON mode.
- `command` is the top-level command that ran (`deploy`, `status`, `group`, …).
- `data` is the command's payload: the same structure `status --json` already returned,
  or the read/action result documented below.
- `error.details` carries the tagged error's extra fields (host, service, target, …).
- Progress, streaming logs and deprecation notices are on stderr and never parsed.
- A bad command line is rejected by a parse preflight before any command runs: unknown flag,
  unknown subcommand, missing value/argument, or a bad choice value is `USAGE` + exit 4.
  Human mode prints one line on stderr and nothing on stdout; JSON mode prints only the
  envelope. Help text is never dumped for a usage failure. `--help` still prints help.

## Error catalog

The catalog is the public contract. Codes never change meaning across minor versions;
a client may switch on `code` alone.

| code | exit | when |
|---|---|---|
| `OK` | 0 | success |
| `USAGE` | 4 | unknown flag, missing argument, bad selector syntax |
| `CONFIG_INVALID` | 1 | YAML does not parse or violates the v2 schema |
| `CONFIG_VERSION_UNSUPPORTED` | 1 | `version:` names a module we do not ship |
| `VALIDATION_FAILED` | 1 | preflight rejected the plan (collision, missing host, bad reference) |
| `NO_MATCH` | 3 | a selector matched zero units |
| `LOCK_HELD` | 2 | another deploy holds the group lock |
| `ENGINE_UNAVAILABLE` | 1 | the engine socket cannot be reached or started |
| `API_DRIFT` | 1 | the engine's response does not match the generated types |
| `HEALTH_TIMEOUT` | 1 | the new revision never became healthy |
| `PROXY_SWAP_FAILED` | 1 | the proxy rejected the target swap |
| `TRANSPORT_ERROR` | 1 | ssh failed or the connection dropped |
| `NOT_FOUND` | 1 | the named unit, revision or container does not exist |
| `INTERNAL` | 1 | a defect; message plus a short tag |

`bundant errors --json` prints the catalog itself:

```sh
bundant errors --json | jq -r '.data[] | "\(.code) \(.exitCode)"'
```

## Exit status

The process exits with the status in the table above, not with a generic 1. A JSON
client should check both the envelope and the status: `ok:false` and the table's
status always agree.

| status | meaning |
|---|---|
| 0 | `OK` |
| 2 | `LOCK_HELD` |
| 3 | `NO_MATCH` |
| 4 | `USAGE` |
| 1 | every other failure |

## Data shapes

| command | `data` |
|---|---|
| `status` | array of `{path, kind, revision, expected, live, containers}` |
| `validate` | the validation report, including the resolved identity |
| `runtime` | array of per-host detection reports |
| `ps` / `stats` / `inspect` | array of `{host, ok, error?, rows}` |
| `events` | array of `{host, lines}` |
| `logs` | array of `{host, container, lines}` |
| `deploy` | `{status, phases, totalMs}`, or `{status:"dry-run", plan}` |
| `start` / `stop` / `restart` | `{started|stopped|restarted: [container...]}` |
| `rm` | `{units: [container...]}` |
| `exec` | `{containers, exitCode}` |
| `errors` | the catalog array `{code, exitCode, when}` |
| other action verbs | `null` on success |

## Examples

Success:

```sh
$ bundant status 'default.**' --json
{"ok":true,"command":"status","data":[{"path":"default.hello.web","kind":"service","revision":"abc1234","expected":1,"live":1,"containers":["hello-web-abc1234"]}]}
```

Failure:

```sh
$ bundant rollback -f deploy.yml --to-revision nope --json
{"ok":false,"command":"rollback","error":{"code":"NOT_FOUND","message":"no revision 'nope' for this service (have: abc1234)","details":{"target":"nope"}}}
$ echo $?
1
```

Success and failure of the same command:

```sh
$ bundant validate -f deploy.yml --json | jq -r '.ok'
true
$ bundant validate -f broken.yml --json
{"ok":false,"command":"validate","error":{"code":"CONFIG_INVALID","message":"file: cannot read /work/broken.yml: ...","details":{}}}
```

A selector with no match is a distinct, retryable outcome:

```sh
$ bundant status 'shop.nope.**' --json
{"ok":false,"command":"status","error":{"code":"NO_MATCH","message":"no unit matches \"shop.nope.**\"","details":{"pattern":"shop.nope.**"}}}
$ echo $?
3
```

## Validation

`schema/errors.json` is generated from the catalog by `bun run errors:gen`. It
describes the envelope and the allowed `code` values with draft-07 JSON Schema, so a
client can validate a response before switching on it. The test suite fails if the file
drifts from `src/agent/errors.ts`.

## Stability

`--json` is the machine interface. Codes, exit statuses, the envelope shape and the
command names are stable across minor versions; new fields may be added to `data` and
`details`, so clients must ignore unknown keys. Human output is not a machine
interface and may change between releases.
