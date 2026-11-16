# Ian and Ember, the clay wanderers

Ian and his goldendoodle Ember are stop-motion clay puppets. They have no tile. Now and then, while nobody is using the remote, they wander onto the home screen in front of the tiles, do a short scene and leave. Between visits the screen is exactly as before.

## What they do

| Scene | When | What happens |
| --- | --- | --- |
| `stroll` | day | Ian walks across the bottom of the screen, Ember trots behind; midway he stops and waves. |
| `fetch` | day | Ian throws a ball, Ember runs, catches it in a leap, trots back with it; a high five, and off they go. |
| `sock-heist` | day | Ember sniffs out a sock and bolts with it; Ian runs after her, skids, facepalms. |
| `zoomies` | day | Ember alone, flat out across the floor, a skid and a play bow, and back. |
| `perch` | day | Ian appears in a puff on the top edge of a tile (not the top row) and sits, lies on his elbows, or hangs and climbs up; then puffs away. |
| `morning` | 6 to 10 AM | Ian with his coffee and a big yawn; Ember scratches. |
| `evening` | 7 to 10 PM | The two sit on the floor watching, then Ian eats popcorn and Ember begs. |
| `night` | 10 PM to 6 AM | Ember curls up asleep in a bottom corner, Z's rising; sometimes Ian naps beside her. The only scene at night, and less often. |
| `weather` | day, if the Weather tile has a forecast | Ian dressed for it: umbrella (rain; Ember is soggy), sunglasses (sunny and warm), hood up (cold or snow), wilting (hot), leaning into the wind (windy). |
| `cheer` | after a to-do item is ticked off | Ian ticks his clipboard and jumps for joy, stars pop. |
| `shrug` | after the Pi connection is lost | Ian shrugs, Ember tilts her head. |

Most scenes last 10 to 25 seconds; the night nap about 45. A reaction (`cheer`, `shrug`) plays at the next visit. Otherwise the time of day decides, then chance, never the same scene twice in a row.

Any key press or click sends them away in the same instant, before the hub acts on the key. So does a panel, a dashboard or the layout bar opening (a panel also when the Pi opens it), the page being hidden, or the layout changing (picked in the layout bar, sent by the Pi, or a resize); no scene starts while any of those is open. They measure the tiles each time a scene starts, so they work with any layout.

## Settings

In `app/config.js`:

```js
clay: { on: true, idleAfter: 20, every: [90, 240], nightEvery: [300, 600] },
```

- `idleAfter`: seconds without a key press (and with no panel open) before a visit. The first visit comes that long, plus a few seconds, after the last key.
- `every`: the pause between visits, a random number of seconds in that range. A visit cut short by a key press doesn't count: the next quiet spell gets a fresh one.
- `nightEvery`: the same from 10 PM to 6 AM.
- `clay: false` or `on: false` turns them off. `?clay=off` at the end of the hub's address does the same for one visit (for tests). Off, nothing of theirs loads.

## How it stays light on the TV

- Nothing loads at start but `clay.js`. At the first visit it loads `clay.css` and `clay/sprites.js` (the list of sprites), then the frames that scene needs (a few KB each). A scene starts only once all its frames are in; if one is missing or they take more than 8 seconds, the scene is skipped quietly and not tried again until the hub reloads.
- One timer, about 7 ticks a second. On a tick a character only changes which of its stacked pictures shows (opacity 0 or 1) and where it stands (`transform`). Props may also fade in steps. No filters, no shadows that blur, no CSS animations, no layout reads while a scene runs.
- One click-through layer above the tiles and below the panel, the dashboard and toasts. It is removed when the scene ends.
- At most two characters (or one picture of the two) and three props on screen.
- Every entry point is wrapped: if anything clay-related fails, the hub carries on as if it weren't there.

The sprites are in `app/clay/sprites/`, made by `art/clay/tools/` (see `art/clay/README.md`). They are drawn at the size they are shown: Ian standing is 160 px tall on the 1080p screen.

## Adding a scene

A scene is a function in `app/clay.js` that adds actors and gives each a script. The engine plays every actor's script at once, one step after another, a tick at a time.

```js
// Ember trots in, barks twice, trots out.
SCENES.bark = function (S) {
  var ember = S.actor('ember', 'char', { shadow: 76 });
  go(ember.at(S.start, S.floor).face(S.dir), EMBER_TROT, S.across(0.4))
    .cycle(['ember/stand-bark', 'ember/stand-2'], 12, 3);
  go(ember, EMBER_TROT, S.end).hide();
};
```

- `S` is the stage, measured as the scene starts: `S.W`, `S.H`, `S.floor` (the y of feet on the floor), `S.ledges` (`{ left, right, y, width }` for each tile top not in the top row), `S.dir` (`'right'` or `'left'`, the way to travel), `S.sgn` (1 or -1), `S.back`, `S.start` and `S.end` (off-screen x on each side), `S.across(f)` (x a fraction of the way across, in the direction of travel), `S.rand`, `S.pick`, `S.chance` (seeded in tests).
- `S.actor(name, kind, opts)`: `kind` is `'char'`, `'duo'` (a picture of the two, counts as both) or `'prop'`. `opts.shadow` is the width of a contact shadow; `opts.scale` a fixed size for a prop; `opts.mirror` draws a front-facing picture mirrored.
- x is where the sprite's centre of weight (`cx`) goes; y is where its bottom goes (the feet when standing). Sprites have no baseline, so a pose like `ian/sit-edge` on a ledge needs its own offset (see `PERCH`).
- Steps: `at(x, y)`, `face(dir)` (a `right` sprite is mirrored to face left), `pose(key, ticks, dy)`, `cycle(keys, ticks, every, { dy, dx })`, `walk(keys, toX, step, every, { dy, keepFace })`, `arc(keys, x, y, height, ticks)`, `move(dx, dy, ticks, { key, fade })`, `wait(ticks)`, `hide()`, `fade(opacity)`, `ground(y)` (where the shadow sits), `signal(name)` and `after(name)` (wait for another actor). The helpers `go(actor, GAIT, toX)` and `shuffle(actor, key, toX)` walk with a gait.
- Return `false` when the scene doesn't fit (`perch` with no ledge).
- Add it to `choose()` with a weight, and to `PLAYS` in `dev/clay-test.js`, which plays every scene and checks the rules above.

## Testing and filming

- `node dev/clay-test.js` checks the rules: nothing loads before the first visit, nothing plays before idle, every scene plays to the end within the limits and changes only transform and opacity, a key press clears the screen before the hub handles it, panels and layout changes end scenes, `clay: false` and `?clay=off` load nothing, a missing sprite skips a scene, night hours pick night scenes, a ticked to-do item queues a cheer.
- `node dev/clay-shots.js [folder]` films every scene frame by frame (`HUB_TEST.clay.setSpeed(0)` and `step()`): stills of each, one MP4 each at the real speed, a highlights reel, a key press making them vanish, and `all-scenes.jpg`. Needs ffmpeg for the videos.
- In a laptop browser: `HUB_TEST.clay.play('fetch')`, `.stop()`, `.state()`, `.scenes()`, `.setHour(23)`, `.setSpeed(ms)`.
