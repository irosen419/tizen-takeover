# Pi commands and their undos

Every lasting change made on the Pi by hand (outside `git pull`), with what it does, when, and how to reverse it. Checked against the Pi on 2026-11-25 (apt history, systemd, boot config, Tailscale). Dates are US Central, give or take a day for older ones (the Pi logged in London time until Nov 25).

Nothing here has needed undoing. Add a row whenever a new copy block is handed to Ian.

Paths assume `~/code/tizen-takeover`. "sudo" marks undos that ask for the password.

## Quick look: what is the Pi's state now

```
timedatectl | grep "Time zone"; systemctl --user list-timers --all; tailscale serve status; grep disable-bt /boot/firmware/config.txt
```

## System

### Time zone to Central (Nov 25, run by Ian)

```
sudo timedatectl set-timezone America/Chicago && systemctl --user daemon-reload && systemctl --user restart budget dashboard
```

Moves the Pi from London to Central time; timers, logs and the budget app's "today" follow. Confirmed on the Pi. cron was not restarted, which is fine: there is no crontab.

Undo (sudo):

```
sudo timedatectl set-timezone Europe/London && systemctl --user daemon-reload && systemctl --user restart budget dashboard
```

### Onboard Bluetooth off (Nov 20, run by Ian, rebooted)

```
sudo cp /boot/firmware/config.txt /boot/firmware/config.txt.bak-20261120 && echo "dtoverlay=disable-bt" | sudo tee -a /boot/firmware/config.txt && sudo reboot
```

Leaves the TP-Link USB adapter as the only Bluetooth controller.

Undo (sudo, reboots the Pi):

```
sudo sed -i '/^dtoverlay=disable-bt$/d' /boot/firmware/config.txt && sudo reboot
```

The backup `/boot/firmware/config.txt.bak-20261120` also works, but copying it back would drop any later edits to that file.

### hciuart service (given Nov 23, NOT run)

```
sudo systemctl disable --now hciuart
```

Optional. Only stops the weekly health report flagging it. Undo if ever run (sudo):

```
sudo systemctl enable --now hciuart
```

### Pi password (given Nov 20)

```
sudo passwd irosen419
```

Sets a new login password. No undo: run it again to set another.

## Installed packages

All installs pulled in extra libraries; `autoremove` clears those too. Remove only what you mean to: each one switches a feature off.

| When | Packages | For | Without it |
| --- | --- | --- | --- |
| Nov 14 | `pipewire pipewire-pulse pipewire-alsa wireplumber libspa-0.2-bluetooth mpg123` | Bluetooth speaker sound | No speaker or storm sounds |
| Nov 22 | `gh` | Pi sessions opening PRs | Pi can push, not open PRs |
| Nov 23 | `adb android-tools-adb imagemagick webp` | Photo album sync, wall calendar control | Photo sync stops |
| Nov 25 | `ffmpeg` | Live photo clips | Clips show as stills |

Undo (sudo), one group at a time:

```
sudo apt remove ffmpeg && sudo apt autoremove
```

```
sudo apt remove adb android-tools-adb imagemagick webp && sudo apt autoremove
```

```
gh auth logout; sudo apt remove gh && sudo apt autoremove
```

```
sudo apt remove pipewire pipewire-pulse pipewire-alsa wireplumber libspa-0.2-bluetooth mpg123 && sudo apt autoremove
```

## Timers and shortcuts (no sudo)

### Auto-pull (Nov 23)

```
cd ~/code/tizen-takeover && pi/autopull/install.sh --run
```

Pulls `main` every 5 minutes and restarts the hub, then the budget, when `pi/` changed.

Pause, resume:

```
hubauto off
```

```
hubauto on
```

Remove:

```
cd ~/code/tizen-takeover && pi/autopull/install.sh --remove
```

### Weekly health report (Nov 19)

```
cd ~/code/tizen-takeover && pi/health/install.sh --run
```

Undo:

```
cd ~/code/tizen-takeover && pi/health/install.sh --remove
```

### Photo sync timer (Nov 23)

Copies the wall calendar's album every 30 minutes. Undo:

```
systemctl --user disable --now photos-sync.timer && rm ~/.config/systemd/user/photos-sync.service ~/.config/systemd/user/photos-sync.timer && systemctl --user daemon-reload
```

### Photo folder ownership (Nov 23, run by Ian)

```
cd ~/code/tizen-takeover/pi && sudo mkdir -p data/photos && sudo chown -R $(id -un): data/photos
```

Lets photo sync write there (the rest of `pi/data` belongs to root). Undo (sudo; photo sync then fails):

