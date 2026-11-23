/*
 * Investments: one standalone tile fed by the "investments" section of the
 * budget snapshot (docs/budget-snapshot.md), sent by the budget app on the Pi.
 *
 *   investments   The portfolio. By the size the tile is given:
 *                 1 column      one figure and the gain, as big as fits;
 *                 1 row         the total and the gain against cost on a line;
 *                 smallest tile the total, and "+$8,111 · +20.2% vs cost"
 *                               (green when up, coral when down);
 *                 4 columns+    a trend line from the history (hidden under
 *                               2 days, with "Trend starts building today");
 *                 3 rows+       an allocation bar by account and the top
 *                               holdings with their share of the total.
 *                 OK opens it in place: the trend, every account and every
 *                 top holding.
 *
 * The owner approved dollar figures here on 2026-11-19. Guest mode (guest.js)
 * blurs every dollar amount on the tile and the panel; the percentages, the
 * names and the trend's shape (no axis, no figure) stay readable.
 *
 * This widget is in no layout. Put it on one with Layout Studio or
 * "./hub layout". With no investments section it says "Waiting for the budget
 * app"; data over 2 hours old dims and says "as of 9:10 AM", like the budget
 * tiles. widgets.budget.show: false in config.js hides it too.
 *
 * Every word is in EN; the Spanish is under 'investments.<path>' in
 * app/i18n.js. Money keeps its US form ($1,265). Plain ES5; nothing animates.
 */
