#!/bin/sh
# Copies new photos from the wall calendar (Dragon Touch, eCalendar app) into
# pi/data/photos/ for the TV's photo album. Runs on the Pi host (the hub's
# Docker container has no adb), every 30 minutes from the systemd user timer
# photos-sync.timer. See pi/README.md, "Photo album".
#
#   pi/photos-sync.sh
#
# Settings (environment, all optional):
#   PHOTOS_ADB_ADDR   the calendar's adb address, host:5555. Kept out of the
#                     public repo: from the environment, else the
#                     PHOTOS_ADB_ADDR= line in pi/.env, else the one network
#                     device adb is already connected to
#   PHOTOS_SRC        the folder on the calendar (default /sdcard/CloudAlbum)
#   PHOTOS_DATA_DIR   the hub's data folder (default pi/data)
#
# Never deletes anything, on the calendar or here: it only pulls files that
# are not here yet. Searches the album folder at any depth. Images (.webp
# .jpg .jpeg .png, any case) and videos, the "live photos" (.mp4 .mov .m4v);
# ".downloading" is skipped. Each video becomes a small H.264 clip (clip/,
# 1280 px at most, no sound, 30 s at most) and a still of its first frame
# (still/, and a thumb) with ffmpeg; without ffmpeg the videos wait, counted
# in one line, and the photos carry on. A video ffmpeg cannot read gets
# clip/<id>.bad and is not tried again (delete it to retry).
# Prints counts only, never a file name. A calendar that is off or away is
# not an error: it says nothing (videos already here are still converted).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ADDR="${PHOTOS_ADB_ADDR:-}"
if [ -z "$ADDR" ] && [ -r "$HERE/.env" ]; then
  ADDR=$(sed -n 's/^PHOTOS_ADB_ADDR=//p' "$HERE/.env" | tail -n 1 | tr -d "\"' \r")
fi
SRC="${PHOTOS_SRC:-/sdcard/CloudAlbum}"
DATA="${PHOTOS_DATA_DIR:-$HERE/data}"
DIR="$DATA/photos"
ORIG="$DIR/orig"
THUMB="$DIR/thumb"

command -v adb >/dev/null 2>&1 || { echo "photos: adb is not installed (sudo apt install android-tools-adb)"; exit 1; }
if [ -z "$ADDR" ]; then
  ADDR=$(adb devices 2>/dev/null | awk '$2 == "device" && $1 ~ /:[0-9]+$/ { print $1 }' | head -n 1)
fi
[ -n "$ADDR" ] || { echo "photos: no calendar address (add PHOTOS_ADB_ADDR=<address>:5555 to pi/.env)"; exit 1; }

CLIP="$DIR/clip"
STILL="$DIR/still"

T=""
TP=""
TV=""
command -v timeout >/dev/null 2>&1 && { T="timeout 20"; TP="timeout 300"; TV="timeout 600"; }

idof() { printf '%s' "$1" | sha1sum | cut -c1-12; }
vids() { [ "$1" = 1 ] && echo "1 video" || echo "$1 videos"; }

# Videos here with no clip yet (and not marked bad).
pending_videos() {
  n=0
  for f in "$ORIG"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$(printf '%s' "$name" | tr 'A-Z' 'a-z')" in *.mp4|*.mov|*.m4v) ;; *) continue ;; esac
    id=$(idof "$name")
    [ -e "$CLIP/$id.mp4" ] || [ -e "$CLIP/$id.bad" ] || n=$((n + 1))
  done
  echo "$n"
}

# Reachable? When not: convert videos already here (if ffmpeg is in), else quietly done.
PULL=1
$T adb connect "$ADDR" >/dev/null 2>&1
if [ "$($T adb -s "$ADDR" get-state 2>/dev/null)" != "device" ]; then
  command -v ffmpeg >/dev/null 2>&1 && [ -d "$ORIG" ] && [ "$(pending_videos)" -gt 0 ] || exit 0
  PULL=0
fi

mkdir -p "$ORIG" "$THUMB" "$CLIP" "$STILL" 2>/dev/null
if [ ! -w "$ORIG" ] || [ ! -w "$THUMB" ] || [ ! -w "$DIR" ] || [ ! -w "$CLIP" ] || [ ! -w "$STILL" ]; then
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

NEW=0
FAILED=0
OK=1
LIST="$DIR/.list.$$"
if [ "$PULL" = 1 ]; then
# Every file under the album, however deep (eCalendar keeps them around
# CloudAlbum/cloud/<account>/photos/.../YYYY/MM/), as "size|path". Paths
# with spaces are fine: the line is split at the first "|" only.
if $T adb -s "$ADDR" shell "find '$SRC' -type f -exec stat -c '%s|%n' {} + 2>/dev/null; true" > "$LIST.raw" 2>/dev/null; then
  tr -d '\r' < "$LIST.raw" > "$LIST"; rm -f "$LIST.raw"
else
  rm -f "$LIST" "$LIST.raw"
  echo "photos: could not list the calendar's album"
  exit 0
fi

