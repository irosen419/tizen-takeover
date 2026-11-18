#!/usr/bin/env bash
# Put several to-dos on the hub in one go, through the Pi's R2 mailbox.
#
# Why: one `todo.add` and waiting for its reply takes ~30 s. The Pi runs up to
# 20 mailbox commands per 10 s poll, so this writes all the commands at once,
# then waits for the replies together. No Pi change is needed.
#
# Usage:
#   dev/todo-bulk.sh [--level must|optional|passive] [--due YYYY-MM-DD]
#                    [--dry-run] [--no-signal] FILE|-
#
# FILE (or - for stdin) is either a JSON array whose entries are titles
# (strings) or objects with the todo.add args (title, level, due, lead, notes,
# section), or plain text with one title per line (blank lines and lines
# starting with # are skipped). --level and --due are defaults for entries that
# do not set their own. At most 40 items. Everything is checked before anything
# is sent; on a bad entry nothing is sent and the exit code is non-zero.
#
# The list reads top-down in the order you give: the Pi puts each new item at
# the top, so the files are sent in reverse order (the last item gets the
# earliest "created" time, 1 ms apart).
#
# --dry-run prints the command files and sends nothing (no network). Set
# TODO_BULK_OUT=<dir> to also keep them in that directory.
#
# Example:
#   printf '%s\n' '[{"title":"Call the dentist","level":"must"},"Buy milk"]' \
#     | dev/todo-bulk.sh --due 2026-12-24 -
#
# Exit code is non-zero if the Pi looks offline, an entry is invalid, or any
# reply is ok:false or missing. It never resends.
set -u

B=https://api.cloudflare.com/client/v4/accounts/f24d1741cf57727291b631def49ffacb/r2/buckets/home-hub-mailbox/objects
LEVEL= DUE= DRY=0 SIGNAL=1 SRC=

