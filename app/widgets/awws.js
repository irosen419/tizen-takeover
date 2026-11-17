/*
 * A World Worth Saving: a family of tiles for the picture book project.
 *
 *   awws           A World Worth Saving: the Glance (next visit, the board in
 *                  one look; at 6 x 4 or more the one-screen dashboard). Its
 *                  panel is a launcher that opens the other views inside it.
 *   awws-visits    Next visit: school visits from the calendar.
 *   awws-agenda    This week: calendar dates and dated to-dos, day by day.
 *   awws-todo      To-do board: the snapshot's to-dos (read only).
 *   awws-reach     Reach: site visits and buy clicks this week with their
 *                  trend, flier scans at schools, and newsletter subscribers
 *                  (counted by hand for now, so it works with those alone).
 *   awws-outreach, awws-pipeline, awws-money: placeholders.
 *
 * Two sources, both from the hub server on the Raspberry Pi:
 *   - the live resource "calendar" (docs/live-updates.md), filtered by
 *     calendar NAME with HUB_CONFIG.widgets.awws.calendars;
 *   - the live resource "awws", the snapshot (docs/awws-snapshot.md).
 * Each source is in one state: data, loading, notsetup, missing, error, or
 * one of the Pi line's states (off, quiet, lost, refused). A tile that uses
 * both draws the part it has and says quietly what the other part lacks.
 * Nothing here ever leaves a tile blank: every draw is wrapped, and a failed
 * one shows "couldn't be shown".
 *
 * The TV keeps its last snapshot (homeHub.awws.v1). The calendar's own copy
 * (homeHub.calendar.v1, kept by calendar.js) is only read, never written.
 *
 * Every word is in STRINGS. window.HUB_AWWS_STRINGS, when set before this
 * file loads, replaces any of them key by key (the screenshots use it to try
 * Spanish; the TV stays English).
 */
