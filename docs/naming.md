# Naming (config v1 and v2)

Naming is part of the config version. v1 keeps the historical hyphen names; v2
uses dots as structural separators.

## v1 (default, no version field)

- identifier charset for the **service** is `[a-z0-9]+(-[a-z0-9]+)*`; group,
  role and revision are `[a-z0-9]+`.
- service: `<group>-<service>-<role>-<revision>[-<replica>]` (the default group
  never prefixes; accessories are `<service>` or `<group>-<service>`).

Existing files produce exactly the same names as before — parity against main is
part of the regression suite.

## v2 (`version: 2`)

- identifier: `^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9]))*$`
  — kebab-case, camelCase, snake_case, UPPERCASE; no spaces, no dots, no
  leading/trailing/consecutive `-` or `_`.
- revision: `^[A-Za-z0-9]+$`.
- service: `<group>.<service>.<role>.<revision>[.<replica>]` — e.g.
  `Shop.api.Web.r2026a.2`.
- accessory: exactly two segments, `<group>.<service>` — e.g. `Shop.Shop-DB`.
- parse: 2 segments = accessory, 4 = service, 5 = service+replica; anything else
  is rejected.
- v2 always includes the group segment, including `default`, so the shape is
  unambiguous.

## Case collisions

Docker names are case-sensitive but DNS/hosts may not be. v2 therefore refuses a
deploy when an existing unit differs only by case:

```text
case-collision: shop.Api and Shop.Api both resolve to shop.api
```

Pass `--allow-case-collision` only when you know every host and DNS path is
case-safe.

## Migrating a live v1 unit to v2

1. Add `version: 2` to the file (same fields otherwise).
2. Deploy once. The deploy detects the old v1 route id, serves the new dotted id
   as a wildcard first, removes the stale v1 route, then re-registers the new id
   with its real host. Old containers are stopped by label afterwards.
3. Requests stay 200 throughout; `migrate-smoke.sh` proves it on both engines.

Selection (rollback/prune/delete/scale) reads labels, so old and new names remain
selectable during and after the migration.
