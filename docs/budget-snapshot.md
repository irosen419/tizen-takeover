# The budget snapshot

Written 2026-11-17. This is the contract between the budget app on the Pi, which works out the figures, and the hub server on the same Pi, which stores them and pushes them to the TV's budget tiles (Daily room, Card day, Goals, Budget lab) and the "New charge" banner.

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

Only totals ever leave the budget app: room per day, the card day and how it is covered, goal states, the names of merchants with a new charge, and for Budget lab the room to card day, one spending total per day, the top 5 merchants with their month-to-date totals and the runway to card day as headroom. **Never a balance, never a transaction list, never an amount on an alert**, with two exceptions: the Card day receipt (`cardDay.receipt`, below) carries the checking balance, what each card owes and the names of bills and planned buys, and the `investments` section (below) carries the portfolio total, each account's value and the top holdings in dollars. (The owner asked for the merchant names and their totals on 2026-11-17, see [Privacy for Budget lab](#privacy-for-budget-lab), approved the receipt for the TV on 2026-11-19, and approved the investment dollar figures for the TV the same day, see [Privacy for investments](#privacy-for-investments); guest mode on the TV hides both.) The budget app talks to the hub server on the Pi directly; nothing goes through the cloud. (The Claude mailbox also has `budget.show`, `budget.set` and `budget.clear`, for setting things up by hand; `budget.show` only ever answers with dates, counts and states.)

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
               "transfers": [ { "label": "From checking", "amount": 310 } ], "paychecks": ["2026-11-20"],
               "plan": [ { "label": "Sapphire Reserve", "date": "2026-11-19", "amount": 480, "kind": "first" } ] },
  "goals":   { "asOf": "...", "items": [ { "label": "Coffee out", "state": "over", "text": "$62 over", "pct": 100 } ] },
  "alerts":  { "asOf": "...", "items": [ { "id": "a-1042", "label": "Corner Bakery Stand" } ] },
  "lab":       { "asOf": "...", "room": 1334, "spentToday": 0, "daysLeft": 14, "cardDate": "2026-12-01", "monthDay": 17, "autopayRoom": 412.6, "autopayDate": "2026-11-24",
                 "split": [ { "key": "savings", "amount": 500 }, { "key": "awws", "amount": 150 }, { "key": "buffer", "amount": 350 } ] },
  "merchants": { "asOf": "...", "month": "2026-11", "combined": 702.4,
                 "items": [ { "label": "Corner Bakery Stand", "mtd": 212.6, "count": 9 } ] },
  "pace":      { "asOf": "...", "days": [ { "date": "2026-11-16", "spent": 71.2, "cap": 95.29 } ] },
  "runway":    { "asOf": "...", "start": -731, "end": "2026-12-01",
                 "steps": [ { "date": "2026-11-20", "delta": 2600, "kind": "pay" }, { "date": "2026-11-24", "delta": -120, "kind": "bill" },
                            { "date": "2026-12-01", "delta": -415, "kind": "reserve" } ] },
  "investments": { "asOf": "...", "total": 48210.55, "cost": 40100, "gain": 8110.55,
                   "accounts": [ { "label": "Roth Contributory IRA", "value": 30110.2, "gain": 5200.1 } ],
                   "top": [ { "ticker": "VTI", "name": "Vanguard Total Stock Market ETF", "value": 21000, "gain": 3100 } ],
                   "history": [ { "date": "2026-11-18", "total": 48100 } ] },
  "trends":    { "asOf": "...", "month": "2026-11",
                 "categories": [ { "label": "Food", "mtd": 412, "usual": 520 } ],
                 "merchants":  [ { "label": "Hilltop Grocer", "mtd": 184, "usual": 205 } ],
                 "weekdays":   [ 38, 35, 44, 41, 71, 96, null ] },
  "planned":   { "asOf": "...", "cardDay": "2026-12-01",
                 "items": [ { "id": "3f9a12c0", "label": "Headphones", "amount": 79, "date": "2026-12-05", "match": "amazon", "state": "upcoming" } ] }
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
- **Dollar figures** are numbers, rounded to cents by the Pi, from 0 to 1,000,000 unless a field says it may be negative (the `investments` section allows up to 10,000,000). The TV shows whole dollars: room rounded down, a shortfall rounded up.
- `goals` and `alerts` may be sent as the list itself (`"goals": [ ... ]`) or as `{ "asOf": "...", "items": [ ... ] }`. The Pi stores the second form.

