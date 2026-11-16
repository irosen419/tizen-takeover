# Home Hub live updates

Written 2026-11-15. Status: design agreed in outline with Ian, first build in the same pull request.

## What this is for

Two things, in Ian's words:

1. **Steer the screen.** Mid-conversation with Claude: "show me the weather", "show me my to-do", "show me what apps I have". The TV changes at once.
2. **Data that shows up by itself.** "Add milk to my to-do list" or "put the dentist on my calendar", and it appears on the TV without anyone touching the remote.

And one hard rule: **the TV being off, or the Pi being down, must never break anything**, now or the next time the TV turns on.

## The idea in one picture

```
 You, talking to Claude
        |
        v
 A small server on the Raspberry Pi   <---  the one place your lists live
   (holds the data, knows the password)
        |
        |  an open line the TV keeps to the Pi
        v
 Home Hub on the TV   (draws what the Pi tells it)
```

- The **Pi server** is a small program that runs next to Home Assistant. It keeps your lists in a file on the Pi and holds every secret.
- The **TV keeps one open line** to the Pi. The Pi pushes down that line the moment something changes. The TV never has to ask "anything new?" over and over.
- **Claude talks to the Pi**, never to the TV directly.

You called it webhooks, then WebSockets. You had the right idea both times. The exact tool is a close cousin of a WebSocket called **Server-Sent Events**: a one-way line from server to page. It does the same job here, every TV browser back to 2012 has it built in, and it needs no extra library on the Pi. When the TV wants to tell the Pi something (you tick a to-do with the remote), it makes an ordinary request.

## Two kinds of message, on purpose

| | Commands | Data |
|---|---|---|
| Examples | show the weather, go home, say "dinner in 10" | the to-do list, later the calendar |
| Kept on the Pi? | No | Yes, in a file |
| TV is off | Dropped. Claude is told "no screen is listening" | Nothing to do. The data waits on the Pi |
| TV turns on | Nothing fires | The TV loads the current full list |

This split is what makes "TV off" safe. A command is only for a screen that is on right now, so there is no pile of old commands waiting to fire when you turn the TV on. Data is not a pile of messages at all: it is just "what the list looks like now", and the TV asks for that every time it connects.

## What happens when the TV turns on

1. The hub draws from what it saved last time, straight away. It never waits for the Pi.
2. It asks the Pi for the **current full picture** (one request).
3. Only then does it open the line and **listen for changes**.
4. If the line drops, it shows that quietly, keeps working from what it has, and tries again after 2, 5, 10, 30 and then every 60 seconds. Every reconnect starts again at step 2, so a missed change can never leave the TV wrong for long.

The Pi side is just as plain. With no TV connected it holds no open lines and no queue. A command sent then returns at once with "delivered to 0 screens".

## What you see when something is wrong

Small text in the About panel (Left from a tile at the left edge of the home screen), under Updates, Live updates; never a pop-up, never a blank screen. Each problem has its own words. The panel leaves out the `Live: ` that `HUB_LIVE.status().text` starts with, and shows `Live` as `connected`:

| Situation | `HUB_LIVE.status().text` | The About panel's Live updates row | What the hub does |
|---|---|---|---|
| Live updates not set up | `''` | no row | exactly what it does today |
| Pi never reached from this TV | `''` | no row | exactly what it does today, keeps trying quietly |
| Connected | `Live` | `connected` | |
| Was connected, Pi now unreachable | `Live: lost the Pi at 7:10 AM` | `lost the Pi at 7:10 AM` | uses saved data, retries |
| Pi refuses this TV (not on its allowed list) | `Live: the Pi refused this TV` | `the Pi refused this TV` | retries every 5 minutes |
| Something else answers at that address | `Live: unexpected reply from the Pi` | `unexpected reply from the Pi` | retries every 5 minutes |
| Pi server is newer than the hub understands | `Live: the hub needs an update` | `the hub needs an update` | keeps data it understands |

The To-do tile says where its list lives: `On this TV` (no Pi), `In sync`, or `Saved here, 2 to send` when you changed things while the Pi was away.

When Claude sends something with a wrong password, that is Claude's error to see, not the TV's: the Pi answers "wrong token" and the TV is not involved.

