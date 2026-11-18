# Layout Studio

`layout-studio.html` is the source of the Home Hub Layout Studio artifact
(https://claude.ai/artifact/JtD3vYbeiscHxDfKCyc7BH). It is not loaded by the
TV. It is kept here so the page and the TV code can be changed together.

The "What shows at each size" section is driven by one object in the page,
`SIZE_MATRIX`. `docs/tile-sizes.md` is the same table in English. When a
widget's tile changes what it draws at a size, update both.

## Staying in sync with the hub

The Studio must hold every widget and every layout the hub has. `node dev/studio-sync-test.js` (no browser) fails when:

- a widget is registered in `app/widgets/*.js` that the Studio's `WIDGETS`, `SIZE_MATRIX` or `SZ_ORDER` lacks;
- `TV_DEFAULT` differs from `HUB_CONFIG.layout` in `app/config.js`;
- `TV_LAYOUTS` differs from `HUB_CONFIG.layouts` (a layout added, moved or renamed);
- a widget is marked built in the Studio but is still `soon`, or is in the Studio, absent from the hub and not marked `soon` (a proposal).

Any PR that adds or changes a widget or a layout updates the Studio in the same PR, runs this test, and then republishes the page (same URL). Proposed widgets that are not built yet go in with `soon: true` and a `budgetPlanned`/`plannedEntry` size entry, so they can be placed and commented on.

## Architecture page

The "Pages → Architecture" chip in the Studio swaps the workspace for an expandable map of the whole system (TV, Pi, cloud, outside services, scheduled tasks, Studio and tools), with search, status filters, data flows and a big-picture diagram.

- The map is data: `studio/architecture/data.json` (nodes with status `live`, `unverified`, `draft` or `planned`, files, links, plus `flows` and the `overview` diagram). `arch.js` and `arch.css` in the same folder draw it.
- The Studio is published as one file, so run `node studio/build-architecture.js` after editing any of the three to copy them into `layout-studio.html` (`--check` only reports), then republish.
- `node dev/architecture-test.js` checks unique ids, links, flow steps, that live nodes' files exist, that no email, IP address, account id or token is in the data, and that the Studio carries the same data.
- When a PR lands or something is checked on the real TV, change that node's status in `data.json`.
