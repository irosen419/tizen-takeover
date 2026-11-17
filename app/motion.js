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
 *   cover       The Now Playing cover flies between the page and the
 *               visualizer's card when full screen opens and closes.
 *   bloom       An app's icon grows to fill the screen while the app opens.
 *   activity    When a live sync brings real new data for a tile (a new
 *               to-do, changed events, a changed snapshot), that tile shows a
 *               small chip in its lower left corner ("Incoming to-do") for
 *               about 2.4 s, with a light that sweeps its top edge twice.
 *               Never on the first data after the hub starts, while the
 *               wanderers are on screen, or while the home screen is covered.
 *               Widgets call ctx.activity(kind); HUB_FX.addActivity(kind,
 *               { icon, key, label }) adds a kind (key: an app/i18n.js key,
 *               label: its English, or a function giving the words).
 *   edge        The accent edge: a thin 4px light along the top of a tile
 *               that has something new to see (every activity above, and
 *               ctx.accent(), e.g. an event starting within the hour). It
 *               fades in, stays about 60 s and fades out; opening the tile
 *               clears it. Static (no sweep, no fades) in 'fade' mode or
 *               on a slow screen. Never on focus.
 *
 * Every moving part animates only transform and opacity, and runs only when
 * the hub's own timing (motion 'auto', see hub.js) says the screen keeps up:
 * in 'fade' mode, after auto stepped down from push, or below 40 frames a
 * second, focus is the plain border swap and the rest happens at once.
 * With every switch off this file adds no element and no class.
 *
 * Every entry point is wrapped, so if anything here breaks, the hub carries
 * on exactly as without it.
 */