## What can be controlled first

Kept deliberately small, one or two of each kind, so the first test is easy to judge.

Commands:

- `show <widget>`: open a widget (`weather`, `todo`, `calendar`, `entertainment`), optionally full screen.
- `home`: close whatever is open.
- `say "<text>"`: a short message at the bottom of the screen for a few seconds.
- `reload`: load the hub afresh. It restarts through the loader (`app/index.html`), so it also picks up the newest version of the hub.

Data:

- **To-do.** The list moves to the Pi. Add, tick, move and remove work from the TV remote as today and from Claude. Changes made on the TV while the Pi is away are kept and sent later.

Next, once this works on the TV: the calendar, private settings (below), a longer-lived banner, and choosing which tiles are on the home screen. (The calendar and the tile layout are now built.)

## How Claude reaches the Pi

Claude in the cloud cannot reach your home network. That is a wall worth keeping. Three ways through it:

| Way | How it works | Speed | What it costs |
|---|---|---|---|
| **A. The Claude already on your Pi** (recommended to start) | Your Pi runs a Claude session that this project can hand work to. It runs one command on the Pi itself | Instant when you talk to the Pi's Claude directly. From this project chat there is a hand-off first, not yet timed | Nothing new. No door opened to the internet |
| B. A tunnel | A helper on the Pi (Cloudflare Tunnel or Tailscale Funnel) keeps an outgoing line open, and gives Claude a web address that leads to one locked door on the Pi | About a second | 15 to 20 minutes of setup, one more allowed address in this project's settings, and a door on the internet that only the password protects |
| C. Both | A for setup and repairs, B for speed | | |

**Recommendation: start with A.** It works the day the server is installed, and it is also how the server gets installed. If the hand-off from this chat feels slow, add B. The server is built for both from day one: the tunnel can only ever be plugged into a separate side door that accepts password-protected commands and nothing else (no reading of your lists).

## Security, in plain terms

- **Changing things needs the password** (a long random token). It is created on the Pi and lives in a file there called `.env`. It is never in this repository, which is public, and never in a chat.
- **The TV does not hold the password.** The hub's code is public, so it has nowhere safe to keep one. Instead the Pi lets devices on your home network read the lists and edit the to-do list. To tighten that, list the TV's address in `.env` (`HUB_TV_IPS`) and the Pi will refuse everything else.
- **Home network only.** The main door listens on your home network. The optional side door for a tunnel listens only on the Pi itself.
- **If you use a tunnel**, Claude's copy of the password goes in this project's cloud environment as a secret, typed in by you.

What that leaves open: someone on your home Wi-Fi could read or edit the TV's to-do list. If that ever matters, a one-time pairing code between the TV and the Pi closes it.

## Where secrets and private settings live

You asked about an environment variable in the repo. In a public repository a committed settings file is public too, so it cannot hide anything. The Pi's `.env` file is the private place:

- the password for sending changes,
- the secret calendar links,
- later, private settings the TV picks up from the Pi when it connects, for example a more exact weather spot. That gives you what you were after: the public repo says "ask the Pi", and the Pi knows the answer.

## Calendar: how it plugs in

The calendar needs a home off GitHub for its secret links, and this server is that home.

- The secret iCal links go in the Pi's `.env`.
- The Pi reads the calendars every few minutes and keeps the events as one more piece of data, exactly like the to-do list.
- When the events change, the Pi pushes them to the TV.
- When Claude adds an event to your Google Calendar, Claude then tells the Pi "read the calendar now", so it appears right away instead of minutes later.

From you: which calendars to show, whether any show as just "Busy", and one secret link per calendar pasted into `.env`.

### What the Pi reader does (built)