while IFS= read -r line; do
  size=${line%%|*}
  rpath=${line#*|}
  case "$size" in ''|*[!0-9]*) continue ;; esac
  case "$rpath" in
    *.downloading|*.downloading/*|*/.downloading/*) continue ;; # partial downloads
  esac
  name=${rpath##*/}
  case "$name" in ''|.*) continue ;; esac
  lower=$(printf '%s' "$name" | tr 'A-Z' 'a-z')
  case "$lower" in
    *.webp) ext=webp ;;
    *.jpg|*.jpeg) ext=jpg ;;
    *.png) ext=png ;;
    *.mp4) ext=mp4 ;;
    *.mov) ext=mov ;;
    *.m4v) ext=m4v ;;
    *) continue ;;
  esac
  # The copy is named by file name + size, not by folder: the same photo in
  # two folders is one copy, and a moved file is not pulled again.
  lname="$(idof "$name|$size").$ext"
  [ -e "$ORIG/$lname" ] && continue
  part="$ORIG/.part-$$"
  # -a keeps the calendar's file time (the album month comes from it).
  if $TP adb -s "$ADDR" pull -a "$rpath" "$part" >/dev/null 2>&1 </dev/null ||
     $TP adb -s "$ADDR" pull "$rpath" "$part" >/dev/null 2>&1 </dev/null; then
    mv "$part" "$ORIG/$lname" && NEW=$((NEW + 1))
  else
    rm -f "$part"
    FAILED=$((FAILED + 1))
  fi
done < "$LIST"
rm -f "$LIST"
[ "$FAILED" -gt 0 ] && OK=0
fi

# Videos: a small H.264 clip and a still of the first frame for each.
# Long side 960 px at most, 30 fps, no sound, 30 s at most, Baseline profile
# (the wall calendar's old WebView decodes it smoothly; Main at 1280 stuttered
# and caught up too fast), moov at the front (+faststart) so it starts at once.
# CLIP_V is the recipe: when clip/.recipe says another, every clip is made
# again (the old one stays served until its new one is in).
CLIP_V=2
REDO=0
[ "$(cat "$CLIP/.recipe" 2>/dev/null)" = "$CLIP_V" ] || REDO=1
FIT='trunc(min(1\,LONG/max(iw\,ih))*iw/2)*2:trunc(min(1\,LONG/max(iw\,ih))*ih/2)*2'
CONVERTED=0
BAD=0
if command -v ffmpeg >/dev/null 2>&1; then
  for f in "$ORIG"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$(printf '%s' "$name" | tr 'A-Z' 'a-z')" in *.mp4|*.mov|*.m4v) ;; *) continue ;; esac
    id=$(idof "$name")
    [ -e "$CLIP/$id.bad" ] && continue
    [ -e "$CLIP/$id.mp4" ] && [ "$REDO" = 0 ] && continue
    if $TV nice -n 10 ffmpeg -nostdin -v error -y -i "$f" -t 30 -an -sn -dn \
         -vf "scale=$(printf '%s' "$FIT" | sed 's/LONG/960/g'),fps=30,format=yuv420p" \
         -c:v libx264 -profile:v baseline -level 3.1 -preset veryfast -crf 25 -g 30 \
         -movflags +faststart -f mp4 "$CLIP/.$id.mp4" </dev/null >/dev/null 2>&1 &&
       $T ffmpeg -nostdin -v error -y -i "$CLIP/.$id.mp4" -frames:v 1 -q:v 3 -f image2 "$STILL/.$id.jpg" </dev/null >/dev/null 2>&1 &&
       $T ffmpeg -nostdin -v error -y -i "$STILL/.$id.jpg" -vf "scale=480:-2" -q:v 4 -f image2 "$THUMB/.$id.jpg" </dev/null >/dev/null 2>&1; then
      # The still before the clip: the index takes a video once both are in.
      mv "$THUMB/.$id.jpg" "$THUMB/$id.jpg"
      mv "$STILL/.$id.jpg" "$STILL/$id.jpg"
      mv "$CLIP/.$id.mp4" "$CLIP/$id.mp4"
      CONVERTED=$((CONVERTED + 1))
    else
      rm -f "$CLIP/.$id.mp4" "$STILL/.$id.jpg" "$THUMB/.$id.jpg"
      : > "$CLIP/$id.bad"
      BAD=$((BAD + 1))
    fi
  done
  [ -w "$CLIP" ] && printf '%s\n' "$CLIP_V" > "$CLIP/.recipe"
else
  WAIT=$(pending_videos)
  [ "$WAIT" -gt 0 ] && echo "photos: $(vids "$WAIT") waiting for ffmpeg (sudo apt install -y ffmpeg)"
fi
[ "$PULL" = 0 ] && [ "$CONVERTED" = 0 ] && exit 0

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
  docker run --rm --user "$(id -u):$(id -g)" -v "$HERE:/app:ro" -v "$DATA:/data" -w /app node:22-alpine \
    node photos.js index /data --new "$NEW" --ok "$OK"
fi
[ "$FAILED" -gt 0 ] && echo "photos: $FAILED could not be copied (tried again next run)"
[ "$CONVERTED" -gt 0 ] && echo "photos: $(vids "$CONVERTED") converted"
[ "$BAD" -gt 0 ] && echo "photos: $(vids "$BAD") could not be converted (skipped from now on)"
exit 0
