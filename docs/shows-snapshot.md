# The shows snapshot (`shows`)

What the Pi sends the TV for the Schedule in the Entertainment panel, and for the counts on the Entertainment tile. The Pi builds it from the owner's show list and TVmaze (`pi/shows.js`); nobody writes it by hand. A made-up example is [`pi/fixtures/shows-sample.json`](../pi/fixtures/shows-sample.json) (the preview and the tests use it; `HUB_SHOWS=sample` makes a real Pi send it instead of asking TVmaze).

## Where it comes from

- **The list** lives on the Pi in `data/shows.json`, started from `pi/shows-seed.json` (Hell's Kitchen and Shark Tank on Disney+, The Great British Baking Show on Netflix, Stick on Apple TV). Each entry is `{ name, service?, tvmazeId?, serviceOverride?, alsoOn?, via? }`:
  - `name`: the show as the owner says it.
  - `service`: the show's watch app and its badge on the TV. It wins over what TVmaze says.
  - `serviceOverride`: the app Watch opens when it differs from the badge.
  - `alsoOn`: up to 4 other apps that carry it. The TV offers each as "Also on ...".
  - `via`: the app the show is billed through and opened in, such as `Prime Video` for HBO Max through Prime Video Channels.
  - `tvmazeId`: filled in by the first lookup and kept.
  - `watched`: optional, the episodes marked watched: `[{ s, e, at }]` (season, episode, when it was marked; at most 400 per show, the oldest go first). Never written by hand: the TV marks them, `./hub shows watched|unwatch` and the mailbox correct them.
  - `upTo`: optional, `{ s, e, at }`, "watched up to here": every numbered episode of an earlier season, or of season `s` up to number `e`, counts as watched.
  - `unwatched`: optional, `[{ s, e }]` (at most 200): episodes inside the `upTo` range that were NOT seen.
  An episode is watched when it is in `watched`, or inside `upTo` and not in `unwatched`. A special (no season or number) never is.
  Change it with `./hub shows add|remove`, the mailbox (`shows.add`, `shows.remove`, `shows.set`) or `POST /api/shows`.
- **TVmaze** (`https://api.tvmaze.com`, public, no key). Per show and refresh:
  - `GET /singlesearch/shows?q=<name>`, only until the id is known;
  - `GET /shows/<id>?embed[]=nextepisode&embed[]=previousepisode`;
  - `GET /shows/<id>/episodes`.
  At most 20 calls in any 10 seconds, one at a time. A `429` waits 2.5 s and tries again, up to 3 times.
- **When:** at start, every 6 hours, after a list change, and on `./hub shows refresh` (`POST /api/shows/refresh`, which waits up to 25 s).
- **Last good copy:** a show that can't be read keeps its previous copy, marked `stale` with an `error` code. The resource lives in `data/state.json`, so the copy survives a restart and a TVmaze outage never blanks the TV.

## The resource

`GET /api/shows` (token) answers `{ ok, rev, data, list, tz }`. The TV gets `data` through live updates (`/live/state`, the `change` event and the poll), like every resource.

```json
{
  "v": 1,
  "updatedAt": "2026-11-17T12:00:00Z",
  "sample": true,
  "error": "No show could be read: unreachable",
  "shows": [
    {
      "id": "hells-kitchen",
      "name": "Hell's Kitchen",
      "service": "Disney+",
      "watch": "Disney+",
      "channel": "FOX",
      "alsoOn": ["Hulu"],
      "status": "Running",
      "running": true,
      "tvmazeId": 1234,
      "checkedAt": "2026-11-17T12:00:00Z",
      "stale": false,
      "nextEpisode": { "season": 24, "number": 8, "name": "Surf and Turf", "airstamp": "2026-11-20T02:00:00Z", "runtime": 60 },
      "upcoming": [ { "season": 24, "number": 7, "name": "Hot Mess", "airstamp": "2026-11-13T02:00:00Z", "runtime": 60, "watched": true }, { "season": 24, "number": 8, "name": "Surf and Turf", "airstamp": "2026-11-20T02:00:00Z", "runtime": 60 } ],
      "watched": [ { "season": 24, "number": 7, "at": "2026-11-13T04:10:00Z" } ],
      "progress": { "upTo": { "season": 24, "number": 6, "at": "2026-11-13T04:00:00Z" }, "unwatched": [ { "season": 24, "number": 3 } ], "aired": 7, "seen": 6, "caughtUp": false, "next": { "season": 24, "number": 3 } },
      "returning": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `v` | Always 1. |
| `updatedAt` | When TVmaze was last read (UTC), or `null` before the first read. |
| `sample` | Present and `true` only for the made-up sample. The TV shows a SAMPLE chip then, and never otherwise. |
| `error` | Present only when no show at all could be read. The TV then shows "TVmaze couldn't be reached" if it has nothing better. |
| `shows[].id` | A slug of the name (`hells-kitchen`). Unique. |
| `name` | As on the owner's list. |
| `service` | The badge: the list's `service`, or else TVmaze's web channel (`webChannel.name`) or network, with a few names tidied (`Apple TV+` → `Apple TV`, `Max` → `HBO Max`). |
| `watch` | The app Watch opens: `serviceOverride`, or else `service`. The TV may still send a whole service elsewhere with `watchAliases`, see below. |
| `channel` | Where TVmaze says it airs (`FOX`, `FX on Hulu`). Informational. |
| `alsoOn` | Optional: other apps that carry it. |
| `via` | Optional (`null` when not set): the app it is billed through. The badge still names `service`; the TV adds a small "via Prime Video" and Watch opens that app. |
| `status`, `running` | TVmaze's status (`Running`, `Ended`, `To Be Determined`, `In Development`), and whether that means it continues. The TV shows "Still running" or "Ended". |
| `checkedAt` | When this show was last read well, or `null` if never. |
| `stale`, `error` | Present when the last read failed and this is the last good copy. `error` is a code only: `timeout`, `unreachable`, `not-found`, `rate-limited`, `http-503`, `not-json` or `no-id`. |
| `nextEpisode` | `{ season, number, name, airstamp, runtime?, watched? }` or `null`. |
| `watched` | The newest 60 episodes marked watched: `[{ season, number, at }]`, always present (`[]` when none). |
| `progress` | Always present: `{ upTo, unwatched, aired, seen, caughtUp, next }`. `upTo` is `{ season, number, at }` or `null`; `unwatched` the exceptions inside it, `[{ season, number }]`. `aired` counts the numbered episodes already out in the show's full list (`0` when that list is not known yet), `seen` how many of those are watched, `next` is the earliest aired episode not watched (`{ season, number }` or `null`), and `caughtUp` is `aired > 0 && seen === aired`. Recomputed on every publish and refresh, so an episode airing moves it. The TV can also work it out from the list in `GET /shows/episodes`. |
| `runtime` (on an episode) | TVmaze's length in minutes, when it has one. |
| `watched` (on an episode) | `true` when that episode is marked watched. Absent otherwise. |
| `upcoming` | Episodes from 7 days ago to 60 days ahead, at most 40, oldest first. The week view shows the days already gone dimmed as "Aired". |
| `returning` | A season coming back: `{ season, label, date, airstamp }` (`date` and `airstamp` `null` when there is no date yet), or `null`. The Coming soon strip shows these with a day count. |

Times are UTC ISO strings (`airstamp`). The TV shows them in its own time zone, 12 or 24 hour as the Clock is set, and puts episodes on its own local days.

The snapshot does not carry a show's full episode list (it would be far too big): the TV asks for one show at a time, see "The show page" below.

At most 40 shows. Episode names are cut at 80 characters, service names at 24.

## On the TV

- The Schedule lives in Entertainment. Its tabs are Today, This week, This month and Coming soon, with rows grouped by day.
  - Today has a lit edge, and so does an episode airing within the hour ("in 35 min").
  - A watched episode is dimmed, with a small check and "Watched" (Spanish "Visto"), and is skipped by the tile's counts; a show whose aired episodes are all watched does not count toward its app's badge.
  - Episodes opened with OK go on a "Did you finish?" list at the top of the panel (Watched / Not yet per line, kept 7 days), and the Entertainment tile says "N to check" while it has lines. Every aired row ends in a small check that marks or unmarks it.
  - Each row has a tiny lettered poster, the title, "S3 E4 · 9:00 PM" and the service badge.
  - The focused row shows "Watch on X"; OK opens that app (no deep link) after a centered card for about 1.8 s: "X opens on its home screen" over "Search for: <show>"; OK or Back launches at once.
  - A show that is also on another app gets an "Also on Hulu" chip beside its row. Right reaches the chip, and OK on it opens that app instead.
- `widgets.entertainment.watchAliases` in `app/config.js` sends a whole service to another app. The default is `{ Hulu: 'Disney+' }`, so titles tagged Hulu show and open as Disney+, with "Also on Hulu" offered.
- `widgets.entertainment.watchVia` (commented out by default, for example `{ 'HBO Max': 'Prime Video' }`) does the same as `via` for every show of a service. The badge keeps the service, the row adds "via Prime Video", Watch opens Prime Video, and the tile counts the show under Prime Video.
- The **Entertainment tile** puts first the apps that have something airing today or out in the last 7 days, with a small count on the logo. The tile's line reads "Tonight: Paradise 8 PM" while something still airs today.
- The TV keeps its last copy as `homeHub.shows.v1`, so the Schedule draws at once after a restart.
- When there is nothing to show, the Schedule says why:
  - no Pi set up;
  - the Pi not reached yet, or lost;
  - a Pi too old to send shows;
  - loading;
  - an empty list;
  - waiting for the first TVmaze read;
  - TVmaze unreachable.

## Watched episodes

The TV marks an episode when the person says so: "Watched" on a line of the Schedule's "Did you finish?" strip, or the check at the end of an aired row (how it works: README.md, Schedule). It tells the Pi with `POST /shows/watched` (no token: the screen door, like `/linktests`; a web page on another site is refused) and the body `{ "id": "hells-kitchen", "season": 24, "number": 7 }`. The Pi answers `{ ok, changed }`, stores `{ s, e, at }` in the show's list entry in `data/shows.json`, and pushes the new snapshot. No TVmaze call. Marking an episode already marked changes nothing. The check on a row that is already marked takes the mark off with `POST /shows/unwatch`, the same body and answer (`changed` is `false` when there was no mark).

By hand, with the token: `POST /api/shows/watched` and `POST /api/shows/unwatch` with `{ "show": "<name or id>", "episode": "S3E4" }` (`episode` may be left out on `watched`: the earliest episode out in the last week and not yet marked). `./hub shows watched "<name>" [S3E4]`, `./hub shows unwatch "<name>" S3E4`, and the mailbox's `shows.watched {name, episode?}` and `shows.unwatch {name, episode}` do the same. Needs server 0.8.0.

## Progress: watched up to here, caught up

Besides single episodes, the owner can say "I'm up to S3E4" (a binge) or "I've seen it all". The TV tells the Pi with `POST /shows/upto` (body `{ "id": "slow-horses", "season": 3, "number": 4 }`, answer `{ ok, changed }`) and `POST /shows/caughtup` (body `{ "id": "slow-horses" }`, answer `{ ok, changed, season, number }`), the same door as `/shows/watched` (no token, origin checked). A show that is not on the list, or a bad body, answers 400 with `{ ok: false, error }`. No TVmaze call; the new snapshot goes out at once.

- **Up to** sets `upTo` to that episode: every numbered episode up to and including it counts as watched, and the single marks and exceptions inside it go (they are now redundant). Setting it to an EARLIER point than before replaces the old one: the episodes after the new point (and before the old) are unwatched again, except those still in the `watched` list.
- **Caught up** sets `upTo` to the latest numbered episode that has already aired (from the show's full list, else from the snapshot's episodes) and clears `unwatched`. It answers 400 when nothing has aired.
- **Mark watched** on an episode inside `upTo` (one that is in `unwatched`) takes it out of `unwatched`; outside it adds it to `watched`. **Unwatch** inside `upTo` adds it to `unwatched` (and takes it off `watched` if it was there).

By hand, with the token: `POST /api/shows/upto` `{ "show": "<name or id>", "episode": "S3E4" }` and `POST /api/shows/caughtup` `{ "show": "<name or id>" }`; `./hub shows upto "<name>" S3E4`, `./hub shows caughtup "<name>"`, and the mailbox's `shows.upto {name, episode}` and `shows.caughtup {name}` do the same. Needs server 0.13.0.

## The show page

`GET /shows/episodes?id=<show id>` (screen door, no token, like `/live/state`) answers one show's full list for the TV's show page:

```json
{
  "ok": true,
  "id": "slow-horses",
  "checkedAt": "2026-11-17T12:00:00Z",
  "partial": true,
  "seasons": [
    { "season": 1, "episodes": [ { "number": 1, "name": "Spook Street", "airstamp": "2022-04-01T03:00:00Z", "runtime": 60, "watched": true } ] }
  ],
  "progress": { "upTo": null, "unwatched": [], "aired": 0, "seen": 0, "caughtUp": false, "next": null }
}
```

- `seasons` and their `episodes` are sorted ascending. Only numbered episodes are listed. `runtime` is present when TVmaze has one; `watched: true` only on watched episodes. `progress` is as in the snapshot, computed now. `checkedAt` is when the show was last read well, or `null`.
- `partial: true` (absent otherwise) means the Pi has no full list for the show yet (not read since 0.13.0 started, or TVmaze not reached): `seasons` then holds only the episodes the snapshot has (the week back to 60 days ahead), and `progress.aired` is `0`.
- An id that is not on the list answers 404 `{ ok: false, error }`; no `id` answers 400.
- The Pi keeps the lists in `data/show-episodes.json` (`{ v: 1, shows: { "<show id>": [ { season, number, name, airstamp, runtime? } ] } }`, numbered episodes only, at most 800 per show, written only when one changes, dropped with the show). They come from the `GET /shows/<id>/episodes` call every refresh already makes. In sample mode (`HUB_SHOWS=sample`) the lists come from an optional `episodes` array on a show in `pi/fixtures/shows-sample.json`, moved to today like the rest, and are never part of the snapshot.

## Logs

The Pi's log never names a show or carries a link. It holds counts and codes only:

- `shows refresh: 4 of 4 shows read`
- `shows refresh: 3 of 4 shows read, 1 failed (timeout)`
- `shows changed: 4 shows (rev 58)`
- `screen marked an episode watched` (and `screen marked an episode watched (already marked)`), when the TV marks one
- `screen took a watched mark off an episode`, when the TV takes one off (no show, episode, address or token in either line)
- `screen marked a show watched up to an episode` and `screen marked a show caught up` (each with ` (already marked)` added when nothing changed), from the show page; `GET /shows/episodes` logs nothing
- `shows: could not save the episode lists (EACCES)`, when `data/show-episodes.json` can't be written (a code only)
- `control POST /api/shows/watched -> 200 marked an episode watched` and `control POST /api/shows/unwatch -> 200 took a watched mark off an episode`, from the control API (the usual `control ...` line, with the route, the status and a generic note; likewise `control POST /api/shows/upto -> 200 marked a show watched up to an episode` and `control POST /api/shows/caughtup -> 200 marked a show caught up`)
