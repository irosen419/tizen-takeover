/*
 * Entertainment: the app launcher. Streaming apps, TizenTube, the Xbox
 * (through Home Assistant), dashboards and the list of every app on the TV.
 * Items come from HUB_CONFIG.widgets.entertainment.sections.
 *
 * Two more views in the same panel: the Schedule of TV shows (a "schedule"
 * item; drawn by app/widgets/shows.js) and the watch link test (opened from
 * the About panel; drawn by app/widgets/linktest.js). Back returns to the
 * grid from either.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var TIZENBREW_WS = 'ws://127.0.0.1:8081';
  var TILE_CHIPS = 6;       // logo chips on the home tile before "+N"

  var C = null;             // ctx, kept from init
  var sections = [];        // [{ label, items: [item] }]
  var items = [];           // every item, flat: { cfg, key, appId }
  var apps = null;          // [{ id, name, hidden }] once loaded
  var lookupFailed = false;
  var view = 'grid';        // grid | list | schedule | linktests
  var lastKey = null;       // last focused item, so reopening lands on it
  var gridCache = null;     // the grid's DOM, built once: { grid, nodes: [{ item, node, state }] }

  /* ---------- small DOM helpers ---------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  // A square app icon: .logo keeps the square (padding-top: 100%), .logo-face
  // holds the color, the glyph and the sheen.
  function logoEl(cfg, cls) {
    var node = el('span', 'logo' + (cls ? ' ' + cls : ''));
    var face = el('span', 'logo-face');
    node.appendChild(face);
    var logos = typeof HUB_LOGOS !== 'undefined' ? HUB_LOGOS : null;
    var logo = logos && cfg.logo ? logos[cfg.logo] : null;
    if (logo && logo.svg) {
      face.style.background = logo.bg || '#1b1e26';
      face.innerHTML = logo.svg;
    } else {
      node.className += ' logo-mono';
      face.appendChild(el('span', 'logo-text', (cfg.label || '?').charAt(0).toUpperCase()));
    }
    return node;
  }

  function textIcon(text, cls) {
    var node = el('span', 'logo logo-mono' + (cls ? ' ' + cls : ''));
    var face = el('span', 'logo-face');
    face.appendChild(el('span', 'logo-text', text));
    node.appendChild(face);
    return node;
  }

  /* ---------- home tile ---------- */

  // How many logo chips fit the tile body: per row (never so many that a
  // chip is smaller than MIN_CHIP) and, unless it is a strip, how many rows
  // and how big (face, px; 0 leaves it to the CSS).
  var MIN_CHIP = 3.4;       // rem, a chip in a two-row or taller tile
  var NARROW_CHIP = 2.6;    // rem, the same in a tile one or two columns wide
  var STRIP_CHIP = 3.4;     // rem, every chip in a one-row strip
  var MAX_CHIP = 5.2;       // rem
  var CHIP_GAP = 0.6;       // rem, like .ent-chip's margin-right
  var STRIP_GAP = 0.5;

  function chipFit(body, ctx) {
    var size = ctx && ctx.size ? ctx.size() : null;
    var rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 24;
    var strip = !!size && size.tier === 'strip';
    var chip = (strip ? STRIP_CHIP : size && size.width === 'narrow' ? NARROW_CHIP : MIN_CHIP) * rem;
    var gap = (strip ? STRIP_GAP : CHIP_GAP) * rem;
    var w = body.clientWidth;
    var h = body.clientHeight;
    if (!w) {
      // Not laid out (hidden): guess from the grid, 80rem by 45rem.
      var cols = size ? size.cols : 6;
      w = (cols * 78.5 / 12 - 3.2) * rem;
      h = ((size ? size.rows : 2) * 43.5 / 6 - 3.2) * rem;
    }
    var perRow = Math.max(1, Math.min(TILE_CHIPS + 1, Math.floor((w + gap) / (chip + gap))));
    var fit = { perRow: perRow, rows: 1, face: 0 };
    if (strip) return fit;
    // One row is the usual look. More rows of smaller logos only when they
    // clearly cover more of the tile (count x size squared, a quarter more),
    // as in a narrow or a tall tile.
    var oneFace = Math.min(MAX_CHIP * rem, (w - gap * (perRow - 1)) / perRow);
    var bestScore = Math.min(perRow, items.length) * oneFace * oneFace;
    for (var p = 1; p <= TILE_CHIPS + 1; p++) {
      var faceW = (w - gap * (p - 1)) / p;
      if (faceW < chip) break;
      for (var r = 2; r <= 6; r++) {
        var face = Math.min(MAX_CHIP * rem, faceW, (h - gap * (r - 1)) / r);
        if (face < chip) break;
        var score = Math.min(p * r, items.length) * face * face;
        if (score > bestScore * 1.25) {
          bestScore = score;
          fit = { perRow: p, rows: r, face: face };
        }
        if (p * r >= items.length) break;
      }
    }
    return fit;
  }

  /* ---------- what's on (from the Schedule) ---------- */

  // Per app label, how many of the owner's shows have something to watch
  // now (out this week, or later today): {} without the Schedule.
  function availability() {
    try { return window.HUB_SHOWS && typeof HUB_SHOWS.availability === 'function' ? HUB_SHOWS.availability() || {} : {}; } catch (e) { return {}; }
  }

  // The one count badge, on a logo: how many shows have something to watch
  // in this app. Used by the tile, the panel and full screen.
  function putBadge(logo, n) {
    var old = logo.querySelector('.ent-count');
    if (old) logo.removeChild(old);
    if (n) logo.appendChild(el('span', 'ent-count', String(n)));
  }

  // The tile's order: apps with something to watch first (most first), the
  // rest as in config.js. Only app items count; a sort that keeps ties stable.
  function tileOrder(avail) {
    var list = [];
    for (var i = 0; i < items.length; i++) {
      var n = items[i].cfg.kind === 'app' && avail.hasOwnProperty(items[i].cfg.label) ? avail[items[i].cfg.label] : 0;
      list.push({ item: items[i], n: n, at: i });
    }
    list.sort(function (a, b) { return (b.n - a.n) || (a.at - b.at); });
    return list;
  }

  /* ---------- items ---------- */

  function buildItems() {
    var conf = (C && C.config.sections) || [];
    sections = [];
    items = [];
    for (var s = 0; s < conf.length; s++) {
      if (!conf[s] || !conf[s].items || !conf[s].items.length) continue;
      var sec = { label: conf[s].label || '', items: [] };
      for (var i = 0; i < conf[s].items.length; i++) {
        var item = { cfg: conf[s].items[i], key: 'item' + items.length, appId: null };
        sec.items.push(item);
        items.push(item);
      }
      sections.push(sec);
    }
  }

  function itemByKey(key) {
    for (var i = 0; i < items.length; i++) if (items[i].key === key) return items[i];
    return null;
  }

  // What the small line under an item says, and whether it's dimmed.
  function stateOf(item) {
    var cfg = item.cfg;
    if (cfg.kind === 'schedule' && window.HUB_SHOWS) return { text: HUB_SHOWS.entry().sub, missing: false };
    if (cfg.kind !== 'app') return { text: cfg.sub || '', missing: false };
    if (item.appId) return { text: cfg.sub || '', missing: false };
    if (!apps) return { text: lookupFailed ? 'Couldn’t check' : 'Looking for it', missing: false };
    return { text: 'Not installed', missing: true };
  }

  /* ---------- app lookup ---------- */

  function findApp(match) {
    if (!apps || !match) return null;
    // Exact names beat partial ones. Visible apps beat hidden built-ins
    // (Samsung TV Plus can be one of those).
    return exactIn(match, false) || exactIn(match, true) ||
      containsIn(match, false) || containsIn(match, true);
  }

  function exactIn(match, hidden) {
    for (var i = 0; i < match.length; i++) {
      var m = match[i].toLowerCase();
      for (var j = 0; j < apps.length; j++) {
        if (!!apps[j].hidden === hidden && (apps[j].name || '').toLowerCase() === m) return apps[j];
      }
    }
    return null;
  }

  function containsIn(match, hidden) {
    for (var i = 0; i < match.length; i++) {
      var m = match[i].toLowerCase();
      var best = null;
      for (var j = 0; j < apps.length; j++) {
        var lower = (apps[j].name || '').toLowerCase();
        if (!!apps[j].hidden !== hidden || lower.indexOf(m) === -1) continue;
        if (!best || lower.length < best.name.length) best = apps[j];
      }
      if (best) return best;
    }
    return null;
  }

  function resolveItems() {
    for (var i = 0; i < items.length; i++) {
      if (items[i].cfg.kind !== 'app') continue;
      var found = findApp(items[i].cfg.match);
      items[i].appId = found ? found.id : null;
    }
    refresh();
  }

  function refresh() {
    C.redrawTile();
    if (C.isOpen()) C.redrawPanel();
  }

  function loadApps(attempt) {
    attempt = attempt || 1;
    if (C.hasTizen && attempt === 1) {
      try {
        tizen.application.getAppsInfo(function (infos) {
          apps = [];
          for (var i = 0; i < infos.length; i++) {
            apps.push({ id: infos[i].id, name: infos[i].name, hidden: infos[i].show === false });
          }
          resolveItems();
        }, function () { loadApps(2); });
        return;
      } catch (e) { /* fall through to the service */ }
    }
    // The service starts a moment after the page, so keep trying for a while.
    C.service('/apps', 4000, function (err, data) {
      if (!err) { apps = data.apps || []; resolveItems(); return; }
      if (attempt < 25) return setTimeout(function () { loadApps(attempt + 1); }, 800);
      lookupFailed = true;
      refresh();
      C.toast('Couldn’t read the app list (' + err + '). Try closing and reopening the hub.', 6000);
    });
  }

  /* ---------- actions ---------- */

  // The bloom of the app being opened, if any: it goes when the app can't open.
  var launchBloom = null;

  function unbloom() {
    if (launchBloom) { try { launchBloom.cancel(); } catch (e) { /* gone */ } }
    launchBloom = null;
  }

  // An app control (the watch link test, and deep links later): the page's
  // own tizen API when it has one, otherwise service.js. c: { id, op, uri,
  // key, val }; cb(err) with err null when the TV took it.
  function launchControl(c, cb) {
    function viaService() {
      var q = '/launch-control?id=' + encodeURIComponent(c.id) + '&op=' + encodeURIComponent(c.op) +
        (c.uri ? '&uri=' + encodeURIComponent(c.uri) : '') +
        (c.key ? '&key=' + encodeURIComponent(c.key) + '&val=' + encodeURIComponent(c.val || '') : '');
      C.service(q, 8000, function (err) { cb(err || null); });
    }
    if (C.hasTizen && window.tizen && tizen.ApplicationControl) {
      try {
        var data = c.key ? [new tizen.ApplicationControlData(c.key, [c.val || ''])] : null;
        tizen.application.launchAppControl(new tizen.ApplicationControl(c.op, c.uri || null, null, null, data), c.id,
          function () { cb(null); }, viaService);
        return;
      } catch (e) { /* fall back */ }
    }
    viaService();
  }

  // The names to find an app by, from the Entertainment item with this label.
  function matchFor(label) {
    for (var i = 0; i < items.length; i++) {
      var cfg = items[i].cfg;
      if (cfg.kind === 'app' && cfg.label === label && cfg.match && cfg.match.length) return cfg.match.slice();
    }
    return null;
  }

  // What shows.js and linktest.js use to find and open apps.
  var host = {
    findApp: function (match) { return findApp(match); },
    appsReady: function () { return !!apps; },
    launch: function (id, label) { launchById(id, label); },
    launchControl: function (c, cb) { launchControl(c, cb); },
    matchFor: matchFor
  };

  function launchById(id, label) {
    function viaService() {
      C.service('/launch?id=' + encodeURIComponent(id), 8000, function (err) {
        if (err) { unbloom(); C.toast('Couldn’t open ' + label + ' (' + err + ').', 5000); }
      });
    }
    if (C.hasTizen) {
      try {
        tizen.application.launch(id, function () {}, viaService);
        return;
      } catch (e) { /* fall back */ }
    }
    viaService();
  }

  function openTizenBrewModule(pattern, label) {
    var ws;
    var handled = false;
    var timer = setTimeout(function () {
      if (handled) return;
      handled = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      unbloom();
      C.toast('TizenBrew didn’t answer, so ' + label + ' couldn’t open.', 5000);
    }, 7000);

    try {
      ws = new WebSocket(TIZENBREW_WS);
    } catch (e) {
      clearTimeout(timer);
      unbloom();
      return C.toast('Couldn’t reach TizenBrew.', 4000);
    }

    ws.onopen = function () { ws.send(JSON.stringify({ type: 4, payload: false })); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== 4 || handled) return;
      if (!msg.payload) { ws.send(JSON.stringify({ type: 4, payload: true })); return; }

      var mod = null;
      for (var i = 0; i < msg.payload.length; i++) {
        if (pattern.test(msg.payload[i].appName || '') || pattern.test(msg.payload[i].fullName || '')) {
          mod = msg.payload[i];
          break;
        }
      }
      handled = true;
      clearTimeout(timer);
      if (!mod) { unbloom(); return C.toast(label + ' isn’t added in TizenBrew.', 4000); }

      // Same two steps TizenBrew's own menu takes when you pick a module.
      C.registerKeys(mod.keys);
      ws.send(JSON.stringify({ type: 5, payload: mod }));
      setTimeout(function () { location.href = mod.appPath; }, 200);
    };
    ws.onerror = function () {
      if (handled) return;
      handled = true;
      clearTimeout(timer);
      unbloom();
      C.toast('Couldn’t reach TizenBrew.', 4000);
    };
  }

  function pressInputKey(tc) {
    C.toast('Switching to ' + (tc.sub || tc.label) + '. If the TV asks, choose Allow.', 6000);
    C.service('/key?k=' + encodeURIComponent(tc.key), 170000, function (err) {
      if (err) C.toast('Couldn’t switch input. ' + err, 15000);
    });
  }

  function callWebhook(tc) {
    if (!tc.url) return C.toast(tc.hint || (tc.label + ' has no webhook address yet. Add one in config.js.'), 8000);
    C.toast((tc.busy || 'Working on it') + '…', 4000);
    C.service('/webhook?url=' + encodeURIComponent(tc.url), 15000, function (err) {
      if (err) C.toast('Couldn’t reach Home Assistant. ' + err, 10000);
    });
  }

  function activate(item) {
    var tc = item.cfg;
    if (tc.kind === 'app') {
      if (!apps) return C.toast('Still looking for your apps. Try again in a second.');
      if (!item.appId) return C.toast(tc.label + ' isn’t on this TV. Open All apps to see what is.', 4500);
      return launchById(item.appId, tc.label);
    }
    if (tc.kind === 'tizentube') return openTizenBrewModule(/tizentube/i, tc.label);
    if (tc.kind === 'input') return pressInputKey(tc);
    if (tc.kind === 'dashboard') return C.openFrame(tc.url);
    if (tc.kind === 'webhook') return callWebhook(tc);
    if (tc.kind === 'allApps') return openList(item);
    if (tc.kind === 'schedule') return openView('schedule', item);
  }

  /* ---------- Schedule and the watch link test ---------- */

  function viewTitle(name) {
    if (name === 'schedule' && window.HUB_SHOWS) return HUB_SHOWS.title();
    if (name === 'linktests' && window.HUB_LINKTEST) return HUB_LINKTEST.title();
    return '';
  }

  function openView(name, item) {
    if (name === 'schedule' && !window.HUB_SHOWS) return C.toast('The schedule didn’t load. Try closing and reopening the hub.', 5000);
    if (name === 'linktests' && !window.HUB_LINKTEST) return C.toast('The watch link test didn’t load.', 5000);
    view = name;
    if (item) lastKey = item.key;
    C.setSub(viewTitle(name));
    if (C.isOpen()) C.redrawPanel();
  }

  // The tile's small line: "Tonight: Stick 8 PM" when something airs today.
  function tileSub() {
    var line = '';
    try { line = window.HUB_SHOWS ? HUB_SHOWS.tileLine() : ''; } catch (e) { line = ''; }
    C.setTileSub(line || (C.config && C.config.sub) || '');
  }

  /* ---------- all apps list ---------- */

  function openList(item) {
    if (!apps) return C.toast('Still looking for your apps. Try again in a second.');
    view = 'list';
    lastKey = item.key;
    C.setSub('All apps');
    C.redrawPanel();
  }

  function closeList() {
    view = 'grid';
    C.setSub(C.config.sub || '');
    C.redrawPanel();
  }

  function renderList(body) {
    // Your apps first, then hidden built-in ones at the bottom.
    var sorted = apps.slice().sort(function (a, b) {
      if (!!a.hidden !== !!b.hidden) return a.hidden ? 1 : -1;
      return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
    });
    var list = el('div', 'ent-list');
    for (var i = 0; i < sorted.length; i++) {
      var row = el('div', 'ent-row f');
      row.setAttribute('data-key', 'app:' + sorted[i].id);
      row.setAttribute('data-id', sorted[i].id);
      row.setAttribute('data-name', sorted[i].name || sorted[i].id);
      if (i === 0) row.setAttribute('data-autofocus', '');
      row.appendChild(el('span', 'ent-row-name', sorted[i].name || sorted[i].id));
      row.appendChild(el('span', 'ent-row-id', sorted[i].id + (sorted[i].hidden ? ' (hidden)' : '')));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  /* ---------- grid ---------- */

  // Built once (parsing the logo SVGs is slow on the TV) and kept; each
  // render only updates what can change. Built without whitespace text
  // nodes, so inline-block items sit flush.
  function buildGrid() {
    if (gridCache) return gridCache;
    var grid = el('div', 'ent-grid');
    var nodes = [];
    for (var s = 0; s < sections.length; s++) {
      var sec = el('div', 'ent-section' + (s === 0 ? ' is-first' : ''));
      sec.appendChild(el('div', 'ent-section-label', sections[s].label));
      for (var i = 0; i < sections[s].items.length; i++) {
        var item = sections[s].items[i];
        var node = el('div', 'ent-item f');
        node.setAttribute('data-key', item.key);
        var iconWrap = el('div', 'ent-icon');
        node.icon = iconWrap;
        iconWrap.appendChild(logoEl(item.cfg));
        node.appendChild(iconWrap);
        node.appendChild(el('div', 'ent-name', item.cfg.label));
        var state = el('div', 'ent-state');
        node.appendChild(state);
        sec.appendChild(node);
        nodes.push({ item: item, node: node, state: state });
      }
      grid.appendChild(sec);
    }
    gridCache = { grid: grid, nodes: nodes };
    return gridCache;
  }

  function renderGrid(body) {
    var cache = buildGrid();
    var avail = availability();
    for (var i = 0; i < cache.nodes.length; i++) {
      var n = cache.nodes[i];
      var st = stateOf(n.item);
      // Resetting the class also drops focus and press marks from last time.
      n.node.className = 'ent-item f' + (st.missing ? ' is-missing' : '');
      if (n.state.textContent !== st.text) n.state.textContent = st.text;
      var cnt = n.item.cfg.kind === 'app' && avail.hasOwnProperty(n.item.cfg.label) ? avail[n.item.cfg.label] : 0;
      putBadge(n.node.icon.firstChild, cnt);
      if (n.item.key === lastKey) n.node.setAttribute('data-autofocus', '');
      else n.node.removeAttribute('data-autofocus');
    }
    body.appendChild(cache.grid);
  }

  // Builds the grid ahead of time, while nothing else is going on.
  function prebuild() {
    try { buildGrid(); } catch (e) { /* renderPanel will try again */ }
  }

  /* ---------- widget ---------- */

  return {
    id: 'entertainment',
    title: 'Entertainment',
    // Only when "Entertainment" doesn't fit its tile on one line (hub.js).
    shortTitle: 'Apps',
    icon: 'tv',
    expandable: true,
    stagger: '.ent-item',     // the icons arrive one by one as the panel opens

    init: function (ctx) {
      C = ctx;
      buildItems();
      if (window.HUB_SHOWS) {
        try {
          HUB_SHOWS.attach(ctx, host);
          var tileSig = null;
          HUB_SHOWS.onChange(function () {
            // Redrawn only when its line or counts change (logos are slow to draw).
            var sig = HUB_SHOWS.tileLine() + '|' + JSON.stringify(availability());
            var changed = sig !== tileSig;
            if (changed) { tileSig = sig; C.redrawTile(); }
            // The grid's badges follow the counts; redrawn only when they change.
            if (C.isOpen() && (view === 'schedule' || (view === 'grid' && changed))) C.redrawPanel();
          });
        } catch (e) { /* the grid works without it */ }
      }
      if (window.HUB_LINKTEST) {
        try { HUB_LINKTEST.attach(ctx, host); } catch (e) { /* About says it can't run */ }
      }
      loadApps(1);
      setTimeout(prebuild, 1000);
    },

    renderTile: function (body, ctx) {
      C = ctx;
      tileSub();
      var fit = chipFit(body, ctx);
      // As many logos as fit, the last one "+N" when there are more.
      var room = fit.perRow * fit.rows;
      if (room < 2 && items.length > 1) {
        // No room for logos and "+N": the widget's own icon says what it is.
        var mark = el('span', 'icon ent-tile-mark');
        mark.innerHTML = (window.HUB_ICONS && HUB_ICONS.tv) || '';
        body.appendChild(mark);
        return;
      }
      var shown = items.length <= room ? items.length : room - 1;
      var order = tileOrder(availability());
      var rowEl = null;
      var inRow = 0;
      function nextChip(chip) {
        if (fit.face) chip.style.maxWidth = Math.floor(fit.face) + 'px';
        if (!rowEl || inRow === fit.perRow) {
          rowEl = el('div', 'ent-chips' + (fit.rows > 1 ? ' is-multi' : ''));
          body.appendChild(rowEl);
          inRow = 0;
        }
        rowEl.appendChild(chip);
        inRow++;
      }
      // Each chip is a flex item holding a square icon.
      for (var i = 0; i < shown; i++) {
        var it = order[i].item;
        var chip = el('span', 'ent-chip' + (stateOf(it).missing ? ' is-missing' : '') + (order[i].n ? ' has-count' : ''));
        chip.appendChild(logoEl(it.cfg));
        // Shows with something to watch in this app: a small count on its logo.
        putBadge(chip.firstChild, order[i].n);
        nextChip(chip);
      }
      if (items.length > shown) {
        var more = el('span', 'ent-chip');
        more.appendChild(textIcon('+' + (items.length - shown), 'ent-more'));
        nextChip(more);
      }
      // Several rows: blank chips keep the last row on the same columns.
      while (fit.rows > 1 && rowEl && inRow < fit.perRow) {
        nextChip(el('span', 'ent-chip is-blank'));
      }
    },

    renderPanel: function (body) {
      if (view === 'list' && apps) renderList(body);
      else if (view === 'schedule' && window.HUB_SHOWS) { C.setSub(viewTitle(view)); HUB_SHOWS.renderPanel(body); }
      else if (view === 'linktests' && window.HUB_LINKTEST) { C.setSub(viewTitle(view)); HUB_LINKTEST.renderPanel(body); }
      else { view = 'grid'; renderGrid(body); }
    },

    // The About panel's "Watch link test" opens it here (hub.js openWidgetView).
    openView: function (name) {
      if (name !== 'schedule' && name !== 'linktests') return false;
      openView(name, null);
      return view === name;
    },

    onFocus: function (target) {
      var key = target && target.getAttribute('data-key');
      if (key && key.indexOf('app:') !== 0) lastKey = key;
    },

    // Done on the watch link test's id box.
    onSubmit: function (box) {
      if (view === 'linktests' && window.HUB_LINKTEST && HUB_LINKTEST.onSubmit) return HUB_LINKTEST.onSubmit(box);
      return false;
    },

    onSelect: function (target) {
      var key = target.getAttribute('data-key') || '';
      if (key.indexOf('sh:') === 0 && window.HUB_SHOWS) return HUB_SHOWS.onSelect(target);
      if (key.indexOf('lt:') === 0 && window.HUB_LINKTEST) return HUB_LINKTEST.onSelect(target);
      if (key.indexOf('app:') === 0) return launchById(target.getAttribute('data-id'), target.getAttribute('data-name'));
      var item = itemByKey(key);
      if (!item) return;
      // An app about to open: its icon blooms over the screen (motion extras).
      var tc = item.cfg;
      if (C.bloom && ((tc.kind === 'app' && apps && item.appId) || tc.kind === 'tizentube')) {
        launchBloom = C.bloom(target);
      }
      activate(item);
    },

    onBack: function () {
      if (view === 'linktests' && window.HUB_LINKTEST && HUB_LINKTEST.onBack()) return true;
      if (view === 'grid') return false;
      closeList();
      return true;
    },

    onClose: function (ctx) {
      if (view !== 'grid') {
        view = 'grid';
        ctx.setSub(ctx.config.sub || '');
      }
    }
  };
})());
