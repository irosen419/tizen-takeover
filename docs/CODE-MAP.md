# Code map

One page to find your way around. Features live in `README.md` and `docs/`; this is only where things are. Counts are approximate (main at v0.50).

The Architecture page's drawer shows this map beside each part (`studio/codemap.js` reads sections 2, 3, 4, 6 and 8). After editing it, run `node studio/build-architecture.js`, then `node dev/codemap-test.js`.

## 1. The picture in two minutes

Four places run code:

- **TV page, `app/`.** ES5 in the TV's browser. TizenBrew opens it from jsDelivr (`irosen419/tizen-takeover@main`).
- **TV helper, `service.js`.** ES5 Node inside TizenBrew, on `127.0.0.1:8095` only: lists and opens apps, sends keys and webhooks, fetches weather.
- **Pi server, `pi/`.** Node 22, CommonJS, no npm packages, in Docker (`node:22-alpine`, `pi/docker-compose.yml`) on port 8097. It also serves the touch app (`app/touch.html`).
- **Cloud.** jsDelivr (code to the TV), a Cloudflare R2 bucket used as the Claude mailbox (Claude to Pi), and the Layout Studio artifact.

```
 GitHub main --jsDelivr--> TV page (app/) <--8095--> service.js (TV)
                              |   ^
              POST /grocery/ops   |  /live/events (push)
                              v   |
 phone (touch app) -------> Pi server (pi/server.js :8097)
                              ^    ^
              ./hub (hubctl.js)    |  mailbox.js polls R2
                                   |
                  Claude (dev/hub-remote.js) --R2 inbox/outbox
```

Support folders: `dev/` (tests, screenshot scripts, laptop preview, version tools; never on the TV or Pi), `studio/` (Layout Studio source and the architecture page data), `docs/`, `art/` (offline image tools; ignore).

## 2. Folders

| Folder | Language | Runs where | Start reading at |
| --- | --- | --- | --- |
| `app/` | ES5 JS + CSS, no modules | TV browser; also phones (touch app) | `app/hub.js` |
| `app/widgets/` | ES5, one file per widget | same | `app/widgets/wotd.js` |
| `service.js` | ES5 Node | TV (TizenBrew service) | top of the file |
| `pi/` | Node 22 CommonJS, async/await | Pi (Docker) | `pi/server.js` |
| `dev/` | Node CommonJS, Playwright | laptop or cloud | `dev/run-affected.js` |
| `studio/` | one HTML file + data | claude.ai artifact | `studio/README.md` |
| `docs/` | Markdown | n/a | `docs/live-updates.md` |

## 3. Read these first (in order)

1. `package.json`: the TizenBrew manifest (`appPath`, `hubPage`, `serviceFile`) and the version.
2. `app/index.html` and `app/update.js` (about 850 lines, read the top comment): the loader. It asks GitHub for the newest commit and opens that commit's `hub.html`.
3. `app/hub.html`: the script order is the load order (`update.js`, `config.js`, backgrounds, i18n, `guest.js`/`pin.js`/`icons.js`/`logos.js`, the widgets with their data files, `live.js`, `clay.js`, `agents.js`, `motion.js`, `appver.js` (newer code on the Pi, for pages the Pi serves), then `hub.js` last).
4. `app/config.js` (about 550 lines): `HUB_PI`, the built-in `layout`, the saved `layouts`, per-widget `widgets` settings.
5. Top comment of `app/hub.js` (the file is about 3,600 lines): the widget contract and `ctx`.
6. `app/widgets/wotd.js` (about 350 lines): a small, complete widget to copy.
7. `app/live.js` (about 550 lines): the header lists its whole API.
8. Top comment of `pi/server.js` (the file is about 2,400 lines): every route. Then `handler()` near line 2130.
9. `pi/grocery.js` (about 170 lines) and `pi/grocery-test.js`: a small Pi feature and its test.
10. `pi/hubctl.js` (about 1,600 lines, behind `pi/hub`) and the `COMMANDS` table in `pi/mailbox.js` (about 1,400 lines).

## 4. How things flow

