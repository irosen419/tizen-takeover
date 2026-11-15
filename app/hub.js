/*
 * Home Hub core. Runs inside TizenBrew on the TV. Plain ES5 so older Tizen
 * browsers (2017 to 2019 sets) can run it. Loads last, after the widgets.
 *
 * ---------------------------------------------------------------------------
 * Writing a widget
 * ---------------------------------------------------------------------------
 * A widget is one file in app/widgets/ that registers itself, plus a script
 * tag in index.html (before hub.js) and an entry in HUB_CONFIG.layout:
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
 *     onFocus: function (target, ctx) {},  // focus moved to a body focusable
 *     onBack: function (ctx) { return false; }, // true = the widget used Back itself
 *     onMode: function (mode, ctx) {},     // after switching 'panel' <-> 'full'
 *     onClose: function (ctx) {},          // panel closed
 *     onStatus: function (ctx) {}          // the motion status text changed
 *   });
 *
 * Everything except id and title is optional. Every call into a widget is
 * wrapped in try/catch, so a broken widget shows a short toast instead of
 * stopping the hub. If two widgets register the same id, a real one beats a
 * planned placeholder; otherwise the last one registered wins.
 *
 * ctx, one per widget:
 *   ctx.id, ctx.config        HUB_CONFIG.widgets[id] || {}
 *   ctx.build                 'v0.6.0'
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
 *   ctx.focus(el)             move panel focus to el
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

  var BUILD = 'v0.6.0';
  var SERVICE = 'http://127.0.0.1:8095';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8 };
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

  function nextFrame(cb) {
    if (window.requestAnimationFrame) requestAnimationFrame(function () { requestAnimationFrame(cb); });
    else setTimeout(cb, 32);
  }

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

  // In push mode the tiles stay on their own layers, so they aren't
  // re-rastered at the moment the animation starts.
  function markMotion() {
    if (motion.mode === 'push') document.body.classList.add('motion-push');
    else document.body.classList.remove('motion-push');
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

  // Samples frame times while a push or expand transition runs. Returns stop().
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
    return function () {
      running = false;
      if (document.hidden || rung !== motion.mode) return;
      recordRun(times);
    };
  }

  function recordRun(times) {
    // Ignore the first frame: it often carries the cost of starting the transition.
    var gaps = [];
    for (var i = 2; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    var total = 0;
    var worst = 0;
    for (var j = 0; j < gaps.length; j++) { total += gaps[j]; if (gaps[j] > worst) worst = gaps[j]; }
    var fps = gaps.length && total > 0 ? Math.round(gaps.length * 1000 / total) : 0;
    var janky = gaps.length < 2 || fps < 40 || worst > 120;
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
    placeFloatingGlass(panelEl);
    placeFloatingGlass(ghostEl);
  }

  // Panel and ghost are fixed, so their offsets are screen positions that
  // ignore transforms.
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

  function showGhost(full, transform) {
    ghostEl.style.transition = 'none';
    ghostEl.className = 'ghost is-shown' + (full ? ' is-full' : '');
    ghostEl.style.transform = transform || IDENTITY;
    placeFloatingGlass(ghostEl);
  }

  function hideGhost() {
    ghostEl.className = 'ghost';
    ghostEl.style.transition = 'none';
    ghostEl.style.transform = '';
  }

  function setOpacity(node, value, ms, delay) {
    node.style.transition = ms ? 'opacity ' + ms + 'ms linear' + (delay ? ' ' + delay + 'ms' : '') : 'none';
    node.style.opacity = String(value);
  }

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
      focus: function (node) { if (open === rec) focusPanel(node); },
      _bind: function (r) { rec = r; }
    };
    return ctx;
  }

  function build() {
    var byId = pickWidgets();
    var layout = cfg.layout || [];
    for (var i = 0; i < layout.length; i++) {
      var entry = layout[i];
      var w = entry && byId[entry.widget];
      if (!w) continue;
      var ctx = makeCtx(w);
      var rec = { w: w, ctx: ctx, expandable: w.expandable !== false };
      ctx._bind(rec);
      delete ctx._bind;

      var cell = el('div', 'cell', gridEl);
      cell.setAttribute('data-widget', w.id);
      cell.style.left = (entry.x / 12 * 100) + '%';
      cell.style.top = (entry.y / 6 * 100) + '%';
      cell.style.width = (entry.w / 12 * 100) + '%';
      cell.style.height = (entry.h / 6 * 100) + '%';

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
    panel.hint.textContent = full ? 'Back to shrink' : 'Back to close';
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
    focusPanel(target);
  }

  function focusPanel(node) {
    if (!node) return;
    if (panelFocus && panelFocus !== node) panelFocus.classList.remove('is-focused');
    panelFocus = node;
    node.classList.add('is-focused');
    if (node !== panel.btn) {
      keepInView(node);
      call(open, 'onFocus', [node, open.ctx]);
    }
  }

  // Scrolls the panel body (instantly) so the focused element is visible.
  function keepInView(node) {
    var body = panel.body;
    if (!body.contains(node)) return;
    var b = body.getBoundingClientRect();
    var r = node.getBoundingClientRect();
    // About 0.5rem, so a focused row never sits flush against the clipped edge.
    var margin = Math.round(0.5 * parseFloat(getComputedStyle(document.documentElement).fontSize || '16'));
    if (r.top < b.top + margin) body.scrollTop -= (b.top + margin - r.top);
    else if (r.bottom > b.bottom - margin) body.scrollTop += (r.bottom - (b.bottom - margin));
  }

  function movePanel(dir) {
    var list = panelFocusables();
    if (!panelFocus) { focusPanel(list[0]); return; }
    var from = rectOf(panelFocus);
    var rects = [];
    for (var i = 0; i < list.length; i++) rects.push(list[i] === panelFocus ? null : rectOf(list[i]));
    var next = pickNext(from, rects, dir);
    if (next >= 0) focusPanel(list[next]);
  }

  function selectPanel() {
    if (!panelFocus) return;
    if (panelFocus === panel.btn) { switchMode(mode === 'full' ? 'panel' : 'full'); return; }
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

  function openPanel(rec) {
    if (busy || open || !rec.expandable) return;
    open = rec;
    mode = 'panel';
    busy = true;
    panelEl.className = 'panel is-shown';
    placeFloatingGlass(panelEl);
    setOpacity(panelEl, 0, 0);
    drawPanelHead();
    setPanelSub(rec.ctx.config.sub || rec.w.sub || '');
    drawPanelBody(false);

    scrimEl.className = 'scrim is-shown';
    setOpacity(scrimEl, 0, 0);

    if (motion.mode === 'fade') {
      nextFrame(function () {
        setOpacity(scrimEl, scrimLevel(), 140);
        setOpacity(panelEl, 1, 140);
        after(panelEl, 140, function () { busy = false; });
      });
      return;
    }

    var push = motion.mode === 'push';
    var ms = push ? 320 : 260;
    var from = rec.home || rectOf(rec.tile);
    showGhost(false);
    var to = rectOf(ghostEl);
    ghostEl.style.transform = flip(from, to);
    rec.tile.style.visibility = 'hidden';
    void ghostEl.offsetWidth;
    nextFrame(function () {
      var stop = startSampling();
      ghostEl.style.transition = 'transform ' + ms + 'ms ' + EASE;
      ghostEl.style.transform = IDENTITY;
      // Push keeps the scrim transparent: it only catches clicks outside.
      if (push) pushOthers(rec, ms);
      else setOpacity(scrimEl, scrimLevel(), ms);
      setOpacity(panelEl, 1, 140, ms - 140);
      after(ghostEl, ms, function () {
        stop();
        hideGhost();
        busy = false;
      });
    });
  }

  function closePanel() {
    if (busy || !open) return;
    var rec = open;
    busy = true;

    function done() {
      panelEl.className = 'panel';
      panelEl.style.transition = 'none';
      scrimEl.className = 'scrim';
      scrimEl.style.transition = 'none';
      rec.tile.style.visibility = '';
      settleOthers();
      hideGhost();
      if (panelFocus) panelFocus.classList.remove('is-focused');
      panelFocus = null;
      open = null;
      mode = null;
      busy = false;
      focusHome(rec.index);
      call(rec, 'onClose', [rec.ctx]);
      panel.body.innerHTML = '';
    }

    if (motion.mode === 'fade' || mode === 'full') {
      // From full screen the panel just fades; there is no tile-sized box to shrink to cleanly.
      setOpacity(panelEl, 0, 140);
      setOpacity(scrimEl, 0, 140);
      rec.tile.style.visibility = '';
      returnOthers(rec, 140);
      after(panelEl, 140, done);
      return;
    }

    showGhost(false);
    var to = rectOf(ghostEl);
    var target = flip(rec.home || rectOf(rec.tile), to);
    void ghostEl.offsetWidth;
    var stop = startSampling();
    setOpacity(panelEl, 0, 80);
    ghostEl.style.transition = 'transform 200ms ' + EASE + ' 80ms';
    ghostEl.style.transform = target;
    if (motion.mode === 'push') returnOthers(rec, 280);
    else setOpacity(scrimEl, 0, 200, 80);
    after(ghostEl, 280, function () { stop(); done(); });
  }

  function switchMode(next) {
    if (busy || !open || next === mode) return;
    busy = true;
    var rec = open;
    var wasFull = mode === 'full';

    function apply() {
      mode = next;
      panelEl.className = 'panel is-shown' + (next === 'full' ? ' is-full' : '');
      placeFloatingGlass(panelEl);
      drawPanelHead();
      call(rec, 'onMode', [next, rec.ctx]);
      if (panelFocus) keepInView(panelFocus);
    }

    setOpacity(panelEl, 0, 80);
    after(panelEl, 80, function () {
      if (motion.mode === 'fade') {
        apply();
        void panelEl.offsetWidth;
        setOpacity(panelEl, 1, 120);
        after(panelEl, 120, function () { busy = false; });
        return;
      }
      showGhost(wasFull);
      var from = rectOf(ghostEl);
      ghostEl.className = 'ghost is-shown' + (next === 'full' ? ' is-full' : '');
      placeFloatingGlass(ghostEl);
      var to = rectOf(ghostEl);
      ghostEl.style.transform = flip(from, to);
      apply();
      void ghostEl.offsetWidth;
      nextFrame(function () {
        var stop = startSampling();
        ghostEl.style.transition = 'transform 240ms ' + EASE;
        ghostEl.style.transform = IDENTITY;
        setOpacity(panelEl, 1, 120, 130);
        after(ghostEl, 240, function () {
          stop();
          hideGhost();
          busy = false;
        });
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
    if (handled) e.preventDefault();
    if (busy || !handled) return;

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

  /* ---------- start ---------- */

  setupMotion();
  markMotion();
  buildPanel();
  build();
  setupBackground();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { measureHome(); placeGlass(); }, 150);
  });
})();
