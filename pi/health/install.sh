#!/bin/sh
# Sets up the weekly Pi health report as a systemd user timer. Safe to run
# again: it rewrites the two unit files and leaves everything else alone.
#
#   pi/health/install.sh          install (or update) and turn the timer on
#   pi/health/install.sh --run    the same, then make one report now
#   pi/health/install.sh --remove turn it off and remove the unit files
#
# Runs as the normal user (no sudo). The report lands in pi/data/health/ and
# the hub server copies it to the Claude mailbox bucket within a minute.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PY=$(command -v python3 || true)
WHEN="${PI_HEALTH_WHEN:-Sun *-*-* 03:15:00 America/Chicago}"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now pi-health.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/pi-health.timer" "$UNIT_DIR/pi-health.service"
  systemctl --user daemon-reload
  echo "Weekly Pi health report removed. Old reports stay in pi/data/health/."
  exit 0
fi

if [ -z "$PY" ]; then
  echo "python3 is not installed (sudo apt install python3)."
  exit 1
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/pi-health.service" <<UNIT
[Unit]
Description=Weekly Pi health report (tizen-takeover pi/health)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$HERE
ExecStart=$PY $HERE/pi-health.py
Nice=10
TimeoutStartSec=15min
UNIT

cat > "$UNIT_DIR/pi-health.timer" <<UNIT
[Unit]
Description=Weekly Pi health report

[Timer]
OnCalendar=$WHEN
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now pi-health.timer >/dev/null
echo "Weekly Pi health report: on ($WHEN)."
systemctl --user list-timers pi-health.timer --no-pager --no-legend | sed 's/^/  next: /'

# What the report can see depends on these; say plainly what is missing.
if [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null)" != "Linger=yes" ]; then
  echo "Note: linger is off, so the timer only runs while you are logged in. Fix: sudo loginctl enable-linger $USER"
fi
for g in adm docker video; do
  if ! id -nG | tr ' ' '\n' | grep -qx "$g"; then
    case $g in
      adm) why="the kernel log (SD card, power and memory errors)";;
      docker) why="the containers";;
      video) why="vcgencmd (throttling and under-voltage)";;
    esac
    echo "Note: $USER is not in the $g group, so the report cannot read $why. Fix: sudo usermod -aG $g $USER (then log in again)"
  fi
done

if [ "${1:-}" = "--run" ]; then
  echo "Making a report now (about a minute)..."
  systemctl --user start pi-health.service
  cat "$HERE/../data/health/latest.txt"
fi
