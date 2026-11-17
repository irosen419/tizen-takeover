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

   You should see `The server is running (version 0.5.0, ...)` and `No screen is connected right now.` until the TV connects.

## Try it

Turn the TV on with Home Hub open (it needs to know the Pi's address; that is set on the hub side). Then:

1. `./hub say "Hello from the Pi"`: the message appears at the bottom of the TV. The terminal says `Sent. 1 screen showed it.`
2. `./hub show weather`: the weather opens. Add `--full` for full screen. `./hub home` closes it.
3. `./hub todo add "Buy milk"`: the item appears on the TV's to-do list. The terminal says `Added "Buy milk" to Now.`

If the TV is off you will see `Sent, but no screen is listening`. That is normal: commands are only for a screen that is on right now. To-dos are kept and show up when the TV turns on.

Run `./hub help` for every command.

### To-do notes

A to-do can carry notes, plain text up to 300 characters. The TV shows them under the title, in smaller gray text, and shows nothing extra for an item without notes.

- `./hub todo add "Buy milk" --notes "Oat, not dairy"` adds an item with notes. The terminal says `Added "Buy milk" to Now, with notes.`
- `./hub todo notes "Buy milk" "Oat, not dairy"` sets or changes the notes of an item (by id or exact title); `./hub todo notes "Buy milk" --clear` removes them.
- `./hub todo list` prints each item's notes on the line under it.

This needs server 0.3.0. After pulling it: `git pull`, then `docker compose restart hub` (or `sudo systemctl restart home-hub`); `./hub status` should say `version 0.3.0`. Nothing changes in `.env`, and the TV needs nothing: it picks up its part by itself. An older server keeps notes it is sent through `todo/ops` but ignores `--notes` on `todo add`.

## Tile layout

Where each tile sits on the home screen can be changed from the Pi, without editing `app/config.js`:

- `./hub layout show` lists the tiles, or says the TV uses its built-in layout.
- `./hub layout set layout.json` sends a new layout. The file holds a list of tiles, or `{ "layout": [ ... ] }`. With Docker the file must be in this folder; `./hub layout set - < layout.json` reads it from input instead.
- `./hub layout reset` goes back to the layout in `app/config.js`.

A tile is `{ "widget": "weather", "x": 0, "y": 0, "w": 3, "h": 2 }` on a grid 12 wide and 6 high: whole numbers, inside the grid, no two tiles overlapping, each widget once, at most 24 tiles. The server refuses anything else and says why. A TV that is on moves its tiles at once (if the set of widgets changed it reloads once). It waits while a panel is open. The TV keeps the last layout, so it starts with it even when the Pi is away.

## A World Worth Saving snapshot

The A World Worth Saving tiles on the TV (to-dos, handoffs, outreach and the rest) show one small file of figures, called the **snapshot**. A scheduled Claude routine builds it from places only a signed-in Claude can read and sends it to the Pi through the Claude mailbox (below), usually every half hour. The Pi checks it, keeps it in `data/state.json` and passes it to the TV. School visits and other dates still come from the calendars, not from the snapshot.

The full description of the file, field by field, is in [`docs/awws-snapshot.md`](../docs/awws-snapshot.md). A made-up example is `fixtures/awws-sample.json` in this folder.

- `./hub awws show` says when the snapshot was sent, how big it is (at most 48 KB), and one line per part, such as `khaya     11 of 12 done, as of 9:00 AM`. Before any snapshot it says `No A World Worth Saving snapshot yet.`
- `./hub awws set snapshot.json` stores a snapshot from a file. With Docker the file must be in this folder; `./hub awws set - < snapshot.json` reads it from input instead.
- `./hub awws clear` removes it. The tiles then say "Not synced yet".

The Pi checks each part (it calls them sections) on its own. A section that breaks a rule is refused by name and the Pi keeps its last good copy; the other sections are still stored. The snapshot must never hold email addresses or links, and the Pi refuses a section that does. It must not hold notes or librarians' last names either; the Pi cannot tell those apart from other words, so the sender has to leave them out. You said yes to money figures on the TV on 2026-11-16, so the money section may be sent; to keep money off the TV (for guests, say), set `showMoney: false` under `widgets.awws` in `app/config.js`.

### After pulling this change

This adds one new file, `awws.js`, next to `server.js`. Docker uses this folder as it is (it is mounted into the container, and nothing is built), so a restart is enough. No rebuild, and no change to `.env`:

1. `cd tizen-takeover && git pull && cd pi`
2. With Docker: `docker compose restart hub`. With systemd: `sudo systemctl restart home-hub`.
3. `./hub status` should say `version 0.2.0` (or newer), and `./hub awws show` should say `No A World Worth Saving snapshot yet.` If it says `The server said no: no such call.` instead, the server is still running the old code: do step 2 again.

From the cloud, a mailbox `ping` answers `Home Hub live server 0.2.0 is running.` (or a newer version) once this is in place.

## Budget snapshot

The budget tiles on the TV (Daily room, Card day, Goals, Budget lab) and the "New charge" banner show one small file of totals, the **budget snapshot**. Your budget app, running on this Pi, works the figures out and sends them to the hub server here with the token (`POST http://127.0.0.1:8097/api/budget`); they never go through the cloud. Only totals: the room per day, the card day and how it is covered, goal states, and the names of merchants with a new charge. Never a balance, and never an amount on an alert.

The full description, field by field, with a `curl` example, is in [`docs/budget-snapshot.md`](../docs/budget-snapshot.md). A made-up example is `fixtures/budget-sample.json` in this folder.

- `./hub budget show` says when it was sent, its size, and one line per section with dates, counts and states only (never a label or an amount), such as `cardDay  2026-11-19 (in 3 days), covered, 3 transfers, 2 paychecks, as of 9:05 AM`. Before any snapshot it says `No budget snapshot yet.`
- `./hub budget set budget.json` stores one by hand (`-` reads it from input).
- `./hub budget clear` removes it. The tiles then say "Waiting for the budget app".

Each section is checked on its own, with the same rules as the A World Worth Saving snapshot: no email addresses or links, unknown fields dropped, at most 48 KB. To hide the budget on the TV (for guests, say), set `show: false` under `widgets.budget` in `app/config.js`.

### After pulling this change

It adds `budget.js` next to `server.js` and makes the server version 0.4.0. A restart is enough, with no rebuild and no change to `.env`:

1. `cd tizen-takeover && git pull && cd pi`
2. With Docker: `docker compose restart hub`. With systemd: `sudo systemctl restart home-hub`.
3. `./hub status` should say `version 0.4.0` or later, and `./hub budget show` should say `No budget snapshot yet.` If it says `The server said no: no such call.`, the server is still running the old code: do step 2 again.

### Budget lab sections (server 0.5.0)

Server 0.5.0 also keeps four more optional sections for the Budget lab tile: `lab` (the room to card day), `merchants` (the top 5 merchants this month, with their month-to-date totals), `pace` (one spending total and the morning's cap per day) and `runway` (headroom from today to card day, never a balance). An older server drops them and keeps the rest, so the budget app may send them first. `./hub budget show` prints counts and dates for them, never a merchant name or an amount. After pulling: `docker compose restart hub` (or `sudo systemctl restart home-hub`); `./hub status` should say `version 0.5.0`.

## Calendars

The Pi can read your Google calendars and send the coming events to the TV. Each calendar has a private link, called the **secret address**. The Pi reads that link every few minutes. Nobody needs to sign in to Google on the Pi.

The secret address is like a key: anyone who has it can read that calendar. Keep it only in `.env` on the Pi. Never put it in git, a chat, an email or a screenshot.

### Set up a calendar

1. On a computer (not the phone app), open [Google Calendar](https://calendar.google.com).
2. Click the gear at the top right, then **Settings**.
3. On the left, under **Settings for my calendars**, click the calendar you want on the TV.
4. Scroll down to **Integrate calendar**.
5. Find **Secret address in iCal format** and click the copy button next to it. It starts with `https://calendar.google.com/calendar/ical/` and ends with `basic.ics`.
6. On the Pi, go to this folder and open the settings file:

   ```sh
   cd tizen-takeover/pi
   nano .env
   ```

7. Find the `CALENDAR_` lines near the bottom. For your first calendar, make two lines like these (no `#` at the start), and paste your link after `CALENDAR_1_URL=`:

   ```
   CALENDAR_1_NAME=Ian
   CALENDAR_1_URL=https://calendar.google.com/calendar/ical/.../basic.ics
   ```

   The name is what you will see in `./hub calendar status`. A second calendar uses `CALENDAR_2_NAME` and `CALENDAR_2_URL`, and so on up to 9.

   If your `.env` has no `CALENDAR_` lines (it was made before calendars existed), just type them at the end.

8. Save and close: press Ctrl+O, then Enter, then Ctrl+X.
9. Restart the server so it reads the new settings:

   ```sh
   docker compose restart hub
   ```

10. Check it:

    ```sh
    ./hub calendar status
    ```

    You should see one line per calendar, such as `Ian: 42 events, read at 7:10 AM`, and then the next event, such as `Next: Thursday 9:00 AM, Dentist`. If it says `No calendars are set up yet`, check that the two lines in `.env` have no `#` in front.

The TV shows events from yesterday up to 60 days ahead.

### Show a calendar as just "Busy"

For a calendar whose details should stay private (work, for example), add a third line:

```
CALENDAR_2_DETAILS=busy
```

The TV then shows each event as `Busy`, with its time but no title and no place. Restart the server after the change, as in step 9.

### Choose a calendar's color

The secret address does not carry Google's colors, so the TV gives each calendar a color by its number (1 to 9). To match Google, or just to pick your own, add a line per calendar:

```
CALENDAR_3_COLOR=red
```

Use `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink` or `gray`, or a code like `#d50000`. These names are tuned to be readable on the TV. A color the server does not understand is logged by calendar name and the default is used. Restart the server after the change, as in step 9.

### New events and waiting

Google can take a while to put a new or changed event into the secret address. We have not confirmed how long. The Pi reads every 5 minutes (change it with `CALENDAR_REFRESH_MINUTES` in `.env`).

To read all calendars right now:

```sh
./hub calendar refresh
```

You should see something like `Refreshed. 3 calendars, 57 events (changed).` This reads at once, but it cannot make Google update its side sooner. If a new event is not there yet, try again in a few minutes.

### If a secret address leaks

1. Go back to the same Google screen (gear, **Settings**, click the calendar, **Integrate calendar**).
2. Next to **Secret address in iCal format**, click **Reset**. The old link stops working.
3. Copy the new link and paste it into `.env` in place of the old one (steps 6 to 9 above).

### Holidays and other public calendars

A public calendar, such as a Holidays calendar, has a normal public address and does not need the secret one. On its **Integrate calendar** screen, use **Public address in iCal format** instead, in the same `CALENDAR_` lines.

### If a calendar cannot be read

`./hub calendar status` says what went wrong in plain words, for example `Health: could not be read (HTTP 404), showing the 12 events from 6:55 AM`. The TV keeps showing the last events it had for up to a day.

- `could not be read (HTTP 404)`: the link is wrong or was reset. Copy it again from Google.
- `did not look like a calendar`: the link leads to a web page, not a calendar. Make sure you copied the **iCal** address.
- `timed out` or `could not be reached`: the Pi could not reach Google. Check its internet connection; it tries again by itself.

The server never writes a calendar link in its log, so `docker compose logs hub` is safe to show.

## Spotify (Now Playing)

The Now Playing tile shows what is playing on your Spotify. The Pi asks Spotify every few seconds (every 5 s while the TV is on and something plays, every 10 s when nothing does, once a minute when no TV is on) and sends the song to the TV. The TV never sees your Spotify secret or sign-in.

Spotify asks for two things, once: a **redirect address** added to your Spotify app, and **your OK** (signing in). Both are below. The app's **client ID** and **client secret** are already in `.env` (`SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`).

**Check first:** `./hub spotify status` should say `Spotify is set up but not signed in.` If it says `not set up yet`, a line in `.env` is missing or has a typo (it names which one); fix it, then `docker compose restart hub`.

### Step 1: add the redirect address to your Spotify app (once)

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and click your app.
2. Click **Settings**.
3. Under **Redirect URIs**, type exactly this and click **Add**, then **Save** at the bottom:

   ```
   http://127.0.0.1:8097/spotify/callback
   ```

   (If you changed `HUB_PORT` in `.env`, use that number instead of 8097.) Spotify only accepts `127.0.0.1` here, never the Pi's own address or `localhost`; that is why step 2 has a paste.
4. The app must list the **Web API** under "APIs used". It does if you ticked it when you made the app. The Spotify account that owns the app must be Premium, and you must be the account you sign in with in step 2.

### Step 2: sign in (once, about a minute)

On the Pi, in `tizen-takeover/pi` after `git pull` and `docker compose restart hub`:

```sh
./hub spotify login
```

It prints a long link and waits.

1. Open the link on a **laptop or computer** (a phone browser may hide the address). Sign in to Spotify if it asks, then click **Agree**.
2. The browser then goes to an address that starts with `http://127.0.0.1:8097/spotify/callback?code=` and shows an **error page** ("can't be reached", or "refused to connect"). That is expected: it is the laptop's own 127.0.0.1, not the Pi.
3. Click the address bar, select the **whole address** and copy it.
4. Back in the Pi's terminal, paste it where it says `Paste the address here`, and press Enter.

You should see `Spotify is connected (signed in as <your name>). The TV shows what is playing within a few seconds.` Play something on Spotify and watch the tile.

If you cannot paste into the terminal (or it just returns to the prompt), run it in one line instead, keeping the quotes:

```sh
./hub spotify code "http://127.0.0.1:8097/spotify/callback?code=...&state=..."
```

**Or let Claude do the paste:** tell Claude "run Spotify login", open the link it gives you, click Agree, and paste the address of the error page into the chat. Claude sends it to the Pi through the mailbox below (`spotify.login`, then `spotify.code`). The one-time code in that address works once, for a few minutes, and only with the secret that stays on the Pi, so it is safe to paste.

The sign-in link works for 15 minutes. After that, or after a restart of the server, run `./hub spotify login` again.

### What gets stored, and for how long

The sign-in is a long-lived key saved in `data/spotify.json` on the Pi (readable by you only, never in git, never sent to the TV, never in a log). It renews itself every hour. Spotify can end it: if you remove the app's access at [spotify.com/account/apps](https://www.spotify.com/account/apps), or after a long while, the tile says `Not connected yet` and `./hub spotify login` fixes it. `./hub spotify logout` forgets it on purpose. Changing the client secret in the dashboard means pasting the new one into `.env` and restarting.

### The song's vibe (for the visualizer)

In full screen, Now Playing has a classic-style visualizer that moves with the song (see "Now Playing" in the main README). For that, the Pi looks up each new song's **vibe** once: its tempo, energy, mood, danceability and acousticness.

1. It asks [ReccoBeats](https://reccobeats.com), a free service with no sign-up: `GET https://api.reccobeats.com/v1/audio-features?ids=<the song's Spotify ID>`.
2. If ReccoBeats doesn't know the song, it guesses from the first artist's genres, which it reads from Spotify with the sign-in it already has.
3. If neither works (a podcast, a home recording), the TV moves gently at 100 BPM.

The lookup runs on its own, one song at a time, so the tile never waits for it; the song shows at once and the visualizer picks up the vibe a moment later. Answers are kept in `data/vibes.json` (the last 500 songs), so a song played again is not asked about again; a song nobody knew is tried again after a day.

**Privacy:** ReccoBeats sees the Spotify IDs of the songs you play and the Pi's internet address, nothing else: no sign-in, no token, no name, no account. The TV never talks to ReccoBeats or Spotify itself. To stop it, add this line to `.env` and run `docker compose restart hub`:

```
SPOTIFY_VIBE=off
```

With it off, the Pi still guesses from Spotify's genres (no one new sees anything), and `./hub spotify status` says `Vibe lookups: off (SPOTIFY_VIBE=off).`

`./hub spotify status` (and the mailbox's `spotify.status`) ends with a **Vibe** line for the song playing, for example:

- `Vibe: features, 124 BPM, energy 0.78, mood 0.82.` (ReccoBeats knew it)
- `Vibe: from genres (indie pop, dream pop).` (a guess from the artist)
- `Vibe: looking it up.`, `Vibe: none yet.`, `Vibe: none (songs only, not podcasts).`
- and, when the last lookup failed, `Last lookup problem: ReccoBeats answered HTTP 500 (40 seconds ago).` It is retried after half an hour; nothing else is affected.

### Commands

- `./hub spotify status` says what is playing, and whether Spotify is reachable. Its last line is the song's vibe (above).
- `./hub spotify login`, `./hub spotify code "<address>"`, `./hub spotify logout` as above.
- `./hub show nowplaying` opens the page on the TV (add `--full` for full screen).

### If it says something else

| What you see | What it means | What to do |
|---|---|---|
| `Spotify is not set up yet` | `SPOTIFY_CLIENT_ID` or `SPOTIFY_CLIENT_SECRET` is missing, or has a typo | Add or fix both lines in `.env` (32 letters and digits each), then `docker compose restart hub` |
| Spotify's page says `INVALID_CLIENT: Invalid redirect URI` | Step 1 was not saved, or the address differs by one character | Check **Redirect URIs** in the dashboard against the address `./hub spotify login` shows (`redirect_uri=` in the link) |
| `Spotify says the request was declined` | You clicked Cancel | Run `./hub spotify login` again and choose **Agree** |
| `Spotify did not accept that code` | The code was used already, or is older than a few minutes | Run `./hub spotify login` again and use the new link |
| `That address belongs to an older sign-in link` | You opened an earlier link | Use the newest link from the last `./hub spotify login` |
| `Spotify did not accept the client ID or secret` | One of them is wrong in `.env` | Copy them again from the dashboard, restart |
| The tile says `Can't reach Spotify` (and `Spotify refused the request` in the log) | Spotify answered 403. In development mode only the app's owner and people added under **User Management** may use it | Add your Spotify email under the app's **User Management**, or make sure you signed in as the owner |
| Nothing on the tile while music plays | Spotify only reports playback from a signed-in Spotify app or device (not "private session" or some web players) | Turn private session off, and play from the phone or computer app. `./hub spotify status` says what the Pi sees |
| Pause or skip does not show for a few seconds | The Pi looks every 5 seconds | Normal |

Spotify's rules can limit how often the Pi may ask; if it asks for a pause the Pi waits as long as told and the log says so (`asked us to slow down`).

## All sounds (test widget)

The "All sounds" test widget on the TV (the "All sounds test" layout) shows what plays anywhere: the Echo speakers through Home Assistant, and Spotify (Spotify wins when both play). `allsounds.js` reads Home Assistant's REST API (`GET /api/states`, every 5 seconds while something plays, 20 seconds otherwise, backing off up to 2 minutes when it cannot get through) and keeps the `allsounds` resource; it changes nothing for Now Playing.

Setup (once):

1. In Home Assistant, the Alexa Media Player integration (HACS) must be installed and signed in, so each Echo is a `media_player` entity.
2. In Home Assistant, open your profile, the **Security** tab, and create a **long-lived access token**. Copy it.
3. Add it to `.env` as `HA_TOKEN=...` (see `.env.example`). `HA_URL` defaults to `http://127.0.0.1:8123`, Home Assistant on this Pi.
4. Set `ALLSOUNDS_ENTITIES` to your own speakers, for example `ALLSOUNDS_ENTITIES=media_player.ian_s_echo_show,media_player.ian_s_echo_dot`. Left out, the Pi watches every Alexa speaker Home Assistant knows (entities with `last_called` or `bluetooth_list`), and Alexa Media Player lists every Echo and Fire TV on the Amazon account, so someone else's (Stan's, say) could show on your TV. It never watches `media_player.everywhere` (a group that repeats the others), TVs, the Xbox or `browser_mod` panels.
5. `docker compose restart hub`, then `./hub allsounds status`.

What reaches the TV: the state, the app's name when Home Assistant gives one ("TuneIn"), the speaker's name, the title, artist and album, and a picture only when it is an absolute `https` address. Never the token or a Home Assistant address. The token is only ever sent to `HA_URL`.

What a real Echo Show sends (seen 2026-11-17), and what the TV shows:

- Amazon Music: the title, artist, album and picture, but no app name. The TV shows the song and the speaker, with no source chip.
- TuneIn: the station's name as the title (`KERA`) and a picture, no artist or album. The TV shows the station, then the speaker. In the first few seconds after it starts there is nothing at all; the TV then shows "Something is playing" and the speaker, with the music mark.
- NPR: reported as `idle`, so the TV says "Nothing playing".
- Audible (and other apps Alexa Media Player does not understand): it keeps showing the last song as playing. When that song has a length and should have ended over a minute ago, the TV adds a small "May be out of date" line under the title. Radio streams have no length and never get it; Spotify never does.

What reaches the log (fixed words only, never the token, an address, a title, a speaker's name or the app's name):

```
allsounds: off (no HA_TOKEN in .env)
allsounds: off (HA_TOKEN does not look like a Home Assistant token)
allsounds: off (HA_URL does not look right (it is like http://127.0.0.1:8123))
allsounds: off (ALLSOUNDS_ENTITIES must be media_player ids, separated by commas)
allsounds: off (ALLSOUNDS_ENTITIES lists more than 12)
allsounds: watching Home Assistant
allsounds: watching Home Assistant (2 listed speakers)
allsounds: playing from an Echo
allsounds: playing from Spotify
allsounds: paused
allsounds: nothing playing
allsounds: Home Assistant refused the token (401)
allsounds: Home Assistant could not be reached
allsounds: Home Assistant sent a reply that could not be read
allsounds: Home Assistant answered HTTP 500
allsounds: Home Assistant timed out
allsounds: Home Assistant working again
allsounds: unexpected problem
```

Commands: `./hub allsounds status` (state, source, speaker, title and artist), `./hub show allsounds` (the page on the TV). Tests: `node pi/allsounds-test.js` (against the pretend Home Assistant in `dev/mock-ha.js`).

| What you see | What it means | What to do |
|---|---|---|
| `All sounds: not set up` | No `HA_TOKEN` in `.env` | Steps 2 to 5 above |
| Someone else's Echo shows | `ALLSOUNDS_ENTITIES` is not set, so every Echo on the Amazon account is watched | Step 4 above |
| `Home Assistant refused the token` | The token is wrong or was deleted | Make a new one, put it in `.env`, restart |
| `Home Assistant cannot be reached` | `HA_URL` is wrong, or Home Assistant is down | Check Home Assistant opens at that address from the Pi |
| `nothing playing` while an Echo plays | Alexa Media Player has not caught up (it can lag 10 to 30 seconds), or the speaker is not listed in `ALLSOUNDS_ENTITIES` | Wait a moment; check the entity in Home Assistant |

## Run without Docker

If you prefer, install Node 14 or newer (`node --version` shows yours) and run it directly:

1. `cd tizen-takeover/pi`
2. `./hub token`
3. `node server.js`

You should see `Home Hub live server 0.5.0 listening on port 8097`. It stops when you close the terminal or press Ctrl+C.

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
| About this hub on the TV's Clock page says `Live: the Pi refused this TV` | The TV's address is not allowed | Check `HUB_TV_IPS` in `.env`. Empty allows any home device. Run `./hub status` while the TV tries, and check the log for its address |
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

## Claude mailbox

### What it is, and why

Claude runs in the cloud and cannot reach your Pi (that is good: nothing on the internet can). The mailbox is a way round that, with no open door on the Pi:

- You have a storage bucket on Cloudflare R2 called `home-hub-mailbox`. Think of it as a shared folder on the internet.
- Claude drops a small note in it, such as "add Buy milk to the to-do list".
- Every 10 seconds the Pi looks in the bucket, does what the note says, and leaves a reply note next to it.

The Pi only ever goes *out* to Cloudflare; nothing comes in. It can only do the things `./hub` does (show a widget, say a message, to-dos, calendar status and refresh, layout, the A World Worth Saving snapshot, status, and restart the server). It cannot run any other command, git or Docker. Notes older than a day, or that do not look exactly right, are refused and never run.

### One-time setup

You need the Cloudflare account where the `home-hub-mailbox` bucket was made.

1. On a computer, sign in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. On the left, click **R2 Object Storage**, then **Manage R2 API Tokens** (on the right of the R2 page; on some screens it is under **API**).
3. Click **Create API token** (pick the **Account API token** kind if it asks).
4. Give it a name such as `home-hub-pi`. Under **Permissions**, choose **Object Read & Write**.
5. Under **Specify bucket(s)**, choose **Apply to specific buckets only** and pick `home-hub-mailbox`. Leave the rest as it is and click **Create API Token**.
6. The next page shows three things you need. Copy each one now (the secret is shown only once):
   - **Access Key ID**
   - **Secret Access Key**
   - the S3 endpoint, under **Use jurisdiction-specific endpoints for S3 clients**, which looks like `https://<a long number>.r2.cloudflarestorage.com`

   Keep this page open until step 9. The Access Key ID and Secret Access Key are passwords: never put them in git, a chat, an email or a screenshot.
7. On the Pi, open the settings file:

   ```sh
   cd ~/code/tizen-takeover/pi
   nano .env
   ```

8. Go to the end of the file and type these three lines, pasting your own values after each `=` (no spaces, no quotes):

   ```
   HUB_MAILBOX_ENDPOINT=https://...r2.cloudflarestorage.com
   HUB_MAILBOX_ACCESS_KEY_ID=...
   HUB_MAILBOX_SECRET_ACCESS_KEY=...
   ```

   If the endpoint you copied ends with `/home-hub-mailbox`, that is fine too.
9. Save and close: press Ctrl+O, then Enter, then Ctrl+X.
10. Get the new code and restart the server:

    ```sh
    git pull
    docker compose restart hub
    ```

11. Wait about 15 seconds, then check it:

    ```sh
    ./hub mailbox status
    ```

    You should see `Claude mailbox: connected, checked 5 seconds ago.` and `Bucket home-hub-mailbox at ...`. `./hub status` also has a `Claude mailbox:` line.

This is Pi-only: the TV app does not change, and nothing on jsDelivr needs refreshing.

### If it says something else

| What you see | What it means | What to do |
|---|---|---|
| `The Claude mailbox is off.` | The three lines are not in `.env`, or have a `#` in front | Check step 8, then `docker compose restart hub` |
| `The Claude mailbox is off: HUB_MAILBOX_... missing in pi/.env` | One of the three lines is missing or empty | Add it, then restart |
| `NOT connected (R2 answered HTTP 403 SignatureDoesNotMatch)` | The secret key is wrong (often a missing character) | Paste it again, or make a new token, then restart |
| `NOT connected (R2 answered HTTP 403 AccessDenied)` or `InvalidAccessKeyId` | The token is wrong, deleted, or not allowed on this bucket | Make a new token for `home-hub-mailbox` (steps 2 to 6) |
| `NOT connected (R2 answered HTTP 404 NoSuchBucket)` | The endpoint is for another account, or the bucket has a different name | Copy the endpoint again |
| `NOT connected (network problem ...)` or `cannot find ...` | The Pi cannot reach the internet right now | It keeps trying by itself, at most once a minute |
| `This server does not know the Claude mailbox yet.` | The server is still running the old code | `git pull`, then `docker compose restart hub` |

The log (`docker compose logs hub`) says when the mailbox connects, when it first loses the connection and when it is back; it never shows the keys.

### If a key leaks

In the Cloudflare dashboard, go back to **R2 Object Storage**, **Manage R2 API Tokens**, and delete that token. The old keys stop working at once. Then make a new one (steps 3 to 6) and put the new values in `.env` (steps 7 to 10).

### Cost

At one look every 10 seconds the Pi makes about 8,600 list calls a day (about 260,000 a month), plus one small status write a minute (about 43,000 a month). R2's free tier includes 1 million such calls a month, and the notes are tiny, so this stays free. Setting `HUB_MAILBOX_POLL_SECONDS=30` in `.env` cuts it to a third; Claude's commands then take up to 30 seconds to happen.

### How it works (for builders)

- Claude writes `inbox/<id>.json`: `{"id": "<id>", "created": "<ISO time>", "cmd": "<name>", "args": {...}}`. The id is 6 to 64 letters, digits, `_` or `-` and must match the file name; `created` must be within the last 24 hours and at most 5 minutes ahead; the file must be under 64 KB; only `id`, `created`, `cmd` and `args` are allowed.
- Commands: `show {widget, full?}`, `home`, `say {text, seconds?}`, `reload`, `todo.add {title, section?, due?}`, `todo.list`, `todo.done {id or title}`, `todo.remove {id or title}`, `calendar.status`, `calendar.refresh`, `layout.show`, `layout.set {layout: [...]}`, `layout.reset`, `awws.show`, `awws.set {snapshot: {...} or null}`, `awws.clear`, `budget.show`, `budget.set {snapshot: {...} or null}`, `budget.clear`, `status`, `ping`, `restart`. They go through the same control API, and the same checks, as `./hub`.
- The Pi writes `outbox/<id>.json`: `{id, cmd, ok, state, message, data, started, finished}`. `message` is the same text `./hub` prints (several lines for lists). First it writes `state: "running"` as a claim, then the final result with `state: "done"`; a command with an outbox file is never run again, even after a crash. Then it deletes the inbox file.
- At most 20 commands per look, oldest `created` first, one at a time.
- `status.json` is rewritten every minute and after each command: version, uptime, how many screens are listening, the mailbox's last command and last error, and a calendar summary (counts only).
- About once an hour, results older than 7 days and leftover inbox files older than 24 hours are deleted.
- `restart` writes its result, then stops the server; Docker (`restart: unless-stopped`) starts it again with whatever code is on the Pi. It does not run `git pull`. Without Docker or systemd the server just stops.
- Settings: `HUB_MAILBOX_ENDPOINT`, `HUB_MAILBOX_BUCKET` (default `home-hub-mailbox`), `HUB_MAILBOX_ACCESS_KEY_ID`, `HUB_MAILBOX_SECRET_ACCESS_KEY`, `HUB_MAILBOX_POLL_SECONDS` (default 10, at least 3). The code is `mailbox.js`; tests are `node pi/mailbox-test.js`.

### How Claude sends a command

Claude uses the Cloudflare REST API through its own connection (no R2 keys needed on that side; the account id below is not a secret). The full steps for Claude are in `pi/CLAUDE.md`. In short:

```sh
B=https://api.cloudflare.com/client/v4/accounts/f24d1741cf57727291b631def49ffacb/r2/buckets/home-hub-mailbox/objects
curl -sS -X PUT "$B/inbox%2F<id>.json" -H 'content-type: application/json' --data @cmd.json   # send
curl -sS "$B/outbox%2F<id>.json"                                                              # the reply
curl -sS "$B/status.json"                                                                     # is the Pi alive
curl -sS "$B?prefix=outbox/"                                                                  # list replies
```

## Where your data lives, and backups

Everything is in `data/state.json` in this folder (the to-do list, the tile layout, the A World Worth Saving snapshot, and the latest calendar events; never the calendar links). It is rewritten safely on each change. If it ever gets damaged, the server moves it aside as `data/state.bad-<time>.json` and starts an empty list instead of failing.

To back up, copy that file somewhere safe:

```sh
cp data/state.json ~/home-hub-backup-$(date +%F).json
```

To restore, stop the server, copy the file back to `data/state.json`, and start it again.

## Security notes

- The token is the key to sending commands. It lives only in `pi/.env` on the Pi.
- Never put the token in git, in a chat, or in a screenshot. `.env` is listed in `.gitignore` so git skips it.
- `./hub` never prints the token, and the server never logs it.
- The calendar secret addresses are also only in `.env`. The server never logs them or shows them in any answer.
- The Claude mailbox keys (`HUB_MAILBOX_ACCESS_KEY_ID`, `HUB_MAILBOX_SECRET_ACCESS_KEY`) are only in `.env` too, and are never logged or written to the bucket. If one leaks, delete the token in Cloudflare ("If a key leaks" above).
- If you think it leaked, delete the `HUB_TOKEN=` line from `.env`, run `./hub token`, and restart the server.
