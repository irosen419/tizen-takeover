# The budget snapshot

Written 2026-11-17. This is the contract between the budget app on the Pi, which works out the figures, and the hub server on the same Pi, which stores them and pushes them to the TV's budget tiles (Daily room, Card day, Goals) and the "New charge" banner.

A sample with made-up figures is in [`pi/fixtures/budget-sample.json`](../pi/fixtures/budget-sample.json). This repository is public, so the sample must stay made up.

## How it travels

```
 The budget app on the Pi          reads the accounts, works out the totals
        |
        |  POST /api/budget with the hub's token, on the Pi itself (127.0.0.1)
        v
 Hub server on the Pi              checks it, keeps it in data/state.json as the resource "budget"
        |
        |  the live line the TV already keeps open
        v
 The budget tiles and the banner on the TV
```

Only totals ever leave the budget app: room per day, the card day and how it is covered, goal states and the names of merchants with a new charge. **Never a balance, never a transaction list, never an amount on an alert.** The budget app talks to the hub server on the Pi directly; nothing goes through the cloud. (The Claude mailbox also has `budget.show`, `budget.set` and `budget.clear`, for setting things up by hand; `budget.show` only ever answers with dates, counts and states.)

By hand on the Pi: `./hub budget set file.json`.

## Sending it

```sh
curl -sS -X POST http://127.0.0.1:8097/api/budget \
  -H "Authorization: Bearer $HUB_TOKEN" -H 'content-type: application/json' \
  --data @budget.json
```

where `budget.json` is `{ "snapshot": { ... } }`. The token is `HUB_TOKEN` in `pi/.env`; give the budget app its own copy and never print it. Send a snapshot whenever the figures change, and at least once an hour: the TV calls the data old after 2 hours (below).

## The shape

One JSON object. `v` and `sentAt` are required. Every section is optional.

```json
{
  "v": 1,
  "sentAt": "2026-11-16T15:10:00Z",
  "room":    { "asOf": "...", "cap": 60, "roomPerDay": 42.5, "roomIfRefund": 48, "daysLeft": 9, "throughDate": "2026-11-24" },
  "cardDay": { "asOf": "...", "date": "2026-11-19", "daysAway": 3, "covered": true,
               "transfers": [ { "label": "From checking", "amount": 310 } ], "paychecks": ["2026-11-20"] },
  "goals":   { "asOf": "...", "items": [ { "label": "Coffee out", "state": "over", "text": "$62 over", "pct": 100 } ] },
  "alerts":  { "asOf": "...", "items": [ { "id": "a-1042", "label": "Corner Bakery Stand" } ] }
}
```

### Rules for the whole snapshot

These are the same rules as the A World Worth Saving snapshot ([`awws-snapshot.md`](awws-snapshot.md)):

- **A section you leave out is kept as it was.** A section sent as `null` is removed from the Pi and the TV.
- **Each section is checked by itself.** A section that breaks a rule is refused by name and the Pi keeps its last good copy; the other sections are still stored. The answer lists what was accepted, cleared and rejected.
- **48 KB at most** (49,152 bytes of JSON), as sent and as held after merging.
- **Times** are UTC, `2026-11-16T15:10:00Z`. **Dates** are `2026-11-24`.
- `sentAt` is when the snapshot was built. It may not be more than 10 minutes in the future. Once it is over 2 hours old the tiles say "as of 9:10 AM" under their titles and dim.
- `asOf` on a section is when its figures were worked out. Left out, the Pi fills in `sentAt`.
- **Text** is trimmed, control characters become spaces, and text longer than its limit is cut and ends in "…". **No email addresses and no links:** a section with one is refused.
- **Unknown fields are dropped**, at the top and inside sections. An `amount` on an alert, or a `balance` anywhere, is simply never stored.
- **Dollar figures** are numbers, rounded to cents by the Pi, from 0 to 1,000,000 unless a field says it may be negative. The TV shows whole dollars: room rounded down, a shortfall rounded up.
- `goals` and `alerts` may be sent as the list itself (`"goals": [ ... ]`) or as `{ "asOf": "...", "items": [ ... ] }`. The Pi stores the second form.

### `room`: daily room

| Field | Type | Notes |
|---|---|---|
| `cap` | dollars, more than 0 | required: the daily cap |
| `roomPerDay` | dollars, may be negative | required: what is left to spend per day through `throughDate` |
| `roomIfRefund` | dollars, may be negative | optional: `roomPerDay` once a pending refund posts |
| `daysLeft` | whole number, 0 to 366 | required |
| `throughDate` | date | required: the last day the room covers |

On the TV: the room per day, big; amber when it is under the cap, coral below zero, green at the cap or over. A bar of how much of the cap is left, "of $60 a day · 9 days left", "through Tue, Nov 24", and "about $48 once the pending refund posts" when `roomIfRefund` is there.

