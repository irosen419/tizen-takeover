#!/bin/sh
# Home Hub auto-pull: keeps this checkout on the newest main, so a merge
# reaches the wall tablet, the phone app and the Pi server by itself.
# Run every 5 minutes by a systemd user timer (pi/autopull/install.sh).
# Plain shell and git: no Claude, no tokens, nothing leaves the Pi but the
# git fetch.
#
# Each run:
#   - pi/data/autopull.off exists: does nothing (logs "off" once).
#   - another run is still going (the lock): does nothing.
#   - failed a short while ago: waits (5 min x 2^failures, at most 6 h).
#   - not on main, or files changed by hand on the Pi: skips (logged once).
#   - fetches origin main; already there: nothing, no log line.
#   - not a fast-forward (the Pi has its own commits): skips (logged once).
#   - fast-forwards. Only app/, docs/, dev/, studio/ and the like changed:
#     nothing to restart (the hub serves app/ fresh; app/appver.js reloads the
#     tablet and phone). A server file in pi/ changed: restarts the hub, then
#     the budget user service if there is one, the same order as hubup in
#     pi/aliases.sh.
#
# Log: pi/data/autopull.log, one line per action, counts only (never a file
# name or a commit message), the newest 200 lines. State (failures, the last
# reason logged, a restart still owed): pi/data/autopull.state.
#
# For tests: AUTOPULL_REPO (the checkout; default: two folders up from here),
# AUTOPULL_DATA (default: pi/data), AUTOPULL_NOW (seconds, for the backoff)
# and AUTOPULL_RESTART_CMD (run as "$AUTOPULL_RESTART_CMD hub", "... budget"
# and "... has-budget" instead of docker compose and systemctl).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${AUTOPULL_REPO:-$(cd "$HERE/../.." && pwd)}
DATA=${AUTOPULL_DATA:-$REPO/pi/data}
BRANCH=main
FAKE=${AUTOPULL_RESTART_CMD:-}
LOG=$DATA/autopull.log
STATE=$DATA/autopull.state
OFF=$DATA/autopull.off
LOCK=$DATA/autopull.lock
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true LC_ALL=C

mkdir -p "$DATA" || exit 1

now() { echo "${AUTOPULL_NOW:-$(date +%s)}"; }

say() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M')" "$1" >> "$LOG"
  if [ "$(wc -l < "$LOG")" -gt 200 ]; then
    tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# --- the lock: one run at a time (a lock older than 30 min is left over) ---
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit 1' INT TERM HUP

# --- state ---
get() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | head -n 1; }
num() { case ${1:-} in ''|*[!0-9]*) echo 0;; *) echo "$1";; esac; }
FAILS=$(num "$(get fails)")
LAST=$(num "$(get last)")
REASON=$(get reason)
PENDING=$(get pending)

save() {
  printf 'fails=%s\nlast=%s\nreason=%s\npending=%s\n' "$FAILS" "$LAST" "$REASON" "$PENDING" > "$STATE.tmp" &&
    mv "$STATE.tmp" "$STATE"
}

# A reason to skip: logged only when it differs from the last one.
note() {
  [ "$REASON" = "$1" ] || say "$2"
  REASON=$1
  FAILS=0
  save
  exit 0
}

backoff() {
  w=300; i=0
  while [ "$i" -lt "$FAILS" ] && [ "$w" -lt 21600 ]; do w=$((w * 2)); i=$((i + 1)); done
  [ "$w" -gt 21600 ] && w=21600
  echo "$w"
}

fail() {
  FAILS=$((FAILS + 1))
  LAST=$(now)
  REASON=fail
  say "$1 ($FAILS in a row; next try in $(( $(backoff) / 60 )) min)"
  save
  exit 0
}

# --- restarts (the same order as hubup) ---
restart_hub() {
  if [ -n "$FAKE" ]; then $FAKE hub; return; fi
  ( cd "$REPO/pi" && docker compose up -d hub && docker compose restart hub ) >/dev/null 2>&1
}
has_budget() {
  if [ -n "$FAKE" ]; then $FAKE has-budget; return; fi
  systemctl --user cat budget >/dev/null 2>&1
}
restart_budget() {
  if [ -n "$FAKE" ]; then $FAKE budget; return; fi
  systemctl --user restart budget >/dev/null 2>&1
}
# Prints what was restarted ("hub+budget", "hub"); fails when the hub didn't.
restart_all() {
  restart_hub || return 1
  if has_budget; then
    restart_budget || { echo "hub (budget restart failed)"; return 0; }
    echo "hub+budget"
  else
    echo "hub"
  fi
}

# --- the run ---
if [ -f "$OFF" ]; then
  note off "off (pi/data/autopull.off is there)"
fi
if [ "$REASON" = off ]; then say "on again"; REASON=; save; fi

if [ "$FAILS" -gt 0 ] && [ "$(now)" -lt $((LAST + $(backoff))) ]; then
  exit 0
fi

cd "$REPO" 2>/dev/null || fail "failed: the checkout is missing"
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$BRANCH" ] || note branch "skipped: the checkout is not on $BRANCH"
CHANGED=$(git status --porcelain --untracked-files=no 2>/dev/null | grep -c .)
[ "$CHANGED" -eq 0 ] || note dirty "skipped: $CHANGED file(s) changed on the Pi"

if command -v timeout >/dev/null 2>&1; then T="timeout 120"; else T=; fi
$T git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >/dev/null 2>&1 || fail "fetch failed"
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse "refs/remotes/origin/$BRANCH")

if [ "$OLD" = "$NEW" ]; then
  if [ -n "$PENDING" ]; then
    DID=$(restart_all) || fail "hub restart failed again"
    PENDING=
    FAILS=0; REASON=restarted
    say "restarted $DID (owed from an earlier pull)"
    save
    exit 0
  fi
  REASON=current; FAILS=0
  save
  exit 0
fi

git merge-base --is-ancestor "$OLD" "$NEW" 2>/dev/null ||
  note nonff "skipped: main on the Pi has its own commits, so it is not a fast-forward"
git merge --ff-only --quiet "$NEW" >/dev/null 2>&1 || fail "fast-forward failed"

FILES=$(git diff --name-only "$OLD" "$NEW")
NFILES=$(printf '%s\n' "$FILES" | grep -c .)
NCOMMITS=$(git rev-list --count "$OLD..$NEW")
BYDIR=$(printf '%s\n' "$FILES" | grep . | awk -F/ '{ print (NF > 1 ? $1 : "top") }' | sort | uniq -c |
  awk '{ printf "%s%s %s", (NR > 1 ? ", " : ""), $2, $1 }')
# Server files: pi/<file> but not its tests, notes, shortcuts or the ./hub wrapper.
SERVER=$(printf '%s\n' "$FILES" | grep -E '^pi/[^/]+$' |
  grep -vE '(-test\.js|^pi/test\.js|\.md|^pi/aliases\.sh|^pi/hub|^pi/\.gitignore)$' | grep -c .)
WHAT="pulled $NCOMMITS commit(s), $NFILES file(s) ($BYDIR)"

if [ "$SERVER" -gt 0 ]; then
  PENDING=hub
  save
  DID=$(restart_all) || fail "$WHAT, hub restart failed"
  PENDING=
  FAILS=0; REASON=pulled
  say "$WHAT, restarted $DID"
else
  FAILS=0; REASON=pulled
  say "$WHAT, no restart"
fi
save
exit 0