- Each calendar is `CALENDAR_n_NAME`, `CALENDAR_n_URL` and optionally `CALENDAR_n_DETAILS=busy` in `.env`. Names may contain spaces.
- The Pi downloads each feed over https only (10 second limit, 5 MB cap, at most 3 redirects), reads it with its own small parser and keeps one resource, `calendar`, in `state.json`. Only the events live there. The links never do, and never appear in a log, an answer or the state file.
- Window: the start of yesterday up to 60 days after today, at most 500 events, in the time zone `HUB_TIMEZONE` (default America/Chicago).
- Repeating events are expanded on the Pi (daily, weekly, monthly, yearly, with interval, count, until, weekdays, month days, exceptions and moved single copies). Shapes it cannot read safely are skipped and counted, never guessed.
- A feed that fails keeps its last good events for 24 hours, and the calendar's own row says which one failed and why. Other calendars keep working.
- A push happens only when the events really change, so a quiet calendar sends nothing.
- Data shape, per event: `{ id, cal, title, start, end, allDay, location }`. Timed events use UTC ISO strings. All-day events use `YYYY-MM-DD` with an exclusive end. `cal` is the 1-based number of the calendar in `calendars`, which carries `name`, `ok`, `error`, `count`, `skipped`, `updatedAt`. With `busy`, titles and places are replaced by "Busy" before the data leaves the reader.
- `GET /api/calendar` returns it, `POST /api/calendar/refresh` reads now and waits (up to 25 s), `./hub calendar status` and `./hub calendar refresh` wrap both.
- The TV widget is `app/widgets/calendar.js` (v0.11.1). It listens for `calendar`, keeps the last copy on the TV (`homeHub.calendar.v1`) and converts every time to `tz` itself.

## Tile layout from the Pi (built, v0.12.0)

So a visual editor (or `./hub layout set`) can rearrange the home screen without a commit to `app/config.js`.

- One more resource, `layout`: `{ layout: null | [ { widget, x, y, w, h } ] }`, the same shape as `HUB_CONFIG.layout` on the 12 x 6 grid. `null` means "use the hub's built-in layout", which stays `HUB_CONFIG.layout`. A state file from before this has none and reads as `null`; a damaged one also falls back to `null`.
- `GET /api/layout` answers `{ ok, rev, layout }`. `POST /api/layout` takes `{ layout: [...] }` or `{ layout: null }` and answers `{ ok, rev, changed, layout }`. It is strict: whole numbers, `x, y >= 0`, `w, h >= 1`, `x + w <= 12`, `y + h <= 6`, no overlaps, each widget once, ids of 1 to 32 `a-z 0-9 -`, at most 24 tiles; otherwise `400` naming the tile. Fields other than the five are dropped. Posting the same layout again changes nothing and does not raise `rev`.
- The TV (`app/hub.js`) starts with the copy it keeps in `homeHub.layout`, else `HUB_CONFIG.layout`, and listens for `layout`. A new layout is saved (or the copy cleared for `null`). If the same widgets stay on screen, their tiles just move. If the set of widgets changed it reloads once (a `sessionStorage` note keyed by the layout stops a loop). Nothing moves while a panel or a dashboard is open; it waits until it closes. The TV checks every entry the same way and skips bad ones; with nothing usable left it uses `HUB_CONFIG.layout`. Widgets the hub does not have are skipped, as before. `node dev/layout-test.js` tests all of this in a headless browser.
- `updatedAt` only moves when the events change, because a refresh that finds the same events pushes nothing. So the TV does not call data old just because `updatedAt` is old: it only says "Last updated …" when the line to the Pi is down (or it is showing its saved copy) and the last time it had the Pi is more than 30 minutes ago.

## How it is tested without your TV or Pi

On a laptop-style preview, with the Pi server running on the same machine:

1. No server set: the hub behaves exactly as on `main`.
2. Server set but not running: same, and no error is shown because it was never reached.
3. Server starts later: the hub connects by itself.
4. `show weather`, `home`, `say`: the screen follows.
5. A to-do added on the Pi appears on the screen; one ticked on the screen reaches the Pi.
6. **TV off then on:** close the page, add to-dos and send a `show` command, confirm the server answers at once and keeps nothing queued, open the page again: the new to-dos are there, the old command does not fire, nothing is blank.
7. Server stops while connected: the Clock page says so, the to-do list still works, changes are kept and sent when the server returns.
8. A screen the server refuses, and a wrong reply at the address: each shows its own words.
9. Old browser path: the same checks with the push line switched off, so the fallback is used.

Run them with `node dev/live-test.js`. What this cannot prove: the real TV's browser and your home network. The first run on the TV is still a real test.

---

## Reference for builders

