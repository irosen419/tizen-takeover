/*
 * Today: the clock tile. Static, so focus skips it.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var els = null;

  function div(cls, parent) {
    var el = document.createElement('div');
    el.className = cls;
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
    node.textContent = now.toLocaleDateString('en-US', opts);
    if (shortOpts && node.scrollWidth > node.clientWidth + 1) node.textContent = now.toLocaleDateString('en-US', shortOpts);
  }

  // The clock as large as the tile's CSS says, but never wider than the
  // tile: if the digits don't fit (a narrow tile), they shrink, AM/PM with them.
  function fitTime() {
    var t = els.time;
    t.style.fontSize = '';
    els.ampm.style.fontSize = '';
    if (!t.clientWidth || t.scrollWidth <= t.clientWidth + 1) return;
    var cs = window.getComputedStyle(t);
    var size = parseFloat(cs.fontSize) || 60;
    var ampm = parseFloat(window.getComputedStyle(els.ampm).fontSize) || 20;
    var ratio = ampm / size;
    for (var i = 0; i < 14 && t.scrollWidth > t.clientWidth + 1; i++) {
      size = size * 0.9;
      t.style.fontSize = size.toFixed(1) + 'px';
      els.ampm.style.fontSize = (size * ratio).toFixed(1) + 'px';
    }
  }

  function tick() {
    if (!els) return;
    var now = new Date();
    var time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // "9:41 PM": the digits big, AM/PM smaller next to them.
    var space = time.lastIndexOf(' ');
    var digits = space > 0 ? time.substring(0, space) : time;
    els.digits.textContent = digits;
    els.ampm.textContent = space > 0 ? time.substring(space + 1) : '';
    drawDate(now);
    if (els.fitted !== digits.length) {
      els.fitted = digits.length;
      fitTime();
    }
  }

  return {
    id: 'today',
    title: 'Today',
    icon: 'clock',
    expandable: false,
    head: false,

    init: function () {
      setInterval(tick, 15000);
    },

    renderTile: function (el, ctx) {
      var size = ctx.size ? ctx.size() : null;
      var form = size && size.tier === 'strip' ? 'strip' : size && size.width === 'narrow' ? 'narrow' : 'wide';
      el.classList.remove('today-rows-3');
      el.classList.remove('today-rows-4');
      if (form === 'strip') el.classList.add('today-strip');
      else el.classList.remove('today-strip');
      if (form === 'strip') {
        // One row: the time, and the date stacked to its right. The place
        // and the version and status lines need a bigger tile.
        timeEls(el, form);
        tick();
        return;
      }
      var place = div('today-place', el);
      place.textContent = (window.HUB_CONFIG && HUB_CONFIG.title) || 'Today';
      timeEls(el, form);
      // One-line rows that end in "..." rather than wrap, so a wider TV font
      // can't push the tile past its edge. The live updates row and the
      // updates row are only there when they have something to say; with
      // both there are four rows (checked to fit at 1920x1080).
      var updates;
      try { updates = typeof ctx.updates === 'function' ? ctx.updates() : undefined; } catch (e) { updates = undefined; }
      var newest = !!(updates && updates.newest === true);
      var updateText = updates && typeof updates.text === 'string' ? updates.text : '';
      var status = div('today-status', el);
      var browser = ctx.browser ? ctx.browser() : '';
      div('today-status-line', status).textContent = ctx.build + (newest ? ' (newest)' : '') + (browser ? ' · ' + browser : '');
      div('today-status-line', status).textContent = ctx.motionStatus();
      var live = '';
      try { live = ctx.live ? ctx.live.status().text || '' : ''; } catch (e) { live = ''; }
      if (live) div('today-status-line today-status-live', status).textContent = live;
      if (updateText) div('today-status-line today-status-updates', status).textContent = updateText;
      // The clock gives up a little height for each extra row.
      var rows = 2 + (live ? 1 : 0) + (updateText ? 1 : 0);
      if (rows > 2) el.classList.add('today-rows-' + rows);
      tick();
    },

    // The motion status, the live updates status or the updates status changed.
    onStatus: function (ctx) {
      ctx.redrawTile();
    }
  };
})());
