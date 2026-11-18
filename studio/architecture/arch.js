/* Architecture page (generated into the Studio by studio/build-architecture.js; edit studio/architecture/arch.js) */
(function () {
  'use strict';
  var dataEl = document.getElementById('archData'), host = document.getElementById('archView');
  if (!dataEl || !host) return;
  var D;
  try { D = JSON.parse(dataEl.textContent); } catch (e) { host.innerHTML = '<p class="ar-empty">The architecture data could not be read.</p>'; return; }

  var REPO = 'https://github.com/irosen419/tizen-takeover/blob/main/';
  var STATUS = [
    { id: 'live', name: 'Live', short: 'Confirmed on the TV', hint: 'On main and confirmed on the real TV or in daily use' },
    { id: 'unverified', name: 'Unverified', short: 'On main, laptop-tested', hint: 'On main, checked on a laptop only' },
    { id: 'draft', name: 'Draft', short: 'In an open pull request', hint: 'Only in an open pull request' },
    { id: 'planned', name: 'Planned', short: 'Not started', hint: 'An idea or plan, not started' }
  ];
  var STNAME = {}; STATUS.forEach(function (s) { STNAME[s.id] = s; });
  var KIND = { group: 'Group', component: 'Component', file: 'File', service: 'Service', data: 'Data', script: 'Script', test: 'Test', external: 'Outside service', task: 'Scheduled task', doc: 'Document' };
  var KP = {
    group: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
    component: '<rect x="3" y="3" width="10" height="10" rx="2.5"/><path d="M6 8h4"/>',
    file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
    service: '<rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>',
    data: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
    script: '<path d="M6 4 3 8l3 4M10 4l3 4-3 4"/>',
    test: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8.2 7.3 10l3.4-3.8"/>',
    external: '<path d="M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 12 6.5a3 3 0 0 1-.5 6z"/>',
    task: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.3l2 1.2"/>',
    doc: '<path d="M3 4h10M3 8h10M3 12h6"/>'
  };
  function kindIco(k) { return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (KP[k] || KP.component) + '</svg>'; }
  /* Diagram tiles: one drawn icon per kind on a 24 grid, 1.6 stroke, round joins. */
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
  function tileIco(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (KD[k] || KD.component) + '</svg>'; }
  function stIco(s) {
    var b = '<svg class="ar-ico s-' + s + '" viewBox="0 0 14 14" aria-hidden="true">';
    if (s === 'live') return b + '<circle cx="7" cy="7" r="5" fill="currentColor"/></svg>';
    if (s === 'unverified') return b + '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 2.6a4.4 4.4 0 0 0 0 8.8z" fill="currentColor"/></svg>';
    if (s === 'draft') return b + '<path d="M7 1.8 12.2 7 7 12.2 1.8 7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.4" fill="currentColor"/></svg>';
    return b + '<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>';
  }
  var CHEV = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5 8 6l-4 3.5"/></svg>';
  var BACK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /*LAYOUT-BEGIN*/
  /* Diagram layout: pure arithmetic, no DOM, so dev/architecture-test.js can run it in Node.
     makeLayout(tree) returns { layout(rootId, open), ... }. layout() lays the root's children out
     left to right in layers built from their talksTo links (rolled up to siblings), with boxes that
     link to nothing in a grid row beneath, open boxes drawn as containers holding their own
     sub-diagram, and links that leave the root as "ghost" chips on the left (in) and right (out). */
  function makeLayout(tree) {
    var C = { BW: 196, BH: 142, GX: 116, CGX: 64, GY: 20, PAD: 20, HEAD: 68, CW: 132, CH: 60, CMINW: 340, LABW: 104, GRIDHEAD: 34, DUMH: 22 };
    var by = {}, par = {}, ord = {}, tops = [], oi = 0;
    function ix(n, p) { by[n.id] = n; par[n.id] = p; ord[n.id] = oi++; (n.children || []).forEach(function (c) { ix(c, n.id); }); }
    tree.forEach(function (n) { ix(n, null); tops.push(n.id); });
    function kids(id) { return ((by[id] && by[id].children) || []).map(function (c) { return c.id; }); }
    function topOf(id) { while (par[id]) id = par[id]; return id; }
    function chain(id) { var a = []; while (id) { a.unshift(id); id = par[id]; } return a; }
    function childOn(anc, id) { var prev = null; while (id && id !== anc) { prev = id; id = par[id]; } return id === anc ? prev : null; }
    function ghostKey(root, id) { var rc = chain(root), xc = chain(id), i = 0; while (i < xc.length && xc[i] === rc[i]) i++; return xc[i] || xc[xc.length - 1]; }

    // Directed links, one per (from, to, label); "in" links are turned round so s always sends to t.
    var links = [], seen = {};
    Object.keys(by).forEach(function (id) {
      (by[id].talksTo || []).forEach(function (t) {
        if (!by[t.to] || t.to === id) return;
        var s = t.dir === 'in' ? t.to : id, d = t.dir === 'in' ? id : t.to, k = s + '>' + d + '>' + (t.label || '');
        if (seen[k]) return; seen[k] = 1;
        links.push({ s: s, t: d, label: t.label || '', both: t.dir === 'both' });
      });
    });

    function est(text) { // label size estimate (11px Inter): conservative, so the real one is never bigger
      var tw = String(text).length * 6.3 + 16, lines = tw > C.LABW ? 2 : 1;
      return { w: lines > 1 ? C.LABW : Math.ceil(tw), h: lines * 15 + 7, lines: lines };
    }

    /* isotonic regression (pool adjacent violators): best tops for an ordered column with fixed gaps */
    function placeColumn(items, desired, weight) {
      var off = [], o = 0, blocks = [];
      items.forEach(function (it, i) { off.push(o); o += it.h + (i < items.length - 1 ? gapBetween(it, items[i + 1]) : 0); });
      items.forEach(function (it, i) {
        blocks.push({ v: desired[i] - off[i], w: weight[i], n: 1 });
        while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
          var b = blocks.pop(), a = blocks[blocks.length - 1], w = a.w + b.w;
          a.v = (a.v * a.w + b.v * b.w) / (w || 1); a.w = w; a.n += b.n;
        }
      });
      var out = [], k = 0;
      blocks.forEach(function (b) { for (var j = 0; j < b.n; j++, k++) out.push(b.v + off[k]); });
      return out;
    }
    function gapBetween(a, b) { return (a.dummy || b.dummy) ? 8 : C.GY; }

    function layoutBox(cid, open, isRoot, rootId) {
      var ks = kids(cid), node = {}, R = { items: [], chips: [], dummies: {}, layer: {}, w: 0, h: 0, grid: null };
      ks.forEach(function (k) {
        var n = { id: k, w: C.BW, h: C.BH };
        if (open[k] && kids(k).length) {
          n.sub = layoutBox(k, open, false, rootId);
          n.w = Math.max(C.CMINW, n.sub.w + 2 * C.PAD); n.h = C.HEAD + 6 + n.sub.h + C.PAD;
        }
        node[k] = n;
      });
      // rolled-up pairs at this level
      var pair = {}, chipN = {};
      function addPair(a, b, w) {
        var key = ord[a] !== undefined && ord[b] !== undefined ? (ord[a] < ord[b] ? a + '|' + b : b + '|' + a) : a + '|' + b;
        var p = pair[key] || (pair[key] = { a: key.split('|')[0], b: key.split('|')[1], ab: 0, ba: 0, first: null });
        if (p.a === a) p.ab += w; else p.ba += w;
        if (!p.first) p.first = a;
      }
      links.forEach(function (L) {
        var a = childOn(cid, L.s), b = childOn(cid, L.t);
        if (a && b) { if (a !== b) addPair(a, b, 1); return; }
        if (!isRoot || (!a && !b)) return;
        var other = a ? L.t : L.s, key = (a ? 'out:' : 'in:') + ghostKey(rootId, other);
        if (!node[key]) { node[key] = { id: key, w: C.CW, h: C.CH, chip: a ? 'out' : 'in', key: ghostKey(rootId, other) }; chipN[key] = 1; }
        if (a) addPair(a, key, 1); else addPair(key, b, 1);
      });
      // simple digraph oriented by majority; chips fixed (in = source, out = sink)
      var ids = ks.concat(Object.keys(chipN).sort(function (x, y) { return ord[x.split(':')[1]] - ord[y.split(':')[1]]; }));
      var out = {}, inn = {}, deg = {};
      ids.forEach(function (i) { out[i] = {}; inn[i] = {}; deg[i] = 0; });
      Object.keys(pair).forEach(function (k) {
        var p = pair[k], s = p.a, t = p.b, w = p.ab + p.ba;
        if (node[s].chip === 'out' || node[t].chip === 'in') { s = p.b; t = p.a; }
        else if (!node[s].chip && !node[t].chip && (p.ba > p.ab || (p.ba === p.ab && p.first === p.b))) { s = p.b; t = p.a; }
        out[s][t] = (out[s][t] || 0) + w; inn[t][s] = (inn[t][s] || 0) + w; deg[s] += w; deg[t] += w;
      });
      var conn = ids.filter(function (i) { return deg[i] > 0; }), iso = ks.filter(function (i) { return !deg[i]; });
      var real = conn.filter(function (i) { return !node[i].chip; });
      // cycle breaking (Eades-Lin-Smyth greedy) on the real boxes
      var rem = {}, s1 = [], s2 = [];
      real.forEach(function (i) { rem[i] = 1; });
      function dgo(i, inc) { var n = 0, m = inc ? inn[i] : out[i]; for (var j in m) if (rem[j]) n += m[j]; return n; }
      var left = real.length;
      while (left) {
        var moved = true;
        while (moved) {
          moved = false;
          for (var a = 0; a < real.length; a++) { var u = real[a]; if (rem[u] && !dgo(u, false)) { s2.unshift(u); delete rem[u]; left--; moved = true; } }
          for (var b = 0; b < real.length; b++) { var v = real[b]; if (rem[v] && !dgo(v, true)) { s1.push(v); delete rem[v]; left--; moved = true; } }
        }
        if (!left) break;
        var best = null, bd = -1e9;
        real.forEach(function (i) { if (rem[i]) { var d = dgo(i, false) - dgo(i, true); if (d > bd) { bd = d; best = i; } } });
        s1.push(best); delete rem[best]; left--;
      }
      var pos = {}; s1.concat(s2).forEach(function (i, n) { pos[i] = n; });
      // layering edges among real boxes (reversed where they go against the order)
      var E = [], pred = {}, succ = {};
      real.forEach(function (i) { pred[i] = []; succ[i] = []; });
      real.forEach(function (s) { for (var t in out[s]) { if (node[t].chip) continue; var u = s, v = t; if (pos[s] > pos[t]) { u = t; v = s; } if (succ[u].indexOf(v) < 0) { succ[u].push(v); pred[v].push(u); } } });
      var L = {}, done = {};
      function lp(i) { if (done[i] !== undefined) return L[i]; done[i] = 1; var m = 0; pred[i].forEach(function (p) { m = Math.max(m, lp(p) + 1); }); L[i] = m; return m; }
      real.forEach(lp);
      real.forEach(function (i) { if (!pred[i].length && succ[i].length) L[i] = Math.min.apply(null, succ[i].map(function (s) { return L[s]; })) - 1; });
      var internal = real.filter(function (i) { return pred[i].length || succ[i].length; });
      var maxL = internal.length ? Math.max.apply(null, internal.map(function (i) { return L[i]; })) : 0;
      real.forEach(function (i) {
        if (pred[i].length || succ[i].length) return;
        var hasIn = false; for (var j in inn[i]) if (node[j].chip === 'in') hasIn = true;
        L[i] = hasIn || !internal.length ? 0 : maxL;
      });
      // compact layers, then put chips outside
      var used = {}; real.forEach(function (i) { used[L[i]] = 1; });
      var lv = Object.keys(used).map(Number).sort(function (x, y) { return x - y; }), remap = {};
      lv.forEach(function (l, n) { remap[l] = n; });
      real.forEach(function (i) { L[i] = remap[L[i]] + 1; });
      var nL = lv.length, hasInChip = false, hasOutChip = false;
      conn.forEach(function (i) { if (node[i].chip === 'in') { L[i] = 0; hasInChip = true; } else if (node[i].chip === 'out') { L[i] = nL + 1; hasOutChip = true; } });
      // all layering edges incl. chips, oriented low -> high layer
      var LE = [];
      conn.forEach(function (s) { for (var t in out[s]) { var u = s, v = t; if (L[u] > L[v]) { u = t; v = s; } LE.push({ u: u, v: v, w: out[s][t] }); } });
      // merge duplicates (2-cycles)
      var lem = {}; LE.forEach(function (e) { var k = e.u + '|' + e.v; if (lem[k]) lem[k].w += e.w; else lem[k] = e; }); LE = Object.keys(lem).map(function (k) { return lem[k]; });
      // dummies for long edges
      var layers = []; for (var l = 0; l <= nL + 1; l++) layers.push([]);
      conn.forEach(function (i) { layers[L[i]].push(i); });
      var nodes = {}; conn.forEach(function (i) { nodes[i] = node[i]; });
      var adj = []; // segments between adjacent layers
      LE.forEach(function (e) {
        var chainIds = [e.u];
        for (var l2 = L[e.u] + 1; l2 < L[e.v]; l2++) {
          var did = 'd:' + e.u + '|' + e.v + ':' + l2;
          nodes[did] = { id: did, w: 0, h: C.DUMH, dummy: true }; L[did] = l2; layers[l2].push(did); chainIds.push(did);
        }
        chainIds.push(e.v);
        if (chainIds.length > 2) R.dummies[e.u + '|' + e.v] = chainIds.slice(1, -1);
        for (var c2 = 0; c2 < chainIds.length - 1; c2++) adj.push({ u: chainIds[c2], v: chainIds[c2 + 1], w: e.w });
      });
      // ordering: barycenter sweeps, keep the best
      var idx = {};
      function reindex() { layers.forEach(function (ly) { ly.forEach(function (i, n) { idx[i] = n; }); }); }
      layers.forEach(function (ly) { ly.sort(function (x, y) { return (ord[x] !== undefined ? ord[x] : 1e6) - (ord[y] !== undefined ? ord[y] : 1e6) || (x < y ? -1 : 1); }); });
      reindex();
      var nb = {}; Object.keys(nodes).forEach(function (i) { nb[i] = { up: [], dn: [] }; });
      adj.forEach(function (e) { nb[e.v].up.push({ o: e.u, w: e.w }); nb[e.u].dn.push({ o: e.v, w: e.w }); });
      function crossings() {
        var c = 0;
        for (var l3 = 0; l3 < layers.length - 1; l3++) {
          var es = adj.filter(function (e) { return L[e.u] === l3; });
          for (var x = 0; x < es.length; x++) for (var y = x + 1; y < es.length; y++) {
            var a1 = idx[es[x].u] - idx[es[y].u], b1 = idx[es[x].v] - idx[es[y].v];
            if (a1 * b1 < 0) c += es[x].w * es[y].w;
          }
        }
        return c;
      }
      function sweep(l4, dir) {
        var ly = layers[l4], bc = {};
        ly.forEach(function (i) {
          var ns = dir === 'dn' ? nb[i].up : nb[i].dn, s = 0, w = 0;
          ns.forEach(function (x) { s += idx[x.o] * x.w; w += x.w; });
          bc[i] = w ? s / w : idx[i];
        });
        ly.sort(function (x, y) { return bc[x] - bc[y] || idx[x] - idx[y]; });
        ly.forEach(function (i, n) { idx[i] = n; });
      }
      var best2 = layers.map(function (ly) { return ly.slice(); }), bestC = crossings();
      for (var it = 0; it < 10 && bestC > 0; it++) {
        for (var l5 = 1; l5 < layers.length; l5++) sweep(l5, 'dn');
        for (var l6 = layers.length - 2; l6 >= 0; l6--) sweep(l6, 'up');
        var cc = crossings(); if (cc < bestC) { bestC = cc; best2 = layers.map(function (ly) { return ly.slice(); }); }
      }
      layers = best2; reindex();
      // x: columns
      var colX, colW, x0;
      function cols(cg) {
        colX = []; colW = []; x0 = 0;
        layers.forEach(function (ly, l7) {
          var w = 0; ly.forEach(function (i) { w = Math.max(w, nodes[i].w); });
          if (!ly.length) w = 0; else if (!w) w = 40;
          colW.push(w); colX.push(x0); if (w) x0 += w + ((l7 === 0 && hasInChip) || (l7 === layers.length - 2 && hasOutChip) ? cg : C.GX);
        });
      }
      cols(C.GX);
      if (x0 - C.GX > 1180) cols(C.CGX);
      var mainW = 0; colX.forEach(function (x, l9) { if (colW[l9]) mainW = Math.max(mainW, x + colW[l9]); });
      // y: start stacked, then pull towards neighbours a few times
      var Y = {};
      layers.forEach(function (ly) { var y = 0; ly.forEach(function (i, n) { Y[i] = y; y += nodes[i].h + (n < ly.length - 1 ? gapBetween(nodes[i], nodes[ly[n + 1]]) : 0); }); });
      var tallest = 0; layers.forEach(function (ly) { if (ly.length) { var last = ly[ly.length - 1]; tallest = Math.max(tallest, Y[last] + nodes[last].h); } });
      layers.forEach(function (ly) { if (!ly.length) return; var last = ly[ly.length - 1], hh = Y[last] + nodes[last].h, d = (tallest - hh) / 2; ly.forEach(function (i) { Y[i] += d; }); });
      function cy(i) { return Y[i] + nodes[i].h / 2; }
      function pull(l8, use) {
        var ly = layers[l8]; if (!ly.length) return;
        var des = [], wt = [];
        ly.forEach(function (i) {
          var s = 0, w = 0;
          if (use !== 'dn') nb[i].up.forEach(function (x) { s += cy(x.o) * x.w; w += x.w; });
          if (use !== 'up') nb[i].dn.forEach(function (x) { s += cy(x.o) * x.w; w += x.w; });
          des.push(w ? s / w - nodes[i].h / 2 : Y[i]); wt.push(w ? (nodes[i].dummy ? 0.6 : 1) * Math.min(w, 4) : 0.05);
        });
        var t = placeColumn(ly.map(function (i) { return nodes[i]; }), des, wt);
        ly.forEach(function (i, n) { Y[i] = t[n]; });
      }
      for (var it2 = 0; it2 < 6; it2++) {
        for (var a3 = 1; a3 < layers.length; a3++) pull(a3, 'dn');
        for (var b3 = layers.length - 2; b3 >= 0; b3--) pull(b3, 'up');
      }
      for (var c3 = 0; c3 < layers.length; c3++) pull(c3, 'both');
      var minY = 1e9, maxY = -1e9;
      Object.keys(nodes).forEach(function (i) { minY = Math.min(minY, Y[i]); maxY = Math.max(maxY, Y[i] + nodes[i].h); });
      if (!conn.length) { minY = 0; maxY = 0; }
      // grid of boxes that link to nothing
      var gx0 = hasInChip ? colX[1] : 0, gy0 = conn.length ? maxY - minY + (iso.length ? 26 : 0) : 0;
      var gridItems = [];
      if (iso.length) {
        var limit;
        if (conn.length) limit = Math.max(mainW - gx0 - (hasOutChip ? colW[colW.length - 1] + C.CGX : 0), 2 * C.BW + C.GY);
        else { var cols = iso.length <= 3 ? iso.length : iso.length === 4 ? 2 : iso.length <= 9 ? 3 : 4; limit = cols * C.BW + (cols - 1) * C.GY; }
        if (conn.length) { R.grid = { x: gx0, y: gy0, w: limit }; gy0 += C.GRIDHEAD; }
        var gx = 0, gy = 0, rowH = 0;
        iso.forEach(function (i) {
          var n = node[i];
          if (gx > 0 && gx + n.w > limit + 1) { gx = 0; gy += rowH + C.GY; rowH = 0; }
          gridItems.push({ id: i, x: gx0 + gx, y: gy0 + gy }); gx += n.w + C.GY; rowH = Math.max(rowH, n.h);
        });
        gy0 += gy + rowH;
      }
      // collect
      Object.keys(nodes).forEach(function (i) {
        var n = nodes[i], it3 = { id: i, x: colX[L[i]] + (colW[L[i]] - n.w) / 2, y: Y[i] - minY, w: n.w, h: n.h, layer: L[i] };
        if (n.dummy) { it3.x = colX[L[i]]; it3.w = colW[L[i]]; it3.dummy = true; R.layer[i] = L[i]; R.items.push(it3); return; }
        if (n.chip) { it3.chip = n.chip; it3.key = n.key; R.chips.push(it3); R.layer[i] = L[i]; return; }
        it3.sub = n.sub; R.layer[i] = L[i]; R.items.push(it3);
      });
      gridItems.forEach(function (g) { var n = node[g.id]; R.items.push({ id: g.id, x: g.x, y: g.y, w: n.w, h: n.h, sub: n.sub, grid: true }); });
      var W = mainW, H = conn.length ? gy0 : gy0;
      R.items.forEach(function (i) { W = Math.max(W, i.x + i.w); H = Math.max(H, i.y + i.h); });
      R.w = W; R.h = H;
      return R;
    }

    function rect(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
    function hit(a, b, m) { return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m; }

    function layout(rootId, open) {
      open = open || {};
      var top = layoutBox(rootId, open, true, rootId);
      var out = { root: rootId, w: top.w, h: top.h, boxes: [], conts: [], chips: [], edges: [], labels: [], grids: [], pos: {} };
      var dummyAt = {}, layerIn = {}, contOf = {};
      function flat(R, ox, oy, cid, depth) {
        layerIn[cid] = R.layer;
        if (R.grid) out.grids.push({ x: ox + R.grid.x, y: oy + R.grid.y, w: R.grid.w, cont: cid });
        R.items.forEach(function (it) {
          if (it.dummy) { dummyAt[cid + '#' + it.id] = { x1: ox + it.x, x2: ox + it.x + it.w, y: oy + it.y + it.h / 2 }; return; }
          var b = { id: it.id, x: ox + it.x, y: oy + it.y, w: it.w, h: it.h, depth: depth, cont: cid, open: !!it.sub, grid: !!it.grid };
          contOf[it.id] = cid;
          out.pos[it.id] = b;
          if (it.sub) {
            out.conts.push(b);
            var sx = b.x + (b.w - it.sub.w) / 2, sy = b.y + C.HEAD + 6;
            flat(it.sub, sx, sy, it.id, depth + 1);
          }
          out.boxes.push(b);
        });
        R.chips.forEach(function (it) { var c = { id: it.id, key: it.key, side: it.chip, x: ox + it.x, y: oy + it.y, w: it.w, h: it.h }; out.chips.push(c); out.pos[it.id] = c; });
        Object.keys(R.dummies).forEach(function (k) { dummyAt[cid + '@' + k] = R.dummies[k]; });
      }
      flat(top, 0, 0, rootId, 0);
      // which box shows a node
      function vis(id) {
        var c = childOn(rootId, id); if (!c) return null;
        while (c !== id && out.pos[c] && out.pos[c].open) { var n = childOn(c, id); if (!n) break; c = n; }
        return c;
      }
      function lca(p, q) { // deepest container (root or open box) holding both
        if (p.indexOf(':') > 0 || q.indexOf(':') > 0) return rootId;
        var a = chain(p), b = chain(q), c = rootId;
        for (var i = a.indexOf(rootId) + 1; i < a.length && a[i] === b[i]; i++) { if (out.pos[a[i]] && out.pos[a[i]].open) c = a[i]; else break; }
        return c;
      }
      function rollAt(cid, id) { return id.indexOf(':') > 0 ? id : childOn(cid, id); }
      // visible pairs
      var P = {}, plist = [];
      links.forEach(function (Lk) {
        var p = vis(Lk.s), q = vis(Lk.t), a, b, ghost = false;
        if (!p && !q) return;
        if (p && q) {
          if (p === q) return;
          if (chain(q).indexOf(p) >= 0 || chain(p).indexOf(q) >= 0) return;
          a = p; b = q;
        } else if (p) { a = p; b = 'out:' + ghostKey(rootId, Lk.t); ghost = true; } else { a = 'in:' + ghostKey(rootId, Lk.s); b = q; ghost = true; }
        var k = a < b ? a + '|' + b : b + '|' + a, e = P[k];
        if (!e) { e = P[k] = { a: a < b ? a : b, b: a < b ? b : a, labels: [], arrowA: false, arrowB: false, ghost: ghost, links: 0 }; plist.push(e); }
        if (Lk.label && e.labels.indexOf(Lk.label) < 0) e.labels.push(Lk.label);
        e.links++;
        var toB = b === e.b; if (toB) e.arrowB = true; else e.arrowA = true;
        if (Lk.both) { e.arrowA = true; e.arrowB = true; }
      });
      // route
      var dumUse = {};
      plist.forEach(function (e) {
        var C0 = lca(e.a, e.b), ra = rollAt(C0, e.a), rb = rollAt(C0, e.b), la = layerIn[C0][ra], lb = layerIn[C0][rb];
        var lft = e.a, rgt = e.b, ru = ra, rv = rb;
        if (la > lb) { lft = e.b; rgt = e.a; ru = rb; rv = ra; }
        e.left = lft; e.right = rgt; e.arrowL = lft === e.a ? e.arrowA : e.arrowB; e.arrowR = rgt === e.a ? e.arrowA : e.arrowB;
        var dk = C0 + '@' + ru + '|' + rv, wps = [];
        (dummyAt[dk] || []).forEach(function (did) { var d = dummyAt[C0 + '#' + did]; if (!d) return; var u = dumUse[did] = (dumUse[did] || 0) + 1; wps.push({ x1: d.x1, x2: d.x2, y: d.y, did: did, n: u - 1 }); });
        e.wps = wps;
        e.text = e.labels.join(' · ');
      });
      // spread several edges through one dummy
      plist.forEach(function (e) { e.wps.forEach(function (w) { var tot = dumUse[w.did]; w.y += (w.n - (tot - 1) / 2) * 6; }); });
      // ports
      var ports = {};
      plist.forEach(function (e) {
        var A = out.pos[e.left], B = out.pos[e.right];
        var nextA = e.wps.length ? e.wps[0].y : B.y + B.h / 2, nextB = e.wps.length ? e.wps[e.wps.length - 1].y : A.y + A.h / 2;
        (ports[e.left + '>R'] = ports[e.left + '>R'] || []).push({ e: e, end: 'L', t: nextA });
        (ports[e.right + '>L'] = ports[e.right + '>L'] || []).push({ e: e, end: 'R', t: nextB });
      });
      Object.keys(ports).forEach(function (k) {
        var id = k.split('>')[0], side = k.split('>')[1], B = out.pos[id], arr = ports[k];
        arr.sort(function (x, y) { return x.t - y.t; });
        var top0 = B.open ? B.y + 18 : B.y + 22, bot = B.open ? B.y + Math.min(B.h - 18, C.HEAD + 200) : B.y + B.h - 22;
        if (B.key) { top0 = B.y + 12; bot = B.y + B.h - 12; }
        if (B.open) { top0 = B.y + 22; bot = B.y + B.h - 22; }
        arr.forEach(function (p, n) {
          var y = arr.length === 1 ? Math.max(top0, Math.min(bot, (B.y + B.h / 2))) : top0 + (bot - top0) * (n + 0.5) / arr.length;
          if (arr.length === 1 && !B.key && !B.open) y = B.y + B.h / 2;
          if (arr.length === 1 && B.open) y = Math.max(top0, Math.min(bot, p.t));
          var x = side === 'R' ? B.x + B.w : B.x;
          if (p.end === 'L') p.e.p0 = { x: x, y: y }; else p.e.p1 = { x: x, y: y };
        });
      });
      // geometry
      plist.forEach(function (e) {
        var pts = [e.p0]; e.wps.forEach(function (w) { pts.push({ x: w.x1, y: w.y }); pts.push({ x: w.x2, y: w.y }); }); pts.push(e.p1);
        var d = 'M' + r1(pts[0].x) + ' ' + r1(pts[0].y), segs = [];
        for (var i = 0; i < pts.length - 1; i++) {
          var p = pts[i], q = pts[i + 1];
          if (Math.abs(q.y - p.y) < 0.5 && i > 0 && i < pts.length - 2 && (i % 2 === 1)) { d += ' L' + r1(q.x) + ' ' + r1(q.y); segs.push({ p: p, q: q, line: true }); continue; }
          var dx = Math.max(16, (q.x - p.x) * 0.5);
          var c1 = { x: p.x + dx, y: p.y }, c2 = { x: q.x - dx, y: q.y };
          d += ' C' + r1(c1.x) + ' ' + r1(c1.y) + ' ' + r1(c2.x) + ' ' + r1(c2.y) + ' ' + r1(q.x) + ' ' + r1(q.y);
          segs.push({ p: p, q: q, c1: c1, c2: c2 });
        }
        e.d = d; e.segs = segs;
      });
      // labels: first spot along the path that is clear of boxes, chips and other labels
      var obst = [];
      out.boxes.forEach(function (b) { obst.push(b.open ? rect(b.x, b.y, b.w, C.HEAD) : rect(b.x, b.y, b.w, b.h)); });
      out.chips.forEach(function (c) { obst.push(rect(c.x, c.y, c.w, c.h)); });
      out.grids.forEach(function (g) { obst.push(rect(g.x, g.y, 180, C.GRIDHEAD - 6)); });
      var placed = [];
      plist.slice().sort(function (x, y) { return (x.ghost - y.ghost) || (x.p0.x - y.p0.x) || (x.p0.y - y.p0.y); }).forEach(function (e) {
        if (!e.text) return;
        var sz = est(e.text), samples = [];
        e.segs.forEach(function (s, si) {
          for (var k = 1; k < 12; k++) { var t = k / 12, pt = s.line ? { x: s.p.x + (s.q.x - s.p.x) * t, y: s.p.y } : bez(s, t); samples.push({ x: pt.x, y: pt.y, si: si, t: t }); }
        });
        var pref = function (sm) { var segPref = e.ghost ? (e.left.indexOf(':') > 0 ? 0 : e.segs.length - 1) : 0; return Math.abs(sm.si - segPref) * 2 + Math.abs(sm.t - 0.5); };
        samples.sort(function (x, y) { return pref(x) - pref(y); });
        var got = null;
        for (var i = 0; i < samples.length && !got; i++) {
          var r = rect(samples[i].x - sz.w / 2, samples[i].y - sz.h / 2, sz.w, sz.h), ok = r.x >= 0 && r.y >= -4 && r.x + r.w <= out.w;
          for (var j = 0; ok && j < obst.length; j++) if (hit(r, obst[j], 4)) ok = false;
          for (var j2 = 0; ok && j2 < placed.length; j2++) if (hit(r, placed[j2], 3)) ok = false;
          if (ok) got = r;
        }
        if (got) { placed.push(got); out.labels.push({ edge: e, x: got.x, y: got.y, w: got.w, h: got.h, lines: sz.lines, text: e.text }); e.label = got; }
        else { var s0 = samples[0]; out.labels.push({ edge: e, x: s0.x - sz.w / 2, y: s0.y - sz.h / 2, w: sz.w, h: sz.h, lines: sz.lines, text: e.text, over: true }); }
      });
      out.edges = plist;
      var minY = 0; out.labels.forEach(function (l) { if (!l.over) minY = Math.min(minY, l.y); });
      out.top = Math.ceil(-minY);
      return out;
    }
    function r1(v) { return Math.round(v * 10) / 10; }
    function bez(s, t) {
      var u = 1 - t;
      return { x: u * u * u * s.p.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.q.x, y: u * u * u * s.p.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.q.y };
    }
    return { layout: layout, C: C, kids: kids, topOf: topOf, chain: chain, childOn: childOn, ghostKey: ghostKey, links: links, hit: hit };
  }
  /*LAYOUT-END*/

  /* ---------- index ---------- */
  var byId = {}, list = [], inc = {}, flowsOf = {};
  function index(n, p, d) {
    n.children = n.children || []; n._p = p ? p.id : null; n._d = d; byId[n.id] = n; list.push(n);
    n.children.forEach(function (c) { index(c, n, d + 1); });
  }
  (D.tree || []).forEach(function (n) { index(n, null, 0); });
  function roll(n) {
    var c = { live: 0, unverified: 0, draft: 0, planned: 0, total: 0 };
    if (n.kind !== 'group' || !n.children.length) { c[n.status || 'live']++; c.total++; }
    n.children.forEach(function (ch) { var r = roll(ch); for (var k in c) c[k] += r[k]; });
    n._c = c; return c;
  }
  (D.tree || []).forEach(roll);
  list.forEach(function (n) {
    (n.talksTo || []).forEach(function (t) {
      if (!byId[t.to]) return;
      var back = t.dir === 'out' ? 'in' : t.dir === 'in' ? 'out' : 'both';
      (inc[t.to] = inc[t.to] || []).push({ other: n.id, label: t.label, dir: back });
    });
  });
  (D.flows || []).forEach(function (f) { (f.steps || []).forEach(function (s) { var a = flowsOf[s.node] = flowsOf[s.node] || []; if (a.indexOf(f.id) < 0) a.push(f.id); }); });
  var flowById = {}; (D.flows || []).forEach(function (f) { flowById[f.id] = f; });
  var totals = { live: 0, unverified: 0, draft: 0, planned: 0, total: 0 };
  (D.tree || []).forEach(function (n) { for (var k in totals) totals[k] += n._c[k]; });
  list.forEach(function (n) {
    n._hay = [n.title, n.summary, (n.details || []).join(' '), (n.files || []).join(' '), (n.notes || []).join(' '), n.pr || '', (n.talksTo || []).map(function (t) { return t.label; }).join(' ')].join(' \n ').toLowerCase();
  });
  function path(n) { var a = [], p = n; while (p) { a.unshift(p); p = p._p ? byId[p._p] : null; } return a; }
  function topOf(id) { var n = byId[id]; while (n && n._p) n = byId[n._p]; return n; }
  function isUnder(id, anc) { var n = byId[id]; while (n) { if (n.id === anc) return true; n = n._p ? byId[n._p] : null; } return false; }
  var LAY = makeLayout(D.tree || []);
  var reduceMotion = function () { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); };
  var isNarrow = function () { return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches); };

  /* ---------- state ---------- */
  var S = { tab: 'diag', sel: null, open: {}, q: '', st: { live: 1, unverified: 1, draft: 1, planned: 1 }, flow: null, flowPick: (D.flows && D.flows[0] && D.flows[0].id) || null, sheet: false, fresh: {}, pulse: null,
    root: null, dopen: {}, back: [], z: 1, fit: true, dflow: null, hot: null, last: null };
  try { var saved = JSON.parse(localStorage.getItem('hh.studio.archOpen') || '[]'); if (Array.isArray(saved)) saved.forEach(function (id) { if (byId[id]) S.open[id] = 1; }); } catch (x) { /* ignore */ }
  try { var dsaved = JSON.parse(localStorage.getItem('hh.studio.archDiagOpen') || '[]'); if (Array.isArray(dsaved)) dsaved.forEach(function (id) { if (byId[id] && byId[id].children.length) S.dopen[id] = 1; }); } catch (x) { /* ignore */ }
  function persist() { try { localStorage.setItem('hh.studio.archOpen', JSON.stringify(Object.keys(S.open))); localStorage.setItem('hh.studio.archDiagOpen', JSON.stringify(Object.keys(S.dopen))); } catch (x) { /* ignore */ } }
  function filterActive() { return STATUS.some(function (s) { return !S.st[s.id]; }); }

  /* ---------- visibility ---------- */
  var VIS;
  function flowSet() { var f = S.flow && flowById[S.flow], m = {}; if (f) f.steps.forEach(function (s, i) { (m[s.node] = m[s.node] || []).push(i + 1); }); return f ? m : null; }
  function compute() {
    var q = S.q, fs = flowSet(), vis = {}, forced = {}, matchN = 0;
    function walk(n, am) {
      var tm = !q || n._hay.indexOf(q) >= 0;
      var sm = n.kind === 'group' && n.children.length ? true : !!S.st[n.status];
      var inflow = fs ? !!fs[n.id] : true;
      var self = tm && sm && inflow;
      var anyKid = false;
      n.children.forEach(function (c) {
        var r = walk(c, am || (!!q && tm));
        if (r) anyKid = true;
      });
      var showNow = self || anyKid || (am && sm && inflow && !fs);
      if (showNow) vis[n.id] = true;
      if (anyKid && (q || filterActive() || fs)) forced[n.id] = true;
      if (self && q && n.kind !== 'group') matchN++;
      return showNow;
    }
    (D.tree || []).forEach(function (n) { walk(n, false); });
    VIS = { vis: vis, forced: forced, count: matchN, flow: fs };
  }
  function isOpen(n) { return !!(S.open[n.id] || VIS.forced[n.id]); }
  /* diagram search + status filter: which boxes hold a match (themselves or inside) */
  function diagHits() {
    if (!S.q && !filterActive()) return null;
    var hits = {}, self = {};
    function walk(n) {
      var tm = !S.q || n._hay.indexOf(S.q) >= 0, sm = n.kind === 'group' && n.children.length ? !S.q || tm : !!S.st[n.status || 'live'];
      var me = tm && sm && !(n.kind === 'group' && n.children.length && !S.q), any = false;
      n.children.forEach(function (c) { if (walk(c)) any = true; });
      if (n.kind === 'group' && n.children.length && S.q && tm && filterActive()) me = any;
      if (me) self[n.id] = 1;
      if (me || any) hits[n.id] = 1;
      return me || any;
    }
    (D.tree || []).forEach(walk);
    return { hits: hits, self: self };
  }

  /* ---------- text helpers ---------- */
  function hl(t) {
    t = String(t == null ? '' : t); if (!S.q) return esc(t);
    var lo = t.toLowerCase(), q = S.q, out = '', i = 0, j;
    while ((j = lo.indexOf(q, i)) >= 0) { out += esc(t.slice(i, j)) + '<mark>' + esc(t.slice(j, j + q.length)) + '</mark>'; i = j + q.length; }
    return out + esc(t.slice(i));
  }
  function pill(s) { var x = STNAME[s] || STNAME.live; return '<span class="ar-pill s-' + s + '" title="' + esc(x.hint) + '">' + stIco(s) + esc(x.name) + '</span>'; }
  function bar(c, big) {
    if (!c.total) return '';
    var h = '<span class="ar-bar' + (big ? ' big' : '') + '" role="img" aria-label="' + STATUS.map(function (s) { return c[s.id] + ' ' + s.name.toLowerCase(); }).join(', ') + '">';
    STATUS.forEach(function (s) { if (c[s.id]) h += '<i class="b-' + s.id + '" style="flex:' + c[s.id] + ' 1 0"></i>'; });
    return h + '</span>';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : /(ch|sh|s|x)$/.test(w) ? 'es' : 's'); }

  /* ---------- scaffold ---------- */
  function scaffold() {
    var h = '<div class="ar-intro"><div><h2>' + esc(D.title || 'Architecture') + '</h2><p>' + esc(D.intro || '') + '</p></div><div class="ar-asof">' + esc(D.asOf || '') + '</div></div>';
    h += '<div class="ar-score" id="arScore" role="group" aria-label="Filter by status"></div>';
    h += '<div class="ar-top"><div class="ar-tabs" role="tablist" aria-label="Views">' +
      '<button type="button" class="ar-tab" role="tab" data-tab="diag">Big picture</button>' +
      '<button type="button" class="ar-tab" role="tab" data-tab="tree">Tree</button>' +
      '<button type="button" class="ar-tab" role="tab" data-tab="flows">Data flows <span class="ar-count">(' + (D.flows || []).length + ')</span></button></div>' +
      '<div class="ar-tools" id="arTools"><div class="ar-search"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>' +
      '<input type="search" id="arQ" placeholder="Search parts, files, services…" aria-label="Search the architecture" autocomplete="off" spellcheck="false"><button type="button" class="ar-x" id="arQx" aria-label="Clear search" hidden>×</button></div>' +
      '<button type="button" class="btn" data-act="expandAll">Expand all</button><button type="button" class="btn" data-act="collapseAll">Collapse all</button><span class="ar-count" id="arCount" aria-live="polite"></span></div>' +
      '<div class="ar-hits" id="arHits" hidden></div></div>';
    h += '<div id="arBody" class="ar-body"><div class="ar-maincol"><div id="arTreeView" class="ar-treewrap"><div id="arBanner"></div><ul class="ar-tree" id="arTree" role="tree" aria-label="Home Hub architecture"></ul></div><div id="arDiagView" class="ar-dgview"></div></div><aside class="ar-detail" id="arDetail" aria-label="Details"></aside></div>';
    h += '<div id="arFlowView" class="ar-flows" hidden></div>';
    host.innerHTML = h;
  }

  /* ---------- tree ---------- */
  function rowHtml(n) {
    var open = isOpen(n), kids = n.children.filter(function (c) { return VIS.vis[c.id]; });
    var grp = n.children.length > 0, fs = VIS.flow && VIS.flow[n.id];
    var cls = (grp ? 'is-group ' : '') + 'depth' + Math.min(n._d, 2) + (S.fresh[n.id] ? ' ar-new' : '') + (S.pulse === n.id ? ' ar-pulse' : '');
    var h = '<li role="treeitem" tabindex="-1" data-id="' + esc(n.id) + '" class="' + cls + '" aria-level="' + (n._d + 1) + '" aria-selected="' + (S.sel === n.id) + '"' + (grp ? ' aria-expanded="' + open + '"' : '') + '>';
    h += '<div class="ar-row" data-row="' + esc(n.id) + '">';
    h += grp ? '<button type="button" class="ar-chev" tabindex="-1" data-act="toggle" data-id="' + esc(n.id) + '" aria-label="' + (open ? 'Collapse ' : 'Expand ') + esc(n.title) + '">' + CHEV + '</button>' : '<span class="ar-chev"></span>';
    h += '<span class="ar-kind" title="' + esc(KIND[n.kind] || '') + '">' + kindIco(n.kind) + '</span>';
    h += '<span class="ar-main"><span class="ar-line"><span class="ar-title">' + hl(n.title) + '</span>';
    if (fs) h += fs.map(function (x) { return '<span class="ar-badge" title="Step ' + x + ' of the flow">' + x + '</span>'; }).join('');
    if (!grp || n.kind !== 'group') h += pill(n.status || 'live');
    if (n.pr) h += '<span class="ar-pr">' + esc(n.pr) + '</span>';
    h += '</span>' + (n.summary ? '<span class="ar-sum">' + hl(n.summary) + '</span>' : '') + '</span>';
    if (grp) h += '<span class="ar-roll">' + bar(n._c) + '<small>' + plural(n._c.total, 'part') + '</small><button type="button" class="ar-info" tabindex="-1" data-act="info" data-id="' + esc(n.id) + '">Details</button></span>';
    h += '</div>';
    if (grp && open && kids.length) h += '<ul role="group">' + kids.map(rowHtml).join('') + '</ul>';
    return h + '</li>';
  }
  function renderTree() {
    compute();
    var roots = (D.tree || []).filter(function (n) { return VIS.vis[n.id]; });
    var t = document.getElementById('arTree');
    var focusId = document.activeElement && document.activeElement.closest && document.activeElement.closest('#arTree') ? (document.activeElement.getAttribute('data-id')) : null;
    t.innerHTML = roots.length ? roots.map(rowHtml).join('') : '<li class="ar-empty" role="none">Nothing matches' + (S.q ? ' “' + esc(S.q) + '”' : '') + (filterActive() ? ' with these status filters' : '') + '. <button type="button" class="btn" data-act="clearAll">Clear search and filters</button></li>';
    S.fresh = {}; S.pulse = null;
    var first = t.querySelector('[data-id="' + (focusId || S.sel || '') + '"]') || t.querySelector('[role=treeitem]');
    if (first) first.tabIndex = 0;
    if (focusId && t.querySelector('[data-id="' + focusId + '"]')) t.querySelector('[data-id="' + focusId + '"]').focus();
    var b = document.getElementById('arBanner');
    if (S.flow) { var f = flowById[S.flow]; b.innerHTML = '<div class="ar-banner"><span>Showing only the parts in <b>' + esc(f.title) + '</b>. Numbers are the steps.</span><button type="button" class="btn" data-act="flowExit">Show everything</button></div>'; } else b.innerHTML = '';
    updateCount();
  }
  function updateCount() {
    var ct = document.getElementById('arCount');
    if (S.tab === 'tree') ct.textContent = (S.q || filterActive() || S.flow) ? plural(VIS.count || Object.keys(VIS.vis).length, 'match') : '';
    else { var r = diagHits(); ct.textContent = r && S.q ? plural(Object.keys(r.self).filter(function (id) { return byId[id].kind !== 'group'; }).length, 'match') : ''; }
    document.getElementById('arQx').hidden = !S.q;
    renderHits();
  }
  /* on the diagram, search results are a row of buttons that open the part where it lives */
  function renderHits() {
    var el = document.getElementById('arHits');
    if (S.tab !== 'diag' || !S.q) { el.hidden = true; el.innerHTML = ''; return; }
    var r = diagHits(), ids = r ? Object.keys(r.self).filter(function (id) { return byId[id].kind !== 'group' || !byId[id].children.length; }) : [];
    ids.sort(function (a, b) { return list.indexOf(byId[a]) - list.indexOf(byId[b]); });
    var h = '<span class="ar-hitlab">' + (ids.length ? 'Open a match:' : 'Nothing matches “' + esc(S.q) + '”.') + '</span>';
    ids.slice(0, 10).forEach(function (id) { var n = byId[id], t = topOf(id); h += '<button type="button" class="ar-hit" data-dgo="' + esc(id) + '" data-g="' + esc(t.id) + '"><b>' + hl(n.title) + '</b><small>' + esc(t.title) + '</small></button>'; });
    if (ids.length > 10) h += '<span class="ar-count">and ' + (ids.length - 10) + ' more (the Tree tab lists them all)</span>';
    el.innerHTML = h; el.hidden = false;
  }
  function renderScore() {
    var h = '';
    STATUS.forEach(function (s) {
      h += '<button type="button" class="ar-stat" data-st="' + s.id + '" aria-pressed="' + !!S.st[s.id] + '"><b>' + totals[s.id] + '</b><span>' + stIco(s.id) + esc(s.name) + '</span><small>' + esc(s.short) + '</small></button>';
    });
    document.getElementById('arScore').innerHTML = h;
  }

  /* ---------- detail ---------- */
  function linkRow(id, label, dir, extra) {
    var o = byId[id]; if (!o) return '';
    var ar = dir === 'out' ? '→' : dir === 'in' ? '←' : '↔', aria = dir === 'out' ? 'sends to' : dir === 'in' ? 'receives from' : 'both ways with';
    var top = path(o).slice(0, -1).map(function (x) { return x.title; });
    return '<li><button type="button" class="ar-link" data-goto="' + esc(id) + '"><span class="ar-arrow" aria-label="' + aria + '">' + ar + '</span><span class="t">' + esc(o.title) + (top.length ? ' <em>· ' + esc(top[0]) + '</em>' : '') + '</span>' + (label ? '<span class="l">' + esc(label) + '</span>' : '') + '</button></li>';
  }
  function legendHtml() {
    var h = '<div class="ar-legend">';
    STATUS.forEach(function (s) { h += '<div>' + pill(s.id) + '<span>' + esc(s.hint) + '.</span></div>'; });
    return h + '</div>';
  }
  function renderDetail() {
    var el = document.getElementById('arDetail'), n = S.sel && byId[S.sel], h = '';
    el.classList.toggle('is-open', !!(n && S.sheet));
    if (!n) {
      el.innerHTML = '<div class="ar-sec" style="border:0;padding:0"><h4>How to read this</h4><p class="ar-tip">Tap any part to see what it is, which files hold it and what it talks to. Groups open and close. Links in the detail jump to the other part.</p></div>' + legendHtml() +
        '<p class="ar-tip">Keyboard: <kbd>↑</kbd><kbd>↓</kbd> move, <kbd>→</kbd> opens, <kbd>←</kbd> closes, <kbd>/</kbd> searches.</p>';
      return;
    }
    var anc = path(n).slice(0, -1);
    h += '<button type="button" class="btn ar-close" data-act="closeSheet">Close</button>';
    if (anc.length) h += '<nav class="ar-crumbs" aria-label="Where this sits">' + anc.map(function (a) { return '<button type="button" data-goto="' + esc(a.id) + '">' + esc(a.title) + '</button>'; }).join('<span aria-hidden="true">›</span>') + '</nav>';
    h += '<div><h3>' + esc(n.title) + '</h3></div>';
    h += '<div class="ar-meta">' + (n.kind === 'group' && n.children.length ? '' : pill(n.status || 'live')) + (n.pr ? '<span class="ar-pr">' + esc(n.pr) + ' · open draft</span>' : '') + '<span class="ar-kindtag">' + esc(KIND[n.kind] || n.kind) + '</span></div>';
    h += '<div class="ar-jump">' + (S.tab === 'diag' ? '<button type="button" class="ar-jl" data-treego="' + esc(n.id) + '">Show in tree</button>' + (n.children.length && n.id !== S.root ? '<button type="button" class="ar-jl" data-zoom="' + esc(n.id) + '">Open as its own diagram</button>' : '') : '<button type="button" class="ar-jl" data-diaggo="' + esc(n.id) + '">Show on the diagram</button>') + '</div>';
    if (n.summary) h += '<p class="ar-lead">' + esc(n.summary) + '</p>';
    if (n.children.length) {
      var c = n._c;
      h += '<div class="ar-sec"><h4>Health of the ' + plural(c.total, 'part') + ' inside</h4>' + bar(c, true) + '<p>' + STATUS.filter(function (s) { return c[s.id]; }).map(function (s) { return c[s.id] + ' ' + s.name.toLowerCase(); }).join(' · ') + '</p></div>';
    }
    (n.details || []).forEach(function (p, i) { h += '<div class="ar-sec"' + (i ? ' style="border:0;padding-top:0"' : '') + '>' + (i ? '' : '<h4>What it is</h4>') + '<p>' + esc(p) + '</p></div>'; });
    if ((n.notes || []).length) h += '<div class="ar-sec"><h4>Worth knowing</h4>' + n.notes.map(function (x) { return '<p class="ar-note">' + esc(x) + '</p>'; }).join('') + '</div>';
    if ((n.files || []).length) h += '<div class="ar-sec"><h4>Key files</h4><div class="ar-files">' + n.files.map(function (f) {
      return /^\(PR/.test(f) || /\s/.test(f) ? '<span class="ar-file">' + esc(f) + '</span>' : '<a class="ar-file" target="_blank" rel="noopener" href="' + esc(REPO + f.replace(/\/$/, '')) + '">' + esc(f) + '</a>';
    }).join('') + '</div></div>';
    var seen = {}, rows = [];
    (n.talksTo || []).forEach(function (t) { var k = t.to + '|' + t.label; if (byId[t.to] && !seen[k]) { seen[k] = 1; rows.push({ id: t.to, label: t.label, dir: t.dir || 'out' }); } });
    (inc[n.id] || []).forEach(function (t) { var k = t.other + '|' + t.label; if (!seen[k]) { seen[k] = 1; rows.push({ id: t.other, label: t.label, dir: t.dir }); } });
    ['out', 'in', 'both'].forEach(function (d) {
      var r = rows.filter(function (x) { return x.dir === d; }); if (!r.length) return;
      h += '<div class="ar-sec"><h4>' + (d === 'out' ? 'Sends to' : d === 'in' ? 'Receives from' : 'Talks both ways with') + '</h4><ul class="ar-links">' + r.map(function (x) { return linkRow(x.id, x.label, d); }).join('') + '</ul></div>';
    });
    if (flowsOf[n.id]) h += '<div class="ar-sec"><h4>Appears in these data flows</h4><ul class="ar-links">' + flowsOf[n.id].map(function (id) { return '<li><button type="button" class="ar-link" data-flowgo="' + esc(id) + '" data-node="' + esc(n.id) + '"><span class="ar-arrow" aria-hidden="true">⇢</span><span class="t">' + esc(flowById[id].title) + '</span></button></li>'; }).join('') + '</ul></div>';
    if (n.children.length) h += '<div class="ar-sec ar-kids"><h4>Inside</h4><ul class="ar-links">' + n.children.map(function (k) {
      return '<li><button type="button" class="ar-link" data-goto="' + esc(k.id) + '"><span class="ar-kind">' + kindIco(k.kind) + '</span><span class="t">' + esc(k.title) + '</span>' + (k.kind === 'group' && k.children.length ? '<span class="ar-count">' + plural(k._c.total, 'part') + '</span>' : pill(k.status || 'live')) + '</button></li>';
    }).join('') + '</ul></div>';
    el.innerHTML = h;
    el.scrollTop = 0;
  }

  /* ---------- flows ---------- */
  function renderFlows() {
    var fl = D.flows || [], pick = flowById[S.flowPick] || fl[0], h = '<div class="ar-flowlist" role="group" aria-label="Data flows">';
    fl.forEach(function (f) { h += '<button type="button" class="ar-flowbtn" data-flowpick="' + esc(f.id) + '" aria-pressed="' + (pick && pick.id === f.id) + '"><b>' + esc(f.title) + '</b><span>' + esc(f.summary || '') + '</span><small>' + plural(f.steps.length, 'step') + '</small></button>'; });
    h += '</div>';
    if (pick) {
      h += '<div class="ar-flowpane"><h3>' + esc(pick.title) + '</h3><p>' + esc(pick.summary || '') + '</p><div class="ar-flowact"><button type="button" class="btn primary" data-flowdiag="' + esc(pick.id) + '">Show on the diagram</button><button type="button" class="btn" data-flowshow="' + esc(pick.id) + '">Show these parts in the tree</button></div><ol class="ar-steps">';
      pick.steps.forEach(function (s, i) {
        var o = byId[s.node], top = o ? path(o).slice(0, -1).map(function (x) { return x.title; }).join(' › ') : '';
        h += '<li class="ar-step"><span class="n" aria-hidden="true">' + (i + 1) + '</span><div><button type="button" class="node" data-goto="' + esc(s.node) + '"><span class="nt">' + esc(o ? o.title : s.node) + (o ? pill(o.status || 'live') : '') + '</span>' + (top ? '<span class="where">' + esc(top) + '</span>' : '') + '<span class="say">' + esc(s.say || '') + '</span></button></div></li>';
      });
      h += '</ol></div>';
    }
    document.getElementById('arFlowView').innerHTML = h;
  }
  /* where a flow lives: one group when every step is inside it, otherwise the Big picture */
  function flowHome(f) {
    var t = null, one = true;
    f.steps.forEach(function (s) { var g = byId[s.node] && topOf(s.node).id; if (t === null) t = g; else if (g !== t) one = false; });
    return one ? t : null;
  }

  /* ---------- curves shared by the Big picture and the diagrams ---------- */
  function linkPath(A, B) { // a soft curve from box A to box B, leaving and entering on the facing sides
    var ac = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, bc = { x: B.x + B.w / 2, y: B.y + B.h / 2 }, p, q, c1, c2;
    if (B.x >= A.x + A.w + 8 || A.x >= B.x + B.w + 8) {
      var r = bc.x > ac.x;
      p = { x: r ? A.x + A.w : A.x, y: ac.y }; q = { x: r ? B.x : B.x + B.w, y: bc.y };
      var dx = Math.max(24, Math.abs(q.x - p.x) * 0.5) * (r ? 1 : -1);
      c1 = { x: p.x + dx, y: p.y }; c2 = { x: q.x - dx, y: q.y };
    } else {
      var dn = bc.y > ac.y;
      p = { x: ac.x, y: dn ? A.y + A.h : A.y }; q = { x: bc.x, y: dn ? B.y : B.y + B.h };
      var dy = Math.max(24, Math.abs(q.y - p.y) * 0.5) * (dn ? 1 : -1);
      c1 = { x: p.x, y: p.y + dy }; c2 = { x: q.x, y: q.y - dy };
    }
    return 'M' + p.x + ' ' + p.y + ' C' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + q.x + ' ' + q.y;
  }
  function flowPaths(steps, rectOf) { // dashed arrows between consecutive steps whose boxes both show
    var s = '', prev = null;
    steps.forEach(function (st) {
      var r = rectOf(st.node);
      if (r && prev && prev.id !== r.id) s += '<path class="ar-fpath" d="' + linkPath(prev, r) + '" marker-end="url(#arAhF)"/>';
      if (r) prev = r;
    });
    return s;
  }
  var MARKERS = '<marker id="arAh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 10 5 0 9z"/></marker>' +
    '<marker id="arAhF" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 10 5 0 9z"/></marker>';

  /* ---------- big picture ---------- */
  function mapHtml() {
    var M = D.overview;
    if (!M) return '';
    var f = S.dflow && flowById[S.dflow], hits = diagHits(), badges = {};
    if (f) f.steps.forEach(function (st, i) { var t = byId[st.node] && topOf(st.node).id; if (t) (badges[t] = badges[t] || []).push(i + 1); });
    var s = '<div class="ar-map' + (f ? ' has-flow' : '') + '"><svg viewBox="0 0 ' + M.w + ' ' + M.h + '" role="group" aria-label="How the main parts connect"><defs>' +
      '<marker id="arAr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>' + MARKERS + '</defs>';
    (M.edges || []).forEach(function (e) {
      var d = 'M' + e.pts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L');
      s += '<path class="edge' + (e.dash ? ' dash' : '') + '" d="' + d + '"' + (e.dir !== 'in' ? ' marker-end="url(#arAr)"' : '') + (e.dir === 'both' || e.dir === 'in' ? ' marker-start="url(#arAr)"' : '') + '/>';
      if (e.label) s += '<text class="el" x="' + e.lx + '" y="' + e.ly + '" text-anchor="' + (e.anchor || 'middle') + '">' + esc(e.label) + '</text>';
    });
    var boxAt = {}; (M.boxes || []).forEach(function (b) { boxAt[b.group] = { id: b.group, x: b.x, y: b.y, w: b.w, h: b.h }; });
    if (f) s += '<g class="ar-fl">' + flowPaths(f.steps, function (id) { var t = byId[id] && topOf(id); return t && boxAt[t.id]; }) + '</g>';
    (M.boxes || []).forEach(function (b) {
      var g = byId[b.group], c = g ? g._c : null, dim = (hits && !hits.hits[b.group]) || (f && !badges[b.group]);
      s += '<g class="box' + (dim ? ' is-dim' : '') + (hits && hits.hits[b.group] && S.q ? ' is-hit' : '') + '" tabindex="0" role="button" data-zoom="' + esc(b.group) + '" data-g="' + esc(b.group) + '" aria-label="' + esc(b.title + ': ' + (b.lines || []).join(' ') + '. Open its diagram') + '"><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="14"/>' +
        '<text class="bt" x="' + (b.x + 16) + '" y="' + (b.y + 28) + '">' + esc(b.title) + '</text>' +
        (b.lines || []).map(function (ln, i) { return '<text class="bs" x="' + (b.x + 16) + '" y="' + (b.y + 48 + i * 17) + '">' + esc(ln) + '</text>'; }).join('');
      if (c && c.total) {
        var bx = b.x + 16, bw = b.w - 32, by = b.y + b.h - 18, off = 0;
        STATUS.forEach(function (st) { if (c[st.id]) { var w = bw * c[st.id] / c.total; s += '<rect x="' + (bx + off) + '" y="' + by + '" width="' + Math.max(w - 1, 2) + '" height="6" rx="3" style="stroke:none;fill:var(--s-' + st.id + ')"/>'; off += w; } });
      }
      s += '<g class="zoomhint" aria-hidden="true"><circle cx="' + (b.x + b.w - 22) + '" cy="' + (b.y + 24) + '" r="11"/><path d="M' + (b.x + b.w - 24) + ' ' + (b.y + 19) + 'l5 5-5 5"/></g>';
      if (badges[b.group]) { var bs = badges[b.group], bx2 = b.x + b.w - 14 - bs.length * 24; bs.forEach(function (n, i) { s += '<g class="ar-sbadge"><circle cx="' + (bx2 + i * 24) + '" cy="' + (b.y) + '" r="11"/><text x="' + (bx2 + i * 24) + '" y="' + (b.y + 4) + '" text-anchor="middle">' + n + '</text></g>'; }); }
      s += '</g>';
    });
    s += '</svg></div><p class="ar-mapnote">' + esc(M.note || '') + ' Tap a box to open its own diagram. The coloured strip is how much of each part is live, unverified, draft or planned.</p>';
    return s;
  }

  /* ---------- group diagrams ---------- */
  var MARG = 28;
  function nodeBox(n, b, L, hits, badges) {
    var kids = n.children.length, open = b.open, st = n.status || 'live', grp = n.kind === 'group' && kids;
    var cls = 'ar-node k-' + n.kind + ' s-' + st + (open ? ' is-open' : '') + (kids ? ' has-kids' : '') + (S.sel === n.id ? ' is-sel' : '') +
      (hits ? (hits.hits[n.id] ? (S.q && hits.self[n.id] ? ' is-hit' : '') : ' is-dim') : '') + (badges && !badges[n.id] && !open ? ' is-dim' : '');
    var label = n.title + '. ' + (KIND[n.kind] || n.kind) + (grp ? '' : ', ' + (STNAME[st] || STNAME.live).name) + (kids ? ', ' + plural(kids, 'part') + (open ? ', expanded' : ', press Space to expand') : '') + '. ' + (n.summary || '');
    var h = '<div class="' + cls + '" data-node="' + esc(n.id) + '" role="button" tabindex="0" aria-label="' + esc(label) + '"' + (kids ? ' aria-expanded="' + open + '"' : '') + ' style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + (open ? LAY.C.HEAD : b.h) + 'px">';
    h += '<div class="ar-nh"><span class="ar-tile" title="' + esc(KIND[n.kind] || '') + '">' + tileIco(n.kind) + '</span><span class="ar-nt">' + hl(n.title) + '</span>';
    if (open) h += '<span class="ar-nside">' + (n._c.total > 1 ? bar(n._c) : '') + '<button type="button" class="ar-more" tabindex="-1" aria-hidden="true" data-act="dexp" data-id="' + esc(n.id) + '">− Collapse</button></span>';
    h += '</div>';
    if (!open) {
      h += '<div class="ar-ns">' + hl(n.summary || '') + '</div><div class="ar-nf">';
      h += grp ? '<span class="ar-nst">' + plural(n._c.total, 'part') + '</span>' : '<span class="ar-nst s-' + st + '">' + stIco(st) + esc((STNAME[st] || STNAME.live).name) + '</span>';
      if (n.pr) h += '<span class="ar-npr">' + esc(n.pr) + '</span>';
      if (kids) h += '<button type="button" class="ar-more" tabindex="-1" aria-hidden="true" data-act="dexp" data-id="' + esc(n.id) + '">+ ' + plural(kids, 'part') + '</button>';
      h += '</div>' + stripHtml(n);
    }
    if (badges && badges[n.id]) h += '<span class="ar-nbadges">' + badges[n.id].map(function (x) { return '<i>' + x + '</i>'; }).join('') + '</span>';
    return h + '</div>';
  }
  function stripHtml(n) {
    var c = n.children.length ? n._c : null, h = '<span class="ar-strip" aria-hidden="true">';
    if (c && c.total) STATUS.forEach(function (s) { if (c[s.id]) h += '<i class="b-' + s.id + '" style="flex:' + c[s.id] + ' 1 0"></i>'; });
    else h += '<i class="b-' + (n.status || 'live') + '" style="flex:1"></i>';
    return h + '</span>';
  }
  function crumbsHtml() {
    var h = '<nav class="ar-dcrumbs" aria-label="Where you are"><button type="button" data-crumb=""' + (S.root ? '' : ' aria-current="page"') + '>Big picture</button>';
    if (S.root) path(byId[S.root]).forEach(function (a) { h += '<span aria-hidden="true">›</span><button type="button" data-crumb="' + esc(a.id) + '"' + (a.id === S.root ? ' aria-current="page"' : '') + '>' + esc(a.title) + '</button>'; });
    return h + '</nav>';
  }
  function renderDiag(anim) {
    var el = document.getElementById('arDiagView'), f = S.dflow && flowById[S.dflow];
    Array.prototype.forEach.call(host.querySelectorAll('[data-act=expandAll],[data-act=collapseAll]'), function (b) { b.hidden = !S.root; });
    var h = '<div class="ar-dgbar">' + (S.root ? '<button type="button" class="btn ar-backb" data-act="dback">' + BACK + 'Back</button>' : '') + crumbsHtml() + '<span class="ar-sp"></span>';
    if (S.root) h += '<div class="ar-zoom" role="group" aria-label="Zoom"><button type="button" class="btn" data-act="zout" aria-label="Zoom out">−</button><button type="button" class="btn ar-zv" data-act="zfit" title="Fit to width" aria-label="Fit to width">' + Math.round(S.z * 100) + '%</button><button type="button" class="btn" data-act="zin" aria-label="Zoom in">+</button></div>';
    h += '</div>';
    if (f) h += '<div class="ar-banner"><span>Showing <b>' + esc(f.title) + '</b>. Numbers are the steps; the moving line follows them.</span><button type="button" class="btn" data-act="dflowExit">Clear</button></div>';
    if (!S.root) { el.innerHTML = h + mapHtml(); S.last = null; return; }
    var root = byId[S.root], L = LAY.layout(S.root, S.dopen), hits = diagHits(), badges = null;
    if (f) { badges = {}; f.steps.forEach(function (st, i) { var v = visOf(L, st.node); if (v) (badges[v] = badges[v] || []).push(i + 1); }); }
    var W = Math.ceil(L.w + 2 * MARG), H = Math.ceil(L.h + L.top + 2 * MARG), oy = MARG + L.top;
    var internal = L.edges.filter(function (e) { return !e.ghost; }).length, busy = L.edges.length > 25 || L.edges.length - internal > 14;
    var cls = 'ar-canvas' + (busy ? ' is-busy' : '') + (internal > 25 ? ' is-busier' : '') + (anim === 'enter' && !reduceMotion() ? ' ar-enter' : '');
    var s = '<div class="ar-stage" id="arStage" data-g="' + esc(topOf(S.root).id) + '"><div class="ar-sizer" id="arSizer"><div class="' + cls + '" id="arCanvas" data-g="' + esc(topOf(S.root).id) + '" style="width:' + W + 'px;height:' + H + 'px"><div class="ar-plane" style="transform:translate(' + MARG + 'px,' + oy + 'px)">';
    L.conts.forEach(function (b) { s += '<div class="ar-cont d' + Math.min(b.depth, 3) + '" style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px"></div>'; });
    L.grids.forEach(function (g) { s += '<div class="ar-gridlab" style="left:' + g.x + 'px;top:' + g.y + 'px">Also in this part</div>'; });
    s += '<svg class="ar-edges" width="' + Math.ceil(L.w) + '" height="' + Math.ceil(L.h) + '" style="overflow:visible" aria-hidden="true"><defs>' + MARKERS + '</defs>';
    L.edges.forEach(function (e) {
      s += '<path class="ar-e' + (e.ghost ? ' ghost' : '') + '" data-ends="' + esc(e.a + ' ' + e.b) + '" d="' + e.d + '"' + (e.arrowR ? ' marker-end="url(#arAh)"' : '') + (e.arrowL ? ' marker-start="url(#arAh)"' : '') + '/>';
    });
    if (f) s += '<g class="ar-fl">' + flowPaths(f.steps, function (id) { var v = visOf(L, id); return v && L.pos[v]; }) + '</g>';
    s += '</svg>';
    L.boxes.forEach(function (b) { s += nodeBox(byId[b.id], b, L, hits, badges); });
    L.chips.forEach(function (c) {
      var g = byId[c.key], t = topOf(c.key);
      s += '<button type="button" class="ar-ghost side-' + c.side + '" data-zoom="' + esc(g.children.length ? g.id : (g._p || g.id)) + '" data-chip="' + esc(c.id) + '" data-g="' + esc(t.id) + '" style="left:' + c.x + 'px;top:' + c.y + 'px;width:' + c.w + 'px;height:' + c.h + 'px" aria-label="' + esc((c.side === 'in' ? 'From ' : 'To ') + g.title + '. Open its diagram') + '"><small>' + (c.side === 'in' ? 'From' : 'To') + ' · ' + plural(L.edges.filter(function (e) { return e.a === c.id || e.b === c.id; }).length, 'link') + '</small><b>' + esc(g.title) + '</b></button>';
    });
    L.labels.forEach(function (l) {
      s += '<div class="ar-elab' + (l.edge.ghost ? ' ghost' : '') + (l.over ? ' over' : '') + '" data-ends="' + esc(l.edge.a + ' ' + l.edge.b) + '" title="' + esc(l.text) + '" style="left:' + Math.round(l.x) + 'px;top:' + Math.round(l.y) + 'px;width:' + Math.round(l.w) + 'px">' + esc(l.text) + '</div>';
    });
    s += '</div></div></div></div>';
    s += '<p class="ar-mapnote">' + esc(root.summary || '') + ' Tap a part for its details, “+ parts” to open it in place. Dashed chips are other parts of the system; arrows show who sends what.' + (busy ? ' Busy view: point at a part (or a dashed chip) to see its links to the rest of the system.' : '') + '</p>';
    var prev = S.last && S.last.root === S.root ? S.last : null;
    el.innerHTML = h + s;
    S.last = L;
    applyZoom();
    setHot(S.sel);
    if (prev && anim !== 'enter') flip(prev, L);
  }
  function visOf(L, id) {
    if (!isUnder(id, L.root) || id === L.root) return null;
    var c = LAY.childOn(L.root, id);
    while (c && c !== id && L.pos[c] && L.pos[c].open) { var n = LAY.childOn(c, id); if (!n) break; c = n; }
    return c;
  }
  /* FLIP: boxes glide from where they were; new ones fade in. Transform and opacity only. */
  function flip(prev, L) {
    if (reduceMotion()) return;
    var cv = document.getElementById('arCanvas'); if (!cv) return;
    var moved = [];
    Array.prototype.forEach.call(cv.querySelectorAll('[data-node],[data-chip]'), function (el) {
      var id = el.getAttribute('data-node') || el.getAttribute('data-chip'), a = prev.pos[id], b = L.pos[id];
      if (!a || !b) { el.classList.add('ar-fade'); return; }
      var dx = a.x - b.x, dy = (a.y + prev.top) - (b.y + L.top);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; moved.push(el);
    });
    Array.prototype.forEach.call(cv.querySelectorAll('.ar-edges, .ar-elab, .ar-cont, .ar-gridlab'), function (el) { el.classList.add('ar-fade'); });
    if (!moved.length) return;
    void cv.offsetWidth;
    moved.forEach(function (el) { el.style.transition = 'transform .26s cubic-bezier(.2,.7,.2,1)'; el.style.transform = ''; });
    setTimeout(function () { moved.forEach(function (el) { el.style.transition = ''; }); }, 320);
  }
  /* zoom: fit to the stage width by default; − / + / pinch / ctrl+wheel change it */
  function applyZoom(keep) {
    var st = document.getElementById('arStage'), sz = document.getElementById('arSizer'), cv = document.getElementById('arCanvas');
    if (!st || !cv) return;
    var W = parseFloat(cv.style.width), H = parseFloat(cv.style.height), avail = st.clientWidth;
    if (!avail) return;
    if (S.fit) S.z = Math.min(1, avail / W);
    var cx = keep ? (st.scrollLeft + st.clientWidth / 2) / (sz.offsetWidth || 1) : 0, cy = keep ? keep.y : 0;
    cv.style.transform = 'scale(' + S.z + ')';
    sz.style.width = Math.floor(W * S.z) + 'px'; sz.style.height = Math.ceil(H * S.z) + 'px';
    if (keep) st.scrollLeft = cx * sz.offsetWidth - st.clientWidth / 2;
    var zv = host.querySelector('.ar-zv'); if (zv) zv.textContent = Math.round(S.z * 100) + '%';
    return cy;
  }
  function zoomBy(f) { S.fit = false; S.z = Math.max(0.2, Math.min(2, S.z * f)); applyZoom({ y: 0 }); }
  function setHot(id) {
    S.hot = id;
    var cv = document.getElementById('arCanvas'); if (!cv) return;
    Array.prototype.forEach.call(cv.querySelectorAll('.hot'), function (el) { el.classList.remove('hot'); });
    cv.classList.toggle('has-hot', !!id);
    if (!id) return;
    var sel = '[data-ends~="' + String(id).replace(/"/g, '') + '"]';
    Array.prototype.forEach.call(cv.querySelectorAll(sel), function (el) { el.classList.add('hot'); });
  }
  function focusBox(id) { var el = host.querySelector('[data-node="' + String(id).replace(/"/g, '') + '"]'); if (el) el.focus({ preventScroll: true }); return el; }
  function zoomTo(id, opts) {
    id = id || null;
    if (id && !byId[id]) return;
    if (id && !byId[id].children.length) id = byId[id]._p;
    if (id === S.root) { if (S.tab !== 'diag') setTab('diag'); return; }
    if (!(opts && opts.noHistory)) S.back.push(S.root);
    S.root = id; S.fit = true;
    if (!(opts && opts.keepSel)) { S.sel = null; S.sheet = false; renderDetail(); }
    if (S.tab !== 'diag') setTab('diag'); else renderDiag('enter');
    updateCount();
    var ae = document.activeElement; if (!ae || ae === document.body || !host.contains(ae)) { var dv = document.getElementById('arDiagView'); dv.tabIndex = -1; dv.focus({ preventScroll: true }); }
  }
  function dback() { var p = S.back.length ? S.back.pop() : (S.root && byId[S.root]._p) || null; if (p && !byId[p]) p = null; zoomTo(p, { noHistory: true }); }
  function dselect(id) { S.sel = id; S.sheet = true; renderDetail(); Array.prototype.forEach.call(host.querySelectorAll('.ar-node.is-sel'), function (el) { el.classList.remove('is-sel'); }); var el = host.querySelector('[data-node="' + id + '"]'); if (el) el.classList.add('is-sel'); setHot(id); }
  function dtoggle(id, want) {
    var n = byId[id]; if (!n || !n.children.length) return;
    var open = !!S.dopen[id]; if (want !== undefined && want === open) return;
    if (open) { delete S.dopen[id]; n.children.forEach(function (c) { (function w(x) { delete S.dopen[x.id]; x.children.forEach(w); })(c); }); } else S.dopen[id] = 1;
    persist(); renderDiag(); focusBox(id);
  }
  /* open the diagram that holds a part, opening the boxes around it, and select it */
  function dgoto(id) {
    var n = byId[id]; if (!n) return;
    if (S.tab !== 'diag') setTab('diag');
    var root = S.root;
    if (!root || !isUnder(id, root) || id === root) root = n._p ? topOf(id).id : id;
    if (isUnder(S.root || '', id) || id === root) { zoomTo(n.children.length ? id : n._p, { keepSel: true }); S.sel = id; S.sheet = true; renderDetail(); return; }
    var p = byId[id]._p; while (p && p !== root) { S.dopen[p] = 1; p = byId[p]._p; }
    persist();
    if (root !== S.root) { S.back.push(S.root); S.root = root; S.fit = true; }
    S.sel = id; S.sheet = true;
    renderDiag('enter'); renderDetail(); updateCount();
    var el = focusBox(id);
    if (el) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); if (!reduceMotion()) el.classList.add('ar-pulse'); }
  }
  function showFlowOnDiagram(fid) {
    var f = flowById[fid]; if (!f) return;
    S.dflow = fid; S.sel = null; S.sheet = false;
    var home = flowHome(f);
    if (home) f.steps.forEach(function (st) { var p = byId[st.node] && byId[st.node]._p; while (p && p !== home) { S.dopen[p] = 1; p = byId[p]._p; } });
    persist();
    if (S.root !== home) S.back.push(S.root);
    S.root = home; S.fit = true;
    setTab('diag'); renderDetail();
    host.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  /* ---------- actions ---------- */
  function setTab(t) {
    S.tab = t;
    host.classList.toggle('is-diag', t === 'diag'); host.classList.toggle('is-tree', t === 'tree');
    document.getElementById('arBody').hidden = t === 'flows';
    document.getElementById('arTreeView').hidden = t !== 'tree';
    document.getElementById('arDiagView').hidden = t !== 'diag';
    document.getElementById('arFlowView').hidden = t !== 'flows';
    document.getElementById('arTools').style.display = t === 'flows' ? 'none' : '';
    Array.prototype.forEach.call(host.querySelectorAll('[data-act=expandAll],[data-act=collapseAll]'), function (b) { b.hidden = t === 'diag' && !S.root; });
    Array.prototype.forEach.call(host.querySelectorAll('.ar-tab'), function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === t)); b.tabIndex = b.dataset.tab === t ? 0 : -1; });
    if (t === 'flows') renderFlows();
    if (t === 'diag') renderDiag('enter');
    if (t === 'tree') renderTree();
    renderDetail(); updateCount();
  }
  function openAncestors(id) {
    var n = byId[id], changed = false; while (n && n._p) { var p = byId[n._p]; if (!S.open[p.id]) { S.open[p.id] = 1; S.fresh[p.id] = 1; changed = true; } n = p; }
    return changed;
  }
  function goto(id, opts) {
    var n = byId[id]; if (!n) return;
    if (S.tab === 'diag') { dgoto(id); return; }
    if (S.tab !== 'tree') setTab('tree');
    compute();
    if (!VIS.vis[id]) { S.q = ''; S.flow = null; STATUS.forEach(function (s) { S.st[s.id] = 1; }); document.getElementById('arQ').value = ''; renderScore(); }
    openAncestors(id); if (n.children.length && !(opts && opts.keepClosed)) { S.open[id] = 1; S.fresh[id] = 1; }
    S.sel = id; S.sheet = true; S.pulse = id; persist();
    renderTree(); renderDetail();
    var li = document.querySelector('#arTree [data-id="' + id.replace(/"/g, '') + '"]');
    if (li) { li.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); }
  }
  function select(id, toggle) {
    var n = byId[id]; if (!n) return;
    S.sel = id; S.sheet = !(toggle && n.children.length && isNarrow());
    if (toggle && n.children.length) { if (S.open[id]) delete S.open[id]; else { S.open[id] = 1; S.fresh[id] = 1; n.children.forEach(function (c) { S.fresh[c.id] = 1; }); } persist(); }
    renderTree(); renderDetail();
  }
  function toggleOnly(id) {
    var n = byId[id]; if (!n) return;
    if (S.open[id]) delete S.open[id]; else { S.open[id] = 1; n.children.forEach(function (c) { S.fresh[c.id] = 1; }); }
    persist(); renderTree();
  }
  function expandAll() {
    if (S.tab === 'diag') { if (!S.root) return; (function w(n) { n.children.forEach(function (c) { if (c.children.length) { S.dopen[c.id] = 1; w(c); } }); })(byId[S.root]); S.fit = true; persist(); renderDiag(); return; }
    list.forEach(function (n) { if (n.children.length) S.open[n.id] = 1; }); persist(); renderTree();
  }
  function collapseAll() {
    if (S.tab === 'diag') { if (!S.root) return; (function w(n) { n.children.forEach(function (c) { delete S.dopen[c.id]; w(c); }); })(byId[S.root]); S.fit = true; persist(); renderDiag(); return; }
    S.open = {}; persist(); renderTree();
  }
  function clearAll() { S.q = ''; S.flow = null; STATUS.forEach(function (s) { S.st[s.id] = 1; }); document.getElementById('arQ').value = ''; renderScore(); refresh(); }
  function refresh() { if (S.tab === 'tree') renderTree(); else if (S.tab === 'diag') { renderDiag(); updateCount(); } }

  host.addEventListener('click', function (ev) {
    var t = ev.target, b = t.closest ? t.closest('button, [data-goto], [data-zoom], [data-row], [data-node], a') : null;
    if (!b) return;
    if (b.tagName === 'A') return;
    if (b.dataset.tab) { setTab(b.dataset.tab); return; }
    if (b.dataset.st) { var id = b.dataset.st; S.st[id] = S.st[id] ? 0 : 1; if (!STATUS.some(function (s) { return S.st[s.id]; })) STATUS.forEach(function (s) { S.st[s.id] = 1; }); renderScore(); if (S.tab === 'flows') setTab('tree'); refresh(); return; }
    var act = b.dataset.act;
    if (act === 'info') { ev.stopPropagation(); S.sel = b.dataset.id; S.sheet = true; renderTree(); renderDetail(); return; }
    if (act === 'toggle') { ev.stopPropagation(); toggleOnly(b.dataset.id); return; }
    if (act === 'dexp') { ev.stopPropagation(); dtoggle(b.dataset.id); return; }
    if (act === 'dback') { dback(); return; }
    if (act === 'zin') { zoomBy(1.25); return; }
    if (act === 'zout') { zoomBy(0.8); return; }
    if (act === 'zfit') { S.fit = true; applyZoom(); return; }
    if (act === 'dflowExit') { S.dflow = null; renderDiag(); return; }
    if (act === 'expandAll') { expandAll(); return; }
    if (act === 'collapseAll') { collapseAll(); return; }
    if (act === 'clearAll') { clearAll(); return; }
    if (act === 'closeSheet') { S.sheet = false; renderDetail(); return; }
    if (act === 'flowExit') { S.flow = null; renderTree(); return; }
    if (b.dataset.crumb !== undefined) { zoomTo(b.dataset.crumb || null); return; }
    if (b.dataset.zoom) { zoomTo(b.dataset.zoom); return; }
    if (b.dataset.dgo) { dgoto(b.dataset.dgo); return; }
    if (b.dataset.treego) { var tid = b.dataset.treego; setTab('tree'); goto(tid); return; }
    if (b.dataset.diaggo) { dgoto(b.dataset.diaggo); return; }
    if (b.dataset.flowpick) { S.flowPick = b.dataset.flowpick; renderFlows(); return; }
    if (b.dataset.flowdiag) { showFlowOnDiagram(b.dataset.flowdiag); return; }
    if (b.dataset.flowshow) { S.flow = b.dataset.flowshow; setTab('tree'); renderTree(); var first = flowById[S.flow].steps[0]; if (first) { S.sel = first.node; S.sheet = false; renderDetail(); renderTree(); } return; }
    if (b.dataset.flowgo) { S.flowPick = b.dataset.flowgo; setTab('flows'); window.scrollTo && host.scrollIntoView({ block: 'start' }); return; }
    if (b.dataset.goto) { goto(b.dataset.goto); return; }
    if (b.dataset.node) { dselect(b.dataset.node); return; }
    var row = t.closest('[data-row]'); if (row) { select(row.dataset.row, true); var li = document.querySelector('#arTree [data-id="' + row.dataset.row + '"]'); if (li) { li.tabIndex = 0; } }
  });
  host.addEventListener('keydown', function (ev) {
    var k = ev.key;
    if (ev.target.id === 'arQ') { if (k === 'Escape') { S.q = ''; ev.target.value = ''; refresh(); } if (k === 'ArrowDown') { var f = document.querySelector(S.tab === 'tree' ? '#arTree [role=treeitem]' : '#arHits button, #arDiagView [data-node]'); if (f) { ev.preventDefault(); f.focus(); } } if (k === 'Enter' && S.tab === 'diag') { var h1 = document.querySelector('#arHits [data-dgo]'); if (h1) { ev.preventDefault(); dgoto(h1.dataset.dgo); } } return; }
    if (k === '/' && !/INPUT|TEXTAREA/.test(ev.target.tagName) && S.tab !== 'flows') { ev.preventDefault(); document.getElementById('arQ').focus(); return; }
    var nb = ev.target.closest && ev.target.closest('[data-node]');
    if (nb && nb === ev.target) {
      var nid = nb.dataset.node, nn = byId[nid];
      if (k === 'Enter') { ev.preventDefault(); dselect(nid); return; }
      if ((k === ' ' || k === 'ArrowRight') && nn.children.length) { ev.preventDefault(); if (!S.dopen[nid]) dtoggle(nid, true); return; }
      if (k === ' ') { ev.preventDefault(); dselect(nid); return; }
      if (k === 'ArrowLeft') { ev.preventDefault(); if (S.dopen[nid]) dtoggle(nid, false); else if (nn._p && nn._p !== S.root && S.dopen[nn._p]) dtoggle(nn._p, false); return; }
    }
    if (ev.target.classList && ev.target.classList.contains('box') && (k === 'Enter' || k === ' ')) { ev.preventDefault(); zoomTo(ev.target.getAttribute('data-zoom')); return; }
    if (k === 'Escape') {
      if (S.sheet) { S.sheet = false; renderDetail(); if (S.tab === 'diag' && S.sel) focusBox(S.sel); }
      else if (S.tab === 'diag' && S.dflow) { S.dflow = null; renderDiag(); }
      else if (S.tab === 'diag' && S.root) { var was = S.root; dback(); if (!focusBox(was)) { var bx = host.querySelector('.ar-map [data-zoom="' + was + '"]'); if (bx) bx.focus(); } }
      else if (S.flow) { S.flow = null; renderTree(); }
      return;
    }
    var li = ev.target.closest && ev.target.closest('#arTree [role=treeitem]');
    if (!li || ev.target.tagName === 'A') return;
    var all = Array.prototype.slice.call(document.querySelectorAll('#arTree [role=treeitem]')), i = all.indexOf(li), n = byId[li.dataset.id], moved = null;
    if (k === 'ArrowDown') moved = all[i + 1]; else if (k === 'ArrowUp') moved = all[i - 1]; else if (k === 'Home') moved = all[0]; else if (k === 'End') moved = all[all.length - 1];
    else if (k === 'ArrowRight') { if (n.children.length && !isOpen(n)) { S.open[n.id] = 1; S.fresh[n.children[0].id] = 1; persist(); renderTree(); var l2 = document.querySelector('#arTree [data-id="' + n.id + '"]'); if (l2) l2.focus(); ev.preventDefault(); return; } moved = li.querySelector('ul > li'); }
    else if (k === 'ArrowLeft') { if (n.children.length && S.open[n.id]) { delete S.open[n.id]; persist(); renderTree(); var l3 = document.querySelector('#arTree [data-id="' + n.id + '"]'); if (l3) l3.focus(); ev.preventDefault(); return; } moved = n._p ? document.querySelector('#arTree [data-id="' + n._p + '"]') : null; }
    else if (k === 'Enter' || k === ' ') { ev.preventDefault(); select(n.id, true); var l4 = document.querySelector('#arTree [data-id="' + n.id + '"]'); if (l4) l4.focus(); return; }
    else return;
    ev.preventDefault();
    if (moved) { all.forEach(function (x) { x.tabIndex = -1; }); moved.tabIndex = 0; moved.focus(); }
  });
  var qTimer;
  host.addEventListener('input', function (ev) {
    if (ev.target.id !== 'arQ') return;
    clearTimeout(qTimer); var v = ev.target.value;
    qTimer = setTimeout(function () { S.q = v.trim().toLowerCase(); refresh(); }, 90);
  });
  /* point at a part (or focus it) to light up its arrows and labels */
  function hotFrom(t) { var e = t && t.closest && t.closest('[data-node],[data-chip]'); return e ? (e.getAttribute('data-node') || e.getAttribute('data-chip')) : null; }
  host.addEventListener('mouseover', function (ev) { if (S.tab !== 'diag') return; var id = hotFrom(ev.target); if (id && id !== S.hot) setHot(id); else if (!id && S.hot !== S.sel) setHot(S.sel); });
  host.addEventListener('mouseout', function (ev) { if (S.tab !== 'diag' || hotFrom(ev.relatedTarget)) return; if (S.hot !== S.sel) setHot(S.sel); });
  host.addEventListener('focusin', function (ev) { if (S.tab !== 'diag') return; var id = hotFrom(ev.target); if (id) setHot(id); });
  /* pinch and ctrl+wheel zoom on the stage */
  var pinch = null;
  host.addEventListener('touchstart', function (ev) { if (ev.touches.length === 2 && ev.target.closest && ev.target.closest('#arStage')) { var a = ev.touches[0], b = ev.touches[1]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: S.z }; } }, { passive: true });
  host.addEventListener('touchmove', function (ev) {
    if (!pinch || ev.touches.length !== 2) return;
    ev.preventDefault();
    var a = ev.touches[0], b = ev.touches[1], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    S.fit = false; S.z = Math.max(0.2, Math.min(2, pinch.z * d / (pinch.d || 1))); applyZoom({ y: 0 });
  }, { passive: false });
  host.addEventListener('touchend', function (ev) { if (ev.touches.length < 2) pinch = null; });
  host.addEventListener('wheel', function (ev) { if (!ev.ctrlKey || !(ev.target.closest && ev.target.closest('#arStage'))) return; ev.preventDefault(); zoomBy(ev.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
  var rzT;
  window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(function () { if (S.tab === 'diag' && S.fit) applyZoom(); }, 80); });

  scaffold(); renderScore(); setTab('diag'); renderDetail();
  window.HHArch = { goto: goto, onShow: function () { if (S.tab === 'diag') applyZoom(); }, layout: LAY, state: S, zoomTo: zoomTo, dgoto: dgoto, showFlow: showFlowOnDiagram };
})();
