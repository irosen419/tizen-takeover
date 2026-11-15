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

  // The date for the tile's size: "Sunday, November 15", "Sun, Nov 15" in a
  // narrow tile, and in a strip two short lines, "Sunday" over "Nov 15".
  function drawDate(now) {
    var d = els.date;
    if (els.form === 'strip') {
      var dow = now.toLocaleDateString('en-US', { weekday: 'long' });
      var md = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (d.getAttribute('data-text') === dow + md) return;
      d.setAttribute('data-text', dow + md);
      d.innerHTML = '';
      div('today-date-line', d).textContent = dow;
      div('today-date-line', d).textContent = md;
      return;
    }
    d.textContent = els.form === 'narrow' ?
      now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) :
      now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
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
        // One row: the time on the left, the date on the right. The place
        // and the version and status lines need a bigger tile.
        var stripTime = div('today-time', el);
        var stripDigits = document.createElement('span');
        stripDigits.className = 'today-digits';
        var stripAmpm = document.createElement('span');
        stripAmpm.className = 'today-ampm';
        stripTime.appendChild(stripDigits);
        stripTime.appendChild(stripAmpm);
        els = { time: stripTime, digits: stripDigits, ampm: stripAmpm, date: div('today-date', el), form: form };
        tick();
        return;
      }
      var place = div('today-place', el);
      place.textContent = (window.HUB_CONFIG && HUB_CONFIG.title) || 'Today';
      var time = div('today-time', el);
      var digits = document.createElement('span');
      digits.className = 'today-digits';
      var ampm = document.createElement('span');
      ampm.className = 'today-ampm';
      time.appendChild(digits);
      time.appendChild(ampm);
      var date = div('today-date', el);
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
      els = { time: time, digits: digits, ampm: ampm, date: date, form: form };
      tick();
    },

    // The motion status, the live updates status or the updates status changed.
    onStatus: function (ctx) {
      ctx.redrawTile();
    }
  };
})());
