#!/usr/bin/env node
// capture-commands.mjs — build the site's command fixture from the real CLI.
//
//   node scripts/capture-commands.mjs
//
// Runs `bun run src/cli.ts --help` to enumerate the surface, then every
// `<command> --help` to capture the summary, usage and flags. Writes
// site/src/data/cli-surface.txt and site/src/data/commands.json. Nothing about
// a command's usage or flags is written by hand; only the group and a
// documentation example are attached here.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "site/src/data");

const run = (args) =>
  execFileSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Split a help page into its ALL-CAPS sections. */
function sections(text) {
  const out = new Map();
  let current;
  for (const line of text.split("\n")) {
    const heading = line.trim();
    if (heading !== "" && /^[A-Z][A-Z ]+$/.test(heading) && !line.startsWith(" ")) {
      current = heading;
      out.set(current, []);
      continue;
    }
    if (current) out.get(current).push(line);
  }
  return out;
}

const firstValue = (lines) => lines?.map((line) => line.trim()).find((line) => line !== "");

/** `  --file, -f string   description` -> { flag, description } */
function parseFlags(lines) {
  const flags = [];
  for (const line of lines ?? []) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("--")) continue;
    const [flag, ...rest] = trimmed.split(/\s{2,}/);
    flags.push({ flag, description: rest.join(" ").trim() });
  }
  return flags;
}

const groups = {
  deploy: ["deploy", "scale", "rollback", "history", "prune", "delete"],
  units: ["validate", "start", "stop", "restart", "rm", "logs", "exec", "inspect", "status"],
  groups: ["group", "bootstrap"],
  ops: ["runtime", "ui", "ps", "stats", "events", "errors"],
};

/** One runnable example per command, taken from docs/cli.md or README.md. */
const examples = {
  validate: "bundant validate -f deploy.yml",
  start: "bundant start shop.api.web",
  stop: "bundant stop 'shop.**'",
  restart: "bundant restart shop.api.web",
  rm: "bundant rm 'shop.**' --yes --dry-run",
  deploy: "bundant deploy -f deploy.yml",
  scale: "bundant scale --replicas 3 -f deploy.yml",
  rollback: "bundant rollback --to-revision 59ceb8d",
  history: "bundant history -f deploy.yml",
  status: "bundant status 'shop.**' --json",
  delete: "bundant delete --yes",
  prune: "bundant prune --keep 3 -f deploy.yml",
  group: "bundant group install -f group.yml",
  bootstrap: "bundant bootstrap --dry-run",
  runtime: "bundant runtime --json",
  ui: "bundant ui --port 8787",
  exec: "bundant exec shop.api.web -- env",
  ps: "bundant ps -f deploy.yml",
  stats: "bundant stats 'shop.**'",
  inspect: "bundant inspect shop.api.web",
  logs: "bundant logs '**.web' --tail 50",
  events: "bundant events --since 2h",
  errors: "bundant errors --json",
};

const groupOf = new Map(
  Object.entries(groups).flatMap(([group, names]) => names.map((name) => [name, group])),
);

const rootHelp = run(["--help"]);
const surface = (sections(rootHelp).get("SUBCOMMANDS") ?? [])
  .map((line) => /^\s{2}(\S+)\s{2,}/.exec(line)?.[1])
  .filter(Boolean);

if (surface.length === 0) {
  throw new Error("capture-commands: no SUBCOMMANDS found in bundant --help");
}

const commands = surface.map((name) => {
  const help = run([name, "--help"]);
  const parts = sections(help);
  const summary = firstValue(parts.get("DESCRIPTION"));
  const usage = firstValue(parts.get("USAGE"));
  const flags = [...parseFlags(parts.get("FLAGS")), ...parseFlags(parts.get("GLOBAL FLAGS"))];
  const group = groupOf.get(name);
  const example = examples[name];

  if (!summary) throw new Error(`capture-commands: ${name} has no DESCRIPTION`);
  if (!usage) throw new Error(`capture-commands: ${name} has no USAGE`);
  if (!group) throw new Error(`capture-commands: ${name} has no group`);
  if (!example) throw new Error(`capture-commands: ${name} has no example`);
  const undescribed = flags.filter((flag) => flag.description === "").map((flag) => flag.flag);
  if (flags.length === 0) throw new Error(`capture-commands: ${name} captured no flags`);
  if (undescribed.length > 0) {
    throw new Error(`capture-commands: ${name} flags without a description: ${undescribed.join(", ")}`);
  }

  return { name, group, summary, usage, flags, example };
});

const order = Object.keys(groups);
commands.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "cli-surface.txt"), surface.join("\n") + "\n");
writeFileSync(join(dataDir, "commands.json"), JSON.stringify(commands, null, 2) + "\n");

console.log(`captured ${commands.length} commands -> site/src/data/commands.json`);
for (const group of order) {
  const count = commands.filter((command) => command.group === group).length;
  console.log(`  ${group.padEnd(7)} ${count}`);
}
