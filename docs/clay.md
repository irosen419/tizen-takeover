# Ian and Ember, the clay wanderers

Ian and his goldendoodle Ember are stop-motion clay puppets. They have no tile. Now and then, while nobody is using the remote, they wander onto the home screen in front of the tiles, do a short scene and leave. Between visits the screen is exactly as before.

## What they do

| Scene | When | What happens | Length |
| --- | --- | --- | --- |
| `stroll` | day | Ian walks in with Ember behind him and waves; he gets his phone out, Ember gets bored and rolls over, he laughs and gives her a belly rub; they walk on and out the far side. | 34 s |
| `fetch` | day | Ian fakes a throw and Ember falls for it (a skid, a puzzled head tilt); he laughs. A real throw: she runs, catches the ball at the top of a leap, trots it back but lies down guarding it until he calls her; a high five, a hug, and back the way they came. | 36 to 38 s |
| `fetch-bolt` | day | Ian throws, Ember catches the ball and bolts the other way, past him and off the screen. He peers after her, shrugs. She comes back from the far side, tiptoes up behind him, drops the ball at his heels and barks; he yelps. He laughs and points; she snatches the ball up and is off again, he walks after. | 36 to 44 s |
| `fetch-snub` | day | Ian throws, Ember catches the ball and trots most of the way back, then drops it, looks away and slowly walks off. Ian throws up his hands ("What??"), goes and picks up the ball himself and sits on the floor with it, sulking; she looks back, and he poofs away. | 33 to 36 s |
| `sock-heist` | day | Ember sniffs out a sock; Ian creeps up on her ("shh"), she bolts; he runs after her, skids, facepalms. She comes back to tease him with it, a tug of war, she wins and runs off; he laughs and runs after her. | 40 to 41 s |
| `zoomies` | day | Ember alone, flat out across the floor, a skid, play bows and barks; back the other way, a spin, a pounce, a roll on her back, a shake, and off. | 19 to 20 s |
| `perch` | day | Ian appears in a puff on the top edge of a tile (not the top row), sitting on the edge, lying on his elbows, or hanging and climbing up. He makes himself at home: stands and waves, gets his laptop out, sits or lies about; then puffs away. | 20 to 25 s |
| `morning` | 6 to 10 AM | Ian with his coffee and a big stretch; Ember scratches. He puts her breakfast down and she eats and licks her chops; he checks his phone, sees the time and runs off late, Ember after him. | 31 to 32 s |
| `evening` | 7 to 10 PM | Ian dances to music, Ember howls along; the two sit on the floor watching; then popcorn, Ember begs and waits for a piece to fall; a yawn, and home. | 31 to 33 s |
| `night` | 10 PM to 6 AM | Ember curls up asleep in a bottom corner, Z's rising; sometimes Ian naps beside her. The only scene at night, and less often. | 43 to 53 s |
| `weather` | day, if the Weather tile has a forecast | Ian walks in and, in a puff, is dressed for it: umbrella (rain; Ember is soggy, shakes, stares up at the rain), sunglasses (sunny and warm; Ember sunbathes on her back), hood up (cold or snow; Ember shakes the snow off and barks), wilting (hot; Ember flops down), leaning into the wind (windy; Ember barks at it). Another puff, a wave, and on they go. | 32 to 33 s |
| `cheer` | after a to-do item is ticked off | Ian ticks his clipboard, jumps for joy, stars pop. | 17 to 19 s |
| `shrug` | after the Pi connection is lost | Ian shrugs, Ember tilts her head. | 15 to 18 s |

The lengths are at the real speed and vary a little with where they stop and which way they go (`dev/clay-test.js` checks every scene stays in its range). A reaction (`cheer`, `shrug`) plays at the next visit. Otherwise the time of day decides, then chance, never the same scene twice in a row.

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
- A scene uses at most 40 pictures (`MAX_FRAMES`), loaded before it starts; with today's walk cycles `fetch` uses the most.
- The scripts run on a fixed clock of about 7 ticks a second, so a scene plays the same everywhere. How it is drawn is separate; see "Smooth and stepped drawing" below. While a scene plays only `transform` and `opacity` change: which of a character's stacked pictures shows (opacity 0 or 1), where it stands and how it leans or breathes (transform), and a prop's fade. No filters, no shadows that blur, no CSS animations, no layout reads while a scene runs.
- One click-through layer above the tiles and below the panel, the dashboard and toasts. It is removed when the scene ends.
- At most two characters (or one picture of the two) and three props on screen.
- Every entry point is wrapped: if anything clay-related fails, the hub carries on as if it weren't there.

