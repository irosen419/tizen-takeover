# Home Hub widget plans

This is the plan for the seven Home Hub widgets not built yet, written Nov 15, 2026.

Update, later on Nov 15: Weather and the To-do list kept on the TV were built overnight and are merged (v0.8.0). Their sections below are kept as the record of what was planned. The other five widgets are still to do.

Two can be built tonight with nothing from you: Weather, and a To-do list kept on the TV.

One 20-minute job from you unlocks most of the rest: installing the hub backend on the Pi (the Raspberry Pi on your home network).

After that, Calendar and Now Playing each need one short sign-up, and the morning to-do list needs a yes or no on a bridge.

Ambiance waits on the plant wall lights, and Mirror waits on a camera.

## At a glance

| Widget | First version | Data source | Needs from you | Effort |
|---|---|---|---|---|
| A World Worth Saving (AWWS) | Launcher with read-only to-do board | Pi, fed by the bridge | Pi install, bridge yes | Small to Medium |
| To-do | List kept on the TV | TV storage | Nothing | Medium |
| Calendar | Today's agenda; Day, Week, Month | Google Calendar via Pi | Pi install, calendar links | Medium to Large |
| Now Playing | What Spotify is playing | Spotify via Pi | Pi install, Spotify app | Small to Medium |
| Weather | Now, today, the week | Open-Meteo, from the TV | Nothing | Medium |
| Ambiance | Pick a plant wall mood | Light controller | Lights up, its address | Medium |
| Mirror | Live flipped camera picture | Camera on a Pi | Camera purchase | Large |

Effort uses one scale. Small is under half a build session. Medium is one build session (one overnight thread). Large is more than one session, or it waits on hardware.

## What I need from you

| Ask | Unlocks | Time it takes | When it matters |
|---|---|---|---|
| Nothing | Weather, To-do (TV list) | 0 | Tonight |
| Read me the two small lines at the bottom of the Today tile | Browser age: styling limits, safe https | 1 min | Any time |
| Say which city the weather should use, whether it may be written in the public settings file, and confirm Fahrenheit | Weather that never has to guess the place | 1 min | After the weather PR |
| Install the hub backend on the Pi (three commands), or link your computer so Claude can | Calendar, Now Playing, to-do sync, AWWS board | About 20 min | Before any of those |
| Paste the secret iCal link for each calendar into the Pi's settings file | Calendar | 5 min | With the backend |
| Spotify: create a developer app (Premium account), run the helper, click Agree | Now Playing | 10 min, Agree again every 6 months | With the backend |
| Yes or no on the cloud to home bridge (recommended: Cloudflare Worker) | Morning to-do and AWWS board on the TV | 5 min | After the backend |
| Tell me when the plant wall lights are up, and the controller's address | Ambiance | 5 min | When lights are installed |
| Say where the Pi sits relative to the TV, try the free iPhone test if you like, then buy a camera (about $25 to $35) | Mirror | A purchase | Last |

PR means pull request: a proposed change you review before it goes live.

## Ranking: what can be built with no input

Weather and To-do are the best two to build first. They are the only two that end the night working end to end with nothing from you, and they touch different code.

| Rank | Widget | How ready |
|---|---|---|
| 1 | Weather | Needs nothing; finds the city itself; first live test is on the TV |
| 2 | To-do (TV list) | Needs nothing; fully testable in the preview |
| 3 | Ambiance | Code can be finished; needs the lights to prove |
| 4 | A World Worth Saving | Launcher only until bridge and backend exist |
| 5 | Calendar | Needs your calendar link and the backend |
| 6 | Now Playing | Needs your Spotify app and the backend |
| 7 | Mirror | Needs a camera choice and purchase |

So the two build threads can run at once, each owns its own files and neither edits `planned.js` or appends to `style.css`.

