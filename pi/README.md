# Home Hub live server (the Raspberry Pi part)

## What this is

This folder is a small server that runs on your Raspberry Pi and keeps the data Home Hub shows, such as your to-do list. The TV keeps one open line to it, so when you (or Claude) change something, the TV updates straight away. If the TV is off or the Pi is down, nothing breaks: the TV keeps working from what it saved last time.

A few words used below:

- **Terminal**: the window where you type commands on the Pi (over SSH or with a keyboard and screen).
- **Docker**: a tool that runs programs in a sealed box, so you do not have to install Node yourself.
- **Token**: a long random password. Commands to the server need it. It lives in a file called `.env` in this folder.
- **Port**: a numbered door on the Pi. This server uses door `8097`.

## Install with Docker

You need Docker with the Compose plugin on the Pi. If `docker compose version` prints a version number, you have it.

1. Get the code. The first time:

   ```sh
   git clone https://github.com/irosen419/tizen-takeover.git
   ```

   If you already have it, go into it and fetch the latest version instead:

   ```sh
   cd tizen-takeover && git pull && cd ..
   ```

   You should see a list of files being downloaded, or `Already up to date.`

2. Go into this folder:

   ```sh
   cd tizen-takeover/pi
   ```

3. Create the token (only once):

   ```sh
   ./hub token
   ```

   You should see `Token created and saved in pi/.env.` If the Pi has no Node, this runs inside Docker for you; the first time it downloads the Node image, which takes a minute. The same thing by hand is:

   ```sh
   docker compose run --rm --no-deps --user "$(id -u):$(id -g)" hub node hubctl.js token
   ```

4. Start the server:

   ```sh
   docker compose up -d
   ```

   You should see `Container pi-hub-1  Started` (the name can differ slightly). It now starts by itself after every reboot.

5. Check it:

   ```sh
   ./hub status
   ```

   You should see `The server is running (version 0.1.0, ...)` and `No screen is connected right now.` until the TV connects.

## Try it

Turn the TV on with Home Hub open (it needs to know the Pi's address; that is set on the hub side). Then:

1. `./hub say "Hello from the Pi"`: the message appears at the bottom of the TV. The terminal says `Sent. 1 screen showed it.`
2. `./hub show weather`: the weather opens. Add `--full` for full screen. `./hub home` closes it.
3. `./hub todo add "Buy milk"`: the item appears on the TV's to-do list. The terminal says `Added "Buy milk" to Now.`

If the TV is off you will see `Sent, but no screen is listening`. That is normal: commands are only for a screen that is on right now. To-dos are kept and show up when the TV turns on.

Run `./hub help` for every command.

## Run without Docker

If you prefer, install Node 14 or newer (`node --version` shows yours) and run it directly:

1. `cd tizen-takeover/pi`
2. `./hub token`
3. `node server.js`

You should see `Home Hub live server 0.1.0 listening on port 8097`. It stops when you close the terminal or press Ctrl+C.

To keep it running and start it at boot, use **systemd** (the Pi's built-in service manager). Create the file with `sudo nano /etc/systemd/system/home-hub.service` and paste this, changing `pi` and the path to your user name and folder:

```ini
[Unit]
Description=Home Hub live server
After=network-online.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/tizen-takeover/pi
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now home-hub
systemctl status home-hub
```

The last command should say `active (running)`.

## Updating

1. `cd tizen-takeover && git pull && cd pi`
2. With Docker: `docker compose restart hub`. With systemd: `sudo systemctl restart home-hub`.
3. `./hub status` should show the new version.

Your `.env` and your data are not touched by an update.

## Turning it off

- With Docker: `docker compose down` (from this folder). It stays off until you run `docker compose up -d` again.
- With systemd: `sudo systemctl disable --now home-hub`.

The TV carries on as normal without it.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `could not listen on port 8097: that port is already in use` in the log | Something else uses door 8097 | Put `HUB_PORT=8098` (or another free number) in `.env`, restart, and tell the hub the new port |
| The TV's clock tile says `Live: the Pi refused this TV` | The TV's address is not allowed | Check `HUB_TV_IPS` in `.env`. Empty allows any home device. Run `./hub status` while the TV tries, and check the log for its address |
| `Sent, but no screen is listening` | No TV is connected right now | Turn the TV on with Home Hub open. `./hub status` lists connected screens |
| `The server is not running on this Pi (nothing answered on port 8097).` | The server is stopped | `docker compose up -d`, then look at the log |
| `The server rejected the token in pi/.env.` | The running server has a different token | Restart the server so it reads `.env` again: `docker compose restart hub` |
| `The server has no token yet.` | `.env` had no token when the server started | `./hub token`, then `docker compose restart hub` |
| You want to see what it is doing | | Docker: `docker compose logs -f hub` (Ctrl+C to stop watching). systemd: `journalctl -u home-hub -f` |

## Optional: only allow the TV

By default any device on your home network may read the to-do list and edit it from the screen side. To allow only the TV:

1. Find the TV's address in your router, or in the server log when the TV connects (`screen connected (live line) 192.168.1.x`).
2. In `.env` set `HUB_TV_IPS=192.168.1.x` (the real number). Several addresses are separated by commas.
3. `docker compose restart hub`.

The Pi itself is always allowed. Sending commands still needs the token either way.

## Optional: the tunnel side door

This is not needed to start. A **tunnel** (for example Cloudflare Tunnel or Tailscale Funnel) gives Claude in the cloud a web address that leads to your Pi.

The server can open a second door only for that: set `HUB_TUNNEL_PORT=8098` in `.env` and restart. That door:

- listens on the Pi itself only (`127.0.0.1`), so nothing on your network can use it directly;
- accepts only token-protected commands and `/health`; it never shows your lists to a screen.

Point the tunnel at `http://127.0.0.1:8098` and nothing else. Never point a tunnel at the main door (8097).

## Where your data lives, and backups

Everything is in `data/state.json` in this folder. It is rewritten safely on each change. If it ever gets damaged, the server moves it aside as `data/state.bad-<time>.json` and starts an empty list instead of failing.

To back up, copy that file somewhere safe:

```sh
cp data/state.json ~/home-hub-backup-$(date +%F).json
```

To restore, stop the server, copy the file back to `data/state.json`, and start it again.

## Security notes

- The token is the key to sending commands. It lives only in `pi/.env` on the Pi.
- Never put the token in git, in a chat, or in a screenshot. `.env` is listed in `.gitignore` so git skips it.
- `./hub` never prints the token, and the server never logs it.
- If you think it leaked, delete the `HUB_TOKEN=` line from `.env`, run `./hub token`, and restart the server.
