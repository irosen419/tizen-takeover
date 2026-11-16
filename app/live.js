/*
 * Home Hub live updates: the client side of docs/live-updates.md.
 *
 * Keeps one open line to the hub server on the Raspberry Pi and hands what
 * arrives to whoever listens. Plain ES5, no DOM, and it does nothing at all
 * until HUB_LIVE.start() is called, so an old hub.js that never calls it is
 * not affected.
 *
 *   HUB_LIVE.start({ server: 'http://192.168.1.219:8097' })  true if it started
 *   HUB_LIVE.stop()
 *   HUB_LIVE.status()          { state, text, since, epoch }
 *   HUB_LIVE.get(resource)     the data last applied, or undefined
 *   HUB_LIVE.on(resource, fn)  fn(data, rev) on every applied snapshot or change
 *   HUB_LIVE.onCommand(fn)     fn(type, data), once per command
 *   HUB_LIVE.onStatus(fn)      fn(status) when the state or its text changes
 *   HUB_LIVE.post(path, body, cb)   POST JSON; cb(err, data, httpStatus)
 *   HUB_LIVE.everConnected()   this browser has reached the server at least once
 *
 * States: off, quiet (never reached from this browser), connecting, live,
 * lost, refused, badreply, needsupdate. text is what the About panel shows for live updates.
 *
 * In the page address: ?live=<address> uses another server, ?live=off turns
 * live updates off, ?livepoll=1 uses the long-poll fallback from the start.
 */
