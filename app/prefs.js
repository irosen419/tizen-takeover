/*
 * Widget preferences shared by every screen (TV, wall tablet, phone): a
 * choice made inside a widget is the same everywhere. The Pi keeps them
 * (pi/prefs.js, the "prefs" live resource); this file keeps a copy on the
 * screen for the times the Pi is away. Device settings (Look, Language,
 * Guest mode) are not here: they stay per screen.
 *
 *   HUB_PREFS.get(key)          the value, or null
 *   HUB_PREFS.set(key, value)   changes it here at once and sends it to the
 *                               Pi (null removes it); kept and sent again
 *                               when the Pi was away
 *   HUB_PREFS.onChange(fn)      fn(key, value) after a change from here or
 *                               from another screen
 *   HUB_PREFS.KEYS              the shared keys (pi/prefs.js has the same list)
 *
 * Keys and the screen's older key each one replaces (read once, so a choice
 * made before this file is not lost; the first screen to reach the Pi with
 * one sends it up when the Pi has none):
 *   clock.face       homeHub.clock.face
 *   clock.hours      homeHub.clock.hours
 *   budget.capPref   homeHub.budget.capPref.v1 (JSON)
 *
 * Storage: homeHub.prefs.v1 = { values, pending } (pending: keys not yet
 * accepted by the Pi). Loads before the widgets; live.js later, so the line
 * to the Pi is looked up when it is needed. Plain ES5.
 */
(function () {
  'use strict';

  var STORE = 'homeHub.prefs.v1';
  var ROUTE = '/prefs';
  var LEGACY = {
    'clock.face': { key: 'homeHub.clock.face', json: false },
    'clock.hours': { key: 'homeHub.clock.hours', json: false },
    'budget.capPref': { key: 'homeHub.budget.capPref.v1', json: true }
  };
  var KEYS = ['clock.face', 'clock.hours', 'budget.capPref'];

  var values = {};
  var pending = {};
  var listeners = [];
  var hooked = false;
  var heard = false;          // the Pi's copy has arrived at least once
  var sending = {};

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  function known(k) { return KEYS.indexOf(k) >= 0; }

  function warn(msg) {
    try { if (window.console && console.warn) console.warn('Preferences: ' + msg); } catch (e) { /* ignore */ }
  }

  function ls() { try { return window.localStorage || null; } catch (e) { return null; } }

  function load() {
    var s = ls();
    var d = null;
    try { d = s ? JSON.parse(s.getItem(STORE) || 'null') : null; } catch (e) { d = null; }
    if (d && typeof d === 'object') {
      if (d.values && typeof d.values === 'object') for (var k in d.values) if (has(d.values, k) && known(k)) values[k] = d.values[k];
      if (d.pending && typeof d.pending === 'object') for (var p in d.pending) if (has(d.pending, p) && known(p)) pending[p] = true;
    }
    // The older per-screen keys: read once into the shared copy, then marked to
    // go up to the Pi (it keeps its own value when it already has one).
    for (var i = 0; i < KEYS.length; i++) {
      var key = KEYS[i];
      var old = LEGACY[key];
      var raw = null;
      try { raw = s ? s.getItem(old.key) : null; } catch (e) { raw = null; }
      if (raw === null) continue;
      if (!has(values, key)) {
        var v = raw;
        if (old.json) { try { v = JSON.parse(raw); } catch (e) { v = null; } }
        if (v !== null) { values[key] = v; pending[key] = 'legacy'; }
      }
      try { s.removeItem(old.key); } catch (e) { /* read again next time; harmless */ }
    }
    save();
  }

  function save() {
    var s = ls();
    if (!s) return;
    try { s.setItem(STORE, JSON.stringify({ values: values, pending: pending })); } catch (e) { /* kept in memory */ }
  }

  function tell(key, value) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](key, value); } catch (e) { warn(e && e.message); }
    }
  }

  function live() {
    var L = window.HUB_LIVE;
    return L && typeof L.post === 'function' && typeof L.on === 'function' ? L : null;
  }

  function send(key) {
    var L = live();
    if (!L || sending[key]) return;
    sending[key] = true;
    var value = has(values, key) ? values[key] : null;
    try {
      L.post(ROUTE, { key: key, value: value }, function (err, data) {
        sending[key] = false;
        if (err || !data || data.ok !== true) {
          // A value the Pi refuses (an older Pi, a bad value) stays on this
          // screen only; anything else is tried again on the next update.
          if (data && data.ok === false) { delete pending[key]; save(); }
          return;
        }
        if (!same(has(values, key) ? values[key] : null, value)) { send(key); return; }  // changed meanwhile
        delete pending[key];
        save();
      });
    } catch (e) { sending[key] = false; }
  }

  function flush() {
    for (var k in pending) if (has(pending, k)) send(k);
  }

  // The Pi's copy: it wins, except for keys this screen still has to send.
  // A key the Pi has never had and this screen brought from its older
  // storage goes up instead.
  function receive(data) {
    if (!data || typeof data !== 'object') return;
    var pv = data.values && typeof data.values === 'object' ? data.values : {};
    heard = true;
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (has(pending, k)) {
        // Brought from older storage, but the Pi already has a value: the Pi's wins.
        if (pending[k] === 'legacy' && has(pv, k)) delete pending[k];
        else continue;
      }
      var next = has(pv, k) ? pv[k] : null;
      var cur = has(values, k) ? values[k] : null;
      if (same(cur, next)) continue;
      if (next === null) delete values[k]; else values[k] = next;
      tell(k, next);
    }
    save();
    flush();
  }

  function hook() {
    if (hooked) return;
    var L = live();
    if (!L) return;
    hooked = true;
    try { L.on('prefs', function (data) { receive(data); }); } catch (e) { warn(e && e.message); }
    try { var now = L.get && L.get('prefs'); if (now) receive(now); } catch (e) { /* the next update has it */ }
  }

  function get(key) {
    hook();
    return has(values, key) ? values[key] : null;
  }

  function set(key, value) {
    if (!known(key)) return false;
    hook();
    if (value === undefined) value = null;
    if (same(has(values, key) ? values[key] : null, value)) return true;
    if (value === null) delete values[key]; else values[key] = value;
    pending[key] = true;
    save();
    send(key);
    tell(key, value);
    return true;
  }

  load();
  // live.js loads after the widgets: hook up once the page is in.
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(hook, 0);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(hook, 0); });

  window.HUB_PREFS = {
    KEYS: KEYS.slice(),
    get: get,
    set: set,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    heard: function () { return heard; }
  };
})();
