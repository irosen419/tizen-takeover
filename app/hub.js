/*
 * Home Hub core. Runs inside TizenBrew on the TV. Plain ES5 so older Tizen
 * browsers (2017 to 2019 sets) can run it. Loads last, after the widgets.
 *
 * ---------------------------------------------------------------------------
 * Writing a widget
 * ---------------------------------------------------------------------------
 * A widget is one file in app/widgets/ that registers itself, plus a script
 * tag in hub.html (before hub.js) and an entry in HUB_CONFIG.layout (the
 * built-in layout; the Pi can send another, see "Tile layout from the Pi" in
 * docs/live-updates.md):
 *
 *   (window.HUB_WIDGETS = window.HUB_WIDGETS || []).push({
 *     id: 'weather',          // matches a layout entry and HUB_CONFIG.widgets[id]
 *     title: 'Weather',
 *     icon: 'sun-cloud',      // key in HUB_ICONS
 *     expandable: true,       // false = static tile that focus skips
 *     planned: false,         // true = "Soon" tag and quieter styling
 *     head: true,             // false = the hub draws no tile head (icon/title)
 *     sub: '',                // small line under the title (config.sub wins)
 *     init: function (ctx) {},             // once at boot: timers, data loads
 *     renderTile: function (el, ctx) {},   // fill the tile body. Boot and ctx.redrawTile()
 *     renderPanel: function (el, ctx) {},  // fill the panel body on open and ctx.redrawPanel().
 *                                          // Focusable elements get class "f"; one may carry
 *                                          // data-autofocus. A data-key attribute lets
 *                                          // redrawPanel keep focus on the same thing.
 *     onSelect: function (target, ctx) {}, // OK on a focusable in the panel body
 *     onSubmit: function (target, ctx) {}, // Enter or Done in a text box (see below)
 *     onFocus: function (target, ctx) {},  // focus moved to a body focusable, or to the
 *                                          // hub's Full screen button
 *     onMove: function (dir, from, ctx) {}, // an arrow ('left' 'right' 'up' 'down') pressed with
 *                                          // focus on `from` (a body focusable or the hub's
 *                                          // Full screen button). Return the element to focus,
 *                                          // true to stay put, or nothing to move by position.
 *     onBack: function (ctx) { return false; }, // true = the widget used Back itself
 *     backHint: function (ctx) {},         // the Back chip's words while onBack would use
 *                                          // Back itself (e.g. "Back for the list"), or
 *                                          // nothing for the hub's own
 *     openView: function (name, ctx) {},   // asked to show one of its own views before its
 *                                          // panel opens (the About panel's watch link test
 *                                          // asks entertainment for 'linktests'); false = no
 *     engage: true,           // (or a function (ctx) -> boolean, asked per press: a size
 *                             // too small to use in place says false)
 *                             // An interactive tile (Flashcards): a short OK on the
 *                             // tile ENGAGES it instead of opening the panel. The ring
 *                             // changes (class is-engaged) and a hint shows; Left and
 *                             // Right (not held repeats) and a short OK go to
 *                             // onEngagedKey; Back leaves; Up or Down leave and move on.
 *                             // Holding OK (engaged or not) opens the panel. See
 *                             // "engage on OK" below.
 *     onEngagedKey: function (key, ctx) {}, // 'left' | 'right' | 'ok' while engaged
 *     onEngage: function (ctx) {}, onDisengage: function (ctx) {},
 *     engageHint: function (ctx) {},       // the hint's words while engaged (or the hub's)
 *     openMode: 'full',       // OK on the tile opens straight to full screen, and Back
 *                             // closes it (no small panel to shrink to). The owner can
 *                             // set it per widget too: HUB_CONFIG.widgets[id].openMode
 *                             // 'full' or 'panel' wins over the widget's own.
 *     onMode: function (mode, ctx) {},     // after switching 'panel' <-> 'full'
 *     onClose: function (ctx) {},          // panel closed
 *     onStatus: function (ctx) {},         // the motion, live updates or updates status
 *                                          // changed (ctx.live.status())
 *     stagger: '.my-item',                 // panel items that arrive one by one when it
 *                                          // opens (motion extras, app/motion.js)
 *     activity: 'todo'                     // the activity kind this tile shows the
 *                                          // "working" chip for while a sync of that
 *                                          // kind is on its way (a "hub:working <kind>"
 *                                          // say text from the Pi). The first tile in
 *                                          // layout order that declares the kind gets
 *                                          // it; without one, the tile whose id is the
 *                                          // kind. See app/motion.js.
 *   });
 *
 * Everything except id and title is optional. Every call into a widget is
 * wrapped in try/catch, so a broken widget shows a short toast instead of
 * stopping the hub. If two widgets register the same id, a real one beats a
 * planned placeholder; otherwise the last one registered wins.
 *
 * Text boxes: an <input class="f"> (type text, search, url, email, tel,
 * number, password or none) in the panel body. Focus on it is ordinary hub
 * focus until OK, or a typed letter on a USB or Bluetooth keyboard, starts
 * typing: the input gets real focus (on the TV that opens the on-screen
 * keyboard) and keys go to it, so Backspace deletes and Left/Right move the
 * caret. Enter or the keyboard's Done stops typing, then calls
 * onSubmit(target, ctx); target.value is still there to read (clear it and
 * redraw if you like). Back or Cancel stops typing and keeps the text. Up and
 * Down stop typing and move on. Style the typing state with :focus, hub focus
 * with .is-focused. Give the input a data-key so a redraw while typing keeps
 * the text and the caret.
 *
 * ctx, one per widget:
 *   ctx.id, ctx.config        HUB_CONFIG.widgets[id] || {}
 *   ctx.toast(text, ms)
 *   ctx.service(path, timeoutMs, cb)   GET JSON from the local service.js;
 *                             cb(err, data), err unless data.ok is true
 *   ctx.getJSON(url, timeoutMs, cb)    GET JSON from any absolute URL;
 *                             cb(err, data), no ok field needed
 *   ctx.pi(path)              the Raspberry Pi address joined with a path or
 *                             port: ctx.pi('/todo/'), ctx.pi(':8123/api/x')
 *   ctx.hasTizen              the page can use the tizen API directly
 *   ctx.registerKeys(keys)
 *   ctx.openFrame(url)        a web page full screen; Back closes it
 *   ctx.isOpen(), ctx.mode()  'panel' | 'full' | null
 *   ctx.setMode(mode), ctx.close()
 *   ctx.redrawTile(), ctx.redrawPanel()
 *   ctx.size()                the tile's size on the grid now:
 *                             { cols, rows, tier, width }, where tier is
 *                             'strip' (1 row), 'standard' (2) or 'tall' (3+)
 *                             and width is 'narrow' (1-2 columns), 'standard'
 *                             (3-5) or 'wide' (6+). The tile also carries the
 *                             classes tile-h1 / tile-h2 / tile-h3 and tile-wn /
 *                             tile-wm / tile-ww for CSS (and tile-w1 when one
 *                             column wide). A layout from the Pi
 *                             that changes a tile's size calls renderTile again.
 *   ctx.engaged()             this tile is engaged (engage: true widgets)
 *   ctx.disengage()           leave the engaged state
 *   ctx.setSub(text)          the small line in the panel head
 *   ctx.setTileSub(text)      the small line under the tile's title ('' hides it)
 *   ctx.focus(el)             move panel focus to el
 *   ctx.bloom(node)           an app is opening from node: { cancel() } or null
 *   ctx.activity(kind)        real new data for this tile just arrived from a
 *                             live sync (never call it for the first data after
 *                             the hub starts, or for a refetch that changed
 *                             nothing): the motion extras show a small chip
 *                             saying so: 'todo', 'calendar', 'awws', 'budget',
 *                             'nowplaying' (a new song). Every kind is a row of
 *                             the kinds table (KIND_TABLE in app/motion.js);
 *                             HUB_FX.addActivity adds one at run time
 *   (A waiting tile marks itself quiet with an element of class hub-dormant.)
 *   ctx.live                  live updates from the hub server on the Pi (see
 *                             docs/live-updates.md), or undefined when live.js
 *                             isn't loaded. jsDelivr can serve a mix of old and
 *                             new files, so always check it exists first:
 *     ctx.live.status()         { state, text, since }; text is what the
 *                               About panel shows for live updates, '' when
 *                               there is nothing to say
 *     ctx.live.get(resource)    the data last received, e.g. get('todo').items
 *     ctx.live.on(resource, fn) fn(data, rev) each time new data arrives
 *     ctx.live.onStatus(fn)     fn(status) when the state changes (the hub also
 *                               calls every widget's onStatus hook then)
 *     ctx.live.post(path, body, cb)  POST JSON to the server; cb(err, data, httpStatus)
 *     ctx.live.everConnected()  this TV has reached the server at least once
 *
 * (Where the hub stands with updates, the TV's browser and the motion choice
 * are not in ctx: since v0.18.0 the About panel in this file shows them.)
 *
 * Later widgets get their data from the Raspberry Pi in one of two ways. A
 * widget either draws natively from JSON it fetches with
 * ctx.getJSON(ctx.pi('/...')) (the Pi must send an Access-Control-Allow-Origin
 * header), or opens a page hosted on the Pi full screen with
 * ctx.openFrame(ctx.pi('/...')).
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var BUILD = 'v0.84.1';
  // Widgets that remember a frame-rate check per build (nowplaying-viz.js) read it here.
  window.HUB_BUILD = BUILD;
  var SERVICE = 'http://127.0.0.1:8095';
  // IME_DONE and IME_CANCEL: Done and Cancel on Samsung's on-screen keyboard.
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    IME_DONE: 65376, IME_CANCEL: 65385 };
  var MOTION_KEY = 'homeHub.motion';
  var EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

  var cfg = window.HUB_CONFIG || {};
  var ICONS = window.HUB_ICONS || {};

  var gridEl = document.getElementById('grid');
  var scrimEl = document.getElementById('scrim');
  var ghostEl = document.getElementById('ghost');
  var panelEl = document.getElementById('panel');
  var toastEl = document.getElementById('toast');
  var frameWrap = document.getElementById('frameWrap');
  var frameEl = document.getElementById('frame');
  var backdropEl = document.getElementById('backdrop');
  var stageEl = document.getElementById('stage');

  var widgets = [];       // [{ w, ctx, cell, tile, body, subEl, expandable }]
  var homeIndex = -1;     // focused tile
  var FOCUS_KEEP_MS = 60000; // a layout arriving within this of a key press or click leaves focus alone
  var open = null;        // the widget record whose panel is open
  var openAuto = false;   // that panel is a one-widget layout's own window (openSolo), not opened by a person
  var mode = null;        // 'panel' | 'full' | null
  var busy = false;       // a transition is running; keys are ignored
  var frameOpen = false;
  var panelFocus = null;  // focused .f element in the panel
  var toastTimer = null;
  var panel = {};         // panel parts: icon, title, sub, btn, btnIcon, btnLabel, body

  var hasPageTizen = (function () {
    try { return typeof tizen !== 'undefined' && !!tizen.application; } catch (e) { return false; }
  })();

  // Tablet mode (a wall tablet with no remote and no service.js): see
  // "tablet mode" near the end. Off on a TV, and nothing below changes then.
  var tablet = { on: false, noHelper: false, sheetOn: false, sheet: null, hideTimer: null, show: null, peek: false, fkey: '' };

  /* ---------- helpers ---------- */

  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.className = 'toast is-shown';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, ms || 3500);
  }

  // GET JSON. With needOk, the reply must also say { ok: true } (service.js does).
  function xhrJSON(url, timeoutMs, needOk, cb) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function done(err, data) { if (finished) return; finished = true; cb(err, data); }
    try {
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs || 8000;
    } catch (e) {
      return setTimeout(function () { done('bad address'); }, 0);
    }
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (needOk) {
        if (xhr.status === 200 && data && data.ok) return done(null, data);
        return done((data && data.error) || ('HTTP ' + xhr.status));
      }
      if (xhr.status >= 200 && xhr.status < 300 && data !== null) return done(null, data);
      done(xhr.status >= 200 && xhr.status < 300 ? 'not JSON' : 'HTTP ' + xhr.status);
    };
    xhr.onerror = function () { done('not reachable'); };
    xhr.ontimeout = function () { done('timed out'); };
    xhr.send();
  }

  function service(path, timeoutMs, cb) {
    xhrJSON(SERVICE + path, timeoutMs, true, function (err, data) {
      cb(err === 'not reachable' ? 'service not reachable' : err, data);
    });
  }

  function piUrl(path) {
    var base = String(cfg.pi || '').replace(/\/+$/, '');
    if (!base) return '';
    return base + (path || '');
  }

  function registerKeys(keys) {
    if (!keys || !hasPageTizen || !tizen.tvinputdevice) return;
    for (var i = 0; i < keys.length; i++) {
      try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) { /* ignore */ }
    }
  }

  function hasClass(el, c) { return el.classList.contains(c); }

  function iconHTML(name) { return ICONS[name] || ''; }

  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  // Calls a widget hook without letting its errors escape.
  function call(rec, hook, args) {
    var fn = rec.w[hook];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(rec.w, args || []);
    } catch (e) {
      if (window.console && console.warn) console.warn('Widget ' + rec.w.id + ' ' + hook + ': ' + (e && e.message));
      toast(hubWord('widgetProblem', '{name} ran into a problem ({hook}).', { name: rec.w.title || rec.w.id, hook: hook }), 4000);
      return undefined;
    }
  }

  // Runs cb once, on transitionend of el or after ms + 80, whichever comes
  // first. transitionend is unreliable on the TV, so the timer always backs it up.
  function after(el, ms, cb) {
    var called = false;
    function finish(e) {
      if (e && e.target !== el) return;
      if (called) return;
      called = true;
      el.removeEventListener('transitionend', finish);
      clearTimeout(timer);
      cb();
    }
    var timer = setTimeout(finish, ms + 80);
    el.addEventListener('transitionend', finish);
  }

  // Runs cb in a task after the coming frame has been drawn, so work done in
  // cb can't hold back a transition that this task started.
  function afterFrame(cb) {
    if (window.requestAnimationFrame) requestAnimationFrame(function () { setTimeout(cb, 0); });
    else setTimeout(cb, 16);
  }

  var now = window.performance && performance.now ?
    function () { return performance.now(); } :
    function () { return Date.now(); };

  /* ---------- spatial navigation ---------- */

  // Picks the best rect in a direction from `from`. Candidates must have their
  // center (and near edge) beyond from's center on that axis. Ones that line up
  // with `from` (overlap on the other axis) always win. Otherwise Left and Right
  // find nothing, and Up and Down take the nearest thing wholly above or below.
  // Score = gap along the axis plus twice the off-axis center distance.
  // Returns the candidate index or -1.
  function pickNext(from, rects, dir) {
    var horizontal = dir === 'left' || dir === 'right';
    var sign = (dir === 'right' || dir === 'down') ? 1 : -1;
    var fcx = from.left + from.width / 2;
    var fcy = from.top + from.height / 2;
    var best = -1;
    var bestScore = Infinity;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (!r) continue;
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var along = horizontal ? (cx - fcx) * sign : (cy - fcy) * sign;
      if (along <= 1) continue;
      // The near edge must also be past from's center, so a taller neighbor
      // in the same row doesn't count as "below".
      if (dir === 'right' ? r.left < fcx : dir === 'left' ? r.right > fcx :
          dir === 'down' ? r.top < fcy : r.bottom > fcy) continue;
      var gap;
      if (dir === 'right') gap = r.left - from.right;
      else if (dir === 'left') gap = from.left - r.right;
      else if (dir === 'down') gap = r.top - from.bottom;
      else gap = from.top - r.bottom;
      if (gap < 0) gap = 0;
      var off = horizontal ? Math.abs(cy - fcy) : Math.abs(cx - fcx);
      var overlap = horizontal ?
        (r.top < from.bottom - 1 && r.bottom > from.top + 1) :
        (r.left < from.right - 1 && r.right > from.left + 1);
      if (!overlap) {
        // Left and Right stay in the row. Without this, Right from the last
        // item of a short row jumps diagonally to the row above.
        if (horizontal) continue;
        // Up and Down may go diagonally (items to the Full screen button),
        // but only to something wholly above or below, not alongside.
        if (dir === 'down' ? r.top < from.bottom - 1 : r.bottom > from.top + 1) continue;
      }
      var score = gap + 2 * off + along * 0.01 - (overlap ? 100000 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function dirOf(code) {
    if (code === KEY.LEFT) return 'left';
    if (code === KEY.RIGHT) return 'right';
    if (code === KEY.UP) return 'up';
    if (code === KEY.DOWN) return 'down';
    return null;
  }

  /* ---------- motion ---------- */

  // auto starts at the top rung and steps down when a rung stutters twice.
  var LADDER = ['push', 'expand', 'fade'];
  var RETRY_MS = 24 * 60 * 60 * 1000;   // how long a step-down lasts
  var HITCH_MS = 100;                   // a frame gap this long is a stall
  var HITCH_MAX = 3;                    // stalls (or more) that make a run janky
  var FREEZE_MS = 400;                  // one gap this long is a freeze by itself
  var JANKY_RUNS = 3;                   // janky runs in a row that step down
  // No timing in the first minute after the page loads: the TV is still
  // busy starting up (scripts, pictures, the first live data), and runs
  // timed then read a fast TV as slow. ?settle=<ms> changes it (tests).
  var SETTLE_MS = 60 * 1000;
  var loadedAt = Date.now();

  var motion = {
    mode: 'push',         // what runs now: 'push' | 'expand' | 'fade'
    source: 'auto',       // 'auto' | 'config' | 'URL'
    measuring: false,
    fps: 0,
    worst: 0,             // the longest single frame gap (ms) of the run that stepped down
    clean: [],            // fps of clean runs at the current rung
    janky: []             // fps of janky runs at the current rung
  };

  function isMode(m) { return m === 'push' || m === 'expand' || m === 'fade'; }

  function readQuery(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function loadStored() {
    try {
      var raw = window.localStorage && localStorage.getItem(MOTION_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !isMode(data.mode)) return null;
      // A new build keeps a good result (the top rung, timed clean): it
      // stays on and is timed again once the TV has settled. Anything else
      // from an older build starts over from the top rung.
      if (data.build !== BUILD) {
        if (data.mode !== LADDER[0] || data.measuring) return null;
        return { mode: data.mode, fps: data.fps || 0, measuring: true, carried: true };
      }
      // A step-down is only for a day: after that the top rung is timed
      // again, so a few stalls can't lock extras off for good.
      if (data.mode !== LADDER[0] && data.at && Date.now() - data.at > RETRY_MS) return null;
      return data;
    } catch (e) { return null; }
  }

  function store(data) {
    try { if (window.localStorage) localStorage.setItem(MOTION_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  function setupMotion() {
    var wanted = readQuery('motion');
    var source = 'URL';
    if (!isMode(wanted) && wanted !== 'auto') {
      wanted = cfg.motion;
      source = 'config';
    }
    if (isMode(wanted)) {
      motion.mode = wanted;
      motion.source = source;
      return;
    }
    motion.source = 'auto';
    var settle = parseInt(readQuery('settle'), 10);
    if (settle >= 0) SETTLE_MS = settle;
    var stored = loadStored();
    if (stored) {
      motion.mode = stored.mode;
      motion.fps = stored.fps || 0;
      motion.worst = stored.worst || 0;
      // A rung reached by stepping down is still being timed.
      motion.measuring = !!stored.measuring && stored.mode !== 'fade';
      return;
    }
    motion.mode = LADDER[0];
    motion.measuring = true;
  }

  // In push and expand mode the tiles stay on their own layers, so they
  // aren't re-rastered at the moment the animation starts.
  function markMotion() {
    for (var i = 0; i < LADDER.length; i++) document.body.classList.remove('motion-' + LADDER[i]);
    document.body.classList.add('motion-' + motion.mode);
  }

  function motionStatus() {
    var s = 'Motion: ' + motion.mode;
    if (motion.source !== 'auto') return s + ' (' + motion.source + ')';
    if (motion.measuring) return s + ' (auto, measuring)';
    return s + ' (auto' + (motion.fps ? ', ' + motion.fps + ' fps' : '') +
      (motion.worst ? ', stalled ' + motion.worst + ' ms' : '') + ')';
  }

  function announceStatus() {
    for (var i = 0; i < widgets.length; i++) call(widgets[i], 'onStatus', [widgets[i].ctx]);
  }

  // Samples frame times while a push or expand transition runs. Returns
  // stop(skip): skip is the [start, end] of work the hub itself did on the main
  // thread during the transition (building the panel), or null.
  function startSampling() {
    if (!motion.measuring || motion.mode === 'fade' || !window.requestAnimationFrame) return function () {};
    if (Date.now() - loadedAt < SETTLE_MS) return function () {};
    var times = [];
    var running = true;
    var rung = motion.mode;
    function frame(t) {
      if (!running) return;
      times.push(t);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return function (skip) {
      running = false;
      if (document.hidden || rung !== motion.mode) return;
      recordRun(times, skip);
    };
  }

  function recordRun(times, skip) {
    // Ignore the first frame: it often carries the cost of starting the transition.
    // Also ignore the gaps the panel build caused: the one it ran in and the
    // next one, which paints what it built. That is our work, not the TV
    // failing to keep up.
    var skipUntil = -1;
    if (skip) {
      for (var k = 0; k < times.length; k++) if (times[k] >= skip[1]) { skipUntil = times[k]; break; }
      if (skipUntil < 0) skipUntil = Infinity;
    }
    var gaps = [];
    for (var i = 2; i < times.length; i++) {
      if (skip && times[i] > skip[0] && times[i - 1] <= skipUntil) continue;
      gaps.push(times[i] - times[i - 1]);
    }
    // Too little left to judge: count the run as neither clean nor janky.
    if (gaps.length < 2) return;
    var total = 0;
    var worst = 0;
    var stalls = 0;
    for (var j = 0; j < gaps.length; j++) {
      total += gaps[j];
      if (gaps[j] > worst) worst = gaps[j];
      if (gaps[j] > HITCH_MS) stalls++;
    }
    var fps = gaps.length && total > 0 ? Math.round(gaps.length * 1000 / total) : 0;
    // Sustained speed decides, not one long frame: a single stall (a panel
    // paint, a live update) is not the TV failing to keep up.
    var janky = fps < 40 || stalls >= HITCH_MAX || worst > FREEZE_MS;
    if (janky) { motion.janky.push(fps); motion.worstJanky = Math.max(motion.worstJanky || 0, Math.round(worst)); }
    else motion.clean.push(fps);

    if (motion.janky.length >= JANKY_RUNS) {
      // Step down one rung. Fade is the last one, so it ends the timing.
      var next = LADDER[LADDER.indexOf(motion.mode) + 1] || 'fade';
      motion.fps = average(motion.janky);
      motion.worst = motion.worstJanky && motion.worstJanky > HITCH_MS ? motion.worstJanky : 0;
      motion.worstJanky = 0;
      motion.mode = next;
      motion.clean = [];
      motion.janky = [];
      motion.measuring = next !== 'fade';
      store({ mode: next, build: BUILD, fps: motion.fps, worst: motion.worst, measuring: motion.measuring, at: Date.now() });
      markMotion();
      fxHook('motionChanged');
      announceStatus();
    } else if (motion.clean.length >= 3) {
      motion.measuring = false;
      motion.fps = average(motion.clean);
      motion.worst = 0;
      store({ mode: motion.mode, build: BUILD, fps: motion.fps, at: Date.now() });
      announceStatus();
    }
  }

  function average(list) {
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += list[i];
    return list.length ? Math.round(sum / list.length) : 0;
  }

  /* ---------- browser version ---------- */

  // e.g. 'Chrome 63 · Tizen 5.0', or '' if the user agent says neither.
  var browserText = (function () {
    var ua = navigator.userAgent || '';
    var parts = [];
    var chrome = /Chrome\/(\d+)/.exec(ua);
    var tizenVer = /Tizen\s*(\d+(?:\.\d+)?)/.exec(ua);
    if (chrome) parts.push('Chrome ' + chrome[1]);
    if (tizenVer) parts.push('Tizen ' + tizenVer[1]);
    return parts.join(' · ');
  })();

  /* ---------- geometry ---------- */

  function remPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  // Each tile's resting rect, from offsets, so transforms never skew it.
  function measureHome() {
    var g = gridEl.getBoundingClientRect();
    for (var i = 0; i < widgets.length; i++) {
      var rec = widgets[i];
      var left = g.left + rec.cell.offsetLeft + rec.tile.offsetLeft;
      var top = g.top + rec.cell.offsetTop + rec.tile.offsetTop;
      var w = rec.tile.offsetWidth;
      var h = rec.tile.offsetHeight;
      rec.home = { left: left, top: top, width: w, height: h, right: left + w, bottom: top + h };
    }
  }

  // The panel's resting rect in panel mode: 46rem wide, centered, and as
  // tall as the widget's content (measured the first time it opens, see
  // fitPanel), at most 26rem and at least 10rem. Without a rec: 26rem.
  var panelFit = {};             // widget id: content height in px at the rem it was measured at
  function panelRect(rec) {
    var rem = remPx();
    var W = window.innerWidth;
    var H = window.innerHeight;
    // A one-widget layout's window for a widget made for full screen (the
    // Architecture map): most of the screen, the picture showing round it.
    if (rec && rec === soloRec && wantsFull(rec.w)) {
      var sw = Math.round(W * 0.86);
      var sh = Math.round(H * 0.84);
      var sl = Math.round((W - sw) / 2);
      var st = Math.round((H - sh) / 2);
      return { left: sl, top: st, width: sw, height: sh, right: sl + sw, bottom: st + sh };
    }
    var w = 46 * rem;
    var h = 26 * rem;
    var fit = rec && rec.w && panelFit.hasOwnProperty(rec.w.id) ? panelFit[rec.w.id] : null;
    if (fit) h = Math.max(10 * rem, Math.min(h, fit.px * rem / fit.rem));
    var left = (W - w) / 2;
    var top = (H - h) / 2;
    return { left: left, top: top, width: w, height: h, right: left + w, bottom: top + h };
  }

  /*
   * Push mode: where every other tile goes while a panel is open. Pure:
   * rects (null = leave alone), the panel rect P, screen W x H, outer margin m
   * and gap g in, target rects { left, top, width, height, scale } out.
   * Tiles go to a band around P by their home center (left or right column,
   * else top or bottom band; a tile that would shrink below 0.4 in the top or
   * bottom band goes to the nearer column), shrink uniformly to the band's thickness, then
   * further if the band is too short. Across the band they hug the screen
   * edge; along it they keep an edge that touches the band's end, otherwise
   * their center, and two passes remove overlaps.
   */
  function ringLayout(rects, P, W, H, m, g) {
    var bands = {
      left:   { vertical: true,  thick: P.left - g - m,   start: m,      end: H - m,   items: [] },
      right:  { vertical: true,  thick: W - m - P.right - g, start: m,   end: H - m,   items: [] },
      top:    { vertical: false, thick: P.top - g - m,    start: P.left, end: P.right, items: [] },
      bottom: { vertical: false, thick: H - m - P.bottom - g, start: P.left, end: P.right, items: [] }
    };
    var out = [];
    var i;
    for (i = 0; i < rects.length; i++) {
      out.push(null);
      var r = rects[i];
      if (!r) continue;
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var name = cx < P.left ? 'left' : cx > P.right ? 'right' : cy < H / 2 ? 'top' : 'bottom';
      // A tall tile in a short top or bottom band would become an unreadable
      // sliver, so it joins the nearer column instead.
      if ((name === 'top' || name === 'bottom') && bands[name].thick / r.height < 0.4) {
        name = cx < W / 2 ? 'left' : 'right';
      }
      bands[name].items.push(i);
    }
    for (var key in bands) {
      if (!bands.hasOwnProperty(key)) continue;
      var b = bands[key];
      var n = b.items.length;
      if (!n) continue;
      var list = [];
      var sum = 0;
      for (i = 0; i < n; i++) {
        var rr = rects[b.items[i]];
        var tileThick = b.vertical ? rr.width : rr.height;
        var tileLen = b.vertical ? rr.height : rr.width;
        var s = Math.max(0.01, Math.min(1, b.thick / tileThick));
        list.push({ idx: b.items[i], r: rr, s: s, len: tileLen * s, a0: b.vertical ? rr.top : rr.left, tileLen: tileLen });
        sum += tileLen * s;
      }
      var room = b.end - b.start - g * (n - 1);
      if (sum > room) {
        var f = room / sum;
        for (i = 0; i < n; i++) { list[i].s *= f; list[i].len *= f; }
      }
      list.sort(function (p, q) { return p.a0 - q.a0; });
      for (i = 0; i < n; i++) {
        var it = list[i];
        var a1 = it.a0 + it.tileLen;
        if (Math.abs(it.a0 - b.start) <= 2) it.st = b.start;
        else if (Math.abs(a1 - b.end) <= 2) it.st = b.end - it.len;
        else it.st = (it.a0 + a1) / 2 - it.len / 2;
      }
      for (i = 0; i < n; i++) {
        var min = i === 0 ? b.start : list[i - 1].st + list[i - 1].len + g;
        if (list[i].st < min) list[i].st = min;
      }
      for (i = n - 1; i >= 0; i--) {
        var max = i === n - 1 ? b.end : list[i + 1].st - g;
        if (list[i].st + list[i].len > max) list[i].st = max - list[i].len;
      }
      for (i = 0; i < n; i++) {
        var t = list[i];
        var w = t.r.width * t.s;
        var h = t.r.height * t.s;
        var left, top;
        if (b.vertical) {
          top = t.st;
          left = key === 'left' ? m : W - m - w;
        } else {
          left = t.st;
          top = key === 'top' ? m : H - m - h;
        }
        out[t.idx] = { left: left, top: top, width: w, height: h, right: left + w, bottom: top + h, scale: t.s };
      }
    }
    return out;
  }

  function ringTargets(opener) {
    var rem = remPx();
    var rects = [];
    for (var i = 0; i < widgets.length; i++) rects.push(widgets[i] === opener ? null : widgets[i].home);
    return ringLayout(rects, panelRect(opener), window.innerWidth, window.innerHeight, 1.2 * rem, 0.9 * rem);
  }

  // For tests in a laptop browser. Not used by the hub itself.
  window.HUB_TEST = {
    ringLayout: ringLayout,
    // Feeds frame times (ms, one list per run) to the motion timing from the
    // top rung, as if opening panels had produced them; returns where it ended.
    motionRuns: function (runs) {
      motion.mode = LADDER[0]; motion.source = 'auto'; motion.measuring = true;
      motion.fps = 0; motion.worst = 0; motion.worstJanky = 0; motion.clean = []; motion.janky = [];
      for (var i = 0; i < runs.length; i++) { if (motion.measuring) recordRun(runs[i], null); }
      return { mode: motion.mode, measuring: motion.measuring, fps: motion.fps, worst: motion.worst, status: motionStatus() };
    },
    // The timing as it stands: { mode, measuring, runs } (runs: clean + janky timed at this rung).
    motionState: function () {
      return { mode: motion.mode, measuring: motion.measuring, runs: motion.clean.length + motion.janky.length };
    },
    panelRect: function () { return panelRect(open); },
    homeRects: function () {
      var out = {};
      for (var i = 0; i < widgets.length; i++) out[widgets[i].w.id] = widgets[i].home;
      return out;
    }
  };

  /* ---------- background and glass ---------- */

  var hasPicture = false;

  // A tiny, smooth copy of the picture, for the frosted surfaces. Downscaling
  // in two steps is the blur. Returns '' if the canvas can't be read
  // (a picture from another site).
  function blurredCopy(img) {
    try {
      var W = window.innerWidth;
      var H = window.innerHeight;
      var iw = img.naturalWidth;
      var ih = img.naturalHeight;
      // Crop like background-size: cover.
      var k = Math.max(W / iw, H / ih);
      var sw = W / k;
      var sh = H / k;
      var a = document.createElement('canvas');
      a.width = 320;
      a.height = Math.round(320 * H / W);
      a.getContext('2d').drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, a.width, a.height);
      var b = document.createElement('canvas');
      b.width = 64;
      b.height = Math.round(64 * H / W);
      b.getContext('2d').drawImage(a, 0, 0, a.width, a.height, 0, 0, b.width, b.height);
      return b.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      return '';
    }
  }

  // A softer copy of the picture (384 px wide, one canvas, made once): the
  // clear window of each tile shows it, so a busy picture is calmed without
  // a blur filter. '' if the canvas can't be read.
  function softCopy(img) {
    try {
      var W = window.innerWidth;
      var H = window.innerHeight;
      var k = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      var sw = W / k;
      var sh = H / k;
      var a = document.createElement('canvas');
      a.width = 384;
      a.height = Math.round(384 * H / W);
      a.getContext('2d').drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, a.width, a.height);
      return a.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      return '';
    }
  }

  // The picture's brightness on a 160-pixel-wide grid, kept once for placeGlass
  // (the veil of each tile). null if the canvas can't be read: the tiles keep
  // the veil the stylesheet gives them.
  var veil = null;

  function readVeil(img) {
    try {
      var W = window.innerWidth;
      var H = window.innerHeight;
      var k = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      var sw = W / k;
      var sh = H / k;
      var c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.max(1, Math.round(160 * H / W));
      var cx = c.getContext('2d');
      cx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
      var px = cx.getImageData(0, 0, c.width, c.height).data;
      var lum = [];
      for (var i = 0; i < px.length; i += 4) lum.push((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255);
      return { w: c.width, h: c.height, lum: lum };
    } catch (e) {
      return null;
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // How strong the veil over a tile's window is: the brighter or busier the
  // picture behind the tile, the stronger. Night: a dark veil (--veil-a), day:
  // a milky one (--veil-l); the stylesheet picks by theme.
  function placeVeil(tile, r) {
    if (!veil) return;
    var kx = veil.w / window.innerWidth;
    var ky = veil.h / window.innerHeight;
    var n = 0;
    var s = 0;
    var s2 = 0;
    for (var y = Math.floor(r.top * ky); y < Math.min(veil.h, r.bottom * ky); y++) {
      for (var x = Math.floor(r.left * kx); x < Math.min(veil.w, r.right * kx); x++) {
        if (x < 0 || y < 0) continue;
        var l = veil.lum[y * veil.w + x];
        n++;
        s += l;
        s2 += l * l;
      }
    }
    if (!n) return;
    var m = s / n;
    var sd = Math.sqrt(Math.max(0, s2 / n - m * m));
    tile.style.setProperty('--veil-a', clamp(0.18 + 0.62 * m + 1.4 * sd, 0.28, 0.82).toFixed(2));
    tile.style.setProperty('--veil-l', clamp(0.36 + 0.55 * (1 - m) + 1.2 * sd, 0.40, 0.86).toFixed(2));
  }

  /* Which picture: cfg.background 'auto' picks from HUB_BACKGROUNDS
     (app/backgrounds/backgrounds.js) by the look: list[dayNumber % length],
     dayNumber being the days since 1970 on the TV's local date. ?bg=day/N or
     ?bg=night/N forces entry N (from 0) of that list. A file or URL is one
     picture for both looks. '' or null: none. */
  var picture = null; // the picture on screen: { file, title, credit }
  var picLabelEl = document.getElementById('picLabel');

  // The corner label (cfg.pictureLabel): the picture's title, shown on the home screen only.
  function syncPicLabel() {
    if (!picLabelEl) return;
    var text = cfg.pictureLabel === false || !picture ? '' : (picture.title || '');
    if (picLabelEl.textContent !== text) picLabelEl.textContent = text;
    var on = !!text && !open && !frameOpen;
    picLabelEl.className = on ? 'pic-label is-on' : 'pic-label';
  }

  function dayNumber() {
    var d = new Date();
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

  function pictureFor(look) {
    var src = cfg.background;
    if (!src) return null;
    if (src !== 'auto') return { file: String(src), title: '', credit: '' };
    var lists = window.HUB_BACKGROUNDS;
    var list = lists && lists[look];
    if (!list || !list.length) return null;
    var n = dayNumber();
    var m = /^(day|night)\/(\d+)$/.exec(readQuery('bg') || '');
    if (m && m[1] === look) n = parseInt(m[2], 10);
    var pick = list[n % list.length];
    if (!pick) return null;
    // HUB_BACKGROUNDS.base is put before a file that isn't a full address.
    var file = String(pick.file || '');
    if (!/^https?:\/\//i.test(file)) file = String(lists.base || '') + file;
    return { file: file, title: pick.title || '', credit: pick.credit || '' };
  }

  // Loads a picture, then calls done(img), or done(null) if it fails.
  function loadPicture(pic, done) {
    var img = new Image();
    // A picture from another site (a jsDelivr branch) must ask to be read, or
    // the canvas copies for the glass would be blocked.
    if (/^https?:\/\//i.test(pic.file)) img.crossOrigin = 'anonymous';
    img.onload = function () { done(img); };
    img.onerror = function () { done(null); };
    img.src = pic.file;
  }

  // Puts a loaded picture behind the tiles: the backdrop, the blurred and
  // soft copies for the glass, the veil grid, then the glass itself.
  function applyPicture(pic, img) {
    picture = pic;
    hasPicture = true;
    syncPicLabel();
    backdropEl.style.backgroundImage = 'url("' + pic.file + '")';
    document.body.classList.add('has-picture');
    if (cfg.glass === false) return;
    var root = document.documentElement;
    var data = blurredCopy(img);
    if (data) root.style.setProperty('--glass-img', 'url("' + data + '")');
    else root.style.removeProperty('--glass-img');
    var soft = softCopy(img);
    if (soft) root.style.setProperty('--soft-img', 'url("' + soft + '")');
    else root.style.removeProperty('--soft-img');
    veil = readVeil(img);
    document.body.classList.add('is-glass');
    // An old engine may not take url() through a custom property, or may
    // drop the whole background. Then fall back to the plain tint.
    document.body.classList.remove('glass-tint-only');
    if (data && widgets.length) {
      var bg = getComputedStyle(widgets[0].tile).backgroundImage || '';
      if (bg.indexOf('url(') === -1) document.body.classList.add('glass-tint-only');
    }
    placeGlass();
    // The glass look has its own border and padding (theme.css): the room the titles have changes a little.
    retitleAll();
  }

  function setupBackground() {
    var pic = pictureFor(theme.look || wantedTheme().look);
    if (!pic) return;
    loadPicture(pic, function (img) {
      if (img) return applyPicture(pic, img);
      // The picture's host can't be reached: the manifest's fallback (a file
      // next to hub.html), else the plain dark look.
      var fb = cfg.background === 'auto' && window.HUB_BACKGROUNDS ? window.HUB_BACKGROUNDS.fallback : null;
      if (!fb || !fb.file || fb.file === pic.file) return;
      var alt = { file: String(fb.file), title: fb.title || '', credit: fb.credit || '' };
      loadPicture(alt, function (img2) { if (img2) applyPicture(alt, img2); });
    });
  }

  // For the About panel: "Navagio, Zakynthos · Photo: Name, CC BY-SA 4.0".
  function pictureStatus() {
    if (!picture) return '';
    var parts = [];
    var title = picture.title || (picture.credit ? '' : String(picture.file).split('/').pop());
    if (title) parts.push(title);
    if (picture.credit) parts.push(picture.credit);
    return parts.join(' \u00b7 ');
  }

  // Lines up the blurred picture on a surface with the spot it covers.
  function setGlassOrigin(node, left, top) {
    node.style.setProperty('--gx', -left + 'px');
    node.style.setProperty('--gy', -top + 'px');
  }

  function placeGlass() {
    if (!hasPicture) return;
    for (var i = 0; i < widgets.length; i++) {
      var rec = widgets[i];
      if (!rec.home) continue;
      setGlassOrigin(rec.tile, rec.home.left + rec.tile.clientLeft, rec.home.top + rec.tile.clientTop);
      placeVeil(rec.tile, rec.home);
    }
    placeFloatingGlass(ghostEl);
  }

  // The ghost is fixed, so its offsets are screen positions that ignore
  // transforms. Its panel-size rect only depends on the window, so this runs
  // at start, on resize and when it changes size class.
  function placeFloatingGlass(node) {
    if (!hasPicture) return;
    setGlassOrigin(node, node.offsetLeft + node.clientLeft, node.offsetTop + node.clientTop);
  }

  /* ---------- day and night ---------- */

  // The look: day (light glass, dark text) between sunrise and sunset, night
  // (dark glass) otherwise. Sunrise and sunset come from the Weather widget's
  // forecast; without one, day is 7:00 AM to 6:00 PM on the TV's clock.
  // HUB_CONFIG.theme ('auto' | 'day' | 'night') or ?theme=day|night on the
  // address sets it by hand. Checked once a minute. The stylesheet is
  // app/theme.css (body.theme-day, body.theme-night).
  var DAY_FROM = 7;
  var DAY_TO = 18;
  var theme = { look: '', source: 'auto', sunrise: '', sunset: '', timer: null, fading: false };

  // The choice made on the Clock page: 'auto' (sun), 'day' (Light) or 'night'
  // (Dark), kept on this screen in localStorage so each screen can differ.
  // ?theme= on the address still wins; this beats HUB_CONFIG.theme.
  var LOOK_KEY = 'homeHub.look';
  var lookNow = null;   // the choice held in memory too, for a TV whose localStorage fails
  function savedLook() {
    if (lookNow) return lookNow;
    try {
      var v = window.localStorage && window.localStorage.getItem(LOOK_KEY);
      return v === 'day' || v === 'night' ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  window.HUB_LOOK = {
    get: function () { return savedLook(); },
    set: function (v) {
      lookNow = v === 'day' || v === 'night' ? v : 'auto';
      try {
        if (window.localStorage) {
          if (v === 'day' || v === 'night') window.localStorage.setItem(LOOK_KEY, v);
          else window.localStorage.removeItem(LOOK_KEY);
        }
      } catch (e) { /* not kept; lookNow still holds it until the page reloads */ }
      checkTheme();
    }
  };

  function sunTimes() {
    try {
      var rec = widgetById('weather');
      var fn = rec && rec.w ? rec.w.sunNow : null;
      return typeof fn === 'function' ? fn() : null;
    } catch (e) { return null; }
  }

  function wantedTheme() {
    var q = readQuery('theme');
    var source = 'URL';
    if (q !== 'day' && q !== 'night') {
      q = savedLook();
      source = 'chosen';
      if (q === 'auto') { q = cfg.theme; source = 'config'; }
    }
    if (q === 'day' || q === 'night') return { look: q, source: source, sunrise: '', sunset: '' };
    var sun = sunTimes();
    if (sun) return { look: sun.day ? 'day' : 'night', source: 'auto', sunrise: sun.sunrise, sunset: sun.sunset };
    var h = new Date().getHours();
    return { look: h >= DAY_FROM && h < DAY_TO ? 'day' : 'night', source: 'auto', sunrise: '', sunset: '' };
  }

  function paintTheme(look) {
    theme.look = look;
    document.body.classList.remove('theme-day');
    document.body.classList.remove('theme-night');
    document.body.classList.add('theme-' + look);
  }

  // One quick fade of the stage (out 140 ms, in 220 ms) over the change; at
  // once when the hub is on plain fades or something is open or moving. The
  // new look's picture (pic, already loaded as img) goes on under the same fade.
  function switchTheme(look, pic, img) {
    function paint() {
      paintTheme(look);
      if (pic && img) applyPicture(pic, img);
    }
    if (!theme.look || motion.mode === 'fade' || open || busy || frameOpen || theme.fading) return paint();
    theme.fading = true;
    setOpacity(stageEl, 0, 140);
    setTimeout(function () {
      paint();
      setOpacity(stageEl, 1, 220);
      setTimeout(function () {
        stageEl.style.transition = '';
        stageEl.style.opacity = '';
        theme.fading = false;
      }, 240);
    }, 150);
  }

  function checkTheme() {
    clearTimeout(theme.timer);
    var want = wantedTheme();
    theme.source = want.source;
    theme.sunrise = want.sunrise;
    theme.sunset = want.sunset;
    theme.timer = setTimeout(checkTheme, 60000);
    if (want.look === theme.look) return;
    // The first look is painted at once; setupBackground picks its picture.
    var pic = theme.look ? pictureFor(want.look) : null;
    if (!pic || (picture && pic.file === picture.file)) return switchTheme(want.look);
    // Load the new picture first; if it fails, keep the old one and still switch the look.
    loadPicture(pic, function (img) { switchTheme(want.look, pic, img); });
  }

  // For the About panel: "night (auto, until 7:04 AM)", the next change.
  function themeStatus() {
    if (!theme.look) return '';
    if (theme.source !== 'auto') return theme.look + ' (' + theme.source + ')';
    var next = theme.look === 'day' ? theme.sunset || '6:00 PM' : theme.sunrise || '7:00 AM';
    return theme.look + ' (auto, until ' + next + ')';
  }

  function scrimLevel() { return hasPicture ? 0.6 : 0.72; }

  /* ---------- panel and ghost geometry ---------- */

  function rectOf(node) {
    var r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }

  // Transform that makes a box at `to` sit exactly over `from`.
  function flip(from, to) {
    var sx = from.width / to.width;
    var sy = from.height / to.height;
    return 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + sx + ',' + sy + ')';
  }

  var IDENTITY = 'translate(0px,0px) scale(1,1)';

  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  // Panel content sitting on the tile: centered on it, scaled evenly to fit
  // inside it. It then grows with the ghost and always stays inside it.
  function panelStart(tile, P) {
    var s = Math.min(tile.width / P.width, tile.height / P.height);
    var a = center(tile);
    var b = center(P);
    return 'translate(' + (a.x - b.x) + 'px,' + (a.y - b.y) + 'px) scale(' + s + ',' + s + ')';
  }

  // The tile moved so its center sits on the panel's center, scaled evenly
  // as far as still fits inside the panel, so its content grows with the
  // ghost and never pokes out of it. Tiles scale from their top-left corner.
  function tileToCenter(tile, P) {
    var k = Math.min(P.width / tile.width, P.height / tile.height);
    var a = center(tile);
    var b = center(P);
    var x = b.x - a.x + (1 - k) * tile.width / 2;
    var y = b.y - a.y + (1 - k) * tile.height / 2;
    return 'translate(' + x + 'px,' + y + 'px) scale(' + k + ')';
  }

  var TILE_HOME = 'translate(0px,0px) scale(1)';

  // Back to rest: invisible, panel size, no transform. Its layer stays.
  function parkGhost() {
    var wasFull = hasClass(ghostEl, 'is-full');
    ghostEl.style.transition = 'none';
    ghostEl.style.opacity = '0';
    ghostEl.style.transform = IDENTITY;
    ghostEl.className = 'ghost';
    if (wasFull) placeFloatingGlass(ghostEl);
  }

  // The panel and its frame at P's height (panel mode), or back to the
  // style sheet's sizes (P null: full screen, or parked).
  function sizeBoxes(P) {
    var nodes = [panelEl, ghostEl];
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].style.height = P ? P.height + 'px' : '';
      nodes[i].style.marginTop = P ? (-P.height / 2) + 'px' : '';
    }
    placeFloatingGlass(ghostEl);
  }

  // How tall the open panel's content wants to be, in px: the head, then
  // the lowest child of the body (a child that stretches to fill reports
  // the body's own height, so filling panels keep their full size).
  // Offsets only, so it is right while the panel is scaled mid-grow.
  function contentHeight() {
    var body = panel.body;
    var max = 0;
    for (var c = body.firstElementChild; c; c = c.nextElementSibling) {
      var cs = getComputedStyle(c);
      if (cs.position === 'absolute' || cs.position === 'fixed') { max = Math.max(max, body.clientHeight); continue; }
      if (cs.display === 'none') continue;
      max = Math.max(max, c.offsetTop + c.offsetHeight + (parseFloat(cs.marginBottom) || 0));
    }
    var ps = getComputedStyle(panelEl);
    return body.offsetTop + max + (parseFloat(ps.paddingBottom) || 0) + (parseFloat(ps.borderBottomWidth) || 0);
  }

  // The open panel's content changed (a redraw, another view): the box
  // follows at once, measured with the box at its tallest so content that
  // stretches shows its real need. Panel mode only, never mid-move.
  function refitOpen() {
    if (!open || mode !== 'panel' || busy) return;
    var before = panelEl.offsetHeight;
    sizeBoxes(panelRect(null));
    var px = contentHeight();
    if (px > 0) panelFit[open.w.id] = { px: Math.ceil(px), rem: remPx() };
    var h = panelRect(open).height;
    // Small shrinks are left alone, so the box doesn't twitch on each redraw.
    if (h < before && before - h <= 24) h = before;
    sizeBoxes({ height: h });
    // Content that lays out by the box's height (a picture sized to it) may
    // need a little more at the new height: grow by what overflows, once.
    var max = panelRect(null).height;
    // (offsets, not scrollHeight: items mid-stagger are moved by transforms)
    var over = 0;
    for (var c = panel.body.firstElementChild; c; c = c.nextElementSibling) {
      if (c.offsetParent === panel.body) over = Math.max(over, Math.ceil(c.offsetTop + c.offsetHeight - panel.body.clientHeight));
    }
    if (over > 0 && h < max) {
      h = Math.min(max, h + over);
      sizeBoxes({ height: h });
      panelFit[open.w.id] = { px: Math.ceil(h), rem: remPx() };
    }
    if (panelFocus) keepInView(panelFocus);
  }

  // Remembers the open widget's content height; true when it changed by
  // more than 24px from what P (the rect it opened at) allowed.
  function fitPanel(rec, P) {
    var px = contentHeight();
    if (!(px > 0)) return false;
    panelFit[rec.w.id] = { px: Math.ceil(px), rem: remPx() };
    return Math.abs(panelRect(rec).height - P.height) > 24;
  }

  function clearTile(rec) {
    var s = rec.tile.style;
    s.transition = '';
    s.transform = '';
    s.opacity = '';
    rec.tile.classList.remove('is-lifted');
    rec.cell.classList.remove('is-raised');
  }

  function setOpacity(node, value, ms, delay) {
    node.style.transition = ms ? 'opacity ' + ms + 'ms linear' + (delay ? ' ' + delay + 'ms' : '') : 'none';
    node.style.opacity = String(value);
  }

  /* ---------- tile layout ---------- */

  // The layout can also come from the hub server on the Pi (the live
  // resource 'layout'), so it can change without editing config.js. The TV
  // keeps the last one it got and starts with it. HUB_CONFIG.layout stays the
  // built-in default, used as it is.
  var LAYOUT_KEY = 'homeHub.layout';
  var LAYOUT_RELOAD_KEY = 'homeHub.layout.reloaded';
  var GRID_COLS = 12;
  var GRID_ROWS = 6;
  var MAX_TILES = 24;
  var TILE_ID_RE = /^[a-z0-9-]{1,32}$/;
  var registry = {};          // widget id -> widget, from pickWidgets()
  var layoutKey = '';         // JSON of the layout on screen now
  var pendingLayout;          // undefined: nothing waiting; otherwise a list, or null for the built-in one

  function isWhole(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  // The same rules as the Pi (pi/server.js), but a bad entry is skipped
  // instead of refusing the lot: whole numbers inside the 12 x 6 grid, no
  // overlap with an earlier entry, each widget once, at most 24. Returns the
  // clean list (only the five fields), or null when nothing is left.
  function cleanLayout(raw) {
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') return null;
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length && out.length < MAX_TILES; i++) {
      var e = raw[i];
      if (!e || typeof e !== 'object') continue;
      var id = e.widget;
      // The retired All sounds widget is Now Playing now: a layout saved with it keeps its tile.
      if (id === 'allsounds') id = 'nowplaying';
      if (typeof id !== 'string' || !TILE_ID_RE.test(id) || seen.hasOwnProperty(id)) continue;
      if (!isWhole(e.x) || !isWhole(e.y) || !isWhole(e.w) || !isWhole(e.h)) continue;
      if (e.x < 0 || e.y < 0 || e.w < 1 || e.h < 1 || e.x + e.w > GRID_COLS || e.y + e.h > GRID_ROWS) continue;
      var clash = false;
      for (var j = 0; j < out.length; j++) {
        var o = out[j];
        if (e.x < o.x + o.w && o.x < e.x + e.w && e.y < o.y + o.h && o.y < e.y + e.h) { clash = true; break; }
      }
      if (clash) continue;
      seen[id] = true;
      out.push({ widget: id, x: e.x, y: e.y, w: e.w, h: e.h });
    }
    return out.length ? out : null;
  }

  // A clean layout that shows at least one widget this hub has, or null.
  function usableLayout(raw) {
    var list = cleanLayout(raw);
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (registry.hasOwnProperty(list[i].widget)) return list;
    return null;
  }

  function readSavedLayout() {
    try {
      var raw = window.localStorage && localStorage.getItem(LAYOUT_KEY);
      return raw ? usableLayout(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  // list null: forget the saved one, so the built-in layout is used.
  function saveLayout(list) {
    try {
      if (!window.localStorage) return;
      if (list) localStorage.setItem(LAYOUT_KEY, JSON.stringify(list));
      else localStorage.removeItem(LAYOUT_KEY);
    } catch (e) { /* ignore */ }
  }

  // The layout to build with at start.
  function startLayout() {
    var layout = readSavedLayout() || cfg.layout || [];
    layoutKey = JSON.stringify(layout);
    // The reload for this layout worked, so its note can go.
    try {
      if (window.sessionStorage && sessionStorage.getItem(LAYOUT_RELOAD_KEY) === layoutKey) sessionStorage.removeItem(LAYOUT_RELOAD_KEY);
    } catch (e) { /* ignore */ }
    return layout;
  }

  function placeCell(cell, entry) {
    cell.style.left = (entry.x / 12 * 100) + '%';
    cell.style.top = (entry.y / 6 * 100) + '%';
    cell.style.width = (entry.w / 12 * 100) + '%';
    cell.style.height = (entry.h / 6 * 100) + '%';
  }

  // A tile's size in grid cells, with a rough height tier and width class
  // that widgets and the CSS use to pick a layout (see ctx.size()).
  function sizeOf(entry) {
    var cols = entry && entry.w > 0 ? entry.w : 1;
    var rows = entry && entry.h > 0 ? entry.h : 1;
    return {
      cols: cols,
      rows: rows,
      tier: rows <= 1 ? 'strip' : rows === 2 ? 'standard' : 'tall',
      width: cols <= 2 ? 'narrow' : cols >= 6 ? 'wide' : 'standard'
    };
  }

  var SIZE_CLASSES = ['tile-h1', 'tile-h2', 'tile-h3', 'tile-wn', 'tile-wm', 'tile-ww', 'tile-w1'];

  // Puts the size classes on the tile: tile-h1 (one row, a strip), tile-h2,
  // tile-h3 (three rows or more), and tile-wn (one or two columns), tile-wm
  // (three to five) or tile-ww (six or more), plus tile-w1 on a tile one
  // column wide. Returns true when the size changed.
  function applySize(rec, entry) {
    var size = sizeOf(entry);
    var old = rec.size;
    rec.size = size;
    var want = [size.tier === 'strip' ? 'tile-h1' : size.tier === 'standard' ? 'tile-h2' : 'tile-h3',
      size.width === 'narrow' ? 'tile-wn' : size.width === 'wide' ? 'tile-ww' : 'tile-wm'];
    if (size.cols === 1) want.push('tile-w1');
    for (var i = 0; i < SIZE_CLASSES.length; i++) {
      var c = SIZE_CLASSES[i];
      if (want.indexOf(c) >= 0) rec.tile.classList.add(c);
      else rec.tile.classList.remove(c);
    }
    return !old || old.cols !== size.cols || old.rows !== size.rows;
  }

  // The widget ids a layout puts on screen, each once, sorted.
  function shownIds(layout) {
    var ids = [];
    for (var i = 0; i < layout.length; i++) {
      var id = layout[i] && layout[i].widget;
      if (typeof id === 'string' && registry.hasOwnProperty(id) && ids.indexOf(id) < 0) ids.push(id);
    }
    return ids.sort();
  }

  function onLayoutData(data) {
    try {
      if (!data || typeof data !== 'object') return;
      var list = usableLayout(data.layout);   // null, or nothing usable: the built-in layout
      // The Pi's layout is "Main". Always remember it; show it unless another
      // layout from the bar is on screen (that one stays until you pick again).
      saveLive(list);
      var choice = readChoice();
      if (choice && !isLiveChoice(choice)) return;
      saveLayout(list);
      pendingLayout = list;
      applyPendingLayout();
    } catch (e) {
      liveWarn('layout failed: ' + (e && e.message));
    }
  }

  // Applies a layout that came in, once nothing is open or moving.
  function applyPendingLayout() {
    if (pendingLayout === undefined || open || frameOpen || busy) return;
    var layout = pendingLayout || cfg.layout || [];
    pendingLayout = undefined;
    var key = JSON.stringify(layout);
    if (key === layoutKey) return;
    var onScreen = [];
    for (var i = 0; i < widgets.length; i++) onScreen.push(widgets[i].w.id);
    if (shownIds(layout).join(',') !== onScreen.sort().join(',')) {
      reloadForLayout(key);
      return;
    }
    // The same widgets: move their cells, then update what depends on where they are.
    var at = {};
    for (var j = 0; j < layout.length; j++) {
      if (layout[j] && !at.hasOwnProperty(layout[j].widget)) at[layout[j].widget] = layout[j];
    }
    var resized = [];
    for (var k = 0; k < widgets.length; k++) {
      var entry = at[widgets[k].w.id];
      placeCell(widgets[k].cell, entry);
      widgets[k].entry = entry;
      if (applySize(widgets[k], entry)) resized.push(widgets[k]);
    }
    layoutKey = key;
    measureHome();
    // Back to the top-left tile, unless the remote was used just now.
    if (new Date().getTime() - lastInputAt > FOCUS_KEEP_MS) focusHome(topLeftIndex());
    placeGlass();
    clayHook('layout');
    agentsHook('stop');
    // A tile of another size may want another layout: draw it again.
    for (var r = 0; r < resized.length; r++) drawTile(resized[r]);
    if (engaged && !canEngage(engaged)) disengage();   // too small now to use in place
    retitleAll();
    fxCall('relayout', [focusRect()]);
  }

  // Other widgets: build afresh. A note in sessionStorage keyed by the layout
  // makes sure this happens once per layout, never in a loop. Without
  // sessionStorage there is no reload at all.
  function reloadForLayout(key) {
    try {
      if (!window.sessionStorage || sessionStorage.getItem(LAYOUT_RELOAD_KEY) === key) return;
      sessionStorage.setItem(LAYOUT_RELOAD_KEY, key);
      if (sessionStorage.getItem(LAYOUT_RELOAD_KEY) !== key) return;
    } catch (e) { return; }
    layoutKey = key;
    location.reload();
  }

  function layoutChance() { setTimeout(applyPendingLayout, 0); }

  /* ---------- layout switcher ---------- */

  // Press Up on a top tile, or Left on a left-most one, and a bar of saved
  // layouts (HUB_CONFIG.layouts) drops from the top. Left and Right move, OK
  // applies one at once, and the one showing now has a star. The TV can't write to the Pi (that
  // needs its token), so the pick is kept here, with the Pi's layout at that
  // moment; it stays until someone sets another layout on the Pi.
  var CHOICE_KEY = 'homeHub.layoutChoice';
  var switcherEl = document.getElementById('switcher');
  var STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>';
  var sw = { on: false, index: 0, presets: [], nodes: [], built: false, hideTimer: null };

  // Order-free text for a layout, so two lists of the same tiles compare equal.
  function layoutSig(raw) {
    var list = cleanLayout(raw);
    if (!list) return '';
    list.sort(function (a, b) { return a.widget < b.widget ? -1 : a.widget > b.widget ? 1 : 0; });
    return JSON.stringify(list);
  }

  function readChoice() {
    try {
      var raw = window.localStorage && localStorage.getItem(CHOICE_KEY);
      var c = raw ? JSON.parse(raw) : null;
      return c && typeof c.id === 'string' ? c : null;
    } catch (e) { return null; }
  }

  function saveChoice(c) {
    try {
      if (!window.localStorage) return;
      if (c) localStorage.setItem(CHOICE_KEY, JSON.stringify(c));
      else localStorage.removeItem(CHOICE_KEY);
    } catch (e) { /* ignore */ }
  }

  // The Pi's own layout is the bar's "Main" (id 'main'): it always follows the
  // Pi, never a copy in config.js. The last one the Pi sent is kept here so
  // it is known at start and when the live line is down.
  var LIVE_KEY = 'homeHub.layout.live';

  function saveLive(list) {
    try { if (window.localStorage) localStorage.setItem(LIVE_KEY, JSON.stringify(list || null)); } catch (e) { /* ignore */ }
  }

  // { list } with the Pi's layout (null = the built-in one), or null when the Pi has not said yet.
  function liveMain() {
    var raw = window.HUB_LIVE && typeof window.HUB_LIVE.get === 'function' ? window.HUB_LIVE.get('layout') : null;
    if (raw && typeof raw === 'object') return { list: usableLayout(raw.layout) };
    try {
      var saved = window.localStorage && localStorage.getItem(LIVE_KEY);
      if (saved) return { list: usableLayout(JSON.parse(saved)) };
    } catch (e) { /* ignore */ }
    return null;
  }

  // No pick, or Main picked: the Pi's layout is the one on screen.
  function isLiveChoice(c) { return !c || c.live === true || c.id === 'main' || c.id === 'Main'; }

  // The saved layouts that can be used here: { name, layout (null = built-in) }.
  function switcherPresets() {
    var src = cfg.layouts;
    var out = [];
    if (!src || Object.prototype.toString.call(src) !== '[object Array]') return out;
    for (var i = 0; i < src.length; i++) {
      var p = src[i];
      if (!p || typeof p.name !== 'string' || !p.name) continue;
      var list = p.layout ? usableLayout(p.layout) : null;
      if (p.layout && !list) continue;
      var live = p.id === 'main';
      if (live) {
        var lm = liveMain();
        if (lm) list = lm.list;      // the Pi's Main (null = built-in); config.js's copy is only for before it has said
      }
      out.push({ name: p.name, id: typeof p.id === 'string' ? p.id : '', layout: list, live: live });
    }
    return out;
  }

  function presetSig(p) { return layoutSig(p.layout || cfg.layout); }

  // Guest mode off, on a TV where an older version swapped a
  // money layout out for Guest mode: back to the layout it came from. Guest
  // mode now only blurs the amounts (guest.js) and never changes the layout.
  function guestRestore(on) {
    if (on) return;
    var c = readChoice();
    if (!c || !c.guest) return;
    var all = switcherPresets();
    var from = null;
    for (var a = 0; a < all.length; a++) {
      if (c.from && (all[a].id || all[a].name) === c.from) from = all[a];
    }
    var back;
    if (from && !from.live) {
      saveChoice({ id: from.id || from.name });
      back = from.layout;
    } else {
      saveChoice(null);
      var lm = liveMain();
      back = lm ? lm.list : null;
    }
    saveLayout(back);
    pendingLayout = back;
    layoutChance();
  }

  try { if (window.HUB_GUEST) window.HUB_GUEST.onChange(guestRestore); } catch (e) { /* no Guest mode on this page */ }

  // A preset's name in the hub's language (key 'hub.layout.<id>'); a layout
  // named by the owner, with no Spanish for its id, keeps its own name.
  function layoutName(p) {
    var L = window.HUB_I18N;
    if (!p.id || !L || typeof L.has !== 'function' || !L.has('hub.layout.' + p.id)) return p.name;
    return hubWord('layout.' + p.id, p.name);
  }

  function drawSwitcher() {
    switcherEl.innerHTML = '';
    sw.bar = el('div', 'switcher-bar', switcherEl);
    var current = layoutSig(layoutKey ? JSON.parse(layoutKey) : null);
    sw.nodes = [];
    sw.index = 0;
    // Two layouts can look the same (Main with no Pi layout is Default): the
    // one picked gets the star.
    var chosen = readChoice();
    var star = -1;
    for (var m = 0; m < sw.presets.length; m++) {
      if (presetSig(sw.presets[m]) !== current) continue;
      if (star < 0) star = m;
      if (chosen && (sw.presets[m].id || sw.presets[m].name) === chosen.id) { star = m; break; }
    }
    for (var i = 0; i < sw.presets.length; i++) {
      var node = el('div', 'switcher-item', sw.bar);
      node.setAttribute('role', 'menuitem');
      if (i === star) {
        node.classList.add('is-active');
        node.setAttribute('aria-current', 'true');
        el('span', 'switcher-star', node).innerHTML = STAR_SVG;
        sw.index = i;
      }
      el('span', 'switcher-name', node).textContent = layoutName(sw.presets[i]);
      node.addEventListener('click', (function (n) { return function () { sw.index = n; chooseLayout(); }; })(i));
      sw.nodes.push(node);
    }
    focusSwitcher(sw.index);
  }

  function focusSwitcher(i) {
    if (sw.nodes[sw.index]) sw.nodes[sw.index].classList.remove('is-focused');
    sw.index = i;
    if (sw.nodes[i]) sw.nodes[i].classList.add('is-focused');
  }

  function openSwitcher() {
    if (sw.on || busy || open || frameOpen) return;
    sw.presets = switcherPresets();
    if (sw.presets.length < 2) return;     // nothing to switch between
    clayHook('stop');
    clearTimeout(sw.hideTimer);
    drawSwitcher();
    sw.on = true;
    switcherEl.classList.add('is-on');
    // Glass: the bar shows the blurred picture behind where it comes to rest.
    if (hasPicture) {
      setGlassOrigin(sw.bar, switcherEl.offsetLeft + sw.bar.offsetLeft + sw.bar.clientLeft,
        switcherEl.offsetTop + sw.bar.offsetTop + sw.bar.clientTop);
    }
    void switcherEl.offsetWidth;           // so the drop starts from off screen
    switcherEl.classList.add('is-shown');
  }

  function closeSwitcher() {
    if (!sw.on) return;
    sw.on = false;
    switcherEl.classList.remove('is-shown');
    clearTimeout(sw.hideTimer);
    sw.hideTimer = setTimeout(function () { if (!sw.on) switcherEl.classList.remove('is-on'); }, 260);
    layoutChance();
  }

  function moveSwitcher(dir) {
    var n = sw.nodes.length;
    if (dir === 'right' && sw.index < n - 1) focusSwitcher(sw.index + 1);
    else if (dir === 'left' && sw.index > 0) focusSwitcher(sw.index - 1);
  }

  function chooseLayout() {
    var p = sw.presets[sw.index];
    closeSwitcher();
    if (!p) return;
    saveChoice({ id: p.id || p.name, live: p.live });
    saveLayout(p.layout);
    pendingLayout = p.layout;
    applyPendingLayout();
    toast(hubWord('layoutPicked', '{name} layout', { name: layoutName(p) }), 1800);
  }

  /* ---------- auto-rotate layouts ---------- */

  // A setting in the Menu sheet (per screen, like Look and Language): when on,
  // the hub moves to the next saved layout every 2 minutes. A key, click or
  // touch pushes the next move to 5 minutes after it, since someone is
  // reading. Nothing moves while a tile is open, a web page is full screen,
  // the Menu, layout bar or About strip is up, the PIN pad or the slideshow
  // shows, or a text box has the keyboard; the 5 minutes count from when that
  // ends (closing it is a key or tap). Layouts with rotate: false in
  // config.js (Default and the test layouts) are skipped. A layout with other
  // widgets reloads the page (reloadForLayout); the 2 minutes start again then.
  // A one-widget layout's window that opened by itself (openSolo, e.g. Plants)
  // does not count as an open tile: the move closes it first. A key or touch
  // in it still waits the 5 minutes.
  var ROTATE_KEY = 'homeHub.autoRotate';
  var ROTATE_MS = 120000;       // between moves when nobody is using the hub
  var ROTATE_AWAKE_MS = 300000; // after a key, click or touch
  var ROTATE_TICK_MS = 5000;
  var rot = { lastMove: new Date().getTime(), lastUse: 0, timer: null };

  function rotateOn() {
    try { return !!(window.localStorage && localStorage.getItem(ROTATE_KEY) === 'on'); } catch (e) { return false; }
  }

  function setRotate(on) {
    try {
      if (window.localStorage) {
        if (on) localStorage.setItem(ROTATE_KEY, 'on');
        else localStorage.removeItem(ROTATE_KEY);
      }
    } catch (e) { /* stays as it was */ }
    rot.lastMove = new Date().getTime();   // the first move is a full 2 minutes away
    rotateTimer();
  }

  function noteUse() { rot.lastUse = new Date().getTime(); }
  document.addEventListener('keydown', noteUse, true);
  document.addEventListener('click', noteUse, true);
  document.addEventListener('touchstart', noteUse, true);

  // Something is open or being used: no move now.
  function rotateHeld() {
    if (busy || (open && !openAuto) || frameOpen || sw.on || ab.on || tablet.sheetOn || tablet.show || tablet.peek) return true;
    try { if (window.HUB_PIN && typeof window.HUB_PIN.isOpen === 'function' && window.HUB_PIN.isOpen()) return true; } catch (e) { /* no PIN pad */ }
    return !!typingBox();
  }

  // When the next move is due (ms since 1970).
  function rotateDue() {
    return Math.max(rot.lastMove + ROTATE_MS, rot.lastUse ? rot.lastUse + ROTATE_AWAKE_MS : 0);
  }

  // The layouts it moves through, in the bar's order.
  function rotatePresets() {
    var all = switcherPresets();
    var out = [];
    var src = cfg.layouts || [];
    for (var i = 0; i < all.length; i++) {
      var skip = false;
      for (var j = 0; j < src.length; j++) {
        if (src[j] && src[j].rotate === false && (src[j].id || src[j].name) === (all[i].id || all[i].name)) skip = true;
      }
      if (!skip) out.push(all[i]);
    }
    return out;
  }

  // Where the screen is in that list: the picked one, else the one that looks the same, else -1.
  function rotateIndex(list) {
    var chosen = readChoice();
    var id = isLiveChoice(chosen) ? 'main' : chosen.id;
    for (var i = 0; i < list.length; i++) if ((list[i].id || list[i].name) === id) return i;
    var current = layoutSig(layoutKey ? JSON.parse(layoutKey) : null);
    for (var k = 0; k < list.length; k++) if (presetSig(list[k]) === current) return k;
    return -1;
  }

  function rotateNext() {
    var list = rotatePresets();
    if (list.length < 2) return false;
    var p = list[(rotateIndex(list) + 1) % list.length];
    rot.lastMove = new Date().getTime();
    saveChoice({ id: p.id || p.name, live: p.live });
    saveLayout(p.layout);
    pendingLayout = p.layout;
    if (open && openAuto) closePanel();   // closing applies it (layoutChance)
    else applyPendingLayout();
    return true;
  }

  function rotateTick() {
    if (!rotateOn()) return;
    var now = new Date().getTime();
    if (rotateHeld()) { rot.lastUse = now; return; }   // open counts as in use
    if (now >= rotateDue()) rotateNext();
  }

  function rotateTimer() {
    clearInterval(rot.timer);
    rot.timer = rotateOn() ? setInterval(rotateTick, ROTATE_TICK_MS) : null;
  }
  rotateTimer();

  /* ---------- the About panel ---------- */

  // Press Left on a left-most tile and a strip of facts about the hub slides
  // in from the left: the version, the TV's browser, motion, live updates,
  // updates, and how the clay wanderers are doing. Right or Back closes it
  // (focus stays on the tile it came from); Up and Down scroll it when it is
  // taller than the screen; a click outside closes it. It is not "busy": the
  // wanderers keep their schedule while it is open, so their status can be
  // watched live (they walk behind it). Made like the layout bar.
  //
  // Each row is { group, label, value }: value() returns the text, or '' to
  // leave the row out. groupKey and labelKey (app/i18n.js keys) show the
  // group and label in the hub's language; without them they are English.
  // To show something new, add a row to ABOUT_ROWS (a new group name
  // starts a new group); nothing else needs to change. A row with
  // action() is the strip's one button: OK runs it (the first shown wins).
  // when() (optional) says whether it can act now; such a row goes first
  // while it can. tap: a click or tap on the row runs it too.
  var aboutEl = document.getElementById('about');
  var ab = { on: false, box: null, sig: '', rows: [], drawn: [], dropped: {}, timer: null, hideTimer: null };

  function noPrefix(text, prefix) {
    text = text ? String(text) : '';
    return text.indexOf(prefix) === 0 ? text.slice(prefix.length) : text;
  }

  // 'This hub' -> 'hub.about.ThisHub'
  function aboutKey(english) {
    return 'hub.about.' + String(english).replace(/[^A-Za-z]+(.)?/g, function (m, c) { return c ? c.toUpperCase() : ''; });
  }

  function aboutWord(key, english) {
    var L = window.HUB_I18N;
    try { return L && typeof L.t === 'function' ? String(L.t(key, english)) : english; } catch (e) { return english; }
  }

  function clayPart(name) {
    var st = clayStatus();
    return st && typeof st[name] === 'string' ? st[name] : '';
  }

  var ABOUT_ROWS = [
    { group: 'This hub', label: 'Version', value: function () {
      var u = updateStatus();
      var a = appverStatus();
      return BUILD + ((u && u.newest === true) || (a && a.state === 'current') ? ' (newest)' : '');
    } },
    { group: 'This hub', label: 'Browser', value: function () { return browserText; } },
    { group: 'This hub', label: 'Motion', value: function () {
      var extras = fxCall('statusText') || '';
      return noPrefix(motionStatus(), 'Motion: ') + (extras ? ' · ' + extras : '');
    } },
    // The Weather picture behind the tile and panel: moving, or standing still on a slow TV.
    { group: 'This hub', label: 'Weather picture', value: function () {
      var w = widgetById('weather');
      var fn = w && w.w ? w.w.sceneStatus : null;
      try { return typeof fn === 'function' ? fn() || '' : ''; } catch (e) { return ''; }
    } },
    // Day or night, and why (see Day and night, above).
    { group: 'This hub', label: 'Look', spare: true, value: function () { return themeStatus(); } },
    // The picture behind the tiles and who made it (app/backgrounds/backgrounds.js).
    { group: 'This hub', label: 'Picture', spare: true, value: function () { return pictureStatus(); } },
    // A stylesheet that had to be fetched again, or never arrived (see hub.html).
    { group: 'This hub', label: 'Styles', value: function () {
      var S = window.HUB_STYLES;
      try { return S && typeof S.status === 'function' ? S.status() || '' : ''; } catch (e) { return ''; }
    } },
    // A script that failed to load: the page loaded again for it, or it never came (see hub.html).
    { group: 'This hub', label: 'Scripts', value: function () {
      var S = window.HUB_SCRIPTS;
      try { return S && typeof S.status === 'function' ? S.status() || '' : ''; } catch (e) { return ''; }
    } },
    // The watch link test (app/widgets/linktest.js): OK opens it in the
    // Entertainment panel. spare: it gives way when the strip would be taller
    // than the screen (a long Wanderers problem), and comes back with the
    // next change of rows.
    { group: 'This hub', label: 'Watch link test', spare: true, value: function () {
      var T = window.HUB_LINKTEST;
      try { return T && typeof T.aboutText === 'function' ? T.aboutText() || '' : ''; } catch (e) { return ''; }
    }, action: function () { openWidgetView('entertainment', 'linktests'); } },
    { group: 'Updates', label: 'Live updates', value: function () {
      var L = liveFacade();
      var t = L ? (L.status() || {}).text || '' : '';
      return t === 'Live' ? 'connected' : noPrefix(t, 'Live: ');
    }, raw: function () { var L = liveFacade(); return L ? (L.status() || {}).text || '' : ''; } },
    { group: 'Updates', label: 'Version check', value: function () {
      var u = updateStatus();
      var t = noPrefix(u && typeof u.text === 'string' ? u.text : '', 'Updates: ');
      // Held: why that version didn't start, when update.js kept the reason.
      if (t && u.state === 'held' && typeof u.why === 'string' && u.why) t += ' (' + u.why + ')';
      // Served by the Pi (the wall tablet, a phone): app/appver.js says instead.
      return t || appverLabel();
    }, raw: function () {
      var u = updateStatus();
      var t = u && typeof u.text === 'string' ? u.text : '';
      var a = appverStatus();
      return t || (a ? a.text : '');
    },
    // OK (or a tap on the row) reloads, only while the Pi has a newer version.
    when: function () { var a = appverStatus(); return !!a && a.state === 'available'; },
    tap: true, action: function () { appverReload(); } },
    { group: 'Wanderers', label: 'Now', value: function () { return clayPart('now'); } },
    { group: 'Wanderers', label: 'Visits', value: function () { return clayPart('visits'); } },
    { group: 'Wanderers', label: 'Last visit', value: function () { return clayPart('last'); } },
    { group: 'Wanderers', label: 'Drawing', value: function () { return clayPart('drawing'); } },
    { group: 'Wanderers', label: 'Loading', value: function () { return clayPart('loading'); } },
    { group: 'Wanderers', label: 'Last problem', value: function () { return clayPart('problem'); } },
    // The character beside the chips (app/agents.js): in the hub's language (keys in app/i18n.js).
    { group: 'Characters', groupKey: 'agents.about.group', label: 'Now', labelKey: 'agents.about.now', value: function () { return agentsPart('now'); } },
    { group: 'Characters', groupKey: 'agents.about.group', label: 'Seen', labelKey: 'agents.about.seen', value: function () { return agentsPart('seen'); } },
    { group: 'Characters', groupKey: 'agents.about.group', label: 'Drawing', labelKey: 'agents.about.drawing', value: function () { return agentsPart('drawing'); } },
    // The Now Playing visualizer, once it has shown: its level, frame rate and tempo.
    { group: 'Now Playing', label: 'Visualizer', value: function () {
      var V = window.HUB_NP_VIZ;
      return V && typeof V.status === 'function' ? V.status() : '';
    } }
  ];

  // A number keeps its unit on the same line: "1 s ago", never "1" then "s ago".
  function keepUnits(text) {
    return text.replace(/(\d) (ms|s|min|h|of)(?=$|[ ,.)·])/g, '$1\u00a0$2');
  }

  // A row acts (OK runs it) when it has action(), and when() says yes if it has one.
  function rowActs(r) {
    if (typeof r.action !== 'function') return false;
    if (typeof r.when !== 'function') return true;
    try { return r.when() === true; } catch (e) { return false; }
  }

  // A row that starts or stops acting redraws the strip.
  function rowSig(r) { return r.label + (r.when && rowActs(r) ? '*' : ''); }

  function tapRow(r) {
    return function () { if (rowActs(r)) { try { r.action(); } catch (e) { /* stays as it is */ } } };
  }

  // The rows that have something to say now: [{ row, text }].
  function aboutValues() {
    var out = [];
    for (var i = 0; i < ABOUT_ROWS.length; i++) {
      var text = '';
      try { text = ABOUT_ROWS[i].value() || ''; } catch (e) { text = ''; }
      if (text) out.push({ row: ABOUT_ROWS[i], text: keepUnits(String(text)) });
    }
    return out;
  }

  function drawAbout(list) {
    aboutEl.innerHTML = '';
    ab.box = el('div', 'about-box', aboutEl);
    ab.rows = [];
    ab.drawn = [];
    var group = null;
    var sig = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i].row;
      if (r.group !== group) {
        group = r.group;
        el('div', 'about-group', ab.box).textContent = aboutWord(r.groupKey || aboutKey(group), group);
      }
      var act = rowActs(r);
      var row = el('div', 'about-row' + (act ? ' is-action' : ''), ab.box);
      if (act && r.tap) row.addEventListener('click', tapRow(r), false);
      el('div', 'about-label', row).textContent = aboutWord(r.labelKey || aboutKey(r.label), r.label);
      var value = el('div', 'about-value', row);
      value.textContent = list[i].text;
      ab.rows.push(value);
      ab.drawn.push(r);
      sig.push(rowSig(r));
    }
    ab.sig = sig.join('|');
    ab.dropped = {};
  }

  // Spare rows (the watch link test) leave when the strip is taller than its
  // room, so the rows that report problems never need scrolling for them.
  // Only while it is shown (a hidden strip has no height).
  function trimAbout() {
    var box = ab.box;
    if (!box || box.scrollHeight <= box.clientHeight + 1) return;
    for (var i = ab.drawn.length - 1; i >= 0; i--) {
      if (!ab.drawn[i].spare) continue;
      var row = ab.rows[i].parentNode;
      var prev = row.previousSibling;
      var next = row.nextSibling;
      row.parentNode.removeChild(row);
      // A group header left with no rows goes too.
      if (prev && prev.className === 'about-group' && (!next || next.className === 'about-group')) prev.parentNode.removeChild(prev);
      ab.dropped[ab.drawn[i].label] = true;
      ab.drawn.splice(i, 1);
      ab.rows.splice(i, 1);
    }
  }

  // Once a second while open: only text that changed is touched; a row
  // that comes or goes redraws the strip.
  function refreshAbout() {
    ab.timer = null;
    if (!ab.on) return;
    try {
      var list = aboutValues();
      var sig = [];
      for (var i = 0; i < list.length; i++) sig.push(rowSig(list[i].row));
      if (sig.join('|') !== ab.sig) {
        var top = ab.box ? ab.box.scrollTop : 0;
        drawAbout(list);
        trimAbout();
        ab.box.scrollTop = top;
        if (tablet.sheetOn) markSheetFocus();
        placeAboutGlass();
      } else {
        var shown = [];
        for (var k = 0; k < list.length; k++) if (!ab.dropped[list[k].row.label]) shown.push(list[k]);
        for (var j = 0; j < shown.length && j < ab.rows.length; j++) {
          if (ab.rows[j].textContent !== shown[j].text) ab.rows[j].textContent = shown[j].text;
        }
        trimAbout();
      }
    } catch (e) { /* the strip just stays as it is */ }
    ab.timer = setTimeout(refreshAbout, 1010 - (new Date().getTime() % 1000));
  }

  function placeAboutGlass() {
    if (hasPicture && ab.box) {
      setGlassOrigin(ab.box, aboutEl.offsetLeft + ab.box.offsetLeft + ab.box.clientLeft,
        aboutEl.offsetTop + ab.box.offsetTop + ab.box.clientTop);
    }
  }

  function openAbout() {
    if (ab.on || busy || open || frameOpen || sw.on || typingBox()) return;
    clearTimeout(ab.hideTimer);
    drawAbout(aboutValues());
    ab.on = true;
    aboutEl.classList.add('is-on');
    trimAbout();
    placeAboutGlass();
    void aboutEl.offsetWidth;              // so the slide starts from off screen
    aboutEl.classList.add('is-shown');
    clearTimeout(ab.timer);
    ab.timer = setTimeout(refreshAbout, 1010 - (new Date().getTime() % 1000));
  }

  function closeAbout() {
    if (!ab.on) return;
    ab.on = false;
    clearTimeout(ab.timer);
    ab.timer = null;
    aboutEl.classList.remove('is-shown');
    clearTimeout(ab.hideTimer);
    ab.hideTimer = setTimeout(function () { if (!ab.on) { aboutEl.classList.remove('is-on'); aboutEl.innerHTML = ''; } }, 260);
  }

  // OK in the strip: the first row shown that has an action, or else one
  // that gave way for room (the watch link test when the strip is full), so
  // OK in About always opens it.
  function aboutAction() {
    var pick = null;
    // A row that can act only now (an update to load) goes first.
    for (var w = 0; w < ab.drawn.length && !pick; w++) if (ab.drawn[w].when && rowActs(ab.drawn[w])) pick = ab.drawn[w];
    for (var i = 0; i < ab.drawn.length && !pick; i++) if (rowActs(ab.drawn[i])) pick = ab.drawn[i];
    for (var j = 0; j < ABOUT_ROWS.length && !pick; j++) if (ABOUT_ROWS[j].spare && ab.dropped[ABOUT_ROWS[j].label] && typeof ABOUT_ROWS[j].action === 'function') pick = ABOUT_ROWS[j];
    if (!pick) return false;
    try { pick.action(); } catch (e) { toast(hubWord('didntWork', 'That didn’t work ({why}).', { why: e && e.message }), 4000); }
    return true;
  }

  // Opens a widget's panel on one of its own views (widget hook openView).
  function openWidgetView(id, name) {
    for (var i = 0; i < widgets.length; i++) {
      var rec = widgets[i];
      if (rec.w.id !== id || !rec.expandable) continue;
      closeAbout();
      if (typeof rec.w.openView !== 'function') return toast(hubWord('cantOpen', 'This hub can’t open that yet.'), 4000);
      if (call(rec, 'openView', [name, rec.ctx]) === false) return undefined;
      focusHome(i);
      openPanel(rec);
      return undefined;
    }
    toast(hubWord('noEntertainment', 'Entertainment isn’t on this layout. Pick one with it (Up on a top tile), then try again.'), 6000);
    return undefined;
  }

  // Up and Down: a step at a time, only when it is taller than its room.
  function scrollAbout(dir) {
    var box = ab.box;
    if (!box || box.scrollHeight <= box.clientHeight) return;
    var step = Math.round(box.clientHeight * 0.6);
    box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, box.scrollTop + (dir === 'down' ? step : -step)));
  }

  // A click anywhere outside the strip closes it, and does nothing else.
  document.addEventListener('click', function (e) {
    if (!ab.on || aboutEl.contains(e.target) || tablet.sheetOn) return;
    e.stopPropagation();
    e.preventDefault();
    closeAbout();
  }, true);

  /* ---------- building the stage ---------- */

  function pickWidgets() {
    var list = window.HUB_WIDGETS || [];
    var byId = {};
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w || !w.id || !w.title) continue;
      var prev = byId[w.id];
      if (prev && !prev.planned && w.planned) continue;  // a real widget beats a placeholder
      byId[w.id] = w;
    }
    return byId;
  }

  function makeCtx(w) {
    var rec = null;
    var ctx = {
      id: w.id,
      config: (cfg.widgets && cfg.widgets[w.id]) || {},
      hasTizen: hasPageTizen,
      tablet: tablet.on,          // tablet mode (no remote); can turn on a moment after start
      noHelper: tablet.noHelper,  // tablet mode and service.js does not answer
      launchOnTv: launchOnTv,     // with noHelper: the Pi opens it on the TV (below)
      toast: toast,
      service: service,
      getJSON: function (url, timeoutMs, cb) { xhrJSON(url, timeoutMs, false, cb); },
      pi: piUrl,
      registerKeys: registerKeys,
      openFrame: openFrame,
      isOpen: function () { return !!open && open === rec; },
      mode: function () { return open === rec ? mode : null; },
      setMode: function (m) { if (open === rec && m !== mode && (m === 'panel' || m === 'full')) switchMode(m); },
      close: function () { if (open === rec) closePanel(); },
      redrawTile: function () { if (rec) drawTile(rec); },
      size: function () {
        var z = (rec && rec.size) || sizeOf(null);
        return { cols: z.cols, rows: z.rows, tier: z.tier, width: z.width };
      },
      redrawPanel: function () { if (open === rec) { drawPanelBody(true); refitOpen(); } },
      setSub: function (text) { if (open === rec) setPanelSub(text); },
      setTileSub: function (text) { setTileSub(rec, text); },
      // The header: a title other than the widget's own ('' goes back to
      // it), a badge on the right ('' hides it), the title fitted again
      // (after the widget's title or short form changed), and a header of
      // the same kind drawn by a widget without the hub's (head: false).
      setTitle: function (text) {
        if (!rec) return;
        rec.titleText = text ? String(text) : '';
        retitle(rec);
      },
      setBadge: function (text) {
        if (!rec || !rec.badgeEl) return;
        rec.badgeText = text ? String(text) : '';
        setBadgeText(rec.badgeEl, rec.badgeText || (rec.w.planned ? hubWord('soon', 'Soon') : ''));
        retitle(rec);
      },
      retitle: function () { retitle(rec); },
      drawHead: function (parent, o) {
        o = o || {};
        var parts = buildHead(parent, o.icon || w.icon, '', o.badge || '');
        fitHead(parts.head, parts.title, parts.badge, String(o.title || w.title || ''), o.short || '');
        return parts.head;
      },
      // The accent edge, a faint border around the tile ("something to see here"),
      // for a reason other than ctx.activity (which raises it by itself).
      accent: function (reason) { if (rec && rec.tile) fxCall('accent', [rec.tile, reason || 'update']); },
      live: liveFacade(),
      focus: function (node) { if (open === rec) focusPanel(node); },
      engaged: function () { return !!rec && engaged === rec; },
      disengage: function () { if (rec && engaged === rec) disengage(); },
      bloom: function (node) { return fxCall('bloom', [node]) || null; },
      activity: function (kind) { if (rec && rec.home && rec.tile) fxCall('activity', [rec.tile, kind]); },
      _bind: function (r) { rec = r; }
    };
    return ctx;
  }

  // The layout's one widget, when it fills the whole grid (12 by 6) and can
  // open; null otherwise. Set by build(), opened as a window by openSolo().
  var soloRec = null;

  function build() {
    var byId = pickWidgets();
    registry = byId;
    var layout = startLayout();
    var placed = {};
    for (var i = 0; i < layout.length; i++) {
      var entry = layout[i];
      var w = entry && byId.hasOwnProperty(entry.widget) ? byId[entry.widget] : null;
      if (!w || placed.hasOwnProperty(w.id)) continue;   // one tile per widget
      placed[w.id] = true;
      var ctx = makeCtx(w);
      var rec = { w: w, ctx: ctx, expandable: w.expandable !== false, size: null };
      ctx._bind(rec);
      delete ctx._bind;

      var cell = el('div', 'cell', gridEl);
      cell.setAttribute('data-widget', w.id);
      placeCell(cell, entry);

      var tile = el('div', 'tile' + (w.planned ? ' is-planned' : '') + (rec.expandable ? '' : ' is-static') +
        (w.head === false ? ' is-headless' : ''), cell);
      if (w.head !== false) {
        var parts = buildHead(tile, w.icon, '', w.planned ? hubWord('soon', 'Soon') : '');
        rec.titleEl = parts.title;
        rec.badgeEl = parts.badge;
        var sub = ctx.config.sub || w.sub || '';
        if (sub) el('div', 'tile-sub', parts.titles).textContent = sub;
      }
      rec.cell = cell;
      rec.tile = tile;
      rec.entry = entry;
      applySize(rec, entry);
      rec.body = el('div', 'tile-body', tile);
      rec.index = widgets.length;
      widgets.push(rec);
      tile.addEventListener('click', onTileClick(rec));
    }

    soloRec = null;
    if (widgets.length === 1 && widgets[0].expandable && !widgets[0].w.planned) {
      var only = widgets[0].entry;
      if (only && only.x === 0 && only.y === 0 && only.w === GRID_COLS && only.h === GRID_ROWS) soloRec = widgets[0];
    }
    // Its screen-sized tile stays hidden until the window first closes, so the
    // hub never shows it on the way in (see openSolo).
    if (soloRec) soloRec.cell.classList.add('is-solo-waiting');

    for (var j = 0; j < widgets.length; j++) call(widgets[j], 'init', [widgets[j].ctx]);
    for (var k = 0; k < widgets.length; k++) drawTile(widgets[k]);
    measureHome();
    retitleAll();
    // A language change: every title (and its short form) again, after the
    // widgets' own listeners (registered in init, above) have run.
    try {
      if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') {
        window.HUB_I18N.onChange(function () {
          retitleAll();
          if (open) { drawPanelHead(); }
        });
      }
    } catch (e) { /* titles stay in the language they started in */ }

    focusHome(topLeftIndex());
  }

  // The tile that gets focus when the hub opens or a layout arrives: the
  // top-left one (smallest y on the grid, then smallest x), skipping static
  // tiles. -1 when nothing can take focus.
  function topLeftIndex() {
    var best = -1;
    for (var i = 0; i < widgets.length; i++) {
      var e = widgets[i].entry;
      if (!widgets[i].expandable || !e) continue;
      if (best === -1) { best = i; continue; }
      var b = widgets[best].entry;
      if (e.y < b.y || (e.y === b.y && e.x < b.x)) best = i;
    }
    return best;
  }

  // A one-widget layout opens straight into the widget as a window (the
  // small panel, Full screen one press away) as the hub starts: one fade in
  // place, with no tile shown first and no move from it (a layout change
  // reloads the page, so this runs for each one). Back closes the window to
  // the tile, and Up from there opens the layout bar.
  function openSolo() {
    if (!soloRec) return;
    setTimeout(function () {
      if (!open && !busy && !frameOpen && soloRec) openPanel(soloRec, 'solo');
      else if (soloRec) soloRec.cell.classList.remove('is-solo-waiting');
    }, 0);
  }

  function drawTile(rec) {
    rec.body.innerHTML = '';
    call(rec, 'renderTile', [rec.body, rec.ctx]);
    fxCall('markTile', [rec.tile, rec.body, !!rec.w.planned]);
  }

  function onTileClick(rec) {
    return function () {
      if (busy || open || frameOpen || !rec.expandable) return;
      focusHome(rec.index);
      openPanel(rec);
    };
  }

  /* ---------- home focus ---------- */

  function focusHome(i) {
    if (engaged && widgets[i] !== engaged) disengage();
    if (tablet.peek) { tablet.peek = false; if (tablet.tab) tablet.tab.classList.remove('is-peek'); }
    if (homeIndex >= 0 && widgets[homeIndex]) widgets[homeIndex].tile.classList.remove('is-focused');
    homeIndex = i;
    if (i >= 0 && widgets[i]) widgets[i].tile.classList.add('is-focused');
    if (!open) fxCall('focus', [focusRect(), { repeat: keyRepeat }]);
    keyRepeat = false;
  }

  function moveHome(dir) {
    if (homeIndex < 0) return;
    var from = widgets[homeIndex].home;
    var rects = [];
    for (var i = 0; i < widgets.length; i++) {
      rects.push(i !== homeIndex && widgets[i].expandable ? widgets[i].home : null);
    }
    var next = pickNext(from, rects, dir);
    if (next >= 0) focusHome(next);
    else if (dir === 'up') openSwitcher();       // off the top edge: the layout bar
    else if (dir === 'left') openAbout();        // off the left edge: the About panel
    else if (dir === 'down') showPeek();         // off the bottom edge: the Menu tab (TV)
  }

  /* ---------- engage on OK ---------- */

  /*
   * An interactive tile (w.engage, only Flashcards so far) is used in place.
   * A short OK on it engages it: the ring changes (is-engaged on the tile,
   * hub-engaged on the body for the gliding ring) and a hint shows at the
   * tile's foot. Engaged, Left and Right and a short OK go to the widget's
   * onEngagedKey; Back leaves; Up and Down leave and move on as usual. A long
   * press of OK, engaged or not, opens the panel. Every other tile keeps
   * OK = open, at once.
   *
   * Short or long: a keyup before HOLD_MS is short; a held key's repeated
   * keydown, or no keyup by HOLD_MS, is long. Until a keyup has been seen
   * once (a remote that never sends one), only the repeat counts, and with
   * no repeat either the press is short after HOLD_WAIT_MS.
   */
  var HOLD_MS = 550;
  var HOLD_WAIT_MS = 1000;
  var engaged = null;        // the engaged tile's record
  var okPress = null;        // { rec, decided, timer }: an OK on an interactive tile, still down
  var keyupSeen = false;

  // w.engage: true, or a function (ctx) that says so for the tile's size now.
  // Tablet mode has no remote: the tile's own buttons take taps instead.
  function canEngage(rec) {
    if (!rec || !rec.expandable || !rec.w || !rec.w.engage || tablet.on) return false;
    if (typeof rec.w.engage !== 'function') return true;
    return !!call(rec, 'engage', [rec.ctx]);
  }

  function engageHintText(rec) {
    var t = call(rec, 'engageHint', [rec.ctx]);
    return t ? String(t) : hubWord('engageHint', 'Hold OK: open · Back: done');
  }

  function drawEngageHint(rec) {
    if (!rec.engageHint) {
      rec.engageHint = el('div', 'tile-engage-hint', rec.tile);
      rec.engageHint.setAttribute('aria-hidden', 'true');
    }
    var h = rec.engageHint;
    h.textContent = engageHintText(rec);
    // A long hint (Spanish) steps down a little before it would end in "...".
    h.style.fontSize = '';
    var px = parseFloat(window.getComputedStyle(h).fontSize) || 14;
    var min = px * 0.88;
    for (var i = 0; i < 4 && h.scrollWidth > h.clientWidth + 1 && px > min; i++) {
      px = Math.max(min, px * 0.96);
      h.style.fontSize = px.toFixed(1) + 'px';
    }
  }

  function engage(rec) {
    if (engaged === rec) return;
    if (engaged) disengage();
    engaged = rec;
    rec.tile.classList.add('is-engaged');
    document.body.classList.add('hub-engaged');
    drawEngageHint(rec);
    rec.engageHint.classList.add('is-on');
    call(rec, 'onEngage', [rec.ctx]);
  }

  function disengage() {
    var rec = engaged;
    if (!rec) return;
    engaged = null;
    rec.tile.classList.remove('is-engaged');
    document.body.classList.remove('hub-engaged');
    if (rec.engageHint) rec.engageHint.classList.remove('is-on');
    call(rec, 'onDisengage', [rec.ctx]);
  }

  function clearPress() {
    if (okPress && okPress.timer) clearTimeout(okPress.timer);
    okPress = null;
  }

  function startPress(rec) {
    // An earlier press still undecided (a remote with no keyup): it was short.
    if (okPress && !okPress.decided) decidePress('short');
    clearPress();
    var press = okPress = { rec: rec, decided: false, timer: null };
    press.timer = setTimeout(function () {
      if (okPress !== press || press.decided) return;
      if (keyupSeen) { decidePress('long'); return; }
      press.timer = setTimeout(function () { if (okPress === press && !press.decided) decidePress('short'); }, HOLD_WAIT_MS - HOLD_MS);
    }, HOLD_MS);
  }

  function decidePress(kind) {
    var press = okPress;
    if (!press || press.decided) return;
    press.decided = true;
    if (press.timer) { clearTimeout(press.timer); press.timer = null; }
    var rec = press.rec;
    if (busy || open || frameOpen || widgets[homeIndex] !== rec) return;
    if (kind === 'long') {
      disengage();
      openPanel(rec);
    } else if (engaged === rec) {
      call(rec, 'onEngagedKey', ['ok', rec.ctx]);
    } else {
      engage(rec);
    }
  }

  // Keys while a tile is engaged (home stage, nothing open).
  function engagedKey(code, dir, repeat) {
    if (isBack(code)) { clearPress(); disengage(); return; }
    if (code === KEY.ENTER) { startPress(engaged); return; }
    if (okPress && !okPress.decided) decidePress('short');   // OK, then an arrow before its keyup
    if (!engaged) return;
    if (dir === 'left' || dir === 'right') {
      if (!repeat) call(engaged, 'onEngagedKey', [dir, engaged.ctx]);
      return;
    }
    if (dir) { disengage(); moveHome(dir); }
  }

  document.addEventListener('keyup', function (e) {
    if (e.keyCode !== KEY.ENTER) return;
    keyupSeen = true;
    if (okPress && !okPress.decided) decidePress('short');
    clearPress();
  });

  /* ---------- the panel ---------- */

  function buildPanel() {
    var head = el('div', 'panel-head', panelEl);
    panel.icon = el('span', 'icon panel-icon', head);
    var titles = el('div', 'panel-titles', head);
    panel.title = el('div', 'panel-title', titles);
    panel.sub = el('div', 'panel-sub', titles);
    var right = el('div', 'panel-actions', head);
    panel.hint = el('span', 'panel-hint', right);
    panel.btn = el('div', 'panel-btn f', right);
    panel.btnIcon = el('span', 'icon panel-btn-icon', panel.btn);
    panel.btnLabel = el('span', 'panel-btn-label', panel.btn);
    panel.body = el('div', 'panel-body', panelEl);

    panelEl.addEventListener('click', function (e) {
      if (busy || !open) return;
      var node = e.target;
      while (node && node !== panelEl && !hasClass(node, 'f')) node = node.parentNode;
      if (!node || node === panelEl) return;
      focusPanel(node);
      selectPanel();
    });
    // Real focus entering or leaving a text box changes the Back hint. During
    // blur the box can still be document.activeElement, so go by the event.
    panelEl.addEventListener('focus', function (e) {
      if (isTextBox(e.target)) drawPanelHint(true);
    }, true);
    panelEl.addEventListener('blur', function (e) {
      if (!isTextBox(e.target)) return;
      // The TV keyboard may close and blur the box by itself, so the stray-key
      // guard starts here too, not only in stopTyping.
      typingEndedAt = Date.now();
      drawPanelHint(false);
    }, true);
    scrimEl.addEventListener('click', function () {
      if (!busy && open && !frameOpen) { if (tablet.on) tabletBack(); else closePanel(); }
    });
    // Tablet mode: the Back chip is a button too. mousedown keeps a text box's focus,
    // so a tap while typing stops the typing, as Back does.
    panel.hint.addEventListener('mousedown', function (e) { if (tablet.on) e.preventDefault(); });
    panel.hint.addEventListener('click', function () { if (tablet.on) tabletBack(); });
  }

  function setPanelSub(text) {
    panel.sub.textContent = text || '';
    panel.sub.style.display = text ? '' : 'none';
  }

  // Whether OK on a widget's tile opens straight to full screen, with no
  // small panel in between. HUB_CONFIG.widgets[id].openMode ('full' or
  // 'panel') wins over the widget's own openMode.
  // A layout that is one widget filling the whole screen opens as a window
  // (see openSolo), with Full screen one press away, whatever its openMode.
  function isDirect(w) {
    if (soloRec && soloRec.w === w) return false;
    return wantsFull(w);
  }

  // ' is-wide' for a one-widget layout's window when the widget is made for
  // full screen (its width; panelRect gives its height), else ''.
  function wideClass(rec) {
    return rec && rec === soloRec && wantsFull(rec.w) ? ' is-wide' : '';
  }

  // The widget's own (or config.js's) openMode is 'full'.
  function wantsFull(w) {
    var c = cfg.widgets && cfg.widgets[w.id];
    var m = c && (c.openMode === 'full' || c.openMode === 'panel') ? c.openMode : w.openMode;
    return m === 'full';
  }

  function drawPanelHead() {
    var w = open.w;
    panel.icon.innerHTML = iconHTML(w.icon);
    var full = mode === 'full';
    // A widget that opens straight to full screen has no small panel to shrink to.
    var direct = isDirect(w);
    panel.btn.style.display = direct ? 'none' : '';
    if (direct) panel.btn.classList.remove('f'); else panel.btn.classList.add('f');
    panel.btnIcon.innerHTML = iconHTML(full ? 'shrink' : 'expand');
    panel.btnLabel.textContent = full ? hubWord('exitFull', 'Exit full screen') : hubWord('full', 'Full screen');
    drawPanelHint();
    fitPanelTitle();
  }

  // The open widget's title on one line, else its short form (AWWS).
  function fitPanelTitle() {
    if (!open) return;
    fitTitle(panel.title, String(open.w.title || ''), widgetShort(open));
  }

  // typing: true or false when the caller knows, otherwise worked out here.
  function drawPanelHint(typing) {
    if (!open) return;
    if (typing === undefined) typing = !!typingBox();
    // A small chip like the Full screen button, but never focusable.
    // A widget that uses Back itself (a page inside its panel) can say what Back does.
    var own = !typing && typeof open.w.backHint === 'function' ? call(open, 'backHint', [open.ctx]) : null;
    if (tablet.on) {
      panel.hint.textContent = typing ? hubWord('tapTyping', 'Tap to stop typing') : own ? String(own) : mode === 'full' && !isDirect(open.w) ? hubWord('tapShrink', 'Tap to shrink') : hubWord('tapClose', 'Tap to close');
      return;
    }
    panel.hint.textContent = typing ? hubWord('backTyping', 'Back to stop typing') : own ? String(own) : mode === 'full' && !isDirect(open.w) ? hubWord('backShrink', 'Back to shrink') : hubWord('backClose', 'Back to close');
  }

  function panelFocusables() {
    var list = panelEl.querySelectorAll('.f');
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function bodyFocusables() {
    var list = panel.body.querySelectorAll('.f');
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  // keep: true when redrawing an open panel (try to keep focus on the same thing).
  function drawPanelBody(keep) {
    var prevKey = null;
    var prevIndex = -1;
    var onButton = panelFocus === panel.btn;
    if (keep && panelFocus && !onButton) {
      prevKey = panelFocus.getAttribute('data-key');
      prevIndex = bodyFocusables().indexOf(panelFocus);
    }
    // A redraw while typing keeps the text, the caret and the typing.
    var typed = null;
    var box = keep ? typingBox() : null;
    if (box && box.getAttribute('data-key')) {
      typed = { key: box.getAttribute('data-key'), value: box.value, start: -1, end: -1 };
      try { typed.start = box.selectionStart; typed.end = box.selectionEnd; } catch (e) { /* not supported */ }
    }
    panelFocus = null;
    panel.body.innerHTML = '';
    panel.body.scrollTop = 0;
    call(open, 'renderPanel', [panel.body, open.ctx]);

    var items = bodyFocusables();
    var target = null;
    if (keep && onButton) target = panel.btn;
    if (!target && prevKey) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute('data-key') === prevKey) { target = items[i]; break; }
      }
    }
    if (!target) target = panel.body.querySelector('.f[data-autofocus]');
    if (!target && prevIndex >= 0 && items.length) target = items[Math.min(prevIndex, items.length - 1)];
    if (!target) target = items[0] || panel.btn;
    if (typed) {
      for (var j = 0; j < items.length; j++) {
        if (isTextBox(items[j]) && items[j].getAttribute('data-key') === typed.key) {
          target = items[j];
          target.value = typed.value;
          focusPanel(target);
          startTyping(target);
          if (typed.start >= 0) {
            try { target.setSelectionRange(typed.start, typed.end); } catch (e) { /* not supported */ }
          }
          break;
        }
      }
    }
    if (panelFocus !== target) focusPanel(target);
    drawPanelHint();
  }

  function focusPanel(node) {
    if (!node) return;
    if (panelFocus && panelFocus !== node) {
      if (panelFocus === typingBox()) stopTyping();
      panelFocus.classList.remove('is-focused');
    }
    panelFocus = node;
    node.classList.add('is-focused');
    if (node !== panel.btn) keepInView(node);
    call(open, 'onFocus', [node, open.ctx]);
  }

  // Scrolls the panel body (instantly) so the focused element is visible.
  function keepInView(node) {
    var body = panel.body;
    if (!body.contains(node)) return;
    var b = body.getBoundingClientRect();
    var r = node.getBoundingClientRect();
    // While the panel grows it is scaled; scrollTop is in unscaled pixels.
    var k = body.offsetHeight ? b.height / body.offsetHeight : 1;
    if (!(k > 0)) k = 1;
    // About 0.7rem, so a focused row (and a grown icon's ring) never sits
    // flush against the clipped edge.
    var margin = Math.round(0.7 * parseFloat(getComputedStyle(document.documentElement).fontSize || '16')) * k;
    if (r.top < b.top + margin) body.scrollTop -= (b.top + margin - r.top) / k;
    else if (r.bottom > b.bottom - margin) body.scrollTop += (r.bottom - (b.bottom - margin)) / k;
  }

  function movePanel(dir) {
    var list = panelFocusables();
    if (!panelFocus) { focusPanel(list[0]); return; }
    // A widget may steer a move itself: onMove returns the element to focus,
    // true to stay put, or nothing for the usual move by position.
    var own = call(open, 'onMove', [dir, panelFocus, open.ctx]);
    if (own === true) return;
    if (own && own.nodeType === 1 && own !== panelFocus && panelEl.contains(own)) { focusPanel(own); return; }
    var from = rectOf(panelFocus);
    var rects = [];
    for (var i = 0; i < list.length; i++) rects.push(list[i] === panelFocus ? null : rectOf(list[i]));
    var next = pickNext(from, rects, dir);
    if (next >= 0) focusPanel(list[next]);
  }

  function selectPanel() {
    if (!panelFocus) return;
    if (panelFocus === panel.btn) { if (!isDirect(open.w)) switchMode(mode === 'full' ? 'panel' : 'full'); return; }
    if (isTextBox(panelFocus)) { startTyping(panelFocus); return; }
    var target = panelFocus;
    target.classList.add('is-pressed');
    setTimeout(function () { target.classList.remove('is-pressed'); }, 160);
    call(open, 'onSelect', [target, open.ctx]);
  }

  function backInPanel() {
    if (call(open, 'onBack', [open.ctx]) === true) return;
    // A widget that opens straight to full screen closes on Back.
    if (mode === 'full' && !isDirect(open.w)) switchMode('panel');
    else closePanel();
  }

  /* ---------- typing in text boxes ---------- */

  // Typing = real (DOM) focus is on a text box in the open panel. Hub focus
  // (.is-focused) stays on it too. Nothing else keeps a typing flag.
  var TEXT_TYPES = { '': true, text: true, search: true, url: true, email: true, tel: true, number: true, password: true };
  var typingEndedAt = 0;

  function isTextBox(node) {
    if (!node || node.nodeType !== 1 || node.tagName !== 'INPUT' || !hasClass(node, 'f')) return false;
    var type = (node.getAttribute('type') || '').toLowerCase();
    return TEXT_TYPES.hasOwnProperty(type) && panel.body.contains(node);
  }

  function typingBox() {
    if (!open) return null;
    var node = document.activeElement;
    return isTextBox(node) ? node : null;
  }

  // On the TV, focusing the box opens the on-screen keyboard.
  function startTyping(node) {
    var already = document.activeElement === node;
    try { node.focus(); } catch (e) { return; }
    // A click has already focused it and placed the caret; leave that alone.
    if (!already) {
      try { node.setSelectionRange(node.value.length, node.value.length); } catch (e2) { /* not supported */ }
    }
  }

  function stopTyping() {
    var box = typingBox();
    if (box) {
      try { box.blur(); } catch (e) { /* ignore */ }
    }
    typingEndedAt = Date.now();
  }

  // Keys while typing. Only Enter/Done, Back/Cancel and Up/Down are the
  // hub's; everything else (letters, Backspace, Left/Right) goes to the box.
  function typingKey(e, box) {
    var code = e.keyCode;
    if (e.isComposing || code === 229) return;
    if (e.repeat && (code === KEY.ENTER || code === KEY.BACK || code === KEY.ESC)) { e.preventDefault(); return; }
    if (code === KEY.ENTER || code === KEY.IME_DONE) {
      e.preventDefault();
      stopTyping();
      call(open, 'onSubmit', [box, open.ctx]);
    } else if (code === KEY.BACK || code === KEY.ESC || code === KEY.IME_CANCEL) {
      e.preventDefault();
      stopTyping();
    } else if (code === KEY.UP || code === KEY.DOWN) {
      e.preventDefault();
      stopTyping();
      typingEndedAt = 0;   // OK right after moving on is a real press
      if (!busy) movePanel(dirOf(code));
    }
  }

  // A key that types a character, without ctrl, meta or alt.
  function isPrintable(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    // Old engines leave key out or report 'Unidentified'; go by the code then.
    if (e.key && e.key !== 'Unidentified') return e.key.length === 1;
    var c = e.keyCode;
    return c === 32 || (c >= 48 && c <= 90) || (c >= 96 && c <= 111) || (c >= 186 && c <= 222);
  }

  /* ---------- open, close, full screen ---------- */

  // Push mode: the other tiles slide into a ring around the panel.
  function pushOthers(rec, ms) {
    var targets = ringTargets(rec);
    for (var i = 0; i < widgets.length; i++) {
      var t = targets[i];
      var w = widgets[i];
      if (!t || w === rec) continue;
      w.tile.style.transition = 'transform ' + ms + 'ms ' + EASE + ', opacity ' + ms + 'ms ' + EASE;
      w.tile.style.transform = 'translate(' + (t.left - w.home.left) + 'px,' + (t.top - w.home.top) + 'px) scale(' + t.scale + ')';
      w.tile.style.opacity = '0.6';
      // Pushed aside, the body's words are too small to read: icon and title only.
      w.tile.classList.add('is-pushed');
    }
  }

  function returnOthers(rec, ms) {
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      w.tile.classList.remove('is-pushed');
      if (w === rec || !w.tile.style.transform) continue;
      w.tile.style.transition = 'transform ' + ms + 'ms ' + EASE + ', opacity ' + ms + 'ms ' + EASE;
      w.tile.style.transform = 'translate(0px,0px) scale(1)';
      w.tile.style.opacity = '1';
    }
  }

  function settleOthers() {
    for (var i = 0; i < widgets.length; i++) {
      var s = widgets[i].tile.style;
      s.transition = '';
      s.transform = '';
      s.opacity = '';
      widgets[i].tile.classList.remove('is-pushed');
    }
  }

  /*
   * Opening starts moving in the same task as the key press and only uses
   * layers that already exist: the ghost (the frame, parked invisible), the
   * tile itself and the empty panel. The tile rides to the center and fades
   * out over the growing ghost; the panel's content is built in a later task,
   * once the first frame is out, and fades in wherever the move is by then.
   * Transform and opacity transitions run on the compositor, so the build
   * doesn't stop them.
   */
  function openPanel(rec, how) {
    if (busy || open || !rec.expandable) return;
    if (engaged) disengage();
    closeAbout();                          // a panel the Pi opens goes over it: close it first
    clayHook('stop');
    open = rec;
    openAuto = how === 'solo';
    syncPicLabel();
    // openMode: 'full' (a widget's own choice) opens straight to full screen.
    var direct = isDirect(rec.w);
    mode = direct ? 'full' : 'panel';
    busy = true;
    // A one-widget layout's window fades in where it rests: its tile is the
    // whole screen, so a move from it would read as a second step.
    var fade = motion.mode === 'fade' || how === 'solo';
    var push = motion.mode === 'push';
    var ms = fade ? 140 : push ? 320 : 260;
    var T = rec.home || rectOf(rec.tile);
    var moved = false;
    var built = false;
    var skip = null;
    var openedAt = now();
    fxCall('ringHide');
    fxCall('activityStop');
    // Seen: the tile's accent edge goes (motion.js).
    fxCall('accentClear', [rec.tile]);

    // The panel is as tall as its content. The first time a widget opens,
    // its content is built here, before anything moves, and measured; after
    // that the height is known and the build waits for the first frame.
    // Which widget the panel shows: Guest mode (guest.js) blurs a money one.
    panelEl.setAttribute('data-panel-widget', rec.w.id);
    panelEl.className = 'panel is-shown' + (direct ? ' is-full is-direct' : wideClass(rec));
    panelEl.style.transition = 'none';
    panelEl.style.opacity = '0';
    panelEl.style.transform = IDENTITY;
    var prebuilt = direct || !panelFit.hasOwnProperty(rec.w.id);
    // The frame is full size before the boxes are sized, so its glass lines up.
    if (direct) ghostEl.className = 'ghost is-full';
    if (prebuilt) {
      sizeBoxes(direct ? null : panelRect(null));
      fillPanel(rec);
      if (!direct) fitPanel(rec, panelRect(null));
    }
    // Full screen is the whole window, with no fit to the content.
    var P = direct ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, right: window.innerWidth, bottom: window.innerHeight } : panelRect(rec);
    sizeBoxes(direct ? null : P);
    // Content built already: its items hide now, before the first frame shows them.
    if (prebuilt && !fade && rec.w.stagger) fxCall('stagger', [panel.body, rec.w.stagger, T, P, 140 - (now() - openedAt)]);
    var stop = fade ? function () {} : startSampling();

    function finish() {
      if (!moved || !built) return;
      stop(skip);
      ghostEl.style.transition = 'none';
      if (!fade) {
        clearTile(rec);
        rec.tile.style.visibility = 'hidden';
      }
      busy = false;
      // The content may have changed height since last time: the box follows, at once.
      refitOpen();
    }

    // Start state, then one style flush, then the transitions (FLIP).
    panelEl.style.transform = fade ? IDENTITY : panelStart(T, P);
    ghostEl.style.transition = 'none';
    ghostEl.className = 'ghost' + (direct ? ' is-full' : wideClass(rec));
    ghostEl.style.transform = fade ? IDENTITY : flip(T, P);
    ghostEl.style.opacity = fade ? '0' : '1';
    scrimEl.className = 'scrim is-shown';
    setOpacity(scrimEl, 0, 0);
    if (!fade) {
      // Only the tile's content rides along; from here the ghost is the frame.
      rec.cell.classList.add('is-raised');
      rec.tile.classList.add('is-lifted');
      rec.tile.style.transition = 'none';
      rec.tile.style.transform = TILE_HOME;
      rec.tile.style.opacity = '1';
    }
    void ghostEl.offsetWidth;

    if (fade) {
      panelEl.style.transition = 'opacity 150ms linear';
      setOpacity(ghostEl, 1, ms);
      setOpacity(scrimEl, scrimLevel(), ms);
    } else {
      ghostEl.style.transition = 'transform ' + ms + 'ms ' + EASE;
      ghostEl.style.transform = IDENTITY;
      panelEl.style.transition = 'transform ' + ms + 'ms ' + EASE + ', opacity 150ms linear';
      panelEl.style.transform = IDENTITY;
      rec.tile.style.transition = 'transform ' + ms + 'ms ' + EASE + ', opacity ' + Math.round(ms * 0.45) + 'ms linear';
      rec.tile.style.transform = tileToCenter(T, P);
      rec.tile.style.opacity = '0';
      // Push keeps the scrim transparent: it only catches clicks outside.
      if (push && !direct) pushOthers(rec, ms);
      else setOpacity(scrimEl, scrimLevel(), ms);
    }
    after(ghostEl, ms, function () { moved = true; finish(); });

    afterFrame(function () {
      var t0 = now();
      if (!prebuilt) {
        fillPanel(rec);
      }
      skip = [t0, now()];
      panelEl.style.opacity = '1';
      // Motion extras: the items arrive from the tile's side (not in fade mode).
      if (!prebuilt && !fade && rec.w.stagger) fxCall('stagger', [panel.body, rec.w.stagger, T, P, 140 - (now() - openedAt)]);
      built = true;
      finish();
    });
  }

  // The panel's head and content for rec (open is rec already).
  function fillPanel(rec) {
    try {
      drawPanelHead();
      setPanelSub(rec.ctx.config.sub || rec.w.sub || '');
      drawPanelBody(false);
    } catch (e) {
      if (window.console && console.warn) console.warn('Panel build: ' + (e && e.message));
    }
  }

  // The mirror of opening: the content fades out quickly while shrinking
  // toward the tile, the ghost shrinks onto the tile, and the tile rides
  // back home fading in, so there is always something in the box.
  function closePanel() {
    if (busy || !open) return;
    var rec = open;
    busy = true;

    function done() {
      panelEl.className = 'panel';
      panelEl.removeAttribute('data-panel-widget');
      panelEl.style.transition = 'none';
      panelEl.style.transform = '';
      panelEl.style.opacity = '0';
      scrimEl.className = 'scrim';
      scrimEl.style.transition = 'none';
      parkGhost();
      clearTile(rec);
      rec.tile.style.visibility = '';
      rec.cell.classList.remove('is-solo-waiting');
      settleOthers();
      if (panelFocus) panelFocus.classList.remove('is-focused');
      panelFocus = null;
      open = null;
      openAuto = false;
      syncPicLabel();
      mode = null;
      busy = false;
      focusHome(rec.index);
      call(rec, 'onClose', [rec.ctx]);
      panel.body.innerHTML = '';
      layoutChance();
    }

    if (motion.mode === 'fade' || mode === 'full' || rec === soloRec) {
      // From full screen everything just fades; there is no tile-sized box to shrink to cleanly.
      // A one-widget layout's window fades too: its tile is the whole screen.
      // (A shared picture, the Now Playing cover, flies back to the tile.)
      if (mode === 'full') fxCall('shareTo', [fxCall('shareFrom', [panel.body]), rec.body, true]);
      setOpacity(panelEl, 0, 140);
      setOpacity(ghostEl, 0, 140);
      setOpacity(scrimEl, 0, 140);
      rec.tile.style.visibility = '';
      returnOthers(rec, 140);
      after(panelEl, 140, done);
      return;
    }

    var ms = 280;
    var P = panelRect(rec);
    var T = rec.home || rectOf(rec.tile);
    var stop = startSampling();
    rec.cell.classList.add('is-raised');
    rec.tile.classList.add('is-lifted');
    rec.tile.style.transition = 'none';
    rec.tile.style.transform = tileToCenter(T, P);
    rec.tile.style.opacity = '0';
    rec.tile.style.visibility = '';
    void rec.tile.offsetWidth;
    ghostEl.style.transition = 'transform ' + ms + 'ms ' + EASE;
    ghostEl.style.transform = flip(T, P);
    panelEl.style.transition = 'transform ' + ms + 'ms ' + EASE + ', opacity 90ms linear';
    panelEl.style.transform = panelStart(T, P);
    panelEl.style.opacity = '0';
    // The tile starts fading in just before the content is gone, so the two overlap.
    rec.tile.style.transition = 'transform ' + ms + 'ms ' + EASE + ', opacity ' + Math.round(ms * 0.5) + 'ms linear ' + Math.round(ms * 0.2) + 'ms';
    rec.tile.style.transform = TILE_HOME;
    rec.tile.style.opacity = '1';
    if (motion.mode === 'push') returnOthers(rec, ms);
    else setOpacity(scrimEl, 0, ms - 80, 80);
    after(ghostEl, ms, function () { stop(null); done(); });
  }

  function switchMode(next) {
    if (busy || !open || next === mode) return;
    busy = true;
    var rec = open;
    var shared = fxCall('shareFrom', [panel.body]);

    function apply() {
      mode = next;
      panelEl.className = 'panel is-shown' + (next === 'full' ? ' is-full' : wideClass(rec)) + (isDirect(rec.w) ? ' is-direct' : '');
      drawPanelHead();
      call(rec, 'onMode', [next, rec.ctx]);
      if (panelFocus) keepInView(panelFocus);
    }

    function sizeGhost() {
      ghostEl.className = 'ghost' + (next === 'full' ? ' is-full' : wideClass(rec));
      sizeBoxes(next === 'full' ? null : panelRect(rec));
    }

    setOpacity(panelEl, 0, 80);
    if (motion.mode === 'fade') setOpacity(ghostEl, 0, 80);
    after(panelEl, 80, function () {
      if (motion.mode === 'fade') {
        // Both are invisible, so the frame just changes size with the content.
        sizeGhost();
        apply();
        void panelEl.offsetWidth;
        fxCall('shareTo', [shared, panel.body, next !== 'full']);
        setOpacity(panelEl, 1, 120);
        setOpacity(ghostEl, 1, 120);
        after(panelEl, 120, function () { busy = false; });
        return;
      }
      // The frame morphs between the two rects while the content is out.
      var from = rectOf(ghostEl);
      sizeGhost();
      var to = rectOf(ghostEl);
      ghostEl.style.transition = 'none';
      ghostEl.style.transform = flip(from, to);
      apply();
      void ghostEl.offsetWidth;
      fxCall('shareTo', [shared, panel.body, next !== 'full']);
      var stop = startSampling();
      ghostEl.style.transition = 'transform 240ms ' + EASE;
      ghostEl.style.transform = IDENTITY;
      setOpacity(panelEl, 1, 120, 130);
      after(ghostEl, 240, function () {
        stop(null);
        ghostEl.style.transition = 'none';
        busy = false;
      });
    });
  }

  /* ---------- dashboard frame ---------- */

  function openFrame(url) {
    if (!url) return toast(hubWord('noAddress', 'This dashboard has no address yet.'));
    closeAbout();
    clayHook('stop');
    fxCall('activityStop');
    frameOpen = true;
    syncPicLabel();
    frameEl.src = url;
    frameWrap.hidden = false;
  }

  function closeFrame() {
    frameEl.src = 'about:blank';
    frameWrap.hidden = true;
    frameOpen = false;
    syncPicLabel();
    layoutChance();
  }

  /* ---------- keys ---------- */

  function isBack(code) { return code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE; }

  var keyRepeat = false;     // the key being handled is a held one (no glide for it)

  // window.HUB_ALERT, from a widget that shows a banner: { shown(), dismiss() }.
  function alertShown() {
    var A = window.HUB_ALERT;
    try { return !!(A && typeof A.shown === 'function' && A.shown()); } catch (e) { return false; }
  }

  function dismissAlert() {
    try { window.HUB_ALERT.dismiss(); } catch (e) { /* nothing more to do */ }
  }

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;
    var dir = dirOf(code);
    keyRepeat = !!e.repeat;
    var handled = dir || code === KEY.ENTER || isBack(code);

    if (frameOpen) {
      if (isBack(code)) { e.preventDefault(); closeFrame(); }
      return;
    }
    if (tablet.show) {               // the tablet's Slideshow: Back (or OK) ends it
      e.preventDefault();
      if (isBack(code) || code === KEY.ENTER) closeShow();
      return;
    }
    var box = typingBox();
    if (box) { typingKey(e, box); return; }
    // A keyboard letter on a focused text box starts typing; the browser then
    // puts that letter in the box. Backspace there deletes instead of going Back.
    if (open && !busy && isTextBox(panelFocus) &&
        (isPrintable(e) || (code === KEY.BACKSPACE && panelFocus.value))) {
      startTyping(panelFocus);
      return;
    }
    if (!handled) return;
    e.preventDefault();
    // A held OK on an interactive tile: the repeat makes it a long press.
    if (code === KEY.ENTER && e.repeat && okPress) {
      if (!okPress.decided) decidePress('long');
      return;
    }
    // A held OK or Back counts once. Otherwise holding OK on a tile would
    // carry on pressing things inside the panel it opens.
    if (e.repeat && !dir) return;
    if (busy) return;
    // The TV keyboard can send a stray Enter after Done or Back after Cancel.
    if ((code === KEY.ENTER || isBack(code)) && Date.now() - typingEndedAt < 300) return;

    // A banner over the screen (budget.js's "New charge: ..."): OK or Back
    // dismisses it first, wherever you are (home, a panel, the layout switcher,
    // About); the arrows still move as usual.
    if ((code === KEY.ENTER || isBack(code)) && alertShown()) {
      dismissAlert();
      return;
    }

    if (tablet.sheetOn) { sheetKey(code, dir); return; }
    if (tablet.peek && !open) { peekKey(code, dir); return; }
    if (tablet.peek) hidePeek(false);       // a panel opened meanwhile: it has the keys

    if (ab.on) {
      if (dir === 'right' || isBack(code)) closeAbout();
      else if (dir === 'up' || dir === 'down') scrollAbout(dir);
      else if (code === KEY.ENTER) aboutAction();
      return;
    }

    if (sw.on) {
      if (code === KEY.ENTER) chooseLayout();
      else if (dir === 'left' || dir === 'right') moveSwitcher(dir);
      else if (dir === 'down' || isBack(code)) closeSwitcher();
      return;
    }

    if (open) {
      if (dir) movePanel(dir);
      else if (code === KEY.ENTER) selectPanel();
      else backInPanel();
      return;
    }

    if (engaged && !canEngage(engaged)) disengage();   // a layout made it too small
    if (isBack(code) && okPress) clearPress();
    if (engaged) { engagedKey(code, dir, e.repeat); keyRepeat = false; return; }
    if (dir) moveHome(dir);
    else if (code === KEY.ENTER && homeIndex >= 0) {
      if (canEngage(widgets[homeIndex])) startPress(widgets[homeIndex]);
      else openPanel(widgets[homeIndex]);
    }
    // Back on the home stage does nothing: the hub is home.
    keyRepeat = false;
  });

  /* ---------- tile header ---------- */

  /*
   * Every tile with a title has one header: the icon (1.5rem), the title on
   * one line (never wrapped) and, on the right, an optional badge (Soon,
   * Sample, a state). A title that doesn't fit on one line at its size takes
   * the widget's short form (w.shortTitle: a string, a getter or a function
   * of the tile's size), and only if that doesn't fit either does it end in
   * "...". The hub's own words follow the language: 'hub.<key>' in i18n.js.
   */
  function hubWord(key, english, vars) {
    var L = window.HUB_I18N;
    if (L && typeof L.t === 'function') {
      try { return String(L.t('hub.' + key, english, vars)); } catch (e) { /* English below */ }
    }
    return english;
  }

  // The header's elements, in parent (a tile, or a widget's own body that
  // draws a header of the same kind: ctx.drawHead).
  function buildHead(parent, iconName, title, badge) {
    var head = el('div', 'tile-head', parent);
    var icon = el('span', 'icon tile-icon', head);
    icon.innerHTML = iconHTML(iconName);
    var titles = el('div', 'tile-titles', head);
    var t = el('div', 'tile-title', titles);
    t.textContent = title || '';
    var b = el('span', 'tile-badge', head);
    setBadgeText(b, badge);
    return { head: head, title: t, titles: titles, badge: b };
  }

  function setBadgeText(node, text) {
    text = text ? String(text) : '';
    if (node.textContent !== text) node.textContent = text;
    node.style.display = text ? '' : 'none';
    // The planned tiles' tag kept its old name, for the tests and the CSS.
    if (text && node.parentNode && hasClass(node.parentNode.parentNode || node, 'is-planned')) node.classList.add('tile-soon');
  }

  function widgetShort(rec) {
    var s = rec.w.shortTitle;
    try { if (typeof s === 'function') s = s(rec.size || sizeOf(null)); } catch (e) { s = ''; }
    return s ? String(s) : '';
  }

  // Puts text in a title element, or its short form when the full one would
  // need a second line. Only reads layout when the full one may not fit.
  function fitTitle(node, full, short) {
    if (node.textContent !== full) node.textContent = full;
    if (node.getAttribute('data-full')) node.removeAttribute('data-full');
    if (!short || short === full || !node.clientWidth) return;
    if (node.scrollWidth > node.clientWidth + 1) {
      node.textContent = short;
      node.setAttribute('data-full', full);    // the name it stands for (tests, and anyone curious)
    }
  }

  // The title (or its short form) beside the badge; if even that can't fit,
  // the badge goes to the next line (class is-crowded) and the title is
  // fitted again with the whole row.
  function fitHead(head, title, badge, full, short) {
    head.classList.remove('is-crowded');
    fitTitle(title, full, short);
    if (!badge || !badge.textContent || badge.style.display === 'none' || !title.clientWidth) return;
    if (title.scrollWidth <= title.clientWidth + 1) return;
    if (getComputedStyle(badge).display === 'none') return;
    head.classList.add('is-crowded');
    fitTitle(title, full, short);
  }

  function retitle(rec) {
    if (rec && rec === open) fitPanelTitle();
    if (!rec || !rec.titleEl) return;
    if (rec.badgeText === undefined || rec.badgeText === null) {
      setBadgeText(rec.badgeEl, rec.w.planned ? hubWord('soon', 'Soon') : '');
    }
    var full = rec.titleText || String(rec.w.title || '');
    fitHead(rec.titleEl.parentNode.parentNode, rec.titleEl, rec.badgeEl, full, rec.titleText ? '' : widgetShort(rec));
  }

  function retitleAll() {
    for (var i = 0; i < widgets.length; i++) retitle(widgets[i]);
  }

  /* ---------- tile sub line ---------- */

  // Sets the small line under a tile's title, adding or removing it. The tile
  // head keeps its shape; a tile without a head has nowhere to put it.
  function setTileSub(rec, text) {
    if (!rec || !rec.tile) return;
    var titles = rec.tile.querySelector('.tile-titles');
    if (!titles) return;
    var sub = titles.querySelector('.tile-sub');
    text = text ? String(text) : '';
    if (!text) {
      if (sub) titles.removeChild(sub);
      return;
    }
    if (!sub) sub = el('div', 'tile-sub', titles);
    if (sub.textContent !== text) sub.textContent = text;
  }

  /* ---------- live updates ---------- */

  // The hub server on the Pi can steer the screen (show, home, say, reload)
  // and send data. live.js does the talking; this part acts on commands.
  // Nothing here runs unless live.js is loaded and a server is set, and every
  // path is wrapped so a problem can never stop the hub.

  var LOADED_AT = new Date().getTime();
  var LIVE_WAIT_MS = 4000;     // how long a command waits for a running transition
  var LIVE_STEP_MS = 60;
  var liveApi = null;
  var liveTimer = null;        // one pending step of a show or home command

  function liveWarn(text) {
    try { if (window.console && console.warn) console.warn('Live: ' + text); } catch (e) { /* ignore */ }
  }

  // A thin, safe face over window.HUB_LIVE for widgets, or undefined.
  function liveFacade() {
    var L = window.HUB_LIVE;
    if (!L || typeof L !== 'object' || typeof L.status !== 'function') return undefined;
    if (liveApi) return liveApi;
    function wrap(name, fallback) {
      return function () {
        try {
          if (typeof L[name] !== 'function') return fallback();
          return L[name].apply(L, arguments);
        } catch (e) {
          liveWarn(name + ' failed: ' + (e && e.message));
          return fallback();
        }
      };
    }
    function none() { return undefined; }
    liveApi = {
      status: wrap('status', function () { return { state: 'off', text: '', since: 0 }; }),
      get: wrap('get', none),
      on: wrap('on', function () { return function () {}; }),
      onStatus: wrap('onStatus', none),
      everConnected: wrap('everConnected', function () { return false; }),
      // GET JSON from the server's screen door (the show page's episode list).
      fetch: function (path, cb) {
        var finished = false;
        function done(err, data, code) {
          if (finished) return;
          finished = true;
          if (typeof cb === 'function') cb(err, data, code);
        }
        try {
          if (typeof L.fetch !== 'function') throw new Error('no fetch');
          L.fetch(path, done);
        } catch (e) {
          setTimeout(function () { done('live updates are not available', null, 0); }, 0);
        }
      },
      post: function (path, body, cb) {
        var finished = false;
        function done(err, data, code) {
          if (finished) return;
          finished = true;
          if (typeof cb === 'function') cb(err, data, code);
        }
        try {
          if (typeof L.post !== 'function') throw new Error('no post');
          L.post(path, body, done);
        } catch (e) {
          setTimeout(function () { done('live updates are not available', null, 0); }, 0);
        }
      }
    };
    return liveApi;
  }

  function cancelLiveStep() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
  }

  // Runs step() now, or every 60 ms while a transition runs, for up to 4
  // seconds in all. After that it gives up without a word. step() may return
  // true to be run again once the hub is idle (it started a transition).
  function whenIdle(step) {
    cancelLiveStep();
    var startedAt = new Date().getTime();
    function tryStep() {
      liveTimer = null;
      try {
        if (new Date().getTime() - startedAt > LIVE_WAIT_MS) return;
        if (busy) {
          liveTimer = setTimeout(tryStep, LIVE_STEP_MS);
          return;
        }
        if (step() === true) liveTimer = setTimeout(tryStep, LIVE_STEP_MS);
      } catch (e) {
        liveWarn('a command failed: ' + (e && e.message));
      }
    }
    tryStep();
  }

  function widgetById(id) {
    for (var i = 0; i < widgets.length; i++) if (widgets[i].w.id === id) return widgets[i];
    return null;
  }

  // Leaves the dashboard frame and any typing, the parts that are instant.
  function clearForCommand() {
    if (tablet.sheetOn && !tablet.on) closeSheet();   // the TV's Menu: the Pi's command comes first
    hidePeek(false);
    if (frameOpen) closeFrame();
    if (typingBox()) stopTyping();
  }

  function liveShow(data) {
    var id = String(data.widget || '');
    var rec = widgetById(id);
    if (!rec || !rec.expandable) {
      var name = id.length > 40 ? id.substring(0, 40) + '...' : id;
      toast(hubWord('askedShow', 'Asked to show "{name}", which this hub doesn\'t have.', { name: name }), 5000);
      return;
    }
    var wanted = data.mode === 'full' || data.mode === 'panel' ? data.mode : null;
    var opened = false;
    whenIdle(function () {
      clearForCommand();
      if (open && open !== rec) { closePanel(); return true; }
      if (open === rec) {
        // Ours is open: only the mode may need fixing. An open just started
        // here goes full screen only when asked.
        if (wanted && mode !== wanted) switchMode(wanted);
        return false;
      }
      if (opened) return false;   // the open did not happen (closed again meanwhile)
      opened = true;
      focusHome(rec.index);
      openPanel(rec);
      return wanted === 'full';
    });
  }

  function liveHome() {
    whenIdle(function () {
      clearForCommand();
      if (open) closePanel();
      return false;
    });
  }

  // "hub:working <kind> [seconds|done]" in a say text: a sync of that kind is
  // on its way (or ended with nothing new). The Pi passes say texts on as
  // they are, so this needs nothing new there.
  var WORK_SAY_RE = /^hub:working ([a-z][a-z0-9-]{0,23})(?: ([0-9]{1,6}|done))?$/;

  // Texts that start with "hub:" are for the hub, never shown, even when
  // they make no sense to this version.
  // "hub:motion push" (or expand, fade): that motion for this session only,
  // whatever auto measured (to see the extras and the character on a TV
  // that stepped itself down); nothing is stored, so a reload goes back to
  // auto. "hub:motion auto": forget the step-down and time the top rung
  // again from now.
  var MOTION_SAY_RE = /^hub:motion (push|expand|fade|auto)$/;

  function liveMotion(want) {
    if (want === 'auto') {
      try { if (window.localStorage) localStorage.removeItem(MOTION_KEY); } catch (e) { /* ignore */ }
      motion.source = 'auto';
      motion.mode = LADDER[0];
      motion.measuring = true;
    } else {
      motion.source = 'remote';
      motion.mode = want;
      motion.measuring = false;
    }
    motion.fps = 0; motion.worst = 0; motion.worstJanky = 0; motion.clean = []; motion.janky = [];
    markMotion();
    fxHook('motionChanged');
    announceStatus();
  }

  function liveHubSay(text) {
    var mm = MOTION_SAY_RE.exec(text);
    if (mm) { liveMotion(mm[1]); return; }
    var m = WORK_SAY_RE.exec(text);
    if (!m) return;
    if (m[2] === 'done') fxCall('workingDone', [m[1]]);
    else fxCall('working', [m[1], m[2] ? Number(m[2]) : null]);
  }

  function liveSay(data) {
    var text = String(data.text === undefined || data.text === null ? '' : data.text).replace(/\s+/g, ' ');
    text = text.replace(/^\s+|\s+$/g, '');
    if (text.substring(0, 4) === 'hub:') { liveHubSay(text); return; }
    text = text.substring(0, 140);
    if (!text) return;
    var seconds = Number(data.seconds);
    if (data.seconds === undefined || data.seconds === null || !isFinite(seconds)) seconds = 6;
    seconds = Math.max(2, Math.min(30, seconds));
    toast(text, Math.round(seconds * 1000));
  }

  // play / stop: one audio element, reused, so a new play replaces whatever
  // was playing. The TV's browser may refuse to start sound that no key
  // press started (autoplay). Two defences: the first key press after
  // loading plays a silent blip through the same element, which unlocks it
  // for later plays; and a play the TV still refuses waits (up to 10
  // minutes) for the next key press, which starts it.
  var SILENT_CLIP = 'data:audio/wav;base64,UklGRogAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWQAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'
  var PLAY_WAIT_MS = 10 * 60 * 1000;
  var liveAudio = null;
  var audioUnlocked = false;
  var audioUnlocking = false;
  var playWaiting = null; // { shown, at } while a refused play waits for a key
  var audioNow = null;     // { url, title } of the real sound loaded, or null
  var audioWatchers = [];
  // A layout switch (or an update) loads the page afresh; sound playing then
  // carries on from where it was if the page comes back within a minute.
  var AUDIO_RESUME_KEY = 'homeHub.audio.resume';
  var AUDIO_RESUME_MS = 60 * 1000;

  function audioChanged() {
    for (var i = 0; i < audioWatchers.length; i++) {
      try { audioWatchers[i](); } catch (e) { liveWarn('audio watcher failed: ' + (e && e.message)); }
    }
  }

  // window.HUB_AUDIO, for widgets (All sounds): what the TV itself plays.
  // now() is null, or { state: 'playing'|'paused'|'waiting', title }.
  window.HUB_AUDIO = {
    now: function () {
      if (!audioNow || !liveAudio || liveAudio.ended) return null;
      var state = playWaiting ? 'waiting' : liveAudio.paused ? 'paused' : 'playing';
      return { state: state, title: audioNow.title };
    },
    onChange: function (fn) { if (typeof fn === 'function') audioWatchers.push(fn); }
  };

  function audioEl() {
    if (liveAudio) return liveAudio;
    liveAudio = new Audio();
    liveAudio.preload = 'auto';
    liveAudio.addEventListener('error', function () {
      var src = liveAudio.getAttribute('src');
      if (!src || src === SILENT_CLIP) return;
      playWaiting = null;
      audioNow = null;
      audioChanged();
      liveWarn('play failed: the audio could not be loaded');
      toast(hubWord('playFailed', 'Could not play that audio'), 5000);
    });
    var real = function () { var src = liveAudio.getAttribute('src'); if (src && src !== SILENT_CLIP) audioChanged(); };
    liveAudio.addEventListener('playing', real);
    liveAudio.addEventListener('pause', real);
    liveAudio.addEventListener('ended', function () {
      if (liveAudio.getAttribute('src') === SILENT_CLIP) return;
      audioNow = null;
      audioChanged();
    });
    return liveAudio;
  }

  function playingText(title) {
    return title ? hubWord('playing', 'Playing: {title}', { title: title }) : hubWord('playingNoTitle', 'Playing');
  }

  // play() as a promise-or-not: ok() once sound starts, no(err) if refused.
  function startAudio(ok, no) {
    var started;
    try { started = liveAudio.play(); } catch (e) { no(e); return; }
    if (started && typeof started.then === 'function') started.then(ok, no);
    else ok();
  }

  function liveStop() {
    var had = !!audioNow;
    playWaiting = null;
    audioNow = null;
    if (liveAudio) {
      try { liveAudio.pause(); } catch (e) {}
      try { liveAudio.removeAttribute('src'); liveAudio.load(); } catch (e2) {}
    }
    if (had) audioChanged();
  }

  function livePlay(data) {
    var url = String(data.url === undefined || data.url === null ? '' : data.url);
    url = url.replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    var title = String(data.title === undefined || data.title === null ? '' : data.title).replace(/\s+/g, ' ');
    title = title.replace(/^\s+|\s+$/g, '').substring(0, 140);
    liveStop();
    audioEl().src = url;
    audioNow = { url: url, title: title };
    // Carrying on after a reload: from the second it was at, without a toast.
    var from = typeof data.from === 'number' && data.from > 0 ? data.from : 0;
    if (from) {
      var seek = function () {
        liveAudio.removeEventListener('loadedmetadata', seek);
        try { if (liveAudio.getAttribute('src') === url) liveAudio.currentTime = from; } catch (e) {}
      };
      liveAudio.addEventListener('loadedmetadata', seek);
    }
    var shown = playingText(title);
    startAudio(function () { audioUnlocked = true; if (!data.quiet) toast(shown, 6000); }, function (err) {
      if (liveAudio.getAttribute('src') !== url) return; // replaced or stopped meanwhile
      liveWarn('play refused: ' + (err && (err.name || err.message)) + '; waiting for a key press');
      playWaiting = { shown: shown, at: new Date().getTime() };
      audioChanged();
      toast(hubWord('playPressKey', 'Press any button on the remote to start the sound'), 8000);
    });
    audioChanged();
  }

  // Before the page goes (a layout switch, an update, a reload): note what is
  // playing. On the next load within a minute it carries on.
  window.addEventListener('beforeunload', function () {
    try {
      if (!window.sessionStorage) return;
      if (!audioNow || !liveAudio || liveAudio.paused || liveAudio.ended) { sessionStorage.removeItem(AUDIO_RESUME_KEY); return; }
      sessionStorage.setItem(AUDIO_RESUME_KEY, JSON.stringify({
        url: audioNow.url, title: audioNow.title, from: liveAudio.currentTime || 0, at: new Date().getTime()
      }));
    } catch (e) { /* no note: the sound simply ends with the page */ }
  });

  (function resumeAudio() {
    var note = null;
    try {
      if (!window.sessionStorage) return;
      note = JSON.parse(sessionStorage.getItem(AUDIO_RESUME_KEY) || 'null');
      sessionStorage.removeItem(AUDIO_RESUME_KEY);
    } catch (e) { return; }
    if (!note || typeof note.url !== 'string' || typeof note.at !== 'number') return;
    var age = new Date().getTime() - note.at;
    if (age < 0 || age > AUDIO_RESUME_MS) return;
    setTimeout(function () {
      try { livePlay({ url: note.url, title: note.title, from: Number(note.from) || 0, quiet: true }); } catch (e) { liveWarn('resume failed: ' + (e && e.message)); }
    }, 0);
  })();

  // Every key press (capture phase, nothing is stopped or changed): start a
  // play that is waiting, or unlock the audio element once.
  document.addEventListener('keydown', function () {
    if (playWaiting) {
      var w = playWaiting;
      playWaiting = null;
      if (new Date().getTime() - w.at > PLAY_WAIT_MS || !liveAudio || !liveAudio.getAttribute('src')) return;
      startAudio(function () { audioUnlocked = true; audioChanged(); toast(w.shown, 6000); }, function (err) {
        liveWarn('play refused again after a key press: ' + (err && (err.name || err.message)));
        liveStop();
        toast(hubWord('playNoStart', 'Could not start the audio'), 5000);
      });
      return;
    }
    if (audioUnlocked || audioUnlocking) return;
    var el = audioEl();
    if (el.getAttribute('src')) return; // something real is loaded; leave it alone
    audioUnlocking = true;
    el.src = SILENT_CLIP;
    startAudio(function () {
      audioUnlocking = false;
      audioUnlocked = true;
      if (el.getAttribute('src') !== SILENT_CLIP) return;
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
    }, function () {
      audioUnlocking = false; // try again on the next key press
      if (el.getAttribute('src') === SILENT_CLIP) {
        try { el.removeAttribute('src'); el.load(); } catch (e) {}
      }
    });
  }, true);

  function liveReload() {
    // A reload loop (an old command arriving right after loading) must not happen.
    if (new Date().getTime() - LOADED_AT < 30000) return;
    // Through the shell, so it also picks up the newest version.
    var U = updateApi('restart');
    if (U) {
      try { U.restart(); return; } catch (e) { liveWarn('restart failed: ' + (e && e.message)); }
    }
    location.reload();
  }

  function onLiveCommand(type, data) {
    try {
      data = data && typeof data === 'object' ? data : {};
      if (type === 'show') liveShow(data);
      else if (type === 'home') liveHome();
      else if (type === 'say') liveSay(data);
      else if (type === 'play') livePlay(data);
      else if (type === 'stop') liveStop();
      else if (type === 'reload') liveReload();
    } catch (e) {
      liveWarn(type + ' failed: ' + (e && e.message));
    }
  }

  // The live resources whose arrival can end a working chip of the same
  // kind. Data that brought news turns the chip into the arrival chip (the
  // widget calls ctx.activity); otherwise, shortly after, it just ends.
  // How long after the data that is (HUB_FX.rules().settleMs, 1.5 s; the
  // working rules live with the chips in app/motion.js).
  var WORK_RESOURCES = ['todo', 'calendar', 'awws'];
  var WORK_SETTLE_MS = 1500;

  function workSettleMs() {
    var r = fxCall('rules');
    var ms = r && typeof r.settleMs === 'number' && isFinite(r.settleMs) ? r.settleMs : WORK_SETTLE_MS;
    return Math.max(0, Math.min(10000, ms));
  }

  function onWorkData(kind) {
    return function () {
      try {
        var at = new Date().getTime();
        setTimeout(function () { fxCall('workingDone', [kind, at]); }, workSettleMs());
      } catch (e) { /* the chip ends by itself */ }
    };
  }

  function startLive() {
    var L = window.HUB_LIVE;
    if (!L || typeof L !== 'object' || typeof L.start !== 'function') return;
    try {
      var server = cfg.live && typeof cfg.live.server === 'string' ? cfg.live.server : '';
      if (!server && readQuery('live') === null) return;
      if (typeof L.onCommand === 'function') L.onCommand(onLiveCommand);
      if (typeof L.onStatus === 'function') L.onStatus(function () { announceStatus(); });
      if (typeof L.on === 'function') L.on('layout', onLayoutData);
      if (typeof L.on === 'function') {
        for (var i = 0; i < WORK_RESOURCES.length; i++) L.on(WORK_RESOURCES[i], onWorkData(WORK_RESOURCES[i]));
      }
      L.start({ server: server });
    } catch (e) {
      liveWarn('could not start: ' + (e && e.message));
    }
  }

  /* ---------- updates ---------- */

  // app/update.js moves the hub to the newest commit of its branch. Here the
  // hub only says when a reload would bother nobody and reports the status.
  // The @main fallback can still mix old and new files, so every call is
  // checked and wrapped.

  var IDLE_MS = 120000;        // no key or click for this long
  var lastInputAt = 0;
  var idleOverride = null;     // tests: true or false instead of the real answer

  function updateApi(name) {
    var U = window.HUB_UPDATE;
    return U && typeof U === 'object' && typeof U[name] === 'function' ? U : null;
  }

  function noteInput() {
    lastInputAt = new Date().getTime();
    // Keys pressed while the About panel is open (scrolling it, and closing it)
    // are not "using the remote" for the wanderers: they keep to their own
    // schedule, so the panel can be watched and left without restarting it.
    if (!ab.on) clayHook('input');
  }
  document.addEventListener('keydown', noteInput, true);
  document.addEventListener('click', noteInput, true);

  function hubIdle() {
    if (idleOverride !== null) return idleOverride;
    if (busy || open || frameOpen || typingBox()) return false;
    return new Date().getTime() - lastInputAt >= IDLE_MS;
  }

  // app/appver.js (pages the Pi serves): its status, or undefined without it.
  function appverApi(name) {
    var A = window.HUB_APPVER;
    return A && typeof A === 'object' && typeof A[name] === 'function' ? A : null;
  }

  function appverStatus() {
    var A = appverApi('status');
    if (!A) return undefined;
    try { return A.status(); } catch (e) { return undefined; }
  }

  function appverLabel() {
    var A = appverApi('label');
    if (!A) return '';
    try { return A.label() || ''; } catch (e) { return ''; }
  }

  function appverReload() {
    var A = appverApi('reload');
    if (A) A.reload();
  }

  // A quiet dot on the Clock tile while the Pi has a newer version.
  function updateDot() {
    var a = appverStatus();
    var on = !!a && a.state === 'available';
    for (var i = 0; i < widgets.length; i++) {
      var rec = widgets[i];
      if (rec.w.id !== 'today' || !rec.tile) continue;
      if (!rec.updateDot) {
        if (!on) continue;
        rec.updateDot = el('span', 'update-dot', rec.tile);
        rec.updateDot.setAttribute('aria-hidden', 'true');
      }
      if (on) rec.updateDot.classList.add('is-on');
      else rec.updateDot.classList.remove('is-on');
    }
  }

  // The status object, or undefined without update.js.
  function updateStatus() {
    var U = updateApi('status');
    if (!U) return undefined;
    try { return U.status(); } catch (e) { return undefined; }
  }

  function startUpdates() {
    startAppver();
    var U = updateApi('watch');
    if (!U) return;
    try {
      U.watch({ idle: hubIdle, onStatus: function () { announceStatus(); } });
    } catch (e) {
      liveWarn('updates could not start: ' + (e && e.message));
    }
  }

  function startAppver() {
    var A = appverApi('start');
    if (!A) return;
    try {
      A.start({ version: BUILD.replace(/^v/, ''), idle: hubIdle, onStatus: function () { updateDot(); announceStatus(); } });
    } catch (e) {
      liveWarn('version check could not start: ' + (e && e.message));
    }
  }

  // Tells update.js this commit started. The very last step of the start.
  function reportStarted() {
    var U = updateApi('started');
    if (!U) return;
    try { U.started({ version: BUILD.replace(/^v/, '') }); } catch (e) { liveWarn('started failed: ' + (e && e.message)); }
  }

  // For tests in a laptop browser.
  window.HUB_TEST.open = function () { return open ? open.w.id : null; };
  window.HUB_TEST.engaged = function () { return engaged ? engaged.w.id : null; };
  window.HUB_TEST.mode = function () { return mode; };
  window.HUB_TEST.busy = function () { return busy; };
  // The About panel: open() and close() as Left and Right would (open only
  // when it could), isOpen(), and rows(): [{ group, label, value, raw }]
  // (raw: the source text, e.g. 'Live: lost the Pi at 9:41 AM'), as shown
  // (the no-break spaces that keep a number with its unit read as spaces).
  window.HUB_TEST.about = {
    open: function () { openAbout(); return ab.on; },
    close: function () { closeAbout(); return !ab.on; },
    isOpen: function () { return ab.on; },
    rows: function () {
      var out = [];
      if (!ab.on || !ab.box) return out;
      for (var i = 0; i < ab.drawn.length; i++) {
        var r = ab.drawn[i];
        var value = ab.rows[i].textContent.replace(/\u00a0/g, ' ');
        var raw = value;
        try { if (r.raw) raw = r.raw(); } catch (e) { /* the value then */ }
        out.push({ group: r.group, label: r.label, value: value, raw: raw });
      }
      return out;
    }
  };
  window.HUB_TEST.idle = hubIdle;
  window.HUB_TEST.setIdle = function (value) { idleOverride = value === true || value === false ? value : null; };
  window.HUB_TEST.setIdleMs = function (ms) { IDLE_MS = ms; };
  window.HUB_TEST.rotate = {
    times: function (moveMs, awakeMs, tickMs) { ROTATE_MS = moveMs; ROTATE_AWAKE_MS = awakeMs; ROTATE_TICK_MS = tickMs; rot.lastMove = new Date().getTime(); rotateTimer(); },
    state: function () { return { on: rotateOn(), held: rotateHeld(), due: rotateDue() - new Date().getTime(), order: rotatePresets().map(function (p) { return p.id || p.name; }) }; },
    next: rotateNext
  };
  window.HUB_TEST.cleanLayout = cleanLayout;
  window.HUB_TEST.layout = function () { return layoutKey ? JSON.parse(layoutKey) : null; };
  window.HUB_TEST.layoutWaiting = function () { return pendingLayout !== undefined; };
  window.HUB_TEST.checkUpdates = function () { var U = updateApi('check'); if (U) U.check(); };
  // Open a widget's panel, or close the open one, as OK and Back would, but
  // without counting as a key press (so the idle timer isn't touched).
  window.HUB_TEST.openPanel = function (id) {
    if (busy || open || frameOpen) return false;
    for (var i = 0; i < widgets.length; i++) {
      if (widgets[i].w.id === id && widgets[i].expandable) { focusHome(i); openPanel(widgets[i]); return true; }
    }
    return false;
  };
  window.HUB_TEST.closePanel = function () {
    if (busy || !open) return false;
    closePanel();
    return true;
  };

  /* ---------- clay characters ---------- */

  // app/clay.js: Ian and Ember wander across the home screen now and then
  // while nobody uses the remote (docs/clay.md). The hub lends it a read-only
  // view (is a panel, the dashboard or the layout bar open, where are the
  // tiles, two widget getters, the live status) and tells it about input, panels and layout changes. Every call
  // is wrapped, so without clay.js, or with a broken one, nothing changes.

  function clayApi(name) {
    var K = window.HUB_CLAY;
    return K && typeof K === 'object' && typeof K[name] === 'function' ? K : null;
  }

  function clayHook(name) {
    var K = clayApi(name);
    if (!K) return;
    try { K[name](); } catch (e) { /* the characters just don't show */ }
  }

  // HUB_CLAY.status() ({ now, visits, last, drawing, loading, problem, text }), or null.
  function clayStatus() {
    var K = clayApi('status');
    if (!K) return null;
    try { return K.status() || null; } catch (e) { return null; }
  }

  function startClay() {
    var K = clayApi('start');
    if (!K) return;
    try {
      K.start({
        config: cfg.clay,
        quiet: function () { return !busy && !open && !frameOpen && !sw.on && !typingBox(); },
        // Why quiet() is false, for the status line: 'typing' | 'panel' | 'frame' | 'switcher' | 'moving' | ''.
        busyWhy: function () {
          return typingBox() ? 'typing' : open ? 'panel' : frameOpen ? 'frame' :
            sw.on ? 'switcher' : busy ? 'moving' : '';
        },
        // Each tile's rect, measured now (a scene measures once, as it starts).
        tiles: function () {
          measureHome();
          var out = [];
          for (var i = 0; i < widgets.length; i++) {
            var h = widgets[i].home;
            if (h) out.push({ id: widgets[i].w.id, left: h.left, top: h.top, width: h.width, height: h.height });
          }
          return out;
        },
        // Read-only getters some widgets offer: weather.current(), todo.doneCount().
        widget: function (id) { return registry.hasOwnProperty(id) ? registry[id] : null; },
        liveStatus: function () { var L = liveFacade(); return L ? L.status() : null; }
      });
    } catch (e) {
      liveWarn('clay could not start: ' + (e && e.message));
    }
  }

  window.HUB_TEST.clay = window.HUB_CLAY && window.HUB_CLAY.test ? window.HUB_CLAY.test : null;

  /* ---------- characters ---------- */

  // app/agents.js: a pixel-art character who swoops in beside a tile's
  // working or arrival chip (docs/agents.md). motion.js tells it about the
  // chips; the hub only starts it, ends it at once on a layout change or a
  // resize, and shows its status in the About panel. Every call is wrapped,
  // so without agents.js, or with a broken one, nothing changes.

  function agentsApi(name) {
    var A = window.HUB_AGENTS;
    return A && typeof A === 'object' && typeof A[name] === 'function' ? A : null;
  }

  function agentsHook(name) {
    var A = agentsApi(name);
    if (!A) return;
    try { A[name](); } catch (e) { /* the chips show alone */ }
  }

  // A part of HUB_AGENTS.status() ({ now, seen, drawing, asked }), or ''.
  // The rows wait for the first chip (asked): before it there is nothing to say.
  function agentsPart(name) {
    var A = agentsApi('status');
    var st = null;
    try { st = A ? A.status() : null; } catch (e) { st = null; }
    return st && st.asked > 0 && typeof st[name] === 'string' ? st[name] : '';
  }

  function startAgents() {
    var A = agentsApi('start');
    if (!A) return;
    try { A.start({ config: cfg.agents }); } catch (e) { /* the chips show alone */ }
  }

  window.HUB_TEST.agents = window.HUB_AGENTS && window.HUB_AGENTS.test ? window.HUB_AGENTS.test : null;

  /* ---------- motion extras ---------- */

  // app/motion.js: the focus ring that glides, items that arrive in an
  // opened panel, the Now Playing cover's flight, the
  // launch bloom, the activity chips and quiet waiting tiles. They run only when the timing
  // above says the screen keeps up (speed 'ok'), and every call is wrapped,
  // so without motion.js, or with a broken one, nothing changes.

  function fxCall(name, args) {
    var F = window.HUB_FX;
    if (!F || typeof F !== 'object' || typeof F[name] !== 'function') return undefined;
    try { return F[name].apply(F, args || []); } catch (e) { return undefined; }
  }
  function fxHook(name) { fxCall(name); }

  // 'fade' in fade mode; 'slow' when auto stepped down from push, a run is
  // stuttering while auto still measures, or the measured rate is under 40;
  // otherwise 'ok'.
  function fxSpeed() {
    if (motion.mode === 'fade') return 'fade';
    if (motion.source === 'auto' && motion.mode !== LADDER[0]) return 'slow';
    if (motion.fps && motion.fps < 40) return 'slow';
    if (motion.measuring && motion.janky.length) return 'slow';
    return 'ok';
  }

  // The same for the light extras only (activity chips, working chips, the
  // accent edge and its border light: opacity and transform on small
  // elements): when auto stepped down from push but the screen still
  // measures 60 fps or more with no stuttering run, they keep running
  // ('ok') while the heavy ones (ring glide, stagger, cover, bloom) stay
  // off. Otherwise as fxSpeed.
  var LIGHT_FPS = 60;
  function fxLightSpeed() {
    var sp = fxSpeed();
    if (sp !== 'slow') return sp;
    if (motion.source === 'auto' && motion.mode !== LADDER[0] && motion.fps >= LIGHT_FPS &&
        !(motion.measuring && motion.janky.length)) return 'ok';
    return 'slow';
  }

  // The focused tile's resting rect, or null.
  function focusRect() {
    var rec = homeIndex >= 0 ? widgets[homeIndex] : null;
    return rec && rec.home ? rec.home : null;
  }

  function startFx() {
    fxCall('start', [{
      config: cfg.motionFx,
      speed: fxSpeed,
      lightSpeed: fxLightSpeed,
      // The home screen is in view and uncovered (the activity chips wait for it).
      quiet: function () { return !busy && !open && !frameOpen && !sw.on && !typingBox() && !document.hidden; },
      clayDrawing: function () {
        var K = clayApi('drawing');
        try { return K ? K.drawing() === true : false; } catch (e) { return false; }
      },
      tileFor: fxTileFor
    }]);
  }

  // The home tile for a kind's working chip: the first in layout order whose
  // widget declares activity: kind, else the one whose id is kind, or null.
  var fxLayout = { key: null, list: [] };
  function fxTileFor(kind) {
    if (fxLayout.key !== layoutKey) {
      fxLayout.key = layoutKey;
      try { fxLayout.list = layoutKey ? JSON.parse(layoutKey) : []; } catch (e) { fxLayout.list = []; }
    }
    var order = [];
    var i;
    for (i = 0; i < fxLayout.list.length; i++) {
      var rec = fxLayout.list[i] ? widgetById(fxLayout.list[i].widget) : null;
      if (rec && order.indexOf(rec) < 0) order.push(rec);
    }
    for (i = 0; i < widgets.length; i++) if (order.indexOf(widgets[i]) < 0) order.push(widgets[i]);
    for (i = 0; i < order.length; i++) {
      if (order[i].tile && order[i].home && order[i].w.activity === kind) return order[i].tile;
    }
    for (i = 0; i < order.length; i++) {
      if (order[i].tile && order[i].home && order[i].w.id === kind) return order[i].tile;
    }
    return null;
  }

  window.HUB_TEST.fx = function () { return fxCall('state') || null; };
  window.HUB_TEST.focusRect = function () { return focusRect(); };
  window.HUB_TEST.setFocusKeepMs = function (ms) { FOCUS_KEEP_MS = ms; };
  window.HUB_TEST.focused = function () { return homeIndex >= 0 && widgets[homeIndex] ? widgets[homeIndex].w.id : null; };

  /* ---------- tablet mode ---------- */

  // The hub on a wall tablet (Android, Fully Kiosk, Chrome 52 WebView): no
  // remote, no Tizen API and no service.js. ?as=tablet turns it on and
  // ?as=tv keeps it off; otherwise a touch screen with no Tizen API turns it
  // on once service.js turns out not to answer. Then: the Back chip and the
  // dark around a panel close it (as Back would), a tab on the bottom edge
  // pulls up a sheet with About (left) and the layouts (right). With no
  // service.js, ctx.noHelper tells widgets that nothing can open a TV app
  // (Entertainment keeps only the Schedule). A TV never gets any of it.
  // docs/tablet-mode.md; styles in app/tablet.css; dev/tablet-test.js.
  var CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 15l6-6 6 6"/></svg>';

  function tabletWanted() {
    var as = readQuery('as');
    if (as === 'tv') return 'no';
    if (as === 'tablet') return 'yes';
    var ua = navigator.userAgent || '';
    if (hasPageTizen || /Tizen|Web0S|SMART-TV/i.test(ua)) return 'no';
    return ('ontouchstart' in window) || /Android/i.test(ua) ? 'maybe' : 'no';
  }

  function startTablet() {
    var want = tabletWanted();
    if (want === 'no') return;
    if (want === 'yes') tabletOn();
    service('/ping', 3000, function (err) {
      if (!err) return;
      tablet.noHelper = true;
      tabletOn();
      if (open) { drawPanelBody(true); refitOpen(); }
    });
  }

  function tabletOn() {
    var i;
    if (!tablet.on) {
      tablet.on = true;
      document.documentElement.classList.add('tablet');
      document.body.classList.add('tablet');
      buildSheet();
      hidePeek(true);
      tapFrameHint();
    }
    for (i = 0; i < widgets.length; i++) { widgets[i].ctx.tablet = true; widgets[i].ctx.noHelper = tablet.noHelper; }
    // Tiles drawn before it turned on (the to-do tile measures differently).
    for (i = 0; i < widgets.length; i++) drawTile(widgets[i]);
    if (open) drawPanelHint();
  }

  // The one way a tablet with no service.js opens something on the TV: the
  // Pi turns the TV on if it is off, waits for it, then opens it through
  // Home Assistant (POST /tv/launch). req: { kind: 'app' | 'tizentube' |
  // 'key' | 'webhook', name, match?, key?, url?, title?, link? } (title and link:
  // a show's Watch, docs/tablet-mode.md). cb(err) when it answered.
  function launchOnTv(req, cb) {
    req = req || {};
    var name = String(req.name || '');
    var done = function (err) { if (typeof cb === 'function') { try { cb(err || null); } catch (e) { /* ignore */ } } };
    var L = liveFacade();
    if (!L || typeof L.post !== 'function') {
      toast(hubWord('tvOpenFailed', 'Couldn’t open {name} on the TV ({why}).', { name: name, why: hubWord('tvNoPi', 'the Pi isn’t reachable') }), 6000);
      return done('no live');
    }
    // The Pi answers at once (202, { ok: true, queued: true }) and works on in
    // the background: the TV can take a minute to wake. docs/tablet-mode.md.
    toast(hubWord('tvOpening', 'Opening {name} on the TV…', { name: name }), 15000);
    L.post('/tv/launch', req, function (err, data, code) {
      if ((!err && data && data.ok !== false) || (code === 202 && !(data && data.ok === false))) return done(null);
      var why = code === 404 ? hubWord('tvOldPi', 'the Pi needs an update') : (data && typeof data.error === 'string' && data.error) || String(err || 'HTTP ' + code);
      toast(hubWord('tvOpenFailed', 'Couldn’t open {name} on the TV ({why}).', { name: name, why: why }), 8000);
      done(why);
    });
  }

  // The Back chip or the dark around the panel, tapped: what Back does.
  function tabletBack() {
    if (busy || !open || frameOpen) return;
    if (alertShown()) { dismissAlert(); return; }
    if (typingBox()) { stopTyping(); return; }
    // The tap itself ended the typing (the box lost focus): that was all it did.
    if (Date.now() - typingEndedAt < 300) return;
    backInPanel();
  }

  function buildSheet() {
    var t = tablet;
    if (t.sheet) return;                    // built once: on a TV at start, on a tablet when it turns on
    t.tab = el('div', 'tablet-tab', document.body);
    t.tab.setAttribute('role', 'button');
    var pill = el('span', 'tablet-tab-pill', t.tab);
    el('span', 'tablet-chev', pill).innerHTML = CHEVRON;
    t.tabLabel = el('span', 'tablet-tab-label', pill);
    t.sheet = el('div', 'tsheet', document.body);
    t.sheet.setAttribute('role', 'dialog');
    t.head = el('div', 'tsheet-head', t.sheet);
    t.close = el('div', 'tsheet-close', t.head);
    t.close.setAttribute('role', 'button');
    el('span', 'tablet-chev is-down', t.close).innerHTML = CHEVRON;
    t.closeLabel = el('span', 'tsheet-close-label', t.close);
    var cols = el('div', 'tsheet-cols', t.sheet);
    var left = el('div', 'tsheet-col tsheet-left', cols);
    t.setTitle = el('div', 'tsheet-title', left);
    t.settings = el('div', 'tsheet-settings', left);
    t.leftTitle = el('div', 'tsheet-title', left);
    t.left = el('div', 'tsheet-slot', left);
    var right = el('div', 'tsheet-col tsheet-right', cols);
    t.rightTitle = el('div', 'tsheet-title', right);
    t.right = el('div', 'tsheet-slot', right);
    t.empty = el('div', 'tsheet-empty', right);
    t.photoTitle = el('div', 'tsheet-title', right);
    t.showBtn = el('div', 'tsheet-btn tsheet-show', right);
    t.showBtn.setAttribute('role', 'button');
    el('span', 'tsheet-btn-icon', t.showBtn).innerHTML = ICONS.photo || '';
    t.showLabel = el('span', 'tsheet-btn-label', t.showBtn);
    t.showBtn.addEventListener('click', openShow);
    t.settings.addEventListener('click', function (e) {
      for (var n = e.target; n && n !== t.settings; n = n.parentNode) {
        if (n.getAttribute && n.getAttribute('data-set')) { chooseSetting(n.getAttribute('data-set')); return; }
      }
    });
    sheetWords();
    try {
      if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') window.HUB_I18N.onChange(sheetWords);
    } catch (e) { /* stays in the language it started in */ }
    t.tab.addEventListener('click', function () { if (t.sheetOn) closeSheet(); else openSheet(); });
    t.close.addEventListener('click', closeSheet);
    t.sheet.addEventListener('click', onSheetClick);
    sheetDrag(t.tab, true);
    sheetDrag(t.head, false);
  }

  // A web page full screen (ctx.openFrame): on a tablet its "Back to return" chip is a button.
  function tapFrameHint() {
    var t = tablet;
    if (t.frameHint) return;
    t.frameHint = frameWrap.querySelector('.frame-hint');
    if (t.frameHint) {
      t.frameHint.setAttribute('role', 'button');
      t.frameHint.addEventListener('click', function () { if (tablet.on && frameOpen) closeFrame(); });
      t.frameHint.textContent = hubWord('tapClose', 'Tap to close');
    }
  }

  function sheetWords() {
    var t = tablet;
    t.tabLabel.textContent = hubWord('tablet.menu', 'Menu');
    t.closeLabel.textContent = hubWord('tablet.close', 'Close');
    t.leftTitle.textContent = hubWord('tablet.about', 'About this hub');
    t.rightTitle.textContent = hubWord('tablet.layouts', 'Layouts');
    t.empty.textContent = hubWord('tablet.oneLayout', 'Only one layout is saved.');
    t.setTitle.textContent = hubWord('tablet.settings', 'Settings');
    t.photoTitle.textContent = hubWord('tablet.photos', 'Photos');
    t.showLabel.textContent = hubWord('tablet.slideshow', 'Start slideshow');
    if (t.frameHint) t.frameHint.textContent = hubWord('tapClose', 'Tap to close');
    drawSettings();
  }

  // Settings in the sheet: the same choices as the Clock page (app/widgets/today.js),
  // through the same setters: the look (HUB_LOOK), the language (HUB_I18N) and Guest
  // mode (HUB_GUEST, only after the PIN, app/pin.js). The Clock page keeps its own.
  function drawSettings() {
    var box = tablet.settings;
    if (!box) return;
    box.innerHTML = '';
    var L = window.HUB_I18N;
    function row(label, opts) {
      var r = el('div', 'tsheet-set', box);
      el('div', 'tsheet-set-label', r).textContent = label;
      var pills = el('div', 'tsheet-set-opts', r);
      for (var i = 0; i < opts.length; i++) {
        var o = el('div', 'tsheet-opt' + (opts[i][2] ? ' is-on' : ''), pills);
        o.setAttribute('data-set', opts[i][0]);
        o.setAttribute('role', 'button');
        o.textContent = opts[i][1];
      }
    }
    if (window.HUB_LOOK && typeof window.HUB_LOOK.get === 'function') {
      var lk = window.HUB_LOOK.get();
      row(aboutWord('look.label', 'Look'), [['look-auto', aboutWord('look.auto', 'Auto'), lk === 'auto'],
        ['look-day', aboutWord('look.light', 'Light'), lk === 'day'], ['look-night', aboutWord('look.dark', 'Dark'), lk === 'night']]);
    }
    if (L && typeof L.lang === 'function' && typeof L.setLang === 'function') {
      var lang = L.lang();
      row(aboutWord('lang.label', 'Language'), [['lang-en', 'English', lang === 'en'], ['lang-es', 'Español', lang === 'es']]);
    }
    if (window.HUB_GUEST && typeof window.HUB_GUEST.on === 'function') {
      var g = window.HUB_GUEST.on();
      row(aboutWord('guest.label', 'Guest mode'), [['guest-off', aboutWord('guest.off', 'Off'), !g], ['guest-on', aboutWord('guest.on', 'On'), g]]);
    }
    var ro = rotateOn();
    row(hubWord('rotate.label', 'Rotate layouts'), [['rotate-off', aboutWord('guest.off', 'Off'), !ro], ['rotate-on', aboutWord('guest.on', 'On'), ro]]);
    el('div', 'tsheet-set-note', box).textContent = hubWord('rotate.note', 'Every 2 minutes. Waits 5 minutes after you use it.');
    markSheetFocus();                       // drawn again: the remote's focus stays on its pill
  }

  function chooseSetting(key) {
    try {
      if (key === 'lang-en' || key === 'lang-es') { window.HUB_I18N.setLang(key.slice(5)); drawSettings(); return; }
      if (key.indexOf('look-') === 0) { window.HUB_LOOK.set(key.slice(5)); drawSettings(); return; }
      if (key === 'rotate-on' || key === 'rotate-off') { setRotate(key === 'rotate-on'); drawSettings(); return; }
      if (key === 'guest-on' || key === 'guest-off') {
        var want = key === 'guest-on';
        var P = window.HUB_PIN;
        if (!window.HUB_GUEST || window.HUB_GUEST.on() === want || !P || typeof P.ask !== 'function' || P.isOpen()) return;
        var Lv = liveFacade();
        P.ask({ on: want, post: Lv && typeof Lv.post === 'function' ? Lv.post : undefined }, function (ok, info) {
          if (ok && info && info.all) toast(want ? aboutWord('guest.allOn', 'Guest mode is on for all screens') : aboutWord('guest.allOff', 'Guest mode is off for all screens'), 3500);
          if (ok && window.HUB_GUEST.on() !== want) window.HUB_GUEST.set(want);
          drawSettings();
        });
      }
    } catch (e) { /* the choice stays as it was */ }
  }

  // The Slideshow: every photo full screen (app/widgets/photos.js does the
  // showing) until a tap anywhere, or Back.
  function openShow() {
    if (tablet.show) return;
    closeSheet();
    var o = el('div', 'tshow', document.body);
    var hint = el('div', 'tshow-hint', o);
    hint.textContent = tablet.on ? hubWord('tapClose', 'Tap to close') : hubWord('backClose', 'Back to close');
    var show = { el: o, ss: null, timer: null };
    tablet.show = show;
    o.addEventListener('click', closeShow);
    try {
      show.ss = window.HUB_PHOTOS && typeof window.HUB_PHOTOS.slideshow === 'function' ? window.HUB_PHOTOS.slideshow(o, {
        getJSON: function (url, ms, cb) { xhrJSON(url, ms, false, cb); },
        onEmpty: function () { el('div', 'tshow-empty', o).textContent = hubWord('tablet.noPhotos', 'No photos to show yet.'); }
      }) : null;
    } catch (e) { show.ss = null; }
    if (!show.ss) el('div', 'tshow-empty', o).textContent = hubWord('tablet.noPhotos', 'No photos to show yet.');
    void o.offsetWidth;
    o.classList.add('is-on');
    show.timer = setTimeout(function () { hint.classList.add('is-gone'); }, 2500);
  }

  function closeShow() {
    var show = tablet.show;
    if (!show) return;
    tablet.show = null;
    clearTimeout(show.timer);
    try { if (show.ss) show.ss.stop(); } catch (e) { /* gone anyway */ }
    show.el.classList.remove('is-on');
    setTimeout(function () { if (show.el.parentNode) show.el.parentNode.removeChild(show.el); }, 320);
  }

  // Fills the sheet with the About strip and the layout bar themselves (moved
  // in while it is up) and draws it, still below the screen.
  function sheetReady() {
    if (busy || open || frameOpen || typingBox()) return false;
    clearTimeout(tablet.hideTimer);
    if (tablet.sheetOn) return true;
    closeAbout();
    closeSwitcher();
    tablet.left.appendChild(aboutEl);
    tablet.right.appendChild(switcherEl);
    tablet.sheetOn = true;
    openAbout();
    openSwitcher();
    drawSettings();
    tablet.empty.style.display = sw.on ? 'none' : '';
    tablet.sheet.classList.add('is-on');
    document.body.classList.add('tsheet-up');
    hidePeek(false);
    return true;
  }

  function openSheet() {
    if (!sheetReady()) return;
    void tablet.sheet.offsetWidth;          // so the slide starts from below the screen
    tablet.sheet.classList.remove('is-dragging');
    tablet.sheet.style.transform = '';
    tablet.sheet.classList.add('is-shown');
    // The remote: focus starts on the first setting's choice (Look).
    if (!tablet.on) {
      var cols = tablet.sheet.querySelectorAll('.tsheet-col');
      for (var c = 0; c < cols.length; c++) cols[c].scrollTop = 0;
      var first = tablet.settings.querySelector('.tsheet-opt.is-on') || tablet.settings.querySelector('.tsheet-opt');
      sheetFocus(first ? 'set:' + first.getAttribute('data-set') : 'close');
    }
  }

  function closeSheet() {
    if (!tablet.sheetOn) return;
    tablet.sheetOn = false;
    closeAbout();
    closeSwitcher();
    // Their own hide timers (260 ms) would empty them while the sheet still slides
    // (300 ms): the sheet's timer below does it once it is down.
    clearTimeout(ab.hideTimer);
    clearTimeout(sw.hideTimer);
    tablet.sheet.classList.remove('is-dragging');
    tablet.sheet.style.transform = '';
    tablet.sheet.classList.remove('is-shown');
    document.body.classList.remove('tsheet-up');
    if (!tablet.on) {
      sheetFocus('');
      if (homeIndex >= 0 && widgets[homeIndex]) focusHome(homeIndex);   // back on the tile it came from
    }
    clearTimeout(tablet.hideTimer);
    tablet.hideTimer = setTimeout(function () {
      if (tablet.sheetOn) return;
      tablet.sheet.classList.remove('is-on');
      if (!ab.on) { aboutEl.classList.remove('is-on'); aboutEl.innerHTML = ''; }
      if (!sw.on) switcherEl.classList.remove('is-on');
      document.body.insertBefore(switcherEl, toastEl);
      document.body.insertBefore(aboutEl, toastEl);
      layoutChance();
    }, 320);
  }

  // A layout picked (its pill's own click ran first, and closed the bar):
  // the sheet goes too. The watch link test row runs as OK would.
  function onSheetClick(e) {
    if (!tablet.sheetOn) return;
    for (var node = e.target; node && node !== tablet.sheet; node = node.parentNode) {
      if (hasClass(node, 'about-row') && hasClass(node, 'is-action')) {
        // That row's own action (a tap row already ran it), not the first one that can act.
        var r = aboutRowOf(node);
        closeSheet();
        if (!r) aboutAction();
        else if (!r.tap && rowActs(r)) { try { r.action(); } catch (er) { /* stays as it is */ } }
        return;
      }
    }
    if (!sw.on && tablet.empty.style.display === 'none') closeSheet();
  }

  function aboutRowOf(node) {
    for (var j = 0; j < ab.rows.length; j++) if (ab.rows[j].parentNode === node) return ab.drawn[j];
    return null;
  }

  // A keyboard on the tablet: Back closes, the arrows and OK work the layouts.
  // A TV's remote: tvSheetKey (below).
  function sheetKey(code, dir) {
    if (!tablet.on) { tvSheetKey(code, dir); return; }
    if (isBack(code)) closeSheet();
    else if ((dir === 'left' || dir === 'right') && sw.on) moveSwitcher(dir);
    else if (dir === 'up' || dir === 'down') scrollAbout(dir);
    else if (code === KEY.ENTER && sw.on) chooseLayout();
  }

  // Drag the tab up to pull the sheet, or its head down to put it away. A
  // tap (no move) is left to the click.
  function sheetDrag(node, fromTab) {
    var d = null;
    node.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) { d = null; return; }
      d = { y0: e.touches[0].clientY, h: window.innerHeight || 1, moved: false, at: 0 };
    });
    node.addEventListener('touchmove', function (e) {
      if (!d || !e.touches || !e.touches.length) return;
      var dy = e.touches[0].clientY - d.y0;
      if (!d.moved) {
        if (Math.abs(dy) < 10) return;
        if (fromTab && !sheetReady()) { d = null; return; }
        d.moved = true;
        tablet.sheet.classList.add('is-dragging');
      }
      e.preventDefault();
      d.at = Math.max(0, Math.min(d.h, (fromTab ? d.h : 0) + dy));
      tablet.sheet.style.transform = 'translate(0, ' + Math.round(d.at) + 'px)';
    });
    node.addEventListener('touchend', function (e) {
      if (!d || !d.moved) { d = null; return; }
      e.preventDefault();                     // no click after a drag
      // A pull of more than 15% of the screen either way does it.
      var up = fromTab ? d.at < d.h * 0.85 : d.at < d.h * 0.15;
      d = null;
      if (up) openSheet(); else closeSheet();
    });
    node.addEventListener('touchcancel', function () {
      var was = d;
      d = null;
      if (was && was.moved) { if (fromTab) closeSheet(); else openSheet(); }
    });
  }

  /* ---------- the Menu on a TV ---------- */

  // The same sheet on a TV, worked by the remote (docs/tv-menu.md). Down off
  // a bottom tile raises the tab (its peek, focused); OK opens the sheet, Up
  // or Back puts the tab away. In the sheet the arrows move a focus between
  // everything that can be chosen (Close, each setting's choices, About's
  // button row, the layouts, Start slideshow), by where things are on screen;
  // OK chooses it (as a tap would), Back closes. A column with more below
  // than shows scrolls a step when Down finds nothing further.
  function showPeek() {
    if (tablet.on || !tablet.tab || tablet.peek || busy || open || frameOpen || typingBox()) return;
    tablet.peek = true;
    if (homeIndex >= 0 && widgets[homeIndex]) widgets[homeIndex].tile.classList.remove('is-focused');
    fxCall('ringHide', []);
    tablet.tab.classList.add('is-peek');
  }

  function hidePeek(refocus) {
    if (!tablet.peek) return;
    tablet.peek = false;
    if (tablet.tab) tablet.tab.classList.remove('is-peek');
    if (refocus && homeIndex >= 0 && widgets[homeIndex]) focusHome(homeIndex);
  }

  function peekKey(code, dir) {
    if (code === KEY.ENTER) openSheet();
    else if (dir === 'up' || isBack(code)) hidePeek(true);
  }

  // Everything the remote can land on, by key: close, set:<data-set>,
  // lay:<n>, about:<n>, show. Only what is drawn.
  function sheetItems() {
    var t = tablet;
    var list = [];
    function add(key, node) { if (node && node.offsetWidth > 0) list.push({ key: key, node: node }); }
    add('close', t.close);
    var opts = t.settings ? t.settings.querySelectorAll('.tsheet-opt') : [];
    for (var i = 0; i < opts.length; i++) add('set:' + opts[i].getAttribute('data-set'), opts[i]);
    for (var a = 0; a < ab.rows.length; a++) {
      var arow = ab.rows[a].parentNode;
      if (arow && hasClass(arow, 'is-action') && ab.drawn[a]) add('about:' + ab.drawn[a].label, arow);
    }
    if (sw.on) for (var n = 0; n < sw.nodes.length; n++) add('lay:' + n, sw.nodes[n]);
    add('show', t.showBtn);
    return list;
  }

  function sheetNodeOf(key, list) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].node;
    return null;
  }

  // Draws the focus where tablet.fkey says (again after a redraw).
  function markSheetFocus() {
    if (!tablet.sheet) return;
    var old = tablet.sheet.querySelectorAll('.is-tvfocus');
    for (var i = 0; i < old.length; i++) old[i].classList.remove('is-tvfocus');
    if (tablet.on || !tablet.sheetOn || !tablet.fkey) return;
    var list = sheetItems();
    var node = sheetNodeOf(tablet.fkey, list);
    var moved = false;
    if (!node && list.length) {              // its row went (About redrew): the nearest thing left
      var pick = list[0];
      for (var k = 0; k < list.length; k++) {
        if (tablet.fkey.indexOf('about:') === 0 && list[k].key.indexOf('about:') === 0) { pick = list[k]; break; }
        if (list[k].key.indexOf('set:') === 0) pick = list[k];   // else the last setting, in the same column
      }
      tablet.fkey = pick.key;
      node = pick.node;
      moved = true;
    }
    if (!node) return;
    if (moved) sheetInView(node);
    node.classList.add('is-tvfocus');
    // The layouts keep their own index (OK on one uses it).
    if (tablet.fkey.indexOf('lay:') === 0) focusSwitcher(+tablet.fkey.slice(4));
    else if (sw.nodes[sw.index]) sw.nodes[sw.index].classList.remove('is-focused');
  }

  function sheetFocus(key) {
    tablet.fkey = key;
    markSheetFocus();
    var list = sheetItems();
    var node = key ? sheetNodeOf(key, list) : null;
    if (node) sheetInView(node);
  }

  // Scrolls the node's column so the node shows, with a little room.
  function sheetInView(node) {
    var col = sheetCol(node);
    if (!col) return;
    var c = col.getBoundingClientRect();
    var r = node.getBoundingClientRect();
    var room = Math.round(c.height * 0.12);
    if (r.bottom > c.bottom - room) col.scrollTop += Math.round(r.bottom - c.bottom + room);
    else if (r.top < c.top + room) col.scrollTop = Math.max(0, col.scrollTop - Math.round(c.top + room - r.top));
  }

  function tvSheetKey(code, dir) {
    if (isBack(code)) { closeSheet(); return; }
    var list = sheetItems();
    var cur = sheetNodeOf(tablet.fkey, list);
    if (code === KEY.ENTER) {
      if (cur) cur.click();                 // what a tap does: the sheet's own handlers
      return;
    }
    if (!dir) return;
    if (!cur) { if (list.length) sheetFocus(list[0].key); return; }
    // Down from Close: the first setting's choice (not the layouts, though they sit as near).
    if (tablet.fkey === 'close' && dir === 'down') {
      var first = tablet.settings.querySelector('.tsheet-opt.is-on') || tablet.settings.querySelector('.tsheet-opt');
      if (first) { sheetFocus('set:' + first.getAttribute('data-set')); return; }
    }
    var from = cur.getBoundingClientRect();
    var rects = [];
    // Up and Down stay in the column (or go to Close above them).
    var mine = sheetCol(cur);
    for (var i = 0; i < list.length; i++) {
      var other = sheetCol(list[i].node);
      var keep = list[i].node !== cur && (dir === 'left' || dir === 'right' || other === mine || (dir === 'up' && !other));
      rects.push(keep ? list[i].node.getBoundingClientRect() : null);
    }
    var next = sheetPick(from, rects, dir);
    if (next < 0 && (dir === 'left' || dir === 'right')) next = sideNearest(from, rects, dir);
    if (next >= 0) { sheetFocus(list[next].key); return; }
    // Nothing further that way: Up and Down scroll the column (About's text).
    if (dir === 'up' || dir === 'down') {
      var col = sheetCol(cur);
      if (!col) return;
      // Half a screen, but never past the focused item (the column clips).
      var c = col.getBoundingClientRect();
      var room = dir === 'down' ? from.top - c.top - 8 : c.bottom - from.bottom - 8;
      var step = Math.max(0, Math.min(Math.round(col.clientHeight * 0.5), Math.round(room)));
      col.scrollTop = Math.max(0, col.scrollTop + (dir === 'down' ? step : -step));
    }
  }

  // The column a node is in (null: Close, above both).
  function sheetCol(node) {
    while (node && node.nodeType === 1 && !hasClass(node, 'tsheet-col')) node = node.parentNode;
    return node && node.nodeType === 1 ? node : null;
  }

  // The next item that way. Up and Down: the nearest row first, then the item
  // in it nearest across. Left and Right: the nearest in the same row.
  function sheetPick(from, rects, dir) {
    var fcx = from.left + from.width / 2;
    var i, r, gap;
    var gaps = [];
    var minGap = Infinity;
    for (i = 0; i < rects.length; i++) {
      r = rects[i];
      gaps.push(null);
      if (!r) continue;
      if (dir === 'up') gap = r.bottom <= from.top + 2 ? from.top - r.bottom : null;
      else if (dir === 'down') gap = r.top >= from.bottom - 2 ? r.top - from.bottom : null;
      else {
        var sameRow = r.top < from.bottom - 1 && r.bottom > from.top + 1;
        gap = !sameRow ? null : dir === 'right' ? (r.left >= from.right - 2 ? r.left - from.right : null) :
          (r.right <= from.left + 2 ? from.left - r.right : null);
      }
      if (gap === null) continue;
      gaps[i] = Math.max(0, gap);
      if (gaps[i] < minGap) minGap = gaps[i];
    }
    if (minGap === Infinity) return -1;
    var best = -1;
    var bestOff = Infinity;
    for (i = 0; i < rects.length; i++) {
      if (gaps[i] === null) continue;
      if (dir === 'left' || dir === 'right') {
        if (gaps[i] === minGap) return i;
        continue;
      }
      if (gaps[i] > minGap + 12) continue;     // a row further on
      r = rects[i];
      var off = Math.abs(r.left + r.width / 2 - fcx);
      if (off < bestOff) { bestOff = off; best = i; }
    }
    return best;
  }

  // Left or Right with nothing in the same row: the nearest item on that side
  // (from the settings over to the layouts, and back).
  function sideNearest(from, rects, dir) {
    var fcx = from.left + from.width / 2;
    var fcy = from.top + from.height / 2;
    var best = -1;
    var bestD = Infinity;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (!r) continue;
      var cx = r.left + r.width / 2;
      if (dir === 'right' ? cx <= from.right : cx >= from.left) continue;
      var d = Math.abs(cx - fcx) + 3 * Math.abs(r.top + r.height / 2 - fcy);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  window.HUB_TEST.tablet = function () { return { on: tablet.on, noHelper: tablet.noHelper, sheet: tablet.sheetOn, show: !!tablet.show, peek: tablet.peek, focus: tablet.fkey }; };

  /* ---------- start ---------- */

  setupMotion();
  markMotion();
  startFx();
  buildPanel();
  build();
  parkGhost();
  checkTheme();
  setupBackground();
  openSolo();
  startLive();
  startUpdates();
  startClay();
  startAgents();
  startTablet();
  buildSheet();                             // the Menu: a TV raises its tab with Down off a bottom tile

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    clayHook('layout');
    agentsHook('stop');
    resizeTimer = setTimeout(function () { measureHome(); placeGlass(); retitleAll(); fxCall('relayout', [focusRect()]); }, 150);
  });

  reportStarted();
})();
