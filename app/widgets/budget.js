/*
 * Personal budget: three tiles and a banner, from the budget app on the Pi.
 *
 *   budget-room    Daily room: the room per day left in the budget, a bar of
 *                  how much of the daily cap is left, and what it will be
 *                  once a pending refund posts. Amber under the cap, coral
 *                  below zero.
 *   budget-card    Card day: when the card is due, "Covered" (green) or
 *                  "Short by $X" (coral), the transfers that cover it and the
 *                  next paycheck.
 *   budget-goals   Goals: one bar per goal, colored by its state (clean, on
 *                  pace, over, under).
 *   The banner     "New charge: <label>" across the top when a charge posts
 *                  at a merchant that was cut. No amount, ever. OK (or Back)
 *                  dismisses it from any screen, and it clears itself after
 *                  5 minutes; this TV remembers which ones it has shown (homeHub.budget.seen.v1).
 *
 * The data is the live resource "budget" from the hub server on the Pi
 * (docs/budget-snapshot.md): only totals, sent by the budget app on the Pi
 * itself. The TV keeps the last copy (homeHub.budget.v1). After 2 hours
 * without a new copy the tiles say "as of" and the time, and step back.
 *
 * HUB_CONFIG.widgets.budget.show: false hides all of it (the tiles say so,
 * the banner never shows).
 *
 * Every word is in EN (English). The tiles follow the hub's language (the
 * Clock page's Language choice): HUB_I18N.localize turns EN into STRINGS,
 * with the Spanish under 'budget.<path>' keys in app/i18n.js. Amounts keep
 * their US form and what the budget app sends (goal names, transfer labels,
 * merchants) is shown as sent. window.HUB_BUDGET_STRINGS, when set before
 * this file loads, replaces any English word key by key (the tests use it).
 * Plain ES5 for the TV's browser; nothing animates but opacity and transform.
 */
