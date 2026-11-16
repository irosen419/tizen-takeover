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

  function tick() {
    if (!els) return;
    var now = new Date();
    var time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // "9:41 PM": the digits big, AM/PM smaller next to them.
    var space = time.lastIndexOf(' ');
    els.digits.textContent = space > 0 ? time.substring(0, space) : time;
    els.ampm.textContent = space > 0 ? time.substring(space + 1) : '';
    // Two parts so a one-row tile can stack them: "Sunday" over "November 15".
    els.dow.textContent = now.toLocaleDateString('en-US', { weekday: 'long' });
    els.md.textContent = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
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

    // The tile moved or changed size (a new layout came from the Pi).
    onLayout: function (ctx) {
      ctx.redrawTile();
    },

    renderTile: function (el, ctx) {
      // One row tall: only the time and the date fit. The status lines move
      // to the clock's page once it grows one (see the Clock plan).
      var compact = !!(el.offsetHeight && el.offsetHeight < 150);
      el.classList.toggle('today-compact', compact);
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
      var dow = document.createElement('span');
      dow.className = 'today-dow';
      var sep = document.createElement('span');
      sep.className = 'today-sep';
      sep.textContent = ', ';
      var md = document.createElement('span');
      md.className = 'today-md';
      date.appendChild(dow);
      date.appendChild(sep);
      date.appendChild(md);
      // One-line rows that end in "..." rather than wrap, so a wider TV font
      // can't push the tile past its edge. The live updates row and the
      // updates row are only there when they have something to say; with
      // both there are four rows (checked to fit at 1920x1080).
      var updates;
      try { updates = typeof ctx.updates === 'function' ? ctx.updates() : undefined; } catch (e) { updates = undefined; }
      var newest = !!(updates && updates.newest === true);
      var updateText = updates && typeof updates.text === 'string' ? updates.text : '';
      var status = div('today-status', el);
      if (compact) status.style.display = 'none';
      var browser = ctx.browser ? ctx.browser() : '';
      div('today-status-line', status).textContent = ctx.build + (newest ? ' (newest)' : '') + (browser ? ' · ' + browser : '');
      div('today-status-line', status).textContent = ctx.motionStatus();
      var live = '';
      try { live = ctx.live ? ctx.live.status().text || '' : ''; } catch (e) { live = ''; }
      if (live) div('today-status-line today-status-live', status).textContent = live;
      if (updateText) div('today-status-line today-status-updates', status).textContent = updateText;
      // The clock gives up a little height for each extra row.
      var rows = 2 + (live ? 1 : 0) + (updateText ? 1 : 0);
      el.classList.remove('today-rows-3');
      el.classList.remove('today-rows-4');
      if (rows > 2) el.classList.add('today-rows-' + rows);
      els = { digits: digits, ampm: ampm, dow: dow, md: md };
      tick();
    },

    // The motion status, the live updates status or the updates status changed.
    onStatus: function (ctx) {
      ctx.redrawTile();
    }
  };
})());
