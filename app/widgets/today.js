/*
 * Clock. OK on the tile opens the Clock page: a digital or an analog face
 * and a 12-hour or 24-hour clock. (The version and the other facts about
 * the hub are in the About panel, Left from a left-most tile: app/hub.js.)
 * Both choices are remembered on this TV, and the tile follows them.
 * A third choice, Language (English or Español), sets the hub's language
 * (app/i18n.js); the Clock itself stays in English for now.
 *
 *
 *   Digital  the time and the date, nothing else, 12- or 24-hour.
 *   Analog   only the analog face (the page's own, drawFace), as large as
 *            the tile allows and centred, with the date in its window:
 *            "MON 16" when the face is big enough to read it, "16" on a
 *            small face (a 1x1 or a strip), no window on a tiny one. No
 *            digital time anywhere. The 12/24 choice doesn't apply, so the
 *            page hides it (it stays remembered for Digital). In a strip
 *            three or more columns wide (Ian's 3x1) the tile is a small
 *            plain face (12 marks, no numbers) with the digital time and
 *            the short date beside it, which reads better at that height.
 *   Sun path the day as a half circle: sunrise on the left, sunset on the
 *            right, the sun on it now; after dark the same arc is the
 *            night, sunset to sunrise, with the moon (its real phase, worked
 *            out here) on it. The time sits inside the arc. Sunrise and
 *            sunset are worked out on the TV for the weather's city point
 *            (HUB_CONFIG.widgets.weather.location), so no feed is needed.
 *            At 3x2 and bigger the tile is a 24-hour dial instead: noon at
 *            the top, midnight at the bottom, the sun at the time and the
 *            moon where it really is (low-precision places, about a degree).
 *
 * A change on the page redraws the tile at once (ctx.redrawTile).
 *
 * Nothing here animates. The hands are turned with an SVG transform
 * attribute. The page ticks once a second while it is open; the digital
 * tile every 15 seconds; the analog tile once a second (one setTimeout
 * loop just after each whole second, only while that face is on the tile,
 * stopped whenever the tile is drawn again).
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var FACE_KEY = 'homeHub.clock.face';     // 'digital' | 'analog' | 'sun'
  var FACES = ['digital', 'analog', 'sun'];
  var HOURS_KEY = 'homeHub.clock.hours';   // '12' | '24'

  var els = null;     // the digital tile's parts, or null
  var tileFace = null; // the analog tile's face, or null
  var mini = null;    // the small analog strip's parts (face, time, date), or null
  var sunTile = null; // the Sun path tile's parts, or null
  var sunDial = null; // the 24-hour Sun dial's parts (3x2 and bigger), or null
  var tileTimer = null;
  var page = null;    // the open page's parts, or null
  var pageTimer = null;

  /* ---------- the two choices, remembered when the TV allows it ---------- */

  function load(key, allowed, fallback) {
    var v = null;
    try { v = window.localStorage ? localStorage.getItem(key) : null; } catch (e) { v = null; }
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  // app/i18n.js, or null when it isn't loaded.
  function I18N() {
    var L = window.HUB_I18N;
    return L && typeof L.t === 'function' && typeof L.setLang === 'function' ? L : null;
  }

  // A word in the hub's language: 'today.<name>' (app/i18n.js); English as given.
  function T(key, english) {
    var L = window.HUB_I18N;
    try { return L && typeof L.t === 'function' ? String(L.t('today.' + key, english)) : english; } catch (e) { return english; }
  }

  function spanish() {
    var L = window.HUB_I18N;
    try { return !!L && typeof L.lang === 'function' && L.lang() === 'es'; } catch (e) { return false; }
  }

  // The two choices are shared by every screen (app/prefs.js, the Pi's
  // "prefs"); without prefs.js, this screen's own storage as before.
  var PREF = { 'homeHub.clock.face': 'clock.face', 'homeHub.clock.hours': 'clock.hours' };

  function P() { var p = window.HUB_PREFS; return p && typeof p.get === 'function' && typeof p.set === 'function' ? p : null; }

  function pick(key, allowed, fallback) {
    var p = P();
    if (!p) return load(key, allowed, fallback);
    var v = p.get(PREF[key]);
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function save(key, value) {
    if (P()) { P().set(PREF[key], value); return; }
    try { if (window.localStorage) localStorage.setItem(key, value); } catch (e) { /* not kept; fine */ }
  }

  var face = pick(FACE_KEY, FACES, 'digital');
  var hours = pick(HOURS_KEY, ['12', '24'], '12');

  /* ---------- small helpers ---------- */

  function div(cls, parent, text) {
    var el = document.createElement('div');
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function span(cls, parent, text) {
    var el = document.createElement('span');
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function svgEl(tag, attrs, parent) {
    var el = document.createElementNS(SVGNS, tag);
    for (var k in attrs) {
      if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "9:41" and "PM", or "21:41" and "" on a 24-hour clock. Worked out by
  // hand, not by the browser: old engines differ on 24-hour midnight.
  function timeParts(now) {
    var h = now.getHours();
    var mm = pad(now.getMinutes());
    if (hours === '24') return { digits: pad(h) + ':' + mm, ampm: '' };
    return { digits: (h % 12 || 12) + ':' + mm, ampm: (h < 12 ? T('am', 'AM') : T('pm', 'PM')).replace(/ /g, '\u00a0') };
  }

  // The date in the hub's language. English is the browser's own en-US;
  // Spanish comes from the hub's lists (the TV's browser may not know it):
  // "sábado", "sáb", "19 de noviembre", "19 nov", "19 de noviembre de 2026".
  function dateText(now, opts) {
    if (!spanish()) return now.toLocaleDateString('en-US', opts);
    var L = window.HUB_I18N;
    if (opts.weekday && !opts.month) return L.dayName(now, opts.weekday === 'short');
    var d = now.getDate();
    if (opts.month === 'short') return d + ' ' + L.monthName(now, true);
    return d + ' de ' + L.monthName(now, false) + (opts.year ? ' de ' + now.getFullYear() : '');
  }

  function rem() {
    return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  }

  // Shrinks box (and small, AM/PM, in step) until box fits its own width.
  // Runs only when drawn or when the digits change length, never each second.
  function fitWidth(box, small) {
    box.style.fontSize = '';
    if (small) small.style.fontSize = '';
    if (!box.clientWidth || box.scrollWidth <= box.clientWidth + 1) return;
    var size = parseFloat(window.getComputedStyle(box).fontSize) || 60;
    var ratio = small ? (parseFloat(window.getComputedStyle(small).fontSize) || 20) / size : 0;
    for (var i = 0; i < 14 && box.scrollWidth > box.clientWidth + 1; i++) {
      size = size * 0.9;
      box.style.fontSize = size.toFixed(1) + 'px';
      if (small) small.style.fontSize = (size * ratio).toFixed(1) + 'px';
    }
  }

  /* ---------- the tile ---------- */

  // The time ("9:41" and "PM") and the date (weekday, ", ", month and day).
  function timeEls(parent, form) {
    var time = div('today-time', parent);
    var digits = span('today-digits', time);
    var ampm = span('today-ampm', time);
    var date = div('today-date', parent);
    var dow = span('today-dow', date);
    span('today-sep', date, ', ');
    els = { time: time, digits: digits, ampm: ampm, dow: dow, md: span('today-md', date), form: form };
  }

  // The date for the tile's size, in two parts: "Sunday" ", " "November 15",
  // "Sun, Nov 15" in a narrow tile. In a strip the CSS hides the ", " and
  // stacks the two parts beside the time, "Sunday" over "November 15"; a
  // part too long for the room left by the time (a late hour, a longer
  // language) takes its short form, "Wed" or "Sep 30", before it would end
  // in "...".
  function drawDate(now) {
    var narrow = els.form === 'narrow';
    var fit = els.form === 'strip';
    datePart(els.dow, now, { weekday: narrow ? 'short' : 'long' }, fit && { weekday: 'short' });
    datePart(els.md, now, { month: narrow ? 'short' : 'long', day: 'numeric' }, fit && { month: 'short', day: 'numeric' });
  }

  function datePart(node, now, opts, shortOpts) {
    node.textContent = dateText(now, opts);
    if (shortOpts && node.scrollWidth > node.clientWidth + 1) node.textContent = dateText(now, shortOpts);
  }

  function tick() {
    if (mini) miniTick();
    if (sunTile) sunTileTick();
    if (sunDial) sunDialTick();
    if (!els) return;
    var now = new Date();
    var t = timeParts(now);
    els.digits.textContent = t.digits;
    els.ampm.textContent = t.ampm;
    els.ampm.style.display = t.ampm ? '' : 'none';
    drawDate(now);
    var shape = t.digits.length + (t.ampm ? 'a' : '');
    if (els.fitted !== shape) {
      els.fitted = shape;
      fitWidth(els.time, els.ampm);
      // The time's width changed, so the date may fit in full again (or no longer).
      drawDate(now);
    }
  }

  /* ---------- the analog face, on the tile and the page ---------- */

  // The analog face, 200 units across: hairline minute ticks, bolder hour
  // ticks, the four quarter numerals, the day-date window in the lower half,
  // and three hands, each a group turned about the centre.
  //
  // win: 'full' ("SUN 15", the default), 'day' ("15" in a smaller window
  // with bigger figures, for a small face) or 'none'.
  function drawFace(parent, win) {
    win = win || 'full';
    var svg = svgEl('svg', { viewBox: '0 0 200 200', 'class': 'clock-svg' + (win === 'full' ? '' : ' clock-svg-small'), focusable: 'false', 'aria-hidden': 'true' }, parent);
    svgEl('circle', { cx: 100, cy: 100, r: 98, 'class': 'clock-dial' }, svg);
    svgEl('circle', { cx: 100, cy: 100, r: 86, 'class': 'clock-dial-ring' }, svg);
    for (var i = 0; i < 60; i++) {
      var hour = i % 5 === 0;
      var a = i * Math.PI / 30;
      var r1 = hour ? 81 : 88;
      var r2 = 93;
      var sx = Math.sin(a);
      var cy = -Math.cos(a);
      svgEl('line', {
        x1: (100 + r1 * sx).toFixed(2), y1: (100 + r1 * cy).toFixed(2),
        x2: (100 + r2 * sx).toFixed(2), y2: (100 + r2 * cy).toFixed(2),
        'class': hour ? 'clock-tick-h' : 'clock-tick-m'
      }, svg);
    }
    var nums = [[12, 100, 38], [3, 166, 100], [6, 100, 162], [9, 34, 100]];
    for (var n = 0; n < nums.length; n++) {
      var t = svgEl('text', { x: nums[n][1], y: nums[n][2], 'class': 'clock-num', 'text-anchor': 'middle', dy: '0.35em' }, svg);
      t.textContent = String(nums[n][0]);
    }
    // The day-date window: "SUN 15" (room for 56 units of text), or "15".
    // Each window is centred in the free space between the centre cap
    // (bottom at 104.6) and the top of the 6 (about 154.7 at 19px, 153.1 at
    // the small face's 23px): equal gaps above and below. The text's
    // visible middle (capitals and figures) sits on the window's middle; an
    // accent on a capital (SÁB, MIÉ) still has room above it.
    var wtext = null;
    var wmax = 0;
    if (win === 'day') {
      svgEl('rect', { x: 82, y: 115.85, width: 36, height: 26, rx: 4.5, ry: 4.5, 'class': 'clock-window' }, svg);
      wtext = svgEl('text', { x: 100, y: 128.85, 'class': 'clock-window-text clock-window-day', 'text-anchor': 'middle', dy: '0.36em' }, svg);
      wmax = 30;
    } else if (win !== 'none') {
      svgEl('rect', { x: 68, y: 116.65, width: 64, height: 26, rx: 4.5, ry: 4.5, 'class': 'clock-window' }, svg);
      // x 100.4, not 100: the text's letter-spacing adds a trailing gap
      // after the last figure, which pulls the visible ink left of centre.
      wtext = svgEl('text', { x: 100.4, y: 129.65, 'class': 'clock-window-text', 'text-anchor': 'middle', dy: '0.368em' }, svg);
      wmax = 56;
    }

    var hh = svgEl('g', { 'class': 'clock-hand clock-hand-h' }, svg);
    svgEl('line', { x1: 100, y1: 114, x2: 100, y2: 52 }, hh);
    var mh = svgEl('g', { 'class': 'clock-hand clock-hand-m' }, svg);
    svgEl('line', { x1: 100, y1: 116, x2: 100, y2: 22 }, mh);
    var sh = svgEl('g', { 'class': 'clock-hand clock-hand-s' }, svg);
    svgEl('line', { x1: 100, y1: 126, x2: 100, y2: 16 }, sh);
    svgEl('circle', { cx: 100, cy: 100, r: 4.6, 'class': 'clock-cap' }, svg);
    svgEl('circle', { cx: 100, cy: 100, r: 1.7, 'class': 'clock-cap-dot' }, svg);
    return { svg: svg, h: hh, m: mh, s: sh, win: wtext, winMode: win, winMax: wmax };
  }

  function turn(g, deg) { g.setAttribute('transform', 'rotate(' + deg.toFixed(2) + ' 100 100)'); }

  // The hands and the window for now. Text is only touched when it changes.
  function setFace(f, now) {
    var s = now.getSeconds();
    var m = now.getMinutes();
    turn(f.s, s * 6);
    turn(f.m, m * 6 + s * 0.1);
    turn(f.h, (now.getHours() % 12) * 30 + m * 0.5);
    drawWindow(f, now);
  }

  // "SUN 15" (or "15") in the window. A longer weekday (another language,
  // "MIÉ", "SÁB") is squeezed to the window's width rather than spilling
  // past it; when the face can't be measured (not on screen yet) anything
  // longer than "SUN 15" is squeezed anyway.
  function drawWindow(f, now) {
    var w = f.win;
    if (!w) return;
    var day = String(now.getDate());
    var text = f.winMode === 'day' ? day :
      dateText(now, { weekday: 'short' }).replace(/\.$/, '').toUpperCase() + ' ' + day;
    if (w.textContent === text) return;
    w.textContent = text;
    w.removeAttribute('textLength');
    w.removeAttribute('lengthAdjust');
    var len = 0;
    try { len = w.getComputedTextLength(); } catch (e) { len = 0; }
    if (len > f.winMax || (!len && text.length > (f.winMode === 'day' ? 2 : 6))) {
      w.setAttribute('textLength', String(f.winMax));
      w.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }

  /* ---------- the analog tile ---------- */

  // Which window a face this many pixels across can read: "MON 16" from
  // about 7.5rem (the window text is then ~12px), "16" from 3rem.
  function windowFor(px) {
    var r = rem();
    return px >= 7.5 * r ? 'full' : px >= 3 * r ? 'day' : 'none';
  }

  function drawAnalogTile(el, size) {
    var box = div('today-face', el);
    var px = Math.min(box.clientWidth, box.clientHeight);
    // Not laid out (hidden): judge by the grid size instead.
    var win = px > 0 ? windowFor(px) :
      size && size.rows >= 2 && size.cols >= 2 ? 'full' : 'day';
    tileFace = drawFace(box, win);
    box.setAttribute('data-window', win);
    tileTick();
    startTileTicking();
  }

  function tileTick() {
    if (tileFace) setFace(tileFace, new Date());
  }

  // One loop, just after each whole second, while the analog face is on
  // the tile. Every renderTile stops it first, so a redraw never leaves
  // two running.
  function startTileTicking() {
    stopTileTicking();
    function loop() {
      if (!tileFace) { tileTimer = null; return; }
      tileTick();
      tileTimer = setTimeout(loop, 1010 - (new Date().getTime() % 1000));
    }
    tileTimer = setTimeout(loop, 1010 - (new Date().getTime() % 1000));
  }

  function stopTileTicking() {
    if (tileTimer) clearTimeout(tileTimer);
    tileTimer = null;
  }

  /* ---------- the small analog strip (3x1 and wider) ---------- */

  // A plain face for a small size: 12 marks (the quarters longer), the
  // hour and minute hands, no numbers, no window, no second hand.
  function drawMiniFace(parent) {
    var svg = svgEl('svg', { viewBox: '0 0 200 200', 'class': 'clock-svg clock-svg-mini', focusable: 'false', 'aria-hidden': 'true' }, parent);
    svgEl('circle', { cx: 100, cy: 100, r: 98, 'class': 'clock-dial' }, svg);
    for (var i = 0; i < 12; i++) {
      var a = i * Math.PI / 6;
      var q = i % 3 === 0;
      var r1 = q ? 74 : 84;
      svgEl('line', {
        x1: (100 + r1 * Math.sin(a)).toFixed(2), y1: (100 - r1 * Math.cos(a)).toFixed(2),
        x2: (100 + 92 * Math.sin(a)).toFixed(2), y2: (100 - 92 * Math.cos(a)).toFixed(2),
        'class': 'clock-tick-h' + (q ? ' is-quarter' : '')
      }, svg);
    }
    var hh = svgEl('g', { 'class': 'clock-hand clock-hand-h' }, svg);
    svgEl('line', { x1: 100, y1: 112, x2: 100, y2: 48 }, hh);
    var mh = svgEl('g', { 'class': 'clock-hand clock-hand-m' }, svg);
    svgEl('line', { x1: 100, y1: 114, x2: 100, y2: 20 }, mh);
    svgEl('circle', { cx: 100, cy: 100, r: 7, 'class': 'clock-cap' }, svg);
    svgEl('circle', { cx: 100, cy: 100, r: 2.6, 'class': 'clock-cap-dot' }, svg);
    return { h: hh, m: mh };
  }

  function drawMiniTile(el) {
    var box = div('today-mini-face', el);
    var txt = div('today-mini-txt', el);
    var time = div('today-mini-time', txt);
    mini = {
      face: drawMiniFace(box),
      time: time,
      digits: span('today-digits', time),
      ampm: span('today-ampm', time),
      date: div('today-mini-date', txt),
      shown: ''
    };
    miniTick();
  }

  // Every 15 seconds with the digital tile's tick: the hands, the time and
  // "Tue, Nov 24" ("mié, 30 sept"). Text only when it changes.
  function miniTick() {
    var now = new Date();
    var m = now.getMinutes();
    turn(mini.face.m, m * 6 + now.getSeconds() * 0.1);
    turn(mini.face.h, (now.getHours() % 12) * 30 + m * 0.5);
    var t = timeParts(now);
    var date = shortDate(now);
    var shape = t.digits + '|' + t.ampm + '|' + date;
    if (mini.shown === shape) return;
    mini.shown = shape;
    mini.digits.textContent = t.digits;
    mini.ampm.textContent = t.ampm;
    mini.ampm.style.display = t.ampm ? '' : 'none';
    mini.date.textContent = date;
    fitWidth(mini.time, mini.ampm);
    fitText(mini.date);
  }

  // "Tue, Nov 24" or "mié, 30 sept".
  function shortDate(now) {
    return dateText(now, { weekday: 'short' }) + ', ' + dateText(now, { month: 'short', day: 'numeric' });
  }

  // Shrinks one line of text to fit its width, down to 70%; past that the
  // CSS ends it in "...". Only when drawn or when its text changes.
  // keep: start from the size already set on it (not the CSS's).
  function fitText(node, keep) {
    if (!keep) node.style.fontSize = '';
    if (!node.clientWidth || node.scrollWidth <= node.clientWidth + 1) return;
    var size0 = parseFloat(window.getComputedStyle(node).fontSize) || 20;
    var size = size0;
    while (node.scrollWidth > node.clientWidth + 1 && size > size0 * 0.72) {
      size = size * 0.94;
      node.style.fontSize = size.toFixed(1) + 'px';
    }
  }

  /* ---------- the sun and the moon ---------- */

  var DAY_MS = 864e5;

  // The weather's city point (a rounded spot, never an address).
  function place() {
    var all = (window.HUB_CONFIG && window.HUB_CONFIG.widgets) || {};
    var wl = all.weather && all.weather.location;
    var ok = wl && typeof wl === 'object';
    var lat = ok && typeof wl.latitude === 'number' && isFinite(wl.latitude) ? wl.latitude : 32.78;
    var lon = ok && typeof wl.longitude === 'number' && isFinite(wl.longitude) ? wl.longitude : -96.78;
    return { lat: lat, lon: lon };
  }

  function rad(x) { return x * Math.PI / 180; }
  function deg(x) { return x * 180 / Math.PI; }

  // Sunrise or sunset (ms) on the local day that holds ms, or null when the
  // sun doesn't rise or set that day. The Almanac for Computers method
  // (zenith 90.833: the top edge of the sun, with refraction), good to a
  // minute or two.
  function riseSet(ms, rising, at) {
    var d0 = new Date(ms);
    var y = d0.getFullYear(), m = d0.getMonth() + 1, d = d0.getDate();
    var mid = new Date(y, m - 1, d).getTime();
    var n = Math.floor(275 * m / 9) - Math.floor((m + 9) / 12) * (1 + Math.floor((y - 4 * Math.floor(y / 4) + 2) / 3)) + d - 30;
    var lh = at.lon / 15;
    var t = n + ((rising ? 6 : 18) - lh) / 24;
    var M = 0.9856 * t - 3.289;
    var L = (M + 1.916 * Math.sin(rad(M)) + 0.020 * Math.sin(rad(2 * M)) + 282.634 + 720) % 360;
    var ra = (deg(Math.atan(0.91764 * Math.tan(rad(L)))) + 360) % 360;
    ra = (ra + Math.floor(L / 90) * 90 - Math.floor(ra / 90) * 90) / 15;
    var sd = 0.39782 * Math.sin(rad(L));
    var cd = Math.cos(Math.asin(sd));
    var ch = (Math.cos(rad(90.833)) - sd * Math.sin(rad(at.lat))) / (cd * Math.cos(rad(at.lat)));
    if (ch > 1 || ch < -1) return null;
    var h = (rising ? 360 - deg(Math.acos(ch)) : deg(Math.acos(ch))) / 15;
    var ut = ((h + ra - 0.06571 * t - 6.622 - lh) % 24 + 24) % 24;
    var out = Date.UTC(y, m - 1, d) + ut * 36e5;
    while (out < mid) out += DAY_MS;
    while (out >= mid + DAY_MS) out -= DAY_MS;
    return out;
  }

  // Sunrise and sunset for the day holding ms; 6:00 and 18:00 when the
  // sun stays up or down all day (far north or south).
  function sunDay(ms, at) {
    var d = new Date(ms);
    var mid = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var rise = riseSet(ms, true, at);
    var set = riseSet(ms, false, at);
    if (rise === null || set === null || set <= rise) { rise = mid + 6 * 36e5; set = mid + 18 * 36e5; }
    return { rise: rise, set: set };
  }

  // Where we are: in the day (sunrise to sunset) or the night (sunset to
  // sunrise), how far through it (f, 0 to 1), and the times around it.
  function sunNow(ms) {
    var at = place();
    var today = sunDay(ms, at);
    var y = sunDay(ms - DAY_MS, at);
    var tm = sunDay(ms + DAY_MS, at);
    var s = { day: ms >= today.rise && ms < today.set, today: today, yesterday: y, tomorrow: tm };
    if (s.day) { s.from = today.rise; s.to = today.set; }
    else if (ms >= today.set) { s.from = today.set; s.to = tm.rise; }
    else { s.from = y.set; s.to = today.rise; }
    s.f = Math.max(0, Math.min(1, (ms - s.from) / (s.to - s.from)));
    return s;
  }

  // The moon's age as a part of its 29.53-day cycle: 0 new, 0.25 first
  // quarter, 0.5 full, 0.75 last quarter. From a known new moon (6 January
  // 2000, 18:14 UTC); good to about half a day, plenty for a picture.
  function moonPhase(ms) {
    var p = ((ms - 947182440000) / DAY_MS / 29.530588853) % 1;
    return p < 0 ? p + 1 : p;
  }

  // The lit part of the moon at (cx, cy), radius r, as an SVG path, seen
  // from the north: it grows on the right, wanes from the right. '' near new.
  function moonLit(cx, cy, r, p) {
    if (p < 0.02 || p > 0.98) return '';
    var rx = Math.abs(Math.cos(2 * Math.PI * p)) * r;
    var top = cx.toFixed(1) + ' ' + (cy - r).toFixed(1);
    var bottom = cx.toFixed(1) + ' ' + (cy + r).toFixed(1);
    var waxing = p < 0.5;
    var edge = waxing ? (p < 0.25 ? 0 : 1) : (p > 0.75 ? 1 : 0);
    return 'M ' + top + ' A ' + r + ' ' + r + ' 0 0 ' + (waxing ? 1 : 0) + ' ' + bottom +
      ' A ' + rx.toFixed(2) + ' ' + r + ' 0 0 ' + edge + ' ' + top + ' Z';
  }

  var arcIds = 0;

  // The arc for where we are, W units across with radius r: the dotted
  // path, the part already gone lit (warm by day, cool by night), the
  // horizon, and the sun (or the moon in its phase) at now.
  function drawArc(parent, s, W, r, small, ms) {
    var cx = W / 2, cy = r + (small ? 14 : 20), x0 = cx - r, x1 = cx + r;
    var night = !s.day;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + (cy + (small ? 4 : 8)), 'class': 'sun-svg' + (night ? ' is-night' : ''),
      preserveAspectRatio: 'xMidYMax meet', focusable: 'false', 'aria-hidden': 'true' }, parent);
    var id = 'sun-lit-' + (++arcIds);
    var defs = svgEl('defs', {}, svg);
    var g = svgEl('linearGradient', { id: id, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
    svgEl('stop', { offset: 0, 'class': 'sun-g0' }, g);
    svgEl('stop', { offset: 1, 'class': 'sun-g1' }, g);
    var foot = small ? 10 : 34;
    svgEl('path', { d: 'M ' + x0 + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + x1 + ' ' + cy, 'class': 'sun-track' }, svg);
    svgEl('line', { x1: x0 - foot, y1: cy, x2: x1 + foot, y2: cy, 'class': 'sun-horizon' }, svg);
    var a = Math.PI * (1 - s.f);
    var px = cx + r * Math.cos(a), py = cy - r * Math.sin(a);
    if (s.f > 0.002) {
      svgEl('path', { d: 'M ' + x0 + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + px.toFixed(1) + ' ' + py.toFixed(1),
        'class': 'sun-lit', stroke: 'url(#' + id + ')' }, svg);
    }
    var fr = small ? 2.5 : 4;
    svgEl('circle', { cx: x0, cy: cy, r: fr, 'class': 'sun-foot' }, svg);
    svgEl('circle', { cx: x1, cy: cy, r: fr, 'class': 'sun-foot' }, svg);
    var dr = small ? 8 : night ? 19 : 15;
    svgEl('circle', { cx: px.toFixed(1), cy: py.toFixed(1), r: small ? 13 : 30, 'class': 'sun-glow' }, svg);
    if (!night) {
      svgEl('circle', { cx: px.toFixed(1), cy: py.toFixed(1), r: dr, 'class': 'sun-disc' }, svg);
    } else {
      // The moon: its dark side faint, its lit side bright.
      svgEl('circle', { cx: px.toFixed(1), cy: py.toFixed(1), r: dr, 'class': 'moon-dark' }, svg);
      var lit = moonLit(px, py, dr, moonPhase(ms));
      if (lit) svgEl('path', { d: lit, 'class': 'moon-lit' }, svg);
    }
    return svg;
  }

  // "7 h 13 min", "45 min".
  function span2(ms) {
    var t = Math.max(0, Math.round(ms / 6e4));
    var h = Math.floor(t / 60), m = t % 60;
    return h ? T('hm', '{h} h {m} min').replace('{h}', h).replace('{m}', m) : T('m', '{m} min').replace('{m}', m);
  }

  // "5:22 PM" (12- or 24-hour, as chosen).
  function at(ms) {
    var t = timeParts(new Date(ms));
    return t.digits + (t.ampm ? ' ' + t.ampm : '');
  }

  /* ---------- the Sun path tile ---------- */

  // A strip: the arc with the time in it, and beside it "Nov 24" over
  // "Sunset 5:22 PM". Bigger tiles: the arc on top, the two lines under it.
  // A 2-column strip has room for the date only; a 1x1 strip for the arc;
  // a taller 1-column tile for the arc and "Nov 24".
  function drawSunTile(el, strip, cols) {
    el.classList.add('today-sun');
    if (strip) el.classList.add('is-strip');
    el.classList.remove('is-cols-1');
    el.classList.remove('is-cols-2');
    if (strip && cols < 3) el.classList.add('is-cols-' + Math.max(1, cols));
    else if (cols <= 1) el.classList.add('is-cols-1');
    var arc = div('today-sun-arc', el);
    var txt = div('today-sun-txt', el);
    sunTile = {
      strip: strip,
      short: strip || cols <= 1,
      arc: arc,
      svgBox: div('today-sun-svg', arc),
      time: div('today-sun-time', arc),
      date: div('today-sun-date', txt),
      next: div('today-sun-next', txt),
      el: el,
      txt: txt,
      sized: false,
      shown: ''
    };
    sunTileTick();
    // Not laid out yet (the hub is still placing the tile): measure again shortly.
    if (!sunTile.sized) {
      var mine = sunTile;
      setTimeout(function () { if (sunTile === mine) sunTileTick(); }, 250);
    }
  }

  // Once per draw, when the tile can be measured: a bigger tile gets an
  // arc twice as wide as it is tall, as big as the room under the text
  // allows (a strip's arc is set by the CSS), and the time inside it in
  // proportion, so it sits under the arc at any size.
  function sizeSunTile() {
    var t = sunTile;
    if (t.strip && t.el.clientHeight > 6 * rem()) {
      // A wide 2-row tile: the arc as tall as the tile, up to half its width.
      t.arc.style.width = Math.floor(Math.min(t.el.clientHeight * 2, t.el.clientWidth * 0.5)) + 'px';
    } else if (!t.strip) {
      var w = t.el.clientWidth;
      var room = t.el.clientHeight - t.txt.offsetHeight - 0.3 * rem();
      if (!w || room <= 0) return false;
      w = Math.min(w, Math.floor(room * 2), Math.floor(18 * rem()));
      t.arc.style.width = w + 'px';
      t.arc.style.height = Math.floor(w / 2) + 'px';
    }
    var aw = t.arc.clientWidth;
    if (!aw) return false;
    t.time.style.fontSize = Math.max(14, Math.round(aw * 0.2)) + 'px';
    return true;
  }

  function sunTileTick() {
    var now = new Date();
    var ms = now.getTime();
    var s = sunNow(ms);
    var t = timeParts(now);
    var date = sunTile.short ? dateText(now, { month: 'short', day: 'numeric' }) : shortDate(now);
    // At night before midnight the next sunrise is tomorrow's: a sunrise
    // mark and "Tomorrow 7:06 AM" (short enough for the strip in Spanish).
    var tomorrow = !s.day && new Date(s.to).toDateString() !== now.toDateString();
    var next = s.day ? T('sunset', 'Sunset') + ' ' + at(s.to) :
      (tomorrow ? T('sunriseTomorrow', 'Tomorrow') : T('sunrise', 'Sunrise')) + ' ' + at(s.to);
    // The arc moves about a pixel every few minutes: drawn again each minute.
    var shape = t.digits + '|' + date + '|' + next + (tomorrow ? '+' : '') + '|' + Math.floor(ms / 6e4);
    if (sunTile.shown === shape && sunTile.sized) return;
    var refit = !sunTile.shown || sunTile.shown.split('|')[0].length !== t.digits.length;
    sunTile.shown = shape;
    sunTile.svgBox.innerHTML = '';
    drawArc(sunTile.svgBox, s, 200, 82, true, ms);
    sunTile.time.textContent = t.digits;
    sunTile.date.textContent = date;
    sunTile.next.textContent = next;
    if (tomorrow && window.HUB_ICONS) {
      var mark = document.createElement('span');
      mark.className = 'today-sun-mark';
      mark.innerHTML = window.HUB_ICONS['wx-sunrise'] || '';
      sunTile.next.insertBefore(mark, sunTile.next.firstChild);
    }
    if (!sunTile.sized) { sunTile.sized = sizeSunTile(); refit = true; }
    if (refit && sunTile.sized) {
      // From the proportional size, shrunk only if the digits still don't fit.
      fitText(sunTile.time, true);
    }
    fitText(sunTile.date);
    fitText(sunTile.next);
    if (sunTile.strip && sunTile.sized) alignSunStrip();
  }

  // Where a line of text sits (its baseline), in px from the top of the page.
  function baseline(node) {
    var probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0';
    node.appendChild(probe);
    var y = probe.getBoundingClientRect().top;
    node.removeChild(probe);
    return y;
  }

  // A strip: the arc raised so its horizon sits on the baseline of the
  // last line beside it ("Sunrise 7:06 AM", or the date when that's
  // hidden). The drawing sits at the bottom of its box, so the box's
  // bottom (and the time's) moves up; the drawing never leaves the tile.
  function alignSunStrip() {
    var t = sunTile;
    var line = t.next.offsetHeight ? t.next : t.date.offsetHeight ? t.date : null;
    var hz = t.svgBox.querySelector('.sun-horizon');
    if (!line || !hz) return;
    var r = hz.getBoundingClientRect();
    var lift = (parseFloat(t.lift) || 0) + (r.top + r.height / 2) - baseline(line);
    lift = Math.max(0, Math.min(lift, t.arc.clientHeight * 0.3));
    if (Math.abs(lift - (t.lift || 0)) < 0.5) return;
    t.lift = Math.round(lift);
    t.svgBox.style.bottom = 'calc(0.15rem + ' + t.lift + 'px)';
    t.time.style.bottom = 'calc(0.35rem + ' + t.lift + 'px)';
  }

  /* ---------- the sun and the moon in the sky ---------- */

  // Low-precision places of the sun and the moon (about a degree): where
  // each is in the sky now, for the 24-hour dial. Days from J2000.0.
  function j2000(ms) { return ms / DAY_MS - 10957.5; }

  function sunRaDec(d) {
    var L = 280.460 + 0.9856474 * d, g = rad(357.528 + 0.9856003 * d);
    var lam = rad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), e = rad(23.439);
    return { ra: deg(Math.atan2(Math.cos(e) * Math.sin(lam), Math.cos(lam))), dec: deg(Math.asin(Math.sin(e) * Math.sin(lam))) };
  }

  function moonRaDec(d) {
    var L = 218.316 + 13.176396 * d, M = rad(134.963 + 13.064993 * d), F = rad(93.272 + 13.229350 * d);
    var D = rad(297.850 + 12.190749 * d), Ms = rad(357.529 + 0.98560028 * d);
    var lon = rad(L + 6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms));
    var lat = rad(5.128 * Math.sin(F)), e = rad(23.439);
    return {
      ra: deg(Math.atan2(Math.sin(lon) * Math.cos(e) - Math.tan(lat) * Math.sin(e), Math.cos(lon))),
      dec: deg(Math.asin(Math.sin(lat) * Math.cos(e) + Math.cos(lat) * Math.sin(e) * Math.sin(lon)))
    };
  }

  // Hour angle (degrees, -180 to 180: below zero is still rising, east)
  // and height above the horizon (degrees) of a body at ms.
  function skyPlace(ms, eq, at) {
    var st = 280.46061837 + 360.98564736629 * j2000(ms) + at.lon;
    var H = ((st - eq.ra) % 360 + 540) % 360 - 180;
    var p = rad(at.lat), de = rad(eq.dec);
    return { H: H, alt: deg(Math.asin(Math.sin(p) * Math.sin(de) + Math.cos(p) * Math.cos(de) * Math.cos(rad(H)))) };
  }

  function moonPlace(ms, at) { return skyPlace(ms, moonRaDec(j2000(ms)), at); }

  // The next moonrise (up false) or moonset (up true) after ms, to five
  // minutes, looking up to 36 hours ahead; null when there is none.
  function moonNext(ms, at, up) {
    var step = 3e5, prev = moonPlace(ms, at).alt - 0.125;
    for (var t = ms + step; t < ms + 1.5 * DAY_MS; t += step) {
      var a = moonPlace(t, at).alt - 0.125;
      if (up ? (prev > 0 && a <= 0) : (prev < 0 && a >= 0)) return t - step * a / (a - prev);
      prev = a;
    }
    return null;
  }

  /* ---------- the 24-hour Sun dial (3x2 and bigger) ---------- */

  // The whole day on a dial: noon at the top, midnight at the bottom,
  // morning on the left (east). The day (sunrise to sunset) is the warm
  // part of the ring, the night the cool part, the dashed line between
  // sunrise and sunset the horizon. The sun sits at the time, the moon
  // where it really is (its hour angle against the sun's), faint when it's
  // below the horizon. Beside it: the date, the next sunrise or sunset and
  // the next moonrise or moonset.
  function drawSunDial(el) {
    el.classList.add('today-sund');
    var art = div('sund-art', el);
    var txt = div('sund-txt', el);
    var date = div('sund-date', txt);
    div('sund-rule', txt);
    function stat() {
      var box = div('sund-stat', txt);
      var k = div('sund-k', box);
      return { ic: span('sund-ic', k), k: span('sund-kt', k), v: div('sund-v', box) };
    }
    sunDial = { el: el, art: art, txt: txt, date: date, sun: stat(), moon: stat(), shown: '', sized: false, moonEv: null };
    sunDialTick();
    if (!sunDial.sized) {
      var mine = sunDial;
      setTimeout(function () { if (sunDial === mine) { mine.shown = ''; sunDialTick(); } }, 250);
    }
  }

  // The dial as tall as the tile (at most 55% of its width); the text in
  // proportion to it.
  function sizeSunDial() {
    var t = sunDial;
    var h = t.el.clientHeight, w = t.el.clientWidth;
    if (!h || !w) return false;
    var px = Math.floor(Math.min(h, w * 0.55));
    t.art.style.width = px + 'px';
    t.art.style.height = px + 'px';
    t.txt.style.fontSize = (px / 7.6).toFixed(1) + 'px';
    return true;
  }

  function dialPoint(c, r, a) { return [c + r * Math.sin(a), c - r * Math.cos(a)]; }

  // The angle (radians from the top, clockwise) of a clock time.
  function dialAngle(ms) {
    var d = new Date(ms);
    return ((d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600) - 12) * Math.PI / 12;
  }

  function drawDial(parent, ms, s, moon, phase) {
    var c = 100, R = 80, here = place();
    var svg = svgEl('svg', { viewBox: '8 8 184 184', 'class': 'sund-svg', focusable: 'false', 'aria-hidden': 'true' }, parent);
    svgEl('circle', { cx: c, cy: c, r: R + 10, 'class': 'sund-face' }, svg);
    var rp = dialPoint(c, R, dialAngle(s.today.rise)), sp = dialPoint(c, R, dialAngle(s.today.set));
    var rx = rp[0].toFixed(1), ry = rp[1].toFixed(1), sx = sp[0].toFixed(1), sy = sp[1].toFixed(1);
    svgEl('path', { d: 'M ' + sx + ' ' + sy + ' A ' + R + ' ' + R + ' 0 1 1 ' + rx + ' ' + ry, 'class': 'sund-night' }, svg);
    svgEl('path', { d: 'M ' + rx + ' ' + ry + ' A ' + R + ' ' + R + ' 0 0 1 ' + sx + ' ' + sy, 'class': 'sund-day' }, svg);
    svgEl('line', { x1: (rp[0] - 10).toFixed(1), y1: ry, x2: (sp[0] + 10).toFixed(1), y2: sy, 'class': 'sund-horizon' }, svg);
    for (var h = 0; h < 24; h++) {
      var big = h % 6 === 0, a = (h - 12) * Math.PI / 12;
      var p1 = dialPoint(c, R - 9, a), p2 = dialPoint(c, R - (big ? 17 : 12), a);
      svgEl('line', { x1: p1[0].toFixed(1), y1: p1[1].toFixed(1), x2: p2[0].toFixed(1), y2: p2[1].toFixed(1), 'class': 'sund-tick' + (big ? ' is-big' : '') }, svg);
    }
    svgEl('text', { x: c, y: c - R + 32, 'class': 'sund-lab' }, svg).textContent = T('noon', 'Noon');
    svgEl('text', { x: c, y: c + R - 23, 'class': 'sund-lab' }, svg).textContent = T('midnight', 'Midnight');
    svgEl('circle', { cx: rx, cy: ry, r: 2.6, 'class': 'sund-foot' }, svg);
    svgEl('circle', { cx: sx, cy: sy, r: 2.6, 'class': 'sund-foot' }, svg);
    svgEl('text', { x: c, y: c + 11, 'class': 'sund-time' }, svg).textContent = timeParts(new Date(ms)).digits;
    // The moon: as far round from the sun as its hour angle is from the sun's.
    var sunH = skyPlace(ms, sunRaDec(j2000(ms)), here).H;
    var mp = dialPoint(c, R, dialAngle(ms) + rad(moon.H - sunH));
    var mx = +mp[0].toFixed(1), my = +mp[1].toFixed(1);
    var mg = svgEl('g', { 'class': 'sund-moon' + (moon.alt > 0.125 ? '' : ' is-down') }, svg);
    svgEl('circle', { cx: mx, cy: my, r: 17, 'class': 'sun-glow' }, mg);
    svgEl('circle', { cx: mx, cy: my, r: 9, 'class': 'moon-dark' }, mg);
    var lit = moonLit(mx, my, 9, phase);
    if (lit) svgEl('path', { d: lit, 'class': 'moon-lit' }, mg);
    var up = dialPoint(c, R, dialAngle(ms));
    var sg = svgEl('g', { 'class': 'sund-sun' + (s.day ? '' : ' is-down') }, svg);
    svgEl('circle', { cx: up[0].toFixed(1), cy: up[1].toFixed(1), r: 17, 'class': 'sun-glow' }, sg);
    svgEl('circle', { cx: up[0].toFixed(1), cy: up[1].toFixed(1), r: 8.5, 'class': 'sun-disc' }, sg);
    return svg;
  }

  // A small sun, a small moon in its phase, or the sunrise mark, for a line.
  function dialIcon(box, kind, phase) {
    box.innerHTML = '';
    if (kind === 'rise') { box.innerHTML = (window.HUB_ICONS && window.HUB_ICONS['wx-sunrise']) || ''; return; }
    var svg = svgEl('svg', { viewBox: '0 0 20 20', focusable: 'false', 'aria-hidden': 'true' }, box);
    if (kind === 'sun') { svgEl('circle', { cx: 10, cy: 10, r: 5, 'class': 'sun-disc' }, svg); return; }
    svgEl('circle', { cx: 10, cy: 10, r: 6, 'class': 'moon-dark' }, svg);
    var lit = moonLit(10, 10, 6, phase);
    if (lit) svgEl('path', { d: lit, 'class': 'moon-lit' }, svg);
  }

  function sunDialTick() {
    var t = sunDial;
    var now = new Date(), ms = now.getTime(), here = place();
    var s = sunNow(ms);
    var moon = moonPlace(ms, here), moonUp = moon.alt > 0.125, phase = moonPhase(ms);
    if (!t.moonEv || ms >= t.moonEv.at || t.moonEv.up !== moonUp) {
      var next = moonNext(ms, here, moonUp);
      t.moonEv = next ? { at: next, up: moonUp } : null;
    }
    var tomorrow = !s.day && new Date(s.to).toDateString() !== now.toDateString();
    var sunK = s.day ? T('sunset', 'Sunset') : tomorrow ? T('sunriseTomorrow', 'Tomorrow') : T('sunrise', 'Sunrise');
    var moonK = moonUp ? T('moonset', 'Moonset') : T('moonrise', 'Moonrise');
    var moonV = t.moonEv ? at(t.moonEv.at) : '–';
    var date = shortDate(now);
    var shape = Math.floor(ms / 6e4) + '|' + date + '|' + sunK + '|' + moonK + '|' + moonV + '|' + hours;
    if (t.shown === shape && t.sized) return;
    t.shown = shape;
    if (!t.sized) t.sized = sizeSunDial();
    t.art.innerHTML = '';
    drawDial(t.art, ms, s, moon, phase);
    t.date.textContent = date;
    dialIcon(t.sun.ic, s.day ? 'sun' : tomorrow ? 'rise' : 'sun');
    t.sun.k.textContent = sunK;
    t.sun.v.textContent = at(s.to);
    dialIcon(t.moon.ic, 'moon', phase);
    t.moon.k.textContent = moonK;
    t.moon.v.textContent = moonV;
    fitText(t.date);
    fitText(t.sun.k.parentNode);
    fitText(t.sun.v);
    fitText(t.moon.k.parentNode);
    fitText(t.moon.v);
  }


  /* ---------- the Sun path page ---------- */

  function drawSunPage(display) {
    var root = div('sun-page', display);
    var stage = div('sun-stage', root);
    var svgBox = div('sun-stage-svg', stage);
    var read = div('sun-read', stage);
    var big = div('sun-time', read);
    page.digits = span('clock-digits', big);
    page.ampm = span('clock-ampm', big);
    page.fitBox = big;
    page.date = div('clock-fulldate sun-date', root);
    page.dow = span('clock-dow', page.date);
    span('clock-sep', page.date, ', ');
    page.mdy = span('clock-mdy', page.date);
    var stats = div('sun-stats', root);
    var cells = [];
    for (var i = 0; i < 3; i++) {
      var c = div('sun-stat' + (i === 1 ? ' is-mid' : i === 2 ? ' is-end' : ''), stats);
      cells.push({ k: div('sun-k', c), v: div('sun-v', c) });
    }
    page.sun = { root: root, svgBox: svgBox, cells: cells, note: div('sun-note', root), key: '' };
  }

  // Once a minute while the page is open: the arc, the three figures and
  // the line under them. Day: Sunrise, Daylight left, Sunset, and the day's
  // length against yesterday's. Night: Sunset, Sunrise in, Sunrise, and
  // tomorrow's daylight.
  function sunPageTick(now) {
    var ms = now.getTime();
    var key = String(Math.floor(ms / 6e4)) + hours;
    if (page.sun.key === key) return;
    page.sun.key = key;
    var s = sunNow(ms);
    page.sun.root.className = 'sun-page' + (s.day ? '' : ' is-night');
    page.sun.svgBox.innerHTML = '';
    drawArc(page.sun.svgBox, s, 600, 215, false, ms);
    var rows = s.day ?
      [[T('sunrise', 'Sunrise'), at(s.from)], [T('daylightLeft', 'Daylight left'), span2(s.to - ms)], [T('sunset', 'Sunset'), at(s.to)]] :
      [[T('sunset', 'Sunset'), at(s.from)], [T('sunriseIn', 'Sunrise in'), span2(s.to - ms)], [T('sunrise', 'Sunrise'), at(s.to)]];
    for (var i = 0; i < 3; i++) {
      page.sun.cells[i].k.textContent = rows[i][0];
      page.sun.cells[i].v.textContent = rows[i][1];
      fitText(page.sun.cells[i].k);
      fitText(page.sun.cells[i].v);
    }
    var note;
    if (s.day) {
      var len = s.today.set - s.today.rise;
      var diff = Math.round((len - (s.yesterday.set - s.yesterday.rise)) / 6e4);
      note = T('dayLength', 'Day length {d}').replace('{d}', span2(len));
      if (diff) {
        note += ' · ' + (diff < 0 ? T('shorter', '{n} min shorter than yesterday') : T('longer', '{n} min longer than yesterday')).replace('{n}', Math.abs(diff));
      }
    } else {
      // The coming day: tomorrow's after sunset, today's before sunrise.
      var next = ms >= s.today.set ? s.tomorrow : s.today;
      note = T('tomorrowLight', 'Tomorrow: {d} of daylight').replace('{d}', span2(next.set - next.rise));
      if (next === s.today) note = T('todayLight', 'Today: {d} of daylight').replace('{d}', span2(next.set - next.rise));
    }
    page.sun.note.textContent = note;
    fitText(page.sun.note);
  }

  /* ---------- the page ---------- */

  function option(parent, key, label, selected) {
    var b = div('clock-opt f' + (selected ? ' is-selected' : ''), parent);
    b.setAttribute('data-key', key);
    span('clock-opt-dot', b);
    span('clock-opt-label', b, label);
    if (selected) b.setAttribute('data-autofocus', '');
    return b;
  }

  function group(parent, label, opts) {
    var g = div('clock-group', parent);
    div('clock-group-label', g, label);
    var seg = div('clock-seg' + (opts.length > 2 ? ' is-three' : ''), g);
    for (var i = 0; i < opts.length; i++) option(seg, opts[i][0], opts[i][1], opts[i][2]);
    return g;
  }

  // Once a second while the page is open: the digital time, the date, the hands.
  // Text is only touched when it changes.
  function pageTick() {
    if (!page) return;
    var now = new Date();
    var t = timeParts(now);
    var shape = t.digits + '|' + t.ampm;
    if (page.digits && page.shown !== shape) {
      var refit = !page.shown || page.shown.length !== shape.length;
      page.shown = shape;
      page.digits.textContent = t.digits;
      page.ampm.textContent = t.ampm;
      page.ampm.style.display = t.ampm ? '' : 'none';
      if (refit && page.fitBox) fitWidth(page.fitBox, page.ampm);
    }
    // "Sunday" ", " "November 15, 2026": one line under the digital time,
    // the weekday over the rest beside the analog face.
    var dow = dateText(now, { weekday: 'long' });
    var mdy = dateText(now, face === 'sun' ? { month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', year: 'numeric' });
    if (page.dow.textContent !== dow) page.dow.textContent = dow;
    if (page.mdy.textContent !== mdy) page.mdy.textContent = mdy;
    if (page.analog) setFace(page.analog, now);
    if (page.sun) sunPageTick(now);
  }

  function startTicking() {
    stopTicking();
    function loop() {
      pageTick();
      // Just after the next whole second, so the second hand keeps step.
      pageTimer = setTimeout(loop, 1010 - (new Date().getTime() % 1000));
    }
    pageTimer = setTimeout(loop, 1010 - (new Date().getTime() % 1000));
  }

  function stopTicking() {
    if (pageTimer) clearTimeout(pageTimer);
    pageTimer = null;
  }

  // The analog face as large as the room allows: the full height of the
  // display, leaving the date beside it at least ~12rem. Measured once
  // per draw, never each second.
  function fitFace() {
    if (!page || !page.analog) return;
    var box = page.display;
    var r = rem();
    var room = Math.min(box.clientHeight - 0.4 * r, box.clientWidth - (page.full ? 22 : 13) * r);
    var size = Math.max(6 * r, Math.floor(room));
    page.faceBox.style.width = size + 'px';
    page.faceBox.style.height = size + 'px';
  }

  function dateEls(parent) {
    page.date = div('clock-fulldate', parent);
    page.dow = span('clock-dow', page.date);
    span('clock-sep', page.date, ', ');
    page.mdy = span('clock-mdy', page.date);
  }

  function drawPage(body, ctx) {
    var full = ctx.mode && ctx.mode() === 'full';
    var root = div('clock-page is-' + face + (full ? ' is-full' : ''), body);
    var main = div('clock-main', root);
    var display = div('clock-display', main);
    page = { root: root, display: display, full: full, shown: null, analog: null, sun: null, fitBox: null, digits: null, ampm: null };

    if (face === 'sun') {
      drawSunPage(display);
    } else if (face === 'analog') {
      // Only the face and, beside it, the date: no digital time.
      var an = div('clock-analog', display);
      page.faceBox = div('clock-face', an);
      page.analog = drawFace(page.faceBox);
      var side = div('clock-side', an);
      dateEls(side);
    } else {
      var dg = div('clock-digital', display);
      var big = div('clock-big', dg);
      page.digits = span('clock-digits', big);
      page.ampm = span('clock-ampm', big);
      dateEls(dg);
      page.fitBox = big;
    }

    var controls = div('clock-controls', main);
    group(controls, T('face', 'Face'), [['face-digital', T('digital', 'Digital'), face === 'digital'], ['face-analog', T('analog', 'Analog'), face === 'analog'], ['face-sun', T('sun', 'Sun'), face === 'sun']]);
    // 12/24 only means something with a digital time (Digital, Sun path);
    // Analog leaves it out (focus and the arrows simply have one group fewer).
    if (face !== 'analog') {
      group(controls, T('clock', 'Clock'), [['hours-12', T('hours12', '12-hour'), hours === '12'], ['hours-24', T('hours24', '24-hour'), hours === '24']]);
    }
    // The look (hub.js HUB_LOOK): Auto follows the sun, Light is the day look, Dark the night look.
    if (window.HUB_LOOK) {
      var lk = window.HUB_LOOK.get();
      var lt = function (k, en) { return I18N() ? I18N().t(k, en) : en; };
      group(controls, lt('look.label', 'Look'), [['look-auto', lt('look.auto', 'Auto'), lk === 'auto'], ['look-day', lt('look.light', 'Light'), lk === 'day'], ['look-night', lt('look.dark', 'Dark'), lk === 'night']]);
    }
    // The hub's language (app/i18n.js), on both faces. Each name is in its
    // own language, so it can always be found again; only the label follows.
    if (I18N()) {
      var lang = I18N().lang();
      group(controls, I18N().t('lang.label', 'Language'), [['lang-en', 'English', lang === 'en'], ['lang-es', 'Español', lang === 'es']]);
    }
    // Guest mode (guest.js): On blurs every dollar amount until it is off again.
    if (window.HUB_GUEST) {
      var guest = window.HUB_GUEST.on();
      var gt = function (k, en) { return I18N() ? I18N().t(k, en) : en; };
      group(controls, gt('guest.label', 'Guest mode'), [['guest-off', gt('guest.off', 'Off'), !guest], ['guest-on', gt('guest.on', 'On'), guest]]);
    }
    // Four groups (Digital, with Language and Guest mode): closer together, so
    // the last one stays inside the panel.
    if (controls.children.length >= 4) controls.className += ' is-tight';
    if (controls.children.length >= 5) controls.className += ' is-tighter';
    // Opened on the face choice: the first thing people change.
    var marked = controls.querySelectorAll('[data-autofocus]');
    for (var i = 1; i < marked.length; i++) marked[i].removeAttribute('data-autofocus');

    fitFace();
    pageTick();
    startTicking();
  }

  function choose(key, ctx) {
    // The language: app/i18n.js remembers it and tells everyone, this page
    // included (the listener in init redraws it).
    if (key === 'lang-en' || key === 'lang-es') {
      if (I18N()) I18N().setLang(key.slice(5));
      return;
    }
    if (key === 'look-auto' || key === 'look-day' || key === 'look-night') {
      if (window.HUB_LOOK) window.HUB_LOOK.set(key.slice(5));
      if (ctx.isOpen()) ctx.redrawPanel();
      return;
    }
    // Guest mode, on or off, only after the PIN (app/pin.js; the Pi checks
    // it). Without the pop-up, or the Pi, nothing changes: it fails closed.
    if (key === 'guest-on' || key === 'guest-off') {
      var want = key === 'guest-on';
      if (!window.HUB_GUEST || window.HUB_GUEST.on() === want) return;
      var P = window.HUB_PIN;
      if (!P || typeof P.ask !== 'function' || P.isOpen()) return;
      var post = ctx.live && typeof ctx.live.post === 'function' ? ctx.live.post : null;
      P.ask({ on: want, post: post }, function (ok, info) {
        // "All screens": the Pi sent it everywhere; say so here.
        if (ok && info && info.all && typeof ctx.toast === 'function') {
          var gw = function (k, en) { return I18N() ? I18N().t(k, en) : en; };
          ctx.toast(want ? gw('guest.allOn', 'Guest mode is on for all screens') : gw('guest.allOff', 'Guest mode is off for all screens'), 3500);
        }
        if (!ok || window.HUB_GUEST.on() === want) return;
        window.HUB_GUEST.set(want);
        // Focus stays on the same choice (redrawPanel keeps its data-key).
        if (ctx.isOpen()) ctx.redrawPanel();
      });
      return;
    }
    var nextFace = key === 'face-digital' ? 'digital' : key === 'face-analog' ? 'analog' : key === 'face-sun' ? 'sun' : face;
    var nextHours = key === 'hours-12' ? '12' : key === 'hours-24' ? '24' : hours;
    if (nextFace === face && nextHours === hours) return;
    if (nextFace !== face) { face = nextFace; save(FACE_KEY, face); }
    if (nextHours !== hours) { hours = nextHours; save(HOURS_KEY, hours); }
    // The tile follows both choices, live.
    ctx.redrawTile();
    ctx.redrawPanel();
  }

  return {
    id: 'today',
    get title() { return T('title', 'Clock'); },
    icon: 'clock',
    head: false,

    init: function (ctx) {
      setInterval(tick, 15000);
      // Face or 12/24 picked on another screen: this one follows.
      if (P() && typeof P().onChange === 'function') {
        P().onChange(function (key) {
          if (key !== 'clock.face' && key !== 'clock.hours') return;
          var f = pick(FACE_KEY, FACES, 'digital');
          var h = pick(HOURS_KEY, ['12', '24'], '12');
          if (f === face && h === hours) return;
          face = f;
          hours = h;
          try { ctx.redrawTile(); } catch (e) { /* the next draw has it */ }
          if (page && ctx.isOpen && ctx.isOpen()) ctx.redrawPanel();
        });
      }
      // A new language (picked here, or sent from the Pi): an open page
      // redraws with its label; focus stays on the same choice.
      if (I18N() && typeof I18N().onChange === 'function') {
        I18N().onChange(function () {
          try { ctx.redrawTile(); } catch (e) { /* the next draw has it */ }
          if (page && ctx && ctx.isOpen && ctx.isOpen()) ctx.redrawPanel();
        });
      }
    },

    renderTile: function (el, ctx) {
      // Whatever was there before is gone (hub.js empties the body).
      stopTileTicking();
      tileFace = null;
      els = null;
      mini = null;
      sunTile = null;
      sunDial = null;
      var size = ctx.size ? ctx.size() : null;
      var strip = !!size && size.tier === 'strip';
      el.classList.add('today-tile');
      el.classList.remove('today-mini');
      el.classList.remove('today-sun');
      el.classList.remove('today-sund');
      el.classList.remove('is-strip');
      if (face === 'sun') {
        el.classList.remove('today-strip');
        el.classList.remove('today-analog');
        // 3 columns by 2 rows and bigger: the 24-hour dial. Smaller: the arc.
        if (!strip && size && size.rows >= 2 && size.cols >= 3) {
          drawSunDial(el);
          return;
        }
        drawSunTile(el, strip, size ? size.cols : 3);
        return;
      }
      if (face === 'analog' && strip && size.cols >= 3) {
        // A wide strip: the small face, the time and the date (miniTick).
        el.classList.remove('today-strip');
        el.classList.remove('today-analog');
        el.classList.add('today-mini');
        drawMiniTile(el);
        return;
      }
      if (face === 'analog') {
        // Only the face, filling the tile's box, centred.
        el.classList.remove('today-strip');
        el.classList.add('today-analog');
        drawAnalogTile(el, size);
        return;
      }
      el.classList.remove('today-analog');
      var form = size && size.tier === 'strip' ? 'strip' : size && size.width === 'narrow' ? 'narrow' : 'wide';
      if (form === 'strip') el.classList.add('today-strip');
      else el.classList.remove('today-strip');
      // One row: the time, and the date stacked to its right. Bigger
      // tiles: the time over the date, in the middle of the tile.
      timeEls(el, form);
      tick();
    },

    renderPanel: function (body, ctx) {
      stopTicking();
      page = null;
      try {
        drawPage(body, ctx);
      } catch (e) {
        if (window.console && console.warn) console.warn('Clock page: ' + (e && e.message));
        stopTicking();
        page = null;
        body.innerHTML = '';
        div('clock-fallback', body, T('broken', 'The clock page couldn’t be shown.'));
      }
    },

    onSelect: function (target, ctx) {
      var key = target.getAttribute('data-key');
      if (key) choose(key, ctx);
    },

    onMode: function (mode, ctx) {
      ctx.redrawPanel();
    },

    onClose: function (ctx) {
      stopTicking();
      page = null;
      ctx.redrawTile();
    }
  };
})());
