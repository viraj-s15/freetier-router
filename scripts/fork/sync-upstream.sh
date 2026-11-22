#!/usr/bin/env bash
# Syncs the fork with upstream FreeLLMAPI, checks that nothing broke, and
# replaces the router on port 6969. See scripts/fork/README.md.
#
#   scripts/fork/sync-upstream.sh              merge upstream/main, check, restart
#   scripts/fork/sync-upstream.sh --continue   after you fix merge conflicts in the worktree
#   scripts/fork/sync-upstream.sh --check      check the current main, no merge or restart
#   options: --no-restart  --no-chat
set -euo pipefail

MAIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$MAIN/.git" ]]; then
  # The script runs from a worktree copy: act on the main checkout.
  MAIN="$(cd "$(git -C "$MAIN" rev-parse --git-common-dir)/.." && pwd)"
fi
WT="${SYNC_WORKTREE:-$(dirname "$MAIN")/freetier-router-sync}"
BRANCH="sync/upstream-$(date +%Y-%m-%d)"
NODE="${FREETIER_NODE:-/opt/homebrew/opt/node@22/bin/node}"
PI_CONFIG="${PI_CONFIG_DIR:-$HOME/Documents/github/pi-config}"
LIVE_PORT="${LIVE_PORT:-6969}"
STAGE_PORT="${STAGE_PORT:-6970}"
LOG="$HOME/Library/Logs/freetier-router.log"
DB="$MAIN/server/data/freeapi.db"
PID_FILE="$MAIN/server/data/.router.pid"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUPS="$MAIN/server/data/backups/sync-$STAMP"
REPORT="${TMPDIR:-/tmp}/freetier-sync-$STAMP"
DISTS="server/dist client/dist shared/dist cli/dist"

MODE=sync RESTART=1 CHAT=1
for arg in "$@"; do
  case "$arg" in
    --continue) MODE=continue ;;
    --check) MODE=check RESTART=0 ;;
    --no-restart) RESTART=0 ;;
    --no-chat) CHAT=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
CHAT_FLAG=(); [[ $CHAT == 1 ]] || CHAT_FLAG=(--no-chat)

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSYNC FAILED: %s\n' "$*" >&2; exit 1; }

# better-sqlite3 is built for Node 22, so every npm and node call uses it.
[[ -x "$NODE" ]] || die "Node 22 is not at $NODE. Set FREETIER_NODE."
export PATH="$(dirname "$NODE"):$PATH"
mkdir -p "$REPORT"

port_pid() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }
wait_up() {
  for _ in $(seq 1 120); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/")" == 200 ]] && return 0
    sleep 0.5
  done
  return 1
}
stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
}
snapshot_db() { sqlite3 "$1" ".backup '$2'"; }
discovered_rows() { sqlite3 -readonly "$1" "select count(*) from models where source='discovered';"; }

# ── 1. Merge in a worktree, so the live checkout is untouched until it passes ──
[[ -z "$(git -C "$MAIN" status --porcelain)" ]] || die "$MAIN has uncommitted changes. Commit or stash them first."
[[ "$(git -C "$MAIN" branch --show-current)" == main ]] || die "$MAIN is not on main."
OLD_MAIN="$(git -C "$MAIN" rev-parse main)"

