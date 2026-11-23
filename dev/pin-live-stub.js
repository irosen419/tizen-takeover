/*
 * TEST FIXTURE ONLY (dev/pin-test.js): a stand-in for app/live.js that
 * answers POST /guest/pin like pi/server.js with pi/guestpin.js (status,
 * check, set; 3 wrong in a row lock it). Never loaded by the hub itself:
 * the test serves it in place of live.js.
 *
 * window.PIN_STUB: pin (the PIN set, or '' for none), lockSecs (the lock a
 * third wrong try gives), down (true: every post fails as "not reachable"),
 * posts (every body posted), wrong (wrong tries in a row), lockedUntil.
 */
(function () {
  'use strict';

  var stub = { pin: '', lockSecs: 25, down: false, posts: [], wrong: 0, lockedUntil: 0, delay: 60 };
  window.PIN_STUB = stub;

  function lockedFor() {
    var left = stub.lockedUntil - new Date().getTime();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function answer(body) {
    if (!body || typeof body !== 'object') return [400, { ok: false, error: 'bad body' }];
    if (body.action === 'status') return [200, { ok: true, set: !!stub.pin, locked_for: lockedFor() }];
    if (typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) return [400, { ok: false, error: 'the PIN must be 4 digits' }];
    if (body.action === 'set') {
      if (stub.pin) return [409, { ok: false, error: 'a PIN is already set' }];
      stub.pin = body.pin;
      return [200, { ok: true, set: true, locked_for: 0 }];
    }
    if (body.action === 'check') {
      if (!stub.pin) return [200, { ok: true, set: false, match: false, locked_for: 0 }];
      if (lockedFor()) return [200, { ok: true, set: true, match: false, locked_for: lockedFor() }];
      if (body.pin === stub.pin) { stub.wrong = 0; return [200, { ok: true, set: true, match: true, locked_for: 0 }]; }
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
    get: function () { return undefined; },
    rev: function () { return 0; },
    on: function () { return function () {}; },
    onCommand: function () {},
    onStatus: function () {},
    everConnected: function () { return true; },
    fetch: function (path, cb) { setTimeout(function () { cb('not in the stub', null, 404); }, 0); },
    post: function (path, body, cb) {
      stub.posts.push({ path: path, body: JSON.parse(JSON.stringify(body)) });
      setTimeout(function () {
        if (stub.down) return cb('not reachable', null, 0);
        if (path !== '/guest/pin') return cb('not found', { ok: false, error: 'not found' }, 404);
        var a = answer(body);
        if (a[0] !== 200) return cb(a[1].error, a[1], a[0]);
        cb(null, a[1], 200);
      }, stub.delay);
    }
  };
})();
