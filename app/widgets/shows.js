/*
 * Schedule: the TV shows on the owner's list, inside the Entertainment
 * panel (OK on "Schedule" there). The list and the episodes come from the
 * hub server on the Pi (the resource "shows", pi/shows.js, contract in
 * docs/shows-snapshot.md); times arrive in UTC and are shown in this TV's
 * own time zone, 12 or 24 hours like the Clock tile.
 *
 * Four views: Today, This week (Monday to Sunday, the days gone dimmed),
 * This month (today to the month's end) and Coming soon ("Ready to watch":
 * shows started and behind, with how many episodes are out and not marked;
 * then seasons coming back, and every show marked still running or ended,
 * each with its show page chip). The Coming soon tab carries how many shows
 * are ready to watch. OK on an episode
 * opens its app ("Watch on Hulu"), through a ladder per service: a deep link
 * when one is known (none yet; the watch link test in the About panel is
 * finding out which work), otherwise the app itself and a toast saying what
 * to search for. On the tablet (no service.js) the Pi opens the app on the
 * TV (host.launch with the show's title and link); once it has the request, a
 * "Go to: <title>" card says what to look for there, until a tap (30 s).
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
  var EPS_KEY = 'homeHub.showEps.v1.';       // a show page's episode list, per show id (kept for at most EPS_KEEP shows)
  var EPS_INDEX = 'homeHub.showEps.index.v1';
  var EPS_KEEP = 6;
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
    readyHead: 'Ready to watch',
    readyAll: 'Season {s} · all {n} out',
    readyOne: 'Season {s} is out',
    readyPart: 'Season {s} · {out} of {total} out',
    readySeasons: 'Seasons {a}–{b}',
    readyNext: 'Up next: {code}',
    toWatch: 'to watch',
    nToWatch: '{n} to watch',
    running: 'Still running',
    ended: 'Ended',
    tbd: 'Still running · undecided',
    nextLine: 'Next: {code} · {when}',
    nothingToday: 'Nothing airs today.',
    nothingWeek: 'Nothing airs this week.',
    nothingMonth: 'Nothing more airs this month.',
    nothingSoon: 'Nothing with a date yet.',
    nextAiring: 'Next up: {name} · {when}',
    tonight: 'Tonight: {name} {time}',
    todayLine: 'Today: {name} {time}',
    opensHome: '{service} opens on its home screen',
    searchFor: 'Search for: {name}',
    goTo: 'Go to: {name}',
    goToLine: 'Find it in {service} on the TV. Tap to close.',
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
    markUpTo: 'Mark as up to date',
    showPage: 'Show page',
    seasonsN: '{n} seasons',
    seasonsOne: '1 season',
    seasonLine: 'Season {s} · {w} of {n} watched',
    allLine: 'All {n} episodes watched',
    watchNext: 'Watch {code}',
    pgNoEps: 'No episodes listed yet',
    pgNoEpsLine: 'Date not announced yet. The list fills in once it is.',
    pgOpen: 'Open {service}',
    caughtUp: 'I’m caught up',
    seenAll: 'I’ve seen it all',
    caughtDone: 'You’re caught up',
    seenDone: 'Seen it all',
    seasonPill: 'S{s}',
    epNum: 'E{e}',
    upToHere: 'Watched up to here',
    airedOn: 'Aired {d}',
    airsOn: 'Airs {d}',
    pgDate: '{mon} {d}',
    pgDateYear: '{date}, {year}',
    minutes: '{n} min',
    partial: 'Only recent episodes so far',
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
      pageLost: { head: 'Can’t reach the Pi', line: 'The episode list fills in as soon as the Pi answers again.' },
      pageOld: { head: 'Show page needs a newer Pi', line: 'The hub server on the Pi doesn’t send episode lists yet. Update it (pi/README.md), then restart it.' },
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

  var LIST_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.5" cy="7" r="0.6" fill="currentColor"/><circle cx="4.5" cy="12" r="0.6" fill="currentColor"/><circle cx="4.5" cy="17" r="0.6" fill="currentColor"/></svg>';

  var POSTER_COLORS = ['#26404a', '#4a2630', '#2f3a52', '#4a3b22', '#2d4632', '#3e2e4f', '#4b3226', '#24424a'];

  var S = {
    C: null,          // the Entertainment widget's ctx
    host: null,       // { findApp(match), appsReady(), launch(id, label), matchFor(label) }
    data: null,       // the shows resource, last good, moved to when each episode streams (streamView)
    raw: null,        // the same as the Pi sent it (kept in the cache)
    fromCache: false,
    tab: 'week',
    soonSeen: {},
    page: null,       // the open show page: { id, season, inEp, back }
    backKey: null,    // the page chip focus returns to when the show page closes
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

  // Is (season, number) inside a watched-up-to point { season, number }?
  function coversUp(up, season, number) {
    if (!up || typeof up.season !== 'number' || typeof up.number !== 'number') return false;
    if (typeof season !== 'number' || typeof number !== 'number') return false;
    return season < up.season || (season === up.season && number <= up.number);
  }

  function inPairs(list, season, number) {
    if (!isArr(list)) return false;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].season === season && list[i].number === number) return true;
    return false;
  }

  // Watched as the Pi says, unless a mark from this TV is still on its way
  // (then that wins, so a row answers at once). show may be left out.
  function epWatched(show, ep) {
    if (!ep) return false;
    if (show && typeof ep.season === 'number' && typeof ep.number === 'number') {
      var p = pendingMark(show.id, ep.season, ep.number, parseIso(ep.airstamp));
      if (p) return p === 'watched';
      if (ep.watched === true) return true;
      return baseWatched(show, ep.season, ep.number);
    }
    return ep.watched === true;
  }

  // The Pi's answer for an episode named by numbers, from the snapshot's lists
  // and its progress (up to here, minus the exceptions inside it).
  function baseWatched(show, season, number) {
    if (inPairs(show.watched, season, number)) return true;
    var pr = show.progress;
    if (pr && typeof pr === 'object' && coversUp(pr.upTo, season, number) && !inPairs(pr.unwatched, season, number)) return true;
    return false;
  }

  function snapEps(show) {
    return (isArr(show.upcoming) ? show.upcoming : []).concat(show.nextEpisode ? [show.nextEpisode] : []);
  }

  // The same for an episode named by numbers (it may be gone from upcoming: then the Pi's watched list and progress say).
  function isWatchedEp(show, season, number) {
    var eps = snapEps(show);
    var air = null;
    for (var i = 0; i < eps.length; i++) {
      if (eps[i] && eps[i].season === season && eps[i].number === number) {
        if (air === null) air = parseIso(eps[i].airstamp);
        if (eps[i].watched === true && !pendingMark(show.id, season, number, air)) return true;
      }
    }
    var p = pendingMark(show.id, season, number, air);
    if (p) return p === 'watched';
    return baseWatched(show, season, number);
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

  // The Coming soon tab: every show with a date ahead, soonest first. A show's
  // next episode (as Your shows says it), or else its dated new season. Shows
  // with no date yet are not coming soon: they stay in Your shows, where
  // their row says "Season 3 · no date yet".
  function comingSoon(d, t) {
    var out = [];
    var back = returning(d, t);
    var list = showsOf(d);
    for (var i = 0; i < list.length; i++) {
      var next = nextFor(list[i], t);
      var ret = null;
      for (var j = 0; j < back.length; j++) if (back[j].show === list[i] && back[j].ms !== null) ret = back[j];
      if (next && (!ret || next.ms <= ret.ms)) {
        out.push({ show: list[i], ms: next.ms, ep: next.ep, season: next.ep.season, days: Math.round((dayStart(next.ms) - dayStart(t)) / DAY) });
      } else if (ret) out.push(ret);
    }
    out.sort(function (a, b) { return (a.ms - b.ms) || (a.show.name < b.show.name ? -1 : 1); });
    return out;
  }

  // A show's undated return ("Season 3 · no date yet"), or null.
  function undatedFor(d, s, t) {
    var back = returning(d, t);
    for (var i = 0; i < back.length; i++) if (back[i].show === s && back[i].ms === null) return back[i];
    return null;
  }

  // Shows started and not caught up, with aired episodes not marked watched
  // ("Ready to watch" on Coming soon): [{ show, n, left, next }], by title.
  // Started = a "watched up to" point or any episode marked; a show never
  // touched is not listed (a long-running show would say "300 to watch").
  // left is the Pi's per-season counts (progress.left, server 0.17.0);
  // an older Pi sends none, and then only the total and the next episode show.
  function readyList(d) {
    var out = [];
    var list = showsOf(d);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var pr = s.progress;
      if (!pr || typeof pr !== 'object' || pr.caughtUp === true) continue;
      var started = !!pr.upTo || pr.seen > 0 || (isArr(s.watched) && s.watched.length > 0);
      if (!started) continue;
      var left = [];
      var n = 0;
      var raw = isArr(pr.left) ? pr.left : [];
      for (var j = 0; j < raw.length; j++) {
        var x = raw[j];
        if (x && typeof x.season === 'number' && typeof x.unseen === 'number' && x.unseen > 0) { left.push(x); n += x.unseen; }
      }
      if (!left.length) n = Math.max(0, (pr.aired || 0) - (pr.seen || 0));
      if (n <= 0) continue;
      out.push({ show: s, n: n, left: left, next: pr.next && typeof pr.next.season === 'number' ? pr.next : null });
    }
    out.sort(function (a, b) {
      var x = nameKey(a.show.name);
      var y = nameKey(b.show.name);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return out;
  }

  function readyFor(d, id) {
    var list = readyList(d);
    for (var i = 0; i < list.length; i++) if (list[i].show.id === id) return list[i];
    return null;
  }

  // "Season 2 · all 12 out", "Season 5 · 4 of 6 out", "Seasons 4–5".
  function readyText(r) {
    if (!r.left.length) return '';
    if (r.left.length > 1) return word('readySeasons', { a: r.left[0].season, b: r.left[r.left.length - 1].season });
    var l = r.left[0];
    if (typeof l.total === 'number' && typeof l.out === 'number' && l.out < l.total) return word('readyPart', { s: l.season, out: l.out, total: l.total });
    if (l.out === 1) return word('readyOne', { s: l.season });
    return word('readyAll', { s: l.season, n: l.out });
  }

  // What a view shows: { tab, range, groups, empty, soon }.
  function view(d, tab, t) {
    var from = dayStart(t);
    var to;
    var range;
    if (tab === 'today') { to = addDays(from, 1); range = longDay(t); }
    else if (tab === 'month') { to = monthEnd(t); range = monthTitle(t); }
    else if (tab === 'soon') { return { tab: tab, range: '', groups: [], soon: comingSoon(d, t), shows: showsOf(d), ready: readyList(d) }; }
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
  // for the tests: 'deeplink', 'app', 'tv' (tablet: the Pi opens it), 'missing', 'noservice' or 'waiting'.
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
      // Tablet: the Pi opens it on the TV; then the show's title to look for.
      if (typeof host.onTv === 'function' && host.onTv()) {
        host.launch(app.id, service, { title: show.name, link: typeof show.link === 'string' ? show.link : '' }, function (err) {
          if (!err) goToCard(show.name, service);
        });
        noteStarted(show, eps);
        return 'tv';
      }
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
        if (!r || typeof r.showId !== 'string') continue;
        if (r.op === 'caughtup') O.list.push({ op: r.op, showId: r.showId });
        else if ((r.op === 'watched' || r.op === 'unwatch' || r.op === 'upto') && typeof r.season === 'number' && typeof r.number === 'number') {
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

  function outKey(r) { return r.op === 'caughtup' ? r.showId + '|caughtup' : r.showId + '|' + r.season + '|' + r.number; }

  // 'watched', 'unwatch' or '' for an episode with a mark still on its way,
  // in the order the marks were made: a single mark on it, a "watched up to
  // here" at or after it, or "caught up" when it has aired (airMs).
  function pendingMark(showId, season, number, airMs) {
    var list = loadOut();
    var res = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.showId !== showId) continue;
      if (r.op === 'caughtup') { if (typeof airMs === 'number' && airMs <= now() + 5 * MIN) res = 'watched'; }
      else if (r.season === season && r.number === number) res = r.op === 'unwatch' ? 'unwatch' : 'watched';
      else if (r.op === 'upto' && coversUp(r, season, number)) res = 'watched';
    }
    return res;
  }

  // op: watched, unwatch, upto (season and number) or caughtup (neither).
  function queueMark(op, showId, season, number) {
    var rec = op === 'caughtup' ? { op: op, showId: showId } : { op: op, showId: showId, season: season, number: number };
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

  // The latest numbered episode that has aired, from the snapshot and the
  // show page's list: { season, number } or null.
  function latestAired(showId, show) {
    var best = null;
    var t = now() + 5 * MIN;
    function see(e) {
      var ms = parseIso(e && e.airstamp);
      if (ms === null || ms > t || typeof e.season !== 'number' || typeof e.number !== 'number') return;
      if (!best || e.season > best.season || (e.season === best.season && e.number > best.number)) best = { season: e.season, number: e.number };
    }
    var list = show ? snapEps(show) : [];
    for (var i = 0; i < list.length; i++) see(list[i]);
    var d = epsGet(showId);
    var fl = d ? flatEps(d) : [];
    for (var j = 0; j < fl.length; j++) see(fl[j]);
    return best;
  }

  function isoNow() { return new Date(now()).toISOString(); }

  // A mark in the copy of the Pi's data this TV holds (the snapshot's show):
  // op watched, unwatch or upto.
  function applyToShow(show, op, season, number) {
    var pr = show.progress && typeof show.progress === 'object' ? show.progress : null;
    var eps = snapEps(show);
    var w = isArr(show.watched) ? show.watched : [];
    var i;
    if (op === 'upto') {
      var up = { season: season, number: number };
      var old = pr && pr.upTo;
      for (i = 0; i < eps.length; i++) {
        if (!eps[i]) continue;
        if (coversUp(up, eps[i].season, eps[i].number)) eps[i].watched = true;
        else if (old && coversUp(old, eps[i].season, eps[i].number) && !inPairs(w, eps[i].season, eps[i].number)) delete eps[i].watched;
      }
      var keep = [];
      for (i = 0; i < w.length; i++) if (!coversUp(up, w[i].season, w[i].number)) keep.push(w[i]);
      show.watched = keep;
      if (!pr) pr = show.progress = { upTo: null, unwatched: [], aired: 0, seen: 0, caughtUp: false, next: null };
      pr.upTo = { season: season, number: number, at: isoNow() };
      pr.unwatched = [];
      leftAfter(pr, function (l) {
        if (l.season < season) return 0;
        if (l.season > season) return l.unseen;
        return Math.max(0, Math.min(l.unseen, (l.out || 0) - number));
      });
      return;
    }
    var on = op === 'watched';
    for (i = 0; i < eps.length; i++) {
      if (eps[i] && eps[i].season === season && eps[i].number === number) { if (on) eps[i].watched = true; else delete eps[i].watched; }
    }
    var out = [];
    for (var j = 0; j < w.length; j++) if (!(w[j].season === season && w[j].number === number)) out.push(w[j]);
    if (pr && coversUp(pr.upTo, season, number)) {
      var ex = [];
      var u = isArr(pr.unwatched) ? pr.unwatched : [];
      for (var k = 0; k < u.length; k++) if (!(u[k].season === season && u[k].number === number)) ex.push(u[k]);
      if (!on) ex.push({ season: season, number: number });
      pr.unwatched = ex;
    } else if (on) out.push({ season: season, number: number, at: isoNow() });
    show.watched = out;
    // One more seen in its season (a mark taken off waits for the Pi's count).
    if (on && pr) leftAfter(pr, function (l) { return l.season === season ? Math.max(0, l.unseen - 1) : l.unseen; });
  }

  // The per-season counts (progress.left) after a mark, until the Pi sends
  // its own: f(season) -> its new unseen count; seen and caughtUp follow.
  function leftAfter(pr, f) {
    if (!isArr(pr.left) || !pr.left.length) return;
    var keep = [];
    var gone = 0;
    for (var i = 0; i < pr.left.length; i++) {
      var l = pr.left[i];
      var u = f(l);
      gone += l.unseen - u;
      if (u > 0) keep.push({ season: l.season, unseen: u, out: l.out, total: l.total });
    }
    pr.left = keep;
    if (typeof pr.seen === 'number' && typeof pr.aired === 'number') {
      pr.seen = Math.min(pr.aired, pr.seen + gone);
      pr.caughtUp = pr.aired > 0 && pr.seen === pr.aired;
    }
  }

  // Puts a mark into the copy of the Pi's data this TV holds, so the row
  // and the show page show it before the Pi's own update arrives.
  function applyMark(rec) {
    var show = validData(S.data) ? findShow(rec.showId) : null;
    var op = rec.op;
    var season = rec.season;
    var number = rec.number;
    if (op === 'caughtup') {
      var cu = latestAired(rec.showId, show);
      if (!cu) return;
      op = 'upto';
      season = cu.season;
      number = cu.number;
    }
    applyToEps(rec.showId, show, op, season, number);
    if (show) { applyToShow(show, op, season, number); saveCache(); }
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
      var route = { watched: '/shows/watched', unwatch: '/shows/unwatch', upto: '/shows/upto', caughtup: '/shows/caughtup' }[rec.op];
      var body = rec.op === 'caughtup' ? { id: rec.showId } : { id: rec.showId, season: rec.season, number: rec.number };
      Lv.post(route, body, function (err, data, code) {
        O.sending[k] = false;
        // Kept for the next try while the Pi can't be reached; dropped when it refuses.
        if (!err || code === 400 || code === 404) {
          removeOut(rec);
          if (!err) applyMark(rec);
          changed();
          if (!err) refetchPageSoon();
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

  // Tablet: after the Pi took a Watch, "Go to: <title>" until a tap, a key or GO_MS.
  var GO_MS = 30000;
  var goCard = null;

  function goToCard(name, service) {
    if (goCard) goCard.close();
    var node = document.createElement('div');
    node.className = 'sh-go-card';
    node.setAttribute('role', 'button');
    var t = document.createElement('div');
    t.className = 'sh-go-card-title';
    t.textContent = word('goTo', { name: name });
    var l = document.createElement('div');
    l.className = 'sh-go-card-line';
    l.textContent = word('goToLine', { service: service });
    node.appendChild(t);
    node.appendChild(l);
    document.body.appendChild(node);
    var me = { node: node, close: close };
    var timer = setTimeout(close, GO_MS);
    function close() {
      clearTimeout(timer);
      node.removeEventListener('click', close);
      document.removeEventListener('keydown', close, true);
      if (node.parentNode) node.parentNode.removeChild(node);
      if (goCard === me) goCard = null;
    }
    node.addEventListener('click', close);
    document.addEventListener('keydown', close, true);
    goCard = me;
    setTimeout(function () { if (goCard === me) node.className = 'sh-go-card is-shown'; }, 20);
    return me;
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
    refetchPageSoon();
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

  function drawRow(parent, a, t, past, cols) {
    cols = cols || { alt: false, mark: false };
    var dayOnly = !!a.eps[0].dayOnly;
    var airMs = parseIso(a.eps[0].airedAt);
    var soon = !dayOnly && a.ms > t - 5 * MIN && a.ms - t <= HOUR;
    var on = !dayOnly && a.ms <= t && a.ms > t - 5 * MIN;
    var app = watchApp(a.show);
    var alts = alternatives(a.show);
    var line = el('div', 'sh-line', parent);
    var seen = rowWatched(a);
    var row = el('div', 'sh-row f' + (past ? ' is-past' : '') + (seen ? ' is-watched' : '') + (soon || on ? ' is-soon' : ''), line);
    row.setAttribute('data-key', rowKey(a));
    poster(row, a.show);
    var info = el('div', 'sh-info', row);
    el('div', 'sh-title', info, a.show.name);
    var meta = el('div', 'sh-meta', info);
    // The code and the time each stay whole; a narrow (focused) row breaks
    // only between them, never inside "8:00 PM".
    var mt = el('span', 'sh-meta-text', meta);
    el('span', 'sh-meta-bit', mt, epCode(a.eps) + ' ·');
    mt.appendChild(document.createTextNode(' '));
    el('span', dayOnly ? 'sh-meta-wrap' : 'sh-meta-bit', mt, dayOnly ? word('streamsOn', { service: app || a.show.service || '' }) : timeText(a.ms));
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
    // Fixed columns after the row, in a fixed order: Also on, check, show page. A column a
    // row lacks keeps an empty slot of the same width; a column no row of the view has is left out.
    if (cols.alt) {
      var altSlot = el('div', 'sh-slot is-alt', line);
      if (alts.length) {
        // A chip of its own beside the row: Right reaches it, OK opens that app.
        var alt = el('div', 'sh-alt f' + (past ? ' is-past' : ''), altSlot, word('alsoOn', { service: alts[0] }));
        alt.setAttribute('data-key', 'sh:alt:' + a.show.id + ':' + a.ms + ':0');
      }
    }
    if (cols.mark) {
      var markSlot = el('div', 'sh-slot is-mark', line);
      if (markable(a, t)) {
        // A small check toggle at the end of an aired row: OK marks the episode
        // watched, or takes the mark off.
        var mk = el('div', 'sh-mark f' + (seen ? ' is-on' : '') + (past ? ' is-past' : ''), markSlot);
        mk.setAttribute('data-key', 'sh:mark:' + a.show.id + ':' + a.ms);
        mk.setAttribute('role', 'checkbox');
        mk.setAttribute('aria-checked', seen ? 'true' : 'false');
        var box = el('span', 'sh-mark-box', mk);
        el('span', 'sh-check', box);
        el('span', 'sh-mark-text', mk, word(seen ? 'unmark' : 'markUpTo'));
      }
    }
    // The show page: a small round list icon; focused, it names itself.
    var pg = el('div', 'sh-page f' + (past ? ' is-past' : ''), el('div', 'sh-slot is-page', line));
    pg.setAttribute('data-key', 'sh:page:' + a.show.id + ':' + a.ms);
    pg.setAttribute('role', 'button');
    var ic = el('span', 'sh-page-ic', pg);
    ic.innerHTML = LIST_SVG;
    el('span', 'sh-page-text', pg, word('showPage'));
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
    // Which optional columns this view has at all (the same for every row of it).
    var cols = { alt: false, mark: false };
    for (var c = 0; c < groups.length; c++) {
      for (var d = 0; d < groups[c].rows.length; d++) {
        var cr = groups[c].rows[d];
        if (alternatives(cr.show).length) cols.alt = true;
        if (markable(cr, t)) cols.mark = true;
      }
    }
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var day = el('div', 'sh-day' + (g.today ? ' is-today' : '') + (g.past ? ' is-past' : ''), box);
      var date = el('div', 'sh-date', day);
      if (g.today) el('div', 'sh-date-mark', date, word('todayMark'));
      el('div', 'sh-date-dow', date, dayName(g.ms));
      el('div', 'sh-date-day', date, dayDate(g.ms));
      var rows = el('div', 'sh-rows', day);
      for (var j = 0; j < g.rows.length; j++) drawRow(rows, g.rows[j], t, g.past || g.rows[j].ms < t - 5 * MIN, cols);
    }
    return box;
  }

  function soonText(r) {
    if (r.ep) return word('nextLine', { code: epCode([r.ep]), when: whenText(r.ms, now(), r.ep.dayOnly) });
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
    if (r.days === null) el('div', 'sh-count is-blank', card);
    else {
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

  // The small round show page chip at the end of a line (as on the Schedule rows).
  function pageChip(line, id, key) {
    var pg = el('div', 'sh-page f', el('div', 'sh-slot is-page', line));
    pg.setAttribute('data-key', 'sh:page:' + id + ':' + key);
    pg.setAttribute('role', 'button');
    var ic = el('span', 'sh-page-ic', pg);
    ic.innerHTML = LIST_SVG;
    el('span', 'sh-page-text', pg, word('showPage'));
    return pg;
  }

  // "Ready to watch": one line per show behind, OK watches the next episode.
  function drawReady(parent, list) {
    if (!list.length) return;
    var wrap = el('div', 'sh-ready', parent);
    var head = el('div', 'sh-soon-head sh-ready-head', wrap);
    el('span', '', head, word('readyHead'));
    el('span', 'sh-ready-n', head, String(list.length));
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var line = el('div', 'sh-line', wrap);
      var row = el('div', 'sh-show sh-ready-row f', line);
      row.setAttribute('data-key', 'sh:ready:' + r.show.id);
      poster(row, r.show);
      var info = el('div', 'sh-info', row);
      el('div', 'sh-title', info, r.show.name);
      // What is out, then the next episode on its own quiet line, so the
      // Spanish (about a quarter longer) never cuts either.
      var what = readyText(r);
      var nextText = r.next ? word('readyNext', { code: word('code', { s: r.next.season, e: r.next.number }) }) : '';
      el('div', 'sh-meta sh-ready-line', info, what || nextText);
      if (what && nextText) el('div', 'sh-air sh-ready-next', info, nextText);
      var n = el('div', 'sh-count sh-ready-count', row);
      el('div', 'sh-count-n', n, String(r.n));
      el('div', 'sh-count-word', n, word('toWatch'));
      var side = el('div', 'sh-side', row);
      badge(side, watchApp(r.show));
      pageChip(line, r.show.id, 'ready');
    }
  }

  function drawSoonView(parent, v, t) {
    var wrap = el('div', 'sh-soonview', parent);
    drawReady(wrap, v.ready || []);
    if (v.ready && v.ready.length) el('div', 'sh-soon-head', wrap, word('soonHead'));
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
      var sl = el('div', 'sh-line', list);
      var row = el('div', 'sh-show f' + (s.running === false ? ' is-ended' : ''), sl);
      row.setAttribute('data-key', 'sh:show:' + s.id);
      poster(row, s);
      var info = el('div', 'sh-info', row);
      el('div', 'sh-title', info, s.name);
      var line = '';
      var next = nextFor(s, t);
      if (next) line = word('nextLine', { code: epCode([next.ep]), when: whenText(next.ms, t, next.ep.dayOnly) });
      var meta = el('div', 'sh-meta', info);
      if (!line) { var nd = undatedFor(S.data, s, t); if (nd) line = soonText(nd); }
      el('span', 'sh-meta-text', meta, line || (s.checkedAt ? '' : (s.error || '')));
      var rd = readyFor(S.data, s.id);
      if (rd) el('span', 'sh-chip is-ready', meta, word('nToWatch', { n: rd.n }));
      var side = el('div', 'sh-side', row);
      el('span', 'sh-flag' + (s.running === false ? ' is-ended' : ' is-running'), side, s.checkedAt ? statusText(s) : '…');
      badge(side, watchApp(s));
      pageChip(sl, s.id, 'show');
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
    if (S.page && findShow(S.page.id)) { renderPage(body); return; }
    S.page = null;
    var t = now();
    var root = el('div', 'sh', body);
    var st = state();
    var top = el('div', 'sh-top', root);
    var tabs = el('div', 'sh-tabs', top);
    for (var i = 0; i < TABS.length; i++) {
      var b = el('div', 'sh-tab f' + (TABS[i] === S.tab ? ' is-on' : ''), tabs, word('tabs.' + TABS[i]));
      b.setAttribute('data-key', 'sh:tab:' + TABS[i]);
      // Coming soon carries how many shows are ready to watch, so they are found from any tab.
      var nr = TABS[i] === 'soon' && st === 'data' ? readyList(S.data).length : 0;
      if (nr) el('span', 'sh-tab-n', b, String(nr));
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
    // Back from a show page: the chip it was opened from.
    if (S.backKey) {
      var chips = root.querySelectorAll('.sh-page, .sh-card');
      for (var c = 0; c < chips.length; c++) if (chips[c].getAttribute('data-key') === S.backKey) pick = chips[c];
      S.backKey = null;
    }
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
    if (p[1] === 'pg') return selectPage(p);
    if (p[1] === 'page' || p[1] === 'soon') {
      // A Coming soon card opens the show page too, dated or not.
      if (findShow(p[2])) openPage(p[2], key);
      return true;
    }
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
      var t0 = now();
      var a0 = { show: show, eps: eps };
      if (rowWatched(a0)) toggleRow(show, eps, t0);
      else {
        // Not watched yet: this episode and every earlier one.
        var last = null;
        for (var q = 0; q < eps.length; q++) {
          var qm = parseIso(eps[q].airstamp);
          if (qm !== null && qm <= t0 + 5 * MIN && typeof eps[q].season === 'number' && typeof eps[q].number === 'number') last = eps[q];
        }
        // Never move the up-to point back: an episode already inside it (an
        // exception taken off by hand) is only marked watched again.
        var up = show.progress && show.progress.upTo;
        var inside = !!(last && up && typeof up.season === 'number' && typeof up.number === 'number' &&
          (last.season < up.season || (last.season === up.season && last.number <= up.number)));
        if (inside) toggleRow(show, eps, t0);
        else if (last) queueMark('upto', show.id, last.season, last.number);
      }
      changed();
      return true;
    }
    if (p[1] === 'ready') {
      // The next episode not watched, as a row the started list can hold.
      var rd = readyFor(S.data, show.id);
      if (rd && rd.next) eps.push({ season: rd.next.season, number: rd.next.number, airstamp: isoOf(now() - MIN) });
    }
    var other = null;
    if (p[1] === 'alt') other = alternatives(show)[Number(p[4]) || 0] || null;
    watch(show, eps, other);
    return true;
  }


  /* ---------- the show page ---------- */

  /* A show's full list of episodes, from GET /shows/episodes?id= on the Pi:
     { ok, id, checkedAt, partial?, seasons: [{ season, episodes: [{ number,
     name, airstamp, runtime?, watched? }] }], progress }. Kept per show in
     localStorage (the last EPS_KEEP shows) and drawn at once, then refreshed.
     Marks change this copy as well as the snapshot, so the page answers
     before the Pi does. */
  var EPS = {};
  var P = { seq: 0, state: '', timer: null };

  function validEps(d) {
    return !!d && typeof d === 'object' && isArr(d.seasons) && !!d.progress && typeof d.progress === 'object';
  }

  function epsGet(id) {
    if (EPS.hasOwnProperty(id)) return EPS[id];
    var d = null;
    try { d = JSON.parse(load(EPS_KEY + id) || 'null'); } catch (e) { d = null; }
    EPS[id] = validEps(d) ? d : null;
    return EPS[id];
  }

  function epsPut(id, d) {
    EPS[id] = d;
    var idx = [];
    try { idx = JSON.parse(load(EPS_INDEX) || '[]'); } catch (e) { idx = []; }
    if (!isArr(idx)) idx = [];
    var keep = [];
    for (var i = 0; i < idx.length; i++) if (idx[i] !== id) keep.push(idx[i]);
    keep.push(id);
    while (keep.length > EPS_KEEP) {
      var gone = keep.shift();
      delete EPS[gone];
      try { if (window.localStorage) localStorage.removeItem(EPS_KEY + gone); } catch (e2) { /* ignore */ }
    }
    store(EPS_INDEX, JSON.stringify(keep));
    store(EPS_KEY + id, JSON.stringify(d));
  }

  // Every numbered episode: [{ season, number, name, airstamp, runtime, ms, watched }], in order.
  function flatEps(d) {
    var out = [];
    // Dates as the Schedule shows them: the day it streams on the show's app
    // (streamTime), not the broadcast airstamp, when the two differ.
    var show = validData(S.data) && d.id ? findShow(d.id) : null;
    var msOf = function (e) {
      var st = null;
      try { st = show ? streamTime(show, e) : null; } catch (x) { st = null; }
      return st ? st.ms : parseIso(e.airstamp);
    };
    for (var i = 0; i < d.seasons.length; i++) {
      var sea = d.seasons[i];
      if (!sea || typeof sea.season !== 'number' || !isArr(sea.episodes)) continue;
      for (var j = 0; j < sea.episodes.length; j++) {
        var e = sea.episodes[j];
        if (!e || typeof e.number !== 'number') continue;
        out.push({ season: sea.season, number: e.number, name: e.name, airstamp: e.airstamp, runtime: e.runtime, ms: msOf(e), watched: e.watched === true, ref: e });
      }
    }
    return out;
  }

  // One episode of the page: watched as marked, a mark on its way winning.
  function pgWatched(id, e) {
    var p = pendingMark(id, e.season, e.number, e.ms);
    if (p) return p === 'watched';
    return e.watched;
  }

  function isOut(e, t) { return e.ms !== null && e.ms <= t + 5 * MIN; }

  // A mark in the page's own copy of the list, and the counts that go with it.
  function applyToEps(id, show, op, season, number) {
    var d = epsGet(id);
    if (!d) return;
    var fl = flatEps(d);
    var pr = d.progress;
    var w = show && isArr(show.watched) ? show.watched : [];
    var i;
    if (op === 'upto') {
      var up = { season: season, number: number };
      var old = pr.upTo;
      for (i = 0; i < fl.length; i++) {
        if (coversUp(up, fl[i].season, fl[i].number)) fl[i].ref.watched = true;
        else if (old && coversUp(old, fl[i].season, fl[i].number) && !inPairs(w, fl[i].season, fl[i].number)) delete fl[i].ref.watched;
      }
      pr.upTo = { season: season, number: number, at: isoNow() };
      pr.unwatched = [];
    } else {
      var on = op === 'watched';
      for (i = 0; i < fl.length; i++) if (fl[i].season === season && fl[i].number === number) { if (on) fl[i].ref.watched = true; else delete fl[i].ref.watched; }
      if (coversUp(pr.upTo, season, number)) {
        var ex = [];
        var u = isArr(pr.unwatched) ? pr.unwatched : [];
        for (var k = 0; k < u.length; k++) if (!(u[k].season === season && u[k].number === number)) ex.push(u[k]);
        if (!on) ex.push({ season: season, number: number });
        pr.unwatched = ex;
      }
    }
    var t = now();
    var aired = 0;
    var seen = 0;
    var next = null;
    fl = flatEps(d);
    for (i = 0; i < fl.length; i++) {
      if (!isOut(fl[i], t)) continue;
      aired++;
      if (fl[i].watched) seen++;
      else if (!next) next = { season: fl[i].season, number: fl[i].number };
    }
    if (!d.partial) pr.aired = aired;
    pr.seen = seen;
    pr.next = next;
    pr.caughtUp = aired > 0 && seen === aired;
    epsPut(id, d);
  }

  function fetchEps(id) {
    var Lv = S.C && S.C.live;
    var had = !!epsGet(id);
    var seq = ++P.seq;
    P.state = had ? 'ok' : 'loading';
    function done(state) {
      if (seq !== P.seq || !S.page || S.page.id !== id) return;
      P.state = state;
      if (S.C) S.C.redrawPanel();
    }
    if (!Lv || typeof Lv.fetch !== 'function') { setTimeout(function () { done(had ? 'ok' : 'lost'); }, 0); return; }
    try {
      Lv.fetch('/shows/episodes?id=' + encodeURIComponent(id), function (err, data, code) {
        if (!err && validEps(data)) { epsPut(id, data); return done('ok'); }
        if (!err) return done(epsGet(id) ? 'ok' : 'old');
        if (code === 404) {
          // A show that is gone from the list: back to the Schedule. Anything else on a 404 is a Pi without the route.
          if (/not on the list/.test(String(err)) && seq === P.seq && S.page && S.page.id === id) { closePage(); return; }
          return done(epsGet(id) ? 'ok' : 'old');
        }
        done(epsGet(id) ? 'ok' : 'lost');
      });
    } catch (e) { warn('reading the episodes', e); done(had ? 'ok' : 'lost'); }
  }

  // After a mark or a new snapshot: ask again shortly (one call for a burst).
  function refetchPageSoon() {
    if (!S.page) return;
    clearTimeout(P.timer);
    P.timer = setTimeout(function () { if (S.page) fetchEps(S.page.id); }, 250);
  }

  function openPage(id, backKey) {
    S.page = { id: id, season: null, inEp: null, back: backKey || null };
    fetchEps(id);
    if (S.C) S.C.redrawPanel();
  }

  function closePage() {
    if (!S.page) return false;
    S.backKey = S.page.back;
    S.page = null;
    P.seq++;
    clearTimeout(P.timer);
    if (S.C) S.C.redrawPanel();
    return true;
  }

  // The page's first episode still to watch that has aired: { season, number, name, airstamp } or null.
  function nextToWatch(id, fl, t) {
    for (var i = 0; i < fl.length; i++) if (isOut(fl[i], t) && !pgWatched(id, fl[i])) return fl[i];
    return null;
  }

  function pickSeason(id, fl, t) {
    var nx = nextToWatch(id, fl, t);
    if (nx) return nx.season;
    var last = null;
    for (var i = 0; i < fl.length; i++) if (isOut(fl[i], t)) last = fl[i].season;
    return last !== null ? last : (fl.length ? fl[fl.length - 1].season : null);
  }

  function pgDate(ms, t) {
    var d = new Date(ms);
    var text = word('pgDate', { mon: monName(ms), d: d.getDate() });
    return d.getFullYear() === new Date(t).getFullYear() ? text : word('pgDateYear', { date: text, year: d.getFullYear() });
  }

  function pgBtn(parent, key, cls, text, glyph) {
    var b = el('div', 'sh-pg-btn f' + (cls ? ' ' + cls : ''), parent);
    b.setAttribute('data-key', key);
    b.setAttribute('role', 'button');
    el('span', glyph === 'play' ? 'sh-watch-play' : 'sh-check', b);
    el('span', 'sh-pg-btn-text', b, text);
    return b;
  }

  function renderPage(body) {
    var pg = S.page;
    var show = findShow(pg.id);
    var t = now();
    var d = epsGet(pg.id);
    var fl = d ? flatEps(d) : [];
    if (pg.season === null && fl.length) pg.season = pickSeason(pg.id, fl, t);
    var root = el('div', 'sh sh-pg', body);
    var top = el('div', 'sh-pg-top', root);
    var back = el('div', 'sh-pg-back f', top);
    // While the list is still coming, the chip has a key of its own, so focus moves to Watch when it arrives.
    var noList = !fl.length && P.state === 'ok' && !!d;
    back.setAttribute('data-key', fl.length || noList ? 'sh:pg:back' : 'sh:pg:back:wait');
    back.setAttribute('role', 'button');
    el('span', 'sh-pg-back-arrow', back);
    el('span', 'sh-pg-back-text', back, word('title'));

    var head = el('div', 'sh-pg-head', root);
    poster(head, show);
    var info = el('div', 'sh-pg-info', head);
    el('div', 'sh-pg-title', info, show.name);
    var meta = el('div', 'sh-pg-meta', info);
    badge(meta, watchApp(show));
    el('span', 'sh-pg-meta-text', meta, statusText(show));
    var nSeasons = 0;
    for (var q = 0; q < fl.length; q++) if (q === 0 || fl[q].season !== fl[q - 1].season) nSeasons++;
    if (nSeasons) {
      el('span', 'sh-pg-dot', meta, '·');
      el('span', 'sh-pg-meta-text', meta, nSeasons === 1 ? word('seasonsOne') : word('seasonsN', { n: nSeasons }));
    }
    var firstFocus = null;
    if (noList) {
      // A show with no episode listed (a new season with no date yet): say so, and still open its app.
      var nm = el('div', 'sh-msg', root);
      el('div', 'sh-msg-head', nm, word('pgNoEps'));
      el('div', 'sh-msg-line', nm, word('pgNoEpsLine'));
      var svc = watchApp(show);
      if (svc) {
        var ob = pgBtn(el('div', 'sh-pg-acts sh-pg-acts-solo', root), 'sh:pg:open', 'is-main', word('pgOpen', { service: svc }), 'play');
        ob.setAttribute('data-autofocus', '');
      } else back.setAttribute('data-autofocus', '');
      return;
    }
    if (!fl.length) {
      var st = P.state === 'old' || P.state === 'lost' ? 'page' + cap(P.state) : 'loading';
      var w = stateWords(st);
      var msg = el('div', 'sh-msg', root);
      el('div', 'sh-msg-head', msg, w.head);
      if (w.line) el('div', 'sh-msg-line', msg, w.line);
      back.setAttribute('data-autofocus', '');
      return;
    }
    // The season on show, with one bar segment per episode.
    var inSeason = [];
    var total = 0;
    var airedAll = 0;
    var seenAll = 0;
    for (var a = 0; a < fl.length; a++) {
      total++;
      if (isOut(fl[a], t)) { airedAll++; if (pgWatched(pg.id, fl[a])) seenAll++; }
      if (fl[a].season === pg.season) inSeason.push(fl[a]);
    }
    var seenIn = 0;
    for (var b = 0; b < inSeason.length; b++) if (pgWatched(pg.id, inSeason[b])) seenIn++;
    var allSeen = airedAll > 0 && seenAll === airedAll && airedAll === total;
    var prog = el('div', 'sh-pg-prog', info);
    el('div', 'sh-pg-prog-text', prog, allSeen ? word('allLine', { n: total }) : word('seasonLine', { s: pg.season, w: seenIn, n: inSeason.length }));
    var segs = el('div', 'sh-pg-segs', prog);
    for (var c = 0; c < inSeason.length; c++) {
      var on = pgWatched(pg.id, inSeason[c]);
      el('span', 'sh-pg-seg' + (on ? ' is-on' : isOut(inSeason[c], t) ? ' is-out' : ''), segs);
    }
    // The two buttons.
    var ended = show.running === false;
    var acts = el('div', 'sh-pg-acts', head);
    var nx = nextToWatch(pg.id, fl, t);
    var caught = airedAll > 0 && !nx;
    if (nx) {
      var wb = pgBtn(acts, 'sh:pg:watch', 'is-main', word('watchNext', { code: word('code', { s: nx.season, e: nx.number }) }), 'play');
      firstFocus = wb;
    }
    var cb = pgBtn(acts, 'sh:pg:caught', caught ? 'is-done' : '', caught ? word(ended ? 'seenDone' : 'caughtDone') : word(ended ? 'seenAll' : 'caughtUp'));
    if (!firstFocus) firstFocus = cb;

    // Season pills.
    var seasons = [];
    for (var e0 = 0; e0 < fl.length; e0++) {
      var sx = seasons.length ? seasons[seasons.length - 1] : null;
      if (!sx || sx.n !== fl[e0].season) { sx = { n: fl[e0].season, all: 0, seen: 0 }; seasons.push(sx); }
      sx.all++;
      if (pgWatched(pg.id, fl[e0])) sx.seen++;
    }
    var tabs = el('div', 'sh-tabs sh-pg-tabs', el('div', 'sh-pg-seasons', root));
    for (var f = 0; f < seasons.length; f++) {
      var sel = seasons[f].n === pg.season;
      var pill = el('div', 'sh-tab f' + (sel ? ' is-on' : ''), tabs, word('seasonPill', { s: seasons[f].n }));
      pill.setAttribute('data-key', 'sh:pg:season:' + seasons[f].n);
      if (sel) el('span', 'sh-pg-frac', pill, seasons[f].seen + '/' + seasons[f].all);
      else if (seasons[f].all > 0 && seasons[f].seen === seasons[f].all) el('span', 'sh-pg-tick', pill);
    }
    if (d.partial) el('div', 'sh-pg-note', root, word('partial'));
    // The episodes.
    var list = el('div', 'sh-pg-eps', root);
    for (var g = 0; g < inSeason.length; g++) {
      var ep = inSeason[g];
      var out = isOut(ep, t);
      var seen = out && pgWatched(pg.id, ep);
      var ek = ep.season + ':' + ep.number;
      var isIn = pg.inEp === ek;
      var item = el('div', 'sh-pg-ep' + (isIn ? ' is-in' : ''), list);
      item.setAttribute('data-ep', ek);
      var row = el('div', 'sh-pg-row f' + (seen ? ' is-seen' : '') + (out ? '' : ' is-future'), item);
      row.setAttribute('data-key', 'sh:pg:ep:' + ek);
      el('div', 'sh-pg-num', row, word('epNum', { e: ep.number }));
      var ei = el('div', 'sh-pg-ep-info', row);
      el('div', 'sh-pg-ep-title', ei, ep.name || word('epNum', { e: ep.number }));
      var em = el('div', 'sh-pg-ep-meta', ei);
      var line = ep.ms === null ? '' : word(out ? 'airedOn' : 'airsOn', { d: pgDate(ep.ms, t) });
      if (ep.runtime) line += (line ? ' · ' : '') + word('minutes', { n: ep.runtime });
      el('span', 'sh-pg-ep-meta-text', em, line);
      if (seen) {
        var wn = el('span', 'sh-note is-watched', em);
        el('span', 'sh-pg-dot', wn, '·');
        el('span', 'sh-check', wn);
        el('span', 'sh-note-text', wn, word('watched'));
      }
      if (out) {
        var mk = el('div', 'sh-mark f' + (seen ? ' is-on' : ''), item);
        mk.setAttribute('data-key', 'sh:pg:mark:' + ek);
        mk.setAttribute('role', 'checkbox');
        mk.setAttribute('aria-checked', seen ? 'true' : 'false');
        el('span', 'sh-check', el('span', 'sh-mark-box', mk));
        el('span', 'sh-mark-text', mk, word(seen ? 'unmark' : 'markWatched'));
        var up = el('div', 'sh-pg-upto' + (isIn ? ' f' : ''), item, word('upToHere'));
        up.setAttribute('data-key', 'sh:pg:upto:' + ek);
        up.setAttribute('role', 'button');
      } else {
        el('span', 'sh-mark-gap', item);
      }
    }
    // Opening the page lands on Watch (or I'm caught up).
    if (firstFocus) firstFocus.setAttribute('data-autofocus', '');
  }

  // OK on something of the show page (key parts p: sh, pg, what, ...).
  function selectPage(p) {
    var pg = S.page;
    if (!pg) return true;
    var show = findShow(pg.id);
    if (!show) return true;
    var what = p[2];
    if (what === 'back') { closePage(); return true; }
    var d = epsGet(pg.id);
    var fl = d ? flatEps(d) : [];
    var t = now();
    if (what === 'season') {
      pg.season = Number(p[3]);
      pg.inEp = null;
      if (S.C) S.C.redrawPanel();
      return true;
    }
    if (what === 'open') { watch(show, [], null); return true; }
    if (what === 'watch') {
      var nx = nextToWatch(pg.id, fl, t);
      if (nx) watch(show, [{ season: nx.season, number: nx.number, name: nx.name, airstamp: nx.airstamp }], null);
      return true;
    }
    if (what === 'caught') {
      var airedAny = false;
      for (var i = 0; i < fl.length; i++) if (isOut(fl[i], t)) airedAny = true;
      if (airedAny && nextToWatch(pg.id, fl, t)) { queueMark('caughtup', show.id); changed(); }
      return true;
    }
    var s = Number(p[3]);
    var n = Number(p[4]);
    if (what === 'mark') {
      var cur = null;
      for (var j = 0; j < fl.length; j++) if (fl[j].season === s && fl[j].number === n) cur = fl[j];
      if (!cur) return true;
      queueMark(pgWatched(pg.id, cur) ? 'unwatch' : 'watched', show.id, s, n);
      changed();
      return true;
    }
    if (what === 'upto') { queueMark('upto', show.id, s, n); changed(); }
    return true;
  }

  // Focus moved: the episode whose controls are in use shows its "Watched up to here" chip.
  function onFocus(target) {
    var pg = S.page;
    if (!pg || !target) return;
    var key = target.getAttribute('data-key') || '';
    var p = key.split(':');
    var ek = p[1] === 'pg' && (p[2] === 'ep' || p[2] === 'mark' || p[2] === 'upto') ? p[3] + ':' + p[4] : null;
    if (ek === pg.inEp) return;
    pg.inEp = ek;
    var items = document.querySelectorAll('.sh-pg-ep');
    for (var i = 0; i < items.length; i++) {
      var on = ek !== null && items[i].getAttribute('data-ep') === ek;
      var cls = items[i].className.replace(/\s*\bis-in\b/, '');
      items[i].className = on ? cls + ' is-in' : cls;
      var up = items[i].querySelector('.sh-pg-upto');
      if (up) up.className = 'sh-pg-upto' + (on ? ' f' : '') + (up === target ? ' is-focused' : '');
    }
  }

  function pgNode(key) {
    var all = document.querySelectorAll('.sh-pg .f');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-key') === key) return all[i];
    return null;
  }

  // The listing's focusables (everything under the tabs), in document order.
  function lineOf(node) {
    var n = node;
    while (n && n.nodeType === 1 && !/\bsh-line\b/.test(n.className)) n = n.parentNode;
    return n && n.nodeType === 1 ? n : node;
  }

  function inReady(node) {
    for (var n = node; n && n.nodeType === 1; n = n.parentNode) if (/\bsh-ready\b/.test(n.className)) return true;
    return false;
  }

  function listingItems() {
    var all = document.querySelectorAll('.sh .f');
    var out = [];
    for (var i = 0; i < all.length; i++) if (!/\bsh-tab\b/.test(all[i].className)) out.push(all[i]);
    return out;
  }

  // Left and Right along a row's line go piece by piece in the line's order (row, Also on,
  // check, show page), whatever the focused pills have grown over.
  function lineMove(dir, from) {
    var line = from.parentNode;
    while (line && line.nodeType === 1 && !/\bsh-line\b/.test(line.className)) line = line.parentNode;
    if (!line || line.nodeType !== 1) return undefined;
    var items = line.querySelectorAll('.f');
    var at = -1;
    for (var i = 0; i < items.length; i++) if (items[i] === from) at = i;
    if (at < 0) return undefined;
    if (dir === 'right') return items[at + 1] || true;
    return items[at - 1] || undefined;
  }

  // Left and Right on the tabs switch the tab at once (no OK needed). Past
  // the first or last tab: the usual move (into the apps column, say).
  function tabMove(dir, from) {
    var i = TABS.indexOf(from) + (dir === 'right' ? 1 : -1);
    if (i < 0 || i >= TABS.length) return undefined;
    S.tab = TABS[i];
    store(TAB_KEY, S.tab);
    if (S.C) S.C.redrawPanel();
    return document.querySelector('.sh .sh-tab[data-key="sh:tab:' + S.tab + '"]') || true;
  }

  // The line (row, Also on, check, show page) holding the focus is drawn as
  // one box: is-lit on the line, is-in when the row itself has the focus.
  function lightLine(target) {
    var lit = document.querySelectorAll('.sh-line.is-lit');
    for (var i = 0; i < lit.length; i++) lit[i].className = lit[i].className.replace(/\s*\bis-(lit|in)\b/g, '');
    if (!target || !target.getAttribute || S.page) return;
    var line = lineOf(target);
    if (!line || !/\bsh-line\b/.test(line.className)) return;
    line.className += ' is-lit' + (/\bsh-(row|show)\b/.test(target.className) ? ' is-in' : '');
  }

  // Down from any tab goes to the first thing of the listing below (the "Did you finish?"
  // strip or the first row), never sideways into the apps column; Up from the first line of
  // the listing goes back to the tab on show.
  function listingMove(dir, from) {
    var key = from.getAttribute('data-key') || '';
    var items = listingItems();
    if (!items.length) return undefined;
    if (key.indexOf('sh:tab:') === 0) return dir === 'down' ? items[0] : undefined;
    // Down from "Ready to watch" (its rows are wide, the Coming soon cards
    // below are half width): the next line in reading order, never past the cards.
    if (dir === 'down' && inReady(from)) {
      var line = lineOf(from);
      var seen = false;
      for (var j = 0; j < items.length; j++) {
        if (items[j] === from) { seen = true; continue; }
        if (seen && lineOf(items[j]) !== line) return items[j];
      }
      return true;
    }
    // Down from a Coming soon card or a "Did you finish?" button: the first thing
    // below it in reading order, so the half-width cards lead into the rows, not
    // into the column of show page chips at the far right.
    if (dir === 'down' && (key.indexOf('sh:soon:') === 0 || key.indexOf('sh:fin:') === 0)) {
      var fr = from.getBoundingClientRect();
      for (var k = 0; k < items.length; k++) {
        if (items[k] === from) continue;
        if (items[k].getBoundingClientRect().top >= fr.bottom - 1) return items[k];
      }
      return undefined;
    }
    if (key.indexOf('sh:') !== 0 || dir !== 'up') return undefined;
    var first = items[0].getBoundingClientRect();
    var r = from.getBoundingClientRect();
    if (r.top + r.height / 2 > first.bottom) return undefined;
    return document.querySelector('.sh .sh-tab.is-on') || undefined;
  }

  // Up and Down on the page go in a fixed order: back, Watch, caught up, the
  // season on show, then the episodes. Returns the node to focus, or undefined
  // for the usual move by position.
  function onMove(dir, from) {
    if (!from) return undefined;
    if (!S.page && (dir === 'left' || dir === 'right')) {
      var fk = from.getAttribute('data-key') || '';
      if (fk.indexOf('sh:tab:') === 0) return tabMove(dir, fk.slice(7));
      return lineMove(dir, from);
    }
    if (dir !== 'up' && dir !== 'down') return undefined;
    if (!S.page) return listingMove(dir, from);
    var key = from.getAttribute('data-key') || '';
    var sea = document.querySelector('.sh-pg-tabs .sh-tab.is-on');
    var firstEp = document.querySelector('.sh-pg-row');
    var watchBtn = pgNode('sh:pg:watch');
    var caught = pgNode('sh:pg:caught');
    var openBtn = pgNode('sh:pg:open');
    if (key === 'sh:pg:back') return dir === 'down' ? (watchBtn || openBtn || caught || sea || undefined) : undefined;
    if (key === 'sh:pg:open') return dir === 'down' ? undefined : pgNode('sh:pg:back') || undefined;
    if (key === 'sh:pg:watch') return dir === 'down' ? (caught || sea || undefined) : pgNode('sh:pg:back') || undefined;
    if (key === 'sh:pg:caught') return dir === 'down' ? (sea || undefined) : (watchBtn || pgNode('sh:pg:back') || undefined);
    if (key.indexOf('sh:pg:season:') === 0) return dir === 'down' ? (firstEp || undefined) : (caught || watchBtn || pgNode('sh:pg:back') || undefined);
    var p = key.split(':');
    if (p[1] === 'pg' && (p[2] === 'ep' || p[2] === 'mark' || p[2] === 'upto')) {
      // Up and Down keep to the same column of controls, episode by episode.
      var items = document.querySelectorAll('.sh-pg-ep');
      var at = -1;
      for (var i = 0; i < items.length; i++) if (items[i].getAttribute('data-ep') === p[3] + ':' + p[4]) at = i;
      if (at < 0) return undefined;
      var to = items[at + (dir === 'down' ? 1 : -1)];
      if (!to) return dir === 'up' ? (sea || undefined) : true;
      var want = p[2] === 'ep' ? '.sh-pg-row' : '.sh-mark';
      return to.querySelector(want) || to.querySelector('.sh-pg-row');
    }
    return undefined;
  }

  // Back on the show page: to the Schedule.
  function onBack() { return closePage(); }

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
    onFocus: onFocus,
    lightLine: lightLine,
    onMove: onMove,
    onBack: onBack,
    closePage: function () { S.page = null; S.backKey = null; P.seq++; },
    pageOpen: function () { return !!S.page; },
    state: state,
    // For the tests (dev/shows-test.js): the pure parts and the state.
    _test: {
      view: view, airings: airings, groupByDay: groupByDay, returning: returning, tileLine: tileLine,
      noteStarted: noteStarted, started: loadStarted, finishLines: finishLines, startedText: startedText, rowWatched: rowWatched, pendingOut: function () { return loadOut().slice(); }, flushOut: flushOut,
      ladder: ladder, watch: watch, watchApp: watchApp, viaApp: viaApp, alternatives: alternatives, availability: availability, timeText: timeText, epCode: epCode, rangeText: rangeText, word: word,
      weekStart: weekStart, monthEnd: monthEnd, setData: function (d) { S.raw = d; S.data = streamView(d); S.fromCache = false; changed(); }, streamView: streamView, channelStreams: channelStreams,
      openPage: function (id) { openPage(id, null); },
      pageState: function () { return P.state; }, epsCached: function (id) { return epsGet(id); }, pendingMark: pendingMark, isWatchedEp: isWatchedEp,
      tab: function (t) { if (t) S.tab = t; return S.tab; },
      ctx: function () { return S.C; }
    }
  };
})();