Everything below is the contract between the hub (`app/`) and the Pi server (`pi/`).

### Pieces

- `pi/server.js`: Node 14 or newer, no dependencies. `require('./server').start(options)` returns `{ close(cb), port, tunnelPort }`; run directly it reads `pi/.env`.
- `pi/hubctl.js`: command line for the control API. Reads the token from `pi/.env`.
- `pi/awws.js`: checks, merges and describes the A World Worth Saving snapshot (the resource `awws`, see below). No network, no files; `server.js` stores what it returns.
- `app/live.js`: the hub's client. Plain ES5. Loads before `hub.js`, touches no DOM, does nothing until `HUB_LIVE.start()`.
- `HUB_CONFIG.live.server`: the server address. `''` = off. `?live=<address>` or `?live=off` in the page address overrides it (for the preview).

Every file must survive the others being an older version, because jsDelivr can serve a mix when the hub runs from the branch (only when GitHub couldn't be reached on a first start; see the README's Updating section): `hub.js` works without `live.js`, `todo.js` works without `ctx.live`, `live.js` is inert without `hub.js`.

### Now Playing (Spotify)

One more resource, `nowplaying`, from `pi/spotify.js`: `{ v: 1, configured, signedIn, state, problem, track, progressMs, at, device, shuffle, repeat, playedAt }`. `state` is `off` (no Spotify settings in `.env`), `signin` (set up, not signed in), `idle`, `playing`, `paused` or `error`. `track` is `null` or `{ id, kind: 'track'|'episode', title, artist, album, art, artSmall, artTiny, durationMs, explicit }` (https picture addresses only); it is kept through `idle` and `error` as "last played". `progressMs` was the song's position when the Pi looked; the TV adds the time since the data **arrived** (never the Pi's `at`, which is in the Pi's clock) while `playing`. The Pi pushes only when something changes (a new song, play or pause, a jump of more than 2.5 s, an error), so a song that plays through pushes nothing. The Pi asks Spotify every 5 s while a screen is on and music plays, 10 s when nothing plays, 60 s with no screen on, and backs off on errors and on Spotify's 429 answers. It carries no token, no secret and no client ID.

Control API: `GET /api/spotify` (`{ ok, spotify: { configured, signedIn, user, state, track, device, lastOkAt, ... } }`), `POST /api/spotify/login` (`{ url, redirectUri, minutes }`), `POST /api/spotify/code` (`{ input }`: the pasted address, a `?code=...&state=...` part or the bare code), `POST /api/spotify/logout`, `POST /api/spotify/refresh` (ask Spotify now). `GET /spotify/callback` on the main door (private addresses only) finishes a sign-in when a browser can reach it. The status call has a `spotify` section; the mailbox has `spotify.status`, `spotify.login`, `spotify.code`, `spotify.logout`. The sign-in (refresh token) lives only in `data/spotify.json`, mode 600.

### Settings (`pi/.env`)

| Name | Default | Meaning |
|---|---|---|
| `HUB_TOKEN` | none | Required for the control API. At least 24 characters. Without it the control API answers 503 |
| `HUB_PORT` | `8097` | Main door, all interfaces |
| `HUB_TV_IPS` | empty | Comma-separated addresses allowed to use the screen API. Empty = any private or loopback address |
| `HUB_ORIGINS` | `http://127.0.0.1:8081` | Page origins allowed by CORS (TizenBrew serves the hub from this one) |
| `HUB_TUNNEL_PORT` | empty | Side door on `127.0.0.1` only: control API and `/health`, nothing else |
| `HUB_DATA_DIR` | `./data` | Where `state.json` (and the Spotify sign-in) is kept |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | empty | The Spotify app's ID and secret. Both, or Now Playing says "Not set up" |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:<HUB_PORT>/spotify/callback` | Must match a Redirect URI in the Spotify app; `http://127.0.0.1...` or `https://...` only |

### State

`data/state.json`, written atomically (temp file, then rename):

```json
{ "epoch": "k3v9x2", "rev": 57, "resources": { "todo": { "rev": 57, "data": { "items": [] } } } }
```