case "$MODE" in
  sync)
    step "Fetching upstream"
    git -C "$MAIN" fetch upstream --quiet
    BEHIND="$(git -C "$MAIN" rev-list --count main..upstream/main)"
    if [[ "$BEHIND" == 0 ]]; then echo "main already has every upstream commit."; exit 0; fi
    [[ ! -e "$WT" ]] || die "$WT already exists. Run with --continue, or remove it with: git worktree remove $WT"
    git -C "$MAIN" worktree add -b "$BRANCH" "$WT" main
    step "Merging $BEHIND upstream commits into $BRANCH"
    if ! git -C "$WT" merge upstream/main --no-ff -m "Sync with upstream FreeLLMAPI" \
        -m "Merged $BEHIND upstream commits up to $(git -C "$MAIN" rev-parse --short upstream/main)."; then
      echo
      echo "The merge has conflicts in:"
      git -C "$WT" diff --name-only --diff-filter=U | sed 's/^/  /'
      echo
      echo "1. Fix them in $WT. Keep the fork's features and names, and take upstream's new code."
      echo "2. If package-lock.json conflicts, take upstream's copy and rename the cli package to freetier-router."
      echo "3. Run: git -C $WT add -A"
      echo "4. Run: $0 --continue"
      exit 2
    fi
    ;;
  continue)
    [[ -d "$WT" ]] || die "$WT does not exist. Run without --continue."
    [[ -z "$(git -C "$WT" diff --name-only --diff-filter=U)" ]] || die "$WT still has merge conflicts."
    if git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null; then git -C "$WT" commit --no-edit; fi
    [[ -z "$(git -C "$WT" status --porcelain)" ]] || die "$WT has uncommitted changes. Commit them first."
    ;;
  check)
    [[ ! -e "$WT" ]] || die "$WT already exists. Remove it with: git worktree remove $WT"
    git -C "$MAIN" worktree add --detach "$WT" main
    ;;
esac
BRANCH="$(git -C "$WT" branch --show-current)"

# ── 2. Lint, build and every test suite ──
run() { # run <name> <command...>; the full output goes to the report folder
  local name="$1"; shift
  printf '  %-28s' "$name"
  if (cd "$WT" && "$@") >"$REPORT/$name.log" 2>&1; then echo ok
  else echo "FAILED, see $REPORT/$name.log"; tail -30 "$REPORT/$name.log"; die "$name failed. The worktree stays at $WT."; fi
}
step "Checking $WT (logs in $REPORT)"
run install npm ci
run lint npm run lint
run build npm run build
run fork-guard npm run test -w server -- src/__tests__/fork
run tests npm test
[[ -d "$PI_CONFIG/extensions/freetier/test" ]] || die "pi-config is not at $PI_CONFIG. Set PI_CONFIG_DIR."
# sync.test.mjs compares pi-config's own rule docs, so router code can't break it.
PI_TESTS=()
for f in "$PI_CONFIG"/extensions/freetier/test/*.test.mjs; do [[ $f == */sync.test.mjs ]] || PI_TESTS+=("$f"); done
run pi-client node --test "${PI_TESTS[@]}"

# ── 3. Run the new build on a spare port with a copy of the live DB ──
step "Testing the new build on port $STAGE_PORT with a copy of the DB"
[[ -z "$(port_pid "$STAGE_PORT")" ]] || die "Port $STAGE_PORT is in use. Set STAGE_PORT."
STAGE_DB="$REPORT/stage.db"
snapshot_db "$DB" "$STAGE_DB"
(cd "$WT" && PORT="$STAGE_PORT" HOST=127.0.0.1 FREEAPI_DB_PATH="$STAGE_DB" FREEAPI_ENV_PATH="$MAIN/.env" \
  "$NODE" server/dist/index.js >"$REPORT/stage-server.log" 2>&1) &
STAGE_PID=$!
trap 'stop_pid "$(port_pid "$STAGE_PORT")"; stop_pid "$STAGE_PID"' EXIT
wait_up "$STAGE_PORT" || die "The new build did not start. See $REPORT/stage-server.log."
BASELINE=(); [[ -n "$(port_pid "$LIVE_PORT")" ]] && BASELINE=(--baseline "http://127.0.0.1:$LIVE_PORT")
"$NODE" "$WT/scripts/fork/smoke.mjs" --base "http://127.0.0.1:$STAGE_PORT" ${BASELINE[@]+"${BASELINE[@]}"} ${CHAT_FLAG[@]+"${CHAT_FLAG[@]}"} \
  || die "The smoke checks failed on the new build."
