/*
 * Calendar: today's agenda on the tile; Day, Week and Month in the panel.
 *
 * The events come from the hub server on the Raspberry Pi as the live
 * resource "calendar" (see docs/live-updates.md, "What the Pi reader does"):
 *   { configured, tz, from, to, updatedAt, truncated,
 *     calendars: [{ cal, name, color, ok, error, count, skipped, updatedAt }],
 *     events: [{ id, cal, title, start, end, allDay, location }] }
 * Timed events are UTC ("2026-11-16T15:00:00Z"); all-day events are dates
 * ("2026-11-16") with an exclusive end. Everything is shown in data.tz, not
 * in the TV's own zone. When the TV can't convert to that zone
 * (Intl.DateTimeFormat without timeZone support) it falls back to its own.
 *
 * The last data received is kept on the TV (homeHub.calendar.v1), so the
 * tile has something to show at once after the TV turns on, before the Pi
 * answers.
 *
 * Remote: in the panel the row of tabs (Today, Day, Week, Month) is one
 * place for focus and the calendar below it is the other.
 *   Tabs:      Left/Right pick a view (it shows at once), Down goes to the calendar.
 *   Day:       Left/Right the day before or after, Up/Down the events.
 *   Week:      Left/Right the day, Up/Down that day's events, OK opens the Day.
 *   Month:     arrows move by day and week (and into the next or last month),
 *              OK opens the Day.
 *   Up from the first event (or the top row of the month) goes back to the tabs.
 *   Notes:     an event with notes (its description in Google Calendar,
 *              data.notes[ev.note], from Pi server 0.16.0) shows the start
 *              of them beside the Day view; OK there (or a click on the
 *              event) opens them to read: Up/Down scroll, OK, Back, Left or
 *              Right close. Guest mode hides notes (app/guest.js).
 *   Guests:    an event with other people on it (Pi server 0.17.0:
 *              guestCount and guests) says "1 guest" / "3 guests" beside its
 *              time in every view; its notes open with the count and the
 *              names. Nothing when there are none; Guest mode hides both.
 *
 * Opening the panel when nothing is left today goes straight to the next
 * event's day with it chosen, the one the tile shows under "Next".
 *
 * Past events: hidden on the tile (it is about what's next), dimmed in the panel.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var WEEK_START = 0;   // first day of the week: 0 = Sunday (the US default), 1 = Monday

  /* Every word the widget shows, in one place for translating. {n} is a
     number, {t} a time, {d} a day, {name} a calendar's name. */
  var STRINGS = {
    title: 'Calendar',
    calendarN: 'Calendar {n}',
    fmtShort: '{mon} {d}',
    fmtLong: '{dow}, {mon} {d}',
    fmtLongYear: '{dow}, {mon} {d}, {y}',
    fmtRangeSame: '{mon} {a} – {b}',
    fmtWithYear: '{s}, {y}',
    fmtMonthYear: '{mon} {y}',
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    daysMin: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
      'September', 'October', 'November', 'December'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    am: 'AM',
    pm: 'PM',
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    allDay: 'All day',
    now: 'Now',
    untilT: 'until {t}',
    noTitle: '(No title)',
    views: { day: 'Day', week: 'Week', month: 'Month' },
    todayButton: 'Today',
    nothingToday: 'Nothing today',
    nothingElse: 'Nothing else today',
    nothingComing: 'Nothing coming up',
    nextLabel: 'Next',
    comingUp: 'Coming up',
    more: '+{n} more',
    nothingDay: 'Nothing on this day.',
    outside: 'The Pi only reads from yesterday to 60 days ahead.',
    lastUpdated: 'Last updated {t}',
    truncated: 'Showing the first {n} events',
    calError: '{name}: couldn’t be read',
    calErrorWhy: '{name}: couldn’t be read ({why})',
    calErrorsTile: '{n} calendars couldn’t be read',
    calErrorTile: '{name} couldn’t be read',
    hintTabs: '← → view · ↓ calendar',
    hintDay: '← → day · ↑ ↓ events',
    hintWeek: '← → day · ↑ ↓ events · OK opens the day',
    hintMonth: 'Arrows move · OK opens the day',
    hintDayNotes: '← → day · ↑ ↓ events · OK reads the notes',
    hintReading: '↑ ↓ scroll · OK or Back closes',
    notesLabel: 'Notes',
    readNotes: 'OK to read',
    notesGuest: 'Notes hidden for guests',
    guestOne: '1 guest',
    guestMany: '{n} guests',
    guestsLabel: 'Guests',
    states: {
      off: { head: 'Calendar needs the Pi',
        line: 'Your calendars come from the hub server on the Raspberry Pi. Live updates are off on this TV: set live.server in config.js to the Pi’s address.',
        short: 'Live updates are off. Set live.server in config.js.' },
      quiet: { head: 'Calendar needs the Pi',
        line: 'This TV hasn’t reached the hub server on the Pi yet. It keeps trying quietly. Setting the server up is in pi/README.md.',
        short: 'Waiting for the hub server on the Pi.' },
      lost: { head: 'Can’t reach the Pi',
        line: '{live}. The calendar shows as soon as the Pi answers again.',
        short: 'Trying again quietly.' },
      refused: { head: 'Calendar needs the Pi', line: '{live}.', short: '{live}.' },
      loading: { head: 'Loading the calendar…', line: '', short: '' },
      nocalendar: { head: 'No calendar from the Pi',
        line: 'The hub server on the Pi doesn’t send a calendar yet. Update it (pi/README.md).',
        short: 'Update the hub server on the Pi.' },
      unconfigured: { head: 'No calendars set up yet',
        line: 'Add each calendar’s secret iCal link to the Pi’s .env file (CALENDAR_1_NAME and CALENDAR_1_URL), then restart the hub server. pi/README.md has the steps.',
        short: 'Add calendar links to the Pi’s .env file.' }
    },
    error: 'The calendar couldn’t be shown.'
  };

  // window.HUB_CALENDAR_STRINGS, when set before this file loads, replaces
  // words key by key (lists as a whole), like HUB_TODO_STRINGS.
  function mergeStrings(dst, src) {
    if (!src || typeof src !== 'object') return;
    for (var k in src) {
      if (!src.hasOwnProperty(k) || !dst.hasOwnProperty(k)) continue;
      var v = src[k];
      var d = dst[k];
      var isList = Object.prototype.toString.call(d) === '[object Array]';
      if (d && typeof d === 'object' && !isList) {
        if (v && typeof v === 'object') mergeStrings(d, v);
      } else if (isList) {
        if (Object.prototype.toString.call(v) === '[object Array]' && v.length === d.length) dst[k] = v;
      } else if (typeof v === 'string') {
        dst[k] = v;
      }
    }
  }
  try { mergeStrings(STRINGS, window.HUB_CALENDAR_STRINGS); } catch (e) { /* keep English */ }

  /* The words in the hub's language ('calendar.<path in STRINGS>' in
     app/i18n.js). STRINGS keeps its identity and is refilled from the
     English copy, or from the Spanish, when the language changes. */
  var EN = JSON.parse(JSON.stringify(STRINGS));
  function localizeStrings() {
    var L = window.HUB_I18N;
    var src = EN;
    try { if (L && typeof L.localize === 'function') src = L.localize(EN, 'calendar'); } catch (e) { src = EN; }
    for (var k in src) if (src.hasOwnProperty(k)) STRINGS[k] = src[k];
    try {
      if (L && typeof L.t === 'function') STRINGS.daysMin = String(L.t('calendar.daysMin', EN.daysMin.join(','))).split(',');
    } catch (e) { /* the English letters */ }
  }
  localizeStrings();

  // "a. m." and "p. m." keep their space, so a time never breaks in two.
  function apWord(h) { return String(h < 12 ? STRINGS.am : STRINGS.pm).replace(/ /g, '\u00a0'); }

  // States that only wait for the Pi: the hub may show these tiles quietly
  // (motion extras, quietTiles), as one small line.
  var WAITING = { off: true, quiet: true, lost: true, refused: true, loading: true };

  /* One color per calendar number (1 to 9), all readable on the dark glass. */
  var PALETTE = [
    [124, 196, 255],  // 1 sky
    [255, 179, 107],  // 2 apricot
    [142, 229, 154],  // 3 mint
    [245, 146, 196],  // 4 pink
    [199, 166, 255],  // 5 lavender
    [255, 209, 102],  // 6 yellow
    [95, 214, 207],   // 7 teal
    [255, 138, 128],  // 8 coral
    [184, 196, 214]   // 9 slate
  ];

  var CACHE_KEY = 'homeHub.calendar.v1';
  var MIN = 60000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  var STALE_MS = 30 * MIN;
  var TILE_ROWS = 8;
  var NAV_LIMIT = 400;          // days either side of today the panel can travel
  var ALLDAY_CHIPS = 3;         // all-day chips in the Day view before "+N"

  var C = null;                 // ctx, kept from init
  var data = null;              // the calendar resource in use (live or cached)
  var fromCache = false;        // data came from the TV's own copy, not this run's Pi
  var lastLiveAt = 0;           // TV time the Pi last gave us data or was live with it
  var zone = null;              // makeZone(data.tz)
  var index = null;             // buildIndex(data)
  var timer = null;             // the one minute timer
  var lastToday = null;
  var tileSig = '';
  var shownState = '';

  // Panel state, kept while the panel is open (view for the whole session).
  var view = 'day';
  var selDay = null;            // the chosen day (day number in data.tz)
  var selId = null;             // the chosen event's id in Day and Week
  var panelOpen = false;
  var ui = null;                // { root, stage, label, hint, tabs, today, full, focus: 'stage'|'tabs' }
  var reading = false;          // the chosen event's notes are open to read (Day view)
  var readTop = 0;              // how far the notes are scrolled (rem)

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

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Calendar: ' + text); } catch (e) { /* ignore */ }
  }

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { warn(e && e.message); return undefined; }
    };
  }

  function remPx() {
    try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch (e) { return 16; }
  }

  // Colors set on the Pi (CALENDAR_n_COLOR) win over the palette: cal number to [r, g, b].
  var chosen = {};

  function readChosen(d) {
    var out = {};
    var list = d && isArr(d.calendars) ? d.calendars : [];
    for (var i = 0; i < list.length; i++) {
      var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str(list[i] && list[i].color));
      if (m) out[list[i].cal] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    }
    return out;
  }

  function color(cal, alpha) {
    var c = chosen[cal] || PALETTE[((cal || 1) - 1) % PALETTE.length] || PALETTE[0];
    return alpha === undefined ? 'rgb(' + c.join(',') + ')' : 'rgba(' + c.join(',') + ',' + alpha + ')';
  }

  /* ---------- time zones (pure) ---------- */

  // Reads y, m, d, h, mi, s from a formatter set to hour12: false. Old engines
  // have no formatToParts; their text ("11/15/2026, 14:05:09") is read by hand.
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
    if (p[3] === 24) p[3] = 0;   // some engines write midnight as 24:00
    return p;
  }

  // A zone that turns UTC instants into wall clock numbers (Date.UTC of the
  // local time) and back. ok is false when it fell back to the TV's own zone.
  function makeZone(tz) {
    var fmt = null;
    if (tz) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: 'numeric',
          day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        if (!readParts(fmt, 0)) fmt = null;
      } catch (e) {
        fmt = null;
      }
    }
    var cache = {};
    var size = 0;
    var Q = 15 * MIN;   // every real zone changes on a quarter hour
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
    // The UTC instant a wall clock number happens (the first time, in the
    // repeated hour; the moment after the gap, in the skipped one).
    // The offsets a day either side are the only two that can apply.
    function utc(w) {
      var a = w - offset(w - DAY);
      var b = w - offset(w + DAY);
      var first = Math.min(a, b);
      var second = Math.max(a, b);
      if (wall(first) === w) return first;
      if (wall(second) === w) return second;
      return a;   // a skipped time: the offset from before the change moves it forward
    }
    return {
      tz: tz,
      ok: !!fmt,
      offset: offset,
      wall: wall,
      utc: utc,
      dayOf: function (ms) { return Math.floor(wall(ms) / DAY); },
      dayStart: function (n) { return utc(n * DAY); }
    };
  }

  /* ---------- days (pure) ---------- */

  // "2026-11-16" to a day number (days since 1970-01-01), or null.
  function dayFromText(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(t);
    if (d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) return null;
    return Math.round(t / DAY);
  }

  // "2026-11-16T15:00:00Z" (seconds and fractions optional) to ms, or NaN.
  // Anything else readable by Date.parse is taken too.
  function parseIso(s) {
    if (typeof s !== 'string') return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function weekday(n) { return ((n + 4) % 7 + 7) % 7; }   // 1970-01-01 was a Thursday

  function ymd(n) {
    var d = new Date(n * DAY);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
  }

  function dayNum(y, m, d) { return Math.round(Date.UTC(y, m, d) / DAY); }

  function weekStartOf(n) { return n - ((weekday(n) - WEEK_START + 7) % 7); }

  function monthStartOf(n) { var p = ymd(n); return dayNum(p.y, p.m, 1); }

  function addMonths(n, k) {
    var p = ymd(n);
    var last = new Date(Date.UTC(p.y, p.m + k + 1, 0)).getUTCDate();
    return dayNum(p.y, p.m + k, Math.min(p.d, last));
  }

  /* ---------- events (pure) ---------- */

  function str(v) { return typeof v === 'string' ? v : ''; }

  // The events as the views use them: { id, cal, title, location, notes,
  // allDay, s, e (UTC ms), startDay, endDay (exclusive day numbers) }, sorted.
  function normalize(d, z) {
    var out = [];
    var list = d && isArr(d.events) ? d.events : [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || typeof ev !== 'object') continue;
      var n = { id: str(ev.id) || ('x' + i), cal: typeof ev.cal === 'number' && ev.cal >= 1 ? ev.cal : 1,
        title: str(ev.title).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''),
        location: str(ev.location).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''),
        allDay: ev.allDay === true,
        notes: typeof ev.note === 'string' && d.notes && typeof d.notes === 'object' && typeof d.notes[ev.note] === 'string' ?
          d.notes[ev.note].replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '') : '',
        guestCount: typeof ev.guestCount === 'number' && ev.guestCount >= 1 ? Math.floor(ev.guestCount) : 0,
        guests: [] };
      if (n.guestCount && isArr(ev.guests)) {
        for (var gi = 0; gi < ev.guests.length && gi < 25; gi++) if (typeof ev.guests[gi] === 'string' && ev.guests[gi]) n.guests.push(ev.guests[gi]);
      }
      if (seen.hasOwnProperty('k' + n.id)) n.id = n.id + '~' + i;
      seen['k' + n.id] = true;
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
      return (p.s - q.s) || ((q.allDay ? 1 : 0) - (p.allDay ? 1 : 0)) || ((q.e - q.s) - (p.e - p.s)) ||
        (p.title < q.title ? -1 : p.title > q.title ? 1 : 0) || (p.id < q.id ? -1 : 1);
    });
    return out;
  }

  // Day number -> events that touch it. A very long event is listed on at
  // most a year of days.
  function buildIndex(d, z) {
    var events = normalize(d, z);
    var byDay = {};
    var byId = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      byId['k' + ev.id] = ev;
      var last = Math.min(ev.endDay, ev.startDay + 366);
      for (var n = ev.startDay; n < last; n++) (byDay[n] = byDay[n] || []).push(ev);
    }
    return { events: events, byDay: byDay, byId: byId, zone: z };
  }

  // A day's events: { allDay: [ev], timed: [{ ev, startMin, endMin, before, after }] }.
  // Minutes are wall clock minutes of that day, clipped to 0..1440.
  function dayEvents(idx, n) {
    var list = idx.byDay[n] || [];
    var z = idx.zone;
    var a = z.dayStart(n);
    var b = z.dayStart(n + 1);
    var out = { allDay: [], timed: [] };
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (ev.allDay) { out.allDay.push(ev); continue; }
      var before = ev.s < a;
      var after = ev.e > b;
      var sm = before ? 0 : (z.wall(ev.s) - n * DAY) / MIN;
      var em = after ? 1440 : (z.wall(ev.e) - n * DAY) / MIN;
      sm = Math.max(0, Math.min(1440, sm));
      em = Math.max(sm, Math.min(1440, em));
      out.timed.push({ ev: ev, startMin: sm, endMin: em, before: before, after: after });
    }
    out.timed.sort(function (p, q) {
      return (p.startMin - q.startMin) || ((q.endMin - q.startMin) - (p.endMin - p.startMin)) || (p.ev.s - q.ev.s);
    });
    return out;
  }

  // Side by side columns for overlapping events. Each item gets col and cols.
  // minDur: an event is treated as at least this long, so short ones that
  // are drawn taller than they last don't cover the next one.
  function pack(items, minDur) {
    var cluster = null;
    var clusters = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var end = Math.max(it.endMin, it.startMin + (minDur || 0));
      if (!cluster || it.startMin >= cluster.end) {
        cluster = { items: [], ends: [], end: 0 };
        clusters.push(cluster);
      }
      var c = 0;
      while (c < cluster.ends.length && cluster.ends[c] > it.startMin) c++;
      cluster.ends[c] = end;
      it.col = c;
      cluster.items.push(it);
      if (end > cluster.end) cluster.end = end;
    }
    for (var k = 0; k < clusters.length; k++) {
      for (var j = 0; j < clusters[k].items.length; j++) clusters[k].items[j].cols = clusters[k].ends.length;
    }
    return items;
  }

  // The day's events in the order Up and Down walk them: all-day, then by time.
  function dayOrder(de) {
    var out = de.allDay.slice();
    for (var i = 0; i < de.timed.length; i++) out.push(de.timed[i].ev);
    return out;
  }

  function isPast(ev, now, today) {
    if (ev.allDay) return ev.endDay <= today;
    return ev.e > ev.s ? ev.e <= now : ev.s < now;
  }

  // What the tile shows. now: Date.now(); returns { today, allDay, upcoming
  // [{ ev, now }], had, next }.
  function agenda(idx, now) {
    var z = idx.zone;
    var today = z.dayOf(now);
    var de = dayEvents(idx, today);
    var upcoming = [];
    for (var i = 0; i < de.timed.length; i++) {
      var it = de.timed[i];
      if (isPast(it.ev, now, today)) continue;
      upcoming.push({ ev: it.ev, now: it.ev.s <= now });
    }
    var next = null;
    if (!upcoming.length) {
      for (var j = 0; j < idx.events.length; j++) {
        var ev = idx.events[j];
        if (ev.startDay > today) { next = ev; break; }
      }
    }
    return { today: today, allDay: de.allDay, upcoming: upcoming, had: de.allDay.length + de.timed.length > 0, next: next };
  }

  /* ---------- words for times and days (pure) ---------- */

  function clockOf(z, ms) {
    var w = z.wall(ms);
    var mins = Math.floor(((w % DAY) + DAY) % DAY / MIN);
    return { h: Math.floor(mins / 60), m: mins % 60 };
  }

  function hm(h, m, withAmPm) {
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + pad(m) + (withAmPm ? ' ' + apWord(h) : '');
  }

  function timeText(z, ms) {
    var c = clockOf(z, ms);
    return hm(c.h, c.m, true);
  }

  // "9 AM" for hour lines.
  function hourText(h) {
    return (h % 12 === 0 ? 12 : h % 12) + ' ' + apWord(h);
  }

  function shortDate(n) {
    var p = ymd(n);
    return fill(STRINGS.fmtShort, { mon: STRINGS.monthsShort[p.m], d: p.d });
  }

  function longDate(n, withYear) {
    var p = ymd(n);
    return fill(withYear ? STRINGS.fmtLongYear : STRINGS.fmtLong, { dow: STRINGS.days[weekday(n)], mon: STRINGS.months[p.m], d: p.d, y: p.y });
  }

  // "Today", "Tomorrow", "Yesterday", a weekday within the week, else "Tue, Nov 24".
  function relDay(n, today) {
    if (n === today) return STRINGS.today;
    if (n === today + 1) return STRINGS.tomorrow;
    if (n === today - 1) return STRINGS.yesterday;
    if (n > today && n < today + 7) return STRINGS.days[weekday(n)];
    return STRINGS.daysShort[weekday(n)] + ', ' + shortDate(n);
  }

  // When an event happens, in words: "9:00 – 10:30 AM", "11:00 AM – 1:00 PM",
  // "Sat 10:00 PM – Sun 1:00 AM", "All day", "All day, Nov 14 – 16".
  function whenText(z, ev) {
    if (ev.allDay) {
      if (ev.endDay - ev.startDay <= 1) return STRINGS.allDay;
      var a = ymd(ev.startDay);
      var b = ymd(ev.endDay - 1);
      var range = a.m === b.m && a.y === b.y ? fill(STRINGS.fmtRangeSame, { mon: STRINGS.monthsShort[a.m], a: a.d, b: b.d }) : shortDate(ev.startDay) + ' – ' + shortDate(ev.endDay - 1);
      return STRINGS.allDay + ', ' + range;
    }
    var s = clockOf(z, ev.s);
    if (ev.e <= ev.s) return hm(s.h, s.m, true);
    var e = clockOf(z, ev.e);
    var sd = z.dayOf(ev.s);
    var ed = z.dayOf(ev.e - 1);
    if (sd !== ed) {
      return STRINGS.daysShort[weekday(sd)] + ' ' + hm(s.h, s.m, true) + ' – ' + STRINGS.daysShort[weekday(z.dayOf(ev.e))] + ' ' + hm(e.h, e.m, true);
    }
    if ((s.h < 12) === (e.h < 12)) return hm(s.h, s.m, false) + ' – ' + hm(e.h, e.m, true);
    return hm(s.h, s.m, true) + ' – ' + hm(e.h, e.m, true);
  }

  // Owner-typed text in the hub's language (display only; app/i18n-dyn.js).
  function dyn(s) { return (window.HUB_I18N && window.HUB_I18N.dyn) ? window.HUB_I18N.dyn(s) : s; }

  function titleOf(ev) { return ev.title ? dyn(ev.title) : STRINGS.noTitle; }

  function guestOn() {
    try { return !!(window.HUB_GUEST && window.HUB_GUEST.on()); } catch (e) { return false; }
  }

  // Notes the screen may show: none while Guest mode is on.
  function notesOf(ev) { return ev && ev.notes && !guestOn() ? ev.notes : ''; }

  // Notes as blocks: { head, lines } per paragraph (blank line between). A
  // short first line with more under it reads as a heading ("Golden pothos").
  // Each line is translated on its own (dyn takes up to 500 characters).
  function noteBlocks(text) {
    var out = [];
    var paras = String(text).split(/\n[ \t]*\n/);
    for (var i = 0; i < paras.length; i++) {
      var lines = paras[i].split('\n');
      var kept = [];
      for (var j = 0; j < lines.length; j++) {
        var l = lines[j].replace(/^\s+|\s+$/g, '');
        if (l) kept.push(l);
      }
      if (!kept.length) continue;
      var head = '';
      if (kept.length > 1 && kept[0].length <= 48 && !/[.!?:,;]$/.test(kept[0])) head = kept.shift();
      out.push({ head: head ? dyn(head) : '', lines: kept.map(function (x) { return x.length > 500 ? x : dyn(x); }) });
    }
    return out;
  }

  function drawNoteBlocks(parent, text) {
    var blocks = noteBlocks(text);
    for (var i = 0; i < blocks.length; i++) {
      var b = el('div', 'cal-nb', parent);
      if (blocks[i].head) el('div', 'cal-nb-head', b, blocks[i].head);
      for (var j = 0; j < blocks[i].lines.length; j++) el('div', 'cal-nb-line', b, blocks[i].lines[j]);
    }
  }

  // How many other people are on the event, as words; '' for none or in Guest mode.
  function guestText(ev) {
    if (!ev || !ev.guestCount || guestOn()) return '';
    return ev.guestCount === 1 ? STRINGS.guestOne : fill(STRINGS.guestMany, { n: ev.guestCount });
  }

  // " · 3 guests" after an event's time, in its own span so it can be quieter.
  // Narrow places (a Week column) get a small person mark and the number.
  function guestTag(parent, ev, mini) {
    var t = guestText(ev);
    if (!t) return;
    if (!mini) { el('span', 'cal-guests', parent, '\u00a0\u00b7 ' + t); return; }
    var m = el('span', 'cal-guests is-mini', parent);
    m.setAttribute('title', t);
    var p = el('span', 'cal-person', m);
    el('i', '', p);
    el('i', '', p);
    el('span', '', m, String(ev.guestCount));
  }

  // The event can be opened to read: it has notes or guests to show.
  function readable(ev) { return !!(notesOf(ev) || guestText(ev)); }

  // A small lines mark: this event has notes.
  function notesMark(parent) {
    var m = el('span', 'cal-has-notes', parent);
    el('i', '', m);
    el('i', '', m);
    el('i', '', m);
    return m;
  }

  /* ---------- test hook ---------- */

  // For dev/calendar-test.js (node) and the screenshot script. Not used by the hub.
  window.HUB_CALENDAR_TEST = {
    STRINGS: STRINGS,
    WEEK_START: WEEK_START,
    makeZone: makeZone,
    dayFromText: dayFromText,
    parseIso: parseIso,
    weekday: weekday,
    ymd: ymd,
    dayNum: dayNum,
    weekStartOf: weekStartOf,
    addMonths: addMonths,
    normalize: normalize,
    buildIndex: buildIndex,
    dayEvents: dayEvents,
    pack: pack,
    agenda: agenda,
    whenText: whenText,
    timeText: timeText,
    relDay: relDay,
    isPast: isPast,
    noteBlocks: noteBlocks,
    notesOf: notesOf,
    guestText: guestText,
    readable: readable
  };

  /* ---------- the data and the live line ---------- */

  function live() { return C && C.live && typeof C.live.status === 'function' ? C.live : null; }

  function liveStatus() {
    var L = live();
    try { return (L && L.status()) || { state: 'off', text: '' }; } catch (e) { return { state: 'off', text: '' }; }
  }

  function validData(d) {
    return !!d && typeof d === 'object' && (d.configured === false || (d.configured === true && isArr(d.events)));
  }

  function loadCache() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      var c = JSON.parse(raw);
      if (c && validData(c.data) && c.data.configured === true) {
        useData(c.data, true);
        lastLiveAt = typeof c.at === 'number' ? c.at : 0;
      }
    } catch (e) { /* start without it */ }
  }

  function saveCache() {
    if (!data || data.configured !== true) {
      try { if (window.localStorage) window.localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
      return;
    }
    try {
      if (window.localStorage) window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, at: lastLiveAt, data: data }));
    } catch (e) { /* the copy in memory still works */ }
  }

  function useData(d, cached) {
    data = d;
    chosen = readChosen(d);
    fromCache = !!cached;
    if (d && d.configured === true) {
      if (!zone || zone.tz !== str(d.tz)) zone = makeZone(str(d.tz));
      index = buildIndex(d, zone);
    } else {
      index = null;
    }
  }

  // Which state to draw: 'data', 'unconfigured', or one of the no-data ones.
  function stateNow() {
    if (data && data.configured === false && !fromCache) return 'unconfigured';
    var st = liveStatus().state;
    if (!live() || st === 'off') return 'off';
    if (index) return 'data';
    if (st === 'live') return 'nocalendar';
    if (st === 'connecting') return 'loading';
    if (st === 'quiet') return 'quiet';
    if (st === 'lost') return 'lost';
    return 'refused';
  }

  function message(state) {
    var m = STRINGS.states[state] || STRINGS.states.loading;
    var text = liveStatus().text || '';
    // "Live: the Pi refused this TV" reads as "The Pi refused this TV" here.
    text = text.replace(/^Live:\s*/, '');
    text = text ? text.charAt(0).toUpperCase() + text.substring(1) : '';
    return { head: m.head, line: fill(m.line, { live: text }), short: fill(m.short, { live: text }) };
  }

  function now() { return new Date().getTime(); }

  function today() { return zone ? zone.dayOf(now()) : Math.floor(now() / DAY); }

  // Quiet notes for the foot of the tile and panel.
  function staleText() {
    if (!data || data.configured !== true) return '';
    if (liveStatus().state === 'live' && !fromCache) return '';
    var at = Math.max(lastLiveAt || 0, parseIso(data.updatedAt) || 0);
    if (!at || now() - at < STALE_MS) return '';
    var t = timeText(zone, at);
    var d = zone.dayOf(at);
    var td = today();
    return fill(STRINGS.lastUpdated, { t: d === td ? t : relDay(d, td) + ' ' + t });
  }

  function badCalendars() {
    var out = [];
    var list = data && isArr(data.calendars) ? data.calendars : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].ok === false) out.push(list[i]);
    return out;
  }

  function calName(c) { return str(c && c.name) || fill(STRINGS.calendarN, { n: c && c.cal }); }

  // The error text from the Pi, only when it is short and plain.
  function plainError(text) {
    text = str(text);
    // The Pi says "could not be read (HTTP 404)"; the line already says the first part.
    var m = /^could not be read \((.*)\)$/.exec(text);
    if (m) text = m[1];
    if (!text || text.length > 40 || /[\/\\{}<>=@:]/.test(text) || text === 'not read yet') return '';
    return text;
  }

  function calendarFor(cal) {
    var list = data && isArr(data.calendars) ? data.calendars : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].cal === cal) return list[i];
    return null;
  }

  // The events of the last live data this run ('' before any): a refetch
  // that brings the same events is not news.
  var liveEvents = '';

  function eventsKey(d) {
    try { return d && d.configured === true ? JSON.stringify(d.events) + JSON.stringify(d.notes || null) : 'none'; } catch (e) { return 'none'; }
  }

  function onLive(d) {
    if (!validData(d)) return;
    var key = eventsKey(d);
    // Changed events after the first live data this run: the tile says so (ctx.activity).
    var changed = liveEvents !== '' && key !== liveEvents && key !== 'none';
    liveEvents = key;
    lastLiveAt = now();
    useData(d, false);
    saveCache();
    refresh(true);
    if (changed && C && typeof C.activity === 'function') {
      try { C.activity('calendar'); } catch (e) { /* the events just show */ }
    }
  }

  // An event starting within the hour gets the tile's accent edge, once per
  // event and start (the edge goes by itself after about a minute).
  var soonSeen = {};
  function checkSoon() {
    if (!index || !C || typeof C.accent !== 'function') return;
    var t = now();
    var a = agenda(index, t);
    for (var i = 0; i < a.upcoming.length; i++) {
      var ev = a.upcoming[i].ev;
      if (!(ev.s > t && ev.s - t <= 60 * MIN)) continue;
      var k = ev.id + '@' + ev.s;
      if (soonSeen[k]) continue;
      soonSeen[k] = true;
      try { C.accent('soon'); } catch (e) { /* the event just shows */ }
    }
  }

  function refresh(force) {
    if (!C) return;
    try { checkSoon(); } catch (e) { warn('soon: ' + (e && e.message)); }
    var sig = signature();
    if (!force && sig === tileSig) {
      if (panelOpen) updateNow();
      return;
    }
    tileSig = sig;
    C.redrawTile();
    if (C.isOpen()) C.redrawPanel();
  }

  // Changes whenever the tile would look different.
  function signature() {
    var s = stateNow() + '|' + (stateNow() === 'data' ? '' : message(stateNow()).line) + '|' + staleText();
    if (index) {
      var a = agenda(index, now());
      s += '|' + a.today + '|' + a.allDay.length + '|' + (a.next ? a.next.id : '');
      for (var i = 0; i < a.upcoming.length; i++) s += ',' + a.upcoming[i].ev.id + (a.upcoming[i].now ? '*' : '');
    }
    return s;
  }

  /* ---------- the minute timer ---------- */

  // One timer for everything: it fires just after each minute turns, moves
  // the now line, drops events that ended, and redraws at midnight in data.tz.
  function schedule() {
    if (timer) clearTimeout(timer);
    var ms = MIN - (now() % MIN) + 250;
    timer = setTimeout(function () {
      timer = null;
      try { tick(); } catch (e) { warn(e && e.message); }
      schedule();
    }, ms);
  }

  function tick() {
    var td = today();
    if (td !== lastToday) {
      lastToday = td;
      // The panel follows the date if it was showing today.
      if (panelOpen && selDay === td - 1) { selDay = td; selId = null; }
      refresh(true);
      return;
    }
    refresh(false);
  }

  /* ---------- tile ---------- */

  function bar(parent, cal) {
    var b = el('span', 'cal-bar', parent);
    b.style.backgroundColor = color(cal);
    return b;
  }

  function drawTileMessage(root, state) {
    var msg = message(state);
    var wait = WAITING[state] === true;
    var box = el('div', 'cal-tile-msg' + (wait ? ' hub-dormant' : ''), root);
    el('div', 'cal-msg-head' + (wait ? ' hub-quiet-line' : ''), box, msg.head);
    if (msg.short) el('div', 'cal-msg-line' + (wait ? ' hub-quiet-hide' : ''), box, msg.short);
    var mark = el('span', 'icon cal-mark' + (wait ? ' hub-quiet-hide' : ''), root);
    mark.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.calendar) || '';
  }

  // A one-row strip: the next thing on one line. What's on now or next today,
  // else today's all-day event, else the next day with something on.
  function drawStrip(body) {
    var root = el('div', 'cal-tile cal-strip', body);
    var state = stateNow();
    if (state !== 'data') {
      el('div', 'cal-strip-title' + (WAITING[state] === true ? ' hub-dormant hub-quiet-line' : ''), root, message(state).head);
      return;
    }
    var a = agenda(index, now());
    var u = a.upcoming[0];
    var line = el('div', 'cal-strip-line', root);
    if (u) {
      bar(line, u.ev.cal);
      var when = el('span', 'cal-strip-when', line);
      if (u.now) el('span', 'cal-now-tag', when, STRINGS.now);
      else when.textContent = timeText(zone, u.ev.s);
      el('span', 'cal-strip-title', line, titleOf(u.ev));
    } else if (a.allDay.length) {
      bar(line, a.allDay[0].cal);
      el('span', 'cal-strip-when cal-trow-tag', line, STRINGS.allDay);
      el('span', 'cal-strip-title', line, titleOf(a.allDay[0]));
    } else if (a.next) {
      bar(line, a.next.cal);
      el('span', 'cal-strip-when', line, relDay(a.next.startDay, a.today) + (a.next.allDay ? '' : ' ' + timeText(zone, a.next.s)));
      el('span', 'cal-strip-title', line, titleOf(a.next));
    } else {
      el('span', 'cal-strip-title is-quiet', line, a.had ? STRINGS.nothingElse : STRINGS.nothingComing);
    }
  }

  // A tall tile with room under today's events: the next days' events, as
  // many as fit. The today list keeps its rows; this list gives way.
  function drawLater(root, list, a) {
    var later = [];
    for (var i = 0; i < index.events.length && later.length < TILE_ROWS; i++) {
      if (index.events[i].startDay > a.today) later.push(index.events[i]);
    }
    if (!later.length) return;
    var box = el('div', 'cal-later', root);
    var foot = root.querySelector('.cal-tile-foot');
    if (foot) root.insertBefore(box, foot);
    el('div', 'cal-next-label', box, STRINGS.comingUp);
    var rows = el('div', 'cal-tile-list cal-later-list', box);
    list.style.flexShrink = '0';
    for (i = 0; i < later.length; i++) {
      var ev = later[i];
      var row = el('div', 'cal-trow', rows);
      bar(row, ev.cal);
      var text = el('div', 'cal-trow-text', row);
      el('div', 'cal-trow-when', text, relDay(ev.startDay, a.today) + (ev.allDay ? ' · ' + STRINGS.allDay : ' ' + timeText(zone, ev.s)));
      el('div', 'cal-trow-title', text, titleOf(ev));
    }
    while (rows.lastChild && rows.scrollHeight > rows.clientHeight + 1) rows.removeChild(rows.lastChild);
    if (!rows.firstChild) {
      root.removeChild(box);
      list.style.flexShrink = '';
    }
  }

  function drawTile(body) {
    var size = C && C.size ? C.size() : null;
    if (size && size.tier === 'strip') return drawStrip(body);
    var root = el('div', 'cal-tile', body);
    var state = stateNow();
    // Without data the zone isn't known yet, so the date waits for it too.
    if (state !== 'data') {
      drawTileMessage(root, state);
      return;
    }
    var a = agenda(index, now());
    var head = el('div', 'cal-date', root);
    var p = ymd(a.today);
    el('div', 'cal-date-num', head, String(p.d));
    var words = el('div', 'cal-date-words', head);
    el('div', 'cal-date-dow', words, STRINGS.days[weekday(a.today)]);
    el('div', 'cal-date-month', words, STRINGS.months[p.m]);

    var list = el('div', 'cal-tile-list', root);
    var rows = [];
    var i;
    for (i = 0; i < a.allDay.length; i++) rows.push(alldayRow(a.allDay[i]));
    for (i = 0; i < a.upcoming.length; i++) rows.push(eventRow(a.upcoming[i]));
    // Where a character works when the events change (app/agents.js): the
    // first row, or the Next block below when there is none.
    if (rows.length) rows[0].setAttribute('data-agent-spot', '');
    var more = el('div', 'cal-more', root);
    more.style.display = 'none';
    if (!a.upcoming.length) {
      var empty = el('div', 'cal-tile-empty', root, a.had ? STRINGS.nothingElse : STRINGS.nothingToday);
      if (a.next) {
        var nx = el('div', 'cal-next', root);
        nx.setAttribute('data-agent-spot', '');
        el('div', 'cal-next-label', nx, STRINGS.nextLabel);
        var line = el('div', 'cal-next-line', nx);
        bar(line, a.next.cal);
        var txt = el('div', 'cal-next-text', line);
        var when = relDay(a.next.startDay, a.today) + (a.next.allDay ? '' : ' ' + timeText(zone, a.next.s));
        var nw = el('div', 'cal-next-when', txt, when);
        guestTag(nw, a.next);
        var nt = el('div', 'cal-next-title', txt, titleOf(a.next));
        if (notesOf(a.next)) notesMark(nt);
      } else if (!a.had) {
        empty.textContent = STRINGS.nothingComing;
      }
    }
    var notes = tileNotes();
    if (notes.length) {
      var foot = el('div', 'cal-tile-foot', root);
      for (i = 0; i < notes.length; i++) el('div', 'cal-tile-note' + (notes[i].warn ? ' is-warn' : ''), foot, notes[i].text);
    }
    fitRows(list, more, rows);
    // Nothing else today, so the "next" block sits under the date. If the
    // tile is too short for all of it, "next" shrinks to one line, then the
    // date gives way (never drawn outside the tile).
    function over() { return root.scrollHeight > root.clientHeight + 1 || list.scrollHeight > list.clientHeight + 1; }
    if (a.next && !a.upcoming.length && over()) {
      root.className += ' is-tight';
      while (list.firstChild) list.removeChild(list.firstChild);
      fitRows(list, more, rows);
      if (over() && head.parentNode === root) {
        root.removeChild(head);
        while (list.firstChild) list.removeChild(list.firstChild);
        fitRows(list, more, rows);
      }
    }
    // A small tile with no room for even one row: the date gives way.
    if (list.firstChild && list.scrollHeight > list.clientHeight + 1 && head.parentNode === root) {
      root.removeChild(head);
      while (list.firstChild) list.removeChild(list.firstChild);
      fitRows(list, more, rows);
    }
    if (size && size.tier === 'tall' && a.upcoming.length && list.childNodes.length === rows.length) drawLater(root, list, a);
  }

  function alldayRow(ev) {
    var row = el('div', 'cal-trow cal-trow-allday');
    bar(row, ev.cal);
    el('span', 'cal-trow-tag', row, STRINGS.allDay);
    var line = el('span', 'cal-trow-line', row, titleOf(ev));
    if (notesOf(ev)) notesMark(line);
    guestTag(line, ev);
    return row;
  }

  function eventRow(u) {
    var row = el('div', 'cal-trow' + (u.now ? ' is-now' : ''));
    bar(row, u.ev.cal);
    var text = el('div', 'cal-trow-text', row);
    var when = el('div', 'cal-trow-when', text);
    if (u.now) {
      el('span', 'cal-now-tag', when, STRINGS.now);
      if (u.ev.e > u.ev.s) el('span', '', when, fill(STRINGS.untilT, { t: timeText(zone, u.ev.e) }));
    } else {
      when.textContent = timeText(zone, u.ev.s);
    }
    guestTag(when, u.ev);
    var t = el('div', 'cal-trow-title', text, titleOf(u.ev));
    if (notesOf(u.ev)) notesMark(t);
    return row;
  }

  // Rows while they fit, then "+N more". Measured, so a bigger font or long
  // titles just show fewer rows.
  function fitRows(list, more, rows) {
    var shown = Math.min(rows.length, TILE_ROWS);
    var i;
    for (i = 0; i < shown; i++) list.appendChild(rows[i]);
    function setMore() {
      var rest = rows.length - shown;
      more.textContent = rest > 0 ? fill(STRINGS.more, { n: rest }) : '';
      more.style.display = rest > 0 ? '' : 'none';
    }
    setMore();
    while (shown > 1 && list.scrollHeight > list.clientHeight + 1) {
      list.removeChild(list.lastChild);
      shown -= 1;
      setMore();
    }
  }

  function tileNotes() {
    var out = [];
    var stale = staleText();
    if (stale) out.push({ text: stale });
    var bad = badCalendars();
    if (bad.length === 1) out.push({ text: fill(STRINGS.calErrorTile, { name: calName(bad[0]) }), warn: true });
    else if (bad.length > 1) out.push({ text: fill(STRINGS.calErrorsTile, { n: bad.length }), warn: true });
    return out;
  }

  /* ---------- panel: frame ---------- */

  function full() { return C && C.mode() === 'full'; }

  function drawPanel(body) {
    var state = stateNow();
    var root = el('div', 'cal-panel' + (full() ? ' is-full' : ''), body);
    ui = { root: root, focus: ui && ui.focus === 'tabs' ? 'tabs' : 'stage' };
    if (!panelOpen) {
      panelOpen = true;
      selDay = null;
      selId = null;
      reading = false;
      ui.focus = 'stage';
    }
    C.setSub(subText());
    if (state !== 'data') {
      var msg = message(state);
      var box = el('div', 'cal-msg', root);
      el('div', 'cal-msg-big', box, msg.head);
      if (msg.line) el('div', 'cal-msg-text', box, msg.line);
      var mark = el('span', 'icon cal-mark cal-mark-panel', root);
      mark.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.calendar) || '';
      ui = null;
      return;
    }
    var td = today();
    if (selDay === null || Math.abs(selDay - td) > NAV_LIMIT) {
      selDay = td;
      // Nothing left today: open on the next event, as the tile's "Next" says.
      var ag = agenda(index, now());
      if (!ag.upcoming.length && ag.next && ag.next.startDay - td <= NAV_LIMIT) {
        var lefts = orderFor(td);
        var open = false;
        for (var q = 0; q < lefts.length; q++) if (!isPast(lefts[q], now(), td)) open = true;
        if (!open) { selDay = ag.next.startDay; selId = ag.next.id; }
      }
    }

    // Today comes first, so reaching it never walks across (and switches) the views.
    var barRow = el('div', 'cal-bar-row', root);
    ui.today = el('div', 'cal-btn cal-today f', barRow, STRINGS.todayButton);
    ui.today.setAttribute('data-key', 'today');
    var tabs = el('div', 'cal-tabs', barRow);
    ui.tabs = {};
    var names = ['day', 'week', 'month'];
    for (var i = 0; i < names.length; i++) {
      var t = el('div', 'cal-btn cal-tab f' + (view === names[i] ? ' is-selected' : ''), tabs, STRINGS.views[names[i]]);
      t.setAttribute('data-key', 'tab-' + names[i]);
      ui.tabs[names[i]] = t;
    }
    ui.label = el('div', 'cal-label', barRow);

    ui.stage = el('div', 'cal-stage f', root);
    ui.stage.setAttribute('data-key', 'stage');
    if (ui.focus === 'stage') ui.stage.setAttribute('data-autofocus', '');
    else ui.tabs[view].setAttribute('data-autofocus', '');

    var foot = el('div', 'cal-foot', root);
    var notes = panelNotes();
    for (var k = 0; k < notes.length; k++) el('div', 'cal-note' + (notes[k].warn ? ' is-warn' : ''), foot, notes[k].text);
    var frow = el('div', 'cal-foot-row', foot);
    var legend = el('div', 'cal-legend', frow);
    var cals = isArr(data.calendars) ? data.calendars : [];
    for (var j = 0; j < cals.length; j++) {
      if (!cals[j]) continue;
      var key = el('div', 'cal-key' + (cals[j].ok === false ? ' is-bad' : ''), legend);
      var sw = el('span', 'cal-swatch', key);
      sw.style.backgroundColor = color(cals[j].cal);
      el('span', 'cal-key-name', key, calName(cals[j]));
    }
    ui.hint = el('div', 'cal-hint', frow);
    drawStage();
  }

  // The head's small line stays empty: the row of tabs already says the day.
  function subText() { return ''; }

  function panelNotes() {
    var out = [];
    var bad = badCalendars();
    for (var i = 0; i < bad.length; i++) {
      var why = plainError(bad[i].error);
      out.push({ text: fill(why ? STRINGS.calErrorWhy : STRINGS.calError, { name: calName(bad[i]), why: why }), warn: true });
    }
    if (data && data.truncated === true) out.push({ text: fill(STRINGS.truncated, { n: index ? index.events.length : 500 }) });
    var stale = staleText();
    if (stale) out.push({ text: stale });
    return out;
  }

  function setHint() {
    if (!ui || !ui.hint) return;
    var text = ui.focus === 'tabs' ? STRINGS.hintTabs :
      view === 'day' ? (reading ? STRINGS.hintReading : readable(selectedEvent()) ? STRINGS.hintDayNotes : STRINGS.hintDay) :
      view === 'week' ? STRINGS.hintWeek : STRINGS.hintMonth;
    ui.hint.textContent = text;
  }

  function setLabel() {
    if (!ui || !ui.label) return;
    var td = today();
    var thisYear = ymd(td).y;
    var text;
    if (view === 'day') {
      text = longDate(selDay, ymd(selDay).y !== thisYear);
      if (Math.abs(selDay - td) <= 1) text = relDay(selDay, td) + ' · ' + text;
    } else if (view === 'week') {
      var a = weekStartOf(selDay);
      var pa = ymd(a);
      var pb = ymd(a + 6);
      text = pa.m === pb.m ? fill(STRINGS.fmtRangeSame, { mon: STRINGS.monthsShort[pa.m], a: pa.d, b: pb.d }) : shortDate(a) + ' – ' + shortDate(a + 6);
      if (pb.y !== thisYear) text = fill(STRINGS.fmtWithYear, { s: text, y: pb.y });
    } else {
      var pm = ymd(selDay);
      text = fill(STRINGS.fmtMonthYear, { mon: STRINGS.months[pm.m], y: pm.y });
    }
    ui.label.textContent = text;
    if (selDay === td) ui.today.classList.add('is-here');
    else ui.today.classList.remove('is-here');
  }

  // Redraws only what is under the tabs; the focusable stage stays, so focus does too.
  function drawStage() {
    if (!ui || !ui.stage) return;
    ui.stage.innerHTML = '';
    ui.stage.className = 'cal-stage f cal-stage-' + view + (ui.stage.classList.contains('is-focused') ? ' is-focused' : '');
    for (var k in ui.tabs) {
      if (!ui.tabs.hasOwnProperty(k)) continue;
      if (k === view) ui.tabs[k].classList.add('is-selected'); else ui.tabs[k].classList.remove('is-selected');
    }
    if (view === 'week') drawWeek(ui.stage);
    else if (view === 'month') drawMonth(ui.stage);
    else drawDay(ui.stage);
    setLabel();
    setHint();
  }

  /* ---------- panel: picking ---------- */

  function orderFor(n) { return dayOrder(dayEvents(index, n)); }

  function selectedEvent() { return selId && index ? index.byId['k' + selId] || null : null; }

  // The event to pick on a day: on today the first that hasn't ended, else the first.
  function defaultPick(n) {
    var list = orderFor(n);
    if (!list.length) return null;
    var t = now();
    var td = today();
    if (n === td) {
      for (var i = 0; i < list.length; i++) if (!list[i].allDay && !isPast(list[i], t, td)) return list[i].id;
      for (var j = 0; j < list.length; j++) if (!isPast(list[j], t, td)) return list[j].id;
      return list[list.length - 1].id;
    }
    for (var k = 0; k < list.length; k++) if (!list[k].allDay) return list[k].id;
    return list[0].id;
  }

  // The selected event if it is still on the chosen day; otherwise the day's default.
  function settleSelection() {
    var list = orderFor(selDay);
    for (var i = 0; i < list.length; i++) if (list[i].id === selId) return list;
    selId = defaultPick(selDay);
    return list;
  }

  function setDay(n) {
    var td = today();
    n = Math.max(td - NAV_LIMIT, Math.min(td + NAV_LIMIT, n));
    if (n === selDay) return false;
    selDay = n;
    selId = defaultPick(n);
    return true;
  }

  function stepEvent(dir) {
    var list = settleSelection();
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === selId) at = i;
    var next = at + dir;
    if (next < 0) return false;          // above the first: back to the tabs
    if (next >= list.length) return true; // stay
    selId = list[next].id;
    return true;
  }

  function outsideData(n) {
    var a = parseIso(data.from);
    var b = parseIso(data.to);
    if (isNaN(a) || isNaN(b)) return false;
    return zone.dayStart(n + 1) <= a || zone.dayStart(n) >= b;
  }

  /* ---------- panel: Day ---------- */

  function drawDay(stage) {
    var isFull = full();
    var H = isFull ? 3.6 : 2.5;              // rem per hour
    var minH = isFull ? 1.75 : 1.4;          // rem, the shortest an event is drawn
    var t = now();
    var td = today();
    var de = dayEvents(index, selDay);
    settleSelection();
    pack(de.timed, minH / H * 60);

    var selEv = selectedEvent();
    if (reading && !readable(selEv)) reading = false;
    var wrap = el('div', 'cal-day' + (reading ? ' is-reading' : ''), stage);
    var tl = el('div', 'cal-tl', wrap);
    var detailBox = el('div', 'cal-detail', wrap);

    // All-day strip: up to three chips, always including the chosen one.
    if (de.allDay.length) {
      var strip = el('div', 'cal-allday', tl);
      el('div', 'cal-allday-label', strip, STRINGS.allDay);
      var chips = el('div', 'cal-chips', strip);
      var first = 0;
      for (var a = 0; a < de.allDay.length; a++) if (de.allDay[a].id === selId) first = Math.max(0, a - ALLDAY_CHIPS + 1);
      var shown = de.allDay.slice(first, first + ALLDAY_CHIPS);
      for (var b = 0; b < shown.length; b++) {
        var ev = shown[b];
        var chip = el('div', 'cal-chip' + (ev.id === selId ? ' is-sel' : '') + (isPast(ev, t, td) ? ' is-past' : ''), chips);
        chip.style.backgroundColor = color(ev.cal, 0.24);
        chip.style.borderLeftColor = color(ev.cal);
        el('span', 'cal-chip-text', chip, titleOf(ev));
        clickPick(chip, ev.id);
      }
      var rest = de.allDay.length - shown.length;
      if (rest > 0) el('div', 'cal-chip cal-chip-more', chips, fill(STRINGS.more, { n: rest }));
    }

    var viewBox = el('div', 'cal-tl-view', tl);
    var inner = el('div', 'cal-tl-inner', viewBox);
    inner.style.height = (24 * H) + 'rem';
    for (var h = 0; h < 24; h++) {
      var line = el('div', 'cal-hour', inner);
      line.style.top = (h * H) + 'rem';
      if (h > 0) el('span', 'cal-hour-label', line, hourText(h));
    }
    var cols = el('div', 'cal-cols', inner);
    var selItem = null;
    for (var i = 0; i < de.timed.length; i++) {
      var it = de.timed[i];
      var top = it.startMin / 60 * H;
      var height = Math.max(minH, (it.endMin - it.startMin) / 60 * H);
      if (top + height > 24 * H) top = Math.max(0, 24 * H - height);
      var box = el('div', 'cal-ev' + (it.ev.id === selId ? ' is-sel' : '') + (isPast(it.ev, t, td) ? ' is-past' : '') +
        (height < minH * 1.9 ? ' is-short' : ''), cols);
      box.style.top = top + 'rem';
      box.style.height = height + 'rem';
      box.style.left = (it.col / it.cols * 100) + '%';
      box.style.width = (100 / it.cols) + '%';
      var face = el('div', 'cal-ev-face', box);
      face.style.backgroundColor = color(it.ev.cal, 0.26);
      face.style.borderLeftColor = color(it.ev.cal);
      el('div', 'cal-ev-title', face, titleOf(it.ev));
      var et = el('div', 'cal-ev-time', face, it.before ? fill(STRINGS.untilT, { t: timeText(zone, it.ev.e) }) : timeText(zone, it.ev.s));
      guestTag(et, it.ev);
      clickPick(box, it.ev.id);
      if (it.ev.id === selId) selItem = { top: top, height: height };
    }
    if (selDay === td) {
      ui.nowLine = el('div', 'cal-now', inner);
      ui.nowH = H;
      placeNow();
    } else {
      ui.nowLine = null;
    }

    // Scroll the hours (a transform, nothing reflows) so the chosen event, or
    // now, or the first event, or 8 AM sits in view.
    var rem = remPx();
    var vh = viewBox.offsetHeight / rem;
    var anchor;
    if (selItem) anchor = selItem.top - Math.max(0.3, Math.min(H * 0.8, (vh - selItem.height) / 2));
    else if (selDay === td) anchor = clockMin(t) / 60 * H - vh / 3;
    else if (de.timed.length) anchor = de.timed[0].startMin / 60 * H - H * 0.5;
    else anchor = 8 * H;
    // Start just above an hour line, so no hour label is cut in half at the top.
    anchor = Math.floor(anchor / H) * H - 0.75;
    anchor = Math.max(0, Math.min(24 * H - vh, anchor));
    if (!(anchor >= 0)) anchor = 0;
    inner.style.transform = 'translateY(' + (-anchor) + 'rem)';

    drawDetail(detailBox, de);
  }

  function clockMin(t) { var c = clockOf(zone, t); return c.h * 60 + c.m; }

  // The now line rides on a transform, so moving it each minute is cheap.
  function placeNow() {
    if (!ui || !ui.nowLine) return;
    ui.nowLine.style.transform = 'translateY(' + (clockMin(now()) / 60 * ui.nowH) + 'rem)';
  }

  function updateNow() { placeNow(); }

  function clickPick(node, id) {
    node.addEventListener('click', function () {
      try { selId = id; } catch (e) { /* ignore */ }
    }, false);
  }

  function drawDetail(box, de) {
    var td = today();
    var ev = selId && index.byId['k' + selId];
    var meta = el('div', 'cal-detail-meta', box);
    el('div', 'cal-detail-day', meta, relDay(selDay, td) === STRINGS.today || Math.abs(selDay - td) === 1 ? relDay(selDay, td) : STRINGS.days[weekday(selDay)]);
    if (!ev) {
      el('div', 'cal-detail-empty', meta, index.events.length ? STRINGS.nothingDay : STRINGS.nothingComing);
      if (outsideData(selDay)) el('div', 'cal-detail-note', meta, STRINGS.outside);
      return;
    }
    var c = calendarFor(ev.cal);
    var who = el('div', 'cal-detail-cal', meta);
    var dot = el('span', 'cal-swatch', who);
    dot.style.backgroundColor = color(ev.cal);
    el('span', 'cal-detail-calname', who, calName(c || { cal: ev.cal }));
    el('div', 'cal-detail-title' + (ev.title === 'Busy' ? ' is-busy' : ''), meta, titleOf(ev));
    el('div', 'cal-detail-when', meta, whenText(zone, ev));
    var gtext = guestText(ev);
    if (gtext) el('div', 'cal-detail-guests', meta, gtext);
    if (ev.location) el('div', 'cal-detail-place', meta, ev.location);
    var count = dayOrder(de).length;
    if (count > 1 && !reading) {
      var at = 0;
      var order = dayOrder(de);
      for (var i = 0; i < order.length; i++) if (order[i].id === ev.id) at = i;
      el('div', 'cal-detail-count', meta, (at + 1) + ' / ' + count);
    }
    if (ev.notes && guestOn()) {
      el('div', 'cal-detail-note', meta, STRINGS.notesGuest);
      return;
    }
    var text = notesOf(ev);
    if (!text && !gtext) { ui.readView = null; return; }
    var notes = el('div', 'cal-notes', box);
    var head = el('div', 'cal-notes-head', notes);
    var label = el('div', 'cal-notes-label', head);
    notesMark(label);
    el('span', '', label, text ? STRINGS.notesLabel : STRINGS.guestsLabel);
    var nview = el('div', 'cal-notes-view', notes);
    var body = el('div', 'cal-notes-body', nview);
    // Who is on it comes first: the count, then the names.
    if (gtext) {
      var gb = el('div', 'cal-nb cal-nb-guests', body);
      el('div', 'cal-nb-head', gb, gtext);
      if (ev.guests.length) {
        var more = ev.guestCount - ev.guests.length;
        el('div', 'cal-nb-line', gb, ev.guests.join(', ') + (more > 0 ? ', ' + fill(STRINGS.more, { n: more }) : ''));
      }
    }
    if (text) drawNoteBlocks(body, text);
    if (reading) {
      ui.readView = nview;
      ui.readBody = body;
      scrollNotes(0);
    } else {
      // A preview: whole lines while they fit, faded at the foot when there is
      // more. Under two lines of room it is just the heading and how to read them.
      ui.readView = null;
      el('div', 'cal-notes-more', head, STRINGS.readNotes);
      var first = body.firstChild && body.firstChild.lastChild;
      var lh = first ? parseFloat(window.getComputedStyle(first).lineHeight) || 0 : 0;
      var room = nview.clientHeight;
      var lines = lh > 0 ? Math.floor((room + 1) / lh) : 0;
      if (lines < 2) {
        notes.className += ' is-squeezed';
      } else {
        if (body.offsetHeight > room + 1) {
          nview.style.height = (lines * lh) + 'px';
          notes.className += ' is-more is-clipped';
        }
      }
    }
  }

  // Scrolls the open notes by dir pages (a transform; nothing reflows).
  // Returns false at the top going up.
  function scrollNotes(dir) {
    if (!ui || !ui.readView || !ui.readBody) return true;
    var rem = remPx();
    var vh = ui.readView.clientHeight / rem;
    var max = Math.max(0, ui.readBody.offsetHeight / rem - vh);
    var step = Math.max(1, vh * 0.35);
    var next = Math.max(0, Math.min(max, readTop + dir * step));
    if (dir < 0 && readTop <= 0) return false;
    readTop = next;
    ui.readBody.style.transform = 'translateY(' + (-readTop) + 'rem)';
    if (readTop < max - 0.05) ui.readView.parentNode.classList.add('is-more');
    else ui.readView.parentNode.classList.remove('is-more');
    return true;
  }

  function openNotes() {
    if (view !== 'day' || !readable(selectedEvent())) return false;
    reading = true;
    readTop = 0;
    drawStage();
    return true;
  }

  function closeNotes() {
    if (!reading) return false;
    reading = false;
    readTop = 0;
    drawStage();
    return true;
  }

  /* ---------- panel: Week ---------- */

  function drawWeek(stage) {
    var t = now();
    var td = today();
    var start = weekStartOf(selDay);
    settleSelection();
    var wrap = el('div', 'cal-week', stage);
    var colsBox = el('div', 'cal-wcols', wrap);
    var scrolls = [];
    for (var d = 0; d < 7; d++) {
      var n = start + d;
      var de = dayEvents(index, n);
      var col = el('div', 'cal-wcol' + (n === selDay ? ' is-sel' : '') + (n === td ? ' is-today' : '') + (n < td ? ' is-past' : ''), colsBox);
      var head = el('div', 'cal-whead', col);
      el('span', 'cal-wdow', head, STRINGS.daysShort[weekday(n)]);
      el('span', 'cal-wnum', head, String(ymd(n).d));
      var listView = el('div', 'cal-wlist-view', col);
      var list = el('div', 'cal-wlist', listView);
      var selNode = null;
      var order = dayOrder(de);
      for (var i = 0; i < order.length; i++) {
        var ev = order[i];
        var item = el('div', 'cal-wev' + (ev.allDay ? ' is-allday' : '') + (ev.id === selId && n === selDay ? ' is-sel' : '') +
          (isPast(ev, t, td) ? ' is-past' : ''), list);
        if (ev.allDay) {
          item.style.backgroundColor = color(ev.cal, 0.24);
          item.style.borderLeftColor = color(ev.cal);
          el('div', 'cal-wev-title', item, titleOf(ev));
        } else {
          item.style.borderLeftColor = color(ev.cal);
          var startsHere = zone.dayOf(ev.s) === n;
          var wt = el('div', 'cal-wev-time', item, startsHere ? timeText(zone, ev.s) : fill(STRINGS.untilT, { t: timeText(zone, ev.e) }));
          guestTag(wt, ev, true);
          el('div', 'cal-wev-title', item, titleOf(ev));
        }
        clickPickDay(item, n, ev.id);
        if (n === selDay && ev.id === selId) selNode = item;
      }
      if (!order.length) el('div', 'cal-wempty', list, '–');
      clickPickDay(head, n, null);
      var more = el('div', 'cal-wmore', col);
      scrolls.push({ view: listView, list: list, sel: selNode, more: more, count: order.length });
    }
    var strip = el('div', 'cal-wdetail', wrap);
    var ev2 = selId && index.byId['k' + selId];
    if (ev2) {
      var sw = el('span', 'cal-swatch', strip);
      sw.style.backgroundColor = color(ev2.cal);
      el('span', 'cal-wdetail-when', strip, whenText(zone, ev2));
      el('span', 'cal-wdetail-title', strip, titleOf(ev2));
      var extra = [];
      if (guestText(ev2)) extra.push(guestText(ev2));
      if (ev2.location) extra.push(ev2.location);
      extra.push(calName(calendarFor(ev2.cal) || { cal: ev2.cal }));
      el('span', 'cal-wdetail-more', strip, extra.join(' · '));
    } else {
      el('span', 'cal-wdetail-empty', strip, !index.events.length ? STRINGS.nothingComing : relDay(selDay, td) + ': ' + STRINGS.nothingDay +
        (outsideData(selDay) ? ' ' + STRINGS.outside : ''));
    }
    // Each column scrolls (by a transform) to keep its chosen event in view,
    // and says how many are out of sight below.
    for (var k = 0; k < scrolls.length; k++) {
      var s = scrolls[k];
      var vh = s.view.clientHeight;
      var shift = 0;
      if (s.sel && s.sel.offsetTop + s.sel.offsetHeight > vh) shift = s.sel.offsetTop + s.sel.offsetHeight - vh + 2;
      if (shift) s.list.style.transform = 'translateY(' + (-shift) + 'px)';
      var hidden = 0;
      var items = s.list.childNodes;
      for (var m = 0; m < items.length; m++) {
        if (items[m].offsetTop + items[m].offsetHeight - shift > vh + 1 || items[m].offsetTop - shift < -1) hidden++;
      }
      s.more.textContent = hidden ? fill(STRINGS.more, { n: hidden }) : '';
      if (!hidden) s.more.style.visibility = 'hidden';
    }
  }

  function clickPickDay(node, n, id) {
    node.addEventListener('click', function () {
      selDay = n;
      selId = id || defaultPick(n);
    }, false);
  }

  /* ---------- panel: Month ---------- */

  function gridStart(n) { return weekStartOf(monthStartOf(n)); }

  function drawMonth(stage) {
    var td = today();
    var t = now();
    var wrap = el('div', 'cal-month', stage);
    var grid = el('div', 'cal-grid', wrap);
    var head = el('div', 'cal-grow cal-ghead', grid);
    var d;
    for (d = 0; d < 7; d++) el('div', 'cal-gdow', head, STRINGS.daysMin[(WEEK_START + d) % 7]);
    var start = gridStart(selDay);
    var month = ymd(selDay).m;
    for (var r = 0; r < 6; r++) {
      var row = el('div', 'cal-grow', grid);
      for (d = 0; d < 7; d++) {
        var n = start + r * 7 + d;
        var p = ymd(n);
        var cell = el('div', 'cal-cell' + (p.m !== month ? ' is-other' : '') + (n === td ? ' is-today' : '') +
          (n === selDay ? ' is-sel' : '') + (n < td ? ' is-past' : ''), row);
        var num = el('div', 'cal-cell-num', cell);
        el('span', 'cal-cell-numtext', num, String(p.d));
        var list = index.byDay[n] || [];
        if (list.length) {
          var dots = el('div', 'cal-dots', cell);
          var seen = {};
          var count = 0;
          for (var i = 0; i < list.length && count < 4; i++) {
            if (seen[list[i].cal]) continue;
            seen[list[i].cal] = true;
            count++;
            var dot = el('span', 'cal-dot', dots);
            dot.style.backgroundColor = color(list[i].cal);
          }
        }
        clickPickDay(cell, n, null);
      }
    }
    var side = el('div', 'cal-mlist', wrap);
    el('div', 'cal-mlist-day', side, relDay(selDay, td) === STRINGS.today ? STRINGS.today + ' · ' + longDate(selDay, false) : longDate(selDay, false));
    var de = dayEvents(index, selDay);
    var order = dayOrder(de);
    var box = el('div', 'cal-mlist-items', side);
    var more = el('div', 'cal-more', side);
    more.style.display = 'none';
    if (!order.length) {
      el('div', 'cal-detail-empty', box, index.events.length ? STRINGS.nothingDay : STRINGS.nothingComing);
      if (outsideData(selDay)) el('div', 'cal-detail-note', box, STRINGS.outside);
      return;
    }
    var rows = [];
    for (var k = 0; k < order.length; k++) {
      var ev = order[k];
      var item = el('div', 'cal-mev' + (isPast(ev, t, td) ? ' is-past' : ''));
      bar(item, ev.cal);
      var text = el('div', 'cal-mev-text', item);
      var mw = el('div', 'cal-mev-when', text, ev.allDay ? STRINGS.allDay : (zone.dayOf(ev.s) === selDay ? timeText(zone, ev.s) : fill(STRINGS.untilT, { t: timeText(zone, ev.e) })));
      guestTag(mw, ev);
      el('div', 'cal-mev-title', text, titleOf(ev));
      rows.push(item);
    }
    fitRows(box, more, rows);
  }

  /* ---------- panel: keys ---------- */

  function isTab(node) { return !!node && node.classList && (node.classList.contains('cal-tab') || node.classList.contains('cal-today')); }

  function onMove(dir, from) {
    if (!ui || !ui.stage) return undefined;
    if (from === ui.stage) return moveInStage(dir);
    if (isTab(from)) {
      if (dir === 'down') return ui.stage;
      return undefined;   // Left and Right walk the row; Up reaches Full screen
    }
    // The hub's Full screen button: Down goes to the current tab.
    if (dir === 'down' && ui.root && !ui.root.contains(from)) return ui.tabs[view];
    return undefined;
  }

  function moveInStage(dir) {
    var td = today();
    if (view === 'day') {
      if (reading) {
        if (dir === 'down') { scrollNotes(1); return true; }
        if (dir === 'up') { if (!scrollNotes(-1)) closeNotes(); return true; }
        closeNotes();
        return true;
      }
      if (dir === 'left' || dir === 'right') { if (setDay(selDay + (dir === 'left' ? -1 : 1))) drawStage(); return true; }
      if (!stepEvent(dir === 'up' ? -1 : 1)) return ui.tabs[view];
      drawStage();
      return true;
    }
    if (view === 'week') {
      if (dir === 'left' || dir === 'right') { if (setDay(selDay + (dir === 'left' ? -1 : 1))) drawStage(); return true; }
      if (!stepEvent(dir === 'up' ? -1 : 1)) return ui.tabs[view];
      drawStage();
      return true;
    }
    // Month
    var step = dir === 'left' ? -1 : dir === 'right' ? 1 : dir === 'up' ? -7 : 7;
    if (dir === 'up' && selDay - 7 < gridStart(selDay)) return ui.tabs[view];
    if (setDay(selDay + step)) drawStage();
    return true;
  }

  function showView(next) {
    if (view === next || !ui) return;
    view = next;
    reading = false;
    drawStage();
  }

  /* ---------- widget ---------- */

  function fallbackText(body) {
    try {
      body.innerHTML = '';
      el('div', 'cal-msg-line cal-broken', body, STRINGS.error);
    } catch (e) { /* nothing more to do */ }
  }

  return {
    id: 'calendar',
    get title() { return STRINGS.title; },
    icon: 'calendar',
    expandable: true,
    activity: 'calendar',      // its working chip (app/motion.js)

    init: function (ctx) {
      C = ctx;
      var L = live();
      if (L) {
        loadCache();
        try {
          var current = L.get('calendar');
          if (validData(current)) { lastLiveAt = now(); useData(current, false); liveEvents = eventsKey(current); }
        } catch (e) { /* wait for it */ }
        L.on('calendar', safe(function (d) { onLive(d); }));
      }
      // A language change: new words, the tile and an open panel drawn again.
      try {
        if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') {
          window.HUB_I18N.onChange(function () {
            try { localizeStrings(); refresh(true); } catch (e) { warn('language: ' + (e && e.message)); }
          });
        }
      } catch (e) { /* stays in the language it started in */ }
      // Guest mode hides notes: draw again when it changes.
      try {
        if (window.HUB_GUEST && typeof window.HUB_GUEST.onChange === 'function') {
          window.HUB_GUEST.onChange(function () {
            try { if (guestOn()) reading = false; refresh(true); } catch (e) { warn('guest: ' + (e && e.message)); }
          });
        }
      } catch (e) { /* notes follow the next draw */ }
      // Spanish for event titles arrived: draw again once per batch, not while typing.
      try {
        if (window.HUB_I18N && typeof window.HUB_I18N.onDyn === 'function') {
          var dynTimer = null;
          window.HUB_I18N.onDyn(function () {
            if (dynTimer) return;
            dynTimer = setTimeout(function () {
              dynTimer = null;
              try {
                var ae = document.activeElement;
                if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;
                refresh(true);
              } catch (e2) { warn('translation: ' + (e2 && e2.message)); }
            }, 120);
          });
        }
      } catch (e1) { /* stays as typed */ }
      lastToday = today();
      tileSig = signature();
      shownState = stateNow();
      schedule();
    },

    renderTile: function (body, ctx) {
      C = ctx;
      try {
        drawTile(body);
      } catch (e) {
        warn('tile: ' + (e && e.message));
        fallbackText(body);
      }
    },

    renderPanel: function (body, ctx) {
      C = ctx;
      try {
        drawPanel(body);
      } catch (e) {
        warn('panel: ' + (e && e.message));
        ui = null;
        fallbackText(body);
      }
    },

    // Live updates changed state: the message may change, or stale data may become fresh.
    onStatus: function () {
      try {
        var s = stateNow();
        if (liveStatus().state === 'live' && index && !fromCache) lastLiveAt = now();
        if (s !== shownState) { shownState = s; refresh(true); } else refresh(false);
      } catch (e) { /* the next change tries again */ }
    },

    onFocus: function (target) {
      if (!ui) return;
      var key = target.getAttribute('data-key') || '';
      if (key.indexOf('tab-') === 0) showView(key.substring(4));
      ui.focus = target === ui.stage ? 'stage' : 'tabs';
      setHint();
    },

    onMove: onMove,

    onSelect: function (target, ctx) {
      if (!ui) return;
      var key = target.getAttribute('data-key') || '';
      if (key.indexOf('tab-') === 0) { showView(key.substring(4)); ctx.focus(ui.stage); return; }
      if (key === 'today') {
        reading = false;
        selDay = today();
        selId = defaultPick(selDay);
        drawStage();
        return;
      }
      // OK on Week or Month opens the chosen day (a click has already picked it).
      if (target === ui.stage) {
        if (view === 'day') {
          if (reading) closeNotes();
          else if (!openNotes()) drawStage();
          return;
        }
        view = 'day';
        drawStage();
      }
    },

    // Back while reading notes closes them; otherwise the hub closes the panel.
    onBack: function () { return closeNotes(); },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },

    onClose: function () {
      panelOpen = false;
      reading = false;
      ui = null;
    }
  };
})());
