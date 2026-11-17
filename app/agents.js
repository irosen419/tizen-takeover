/*
 * Characters: a pixel-art character who swoops in beside a tile's chip.
 * Plain ES5, loaded after clay.js and before motion.js (docs/agents.md).
 *
 * While a tile shows a working chip ("Working on to-dos") or an arrival
 * chip ("Incoming to-do"), the character glides in along the tile's bottom
 * edge on a Stormlight trail, settles at its bottom right (the chip is at
 * the bottom left; on a tile too narrow for both she stands on the chip's
 * line, to its right), idles (a small skate bob, her spren swaying) while
 * the chip lives, and when the chip ends or turns into the arrival chip
 * gives one quick Stormlight pulse and glides out the way she came.
 * Nothing here knows about widgets or kinds: any tile with a chip can get
 * a character. The chip is never changed and stays the words; the
 * character only comes when the screen keeps full speed (motion.js's
 * can('activity')) and the home screen is quiet. Otherwise, or with
 * agents: false / on: false in app/config.js, or ?agent=off, nothing of
 * theirs loads or is added.
 *
 * motion.js tells it about chips (HUB_AGENTS.chip(phase, tile, ok)):
 *   'in'    a chip showed on tile; ok: full speed and the home screen quiet
 *   'done'  the chip is fading or became the arrival chip: pulse, glide out
 *   'gone'  the chip was taken away after its fade (nothing to do: she
 *           is already on her way out)
 *   'cut'   the chip was taken away at once (a panel, a layout change, the
 *           hub slowing down): she goes at once too
 * hub.js calls HUB_AGENTS.start(host) and stop() (layout change, resize).
 *
 * Only transform and opacity move (agents.css). One layer, added with the
 * first character and removed with the last. At most one character per
 * tile and two on screen. Its pictures load a few seconds after start
 * (each asked for up to three times, like clay.js); a picture that never
 * comes means no swoop, never a broken picture. Every entry point is
 * wrapped, so if anything here breaks, the hub carries on exactly as
 * without it. It writes nothing to the console.
 */
