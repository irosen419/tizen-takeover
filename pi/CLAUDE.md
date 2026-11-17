# Home Hub live server: notes for Claude on the Pi

This folder runs the server that feeds the Home Hub screen on the owner's TV.
When the owner asks to change what the TV shows, or to add, tick or remove a
to-do, run `./hub ...` from this folder and report the one-line result back.

## Commands (one example each)

- Open a widget: `./hub show weather` (add `--full` for full screen)
- Close whatever is open: `./hub home`
- Short message on the TV: `./hub say "Dinner in 10" --seconds 8`
- Load the hub afresh: `./hub reload`
- Add a to-do: `./hub todo add "Buy milk" --section now --due 2026-12-24 --notes "Oat, not dairy"` (section, due and notes are optional; sections are `now`, `next`, `waiting`; notes are plain text up to 300 characters)
- See the to-do list with ids and notes: `./hub todo list`
- Set or change a to-do's notes: `./hub todo notes "Buy milk" "Oat, not dairy"` (id or exact title); `--clear` removes them
- Tick a to-do: `./hub todo done "Buy milk"` (id or exact title)
- Remove a to-do: `./hub todo remove "Buy milk"` (id or exact title)
- Calendars and the next event: `./hub calendar status`
- Read the calendars again now: `./hub calendar refresh`
- Tile layout on the home screen: `./hub layout show`; a new one: `./hub layout set layout.json` (a JSON list of `{"widget":"weather","x":0,"y":0,"w":3,"h":2}` on the 12 x 6 grid; `-` reads it from input); back to the built-in one: `./hub layout reset`
- A World Worth Saving snapshot: `./hub awws show` (when it was sent, its size, one line per section); a new one: `./hub awws set snapshot.json` (the snapshot itself, or `{"snapshot": {...}}`; `-` reads it from input; shape in `docs/awws-snapshot.md`); remove it: `./hub awws clear`
- What is playing on Spotify, and sign-in: `./hub spotify status`; one-time sign-in `./hub spotify login` (prints a link, then asks for the pasted address) or `./hub spotify code "<address>"`; `./hub spotify logout`
- Is the server up, which screens are on: `./hub status`
- Is the Claude mailbox (Cloudflare R2) connected: `./hub mailbox status`
- All commands: `./hub help`

Widget ids for `./hub show` are `weather`, `todo`, `calendar`, `entertainment`, `nowplaying`, `today` (the clock), `awws`, `awws-visits`, `awws-agenda`, `awws-todo` and `awws-reach`. A layout may also place the other tiles in `HUB_CONFIG.layout` (`app/config.js`), such as `today`; run `./hub layout show` first and change only what was asked.

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

Commands and args (`args` may be left out when empty; unknown args are refused):

- `show {"widget": "weather", "full": true}` (widgets: weather, todo, calendar, entertainment, nowplaying, today, awws, awws-visits, awws-agenda, awws-todo, awws-reach), `home`, `reload`
- `say {"text": "Dinner in 10", "seconds": 8}` (text up to 140 characters, seconds 1-60)
- `todo.add {"title": "Buy milk", "section": "next", "due": "2026-12-24", "notes": "Oat, not dairy"}` (only `title` is needed; `notes` is plain text up to 300 characters and shows under the title on the TV; leave it out when there is nothing to say), `todo.list` (its `data.items` carry `notes` when an item has them)
- `todo.notes {"title": "Buy milk", "notes": "Oat, not dairy"}` or `{"id": "...", "notes": "..."}` (exactly one of id and title) sets an item's notes; `"notes": ""` or `null` removes them
- `todo.done {"title": "Buy milk"}` or `{"id": "..."}` (exactly one), `todo.remove` the same
- `calendar.status`, `calendar.refresh`
- `layout.show`, `layout.set {"layout": [{"widget":"weather","x":0,"y":0,"w":3,"h":2}, ...]}`, `layout.reset`
- `awws.set {"snapshot": {"v": 1, "sentAt": "2026-11-16T15:10:00Z", "todos": {...}}}` (`{"snapshot": null}` removes it all, a section sent as `null` removes that section), `awws.show` (counts and times only, never the titles), `awws.clear`. The whole command file must stay under 64 KB and the snapshot under 48 KB. `data` of `awws.set` lists `accepted`, `cleared` and `rejected` (with the reason for each); a rejected section keeps its last good copy on the Pi
- `spotify.status`, `spotify.login` (the sign-in link to give the owner), `spotify.code {"address": "<the pasted address>"}`, `spotify.logout`. Signing in: run `spotify.login`, give the owner the `url` from its `message` to open and agree to, ask them to paste back the address of the error page they land on (it contains `?code=`), then run `spotify.code` with it and report `message`. The pasted code is single-use and useless without the secret on the Pi, so it is fine in chat; never ask for or print the client secret.
- `status`, `ping` (answers with the server version)
- `restart`: the server stops after replying and Docker starts it again with the code already on the Pi. It does not `git pull`; the owner does that on the Pi.

Working signal: before a job that will take more than a few seconds and will end by changing the to-dos (kind `todo`), the calendar (`calendar`) or the A World Worth Saving snapshot (`awws`), send `say {"text": "hub:working <kind> <seconds>"}` with a generous time, for example `say {"text": "hub:working awws 300"}`. The TV then shows a small quiet "working" chip on that tile. It clears itself when the data lands (it turns into the usual "new data" chip when something changed), when the time is up (10 to 900 seconds, 120 if you leave the number out), or when you send `say {"text": "hub:working <kind> done"}`, which you should do when the job ends with no change (a calendar refresh or a to-do list that finds nothing new sends the TV nothing, so only `done` or the time ends it). Only use this once the TV runs a hub version that knows the signal (the version this ships in, vX.Y.Z; check the About panel): an older hub shows the text as a message on the screen.

Other calls: list replies `curl -sS "$B?prefix=outbox/"` (an array of `{key, ...}`); delete an object with `curl -sS -X DELETE "$B/inbox%2F$ID.json"` (only to take back a command the Pi has not picked up yet). Results are kept 7 days. No git, docker or shell commands can be sent this way, by design.

## Rules

- Never print, copy, echo or paste the token or the `HUB_MAILBOX_` keys, and never read `.env` aloud. `./hub` reads it for you.
- `./hub token` is only for first setup. If it says a token already exists, leave it.
- "No screen is listening" is not an error: the TV is off or Home Hub is closed. Say so plainly.
- If the server is not running, try `docker compose up -d` from this folder, then `./hub status`. If it still fails, show the last lines of `docker compose logs hub` (they never contain the token).
- Never print, copy, echo or paste `SPOTIFY_CLIENT_SECRET` or anything in `data/spotify.json`.
- Never show, print, copy or log a calendar link (the `CALENDAR_*_URL` lines in `.env`). They are secret keys to the owner's calendars. If one may have leaked, tell the owner to reset it in Google Calendar (README.md, "If a secret address leaks").
- To put an event on the TV, add it through the Google Calendar connector, then run `./hub calendar refresh`. Google may take a while to include it; if it is not there yet, say so and try again in a few minutes.
- Do not edit `data/state.json` by hand while the server runs; use `./hub todo ...`.
- The A World Worth Saving snapshot must never contain email addresses, links, notes text or librarians' last names. The Pi refuses a section with an email address or a link, but it cannot spot notes or names, so leave them out yourself. The owner said yes to money figures on the TV on 2026-11-16, so the `money` section may be sent. To keep money off the TV (for guests, say), set `showMoney: false` under `widgets.awws` in `app/config.js`; the Pi still stores the section.
- Setup and troubleshooting are in `README.md` in this folder.