BEFORE="$(discovered_rows "$DB")" AFTER="$(discovered_rows "$STAGE_DB")"
(( AFTER >= BEFORE )) || die "The new build lost discovered models: $BEFORE before, $AFTER after the migration."
echo "ok    discovered models kept ($BEFORE before, $AFTER after)"
if [[ $CHAT == 1 ]]; then
  ANSWER="$(FREETIER_BASE_URL="http://127.0.0.1:$STAGE_PORT/v1" FREETIER_AUTOSTART=0 \
    "$NODE" "$PI_CONFIG/bin/ftr" ask "Reply with the single word pong." </dev/null 2>"$REPORT/ftr.log")" \
    || die "ftr (the pi client) failed on the new build. See $REPORT/ftr.log."
  [[ -n "$ANSWER" ]] || die "ftr got an empty answer from the new build."
  echo "ok    ftr ask through the pi client"
fi
stop_pid "$(port_pid "$STAGE_PORT")"; stop_pid "$STAGE_PID"; trap - EXIT

if [[ $MODE == check ]]; then
  git -C "$MAIN" worktree remove --force "$WT"
  step "All checks passed on main."
  exit 0
fi

# ── 4. Move main to the checked merge ──
step "Moving main to $BRANCH"
git -C "$MAIN" merge --ff-only "$BRANCH"
git -C "$MAIN" worktree remove --force "$WT"
git -C "$MAIN" branch -d "$BRANCH"
if [[ $RESTART == 0 ]]; then
  step "Done. main is synced, and the router on $LIVE_PORT still runs the old build."
  echo "To switch, run: cd $MAIN && npm ci && npm run build, then restart the router."
  exit 0
fi

# ── 5. Replace the live router, and roll back if the new one fails ──
step "Backing up the DB and the old build to $BACKUPS"
mkdir -p "$BACKUPS"
snapshot_db "$DB" "$BACKUPS/freeapi.db"
for d in $DISTS; do
  if [[ -d "$MAIN/$d" ]]; then mkdir -p "$BACKUPS/$(dirname "$d")"; cp -R "$MAIN/$d" "$BACKUPS/$d"; fi
done

start_router() {
  (cd "$MAIN" && nohup "$NODE" server/dist/index.js >>"$LOG" 2>&1 & echo $! >"$PID_FILE")
  wait_up "$LIVE_PORT"
}
stop_router() { stop_pid "$(port_pid "$LIVE_PORT")"; }

rollback() {
  echo "Rolling back to $OLD_MAIN"
  stop_router
  git -C "$MAIN" reset --hard "$OLD_MAIN"
  (cd "$MAIN" && npm ci) >"$REPORT/rollback-install.log" 2>&1 || true
  for d in $DISTS; do
    if [[ -d "$BACKUPS/$d" ]]; then rm -rf "${MAIN:?}/$d"; cp -R "$BACKUPS/$d" "$MAIN/$d"; fi
  done
  cp "$BACKUPS/freeapi.db" "$DB" && rm -f "$DB-wal" "$DB-shm"
  start_router && "$NODE" "$MAIN/scripts/fork/smoke.mjs" --base "http://127.0.0.1:$LIVE_PORT" --no-chat \
    && echo "The old router runs again on $LIVE_PORT." \
    || echo "The old router did not come back. See $LOG. The backups are in $BACKUPS."
  die "$1"
}

step "Building main"
(cd "$MAIN" && npm ci && npm run build) >"$REPORT/main-build.log" 2>&1 || rollback "The build on main failed. See $REPORT/main-build.log."
step "Restarting the router on $LIVE_PORT"
stop_router
start_router || rollback "The new router did not start. See $LOG."
"$NODE" "$MAIN/scripts/fork/smoke.mjs" --base "http://127.0.0.1:$LIVE_PORT" ${CHAT_FLAG[@]+"${CHAT_FLAG[@]}"} \
  || rollback "The smoke checks failed on the live router."

step "Synced. main moved from ${OLD_MAIN:0:8} to $(git -C "$MAIN" rev-parse --short main), and the new router runs on $LIVE_PORT."
echo "Backups: $BACKUPS"
echo "Push it yourself when you are ready: git -C $MAIN push origin main"
