/*
 * Personal budget: three tiles and a banner, from the budget app on the Pi.
 *
 *   budget-room    Daily room: the room per day left in the budget, a bar of
 *                  how much of the daily cap is left, and what it will be
 *                  once a pending refund posts. Amber under the cap, coral
 *                  below zero.
 *   budget-card    Card day: when the card is due, "Covered" (green) or
 *                  "Short by $X" (coral), the transfers that cover it and the
 *                  next paycheck. When the snapshot carries cardDay.receipt
 *                  (a prototype, docs/budget-snapshot.md says nothing of it
 *                  yet) the tile is a 3 line receipt, the panel the whole
 *                  receipt (OK on a row opens that row's items in place, Back
 *                  returns) and nothing says "Transfers".
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
 * the banner never shows). Guest mode (guest.js) hides nothing here: it blurs
 * the dollar amounts on these tiles, their panels and the banner.
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
    // Short forms, only when a title doesn't fit its tile on one line (the hub measures).
    titlesShort: { room: 'Room', card: 'Card', goals: 'Goals' },
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
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
    // Card day, autopay days: short on card day but every card is paid by its own autopay day
    planHead: 'Payments',
    autoWord: 'Short {n}',
    autoNote: 'for {d}, covered by autopay',
    autoNoteShort: 'covered by autopay',
    autoNoteTiny: 'autopay',
    autoSolo: 'autopay',
    autoPay: 'autopay',
    autoShortNote: '{n} short even with autopay',
    autoShortNoteShort: '{n} short with autopay',
    // Card day receipt, the budget app's own lines: one list read top to bottom, each with a sign.
    // {d} is card day, {e} the day the next paycheck lands (both short dates)
    receipt: {
      lines: {
        checking: 'Checking now',
        paychecks: 'Paychecks before {d}',
        billsBefore: 'Bills before {d}',
        cardsToday: 'Cards today, pending included',
        cardCharges: 'Recurring charges on the cards before {d}',
        billsAfter: 'Bills from {d} to payday {e}',
        billsAfterNo: 'Bills from {d} to the next payday',
        buys: 'Planned buys'
      },
      bottom: 'Left to spend',
      bottomNote: 'What checking will hold just before your {e} paycheck, after the bills and paying today’s card balances in full. Every new charge comes out of it.',
      bottomNoteNo: 'What checking will hold just before your next paycheck, after the bills and paying today’s card balances in full. Every new charge comes out of it.',
      miniBills: 'Cards and bills to {e}',
      miniBillsNo: 'Cards and bills to the next payday',
      heroLeft: '{n} left to spend',
      heroDay: 'about {n} a day',
      heroShort: 'Short {n} on {d}',
      heroShortPlain: 'Short {n}',
      heroByAutopay: 'covered by autopay',
      heroEven: 'even with autopay',
      noPay: 'None before {d}. Next: {n}',
      noPayNext: 'None before {d}',
      planHead: 'Payment plan',
      payOn: 'Pay on {d}',
      leaveFor: 'Leave for autopay',
      planNote: 'A plan to read, nothing here pays a card or moves money.',
      okHint: 'OK for details',
      backHint: 'Back to the receipt',
      nextPay: 'Next paycheck {d} · {n}',
      checkingNote: 'Available balance, pending debits already out.',
      checkingAsOf: 'As of {t} sync.',
      payNote: 'The smallest of the last three deposits.',
      buysNote: 'Edit them on the budget site.',
      newTag: 'new',
      total: 'Total',
      owesBal: 'Balance {n}',
      owesPending: 'pending {n}',
      owesComing: 'plus {n} in recurring charges before {d}',
      cardAutopay: 'Autopay {d}',
      cardNoAutopay: 'No autopay day',
      cardPays: 'You pay {n} on {d}',
      cardAuto: 'Autopay takes {n}',
      formula: 'Checking, plus paychecks, less bills, cards, charges and buys:',
      onCard: 'on {card}',
      empty: 'Nothing here.',
      // The next 3 months page (sample data). {d} short date, {n} a figure, {m} a month name
      outlook: {
        tabReceipt: 'Receipt',
        tabOutlook: 'Next {n} months',
        tabHint: '◀ ▶',
        headOn: 'Back on top by {d}',
        headBehind: 'Still behind by {d}',
        headAhead: 'Ahead all {n} months',
        headAheadBy: 'Ahead by {n} on {d}',
        subCatch: 'Your {o} {m} paycheck catches you up. After that, about {n} a month you could save.',
        subAhead: 'About {n} a month you could save.',
        subBehind: 'Try a lower daily amount.',
        ordWord: '{n}{s}',
        ordSfx: 'st|nd|rd|th',
        start: 'Starting {d}: {n} behind',
        startAhead: 'Starting {d}: even',
        startAheadBy: 'Starting {d}: {n} ahead',
        paychecks: 'Paychecks',
        bills: 'Bills from checking',
        cards: 'Everyday spending and card charges',
        buys: 'Planned buys',
        left: 'Left over this month',
        save: 'Could move to savings',
        saveNote: 'after catching up {n}',
        pill: '{n} paychecks',
        lever: 'Everyday spending: {n} a day, your average for the last {m} months',
        leverOther: 'Everyday spending: {n} a day, you average {a}',
        leverHint: '▲ ▼ try another amount',
        moreSave: 'At {n} a day you could save {m} more a month',
        lessSave: 'At {n} a day you would save {m} less a month',
        legOk: 'ahead / can save',
        legNeg: 'behind',
        legPill: 'a month with an extra paycheck',
        legNote: 'A forecast, not a promise. Nothing here pays or moves money.'
      }
    },
    // Daily room, when its figure is worked from the autopay days
    usingAutopay: 'using autopay days',
    usingAutopayShort: 'autopay days',
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
      hidden: { head: 'Budget is hidden', line: 'widgets.budget.show is off in config.js, so no budget figures show on this TV.', short: 'Turned off in config.js.' },
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

  var S = { ctxs: {}, order: [], listeners: [], bound: false, data: null, fromCache: false, timer: null, sig: '', seen: null, banner: null, current: null };

  function config() {
    var w = window.HUB_CONFIG && window.HUB_CONFIG.widgets;
    var c = w && w.budget;
    return c && typeof c === 'object' ? c : {};
  }

  function allowed() { return config().show !== false; }

  // Figures may show: config.js allows them. (Guest mode blurs them, guest.js.)
  function shown() { return allowed(); }

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
    if (!allowed()) return 'hidden';
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

  // The figures of a snapshot, without when it was sent or received: a
  // resend of the same figures is not news.
  function figuresKey(d) {
    try { return JSON.stringify(d, function (k, v) { return k === 'receivedAt' || k === 'sentAt' ? undefined : v; }); } catch (e) { return ''; }
  }

  function onData(d) {
    if (!d || typeof d !== 'object' || isArr(d)) return;
    // { sentAt: null } is the Pi saying "nothing stored": forget the copy too.
    S.data = ready(d) ? d : null;
    S.fromCache = false;
    saveCache();
    refreshAll();
    updateBanner();
    // New figures (a new charge among them) after the first live data this
    // run: each budget tile says so (activity chip and accent edge).
    var key = S.data ? figuresKey(S.data) : '';
    var changed = S.liveKey !== undefined && key && key !== S.liveKey;
    S.liveKey = key;
    if (!changed) return;
    for (var i = 0; i < S.order.length; i++) {
      var ctx = S.ctxs[S.order[i]];
      if (ctx && typeof ctx.activity === 'function') { try { ctx.activity('budget'); } catch (e) { /* the figures just show */ } }
    }
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
    tell();
  }

  // The other budget widgets (budget-lab.js) draw again on the same news.
  function tell() {
    var fns = S.listeners.slice();
    for (var j = 0; j < fns.length; j++) {
      try { fns[j](); } catch (e) { warn('listener: ' + (e && e.message)); }
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
    if (!allowed()) return;
    readLatest(x);
    try { x.on('budget', function (d) { try { onData(d); } catch (e) { warn(e && e.message); } }); } catch (e) { warn('live: ' + (e && e.message)); }
    try { if (typeof x.onStatus === 'function') x.onStatus(function () { try { refreshAll(); } catch (e) { /* next time */ } }); } catch (e) { /* ignore */ }
    S.sig = signature();
    tell();
    schedule();
    updateBanner();
  }

  // The budget from the live line now, else this TV's copy.
  function readLatest(x) {
    loadCache();
    try {
      var d = x && x.get('budget');
      if (d && typeof d === 'object') { S.data = ready(d) ? d : null; S.fromCache = false; saveCache(); S.liveKey = S.data ? figuresKey(S.data) : ''; }
    } catch (e) { /* wait for it */ }
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
      days: num(s.daysLeft), through: dayFromText(s.throughDate), auto: s.basis === 'autopay' };
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
    var auto = r.auto ? el('div', 'bu-quiet bu-auto-line', root, STRINGS.usingAutopay) : null;
    fitHero(h, STRINGS.aDay);
    fitForms(cap, roomForms(r, false));
    if (thru) fitForms(thru, [fill(STRINGS.through, { d: dateText(r.through, 'long') }), fill(STRINGS.through, { d: dateText(r.through, 'short') })]);
    if (refund) {
      refund.textContent = fill(STRINGS.refund, { n: cash(r.refund) });
      if (overH(refund) || overW(refund)) fitForms(refund, [fill(STRINGS.refundShort, { n: cash(r.refund) }), fill(STRINGS.refundTiny, { n: cash(r.refund) })]);
    }
    if (auto) fitForms(auto, [STRINGS.usingAutopay, STRINGS.usingAutopayShort]);
    trim(root, [cap, refund, thru, auto]);
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
    if (r.auto) el('div', 'bu-pline is-quiet', sec, STRINGS.usingAutopay);
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
    var c = { day: day, away: num(s.daysAway), covered: s.covered, short: short === null ? null : Math.ceil(short), transfers: [], pay: [], plan: [] };
    // Short on card day but every card paid by its autopay day: amber, not an alarm.
    c.byAuto = !s.covered && s.byAutopay === true;
    var ashort = num(s.autopayShortBy);
    c.autoShort = !s.covered && s.byAutopay === false && ashort !== null ? Math.ceil(ashort) : null;
    var pl = isArr(s.plan) ? s.plan : [];
    for (var q = 0; q < pl.length; q++) {
      var pday = pl[q] ? dayFromText(pl[q].date) : null;
      if (pday !== null && str(pl[q].label) && num(pl[q].amount) !== null) {
        c.plan.push({ day: pday, label: str(pl[q].label), amount: pl[q].amount, auto: pl[q].kind === 'autopay' });
      }
    }
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
    c.rc = receiptData(s, c);
    c.ol = c.rc ? outlookData(s) : null;
    c.tone = c.covered ? 'is-ok' : c.byAuto ? 'is-under' : 'is-neg';
    var wordText = c.byAuto ? STRINGS.autoWord : STRINGS.shortBy;
    c.word = c.covered ? STRINGS.covered : fill(wordText, { n: cash(c.short || 0) });
    if (!c.covered && c.short === null) c.word = fill(wordText, { n: '' }).replace(/\s+$/, '');
    return c;
  }


  /* ---------- Card day receipt ---------- */

  var RC_KEYS = ['checking', 'paychecks', 'billsBefore', 'cardsToday', 'cardCharges', 'billsAfter', 'buys'];

  function itemData(it) {
    if (!it || typeof it !== 'object' || !str(it.label) || num(it.amount) === null) return null;
    var o = { label: str(it.label), amount: it.amount, day: dayFromText(it.date), isNew: it.new === true, note: str(it.note) };
    var f = ['bal', 'pending', 'coming', 'pay', 'auto'];
    for (var i = 0; i < f.length; i++) o[f[i]] = num(it[f[i]]);
    o.autoDay = dayFromText(it.autopay);
    return o;
  }

  // The receipt, or null when it is missing or its lines do not add up to the bottom line.
  function receiptData(s, c) {
    var r = s.receipt;
    if (!r || typeof r !== 'object' || !isArr(r.lines) || num(r.bottom) === null) return null;
    var out = { lines: [], bottom: r.bottom, next: null, asOf: parseIso(r.asOf), perDay: num(r.perDay) };
    var sum = 0;
    for (var i = 0; i < r.lines.length; i++) {
      var ln = r.lines[i];
      if (!ln || RC_KEYS.indexOf(ln.key) < 0 || num(ln.amount) === null) continue;
      var items = [];
      var its = isArr(ln.items) ? ln.items : [];
      for (var j = 0; j < its.length; j++) { var d = itemData(its[j]); if (d) items.push(d); }
      sum += ln.amount;
      out.lines.push({ key: ln.key, amount: ln.amount, items: items });
    }
    if (!out.lines.length || out.lines[0].key !== 'checking' || Math.abs(sum - out.bottom) > 0.01) return null;
    var nx = r.next && typeof r.next === 'object' ? r.next : null;
    var nd = nx ? dayFromText(nx.date) : null;
    if (nd !== null) out.next = { day: nd, amount: num(nx.amount) };
    return out;
  }

  /* ---------- Card day, next 3 months (sample data, a forecast) ---------- */

  var OL_STEP = 5;
  var OL_MAX = 500;

  // The outlook as sent, or null when it is not well formed.
  function outlookData(s) {
    var o = s.outlook;
    if (!o || typeof o !== 'object' || !isArr(o.months) || !o.months.length || !o.start || typeof o.start !== 'object') return null;
    var out = { startDay: dayFromText(o.start.date), behind: num(o.start.behind), ahead: num(o.start.ahead), avg: num(o.dailyAverage), avgMonths: num(o.averageMonths), months: [] };
    if (out.startDay === null || out.behind === null || out.avg === null || out.behind < 0 || out.avg < 0) return null;
    // Older sample data had no "ahead": that is the same as 0.
    if (out.ahead === null) out.ahead = 0;
    if (out.ahead < 0) return null;
    // A cushion and a gap cancel: only the net is shown.
    var net = out.ahead - out.behind;
    out.behind = net < 0 ? -net : 0;
    out.ahead = net > 0 ? net : 0;
    // The budget app sends 3 months; more than that is not drawn.
    for (var i = 0; i < o.months.length && i < 3; i++) {
      var m = o.months[i];
      var mm = m && /^(\d{4})-(\d{2})$/.exec(str(m.month));
      if (!mm || num(m.days) === null || m.days < 28 || m.days > 31 || m.days % 1 !== 0 || +mm[2] < 1 || +mm[2] > 12 || !isArr(m.paydays) || num(m.paycheck) === null || num(m.bills) === null ||
          num(m.cardRecurring) === null) return null;
      var pd = [];
      for (var j = 0; j < m.paydays.length; j++) { var d = dayFromText(m.paydays[j]); if (d !== null) pd.push(d); }
      out.months.push({ idx: +mm[2] - 1, days: m.days, paydays: pd, paycheck: m.paycheck, bills: m.bills, cardRecurring: m.cardRecurring,
        planned: num(m.planned) || 0, end: dayFromText(mm[1] + '-' + mm[2] + '-' + (m.days < 10 ? '0' : '') + m.days) });
    }
    if (out.avgMonths === null) out.avgMonths = out.months.length;
    return out;
  }

  /*
   * The math, pure (no DOM): each month's paychecks, bills, card spending (recurring + daily x days), planned
   * buys, what is left over, and what could move to savings once the starting gap is caught up. The catch-up
   * day is the first payday at which the position (minus the gap, plus every paycheck so far, less the
   * month's outflows, which come out at the start of the month) is back at zero. Never caught up: catchDay
   * is null and endDay is the last day of the window.
   */
  function outlookCalc(o, daily) {
    var pos = o.ahead - o.behind;
    var caught = null;
    var out = { months: [], catchDay: null, catchMonth: -1, catchNth: 0, endDay: o.months[o.months.length - 1].end, avgSave: 0, behind: o.behind, ahead: o.ahead };
    var i;
    for (i = 0; i < o.months.length; i++) {
      var m = o.months[i];
      var paychecks = m.paycheck * m.paydays.length;
      var card = m.cardRecurring + daily * m.days;
      var left = paychecks - m.bills - card - m.planned;
      var run = pos - m.bills - card - m.planned;
      for (var j = 0; j < m.paydays.length; j++) {
        run += m.paycheck;
        if (!caught && o.behind > 0 && run >= 0) { caught = { day: m.paydays[j], month: i, nth: j + 1 }; }
      }
      var end = pos + left;
      var save = end > 0 ? Math.min(left, end) : 0;
      out.months.push({ idx: m.idx, days: m.days, paydayCount: m.paydays.length, paychecks: paychecks, bills: m.bills, card: card, planned: m.planned,
        left: left, save: Math.max(0, save), note: pos < 0 && end > 0 ? -pos : 0 });
      pos = end;
    }
    if (caught) { out.catchDay = caught.day; out.catchMonth = caught.month; out.catchNth = caught.nth; }
    var from = o.behind > 0 ? (caught ? caught.month + 1 : out.months.length) : 0;
    if (from >= out.months.length && caught) from = out.months.length - 1;
    var sum = 0;
    var n = 0;
    for (i = from; i < out.months.length; i++) { sum += out.months[i].save; n++; }
    out.avgSave = n ? sum / n : 0;
    return out;
  }

  function olDaily(o) { return S.olDaily === null || S.olDaily === undefined ? o.avg : S.olDaily; }

  function olStep(c, dir) {
    var d = olDaily(c.ol) + (dir === 'up' ? OL_STEP : -OL_STEP);
    S.olDaily = Math.max(0, Math.min(OL_MAX, d));
  }

  function olOrd(n) {
    var O = STRINGS.receipt.outlook;
    var sf = O.ordSfx.split('|');
    var k = n % 100 >= 11 && n % 100 <= 13 ? 3 : n % 10 === 1 ? 0 : n % 10 === 2 ? 1 : n % 10 === 3 ? 2 : 3;
    return fill(O.ordWord, { n: n, s: sf[k] || '' });
  }

  function olTabs(root, page, n) {
    var O = STRINGS.receipt.outlook;
    var bar = el('div', 'bu-tabs', root);
    el('span', 'bu-tab' + (page === 'receipt' ? ' is-on' : ''), bar, O.tabReceipt);
    el('span', 'bu-tab' + (page === 'outlook' ? ' is-on' : ''), bar, fill(O.tabOutlook, { n: n }));
    el('span', 'bu-tabhint', bar, O.tabHint);
  }

  function olRow(sign, label, vals, cls, tones) {
    var row = el('div', 'bu-rrow bu-orow' + (cls ? ' ' + cls : ''));
    el('span', 'bu-rsign', row, sign);
    el('span', 'bu-rlabel', row, label);
    for (var i = 0; i < vals.length; i++) {
      var cell = el('span', 'bu-ramt bu-ocell' + (tones && tones[i] ? ' ' + tones[i] : ''), row);
      if (typeof vals[i] === 'string') cell.textContent = vals[i]; else vals[i](cell);
    }
    return row;
  }

  function olPage(root, c) {
    var O = STRINGS.receipt.outlook;
    var o = c.ol;
    var daily = olDaily(o);
    var r = outlookCalc(o, daily);
    var wrap = el('div', 'bu-pwrap bu-rc bu-ol' + (staleAt() ? ' is-stale' : ''), root);
    var nm = o.months.length;
    var i;
    // Headline and its line
    var tone;
    var head;
    var sub;
    if (o.behind <= 0) {
      tone = 'is-ok';
      head = o.ahead > 0 ? fill(O.headAheadBy, { n: cash(o.ahead), d: dateText(o.startDay, 'short') }) : fill(O.headAhead, { n: nm }); sub = fill(O.subAhead, { n: cash(r.avgSave) });
    } else if (r.catchDay !== null) {
      tone = 'is-ok'; head = fill(O.headOn, { d: dateText(r.catchDay, 'short') });
      sub = fill(O.subCatch, { o: olOrd(r.catchNth), m: STRINGS.months[r.months[r.catchMonth].idx], n: cash(r.avgSave) });
    } else {
      tone = 'is-under'; head = fill(O.headBehind, { d: dateText(r.endDay, 'short') }); sub = O.subBehind;
    }
    var top = el('div', 'bu-rhead', wrap);
    el('div', 'bu-rhero-word ' + tone, top, head);
    el('div', 'bu-rhero-cap bu-ol-sub', top, sub);
    if (o.behind > 0) el('div', 'bu-ol-start is-neg', wrap, fill(O.start, { d: dateText(o.startDay, 'short'), n: cash(o.behind) }));
    else if (o.ahead > 0) el('div', 'bu-ol-start is-ok', wrap, fill(O.startAheadBy, { d: dateText(o.startDay, 'short'), n: cash(o.ahead) }));
    else el('div', 'bu-ol-start is-ok', wrap, fill(O.startAhead, { d: dateText(o.startDay, 'short') }));
    // The table
    var tbl = el('div', 'bu-otable', wrap);
    var hd = el('div', 'bu-rrow bu-orow bu-ohead', tbl);
    el('span', 'bu-rsign', hd, '');
    el('span', 'bu-rlabel', hd, '');
    for (i = 0; i < r.months.length; i++) el('span', 'bu-ramt bu-ocell', hd, STRINGS.months[r.months[i].idx]);
    function col(fn) { var a = []; for (var k = 0; k < r.months.length; k++) a.push(fn(r.months[k])); return a; }
    var pay = col(function (m) {
      if (m.paydayCount < 3) return cash(m.paychecks);
      return function (cell) { el('span', 'bu-opill', cell, fill(O.pill, { n: m.paydayCount })); cell.appendChild(document.createTextNode(cash(m.paychecks))); };
    });
    tbl.appendChild(olRow('+', O.paychecks, pay));
    tbl.appendChild(olRow(STRINGS.minus, O.bills, col(function (m) { return cash(m.bills); })));
    tbl.appendChild(olRow(STRINGS.minus, O.cards, col(function (m) { return cash(m.card); })));
    tbl.appendChild(olRow(STRINGS.minus, O.buys, col(function (m) { return cash(m.planned); })));
    tbl.appendChild(olRow('=', O.left, col(function (m) { return (m.left > 0 ? '+' : '') + cash(m.left); }), 'is-total',
      col(function (m) { return m.left >= 0 ? 'is-ok' : 'is-neg'; })));
    tbl.appendChild(olRow('', O.save, col(function (m) {
      return function (cell) {
        el('span', 'bu-osave', cell, cash(m.save));
        if (m.note) el('span', 'bu-onote', cell, fill(O.saveNote, { n: cash(m.note) }));
      };
    }), 'is-save', col(function (m) { return m.save > 0 ? 'is-ok' : ''; })));
    // The lever
    var lev = el('div', 'bu-olever f', wrap);
    lev.setAttribute('data-key', 'ol-lever');
    lev.setAttribute('data-autofocus', '');
    var same = Math.round(daily) === Math.round(o.avg);
    var lt = same ? fill(O.lever, { n: cash(daily), m: nm }) : fill(O.leverOther, { n: cash(daily), a: cash(o.avg) });
    var lrow = el('div', 'bu-olever-top', lev);
    el('span', 'bu-olever-text', lrow, lt);
    el('span', 'bu-olever-hint', lrow, O.leverHint);
    if (!same) {
      var days = 0;
      for (i = 0; i < o.months.length; i++) days += o.months[i].days;
      var diff = Math.round((o.avg - daily) * days / o.months.length);
      el('div', 'bu-olever-more ' + (diff >= 0 ? 'is-ok' : 'is-neg'), lev,
        fill(diff >= 0 ? O.moreSave : O.lessSave, { n: cash(daily), m: cash(Math.abs(diff)) }));
    }
    // The legend
    var lg = el('div', 'bu-olegend', wrap);
    var li = el('div', 'bu-olegend-row', lg);
    el('span', 'bu-odot is-ok', li);
    el('span', 'bu-olegend-t', li, O.legOk);
    el('span', 'bu-odot is-neg', li);
    el('span', 'bu-olegend-t', li, O.legNeg);
    el('span', 'bu-opill', li, fill(O.pill, { n: 3 }));
    el('span', 'bu-olegend-t', li, '= ' + O.legPill);
    el('div', 'bu-olegend-row', lg, O.legNote);
  }

  function rcLabel(line, c, rc) {
    var R = STRINGS.receipt;
    var key = line.key === 'billsAfter' && !rc.next ? 'billsAfterNo' : line.key;
    return fill(R.lines[key], { d: dateText(c.day, 'short'), e: rc.next ? dateText(rc.next.day, 'short') : '' });
  }

  function rcBottomLabel() { return STRINGS.receipt.bottom; }

  function rcBottomNote(rc) {
    var R = STRINGS.receipt;
    return rc.next ? fill(R.bottomNote, { e: dateText(rc.next.day, 'short') }) : R.bottomNoteNo;
  }

  // Tile words: the hero and the small word beside it.
  function rcHero(c) {
    var R = STRINGS.receipt;
    if (c.covered) {
      return { word: fill(R.heroLeft, { n: cash(c.rc.bottom) }), cap: c.rc.perDay !== null ? fill(R.heroDay, { n: cash(c.rc.perDay) }) : '' };
    }
    if (c.byAuto) return { word: fill(R.heroShort, { n: cash(c.short || 0), d: dateText(c.day, 'short') }), cap: R.heroByAutopay };
    return { word: fill(R.heroShortPlain, { n: cash(c.autoShort !== null ? c.autoShort : (c.short || 0)) }), cap: R.heroEven };
  }

  function rcNextText(c, form) {
    var R = STRINGS.receipt;
    if (!c.rc.next) return '';
    var amt = c.rc.next.amount === null ? '' : cash(c.rc.next.amount);
    var m = fill(R.nextPay, { d: dateText(c.rc.next.day, form || 'long'), n: amt });
    return amt ? m : fill(STRINGS.nextPay, { d: dateText(c.rc.next.day, form || 'long') });
  }

  // One line of the receipt: sign, words, amount. Signs have their own column, amounts right-aligned.
  function rcRow(sign, label, amount, tone, cls) {
    var row = el('div', 'bu-rrow' + (cls ? ' ' + cls : ''));
    el('span', 'bu-rsign', row, sign);
    el('span', 'bu-rlabel', row, label);
    el('span', 'bu-ramt' + (tone ? ' ' + tone : ''), row, amount);
    return row;
  }

  function rcSign(line, i) {
    if (i === 0) return '';
    return line.key === 'paychecks' ? '+' : STRINGS.minus;
  }

  // The mini receipt on the tile: three lines.
  function rcMini(parent, c) {
    var R = STRINGS.receipt;
    var rc = c.rc;
    var e = rc.next ? dateText(rc.next.day, 'short') : '';
    var box = el('div', 'bu-mini', parent);
    box.appendChild(rcRow('', R.lines.checking, cash(rc.lines[0].amount), '', 'is-mini'));
    box.appendChild(rcRow('', rc.next ? fill(R.miniBills, { e: e }) : R.miniBillsNo, cash(rc.bottom - rc.lines[0].amount), '', 'is-mini'));
    box.appendChild(rcRow('', R.bottom, cash(rc.bottom), c.tone, 'is-mini is-total'));
    return box;
  }

  /* level 2: what one line is made of */

  function rcDetailItems(line, c, rc, panel) {
    var R = STRINGS.receipt;
    var i;
    function itemRow(it, n) {
      var row = el('div', 'bu-ritem f');
      row.setAttribute('data-key', 'rd-' + n);
      var top = el('div', 'bu-ritop', row);
      el('span', 'bu-rdate', top, it.day !== null ? dateText(it.day, 'short') : '');
      var lab = el('span', 'bu-rlabel', top, it.label);
      if (it.isNew) el('span', 'bu-rtag', lab, R.newTag);
      el('span', 'bu-ramt', top, cash(Math.abs(it.amount)));
      return row;
    }
    if (line.key === 'checking') {
      var txt = R.checkingNote;
      if (!isNaN(rc.asOf)) txt += ' ' + fill(R.checkingAsOf, { t: hm(rc.asOf) });
      var cn = el('div', 'bu-rnote f', panel, txt);
      cn.setAttribute('data-key', 'rd-0');
      return;
    }
    if (line.key === 'paychecks' && !line.items.length) {
      var np = rc.next ? fill(R.noPay, { d: dateText(c.day, 'short'), n: dateText(rc.next.day, 'long') }) : fill(R.noPayNext, { d: dateText(c.day, 'short') });
      var nn = el('div', 'bu-rnote f', panel, np);
      nn.setAttribute('data-key', 'rd-0');
      return;
    }
    if (!line.items.length) {
      var ne = el('div', 'bu-rnote f', panel, R.empty);
      ne.setAttribute('data-key', 'rd-0');
      return;
    }
    for (i = 0; i < line.items.length; i++) {
      var it = line.items[i];
      var row = itemRow(it, i);
      if (line.key === 'cardsToday') {
        var parts = [fill(R.owesBal, { n: cash(it.bal !== null ? it.bal : it.amount) })];
        if (it.pending) parts.push(fill(R.owesPending, { n: cash(it.pending) }));
        if (it.coming) parts.push(fill(R.owesComing, { n: cash(it.coming), d: dateText(c.day, 'short') }));
        el('div', 'bu-rsub', row, parts.join(STRINGS.sep));
        var two = [it.autoDay !== null ? fill(R.cardAutopay, { d: dateText(it.autoDay, 'short') }) : R.cardNoAutopay];
        if (it.pay) two.push(fill(R.cardPays, { n: cash(it.pay), d: dateText(c.day, 'short') }));
        if (it.auto) two.push(fill(R.cardAuto, { n: cash(it.auto) }));
        el('div', 'bu-rsub', row, two.join(STRINGS.sep));
      } else if (line.key === 'paychecks') {
        el('div', 'bu-rsub', row, R.payNote);
      } else if (line.key === 'cardCharges' && it.note) {
        el('div', 'bu-rsub', row, fill(R.onCard, { card: it.note }));
      } else if (it.note) {
        el('div', 'bu-rsub', row, it.note);
      }
      panel.appendChild(row);
    }
    var tot = el('div', 'bu-ritem bu-rtotal f', panel);
    tot.setAttribute('data-key', 'rd-total');
    var tt = el('div', 'bu-ritop', tot);
    el('span', 'bu-rdate', tt, '');
    el('span', 'bu-rlabel', tt, R.total);
    el('span', 'bu-ramt', tt, cash(Math.abs(line.amount)));
    if (line.key === 'buys') el('div', 'bu-rsub', tot, R.buysNote);
  }

  function rcDetailBottom(c, rc, panel) {
    var R = STRINGS.receipt;
    var f = el('div', 'bu-rnote f', panel);
    f.setAttribute('data-key', 'rd-0');
    el('div', 'bu-rsub', f, R.formula);
    var terms = '';
    for (var i = 0; i < rc.lines.length; i++) {
      var a = rc.lines[i].amount;
      if (i > 0 && a === 0) continue;
      terms += (i === 0 ? '' : ' ' + (rc.lines[i].key === 'paychecks' ? '+' : STRINGS.minus) + ' ') + cash(Math.abs(a));
    }
    el('div', 'bu-rformula', f, terms + ' = ' + cash(rc.bottom));
    el('div', 'bu-rsub', f, rcBottomNote(rc));
  }

  function setBackHint() {
    var h = document.querySelector('#panel .panel-hint');
    if (h) h.textContent = STRINGS.receipt.backHint;
  }

  function rcPanel(root, ctx, full, c) {
    var R = STRINGS.receipt;
    var rc = c.rc;
    var tabbed = !!(c.ol && !S.rcOpen);
    if (tabbed && S.rcPage === 'outlook') {
      olTabs(root, 'outlook', c.ol.months.length);
      return olPage(root, c);
    }
    var wrap = el('div', 'bu-pwrap bu-rc' + (full ? ' is-full is-cols' : '') + (S.rcOpen ? ' is-detail' : '') + (staleAt() ? ' is-stale' : ''), root);
    var detail = S.rcOpen;
    var line = null;
    var idx = -1;
    var i;
    if (detail) {
      if (detail === 'bottom') { line = { key: 'bottom', amount: rc.bottom, items: [] }; idx = rc.lines.length; } else {
        for (i = 0; i < rc.lines.length; i++) if (rc.lines[i].key === detail) { line = rc.lines[i]; idx = i; }
      }
      if (!line) { S.rcOpen = null; detail = null; }
    }
    var colA = el('div', 'bu-pcol', wrap);
    // The tab strip sits over the receipt's own column only, so the plan column keeps its height
    // (and its "OK for details" hint stays on screen).
    if (tabbed) olTabs(colA, 'receipt', c.ol.months.length);
    var colB = full && !detail ? el('div', 'bu-pcol', wrap) : null;
    var hh = rcHero(c);
    if (detail) {
      var head = line.key === 'bottom' ? rcRow('=', rcBottomLabel(rc), cash(rc.bottom), c.tone, 'is-total is-open f') :
        rcRow(rcSign(line, idx), rcLabel(line, c, rc), cash(Math.abs(line.amount)), '', 'is-open f');
      head.setAttribute('data-key', 'rc-' + line.key);
      colA.appendChild(head);
      var box = el('div', 'bu-rdetail' + (S.rcFresh ? ' is-enter' : ''), colA);
      if (line.key === 'bottom') rcDetailBottom(c, rc, box); else rcDetailItems(line, c, rc, box);
      S.rcFresh = false;
      // The hub writes its own Back hint after this draw.
      setTimeout(setBackHint, 0);
      return;
    }
    // At full screen the headline sits over the plan, so the whole receipt fits on the left.
    var top = el('div', 'bu-rhead', colB || colA);
    el('div', 'bu-pline', top, fill(STRINGS.cardOn, { d: dateText(c.day, 'long') }) + STRINGS.sep + awayText(c));
    var hb = el('div', 'bu-rhero', top);
    el('span', 'bu-rhero-word ' + c.tone, hb, hh.word);
    if (hh.cap) el('span', 'bu-rhero-cap', hb, hh.cap);
    for (i = 0; i < rc.lines.length; i++) {
      var ln = rc.lines[i];
      var row = rcRow(rcSign(ln, i), rcLabel(ln, c, rc), cash(Math.abs(ln.amount)), '', 'f');
      row.setAttribute('data-key', 'rc-' + ln.key);
      if (S.rcBack ? S.rcBack === ln.key : i === 0) row.setAttribute('data-autofocus', '');
      colA.appendChild(row);
    }
    var tot = rcRow('=', rcBottomLabel(rc), cash(rc.bottom), c.tone, 'is-total f');
    tot.setAttribute('data-key', 'rc-bottom');
    if (S.rcBack === 'bottom') tot.setAttribute('data-autofocus', '');
    colA.appendChild(tot);
    el('div', 'bu-pline is-quiet bu-rnote-low', colA, rcBottomNote(rc));
    var side = colB || colA;
    if (c.plan.length) {
      var pls = el('div', 'bu-psec f' + (colB ? '' : ' is-after'), side);
      pls.setAttribute('data-key', 'plan');
      el('div', 'bu-label', pls, R.planHead);
      var firsts = [];
      var laters = [];
      for (var n = 0; n < c.plan.length; n++) (c.plan[n].auto ? laters : firsts).push(c.plan[n]);
      if (firsts.length) {
        el('div', 'bu-rsubhead', pls, fill(R.payOn, { d: dateText(c.day, 'short') }));
        for (i = 0; i < firsts.length; i++) pls.appendChild(planRow(firsts[i], 'pay'));
      }
      laters.sort(function (a, b) { return a.day - b.day; });
      if (laters.length) {
        el('div', 'bu-rsubhead', pls, R.leaveFor);
        for (i = 0; i < laters.length; i++) pls.appendChild(planRow(laters[i], 'auto'));
      }
      el('div', 'bu-pline is-quiet', pls, R.planNote);
    }
    var nxt = rcNextText(c, 'long');
    if (nxt) {
      var ps = el('div', 'bu-psec f', side);
      ps.setAttribute('data-key', 'pay');
      el('div', 'bu-pline', ps, nxt);
    }
    el('div', 'bu-pline is-quiet bu-rhint', side, R.okHint);
    S.rcBack = null;
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

  // The plain words under the figure: covered by autopay, or still short with it.
  function noteForms(c) {
    if (c.byAuto) {
      return [fill(STRINGS.autoNote, { d: dateText(c.day, 'short') }), STRINGS.autoNoteShort, STRINGS.autoNoteTiny];
    }
    if (c.autoShort !== null) return [fill(STRINGS.autoShortNote, { n: cash(c.autoShort) }), fill(STRINGS.autoShortNoteShort, { n: cash(c.autoShort) })];
    return [];
  }

  // One payment of the plan: its day, the card and the amount ("autopay" after it when left for the card's day).
  function planRow(p, mode) {
    var row = el('div', 'bu-trow bu-prow' + (mode === 'pay' ? ' is-nodate' : ''));
    // The receipt's plan: "Pay on Dec 1" rows have no date of their own.
    if (mode !== 'pay') el('span', 'bu-prow-date', row, dateText(p.day, 'short'));
    el('span', 'bu-trow-label bu-cut', row, p.label);
    var v = el('span', 'bu-trow-value', row, cash(p.amount));
    if (p.auto && !mode) el('span', 'bu-prow-auto', v, STRINGS.autoPay);
    return row;
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
        c.byAuto ? [STRINGS.autoSolo] : [fill(STRINGS.shortWord, { n: cash(c.short || 0) }), cash(-(c.short || 0))], c.tone);
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
      var nf = noteForms(c);
      if (nf.length) forms.push(STRINGS.sep + w[0] + STRINGS.sep + nf[nf.length - 1]);
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
    if (c.rc) {
      var rh = rcHero(c);
      var rwhen = el('div', 'bu-when', root);
      var hr = hero(root, rh.word, rh.cap, c.tone, 'is-word');
      var rcap = hr.capEl;
      fitForms(rwhen, whenForms(c));
      fitHero(hr, '');
      if (rcap && rcap.parentNode) rcap.className += ' bu-rcap ' + c.tone;
      var mini = rcMini(root, c);
      // Short on height: the heading's caption goes first, then the middle line.
      if (overH(root) && rcap && rcap.parentNode) rcap.parentNode.removeChild(rcap);
      if (overH(root)) mini.removeChild(mini.childNodes[1]);
      if (size.cols < 3) mini.className += ' is-tight';
      return;
    }
    // The payment plan takes the list's place when there is one; the transfers stay in the panel.
    var usePlan = c.plan.length > 0;
    var wide = size.width === 'wide' && (usePlan || c.transfers.length > 0);
    var left = wide ? el('div', 'bu-split-a', el('div', 'bu-split', root)) : root;
    var right = wide ? el('div', 'bu-split-b', left.parentNode) : null;
    var when = el('div', 'bu-when', left);
    var h = hero(left, c.word, '', c.tone, 'is-word');
    var nfs = noteForms(c);
    var note = nfs.length ? el('div', 'bu-line bu-auto-note ' + (c.byAuto ? 'is-under' : 'is-neg'), left) : null;
    var list = null;
    var more = null;
    if ((usePlan || c.transfers.length) && size.cols >= 3) {
      var sect = el('div', 'bu-sect', wide ? right : left);
      el('div', 'bu-label', sect, usePlan ? STRINGS.planHead : STRINGS.transfersHead);
      list = el('div', 'bu-list', sect);
      more = el('div', 'bu-more', sect);
    }
    var pay = c.pay.length ? el('div', 'bu-foot', root) : null;
    fitForms(when, whenForms(c));
    fitHero(h);
    if (note) fitForms(note, nfs);
    if (pay) fitForms(pay, payForms(c));
    if (list) {
      var rows = [];
      if (usePlan) for (var m = 0; m < c.plan.length; m++) rows.push(planRow(c.plan[m]));
      else for (var k = 0; k < c.transfers.length; k++) rows.push(transferRow(c.transfers[k]));
      if (!fitRows(list, more, rows)) list.parentNode.parentNode.removeChild(list.parentNode);
    }
    trim(root, [note, pay]);
    if (!list && size.cols >= 3) mark(root);
  }

  function cardPanel(root, ctx, full) {
    var c = shown() ? cardData() : null;
    if (!c) return panelMessage(root, emptyState());
    if (c.rc) return rcPanel(root, ctx, full, c);
    var wrap = el('div', 'bu-pwrap' + (full ? ' is-full is-cols' : '') + (staleAt() ? ' is-stale' : ''), root);
    var colA = el('div', 'bu-pcol', wrap);
    var colB = full ? el('div', 'bu-pcol', wrap) : colA;
    var top = el('div', 'bu-psec f', colA);
    top.setAttribute('data-key', 'card');
    top.setAttribute('data-autofocus', '');
    el('div', 'bu-pline', top, fill(STRINGS.cardOn, { d: dateText(c.day, 'long') }) + STRINGS.sep + awayText(c));
    var h = hero(top, c.word, '', c.tone, 'is-panel is-word');
    fitWidth(h.numEl);
    var pnf = noteForms(c);
    if (pnf.length) el('div', 'bu-pline ' + (c.byAuto ? 'is-under' : 'is-neg'), top, pnf[0]);
    if (c.plan.length) {
      var pls = el('div', 'bu-psec f', colB);
      pls.setAttribute('data-key', 'plan');
      el('div', 'bu-label', pls, STRINGS.planHead);
      for (var n = 0; n < c.plan.length; n++) pls.appendChild(planRow(c.plan[n]));
    }
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

  function real(id, titleKey, drawTile, drawPanel, extra) {
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
    if (extra) for (var xk in extra) if (extra.hasOwnProperty(xk)) w[xk] = extra[xk];
    // Read when the hub draws the tile head, so it follows the language.
    Object.defineProperty(w, 'title', { get: function () { return STRINGS.titles[titleKey]; }, enumerable: true, configurable: true });
    Object.defineProperty(w, 'shortTitle', { get: function () { return (STRINGS.titlesShort || {})[titleKey] || ''; }, enumerable: true, configurable: true });
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
      // The hub fits the title, or its short form, to the tile.
      if (ctx && typeof ctx.retitle === 'function') ctx.retitle();
      else {
        var heads = document.querySelectorAll('.cell[data-widget="' + id + '"] .tile-title');
        for (var j = 0; j < heads.length; j++) heads[j].textContent = STRINGS.titles[key] || '';
      }
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

  /*
   * For the other budget widgets (app/widgets/budget-lab.js), so the cache
   * and widgets.budget.show stay in this one file:
   *   data()        the snapshot, or null while none may show (hidden,
   *                 nothing sent yet)
   *   onChange(fn)  fn() after anything that changes what a budget tile
   *                 shows (new figures, the language, the line, a new
   *                 minute that makes the data old or a new day)
   *   shown()       figures may show: config.js allows them
   *   state()       why there is nothing to show: a key of the states below
   *   stateText(k)  { head, line, short } for that key, in the hub's language
   *   asOf()        "as of 7:10 AM" once the data is over 2 hours old, else ''
   *   stale()       true once the data is over 2 hours old
   *   today()       today in the Pi's time zone, 'YYYY-MM-DD'
   */
  window.HUB_BUDGET = {
    data: function () { return shown() && ready(S.data) ? S.data : null; },
    onChange: function (fn) {
      if (typeof fn === 'function') S.listeners.push(fn);
      // A layout with no other budget tile: the line is bound from here.
      bindLive();
    },
    shown: shown,
    state: emptyState,
    stateText: function (key) { return STRINGS.states[key] || STRINGS.states.waiting; },
    asOf: function () { return shown() ? asOfText() : ''; },
    stale: function () { return !!staleAt(); },
    today: function () {
      var d = new Date(today() * DAY);
      var m = d.getUTCMonth() + 1;
      var n = d.getUTCDate();
      return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (n < 10 ? '0' : '') + n;
    }
  };

  // For dev/money-test.js. Not used by the hub.
  window.HUB_BUDGET_TEST = {
    STRINGS: EN,
    strings: function () { return STRINGS; },
    store: S,
    outlookCalc: outlookCalc,
    outlookData: outlookData,
    refresh: function () { refreshAll(); updateBanner(); },
    seen: function () { return seenList().slice(); }
  };

  setTimeout(bindLive, 0);

  var list = (window.HUB_WIDGETS = window.HUB_WIDGETS || []);
  list.push(real('budget-room', 'room', roomTile, roomPanel));
  list.push(real('budget-card', 'card', cardTile, cardPanel, {
    // Level 2 of the receipt: OK on a line opens its items, Back returns to the receipt.
    onSelect: function (target, ctx) {
      var k = (target && target.getAttribute('data-key')) || '';
      if (k.indexOf('rc-') !== 0 || S.rcOpen) return;
      S.rcOpen = k.substring(3);
      S.rcBack = S.rcOpen;
      S.rcFresh = true;
      ctx.redrawPanel();
    },
    // The receipt's pages: Right opens "Next 3 months", Left returns; Up/Down on it change the daily amount.
    onMove: function (dir, from, ctx) {
      var c = shown() ? cardData() : null;
      if (!c || !c.rc || !c.ol || S.rcOpen) return undefined;
      if (S.rcPage === 'outlook') {
        if (dir === 'left') { S.rcPage = 'receipt'; S.rcBack = null; ctx.redrawPanel(); } else if (dir === 'up' || dir === 'down') { olStep(c, dir); ctx.redrawPanel(); }
        return true;
      }
      if (dir === 'right') { S.rcPage = 'outlook'; ctx.redrawPanel(); return true; }
      return undefined;
    },
    onBack: function (ctx) {
      if (!S.rcOpen) return false;
      S.rcOpen = null;
      ctx.redrawPanel();
      return true;
    },
    onClose: function () { S.rcOpen = null; S.rcBack = null; S.rcPage = 'receipt'; S.olDaily = null; }
  }));
  // The receipt is a page, not a glance: OK on the tile opens it at full screen (Back closes).
  Object.defineProperty(list[list.length - 1], 'openMode', {
    get: function () { var c = shown() ? cardData() : null; return c && c.rc ? 'full' : undefined; },
    enumerable: true, configurable: true
  });
  list.push(real('budget-goals', 'goals', goalsTile, goalsPanel));
})();
