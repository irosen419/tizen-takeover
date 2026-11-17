# The A World Worth Saving snapshot

Written 2026-11-16. This is the contract between whoever sends A World Worth Saving data (a scheduled Claude routine, or a person with a file) and the hub server on the Pi, which stores it and pushes it to the TV.

The calendars are not part of this. School visits and A World Worth Saving dates come from the Pi's calendar reader, which is already running. Everything else the A World Worth Saving tiles show comes from this one snapshot.

A sample with made-up data is in [`pi/fixtures/awws-sample.json`](../pi/fixtures/awws-sample.json). This repository is public, so the sample must stay made up.

## How it travels

```
 The sources (to-do board, reply drafts, ...)      only a signed-in Claude can read these
        |
        v
 A Claude routine builds one small JSON snapshot
        |
        |  mailbox command awws.set (Cloudflare R2, see pi/CLAUDE.md)
        v
 Hub server on the Pi      checks it, keeps it in data/state.json as the resource "awws"
        |
        |  the live line the TV already keeps open
        v
 The awws tiles on the TV
```

On the Pi itself the same thing is `./hub awws set file.json`.

## The shape

One JSON object. `v` and `sentAt` are required. Every section is optional.

```json
{
  "v": 1,
  "sentAt": "2026-11-16T15:10:00Z",
  "todos":    { "asOf": "...", "items": [ ... ] },
  "handoffs": { "asOf": "...", "open": 2, "blocked": 1 },
  "outreach": { "asOf": "...", "replied": 9, "booked": 3, "visited": 1, "waitingOnIan": 5 },
  "khaya":    { "asOf": "...", "done": 11, "total": 12 },
  "pipeline": { "asOf": "...", "stages": [ ... ], "items": [ ... ] },
  "money":    { "asOf": "...", "currency": "USD", "spent": 0, "earned": 0 },
  "reach":    { "asOf": "...", "subscribers": 2, "subscribersAsOf": "2026-11-16" }
}
```

### Rules for the whole snapshot

- **A section you leave out is kept as it was.** Send only `todos` every half hour and `reach` twice a day, and neither blanks the other.
- **A section sent as `null` is removed** from the Pi and the TV.
- **Each section is checked by itself.** A section that breaks a rule is refused by name and the Pi keeps its last good copy of it. The other sections in the same snapshot are still stored. The answer lists what was accepted, cleared and rejected.
- **48 KB at most** (49,152 bytes of JSON), both for what is sent and for everything the Pi holds after merging. The mailbox carries files up to 64 KB, so this leaves room for the envelope. Over the cap, nothing is stored and the answer says how big it was.
- **Times** are UTC, written `2026-11-16T15:10:00Z` (fractions of a second are allowed). **Dates** are `2026-12-01`. **Months** are `2026-11`.
- `sentAt` is when the sender built the snapshot. It may not be more than 10 minutes in the future. The TV calls the snapshot stale, and says "as of 9:10 AM", once `sentAt` is over 2 hours old.
- `asOf` on a section is when its source was read. Left out, the Pi fills in `sentAt`.
- **Text** is trimmed, and control characters become spaces (a run of them becomes one space). Text longer than its limit is cut to the limit and ends in "…". Lengths are counted in characters, so "ñ" is one.
- **No email addresses and no links.** A section with text that holds an email address, `http://`, `https://` or `www.` is refused. Also leave out notes text and librarians' last names; the Pi cannot check those, so the sender must.
- **Unknown fields are dropped**, at the top and inside sections, so a newer sender does not break an older Pi.
- Whole numbers are 0 or more and at most 1,000,000 unless a section says otherwise.

### `todos`: the to-do board

Open items, plus items ticked in the last 7 days. Order in `items` is the order shown.

| Field | Type | Notes |
|---|---|---|
| `items` | list, at most 200 | required (may be empty) |
| `items[].id` | text | required, unique, 1 to 40 of `A-Z a-z 0-9 _ -` |
| `items[].title` | text, 80 | required |
| `items[].owner` | `ian`, `claude` or `both` | required |
| `items[].section` | `now`, `next` or `later` | required |
| `items[].stream` | text, 24 | the workstream, e.g. "Outreach" |
| `items[].due` | text, 40 | the board's own words, shown as written: "Dec 1, 12:15 PM", "On hold" |
| `items[].dueISO` | date or time | only when `due` is a real date. This is what puts the item on the agenda and marks it overdue |
| `items[].waitingOn` | text, 40 | who or what it waits on |
| `items[].done` | true or false | default false |
| `items[].doneAt` | time | when it was ticked |
| `totals` | object | optional: `{ "ian": { "now": 17, "next": 9, "later": 30 }, "claude": { ... }, "both": { ... } }`, all three owners, each with `now`, `next` and `later` as whole numbers. The true open counts on the board. Send it when the list had to be cut to fit; without it the TV counts the open items it was given |

