# Characters who work on the tiles

When a tile is busy (a working state: "Working on to-dos", "Checking calendar") or has news (an arrival: "Incoming to-do", "Updating calendar"), a pixel-art character can come and work on it instead of the chip. Today there is one: Lift, the Edgedancer from Brandon Sanderson's Stormlight books, who skates on Stormlight, makes things grow, and goes nowhere without her spren Wyndle, the vine. The character is not tied to a widget or a kind: any tile that would get a chip can get her.

## No chip while she is there

- When she comes, the tile gets **no chip**: only her and the tile's border light, exactly as before (the light that laps the border on arrival, the accent edge after it, the focus highlight stepping aside while the light laps). The chip's words ("Working on to-dos") are not shown while she works; that is intended.
- The chip is the **fallback**, and shows exactly as before, whenever she cannot come: a slow screen (she follows the chips' own rule, `canLight`: full speed, or stepped down from push but still 60+ fps without stutter; below that neither she nor the chips show), fade mode (a TV that stepped itself down can be put back on push for the session with the say text `hub:motion push`), less motion asked for, the motion extras off, her pictures not loaded yet or failed, two characters already out (the third tile gets its chip), the home screen not quiet, or agents off.
- It is decided once, at the moment the chip would be made (motion.js asks `HUB_AGENTS.chip('in', tile, ok, mode)`; `HUB_AGENTS.willShow(tile, ok)` is the same question without starting her). A chip never gets her beside it later, and she never gets a chip beside her, except one way: if she is taken away at once while the tile is still working (a resize, a layout change, the hub slowing down), the working chip comes back so the tile never says nothing.
- Her pictures load 6 seconds after the hub starts (or at the first chip, if sooner), so a chip in the first seconds after a load is a chip.

## What she does

Every step moves only `transform` and `opacity`: several pose pictures stacked in one box, one shown at a time (opacity), and the box moved, raised, leant and mirrored (transform).

1. **Enter:** she skates in along the tile's bottom edge on a trail of Stormlight, from the side with screen room (a tile on the right half of the screen: from its left; else from its right), mirrored to face her way.
2. **Travel:** a short carving skate to the work spot (across and up are eased differently, so the path curves, and she leans into it), ending in a braking skid with a spray of Stormlight sparks.
3. **Work:** she crouches with a hand on the card. one steady, deep blue stream of Stormlight runs down her arm into it (lighter surges sliding along it, two thin light strands twisting around it) and rings out from her hand, Wyndle grows a little vine curl toward it and sways, and she bobs a little. A cheap CSS loop (1.5 s cycles, about 3 s in all); no timer runs while she works. It lasts as long as the working state (up to 15 minutes); after 20 seconds it calms (no bob, the light slower).
4. **Reveal:** when the news lands (or, for an arrival alone, after a short work), she springs up with her arms raised and a burst of sparks goes off at the spot; the border light laps the tile at the same time.
5. **Exit:** she turns, waves (with her bread), and skates out the way she came. A working state that ends without news skips the reveal.

An arrival alone is one fixed sequence of about 5.5 to 6 seconds (enter 0.7 s, travel and skid about 1 s, work 1.5 s, reveal 0.9 s, wave 0.65 s, out 0.65 s); the border light's laps (2.4 s) run as before. News that comes while she is still on her way in: she works a moment at the spot, then the reveal.

- **The work spot** is where the new thing shows, when the widget says: the first visible element with `data-agent-spot` in the tile. She crouches on its top edge, at its end on the side she came from, with her hand on it, so she sits in the room at the end of the line above (beside the to-do count, beside the calendar's date) and not over the row's words; a working state can last minutes, so she should not hide what the tile says. Before she goes there, the tile's words are measured (each line of text, once): if her crouch there would cover any (a longer line above, as in Spanish, "por hacer ahora"), she tries, in order, pressed to the tile's edge, then lower with her hand on the middle or the bottom of the row (over the row's own end), and takes the first place that covers no words, or the one that covers fewest (the row's own words counting four times, so on a crowded narrow tile she would rather touch the end of the line above than the new item). On her way there (the travel, a second or so) she may pass over words. Without one, the middle of the tile, lower half. It is measured once, as she starts, and kept inside the tile; her box is kept inside the tile (it may rise a quarter of its height above the top) and on screen. Today: the to-do tile marks its first optional row (new to-dos go to the top of their level, so that is where one shows; the first row when there are only must-dos), the calendar tile its first event row, or its "Next" block when there are none today. Other widgets use the middle.
- **Small tiles:** a tile narrower than 2.3 times her box or lower than 1.2 times it (a 2x1, say) gets a short version: she skates in to its bottom corner, works there, and leaves (sparks at the end of an arrival, no leap). Still no chip.
- **At once:** anything that takes a chip away at once (a panel opening, the dashboard, a layout change, a resize, the hub slowing down) takes her away at once too, with no glide.
- At most one character on a tile and two on screen.
- She is a 140 x 126 px box at 1080p (about 112 px of her skating, 70 px crouching).

## Settings

In `app/config.js`:

```js
agents: { on: true, who: 'lift' },
```

- `who`: the character, a name in the roster (below). A name that is not there turns them off, with no error (the About panel says `off (no character called ...)`), and the chips show.
- `agents: false` or `on: false` turns them off (the chips show, as before); so does `?agent=off` on the hub's address for one visit. Off, nothing of theirs loads and no element is added.
- `?agent=lift` picks that character for one visit, even with the config off (for tests).

## The About panel

Press Left on a left-most tile. The **Characters** group, in the hub's language, shows from the first working or arrival state since the page loaded (before it there is nothing to say):

- **Now:** `Lift, on To-do` (the tile's title), `none`, or `loading pictures`.
- **Seen:** how many times she has come since the page loaded.
- **Drawing:** `on`; `off (fade mode)`, `off (slow screen)`, `off (config)`, `off (?agent=off)`, `off (no character called x)`, `off (the activity chips are off)`, or `off (pictures did not load; tried again in 10 min)`. In every case but `on`, the tiles get their chips.

## How it stays light on the TV

- Six pictures, about 52 KB in all, in `app/agents/lift/`: `lift.webp` (skating, 132 x 112) and `wyndle.webp` (Wyndle's head, so he can sway as she skates), `skid.webp`, `crouch.webp`, `leap.webp`, `wave.webp`. They load together, 6 seconds after the hub starts or at the first chip if that comes sooner, well under the TV's six requests at a time. Each is asked for up to three times (again 1 s and 2.5 s after a failure), as the clay wanderers' frames are. If any one still fails, or loads without decoding, she is unavailable (never half a character): the chips show, and loading is tried again 10 minutes later.
- Only `transform` and `opacity` move: CSS transitions for the skating, the carve and the jump, CSS animations for the trail, the spray, the work loop and the burst. Poses switch by opacity. No filters, no shadows, no layout changes.
- Her own timers are a handful of one-shot `setTimeout`s per sequence (one per phase); nothing polls and nothing runs while she works.
- One click-through layer (`.ag-layer`, z-index 9, like the wanderers') above the tiles and under the panels, the dashboard and toasts. It is added with the first character and removed with the last.
- The pictures are drawn at 1:1 at 1080p (`image-rendering: pixelated`, sizes in rem), so each art pixel is a screen pixel.
- Every entry point is wrapped; if anything here fails, the hub carries on exactly as without it (the chips). It writes nothing to the console.

## Adding or swapping a character

1. Make the pictures: transparent WebP drawn at the size they are shown at 1080p, in `app/agents/<name>/`, every pose at the same art-pixel size, all facing the same way.
2. Add an entry to `ROSTER` at the top of `app/agents.js`: `name`, `dir`, `w` and `h` (the box every pose is drawn in, feet on its bottom), `faces` (`'right'` or `'left'`), `poses` (for each of `skate`, `skid`, `crouch`, `leap`, `wave`: its parts, each a `file`, `left`, `top`, `w`, `h`; `sway: true` sways that part about its bottom middle; on the crouch, an optional `shape`, boxes `[left, top, w, h]` where that picture is not see-through, lets her keep clear of words more closely than its whole box), `trail` (where the Stormlight trail starts, behind the feet), `spray` (the skid's front foot), `hand` (the crouch's hand on the card: it goes on the work spot) and `vine` (where the vine curl grows from). Only `skate` is required: a pose that is missing is drawn with the skate pose, so a one-picture character still does the whole sequence by transform.
3. Set `agents.who` in `app/config.js`.

### How Lift's poses were made

- `art/agents/gen.py` asks Gemini (`gemini-2.5-flash-image`, REST `generateContent`) for pose sheets with the old art as reference, so she stays the same character. It reads the key from `GEMINI_VIDEO_GEN_KEY` only and never prints it. Each sheet puts the old skating pose on the left (for scale) and the new pose on the right, on flat grey. The raw sheets stay in the project files (`home-hub-agents/lift-v2/raw/`), never in this repository.
- `python3 art/agents/extract.py --poses <raw-folder> app/agents/lift <preview-folder>` cuts each pose out (the grey, the ground shadow and the pale Stormlight haze go, with no grey halo), scales each sheet so its skating figure would be exactly as tall as `lift.webp` (so every pose has the same art-pixel size), brings it down to those pixels and writes the WebP, plus 4x previews of every pose on a dark and a light backdrop to check the edges. `python3 art/agents/extract.py <sheet>` (no `--poses`) is still how `lift.webp` and `wyndle.webp` were cut from the first sheet.
- **Art spend:** the first Lift art cost about $0.48. The poses cost 5 more images (about $0.20): a four-pose sheet that came back as four skating poses (not used), a leap-and-wave sheet (used), a crouch (used), and a skid twice (the first leaned forward; the second is used). About $0.68 of the $1 allowed for her.

## Testing

- `node dev/agents-test.js` (Playwright, the real hub against the preview and the Pi's server, port 8095), 11 checks: a working state brings her with no chip, through enter, travel, skid and work, and out on done with nothing left; an arrival alone plays enter to exit in 4 to 8.5 s with the border light and no chip, and the calendar's spot marker is used; a working state turning into news plays the reveal and never shows a chip, even when the news comes while she is still coming in; the chip is the fallback in fade mode, on a slow screen, with agents off or an unknown `who` (which load nothing), and before her pictures are in; at most two on screen and one per tile, the third tile with its chip and never a chip beside her; only transform and opacity animate, and in a work loop nothing in her changes for 3 s and no loop is faster than 1.5 s; one pose picture that fails three times means no character and the chip; a panel ends her at once and she comes back, a resize ends her and gives the chip back; four layouts (direction, facing, inside the tile, a 2x1 tile's short sequence); the About rows in English and Spanish; the spot marker kept inside the tile, the to-do list's own marker (her hand on that row, and her drawn crouch over none of the tile's words, measured in the page), and a language change while she works.
- `node dev/agents-shots.js --out <folder> [--clip]` takes before and after pairs (`?agent=off`, the chip, against her at work, the same signal at the same moment, every animation paused at the same point, and counts the pixels that differ outside her box and the chip), a picture of her at 1080p, a labelled strip of one real capture per phase on the to-do tile, and with `--clip` two clips: `lift-sequence.mp4` (working, then a new to-do) and `lift-calendar.mp4` (an arrival alone).

## Not verified

- Nothing here has run on the real TV yet. A desktop browser proves the logic and that only transform and opacity move, not how smooth the skating, the carve and the work loop look on the TV's Chromium, nor how the pixelated drawing looks there.
- `image-rendering: pixelated` needs Chromium 41 or later; an older browser draws the pictures smoothed (still the right size).
- The art is AI-drawn "pixel" art brought down to its own pixels, so some edges are uneven. Between poses her hair is a little shorter in the skid, leap and wave than in the skating pose, the skid has her arms up (more a cheer than a brake), and the skid's spray is thin; the skating pose has no second frame (the alternate stride Gemini drew lost Wyndle and the bread), so the skating is still one picture moved by transform.
