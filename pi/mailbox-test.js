/*
 * Tests for the Claude mailbox (mailbox.js). Run from the repo root with:
 *
 *   node pi/mailbox-test.js
 *
 * It starts a small fake R2 (S3) server on 127.0.0.1 that checks every
 * request's signature, starts the hub server with the mailbox pointed at it,
 * and drives the mailbox one poll at a time. Nothing leaves this computer.
 * It uses only what ships with Node, so there is nothing to install.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hubServer = require('./server');
const mailbox = require('./mailbox');
const hubctl = require('./hubctl');
const awws = require('./awws');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const KEY_ID = 'AKIDTESTKEYID0123456789';
const SECRET = 'SECRETtestValue/abcdefghijklmnopqrstuvwxyz0123';
const BUCKET = 'home-hub-mailbox';
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mailbox-test-'));
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

/* ---------- a fake R2 ---------- */

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startFakeR2(port) {
  const store = new Map(); // key -> { body: Buffer, lastModified: ms }
  const fake = {
    store: store,
    requests: [],
    faults: [],   // fn({ method, key, body }) -> true to answer 500 (the fault is removed after use if it returns 'once')
    badSignatures: 0,
    pageSize: 1000,
    port: null,
    sockets: new Set(),
    put: (key, value, lastModified) => {
      store.set(key, { body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), lastModified: lastModified || Date.now() });
    },
    json: (key) => (store.has(key) ? JSON.parse(store.get(key).body.toString('utf8')) : null),
    keys: (prefix) => Array.from(store.keys()).filter((k) => k.indexOf(prefix || '') === 0).sort()
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const parts = decodeURIComponent(url.pathname).split('/');
      const bucket = parts[1];
      const key = parts.slice(2).join('/');
      fake.requests.push({ method: req.method, key: key, query: url.search, headers: req.headers });
      // Check the signature the way R2 would.
      const auth = req.headers.authorization || '';
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
      let sigOk = false;
      if (m && m[1] === KEY_ID) {
        const headers = {};
        m[3].split(';').forEach((h) => { headers[h] = req.headers[h]; });
        const query = {};
        url.searchParams.forEach((v, k) => { query[k] = v; });
        const hash = crypto.createHash('sha256').update(body).digest('hex');
        const s = mailbox.signRequest({
          method: req.method, path: decodeURIComponent(url.pathname), query: query, headers: headers,
          payloadHash: req.headers['x-amz-content-sha256'], accessKeyId: KEY_ID, secretAccessKey: SECRET,
          region: 'auto', service: 's3', amzDate: req.headers['x-amz-date']
        });
        sigOk = s.signature === m[4] && hash === req.headers['x-amz-content-sha256'];
      }
      const send = (status, text, type) => {
        res.writeHead(status, { 'Content-Type': type || 'application/xml', 'Content-Length': Buffer.byteLength(text || '') });
        res.end(text || '');
      };
      if (!sigOk) {
        fake.badSignatures++;
        return send(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
      }
      if (bucket !== BUCKET) return send(404, '<Error><Code>NoSuchBucket</Code></Error>');
      for (let i = 0; i < fake.faults.length; i++) {
        const hit = fake.faults[i]({ method: req.method, key: key, body: body.toString('utf8') });
        if (hit) {
          if (hit === 'once') fake.faults.splice(i, 1);
          return send(500, '<Error><Code>InternalError</Code></Error>');
        }
      }
      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        const all = fake.keys(prefix);
        const start = Number(url.searchParams.get('continuation-token') || 0);
        const page = all.slice(start, start + fake.pageSize);
        const more = start + page.length < all.length;
        const xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>' + BUCKET + '</Name>' +
          page.map((k) => '<Contents><Key>' + xmlEscape(k) + '</Key><LastModified>' + new Date(store.get(k).lastModified).toISOString() +
            '</LastModified><Size>' + store.get(k).body.length + '</Size></Contents>').join('') +
          '<IsTruncated>' + more + '</IsTruncated>' + (more ? '<NextContinuationToken>' + (start + page.length) + '</NextContinuationToken>' : '') +
          '</ListBucketResult>';
        return send(200, xml);
      }
      if (req.method === 'GET') {
        if (!store.has(key)) return send(404, '<Error><Code>NoSuchKey</Code></Error>');
        const b = store.get(key).body;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length });
        return res.end(b);
      }
      if (req.method === 'PUT') {
        store.set(key, { body: body, lastModified: Date.now() });
        return send(200, '');
      }
      if (req.method === 'DELETE') {
        store.delete(key);
        return send(204, '');
      }
      return send(405, '');
    });
  });
  server.on('connection', (s) => { fake.sockets.add(s); s.on('close', () => fake.sockets.delete(s)); });
  fake.close = () => new Promise((r) => { server.close(r); fake.sockets.forEach((s) => s.destroy()); });
  return new Promise((resolve) => server.listen(port || 0, '127.0.0.1', () => { fake.port = server.address().port; resolve(fake); }));
}

/* ---------- helpers ---------- */

