# Editor schema (JSON Schema)

bundant validates configs at load time with the version 2 zod modules in
`src/config/v2/`, dispatched by `src/config/registry.ts`. The same schemas are
projected to **JSON Schema draft-07** under `schema/v2/`, so your editor can
autocomplete field names and flag typos before you run the CLI.

```
schema/
├── README.md
└── v2/
    ├── deploy.schema.json       # deploy.yml
    ├── accessory.schema.json    # accessory.yml
    └── group.schema.json        # group.yml
```

## Enable it in your editor

Add one comment line at the top of a config file (VS Code's YAML extension, and
anything else built on `yaml-language-server`, understands it):

```yaml
# yaml-language-server: $schema=./schema/v2/deploy.schema.json
version: 2
service: Shop-Api
image: traefik/whoami:latest
```

Relative paths resolve against the YAML file, so an example two directories down
writes `../../schema/v2/deploy.schema.json`. You get:

- field name completion with the description from the zod schema
- inline errors for unknown keys, bad `service`/`role`/`group` names, out-of-range
  ports, and `kind` values other than `service`/`accessory`
- enum hints for `runtime` (`docker` | `podman`) and `kind`

If you prefer not to touch the files, map them by glob in VS Code
(`settings.json`):

```json
{
  "yaml.schemas": {
    "https://bundant.dev/schema/v2/deploy.schema.json": ["**/deploy.yml"],
    "https://bundant.dev/schema/v2/accessory.schema.json": ["**/accessory.yml"],
    "https://bundant.dev/schema/v2/group.schema.json": ["**/group.yml"]
  }
}
```

## Keeping the schemas honest

They are generated, never hand-edited:

```sh
bun run schema:gen      # rewrite schema/v2/*.json from the registry
bun run schema:check    # just the schema tests
```

`src/schema.test.ts` fails when the checked-in files drift, when an example
stops validating, or when a schema stops rejecting something zod rejects.

## Limits

The schema covers shape and types; cross-field rules stay runtime checks because
they depend on more than one file or on the host:

- `proxy.host` is required when `proxy.enabled` is true
- a group member's `name` must equal its file's `service:`
- `needs:` cycles, and dependencies that are not members of the group

See [validation.md](validation.md#version-2) for the validation rules and
[naming.md](naming.md#identifiers) for the composed-name grammar.
