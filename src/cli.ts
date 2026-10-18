#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { buildDeployPlan, renderPlan } from "./planner.ts";
import { resolveRevision, sanitizeRevision } from "./revision.ts";
import { cliVersion } from "./version.ts";

const USAGE = [
  "usage: bundant <command> [options]",
  "",
  "commands:",
  "  deploy                deploy the current revision to every host",
  "  rollback [--to-revision <rev>]  previous revision, or the one named by --to-revision",
  "  history                revisions newest-first, with state and the current one",
  "  status                per-host containers, proxy targets, health",
  "  prune                 remove stopped revisions beyond the newest K (--keep, default 3)",
  "  delete [--yes] [--images]  remove the service: proxy route, containers, env file",
  "  bootstrap             install/verify podman and its host prerequisites on every host",
  "  ps                    every container on every host, with state and ports",
  "  stats                 one resource snapshot per host (cpu / mem / pids)",
  "  logs [--follow]       tail logs (all hosts in parallel; --follow streams them)",
  "  inspect <selector>    state, restarts, health, image, restart policy",
  "  exec <cmd...>         shell into a container (--host required, PTY through ssh)",
  "  ui                    local read-only monitoring page (pull-on-demand)",
  "  events                runtime events since a duration (default 2h)",
  "",
  "options:",
  "  -f, --file <path>     deploy.yml path (default: ./deploy.yml)",
  "      --dry-run         print the full command plan without executing",
  "      --rev <id>        override revision id (testing hook; default: git short sha)",
  "      --local-image <name:tag>  stream a locally built image to hosts (no registry)",
  "      --keep <k>        prune: revisions to keep (default 3)",
  "      --yes             delete: required confirmation for the destructive path",
  "      --images          delete: also remove the image refs of the deleted revisions",
  "",
  "env:",
  "  BUNDANT_HOSTS=a,b     override deploy.yml hosts",
  "  BUNDANT_LOCK_TTL_S    stale-lock reclaim threshold (default 900)",
].join("\n");

function usage(): never {
  console.error(USAGE);
  process.exit(2);
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
      file: { type: "string", short: "f", default: "deploy.yml" },
      "dry-run": { type: "boolean", default: false },
      rev: { type: "string" },
      "local-image": { type: "string" },
      keep: { type: "string", default: "3" },
      yes: { type: "boolean", default: false },
      images: { type: "boolean", default: false },
      "to-revision": { type: "string" },
      "skip-smoke": { type: "boolean", default: false },
      host: { type: "string" },
      container: { type: "string" },
      tail: { type: "string", default: "200" },
      follow: { type: "boolean", default: false },
      since: { type: "string", default: "2h" },
      port: { type: "string", default: "8787" },
    },
  });
  const sub = args.positionals[0];
  if (!sub) usage();

  if (sub === "deploy") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const revision = args.values.rev
      ? sanitizeRevision(args.values.rev)
      : await resolveRevision(dirname(loaded.path));
    const localImage = args.values["local-image"];
    if (localImage !== undefined && localImage.trim() === "") {
      console.error("bundant: --local-image requires a name:tag value");
      return 2;
    }
    const plan = buildDeployPlan(loaded.config, revision, { localImage });
    if (args.values["dry-run"]) {
      console.log(renderPlan(plan));
      return 0;
    }
    const { deploy } = await import("./deploy.ts");
    return deploy(plan, loaded);
  }

  if (sub === "rollback") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { rollback } = await import("./rollback.ts");
    return rollback(loaded, { toRevision: args.values["to-revision"] });
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
    const { remove } = await import("./delete.ts");
    return remove(loaded, {
      yes: args.values.yes === true,
      images: args.values.images === true,
      dryRun: args.values["dry-run"] === true,
    });
  }

  if (sub === "prune") {
    const keep = Number(args.values.keep ?? "3");
    if (!Number.isInteger(keep) || keep < 0) {
      console.error("bundant: --keep must be a non-negative integer");
      return 2;
    }
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { prune } = await import("./prune.ts");
    return prune(loaded, { keep, dryRun: args.values["dry-run"] === true });
  }

  if (sub === "bootstrap") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { bootstrap } = await import("./bootstrap.ts");
    return bootstrap(loaded, {
      dryRun: args.values["dry-run"] === true,
      smoke: args.values["skip-smoke"] !== true,
    });
  }

  if (sub === "ps" || sub === "stats" || sub === "inspect" || sub === "logs" || sub === "events") {
    const loaded = loadConfig(args.values.file ?? "deploy.yml");
    const { monitorFor } = await import("./monitor.ts");
    const monitor = monitorFor(loaded);
    const host = args.values.host;
    const container = args.values.container;

    if (sub === "ps") {
      const { renderContainers } = await import("./monitor-render.ts");
      console.log(renderContainers(await monitor.containers()));
      return 0;
    }
    if (sub === "stats") {
      const { renderStats } = await import("./monitor-render.ts");
      console.log(renderStats(await monitor.stats()));
      return 0;
    }
    if (sub === "inspect") {
      const selector = args.positionals[1] ?? container;
      if (selector === undefined) {
        console.error("bundant: inspect needs a container name (or --container)");
        return 2;
      }
      const { renderInspect } = await import("./monitor-render.ts");
      console.log(renderInspect(await monitor.inspect(selector)));
      return 0;
    }
    if (sub === "logs") {
      const tail = Number(args.values.tail ?? "200");
      if (!Number.isInteger(tail) || tail <= 0) {
        console.error("bundant: --tail must be a positive integer");
        return 2;
      }
      if (args.values.follow === true) {
        return await monitor.followLogs({ host, container, tail });
      }
      const hosts = host === undefined ? monitor.hosts : [host];
      for (const h of hosts) {
        process.stdout.write("== " + h + " ==\n");
        process.stdout.write(await monitor.logs(h, container ?? "", tail));
      }
      return 0;
    }
    const since = args.values.since ?? "2h";
    const hosts = host === undefined ? monitor.hosts : [host];
    for (const h of hosts) {
      const lines = await monitor.events(h, since);
      console.log("== " + h + " ==");
      for (const line of lines.slice(-80)) console.log("  " + line);
    }
    return 0;
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
    return await monitorFor(loaded).execShell(host, args.values.container ?? "", argv);
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

try {
  process.exit(await main());
} catch (e) {
  console.error("bundant: " + (e as Error).message);
  process.exit(1);
}
