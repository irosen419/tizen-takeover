# How changes get made and released

## Version: a label stamped at merge

- A PR does **not** change the version. Do not edit `package.json`, `package-lock.json`, `BUILD` in `app/hub.js`, `VERSION` in `service.js`, or the README's About-panel example. Open PRs that all leave those lines alone never conflict over them.
- Right before merging, stamp the next version once, from whatever `main` says now:
  ```
  git fetch origin main && git merge origin/main
  node dev/bump.js minor      # or patch; counts from origin/main
  npm test                    # only what this PR affects
  git commit -am "Version 0.x.y" && git push
  ```
  then merge the PR straight away. If `main` moved in between, merge it again and re-run `node dev/bump.js minor`; it is safe to repeat.
- `node dev/bump.js --check` (or `npm run version:check`) lists every place and says whether they agree; `--sync` makes them match `package.json`. `dev/version-test.js` runs the same check.
- The version is only a label. Ian checks what the TV runs in the Home Hub About panel (Clock page); the TizenBrew menu lags and is not the source of truth.
- Text like "v0.39.0" in comments, test names and `docs/tile-sizes.md` is history. Never renumber it.
- The Pi server has its own version (`pi/server.js`). It only moves when the server changes.

## Tests

- `npm test` runs only the suites the branch can affect (changed files compared with `origin/main`, plus uncommitted ones) and prints one line per suite. A failure prints its first failing lines.
- `npm test -- --list` shows what would run. `npm test -- --failed` re-runs only the suites that failed last time (use it after each fix). `npm test -- soundctl clock` runs named suites. `npm run test:full` runs everything (45+ minutes; do it only when asked, or when more than a fifth of the suites failed).
- Mapping (see the header of `dev/run-affected.js`): a changed suite runs itself; a changed file runs the suite with its name; a suite that mentions the file runs; shared files (`hub.js`, `config.js`, CSS, `i18n`) run a core set; docs and images run nothing.

## Threads

- One thread per PR. Resolve the thread when the PR merges. Follow-ups and TV bugs get a fresh thread with a handoff note of 15 lines or fewer.
- Hard stop near 40M tokens or about 150 messages: write the handoff note and start a new thread.
- One checklist post at the start and one at the end, not one per step. The coordinator batches relays.