- Weather owns `weather.js`, `weather.css`, new icons in `icons.js`, and the `/fetch` route in `service.js` plus its twin in `dev/preview.js`.
- To-do owns `todo.js`, `todo.css`, and the `hub.js` changes (typing mode, `sendJSON`, cache).
- Both add one script tag, one link tag and a config block. The second PR to merge rebases and takes the next version (`package.json` and `BUILD` in `hub.js`).
- Each PR is merged only on your approval, then every changed file is purged from jsDelivr (the public service that serves the hub's files). A partial purge gave a blank screen on Nov 15.

## Ground rules for every widget

Every widget follows your standing preferences: polished and not generic, with no lazy card grids. Each row leads with its key attribute, such as the time for an event, the temperature for an hour, or the owner and when for a task.

Layouts survive text 25% longer than English (Spanish) and never clip accents. A data widget never leaves its tile empty; it shows loading, live, stale ("as of 7:10 AM"), needs setup, or error.

Nothing secret ever goes in the repo, because the repo is public and jsDelivr serves it publicly. Secrets live on the Pi.

## Shared groundwork

### G1. Hub backend on the Pi

One small service on the Pi holds every secret and hands the TV plain data. Claude can write and test it in the cloud with no input, but cloud sessions cannot reach your home network, so installing it is your job (about three commands over SSH, a remote login), or Claude's on a thread linked to your computer.

The TV cannot call Spotify or Google itself, because the repo is public and the TV has no safe place for a secret. Home Assistant cannot serve the data either: its webhooks need no token but cannot hand data back, and reading from it needs a long-lived token with your full rights. Sources: [webhooks](https://www.home-assistant.io/triggers/webhook/), [REST API](https://developers.home-assistant.io/docs/api/rest/) (the "cannot hand data back" part is from the docs' silence, not a stated rule).

Build notes:

- New `pi/` folder. Runs in Docker next to Home Assistant, port `8097`, few dependencies (the calendar needs a parsing library).
- Header `Access-Control-Allow-Origin: http://127.0.0.1:8081`; home network only. Widgets call it only via `ctx.pi(':8097/...')`.
- Secrets in `.env` on the Pi; ship `.env.example`. Install: clone, `cp .env.example .env`, `docker compose up -d`.
- Routes: `/health`, `/calendar`, `/nowplaying`, `/todo`, `/awws/todos`, later `/mirror/start`, `/mirror/stop`.

### G2. Small additions to the hub core

Today the hub cannot send data, a text box in a panel cannot be typed in, and nothing keeps a widget's last good answer. If the hub fails at start, the screen goes blank with no message, as happened on Nov 15. A start-up guard for that was offered on Nov 15 and is not approved, so it is a recommendation.

Build notes:

- `ctx.sendJSON(method, url, body, timeoutMs, cb)`, for To-do sync, Ambiance and AWWS ticks.
- Typing mode: keys go to a focused text box; Back or the keyboard's Done and Cancel leave it. Today arrows, Enter and Backspace are swallowed and Backspace means Back.
- `ctx.cache(key)` in local storage with a saved-at time; `ctx.every(ms, fn)` that pauses while the hub is hidden.
- Shared tile states: `loading`, `live`, `stale`, `needs setup`, `error`.
- Start-up guard: inline script in `index.html` that shows a message if `hub.js` fails or files are from mixed versions.

### G3. The bridge from Claude's lists to your home

This needs your decision. Your morning Tasks list and the AWWS board live in claude.ai storage that only a signed-in claude.ai page can read, and the TV cannot open those pages (claude.ai refuses to be shown inside another page, header `frame-ancestors 'self'`, checked Nov 15, 2026; the pages also need a newer browser).

It is a privacy choice, because task text would leave claude.ai for your Cloudflare account and your Pi.

| Option | How it works | Catch |
|---|---|---|
| Cloudflare Worker (recommended) | A tiny program on your Cloudflare account holds a copy; the Pi reads it | You say yes and paste one secret |
| Private GitHub repo | The repo is the drop point | Pi needs a GitHub token; every sync is a commit |
| No bridge | TV lists stay separate | TV to-do is not your morning list |

Build notes:

- Worker with key-value storage and one shared secret, also in the Pi's `.env`.
- A scheduled Claude task copies the lists about every 30 minutes and after each morning brief; the Pi reads every few minutes. TV ticks travel back the same way and the task applies them.

## A World Worth Saving

### First version

A tile that opens a launcher for your dashboards, starting with the AWWS to-do board, redrawn by the hub and read-only. The tile shows "Ian now" and "Claude now" counts and your next item.

The board has the summary strip, rows grouped by workstream or by Now, Next and Later, and an owner filter. Each row leads with owner and when, then title, due date and who it waits on; full screen shows two columns.

Adding items, "Start with Claude" (no clipboard or chat on a TV), notes and handoffs are left out. Handoffs show only as a count line, such as "2 handoffs open, 1 blocked".

### Where the data comes from

The "AWWS To-Do Board" page in claude.ai, copied by the bridge (G3) and served by the Pi backend (G1).

### What it needs from you

The bridge decision and the backend installed. Read-only first is recommended, with ticks from the TV next.

### Effort

Launcher Small, board Medium, bridge and scheduled copy Medium (shared with To-do).

### Risks

- Data is as fresh as the copy interval, aiming for 30 minutes or better.
- A TV tick can clash with a Claude edit; the newest change wins and a tick never deletes.
- Long titles need wrapping rules at TV distance.
- Each other dashboard (traffic, spend, socials planner) needs its own data path.

### Later

Ticks from the TV, more dashboards, AWWS brand colours on the tile.

### Build notes

- Id `awws`, 3x2. Files `app/widgets/awws.js`, `awws.css`. Launcher entries in config: label and one-line description.
- Keep the artifact's store shape: `todos`, `notes`, `handoffs`. `todos` fields `n`, `t`, `note`, `stream`, `owner`, `when`, `due`, `waitingOn`, `link`, `linkText`, `done`, `order`.
- Sort: done last, then `when`, then `order`.

## To-do

### First version

A list kept on the TV that you read, tick and add to with the remote, labelled "On this TV" so it is not mistaken for the morning list. The tall tile shows the first five or six open Now items with tick marks, "Overdue" flags and a count line ("4 more, 2 waiting").

The panel has Now, Next and Waiting on. OK ticks an item, "Add an item" opens the TV keyboard, done items move to "Done today" and clear the next day, and "Remove" needs a second press. Full screen shows the sections as columns.

### Where the data comes from

The TV's local storage (space the browser keeps on the TV).

### What it needs from you

Nothing.

### Effort

Medium, because it also carries the hub's typing mode.

### Risks

- The on-screen keyboard is untested with this hub on your TV, so adding items is the part most likely to need a fix. Reading and ticking do not depend on it.
- Typing with a remote is slow, so version two should also allow adding from a phone page on the Pi.
- The storage belongs to TizenBrew (the tool that launches the hub) and could be cleared if TizenBrew is reinstalled.

### Later

Version two shows your morning Tasks list from the Pi through the bridge, and ticks travel back. It uses the Pi when it answers and the TV list when it does not. It needs G1 and G3 and is Medium.

### Build notes

- Id `todo`, 3x4. Files `app/widgets/todo.js`, `todo.css`. Storage key `homeHub.todo.v1`.
- Store with `load`, `save`, `add`, `toggle`, `remove`; back ends `tv` and `pi` (`/todo`).
- Item: `id`, `title`, `section`, `project`, `priority`, `due` (`YYYY-MM-DD`), `waitingOn`, `done`, `doneAt`.

## Calendar

### First version

Today's agenda on the tile, and a read-only calendar in the panel with a Day, Week and Month switch. Tile rows lead with the start time, then title and place; a line marks now, past events dim, and all-day events sit on top.

When the day is clear it says "Nothing else today" and shows tomorrow's first event. Day is a timeline, Week is seven columns, and Month is a grid with the chosen day's agenda beside it.

### Where the data comes from

Google Calendar's secret iCal link (iCal is the standard calendar feed format), read by the Pi. The TV cannot read the link itself (expected; not confirmed, because the test was blocked). Source: [Google help](https://support.google.com/calendar/answer/37648).

Home Assistant's Google integration also works but needs far more setup, including a Google Cloud project and a published consent screen (one left in "Testing" loses its sign-in every 7 days). Sources: [integration](https://www.home-assistant.io/integrations/google/), [REST API](https://developers.home-assistant.io/docs/api/rest/). Google's sign-in for TVs does not allow calendar access ([source](https://developers.google.com/identity/protocols/oauth2/limited-input-device)).

### What it needs from you

In Google Calendar on a computer, open Settings, the calendar, Integrate calendar, and copy the secret iCal link (about 2 minutes per calendar). Anyone with it can read that calendar; "Reset" there cancels it. Decide which calendars to show, and whether any show as "Busy" only.

### Effort

Backend route Medium, since repeating events and time zones are hard. Widget Medium to Large because of the three views.

### Risks

- How fast Google updates the feed is not confirmed; with a few minutes of cache on the Pi, the delay is unknown.
- Repeating events, their exceptions and time zones are easy to get wrong.
- The TV's browser lacks modern layout tools, so the month grid is built the old way.
- Long titles, and private details on a living room screen.

### Later

Month view, after Day and Week work.

### Build notes

- Id `calendar`, 3x4. Files `app/widgets/calendar.js`, `calendar.css`.
- `/calendar?from=...&to=...` returns `id`, `title`, `start`, `end`, `allDay`, `location`, calendar name, colour.
- Parse with `node-ical`, or `icalendar` plus `recurring-ical-events`. All-day end dates are exclusive.
- Config switch to hide details per calendar. Month grid with a table or fixed positions (no CSS grid).

## Now Playing

### First version

The tile shows album art, track, artist, a progress line and the device, or "Nothing playing" with the last track dimmed. The panel adds large art, album and times. It is read-only, as you asked only to show it.

### Where the data comes from

Spotify, asked by the Pi, which holds the token (the saved approval) and caches the answer. Source: [currently playing](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track).

Since February 2026 the app owner needs Premium, and the app stops if Premium lapses. Development apps allow 5 users, and this service was not removed ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)). Home Assistant's Spotify integration needs the same app and saves little.

### What it needs from you

About 10 minutes once. Create an app at developer.spotify.com/dashboard, add the redirect address, run the helper on your laptop, click Agree, and paste three values into the Pi's settings file ([authorization](https://developer.spotify.com/documentation/web-api/concepts/authorization), [redirects](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)).

Spotify has no TV sign-in, so this needs a normal browser; a thread linked to your computer could run the helper. The approval expires after 6 months and refreshing does not extend it, so you click Agree twice a year ([source](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)).

### Effort

Backend route Small to Medium, widget Small.

### Risks

- A Premium lapse stops it, and the twice-yearly approval must show "Spotify needs a fresh approval", not a blank tile.
- Podcasts and local files come back differently, sometimes without art. A private session hides playback.
- Spotify changed these rules twice in a year, so expect upkeep.
- Not confirmed: whether a free listener account can be read.

### Later

Play, pause and skip (wider permission and Premium), and opening the TV's Spotify app from the panel.

### Build notes

- Id `nowplaying`, 3x2. Files `app/widgets/nowplaying.js`, `nowplaying.css`.
- Pi calls `GET https://api.spotify.com/v1/me/player/currently-playing`, scope `user-read-currently-playing`. Redirect `http://127.0.0.1:8888/callback` (`localhost` is refused).
- Poll every 5 s while playing, 30 s otherwise (our choice); obey `429` and `Retry-After` ([rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)).
- Handle `episode` and missing art. Empty `204` for "nothing playing" is not confirmed.
- TV counts progress forward with `transform` only and corrects on each poll.

## Weather

### First version

The tile shows the temperature large, with condition, icon, high and low, and rain chance. The panel switches between Day (the next 12 hours led by the hour, plus feels-like, wind, sunrise and sunset) and Week (seven rows led by the day, with a low-to-high bar).

Full screen shows both. It refreshes every 20 minutes while the hub is in front, keeps the last good forecast with "as of 7:10 AM", and credits "Weather data by Open-Meteo.com" as the licence asks.

### Where the data comes from

Open-Meteo, called from the TV with no key or account. Its published source and readme (checked Nov 15, 2026) say any page may call it, it is free for non-commercial use, and fair use is about 10,000 requests a day (this makes about 72). Data is CC BY 4.0, so credit is required. None of this was checked with a live call.

### What it needs from you

Nothing to build. The widget has to know your city, and the repo is public, so the plan does not write your city into it without your say.

Until you answer, the widget finds the city itself from the TV's internet address (city level, kept on the TV only) and shows "Set your city" if that fails. Afterwards, tell me the city, whether it may go in the public settings file, and confirm Fahrenheit.

### Effort

Medium.

### Risks

- Cloud sessions are refused by the network policy for every weather service tried, so it is built against a sample and the screenshots must say so. You can allow a live check by adding a cloud environment with api.open-meteo.com allowed (Project settings, Environment).
- An old TV may not trust modern https certificates; unknown for yours. If the direct call fails, the TV's own helper fetches it, as it already does for the hub's files.
- Times come without a zone, which old browsers misread, so the widget reads them itself.
- The city lookup uses a free public service that could not be reached from the cloud either, so it is also first tried on the TV. A city in the settings file skips it.

### Later

US severe weather alerts from the National Weather Service, a second place, a rain-in-the-next-hour line.

### Build notes

- Id `weather`, 3x2. Files `app/widgets/weather.js`, `weather.css`. Cache key `homeHub.weather.v1`.
- Config `widgets.weather`: `place`, `latitude`, `longitude`, `units`, all empty by default. Place order: config if set, then the saved lookup (`homeHub.weather.place`), then a fresh lookup, then the `needs setup` state.
- Lookup candidates, keyless, not checked: `https://ipwho.is/` and `https://get.geojs.io/v1/ip/geo.json`. Use city-centre coordinates only.
- `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`
- Fallback `/fetch` in `service.js` (`127.0.0.1:8095`), limited to the weather and lookup addresses.
- Split `2026-11-15T09:00` by hand; never pass it to `Date`.
- WMO codes: `0` clear, `1` to `3` clear to overcast, `45` and `48` fog, `51` to `57` drizzle, `61` to `67` rain, `71` to `77` snow, `80` to `82` showers, `85` and `86` snow showers, `95` to `99` storm. About eight icons, day and night for clear and partly cloudy.
- Icons: sun, moon, cloud, partly cloudy day and night, rain, snow, storm, fog, wind, sunrise, sunset.
- Sample `dev/samples/weather.json`, preview only.

## Ambiance

### First version

Your Plant Wall Moods picker on the TV. The tile shows the current mood and its four swatches, or "Off"; the panel shows the 22 moods as chips grouped Everyday, Nature and Holiday, each led by its swatches, plus Off, dimmer and brighter.

Full screen shows all moods with descriptions. If the lights cannot be reached, the tile says "Lights not found" and the panel names the setting to fill in.

### Where the data comes from

The TV talks straight to the light controller. WLED, the software on the controller, accepts calls from any web page with no password unless a PIN is set (checked in its source Nov 15). The moods are generated from your Moods page's own code, so the TV and the page always agree.

### What it needs from you

The lights installed and on Wi-Fi, the controller's address (ideally fixed on the router), and a go-ahead after the on-wall calibration.

### Effort

Medium.

### Risks

- It cannot be proven without the hardware; parts were ordered Nov 14.
- Calibration may shift LED positions, so saved moods leave positions out. Menorah is the exception and needs regenerating.
- The song shows (Carol of the Bells, Dreidel) need the Pi, so they come later. Moods that listen to the room use the controller's microphone.
- Brightness is capped by the plan's USB power budget.

### Later

Song shows through the Pi, and a static live preview of the wall.

### Build notes

- Id `ambiance`, 3x2. Files `ambiance.js`, `ambiance.css`, generated `ambiance-moods.js`; generator `dev/build-moods.js` using headless Chromium.
- `POST http://<controller>/json/state` via `ctx.sendJSON`. A `.local` name is unlikely to work.
- Set colours and effects for segments `0` to `15` only; Menorah has one segment per candle.

## Mirror

### First version

The tile opens the mirror full screen at once. The picture is flipped like a real mirror, with a bright border that works as a vanity light, and Back closes it and stops the camera. Nothing is recorded.

### Where the data comes from

A camera on a Raspberry Pi at the TV, sending Motion JPEG (a stream of still pictures that even an old browser shows). [µStreamer](https://github.com/pikvm/ustreamer) does this with the Pi's hardware encoder (confirmed); [camera-streamer](https://github.com/ayufan/camera-streamer) is the alternative.

| Route | Cost | Delay | Effort | Catch |
|---|---|---|---|---|
| Pi camera at the TV | $25 to $35 (not confirmed) | 0.1 to 0.25 s (not confirmed) | Large | Pi must be near the TV |
| USB webcam on a Pi | $25 to $35 (not confirmed) | 0.1 to 0.25 s (not confirmed) | Large | Webcam must output Motion JPEG |
| iPhone trial | Free, watermark | Not measured | Trial | Phone must stay awake |
| Webcam into the TV | Webcam only | n/a | n/a | Does not work |

A webcam plugged into the TV is undocumented, and a [Samsung community thread](https://eu.community.samsung.com/t5/tv/can-t-get-my-samsung-webcam-to-work-on-my-samsung-smart-tv/td-p/2763019) reports one failing on a 2020 TV. iPhone as webcam (Continuity Camera) only works with Macs and Apple TV ([Apple](https://support.apple.com/en-lk/guide/tv/aside/atvb822161d6/tvos), confirmed).

The free trial uses an app such as [IP Camera Lite](https://apps.apple.com/us/app/ip-camera-lite/id1013455241) on a propped, plugged-in iPhone, converted by go2rtc on the Pi. That the phone must stay awake with the app open is reported practice, not confirmed.

### What it needs from you

Say whether the Pi is close enough to the TV for a camera cable; if not, a second small Pi at the TV is the clean answer. Then pick and buy a camera (prices from memory, not confirmed).

### Effort

Large: hardware, mounting, and delay tuning on the real TV.

### Risks

- Lag makes a mirror feel wrong; the target is well under a quarter of a second, and the delay and Pi load figures must be measured on the TV.
- The camera must sit at eye level, beside or above the screen.
- The TV may stutter on a large picture, so it starts at 720p.
- HLS, a common streaming method, is ruled out for its several seconds of delay.

Privacy: home network only, no port forwarding, the camera runs only while the mirror is open, and a lens cover or switched power gives certainty.

### Later

WebRTC through [go2rtc](https://github.com/AlexxIT/go2rtc) is held in reserve. It has the lowest delay in general, but its project only documents current browsers, so expect trouble on an old TV.

### Build notes

- Id `mirror`, 3x2. Files `app/widgets/mirror.js`, `mirror.css`.
- Plain `<img>` with `transform: scaleX(-1)`, 720p.
- `/mirror/start` on open; `/mirror/stop` on Back and in `onClose`.
- Hardware: Raspberry Pi Camera Module 3, or a Motion JPEG USB webcam.

## Suggested order

1. Tonight, no input: Weather and To-do (TV list), as two PRs.
2. Small and safe, no input: the start-up guard, and the Pi backend written and tested in the cloud.
3. Your time: install the backend, paste the calendar links, set up Spotify. Then Calendar and Now Playing.
4. Your yes on the bridge. Then the morning to-do list and the AWWS board.
5. When the wall lights are up: Ambiance.
6. Last: Mirror, after the camera choice.

## Open questions

1. What do the two small lines on the Today tile say?
2. Answered in part on Nov 15: the weather uses Dallas, and you said it may be written in the public settings file. Still open: is Fahrenheit right?
3. Bridge: Cloudflare Worker (recommended), private GitHub repo, or keep TV lists separate?
4. AWWS board on the TV: read-only first (recommended), or ticks from day one?
5. Calendar on a shared screen: show every calendar, or hide details for some?
6. Are the plant wall lights installed yet, and what is the controller's address?
7. Mirror: which camera route?

## How this was checked

- Read the hub's code on main at v0.6.0, your AWWS To-Do Board, Plant Wall Moods and Plant Wall Lighting artifacts, and the morning Tasks page (structure only), all on Nov 15.
- Read Open-Meteo's and WLED's published source. Live Open-Meteo calls were refused by the network policy. You allowed the address on Nov 15; that applies to threads started afterwards, so a live check is still to be run from a new thread.
- Fetched a claude.ai artifact link's headers.
- Spotify, calendar and camera facts come from research on Nov 15, 2026, with links beside each fact.
- Samsung's TV browser table, from memory and not re-checked: 2018 Chromium 56, 2019 63, 2020 69, 2021 76, 2022 85, 2023 94, 2024 108. Until you read the Today tile, the plan assumes the oldest.
- Not checked: anything on the home network, the TV's browser version, its trust of modern https sites, and its on-screen keyboard inside the hub.
