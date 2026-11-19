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
 * Watched, without any timing: every OK that opens an app for an episode that
 * has aired (or, from a show row with no episode, the show's earliest one out
 * and not yet watched) adds that episode to a "started" list on this TV
 * (homeHub.watch.v1: show, season, episode, when; the same episode twice is
 * one entry, at most 20). Nothing else happens: no timer, no question, no call
 * to the TV service, because being in an app is not proof of watching. Back in
 * the hub, whenever, the Entertainment tile (and the Schedule item in its
 * panel) says "N to check" and the top of the Schedule panel lists the started
 * episodes as "Did you finish?", sorted by show title (a leading "The "
 * ignored), then season and episode: show, S16 E9, when it was started, and
 * two buttons, Watched and Not yet. Watched tells the Pi (POST /shows/watched,
 * kept in homeHub.watch.out.v1 and tried again until the Pi answers); Not yet
 * sends nothing; either way the line goes and focus moves to the next line's
 * Watched (the first Schedule row when none is left). An unanswered line waits
 * 7 days and then goes quietly, as unwatched; one whose episode the Pi already
 * has as watched goes by itself. Any aired row also ends in a small check
 * toggle (Right from the row, after "Also on"): it marks the episode watched
 * (POST /shows/watched) or takes the mark off again (POST /shows/unwatch).
 * Watched rows are dimmed with a check, and a watched episode no longer counts
 * on the Entertainment tile.
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
  var WATCH_KEY = 'homeHub.watch.v1';        // started episodes: [{ showId, season, number, startedAt }]
  var OUT_KEY = 'homeHub.watch.out.v1';      // marks on their way to the Pi: [{ op, showId, season, number }]
  var FINISH_KEEP = 7 * DAY;                 // an unanswered "Did you finish?" line goes after this
  var FINISH_MAX = 20;                       // started episodes kept

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
    out: 'Out',
    streamsOn: 'Streams on {service}',
    airsLive: 'Airs live on {channel} · {when}',
    airedLive: 'Aired live on {channel} · {when}',
    newToday: 'New today: {name}',
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
    finishTitle: 'Did you finish?',
    finishWatched: 'Watched',
    finishNotYet: 'Not yet',
    toCheck: '{n} to check',
    started: 'started {when}',
    startedOn: 'started {day}',
    startedLastNight: 'last night',
    startedTonight: 'tonight',
    startedToday: 'earlier today',
    startedYesterday: 'yesterday',
    markWatched: 'Mark as watched',
    unmark: 'Mark as not watched',
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
    data: null,       // the shows resource, last good, moved to when each episode streams (streamView)
    raw: null,        // the same as the Pi sent it (kept in the cache)
    fromCache: false,
    tab: 'week',
    soonSeen: {},
    focusKey: null,   // where focus goes on the next drawing (after a "Did you finish?" answer)
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
  function whenText(ms, t, dayOnly) {
    var d0 = dayStart(t);
    if (dayOnly) {
      if (ms >= d0 && ms < addDays(d0, 1)) return word('todayMark');
      return ms < addDays(d0, 7) ? dayName(ms, true) : dayDate(ms);
    }
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

  /* ---------- when an episode can be watched ---------- */

  // TVmaze dates an episode by its first broadcast: FOX at 7 PM, Channel 4 in
  // the UK. When that channel is not a streaming app, the episode reaches the
  // show's app later, so the schedule lists it on the day it streams and says
  // where it airs live. How much later: widgets.entertainment.streamAfterAir
  // in config.js, per show (by name) and then per app, else the next day.
  // A rule is { days: 1 } (that many days after the broadcast's local day),
  // { weekday: 'fri' } (the first Friday after it), either with at: '02:00'
  // when the hour is known (without it the day alone is shown), or
  // { live: true } (watched as it airs: no change).
  var DEFAULT_STREAM = { days: 1 };
  var WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  // True when the channel is a streaming app itself ("Netflix", "FX on Hulu"):
  // its airstamp is already when it streams.
  function channelStreams(channel) {
    if (!channel) return true;
    var c = ' ' + String(channel).toLowerCase().replace(/[^a-z0-9+]+/g, ' ') + ' ';
    for (var k in SERVICES) {
      if (!SERVICES.hasOwnProperty(k)) continue;
      var m = SERVICES[k].match.concat([k]);
      for (var i = 0; i < m.length; i++) {
        var w = ' ' + m[i].toLowerCase().replace(/[^a-z0-9+]+/g, ' ') + ' ';
        if (c.indexOf(w) >= 0) return true;
      }
    }
    return false;
  }

  function streamRule(show) {
    var c = S.C && S.C.config;
    var cfg = c && c.streamAfterAir && typeof c.streamAfterAir === 'object' ? c.streamAfterAir : {};
    var byShow = cfg.shows && typeof cfg.shows === 'object' ? cfg.shows : {};
    var byApp = cfg.apps && typeof cfg.apps === 'object' ? cfg.apps : {};
    var name = String((show && show.name) || '').toLowerCase();
    for (var k in byShow) if (byShow.hasOwnProperty(k) && k.toLowerCase() === name && byShow[k]) return byShow[k];
    var app = watchApp(show);
    if (app && byApp.hasOwnProperty(app) && byApp[app]) return byApp[app];
    var own = (show && (show.watch || show.service)) || '';
    if (own && byApp.hasOwnProperty(own) && byApp[own]) return byApp[own];
    return DEFAULT_STREAM;
  }

  // When an episode can be watched in the show's app:
  // { ms, dayOnly, airMs, airedOn } (airedOn '' when the airstamp already is
  // the streaming time). null without a time. Works on the Pi's episodes as
  // they come (the show page's full list too).
  function streamTime(show, ep) {
    var airMs = parseIso(ep && (ep.airedAt || ep.airstamp));
    if (airMs === null) return null;
    var channel = (show && show.channel) || '';
    var rule = channelStreams(channel) ? null : streamRule(show);
    if (!rule || rule.live === true) return { ms: airMs, dayOnly: false, airMs: airMs, airedOn: '' };
    var day = dayStart(airMs);
    var wd = typeof rule.weekday === 'string' ? WEEKDAYS[rule.weekday.slice(0, 3).toLowerCase()] : undefined;
    if (typeof wd === 'number') {
      day = addDays(day, 1);
      while (new Date(day).getDay() !== wd) day = addDays(day, 1);
    } else {
      var n = typeof rule.days === 'number' && rule.days >= 0 && rule.days <= 30 ? Math.round(rule.days) : 1;
      day = addDays(day, n);
    }
    var at = typeof rule.at === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(rule.at) : null;
    if (at && +at[1] < 24 && +at[2] < 60) {
      var d = new Date(day);
      d.setHours(+at[1], +at[2], 0, 0);
      return { ms: d.getTime(), dayOnly: false, airMs: airMs, airedOn: channel };
    }
    return { ms: day, dayOnly: true, airMs: airMs, airedOn: channel };
  }

  function isoOf(ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); }

  // The Pi's data with every episode moved to when it streams (the original
  // kept as airedAt, dayOnly when only the day is known). The rest of the
  // Schedule reads airstamp, so it all follows.
  function streamView(d) {
    if (!validData(d)) return d;
    var out;
    try { out = JSON.parse(JSON.stringify(d)); } catch (e) { return d; }
    function move(show, ep) {
      if (!ep || typeof ep !== 'object' || ep.airedAt) return;
      var st = streamTime(show, ep);
      if (!st || !st.airedOn) return;
      ep.airedAt = ep.airstamp;
      ep.airstamp = isoOf(st.ms);
      if (st.dayOnly) ep.dayOnly = true;
    }
    for (var i = 0; i < out.shows.length; i++) {
      var s = out.shows[i];
      if (!s || typeof s !== 'object') continue;
      if (isArr(s.upcoming)) for (var j = 0; j < s.upcoming.length; j++) move(s, s.upcoming[j]);
      move(s, s.nextEpisode);
      var r = s.returning;
      if (r && typeof r === 'object' && r.airstamp) {
        move(s, r);
        if (r.airedAt) {
          var rd = new Date(parseIso(r.airstamp));
          r.date = rd.getFullYear() + '-' + pad(rd.getMonth() + 1) + '-' + pad(rd.getDate());
        }
      }
    }
    return out;
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

  // Watched as the Pi says, unless a mark from this TV is still on its way
  // (then that wins, so a row answers at once). show may be left out.
  function epWatched(show, ep) {
    if (!ep) return false;
    if (show && typeof ep.season === 'number' && typeof ep.number === 'number') {
      var p = pendingMark(show.id, ep.season, ep.number);
      if (p) return p === 'watched';
    }
    return ep.watched === true;
  }

  // The same for an episode named by numbers (it may be gone from upcoming: then the Pi's watched list says).
  function isWatchedEp(show, season, number) {
    var p = pendingMark(show.id, season, number);
    if (p) return p === 'watched';
    var eps = (isArr(show.upcoming) ? show.upcoming : []).concat(show.nextEpisode ? [show.nextEpisode] : []);
    for (var i = 0; i < eps.length; i++) if (eps[i] && eps[i].season === season && eps[i].number === number && eps[i].watched === true) return true;
    var w = isArr(show.watched) ? show.watched : [];
    for (var j = 0; j < w.length; j++) if (w[j] && w[j].season === season && w[j].number === number) return true;
    return false;
  }

  // True when every episode of a row is marked watched.
  function rowWatched(a) {
    if (!a || !isArr(a.eps) || !a.eps.length) return false;
    for (var i = 0; i < a.eps.length; i++) if (!epWatched(a.show, a.eps[i])) return false;
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
    var all = airings(d, dayStart(t), addDays(dayStart(t), 1));
    var list = [];
    var fresh = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].eps[0].dayOnly) { if (!fresh && !rowWatched(all[i])) fresh = all[i]; }
      else if (all[i].ms >= t - 30 * MIN) list.push(all[i]);
    }
    if (!list.length) return fresh ? word('newToday', { name: fresh.show.name }) : '';
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
        host.launchControl(link, function (err) { if (err) openApp(); else noteStarted(show, eps); });
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
        noteStarted(show, eps);
      });
      return 'app';
    }
  }

  /* ---------- watched: the started list, "Did you finish?" and the marks ---------- */

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
      if (ms === null || ms > t + 5 * MIN || epWatched(show, ep)) continue;
      if (typeof ep.season !== 'number' || typeof ep.number !== 'number') continue;
      if (best === null || ms < bestMs) { best = ep; bestMs = ms; }
    }
    return best;
  }

  // The started list (homeHub.watch.v1): [{ showId, season, number, startedAt }].
  function loadStarted() {
    var list = null;
    try { list = JSON.parse(load(WATCH_KEY) || '[]'); } catch (e) { list = null; }
    var out = [];
    if (!isArr(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && typeof r.showId === 'string' && typeof r.season === 'number' && typeof r.number === 'number' && typeof r.startedAt === 'number') {
        out.push({ showId: r.showId, season: r.season, number: r.number, startedAt: r.startedAt });
      }
    }
    return out;
  }

  function saveStarted(list) {
    store(WATCH_KEY, JSON.stringify(list));
  }

  function sameEp(a, b) { return a.showId === b.showId && a.season === b.season && a.number === b.number; }

  // OK opened an app for this show: remember the episode as started. Nothing
  // else happens: no timer, no question. The same episode twice is one entry
  // (the newest press); at most FINISH_MAX are kept, the oldest go first.
  // Returns the entry, or null (nothing to remember).
  function noteStarted(show, eps) {
    if (!show) return null;
    var t = now();
    var ep = pickEpisode(show, eps, t);
    if (!ep) return null;
    var rec = { showId: show.id, season: ep.season, number: ep.number, startedAt: t };
    var list = loadStarted();
    var out = [];
    for (var i = 0; i < list.length; i++) if (!sameEp(list[i], rec) && t - list[i].startedAt < FINISH_KEEP) out.push(list[i]);
    out.push(rec);
    out.sort(function (a, b) { return a.startedAt - b.startedAt; });
    saveStarted(out.slice(-FINISH_MAX));
    changed();
    return rec;
  }

  function nameKey(name) {
    return String(name || '').toLowerCase().replace(/^\s*the\s+/, '');
  }

  // The lines of "Did you finish?": started episodes waiting for an answer,
  // newest 7 days only, minus the ones the Pi already has as watched, sorted
  // by show title (case-insensitive, a leading "The " ignored), then season
  // and episode. [{ rec, show }]. Dropped ones are forgotten for good.
  function finishLines(t) {
    var all = loadStarted();
    var keep = [];
    var lines = [];
    var valid = validData(S.data);
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (t - r.startedAt >= FINISH_KEEP) continue;
      var show = valid ? findShow(r.showId) : null;
      if (show && isWatchedEp(show, r.season, r.number)) continue;
      keep.push(r);
      if (show) lines.push({ rec: r, show: show });
    }
    keep.sort(function (a, b) { return a.startedAt - b.startedAt; });
    keep = keep.slice(-FINISH_MAX);
    if (keep.length !== all.length) saveStarted(keep);
    lines.sort(function (a, b) {
      var x = nameKey(a.show.name);
      var y = nameKey(b.show.name);
      if (x !== y) return x < y ? -1 : 1;
      return (a.rec.season - b.rec.season) || (a.rec.number - b.rec.number) || (a.rec.startedAt - b.rec.startedAt);
    });
    return lines.slice(0, FINISH_MAX);
  }

  function toCheck() {
    return S.data && state() === 'data' ? finishLines(now()).length : 0;
  }

  // "started last night", "started Tue": when an episode was started, as a person says it.
  function startedText(ms, t) {
    var diff = Math.round((dayStart(t) - dayStart(ms)) / DAY);
    var h = new Date(ms).getHours();
    var when = '';
    if (diff <= 0) when = word(h < 5 ? 'startedLastNight' : h >= 17 ? 'startedTonight' : 'startedToday');
    else if (diff === 1) when = word(h >= 17 ? 'startedLastNight' : 'startedYesterday');
    else return word('startedOn', { day: lang() === 'es' ? dayName(ms, false).toLowerCase() : dayName(ms, true) });   // "started Tue", "empezó el martes"
    return word('started', { when: when });
  }

  /* The marks waiting for the Pi (homeHub.watch.out.v1): [{ op, showId,
     season, number }], op 'watched' or 'unwatch'. Kept until the Pi has
     them, tried again on every minute, when the hub is back on screen and
     when the Pi answers again; dropped when the Pi refuses (the show is
     gone). Until then the Schedule shows them as already done. */
  var O = { list: null, sending: {} };

  function loadOut() {
    if (O.list) return O.list;
    var list = null;
    try { list = JSON.parse(load(OUT_KEY) || '[]'); } catch (e) { list = null; }
    O.list = [];
    if (isArr(list)) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r && (r.op === 'watched' || r.op === 'unwatch') && typeof r.showId === 'string' && typeof r.season === 'number' && typeof r.number === 'number') {
          O.list.push({ op: r.op, showId: r.showId, season: r.season, number: r.number });
        }
      }
    }
    return O.list;
  }

  function saveOut(list) {
    O.list = list;
    store(OUT_KEY, JSON.stringify(list));
  }

  function outKey(r) { return r.showId + '|' + r.season + '|' + r.number; }

  // 'watched', 'unwatch' or '' for an episode with a mark still on its way.
  function pendingMark(showId, season, number) {
    var list = loadOut();
    for (var i = 0; i < list.length; i++) {
      if (list[i].showId === showId && list[i].season === season && list[i].number === number) return list[i].op;
    }
    return '';
  }

  function queueMark(op, showId, season, number) {
    var rec = { op: op, showId: showId, season: season, number: number };
    var out = [];
    var list = loadOut();
    for (var i = 0; i < list.length; i++) if (outKey(list[i]) !== outKey(rec)) out.push(list[i]);
    out.push(rec);
    saveOut(out.slice(-60));
    flushOut();
  }

  function removeOut(rec) {
    var out = [];
    var list = loadOut();
    for (var i = 0; i < list.length; i++) if (!(outKey(list[i]) === outKey(rec) && list[i].op === rec.op)) out.push(list[i]);
    saveOut(out);
  }

  // Puts a mark into the copy of the Pi's data this TV holds, so the row
  // shows it before the Pi's own update arrives.
  function applyMark(rec) {
    var show = validData(S.data) ? findShow(rec.showId) : null;
    if (!show) return;
    var on = rec.op === 'watched';
    var eps = (isArr(show.upcoming) ? show.upcoming : []).concat(show.nextEpisode ? [show.nextEpisode] : []);
    for (var i = 0; i < eps.length; i++) {
      if (eps[i] && eps[i].season === rec.season && eps[i].number === rec.number) { if (on) eps[i].watched = true; else delete eps[i].watched; }
    }
    var w = isArr(show.watched) ? show.watched : [];
    var out = [];
    for (var j = 0; j < w.length; j++) if (!(w[j].season === rec.season && w[j].number === rec.number)) out.push(w[j]);
    if (on) out.push({ season: rec.season, number: rec.number, at: new Date(now()).toISOString() });
    show.watched = out;
    saveCache();
  }

  // Tells the Pi about every mark waiting: POST /shows/watched or
  // /shows/unwatch (the screen's own doors, no token). Quiet always.
  function flushOut() {
    var Lv = S.C && S.C.live;
    if (!Lv || typeof Lv.post !== 'function') return;
    var list = loadOut().slice();
    for (var i = 0; i < list.length; i++) sendMark(Lv, list[i]);
  }

  function sendMark(Lv, rec) {
    var k = outKey(rec) + rec.op;
    if (O.sending[k]) return;
    O.sending[k] = true;
    try {
      Lv.post(rec.op === 'watched' ? '/shows/watched' : '/shows/unwatch', { id: rec.showId, season: rec.season, number: rec.number }, function (err, data, code) {
        O.sending[k] = false;
        // Kept for the next try while the Pi can't be reached; dropped when it refuses.
        if (!err || code === 400 || code === 404) {
          removeOut(rec);
          if (!err) applyMark(rec);
          changed();
        }
      });
    } catch (e) { O.sending[k] = false; warn('telling the Pi', e); }
  }

  // The marks for the episodes of a row: all not watched yet when any is
  // not, else all watched ones come off. Returns the marks queued.
  function toggleRow(show, eps, t) {
    var numbered = [];
    for (var i = 0; i < eps.length; i++) {
      var ms = parseIso(eps[i].airstamp);
      if (ms !== null && ms <= t + 5 * MIN && typeof eps[i].season === 'number' && typeof eps[i].number === 'number') numbered.push(eps[i]);
    }
    var allSeen = numbered.length > 0;
    for (var j = 0; j < numbered.length; j++) if (!epWatched(show, numbered[j])) allSeen = false;
    var n = 0;
    for (var k = 0; k < numbered.length; k++) {
      if (allSeen === epWatched(show, numbered[k])) { queueMark(allSeen ? 'unwatch' : 'watched', show.id, numbered[k].season, numbered[k].number); n++; }
    }
    return allSeen ? -n : n;
  }

  // Answers one line of "Did you finish?". key: showId:season:number.
  function answerFinish(yes, showId, season, number) {
    var t = now();
    var lines = finishLines(t);
    var at = -1;
    for (var i = 0; i < lines.length; i++) if (lines[i].rec.showId === showId && lines[i].rec.season === season && lines[i].rec.number === number) at = i;
    if (at < 0) return;
    // Focus goes to the next line's Watched, or the one before when this was the last.
    var to = lines[at + 1] || lines[at - 1] || null;
    S.focusKey = to ? finKey('yes', to.rec) : null;
    var rec = lines[at].rec;
    var left = [];
    var all = loadStarted();
    for (var j = 0; j < all.length; j++) if (!sameEp(all[j], rec)) left.push(all[j]);
    saveStarted(left);
    if (yes) queueMark('watched', rec.showId, rec.season, rec.number);
    changed();
  }

  function finKey(which, rec) { return 'sh:fin:' + which + ':' + rec.showId + ':' + rec.season + ':' + rec.number; }

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
      if (validData(d)) { S.raw = d; S.data = streamView(d); S.fromCache = true; }
    } catch (e) { /* none */ }
  }

  function saveCache() {
    try { store(CACHE_KEY, JSON.stringify(S.raw)); } catch (e) { /* not kept */ }
  }

  function onData(d) {
    if (!validData(d)) return;
    var before = S.raw ? JSON.stringify(S.raw.shows) : null;
    S.raw = d;
    S.data = streamView(d);
    S.fromCache = false;
    saveCache();
    changed(before !== null && before !== JSON.stringify(d.shows));
    flushOut();
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
      if (S.soonSeen[k] || list[i].eps[0].dayOnly) continue;
      S.soonSeen[k] = true;
      try { C.accent('soon'); } catch (e) { /* it just shows */ }
    }
  }

  // Once a minute: "in 25 min", the accent edge and the tile's line move on.
  function schedule() {
    clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      try { changed(); } catch (e) { warn('the minute update', e); }
      try { flushOut(); } catch (e) { warn('telling the Pi', e); }
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
    var dayOnly = !!a.eps[0].dayOnly;
    var airMs = parseIso(a.eps[0].airedAt);
    var soon = !dayOnly && a.ms > t - 5 * MIN && a.ms - t <= HOUR;
    var on = !dayOnly && a.ms <= t && a.ms > t - 5 * MIN;
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
    var bits = epCode(a.eps) + ' · ' + (dayOnly ? word('streamsOn', { service: app || a.show.service || '' }) : timeText(a.ms));
    el('span', 'sh-meta-text', meta, bits);
    if (seen) {
      var wn = el('span', 'sh-note is-watched', meta);
      el('span', 'sh-check', wn);
      el('span', 'sh-note-text', wn, word('watched'));
    } else if (past) el('span', 'sh-note', meta, word(airMs !== null ? 'out' : 'aired'));
    else if (on) el('span', 'sh-note is-live', meta, word('now'));
    else if (soon) el('span', 'sh-note is-live', meta, word('inMin', { n: Math.max(1, Math.round((a.ms - t) / MIN)) }));
    if (a.eps[0].number === 1 && !past) el('span', 'sh-chip', meta, word('premiere'));
    var via = viaApp(a.show, app);
    if (via) el('span', 'sh-via', meta, word('via', { service: via }));
    if (airMs !== null && a.show.channel) {
      // Where it airs live, under the line: "Airs live on FOX · Thu 7 PM".
      el('div', 'sh-air', info, word(airMs > t ? 'airsLive' : 'airedLive', { channel: a.show.channel, when: dayName(airMs, true) + ' ' + timeText(airMs, true) }));
    }
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
    if (markable(a, t)) {
      // A small check toggle at the end of an aired row, after "Also on": OK marks the episode
      // watched, or takes the mark off.
      var mk = el('div', 'sh-mark f' + (seen ? ' is-on' : '') + (past ? ' is-past' : ''), line);
      mk.setAttribute('data-key', 'sh:mark:' + a.show.id + ':' + a.ms);
      mk.setAttribute('role', 'checkbox');
      mk.setAttribute('aria-checked', seen ? 'true' : 'false');
      var box = el('span', 'sh-mark-box', mk);
      el('span', 'sh-check', box);
      el('span', 'sh-mark-text', mk, word(seen ? 'unmark' : 'markWatched'));
    }
    return row;
  }

  // An aired row with episode numbers can be marked (a special has none).
  function markable(a, t) {
    for (var i = 0; i < a.eps.length; i++) {
      var ms = parseIso(a.eps[i].airstamp);
      if (ms !== null && ms <= t + 5 * MIN && typeof a.eps[i].season === 'number' && typeof a.eps[i].number === 'number') return true;
    }
    return false;
  }

  // "Did you finish?": the episodes started from here and not answered yet.
  function drawFinish(parent, lines, t) {
    var box = el('div', 'sh-fin', parent);
    el('div', 'sh-fin-head', box, word('finishTitle'));
    for (var i = 0; i < lines.length; i++) {
      var r = lines[i].rec;
      var line = el('div', 'sh-fin-line', box);
      var text = el('div', 'sh-fin-text', line);
      el('span', 'sh-fin-name', text, lines[i].show.name);
      el('span', 'sh-fin-meta', text, ' · ' + word('code', { s: r.season, e: r.number }) + ' · ' + startedText(r.startedAt, t));
      var btns = el('div', 'sh-fin-btns', line);
      var yes = el('div', 'sh-fin-btn f', btns, word('finishWatched'));
      yes.setAttribute('data-key', finKey('yes', r));
      var no = el('div', 'sh-fin-btn f', btns, word('finishNotYet'));
      no.setAttribute('data-key', finKey('no', r));
    }
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
      if (next) line = word('nextLine', { code: epCode([next.ep]), when: whenText(next.ms, t, next.ep.dayOnly) });
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
      if (ms !== null && (ms > t - 30 * MIN || (ups[i].dayOnly && ms >= dayStart(t)))) return { ep: ups[i], ms: ms };
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
    var lines = finishLines(t);
    if (lines.length) drawFinish(root, lines, t);
    if (v.tab === 'soon') {
      drawSoonView(root, v, t);
    } else if (!v.groups.length) {
      var e = el('div', 'sh-empty', root, word(v.tab === 'today' ? 'nothingToday' : v.tab === 'month' ? 'nothingMonth' : 'nothingWeek'));
      var nx = nextAiring(S.data, t);
      if (nx) el('div', 'sh-empty-next', e, word('nextAiring', { name: nx.show.name, when: whenText(nx.ms, t, nx.eps[0].dayOnly) }));
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
    // After an answer in "Did you finish?": the next line's Watched. Opening
    // the Schedule with lines waiting: the first line's Watched.
    var fins = root.querySelectorAll('.sh-fin-btn');
    var want = null;
    for (var f = 0; f < fins.length; f++) {
      if (S.focusKey && fins[f].getAttribute('data-key') === S.focusKey) want = fins[f];
    }
    S.focusKey = null;
    if (!want && fins.length) want = fins[0];
    if (want) pick = want;
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
    if (p[1] === 'fin') {
      answerFinish(p[2] === 'yes', p[3], Number(p[4]), Number(p[5]));
      return true;
    }
    var show = findShow(p[2]);
    if (!show) return true;
    var eps = [];
    if (p[1] === 'row' || p[1] === 'alt' || p[1] === 'mark') {
      var ms = Number(p[3]);
      var ups = isArr(show.upcoming) ? show.upcoming : [];
      for (var i = 0; i < ups.length; i++) if (parseIso(ups[i].airstamp) === ms) eps.push(ups[i]);
    }
    if (p[1] === 'mark') {
      toggleRow(show, eps, now());
      changed();
      return true;
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
    // Back in front after an app, and shortly after start: marks the Pi has not heard yet.
    try { document.addEventListener('visibilitychange', function () { if (!document.hidden) flushOut(); }, false); } catch (e) { /* the minute tick still looks */ }
    setTimeout(function () { try { flushOut(); } catch (e) { warn('telling the Pi', e); } }, 4000);
  }

  window.HUB_SHOWS = {
    STRINGS: STRINGS,
    SERVICES: SERVICES,
    // When an episode (as the Pi sends it) can be watched in the show's app:
    // { ms, dayOnly, airMs, airedOn }; see "when an episode can be watched".
    streamTime: function (show, ep) { try { return streamTime(show, ep); } catch (e) { warn('a streaming time', e); return null; } },
    attach: attach,
    onChange: function (fn) { if (typeof fn === 'function') S.listeners.push(fn); },
    title: function () { return word('title'); },
    entry: function () { var n = toCheck(); return { label: word('entry'), sub: n ? word('toCheck', { n: n }) : word('entrySub') }; },
    toCheck: toCheck,
    checkText: function () { var n = toCheck(); return n ? word('toCheck', { n: n }) : ''; },
    tileLine: function () { return S.data && state() === 'data' ? tileLine(S.data, now()) : ''; },
    availability: function () { return S.data && state() === 'data' ? availability(S.data, now()) : {}; },
    renderPanel: renderPanel,
    onSelect: onSelect,
    state: state,
    // For the tests (dev/shows-test.js): the pure parts and the state.
    _test: {
      view: view, airings: airings, groupByDay: groupByDay, returning: returning, tileLine: tileLine,
      noteStarted: noteStarted, started: loadStarted, finishLines: finishLines, startedText: startedText, rowWatched: rowWatched, pendingOut: function () { return loadOut().slice(); }, flushOut: flushOut,
      ladder: ladder, watch: watch, watchApp: watchApp, viaApp: viaApp, alternatives: alternatives, availability: availability, timeText: timeText, epCode: epCode, rangeText: rangeText, word: word,
      weekStart: weekStart, monthEnd: monthEnd, setData: function (d) { S.raw = d; S.data = streamView(d); S.fromCache = false; changed(); }, streamView: streamView, channelStreams: channelStreams,
      tab: function (t) { if (t) S.tab = t; return S.tab; }
    }
  };
})();
