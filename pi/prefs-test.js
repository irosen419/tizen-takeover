/*
 * Tests for the shared widget preferences and Guest mode on every screen
 * (prefs.js, and their routes in server.js): node pi/prefs-test.js
 *
 * The key list and value checks, a null removing a key, a cleaned copy
 * from a damaged file; on a real server: POST /prefs from a screen (home
 * address, listed Origin), the push to /live/state, GET /api/prefs and the
 * mailbox's words (keys and times, never a value), a restart keeping them,
 * log lines without a value; POST /guest/pin { all, on } setting guestall
 * only with a right PIN (and with a new one), never with a wrong one.
 * Prints one line per check, then "N passed, M failed". Node only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const prefs = require('./prefs');
const hubServer = require('./server');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
let passed = 0;
let failed = 0;
const dirs = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prefs-'));
  dirs.push(d);
  return d;
}

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    const body = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function start(dataDir) {
  const lines = [];
  const opts = {
    port: 0, token: TOKEN, dataDir: dataDir || tmp(), log: (s) => lines.push(String(s)),
    clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress
  };
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.lines = lines; h.dataDir = opts.dataDir; return h; });
}
const stop = (h) => new Promise((r) => h.close(r));

const CAP = { v: 1, cardDate: '2026-12-01', keep: 214.5, at: '2026-11-24T20:00:00.000Z' };

async function main() {
  /* ---------- prefs.js ---------- */

  await check('the key list; good values kept, bad ones and unknown keys refused; null removes', async () => {
    assert.deepStrictEqual(prefs.KEYS, ['clock.face', 'clock.hours', 'budget.capPref']);
    let r = prefs.apply(prefs.emptyData(), { key: 'clock.hours', value: '24' }, 'T1');
    assert.deepStrictEqual(r.data, { values: { 'clock.hours': '24' }, at: { 'clock.hours': 'T1' } });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(prefs.apply(r.data, { key: 'clock.hours', value: '24' }, 'T2').changed, false);
    r = prefs.apply(r.data, { key: 'budget.capPref', value: CAP }, 'T3');
    assert.deepStrictEqual(r.data.values['budget.capPref'], CAP);
    assert.throws(() => prefs.apply(r.data, { key: 'clock.hours', value: '13' }, 'T'), /one of 12, 24/);
    assert.throws(() => prefs.apply(r.data, { key: 'look', value: 'day' }, 'T'), /unknown preference/);
    assert.throws(() => prefs.apply(r.data, { key: 'budget.capPref', value: { v: 1, keep: 'x', cardDate: '2026-12-01' } }, 'T'), /keep/);
    assert.throws(() => prefs.apply(r.data, { key: 'clock.face' }, 'T'), /send/);
    r = prefs.apply(r.data, { key: 'clock.hours', value: null }, 'T4');
    assert.deepStrictEqual(Object.keys(r.data.values), ['budget.capPref']);
    assert.deepStrictEqual(Object.keys(r.data.at), ['budget.capPref']);
    const clean = prefs.cleanResource({ rev: 4, data: { values: { 'clock.face': 'round', 'clock.hours': '12', junk: 1 }, at: { 'clock.hours': 'T' } } });
    assert.deepStrictEqual(clean, { rev: 4, data: { values: { 'clock.hours': '12' }, at: { 'clock.hours': 'T' } } });
    assert.deepStrictEqual(prefs.guestClean({ data: { on: 'yes' } }).data, { on: null, at: null });
    assert.ok(prefs.showText(r.data).indexOf('214') < 0, 'no amount in the words');
  });

  /* ---------- the server ---------- */

  const tv = { Origin: 'http://127.0.0.1:8081', 'x-test-ip': '192.168.1.50' };
  let h = await start();
  const dir = h.dataDir;
  try {
    await check('POST /prefs from a screen: saved, in /live/state for every screen; foreign Origin or outside address refused', async () => {
      let r = await request(h.port, 'POST', '/prefs', { headers: tv, body: { key: 'clock.hours', value: '24' } });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.changed, true);
      r = await request(h.port, 'POST', '/prefs', { headers: tv, body: { key: 'budget.capPref', value: CAP } });
      assert.strictEqual(r.status, 200, r.text);
      r = await request(h.port, 'POST', '/prefs', { headers: tv, body: { key: 'clock.hours', value: '7' } });
      assert.strictEqual(r.status, 400);
      r = await request(h.port, 'POST', '/prefs', { headers: Object.assign({}, tv, { Origin: 'http://evil.example' }), body: { key: 'clock.face', value: 'analog' } });
      assert.strictEqual(r.status, 403);
      r = await request(h.port, 'POST', '/prefs', { headers: Object.assign({}, tv, { 'x-test-ip': '8.8.8.8' }), body: { key: 'clock.face', value: 'analog' } });
      assert.strictEqual(r.status, 403);
      r = await request(h.port, 'GET', '/live/state', { headers: tv });
      assert.deepStrictEqual(r.json.resources.prefs.data.values, { 'clock.hours': '24', 'budget.capPref': CAP });
      assert.deepStrictEqual(r.json.resources.guestall.data, { on: null, at: null });
    });

    await check('GET /api/prefs (token): keys and times, never a value; the log names the key only', async () => {
      const r = await request(h.port, 'GET', '/api/prefs', { token: TOKEN });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(r.json.keys, ['clock.hours', 'budget.capPref']);
      assert.ok(/clock\.hours \(set/.test(r.json.message), r.json.message);
      assert.ok(r.text.indexOf('214.5') < 0, 'the cap amount is not in the reply');
      assert.ok(h.lines.some((l) => /screen set the shared preference budget\.capPref/.test(l)));
      assert.ok(!h.lines.some((l) => /214/.test(l)), 'no amount in the log');
    });

    await check('POST /guest/pin { all, on }: guestall set only with a right PIN (or a new one); a wrong one changes nothing', async () => {
      let r = await request(h.port, 'POST', '/guest/pin', { headers: tv, body: { action: 'set', pin: '2468', all: true, on: true } });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.all, true);
      let s = await request(h.port, 'GET', '/live/state', { headers: tv });
      assert.strictEqual(s.json.resources.guestall.data.on, true);
      const at1 = s.json.resources.guestall.data.at;
      r = await request(h.port, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: '1111', all: true, on: false } });
      assert.strictEqual(r.json.match, false);
      assert.strictEqual(r.json.all, undefined);
      s = await request(h.port, 'GET', '/live/state', { headers: tv });
      assert.deepStrictEqual(s.json.resources.guestall.data, { on: true, at: at1 });
      r = await request(h.port, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: '2468' } });
      assert.strictEqual(r.json.match, true);
      assert.strictEqual(r.json.all, undefined, 'no all asked: this screen only');
      r = await request(h.port, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: '2468', all: true, on: false } });
      assert.strictEqual(r.json.all, true);
      s = await request(h.port, 'GET', '/live/state', { headers: tv });
      assert.strictEqual(s.json.resources.guestall.data.on, false);
      assert.ok(h.lines.some((l) => /Guest mode off on every screen/.test(l)));
      assert.ok(!h.lines.some((l) => /2468/.test(l)), 'never the PIN');
    });
  } finally {
    await stop(h);
  }

  await check('a restart keeps the preferences and the last All screens choice', async () => {
    h = await start(dir);
    try {
      const s = await request(h.port, 'GET', '/live/state', { headers: tv });
      assert.strictEqual(s.json.resources.prefs.data.values['clock.hours'], '24');
      assert.deepStrictEqual(s.json.resources.prefs.data.values['budget.capPref'], CAP);
      assert.strictEqual(s.json.resources.guestall.data.on, false);
    } finally {
      await stop(h);
    }
  });

  await check('the mailbox has prefs.show (keys and times only)', async () => {
    const text = fs.readFileSync(path.join(__dirname, 'mailbox.js'), 'utf8');
    assert.ok(/'prefs\.show'/.test(text) && /\/api\/prefs/.test(text));
  });

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
