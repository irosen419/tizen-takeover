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
 *     onMode: function (mode, ctx) {},     // after switching 'panel' <-> 'full'
 *     onClose: function (ctx) {},          // panel closed
 *     onLayout: function (ctx) {},         // a new layout moved or resized the tiles
 *     onStatus: function (ctx) {}          // the motion status text changed
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
 *   ctx.build                 'v0.12.0'
 *   ctx.motionStatus()        e.g. 'Motion: push (auto, 58 fps)'
 *   ctx.browser()             the TV's browser, e.g. 'Chrome 63 · Tizen 5.0' ('' if unknown)
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
 *   ctx.setSub(text)          the small line in the panel head
 *   ctx.setTileSub(text)      the small line under the tile's title ('' hides it)
 *   ctx.focus(el)             move panel focus to el
 *   ctx.live                  live updates from the hub server on the Pi (see
 *                             docs/live-updates.md), or undefined when live.js
 *                             isn't loaded. jsDelivr can serve a mix of old and
 *                             new files, so always check it exists first:
 *     ctx.live.status()         { state, text, since }; text is the clock tile's
 *                               line, '' when there is nothing to say
 *     ctx.live.get(resource)    the data last received, e.g. get('todo').items
 *     ctx.live.on(resource, fn) fn(data, rev) each time new data arrives
 *     ctx.live.onStatus(fn)     fn(status) when the state changes (the hub also
 *                               calls every widget's onStatus hook then)
 *     ctx.live.post(path, body, cb)  POST JSON to the server; cb(err, data, httpStatus)
 *     ctx.live.everConnected()  this TV has reached the server at least once
 *   ctx.updates()             where this hub stands with updates (app/update.js):
 *                             { managed, pinned, sha, state, text, newest, checkedAt },
 *                             or undefined when update.js isn't loaded. text is the
 *                             clock tile's line, '' when there is nothing to say;
 *                             newest is true when this is the branch's newest commit
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

  var BUILD = 'v0.12.0';
  var SERVICE = 'http://127.0.0.1:8095';
  // IME_DONE and IME_CANCEL: Done and Cancel on Samsung's on-screen keyboard.
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8,
    IME_DONE: 65376, IME_CANCEL: 65385 };
  var MOTION_KEY = 'homeHub.motion';
  var EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

  var cfg = window.HUB_CONFIG || {};
  var ICONS = window.HUB_ICONS || {};

  var stageEl = document.getElementById('stage');
  var gridEl = document.getElementById('grid');
  var scrimEl = document.getElementById('scrim');
  var ghostEl = document.getElementById('ghost');
  var panelEl = document.getElementById('panel');
  var toastEl = document.getElementById('toast');
  var frameWrap = document.getElementById('frameWrap');
  var frameEl = document.getElementById('frame');
  var backdropEl = document.getElementById('backdrop');

  var widgets = [];       // [{ w, ctx, cell, tile, body, subEl, expandable }]
  var homeIndex = -1;     // focused tile
  var open = null;        // the widget record whose panel is open
  var mode = null;        // 'panel' | 'full' | null
  var busy = false;       // a transition is running; keys are ignored
  var frameOpen = false;
  var panelFocus = null;  // focused .f element in the panel
  var toastTimer = null;
  var panel = {};         // panel parts: icon, title, sub, btn, btnIcon, btnLabel, body

  var hasPageTizen = (function () {
    try { return typeof tizen !== 'undefined' && !!tizen.application; } catch (e) { return false; }
  })();

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
      toast((rec.w.title || rec.w.id) + ' ran into a problem (' + hook + ').', 4000);
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

  var motion = {
    mode: 'push',         // what runs now: 'push' | 'expand' | 'fade'
    source: 'auto',       // 'auto' | 'config' | 'URL'
    measuring: false,
    fps: 0,
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
      return data && data.build === BUILD && isMode(data.mode) ? data : null;
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
    var stored = loadStored();
    if (stored) {
      motion.mode = stored.mode;
      motion.fps = stored.fps || 0;
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
    return s + ' (auto' + (motion.fps ? ', ' + motion.fps + ' fps' : '') + ')';
  }

  function announceStatus() {
    for (var i = 0; i < widgets.length; i++) call(widgets[i], 'onStatus', [widgets[i].ctx]);
  }

  // Samples frame times while a push or expand transition runs. Returns
  // stop(skip): skip is the [start, end] of work the hub itself did on the main
  // thread during the transition (building the panel), or null.
  function startSampling() {
    if (!motion.measuring || motion.mode === 'fade' || !window.requestAnimationFrame) return function () {};
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
    for (var j = 0; j < gaps.length; j++) { total += gaps[j]; if (gaps[j] > worst) worst = gaps[j]; }
    var fps = gaps.length && total > 0 ? Math.round(gaps.length * 1000 / total) : 0;
    var janky = fps < 40 || worst > 120;
    if (janky) motion.janky.push(fps); else motion.clean.push(fps);

    if (motion.janky.length >= 2) {
      // Step down one rung. Fade is the last one, so it ends the timing.
      var next = LADDER[LADDER.indexOf(motion.mode) + 1] || 'fade';
      motion.fps = average(motion.janky);
      motion.mode = next;
      motion.clean = [];
      motion.janky = [];
      motion.measuring = next !== 'fade';
      store({ mode: next, build: BUILD, fps: motion.fps, measuring: motion.measuring });
      markMotion();
      announceStatus();
    } else if (motion.clean.length >= 3) {
      motion.measuring = false;
      motion.fps = average(motion.clean);
      store({ mode: motion.mode, build: BUILD, fps: motion.fps });
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

  // The panel's resting rect in panel mode (46 x 26rem, centered).
  function panelRect() {
    var rem = remPx();
    var W = window.innerWidth;
    var H = window.innerHeight;
    var w = 46 * rem;
    var h = 26 * rem;
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
    return ringLayout(rects, panelRect(), window.innerWidth, window.innerHeight, 1.2 * rem, 0.9 * rem);
  }

  // For tests in a laptop browser. Not used by the hub itself.
  window.HUB_TEST = {
    ringLayout: ringLayout,
    panelRect: panelRect,
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

  function setupBackground() {
    var src = cfg.background;
    if (!src) return;
    var img = new Image();
    img.onload = function () {
      hasPicture = true;
      backdropEl.style.backgroundImage = 'url("' + src + '")';
      document.body.classList.add('has-picture');
      if (cfg.glass === false) return;
      var data = blurredCopy(img);
      if (data) document.documentElement.style.setProperty('--glass-img', 'url("' + data + '")');
      document.body.classList.add('is-glass');
      // An old engine may not take url() through a custom property, or may
      // drop the whole background. Then fall back to the plain tint.
      if (data && widgets.length) {
        var bg = getComputedStyle(widgets[0].tile).backgroundImage || '';
        if (bg.indexOf('url(') === -1) document.body.classList.add('glass-tint-only');
      }
      placeGlass();
    };
    img.onerror = function () { /* keep the plain dark look */ };
    img.src = src;
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
    for (var k = 0; k < widgets.length; k++) placeCell(widgets[k].cell, at[widgets[k].w.id]);
    layoutKey = key;
    measureHome();
    placeGlass();
    for (var m = 0; m < widgets.length; m++) {
      // A widget with an onLayout hook handles its own redraw; the rest are drawn again at the new size.
      if (typeof widgets[m].w.onLayout === 'function') call(widgets[m], 'onLayout', [widgets[m].ctx]);
      else drawTile(widgets[m]);
    }
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
      build: BUILD,
      hasTizen: hasPageTizen,
      motionStatus: motionStatus,
      browser: function () { return browserText; },
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
      redrawPanel: function () { if (open === rec) drawPanelBody(true); },
      setSub: function (text) { if (open === rec) setPanelSub(text); },
      setTileSub: function (text) { setTileSub(rec, text); },
      live: liveFacade(),
      updates: updateStatus,
      focus: function (node) { if (open === rec) focusPanel(node); },
      _bind: function (r) { rec = r; }
    };
    return ctx;
  }

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
      var rec = { w: w, ctx: ctx, expandable: w.expandable !== false };
      ctx._bind(rec);
      delete ctx._bind;

      var cell = el('div', 'cell', gridEl);
      cell.setAttribute('data-widget', w.id);
      placeCell(cell, entry);

      var tile = el('div', 'tile' + (w.planned ? ' is-planned' : '') + (rec.expandable ? '' : ' is-static'), cell);
      if (w.head !== false) {
        var head = el('div', 'tile-head', tile);
        var icon = el('span', 'icon tile-icon', head);
        icon.innerHTML = iconHTML(w.icon);
        var titles = el('div', 'tile-titles', head);
        el('div', 'tile-title', titles).textContent = w.title;
        var sub = ctx.config.sub || w.sub || '';
        if (sub) el('div', 'tile-sub', titles).textContent = sub;
        if (w.planned) el('span', 'tile-soon', head).textContent = 'Soon';
      }
      rec.cell = cell;
      rec.tile = tile;
      rec.body = el('div', 'tile-body', tile);
      rec.index = widgets.length;
      widgets.push(rec);
      tile.addEventListener('click', onTileClick(rec));
    }

    for (var j = 0; j < widgets.length; j++) call(widgets[j], 'init', [widgets[j].ctx]);
    for (var k = 0; k < widgets.length; k++) drawTile(widgets[k]);
    measureHome();

    var start = -1;
    for (var s = 0; s < widgets.length; s++) {
      if (!widgets[s].expandable) continue;
      if (start === -1) start = s;
      if (widgets[s].w.id === cfg.start) { start = s; break; }
    }
    focusHome(start);
  }

  function drawTile(rec) {
    rec.body.innerHTML = '';
    call(rec, 'renderTile', [rec.body, rec.ctx]);
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
    if (homeIndex >= 0 && widgets[homeIndex]) widgets[homeIndex].tile.classList.remove('is-focused');
    homeIndex = i;
    if (i >= 0 && widgets[i]) widgets[i].tile.classList.add('is-focused');
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
  }

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
      if (!busy && open && !frameOpen) closePanel();
    });
  }

  function setPanelSub(text) {
    panel.sub.textContent = text || '';
    panel.sub.style.display = text ? '' : 'none';
  }

  function drawPanelHead() {
    var w = open.w;
    panel.icon.innerHTML = iconHTML(w.icon);
    panel.title.textContent = w.title;
    var full = mode === 'full';
    panel.btnIcon.innerHTML = iconHTML(full ? 'shrink' : 'expand');
    panel.btnLabel.textContent = full ? 'Exit full screen' : 'Full screen';
    drawPanelHint();
  }

  // typing: true or false when the caller knows, otherwise worked out here.
  function drawPanelHint(typing) {
    if (!open) return;
    if (typing === undefined) typing = !!typingBox();
    panel.hint.textContent = typing ? 'Back to stop typing' : mode === 'full' ? 'Back to shrink' : 'Back to close';
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
    if (panelFocus === panel.btn) { switchMode(mode === 'full' ? 'panel' : 'full'); return; }
    if (isTextBox(panelFocus)) { startTyping(panelFocus); return; }
    var target = panelFocus;
    target.classList.add('is-pressed');
    setTimeout(function () { target.classList.remove('is-pressed'); }, 160);
    call(open, 'onSelect', [target, open.ctx]);
  }

  function backInPanel() {
    if (call(open, 'onBack', [open.ctx]) === true) return;
    if (mode === 'full') switchMode('panel');
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
    }
  }

  function returnOthers(rec, ms) {
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
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
  function openPanel(rec) {
    if (busy || open || !rec.expandable) return;
    open = rec;
    mode = 'panel';
    busy = true;
    var fade = motion.mode === 'fade';
    var push = motion.mode === 'push';
    var ms = fade ? 140 : push ? 320 : 260;
    var P = panelRect();
    var T = rec.home || rectOf(rec.tile);
    var moved = false;
    var built = false;
    var skip = null;
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
    }

    // Start state, then one style flush, then the transitions (FLIP).
    panelEl.className = 'panel is-shown';
    panelEl.style.transition = 'none';
    panelEl.style.opacity = '0';
    panelEl.style.transform = fade ? IDENTITY : panelStart(T, P);
    ghostEl.style.transition = 'none';
    ghostEl.className = 'ghost';
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
      if (push) pushOthers(rec, ms);
      else setOpacity(scrimEl, scrimLevel(), ms);
    }
    after(ghostEl, ms, function () { moved = true; finish(); });

    afterFrame(function () {
      var t0 = now();
      try {
        drawPanelHead();
        setPanelSub(rec.ctx.config.sub || rec.w.sub || '');
        drawPanelBody(false);
      } catch (e) {
        if (window.console && console.warn) console.warn('Panel build: ' + (e && e.message));
      }
      skip = [t0, now()];
      panelEl.style.opacity = '1';
      built = true;
      finish();
    });
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
      panelEl.style.transition = 'none';
      panelEl.style.transform = '';
      panelEl.style.opacity = '0';
      scrimEl.className = 'scrim';
      scrimEl.style.transition = 'none';
      parkGhost();
      clearTile(rec);
      rec.tile.style.visibility = '';
      settleOthers();
      if (panelFocus) panelFocus.classList.remove('is-focused');
      panelFocus = null;
      open = null;
      mode = null;
      busy = false;
      focusHome(rec.index);
      call(rec, 'onClose', [rec.ctx]);
      panel.body.innerHTML = '';
      layoutChance();
    }

    if (motion.mode === 'fade' || mode === 'full') {
      // From full screen everything just fades; there is no tile-sized box to shrink to cleanly.
      setOpacity(panelEl, 0, 140);
      setOpacity(ghostEl, 0, 140);
      setOpacity(scrimEl, 0, 140);
      rec.tile.style.visibility = '';
      returnOthers(rec, 140);
      after(panelEl, 140, done);
      return;
    }

    var ms = 280;
    var P = panelRect();
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

    function apply() {
      mode = next;
      panelEl.className = 'panel is-shown' + (next === 'full' ? ' is-full' : '');
      drawPanelHead();
      call(rec, 'onMode', [next, rec.ctx]);
      if (panelFocus) keepInView(panelFocus);
    }

    function sizeGhost() {
      ghostEl.className = 'ghost' + (next === 'full' ? ' is-full' : '');
      placeFloatingGlass(ghostEl);
    }

    setOpacity(panelEl, 0, 80);
    if (motion.mode === 'fade') setOpacity(ghostEl, 0, 80);
    after(panelEl, 80, function () {
      if (motion.mode === 'fade') {
        // Both are invisible, so the frame just changes size with the content.
        sizeGhost();
        apply();
        void panelEl.offsetWidth;
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
    if (!url) return toast('This dashboard has no address yet.');
    frameOpen = true;
    frameEl.src = url;
    frameWrap.hidden = false;
  }

  function closeFrame() {
    frameEl.src = 'about:blank';
    frameWrap.hidden = true;
    frameOpen = false;
    layoutChance();
  }

  /* ---------- keys ---------- */

  function isBack(code) { return code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE; }

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;
    var dir = dirOf(code);
    var handled = dir || code === KEY.ENTER || isBack(code);

    if (frameOpen) {
      if (isBack(code)) { e.preventDefault(); closeFrame(); }
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
    // A held OK or Back counts once. Otherwise holding OK on a tile would
    // carry on pressing things inside the panel it opens.
    if (e.repeat && !dir) return;
    if (busy) return;
    // The TV keyboard can send a stray Enter after Done or Back after Cancel.
    if ((code === KEY.ENTER || isBack(code)) && Date.now() - typingEndedAt < 300) return;

    if (open) {
      if (dir) movePanel(dir);
      else if (code === KEY.ENTER) selectPanel();
      else backInPanel();
      return;
    }

    if (dir) moveHome(dir);
    else if (code === KEY.ENTER) { if (homeIndex >= 0) openPanel(widgets[homeIndex]); }
    // Back on the home stage does nothing: the hub is home.
  });

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
    if (frameOpen) closeFrame();
    if (typingBox()) stopTyping();
  }

  function liveShow(data) {
    var id = String(data.widget || '');
    var rec = widgetById(id);
    if (!rec || !rec.expandable) {
      var name = id.length > 40 ? id.substring(0, 40) + '...' : id;
      toast('Asked to show "' + name + '", which this hub doesn\'t have.', 5000);
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

  function liveSay(data) {
    var text = String(data.text === undefined || data.text === null ? '' : data.text).replace(/\s+/g, ' ');
    text = text.replace(/^\s+|\s+$/g, '').substring(0, 140);
    if (!text) return;
    var seconds = Number(data.seconds);
    if (data.seconds === undefined || data.seconds === null || !isFinite(seconds)) seconds = 6;
    seconds = Math.max(2, Math.min(30, seconds));
    toast(text, Math.round(seconds * 1000));
  }

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
      else if (type === 'reload') liveReload();
    } catch (e) {
      liveWarn(type + ' failed: ' + (e && e.message));
    }
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

  function noteInput() { lastInputAt = new Date().getTime(); }
  document.addEventListener('keydown', noteInput, true);
  document.addEventListener('click', noteInput, true);

  function hubIdle() {
    if (idleOverride !== null) return idleOverride;
    if (busy || open || frameOpen || typingBox()) return false;
    return new Date().getTime() - lastInputAt >= IDLE_MS;
  }

  // The status object, or undefined without update.js.
  function updateStatus() {
    var U = updateApi('status');
    if (!U) return undefined;
    try { return U.status(); } catch (e) { return undefined; }
  }

  function startUpdates() {
    var U = updateApi('watch');
    if (!U) return;
    try {
      U.watch({ idle: hubIdle, onStatus: function () { announceStatus(); } });
    } catch (e) {
      liveWarn('updates could not start: ' + (e && e.message));
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
  window.HUB_TEST.mode = function () { return mode; };
  window.HUB_TEST.busy = function () { return busy; };
  window.HUB_TEST.idle = hubIdle;
  window.HUB_TEST.setIdle = function (value) { idleOverride = value === true || value === false ? value : null; };
  window.HUB_TEST.setIdleMs = function (ms) { IDLE_MS = ms; };
  window.HUB_TEST.cleanLayout = cleanLayout;
  window.HUB_TEST.layout = function () { return layoutKey ? JSON.parse(layoutKey) : null; };
  window.HUB_TEST.layoutWaiting = function () { return pendingLayout !== undefined; };
  window.HUB_TEST.checkUpdates = function () { var U = updateApi('check'); if (U) U.check(); };

  /* ---------- start ---------- */

  setupMotion();
  markMotion();
  buildPanel();
  build();
  parkGhost();
  setupBackground();
  startLive();
  startUpdates();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { measureHome(); placeGlass(); }, 150);
  });

  reportStarted();
})();
