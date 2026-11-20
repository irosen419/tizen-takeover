/*
 * Clay wanderers: Ian and his goldendoodle Ember, two stop-motion clay
 * puppets, now and then wander onto the home screen in front of the tiles
 * while nobody is using the remote, do a short scene and leave. Plain ES5,
 * loaded before hub.js; hub.js calls HUB_CLAY.start(host) once it is up and
 * tells it about key presses, panels and layout changes (see docs/clay.md).
 *
 * Built for a weak TV (Chrome 63):
 *   - The scripts run on a fixed clock of about 7 ticks a second, so a scene
 *     plays the same way on any screen. On a tick an actor only changes which
 *     of its stacked, preloaded <img>s has opacity 1 and where it is going.
 *     Between ticks a requestAnimationFrame loop draws each actor part of the
 *     way from where it was at the last tick to where it is now ("smooth"),
 *     with a little breathing, lean and squash on top, all on the actor's
 *     transform. A screen that can't keep up (under 20 frames a second for a
 *     second), or a browser without requestAnimationFrame, gets one drawing
 *     per tick instead ("stepped"), as before. No CSS animations, no src
 *     changes, no filters, no layout reads while a scene runs.
 *   - One fixed, click-through layer above the tiles and below the scrim, the
 *     panel, the dashboard frame and the toast. It never takes focus.
 *   - A scene's frames load (new Image()) before it starts. One that fails
 *     (onerror) is asked for again, three times in all. If it still fails,
 *     or one loads 0 px wide, the scene is skipped and left out for
 *     10 minutes; if they take over 30 s the visit is skipped and the same
 *     scene comes at the next visit (the files go on loading into the cache,
 *     nothing is cancelled). Its DOM is removed when it ends. Nothing loads
 *     until the first scene: then the styles go in (one <style>, from STYLE
 *     below, no request) and clay/sprites.js (the sprite list) loads, then
 *     the frames. A failed sprite list is tried again at the next visit.
 *     After a visit, the next one's scene is picked and its frames load
 *     while they wait (one scene ahead, never sooner than the visit is due).
 *   - Any key or click, a panel opening, the page hiding or the layout
 *     changing ends a scene at once.
 *
 * Every entry point is wrapped, so if anything here breaks, the hub carries
 * on exactly as without it. HUB_CLAY.status() says what they are doing or
 * why they are not coming, how the visits went, how long loading took and
 * the last problem (the About panel shows it, under Wanderers).
 *
 * Scenes are small scripts: each actor (a character, a duo sprite or a prop)
 * gets a list of steps that play one after another, tick by tick, and actors
 * wait for each other with signal()/after(). Coordinates are screen pixels on
 * a 1080-row screen: x is where the sprite's centre of weight goes (its cx in
 * sprites.js), y where the bottom of the sprite goes (the feet, for standing
 * poses). See "Adding a scene" in docs/clay.md.
 */