### `handoffs`

| Field | Type | Notes |
|---|---|---|
| `open` | whole number | required |
| `blocked` | whole number | required |
| `items` | list, at most 20 | optional |
| `items[].id` | text | required, as in `todos` |
| `items[].title` | text, 80 | required |
| `items[].state` | `open` or `blocked` | required |

### `outreach`: librarians and schools

| Field | Type | Notes |
|---|---|---|
| `replied`, `booked`, `visited` | whole numbers | required |
| `waitingOnIan` | whole number | required: replies waiting on Ian |
| `emailed` | whole number | optional until there is a source for it |
| `schools` | list, at most 30 | optional |
| `schools[].school` | text, 40 | required; the school, never a person's name |
| `schools[].state` | `waiting-ian`, `waiting-them`, `booked` or `visited` | required |
| `schools[].since` | date | optional |
| `log` | list, at most 30 | optional: `{ "date": "2026-11-14", "school": "...", "what": "Replied, asked for dates" }`, all three required; `date` is a date, `school` is text, 40, `what` is text, 80 |

### `khaya`: rewrite progress

| Field | Type | Notes |
|---|---|---|
| `done` | whole number | required, at most `total` |
| `total` | whole number, 1 or more | required |
| `label` | text, 40 | optional, e.g. "Rewrite" |

### `pipeline`: books and content

| Field | Type | Notes |
|---|---|---|
| `stages` | list of 2 to 7 texts, 16 each | required, in order, e.g. `["Write", "Art", "Layout", "Proof", "Live"]` |
| `items` | list, at most 12 | required |
| `items[].id` | text | required, as in `todos` |
| `items[].title` | text, 40 | required |
| `items[].format` | text, 24 | e.g. "Hardcover" |
| `items[].stage` | whole number, 0 to the number of stages | required: how many stages are finished |
| `items[].next` | text, 80 | the next step |
| `items[].waitingOn` | text, 40 | |
| `items[].blocked` | true or false | default false |

### `money`

Stored like any other section. Ian said yes to money figures on the living room TV on 2026-11-16, so the sender may include this section, and `HUB_CONFIG.widgets.awws.showMoney` in `app/config.js` ships `true`. With it, the Glance shows a money line ("Spent $1,841 · earned $1,265") in its Progress list and in its launcher. The **Earned vs spent** tile (`awws-money`, on the "AWWS money" layout) shows the net so far (`earned` minus `spent`; green when it is up, coral when it is down), "earned $1,265 · spent $1,841", one pair of bars per entry in `months` (earned green, spent coral) and, on a tall tile, the next transfer. Its panel adds `claude` as "Claude this month". It never shows a balance; the snapshot carries none. To keep money off the TV (for guests, say), set `showMoney` to `false`: the Glance drops its money line and Earned vs spent says "Money is hidden". The Pi still stores the section. With a snapshot but no money section the tile says "No money data yet"; when the snapshot is over 2 hours old it says "as of" under its title and dims.

| Field | Type | Notes |
|---|---|---|
| `currency` | three capital letters | required, e.g. `USD` |
| `spent`, `earned` | numbers, 0 to 1,000,000,000 | required: totals to date, rounded to cents by the Pi |
| `months` | list, at most 12 | optional: `{ "month": "2026-11", "spent": 120.5, "earned": 80 }`, oldest first |
| `claude` | object | optional: `{ "month": "2026-11", "cost": 41.2 }` |
| `nextTransfer` | object | optional: `{ "date": "2026-12-01", "amount": 250 }`; `amount` may be left out |

### `reach`

Newsletter subscribers are counted by hand for now, and the site traffic figures come later, so every field here is optional. The section must hold at least one of `visits`, `buyClicks`, `subscribers` and `scans`; a reach section with none of them is refused and the Pi says which fields it may hold.

