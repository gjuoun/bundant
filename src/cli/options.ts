import { Flag } from "effect/cli";

/** Every flag the old dispatcher accepted, with the text `--help` prints next
 * to it. Numeric flags stay strings so the handlers keep the historical
 * validation messages. */
export const globalFlags = {
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.optional,
    Flag.withDescription("config path (hosts/runtime; filters read verbs to one unit)"),
  ),
  "dry-run": Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("print the plan without executing it"),
  ),
  rev: Flag.String("rev").pipe(
    Flag.optional,
    Flag.withDescription("override the revision for file-driven deploys"),
  ),
  "local-image": Flag.String("local-image").pipe(
    Flag.optional,
    Flag.withDescription("stream a locally built image (name:tag) instead of pulling"),
  ),
  pull: Flag.String("pull").pipe(
    Flag.withDefault("missing"),
    Flag.withDescription("image pull policy: missing, always or never"),
  ),
  keep: Flag.String("keep").pipe(
    Flag.withDefault("3"),
    Flag.withDescription("prune: revisions to keep (default 3)"),
  ),
  replicas: Flag.String("replicas").pipe(
    Flag.optional,
    Flag.withDescription("scale: target replica count"),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("skip the confirmation prompt"),
  ),
  images: Flag.Boolean("images").pipe(
    Flag.withDefault(false),
    Flag.withDescription("rm/delete: also remove images"),
  ),
  volumes: Flag.Boolean("volumes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("rm: also remove volumes"),
  ),
  "to-revision": Flag.String("to-revision").pipe(
    Flag.optional,
    Flag.withDescription("rollback: revision to return to"),
  ),
  "skip-smoke": Flag.Boolean("skip-smoke").pipe(
    Flag.withDefault(false),
    Flag.withDescription("bootstrap: skip the smoke container"),
  ),
  host: Flag.String("host").pipe(
    Flag.optional,
    Flag.withDescription("filter to one host"),
  ),
  container: Flag.String("container").pipe(
    Flag.optional,
    Flag.withDescription("filter to one container"),
  ),
  tail: Flag.String("tail").pipe(
    Flag.withDefault("200"),
    Flag.withDescription("logs: lines to show (default 200)"),
  ),
  follow: Flag.Boolean("follow").pipe(
    Flag.withDefault(false),
    Flag.withDescription("logs: keep streaming new lines"),
  ),
  since: Flag.String("since").pipe(
    Flag.withDefault("2h"),
    Flag.withDescription("events: window to query (default 2h)"),
  ),
  port: Flag.String("port").pipe(
    Flag.withDefault("8787"),
    Flag.withDescription("ui: port to bind (default 8787)"),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("emit machine-readable JSON"),
  ),
  timings: Flag.Boolean("timings").pipe(
    Flag.withDefault(false),
    Flag.withDescription("print per-phase timings"),
  ),
  hosts: Flag.String("hosts").pipe(
    Flag.optional,
    Flag.withDescription("filter to a comma-separated host list"),
  ),
  via: Flag.String("via").pipe(
    Flag.withDefault("api"),
    Flag.withDescription("ops transport: api or cli (default api)"),
  ),
  strict: Flag.Boolean("strict").pipe(
    Flag.withDefault(false),
    Flag.withDescription("validate: require an explicit version"),
  ),
  "allow-case-collision": Flag.Boolean("allow-case-collision").pipe(
    Flag.withDefault(false),
    Flag.withDescription("deploy v2: permit case-only duplicate units"),
  ),
  replica: Flag.String("replica").pipe(
    Flag.optional,
    Flag.withDescription("flat verbs: select one replica"),
  ),
  revision: Flag.String("revision").pipe(
    Flag.optional,
    Flag.withDescription("flat verbs: select one revision"),
  ),
  "all-revisions": Flag.Boolean("all-revisions").pipe(
    Flag.withDefault(false),
    Flag.withDescription("flat verbs: include stopped revisions"),
  ),
  route: Flag.Boolean("route").pipe(
    Flag.withDefault(false),
    Flag.withDescription("rm: also remove the proxy route"),
  ),
  env: Flag.Boolean("env").pipe(
    Flag.withDefault(false),
    Flag.withDescription("rm: also remove the rendered env file"),
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDefault(false),
    Flag.withDescription("exec: run in every matching replica"),
  ),
};
