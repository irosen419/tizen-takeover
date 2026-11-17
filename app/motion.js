/*
 * Motion extras: small touches on top of the hub's own open animation. Plain
 * ES5, loaded before hub.js; hub.js calls HUB_FX.start(host) first thing and
 * then tells it about focus, panels, layouts and tiles. Each part is its own
 * section below, with its own switch in HUB_CONFIG.motionFx (all on by
 * default; motionFx: false turns them all off, ?fx=off does for one visit):
 *
 *   quietTiles  Tiles that are only waiting (for the Pi, or "Soon") are
 *               quiet: one small muted line, no big mark. Static, no motion.
 *   ring        One focus ring that glides (translate and scale, 190 ms)
 *               from tile to tile, instead of the instant border swap.
 *   stagger     A panel's items (a widget's `stagger` selector) arrive from
 *               the opening tile's side, 35 ms apart, all in by 500 ms.
 *   handoff     A to-do that a sync brings (never the first sync) arrives
 *               as a glowing dot from the A World Worth Saving tile, its row
 *               slides in and the To-do tile's border pulses once.
 *   cover       The Now Playing cover flies between the page and the
 *               visualizer's card when full screen opens and closes.
 *   bloom       An app's icon grows to fill the screen while the app opens.
 *
 * Every moving part animates only transform and opacity, and runs only when
 * the hub's own timing (motion 'auto', see hub.js) says the screen keeps up:
 * in 'fade' mode, after auto stepped down from push, or below 40 frames a
 * second, focus is the plain border swap and the rest happens at once. While
 * the clay wanderers are on screen the dot stays home (they draw too).
 * With every switch off this file adds no element and no class.
 *
 * Every entry point is wrapped, so if anything here breaks, the hub carries
 * on exactly as without it.
 */
