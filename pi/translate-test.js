/*
 * Tests for the Spanish translator (translate.js) and POST /api/translate.
 * Run from the repo root: node pi/translate-test.js
 * Gemini is mocked; nothing leaves this computer.
 */
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const translate = require('./translate');
const hubServer = require('./server');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));
const fake = (calls) => (items) => { calls.push(items.slice()); return Promise.resolve(JSON.stringify(items.map((s) => 'ES:' + s))); };

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-token-0123456789abcdef-long-enough' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t) }));
    });
    req.on('error', reject); req.end(data);
  });
}

(async () => {
  await check('misses go to Gemini in one call, then come from the cache file', async () => {
    const dir = tmp(); const calls = []; const logs = [];
    let t = translate.createTranslator({ dataDir: dir, call: fake(calls), log: (l) => logs.push(l) });
    const r = await t.translate(['Buy milk', 'Call Ana']);
    assert.deepStrictEqual(r.map, { 'Buy milk': 'ES:Buy milk', 'Call Ana': 'ES:Call Ana' });
    assert.strictEqual(calls.length, 1);
    t = translate.createTranslator({ dataDir: dir, call: fake(calls), log: (l) => logs.push(l) }); // reload from disk
    const r2 = await t.translate(['Buy milk', 'New one']);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1], ['New one']);
    assert.strictEqual(r2.map['Buy milk'], 'ES:Buy milk');
    assert(logs.some((l) => /^translate: 2 asked, 0 cached, 2 new \(Gemini \d+ ms\)$/.test(l)), logs.join('|'));
    assert(logs.some((l) => /^translate: 2 asked, 1 cached, 1 new/.test(l)));
    logs.forEach((l) => assert(!/milk|Ana|New one/i.test(l), 'a text reached the log'));
  });
  await check('concurrent requests do not translate twice', async () => {
    const calls = []; let release;
    const gate = new Promise((r) => { release = r; });
    const t = translate.createTranslator({ dataDir: tmp(), log: () => {}, call: (items) => { calls.push(items); return gate.then(() => JSON.stringify(items.map((s) => 'x' + s))); } });
    const a = t.translate(['A']); const b = t.translate(['A', 'B']);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra.map.A, 'xA'); assert.strictEqual(rb.map.B, 'xB');
    assert.strictEqual(calls.length, 2); assert.deepStrictEqual(calls[1], ['B']);
  });
  await check('bad answers are not cached; errors pause Gemini for 10 minutes', async () => {
    let clock = 1000; let n = 0; let mode = 'short';
    const t = translate.createTranslator({ dataDir: tmp(), now: () => clock, log: () => {}, call: (items) => {
      n++;
      if (mode === 'short') return Promise.resolve('["only one"]');
      if (mode === 'throw') return Promise.reject(new Error('Gemini HTTP 429'));
      return Promise.resolve(JSON.stringify(items.map((s) => 'ok' + s)));
    } });
    let r = await t.translate(['A', 'B']);
    assert.deepStrictEqual(r.map, {}); assert.strictEqual(t.size(), 0); assert.strictEqual(n, 1);
    mode = 'ok';
    r = await t.translate(['A']); assert.deepStrictEqual(r.map, {}); assert.strictEqual(n, 1, 'paused');
    clock += translate.BACKOFF_MS + 1;
    r = await t.translate(['A']); assert.strictEqual(r.map.A, 'okA'); assert.strictEqual(n, 2);
    mode = 'throw'; clock += 1;
    r = await t.translate(['Z']); assert.deepStrictEqual(r.map, {}); assert(t.info().paused);
  });
  await check('the cache is capped, oldest dropped', async () => {
    const t = translate.createTranslator({ dataDir: tmp(), log: () => {}, call: fake([]), maxNewPerDay: 100000 });
    for (let i = 0; i < translate.MAX_CACHE / 50 + 2; i++) {
      const items = []; for (let j = 0; j < 50; j++) items.push('t' + i + '_' + j);
      await t.translate(items.slice(0, 50));
    }
    assert.strictEqual(t.size(), translate.MAX_CACHE);
    assert.strictEqual((await t.translate(['t0_0'])).map['t0_0'], 'ES:t0_0'); // re-translated, so it was dropped
  });
  await check('a daily limit caps new lines sent to Gemini', async () => {
    const calls = []; const lines = [];
    const t = translate.createTranslator({ dataDir: tmp(), log: (l) => lines.push(l), call: fake(calls), maxNewPerDay: 3 });
    let r = await t.translate(['a1', 'a2']); assert.strictEqual(r.map.a1, 'ES:a1');
    r = await t.translate(['a1', 'b1', 'b2']); assert.deepStrictEqual(r.map, { a1: 'ES:a1' });
    assert.strictEqual(calls.length, 1);
    assert(lines.some((l) => l === 'translate: 3 asked, 1 cached, 2 not translated (daily limit)'));
  });
  await check('no key: cache hits only, disabled', async () => {
    const dir = tmp();
    translate.createTranslator({ dataDir: dir, call: fake([]), log: () => {} }).translate(['Hi']);
    await new Promise((r) => setTimeout(r, 20));
    const t = translate.createTranslator({ dataDir: dir, key: '', log: () => {} });
    const r = await t.translate(['Hi', 'Other']);
    assert.deepStrictEqual(r.map, { Hi: 'ES:Hi' }); assert.strictEqual(r.disabled, true);
  });
  await check('request checks', () => {
    assert.throws(() => translate.checkRequest({ to: 'fr', texts: [] }), /only/);
    assert.throws(() => translate.checkRequest({ to: 'es', texts: new Array(61).fill('a') }), /at most/);
    assert.throws(() => translate.checkRequest({ to: 'es', texts: ['x'.repeat(501)] }), /at most/);
    assert.throws(() => translate.checkRequest({ to: 'es', texts: [5] }), /string/);
    assert.deepStrictEqual(translate.checkRequest({ to: 'es', texts: ['a', 'a', ' ', 'b'] }), ['a', 'b']);
  });
  await check('POST /api/translate and the TV route /translate', async () => {
    const calls = [];
    const h = hubServer.start({ port: 0, token: 'test-token-0123456789abcdef-long-enough', log: false, dataDir: tmp(), translateCall: fake(calls) });
    await h.ready;
    try {
      const r = await post(h.port, '/api/translate', { to: 'es', texts: ['Hello'] });
      assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { ok: true, map: { Hello: 'ES:Hello' } });
      const t = await post(h.port, '/translate', { to: 'es', texts: ['Hello', 'Bye'] });
      assert.strictEqual(t.body.map.Bye, 'ES:Bye'); assert.strictEqual(calls.length, 2);
      const bad = await post(h.port, '/api/translate', { to: 'de', texts: ['x'] });
      assert.strictEqual(bad.status, 400);
    } finally { await new Promise((r) => h.close(r)); }
  });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
