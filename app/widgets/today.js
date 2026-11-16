/*
 * Clock. The tile shows the time and the date, nothing else. OK opens the
 * Clock page: a digital or an analog face, a 12-hour or 24-hour clock, and
 * "About this hub" at the bottom (the version, the TV's browser, the motion
 * choice, and the live updates and updates lines when they have something
 * to say). The face and the 12/24 choice are remembered on this TV; the
 * 12/24 choice applies to the tile too.
 *
 * Nothing here animates. The page ticks once a second while it is open
 * (the analog hands are turned with an SVG transform attribute); the tile
 * every 15 seconds.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var FACE_KEY = 'homeHub.clock.face';     // 'digital' | 'analog'
  var HOURS_KEY = 'homeHub.clock.hours';   // '12' | '24'

  var els = null;     // the tile's parts
  var page = null;    // the open page's parts, or null
  var pageTimer = null;

  /* ---------- the two choices, remembered when the TV allows it ---------- */

  function load(key, allowed, fallback) {
    var v = null;
    try { v = window.localStorage ? localStorage.getItem(key) : null; } catch (e) { v = null; }
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function save(key, value) {
    try { if (window.localStorage) localStorage.setItem(key, value); } catch (e) { /* not kept; fine */ }
  }

  var face = load(FACE_KEY, ['digital', 'analog'], 'digital');
  var hours = load(HOURS_KEY, ['12', '24'], '12');

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
    return { digits: (h % 12 || 12) + ':' + mm, ampm: h < 12 ? 'AM' : 'PM' };
  }

  function dateText(now, opts) { return now.toLocaleDateString('en-US', opts); }

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
    var seg = div('clock-seg', g);
    for (var i = 0; i < opts.length; i++) option(seg, opts[i][0], opts[i][1], opts[i][2]);
    return g;
  }

  // The analog face, 200 units across: hairline minute ticks, bolder hour
  // ticks, the four quarter numerals, the day-date window in the lower half,
  // and three hands, each a group turned about the centre.
  function drawFace(parent) {
    var svg = svgEl('svg', { viewBox: '0 0 200 200', 'class': 'clock-svg', focusable: 'false', 'aria-hidden': 'true' }, parent);
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
    // The day-date window: "SUN 15".
    svgEl('rect', { x: 74, y: 118, width: 52, height: 21, rx: 4, ry: 4, 'class': 'clock-window' }, svg);
    var wtext = svgEl('text', { x: 100, y: 128.5, 'class': 'clock-window-text', 'text-anchor': 'middle', dy: '0.35em' }, svg);

    var hh = svgEl('g', { 'class': 'clock-hand clock-hand-h' }, svg);
    svgEl('line', { x1: 100, y1: 114, x2: 100, y2: 52 }, hh);
    var mh = svgEl('g', { 'class': 'clock-hand clock-hand-m' }, svg);
    svgEl('line', { x1: 100, y1: 116, x2: 100, y2: 22 }, mh);
    var sh = svgEl('g', { 'class': 'clock-hand clock-hand-s' }, svg);
    svgEl('line', { x1: 100, y1: 126, x2: 100, y2: 16 }, sh);
    svgEl('circle', { cx: 100, cy: 100, r: 4.6, 'class': 'clock-cap' }, svg);
    svgEl('circle', { cx: 100, cy: 100, r: 1.7, 'class': 'clock-cap-dot' }, svg);
    return { svg: svg, h: hh, m: mh, s: sh, win: wtext };
  }

  function turn(g, deg) { g.setAttribute('transform', 'rotate(' + deg.toFixed(2) + ' 100 100)'); }

  // "SUN 15" in the window. A longer weekday (another language) is squeezed
  // to the window's width rather than spilling past it.
  function drawWindow(now) {
    var w = page.analog.win;
    var text = dateText(now, { weekday: 'short' }).replace(/\.$/, '').toUpperCase() + ' ' + now.getDate();
    if (w.textContent === text) return;
    w.textContent = text;
    w.removeAttribute('textLength');
    w.removeAttribute('lengthAdjust');
    var len = 0;
    try { len = w.getComputedTextLength(); } catch (e) { len = 0; }
    if (len > 44) {
      w.setAttribute('textLength', '44');
      w.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }

  // Once a second while the page is open: the readout, the date, the hands.
  // Text is only touched when it changes.
  function pageTick() {
    if (!page) return;
    var now = new Date();
    var t = timeParts(now);
    var shape = t.digits + '|' + t.ampm;
    if (page.shown !== shape) {
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
    var mdy = dateText(now, { month: 'long', day: 'numeric', year: 'numeric' });
    if (page.dow.textContent !== dow) page.dow.textContent = dow;
    if (page.mdy.textContent !== mdy) page.mdy.textContent = mdy;
    if (page.analog) {
      var s = now.getSeconds();
      var m = now.getMinutes();
      turn(page.analog.s, s * 6);
      turn(page.analog.m, m * 6 + s * 0.1);
      turn(page.analog.h, (now.getHours() % 12) * 30 + m * 0.5);
      drawWindow(now);
    }
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

  // The lines that used to sit on the clock tile, same data and guards.
  function aboutLines(ctx) {
    var out = [];
    var updates;
    try { updates = typeof ctx.updates === 'function' ? ctx.updates() : undefined; } catch (e) { updates = undefined; }
    var newest = !!(updates && updates.newest === true);
    var updateText = updates && typeof updates.text === 'string' ? updates.text : '';
    var browser = '';
    try { browser = ctx.browser ? ctx.browser() : ''; } catch (e) { browser = ''; }
    out.push({ cls: 'clock-about-build', text: ctx.build + (newest ? ' (newest)' : '') + (browser ? ' · ' + browser : '') });
    var motion = '';
    try { motion = ctx.motionStatus ? ctx.motionStatus() : ''; } catch (e) { motion = ''; }
    if (motion) out.push({ cls: 'clock-about-motion', text: motion });
    var live = '';
    try { live = ctx.live ? ctx.live.status().text || '' : ''; } catch (e) { live = ''; }
    if (live) out.push({ cls: 'clock-about-live', text: live });
    if (updateText) out.push({ cls: 'clock-about-updates', text: updateText });
    return out;
  }

  function drawAbout(box, ctx) {
    box.innerHTML = '';
    div('clock-about-title', box, 'About this hub');
    var list = div('clock-about-lines', box);
    var lines = aboutLines(ctx);
    for (var i = 0; i < lines.length; i++) {
      var line = div('clock-about-line ' + lines[i].cls, list, lines[i].text);
      line.title = lines[i].text;
    }
  }

  // The analog face as large as the room allows: the full height of the
  // display, leaving the readout beside it at least ~12rem. Measured once
  // per draw (and when the about lines change), never each second.
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
    page = { root: root, display: display, full: full, shown: null, analog: null, fitBox: null };

    if (face === 'analog') {
      var an = div('clock-analog', display);
      page.faceBox = div('clock-face', an);
      page.analog = drawFace(page.faceBox);
      var side = div('clock-side', an);
      var readout = div('clock-readout', side);
      page.digits = span('clock-digits', readout);
      page.ampm = span('clock-ampm', readout);
      dateEls(side);
      page.fitBox = readout;
    } else {
      var dg = div('clock-digital', display);
      var big = div('clock-big', dg);
      page.digits = span('clock-digits', big);
      page.ampm = span('clock-ampm', big);
      dateEls(dg);
      page.fitBox = big;
    }

    var controls = div('clock-controls', main);
    group(controls, 'Face', [['face-digital', 'Digital', face === 'digital'], ['face-analog', 'Analog', face === 'analog']]);
    group(controls, 'Clock', [['hours-12', '12-hour', hours === '12'], ['hours-24', '24-hour', hours === '24']]);
    // Opened on the face choice: the first thing people change.
    var marked = controls.querySelectorAll('[data-autofocus]');
    for (var i = 1; i < marked.length; i++) marked[i].removeAttribute('data-autofocus');

    page.about = div('clock-about', root);
    drawAbout(page.about, ctx);

    fitFace();
    pageTick();
    startTicking();
  }

  function choose(key, ctx) {
    var nextFace = key === 'face-digital' ? 'digital' : key === 'face-analog' ? 'analog' : face;
    var nextHours = key === 'hours-12' ? '12' : key === 'hours-24' ? '24' : hours;
    if (nextFace === face && nextHours === hours) return;
    if (nextFace !== face) { face = nextFace; save(FACE_KEY, face); }
    if (nextHours !== hours) { hours = nextHours; save(HOURS_KEY, hours); ctx.redrawTile(); }
    ctx.redrawPanel();
  }

  return {
    id: 'today',
    title: 'Clock',
    icon: 'clock',
    head: false,

    init: function () {
      setInterval(tick, 15000);
    },

    renderTile: function (el, ctx) {
      var size = ctx.size ? ctx.size() : null;
      var form = size && size.tier === 'strip' ? 'strip' : size && size.width === 'narrow' ? 'narrow' : 'wide';
      el.classList.add('today-tile');
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
        div('clock-fallback', body, 'The clock page couldn’t be shown.');
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
    },

    // The motion, live updates or updates status changed: the about lines.
    onStatus: function (ctx) {
      if (!page || !page.about || !ctx.isOpen || !ctx.isOpen()) return;
      drawAbout(page.about, ctx);
      fitFace();
    }
  };
})());