- `rev` is one counter for the whole server. Every change adds 1 and stamps the changed resource.
- `epoch` is made once with the file. A new epoch means "forget what you knew, take everything".
- The resources are `todo`, `calendar`, `layout` and `awws`. A state file from before a resource existed loads fine: the missing one starts empty.
- A to-do item: `{ id, title, section: 'now'|'next'|'waiting', done, doneAt, createdAt, due?, notes? }`, the same shape the TV already saves. Order in `items` is display order. At most 200 items; title 1 to 80 characters; `notes` plain text of 1 to 300 characters (control characters and runs of spaces become one space; empty or `null` removes the field, so an item never holds empty notes); id up to 40 of `A-Z a-z 0-9 _ -`; one item at most 2000 bytes as JSON. Done items ticked more than 48 hours ago are dropped on the next write.

### Screen API (no token; private addresses only, or `HUB_TV_IPS`)

Refusals are `403 { ok: false, error: 'screen not allowed' }`.

`GET /live/state`

```json
{ "ok": true, "v": 1, "server": "0.3.0", "epoch": "k3v9x2", "rev": 57,
  "resources": { "todo": { "rev": 57, "data": { "items": [] } } } }
```

`GET /live/events` is the push line (`text/event-stream`). Events:

- `hello` `{ "v": 1, "epoch": "...", "rev": 57 }`, first on every connection.
- `change` `{ "resource": "todo", "rev": 58, "data": { "items": [] } }`, the whole resource each time.
- `command` `{ "id": "c9", "type": "show", "data": { "widget": "weather", "mode": "panel" } }`.
- `ping` `{ "rev": 58 }` every 20 seconds.

`GET /live/poll?epoch=&rev=&cursor=` is the fallback. It answers at once if `rev` or `epoch` differ from the server's or a command newer than `cursor` exists, otherwise it waits up to 25 seconds.

```json
{ "ok": true, "v": 1, "epoch": "...", "rev": 58, "resources": { }, "commands": [ ], "cursor": "c9" }
```

`resources` holds only resources newer than the `rev` sent (all of them on an epoch change). For this fallback alone the server remembers commands for 10 seconds, at most 20.

`POST /todo/ops` with `{ "ops": [ ... ] }` (at most 100), answered with `{ ok, rev, items }` and pushed to every screen:

- `{ "op": "add", "item": { ... }, "at": "top" | "end" }`. An id that exists is treated as `set`.
- `{ "op": "set", "id": "...", "fields": { ... }, "to": "end" }`. `to` is optional and moves the item to the end. An unknown id is ignored.
- `{ "op": "remove", "id": "..." }`.

Ops are applied in order and the last one to arrive wins. `set` merges `fields` into the item, so a change from the TV (`done`, `section`) keeps fields it did not send, `notes` among them; `{ "notes": null }` or `""` removes the notes.

### Control API (token; both doors)

`Authorization: Bearer <token>`. Wrong or missing: `401 { ok: false, error: 'wrong token' }`. Bodies are JSON, at most 8 KB, except `POST /api/awws`, which takes up to 64 KB (the snapshot inside it may be at most 48 KB). A body over the limit is refused with `413 { ok: false, error: 'request body too large (at most 8 KB)' }` (or `64 KB`) before it is read.