### `room`: daily room

| Field | Type | Notes |
|---|---|---|
| `cap` | dollars, more than 0 | required: the daily cap |
| `roomPerDay` | dollars, may be negative | required: what is left to spend per day through `throughDate` |
| `roomIfRefund` | dollars, may be negative | optional: `roomPerDay` once a pending refund posts |
| `basis` | `first` or `autopay` | optional, `first` when left out: which card day plan `roomPerDay` is worked from. `autopay` means the cards wait for their own autopay days |
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
| `byAutopay` | true or false | optional, and only when `covered` is false (a snapshot with `byAutopay` and `covered: true` is refused). `true`: the card day is short, but every card is paid in full by its own autopay day |
| `autopayShortBy` | dollars | optional, and only when `byAutopay` is `false`: how short it is even when the cards wait for their autopay days (refused otherwise) |
| `plan` | list, at most 6 | optional: `{ "label": "Sapphire Reserve", "date": "2026-12-01", "amount": 1200, "kind": "first" }`; `label` is text, 24; `date` is the day of the payment; `amount` is dollars, the payment itself; `kind` is `first` (paid by hand on card day) or `autopay` (left for the card's autopay day, which can be before card day too). In date order |

| `receipt` | object | optional: the Card day sum, line by line, as the budget site shows it (below) |
| `outlook` | object | optional: the next 3 months (server 0.13.0). `start`: `{ "date", "behind", "ahead" }` (the day the outlook starts from; `behind` and `ahead` are dollars from 0 to 1,000,000; an ahead start is a cushion the savings start from). `dailyAverage`: dollars, the average daily spending. `averageMonths`: whole number 1 to 12 (3). `months`: 1 to 3 of `{ "month": "2026-12", "days": 28 to 31, "paydays": [dates, at most 3], "paycheck", "bills", "cardRecurring", "planned" }` (the four are dollars). Anything wrong in `outlook` drops the outlook only; the rest of card day is kept |

The `plan` amounts are payments the owner asked to see. Outside `receipt`, they are the one exception to "no balance": never what a card owes in any other form.

On the TV: "Thu, Nov 19 · in 3 days", then "Covered" in green or "Short by $120" in coral, the transfer rows, and "Next paycheck Fri, Nov 20" (the first paycheck from today on). With `covered: false` and `byAutopay: true` the word is amber, "Short $954 for Dec 1, covered by autopay", not a coral alarm. When there is a `plan`, its rows come next ("Dec 1  Sapphire Reserve  $1,200", "Dec 7  Sapphire Reserve  $400 autopay"), also when the card day is covered. With `byAutopay: false` the tile stays coral, as before, and says "$X short even with autopay" from `autopayShortBy`.

#### `cardDay.receipt`: the Card day sum

The same lines, in the same order, as the Card day sum on the budget site, so the TV and the site always agree. The owner approved sending the checking balance, what the cards owe and the names of bills and planned buys for this on 2026-11-19. On the TV the whole receipt is hidden in guest mode. Nothing here pays or moves money.

A shortened example (a real one has all its lines, and they add up):

```json
"receipt": {
  "asOf": "2026-11-16T15:05:00Z", "bottom": 430, "perDay": 143, "next": { "date": "2026-11-20", "amount": 3595 },
  "lines": [
    { "key": "checking", "label": "Checking now", "amount": 4200 },
    { "key": "billsBefore", "label": "Bills before card day", "amount": -160,
      "items": [ { "label": "Phone", "amount": 85, "date": "2026-11-17", "new": true }, { "label": "Internet", "amount": 75, "date": "2026-11-18" } ] },
    { "key": "cardsToday", "label": "Cards today, pending included", "amount": -800,
      "items": [ { "label": "Green Card", "amount": 800, "bal": 750, "pending": 50, "coming": 0, "autopay": "2026-11-24", "pay": 800, "auto": 0 } ] }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `asOf` | UTC time | required: when the figures were worked (the sync the checking balance is from) |
| `bottom` | dollars, may be negative | required: left to spend before the next paycheck (the card day allowance) |
| `perDay` | dollars | optional: the allowance over the days left, sent when `bottom` is more than 0 |
| `next` | `{ "date", "amount" }` | optional: the paycheck that ends the window; `date` is a date, `amount` is dollars |
| `lines` | list, 1 to 8 | required, each `key` at most once, the first is `checking`, in the budget site's order |

Each line: `key` is `checking`, `paychecks`, `billsBefore`, `cardsToday`, `cardCharges` (recurring charges on the cards before card day), `billsAfter` (bills from card day to the next payday) or `buys` (planned buys); `label` is text, 60, optional (the TV words each line itself, in the language it is set to); `amount` is signed dollars (the checking balance and paychecks are plus, the rest minus); `items` is optional, at most 12, and not for `checking`.

**The sums are checked to the cent, and a receipt that does not add up is refused.** The lines add up to `bottom`, and a line's items add up to the line (paychecks add, every other line takes away, so the items are plain figures and the line carries the sign). A line with more than 12 things behind it sends 11 and one more item for the rest ("4 more"), so the sum still holds. A sender that cannot make it add up leaves the receipt out and the TV draws its older Card day tile.

Each item: `label` is text, 30; `amount` is dollars; and, all optional, `date` (the day it falls), `new` (`true` when the owner has not yet chosen whether the bill counts), `note` (text, 30; for a card charge, the card), and, for a card only, `bal` and `pending` (the owed `amount` split in the posted balance and pending charges), `coming` (recurring charges still to come before card day), `autopay` (the card's next autopay date), `pay` (what the plan pays on card day) and `auto` (what is left to the card's autopay).

### `goals`

A list of at most 8 goals, shown in this order.

| Field | Type | Notes |
|---|---|---|
| `label` | text, 30 | required |
| `state` | `clean`, `on-pace`, `over` or `under` | required. `clean`: nothing spent where nothing should be. `under`: under its limit |
| `text` | text, 20 | optional: the goal's own words, shown as written, e.g. "$62 over", "12 days" |
| `pct` | number, 0 to 100 | optional: how full its bar is. Without it the goal shows its state in words |
| `spent` | dollars | optional (hub v0.75.0): spent toward the goal this calendar month. Sent with `limit` or not at all |
| `limit` | dollars, more than 0 | optional: the goal's monthly limit. With `spent`, the TV words the goal itself, in its own language: "$62 over" or "$82 left", and "$462 of $400 this month · 116%" under the bar, and the tile says "Monthly spending limits" |
| `pace` | dollars | optional, only with `limit`: where today's pace ends the month. An `on-pace` goal (heading over its limit) shows "on pace for $229" |

On the TV: one row per goal with its bar, green for `clean` and `under`, blue for `on-pace` (under its limit so far, but its pace runs over), coral for `over` (the bar then runs to what was spent, with a mark at the limit).

### `alerts`: a charge at a merchant that was cut

A list of at most 5.

| Field | Type | Notes |
|---|---|---|
| `id` | text | required, unique, 1 to 40 of `A-Z a-z 0-9 _ -`. Keep it the same while the alert stands: the TV remembers the ids it has shown |
| `label` | text, 30 | required: the merchant, as the owner knows it |

There is no amount field, and one sent is dropped. On the TV: a banner across the top of the screen, "New charge: Corner Bakery Stand", with "+1 more" when there are more. OK (or Back) on any screen (a panel, the layout switcher and About too) dismisses it and the next one shows; one nobody dismisses clears itself 5 minutes after this TV first shows it; a dismissed id never shows again on that TV (it keeps the last 50, in `homeHub.budget.seen.v1`). Send the list with only the alerts that still stand; an empty list (or `null`) clears them.

### `lab`: Budget lab's room to card day

The figures the Budget lab tile works its equations from (cap, what is kept on card day, the suggested move). The TV does the arithmetic; the budget app only sends the inputs. The budget app leaves `lab` out when card day cannot be worked out (no payday, no checking), as it already does for `room` and `cardDay`.

| Field | Type | Notes |
|---|---|---|
| `room` | dollars, may be negative | required: the room to card day as it stood this morning, before today's spending (the allowance less pending refunds plus `spentToday`) |
| `spentToday` | dollars | required: spent today so far, in the spend buckets, pending included |
| `daysLeft` | whole number, 0 to 366 | required: today through the day before card day. 0 means card day is today |
| `cardDate` | date | required: card day |
| `monthDay` | whole number, 1 to 31 | required: the day of the month today, today included |
| `autopayRoom` | dollars, may be negative | optional: the room to the autopay date, worked on the same morning basis as `room` (the autopay allowance less pending refunds plus `spentToday`). Sent whenever the budget app works it out; the TV uses it only when `room` is below zero |
| `autopayDate` | date | optional: the day that plan is worked to (the earliest autopay day on or after card day) |
| `split` | list, at most 4 | optional: `{ "key": "savings", "amount": 500 }`; `key` is `savings`, `awws`, `buffer` or `extra`, each at most once; `amount` is dollars. Where spare money on card day goes, in this order. Left out, the TV uses 500, 150 and 350 |

### `merchants`: the top 5 merchants this month

| Field | Type | Notes |
|---|---|---|
| `month` | month, `2026-11` | required |
| `items` | list, at most 5 | required, biggest first: `{ "label": "Corner Bakery Stand", "mtd": 212.6, "count": 9 }`; `label` is text, 30, the merchant as the owner knows it; `mtd` is dollars, the month to date at that merchant; `count` is a whole number, 0 to 999, how many charges (so the TV can say what one run costs). Rent is never in the list |
| `combined` | dollars | required: the five together, with each charge counted once. It can be less than the sum of the `mtd` figures, because one order can count for two merchants (a delivery app and the restaurant); never add the `mtd` figures up instead |

### `pace`: spending against the cap, day by day

| Field | Type | Notes |
|---|---|---|
| `days` | list, at most 31 | required, oldest first, one entry per date, each date once: `{ "date": "2026-11-16", "spent": 71.2, "cap": 95.29 }`; `spent` is dollars, that day's total in the spend buckets; `cap` is dollars, more than 0, the calculated daily cap the budget app logged that morning, left out on a day with no log (the Pi was off). One total per day, never the charges themselves |

**`pace.goals` (added by the hub server, never sent by the budget app).** The daily spending goal's history, `[{ "from": "2026-11-24", "goal": 60 }]`, oldest first, one entry per date, `goal` whole dollars 1 to 1,000, at most 200 entries. The hub server owns it (`pi/budgetgoal.js`, `data/budget-goal.json`) and merges it into the stored `pace` section, so it reaches the TV with the snapshot; a `goals` or `goal` field the budget app sends in `pace` is dropped. It is set from Budget lab's full screen (the Daily goal row: Left and Right, OK saves; `POST /budget/goal { "goal": 60 }` from the TV), with `./hub budget goal 60` or the mailbox's `budget.goal {"goal": 60}`. A change applies from the Pi's local date on and never rewrites a past day: a second change the same day replaces that day's entry. The TV judges each past day against the goal in force that day (the last entry with `from` on or before it); days before the first entry have no goal and are skipped. Budget lab shows "Under your $60 goal: 11 of last 14 days" (days with an entry in the 14 days ending yesterday), the days in a row under it, and at full screen a bar a day for the last 31 days (green under, coral over, grey before the first goal) with the goal as a dashed line, "7-day avg $52 vs 30-day avg $62" (mean spent per logged day) and the trend in words: coming down, going up, or steady within 3%. The goal uses `spent` only; the morning `cap` plays no part. Since hub v0.71 the goal is also "your cap" in Budget lab: OK on the cap slider posts it as the goal (the old re-averaged keep amount, `budget.capPref`, is no longer read), the full screen shows the calculated cap and your cap side by side with what each leaves on the day the plan runs to (and how short the 1st is with the autopay plan), and a 7-day tracker judges each day against your cap in force that day and against that morning's logged `pace.days[].cap`, so a later cap never turns a past miss into a win. `./hub budget goal` with no number and `budget.goal` with no args say when it was last set, never the amount.

When `room` is below zero and `autopayRoom` is there, Budget lab works from `autopayRoom` instead of showing "You're $X short even at $0 a day": its header says the 1st is short and the plan relies on the cards' autopay days (up to `autopayDate`), then the usual cap screen runs off `autopayRoom`. When `autopayRoom` is below zero too, the move money screen shows that shortfall.

### `runway`: headroom from today to card day

| Field | Type | Notes |
|---|---|---|
| `start` | dollars, may be negative | required: headroom this morning, checking less what the cards owe today, less the floor, less pending refunds, plus `spentToday`. Never checking or a card balance by itself |
| `end` | date | required: card day |
| `steps` | list, at most 40 | required, in date order, none after `end`: `{ "date": "2026-11-20", "delta": 2600, "kind": "pay" }`; `delta` is dollars, may be negative; `kind` is `pay` (`delta` 0 or more), `bill` or `reserve` (`delta` 0 or less). `reserve` is the bills from card day to the next payday, as one step on card day. No bill names: a `label` sent is dropped |

The headroom on card day (`start` plus every `delta`) is the same figure as `lab.room`. The TV draws the runway without a dollar axis.

### `planned`: planned buys

The budget app's planned buys, all of them, in the owner's order (budget repository PR 158). The budget app is their only home: the hub keeps no list of its own and Budget lab on the TV shows exactly this section. Sent with every snapshot, `items: []` when there are none.

| Field | Type | Notes |
|---|---|---|
| `cardDay` | date | optional: the card day the states were worked against |
| `items` | list, at most 50 | required. Each: `id` (1 to 40 of `A-Z a-z 0-9 _ -`; the budget app uses 8 hex), `label` (text, 24, required), `amount` (dollars, more than 0, required), `date` (date or `null`: no day), `match` (text, 40, or `null`: the words a charge must hold; without it the label is matched), `state` (required) |

`state` is `upcoming` (counted in Card day and the daily room: no date, or from today to the day before card day), `later` (on or after card day, not counted yet), `overdue` (its day passed with no charge; not counted) or `matched` (the charge is in; then `matchedDate`, `matchedAmount` and `matchedMerchant` (text, 40) say which, and that charge stays out of the daily goal and the streak).

**Changes from the TV.** Budget lab's full screen lists them (Planned buys) and adds, changes and removes them with the remote. The TV posts `POST /budget/planned` to the hub server (`pi/budgetplanned.js`): `{ "op": "add", "label", "amount", "date", "match" }`, `{ "op": "edit", "id", ... }`, `{ "op": "remove", "id" }` or `{ "op": "unmatch", "id" }` ("not this charge"). The hub server passes it on to the budget app on the Pi (`BUDGET_APP_URL`, default `http://127.0.0.1:8000`; the hub's own `HUB_TOKEN` as a Bearer, or `BUDGET_APP_TOKEN`): `POST /api/planned`, `PUT /api/planned/<id>`, `DELETE /api/planned/<id>`, `POST /api/planned/<id>/unmatch`. The budget app answers with the whole list, which the hub stores as this section at once (so every screen shows it before the next snapshot), and then sends a fresh snapshot too. A refusal (400, 404) reaches the TV as a toast with the budget app's reason; a budget app that does not answer is a 502 and one log line. The log never names a buy or an amount: `screen added a planned buy`, `screen changed a planned buy`, `screen removed a planned buy`, `screen said a planned buy's charge was not it`. On the TV, guest mode blurs the amounts and makes the list read only. `./hub budget show` prints `4 planned buys (2 upcoming, 1 overdue, 1 matched)`.

### Privacy for Budget lab

- **Merchant names and their month-to-date totals** for the top 5 merchants are allowed: the owner asked for them on 2026-11-17. Rent is left out by its category in the budget app, not by name.
- **No transaction list.** `pace.days` is one total per day, the same grain as the room figures.
- **No balance.** The runway is headroom (checking less the cards, the floor and pending refunds), never checking or a card balance on its own, and the TV draws it without figures on its axis; only the gap on card day carries a figure.
- **No amount on an alert**, as before.
- `./hub budget show` and the mailbox's `budget.show` print counts, dates and states for these sections, never a merchant name or an amount: `merchants  5 merchants in 2026-11`, `pace  14 days (13 with a cap), 2026-11-03 to 2026-11-16`, `runway  6 steps to 2026-12-01 (1 payday, 4 bills, 1 reserve)`.
- The snapshot only travels on the Pi itself (127.0.0.1), never through the mailbox or the cloud.

The four Budget lab sections are optional like the others and checked one by one; a snapshot with only `room`, `cardDay`, `goals` and `alerts` is stored as before. A hub server older than 0.5.0 drops the four sections and keeps the rest; one older than 0.16.0 drops `investments` the same way.

### `investments`: the portfolio

Added with server 0.18.0. Sent by the budget app from its investment accounts' holdings, at least once a day (the app logs one total per date so the trend builds from the first day).

| Field | Type | Notes |
|---|---|---|
| `total` | dollars, 0 to 10,000,000 | required: the whole portfolio |
| `cost` | dollars, 0 to 10,000,000 | optional: what was paid in (the cost basis) |
| `gain` | dollars, may be negative, up to 10,000,000 either way | optional: `total` less `cost`; the TV shows it as +$X or -$X and as a percent of `cost` |
| `accounts` | list, 1 to 6 | required: `{ "label": "Roth Contributory IRA", "value": 30110.2, "gain": 5200.1 }`; `label` is text, 30; `value` is dollars, 0 to 10,000,000; `gain` is optional and signed. No account numbers |
| `top` | list, 0 to 8 | optional, biggest first: `{ "ticker": "VTI", "name": "Vanguard Total Stock Market ETF", "value": 21000, "gain": 3100 }`; `ticker` is text, 10, and may be empty or left out (cash); `name` is text, 40; `value` is dollars; `gain` is optional and signed. No share counts |
| `history` | list, 0 to 92 | optional, oldest first, one per date, dates ascending (a repeated or earlier date refuses the section): `{ "date": "2026-11-18", "total": 48100 }`. The TV draws it as a trend line without an axis |

On the TV: the Investments tile (`investments`, standalone, in no layout; add it in Layout Studio or `layout.set`). Smallest size: the total and the gain against cost (`+$8,110 · +20.2%`, green when up, coral when down). Wider: a trend line from `history` (hidden under 2 points, with "Trend starts building today"). Bigger: an allocation bar by account and the top holdings with their share of the total. A click opens it in place with every account and holding. In guest mode **no dollar figure is drawn**: only percentages (the gain percent, each account's and holding's share) and the shape of the trend. Old data (over 2 hours) dims and says "as of 9:10 AM"; with no section the tile says "Waiting for the budget app".

### Privacy for investments

- **Dollar figures for the portfolio total, each account and the top holdings are allowed on the TV: the owner approved them on 2026-11-19** (the second exception to "no balance", after the Card day receipt). Guest mode (Clock page) blurs them on screen; percentages stay readable. The TV keeps the figures as it does with Guest mode off.
- Never account numbers, share counts, purchase dates or a transaction list. A field not named above is dropped.
- `./hub budget show` and the mailbox's `budget.show` print counts and dates only: `investments  6 accounts, 8 holdings, 31 days of history, 2026-10-19 to 2026-11-18`.
- The snapshot only travels on the Pi itself (127.0.0.1), never through the mailbox or the cloud.

### `trends`: where everyday spending goes

Added with server 0.35.0, for the Spending widget's **Where it goes** page. **Everyday spending only**: the same rule as `pace.spent` (rent, utilities and other recurring bills left out). Built by the budget app (its own repository; this is the contract for it). Every list is optional, so a later addition (one total per day for a Month vs month page) can join the section without breaking anything; until the budget app sends it, the page says "Where it goes is on its way".

| Field | Type | Notes |
|---|---|---|
| `month` | month, `2026-11` | required: the month the figures are for |
| `categories` | list, at most 8 | optional, any order (the TV sorts biggest first): `{ "label": "Food", "mtd": 412, "usual": 520 }`; `label` is text, 30, the spending bucket as the owner knows it; `mtd` is dollars, this month so far (through yesterday); `usual` is dollars or `null`/left out, the 3-month average **up to the same day of the month** (the average of the last 3 months' totals from the 1st to that day). With no `usual` the TV draws no tick for that row and says "No usual yet" |
| `merchants` | list, at most 8 | optional, the same shape as `categories`: the top merchants by `mtd` this month. As with `merchants` above, one order can count for two merchants, so the TV never adds them up |
| `weekdays` | list of exactly 7 | optional: the average everyday spend per weekday, **Monday first** (Monday, Tuesday, ... Sunday), dollars or `null` for a weekday with no data. The budget app chooses the window (8 weeks is a good default); a list that is not 7 long refuses the section |

Unknown fields are dropped, as everywhere. The TV compares this month with the usual in whole dollars ("$108 less" in green, "$12 more" in coral), draws each list on its own scale with a tick at the usual, and marks the weekdays whose average is above the daily goal in force yesterday (`pace.goals`; with no goal it only draws the bars). About 1 to 2 KB with every list full.

### Privacy for trends

- **Category totals, merchant totals and their "usual" figures are allowed on the TV: the owner approved them on 2026-11-24** (the third exception, after the Card day receipt and investments). Guest mode (Clock page) blurs every dollar figure on the page; the bars, ticks, names and "less/more" stay.
- Totals only: never a transaction, a date of a charge or an account. A field not named above is dropped.
- `./hub budget show` and the mailbox's `budget.show` print counts only: `trends  3 categories, 5 merchants, 7 of 7 weekdays in 2026-11`.
- The snapshot only travels on the Pi itself (127.0.0.1), never through the mailbox or the cloud.

## What the Pi keeps

The resource `budget` in `data/state.json`, sent to the TV with everything else:

```json
{ "v": 1, "sentAt": "2026-11-16T15:10:00Z", "receivedAt": "2026-11-16T15:10:01Z", "room": { ... }, "goals": { ... } }
```

Before any snapshot, and after `./hub budget clear`, it is `{ "v": 1, "sentAt": null, "receivedAt": null }` and the tiles say "Waiting for the budget app". Every accepted snapshot is stored and pushed, even when nothing changed: the new `sentAt` is what keeps the tiles from calling it old.

## Reading and clearing

On the Pi:

- `./hub budget show`: when it was sent, its size, and one line per section with dates, counts and states only, never a label or an amount. For example `cardDay  2026-11-19 (in 3 days), covered, 3 transfers, 2 paychecks, as of 9:05 AM` or `lab  2026-12-01 (14 days left), day 17 of the month, room to spare, split in 3, as of 9:05 AM`.
- `./hub budget set file.json`: store a snapshot (`-` reads it from input). The file is the snapshot itself, or `{ "snapshot": { ... } }`.
- `./hub budget clear`: remove everything.

Control API (token needed, see `docs/live-updates.md`):

| Call | Body | Answer |
|---|---|---|
| `GET /api/budget` | | `{ ok, rev, data, tz }` |
| `POST /api/budget` | `{ "snapshot": { ... } }` or `{ "snapshot": null }` to clear | `{ ok, rev, changed, bytes, accepted: [], cleared: [], rejected: [{ section, error }] }` |

`POST /api/budget` answers `400` and changes nothing when the snapshot as a whole is wrong (not an object, wrong `v`, bad `sentAt`, no sections, over 48 KB) or when every section in it was rejected. Bodies may be up to 64 KB. The server's log notes each call without its contents (`control POST /api/budget -> 200 4 sections stored, 914 bytes, rev 58`).

## On the TV

- `budget-room` (Daily room), `budget-card` (Card day) and `budget-goals` (Goals), with a wallet icon. `budget-lab` (Budget lab) reads `lab`, `merchants`, `pace` and `runway` (the runway as a chart at full screen from hub v0.29.5, with no dollar axis; its one figure is the gap on card day). Every size works; [tile-sizes.md](tile-sizes.md) says what each shows. `spending` (Spending, `app/widgets/spending.js` with `app/spending-math.js`) reads `pace.days` as everyday spending and a dated goal history (`pace.goals`, `[{ from, goal }]`, when the snapshot carries it; until then a single `pace.goal`, else no goal): the 7-day and 30-day averages, days under the goal, what was kept and the Trend page at full screen. Its windows always end yesterday (the TV's date, in the Pi's time zone): when `pace.days` stops earlier (the budget app or the Pi was off), the missing days are neither under nor over, the streak is not carried over and the tile says “No data since Nov 12” instead. The **Budget** layout in the switcher places Daily room and Spending on top, Budget lab, Card day and Goals below.
- The Spending full screen has two pages, **Trend** and **Where it goes** (`trends`): on the TV Down switches to Where it goes and Up (at its top) or Left goes back; on the tablet the two pills at the top switch. Where it goes shows the categories and the top merchants as bars with a tick at the usual, and the 7 weekdays against the goal; with no `trends` section it says "Where it goes is on its way", and when `month` is not the current month (the TV's date in the Pi's time zone) it says "Waiting for this month's figures" rather than show an older month as this one.
- A section that is missing makes its tile say "Waiting for the budget app"; with no line to the Pi they say "Needs the Pi" or "Can’t reach the Pi".
- The TV keeps its last copy (`homeHub.budget.v1`), so the tiles have something to show straight after the TV turns on.
- `widgets.budget.show: false` in `app/config.js` hides it all on that TV: the tiles say "Budget is hidden" and the banner never shows.
