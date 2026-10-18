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
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
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

  usage();
}

try {
  process.exit(await main());
} catch (e) {
  console.error("bundant: " + (e as Error).message);
  process.exit(1);
}
