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
      "nextEpisode": { "season": 24, "number": 8, "name": "Surf and Turf", "airstamp": "2026-11-20T02:00:00Z" },
      "upcoming": [ { "season": 24, "number": 8, "name": "Surf and Turf", "airstamp": "2026-11-20T02:00:00Z" } ],
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
| `nextEpisode` | `{ season, number, name, airstamp }` or `null`. |
| `upcoming` | Episodes from 7 days ago to 60 days ahead, at most 40, oldest first. The week view shows the days already gone dimmed as "Aired". |
| `returning` | A season coming back: `{ season, label, date, airstamp }` (`date` and `airstamp` `null` when there is no date yet), or `null`. The Coming soon strip shows these with a day count. |

Times are UTC ISO strings (`airstamp`). The TV shows them in its own time zone, 12 or 24 hour as the Clock is set, and puts episodes on its own local days.

At most 40 shows. Episode names are cut at 80 characters, service names at 24.

## On the TV

- The Schedule lives in Entertainment. Its tabs are Today, This week, This month and Coming soon, with rows grouped by day.
  - Today has a lit edge, and so does an episode airing within the hour ("in 35 min").
  - Each row has a tiny lettered poster, the title, "S3 E4 · 9:00 PM" and the service badge.
  - The focused row shows "Watch on X"; OK opens that app with the toast "Opened X. Search: <show>".
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

## Logs

The Pi's log never names a show or carries a link. It holds counts and codes only:

- `shows refresh: 4 of 4 shows read`
- `shows refresh: 3 of 4 shows read, 1 failed (timeout)`
- `shows changed: 4 shows (rev 58)`
