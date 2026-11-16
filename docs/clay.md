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
clay: { on: true, idleAfter: 20, every: [90, 150], nightEvery: [300, 600] },
```

- `idleAfter`: seconds without a key press (and with no panel open) before a visit. The first visit comes that long, plus a few seconds, after the last key.
- `every`: the pause between visits, a random number of seconds in that range. A visit cut short by a key press doesn't count: the next quiet spell gets a fresh one. After a visit skipped as too slow the next comes 20 seconds later (or after `every[0]`, if that is sooner), while its files are still coming in; after three slow visits in a row it waits `every[0]` each time until one plays. The remote still has to be left alone for `idleAfter` first.
- `nightEvery`: the same from 10 PM to 6 AM.
- `clay: false` or `on: false` turns them off. `?clay=off` at the end of the hub's address does the same for one visit (for tests). Off, nothing of theirs loads.

## How it stays light on the TV

- Nothing loads at start but `clay.js`. At the first visit it adds its few styles (from `clay.js` itself, no request) and loads `clay/sprites.js` (the list of sprites), then the frames that scene needs (a few KB each). A scene starts only once all its frames are in.
- Loading may be slow on the TV. The sprite list and a scene's frames each get 30 seconds; past that the visit is skipped, but nothing is cancelled: the files keep loading into the browser's cache, and the next visit (20 seconds later, see `every`) tries the same scene again. At most 200 pictures that never answered are kept waiting; past that the oldest is let go. A sprite list that failed is tried again at the next visit. A frame that really fails (an error, or a picture that loads but does not decode) leaves that scene out for 10 minutes.
- Once the sprite list is in, a few seconds after each visit the next visit's scene is picked and its frames start loading, so the visit starts from the cache. Only one scene ahead, and it never makes a visit come sooner.
- One timer, about 7 ticks a second. On a tick a character only changes which of its stacked pictures shows (opacity 0 or 1) and where it stands (`transform`). Props may also fade in steps. No filters, no shadows that blur, no CSS animations, no layout reads while a scene runs.
- One click-through layer above the tiles and below the panel, the dashboard and toasts. It is removed when the scene ends.
- At most two characters (or one picture of the two) and three props on screen.
- Every entry point is wrapped: if anything clay-related fails, the hub carries on as if it weren't there.

The sprites are in `app/clay/sprites/`, made by `art/clay/tools/` (see `art/clay/README.md`). They are drawn at the size they are shown: Ian standing is 160 px tall on the 1080p screen.

## If they don't show up

Press Left on a left-most tile: the **About panel** slides in from the left, and its **Wanderers** group says what they are doing and how it has gone since the page loaded. It changes by itself, once a second, while it is open. The panel doesn't hold them back: a visit loads and plays with it open, behind it, so you can watch the countdown turn into loading and then into `on screen now`. Right or Back closes it. `HUB_CLAY.status()` gives the same as `{ now, visits, last, loading, problem, text }` (`text` is all of it on one line).

Times read `42 s` up to 99 seconds, then `1 min 42 s`.

**Now**: what they are doing, or what comes next.

- `due back in 1 min 42 s`: waiting for the next visit; the remote has to stay untouched until then (a key press starts the wait for quiet again).
- `loading stroll, 12 of 18 frames, 7 s`: a visit is loading its frames: how many are in, and for how long. `loading stroll (sprite list), 3 s`: it is still waiting for `clay/sprites.js`.
- `on screen now: stroll`: a scene is playing.
- `waiting: hub busy (a page is open)` (or `the layout bar is open`, `you are typing`, `the hub is moving`): nothing comes while that is open; the wait for quiet starts again after it.
- `waiting: page reports hidden`: the browser says the page is hidden (`document.hidden`), so no visit starts. If this shows while the hub is plainly on screen, the TV's browser reports it wrongly.
- `off (config)`: `clay: false` or `on: false` in `app/config.js`. `off (?clay=off)`: the address says so.
- `not started`: hub.js never started them (an older or broken hub.js).

**Visits**: `3 played · 1 slow · 0 failed` since the page loaded. Slow visits were skipped because loading took over 30 seconds; failed ones because something did not load at all.

**Last visit**: the last visit, how it ended and how long ago: `stroll finished, 4 min ago`. It ends `finished`, `interrupted` (a key, a click, a panel or a layout change), `stopped` (from a test), `did not fit` (`perch` with no ledge), `too slow`, `failed` or `hit an error`. Not shown before the first visit.

**Loading**: how long the files took, shown once something has loaded.

- `sprite list 812 ms`: how long `clay/sprites.js` took. `sprite list onerror after 40 ms`: it failed. `sprite list not in after 30.0 s`: no onload or onerror yet. `(over 30 s)`: it came, but after the limit.
- `stroll 18/18 frames in 2.3 s`: the last scene's frames, how many came of how many, and how long. `12/18 frames after 31.2 s`: still coming after the limit (the count goes on as they arrive). `5/18 frames so far, 4.1 s`: still loading. `3/18 frames, then one failed`: a frame failed.

**Last problem**: the last thing that went wrong, and how long ago. It stays after later good visits, and is not shown when nothing has gone wrong since the page loaded. One of:

- `sprite list did not load (onerror)`: `clay/sprites.js` answered with an error.
- `sprite list did not load (no onload or onerror in 30 s)`: no answer in time (`, then came in 41234 ms` when it came later; the next visit uses it).
- `sprite list loaded but is not valid (onload, ...)`: the file loaded but `CLAY_SPRITES` is missing or has no sprites or sequences.
- `the styles could not be added: ...`: putting the `<style>` in threw.
- `scene stroll skipped: frame ember/trot-1 failed (onerror)`: that picture did not load; the scene is left out for 10 minutes.
- `scene stroll skipped: frame ember/trot-1 failed (loaded, 0 px wide: did not decode)`: the file came but the browser could not decode it (WebP on an old browser, a damaged file); left out for 10 minutes.
- `scene stroll skipped: frame X is not in the sprite list`: a scene asks for a picture `sprites.js` doesn't have.
- `scene stroll skipped: its frames took over 30 s (12 of 18 in)`: slow; the same scene comes at the next visit.
- `scene stroll could not be built: ...`, `scene stroll could not be shown: ...`, `error in scene stroll: ...`, `error in the scheduler: ...`, `error: ...`: an exception, with its message.

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
- Add it to `bagFor()` with a weight, and to `PLAYS` in `dev/clay-test.js`, which plays every scene and checks the rules above.

## Testing and filming

- `node dev/clay-test.js` checks the rules: nothing loads before the first visit, nothing plays before idle, every scene plays to the end within the limits and changes only transform and opacity, a key press clears the screen before the hub handles it, panels and layout changes end scenes, `clay: false` and `?clay=off` load nothing, a missing sprite skips a scene, night hours pick night scenes, a ticked to-do item queues a cheer, the status says what happened (off, waiting, playing, busy, hidden, a missing or slow or invalid sprite list, a missing or undecodable frame), no stylesheet is fetched, a failed or slow load is tried again at the next visit, a slow scene is not marked broken and plays at a later visit, the next scene's frames load ahead, the default pause is 90 to 150 s, after a slow visit the next comes 20 s later (three times, then `every[0]`), and at most 200 unanswered pictures are kept. It also checks the About panel: Left opens it and Up does not, Right, Back and a click close it, it never opens over a panel or the layout bar, its rows come and go and refresh by themselves, a long problem wraps inside it at 1920 x 1080 and 1280 x 720, and a visit loads and plays with it open.
- `node dev/clay-shots.js [folder]` films every scene frame by frame (`HUB_TEST.clay.setSpeed(0)` and `step()`): stills of each, one MP4 each at the real speed, a highlights reel, a key press making them vanish, and `all-scenes.jpg`. Needs ffmpeg for the videos.
- In a laptop browser: `HUB_TEST.clay.play('fetch')`, `.stop()`, `.state()`, `.scenes()`, `.setHour(23)`, `.setSpeed(ms)`, `.setLoadMs(ms)`; `HUB_CLAY.status()`.