(function () {
  'use strict';

  /* Every word the tiles show. {n} is a number, {t} a time, {name} a name. */
  var STRINGS = {
    titles: {
      awws: 'A World Worth Saving', visits: 'Next visit', agenda: 'This week', todo: 'To-do board',
      outreach: 'Librarians', pipeline: 'Books', money: 'Money', reach: 'Reach'
    },
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
      'September', 'October', 'November', 'December'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    // {dow} short weekday, {dowLong} weekday, {mon} short month, {month} month, {d} day
    dateLong: '{dow}, {mon} {d}',
    dateShort: '{mon} {d}',
    dateFull: '{dowLong}, {month} {d}',
    am: 'AM',
    pm: 'PM',
    thousands: ',',
    sep: ' · ',
    today: 'Today',
    tomorrow: 'Tomorrow',
    now: 'Now',
    allDay: 'All day',
    untilT: 'until {t}',
    days1: '1 day',
    daysN: '{n} days',
    daysShortN: '{n} d',
    unitDays: 'days',
    inDays: 'in {n} days',
    todayAt: 'today at {t}',
    tomorrowAt: 'tomorrow at {t}',
    onNow: 'on now',
    noTitle: '(No title)',
    more: '+{n} more',
    asOf: 'as of {t}',
    // The Glance
    nowForYou: 'now for you',
    nowForYouHead: 'Now for you',
    nowCount: '{n} now for you',
    nowCountShort: '{n} now',
    nowWord: 'now',
    todayCap: 'today',
    comingUp: 'Coming up',
    figuresHead: 'Progress',
    then: 'Then',
    noVisits: 'No visits booked',
    noVisitsWhen: 'in the next 60 days',
    nothingNow: 'Nothing in Now for you',
    replies1: '1 reply waiting',
    repliesN: '{n} replies waiting',
    booked: '{n} booked',
    figures: { outreach: 'Librarians', pipeline: 'Books', khaya: 'Rewrite', handoffs: 'Handoffs', money: 'Money', reach: 'Reach' },
    spreads: '{done} of {total} spreads',
    handoffsLine: '{open} open · {blocked} blocked',
    bookBlocked: '{title} {format}',
    waitingOn: 'waiting on {name}',
    bookStage: '{title}: {stage}',
    allLive: 'All {n} live',
    moneyLine: 'Spent {spent} · earned {earned}',
    moneyLineShort: '{spent} out · {earned} in',
    reachLine: '{n} visits this week',
    reachLine1: '1 visit this week',
    reachSubs: '{n} subscribers',
    reachSubs1: '1 subscriber',
    reachClicks: '{n} buy clicks',
    reachClicks1: '1 buy click',
    reachScans: '{n} flier scans',
    reachScans1: '1 flier scan',
    notSynced: 'Not synced yet',
    soon: 'Soon',
    views: { visits: 'Next visit', agenda: 'This week', todo: 'To-do board', reach: 'Reach' },
    // This week
    nothingToday: 'Nothing today',
    nothingWeek: 'Nothing this week',
    nothingTwoWeeks: 'Nothing in the next two weeks',
    weekCount: '{n} dates',
    weekCount1: '1 date',
    dueCount: '{n} to-dos due',
    dueCount1: '1 to-do due',
    due: 'Due',
    // To-do board
    owners: { ian: 'Ian', claude: 'Claude', both: 'Both' },
    ownersShort: { ian: 'I', claude: 'C', both: 'B' },
    filters: { all: 'All', ian: 'Ian', claude: 'Claude', both: 'Both' },
    filterHint: '← → owner',
    ownerCount: '{name} {n}',
    sections: { now: 'Now', next: 'Next', later: 'Later' },
    overdue: 'Overdue',
    overdueCount: '{n} overdue',
    overdueCount1: '1 overdue',
    doneWeek: '{n} done this week',
    doneWeek1: '1 done this week',
    byStream: 'Open by workstream',
    noStream: 'Other',
    emptyBoard: 'Nothing on the board',
    emptySection: 'Nothing here',
    emptyFilter: 'Nothing for {name}',
    // Reach
    visitsWord: 'visits',
    visitsWord1: 'visit',
    visitsWeek: 'visits this week',
    visitsWeek1: 'visit this week',
    clicksWord: 'buy clicks',
    clicksWord1: 'buy click',
    clicksWordShort: 'clicks',
    clicksWeek: 'buy clicks this week',
    clicksWeek1: 'buy click this week',
    subsWord: 'subscribers',
    subsWord1: 'subscriber',
    subsWordShort: 'subs',
    scansWord: 'flier scans',
    scansWord1: 'flier scan',
    changeUp: 'up {n}',
    changeDown: 'down {n}',
    changeSame: 'same as last week',
    changeSameShort: 'same',
    vsLast: 'vs {n} last week',
    vsLastShort: 'vs {n}',
    weekVsLast: '{n} last week',
    lastCheck: 'at last check {d}',
    lastCheckShort: 'checked {d}',
    lastDays: 'Last {n} days',
    scansHead: 'Flier scans',
    reachHeads: { visits: 'Site visits', clicks: 'Buy clicks', scans: 'Flier scans at schools', subs: 'Newsletter subscribers' },
    trafficLater: 'Site visits and buy clicks show here once the sync sends them.',
    states: {
      off: { head: 'Needs the Pi',
        line: 'Visits and the board come from the hub server on the Raspberry Pi. Live updates are off on this TV: set live.server in config.js to the Pi’s address.',
        short: 'Live updates are off. Set live.server in config.js.' },
      quiet: { head: 'Needs the Pi',
        line: 'This TV hasn’t reached the hub server on the Pi yet. It keeps trying quietly. Setting the server up is in pi/README.md.',
        short: 'Waiting for the hub server on the Pi.' },
      lost: { head: 'Can’t reach the Pi',
        line: '{live}. These tiles fill in as soon as the Pi answers again.',
        short: 'Trying again quietly.' },
      refused: { head: 'Needs the Pi', line: '{live}.', short: '{live}.' },
      loading: { head: 'Loading…', line: '', short: '' },
      nocalendar: { head: 'No calendar from the Pi',
        line: 'The hub server on the Pi doesn’t send a calendar yet. Update it (pi/README.md).',
        short: 'Update the hub server on the Pi.' },
      missing: { head: 'No “{name}” calendar on the Pi',
        line: 'Add it to the Pi’s .env file as CALENDAR_n_NAME={name} with its CALENDAR_n_URL, then restart the hub server. pi/README.md has the steps.',
        short: 'Add it to the Pi’s .env file.' },
      error: { head: '{name} couldn’t be read',
        line: 'The Pi couldn’t read the {name} calendar{why}. It tries again every few minutes.',
        short: 'The Pi tries again every few minutes.' },
      notsetup: { head: 'Not synced yet',
        line: 'The board data arrives once the sync is set up. docs/awws-snapshot.md says how.',
        short: '' }
    },
    whyText: ' ({why})',
    calBad: '{name} couldn’t be read',
    broken: '{title} couldn’t be shown',
    planned: {
      outreach: 'Replies waiting on you, and how many schools replied, booked and were visited.',
      pipeline: 'Each book and download from writing to live, and what each one waits on.',
      money: 'What the project spent and earned, month by month.'
    },
    plannedNote: 'Not built yet. This spot is reserved for it.'
  };

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  // window.HUB_AWWS_STRINGS replaces words key by key (lists as a whole).
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
  try { mergeStrings(STRINGS, window.HUB_AWWS_STRINGS); } catch (e) { /* keep English */ }

  /* One color per calendar number, the same as calendar.js. */
  var PALETTE = [
    [124, 196, 255], [255, 179, 107], [142, 229, 154], [245, 146, 196], [199, 166, 255],
    [255, 209, 102], [95, 214, 207], [255, 138, 128], [184, 196, 214]
  ];

  var CAL_KEY = 'homeHub.calendar.v1';   // calendar.js's copy: read only
  var SNAP_KEY = 'homeHub.awws.v1';
  var MIN = 60000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  var CAL_STALE = 30 * MIN;
  var SNAP_STALE = 2 * HOUR;
  var VISIT_DAYS = 60;
  var FALLBACK_TZ = 'America/Chicago';
  var OWNERS = ['ian', 'claude', 'both'];
  var SECTIONS = ['now', 'next', 'later'];
  var FILTERS = ['all', 'ian', 'claude', 'both'];

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

  function clean(v) { return str(v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }

  function count(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : null; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('A World Worth Saving: ' + text); } catch (e) { /* ignore */ }
  }

  function remPx() {
    try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch (e) { return 16; }
  }

  function fmtNum(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, STRINGS.thousands);
  }

  function plural(n, one, many, extra) {
    var map = { n: fmtNum(n) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) map[k] = extra[k];
    return fill(n === 1 ? one : many, map);
  }

  function now() { return new Date().getTime(); }

  function family() {
    var w = window.HUB_CONFIG && window.HUB_CONFIG.widgets;
    var c = w && w.awws;
    return c && typeof c === 'object' ? c : {};
  }

  // The calendar names for 'visits' or 'awws', from config.js.
  function wantedNames(kind) {
    var c = family().calendars;
    var list = c && isArr(c[kind]) ? c[kind] : (kind === 'visits' ? ['School Visits'] : ['A World Worth Saving']);
    var out = [];
    for (var i = 0; i < list.length; i++) if (clean(list[i])) out.push(clean(list[i]));
    return out;
  }

  function showMoney() { return family().showMoney === true; }

  /* ---------- measuring ---------- */

  function overH(node) { return node.scrollHeight > node.clientHeight + 1; }
  function overW(node) { return node.scrollWidth > node.clientWidth + 1; }

  // Puts the first text that fits on one line; if none does, the line goes.
  function fitForms(node, forms) {
    for (var i = 0; i < forms.length; i++) {
      if (!forms[i]) continue;
      node.textContent = forms[i];
      if (!overW(node)) return true;
    }
    node.style.display = 'none';
    return false;
  }

  // Shrinks a one-line number or word until it fits its box.
  function fitWidth(node) {
    node.style.fontSize = '';
    if (!node.clientWidth || !overW(node)) return;
    var size = parseFloat(window.getComputedStyle(node).fontSize) || 40;
    for (var i = 0; i < 16 && overW(node); i++) {
      size = size * 0.9;
      node.style.fontSize = size.toFixed(1) + 'px';
    }
  }

  // Rows while they fit, then "+N more". Measured, so a bigger font or a
  // longer language just shows fewer rows. Returns how many are shown.
  function fitRows(list, more, rows, max, keepOne) {
    var shown = Math.min(rows.length, max || rows.length);
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
    var least = keepOne ? 1 : 0;
    while (shown > least && overH(list)) {
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

  /* ---------- time zones and days (copied small from calendar.js) ---------- */

  // calendar.js has the long comments; these are the same functions, kept
  // small and separate so neither widget depends on the other's file.
  function readParts(fmt, ms) {
    var p = null;
    if (typeof fmt.formatToParts === 'function') {
      var list = fmt.formatToParts(new Date(ms));
      p = {};
      for (var i = 0; i < list.length; i++) p[list[i].type] = parseInt(list[i].value, 10);
      p = [p.year, p.month, p.day, p.hour, p.minute, p.second];
    } else {
      var m = /(\d+)\D+(\d+)\D+(\d+)\D+(\d+)\D+(\d+)\D+(\d+)/.exec(fmt.format(new Date(ms)));
      if (m) p = [+m[3], +m[1], +m[2], +m[4], +m[5], +m[6]];
    }
    if (!p) return null;
    for (var j = 0; j < 6; j++) if (typeof p[j] !== 'number' || isNaN(p[j])) return null;
    if (p[3] === 24) p[3] = 0;
    return p;
  }

  function makeZone(tz) {
    var fmt = null;
    if (tz) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: 'numeric',
          day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        if (!readParts(fmt, 0)) fmt = null;
      } catch (e) { fmt = null; }
    }
    var cache = {};
    var size = 0;
    var Q = 15 * MIN;
    function offset(ms) {
      var key = Math.floor(ms / Q);
      if (cache.hasOwnProperty(key)) return cache[key];
      var at = key * Q;
      var off = null;
      if (fmt) {
        try {
          var p = readParts(fmt, at);
          if (p) off = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - at;
        } catch (e) { off = null; }
      }
      if (off === null) off = -new Date(at).getTimezoneOffset() * MIN;
      if (size > 4000) { cache = {}; size = 0; }
      cache[key] = off;
      size += 1;
      return off;
    }
    function wall(ms) { return ms + offset(ms); }
    function utc(w) {
      var a = w - offset(w - DAY);
      var b = w - offset(w + DAY);
      var first = Math.min(a, b);
      var second = Math.max(a, b);
      if (wall(first) === w) return first;
      if (wall(second) === w) return second;
      return a;
    }
    return {
      tz: tz, ok: !!fmt, wall: wall, utc: utc,
      dayOf: function (ms) { return Math.floor(wall(ms) / DAY); },
      dayStart: function (n) { return utc(n * DAY); }
    };
  }

  function dayFromText(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(t);
    if (d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) return null;
    return Math.round(t / DAY);
  }

  function parseIso(s) {
    if (typeof s !== 'string') return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function weekday(n) { return ((n + 4) % 7 + 7) % 7; }

  function ymd(n) {
    var d = new Date(n * DAY);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
  }

  /* ---------- words for times and days ---------- */

  function zone() {
    if (!S.zone) S.zone = makeZone(FALLBACK_TZ);
    return S.zone;
  }

  function today() { return zone().dayOf(now()); }

  function hm(ms) {
    var w = zone().wall(ms);
    var mins = Math.floor(((w % DAY) + DAY) % DAY / MIN);
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return (h % 12 === 0 ? 12 : h % 12) + ':' + pad(m) + ' ' + (h < 12 ? STRINGS.am : STRINGS.pm);
  }

  function dateText(n, form) {
    var p = ymd(n);
    var map = { dow: STRINGS.daysShort[weekday(n)], dowLong: STRINGS.days[weekday(n)],
      mon: STRINGS.monthsShort[p.m], month: STRINGS.months[p.m], d: p.d };
    return fill(form === 'short' ? STRINGS.dateShort : form === 'full' ? STRINGS.dateFull : STRINGS.dateLong, map);
  }

  // "Today", "Tomorrow", a weekday within the week, else "Tue, Dec 1".
  // short: the short weekday instead of the long one.
  function relDay(n, td, short) {
    if (n === td) return STRINGS.today;
    if (n === td + 1) return STRINGS.tomorrow;
    if (n > td && n < td + 7) return short ? STRINGS.daysShort[weekday(n)] : STRINGS.days[weekday(n)];
    return dateText(n, short ? 'short' : 'long');
  }

  // "7:10 AM", or "Nov 15" on another day.
  function whenAt(ms) {
    var d = zone().dayOf(ms);
    return d === today() ? hm(ms) : dateText(d, 'short');
  }

  function asOf(ms) { return fill(STRINGS.asOf, { t: whenAt(ms) }); }

  /* ---------- the shared store ---------- */

  var S = {
    ctxs: {},          // widget id -> ctx
    order: [],
    L: null,           // the live line (ctx.live), or null
    bound: false,
    cal: null,         // the calendar resource in use
    calFromCache: false,
    calLiveAt: 0,
    events: null,      // normalized events (all calendars)
    chosen: {},        // cal number -> [r, g, b] sent by the Pi
    snap: null,        // the snapshot in use
    snapFromCache: false,
    snapKey: '',       // the last live snapshot's content this run ('' before any)
    zone: null,
    timer: null,
    sig: '',
    lastDay: null,
    panel: {}          // widget id -> { view, filter, from }
  };

  function live() { return S.L && typeof S.L.status === 'function' ? S.L : null; }

  function liveStatus() {
    var L = live();
    try { return (L && L.status()) || { state: 'off', text: '' }; } catch (e) { return { state: 'off', text: '' }; }
  }

  function validCal(d) {
    return !!d && typeof d === 'object' && (d.configured === false || (d.configured === true && isArr(d.events)));
  }

  function readChosen(d) {
    var out = {};
    var list = d && isArr(d.calendars) ? d.calendars : [];
    for (var i = 0; i < list.length; i++) {
      var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str(list[i] && list[i].color));
      if (m) out[list[i].cal] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    }
    return out;
  }

  function color(cal) {
    var c = S.chosen[cal] || PALETTE[((cal || 1) - 1) % PALETTE.length] || PALETTE[0];
    return 'rgb(' + c.join(',') + ')';
  }

  // The events, sorted: { id, cal, title, place, allDay, s, e, startDay, endDay }.
  function normalize(d, z) {
    var out = [];
    var list = d && isArr(d.events) ? d.events : [];
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || typeof ev !== 'object') continue;
      var n = { id: str(ev.id) || ('x' + i), cal: typeof ev.cal === 'number' && ev.cal >= 1 ? ev.cal : 1,
        title: clean(ev.title), place: clean(ev.location), allDay: ev.allDay === true };
      if (n.allDay) {
        var a = dayFromText(ev.start);
        var b = dayFromText(ev.end);
        if (a === null) continue;
        if (b === null || b <= a) b = a + 1;
        n.startDay = a;
        n.endDay = b;
        n.s = z.dayStart(a);
        n.e = z.dayStart(b);
      } else {
        var s = parseIso(ev.start);
        var e = parseIso(ev.end);
        if (isNaN(s)) continue;
        if (isNaN(e) || e < s) e = s;
        n.s = s;
        n.e = e;
        n.startDay = z.dayOf(s);
        n.endDay = (e > s ? z.dayOf(e - 1) : n.startDay) + 1;
      }
      out.push(n);
    }
    out.sort(function (p, q) {
      return (p.s - q.s) || ((q.allDay ? 1 : 0) - (p.allDay ? 1 : 0)) || (p.title < q.title ? -1 : p.title > q.title ? 1 : 0);
    });
    return out;
  }

  function useCal(d, cached) {
    S.cal = d;
    S.calFromCache = !!cached;
    S.chosen = readChosen(d);
    if (d && d.configured === true) {
      var tz = str(d.tz) || FALLBACK_TZ;
      if (!S.zone || S.zone.tz !== tz) S.zone = makeZone(tz);
      S.events = normalize(d, S.zone);
    } else {
      S.events = null;
    }
  }

  function loadCalCache() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(CAL_KEY);
      if (!raw) return;
      var c = JSON.parse(raw);
      if (c && validCal(c.data) && c.data.configured === true) {
        useCal(c.data, true);
        S.calLiveAt = typeof c.at === 'number' ? c.at : 0;
      }
    } catch (e) { /* start without it */ }
  }

  // A snapshot worth showing: an object with a readable sentAt.
  function snapReady(d) {
    return !!d && typeof d === 'object' && !isArr(d) && !isNaN(parseIso(d.sentAt));
  }

  function loadSnapCache() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(SNAP_KEY);
      if (!raw) return;
      var c = JSON.parse(raw);
      if (c && snapReady(c.data)) { S.snap = c.data; S.snapFromCache = true; }
    } catch (e) { /* start without it */ }
  }

  function saveSnapCache() {
    try {
      if (!window.localStorage) return;
      if (S.snap) window.localStorage.setItem(SNAP_KEY, JSON.stringify({ v: 1, at: now(), data: S.snap }));
      else window.localStorage.removeItem(SNAP_KEY);
    } catch (e) { /* the copy in memory still works */ }
  }

  // What the tiles show from a resource, without the times that only say
  // when it was read or sent: two pushes with the same key draw the same.
  function contentKey(d, skip) {
    try {
      return JSON.stringify(d, function (k, v) { return skip.hasOwnProperty(k) ? undefined : v; });
    } catch (e) { return String(now()); }
  }

  var CAL_SKIP = { updatedAt: true };
  var SNAP_SKIP = { sentAt: true, receivedAt: true, asOf: true };

  function onCal(d) {
    if (!validCal(d)) return;
    S.calLiveAt = now();
    useCal(d, false);
    refreshAll();
  }

  // The tiles that draw from the snapshot (Next visit only reads the calendar).
  var SNAP_TILES = { awws: true, 'awws-agenda': true, 'awws-todo': true, 'awws-reach': true };

  function onSnap(d) {
    if (!d || typeof d !== 'object' || isArr(d)) return;
    // { sentAt: null } is the Pi saying "nothing stored": forget the copy too.
    S.snap = snapReady(d) ? d : null;
    S.snapFromCache = false;
    saveSnapCache();
    // The Pi pushes every snapshot it accepts, even an unchanged one (a new
    // sentAt says it is fresh): the signature redraws only what changed.
    var key = contentKey(S.snap, SNAP_SKIP);
    var changed = S.snapKey !== '' && key !== S.snapKey && !!S.snap;
    S.snapKey = key;
    refreshAll();
    // New content after the first live snapshot this run: those tiles say so.
    if (!changed) return;
    for (var i = 0; i < S.order.length; i++) {
      var ctx = S.ctxs[S.order[i]];
      if (!ctx || !SNAP_TILES[S.order[i]] || typeof ctx.activity !== 'function') continue;
      try { ctx.activity('awws'); } catch (e) { /* the figures just show */ }
    }
  }

  /* ---------- states ---------- */

  // The Pi line's state when a source has nothing to show.
  function lineState() {
    var st = liveStatus().state;
    if (!live() || st === 'off') return 'off';
    if (st === 'connecting') return 'loading';
    if (st === 'quiet') return 'quiet';
    if (st === 'lost') return 'lost';
    if (st === 'live') return 'live';
    return 'refused';
  }

  function calStateRaw() {
    if (S.cal && S.cal.configured === false && !S.calFromCache) return 'unconfigured';
    var ls = lineState();
    if (ls === 'off') return 'off';
    if (S.events) return 'data';
    if (ls === 'live') return 'nocalendar';
    return ls;
  }

  function calByName(name) {
    var list = S.cal && isArr(S.cal.calendars) ? S.cal.calendars : [];
    var want = name.toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && clean(list[i].name).toLowerCase() === want) return list[i];
    }
    return null;
  }

  // The plain reason the Pi gave, only when it is short (like calendar.js).
  function plainError(text) {
    text = str(text);
    var m = /^could not be read \((.*)\)$/.exec(text);
    if (m) text = m[1];
    if (!text || text.length > 40 || /[\/\\{}<>=@:]/.test(text) || text === 'not read yet') return '';
    return text;
  }

  // What the calendar gives a widget. kind: 'visits' or 'all'.
  // { state, names, missing [names], bad [{ name, why }], cals { n: true }, events [] }
  function calFor(kind) {
    var names = kind === 'visits' ? wantedNames('visits') : wantedNames('visits').concat(wantedNames('awws'));
    var out = { state: calStateRaw(), names: names, missing: [], bad: [], cals: {}, events: [] };
    if (out.state === 'unconfigured') { out.state = 'missing'; out.missing = names.slice(); return out; }
    if (out.state !== 'data') return out;
    var found = 0;
    var okCount = 0;
    for (var i = 0; i < names.length; i++) {
      var c = calByName(names[i]);
      if (!c) { out.missing.push(names[i]); continue; }
      found += 1;
      out.cals[c.cal] = true;
      if (c.ok === false) out.bad.push({ name: clean(c.name), why: plainError(c.error) });
      else okCount += 1;
    }
    if (!found) { out.state = 'missing'; return out; }
    for (var j = 0; j < S.events.length; j++) if (out.cals[S.events[j].cal]) out.events.push(S.events[j]);
    if (!okCount && !out.events.length) out.state = 'error';
    return out;
  }

  function snapState() {
    if (snapReady(S.snap)) {
      if (!live() || liveStatus().state === 'off') return 'off';
      return 'data';
    }
    var ls = lineState();
    if (ls === 'live') return 'notsetup';
    return ls;
  }

  function section(name) {
    var v = snapReady(S.snap) ? S.snap[name] : null;
    return v && typeof v === 'object' && !isArr(v) ? v : null;
  }

  // Words for a state: { head, line, short }.
  function message(state, info) {
    var m = STRINGS.states[state] || STRINGS.states.loading;
    var text = (liveStatus().text || '').replace(/^Live:\s*/, '');
    text = text ? text.charAt(0).toUpperCase() + text.substring(1) : '';
    var name = '';
    var why = '';
    if (state === 'missing' && info) name = (info.missing && info.missing[0]) || (info.names && info.names[0]) || '';
    if (state === 'error' && info && info.bad && info.bad[0]) {
      name = info.bad[0].name;
      why = info.bad[0].why ? fill(STRINGS.whyText, { why: info.bad[0].why }) : '';
    }
    var map = { live: text, name: name, why: why };
    return { head: fill(m.head, map), line: fill(m.line, map), short: fill(m.short, map), state: state };
  }

  // States that only wait for the Pi: the hub may show these tiles quietly
  // (motion extras, quietTiles), as one small line.
  var WAITING = { off: true, quiet: true, lost: true, refused: true, loading: true };

  function calStale() {
    if (!S.cal || S.cal.configured !== true) return 0;
    if (liveStatus().state === 'live' && !S.calFromCache) return 0;
    var at = Math.max(S.calLiveAt || 0, parseIso(S.cal.updatedAt) || 0);
    if (!at || now() - at < CAL_STALE) return 0;
    return at;
  }

  function snapStale() {
    if (!snapReady(S.snap)) return 0;
    var at = parseIso(S.snap.sentAt);
    return now() - at >= SNAP_STALE ? at : 0;
  }

  // The oldest age worth saying for the sources a widget uses.
  function staleText(useCal, useSnap) {
    var a = useCal ? calStale() : 0;
    var b = useSnap ? snapStale() : 0;
    var at = a && b ? Math.min(a, b) : (a || b);
    return at ? asOf(at) : '';
  }

  /* ---------- the models ---------- */

  function titleOf(ev) { return ev.title || STRINGS.noTitle; }

  // Visits that haven't ended, in the next 60 days.
  function visits(info) {
    var t = now();
    var limit = today() + VISIT_DAYS;
    var out = [];
    for (var i = 0; i < info.events.length; i++) {
      var ev = info.events[i];
      if (ev.e > t && ev.startDay <= limit) out.push(ev);
    }
    return out;
  }

  // The countdown to an event: { kind: 'now'|'today'|'tomorrow'|'days', n }.
  function countdown(ev, t) {
    var z = zone();
    var td = z.dayOf(t);
    if (ev.allDay ? ev.startDay <= td : ev.s <= t) return { kind: 'now', n: 0 };
    var n = ev.startDay - td;
    return { kind: n <= 0 ? 'today' : n === 1 ? 'tomorrow' : 'days', n: n };
  }

  // "15 days" (or "15 d"), "Today", "Tomorrow", "Now".
  function countdownText(ev, short) {
    var c = countdown(ev, now());
    if (c.kind === 'days') return fill(short ? STRINGS.daysShortN : STRINGS.daysN, { n: fmtNum(c.n) });
    return c.kind === 'now' ? STRINGS.now : c.kind === 'today' ? STRINGS.today : STRINGS.tomorrow;
  }

  function timeOf(ev) { return ev.allDay ? STRINGS.allDay : hm(ev.s); }

  // "in 15 days", "today at 12:15 PM", "tomorrow at 9:30 AM", "on now".
  function whenPhrase(ev) {
    var c = countdown(ev, now());
    if (c.kind === 'days') return fill(STRINGS.inDays, { n: fmtNum(c.n) });
    if (c.kind === 'now') return STRINGS.onNow;
    return fill(c.kind === 'today' ? STRINGS.todayAt : STRINGS.tomorrowAt, { t: timeOf(ev) });
  }

  // A visit's date and time, longest first, for fitForms.
  function whenForms(ev, withPlace) {
    var t = timeOf(ev);
    var forms = [];
    if (withPlace && ev.place) forms.push(dateText(ev.startDay, 'long') + STRINGS.sep + t + STRINGS.sep + ev.place);
    forms.push(dateText(ev.startDay, 'long') + STRINGS.sep + t);
    forms.push(dateText(ev.startDay, 'short') + STRINGS.sep + t);
    forms.push(dateText(ev.startDay, 'short'));
    return forms;
  }

  function cleanTodo(raw, i) {
    if (!raw || typeof raw !== 'object') return null;
    var title = clean(raw.title);
    var owner = clean(raw.owner).toLowerCase();
    var sec = clean(raw.section).toLowerCase();
    if (!title || OWNERS.indexOf(owner) < 0 || SECTIONS.indexOf(sec) < 0) return null;
    var it = { id: clean(raw.id) || ('t' + i), title: title, owner: owner, section: sec, stream: clean(raw.stream),
      due: clean(raw.due), waitingOn: clean(raw.waitingOn), done: raw.done === true, dueDay: null, dueMs: NaN };
    var d = dayFromText(raw.dueISO);
    if (d !== null) it.dueDay = d;
    else {
      var ms = parseIso(raw.dueISO);
      if (!isNaN(ms) && /T/.test(str(raw.dueISO))) { it.dueMs = ms; it.dueDay = zone().dayOf(ms); }
    }
    it.doneAt = parseIso(raw.doneAt);
    return it;
  }

  function totalsFrom(t) {
    if (!t || typeof t !== 'object') return null;
    var out = {};
    for (var i = 0; i < OWNERS.length; i++) {
      var o = t[OWNERS[i]];
      out[OWNERS[i]] = {};
      for (var j = 0; j < SECTIONS.length; j++) {
        var v = o && typeof o === 'object' ? count(o[SECTIONS[j]]) : null;
        if (v === null) return null;
        out[OWNERS[i]][SECTIONS[j]] = v;
      }
    }
    return out;
  }

  // The to-do board, or null when it isn't there.
  function board() {
    var sec = section('todos');
    if (!sec || !isArr(sec.items)) return null;
    var items = [];
    var open = [];
    var doneWeek = 0;
    var t = now();
    var seen = {};
    for (var i = 0; i < sec.items.length; i++) {
      var it = cleanTodo(sec.items[i], i);
      if (!it || seen['k' + it.id]) continue;
      seen['k' + it.id] = true;
      items.push(it);
      if (!it.done) open.push(it);
      else if (isNaN(it.doneAt) || t - it.doneAt <= 7 * DAY) doneWeek += 1;
    }
    var counted = {};
    for (var a = 0; a < OWNERS.length; a++) {
      counted[OWNERS[a]] = { now: 0, next: 0, later: 0 };
    }
    for (var b = 0; b < open.length; b++) counted[open[b].owner][open[b].section] += 1;
    var totals = totalsFrom(sec.totals) || counted;
    return { items: items, open: open, totals: totals, doneWeek: doneWeek };
  }

  function isOverdue(it) { return it.dueDay !== null && it.dueDay < today(); }

  function ownerIs(it, f) { return f === 'all' || it.owner === f; }

  // Open Now items for Ian, then for both.
  function nowForIan(b) {
    var out = [];
    var i;
    for (i = 0; i < b.open.length; i++) if (b.open[i].section === 'now' && b.open[i].owner === 'ian') out.push(b.open[i]);
    for (i = 0; i < b.open.length; i++) if (b.open[i].section === 'now' && b.open[i].owner === 'both') out.push(b.open[i]);
    return out;
  }

  function overdueCount(b, f) {
    var n = 0;
    for (var i = 0; i < b.open.length; i++) if (ownerIs(b.open[i], f || 'all') && isOverdue(b.open[i])) n += 1;
    return n;
  }

  // The agenda: events from both calendar lists and open to-dos with a
  // dueISO, on their day, from today for the given number of days. Ended events are left out.
  // [{ key, day, kind, allDay, s, title, cal, place, now, todo }], sorted.
  function agendaItems(info, b, days) {
    var t = now();
    var td = today();
    var out = [];
    var i;
    if (info && info.state === 'data') {
      for (i = 0; i < info.events.length; i++) {
        var ev = info.events[i];
        if (ev.e <= t) continue;
        var first = Math.max(ev.startDay, td);
        var last = Math.min(ev.endDay, td + days);
        if (!ev.allDay) last = Math.min(Math.max(ev.startDay, td) + 1, td + days);
        for (var n = first; n < last; n++) {
          out.push({ key: 'e' + ev.id + '@' + n, day: n, kind: 'event', allDay: ev.allDay, s: ev.allDay ? -1 : ev.s,
            title: titleOf(ev), cal: ev.cal, place: ev.place, now: !ev.allDay && ev.s <= t && n === td, ev: ev });
        }
      }
    }
    if (b) {
      for (i = 0; i < b.open.length; i++) {
        var it = b.open[i];
        if (it.dueDay === null || it.dueDay < td || it.dueDay >= td + days) continue;
        out.push({ key: 't' + it.id, day: it.dueDay, kind: 'todo', allDay: isNaN(it.dueMs), s: isNaN(it.dueMs) ? Infinity : it.dueMs,
          title: it.title, cal: 0, place: '', now: false, todo: it });
      }
    }
    out.sort(function (p, q) {
      return (p.day - q.day) || (p.s - q.s) || (p.title < q.title ? -1 : p.title > q.title ? 1 : 0);
    });
    return out;
  }

  function itemWhen(it) {
    if (it.now) return STRINGS.now;
    if (it.kind === 'todo') return isNaN(it.todo.dueMs) ? STRINGS.due : hm(it.todo.dueMs);
    return it.allDay ? STRINGS.allDay : hm(it.s);
  }

  /* ---------- one-line figures ---------- */

  function money(n, cur) {
    var whole = Math.round(n);
    return (cur === 'USD' ? '$' : (cur ? cur + ' ' : '')) + fmtNum(whole);
  }

  // { label, text, forms, bar, missing } for Librarians, Books, Rewrite, Handoffs, Money, Reach.
  function figure(key) {
    var f = { key: key, label: STRINGS.figures[key], forms: null, bar: -1, missing: false };
    var sec = section(key);
    var parts;
    if (key === 'outreach' && sec && count(sec.waitingOnIan) !== null) {
      parts = [plural(count(sec.waitingOnIan), STRINGS.replies1, STRINGS.repliesN)];
      if (count(sec.booked) !== null) parts.push(fill(STRINGS.booked, { n: fmtNum(count(sec.booked)) }));
      f.forms = [parts.join(STRINGS.sep), parts[0]];
    } else if (key === 'pipeline' && sec && isArr(sec.items)) {
      var stages = isArr(sec.stages) ? sec.stages : [];
      var blocked = null;
      var best = null;
      var live = 0;
      for (var i = 0; i < sec.items.length; i++) {
        var it = sec.items[i];
        if (!it || typeof it !== 'object' || !clean(it.title)) continue;
        var st = count(it.stage) || 0;
        if (stages.length && st >= stages.length) { live += 1; continue; }
        if (it.blocked === true && !blocked) blocked = it;
        if (!best || st > (count(best.stage) || 0)) best = it;
      }
      if (blocked) {
        var name = fill(STRINGS.bookBlocked, { title: clean(blocked.title), format: clean(blocked.format).toLowerCase() }).replace(/\s+$/, '');
        f.forms = clean(blocked.waitingOn) ? [name + STRINGS.sep + fill(STRINGS.waitingOn, { name: clean(blocked.waitingOn) }), name] : [name];
        f.forms.push(clean(blocked.title));
        f.warn = true;
      } else if (best) {
        var stage = clean(stages[count(best.stage) || 0]);
        f.forms = [stage ? fill(STRINGS.bookStage, { title: clean(best.title), stage: stage }) : clean(best.title), clean(best.title)];
      } else if (live) {
        f.forms = [fill(STRINGS.allLive, { n: live })];
      } else f.missing = true;
    } else if (key === 'khaya' && sec && count(sec.total) && count(sec.done) !== null) {
      var done = Math.min(count(sec.done), count(sec.total));
      f.label = clean(sec.label) || f.label;
      f.forms = [fill(STRINGS.spreads, { done: fmtNum(done), total: fmtNum(count(sec.total)) }), fmtNum(done) + '/' + fmtNum(count(sec.total))];
      f.bar = done / count(sec.total);
    } else if (key === 'handoffs' && sec && count(sec.open) !== null && count(sec.blocked) !== null) {
      f.forms = [fill(STRINGS.handoffsLine, { open: fmtNum(count(sec.open)), blocked: fmtNum(count(sec.blocked)) })];
    } else if (key === 'money' && sec && typeof sec.spent === 'number' && typeof sec.earned === 'number') {
      var cash = { spent: money(sec.spent, str(sec.currency)), earned: money(sec.earned, str(sec.currency)) };
      f.forms = [fill(STRINGS.moneyLine, cash), fill(STRINGS.moneyLineShort, cash)];
    } else if (key === 'reach' && reachData()) {
      f.forms = [reachStatus(reachData())];
    } else {
      f.missing = true;
    }
    if (f.missing) f.forms = [STRINGS.notSynced];
    return f;
  }

  function figureKeys() {
    var keys = ['outreach', 'pipeline', 'khaya', 'handoffs'];
    if (showMoney()) keys.push('money');
    return keys;
  }

  /* ---------- the minute timer and redraws ---------- */

  // Changes whenever any tile in the family would look different.
  function signature() {
    var t = now();
    var parts = [calStateRaw(), snapState(), lineState(), today(), staleText(true, false), staleText(false, true),
      contentKey(S.cal, CAL_SKIP), contentKey(S.snap, SNAP_SKIP), liveStatus().text || ''];
    var ended = 0;
    var started = 0;
    if (S.events) {
      for (var i = 0; i < S.events.length; i++) {
        if (S.events[i].e <= t) ended += 1;
        if (S.events[i].s <= t) started += 1;
      }
    }
    parts.push(ended + ':' + started);
    return parts.join('|');
  }

  function refreshAll() {
    var sig = signature();
    if (sig === S.sig) return;
    S.sig = sig;
    S.redraws = (S.redraws || 0) + 1;
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
    var ms = MIN - (now() % MIN) + 250;
    S.timer = setTimeout(function () {
      S.timer = null;
      try { refreshAll(); } catch (e) { warn(e && e.message); }
      schedule();
    }, ms);
  }

  function bind(ctx) {
    if (!S.ctxs[ctx.id]) S.order.push(ctx.id);
    S.ctxs[ctx.id] = ctx;
    if (S.bound) return;
    S.bound = true;
    var L = ctx.live && typeof ctx.live.status === 'function' ? ctx.live : null;
    S.L = L;
    if (L) {
      loadCalCache();
      loadSnapCache();
      try {
        var c = L.get('calendar');
        if (validCal(c)) { S.calLiveAt = now(); useCal(c, false); }
      } catch (e) { /* wait for it */ }
      try {
        var d = L.get('awws');
        if (d && typeof d === 'object') { S.snap = snapReady(d) ? d : null; S.snapFromCache = false; saveSnapCache(); S.snapKey = contentKey(S.snap, SNAP_SKIP); }
      } catch (e) { /* wait for it */ }
      try {
        L.on('calendar', function (d) { try { onCal(d); } catch (e) { warn(e && e.message); } });
        L.on('awws', function (d) { try { onSnap(d); } catch (e) { warn(e && e.message); } });
      } catch (e) { warn('live: ' + (e && e.message)); }
    }
    S.sig = signature();
    schedule();
  }

  function onStatus() {
    try {
      if (liveStatus().state === 'live' && S.events && !S.calFromCache) S.calLiveAt = now();
      refreshAll();
    } catch (e) { /* the next change tries again */ }
  }

  /* ---------- shared drawing ---------- */

  function sizeOf(ctx) {
    var z = ctx && ctx.size ? ctx.size() : null;
    return z || { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
  }

  function accent(parent, cal, todo) {
    var b = el('span', 'aw-bar' + (todo ? ' is-todo' : ''), parent);
    if (!todo) b.style.backgroundColor = color(cal);
    return b;
  }

  function dot(parent, cal, todo) {
    var d = el('span', 'aw-dot' + (todo ? ' is-todo' : ''), parent);
    if (!todo) d.style.backgroundColor = color(cal);
    return d;
  }

  function mark(parent, cls) {
    var m = el('span', 'icon aw-mark' + (cls ? ' ' + cls : ''), parent);
    m.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.globe) || '';
    return m;
  }

  // A message in a tile: head, short line, faint globe.
  function tileMessage(root, size, msg, quiet) {
    var wait = WAITING[msg.state] === true;
    if (size.cols === 1) {
      mark(root, 'is-solo' + (wait ? ' hub-dormant' : ''));
      return;
    }
    if (size.tier === 'strip') {
      el('div', 'aw-strip-text aw-cut' + (quiet ? ' is-quiet' : '') + (wait ? ' hub-dormant hub-quiet-line' : ''), root, msg.head);
      return;
    }
    var box = el('div', 'aw-msg' + (wait ? ' hub-dormant' : ''), root);
    el('div', 'aw-msg-head' + (wait ? ' hub-quiet-line' : ''), box, msg.head);
    if (msg.short) el('div', 'aw-msg-line' + (wait ? ' hub-quiet-hide' : ''), box, msg.short);
    trim(root, [box.lastChild !== box.firstChild ? box.lastChild : null]);
    mark(root, wait ? 'hub-quiet-hide' : '');   // after the fit: the globe hangs over the edge on purpose
  }

  // A message in a panel: big head, the full line, faint globe.
  function panelMessage(root, msg, extra) {
    var box = el('div', 'aw-pmsg', root);
    el('div', 'aw-pmsg-head', box, msg.head);
    if (msg.line) el('div', 'aw-pmsg-line', box, msg.line);
    if (extra) el('div', 'aw-pmsg-line', box, extra);
    mark(root, 'is-panel');
  }

  // The big countdown: "15" with "days", or "Today" with the time.
  function hero(parent, ev, cls) {
    var c = countdown(ev, now());
    var box = el('div', 'aw-hero' + (cls ? ' ' + cls : ''), parent);
    var num;
    if (c.kind === 'days') {
      num = el('span', 'aw-hero-num', box, fmtNum(c.n));
      el('span', 'aw-hero-cap', box, STRINGS.unitDays);
    } else {
      num = el('span', 'aw-hero-num is-word', box, c.kind === 'now' ? STRINGS.now : c.kind === 'today' ? STRINGS.today : STRINGS.tomorrow);
      var cap = c.kind === 'now' ? (ev.allDay ? STRINGS.allDay : fill(STRINGS.untilT, { t: hm(ev.e) })) : timeOf(ev);
      el('span', 'aw-hero-cap', box, cap);
    }
    box.numEl = num;
    return box;
  }

  // A hero number with its caption: the Now count, the to-do count.
  function heroCount(parent, n, cap, cls) {
    var box = el('div', 'aw-hero' + (cls ? ' ' + cls : ''), parent);
    box.numEl = el('span', 'aw-hero-num', box, fmtNum(n));
    if (cap) el('span', 'aw-hero-cap', box, cap);
    return box;
  }

  function fitHero(box) {
    if (box && box.numEl) fitWidth(box.numEl);
  }

  // The 1-column tile: only the number (or word), as big as fits.
  // caps: the caption, or a list of them, longest first.
  function solo(root, text, caps, warnIt) {
    root.className += ' aw-solo';
    var n = el('div', 'aw-solo-num' + (warnIt ? ' is-warn' : ''), root, text);
    fitWidth(n);
    if (!caps) return;
    var c = el('div', 'aw-solo-cap', root);
    if (!fitForms(c, typeof caps === 'string' ? [caps] : caps)) c.parentNode.removeChild(c);
  }

  // A small section label ("NOW FOR YOU").
  function label(parent, text, cls) { return el('div', 'aw-label' + (cls ? ' ' + cls : ''), parent, text); }

  // A to-do row for tiles and panels: owner chip, title, due, waiting on.
  function todoRow(it, opts) {
    opts = opts || {};
    var late = isOverdue(it);
    var row = el('div', 'aw-trow' + (late ? ' is-late' : '') + (opts.cls ? ' ' + opts.cls : ''));
    if (opts.chip) {
      el('span', 'aw-chip', row, opts.chip === 'long' ? STRINGS.owners[it.owner] : STRINGS.ownersShort[it.owner]);
    }
    var text = el('div', 'aw-trow-text', row);
    el('div', 'aw-trow-title aw-cut', text, it.title);
    var meta = [];
    if (late) meta.push({ t: it.due ? STRINGS.overdue + STRINGS.sep + it.due : STRINGS.overdue, c: 'is-late' });
    else if (it.due) meta.push({ t: it.due, c: '' });
    if (it.waitingOn) meta.push({ t: fill(STRINGS.waitingOn, { name: it.waitingOn }), c: 'is-wait' });
    if (meta.length && opts.meta !== false) {
      var line = el('div', 'aw-trow-meta', text);
      for (var i = 0; i < meta.length; i++) {
        if (i) el('span', 'aw-sep', line, STRINGS.sep);
        el('span', 'aw-meta-part ' + meta[i].c, line, meta[i].t);
      }
    }
    return row;
  }

  // Keeps a to-do row's meta line whole: parts that don't fit go, last first.
  function fitMeta(rows) {
    for (var r = 0; r < rows.length; r++) {
      var line = rows[r].querySelector && rows[r].querySelector('.aw-trow-meta');
      if (!line || !line.parentNode) continue;
      while (overW(line) && line.childNodes.length > 1) {
        line.removeChild(line.lastChild);
        if (line.lastChild && line.lastChild.className === 'aw-sep') line.removeChild(line.lastChild);
      }
      if (overW(line)) line.className += ' aw-cut';
    }
  }

  // An event row: color bar, "when" line over the title.
  function eventRow(when, title, cal, todo, cls) {
    var row = el('div', 'aw-erow' + (cls ? ' ' + cls : ''));
    accent(row, cal, todo);
    var text = el('div', 'aw-erow-text', row);
    el('div', 'aw-erow-when', text, when);
    el('div', 'aw-erow-title aw-cut', text, title);
    return row;
  }

  function foot(root, text, warnIt) {
    if (!text) return null;
    var f = el('div', 'aw-foot' + (warnIt ? ' is-warn' : ''), root, text);
    return f;
  }

  function badNote(info) {
    if (!info || !info.bad || !info.bad.length) return '';
    return fill(STRINGS.calBad, { name: info.bad[0].name });
  }

  function broken(body, title) {
    try {
      body.innerHTML = '';
      el('div', 'aw-msg-line aw-broken', body, fill(STRINGS.broken, { title: title }));
    } catch (e) { /* nothing more to do */ }
  }

  /* ---------- Next visit ---------- */

  function visitsTile(body, ctx) {
    var size = sizeOf(ctx);
    var info = calFor('visits');
    ctx.setTileSub(staleText(true, false));
    var root = el('div', 'aw-tile aw-visits', body);
    if (info.state !== 'data') return tileMessage(root, size, message(info.state, info));
    var list = visits(info);
    var t0 = list[0];
    if (!t0) {
      if (size.cols === 1) return solo(root, '–', '');
      if (size.tier === 'strip') return el('div', 'aw-strip-text is-quiet', root, STRINGS.noVisits);
      var box = el('div', 'aw-msg', root);
      el('div', 'aw-msg-head', box, STRINGS.noVisits);
      el('div', 'aw-msg-line', box, STRINGS.noVisitsWhen);
      mark(root);
      foot(root, badNote(info), true);
      return;
    }
    if (size.cols === 1) {
      var c = countdown(t0, now());
      if (c.kind === 'days') return solo(root, fmtNum(c.n), STRINGS.unitDays);
      return solo(root, countdownText(t0), c.kind === 'now' ? '' : timeOf(t0));
    }
    if (size.tier === 'strip') return visitsStrip(root, size, t0);
    var h = hero(root, t0);
    var lead = el('div', 'aw-lead aw-cut', root, titleOf(t0));
    var when = el('div', 'aw-when', root);
    var bad = foot(root, badNote(info), true);
    fitHero(h);
    fitForms(when, whenForms(t0, true));
    var later = null;
    if (size.tier === 'tall' && list.length > 1) {
      later = el('div', 'aw-sect', root);
      if (bad) root.insertBefore(later, bad);
      label(later, STRINGS.then);
      var rows = el('div', 'aw-list', later);
      var built = [];
      for (var i = 1; i < list.length && i < 3; i++) built.push(visitRow(list[i]));
      if (!fitRows(rows, null, built, 2)) root.removeChild(later);
      else fitVisitRows(built);
    }
    trim(root, [when, bad]);
    if (overH(root)) lead.className += ' is-small';
  }

  function visitRow(ev) {
    var row = el('div', 'aw-vrow');
    accent(row, ev.cal);
    el('span', 'aw-vrow-count', row, countdownText(ev, true));
    var text = el('span', 'aw-vrow-title aw-cut', row, titleOf(ev));
    var date = el('span', 'aw-vrow-date', row, dateText(ev.startDay, 'short'));
    row.textEl = text;
    row.dateEl = date;
    return row;
  }

  // A compact row whose title gets too thin drops its date.
  function fitVisitRows(rows) {
    var min = remPx() * 4;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].parentNode && rows[i].textEl.clientWidth < min) rows[i].removeChild(rows[i].dateEl);
    }
  }

  function visitsStrip(root, size, ev) {
    root.className += ' aw-strip';
    if (size.width === 'narrow') {
      var h = hero(root, ev, 'is-strip');
      fitHero(h);
      if (overW(root) && h.lastChild !== h.numEl) h.removeChild(h.lastChild);
      return;
    }
    var t = timeOf(ev);
    var forms = [dateText(ev.startDay, 'long') + STRINGS.sep + t, dateText(ev.startDay, 'short') + STRINGS.sep + t, dateText(ev.startDay, 'short')];
    if (ev.place) forms.unshift(forms[0] + STRINGS.sep + ev.place);
    stripItem(root, { cal: ev.cal, title: titleOf(ev), forms: forms });
  }

  // A strip's one useful thing: a title and when. One line when the title
  // fits whole; otherwise "when" on a small line over the title.
  // o: { cal, todo, title, forms (longest first), whenFirst, now }
  function stripItem(root, o) {
    var line = el('div', 'aw-strip-line', root);
    accent(line, o.cal, o.todo);
    var when;
    var title;
    if (o.whenFirst) {
      when = el('span', 'aw-strip-when' + (o.now ? ' is-now' : ''), line);
      title = el('span', 'aw-strip-title aw-cut', line, o.title);
    } else {
      title = el('span', 'aw-strip-title aw-cut', line, o.title);
      when = el('span', 'aw-strip-when', line);
    }
    for (var i = 0; i < o.forms.length; i++) {
      when.textContent = (o.whenFirst ? '' : STRINGS.sep) + o.forms[i];
      if (!overW(title) && !overW(line)) return line;
    }
    root.removeChild(line);
    line = el('div', 'aw-strip-line is-stack', root);
    accent(line, o.cal, o.todo);
    var stack = el('div', 'aw-strip-stack', line);
    var small = el('div', 'aw-strip-small' + (o.now ? ' is-now' : ''), stack);
    el('div', 'aw-strip-title2 aw-cut', stack, o.title);
    fitForms(small, o.forms);
    return null;
  }

  function visitsPanel(root, ctx, opts) {
    var info = calFor('visits');
    if (info.state !== 'data') return panelMessage(root, message(info.state, info));
    var list = visits(info);
    var notes = [];
    if (badNote(info)) notes.push(badNote(info));
    if (!list.length) {
      panelMessage(root, { head: STRINGS.noVisits, line: STRINGS.noVisitsWhen }, notes.join(' '));
      return;
    }
    // Full screen: two columns once one would run off the screen.
    var wrap = el('div', 'aw-vlist' + (opts.full && list.length > 4 ? ' is-cols' : ''), root);
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      var row = el('div', 'aw-vpanel f', wrap);
      row.setAttribute('data-key', 'visit-' + ev.id);
      if (i === 0) row.setAttribute('data-autofocus', '');
      accent(row, ev.cal);
      el('div', 'aw-vpanel-count' + (i === 0 ? ' is-first' : ''), row, countdownText(ev, false));
      var text = el('div', 'aw-vpanel-text', row);
      el('div', 'aw-vpanel-title aw-cut', text, titleOf(ev));
      var when = el('div', 'aw-vpanel-when', text);
      when.textContent = dateText(ev.startDay, 'full') + STRINGS.sep + timeOf(ev);
      if (ev.place) el('div', 'aw-vpanel-place aw-cut', text, ev.place);
    }
    for (var k = 0; k < notes.length; k++) el('div', 'aw-pnote is-warn', root, notes[k]);
    // A "when" line too long for its row takes the short date.
    var whens = wrap.querySelectorAll('.aw-vpanel-when');
    for (var j = 0; j < whens.length; j++) {
      if (overW(whens[j])) fitForms(whens[j], whenForms(list[j], false));
    }
  }

  /* ---------- This week ---------- */

  function agendaTile(body, ctx) {
    var size = sizeOf(ctx);
    var info = calFor('all');
    var b = board();
    ctx.setTileSub(staleText(true, !!b));
    var root = el('div', 'aw-tile aw-agenda', body);
    if (info.state !== 'data' && !b) return tileMessage(root, size, message(info.state, info));
    var items = agendaItems(info, b, 7);
    var td = today();
    var note = info.state !== 'data' ? message(info.state, info).head : (!b ? STRINGS.notSynced : '');
    if (size.cols === 1) {
      var todayN = 0;
      for (var a = 0; a < items.length; a++) if (items[a].day === td) todayN += 1;
      return solo(root, fmtNum(todayN), STRINGS.todayCap);
    }
    if (size.tier === 'strip') return agendaStrip(root, size, items, td);
    if (size.width === 'wide') return weekColumns(root, items, td, size.tier === 'tall' ? 3 : 1, note, info);
    // Not wide enough for seven columns: the next few items with day labels.
    var list = el('div', 'aw-list aw-agenda-list', root);
    var more = el('div', 'aw-more', root);
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var day = relDay(it.day, td, size.width === 'narrow');
      rows.push(eventRow(day + STRINGS.sep + itemWhen(it), it.title, it.cal, it.kind === 'todo', it.now ? 'is-now' : ''));
    }
    if (!rows.length) el('div', 'aw-empty', root, STRINGS.nothingWeek);
    var f = foot(root, note || badNote(info), !note && !!badNote(info));
    fitRows(list, more, rows, size.tier === 'tall' ? 12 : 4, true);
    shortWhen(list, items, td);
    if (overH(root)) trim(root, [f]);
  }

  // A "when" line too long for a narrow row uses the short day.
  function shortWhen(list, items, td) {
    var whens = list.querySelectorAll('.aw-erow-when');
    for (var i = 0; i < whens.length; i++) {
      if (!overW(whens[i])) continue;
      var it = items[i];
      fitForms(whens[i], [relDay(it.day, td, true) + STRINGS.sep + itemWhen(it), relDay(it.day, td, true)]);
    }
  }

  function agendaStrip(root, size, items, td) {
    root.className += ' aw-strip';
    var first = null;
    for (var i = 0; i < items.length; i++) if (items[i].day === td) { first = items[i]; break; }
    if (first) {
      var line = stripItem(root, { cal: first.cal, todo: first.kind === 'todo', title: first.title, forms: [itemWhen(first)],
        whenFirst: true, now: first.now });
      // A wide strip with room: the next items after it, while they fit whole.
      for (var k = i + 1; line && k < items.length && k < i + 4; k++) {
        var more = el('span', 'aw-strip-extra', line, STRINGS.sep + relDay(items[k].day, td, true) + ' ' + itemWhen(items[k]) + '  ' + items[k].title);
        if (overW(line)) { line.removeChild(more); break; }
      }
      return;
    }
    var next = items[0];
    if (!next) return el('div', 'aw-strip-text is-quiet', root, STRINGS.nothingWeek);
    var day = relDay(next.day, td, true);
    stripItem(root, { cal: next.cal, todo: next.kind === 'todo', title: next.title, whenFirst: true,
      forms: [STRINGS.nothingToday + STRINGS.sep + day, day] });
  }

  // Seven day columns: weekday and day number, a dot per item, the first
  // items' titles. max: titles per day.
  function weekColumns(root, items, td, max, note, info) {
    root.className += ' aw-week-tile';
    var wk = el('div', 'aw-wk', root);
    for (var d = 0; d < 7; d++) {
      var n = td + d;
      var col = el('div', 'aw-wd' + (n === td ? ' is-today' : ''), wk);
      var head = el('div', 'aw-wd-head', col);
      el('span', 'aw-wd-dow', head, STRINGS.daysShort[weekday(n)]);
      el('span', 'aw-wd-num', head, String(ymd(n).d));
      var mine = [];
      for (var i = 0; i < items.length; i++) if (items[i].day === n) mine.push(items[i]);
      var dots = el('div', 'aw-dots', col);
      for (var k = 0; k < mine.length && k < 6; k++) dot(dots, mine[k].cal, mine[k].kind === 'todo');
      var list = el('div', 'aw-wd-list', col);
      var more = el('div', 'aw-wd-more', col);
      var rows = [];
      for (var j = 0; j < mine.length; j++) {
        var r = el('div', 'aw-wd-item aw-cut' + (mine[j].now ? ' is-now' : ''));
        r.textContent = mine[j].title;
        rows.push(r);
      }
      col.fit = { list: list, more: more, rows: rows };
    }
    var f = foot(root, note || badNote(info), !note && !!badNote(info));
    var cols = wk.childNodes;
    for (var c = 0; c < cols.length; c++) {
      var fit = cols[c].fit;
      var shown = fitRows(fit.list, fit.more, fit.rows, max);
      // No room for a title and "+N": the first title alone, the dots tell the rest.
      if (!shown && fit.rows.length) {
        fit.more.style.display = 'none';
        if (!fitRows(fit.list, null, fit.rows, 1)) fit.more.style.display = '';
      }
      if (fit.more.style.display !== 'none') fit.more.textContent = '+' + (fit.rows.length - fit.list.childNodes.length);
    }
    if (overH(root)) trim(root, [f]);
  }

  // The 14-day list grouped by day, used by the panel and the Glance.
  function agendaPanel(root, ctx, opts) {
    var info = calFor('all');
    var b = board();
    if (info.state !== 'data' && !b) return panelMessage(root, message(info.state, info));
    var td = today();
    var items = agendaItems(info, b, 14);
    var notes = [];
    if (info.state !== 'data') notes.push(message(info.state, info).head);
    else if (info.missing.length) notes.push(message('missing', info).head);
    if (badNote(info)) notes.push(badNote(info));
    if (!b) notes.push(STRINGS.notSynced);
    if (!items.length) {
      panelMessage(root, { head: STRINGS.nothingTwoWeeks, line: '' }, notes.join(STRINGS.sep));
      return;
    }
    var cols = el('div', 'aw-alist' + (opts.full ? ' is-cols' : ''), root);
    var halves = [el('div', 'aw-acol', cols)];
    if (opts.full) halves.push(el('div', 'aw-acol', cols));
    var lastDay = null;
    var box = null;
    var first = true;
    var where = halves[0];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.day !== lastDay) {
        lastDay = it.day;
        // Full screen: whole days, the second column from about half the rows.
        if (opts.full && i >= Math.ceil(items.length / 2)) where = halves[1];
        box = el('div', 'aw-aday', where);
        var head = el('div', 'aw-aday-head' + (it.day === td ? ' is-today' : ''), box);
        el('span', 'aw-aday-rel', head, relDay(it.day, td, false));
        // A day a week or more away is named by its date already.
        if (it.day < td + 7) el('span', 'aw-aday-date', head, dateText(it.day, 'short'));
      }
      var row = el('div', 'aw-arow f' + (it.now ? ' is-now' : '') + (it.kind === 'todo' ? ' is-todo' : ''), box);
      row.setAttribute('data-key', 'a-' + it.key);
      if (first) { row.setAttribute('data-autofocus', ''); first = false; }
      accent(row, it.cal, it.kind === 'todo');
      el('span', 'aw-arow-when', row, itemWhen(it));
      var text = el('div', 'aw-arow-text', row);
      el('div', 'aw-arow-title aw-cut', text, it.title);
      // A to-do's day is in the heading already: its line says whose it is.
      var sub = it.place;
      if (it.kind === 'todo') {
        sub = STRINGS.owners[it.todo.owner] || '';
        if (clean(it.todo.waitingOn)) sub += STRINGS.sep + fill(STRINGS.waitingOn, { name: clean(it.todo.waitingOn) });
      }
      if (sub) el('div', 'aw-arow-sub aw-cut', text, sub);
    }
    for (var k = 0; k < notes.length; k++) el('div', 'aw-pnote', root, notes[k]);
  }

  /* ---------- To-do board ---------- */

  function todoTile(body, ctx) {
    var size = sizeOf(ctx);
    var b = board();
    ctx.setTileSub(b ? staleText(false, true) : '');
    var root = el('div', 'aw-tile aw-todo', body);
    var st = snapState();
    if (!b) return tileMessage(root, size, message(st === 'data' ? 'notsetup' : st), st === 'data' || st === 'notsetup');
    var ianNow = b.totals.ian.now;
    var nowItems = [];
    var ianItems = [];
    for (var i = 0; i < b.open.length; i++) {
      if (b.open[i].section !== 'now') continue;
      nowItems.push(b.open[i]);
      if (b.open[i].owner === 'ian') ianItems.push(b.open[i]);
    }
    if (size.cols === 1) return solo(root, fmtNum(ianNow), [STRINGS.nowForYou, STRINGS.nowWord], false);
    if (size.tier === 'strip') {
      root.className += ' aw-strip';
      var line = el('div', 'aw-strip-line', root);
      el('span', 'aw-strip-num', line, fmtNum(ianNow));
      var first = ianItems[0] || nowItems[0];
      // The first item may take two lines; the cut falls between lines.
      if (first) el('span', 'aw-strip-title2 aw-cut' + (isOverdue(first) ? ' is-late' : ''), line, first.title);
      else el('span', 'aw-strip-title is-quiet', line, STRINGS.nowForYou);
      return;
    }
    var tall = size.tier === 'tall';
    // A wide, short tile: the count on the left, Ian's Now items on the right.
    var split = size.width === 'wide' && !tall;
    var left = split ? el('div', 'aw-split-a', el('div', 'aw-split', root)) : root;
    var h = heroCount(left, ianNow, STRINGS.nowForYou);
    var meta = el('div', 'aw-meta', left);
    // Overdue first, so it is the part that stays when the line is short.
    var late = overdueCount(b, 'all');
    if (late) el('span', 'aw-late-count', meta, plural(late, STRINGS.overdueCount1, STRINGS.overdueCount));
    var owners = ['claude', 'both'];
    for (var o = 0; o < owners.length; o++) {
      if (meta.childNodes.length) el('span', 'aw-sep', meta, STRINGS.sep);
      el('span', '', meta, fill(STRINGS.ownerCount, { name: STRINGS.owners[owners[o]], n: fmtNum(b.totals[owners[o]].now) }));
    }
    fitHero(h);
    while (overW(meta) && meta.childNodes.length > 1) {
      meta.removeChild(meta.lastChild);
      if (meta.lastChild && meta.lastChild.className === 'aw-sep') meta.removeChild(meta.lastChild);
    }
    if (overW(meta)) meta.className += ' aw-cut';
    if (split) {
      var right = el('div', 'aw-split-b', left.parentNode);
      var sec = listSection(right, STRINGS.nowForYouHead, ianItems.length ? ianItems : nowItems, 30, null, function (it) {
        return todoRow(it, { meta: true });
      });
      sec.box.style.display = '';
      var more2 = el('div', 'aw-more', sec.box);
      var n = fitRows(sec.list, more2, sec.rows, sec.max, true);
      fitMeta(sec.rows.slice(0, n));
      trim(left, [meta]);
      return;
    }
    var list = el('div', 'aw-list aw-todo-list', root);
    var more = el('div', 'aw-more', root);
    var source = tall ? nowItems : (ianItems.length ? ianItems : nowItems);
    var rows = [];
    var chip = tall ? (size.width === 'narrow' ? 'short' : 'long') : null;
    for (var j = 0; j < source.length; j++) rows.push(todoRow(source[j], { chip: chip, meta: tall }));
    var shown = fitRows(list, tall ? more : null, rows, tall ? 8 : 1);
    if (!shown) { root.removeChild(list); root.removeChild(more); }
    fitMeta(rows);
    trim(root, [meta]);
  }

  function filterRow(parent, f) {
    var row = el('div', 'aw-filters', parent);
    for (var i = 0; i < FILTERS.length; i++) {
      el('span', 'aw-filter' + (FILTERS[i] === f ? ' is-on' : ''), row, STRINGS.filters[FILTERS[i]]);
    }
    el('span', 'aw-filter-hint', row, STRINGS.filterHint);
    return row;
  }

  function todoPanel(root, ctx, opts) {
    var b = board();
    var st = snapState();
    if (!b) return panelMessage(root, message(st === 'data' ? 'notsetup' : st));
    var f = opts.filter || 'all';
    var wrap = el('div', 'aw-board' + (opts.full ? ' is-full' : ''), root);
    var main = el('div', 'aw-board-main', wrap);
    filterRow(main, f);
    var first = true;
    var any = false;
    for (var s = 0; s < SECTIONS.length; s++) {
      var sec = SECTIONS[s];
      var mine = [];
      for (var i = 0; i < b.open.length; i++) if (b.open[i].section === sec && ownerIs(b.open[i], f)) mine.push(b.open[i]);
      var total = 0;
      for (var o = 0; o < OWNERS.length; o++) if (ownerIs({ owner: OWNERS[o] }, f)) total += b.totals[OWNERS[o]][sec];
      var box = el('div', 'aw-bsec', main);
      var head = el('div', 'aw-label aw-bsec-head', box, STRINGS.sections[sec]);
      el('span', 'aw-bsec-count', head, fmtNum(Math.max(total, mine.length)));
      if (!mine.length) { el('div', 'aw-bsec-empty', box, STRINGS.emptySection); continue; }
      any = true;
      for (var k = 0; k < mine.length; k++) {
        var row = todoRow(mine[k], { chip: f === 'all' ? 'long' : null, cls: 'aw-prow f' });
        row.setAttribute('data-key', 'todo-' + mine[k].id);
        if (first) { row.setAttribute('data-autofocus', ''); first = false; }
        box.appendChild(row);
      }
      if (total > mine.length) el('div', 'aw-more', box, fill(STRINGS.more, { n: total - mine.length }));
    }
    if (!any) el('div', 'aw-bsec-empty', main, f === 'all' ? STRINGS.emptyBoard : fill(STRINGS.emptyFilter, { name: STRINGS.filters[f] }));
    if (b.doneWeek) el('div', 'aw-pnote', main, plural(b.doneWeek, STRINGS.doneWeek1, STRINGS.doneWeek));
    fitMeta(main.querySelectorAll('.aw-trow'));
    if (opts.full) streamBars(el('div', 'aw-board-side', wrap), b, f);
  }

  // Open items per workstream, top five, as plain horizontal bars.
  function streamBars(parent, b, f) {
    var by = {};
    var keys = [];
    for (var i = 0; i < b.open.length; i++) {
      if (!ownerIs(b.open[i], f)) continue;
      var k = b.open[i].stream || STRINGS.noStream;
      if (!by.hasOwnProperty(k)) { by[k] = 0; keys.push(k); }
      by[k] += 1;
    }
    keys.sort(function (p, q) { return (by[q] - by[p]) || (p < q ? -1 : 1); });
    keys = keys.slice(0, 5);
    label(parent, STRINGS.byStream);
    var most = keys.length ? by[keys[0]] : 1;
    for (var j = 0; j < keys.length; j++) {
      var row = el('div', 'aw-brow', parent);
      el('span', 'aw-brow-label aw-cut', row, keys[j]);
      var track = el('span', 'aw-brow-track', row);
      var fillBar = el('span', 'aw-brow-fill', track);
      fillBar.style.width = Math.max(4, Math.round(by[keys[j]] / most * 100)) + '%';
      el('span', 'aw-brow-value', row, fmtNum(by[keys[j]]));
    }
  }

  /* ---------- Reach ---------- */

  // A week's count from the snapshot: { week, prev (or null), days [] }.
  function trendOf(o) {
    if (!o || typeof o !== 'object' || isArr(o)) return null;
    var week = count(o.week);
    if (week === null) return null;
    var days = [];
    if (isArr(o.days)) {
      for (var i = 0; i < o.days.length; i++) if (count(o.days[i]) !== null) days.push(count(o.days[i]));
    }
    return { week: week, prev: count(o.prev), days: days };
  }

  // The reach section, or null when it isn't there or holds nothing usable:
  // { visits, clicks (trends or null), subs (a number or null), subsDay (the
  //   day the subscribers were last counted, or null), scans [{ school, n }] }.
  // Subscribers are counted by hand for now, so any one figure is enough.
  function reachData() {
    var sec = section('reach');
    if (!sec) return null;
    var r = { visits: trendOf(sec.visits), clicks: trendOf(sec.buyClicks), subs: count(sec.subscribers), subsDay: null, scans: [] };
    var d = dayFromText(sec.subscribersAsOf);
    if (d === null && !isNaN(parseIso(sec.subscribersAsOf))) d = zone().dayOf(parseIso(sec.subscribersAsOf));
    if (d === null && !isNaN(parseIso(sec.asOf))) d = zone().dayOf(parseIso(sec.asOf));
    r.subsDay = d;
    var list = isArr(sec.scans) ? sec.scans : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s && typeof s === 'object' && clean(s.school) && count(s.count) !== null) r.scans.push({ school: clean(s.school), n: count(s.count) });
    }
    r.scans.sort(function (p, q) { return q.n - p.n; });
    if (!r.visits && !r.clicks && r.subs === null && !r.scans.length) return null;
    return r;
  }

  // The one figure a tile leads with: visits this week when the sync sends
  // them, otherwise the subscribers (counted by hand), then buy clicks, then
  // scans. { kind, n, t (the trend, or null), cap, word [longest first] }.
  function reachHero(r) {
    if (r.visits) {
      return { kind: 'visits', n: r.visits.week, t: r.visits, cap: r.visits.week === 1 ? STRINGS.visitsWeek1 : STRINGS.visitsWeek,
        word: [r.visits.week === 1 ? STRINGS.visitsWord1 : STRINGS.visitsWord] };
    }
    if (r.subs !== null) {
      return { kind: 'subs', n: r.subs, t: null, cap: r.subs === 1 ? STRINGS.subsWord1 : STRINGS.subsWord,
        word: [r.subs === 1 ? STRINGS.subsWord1 : STRINGS.subsWord, STRINGS.subsWordShort] };
    }
    if (r.clicks) {
      return { kind: 'clicks', n: r.clicks.week, t: r.clicks, cap: r.clicks.week === 1 ? STRINGS.clicksWeek1 : STRINGS.clicksWeek,
        word: [r.clicks.week === 1 ? STRINGS.clicksWord1 : STRINGS.clicksWord, STRINGS.clicksWordShort] };
    }
    var total = 0;
    for (var i = 0; i < r.scans.length; i++) total += r.scans[i].n;
    return { kind: 'scans', n: total, t: null, cap: total === 1 ? STRINGS.scansWord1 : STRINGS.scansWord,
      word: [total === 1 ? STRINGS.scansWord1 : STRINGS.scansWord] };
  }

  // This week against last week: { dir: 'up'|'down'|'same', n }, or null.
  function changeOf(t) {
    if (!t || t.prev === null) return null;
    var d = t.week - t.prev;
    return { dir: d > 0 ? 'up' : d < 0 ? 'down' : 'same', n: Math.abs(d) };
  }

  // The words for a change ("up 24"); the arrow beside them only helps.
  function changeWords(ch, long) {
    if (ch.dir === 'same') return long ? STRINGS.changeSame : STRINGS.changeSameShort;
    return fill(ch.dir === 'up' ? STRINGS.changeUp : STRINGS.changeDown, { n: fmtNum(ch.n) });
  }

  // "at last check Nov 16" for the hand-counted subscribers.
  function lastCheck(r, short) {
    if (r.subsDay === null) return '';
    return fill(short ? STRINGS.lastCheckShort : STRINGS.lastCheck, { d: dateText(r.subsDay, 'short') });
  }

  var ARROW = {
    up: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5 9.2 8.5H.8z" fill="currentColor"/></svg>',
    down: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8.5 .8 1.5h8.4z" fill="currentColor"/></svg>'
  };

  // A line made of parts: the first form that fits on one line; none, it goes.
  // A part: { t: text, c: class, dir: 'up' or 'down' for a small arrow before it }.
  function fitParts(node, forms) {
    for (var f = 0; f < forms.length; f++) {
      if (!forms[f]) continue;
      while (node.firstChild) node.removeChild(node.firstChild);
      for (var i = 0; i < forms[f].length; i++) {
        var p = forms[f][i];
        var span = el('span', p.c || '', node);
        if (p.dir && ARROW[p.dir]) el('span', 'aw-arrow', span).innerHTML = ARROW[p.dir];
        span.appendChild(document.createTextNode(p.t));
      }
      if (!overW(node)) return true;
    }
    node.style.display = 'none';
    return false;
  }

  function sepPart() { return { t: STRINGS.sep, c: 'aw-sep' }; }

  function changePart(ch, long) { return { t: changeWords(ch, long), c: 'aw-rchg', dir: ch.dir === 'same' ? '' : ch.dir }; }

  // Under the hero: "▲ up 24 · vs 388 last week" (shorter forms when narrow),
  // or for subscribers "at last check Nov 16".
  function compareForms(r, h) {
    if (h.kind === 'subs') {
      var a = lastCheck(r, false);
      return a ? [[{ t: a }], [{ t: lastCheck(r, true) }]] : [];
    }
    var ch = changeOf(h.t);
    if (!ch) return [];
    var vs = { t: fill(STRINGS.vsLast, { n: fmtNum(h.t.prev) }) };
    var vsShort = { t: fill(STRINGS.vsLastShort, { n: fmtNum(h.t.prev) }) };
    return [[changePart(ch, false), sepPart(), vs], [changePart(ch, false), sepPart(), vsShort], [vs], [changePart(ch, false)]];
  }

  // "23 buy clicks · ▼ down 4", with shorter forms.
  function figureForms(t, one, many, short) {
    var num = { t: fmtNum(t.week) + ' ', c: 'aw-rline-num' };
    var word = { t: t.week === 1 ? one : many };
    var ch = changeOf(t);
    var forms = [];
    if (ch) forms.push([num, word, sepPart(), changePart(ch, false)]);
    if (ch && short) forms.push([num, { t: short }, sepPart(), changePart(ch, false)]);
    forms.push([num, word]);
    if (short) forms.push([num, { t: short }]);
    return forms;
  }

  function subsForms(r) {
    var num = { t: fmtNum(r.subs) + ' ', c: 'aw-rline-num' };
    var word = { t: r.subs === 1 ? STRINGS.subsWord1 : STRINGS.subsWord };
    var forms = [];
    if (lastCheck(r, false)) forms.push([num, word, sepPart(), { t: lastCheck(r, false) }], [num, word, sepPart(), { t: lastCheck(r, true) }]);
    forms.push([num, word], [num, { t: STRINGS.subsWordShort }]);
    return forms;
  }

  // A sparkline: the days as one line, the last day marked with a dot. No
  // axes and no labels. Drawn to the box's measured size, so the stroke keeps
  // its width (strokeRem, never under 3 px at 1920 x 1080).
  function spark(box, values, strokeRem) {
    var w = box.clientWidth;
    var h = box.clientHeight;
    // Too low to read a shape: no line at all.
    if (!w || !h || values.length < 2 || h < remPx() * 1.8) return false;
    var NS = 'http://www.w3.org/2000/svg';
    var sw = Math.max(3, remPx() * strokeRem);
    var r = sw * 1.5;
    var pad = r + 1;
    if (h < pad * 2 + 4) return false;
    var lo = values[0];
    var hi = values[0];
    for (var i = 1; i < values.length; i++) { lo = Math.min(lo, values[i]); hi = Math.max(hi, values[i]); }
    var pts = [];
    var x = 0;
    var y = 0;
    for (var j = 0; j < values.length; j++) {
      x = pad + j * (w - 2 * pad) / (values.length - 1);
      y = hi === lo ? h / 2 : pad + (1 - (values[j] - lo) / (hi - lo)) * (h - 2 * pad);
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('aria-hidden', 'true');
    var line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', sw.toFixed(1));
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
    var end = document.createElementNS(NS, 'circle');
    end.setAttribute('cx', x.toFixed(1));
    end.setAttribute('cy', y.toFixed(1));
    end.setAttribute('r', r.toFixed(1));
    end.setAttribute('class', 'aw-spark-dot');
    svg.appendChild(end);
    box.appendChild(svg);
    return true;
  }

  function lastDays(values, n) { return values.length > n ? values.slice(values.length - n) : values.slice(); }

  // Top scans as plain horizontal bars: school, bar, count. Returns the rows.
  function scanBars(parent, scans, max) {
    var rows = [];
    var most = scans.length ? Math.max(1, scans[0].n) : 1;
    for (var i = 0; i < scans.length && i < max; i++) {
      var row = el('div', 'aw-brow');
      el('span', 'aw-brow-label aw-cut', row, scans[i].school);
      var track = el('span', 'aw-brow-track', row);
      el('span', 'aw-brow-fill', track).style.width = Math.max(4, Math.round(scans[i].n / most * 100)) + '%';
      el('span', 'aw-brow-value', row, fmtNum(scans[i].n));
      rows.push(row);
    }
    if (parent) for (var k = 0; k < rows.length; k++) parent.appendChild(rows[k]);
    return rows;
  }

  // The one-line status for the Glance's launcher.
  function reachStatus(r) {
    if (r.visits) return plural(r.visits.week, STRINGS.reachLine1, STRINGS.reachLine);
    if (r.subs !== null) return plural(r.subs, STRINGS.reachSubs1, STRINGS.reachSubs);
    if (r.clicks) return plural(r.clicks.week, STRINGS.reachClicks1, STRINGS.reachClicks);
    return plural(reachHero(r).n, STRINGS.reachScans1, STRINGS.reachScans);
  }

  function reachTile(body, ctx) {
    var size = sizeOf(ctx);
    var r = reachData();
    ctx.setTileSub(r ? staleText(false, true) : '');
    var root = el('div', 'aw-tile aw-reach', body);
    var st = snapState();
    if (!r) return tileMessage(root, size, message(st === 'data' ? 'notsetup' : st), st === 'data' || st === 'notsetup');
    var h = reachHero(r);
    if (size.cols === 1) return solo(root, fmtNum(h.n), h.word);
    if (size.tier === 'strip') return reachStrip(root, size, r, h);
    var tall = size.tier === 'tall';
    var days = h.t ? lastDays(h.t.days, 14) : [];
    var subsFoot = tall && h.kind !== 'subs' && r.subs !== null;
    // Wide: the figures on the left; on the right the trend, or when tall the
    // scans and subscribers. Nothing for the right, no split.
    var wide = size.width === 'wide' && (tall ? r.scans.length > 0 || subsFoot : days.length >= 2);
    var left = wide ? el('div', 'aw-split-a', el('div', 'aw-split', root)) : root;
    var right = wide ? el('div', 'aw-split-b', left.parentNode) : null;
    var hb = heroCount(left, h.n, h.cap);
    var cmp = el('div', 'aw-rcmp', left);
    // The second figure: buy clicks, under visits or subscribers.
    var second = (h.kind === 'visits' || h.kind === 'subs') && r.clicks ?
      figureForms(r.clicks, STRINGS.clicksWord1, STRINGS.clicksWord, STRINGS.clicksWordShort) : null;
    var line2 = second ? el('div', 'aw-rline', left) : null;
    var sparkBox = null;
    var head = null;
    var scanSec = null;
    var foot = null;
    if (days.length >= 2) {
      // Wide and tall, the trend fills the left column under the figures.
      var where = wide && !tall ? right : left;
      if (wide) head = label(where, fill(STRINGS.lastDays, { n: days.length }), 'aw-rspark-head');
      sparkBox = el('div', 'aw-spark' + (tall && !wide ? ' is-fixed' : ''), where);
    }
    if (tall && r.scans.length) {
      scanSec = el('div', 'aw-sect aw-rscans', wide ? right : left);
      label(scanSec, STRINGS.scansHead);
      scanSec.list = el('div', 'aw-list aw-rbars', scanSec);
      scanSec.rows = scanBars(null, r.scans, 5);
    }
    // Tall: the subscribers as a quiet figure with their last-check date.
    if (subsFoot) foot = el('div', 'aw-foot aw-rfoot', wide ? right : root);
    fitHero(hb);
    // A caption pushed under the number takes its short word ("visits").
    var cap = hb.lastChild !== hb.numEl ? hb.lastChild : null;
    if (cap && cap.offsetLeft <= hb.numEl.offsetLeft + 1 && h.word[0] !== h.cap) cap.textContent = h.word[0];
    if (!fitParts(cmp, compareForms(r, h))) { cmp.parentNode.removeChild(cmp); cmp = null; }
    if (line2 && !fitParts(line2, second)) { line2.parentNode.removeChild(line2); line2 = null; }
    if (foot && !fitParts(foot, subsForms(r))) { foot.parentNode.removeChild(foot); foot = null; }
    if (scanSec && !fitRows(scanSec.list, null, scanSec.rows, 5)) { scanSec.parentNode.removeChild(scanSec); scanSec = null; }
    trim(root, [line2, foot]);
    if (wide) trim(left, [line2]);
    if (sparkBox && !spark(sparkBox, days, 0.15)) {
      if (head) head.parentNode.removeChild(head);
      sparkBox.parentNode.removeChild(sparkBox);
      sparkBox = null;
    }
    // Subscribers alone leave room: when tall, a quiet word on the traffic
    // still to come, and the faint globe, as the messages have.
    if (!sparkBox && !scanSec && !line2 && !foot && size.cols >= 3) {
      if (tall && !r.visits && !r.clicks) {
        var note = el('div', 'aw-rnote', root, STRINGS.trafficLater);
        if (overH(root)) root.removeChild(note);
      }
      mark(root);
    }
  }

  function reachStrip(root, size, r, h) {
    root.className += ' aw-strip';
    if (size.width === 'narrow') {
      var hb = heroCount(root, h.n, h.word[0], 'is-strip');
      fitHero(hb);
      if (overW(root) && h.word[1] && hb.lastChild !== hb.numEl) hb.lastChild.textContent = h.word[1];
      if (overW(root) && hb.lastChild !== hb.numEl) hb.removeChild(hb.lastChild);
      return;
    }
    var line = el('div', 'aw-strip-line', root);
    el('span', 'aw-strip-num', line, fmtNum(h.n));
    var text = el('span', 'aw-rstrip', line);
    var forms = [];
    var ch = changeOf(h.t);
    if (h.kind === 'subs' && lastCheck(r, false)) {
      forms.push([{ t: h.word[0] }, sepPart(), { t: lastCheck(r, false), c: 'aw-rquiet' }]);
      forms.push([{ t: h.word[0] }, sepPart(), { t: lastCheck(r, true), c: 'aw-rquiet' }]);
    } else if (ch) {
      forms.push([{ t: h.cap }, sepPart(), changePart(ch, false), { t: ' ' + fill(STRINGS.vsLastShort, { n: fmtNum(h.t.prev) }), c: 'aw-rquiet' }]);
      forms.push([{ t: h.word[0] + ' ' }, changePart(ch, false)]);
    }
    forms.push([{ t: h.cap }], [{ t: h.word[0] }]);
    if (h.word[1]) forms.push([{ t: h.word[1] }]);
    fitParts(text, forms);
    // The words stay whole from here: the extras must fit beside them.
    text.style.flexShrink = '0';
    // A wide strip with room: the other figures after it, while they fit whole.
    var extras = [];
    if (h.kind !== 'clicks' && r.clicks) extras.push(plural(r.clicks.week, STRINGS.reachClicks1, STRINGS.reachClicks));
    if (h.kind !== 'subs' && r.subs !== null) extras.push(plural(r.subs, STRINGS.reachSubs1, STRINGS.reachSubs));
    for (var i = 0; i < extras.length; i++) {
      var more = el('span', 'aw-strip-extra', line, STRINGS.sep + extras[i]);
      if (overW(line)) { line.removeChild(more); break; }
    }
  }

  // The panel: each figure with its trend, this week against last, then the
  // scans and the subscribers. Each part takes focus, so a long one scrolls.
  function reachPanel(root, ctx, opts) {
    var r = reachData();
    var st = snapState();
    if (!r) return panelMessage(root, message(st === 'data' ? 'notsetup' : st));
    var wrap = el('div', 'aw-rpanel' + (opts.full ? ' is-cols' : ''), root);
    var cols = [el('div', 'aw-rcol', wrap)];
    if (opts.full && (r.visits || r.clicks) && (r.scans.length || r.subs !== null)) cols.push(el('div', 'aw-rcol', wrap));
    var first = true;
    var sparks = [];
    var lines = [];
    function sect(key, parent, head) {
      var box = el('div', 'aw-rsec f', parent);
      box.setAttribute('data-key', 'r-' + key);
      if (first) { box.setAttribute('data-autofocus', ''); first = false; }
      label(box, head, 'aw-rsec-head');
      return box;
    }
    function bigFigure(box, n, cap) {
      var big = el('div', 'aw-rbig', box);
      big.numEl = el('span', 'aw-rbig-num', big, fmtNum(n));
      el('span', 'aw-rbig-cap', big, cap);
      return big;
    }
    function trendSect(key, t, head, one, many) {
      var box = sect(key, cols[0], head);
      bigFigure(box, t.week, t.week === 1 ? one : many);
      var ch = changeOf(t);
      if (ch) {
        var prev = { t: fill(STRINGS.weekVsLast, { n: fmtNum(t.prev) }) };
        lines.push({ node: el('div', 'aw-rcmp', box), forms: [[changePart(ch, true), sepPart(), prev], [changePart(ch, false), sepPart(), prev], [prev]] });
      }
      var days = lastDays(t.days, 28);
      if (days.length >= 2) {
        var sb = el('div', 'aw-spark is-panel', box);
        sparks.push({ box: sb, days: days, cap: el('div', 'aw-rspark-cap', box, fill(STRINGS.lastDays, { n: days.length })) });
      }
    }
    if (r.visits) trendSect('visits', r.visits, STRINGS.reachHeads.visits, STRINGS.visitsWeek1, STRINGS.visitsWeek);
    if (r.clicks) trendSect('clicks', r.clicks, STRINGS.reachHeads.clicks, STRINGS.clicksWeek1, STRINGS.clicksWeek);
    var side = cols[cols.length - 1];
    if (r.scans.length) scanBars(el('div', 'aw-rbars', sect('scans', side, STRINGS.reachHeads.scans)), r.scans, 10);
    if (r.subs !== null) {
      var subs = sect('subs', side, STRINGS.reachHeads.subs);
      bigFigure(subs, r.subs, r.subs === 1 ? STRINGS.subsWord1 : STRINGS.subsWord);
      if (lastCheck(r, false)) lines.push({ node: el('div', 'aw-rcmp', subs), forms: [[{ t: lastCheck(r, false) }], [{ t: lastCheck(r, true) }]] });
    }
    if (!r.visits && !r.clicks) el('div', 'aw-pnote', side, STRINGS.trafficLater);
    for (var i = 0; i < lines.length; i++) fitParts(lines[i].node, lines[i].forms);
    for (var j = 0; j < sparks.length; j++) {
      if (!spark(sparks[j].box, sparks[j].days, opts.full ? 0.22 : 0.18)) {
        sparks[j].box.parentNode.removeChild(sparks[j].cap);
        sparks[j].box.parentNode.removeChild(sparks[j].box);
      }
    }
  }

  /* ---------- the Glance ---------- */

  function glanceTile(body, ctx) {
    var size = sizeOf(ctx);
    var info = calFor('all');
    var vinfo = calFor('visits');
    var b = board();
    ctx.setTileSub(staleText(true, !!b));
    var root = el('div', 'aw-tile aw-glance', body);
    if (size.cols >= 6 && size.rows >= 4) return dashboard(root, { big: size.cols >= 9 && size.rows >= 5 });
    var vlist = vinfo.state === 'data' ? visits(vinfo) : [];
    var next = vlist[0] || null;
    var ianNow = b ? b.totals.ian.now : null;
    if (!next && ianNow === null) return tileMessage(root, size, message(info.state === 'data' ? 'notsetup' : info.state, info), info.state === 'data');
    if (size.cols === 1) {
      if (next) {
        var c = countdown(next, now());
        return c.kind === 'days' ? solo(root, fmtNum(c.n), STRINGS.unitDays) : solo(root, countdownText(next), c.kind === 'now' ? '' : timeOf(next));
      }
      return solo(root, fmtNum(ianNow), [STRINGS.nowForYou, STRINGS.nowWord]);
    }
    if (size.tier === 'strip') return glanceStrip(root, size, next, ianNow, vinfo);

    var wide = size.width === 'wide';
    var left = wide ? el('div', 'aw-split-a', el('div', 'aw-split', root)) : root;
    var right = wide ? el('div', 'aw-split-b', left.parentNode) : null;
    var h;
    var lead;
    var when = null;
    if (next) {
      h = hero(left, next);
      lead = el('div', 'aw-lead aw-cut', left, titleOf(next));
      when = el('div', 'aw-when', left);
    } else {
      h = heroCount(left, ianNow, STRINGS.nowForYou);
      // Why there is no visit may take two lines.
      lead = el('div', 'aw-lead is-quiet aw-two', left, vinfo.state === 'data' ? STRINGS.noVisits : message(vinfo.state, vinfo).head);
    }
    // The foot: "9 now for you · 5 replies waiting", or why the board is missing.
    var parts = [];
    if (next && ianNow !== null) parts.push(fill(STRINGS.nowCount, { n: fmtNum(ianNow) }));
    var out = section('outreach');
    if (out && count(out.waitingOnIan) !== null) parts.push(plural(count(out.waitingOnIan), STRINGS.replies1, STRINGS.repliesN));
    var footText = b || out ? parts.join(STRINGS.sep) : STRINGS.notSynced;
    var f = footText ? el('div', 'aw-foot' + (b || out ? '' : ' is-quiet'), root, footText) : null;
    if (f) f.forms = parts.length > 1 ? [footText, parts[0]] : [footText];
    fitHero(h);
    if (when) fitForms(when, whenForms(next, size.tier === 'tall' || wide));
    if (f) fitForms(f, f.forms);
    var tall = size.tier === 'tall';
    var sections = [];
    // Now for you: the right column of a wide tile, or under the hero when tall.
    if (b && (wide || tall)) {
      var items = nowForIan(b);
      if (items.length) sections.push(listSection(wide ? right : root, STRINGS.nowForYouHead, items, 3, f, function (it) {
        return todoRow(it, { meta: false });
      }));
    }
    if (tall && info.state === 'data') {
      var coming = [];
      var t = now();
      for (var k = 0; k < info.events.length && coming.length < 3; k++) {
        var ev = info.events[k];
        if (ev.e > t && (!next || ev.id !== next.id)) coming.push(ev);
      }
      if (coming.length) sections.push(listSection(wide ? left : root, STRINGS.comingUp, coming, 3, f, function (ev) {
        return eventRow(relDay(ev.startDay, today(), true) + STRINGS.sep + timeOf(ev), titleOf(ev), ev.cal, false);
      }));
    }
    // Lists fit in turn: each takes what it needs and leaves the rest.
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      sec.box.style.display = '';
      var shown = fitRows(sec.list, null, sec.rows, sec.max);
      if (!shown) sec.box.parentNode.removeChild(sec.box);
      else sec.list.style.flexShrink = '0';
    }
    trim(root, [when, f]);
    if (wide) trim(left, [when]);
    if (overH(root) && lead) lead.className += ' is-small';
  }

  function listSection(parent, title, items, max, before, make) {
    var box = el('div', 'aw-sect', parent);
    box.style.display = 'none';   // shown on its turn, so lists fit one after another
    if (before && before.parentNode === parent) parent.insertBefore(box, before);
    label(box, title);
    var list = el('div', 'aw-list', box);
    var rows = [];
    for (var i = 0; i < items.length && i < max; i++) rows.push(make(items[i]));
    return { box: box, list: list, rows: rows, max: max };
  }

  function glanceStrip(root, size, next, ianNow, vinfo) {
    root.className += ' aw-strip';
    if (size.width === 'narrow') {
      var h = next ? hero(root, next, 'is-strip') : heroCount(root, ianNow, STRINGS.nowWord, 'is-strip');
      fitHero(h);
      if (overW(root) && h.lastChild !== h.numEl) h.removeChild(h.lastChild);
      return;
    }
    var line = el('div', 'aw-strip-line', root);
    if (!next) {
      el('span', 'aw-strip-num', line, fmtNum(ianNow));
      el('span', 'aw-strip-title aw-cut', line, STRINGS.nowForYou + STRINGS.sep + (vinfo.state === 'data' ? STRINGS.noVisits : message(vinfo.state, vinfo).head));
      return;
    }
    accent(line, next.cal);
    var title = el('span', 'aw-strip-title aw-cut', line, titleOf(next));
    el('span', 'aw-strip-when is-strong', line, whenPhrase(next));
    var extra = ianNow !== null ? el('span', 'aw-strip-extra', line) : null;
    var out = section('outreach');
    var replies = out && count(out.waitingOnIan) !== null ? plural(count(out.waitingOnIan), STRINGS.replies1, STRINGS.repliesN) : '';
    var min = remPx() * 5;
    if (extra) {
      var forms = [STRINGS.sep + fill(STRINGS.nowCount, { n: fmtNum(ianNow) }), STRINGS.sep + fill(STRINGS.nowCountShort, { n: fmtNum(ianNow) })];
      if (replies) forms.unshift(forms[0] + STRINGS.sep + replies);
      var fits = false;
      for (var f = 0; f < forms.length && !fits; f++) {
        extra.textContent = forms[f];
        fits = !overW(line) && !overW(title);
      }
      if (!fits) line.removeChild(extra);
    }
    if (overW(line) || title.clientWidth < min) {
      root.removeChild(line);
      fitHero(hero(root, next, 'is-strip'));
    }
  }

  // The one-screen dashboard: the countdown, this week, Now for you, and
  // one-line figures, in four quarters split by hairlines.
  function dashboard(root, opts) {
    root.className += ' aw-dash' + (opts.big ? ' is-big' : '') + (opts.full ? ' is-full' : '');
    var top = el('div', 'aw-drow', root);
    var bottom = el('div', 'aw-drow is-bottom', root);
    var q = [el('div', 'aw-q', top), el('div', 'aw-q', top), el('div', 'aw-q', bottom), el('div', 'aw-q', bottom)];
    if (opts.full) {
      var keys = ['visits', 'agenda', 'todo'];
      for (var i = 0; i < 3; i++) {
        q[i].className += ' f';
        q[i].setAttribute('data-key', 'q-' + keys[i]);
      }
      q[0].setAttribute('data-autofocus', '');
    }
    dashVisit(q[0]);
    dashWeek(q[1], !!opts.big);
    dashNow(q[2]);
    dashFigures(q[3]);
  }

  function quietLine(parent, text) { return el('div', 'aw-quiet', parent, text); }

  function dashVisit(q) {
    var info = calFor('visits');
    label(q, STRINGS.titles.visits);
    if (info.state !== 'data') {
      var m = message(info.state, info);
      el('div', 'aw-msg-head', q, m.head);
      if (m.short) el('div', 'aw-msg-line', q, m.short);
      return;
    }
    var list = visits(info);
    if (!list.length) {
      el('div', 'aw-msg-head', q, STRINGS.noVisits);
      el('div', 'aw-msg-line', q, STRINGS.noVisitsWhen);
      return;
    }
    var ev = list[0];
    var h = hero(q, ev, 'is-dash');
    var lead = el('div', 'aw-lead aw-cut', q, titleOf(ev));
    var when = el('div', 'aw-when', q);
    var place = ev.place ? el('div', 'aw-when aw-cut', q, ev.place) : null;
    var rows = [];
    var then = null;
    if (list.length > 1) {
      then = el('div', 'aw-sect', q);
      label(then, STRINGS.then);
      var tl = el('div', 'aw-list', then);
      for (var i = 1; i < list.length && i < 3; i++) rows.push(visitRow(list[i]));
      then.list = tl;
    }
    fitHero(h);
    fitForms(when, whenForms(ev, false));
    if (then && !fitRows(then.list, null, rows, 2)) { q.removeChild(then); then = null; }
    if (then) fitVisitRows(rows);
    trim(q, [when, place]);
    if (overH(q)) lead.className += ' is-small';
  }

  function dashWeek(q, big) {
    var info = calFor('all');
    var b = board();
    label(q, STRINGS.titles.agenda);
    if (info.state !== 'data' && !b) {
      el('div', 'aw-msg-head', q, message(info.state, info).head);
      return;
    }
    var td = today();
    var items = agendaItems(info, b, 7);
    var wk = el('div', 'aw-wk is-mini', q);
    for (var d = 0; d < 7; d++) {
      var n = td + d;
      var col = el('div', 'aw-wd' + (n === td ? ' is-today' : ''), wk);
      var head = el('div', 'aw-wd-head', col);
      el('span', 'aw-wd-dow', head, STRINGS.daysShort[weekday(n)]);
      el('span', 'aw-wd-num', head, String(ymd(n).d));
      var dots = el('div', 'aw-dots', col);
      var k = 0;
      for (var i = 0; i < items.length && k < 4; i++) if (items[i].day === n) { dot(dots, items[i].cal, items[i].kind === 'todo'); k += 1; }
    }
    // Shrink the weekday names if a language makes them too wide.
    var dows = wk.querySelectorAll('.aw-wd-dow');
    for (var w = 0; w < dows.length; w++) if (overW(dows[w])) { dows[w].className += ' is-min'; dows[w].textContent = dows[w].textContent.charAt(0); }
    var list = el('div', 'aw-list', q);
    var more = el('div', 'aw-more', q);
    var rows = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      rows.push(eventRow(relDay(it.day, td, true) + STRINGS.sep + itemWhen(it), it.title, it.cal, it.kind === 'todo',
        (it.now ? 'is-now' : '') + (big ? ' is-line' : '')));
    }
    if (!rows.length) el('div', 'aw-empty', q, STRINGS.nothingWeek);
    var note = info.state !== 'data' ? quietLine(q, message(info.state, info).head) : (!b ? quietLine(q, STRINGS.notSynced) : null);
    if (note) q.insertBefore(note, list);
    fitRows(list, more, rows, 8);
    shortWhen(list, items, td);
  }

  function dashNow(q) {
    var b = board();
    label(q, STRINGS.nowForYouHead);
    if (!b) { quietLine(q, STRINGS.notSynced); return; }
    var items = nowForIan(b);
    if (!items.length) { quietLine(q, STRINGS.nothingNow); return; }
    var list = el('div', 'aw-list', q);
    var more = el('div', 'aw-more', q);
    var rows = [];
    for (var i = 0; i < items.length; i++) rows.push(todoRow(items[i], { chip: items[i].owner === 'both' ? 'long' : null }));
    fitRows(list, more, rows, 10);
    fitMeta(rows);
    if (more.style.display !== 'none') {
      var total = b.totals.ian.now + b.totals.both.now;
      var rest = Math.max(total, items.length) - list.childNodes.length;
      more.textContent = fill(STRINGS.more, { n: rest });
    }
  }

  function dashFigures(q) {
    label(q, STRINGS.figuresHead, 'aw-cut');
    var keys = figureKeys();
    var box = el('div', 'aw-figs', q);
    var rows = [];
    for (var i = 0; i < keys.length; i++) {
      var f = figure(keys[i]);
      var row = el('div', 'aw-fig' + (f.missing ? ' is-missing' : ''), box);
      el('div', 'aw-fig-label', row, f.label);
      var val = el('div', 'aw-fig-value', row);
      var v = el('div', 'aw-fig-text', val);
      if (f.bar >= 0) {
        var track = el('div', 'aw-fig-track', val);
        el('div', 'aw-fig-fill', track).style.width = Math.round(f.bar * 100) + '%';
      }
      rows.push({ v: v, forms: f.forms });
    }
    for (var j = 0; j < rows.length; j++) {
      if (!fitForms(rows[j].v, rows[j].forms)) {
        rows[j].v.style.display = '';
        rows[j].v.textContent = rows[j].forms[rows[j].forms.length - 1];
        rows[j].v.className += ' aw-cut';
      }
    }
    while (box.lastChild && box.childNodes.length > 1 && (overH(q) || overH(box))) box.removeChild(box.lastChild);
  }

  /* ---------- the Glance panel: a launcher ---------- */

  function launcher(root, ctx, opts) {
    var vinfo = calFor('visits');
    var info = calFor('all');
    var b = board();
    var from = opts.from || 'visits';
    var list = el('div', 'aw-launch', root);
    function row(key, name, status, soon) {
      var r = el('div', 'aw-lrow' + (soon ? ' is-soon' : ' f'), list);
      if (!soon) {
        r.setAttribute('data-key', 'go-' + key);
        if (key === from) r.setAttribute('data-autofocus', '');
      }
      el('div', 'aw-lrow-name', r, name);
      var s = el('div', 'aw-lrow-status aw-cut', r, status);
      if (soon) el('span', 'aw-lrow-soon', r, STRINGS.soon);
      return s;
    }
    var vs;
    if (vinfo.state !== 'data') vs = message(vinfo.state, vinfo).head;
    else {
      var v = visits(vinfo)[0];
      vs = v ? titleOf(v) + STRINGS.sep + whenPhrase(v) : STRINGS.noVisits;
    }
    row('visits', STRINGS.views.visits, vs);
    var ws;
    if (info.state !== 'data' && !b) ws = message(info.state, info).head;
    else {
      var items = agendaItems(info, b, 7);
      var dates = 0;
      var dues = 0;
      for (var i = 0; i < items.length; i++) { if (items[i].kind === 'todo') dues += 1; else dates += 1; }
      var p = [];
      if (dates) p.push(plural(dates, STRINGS.weekCount1, STRINGS.weekCount));
      if (dues) p.push(plural(dues, STRINGS.dueCount1, STRINGS.dueCount));
      ws = p.length ? p.join(STRINGS.sep) : STRINGS.nothingWeek;
    }
    row('agenda', STRINGS.views.agenda, ws);
    var ts;
    if (!b) ts = snapState() === 'data' || snapState() === 'notsetup' ? STRINGS.notSynced : message(snapState()).head;
    else {
      ts = fill(STRINGS.nowCount, { n: fmtNum(b.totals.ian.now) });
      var late = overdueCount(b, 'ian');
      if (late) ts += STRINGS.sep + plural(late, STRINGS.overdueCount1, STRINGS.overdueCount);
    }
    row('todo', STRINGS.views.todo, ts);
    var r = reachData();
    var rs;
    if (r) rs = reachStatus(r);
    else rs = snapState() === 'data' || snapState() === 'notsetup' ? STRINGS.notSynced : message(snapState()).head;
    row('reach', STRINGS.views.reach, rs);
    var soon = ['outreach', 'pipeline'];
    if (showMoney()) soon.push('money');
    el('div', 'aw-ldiv', list);
    for (var k = 0; k < soon.length; k++) {
      var f = figure(soon[k]);
      var s = row(soon[k], STRINGS.titles[soon[k]], f.missing ? '' : f.forms[0], true);
      if (f.missing) s.parentNode.removeChild(s);
    }
  }

  /* ---------- panels: which view, focus, keys ---------- */

  function pstate(id) {
    if (!S.panel[id]) S.panel[id] = { view: id === 'awws' ? 'launcher' : id.replace('awws-', ''), filter: 'all', from: '' };
    return S.panel[id];
  }

  function full(ctx) { return ctx && ctx.mode && ctx.mode() === 'full'; }

  function subText(ctx, view, useCal, useSnap) {
    var parts = [];
    if (ctx.id === 'awws' && view !== 'launcher' && view !== 'dash') parts.push(STRINGS.views[view]);
    var stale = staleText(useCal, useSnap);
    if (stale) parts.push(stale);
    return parts.join(STRINGS.sep);
  }

  function drawPanel(body, ctx) {
    var ps = pstate(ctx.id);
    var isFull = full(ctx);
    var view = ps.view;
    if (ctx.id === 'awws' && view === 'launcher' && isFull) view = 'dash';
    var root = el('div', 'aw-panel aw-pview-' + view + (isFull ? ' is-full' : ''), body);
    var opts = { full: isFull, filter: ps.filter, from: ps.from };
    if (view === 'visits') { ctx.setSub(subText(ctx, view, true, false)); visitsPanel(root, ctx, opts); }
    else if (view === 'agenda') { ctx.setSub(subText(ctx, view, true, true)); agendaPanel(root, ctx, opts); }
    else if (view === 'todo') { ctx.setSub(subText(ctx, view, false, true)); todoPanel(root, ctx, opts); }
    else if (view === 'reach') { ctx.setSub(subText(ctx, view, false, true)); reachPanel(root, ctx, opts); }
    else if (view === 'dash') {
      ctx.setSub(subText(ctx, view, true, true));
      root.className += ' is-fill';
      dashboard(el('div', 'aw-tile', root), { full: true, big: true });
    } else { ctx.setSub(subText(ctx, view, true, true)); launcher(root, ctx, opts); }
  }

  function panelHooks(id) {
    return {
      renderPanel: function (body, ctx) {
        try { drawPanel(body, ctx); } catch (e) {
          warn('panel: ' + (e && e.message));
          broken(body, STRINGS.titles[id === 'awws' ? 'awws' : id.replace('awws-', '')] || '');
        }
      },
      onSelect: function (target, ctx) {
        var ps = pstate(ctx.id);
        var key = (target && target.getAttribute('data-key')) || '';
        var m = /^(?:go|q)-(visits|agenda|todo|reach)$/.exec(key);
        if (m && ctx.id === 'awws') {
          ps.view = m[1];
          ps.from = m[1];
          ctx.redrawPanel();
        }
      },
      onBack: function (ctx) {
        var ps = pstate(ctx.id);
        if (ctx.id === 'awws' && ps.view !== 'launcher') {
          ps.view = 'launcher';
          ctx.redrawPanel();
          return true;
        }
        return false;
      },
      onMove: function (dir, from, ctx) {
        var ps = pstate(ctx.id);
        if (ps.view !== 'todo' || (dir !== 'left' && dir !== 'right')) return undefined;
        var at = FILTERS.indexOf(ps.filter);
        var next = Math.max(0, Math.min(FILTERS.length - 1, at + (dir === 'left' ? -1 : 1)));
        if (next !== at) {
          ps.filter = FILTERS[next];
          ctx.redrawPanel();
        }
        return true;
      },
      onMode: function (mode, ctx) { ctx.redrawPanel(); },
      onClose: function (ctx) {
        var ps = pstate(ctx.id);
        ps.view = ctx.id === 'awws' ? 'launcher' : ps.view;
        ps.filter = 'all';
        ps.from = '';
      },
      onStatus: onStatus
    };
  }

  /* ---------- registering ---------- */

  function real(id, titleKey, drawTile) {
    var w = {
      id: id,
      title: STRINGS.titles[titleKey],
      icon: 'globe',
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
      }
    };
    if (SNAP_TILES[id]) w.activity = 'awws';   // the working chip goes on the first of these
    var hooks = panelHooks(id);
    for (var k in hooks) if (hooks.hasOwnProperty(k)) w[k] = hooks[k];
    return w;
  }

  /* Placeholders, in the style of planned.js (its fitLines, copied small). */
  function outer(node) {
    var cs = window.getComputedStyle(node);
    if (cs.position === 'absolute' || cs.display === 'none') return 0;
    return node.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }

  function fitLines(body, text, m) {
    var room = body.clientHeight;
    if (!room) return;
    var lh = parseFloat(window.getComputedStyle(text).lineHeight) || 20;
    var lines = Math.max(1, Math.floor((room - outer(m) - outer(text) + text.offsetHeight) / lh));
    function clamp(n) {
      text.style.display = '-webkit-box';
      text.style.webkitBoxOrient = 'vertical';
      text.style.webkitLineClamp = String(n);
      text.style.overflow = 'hidden';
    }
    if (text.offsetHeight <= lines * lh + 1) return;
    clamp(lines);
    if (outer(m) && outer(m) + outer(text) > room + 1) {
      m.style.display = 'none';
      clamp(Math.max(1, Math.floor((room - outer(text) + text.offsetHeight) / lh)));
    }
  }

  function placeholder(key) {
    var words = STRINGS.planned[key];
    return {
      id: 'awws-' + key,
      title: STRINGS.titles[key],
      icon: 'globe',
      expandable: true,
      planned: true,
      renderTile: function (body, ctx) {
        try {
          var text = el('p', 'planned-text aw-planned-text', body, words);
          var m = el('span', 'planned-mark', body);
          m.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.globe) || '';
          var size = ctx && ctx.size ? ctx.size() : null;
          if (!size || size.tier !== 'strip') fitLines(body, text, m);
        } catch (e) { broken(body, STRINGS.titles[key]); }
      },
      renderPanel: function (body) {
        var wrap = el('div', 'planned-panel', body);
        el('p', 'planned-lead', wrap, words);
        el('p', 'planned-note aw-planned-note', wrap, STRINGS.plannedNote);
        var m = el('span', 'planned-mark planned-mark-panel', body);
        m.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.globe) || '';
      }
    };
  }

  /* ---------- test hook ---------- */

  // For dev/awws-test.js and dev/awws-shots.js. Not used by the hub.
  window.HUB_AWWS_TEST = {
    STRINGS: STRINGS,
    makeZone: makeZone,
    countdown: function (ev, t) { return countdown(ev, t); },
    setZone: function (tz) { S.zone = makeZone(tz); },
    today: today,
    board: board,
    calFor: calFor,
    snapState: snapState,
    refresh: function () { refreshAll(); },
    redraws: function () { return S.redraws || 0; },
    store: S
  };

  var list = (window.HUB_WIDGETS = window.HUB_WIDGETS || []);
  list.push(real('awws', 'awws', glanceTile));
  list.push(real('awws-visits', 'visits', visitsTile));
  list.push(real('awws-agenda', 'agenda', agendaTile));
  list.push(real('awws-todo', 'todo', todoTile));
  list.push(real('awws-reach', 'reach', reachTile));
  list.push(placeholder('outreach'));
  list.push(placeholder('pipeline'));
  list.push(placeholder('money'));
})();
