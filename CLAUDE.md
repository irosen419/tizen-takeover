# Home Hub: notes for Claude

Custom home screen for Ian's Samsung Tizen TV (TizenBrew module, loaded from jsDelivr `irosen419/tizen-takeover@main`). Plain ES5 on the TV: no CSS grid, no flex gap, animate only transform/opacity. Pi server in `pi/`. Details: `README.md`, `pi/CLAUDE.md`, `pi/README.md`, `docs/`.

## Layout
- `app/` TV code: `config.js` (tiles, layouts), `hub.js` (UI), one JS+CSS pair per widget, `i18n` (English + Spanish).
- `service.js` helper on the TV (localhost:8095). `pi/` server, `./hub` CLI, mailbox, tests. `studio/` Layout Studio. `dev/` tests and screenshot scripts.

## Rules
- Never push or merge `main` without Ian's say-so (project memory has the standing merge go-ahead). Work on your branch, open a PR.
- One thread per PR. Stop near 40M tokens; hand off in 15 lines or fewer.
- Be succinct. Anything Ian must copy goes in a fenced block (he reads on a phone).
- Every CSS file ends with `.css-end { top: 0; }` and is listed in `dev/styles-test.js` ORDER.
- New UI text goes into i18n with Spanish (allow +25% length, diacritics must not clip). Before/after mock-ups change only the thing changed.
- A large architecture change also updates the architecture diagram (`dev/architecture-*`, Layout Studio Pages chip).
- Never print secrets (`pi/.env`) or personal data in logs, commits, or replies.

## Tests
Run only suites for files you touched: `node dev/<name>-test.js` (browser suites) and `node pi/<name>-test.js`. Re-run only what failed. Do not run all suites repeatedly.

## Pi chores from the cloud
`node dev/hub-remote.js status` (is the Pi up), `node dev/hub-remote.js <cmd> '<json args>'` (one-line result). Commands: COMMANDS in `pi/mailbox.js`. It cannot git pull or restart: Ian restarts (`hubup` on the Pi, see `pi/aliases.sh`); never ask him to run steps you can send through the mailbox.

## Deploy
Data/content changes reach the TV through the mailbox, no restart. Code in `pi/`: Ian runs `hubup` (pull, restart hub, then budget). Restarts are always confirmed with Ian first. After merging to `main`, jsDelivr may lag; the About panel (Clock page) shows the real version.