### `cardDay`: the card's due date

| Field | Type | Notes |
|---|---|---|
| `date` | date | required: when the card is due |
| `daysAway` | whole number, 0 to 366 | required. The TV works it out again from `date` once its own day moves on |
| `covered` | true or false | required |
| `shortBy` | dollars | optional, and only when `covered` is false; a snapshot with `shortBy` and `covered: true` has its card day refused |
| `transfers` | list, at most 6 | optional: `{ "label": "From checking", "amount": 310 }`; `label` is text, 24; `amount` is dollars. The split that covers the card |
| `paychecks` | list of dates, at most 4 | optional: the coming paychecks |

On the TV: "Thu, Nov 19 · in 3 days", then "Covered" in green or "Short by $120" in coral, the transfer rows, and "Next paycheck Fri, Nov 20" (the first paycheck from today on).

### `goals`

A list of at most 8 goals, shown in this order.

| Field | Type | Notes |
|---|---|---|
| `label` | text, 30 | required |
| `state` | `clean`, `on-pace`, `over` or `under` | required. `clean`: nothing spent where nothing should be. `under`: under its limit |
| `text` | text, 20 | optional: the goal's own words, shown as written, e.g. "$62 over", "12 days" |
| `pct` | number, 0 to 100 | optional: how full its bar is. Without it the goal shows its state in words |

On the TV: one row per goal with its bar, green for `clean` and `under`, blue for `on-pace`, coral for `over`.

### `alerts`: a charge at a merchant that was cut

A list of at most 5.

| Field | Type | Notes |
|---|---|---|
| `id` | text | required, unique, 1 to 40 of `A-Z a-z 0-9 _ -`. Keep it the same while the alert stands: the TV remembers the ids it has shown |
| `label` | text, 30 | required: the merchant, as the owner knows it |

There is no amount field, and one sent is dropped. On the TV: a banner across the top of the screen, "New charge: Corner Bakery Stand", with "+1 more" when there are more. OK (or Back) on the home screen dismisses it and the next one shows; a dismissed id never shows again on that TV (it keeps the last 50, in `homeHub.budget.seen.v1`). Send the list with only the alerts that still stand; an empty list (or `null`) clears them.

## What the Pi keeps

The resource `budget` in `data/state.json`, sent to the TV with everything else:

```json
{ "v": 1, "sentAt": "2026-11-16T15:10:00Z", "receivedAt": "2026-11-16T15:10:01Z", "room": { ... }, "goals": { ... } }
```

Before any snapshot, and after `./hub budget clear`, it is `{ "v": 1, "sentAt": null, "receivedAt": null }` and the tiles say "Waiting for the budget app". Every accepted snapshot is stored and pushed, even when nothing changed: the new `sentAt` is what keeps the tiles from calling it old.

## Reading and clearing

On the Pi:

- `./hub budget show`: when it was sent, its size, and one line per section with dates, counts and states only, never a label or an amount. For example `cardDay  2026-11-19 (in 3 days), covered, 3 transfers, 2 paychecks, as of 9:05 AM`.
- `./hub budget set file.json`: store a snapshot (`-` reads it from input). The file is the snapshot itself, or `{ "snapshot": { ... } }`.
- `./hub budget clear`: remove everything.

Control API (token needed, see `docs/live-updates.md`):

| Call | Body | Answer |
|---|---|---|
| `GET /api/budget` | | `{ ok, rev, data, tz }` |
| `POST /api/budget` | `{ "snapshot": { ... } }` or `{ "snapshot": null }` to clear | `{ ok, rev, changed, bytes, accepted: [], cleared: [], rejected: [{ section, error }] }` |

`POST /api/budget` answers `400` and changes nothing when the snapshot as a whole is wrong (not an object, wrong `v`, bad `sentAt`, no sections, over 48 KB) or when every section in it was rejected. Bodies may be up to 64 KB. The server's log notes each call without its contents (`control POST /api/budget -> 200 4 sections stored, 914 bytes, rev 58`).

## On the TV

- `budget-room` (Daily room), `budget-card` (Card day) and `budget-goals` (Goals), with a wallet icon. Every size works; [tile-sizes.md](tile-sizes.md) says what each shows. The **Budget** layout in the switcher places them with Calendar, Today and Entertainment.
- A section that is missing makes its tile say "Waiting for the budget app"; with no line to the Pi they say "Needs the Pi" or "Can’t reach the Pi".
- The TV keeps its last copy (`homeHub.budget.v1`), so the tiles have something to show straight after the TV turns on.
- `widgets.budget.show: false` in `app/config.js` hides it all on that TV: the tiles say "Budget is hidden" and the banner never shows.
