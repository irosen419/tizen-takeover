# Home Hub live server: notes for Claude on the Pi

This folder runs the server that feeds the Home Hub screen on the owner's TV.
When the owner asks to change what the TV shows, or to add, tick or remove a
to-do, run `./hub ...` from this folder and report the one-line result back.

## Commands (one example each)

- Open a widget: `./hub show weather` (add `--full` for full screen)
- Close whatever is open: `./hub home`
- Short message on the TV: `./hub say "Dinner in 10" --seconds 8`
- Load the hub afresh: `./hub reload`
- Add a to-do: `./hub todo add "Buy milk" --level must --due 2026-12-24 --notes "Oat, not dairy"` (level, due and notes are optional; levels are `must`, `optional` (the default) and `passive` (a reminder shown on the TV under "Coming up" from 2 days before its due date); notes are plain text up to 300 characters; `--section` is still taken but no longer shown)
- Change a to-do's level: `./hub todo level "Buy milk" passive` (id or exact title)
- When a passive to-do shows under "Coming up": `./hub todo lead "School meeting" 3` (whole days before its due date, 0 to 30; 0 = only on the day; `--clear` goes back to 2), or `--lead 3` on `./hub todo add`
- See the to-do list with ids and notes: `./hub todo list`
- Set or change a to-do's notes: `./hub todo notes "Buy milk" "Oat, not dairy"` (id or exact title); `--clear` removes them
- Tick a to-do: `./hub todo done "Buy milk"` (id or exact title)
- Remove a to-do: `./hub todo remove "Buy milk"` (id or exact title)
- Calendars and the next event: `./hub calendar status`
- Read the calendars again now: `./hub calendar refresh`
- Tile layout on the home screen: `./hub layout show`; a new one: `./hub layout set layout.json` (a JSON list of `{"widget":"weather","x":0,"y":0,"w":3,"h":2}` on the 12 x 6 grid; `-` reads it from input); back to the built-in one: `./hub layout reset`
- A World Worth Saving snapshot: `./hub awws show` (when it was sent, its size, one line per section); a new one: `./hub awws set snapshot.json` (the snapshot itself, or `{"snapshot": {...}}`; `-` reads it from input; shape in `docs/awws-snapshot.md`); remove it: `./hub awws clear`
- Budget snapshot (totals from the budget app on this Pi): `./hub budget show` (dates, counts and states, never amounts or labels); by hand `./hub budget set budget.json` (shape in `docs/budget-snapshot.md`); remove it: `./hub budget clear`
- What is playing on Spotify, and sign-in: `./hub spotify status`; one-time sign-in `./hub spotify login` (prints a link, then asks for the pasted address) or `./hub spotify code "<address>"`; `./hub spotify logout`
- The room's lights (Ambience, through Home Assistant; server 0.7.0): `./hub ambience status`; the ids: `./hub ambience scenes`; a scene: `./hub ambience scene chill`; one light: `./hub ambience light geeni 40` (or `on`/`off`); the plant wall: `./hub ambience mood dim`; new lights and scenes: `./hub ambience set my-lights.json` (shape in `ambience.example.json`); `./hub ambience reset`
- TV shows on the Schedule (Entertainment panel): `./hub shows list`; add one `./hub shows add "Stick" --service "Apple TV"` (`--id 12345` for its TVmaze number when the name finds the wrong show, `--watch Hulu` to open another app than the badge, `--also "Hulu,Peacock"` for other apps that carry it, `--via "Prime Video"` when the service is billed through Prime Video Channels); `./hub shows remove "Stick"`; ask TVmaze now: `./hub shows refresh` (it also does so every 6 hours); the owner marks episodes watched on the TV himself ("Did you finish?" and the check on a row), so use these only for a mistake: `./hub shows watched "Stick" S3E4` (leave `S3E4` out: the earliest episode out in the last week that is not marked) and `./hub shows unwatch "Stick" S3E4` (server 0.8.0)
- What the TV's watch link test found (which deep links open a title): `./hub linktests`
- What plays anywhere (Echo speakers through Home Assistant, and Spotify), for the test widget All sounds: `./hub allsounds status` (state, source, speaker, title and artist only)
- Is the server up, which screens are on: `./hub status`
- Is the Claude mailbox (Cloudflare R2) connected: `./hub mailbox status`
- The server's recent log lines: `./hub log` (last 50); only problems: `./hub log --errors`; more: `./hub log --lines 120` (1 to 200)
- All commands: `./hub help`

