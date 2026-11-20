/*
 * Tests for the TV remote from the Pi (tvremote.js). Run from the repo root with:
 *
 *   node pi/tvremote-test.js
 *
 * A fake TV stands in: a small WebSocket server built on net (the plain 8001
 * path; the TLS port is a closed one, so the fallback is tested too) and a
 * fake DIAL HTTP server. Waits are made tiny. Nothing leaves this computer.
 */
'use strict';

const net = require('net');
const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const tvremote = require('./tvremote');
const hubServer = require('./server');
const mailbox = require('./mailbox');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const TV_TOKEN = 'tvsecret12345678';
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tvremote-test-'));
  tmpDirs.push(d);
  return d;
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spare() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ---------- a fake TV ---------- */

// mode: 'allow' (sends a token), 'allow-notoken', 'deny', 'silent' (never answers).
async function fakeTv(mode) {
  const tv = { mode: mode || 'allow', paths: [], got: [], at: [], pings: 0, pongs: 0, closed: 0 };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let up = false;
    sock.on('error', () => {});
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!up) {
        const t = buf.toString('latin1');
        const end = t.indexOf('\r\n\r\n');
        if (end < 0) return;
        up = true;
        tv.paths.push(/^GET (\S+)/.exec(t)[1]);
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(t)[1];
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        buf = buf.slice(end + 4);
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        // A ping, and a long message (extended length), before the answer.
        sock.write(Buffer.from([0x89, 0x00]));
        tv.pings++;
        const junk = JSON.stringify({ event: 'ms.noise', data: 'x'.repeat(300) });
        const jb = Buffer.from(junk);
        sock.write(Buffer.concat([Buffer.from([0x81, 126, jb.length >> 8, jb.length & 255]), jb]));
        const send = (o) => { const b = Buffer.from(JSON.stringify(o)); sock.write(Buffer.concat([Buffer.from([0x81, b.length]), b])); };
        if (tv.mode === 'allow') send({ event: 'ms.channel.connect', data: { token: TV_TOKEN, clients: [] } });
        else if (tv.mode === 'allow-notoken') send({ event: 'ms.channel.connect', data: {} });
        else if (tv.mode === 'deny') send({ event: 'ms.channel.unauthorized' });
      }
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 15;
        let len = buf[1] & 127;
        let head = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); head = 4; }
        if (buf.length < head + 4 + len) return;
        assert.ok(buf[1] & 128, 'client frames must be masked');
        const mask = buf.slice(head, head + 4);
        const data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[head + 4 + i] ^ mask[i % 4];
        buf = buf.slice(head + 4 + len);
        if (opcode === 1) { tv.got.push(JSON.parse(data.toString('utf8'))); tv.at.push(Date.now()); }
        else if (opcode === 10) tv.pongs++;
        else if (opcode === 8) { tv.closed++; sock.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tv.port = server.address().port;
  tv.close = () => new Promise((r) => { server.close(r); server.closeAllConnections && 0; setTimeout(r, 50); });
  return tv;
}

async function fakeDial(status) {
  const d = { status: status || 201, reqs: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      d.reqs.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(d.status);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  d.port = server.address().port;
  d.close = () => new Promise((r) => { server.close(r); setTimeout(r, 50); });
  return d;
}

async function rig(mode, dialStatus, extra) {
  const tv = await fakeTv(mode);
  const dial = await fakeDial(dialStatus);
  const dead = await spare();
  const lines = [];
  const dir = tmpDir();
  const remote = tvremote.create(Object.assign({
    dataDir: dir, log: (s) => lines.push(s), host: '127.0.0.1', ports: { tls: dead, plain: tv.port, dial: dial.port },
    secondMs: 20, keyGapMs: 5, pairMs: 400, connectMs: 1000, dialMs: 1000
  }, extra || {}));
  return { tv: tv, dial: dial, lines: lines, dir: dir, remote: remote, file: path.join(dir, 'tvremote.json'),
    close: async () => { await tv.close(); await dial.close(); } };
}

const BASE = { id: 'netflix-2step-dial', appId: '3201907018807', link: 'dial', dialApp: 'Netflix', payload: 'm=https://www.netflix.com/watch/81505776&source_type=4' };

/* ---------- the server and ./hub ---------- */

function request(h, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: h.port, path: p, method: method,
      headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const authed = { Authorization: 'Bearer ' + TOKEN };

function hubctl(h, args) {
  return new Promise((resolve) => {
    const p = childProcess.spawn(process.execPath, [path.join(__dirname, 'hubctl.js')].concat(args), {
      env: Object.assign({}, process.env, { HUB_TOKEN: TOKEN, HUB_URL: 'http://127.0.0.1:' + h.port })
    });
    let stdout = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stdout += c; });
    p.on('close', (code) => resolve({ status: code, stdout: stdout }));
  });
}

