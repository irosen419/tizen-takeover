/*
 * Characters: a pixel-art character who comes to work on a tile while it
 * is busy or has news, instead of the chip. Plain ES5, loaded after clay.js
 * and before motion.js (docs/agents.md).
 *
 * When a tile would show a working chip ("Working on to-dos") or an arrival
 * chip ("Incoming to-do"), motion.js first asks here whether the character
 * will come (HUB_AGENTS.chip('in', ...)). When she does, the tile gets no
 * chip at all: only her and the tile's border light (motion.js keeps that).
 * When she cannot (a slow screen, fade mode, pictures not loaded, two
 * already out, agents off), the chip shows as before.
 *
 * Her sequence (every step transform and opacity only, agents.css):
 *   enter   skates in along the tile's bottom edge on a Stormlight trail,
 *           from the side of the tile that has screen room
 *   travel  a short carving skate to the work spot, ending in a braking
 *           skid and a spray of Stormlight sparks
 *   work    crouches with a hand on the card: Stormlight flows down her arm
 *           into the card and rings out from her hand, Wyndle grows a vine
 *           curl toward it, a small bob. Loops (about 3 s) while the tile
 *           is working; a short while when the news is already there
 *   reveal  the news lands: she springs up, arms raised, and a burst of
 *           sparks goes off at the spot (the border light laps at the
 *           same time, from motion.js)
 *   exit    a wave with the bread, then she skates out the way she came
 * The work spot is the first [data-agent-spot] element in the tile (a
 * widget puts it on the row where its new item shows; she crouches on its
 * top edge, at its end on her side, so she covers the end of the line above
 * and not the row), else the middle of the tile, lower half; measured once
 * as she starts, kept inside the tile. On a
 * tile too small for all that she enters, works at its bottom corner and
 * leaves (sparks, no leap). Anything that takes a chip away at once (a
 * panel, a layout change, a resize, the hub slowing down) takes her away at
 * once too.
 *
 * motion.js tells it (HUB_AGENTS.chip(phase, tile, ok, mode)):
 *   'in'      a chip would show on tile; ok: full speed and the home screen
 *             quiet; mode 'work' (a working chip) or 'arrive'. True when she
 *             comes (motion.js then makes no chip).
 *   'reveal'  the working state turned into news on the same tile. True when
 *             she takes it (she will spring up); false when she is already
 *             on her way out (motion.js then shows the arrival chip).
 *   'done'    the working state ended without news: she stops working and
 *             leaves. (An arrival's own end does not cut her sequence short.)
 *   'gone'    the chip's time is over (nothing to do: she finishes)
 *   'cut'     taken away at once: she goes at once too
 * HUB_AGENTS.willShow(tile, ok) answers the same question as 'in' without
 * starting her; has(tile) says whether she is working there now.
 * hub.js calls HUB_AGENTS.start(host) and stop() (layout change, resize).
 *
 * Nothing here knows about widgets or kinds. One layer, added with the
 * first character and removed with the last. At most one character per
 * tile and two on screen. Her pictures (every pose) load a few seconds
 * after start, each asked for up to three times (like clay.js); if any one
 * never comes, she is unavailable and the chips show (never half a
 * character). Every entry point is wrapped, so if anything here breaks, the
 * hub carries on exactly as without it. It writes nothing to the console.
 */
