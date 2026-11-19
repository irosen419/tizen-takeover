# Clay characters

Ian and Ember as stop-motion clay puppets, for the hub to animate. Nothing here runs on the TV; the finished sprites are in `app/clay/`, and `app/clay.js` brings them on screen (see `docs/clay.md`).

![Every sprite: Ian, Ember, the two together, and props](gallery.jpg)

## What's where

`models/` and `raw/` are not in git. They live in the picture bucket (see `docs/asset-storage.md`) under `clay/source/v1/`, listed with their checksums in `source.sha256`. Get them with `python3 art/clay/tools/fetch_source.py` before using the tools.

- `models/` holds the two turnaround sheets and three test shots. The sheets are the reference for every pose, so a new pose still looks like the same puppet.
- `raw/` holds the pose sheets as Gemini drew them: one row of poses on a green or blue backdrop.
- `tools/` turns those into sprites (below).
- `app/clay/sprites/` holds the sprites: transparent WebP, in `ian/`, `ember/`, `duo/` (both in one picture) and `props/`.
- `app/clay/sprites.json` lists them. `unit` is Ian's standing height in sprite pixels (160, his size on the 1080p hub: the TV shows Ian and Ember at their natural size, never scaled); every sprite is drawn to that one scale, so Ember standing is about 93 px tall. Each sprite has its `file`, `w` and `h`, `cx` (the horizontal middle of its weight, steadier than the middle of the box when frames change), `faces` (`right`, `front` or `back`; mirror a `right` sprite to go left) and `about`. `sequences` names frames that play in order, such as `ian.run` and `ember.jump`. The gaits (`ian.walk`, `ian.run`, `ember.trot`, `ember.run`, `ember.ball-trot`, `ember.sock-run`) are full cycles that loop. `strides` gives, for each gait, the px travelled in one full cycle at this scale, so a planted foot does not slide: move by `stride / frames` per frame. There is no baseline: the bottom of each picture is the lowest pixel of the pose, so `lifts` gives the px above the floor line for gait frames with nothing on the ground (a gallop's flight), and a scene sets its own offsets for other frames like a leap.
- `app/clay/sprites.js` is the same list for the TV, cut down to `file`, `w`, `h`, `cx`, `faces`, the sequences, `strides` and `lifts`, as `var CLAY_SPRITES = {...}`. The hub loads it as a script and never fetches the JSON.

## Adding poses

It needs Python 3 with `pillow`, `numpy` and `scipy`, and a Gemini key in `GEMINI_API_KEY`.

1. Describe the poses in `tools/sheets.py`: add a `sheet(...)` with five or six poses. The first must be an upright standing pose, because its height sets the scale for the whole sheet. Use a green backdrop for Ian (his jeans are blue) and a blue one for Ember and anything with a tennis ball in it (the ball is nearly green).
2. `python3 art/clay/tools/gen.py my-sheet` asks Gemini for the sheet and saves `raw/my-sheet.jpg`. Each run costs one image. A sheet you keep goes to the bucket at `clay/source/v1/raw/` (a Claude thread can upload it), and its line goes in `source.sha256` (`cd art/clay && sha256sum raw/my-sheet.jpg >> source.sha256`).
   A sheet can send more pictures after the model sheets with `refs=[(path, what it is)]`, such as `raw/ember-move.jpg`, so it keeps the look and size of earlier poses. Gemini copies a reference's poses unless the text says not to (`LOOK_ONLY` in `sheets.py`); the ball and sock cycles use that on purpose, redrawing the accepted trot and gallop sheets with a toy. `ask_rows=2` asks for two rows, for a cycle with more poses than fit in one; the standing pose still comes first. `edit='raw/<sheet>.jpg'` sends that one sheet alone with `note` as the whole prompt, to ask for a small change to it.
   When Gemini will not put a limb where a cycle needs it (it draws Ember's near hind leg trailing behind in nearly every trot pose, whatever the words say), `moves={pose: [dict(take=polygon, pivot=..., rotate=deg)]}` (or `shear=px`) has `cut.py` cut that leg out of the pose, swing it about the hip and lay it back, like re-posing a clay leg between frames. Coordinates are in the cut-out's pixels (`cut/<sheet>/<pose>.png`); see `TROT_MOVES` in `sheets.py`.
3. Look at it. Gemini strays: it adds or drops a pose, stacks two, draws a logo, forgets the glasses. Say what it actually drew with `found=[...]` (a name per pose, `None` to throw one away), `rows=`, `join=` and `scales=`; `sheets.py` has examples of each. Redo anything that is wrong in a new sheet.
4. `python3 art/clay/tools/cut.py my-sheet` removes the backdrop and cuts one picture per pose into `cut/` (not kept in git). It prints how many poses it found.
5. `python3 art/clay/tools/export.py app/clay` rebuilds every sprite, `sprites.json` and `sprites.js`. It needs every sheet cut first: `cut.py` takes several names (all of them: `python3 art/clay/tools/cut.py $(python3 -c "import sys; sys.path.insert(0, 'art/clay/tools'); import sheets; print(' '.join(sheets.SHEETS))")`, about a minute; cutting and exporting need no Gemini key). A second argument sets the size: `export.py app/clay 400` makes Ian 400 px tall, the size the sprites were first made at. The same cut-outs always give the same sprites, byte for byte.
6. `python3 art/clay/tools/review.py out.jpg app/clay/sprites/ian` lays one folder of sprites out side by side to check heads are the same size.
7. For a gait, `python3 art/clay/tools/flipbook.py /tmp/walk ian.walk --before ian/walk-1,ian/walk-2` writes `/tmp/walk.jpg` (the cycle on one floor line) and `/tmp/walk.mp4` (the character crossing a dark strip, one stride per cycle, with the frames' lifts; `--before` adds a lane above to compare). Check that it loops without a jump, that the legs alternate and that a planted foot stays on its tick mark, then set `STRIDES` and `LIFTS` in `sheets.py`. Cycle sheets ask for one shared ground line per row, and `cut.py` keeps each pose's box on the sheet in `cut/<sheet>/_meta.json`, so a flight pose's lift is how far its bottom sits above the poses with a foot down in the same row.

Only the puppets and the photo crops they were first made from ever went to Gemini. The photos are not in this repository.
