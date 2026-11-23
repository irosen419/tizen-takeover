#!/bin/sh
# Sets up the Home Hub auto-pull (autopull.sh) as a systemd user timer: every
# 5 minutes the Pi fast-forwards this checkout to the newest main and, only
# when a server file in pi/ changed, restarts the hub and then the budget app.
# Safe to run again: it rewrites the two unit files and leaves everything
# else alone.
#
#   pi/autopull/install.sh          install (or update) and turn the timer on
#   pi/autopull/install.sh --run    the same, then pull once now
#   pi/autopull/install.sh --remove turn it off and remove the unit files
#
# Runs as the normal user (no sudo). To pause it without removing it:
# touch pi/data/autopull.off (rm it to go on). Log: pi/data/autopull.log.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now hub-autopull.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/hub-autopull.timer" "$UNIT_DIR/hub-autopull.service"
  systemctl --user daemon-reload
  echo "Home Hub auto-pull removed. Its log stays in pi/data/autopull.log."
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed (sudo apt install git)."
  exit 1
fi

chmod +x "$HERE/autopull.sh" 2>/dev/null || true
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/hub-autopull.service" <<UNIT
[Unit]
Description=Home Hub auto-pull (tizen-takeover pi/autopull)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$HERE
ExecStart=/bin/sh $HERE/autopull.sh
Nice=10
TimeoutStartSec=10min
UNIT

cat > "$UNIT_DIR/hub-autopull.timer" <<UNIT
[Unit]
Description=Home Hub auto-pull, every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now hub-autopull.timer >/dev/null
echo "Home Hub auto-pull: on (every 5 minutes)."
systemctl --user list-timers hub-autopull.timer --no-pager --no-legend | sed 's/^/  next: /'

if [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null)" != "Linger=yes" ]; then
  echo "Note: linger is off, so the timer only runs while you are logged in. Fix: sudo loginctl enable-linger $USER"
fi
if ! id -nG | tr ' ' '\n' | grep -qx docker; then
  echo "Note: $USER is not in the docker group, so a pull that changes the server cannot restart the hub. Fix: sudo usermod -aG docker $USER (then log in again)"
fi

if [ "${1:-}" = "--run" ]; then
  echo "Pulling once now..."
  systemctl --user start hub-autopull.service || true
  tail -n 3 "$HERE/../data/autopull.log" 2>/dev/null || echo "  already up to date (nothing logged)"
fi
