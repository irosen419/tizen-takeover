/*
 * Tests for Spanish study progress (spanish.js) and its routes in server.js:
 * node pi/spanish-test.js
 *
 * The box rule (got moves up 1, 3, 7, 14, 30 days; again goes back to box 0,
 * due today, one more miss), the same rule as apply() in app/flash-math.js,
 * bad ops refused with nothing changed, today's new and reviewed counts, and
 * on a real server: GET /spanish/progress, POST /spanish/ops, the browser's
 * preflight, a log line with counts only, the progress surviving a restart.
 * Dates are relative to the real today, never a fixed day or zone.
 * Prints one line per check, then "N passed, M failed". Node only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const S = require('./spanish');
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

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spanish-'));
  dirs.push(d);
  return d;
}

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    const body = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Today as the module sees it, and days around it, all from the real clock.
const today = new Date().toISOString().slice(0, 10);
const plus = (n) => S.addDays(today, n);

async function main() {
  if (!S.available()) {
    console.log('skip: this Node has no node:sqlite');
    console.log('0 passed, 0 failed');
    return;
  }

  await check('apply: got climbs the boxes 1, 3, 7, 14, 30 days and stays at 30; again goes back to today', () => {
    let r = S.apply(null, 'got', today);
    assert.deepStrictEqual(r, [1, plus(1), 0]);
    const seen = [];
    for (let i = 0; i < 6; i++) { r = S.apply(r, 'got', today); seen.push(r[1]); }
    assert.deepStrictEqual(seen, [plus(3), plus(7), plus(14), plus(30), plus(30), plus(30)]);
    r = S.apply(r, 'again', today);
    assert.deepStrictEqual(r, [0, today, 1]);
    assert.deepStrictEqual(S.apply(null, 'again', today), [0, today, 1]);
  });

  await check('apply agrees with app/flash-math.js for every box and both answers', () => {
    const F = require('../app/flash-math');
    let rec = null;
    for (let i = 0; i < 8; i++) {
      for (const r of ['got', 'again']) assert.deepStrictEqual(S.apply(rec, r, today), F.apply(rec, r, today), 'box ' + (rec ? rec[0] : 'new') + ' ' + r);
      rec = S.apply(rec, 'got', today);
    }
    assert.strictEqual(String(S.ID_RE), String(F.ID_RE));
    assert.deepStrictEqual(S.INTERVALS, F.INTERVALS);
  });

  await check('ops: saved, counted for today, bad ops refused with nothing changed', () => {
    const db = S.createSpanish({ file: ':memory:', today: () => today });
    try {
      let r = db.ops({ ops: [{ id: 'tener.pret.1', r: 'got' }, { id: 'ser.pres.0', r: 'again' }] });
      assert.deepStrictEqual(r.cards, { 'tener.pret.1': [1, plus(1), 0], 'ser.pres.0': [0, today, 1] });
      assert.strictEqual(r.intro, 2);
      assert.strictEqual(r.reviewed, 2);
      r = db.ops({ ops: [{ id: 'ser.pres.0', r: 'got' }] });
      assert.deepStrictEqual(r.cards, { 'ser.pres.0': [1, plus(1), 1] }, 'misses kept');
      const p = db.progress();
      assert.strictEqual(p.today, today);
      assert.strictEqual(Object.keys(p.cards).length, 2);
      for (const body of [null, {}, { ops: [] }, { ops: [{ id: 'tener.pret.1', r: 'maybe' }] }, { ops: [{ id: 'tener.vos.1', r: 'got' }] },
        { ops: [{ id: 'ser.pres.0', r: 'got' }, { id: 'DROP TABLE', r: 'got' }] }, { ops: new Array(51).fill({ id: 'ser.pres.0', r: 'got' }) }]) {
        let err = null;
        try { db.ops(body); } catch (e) { err = e; }
        assert.ok(err && err.status === 400, 'refused: ' + JSON.stringify(body).slice(0, 60));
      }
      assert.deepStrictEqual(db.progress().cards['ser.pres.0'], [1, plus(1), 1], 'a refused batch changed nothing');
    } finally {
      db.close();
    }
  });

  await check('intro counts only cards first seen today', () => {
    let day = plus(-3);
    const db = S.createSpanish({ file: ':memory:', today: () => day });
    try {
      db.ops({ ops: [{ id: 'ir.fut.2', r: 'got' }] });
      day = today;
      const r = db.ops({ ops: [{ id: 'ir.fut.2', r: 'got' }, { id: 'ver.imp.3', r: 'got' }] });
      assert.strictEqual(r.intro, 1);
      assert.strictEqual(r.reviewed, 2);
    } finally {
      db.close();
    }
  });

  await check('server: GET /spanish/progress, POST /spanish/ops, the preflight, a log line with counts only, kept across a restart', async () => {
    const dir = tmpDir();
    const lines = [];
    const start = () => hubServer.start({ port: 0, token: TOKEN, log: (s) => lines.push(s), dataDir: dir, calendars: [] });
    let h = start();
    await h.ready;
    try {
      let r = await request(h.port, 'GET', '/spanish/progress');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.cards, {});
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.json.today), r.json.today);
      r = await request(h.port, 'POST', '/spanish/ops', { body: { ops: [{ id: 'hablar.pres.0', r: 'got' }] } });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.cards['hablar.pres.0'].slice(0, 1), [1]);
      assert.strictEqual((await request(h.port, 'POST', '/spanish/ops', { body: { ops: [{ id: 'x', r: 'got' }] } })).status, 400);
      assert.strictEqual((await request(h.port, 'GET', '/spanish/ops')).status, 405);
      assert.strictEqual((await request(h.port, 'POST', '/spanish/progress', { body: {} })).status, 405);
      const pre = await request(h.port, 'OPTIONS', '/spanish/ops');
      assert.strictEqual(pre.status, 204);
      const line = lines.filter((l) => /Spanish flashcard/.test(l));
      assert.ok(line.length === 1 && /a screen answered 1 Spanish flashcard$/.test(line[0]), JSON.stringify(line));
      assert.ok(!lines.some((l) => /hablar/.test(l)), 'no card in the log');
    } finally {
      await h.close();
    }
    h = start();
    await h.ready;
    try {
      const r = await request(h.port, 'GET', '/spanish/progress');
      assert.ok(r.json.cards['hablar.pres.0'], 'kept');
    } finally {
      await h.close();
    }
  });

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
