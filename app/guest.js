/*
 * Guest mode: blurs every dollar amount on the money tiles while guests are
 * over. The tiles, their layouts and their data stay as they are; only the
 * amounts ($42, −$12, +$8,111, $1,806, EUR 1,200) turn into a soft smudge.
 * Dates, counts, times, names and percentages stay readable.
 *
 *   HUB_GUEST.on()           true while Guest mode is on
 *   HUB_GUEST.set(bool)      turns it on or off; remembered on this TV
 *   HUB_GUEST.onChange(fn)   fn(on) after every change
 *   HUB_GUEST.MONEY          the widgets whose tiles and panels are blurred
 *   HUB_GUEST.mask(root)     wraps the amounts under root now (a widget that
 *                            draws outside a tile or panel can call it)
 *   HUB_GUEST.unmask(root)   takes the wraps off again
 *   HUB_GUEST.match(text)    the amounts found in text (tests)
 *
 * How: each amount in a text node is wrapped in <span class="guest-blur">
 * (style.css: transparent ink with a soft shadow of the text's own colour;
 * no filter, nothing animates). The roots are the tiles of the MONEY widgets
 * (.cell[data-widget]), the panel while one of them is open (hub.js sets
 * #panel's data-panel-widget) and the New charge banner (.bu-alert). One
 * MutationObserver re-masks whatever a widget draws again; its own wraps are
 * taken back out of the queue (takeRecords), so it never feeds itself. With
 * no MutationObserver the roots are masked again every second instead.
 * Turning Guest mode off unwraps everything. SVG charts carry no figures
 * (only shapes), so SVG is left alone.
 *
 * Wider rule later: add a pattern to MATCHERS (PERCENT is ready for it).
 *
 * Off unless turned on. Calendars hide their notes and guest names
 * themselves (calendar.js). Loads before the widgets. Plain ES5.
 */
