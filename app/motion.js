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
 *               { icon, key, label, working, workingKey }) adds a kind (key: an
 *               app/i18n.js key, label: its English, or a function giving
 *               the words; working and workingKey: the same for its
 *               working chip).
 *               While a sync is still on its way (the Pi passes on a
 *               "hub:working <kind> [seconds]" say text, see hub.js), the
 *               tile that declares that kind shows a quieter "working" chip
 *               whose icon is still and only breathes (one opacity loop).
 *               It ends by itself when its time is up (120 s unless told,
 *               10 to 900 s), on "hub:working <kind> done", or when the
 *               data lands: real news turns that same chip into the
 *               arrival chip, unchanged data lets it fade.
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
    },
    // The working chips, while a sync is still on its way (one line each).
    // Spanish in app/i18n.js: motion.working.<kind>.
    working: {
      todo: 'Working on to-dos',
      calendar: 'Checking calendar',
      awws: 'Gathering data'
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

  var FLAGS = ['quietTiles', 'ring', 'stagger', 'cover', 'bloom', 'activity'];
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
  var WORK_MS = 120000;          // a working chip without a time given lasts this long
  var WORK_MIN_S = 10;           // and a time given is kept within these (seconds)
  var WORK_MAX_S = 900;
  var WORK_TICK_MS = 1000;       // how often the working chips look around
  var WORK_KIND_RE = /^[a-z][a-z0-9-]{0,23}$/;
  var WORK_SAVE_KEY = 'homeHub.working';   // sessionStorage: kept over a reload (layout switch)
  var WORK_RESTORE_GRACE_MS = 15000;       // after that reload, data this soon does not end one

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
    KINDS[kind] = { icon: typeof def.icon === 'string' ? def.icon : '', key: key, label: label,
      working: typeof def.working === 'string' ? def.working : '',
      workingKey: typeof def.workingKey === 'string' && def.workingKey ? def.workingKey : '' };
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
  addActivity('todo', { key: 'motion.activity.todo', label: STRINGS.activity.todo,
    working: STRINGS.working.todo, workingKey: 'motion.working.todo', icon:
    '<i class="fx-act-line"></i>' +
    '<i class="fx-act-pen"><svg viewBox="0 0 34 34"><path d="M6 22 L22 6 L27 11 L11 27 L5 28 Z" fill="#cfeeff"/></svg></i>' });
  // A calendar whose dots tick in turn.
  addActivity('calendar', { key: 'motion.activity.calendar', label: STRINGS.activity.calendar,
    working: STRINGS.working.calendar, workingKey: 'motion.working.calendar', icon:
    '<svg viewBox="0 0 34 34"><rect x="4" y="7" width="26" height="23" rx="5" fill="none" stroke="#7fd1ff" stroke-width="2.5"/></svg>' +
    '<i class="fx-act-dot"></i><i class="fx-act-dot"></i><i class="fx-act-dot"></i><i class="fx-act-dot"></i><i class="fx-act-dot"></i>' });
  // Three bars rising and falling.
  addActivity('awws', { key: 'motion.activity.awws', label: STRINGS.activity.awws,
    working: STRINGS.working.awws, workingKey: 'motion.working.awws', icon:
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
    // A working chip taken away (a panel opened): its state stays, so it can come back.
    var w = a.workKind && working.hasOwnProperty(a.workKind) ? working[a.workKind] : null;
    if (w && w.act === a) w.act = null;
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
          if (t) t.textContent = acts[i].workKind ? workLabel(acts[i].workKind) : labelOf(acts[i].kind);
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

  function kindClass(kind) { return 'fx-chip fx-chip-' + String(kind).replace(/[^a-z0-9-]/gi, ''); }

  // The chip element (not yet in a tile): the kind's icon and a label.
  function makeChip(kind, label, extra) {
    var chip = document.createElement('div');
    chip.className = kindClass(kind) + (extra ? ' ' + extra : '');
    chip.setAttribute('aria-hidden', 'true');
    var ico = el('span', 'fx-act-ico', chip);
    ico.innerHTML = KINDS[kind].icon;
    el('span', 'fx-chip-text', chip).textContent = label;
    return chip;
  }

  function makeEdge(tile) {
    var edge = document.createElement('div');
    edge.className = 'fx-edge';
    edge.setAttribute('aria-hidden', 'true');
    el('i', '', edge);
    tile.appendChild(edge);
    return edge;
  }

  // Fades a chip out (150 ms), then takes it away.
  function actFade(a) {
    clearTimeout(a.timer);
    a.retiring = true;
    a.chip.className = a.chip.className.replace(/ is-in\b/g, '').replace(/ is-out\b/g, '') + ' is-out';
    a.timer = later(ACT_OUT_MS + 60, function () { actEnd(a); });
  }

  // The arrival chip's hold: about 2.4 s, then the fade.
  function actHold(a) {
    clearTimeout(a.timer);
    a.timer = later(ACT_HOLD_MS, function () { actFade(a); });
  }

  // A working chip becomes the arrival chip, the same element: the arrival
  // label, the icon's loops run, the edge sweeps, then the usual hold.
  function actUpgrade(a, kind) {
    clearTimeout(a.timer);
    a.workKind = null;
    a.retiring = false;
    a.kind = kind;
    a.chip.className = kindClass(kind) + ' is-in';
    var text = a.chip.querySelector('.fx-chip-text');
    if (text) text.textContent = labelOf(kind);
    if (!a.edge) a.edge = makeEdge(a.tile);
    actHold(a);
  }

  // tile: the tile's element (the chip goes inside it, over its content, so
  // nothing else moves). True when a chip shows.
  function activity(tile, kind) {
    if (!tile || !KINDS.hasOwnProperty(kind)) return false;
    // Real data for this kind landed: its working state ends, here or anywhere.
    var w = working.hasOwnProperty(kind) ? working[kind] : null;
    if (w) {
      delete working[kind];
      workSave();
      if (w.act && w.act.tile === tile && !w.act.retiring && can('activity') && homeQuiet()) {
        actUpgrade(w.act, kind);
        return true;
      }
      if (w.act) actFade(w.act);
    }
    if (!can('activity')) return false;
    var cur = actOf(tile);
    // (A working chip of this kind that just began to fade, for another tile
    // of the same kind a moment ago: it becomes this tile's arrival chip.)
    if (cur && cur.retiring && cur.wasWork === kind && homeQuiet()) {
      actUpgrade(cur, kind);
      return true;
    }
    if (cur || !homeQuiet()) return false;
    var chip = makeChip(kind, labelOf(kind));
    var edge = makeEdge(tile);
    tile.appendChild(chip);
    var a = { tile: tile, kind: kind, chip: chip, edge: edge, timer: null };
    acts.push(a);
    void chip.offsetWidth;
    chip.className += ' is-in';
    actHold(a);
    return true;
  }

  /* ---------- working chips ---------- */

  // kind -> { until (ms), started (ms, the last signal), act (the chip shown, or null) }
  var working = {};
  var workTimer = null;

  // The words for a working chip, looked up when it shows.
  function workLabel(kind) {
    var def = KINDS[kind];
    if (!def) return '';
    if (def.working) return def.workingKey ? tr(def.workingKey, def.working) : def.working;
    return labelOf(kind);
  }

  function workSave() {
    try {
      if (!window.sessionStorage) return;
      var out = {};
      var any = false;
      for (var k in working) {
        if (working.hasOwnProperty(k)) { out[k] = working[k].until; any = true; }
      }
      if (any) sessionStorage.setItem(WORK_SAVE_KEY, JSON.stringify(out));
      else sessionStorage.removeItem(WORK_SAVE_KEY);
    } catch (e) { /* kept in memory only */ }
  }

  // After a reload (a layout with other tiles reloads the page): what was still working.
  function workLoad() {
    try {
      if (!window.sessionStorage) return;
      var raw = sessionStorage.getItem(WORK_SAVE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      var t = Date.now();
      for (var k in saved) {
        if (!saved.hasOwnProperty(k) || !WORK_KIND_RE.test(k) || !KINDS.hasOwnProperty(k)) continue;
        var until = Number(saved[k]);
        if (!isFinite(until) || until <= t) continue;
        // (started a little ahead: the first sync after the reload is the
        // state now, not the job's end, so it does not end the chip.)
        working[k] = { until: Math.min(until, t + WORK_MAX_S * 1000), started: t + WORK_RESTORE_GRACE_MS, act: null };
      }
      workSave();
    } catch (e) { /* start without them */ }
  }

  function workTileFor(kind) {
    try {
      var t = host && host.tileFor ? host.tileFor(kind) : null;
      return t && t.nodeType === 1 ? t : null;
    } catch (e) { return null; }
  }

  function workShow(kind, w, tile) {
    var chip = makeChip(kind, workLabel(kind), 'fx-chip-working');
    tile.appendChild(chip);
    var a = { tile: tile, kind: kind, chip: chip, edge: null, timer: null, workKind: kind, wasWork: kind, retiring: false };
    acts.push(a);
    w.act = a;
    void chip.offsetWidth;
    chip.className += ' is-in';
  }

  // Puts every working chip where it belongs now, ends the ones whose time
  // is up, and looks again in a second while any is left.
  function workReconcile() {
    clearTimeout(workTimer);
    workTimer = null;
    var t = Date.now();
    var left = false;
    var changed = false;
    for (var kind in working) {
      if (!working.hasOwnProperty(kind)) continue;
      var w = working[kind];
      if (t >= w.until) {
        delete working[kind];
        changed = true;
        if (w.act) actFade(w.act);
        continue;
      }
      left = true;
      if (!can('activity')) {
        if (w.act) actEnd(w.act);
        continue;
      }
      var quiet = homeQuiet();
      var tile = quiet ? workTileFor(kind) : null;
      if (w.act && (!quiet || w.act.tile !== tile || !document.documentElement.contains(w.act.tile))) actEnd(w.act);
      if (!w.act && tile && !actOf(tile)) workShow(kind, w, tile);
    }
    if (changed) workSave();
    if (left) workTimer = later(WORK_TICK_MS, workReconcile);
  }

  // A sync for kind is on its way: seconds (10 to 900, 120 when null) at most.
  function workStart(kind, seconds) {
    if (!on('activity') || typeof kind !== 'string' || !WORK_KIND_RE.test(kind) || !KINDS.hasOwnProperty(kind)) return false;
    var s = seconds === null || seconds === undefined || seconds === '' ? WORK_MS / 1000 : Number(seconds);
    if (!isFinite(s)) return false;
    s = Math.max(WORK_MIN_S, Math.min(WORK_MAX_S, s));
    var t = Date.now();
    var w = working.hasOwnProperty(kind) ? working[kind] : null;
    if (w) {
      w.until = Math.max(w.until, t + s * 1000);
      w.started = t;
    } else {
      working[kind] = { until: t + s * 1000, started: t, act: null };
    }
    workSave();
    workReconcile();
    return true;
  }

  // The sync for kind ended with nothing new: the chip fades quietly. With
  // before (ms), only when no new signal came after that moment.
  function workDone(kind, before) {
    if (typeof kind !== 'string' || !working.hasOwnProperty(kind)) return false;
    var w = working[kind];
    if (typeof before === 'number' && w.started > before) return false;
    delete working[kind];
    workSave();
    if (w.act) actFade(w.act);
    workReconcile();
    return true;
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
    }
  }

  /* ---------- start ---------- */

  // host: { config, speed() 'ok'|'fade'|'slow', quiet() (the home screen is
  // in view, uncovered), clayDrawing() (the wanderers are on screen),
  // tileFor(kind) (the home tile for a kind's working chip, or null) }
  function start(h) {
    host = h;
    flags = readFlags(h && h.config);
    if (on('quietTiles')) document.body.classList.add('fx-quiet');
    if (on('activity')) {
      workLoad();
      workReconcile();
    }
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
    working: safe(function (kind, seconds) { return workStart(kind, seconds) === true; }),
    workingDone: safe(function (kind, before) { return workDone(kind, before) === true; }),
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
        working: (function () {
          var out = [];
          var t = Date.now();
          for (var k in working) {
            if (working.hasOwnProperty(k)) out.push({ kind: k, shown: !!working[k].act, left: Math.max(0, working[k].until - t) });
          }
          return out;
        })(),
        // The words each kind's chip would show now.
        labels: (function () { var o = {}; for (var k in KINDS) if (KINDS.hasOwnProperty(k)) o[k] = labelOf(k); return o; })()
      };
    }
  };
})();