```
sudo chown -R root: ~/code/tizen-takeover/pi/data/photos
```

### Shell shortcuts `hubup`, `hubstat`, `hubauto` (Nov 20, run by Ian)

```
echo '[ -f ~/code/tizen-takeover/pi/aliases.sh ] && . ~/code/tizen-takeover/pi/aliases.sh' >> ~/.bashrc
```

Undo (new terminals lose the shortcuts):

```
sed -i '\#tizen-takeover/pi/aliases.sh#d' ~/.bashrc
```

### Alexa bridge and cookbook services off (Nov 23)

Archive: `~/backups/alexa-services-2026-11-23.tar.gz`. Undo:

```
systemctl --user enable --now alexa-bridge cookbook
```

A full return also needs the Home Assistant and Cloudflare parts below.

## Network

### Phone address for the hub, port 10443 (Nov 20, run by Ian)

```
tailscale serve --bg --https=10443 http://127.0.0.1:8097
```

Undo (the phone app stops loading; may need sudo):

```
tailscale serve --https=10443 off
```

Never `tailscale serve reset`: it wipes the dashboard and the other ports too.

### Cloudflare tunnel: Alexa route removed (Nov 23)

Backup: `~/backups/cloudflared-config.yml.2026-11-23.bak`. Undo: copy the Alexa route lines from the backup into the live cloudflared config and restart cloudflared. Ask the Pi thread to do it; the live file's path is not recorded here.

## Keys (never printed)

### Gemini translate key (Nov 19 to 21, run by Ian)

Adds `HUB_TRANSLATE_KEY` to `pi/.env`. Undo (Spanish translating turns off):

```
cd ~/code/tizen-takeover/pi && sed -i '/^HUB_TRANSLATE_KEY=/d' .env && docker compose up -d --force-recreate hub
```

### Google Calendar key (Nov 23, run by Ian)

```
cd ~/code/tizen-takeover/pi && sudo tee data/google-calendar-key.json >/dev/null
```

Lets the hub delete ticked `TODO:` events. Undo (sudo; then also delete the key in Google Cloud):

```
cd ~/code/tizen-takeover/pi && sudo rm data/google-calendar-key.json && docker compose restart hub
```

## Bluetooth speaker

Sony speaker paired on the USB adapter (Nov 20). Undo:

```
bluetoothctl devices
```

```
bluetoothctl remove <address from the list>
```

The rfkill block cleared that day needs no undo.

## Wall calendar (Dragon Touch, over adb from the Pi)

### Fully Kiosk installed (Nov 23)

Undo:

```
adb -s 192.168.1.208:5555 uninstall de.ozerov.fully
```

### Setup marked finished (Nov 23)

```
adb -s 192.168.1.208:5555 shell settings put global device_provisioned 1
adb -s 192.168.1.208:5555 shell settings put secure user_setup_complete 1
```

Stops Fully offering to manage the device. Undo:

```
adb -s 192.168.1.208:5555 shell settings put global device_provisioned 0 && adb -s 192.168.1.208:5555 shell settings put secure user_setup_complete 0
```

### Pi allowed to debug the calendar

Key in `~/.android/adbkey`. Undo: on the calendar, Developer options, "Revoke USB debugging authorizations". Photo sync then stops until you tap Allow again.

## Home Assistant

- **TV Power (Nov 20) and Xbox Power (Nov 24) switches.** Undo: Settings, Devices and services, Helpers, delete the switch.
- **SmartThings integration added.** Undo: Settings, Devices and services, SmartThings, Delete.
- **Recipe view, cookbook sensor and Alexa intents removed (Nov 23).** Backup: `~/backups/configuration.yaml.2026-11-23.bak`. Undo: copy those sections back from the backup, then restart Home Assistant. Do not copy the whole file over; it would drop later changes.

## Budget data (no code, no sudo unless noted)

### Merchants left out of daily spending

Rent, car payment, utilities and subscriptions (11 merchants). Put one back:

```
cd ~/code/budget && python3 everyday.py count --merchant "Name"
```

### Daily goal history backdated to Nov 22 (Nov 24)

Backup: `pi/data/budget-goal.json.bak-2026-11-24`. Undo (sudo; resets the streak to what it was):

```
cd ~/code/tizen-takeover/pi && sudo cp data/budget-goal.json.bak-2026-11-24 data/budget-goal.json && docker compose restart hub
```

## Not changed

No crontab, no edits under `/etc` (sudoers, udev, Bluetooth, PipeWire). Linger was already on. The hub and Home Assistant containers were already on Central time.
