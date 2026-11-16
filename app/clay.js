/*
 * Clay wanderers: Ian and his goldendoodle Ember, two stop-motion clay
 * puppets, now and then wander onto the home screen in front of the tiles
 * while nobody is using the remote, do a short scene and leave. Plain ES5,
 * loaded before hub.js; hub.js calls HUB_CLAY.start(host) once it is up and
 * tells it about key presses, panels and layout changes (see docs/clay.md).
 *
 * Built for a weak TV (Chrome 63):
 *   - One timer, about 7 ticks a second (setTimeout, not requestAnimationFrame,
 *     no CSS animations). On a tick an actor only changes which of its
 *     stacked, preloaded <img>s has opacity 1 and its transform (translate3d,
 *     plus scaleX(-1) to face left). A prop may also fade in steps. No src
 *     changes, no filters, no layout reads while a scene runs.
 *   - One fixed, click-through layer above the tiles and below the scrim, the
 *     panel, the dashboard frame and the toast. It never takes focus.
 *   - A scene's frames load (new Image()) before it starts. If one fails
 *     (onerror, or it loads 0 px wide) the scene is skipped and left out for
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
 * on exactly as without it. HUB_CLAY.status() says, in one line, what they
 * are doing or why they are not coming, and the last problem (the Clock
 * page shows it under "About this hub").
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
  var AHEAD_MS = 3000;         // after a visit ends, this long until the next one's frames start loading
  var CHECK_MS = 5000;         // how often to look again while a panel is open or the page is hidden
  var BROKEN_MS = 10 * 60000;  // a scene whose frames failed is left out this long
  var MAX_TICKS = 700;         // no scene runs longer than this (100 s), whatever its script says
  var DESIGN_H = 1080;         // scenes are written for a 1080-row screen
  var FLOOR_GAP = 6;           // feet this far above the bottom of the screen
  var EDGE = 140;              // off-screen margin for entering and leaving
  var MAX_PROPS = 3;

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
  var problem = null;          // { text, at }: the last thing that went wrong, kept for status()
  var hourOverride = null;
  var tickMs = TICK_MS;
  var pending = null;          // a reaction to play next: 'cheer' | 'shrug'
  var seenDone = null;         // to-do items done at the last look
  var seenLost = null;         // the "since" of the Pi connection loss already reacted to

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
    function failed(key, img) {
      return function () {
        unsettle(img);
        finish(null, 'frame ' + key + ' failed (onerror)', 'broken');
      };
    }
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!M.sprites.hasOwnProperty(key)) {
        setTimeout(function () { finish(null, 'frame ' + key + ' is not in the sprite list', 'broken'); }, 0);
        return function () { finished = true; clearTimeout(guard); };
      }
      var img = new Image();
      img.onload = loaded(key, img);
      img.onerror = failed(key, img);
      images[key] = img;
      settling.push(img);
      img.src = spriteUrl(key);
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
  // Walk (or run, trot, shuffle) to x, `step` px a tick, the frame changing
  // every `every` ticks; turns to face the way it goes unless o.keepFace.
  Actor.prototype.walk = function (keys, to, step, every, o) {
    o = o || {};
    return this.add({ op: 'walk', keys: this.use(keys), to: to, step: step, every: every || 1, dys: o.dy, keepFace: !!o.keepFace });
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

  var OPS = {
    at: function (a, c) { a.x = c.x; a.y = c.y; a.gy = c.y; return NEXT; },
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
    walk: function (a, c) {
      if (c.t === undefined) {
        c.t = 0;
        c.sign = c.to >= a.x ? 1 : -1;
        if (!c.keepFace) a.dir = c.sign > 0 ? 'right' : 'left';
      }
      a.frame = keyAt(c.keys, Math.floor(c.t / c.every));
      a.dy = c.dys ? keyAt(c.dys, c.t) : 0;
      a.dx = 0;
      c.t++;
      a.x += c.sign * c.step;
      if ((c.sign > 0 && a.x >= c.to) || (c.sign < 0 && a.x <= c.to)) { a.x = c.to; return LAST; }
      return HOLD;
    },
    arc: function (a, c) {
      if (c.t === undefined) { c.t = 0; c.x0 = a.x; c.y0 = a.y; }
      c.t++;
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

  function px(v) { return Math.round(v); }

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
      a.sh.style.transform = 'translate3d(-2000px,-2000px,0)';
      a.shT = a.sh.style.transform;
      layer.appendChild(a.sh);
    }
    for (i = 0; i < sc.actors.length; i++) {
      a = sc.actors[i];
      a.el = document.createElement('div');
      a.el.className = 'clay-actor';
      a.el.style.transform = 'translate3d(-2000px,-2000px,0)';
      a.tf = a.el.style.transform;
      a.imgs = {};
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
        a.el.appendChild(img);
      }
      a.shown = null;
      a.opShown = 1;
      layer.appendChild(a.el);
    }
    return layer;
  }

  function draw(a) {
    var f = a.frame;
    if (f !== a.shown) {
      if (a.shown) a.imgs[a.shown].style.opacity = '0';
      if (f) a.imgs[f].style.opacity = '1';
      a.shown = f;
    }
    if (!f) {
      if (a.sh && a.shT !== 'translate3d(-2000px,-2000px,0)') {
        a.shT = 'translate3d(-2000px,-2000px,0)';
        a.sh.style.transform = a.shT;
      }
      return;
    }
    var flip = a.mirror || (a.dir === 'left' && M.sprites[f].faces === 'right');
    var tf = 'translate3d(' + px(a.x + a.dx) + 'px,' + px(a.y + a.dy) + 'px,0)' +
      (a.scale !== 1 ? ' scale(' + a.scale + ')' : '') + (flip ? ' scaleX(-1)' : '');
    if (tf !== a.tf) { a.el.style.transform = tf; a.tf = tf; }
    if (a.op !== a.opShown) { a.el.style.opacity = String(a.op); a.opShown = a.op; }
    if (a.sh) {
      var st = 'translate3d(' + px(a.x + a.dx) + 'px,' + px(a.gy) + 'px,0)';
      if (st !== a.shT) { a.sh.style.transform = st; a.shT = st; }
    }
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

  function tick() {
    var sc = scene;
    if (!sc || sc.phase !== 'playing') return;
    sc.timer = null;
    try {
      if (!quiet()) return end('interrupted');
      sc.tick++;
      var alive = false;
      for (var i = 0; i < sc.actors.length; i++) if (runActor(sc.actors[i], sc)) alive = true;
      for (var j = 0; j < sc.actors.length; j++) draw(sc.actors[j]);
      if (!alive) sc.idleTicks++;
      if (sc.idleTicks > 1 || sc.tick > MAX_TICKS) return end('done');
      if (tickMs > 0) sc.timer = setTimeout(tick, tickMs);
    } catch (e) {
      fail('error in scene ' + sc.name + ': ' + errText(e));
      end('error');
    }
  }

  // Ends the scene now and takes its DOM away. result: 'done' | 'interrupted' |
  // 'stopped' | 'slow: ...' | 'failed: ...' | 'error'.
  function end(result) {
    var sc = scene;
    if (!sc) return;
    scene = null;
    gen++;
    if (sc.timer) clearTimeout(sc.timer);
    if (sc.cancel) { try { sc.cancel(); } catch (e) { /* ignore */ } }
    if (sc.layer && sc.layer.parentNode) sc.layer.parentNode.removeChild(sc.layer);
    sc.layer = null;
    last = { name: sc.name, result: result, ticks: sc.tick };
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
    scene = { name: name, seed: opts.seed, phase: 'loading', step: 'sprite list', tick: 0, idleTicks: 0 };
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
        tick();
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

  // The scenes that may come at hour h, with their weights.
  function bagFor(h) {
    var bag = [];
    var t = now();
    function put(name, weight) { if (usable(name, t)) bag.push({ name: name, weight: weight }); }
    if (isNight(h)) {
      put('night', 1);
    } else {
      put('stroll', 3);
      put('fetch', 3);
      put('sock-heist', 2);
      put('zoomies', 2);
      put('perch', 2);
      if (h >= 6 && h < 10) put('morning', 4);
      if (h >= 19 && h < 22) put('evening', 4);
      if (outfit()) put('weather', 2);
    }
    return bag;
  }

  // At random by weight, without repeating the last scene.
  function pick(bag) {
    if (bag.length > 1) {
      for (var i = 0; i < bag.length; i++) if (bag[i].name === lastName) { bag.splice(i, 1); break; }
    }
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
  // may still come now, else at random without repeating the last.
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

  // Gaits: frames, px per tick, ticks per frame, bob per tick.
  var IAN_WALK = { keys: ['ian/walk-1', 'ian/walk-2'], step: 18, every: 2, dy: [0, -1, 0, -1] };
  var IAN_RUN = { keys: ['ian/run-1', 'ian/run-2'], step: 34, every: 1, dy: [-8, 0] };
  var EMBER_TROT = { keys: ['ember/trot-1', 'ember/trot-2'], step: 18, every: 2, dy: [0, 0, -2, -2] };
  var EMBER_RUN = { keys: ['ember/run-1', 'ember/run-2'], step: 44, every: 1, dy: [-10, -2] };

  function go(a, gait, to, step) {
    return a.walk(gait.keys, to, step || gait.step, gait.every, { dy: gait.dy });
  }

  // A front-facing pose slid along with a little bob, like a puppet shuffled across the set.
  function shuffle(a, key, to, step) {
    return a.walk([key], to, step || 14, 1, { dy: [0, -3, -4, -2], keepFace: true });
  }

  var SCENES = {};

  // 1. Ian walks across the floor, Ember trots behind; midway he stops and waves.
  SCENES.stroll = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var mid = S.across(S.rand(0.38, 0.58));
    go(ian.at(S.start, F).face(S.dir), IAN_WALK, mid)
      .pose('ian/stand', 3)
      .cycle(['ian/stand-wave', 'ian/stand'], 14, 3)
      .pose('ian/stand-wave', 5)
      .pose('ian/stand', 3)
      .signal('go');
    go(ian, IAN_WALK, S.end).hide();
    go(ember.at(S.start - S.sgn * 120, F).face(S.dir), EMBER_TROT, mid - S.sgn * 100)
      .pose('ember/stand-2', 3)
      .cycle(['ember/stand-wag', 'ember/stand-wag', 'ember/stand-2'], 20, 3)
      .pose('ember/sit-side', 0)
      .after('go')
      .wait(3);
    go(ember, EMBER_TROT, S.end + S.sgn * 40).hide();
  };

  // 2. Ian throws the ball, Ember runs, jump-catches it, trots back; a high five.
  SCENES.fetch = function (S) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var duo = S.actor('duo', 'duo', { shadow: 120, mirror: S.dir === 'left' });
    var ball = S.actor('ball', 'prop', { shadow: 18, scale: 1.6 });
    var heart = S.actor('heart', 'prop', { scale: 1.5 });
    var ianX = S.across(S.rand(0.14, 0.2));
    var emberWait = ianX + S.sgn * 125;
    var catchX = S.across(S.rand(0.58, 0.7));
    var runTo = catchX - S.sgn * 14;
    var runTicks = 16;
    var step = Math.max(24, Math.ceil(Math.abs(runTo - emberWait) / runTicks));
    runTicks = Math.ceil(Math.abs(runTo - emberWait) / step);
    var flight = runTicks + 4;           // she crouches, runs, crouches again, rises two
    var apex = F - 70;                   // the bottom of her paws at the top of the jump

    go(ian.at(S.start, F).face(S.dir), IAN_WALK, ianX)
      .pose('ian/stand', 3)
      .face(S.dir)
      .pose('ian/throw-1', 5)
      .signal('throw')
      .pose('ian/throw-2', 6)
      .pose('ian/stand', 0)
      .after('back')
      .pose('ian/call', 4)
      .signal('swap')
      .hide()
      .after('fived')
      .at(ianX, F)
      .pose('ian/stand', 2);
    go(ian, IAN_WALK, S.start).hide();

    go(ember.at(S.start - S.sgn * 130, F).face(S.dir), EMBER_TROT, emberWait)
      .pose('ember/stand-2', 0)
      .after('throw')
      .pose('ember/jump-crouch', 1);
    ember.walk(EMBER_RUN.keys, runTo, step, 1, { dy: EMBER_RUN.dy })
      .pose('ember/jump-crouch', 1)
      .move(S.sgn * 7, (apex - F) / 2, 2, { key: 'ember/jump-catch' })
      .signal('caught')
      .move(S.sgn * 7, (F - apex) / 2, 2, { key: 'ember/jump-catch' })
      .pose('ember/stand-ball', 5)
      .face(S.back)
      .pose('ember/stand-ball', 2)
      .walk(['ember/stand-ball'], ianX + S.sgn * 70, 20, 1, { dy: [0, -6, -3] })
      .pose('ember/stand-ball', 3)
      .signal('back')
      .after('swap')
      .hide()
      .after('fived')
      .at(ianX + S.sgn * 70, F)
      .wait(2);
    go(ember, EMBER_TROT, S.start - S.sgn * 60).hide();

    // The high five, between where they stand.
    var duoX = ianX + S.sgn * 34;
    duo.after('swap').at(duoX, F).pose('duo/high-five', 16).hide().signal('fived');
    heart.after('swap').wait(5).at(duoX + 10, F - 140).pose('props/heart', 2).move(0, -4, 4, { key: 'props/heart' }).hide();

    // The ball: from Ian's hand at the end of the throw, along an arc that
    // ends in Ember's open mouth at the top of her jump, then down with her.
    var handX = ianX + S.sgn * 36;
    var mouthX = runTo + S.sgn * (14 + 18);
    ball.after('throw')
      .at(handX, F - 118)
      .ground(F)
      .arc(['props/ball'], mouthX, apex - 104, Math.min(380, 160 + flight * 14), flight)
      .move(S.sgn * 7, (F - apex) / 2, 2, { key: 'props/ball' })
      .hide();
  };

  // 3. Ember finds a sock and runs off with it; Ian runs after her and skids.
  SCENES['sock-heist'] = function (S) {
    var F = S.floor;
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var sock = S.actor('sock', 'prop');
    var bang = S.actor('bang', 'prop', { scale: 1.4 });
    var sockX = S.across(S.rand(0.3, 0.36));
    var skidX = S.across(S.rand(0.74, 0.8));
    sock.at(sockX, F - 2).face(S.dir).pose('props/sock', 0).after('found').hide();
    go(ember.at(S.start, F).face(S.dir), EMBER_TROT, sockX - S.sgn * 150)
      .walk(['ember/sniff'], sockX - S.sgn * 52, 7, 1, { dy: [0, 0, -1, -1] })
      .pose('ember/sniff', 6)
      .signal('found')
      .pose('ember/sock-proud', 10)
      .signal('heist')
      .pose('ember/sock-proud', 6)
      .after('seen')
      .wait(2)
      .walk(['ember/sock-run'], S.end + S.sgn * 80, 46, 1, { dy: [0, -10, -4] })
      .hide();
    bang.after('seen').at(sockX - S.sgn * 30, F - 112).pose('props/bang', 6).hide();
    ian.after('heist').at(S.start, F).face(S.dir);
    go(ian, IAN_RUN, S.across(0.12)).signal('seen');
    go(ian, IAN_RUN, skidX)
      .move(S.sgn * 18, 0, 2, { key: 'ian/skid' })
      .move(S.sgn * 7, 0, 2, { key: 'ian/skid' })
      .pose('ian/skid', 3)
      .pose('ian/stand', 2)
      .pose('ian/facepalm', 14)
      .pose('ian/stand', 2);
    go(ian, IAN_WALK, S.end).hide();
  };

  // 4. Ember alone, flat out across the floor, a skid and a play bow, and back.
  SCENES.zoomies = function (S) {
    var F = S.floor;
    var ember = S.actor('ember', 'char', { shadow: 76 });
    var keys = ['ember/zoomies', 'ember/run-1', 'ember/run-2'];
    var turn = S.across(S.rand(0.72, 0.82));
    ember.at(S.start, F).face(S.dir)
      .walk(keys, turn, 50, 1, { dy: [-3, -10, -2] })
      .move(S.sgn * 20, 0, 1, { key: 'ember/skid' })
      .move(S.sgn * 8, 0, 2, { key: 'ember/skid' })
      .face(S.back)
      .pose('ember/bow', 6)
      .pose('ember/stand-bark', 3)
      .pose('ember/bow', 3)
      .walk(keys, S.across(S.rand(0.3, 0.4)), 50, 1, { dy: [-3, -10, -2] })
      .pose('ember/spin', 2)
      .face(S.back === 'left' ? 'right' : 'left')
      .pose('ember/spin', 2)
      .face(S.back)
      .walk(keys, S.start - S.sgn * 40, 50, 1, { dy: [-3, -10, -2] })
      .hide();
  };

  // Where a perch pose's bottom goes, against the ledge's y (by eye, from the sprites).
  var PERCH = {
    'sit-edge': 52,     // hands on the edge, legs dangling down the tile
    'lie-chin': 2,      // lying along the top edge
    hang: 163,          // hands curled over the edge, hanging down the tile
    climb: 130          // forearms on top of the edge
  };

  // 5. Ian poofs onto a ledge, sits or lies there a few seconds, poofs away.
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
    var rest = Math.round(S.rand(42, 60));
    var cloudY = how === 'lie-chin' ? y + 14 : how === 'climb' ? y + 70 : y + 40;
    poof.at(x, cloudY).pose('props/poof', 3).hide().after('bye').at(x, how === 'lie-chin' ? y + 14 : y + 40).pose('props/poof', 3).hide();
    ian.wait(1);
    if (how === 'climb') {
      ian.at(x, y + PERCH.hang)
        .cycle(['ian/hang'], 14, 1, { dx: [0, 0, 0, -2, 0, 2] })
        .at(x, y + PERCH.climb)
        .pose('ian/climb', 6)
        .at(x, y + PERCH['sit-edge'])
        .pose('ian/sit-edge', rest - 16);
    } else if (how === 'lie-chin') {
      ian.at(x, y + PERCH['lie-chin']).face(x < S.W / 2 ? 'right' : 'left').pose('ian/lie-chin', rest);
    } else {
      ian.at(x, y + PERCH['sit-edge']).pose('ian/sit-edge', rest);
    }
    ian.signal('bye').wait(1).hide();
  };

  // A walk in, a few beats in the middle, and back out the way they came
  // (the nearer edge). Used by the time-of-day, weather and reaction scenes:
  // middle(ian, ember, x, emberX).
  function visit(S, opts, middle) {
    var F = S.floor;
    var ian = S.actor('ian', 'char', { shadow: 62 });
    var ember = opts.ember === false ? null : S.actor('ember', 'char', { shadow: 76 });
    var x = S.across(opts.at || S.rand(0.3, 0.45));
    var ex = x - S.sgn * (opts.gap || 110);
    if (opts.ianKey) shuffle(ian.at(S.start, F).face(S.dir), opts.ianKey, x, opts.step);
    else go(ian.at(S.start, F).face(S.dir), IAN_WALK, x);
    if (ember) go(ember.at(S.start - S.sgn * 150, F).face(S.dir), EMBER_TROT, ex).signal('here');
    middle(ian, ember, x, ex);
    ian.signal('leave');
    if (opts.ianKey) shuffle(ian.face(S.back), opts.ianKey, S.start - S.sgn * 30, opts.step);
    else go(ian, IAN_WALK, S.start - S.sgn * 30);
    ian.hide();
    if (ember) {
      ember.after('leave');
      go(ember, EMBER_TROT, S.start).hide();
    }
    return { ian: ian, ember: ember };
  }

  // 6a. Morning (6 to 10): Ian with his coffee, and a big yawn.
  SCENES.morning = function (S) {
    visit(S, { at: S.rand(0.24, 0.34) }, function (ian, ember) {
      ian.pose('ian/stand', 2)
        .pose('ian/stand-coffee', 16)
        .pose('ian/yawn', 12)
        .pose('ian/stand-coffee', 18)
        .pose('ian/stand', 2);
      ember.pose('ember/sit-side', 12)
        .pose('ember/scratch', 10)
        .pose('ember/sit', 0)
        .after('leave');
    });
  };

  // 6b. Evening (19 to 22): the two on the floor, watching; then popcorn.
  SCENES.evening = function (S) {
    var F = S.floor;
    var duo = S.actor('duo', 'duo', { shadow: 110, mirror: S.dir === 'right' });
    var spot = S.rand(0.18, 0.3);
    var x = S.across(spot);
    visit(S, { at: spot, gap: 70 }, function (ian, ember, ix, ex) {
      ian.pose('ian/stand', 0).after('here').pose('ian/stand', 3).signal('sit').hide().after('popcorn')
        .at(ix, F).pose('ian/popcorn', 30)
        .pose('ian/stand', 3);
      ember.pose('ember/stand-2', 0).after('sit').hide().after('popcorn')
        .at(ex, F).face(S.dir)
        .pose('ember/beg', 14)
        .pose('ember/sit-side', 18)
        .after('leave');
    });
    duo.after('sit').at((x + x - S.sgn * 70) / 2, F).pose('duo/movie', 60).hide().signal('popcorn');
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
    ember.at(edge, F).face(left ? 'right' : 'left')
      .walk(EMBER_TROT.keys, ex, 10, 2, { dy: EMBER_TROT.dy })
      .pose('ember/sniff', 6)
      .face(left ? 'left' : 'right')
      .pose('ember/down', 12)
      .signal('asleep')
      .pose('ember/sleep', sleepTicks)
      .signal('wake')
      .pose('ember/down', 6)
      .pose('ember/bow', 6)
      .walk(EMBER_TROT.keys, edge, 12, 2, { dy: EMBER_TROT.dy })
      .hide();
    if (ian) {
      ian.after('asleep').at(edge, F).face(left ? 'right' : 'left');
      ian.walk(IAN_WALK.keys, ix, 12, 2, { dy: IAN_WALK.dy })
        .pose('ian/stand', 2)
        .pose('ian/yawn', 10)
        .pose('ian/nap', sleepTicks - 60)
        .after('wake')
        .pose('ian/stand', 4)
        .walk(IAN_WALK.keys, edge, 12, 2, { dy: IAN_WALK.dy })
        .hide();
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

  // 7. Weather: Ian dressed for what the Weather tile says now.
  var OUTFITS = ['umbrella', 'sunny', 'cold', 'hot', 'windy'];
  SCENES.weather = function (S) {
    var kind = OUTFITS.indexOf(S.o.outfit) >= 0 ? S.o.outfit : outfit();
    if (!kind) return false;
    if (kind === 'windy') {
      // Side on, leaning into the wind, slowly.
      visit(S, { ianKey: 'ian/windy', step: 9, at: S.rand(0.22, 0.3) }, function (ian, ember) {
        ian.cycle(['ian/windy'], 24, 1, { dx: [0, -2, 0, -1, 1] });
        ember.pose('ember/sit-side', 0).after('leave');
      });
      return true;
    }
    var key = 'ian/' + kind;
    visit(S, { ianKey: key, step: 14, at: S.rand(0.22, 0.34), gap: 100 }, function (ian, ember) {
      if (kind === 'cold') ian.cycle([key], 34, 1, { dx: [-2, 2, -1, 2, -2, 1] });
      else ian.cycle([key], 34, 1, { dy: kind === 'hot' ? [0, 0, 0, 1, 1, 1] : [0] });
      if (kind === 'umbrella') ember.pose('ember/soggy', 24).pose('ember/shake', 6).pose('ember/sit', 0);
      else if (kind === 'sunny') ember.pose('ember/stand-wag', 8).pose('ember/belly', 22).pose('ember/stand-2', 0);
      else if (kind === 'hot') ember.pose('ember/down', 0);
      else ember.pose('ember/stand-tilt', 0);
      ember.after('leave');
    });
    return true;
  };

  // 8a. A to-do item was ticked off since the last scene: Ian cheers, stars pop.
  SCENES.cheer = function (S) {
    var F = S.floor;
    var stars = [S.actor('star0', 'prop', { scale: 1.6 }), S.actor('star1', 'prop', { scale: 1.6 }), S.actor('star2', 'prop', { scale: 1.6 })];
    var f = S.rand(0.3, 0.45);
    var x = S.across(f);
    visit(S, { at: f, ember: false }, function (ian) {
      ian.pose('ian/stand', 2)
        .pose('ian/checklist', 14)
        .signal('cheer')
        .cycle(['ian/cheer', 'ian/stand-proud'], 20, 3, { dy: [-14, -14, -14, 0, 0, 0] })
        .pose('ian/stand-thumbs', 12)
        .pose('ian/stand', 2);
    });
    var spots = [[-46, F - 170], [42, F - 190], [-4, F - 214]];
    for (var i = 0; i < stars.length; i++) {
      stars[i].after('cheer').wait(i * 2 + 1)
        .at(x + spots[i][0], spots[i][1])
        .pose('props/star', 3).hide().wait(3)
        .at(x + spots[i][0] * 1.2, spots[i][1] - 10)
        .pose('props/star', 3).hide();
    }
  };

  // 8b. The Pi connection was lost: Ian shrugs, Ember tilts her head.
  SCENES.shrug = function (S) {
    visit(S, { gap: 90 }, function (ian, ember) {
      ian.pose('ian/stand', 3).pose('ian/stand-shrug', 18).pose('ian/stand', 6);
      ember.pose('ember/stand-tilt', 0).after('leave');
    });
  };

  // { actors, night, W, H, k }, or null when the scene doesn't fit here.
  function build(name, o) {
    var fn = SCENES[name];
    if (!fn) throw new Error('no scene ' + name);
    var rnd = makeRandom(o.seed);
    var S = stage(o, rnd);
    if (fn(S) === false) return null;
    var props = 0;
    for (var i = 0; i < S.actors.length; i++) if (S.actors[i].kind === 'prop') props++;
    if (props > MAX_PROPS) throw new Error(name + ' has more than ' + MAX_PROPS + ' props');
    return { actors: S.actors, night: !!S.night || name === 'night', W: S.W, H: S.H, k: S.k };
  }

  /* ---------- status, for the Clock page ---------- */

  function ago(t) {
    var s = Math.max(0, Math.round((now() - t) / 1000));
    if (s < 60) return s + ' s ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }

  function outcome(l) {
    var r = l.result;
    var word = r === 'done' ? 'finished' :
      r === 'interrupted' ? 'interrupted' :
      r === 'stopped' ? 'stopped' :
      r === 'failed: does not fit here' ? 'did not fit' :
      r === 'error' ? 'hit an error' :
      r.indexOf('slow:') === 0 ? 'too slow' : 'failed';
    return l.name + ' ' + word;
  }

  function busyWhy() {
    try {
      var w = host && typeof host.busyWhy === 'function' ? host.busyWhy() : '';
      return typeof w === 'string' ? w : '';
    } catch (e) { return ''; }
  }

  function overLimit() { return ' (over ' + Math.round(loadMs / 1000) + ' s)'; }

  // How the sprite list's last try went, or '' before the first.
  function spriteText() {
    if (spriteEvent === 'already there' && spriteMs === null) return 'sprite list in';
    if (!spriteScript) return '';
    if (spriteMs === null) return 'sprite list not in after ' + (now() - spriteStart) + ' ms';
    var s = 'sprite list ' + (spriteHow === 'onerror' ? 'onerror after ' : '') + spriteMs + ' ms';
    return spriteMs > loadMs ? s + overLimit() : s;
  }

  // How the last scene's frames came, or ''.
  function framesText(L) {
    if (!L || L.of === undefined) return '';
    var s = L.name + ' ' + L.got + '/' + L.of + ' frames';
    if (L.ms !== null) return s + ' in ' + L.ms + ' ms' + (L.timedOut ? overLimit() : '');
    if (L.failed) return s + ', then one failed';
    return s + (L.timedOut ? ' after ' : ' so far, ') + (now() - L.t0) + ' ms';
  }

  // { text, detail }: text says what they are doing or why not, the visits
  // so far and the last outcome; detail ('' before anything loaded) how long
  // loading took and the last problem, and when. Always safe to call.
  function status() {
    try {
      var parts = [];
      if (!started) return { text: 'not started', detail: '' };
      if (!settings) return { text: 'off (' + (offWhy || 'config') + ')', detail: '' };
      if (scene) {
        parts.push(scene.phase === 'playing' ? 'playing ' + scene.name : 'loading ' + scene.name + ' (' + scene.step + ')');
      } else if (isHidden()) {
        parts.push('not yet: page reports hidden');
      } else if (!hostQuiet()) {
        var why = busyWhy();
        parts.push('not yet: hub busy' + (why ? ' (' + why + ')' : ''));
      } else {
        parts.push('next visit in ' + Math.max(0, Math.ceil((nextAt() - now()) / 1000)) + ' s');
      }
      parts.push(played + ' played, ' + slow + ' slow, ' + failedN + ' failed' + (last ? '; last ' + outcome(last) : ''));
      var detail = [];
      var a = spriteText();
      if (a) detail.push(a);
      var b = framesText(lastLoad);
      if (b) detail.push(b);
      if (problem) detail.push('problem ' + ago(problem.at) + ': ' + problem.text);
      return { text: parts.join(' · '), detail: detail.join(' · ') };
    } catch (e) {
      return { text: 'status failed: ' + errText(e), detail: '' };
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
    // ms per tick; 0 = only when step() is called (frame-exact screenshots); null = the real 140.
    setSpeed: function (ms) { tickMs = typeof ms === 'number' && ms >= 0 ? ms : TICK_MS; },
    step: function () { if (scene && scene.phase === 'playing' && !scene.timer) tick(); return test.state(); },
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
    status: status,
    test: test
  };
})();