async function mail(h, cmd, args) {
  const name = 'c' + Date.now() + Math.floor(Math.random() * 1000);
  const env = mailbox.checkEnvelope(name, Buffer.from(JSON.stringify({ id: name, created: new Date().toISOString(), cmd: cmd, args: args || {} })), Date.now());
  const call = async (method, route, body) => {
    const r = await h.api(method, route, body);
    if (!r.body || !r.body.ok) throw new Error('The server said no: ' + ((r.body && r.body.error) || r.status));
    return r.body;
  };
  return mailbox.COMMANDS[cmd].run(env.args, { call: call });
}

async function idle(h) {
  for (let i = 0; i < 100; i++) {
    const r = await request(h, 'GET', '/api/tvremote', undefined, authed);
    if (r.json && !r.json.running && r.json.last) return r.json;
    await sleep(50);
  }
  throw new Error('the run never finished');
}

/* ---------- the tests ---------- */

async function main() {
  await check('a request is checked: ids, waits, links, the DIAL allow-list, unknown fields, nothing to do', () => {
    const n = tvremote.normalizeSpec;
    const s = n(BASE);
    assert.deepStrictEqual([s.open, s.waitOpen, s.enter, s.waitAfter], [true, 10, true, 5]);
    assert.strictEqual(n({ id: 'x', appId: 'a.b_c', link: 'none', enter: false }).link, 'none');
    const no = (spec, re) => assert.throws(() => n(spec), (e) => e.status === 400 && re.test(e.message), JSON.stringify(spec).slice(0, 80));
    no(null, /object/);
    no(Object.assign({}, BASE, { id: 'bad id' }), /"id"/);
    no(Object.assign({}, BASE, { appId: 'a/b' }), /"appId"/);
    no(Object.assign({}, BASE, { waitOpen: 31 }), /waitOpen/);
    no(Object.assign({}, BASE, { waitAfter: -1 }), /waitAfter/);
    no(Object.assign({}, BASE, { waitAfter: '5' }), /waitAfter/);
    no(Object.assign({}, BASE, { link: 'magic' }), /"link"/);
    no(Object.assign({}, BASE, { payload: undefined }), /payload/);
    no(Object.assign({}, BASE, { payload: 'x'.repeat(301) }), /300/);
    no(Object.assign({}, BASE, { payload: 'a\nb' }), /control/);
    no(Object.assign({}, BASE, { dialApp: 'Hulu' }), /dialApp/);
    no(Object.assign({}, BASE, { dialApp: undefined }), /dialApp/);
    no(Object.assign({}, BASE, { cmd: 'rm' }), /not something/);
    no(Object.assign({}, BASE, { open: 'yes' }), /"open"/);
    no({ id: 'x', appId: 'a', link: 'deeplink', payload: 'p', dialApp: 'Netflix' }, /dialApp/);
    no({ id: 'x', appId: 'a', open: false, enter: false }, /nothing to do/);
  });

  await check('frames: extended lengths both ways, masking, pings answered, the line closed cleanly', () => {
    for (const n of [5, 125, 126, 300, 65535, 65536, 70000]) {
      const body = Buffer.alloc(n, 0x61);
      const f = tvremote.encodeFrame(1, body);
      assert.ok(f[1] & 128);
      const d = tvremote.decodeFrames(f); // the decoder also unmasks
      assert.strictEqual(d.frames.length, 1);
      assert.strictEqual(d.frames[0].data.length, n);
      assert.ok(d.frames[0].data.equals(body));
    }
    const two = Buffer.concat([Buffer.from([0x81, 2, 0x68, 0x69]), Buffer.from([0x81, 1])]);
    const d = tvremote.decodeFrames(two);
    assert.strictEqual(d.frames.length, 1);
    assert.strictEqual(d.rest.length, 2);
  });

  await check('first run: the TV asks to allow, the token is saved 0600, never logged or returned; the next run sends it', async () => {
    const r = await rig('allow');
    try {
      assert.strictEqual(r.remote.paired(), false);
      const a = r.remote.run({ id: 'p1', appId: '3201907018807', link: 'none', waitOpen: 0, waitAfter: 0 });
      assert.strictEqual(a.paired, false);
      const rec = await a.done;
      assert.strictEqual(rec.ok, true, JSON.stringify(rec));
      assert.strictEqual(r.remote.paired(), true);
      assert.ok(fs.existsSync(r.file));
      assert.strictEqual(fs.statSync(r.file).mode & 0o777, 0o600);
      assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).token, TV_TOKEN);
      assert.ok(!/token/.test(r.tv.paths[0]), 'no token on the first connect');
      assert.ok(/name=SG9tZSBIdWIgUGk=/.test(r.tv.paths[0]), r.tv.paths[0]);
      assert.ok(r.tv.pings === 1 && r.tv.pongs === 1, 'the ping was answered');
      assert.strictEqual(r.tv.closed, 1, 'closed cleanly');
      const st = JSON.stringify(r.remote.status()) + r.lines.join('\n');
      assert.ok(st.indexOf(TV_TOKEN) < 0, 'the token leaked');
      const b = r.remote.run({ id: 'p2', appId: '3201907018807', link: 'none', waitOpen: 0, waitAfter: 0 });
      assert.strictEqual(b.paired, true);
      await b.done;
      assert.ok(r.tv.paths[1].indexOf('&token=' + TV_TOKEN) > 0, 'the saved token is sent');
      // A new object reads the saved token back.
      const again = tvremote.create({ dataDir: r.dir, host: '127.0.0.1' });
      assert.strictEqual(again.paired(), true);
    } finally { await r.close(); }
  });

  await check('the TV says no: a clear message that names where to allow it; nothing is sent', async () => {
    const r = await rig('deny');
    try {
      const rec = await r.remote.run({ id: 'd1', appId: '3201907018807', link: 'none' }).done;
      assert.strictEqual(rec.ok, false);
      assert.ok(/The TV said no to Home Hub Pi/.test(rec.error) && /Device Connection Manager/.test(rec.error), rec.error);
      assert.strictEqual(r.tv.got.length, 0);
      assert.strictEqual(r.remote.paired(), false);
      assert.ok(r.lines.some((l) => /^tvremote: d1: could not connect$/.test(l)), r.lines.join('|'));
    } finally { await r.close(); }
  });

  await check('no answer to the Allow prompt: says so after the wait; an unreachable TV says so', async () => {
    const r = await rig('silent', 201, { pairMs: 150 });
    try {
      const rec = await r.remote.run({ id: 's1', appId: '3201907018807', link: 'none' }).done;
      assert.ok(!rec.ok && /Allow/.test(rec.error), rec.error);
    } finally { await r.close(); }
    const r2 = await rig('allow', 201, { ports: { tls: await spare(), plain: await spare(), dial: await spare() } });
    try {
      const rec = await r2.remote.run({ id: 's2', appId: '3201907018807', link: 'none' }).done;
      assert.ok(!rec.ok && /could not connect/.test(rec.error), rec.error);
    } finally { await r2.close(); }
  });

  await check('a TV that sends no token still works (nothing saved)', async () => {
    const r = await rig('allow-notoken');
    try {
      const rec = await r.remote.run({ id: 'n1', appId: '3201907018807', link: 'none', waitOpen: 0, waitAfter: 0 }).done;
      assert.strictEqual(rec.ok, true);
      assert.strictEqual(r.remote.paired(), false);
    } finally { await r.close(); }
  });

  await check('the sequence: launch, wait, Enter, wait, deep link, in that order with the waits between', async () => {
    const r = await rig('allow');
    try {
      const rec = await r.remote.run({ id: 'netflix-2step-watch', appId: '3201907018807', link: 'deeplink', payload: 'm=https://www.netflix.com/watch/1&source_type=4', waitOpen: 4, waitAfter: 2 }).done;
      assert.strictEqual(rec.ok, true, JSON.stringify(rec));
      assert.deepStrictEqual(rec.steps.map((s) => s.step), ['connect', 'open', 'wait', 'enter', 'wait', 'deeplink']);
      assert.ok(rec.steps.every((s) => s.ok && typeof s.ms === 'number'));
      assert.strictEqual(r.tv.got.length, 3);
      assert.deepStrictEqual(r.tv.got[0], { method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: '3201907018807', action_type: 'DEEP_LINK' } } });
      assert.deepStrictEqual(r.tv.got[1], { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_ENTER', Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
      assert.deepStrictEqual(r.tv.got[2].params.data, { appId: '3201907018807', action_type: 'DEEP_LINK', metaTag: 'm=https://www.netflix.com/watch/1&source_type=4' });
      assert.ok(r.tv.at[1] - r.tv.at[0] >= 70, 'waited about 4 x 20 ms: ' + (r.tv.at[1] - r.tv.at[0]));
      assert.ok(r.tv.at[2] - r.tv.at[1] >= 35, 'waited about 2 x 20 ms: ' + (r.tv.at[2] - r.tv.at[1]));
      assert.ok(r.lines.some((l) => /^tvremote: netflix-2step-watch: opened app \(ok\), Enter \(ok\), deep link \(ok\)$/.test(r.lines.join('|').split('|').pop())) || /opened app \(ok\), Enter \(ok\), deep link \(ok\)/.test(r.lines.join('|')), r.lines.join('|'));
      assert.ok(r.lines.join('').indexOf('netflix.com') < 0, 'the link is in the log');
    } finally { await r.close(); }
  });

  await check('options: no open, no Enter, no waits; a plain "none" link; the launch alone', async () => {
    const r = await rig('allow');
    try {
      let rec = await r.remote.run({ id: 'o1', appId: 'a1', open: false, enter: true, waitAfter: 0, link: 'deeplink', payload: 'p' }).done;
      assert.deepStrictEqual(rec.steps.map((s) => s.step), ['connect', 'enter', 'deeplink']);
      rec = await r.remote.run({ id: 'o2', appId: 'a1', enter: false, waitOpen: 0, link: 'none' }).done;
      assert.deepStrictEqual(rec.steps.map((s) => s.step), ['connect', 'open']);
      rec = await r.remote.run({ id: 'o3', appId: 'a1', open: false, enter: false, waitOpen: 0, waitAfter: 0, link: 'dial', dialApp: 'YouTube', payload: 'v=abc' }).done;
      assert.deepStrictEqual(rec.steps.map((s) => s.step), ['dial']);
      assert.strictEqual(r.dial.reqs[0].url, '/ws/apps/YouTube');
    } finally { await r.close(); }
  });

  await check('DIAL: POST to /ws/apps/Netflix as plain text, the status reported, a 404 is a failure; no link in the log', async () => {
    const r = await rig('allow', 201);
    try {
      const rec = await r.remote.run(Object.assign({}, BASE, { waitOpen: 1, waitAfter: 1 })).done;
      assert.strictEqual(rec.ok, true, JSON.stringify(rec));
      assert.deepStrictEqual(rec.steps.map((s) => s.step), ['connect', 'open', 'wait', 'enter', 'wait', 'dial']);
      assert.strictEqual(rec.steps[5].detail, 'HTTP 201');
      assert.deepStrictEqual(r.dial.reqs[0], { method: 'POST', url: '/ws/apps/Netflix', type: 'text/plain; charset=utf-8', body: BASE.payload });
      assert.ok(r.lines.some((l) => l === 'tvremote: netflix-2step-dial: opened app (ok), Enter (ok), DIAL Netflix -> HTTP 201'), r.lines.join('|'));
      r.dial.status = 404;
      const bad = await r.remote.run(Object.assign({}, BASE, { waitOpen: 0, waitAfter: 0 })).done;
      assert.strictEqual(bad.ok, false);
      assert.ok(/dial failed: HTTP 404/.test(bad.error), bad.error);
      assert.ok(r.lines[r.lines.length - 1].endsWith('DIAL Netflix -> HTTP 404'), r.lines[r.lines.length - 1]);
    } finally { await r.close(); }
  });

  await check('one run at a time: a second gets 409; after it ends a new one starts; no TV address is a clear 400', async () => {
    const r = await rig('allow');
    try {
      const a = r.remote.run({ id: 'a1', appId: 'a', link: 'none', waitOpen: 5, waitAfter: 0, enter: false });
      assert.throws(() => r.remote.run({ id: 'a2', appId: 'a', link: 'none' }), (e) => e.status === 409 && /already going/.test(e.message));
      assert.strictEqual(r.remote.status().running, true);
      await a.done;
      assert.strictEqual(r.remote.status().running, false);
      await r.remote.run({ id: 'a3', appId: 'a', link: 'none', waitOpen: 0, enter: false }).done;
      assert.strictEqual(r.remote.status().last.id, 'a3');
      const none = tvremote.create({ dataDir: r.dir });
      assert.throws(() => none.run({ id: 'x', appId: 'a', link: 'none' }), (e) => e.status === 400 && /TV's address/.test(e.message));
    } finally { await r.close(); }
  });

  await check('the TV address: the screen\'s, saved; HUB_TV_REMOTE_IP wins; loopback and junk are ignored', () => {
    const dir = tmpDir();
    const a = tvremote.create({ dataDir: dir });
    a.seen('::ffff:192.168.1.50');
    assert.strictEqual(a.address(), '192.168.1.50');
    a.seen('127.0.0.1');
    a.seen('not an ip');
    assert.strictEqual(a.address(), '192.168.1.50');
    a.seen('192.168.1.60', true);
    assert.strictEqual(a.address(), '192.168.1.50', 'only-if-unknown does not overwrite');
    assert.strictEqual(tvremote.create({ dataDir: dir }).address(), '192.168.1.50', 'kept over a restart');
    const b = tvremote.create({ dataDir: dir, host: '10.0.0.9' });
    assert.strictEqual(b.address(), '10.0.0.9');
    assert.strictEqual(b.status().hostFrom, 'HUB_TV_REMOTE_IP');
  });

  await check('server: POST /tvremote/run from the screen, GET /api/tvremote, ./hub tvremote, the mailbox; no token or link in logs', async () => {
    const tv = await fakeTv('allow');
    const dial = await fakeDial(201);
    const lines = [];
    const dir = tmpDir();
    const h = hubServer.start({
      port: 0, token: TOKEN, log: (s) => lines.push(s), dataDir: dir,
      tvremote: { allowLoopback: true, ports: { tls: await spare(), plain: tv.port, dial: dial.port }, secondMs: 10, keyGapMs: 5, pairMs: 500, connectMs: 1000 }
    });
    await h.ready;
    try {
      const spec = { id: 'netflix-2step-dial', appId: '3201907018807', link: 'dial', dialApp: 'Netflix', payload: 'm=https://www.netflix.com/watch/81505776&source_type=4', waitOpen: 2, waitAfter: 1 };
      let r = await request(h, 'GET', '/tvremote/run');
      assert.strictEqual(r.status, 405);
      r = await request(h, 'POST', '/tvremote/run', spec, { Origin: 'http://evil.example' });
      assert.strictEqual(r.status, 403);
      r = await request(h, 'POST', '/tvremote/run', Object.assign({}, spec, { dialApp: 'Hulu' }), { Origin: 'http://127.0.0.1:8081' });
      assert.strictEqual(r.status, 400);
      assert.ok(/dialApp/.test(r.json.error), r.json.error);
      r = await request(h, 'GET', '/api/tvremote');
      assert.strictEqual(r.status, 401);
      r = await request(h, 'POST', '/tvremote/run', spec, { Origin: 'http://127.0.0.1:8081' });
      assert.deepStrictEqual(r.json, { ok: true, started: true, paired: false });
      const second = await request(h, 'POST', '/tvremote/run', spec);
      assert.strictEqual(second.status, 409);
      let st = await idle(h);
      assert.strictEqual(st.paired, true);
      assert.strictEqual(st.last.ok, true, JSON.stringify(st.last));
      assert.strictEqual(st.last.steps.length, 6);
      assert.strictEqual(st.host, '127.0.0.1');
      assert.ok(JSON.stringify(st).indexOf(TV_TOKEN) < 0, 'the status holds the token');
      assert.strictEqual(dial.reqs.length, 1);
      // ./hub tvremote
      let out = await hubctl(h, ['tvremote']);
      assert.ok(/paired with the TV/.test(out.stdout) && /Last run \[netflix-2step-dial\] worked/.test(out.stdout) && /dial ok .*HTTP 201/.test(out.stdout), out.stdout);
      assert.ok(out.stdout.indexOf('127.0.0.1') < 0 && out.stdout.indexOf(TV_TOKEN) < 0);
      // ./hub tvremote run
      out = await hubctl(h, ['tvremote', 'run', JSON.stringify({ id: 'hub1', appId: 'a', link: 'none', waitOpen: 0, enter: false })]);
      assert.ok(/^Started\./.test(out.stdout), out.stdout);
      await idle(h);
      out = await hubctl(h, ['tvremote', 'run', 'nope']);
      assert.ok(/not valid JSON/.test(out.stdout), out.stdout);
      // the mailbox
      let m = await mail(h, 'tvremote.run', { id: 'mb1', appId: 'a', link: 'deeplink', payload: '{"values":"x"}', waitOpen: 0, waitAfter: 0 });
      assert.ok(/^Started mb1/.test(m.message) && m.data.paired === true, m.message);
      await idle(h);
      m = await mail(h, 'tvremote.status');
      assert.ok(/paired with the TV/.test(m.message) && m.data.paired === true && m.data.last.id === 'mb1', m.message);
      assert.ok(JSON.stringify(m).indexOf('127.0.0.1') < 0, 'the mailbox answer holds the TV address');
      await assert.rejects(() => mail(h, 'tvremote.run', { id: 'mb2', appId: 'a', extra: 1 }), /extra|not/);
      await assert.rejects(() => mail(h, 'tvremote.run', { id: 'mb2', appId: 'a', link: 'dial', dialApp: 'Hulu', payload: 'x' }), /dialApp/);
      const all = lines.join('\n');
      assert.ok(all.indexOf(TV_TOKEN) < 0 && all.indexOf('netflix.com') < 0 && all.indexOf('values') < 0, 'a log line holds a token or link');
      assert.ok(lines.some((l) => / tvremote: netflix-2step-dial: opened app \(ok\), Enter \(ok\), DIAL Netflix -> HTTP 201$/.test(l)), lines.filter((l) => /tvremote/.test(l)).join('|'));
    } finally {
      await new Promise((r) => h.close(r));
      await tv.close();
      await dial.close();
    }
  });

  console.log(passed + ' passed, ' + failed + ' failed');
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('FAIL (crashed) ' + (e && e.stack));
  process.exit(1);
});
