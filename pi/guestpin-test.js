/*
 * Tests for the Guest mode PIN: node pi/guestpin-test.js
 *
 * guestpin.js on its own (create, check, wrong tries and the lock doubling
 * up to 5 minutes, a right PIN clearing it, the file holding only a salted
 * hash at mode 0600, a damaged file, reset), then the real server over HTTP:
 * POST /guest/pin with no token from a home address and a listed Origin
 * (OPTIONS answered), refused from outside, from a non-TV address when
 * HUB_TV_IPS is set or a foreign Origin, never the
 * PIN in a log line; GET /api/guest-pin and POST /api/guest-pin/reset with
 * the token; and ./hub guest-pin reset. Only Node, no packages. Prints one
 * line per check, then "N passed, M failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const guestpin = require('./guestpin');
const hubServer = require('./server');
const hubctl = require('./hubctl');

const TOKEN = 'guestpin-test-token-0123456789abcdef';
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
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
  }
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-guestpin-'));
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
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function start(extra) {
  const lines = [];
  const opts = Object.assign({
    port: 0, token: TOKEN, dataDir: tmp(), log: (s) => lines.push(String(s)),
    clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress
  }, extra || {});
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.lines = lines; h.dataDir = opts.dataDir; return h; });
}
const stop = (h) => new Promise((r) => h.close(r));

async function main() {
  /* ---------- guestpin.js ---------- */

  await check('no PIN at first; set stores a salted scrypt hash only, mode 0600; a second set is refused (409)', async () => {
    const dir = tmp();
    const lines = [];
    const p = guestpin.create({ dataDir: dir, log: (s) => lines.push(s) });
    assert.deepStrictEqual(await p.handle({ action: 'status' }), { ok: true, set: false, locked_for: 0 });
    const c = await p.handle({ action: 'check', pin: '1234' });
    assert.strictEqual(c.set, false);
    assert.strictEqual(c.match, false);
    assert.deepStrictEqual(await p.handle({ action: 'set', pin: '2468' }), { ok: true, set: true, locked_for: 0 });
    const file = path.join(dir, 'guest-pin.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.indexOf('2468') < 0, 'the PIN is in the file');
    const j = JSON.parse(raw);
    assert.ok(/^[0-9a-f]{32}$/.test(j.salt) && /^[0-9a-f]{64}$/.test(j.hash) && j.N >= 16384, 'salt and hash');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(dir), ['guest-pin.json'], 'no temporary file left');
    await assert.rejects(p.handle({ action: 'set', pin: '1111' }), (e) => e.status === 409);
    assert.strictEqual((await p.handle({ action: 'status' })).set, true);
    assert.ok(!lines.join('\n').match(/2468|1111|1234/) && lines.join('\n').indexOf(j.hash) < 0, 'a PIN or the hash in the log');
    // Two salts for the same PIN differ.
    const dir2 = tmp();
    const p2 = guestpin.create({ dataDir: dir2 });
    await p2.set('2468');
    assert.notStrictEqual(JSON.parse(fs.readFileSync(path.join(dir2, 'guest-pin.json'), 'utf8')).hash, j.hash);
  });

  await check('check: the right PIN matches, a wrong one does not and says how many tries are left', async () => {
    const p = guestpin.create({ dataDir: tmp() });
    await p.handle({ action: 'set', pin: '0007' });
    assert.deepStrictEqual(await p.handle({ action: 'check', pin: '0007' }), { ok: true, set: true, match: true, locked_for: 0 });
    const w = await p.handle({ action: 'check', pin: '0070' });
    assert.strictEqual(w.match, false);
    assert.strictEqual(w.left, 2);
    assert.strictEqual(w.locked_for, 0);
  });

  await check('only 4 digits: letters, 3 or 5 digits, numbers and missing PINs are refused (400); an unknown action too', async () => {
    const p = guestpin.create({ dataDir: tmp() });
    for (const pin of ['12a4', '123', '12345', 1234, '', null, ' 123', '١٢٣٤', '12.4']) {
      await assert.rejects(p.handle({ action: 'set', pin: pin }), (e) => e.status === 400, JSON.stringify(pin));
      await assert.rejects(p.handle({ action: 'check', pin: pin }), (e) => e.status === 400, JSON.stringify(pin));
    }
    await assert.rejects(p.handle({ action: 'zap' }), (e) => e.status === 400);
    await assert.rejects(p.handle(null), (e) => e.status === 400);
    assert.strictEqual(p.status().set, false, 'nothing was set');
  });

  await check('3 wrong in a row lock for 30 s, then 60, 120, 240 and at most 300; locked tries are not counted; a right PIN clears it all', async () => {
    let t = 1000000;
    const p = guestpin.create({ dataDir: tmp(), now: () => t });
    await p.set('5555');
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6].map(guestpin.lockSeconds), [30, 60, 120, 240, 300, 300, 300]);
    const wrongThree = async () => {
      await p.handle({ action: 'check', pin: '0000' });
      await p.handle({ action: 'check', pin: '0000' });
      return p.handle({ action: 'check', pin: '0000' });
    };
    let r = await wrongThree();
    assert.strictEqual(r.locked_for, 30);
    t += 5000;
    r = await p.handle({ action: 'check', pin: '5555' });
    assert.strictEqual(r.match, false, 'the right PIN works while locked');
    assert.strictEqual(r.locked_for, 25);
    assert.strictEqual((await p.handle({ action: 'status' })).locked_for, 25);
    t += 25000;
    assert.strictEqual(p.status().locked_for, 0);
    r = await p.handle({ action: 'check', pin: '0000' });
    assert.strictEqual(r.left, 2, 'locked tries were counted');
    await p.handle({ action: 'check', pin: '0000' });
    r = await p.handle({ action: 'check', pin: '0000' });
    assert.strictEqual(r.locked_for, 60, 'second lock');
    for (const want of [120, 240, 300, 300]) {
      t += 400000;
      r = await wrongThree();
      assert.strictEqual(r.locked_for, want);
    }
    t += 400000;
    assert.strictEqual((await p.handle({ action: 'check', pin: '5555' })).match, true);
    r = await wrongThree();
    assert.strictEqual(r.locked_for, 30, 'a right PIN starts the doubling again');
  });

  await check('tries sent at once are checked one at a time, so they cannot slip past the lock', async () => {
    const p = guestpin.create({ dataDir: tmp() });
    await p.set('9999');
    const all = await Promise.all([1, 2, 3, 4, 5, 6].map(() => p.handle({ action: 'check', pin: '1111' })));
    assert.ok(all[2].locked_for === 30 && all.slice(3).every((r) => r.locked_for > 0 && !r.match), JSON.stringify(all));
    assert.strictEqual((await p.handle({ action: 'check', pin: '9999' })).match, false, 'still locked');
  });

  await check('reset forgets the PIN and the lock; a damaged file counts as no PIN', async () => {
    const dir = tmp();
    const lines = [];
    const p = guestpin.create({ dataDir: dir, log: (s) => lines.push(s) });
    assert.strictEqual(p.reset(), false);
    await p.set('1212');
    for (let i = 0; i < 3; i++) await p.check('0000');
    assert.ok(p.status().locked_for > 0);
    assert.strictEqual(p.reset(), true);
    assert.deepStrictEqual(p.status(), { set: false, locked_for: 0 });
    assert.ok(!fs.existsSync(path.join(dir, 'guest-pin.json')));
    fs.writeFileSync(path.join(dir, 'guest-pin.json'), '{"v":1,"salt":"x"');
    assert.strictEqual(p.status().set, false);
    assert.ok(/damaged/.test(lines.join('\n')));
    await p.set('3434');
    assert.strictEqual((await p.check('3434')).match, true);
  });

  /* ---------- the server ---------- */

  const h = await start();
  const P = h.port;
  const tv = { Origin: 'http://127.0.0.1:8081', 'x-test-ip': '192.168.1.50' };
  try {
    await check('POST /guest/pin: no token from a home address with the TV\'s Origin; OPTIONS answered; outside or foreign Origin refused', async () => {
      let r = await request(P, 'OPTIONS', '/guest/pin', { headers: tv });
      assert.strictEqual(r.status, 204);
      assert.strictEqual(r.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
      assert.ok(/POST/.test(r.headers['access-control-allow-methods']));
      r = await request(P, 'GET', '/guest/pin', { headers: tv });
      assert.strictEqual(r.status, 405);
      r = await request(P, 'POST', '/guest/pin', { headers: Object.assign({}, tv, { 'x-test-ip': '8.8.8.8' }), body: { action: 'status' } });
      assert.strictEqual(r.status, 403);
      r = await request(P, 'POST', '/guest/pin', { headers: Object.assign({}, tv, { Origin: 'http://evil.example' }), body: { action: 'set', pin: '1234' } });
      assert.strictEqual(r.status, 403);
      r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'status' } });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(r.json, { ok: true, set: false, locked_for: 0 });
      assert.strictEqual(r.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
    });

    await check('it is a screen route: with HUB_TV_IPS set, another home address (a phone) is refused and only the TV gets in', async () => {
      let r;
      const h2 = await start({ tvIps: '192.168.1.50' });
      try {
        r = await request(h2.port, 'POST', '/guest/pin', { headers: Object.assign({}, tv, { 'x-test-ip': '192.168.1.77' }), body: { action: 'status' } });
        assert.strictEqual(r.status, 403, 'a phone on the LAN got in with HUB_TV_IPS set');
        r = await request(h2.port, 'POST', '/guest/pin', { headers: Object.assign({}, tv, { 'x-test-ip': '192.168.1.77' }), body: { action: 'check', pin: '1234' } });
        assert.strictEqual(r.status, 403);
        r = await request(h2.port, 'POST', '/guest/pin', { headers: tv, body: { action: 'status' } });
        assert.strictEqual(r.status, 200, 'the TV was refused: ' + r.text);
      } finally {
        await stop(h2);
      }
    });

    await check('create, right, wrong, bad input and the lock over HTTP; no PIN or hash in the log', async () => {
      let r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'set', pin: '8642' } });
      assert.strictEqual(r.status, 200, r.text);
      r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'set', pin: '1111' } });
      assert.strictEqual(r.status, 409);
      r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: '8642' } });
      assert.strictEqual(r.json.match, true);
      r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: 'abcd' } });
      assert.strictEqual(r.status, 400);
      for (let i = 0; i < 2; i++) {
        r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: '0000' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.match, false);
      }
      r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'check', pin: '0000' } });
      assert.strictEqual(r.json.locked_for, 30);
      const hash = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'guest-pin.json'), 'utf8')).hash;
      const log = h.lines.join('\n');
      assert.ok(!/8642|1111|0000|abcd/.test(log) && log.indexOf(hash) < 0, 'the log names a PIN or the hash');
      assert.ok(/guest PIN: 3 wrong tries in a row, locked for 30 s/.test(log), 'no lock line');
    });

    await check('GET /api/guest-pin and POST /api/guest-pin/reset need the token, never show the hash', async () => {
      let r = await request(P, 'GET', '/api/guest-pin');
      assert.strictEqual(r.status, 401);
      r = await request(P, 'GET', '/api/guest-pin', { token: TOKEN });
      assert.strictEqual(r.json.set, true);
      assert.ok(r.json.locked_for > 0);
      assert.ok(!/hash|salt/.test(r.text));
      r = await request(P, 'POST', '/api/guest-pin/reset', { token: TOKEN, body: {} });
      assert.deepStrictEqual(r.json, { ok: true, removed: true });
      r = await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'status' } });
      assert.deepStrictEqual(r.json, { ok: true, set: false, locked_for: 0 });
      r = await request(P, 'POST', '/api/guest-pin/reset', { token: TOKEN, body: {} });
      assert.deepStrictEqual(r.json, { ok: true, removed: false });
    });

    await check('./hub guest-pin status and reset talk to the server; the texts', async () => {
      await request(P, 'POST', '/guest/pin', { headers: tv, body: { action: 'set', pin: '1357' } });
      // Async: the server runs in this process, so a blocking spawn would never be answered.
      const run = (args) => new Promise((resolve) => {
        const c = childProcess.spawn(process.execPath, [path.join(__dirname, 'hubctl.js')].concat(args), {
          env: Object.assign({}, process.env, { HUB_TOKEN: TOKEN, HUB_URL: 'http://127.0.0.1:' + P })
        });
        const o = { stdout: '', stderr: '' };
        c.stdout.on('data', (d) => { o.stdout += d; });
        c.stderr.on('data', (d) => { o.stderr += d; });
        c.on('close', (code) => { o.status = code; resolve(o); });
      });
      let out = await run(['guest-pin', 'status']);
      assert.strictEqual(out.status, 0, out.stdout + out.stderr);
      assert.strictEqual(out.stdout.trim(), 'A Guest mode PIN is set.');
      out = await run(['guest-pin', 'reset']);
      assert.strictEqual(out.status, 0, out.stdout + out.stderr);
      assert.ok(/^Guest mode PIN forgotten\./.test(out.stdout.trim()), out.stdout);
      assert.ok(!fs.existsSync(path.join(h.dataDir, 'guest-pin.json')));
      out = await run(['guest-pin', 'zap']);
      assert.notStrictEqual(out.status, 0);
      assert.ok(/guest-pin status, guest-pin reset/.test(out.stdout + out.stderr));
      assert.ok(/Locked for 25 s/.test(hubctl.guestPinStatusText({ set: true, locked_for: 25 })));
      assert.ok(/^No Guest mode PIN was set/.test(hubctl.guestPinResetText({ removed: false })));
    });
  } finally {
    await stop(h);
  }

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