function mailboxEnv(fake, extra) {
  return Object.assign({
    HUB_MAILBOX_ENDPOINT: 'http://127.0.0.1:' + fake.port,
    HUB_MAILBOX_ACCESS_KEY_ID: KEY_ID,
    HUB_MAILBOX_SECRET_ACCESS_KEY: SECRET
  }, extra || {});
}

const allLogs = [];

async function startHub(fake, extra) {
  const lines = [];
  const opts = Object.assign({
    port: 0, token: TOKEN, dataDir: tmpDir(), mailboxEnv: mailboxEnv(fake), mailboxManual: true,
    log: (s) => { lines.push(s); allLogs.push(s); }
  }, extra || {});
  const h = hubServer.start(opts);
  await h.ready;
  h.lines = lines;
  return h;
}

const stopHub = (h) => new Promise((r) => h.close(r));

let idCounter = 0;
function newId() {
  idCounter++;
  return 'cmd' + Date.now().toString(36) + '-' + idCounter;
}

function envelope(cmd, args, over) {
  const id = (over && over.id) || newId();
  return Object.assign({ id: id, created: new Date().toISOString(), cmd: cmd, args: args || {} }, over || {});
}

// Drops a command in the inbox, polls once, and returns its outbox result.
async function run(fake, h, cmd, args, over) {
  const env = envelope(cmd, args, over);
  fake.put('inbox/' + env.id + '.json', env);
  await h.mailbox.pollOnce();
  return fake.json('outbox/' + env.id + '.json');
}

async function todoItems(h) {
  return (await h.api('GET', '/api/todo')).body.items;
}

/* ---------- the tests ---------- */