die() { echo "todo-bulk: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --level) [ $# -ge 2 ] || die "--level needs a value"; LEVEL=$2; shift 2 ;;
    --due) [ $# -ge 2 ] || die "--due needs a value"; DUE=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-signal) SIGNAL=0; shift ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -) SRC=-; shift ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$SRC" ] || die "only one input file"; SRC=$1; shift ;;
  esac
done
[ -n "$SRC" ] || die "give a file or - for stdin (see --help)"
command -v node >/dev/null || die "node is needed"

TMP=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$TMP"' EXIT
if [ "$SRC" = - ]; then cat > "$TMP/input"; else cat -- "$SRC" > "$TMP/input" || die "cannot read $SRC"; fi
mkdir "$TMP/cmds"

# Validate and write the command files (one JSON file per command).
NODE_BUILD='
const fs = require("fs");
const [input, outDir, defLevel, defDue, signal] = process.argv.slice(1);
const raw = fs.readFileSync(input, "utf8");
const errors = [];
let entries;
if (/^\s*\[/.test(raw)) {
  try { entries = JSON.parse(raw); } catch (e) { console.error("todo-bulk: not valid JSON: " + e.message); process.exit(2); }
} else {
  entries = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== "#");
}
const LEVELS = ["must", "optional", "passive"], SECTIONS = ["now", "next", "waiting"];
const KEYS = ["title", "level", "due", "lead", "notes", "section"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
if (defLevel && LEVELS.indexOf(defLevel) < 0) errors.push("--level must be must, optional or passive");
if (defDue && !isDate(defDue)) errors.push("--due must be a real date like 2026-12-24");
if (!entries.length) errors.push("no items found");
if (entries.length > 40) errors.push("at most 40 items (got " + entries.length + ")");
const items = entries.map((e, i) => {
  const n = "entry " + (i + 1);
  const bad = (m) => errors.push(n + ": " + m);
  if (typeof e === "string") e = { title: e };
  if (!e || typeof e !== "object" || Array.isArray(e)) { bad("must be a title string or an object"); return null; }
  Object.keys(e).forEach((k) => { if (KEYS.indexOf(k) < 0) bad("unknown key \"" + k + "\""); });
  const a = {};
  if (typeof e.title !== "string" || !e.title.trim()) bad("title is missing");
  else if (e.title.trim().length > 80) bad("title is " + e.title.trim().length + " characters (max 80)");
  else a.title = e.title.trim();
  const level = e.level !== undefined ? e.level : (defLevel || undefined);
  if (level !== undefined) { if (LEVELS.indexOf(level) < 0) bad("level must be must, optional or passive"); else a.level = level; }
  const due = e.due !== undefined ? e.due : (defDue || undefined);
  if (due !== undefined) { if (!isDate(due)) bad("due must be a real date like 2026-12-24"); else a.due = due; }
  if (e.lead !== undefined) { if (!Number.isInteger(e.lead) || e.lead < 0 || e.lead > 30) bad("lead must be a whole number 0-30"); else a.lead = e.lead; }
  if (e.notes !== undefined) { if (typeof e.notes !== "string" || e.notes.length > 300) bad("notes must be text up to 300 characters"); else a.notes = e.notes; }
  if (e.section !== undefined) { if (SECTIONS.indexOf(e.section) < 0) bad("section must be now, next or waiting"); else a.section = e.section; }
  return a;
});
if (errors.length) { errors.forEach((m) => console.error("todo-bulk: " + m)); console.error("todo-bulk: nothing was sent"); process.exit(2); }
// Reverse order: the Pi unshifts, so the last item must be added first.
// Times sit in the past (the Pi refuses "created" more than 5 min ahead).
const N = items.length, start = Date.now() - 5000 - N, run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ids = [];
items.forEach((a, i) => {
  const id = "tb" + run + "-" + String(i + 1).padStart(2, "0");
  const created = new Date(start + (N - 1 - i)).toISOString();
  ids.push(id);
  fs.writeFileSync(outDir + "/" + id + ".json", JSON.stringify({ id, created, cmd: "todo.add", args: a }));
});
if (signal === "1") {
  const id = "tbsig" + run;
  fs.writeFileSync(outDir + "/" + id + ".json", JSON.stringify({ id, created: new Date(start - 1).toISOString(), cmd: "say", args: { text: "hub:working todo 90" } }));
}
fs.writeFileSync(outDir + "/ids.txt", ids.join("\n") + "\n");
'
node -e "$NODE_BUILD" "$TMP/input" "$TMP/cmds" "$LEVEL" "$DUE" "$SIGNAL" || exit 2

if [ "$DRY" = 1 ]; then
  for f in "$TMP"/cmds/*.json; do cat "$f"; echo; done
  if [ -n "${TODO_BULK_OUT:-}" ]; then mkdir -p "$TODO_BULK_OUT" && cp "$TMP"/cmds/* "$TODO_BULK_OUT"/; fi
  echo "dry run: $(wc -l < "$TMP/cmds/ids.txt" | tr -d ' ') to-dos, nothing sent"
  exit 0
fi

# Is the Pi alive? "updated" must be under 3 minutes old.
curl -sS --max-time 20 "$B/status.json" -o "$TMP/status.json" 2>/dev/null || { echo "todo-bulk: could not read the mailbox status; nothing sent" >&2; exit 3; }
node -e '
let s; try { s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
const age = (Date.now() - Date.parse(s.updated)) / 1000;
if (!isFinite(age)) process.exit(1);
if (age > 180) { console.error("todo-bulk: the Pi looks offline (status is " + Math.round(age / 60) + " min old); nothing sent"); process.exit(3); }
' "$TMP/status.json" || { echo "todo-bulk: the Pi looks offline or its status is unreadable; nothing sent" >&2; exit 3; }

# Send everything back to back.
for f in "$TMP"/cmds/*.json; do
  id=$(basename "$f" .json)
  curl -sS --max-time 30 -X PUT "$B/inbox%2F$id.json" -H 'content-type: application/json' --data @"$f" -o /dev/null \
    || { echo "todo-bulk: could not send $id; stopping (nothing is resent)" >&2; exit 4; }
done

# Poll for replies every 5 s, up to 90 s.
IDS=$(cat "$TMP/cmds/ids.txt")
mkdir "$TMP/out"
deadline=$((SECONDS + 90))
while :; do
  pending=0
  for id in $IDS; do
    if ! node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state==="done"?0:1)}catch(e){process.exit(1)}' "$TMP/out/$id.json" 2>/dev/null; then
      curl -sS --max-time 15 "$B/outbox%2F$id.json" -o "$TMP/out/$id.json" 2>/dev/null || true
      node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state==="done"?0:1)}catch(e){process.exit(1)}' "$TMP/out/$id.json" 2>/dev/null || pending=1
    fi
  done
  [ "$pending" = 0 ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 5
done

node -e '
const fs = require("fs");
const [dir, idsFile, cmds] = process.argv.slice(1);
const ids = fs.readFileSync(idsFile, "utf8").split("\n").filter(Boolean);
let ok = 0;
ids.forEach((id, i) => {
  let r = null, c = null;
  try { r = JSON.parse(fs.readFileSync(dir + "/" + id + ".json", "utf8")); } catch (e) {}
  try { c = JSON.parse(fs.readFileSync(cmds + "/" + id + ".json", "utf8")); } catch (e) {}
  const t = c ? c.args.title : id;
  if (r && r.state === "done") { if (r.ok) ok++; console.log((r.ok ? "ok" : "FAILED") + ": " + t + " - " + String(r.message || "").slice(0, 200)); }
  else console.log("no reply yet: " + t);
});
console.log(ok + " of " + ids.length + " added");
process.exit(ok === ids.length ? 0 : 1);
' "$TMP/out" "$TMP/cmds/ids.txt" "$TMP/cmds"
