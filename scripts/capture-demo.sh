#!/usr/bin/env bash
# capture-demo.sh — record the homepage terminal demo from the real CLI.
#
# Drives a throwaway service on docker02 through validate -> deploy -> status ->
# rollback, captures stdout, redacts the host, local paths and the revision, and
# writes site/src/data/demo.json. Nothing in the fixture is hand-written: every
# line below comes from one of those four runs.
#
#   bash scripts/capture-demo.sh
#
# Requires ssh access to root@192.168.2.104 (docker02). The throwaway service,
# its containers and its proxy route are removed by the EXIT trap.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
HOST="root@192.168.2.104"
SVC="demo"
DISPLAY_REV="r2026a"
SEED_REV="r2025z"
TMP="$(mktemp -d)"
CONFIG="$TMP/deploy.yml"
OUT="$REPO/site/src/data/demo.json"

now() { node -e 'console.log(Date.now())'; }
cli() { (cd "$REPO" && bun run src/cli.ts "$@"); }

cleanup() {
  cli delete -f "$CONFIG" --yes >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$(dirname "$OUT")"

cat > "$CONFIG" <<YAML
version: 2
service: $SVC
runtime: docker
image: traefik/whoami:v1.10
hosts: [$HOST]
replicas: 1
healthcheck: { path: /, port: 80, timeout: 30 }
proxy: { enabled: true, host: demo.bundant.test, port: 80, tls: false }
YAML

# Seed a previous revision so the captured rollback has somewhere to go.
echo "== seed $SEED_REV"
cli deploy -f "$CONFIG" --rev "$SEED_REV" >/dev/null

run_capture() { # run_capture <name> <command...>
  local name="$1"; shift
  local file="$TMP/$name.txt"
  local started finished code
  started="$(now)"
  set +e
  cli "$@" 2>&1 | tee "$file"
  code=${PIPESTATUS[0]}
  set -e
  finished="$(now)"
  if [ "$code" -ne 0 ]; then
    echo "capture-demo: $name exited $code" >&2
    exit "$code"
  fi
  echo "$((finished - started))" > "$TMP/$name.ms"
}

echo "== validate"
run_capture validate validate -f "$CONFIG"
echo "== deploy $DISPLAY_REV"
run_capture deploy deploy -f "$CONFIG" --rev "$DISPLAY_REV"
echo "== status"
run_capture status status -f "$CONFIG" --json --all-revisions
echo "== rollback"
run_capture rollback rollback -f "$CONFIG"

# The validate step resolves the worktree sha itself; redact it to the same
# fixed revision the deploy used.
ACTUAL_REV="$(sed -n 's/^  revision: \([^ ]*\) (.*/\1/p' "$TMP/validate.txt" | head -n 1)"

export TMP OUT HOST DISPLAY_REV SEED_REV ACTUAL_REV
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const tmp = process.env.TMP;
const out = process.env.OUT;
const host = process.env.HOST;
const rev = process.env.ACTUAL_REV || "";
const displayRev = process.env.DISPLAY_REV;
const seedRev = process.env.SEED_REV;

const strip = (line) =>
  line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");

function redact(line) {
  let text = line;
  text = text.split(host).join("root@box.example.com");
  text = text.split("192.168.2.104").join("box.example.com");
  if (rev !== "") text = text.split(rev).join(displayRev);
  text = text.replace(/\/Users\/[^\s"']+/g, "~/project");
  text = text.replace(/\/(?:private\/)?var\/folders\/[^\s"')]+/g, "~/capture");
  text = text.replace(/\/tmp\/[^\s"']+/g, "~/capture");
  return text;
}

function lines(name) {
  const raw = readFileSync(join(tmp, name + ".txt"), "utf8");
  return raw
    .split("\n")
    .map(strip)
    .map(redact)
    .filter((line) => line.trim() !== "");
}

function duration(name) {
  try {
    return Number(readFileSync(join(tmp, name + ".ms"), "utf8").trim());
  } catch {
    return 0;
  }
}

const commands = [
  { cmd: "bundant validate", lines: lines("validate"), durationMs: duration("validate") },
  { cmd: "bundant deploy", lines: lines("deploy"), durationMs: duration("deploy") },
  { cmd: "bundant status", lines: lines("status"), durationMs: duration("status") },
  { cmd: "bundant rollback", lines: lines("rollback"), durationMs: duration("rollback") },
];

const fixture = {
  prompt: "box:~$",
  capturedAt: new Date().toISOString().slice(0, 10),
  note: "Captured from a recorded run on a real docker host; host, paths and revisions are redacted.",
  commands,
};

writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote " + out + " (" + commands.map((c) => c.lines.length).join(",") + " lines)");
NODE

echo "== cleanup"
