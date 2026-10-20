#!/usr/bin/env bash
# tutorial-walk.sh - run the tutorial on a real host, from scratch.
#
#   bash scripts/tutorial-walk.sh            # all five chapters
#   bash scripts/tutorial-walk.sh 1 2 3      # chapters 1..3, in order
#
# Defaults to docker02 (root@192.168.2.104); docker01 (root@192.168.2.103)
# is used for the podman bootstrap note. Override with TUTORIAL_HOST,
# TUTORIAL_PODMAN_HOST and TUTORIAL_DIR.
set -eo pipefail
export LC_ALL=C
export LANG=C

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "$TUTORIAL_HOST" ]; then TUTORIAL_HOST=root@192.168.2.104; fi
if [ -z "$TUTORIAL_PODMAN_HOST" ]; then TUTORIAL_PODMAN_HOST=root@192.168.2.103; fi
if [ -z "$TUTORIAL_DIR" ]; then TUTORIAL_DIR="$HOME/bundant-tutorial"; fi
if [ -z "$TUTORIAL_SOURCE" ]; then TUTORIAL_SOURCE=https://github.com/gjuoun/bundant.git; fi
HOST_ADDR=$(printf '%s' "$TUTORIAL_HOST" | cut -d@ -f2)
APP="$TUTORIAL_DIR/app"

