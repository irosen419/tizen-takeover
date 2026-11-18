/*
 * Schedule: the TV shows on the owner's list, inside the Entertainment
 * panel (OK on "Schedule" there). The list and the episodes come from the
 * hub server on the Pi (the resource "shows", pi/shows.js, contract in
 * docs/shows-snapshot.md); times arrive in UTC and are shown in this TV's
 * own time zone, 12 or 24 hours like the Clock tile.
 *
 * Four views: Today, This week (Monday to Sunday, the days gone dimmed),
 * This month (today to the month's end) and Coming soon (seasons coming
 * back, and every show marked still running or ended). OK on an episode
 * opens its app ("Watch on Hulu"), through a ladder per service: a deep link
 * when one is known (none yet; the watch link test in the About panel is
 * finding out which work), otherwise the app itself and a toast saying what
 * to search for.
 *
 * Each show has a watch app (the Pi list's service). watchAliases in
 * HUB_CONFIG.widgets.entertainment sends a whole service elsewhere (by
 * default Hulu titles open in Disney+); the app it came from, and any
 * alsoOn apps from the Pi, show as an "Also on Hulu" chip beside the row:
 * Right moves to it and OK there opens that app instead.
 *
 * The Entertainment tile asks availability(): per app, how many shows have
 * an episode out in the last week or airing later today, to put those apps
 * first with a small count.
 *
 * Watched: after OK opens an app for an episode (or, from a show row with no
 * episode, the earliest episode out and not yet watched), the hub keeps a
 * pending watch on this TV (homeHub.watch.v1) and asks the TV service to count
 * the minutes the app stays running (/watch-track; the page sleeps while the
 * app is open, the service doesn't). Back in the hub, /watch-track/status says
 * which are done (70% of the runtime) and the hub tells the Pi (POST
 * /shows/watched), which sends back the episode as watched: true. Watched
 * rows are dimmed with a check, and a watched episode no longer counts on the
 * Entertainment tile. A service without /watch-track (not restarted since the
 * update) is skipped quietly; the About panel says "needs a TV restart".
 *
 * Not a widget by itself: entertainment.js loads it (HUB_SHOWS.attach) and
 * hands it the panel body. Plain ES5. Every word is in STRINGS; Spanish is
 * 'shows.<key>' in app/i18n.js.
 */