| Call | Body | Answer |
|---|---|---|
| `POST /api/command` | `{ type, data }` | `{ ok, delivered }`, the number of screens that got it |
| `GET /api/todo` | | `{ ok, rev, items }` |
| `POST /api/todo` | `{ title, section?, due?, notes? }` | `{ ok, rev, item }` |
| `POST /api/todo/ops` | `{ ops }` | `{ ok, rev, items }` |
| `GET /api/layout` | | `{ ok, rev, layout }` (`null` = the hub's built-in layout) |
| `POST /api/layout` | `{ layout: [...] \| null }` | `{ ok, rev, changed, layout }`; see "Tile layout from the Pi" |
| `GET /api/awws` | | `{ ok, rev, data, tz }`: the stored snapshot, and the hub's time zone so `./hub awws show` can write times the way `./hub calendar status` does |
| `POST /api/awws` | `{ snapshot: {...} \| null }` | `{ ok, rev, changed, bytes, accepted, cleared, rejected }`; see below |
| `GET /api/status` | | `{ ok, server, rev, epoch, uptime, screens: [{ since, via, address }] }` |
| `GET /health` (no token) | | `{ ok, server }` |

Command types: `show` `{ widget, mode?: 'panel'|'full' }`, `home`, `say` `{ text, seconds? }` (text up to 140 characters), `reload` (the hub restarts through the loader with `HUB_UPDATE.restart()`, so it lands on the newest commit; ignored in the first 30 seconds after loading). Anything else is `400`.

### The A World Worth Saving snapshot (`awws`)

The full contract, field by field, is [`docs/awws-snapshot.md`](awws-snapshot.md). In short:

- One more resource, `awws`: `{ v: 1, sentAt, receivedAt, todos?, handoffs?, outreach?, khaya?, pipeline?, money?, reach? }`. Before any snapshot, and after a clear, it is `{ v: 1, sentAt: null, receivedAt: null }`. It reaches screens like every other resource: in `/live/state`, as a `change` event and in the poll.
- `POST /api/awws` checks each section by itself. A section that breaks a rule is listed in `rejected` with the reason and keeps its stored copy; the others are stored. A section sent as `null` is removed (`cleared`). `{ snapshot: null }` removes everything.
- It answers `400` and changes nothing when the snapshot as a whole is wrong (not an object, `v` not 1, `sentAt` missing or more than 10 minutes ahead, no sections, over 48 KB as sent or once merged with what is stored) or every section in it was rejected. The error text names each rejected section and why.
- Every accepted snapshot is stored and pushed, even when no section changed: its new `sentAt` is what tells the TV the data is fresh. `changed` says whether any section's contents changed. Only a clear when nothing is stored leaves `rev` alone.
- The log notes each call without its contents, for example `control POST /api/awws -> 200 3 sections stored, 12.4 KB, rev 58`.

### The hub's client

States: `off`, `quiet` (never reached from this TV), `connecting`, `live`, `lost`, `refused`, `badreply`, `needsupdate`. `HUB_LIVE.status()` returns `{ state, text, since }`; `text` is what the About panel shows for live updates and is `''` for `off`, `quiet` and `connecting`.

1. `GET /live/state`, 8 second limit. Success: hand each resource to its listeners, then subscribe.
2. Subscribe with `EventSource`. `hello` with a different epoch or a higher rev than step 1 saw: go to 1. `change`: apply if its rev is newer. `command`: run once per id. `ping` with a higher rev: go to 1. Nothing for 50 seconds: treat as dropped.
3. Dropped or failed: wait 2, 5, 10, 30, then 60 seconds (5 minutes for `refused`, `badreply`, `needsupdate`), then 1. Becoming visible again retries at once.
4. If step 1 works but the push line fails three times running, use `/live/poll` instead for the rest of this run.

Widgets get `ctx.live` (absent when `live.js` is): `status()`, `get(resource)`, `on(resource, fn)`, `onStatus(fn)`, `post(path, body, cb)`.

To-do on the TV: local storage stays the working copy, so the list is instant and survives the Pi being away. Each change is applied locally, then queued in `homeHub.todo.outbox` and sent as ops. On connect: send the outbox first, then take the server's list. The first time this TV meets a given epoch it uploads its own items as `add` ops, so neither side's items are lost.

### Decisions made while building

- `start()` also returns `ready`, a Promise that settles once the doors are listening.
- The screen API answers only when the request's `Host` is an IP address, `localhost` or a `.local` name, and `POST /todo/ops` refuses an `Origin` that is not on the allowed list. Both stop a web page on another site from reaching the lists through a browser at home.
- A poll with no `cursor` never receives commands. The hub sends its first poll without `rev`, which the server answers at once with a cursor.
- To-do ops are all or nothing: a bad op rejects the whole batch with `400` and names it as `(op N)`. A batch that changes nothing does not raise `rev`.
- `add` without `at` goes to the end. `POST /api/todo` adds at the top, as the TV does.
- Before this TV has ever reached the server, only "unreachable" is silent. A refusal or a wrong reply shows its words even on first contact, because something did answer.
- A dropped push line alone does not show `lost`. That appears only when the full-picture request that follows also fails.
- On first contact with a server, the TV's own items are added after the server's, in the TV's order.