async function main() {
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  await check('SigV4: AWS documented GET Object example', () => {
    const r = mailbox.signRequest({
      method: 'GET', path: '/test.txt', query: {},
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' },
      payloadHash: EMPTY, accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET, region: 'us-east-1', service: 's3', amzDate: '20130524T000000Z'
    });
    assert.strictEqual(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.ok(r.authorization.indexOf('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,') > 0);
  });

  await check('SigV4: AWS documented ListObjects example (query string)', () => {
    const r = mailbox.signRequest({
      method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' },
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' },
      payloadHash: EMPTY, accessKeyId: AWS_KEY, secretAccessKey: AWS_SECRET, region: 'us-east-1', service: 's3', amzDate: '20130524T000000Z'
    });
    assert.strictEqual(r.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  await check('SigV4: AWS documented signing key example', () => {
    const k = mailbox.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
    assert.strictEqual(k.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });

  await check('settings: off when nothing is set, clear problem when half set, never echoes values', () => {
    assert.deepStrictEqual(mailbox.configFromEnv({}), { configured: false, problem: '' });
    const half = mailbox.configFromEnv({ HUB_MAILBOX_ENDPOINT: 'https://abc.r2.cloudflarestorage.com', HUB_MAILBOX_SECRET_ACCESS_KEY: SECRET });
    assert.strictEqual(half.configured, false);
    assert.ok(/HUB_MAILBOX_ACCESS_KEY_ID missing/.test(half.problem));
    assert.ok(half.problem.indexOf(SECRET) < 0);
    const http1 = mailbox.configFromEnv({ HUB_MAILBOX_ENDPOINT: 'http://abc.r2.cloudflarestorage.com', HUB_MAILBOX_ACCESS_KEY_ID: KEY_ID, HUB_MAILBOX_SECRET_ACCESS_KEY: SECRET });
    assert.strictEqual(http1.configured, false);
    assert.ok(/https/.test(http1.problem));
    const ok = mailbox.configFromEnv({ HUB_MAILBOX_ENDPOINT: 'https://abc.r2.cloudflarestorage.com/home-hub-mailbox/', HUB_MAILBOX_ACCESS_KEY_ID: KEY_ID, HUB_MAILBOX_SECRET_ACCESS_KEY: SECRET, HUB_MAILBOX_POLL_SECONDS: '1' });
    assert.strictEqual(ok.configured, true);
    assert.strictEqual(ok.bucket, 'home-hub-mailbox');
    assert.strictEqual(ok.url.host, 'abc.r2.cloudflarestorage.com');
    assert.strictEqual(ok.pollSeconds, 3);
    const def = mailbox.configFromEnv({ HUB_MAILBOX_ENDPOINT: 'https://abc.r2.cloudflarestorage.com', HUB_MAILBOX_ACCESS_KEY_ID: KEY_ID, HUB_MAILBOX_SECRET_ACCESS_KEY: SECRET });
    assert.strictEqual(def.pollSeconds, 10);
    assert.strictEqual(def.bucket, 'home-hub-mailbox');
    const wrong = mailbox.configFromEnv({ HUB_MAILBOX_ENDPOINT: 'https://abc.r2.cloudflarestorage.com/other', HUB_MAILBOX_BUCKET: 'home-hub-mailbox', HUB_MAILBOX_ACCESS_KEY_ID: KEY_ID, HUB_MAILBOX_SECRET_ACCESS_KEY: SECRET });
    assert.strictEqual(wrong.configured, false);
  });

  await check('not configured: the server logs one line and status says off', async () => {
    const lines = [];
    const h = hubServer.start({ port: 0, token: TOKEN, dataDir: tmpDir(), log: (s) => lines.push(s) });
    await h.ready;
    assert.strictEqual(h.mailbox, null);
    assert.strictEqual(lines.filter((l) => /Claude mailbox/.test(l)).length, 1);
    const st = (await h.api('GET', '/api/status')).body;
    assert.strictEqual(st.mailbox.configured, false);
    assert.ok(/off/.test(hubctl.mailboxLines(st.mailbox)[0]));
    await stopHub(h);
  });

  let fake = await startFakeR2();
  let h = await startHub(fake);

  /* --- happy path, every command --- */

  await check('first poll: connects, writes status.json, signatures all good', async () => {
    await h.mailbox.pollOnce();
    const info = h.mailbox.info();
    assert.strictEqual(info.connected, true);
    const st = fake.json('status.json');
    assert.strictEqual(st.version, hubServer.SERVER_VERSION);
    assert.strictEqual(st.screensListening, 0);
    assert.strictEqual(st.mailbox.pollSeconds, 10);
    assert.strictEqual(st.calendar.configured, false);
    assert.strictEqual(fake.badSignatures, 0);
    assert.ok(h.lines.some((l) => /Claude mailbox: connected to bucket home-hub-mailbox/.test(l)));
  });

  await check('ping', async () => {
    const r = await run(fake, h, 'ping');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.state, 'done');
    assert.strictEqual(r.data.version, hubServer.SERVER_VERSION);
    assert.ok(/Pong/.test(r.message));
    assert.ok(r.started && r.finished);
    assert.deepStrictEqual(fake.keys('inbox/'), []);
  });

  await check('show, home, say, reload (no screen on: same words as ./hub)', async () => {
    for (const [cmd, args] of [['show', { widget: 'weather', full: true }], ['show', { widget: 'calendar' }], ['home', {}], ['say', { text: '  Dinner in 10 ', seconds: 8 }], ['reload', {}]]) {
      const r = await run(fake, h, cmd, args);
      assert.strictEqual(r.ok, true, cmd);
      assert.strictEqual(r.message, 'Sent, but no screen is listening (is the TV on with Home Hub open?).');
      assert.deepStrictEqual(r.data, { delivered: 0 });
    }
  });

  await check('todo.add, todo.list, todo.done (title), todo.remove (id)', async () => {
    let r = await run(fake, h, 'todo.add', { title: 'Buy milk', section: 'next', due: '2026-12-24' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'Added "Buy milk" to Next, due 2026-12-24.');
    const id = r.data.item.id;
    r = await run(fake, h, 'todo.list');
    assert.strictEqual(r.message, 'Next:\n  [ ] Buy milk (due 2026-12-24)   id ' + id);
    assert.deepStrictEqual(r.data.items, [{ id: id, title: 'Buy milk', section: 'next', done: false, due: '2026-12-24' }]);
    r = await run(fake, h, 'todo.done', { title: 'buy milk' });
    assert.strictEqual(r.message, 'Ticked "Buy milk".');
    assert.strictEqual((await todoItems(h))[0].done, true);
    r = await run(fake, h, 'todo.remove', { id: id });
    assert.strictEqual(r.message, 'Removed "Buy milk".');
    assert.deepStrictEqual(await todoItems(h), []);
    r = await run(fake, h, 'todo.done', { title: 'Nope' });
    assert.strictEqual(r.ok, false);
    assert.ok(/No to-do has the id or title "Nope"/.test(r.message));
  });

  await check('todo.add with notes, todo.list shows them, todo.notes sets and clears them', async () => {
    const notes = 'Comprar leche de avena, no la de vaca. Preguntar por el pan sin gluten en la panadería de la esquina.';
    let r = await run(fake, h, 'todo.add', { title: 'Comprar leche', notes: '  ' + notes + '\n' });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(r.message, 'Added "Comprar leche" to Now, with notes.');
    assert.strictEqual(r.data.item.notes, notes);
    const id = r.data.item.id;
    r = await run(fake, h, 'todo.add', { title: 'Sin notas', notes: '' });
    assert.strictEqual(r.message, 'Added "Sin notas" to Now.');
    assert.ok(!('notes' in r.data.item));
    const plainId = r.data.item.id;
    r = await run(fake, h, 'todo.list');
    assert.strictEqual(r.message, 'Now:\n  [ ] Sin notas   id ' + plainId + '\n  [ ] Comprar leche   id ' + id + '\n      notes: ' + notes);
    assert.deepStrictEqual(r.data.items[1], { id: id, title: 'Comprar leche', section: 'now', done: false, notes: notes });
    assert.ok(!('notes' in r.data.items[0]));
    r = await run(fake, h, 'todo.notes', { title: 'sin notas', notes: 'Ahora sí' });
    assert.strictEqual(r.message, 'Notes on "Sin notas": Ahora sí');
    assert.strictEqual(r.data.notes, 'Ahora sí');
    r = await run(fake, h, 'todo.notes', { id: plainId, notes: null });
    assert.strictEqual(r.message, 'Removed the notes from "Sin notas".');
    r = await run(fake, h, 'todo.notes', { id: id, notes: '' });
    assert.strictEqual(r.message, 'Removed the notes from "Comprar leche".');
    assert.ok((await todoItems(h)).every((i) => !('notes' in i)));
    r = await run(fake, h, 'todo.notes', { title: 'Nope', notes: 'x' });
    assert.strictEqual(r.ok, false);
    await run(fake, h, 'todo.remove', { id: id });
    await run(fake, h, 'todo.remove', { id: plainId });
  });

  await check('calendar.status and calendar.refresh', async () => {
    let r = await run(fake, h, 'calendar.status');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'No calendars are set up yet. See pi/README.md.');
    assert.deepStrictEqual(r.data, { configured: false, calendars: [] });
    r = await run(fake, h, 'calendar.refresh');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'No calendars are set up yet. See pi/README.md.');
  });

  await check('layout.show, layout.set, layout.reset (server checks the layout)', async () => {
    let r = await run(fake, h, 'layout.show');
    assert.ok(/built-in layout/.test(r.message));
    assert.strictEqual(r.data.layout, null);
    const tiles = [{ widget: 'weather', x: 0, y: 0, w: 3, h: 2 }, { widget: 'todo', x: 3, y: 0, w: 3, h: 2 }];
    r = await run(fake, h, 'layout.set', { layout: tiles });
    assert.strictEqual(r.message, 'Layout saved (2 tiles). Screens that are on change now.');
    assert.deepStrictEqual((await h.api('GET', '/api/layout')).body.layout, tiles);
    r = await run(fake, h, 'layout.set', { layout: [{ widget: 'weather', x: 0, y: 0, w: 3, h: 2 }, { widget: 'todo', x: 1, y: 0, w: 3, h: 2 }] });
    assert.strictEqual(r.ok, false);
    assert.ok(/The server said no: the tile overlaps "weather"/.test(r.message));
    assert.deepStrictEqual((await h.api('GET', '/api/layout')).body.layout, tiles);
    r = await run(fake, h, 'layout.reset');
    assert.strictEqual(r.message, 'Back to the built-in layout. Screens that are on change now.');
  });

  const awwsSample = () => {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'awws-sample.json'), 'utf8'));
    s.sentAt = new Date(Date.now() - 60000).toISOString();
    return s;
  };

  await check('awws.show, awws.set, awws.clear: same words as ./hub, compact data', async () => {
    let r = await run(fake, h, 'awws.show');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'No A World Worth Saving snapshot yet. The TV tiles say "Not synced yet".');
    assert.deepStrictEqual(r.data, { sentAt: null, receivedAt: null, bytes: 0, sections: {} });
    const snap = awwsSample();
    r = await run(fake, h, 'awws.set', { snapshot: snap });
    assert.strictEqual(r.ok, true, r.message);
    assert.ok(/^Stored todos, handoffs, outreach, khaya, pipeline, money and reach \([\d.]+ KB of 48 KB\)\. Screens that are on change now\.$/.test(r.message), r.message);
    assert.deepStrictEqual(Object.keys(r.data), ['changed', 'bytes', 'accepted', 'cleared', 'rejected']);
    assert.strictEqual(r.data.changed, true);
    assert.strictEqual(r.data.accepted.length, 7);
    const stored = (await h.api('GET', '/api/awws')).body;
    assert.strictEqual(r.message, awws.setText(Object.assign({}, r.data)));
    assert.strictEqual(stored.data.sentAt, snap.sentAt);
    r = await run(fake, h, 'awws.show');
    assert.strictEqual(r.message, hubctl.awwsShowLines(stored).join('\n'));
    assert.ok(/^Snapshot sent .*\. [\d.]+ KB of 48 KB\.\n  todos     25 items/.test(r.message), r.message);
    assert.strictEqual(r.data.sentAt, snap.sentAt);
    assert.strictEqual(r.data.sections.todos.items, 25);
    assert.strictEqual(r.data.sections.khaya.total, 12);
    assert.strictEqual(r.data.bytes, Buffer.byteLength(JSON.stringify(stored.data)));
    const shown = JSON.stringify(r);
    assert.ok(shown.indexOf('Maple Grove') < 0 && shown.indexOf('Luma') < 0 && shown.indexOf('1840') < 0, 'no titles, names or amounts');
    r = await run(fake, h, 'awws.set', { snapshot: { v: 1, sentAt: new Date().toISOString(), money: { currency: 'usd', spent: 1, earned: 1 }, khaya: null } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.data.cleared, ['khaya']);
    assert.deepStrictEqual(r.data.rejected, [{ section: 'money', error: '"currency" must be three capital letters, like USD' }]);
    assert.ok(/\nRejected money: "currency" must be three capital letters, like USD\./.test(r.message), r.message);
    r = await run(fake, h, 'awws.set', { snapshot: { v: 1, sentAt: new Date().toISOString(), khaya: { done: 3, total: 2 } } });
    assert.strictEqual(r.ok, false);
    assert.ok(/^The server said no: nothing was stored, because every section was rejected: khaya: "done" \(3\)/.test(r.message), r.message);
    r = await run(fake, h, 'awws.clear');
    assert.strictEqual(r.ok, true);
    assert.ok(/^Cleared the A World Worth Saving snapshot \(todos, handoffs, outreach, pipeline, money and reach\)\./.test(r.message), r.message);
    assert.strictEqual(r.data.changed, true);
    r = await run(fake, h, 'awws.set', { snapshot: null });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'There is no A World Worth Saving snapshot to clear. Nothing changed.');
    assert.strictEqual(r.data.changed, false);
  });

  await check('awws.set: a snapshot near the 48 KB cap goes through the mailbox', async () => {
    const snap = { v: 1, sentAt: new Date().toISOString(), todos: { items: [] } };
    let i = 0;
    while (Buffer.byteLength(JSON.stringify(snap)) < 48 * 1024 - 400) {
      snap.todos.items.push({ id: 'n' + i, title: 'Near the cap ' + i + ' ' + 'q'.repeat(60), owner: 'both', section: 'later', stream: 'Books', due: 'Some day soon, after the school visits', waitingOn: 'w'.repeat(40) });
      i++;
      if (i >= 200) break;
    }
    const size = Buffer.byteLength(JSON.stringify(snap));
    assert.ok(size > 47 * 1024 && size <= 49152, 'size ' + size);
    const env = envelope('awws.set', { snapshot: snap });
    assert.ok(Buffer.byteLength(JSON.stringify(env)) < 64 * 1024);
    const r = await run(fake, h, 'awws.set', { snapshot: snap }, { id: env.id });
    assert.strictEqual(r.ok, true, r.message);
    assert.deepStrictEqual(r.data.accepted, ['todos']);
    const stored = (await h.api('GET', '/api/awws')).body.data;
    assert.strictEqual(stored.todos.items.length, snap.todos.items.length);
    await h.api('POST', '/api/awws', { snapshot: null });
  });

  await check('awws.set: "__proto__" and "constructor" keys in a snapshot do no harm', async () => {
    const id = newId();
    const text = '{"id":"' + id + '","created":"' + new Date().toISOString() + '","cmd":"awws.set","args":{"snapshot":' +
      '{"v":1,"sentAt":"' + new Date().toISOString() + '","__proto__":{"polluted":1},"constructor":{"prototype":{"bad":1}},' +
      '"khaya":{"done":1,"total":2,"__proto__":{"isAdmin":true}}}}}';
    fake.put('inbox/' + id + '.json', text);
    await h.mailbox.pollOnce();
    const r = fake.json('outbox/' + id + '.json');
    assert.strictEqual(r.ok, true, r.message);
    assert.deepStrictEqual(r.data.accepted, ['khaya']);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(({}).isAdmin, undefined);
    assert.strictEqual(({}).bad, undefined);
    const stored = (await h.api('GET', '/api/awws')).body.data;
    assert.strictEqual(JSON.stringify(stored).indexOf('__proto__'), -1);
    await h.api('POST', '/api/awws', { snapshot: null });
  });

  await check('status: same lines as ./hub status, with the mailbox line', async () => {
    const r = await run(fake, h, 'status');
    assert.strictEqual(r.ok, true);
    assert.ok(/^The server is running \(version /.test(r.message));
    assert.ok(/Claude mailbox: connected/.test(r.message));
    assert.strictEqual(r.data.screensListening, 0);
    const st = fake.json('status.json');
    assert.strictEqual(st.mailbox.lastCommandId, r.id);
  });

  await check('./hub mailbox status text', async () => {
    const st = (await h.api('GET', '/api/status')).body;
    const lines = hubctl.mailboxLines(st.mailbox);
    assert.ok(/^Claude mailbox: connected/.test(lines[0]));
    assert.ok(lines.some((l) => /Bucket home-hub-mailbox at 127\.0\.0\.1:\d+, checked every 10 seconds/.test(l)));
    assert.ok(lines.some((l) => /^Last command: status/.test(l)));
  });

  /* --- rejected --- */

  await check('rejected: bad file name, never run, answered as invalid-...', async () => {
    fake.put('inbox/a b.json', envelope('todo.add', { title: 'X' }, { id: 'a b' }));
    fake.put('inbox/abc.json', envelope('todo.add', { title: 'X' }, { id: 'abc' }));
    fake.put('inbox/sub/abcdefg.json', envelope('todo.add', { title: 'X' }, { id: 'abcdefg' }));
    await h.mailbox.pollOnce();
    assert.deepStrictEqual(fake.keys('inbox/'), []);
    const bad = fake.keys('outbox/invalid-');
    assert.strictEqual(bad.length, 3);
    bad.forEach((k) => { const r = fake.json(k); assert.strictEqual(r.ok, false); assert.ok(/file name/.test(r.message)); });
    assert.deepStrictEqual(await todoItems(h), []);
  });

  const rejects = [
    ['id not the file name', (id) => ({ raw: Object.assign(envelope('ping'), { id: id + 'x' }) }), /"id" must be the same as the file name/],
    ['larger than 64 KB', () => ({ raw: Object.assign(envelope('say', { text: 'x'.repeat(70000) })) }), /larger than 64 KB/],
    ['older than 24 hours', () => ({ raw: envelope('todo.add', { title: 'Old' }, { created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }) }), /older than 24 hours/],
    ['created in the future', () => ({ raw: envelope('todo.add', { title: 'Future' }, { created: new Date(Date.now() + 10 * 60 * 1000).toISOString() }) }), /in the future/],
    ['created missing', () => ({ raw: { cmd: 'ping', args: {} } }), /"created" must be an ISO time/],
    ['unknown command', () => ({ raw: envelope('shell', { line: 'rm -rf /' }) }), /unknown command "shell"/],
    ['unknown top-level field', () => ({ raw: Object.assign(envelope('ping'), { note: 'hi' }) }), /unknown field "note"/],
    ['not JSON', () => ({ text: '{ nope' }), /not valid JSON/],
    ['args not an object', () => ({ raw: envelope('say', ['hi']) }), /"args" must be an object/],
    ['unknown arg', () => ({ raw: envelope('ping', { extra: 1 }) }), /does not take "extra"/],
    ['widget not in the list', () => ({ raw: envelope('show', { widget: 'mirror' }) }), /"widget" must be one of: weather, todo, calendar, entertainment/],
    ['say text too long', () => ({ raw: envelope('say', { text: 'x'.repeat(141) }) }), /longer than 140/],
    ['say seconds out of range', () => ({ raw: envelope('say', { text: 'hi', seconds: 600 }) }), /"seconds" must be a number from 1 to 60/],
    ['todo.add missing title', () => ({ raw: envelope('todo.add', {}) }), /needs "title"/],
    ['todo.add bad section', () => ({ raw: envelope('todo.add', { title: 'A', section: 'later' }) }), /"section" must be one of/],
    ['todo.done with id and title', () => ({ raw: envelope('todo.done', { id: 'abc', title: 'A' }) }), /exactly one/],
    ['todo.add notes too long', () => ({ raw: envelope('todo.add', { title: 'A', notes: 'n'.repeat(301) }) }), /"notes" is longer than 300 characters/],
    ['todo.add notes not text', () => ({ raw: envelope('todo.add', { title: 'A', notes: 5 }) }), /"notes" must be text/],
    ['todo.notes without notes', () => ({ raw: envelope('todo.notes', { title: 'A' }) }), /needs "notes"/],
    ['todo.add with "note" (singular)', () => ({ raw: envelope('todo.add', { title: 'A', note: 'x' }) }), /does not take "note"/],
    ['layout.set not a list', () => ({ raw: envelope('layout.set', { layout: 'big' }) }), /"layout" must be a list/],
    ['full not a boolean', () => ({ raw: envelope('show', { widget: 'todo', full: 'yes' }) }), /"full" must be true or false/],
    ['awws.set without a snapshot', () => ({ raw: envelope('awws.set', {}) }), /"awws\.set" needs "snapshot"/],
    ['awws.set snapshot not an object', () => ({ raw: envelope('awws.set', { snapshot: [1, 2] }) }), /"snapshot" must be an object/],
    ['awws.set snapshot nested too deep', () => ({ raw: envelope('awws.set', { snapshot: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } } }) }), /nested more than 8 levels deep/],
    ['awws.set over 64 KB', () => ({ raw: envelope('awws.set', { snapshot: { v: 1, sentAt: new Date().toISOString(), todos: { items: [], pad: 'x'.repeat(66 * 1024) } } }) }), /larger than 64 KB/],
    ['awws.show with args', () => ({ raw: envelope('awws.show', { full: true }) }), /"awws\.show" does not take "full" \(it takes no args\)/]
  ];
  for (const [name, make, re] of rejects) {
    await check('rejected: ' + name, async () => {
      const id = newId();
      const m = make(id);
      let text = m.text;
      if (m.raw) {
        if (!('id' in m.raw)) m.raw.id = id;
        else if (m.raw.id !== id + 'x') m.raw.id = id;
        text = JSON.stringify(m.raw);
      }
      fake.put('inbox/' + id + '.json', text);
      const before = fake.requests.length;
      await h.mailbox.pollOnce();
      const r = fake.json('outbox/' + id + '.json');
      assert.ok(r, 'an outbox result exists');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.id, id);
      assert.ok(re.test(r.message), r.message);
      assert.ok(/^Rejected: .*Not run\.$/.test(r.message), r.message);
      assert.ok(!fake.store.has('inbox/' + id + '.json'));
      assert.deepStrictEqual(await todoItems(h), []);
      // no "running" claim was written for a rejected file
      const puts = fake.requests.slice(before).filter((q) => q.method === 'PUT' && q.key === 'outbox/' + id + '.json');
      assert.strictEqual(puts.length, 1);
    });
  }

  /* --- order and limits --- */

  await check('oldest "created" first, whatever the upload order', async () => {
    const a = envelope('todo.add', { title: 'Second' }, { created: new Date(Date.now() - 1000).toISOString() });
    const b = envelope('todo.add', { title: 'First' }, { created: new Date(Date.now() - 60000).toISOString() });
    fake.put('inbox/' + a.id + '.json', a, Date.now() - 5000);
    fake.put('inbox/' + b.id + '.json', b, Date.now() - 1000);
    await h.mailbox.pollOnce();
    // ./hub todo add puts new items on top, so the last one run is first.
    assert.deepStrictEqual((await todoItems(h)).map((i) => i.title), ['Second', 'First']);
    await h.api('POST', '/api/todo/ops', { ops: (await todoItems(h)).map((i) => ({ op: 'remove', id: i.id })) });
  });

  await check('at most 20 commands per poll; the rest next time', async () => {
    const ids = [];
    for (let i = 0; i < 25; i++) {
      const e = envelope('ping');
      ids.push(e.id);
      fake.put('inbox/' + e.id + '.json', e, Date.now() - 1000 + i);
    }
    await h.mailbox.pollOnce();
    assert.strictEqual(fake.keys('inbox/').length, 5);
    await h.mailbox.pollOnce();
    assert.strictEqual(fake.keys('inbox/').length, 0);
    ids.forEach((id) => assert.strictEqual(fake.json('outbox/' + id + '.json').ok, true));
  });

  await check('list pages are followed (small pages)', async () => {
    fake.pageSize = 3;
    const ids = [];
    for (let i = 0; i < 7; i++) {
      const e = envelope('ping');
      ids.push(e.id);
      fake.put('inbox/' + e.id + '.json', e);
    }
    await h.mailbox.pollOnce();
    fake.pageSize = 1000;
    ids.forEach((id) => assert.strictEqual(fake.json('outbox/' + id + '.json').ok, true));
  });

  /* --- never twice --- */

  await check('outbox write fails: the command is not run again, the result is written later', async () => {
    const e = envelope('todo.add', { title: 'Only once' });
    const okey = 'outbox/' + e.id + '.json';
    fake.faults.push((q) => q.method === 'PUT' && q.key === okey && /"state": "done"/.test(q.body));
    fake.put('inbox/' + e.id + '.json', e);
    await h.mailbox.pollOnce();
    assert.strictEqual(fake.json(okey).state, 'running');
    assert.strictEqual(h.mailbox.info().pendingResults, 1);
    assert.strictEqual(h.mailbox.info().connected, false);
    await h.mailbox.pollOnce(); // still failing
    await h.mailbox.pollOnce();
    assert.strictEqual((await todoItems(h)).filter((i) => i.title === 'Only once').length, 1);
    fake.faults = [];
    await h.mailbox.pollOnce();
    const r = fake.json(okey);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.message, 'Added "Only once" to Now.');
    assert.ok(!fake.store.has('inbox/' + e.id + '.json'));
    assert.strictEqual(h.mailbox.info().pendingResults, 0);
    await h.mailbox.pollOnce();
    assert.strictEqual((await todoItems(h)).filter((i) => i.title === 'Only once').length, 1);
  });

  await check('claim write fails: nothing runs until it can be claimed', async () => {
    const e = envelope('todo.add', { title: 'Claim first' });
    const okey = 'outbox/' + e.id + '.json';
    fake.faults.push((q) => (q.method === 'PUT' && q.key === okey ? 'once' : false));
    fake.put('inbox/' + e.id + '.json', e);
    await h.mailbox.pollOnce();
    assert.strictEqual((await todoItems(h)).filter((i) => i.title === 'Claim first').length, 0);
    await h.mailbox.pollOnce();
    assert.strictEqual((await todoItems(h)).filter((i) => i.title === 'Claim first').length, 1);
    assert.strictEqual(fake.json(okey).ok, true);
  });

  await check('a server that died mid-command: the old "running" result is closed, never run again', async () => {
    const e = envelope('todo.add', { title: 'Interrupted' });
    fake.put('inbox/' + e.id + '.json', e);
    fake.put('outbox/' + e.id + '.json', { id: e.id, cmd: 'todo.add', ok: null, state: 'running', message: 'Running.', started: new Date().toISOString() });
    await h.mailbox.pollOnce();
    const r = fake.json('outbox/' + e.id + '.json');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.state, 'done');
    assert.ok(/may or may not have happened/.test(r.message));
    assert.ok(!fake.store.has('inbox/' + e.id + '.json'));
    assert.strictEqual((await todoItems(h)).filter((i) => i.title === 'Interrupted').length, 0);
  });

  await check('an inbox file whose result already exists is only tidied', async () => {
    const e = envelope('todo.add', { title: 'Done before' });
    fake.put('outbox/' + e.id + '.json', { id: e.id, cmd: 'todo.add', ok: true, state: 'done', message: 'x' });
    fake.put('inbox/' + e.id + '.json', e);
    await h.mailbox.pollOnce();
    assert.ok(!fake.store.has('inbox/' + e.id + '.json'));
    assert.strictEqual(fake.json('outbox/' + e.id + '.json').message, 'x');
    assert.strictEqual((await todoItems(h)).filter((i) => i.title === 'Done before').length, 0);
  });

  /* --- network --- */

  await check('R2 unreachable: the server keeps running, logs once, recovers and logs once', async () => {
    const port = fake.port;
    const old = fake;
    await fake.close();
    const mark = h.lines.length;
    for (let i = 0; i < 4; i++) await h.mailbox.pollOnce();
    const info = h.mailbox.info();
    assert.strictEqual(info.connected, false);
    assert.ok(/network problem|ECONNREFUSED/.test(info.lastError), info.lastError);
    const fresh = h.lines.slice(mark);
    assert.strictEqual(fresh.filter((l) => /cannot reach R2/.test(l)).length, 1, fresh.join('\n'));
    assert.strictEqual((await h.api('GET', '/api/status')).status, 200);
    assert.ok(/NOT connected/.test(hubctl.mailboxLines((await h.api('GET', '/api/status')).body.mailbox)[0]));
    fake = await startFakeR2(port);
    old.store.forEach((v, k) => fake.store.set(k, v));
    const r = await run(fake, h, 'ping');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(h.mailbox.info().connected, true);
    assert.strictEqual(h.lines.slice(mark).filter((l) => /connected again after 4 failed tries/.test(l)).length, 1);
  });

  await check('a wrong secret key: refused by R2, reported plainly', async () => {
    const h2 = await startHub(fake, { mailboxEnv: mailboxEnv(fake, { HUB_MAILBOX_SECRET_ACCESS_KEY: 'wrong-secret-value-123' }) });
    await h2.mailbox.pollOnce();
    assert.strictEqual(h2.mailbox.info().lastError, 'R2 answered HTTP 403 SignatureDoesNotMatch');
    assert.ok(h2.lines.every((l) => l.indexOf('wrong-secret-value-123') < 0));
    await stopHub(h2);
    fake.badSignatures = 0;
  });

  /* --- pruning --- */

  await check('prune: outbox older than 7 days and inbox strays older than 24 h go', async () => {
    const h2 = await startHub(fake);
    fake.put('outbox/oldresult1.json', { id: 'oldresult1' }, Date.now() - 8 * 24 * 3600 * 1000);
    fake.put('outbox/newresult1.json', { id: 'newresult1' }, Date.now() - 6 * 24 * 3600 * 1000);
    await h2.mailbox.pollOnce();
    assert.ok(!fake.store.has('outbox/oldresult1.json'));
    assert.ok(fake.store.has('outbox/newresult1.json'));
    await stopHub(h2);
  });

  /* --- restart --- */

  await check('restart: result written and inbox cleared before the server stops', async () => {
    let restarted = 0;
    let resultAtRestart = null;
    const e = envelope('restart');
    const h2 = await startHub(fake, {
      onRestart: () => { restarted++; resultAtRestart = fake.json('outbox/' + e.id + '.json'); }
    });
    fake.put('inbox/' + e.id + '.json', e);
    await h2.mailbox.pollOnce();
    assert.strictEqual(restarted, 1);
    assert.strictEqual(resultAtRestart.ok, true);
    assert.ok(/Restarting now/.test(resultAtRestart.message));
    assert.ok(!fake.store.has('inbox/' + e.id + '.json'));
    assert.strictEqual(fake.json('status.json').mailbox.lastCommandId, e.id);
    await stopHub(h2);
  });

  await check('restart without a way to restart: says so, ok false', async () => {
    const r = await run(fake, h, 'restart');
    assert.strictEqual(r.ok, false);
    assert.ok(/cannot restart itself/.test(r.message));
  });

  /* --- secrets --- */

  await check('secrets never in logs, bucket objects, or status answers', async () => {
    const st = JSON.stringify((await h.api('GET', '/api/status')).body);
    const lines = hubctl.mailboxLines((await h.api('GET', '/api/status')).body.mailbox).join('\n');
    const objects = Array.from(fake.store.values()).map((v) => v.body.toString('utf8')).join('\n');
    for (const secret of [SECRET, KEY_ID, TOKEN]) {
      assert.ok(allLogs.every((l) => l.indexOf(secret) < 0), 'log');
      assert.ok(st.indexOf(secret) < 0, 'status');
      assert.ok(lines.indexOf(secret) < 0, 'hub mailbox status');
      assert.ok(objects.indexOf(secret) < 0, 'bucket');
    }
    assert.strictEqual(fake.badSignatures, 0);
  });

  await stopHub(h);
  await fake.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