**a. Boot.** TizenBrew opens `app/index.html`, which runs `app/update.js` and moves to the newest commit's `app/hub.html`. That page loads the scripts; each widget file pushes an object onto `window.HUB_WIDGETS`; `app/hub.js` builds the grid from the layout and calls `started()` so `update.js` knows this commit is good (if it never does, the loader goes back to the last good commit).

**b. Pi to TV (push).** `app/live.js` reads `/live/state`, then holds `/live/events` open (Server-Sent Events; `/live/poll` is the fallback). When the Pi calls `changeResource(name, data)` in `pi/server.js`, it bumps `rev`, saves, and runs `broadcast('change', ...)`. `hub.js` passes the data to widgets through `ctx.live.on(resource, fn)`.

**c. TV to Pi (an action).** Ticking a grocery item: the widget's `onSelect` in `app/widgets/grocery.js` calls `send([{ op: 'check', ... }])`, which does `ctx.live.post('/grocery/ops', { ops })` (`HUB_LIVE.post` in `app/live.js`). `handler()` routes it to `touch()` (it is in `TOUCH_ROUTES`), `groceryOps()` runs `grocery.applyOps()` in `pi/grocery.js`, `changeResource('grocery', ...)` broadcasts, and every screen redraws.

**d. TV to its helper.** `ctx.service('/launch?id=...', ms, cb)` in `app/hub.js` calls `service.js` on `127.0.0.1:8095`.

**e. Claude to Pi.** `dev/hub-remote.js` writes `inbox/<id>.json` to the R2 bucket. `pi/mailbox.js` polls (every 10 seconds unless `HUB_MAILBOX_POLL_SECONDS` says otherwise), runs only what is in `COMMANDS`, calls the control API in process, and writes `outbox/<id>.json`. `./hub` on the Pi (`pi/hubctl.js`) calls the same API over HTTP with the bearer token.

**The doors on the Pi server** (`handler(door)` in `pi/server.js`):

| Door | Routes | Who gets in |
| --- | --- | --- |
| Screen routes (`SCREEN_ROUTES`) | `/live/*`, `/todo/ops`, `/shows/*`, `/echo/run`, `/guest/pin`, ... | home-network addresses (or `HUB_TV_IPS`), no token |
| Touch routes (`TOUCH_ROUTES`) and the touch app files (`/`, `/app/...`) | `/touch/state`, `/touch/todo/ops`, `/grocery/ops`, `/pantry/screen-ops`, `/products/*`, `/spanish/progress`, `/spanish/ops` | home and Tailscale addresses |
| Photo album (`photoRoute()`, `pi/photos.js`; files from `pi/photos-sync.sh` on the Pi host) | `GET /photos/list`, `GET /photos/img/<id>?size=full\|thumb`, `GET /photos/clip/<id>` | home and Tailscale addresses |
| Control API (`control()`) | `/api/*` | bearer token |
| Side door | control API only, on `127.0.0.1` at `HUB_TUNNEL_PORT` | local processes, bearer token |
| `/health` | none | anyone |

## 5. Two dialects

| | `app/` and `service.js` | `pi/` and `dev/` |
| --- | --- | --- |
| Syntax | ES5: `var`, `function`, no arrow functions | modern Node: `const`, async/await |
| Modules | none: `<script>` tags and shared globals | CommonJS `require` |
| Network | `XMLHttpRequest`, not `fetch` | `http`, `fetch` |
| Shared state | `window.HUB_*` globals | module exports |

The main globals: `HUB_CONFIG` (`config.js`), `HUB_WIDGETS` (every widget), `HUB_I18N` (`i18n.js`, English and Spanish), `HUB_LIVE` (`live.js`), `HUB_GUEST`, `HUB_PIN` (`pin.js`), `HUB_ICONS`, `HUB_SHOWS`, `HUB_AUDIO`, `HUB_AGENTS`, `HUB_CLAY`, `HUB_NP_BAND` (Ian and Ember on the Now Playing page, `docs/band.md`), `HUB_FX`, `HUB_UPDATE`, `HUB_BUILD` (the version). `HUB_TEST` is for tests only. The bare `var HUB_PI` in `config.js` is the Pi's address.

Ruby readers: `handler()` is a hand-rolled Rack app with route hashes; a widget is a duck-typed object (implement what you need, skip the rest); each test's `check(name, fn)` is a bare assert, no framework.

## 6. Recipes

