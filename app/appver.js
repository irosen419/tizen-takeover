/*
 * Newer code on the Pi, for the pages the Pi serves (the wall tablet, a
 * phone, the touch app: http://<Pi>:8097/app/...). The TV never uses this:
 * it updates through app/update.js (TizenBrew, jsDelivr, GitHub). The Pi
 * pulls main by itself every 5 minutes (pi/autopull/), so a page left open
 * here only needs to notice that the files under it changed.
 *
 * Every 5 minutes, and on becoming visible when the last check is older than
 * 2 minutes, it asks the same origin's GET /health (no token) for `app`, the
 * BUILD of the hub.js the Pi now serves, and compares it with the version this
 * page started with (HUB_BUILD, or on the touch app the first answer).
 *
 *   HUB_APPVER.start({ version, idle, onStatus })   version: '0.56.0' (or ''
 *                     to take the first answer); idle() says when a reload
 *                     would bother nobody (default: no input for 2 minutes);
 *                     onStatus() after every change of state
 *   HUB_APPVER.status()  { state, text, newest, checkedAt }
 *                     state: off (not served by the Pi, under TizenBrew, or the
 *                     Pi doesn't say), current, available, unreachable;
 *                     text is English ('' when off), newest the Pi's version
 *   HUB_APPVER.label()   the same text in the hub's language
 *   HUB_APPVER.reload()  load the page again
 *   HUB_APPVER.check(cb) check now (tests)
 *
 * When an update is available and idle() is true, the page reloads by itself,
 * once per version: sessionStorage remembers the version it reloaded for, so a
 * reload that still gets the old files never loops. Without sessionStorage it
 * never reloads by itself. Plain ES5.
 */
(function () {
  'use strict';

  var CHECK_MS = 5 * 60000;
  var STALE_MS = 2 * 60000;
  var IDLE_MS = 2 * 60000;
  var IDLE_RETRY_MS = 30000;
  var FETCH_MS = 8000;
  var KEY = 'homeHub.appver.reloaded';
  var VER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

  var TEXT = {
    current: 'Up to date',
    available: 'Update available: v{v} (tap to reload)',
    unreachable: 'Can’t reach the Pi'
  };

  var state = 'off';
  var mine = '';
  var newest = '';
  var checkedAt = 0;
  var started = false;
  var checking = false;
  var timer = null;
  var idleTimer = null;
  var leaving = false;
  var opts = { idle: null, onStatus: null };
  var lastInput = new Date().getTime();

  function now() { return new Date().getTime(); }

  function managed() {
    var U = window.HUB_UPDATE;
    try { return !!(U && typeof U.status === 'function' && U.status().managed); } catch (e) { return false; }
  }

  function onPi() {
    try { return String(location.pathname || '').indexOf('/app/') === 0 && /^https?:$/.test(location.protocol) && !managed(); } catch (e) { return false; }
  }

  function fill(text, v) { return String(text).replace('{v}', v); }

  function status() {
    return {
      state: state,
      text: TEXT[state] ? fill(TEXT[state], newest) : '',
      newest: newest,
      checkedAt: checkedAt
    };
  }

  function label() {
    if (!TEXT[state]) return '';
    var L = window.HUB_I18N;
    try { if (L && typeof L.t === 'function') return String(L.t('appver.' + state, TEXT[state], { v: newest })); } catch (e) { /* English */ }
    return fill(TEXT[state], newest);
  }

  function set(next) {
    if (next === state) return;
    state = next;
    if (typeof opts.onStatus === 'function') { try { opts.onStatus(); } catch (e) { /* the hub's problem */ } }
  }

  function store() { try { return window.sessionStorage || null; } catch (e) { return null; } }

  function reload() {
    leaving = true;
    try { location.reload(); } catch (e) { leaving = false; }
  }

  function idleNow() {
    if (typeof opts.idle === 'function') { try { return opts.idle() === true; } catch (e) { return false; } }
    var a = document.activeElement;
    var tag = a && a.tagName ? String(a.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    return now() - lastInput >= IDLE_MS;
  }

  // Reload by itself, once for this version, when nobody is using the page.
  function tryAuto() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (state !== 'available' || leaving) return;
    if (!idleNow()) { idleTimer = setTimeout(tryAuto, IDLE_RETRY_MS); return; }
    var s = store();
    if (!s) return;
    try {
      if (s.getItem(KEY) === newest) return;     // already reloaded for this one: no loop
      s.setItem(KEY, newest);
    } catch (e) { return; }
    reload();
  }

  function answer(app, cb) {
    checking = false;
    checkedAt = now();
    if (app === null) set('unreachable');
    else if (!VER_RE.test(app)) set('off');      // an older Pi, or hub.js unreadable
    else {
      if (!mine) mine = app;
      newest = app;
      set(app === mine ? 'current' : 'available');
    }
    tryAuto();
    if (typeof cb === 'function') { try { cb(status()); } catch (e) { /* the caller's problem */ } }
  }

  function check(cb) {
    if (!onPi()) { set('off'); if (typeof cb === 'function') cb(status()); return; }
    if (checking) { if (typeof cb === 'function') cb(status()); return; }
    checking = true;
    var done = false;
    var xhr = new XMLHttpRequest();
    function finish(app) { if (done) return; done = true; answer(app, cb); }
    try {
      xhr.open('GET', '/health?appver=' + now(), true);
      xhr.timeout = FETCH_MS;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status !== 200) return finish(null);
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') return finish(null);
        finish(typeof j.app === 'string' ? j.app.replace(/^v/, '') : '');
      };
      xhr.ontimeout = function () { finish(null); };
      xhr.send();
    } catch (e) { finish(null); }
  }

  function loop() {
    clearTimeout(timer);
    timer = setTimeout(function () { check(); loop(); }, CHECK_MS);
  }

  function onVisible() {
    var hidden = document.hidden || document.webkitHidden;
    if (!hidden && now() - checkedAt > STALE_MS) check();
  }

  function noteInput() { lastInput = now(); }

  function start(o) {
    o = o || {};
    if (typeof o.idle === 'function') opts.idle = o.idle;
    if (typeof o.onStatus === 'function') opts.onStatus = o.onStatus;
    var v = typeof o.version === 'string' ? o.version.replace(/^v/, '') : '';
    if (VER_RE.test(v)) mine = v;
    if (started || !onPi()) return;
    started = true;
    var ev = ['keydown', 'click', 'touchstart', 'mousedown'];
    for (var i = 0; i < ev.length; i++) document.addEventListener(ev[i], noteInput, true);
    document.addEventListener('visibilitychange', onVisible, false);
    document.addEventListener('webkitvisibilitychange', onVisible, false);
    check();
    loop();
  }

  window.HUB_APPVER = { start: start, status: status, label: label, reload: reload, check: check };
})();