(function () {
  'use strict';

  /* The roster: one entry per character. Sizes are the sprite's own pixels,
     which are the screen's at 1080p (1rem = 24px there). To add one, put its
     pictures in app/agents/<name>/ and an entry here; config picks it with
     agents.who. Every part is drawn at (left, top) inside the w x h box;
     a part with sway: true sways about its bottom middle. trail: where the
     Stormlight streams from (x, y in the box, the side behind her feet). */
  var ROSTER = {
    lift: {
      name: 'Lift',
      dir: 'agents/lift/',
      w: 132, h: 112,
      faces: 'right',
      parts: [
        { file: 'lift.webp', left: 0, top: 0, w: 132, h: 112 },
        { file: 'wyndle.webp', left: 109, top: 57, w: 23, h: 31, sway: true }
      ],
      trail: { x: 2, y: 106 }
    }
  };

  /* Every word this file shows, in English. The Spanish is in app/i18n.js
     under 'agents.' + the path here. */
  var STRINGS = {
    now: '{who}, on {where}',
    none: 'none',
    loading: 'loading pictures',
    seenOne: '1 swoop',
    seenMany: '{n} swoops',
    drawOn: 'on',
    drawLight: 'chips only ({why})',
    why: { fade: 'fade mode', slow: 'slow screen', calm: 'less motion asked for' },
    offWhy: 'off ({why})',
    offConfig: 'off (config)',
    offQuery: 'off (?agent=off)',
    offUnknown: 'off (no character called {who})',
    offChips: 'off (the activity chips are off)',
    offFailed: 'off (pictures did not load; tried again in 10 min)',
    tile: 'a tile'
  };

  var IN_MS = 700;               // the glide in
  var OUT_MS = 520;              // the glide out
  var OUT_AFTER_MS = 220;        // the pulse starts, then she leaves this much later
  var PULSE_MS = 520;
  var GLIDE_REM = 9.5;           // how far beside her rest she starts (228 px at 1080p)
  var INSET_REM = 0.6667;        // from the tile's right and bottom edges (16 px)
  var CALM_MS = 20000;           // idle this long, then calm (no bob, slower sway)
  var MAX_ON_SCREEN = 2;
  var LOAD_AFTER_MS = 6000;      // pictures load this long after start
  var TRIES = 3;                 // a picture is asked for this many times in all
  var RETRY_MS = [1000, 2500];   // after a failure, the next try this much later
  var FAILED_WAIT_MS = 600000;   // after a picture failed, loading is tried again after this
  var EASE_IN = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
  var EASE_OUT = 'cubic-bezier(0.55, 0, 0.8, 0.45)';

  var host = null;
  var started = false;
  var off = '';                  // '' when on; else 'config' | 'query' | 'unknown'
  var who = '';
  var role = null;               // ROSTER[who]
  var pics = { state: 'none', imgs: [], failedAt: 0 };   // 'none' | 'loading' | 'ready' | 'failed'
  var figs = [];                 // [{ tile, node, flip, state, timers, fromLeft, x, y, startX, where }]
  var pending = [];              // tiles waiting for the pictures
  var layer = null;
  var seen = 0;
  var asked = 0;                 // chips that showed (with or without her): the About rows wait for the first
  var loadTimer = null;

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { return undefined; }
    };
  }

  function tr(key, english, vars) {
    var L = window.HUB_I18N;
    if (L && typeof L.t === 'function') {
      try { return String(L.t('agents.' + key, english, vars)); } catch (e) { /* English below */ }
    }
    var text = String(english);
    if (vars) for (var v in vars) if (vars.hasOwnProperty(v)) text = text.split('{' + v + '}').join(String(vars[v]));
    return text;
  }

  function readQuery(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function later(ms, fn) { return setTimeout(safe(fn), ms); }

  function remPx() {
    var r = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    return r > 0 ? r : 24;
  }

  function rem(n) { return Math.round(n / 24 * 10000) / 10000 + 'rem'; }

  function px(n) { return Math.round(n * 100) / 100 + 'px'; }

  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  function drop(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  function lessMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  /* ---------- settings ---------- */

  function readSettings(cfg) {
    var q = readQuery('agent');
    if (q === 'off') return { off: 'query', who: '' };
    var name = q && q !== 'on' ? q : (cfg && typeof cfg === 'object' && typeof cfg.who === 'string' ? cfg.who : 'lift');
    // ?agent=<name> picks one for this visit even when the config has them off.
    if (!(q && q !== 'on') && (cfg === false || (cfg && typeof cfg === 'object' && cfg.on === false))) return { off: 'config', who: '' };
    if (!ROSTER.hasOwnProperty(name)) return { off: 'unknown', who: String(name).slice(0, 24) };
    return { off: '', who: name };
  }

  /* ---------- pictures ---------- */

  // Loads every part's picture; each is asked for up to TRIES times. A
  // picture that loads but has no width did not decode (a failure too).
  function load() {
    clearTimeout(loadTimer);
    loadTimer = null;
    if (off || pics.state === 'loading' || pics.state === 'ready') return;
    if (pics.state === 'failed' && Date.now() - pics.failedAt < FAILED_WAIT_MS) return;
    pics.state = 'loading';
    var parts = role.parts;
    var imgs = [];
    var left = parts.length;
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      if (ok) {
        pics.state = 'ready';
        pics.imgs = imgs;
        flushPending();
      } else {
        pics.state = 'failed';
        pics.failedAt = Date.now();
        pics.imgs = [];
        pending = [];
      }
    }
    function ask(i, n) {
      var img = new Image();
      img.onload = safe(function () {
        if (done) return;
        if (!(img.naturalWidth > 0)) { finish(false); return; }
        imgs[i] = img;
        if (--left === 0) finish(true);
      });
      img.onerror = safe(function () {
        if (done) return;
        if (n >= TRIES) { finish(false); return; }
        later(RETRY_MS[n - 1] || RETRY_MS[RETRY_MS.length - 1], function () { if (!done) ask(i, n + 1); });
      });
      img.src = role.dir + parts[i].file;
    }
    for (var i = 0; i < parts.length; i++) ask(i, 1);
  }

  /* ---------- the layer ---------- */

  function layerOn() {
    if (layer && layer.parentNode) return layer;
    layer = el('div', 'ag-layer', document.body);
    layer.setAttribute('aria-hidden', 'true');
    return layer;
  }

  function layerCheck() {
    if (layer && !figs.length && !layer.querySelector('.ag-pulse')) {
      drop(layer);
      layer = null;
    }
  }

  /* ---------- one character ---------- */

  function figOf(tile) {
    for (var i = 0; i < figs.length; i++) if (figs[i].tile === tile) return figs[i];
    return null;
  }

  function clearTimers(f) {
    for (var i = 0; i < f.timers.length; i++) clearTimeout(f.timers[i]);
    f.timers = [];
  }

  function whereOf(tile) {
    var t = tile.querySelector('.tile-title');
    var text = t ? String(t.textContent || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') : '';
    if (!text) {
      var cell = tile.parentNode;
      text = cell && cell.getAttribute ? cell.getAttribute('data-widget') || '' : '';
    }
    return text ? text.slice(0, 40) : tr('tile', STRINGS.tile);
  }

  // Where she rests on tile (screen px): its bottom right, clear of the chip.
  function restOf(tile, R) {
    var k = R / 24;
    var w = role.w * k;
    var h = role.h * k;
    var inset = INSET_REM * R;
    var r = tile.getBoundingClientRect();
    var x = r.right - inset - w;
    var y = r.bottom - inset * 0.5 - h;
    var chip = tile.querySelector('.fx-chip');
    if (chip) {
      // Layout offsets (the chip's entrance moves it by transform only).
      var bw = tile.clientLeft || 0;
      var chipRight = r.left + bw + chip.offsetLeft + chip.offsetWidth;
      var chipTop = r.top + (tile.clientTop || 0) + chip.offsetTop;
      var gap = 0.25 * R;
      if (chipRight + gap > x) {
        // Tight: closer to the tile's right border, if that clears the chip;
        // else she stands just above the chip's top, at the tile's right.
        var tight = r.right - bw - 0.125 * R - w;
        if (chipRight + gap <= tight) x = tight;
        else y = chipTop - h - 0.0833 * R;
      }
    }
    y = Math.max(r.top - h * 0.25, y);
    return { x: x, y: y, tile: r };
  }

  function place(f, x, flip) {
    f.node.style.transform = 'translate(' + px(x) + ',' + px(f.y) + ')';
    f.flip.className = 'ag-flip' + (flip ? ' is-mirrored' : '');
  }

  function build() {
    var node = el('div', 'ag-fig ag-' + who);
    node.style.width = rem(role.w);
    node.style.height = rem(role.h);
    var flip = el('div', 'ag-flip', node);
    var bob = el('div', 'ag-bob', flip);
    var trail = el('div', 'ag-trail', bob);
    trail.style.left = rem(role.trail.x);
    trail.style.top = rem(role.trail.y);
    for (var t = 0; t < 5; t++) el('i', '', trail);
    for (var i = 0; i < role.parts.length; i++) {
      var p = role.parts[i];
      var img = pics.imgs[i].cloneNode(false);
      img.removeAttribute('id');
      img.alt = '';
      img.setAttribute('draggable', 'false');
      if (p.sway) {
        var holder = el('span', 'ag-spren', bob);
        holder.style.left = rem(p.left);
        holder.style.top = rem(p.top);
        holder.style.width = rem(p.w);
        holder.style.height = rem(p.h);
        holder.appendChild(img);
      } else {
        img.style.left = rem(p.left);
        img.style.top = rem(p.top);
        img.style.width = rem(p.w);
        img.style.height = rem(p.h);
        bob.appendChild(img);
      }
    }
    return { node: node, flip: flip };
  }

  function enter(tile) {
    if (figOf(tile) || figs.length >= MAX_ON_SCREEN) return false;
    var R = remPx();
    var rest = restOf(tile, R);
    var W = window.innerWidth || document.documentElement.clientWidth || 1920;
    // A tile on the right half: she comes from its left (and stays on screen); else from its right.
    var fromLeft = rest.tile.left + rest.tile.width / 2 > W / 2;
    var dx = GLIDE_REM * R;
    var parts = build();
    var f = { tile: tile, node: parts.node, flip: parts.flip, state: 'in', timers: [], fromLeft: fromLeft,
      x: rest.x, y: rest.y, startX: fromLeft ? rest.x - dx : rest.x + dx, where: whereOf(tile) };
    var mirrored = role.faces === 'right' ? !fromLeft : fromLeft;
    var s = f.node.style;
    s.opacity = '0';
    s.transition = 'none';
    place(f, f.startX, mirrored);
    layerOn().appendChild(f.node);
    figs.push(f);
    seen += 1;
    void f.node.offsetWidth;
    f.node.className += ' is-gliding';
    s.transition = 'transform ' + IN_MS + 'ms ' + EASE_IN + ', opacity 220ms linear';
    place(f, f.x, mirrored);
    s.opacity = '1';
    f.timers.push(later(IN_MS + 40, function () {
      if (f.state !== 'in') return;
      f.state = 'idle';
      f.node.className = f.node.className.replace(/ is-gliding\b/g, '') + ' is-idle';
      f.timers.push(later(CALM_MS, function () {
        if (f.state === 'idle') f.node.className += ' is-calm';
      }));
    }));
    return true;
  }

  function pulse(f) {
    var R = remPx();
    var w = role.w * R / 24 * 1.7;
    var h = role.h * R / 24 * 1.3;
    var r = f.node.getBoundingClientRect();
    var node = el('div', 'ag-pulse');
    node.style.width = px(w);
    node.style.height = px(h);
    node.style.left = px(r.left + r.width / 2 - w / 2);
    node.style.top = px(r.top + r.height / 2 - h / 2);
    el('b', '', node);
    for (var i = 0; i < 6; i++) el('i', '', node);
    layerOn().appendChild(node);
    later(PULSE_MS + 80, function () { drop(node); layerCheck(); });
  }

  // The chip ended or became the arrival chip: a pulse, then out the way she came.
  function leave(f) {
    if (f.state === 'out') return;
    clearTimers(f);
    f.state = 'out';
    pulse(f);
    f.timers.push(later(OUT_AFTER_MS, function () {
      var cur = f.node.getBoundingClientRect();
      var s = f.node.style;
      // From where she is drawn now (mid-glide or mid-bob), never a jump.
      s.transition = 'none';
      f.y = cur.top;
      var mirrored = role.faces === 'right' ? f.fromLeft : !f.fromLeft;
      place(f, cur.left, mirrored);
      f.node.className = 'ag-fig ag-' + who + ' is-gliding';
      void f.node.offsetWidth;
      s.transition = 'transform ' + OUT_MS + 'ms ' + EASE_OUT + ', opacity ' + Math.round(OUT_MS * 0.6) + 'ms linear ' + Math.round(OUT_MS * 0.4) + 'ms';
      place(f, f.startX, mirrored);
      s.opacity = '0';
      f.timers.push(later(OUT_MS + 60, function () { end(f); }));
    }));
  }

  function end(f) {
    clearTimers(f);
    drop(f.node);
    var i = figs.indexOf(f);
    if (i >= 0) figs.splice(i, 1);
    layerCheck();
  }

  function stopAll() {
    pending = [];
    while (figs.length) end(figs[0]);
    if (layer) {
      drop(layer);
      layer = null;
    }
  }

  function flushPending() {
    var list = pending;
    pending = [];
    for (var i = 0; i < list.length; i++) {
      var tile = list[i];
      // Still a live chip there, and still full speed.
      var chip = document.documentElement.contains(tile) ? tile.querySelector('.fx-chip') : null;
      if (chip && !/(^| )is-out( |$)/.test(chip.className) && fullSpeed()) enter(tile);
    }
  }

  function fullSpeed() {
    var F = window.HUB_FX;
    try { return !!(F && typeof F.can === 'function' && F.can('activity')) && !lessMotion() && !document.hidden; } catch (e) { return false; }
  }

  /* ---------- from motion.js ---------- */

  function chip(phase, tile, ok) {
    if (started && phase === 'in') asked += 1;
    if (!started || off || !tile || tile.nodeType !== 1) return false;
    var f = figOf(tile);
    if (phase === 'in') {
      if (!ok || lessMotion() || f) return false;
      if (pics.state === 'ready') return enter(tile);
      if (pending.indexOf(tile) < 0 && pending.length < MAX_ON_SCREEN) pending.push(tile);
      load();
      return false;
    }
    var p = pending.indexOf(tile);
    if (p >= 0) pending.splice(p, 1);
    if (!f) return false;
    if (phase === 'done') leave(f);
    else if (phase === 'cut') end(f);
    return true;
  }

  /* ---------- status (the About panel's Characters group) ---------- */

  function drawingText() {
    if (!started) return '';
    if (off === 'config') return tr('offConfig', STRINGS.offConfig);
    if (off === 'query') return tr('offQuery', STRINGS.offQuery);
    if (off === 'unknown') return tr('offUnknown', STRINGS.offUnknown, { who: who });
    var F = window.HUB_FX;
    var fx = null;
    try { fx = F && typeof F.state === 'function' ? F.state() : null; } catch (e) { fx = null; }
    if (!F || (typeof F.on === 'function' && !F.on('activity'))) return tr('offChips', STRINGS.offChips);
    if (pics.state === 'failed') return tr('offFailed', STRINGS.offFailed);
    var sp = fx ? fx.speed : 'fade';
    var why = sp !== 'ok' ? sp : lessMotion() ? 'calm' : '';
    if (!why) return tr('drawOn', STRINGS.drawOn);
    var whyText = tr('why.' + why, STRINGS.why[why] || why);
    // The chips still show (motion.js's light extras), she does not.
    if (fx && fx.lightSpeed === 'ok') return tr('drawLight', STRINGS.drawLight, { why: whyText });
    return tr('offWhy', STRINGS.offWhy, { why: whyText });
  }

  function status() {
    var out = { now: '', seen: '', drawing: drawingText(), who: who, off: off, pictures: pics.state, count: seen, asked: asked };
    if (!started || off) return out;
    var list = [];
    for (var i = 0; i < figs.length; i++) {
      if (figs[i].state !== 'out') list.push(tr('now', STRINGS.now, { who: role.name, where: figs[i].where }));
    }
    out.now = list.length ? list.join(' · ') : pending.length && pics.state === 'loading' ? tr('loading', STRINGS.loading) : tr('none', STRINGS.none);
    out.seen = seen === 1 ? tr('seenOne', STRINGS.seenOne) : tr('seenMany', STRINGS.seenMany, { n: seen });
    return out;
  }

  /* ---------- start ---------- */

  function start(h) {
    if (started) return;
    host = h || {};
    var s = readSettings(host.config);
    off = s.off;
    who = s.who;
    started = true;
    if (off) return;
    role = ROSTER[who];
    loadTimer = later(LOAD_AFTER_MS, load);
  }

  window.HUB_AGENTS = {
    start: safe(start),
    chip: safe(function (phase, tile, ok) { return chip(phase, tile, ok) === true; }),
    stop: safe(stopAll),
    status: safe(status),
    roster: function () { var o = []; for (var k in ROSTER) if (ROSTER.hasOwnProperty(k)) o.push(k); return o; },
    // For tests: what is on screen now, and loading at once.
    test: {
      state: safe(function () {
        return {
          on: started && !off, off: off, who: who, pictures: pics.state, seen: seen, pending: pending.length,
          figs: figs.map(function (f) {
            var cell = f.tile.parentNode;
            return { widget: cell && cell.getAttribute ? cell.getAttribute('data-widget') || '' : '', state: f.state,
              fromLeft: f.fromLeft, x: f.x, y: f.y };
          })
        };
      }),
      load: safe(function () { clearTimeout(loadTimer); load(); return pics.state; })
    }
  };
})();
