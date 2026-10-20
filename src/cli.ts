#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { buildDeployPlan, renderPlan } from "./planner.ts";
import { renderApiPlan } from "./plan-render.ts";
import type { OpsVia } from "./ops/index.ts";
import { resolveRevision, sanitizeRevision } from "./revision.ts";
import { cliVersion } from "./version.ts";
import { runMain } from "./effect/runtime.ts";
import { toAppError } from "./effect/errors.ts";

const USAGE = [
  "usage: bundant <command> [options]",
  "",
  "commands:",
  "  validate [-f file] [--json] [--strict]  parse and validate deploy.yml / group.yml / accessory.yml",
  "  deploy                deploy the current revision to every host",
  "  scale --replicas <n>   add/remove replicas of the running revision (no drops)",
  "  rollback [--to-revision <rev>]  previous revision, or the one named by --to-revision",
  "  history                revisions newest-first, with state and the current one",
  "  status                per-host containers, proxy targets, health",
  "  prune                 remove stopped revisions beyond the newest K (--keep, default 3)",
  "  delete [--yes] [--images]  remove the service: proxy route, containers, env file",
  "  bootstrap             install/verify podman and its host prerequisites on every host",
  "  runtime [--json]      per-host engine/API detection: socket, forward, service state",
  "  ps                    every container on every host, with state and ports",
  "  stats                 one resource snapshot per host (cpu / mem / pids)",
  "  logs [--follow]       tail logs (all hosts in parallel; --follow streams them)",
  "  inspect <selector>    state, restarts, health, image, restart policy",
  "  exec <cmd...>         shell into a container (--host required, PTY through ssh)",
  "  ui                    local read-only monitoring page (pull-on-demand)",
  "  events                runtime events since a duration (default 2h)",
  "  group <install|uninstall|status|rollback>  namespace lifecycle: -f group.yml",
  "  accessory <boot|reboot|stop|logs|status|remove>  stateful member: -f accessory.yml",
  "",
  "options:",
  "  -f, --file <path>     deploy.yml path (default: ./deploy.yml)",
  "      --dry-run         print the full command plan without executing",
  "      --via cli|api     mutations: engine API (default) or legacy ssh commands",
  "      --rev <id>        override revision id (testing hook; default: git short sha)",
  "      --local-image <name:tag>  stream a locally built image to hosts (no registry)",
  "      --keep <k>        prune: revisions to keep (default 3)",
  "      --replicas <n>    scale: target replica count for the running revision",
  "      --yes             delete / accessory remove: required confirmation",
  "      --images          delete: also remove the image refs of the deleted revisions",
  "      --volumes         accessory remove: also delete the declared named volumes",
  "      --to-revision <rev>  group rollback: the shared git sha for every service",
  "      --json            runtime: machine-readable per-host report",
  "      --hosts a,b       runtime: override the configured host list",
  "",
  "env:",
  "  BUNDANT_HOSTS=a,b     override deploy.yml hosts",
  "  BUNDANT_LOCK_TTL_S    stale-lock reclaim threshold (default 900)",
].join("\n");

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function opsVia(raw: string | undefined): OpsVia | null {
  if (raw === undefined || raw === "api") return "api";
  if (raw === "cli") return "cli";
  console.error("bundant: --via must be 'api' or 'cli'");
  return null;
}

