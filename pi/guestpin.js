/*
 * The Guest mode PIN (POST /guest/pin from the TV; ./hub guest-pin on the Pi).
 *
 * Turning Guest mode on or off on the TV's Clock page asks for a 4-digit
 * PIN. The PIN is checked here, never in a file the TV loads: only a salted
 * scrypt hash is kept, in <dataDir>/guest-pin.json (mode 0600, written to a
 * temporary file and renamed into place).
 *
 *   const pins = guestpin.create({ dataDir, log, now })
 *   pins.handle(body)  -> Promise of the answer for POST /guest/pin:
 *     { action: 'status' }            { ok, set, locked_for }
 *     { action: 'check', pin: '1234' } { ok, set, match, locked_for, left }
 *     { action: 'set', pin: '1234' }   { ok, set: true }  (only while no PIN is set: 409 after)
 *   pins.status()      { set, locked_for }
 *   pins.reset()       forgets the PIN (the TV then asks for a new one); true if one was kept
 *
 * Wrong tries (all screens together, in memory): 3 in a row lock checks for
 * 30 seconds, each further lock twice as long, up to 5 minutes. A right PIN
 * clears both. While locked, a check answers match: false with locked_for
 * (whole seconds) and is not counted. A wrong answer has the status 200 so
 * the TV can tell "wrong" from "can't reach the hub".
 *
 * Never log a PIN or a hash. Node 22, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'guest-pin.json';
const PIN_RE = /^\d{4}$/;
const TRIES = 3;
const LOCK_FIRST = 30;      // seconds
const LOCK_MAX = 300;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

function bad(message, status) {
  const e = new Error(message);
  e.status = status || 400;
  return e;
}

function scrypt(pin, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, KEYLEN, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

// The lock after `locks` earlier locks: 30, 60, 120, 240, 300, 300 ...
function lockSeconds(locks) {
  return Math.min(LOCK_MAX, LOCK_FIRST * Math.pow(2, Math.max(0, locks)));
}

function create(opt) {
  opt = opt || {};
  const file = opt.file || path.join(opt.dataDir || 'data', FILE);
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();

  let streak = 0;          // wrong tries in a row since the last lock or right PIN
  let locks = 0;           // locks since the last right PIN
  let lockedUntil = 0;     // ms
  let queue = Promise.resolve();   // checks and sets run one at a time, so tries can't race the lock

  function serial(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    try {
      const j = JSON.parse(raw);
      if (j && j.v === 1 && /^[0-9a-f]{32}$/.test(j.salt) && /^[0-9a-f]{64}$/.test(j.hash)) return j;
    } catch (e) { /* damaged: below */ }
    log('guest PIN: the saved PIN file is damaged; the TV will ask for a new PIN');
    return null;
  }

  function write(record) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) { /* the mode above is enough */ }
    fs.renameSync(tmp, file);
  }

  function lockedFor() {
    const left = lockedUntil - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function status() {
    return { set: !!read(), locked_for: lockedFor() };
  }

  function pinOf(body) {
    const pin = body && body.pin;
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw bad('the PIN must be 4 digits');
    return pin;
  }

  async function check(pin) {
    const saved = read();
    if (!saved) return { ok: true, set: false, match: false, locked_for: 0 };
    const wait = lockedFor();
    if (wait) return { ok: true, set: true, match: false, locked_for: wait };
    const key = await scrypt(pin, Buffer.from(saved.salt, 'hex'), { N: saved.N || SCRYPT.N, r: saved.r || SCRYPT.r, p: saved.p || SCRYPT.p });
    const want = Buffer.from(saved.hash, 'hex');
    const match = key.length === want.length && crypto.timingSafeEqual(key, want);
    if (match) {
      streak = 0;
      locks = 0;
      lockedUntil = 0;
      return { ok: true, set: true, match: true, locked_for: 0 };
    }
    streak += 1;
    if (streak >= TRIES) {
      const secs = lockSeconds(locks);
      locks += 1;
      streak = 0;
      lockedUntil = now() + secs * 1000;
      log('guest PIN: ' + TRIES + ' wrong tries in a row, locked for ' + secs + ' s');
      return { ok: true, set: true, match: false, locked_for: secs, left: 0 };
    }
    log('guest PIN: a wrong try');
    return { ok: true, set: true, match: false, locked_for: 0, left: TRIES - streak };
  }

  async function set(pin) {
    if (read()) throw bad('a PIN is already set (./hub guest-pin reset on the Pi to start again)', 409);
    const salt = crypto.randomBytes(16);
    const key = await scrypt(pin, salt, SCRYPT);
    // Someone else may have set one while this was hashing.
    if (read()) throw bad('a PIN is already set (./hub guest-pin reset on the Pi to start again)', 409);
    write({ v: 1, salt: salt.toString('hex'), hash: key.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, at: new Date(now()).toISOString() });
    streak = 0;
    locks = 0;
    lockedUntil = 0;
    log('guest PIN: a new PIN was set from the TV');
    return { ok: true, set: true, locked_for: 0 };
  }

  function reset() {
    let had = false;
    try { fs.unlinkSync(file); had = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    streak = 0;
    locks = 0;
    lockedUntil = 0;
    log('guest PIN: ' + (had ? 'forgotten; the TV will ask for a new PIN' : 'reset asked for, none was set'));
    return had;
  }

  async function handle(body) {
    const action = body && body.action;
    if (action === 'status') return Object.assign({ ok: true }, status());
    if (action === 'check') { const pin = pinOf(body); return serial(() => check(pin)); }
    if (action === 'set') { const pin = pinOf(body); return serial(() => set(pin)); }
    throw bad('send { "action": "status" | "check" | "set" }');
  }

  return { handle: handle, status: status, check: check, set: set, reset: reset, file: file };
}

module.exports = { create: create, lockSeconds: lockSeconds, FILE: FILE, TRIES: TRIES };