(function () {
  'use strict';

  /* Every word this file shows, in English. The Spanish is in app/i18n.js
     under the same keys ('motion.' + the path here, in its "Motion extras"
     section); each word is looked up when it is shown, so a language change
     on the Clock page applies to the next chip and the next About refresh. */
  var STRINGS = {
    extrasOn: 'extras on',
    extrasOff: 'extras off ({why})',
    why: { fade: 'fade mode', slow: 'slow screen' },
    // The activity chips, one line each (Spanish runs about a quarter longer).
    activity: {
      todo: 'Incoming to-do',
      calendar: 'Updating calendar',
      awws: 'Syncing data'
    }
  };

  // key: an i18n key; english: the text when HUB_I18N is missing or has no
  // Spanish for it. vars fill {name} in either.
  function tr(key, english, vars) {
    var L = window.HUB_I18N;
    if (L && typeof L.t === 'function') {
      try { return String(L.t(key, english, vars)); } catch (e) { /* English below */ }
    }
    var text = String(english);
    if (vars) for (var v in vars) if (vars.hasOwnProperty(v)) text = text.split('{' + v + '}').join(String(vars[v]));
    return text;
  }

  var FLAGS = ['quietTiles', 'ring', 'stagger', 'cover', 'bloom', 'activity', 'edge'];
  var EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';   // ease-out: every entrance
  var RING_MS = 190;
  var STAGGER_MS = 260;
  var STAGGER_STEP = 35;
  var STAGGER_TOTAL = 500;
  var COVER_IN_MS = 520;
  var COVER_OUT_MS = 420;
  var BLOOM_MS = 480;
  var BLOOM_HOLD_MS = 2600;      // the app normally covers the hub long before this
  var ACT_HOLD_MS = 2400;        // the chip shows this long (the edge sweeps twice in it)
  var ACT_OUT_MS = 150;          // then fades out (the entrance, 220 ms, is in style.css)
  var EDGE_HOLD_MS = 60000;      // the accent edge stays this long (edgeHold() changes it, for tests)
  var EDGE_IN_MS = 400;
  var EDGE_OUT_MS = 600;

  var host = null;               // from hub.js (see start)
  var flags = {};

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

  /* ---------- activity chips ---------- */

  // The kinds a widget can say: { icon (HTML), key, label }. The icons are
  // plain elements so every loop moves only transform or opacity (style.css).
  // The words are found when a chip shows, in the language then active:
  //   key    an app/i18n.js key ('budget.activity'); label is its English
  //   label  a string (shown as it is when there is no key), or a function
  //          that returns the words in the hub's language at that moment
  var KINDS = {};

  function addActivity(kind, def) {
    if (!kind || !def || typeof def !== 'object') return false;
    var label = typeof def.label === 'string' || typeof def.label === 'function' ? def.label : '';
    var key = typeof def.key === 'string' && def.key ? def.key : '';
    KINDS[kind] = { icon: typeof def.icon === 'string' ? def.icon : '', key: key, label: label };
    return true;
  }

  // The chip's words for a kind, in the language active now.
  function labelOf(kind) {
    var def = KINDS[kind];
    if (!def) return '';
    if (typeof def.label === 'function') {
      try { return String(def.label() || ''); } catch (e) { return ''; }
    }
    return def.key ? tr(def.key, def.label) : def.label;
  }

  // A pencil writing a line.
  addActivity('todo', { key: 'motion.activity.todo', label: STRINGS.activity.todo, icon:
    '<i class="fx-act-line"></i>' +
    '<i class="fx-act-pen"><svg viewBox="0 0 34 34"><path d="M6 22 L22 6 L27 11 L11 27 L5 28 Z" fill="#cfeeff"/></svg></i>' });
  // A calendar whose dots tick in turn.
  addActivity('calendar', { key: 'motion.activity.calendar', label: STRINGS.activity.calendar, icon:
    '<svg viewBox="0 0 34 34"><rect x="4" y="7" width="26" height="23" rx="5" fill="none" stroke="#7fd1ff" stroke-width="2.5"/></svg>' +
    '<i class="fx-act-dot"></i><i class="fx-act-dot"></i><i class="fx-act-dot"></i><i class="fx-act-dot"></i><i class="fx-act-dot"></i>' });
  // Three bars rising and falling.
  addActivity('awws', { key: 'motion.activity.awws', label: STRINGS.activity.awws, icon:
    '<i class="fx-act-bar"></i><i class="fx-act-bar"></i><i class="fx-act-bar"></i>' });

  var acts = [];                 // [{ tile, kind, chip, edge, timer }]

  function actOf(tile) {
    for (var i = 0; i < acts.length; i++) if (acts[i].tile === tile) return acts[i];
    return null;
  }

  function actEnd(a) {
    clearTimeout(a.timer);
    drop(a.chip);
    drop(a.edge);
    var i = acts.indexOf(a);
    if (i >= 0) acts.splice(i, 1);
  }

  function activityStop() {
    while (acts.length) actEnd(acts[0]);
  }

  // The language changed on the Clock page: a chip still showing says its
  // words again in the new one (the next chips look theirs up as they show).
  try {
    if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') {
      window.HUB_I18N.onChange(safe(function () {
        for (var i = 0; i < acts.length; i++) {
          var t = acts[i].chip.querySelector('.fx-chip-text');
          if (t) t.textContent = labelOf(acts[i].kind);
        }
      }));
    }
  } catch (e) { /* the chips keep their words */ }

  // The home screen is in view and nothing else draws over it.
  function homeQuiet() {
    try {
      if (!host || !host.quiet || !host.quiet()) return false;
      return !(host.clayDrawing && host.clayDrawing());
    } catch (e) { return false; }
  }

  // tile: the tile's element (the chip goes inside it, over its content, so
  // nothing else moves). True when a chip shows.
  function activity(tile, kind) {
    if (!tile || !KINDS.hasOwnProperty(kind)) return false;
    var shown = activityChip(tile, kind);
    // The accent edge comes with every activity, chip or no chip (a panel
    // open, the wanderers out): it stays after the chip, about a minute.
    accent(tile, kind, shown);
    return shown;
  }

  function activityChip(tile, kind) {
    if (!can('activity')) return false;
    if (actOf(tile) || !homeQuiet()) return false;
    var def = KINDS[kind];
    var chip = document.createElement('div');
    chip.className = 'fx-chip fx-chip-' + String(kind).replace(/[^a-z0-9-]/gi, '');
    chip.setAttribute('aria-hidden', 'true');
    var ico = el('span', 'fx-act-ico', chip);
    ico.innerHTML = def.icon;
    el('span', 'fx-chip-text', chip).textContent = labelOf(kind);
    var edge = document.createElement('div');
    edge.className = 'fx-edge';
    edge.setAttribute('aria-hidden', 'true');
    el('i', '', edge);
    tile.appendChild(edge);
    tile.appendChild(chip);
    var a = { tile: tile, kind: kind, chip: chip, edge: edge, timer: null };
    acts.push(a);
    void chip.offsetWidth;
    chip.className += ' is-in';
    a.timer = later(ACT_HOLD_MS, function () {
      chip.className = chip.className.replace(' is-in', '') + ' is-out';
      a.timer = later(ACT_OUT_MS + 60, function () { actEnd(a); });
    });
    return true;
  }

  /* ---------- accent edge ---------- */

  // One per tile: { tile, node, timer }. The node is a static gradient line
  // (only its opacity changes) with an optional light that sweeps it once
  // (transform only).
  var edges = [];

  function edgeOf(tile) {
    for (var i = 0; i < edges.length; i++) if (edges[i].tile === tile) return edges[i];
    return null;
  }

  function edgeEnd(e) {
    clearTimeout(e.timer);
    drop(e.node);
    var i = edges.indexOf(e);
    if (i >= 0) edges.splice(i, 1);
  }

  function edgeFade(e) {
    clearTimeout(e.timer);
    if (!can('edge')) { edgeEnd(e); return; }
    e.node.style.transition = 'opacity ' + EDGE_OUT_MS + 'ms linear';
    e.node.style.opacity = '0';
    e.fading = true;
    e.timer = later(EDGE_OUT_MS + 40, function () { edgeEnd(e); });
  }

  function edgeArm(e, ms) {
    clearTimeout(e.timer);
    e.timer = later(ms, function () { edgeFade(e); });
  }

  // tile: the tile element; reason: what is new (for the tests); quiet:
  // true when the activity chip's own light already sweeps the edge.
  function accent(tile, reason, quiet) {
    if (!tile || !on('edge')) return false;
    var moving = can('edge');
    var e = edgeOf(tile);
    if (!e) {
      var node = document.createElement('div');
      node.className = 'fx-accent';
      node.setAttribute('aria-hidden', 'true');
      e = { tile: tile, node: node, timer: null, reason: reason };
      edges.push(e);
      tile.appendChild(node);
      if (moving) {
        node.style.opacity = '0';
        void node.offsetWidth;
        node.style.transition = 'opacity ' + EDGE_IN_MS + 'ms linear';
      }
      node.style.opacity = '1';
    } else {
      // News again: the minute starts again (and a fading edge comes back).
      e.reason = reason;
      e.fading = false;
      e.node.style.transition = moving ? 'opacity ' + EDGE_IN_MS + 'ms linear' : 'none';
      e.node.style.opacity = '1';
    }
    // A light sweeps the line once, unless the chip's own already does.
    var old = e.node.firstChild;
    if (old) e.node.removeChild(old);
    if (moving && !quiet) el('i', 'fx-accent-sweep', e.node);
    edgeArm(e, EDGE_HOLD_MS);
    return true;
  }

  // The tile was opened: seen, so its edge goes at once.
  function accentClear(tile) {
    var e = edgeOf(tile);
    if (e) edgeEnd(e);
  }

  function edgeClear() {
    while (edges.length) edgeEnd(edges[0]);
  }

  /* ---------- status ---------- */

  // For the About panel's Motion row: '' when every motion switch is off.
  function statusText() {
    if (!anyMotion()) return '';
    var sp = speed();
    if (sp === 'ok') return tr('motion.extrasOn', STRINGS.extrasOn);
    var why = STRINGS.why.hasOwnProperty(sp) ? tr('motion.why.' + sp, STRINGS.why[sp]) : sp;
    return tr('motion.extrasOff', STRINGS.extrasOff, { why: why });
  }

  // The hub's motion setting changed (auto stepped down): drop what is shown.
  function motionChanged() {
    if (speed() !== 'ok') {
      ringDrop();
      staggerClear();
      shareEnd();
      activityStop();
      // Edges stay, but as still lines (no sweep, no fade).
      for (var i = 0; i < edges.length; i++) {
        var n = edges[i].node;
        if (n.firstChild) n.removeChild(n.firstChild);
        n.style.transition = 'none';
        if (!edges[i].fading) n.style.opacity = '1';
      }
    }
  }

  /* ---------- start ---------- */

  // host: { config, speed() 'ok'|'fade'|'slow', quiet() (the home screen is
  // in view, uncovered), clayDrawing() (the wanderers are on screen) }
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
    shareFrom: safe(shareFrom),
    shareTo: safe(shareTo),
    bloom: safe(bloom),
    activity: safe(function () { return activity.apply(null, arguments) === true; }),
    activityStop: safe(activityStop),
    addActivity: safe(function (kind, def) { return addActivity(kind, def) === true; }),
    accent: safe(function (tile, reason) { return accent(tile, reason, false) === true; }),
    accentClear: safe(accentClear),
    edgeClear: safe(edgeClear),
    // For tests: how long an edge stays (ms); the ones showing now end that
    // long from now. Without ms: the current hold.
    edgeHold: safe(function (ms) {
      if (typeof ms !== 'number' || !(ms >= 0)) return EDGE_HOLD_MS;
      EDGE_HOLD_MS = ms;
      for (var i = 0; i < edges.length; i++) if (!edges[i].fading) edgeArm(edges[i], ms);
      return EDGE_HOLD_MS;
    }),
    statusText: safe(statusText),
    motionChanged: safe(motionChanged),
    // For tests: what is going on now.
    state: function () {
      return {
        flags: JSON.parse(JSON.stringify(flags)),
        speed: speed(),
        ring: ring.node ? { at: ring.at, shown: ring.shown, gliding: ring.gliding && Date.now() < ring.glideEnd } : null,
        staggering: stag.items.length,
        flying: !!share.fly,
        blooming: !!bloomState.node,
        chips: acts.map(function (a) { return a.kind; }),
        edges: edges.map(function (e) { return { widget: (e.tile.parentNode && e.tile.parentNode.getAttribute('data-widget')) || '', reason: e.reason, fading: !!e.fading }; }),
        // The words each kind's chip would show now.
        labels: (function () { var o = {}; for (var k in KINDS) if (KINDS.hasOwnProperty(k)) o[k] = labelOf(k); return o; })()
      };
    }
  };
})();