(function () {
  'use strict';

  var EN = {
    titles: { room: 'Daily room', card: 'Card day', goals: 'Goals' },
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    // {dow} short weekday, {mon} short month, {d} day
    dateLong: '{dow}, {mon} {d}',
    dateShort: '{mon} {d}',
    am: 'AM',
    pm: 'PM',
    thousands: ',',
    // {n} is the figure without its sign
    cash: '${n}',
    minus: '−',
    sep: ' · ',
    asOf: 'as of {t}',
    more: '+{n} more',
    // Daily room
    aDay: 'a day',
    roomADay: 'room a day',
    ofCap: 'of {n} a day',
    capShort: 'cap {n}',
    daysLeft: '{n} days left',
    daysLeft1: '1 day left',
    daysLeft0: 'last day',
    through: 'through {d}',
    refund: 'about {n} once the pending refund posts',
    refundShort: 'about {n} after the refund',
    refundTiny: '{n} after refund',
    underCap: 'under the cap',
    overBudget: 'over the budget',
    // Card day
    covered: 'Covered',
    coveredWord: 'covered',
    shortBy: 'Short by {n}',
    shortWord: 'short {n}',
    today: 'today',
    tomorrow: 'tomorrow',
    inDays: 'in {n} days',
    todayCap: 'Today',
    cardOn: 'Card day {d}',
    transfersHead: 'Transfers',
    nextPay: 'Next paycheck {d}',
    nextPayShort: 'Paycheck {d}',
    paychecksHead: 'Paychecks',
    noTransfers: 'No transfers needed',
    // Goals
    goalStates: { clean: 'Clean', 'on-pace': 'On pace', over: 'Over', under: 'Under' },
    overN: '{n} over',
    overN1: '1 over',
    goalsN: '{n} goals',
    goals1: '1 goal',
    allOnTrack: 'all on track',
    noGoals: 'No goals set',
    overWord: 'over',
    goalsWord: 'goals',
    // The banner
    newCharge: 'New charge: {label}',
    moreCharges: '+{n} more',
    okHint: 'OK',
    states: {
      off: { head: 'Needs the Pi',
        line: 'The budget comes from the hub server on the Raspberry Pi. Live updates are off on this TV: set live.server in config.js to the Pi’s address.',
        short: 'Live updates are off.' },
      quiet: { head: 'Needs the Pi', line: 'This TV hasn’t reached the hub server on the Pi yet. It keeps trying quietly.', short: 'Waiting for the Pi.' },
      lost: { head: 'Can’t reach the Pi', line: 'These tiles fill in as soon as the Pi answers again.', short: 'Trying again quietly.' },
      loading: { head: 'Loading…', line: '', short: '' },
      waiting: { head: 'Waiting for the budget app',
        line: 'The budget app on the Pi sends its totals here. docs/budget-snapshot.md says how.',
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
  try { mergeStrings(EN, window.HUB_BUDGET_STRINGS); } catch (e) { /* keep English */ }

  // The words in the hub's language; set again when the language changes.
  var STRINGS = EN;

  function I18N() {
    var x = window.HUB_I18N;
    return x && typeof x.localize === 'function' ? x : null;
  }

  function localizeStrings() {
    var x = I18N();
    try { STRINGS = x ? x.localize(EN, 'budget') : EN; } catch (e) { STRINGS = EN; }
  }
  localizeStrings();

  var CACHE_KEY = 'homeHub.budget.v1';
  var SEEN_KEY = 'homeHub.budget.seen.v1';
  var MIN = 60000;
  var DAY = 24 * 60 * MIN;
  var STALE = 2 * 60 * MIN;
  var FALLBACK_TZ = 'America/Chicago';
  var GOAL_STATES = ['clean', 'on-pace', 'over', 'under'];

  /* ---------- small helpers (the same as awws.js, kept small) ---------- */

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
    try { if (window.console && console.warn) console.warn('Budget: ' + text); } catch (e) { /* ignore */ }
  }

  function remPx() {
    try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch (e) { return 16; }
  }

  function fmtNum(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, STRINGS.thousands);
  }

  // Whole dollars: "$42", "−$12".
  function cash(n) {
    var r = Math.round(n);
    return (r < 0 ? STRINGS.minus : '') + fill(STRINGS.cash, { n: fmtNum(Math.abs(r)) });
  }

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

  // Rows while they fit, then "+N more". Returns how many are shown.
  function fitRows(list, more, rows) {
    var shown = rows.length;
    var i;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (i = 0; i < shown; i++) list.appendChild(rows[i]);
    function setMore() {
      if (!more) return;
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

  // Takes optional parts away, last first, until the box fits.
  function trim(box, parts) {
    for (var i = parts.length - 1; i >= 0 && overH(box); i--) {
      if (parts[i] && parts[i].parentNode) parts[i].parentNode.removeChild(parts[i]);
    }
  }

  // A line made of parts { t, c }: the first form that fits on one line.
  function fitParts(node, forms) {
    for (var f = 0; f < forms.length; f++) {
      if (!forms[f]) continue;
      while (node.firstChild) node.removeChild(node.firstChild);
      for (var i = 0; i < forms[f].length; i++) el('span', forms[f][i].c || '', node, forms[f][i].t);
      if (!overW(node)) return true;
    }
    node.style.display = 'none';
    return false;
  }

  function sepPart() { return { t: STRINGS.sep, c: 'bu-sep' }; }

  function parseIso(s) {
    if (typeof s !== 'string') return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  // A date "2026-11-19" as a day number (days since 1970-01-01), or null.
  function dayFromText(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(t);
    if (d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) return null;
    return Math.round(t / DAY);
  }

  function dateText(n, form) {
    var d = new Date(n * DAY);
    var map = { dow: STRINGS.daysShort[d.getUTCDay()], mon: STRINGS.monthsShort[d.getUTCMonth()], d: d.getUTCDate() };
    return fill(form === 'short' ? STRINGS.dateShort : STRINGS.dateLong, map);
  }

  /* ---------- the Pi's time zone: today and "as of 7:10 AM" ---------- */

  var zoneFmt = null;
  var zoneName = '';

  function tzName() {
    var c = null;
    try { c = window.HUB_LIVE && window.HUB_LIVE.get('calendar'); } catch (e) { c = null; }
    return (c && typeof c.tz === 'string' && c.tz) || FALLBACK_TZ;
  }

  // [year, month, day, hour, minute] on the wall clock in the Pi's zone.
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

  function today() {
    var w = wall(now());
    return Math.round(Date.UTC(w[0], w[1] - 1, w[2]) / DAY);
  }

  function hm(ms) {
    var w = wall(ms);
    var h = w[3];
    return (h % 12 === 0 ? 12 : h % 12) + ':' + (w[4] < 10 ? '0' : '') + w[4] + ' ' + (h < 12 ? STRINGS.am : STRINGS.pm);
  }

  /* ---------- the shared store ---------- */

  var S = { ctxs: {}, order: [], bound: false, data: null, fromCache: false, timer: null, sig: '', seen: null, banner: null, current: null };

  function config() {
    var w = window.HUB_CONFIG && window.HUB_CONFIG.widgets;
    var c = w && w.budget;
    return c && typeof c === 'object' ? c : {};
  }

  function shown() { return config().show !== false; }

  function L() {
    var x = window.HUB_LIVE;
    return x && typeof x === 'object' && typeof x.status === 'function' ? x : null;
  }

  function ready(d) {
    return !!d && typeof d === 'object' && !isArr(d) && !isNaN(parseIso(d.sentAt));
  }

  function section(name) {
    var v = ready(S.data) ? S.data[name] : null;
    return v && typeof v === 'object' && !isArr(v) ? v : null;
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

  // Why a tile has nothing to show: a key of STRINGS.states.
  function emptyState() {
    if (!shown()) return 'hidden';
    if (ready(S.data)) return 'waiting';
    return lineState();
  }

  function staleAt() {
    if (!ready(S.data)) return 0;
    var at = parseIso(S.data.sentAt);
    return now() - at >= STALE ? at : 0;
  }

  function asOfText() {
    var at = staleAt();
    if (!at) return '';
    var w = wall(at);
    var day = Math.round(Date.UTC(w[0], w[1] - 1, w[2]) / DAY);
    return fill(STRINGS.asOf, { t: day === today() ? hm(at) : dateText(day, 'short') });
  }

  function loadCache() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      var c = JSON.parse(raw);
      if (c && ready(c.data)) { S.data = c.data; S.fromCache = true; }
    } catch (e) { /* start without it */ }
  }

  function saveCache() {
    try {
      if (!window.localStorage) return;
      if (S.data) window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, at: now(), data: S.data }));
      else window.localStorage.removeItem(CACHE_KEY);
    } catch (e) { /* the copy in memory still works */ }
  }

  function onData(d) {
    if (!d || typeof d !== 'object' || isArr(d)) return;
    // { sentAt: null } is the Pi saying "nothing stored": forget the copy too.
    S.data = ready(d) ? d : null;
    S.fromCache = false;
    saveCache();
    refreshAll();
    updateBanner();
  }

  function signature() {
    var key;
    try { key = JSON.stringify(S.data, function (k, v) { return k === 'receivedAt' ? undefined : v; }); } catch (e) { key = String(now()); }
    return [emptyState(), lineState(), today(), asOfText(), key].join('|');
  }

  function refreshAll() {
    var sig = signature();
    if (sig === S.sig) return;
    S.sig = sig;
    for (var i = 0; i < S.order.length; i++) {
      var ctx = S.ctxs[S.order[i]];
      if (!ctx) continue;
      try {
        ctx.redrawTile();
        if (ctx.isOpen()) ctx.redrawPanel();
      } catch (e) { warn('redraw: ' + (e && e.message)); }
    }
  }

  function schedule() {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      S.timer = null;
      try { refreshAll(); } catch (e) { warn(e && e.message); }
      schedule();
    }, MIN - (now() % MIN) + 250);
  }

  // Binds to the live line once. live.js loads after the widgets, so this is
  // tried again for a while; the banner needs it even with no budget tile.
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
    if (!shown()) return;
    loadCache();
    try {
      var d = x.get('budget');
      if (d && typeof d === 'object') { S.data = ready(d) ? d : null; S.fromCache = false; saveCache(); }
    } catch (e) { /* wait for it */ }
    try { x.on('budget', function (d) { try { onData(d); } catch (e) { warn(e && e.message); } }); } catch (e) { warn('live: ' + (e && e.message)); }
    try { if (typeof x.onStatus === 'function') x.onStatus(function () { try { refreshAll(); } catch (e) { /* next time */ } }); } catch (e) { /* ignore */ }
    S.sig = signature();
    schedule();
    updateBanner();
  }

  function bind(ctx) {
    if (!S.ctxs[ctx.id]) S.order.push(ctx.id);
    S.ctxs[ctx.id] = ctx;
    bindLive();
  }

  /* ---------- shared drawing ---------- */

  function sizeOf(ctx) {
    var z = ctx && ctx.size ? ctx.size() : null;
    return z || { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
  }

  function mark(parent, cls) {
    var m = el('span', 'icon bu-mark' + (cls ? ' ' + cls : ''), parent);
    m.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.wallet) || '';
    return m;
  }

  function tileMessage(root, size, key) {
    var msg = STRINGS.states[key] || STRINGS.states.waiting;
    if (size.cols === 1) return mark(root, 'is-solo');
    if (size.tier === 'strip') {
      root.className += ' bu-strip';
      return el('div', 'bu-strip-text bu-cut is-quiet', root, msg.head);
    }
    var box = el('div', 'bu-msg', root);
    el('div', 'bu-msg-head', box, msg.head);
    var line = msg.short ? el('div', 'bu-msg-line', box, msg.short) : null;
    trim(root, [line]);
    if (overH(root)) box.firstChild.className += ' is-small';
    mark(root);
    return box;
  }

  function panelMessage(root, key) {
    var msg = STRINGS.states[key] || STRINGS.states.waiting;
    var box = el('div', 'bu-pmsg', root);
    el('div', 'bu-pmsg-head', box, msg.head);
    if (msg.line) el('div', 'bu-pmsg-line', box, msg.line);
    mark(root, 'is-panel');
  }

  // The 1-column tile: one figure as big as fits, a word under it.
  function solo(root, text, caps, tone) {
    root.className += ' bu-solo';
    var n = el('div', 'bu-solo-num' + (tone ? ' ' + tone : ''), root, text);
    fitWidth(n);
    var c = el('div', 'bu-solo-cap', root);
    if (!fitForms(c, caps)) root.removeChild(c);
  }

  // A big figure and its caption.
  function hero(parent, text, cap, tone, cls) {
    var box = el('div', 'bu-hero' + (cls ? ' ' + cls : ''), parent);
    box.numEl = el('span', 'bu-hero-num' + (tone ? ' ' + tone : ''), box, text);
    if (cap) box.capEl = el('span', 'bu-hero-cap', box, cap);
    return box;
  }

  // Shrinks the figure to its line; a caption pushed under it takes a
  // shorter word, or goes when even that would wrap.
  function fitHero(box, shortCap) {
    fitWidth(box.numEl);
    var cap = box.capEl;
    if (!cap || !cap.parentNode) return;
    if (cap.offsetLeft <= box.numEl.offsetLeft + 1 && shortCap) cap.textContent = shortCap;
    if (overW(cap)) box.removeChild(cap);
  }

  // A thin bar: fill is 0..1.
  function meter(parent, frac, tone) {
    var track = el('div', 'bu-meter', parent);
    var f = Math.max(0, Math.min(1, frac));
    var bar = el('span', 'bu-meter-fill' + (tone ? ' ' + tone : ''), track);
    bar.style.width = (f > 0 ? Math.max(2, Math.round(f * 100)) : 0) + '%';
    return track;
  }

  function broken(body, title) {
    try {
      body.innerHTML = '';
      el('div', 'bu-msg-line', body, fill(STRINGS.broken, { title: title }));
    } catch (e) { /* nothing more to do */ }
  }

  function dim(root) { if (staleAt()) root.className += ' is-stale'; }

  /* ---------- Daily room ---------- */

  function roomData() {
    var s = section('room');
    if (!s || num(s.cap) === null || num(s.roomPerDay) === null) return null;
    // Room is shown in whole dollars rounded down, so the TV never promises
    // a cent more than there is.
    var refund = num(s.roomIfRefund);
    var r = { cap: s.cap, per: Math.floor(s.roomPerDay), refund: refund === null ? null : Math.floor(refund),
      days: num(s.daysLeft), through: dayFromText(s.throughDate) };
    r.tone = r.per < 0 ? 'is-neg' : r.per < r.cap ? 'is-under' : 'is-ok';
    return r;
  }

  function daysLeftText(r) {
    if (r.days === null) return '';
    return r.days === 0 ? STRINGS.daysLeft0 : r.days === 1 ? STRINGS.daysLeft1 : fill(STRINGS.daysLeft, { n: fmtNum(r.days) });
  }

  function roomForms(r, withRefund) {
    var parts = [fill(STRINGS.ofCap, { n: cash(r.cap) })];
    var d = daysLeftText(r);
    var forms = [];
    if (d) parts.push(d);
    if (withRefund && r.refund !== null) forms.push(parts.concat([fill(STRINGS.refundShort, { n: cash(r.refund) })]).join(STRINGS.sep));
    forms.push(parts.join(STRINGS.sep));
    if (d) forms.push(fill(STRINGS.capShort, { n: cash(r.cap) }) + STRINGS.sep + d);
    forms.push(parts[0], fill(STRINGS.capShort, { n: cash(r.cap) }));
    return forms;
  }

  function roomTile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'bu-tile bu-room', body);
    var r = shown() ? roomData() : null;
    ctx.setTileSub(r ? asOfText() : '');
    if (!r) return tileMessage(root, size, emptyState());
    dim(root);
    var per = cash(r.per);
    if (size.cols === 1) return solo(root, per, [STRINGS.aDay], r.tone);
    if (size.tier === 'strip') {
      root.className += ' bu-strip';
      if (size.width === 'narrow' || size.cols < 4) {
        var hs = hero(root, per, STRINGS.aDay, r.tone, 'is-strip');
        fitHero(hs);
        return;
      }
      var line = el('div', 'bu-strip-line', root);
      el('span', 'bu-strip-num ' + r.tone, line, per);
      var word = el('span', 'bu-strip-word', line, STRINGS.aDay);
      var m = size.cols >= 5 ? meter(line, r.per / r.cap, r.tone) : null;
      if (m) m.className += ' is-strip';
      var text = el('span', 'bu-strip-rest', line);
      if (!fitForms(text, roomForms(r, true).map(function (f) { return STRINGS.sep + f; }))) {
        if (m) line.removeChild(m);
      }
      if (m && overW(line)) line.removeChild(m);
      if (overW(line)) line.removeChild(word);
      return;
    }
    var h = hero(root, per, STRINGS.roomADay, r.tone);
    var bar = meter(root, r.per / r.cap, r.tone);
    var cap = el('div', 'bu-line', root);
    var thru = r.through !== null ? el('div', 'bu-quiet', root) : null;
    var refund = r.refund !== null ? el('div', 'bu-note', root) : null;
    fitHero(h, STRINGS.aDay);
    fitForms(cap, roomForms(r, false));
    if (thru) fitForms(thru, [fill(STRINGS.through, { d: dateText(r.through, 'long') }), fill(STRINGS.through, { d: dateText(r.through, 'short') })]);
    if (refund) {
      refund.textContent = fill(STRINGS.refund, { n: cash(r.refund) });
      if (overH(refund) || overW(refund)) fitForms(refund, [fill(STRINGS.refundShort, { n: cash(r.refund) }), fill(STRINGS.refundTiny, { n: cash(r.refund) })]);
    }
    trim(root, [cap, refund, thru]);
    if (overH(root) && bar.parentNode) root.removeChild(bar);
  }

  function roomPanel(root, ctx, full) {
    var r = shown() ? roomData() : null;
    if (!r) return panelMessage(root, emptyState());
    var wrap = el('div', 'bu-pwrap' + (staleAt() ? ' is-stale' : ''), root);
    var sec = el('div', 'bu-psec f', wrap);
    sec.setAttribute('data-key', 'room');
    sec.setAttribute('data-autofocus', '');
    var h = hero(sec, cash(r.per), STRINGS.roomADay, r.tone, 'is-panel');
    meter(sec, r.per / r.cap, r.tone).className += ' is-panel';
    var lines = [fill(STRINGS.ofCap, { n: cash(r.cap) })];
    if (daysLeftText(r)) lines.push(daysLeftText(r));
    if (r.through !== null) lines.push(fill(STRINGS.through, { d: dateText(r.through, 'long') }));
    el('div', 'bu-pline', sec, lines.join(STRINGS.sep));
    if (r.per < 0) el('div', 'bu-pline is-neg', sec, STRINGS.overBudget);
    else if (r.per < r.cap) el('div', 'bu-pline is-under', sec, STRINGS.underCap);
    if (r.refund !== null) el('div', 'bu-pline is-quiet', sec, fill(STRINGS.refund, { n: cash(r.refund) }));
    fitWidth(h.numEl);
    if (full) wrap.className += ' is-full';
  }

  /* ---------- Card day ---------- */

  function cardData() {
    var s = section('cardDay');
    var day = s ? dayFromText(s.date) : null;
    if (!s || day === null || typeof s.covered !== 'boolean') return null;
    var short = num(s.shortBy);
    // A shortfall in whole dollars rounded up, never smaller than it is.
    var c = { day: day, away: num(s.daysAway), covered: s.covered, short: short === null ? null : Math.ceil(short), transfers: [], pay: [] };
    var t = isArr(s.transfers) ? s.transfers : [];
    for (var i = 0; i < t.length; i++) {
      if (t[i] && str(t[i].label) && num(t[i].amount) !== null) c.transfers.push({ label: str(t[i].label), amount: t[i].amount });
    }
    var p = isArr(s.paychecks) ? s.paychecks : [];
    var td = today();
    for (var j = 0; j < p.length; j++) {
      var pd = dayFromText(p[j]);
      if (pd !== null && pd >= td) c.pay.push(pd);
    }
    c.pay.sort(function (a, b) { return a - b; });
    // The days away, from the date itself once the TV's day has moved on.
    var left = day - td;
    if (c.away === null || left !== c.away) c.away = Math.max(0, left);
    c.tone = c.covered ? 'is-ok' : 'is-neg';
    c.word = c.covered ? STRINGS.covered : fill(STRINGS.shortBy, { n: cash(c.short || 0) });
    if (!c.covered && c.short === null) c.word = fill(STRINGS.shortBy, { n: '' }).replace(/\s+$/, '');
    return c;
  }

  function awayText(c) {
    return c.away === 0 ? STRINGS.today : c.away === 1 ? STRINGS.tomorrow : fill(STRINGS.inDays, { n: fmtNum(c.away) });
  }

  function whenForms(c) {
    return [dateText(c.day, 'long') + STRINGS.sep + awayText(c), dateText(c.day, 'short') + STRINGS.sep + awayText(c),
      dateText(c.day, 'short'), awayText(c)];
  }

  function payForms(c) {
    if (!c.pay.length) return [];
    return [fill(STRINGS.nextPay, { d: dateText(c.pay[0], 'long') }), fill(STRINGS.nextPay, { d: dateText(c.pay[0], 'short') }),
      fill(STRINGS.nextPayShort, { d: dateText(c.pay[0], 'short') })];
  }

  function transferRow(t) {
    var row = el('div', 'bu-trow');
    el('span', 'bu-trow-label bu-cut', row, t.label);
    el('span', 'bu-trow-value', row, cash(t.amount));
    return row;
  }

  function cardTile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'bu-tile bu-card', body);
    var c = shown() ? cardData() : null;
    ctx.setTileSub(c ? asOfText() : '');
    if (!c) return tileMessage(root, size, emptyState());
    dim(root);
    if (size.cols === 1) {
      return solo(root, c.away === 0 ? STRINGS.todayCap : fmtNum(c.away), c.covered ? [STRINGS.coveredWord] :
        [fill(STRINGS.shortWord, { n: cash(c.short || 0) }), cash(-(c.short || 0))], c.tone);
    }
    if (size.tier === 'strip') {
      root.className += ' bu-strip';
      if (size.width === 'narrow') {
        var hs = hero(root, c.word, '', c.tone, 'is-strip is-word');
        fitHero(hs);
        return;
      }
      var line = el('div', 'bu-strip-line', root);
      el('span', 'bu-strip-word2 ' + c.tone, line, c.word);
      var rest = el('span', 'bu-strip-rest', line);
      var forms = [];
      var w = whenForms(c);
      var p = payForms(c);
      for (var i = 0; i < w.length; i++) {
        if (p.length) forms.push(STRINGS.sep + w[i] + STRINGS.sep + p[Math.min(i, p.length - 1)]);
        forms.push(STRINGS.sep + w[i]);
      }
      fitForms(rest, forms);
      // A word too long for the line (a longer language): the word alone, shrunk to fit.
      if (overW(line)) {
        root.removeChild(line);
        fitHero(hero(root, c.word, '', c.tone, 'is-strip is-word'));
      }
      return;
    }
    var wide = size.width === 'wide' && c.transfers.length > 0;
    var left = wide ? el('div', 'bu-split-a', el('div', 'bu-split', root)) : root;
    var right = wide ? el('div', 'bu-split-b', left.parentNode) : null;
    var when = el('div', 'bu-when', left);
    var h = hero(left, c.word, '', c.tone, 'is-word');
    var list = null;
    var more = null;
    if (c.transfers.length && size.cols >= 3) {
      var sect = el('div', 'bu-sect', wide ? right : left);
      el('div', 'bu-label', sect, STRINGS.transfersHead);
      list = el('div', 'bu-list', sect);
      more = el('div', 'bu-more', sect);
    }
    var pay = c.pay.length ? el('div', 'bu-foot', root) : null;
    fitForms(when, whenForms(c));
    fitHero(h);
    if (pay) fitForms(pay, payForms(c));
    if (list) {
      var rows = [];
      for (var k = 0; k < c.transfers.length; k++) rows.push(transferRow(c.transfers[k]));
      if (!fitRows(list, more, rows)) list.parentNode.parentNode.removeChild(list.parentNode);
    }
    trim(root, [pay]);
    if (!list && size.cols >= 3) mark(root);
  }

  function cardPanel(root, ctx, full) {
    var c = shown() ? cardData() : null;
    if (!c) return panelMessage(root, emptyState());
    var wrap = el('div', 'bu-pwrap' + (full ? ' is-full is-cols' : '') + (staleAt() ? ' is-stale' : ''), root);
    var colA = el('div', 'bu-pcol', wrap);
    var colB = full ? el('div', 'bu-pcol', wrap) : colA;
    var top = el('div', 'bu-psec f', colA);
    top.setAttribute('data-key', 'card');
    top.setAttribute('data-autofocus', '');
    el('div', 'bu-pline', top, fill(STRINGS.cardOn, { d: dateText(c.day, 'long') }) + STRINGS.sep + awayText(c));
    var h = hero(top, c.word, '', c.tone, 'is-panel is-word');
    fitWidth(h.numEl);
    var ts = el('div', 'bu-psec f', colB);
    ts.setAttribute('data-key', 'transfers');
    el('div', 'bu-label', ts, STRINGS.transfersHead);
    if (!c.transfers.length) el('div', 'bu-pline is-quiet', ts, STRINGS.noTransfers);
    for (var i = 0; i < c.transfers.length; i++) ts.appendChild(transferRow(c.transfers[i]));
    if (c.pay.length) {
      var ps = el('div', 'bu-psec f', colA);
      ps.setAttribute('data-key', 'pay');
      el('div', 'bu-label', ps, STRINGS.paychecksHead);
      for (var j = 0; j < c.pay.length; j++) el('div', 'bu-pline', ps, dateText(c.pay[j], 'long'));
    }
  }

  /* ---------- Goals ---------- */

  function goalsData() {
    var s = section('goals');
    if (!s || !isArr(s.items)) return null;
    var out = [];
    for (var i = 0; i < s.items.length; i++) {
      var g = s.items[i];
      if (!g || !str(g.label) || GOAL_STATES.indexOf(g.state) < 0) continue;
      out.push({ label: str(g.label), state: g.state, text: str(g.text), pct: num(g.pct) });
    }
    return out;
  }

  function overCount(list) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].state === 'over') n += 1;
    return n;
  }

  // One goal: label, a bar (or its state in words when there is no
  // percentage) and its own short text.
  function goalRow(g, panel) {
    var row = el('div', 'bu-grow is-g-' + g.state + (panel ? ' bu-psec f' : ''));
    var top = el('div', 'bu-grow-top', row);
    el('span', 'bu-grow-label bu-cut', top, g.label);
    el('span', 'bu-grow-text', top, g.text || STRINGS.goalStates[g.state]);
    if (g.pct !== null) {
      var track = el('div', 'bu-meter is-goal', row);
      var f = el('span', 'bu-meter-fill', track);
      f.style.width = (g.pct > 0 ? Math.max(2, Math.round(g.pct)) : 0) + '%';
    } else if (g.text) {
      el('div', 'bu-grow-state', row, STRINGS.goalStates[g.state]);
    }
    return row;
  }

  function goalsSummary(list) {
    var n = overCount(list);
    var count = list.length === 1 ? STRINGS.goals1 : fill(STRINGS.goalsN, { n: fmtNum(list.length) });
    var over = n === 1 ? STRINGS.overN1 : fill(STRINGS.overN, { n: fmtNum(n) });
    return [count + STRINGS.sep + (n ? over : STRINGS.allOnTrack), n ? over : count, fmtNum(n || list.length)];
  }

  function goalsTile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'bu-tile bu-goals', body);
    var list = shown() ? goalsData() : null;
    ctx.setTileSub(list ? asOfText() : '');
    if (!list) return tileMessage(root, size, emptyState());
    dim(root);
    var over = overCount(list);
    if (size.cols === 1) {
      return over ? solo(root, fmtNum(over), [STRINGS.overWord], 'is-neg') : solo(root, fmtNum(list.length), [STRINGS.goalsWord]);
    }
    if (!list.length) {
      if (size.tier === 'strip') { root.className += ' bu-strip'; return el('div', 'bu-strip-text bu-cut is-quiet', root, STRINGS.noGoals); }
      el('div', 'bu-msg-head is-small', el('div', 'bu-msg', root), STRINGS.noGoals);
      return mark(root);
    }
    if (size.tier === 'strip') {
      root.className += ' bu-strip';
      var line = el('div', 'bu-strip-line', root);
      var head = el('span', 'bu-strip-count' + (over ? ' is-neg' : ''), line);
      fitForms(head, goalsSummary(list));
      // The summary stays whole from here: the goals must fit beside it.
      head.style.flexShrink = '0';
      // The goals that are over first, then the rest, while they fit whole.
      var order = [];
      var i;
      for (i = 0; i < list.length; i++) if (list[i].state === 'over') order.push(list[i]);
      for (i = 0; i < list.length; i++) if (list[i].state !== 'over') order.push(list[i]);
      for (i = 0; i < order.length; i++) {
        var part = el('span', 'bu-strip-goal is-g-' + order[i].state, line, STRINGS.sep + order[i].label + ' ' + (order[i].text || STRINGS.goalStates[order[i].state]));
        if (overW(line)) { line.removeChild(part); break; }
      }
      return;
    }
    var box = el('div', 'bu-list bu-glist' + (size.width === 'narrow' ? ' is-narrow' : ''), root);
    var more = el('div', 'bu-more', root);
    var rows = [];
    for (var k = 0; k < list.length; k++) rows.push(goalRow(list[k], false));
    fitRows(box, more, rows);
  }

  function goalsPanel(root, ctx, full) {
    var list = shown() ? goalsData() : null;
    if (!list) return panelMessage(root, emptyState());
    var wrap = el('div', 'bu-pwrap bu-gpanel' + (full ? ' is-full' : '') + (staleAt() ? ' is-stale' : ''), root);
    var sum = el('div', 'bu-pline', wrap, goalsSummary(list)[0]);
    if (overCount(list)) sum.className += ' is-neg';
    if (!list.length) el('div', 'bu-pline is-quiet', wrap, STRINGS.noGoals);
    for (var i = 0; i < list.length; i++) {
      var row = goalRow(list[i], true);
      row.setAttribute('data-key', 'goal-' + i);
      if (i === 0) row.setAttribute('data-autofocus', '');
      wrap.appendChild(row);
    }
  }

  /* ---------- the banner: a new charge at a merchant that was cut ---------- */

  function seenList() {
    if (S.seen) return S.seen;
    S.seen = [];
    try {
      var raw = window.localStorage && window.localStorage.getItem(SEEN_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (isArr(list)) for (var i = 0; i < list.length; i++) if (typeof list[i] === 'string') S.seen.push(list[i]);
    } catch (e) { /* none yet */ }
    return S.seen;
  }

  function markSeen(id) {
    var list = seenList();
    if (list.indexOf(id) < 0) list.push(id);
    while (list.length > 50) list.shift();
    try { if (window.localStorage) window.localStorage.setItem(SEEN_KEY, JSON.stringify(list)); } catch (e) { /* kept in memory */ }
  }

  // The alerts this TV hasn't dismissed yet, oldest first.
  function pending() {
    var s = shown() ? section('alerts') : null;
    var out = [];
    if (!s || !isArr(s.items)) return out;
    var seen = seenList();
    for (var i = 0; i < s.items.length; i++) {
      var a = s.items[i];
      if (a && str(a.id) && str(a.label) && seen.indexOf(a.id) < 0) out.push({ id: a.id, label: str(a.label) });
    }
    return out;
  }

  function bannerEl() {
    if (S.banner) return S.banner;
    var b = el('div', 'bu-alert', document.body);
    b.setAttribute('role', 'alert');
    var icon = el('span', 'icon bu-alert-icon', b);
    icon.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.wallet) || '';
    b.textEl = el('span', 'bu-alert-text bu-cut', b);
    b.moreEl = el('span', 'bu-alert-more', b);
    el('span', 'bu-alert-ok', b, STRINGS.okHint);
    S.banner = b;
    return b;
  }

  var hideTimer = null;
  var expireTimer = null;
  var expireFor = null;               // the alert id the expiry timer is counting for
  var EXPIRE_MS = 5 * MIN;            // a banner nobody dismissed clears itself after this

  function stopExpiry() {
    if (expireTimer) clearTimeout(expireTimer);
    expireTimer = null;
    expireFor = null;
  }

  // Counts from when this TV first shows each charge, so one left up on a
  // screen nobody is watching doesn't sit there for days.
  function startExpiry(id) {
    if (expireTimer && expireFor === id) return;
    stopExpiry();
    expireFor = id;
    expireTimer = setTimeout(function () {
      expireTimer = null;
      expireFor = null;
      try { if (S.current && S.current.id === id) { markSeen(id); S.current = null; updateBanner(); } } catch (e) { warn('expiry: ' + (e && e.message)); }
    }, EXPIRE_MS);
  }

  function updateBanner() {
    try {
      var list = pending();
      var b = S.banner;
      if (!list.length) {
        S.current = null;
        stopExpiry();
        if (b && b.className.indexOf('is-shown') >= 0) {
          b.className = 'bu-alert is-on';
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(function () { hideTimer = null; if (!S.current) b.className = 'bu-alert'; }, 300);
        }
        return;
      }
      b = bannerEl();
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      S.current = list[0];
      startExpiry(list[0].id);
      b.textEl.textContent = fill(STRINGS.newCharge, { label: list[0].label });
      b.moreEl.textContent = list.length > 1 ? fill(STRINGS.moreCharges, { n: list.length - 1 }) : '';
      b.moreEl.style.display = list.length > 1 ? '' : 'none';
      if (b.className.indexOf('is-shown') < 0) {
        b.className = 'bu-alert is-on';
        // One frame later, so the fade in runs (opacity and transform only).
        setTimeout(function () { if (S.current) b.className = 'bu-alert is-on is-shown'; }, 30);
      }
    } catch (e) { warn('banner: ' + (e && e.message)); }
  }

  // For hub.js: OK or Back on any screen dismisses the banner first.
  window.HUB_ALERT = {
    shown: function () { return !!S.current; },
    dismiss: function () {
      if (!S.current) return false;
      markSeen(S.current.id);
      S.current = null;
      updateBanner();
      return true;
    },
    // For tests: how long a banner stays up before it clears itself.
    setExpiry: function (ms) { EXPIRE_MS = ms; stopExpiry(); updateBanner(); },
    text: function () { return S.current && S.banner ? S.banner.textContent : ''; }
  };

  /* ---------- registering ---------- */

  function real(id, titleKey, drawTile, drawPanel) {
    var w = {
      id: id,
      icon: 'wallet',
      expandable: true,
      init: function (ctx) { try { bind(ctx); } catch (e) { warn('init: ' + (e && e.message)); } },
      renderTile: function (body, ctx) {
        try {
          if (!S.ctxs[ctx.id]) bind(ctx);
          drawTile(body, ctx);
        } catch (e) {
          warn('tile ' + id + ': ' + (e && e.message));
          broken(body, STRINGS.titles[titleKey]);
        }
      },
      renderPanel: function (body, ctx) {
        try {
          var full = ctx.mode && ctx.mode() === 'full';
          ctx.setSub(shown() ? asOfText() : '');
          drawPanel(el('div', 'bu-panel' + (full ? ' is-full' : ''), body), ctx, full);
        } catch (e) {
          warn('panel ' + id + ': ' + (e && e.message));
          broken(body, STRINGS.titles[titleKey]);
        }
      },
      onMode: function (mode, ctx) { ctx.redrawPanel(); },
      onStatus: function () { try { refreshAll(); } catch (e) { /* next change tries again */ } }
    };
    // Read when the hub draws the tile head, so it follows the language.
    Object.defineProperty(w, 'title', { get: function () { return STRINGS.titles[titleKey]; }, enumerable: true, configurable: true });
    return w;
  }

  // A language change: new words, every tile and an open panel drawn again,
  // with their titles (the hub draws those once).
  function onLang() {
    localizeStrings();
    for (var i = 0; i < S.order.length; i++) {
      var id = S.order[i];
      var ctx = S.ctxs[id];
      var key = id.replace('budget-', '');
      var heads = document.querySelectorAll('.cell[data-widget="' + id + '"] .tile-title');
      for (var j = 0; j < heads.length; j++) heads[j].textContent = STRINGS.titles[key] || '';
      if (ctx && ctx.isOpen()) {
        var pt = document.querySelector('#panel .panel-title');
        if (pt) pt.textContent = STRINGS.titles[key] || '';
      }
    }
    S.sig = '';
    refreshAll();
    updateBanner();
  }

  try {
    var lx = I18N();
    if (lx && typeof lx.onChange === 'function') lx.onChange(function () { try { onLang(); } catch (e) { warn('language: ' + (e && e.message)); } });
  } catch (e) { /* stays in the language it started in */ }

  // For dev/money-test.js. Not used by the hub.
  window.HUB_BUDGET_TEST = {
    STRINGS: EN,
    strings: function () { return STRINGS; },
    store: S,
    refresh: function () { refreshAll(); updateBanner(); },
    seen: function () { return seenList().slice(); }
  };

  setTimeout(bindLive, 0);

  var list = (window.HUB_WIDGETS = window.HUB_WIDGETS || []);
  list.push(real('budget-room', 'room', roomTile, roomPanel));
  list.push(real('budget-card', 'card', cardTile, cardPanel));
  list.push(real('budget-goals', 'goals', goalsTile, goalsPanel));
})();
