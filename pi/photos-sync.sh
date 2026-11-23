#!/bin/sh
# Copies new photos from the wall calendar (Dragon Touch, eCalendar app) into
# pi/data/photos/ for the TV's photo album. Runs on the Pi host (the hub's
# Docker container has no adb), every 30 minutes from the systemd user timer
# photos-sync.timer. See pi/README.md, "Photo album".
#
#   pi/photos-sync.sh
#
# Settings (environment, all optional):
#   PHOTOS_ADB_ADDR   the calendar's adb address (default 192.168.1.208:5555)
#   PHOTOS_SRC        the folder on the calendar (default /sdcard/CloudAlbum)
#   PHOTOS_DATA_DIR   the hub's data folder (default pi/data)
#
# Never deletes anything, on the calendar or here: it only pulls files that
# are not here yet. Only images (.webp .jpg .jpeg .png); videos are skipped.
# Prints counts only, never a file name. A calendar that is off or away is
# not an error: it exits 0 and says nothing.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ADDR="${PHOTOS_ADB_ADDR:-192.168.1.208:5555}"
SRC="${PHOTOS_SRC:-/sdcard/CloudAlbum}"
DATA="${PHOTOS_DATA_DIR:-$HERE/data}"
DIR="$DATA/photos"
ORIG="$DIR/orig"
THUMB="$DIR/thumb"

command -v adb >/dev/null 2>&1 || { echo "photos: adb is not installed (sudo apt install android-tools-adb)"; exit 1; }

T=""
command -v timeout >/dev/null 2>&1 && T="timeout 20"

# Reachable? Quietly done when not.
$T adb connect "$ADDR" >/dev/null 2>&1
[ "$($T adb -s "$ADDR" get-state 2>/dev/null)" = "device" ] || exit 0

mkdir -p "$ORIG" "$THUMB" 2>/dev/null
if [ ! -w "$ORIG" ] || [ ! -w "$THUMB" ] || [ ! -w "$DIR" ]; then
  echo "photos: cannot write to pi/data/photos (fix once: sudo mkdir -p $DIR && sudo chown -R $(id -un): $DIR)"
  exit 1
fi

# One run at a time.
LOCK="$DIR/.sync.lock"
mkdir "$LOCK" 2>/dev/null || { [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ] && rm -rf "$LOCK" && mkdir "$LOCK"; } || exit 0
trap 'rm -rf "$LOCK"' EXIT INT TERM

IM=""
if command -v magick >/dev/null 2>&1; then IM=magick
elif command -v convert >/dev/null 2>&1; then IM=convert
fi

idof() { printf '%s' "$1" | sha1sum | cut -c1-12; }

LIST="$DIR/.list.$$"
OK=1
if ! $T adb -s "$ADDR" shell ls -1 "$SRC/" 2>/dev/null | tr -d '\r' > "$LIST"; then
  rm -f "$LIST"
  echo "photos: could not list the calendar's album"
  exit 0
fi

NEW=0
FAILED=0
while IFS= read -r name; do
  case "$name" in
    ''|.*|*/*) continue ;;
  esac
  lower=$(printf '%s' "$name" | tr 'A-Z' 'a-z')
  case "$lower" in
    *.webp|*.jpg|*.jpeg|*.png) ;;
    *) continue ;;
  esac
  [ -e "$ORIG/$name" ] && continue
  part="$ORIG/.part-$$"
  # -a keeps the calendar's file time (the album month comes from it).
  if timeout 120 adb -s "$ADDR" pull -a "$SRC/$name" "$part" >/dev/null 2>&1 ||
     timeout 120 adb -s "$ADDR" pull "$SRC/$name" "$part" >/dev/null 2>&1; then
    mv "$part" "$ORIG/$name" && NEW=$((NEW + 1))
  else
    rm -f "$part"
    FAILED=$((FAILED + 1))
  fi
done < "$LIST"
rm -f "$LIST"
[ "$FAILED" -gt 0 ] && OK=0

# A thumb for every original that has none (480 px wide JPEG, or a copy).
for f in "$ORIG"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  ext=$(printf '%s' "${name##*.}" | tr 'A-Z' 'a-z')
  case "$ext" in webp|jpg|jpeg|png) ;; *) continue ;; esac
  id=$(idof "$name")
  [ -e "$THUMB/$id.jpg" ] || [ -e "$THUMB/$id.$ext" ] && continue
  if [ -n "$IM" ] && $IM "$f[0]" -auto-orient -thumbnail '480x>' -strip -quality 80 "$THUMB/.$id.jpg" >/dev/null 2>&1; then
    mv "$THUMB/.$id.jpg" "$THUMB/$id.jpg"
  else
    rm -f "$THUMB/.$id.jpg"
    cp -p "$f" "$THUMB/.$id.$ext" && mv "$THUMB/.$id.$ext" "$THUMB/$id.$ext"
  fi
done

# Rebuild index.json and state.json (counts only). The host's node, or the
# hub's own image when the Pi has no node outside Docker.
if command -v node >/dev/null 2>&1; then
  node "$HERE/photos.js" index "$DATA" --new "$NEW" --ok "$OK"
else
  docker run --rm -v "$HERE:/app:ro" -v "$DATA:/data" -w /app node:22-alpine \
    node photos.js index /data --new "$NEW" --ok "$OK"
fi
[ "$FAILED" -gt 0 ] && echo "photos: $FAILED could not be copied (tried again next run)"
exit 0