async function main(): Promise<number> {
  // Global flags are only global before a `--` passthrough separator, so
  // `bundant exec --container c -- sh --version` stays a command, not a version print.
  const raw = process.argv.slice(2);
  const sep = raw.indexOf("--");
  const head = sep === -1 ? raw : raw.slice(0, sep);
  if (head.includes("--help") || head.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (head.includes("--version") || head.includes("-v")) {
    console.log(cliVersion());
    return 0;
  }
  const args = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f" },
      "dry-run": { type: "boolean", default: false },
      rev: { type: "string" },
      "local-image": { type: "string" },
      keep: { type: "string", default: "3" },
      replicas: { type: "string" },
      yes: { type: "boolean", default: false },
      images: { type: "boolean", default: false },
      volumes: { type: "boolean", default: false },
      "to-revision": { type: "string" },
      "skip-smoke": { type: "boolean", default: false },
      host: { type: "string" },
      container: { type: "string" },
      tail: { type: "string", default: "200" },
      follow: { type: "boolean", default: false },
      since: { type: "string", default: "2h" },
      port: { type: "string", default: "8787" },
      json: { type: "boolean", default: false },
      hosts: { type: "string" },
      via: { type: "string", default: "api" },
      strict: { type: "boolean", default: false },
    },
  });
  const sub = args.positionals[0];
  if (!sub) usage();

  if (sub === "validate") {
    const { validateCommand } = await import("./effect/commands.ts");
    return await runMain(
      validateCommand({
        file: args.values.file ?? "deploy.yml",
        json: args.values.json === true,
        strict: args.values.strict === true,
      }),
    );
  }

  if (sub === "deploy") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    if (loaded.config.kind === "accessory") {
      console.error(
        "bundant: " + loaded.config.service + " is an accessory — use `bundant accessory boot`",
      );
      return 2;
    }
    const revision = args.values.rev
      ? sanitizeRevision(args.values.rev)
      : await resolveRevision(dirname(loaded.path));
    const localImage = args.values["local-image"];
    if (localImage !== undefined && localImage.trim() === "") {
      console.error("bundant: --local-image requires a name:tag value");
      return 2;
    }
    const plan = buildDeployPlan(loaded.config, revision, { localImage });
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    if (args.values["dry-run"]) {
      console.log(
        via === "api" && localImage === undefined
          ? renderApiPlan(plan, { envCount: loaded.envCount })
          : renderPlan(plan),
      );
      return 0;
    }
    const { deploy } = await import("./deploy.ts");
    return deploy(plan, loaded, { via });
  }

  if (sub === "scale") {
    // Both spellings work: `scale --replicas 5` and `scale 5`.
    const raw = args.values.replicas ?? args.positionals[1];
    if (raw === undefined) {
      console.error("bundant: scale needs --replicas <n>");
      return 2;
    }
    const replicas = Number(raw);
    if (!Number.isInteger(replicas) || replicas < 1) {
      console.error("bundant: --replicas must be an integer >= 1");
      return 2;
    }
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    if (loaded.config.kind === "accessory") {
      console.error(
        "bundant: " + loaded.config.service +
          " is an accessory — a stateful member is one of one",
      );
      return 2;
    }
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    const { scale } = await import("./scale.ts");
    return scale(loaded, {
      replicas,
      dryRun: args.values["dry-run"] === true,
      via,
    });
  }

  if (sub === "rollback") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    const { rollback } = await import("./rollback.ts");
    return rollback(loaded, { toRevision: args.values["to-revision"], via });
  }

  if (sub === "history") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { history } = await import("./history.ts");
    return history(loaded);
  }

  if (sub === "status") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { status } = await import("./status.ts");
    return status(loaded);
  }

  if (sub === "delete") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    const { remove } = await import("./delete.ts");
    return remove(loaded, {
      yes: args.values.yes === true,
      images: args.values.images === true,
      dryRun: args.values["dry-run"] === true,
      via,
    });
  }

  if (sub === "prune") {
    const keep = Number(args.values.keep ?? "3");
    if (!Number.isInteger(keep) || keep < 0) {
      console.error("bundant: --keep must be a non-negative integer");
      return 2;
    }
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    const { prune } = await import("./prune.ts");
    return prune(loaded, { keep, dryRun: args.values["dry-run"] === true, via });
  }

  if (sub === "bootstrap") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { bootstrap } = await import("./bootstrap.ts");
    return bootstrap(loaded, {
      dryRun: args.values["dry-run"] === true,
      smoke: args.values["skip-smoke"] !== true,
    });
  }

  if (sub === "runtime") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const hosts =
      args.values.hosts === undefined
        ? undefined
        : args.values.hosts.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const { runtimeCommand } = await import("./effect/commands.ts");
    return await runMain(runtimeCommand({ loaded, json: args.values.json === true, hosts }));
  }

  if (sub === "ps" || sub === "stats" || sub === "inspect" || sub === "logs" || sub === "events") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const host = args.values.host;
    const container = args.values.container;
    const tail = Number(args.values.tail ?? "200");
    if (sub === "logs" && (!Number.isInteger(tail) || tail <= 0)) {
      console.error("bundant: --tail must be a positive integer");
      return 2;
    }

    // A followed stream is the one read path still driven by its own signals.
    if (sub === "logs" && args.values.follow === true) {
      const { monitorFor } = await import("./monitor.ts");
      const monitor = await monitorFor(loaded);
      const onSignal = (): void => {
        void monitor.close().finally(() => process.exit(130));
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        return await monitor.followLogs({ host, container, tail });
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await monitor.close();
      }
    }

    const { readCommand } = await import("./effect/commands.ts");
    return await runMain(
      readCommand({
        loaded,
        command: sub,
        host,
        container,
        selector: args.positionals[1] ?? container,
        tail,
        since: args.values.since ?? "2h",
      }),
    );
  }

  if (sub === "exec") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const host = args.values.host;
    if (host === undefined) {
      console.error("bundant: exec needs --host <host>");
      return 2;
    }
    const { monitorFor } = await import("./monitor.ts");
    const argv = args.positionals.slice(1);
    const monitor = await monitorFor(loaded);
    try {
      return await monitor.execShell(host, args.values.container ?? "", argv);
    } finally {
      await monitor.close();
    }
  }

  if (sub === "group") {
    const action = args.positionals[1] ?? "install";
    if (!["install", "uninstall", "status", "rollback"].includes(action)) {
      console.error("bundant: unknown group action '" + action + "'");
      return 2;
    }
    const { loadGroup } = await import("./config.ts");
    const loadedGroup = loadGroup(args.values.file ?? "group.yml");
    const { GroupRunner } = await import("./group.ts");
    const runner = new GroupRunner(loadedGroup);
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    const opts = {
      dryRun: args.values["dry-run"] === true,
      yes: args.values.yes === true,
      toRevision: args.values["to-revision"],
      rev: args.values.rev,
      via,
    };
    if (action === "install") return await runner.install(opts);
    if (action === "uninstall") return await runner.uninstall(opts);
    if (action === "status") return await runner.status();
    return await runner.rollback(opts);
  }

  if (sub === "accessory") {
    const action = args.positionals[1] ?? "status";
    if (!["boot", "reboot", "stop", "logs", "status", "remove"].includes(action)) {
      console.error("bundant: unknown accessory action '" + action + "'");
      return 2;
    }
    const loadedAccessory = loadConfig(args.values.file ?? "accessory.yml");
    const via = opsVia(args.values.via);
    if (via === null) return 2;
    const { Accessory } = await import("./accessory.ts");
    const tail = Number(args.values.tail ?? "200");
    if (!Number.isInteger(tail) || tail <= 0) {
      console.error("bundant: --tail must be a positive integer");
      return 2;
    }
    return await new Accessory(loadedAccessory).run(
      action as "boot" | "reboot" | "stop" | "logs" | "status" | "remove",
      {
        yes: args.values.yes === true,
        volumes: args.values.volumes === true,
        tail,
        dryRun: args.values["dry-run"] === true,
        via,
      },
    );
  }

  if (sub === "ui") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const port = Number(args.values.port ?? "8787");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("bundant: --port must be a valid port number");
      return 2;
    }
    const { ui } = await import("./ui.ts");
    return await ui(loaded, { port });
  }

  usage();
}

process.exit(
  await runMain(
    Effect.tryPromise({
      try: () => main(),
      catch: (error) => toAppError(error),
    }),
  ),
);
