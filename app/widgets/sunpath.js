/*
 * Plant sun (sunpath): when direct sun reaches the plant wall, worked out
 * from where the sun is (the NOAA solar position formulas) and what the
 * window can see. Ported from Ian's "Plant Wall Sun Path" page.
 *
 * The window faces about 306 degrees true. Seen from inside it opens onto
 * 260 to 345 degrees on a phone compass, 263.3 to 348.3 true once the
 * magnetic declination (MAG_DECLINATION) is added. The balcony roof blocks
 * the sun above roofAngle. The plant wall is to the right of the right
 * window, gapFeet from its right edge; the plants sit plantFromWindowFeet
 * into the room, plantHeightFeet off the floor. All of these, the place and
 * the plants are in HUB_CONFIG.widgets.sunpath (app/config.js); roofAngle
 * and gapFeet are estimates until measured, and the tile and panel say so
 * while placeholder is true.
 *
 * Times are the TV's own clock and time zone: sunpos() takes UTC ms, and a
 * day's times are made with new Date(y, m, d, 0, minute), so daylight
 * saving needs no table.
 *
 *   1 column   only the answer: "Now", a time, or a date
 *   strip      one line: "Sun on the plants now · until 6:26 PM",
 *              "Next sun at 5:20 PM", "Next sun Mar 14, 7:20 PM"
 *   standard   the answer, then today's sun window(s) on a small day bar,
 *              or (November to February) "grow lights do the work"
 *   tall       adds the season table: Dec 21, Mar 20, Jun 21, Sep 22
 *   panel      a time slider (Left and Right: 15 minutes), a day chooser
 *              (today, Dec 21, Mar 20, Jun 21, Sep 22), what the sun does
 *              then, and one of three views: the room from above, the sun's
 *              arc against the window, the seasons with the plant notes
 *   full       all three views at once
 *
 * Everything that can't fit leaves, lowest first, measured once after each
 * draw. The next sun is searched for once and kept until it passes, the
 * day changes or an hour goes by; a minute timer looks, nothing faster.
 * The one thing that moves is a slow glow on the tile while the sun is on
 * the plants (opacity only, and only in push or expand motion).
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  /* ---------- the window, the room, the search ---------- */

  var MAG_DECLINATION = 3.3;          // degrees east: true bearing = compass bearing + this
  var VIEW_MAG_FROM = 260;            // the window's view on a phone compass (magnetic)
  var VIEW_MAG_TO = 345;
  var AZ_LO = VIEW_MAG_FROM + MAG_DECLINATION;   // 263.3 true
  var AZ_HI = VIEW_MAG_TO + MAG_DECLINATION;     // 348.3 true
  var FACE = (AZ_LO + AZ_HI) / 2;                // 305.8 true: straight out of the window
  var WIN_W = 23 / 12;                // the right window: 23 in wide
  var SILL = 28.5 / 12;               // sill 28.5 in off the floor
  var WIN_H = 4.5;                    // 4.5 ft tall with the shades up
  var WIN_TOP = SILL + WIN_H;
  var PLANT_SLACK = 0.5;              // ft above and below the plant height that still counts

  var DAY_FROM = 10 * 60;             // a day's sun is looked for from 10 AM...
  var DAY_TO = 22 * 60;               // ...to 10 PM (minutes after midnight)
  var SCAN_FROM = 12 * 60;            // the forward search: afternoons only
  var SCAN_TO = 21 * 60 + 30;
  var SCAN_STEP = 15;                 // minutes
  var SCAN_DAYS = 370;
  var CACHE_MS = 3600000;             // the answer is worked out again at least hourly
  var SLIDE_FROM = 12 * 60;           // the panel's time slider: noon...
  var SLIDE_TO = 21 * 60;             // ...to 9 PM
  var SLIDE_STEP = 15;
  var WINTER_DAYS = 7;                // a next sun this far off: the grow lights line shows

  var SEASONS = [
    { k: 'dec', m: 11, d: 21 },
    { k: 'mar', m: 2, d: 20 },
    { k: 'jun', m: 5, d: 21 },
    { k: 'sep', m: 8, d: 22 }
  ];
  var SEASON_COLORS = { dec: '#7fb2ff', mar: '#7ed9a0', jun: '#ffd166', sep: '#e59cff', today: '#f4f5f7' };

  /* ---------- words ---------- */

  var EN = {
    title: 'Plant sun',
    titleShort: 'Sun',
    badge: 'Estimate',
    am: 'AM',
    pm: 'PM',
    dateShort: '{mon} {d}',
    nowHead: 'Sun on the plants now',
    nowShort: 'Sun now',
    until: 'until {t}',
    untilWord: 'until',
    nextToday: 'Next sun at {t}',
    nextTomorrow: 'Next sun tomorrow {t}',
    nextDate: 'Next sun {d}, {t}',
    nextDateShort: 'Next sun {d}',
    nextWord: 'Next sun',
    nextTomorrowWord: 'Next sun tomorrow',
    atTime: 'at {t}',
    noneHead: 'No direct sun ahead',
    noneLine: 'Not in the coming year with these settings.',
    one: { now: 'Now', tomorrow: 'Tmrw', none: 'None' },
    today: 'Today',
    todayNone: 'No sun on the plants today',
    growUntil: 'Grow lights do the work until then',
    keepOut: 'Keep the {plant} out of the beam.',
    range: '{a} to {b}',
    none: 'None',
    table: { day: 'Day', window: 'In the window', plants: 'On the plants' },
    panel: {
      time: 'Time',
      day: 'Day',
      views: { plan: 'Room', arc: 'Sun arc', table: 'Seasons' },
      stepHint: '← → 15 min'
    },
    status: {
      lit: 'Direct sun on the wall. Keep the {plant} out of the beam.',
      room: 'Sun inside the room, not on the plants.',
      down: 'The sun is down.',
      side: 'Outside the window’s view: no direct sun inside.',
      roof: 'Above the roof line: no direct sun inside.',
      at: 'Sun {alt}° up at {az}° true'
    },
    plan: { window: 'Window', wall: 'Plant wall', plants: 'Plants', outside: 'Outside', north: 'N', ft: '{n} ft' },
    arc: { view: 'Window view', roof: 'Roof above {r}°', w: 'W', nw: 'NW', n: 'N' },
    notes: {
      plantsHead: 'The plants',
      plants: '{list}. Keep the {plant} out of the summer evening beam.',
      growHead: 'Grow lights',
      grow: 'No direct sun reaches the wall from November to February: the 11W full-spectrum bulbs do the work in those months.',
      placeTag: 'Placeholder',
      place: 'Roof angle {r}° and wall gap {g} ft are estimates.'
    }
  };
  var S = EN;

  function I18N() {
    var L = window.HUB_I18N;
    return L && typeof L.t === 'function' ? L : null;
  }
  function localize() {
    var L = I18N();
    try { S = L && typeof L.localize === 'function' ? L.localize(EN, 'sunpath') : EN; } catch (e) { S = EN; }
  }
  localize();

  function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (all, n) {
      return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all;
    });
  }

  var NB = ' ';
  function nb(s) { return String(s).replace(/ /g, NB); }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // "6:05 PM" ("6:05 p. m." in Spanish), held together on one line.
  function fmtTime(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var ap = h >= 12 ? S.pm : S.am;
    return (h % 12 || 12) + ':' + pad2(d.getMinutes()) + NB + nb(ap);
  }
  // Without AM/PM, for the 1-column tile and ranges in one half of the day.
  function fmtClock(ms) {
    var d = new Date(ms);
    return (d.getHours() % 12 || 12) + ':' + pad2(d.getMinutes());
  }
  function ampm(ms) { return nb(new Date(ms).getHours() >= 12 ? S.pm : S.am); }

  function monShort(d) {
    var L = I18N();
    if (L && typeof L.monthName === 'function') return L.monthName(d, true);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  }
  function fmtDate(ms) {
    var d = new Date(ms);
    return nb(fill(S.dateShort, { mon: monShort(d), d: d.getDate() }));
  }
  // "5:20 to 6:26 PM" (one AM/PM when both ends share it).
  function fmtRange(a, b) {
    var same = new Date(a).getHours() >= 12 === new Date(b).getHours() >= 12;
    return fill(S.range, { a: same ? fmtClock(a) : fmtTime(a), b: fmtTime(b) });
  }

  /* ---------- settings ---------- */

  var P = null;

  function num(v, dflt) { return typeof v === 'number' && isFinite(v) ? v : dflt; }

  function settings(config) {
    var c = config || {};
    var all = (window.HUB_CONFIG && window.HUB_CONFIG.widgets) || {};
    var wl = all.weather && all.weather.location;
    var lat = num(c.latitude, wl && typeof wl === 'object' ? num(wl.latitude, 32.78) : 32.78);
    var lon = num(c.longitude, wl && typeof wl === 'object' ? num(wl.longitude, -96.78) : -96.78);
    var plants = c.plants && c.plants.length ? c.plants.slice(0, 8) : ['4in Birkin philodendron', 'Golden pothos', 'Maranta Gold Lines'];
    return {
      lat: lat,
      lon: lon,
      roof: num(c.roofAngle, 40),
      gap: num(c.gapFeet, 2),
      depth: num(c.plantFromWindowFeet, 56 / 12),
      height: num(c.plantHeightFeet, 3),
      placeholder: c.placeholder !== false,
      plants: plants,
      shy: typeof c.keepOutOfSun === 'string' && c.keepOutOfSun ? c.keepOutOfSun : plants[plants.length - 1]
    };
  }

  /* ---------- the sun (NOAA) ---------- */

  function rad(x) { return x * Math.PI / 180; }
  function deg(x) { return x * 180 / Math.PI; }

  // Altitude and azimuth (degrees true) of the sun at UTC ms, for lat/lon.
  function sunpos(ms, lat, lon) {
    var jd = ms / 86400000 + 2440587.5;
    var T = (jd - 2451545) / 36525;
    var L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    var M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    var C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(rad(M)) +
      (0.019993 - 0.000101 * T) * Math.sin(rad(2 * M)) + 0.000289 * Math.sin(rad(3 * M));
    var om = 125.04 - 1934.136 * T;
    var lam = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(om));
    var eps = 23.439291 - 0.0130042 * T + 0.00256 * Math.cos(rad(om));
    var dec = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lam)));
    var y = Math.pow(Math.tan(rad(eps / 2)), 2);
    var e = 0.016708634;
    var eot = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) +
      4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0)) -
      1.25 * e * e * Math.sin(2 * rad(M)));
    var mins = (((ms / 60000) % 1440) + 1440) % 1440;
    var tst = ((mins + eot + 4 * lon) % 1440 + 1440) % 1440;
    var ha = rad(tst / 4 - 180);
    var la = rad(lat);
    var alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
    var az = deg(Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(dec) * Math.cos(la))) + 180;
    return { alt: deg(alt), az: ((az % 360) + 360) % 360 };
  }

  function sunAt(ms) { return sunpos(ms, P.lat, P.lon); }

  // Gets through the window: up, inside the view, under the roof.
  function enters(s) { return s.alt > 0 && s.alt <= P.roof && s.az >= AZ_LO && s.az <= AZ_HI; }

  // Lands on the plant spot: the beam through the window reaches the plant
  // wall at the plants' depth, at their height.
  function hitsPlant(s) {
    if (!enters(s)) return false;
    var d = s.az - FACE;
    if (d >= 0) return false;                // sun to the right: the beam goes left, away from the wall
    var t = Math.tan(rad(-d));
    var y0 = P.gap / t;
    var y1 = (WIN_W + P.gap) / t;
    if (P.depth < y0 || P.depth > y1) return false;
    var drop = (P.depth / Math.cos(rad(d))) * Math.tan(rad(s.alt));
    return P.height + PLANT_SLACK >= SILL - drop && P.height - PLANT_SLACK <= WIN_TOP - drop;
  }

  // What the sun does at ms, in one word.
  function stateAt(ms) {
    var s = sunAt(ms);
    var k = s.alt <= 0 ? 'down' : hitsPlant(s) ? 'lit' : enters(s) ? 'room' :
      (s.az < AZ_LO || s.az > AZ_HI) ? 'side' : 'roof';
    return { sun: s, k: k };
  }

  /* ---------- a day's sun, the next sun ---------- */

  function msAt(y, m, d, minute) { return new Date(y, m, d, 0, minute).getTime(); }

  // The stretches of a local day when fn(sun) holds: [{ start, end }] in ms,
  // end being the first minute without. 5-minute look, then to the minute.
  function spans(y, m, d, fn, from, to) {
    from = from === undefined ? DAY_FROM : from;
    to = to === undefined ? DAY_TO : to;
    var out = [];
    var on = false;
    var start = 0;
    function at(min) { return fn(sunAt(msAt(y, m, d, min))); }
    function edge(lo, hi, want) {           // first minute in (lo, hi] where at() === want
      for (var k = lo + 1; k <= hi; k++) if (at(k) === want) return k;
      return hi;
    }
    var prev = from;
    for (var min = from; min <= to; min += 5) {
      var now = at(min);
      if (now && !on) { start = min === from ? from : edge(prev, min, true); on = true; }
      else if (!now && on) { out.push({ start: msAt(y, m, d, start), end: msAt(y, m, d, edge(prev, min, false)) }); on = false; }
      prev = min;
    }
    if (on) out.push({ start: msAt(y, m, d, start), end: msAt(y, m, d, to) });
    return out;
  }

  function daySpans(date, fn) { return spans(date.getFullYear(), date.getMonth(), date.getDate(), fn); }

  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  // The answer for the tile, worked out from scratch:
  //   { k: 'now', end } | { k: 'later', start, end, days } | { k: 'none' }
  // days: 0 today, 1 tomorrow, more for a date further on.
  function search(nowMs) {
    var today = new Date(nowMs);
    var list = daySpans(today, hitsPlant);
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].start <= nowMs && nowMs < list[i].end) return { k: 'now', start: list[i].start, end: list[i].end, today: list };
      if (list[i].start > nowMs) return { k: 'later', start: list[i].start, end: list[i].end, days: 0, today: list };
    }
    var y = today.getFullYear();
    var m = today.getMonth();
    var d = today.getDate();
    for (var n = 1; n <= SCAN_DAYS; n++) {
      var hit = false;
      for (var min = SCAN_FROM; min <= SCAN_TO && !hit; min += SCAN_STEP) hit = hitsPlant(sunAt(msAt(y, m, d + n, min)));
      if (!hit) continue;
      var day = new Date(y, m, d + n);
      var found = spans(day.getFullYear(), day.getMonth(), day.getDate(), hitsPlant);
      if (found.length) return { k: 'later', start: found[0].start, end: found[0].end, days: n, today: list };
    }
    return { k: 'none', today: list };
  }

  var cache = null;    // { result, day, at }

  function answer(nowMs) {
    var key = dayKey(new Date(nowMs));
    var c = cache;
    var stale = !c || c.day !== key || nowMs - c.at >= CACHE_MS || nowMs < c.at ||
      (c.result.k === 'now' && nowMs >= c.result.end) ||
      (c.result.k === 'later' && nowMs >= c.result.start);
    if (stale) cache = c = { result: search(nowMs), day: key, at: nowMs };
    return c.result;
  }

  // A short signature of what the tile shows, to redraw only on a change.
  function signature(nowMs) {
    var a = answer(nowMs);
    var d = new Date(nowMs);
    // The day bar's "now" tick moves a step each quarter hour.
    return [a.k, a.start || 0, a.end || 0, a.days || 0, dayKey(d), Math.floor((d.getHours() * 60 + d.getMinutes()) / 15)].join('|');
  }

  /* ---------- small helpers ---------- */

  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null && text !== '') n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function div(cls, parent, text) { return el('div', cls, parent, text); }
  function span(cls, parent, text) { return el('span', cls, parent, text); }

  function rem() { return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16; }
  function fontPx(n) { return parseFloat(window.getComputedStyle(n).fontSize) || 16; }

  function shrink(n, minRem, fits) {
    var min = minRem * rem();
    var size = fontPx(n);
    for (var i = 0; i < 30 && !fits() && size > min; i++) {
      size = Math.max(min, size * 0.92);
      n.style.fontSize = size.toFixed(1) + 'px';
    }
    return fits();
  }

  function fitsWidth(n) { return n.scrollWidth <= n.clientWidth + 1; }
  function drop(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }

  function clampLines(n, lines) {
    n.style.display = '-webkit-box';
    n.style.webkitBoxOrient = 'vertical';
    n.style.webkitLineClamp = String(lines);
    n.style.overflow = 'hidden';
  }
  function lineHeight(n) {
    var cs = window.getComputedStyle(n);
    return parseFloat(cs.lineHeight) || fontPx(n) * 1.35;
  }

  function sunDot(parent) { return span('sp-dot', parent); }

  function now() { return new Date().getTime(); }

  function yearOf(ms) { return new Date(ms).getFullYear(); }

  function seasonDate(s, ms) { return new Date(yearOf(ms), s.m, s.d); }

  // "Dec 21" ("21 dic"): the season days by the hub's month names.
  function seasonName(k, ms) {
    for (var i = 0; i < SEASONS.length; i++) if (SEASONS[i].k === k) return fmtDate(seasonDate(SEASONS[i], ms).getTime());
    return S.today;
  }

  /* ---------- the tile ---------- */

  var shown = '';      // signature drawn on the tile
  var tileCtx = null;

  function answerWords(a, nowMs) {
    // Kicker, big and sub, for the 2-row and taller tiles.
    if (a.k === 'now') return { kicker: S.nowHead, bigPre: S.untilWord, big: fmtTime(a.end), sub: '' };
    if (a.k === 'none') return { kicker: S.noneHead, big: '', sub: S.noneLine };
    if (a.days === 0) return { kicker: S.nextWord, big: fmtTime(a.start), sub: S.today };
    if (a.days === 1) return { kicker: S.nextTomorrowWord, big: fmtTime(a.start), sub: '' };
    return { kicker: S.nextWord, big: fmtDate(a.start), sub: fill(S.atTime, { t: fmtTime(a.start) }) };
  }

  // The strip's line, longest first.
  function stripLines(a) {
    if (a.k === 'now') {
      return [S.nowHead + ' · ' + fill(S.until, { t: fmtTime(a.end) }), S.nowShort + ' · ' + fill(S.until, { t: fmtTime(a.end) }), S.nowHead, S.nowShort];
    }
    if (a.k === 'none') return [S.noneHead, S.one.none];
    var t = fmtTime(a.start);
    if (a.days === 0) return [fill(S.nextToday, { t: t }), t];
    if (a.days === 1) return [fill(S.nextTomorrow, { t: t }), S.one.tomorrow + ' ' + t];
    var d = fmtDate(a.start);
    return [fill(S.nextDate, { d: d, t: t }), fill(S.nextDateShort, { d: d }), d];
  }

  function drawOne(body, a) {
    var box = div('sp-one', body);
    var top = '';
    var big = '';
    var sub = '';
    if (a.k === 'now') { big = S.one.now; sub = fill(S.until, { t: fmtTime(a.end) }); }
    else if (a.k === 'none') big = S.one.none;
    else if (a.days >= 2) { var dd = new Date(a.start); top = nb(monShort(dd)); big = String(dd.getDate()); }
    else { big = fmtClock(a.start); sub = ampm(a.start); if (a.days === 1) top = S.one.tomorrow; }
    if (top) div('sp-one-top', box, top);
    var b = div('sp-one-big', box, big);
    var s = sub ? div('sp-one-sub', box, sub) : null;
    var fits = function () { return box.scrollHeight <= box.clientHeight + 1 && fitsWidth(box) && fitsWidth(b) && (!s || fitsWidth(s)); };
    if (s && !fits()) shrink(s, 0.8, function () { return fitsWidth(s); });
    if (s && !fits()) { drop(s); s = null; }
    shrink(b, 0.8, fits);
  }

  // Every part of the line inside it (an inline span can poke out by a
  // pixel that scrollWidth rounds away), and the line inside the body.
  function lineFits(line, body) {
    if (line.scrollWidth > line.clientWidth + 1) return false;
    var r = line.getBoundingClientRect();
    for (var i = 0; i < line.childNodes.length; i++) {
      var c = line.childNodes[i];
      if (!c.getBoundingClientRect) continue;
      var cr = c.getBoundingClientRect();
      if (cr.right > r.right + 0.25 || cr.left < r.left - 0.25) return false;
    }
    return line.offsetHeight <= body.clientHeight + 1;
  }

  function drawStrip(body, a) {
    var line = div('sp-line' + (a.k === 'now' ? ' is-lit' : ''), body);
    var dot = a.k === 'now' ? sunDot(line) : null;
    var words = span('sp-line-words', line);
    var list = stripLines(a);
    var fits = function () { return lineFits(line, body); };
    for (var i = 0; i < list.length; i++) {
      words.textContent = list[i];
      line.style.fontSize = '';
      if (shrink(line, 1.0, fits)) return;
    }
    if (dot) drop(dot);
    line.style.fontSize = '';
    if (!shrink(line, 0.85, fits)) line.className += ' is-cut';
  }

  // A day from noon to 9 PM: the window's light dim, the plants' bright, now a tick.
  function dayBar(parent, date, nowMs, showNow) {
    var bar = div('sp-bar', parent);
    var track = div('sp-bar-track', bar);
    var y = date.getFullYear();
    var m = date.getMonth();
    var d = date.getDate();
    var a = msAt(y, m, d, SLIDE_FROM);
    var b = msAt(y, m, d, SLIDE_TO);
    function seg(cls, s) {
      var l = Math.max(0, (s.start - a) / (b - a));
      var r = Math.min(1, (s.end - a) / (b - a));
      if (r <= l) return;
      var n = div(cls, track);
      n.style.left = (l * 100).toFixed(2) + '%';
      n.style.width = ((r - l) * 100).toFixed(2) + '%';
    }
    var win = spans(y, m, d, enters, SLIDE_FROM, SLIDE_TO);
    var lit = spans(y, m, d, hitsPlant, SLIDE_FROM, SLIDE_TO);
    for (var i = 0; i < win.length; i++) seg('sp-bar-win', win[i]);
    for (var j = 0; j < lit.length; j++) seg('sp-bar-lit', lit[j]);
    if (showNow && nowMs >= a && nowMs <= b) {
      var t = div('sp-bar-now', track);
      t.style.left = ((nowMs - a) / (b - a) * 100).toFixed(2) + '%';
    }
    return bar;
  }

  function seasonRows(nowMs) {
    var rows = [];
    for (var i = 0; i < SEASONS.length; i++) {
      var day = seasonDate(SEASONS[i], nowMs);
      rows.push({ k: SEASONS[i].k, name: fmtDate(day.getTime()), win: daySpans(day, enters), lit: daySpans(day, hitsPlant) });
    }
    return rows;
  }

  function spanText(list) {
    if (!list.length) return S.none;
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(fmtRange(list[i].start, list[i].end));
    return out.join(', ');
  }

  function seasonTable(parent, nowMs, cls) {
    var t = div('sp-table ' + (cls || ''), parent);
    var head = div('sp-tr sp-th', t);
    div('sp-td sp-td-day', head, S.table.day);
    div('sp-td sp-td-win', head, S.table.window);
    div('sp-td sp-td-lit', head, S.table.plants);
    var rows = seasonRows(nowMs);
    for (var i = 0; i < rows.length; i++) {
      var r = div('sp-tr', t);
      var dayCell = div('sp-td sp-td-day', r);
      var key = span('sp-key', dayCell);
      key.style.backgroundColor = SEASON_COLORS[rows[i].k];
      span('', dayCell, rows[i].name);
      div('sp-td sp-td-win' + (rows[i].win.length ? '' : ' is-none'), r, spanText(rows[i].win));
      div('sp-td sp-td-lit' + (rows[i].lit.length ? ' is-yes' : ' is-none'), r, spanText(rows[i].lit));
    }
    return t;
  }

  // The table without its window column when it doesn't fit across.
  // Returns false when even that doesn't fit.
  function fitTable(t) {
    if (!t || !t.parentNode) return true;
    if (t.scrollWidth <= t.clientWidth + 1 && !overWide(t)) return true;
    if (!/ is-slim\b/.test(t.className)) t.className += ' is-slim';
    return t.scrollWidth <= t.clientWidth + 1 && !overWide(t);
  }
  function overWide(t) {
    if (t.parentNode && t.offsetWidth > t.parentNode.clientWidth + 1) return true;
    var r = t.getBoundingClientRect();
    var cells = t.querySelectorAll('.sp-td');
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].scrollWidth > cells[i].clientWidth + 1) return true;
      if (cells[i].getBoundingClientRect().right > r.right + 0.5) return true;
    }
    return false;
  }

  function drawBlocks(body, a, nowMs, tall) {
    var w = answerWords(a, nowMs);
    var box = div('sp-box', body);
    var kick = div('sp-kicker' + (a.k === 'now' ? ' is-lit' : ''), box);
    if (a.k === 'now') sunDot(kick);
    span('', kick, w.kicker);
    var big = null;
    if (w.big) {
      big = div('sp-big', box);
      if (w.bigPre) span('sp-big-pre', big, w.bigPre + ' ');
      span('', big, w.big);
    }
    var sub = w.sub ? div('sp-sub', box, w.sub) : null;
    var warn = a.k === 'now' ? div('sp-warn', box, fill(S.keepOut, { plant: P.shy })) : null;
    var winter = a.k === 'later' && a.days >= WINTER_DAYS;
    var grow = winter ? div('sp-grow', box, S.growUntil) : null;
    var todayBox = null;
    if (!winter && a.k !== 'none') {
      todayBox = div('sp-today', box);
      var tl = div('sp-today-line', todayBox);
      span('sp-today-label', tl, S.today + ' ');
      var list = a.today || [];
      span('sp-today-spans', tl, list.length ? spanText(list) : S.none);
      dayBar(todayBox, new Date(nowMs), nowMs, true);
    }
    var table = tall ? seasonTable(box, nowMs, 'is-tile') : null;
    if (table && !fitTable(table)) { drop(table); table = null; }

    if (big) shrink(big, 1.3, function () { return fitsWidth(big); });

    var room = box.clientHeight;
    var over = function () { return box.scrollHeight > box.clientHeight + 1; };
    if (!room || !over()) return;
    function squeeze(n, min) {
      if (!n || !n.parentNode || !over()) return;
      var lh = lineHeight(n);
      var free = room - (box.scrollHeight - n.offsetHeight);
      var lines = Math.floor((free + 0.5) / lh);
      if (lines >= min) clampLines(n, lines);
      else drop(n);
    }
    if (over() && table) { drop(table); table = null; }
    if (over() && todayBox) { var bar = todayBox.querySelector('.sp-bar'); drop(bar); }
    if (over()) squeeze(grow, 1);
    if (over()) squeeze(warn, 1);
    if (over() && todayBox) { drop(todayBox); todayBox = null; }
    if (over()) squeeze(sub, 1);
    if (over() && big) shrink(big, 1.0, function () { return !over(); });
    if (over()) squeeze(kick, 1);
  }

  function renderTile(body, ctx) {
    tileCtx = ctx;
    P = settings(ctx && ctx.config);
    if (ctx && typeof ctx.retitle === 'function') ctx.retitle();
    if (ctx && typeof ctx.setBadge === 'function') ctx.setBadge(P.placeholder ? S.badge : '');
    var t = now();
    var a = answer(t);
    shown = signature(t);
    var size = ctx && ctx.size ? ctx.size() : { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
    body.className = 'tile-body sp-tile' + (a.k === 'now' ? ' is-lit' : '');
    body.setAttribute('data-state', a.k === 'later' ? (a.days === 0 ? 'today' : a.days === 1 ? 'tomorrow' : 'date') : a.k);
    if (a.k === 'now') div('sp-glow', body);
    if (size.cols === 1) { body.className += ' sp-tile-one'; drawOne(body, a); return; }
    if (size.tier === 'strip') { body.className += ' sp-tile-strip'; drawStrip(body, a); return; }
    body.className += size.tier === 'tall' ? ' sp-tile-tall' : ' sp-tile-standard';
    if (size.tier === 'tall' && size.cols >= 6) {
      // Wide and tall: the words on the left, the room as it is now on the right.
      body.className += ' sp-tile-wide';
      var words = div('sp-wcol sp-wcol-text', body);
      var pic = div('sp-wcol sp-wcol-plan', body);
      pic.innerHTML = planSvg(t, 'T');
      drawBlocks(words, a, t, true);
      labelsFit(pic, 0.85);
      return;
    }
    drawBlocks(body, a, t, size.tier === 'tall');
  }

  /* ---------- the panel ---------- */

  var PANEL_DAYS = ['today', 'dec', 'mar', 'jun', 'sep'];
  var pv = null;      // the panel's state and parts: { day, minute, view, ... }

  function panelDate(nowMs) {
    if (pv.day === 'today') return new Date(nowMs);
    for (var i = 0; i < SEASONS.length; i++) if (SEASONS[i].k === pv.day) return seasonDate(SEASONS[i], nowMs);
    return new Date(nowMs);
  }
  function panelMs(nowMs) {
    var d = panelDate(nowMs);
    return msAt(d.getFullYear(), d.getMonth(), d.getDate(), pv.minute);
  }
  function dayLabel(k, nowMs) {
    if (k === 'today') return S.today + ', ' + fmtDate(nowMs);
    return seasonName(k, nowMs);
  }

  function freshPanelState(nowMs) {
    var d = new Date(nowMs);
    var m = d.getHours() * 60 + d.getMinutes();
    m = Math.round(m / SLIDE_STEP) * SLIDE_STEP;
    m = Math.max(SLIDE_FROM, Math.min(SLIDE_TO, m));
    return { day: 'today', minute: m, view: 'plan' };
  }

  /* SVG, built as text: the room from above. */
  // Pictures are drawn in their own units and scaled to their box: when
  // that makes their words smaller than minRem, the words leave (the
  // picture still reads). Measured once after each draw.
  function labelsFit(box, minRem) {
    var svg = box.querySelector('svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal) return true;
    var vb = svg.viewBox.baseVal;
    var r = svg.getBoundingClientRect();
    if (!vb.width || !r.width) return true;
    var k = Math.min(r.width / vb.width, r.height / vb.height);
    var small = 22 * k < minRem * rem() - 0.5;
    if (small) svg.setAttribute('class', (svg.getAttribute('class') || '') + ' is-small');
    return !small;
  }

  function svgText(x, y, text, cls, anchor, extra) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" class="' + cls + '"' + (anchor ? ' text-anchor="' + anchor + '"' : '') + (extra || '') + '>' + esc(text) + '</text>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // The room plan, in feet: the window wall along the top (outside is up),
  // the right window from x 0 to WIN_W, the plant wall at WIN_W + gap.
  function planSvg(ms, id) {
    var clip = 'spRoom' + (id || 'P');
    var st = stateAt(ms);
    var s = st.sun;
    var wallX = WIN_W + P.gap;
    var left = -2.5;
    var depth = 7.5;
    var ft = 40;                           // svg units a foot
    var padL = 20, padT = 124, padB = 24, padR = 132;
    var W = padL + (wallX - left) * ft + padR;
    var H = padT + depth * ft + padB;
    var X = function (x) { return padL + (x - left) * ft; };
    var Y = function (y) { return padT + y * ft; };
    var out = [];
    out.push('<svg class="sp-plan-svg" viewBox="0 0 ' + W.toFixed(0) + ' ' + H.toFixed(0) + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">');
    out.push('<defs><clipPath id="' + clip + '"><rect x="' + X(left) + '" y="' + Y(0) + '" width="' + ((wallX - left) * ft) + '" height="' + (depth * ft) + '"/></clipPath></defs>');
    // The floor.
    out.push('<rect class="sp-floor" x="' + X(left) + '" y="' + Y(0) + '" width="' + ((wallX - left) * ft) + '" height="' + (depth * ft) + '" rx="6"/>');
    // A one-foot grid on the floor, very faint.
    for (var gx = Math.ceil(left); gx < wallX; gx++) out.push('<line class="sp-gridl" x1="' + X(gx) + '" x2="' + X(gx) + '" y1="' + Y(0) + '" y2="' + Y(depth) + '"/>');
    for (var gy = 1; gy < depth; gy++) out.push('<line class="sp-gridl" x1="' + X(left) + '" x2="' + X(wallX) + '" y1="' + Y(gy) + '" y2="' + Y(gy) + '"/>');
    // The beam.
    var d = s.az - FACE;
    var inside = enters(s);
    if (inside) {
      var t = Math.tan(rad(-d));
      var far = depth + 2;
      var pts = [X(0), Y(0), X(WIN_W), Y(0), X(WIN_W + far * t), Y(far), X(far * t), Y(far)];
      out.push('<polygon class="sp-beam' + (st.k === 'lit' ? ' is-lit' : '') + '" clip-path="url(#' + clip + ')" points="' + pts.map(function (n) { return n.toFixed(1); }).join(' ') + '"/>');
      // Where the beam lands on the plant wall.
      if (d < 0) {
        var y0 = Math.max(0, P.gap / t);
        var y1 = Math.min(depth, (WIN_W + P.gap) / t);
        if (y1 > y0) out.push('<line class="sp-patch" x1="' + X(wallX) + '" x2="' + X(wallX) + '" y1="' + Y(y0).toFixed(1) + '" y2="' + Y(y1).toFixed(1) + '"/>');
      }
    }
    // Walls: the window wall, the window, the plant wall.
    out.push('<line class="sp-wall" x1="' + X(left) + '" x2="' + X(wallX) + '" y1="' + Y(0) + '" y2="' + Y(0) + '"/>');
    out.push('<line class="sp-wall" x1="' + X(wallX) + '" x2="' + X(wallX) + '" y1="' + Y(0) + '" y2="' + Y(depth) + '"/>');
    out.push('<rect class="sp-glass" x="' + X(0) + '" y="' + (Y(0) - 7) + '" width="' + (WIN_W * ft) + '" height="14" rx="3"/>');
    // The plants: three leaves along the wall at the plant spot.
    var py = Y(P.depth);
    var px = X(wallX) - 22;
    out.push('<g class="sp-plants' + (st.k === 'lit' ? ' is-lit' : '') + '">' +
      '<circle cx="' + px + '" cy="' + (py - 16) + '" r="11"/><circle cx="' + (px - 6) + '" cy="' + py + '" r="13"/><circle cx="' + px + '" cy="' + (py + 17) + '" r="11"/></g>');
    // The sun outside, on an arc above the window, and its ray.
    var cx = X(WIN_W / 2);
    var cy = Y(0);
    var R = 100;
    var ang = rad(Math.max(-88, Math.min(88, d)));
    var sx = cx + R * Math.sin(ang);
    var sy = cy - R * Math.cos(ang);
    out.push('<path class="sp-sky" d="M ' + (cx - R * Math.sin(rad(88))).toFixed(1) + ' ' + (cy - R * Math.cos(rad(88))).toFixed(1) + ' A ' + R + ' ' + R + ' 0 0 1 ' + (cx + R * Math.sin(rad(88))).toFixed(1) + ' ' + (cy - R * Math.cos(rad(88))).toFixed(1) + '"/>');
    // The window's view on that arc.
    var a0 = rad(AZ_LO - FACE);
    var a1 = rad(AZ_HI - FACE);
    out.push('<path class="sp-view" d="M ' + (cx + R * Math.sin(a0)).toFixed(1) + ' ' + (cy - R * Math.cos(a0)).toFixed(1) + ' A ' + R + ' ' + R + ' 0 0 1 ' + (cx + R * Math.sin(a1)).toFixed(1) + ' ' + (cy - R * Math.cos(a1)).toFixed(1) + '"/>');
    if (s.alt > 0) {
      out.push('<line class="sp-ray' + (inside ? ' is-in' : '') + '" x1="' + sx.toFixed(1) + '" y1="' + sy.toFixed(1) + '" x2="' + cx + '" y2="' + cy + '"/>');
      out.push('<circle class="sp-sun' + (inside ? ' is-in' : '') + '" cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="13"/>');
    }
    // North, from the window's bearing (up is FACE).
    var nx = X(wallX) + 92;
    var ny = Y(0) - 84;
    var na = -FACE;
    out.push('<g class="sp-north" transform="translate(' + nx + ' ' + ny + ') rotate(' + na.toFixed(1) + ')"><path d="M 0 -26 L 9 8 L 0 2 L -9 8 Z"/></g>');
    out.push(svgText(nx, ny + 50, S.plan.north, 'sp-svg-label', 'middle'));
    // Labels.
    out.push(svgText(X(WIN_W / 2), Y(0) + 34, S.plan.window, 'sp-svg-label', 'middle'));
    out.push(svgText(X(wallX) + 18, Y(depth / 2), S.plan.wall, 'sp-svg-label', 'middle', ' transform="rotate(90 ' + (X(wallX) + 18).toFixed(1) + ' ' + Y(depth / 2).toFixed(1) + ')"'));
    out.push(svgText(px - 32, py + 9, S.plan.plants, 'sp-svg-label is-strong', 'end'));
    out.push('</svg>');
    return out.join('');
  }

  // The sun's arc against the window: bearing across, height up.
  function arcSvg(ms, nowMs) {
    var W = 520, H = 320, ml = 50, mr = 14, mt = 16, mb = 46;
    var x0 = 240, x1 = 360, y1 = 70;
    var X = function (a) { return ml + (a - x0) / (x1 - x0) * (W - ml - mr); };
    var Y = function (a) { return mt + (1 - a / y1) * (H - mt - mb); };
    var out = [];
    out.push('<svg class="sp-arc-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">');
    out.push('<rect class="sp-arc-view" x="' + X(AZ_LO).toFixed(1) + '" y="' + Y(P.roof).toFixed(1) + '" width="' + (X(AZ_HI) - X(AZ_LO)).toFixed(1) + '" height="' + (Y(0) - Y(P.roof)).toFixed(1) + '"/>');
    out.push('<rect class="sp-arc-roof" x="' + X(AZ_LO).toFixed(1) + '" y="' + Y(y1).toFixed(1) + '" width="' + (X(AZ_HI) - X(AZ_LO)).toFixed(1) + '" height="' + (Y(P.roof) - Y(y1)).toFixed(1) + '"/>');
    for (var al = 0; al <= y1; al += 10) {
      out.push('<line class="sp-gridl" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(al).toFixed(1) + '" y2="' + Y(al).toFixed(1) + '"/>');
      if (al % 20 === 0) out.push(svgText(ml - 8, Y(al) + 6, al + '°', 'sp-svg-tick', 'end'));
    }
    var ticks = [[270, S.arc.w + ' 270°'], [315, S.arc.nw + ' 315°'], [360, S.arc.n + ' 360°'], [240, '240°']];
    for (var i = 0; i < ticks.length; i++) {
      out.push(svgText(Math.min(X(ticks[i][0]), W - mr), H - 14, ticks[i][1], 'sp-svg-tick', ticks[i][0] === 360 ? 'end' : ticks[i][0] === 240 ? 'start' : 'middle'));
    }
    out.push(svgText((X(AZ_LO) + X(AZ_HI)) / 2, Y(P.roof) - 10, fill(S.arc.roof, { r: P.roof }), 'sp-svg-tick is-quiet', 'middle'));
    out.push(svgText((X(AZ_LO) + X(AZ_HI)) / 2, Y(4) - 6, S.arc.view, 'sp-svg-tick is-warm', 'middle'));
    // One curve per season day, and the chosen day on top.
    var days = [];
    for (var k = 0; k < SEASONS.length; k++) days.push({ k: SEASONS[k].k, date: seasonDate(SEASONS[k], nowMs) });
    var chosen = panelDate(nowMs);
    if (pv.day === 'today') days.push({ k: 'today', date: chosen });
    for (var j = 0; j < days.length; j++) {
      var dd = days[j];
      var on = dd.k === pv.day;
      var all = [];
      var segs = [];
      var cur = [];
      for (var mm = 8 * 60; mm <= 22 * 60; mm += 6) {
        var p = sunAt(msAt(dd.date.getFullYear(), dd.date.getMonth(), dd.date.getDate(), mm));
        if (p.alt <= 0 || p.az < x0 || p.az > x1) { if (cur.length) { segs.push(cur); cur = []; } continue; }
        var pt = X(p.az).toFixed(1) + ',' + Y(Math.min(p.alt, y1)).toFixed(1);
        all.push(pt);
        if (enters(p)) cur.push(pt); else if (cur.length) { segs.push(cur); cur = []; }
      }
      if (cur.length) segs.push(cur);
      var col = SEASON_COLORS[dd.k];
      if (all.length > 1) out.push('<polyline class="sp-curve' + (on ? ' is-on' : '') + '" stroke="' + col + '" points="' + all.join(' ') + '"/>');
      for (var q = 0; q < segs.length; q++) if (segs[q].length > 1) out.push('<polyline class="sp-curve-in' + (on ? ' is-on' : '') + '" stroke="' + col + '" points="' + segs[q].join(' ') + '"/>');
    }
    var s = sunAt(ms);
    if (s.alt > 0 && s.az >= x0 && s.az <= x1) {
      out.push('<circle class="sp-arc-sun' + (hitsPlant(s) ? ' is-lit' : '') + '" cx="' + X(s.az).toFixed(1) + '" cy="' + Y(Math.min(s.alt, y1)).toFixed(1) + '" r="9"/>');
    }
    out.push('</svg>');
    return out.join('');
  }

  function legend(parent, nowMs) {
    var lg = div('sp-legend', parent);
    var keys = ['dec', 'mar', 'jun', 'sep'];
    if (pv.day === 'today') keys.push('today');
    for (var i = 0; i < keys.length; i++) {
      var it = span('sp-legend-item' + (keys[i] === pv.day ? ' is-on' : ''), lg);
      var k = span('sp-key', it);
      k.style.backgroundColor = SEASON_COLORS[keys[i]];
      span('', it, keys[i] === 'today' ? S.today : seasonName(keys[i], nowMs));
    }
    return lg;
  }

  // The plants and the grow lights. In the panel the heads run into the
  // text and the plants are only listed (the status says when to move one).
  function notes(parent, which, runIn) {
    var box = div('sp-notes' + (runIn ? ' is-run-in' : ''), parent);
    if (which.indexOf('plants') >= 0) {
      var n1 = div('sp-note', box);
      span('sp-note-head', n1, S.notes.plantsHead);
      span('sp-note-text', n1, runIn ? P.plants.join(', ') + '.' : fill(S.notes.plants, { list: P.plants.join(', '), plant: P.shy }));
    }
    if (which.indexOf('grow') >= 0) {
      var n2 = div('sp-note', box);
      span('sp-note-head', n2, S.notes.growHead);
      span('sp-note-text', n2, S.notes.grow);
    }
    return box;
  }

  function placeholderNote(parent) {
    if (!P.placeholder) return null;
    var n = div('sp-place', parent);
    span('sp-place-tag', n, S.notes.placeTag);
    span('sp-place-text', n, fill(S.notes.place, { r: P.roof, g: P.gap.toFixed(1) }));
    return n;
  }

  function control(parent, cls, key, label, hint) {
    var c = div('sp-ctl ' + cls, parent);
    if (label) {
      var head = div('sp-ctl-head', c);
      span('sp-ctl-label', head, label);
      if (hint) span('sp-hint', head, hint);
    }
    var f = div('sp-ctl-box f', c);
    f.setAttribute('data-key', key);
    return { wrap: c, box: f };
  }

  function renderPanel(body, ctx) {
    P = settings(ctx && ctx.config);
    var nowMs = now();
    if (!pv) pv = freshPanelState(nowMs);
    var full = ctx && ctx.mode && ctx.mode() === 'full';
    var root = div('sp-panel' + (full ? ' is-full' : ''), body);
    pv.full = full;

    // Panel: the picture (one of three) on the left, the moment on the right.
    // Full screen: the room, the moment, then the arc and the seasons.
    var left = div('sp-col sp-col-left', root);
    var mid = div('sp-col sp-col-mid', root);
    var right = full ? div('sp-col sp-col-right', root) : left;

    // The status: the chosen moment and what the sun does then.
    var status = div('sp-status', mid);
    pv.when = div('sp-when', status);
    pv.say = div('sp-say', status);
    pv.pos = div('sp-pos', status);

    // Time slider.
    var tc = control(mid, 'sp-ctl-time', 'time', S.panel.time, S.panel.stepHint);
    tc.box.setAttribute('data-autofocus', '');
    tc.box.className += ' sp-slider';
    var rail = div('sp-slider-rail', tc.box);
    pv.track = div('sp-slider-track', rail);
    pv.thumb = div('sp-slider-thumb', rail);
    var marks = div('sp-slider-marks', tc.wrap);
    var hours = [12, 15, 18, 21];
    for (var i = 0; i < hours.length; i++) {
      var mk = span('sp-mark' + (i === 0 ? ' is-first' : i === hours.length - 1 ? ' is-last' : ''), marks,
        (hours[i] % 12 || 12) + (i === hours.length - 1 ? NB + nb(S.pm) : ''));
      if (i > 0 && i < hours.length - 1) mk.style.left = ((hours[i] * 60 - SLIDE_FROM) / (SLIDE_TO - SLIDE_FROM) * 100).toFixed(2) + '%';
    }

    // Day chooser.
    var dc = control(mid, 'sp-ctl-day', 'day', '', '');
    dc.box.className += ' sp-stepper';
    span('sp-step-arrow', dc.box, '\u2039');
    pv.dayText = span('sp-step-text', dc.box);
    span('sp-step-arrow', dc.box, '\u203a');

    if (!full) {
      // Which picture the left side shows.
      var views = div('sp-views', left);
      var vk = ['plan', 'arc', 'table'];
      pv.viewEls = [];
      for (var v = 0; v < vk.length; v++) {
        var chip = div('sp-view-chip f' + (pv.view === vk[v] ? ' is-on' : ''), views, S.panel.views[vk[v]]);
        chip.setAttribute('data-key', 'view-' + vk[v]);
        chip.setAttribute('data-view', vk[v]);
        pv.viewEls.push(chip);
      }
    }
    pv.planBox = div('sp-plan', left);
    pv.arcBox = div('sp-arc', right);
    pv.arcSvg = div('sp-arc-pic', pv.arcBox);
    pv.legendBox = div('sp-legend-wrap', pv.arcBox);
    pv.tableBox = div('sp-seasons', right);
    pv.table = seasonTable(pv.tableBox, nowMs, 'is-panel');
    if (full) {
      notes(mid, ['grow'], false);
      notes(right, ['plants'], false);
    } else {
      notes(pv.tableBox, ['plants', 'grow'], true);
    }
    placeholderNote(mid);
    pv.mid = mid;
    pv.views = full ? null : left.querySelector('.sp-views');
    showView();
    refresh();
    fitChips();
    if (full) fitTable(pv.table);
  }

  function showView() {
    if (!pv || pv.full) return;
    pv.planBox.style.display = pv.view === 'plan' ? '' : 'none';
    pv.arcBox.style.display = pv.view === 'arc' ? '' : 'none';
    pv.tableBox.style.display = pv.view === 'table' ? '' : 'none';
    for (var i = 0; i < pv.viewEls.length; i++) {
      var on = pv.viewEls[i].getAttribute('data-view') === pv.view;
      pv.viewEls[i].className = pv.viewEls[i].className.replace(/ is-on\b/g, '') + (on ? ' is-on' : '');
    }
    if (pv.view === 'table') { fitTable(pv.table); fitSeasons(); }
  }

  // The seasons view in the panel: the notes get smaller type, then the
  // last one gives up lines, before anything leaves the panel.
  function fitSeasons() {
    var box = pv.tableBox;
    var n = box.querySelector('.sp-notes');
    if (!n || pv.fitted) return;
    pv.fitted = true;
    var over = function () { return box.scrollHeight > box.clientHeight + 1; };
    if (!over()) return;
    var texts = n.querySelectorAll('.sp-note');
    var size = fontPx(n);
    for (var i = 0; i < 6 && over() && size > 0.75 * rem(); i++) {
      size = Math.max(0.75 * rem(), size * 0.94);
      for (var j = 0; j < texts.length; j++) {
        texts[j].querySelector('.sp-note-head').style.fontSize = size.toFixed(1) + 'px';
        texts[j].querySelector('.sp-note-text').style.fontSize = size.toFixed(1) + 'px';
      }
    }
    // Then the plants' list goes (full screen has it), then the grow
    // lights note gives up lines.
    if (over() && texts.length > 1) drop(texts[0]);
    var last = texts[texts.length - 1];
    var lh = lineHeight(last.querySelector('.sp-note-text'));
    for (var k = 0; k < 8 && over(); k++) {
      var lines = Math.floor((last.offsetHeight - (box.scrollHeight - box.clientHeight)) / lh);
      if (lines < 1) { drop(last); return; }
      clampLines(last, lines);
    }
  }

  // Redraws only what depends on the chosen day and time.
  function refresh() {
    if (!pv || !pv.when || !pv.when.parentNode) return;
    var nowMs = now();
    var ms = panelMs(nowMs);
    var st = stateAt(ms);
    var date = panelDate(nowMs);
    pv.when.textContent = fmtTime(ms) + ' · ' + (pv.day === 'today' ? S.today : seasonName(pv.day, nowMs));
    pv.say.textContent = st.k === 'lit' ? fill(S.status.lit, { plant: P.shy }) : S.status[st.k];
    pv.say.className = 'sp-say' + (st.k === 'lit' ? ' is-lit' : '');
    pv.pos.textContent = st.sun.alt > 0 ? fill(S.status.at, { alt: Math.round(st.sun.alt), az: Math.round(st.sun.az) }) : '';
    pv.dayText.textContent = dayLabel(pv.day, nowMs);
    // The slider: the day's window and plant light, and the thumb.
    pv.track.innerHTML = '';
    var y = date.getFullYear();
    var m = date.getMonth();
    var d = date.getDate();
    var a = msAt(y, m, d, SLIDE_FROM);
    var b = msAt(y, m, d, SLIDE_TO);
    var win = spans(y, m, d, enters, SLIDE_FROM, SLIDE_TO);
    var lit = spans(y, m, d, hitsPlant, SLIDE_FROM, SLIDE_TO);
    function seg(cls, s) {
      var l = Math.max(0, (s.start - a) / (b - a));
      var r = Math.min(1, (s.end - a) / (b - a));
      if (r <= l) return;
      var n = div(cls, pv.track);
      n.style.left = (l * 100).toFixed(2) + '%';
      n.style.width = ((r - l) * 100).toFixed(2) + '%';
    }
    for (var i = 0; i < win.length; i++) seg('sp-bar-win', win[i]);
    for (var j = 0; j < lit.length; j++) seg('sp-bar-lit', lit[j]);
    pv.thumb.style.left = ((pv.minute - SLIDE_FROM) / (SLIDE_TO - SLIDE_FROM) * 100).toFixed(2) + '%';
    pv.thumb.className = 'sp-slider-thumb' + (st.k === 'lit' ? ' is-lit' : '');
    fitMid();
    // The pictures.
    if (pv.full || pv.view === 'plan') pv.planBox.innerHTML = planSvg(ms);
    if (pv.full || pv.view === 'arc') {
      pv.arcSvg.innerHTML = arcSvg(ms, nowMs);
      pv.legendBox.innerHTML = '';
      legend(pv.legendBox, nowMs);
    }
  }

  // The view chips share one row: smaller type before any is cut.
  function fitChips() {
    var v = pv && pv.views;
    if (!v) return;
    var fits = function () {
      if (v.scrollWidth > v.clientWidth + 1) return false;
      for (var i = 0; i < v.children.length; i++) if (v.children[i].scrollWidth > v.children[i].clientWidth + 1) return false;
      return true;
    };
    if (shrink(v, 0.75, fits)) return;
    // Still too long: the chips take two rows.
    v.className += ' is-wrapped';
  }

  // The moment's column: the sun's height and bearing go first, then the
  // status gives up lines, before anything is cut.
  function fitMid() {
    var m = pv && pv.mid;
    if (!m) return;
    pv.pos.style.display = '';
    pv.say.style.display = '';
    pv.say.style.webkitLineClamp = '';
    var over = function () { return m.scrollHeight > m.clientHeight + 1; };
    if (!over()) return;
    pv.pos.style.display = 'none';
    if (!over()) return;
    var free = m.clientHeight - (m.scrollHeight - pv.say.offsetHeight);
    var lines = Math.floor((free + 0.5) / lineHeight(pv.say));
    if (lines >= 1) clampLines(pv.say, lines);
  }

  function stepTime(dir) {
    var m = pv.minute + dir * SLIDE_STEP;
    if (m < SLIDE_FROM || m > SLIDE_TO) return;
    pv.minute = m;
    refresh();
  }
  function stepDay(dir) {
    var i = PANEL_DAYS.indexOf(pv.day);
    i = (i + dir + PANEL_DAYS.length) % PANEL_DAYS.length;
    pv.day = PANEL_DAYS[i];
    refresh();
  }

  function keyOf(target) { return target && target.getAttribute ? target.getAttribute('data-key') || '' : ''; }

  /* ---------- the widget ---------- */

  var widget = {
    id: 'sunpath',
    icon: 'plant-sun',
    expandable: true,

    init: function (ctx) {
      tileCtx = ctx;
      P = settings(ctx && ctx.config);
      var L = I18N();
      if (L && typeof L.onChange === 'function') {
        L.onChange(function () {
          localize();
          shown = '';
          ctx.redrawTile();
          if (ctx.isOpen()) {
            var pt = document.querySelector('#panel .panel-title');
            if (pt) pt.textContent = S.title;
            ctx.redrawPanel();
          }
        });
      }
      // Once a minute: redraw only when the answer (or the day) changed.
      setInterval(function () {
        try {
          if (signature(now()) !== shown) ctx.redrawTile();
        } catch (e) { /* the next minute tries again */ }
      }, 60000);
    },

    renderTile: function (body, ctx) {
      try {
        renderTile(body, ctx);
      } catch (e) {
        body.innerHTML = '';
        div('sp-none', body, S.noneHead);
      }
    },

    renderPanel: function (body, ctx) { renderPanel(body, ctx); },

    onSelect: function (target) {
      var k = keyOf(target);
      if (k === 'day') { stepDay(1); return; }
      if (k === 'time') { stepTime(1); return; }
      if (k.indexOf('view-') === 0 && pv) {
        pv.view = target.getAttribute('data-view');
        showView();
        refresh();
      }
    },

    onMove: function (dir, from) {
      if (!pv || (dir !== 'left' && dir !== 'right')) return;
      var k = keyOf(from);
      if (k === 'time') { stepTime(dir === 'left' ? -1 : 1); return true; }
      if (k === 'day') { stepDay(dir === 'left' ? -1 : 1); return true; }
    },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },

    onClose: function () { pv = null; }
  };

  try {
    Object.defineProperty(widget, 'title', { get: function () { return S.title; }, enumerable: true, configurable: true });
    Object.defineProperty(widget, 'shortTitle', { get: function () { return S.titleShort; }, enumerable: true, configurable: true });
  } catch (e) {
    widget.title = EN.title;
  }

  // For the tests (dev/sunpath-test.js).
  window.HUB_SUNPATH = {
    sunpos: sunpos,
    enters: function (s) { P = P || settings(cfgOwn()); return enters(s); },
    hitsPlant: function (s) { P = P || settings(cfgOwn()); return hitsPlant(s); },
    daySpans: function (date, which) { P = P || settings(cfgOwn()); return daySpans(date, which === 'window' ? enters : hitsPlant); },
    search: function (ms) { P = P || settings(cfgOwn()); return search(ms); },
    answer: function (ms) { P = P || settings(cfgOwn()); return answer(ms); },
    settings: function () { P = P || settings(cfgOwn()); return JSON.parse(JSON.stringify(P)); },
    panel: function () { return pv ? { day: pv.day, minute: pv.minute, view: pv.view } : null; },
    constants: { MAG_DECLINATION: MAG_DECLINATION, AZ_LO: AZ_LO, AZ_HI: AZ_HI, FACE: FACE, WIN_W: WIN_W, SILL: SILL, WIN_H: WIN_H }
  };
  function cfgOwn() { return (window.HUB_CONFIG && window.HUB_CONFIG.widgets && window.HUB_CONFIG.widgets.sunpath) || {}; }

  return widget;
})());