(function () {
  'use strict';

  var KEY = 'homeHub.guest.v1';
  var MONEY = ['awws', 'awws-money', 'budget-room', 'budget-card', 'budget-goals', 'budget-lab', 'investments'];
  var CLS = 'guest-blur';

  // What gets blurred. Each is a RegExp source; a sign right before an amount
  // goes with it (− is U+2212, the minus the money widgets draw).
  var SIGN = '[+\\-\\u2212]?';
  var NUM = '\\d[\\d,]*(?:\\.\\d+)?';
  var CASH = SIGN + '[$\\u20ac\\u00a3]\\s?' + NUM + '(?:\\s?[kKmM]\\b)?';                  // $42, −$12, +$8,111, $1.2k, €9
  var CODE = SIGN + '\\b(?:USD|EUR|GBP|CAD|AUD|MXN)\\s' + NUM;                             // EUR 1,200 (awws.js money())
  var PERCENT = SIGN + NUM + '\\s?%';                                                      // not used yet
  var MATCHERS = [CASH, CODE];
  var RE = new RegExp(MATCHERS.join('|'), 'g');

  var state = false;
  var listeners = [];
  var observer = null;
  var timer = null;

  try { state = !!(window.localStorage && window.localStorage.getItem(KEY) === 'on'); } catch (e) { state = false; }

  function warn(msg) {
    try { if (window.console && console.warn) console.warn('Guest mode: ' + msg); } catch (e) { /* ignore */ }
  }

  function hasClass(node, c) {
    return !!node && typeof node.className === 'string' && (' ' + node.className + ' ').indexOf(' ' + c + ' ') >= 0;
  }

  function match(text) {
    var out = [];
    var m;
    RE.lastIndex = 0;
    while ((m = RE.exec(String(text || ''))) !== null) {
      if (!m[0]) { RE.lastIndex += 1; continue; }
      out.push(m[0]);
    }
    return out;
  }

  /* ---------- which nodes are blurred ---------- */

  function isMoneyWidget(node) {
    var id = node.getAttribute && (node.getAttribute('data-widget') || node.getAttribute('data-panel-widget'));
    return !!id && MONEY.indexOf(id) >= 0;
  }

  // The root a node sits in, or null when it is not under a money tile, a
  // money panel or the banner.
  function rootOf(node) {
    for (var n = node; n && n.nodeType !== 9; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if (hasClass(n, 'cell') || n.id === 'panel') return isMoneyWidget(n) ? n : null;
      if (hasClass(n, 'bu-alert')) return n;
    }
    return null;
  }

  function roots() {
    var out = [];
    var i;
    var cells = document.querySelectorAll('.cell[data-widget]');
    for (i = 0; i < cells.length; i++) if (isMoneyWidget(cells[i])) out.push(cells[i]);
    var panel = document.getElementById('panel');
    if (panel && isMoneyWidget(panel)) out.push(panel);
    var alerts = document.querySelectorAll('.bu-alert');
    for (i = 0; i < alerts.length; i++) out.push(alerts[i]);
    return out;
  }

  /* ---------- wrapping ---------- */

  function skip(el) {
    if (!el || el.nodeType !== 1) return true;
    var tag = String(el.nodeName).toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;   // SVG: shapes only
    return hasClass(el, CLS);
  }

  function wrapText(t) {
    var parent = t.parentNode;
    if (skip(parent)) return;
    var text = t.nodeValue;
    if (!text) return;
    RE.lastIndex = 0;
    var m = RE.exec(text);
    if (!m) return;
    var frag = document.createDocumentFragment();
    var at = 0;
    while (m) {
      if (m[0]) {
        if (m.index > at) frag.appendChild(document.createTextNode(text.slice(at, m.index)));
        var s = document.createElement('span');
        s.className = CLS;
        s.appendChild(document.createTextNode(m[0]));
        frag.appendChild(s);
        at = m.index + m[0].length;
      } else {
        RE.lastIndex += 1;
      }
      m = RE.exec(text);
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
    parent.replaceChild(frag, t);
  }

  function mask(root) {
    if (!state || !root) return;
    if (root.nodeType === 3) { wrapText(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    var found = [];
    collect(root, found);
    for (var i = 0; i < found.length; i++) wrapText(found[i]);
  }

  // Text nodes under root, not inside SVG or a wrap already.
  function collect(node, out) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1 && !skip(c)) collect(c, out);
    }
  }

  function unmask(root) {
    if (!root || !root.getElementsByClassName) return;
    var list = root.getElementsByClassName(CLS);
    var spans = [];
    var i;
    for (i = 0; i < list.length; i++) spans.push(list[i]);
    var parents = [];
    for (i = 0; i < spans.length; i++) {
      var p = spans[i].parentNode;
      if (!p) continue;
      p.replaceChild(document.createTextNode(spans[i].textContent), spans[i]);
      if (parents.indexOf(p) < 0) parents.push(p);
    }
    // One text node again where there was one, so widgets that write into it
    // (budget-lab.js setText) keep doing so.
    for (i = 0; i < parents.length; i++) { try { parents[i].normalize(); } catch (e) { /* fine as it is */ } }
  }

  function maskAll() {
    var r = roots();
    for (var i = 0; i < r.length; i++) mask(r[i]);
  }

  /* ---------- watching ---------- */

  function onRecords(records) {
    if (!state) return;
    var todo = [];
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (rec.type === 'attributes') {
        // #panel now shows a money widget.
        if (isMoneyWidget(rec.target)) todo.push(rec.target);
        continue;
      }
      if (rec.type === 'characterData') {
        if (rootOf(rec.target)) todo.push(rec.target);
        continue;
      }
      var added = rec.addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType === 1 && hasClass(n, CLS)) continue;
        if (n.nodeType === 1 && hasClass(n, 'bu-alert')) { todo.push(n); continue; }
        if ((n.nodeType === 1 || n.nodeType === 3) && rootOf(n.nodeType === 3 ? n.parentNode : n)) todo.push(n);
      }
    }
    for (var k = 0; k < todo.length; k++) {
      // Detached since (a later redraw replaced it): nothing to do.
      if (!document.body || !document.body.contains(todo[k])) continue;
      mask(todo[k]);
    }
    // Our own wraps queued records of their own: drop them, so this never runs on itself.
    if (observer) { try { observer.takeRecords(); } catch (e) { /* the next pass finds nothing to wrap */ } }
  }

  function watch() {
    if (observer || timer || !document.body) return;
    var MO = window.MutationObserver || window.WebKitMutationObserver;
    if (MO) {
      observer = new MO(function (records) {
        try { onRecords(records); } catch (e) { warn(e && e.message); }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-panel-widget'] });
    } else {
      timer = setInterval(function () { try { maskAll(); } catch (e) { warn(e && e.message); } }, 1000);
    }
  }

  function unwatch() {
    if (observer) { try { observer.disconnect(); } catch (e) { /* gone anyway */ } }
    observer = null;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function apply() {
    if (!document.body) return;
    if (state) {
      maskAll();
      watch();
    } else {
      unwatch();
      unmask(document.body);
    }
  }

  function set(next) {
    next = !!next;
    if (next === state) return;
    state = next;
    try {
      if (window.localStorage) {
        if (state) window.localStorage.setItem(KEY, 'on');
        else window.localStorage.removeItem(KEY);
      }
    } catch (e) { /* kept for this visit only */ }
    try { apply(); } catch (e) { warn(e && e.message); }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { warn(e && e.message); }
    }
  }

  // This file loads in <head>: start watching once the page has a body.
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', function () { try { apply(); } catch (e) { warn(e && e.message); } });

  window.HUB_GUEST = {
    MONEY: MONEY.slice(),
    PERCENT: PERCENT,
    on: function () { return state; },
    set: set,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    mask: function (root) { try { mask(root || document.body); } catch (e) { warn(e && e.message); } },
    unmask: function (root) { try { unmask(root || document.body); } catch (e) { warn(e && e.message); } },
    match: match
  };
})();
