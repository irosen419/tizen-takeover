/*
 * TEST FIXTURE ONLY (dev/pin-test.js): a stand-in for app/live.js that
 * answers POST /guest/pin like pi/server.js with pi/guestpin.js (status,
 * check, set; 3 wrong in a row lock it). Never loaded by the hub itself:
 * the test serves it in place of live.js.
 *
 * window.PIN_STUB: pin (the PIN set, or '' for none), lockSecs (the lock a
 * third wrong try gives), down (true: every post fails as "not reachable"),
 * posts (every body posted), wrong (wrong tries in a row), lockedUntil,
 * push(name, data) (a live resource arriving, e.g. guestall). { all, on }
 * with a right PIN answers all: true like the Pi. POST /prefs is kept in
 * resources.prefs and pushed back (noPrefs: true answers 404, an older Pi).
 */
(function () {
  'use strict';

  var stub = { pin: '', lockSecs: 25, down: false, posts: [], wrong: 0, lockedUntil: 0, delay: 60, resources: {}, listeners: {} };
  window.PIN_STUB = stub;
  // A push from the Pi, as another screen's change would arrive.
  stub.push = function (name, data) {
    stub.resources[name] = data;
    var l = stub.listeners[name] || [];
    for (var i = 0; i < l.length; i++) l[i](data, 1);
  };

  function lockedFor() {
    var left = stub.lockedUntil - new Date().getTime();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function answer(body) {
    if (!body || typeof body !== 'object') return [400, { ok: false, error: 'bad body' }];
    if (body.action === 'status') return [200, { ok: true, set: !!stub.pin, locked_for: lockedFor() }];
    if (typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) return [400, { ok: false, error: 'the PIN must be 4 digits' }];
    var all = body.all === true && typeof body.on === 'boolean';
    if (body.action === 'set') {
      if (stub.pin) return [409, { ok: false, error: 'a PIN is already set' }];
      stub.pin = body.pin;
      return [200, all ? { ok: true, set: true, locked_for: 0, all: true } : { ok: true, set: true, locked_for: 0 }];
    }
    if (body.action === 'check') {
      if (!stub.pin) return [200, { ok: true, set: false, match: false, locked_for: 0 }];
      if (lockedFor()) return [200, { ok: true, set: true, match: false, locked_for: lockedFor() }];
      if (body.pin === stub.pin) {
        stub.wrong = 0;
        return [200, all ? { ok: true, set: true, match: true, locked_for: 0, all: true } : { ok: true, set: true, match: true, locked_for: 0 }];
      }
      stub.wrong += 1;
      if (stub.wrong >= 3) {
        stub.wrong = 0;
        stub.lockedUntil = new Date().getTime() + stub.lockSecs * 1000;
        return [200, { ok: true, set: true, match: false, locked_for: stub.lockSecs, left: 0 }];
      }
      return [200, { ok: true, set: true, match: false, locked_for: 0, left: 3 - stub.wrong }];
    }
    return [400, { ok: false, error: 'unknown action' }];
  }

  window.HUB_LIVE = {
    version: 1,
    start: function () { return true; },
    stop: function () {},
    status: function () { return { state: 'live', text: 'Live', since: 0, epoch: 'stub' }; },
    get: function (name) { return stub.resources[name]; },
    rev: function () { return 0; },
    on: function (name, fn) { (stub.listeners[name] = stub.listeners[name] || []).push(fn); return function () {}; },
    onCommand: function () {},
    onStatus: function () {},
    everConnected: function () { return true; },
    fetch: function (path, cb) { setTimeout(function () { cb('not in the stub', null, 404); }, 0); },
    post: function (path, body, cb) {
      stub.posts.push({ path: path, body: JSON.parse(JSON.stringify(body)) });
      setTimeout(function () {
        if (stub.down) return cb('not reachable', null, 0);
        if (path === '/prefs' && !stub.noPrefs) {
          // Like pi/prefs.js: kept and pushed back to every screen (this one too).
          var cur = stub.resources.prefs || { values: {}, at: {} };
          var next = { values: JSON.parse(JSON.stringify(cur.values || {})), at: JSON.parse(JSON.stringify(cur.at || {})) };
          if (body.value === null) { delete next.values[body.key]; delete next.at[body.key]; } else { next.values[body.key] = body.value; next.at[body.key] = 'now'; }
          cb(null, { ok: true, key: body.key, changed: true }, 200);
          stub.push('prefs', next);
          return;
        }
        if (path !== '/guest/pin') return cb('not found', { ok: false, error: 'not found' }, 404);
        var a = answer(body);
        if (a[0] !== 200) return cb(a[1].error, a[1], a[0]);
        cb(null, a[1], 200);
      }, stub.delay);
    }
  };
})();
