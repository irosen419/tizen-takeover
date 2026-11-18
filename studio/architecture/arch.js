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
  function stIco(s) {
    var b = '<svg class="ar-ico s-' + s + '" viewBox="0 0 14 14" aria-hidden="true">';
    if (s === 'live') return b + '<circle cx="7" cy="7" r="5" fill="currentColor"/></svg>';
    if (s === 'unverified') return b + '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 2.6a4.4 4.4 0 0 0 0 8.8z" fill="currentColor"/></svg>';
    if (s === 'draft') return b + '<path d="M7 1.8 12.2 7 7 12.2 1.8 7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.4" fill="currentColor"/></svg>';
    return b + '<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>';
  }
  var CHEV = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5 8 6l-4 3.5"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

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

  /* ---------- state ---------- */
  var S = { tab: 'tree', sel: null, open: {}, q: '', st: { live: 1, unverified: 1, draft: 1, planned: 1 }, flow: null, flowPick: (D.flows && D.flows[0] && D.flows[0].id) || null, sheet: false, fresh: {}, pulse: null };
  try { var saved = JSON.parse(localStorage.getItem('hh.studio.archOpen') || '[]'); if (Array.isArray(saved)) saved.forEach(function (id) { if (byId[id]) S.open[id] = 1; }); } catch (x) { /* ignore */ }
  function persist() { try { localStorage.setItem('hh.studio.archOpen', JSON.stringify(Object.keys(S.open))); } catch (x) { /* ignore */ } }
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
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /* ---------- scaffold ---------- */
  function scaffold() {
    var h = '<div class="ar-intro"><div><h2>' + esc(D.title || 'Architecture') + '</h2><p>' + esc(D.intro || '') + '</p></div><div class="ar-asof">' + esc(D.asOf || '') + '</div></div>';
    h += '<div class="ar-score" id="arScore" role="group" aria-label="Filter by status"></div>';
    h += '<div class="ar-top"><div class="ar-tabs" role="tablist" aria-label="Views">' +
      '<button type="button" class="ar-tab" role="tab" data-tab="tree">Tree</button>' +
      '<button type="button" class="ar-tab" role="tab" data-tab="flows">Data flows <span class="ar-count">(' + (D.flows || []).length + ')</span></button>' +
      '<button type="button" class="ar-tab" role="tab" data-tab="map">Big picture</button></div>' +
      '<div class="ar-tools" id="arTools"><div class="ar-search"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>' +
      '<input type="search" id="arQ" placeholder="Search parts, files, services…" aria-label="Search the architecture" autocomplete="off" spellcheck="false"><button type="button" class="ar-x" id="arQx" aria-label="Clear search" hidden>×</button></div>' +
      '<button type="button" class="btn" data-act="expandAll">Expand all</button><button type="button" class="btn" data-act="collapseAll">Collapse all</button><span class="ar-count" id="arCount" aria-live="polite"></span></div></div>';
    h += '<div id="arTreeView" class="ar-body"><div class="ar-treewrap"><div id="arBanner"></div><ul class="ar-tree" id="arTree" role="tree" aria-label="Home Hub architecture"></ul></div><aside class="ar-detail" id="arDetail" aria-label="Details"></aside></div>';
    h += '<div id="arFlowView" class="ar-flows" hidden></div><div id="arMapView" hidden></div>';
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
    var ct = document.getElementById('arCount');
    ct.textContent = (S.q || filterActive() || S.flow) ? plural(VIS.count || Object.keys(VIS.vis).length, 'match') + (VIS.count ? '' : '') : '';
    document.getElementById('arQx').hidden = !S.q;
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
      h += '<div class="ar-flowpane"><h3>' + esc(pick.title) + '</h3><p>' + esc(pick.summary || '') + '</p><div class="ar-flowact"><button type="button" class="btn" data-flowshow="' + esc(pick.id) + '">Show these parts in the tree</button></div><ol class="ar-steps">';
      pick.steps.forEach(function (s, i) {
        var o = byId[s.node], top = o ? path(o).slice(0, -1).map(function (x) { return x.title; }).join(' › ') : '';
        h += '<li class="ar-step"><span class="n" aria-hidden="true">' + (i + 1) + '</span><div><button type="button" class="node" data-goto="' + esc(s.node) + '"><span class="nt">' + esc(o ? o.title : s.node) + (o ? pill(o.status || 'live') : '') + '</span>' + (top ? '<span class="where">' + esc(top) + '</span>' : '') + '<span class="say">' + esc(s.say || '') + '</span></button></div></li>';
      });
      h += '</ol></div>';
    }
    document.getElementById('arFlowView').innerHTML = h;
  }

  /* ---------- big picture ---------- */
  function renderMap() {
    var M = D.overview, el = document.getElementById('arMapView');
    if (!M) { el.innerHTML = ''; return; }
    var s = '<div class="ar-map"><svg viewBox="0 0 ' + M.w + ' ' + M.h + '" role="group" aria-label="How the main parts connect"><defs>' +
      '<marker id="arAr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker></defs>';
    (M.edges || []).forEach(function (e) {
      var d = 'M' + e.pts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L');
      s += '<path class="edge' + (e.dash ? ' dash' : '') + '" d="' + d + '"' + (e.dir !== 'in' ? ' marker-end="url(#arAr)"' : '') + (e.dir === 'both' || e.dir === 'in' ? ' marker-start="url(#arAr)"' : '') + '/>';
      if (e.label) s += '<text class="el" x="' + e.lx + '" y="' + e.ly + '" text-anchor="' + (e.anchor || 'middle') + '">' + esc(e.label) + '</text>';
    });
    (M.boxes || []).forEach(function (b) {
      var g = byId[b.group], c = g ? g._c : null;
      s += '<g class="box" tabindex="0" role="button" data-goto="' + esc(b.group) + '" aria-label="' + esc(b.title + ': ' + (b.lines || []).join(' ')) + '"><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="14"/>' +
        '<text class="bt" x="' + (b.x + 16) + '" y="' + (b.y + 28) + '">' + esc(b.title) + '</text>' +
        (b.lines || []).map(function (ln, i) { return '<text class="bs" x="' + (b.x + 16) + '" y="' + (b.y + 48 + i * 17) + '">' + esc(ln) + '</text>'; }).join('');
      if (c && c.total) {
        var bx = b.x + 16, bw = b.w - 32, by = b.y + b.h - 18, off = 0;
        STATUS.forEach(function (st) { if (c[st.id]) { var w = bw * c[st.id] / c.total; s += '<rect x="' + (bx + off) + '" y="' + by + '" width="' + Math.max(w - 1, 2) + '" height="6" rx="3" style="stroke:none;fill:var(--s-' + st.id + ')"/>'; off += w; } });
      }
      s += '</g>';
    });
    s += '</svg></div><p class="ar-mapnote">' + esc(M.note || '') + ' Tap a box to open that part of the tree. The coloured strip is how much of each part is live, unverified, draft or planned.</p>';
    el.innerHTML = s;
  }

  /* ---------- actions ---------- */
  function setTab(t) {
    S.tab = t;
    document.getElementById('arTreeView').hidden = t !== 'tree';
    document.getElementById('arFlowView').hidden = t !== 'flows';
    document.getElementById('arMapView').hidden = t !== 'map';
    document.getElementById('arTools').style.display = t === 'tree' ? '' : 'none';
    Array.prototype.forEach.call(host.querySelectorAll('.ar-tab'), function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === t)); b.tabIndex = b.dataset.tab === t ? 0 : -1; });
    if (t === 'flows') renderFlows();
    if (t === 'map') renderMap();
  }
  function openAncestors(id) {
    var n = byId[id], changed = false; while (n && n._p) { var p = byId[n._p]; if (!S.open[p.id]) { S.open[p.id] = 1; S.fresh[p.id] = 1; changed = true; } n = p; }
    return changed;
  }
  function goto(id, opts) {
    var n = byId[id]; if (!n) return;
    if (S.tab !== 'tree') setTab('tree');
    compute();
    if (!VIS.vis[id]) { S.q = ''; S.flow = null; STATUS.forEach(function (s) { S.st[s.id] = 1; }); document.getElementById('arQ').value = ''; renderScore(); }
    openAncestors(id); if (n.children.length && !(opts && opts.keepClosed)) { S.open[id] = 1; S.fresh[id] = 1; }
    S.sel = id; S.sheet = true; S.pulse = id; persist();
    renderTree(); renderDetail();
    var li = document.querySelector('#arTree [data-id="' + id.replace(/"/g, '') + '"]');
    if (li) { var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; li.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); }
  }
  function select(id, toggle) {
    var n = byId[id]; if (!n) return;
    S.sel = id; S.sheet = !(toggle && n.children.length && window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
    if (toggle && n.children.length) { if (S.open[id]) delete S.open[id]; else { S.open[id] = 1; S.fresh[id] = 1; n.children.forEach(function (c) { S.fresh[c.id] = 1; }); } persist(); }
    renderTree(); renderDetail();
  }
  function toggleOnly(id) {
    var n = byId[id]; if (!n) return;
    if (S.open[id]) delete S.open[id]; else { S.open[id] = 1; n.children.forEach(function (c) { S.fresh[c.id] = 1; }); }
    persist(); renderTree();
  }
  function expandAll() { list.forEach(function (n) { if (n.children.length) S.open[n.id] = 1; }); persist(); renderTree(); }
  function collapseAll() { S.open = {}; persist(); renderTree(); }
  function clearAll() { S.q = ''; S.flow = null; STATUS.forEach(function (s) { S.st[s.id] = 1; }); document.getElementById('arQ').value = ''; renderScore(); renderTree(); }

  host.addEventListener('click', function (ev) {
    var t = ev.target, b = t.closest ? t.closest('button, [data-goto], [data-row], a') : null;
    if (!b) return;
    if (b.tagName === 'A') return;
    if (b.dataset.tab) { setTab(b.dataset.tab); return; }
    if (b.dataset.st) { var id = b.dataset.st; S.st[id] = S.st[id] ? 0 : 1; if (!STATUS.some(function (s) { return S.st[s.id]; })) STATUS.forEach(function (s) { S.st[s.id] = 1; }); renderScore(); if (S.tab !== 'tree') setTab('tree'); renderTree(); return; }
    var act = b.dataset.act;
    if (act === 'info') { ev.stopPropagation(); S.sel = b.dataset.id; S.sheet = true; renderTree(); renderDetail(); return; }
    if (act === 'toggle') { ev.stopPropagation(); toggleOnly(b.dataset.id); return; }
    if (act === 'expandAll') { expandAll(); return; }
    if (act === 'collapseAll') { collapseAll(); return; }
    if (act === 'clearAll') { clearAll(); return; }
    if (act === 'closeSheet') { S.sheet = false; renderDetail(); return; }
    if (act === 'flowExit') { S.flow = null; renderTree(); return; }
    if (b.dataset.flowpick) { S.flowPick = b.dataset.flowpick; renderFlows(); return; }
    if (b.dataset.flowshow) { S.flow = b.dataset.flowshow; setTab('tree'); renderTree(); var first = flowById[S.flow].steps[0]; if (first) { S.sel = first.node; S.sheet = false; renderDetail(); renderTree(); } return; }
    if (b.dataset.flowgo) { S.flowPick = b.dataset.flowgo; setTab('flows'); window.scrollTo && host.scrollIntoView({ block: 'start' }); return; }
    if (b.dataset.goto) { goto(b.dataset.goto); return; }
    var row = t.closest('[data-row]'); if (row) { select(row.dataset.row, true); var li = document.querySelector('#arTree [data-id="' + row.dataset.row + '"]'); if (li) { li.tabIndex = 0; } }
  });
  host.addEventListener('keydown', function (ev) {
    var k = ev.key;
    if (ev.target.id === 'arQ') { if (k === 'Escape') { S.q = ''; ev.target.value = ''; renderTree(); } if (k === 'ArrowDown') { var f = document.querySelector('#arTree [role=treeitem]'); if (f) { ev.preventDefault(); f.focus(); } } return; }
    if (k === '/' && !/INPUT|TEXTAREA/.test(ev.target.tagName) && S.tab === 'tree') { ev.preventDefault(); document.getElementById('arQ').focus(); return; }
    if (k === 'Escape') { if (S.sheet) { S.sheet = false; renderDetail(); } else if (S.flow) { S.flow = null; renderTree(); } return; }
    if (ev.target.classList && ev.target.classList.contains('box') && (k === 'Enter' || k === ' ')) { ev.preventDefault(); goto(ev.target.getAttribute('data-goto')); return; }
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
    qTimer = setTimeout(function () { S.q = v.trim().toLowerCase(); renderTree(); }, 90);
  });

  scaffold(); renderScore(); setTab('tree'); renderTree(); renderDetail();
  window.HHArch = { goto: goto, onShow: function () { /* nothing to refresh */ } };
})();
