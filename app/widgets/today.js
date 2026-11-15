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
    els.date.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
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
      // Two fixed lines, so a wider TV font can't push the tile past its edge.
      var status = div('today-status', el);
      var browser = ctx.browser ? ctx.browser() : '';
      div('today-status-line', status).textContent = ctx.build + (browser ? ' · ' + browser : '');
      div('today-status-line', status).textContent = ctx.motionStatus();
      els = { digits: digits, ampm: ampm, date: date };
      tick();
    },

    // The motion status changed (auto mode finished measuring).
    onStatus: function (ctx) {
      ctx.redrawTile();
    }
  };
})());
