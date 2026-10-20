import { Flag } from "effect/cli";

/** Every flag the old dispatcher accepted. Numeric flags stay strings so the
 * handlers keep the historical validation messages. */
export const globalFlags = {
  file: Flag.String("file").pipe(Flag.withAlias("f"), Flag.optional),
  "dry-run": Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  rev: Flag.String("rev").pipe(Flag.optional),
  "local-image": Flag.String("local-image").pipe(Flag.optional),
  keep: Flag.String("keep").pipe(Flag.withDefault("3")),
  replicas: Flag.String("replicas").pipe(Flag.optional),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  images: Flag.Boolean("images").pipe(Flag.withDefault(false)),
  volumes: Flag.Boolean("volumes").pipe(Flag.withDefault(false)),
  "to-revision": Flag.String("to-revision").pipe(Flag.optional),
  "skip-smoke": Flag.Boolean("skip-smoke").pipe(Flag.withDefault(false)),
  host: Flag.String("host").pipe(Flag.optional),
  container: Flag.String("container").pipe(Flag.optional),
  tail: Flag.String("tail").pipe(Flag.withDefault("200")),
  follow: Flag.Boolean("follow").pipe(Flag.withDefault(false)),
  since: Flag.String("since").pipe(Flag.withDefault("2h")),
  port: Flag.String("port").pipe(Flag.withDefault("8787")),
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  hosts: Flag.String("hosts").pipe(Flag.optional),
  via: Flag.String("via").pipe(Flag.withDefault("api")),
  strict: Flag.Boolean("strict").pipe(Flag.withDefault(false)),
  "allow-case-collision": Flag.Boolean("allow-case-collision").pipe(Flag.withDefault(false)),
  replica: Flag.String("replica").pipe(Flag.optional),
  revision: Flag.String("revision").pipe(Flag.optional),
  "all-revisions": Flag.Boolean("all-revisions").pipe(Flag.withDefault(false)),
  route: Flag.Boolean("route").pipe(Flag.withDefault(false)),
  env: Flag.Boolean("env").pipe(Flag.withDefault(false)),
};
