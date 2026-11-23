/*
 * Architecture: the map of the whole system (every part of Home Hub, what it
 * is, what it talks to and how far along it is) on the TV, driven by the
 * remote. The same data the Layout Studio's Architecture page draws:
 * studio/architecture/data.json, written for the TV by
 * node studio/build-architecture.js into app/widgets/architecture-data.js
 * (var HUB_ARCH = {...};, about 200 KB with the code map).
 *
 *   tile       a tiny drawn map of the seven Big picture boxes and the status
 *              counts. It needs no data file: the counts and boxes sit in
 *              SUMMARY below, which the build script rewrites (leave the two
 *              markers alone).
 *   full       opens straight to full screen (openMode 'full'); Back closes.
 *              The data file is fetched when the widget is first opened (a
 *              script tag, tried twice), never at boot.
 *
 * Three levels, with a breadcrumb on top and the remote's keys at the bottom:
 *   Big picture   the overview boxes at screen scale, with their arrows. Each
 *                 box has a status bar. Arrows move to the nearest box in
 *                 that direction, OK opens the group. A chip below opens the
 *                 data flows: pick one, then Left and Right step through it.
 *   Group         the parts of a group (or of one part) as cards, with lines
 *                 between parts that talk to each other. Parts with parts say
 *                 "+N parts" and OK goes into them; OK on any other opens
 *                 Details. A "Details" pill on the head opens the drawer for
 *                 the group or part itself.
 *   Details       a drawer on the right (about 40%) over the dimmed diagram:
 *                 status, summary, details, files, the code map (where to start
 *                 reading, from docs/CODE-MAP.md), notes and "Talks to" links
 *                 (OK jumps to that part). Up and Down move through its rows;
 *                 text taller than the drawer scrolls (a transform).
 * Back goes up one level and closes the widget at the Big picture. Focus is
 * remembered per level, so Back lands on the box or card you came from.
 *
 * Plain ES5. Only transform and opacity ever move, and focus changes are
 * instant. Nothing here is sized to English text: text wraps or is clamped
 * with room for accents.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  /* Written by node studio/build-architecture.js from studio/architecture/data.json. */
  /*ARCH-SUMMARY-BEGIN*/
  var SUMMARY = {"asOf":"As of Nov 19, 2026 \u00b7 main is v0.33.1","counts":{"live":126,"unverified":83,"draft":15,"planned":11},"w":1000,"h":620,"boxes":[{"group":"studio","x":40,"y":40,"w":230,"h":110,"counts":{"live":17,"unverified":1,"draft":0,"planned":0}},{"group":"sched","x":40,"y":190,"w":230,"h":110,"counts":{"live":8,"unverified":4,"draft":1,"planned":0}},{"group":"cloud","x":370,"y":40,"w":260,"h":230,"counts":{"live":7,"unverified":1,"draft":2,"planned":0}},{"group":"tv","x":730,"y":40,"w":230,"h":110,"counts":{"live":26,"unverified":36,"draft":3,"planned":3}},{"group":"ext","x":40,"y":330,"w":230,"h":130,"counts":{"live":12,"unverified":16,"draft":3,"planned":7}},{"group":"pi","x":370,"y":330,"w":260,"h":130,"counts":{"live":36,"unverified":25,"draft":6,"planned":1}},{"group":"dev","x":40,"y":510,"w":920,"h":90,"counts":{"live":20,"unverified":0,"draft":0,"planned":0}}]};
  /*ARCH-SUMMARY-END*/

  var DATA_URL = 'widgets/architecture-data.js';

  var STATUSES = [
    { id: 'live', name: 'Live' },
    { id: 'unverified', name: 'Unverified' },
    { id: 'draft', name: 'Draft' },
    { id: 'planned', name: 'Planned' }
  ];
  // The Studio's colors on its dark theme.
  var STCOL = { live: '#5bd18d', unverified: '#f0a93a', draft: '#6fb1ff', planned: '#9aa1b0' };
  var GCOL = { tv: '#8d96ff', pi: '#f07aa0', cloud: '#5cc0f2', ext: '#b892ff', sched: '#eaa94a', studio: '#4fd1bd', dev: '#a3adbd' };

  // One drawn icon per kind, on a 24 grid (the Studio's diagram icons).
  var KD = {
    group: '<path d="M12 3.5 20.5 8 12 12.5 3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
    component: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    service: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7.5 7.25h.01M7.5 16.75h.01M11 7.25h5M11 16.75h5"/>',
    data: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
    script: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15.5h4.5"/>',
    test: '<path d="M9.5 3.5h5M10.5 3.5v6L5.2 18.2A1.5 1.5 0 0 0 6.5 20.5h11a1.5 1.5 0 0 0 1.3-2.3L13.5 9.5v-6"/><path d="M7.6 14.5h8.8"/>',
    external: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/>',
    task: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8M9.5 3h5"/>',
    doc: '<path d="M4.5 5.5c2.5-1.3 5-1.3 7.5 0v14c-2.5-1.3-5-1.3-7.5 0z"/><path d="M12 5.5c2.5-1.3 5-1.3 7.5 0v14c-2.5-1.3-5-1.3-7.5 0z"/>'
  };
  var SVGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  function kindIcon(k) { return SVGO + (KD[k] || KD.component) + '</svg>'; }
  var CHEV = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 2.5 8 6l-4 3.5"/></svg>';
  var ARROWS = {
    out: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.5 8h11M9.5 4l4 4-4 4"/></svg>',
    'in': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13.5 8h-11M6.5 4l-4 4 4 4"/></svg>',
    both: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 8h12M5 4.8 2 8l3 3.2M11 4.8 14 8l-3 3.2"/></svg>'
  };

  // The Studio's status shapes: filled, half, diamond, dashed (shape as well as color).
  function stShape(s) {
    var b = '<svg class="ar-st s-' + s + '" viewBox="0 0 14 14" aria-hidden="true" focusable="false">';
    if (s === 'live') return b + '<circle cx="7" cy="7" r="5" fill="currentColor"/></svg>';
    if (s === 'unverified') return b + '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 2.6a4.4 4.4 0 0 0 0 8.8z" fill="currentColor"/></svg>';
    if (s === 'draft') return b + '<path d="M7 1.8 12.2 7 7 12.2 1.8 7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.4" fill="currentColor"/></svg>';
    return b + '<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>';
  }
  function stName(s) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === s) return STATUSES[i].name;
    return '';
  }

  /* ---------- small helpers ---------- */

  function div(cls, parent, text) {
    var n = document.createElement('div');
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function span(cls, parent, text) {
    var n = document.createElement('span');
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function html(cls, parent, markup, tag) {
    var n = document.createElement(tag || 'span');
    if (cls) n.className = cls;
    n.innerHTML = markup;
    if (parent) parent.appendChild(n);
    return n;
  }
  function remPx() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 24; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function setClass(el, name, on) {
    var has = (' ' + el.className + ' ').indexOf(' ' + name + ' ') >= 0;
    if (on && !has) el.className += ' ' + name;
    if (!on && has) el.className = (' ' + el.className + ' ').replace(' ' + name + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }
  function svgClass(el, name, on) {
    var c = el.getAttribute('class') || '';
    var has = (' ' + c + ' ').indexOf(' ' + name + ' ') >= 0;
    if (on && !has) el.setAttribute('class', c ? c + ' ' + name : name);
    if (!on && has) el.setAttribute('class', (' ' + c + ' ').replace(' ' + name + ' ', ' ').replace(/^\s+|\s+$/g, ''));
  }

  /* ---------- the tile (no data file needed) ---------- */

  function statusBarMarkup(counts, x, y, w, h) {
    var total = 0, i, out = '';
    for (i = 0; i < STATUSES.length; i++) total += counts[STATUSES[i].id] || 0;
    if (!total) return '';
    var at = x;
    for (i = 0; i < STATUSES.length; i++) {
      var n = counts[STATUSES[i].id] || 0;
      if (!n) continue;
      var sw = w * n / total;
      out += '<rect x="' + r2(at) + '" y="' + y + '" width="' + r2(sw) + '" height="' + h + '" fill="' + STCOL[STATUSES[i].id] + '"/>';
      at += sw;
    }
    return out;
  }

  function miniMap() {
    var boxes = SUMMARY.boxes || [];
    if (!boxes.length) return null;
    var w = SUMMARY.w || 1000, h = SUMMARY.h || 620;
    var s = '<svg class="ar-mini" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">';
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var col = GCOL[b.group] || '#a4a8b3';
      s += '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="16" fill="' + col + '" fill-opacity="0.2" stroke="' + col + '" stroke-width="7"/>';
      // The status bar sits along the bottom edge, inside the box.
      s += statusBarMarkup(b.counts || {}, b.x + 16, b.y + b.h - 26, b.w - 32, 12);
    }
    return s + '</svg>';
  }

  function renderTile(body, ctx) {
    var size = ctx && ctx.size ? ctx.size() : { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
    body.className = 'tile-body ar-tile ar-tile-' + size.tier;
    body.innerHTML = '';
    var map = miniMap();
    var counts = SUMMARY.counts || {};
    if (map) html('ar-tile-map', body, map, 'div');
    // A one-row tile three columns wide or less has room for the map alone.
    if (size.cols > 1 && !(size.tier === 'strip' && size.cols <= 3)) {
      var list = div('ar-tile-counts', body);
      for (var i = 0; i < STATUSES.length; i++) {
        var n = counts[STATUSES[i].id];
        if (n === undefined) continue;
        var chip = span('ar-tile-count', list);
        chip.innerHTML = stShape(STATUSES[i].id);
        span('ar-tile-num', chip, String(n));
        span('ar-tile-name', chip, STATUSES[i].name.toLowerCase());
      }
    }
    if (!map && !body.firstChild) div('ar-none', body, 'Every part of Home Hub');
  }

  /* ---------- the data, loaded when the widget first opens ---------- */

  var dataState = 'none';       // none, loading, ready, failed
  var tries = 0;
  var waiters = [];
  var D = null;                 // HUB_ARCH
  var byId = {};
  var parentOf = {};
  var rootIds = [];
  var flowById = {};
  var total = { live: 0, unverified: 0, draft: 0, planned: 0 };

  function prepare(d) {
    D = d;
    byId = {}; parentOf = {}; rootIds = []; flowById = {};
    total = { live: 0, unverified: 0, draft: 0, planned: 0 };
    function walk(n, p) {
      byId[n.id] = n;
      parentOf[n.id] = p;
      if (total.hasOwnProperty(n.status)) total[n.status]++;
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i], n.id);
    }
    for (var i = 0; i < d.tree.length; i++) { rootIds.push(d.tree[i].id); walk(d.tree[i], null); }
    var f = d.flows || [];
    for (var j = 0; j < f.length; j++) flowById[f[j].id] = f[j];
  }

  function finishLoad(ok) {
    var list = waiters;
    waiters = [];
    dataState = ok ? 'ready' : 'failed';
    for (var i = 0; i < list.length; i++) {
      try { list[i](ok); } catch (e) { /* the next draw shows the state */ }
    }
  }

  function attempt() {
    var head = document.getElementsByTagName('head')[0] || document.documentElement;
    var script = document.createElement('script');
    var settled = false;
    function bad() {
      if (settled) return;
      settled = true;
      script.onload = script.onerror = null;
      if (script.parentNode) script.parentNode.removeChild(script);
      tries += 1;
      if (tries < 2) setTimeout(attempt, 700);      // one more go, then say so
      else finishLoad(false);
    }
    script.onload = function () {
      if (settled) return;
      var ok = false;
      try {
        if (window.HUB_ARCH && window.HUB_ARCH.tree && window.HUB_ARCH.tree.length) { prepare(window.HUB_ARCH); ok = true; }
      } catch (e) { ok = false; }
      if (!ok) return bad();
      settled = true;
      finishLoad(true);
    };
    script.onerror = bad;
    script.src = DATA_URL + (tries ? '?retry=' + tries : '');
    head.appendChild(script);
  }

  function ensureData(cb) {
    if (dataState === 'ready') { if (cb) cb(true); return; }
    if (cb) waiters.push(cb);
    if (dataState === 'loading') return;
    if (window.HUB_ARCH && window.HUB_ARCH.tree) {
      try { prepare(window.HUB_ARCH); finishLoad(true); return; } catch (e) { /* load it again */ }
    }
    dataState = 'loading';
    tries = 0;
    attempt();
  }

  /* ---------- where the person is ---------- */

  var S = fresh();
  var C = null;                 // the widget's ctx
  var ROOT = null;              // the drawn page
  var MEM = { big: 'bp:cloud' }; // view key -> data-key last focused there
  var SCR = {};                 // view key -> scroll (px) of that view's canvas

  function fresh() { return { view: 'big', parent: null, node: null, flow: null, step: 0, dscroll: 0 }; }

  function viewKey() {
    if (S.view === 'group') return 'g:' + S.parent;
    return S.view;
  }

  function groupOf(id) {
    var n = id, p;
    while ((p = parentOf[n])) n = p;
    return n;
  }
  function pathOf(id) {
    var a = [];
    var n = id;
    while (n) { a.unshift(n); n = parentOf[n]; }
    return a;
  }
  function gcol(id) { return GCOL[groupOf(id)] || '#a4a8b3'; }
  function titleOf(id) { return byId[id] ? byId[id].title : id; }
  function kidsOf(id) { return (byId[id] && byId[id].children) || []; }

  function counts(n) {
    var c = { live: 0, unverified: 0, draft: 0, planned: 0 };
    (function walk(x) {
      if (c.hasOwnProperty(x.status)) c[x.status]++;
      var k = x.children || [];
      for (var i = 0; i < k.length; i++) walk(k[i]);
    })(n);
    return c;
  }

  // force: a data-key to put focus on afterwards (the hub keeps focus on a same-keyed element otherwise).
  function redraw(force) {
    if (!C) return;
    C.redrawPanel();
    if (!force || !ROOT) return;
    var list = ROOT.querySelectorAll('.f');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-key') === force) { C.focus(list[i]); return; }
    }
  }

  /* ---------- drawing: the frame ---------- */

  function crumbs() {
    var a = [{ t: 'Big picture' }];
    var i;
    if (S.view === 'group') {
      var p = pathOf(S.parent);
      for (i = 0; i < p.length; i++) a.push({ t: titleOf(p[i]), g: i === 0 ? p[0] : null });
    } else if (S.view === 'flows') {
      a.push({ t: 'Data flows' });
    } else if (S.view === 'flow') {
      a.push({ t: 'Data flows' });
      a.push({ t: flowById[S.flow] ? flowById[S.flow].title : '' });
    }
    if (S.node) a.push({ t: titleOf(S.node) });
    return a;
  }

  function drawCrumbs(parent) {
    var bar = div('ar-crumbs', parent);
    var a = crumbs();
    for (var i = 0; i < a.length; i++) {
      if (i) html('ar-sep', bar, CHEV);
      var c = span('ar-crumb' + (i === a.length - 1 ? ' is-last' : ''), bar, a[i].t);
      if (a[i].g && GCOL[a[i].g]) c.style.color = i === a.length - 1 ? '' : GCOL[a[i].g];
    }
  }

  function hintText() {
    if (S.node) return 'Up and Down read  ·  OK follow a link  ·  Back close';
    if (S.view === 'big') return 'Arrow keys move  ·  OK open  ·  Back close';
    if (S.view === 'flow') return 'Left and Right step  ·  OK show the part  ·  Back up';
    return 'Arrow keys move  ·  OK open  ·  Back up';
  }

  function drawLegend(parent) {
    var lg = div('ar-legend', parent);
    for (var i = 0; i < STATUSES.length; i++) {
      var it = span('ar-lg s-' + STATUSES[i].id, lg);
      it.innerHTML = stShape(STATUSES[i].id);
      span('ar-lg-name', it, STATUSES[i].name);
      span('ar-lg-num', it, String(total[STATUSES[i].id]));
    }
  }

  function drawBottom(parent) {
    var bot = div('ar-bottom', parent);
    div('ar-hint', bot, hintText());
    if (D && D.asOf) div('ar-asof', bot, D.asOf);
  }

  /* ---------- drawing: Big picture ---------- */

  function statusBar(parent, c, cls) {
    var bar = div('ar-sbar' + (cls ? ' ' + cls : ''), parent);
    var t = 0, i;
    for (i = 0; i < STATUSES.length; i++) t += c[STATUSES[i].id] || 0;
    if (!t) return bar;
    for (i = 0; i < STATUSES.length; i++) {
      var n = c[STATUSES[i].id] || 0;
      if (!n) continue;
      var seg = div('ar-sseg s-' + STATUSES[i].id, bar);
      seg.style.width = (n * 100 / t).toFixed(2) + '%';
    }
    return bar;
  }

  // The bottom row (boxes below every other box, Tests, tools and docs) sits
  // centered between the lowest box above it, as drawn, and the map's bottom,
  // so it never runs into the Data flows row under the map. Boxes grow with
  // their text, so this measures them rather than trusting the data's heights.
  function centerBottomRow(map, boxes, els, rem) {
    var i, j, low = [], above = 0;
    for (i = 0; i < boxes.length; i++) {
      var under = true;
      for (j = 0; j < boxes.length; j++) {
        if (j !== i && boxes[j].y + boxes[j].h > boxes[i].y) { under = false; break; }
      }
      if (under) low.push(i);
    }
    if (!low.length || low.length === boxes.length) return;
    for (i = 0; i < els.length; i++) {
      if (low.indexOf(i) < 0) above = Math.max(above, els[i].offsetTop + els[i].offsetHeight);
    }
    var room = map.clientHeight;
    if (!(room > above) || !(rem > 0)) return;
    for (i = 0; i < low.length; i++) {
      var el = els[low[i]];
      var top = above + Math.max(0, (room - above - el.offsetHeight) / 2);
      el.style.top = r2(top / rem) + 'rem';
    }
  }

  function arrowHead(x, y, dx, dy, size) {
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    var bx = x - ux * size, by = y - uy * size;
    var px = -uy * size * 0.55, py = ux * size * 0.55;
    return '<polygon points="' + r2(x) + ',' + r2(y) + ' ' + r2(bx + px) + ',' + r2(by + py) + ' ' + r2(bx - px) + ',' + r2(by - py) + '"/>';
  }

  function drawBig(main) {
    var o = D.overview || { boxes: [], edges: [] };
    var map = div('ar-map', main);
    var chips = div('ar-chips', main);
    var rem = remPx();
    var W = map.clientWidth / rem;
    var H = map.clientHeight / rem;
    if (!(W > 20)) W = 72;
    if (!(H > 10)) H = 26;
    // Fit the boxes (not the empty canvas margin) to the room, wider than tall.
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, i;
    for (i = 0; i < o.boxes.length; i++) {
      minX = Math.min(minX, o.boxes[i].x); maxX = Math.max(maxX, o.boxes[i].x + o.boxes[i].w);
      minY = Math.min(minY, o.boxes[i].y); maxY = Math.max(maxY, o.boxes[i].y + o.boxes[i].h);
    }
    var pad = 0.35;
    var sx = (W - 2 * pad) / Math.max(1, maxX - minX);
    var sy = (H - 2 * pad) / Math.max(1, maxY - minY);
    function X(x) { return pad + (x - minX) * sx; }
    function Y(y) { return pad + (y - minY) * sy; }

    // The arrows first (under the boxes).
    var svg = '<svg class="ar-edges" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" aria-hidden="true" focusable="false"><g class="ar-edge-lines">';
    var heads = '';
    var edges = o.edges || [];
    var e, k;
    for (i = 0; i < edges.length; i++) {
      e = edges[i];
      var pts = [];
      for (k = 0; k < e.pts.length; k++) pts.push(r2(X(e.pts[k][0])) + ',' + r2(Y(e.pts[k][1])));
      svg += '<polyline points="' + pts.join(' ') + '"/>';
      var n = e.pts.length;
      var last = e.pts[n - 1], prev = e.pts[n - 2];
      if (e.dir === 'out' || e.dir === 'both') heads += arrowHead(X(last[0]), Y(last[1]), (last[0] - prev[0]) * sx, (last[1] - prev[1]) * sy, 0.55);
      if (e.dir === 'both') heads += arrowHead(X(e.pts[0][0]), Y(e.pts[0][1]), (e.pts[0][0] - e.pts[1][0]) * sx, (e.pts[0][1] - e.pts[1][1]) * sy, 0.55);
    }
    svg += '</g><g class="ar-edge-heads">' + heads + '</g></svg>';
    html('', map, svg, 'div').className = 'ar-edges-wrap';

    // The boxes.
    var firstKey = '';
    var boxEls = [];
    for (i = 0; i < o.boxes.length; i++) {
      var b = o.boxes[i];
      var g = byId[b.group];
      var box = div('ar-box f', map);
      box.setAttribute('data-key', 'bp:' + b.group);
      box.setAttribute('data-g', b.group);
      box.style.left = r2(X(b.x)) + 'rem';
      box.style.top = r2(Y(b.y)) + 'rem';
      box.style.width = r2(b.w * sx) + 'rem';
      box.style.minHeight = r2(b.h * sy) + 'rem';
      box.style.borderColor = '';
      var head = div('ar-box-head', box);
      var dot = span('ar-gdot', head);
      dot.style.background = GCOL[b.group] || '#a4a8b3';
      div('ar-box-title', head, b.title);
      var lines = [];
      for (k = 0; k < b.lines.length; k++) if (b.lines[k]) lines.push(b.lines[k]);
      // The box's lines, split into paragraphs at each empty line; each
      // paragraph wraps to the box and is clamped to two lines.
      var bl = div('ar-box-lines', box), para = [];
      for (k = 0; k <= b.lines.length; k++) {
        if (k < b.lines.length && b.lines[k]) { para.push(b.lines[k]); continue; }
        if (para.length) div('ar-box-para', bl, para.join(' '));
        para = [];
      }
      statusBar(box, g ? counts(g) : {}, 'ar-box-bar');
      boxEls.push(box);
      if (!firstKey) firstKey = 'bp:' + b.group;
    }
    centerBottomRow(map, o.boxes, boxEls, rem);

    // The edge labels (over the lines, never over a box's text).
    for (i = 0; i < edges.length; i++) {
      e = edges[i];
      if (!e.label) continue;
      var lab = div('ar-elabel', map, e.label);
      if (e.anchor === 'start') {
        lab.style.left = r2(X(e.lx)) + 'rem';
        lab.style.top = r2(Y(e.ly)) + 'rem';
        lab.className += ' is-start';
      } else {
        // Centered on the arrow's span, a little above the line.
        var seg = e.pts[0], seg2 = e.pts[1];
        var span2 = Math.abs(seg2[0] - seg[0]) * sx;
        lab.style.left = r2(X(e.lx)) + 'rem';
        lab.style.top = r2(Y(e.ly) + 0.45) + 'rem';
        lab.style.maxWidth = r2(Math.max(5, span2 - 0.4)) + 'rem';
      }
    }

    // The flows chip and the legend.
    var fc = div('ar-chip ar-chip-flows f', chips);
    fc.setAttribute('data-key', 'flows');
    html('ar-chip-ico', fc, SVGO + '<path d="M4 6h9M4 12h16M4 18h9"/><path d="m16 3.5 3.5 2.5L16 8.5M16 15.5l3.5 2.5-3.5 2.5"/></svg>');
    span('ar-chip-text', fc, 'Data flows (' + (D.flows || []).length + ')');
    drawLegend(chips);
    return firstKey;
  }

  /* ---------- drawing: group diagram ---------- */

  function nodeHead(parent, id) {
    var n = byId[id];
    var isRoot = !parentOf[id];
    var head = div('ar-head', parent);
    var left = div('ar-head-main', head);
    var row = div('ar-head-row', left);
    var ic = html('ar-head-ico', row, kindIcon(n.kind), 'span');
    ic.style.color = gcol(id);
    div('ar-head-title', row, n.title);
    if (isRoot) {
      statusBar(row, counts(n), 'ar-head-bar');
    } else {
      var pill = span('ar-pill s-' + n.status, row);
      pill.innerHTML = stShape(n.status);
      span('ar-pill-name', pill, stName(n.status));
    }
    if (n.pr) span('ar-pr', row, n.pr);
    div('ar-head-sum', left, n.summary);
    var btn = div('ar-pill-btn f', head);
    btn.setAttribute('data-key', 'self:' + id);
    span('', btn, 'Details');
    return head;
  }

  // The sibling (child of parent) a link from id lands on, or null.
  function siblingFor(parent, id) {
    var n = id;
    while (n) {
      if (parentOf[n] === parent) return n;
      n = parentOf[n];
    }
    return null;
  }

  function linksFor(parent) {
    var kids = kidsOf(parent), seen = {}, out = [], i, j;
    for (i = 0; i < kids.length; i++) {
      var t = kids[i].talksTo || [];
      for (j = 0; j < t.length; j++) {
        var to = siblingFor(parent, t[j].to);
        if (!to || to === kids[i].id) continue;
        var from = kids[i].id, dir = t[j].dir;
        var a = from, b = to;
        // One line per pair; an arrow each way becomes "both".
        var key = a < b ? a + '|' + b : b + '|' + a;
        var d = a < b ? dir : (dir === 'out' ? 'in' : dir === 'in' ? 'out' : 'both');
        if (seen[key] !== undefined) {
          var L = out[seen[key]];
          if (L.dir !== d) L.dir = 'both';
          continue;
        }
        seen[key] = out.length;
        // Normalize so that a < b: dir says which way it points (out = a to b).
        out.push({ a: a < b ? a : b, b: a < b ? b : a, dir: d });
      }
    }
    return out;
  }

  function cardMarkup(card, n) {
    var st = div('ar-card-st', card);
    st.style.background = n.status ? STCOL[n.status] : '#a4a8b3';
    var top = div('ar-card-top', card);
    var ic = html('ar-card-ico', top, kindIcon(n.kind));
    ic.style.color = gcol(n.id);
    div('ar-card-title', top, n.title);
    div('ar-card-sum', card, n.summary);
    var foot = div('ar-card-foot', card);
    var s = span('ar-card-status s-' + n.status, foot);
    s.innerHTML = stShape(n.status || 'live');
    span('ar-card-statusname', s, stName(n.status));
    if (n.pr) span('ar-pr', foot, n.pr);
    var k = (n.children || []).length;
    if (k) span('ar-more', foot, '+' + plural(k, 'part', 'parts'));
  }

  function drawGroup(main) {
    var parent = S.parent;
    nodeHead(main, parent);
    var cwrap = div('ar-cwrap', main);
    var canvas = div('ar-canvas', cwrap);
    var rem = remPx();
    var W = cwrap.clientWidth / rem;
    if (!(W > 20)) W = 72;
    var kids = kidsOf(parent);
    var n = kids.length;
    var cols = n <= 3 ? Math.max(1, n) : (n === 4 ? 2 : (n <= 9 ? 3 : 4));
    var gapX = 2.6, gapY = 1.5, cardH = 8.1;
    var cardW = Math.min(25, (W - 0.8 - (cols - 1) * gapX) / cols);
    var gridW = cols * cardW + (cols - 1) * gapX;
    var left = (W - gridW) / 2;
    var rows = Math.ceil(n / cols);
    var H = rows * cardH + (rows - 1) * gapY + 0.8;
    canvas.style.width = r2(W) + 'rem';
    canvas.style.height = r2(H) + 'rem';
    var pos = {}, i;
    for (i = 0; i < n; i++) {
      var r = Math.floor(i / cols), c = i % cols;
      pos[kids[i].id] = { x: left + c * (cardW + gapX), y: 0.4 + r * (cardH + gapY), r: r, c: c };
    }
    // The links first, under the cards.
    var links = linksFor(parent);
    var svg = '<svg class="ar-links" viewBox="0 0 ' + r2(W) + ' ' + r2(H) + '" style="width:' + r2(W) + 'rem;height:' + r2(H) + 'rem" aria-hidden="true" focusable="false">';
    for (i = 0; i < links.length; i++) {
      var L = links[i], A = pos[L.a], B = pos[L.b];
      if (!A || !B) continue;
      var ax, ay, bx, by, c1x, c1y, c2x, c2y;
      if (A.r === B.r) {
        var rightward = A.x < B.x;
        ax = A.x + (rightward ? cardW : 0); ay = A.y + cardH / 2;
        bx = B.x + (rightward ? 0 : cardW); by = B.y + cardH / 2;
        c1x = ax + (rightward ? 1 : -1) * gapX * 0.5; c1y = ay;
        c2x = bx - (rightward ? 1 : -1) * gapX * 0.5; c2y = by;
      } else {
        var down = B.r > A.r;
        ax = A.x + cardW / 2; ay = A.y + (down ? cardH : 0);
        bx = B.x + cardW / 2; by = B.y + (down ? 0 : cardH);
        var dy = Math.max(0.8, Math.abs(by - ay) * 0.45) * (down ? 1 : -1);
        c1x = ax; c1y = ay + dy; c2x = bx; c2y = by - dy;
      }
      var d = 'M' + r2(ax) + ',' + r2(ay) + ' C' + r2(c1x) + ',' + r2(c1y) + ' ' + r2(c2x) + ',' + r2(c2y) + ' ' + r2(bx) + ',' + r2(by);
      svg += '<g class="ar-link" data-a="' + L.a + '" data-b="' + L.b + '"><path d="' + d + '"/>';
      // Arrowheads: out points a to b, in points b to a, both has both.
      if (L.dir === 'out' || L.dir === 'both') svg += '<g class="ar-lh">' + arrowHead(bx, by, bx - c2x, by - c2y, 0.5) + '</g>';
      if (L.dir === 'in' || L.dir === 'both') svg += '<g class="ar-lh">' + arrowHead(ax, ay, ax - c1x, ay - c1y, 0.5) + '</g>';
      svg += '</g>';
    }
    svg += '</svg>';
    html('', canvas, svg, 'div').className = 'ar-links-wrap';
    var firstKey = '';
    for (i = 0; i < n; i++) {
      var node = kids[i], p = pos[node.id];
      var card = div('ar-card f', canvas);
      card.setAttribute('data-key', 'g:' + node.id);
      card.setAttribute('data-id', node.id);
      card.style.left = r2(p.x) + 'rem';
      card.style.top = r2(p.y) + 'rem';
      card.style.width = r2(cardW) + 'rem';
      card.style.height = cardH + 'rem';
      cardMarkup(card, node);
      // A title that wraps to two lines leaves room for one summary line,
      // so the summary never shows a half-cut line.
      var tt = card.querySelector('.ar-card-title');
      if (tt && tt.offsetHeight > rem * 1.2 * 1.4 * 1.5) card.className += ' is-wrap';
      if (!firstKey) firstKey = 'g:' + node.id;
    }
    return { first: firstKey, canvas: canvas, clip: cwrap, height: H };
  }

  /* ---------- drawing: flows ---------- */

  function drawFlows(main) {
    var head = div('ar-head', main);
    var left = div('ar-head-main', head);
    var row = div('ar-head-row', left);
    html('ar-head-ico', row, SVGO + '<path d="M4 6h9M4 12h16M4 18h9"/><path d="m16 3.5 3.5 2.5L16 8.5M16 15.5l3.5 2.5-3.5 2.5"/></svg>');
    div('ar-head-title', row, 'Data flows');
    div('ar-head-sum', left, 'How things travel: pick one and step through it, part by part.');
    var cwrap = div('ar-cwrap', main);
    var canvas = div('ar-canvas', cwrap);
    var rem = remPx();
    var W = cwrap.clientWidth / rem;
    if (!(W > 20)) W = 72;
    var flows = D.flows || [];
    var gap = 1.2, rowH = 5.1, rowGap = 1;
    var colW = (W - 0.8 - gap) / 2;
    var rows = Math.ceil(flows.length / 2);
    var H = rows * rowH + (rows - 1) * rowGap + 0.8;
    canvas.style.width = r2(W) + 'rem';
    canvas.style.height = r2(H) + 'rem';
    var first = '';
    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      var c = i % 2, r = Math.floor(i / 2);
      var it = div('ar-frow f', canvas);
      it.setAttribute('data-key', 'fl:' + f.id);
      it.style.left = r2(0.4 + c * (colW + gap)) + 'rem';
      it.style.top = r2(0.4 + r * (rowH + rowGap)) + 'rem';
      it.style.width = r2(colW) + 'rem';
      it.style.height = rowH + 'rem';
      var num = span('ar-fnum', it, String(i + 1));
      var txt = div('ar-ftext', it);
      div('ar-ftitle', txt, f.title);
      div('ar-fsum', txt, f.summary);
      span('ar-fsteps', it, plural(f.steps.length, 'step', 'steps'));
      if (!first) first = 'fl:' + f.id;
      num.style.color = '';
    }
    return { first: first, canvas: canvas, clip: cwrap, height: H };
  }

  function drawFlow(main) {
    var f = flowById[S.flow];
    var steps = f.steps;
    if (S.step < 0) S.step = 0;
    if (S.step > steps.length - 1) S.step = steps.length - 1;
    var cur = steps[S.step];
    var node = byId[cur.node];
    var wrap = div('ar-stepper f', main);
    wrap.setAttribute('data-key', 'stepper');
    var listCol = div('ar-fl-list', wrap);
    div('ar-fl-title', listCol, f.title);
    var clip = div('ar-fl-clip', listCol);
    var scroll = div('ar-fl-scroll', clip);
    var curEl = null;
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      var item = div('ar-step' + (i === S.step ? ' is-now' : '') + (i < S.step ? ' is-past' : ''), scroll);
      var no = span('ar-step-no', item, String(i + 1));
      var g = groupOf(st.node);
      if (i === S.step) no.style.background = GCOL[g] || '#fff';
      var tx = div('ar-step-text', item);
      div('ar-step-node', tx, titleOf(st.node));
      var gn = div('ar-step-group', tx, titleOf(g));
      gn.style.color = GCOL[g] || '';
      if (i === S.step) curEl = item;
    }
    var now = div('ar-fl-now', wrap);
    div('ar-now-count', now, 'Step ' + (S.step + 1) + ' of ' + steps.length);
    var row = div('ar-now-row', now);
    var ic = html('ar-now-ico', row, kindIcon(node ? node.kind : 'component'));
    ic.style.color = gcol(cur.node);
    div('ar-now-title', row, node ? node.title : cur.node);
    var path = pathOf(cur.node), names = [];
    for (var k = 0; k < path.length; k++) names.push(titleOf(path[k]));
    var pth = div('ar-now-path', now, names.join('  ›  '));
    pth.style.color = gcol(cur.node);
    var say = div('ar-now-say', now, cur.say);
    say.style.borderLeftColor = gcol(cur.node);
    if (node) {
      var meta = div('ar-now-meta', now);
      if (node.status) {
        var pill = span('ar-pill s-' + node.status, meta);
        pill.innerHTML = stShape(node.status);
        span('ar-pill-name', pill, stName(node.status));
      }
      if (node.pr) span('ar-pr', meta, node.pr);
      div('ar-now-sum', now, node.summary);
    }
    var nav = div('ar-now-nav', now);
    span('ar-navchip' + (S.step === 0 ? ' is-off' : ''), nav, 'Left  Previous');
    span('ar-navchip' + (S.step === steps.length - 1 ? ' is-off' : ''), nav, 'Right  Next');
    span('ar-navchip is-ok', nav, 'OK  Show this part');
    return { step: curEl, clip: clip, scroll: scroll };
  }

  /* ---------- drawing: the drawer ---------- */

  function paragraphRow(parent, key, cls, text) {
    var r = div('ar-dr-row f ' + cls, parent);
    r.setAttribute('data-key', key);
    r.textContent = text;
    return r;
  }

  /* The code map (docs/CODE-MAP.md, matched to the part's files by studio/codemap.js
     when the data file is built): where to start reading, what the map says about
     its files, what to check when it breaks and the recipe for adding one like it. */

  // Text with `code` spans, built as nodes (never innerHTML: the words are data).
  function codeText(cls, parent, text) {
    var el = div(cls, parent), bits = String(text || '').split(String.fromCharCode(96)), i; // a backtick
    for (i = 0; i < bits.length; i++) {
      if (!bits[i]) continue;
      if (i % 2) span('ar-cm-code', el, bits[i]);
      else el.appendChild(document.createTextNode(bits[i]));
    }
    return el;
  }
  function cmRow(parent, key, cls) {
    var r = div('ar-dr-row f ar-cm-row ' + (cls || ''), parent);
    r.setAttribute('data-key', key);
    return r;
  }
  function runsOn(f) { return f.lang + (f.where ? '  \u00b7  runs on ' + f.where : ''); }
  function cmFolderLine(parent, f) {
    var w = div('ar-cm-in', parent);
    span('ar-cm-code', w, f.path);
    w.appendChild(document.createTextNode('  ' + runsOn(f)));
  }

  function drawCodeMap(scroll, n) {
    var CM = D && D.codemap, e = CM && CM.parts && CM.parts[n.id];
    if (!e) return;
    var total = CM.read.length, i, r, x, row;
    var lab = div('ar-dr-label ar-cm-label', scroll, 'Code map');
    span('ar-cm-src', lab, CM.src);
    if (e.folders) {
      for (i = 0; i < e.folders.length; i++) {
        var f = CM.folders[e.folders[i]];
        row = cmRow(scroll, 'd:cm:dir' + i, 'ar-cm-file');
        div('ar-cm-path', row, f.path);
        div('ar-cm-note', row, runsOn(f));
        if (f.start) {
          var st = div('ar-cm-also', row, 'Start at ');
          span('ar-cm-code', st, f.start);
        }
      }
      if (e.read) {
        div('ar-dr-label', scroll, 'Its steps in the reading order');
        for (i = 0; i < e.read.length; i++) {
          r = CM.read[e.read[i]];
          row = cmRow(scroll, 'd:cm:read' + i, 'ar-cm-step');
          span('ar-cm-n', row, String(r.n));
          codeText('ar-cm-steptext', row, r.text);
        }
      }
      return;
    }
    var s = e.start, sr = s.read >= 0 ? CM.read[s.read] : null;
    row = cmRow(scroll, 'd:cm:start', 'ar-cm-start');
    var eb = div('ar-cm-eyebrow', row);
    if (sr) span('ar-cm-n', eb, String(sr.n));
    span('', eb, sr ? 'Start here  \u00b7  step ' + sr.n + ' of ' + total : 'Start here  \u00b7  main file');
    div('ar-cm-path ar-cm-big', row, s.path);
    if (sr) codeText('ar-cm-note', row, sr.text);
    else if (s.flow) {
      var fl = CM.flows[s.flow[0]];
      codeText('ar-cm-note', row, fl.title + '. ' + fl.says[s.flow[1]].text);
    }
    if (s.folder >= 0) cmFolderLine(row, CM.folders[s.folder]);
    var files = e.files || [];
    if (files.length) div('ar-dr-label', scroll, 'Also in the map');
    for (i = 0; i < files.length; i++) {
      x = files[i];
      row = cmRow(scroll, 'd:cm:f' + i, 'ar-cm-file');
      var head = div('ar-cm-head', row);
      span('ar-cm-path', head, x.path);
      span('ar-cm-tag', head, x.read !== undefined ? 'Step ' + CM.read[x.read].n : CM.flows[x.flow[0]].title);
      codeText('ar-cm-note', row, x.read !== undefined ? CM.read[x.read].text : CM.flows[x.flow[0]].says[x.flow[1]].text);
      if (x.also) {
        var names = [];
        for (var a = 0; a < x.also.length; a++) names.push('\u201c' + CM.flows[x.also[a]].title + '\u201d');
        div('ar-cm-also', row, 'Also in ' + names.join(', '));
      }
    }
    if (e.more) div('ar-cm-also ar-cm-more', scroll, '+' + e.more + ' more in the map');
    var fixes = e.fixes || [];
    if (fixes.length) div('ar-dr-label', scroll, 'When something looks wrong');
    for (i = 0; i < fixes.length; i++) {
      x = CM.fixes[fixes[i]];
      row = cmRow(scroll, 'd:cm:fix' + i, 'ar-cm-fix');
      div('ar-cm-when', row, x.when);
      codeText('ar-cm-note', row, x.look);
    }
    if (e.recipe) {
      var rc = CM.recipes[e.recipe.i];
      div('ar-dr-label', scroll, 'To add one like it: ' + rc.title);
      row = cmRow(scroll, 'd:cm:recipe', 'ar-cm-recipe');
      for (i = 0; i < rc.steps.length; i++) {
        var li = div('ar-cm-li', row);
        span('ar-cm-num', li, (i + 1) + '.');
        codeText('ar-cm-litext', li, rc.steps[i].text);
      }
    }
  }

  function drawDrawer(root) {
    var n = byId[S.node];
    var dim = div('ar-dim', root);
    dim.setAttribute('aria-hidden', 'true');
    var dr = div('ar-drawer', root);
    dr.setAttribute('data-g', groupOf(n.id));
    var head = div('ar-dr-head', dr);
    var row = div('ar-dr-titlerow', head);
    var ic = html('ar-dr-ico', row, kindIcon(n.kind));
    ic.style.color = gcol(n.id);
    div('ar-dr-title', row, n.title);
    var meta = div('ar-dr-meta', head);
    if (n.status) {
      var pill = span('ar-pill s-' + n.status, meta);
      pill.innerHTML = stShape(n.status);
      span('ar-pill-name', pill, stName(n.status));
    }
    if (n.pr) span('ar-pr', meta, n.pr);
    span('ar-dr-kind', meta, n.kind);
    var p = pathOf(n.id), names = [];
    for (var q = 0; q < p.length - 1; q++) names.push(titleOf(p[q]));
    if (names.length) {
      var where = div('ar-dr-where', head, names.join('  ›  '));
      where.style.color = gcol(n.id);
    }
    var clip = div('ar-dr-clip', dr);
    var scroll = div('ar-dr-scroll', clip);
    var i, key = 0;
    paragraphRow(scroll, 'd:sum', 'ar-dr-sum', n.summary);
    var kids = n.children || [];
    if (kids.length) {
      var open = div('ar-dr-row ar-dr-open f', scroll);
      open.setAttribute('data-key', 'd:open');
      span('', open, 'Open the ' + plural(kids.length, 'part', 'parts') + ' inside');
      html('ar-dr-go', open, CHEV);
    }
    var det = n.details || [];
    if (det.length) div('ar-dr-label', scroll, 'Details');
    for (i = 0; i < det.length; i++) paragraphRow(scroll, 'd:det' + i, 'ar-dr-text', det[i]);
    var files = n.files || [];
    if (files.length) {
      div('ar-dr-label', scroll, 'Files');
      var fr = div('ar-dr-row ar-dr-files f', scroll);
      fr.setAttribute('data-key', 'd:files');
      for (i = 0; i < files.length; i++) div('ar-dr-file', fr, files[i]);
    }
    drawCodeMap(scroll, n);
    var notes = n.notes || [];
    if (notes.length) div('ar-dr-label', scroll, 'Notes');
    for (i = 0; i < notes.length; i++) paragraphRow(scroll, 'd:note' + i, 'ar-dr-text ar-dr-note', notes[i]);
    var talks = n.talksTo || [];
    if (talks.length) div('ar-dr-label', scroll, 'Talks to');
    for (i = 0; i < talks.length; i++) {
      var t = talks[i];
      if (!byId[t.to]) continue;
      var lk = div('ar-dr-row ar-dr-link f', scroll);
      lk.setAttribute('data-key', 'd:to:' + i);
      lk.setAttribute('data-to', t.to);
      var ar = html('ar-dr-arrow', lk, ARROWS[t.dir] || ARROWS.out);
      ar.style.color = gcol(t.to);
      var tx = div('ar-dr-linktext', lk);
      div('ar-dr-linktitle', tx, byId[t.to].title);
      var lbl = t.label || '';
      var tg = titleOf(groupOf(t.to));
      div('ar-dr-linklabel', tx, (lbl ? lbl + '  ·  ' : '') + tg);
      key++;
    }
    return { clip: clip, scroll: scroll };
  }

  /* ---------- drawing: the page ---------- */

  function applyScroll(canvas, px) { canvas.style.transform = 'translateY(' + (-Math.round(px)) + 'px)'; }

  function render(body, ctx) {
    C = ctx;
    ROOT = div('ar-root', body);
    if (dataState !== 'ready') {
      drawCrumbs(ROOT);
      var box = div('ar-state', ROOT);
      if (dataState === 'failed') {
        div('ar-state-title', box, 'The map could not load');
        div('ar-state-text', box, 'The map data did not come through. Press OK to try again.');
        var again = div('ar-pill-btn ar-retry f', box, 'Try again');
        again.setAttribute('data-key', 'retry');
        again.setAttribute('data-autofocus', '');
      } else {
        div('ar-state-title', box, 'Loading the map');
        div('ar-state-text', box, 'Just a moment.');
        ensureData(function () {
          if (!(ctx.isOpen && ctx.isOpen())) return;
          ctx.redrawPanel();
          // The loading page had nothing to focus, so the hub parked focus on its own button.
          var t = ROOT && ROOT.querySelector('[data-autofocus]');
          if (t) ctx.focus(t);
        });
      }
      drawBottom(ROOT);
      return;
    }
    // A node that went away (data changed under it) never leaves a blank page.
    if (S.node && !byId[S.node]) S.node = null;
    if (S.view === 'group' && !byId[S.parent]) { S.view = 'big'; S.parent = null; }
    if (S.view === 'flow' && !flowById[S.flow]) S.view = 'flows';

    var vk = viewKey();
    drawCrumbs(ROOT);
    var main = div('ar-main ar-main-' + S.view, ROOT);
    drawBottom(ROOT);       // before the page is measured, so it has its room
    var info = null, first = '';
    if (S.view === 'big') first = drawBig(main);
    else if (S.view === 'group') { info = drawGroup(main); first = info.first; }
    else if (S.view === 'flows') { info = drawFlows(main); first = info.first; }
    else { info = drawFlow(main); first = 'stepper'; }
    if (S.view === 'flow' && info.step) {
      // Keep the current step in view in the list.
      var clip = info.clip, r = info.step.offsetTop, h = info.step.offsetHeight;
      var top = Math.max(0, r - (clip.clientHeight - h) / 2);
      var maxTop = Math.max(0, info.scroll.offsetHeight - clip.clientHeight);
      info.scroll.style.transform = 'translateY(' + (-Math.round(Math.min(top, maxTop))) + 'px)';
    }
    if (info && info.canvas) {
      var max = Math.max(0, info.height * remPx() - info.clip.clientHeight);
      var sc = Math.min(SCR[vk] || 0, max);
      SCR[vk] = sc;
      applyScroll(info.canvas, sc);
    }

    // Behind the drawer the page is only a picture: nothing on it takes focus.
    if (S.node) {
      var nodes = main.querySelectorAll('.f');
      for (var i = 0; i < nodes.length; i++) setClass(nodes[i], 'f', false);
      setClass(main, 'is-dimmed', true);
      var dr = drawDrawer(ROOT);
      var firstRow = dr.scroll.querySelector('.f');
      if (firstRow) firstRow.setAttribute('data-autofocus', '');
      S.dscroll = 0;
    } else {
      var want = MEM[vk];
      var target = null, all = main.querySelectorAll('.f');
      for (var j = 0; j < all.length; j++) {
        if (all[j].getAttribute('data-key') === want) { target = all[j]; break; }
      }
      if (!target) {
        for (var m = 0; m < all.length; m++) {
          if (all[m].getAttribute('data-key') === first) { target = all[m]; break; }
        }
      }
      if (!target && all.length) target = all[0];
      if (target) target.setAttribute('data-autofocus', '');
    }
  }

  /* ---------- moving ---------- */

  function rectOf(el) { return el.getBoundingClientRect(); }

  // The nearest element in a direction: along that axis first, then how far off to the side.
  function pickDir(dir, from, list) {
    var f = rectOf(from);
    var fx = (f.left + f.right) / 2, fy = (f.top + f.bottom) / 2;
    var best = null, bestScore = 1e12;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === from) continue;
      var r = rectOf(el);
      var cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      var main, side, overlap;
      if (dir === 'left' || dir === 'right') {
        main = dir === 'right' ? cx - fx : fx - cx;
        side = Math.abs(cy - fy);
        overlap = Math.min(r.bottom, f.bottom) - Math.max(r.top, f.top) > 0;
      } else {
        main = dir === 'down' ? cy - fy : fy - cy;
        side = Math.abs(cx - fx);
        overlap = Math.min(r.right, f.right) - Math.max(r.left, f.left) > 0;
      }
      if (main < 4) continue;
      // Anything straight ahead (overlapping on the other axis) beats what is
      // off to the side: Down from the left column reaches the wide Tests box
      // under it before the Data flows chip further down.
      var score = main + side * (overlap ? 0.02 : 3);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function focusables() {
    var out = [];
    if (!ROOT) return out;
    var list = ROOT.querySelectorAll('.f');
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  // Scrolls a canvas (a transform) so el is whole in clip; a block taller than the clip shows its top.
  function reveal(el, clip, canvas, get, set, extra) {
    var rem = remPx();
    var c = clip.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    // The page may still be growing in (scaled): measure in its own pixels.
    var k = clip.offsetHeight ? c.height / clip.offsetHeight : 1;
    if (!(k > 0)) k = 1;
    var m = (extra === undefined ? 0.5 : extra) * rem;
    var top = (r.top - c.top) / k, bottom = (r.bottom - c.top) / k, h = clip.offsetHeight;
    var delta = 0;
    if ((r.height / k) + 2 * m > h) delta = top - m;
    else if (top < m) delta = top - m;
    else if (bottom > h - m) delta = bottom - (h - m);
    if (!delta) return;
    var max = Math.max(0, canvas.offsetHeight - clip.clientHeight);
    var next = Math.max(0, Math.min(max, get() + delta));
    set(next);
    canvas.style.transform = 'translateY(' + (-Math.round(next)) + 'px)';
  }

  function drawerParts() {
    if (!ROOT) return null;
    var clip = ROOT.querySelector('.ar-dr-clip'), scroll = ROOT.querySelector('.ar-dr-scroll');
    return clip && scroll ? { clip: clip, scroll: scroll } : null;
  }

  function drawerMove(dir, from) {
    if (dir === 'left') { S.node = null; redraw(); return true; }
    if (dir === 'right') return true;
    var dp = drawerParts();
    if (!dp) return true;
    var cr = dp.clip.getBoundingClientRect(), fr = rectOf(from);
    var step = cr.height * 0.8;
    var max = Math.max(0, dp.scroll.offsetHeight - dp.clip.clientHeight);
    // A block taller than the drawer scrolls before focus moves on.
    if (dir === 'down' && fr.bottom > cr.bottom + 2 && S.dscroll < max) {
      S.dscroll = Math.min(max, S.dscroll + Math.min(step, fr.bottom - cr.bottom + remPx() * 0.5));
      dp.scroll.style.transform = 'translateY(' + (-Math.round(S.dscroll)) + 'px)';
      return true;
    }
    if (dir === 'up' && fr.top < cr.top - 2 && S.dscroll > 0) {
      S.dscroll = Math.max(0, S.dscroll - Math.min(step, cr.top - fr.top + remPx() * 0.5));
      dp.scroll.style.transform = 'translateY(' + (-Math.round(S.dscroll)) + 'px)';
      return true;
    }
    var list = focusables();
    var at = -1, i;
    for (i = 0; i < list.length; i++) if (list[i] === from) at = i;
    var nx = list[at + (dir === 'down' ? 1 : -1)];
    return nx || true;
  }

  function stepFlow(delta) {
    var f = flowById[S.flow];
    if (!f) return;
    var next = Math.max(0, Math.min(f.steps.length - 1, S.step + delta));
    if (next === S.step) return;
    S.step = next;
    redraw();
  }

  function onMove(dir, from, ctx) {
    if (dataState !== 'ready') return true;
    if (S.node) return drawerMove(dir, from);
    if (S.view === 'flow') {
      stepFlow(dir === 'left' || dir === 'up' ? -1 : 1);
      return true;
    }
    var next = pickDir(dir, from, focusables());
    return next || true;
  }

  /* ---------- opening things ---------- */

  function setView(view, extra) {
    S.view = view;
    S.node = null;
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) S[k] = extra[k];
    redraw();
  }

  // Shows a part on its group's diagram with focus on it (a drawer link, or a flow step).
  function showPart(id) {
    var p = parentOf[id];
    S.node = null;
    if (!p) {
      S.view = 'big'; S.parent = null;
      MEM.big = 'bp:' + id;
    } else {
      S.view = 'group'; S.parent = p;
      MEM['g:' + p] = 'g:' + id;
      SCR['g:' + p] = SCR['g:' + p] || 0;
    }
    redraw(p ? 'g:' + id : 'bp:' + id);
  }

  function goUp() {
    if (S.node) { S.node = null; redraw(); return true; }
    if (dataState !== 'ready') return false;
    if (S.view === 'flow') { S.view = 'flows'; redraw(); return true; }
    if (S.view === 'flows') { S.view = 'big'; redraw(); return true; }
    if (S.view === 'group') {
      var p = parentOf[S.parent];
      if (p) { S.parent = p; } else { MEM.big = 'bp:' + S.parent; S.view = 'big'; S.parent = null; }
      redraw();
      return true;
    }
    return false;
  }

  function onSelect(target) {
    var key = target.getAttribute('data-key') || '';
    if (key === 'retry') { dataState = 'none'; tries = 0; redraw(); return; }
    if (dataState !== 'ready') return;
    if (key.indexOf('bp:') === 0) { setView('group', { parent: key.slice(3) }); return; }
    if (key === 'flows') { setView('flows'); return; }
    if (key.indexOf('fl:') === 0) { setView('flow', { flow: key.slice(3), step: 0 }); return; }
    if (key === 'stepper') {
      var f = flowById[S.flow];
      if (f && f.steps[S.step] && byId[f.steps[S.step].node]) showPart(f.steps[S.step].node);
      return;
    }
    if (key.indexOf('self:') === 0) { S.node = key.slice(5); redraw(); return; }
    if (key.indexOf('g:') === 0) {
      var id = key.slice(2);
      if (kidsOf(id).length) { S.parent = id; redraw(); } else { S.node = id; redraw(); }
      return;
    }
    if (key === 'd:open') { var nid = S.node; S.node = null; S.parent = nid; S.view = 'group'; redraw(); return; }
    if (key.indexOf('d:to:') === 0) { showPart(target.getAttribute('data-to')); return; }
  }

  function onFocus(target) {
    if (!ROOT || dataState !== 'ready' || !target || !target.getAttribute) return;
    var key = target.getAttribute('data-key') || '';
    if (S.node) {
      var dp = drawerParts();
      if (dp) {
        reveal(target, dp.clip, dp.scroll, function () { return S.dscroll; }, function (v) { S.dscroll = v; }, 0.6);
      }
      return;
    }
    var vk = viewKey();
    MEM[vk] = key;
    if (S.view === 'group') {
      markLinks(target.getAttribute('data-id'));
    }
    if (S.view === 'group' || S.view === 'flows') {
      var clip = ROOT.querySelector('.ar-cwrap'), canvas = ROOT.querySelector('.ar-canvas');
      if (clip && canvas && target.parentNode === canvas) {
        reveal(target, clip, canvas, function () { return SCR[vk] || 0; }, function (v) { SCR[vk] = v; }, 0.4);
      } else if (clip && canvas && S.view === 'group') {
        // The head's Details pill: back to the top.
        SCR[vk] = 0;
        canvas.style.transform = 'translateY(0)';
      }
    }
  }

  // Lines of the focused card and the cards they reach stand out.
  function markLinks(id) {
    if (!ROOT) return;
    var links = ROOT.querySelectorAll('.ar-link');
    var linked = {};
    var i;
    for (i = 0; i < links.length; i++) {
      var a = links[i].getAttribute('data-a'), b = links[i].getAttribute('data-b');
      var on = !!id && (a === id || b === id);
      svgClass(links[i], 'is-on', on);
      if (on) linked[a === id ? b : a] = true;
    }
    var cards = ROOT.querySelectorAll('.ar-card');
    for (i = 0; i < cards.length; i++) setClass(cards[i], 'is-linked', !!linked[cards[i].getAttribute('data-id')]);
  }

  /* ---------- the widget ---------- */

  var widget = {
    id: 'architecture',
    title: 'Architecture',
    icon: 'architecture',
    expandable: true,
    openMode: 'full',

    renderTile: function (body, ctx) {
      try {
        renderTile(body, ctx);
      } catch (e) {
        body.innerHTML = '';
        div('ar-none', body, 'Every part of Home Hub');
      }
    },

    renderPanel: function (body, ctx) { render(body, ctx); },

    onMove: function (dir, from, ctx) { return onMove(dir, from, ctx); },

    onSelect: function (target) { onSelect(target); },

    onFocus: function (target) { onFocus(target); },

    onBack: function () { return goUp(); },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },

    onClose: function () {
      // Next time it opens at the Big picture; the last focus on each level is kept.
      S = fresh();
      ROOT = null;
    }
  };

  // For the tests (dev/architecture-tv-test.js).
  window.HUB_ARCHITECTURE = {
    state: function () {
      return { view: S.view, parent: S.parent, node: S.node, flow: S.flow, step: S.step, data: dataState, tries: tries, scroll: S.dscroll };
    },
    summary: function () { return SUMMARY; },
    // Jump to a part (with its drawer open) or into a flow, as the remote would; for tests and pictures.
    goto: function (id, drawer) {
      if (dataState !== 'ready' || !byId[id]) return false;
      showPart(id);
      if (drawer) { S.node = id; redraw(); }
      return true;
    },
    flow: function (id, step) {
      if (dataState !== 'ready' || !flowById[id]) return false;
      S.view = 'flow'; S.flow = id; S.step = step || 0; S.node = null;
      redraw();
      return true;
    }
  };

  return widget;
})());