(function () {
  'use strict';

  var EN = {
    title: 'Investments',
    titleShort: 'Invest',
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    dateShort: '{mon} {d}',
    am: 'AM',
    pm: 'PM',
    thousands: ',',
    cash: '${n}',
    minus: '−',
    plus: '+',
    sep: ' · ',
    asOf: 'as of {t}',
    more: '+{n} more',
    totalCap: 'total value',
    vsCost: 'vs cost',
    gainOnly: 'gain',
    pctOf: '{p} of total',
    trendStarts: 'Trend starts building today',
    trendDays: 'last {n} days',
    trendDay1: 'last day',
    accountsHead: 'Accounts',
    holdingsHead: 'Top holdings',
    byAccount: 'By account',
    nothing: 'Nothing to show yet.',
    states: {
      off: { head: 'Needs the Pi',
        line: 'The portfolio comes from the hub server on the Raspberry Pi. Live updates are off on this TV: set live.server in config.js to the Pi’s address.',
        short: 'Live updates are off.' },
      quiet: { head: 'Needs the Pi', line: 'This TV hasn’t reached the hub server on the Pi yet. It keeps trying quietly.', short: 'Waiting for the Pi.' },
      lost: { head: 'Can’t reach the Pi', line: 'This tile fills in as soon as the Pi answers again.', short: 'Trying again quietly.' },
      loading: { head: 'Loading…', line: '', short: '' },
      waiting: { head: 'Waiting for the budget app',
        line: 'The budget app on the Pi sends its investments here. docs/budget-snapshot.md says how.',
        short: 'It sends its totals to the Pi.' },
      hidden: { head: 'Budget is hidden', line: 'widgets.budget.show is off in config.js, so no budget figures show on this TV.', short: 'Turned off in config.js.' }
    },
    broken: '{title} couldn’t be shown'
  };

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function mergeStrings(dst, src) {
    if (!src || typeof src !== 'object') return;
    for (var k in src) {
      if (!src.hasOwnProperty(k) || !dst.hasOwnProperty(k)) continue;
      var v = src[k];
      var d = dst[k];
      if (d && typeof d === 'object' && !isArr(d)) {
        if (v && typeof v === 'object' && !isArr(v)) mergeStrings(d, v);
      } else if (isArr(d)) {
        if (isArr(v) && v.length === d.length) dst[k] = v;
      } else if (typeof v === 'string') {
        dst[k] = v;
      }
    }
  }
  try { mergeStrings(EN, window.HUB_INVESTMENTS_STRINGS); } catch (e) { /* keep English */ }

  var STRINGS = EN;

  function I18N() {
    var x = window.HUB_I18N;
    return x && typeof x.localize === 'function' ? x : null;
  }

  function localizeStrings() {
    var x = I18N();
    try { STRINGS = x ? x.localize(EN, 'investments') : EN; } catch (e) { STRINGS = EN; }
  }
  localizeStrings();

  var CACHE_KEY = 'homeHub.investments.v1';
  var MIN = 60000;
  var DAY = 24 * 60 * MIN;
  var STALE = 2 * 60 * MIN;
  var FALLBACK_TZ = 'America/Chicago';

  /* ---------- small helpers ---------- */

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function fill(text, map) {
    return String(text).replace(/\{(\w+)\}/g, function (all, k) {
      return map && map.hasOwnProperty(k) ? String(map[k]) : all;
    });
  }

  function str(v) { return typeof v === 'string' ? v : ''; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function now() { return new Date().getTime(); }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Investments: ' + text); } catch (e) { /* ignore */ }
  }

  function fmtNum(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, STRINGS.thousands);
  }

  // Whole dollars: "$42", "−$12".
  function cash(n) {
    var r = Math.round(n);
    return (r < 0 ? STRINGS.minus : '') + fill(STRINGS.cash, { n: fmtNum(Math.abs(r)) });
  }

  // A gain with its sign: "+$8,111", "−$250". Zero has none.
  function signedCash(n) {
    var r = Math.round(n);
    return (r > 0 ? STRINGS.plus : '') + cash(r);
  }

  // A gain percent with its sign and one decimal: "+20.2%", "−3.1%".
  function signedPct(p) {
    var r = Math.round(p * 10) / 10;
    var body = Math.abs(r).toFixed(1) + '%';
    return r > 0 ? STRINGS.plus + body : r < 0 ? STRINGS.minus + body : body;
  }

  // A share of the whole: "63%", "<1%".
  function sharePct(p) {
    if (p > 0 && p < 0.5) return '<1%';
    return Math.round(p) + '%';
  }

  function tone(n) { return n > 0 ? 'is-ok' : n < 0 ? 'is-neg' : 'is-flat'; }

  function overH(node) { return node.scrollHeight > node.clientHeight + 1; }
  function overW(node) { return node.scrollWidth > node.clientWidth + 1; }

  function fitForms(node, forms) {
    for (var i = 0; i < forms.length; i++) {
      if (!forms[i]) continue;
      node.textContent = forms[i];
      if (!overW(node)) return true;
    }
    node.style.display = 'none';
    return false;
  }

  function fitWidth(node) {
    node.style.fontSize = '';
    if (!node.clientWidth || !overW(node)) return;
    var size = parseFloat(window.getComputedStyle(node).fontSize) || 40;
    for (var i = 0; i < 16 && overW(node); i++) {
      size = size * 0.9;
      node.style.fontSize = size.toFixed(1) + 'px';
    }
  }

  // Rows while they fit, then "+N more".
  function fitRows(list, more, rows) {
    var shown = rows.length;
    var i;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (i = 0; i < shown; i++) list.appendChild(rows[i]);
    function setMore() {
      var rest = rows.length - shown;
      more.textContent = rest > 0 ? fill(STRINGS.more, { n: rest }) : '';
      more.style.display = rest > 0 ? '' : 'none';
    }
    setMore();
    while (shown > 0 && overH(list)) {
      list.removeChild(list.lastChild);
      shown -= 1;
      setMore();
    }
    return shown;
  }

  function parseIso(s) {
    if (typeof s !== 'string') return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  /* ---------- the Pi's time zone, for "as of 7:10 AM" ---------- */

  var zoneFmt = null;
  var zoneName = '';

  function tzName() {
    var c = null;
    try { c = window.HUB_LIVE && window.HUB_LIVE.get('calendar'); } catch (e) { c = null; }
    return (c && typeof c.tz === 'string' && c.tz) || FALLBACK_TZ;
  }

  function wall(ms) {
    var tz = tzName();
    if (tz !== zoneName) {
      zoneName = tz;
      zoneFmt = null;
      try {
        zoneFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: 'numeric',
          day: 'numeric', hour: 'numeric', minute: 'numeric' });
      } catch (e) { zoneFmt = null; }
    }
    if (zoneFmt) {
      try {
        var m = /(\d+)\D+(\d+)\D+(\d+)\D+(\d+)\D+(\d+)/.exec(zoneFmt.format(new Date(ms)));
        if (m) return [+m[3], +m[1], +m[2], +m[4] % 24, +m[5]];
      } catch (e) { /* the TV's own clock below */ }
    }
    var d = new Date(ms);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  }

  function todayNum() {
    var w = wall(now());
    return Math.round(Date.UTC(w[0], w[1] - 1, w[2]) / DAY);
  }

  function hm(ms) {
    var w = wall(ms);
    var h = w[3];
    return (h % 12 === 0 ? 12 : h % 12) + ':' + (w[4] < 10 ? '0' : '') + w[4] + ' ' + (h < 12 ? STRINGS.am : STRINGS.pm);
  }

  function shortDate(n) {
    var d = new Date(n * DAY);
    return fill(STRINGS.dateShort, { mon: STRINGS.monthsShort[d.getUTCMonth()], d: d.getUTCDate() });
  }

  /* ---------- the data: dollars, and the copy with no dollars ---------- */

  // S.m holds the figures in dollars. S.g holds the percentages and the
  // trend's shape that the drawing reads beside them.
  var S = { ctx: null, m: null, g: null, sentAt: NaN, fromCache: false, bound: false, sig: '', timer: null };

  function pctOf(part, whole) { return whole > 0 ? part / whole * 100 : null; }

  // A gain as a percent of what it was bought for (value less the gain).
  function gainPctOf(value, gain) {
    if (gain === null) return null;
    return pctOf(gain, value - gain);
  }

  // The trend's shape: each total between the lowest (0) and highest (1) of
  // the period. Nothing here can give a dollar back.
  function shapeOf(hist) {
    if (hist.length < 2) return [];
    var lo = hist[0];
    var hi = hist[0];
    var i;
    for (i = 1; i < hist.length; i++) {
      if (hist[i] < lo) lo = hist[i];
      if (hist[i] > hi) hi = hist[i];
    }
    var out = [];
    for (i = 0; i < hist.length; i++) out.push(hi > lo ? (hist[i] - lo) / (hi - lo) : 0.5);
    return out;
  }

  // The section as the TV uses it, or null when it has no usable total.
  function derive(sec) {
    if (!sec || typeof sec !== 'object' || isArr(sec)) return null;
    var total = num(sec.total);
    if (total === null || total < 0) return null;
    var cost = num(sec.cost);
    var gain = num(sec.gain);
    if (gain === null && cost !== null) gain = total - cost;
    if (cost === null && gain !== null) cost = total - gain;
    var m = { total: total, cost: cost, gain: gain, gainPct: gain !== null && cost !== null ? pctOf(gain, cost) : null,
      accounts: [], top: [], hist: [], days: 0 };
    var i;
    var sum = 0;
    var list = isArr(sec.accounts) ? sec.accounts : [];
    for (i = 0; i < list.length; i++) {
      if (list[i] && str(list[i].label) && num(list[i].value) !== null) sum += list[i].value;
    }
    var whole = total > 0 ? total : sum;
    for (i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !str(a.label) || num(a.value) === null) continue;
      var ag = num(a.gain);
      m.accounts.push({ label: a.label, value: a.value, gain: ag, pct: pctOf(a.value, whole), gainPct: gainPctOf(a.value, ag) });
    }
    list = isArr(sec.top) ? sec.top : [];
    for (i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || !str(t.name) || num(t.value) === null) continue;
      var tg = num(t.gain);
      m.top.push({ ticker: str(t.ticker), name: t.name, value: t.value, gain: tg, pct: pctOf(t.value, whole), gainPct: gainPctOf(t.value, tg) });
    }
    list = isArr(sec.history) ? sec.history : [];
    for (i = 0; i < list.length; i++) if (list[i] && num(list[i].total) !== null) m.hist.push(list[i].total);
    m.days = m.hist.length;
    m.shape = shapeOf(m.hist);
    m.up = m.hist.length > 1 ? m.hist[m.hist.length - 1] >= m.hist[0] : (m.gain === null || m.gain >= 0);
    m.hist = null;
    return m;
  }

  // The percentages and the trend's shape alone.
  function sharesOf(m) {
    var g = { gainPct: m.gainPct, accounts: [], top: [], shape: m.shape, up: m.up, days: m.days, gainSign: m.gain === null ? 0 : m.gain > 0 ? 1 : m.gain < 0 ? -1 : 0 };
    var i;
    for (i = 0; i < m.accounts.length; i++) g.accounts.push({ label: m.accounts[i].label, pct: m.accounts[i].pct, gainPct: m.accounts[i].gainPct });
    for (i = 0; i < m.top.length; i++) g.top.push({ ticker: m.top[i].ticker, name: m.top[i].name, pct: m.top[i].pct, gainPct: m.top[i].gainPct });
    return g;
  }

  // What to draw now.
  function view() {
    if (!S.m) return null;
    return { money: true, m: S.m, g: S.g };
  }

  function config() {
    var w = window.HUB_CONFIG && window.HUB_CONFIG.widgets;
    var c = w && w.budget;
    return c && typeof c === 'object' ? c : {};
  }

  function allowed() { return config().show !== false; }

  function L() {
    var x = window.HUB_LIVE;
    return x && typeof x === 'object' && typeof x.status === 'function' ? x : null;
  }

  function lineState() {
    var x = L();
    var st = 'off';
    try { st = x ? x.status().state : 'off'; } catch (e) { st = 'off'; }
    if (st === 'off') return 'off';
    if (st === 'connecting') return 'loading';
    if (st === 'quiet' || st === 'lost') return st;
    if (st === 'live') return 'waiting';
    return 'quiet';
  }

  function emptyState() {
    if (!allowed()) return 'hidden';
    if (S.g) return 'waiting';
    return lineState();
  }

  function staleAt() {
    if (!S.g || isNaN(S.sentAt)) return 0;
    return now() - S.sentAt >= STALE ? S.sentAt : 0;
  }

  function asOfText() {
    var at = staleAt();
    if (!at) return '';
    var w = wall(at);
    var day = Math.round(Date.UTC(w[0], w[1] - 1, w[2]) / DAY);
    return fill(STRINGS.asOf, { t: day === todayNum() ? hm(at) : shortDate(day) });
  }

  function loadCache() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      var c = JSON.parse(raw);
      var m = c ? derive(c.section) : null;
      if (m && !isNaN(parseIso(c.sentAt))) { setModel(m, parseIso(c.sentAt)); S.fromCache = true; }
    } catch (e) { /* start without it */ }
  }

  function saveCache(section, sentAt) {
    try {
      if (!window.localStorage) return;
      if (section) window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, at: now(), sentAt: sentAt, section: section }));
      else window.localStorage.removeItem(CACHE_KEY);
    } catch (e) { /* the copy in memory still works */ }
  }

  function setModel(m, sentAt) {
    S.g = m ? sharesOf(m) : null;
    S.m = m || null;
    S.sentAt = m ? sentAt : NaN;
  }

  // New budget snapshot from the live line (or the first read of it).
  function onData(d) {
    if (!d || typeof d !== 'object' || isArr(d)) return;
    var sent = parseIso(d.sentAt);
    var sec = isNaN(sent) ? null : d.investments;
    var m = derive(sec);
    setModel(m, sent);
    S.fromCache = false;
    saveCache(m ? sec : null, d.sentAt);
    refresh();
  }

  function signature() {
    var key;
    try { key = JSON.stringify([S.m, S.g]); } catch (e) { key = String(now()); }
    return [emptyState(), lineState(), todayNum(), asOfText(), key].join('|');
  }

  function refresh() {
    var sig = signature();
    if (sig === S.sig) return;
    S.sig = sig;
    var ctx = S.ctx;
    if (!ctx) return;
    try {
      ctx.redrawTile();
      if (ctx.isOpen()) ctx.redrawPanel();
    } catch (e) { warn('redraw: ' + (e && e.message)); }
  }

  function schedule() {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      S.timer = null;
      try { refresh(); } catch (e) { warn(e && e.message); }
      schedule();
    }, MIN - (now() % MIN) + 250);
  }

  function readLatest(x) {
    loadCache();
    try {
      var d = x && x.get('budget');
      if (d && typeof d === 'object') onData(d);
    } catch (e) { /* wait for it */ }
  }

  var tries = 0;
  function bindLive() {
    if (S.bound) return;
    var x = L();
    if (!x) {
      tries += 1;
      if (tries < 30) setTimeout(bindLive, 1000);
      return;
    }
    S.bound = true;
    if (!allowed()) return;
    readLatest(x);
    try { x.on('budget', function (d) { try { onData(d); } catch (e) { warn(e && e.message); } }); } catch (e) { warn('live: ' + (e && e.message)); }
    try { if (typeof x.onStatus === 'function') x.onStatus(function () { try { refresh(); } catch (e) { /* next change tries again */ } }); } catch (e) { /* ignore */ }
    S.sig = signature();
    schedule();
  }

  /* ---------- drawing ---------- */

  function sizeOf(ctx) {
    var z = ctx && ctx.size ? ctx.size() : null;
    return z || { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
  }

  function mark(parent, cls) {
    var m = el('span', 'icon iv-mark' + (cls ? ' ' + cls : ''), parent);
    m.innerHTML = (window.HUB_ICONS && (window.HUB_ICONS.trend || window.HUB_ICONS.wallet)) || '';
    return m;
  }

  function tileMessage(root, size, key) {
    var msg = STRINGS.states[key] || STRINGS.states.waiting;
    if (size.cols === 1) return mark(root, 'is-solo');
    if (size.tier === 'strip') {
      root.className += ' iv-strip';
      return el('div', 'iv-strip-text iv-cut is-quiet', root, msg.head);
    }
    var box = el('div', 'iv-msg', root);
    el('div', 'iv-msg-head', box, msg.head);
    var line = msg.short ? el('div', 'iv-msg-line', box, msg.short) : null;
    if (line && overH(root)) box.removeChild(line);
    if (overH(root)) box.firstChild.className += ' is-small';
    mark(root);
    return box;
  }

  function panelMessage(root, key) {
    var msg = STRINGS.states[key] || STRINGS.states.waiting;
    var box = el('div', 'iv-pmsg', root);
    el('div', 'iv-pmsg-head', box, msg.head);
    if (msg.line) el('div', 'iv-pmsg-line', box, msg.line);
    mark(root, 'is-panel');
  }

  function dim(root) { if (staleAt()) root.className += ' is-stale'; }

  // The big figure: the total.
  function heroText(v) { return cash(v.m.total); }

  function heroTone() { return ''; }

  // The gain against cost, in the forms to try (longest first).
  function gainForms(v) {
    var m = v.m;
    var g = v.g;
    var pct = g.gainPct === null ? null : signedPct(g.gainPct);
    if (m.gain === null) return [];
    var amount = signedCash(m.gain);
    var forms = [];
    if (pct !== null) forms.push(amount + STRINGS.sep + pct + ' ' + STRINGS.vsCost, amount + STRINGS.sep + pct);
    forms.push(amount);
    return forms;
  }

  function gainTone(v) { return v.m.gain === null ? '' : tone(v.m.gain); }

  function hero(parent, v, cap) {
    var box = el('div', 'iv-hero', parent);
    var text = heroText(v);
    box.numEl = el('span', 'iv-hero-num ' + heroTone(v), box, text);
    if (cap) box.capEl = el('span', 'iv-hero-cap', box, cap);
    return box;
  }

  function fitHero(box) {
    fitWidth(box.numEl);
    var cap = box.capEl;
    if (cap && cap.parentNode && (cap.offsetLeft <= box.numEl.offsetLeft + 1 || overW(cap))) box.removeChild(cap);
  }

  function heroCap() { return STRINGS.totalCap; }

  var SVGNS = 'http://www.w3.org/2000/svg';

  // The trend line, from the shape (0 to 1) alone. No axis, no figures.
  function spark(parent, g, cls) {
    var box = el('div', 'iv-spark ' + (g.up ? 'is-ok' : 'is-neg') + (cls ? ' ' + cls : ''), parent);
    var n = g.shape.length;
    var pts = [];
    var i;
    for (i = 0; i < n; i++) pts.push((i / (n - 1) * 100).toFixed(2) + ',' + (36 - g.shape[i] * 32).toFixed(2));
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    var area = document.createElementNS(SVGNS, 'polygon');
    area.setAttribute('points', '0,40 ' + pts.join(' ') + ' 100,40');
    area.setAttribute('class', 'iv-spark-area');
    svg.appendChild(area);
    var line = document.createElementNS(SVGNS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('class', 'iv-spark-line');
    svg.appendChild(line);
    box.appendChild(svg);
    var dot = el('span', 'iv-spark-dot', box);
    dot.style.top = (36 - g.shape[n - 1] * 32) / 40 * 100 + '%';
    return box;
  }

  function trendNote(parent, cls) {
    return el('div', 'iv-note' + (cls ? ' ' + cls : ''), parent, STRINGS.trendStarts);
  }

  var SEGS = 6;

  // One bar split by account.
  function allocBar(parent, v, cls) {
    var list = v.g.accounts;
    var bar = el('div', 'iv-alloc' + (cls ? ' ' + cls : ''), parent);
    for (var i = 0; i < list.length; i++) {
      if (list[i].pct === null || list[i].pct <= 0) continue;
      var seg = el('span', 'iv-seg is-s' + (i % SEGS), bar);
      seg.style.width = Math.max(1, list[i].pct) + '%';
    }
    return bar;
  }

  function legend(parent, v) {
    var box = el('div', 'iv-legend', parent);
    var list = v.g.accounts;
    var items = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].pct === null) continue;
      var it = el('span', 'iv-leg', box);
      el('span', 'iv-dot is-s' + (i % SEGS), it);
      el('span', 'iv-leg-label iv-cut', it, list[i].label);
      el('span', 'iv-leg-pct', it, sharePct(list[i].pct));
      items.push(it);
    }
    while (items.length > 1 && overH(box)) box.removeChild(items.pop());
    return box;
  }

  // A holding: ticker, name, value and its share.
  function holdRow(i, v, wide, panel) {
    var t = v.g.top[i];
    var row = el('div', 'iv-row' + (panel ? ' iv-psec f' : ''));
    el('span', 'iv-tk iv-cut', row, t.ticker);
    el('span', 'iv-nm iv-cut' + (wide ? '' : ' is-hidden'), row, t.name);
    el('span', 'iv-val', row, cash(v.m.top[i].value));
    el('span', 'iv-pct', row, t.pct === null ? '' : sharePct(t.pct));
    if (panel) {
      var gv = v.m.top[i].gain;
      el('span', 'iv-gn ' + (gv === null ? '' : tone(gv)), row, gv === null ? '' : signedCash(gv));
    }
    return row;
  }

  function acctRow(i, v) {
    var a = v.g.accounts[i];
    var row = el('div', 'iv-arow iv-psec f');
    var top = el('div', 'iv-arow-top', row);
    el('span', 'iv-dot is-s' + (i % SEGS), top);
    el('span', 'iv-arow-label iv-cut', top, a.label);
    el('span', 'iv-val', top, cash(v.m.accounts[i].value));
    el('span', 'iv-pct', top, a.pct === null ? '' : sharePct(a.pct));
    var gv = v.m.accounts[i].gain;
    if (gv !== null) el('div', 'iv-arow-gain ' + tone(gv), row, signedCash(gv) + (a.gainPct !== null ? STRINGS.sep + signedPct(a.gainPct) : ''));
    return row;
  }

  function strip(root, v, size) {
    root.className += ' iv-strip';
    var line = el('div', 'iv-strip-line', root);
    var num = el('span', 'iv-strip-num ' + heroTone(v), line, heroText(v));
    num.style.flexShrink = '0';
    var gain = el('span', 'iv-strip-gain ' + gainTone(v), line);
    var forms = gainForms(v);
    for (var i = 0; i < forms.length && size.cols >= 3; i++) {
      gain.textContent = forms[i];
      if (!overW(line)) break;
      gain.textContent = '';
    }
    if (size.cols >= 6 && v.g.shape.length > 1) {
      var sp = spark(line, v.g, 'is-strip');
      if (overW(line)) line.removeChild(sp);
    }
  }

  function tile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'iv-tile', body);
    var v = allowed() ? view() : null;
    ctx.setTileSub(v ? asOfText() : '');
    if (!v) return tileMessage(root, size, emptyState());
    dim(root);
    if (size.cols === 1) {
      root.className += ' iv-solo';
      var n = el('div', 'iv-solo-num ' + heroTone(v), root, heroText(v));
      fitWidth(n);
      var f = gainForms(v);
      var c = el('div', 'iv-solo-cap ' + gainTone(v), root);
      if (v.g.gainPct !== null) c.textContent = signedPct(v.g.gainPct);
      else if (f.length) c.textContent = f[f.length - 1];
      if (!c.textContent || overW(c)) root.removeChild(c);
      return;
    }
    if (size.tier === 'strip') return strip(root, v, size);

    var h = hero(root, v, heroCap(v));
    var gl = el('div', 'iv-gain ' + gainTone(v), root);
    fitHero(h);
    fitForms(gl, gainForms(v));
    var wide = size.cols >= 4;
    var tall = size.rows >= 3;
    var body2 = el('div', 'iv-fill', root);
    if (wide) {
      if (v.g.shape.length > 1) spark(body2, v.g);
      else trendNote(body2);
    }
    if (tall && (v.g.accounts.length || v.g.top.length)) {
      var lower = el('div', 'iv-lower', root);
      if (v.g.accounts.length) {
        allocBar(lower, v);
        legend(lower, v);
      }
      if (v.g.top.length) {
        var list = el('div', 'iv-rows', lower);
        var more = el('div', 'iv-more', lower);
        var rows = [];
        for (var i = 0; i < v.g.top.length; i++) rows.push(holdRow(i, v, size.cols >= 6, false));
        fitRows(list, more, rows);
      }
    }
    // Room is tight: the trend or the lower part gives way before the figure does.
    if (overH(root) && body2.parentNode && (!tall || !wide)) root.removeChild(body2);
    if (overH(root) && body2.parentNode) body2.style.display = 'none';
  }

  function head(parent, text) { return el('div', 'iv-phead', parent, text); }

  function panel(root, ctx, full) {
    var v = allowed() ? view() : null;
    if (!v) return panelMessage(root, emptyState());
    var wrap = el('div', 'iv-pwrap' + (full ? ' is-full' : '') + (staleAt() ? ' is-stale' : ''), root);
    var sec = el('div', 'iv-psec iv-ptop f', wrap);
    sec.setAttribute('data-key', 'total');
    sec.setAttribute('data-autofocus', '');
    var h = hero(sec, v, heroCap(v));
    h.className += ' is-panel';
    var forms = gainForms(v);
    if (forms.length) el('div', 'iv-pgain ' + gainTone(v), sec, forms[0]);
    fitWidth(h.numEl);
    if (v.g.shape.length > 1) {
      spark(sec, v.g, 'is-panel');
      el('div', 'iv-note is-panel', sec, v.g.days === 1 ? STRINGS.trendDay1 : fill(STRINGS.trendDays, { n: fmtNum(v.g.days) }));
    } else {
      trendNote(sec, 'is-panel');
    }
    var i;
    if (v.g.accounts.length) {
      head(wrap, STRINGS.accountsHead);
      allocBar(wrap, v, 'is-panel');
      for (i = 0; i < v.g.accounts.length; i++) {
        var r = acctRow(i, v);
        r.setAttribute('data-key', 'acct-' + i);
        wrap.appendChild(r);
      }
    }
    if (v.g.top.length) {
      head(wrap, STRINGS.holdingsHead);
      for (i = 0; i < v.g.top.length; i++) {
        var hr = holdRow(i, v, true, true);
        hr.setAttribute('data-key', 'hold-' + i);
        wrap.appendChild(hr);
      }
    }
  }

  function broken(body) {
    try {
      body.innerHTML = '';
      el('div', 'iv-msg-line', body, fill(STRINGS.broken, { title: STRINGS.title }));
    } catch (e) { /* nothing more to do */ }
  }

  /* ---------- registering ---------- */

  var widget = {
    id: 'investments',
    icon: 'trend',
    expandable: true,
    init: function (ctx) { try { S.ctx = ctx; bindLive(); } catch (e) { warn('init: ' + (e && e.message)); } },
    renderTile: function (body, ctx) {
      try {
        if (!S.ctx) { S.ctx = ctx; bindLive(); }
        tile(body, ctx);
      } catch (e) {
        warn('tile: ' + (e && e.message));
        broken(body);
      }
    },
    renderPanel: function (body, ctx) {
      try {
        var full = ctx.mode && ctx.mode() === 'full';
        ctx.setSub(allowed() && view() ? asOfText() : '');
        panel(el('div', 'iv-panel', body), ctx, full);
      } catch (e) {
        warn('panel: ' + (e && e.message));
        broken(body);
      }
    },
    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onStatus: function () { try { refresh(); } catch (e) { /* next change tries again */ } }
  };
  Object.defineProperty(widget, 'title', { get: function () { return STRINGS.title; }, enumerable: true, configurable: true });
  Object.defineProperty(widget, 'shortTitle', { get: function () { return STRINGS.titleShort || ''; }, enumerable: true, configurable: true });

  // A language change: new words, the tile and an open panel drawn again.
  try {
    var lx = I18N();
    if (lx && typeof lx.onChange === 'function') {
      lx.onChange(function () {
        try {
          localizeStrings();
          var ctx = S.ctx;
          if (ctx && typeof ctx.retitle === 'function') ctx.retitle();
          if (ctx && ctx.isOpen()) {
            var pt = document.querySelector('#panel .panel-title');
            if (pt) pt.textContent = STRINGS.title;
          }
          S.sig = '';
          refresh();
        } catch (e) { warn('language: ' + (e && e.message)); }
      });
    }
  } catch (e) { /* stays in the language it started in */ }

  // For dev/investments-test.js. Not used by the hub.
  window.HUB_INVESTMENTS_TEST = {
    STRINGS: EN,
    derive: derive,
    sharesOf: sharesOf,
    state: function () { return { m: S.m, g: S.g }; }
  };

  setTimeout(bindLive, 0);

  (window.HUB_WIDGETS = window.HUB_WIDGETS || []).push(widget);
})();