Widget ids for `./hub show` are `weather`, `todo`, `calendar`, `entertainment`, `nowplaying`, `today` (the clock), `awws`, `awws-visits`, `awws-agenda`, `awws-todo`, `awws-reach`, `awws-money` (Earned vs spent), `budget-room` (Daily room), `budget-card` (Card day), `budget-goals` (Goals), `budget-lab` (Budget lab: the pace streak and the cap slider from hub v0.29.3, the merchants' cuts and Put it somewhere from v0.29.4; the runway chart to card day at full screen from v0.29.5; an older hub ignores the id) and `allsounds` (All sounds, a test widget: what plays on any speaker; only on the "All sounds test" layout, from v0.28.16). The layout switcher on the TV has an "AWWS money" and a "Budget" layout with these. A layout may also place the other tiles in `HUB_CONFIG.layout` (`app/config.js`), such as `today`; run `./hub layout show` first and change only what was asked.

## From the cloud: the Claude mailbox

A Claude thread in the cloud cannot reach the Pi. It sends the same commands through the Cloudflare R2 bucket `home-hub-mailbox`; the Pi checks it every 10 seconds (setup: README.md, "Claude mailbox"). Use curl through the proxy (no key needed on your side; the account id is not secret). The Cloudflare MCP `execute` tool gets 403 on R2 objects, so do not use it for this.

```sh
B=https://api.cloudflare.com/client/v4/accounts/f24d1741cf57727291b631def49ffacb/r2/buckets/home-hub-mailbox/objects

# 1. Is the Pi alive? "updated" should be under ~2 minutes old.
curl -sS "$B/status.json"

# 2. Send a command. The id is 6-64 of A-Z a-z 0-9 _ - and is also the file name.
ID=c$(date +%s)$RANDOM
printf '{"id":"%s","created":"%s","cmd":"todo.add","args":{"title":"Buy milk","section":"now"}}' \
  "$ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > cmd.json
curl -sS -X PUT "$B/inbox%2F$ID.json" -H 'content-type: application/json' --data @cmd.json

# 3. Wait about 10-20 seconds, then read the reply (an error JSON means "not there yet").
curl -sS "$B/outbox%2F$ID.json"
```

Write `cmd.json` in your scratchpad folder. The reply is `{"id", "cmd", "ok", "state", "message", "data", "started", "finished"}`. Wait until `"state": "done"` (`"running"` means it is still going; `calendar.refresh` can take 25 seconds). Report `message` to the owner: it is the same text `./hub` prints. `ok: false` with `Rejected: ...` means it was never run; fix what it says and send a new id. No reply after a minute: check `status.json`; if it is old, the Pi or its internet is down, so tell the owner rather than resending (a resent command could run twice once the Pi is back).

### Several to-dos at once

To add more than one to-do, do not send them one by one and wait for each reply. `dev/todo-bulk.sh` checks the list, writes all the commands, sends them back to back and prints one line per item. The Pi runs up to 20 commands per poll, so they all land within about 10-20 seconds. The list reads top-down in the order you give. Add `--dry-run` to see the commands without sending.

```sh
printf '%s' '[{"title":"Call the dentist","level":"must","due":"2026-11-20"},"Buy milk","Renew passport"]' | dev/todo-bulk.sh -
```

Commands and args (`args` may be left out when empty; unknown args are refused):

- `show {"widget": "weather", "full": true}` (widgets: weather, todo, calendar, entertainment, nowplaying, today, awws, awws-visits, awws-agenda, awws-todo, awws-reach, awws-money, budget-room, budget-card, budget-goals, budget-lab, allsounds), `home`, `reload`
- `say {"text": "Dinner in 10", "seconds": 8}` (text up to 140 characters, seconds 1-60)
- `todo.add {"title": "Buy milk", "level": "must", "due": "2026-12-24", "notes": "Oat, not dairy"}` (only `title` is needed; `level` is `must`, `optional` or `passive`, optional when left out, and needs server 0.6.0: an older server refuses it, so there put `[level:must]` or `[level:passive]` at the end of `notes` instead, which the TV reads and hides; `notes` is plain text up to 300 characters and shows under the title on the TV; leave it out when there is nothing to say), `todo.list` (its `data.items` carry `notes` when an item has them)
- `todo.level {"title": "Buy milk", "level": "passive"}` or `{"id": "...", "level": "must"}` (server 0.6.0) changes an item's level
- `todo.lead {"title": "School meeting", "lead": 3}` or `{"id": "...", "lead": 0}` (server 0.7.0) sets how many days before its due date a passive item shows under "Coming up" (whole number 0 to 30; `null` goes back to 2). `todo.add` takes `lead` too. An older server refuses `lead`, so there put `[lead:3]` in `notes` instead (next to `[level:passive]`); the TV reads it and hides it, and a `lead` field wins over the tag. `todo.list` items carry `lead` when they have one
- `todo.notes {"title": "Buy milk", "notes": "Oat, not dairy"}` or `{"id": "...", "notes": "..."}` (exactly one of id and title) sets an item's notes; `"notes": ""` or `null` removes them
- `todo.done {"title": "Buy milk"}` or `{"id": "..."}` (exactly one), `todo.remove` the same
- `calendar.status`, `calendar.refresh`
- `layout.show`, `layout.set {"layout": [{"widget":"weather","x":0,"y":0,"w":3,"h":2}, ...]}`, `layout.reset`
- `awws.set {"snapshot": {"v": 1, "sentAt": "2026-11-16T15:10:00Z", "todos": {...}}}` (`{"snapshot": null}` removes it all, a section sent as `null` removes that section), `awws.show` (counts and times only, never the titles), `awws.clear`. The whole command file must stay under 64 KB and the snapshot under 48 KB. `data` of `awws.set` lists `accepted`, `cleared` and `rejected` (with the reason for each); a rejected section keeps its last good copy on the Pi
- `budget.show` (dates, counts and states only), `budget.set {"snapshot": {...}}` (`null` removes it), `budget.clear`. The budget app on the Pi normally sends this itself with the local token, so it never travels through the mailbox; use these only when the owner asks
- `spotify.status`, `spotify.login` (the sign-in link to give the owner), `spotify.code {"address": "<the pasted address>"}`, `spotify.logout`. Signing in: run `spotify.login`, give the owner the `url` from its `message` to open and agree to, ask them to paste back the address of the error page they land on (it contains `?code=`), then run `spotify.code` with it and report `message`. The pasted code is single-use and useless without the secret on the Pi, so it is fine in chat; never ask for or print the client secret.
- `log.tail {"lines": 50, "errors": false}` (both optional; lines 1-200, default 50; `errors: true` for problems only): the server's recent log lines. The text is scrubbed on the Pi before it reaches the bucket (IP addresses become `[address]`; calendar names, the Spotify name, the bucket name and the R2 host become `[name]`). `message` is one line such as `50 lines, 3 problems in the last 24 hours.`; `data` is `{"lines": [{"t", "text", "level"}], "errors24h"}`. `status.json` also carries `log.errors24h` and `log.lastErrorAt` (a count and a time, no text), so check that first
- `ambience.status`, `ambience.scene {"id": "chill"}`, `ambience.light {"id": "geeni", "pct": 40}` (or `"on": true|false`; `pct` 1-100), `ambience.mood {"id": "dim"}`, `ambience.set {"config": {"lights": [...], "scenes": [...], "moods": [...]}}` (at most 8 KB; shape in `pi/ambience.example.json`), `ambience.reset`. Needs server 0.7.0. A scene answers `applied`, `partly applied` (it names the lights that didn't answer: a Sengled bulb dropping is normal and outside this code; the scene still applied to the others) or `did not apply`. Use only the ids that `ambience.status` or `./hub ambience scenes` list
- `shows.list` (its `data.shows` carry name, service, running, next, problem), `shows.add {"name": "Stick", "service": "Apple TV", "tvmazeId": 12345, "serviceOverride": "Hulu", "alsoOn": ["Hulu"], "via": "Prime Video"}` (only `name` is needed; `via` only when the owner says the service comes through another app; adding a show already there updates it), `shows.remove {"name": "Stick"}`, `shows.set {"shows": [{"name": "Stick", "service": "Apple TV"}, ...]}` (replaces the whole list, at most 40), `shows.watched {"name": "Stick", "episode": "S3E4"}` (`episode` may be left out: the earliest episode out in the last week that is not marked) and `shows.unwatch {"name": "Stick", "episode": "S3E4"}` (server 0.8.0; the owner marks watched on the TV himself, so use these only to correct a mistake), `shows.refresh` (asks TVmaze now and waits up to 25 seconds, like `calendar.refresh`)
- `linktests.show`: the watch link test answers, newest first (`data.results`: `{ id, app, name, outcome, op, uri?, data?, at }`, outcome `title`, `app`, `nothing` or `error`)
- `allsounds.status`: what plays anywhere (the All sounds test widget): state, source, speaker, title and artist only. Never the Home Assistant token or address.
- `translate.status` (server 0.12.0): Spanish translations of the owner's own text: on/off, lines saved, the daily limit, and new lines, Gemini calls, tokens and estimated cost for today, this month and all time (counts only, never the texts)
- `status`, `ping` (answers with the server version)
- `restart`: the server stops after replying and Docker starts it again with the code already on the Pi. It does not `git pull`; the owner does that on the Pi.

Working signal: before a job that will take more than a few seconds and will end by changing the to-dos (kind `todo`), the calendar (`calendar`) or the A World Worth Saving snapshot (`awws`), send `say {"text": "hub:working <kind> <seconds>"}` with a generous time, for example `say {"text": "hub:working awws 300"}`. The TV then shows a small quiet "working" chip on that tile. It clears itself when the data lands (it turns into the usual "new data" chip when something changed), when the time is up (10 to 900 seconds, 120 if you leave the number out), or when you send `say {"text": "hub:working <kind> done"}`, which you should do when the job ends with no change (a calendar refresh or a to-do list that finds nothing new sends the TV nothing, so only `done` or the time ends it). Only use this once the TV runs a hub version that knows the signal (v0.28.7 or later; check the About panel): an older hub shows the text as a message on the screen.

Motion: if the TV's About panel says `extras off (slow screen)` and the owner wants to see the chips or the character anyway, send `say {"text": "hub:motion push"}` (that session only; a reload goes back to auto). `say {"text": "hub:motion auto"}` forgets the step-down and lets the TV time itself again. Needs hub v0.29.11 or later.

Other calls: list replies `curl -sS "$B?prefix=outbox/"` (an array of `{key, ...}`); delete an object with `curl -sS -X DELETE "$B/inbox%2F$ID.json"` (only to take back a command the Pi has not picked up yet). Results are kept 7 days. No git, docker or shell commands can be sent this way, by design.

## Rules

- Never print, copy, echo or paste the token or the `HUB_MAILBOX_` keys, and never read `.env` aloud. `./hub` reads it for you.
- `./hub token` is only for first setup. If it says a token already exists, leave it.
- "No screen is listening" is not an error: the TV is off or Home Hub is closed. Say so plainly.
- If the server is not running, try `docker compose up -d` from this folder, then `./hub status`. If it still fails, show the last lines of `docker compose logs hub` (they never contain the token).
- Never print, copy, echo or paste `SPOTIFY_CLIENT_SECRET` or anything in `data/spotify.json`.
- Never print, copy, echo or paste `HA_TOKEN`, and never put Home Assistant entity ids, `HA_URL` or `WLED_URL` in a message, a commit or a public file: they belong only in `.env` and `data/ambience.json` on the Pi.
- Never print, copy, echo or paste `HA_TOKEN` (the Home Assistant token), and never log what plays (titles, speaker names).
- Never show, print, copy or log a calendar link (the `CALENDAR_*_URL` lines in `.env`). They are secret keys to the owner's calendars. If one may have leaked, tell the owner to reset it in Google Calendar (README.md, "If a secret address leaks").
- To put an event on the TV, add it through the Google Calendar connector, then run `./hub calendar refresh`. Google may take a while to include it; if it is not there yet, say so and try again in a few minutes.
- Do not edit `data/state.json` by hand while the server runs; use `./hub todo ...`.
- The A World Worth Saving snapshot must never contain email addresses, links, notes text or librarians' last names. The Pi refuses a section with an email address or a link, but it cannot spot notes or names, so leave them out yourself. The owner said yes to money figures on the TV on 2026-11-16, so the `money` section may be sent. To keep money off the TV (for guests, say), set `showMoney: false` under `widgets.awws` in `app/config.js`; the Pi still stores the section.
- The budget snapshot carries totals only: never a balance, a transaction list or an amount on an alert, and never email addresses or links. The owner said yes on 2026-11-17 to the names of his top 5 merchants with their month-to-date totals (the `merchants` section) and to the runway sent as headroom (checking minus what the cards owe minus the floor), never checking or a card balance by itself. Do not read budget figures out of `data/state.json` or send them anywhere; `./hub budget show` is enough to say whether it is up to date. To hide the budget on the TV, set `show: false` under `widgets.budget` in `app/config.js`.
- The show list is the owner's own; change it only when asked. Hulu titles open in Disney+ on the TV by default (`watchAliases` under `widgets.entertainment` in `app/config.js`); give a show `alsoOn` when the owner says it is on another app too. The schedule comes from TVmaze (public, no key); there is no TMDB key on this Pi.
- Logs must never name a show, an episode title, a link, a token or an app title: the Pi's own lines only count (`shows refresh: 4 of 4 shows read`, `screen marked an episode watched`, `screen took a watched mark off an episode`). Keep it that way in anything you add.
- Setup and troubleshooting are in `README.md` in this folder.