**Add a widget.**
1. `app/widgets/<id>.js` plus `app/widgets/<id>.css`, which ends with `.css-end { top: 0; }` and is listed in `dev/styles-test.js` ORDER.
2. Script and stylesheet tags in `app/hub.html`, before `app/hub.js`.
3. A layout entry and settings in `app/config.js`.
4. A Spanish section in `app/i18n.js` (allow 25% longer text; diacritics must not clip).
5. The Studio: `WIDGETS` and `SIZE_MATRIX` in `studio/layout-studio.html`, `docs/tile-sizes.md`, then `node dev/studio-sync-test.js`.
6. A test, `dev/<id>-test.js`.

**Give it Pi data.** A new `pi/<name>.js` and `pi/<name>-test.js`, wired in `pi/server.js`: seed a live resource in `freshState()` and change it with `changeResource`, or add a route to `SCREEN_ROUTES`/`TOUCH_ROUTES` and handle it in `screen()`/`touch()`. Model: `pi/grocery.js`.

**Let Claude drive it.** An `/api/...` route in `pi/server.js` (mailbox commands call the control API in process), then a `COMMANDS` entry in `pi/mailbox.js` and the matching subcommand in `pi/hubctl.js`; list it in `pi/CLAUDE.md`.

More detail: "Writing a widget" in `README.md` and the top of `app/hub.js`.

## 7. Test, preview, version, deploy

- `npm test` runs only the suites your change affects (mapping rules in the header of `dev/run-affected.js`). `npm test -- --failed` re-runs the failures. One suite: `node dev/<name>-test.js` or `node pi/<name>-test.js`.
- Suites share fixed ports: run one at a time.
- Laptop preview: `node dev/preview.js` (serves `app/`, fakes `service.js`, and runs the real Pi server on :8097; open the hub with `?live=http://127.0.0.1:8097`).
- Version: a PR never changes it. Right before merging, run `node dev/bump.js minor` (or `patch`) (see `docs/process.md`). The Pi server has its own version in `pi/server.js`.
- Deploy: merge to `main`, then jsDelivr serves it to the TV (the About panel on the Clock page shows the real version). The Pi pulls `main` by itself every 5 minutes (`pi/autopull/autopull.sh`, a systemd user timer from `pi/autopull/install.sh`; test `pi/autopull-test.js`) and restarts the hub, then the budget app, only when a server file in `pi/` changed; pages the Pi serves reload through `app/appver.js` (test `dev/appver-test.js`). `hubup` (`pi/aliases.sh`) is for the first install or a stuck pull. Data changes go through the mailbox and need no restart.

## 8. Where to look when...

