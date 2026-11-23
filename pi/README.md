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

   You should see `The server is running (version 0.25.0, ...)` and `No screen is connected right now.` until the TV connects.

## Try it

Turn the TV on with Home Hub open (it needs to know the Pi's address; that is set on the hub side). Then:

1. `./hub say "Hello from the Pi"`: the message appears at the bottom of the TV. The terminal says `Sent. 1 screen showed it.`
2. `./hub show weather`: the weather opens. Add `--full` for full screen. `./hub home` closes it.
3. `./hub todo add "Buy milk"`: the item appears on the TV's to-do list. The terminal says `Added "Buy milk" to If you can.`

If the TV is off you will see `Sent, but no screen is listening`. That is normal: commands are only for a screen that is on right now. To-dos are kept and show up when the TV turns on.

Run `./hub help` for every command.

## Sound on the TV

From server 0.21.0 and hub v0.37.0 the TV can play audio:

- `./hub play https://example.com/doorbell.mp3 --title "Doorbell"`: the TV plays it and shows `Playing: Doorbell`. Any http or https audio address the TV's browser can play (MP3 is safest). A new `play` replaces what was playing.
- `./hub stop`: stops it.
- `./hub news`: plays the newest **NPR News Now** newscast, NPR's five minute summary that is posted every hour. The Pi reads NPR's public feed (`https://feeds.npr.org/500005/podcast.xml`, no account or key), picks the newest episode by date, follows NPR's tracking redirects (prfx.byspotify.com, podtrac) to the MP3 itself and sends that final address as `play` (if the redirects can't be followed in 8 s it sends the feed's address and the TV tries); the terminal says which one, for example `NPR News Now, 7pm ET, November 19. Sent. 1 screen showed it.` The code is `news.js`; tests are `node pi/news-test.js`.

The hub has to be open (`./hub status` shows the screen). The TV's browser may refuse to start sound that no key press asked for. To get ahead of that, the first key press after the hub loads plays a silent blip, which unlocks sound for later plays. If the TV still refuses, the hub shows "Press any button on the remote to start the sound", and the next key press within 10 minutes starts it (no need to send it again). Switching layouts loads the hub afresh; sound that was playing carries on from where it was (hub v0.38.5). The All sounds test widget shows what the TV itself plays first, with "Living room TV" as the speaker.

### To-do notes

A to-do can carry notes, plain text up to 300 characters. The TV shows them under the title, in smaller gray text, and shows nothing extra for an item without notes.

- `./hub todo add "Buy milk" --notes "Oat, not dairy"` adds an item with notes. The terminal says `Added "Buy milk" to If you can, with notes.`
- `./hub todo notes "Buy milk" "Oat, not dairy"` sets or changes the notes of an item (by id or exact title); `./hub todo notes "Buy milk" --clear` removes them.
- `./hub todo list` prints each item's notes on the line under it.

This needs server 0.3.0. After pulling it: `git pull`, then `docker compose restart hub` (or `sudo systemctl restart home-hub`); `./hub status` should say `version 0.3.0`. Nothing changes in `.env`, and the TV needs nothing: it picks up its part by itself. An older server keeps notes it is sent through `todo/ops` but ignores `--notes` on `todo add`.

## Phone and tablet app, and the grocery list (server 0.26.0)

The Pi also serves a touch app for phones, tablets and computers: open `http://<the Pi's address>:8097/` on the home Wi-Fi, or `http://<the Pi's Tailscale address or name>.ts.net:8097/` from anywhere on your tailnet. There is no login: being on the home network or the tailnet is the key. A small screen opens on a menu of every widget (the ones without a touch view say "TV only"), then one widget per view; a tablet or computer shows them side by side. `?as=phone`, `?as=tablet` or `?as=tv` picks the shape by hand.

The first touch widget is the grocery list. From the Pi or the mailbox:

- `./hub grocery add "Milk" "Eggs"` (one quoted name per item, up to 20 at a time; a name already on the list is not doubled)
- `./hub grocery list`, `./hub grocery done "Milk"`, `./hub grocery remove "Milk"` (id or name), `./hub grocery clear` (drops ticked items; a ticked item also goes by itself after 48 hours)
- Mailbox: `grocery.add {"items": ["Milk", "Eggs"]}`, `grocery.list`, `grocery.done {"name": "Milk"}` or `{"id": "..."}`, `grocery.remove` the same, `grocery.clear`

The log only counts changes; it never names an item. After pulling this change: `hubup` (it mounts `../app` read only into the container, so it needs `docker compose up -d`, not just a restart); `./hub status` should say `version 0.26.0`. Nothing changes in `.env`. Even when `HUB_TV_IPS` is set, the touch app and its two routes (`/touch/state`, `/grocery/ops`) answer any home or Tailscale address, and a phone is never counted as a screen.

### Scanning barcodes (the products catalog)

The grocery view has a **Scan** button: the phone's camera reads a product's barcode (EAN-13, UPC-A, UPC-E, EAN-8; the decoder is served by the Pi, nothing loads from another site), the Pi looks the code up and the item lands on the list as "Brand Name", with a small picture and the size under it. A torn label can be typed in instead.

The lookup is its own small service on the Pi (`products.js`), so a pantry or meal planner can use the same catalog later. Order: the Pi's own catalog (`data/products.json`, pictures in `data/products/`), then Open Food Facts, Open Products Facts and UPCitemdb's free tier (100 a day). Only the barcode number leaves the Pi, with a generic User-Agent; no account, no key. A hit is saved with its thumbnail (stored on the Pi, never linked), so the next scan of that product needs no internet. A code nobody knows is remembered for 24 hours (in memory) and opens a short form: brand, name, size and an optional photo of the pack. What you type is saved as a manual entry and always wins over web data. At most 5000 products; the oldest web ones make room. The log counts lookups and saves, never a code or a name.

For the camera the page must be opened over HTTPS. Tailscale gives the Pi a free certificate: once, in the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS Certificates, then on the Pi:

```sh
tailscale serve --bg 8097
```

Then open `https://<the Pi's machine name>.<your tailnet>.ts.net/` on the phone. Certificates renew by themselves. The machine name ends up in public certificate logs, so keep it generic (like `hub-pi`), never a person's name. Never use `tailscale funnel`: that would put the hub on the open internet. `tailscale serve status` shows it; `tailscale serve --https=443 off` stops it. The plain `http://` address keeps working for everything but the camera (the number box still works there).

For a shopping run (the export): `./hub grocery export` prints one search line per item to get ("Brand Name Size", or just the name), and the mailbox has `grocery.export`. The full list, with brand, name, size, code and a picture path per item, is `GET /api/grocery/export` (token). A lookup must come from the app's own page (a same-host Origin, `Sec-Fetch-Site: same-origin`, or the `X-Hub-Touch: 1` header the app sends), at most 10 web lookups a minute per phone, and ends within 20 seconds. Products on the grocery list are never dropped to make room. Routes: touch `GET /products/lookup?upc=<code>`, `POST /products/save`, `GET /products/image/<code>`; control `GET /api/products?upc=<code>`, `GET /api/products/image?upc=<code>`. After pulling this change: `hubup`, then `./hub status` should say `version 0.27.1`. Nothing changes in `.env`.

The TV has a grocery tile too (on the "Groceries test" layout). It reads the list over the live line like every other widget and posts its changes to the same `POST /grocery/ops`. Its page is on another origin, so that needs server 0.26.1 (it answers the browser's preflight): run `hubup` once, then `./hub status` should say `version 0.26.1`. With an older server the TV shows the list but a change says it didn't save and goes back. The log says `screen changed the grocery list` for the TV and `touch app changed the grocery list` for a phone, never an item's name.

## Tile layout

Where each tile sits on the home screen can be changed from the Pi, without editing `app/config.js`:

- `./hub layout show` lists the tiles, or says the TV uses its built-in layout.
- `./hub layout set layout.json` sends a new layout. The file holds a list of tiles, or `{ "layout": [ ... ] }`. With Docker the file must be in this folder; `./hub layout set - < layout.json` reads it from input instead.
- `./hub layout reset` goes back to the layout in `app/config.js`.

A tile is `{ "widget": "weather", "x": 0, "y": 0, "w": 3, "h": 2 }` on a grid 12 wide and 6 high: whole numbers, inside the grid, no two tiles overlapping, each widget once, at most 24 tiles. The server refuses anything else and says why. A TV that is on moves its tiles at once (if the set of widgets changed it reloads once). It waits while a panel is open. The TV keeps the last layout, so it starts with it even when the Pi is away.

## A World Worth Saving snapshot

The A World Worth Saving tiles on the TV (to-dos, handoffs, outreach and the rest) show one small file of figures, called the **snapshot**. A scheduled Claude routine builds it from places only a signed-in Claude can read and sends it to the Pi through the Claude mailbox (below), once a day at 7:12 AM Central, and when the TV's Sync now row asks (`./hub awws resync`); money has its own weekly routine. See `docs/awws-sync/`. The Pi checks it, keeps it in `data/state.json` and passes it to the TV. School visits and other dates still come from the calendars, not from the snapshot.

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

### To-do levels (server 0.6.0)

Every to-do has a level: `must` (Must today), `optional` (If you can, the default) or `passive` (a reminder the TV shows under Coming up from 2 days before its due date). `./hub todo add "Take weekly shot" --level must --due 2026-11-18`, `./hub todo level "Buy milk" passive`, and the mailbox's `todo.add` with `level` and `todo.level`. `./hub todo list` groups items by level. Sections (`--section`) are still taken and kept, but the TV no longer shows them.

An older server keeps a level the TV sets (Move on the TV) but refuses `level` on `todo add` and in the mailbox, and has no `todo level`. Until it is updated, a level can ride in the notes: end them with `[level:must]` or `[level:passive]`; the TV reads the tag and never shows it. To update: `git pull`, then `docker compose restart hub` (or `sudo systemctl restart home-hub`); `./hub status` should say `version 0.6.0`. Nothing changes in `.env`.

### Coming up lead (server 0.7.0)

A passive to-do can say how many days before its due date the TV starts showing it under Coming up: `lead`, a whole number from 0 to 30 (0 means only on the day it is due; none means 2). `./hub todo add "School meeting" --level passive --due 2026-11-20 --lead 3`, `./hub todo lead "School meeting" 5` (`--clear` goes back to 2), and the mailbox's `todo.add` with `lead` and `todo.lead` (`"lead": null` clears it). `./hub todo list` shows it as `(due 2026-11-20, lead 3 days)`.

An older server drops `lead` on `todo add` (the mailbox refuses it) and has no `todo lead`. Until it is updated, the lead can ride in the notes as `[lead:3]`, next to `[level:passive]`; the TV reads the tag and never shows it, and a `lead` field wins over it. To update: `git pull`, then `docker compose restart hub` (or `sudo systemctl restart home-hub`); `./hub status` should say `version 0.7.0`. Nothing changes in `.env`.

### Budget lab sections (server 0.5.0)

Server 0.5.0 also keeps four more optional sections for the Budget lab tile: `lab` (the room to card day), `merchants` (the top 5 merchants this month, with their month-to-date totals), `pace` (one spending total and the morning's cap per day) and `runway` (headroom from today to card day, never a balance). An older server drops them and keeps the rest, so the budget app may send them first. `./hub budget show` prints counts and dates for them, never a merchant name or an amount. After pulling: `docker compose restart hub` (or `sudo systemctl restart home-hub`); `./hub status` should say `version 0.5.0` or later.

Server 0.18.0 keeps one more optional section, `investments` (the portfolio total, its accounts, the top holdings and one total per day for a trend line), for the Investments tile. The owner approved dollar figures for it on 2026-11-19; the TV blurs them in guest mode. `./hub budget show` prints counts and dates for it, never a name or an amount. An older server drops it and keeps the rest. After pulling: `docker compose restart hub`; `./hub status` should say `version 0.16.0` or later.

## Ambience (the room's lights)

The Ambience tile on the TV sets the room's lights: scenes such as "Chill night", each light's level, and the plant wall's moods. The TV only talks to this server. The server talks to Home Assistant (which talks to the bulbs) and to the plant wall's WLED controller. The TV never gets the token or an address, and it can only send the ids of lights, scenes and moods you saved here.

This needs server 0.7.0. Other changes also move the server's version (each feature that changes the server bumps it), so after pulling, `./hub status` should say `version 0.25.0` or later (0.7.0 is enough for Ambience).

### Before you start: your bulbs must be in Home Assistant

The hub does not talk to any bulb itself. Every light must first show up in Home Assistant as a `light.` entity (or a `switch.` entity for a plug). Check in Home Assistant under Settings, Devices and services, Entities: you should see each bulb there, and turning it on and off from Home Assistant should work.

- **Geeni** bulbs are Tuya devices inside. The usual ways into Home Assistant are the built-in **Tuya** integration (through the Tuya cloud) or the community **LocalTuya** integration (on your network, needs each bulb's local key). Which one works for your bulbs has **not been tried** yet. Get them working in Home Assistant first; the hub can't do this part.
- **Sengled** bulbs come in through their own hub or Zigbee. They often drop off the network. That is between the bulb, its hub and Home Assistant, and this code can't fix it. What the hub does: a scene still applies to every light that answers, and the TV names the one that didn't.
- The **camera plug** (or any smart plug) works as a `switch.` entity: on and off, no level.

### Step 1: a token from Home Assistant (once)

1. In Home Assistant, open your profile (your name, bottom left), then the **Security** tab.
2. Under **Long-lived access tokens**, choose **Create token**, name it `Home Hub`, and copy it. It is shown only once.
3. On the Pi, add it to `pi/.env` (keep it only there, never in git or a chat):

   ```sh
   HA_TOKEN=PASTE-LONG-LIVED-TOKEN
   # Only if Home Assistant is not on this Pi:
   # HA_URL=http://homeassistant.local:8123
   # Only if you have the plant wall's WLED controller:
   # WLED_URL=http://PASTE-WLED-ADDRESS
   ```

4. Restart: `docker compose restart hub` (or `sudo systemctl restart home-hub`). The log says `ambience: on (0 lights, 0 scenes, 3 moods)`.

### Step 2: tell the hub which lights and scenes you have

The lights, scenes and plant wall moods are kept in `data/ambience.json`. Start from the example:

```sh
cp ambience.example.json my-lights.json
```

Edit `my-lights.json`:

- `lights`: one per bulb or plug. `id` is your short name for it (a-z, 0-9, `-` or `_`), `name` is what the TV shows, `entity` is its entity id in Home Assistant (like `light.living_room_lamp`), `kind` is `light` or `switch`. Add `"flaky": true` for a bulb that often drops off.
- `scenes`: each has an `id`, a `name`, an `icon` (`moon`, `sun`, `book`, `film`, `power`, `sparkle`, `bulb`, `leaf`, `sofa` or `bed`) and, for each light, `on`, a level `pct` (1 to 100), and either a white `kelvin` (1500 to 6500) or a `color` `[red, green, blue]`. `wled` names a plant wall mood to set with the scene.
- `moods`: the plant wall's moods, each a WLED state (`on`, `bri` from 0 to 255, optionally `ps` for a WLED preset).

At most 12 lights, 10 scenes and 12 moods; the file is at most 8 KB. Then:

```sh
./hub ambience set my-lights.json
```

It says `Saved: 3 lights, 5 scenes, 3 moods. Screens that are on change now.` or, if something is wrong, which part and why (for example `scene 1 uses a light id that is not in "lights"`). With Docker the file must be in this folder; `./hub ambience set - < my-lights.json` reads it from input instead.

### Commands

- `./hub ambience status`: how many lights answer and are on, which scene is on, one line per light, and the plant wall.
- `./hub ambience scenes`: the ids of the scenes, lights and moods.
- `./hub ambience scene chill`: apply a scene. `Chill night: applied (2 of 2 lights answered).` or `Chill night: partly applied (1 of 2 lights answered; Sengled lamp didn't answer).`
- `./hub ambience light geeni 40` (or `on`, `off`): one light.
- `./hub ambience mood dim`: a plant wall mood.
- `./hub ambience reset`: back to the defaults (no lights; the three plant wall moods Off, Dim and Bright).

From the cloud, the Claude mailbox has the same: `ambience.status`, `ambience.scene` `{ "id": "chill" }`, `ambience.light` `{ "id": "geeni", "pct": 40 }` (or `"on": true|false`), `ambience.mood`, `ambience.set` `{ "config": { ... } }` and `ambience.reset`.

The server asks Home Assistant how the lights are every 10 seconds while a TV is on, and every minute when none is, waiting longer (up to 5 minutes) while Home Assistant doesn't answer. The log only ever says counts and results, such as `ambience: scene applied (1 of 2 lights answered)`: never the token, an address, an entity id or a light's name.

### If it says something else

| What you see | What it means | What to do |
|---|---|---|
| TV: **Set up lights**, "Home Assistant isn't connected yet"; log `ambience: off (no HA_TOKEN in .env)` | No token | Step 1 |
| Log `ambience: off (HA_TOKEN or HA_URL does not look right)` | The token is too short or has spaces, or `HA_URL` is not an `http://` or `https://` address | Copy the token again; check `HA_URL` |
| TV: **Set up lights**, "No lights added yet" | No lights saved | Step 2 |
| TV: "Home Assistant refused the token"; log `ambience: Home Assistant refused the token (401)` | The token was deleted or mistyped | Make a new one (Step 1) and restart |
| TV: "Home Assistant isn't answering"; log `ambience: Home Assistant did not answer (timeout)` or `(network)` | Home Assistant is off or restarting, or `HA_URL` is wrong | The tile keeps the last known lights and the server keeps trying. Check Home Assistant opens in a browser |
| TV and `./hub ambience scene` say "Sengled lamp didn't answer" | **Sengled keeps dropping: scenes still apply to the others.** That bulb is offline in Home Assistant | Nothing to do here. Power the bulb off and on, or look at its hub. Its reliability is outside this code |
| `light ... didn't answer` for a Geeni bulb | Home Assistant has it but can't reach it | Check it in Home Assistant first (Tuya or LocalTuya, see above) |
| Log `ambience: plant wall did not answer` | The WLED controller is off or `WLED_URL` is wrong | Open `WLED_URL` in a browser on the same network |
| Log `ambience: plant wall off (WLED_URL does not look right)` | `WLED_URL` is not an `http://` address | Fix it in `.env` and restart |
| Log `ambience: a screen sent commands too fast (asked it to slow down)` | Someone held a button down | Nothing: the TV waits and tries again |
## Spanish for your own text (server 0.12.0)

In Spanish mode the TV shows your to-dos, calendar events and AWWS task lines in Spanish. It sends new lines to `POST /translate`; the Pi answers lines it already knows from `data/translations-es.json` (up to 5000) and sends new ones to Gemini (`gemini-3.5-flash-lite`; 2.5 Flash-Lite refuses new keys with HTTP 403) in one batch, so each line is translated once. Show titles, songs and place names are kept as they are.

It uses `HUB_TRANSLATE_KEY` from `.env`, or else `GEMINI_VIDEO_GEN_KEY` (your personal key; `GEMINI_API_KEY` is never used). With neither set, the TV simply stays in English for those lines. At most 2000 new lines a day go to Gemini. After an error it waits 1 minute, then 2, 4, 8 and at most 10, and a good answer resets the wait. The log counts lines and never shows the text, for example:

```
translate: 4 asked, 1 cached, 3 new (Gemini 812 ms, 210 + 95 tokens)
```

To see what it costs, Claude sends the mailbox command `translate.status` (or call `GET /api/translate/usage` with the token): new lines, Gemini calls, tokens and an estimated dollar cost for today, this month and all time, from `data/translate-usage.json` (62 days kept). The estimate uses Flash-Lite's list price ($0.30 per million tokens in, $2.50 out, thinking counted as out; `PRICE_IN`/`PRICE_OUT` in `translate.js`); Google's billing page is the real number.

## TV shows (the Schedule)

The Entertainment panel on the TV has a **Schedule**: what airs today, this week and this month from the shows on your list, and which seasons are coming back. The Entertainment tile also puts first the apps that have something new, with a small count. The Pi keeps the list and looks the shows up on [TVmaze](https://www.tvmaze.com/api), a free public TV guide that needs no key or account.

- `./hub shows list` shows the list. For each show it says still running or ended, what airs next and when, a returning season, or why it couldn't be read.
- `./hub shows add "Stick" --service "Apple TV"` adds a show. The options:
  - `--service` names the app it shows under (its badge on the TV). It wins over what TVmaze says.
  - `--id 12345` sets its TVmaze number when the name finds the wrong show (the number is in the show's address on tvmaze.com).
  - `--watch Hulu` opens a different app than the badge.
  - `--also "Hulu,Peacock"` lists other apps that carry it (up to 4); the TV offers each as "Also on Hulu".
  - `--via "Prime Video"` is for a service billed through another app (Prime Video Channels). The badge still says HBO Max, the TV adds "via Prime Video", and Watch opens Prime Video. `watchVia` in `app/config.js` does this for every show of a service.
  Adding a show that is already there updates it.
- `./hub shows remove "Stick"` takes one off.
- `./hub shows watched "Stick" S3E4` marks an episode watched by hand, and `./hub shows unwatch "Stick" S3E4` takes the mark off (server 0.8.0). The TV marks episodes when the person answers "Did you finish?" or taps the check on a row (`POST /shows/watched` and `POST /shows/unwatch` from the screen; README.md, Schedule); these two are for mistakes made elsewhere. Leave the episode out of `watched` to mark the earliest episode out in the last week that is not marked. The marks live in `data/shows.json` (`watched: [{ "s": 3, "e": 4, "at": "..." }]`) and `./hub shows list` ends a show's line with `[watched S3E4]`. The mailbox has `shows.watched` and `shows.unwatch`.
- `./hub shows upto "Stick" S3E4` marks the show watched up to and including S3E4 (a binge: every earlier episode counts too, kept as `upTo` in `data/shows.json`), and `./hub shows caughtup "Stick"` marks every episode that has aired so far (server 0.10.0). Both are normally set on the show page on the TV (`POST /shows/upto` and `POST /shows/caughtup`); these are for the owner telling Claude. Marking an earlier episode with `upto` replaces the old point: episodes after it become unwatched again, except ones marked one by one. `./hub shows list` ends a show's line with `[up to S3E4]`. The mailbox has `shows.upto` and `shows.caughtup`. The Pi also keeps each show's full episode list in `data/show-episodes.json` for the show page (`GET /shows/episodes?id=<show id>`).
- `./hub shows refresh` asks TVmaze about every show now and waits up to 25 seconds. Otherwise the Pi asks every 6 hours, and right after the list changes.

The list starts with Hell's Kitchen and Shark Tank (Disney+), The Great British Baking Show (Netflix) and Stick (Apple TV), and lives in `data/shows.json`. The schedule itself is kept in `data/state.json`.

If TVmaze can't be reached, each show keeps its last good copy and the TV keeps showing it. `./hub shows list` then says the copy is old. The Pi asks TVmaze at most 20 times in 10 seconds (TVmaze's limit), one call at a time; a list of 4 shows takes about 12 calls.

On the TV, OK on a show opens its app (with "Search: Stick" as a reminder, since the apps don't take a show from outside yet). Hulu titles open in Disney+ by default (`watchAliases` in `app/config.js`), with "Also on Hulu" beside them. The shape of the data is in [`docs/shows-snapshot.md`](../docs/shows-snapshot.md).

`HUB_SHOWS=off` in `.env` stops the TVmaze lookups. `HUB_SHOWS=sample` sends a made-up sample instead (`fixtures/shows-sample.json`), to try the TV without TVmaze.

The log names no show. It only counts, for example `shows refresh: 4 of 4 shows read` or `shows refresh: 3 of 4 shows read, 1 failed (timeout)`. Marking watched logs `screen marked an episode watched` (from the TV) or the usual `control POST /api/shows/watched -> 200 marked an episode watched` line.

### Watch link test answers

The TV's About panel has a **Watch link test**: each recipe tries one way of opening a title straight in an app (Prime Video, Netflix, Apple TV, Disney+...). You answer "Opened the title", "Only opened the app" or "Nothing". The TV sends each answer here, and the Pi keeps the last 100. `./hub linktests` lists them, newest first, so a Claude thread can see which deep links work on this TV.

### TV remote from the Pi (two-step launch)

The TV refuses remote key presses it sends to itself, so some Watch link test rows ("Open, Enter, then ...") ask the Pi to press the keys. The Pi talks to the TV's remote-control WebSocket (`wss://<tv>:8002`, or `ws://<tv>:8001` if that does not connect) under the name "Home Hub Pi" (`tvremote.js`, server 0.23.0). A run opens the app, waits about 10 seconds, presses Enter (the default profile), waits about 5 seconds, then sends the title link while the app is already running, either as a deep link or by DIAL (HTTP POST to `http://<tv>:8080/ws/apps/Netflix`). Then you answer the usual "Opened the title / Only opened the app / Nothing".

**One-time Allow prompt.** The first run makes the TV show a prompt to allow "Home Hub Pi": press Allow on the remote within 30 seconds. The TV answers with a token, which the Pi keeps in `data/tvremote.json` (readable by you only, never in a log, never sent anywhere). If the TV said no, allow it under Settings > General > External Device Manager > Device Connection Manager > Device List, then try again.

**The TV's address** comes from the screen's own request, or set `HUB_TV_REMOTE_IP=192.168.1.x` in `.env` to name it (needed for runs from the mailbox before the TV has talked to the Pi). One run at a time.

- `./hub tvremote` says whether the Pi is paired and shows the last run's steps (what was sent, how long each took). `./hub tvremote run '{"id":"x","appId":"3201907018807","link":"dial","dialApp":"Netflix","payload":"m=..."}'` starts one by hand. The mailbox has `tvremote.status` and `tvremote.run` with the same fields (`open`, `waitOpen`, `enter`, `waitAfter`, `link` = `deeplink`, `dial` or `none`, `payload`, `dialApp`).
- The log says only what was done, for example `tvremote: netflix-2step-dial: opened app (ok), Enter (ok), DIAL Netflix -> HTTP 201`; never the link or the token.
- Tests: `node pi/tvremote-test.js` (a fake TV and a fake DIAL port).

### After pulling this change

It adds `shows.js`, `shows-seed.json` and `linktests.js` next to `server.js` and makes the server version 0.6.0. A restart is enough, with no rebuild and no change to `.env`:

1. `cd tizen-takeover && git pull && cd pi`
2. With Docker: `docker compose restart hub`. With systemd: `sudo systemctl restart home-hub`.
3. `./hub status` should say `version 0.6.0`. In a few seconds, `./hub shows list` should list the four shows with what airs next. If it says `The server said no: no such call.`, the server is still running the old code: do step 2 again.

The Pi needs to reach `api.tvmaze.com` over HTTPS. If your network blocks it, the Schedule says "TVmaze couldn't be reached".

## Calendars

The Pi can read your Google calendars and send the coming events to the TV. Each calendar has a private link, called the **secret address**. The Pi reads that link every few minutes. Nobody needs to sign in to Google on the Pi.

The secret address is like a key: anyone who has it can read that calendar. Keep it only in `.env` on the Pi. Never put it in git, a chat, an email or a screenshot.

### Calendar to-dos, and deleting ticked events

Events titled `TODO:` (optional), `TODO!:` (must) and `TODO~:` (passive) become to-dos on every calendar refresh (`todoconvert.js`). Once the to-do is ticked:

| Event | After the tick |
|---|---|
| `TODO:` | deleted from Google Calendar (hidden from the hub calendar as soon as it is a to-do) |
| `TODO!:`, `TODO~:` | stays on the calendar |
| description has `#keep` | stays (a `TODO:` event then also stays on the hub calendar) |
| description has `#remove` | deleted, even for `TODO!:` and `TODO~:` |

Only that day's occurrence of a repeating event is deleted, never the series. A to-do removed without a tick deletes nothing. The delete happens at the next calendar refresh (within about 5 minutes). Google keeps deleted events in the calendar's Trash for 30 days.

The calendars are read through their secret iCal links, which cannot change anything, so deleting uses a Google service account (`gcal.js`). Set it up once, on a computer:

1. console.cloud.google.com: create a project (`home-hub`).
2. APIs & Services, Library: enable **Google Calendar API**.
3. IAM & Admin, Service accounts: **Create** (`hub-calendar`, no roles). Open it, **Keys**, **Add key**, **JSON**. Copy its email (`...iam.gserviceaccount.com`).
4. Google Calendar on the web, for each calendar with TODO events: Settings and sharing, Share with specific people, add that email with **Make changes to events**.
5. On the Pi, paste the downloaded file into `data/google-calendar-key.json` (`nano data/google-calendar-key.json`), then `chmod 600 data/google-calendar-key.json`. No restart needed: the next refresh finds it.

No key file: nothing is deleted. A calendar not shared with the account: the event stays (the log counts it as "not shared with the hub"). Log line, counts only: `Calendar to-dos: 1 ticked event deleted from the calendar, 0 not shared with the hub, 0 to try again`. Never commit or print the key file (`data/` is ignored by git).

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

The TV then shows each event as `Busy`, with its time but no title, no place, no notes and no guests. (A calendar without this line also sends each event's notes, its description in Google Calendar, from server 0.16.0: links and email addresses are taken out, and the TV hides notes while Guest mode is on.) Restart the server after the change, as in step 9.

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

The Now Playing widget on the TV (its expanded and full-screen pages) shows what plays anywhere: the Echo speakers through Home Assistant, and Spotify (Spotify wins when both play). `allsounds.js` reads Home Assistant's REST API (`GET /api/states`, every 5 seconds while something plays, 20 seconds otherwise, backing off up to 2 minutes when it cannot get through) and keeps the `allsounds` resource; it changes nothing for Now Playing.

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

Commands: `./hub allsounds status` (state, source, speaker, title and artist), `./hub show nowplaying` (the page on the TV). Tests: `node pi/allsounds-test.js` (against the pretend Home Assistant in `dev/mock-ha.js`).

| What you see | What it means | What to do |
|---|---|---|
| `All sounds: not set up` | No `HA_TOKEN` in `.env` | Steps 2 to 5 above |
| Someone else's Echo shows | `ALLSOUNDS_ENTITIES` is not set, so every Echo on the Amazon account is watched | Step 4 above |
| `Home Assistant refused the token` | The token is wrong or was deleted | Make a new one, put it in `.env`, restart |
| `Home Assistant cannot be reached` | `HA_URL` is wrong, or Home Assistant is down | Check Home Assistant opens at that address from the Pi |
| `nothing playing` while an Echo plays | Alexa Media Player has not caught up (it can lag 10 to 30 seconds), or the speaker is not listed in `ALLSOUNDS_ENTITIES` | Wait a moment; check the entity in Home Assistant |

## Echo controls (server 0.22.0)

`./hub echo ...` starts an app on one of your Echo speakers, or pauses, skips, stops and sets the volume, through the same Home Assistant and Alexa Media Player (AMP) setup as All sounds (`HA_TOKEN`, `HA_URL`). Without `HA_TOKEN` it says `Echo controls are off (no HA_TOKEN in .env)`. The code is `echo.js`; tests are `node pi/echo-test.js`.

```sh
./hub echo status                                  # targets, and what the hub started
./hub echo audible                                 # resume your book on Audible
./hub echo kera --on dot                           # KERA 90.1 on the Echo Dot
./hub echo news                                    # the Alexa flash briefing
./hub echo start pandora --query "jazz"            # or: start amazon-music, start tunein --query "KERA"
./hub echo pause | resume | next | stop            # add --on show|dot|everywhere
./hub echo volume 40                               # 0 to 100, or up or down
```

**Apps.** Only these presets can be started: `audible` (says "resume my book on Audible"), `pandora` and `amazon-music` (with no `--query` they say "play Pandora" or "play Amazon Music"; with one they search for it), `tunein` (needs a `--query`, a station or show), `kera` (TuneIn's KERA 90.1) and `news` (Alexa's flash briefing). A query is plain text up to 100 characters; `audible`, `news` and `kera` take none.

**Targets.** `show`, `dot` and `everywhere` (Alexa's group of all speakers) by default; the first is used when `--on` is left out. To use other speakers, set `ECHO_TARGETS` in `.env` as `key=media_player.id` pairs (key: letters a-z, digits and `-`, up to 20 characters; up to 8; the first is the default), for example `ECHO_TARGETS=show=media_player.ian_s_echo_show,dot=media_player.ian_s_echo_dot,everywhere=media_player.everywhere`, then `docker compose restart hub`. A target called `everywhere` (or `media_player.everywhere`) is a group: one call goes to it, and every other target counts as a member of it.

**What "All sounds" shows.** Amazon does not tell AMP what Audible or the news is playing, and AMP keeps the last song's title. So when the hub starts something, it remembers that (a label in `data/echo.json`, mode 600, no query saved) and All sounds shows `Audible` (or `Alexa news`) on that speaker with no title and "started by the hub", instead of the stale song. On Ian's Echo Show (2026-11-20) Alexa Media Player does report an Audible book: its title, the author as `By ...` and the cover. All sounds then names it Audible (server 0.22.1) and keeps those details with the "started" line (0.22.2); only a stale song is hidden. An Echo still claiming Spotify "playing" while Spotify itself says paused counts as paused (0.22.2). For Pandora, Amazon Music and TuneIn the real title shows as usual and the label only supplies the app's name (and `KERA 90.1` for the first seconds). Started on `everywhere`, the device reads "Everywhere".

**When the label clears.** On `./hub echo stop`; when something else clearly starts on that speaker (a new picture or title, Spotify, another app); after 6 hours; and for Pandora, Amazon Music and TuneIn when the speaker has been idle for 10 minutes.

**Pause, skip and stop for Audible and the news.** AMP cannot control these as a media player, so while the hub's label says one of them is playing, `pause`, `resume`, `next` and `stop` are sent as spoken commands ("pause", "resume", "next", "stop") instead. Volume always uses the normal speaker volume.

**Not tested yet (written from how AMP is documented):** the spoken commands on the `everywhere` group, whether AMP's `custom` voice commands include "pause" and "resume" for Audible, and the exact words AMP needs for Pandora and Amazon Music with no query.

**Limits and the log.** At most 10 commands in 10 seconds (`Too many Echo commands; wait a few seconds.`). The log gets fixed words and target keys only, never a query, a speaker's name or a title: `echo: started Audible on show`, `echo: pause on dot (voice)`, `echo: volume on show`, `echo: label cleared on show (other playback)` (also `(timeout)`, `(stop)`), `echo: Home Assistant refused the token (401)`. The control API is `GET /api/echo` and `POST /api/echo` (`{ action, target?, app?, query?, level? }`); the TV cannot reach it. The Sound control widget (hub v0.39.0, server 0.24.0) uses its own screen route instead, `POST /echo/run` (`{ action, target?, app?, level?, step? }`): presets only (`audible`, `pandora`, `amazon-music`, `kera`, `news`, and from server 0.24.2 `npr` (Alexa asked to "play NPR News Now") and `spotify` ("play Spotify", or a Spotify search from `./hub`); no `tunein`, no query, unknown fields refused), `volume` takes `step: "up"|"down"` or `level` 0 to 100, a foreign Origin gets 403, more than 6 presses in 5 seconds gets 429, and the reply is only `{ ok, message }` (no address or token). The mailbox commands are `echo.status`, `echo.start`, `echo.pause`, `echo.resume`, `echo.next`, `echo.stop` and `echo.volume`.

## Weekly health report (server 0.15.0)

Once a week (Sundays at 3:15 AM Central) a script checks the whole Pi and writes one report, so Claude can tell you if anything is drifting before it breaks. It runs on the Pi itself, outside Docker, from a systemd **user** timer, so it needs no sudo.

It checks: CPU temperature and throttling, under-voltage, memory and swap, disk space (and how big `pi/data`, `~/code/*`, the journal and Docker's images and volumes are), SD card or disk errors in the kernel log, reboots that came without a clean shutdown, every Docker container (running, restarts since last week, out-of-memory kills, log problem lines), your user services (the budget app) and any failed units, timers, whether each checkout under `~/code` is on its main branch and up to date with GitHub (so a stuck hourly auto-update shows), Wi-Fi signal, drops and pings, the hub's own log problems, how old the calendar, shows, budget and AWWS data are, and translation use against the 2,000-new-lines-a-day cap. If `HA_TOKEN` is set, it also reads Home Assistant's own Pi sensors (System Monitor, Raspberry Pi power) with a week of history, how many lights and speakers are unavailable, and which Home Assistant updates are waiting.

Each finding is a flag, `bad` or `warn`, with a plain sentence. Where the lines are drawn is the `LIMITS` table at the top of `health/pi-health.py`.

**Where it lands:** `data/health/latest.json` (the newest), one dated copy per week (the newest 12 kept) and `data/health/latest.txt` (the flags in plain lines). Within a minute the hub copies `latest.json` to the Claude mailbox bucket as `health/latest.json` and `health/YYYY-MM-DD.json` (kept 180 days), and `status.json` gains a one-line `health` summary. The hub log says, once per new report:

```
Claude mailbox: health report sent (warn, 38 KB)
```

**What it never holds:** anything from `.env`, IP or MAC addresses, the Wi-Fi name, links, email addresses, Home Assistant entity ids, budget amounts, to-do text, or what plays. The report is scrubbed once more before it is written, and its test checks that with a fake hub and Home Assistant that leak on purpose.

### Set it up (once)

```
cd ~/code/tizen-takeover && git pull && pi/health/install.sh --run && cd pi && docker compose restart hub
```

`install.sh` writes `~/.config/systemd/user/pi-health.service` and `.timer`, turns the timer on, says when it runs next, and points out anything that would hide part of the picture (linger off, or your user not in the `adm`, `docker` or `video` group, each with the command that fixes it). `--run` makes a first report right away and prints its summary. After that the script itself updates with every `git pull`; the timer never needs installing again. `install.sh --remove` turns it off.

By hand: `python3 health/pi-health.py` (writes the files), `--print` (prints the report, writes nothing), `--quick` (skips pings, a week of history and Docker logs).

### Adding checks for new things

Lights, the Bluetooth storm speaker and whatever comes next add their own check as a small executable in `health/checks.d/` that prints one JSON object; it appears under `extras` in the report and its flags join the list. The contract and an example are in `health/checks.d/README.md`.

## Run without Docker

If you prefer, install Node 14 or newer (`node --version` shows yours) and run it directly:

1. `cd tizen-takeover/pi`
2. `./hub token`
3. `node server.js`

You should see `Home Hub live server 0.24.2 listening on port 8097`. It stops when you close the terminal or press Ctrl+C.

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

The Docker log is kept to about 15 MB (three files of 5 MB; the oldest is dropped). A change to that setting in `docker-compose.yml` only takes effect after `docker compose up -d`, because a plain restart does not re-create the container. So after pulling the change that added it, run `docker compose up -d` once.

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
| You want to see only what went wrong | | `./hub log --errors` (see below) |

### Recent log lines: `./hub log`

The server keeps its last 400 log lines in memory (they are gone after a restart; the Docker log keeps more).

- `./hub log` prints the last 50, each with its local time.
- `./hub log --errors` prints only the problems.
- `./hub log --lines 120` prints more (1 to 200).

The last line counts the problems, for example `3 problems in the last 24 hours.` Reading the log does not add to it. The Spotify account name is never logged.

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

The Pi only ever goes *out* to Cloudflare; nothing comes in. It can only do the things `./hub` does (show a widget, say a message, to-dos, calendar status and refresh, layout, the A World Worth Saving snapshot, status, recent log lines with addresses and names taken out, and restart the server). It cannot run any other command, git or Docker. Notes older than a day, or that do not look exactly right, are refused and never run.

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
- Commands: `show {widget, full?}`, `home`, `say {text, seconds?}`, `play {url, title?}`, `stop`, `news`, `echo.status`, `echo.start {app, target?, query?}`, `echo.pause`, `echo.resume`, `echo.next`, `echo.stop` (each `{target?}`), `echo.volume {level, target?}`, `reload`, `todo.add {title, level?, section?, due?, notes?}`, `todo.level {id or title, level}`, `todo.notes {id or title, notes}`, `todo.list`, `todo.done {id or title}`, `todo.remove {id or title}`, `calendar.status`, `calendar.refresh`, `layout.show`, `layout.set {layout: [...]}`, `layout.reset`, `awws.show`, `awws.set {snapshot: {...} or null}`, `awws.clear`, `budget.show`, `budget.set {snapshot: {...} or null}`, `budget.clear`, `log.tail {lines?, errors?}`, `status`, `ping`, `restart`. They go through the same control API, and the same checks, as `./hub`.
- The Pi writes `outbox/<id>.json`: `{id, cmd, ok, state, message, data, started, finished}`. `message` is the same text `./hub` prints (several lines for lists). First it writes `state: "running"` as a claim, then the final result with `state: "done"`; a command with an outbox file is never run again, even after a crash. Then it deletes the inbox file.
- At most 20 commands per look, oldest `created` first, one at a time.
- `status.json` is rewritten every minute and after each command: version, uptime, how many screens are listening, the mailbox's last command and last error, a calendar summary (counts only), and `log: {errors24h, lastErrorAt}` (a count and a time, never log text).
- `log.tail` answers with the last log lines (`lines` 1 to 200, default 50; `errors: true` for problems only). Its text is always scrubbed on the Pi before it is written to the bucket: every IP address becomes `[address]`, and each calendar's name, the Spotify account's name, the bucket name and the R2 host become `[name]`. Each line is cut to 300 characters. `message` is one line, such as `50 lines, 3 problems in the last 24 hours.`; `data` is `{lines: [{t, text, level}], errors24h}`.
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
- Log lines that leave the Pi (the mailbox's `log.tail`) are scrubbed first: no IP addresses, calendar names, Spotify name, bucket name or R2 host. `./hub log` on the Pi shows them as they are, like `docker compose logs`.
- If you think it leaked, delete the `HUB_TOKEN=` line from `.env`, run `./hub token`, and restart the server.

## Shortcuts on the Pi (`pi/aliases.sh`)

One-time setup, then open a new shell:

```sh
echo '[ -f ~/code/tizen-takeover/pi/aliases.sh ] && . ~/code/tizen-takeover/pi/aliases.sh' >> ~/.bashrc
```

`hubup` (pull, restart hub, then budget, then status), `hubrestart` (hub only), `budgetrestart`, `hubstat`, `hublog [--errors]`, `hubhub <any ./hub command>`, `hubdocker <compose args>`. Nothing runs by itself; each runs only when typed.
