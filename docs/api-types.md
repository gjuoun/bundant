# Typed engine API + inbound validation

`src/adapters/generated/*.d.ts` is generated, never hand-written:

```
specs/docker-moby.swagger.yaml      Swagger 2.0, Docker Engine API 1.57
specs/podman-v5.7.0.swagger.yaml    Swagger 2.0, Podman 5.7.0
        │ swagger2openapi
        ▼
   OpenAPI 3 + curated allowlist (scripts/api-gen.ts)
        │ openapi-typescript
        ▼
src/adapters/generated/{docker,podman}-api.d.ts
```

```sh
bun run api:gen      # rewrite the two .d.ts files
bun run api:check    # fail when they drift from the specs + allowlist
```

The allowlists in `scripts/api-gen.ts` are the only operations generated, so the
files stay reviewable (~55 KB each). Adding an endpoint means adding it there,
regenerating, and committing the result. Podman compat paths spell the parameter
`{name}` where Docker says `{id}`; the allowlists keep both spellings.

## Boundary validation

Every inbound payload the adapters read is validated with zod in
`src/adapters/schemas/payloads.ts`. Each schema is annotated with a type picked
from the generated definitions, so a schema that drifts from the official spec
does not compile. `parseOrDrift` throws `ApiSchemaDriftError` with the engine,
method + path, the first failing JSON pointer, and a short excerpt (object
shapes are reduced to key lists, so env values are never echoed).

Fixtures under `src/adapters/schemas/fixtures/` are recorded real payloads from
docker02 (Docker 29.1.3) and docker01 (Podman 5.7.0). Mutated copies drive the
drift tests in `schemas.test.ts` and `boundary.test.ts`.

Podman 5.7 declares the Docker-compatible stats body as `Record<string, never>`
and omits the compat events body; those two are validated against Docker's
official contract, which is what Podman's compat API actually returns on the
hosts.