(function () {
  'use strict';

  var VERSION = 1;                        // the newest protocol this file understands
  var SEEN_KEY = 'homeHub.live.seen';
  var BACKOFF = [2000, 5000, 10000, 30000, 60000];
  var SLOW_RETRY = 300000;                // refused, badreply, needsupdate
  var SNAPSHOT_MS = 8000;
  var POLL_MS = 40000;                    // the server holds a poll for up to 25 seconds
  var POST_MS = 10000;
  var WATCHDOG_MS = 50000;                // pings come every 20 seconds
  var STREAM_FAILS_FOR_POLL = 3;
  var COMMAND_MEMORY = 50;

  var TEXT = {
    live: 'Live',
    lost: 'Live: lost the Pi at {t}',
    refused: 'Live: the Pi refused this TV',
    badreply: 'Live: unexpected reply from the Pi',
    needsupdate: 'Live: the hub needs an update'
  };

  var server = '';
  var started = false;
  var usePoll = false;          // for the rest of this page's life once set
  var state = 'off';
  var stateText = '';
  var since = new Date().getTime();
  var lostSince = 0;            // when the current run of failures began

  var epoch = null;
  var rev = 0;                  // the highest rev seen from the server
  var resources = {};           // name -> { rev, data }
  var cursor = '';              // long-poll command cursor, '' until the server gives one

  var listeners = {};           // name -> [fn]
  var commandListeners = [];
  var statusListeners = [];
  var doneCommands = [];        // ids of the last commands run

  var gen = 0;                  // bumped on every new attempt; stale callbacks check it
  var retryTimer = null;        // the one pending retry or poll
  var attempt = 0;              // failures in a row, picks the backoff step
  var streamFails = 0;          // push-line failures in a row while snapshots work
  var resyncs = 0;              // hello or ping asked for a fresh snapshot, in a row
  var es = null;
  var watchdog = null;
  var lastEventAt = 0;
  var xhrs = [];                // requests to abort on stop or a new attempt

  /* ---------- small helpers ---------- */

  function now() { return new Date().getTime(); }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Live: ' + text); } catch (e) { /* ignore */ }
  }

  function readQuery(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function cleanServer(value) {
    var s = String(value || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    return /^https?:\/\/[^\s\/?#]+$/i.test(s) ? s : '';
  }

  function seen() {
    try { return !!window.localStorage && localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }

  function markSeen() {
    try { if (window.localStorage) localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function timeText(t) {
    var d = new Date(t);
    try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch (e) {
      var h = d.getHours();
      var m = d.getMinutes();
      return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
    }
  }

  function callAll(list, args) {
    for (var i = 0; i < list.length; i++) {
      try { list[i].apply(null, args); } catch (e) { warn('a listener failed: ' + (e && e.message)); }
    }
  }

  function status() {
    return { state: state, text: stateText, since: since, epoch: epoch };
  }

  function setState(next, text) {
    text = text || '';
    if (next === state && text === stateText) return;
    state = next;
    stateText = text;
    since = now();
    callAll(statusListeners, [status()]);
  }

  /* ---------- timers and requests ---------- */

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  // At most one pending retry or poll. A new one replaces the old.
  function later(fn, ms) {
    clearRetry();
    retryTimer = setTimeout(function () {
      retryTimer = null;
      try { fn(); } catch (e) { warn('retry failed: ' + (e && e.message)); }
    }, ms);
  }

  function abortAll() {
    var list = xhrs;
    xhrs = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].abort(); } catch (e) { /* ignore */ }
    }
  }

  // cb(kind, data, status). kind: 'ok', 'net' (unreachable or timed out),
  // 'http' (a reply that isn't 2xx), 'notjson'.
  function request(method, url, body, timeoutMs, track, cb) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function done(kind, data, code) {
      if (finished) return;
      finished = true;
      var at = xhrs.indexOf(xhr);
      if (at >= 0) xhrs.splice(at, 1);
      try { cb(kind, data, code); } catch (e) { warn('a reply handler failed: ' + (e && e.message)); }
    }
    try {
      xhr.open(method, url, true);
      xhr.timeout = timeoutMs;
      if (body !== null) xhr.setRequestHeader('Content-Type', 'application/json');
    } catch (e) {
      setTimeout(function () { done('net', null, 0); }, 0);
      return;
    }
    xhr.onload = function () {
      var data = null;
      var parsed = false;
      try { data = JSON.parse(xhr.responseText); parsed = true; } catch (e) { /* not JSON */ }
      if (!parsed || !data || typeof data !== 'object') return done(xhr.status >= 200 && xhr.status < 300 ? 'notjson' : 'http', null, xhr.status);
      done(xhr.status >= 200 && xhr.status < 300 ? 'ok' : 'http', data, xhr.status);
    };
    xhr.onerror = function () { done('net', null, xhr.status || 0); };
    xhr.ontimeout = function () { done('net', null, 0); };
    xhr.onabort = function () { finished = true; };
    if (track) xhrs.push(xhr);
    try {
      xhr.send(body === null ? null : JSON.stringify(body));
    } catch (e2) {
      done('net', null, 0);
    }
  }

  /* ---------- the stream ---------- */

  function closeStream() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (es) {
      var old = es;
      es = null;
      try { old.onerror = null; old.onopen = null; old.close(); } catch (e) { /* ignore */ }
    }
  }

  function feedWatchdog(myGen) {
    lastEventAt = now();
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      watchdog = null;
      if (myGen === gen) streamFailed(myGen, 'no word for 50 seconds');
    }, WATCHDOG_MS);
  }

  function streamDead() {
    return !es || now() - lastEventAt > WATCHDOG_MS;
  }

  /* ---------- applying what arrives ---------- */

  function notify(name) {
    var r = resources[name];
    if (!r) return;
    callAll(listeners[name] || [], [r.data, r.rev]);
  }

  // force: an epoch change, so whatever is held is replaced.
  function applyResource(name, r, force) {
    if (!r || typeof r !== 'object' || typeof r.rev !== 'number') return;
    var held = resources[name];
    if (!force && held && r.rev <= held.rev) return;
    resources[name] = { rev: r.rev, data: r.data };
    if (r.rev > rev) rev = r.rev;
    notify(name);
  }

  // A whole set of resources, from a snapshot or a poll.
  function applySet(newEpoch, newRev, set) {
    var changed = newEpoch !== epoch;
    if (changed) resources = {};
    epoch = newEpoch;
    if (changed) rev = 0;
    set = set && typeof set === 'object' ? set : {};
    for (var name in set) {
      if (set.hasOwnProperty(name)) applyResource(name, set[name], changed);
    }
    if (typeof newRev === 'number' && newRev > rev) rev = newRev;
  }

  function runCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return;
    if (cmd.id !== undefined && cmd.id !== null) {
      var id = String(cmd.id);
      if (doneCommands.indexOf(id) >= 0) return;
      doneCommands.push(id);
      if (doneCommands.length > COMMAND_MEMORY) doneCommands.shift();
    }
    callAll(commandListeners, [cmd.type, cmd.data || {}]);
  }

  /* ---------- the steps ---------- */

  // Kinds of failure: 'lost', 'refused', 'badreply', 'needsupdate'.
  function fail(kind) {
    clearRetry();
    closeStream();
    abortAll();
    if (kind === 'lost') {
      if (!lostSince) lostSince = now();
      if (seen()) setState('lost', TEXT.lost.replace('{t}', timeText(lostSince)));
      else setState('quiet', '');
      var step = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      attempt += 1;
      later(connect, step);
      return;
    }
    lostSince = 0;
    setState(kind, TEXT[kind]);
    attempt += 1;
    later(connect, SLOW_RETRY);
  }

  // Sorts out a reply from the screen API. Returns a failure kind or ''.
  function judge(kind, data, code) {
    if (kind === 'net') return 'lost';
    if (kind === 'http') {
      if (code === 403 && data) return 'refused';
      // The server itself in trouble answers JSON; anything else is a stranger.
      if (data && data.ok === false && code >= 500) return 'lost';
      return 'badreply';
    }
    if (kind !== 'ok' || !data || data.ok !== true || typeof data.v !== 'number') return 'badreply';
    if (data.v > VERSION) return 'needsupdate';
    return '';
  }

  // Step 1: the full picture.
  function connect() {
    if (!started) return;
    clearRetry();
    closeStream();
    abortAll();
    gen += 1;
    var myGen = gen;
    if (state === 'off') setState('connecting', '');
    request('GET', server + '/live/state', null, SNAPSHOT_MS, true, function (kind, data, code) {
      if (myGen !== gen || !started) return;
      var problem = judge(kind, data, code);
      if (problem) {
        streamFails = 0;
        fail(problem);
        return;
      }
      markSeen();
      attempt = 0;
      lostSince = 0;
      applySet(String(data.epoch || ''), data.rev, data.resources);
      setState('live', TEXT.live);
      if (usePoll || typeof window.EventSource !== 'function') {
        usePoll = true;
        poll(myGen);
      } else {
        subscribe(myGen);
      }
    });
  }

  // Go back to step 1 straight away, unless that keeps happening.
  function resync(myGen) {
    if (myGen !== gen) return;
    resyncs += 1;
    closeStream();
    if (resyncs > 3) {
      resyncs = 0;
      later(connect, BACKOFF[0]);
      return;
    }
    connect();
  }

  function parse(e) {
    try { return JSON.parse(e.data); } catch (x) { return null; }
  }

  // Step 2: the push line.
  function subscribe(myGen) {
    var source;
    try {
      source = new window.EventSource(server + '/live/events');
    } catch (e) {
      usePoll = true;
      poll(myGen);
      return;
    }
    es = source;
    var greeted = false;
    feedWatchdog(myGen);

    function guard(fn) {
      return function (e) {
        if (myGen !== gen || es !== source) return;
        try { fn(e); } catch (x) { warn('event failed: ' + (x && x.message)); }
      };
    }

    source.addEventListener('hello', guard(function (e) {
      feedWatchdog(myGen);
      var d = parse(e) || {};
      if (typeof d.v === 'number' && d.v > VERSION) { fail('needsupdate'); return; }
      greeted = true;
      if (String(d.epoch || '') !== epoch || (typeof d.rev === 'number' && d.rev > rev)) { resync(myGen); return; }
      resyncs = 0;
    }), false);

    source.addEventListener('change', guard(function (e) {
      feedWatchdog(myGen);
      streamFails = 0;
      var d = parse(e);
      if (!d || typeof d.resource !== 'string') return;
      applyResource(d.resource, { rev: d.rev, data: d.data }, false);
    }), false);

    source.addEventListener('command', guard(function (e) {
      feedWatchdog(myGen);
      streamFails = 0;
      runCommand(parse(e));
    }), false);

    source.addEventListener('ping', guard(function (e) {
      feedWatchdog(myGen);
      streamFails = 0;
      var d = parse(e) || {};
      if (typeof d.rev === 'number' && d.rev > rev) resync(myGen);
    }), false);

    source.onerror = guard(function () {
      streamFailed(myGen, greeted ? 'the line dropped' : 'the line did not open');
    });
  }

  // Dropped or failed. EventSource would retry by itself; we close it and
  // decide when, so every reconnect begins with a snapshot.
  function streamFailed(myGen, why) {
    if (myGen !== gen) return;
    closeStream();
    streamFails += 1;
    if (streamFails >= STREAM_FAILS_FOR_POLL) {
      warn('the push line failed ' + streamFails + ' times (' + why + '), using the fallback');
      usePoll = true;
    }
    var step = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt += 1;
    later(connect, step);
  }

  // Step 4: the long-poll fallback.
  function poll(myGen) {
    if (myGen !== gen || !started) return;
    // Without a cursor the server sends no commands (nothing older than this
    // page fires) and would hold the poll, so the first one leaves out rev to
    // get an answer, and a cursor, at once.
    var url = server + '/live/poll?epoch=' + encodeURIComponent(epoch || '') + '&rev=' + (cursor ? rev : '') +
      '&cursor=' + encodeURIComponent(cursor);
    request('GET', url, null, POLL_MS, true, function (kind, data, code) {
      if (myGen !== gen || !started) return;
      var problem = judge(kind, data, code);
      if (problem) {
        // The snapshot decides how bad it is.
        if (problem === 'lost') {
          var step = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
          attempt += 1;
          later(connect, step);
        } else {
          fail(problem);
        }
        return;
      }
      lastEventAt = now();
      applySet(String(data.epoch || epoch || ''), data.rev, data.resources);
      var list = data.commands && data.commands.length ? data.commands : [];
      for (var i = 0; i < list.length; i++) runCommand(list[i]);
      if (data.cursor !== undefined && data.cursor !== null) cursor = String(data.cursor);
      later(function () { poll(myGen); }, 0);
    });
  }

  /* ---------- page visibility ---------- */

  function onVisible() {
    var hidden = document.hidden;
    if (hidden === undefined) hidden = document.webkitHidden;
    if (hidden || !started) return;
    if (state !== 'live') { attempt = 0; connect(); return; }
    if (!usePoll && streamDead()) connect();
    else if (usePoll && retryTimer && !xhrs.length) connect();
  }

  var visibilityHooked = false;
  function hookVisibility() {
    if (visibilityHooked) return;
    visibilityHooked = true;
    try {
      document.addEventListener('visibilitychange', onVisible, false);
      document.addEventListener('webkitvisibilitychange', onVisible, false);
    } catch (e) { /* ignore */ }
  }

  /* ---------- the API ---------- */

  function start(options) {
    try {
      if (started) stop();
      var wanted = readQuery('live');
      if (wanted === 'off') return false;
      var address = cleanServer(wanted !== null && wanted !== '' ? wanted : options && options.server);
      if (!address) return false;
      server = address;
      started = true;
      if (readQuery('livepoll') === '1') usePoll = true;
      attempt = 0;
      streamFails = 0;
      lostSince = 0;
      hookVisibility();
      setState('connecting', '');
      connect();
      return true;
    } catch (e) {
      warn('could not start: ' + (e && e.message));
      return false;
    }
  }

  function stop() {
    started = false;
    gen += 1;
    clearRetry();
    closeStream();
    abortAll();
    setState('off', '');
  }

  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] = listeners[name] || []).push(fn);
    return function () {
      var list = listeners[name] || [];
      var at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    };
  }

  function post(path, body, cb) {
    cb = typeof cb === 'function' ? cb : function () {};
    if (!started || !server) {
      setTimeout(function () { cb('live updates are off', null, 0); }, 0);
      return;
    }
    request('POST', server + path, body === undefined ? {} : body, POST_MS, false, function (kind, data, code) {
      if (kind === 'ok' && data && data.ok === true) return cb(null, data, code);
      if (kind === 'net') return cb('not reachable', null, code);
      cb((data && data.error) || ('HTTP ' + code), data, code);
    });
  }

  window.HUB_LIVE = {
    version: VERSION,
    start: start,
    stop: stop,
    status: status,
    get: function (name) { return resources[name] ? resources[name].data : undefined; },
    rev: function (name) { return resources[name] ? resources[name].rev : 0; },
    on: on,
    onCommand: function (fn) { if (typeof fn === 'function') commandListeners.push(fn); },
    onStatus: function (fn) { if (typeof fn === 'function') statusListeners.push(fn); },
    post: post,
    everConnected: seen
  };
})();