| Field | Type | Notes |
|---|---|---|
| `visits` | object | optional: `{ "week": 412, "prev": 388, "days": [ ... ] }`. `week` and `prev` are whole numbers; `days` is optional, at most 28 whole numbers, oldest first |
| `buyClicks` | object | optional, same shape as `visits` |
| `subscribers` | whole number | optional: newsletter subscribers |
| `subscribersAsOf` | date or time | optional: when the subscribers were last counted by hand, `2026-11-16` or `2026-11-16T15:10:00Z`. Left out, the TV uses the section's `asOf` |
| `scans` | list, at most 10 | optional: `{ "school": "...", "count": 14 }`; `school` is text, 40 |

## What the Pi keeps

The resource `awws` in `data/state.json`, sent to the TV with everything else:

```json
{ "v": 1, "sentAt": "2026-11-16T15:10:00Z", "receivedAt": "2026-11-16T15:10:12Z",
  "todos": { ... }, "khaya": { ... } }
```

`receivedAt` is the Pi's own clock when it last stored something. Before any snapshot arrives, and after `./hub awws clear`, it is `{ "v": 1, "sentAt": null, "receivedAt": null }` and the tiles say "Not synced yet".

Every snapshot the Pi accepts is stored and pushed to the TV, even when no section's contents changed. A sync that found nothing new still proves the data is fresh, and the new `sentAt` is what keeps the tiles from calling it stale. The answer's `changed` says whether any section's contents changed. Only a clear when nothing is stored pushes nothing.

What the Pi keeps is the checked copy: unknown fields dropped, text tidied, money rounded, `asOf` filled in. `done` and `blocked` are kept only when they are `true`; left out means `false`, so the stored copy is never meaningfully larger than what was sent.

## Sending and reading

On the Pi:

- `./hub awws show`: when the snapshot was sent, its size, and one line per section.
- `./hub awws set file.json`: store a snapshot (`-` reads it from input). The file is the snapshot itself, or `{ "snapshot": { ... } }`.
- `./hub awws clear`: remove everything.

Control API (token needed, see `docs/live-updates.md`):

| Call | Body | Answer |
|---|---|---|
| `GET /api/awws` | | `{ ok, rev, data, tz }`; `tz` is the hub's time zone (`HUB_TIMEZONE`), so `./hub awws show` writes times the way `./hub calendar status` does |
| `POST /api/awws` | `{ "snapshot": { ... } }` or `{ "snapshot": null }` to clear | `{ ok, rev, changed, bytes, accepted: [], cleared: [], rejected: [{ section, error }] }` |

`POST /api/awws` answers `400` and changes nothing when the snapshot as a whole is wrong (not an object, wrong `v`, bad `sentAt`, no sections at all, over 48 KB as sent or once merged with what the Pi holds) or when every section in it was rejected; the error text then names each section and why. Bodies for this call may be up to 64 KB (every other control call keeps 8 KB). Otherwise it answers `200`, even with some sections rejected; read `rejected`.

From the cloud, through the Claude mailbox (`pi/CLAUDE.md`): `awws.set {"snapshot": { ... }}`, `awws.show`, `awws.clear`. The reply's `message` is the same text `./hub` prints. For `awws.set`, `data` carries `changed`, `bytes`, `accepted`, `cleared` and `rejected`. For `awws.show`, `data` is a compact summary, never the whole snapshot (a reply's `data` is capped at 48 KB): `sentAt`, `receivedAt`, `bytes`, and per section its `asOf` and counts. `awws.set {"snapshot": null}` clears everything, like `awws.clear`.

## What the TV does with it

- `awws` (Glance): counts from `todos`, the first Now items for Ian, and one-line figures from `handoffs`, `outreach`, `pipeline` and `khaya` when they are there.
- `awws-todo`: the board, by section and owner, with overdue items in amber (`dueISO` before today) and open items per workstream.
- `awws-agenda`: items with a `dueISO` join the calendar events on their day.
- `awws-reach`: site visits this week as the big figure, with the change from last week and a line of the last 14 days, then buy clicks, flier scans by school and subscribers with the day they were last counted. With only `subscribers` (as today) it leads with them: "2 subscribers, at last check Nov 16". Every size works with subscribers alone, traffic alone, or both. The Glance's launcher opens it too. It is on no layout yet; place it with the Layout Studio or `./hub layout set`.
- `money`: the Glance's money line and the Earned vs spent tile (`awws-money`), while `showMoney` is `true` (above).
- `awws-outreach` and `awws-pipeline` are placeholders for now. Their sections are already checked and stored, so the tiles can be built without touching the Pi again.

The TV keeps its last copy (`homeHub.awws.v1`), so the tiles have something to show straight after the TV turns on.
