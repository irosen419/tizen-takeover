# The Menu on the TV

The wall tablet's Menu sheet (`docs/tablet-mode.md`), on the TV, worked by the remote. It is there on every layout, so Guest mode, the look and the language can be changed without going to a layout with the Clock tile.

## Using it

- **Down off a bottom tile** raises a small "Menu" tab at the bottom edge, already focused (the tile lets go of its focus). **Up** or **Back** puts the tab away and gives the tile its focus back. Left and Right do nothing.
- **OK on the tab** slides up the whole sheet, the same one as the tablet: Settings (Look, Language, Guest mode, Rotate layouts), About this hub, Layouts, Photos (Start slideshow).
- **In the sheet** the arrows move a white focus ring between Close, each setting's choices, About's button row (the watch link test), the layouts and Start slideshow. Up and Down stay in their column (Up from the top goes to Close); with nothing further below, Down scrolls the column, for About's text. Left and Right go along a row, and from one column over to the other.
- **OK** chooses what has the focus, as a tap does on the tablet. Guest mode still asks for the PIN (`app/pin.js`, PR 165); the PIN pad takes every key while it shows, and Back there cancels it with the sheet still up. A layout is used at once and the sheet goes. Start slideshow shows the photos until Back or OK ("Back to close").
- **Back** closes the sheet; the tile it came from has its focus again.

The Clock page keeps its own Look, Language and Guest mode rows, and Left (About) and Up (the layout bar) work as before.

## Code

- `app/hub.js`, "the Menu on a TV": `showPeek`, `hidePeek`, `peekKey`, `tvSheetKey`, `sheetItems` (what the remote can land on, by key: `close`, `set:<choice>`, `about:<n>`, `lay:<n>`, `show`), `sheetPick` (next item by position), `markSheetFocus` (draws the ring again after the settings or About redraw). The sheet itself is the tablet's (`buildSheet`, now built at start on every device; tablet mode reuses it).
- `app/tablet.css`, the last block (`html:not(.tablet)`): the tab out of sight until `.is-peek`, the bigger tab, an opaque sheet, columns that clip (the focus scrolls them), the focus ring.
- Test: `node dev/tvmenu-test.js` (`SHOTS=<dir>` saves screenshots). `dev/tablet-test.js` checks the tab stays out of sight on a TV.

## Rotate layouts

A setting in the sheet, per screen (kept in this screen's `homeHub.autoRotate`, like Look and Language), off by default. When on, the hub moves to the next saved layout (`HUB_CONFIG.layouts` order, skipping any with `rotate: false`: Default and the test layouts) every 2 minutes. A key, click or touch pushes the next move to 5 minutes after it. Nothing moves while a tile is open, a web page is full screen, the Menu, layout bar or About strip is up, or the PIN pad or slideshow shows; the 5 minutes count from when that closes. A layout with other tiles reloads the page, which starts the 2 minutes again. Code: "auto-rotate layouts" in `app/hub.js`. Test: `node dev/rotate-test.js`.