(function () {
  'use strict';

  /* The roster: one entry per character. Sizes are the sprite's own pixels,
     which are the screen's at 1080p (1rem = 24px there). To add one, put its
     pictures in app/agents/<name>/ and an entry here; config picks it with
     agents.who. w x h: the box every pose is drawn in (feet on its bottom).
     poses: each pose's parts (file, left, top, w, h inside the box; sway:
     true sways that part about its bottom middle). Only 'skate' is needed:
     a missing pose is drawn with the skate pose. trail: where the Stormlight
     streams from while she skates (behind her feet); spray: where the skid's
     sparks fly from (her front foot); hand: the crouch pose's hand on the
     card (it goes on the work spot); vine: where Wyndle's vine curl grows
     from in the crouch. All in the box, facing `faces`. */
  var ROSTER = {
    lift: {
      name: 'Lift',
      dir: 'agents/lift/',
      w: 140, h: 126,
      faces: 'right',
      poses: {
        skate: [
          { file: 'lift.webp', left: 4, top: 14, w: 132, h: 112 },
          { file: 'wyndle.webp', left: 113, top: 71, w: 23, h: 31, sway: true }
        ],
        skid: [{ file: 'skid.webp', left: 6, top: 12, w: 125, h: 114 }],
        crouch: [{ file: 'crouch.webp', left: 14, top: 56, w: 112, h: 70 }],
        leap: [{ file: 'leap.webp', left: 20, top: 1, w: 99, h: 125 }],
        wave: [{ file: 'wave.webp', left: 26, top: 9, w: 87, h: 117 }]
      },
      trail: { x: 6, y: 120 },
      spray: { x: 108, y: 121 },
      hand: { x: 67, y: 122 },
      vine: { x: 86, y: 119 }
    }
  };
  var POSES = ['skate', 'skid', 'crouch', 'leap', 'wave'];

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

  // The sequence's timing (ms). An arrival alone: about 5.5 to 6 s in all.
  var IN_MS = 700;               // enter: the glide in along the bottom edge
  var TRAVEL_MIN_MS = 450;       // travel: by distance, within these
  var TRAVEL_MAX_MS = 1050;
  var TRAVEL_MS_PER_PX = 1.7;
  var SKID_MS = 420;             // the skid at the end of the travel (inside it, then a little more)
  var BRIEF_MS = 1500;           // work, when the news is already there
  var AFTER_REVEAL_MS = 700;     // work, when the news came while she was still travelling
  var REVEAL_MS = 900;           // the spring up and the burst
  var BURST_MS = 760;
  var WAVE_MS = 650;             // the wave before she skates out
  var OUT_MS = 650;              // the glide out
  var CALM_MS = 20000;           // working this long, then calm (slower loop)
  var GLIDE_REM = 9.5;           // how far beside the tile's edge she starts (228 px at 1080p)
  var INSET_REM = 0.6667;        // from the tile's edges (16 px)
  var JUMP_PX = 18;              // the spring up, in sprite pixels
  var LEAN_DEG = 5;
  var MAX_ON_SCREEN = 2;
  var LOAD_AFTER_MS = 6000;      // pictures load this long after start
  var TRIES = 3;                 // a picture is asked for this many times in all
  var RETRY_MS = [1000, 2500];   // after a failure, the next try this much later
  var FAILED_WAIT_MS = 600000;   // after a picture failed, loading is tried again after this
  var EASE_IN = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
  var EASE_OUT = 'cubic-bezier(0.55, 0, 0.8, 0.45)';
  var EASE_CARVE_X = 'cubic-bezier(0.45, 0.05, 0.3, 1)';
  var EASE_CARVE_Y = 'cubic-bezier(0.15, 0.75, 0.35, 1)';

  var host = null;
  var started = false;
  var off = '';                  // '' when on; else 'config' | 'query' | 'unknown'
  var who = '';
  var role = null;               // ROSTER[who]
  var pics = { state: 'none', imgs: {}, failedAt: 0 };   // 'none' | 'loading' | 'ready' | 'failed'
  var figs = [];                 // see enter()
  var layer = null;
  var seen = 0;
  var asked = 0;                 // chips asked about (with or without her): the About rows wait for the first
  var loadTimer = null;
  var lostTiles = [];            // tiles whose character stop() took away (motion.js then shows their chip)

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

  function clamp(v, lo, hi) { return hi < lo ? lo : Math.max(lo, Math.min(hi, v)); }

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

  function partsOf(pose) {
    return role.poses[pose] || role.poses.skate;
  }

  // Every picture of every pose, once each.
  function files() {
    var out = [];
    for (var i = 0; i < POSES.length; i++) {
      var parts = role.poses[POSES[i]] || [];
      for (var j = 0; j < parts.length; j++) if (out.indexOf(parts[j].file) < 0) out.push(parts[j].file);
    }
    return out;
  }

  // Loads every picture together; each is asked for up to TRIES times. A
  // picture that loads but has no width did not decode (a failure too). If
  // any one fails, none is used: never half a character.
  function load() {
    clearTimeout(loadTimer);
    loadTimer = null;
    if (off || pics.state === 'loading' || pics.state === 'ready') return;
    if (pics.state === 'failed' && Date.now() - pics.failedAt < FAILED_WAIT_MS) return;
    pics.state = 'loading';
    var list = files();
    var imgs = {};
    var left = list.length;
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      if (ok) {
        pics.state = 'ready';
        pics.imgs = imgs;
      } else {
        pics.state = 'failed';
        pics.failedAt = Date.now();
        pics.imgs = {};
      }
    }
    function ask(file, n) {
      var img = new Image();
      img.onload = safe(function () {
        if (done) return;
        if (!(img.naturalWidth > 0)) { finish(false); return; }
        imgs[file] = img;
        if (--left === 0) finish(true);
      });
      img.onerror = safe(function () {
        if (done) return;
        if (n >= TRIES) { finish(false); return; }
        later(RETRY_MS[n - 1] || RETRY_MS[RETRY_MS.length - 1], function () { if (!done) ask(file, n + 1); });
      });
      img.src = role.dir + file;
    }
    for (var i = 0; i < list.length; i++) ask(list[i], 1);
  }

  /* ---------- the layer ---------- */

  function layerOn() {
    if (layer && layer.parentNode) return layer;
    layer = el('div', 'ag-layer', document.body);
    layer.setAttribute('aria-hidden', 'true');
    return layer;
  }

  function layerCheck() {
    if (layer && !figs.length && !layer.querySelector('.ag-burst')) {
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

  function after(f, ms, fn) { f.timers.push(later(ms, fn)); }

  function whereOf(tile) {
    var t = tile.querySelector('.tile-title');
    var text = t ? String(t.textContent || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') : '';
    if (!text) {
      var cell = tile.parentNode;
      text = cell && cell.getAttribute ? cell.getAttribute('data-widget') || '' : '';
    }
    return text ? text.slice(0, 40) : tr('tile', STRINGS.tile);
  }

  // The work spot (screen px): the first visible [data-agent-spot] in the
  // tile (at its top edge, at its end on the side she comes from: she
  // crouches on that row's top line with her hand on it, so her body is in
  // the room at the end of the line above, not over the row's words), else
  // the middle of the tile, lower half; kept inside the tile. Measured once,
  // as she starts.
  function spotOf(tile, r, inset, fromLeft) {
    var x = r.left + r.width / 2;
    var y = r.top + r.height * 0.72;
    var marker = false;
    var row = null;
    var list = tile.querySelectorAll('[data-agent-spot]');
    for (var i = 0; i < list.length; i++) {
      var m = list[i].getBoundingClientRect();
      if (m.width > 0 && m.height > 0) {
        x = fromLeft ? m.left + Math.min(inset, m.width / 2) : m.right - Math.min(inset, m.width / 2);
        y = m.top;
        marker = true;
        row = { top: m.top, bottom: m.bottom };
        break;
      }
    }
    return {
      x: clamp(x, r.left + inset, r.right - inset),
      y: clamp(y, r.top + inset, r.bottom - inset),
      marker: marker,
      row: row
    };
  }

  // The boxes of the tile's words on screen (each line of each text), at
  // most 300 texts; measured once, as she starts.
  function wordBoxes(tile) {
    var out = [];
    if (!document.createRange || !document.createTreeWalker) return out;
    var walk = document.createTreeWalker(tile, 4, null, false);   // 4: text only
    var range = document.createRange();
    var n = 0;
    var node;
    while ((node = walk.nextNode()) && n < 300) {
      if (!/\S/.test(node.nodeValue || '')) continue;
      n += 1;
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        if (rects[i].width > 0 && rects[i].height > 0) out.push({ left: rects[i].left, top: rects[i].top, right: rects[i].right, bottom: rects[i].bottom });
      }
    }
    return out;
  }

  // How much of the words box b would cover (px squared).
  function covers(b, words) {
    var sum = 0;
    for (var i = 0; i < words.length; i++) {
      var w = Math.min(b.right, words[i].right) - Math.max(b.left, words[i].left);
      var h = Math.min(b.bottom, words[i].bottom) - Math.max(b.top, words[i].top);
      if (w > 0 && h > 0) sum += w * h;
    }
    return sum;
  }

  // Her drawn box while she works (the crouch pose's parts), in the box's
  // own pixels, mirrored or not.
  function workArt(mirrored) {
    var parts = partsOf('crouch');
    var b = { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 };
    for (var i = 0; i < parts.length; i++) {
      var l = mirrored ? role.w - parts[i].left - parts[i].w : parts[i].left;
      b.left = Math.min(b.left, l);
      b.right = Math.max(b.right, l + parts[i].w);
      b.top = Math.min(b.top, parts[i].top);
      b.bottom = Math.max(b.bottom, parts[i].top + parts[i].h);
    }
    return b;
  }

  // Where everything happens, measured once: the tile, her size, the side
  // she comes from, the corner she enters at, the spot and where she works.
  function plan(tile) {
    var R = remPx();
    var k = R / 24;
    var w = role.w * k;
    var h = role.h * k;
    var inset = INSET_REM * R;
    var r = tile.getBoundingClientRect();
    var W = window.innerWidth || document.documentElement.clientWidth || 1920;
    // A tile on the right half: she comes from its left (and stays on screen); else from its right.
    var fromLeft = r.left + r.width / 2 > W / 2;
    var baseY = Math.max(r.top - h * 0.25, r.bottom - inset * 0.5 - h);
    var ex = fromLeft ? r.left + inset * 0.5 : r.right - inset * 0.5 - w;
    ex = clamp(ex, 0, W - w);
    var startX = fromLeft ? ex - GLIDE_REM * R : ex + GLIDE_REM * R;
    var mirrored = role.faces === 'right' ? !fromLeft : fromLeft;
    var small = r.width < w * 2.3 || r.height < h * 1.2;
    var spot = spotOf(tile, r, inset, fromLeft);
    var hand = role.hand || { x: role.w * 0.7, y: role.h };
    var hx = (mirrored ? role.w - hand.x : hand.x) * k;
    var hy = hand.y * k;
    var wx = ex;
    var wy = baseY;
    var best = -1;
    if (!small) {
      wx = clamp(spot.x - hx, r.left + inset * 0.5, r.right - inset * 0.5 - w);
      wx = clamp(wx, 0, W - w);
      // Never back past the corner she came in at.
      wx = fromLeft ? Math.max(wx, ex) : Math.min(wx, ex);
      wy = clamp(spot.y - hy, r.top - h * 0.25, baseY);
      // Never over the tile's words if she can help it: on the row's top
      // edge (the end of the line above) first, then pressed to the tile's
      // edge, then lower, over the end of the row itself; the place that
      // covers the fewest words wins (the first, on a tie).
      if (spot.row) {
        var words = wordBoxes(tile);
        var art = workArt(mirrored);
        var edge = fromLeft ? clamp(r.left + inset * 0.5, 0, W - w) : clamp(r.right - inset * 0.5 - w, 0, W - w);
        var xs = [wx, edge];
        var ys = [spot.y, (spot.row.top + spot.row.bottom) / 2, spot.row.bottom];
        for (var yi = 0; yi < ys.length && best !== 0; yi++) {
          var cy = clamp(ys[yi] - hy, r.top - h * 0.25, baseY);
          for (var xi = 0; xi < xs.length && best !== 0; xi++) {
            // (2 px more all round: the work loop bobs her a little.)
            var c = covers({ left: xs[xi] + art.left * k - 2, right: xs[xi] + art.right * k + 2,
              top: cy + art.top * k - 2, bottom: cy + art.bottom * k + 2 }, words);
            if (best < 0 || c < best) { best = c; wx = xs[xi]; wy = cy; }
          }
        }
      }
    }
    return { k: k, w: w, h: h, r: r, fromLeft: fromLeft, mirrored: mirrored, baseY: baseY, ex: ex, startX: startX,
      small: small, spot: spot, wx: wx, dy: wy - baseY, covers: best,
      // The spot she really works at (the hand, after keeping her in the tile).
      at: { x: wx + hx, y: wy + hy } };
  }

  function build() {
    var node = el('div', 'ag-fig ag-' + who + ' is-pose-skate');
    node.style.width = rem(role.w);
    node.style.height = rem(role.h);
    var ride = el('div', 'ag-ride', node);
    var lean = el('div', 'ag-lean', ride);
    var flip = el('div', 'ag-flip', lean);
    var bob = el('div', 'ag-bob', flip);
    var trail = el('div', 'ag-trail', bob);
    trail.style.left = rem(role.trail.x);
    trail.style.top = rem(role.trail.y);
    for (var t = 0; t < 5; t++) el('i', '', trail);
    for (var p = 0; p < POSES.length; p++) {
      if (!role.poses[POSES[p]]) continue;
      var holder = el('div', 'ag-pose ag-pose-' + POSES[p], bob);
      var parts = role.poses[POSES[p]];
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        var img = pics.imgs[part.file].cloneNode(false);
        img.removeAttribute('id');
        img.alt = '';
        img.setAttribute('draggable', 'false');
        var box = img;
        if (part.sway) {
          box = el('span', 'ag-spren', holder);
          box.appendChild(img);
        } else {
          holder.appendChild(img);
        }
        box.style.left = rem(part.left);
        box.style.top = rem(part.top);
        box.style.width = rem(part.w);
        box.style.height = rem(part.h);
      }
    }
    // The skid's spray: sparks fanning out from her front foot.
    var sp = role.spray || role.trail;
    var spray = el('div', 'ag-spray', bob);
    spray.style.left = rem(sp.x);
    spray.style.top = rem(sp.y);
    for (var s = 0; s < 7; s++) el('i', '', el('b', '', spray));
    // The work: Stormlight down her arm into the card, rings from her hand,
    // Wyndle's vine curl growing toward it.
    var hand = role.hand || { x: role.w * 0.7, y: role.h };
    var work = el('div', 'ag-work', bob);
    work.style.left = rem(hand.x);
    work.style.top = rem(hand.y);
    el('b', 'ag-ring', work);
    el('b', 'ag-ring', work);
    for (var d = 0; d < 3; d++) el('i', 'ag-dot', work);
    var vp = role.vine || hand;
    var vine = el('div', 'ag-vine', bob);
    vine.style.left = rem(vp.x);
    vine.style.top = rem(vp.y);
    var curl = el('span', 'ag-curl', vine);
    for (var c = 0; c < 6; c++) el('i', '', curl);
    return { node: node, ride: ride, lean: lean, flip: flip };
  }

  function cls(f, add, remove) {
    var c = ' ' + f.node.className + ' ';
    for (var i = 0; i < remove.length; i++) c = c.replace(new RegExp(' ' + remove[i] + '(?= )', 'g'), ' ');
    for (var j = 0; j < add.length; j++) if (c.indexOf(' ' + add[j] + ' ') < 0) c += add[j] + ' ';
    f.node.className = c.replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
  }

  function pose(f, name) {
    if (!role.poses[name]) name = 'skate';
    if (f.pose === name) return;
    cls(f, ['is-pose-' + name], ['is-pose-' + f.pose]);
    f.pose = name;
  }

  function phase(f, name) {
    f.state = name;
    f.phases.push(name);
  }

  function face(f, mirrored) {
    f.flip.className = 'ag-flip' + (mirrored ? ' is-mirrored' : '');
  }

  function moveX(f, x, ms, ease) {
    f.x = x;
    f.node.style.transition = ms ? 'transform ' + ms + 'ms ' + ease + ', opacity 220ms linear' : 'none';
    f.node.style.transform = 'translate(' + px(x) + ',' + px(f.p.baseY) + ')';
  }

  function moveY(f, dy, ms, ease) {
    f.dy = dy;
    f.ride.style.transition = ms ? 'transform ' + ms + 'ms ' + ease : 'none';
    f.ride.style.transform = 'translate(0,' + px(dy) + ')';
  }

  // Leaning into the carve (deg > 0 leans toward the right of the screen).
  function lean(f, deg, ms) {
    f.lean.style.transition = ms ? 'transform ' + ms + 'ms ease-out' : 'none';
    f.lean.style.transform = deg ? 'rotate(' + deg + 'deg)' : '';
  }

  // enter: from the side, along the bottom edge, on the trail.
  function enter(tile, mode) {
    var p = plan(tile);
    var parts = build();
    var f = { tile: tile, node: parts.node, ride: parts.ride, lean: parts.lean, flip: parts.flip, p: p,
      mode: mode, state: '', phases: [], pose: 'skate', timers: [], x: p.startX, dy: 0,
      wantReveal: false, wantDone: false, where: whereOf(tile), born: Date.now() };
    var s = f.node.style;
    s.opacity = '0';
    face(f, p.mirrored);
    moveX(f, p.startX, 0);
    moveY(f, 0, 0);
    layerOn().appendChild(f.node);
    figs.push(f);
    seen += 1;
    phase(f, 'enter');
    void f.node.offsetWidth;
    cls(f, ['is-gliding'], []);
    moveX(f, p.ex, IN_MS, EASE_IN);
    s.opacity = '1';
    after(f, IN_MS + 30, function () {
      if (f.p.small) atSpot(f);
      else travel(f);
    });
    return true;
  }

  // travel: a carve to the work spot (x and y eased differently, so the
  // path curves), then the skid.
  function travel(f) {
    var p = f.p;
    var dist = Math.abs(p.wx - f.x) + Math.abs(p.dy);
    var ms = Math.round(clamp(dist * TRAVEL_MS_PER_PX, TRAVEL_MIN_MS, TRAVEL_MAX_MS));
    var dir = p.fromLeft ? 1 : -1;
    phase(f, 'travel');
    lean(f, dir * LEAN_DEG, 240);
    moveX(f, p.wx, ms, EASE_CARVE_X);
    moveY(f, p.dy, ms, EASE_CARVE_Y);
    after(f, Math.max(0, ms - Math.round(SKID_MS * 0.6)), function () {
      phase(f, 'skid');
      pose(f, 'skid');
      cls(f, ['is-skid'], ['is-gliding']);
      lean(f, -dir * LEAN_DEG * 0.6, 160);
      after(f, SKID_MS, function () {
        lean(f, 0, 160);
        cls(f, [], ['is-skid']);
        atSpot(f);
      });
    });
  }

  // At the spot: work, unless the working state already ended.
  function atSpot(f) {
    if (f.wantDone) { leave(f); return; }
    phase(f, 'work');
    pose(f, 'crouch');
    cls(f, ['is-work'], ['is-gliding', 'is-skid']);
    if (f.mode === 'arrive') {
      after(f, f.wantReveal ? AFTER_REVEAL_MS : BRIEF_MS, function () { reveal(f); });
    } else {
      after(f, CALM_MS, function () { if (f.state === 'work') cls(f, ['is-calm'], []); });
    }
  }

  // A burst of sparks at the spot (in the layer, so it stays put).
  function burst(f) {
    var R = remPx();
    var size = 4 * R;
    var node = el('div', 'ag-burst');
    node.style.width = px(size);
    node.style.height = px(size);
    node.style.transform = 'translate(' + px(f.p.at.x - size / 2) + ',' + px(f.p.at.y - size / 2) + ')';
    el('u', '', node);
    for (var i = 0; i < 8; i++) el('i', '', el('b', '', node));
    layerOn().appendChild(node);
    later(BURST_MS + 80, function () { drop(node); layerCheck(); });
  }

  // reveal: the news is in: she springs up, sparks at the spot.
  function reveal(f) {
    clearTimers(f);
    phase(f, 'reveal');
    cls(f, ['is-reveal'], ['is-work', 'is-calm']);
    burst(f);
    if (f.p.small) {
      after(f, Math.round(REVEAL_MS * 0.5), function () { leave(f); });
      return;
    }
    pose(f, 'leap');
    var up = f.p.dy - JUMP_PX * f.p.k;
    moveY(f, up, 240, 'cubic-bezier(0.2, 0.8, 0.4, 1)');
    after(f, 300, function () { moveY(f, f.p.dy, 320, 'cubic-bezier(0.6, 0, 0.8, 0.6)'); });
    after(f, REVEAL_MS, function () { leave(f); });
  }

  // exit: she turns, waves with the bread, then skates out the way she came.
  function leave(f) {
    if (f.state === 'exit') return;
    clearTimers(f);
    phase(f, 'exit');
    cls(f, [], ['is-work', 'is-calm', 'is-reveal', 'is-skid']);
    face(f, !f.p.mirrored);
    pose(f, 'wave');
    after(f, f.p.small ? Math.round(WAVE_MS * 0.6) : WAVE_MS, function () {
      pose(f, 'skate');
      cls(f, ['is-gliding'], []);
      lean(f, (f.p.fromLeft ? -1 : 1) * LEAN_DEG, 200);
      moveY(f, 0, Math.round(OUT_MS * 0.7), EASE_IN);
      f.x = f.p.startX;
      f.node.style.transition = 'transform ' + OUT_MS + 'ms ' + EASE_OUT + ', opacity ' + Math.round(OUT_MS * 0.6) + 'ms linear ' + Math.round(OUT_MS * 0.4) + 'ms';
      f.node.style.transform = 'translate(' + px(f.x) + ',' + px(f.p.baseY) + ')';
      f.node.style.opacity = '0';
      after(f, OUT_MS + 60, function () { end(f); });
    });
  }

  function end(f) {
    clearTimers(f);
    drop(f.node);
    var i = figs.indexOf(f);
    if (i >= 0) figs.splice(i, 1);
    layerCheck();
  }

  function stopAll() {
    while (figs.length) {
      if (lostTiles.indexOf(figs[0].tile) < 0) lostTiles.push(figs[0].tile);
      if (lostTiles.length > 8) lostTiles.shift();
      end(figs[0]);
    }
    if (layer) {
      drop(layer);
      layer = null;
    }
  }

  function fullSpeed() {
    var F = window.HUB_FX;
    try { return !!(F && typeof F.can === 'function' && F.can('activity')) && !lessMotion() && !document.hidden; } catch (e) { return false; }
  }

  /* ---------- from motion.js ---------- */

  // Would she come to tile now? ok: motion.js's full speed and quiet home.
  // A character still finishing on the same tile does not count: a new
  // chip there replaces her.
  function willShow(tile, ok) {
    if (!started || off || !tile || tile.nodeType !== 1) return false;
    if (pics.state !== 'ready') {
      load();
      return false;
    }
    if (!ok || !fullSpeed() || !document.documentElement.contains(tile)) return false;
    var others = 0;
    for (var i = 0; i < figs.length; i++) if (figs[i].tile !== tile) others += 1;
    return others < MAX_ON_SCREEN;
  }

  function chip(phaseName, tile, ok, mode) {
    if (started && phaseName === 'in') asked += 1;
    if (!started || off || !tile || tile.nodeType !== 1) return false;
    var f = figOf(tile);
    var lost = lostTiles.indexOf(tile);
    if (lost >= 0 && (phaseName === 'in' || phaseName === 'cut' || phaseName === 'gone')) lostTiles.splice(lost, 1);
    if (phaseName === 'in') {
      if (!willShow(tile, ok)) return false;
      if (f) end(f);
      return enter(tile, mode === 'work' ? 'work' : 'arrive');
    }
    if (!f) return false;
    if (phaseName === 'reveal') {
      if (f.state === 'exit' || f.state === 'reveal' || f.wantDone) return false;
      if (f.mode === 'work') {
        f.mode = 'arrive';
        f.wantReveal = true;
        if (f.state === 'work') reveal(f);
      }
      return true;
    }
    if (phaseName === 'done') {
      if (f.mode !== 'work') return true;   // an arrival plays to its end
      if (f.state === 'work') leave(f);
      else f.wantDone = true;
      return true;
    }
    if (phaseName === 'cut') end(f);
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
      if (figs[i].state !== 'exit') list.push(tr('now', STRINGS.now, { who: role.name, where: figs[i].where }));
    }
    out.now = list.length ? list.join(' · ') : pics.state === 'loading' ? tr('loading', STRINGS.loading) : tr('none', STRINGS.none);
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
    chip: safe(function (phaseName, tile, ok, mode) { return chip(phaseName, tile, ok, mode) === true; }),
    willShow: safe(function (tile, ok) { return willShow(tile, ok) === true; }),
    has: safe(function (tile) { var f = figOf(tile); return !!f && f.state !== 'exit'; }),
    // Was her character on tile taken away by stop() (and nothing new asked
    // for there since)? Asking forgets it, so motion.js shows the chip once.
    lost: safe(function (tile) {
      var i = lostTiles.indexOf(tile);
      if (i < 0) return false;
      lostTiles.splice(i, 1);
      return true;
    }),
    stop: safe(stopAll),
    status: safe(status),
    roster: function () { var o = []; for (var k in ROSTER) if (ROSTER.hasOwnProperty(k)) o.push(k); return o; },
    // For tests: what is on screen now, and loading at once.
    test: {
      state: safe(function () {
        return {
          on: started && !off, off: off, who: who, pictures: pics.state, seen: seen,
          figs: figs.map(function (f) {
            var cell = f.tile.parentNode;
            return { widget: cell && cell.getAttribute ? cell.getAttribute('data-widget') || '' : '', state: f.state,
              phases: f.phases.slice(), mode: f.mode, pose: f.pose, small: f.p.small, fromLeft: f.p.fromLeft,
              spot: { x: f.p.spot.x, y: f.p.spot.y, marker: f.p.spot.marker }, at: f.p.at, covers: f.p.covers,
              tile: { left: f.p.r.left, top: f.p.r.top, right: f.p.r.right, bottom: f.p.r.bottom },
              x: f.x, y: f.p.baseY + f.dy };
          })
        };
      }),
      load: safe(function () { clearTimeout(loadTimer); load(); return pics.state; })
    }
  };
})();
