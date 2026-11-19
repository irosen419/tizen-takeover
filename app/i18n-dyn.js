/*
 * Spanish for text the owner typed (to-do titles, calendar events, task
 * lines), through the Pi (POST /translate, which asks Gemini once per text).
 * Loads right after i18n.js and adds to HUB_I18N:
 *
 *   HUB_I18N.dyn(text)       the Spanish when known and the hub is in Spanish,
 *                            otherwise text itself (and the text is queued)
 *   HUB_I18N.onDyn(fn)       fn() when new translations arrived; returns an
 *                            unsubscribe function. Widgets re-render in fn.
 *
 * Plain ES5. English mode and tiny, blank or numeric text queue nothing.
 */
(function () {
  'use strict';
  var I = window.HUB_I18N;
  if (!I) return;

  var KEY = 'homeHub.tr.es';
  var MAX_STORE = 3000;
  var BATCH = 60;
  var MAX_LEN = 500;
  var DEBOUNCE_MS = 400;
  var RETRY_MS = 2 * 60 * 1000;

  var map = {};
  var order = [];       // keys, oldest first
  var queued = {};
  var queue = [];
  var failedAt = {};    // text -> time of the failed ask
  var timer = null;
  var inflight = false;
  var listeners = [];
  var lastFail = 0;

  function load() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(KEY) : null;
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        for (var k in o) if (o.hasOwnProperty(k) && typeof o[k] === 'string') { map[k] = o[k]; order.push(k); }
      }
    } catch (e) { /* not kept; fine */ }
  }

  function store() {
    try { if (window.localStorage) window.localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  function now() { return new Date().getTime(); }

  function skip(s) {
    if (typeof s !== 'string' || s.length > MAX_LEN) return true;
    var t = s.replace(/^\s+|\s+$/g, '');
    return t.length < 3 || /^[\d\s.,:;\-+\/%$()]*$/.test(t);
  }

  function schedule(ms) {
    if (timer || inflight || !queue.length) return;
    timer = setTimeout(function () { timer = null; flush(); }, ms);
  }

  function flush() {
    if (inflight || !queue.length) return;
    var wait = lastFail ? lastFail + RETRY_MS - now() : 0;
    if (wait > 0) { schedule(wait); return; }
    var L = window.HUB_LIVE;
    var batch = queue.splice(0, BATCH);
    for (var i = 0; i < batch.length; i++) delete queued[batch[i]];
    function fail() {
      inflight = false;
      lastFail = now();
      for (var j = 0; j < batch.length; j++) enqueue(batch[j], true);
      schedule(RETRY_MS);
    }
    if (!L || typeof L.post !== 'function') { fail(); return; }
    inflight = true;
    try {
      L.post('/translate', { to: 'es', texts: batch }, function (err, data) {
        if (err || !data || !data.map || typeof data.map !== 'object') { fail(); return; }
        inflight = false;
        lastFail = 0;
        var got = 0;
        for (var j = 0; j < batch.length; j++) {
          var s = batch[j];
          var v = data.map.hasOwnProperty(s) ? data.map[s] : null;
          if (typeof v === 'string' && v) {
            if (!map.hasOwnProperty(s)) order.push(s);
            map[s] = v;
            got++;
          }
        }
        while (order.length > MAX_STORE) delete map[order.shift()];
        if (got) {
          store();
          for (var k = 0; k < listeners.length; k++) {
            try { listeners[k](); } catch (e) { if (window.console && console.warn) console.warn('Translation listener: ' + (e && e.message)); }
          }
        }
        // Texts the Pi left out (no key, paused) are not asked again this session until a retry window passes.
        for (var m = 0; m < batch.length; m++) if (!map.hasOwnProperty(batch[m])) failedAt[batch[m]] = now();
        schedule(DEBOUNCE_MS);
      });
    } catch (e) { fail(); }
  }

  function enqueue(s, retry) {
    if (queued.hasOwnProperty(s)) return;
    if (!retry && failedAt.hasOwnProperty(s) && now() - failedAt[s] < RETRY_MS) return;
    queued[s] = true;
    queue.push(s);
    schedule(DEBOUNCE_MS);
  }

  function dyn(text) {
    if (I.lang() !== 'es' || skip(text)) return text;
    if (map.hasOwnProperty(text)) return map[text];
    enqueue(text, false);
    return text;
  }

  function onDyn(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  load();
  I.dyn = dyn;
  I.onDyn = onDyn;
})();
