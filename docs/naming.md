# Naming

Every config declares `version: 2`. A composed name joins identifiers with dots:
dots are separators, never part of an identifier.

## Identifiers

- service, group and role: `^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9]))*$`
  — kebab-case, camelCase, snake_case and UPPERCASE are accepted; no spaces, no
  dots, no leading/trailing/consecutive `-` or `_`.
- revision: `^[A-Za-z0-9]+$`.
- replica: digits.

## Composed names

- service: `<group>.<service>.<role>.<revision>[.<replica>]` — for example
  `default.hello.web.r2026a` or `Shop.api.Web.r2026a.2`.
- accessory: exactly two segments, `<group>.<service>` — for example `Shop.db`.
- the default group is always present, so the shape is unambiguous:
  `default.hello.web.r2026a`.
- parse: 2 segments = accessory, 4 = service, 5 = service + replica; anything
  else is rejected.

## Selector paths

Flat verbs address the composed name as a path with dots preserved
(`group.service.role` / `group.service`) and match it with picomatch: `*` is
one segment, `**` any number, `*` alone means everything. Replica and revision
are flags, never path segments. See [cli.md](cli.md#unit-paths-and-globs).

## Case collisions

Docker names are case-sensitive but DNS/hosts may not be. bundant therefore
refuses a deploy when an existing unit differs only by case:

```text
case-collision: shop.Api and Shop.Api both resolve to shop.api.web
```

Pass `--allow-case-collision` only when you know every host and DNS path is
case-safe.