(function () {
  'use strict';

  var TICK_MS = 140;           // about 7 frames a second: stop-motion
  var LOAD_MS = 30000;         // the sprite list, or a scene's frames, must load within this, or
                               // the visit is skipped (and tried again at the next one; the
                               // files go on loading into the cache)
  var SLOW_RETRY_MS = 20000;   // after a visit skipped as slow (its files still coming), the next this soon
                               // (or every[0], if that is sooner),
  var SLOW_RETRIES = 3;        // for at most this many slow visits in a row; then every[0] until one plays
  var MAX_SETTLING = 200;      // Images kept alive while they finish loading, at most (the oldest go)
  var AHEAD_MS = 3000;         // after a visit ends, this long until the next one's frames start loading
  var CHECK_MS = 5000;         // how often to look again while a panel is open or the page is hidden
  var BROKEN_MS = 10 * 60000;  // a scene whose frames failed is left out this long
  var FRAME_TRIES = 3;         // a picture that fails is asked for this many times in all
  var FRAME_RETRY_MS = [1000, 2500]; // how long after a failure the next try starts
  var MAX_TICKS = 700;         // no scene runs longer than this (100 s), whatever its script says
  var DESIGN_H = 1080;         // scenes are written for a 1080-row screen
  var FLOOR_GAP = 6;           // feet this far above the bottom of the screen
  var EDGE = 140;              // off-screen margin for entering and leaving
  var MAX_PROPS = 3;
  var MAX_FRAMES = 40;         // no scene loads more pictures than this (26 or fewer today; room for longer walk cycles)

  // Drawing between ticks (see "drawing" below).
  var MIN_FPS = 20;            // smooth drawing needs at least this many frames a second, else stepped
  var WARM_MS = 500;           // the first half second of a scene is not measured (pictures settling in)
  var MEASURE_MS = 1000;       // the rate is measured over windows this long
  var WATCH_MS = 250;          // a timer looks this often whether frames are still coming
  var SLOW_KEEP_MS = 30 * 60000; // after a scene was too slow to draw smoothly, visits are stepped this long
  var BLEND_MS = 0;            // an experiment: a change of picture blends over this long (0: a hard cut, as always)
  var OFF = 'translate3d(-2000px,-2000px,0)';

  // The styles, put in once at the first visit (no request, no load event to wait for).
  // One click-through layer above the tiles (cells have no z-index) and below
  // the scrim (10), the ghost, the panel, the dashboard frame and the toast.
  // Each actor and each shadow is its own layer; on a tick only an image's
  // opacity and an actor's transform change. Nothing here animates by itself.
  var STYLE =
    '.clay-layer{position:fixed;top:0;left:0;width:100%;height:100%;overflow:hidden;' +
      'pointer-events:none;z-index:9;transform-origin:0 0}' +
    '.clay-actor,.clay-shadow{position:absolute;top:0;left:0;width:0;height:0;' +
      'transform-origin:0 0;will-change:transform}' +
    '.clay-actor img{position:absolute;display:block;max-width:none;opacity:0}' +
    // A soft contact shadow under the feet: a painted gradient, no blur.
    '.clay-shadow{border-radius:50%;background:radial-gradient(ellipse closest-side,' +
      'rgba(0,0,0,0.45),rgba(0,0,0,0.22) 55%,rgba(0,0,0,0))}';

  var host = null;             // from hub.js: { quiet(), tiles(), widget(id), liveStatus() }
  var settings = null;         // null = off
  var assets = 'none';         // 'none' | 'loading' | 'ready' | 'failed'
  var assetWaiters = [];
  var styled = false;          // the <style> is in
  var spriteScript = null;     // the <script> of the last try
  var spriteSettled = true;    // it fired onload or onerror (else it may still come)
  var spriteStart = 0;
  var spriteMs = null;         // how long it took to fire onload or onerror
  var spriteHow = '';          // which of the two it fired
  var spriteEvent = '';        // how the last try ended: 'onload' | 'onerror' | 'timeout' | 'already there'
  var spriteTry = null;        // the waiting try's finish(how)
  var loadMs = LOAD_MS;        // tests shorten it
  var lastLoad = null;         // the last scene's frames: { name, got, of, t0, ms, timedOut }
  var settling = [];           // Images still loading after their scene gave up on them (kept alive)
  var ahead = null;            // the next visit, chosen early: { name, seed, info }
  var aheadTimer = null;
  var M = null;                // window.CLAY_SPRITES once loaded

  var scene = null;            // the scene loading or playing
  var gen = 0;                 // bumped on every stop, so late callbacks can tell they are stale
  var timer = null;            // the scheduler's one timer (only when no scene runs)
  var readyAt = 0;             // not before this: idleAfter (plus a little) after the last input or busy moment
  var due = 0;                 // not before this: the pause after the last scene
  var lastName = '';
  var last = null;             // { name, result } of the last scene
  var broken = {};             // scene name -> when its frames would not load (left out for BROKEN_MS)
  var started = false;         // start() was called
  var offWhy = '';             // when off: 'config' | '?clay=off'
  var played = 0;              // scenes that came on screen since the page loaded
  var slow = 0;                // visits skipped because loading took over loadMs
  var failedN = 0;             // visits that failed for any other reason
  var slowRun = 0;             // slow visits in a row
  var problem = null;          // { text, at }: the last thing that went wrong, kept for status()
  var hourOverride = null;
  var tickMs = TICK_MS;
  var pending = null;          // a reaction to play next: 'cheer' | 'shrug'
  var seenDone = null;         // to-do items done at the last look
  var seenLost = null;         // the "since" of the Pi connection loss already reacted to
  var drawForce = null;        // tests: 'smooth' | 'stepped' for every scene, null to decide
  var blendMs = BLEND_MS;      // tests and films: the blend experiment on (ms) or off (0)
  var moveWithPose = null;     // tests: MOVE_WITH_POSE for this page (set at the first scene)
  var slowSeen = null;         // { fps, at }: the last time a scene was too slow to draw smoothly
  var drawInfo = null;         // how the last (or current) visit is drawn: { mode, why, fps, seenAt }

  function now() { return new Date().getTime(); }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Clay: ' + text); } catch (e) { /* ignore */ }
  }

  // Something went wrong: kept for status() until something else goes wrong.
  function fail(text) {
    problem = { text: text, at: now() };
    warn(text);
  }

  function errText(e) {
    var m = e && e.message ? e.message : String(e);
    return m.length > 80 ? m.slice(0, 77) + '...' : m;
  }

  function readQuery(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function isHidden() {
    try {
      var h = document.hidden;
      if (h === undefined) h = document.webkitHidden;
      return !!h;
    } catch (e) { return false; }
  }

  function hostQuiet() {
    try { return !host || host.quiet() !== false; } catch (e) { return false; }
  }

  function quiet() {
    if (isHidden()) return false;
    return hostQuiet();
  }

  /* ---------- settings ---------- */

  function seconds(v, fallback, min, max) {
    return typeof v === 'number' && isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  }

  function range(v, fallback) {
    if (!v || Object.prototype.toString.call(v) !== '[object Array]' || v.length !== 2) return fallback;
    var a = seconds(v[0], fallback[0], 1, 86400);
    var b = seconds(v[1], fallback[1], 1, 86400);
    return a <= b ? [a, b] : [b, a];
  }

  // null when the characters are off.
  function readSettings(c) {
    offWhy = '?clay=off';
    if (readQuery('clay') === 'off') return null;
    offWhy = 'config';
    if (c === false || (c && typeof c === 'object' && c.on === false)) return null;
    if (c !== undefined && c !== true && (!c || typeof c !== 'object')) return null;
    offWhy = '';
    c = c && typeof c === 'object' ? c : {};
    return {
      idleAfter: seconds(c.idleAfter, 20, 1, 3600),
      every: range(c.every, [90, 150]),
      nightEvery: range(c.nightEvery, [300, 600])
    };
  }

  /* ---------- randomness (seeded for tests and screenshots) ---------- */

  function makeRandom(seed) {
    if (typeof seed !== 'number' || !isFinite(seed)) return Math.random;
    var s = (Math.floor(seed) >>> 0) || 1;
    return function () {
      // mulberry32
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul ? Math.imul(t ^ (t >>> 15), t | 1) : (t ^ (t >>> 15)) * (t | 1);
      t ^= t + (Math.imul ? Math.imul(t ^ (t >>> 7), t | 61) : (t ^ (t >>> 7)) * (t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function between(a, b) { return a + Math.random() * (b - a); }

  /* ---------- loading ---------- */

  function addStyle() {
    if (styled) return;
    var el = document.createElement('style');
    el.type = 'text/css';
    el.id = 'clay-style';
    el.appendChild(document.createTextNode(STYLE));
    (document.getElementsByTagName('head')[0] || document.documentElement).appendChild(el);
    styled = true;
  }

  function validSprites(S) {
    return !!(S && typeof S === 'object' && S.sprites && typeof S.sprites === 'object' &&
      S.sequences && typeof S.sequences === 'object');
  }

  function timeoutText() {
    return 'sprite list did not load (no onload or onerror in ' + Math.round(loadMs / 1000) + ' s)';
  }

  // The styles and clay/sprites.js. cb(ok). Once it worked it is never done
  // again; after a failure the next call (the next visit) tries again. A
  // timeout leaves the <script> loading: the next try waits for that one.
  function loadAssets(cb) {
    if (assets === 'ready') return cb(true);
    assetWaiters.push(cb);
    if (assets === 'loading') return;
    assets = 'loading';
    var finished = false;
    var guard = null;
    function finish(how) {
      if (finished) return;
      finished = true;
      spriteTry = null;
      clearTimeout(guard);
      spriteEvent = how;
      var S = window.CLAY_SPRITES;
      if (how === 'no styles') {
        assets = 'failed';
      } else if (how === 'onload' || how === 'already there') {
        if (validSprites(S)) {
          M = S;
          assets = 'ready';
        } else {
          assets = 'failed';
          fail('sprite list loaded but is not valid (' + how + ', ' +
            (S === undefined ? 'CLAY_SPRITES missing' : 'no sprites or sequences') + ')');
        }
      } else {
        assets = 'failed';
        fail(how === 'onerror' ? 'sprite list did not load (onerror)' : timeoutText());
      }
      var list = assetWaiters;
      assetWaiters = [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](assets === 'ready'); } catch (e) { fail('error after loading: ' + errText(e)); }
      }
    }
    try {
      addStyle();
    } catch (e) {
      fail('the styles could not be added: ' + errText(e));
      return finish('no styles');
    }
    if (window.CLAY_SPRITES) return finish('already there');
    guard = setTimeout(function () { finish('timeout'); }, loadMs);
    spriteTry = finish;
    if (spriteScript && !spriteSettled) return;      // the last one is still on its way
    var head = document.getElementsByTagName('head')[0] || document.documentElement;
    if (spriteScript && spriteScript.parentNode) spriteScript.parentNode.removeChild(spriteScript);
    var script = document.createElement('script');
    function settled(how) {
      return function () {
        if (script !== spriteScript) return;
        spriteSettled = true;
        spriteMs = now() - spriteStart;
        spriteHow = how;
        if (spriteTry) spriteTry(how);
        else if (how === 'onload' && problem && problem.text === timeoutText()) problem.text += ', then came in ' + spriteMs + ' ms';
      };
    }
    script.onload = settled('onload');
    script.onerror = settled('onerror');
    spriteScript = script;
    spriteSettled = false;
    spriteStart = now();
    spriteMs = null;
    spriteHow = '';
    script.src = 'clay/sprites.js';
    head.appendChild(script);
  }

  function spriteUrl(key) { return 'clay/' + M.sprites[key].file; }

  function unsettle(img) {
    for (var i = 0; i < settling.length; i++) if (settling[i] === img) { settling.splice(i, 1); return; }
  }

  // Loads every frame. cb(images by key) or cb(null, why, kind), kind
  // 'slow' (over loadMs), 'broken' (onerror, or onload 0 px wide: it did not
  // decode) or 'cancelled'. info ({ name }) gets got, of, t0, ms and
  // timedOut, and keeps counting frames that come after a timeout: those
  // are never dropped, so they land in the cache for the next try.
  // Returns cancel(), which only stops waiting.
  function preload(keys, info, cb) {
    var images = {};
    var left = keys.length;
    var finished = false;
    info.got = 0;
    info.of = keys.length;
    info.t0 = now();
    info.ms = null;
    info.timedOut = false;
    info.retried = 0;
    var guard = setTimeout(function () {
      info.timedOut = true;
      finish(null, 'its frames took over ' + Math.round(loadMs / 1000) + ' s (' + info.got + ' of ' + info.of + ' in)', 'slow');
    }, loadMs);
    function finish(result, why, kind) {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      if (kind === 'broken') info.failed = true;
      cb(result, why, kind);
    }
    function loaded(key, img) {
      return function () {
        unsettle(img);
        if (!(img.naturalWidth > 0)) return finish(null, 'frame ' + key + ' failed (loaded, 0 px wide: did not decode)', 'broken');
        info.got++;
        if (--left === 0) {
          info.ms = now() - info.t0;
          finish(images);
        }
      };
    }
    // A picture that fails is asked for again, twice, a little later each
    // time: through the TV's proxy one request in a batch now and then fails
    // though the file is fine. Only after the last try is the scene skipped.
    function failed(key, img, n) {
      return function () {
        unsettle(img);
        if (finished) return;
        if (n >= FRAME_TRIES) return finish(null, 'frame ' + key + ' failed (onerror, ' + n + ' tries)', 'broken');
        info.retried++;
        setTimeout(function () { if (!finished) ask(key, n + 1); }, FRAME_RETRY_MS[n - 1] || FRAME_RETRY_MS[FRAME_RETRY_MS.length - 1]);
      };
    }
    function ask(key, n) {
      var img = new Image();
      img.onload = loaded(key, img);
      img.onerror = failed(key, img, n);
      images[key] = img;
      settling.push(img);
      if (settling.length > MAX_SETTLING) settling.shift();
      img.src = spriteUrl(key);
    }
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!M.sprites.hasOwnProperty(key)) {
        setTimeout(function () { finish(null, 'frame ' + key + ' is not in the sprite list', 'broken'); }, 0);
        return function () { finished = true; clearTimeout(guard); };
      }
      ask(key, 1);
    }
    if (!keys.length) setTimeout(function () { info.ms = 0; finish(images); }, 0);
    return function () { finish(null, 'cancelled', 'cancelled'); };
  }

  // Every frame key a built scene uses.
  function frameKeys(actors) {
    var keys = [];
    var seen = {};
    for (var i = 0; i < actors.length; i++) {
      for (var key in actors[i].frames) {
        if (actors[i].frames.hasOwnProperty(key) && !seen[key]) { seen[key] = true; keys.push(key); }
      }
    }
    return keys;
  }

  /* ---------- the stage a scene plays on ---------- */

  // Measured once when a scene starts: the screen in scene pixels, the floor
  // and the ledges (the top edges of the tiles that are not in the top row).
  function measure() {
    var Wpx = window.innerWidth || 1920;
    var Hpx = window.innerHeight || 1080;
    var k = Hpx / DESIGN_H;
    if (!(k > 0)) k = 1;
    var W = Wpx / k;
    var H = Hpx / k;
    var tiles = [];
    try { tiles = host && host.tiles ? host.tiles() || [] : []; } catch (e) { tiles = []; }
    var top = Infinity;
    var i;
    for (i = 0; i < tiles.length; i++) if (tiles[i] && tiles[i].top < top) top = tiles[i].top;
    var ledges = [];
    for (i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t || !(t.width > 0) || t.top <= top + 8) continue;
      ledges.push({ id: t.id, left: t.left / k, right: (t.left + t.width) / k, y: t.top / k, width: t.width / k });
    }
    return { W: W, H: H, k: k, floor: H - FLOOR_GAP, ledges: ledges };
  }

  /* ---------- scripts ---------- */

  // How a step ends a tick: NEXT runs the following step in the same tick,
  // HOLD keeps this step for the next tick, LAST finishes it after this tick.
  var NEXT = 0;
  var HOLD = 1;
  var LAST = 2;

  function Actor(name, kind, opts) {
    opts = opts || {};
    this.name = name;
    this.kind = kind;                 // 'char' | 'duo' | 'prop'
    this.scale = opts.scale || 1;     // props only: a fixed size, never changed while playing
    this.mirror = !!opts.mirror;      // always drawn mirrored (a front-facing duo the other way round)
    this.shadowW = opts.shadow || 0;  // width of the contact shadow, 0 for none
    this.cmds = [];
    this.frames = {};
    // Play state.
    this.i = 0;
    this.x = -1000;
    this.y = -1000;
    this.gy = -1000;                  // where the shadow sits (the ground under it)
    this.dx = 0;
    this.dy = 0;
    this.dir = 'right';
    this.frame = null;
    this.op = 1;
    // Drawing state: the state after the last tick (now) and the one before
    // it (prev), which the drawing goes between; see settle() and place().
    this.now = null;
    this.prev = null;
    this.jump = false;                // an at() this tick: drawn there at once, never glided to
    this.gait = 0;                    // walking this tick (for the lean)
    this.arcAt = null;                // on an arc this tick: { c, t }, drawn along the real curve
    this.still = 0;                   // ticks it has stood still (for the breathing)
    this.amp = 0;                     // how much it breathes now, 0 to 1 (eases in and out)
    this.lean = 0;                    // degrees, eased
    this.sq = 0;                      // squash left from a landing or a skid
    this.breath = name.indexOf('ember') === 0 ? BREATH.ember : kind === 'duo' ? BREATH.duo : BREATH.ian;
    this.phase = name.length * 1.7;   // so two actors don't breathe in step
    this.old = null;                  // the blend experiment: the picture being blended away
  }

  Actor.prototype.add = function (c) { this.cmds.push(c); return this; };
  Actor.prototype.use = function (keys) {
    for (var i = 0; i < keys.length; i++) this.frames[keys[i]] = true;
    return keys;
  };
  // Put the actor at x, y (instant). The shadow goes to the same ground.
  Actor.prototype.at = function (x, y) { return this.add({ op: 'at', x: x, y: y }); };
  Actor.prototype.ground = function (y) { return this.add({ op: 'ground', y: y }); };
  Actor.prototype.face = function (dir) { return this.add({ op: 'face', dir: dir }); };
  Actor.prototype.hide = function () { return this.add({ op: 'hide' }); };
  Actor.prototype.fade = function (v) { return this.add({ op: 'fade', v: v }); };
  Actor.prototype.signal = function (name) { return this.add({ op: 'signal', name: name }); };
  Actor.prototype.after = function (name) { return this.add({ op: 'after', name: name }); };
  Actor.prototype.wait = function (ticks) { return this.add({ op: 'wait', ticks: ticks }); };
  // Show one frame for some ticks (0: show it and go straight on), raised by dy.
  Actor.prototype.pose = function (key, ticks, dy) {
    this.use([key]);
    return this.add({ op: 'pose', key: key, ticks: ticks || 0, dy: dy || 0 });
  };
  // Loop frames in place for some ticks, each held `every` ticks. o.dy and
  // o.dx are offsets per tick, in turn (a bob, a shiver).
  Actor.prototype.cycle = function (keys, ticks, every, o) {
    o = o || {};
    return this.add({ op: 'cycle', keys: this.use(keys), ticks: ticks, every: every || 1, dys: o.dy, dxs: o.dx });
  };
  // Walk (or run, trot, shuffle) to x, `step` px a tick; turns to face the
  // way it goes unless o.keepFace. With o.stride (px for one whole round of
  // the pictures) the picture goes by the distance walked, so the feet keep
  // to the ground at any speed; without, it changes every `every` ticks.
  // It eases in and out (o.ease 'both', the default): the first ticks are
  // shorter, and so are the last before it stops. 'in' (into a skid or a
  // leap), 'out' or 'none' for the others. A walk that starts or ends off
  // screen doesn't ease at that end. It always ends exactly on x.
  Actor.prototype.walk = function (keys, to, step, every, o) {
    o = o || {};
    return this.add({ op: 'walk', keys: this.use(keys), to: to, step: step, every: every || 1, dys: o.dy,
      keepFace: !!o.keepFace, ease: o.ease || 'both', stride: o.stride || 0, cuts: o.cuts || null });
  };
  // Move along a parabola to (x, y) in `ticks`, peaking `height` px above the straight line.
  Actor.prototype.arc = function (keys, x, y, height, ticks) {
    return this.add({ op: 'arc', keys: this.use(keys), x: x, y: y, height: height, ticks: ticks });
  };
  // Move by dx, dy each tick for some ticks; o.key shows a frame, o.fade
  // is a list of opacities, one per tick (props only).
  Actor.prototype.move = function (dx, dy, ticks, o) {
    o = o || {};
    if (o.key) this.use([o.key]);
    return this.add({ op: 'move', dx: dx, dy: dy, ticks: ticks, key: o.key || null, fades: o.fade || null });
  };

  function keyAt(list, i) { return list[i % list.length]; }

  // Which picture of a gait shows after d px, round and round. Evenly spaced
  // by default: floor(d / stride * pictures). With c.cuts (where each picture
  // starts, as a share of the stride: 0 first, then rising, all under 1) the
  // pictures can cover different shares of the stride.
  function gaitIndex(c, d) {
    var n = c.keys.length;
    if (!c.cuts) return Math.floor(d / c.stride * n + 1e-6) % n;
    var u = d / c.stride + 1e-6;
    var f = u - Math.floor(u);
    var i = n - 1;
    while (i > 0 && f < c.cuts[i]) i--;
    return i;
  }

  function gaitFrame(c, d) { return c.keys[gaitIndex(c, d)]; }

  // Where the picture showing after d px began (for pose-locked moving).
  function gaitFrameStart(c, d) {
    var i = gaitIndex(c, d);
    var u = d / c.stride + 1e-6;
    var whole = Math.floor(u);
    // Just after a round ends, gaitIndex already shows picture 0 of the next.
    var start = c.cuts ? c.cuts[i] : i / c.keys.length;
    return (whole + start) * c.stride;
  }

  // How far above the floor line a picture is drawn (CLAY_SPRITES.lifts, for
  // the flight phases of a run); 0 for most.
  function liftOf(key) {
    var L = M && M.lifts;
    var v = L && key ? L[key] : 0;
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  // A walk's tick lengths, as fractions of its step: the first three ticks
  // speed up, and near the end each tick goes half the way that is left
  // (never under a quarter step), so it slows into its stop.
  var EASE_IN = [0.3, 0.6, 0.85];

  function onStage(x, W) { return x > -40 && x < W + 40; }

  // How far a walk goes on its tick t (0 for the first), with rem px left.
  function stride(c, t, rem) {
    var v = c.step;
    if (c.easeIn && t < EASE_IN.length) v = c.step * EASE_IN[t];
    if (c.easeOut) v = Math.min(v, Math.max(c.step * 0.25, rem * 0.5));
    return v;
  }

  // How many ticks a walk from `from` to `to` takes (for scenes that time
  // something else to it, like the ball in fetch).
  function walkTicks(from, to, step, easeIn, easeOut) {
    var c = { step: step, easeIn: easeIn, easeOut: easeOut };
    var sign = to >= from ? 1 : -1;
    var x = from;
    for (var t = 1; t < 1000; t++) {
      x += sign * stride(c, t - 1, Math.abs(to - x));
      if ((sign > 0 && x >= to) || (sign < 0 && x <= to)) return t;
    }
    return t;
  }

  var OPS = {
    at: function (a, c) { a.x = c.x; a.y = c.y; a.gy = c.y; a.jump = true; return NEXT; },
    ground: function (a, c) { a.gy = c.y; return NEXT; },
    face: function (a, c) { a.dir = c.dir; return NEXT; },
    hide: function (a) { a.frame = null; return NEXT; },
    fade: function (a, c) { a.op = c.v; return NEXT; },
    signal: function (a, c, sc) {
      if (!sc.signals[c.name]) sc.signals[c.name] = sc.tick;
      return NEXT;
    },
    after: function (a, c, sc) { return sc.signals[c.name] ? NEXT : HOLD; },
    wait: function (a, c) {
      if (!c.ticks) return NEXT;
      c.t = (c.t || 0) + 1;
      return c.t >= c.ticks ? LAST : HOLD;
    },
    pose: function (a, c) {
      a.frame = c.key;
      a.dy = c.dy;
      a.dx = 0;
      if (!c.ticks) return NEXT;
      c.t = (c.t || 0) + 1;
      return c.t >= c.ticks ? LAST : HOLD;
    },
    cycle: function (a, c) {
      var t = c.t || 0;
      a.frame = keyAt(c.keys, Math.floor(t / c.every));
      a.dy = c.dys ? keyAt(c.dys, t) : 0;
      a.dx = c.dxs ? keyAt(c.dxs, t) : 0;
      c.t = t + 1;
      return c.t >= c.ticks ? LAST : HOLD;
    },
    walk: function (a, c, sc) {
      if (c.t === undefined) {
        var W = sc && sc.W ? sc.W : 1920;
        c.t = 0;
        c.d = 0;
        c.x0 = a.x;
        c.sign = c.to >= a.x ? 1 : -1;
        c.easeIn = (c.ease === 'both' || c.ease === 'in') && onStage(a.x, W);
        c.easeOut = (c.ease === 'both' || c.ease === 'out') && onStage(c.to, W);
        if (!c.keepFace) a.dir = c.sign > 0 ? 'right' : 'left';
      }
      a.dx = 0;
      a.gait = 1;
      var d0 = c.d;
      var v = stride(c, c.t, Math.abs(c.to - a.x));
      var last = (c.sign > 0 && a.x + v >= c.to) || (c.sign < 0 && a.x - v <= c.to);
      if (last) v = Math.abs(c.to - a.x);
      a.x = last ? c.to : a.x + c.sign * v;
      c.d += v;
      if (c.stride) {
        // A gait: the picture and the bob by the distance walked (at the
        // end of this tick; the drawing works it out for each frame).
        a.frame = gaitFrame(c, c.d);
        a.dy = c.dys ? c.dys[Math.floor(((c.d % c.stride) / c.stride) * c.dys.length) % c.dys.length] : 0;
        a.gaitAt = { c: c, d0: d0, d1: c.d, last: last };
      } else {
        // One picture slid along (or an old-style list changing every `every` ticks).
        a.frame = keyAt(c.keys, Math.floor(c.t / c.every));
        a.dy = c.dys ? keyAt(c.dys, c.t) : 0;
      }
      c.t++;
      return last ? LAST : HOLD;
    },
    arc: function (a, c) {
      if (c.t === undefined) { c.t = 0; c.x0 = a.x; c.y0 = a.y; }
      c.t++;
      a.arcAt = { c: c, t: c.t };
      var p = Math.min(1, c.t / c.ticks);
      a.x = c.x0 + (c.x - c.x0) * p;
      a.y = c.y0 + (c.y - c.y0) * p - 4 * c.height * p * (1 - p);
      a.frame = c.keys[Math.min(c.keys.length - 1, Math.floor(p * c.keys.length - 1e-9))];
      a.dy = 0;
      a.dx = 0;
      return c.t >= c.ticks ? LAST : HOLD;
    },
    move: function (a, c) {
      c.t = (c.t || 0) + 1;
      a.x += c.dx;
      a.y += c.dy;
      if (c.key) { a.frame = c.key; a.dy = 0; a.dx = 0; }
      if (c.fades) a.op = keyAt(c.fades, c.t - 1);
      return c.t >= c.ticks ? LAST : HOLD;
    }
  };

  // One tick of one actor's script. Returns true while it has steps left.
  function runActor(a, sc) {
    var n = 0;
    while (a.i < a.cmds.length) {
      if (++n > 60) return true;      // a script of only instant steps: go on next tick
      var c = a.cmds[a.i];
      var r = OPS[c.op](a, c, sc);
      if (r === NEXT) { a.i++; continue; }
      if (r === LAST) a.i++;
      return true;
    }
    return false;
  }

  /* ---------- drawing ---------- */

  // The scripts move on whole ticks (TICK_MS). The drawing runs on its own
  // clock, sc.tau (ms since the scene started): tick n covers the time from
  // (n - 1) * TICK_MS to n * TICK_MS, and while it does each actor is drawn
  // part of the way (p, 0 to 1) from where it was after tick n - 1 (prev)
  // to where it is after tick n (now). At p = 1 it is exactly where the
  // script put it. advance(ms) moves that clock on, runs the ticks that come
  // due and draws once. The real loop calls it from requestAnimationFrame
  // with the time since the last frame; tests and films call it by hand.
  //
  // What never glides: an at() (a teleport), the first appearance and a
  // show after a hide are drawn where they are at once; the picture and the
  // way it faces (scaleX(-1)) change at the start of the tick, never half
  // way. The bob (dy, dx) eases between its values, so it reads as a soft
  // bounce, and an arc follows its real curve on every drawn frame.
  //
  // On top of that, a character gets a little life, on its transform only
  // and never on its shadow: it breathes when it has stood still for a few
  // ticks (a slow scale about its feet), leans into a walk or a run, and
  // squashes a little on a landing or a skid. "Stepped" drawing (a slow
  // screen) draws once a tick at the tick's position, without any of that,
  // as before.

  // How a walk with a stride is drawn between ticks: false moves the
  // position continuously, every frame; true moves it only when the walk's
  // picture changes, by the stride's share for one picture (classic
  // stop-motion: pose and position change together). Either way the picture
  // is chosen by the distance walked.
  var MOVE_WITH_POSE = false;

  var BREATH = {
    ian: { ms: 2900, by: 0.012 },     // a breath every 2.9 s, 1.2 % taller at the top of it
    ember: { ms: 1700, by: 0.016 },   // a dog breathes faster
    duo: { ms: 2500, by: 0.01 }
  };
  var STILL_TICKS = 3;                // standing still this many ticks before breathing starts
  var LEAN_PER_PX = 0.07;             // degrees of lean per px a tick (a walk 1.3, a run 3)
  var LEAN_MAX = 3.5;
  // Pictures that land with a squash when they first show (a fraction of the height).
  var SQUASH = { 'ian/skid': 0.05, 'ember/skid': 0.06, 'ember/pounce': 0.05, 'ian/jump-land': 0.07, 'ember/jump-land': 0.07 };
  var LAND_SQUASH = 0.07;             // a character that comes down onto its ground
  // Pictures held by their hands, which must not move: no breathing.
  var NO_BREATH = { 'ian/hang': true, 'ian/climb': true };

  function perf() {
    try { if (window.performance && typeof performance.now === 'function') return performance.now(); } catch (e) { /* below */ }
    return now();
  }

  function rafFn() { return typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame : null; }

  // To 0.1 px when smooth (the layers move by fractions), whole px when stepped.
  function num(v, fine) { return fine ? Math.round(v * 10) / 10 : Math.round(v); }

  function buildLayer(sc, images) {
    var layer = document.createElement('div');
    layer.className = 'clay-layer';
    layer.setAttribute('aria-hidden', 'true');
    if (sc.k !== 1) {
      // A screen that isn't 1080 rows: the whole scene scales once, up front.
      layer.style.width = sc.W + 'px';
      layer.style.height = sc.H + 'px';
      layer.style.transform = 'scale(' + sc.k + ')';
    }
    var used = {};
    var i, a;
    for (i = 0; i < sc.actors.length; i++) {
      a = sc.actors[i];
      if (!a.shadowW) continue;
      a.sh = document.createElement('div');
      a.sh.className = 'clay-shadow';
      a.sh.style.width = a.shadowW + 'px';
      a.sh.style.height = Math.round(a.shadowW * 0.18) + 'px';
      a.sh.style.marginLeft = -Math.round(a.shadowW / 2) + 'px';
      a.sh.style.marginTop = -Math.round(a.shadowW * 0.09) + 'px';
      a.sh.style.transform = OFF;
      a.shT = a.sh.style.transform;
      layer.appendChild(a.sh);
    }
    for (i = 0; i < sc.actors.length; i++) {
      a = sc.actors[i];
      a.el = document.createElement('div');
      a.el.className = 'clay-actor';
      a.el.style.transform = OFF;
      a.tf = a.el.style.transform;
      a.imgs = {};
      a.order = {};
      var n = 0;
      for (var key in a.frames) {
        if (!a.frames.hasOwnProperty(key)) continue;
        var s = M.sprites[key];
        // The loaded picture itself the first time, a copy (from the cache) after that.
        var img = used[key] ? images[key].cloneNode(false) : images[key];
        used[key] = true;
        img.alt = '';
        img.className = '';
        img.style.left = -Math.round(s.cx) + 'px';
        img.style.top = -s.h + 'px';
        img.style.width = s.w + 'px';
        img.style.height = s.h + 'px';
        a.imgs[key] = img;
        a.order[key] = n++;
        a.el.appendChild(img);
      }
      a.shown = null;
      a.opShown = 1;
      layer.appendChild(a.el);
    }
    return layer;
  }

  function flipOf(a, f) {
    return a.mirror || (!!f && a.dir === 'left' && M.sprites[f].faces === 'right');
  }

  // After a tick's scripts ran: the actor's new state, and where the drawing
  // comes from (the last state, or the new one itself when it must not glide).
  function settle(a, sc) {
    var C = { x: a.x, y: a.y, dx: a.dx, dy: a.dy, gy: a.gy, op: a.op, frame: a.frame,
      arc: a.arcAt, gait: a.gait, gaitAt: a.gaitAt, flip: flipOf(a, a.frame) };
    var P = a.now;
    var snapped = !P || !P.frame || !C.frame || a.jump;
    if (snapped) { P = C; C.gaitAt = null; }
    a.prev = P;
    a.now = C;
    if (!snapped && C.x === P.x && C.y === P.y && C.dx === P.dx && C.dy === P.dy) a.still++;
    else a.still = 0;
    if (snapped) a.jumpTick = sc.tick;
    if (a.kind !== 'prop' && C.frame) {
      if (C.frame !== P.frame && SQUASH[C.frame]) a.sq = Math.max(a.sq, SQUASH[C.frame]);
      if (!snapped && P.y < C.gy - 3 && C.y >= C.gy - 0.5) a.sq = Math.max(a.sq, LAND_SQUASH);
    }
  }

  function setOp(img, v) {
    var s = String(Math.round(v * 100) / 100);
    if (img.style.opacity !== s) img.style.opacity = s;
  }

  // Which picture shows. The blend experiment (blendMs > 0, smooth only):
  // the new picture fades in on top of the old one, which stays fully
  // opaque until it is dropped, so the body never goes see-through. When the
  // new one is stacked below the old one, the same thing the other way
  // round: the new one shows at once and the old one fades off the top.
  function showFrame(a, f, sc, smooth) {
    if (f !== a.shown) {
      if (a.old) { a.imgs[a.old].style.opacity = '0'; a.old = null; }
      var from = a.shown;
      a.shown = f;
      if (blendMs > 0 && smooth && from && f) {
        a.old = from;
        a.blendAt = (sc.tick - 1) * TICK_MS;
        a.above = a.order[f] > a.order[from];
        a.imgs[f].style.opacity = a.above ? '0' : '1';
      } else {
        if (from) a.imgs[from].style.opacity = '0';
        if (f) a.imgs[f].style.opacity = '1';
      }
    }
    if (!a.old) return;
    var k = (sc.tau - a.blendAt) / blendMs;
    if (k >= 1 || !smooth) {
      a.imgs[a.old].style.opacity = '0';
      if (a.shown) a.imgs[a.shown].style.opacity = '1';
      a.old = null;
    } else if (a.above) {
      setOp(a.imgs[a.shown], Math.max(0, k));
    } else {
      setOp(a.imgs[a.old], 1 - Math.max(0, k));
    }
  }

  // The breathing, lean and squash, as transform functions (or '').
  function life(a, sc, C, P, dt) {
    var B = a.breath;
    var want = a.still >= STILL_TICKS && !NO_BREATH[C.frame] ? 1 : 0;
    a.amp += (want - a.amp) * Math.min(1, dt / 500);
    var s = Math.sin(2 * Math.PI * sc.tau / B.ms + a.phase);
    var sy = 1 + a.amp * B.by * s;
    var sx = 1 - a.amp * B.by * 0.5 * s;
    var lean = C.gait ? Math.max(-LEAN_MAX, Math.min(LEAN_MAX, (C.x - P.x) * LEAN_PER_PX)) : 0;
    a.lean += (lean - a.lean) * Math.min(1, dt / 160);
    if (a.sq > 0.002) {
      sy *= 1 - a.sq;
      sx *= 1 + a.sq * 0.6;
      a.sq *= Math.exp(-dt / 110);
    } else {
      a.sq = 0;
    }
    var out = '';
    if (Math.abs(a.lean) > 0.05) out += ' rotate(' + a.lean.toFixed(2) + 'deg)';
    if (Math.abs(sx - 1) > 0.0004 || Math.abs(sy - 1) > 0.0004) out += ' scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
    return out;
  }

  // Draws an actor p of the way through the current tick (1 when stepped).
  function place(a, sc, p, dt) {
    var C = a.now;
    var P = a.prev || C;
    var f = C ? C.frame : null;
    var smooth = sc.draw.mode === 'smooth';
    showFrame(a, f, sc, smooth);
    if (!f) {
      if (a.sh && a.shT !== OFF) { a.shT = OFF; a.sh.style.transform = OFF; }
      return;
    }
    if (!smooth) p = 1;
    var x, y;
    var g = smooth ? C.gaitAt : null;
    var d = g ? g.d0 + (g.d1 - g.d0) * p : 0;
    a.drawD = g ? d : null;
    if (g) {
      // Travelling: the picture by distance, so the feet keep to the ground.
      f = gaitFrame(g.c, d);
      showFrame(a, f, sc, smooth);
    }
    if (g && (moveWithPose === null ? MOVE_WITH_POSE : moveWithPose) && !(p >= 1 && g.last)) {
      // Stop-motion: the position moves only when the picture changes.
      x = g.c.x0 + g.c.sign * gaitFrameStart(g.c, d);
      y = C.y;
    } else if (C.arc) {
      // Along the real parabola: the tick's share of the arc, p of the way through.
      var c = C.arc.c;
      var q = (C.arc.t - 1 + p) / c.ticks;
      x = c.x0 + (c.x - c.x0) * q;
      y = c.y0 + (c.y - c.y0) * q - 4 * c.height * q * (1 - q);
    } else {
      x = P.x + (C.x - P.x) * p;
      y = P.y + (C.y - P.y) * p;
    }
    var e = (1 - Math.cos(Math.PI * p)) / 2;
    x += P.dx + (C.dx - P.dx) * e;
    y += P.dy + (C.dy - P.dy) * e;
    // A picture in mid-air (a lift in the sprite list) is drawn that much
    // higher; the shadow below stays on the ground.
    a.lift = liftOf(f);
    var tf = 'translate3d(' + num(x, smooth) + 'px,' + num(y - a.lift, smooth) + 'px,0)';
    if (smooth && a.kind !== 'prop') tf += life(a, sc, C, P, dt);
    if (a.scale !== 1) tf += ' scale(' + a.scale + ')';
    if (C.flip) tf += ' scaleX(-1)';
    if (tf !== a.tf) { a.el.style.transform = tf; a.tf = tf; }
    var op = smooth ? Math.round((P.op + (C.op - P.op) * p) * 100) / 100 : C.op;
    if (op !== a.opShown) { a.el.style.opacity = String(op); a.opShown = op; }
    if (a.sh) {
      var gy = P.gy + (C.gy - P.gy) * p;
      var st = 'translate3d(' + num(x, smooth) + 'px,' + num(gy, smooth) + 'px,0)';
      if (st !== a.shT) { a.sh.style.transform = st; a.shT = st; }
    }
  }

  function drawAll(sc, p, dt) {
    for (var i = 0; i < sc.actors.length; i++) place(sc.actors[i], sc, p, dt);
  }

  /* ---------- running a scene ---------- */

  function count(sc) {
    var out = { chars: 0, props: 0 };
    if (!sc || !sc.actors) return out;
    for (var i = 0; i < sc.actors.length; i++) {
      var a = sc.actors[i];
      if (!a.shown) continue;
      if (a.kind === 'prop') out.props++;
      else out.chars += a.kind === 'duo' ? 2 : 1;
    }
    return out;
  }

  // One tick of every script. False when the scene ended.
  function tickOnce(sc) {
    if (!quiet()) { end('interrupted'); return false; }
    sc.tick++;
    var i, a;
    var alive = false;
    for (i = 0; i < sc.actors.length; i++) {
      a = sc.actors[i];
      a.jump = false;
      a.gait = 0;
      a.gaitAt = null;
      a.arcAt = null;
    }
    for (i = 0; i < sc.actors.length; i++) if (runActor(sc.actors[i], sc)) alive = true;
    for (i = 0; i < sc.actors.length; i++) settle(sc.actors[i], sc);
    if (!alive) sc.idleTicks++;
    if (sc.idleTicks > 1 || sc.tick > MAX_TICKS) { end('done'); return false; }
    return true;
  }

  // Moves the scene's clock on by ms: runs the ticks that come due, then
  // draws once, part of the way through the current tick. False when the
  // scene ended.
  function advance(sc, ms) {
    sc.tau += ms;
    while (sc.tau > sc.tick * TICK_MS + 0.001) {
      if (!tickOnce(sc)) return false;
    }
    drawAll(sc, (sc.tau - (sc.tick - 1) * TICK_MS) / TICK_MS, ms);
    return true;
  }

  // How this scene will be drawn: { mode: 'smooth' | 'stepped', why, fps }.
  // why: '' (smooth, measured as it plays), 'hand' (a test steps it),
  // 'test' (a test chose), 'speed' (a test sped the clock up), 'no-raf'
  // (no requestAnimationFrame) or 'remembered' (a scene in the last 30
  // minutes was too slow to draw smoothly).
  function chooseDrawing() {
    var d = { mode: 'smooth', why: '', fps: null, seenAt: 0 };
    if (drawForce) { d.mode = drawForce; d.why = 'test'; }
    else if (tickMs === 0) d.why = 'hand';
    else if (tickMs !== TICK_MS) { d.mode = 'stepped'; d.why = 'speed'; }
    else if (!rafFn()) { d.mode = 'stepped'; d.why = 'no-raf'; }
    else if (slowSeen && now() - slowSeen.at < SLOW_KEEP_MS) {
      d.mode = 'stepped';
      d.why = 'remembered';
      d.fps = slowSeen.fps;
      d.seenAt = slowSeen.at;
    }
    return d;
  }

  // Starts the scene's clock: the first tick at once, drawn where it ends,
  // then frames (smooth), a timer (stepped) or nothing (a test steps it).
  function run(sc) {
    sc.draw = chooseDrawing();
    drawInfo = sc.draw;
    sc.tau = 0;
    sc.raf = null;
    if (!advance(sc, TICK_MS)) return;
    if (tickMs === 0) return;
    var raf = rafFn();
    if (sc.draw.mode === 'smooth' && tickMs === TICK_MS && raf) {
      sc.rafFn = raf;
      sc.cafFn = typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame : null;
      sc.lastT = perf();
      sc.m = { start: sc.lastT, t0: sc.lastT, n: 0, allN: 0, allMs: 0 };
      sc.raf = raf.call(window, frame);
      sc.timer = setTimeout(watch, WATCH_MS);
    } else {
      sc.timer = setTimeout(stepTick, tickMs);
    }
  }

  // Stepped: one tick and one drawing per timer.
  function stepTick() {
    var sc = scene;
    if (!sc || sc.phase !== 'playing') return;
    sc.timer = null;
    try {
      sc.tau = sc.tick * TICK_MS;
      if (!advance(sc, TICK_MS)) return;
      if (tickMs > 0) sc.timer = setTimeout(stepTick, tickMs);
    } catch (e) {
      fail('error in scene ' + sc.name + ': ' + errText(e));
      end('error');
    }
  }

  // Smooth: once per screen frame. One frame never moves the clock more
  // than two ticks, so a stall slows the scene down instead of jumping it.
  function frame() {
    var sc = scene;
    if (!sc || sc.phase !== 'playing' || sc.raf === null) return;
    sc.raf = null;
    try {
      var t = perf();
      var dt = t - sc.lastT;
      sc.lastT = t;
      sc.m.n++;
      if (!advance(sc, Math.max(0, Math.min(dt, 2 * TICK_MS)))) return;
      if (!judge(sc, t)) return;
      sc.raf = sc.rafFn.call(window, frame);
    } catch (e) {
      fail('error in scene ' + sc.name + ': ' + errText(e));
      end('error');
    }
  }

  // Smooth: a timer that keeps an eye on the frames. If none came for a
  // while (a browser that stops them), it moves the scene on itself, and the
  // rate it measures then is low, so the scene goes stepped.
  function watch() {
    var sc = scene;
    if (!sc || sc.phase !== 'playing' || sc.draw.mode !== 'smooth') return;
    sc.timer = null;
    try {
      var t = perf();
      if (t - sc.lastT > 300) {
        var dt = t - sc.lastT;
        sc.lastT = t;
        if (!advance(sc, Math.min(dt, 2 * TICK_MS))) return;
      }
      if (!judge(sc, t)) return;
      sc.timer = setTimeout(watch, WATCH_MS);
    } catch (e) {
      fail('error in scene ' + sc.name + ': ' + errText(e));
      end('error');
    }
  }

  // The frame rate, a second at a time after the first half second. Under
  // MIN_FPS: stepped for the rest of the scene (and the next 30 minutes).
  // False when it switched.
  function judge(sc, t) {
    var m = sc.m;
    if (t - m.start < WARM_MS) { m.t0 = t; m.n = 0; return true; }
    var span = t - m.t0;
    if (span < MEASURE_MS) return true;
    var fps = m.n * 1000 / span;
    m.allN += m.n;
    m.allMs += span;
    m.t0 = t;
    m.n = 0;
    sc.draw.fps = Math.round(m.allN * 1000 / m.allMs);
    if (fps >= MIN_FPS) return true;
    if (sc.raf !== null && sc.cafFn) { try { sc.cafFn.call(window, sc.raf); } catch (e) { /* ignore */ } }
    sc.raf = null;
    if (sc.timer) clearTimeout(sc.timer);
    slowSeen = { fps: Math.round(fps), at: now() };
    sc.draw = { mode: 'stepped', why: 'slow', fps: slowSeen.fps, seenAt: slowSeen.at };
    drawInfo = sc.draw;
    // The tick in progress is drawn where it ends, then a tick a timer.
    var left = sc.tick * TICK_MS - sc.tau;
    sc.tau = sc.tick * TICK_MS;
    drawAll(sc, 1, 0);
    sc.timer = setTimeout(stepTick, Math.max(0, left));
    return false;
  }

  // Ends the scene now and takes its DOM away. result: 'done' | 'interrupted' |
  // 'stopped' | 'slow: ...' | 'failed: ...' | 'error'.
  function end(result) {
    var sc = scene;
    if (!sc) return;
    scene = null;
    gen++;
    if (sc.timer) clearTimeout(sc.timer);
    if (sc.raf !== null && sc.raf !== undefined && sc.cafFn) { try { sc.cafFn.call(window, sc.raf); } catch (e) { /* ignore */ } }
    sc.raf = null;
    if (sc.cancel) { try { sc.cancel(); } catch (e) { /* ignore */ } }
    if (sc.layer && sc.layer.parentNode) sc.layer.parentNode.removeChild(sc.layer);
    sc.layer = null;
    last = { name: sc.name, result: result, ticks: sc.tick, at: now() };
    if (sc.phase === 'playing') lastName = sc.name;
    if (result.indexOf('slow:') === 0) slow++;
    else if (result.indexOf('failed:') === 0 && result !== 'failed: does not fit here') failedN++;
    else if (result === 'error') failedN++;
    var t = now();
    if (result === 'done') {
      var r = sc.night ? settings.nightEvery : settings.every;
      due = t + between(r[0], r[1]) * 1000;
    } else if (result === 'interrupted' || result === 'stopped') {
      // The next quiet spell gets a fresh visit.
      due = 0;
    } else if (result.indexOf('slow:') === 0 && ++slowRun <= SLOW_RETRIES) {
      // Its files are still coming: back soon (the idle rule still applies).
      due = t + Math.min(SLOW_RETRY_MS, settings.every[0] * 1000);
    } else {
      due = t + settings.every[0] * 1000;
    }
    // Loading too slowly: the same scene, the same way, at the next visit.
    if (result.indexOf('slow:') === 0) ahead = { name: sc.name, seed: sc.seed, info: null };
    if (result !== 'stopped') aheadSoon();
    arm();
  }

  // Builds the named scene and starts loading it. Returns true when it started.
  function begin(name, opts) {
    opts = opts || {};
    if (scene) end('stopped');
    var my = ++gen;
    scene = { name: name, seed: opts.seed, phase: 'loading', step: 'sprite list', tick: 0, idleTicks: 0, t0: now() };
    stopTimer();
    loadAssets(function (ok) {
      if (my !== gen || !scene) return;
      if (!ok) return end((spriteEvent === 'timeout' ? 'slow: ' : 'failed: ') + 'no sprite list');
      var sc = scene;
      sc.step = 'frames';
      var built;
      try {
        built = build(name, opts);
      } catch (e) {
        fail('scene ' + name + ' could not be built: ' + errText(e));
        broken[name] = now();
        return end('error');
      }
      if (!built) return end('failed: does not fit here');
      sc.actors = built.actors;
      sc.night = !!built.night;
      sc.W = built.W;
      sc.H = built.H;
      sc.k = built.k;
      sc.signals = {};
      lastLoad = { name: name };
      sc.cancel = preload(frameKeys(sc.actors), lastLoad, function (images, why, kind) {
        sc.cancel = null;
        if (my !== gen || scene !== sc) return;
        if (!images) {
          if (kind === 'slow') {
            // Not broken: only slow. The frames go on loading into the cache.
            fail('scene ' + name + ' skipped: ' + why);
            return end('slow: ' + why);
          }
          if (kind === 'broken') {
            fail('scene ' + name + ' skipped: ' + why);
            broken[name] = now();
          }
          return end('failed: ' + why);
        }
        if (!quiet()) return end('interrupted');
        try {
          sc.layer = buildLayer(sc, images);
          document.body.appendChild(sc.layer);
        } catch (e) {
          fail('scene ' + name + ' could not be shown: ' + errText(e));
          return end('error');
        }
        sc.phase = 'playing';
        played++;
        slowRun = 0;
        try {
          run(sc);
        } catch (e) {
          fail('error in scene ' + name + ': ' + errText(e));
          end('error');
        }
      });
    });
    return true;
  }

  /* ---------- the next visit's frames, ahead of time ---------- */

  // A little after a visit ends (never in a key handler: from a timer), and
  // only once the sprite list is in: pick the next visit's scene now and
  // start loading its frames, so the visit starts from the cache. One scene
  // ahead at most. It never changes when the next visit comes, only which
  // scene a plain random pick gives (a reaction still goes first).
  function aheadSoon() {
    if (aheadTimer) clearTimeout(aheadTimer);
    aheadTimer = setTimeout(loadAhead, AHEAD_MS);
  }

  function loadAhead() {
    aheadTimer = null;
    try {
      if (!settings || scene || assets !== 'ready' || !quiet()) return;
      if (ahead && ahead.info) return;                 // already loading or loaded
      if (!ahead) {
        var name = pick(bagFor(hourNow()));
        if (!name) return;
        ahead = { name: name, seed: Math.floor(Math.random() * 1e9), info: null };
      }
      var built = build(ahead.name, { seed: ahead.seed });
      if (!built) { ahead = null; return; }
      ahead.info = { name: ahead.name };
      preload(frameKeys(built.actors), ahead.info, function () { /* only for the cache */ });
    } catch (e) {
      ahead = null;
      warn('loading ahead: ' + errText(e));
    }
  }

  /* ---------- choosing ---------- */

  function hourNow() { return hourOverride !== null ? hourOverride : new Date().getHours(); }
  function isNight(h) { return h >= 22 || h < 6; }

  // The Weather widget's reading now, mapped to an outfit, or null.
  function outfit() {
    var w = null;
    try {
      var widget = host && host.widget ? host.widget('weather') : null;
      w = widget && typeof widget.current === 'function' ? widget.current() : null;
    } catch (e) { w = null; }
    if (!w || typeof w !== 'object') return null;
    var code = typeof w.code === 'number' ? w.code : -1;
    var f = typeof w.temp === 'number' ? (w.units === 'celsius' ? w.temp * 9 / 5 + 32 : w.temp) : null;
    var mph = typeof w.wind === 'number' ? (w.units === 'celsius' ? w.wind / 1.609 : w.wind) : null;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'umbrella';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'cold';
    if (mph !== null && mph >= 20) return 'windy';
    if (f !== null && f >= 88) return 'hot';
    if (f !== null && f <= 40) return 'cold';
    if ((code === 0 || code === 1) && w.isDay !== false && (f === null || f >= 60)) return 'sunny';
    return null;
  }

  // Looks at the To-do count and the Pi connection; may queue a reaction.
  function lookForReactions(night) {
    try {
      var todo = host && host.widget ? host.widget('todo') : null;
      var done = todo && typeof todo.doneCount === 'function' ? todo.doneCount() : null;
      if (typeof done === 'number') {
        if (seenDone !== null && done > seenDone && !night) pending = 'cheer';
        seenDone = done;
      }
    } catch (e) { /* no reaction */ }
    try {
      var st = host && host.liveStatus ? host.liveStatus() : null;
      if (st && st.state === 'lost') {
        if (seenLost !== st.since && !night && pending !== 'cheer') pending = 'shrug';
        seenLost = st.since;
      }
    } catch (e2) { /* no reaction */ }
  }

  function usable(name, t) {
    if (broken[name] && t - broken[name] < BROKEN_MS) return false;
    delete broken[name];
    return true;
  }

  // Scenes that are variants of one another, by family; any other scene is
  // its own family. A family's weight is split among its usable variants, and
  // no family comes twice in a row.
  var FAMILY = { 'fetch': 'fetch', 'fetch-bolt': 'fetch', 'fetch-snub': 'fetch' };
  function familyOf(name) { return FAMILY.hasOwnProperty(name) ? FAMILY[name] : name; }

  // The scenes that may come at hour h, with their weights: by day each
  // family 2 (fetch's 2 split among its variants), morning and evening 3 in
  // their hours, weather 2; at night only night.
  function bagFor(h) {
    var bag = [];
    var t = now();
    function put(name, weight) { if (usable(name, t)) bag.push({ name: name, weight: weight }); }
    function putFamily(names, weight) {
      var ok = [];
      for (var i = 0; i < names.length; i++) if (usable(names[i], t)) ok.push(names[i]);
      for (var j = 0; j < ok.length; j++) bag.push({ name: ok[j], weight: weight / ok.length });
    }
    if (isNight(h)) {
      put('night', 1);
    } else {
      put('stroll', 2);
      putFamily(['fetch', 'fetch-bolt', 'fetch-snub'], 2);
      put('sock-heist', 2);
      put('zoomies', 2);
      put('perch', 2);
      if (h >= 6 && h < 10) put('morning', 3);
      if (h >= 19 && h < 22) put('evening', 3);
      if (outfit()) put('weather', 2);
    }
    return bag;
  }

  // At random by weight, never from the last scene's family (unless nothing
  // else is left).
  function pick(bag) {
    var fam = lastName ? familyOf(lastName) : '';
    var rest = [];
    for (var i = 0; i < bag.length; i++) if (familyOf(bag[i].name) !== fam) rest.push(bag[i]);
    if (rest.length) bag = rest;
    if (!bag.length) return null;
    var total = 0;
    for (var j = 0; j < bag.length; j++) total += bag[j].weight;
    var r = Math.random() * total;
    for (var k = 0; k < bag.length; k++) {
      r -= bag[k].weight;
      if (r < 0) return bag[k].name;
    }
    return bag[bag.length - 1].name;
  }

  // The next scene's name, by context, else `prefer` (chosen ahead) when it
  // may still come now, else at random, not from the last scene's family.
  function choose(prefer) {
    var h = hourNow();
    var night = isNight(h);
    lookForReactions(night);
    if (!night && pending) {
      var p = pending;
      pending = null;
      return p;
    }
    var bag = bagFor(h);
    if (prefer) {
      for (var i = 0; i < bag.length; i++) if (bag[i].name === prefer) return prefer;
    }
    return pick(bag);
  }

  /* ---------- scheduling ---------- */

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function idleMs() { return settings.idleAfter * 1000; }

  // idleAfter plus a short random wait.
  function afterQuiet(t) { return t + idleMs() * between(1.1, 1.3) + between(1000, 4000); }

  function nextAt() { return Math.max(readyAt, due); }

  function arm() {
    stopTimer();
    if (!settings || scene) return;
    timer = setTimeout(wake, Math.max(250, nextAt() - now()));
  }

  function wake() {
    timer = null;
    try {
      if (!settings || scene) return;
      var t = now();
      if (!quiet()) {
        // A panel or the dashboard is open, or the page is hidden: idle starts again after it.
        readyAt = afterQuiet(t);
        timer = setTimeout(wake, CHECK_MS);
        return;
      }
      if (t < nextAt()) return arm();
      var was = ahead;
      ahead = null;
      if (aheadTimer) { clearTimeout(aheadTimer); aheadTimer = null; }
      var name = choose(was ? was.name : null);
      if (!name) { due = t + settings.every[0] * 1000; return arm(); }
      begin(name, { seed: was && was.name === name ? was.seed : Math.floor(Math.random() * 1e9) });
    } catch (e) {
      fail('error in the scheduler: ' + errText(e));
      due = now() + settings.every[1] * 1000;
      arm();
    }
  }

  /* ---------- hooks from hub.js ---------- */

  // Any key or click: gone at once, and idle starts over.
  function input() {
    if (!settings) return;
    if (scene) end('interrupted');
    readyAt = afterQuiet(now());
    arm();
  }

  // A panel or the dashboard is opening, or the layout changed.
  function interrupt() {
    if (!settings) return;
    if (scene) end('interrupted');
    readyAt = Math.max(readyAt, afterQuiet(now()));
    arm();
  }

  function onVisibility() {
    try {
      if (isHidden()) { if (scene) end('interrupted'); return; }
      readyAt = Math.max(readyAt, afterQuiet(now()));
      arm();
    } catch (e) { /* ignore */ }
  }

  function start(h) {
    started = true;
    host = h || null;
    settings = readSettings(host ? host.config : undefined);
    if (!settings) return;
    readyAt = afterQuiet(now());
    due = 0;
    try { document.addEventListener('visibilitychange', onVisibility); } catch (e) { /* ignore */ }
    // The baseline for "a to-do item was done since the last scene".
    lookForReactions(true);
    pending = null;
    arm();
  }


  /* ---------- the scenes ---------- */

  // The helper a scene builds with. o: the options from play(), for tests.
  function stage(o, rnd) {
    var m = measure();
    var S = {
      W: m.W, H: m.H, k: m.k,
      floor: m.floor,
      ledges: m.ledges,
      hour: hourNow(),
      o: o,
      actors: [],
      rand: function (a, b) { return a + rnd() * (b - a); },
      chance: function (p) { return rnd() < p; },
      pick: function (list) { return list[Math.floor(rnd() * list.length) % list.length]; },
      seq: function (name) { return M.sequences[name].slice(); },
      sprite: function (key) { return M.sprites[key]; },
      actor: function (name, kind, opts) {
        var a = new Actor(name, kind, opts);
        S.actors.push(a);
        return a;
      }
    };
    S.dir = o.dir === 'left' || o.dir === 'right' ? o.dir : (rnd() < 0.5 ? 'right' : 'left');
    S.sgn = S.dir === 'right' ? 1 : -1;
    S.back = S.dir === 'right' ? 'left' : 'right';
    // x a fraction f of the way across, in the direction of travel.
    S.across = function (f) { return S.dir === 'right' ? f * S.W : (1 - f) * S.W; };
    S.start = S.dir === 'right' ? -EDGE : S.W + EDGE;
    S.end = S.dir === 'right' ? S.W + EDGE : -EDGE;
    return S;
  }

  // Gaits. seq names a sequence in the sprite list (CLAY_SPRITES.sequences,
  // any number of pictures in loop order); keys are the pictures to use when
  // the list has no such sequence. step is px a tick; stride is px for one
  // whole round of the pictures (CLAY_SPRITES.strides[seq] when the list
  // has it), which keeps today's cadence with two pictures; dy is the bob
  // over one round. New, longer cycles drop in through the sprite list with
  // no change here.
  var IAN_WALK = { seq: 'ian.walk', keys: ['ian/walk-1', 'ian/walk-2'], step: 18, stride: 72, dy: [0, -1, 0, -1] };
  var IAN_RUN = { seq: 'ian.run', keys: ['ian/run-1', 'ian/run-2'], step: 34, stride: 68, dy: [-8, 0] };
  var EMBER_TROT = { seq: 'ember.trot', keys: ['ember/trot-1', 'ember/trot-2'], step: 18, stride: 72, dy: [0, 0, -2, -2] };
  var EMBER_RUN = { seq: 'ember.run', keys: ['ember/run-1', 'ember/run-2'], step: 44, stride: 88, dy: [-10, -2] };
  // Zoomies: her wild sprint picture between the two run pictures; once the
  // list has a longer run cycle (over two pictures), that instead.
  var EMBER_ZOOM = { seq: 'ember.zoomies', longer: 'ember.run', keys: ['ember/zoomies', 'ember/run-1', 'ember/run-2'], step: 50, stride: 150, dy: [-3, -10, -2] };
  // Ember carrying the ball or the sock: a cycle when the list has one, else
  // the one picture slid along (kept short; see docs/clay.md). Optional:
  // a scene that would go over MAX_FRAMES with them is built without.
  var BALL_TROT = { seq: 'ember.ball-trot', keys: ['ember/stand-ball'], step: 18, stride: 72, dy: [0, -6, -3, 0], optional: true };
  // Ember galloping with the ball: the sock-run recipe with the ball.
  var BALL_RUN = { seq: 'ember.ball-run', keys: ['ember/stand-ball'], step: 46, stride: 138, dy: [0, -10, -4], optional: true };
  var SOCK_RUN = { seq: 'ember.sock-run', keys: ['ember/sock-run'], step: 46, stride: 138, dy: [0, -10, -4], optional: true };
  var plainExtras = false;     // while building: leave the optional cycles out
  var trimmed = false;         // while building: leave a scene's small touches out

  // The sequence a gait takes its pictures from: its own, or (zoomies) a
  // longer cycle of another; null for its own fallback pictures.
  function gaitSeq(g) {
    var Q = M && M.sequences ? M.sequences : {};
    if (g.optional && plainExtras) return null;
    if (g.seq && Q[g.seq] && Q[g.seq].length) return g.seq;
    if (g.longer && Q[g.longer] && Q[g.longer].length > 2) return g.longer;
    return null;
  }

  function gaitKeys(g) {
    var q = gaitSeq(g);
    return q ? M.sequences[q].slice() : g.keys.slice();
  }

  function gaitStride(g) {
    var q = gaitSeq(g);
    var s = q && M.strides ? M.strides[q] : null;
    if (typeof s === 'number' && s > 0) return s;
    return q === g.longer && q === EMBER_RUN.seq ? EMBER_RUN.stride : g.stride;
  }

  // Where each picture of a sequence starts, as a share of its stride, from
  // CLAY_SPRITES.shares[seq] (each picture's share; they need not add up to
  // exactly 1, they are scaled to). null for even spacing, and when the list
  // doesn't match the sequence.
  function gaitCuts(q, n) {
    var s = q && M.shares ? M.shares[q] : null;
    if (!s || !s.length || s.length !== n) return null;
    var sum = 0;
    for (var i = 0; i < n; i++) {
      if (typeof s[i] !== 'number' || !(s[i] > 0)) return null;
      sum += s[i];
    }
    var cuts = [];
    var at = 0;
    for (var j = 0; j < n; j++) { cuts.push(at / sum); at += s[j]; }
    return cuts;
  }

  // Whether any picture of a gait has a lift: then the pictures carry the
  // bounce themselves, and the hand-made bob (dy) is left out.
  function gaitLifts(keys) {
    for (var i = 0; i < keys.length; i++) if (liftOf(keys[i])) return true;
    return false;
  }

  // Ian coming to a stop out of a walk and standing for `ticks`: when the
  // sprite list has him standing side-on (ian/stand-side), the first two of
  // those ticks show that, so he doesn't turn to the front mid-stride. The
  // same length either way.
  function halt(ian, ticks) {
    if (M.sprites['ian/stand-side'] && ticks > 2) ian.pose('ian/stand-side', 2).pose('ian/stand', ticks - 2);
    else ian.pose('ian/stand', ticks);
    return ian;
  }

  // Walk with a gait to x. o: { step, ease } (see Actor.walk).
  function go(a, gait, to, o) {
    o = o || {};
    var keys = gaitKeys(gait);
    return a.walk(keys, to, o.step || gait.step, 1, {
      dy: gaitLifts(keys) ? null : gait.dy,
      stride: gaitStride(gait),
      cuts: gaitCuts(gaitSeq(gait), keys.length),
      ease: o.ease
    });
  }

  var SCENES = {};

  // 1. Ian walks in with Ember behind; he waves, then looks at his phone.
  // Ember gets bored and rolls over; he laughs and gives her a belly rub;
  // they walk on and out the far side.
  SCENES.stroll = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    // In the picture he kneels on the left and she lies on the right; here
    // she is behind him (towards where they came from).
    var duo = S.actor('duo', 'duo', { shadow: 130, mirror: S.dir === 'right' });
    var mid = S.across(S.rand(0.42, 0.54));
    var ex = mid - S.sgn * 112;
    halt(go(ian.at(S.start, F).face(S.dir), IAN_WALK, mid), 3)
      .cycle(['ian/stand-wave', 'ian/stand'], 12, 3)
      .pose('ian/stand-wave', 4)
      .pose('ian/stand', 4)
      .signal('phone')
      .pose('ian/stand-phone', 24)
      .after('bored')
      .pose('ian/stand-phone', 3)
      .pose('ian/laugh', 12)
      .signal('rub')
      .hide()
      .after('rubbed')
      .at(mid, F)
      .face(S.dir)
      .pose('ian/stand', 4)
      .signal('go');
    go(ian, IAN_WALK, S.end).hide();
    go(ember.at(S.start - S.sgn * 130, F).face(S.dir), EMBER_TROT, ex)
      .pose('ember/stand-2', 3)
      .cycle(['ember/stand-wag', 'ember/stand-wag', 'ember/stand-2'], 15, 3)
      .pose('ember/sit-side', 0)
      .after('phone')
      .pose('ember/sit-side', 10)
      .pose('ember/stand-look', 8)
      .pose('ember/down', 6)
      .pose('ember/roll', 3)
      .pose('ember/belly', 8)
      .signal('bored')
      .pose('ember/belly', 0)
      .after('rub')
      .hide()
      .after('rubbed')
      .at(ex, F)
      .face(S.dir)
      .pose('ember/stand-2', 0)
      .after('go')
      .wait(3);
    go(ember, EMBER_TROT, S.end + S.sgn * 40).hide();
    duo.after('rub').at((mid + ex) / 2, F).pose('duo/belly-rub', 28).hide().signal('rubbed');
  };

  // (A swap to a picture of the two: the actor that comes first gives the
  // signal, so both hide in the very tick the duo shows; never three at once.)

  // 2. Fetch. Ian fakes a throw and Ember falls for it; he laughs. Then a
  // real throw: she runs, leaps and catches the ball at the top of her jump
  // and trots it back, but lies down guarding it until he calls her. A high
  // five and a hug, and they go back the way they came.
  SCENES.fetch = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    // In both pictures he is on the left and she on the right; here she is
    // on his far side (the way they travel).
    var duo = S.actor('duo', 'duo', { shadow: 120, mirror: S.dir === 'left' });
    var ball = S.actor('ball', 'prop', { shadow: 18, scale: 1.6 });
    // The heart over the hug is a trimming: left out when the pictures would
    // go over MAX_FRAMES with her ball-carrying trot (see build()).
    var heart = trimmed ? null : S.actor('heart', 'prop', { scale: 1.5 });
    var ianX = S.across(S.rand(0.14, 0.2));
    var emberWait = ianX + S.sgn * 125;
    var fakeTo = emberWait + S.sgn * 190;
    var catchX = S.across(S.rand(0.5, 0.58));
    var runTo = catchX - S.sgn * 14;
    var runTicks = walkTicks(emberWait, runTo, EMBER_RUN.step, true, false);
    var flight = runTicks + 4;           // she crouches, runs, crouches again, rises two
    var apex = F - 70;                   // the bottom of her paws at the top of the jump
    var land = runTo + S.sgn * 28;
    var meet = ianX + S.sgn * 150;       // he walks up to meet her on the way back
    var rise = 17.5;                     // half a parabola: level at the top (70 / 4)

    go(ian.at(S.start, F).face(S.dir), IAN_WALK, ianX)
      .pose('ian/stand', 0)
      .after('here')
      .pose('ian/stand', 3)
      .pose('ian/throw-1', 6)
      .signal('fake')
      .pose('ian/throw-1', 5)
      .pose('ian/stand', 0)
      .after('fooled')
      .pose('ian/laugh', 12)
      .pose('ian/stand', 2)
      .signal('ready')
      .after('again')
      .pose('ian/throw-1', 5)
      .signal('throw')
      .pose('ian/throw-2', 6)
      .pose('ian/stand', 0)
      .after('caught')
      .wait(8);
    go(ian, IAN_WALK, meet)
      .pose('ian/stand', 0)
      .after('back')
      .pose('ian/stand', 4)
      .pose('ian/call', 8)
      .signal('call')
      .pose('ian/call', 4)
      .after('near')
      .signal('swap')
      .hide()
      .after('fived')
      .at(meet, F)
      .pose('ian/stand', 3);
    go(ian, IAN_WALK, S.start).hide();

    go(ember.at(S.start - S.sgn * 130, F).face(S.dir), EMBER_TROT, emberWait)
      .signal('here')
      .pose('ember/stand-2', 0)
      .after('fake')
      .pose('ember/jump-crouch', 1);
    go(ember, EMBER_RUN, fakeTo, { ease: 'in' })
      .move(S.sgn * 16, 0, 1, { key: 'ember/skid' })
      .move(S.sgn * 6, 0, 2, { key: 'ember/skid' })
      .pose('ember/stand-tilt', 10)
      .signal('fooled');
    go(ember, EMBER_TROT, emberWait)
      .face(S.dir)
      .pose('ember/stand-2', 0)
      .after('ready')
      .wait(4)
      .signal('again')
      .after('throw')
      .pose('ember/jump-crouch', 1);
    go(ember, EMBER_RUN, runTo, { ease: 'in' })
      .pose('ember/jump-crouch', 1)
      .arc(['ember/jump-catch'], runTo + S.sgn * 14, apex, rise, 2)
      .signal('caught')
      .arc(['ember/jump-catch'], land, F, rise, 2)
      .pose('ember/stand-ball', 5)
      .face(S.back)
      .pose('ember/stand-ball', 2);
    go(ember, BALL_TROT, meet + S.sgn * 120)
      .pose('ember/stand-ball', 3)
      .signal('back')
      .pose('ember/ball-down', 0)
      .after('call')
      .pose('ember/ball-down', 3)
      .pose('ember/stand-ball', 3);
    go(ember, BALL_TROT, meet + S.sgn * 70)
      .signal('near')
      .pose('ember/stand-ball', 0)
      .after('swap')
      .hide()
      .after('fived')
      .at(meet + S.sgn * 70, F)
      .pose('ember/stand-2', 3);
    go(ember, EMBER_TROT, S.start - S.sgn * 60).hide();

    // The high five, then a hug, between where they stand.
    var duoX = meet + S.sgn * 34;
    duo.after('swap').at(duoX, F).pose('duo/high-five', 14).pose('duo/hug', 20).hide().signal('fived');
    if (heart) heart.after('swap').wait(16).at(duoX + S.sgn * 6, F - 150).pose('props/heart', 2).move(0, -4, 6, { key: 'props/heart' }).hide();

    // The ball: from Ian's hand at the end of the throw, along an arc that
    // ends in Ember's open mouth at the top of her jump, then down with her.
    var handX = ianX + S.sgn * 36;
    var mouthX = runTo + S.sgn * (14 + 18);
    ball.after('throw')
      .at(handX, F - 118)
      .ground(F)
      .arc(['props/ball'], mouthX, apex - 104, Math.min(380, 160 + flight * 14), flight)
      .arc(['props/ball'], land + S.sgn * 18, F - 104, rise, 2)
      .hide();
  };

  // 3. Ember finds a sock and Ian creeps up on her, but she bolts with it.
  // He runs after her, skids and facepalms; she trots back to tease him, a
  // tug of war, and she wins and runs off again. He laughs and follows.
  SCENES['sock-heist'] = function (S) {
    var F = S.floor;
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var ian = S.actor('ian', 'char', { shadow: 62 });
    // In the picture he pulls from the left, she from the right; here he is behind her.
    var duo = S.actor('duo', 'duo', { shadow: 150, mirror: S.dir === 'left' });
    var sock = S.actor('sock', 'prop');
    var bang = S.actor('bang', 'prop', { scale: 1.4 });
    var sockX = S.across(S.rand(0.3, 0.36));
    var skidX = S.across(S.rand(0.6, 0.66));
    var sniffX = sockX - S.sgn * 52;
    var teaseX = skidX + S.sgn * 136;
    sock.at(sockX, F - 2).face(S.dir).pose('props/sock', 0).after('found').hide();
    go(ember.at(S.start, F).face(S.dir), EMBER_TROT, sniffX - S.sgn * 30)
      .pose('ember/sniff', 8)
      .move(S.sgn * 15, 0, 2, { key: 'ember/sniff' })
      .pose('ember/sniff', 6)
      .signal('found')
      .pose('ember/sock-proud', 10)
      .signal('heist')
      .pose('ember/sock-proud', 0)
      .after('seen')
      .wait(3);
    go(ember, SOCK_RUN, S.end + S.sgn * 80, { ease: 'in' })
      .after('sulk')
      .wait(2);
    go(ember, SOCK_RUN, teaseX, { step: 36 })
      .pose('ember/sock-proud', 6)
      .signal('tease')
      .pose('ember/sock-proud', 0)
      .after('lunge')
      .signal('grab')
      .hide()
      .after('tugged')
      .at(teaseX, F)
      .face(S.dir)
      .pose('ember/sock-proud', 2);
    go(ember, SOCK_RUN, S.end + S.sgn * 80, { ease: 'in' }).hide();
    bang.after('seen').at(sniffX + S.sgn * 10, F - 116).pose('props/bang', 6).hide();
    // He creeps in: a slow walk, a "shh" to us, then on, slower still.
    ian.after('heist').at(S.start, F).face(S.dir);
    go(ian, IAN_WALK, S.across(0.08), { step: 14 })
      .pose('ian/sneak', 8);
    go(ian, IAN_WALK, sockX - S.sgn * 200, { step: 11 })
      .pose('ian/sneak', 3)
      .signal('seen')
      .pose('ian/stand', 3);
    go(ian, IAN_RUN, skidX, { ease: 'in' })
      .move(S.sgn * 18, 0, 2, { key: 'ian/skid' })
      .move(S.sgn * 7, 0, 2, { key: 'ian/skid' })
      .pose('ian/skid', 3)
      .pose('ian/stand', 2)
      .pose('ian/facepalm', 14)
      .pose('ian/stand', 2)
      .signal('sulk')
      .pose('ian/stand', 0)
      .after('tease')
      .face(S.dir)
      .pose('ian/point', 8)
      .signal('lunge')
      .pose('ian/point', 0)
      .after('grab')
      .hide()
      .after('tugged')
      .at(skidX + S.sgn * 50, F)
      .pose('ian/stand', 2)
      .pose('ian/laugh', 12)
      .pose('ian/stand', 2)
      .face(S.dir);
    go(ian, IAN_RUN, S.end, { ease: 'in' }).hide();
    duo.after('grab').at(skidX + S.sgn * 68, F)
      .cycle(['duo/tug'], 20, 1, { dx: [0, -2, -4, -2, 0, 2, 4, 2] })
      .hide()
      .signal('tugged');
  };

  // 4. Ember alone: flat out across the floor, a skid, a play bow and a
  // bark; back the other way, a spin and a pounce, a roll on her back, a
  // shake, and off.
  SCENES.zoomies = function (S) {
    var F = S.floor;
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var turn = S.across(S.rand(0.72, 0.8));
    var back = S.across(S.rand(0.3, 0.38));
    go(ember.at(S.start, F).face(S.dir), EMBER_ZOOM, turn, { ease: 'in' })
      .move(S.sgn * 20, 0, 1, { key: 'ember/skid' })
      .move(S.sgn * 8, 0, 2, { key: 'ember/skid' })
      .face(S.back)
      .pose('ember/bow', 6)
      .pose('ember/stand-bark', 3)
      .pose('ember/bow', 3)
      .pose('ember/stand-bark', 3)
      .pose('ember/bow', 4);
    go(ember, EMBER_ZOOM, back, { ease: 'in' })
      .move(-S.sgn * 20, 0, 1, { key: 'ember/skid' })
      .move(-S.sgn * 8, 0, 2, { key: 'ember/skid' })
      .cycle(['ember/spin'], 8, 1, { dy: [0, -6, -8, -4] })
      .pose('ember/pounce', 4)
      .pose('ember/down', 4)
      .pose('ember/roll', 3)
      .pose('ember/belly', 10)
      .pose('ember/roll', 3)
      .pose('ember/down', 3)
      .pose('ember/stand-2', 2)
      .pose('ember/shake', 6)
      .pose('ember/stand-2', 3);
    go(ember, EMBER_ZOOM, S.start - S.sgn * 40, { ease: 'in' }).hide();
  };

  // Both new fetches start the same way as `fetch`: Ember bounds in, Ian
  // walks in, a real throw, she gallops after the ball and picks it up.
  function fetchStart(S, ian, ember, ball, landF) {
    var F = S.floor;
    var ianX = S.across(S.rand(0.16, 0.22));
    var emberWait = ianX + S.sgn * 125;
    var landX = S.across(landF);
    var runTo = landX - S.sgn * 34;
    var runTicks = walkTicks(emberWait, runTo, EMBER_RUN.step, true, false);
    go(ian.at(S.start, F).face(S.dir), IAN_WALK, ianX)
      .pose('ian/stand', 0)
      .after('here')
      .pose('ian/stand', 3)
      .pose('ian/throw-1', 6)
      .signal('throw')
      .pose('ian/throw-2', 6)
      .pose('ian/stand', 0);
    go(ember.at(S.start - S.sgn * 130, F).face(S.dir), EMBER_RUN, emberWait, { ease: 'out' })
      .signal('here')
      .pose('ember/stand-2', 0)
      .after('throw')
      .pose('ember/jump-crouch', 1);
    go(ember, EMBER_RUN, runTo, { ease: 'in' })
      .move(S.sgn * 16, 0, 1, { key: 'ember/skid' })
      .move(S.sgn * 6, 0, 2, { key: 'ember/skid' })
      .pose('ember/stand-2', 2)
      .signal('pick')
      .pose('ember/stand-ball', 3);
    ball.after('throw')
      .at(ianX + S.sgn * 36, F - 118)
      .ground(F)
      .arc(['props/ball'], landX, F - 4, Math.min(380, 160 + runTicks * 14), runTicks + 1)
      .pose('props/ball', 0)
      .after('pick')
      .hide();
    return { ianX: ianX, landX: landX, runTo: runTo };
  }

  // 2b. Where'd she go? Ember catches the ball and bolts the other way, past
  // Ian and off the screen. He turns to peer after her; she comes back from
  // the far side, tiptoes up behind him, drops the ball at his heels and
  // barks. He yelps; then he laughs, points, and she snatches it up and
  // is off again, with him walking after.
  SCENES['fetch-bolt'] = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var ball = S.actor('ball', 'prop', { shadow: 18, scale: 1.6 });
    var bang = S.actor('bang', 'prop', { scale: 1.4 });
    var P = fetchStart(S, ian, ember, ball, S.rand(0.72, 0.8));
    var nearX = P.ianX + S.sgn * 100;
    var dropX = nearX - S.sgn * 38;      // her mouth, facing him
    // Ian watches her run past, searches for her, shrugs, searches again.
    ian.after('pick')
      .pose('ian/stand', 8)
      .signal('bolted')
      .face(S.back)
      .pose('ian/search', 8)
      .pose('ian/stand-shrug', 8)
      .face(S.back)
      .pose('ian/search', 0)
      .after('bark')
      .pose('ian/startled', 4)
      .face(S.dir)
      .pose('ian/stand', 3)
      .pose('ian/laugh', 12)
      .pose('ian/stand', 2)
      .pose('ian/point', 8)
      .signal('point')
      .pose('ian/point', 0)
      .after('snatch');
    go(ian, IAN_WALK, S.end).hide();
    // She bolts with the ball: past him and off the far edge, then round.
    go(ember, BALL_RUN, S.start - S.sgn * 140, { ease: 'in' })
      .face(S.back)
      .signal('gone')
      .wait(6)
      .at(S.end + S.sgn * 70, F)
      .face(S.back);
    go(ember, BALL_TROT, nearX + S.sgn * 300, { step: 40, ease: 'none' });
    go(ember, BALL_TROT, nearX, { step: 12, ease: 'out' })
      .pose('ember/stand-ball', 4)
      .pose('ember/stand-bark', 2)
      .signal('bark')
      .pose('ember/stand-bark', 4)
      .pose('ember/stand-2', 0)
      .after('point')
      .pose('ember/stand-ball', 1)
      .signal('snatch');
    go(ember, BALL_RUN, S.end + S.sgn * 120, { ease: 'in' }).hide();
    // Dropped at his heels, behind him.
    ball.after('bark')
      .at(dropX, F - 56)
      .ground(F)
      .arc(['props/ball'], dropX - S.sgn * 10, F - 4, 14, 2)
      .pose('props/ball', 0)
      .after('snatch')
      .hide();
    bang.after('bark').at(P.ianX, F - 196).pose('props/bang', 6).hide();
  };

  // 2c. The snub. Ember catches the ball, trots most of the way back, drops
  // it, looks the other way and slowly walks off. Ian throws up his hands
  // ("What??"), goes over, picks the ball up himself and sits on the floor
  // with it, sulking. She looks back over her shoulder; he poofs away.
  SCENES['fetch-snub'] = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var ball = S.actor('ball', 'prop', { shadow: 18, scale: 1.6 });
    var bang = S.actor('bang', 'prop', { scale: 1.4 });
    var poof = S.actor('poof', 'prop', { scale: 3 });
    var P = fetchStart(S, ian, ember, ball, S.rand(0.7, 0.76));
    var dropX = S.across(S.rand(0.5, 0.54));
    var mouthX = dropX + S.sgn * 30;     // she faces back toward him
    var sitX = dropX - S.sgn * 36;
    go(ember, BALL_TROT, dropX)
      .pose('ember/stand-ball', 3)
      .signal('drop')
      .pose('ember/stand-2', 6)
      .pose('ember/stand-look', 8)
      .signal('snub');
    go(ember, EMBER_TROT, S.across(0.8), { step: 8 })
      .pose('ember/stand-look', 0)
      .after('sat')
      .pose('ember/stand-look', 8);
    go(ember, EMBER_TROT, S.end + S.sgn * 80, { step: 12 }).hide();
    // The drop: out of her mouth to the floor (after the ball hid in her mouth, on 'pick').
    ball.after('drop')
      .at(mouthX, F - 56)
      .ground(F)
      .arc(['props/ball'], mouthX + S.sgn * 8, F - 4, 12, 2)
      .pose('props/ball', 0)
      .after('lifted')
      .hide()
      .after('sat')
      .at(sitX + S.sgn * 4, F - 18)
      .pose('props/ball', 0)
      .after('bye')
      .hide();
    ian.after('snub')
      .face(S.dir)
      .pose('ian/stand', 2)
      .pose('ian/hands-up', 12)
      .signal('what')
      .pose('ian/stand-shrug', 6);
    go(ian, IAN_WALK, sitX - S.sgn * 40)
      .face(S.dir)
      .pose('ian/pick-up', 5)
      .signal('lifted')
      .signal('down')
      .at(sitX, F)
      .face('right')
      .pose('ian/sit-ball', 6)
      .signal('sat')
      .pose('ian/sit-ball', 40)
      .signal('bye')
      .hide();
    bang.after('what').at(P.ianX, F - 190).pose('props/bang', 6).hide();
    poof.after('bye').at(sitX, F - 8).pose('props/poof', 3).hide();
  };

  // Where a perch pose's bottom goes, against the ledge's y (by eye, from the sprites).
  var PERCH = {
    'sit-edge': 52,     // hands on the edge, legs dangling down the tile
    'lie-chin': 2,      // lying along the top edge
    hang: 163,          // hands curled over the edge, hanging down the tile
    climb: 130,         // forearms on top of the edge
    stand: 3,           // standing on top of the tile
    laptop: 3           // sitting cross-legged on top of the tile
  };

  // 5. Ian poofs onto a ledge (sitting on the edge, lying on his elbows, or
  // hanging and climbing up) and makes himself at home there: he stands
  // and waves, gets out his laptop, sits or lies about; then poofs away.
  SCENES.perch = function (S) {
    var room = [];
    for (var i = 0; i < S.ledges.length; i++) if (S.ledges[i].width >= 220) room.push(S.ledges[i]);
    if (!room.length) return false;
    var L = S.o.ledge !== undefined && room[S.o.ledge % room.length] ? room[S.o.ledge % room.length] : S.pick(room);
    var x = Math.round(S.rand(L.left + 90, L.right - 90));
    var y = L.y;
    var how = S.o.pose && (S.o.pose === 'sit-edge' || S.o.pose === 'lie-chin' || S.o.pose === 'climb') ? S.o.pose :
      S.pick(['sit-edge', 'sit-edge', 'lie-chin', 'climb']);
    var ian = S.actor('ian', 'char');
    var poof = S.actor('poof', 'prop', { scale: 3 });
    var k = S.rand(0.9, 1.1);            // a little longer or shorter each time
    function t(n) { return Math.round(n * k); }
    var inward = x < S.W / 2 ? 'right' : 'left';
    var cloudY = how === 'lie-chin' ? y + 14 : how === 'climb' ? y + 70 : y + 40;
    poof.at(x, cloudY).pose('props/poof', 3).hide().after('bye').at(x, y + 20).pose('props/poof', 3).hide();
    function stand() {
      ian.at(x, y + PERCH.stand).pose('ian/stand', 3)
        .cycle(['ian/stand-wave', 'ian/stand'], 12, 3)
        .pose('ian/stand', 3);
    }
    function sit(n) { ian.at(x, y + PERCH['sit-edge']).pose('ian/sit-edge', t(n)); }
    function laptop(n) { ian.at(x, y + PERCH.laptop).pose('ian/laptop', t(n)); }
    function lie(n) { ian.at(x, y + PERCH['lie-chin']).face(inward).pose('ian/lie-chin', t(n)); }
    ian.wait(1);
    if (how === 'climb') {
      ian.at(x, y + PERCH.hang)
        .cycle(['ian/hang'], 14, 1, { dx: [0, 0, 0, -2, 0, 2] })
        .at(x, y + PERCH.climb)
        .pose('ian/climb', 6);
      sit(40);
      stand();
      laptop(50);
      lie(28);
    } else if (how === 'lie-chin') {
      lie(44);
      stand();
      sit(40);
      laptop(46);
    } else {
      sit(44);
      stand();
      laptop(50);
      lie(36);
    }
    ian.at(x, y + PERCH.stand).pose('ian/stand', 3).signal('bye').wait(1).hide();
  };

  // A walk in, a few beats in the middle, and back out the way they came
  // (the nearer edge). Used by the evening and reaction scenes:
  // middle(ian, ember, x, emberX).
  function visit(S, opts, middle) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = opts.ember === false ? null : S.actor('ember', 'char', { shadow: 76 });
    var x = S.across(opts.at || S.rand(0.3, 0.45));
    var ex = x - S.sgn * (opts.gap || 110);
    go(ian.at(S.start, F).face(S.dir), IAN_WALK, x);
    if (ember) go(ember.at(S.start - S.sgn * 150, F).face(S.dir), EMBER_TROT, ex).signal('here');
    middle(ian, ember, x, ex);
    ian.signal('leave');
    go(ian, IAN_WALK, S.start - S.sgn * 30);
    ian.hide();
    if (ember) {
      ember.after('leave');
      go(ember, EMBER_TROT, S.start).hide();
    }
    return { ian: ian, ember: ember };
  }

  // 6a. Morning (6 to 10): Ian with his coffee and a big stretch; he puts
  // Ember's breakfast down and she eats; he checks his phone, sees the
  // time and runs off, late, with Ember after him.
  SCENES.morning = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var bowl = S.actor('bowl', 'prop', { scale: 1.5, shadow: 40 });
    var x = S.across(S.rand(0.3, 0.4));
    var ex = x - S.sgn * 130;
    go(ian.at(S.start, F).face(S.dir), IAN_WALK, x)
      .pose('ian/stand', 2)
      .pose('ian/stand-coffee', 20)
      .pose('ian/yawn', 14)
      .pose('ian/stand-coffee', 12)
      .face(S.back)
      .pose('ian/kneel-pet', 6)
      .signal('bowl')
      .pose('ian/kneel-pet', 6)
      .pose('ian/stand', 2)
      .pose('ian/stand-coffee', 0)
      .after('fed')
      .pose('ian/stand-coffee', 4)
      .pose('ian/stand-phone', 14)
      .pose('ian/late', 12)
      .signal('late')
      .face(S.dir);
    go(ian, IAN_RUN, S.end, { ease: 'in' }).hide();
    go(ember.at(S.start - S.sgn * 150, F).face(S.dir), EMBER_TROT, ex)
      .pose('ember/sit-side', 12)
      .pose('ember/scratch', 14)
      .pose('ember/sit-side', 0)
      .after('bowl')
      .wait(3)
      .pose('ember/stand-2', 3)
      .pose('ember/sniff', 30)
      .pose('ember/lick', 8)
      .pose('ember/sit', 4)
      .signal('fed')
      .pose('ember/sit', 0)
      .after('late')
      .wait(4)
      .face(S.dir)
      .pose('ember/stand-2', 2);
    // A quick trot after him (a run cycle too would make this scene the
    // biggest to load once the cycles are longer).
    go(ember, EMBER_TROT, S.end + S.sgn * 60, { step: 30, ease: 'in' }).hide();
    // The bowl appears in front of her nose as he puts it down; it fades
    // once they have gone.
    bowl.after('bowl').at(ex + S.sgn * 48, F).fade(0)
      .move(0, 0, 3, { key: 'props/bowl', fade: [0.35, 0.7, 1] })
      .after('late').wait(20)
      .move(0, 0, 4, { key: 'props/bowl', fade: [0.75, 0.5, 0.25, 0] })
      .hide();
  };

  // 6b. Evening (19 to 22): Ian dances to music, Ember howls along; then the
  // two sit on the floor watching; then popcorn, Ember begs and waits for a
  // piece to fall; a yawn, and home.
  SCENES.evening = function (S) {
    var F = S.floor;
    var duo = S.actor('duo', 'duo', { shadow: 110, mirror: S.dir === 'right' });
    var notes = [S.actor('note0', 'prop', { scale: 1.6 }), S.actor('note1', 'prop', { scale: 1.6 })];
    var spot = S.rand(0.18, 0.26);
    var x = S.across(spot);
    visit(S, { at: spot, gap: 70 }, function (ian, ember, ix, ex) {
      ian.pose('ian/stand', 0).after('here').pose('ian/stand', 3)
        .signal('dance')
        .cycle(['ian/dance-1', 'ian/dance-2'], 30, 3, { dy: [0, -3, 0, 0, -3, 0] })
        .pose('ian/stand', 3)
        .signal('sit').hide().after('popcorn')
        .at(ix, F).pose('ian/popcorn', 30)
        .pose('ian/stand', 3)
        .pose('ian/yawn', 10)
        .pose('ian/stand', 3);
      ember.pose('ember/stand-2', 0).after('dance').wait(6)
        .face(S.dir)
        .pose('ember/howl', 16)
        .pose('ember/stand-2', 0)
        .after('sit').hide().after('popcorn')
        .at(ex, F).face(S.dir)
        .pose('ember/beg', 14)
        .pose('ember/look-up', 10)
        .pose('ember/sit-side', 0)
        .after('leave');
    });
    duo.after('sit').at((x + x - S.sgn * 70) / 2, F).pose('duo/movie', 70).hide().signal('popcorn');
    // Notes float up from the dancing, in turns.
    for (var i = 0; i < notes.length; i++) {
      notes[i].after('dance').wait(2 + i * 7);
      for (var r = 0; r < 2; r++) {
        notes[i].at(x + S.sgn * (i ? 30 : -24) + r * 8, F - 172 - i * 14).fade(1)
          .move(S.sgn * (i ? 2 : -1), -5, 7, { key: 'props/note', fade: [1, 1, 1, 0.8, 0.6, 0.4, 0.2] })
          .hide().wait(7);
      }
    }
  };

  // 6c. Night (22 to 6): Ember asleep in a bottom corner, Z's rising; sometimes Ian naps too.
  SCENES.night = function (S) {
    var F = S.floor;
    S.night = true;
    var left = S.dir === 'left';      // the corner they come from
    var edge = left ? -EDGE : S.W + EDGE;
    var inward = left ? 1 : -1;
    var ex = left ? 90 : S.W - 90;
    var nap = S.o.nap !== undefined ? !!S.o.nap : S.chance(0.4);
    var sleepTicks = Math.round(S.rand(230, 300));
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var ian = nap ? S.actor('ian', 'char', { shadow: 100 }) : null;
    var ix = ex + inward * 120;
    go(ember.at(edge, F).face(left ? 'right' : 'left'), EMBER_TROT, ex, { step: 10 })
      .pose('ember/sniff', 6)
      .face(left ? 'left' : 'right')
      .pose('ember/down', 12)
      .signal('asleep')
      .pose('ember/sleep', sleepTicks)
      .signal('wake')
      .pose('ember/down', 6)
      .pose('ember/bow', 6);
    go(ember, EMBER_TROT, edge, { step: 12 }).hide();
    if (ian) {
      ian.after('asleep').at(edge, F).face(left ? 'right' : 'left');
      go(ian, IAN_WALK, ix, { step: 12 })
        .pose('ian/stand', 2)
        .pose('ian/yawn', 10)
        .pose('ian/nap', sleepTicks - 60)
        .after('wake')
        .pose('ian/stand', 4);
      go(ian, IAN_WALK, edge, { step: 12 }).hide();
    }
    // Three Z's take turns rising from the sleepers and fading in steps.
    var fades = [1, 1, 1, 1, 1, 0.85, 0.7, 0.55, 0.4, 0.25];
    for (var z = 0; z < 3; z++) {
      var zed = S.actor('zed' + z, 'prop', { scale: 1.7 });
      zed.after('asleep').wait(8 + z * 12);
      var rounds = Math.floor((sleepTicks - 40 - z * 12) / 36);
      for (var r = 0; r < rounds; r++) {
        var fromIan = ian && r % 2 === 1;
        var zx = (fromIan ? ix + inward * 40 : ex + inward * 22) + (z - 1) * 6;
        var zy = fromIan ? F - 40 : F - 48;
        zed.at(zx, zy).fade(1).move(inward * 2, -6, fades.length, { key: 'props/zed', fade: fades }).hide().wait(26);
      }
    }
  };

  // 7. Weather: Ian walks in, and in a puff he is dressed for what the
  // Weather tile says now; Ember has her own take on it. Another puff, back
  // in his hoodie, a wave, and they walk on and out the far side.
  var OUTFITS = ['umbrella', 'sunny', 'cold', 'hot', 'windy'];
  // What Ember does meanwhile: [picture, ticks] in turn (about 9 s).
  var EMBER_WEATHER = {
    umbrella: [['ember/soggy', 18], ['ember/shake', 6], ['ember/sit', 6], ['ember/look-up', 16], ['ember/soggy', 18]],
    sunny: [['ember/stand-wag', 8], ['ember/belly', 20], ['ember/roll', 3], ['ember/belly', 12], ['ember/roll', 3], ['ember/stand-2', 8], ['ember/sit-side', 10]],
    cold: [['ember/stand-tilt', 10], ['ember/shake', 6], ['ember/sit', 10], ['ember/stand-tilt', 8], ['ember/stand-bark', 3], ['ember/stand-2', 4], ['ember/stand-bark', 3], ['ember/sit', 16]],
    hot: [['ember/stand-2', 8], ['ember/down', 30], ['ember/stand-2', 6], ['ember/sit-side', 20]],
    windy: [['ember/sit-side', 10], ['ember/stand-bark', 3], ['ember/stand-2', 3], ['ember/stand-bark', 3], ['ember/stand-look', 12], ['ember/stand-2', 6], ['ember/sit-side', 26]]
  };
  // How Ian holds the outfit pose: a shiver, a fanning bob, a buffeting.
  var IAN_WEATHER = {
    umbrella: {},
    sunny: {},
    cold: { dx: [-2, 2, -1, 2, -2, 1] },
    hot: { dy: [0, 0, 0, -1, -1, -1] },
    windy: { dx: [0, -2, 0, -1, 1] }
  };
  SCENES.weather = function (S) {
    var kind = OUTFITS.indexOf(S.o.outfit) >= 0 ? S.o.outfit : outfit();
    if (!kind) return false;
    var F = S.floor;
    var key = 'ian/' + kind;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var poof = S.actor('poof', 'prop', { scale: 3 });
    var x = S.across(S.rand(0.3, 0.4));
    var ex = x - S.sgn * 120;
    halt(go(ian.at(S.start, F).face(S.dir), IAN_WALK, x), 5)
      .signal('dress')
      .pose('ian/stand', 1)
      .cycle([key], 40, 1, IAN_WEATHER[kind])
      .pose(key, 0)
      .after('settled')
      .pose(key, 4)
      .signal('undress')
      .pose(key, 1)
      .pose('ian/stand', 3)
      .cycle(['ian/stand-wave', 'ian/stand'], 9, 3)
      .pose('ian/stand', 2)
      .signal('leave');
    go(ian, IAN_WALK, S.end).hide();
    go(ember.at(S.start - S.sgn * 150, F).face(S.dir), EMBER_TROT, ex)
      .pose('ember/stand-2', 0)
      .after('dress')
      .wait(3);
    var beats = EMBER_WEATHER[kind];
    for (var i = 0; i < beats.length; i++) ember.pose(beats[i][0], beats[i][1]);
    ember.signal('settled')
      .pose('ember/stand-2', 0)
      .after('leave')
      .wait(4);
    go(ember, EMBER_TROT, S.end + S.sgn * 40).hide();
    poof.after('dress').at(x, F - 10).pose('props/poof', 3).hide()
      .after('undress').at(x, F - 10).pose('props/poof', 3).hide();
    return true;
  };

  // 8a. A to-do item was ticked off since the last scene: Ian ticks his
  // clipboard, jumps for joy, stars pop.
  SCENES.cheer = function (S) {
    var F = S.floor;
    var stars = [S.actor('star0', 'prop', { scale: 1.6 }), S.actor('star1', 'prop', { scale: 1.6 }), S.actor('star2', 'prop', { scale: 1.6 })];
    var f = S.rand(0.27, 0.33);
    var x = S.across(f);
    visit(S, { at: f, ember: false }, function (ian) {
      ian.pose('ian/stand', 2)
        .pose('ian/checklist', 12)
        .signal('cheer')
        .cycle(['ian/cheer', 'ian/stand-proud'], 12, 3, { dy: [-14, -14, -14, 0, 0, 0] })
        .pose('ian/stand', 1)
        .arc(['ian/jump-tuck'], x, F, 44, 5)
        .pose('ian/stand-thumbs', 9)
        .pose('ian/stand', 2);
    });
    var spots = [[-46, F - 170], [42, F - 190], [-4, F - 214]];
    for (var i = 0; i < stars.length; i++) {
      stars[i].after('cheer').wait(i * 2 + 1)
        .at(x + spots[i][0], spots[i][1])
        .pose('props/star', 3).hide().wait(3)
        .at(x + spots[i][0] * 1.2, spots[i][1] - 10)
        .pose('props/star', 3).hide().wait(4)
        .at(x + spots[i][0] * 0.8, spots[i][1] - 30)
        .pose('props/star', 3).hide();
    }
  };

  // 8b. The Pi connection was lost: Ian shrugs, Ember tilts her head.
  SCENES.shrug = function (S) {
    visit(S, { gap: 90, at: S.rand(0.28, 0.36) }, function (ian, ember) {
      ian.pose('ian/stand', 3).pose('ian/stand-shrug', 18).pose('ian/stand', 6);
      ember.pose('ember/stand-tilt', 0).after('leave');
    });
  };

  // { actors, night, W, H, k }, or null when the scene doesn't fit here.
  // A scene too big for MAX_FRAMES is built again with less: first without
  // its trimmings (small touches like fetch's heart, see `trimmed`) so the
  // optional cycles (BALL_TROT, SOCK_RUN) can stay, then with the trimmings
  // but without those cycles, then without both.
  var LEANER = [[false, true], [true, false], [true, true]];

  function build(name, o) {
    try {
      return buildOnce(name, o);
    } catch (e) {
      if (!e.tooBig) throw e;
      for (var i = 0; i < LEANER.length; i++) {
        plainExtras = LEANER[i][0];
        trimmed = LEANER[i][1];
        try {
          return buildOnce(name, o);
        } catch (e2) {
          if (!e2.tooBig || i === LEANER.length - 1) throw e2;
        } finally {
          plainExtras = false;
          trimmed = false;
        }
      }
      return null;
    }
  }

  function buildOnce(name, o) {
    var fn = SCENES[name];
    if (!fn) throw new Error('no scene ' + name);
    var rnd = makeRandom(o.seed);
    var S = stage(o, rnd);
    if (fn(S) === false) return null;
    var props = 0;
    for (var i = 0; i < S.actors.length; i++) if (S.actors[i].kind === 'prop') props++;
    if (props > MAX_PROPS) throw new Error(name + ' has more than ' + MAX_PROPS + ' props');
    var frames = frameKeys(S.actors).length;
    if (frames > MAX_FRAMES) {
      var big = new Error(name + ' uses ' + frames + ' pictures, over ' + MAX_FRAMES);
      big.tooBig = true;
      throw big;
    }
    return { actors: S.actors, night: !!S.night || name === 'night', W: S.W, H: S.H, k: S.k };
  }

  /* ---------- status, for the About panel ---------- */

  // The words follow the hub's language (Spanish: app/i18n.js 'clay.*').
  function T(key, english, vars) {
    var L = window.HUB_I18N;
    if (L && typeof L.t === 'function') { try { return String(L.t(key, english, vars)); } catch (e) { /* English below */ } }
    return String(english).replace(/\{(\w+)\}/g, function (all, n) { return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all; });
  }

  function ago(t) {
    var s = Math.max(0, Math.round((now() - t) / 1000));
    if (s < 60) return T('clay.agoS', '{n} s ago', { n: s });
    var m = Math.floor(s / 60);
    if (m < 60) return T('clay.agoMin', '{n} min ago', { n: m });
    return T('clay.agoH', '{h} h {m} min ago', { h: Math.floor(m / 60), m: m % 60 });
  }

  function outcome(l) {
    var r = l.result;
    var word = r === 'done' ? T('clay.done', 'finished') :
      r === 'interrupted' ? T('clay.interrupted', 'interrupted') :
      r === 'stopped' ? T('clay.stopped', 'stopped') :
      r === 'failed: does not fit here' ? T('clay.noFit', 'did not fit') :
      r === 'error' ? T('clay.error', 'hit an error') :
      r.indexOf('slow:') === 0 ? T('clay.slow', 'too slow') : T('clay.failed', 'failed');
    return l.name + ' ' + word;
  }

  // "N s" up to 99 s, else "M min S s".
  function howLong(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return s <= 99 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }

  // What keeps the hub busy, in plain words.
  var BUSY = {
    panel: 'a page is open',
    frame: 'a page is open',
    switcher: 'the layout bar is open',
    typing: 'you are typing',
    moving: 'the hub is moving'
  };
  function busyWord(w) { return T('clay.busy.' + w, BUSY[w]); }

  function busyWhy() {
    try {
      var w = host && typeof host.busyWhy === 'function' ? host.busyWhy() : '';
      return BUSY.hasOwnProperty(w) ? busyWord(w) : '';
    } catch (e) { return ''; }
  }

  // Now: what they are doing, or what comes next.
  function nowText() {
    if (scene) {
      if (scene.phase === 'playing') return T('clay.onScreen', 'On screen now: {name}', { name: scene.name });
      var secs = Math.floor((now() - scene.t0) / 1000) + ' s';
      if (scene.step === 'frames' && lastLoad && lastLoad.name === scene.name && lastLoad.of !== undefined) {
        return T('clay.loadingFrames', 'Loading {name}, {got} of {of} frames, {secs}', { name: scene.name, got: lastLoad.got, of: lastLoad.of, secs: secs });
      }
      return T('clay.loadingStep', 'Loading {name} ({step}), {secs}', { name: scene.name, step: scene.step, secs: secs });
    }
    if (isHidden()) return T('clay.hidden', 'Waiting: page reports hidden');
    if (!hostQuiet()) {
      var why = busyWhy();
      return T('clay.busy', 'Waiting: hub busy') + (why ? ' (' + why + ')' : '');
    }
    return T('clay.dueBack', 'Due back in {t}', { t: howLong(nextAt() - now()) });
  }

  // "N ms" under a second, else "N.N s".
  function ms(v) { return v < 1000 ? v + ' ms' : (v / 1000).toFixed(1) + ' s'; }

  function overLimit() { return T('clay.over', ' (over {n} s)', { n: Math.round(loadMs / 1000) }); }

  // How the sprite list's last try went, or '' before the first.
  function spriteText() {
    if (spriteEvent === 'already there' && spriteMs === null) return T('clay.spriteIn', 'sprite list in');
    if (!spriteScript) return '';
    if (spriteMs === null) return T('clay.spriteNot', 'sprite list not in after {t}', { t: ms(now() - spriteStart) });
    var s = spriteHow === 'onerror' ? T('clay.spriteErr', 'sprite list onerror after {t}', { t: ms(spriteMs) }) : T('clay.sprite', 'sprite list {t}', { t: ms(spriteMs) });
    return spriteMs > loadMs ? s + overLimit() : s;
  }

  // How the last scene's frames came, or ''.
  function framesText(L) {
    if (!L || L.of === undefined) return '';
    var s = T('clay.frames', '{name} {got}/{of} frames', { name: L.name, got: L.got, of: L.of });
    if (L.ms !== null) return s + T('clay.framesIn', ' in {t}', { t: ms(L.ms) }) + (L.timedOut ? overLimit() : '') + (L.retried ? T('clay.retried', ' ({n} asked for again)', { n: L.retried }) : '');
    if (L.failed) return s + T('clay.framesFailed', ', then one failed');
    return s + (L.timedOut ? T('clay.framesAfter', ' after {t}', { t: ms(now() - L.t0) }) : T('clay.framesSoFar', ' so far, {t}', { t: ms(now() - L.t0) }));
  }

  // How the last (or current) visit is drawn, in plain words, or ''.
  function drawingText(d) {
    if (!d) return '';
    var playing = scene && scene.phase === 'playing' && scene.draw === d;
    if (d.mode === 'smooth') {
      if (d.why === 'hand') return T('clay.smoothHand', 'Smooth, stepped by hand (a test)');
      if (d.fps) return T('clay.smoothFps', 'Smooth, {n} frames a second', { n: d.fps });
      return playing ? T('clay.smoothMeasuring', 'Smooth, measuring the frame rate') : T('clay.smoothShort', 'Smooth (too short to measure)');
    }
    if (d.why === 'slow') return T('clay.steppedSlow', 'Stepped: the screen managed {n} frames a second', { n: d.fps });
    if (d.why === 'remembered') {
      return T('clay.steppedRemembered', 'Stepped: the screen managed {n} frames a second {ago}; smooth is tried again in {t}',
        { n: d.fps, ago: ago(d.seenAt), t: howLong(Math.max(0, d.seenAt + SLOW_KEEP_MS - now())) });
    }
    if (d.why === 'no-raf') return T('clay.steppedNoRaf', 'Stepped: this browser has no requestAnimationFrame');
    if (d.why === 'speed') return T('clay.steppedSpeed', 'Stepped: sped up by a test');
    return T('clay.steppedTest', 'Stepped: set by a test');
  }

  // The parts the About panel shows, one row each, all strings ('' when a
  // row has nothing to say): now (what they are doing, or what comes next),
  // visits, last (the last visit, how it ended and when), drawing (how the
  // last visit was drawn: smooth and its frame rate, or stepped and why),
  // loading (how long the sprite list and the last scene's frames took) and
  // problem (the last thing that went wrong, and when). text joins them in
  // one line, for tests and the console. Always safe to call.
  function status() {
    try {
      var out = { now: '', visits: '', last: '', drawing: '', loading: '', problem: '', text: '' };
      if (!started) out.now = T('clay.notStarted', 'Not started');
      else if (!settings) out.now = T('clay.off', 'Off ({why})', { why: offWhy === '?clay=off' ? offWhy : T('clay.offConfig', offWhy || 'config') });
      else {
        out.now = nowText();
        out.visits = T('clay.visits', '{played} played · {slow} slow · {failed} failed', { played: played, slow: slow, failed: failedN });
        if (last) out.last = outcome(last) + ', ' + ago(last.at);
        out.drawing = drawingText(drawInfo);
        var load = [];
        var a = spriteText();
        if (a) load.push(a);
        var b = framesText(lastLoad);
        if (b) load.push(b);
        out.loading = load.join(' · ');
        if (problem) out.problem = problem.text + ', ' + ago(problem.at);
      }
      var parts = [out.now];
      if (out.visits) parts.push(out.visits);
      if (out.last) parts.push(T('clay.partLast', 'last {t}', { t: out.last }));
      if (out.drawing) parts.push(T('clay.partDrawing', 'drawing: {t}', { t: out.drawing }));
      if (out.loading) parts.push(out.loading);
      if (out.problem) parts.push(T('clay.partProblem', 'problem: {t}', { t: out.problem }));
      out.text = parts.join(' · ');
      return out;
    } catch (e) {
      return { now: 'status failed: ' + errText(e), visits: '', last: '', drawing: '', loading: '', problem: '', text: 'status failed: ' + errText(e) };
    }
  }

  /* ---------- for tests ---------- */

  var test = {
    scenes: function () {
      var out = [];
      for (var k in SCENES) if (SCENES.hasOwnProperty(k)) out.push(k);
      return out;
    },
    // Plays a scene now, without waiting for idle. opts: { seed, dir, pose,
    // ledge, outfit, nap }. False when off, unknown, or a panel is open.
    play: function (name, opts) {
      if (!settings || !SCENES.hasOwnProperty(name)) return false;
      try { if (host && host.quiet() === false) return false; } catch (e) { return false; }
      opts = opts || {};
      var o = {};
      for (var k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
      delete broken[name];
      return begin(name, o);
    },
    stop: function () { if (scene) end('stopped'); },
    state: function () {
      var c = count(scene);
      return {
        on: !!settings,
        phase: !settings ? 'off' : scene ? scene.phase : 'waiting',
        scene: scene ? scene.name : null,
        tick: scene ? scene.tick : 0,
        // The signals given so far, with the tick of each (stills for screenshots).
        beats: scene && scene.signals ? scene.signals : {},
        nextIn: settings && !scene ? Math.max(0, nextAt() - now()) : null,
        last: last,
        chars: c.chars,
        props: c.props,
        assets: assets,
        spriteEvent: spriteEvent,
        spriteMs: spriteMs,
        played: played,
        slow: slow,
        slowRun: slowRun,
        settling: settling.length,
        failed: failedN,
        broken: (function () { var b = []; for (var k in broken) if (broken.hasOwnProperty(k)) b.push(k); return b; })(),
        lastLoad: lastLoad,
        ahead: ahead ? { name: ahead.name, got: ahead.info ? ahead.info.got : 0, of: ahead.info ? ahead.info.of : 0 } : null,
        problem: problem,
        pending: pending
      };
    },
    // What the scheduler would pick now (it may also take a waiting reaction).
    choose: function () { return settings ? choose() : null; },
    setHour: function (h) { hourOverride = typeof h === 'number' && h >= 0 && h < 24 ? Math.floor(h) : null; },
    // The scene that played last, as choose() sees it ('' for none).
    setLast: function (name) { lastName = typeof name === 'string' ? name : ''; },
    // ms per tick; 0 = only when step() or advance() is called (frame-exact
    // screenshots); null = the real 140, drawn smooth. Any other speed is
    // drawn stepped.
    setSpeed: function (ms) { tickMs = typeof ms === 'number' && ms >= 0 ? ms : TICK_MS; },
    // One whole tick, drawn where it ends (with setSpeed(0)).
    step: function () {
      var sc = scene;
      if (sc && sc.phase === 'playing' && !sc.timer && sc.raf === null) {
        sc.tau = sc.tick * TICK_MS;
        advance(sc, TICK_MS);
      }
      return test.state();
    },
    // The scene's clock on by ms (with setSpeed(0)): the ticks that come
    // due, then one drawing part of the way through the next (a film at 30
    // frames a second calls advance(1000 / 30) per frame).
    advance: function (ms) {
      var sc = scene;
      if (sc && sc.phase === 'playing' && !sc.timer && sc.raf === null && ms > 0) advance(sc, ms);
      return test.state();
    },
    // How the current or last visit is drawn: { mode, why, fps, text, slowSeen }.
    drawing: function () {
      var d = drawInfo || {};
      return { mode: d.mode || null, why: d.why || '', fps: d.fps || null, text: drawingText(drawInfo), slowSeen: slowSeen };
    },
    // 'smooth' or 'stepped' for the next scenes; null to decide as on the TV.
    setDrawing: function (mode) { drawForce = mode === 'smooth' || mode === 'stepped' ? mode : null; },
    // Forgets that a scene was too slow (as if 30 minutes had passed).
    forgetSlow: function () { slowSeen = null; },
    // The blend experiment: ms (0 off); null = BLEND_MS.
    setBlend: function (ms) { blendMs = typeof ms === 'number' && ms >= 0 ? ms : BLEND_MS; },
    // true: a walk's position moves only with its picture; null = MOVE_WITH_POSE.
    setMoveWithPose: function (on) { moveWithPose = on === true || on === false ? on : null; },
    // Each actor as the script has it after the last tick (x, y with the
    // bob, and before it), how it is drawn now, and whether it jumped there.
    actors: function () {
      var out = [];
      if (!scene || !scene.actors) return out;
      for (var i = 0; i < scene.actors.length; i++) {
        var a = scene.actors[i];
        var C = a.now || {};
        var P = a.prev || C;
        out.push({ name: a.name, frame: C.frame || null, shown: a.shown || null, x: C.x + C.dx, y: C.y + C.dy,
          px: P.x + P.dx, py: P.y + P.dy, jumped: a.jumpTick === scene.tick, walking: !!C.gaitAt, arc: !!C.arc,
          gait: C.gaitAt ? { keys: C.gaitAt.c.keys, stride: C.gaitAt.c.stride, cuts: C.gaitAt.c.cuts, bob: !!C.gaitAt.c.dys,
            d: a.drawD, d0: C.gaitAt.d0, d1: C.gaitAt.d1 } : null,
          lift: a.lift || 0,
          opacities: (function () {
            var o = {};
            for (var key in a.imgs || {}) if (a.imgs.hasOwnProperty(key) && a.imgs[key].style.opacity && a.imgs[key].style.opacity !== '0') o[key] = a.imgs[key].style.opacity;
            return o;
          })(),
          flip: !!C.flip, transform: a.el ? a.el.style.transform : '', shadow: a.sh ? a.sh.style.transform : '' });
      }
      return out;
    },
    // A scene's length without playing it: { ticks, seconds, frames, gaits }
    // (gaits: the gait pictures it uses, by sequence). Needs the sprite list
    // in (after one visit). null when it doesn't fit.
    dry: function (name, opts) {
      if (!M || !SCENES.hasOwnProperty(name)) return null;
      var o = {};
      for (var k in (opts || {})) if (opts.hasOwnProperty(k)) o[k] = opts[k];
      var b = build(name, o);
      if (!b) return null;
      var sc = { tick: 0, idleTicks: 0, signals: {}, W: b.W };
      while (sc.tick <= MAX_TICKS) {
        sc.tick++;
        var alive = false;
        for (var i = 0; i < b.actors.length; i++) if (runActor(b.actors[i], sc)) alive = true;
        if (!alive) sc.idleTicks++;
        if (sc.idleTicks > 1) break;
      }
      var keys = frameKeys(b.actors);
      var gaits = {};
      var all = [IAN_WALK, IAN_RUN, EMBER_TROT, EMBER_RUN, EMBER_ZOOM, BALL_TROT, SOCK_RUN];
      for (var g = 0; g < all.length; g++) {
        var gk = gaitKeys(all[g]);
        if (gk.length > 1 && keys.indexOf(gk[0]) >= 0 && keys.indexOf(gk[1]) >= 0) gaits[all[g].seq] = gk.length;
        else if (gk.length === 1 && keys.indexOf(gk[0]) >= 0) gaits[all[g].seq] = 1;
      }
      return { ticks: sc.tick, seconds: Math.round(sc.tick * TICK_MS / 100) / 10, frames: keys.length, keys: keys, gaits: gaits };
    },
    // How long the sprite list or a scene's frames may take; null = the real 30 s.
    setLoadMs: function (ms) { loadMs = typeof ms === 'number' && ms > 0 ? ms : LOAD_MS; },
    // Makes the next visit due in ms (the idle rules still apply).
    dueIn: function (ms) { readyAt = now() + (ms || 0); due = 0; arm(); }
  };

  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { fail('error: ' + errText(e)); return undefined; }
    };
  }

  window.HUB_CLAY = {
    start: safe(start),
    input: safe(input),
    stop: safe(interrupt),
    layout: safe(interrupt),
    // A scene is on screen now (the motion extras keep out of its way).
    drawing: function () { return !!scene; },
    status: status,
    test: test
  };
})();