The sprites are in `app/clay/sprites/`, made by `art/clay/tools/` (see `art/clay/README.md`). They are drawn at the size they are shown: Ian standing is 160 px tall on the 1080p screen.

## Smooth and stepped drawing

The scripts move on whole ticks (140 ms). Drawing them only on the ticks made them jump 18 px at a walk and 50 px at a run, seven times a second, which looked choppy. So between ticks a `requestAnimationFrame` loop draws each actor part of the way from where it was at the last tick to where it is going, at the screen's own frame rate ("smooth"). At the end of each tick it is exactly where the script put it.

- Things that must not glide don't: an `at()` (a jump to another place), a first appearance and a show after a hide are drawn where they are at once. A change of picture, and a turn to face the other way (`scaleX(-1)`), happen at the start of a tick, never part way or squashed through zero.
- A walk speeds up over its first three ticks and slows into its stop (`walk(..., { ease })`; `in` for a run into a skid or a leap; a walk from or to off screen doesn't ease at that end). It always ends exactly on its x.
- Walks, trots and runs are gaits: their pictures come from the sprite list's sequences (`ian.walk`, `ian.run`, `ember.trot`, `ember.run`, any number of pictures in loop order), and the picture is chosen by the distance walked, `floor(distance / stride * pictures)`, worked out for every drawn frame. That keeps the feet on the ground and quickens the steps with the speed. The stride (px for one round of the pictures) comes from `CLAY_SPRITES.strides` when the list has it, else from the gait in `clay.js`, set so two pictures keep the old cadence. Longer cycles drop in through the sprite list with no change to the engine. `ember.ball-trot` and `ember.sock-run` are used for Ember carrying the ball or the sock (without them, with an older sprite list, that one picture is slid along). Those two are optional: a scene that would load more than 40 pictures with them first drops its small touches (in `fetch`, the heart over the hug), and if that is not enough it is built without them. With today's art both fit with everything in (`fetch` 37 pictures, `sock-heist` 34); with 8-picture cycles for every gait, `fetch` would be built without its carrying trot.
- Two more optional maps in the sprite list tune a gait from the art side. `CLAY_SPRITES.lifts` (sprite key to px above the floor line) draws a picture in mid-air that much higher, the shadow staying on the ground; a gait with any lifted picture leaves out its hand-made bob (`dy` in `clay.js`), so the two don't add up. `CLAY_SPRITES.shares` (sequence name to one number a picture, each its share of the stride, scaled to add up to 1) spaces the pictures unevenly, to tune foot slip; without it, or when its length doesn't match the sequence, they are evenly spaced. When the list has `ian/stand-side`, Ian shows it for two ticks as he stops out of a walk before facing the front (`stroll`, `cheer`), the scene's length unchanged.
- `MOVE_WITH_POSE` in `clay.js` (off) moves a walk's position only when its picture changes, by that picture's share of the stride, as in classic stop-motion, instead of continuously.
- The bob of a walk or a held pose (`dy`, `dx`) eases between its values, a soft bounce; an `arc` follows its parabola on every drawn frame.
- A little life on the character's transform, never on its shadow: after standing still for three ticks it breathes (a slow scale of about 1 % about its feet, so feet stay planted; not while hanging by its hands), it leans up to 3 degrees into a walk or a run, and squashes a little on a landing or a skid.
- The loop's rate is measured a second at a time, after the first half second. Under 20 frames a second, the rest of the scene is drawn once a tick at the tick's position, without the in-betweens and the life ("stepped", as before), and so are the visits of the next 30 minutes; then smooth is tried again. A browser without `requestAnimationFrame` is always stepped. A timer checks the frames are still coming, so a browser that stops them can't freeze a scene. One frame never moves the clock more than two ticks, so a stall slows a scene down rather than jumping it.
- `BLEND_MS` in `clay.js` (0, off) is an experiment: a change of picture blends over that long, the new picture fading in on top of the old one, which stays fully drawn until it is dropped.

Headless desktop Chromium (`dev/clay-test.js`) proves the logic: the in-betweens, the snaps, the fallbacks, what changes. It can't prove how smooth it looks on the TV; the About panel's **Drawing** row says how the TV actually drew the last visit.

## If they don't show up

Press Left on a left-most tile: the **About panel** slides in from the left, and its **Wanderers** group says what they are doing and how it has gone since the page loaded. It changes by itself, once a second, while it is open. The panel doesn't hold them back: a visit loads and plays with it open, behind it, so you can watch the countdown turn into loading and then into `On screen now`. Right or Back closes it. Keys pressed while it is open, the one that closes it included, don't count as using the remote, so their wait isn't restarted (the Left that opens it does count). `HUB_CLAY.status()` gives the same as `{ now, visits, last, drawing, loading, problem, text }` (`text` is all of it on one line).

Times read `42 s` up to 99 seconds, then `1 min 42 s`.

**Now**: what they are doing, or what comes next.

- `Due back in 1 min 42 s`: waiting for the next visit; the remote has to stay untouched until then (a key press starts the wait for quiet again).
- `Loading stroll, 12 of 18 frames, 7 s`: a visit is loading its frames: how many are in, and for how long. `Loading stroll (sprite list), 3 s`: it is still waiting for `clay/sprites.js`.
- `On screen now: stroll`: a scene is playing.
- `Waiting: hub busy (a page is open)` (or `the layout bar is open`, `you are typing`, `the hub is moving`): nothing comes while that is open; the wait for quiet starts again after it.
- `Waiting: page reports hidden`: the browser says the page is hidden (`document.hidden`), so no visit starts. If this shows while the hub is plainly on screen, the TV's browser reports it wrongly.
- `Off (config)`: `clay: false` or `on: false` in `app/config.js`. `Off (?clay=off)`: the address says so.
- `Not started`: hub.js never started them (an older or broken hub.js).

**Visits**: `3 played · 1 slow · 0 failed` since the page loaded. Slow visits were skipped because loading took over 30 seconds; failed ones because something did not load at all.

**Last visit**: the last visit, how it ended and how long ago: `stroll finished, 4 min ago`. It ends `finished`, `interrupted` (a key, a click, a panel or a layout change), `stopped` (from a test), `did not fit` (`perch` with no ledge), `too slow`, `failed` or `hit an error`. Not shown before the first visit.

**Drawing**: how the last visit (or the one on screen) was drawn, shown once one has played.

- `Smooth, 58 frames a second`: drawn between ticks; the rate it managed, on average, after the first half second.
- `Smooth, measuring the frame rate`: on screen, not a full second yet. `Smooth (too short to measure)`: it ended before that.
- `Stepped: the screen managed 14 frames a second`: under 20 a second, so it went back to one drawing a tick.
- `Stepped: the screen managed 14 frames a second 5 min ago; smooth is tried again in 25 min`: a recent visit was too slow, so this one was stepped from the start.
- `Stepped: this browser has no requestAnimationFrame`.
- `Smooth, stepped by hand (a test)`, `Stepped: sped up by a test`, `Stepped: set by a test`: from the test hooks.

**Loading**: how long the files took, shown once something has loaded.

- `sprite list 812 ms`: how long `clay/sprites.js` took. `sprite list onerror after 40 ms`: it failed. `sprite list not in after 30.0 s`: no onload or onerror yet. `(over 30 s)`: it came, but after the limit.
- `stroll 18/18 frames in 2.3 s`: the last scene's frames, how many came of how many, and how long. `12/18 frames after 31.2 s`: still coming after the limit (the count goes on as they arrive). `5/18 frames so far, 4.1 s`: still loading. `3/18 frames, then one failed`: a frame failed.

**Last problem**: the last thing that went wrong, and how long ago. It stays after later good visits, and is not shown when nothing has gone wrong since the page loaded. One of:

- `sprite list did not load (onerror)`: `clay/sprites.js` answered with an error.
- `sprite list did not load (no onload or onerror in 30 s)`: no answer in time (`, then came in 41234 ms` when it came later; the next visit uses it).
- `sprite list loaded but is not valid (onload, ...)`: the file loaded but `CLAY_SPRITES` is missing or has no sprites or sequences.
- `the styles could not be added: ...`: putting the `<style>` in threw.
- `scene stroll skipped: frame ember/trot-a1 failed (onerror, 3 tries)`: that picture did not load, though it was asked for three times (again 1 s and 2.5 s after a failure); the scene is left out for 10 minutes. A picture that came on a later try shows in Loading instead, as `stroll 23/23 frames in 1.4 s (1 asked for again)`, and the scene plays.
- `scene stroll skipped: frame ember/trot-a1 failed (loaded, 0 px wide: did not decode)`: the file came but the browser could not decode it (WebP on an old browser, a damaged file); left out for 10 minutes.
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
- Steps: `at(x, y)`, `face(dir)` (a `right` sprite is mirrored to face left), `pose(key, ticks, dy)`, `cycle(keys, ticks, every, { dy, dx })`, `walk(keys, toX, step, every, { dy, keepFace, ease, stride })`, `arc(keys, x, y, height, ticks)`, `move(dx, dy, ticks, { key, fade })`, `wait(ticks)`, `hide()`, `fade(opacity)`, `ground(y)` (where the shadow sits), `signal(name)` and `after(name)` (wait for another actor). The helper `go(actor, GAIT, toX, { step, ease })` walks with a gait (`IAN_WALK`, `IAN_RUN`, `EMBER_TROT`, `EMBER_RUN`, ...). Travel with a gait; strike a special pose standing still (the weather outfits come in a puff once Ian has stopped) rather than sliding one picture across the screen.
- `walkTicks(from, to, step, easeIn, easeOut)` says how many ticks a walk takes, to time something else to it (the ball in `fetch` meets Ember's mouth at the top of her leap).
- Return `false` when the scene doesn't fit (`perch` with no ledge).
- Add it to `bagFor()` with a weight, to `PLAYS` and `LENGTHS` in `dev/clay-test.js`, which plays every scene and checks the rules above and its length, and to `SHOTS` in `dev/clay-shots.js`.

## Testing and filming

- `node dev/clay-test.js` checks the rules: nothing loads before the first visit, nothing plays before idle, every scene plays to the end within the limits and changes only transform and opacity, a key press clears the screen before the hub handles it, panels and layout changes end scenes, `clay: false` and `?clay=off` load nothing, a missing sprite skips a scene, night hours pick night scenes, a ticked to-do item queues a cheer, the status says what happened (off, waiting, playing, busy, hidden, a missing or slow or invalid sprite list, a missing or undecodable frame), no stylesheet is fetched, a failed or slow load is tried again at the next visit, a slow scene is not marked broken and plays at a later visit, the next scene's frames load ahead, the default pause is 90 to 150 s, after a slow visit the next comes 20 s later (three times, then `every[0]`), and at most 200 unanswered pictures are kept. The drawing: between ticks a character moves by fractions and ends each tick exactly on its position, a teleport or a turn never glides, a walk's picture goes by distance, a held pose breathes and a walk leans while the shadow does neither, `MOVE_WITH_POSE` and the blend experiment, at the real speed only transform and opacity change, slow frames go stepped and are remembered for 30 minutes, no `requestAnimationFrame` is stepped from the start, and every scene's length is in its range with 40 pictures or fewer (also with 8-picture cycles, and with the old two-picture shape of the sprite list, `CLAY_ART=old`), and that lifts, shares and `ian/stand-side` work. It also checks the About panel: Left opens it and Up does not, Right, Back and a click close it, it never opens over a panel or the layout bar, its rows come and go and refresh by themselves, a long problem wraps inside it at 1920 x 1080 and 1280 x 720, and a visit loads and plays with it open.
- `node dev/clay-shots.js [folder]` films every scene frame by frame at 30 frames a second (`HUB_TEST.clay.setSpeed(0)`, then `advance(1000 / 30)` per frame, drawn as smooth drawing draws it): stills of each, one MP4 each at the real speed, a highlights reel, a key press making them vanish, and `all-scenes.jpg`. `CLAY_FPS=7` films one frame a tick instead. Needs ffmpeg for the videos.
- `node dev/clay-compare.js [folder]` films before and after: the old engine (taken out of git at `OLD_REF`, default b119887, drawn on the ticks only) above this tree (smooth, 30 frames a second), for `stroll` and the `perch` climb, labelled and cropped (`compare-stroll.mp4`, `compare-perch.mp4`), and the About panel with its Drawing row during a visit (`about-panel-drawing.jpg`). Each side runs its own preview on spare ports. Needs git and ffmpeg.
- In a laptop browser: `HUB_TEST.clay.play('fetch')`, `.stop()`, `.state()`, `.scenes()`, `.setHour(23)`, `.setSpeed(ms)` (0: only by hand; null: the real speed), `.step()` (one whole tick, drawn where it ends), `.advance(ms)` (the clock on by ms, drawn part way), `.drawing()` (`{ mode, why, fps, text }`), `.setDrawing('stepped')`, `.forgetSlow()`, `.setBlend(ms)`, `.setMoveWithPose(true)`, `.actors()`, `.dry(name, opts)` (a scene's length and pictures without playing it), `.setLoadMs(ms)`; `HUB_CLAY.status()`.
