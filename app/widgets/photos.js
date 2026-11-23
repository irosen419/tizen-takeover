/*
 * Photo album: friends' photos from the Pi, as a slideshow on the tile and
 * a thumbnail grid with a big viewer in full screen.
 *
 * DATA (the Pi server, pi/photos.js, built separately):
 *   GET <server>/photos/list          { rev, count, items: [{ id, w, h, month: 'YYYY-MM' }] },
 *                                     newest first
 *   GET <server>/photos/img/<id>?size=full|thumb
 *                                     full ~1080x1440 WebP, thumb ~480 px wide
 * <server> is the hub server the live line uses (?live=<address> on the page,
 * else HUB_CONFIG.live.server, else HUB_PI:8097). The list is fetched at boot
 * and every 10 minutes (and when a "photos" live resource arrives, if the Pi
 * ever sends one); an unchanged rev changes nothing. No Pi, no photos: a
 * quiet frame says so, never an error box.
 *
 *   tile       one photo at a time, ~12 s each (HUB_CONFIG.widgets.photos.seconds),
 *              crossfaded by opacity between two stacked layers once the next
 *              image has loaded. A photo whose shape is close to the tile's
 *              covers it; any other (a portrait on a landscape tile) is shown
 *              whole (contain), over the same image scaled up and blurred
 *              once (a static layer, never animated). A month caption
 *              ("November 2026") on a soft gradient at the bottom, except on
 *              1-column tiles. A hairline at the bottom shows the time left.
 *   full       OK opens straight to full screen (openMode 'full'): the photos
 *              as thumbnails grouped by month (inline blocks, no CSS grid),
 *              loaded as they come into view. OK on one opens the viewer:
 *              the photo whole, the month and "12 of 38"; Left/Right (or a
 *              tap on the left/right half) go to the previous/next; Back goes
 *              back to the grid, then closes.
 *
 * Guest mode leaves photos alone (they are not amounts). Plain ES5; only
 * opacity and transform animate; focus changes are instant.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var REFRESH_MS = 10 * 60 * 1000;
  var DEFAULT_SECONDS = 12;
  var LOAD_WAIT_MS = 20000;       // an image that takes longer is skipped
  var THUMB_PX = 520;             // frames up to this many device pixels use the thumb
  var THUMB_BATCH = 24;           // grid thumbnails loaded at first, the rest as they show

  var S = {
    ctx: null,
    items: [],
    rev: null,
    state: 'loading',             // loading | ok | empty | offline
    index: 0,                     // the photo on the tile
    tile: null,                   // { body, frame, stage, bar }
    timer: null,
    loading: false,
    viewing: -1,                  // the photo in the viewer, -1 = the grid
    view: null,                   // { stage, month, count }
    lastThumb: -1
  };

  /* ---------- languages ---------- */

  function I18N() {
    var L = window.HUB_I18N;
    return L && typeof L.t === 'function' ? L : null;
  }

  function T(key, en, vars) {
    var L = I18N();
    if (L) return L.t(key, en, vars);
    return String(en).replace(/\{(\w+)\}/g, function (all, n) { return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all; });
  }

  function title() { return T('photos.title', 'Photo album'); }
  function shortTitle() { return T('photos.titleShort', 'Photos'); }

  var MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // 'YYYY-MM' -> "November 2026" / "Noviembre de 2026". '' when unreadable.
  function monthLabel(month) {
    var m = /^(\d{4})-(\d{2})/.exec(String(month || ''));
    if (!m) return '';
    var mi = parseInt(m[2], 10) - 1;
    if (mi < 0 || mi > 11) return '';
    var L = I18N();
    var name = L && typeof L.monthName === 'function' ? L.monthName(new Date(+m[1], mi, 15)) : MONTHS_EN[mi];
    var text = T('photos.month', '{month} {year}', { month: name, year: m[1] });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function countText(n, total) { return T('photos.count', '{n} of {total}', { n: n, total: total }); }
  function totalText(n) { return n === 1 ? T('photos.countOne', '1 photo') : T('photos.countAll', '{n} photos', { n: n }); }

  /* ---------- where the photos come from ---------- */

  function readQuery(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function clean(s) {
    s = String(s || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    return /^https?:\/\/[^\s\/?#]+$/i.test(s) ? s : '';
  }

  function server() {
    var q = readQuery('live');
    if (q === 'off') return '';
    if (q) return clean(q);
    var c = S.ctx && S.ctx.config && S.ctx.config.server;
    if (c) return clean(c);
    var cfg = window.HUB_CONFIG || {};
    if (cfg.live && cfg.live.server) return clean(cfg.live.server);
    return typeof HUB_PI === 'string' && HUB_PI ? clean(HUB_PI + ':8097') : '';
  }

  function imgUrl(id, size) {
    return server() + '/photos/img/' + encodeURIComponent(id) + '?size=' + (size === 'thumb' ? 'thumb' : 'full');
  }

  // The Pi's list, cleaned: only items with an id, sizes as numbers.
  function cleanList(data) {
    var out = [];
    var list = data && data.items && data.items.length ? data.items : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || (typeof it.id !== 'string' && typeof it.id !== 'number') || it.id === '') continue;
      out.push({ id: String(it.id), w: +it.w > 0 ? +it.w : 0, h: +it.h > 0 ? +it.h : 0, month: String(it.month || '') });
    }
    return out;
  }

  function load(force) {
    var ctx = S.ctx;
    if (!ctx || S.loading) return;
    var base = server();
    if (!base) { setState(S.items.length ? 'ok' : 'offline'); return; }
    S.loading = true;
    ctx.getJSON(base + '/photos/list', 10000, function (err, data) {
      S.loading = false;
      if (err || !data || typeof data !== 'object') {
        // Keep what is showing; with nothing yet, say the Pi is away.
        if (!S.items.length) setState('offline');
        return;
      }
      if (!force && S.rev !== null && data.rev === S.rev && S.state !== 'offline') return;
      var current = S.items[S.index] ? S.items[S.index].id : null;
      S.rev = data.rev === undefined ? null : data.rev;
      S.items = cleanList(data);
      S.index = 0;
      for (var i = 0; current !== null && i < S.items.length; i++) if (S.items[i].id === current) { S.index = i; break; }
      if (S.viewing >= S.items.length) S.viewing = S.items.length - 1;
      var was = S.state;
      S.state = S.items.length ? 'ok' : 'empty';
      if (was !== S.state || !S.tile || !S.tile.stage) ctx.redrawTile();
      else schedule();
      if (ctx.isOpen()) {
        if (S.viewing >= 0 && S.view) S.view.count.textContent = countText(S.viewing + 1, S.items.length);
        else ctx.redrawPanel();
      }
    });
  }

  function setState(st) {
    if (S.state === st) return;
    S.state = st;
    if (S.ctx) {
      S.ctx.redrawTile();
      if (S.ctx.isOpen()) S.ctx.redrawPanel();
    }
  }

  /* ---------- small helpers ---------- */

  function div(cls, parent, text) {
    var el = document.createElement('div');
    el.className = cls;
    if (text) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }

  function icon(name, cls, parent) {
    var el = div(cls, parent);
    var I = window.HUB_ICONS || {};
    if (I[name]) el.innerHTML = I[name];
    return el;
  }

  function hasClass(el, c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  function addClass(el, c) { if (!hasClass(el, c)) el.className += ' ' + c; }
  function removeClass(el, c) { el.className = (' ' + el.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, ''); }

  function lessMotion() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (e) { /* ignore */ }
    return hasClass(document.body, 'motion-fade');
  }

  function seconds() {
    var s = S.ctx && S.ctx.config ? +S.ctx.config.seconds : 0;
    return s >= 3 ? s : DEFAULT_SECONDS;
  }

  // 'cover' when the photo's shape is close to the frame's (a little is
  // cropped at the edges); 'contain' otherwise, and always for a portrait
  // photo on a landscape frame, so faces are never cut.
  function fitFor(item, fw, fh) {
    if (!item || !item.w || !item.h || !fw || !fh) return 'contain';
    var pa = item.w / item.h;
    var fa = fw / fh;
    if (pa < 1 && fa > 1.05) return 'contain';
    var r = pa / fa;
    return r >= 0.8 && r <= 1.25 ? 'cover' : 'contain';
  }

  /* ---------- a stage: two stacked layers that crossfade ---------- */

  // opts: { fit: 'auto' | 'contain', caption: bool, thumb: bool }
  function makeStage(parent, opts) {
    var el = div('ph-stage', parent);
    var layers = [makeLayer(el, opts), makeLayer(el, opts)];
    var st = { el: el, layers: layers, front: -1, shown: null, want: null, opts: opts };
    return st;
  }

  function makeLayer(parent, opts) {
    var el = div('ph-layer', parent);
    var fill = document.createElement('img');
    fill.className = 'ph-fill';
    fill.alt = '';
    el.appendChild(fill);
    var img = document.createElement('img');
    img.className = 'ph-img';
    img.alt = '';
    el.appendChild(img);
    var cap = null;
    if (opts.caption) {
      var shade = div('ph-cap', el);
      cap = div('ph-cap-text', shade);
    }
    return { el: el, fill: fill, img: img, cap: cap };
  }

  function stageSize(st) {
    var r = st.el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function sizeFor(st) {
    if (st.opts.full) return 'full';
    var z = stageSize(st);
    var dpr = window.devicePixelRatio || 1;
    return Math.max(z.w, z.h) * dpr <= THUMB_PX ? 'thumb' : 'full';
  }

  // Loads url; cb(ok). The image stays in the browser's cache for the layer.
  function preload(url, cb) {
    var im = new Image();
    var done = false;
    var timer = setTimeout(function () { finish(false); }, LOAD_WAIT_MS);
    function finish(ok) { if (done) return; done = true; clearTimeout(timer); im.onload = im.onerror = null; if (cb) cb(ok); }
    im.onload = function () { finish(true); };
    im.onerror = function () { finish(false); };
    im.src = url;
    return im;
  }

  // Shows item on the stage: on the hidden layer once loaded, then fades it
  // in (instant when nothing showed yet). cb(ok) after the swap.
  function show(st, item, cb) {
    if (!item) return;
    st.want = item.id;
    var size = sizeFor(st);
    var url = imgUrl(item.id, size);
    preload(url, function (ok) {
      if (st.want !== item.id || !st.el.parentNode) return;
      if (!ok) { if (cb) cb(false); return; }
      var next = st.front === 0 ? 1 : 0;
      var L = st.layers[next];
      var z = stageSize(st);
      var fit = st.opts.fit === 'contain' ? 'contain' : fitFor(item, z.w, z.h);
      L.el.className = 'ph-layer ph-' + fit;
      L.el.setAttribute('data-id', item.id);
      L.el.setAttribute('data-fit', fit);
      L.img.src = url;
      // The blurred fill: the small image, blurred once by CSS, never animated.
      if (fit === 'contain') L.fill.src = size === 'thumb' ? url : imgUrl(item.id, 'thumb');
      else L.fill.removeAttribute('src');
      if (L.cap) L.cap.textContent = monthLabel(item.month);
      var first = st.front < 0;
      var old = first ? null : st.layers[st.front];
      // Two frames, so the browser has the new layer drawn before it fades.
      if (first || lessMotion()) addClass(st.el, 'is-quick'); else removeClass(st.el, 'is-quick');
      if (first) addClass(st.el, 'is-instant');
      setTimeout(function () {
        addClass(L.el, 'is-on');
        if (old) removeClass(old.el, 'is-on');
        st.front = next;
        st.shown = item.id;
        if (first) setTimeout(function () { removeClass(st.el, 'is-instant'); }, 50);
        if (cb) cb(true);
      }, first ? 0 : 30);
    });
  }

  /* ---------- the tile ---------- */

  function clearTimer() { if (S.timer) { clearTimeout(S.timer); S.timer = null; } }

  function restartBar() {
    var bar = S.tile && S.tile.bar;
    if (!bar) return;
    removeClass(bar, 'is-running');
    bar.style.webkitTransitionDuration = bar.style.transitionDuration = '0s';
    void bar.offsetWidth;
    bar.style.webkitTransitionDuration = bar.style.transitionDuration = seconds() + 's';
    addClass(bar, 'is-running');
  }

  function schedule() {
    clearTimer();
    if (S.state !== 'ok' || S.items.length < 2 || !S.tile || !S.tile.stage) return;
    S.timer = setTimeout(advance, seconds() * 1000);
  }

  function advance() {
    S.timer = null;
    var t = S.tile;
    if (!t || !t.stage || !t.stage.el.parentNode || S.items.length < 2) return;
    // The grid or the viewer is open, or the TV is showing something else: wait.
    if ((S.ctx && S.ctx.isOpen()) || document.hidden) { schedule(); return; }
    var tries = 0;
    (function step() {
      S.index = (S.index + 1) % S.items.length;
      show(t.stage, S.items[S.index], function (ok) {
        if (!ok && ++tries < Math.min(5, S.items.length)) { step(); return; }
        restartBar();
        schedule();
        preloadNext();
      });
    })();
  }

  function preloadNext() {
    var t = S.tile;
    if (!t || !t.stage || S.items.length < 2) return;
    var it = S.items[(S.index + 1) % S.items.length];
    preload(imgUrl(it.id, sizeFor(t.stage)));
  }

  function drawQuiet(body, kind, size) {
    var box = div('ph-quiet ph-quiet-' + kind, body);
    var art = div('ph-quiet-art', box);
    div('ph-quiet-card ph-quiet-back', art);
    var front = div('ph-quiet-card ph-quiet-front', art);
    icon('photo', 'ph-quiet-icon', front);
    if (kind === 'loading') {
      div('ph-quiet-head', box, T('photos.loading', 'Loading photos…'));
      return;
    }
    var head = kind === 'empty' ? T('photos.empty', 'No photos yet') : T('photos.offline', 'Photos live on the Pi');
    var hint = kind === 'empty' ? T('photos.emptyHint', 'Photos friends share will show up here.')
      : T('photos.offlineHint', 'They will show again when the Pi can be reached.');
    div('ph-quiet-head', box, head);
    if (size.cols > 1 && size.rows > 1) div('ph-quiet-hint', box, hint);
  }

  function renderTile(body, ctx) {
    clearTimer();
    var size = ctx.size ? ctx.size() : { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
    body.className = 'tile-body ph-tile' + (size.cols === 1 ? ' ph-tile-one' : '') + (size.tier === 'strip' ? ' ph-tile-strip' : '');
    var tile = body.parentNode;
    if (tile && tile.className) addClass(tile, 'ph-host');
    var frame = div('ph-frame', body);
    S.tile = { body: body, frame: frame, stage: null, bar: null };
    if (S.state !== 'ok' || !S.items.length) {
      addClass(frame, 'ph-frame-quiet');
      // A waiting tile is quiet (motion extras skip it).
      if (S.state === 'loading') addClass(frame, 'hub-dormant');
      drawQuiet(frame, S.state === 'ok' ? 'empty' : S.state, size);
      return;
    }
    var st = makeStage(frame, { fit: 'auto', caption: size.cols > 1 });
    S.tile.stage = st;
    div('ph-rim', frame);
    if (S.items.length > 1) {
      var track = div('ph-bar-track', frame);
      S.tile.bar = div('ph-bar', track);
    }
    if (S.index >= S.items.length) S.index = 0;
    var tries = 0;
    (function first() {
      show(st, S.items[S.index], function (ok) {
        if (!ok && ++tries < Math.min(5, S.items.length)) { S.index = (S.index + 1) % S.items.length; first(); return; }
        restartBar();
        schedule();
        preloadNext();
      });
    })();
  }

  /* ---------- full screen: the grid ---------- */

  function groups() {
    var out = [];
    var last = null;
    for (var i = 0; i < S.items.length; i++) {
      var m = S.items[i].month || '';
      if (!last || last.month !== m) { last = { month: m, list: [] }; out.push(last); }
      last.list.push(i);
    }
    return out;
  }

  function loadThumb(cell) {
    if (!cell || cell.getAttribute('data-loaded')) return;
    cell.setAttribute('data-loaded', '1');
    var img = cell.querySelector('img');
    var id = cell.getAttribute('data-id');
    if (!img || !id) return;
    img.onload = function () { addClass(cell, 'is-loaded'); img.onload = null; };
    img.src = imgUrl(id, 'thumb');
  }

  // Thumbnails in or near the visible part of the panel body.
  function loadVisible(body) {
    if (!body) return;
    var b = body.getBoundingClientRect();
    var pad = b.height;
    var cells = body.querySelectorAll('.ph-thumb');
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].getAttribute('data-loaded')) continue;
      var r = cells[i].getBoundingClientRect();
      if (r.bottom >= b.top - pad && r.top <= b.bottom + pad) loadThumb(cells[i]);
    }
  }

  var scrollTimer = null;
  function onScroll(e) {
    var body = e.currentTarget || e.target;
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () { scrollTimer = null; loadVisible(body); }, 120);
  }

  function setScroller(body, on) {
    if (!body) return;
    if (on) {
      addClass(body, 'ph-scroll');
      if (!body.phScroll) { body.addEventListener('scroll', onScroll); body.phScroll = true; }
    } else {
      removeClass(body, 'ph-scroll');
    }
  }

  function renderGrid(root, ctx, body) {
    var wrap = div('ph-grid', root);
    var gs = groups();
    var n = 0;
    for (var g = 0; g < gs.length; g++) {
      var label = monthLabel(gs[g].month);
      if (label) div('ph-month', wrap, label);
      var row = div('ph-row', wrap);
      for (var j = 0; j < gs[g].list.length; j++) {
        var i = gs[g].list[j];
        var it = S.items[i];
        var cell = div('ph-thumb f', row);
        cell.setAttribute('data-key', 'p:' + it.id);
        cell.setAttribute('data-id', it.id);
        cell.setAttribute('data-i', String(i));
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', T('photos.photoOf', 'Photo from {month}', { month: label || '' }));
        if (it.w && it.h && it.h > it.w) addClass(cell, 'is-portrait');
        var img = document.createElement('img');
        img.alt = '';
        cell.appendChild(img);
        if (i === S.lastThumb) cell.setAttribute('data-autofocus', '1');
        if (n < THUMB_BATCH) loadThumb(cell);
        n++;
      }
    }
    setTimeout(function () { loadVisible(body); }, 0);
  }

  /* ---------- full screen: the viewer ---------- */

  function renderViewer(root, ctx) {
    var it = S.items[S.viewing];
    var v = div('ph-viewer f', root);
    v.setAttribute('data-key', 'viewer');
    v.setAttribute('data-autofocus', '1');
    var st = makeStage(v, { fit: 'contain', caption: false, full: true });
    div('ph-rim', v);
    var prev = div('ph-nav ph-nav-prev', v);
    icon('back', 'ph-nav-icon', prev);
    var next = div('ph-nav ph-nav-next', v);
    icon('back', 'ph-nav-icon', next);
    var foot = div('ph-view-foot', v);
    var month = div('ph-view-month', foot, monthLabel(it.month));
    var count = div('ph-view-count', foot, countText(S.viewing + 1, S.items.length));
    div('ph-view-tip', foot, T('photos.tipView', 'Left and right for more'));
    S.view = { stage: st, month: month, count: count };
    // A tap on the left or right half goes back or on (the hub's own click
    // would only press OK, which goes on).
    st.el.parentNode.addEventListener('click', function (e) {
      e.stopPropagation();
      var r = v.getBoundingClientRect();
      var x = (e.clientX || 0) - r.left;
      step(x < r.width / 2 ? -1 : 1);
    });
    show(st, it, function () { preloadAround(); });
  }

  function preloadAround() {
    var n = S.items.length;
    if (n < 2) return;
    preload(imgUrl(S.items[(S.viewing + 1) % n].id, 'full'));
    preload(imgUrl(S.items[(S.viewing - 1 + n) % n].id, 'full'));
  }

  function step(dir) {
    var n = S.items.length;
    if (S.viewing < 0 || !S.view || n < 1) return;
    S.viewing = (S.viewing + dir + n) % n;
    S.lastThumb = S.viewing;
    var it = S.items[S.viewing];
    S.view.month.textContent = monthLabel(it.month);
    S.view.count.textContent = countText(S.viewing + 1, n);
    show(S.view.stage, it, function () { preloadAround(); });
  }

  function renderPanel(body, ctx) {
    S.view = null;
    var full = ctx.mode && ctx.mode() === 'full';
    var root = div('ph-panel' + (full ? ' is-full' : ''), body);
    if (S.state !== 'ok' || !S.items.length) {
      setScroller(body, false);
      S.viewing = -1;
      var box = div('ph-panel-quiet', root);
      drawQuiet(box, S.state === 'ok' ? 'empty' : S.state, { cols: 6, rows: 4 });
      ctx.setSub('');
      return;
    }
    ctx.setSub(totalText(S.items.length));
    if (S.viewing >= 0 && S.viewing < S.items.length) {
      setScroller(body, false);
      addClass(root, 'is-viewing');
      renderViewer(root, ctx);
    } else {
      S.viewing = -1;
      setScroller(body, true);
      renderGrid(root, ctx, body);
    }
  }

  function closeViewer(ctx) {
    S.viewing = -1;
    ctx.redrawPanel();
  }

  /* ---------- the widget ---------- */

  var widget = {
    id: 'photos',
    icon: 'photo',
    head: false,
    openMode: 'full',

    init: function (ctx) {
      S.ctx = ctx;
      var L = I18N();
      if (L && typeof L.onChange === 'function') {
        L.onChange(function () {
          // Captions follow the language; the photo stays.
          var t = S.tile;
          if (t && t.stage) {
            for (var i = 0; i < t.stage.layers.length; i++) {
              var lay = t.stage.layers[i];
              var id = lay.el.getAttribute('data-id');
              if (!lay.cap || !id) continue;
              for (var j = 0; j < S.items.length; j++) if (S.items[j].id === id) { lay.cap.textContent = monthLabel(S.items[j].month); break; }
            }
          } else {
            ctx.redrawTile();
          }
          if (ctx.isOpen()) ctx.redrawPanel();
        });
      }
      load(true);
      setInterval(function () { load(false); }, REFRESH_MS);
      if (ctx.live && typeof ctx.live.on === 'function') ctx.live.on('photos', function () { load(false); });
      // Back on screen after a while away: pick up where it was.
      try {
        document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(); });
      } catch (e) { /* ignore */ }
    },

    renderTile: function (body, ctx) {
      try {
        renderTile(body, ctx);
      } catch (e) {
        if (window.console && console.warn) console.warn('Photo album: ' + (e && e.message));
        body.innerHTML = '';
        drawQuiet(div('ph-frame ph-frame-quiet', body), 'offline', { cols: 1, rows: 1 });
      }
    },

    renderPanel: function (body, ctx) { renderPanel(body, ctx); },

    onSelect: function (target, ctx) {
      if (!target) return;
      if (hasClass(target, 'ph-viewer')) { step(1); return; }
      var i = parseInt(target.getAttribute('data-i'), 10);
      if (i >= 0 && i < S.items.length) {
        S.viewing = i;
        S.lastThumb = i;
        ctx.redrawPanel();
      }
    },

    onFocus: function (target) {
      if (target && hasClass(target, 'ph-thumb')) {
        S.lastThumb = parseInt(target.getAttribute('data-i'), 10);
        var body = target.parentNode;
        while (body && !hasClass(body, 'panel-body')) body = body.parentNode;
        loadVisible(body);
      }
    },

    onMove: function (dir, from) {
      if (from && hasClass(from, 'ph-viewer')) {
        if (dir === 'left') step(-1);
        else if (dir === 'right') step(1);
        return true;
      }
    },

    onBack: function (ctx) {
      if (S.viewing >= 0) { closeViewer(ctx); return true; }
      return false;
    },

    backHint: function () {
      return S.viewing >= 0 ? T('photos.backGrid', 'Back for all photos') : null;
    },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },

    onClose: function (ctx) {
      S.viewing = -1;
      S.view = null;
      var body = document.querySelector('#panel .panel-body');
      setScroller(body, false);
      schedule();
    }
  };

  try {
    Object.defineProperty(widget, 'title', { get: title, enumerable: true, configurable: true });
    Object.defineProperty(widget, 'shortTitle', { get: shortTitle, enumerable: true, configurable: true });
  } catch (e) {
    widget.title = 'Photo album';
  }

  // For the tests (dev/photos-test.js).
  window.HUB_PHOTOS = {
    fitFor: fitFor,
    monthLabel: monthLabel,
    cleanList: cleanList,
    server: server,
    state: function () { return { state: S.state, index: S.index, count: S.items.length, rev: S.rev, viewing: S.viewing }; },
    advance: function () { clearTimer(); advance(); },
    reload: function () { load(true); },
    refresh: function () { load(false); }
  };

  return widget;
})());
