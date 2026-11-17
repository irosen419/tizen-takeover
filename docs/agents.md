# Characters beside the chips

When a tile shows a working chip ("Working on to-dos", "Checking calendar") or an arrival chip ("Incoming to-do", "Updating calendar"), a pixel-art character swoops in beside it. Today there is one: Lift, the Edgedancer from Brandon Sanderson's Stormlight books, skating on Stormlight with her spren Wyndle. The character is not tied to a widget or a kind of chip: any tile with a chip can get her.

## What she does

- **In:** she glides in along the tile's bottom edge from the side, on a short trail of Stormlight under her feet, and settles at the tile's bottom right (the chip is at the bottom left). On a tile too narrow for both she stands just above the chip, at the tile's right. A tile on the right half of the screen has her come from its left, one on the left half from its right, so she stays on screen.
- **Idle:** while the chip lasts (a working chip can last 2 minutes or more) she bobs a little and Wyndle sways. After 20 seconds the bob stops and the sway slows, to keep it cheap.
- **Out:** when the chip fades, or the working chip turns into the arrival chip, a quick Stormlight pulse and a few sparkles where she stands, then she glides out the way she came.
- **At once:** anything that takes a chip away at once (a panel opening, the dashboard, a layout change, a resize, the hub slowing down) takes her away at once too, with no glide.
- The chip is never changed: its words are still there, in English or Spanish. She comes only when the screen keeps full speed (`HUB_FX.can('activity')`) and the home screen is quiet. On a slow screen, in fade mode, with less motion asked for, or with the motion extras off, the chip shows alone.
- At most one character on a tile and two on screen.

## Settings

In `app/config.js`:

```js
agents: { on: true, who: 'lift' },
```

- `who`: the character, a name in the roster (below). A name that is not there turns them off, with no error (the About panel says `off (no character called ...)`).
- `agents: false` or `on: false` turns them off; so does `?agent=off` on the hub's address for one visit. Off, nothing of theirs loads and no element is added.
- `?agent=lift` picks that character for one visit, even with the config off (for tests).

## The About panel

Press Left on a left-most tile. The **Characters** group, in the hub's language, shows from the first working or arrival chip since the page loaded (before it there is nothing to say):

- **Now:** `Lift, on To-do` (the tile's title), `none`, or `loading pictures`.
- **Seen:** how many times she has swooped in since the page loaded.
- **Drawing:** `on`; `chips only (slow screen)` (the chips still run, she does not); `off (fade mode)`, `off (slow screen)`, `off (config)`, `off (?agent=off)`, `off (no character called x)`, `off (the activity chips are off)`, or `off (pictures did not load; tried again in 10 min)`.

## How it stays light on the TV

- Two pictures, 14 KB in all (`app/agents/lift/lift.webp`, 132 x 112, and `wyndle.webp`, Wyndle's head and neck so he can sway). They load 6 seconds after the hub starts, or at the first chip if that comes sooner. Each is asked for up to three times (again 1 s and 2.5 s after a failure), as the clay wanderers' frames are, because the TV's proxy now and then fails one request in a batch. If one still fails, or loads without decoding, there is no swoop (never a broken picture), and loading is tried again 10 minutes later. A chip that comes while they load gets her once they are in, if it is still there.
- Only `transform` and `opacity` move: CSS transitions for the glide, CSS animations for the bob, the sway, the trail and the pulse. No filters, no shadows, no layout changes.
- One click-through layer (`.ag-layer`, z-index 9, like the wanderers') above the tiles and under the panels, the dashboard and toasts. It is added with the first character and removed with the last.
- The pictures are drawn at 1:1 at 1080p (`image-rendering: pixelated`, sizes in rem), so each art pixel is a screen pixel.
- Every entry point is wrapped; if anything here fails, the hub carries on exactly as without it. It writes nothing to the console.

## Adding or swapping a character

1. Make the pictures: transparent WebP drawn at the size they are shown at 1080p (about 110 to 140 px tall), in `app/agents/<name>/`. `art/agents/extract.py` is how Lift's were made: it cuts the big frame of a pixel-art sheet out of its flat grey background (a flood fill from the edges, closed-in grey patches, and the greyish fringe so there is no halo on the dark blue), brings it down to the art's own pixels and cuts Wyndle's head out as its own picture. The source sheet is private reference art kept in the project files (`home-hub-agents/gemini/`), not in this repository. Check the result on a dark and a light backdrop (its third argument writes both previews).
2. Add an entry to `ROSTER` at the top of `app/agents.js`: `name`, `dir`, `w` and `h` (the box, in sprite pixels), `faces` (`'right'` or `'left'`, which way the art looks), `parts` (each picture's `file`, `left`, `top`, `w`, `h`; `sway: true` sways it about its bottom middle), and `trail` (where the Stormlight trail starts, behind the feet).
3. Set `agents.who` in `app/config.js`.

Everything else (when she comes, where she stands, how she leaves) is the same for every character. Ian's longer idea, a cast that comes in to "update the card" whatever the widget, fits this: the roster is the cast, and a later change could pick from it per swoop.

## Testing

- `node dev/agents-test.js` (Playwright, the real hub against the preview and the Pi's server, port 8095): she comes and goes with a working chip and with arrival chips, leaves when the working chip turns into the arrival chip, never in fade mode or on a slow screen or with agents off or an unknown `who` (and then loads nothing), at most two on screen and one per tile, only transform and opacity animate, a failed picture means no swoop and no broken picture, a panel and a resize end her at once, a tile at the right edge has her come from the left, three layouts, and the About rows in English and Spanish.
- `node dev/agents-shots.js --out <folder> [--clip]` takes before and after pairs (`?agent=off` and on, the same signal at the same moment, every animation paused at the same point, and checks how many pixels differ outside her box), a picture of her at 1080p, and a clip of one swoop.

## Not verified

- Nothing here has run on the real TV yet. A desktop browser proves the logic and that only transform and opacity move, not how smooth the glide and the idle look on the TV's Chromium, nor how the pixelated drawing looks there.
- `image-rendering: pixelated` needs Chromium 41 or later; an older browser draws the pictures smoothed (still the right size).
- The art: the four small frames on the source sheet are near copies (only the last holds the bread), so there is no skate cycle; the motion is made from transform on one picture. The source is AI-drawn "pixel" art, so after bringing it down to its own pixels a few edges are uneven.
