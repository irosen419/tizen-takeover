# Home Hub shortcuts for the Pi. Installed once by adding this line to ~/.bashrc:
#   [ -f ~/code/tizen-takeover/pi/aliases.sh ] && . ~/code/tizen-takeover/pi/aliases.sh
# Because it lives in the repo, `git pull` keeps the shortcuts current.
# Nothing here runs on its own: each command runs only when you type it.

HUB_REPO="${HUB_REPO:-$HOME/code/tizen-takeover}"

# hubup: pull the newest code (the auto-pull timer does this every 5 minutes;
# hubup is for the first install or when it is stuck), restart the hub, THEN the budget app (hub first,
# so the budget's new snapshot is not dropped), and say what is running.
hubup() {
  ( cd "$HUB_REPO" && git pull --ff-only ) || { echo "hubup: git pull failed, nothing restarted"; return 1; }
  ( cd "$HUB_REPO/pi" && docker compose up -d hub && docker compose restart hub ) || { echo "hubup: hub restart failed"; return 1; }
  if [ "$1" != "--no-budget" ] && systemctl --user cat budget >/dev/null 2>&1; then
    systemctl --user restart budget && echo "budget restarted"
  else
    echo "budget not restarted (no user service named budget here, or --no-budget)"
  fi
  sleep 3
  hubstat
}

hubrestart() { ( cd "$HUB_REPO/pi" && docker compose up -d hub && docker compose restart hub ) && sleep 3 && hubstat; }  # hub only, no pull
budgetrestart() { systemctl --user restart budget && echo "budget restarted"; }
hubstat() { ( cd "$HUB_REPO/pi" && ./hub status ); }
hublog() { ( cd "$HUB_REPO/pi" && ./hub log "$@" ); }       # hublog --errors, hublog --lines 120
hubhub() { ( cd "$HUB_REPO/pi" && ./hub "$@" ); }           # any ./hub command from anywhere
hubdocker() { ( cd "$HUB_REPO/pi" && docker compose "$@" ); }  # hubdocker ps, hubdocker logs --tail 50 hub

# hubauto: is the auto-pull timer (pi/autopull/) on, and its last 5 log lines.
# hubauto off | on: pause it or let it go on (the pi/data/autopull.off switch).
hubauto() {
  case "${1:-}" in
    off) touch "$HUB_REPO/pi/data/autopull.off" && echo "auto-pull: off (hubauto on to resume)"; return;;
    on) rm -f "$HUB_REPO/pi/data/autopull.off" && echo "auto-pull: on";;
  esac
  if [ -f "$HUB_REPO/pi/data/autopull.off" ]; then echo "auto-pull: off (switch file there)"; else echo "auto-pull: on"; fi
  systemctl --user is-active --quiet hub-autopull.timer && echo "timer: running" || echo "timer: not installed (pi/autopull/install.sh --run)"
  tail -n 5 "$HUB_REPO/pi/data/autopull.log" 2>/dev/null || echo "no log yet"
}