if [ $# -eq 0 ]; then WANT=" 1 2 3 4 5 "; else WANT=" $* "; fi
want() {
  case "$WANT" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

step() { printf '\n$ %s\n' "$*"; }
say() { printf '\n%s\n' "$*"; }

cleanup() {
  set +e
  say "== cleanup"
  if [ -f "$APP/shop/group.yml" ]; then
    bundant group uninstall -f "$APP/shop/group.yml" --yes >/dev/null 2>&1
  fi
  bundant rm 'shop.db' --yes --volumes --hosts "$TUTORIAL_HOST" >/dev/null 2>&1
  if [ -f "$APP/deploy.yml" ]; then
    bundant delete -f "$APP/deploy.yml" --yes >/dev/null 2>&1
  fi
  bundant rm 'default.broken.**' --yes --all-revisions --route --env --hosts "$TUTORIAL_HOST" >/dev/null 2>&1

  ssh "$TUTORIAL_HOST" '
    for name in $(docker ps -a --format "{{.Names}}" | grep -E "^(default\\.hello|default\\.broken|shop\\.)"); do
      docker rm -f "$name" >/dev/null 2>&1
    done
    for volume in $(docker volume ls --filter label=bundant.owner=shop/db -q); do
      docker volume rm "$volume" >/dev/null 2>&1
    done
    rm -rf ~/.bundant/locks/default/hello.lock ~/.bundant/locks/default/broken.lock ~/.bundant/locks/shop
  ' 2>/dev/null

  local left
  left=$(ssh "$TUTORIAL_HOST" 'docker ps -a --format "{{.Names}}" | grep -cE "^(default\\.hello|default\\.broken|shop\\.)"' 2>/dev/null || true)
  printf 'tutorial containers left: %s\n' "$left"
  printf 'tutorial volumes left: %s\n' "$(ssh "$TUTORIAL_HOST" 'docker volume ls --filter label=bundant.owner=shop/db -q | wc -l' 2>/dev/null || true)"
}

trap cleanup EXIT

say "== install from source"
rm -rf "$TUTORIAL_DIR"
mkdir -p "$TUTORIAL_DIR"
step "git clone $TUTORIAL_SOURCE"
git clone --quiet "$TUTORIAL_SOURCE" "$TUTORIAL_DIR/bundant"
cd "$TUTORIAL_DIR/bundant"
step "bun install"
bun install --silent
step "bun run build"
bun run build >/dev/null
step "bun link"
BUN_INSTALL="$TUTORIAL_DIR/.bun" bun link >/dev/null
export BUN_INSTALL="$TUTORIAL_DIR/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
step "bundant --version"
bundant --version

mkdir -p "$APP"
cd "$APP"
git init -q

commit() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" \
  GIT_AUTHOR_NAME=Tutorial GIT_AUTHOR_EMAIL=tutorial@example.com \
  GIT_COMMITTER_NAME=Tutorial GIT_COMMITTER_EMAIL=tutorial@example.com \
  git commit -qm "$2"
}

if want 1; then
  say "== chapter 1 - quick start"
  cat > deploy.yml <<'YAML'
version: 2
service: hello
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
YAML
  git add deploy.yml
  commit '2026-01-01T00:00:00+0000' 'first service'
  step "git rev-parse --short HEAD"
  git rev-parse --short HEAD
  step "bundant validate -f deploy.yml"
  bundant validate -f deploy.yml
  step "bundant runtime -f deploy.yml"
  bundant runtime -f deploy.yml
  step "bundant deploy -f deploy.yml"
  bundant deploy -f deploy.yml
  step "curl -s -H 'Host: hello.bundant.test' http://$HOST_ADDR/"
  curl -s -H 'Host: hello.bundant.test' "http://$HOST_ADDR/" | sed -n '1,3p'
  step "bundant status '*' -f deploy.yml"
  bundant status '*' -f deploy.yml
fi

if want 2; then
  say "== chapter 2 - your first service"
  cat > deploy.yml <<'YAML'
version: 2
service: hello
role: web
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
env:
  vars:
    BUNDANT_DEMO: "1"
healthcheck:
  path: /
  timeout: 30
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
YAML
  git add deploy.yml
  commit '2026-02-01T00:00:00+0000' 'add health, env and role'
  step "bundant validate -f deploy.yml"
  bundant validate -f deploy.yml
  step "bundant deploy -f deploy.yml"
  bundant deploy -f deploy.yml
  step "bundant history -f deploy.yml"
  bundant history -f deploy.yml
fi

if want 3; then
  say "== chapter 3 - operate"
  cat > deploy.yml <<'YAML'
version: 2
service: hello
role: web
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
env:
  vars:
    BUNDANT_DEMO: "2"
healthcheck:
  path: /
  timeout: 30
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
YAML
  git add deploy.yml
  commit '2026-03-01T00:00:00+0000' 'change the demo env'
  step "bundant deploy -f deploy.yml"
  bundant deploy -f deploy.yml
  step "bundant status '*' -f deploy.yml"
  bundant status '*' -f deploy.yml
  step "bundant logs '*' -f deploy.yml --tail 5"
  bundant logs '*' -f deploy.yml --tail 5
  step "bundant history -f deploy.yml"
  bundant history -f deploy.yml
  step "bundant rollback -f deploy.yml"
  bundant rollback -f deploy.yml
  step "bundant status '*' -f deploy.yml"
  bundant status '*' -f deploy.yml
  step "bundant history -f deploy.yml"
  bundant history -f deploy.yml
fi

if want 4; then
  say "== chapter 4 - scale and groups"
  cat > deploy.yml <<'YAML'
version: 2
service: hello
role: web
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
replicas: 3
env:
  vars:
    BUNDANT_DEMO: "2"
healthcheck:
  path: /
  timeout: 30
proxy:
  enabled: true
  host: hello.bundant.test
  port: 80
YAML
  git add deploy.yml
  commit '2026-04-01T00:00:00+0000' 'run three replicas'
  step "bundant deploy -f deploy.yml"
  bundant deploy -f deploy.yml
  step "bundant status '*' -f deploy.yml"
  bundant status '*' -f deploy.yml
  step "bundant scale --replicas 5 -f deploy.yml"
  bundant scale --replicas 5 -f deploy.yml
  step "bundant status '*' -f deploy.yml"
  bundant status '*' -f deploy.yml
  step "bundant scale --replicas 3 -f deploy.yml"
  bundant scale --replicas 3 -f deploy.yml

  mkdir -p shop/db shop/web
  cat > shop/group.yml <<'YAML'
version: 2
group: shop
services:
  - name: db
    file: ./db/accessory.yml
  - name: web
    file: ./web/deploy.yml
    needs: [db]
YAML
  cat > shop/db/accessory.yml <<'YAML'
version: 2
kind: accessory
service: db
image: docker.io/library/postgres:16-alpine
hosts: [root@192.168.2.104]
env:
  vars:
    POSTGRES_DB: shop
    POSTGRES_USER: shop
    POSTGRES_PASSWORD: tutorial
volumes:
  - "pgdata:/var/lib/postgresql/data"
healthcheck:
  tcp: 5432
  timeout: 60
proxy:
  enabled: false
YAML
  cat > shop/web/deploy.yml <<'YAML'
version: 2
service: web
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
healthcheck:
  path: /
  timeout: 30
proxy:
  enabled: true
  host: shop.bundant.test
  port: 80
YAML
  git add shop
  commit '2026-05-01T00:00:00+0000' 'add the shop group'
  step "bundant validate -f shop/group.yml"
  bundant validate -f shop/group.yml

  step "bundant group install -f shop/group.yml"
  if bundant group install -f shop/group.yml; then
    echo "expected the accessory check to fail" >&2
    exit 1
  fi

  step "bundant start -f shop/db/accessory.yml"
  bundant start -f shop/db/accessory.yml
  step "bundant group install -f shop/group.yml"
  bundant group install -f shop/group.yml
  step "bundant group status -f shop/group.yml | grep -E '===|volumes:|replicas:|revision:|health'"
  bundant group status -f shop/group.yml | grep -E '===|volumes:|replicas:|revision:|health'
  step "curl -s -H 'Host: shop.bundant.test' http://$HOST_ADDR/"
  curl -s -H 'Host: shop.bundant.test' "http://$HOST_ADDR/" | sed -n '1,3p'
fi

if want 5; then
  say "== chapter 5 - observe and debug"
  step "bundant ps -f deploy.yml | grep -E 'hello|shop|kamal'"
  bundant ps -f deploy.yml | grep -E 'hello|shop|kamal'
  step "bundant stats '*' -f deploy.yml | sed -n '1,8p'"
  bundant stats '*' -f deploy.yml | sed -n '1,8p'
  step "bundant events --since 5m -f deploy.yml | sed -n '1,8p'"
  bundant events --since 5m -f deploy.yml | sed -n '1,8p'
  step "bundant inspect '*' -f deploy.yml"
  bundant inspect '*' -f deploy.yml
  step "bundant exec 'shop.db' -f shop/db/accessory.yml -- hostname"
  bundant exec 'shop.db' -f shop/db/accessory.yml -- hostname

  step "bundant ui --port 8787 -f deploy.yml"
  bundant ui --port 8787 -f deploy.yml > "$TUTORIAL_DIR/ui.log" 2>&1 &
  UI_PID=$!
  sleep 1
  step "curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8787/"
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/
  kill "$UI_PID" 2>/dev/null || true
  wait "$UI_PID" 2>/dev/null || true
  cat "$TUTORIAL_DIR/ui.log"

  mkdir -p broken
  cat > broken/deploy.yml <<'YAML'
version: 2
service: broken
image: traefik/whoami:v1.10
hosts: [root@192.168.2.104]
healthcheck:
  path: /
  port: 59999
  timeout: 5
proxy:
  enabled: false
YAML
  step "bundant deploy -f broken/deploy.yml"
  if bundant deploy -f broken/deploy.yml; then
    echo "expected the health gate to fail" >&2
    exit 1
  fi
  step "bundant ps -f broken/deploy.yml | grep broken || echo 'no broken container left'"
  bundant ps -f broken/deploy.yml | grep broken || echo 'no broken container left'

  step "hold the deploy lock, then deploy again"
  ssh "$TUTORIAL_HOST" 'mkdir -p ~/.bundant/locks/default && mkdir ~/.bundant/locks/default/hello.lock && printf "tutorial %s\n" "$(date +%s)" > ~/.bundant/locks/default/hello.lock/owner'
  step "bundant deploy -f deploy.yml"
  if bundant deploy -f deploy.yml; then
    echo "expected the lock to be held" >&2
    exit 1
  fi
  ssh "$TUTORIAL_HOST" 'rm -rf ~/.bundant/locks/default/hello.lock'

  step "bundant bootstrap -f hello-podman.yml (docker01)"
  cat > hello-podman.yml <<'YAML'
version: 2
service: hello-podman
image: traefik/whoami:v1.10
runtime: podman
hosts: [root@192.168.2.103]
proxy: { enabled: true, host: hello-podman.bundant.test, port: 80 }
YAML
  bundant bootstrap -f hello-podman.yml | tail -8
fi

say "TUTORIAL OK"
