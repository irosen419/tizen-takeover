/*
 * Tests for the screen report (screenreport.js and its routes in server.js):
 * node pi/screenreport-test.js
 *
 * A report checked and cleaned (bad ids, places and lists refused); the
 * flat answer for Home Assistant (off when stale or in another app); the
 * one-line text; on a real server: POST /screen/report from a screen only,
 * GET /api/screen with the token, the log line only on a return, and the
 * TV-only commands layout, scene and visualizer through /api/command.
 * Prints one line per check, then "N passed, M failed". Node only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const screenreport = require('./screenreport');
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-screen-'));
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

const REPORT = {
  kind: 'tv', hub: '0.89.0', place: 'home', layout: { id: 'main', name: 'Main' },
  layouts: [{ id: 'stock', name: 'Default' }, { id: 'main', name: 'Main' }, { id: 'budget', name: 'Budget' }],
  widgets: ['today', 'weather', 'nowplaying'], open: null, mode: null, viz: false, playing: false,
  animations: { set: 'wanderers', scenes: ['fetch', 'sock-heist', 'night'] }
};

async function main() {
  await check('a report is checked and cleaned; bad ones refused', async () => {
    const r = screenreport.normalize(Object.assign({}, REPORT, { layout: { id: 'main', name: '  Main\n ' }, extra: 1 }));
    assert.strictEqual(r.layout.name, 'Main');
    assert.deepStrictEqual(r.scenes, ['fetch', 'sock-heist', 'night']);
    assert.strictEqual(r.animations, 'wanderers');
    assert.strictEqual(screenreport.normalize({}).kind, 'browser');
    assert.throws(() => screenreport.normalize([]), /object/);
    assert.throws(() => screenreport.normalize({ place: 'moon' }), /place/);
    assert.throws(() => screenreport.normalize({ open: '../x' }), /open/);
    assert.throws(() => screenreport.normalize({ animations: { set: 'stage', scenes: ['Band!'] } }), /scenes/);
    assert.throws(() => screenreport.normalize({ widgets: new Array(41).fill('a') }), /up to 40/);
    const l = screenreport.normalize({ last: { scene: 'fetch', ok: false, why: 'panel open', ago: 3.4 } });
    assert.deepStrictEqual(l.last, { scene: 'fetch', ok: false, why: 'panel open', ago: 3 });
  });

  await check('the flat answer: on while fresh, off when stale or in another app; text lines', async () => {
    let t = 1000000;
    const s = screenreport.createStore({ now: () => t, staleMs: 150000 });
    let g = s.get('tv');
    assert.strictEqual(g.on, false);
    assert.strictEqual(g.place, 'off');
    assert.ok(/has not reported/.test(screenreport.text(g)));
    assert.strictEqual(s.put(REPORT).first, true);
    t += 4000;
    assert.strictEqual(s.put(REPORT).first, false);
    g = s.get('tv');
    assert.strictEqual(g.on, true);
    assert.strictEqual(g.place, 'home');
    assert.strictEqual(g.layout, 'main');
    assert.deepStrictEqual(g.scenes, ['fetch', 'sock-heist', 'night']);
    assert.ok(/^Main, home screen\. Animations: fetch, sock-heist, night\./.test(screenreport.text(g)), screenreport.text(g));
    t += 151000;
    g = s.get('tv');
    assert.strictEqual(g.on, false);
    assert.deepStrictEqual(g.scenes, []);
    assert.strictEqual(g.layout, 'main', 'the last layout is still known');
    assert.ok(/not showing \(last heard 3 min ago\)/.test(screenreport.text(g)), screenreport.text(g));
    assert.strictEqual(s.put(Object.assign({}, REPORT, { place: 'away' })).first, true);
    assert.strictEqual(s.get('tv').on, false);
    assert.strictEqual(s.get('tablet').seenSecondsAgo, null, 'a tablet report is kept apart');
  });

  const tv = { Origin: 'http://127.0.0.1:8081', 'x-test-ip': '192.168.1.50' };
  const h = await start();
  try {
    await check('POST /screen/report from a screen; outside address refused; GET /api/screen needs the token', async () => {
      let r = await request(h.port, 'POST', '/screen/report', { headers: tv, body: REPORT });
      assert.strictEqual(r.status, 200, r.text);
      r = await request(h.port, 'POST', '/screen/report', { headers: Object.assign({}, tv, { 'x-test-ip': '8.8.8.8' }), body: REPORT });
      assert.strictEqual(r.status, 403);
      r = await request(h.port, 'POST', '/screen/report', { headers: tv, body: { place: 'moon' } });
      assert.strictEqual(r.status, 400);
      r = await request(h.port, 'GET', '/api/screen');
      assert.strictEqual(r.status, 401);
      r = await request(h.port, 'GET', '/api/screen', { token: TOKEN });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.on, true);
      assert.strictEqual(r.json.layoutName, 'Main');
      assert.deepStrictEqual(r.json.widgets, ['today', 'weather', 'nowplaying']);
      await request(h.port, 'POST', '/screen/report', { headers: tv, body: REPORT });
      assert.strictEqual(h.lines.filter((l) => /the tv reports what it shows/.test(l)).length, 1, 'logged once, not every report');
    });

    await check('layout, scene and visualizer commands: checked, for the TV unless told', async () => {
      let r = await request(h.port, 'POST', '/api/command', { token: TOKEN, body: { type: 'layout', data: { id: 'budget' } } });
      assert.strictEqual(r.status, 200, r.text);
      r = await request(h.port, 'POST', '/api/command', { token: TOKEN, body: { type: 'scene', data: { name: 'fetch', screen: 'all' } } });
      assert.strictEqual(r.status, 200, r.text);
      r = await request(h.port, 'POST', '/api/command', { token: TOKEN, body: { type: 'visualizer' } });
      assert.strictEqual(r.status, 200, r.text);
      r = await request(h.port, 'POST', '/api/command', { token: TOKEN, body: { type: 'layout', data: { id: '../x' } } });
      assert.strictEqual(r.status, 400);
      r = await request(h.port, 'POST', '/api/command', { token: TOKEN, body: { type: 'scene', data: { name: 'Fetch Now' } } });
      assert.strictEqual(r.status, 400);
      r = await request(h.port, 'POST', '/api/command', { token: TOKEN, body: { type: 'scene', data: { name: 'fetch', screen: 'fridge' } } });
      assert.strictEqual(r.status, 400);
    });
  } finally {
    await stop(h);
    dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* */ } });
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main();