| Symptom | Look at |
| --- | --- |
| TV blank or old after a merge | `app/update.js` (held commit, jsDelivr cache), About panel's Version check row |
| Wall tablet or phone old after a merge | the auto-pull log, ~/.local/state/tizen-takeover/autopull/autopull.log on the Pi (`hubauto`), and its kill switch autopull.off in the same folder; `app/appver.js` (About panel's Version check row, the dot on the Clock tile) |
| TV Menu tab (Down off a bottom tile): settings, Guest mode, layouts on any layout; remote focus in the sheet | "the Menu on a TV" in `app/hub.js`, last block of `app/tablet.css`, `docs/tv-menu.md`; `dev/tvmenu-test.js` |
| Auto-rotate layouts (Menu > Settings > Rotate layouts): next layout every 2 min, 5 min after use | "auto-rotate layouts" in `app/hub.js`, `rotate: false` in `app/config.js` layouts, `docs/tv-menu.md`; `dev/rotate-test.js` |
| A tile shows an error box | that widget's file in `app/widgets/`; `hub.js` wraps every widget call in try/catch |
| Live dot not green | `app/live.js` status text; `./hub log --errors` on the Pi; `docs/live-updates.md` |
| A mailbox command failed | `outbox/<id>.json`, then `COMMANDS` in `pi/mailbox.js`; `dev/hub-remote.js status` |
| Spanish text clips | `app/i18n.js` and the widget's CSS; `dev/i18n-es-test.js` |
| Layout looks old | the Pi's saved layout beats `app/config.js` (`docs/live-updates.md`, "Tile layout from the Pi"); the Studio keeps its own draft |
| Phone app differs from TV | `app/touch.js` and the widget's `renderTouch` |
| A widget choice not the same on every screen (Clock face, 12/24, Budget lab's saved cap), or Guest mode "All screens" | `app/prefs.js` (HUB_PREFS), `pi/prefs.js`, `POST /prefs` and `/guest/pin` `{ all, on }` in `pi/server.js`, `app/guest.js` (guestall); `pi/prefs-test.js`, `dev/prefs-test.js` |
| Clock faces (Digital, Analog, Sun), the small Analog strip, sunrise/sunset and moon phase on the Sun face | `app/widgets/today.js` (`riseSet`, `sunNow`, `moonPhase`, `drawArc`, `drawMiniTile`) + `app/widgets/today.css`; face values allowed in `pi/prefs.js`; `dev/clock-test.js` |
| Budget lab's daily goal wrong or not saving | `pi/budgetgoal.js` (history in `data/budget-goal.json`, merged as `pace.goals`), `POST /budget/goal` in `pi/server.js`; `goalTrend` in `app/budget-lab-math.js`; `pi/budgetgoal-test.js`, `dev/budget-lab-math-test.js` |
| Spending tile or its pages wrong (streak, "No data since", Where it goes bars) | `app/spending-math.js` (windows end yesterday; `where()` for the second page), `app/widgets/spending.js` + `app/widgets/spending.css`; the `trends` section in `pi/budget.js`; `dev/spending-math-test.js`, `dev/spending-test.js`, `pi/budget-test.js` |
| A dollar amount readable in Guest mode | `app/guest.js` (blurs amounts on the money tiles, panels and banner: `MONEY`, `MATCHERS`), `.guest-blur` in `app/style.css`; `dev/money-test.js` |
| Wall tablet (Fully Kiosk): panels won't close, no layout menu, an app won't open on the TV, a panel won't scroll by touch | "tablet mode" in `app/hub.js`, `app/tablet.css` (Touch scrolling), `docs/tablet-mode.md`; `dev/tablet-test.js`, `dev/scroll-test.js` |
| Guest mode PIN pop-up, wrong PIN, forgotten PIN | `app/pin.js` + `app/pin.css` (the pop-up; `choose()` in `app/widgets/today.js` opens it), `POST /guest/pin` in `pi/server.js` -> `pi/guestpin.js` (hash in `data/guest-pin.json`, the lock); `./hub guest-pin reset`; `dev/pin-test.js`, `pi/guestpin-test.js` |
| Flashcards wrong (cards, rounds, progress not saved), or a tile that should engage on OK (short OK uses it in place, holding OK opens it) | `app/widgets/flashcards.js` + `.css`, `app/flash-math.js`, `app/spanish-cards.js` (from `dev/build-spanish-cards.js`); "engage on OK" in `app/hub.js`, `.tile-engage-hint` in `app/style.css`; `pi/spanish.js` (`data/spanish.db`), `/spanish/*` in `pi/server.js`; `docs/spanish-flashcards.md`; `dev/flashcards-test.js`, `pi/spanish-test.js` |

## 9. Glossary

- **Tile:** a widget's small card on the home screen.
- **Panel:** what a tile opens into, in place. **Full screen:** the panel grown to fill the TV.
- **Layout:** which tiles go where on the 12 by 6 grid. Built in (`app/config.js`) or sent by the Pi.
- **Live resource:** a named piece of Pi data pushed to the TV (`todo`, `grocery`, `calendar`, `layout`, `awws`, `budget`, `nowplaying`, `shows`, `linktests`, `allsounds`, `ambience`).
- **Door:** one of the listeners and access levels on the Pi server (section 4).
- **Mailbox:** the R2 bucket Claude uses to send commands to the Pi.
- **Touch app:** `app/touch.html`, the hub on a phone, served by the Pi.
- **Studio:** the Layout Studio artifact; source in `studio/`.
- **TizenBrew module:** how the hub is installed and started on the TV (`package.json`).
- **About panel:** on the Clock page; shows the version and status.
- **hubup:** the Pi shell alias that pulls and restarts the hub.

Not covered here, because it lives outside this repo: the budget app, the Alexa bridge, the cookbook skill and the project dashboard.
