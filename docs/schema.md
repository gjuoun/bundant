# Editor schema (JSON Schema)

bundant validates configs at load time with zod (`src/config.ts`). The same zod
schemas are projected to **JSON Schema draft-07** in `schema/`, so your editor can
autocomplete field names and flag typos before you ever run the CLI.

```
schema/
├── deploy.schema.json   # deploy.yml and accessory.yml
└── group.schema.json    # group.yml
```

## Enable it in your editor

Add one comment line at the top of a config file (VS Code's YAML extension, and
anything else built on `yaml-language-server`, understands it):

```yaml
# yaml-language-server: $schema=./schema/deploy.schema.json
service: api
image: traefik/whoami:v1.10
```

Relative paths resolve against the YAML file, so an example two directories down
writes `../../schema/deploy.schema.json` (see `examples/`). You get:

- field name completion with the description from the zod schema
- inline errors for unknown keys, bad `service`/`role`/`group` names, out-of-range
  ports, and `kind` values other than `service`/`accessory`
- enum hints for `runtime` (`docker` | `podman`) and `kind`

If you prefer not to touch the files, map them by glob in VS Code
(`settings.json`):

```json
{
  "yaml.schemas": {
    "https://bundant.dev/schema/DeployFile.json": ["**/deploy.yml", "**/accessory.yml"],
    "https://bundant.dev/schema/GroupFile.json": ["**/group.yml"]
  }
}
```

## Keeping the schemas honest

They are generated, never hand-edited:

```sh
bun run schema:gen      # rewrite schema/*.json from src/config.ts
bun run schema:check    # just the schema tests
```

`src/schema.test.ts` fails when the checked-in files drift from `src/config.ts`,
when an example stops validating, or when the schema stops rejecting something zod
rejects — so a field added in code cannot ship without its schema.

## Limits

The schema covers shape and types; the cross-field rules stay runtime checks
because they depend on more than one file or on the host:

- `proxy.host` is required when `proxy.enabled` is true
- a group member's `name` must equal its file's `service:`
- `needs:` cycles, and dependencies that are not members of the group