(function () {
  'use strict';

  /* Every word this file shows (the About panel's Motion row), for
     translating. window.HUB_MOTION_STRINGS replaces any of them. */
  var STRINGS = {
    extrasOn: 'extras on',
    extrasOff: 'extras off ({why})',
    why: { fade: 'fade mode', slow: 'slow screen' }
  };

  function mergeStrings(dst, src) {
    if (!src || typeof src !== 'object') return;
    for (var k in src) {
      if (!src.hasOwnProperty(k) || !dst.hasOwnProperty(k)) continue;
      if (dst[k] && typeof dst[k] === 'object') mergeStrings(dst[k], src[k]);
      else if (typeof src[k] === 'string') dst[k] = src[k];
    }
  }
  try { mergeStrings(STRINGS, window.HUB_MOTION_STRINGS); } catch (e) { /* keep English */ }

  var FLAGS = ['quietTiles', 'ring', 'stagger', 'handoff', 'cover', 'bloom'];
  var EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';   // ease-out: every entrance
  var RING_MS = 190;
  var STAGGER_MS = 260;
  var STAGGER_STEP = 35;
  var STAGGER_TOTAL = 500;
  var DOT_MS = 900;
  var ROW_MS = 260;
  var COVER_IN_MS = 520;
  var COVER_OUT_MS = 420;
  var BLOOM_MS = 480;
  var BLOOM_HOLD_MS = 2600;      // the app normally covers the hub long before this

  var host = null;               // from hub.js (see start)
  var flags = {};
  var styleEl = null;            // keyframes for the dot's arc
  var runs = 0;

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) {
        if (window.console && console.warn) console.warn('Motion extras: ' + (e && e.message));
        return undefined;
      }
    };
  }

  function readQuery(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function readFlags(cfg) {
    var out = {};
    var q = readQuery('fx');
    var all = !(cfg === false || q === 'off');
    for (var i = 0; i < FLAGS.length; i++) {
      var f = FLAGS[i];
      out[f] = all && !(cfg && typeof cfg === 'object' && cfg[f] === false);
    }
    // ?fx=ring,stagger: only those, for one visit.
    if (q && q !== 'off' && q !== 'on') {
      var want = q.split(',');
      for (var j = 0; j < FLAGS.length; j++) out[FLAGS[j]] = want.indexOf(FLAGS[j]) >= 0;
    }
    return out;
  }

  function on(name) { return !!flags[name]; }

  // 'ok', 'fade' or 'slow', from the hub's own frame-rate timing.
  function speed() {
    try { return host ? host.speed() : 'fade'; } catch (e) { return 'fade'; }
  }

  function can(name) { return on(name) && speed() === 'ok'; }

  function anyMotion() {
    for (var i = 1; i < FLAGS.length; i++) if (flags[FLAGS[i]]) return true;
    return false;
  }

  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    (parent || document.body).appendChild(node);
    return node;
  }

  function drop(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  function rectOf(node) {
    var r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function px(n) { return Math.round(n * 100) / 100 + 'px'; }

  function translate(x, y, sx, sy) {
    return 'translate(' + px(x) + ',' + px(y) + ') scale(' + (sx === undefined ? 1 : sx) + ',' + (sy === undefined ? (sx === undefined ? 1 : sx) : sy) + ')';
  }

  function later(ms, fn) { return setTimeout(safe(fn), ms); }

  // cb once, on transitionend/animationend of node or after ms + 80.
  function after(node, ms, cb, type) {
    var called = false;
    var ev = type || 'transitionend';
    function finish(e) {
      if (e && e.target !== node) return;
      if (called) return;
      called = true;
      node.removeEventListener(ev, finish);
      clearTimeout(timer);
      safe(cb)();
    }
    var timer = setTimeout(finish, ms + 80);
    node.addEventListener(ev, finish);
  }

  /* ---------- quiet tiles (no motion) ---------- */

  // Called after every tile draw. A widget marks a waiting state by giving an
  // element in its tile the class hub-dormant; placeholders are always quiet.
  function markTile(tile, body, planned) {
    if (!on('quietTiles')) return;
    var dormant = !!planned || !!body.querySelector('.hub-dormant');
    if (dormant) tile.classList.add('is-dormant');
    else tile.classList.remove('is-dormant');
  }

  /* ---------- focus ring ---------- */

  var ring = { node: null, at: null, gliding: false, glideEnd: 0, shown: true };

  function ringDrop() {
    if (!ring.node) return;
    drop(ring.node);
    ring.node = null;
    ring.at = null;
    document.body.classList.remove('fx-ring-on');
  }

  // Where the ring is drawn now, mid-glide or not.
  function ringNow() {
    if (!ring.at) return null;
    if (ring.gliding && Date.now() < ring.glideEnd) return rectOf(ring.node);
    return ring.at;
  }

  // Puts the ring on rect (the focused tile's resting rect), gliding from
  // where it is when glide is true, otherwise at once.
  function ringTo(rect, glide) {
    if (!rect || !can('ring')) { ringDrop(); return; }
    if (!ring.node) {
      ring.node = el('div', 'fx-ring');
      ring.node.setAttribute('aria-hidden', 'true');
      document.body.classList.add('fx-ring-on');
      glide = false;
    }
    var n = ring.node;
    var s = n.style;
    var from = glide ? ringNow() : null;
    s.transition = 'none';
    s.width = px(rect.width);
    s.height = px(rect.height);
    if (from && (Math.abs(from.left - rect.left) > 0.5 || Math.abs(from.top - rect.top) > 0.5 ||
        Math.abs(from.width - rect.width) > 0.5 || Math.abs(from.height - rect.height) > 0.5)) {
      // FLIP: drawn where it was (scaled to that size), then let go.
      s.transform = translate(from.left, from.top, from.width / rect.width, from.height / rect.height);
      void n.offsetWidth;
      s.transition = 'transform ' + RING_MS + 'ms ' + EASE;
      ring.gliding = true;
      ring.glideEnd = Date.now() + RING_MS;
    } else {
      ring.gliding = false;
    }
    s.transform = translate(rect.left, rect.top);
    ring.at = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (ring.shown) { s.opacity = '1'; }
  }

  var lastFocusAt = 0;

  // The focused tile changed. opts.repeat: a held arrow key (no glide).
  function focus(rect, opts) {
    var t = Date.now();
    var quick = t - lastFocusAt < 110;      // keys faster than the eye: keep up instead
    lastFocusAt = t;
    ring.shown = true;
    ringTo(rect, !(opts && opts.repeat) && !quick);
  }

  // A panel opens: the ring goes (the tile itself rides to the middle).
  function ringHide() {
    ring.shown = false;
    if (!ring.node) return;
    ring.node.style.transition = 'opacity 120ms linear';
    ring.node.style.opacity = '0';
  }

  // Layout changed or the window resized: straight to the focused tile.
  function relayout(rect) {
    if (!ring.node) return;
    ringTo(rect, false);
  }

  /* ---------- stagger in an opened panel ---------- */

  var stag = { items: [], timer: null, gen: 0 };

  function staggerClear() {
    clearTimeout(stag.timer);
    for (var i = 0; i < stag.items.length; i++) {
      var s = stag.items[i].style;
      s.transition = '';
      s.transform = '';
      s.opacity = '';
    }
    stag.items = [];
  }

  // body: the panel body just built; selector: the widget's items;
  // tile and panel: rects, so the items come from the tile's side;
  // wait: ms before the first starts.
  function stagger(body, selector, tile, panel, wait) {
    staggerClear();
    if (!selector || !can('stagger')) return;
    var list = body.querySelectorAll(selector);
    if (!list.length) return;
    var dx = (tile.left + tile.width / 2) - (panel.left + panel.width / 2);
    var dy = (tile.top + tile.height / 2) - (panel.top + panel.height / 2);
    var D = 50;
    var fx = 0;
    var fy = 0;
    if (Math.abs(dy) >= Math.abs(dx) * 0.6) fy = dy >= 0 ? D : -D;
    else fx = dx >= 0 ? D : -D;
    var start = translate(fx, fy, 0.85);
    var maxDelay = STAGGER_TOTAL - STAGGER_MS;
    wait = Math.round(Math.max(0, Math.min(wait || 0, 120)));
    var i;
    for (i = 0; i < list.length; i++) {
      var s = list[i].style;
      s.transition = 'none';
      s.opacity = '0';
      s.transform = start;
      stag.items.push(list[i]);
    }
    void body.offsetWidth;
    for (i = 0; i < stag.items.length; i++) {
      var d = wait + Math.min(i * STAGGER_STEP, maxDelay);
      var st = stag.items[i].style;
      st.transition = 'transform ' + STAGGER_MS + 'ms ' + EASE + ' ' + d + 'ms, opacity ' + STAGGER_MS + 'ms ease-out ' + d + 'ms';
      st.transform = translate(0, 0, 1);
      st.opacity = '1';
    }
    stag.timer = later(wait + STAGGER_TOTAL + 80, staggerClear);
  }

  /* ---------- handoff: a new to-do arrives ---------- */

  var hand = { busy: false, dot: null, timers: [] };

  // Cubic bezier easing, for the arc's keyframes (CSS eases each keyframe
  // step on its own, so the easing is baked into where the steps fall).
  function bezier(x1, y1, x2, y2) {
    function a(p, q) { return 1 - 3 * q + 3 * p; }
    function b(p, q) { return 3 * q - 6 * p; }
    function c(p) { return 3 * p; }
    function at(t, p, q) { return ((a(p, q) * t + b(p, q)) * t + c(p)) * t; }
    function slope(t, p, q) { return 3 * a(p, q) * t * t + 2 * b(p, q) * t + c(p); }
    return function (x) {
      var t = x;
      for (var i = 0; i < 8; i++) {
        var sl = slope(t, x1, x2);
        if (Math.abs(sl) < 1e-6) break;
        t -= (at(t, x1, x2) - x) / sl;
      }
      return at(Math.max(0, Math.min(1, t)), y1, y2);
    };
  }
  var travel = bezier(0.4, 0, 0.2, 1);

  function keyframes(name, from, to) {
    var steps = 16;
    var lift = Math.min(220, 80 + Math.abs(to.x - from.x) * 0.25);
    var cx = (from.x + to.x) / 2;
    var cy = Math.min(from.y, to.y) - lift;
    var css = '@keyframes ' + name + '{';
    for (var k = 0; k <= steps; k++) {
      var t = k / steps;
      var p = travel(t);
      var u = 1 - p;
      var x = u * u * from.x + 2 * u * p * cx + p * p * to.x;
      var y = u * u * from.y + 2 * u * p * cy + p * p * to.y;
      var sc = 1.15 - 0.45 * p * p;
      var op = t < 0.1 ? t * 10 : t > 0.9 ? (1 - t) * 10 : 1;
      css += (t * 100).toFixed(2) + '%{transform:' + translate(x, y, sc.toFixed(3)) + ';opacity:' + op.toFixed(2) + '}';
    }
    return css + '}';
  }

  function handoffTimer(ms, fn) { hand.timers.push(later(ms, fn)); }

  // to: the receiving tile; toRect, fromRect: resting rects (fromRect null:
  // no source tile on screen, so no dot); rows: the new rows in the tile,
  // already drawn. False when nothing moved (the rows just show).
  function handoff(to, toRect, fromRect, rows) {
    if (!can('handoff') || hand.busy) return false;
    var quiet = false;
    try { quiet = host.quiet() && !host.clayDrawing(); } catch (e) { quiet = false; }
    if (!quiet) return false;
    hand.busy = true;
    rows = rows || [];
    var i;
    for (i = 0; i < rows.length; i++) {
      rows[i].style.transition = 'none';
      rows[i].style.opacity = '0';
      rows[i].style.transform = translate(-30, 0);
    }
    function land() {
      for (var j = 0; j < rows.length; j++) {
        var s = rows[j].style;
        s.transition = 'transform ' + ROW_MS + 'ms ' + EASE + ', opacity ' + ROW_MS + 'ms ease-out';
        s.transform = translate(0, 0);
        s.opacity = '1';
      }
      to.classList.add('fx-pulse');
      // A frame later, so the overlay starts from opacity 0.
      handoffTimer(30, function () { to.classList.add('fx-pulse-up'); });
      handoffTimer(230, function () { to.classList.remove('fx-pulse-up'); });
      handoffTimer(950, function () {
        to.classList.remove('fx-pulse');
        for (var k = 0; k < rows.length; k++) { rows[k].style.transition = ''; rows[k].style.transform = ''; rows[k].style.opacity = ''; }
        hand.busy = false;
      });
    }
    if (!fromRect) { land(); return true; }

    var D = 22;   // the dot's size in px at 1920 wide; scaled with the screen
    var size = Math.round(D * window.innerWidth / 1920);
    var first = rows[0] ? rectOf(rows[0]) : null;
    var from = { x: fromRect.left + fromRect.width / 2 - size / 2, y: fromRect.top + fromRect.height * 0.62 - size / 2 };
    var to2 = first ? { x: first.left + 14 - size / 2, y: first.top + first.height / 2 - size / 2 } :
      { x: toRect.left + toRect.width / 2 - size / 2, y: toRect.top + toRect.height * 0.3 - size / 2 };
    if (!hand.dot) hand.dot = el('div', 'fx-dot');
    if (!styleEl) { styleEl = document.createElement('style'); document.head.appendChild(styleEl); }
    runs += 1;
    var name = 'fxArc' + runs;
    styleEl.textContent = keyframes(name, from, to2);
    var d = hand.dot;
    d.style.width = size + 'px';
    d.style.height = size + 'px';
    d.style.animation = 'none';
    void d.offsetWidth;
    d.style.animation = name + ' ' + DOT_MS + 'ms linear forwards';
    after(d, DOT_MS, function () {
      d.style.animation = 'none';
      d.style.opacity = '0';
      land();
    }, 'animationend');
    return true;
  }

  /* ---------- shared cover (Now Playing) ---------- */

  var share = { fly: null, dest: null, timer: null };

  function shareEnd() {
    clearTimeout(share.timer);
    if (share.dest) share.dest.style.visibility = '';
    drop(share.fly);
    share.fly = null;
    share.dest = null;
  }

  function visibleShare(root) {
    if (!root) return null;
    var list = root.querySelectorAll('[data-share]');
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return list[i];
    }
    return null;
  }

  // Before a change: what is on screen now and where. Null when there is
  // nothing to carry over.
  function shareFrom(root) {
    var running = !!share.fly;
    shareEnd();
    if (!can('cover')) return null;
    var node = visibleShare(root);
    if (!node) return null;
    return { key: node.getAttribute('data-share'), rect: rectOf(node), node: node, interrupted: running };
  }

  // After the change: fly a copy from where it was to where its twin is now.
  function shareTo(from, root, out) {
    if (!from || !can('cover')) return false;
    var dest = null;
    var list = root ? root.querySelectorAll('[data-share="' + from.key + '"]') : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width > 4 && r.height > 4) { dest = list[i]; break; }
    }
    if (!dest) return false;
    var to = rectOf(dest);
    var a = from.rect;
    if (!a.width || !a.height || !to.width || !to.height) return false;
    var fly = el('div', 'fx-fly');
    fly.style.width = px(a.width);
    fly.style.height = px(a.height);
    var face = (from.node.querySelector('.np-face') || from.node).cloneNode(true);
    fly.appendChild(face);
    fly.style.transform = translate(a.left, a.top);
    dest.style.visibility = 'hidden';
    share.fly = fly;
    share.dest = dest;
    var ms = out ? COVER_OUT_MS : COVER_IN_MS;
    void fly.offsetWidth;
    fly.style.transition = 'transform ' + ms + 'ms ' + EASE;
    fly.style.transform = translate(to.left, to.top, to.width / a.width, to.height / a.height);
    share.timer = later(ms + 40, shareEnd);
    return true;
  }

  /* ---------- launch bloom ---------- */

  var bloomState = { node: null, timer: null };

  function bloomEnd(fade) {
    clearTimeout(bloomState.timer);
    var n = bloomState.node;
    bloomState.node = null;
    if (!n) return;
    if (!fade) { drop(n); return; }
    n.style.transition = 'opacity 160ms linear';
    n.style.opacity = '0';
    later(220, function () { drop(n); });
  }

  // node: the item being opened (it holds a .logo-face). Returns
  // { cancel() } when it bloomed, null when not.
  function bloom(node) {
    bloomEnd(false);
    if (!node || !can('bloom')) return null;
    var face = node.querySelector('.logo-face') || node;
    var r = rectOf(face);
    if (!r.width || !r.height) return null;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var cs = window.getComputedStyle(face);
    var wrap = el('div', 'fx-bloom');
    wrap.style.width = px(r.width);
    wrap.style.height = px(r.height);
    wrap.style.backgroundColor = cs.backgroundColor;
    wrap.style.borderRadius = cs.borderTopLeftRadius;
    // Scaled about its middle, far enough that every corner of the screen is covered.
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var k = Math.max(2 * Math.max(cx, W - cx) / r.width, 2 * Math.max(cy, H - cy) / r.height) * 1.12;
    // A plain square of the icon's own color (a copy of the logo itself
    // cost a 100 ms frame to draw that big, even on a desktop), fading in
    // over the icon as it starts to grow.
    wrap.style.opacity = '0';
    wrap.style.transform = translate(r.left, r.top, 1);
    bloomState.node = wrap;
    void wrap.offsetWidth;
    wrap.style.transition = 'transform ' + BLOOM_MS + 'ms cubic-bezier(0.5, 0, 0.2, 1), opacity 120ms linear';
    wrap.style.transform = translate(cx - r.width * k / 2, cy - r.height * k / 2, k.toFixed(3));
    wrap.style.opacity = '1';
    bloomState.timer = later(BLOOM_MS + BLOOM_HOLD_MS, function () { bloomEnd(true); });
    return { cancel: safe(function () { bloomEnd(true); }) };
  }

  // Back to the hub after an app (or the page was hidden): no bloom left over.
  document.addEventListener('visibilitychange', safe(function () {
    if (!document.hidden) bloomEnd(false);
  }));

  /* ---------- status ---------- */

  // For the About panel's Motion row: '' when every motion switch is off.
  function statusText() {
    if (!anyMotion()) return '';
    var sp = speed();
    if (sp === 'ok') return STRINGS.extrasOn;
    return STRINGS.extrasOff.replace('{why}', STRINGS.why[sp] || sp);
  }

  // The hub's motion setting changed (auto stepped down): drop what is shown.
  function motionChanged() {
    if (speed() !== 'ok') {
      ringDrop();
      staggerClear();
      shareEnd();
    }
  }

  /* ---------- start ---------- */

  // host: { config, speed() 'ok'|'fade'|'slow', quiet(), clayDrawing() }
  function start(h) {
    host = h;
    flags = readFlags(h && h.config);
    if (on('quietTiles')) document.body.classList.add('fx-quiet');
  }

  window.HUB_FX = {
    start: safe(start),
    on: function (name) { return on(name); },
    can: function (name) { return can(name); },
    markTile: safe(markTile),
    focus: safe(focus),
    ringHide: safe(ringHide),
    relayout: safe(relayout),
    stagger: safe(stagger),
    handoff: safe(function () { return handoff.apply(null, arguments) === true; }),
    shareFrom: safe(shareFrom),
    shareTo: safe(shareTo),
    bloom: safe(bloom),
    statusText: safe(statusText),
    motionChanged: safe(motionChanged),
    // For tests: what is going on now.
    state: function () {
      return {
        flags: JSON.parse(JSON.stringify(flags)),
        speed: speed(),
        ring: ring.node ? { at: ring.at, shown: ring.shown, gliding: ring.gliding && Date.now() < ring.glideEnd } : null,
        handoff: hand.busy,
        arcs: runs,
        staggering: stag.items.length,
        flying: !!share.fly,
        blooming: !!bloomState.node
      };
    }
  };
})();