(function () {
  'use strict';

  var CACHE_KEY = 'homeHub.shows.v1';
  var TAB_KEY = 'homeHub.shows.tab';
  var HOURS_KEY = 'homeHub.clock.hours';     // the Clock tile's 12 / 24 choice
  var MIN = 60000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  var TABS = ['today', 'week', 'month', 'soon'];
  var SOON_STRIP = 3;                        // Coming soon cards under the other views
  var DEFAULT_ALIASES = { 'Hulu': 'Disney+' };
  var WATCH_KEY = 'homeHub.watch.v1';        // pending watches: [{ token, showId, season, number, appId, startedAt, runtimeMin }]
  var WATCH_SHARE = 0.7;                     // of the runtime the app must stay open
  var DEFAULT_RUNTIME = 30;                  // minutes, when TVmaze has none
  var WATCH_KEEP = 12 * HOUR;                // a pending watch the service never finished is dropped after this
  var WATCH_MAX = 6;                         // pending watches kept
  var TRACK_OLD = 'needs a TV restart';      // the About row, English only like the other About rows

  var STRINGS = {
    title: 'Schedule',
    entry: 'Schedule',
    entrySub: 'Your shows',
    tabs: { today: 'Today', week: 'This week', month: 'This month', soon: 'Coming soon' },
    sample: 'Sample',
    todayMark: 'Today',
    weekOf: 'Week of {range}',
    rangeSame: '{mon} {a} – {b}',
    rangeTwo: '{monA} {a} – {monB} {b}',
    dayDate: '{mon} {d}',
    code: 'S{s} E{e}',
    codeRange: 'S{s} E{e}–{f}',
    special: 'Special',
    am: 'AM',
    pm: 'PM',
    aired: 'Aired',
    watched: 'Watched',
    inMin: 'in {n} min',
    now: 'On now',
    premiere: 'Premiere',
    watchOn: 'Watch on {service}',
    alsoOn: 'Also on {service}',
    via: 'via {service}',
    noService: 'No app set',
    soonHead: 'Coming soon',
    returns: 'Season {n} returns {date}',
    returnsNoDate: 'Season {n} · no date yet',
    newSeason: 'New season · no date yet',
    days: 'days',
    day: 'day',
    todayChip: 'today',
    yourShows: 'Your shows',
    running: 'Still running',
    ended: 'Ended',
    tbd: 'Still running · undecided',
    nextLine: 'Next: {code} · {when}',
    nothingToday: 'Nothing airs today.',
    nothingWeek: 'Nothing airs this week.',
    nothingMonth: 'Nothing more airs this month.',
    nothingSoon: 'No season dates yet.',
    nextAiring: 'Next up: {name} · {when}',
    tonight: 'Tonight: {name} {time}',
    todayLine: 'Today: {name} {time}',
    opensHome: '{service} opens on its home screen',
    searchFor: 'Search for: {name}',
    notInstalled: '{service} isn’t on this TV.',
    noApp: 'No app is set for {name}. Give it one on the Pi: ./hub shows add "{name}" --service Netflix',
    stillLooking: 'Still looking for your apps. Try again in a second.',
    stale: 'TVmaze couldn’t be reached; this is the last good copy.',
    asOf: 'as of {when}',
    states: {
      off: { head: 'Schedule needs the Pi', line: 'Shows come from the hub server on the Raspberry Pi. Live updates are off on this TV: set live.server in config.js to the Pi’s address.' },
      quiet: { head: 'Schedule needs the Pi', line: 'This TV hasn’t reached the hub server on the Pi yet. It keeps trying quietly. Setting the server up is in pi/README.md.' },
      lost: { head: 'Can’t reach the Pi', line: '{live}. The schedule fills in as soon as the Pi answers again.' },
      old: { head: 'Schedule needs a newer Pi', line: 'The hub server on the Pi doesn’t send shows yet. Update it (pi/README.md), then restart it.' },
      loading: { head: 'Loading…', line: '' },
      empty: { head: 'No shows on the list yet', line: 'Add one on the Pi: ./hub shows add "Stick" --service "Apple TV"' },
      waiting: { head: 'Looking the shows up', line: 'The Pi asks TVmaze about each show. It takes a few seconds.' },
      error: { head: 'TVmaze couldn’t be reached', line: 'The Pi tries again every 6 hours, or now with ./hub shows refresh.' }
    }
  };

  // The service's badge dot, and the names its app goes by on the TV.
  // tryDeepLink(show, episode) may later return { op, uri, key, val } for
  // /launch-control; until the watch link test says what works, every
  // service only opens its app (fallbackOpenApp) and says what to search.
  var SERVICES = {
    'Netflix': { color: '#e50914', match: ['Netflix'] },
    'Prime Video': { color: '#1fa1f1', match: ['Prime Video', 'Amazon Prime Video', 'Amazon'] },
    'Disney+': { color: '#3b6cf6', match: ['Disney+', 'Disney Plus', 'Disney'] },
    'Hulu': { color: '#1ce783', match: ['Hulu'] },
    'Peacock': { color: '#f5c518', match: ['Peacock TV', 'Peacock'] },
    'Apple TV': { color: '#a4a8b3', match: ['Apple TV', 'Apple TV+'] },
    'HBO Max': { color: '#6a5cff', match: ['HBO Max', 'Max'] },
    'Paramount+': { color: '#2a7fff', match: ['Paramount+', 'Paramount Plus'] }
  };

  var POSTER_COLORS = ['#26404a', '#4a2630', '#2f3a52', '#4a3b22', '#2d4632', '#3e2e4f', '#4b3226', '#24424a'];

  var S = {
    C: null,          // the Entertainment widget's ctx
    host: null,       // { findApp(match), appsReady(), launch(id, label), matchFor(label) }
    data: null,       // the shows resource, last good
    fromCache: false,
    tab: 'week',
    soonSeen: {},
    timer: null,
    listeners: []
  };

  /* ---------- small helpers ---------- */

  function now() { return new Date().getTime(); }

  // Only where it failed and the error's kind (TypeError...), never a
  // message: one could quote a show's name.
  function warn(where, e) {
    var kind = (e && e.name) || 'error';
    try { if (window.console && console.warn) console.warn('Schedule: ' + where + ' failed (' + kind + ')'); } catch (x) { /* ignore */ }
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (all, k) {
      return vars && vars.hasOwnProperty(k) && vars[k] !== null && vars[k] !== undefined ? String(vars[k]) : all;
    });
  }

  function L() { return window.HUB_I18N || null; }

  function lang() {
    var I = L();
    try { return I && typeof I.lang === 'function' ? I.lang() : 'en'; } catch (e) { return 'en'; }
  }

  // A word in the hub's language: 'shows.<path>' in i18n.js, else the English.
  function word(path, vars) {
    var parts = path.split('.');
    var v = STRINGS;
    for (var i = 0; i < parts.length && v; i++) v = v[parts[i]];
    var english = typeof v === 'string' ? v : path;
    var I = L();
    if (I && typeof I.t === 'function') {
      try { return String(I.t('shows.' + path, english, vars)); } catch (e) { /* English below */ }
    }
    return fill(english, vars);
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.substring(1) : s; }

  function parseIso(v) {
    if (typeof v !== 'string') return null;
    var t = Date.parse(v);
    return isFinite(t) ? t : null;
  }

  function store(key, value) {
    try { if (window.localStorage) localStorage.setItem(key, value); } catch (e) { /* not kept; fine */ }
  }

  function load(key) {
    try { return window.localStorage ? localStorage.getItem(key) : null; } catch (e) { return null; }
  }

  /* ---------- dates and times, on this TV's clock ---------- */

  function dayStart(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function addDays(ms, n) {
    var d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function weekStart(ms) {
    var d = new Date(dayStart(ms));
    var back = (d.getDay() + 6) % 7;      // Monday first
    return addDays(d.getTime(), -back);
  }

  function monthEnd(ms) {
    var d = new Date(dayStart(ms));
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }

  function hours24() { return load(HOURS_KEY) === '24'; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "9:00 PM" or "21:00"; short: "9 PM" when on the hour.
  function timeText(ms, short) {
    var d = new Date(ms);
    var h = d.getHours();
    var m = d.getMinutes();
    if (hours24()) return h + ':' + pad(m);
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (short && m === 0 ? '' : ':' + pad(m)) + ' ' + word(h < 12 ? 'am' : 'pm');
  }

  function monName(ms) {
    var I = L();
    var d = new Date(ms);
    try { if (I && I.monthName) return I.monthName(d, true); } catch (e) { /* below */ }
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  }

  function dayName(ms, short) {
    var I = L();
    var d = new Date(ms);
    try { if (I && I.dayName) return cap(I.dayName(d, short)); } catch (e) { /* below */ }
    return (short ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])[d.getDay()];
  }

  function dayDate(ms) {
    return word('dayDate', { mon: monName(ms), d: new Date(ms).getDate() });
  }

  function rangeText(fromMs, toMs) {
    var last = addDays(toMs, -1);
    var a = new Date(fromMs);
    var b = new Date(last);
    var range = a.getMonth() === b.getMonth()
      ? word('rangeSame', { mon: monName(fromMs), a: a.getDate(), b: b.getDate() })
      : word('rangeTwo', { monA: monName(fromMs), a: a.getDate(), monB: monName(last), b: b.getDate() });
    return word('weekOf', { range: range });
  }

  function monthTitle(ms) {
    var I = L();
    var d = new Date(ms);
    try { if (I && I.monthName) return cap(I.monthName(d, false)); } catch (e) { /* below */ }
    return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()];
  }

  function longDay(ms) {
    var I = L();
    try { if (I && I.longDate) return cap(I.longDate(new Date(ms))); } catch (e) { /* below */ }
    return dayName(ms) + ', ' + dayDate(ms);
  }

  // "Thu 8:00 PM", or "today 8:00 PM" style for the next-up lines.
  function whenText(ms, t) {
    var d0 = dayStart(t);
    if (ms >= d0 && ms < addDays(d0, 1)) return timeText(ms);
    if (ms < addDays(d0, 7)) return dayName(ms, true) + ' ' + timeText(ms);
    return dayDate(ms) + ' · ' + timeText(ms);
  }

  /* ---------- the data ---------- */

  function validData(d) {
    return !!d && typeof d === 'object' && d.v === 1 && isArr(d.shows);
  }

  function showsOf(d) {
    return validData(d) ? d.shows : [];
  }

  function epCode(eps) {
    var first = eps[0];
    if (first.season === null || first.season === undefined || first.number === null || first.number === undefined) return word('special');
    if (eps.length > 1) {
      var last = eps[eps.length - 1];
      if (last.season === first.season && last.number > first.number) return word('codeRange', { s: first.season, e: first.number, f: last.number });
    }
    return word('code', { s: first.season, e: first.number });
  }

  // Every episode in [fromMs, toMs): [{ show, eps, ms }], a show's episodes
  // at the same moment (a season dropped at once) as one row.
  function airings(d, fromMs, toMs) {
    var out = [];
    var list = showsOf(d);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var ups = isArr(s.upcoming) ? s.upcoming : [];
      var byMs = {};
      for (var j = 0; j < ups.length; j++) {
        var ms = parseIso(ups[j].airstamp);
        if (ms === null || ms < fromMs || ms >= toMs) continue;
        if (!byMs[ms]) { byMs[ms] = { show: s, eps: [], ms: ms }; out.push(byMs[ms]); }
        byMs[ms].eps.push(ups[j]);
      }
    }
    out.sort(function (a, b) { return a.ms - b.ms || (a.show.name < b.show.name ? -1 : 1); });
    return out;
  }

  function epWatched(ep) { return !!ep && ep.watched === true; }

  // True when every episode of a row is marked watched.
  function rowWatched(a) {
    if (!a || !isArr(a.eps) || !a.eps.length) return false;
    for (var i = 0; i < a.eps.length; i++) if (!epWatched(a.eps[i])) return false;
    return true;
  }

  // The rows of a view, grouped by local day: [{ ms, today, past, rows }].
  function groupByDay(list, t) {
    var groups = [];
    var today = dayStart(t);
    for (var i = 0; i < list.length; i++) {
      var ds = dayStart(list[i].ms);
      var g = groups.length ? groups[groups.length - 1] : null;
      if (!g || g.ms !== ds) {
        g = { ms: ds, today: ds === today, past: ds < today, rows: [] };
        groups.push(g);
      }
      g.rows.push(list[i]);
    }
    return groups;
  }

  // Seasons coming back: [{ show, ms (or null: no date yet), days }], dated
  // ones first, soonest first.
  function returning(d, t) {
    var out = [];
    var list = showsOf(d);
    for (var i = 0; i < list.length; i++) {
      var r = list[i].returning;
      if (!r || typeof r !== 'object') continue;
      var ms = parseIso(r.airstamp);
      if (ms === null && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        var p = r.date.split('-');
        ms = new Date(+p[0], +p[1] - 1, +p[2], 12).getTime();
      }
      if (ms !== null && ms < dayStart(t)) continue;
      out.push({ show: list[i], ms: ms, season: r.season, days: ms === null ? null : Math.round((dayStart(ms) - dayStart(t)) / DAY) });
    }
    out.sort(function (a, b) {
      if (a.ms === null || b.ms === null) return a.ms === null ? (b.ms === null ? (a.show.name < b.show.name ? -1 : 1) : 1) : -1;
      return a.ms - b.ms;
    });
    return out;
  }

  // What a view shows: { tab, range, groups, empty, soon }.
  function view(d, tab, t) {
    var from = dayStart(t);
    var to;
    var range;
    if (tab === 'today') { to = addDays(from, 1); range = longDay(t); }
    else if (tab === 'month') { to = monthEnd(t); range = monthTitle(t); }
    else if (tab === 'soon') { return { tab: tab, range: '', groups: [], soon: returning(d, t), shows: showsOf(d) }; }
    else { tab = 'week'; from = weekStart(t); to = addDays(from, 7); range = rangeText(from, to); }
    var groups = groupByDay(airings(d, from, to), t);
    return { tab: tab, range: range, groups: groups, soon: returning(d, t), from: from, to: to };
  }

  // The next episode from now on, for "Next up" lines: { show, eps, ms } or null.
  function nextAiring(d, t) {
    var list = airings(d, t - 30 * MIN, t + 400 * DAY);
    return list.length ? list[0] : null;
  }

  // The Entertainment tile's line: "Tonight: Stick 8 PM", or '' when
  // nothing more airs today.
  function tileLine(d, t) {
    var list = airings(d, t - 30 * MIN, addDays(dayStart(t), 1));
    if (!list.length) return '';
    var a = list[0];
    var key = new Date(a.ms).getHours() >= 17 ? 'tonight' : 'todayLine';
    return word(key, { name: a.show.name, time: timeText(a.ms, true) });
  }

  /* ---------- watching ---------- */

  function aliases() {
    var c = S.C && S.C.config;
    var a = c && c.watchAliases;
    return a && typeof a === 'object' ? a : DEFAULT_ALIASES;
  }

  // The app a show opens in: its own watch app, through the alias map.
  function watchApp(show) {
    var own = (show && (show.watch || show.service)) || '';
    var a = aliases();
    return own && a.hasOwnProperty(own) && typeof a[own] === 'string' && a[own] ? a[own] : own;
  }

  // The app a service is billed through and opened in (Prime Video Channels:
  // HBO Max through Prime Video): the show's own via from the Pi when it is
  // for this service, or else widgets.entertainment.watchVia[service]. ''
  // when it opens in its own app.
  function viaApp(show, service) {
    if (!service) return '';
    var own = show && typeof show.via === 'string' ? show.via : '';
    var v = '';
    if (own && service === watchApp(show)) v = own;
    else {
      var c = S.C && S.C.config;
      var m = c && c.watchVia;
      if (m && typeof m === 'object' && m.hasOwnProperty(service) && typeof m[service] === 'string') v = m[service];
    }
    return v && v !== service ? v : '';
  }

  // The other apps that carry it: the one the alias moved it from, then alsoOn.
  function alternatives(show) {
    var main = watchApp(show);
    var out = [];
    var own = (show && (show.watch || show.service)) || '';
    var list = [own].concat(isArr(show && show.alsoOn) ? show.alsoOn : []);
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (typeof x === 'string' && x && x !== main && out.indexOf(x) < 0) out.push(x);
    }
    return out;
  }

  // Per watch app, how many shows have an episode out in the last week or
  // still to air today: { 'Disney+': 2, ... }.
  function availability(d, t) {
    var out = {};
    var list = airings(d, t - 7 * DAY, addDays(dayStart(t), 1));
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      // A row whose episodes are all marked watched is not something to watch.
      if (rowWatched(list[i])) continue;
      // Counted under the app OK opens: Prime Video for a show watched via it.
      var main = watchApp(list[i].show);
      var app = viaApp(list[i].show, main) || main;
      var k = app + '|' + list[i].show.id;
      if (!app || seen[k]) continue;
      seen[k] = true;
      out[app] = (out[app] || 0) + 1;
    }
    return out;
  }

  function serviceInfo(name) {
    return SERVICES.hasOwnProperty(name) ? SERVICES[name] : null;
  }

  // The ladder for one service: what OK on an episode tries, in order.
  // { service, tryDeepLink: function (show, eps) -> app control or null,
  //   fallbackOpenApp: { label, match }, hint: 'search' }
  function ladder(service) {
    var info = serviceInfo(service);
    var match = null;
    if (S.host && typeof S.host.matchFor === 'function') {
      try { match = S.host.matchFor(service); } catch (e) { match = null; }
    }
    if (!match) match = info ? info.match.slice() : (service ? [service] : []);
    return {
      service: service,
      tryDeepLink: null,
      fallbackOpenApp: { label: service, match: match },
      hint: 'search'
    };
  }

  // OK on an episode or a show: its app, by the ladder. Returns what it did,
  // for the tests: 'deeplink', 'app', 'missing', 'noservice' or 'waiting'.
  function watch(show, eps, other) {
    var C = S.C;
    var host = S.host;
    var service = other || watchApp(show);
    var toast = function (text, ms) { try { if (C) C.toast(text, ms || 5000); } catch (e) { /* ignore */ } };
    if (!service) { toast(word('noApp', { name: show.name }), 7000); return 'noservice'; }
    // Billed through another app (via): that app opens instead.
    service = viaApp(show, service) || service;
    var lad = ladder(service);
    if (typeof lad.tryDeepLink === 'function') {
      var link = null;
      try { link = lad.tryDeepLink(show, eps); } catch (e) { link = null; }
      if (link && host && typeof host.launchControl === 'function') {
        host.launchControl(link, function (err) { if (err) openApp(); else track(show, eps, link.id); });
        return 'deeplink';
      }
    }
    return openApp();

    function openApp() {
      if (!host || !host.appsReady()) { toast(word('stillLooking'), 3500); return 'waiting'; }
      var app = host.findApp(lad.fallbackOpenApp.match);
      if (!app) { toast(word('notInstalled', { service: service }), 4500); return 'missing'; }
      // No deep link: say first what will happen, then open the app.
      showCard(word('opensHome', { service: service }), word('searchFor', { name: show.name }), function () {
        host.launch(app.id, service);
        track(show, eps, app.id);
      });
      return 'app';
    }
  }

  /* ---------- watched: pending watches and the service's count ---------- */

  var T = { old: false, busy: false, probed: false };

  function loadPending() {
    var list = null;
    try { list = JSON.parse(load(WATCH_KEY) || '[]'); } catch (e) { list = null; }
    return isArr(list) ? list : [];
  }

  function savePending(list) {
    store(WATCH_KEY, JSON.stringify(list.slice(-WATCH_MAX)));
  }

  function dropPending(token) {
    var list = loadPending();
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].token !== token) out.push(list[i]);
    savePending(out);
  }

  function makeToken() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var t = '';
    for (var i = 0; i < 12; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
    return t;
  }

  // The episode a Watch press is for: the row's first episode that is out and
  // not watched, or, with no row (a show), the show's earliest one. null when
  // there is none (an episode still to air is not watched yet).
  function pickEpisode(show, eps, t) {
    var list = eps && eps.length ? eps : (show && isArr(show.upcoming) ? show.upcoming : []);
    var best = null;
    var bestMs = 0;
    for (var i = 0; i < list.length; i++) {
      var ep = list[i];
      var ms = parseIso(ep && ep.airstamp);
      if (ms === null || ms > t + 5 * MIN || epWatched(ep)) continue;
      if (typeof ep.season !== 'number' || typeof ep.number !== 'number') continue;
      if (best === null || ms < bestMs) { best = ep; bestMs = ms; }
    }
    return best;
  }

  // OK opened an app for this show: keep a pending watch and ask the service
  // to count. Returns the pending watch, or null (nothing to track).
  function track(show, eps, appId) {
    var C = S.C;
    if (!C || !show || !appId || T.old) return null;
    var t = now();
    var ep = pickEpisode(show, eps, t);
    if (!ep) return null;
    var runtime = typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : DEFAULT_RUNTIME;
    var rec = { token: makeToken(), showId: show.id, season: ep.season, number: ep.number, appId: String(appId), startedAt: t, runtimeMin: runtime };
    var list = loadPending();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && !(list[i].showId === rec.showId && list[i].season === rec.season && list[i].number === rec.number)) out.push(list[i]);
    }
    out.push(rec);
    savePending(out);
    var need = Math.max(1, Math.ceil(runtime * WATCH_SHARE));
    try {
      C.service('/watch-track?app=' + encodeURIComponent(rec.appId) + '&id=' + rec.token + '&need=' + need, 6000, function (err) {
        // An old service (not restarted since the update) has no /watch-track:
        // no toast, nothing kept; the About panel says so.
        if (err === 'not found') { T.old = true; dropPending(rec.token); }
      });
    } catch (e) { warn('starting the count', e); }
    return rec;
  }

  // Tells the Pi an episode is watched. Kept for the next try while the Pi
  // can't be reached; dropped when it refuses (the show is gone).
  function forward(rec) {
    var Lv = S.C && S.C.live;
    if (!Lv || typeof Lv.post !== 'function') return;
    try {
      Lv.post('/shows/watched', { id: rec.showId, season: rec.season, number: rec.number }, function (err, data, code) {
        if (!err || code === 400 || code === 404) dropPending(rec.token);
      });
    } catch (e) { warn('telling the Pi', e); }
  }

  // Asks the service which counts are done and forwards those. Quiet always.
  function checkTracked(force) {
    var C = S.C;
    if (!C || T.busy) return;
    var t = now();
    var list = loadPending();
    var keep = [];
    for (var i = 0; i < list.length; i++) if (list[i] && t - list[i].startedAt < WATCH_KEEP) keep.push(list[i]);
    if (keep.length !== list.length) savePending(keep);
    if (!keep.length && (T.probed && !force)) return;
    T.busy = true;
    T.probed = true;
    try {
      // On screen means the person is back from the app: tell the service to
      // stop counting (the app may keep running behind the hub).
      var settle = false;
      try { settle = document.hidden === false; } catch (e) { settle = false; }
      C.service('/watch-track/status' + (settle ? '?settle=1' : ''), 5000, function (err, data) {
        T.busy = false;
        if (err) {
          if (err === 'not found') { T.old = true; savePending([]); }
          return;
        }
        T.old = false;
        var tracks = data && isArr(data.tracks) ? data.tracks : [];
        var pend = loadPending();
        for (var a = 0; a < pend.length; a++) {
          for (var b = 0; b < tracks.length; b++) {
            if (tracks[b] && tracks[b].id === pend[a].token && tracks[b].done === true) forward(pend[a]);
          }
        }
      });
    } catch (e) { T.busy = false; warn('asking the service', e); }
  }

  // The card before an app opens without a deep link: centered, about 1.8 s;
  // OK or Back (any key is swallowed meanwhile) launches at once. Only
  // opacity and transform animate.
  var CARD_MS = 1800;
  var card = null;

  function showCard(title, line, go) {
    if (card) return;
    var node = document.createElement('div');
    node.className = 'sh-go-card';
    node.setAttribute('role', 'alert');
    var t = document.createElement('div');
    t.className = 'sh-go-card-title';
    t.textContent = title;
    var l = document.createElement('div');
    l.className = 'sh-go-card-line';
    l.textContent = line;
    node.appendChild(t);
    node.appendChild(l);
    document.body.appendChild(node);
    var finished = false;
    var timer = null;
    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      if (node.parentNode) node.parentNode.removeChild(node);
      card = null;
      go();
    }
    function onKey(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      var c = e.keyCode;
      if (c === 13 || c === 10009 || c === 27 || c === 8) done();
    }
    card = { done: done, node: node };
    document.addEventListener('keydown', onKey, true);
    timer = setTimeout(done, CARD_MS);
    // One frame later, so the fade in has something to start from.
    setTimeout(function () { if (!finished) node.className = 'sh-go-card is-shown'; }, 20);
  }

  /* ---------- live data ---------- */

  function liveStatus() {
    var Lv = S.C && S.C.live;
    try { return Lv && typeof Lv.status === 'function' ? Lv.status() || {} : { state: 'off' }; } catch (e) { return { state: 'off' }; }
  }

  function loadCache() {
    try {
      var d = JSON.parse(load(CACHE_KEY) || 'null');
      if (validData(d)) { S.data = d; S.fromCache = true; }
    } catch (e) { /* none */ }
  }

  function saveCache() {
    try { store(CACHE_KEY, JSON.stringify(S.data)); } catch (e) { /* not kept */ }
  }

  function onData(d) {
    if (!validData(d)) return;
    var before = S.data ? JSON.stringify(S.data.shows) : null;
    S.data = d;
    S.fromCache = false;
    saveCache();
    changed(before !== null && before !== JSON.stringify(d.shows));
  }

  function changed() {
    checkSoon();
    for (var i = 0; i < S.listeners.length; i++) {
      try { S.listeners[i](); } catch (e) { warn('a listener', e); }
    }
  }

  // An episode starting within the hour gets the tile's accent edge, once
  // per show and start (calendar.js does the same for events).
  function checkSoon() {
    var C = S.C;
    if (!C || typeof C.accent !== 'function' || !S.data) return;
    var t = now();
    var list = airings(S.data, t, t + HOUR);
    for (var i = 0; i < list.length; i++) {
      var k = list[i].show.id + '@' + list[i].ms;
      if (S.soonSeen[k]) continue;
      S.soonSeen[k] = true;
      try { C.accent('soon'); } catch (e) { /* it just shows */ }
    }
  }

  // Once a minute: "in 25 min", the accent edge and the tile's line move on.
  function schedule() {
    clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      try { changed(); } catch (e) { warn('the minute update', e); }
      try { checkTracked(false); } catch (e) { warn('the watch check', e); }
      schedule();
    }, MIN - (now() % MIN) + 300);
  }

  // What the panel can show now: 'data', or a state from STRINGS.states.
  function state() {
    var ls = liveStatus();
    var Lv = S.C && S.C.live;
    if (!Lv || ls.state === 'off') return S.data ? 'data' : 'off';
    if (!S.data) {
      if (ls.state === 'live') {
        var got;
        try { got = Lv.get('shows'); } catch (e) { got = undefined; }
        return got === undefined ? 'old' : 'loading';
      }
      if (ls.state === 'lost') return 'lost';
      if (ls.state === 'quiet' || ls.state === 'connecting') return 'quiet';
      return 'quiet';
    }
    var list = showsOf(S.data);
    if (!list.length) return 'empty';
    var looked = false;
    for (var i = 0; i < list.length; i++) if (list[i].checkedAt) looked = true;
    if (!looked) return S.data.error ? 'error' : 'waiting';
    return 'data';
  }

  function stateWords(st) {
    var m = STRINGS.states[st] || STRINGS.states.loading;
    var live = (liveStatus().text || '').replace(/^Live:\s*/, '');
    live = cap(live);
    return {
      head: word('states.' + st + '.head'),
      line: m.line ? word('states.' + st + '.line', { live: live }) : ''
    };
  }

  /* ---------- drawing ---------- */

  function poster(parent, show) {
    var name = String(show.name || '?');
    var words = name.replace(/^(the|a|an|el|la|los|las)\s+/i, '').split(/\s+/);
    var ab = (words[0] || name).substring(0, 2);
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 9973;
    var p = el('span', 'sh-poster', parent);
    p.style.backgroundColor = POSTER_COLORS[h % POSTER_COLORS.length];
    el('span', 'sh-poster-ab', p, cap(ab));
    el('span', 'sh-poster-name', p, name);
    return p;
  }

  function badge(parent, service) {
    if (!service) return null;
    var b = el('span', 'sh-badge', parent);
    var info = serviceInfo(service);
    var dot = el('span', 'sh-badge-dot', b);
    if (info) dot.style.backgroundColor = info.color;
    el('span', 'sh-badge-text', b, service);
    return b;
  }

  function rowKey(a) { return 'sh:row:' + a.show.id + ':' + a.ms; }

  function drawRow(parent, a, t, past) {
    var soon = a.ms > t - 5 * MIN && a.ms - t <= HOUR;
    var on = a.ms <= t && a.ms > t - 5 * MIN;
    var app = watchApp(a.show);
    var alts = alternatives(a.show);
    var line = el('div', 'sh-line' + (alts.length ? ' has-alt' : ''), parent);
    var seen = rowWatched(a);
    var row = el('div', 'sh-row f' + (past ? ' is-past' : '') + (seen ? ' is-watched' : '') + (soon || on ? ' is-soon' : ''), line);
    row.setAttribute('data-key', rowKey(a));
    poster(row, a.show);
    var info = el('div', 'sh-info', row);
    el('div', 'sh-title', info, a.show.name);
    var meta = el('div', 'sh-meta', info);
    var bits = epCode(a.eps) + ' · ' + timeText(a.ms);
    el('span', 'sh-meta-text', meta, bits);
    if (seen) {
      var wn = el('span', 'sh-note is-watched', meta);
      el('span', 'sh-check', wn);
      el('span', 'sh-note-text', wn, word('watched'));
    } else if (past) el('span', 'sh-note', meta, word('aired'));
    else if (on) el('span', 'sh-note is-live', meta, word('now'));
    else if (soon) el('span', 'sh-note is-live', meta, word('inMin', { n: Math.max(1, Math.round((a.ms - t) / MIN)) }));
    if (a.eps[0].number === 1 && !past) el('span', 'sh-chip', meta, word('premiere'));
    var via = viaApp(a.show, app);
    if (via) el('span', 'sh-via', meta, word('via', { service: via }));
    var side = el('div', 'sh-side', row);
    badge(side, app);
    var w = el('span', 'sh-watch', side);
    el('span', 'sh-watch-play', w);
    el('span', 'sh-watch-text', w, app ? word('watchOn', { service: app }) : word('noService'));
    if (alts.length) {
      // A chip of its own beside the row: Right reaches it, OK opens that app.
      var alt = el('div', 'sh-alt f' + (past ? ' is-past' : ''), line, word('alsoOn', { service: alts[0] }));
      alt.setAttribute('data-key', 'sh:alt:' + a.show.id + ':' + a.ms + ':0');
    }
    return row;
  }

  function drawDays(parent, groups, t) {
    var box = el('div', 'sh-days', parent);
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var day = el('div', 'sh-day' + (g.today ? ' is-today' : '') + (g.past ? ' is-past' : ''), box);
      var date = el('div', 'sh-date', day);
      if (g.today) el('div', 'sh-date-mark', date, word('todayMark'));
      el('div', 'sh-date-dow', date, dayName(g.ms));
      el('div', 'sh-date-day', date, dayDate(g.ms));
      var rows = el('div', 'sh-rows', day);
      for (var j = 0; j < g.rows.length; j++) drawRow(rows, g.rows[j], t, g.past || g.rows[j].ms < t - 5 * MIN);
    }
    return box;
  }

  function soonText(r) {
    if (r.ms === null) return r.season ? word('returnsNoDate', { n: r.season }) : word('newSeason');
    return word('returns', { n: r.season, date: dayDate(r.ms) });
  }

  function drawSoonCard(parent, r) {
    var card = el('div', 'sh-card f', parent);
    card.setAttribute('data-key', 'sh:soon:' + r.show.id);
    poster(card, r.show);
    var info = el('div', 'sh-card-info', card);
    el('div', 'sh-card-title', info, r.show.name);
    el('div', 'sh-card-line', info, soonText(r));
    if (r.days !== null) {
      var n = el('div', 'sh-count', card);
      if (r.days === 0) el('div', 'sh-count-word is-today', n, word('todayChip'));
      else {
        el('div', 'sh-count-n', n, String(r.days));
        el('div', 'sh-count-word', n, word(r.days === 1 ? 'day' : 'days'));
      }
    }
    return card;
  }

  function drawSoonStrip(parent, list) {
    var dated = [];
    for (var i = 0; i < list.length && dated.length < SOON_STRIP; i++) if (list[i].ms !== null) dated.push(list[i]);
    if (!dated.length) return;
    var wrap = el('div', 'sh-soon', parent);
    el('div', 'sh-soon-head', wrap, word('soonHead'));
    var cards = el('div', 'sh-cards n' + dated.length, wrap);
    for (var j = 0; j < dated.length; j++) drawSoonCard(cards, dated[j]);
  }

  function statusText(s) {
    if (s.running === false) return word('ended');
    if (s.status === 'To Be Determined') return word('tbd');
    return word('running');
  }

  function drawSoonView(parent, v, t) {
    var wrap = el('div', 'sh-soonview', parent);
    if (v.soon.length) {
      var cards = el('div', 'sh-cards is-list', wrap);
      for (var i = 0; i < v.soon.length; i++) drawSoonCard(cards, v.soon[i]);
    } else {
      el('div', 'sh-empty', wrap, word('nothingSoon'));
    }
    el('div', 'sh-soon-head', wrap, word('yourShows'));
    var list = el('div', 'sh-shows', wrap);
    for (var j = 0; j < v.shows.length; j++) {
      var s = v.shows[j];
      var row = el('div', 'sh-show f' + (s.running === false ? ' is-ended' : ''), list);
      row.setAttribute('data-key', 'sh:show:' + s.id);
      poster(row, s);
      var info = el('div', 'sh-info', row);
      el('div', 'sh-title', info, s.name);
      var line = '';
      var next = nextFor(s, t);
      if (next) line = word('nextLine', { code: epCode([next.ep]), when: whenText(next.ms, t) });
      el('div', 'sh-meta', info, line || (s.checkedAt ? '' : (s.error || '')));
      var side = el('div', 'sh-side', row);
      el('span', 'sh-flag' + (s.running === false ? ' is-ended' : ' is-running'), side, s.checkedAt ? statusText(s) : '…');
      badge(side, watchApp(s));
    }
  }

  function nextFor(s, t) {
    var ups = isArr(s.upcoming) ? s.upcoming : [];
    for (var i = 0; i < ups.length; i++) {
      var ms = parseIso(ups[i].airstamp);
      if (ms !== null && ms > t - 30 * MIN) return { ep: ups[i], ms: ms };
    }
    var n = s.nextEpisode;
    var nm = n ? parseIso(n.airstamp) : null;
    return nm !== null && nm > t ? { ep: n, ms: nm } : null;
  }

  function drawMessage(parent, st) {
    var w = stateWords(st);
    var box = el('div', 'sh-msg', parent);
    el('div', 'sh-msg-head', box, w.head);
    if (w.line) el('div', 'sh-msg-line', box, w.line);
  }

  // The whole Schedule in the panel body.
  function renderPanel(body) {
    var t = now();
    var root = el('div', 'sh', body);
    var st = state();
    var top = el('div', 'sh-top', root);
    var tabs = el('div', 'sh-tabs', top);
    for (var i = 0; i < TABS.length; i++) {
      var b = el('div', 'sh-tab f' + (TABS[i] === S.tab ? ' is-on' : ''), tabs, word('tabs.' + TABS[i]));
      b.setAttribute('data-key', 'sh:tab:' + TABS[i]);
      if (TABS[i] === S.tab && st !== 'data') b.setAttribute('data-autofocus', '');
    }
    if (st !== 'data') {
      drawMessage(root, st);
      return;
    }
    var v = view(S.data, S.tab, t);
    var right = el('div', 'sh-range', top);
    if (S.data.sample) el('span', 'sh-sample', right, word('sample'));
    if (v.range) el('span', 'sh-range-text', right, v.range);
    var stale = false;
    var shows = showsOf(S.data);
    for (var k = 0; k < shows.length; k++) if (shows[k].stale) stale = true;
    if (stale || S.fromCache) {
      var when = parseIso(S.data.updatedAt);
      el('div', 'sh-stale', root, stale ? word('stale') : (when ? word('asOf', { when: whenText(when, t) }) : ''));
    }
    if (v.tab === 'soon') {
      drawSoonView(root, v, t);
    } else if (!v.groups.length) {
      var e = el('div', 'sh-empty', root, word(v.tab === 'today' ? 'nothingToday' : v.tab === 'month' ? 'nothingMonth' : 'nothingWeek'));
      var nx = nextAiring(S.data, t);
      if (nx) el('div', 'sh-empty-next', e, word('nextAiring', { name: nx.show.name, when: whenText(nx.ms, t) }));
      drawSoonStrip(root, v.soon);
    } else {
      drawDays(root, v.groups, t);
      drawSoonStrip(root, v.soon);
    }
    // Focus lands on the first episode still to come (or the tab).
    var rows = root.querySelectorAll('.sh-row');
    var pick = null;
    for (var r = 0; r < rows.length; r++) {
      if (!/\bis-(past|watched)\b/.test(rows[r].className)) { pick = rows[r]; break; }
    }
    if (!pick) pick = root.querySelector('.sh-tab.is-on');
    if (pick) pick.setAttribute('data-autofocus', '');
  }

  function findShow(id) {
    var list = showsOf(S.data);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // OK on something in the Schedule. Returns true when it was ours.
  function onSelect(target) {
    var key = (target && target.getAttribute('data-key')) || '';
    if (key.indexOf('sh:') !== 0) return false;
    var p = key.split(':');
    if (p[1] === 'tab') {
      if (TABS.indexOf(p[2]) >= 0 && p[2] !== S.tab) {
        S.tab = p[2];
        store(TAB_KEY, S.tab);
        if (S.C) S.C.redrawPanel();
      }
      return true;
    }
    var show = findShow(p[2]);
    if (!show) return true;
    var eps = [];
    if (p[1] === 'row' || p[1] === 'alt') {
      var ms = Number(p[3]);
      var ups = isArr(show.upcoming) ? show.upcoming : [];
      for (var i = 0; i < ups.length; i++) if (parseIso(ups[i].airstamp) === ms) eps.push(ups[i]);
    }
    var other = null;
    if (p[1] === 'alt') other = alternatives(show)[Number(p[4]) || 0] || null;
    watch(show, eps, other);
    return true;
  }

  /* ---------- hooking in ---------- */

  // ctx: the Entertainment widget's; host: its app finder and launcher.
  function attach(ctx, host) {
    S.C = ctx;
    S.host = host;
    var saved = load(TAB_KEY);
    if (TABS.indexOf(saved) >= 0) S.tab = saved;
    loadCache();
    var Lv = ctx && ctx.live && typeof ctx.live.on === 'function' ? ctx.live : null;
    if (Lv) {
      try {
        var d = Lv.get('shows');
        if (validData(d)) onData(d);
      } catch (e) { /* wait for it */ }
      try { Lv.on('shows', function (d) { try { onData(d); } catch (e) { warn('new shows data', e); } }); } catch (e) { warn('listening for shows', e); }
    }
    try {
      var I = L();
      if (I && typeof I.onChange === 'function') I.onChange(function () { changed(); });
    } catch (e) { /* stays in its language */ }
    schedule();
    checkSoon();
    // Back in front after an app: see which watches finished. The first look
    // (a few seconds after start) also finds out whether the service has /watch-track.
    try { document.addEventListener('visibilitychange', function () { if (!document.hidden) checkTracked(false); }, false); } catch (e) { /* the minute tick still looks */ }
    setTimeout(function () { try { checkTracked(true); } catch (e) { warn('the watch check', e); } }, 4000);
  }

  window.HUB_SHOWS = {
    STRINGS: STRINGS,
    SERVICES: SERVICES,
    attach: attach,
    onChange: function (fn) { if (typeof fn === 'function') S.listeners.push(fn); },
    title: function () { return word('title'); },
    entry: function () { return { label: word('entry'), sub: word('entrySub') }; },
    tileLine: function () { return S.data && state() === 'data' ? tileLine(S.data, now()) : ''; },
    trackText: function () { return T.old ? TRACK_OLD : ''; },
    availability: function () { return S.data && state() === 'data' ? availability(S.data, now()) : {}; },
    renderPanel: renderPanel,
    onSelect: onSelect,
    state: state,
    // For the tests (dev/shows-test.js): the pure parts and the state.
    _test: {
      view: view, airings: airings, groupByDay: groupByDay, returning: returning, tileLine: tileLine,
      track: track, checkTracked: checkTracked, pending: loadPending, rowWatched: rowWatched, trackOld: function () { return T.old; },
      ladder: ladder, watch: watch, watchApp: watchApp, viaApp: viaApp, alternatives: alternatives, availability: availability, timeText: timeText, epCode: epCode, rangeText: rangeText, word: word,
      weekStart: weekStart, monthEnd: monthEnd, setData: function (d) { S.data = d; S.fromCache = false; changed(); },
      tab: function (t) { if (t) S.tab = t; return S.tab; }
    }
  };
})();
