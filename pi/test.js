/*
 * Tests for the Home Hub live server. Run from the repo root with:
 *
 *   node pi/test.js
 *
 * It starts the server on a free port with a throwaway data folder, talks to
 * it over real HTTP, and prints one line per check, then "N passed, 0 failed".
 * It uses only what ships with Node, so there is nothing to install.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const hubServer = require('./server');
const awws = require('./awws');
const logscrub = require('./logscrub');
const hubctl = require('./hubctl');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const APP_BUILD = (/var BUILD = 'v([\d.]+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'app', 'hub.js'), 'utf8')) || [])[1];
const NO_CALENDAR = { configured: false, calendars: 0, timer: false, refreshing: false };
const NO_SPOTIFY = { timer: false, fails: 0, signedIn: false, pending: false, delay: 0, vibe: { busy: null, queued: null, kept: 0, lookups: 0, waitUntil: 0 } };
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
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
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, p, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    let body = null;
    if (o.raw !== undefined) body = Buffer.from(o.raw);
    else if (o.body !== undefined) body = Buffer.from(JSON.stringify(o.body));
    if (body) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = body.length;
    }
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

// A tiny Server-Sent Events reader.
function openEvents(port, headers) {
  return new Promise((resolve, reject) => {
    const events = [];
    const raw = { text: '' };
    const req = http.get({ host: '127.0.0.1', port: port, path: '/live/events', headers: headers || {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw.text += c;
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          block.split('\n').forEach((line) => {
            if (line.indexOf('event: ') === 0) ev.event = line.slice(7);
            else if (line.indexOf('data: ') === 0) ev.data = JSON.parse(line.slice(6));
            else if (line.indexOf('retry: ') === 0) ev.retry = Number(line.slice(7));
          });
          events.push(ev);
        }
      });
      resolve({
        res: res,
        events: events,
        raw: raw,
        close: () => req.destroy(),
        waitFor: async (pred, ms) => {
          const end = Date.now() + (ms || 2000);
          while (Date.now() < end) {
            const hit = events.find(pred);
            if (hit) return hit;
            await sleep(10);
          }
          throw new Error('event did not arrive');
        }
      });
    });
    req.on('error', reject);
  });
}

function start(extra) {
  const opts = Object.assign({ port: 0, token: TOKEN, log: false, dataDir: tmpDir() }, extra || {});
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.dataDir = opts.dataDir; return h; });
}

const stop = (h) => new Promise((r) => h.close(r));

async function waitUntil(fn, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('condition not met in time');
}

async function main() {
  /* ---------- pure helpers ---------- */

  await check('address classifier: private and loopback addresses allowed', () => {
    ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.9.9', '127.0.0.1',
      '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', '::ffff:192.168.1.5', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
      '100.64.0.1', '100.101.102.103', '100.127.255.254', '::ffff:100.100.1.1', 'fd7a:115c:a1e0::1']
      .forEach((a) => assert.strictEqual(hubServer.isPrivateAddress(a), true, a));
  });

  await check('address classifier: public addresses refused', () => {
    ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '1.1.1.1', '2001:db8::1', '::ffff:8.8.8.8', '', 'nonsense', '::', '999.1.1.1',
      '100.63.255.255', '100.128.0.1']
      .forEach((a) => assert.strictEqual(hubServer.isPrivateAddress(a), false, a));
  });

  await check('screen allow-list with HUB_TV_IPS: only those plus loopback', () => {
    const list = ['192.168.1.50'];
    assert.strictEqual(hubServer.screenAllowed('192.168.1.50', list), true);
    assert.strictEqual(hubServer.screenAllowed('::ffff:192.168.1.50', list), true);
    assert.strictEqual(hubServer.screenAllowed('127.0.0.1', list), true);
    assert.strictEqual(hubServer.screenAllowed('::1', list), true);
    assert.strictEqual(hubServer.screenAllowed('192.168.1.51', list), false);
  });

  await check('.env parser: comments, quotes, export, inline notes', () => {
    const env = hubServer.parseEnv('# note\nHUB_TOKEN="abc def"\nHUB_PORT=9000  # main\nexport HUB_X=\'q\'\nBROKEN LINE\n\nHUB_EMPTY=\n');
    assert.deepStrictEqual(env, { HUB_TOKEN: 'abc def', HUB_PORT: '9000', HUB_X: 'q', HUB_EMPTY: '' });
  });

  /* ---------- state file ---------- */

  let dir = tmpDir();
  let h = await start({ dataDir: dir });
  let epoch;
  await check('state file is created on first run with an epoch and rev 0', () => {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.ok(typeof st.epoch === 'string' && st.epoch.length >= 4);
    assert.strictEqual(st.rev, 0);
    assert.deepStrictEqual(st.resources.todo.data.items, []);
    assert.deepStrictEqual(st.resources.calendar, { rev: 0, data: { configured: false, calendars: [], events: [] } });
    epoch = st.epoch;
  });
  await request(h.port, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Keep me' } });
  await stop(h);
  h = await start({ dataDir: dir });
  await check('rev, epoch and items survive a restart', async () => {
    const r = await request(h.port, 'GET', '/live/state');
    assert.strictEqual(r.json.epoch, epoch);
    assert.strictEqual(r.json.rev, 1);
    assert.strictEqual(r.json.resources.todo.data.items[0].title, 'Keep me');
    assert.strictEqual(r.json.resources.calendar.data.configured, false);
    assert.ok(!fs.readdirSync(dir).some((f) => f.indexOf('.tmp') >= 0), 'no temp file left');
  });
  await stop(h);

  await check('a damaged state file is moved aside and a fresh one started', async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'state.json'), '{ this is not json');
    const lines = [];
    const h2 = await start({ dataDir: d, log: (s) => lines.push(s) });
    const r = await request(h2.port, 'GET', '/live/state');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.rev, 0);
    assert.ok(fs.readdirSync(d).some((f) => /^state\.bad-.*\.json$/.test(f)));
    assert.ok(lines.some((l) => /damaged/.test(l)));
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ epoch: 5 }));
    await stop(h2);
    const h3 = await start({ dataDir: d });
    assert.strictEqual((await request(h3.port, 'GET', '/live/state')).json.rev, 0);
    assert.strictEqual(fs.readdirSync(d).filter((f) => /^state\.bad-/.test(f)).length >= 1, true);
    await stop(h3);
  });

  /* ---------- control API ---------- */

  h = await start({ pingInterval: 150, pollWait: 400, commandTtl: 300 });
  const P = h.port;

  await check('/health answers without a token', async () => {
    const r = await request(P, 'GET', '/health');
    assert.deepStrictEqual(r.json, { ok: true, server: hubServer.SERVER_VERSION, app: APP_BUILD });
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  });

  await check('/health and /api/status: app is the BUILD of the hub.js served, read again after a change', async () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(APP_BUILD), APP_BUILD);
    assert.strictEqual((await request(P, 'GET', '/api/status', { token: TOKEN })).json.app, APP_BUILD);
    const dir = tmpDir();
    const file = path.join(dir, 'hub.js');
    fs.writeFileSync(file, "  var BUILD = 'v1.2.3';\n");
    const h3 = await start({ appDir: dir });
    try {
      assert.strictEqual((await request(h3.port, 'GET', '/health')).json.app, '1.2.3');
      fs.writeFileSync(file, "  var BUILD = 'v1.20.30';\n");
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
      assert.strictEqual((await request(h3.port, 'GET', '/api/status', { token: TOKEN })).json.app, '1.20.30');
      fs.unlinkSync(file);
      assert.strictEqual((await request(h3.port, 'GET', '/health')).json.app, '');
    } finally { await stop(h3); }
  });

  await check('control API: missing token is 401 "wrong token"', async () => {
    const r = await request(P, 'GET', '/api/status');
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(r.json, { ok: false, error: 'wrong token' });
  });

  await check('control API: wrong token (same and different length) is 401', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/status', { token: 'nope' })).status, 401);
    const same = TOKEN.slice(0, -1) + (TOKEN.slice(-1) === 'x' ? 'y' : 'x');
    assert.strictEqual((await request(P, 'GET', '/api/status', { token: same })).status, 401);
    assert.strictEqual((await request(P, 'GET', '/api/status', { headers: { Authorization: TOKEN } })).status, 401);
  });

  await check('GET /api/status: version, rev, epoch, uptime, screens; no token in it', async () => {
    const r = await request(P, 'GET', '/api/status', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.server, hubServer.SERVER_VERSION);
    assert.strictEqual(typeof r.json.rev, 'number');
    assert.strictEqual(typeof r.json.epoch, 'string');
    assert.strictEqual(typeof r.json.uptime, 'number');
    assert.deepStrictEqual(r.json.screens, []);
    assert.deepStrictEqual(r.json.calendar, { configured: false, calendars: 0, lastRefresh: null });
    assert.ok(r.text.indexOf(TOKEN) < 0);
  });

  await check('calendar calls need the token; with nothing set up they answer configured false', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/calendar')).status, 401);
    assert.strictEqual((await request(P, 'POST', '/api/calendar/refresh')).status, 401);
    const g = await request(P, 'GET', '/api/calendar', { token: TOKEN });
    assert.deepStrictEqual(g.json, { ok: true, rev: 0, data: { configured: false, calendars: [], events: [] } });
    const r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.deepStrictEqual(r.json, { ok: true, done: true, changed: false, calendars: [] });
    assert.strictEqual((await request(P, 'GET', '/api/calendar/refresh', { token: TOKEN })).status, 405);
  });

  await check('control API: unknown call 404, wrong method 405, invalid JSON 400', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/nothing', { token: TOKEN })).status, 404);
    const m = await request(P, 'GET', '/api/command', { token: TOKEN });
    assert.strictEqual(m.status, 405);
    assert.strictEqual(m.headers.allow, 'POST');
    const j = await request(P, 'POST', '/api/command', { token: TOKEN, raw: '{bad json' });
    assert.strictEqual(j.status, 400);
    assert.ok(/JSON/.test(j.json.error));
    assert.strictEqual((await request(P, 'GET', '/nowhere')).status, 404);
  });

  await check('body over 8 KB is 413', async () => {
    const r = await request(P, 'POST', '/api/todo', { token: TOKEN, raw: JSON.stringify({ title: 'x'.repeat(9000) }) });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.json.ok, false);
  });

  await check('commands: bad type and bad data are 400 with a clear error', async () => {
    let r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'dance' } });
    assert.strictEqual(r.status, 400);
    assert.ok(/unknown command/.test(r.json.error));
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'show', data: {} } });
    assert.strictEqual(r.status, 400);
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'show', data: { widget: 'weather', mode: 'huge' } } });
    assert.strictEqual(r.status, 400);
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'say', data: { text: 'x'.repeat(141) } } });
    assert.strictEqual(r.status, 400);
    assert.ok(/140/.test(r.json.error));
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'say', data: { text: 'hi', seconds: 'ten' } } });
    assert.strictEqual(r.status, 400);
    for (const url of [undefined, '', 'ftp://example.com/a.mp3', 'javascript:alert(1)', 'https://a b.mp3', 'https://x/' + 'a'.repeat(2048)]) {
      r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'play', data: { url: url } } });
      assert.strictEqual(r.status, 400, String(url).slice(0, 40));
    }
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'play', data: { url: 'https://example.com/a.mp3', title: 't'.repeat(141) } } });
    assert.strictEqual(r.status, 400);
    assert.ok(/140/.test(r.json.error));
  });

  await check('play and stop pass the checks; play keeps the address and a cleaned title', async () => {
    let r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'play', data: { url: ' https://example.com/a.mp3?x=1 ', title: ' Doorbell\n ' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.delivered, 0);
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'play', data: { url: 'http://example.com/a.mp3' } } });
    assert.strictEqual(r.status, 200);
    r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'stop' } });
    assert.strictEqual(r.status, 200);
  });

  await check('a command with no screens: delivered 0 at once, nothing kept', async () => {
    const t0 = Date.now();
    const r = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'show', data: { widget: 'weather' } } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, delivered: 0 });
    assert.ok(Date.now() - t0 < 500);
    for (const type of ['home', 'reload']) {
      assert.strictEqual((await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: type } })).json.delivered, 0);
    }
    assert.deepStrictEqual(h._debug(), { sse: 0, polls: 0, commands: 0, pollScreens: 0, pingTimer: false, calendar: NO_CALENDAR, spotify: NO_SPOTIFY });
  });

  /* ---------- to-do ---------- */

  await check('POST /api/todo adds at the top with a server id', async () => {
    const a = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'First' } });
    const b = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: '  Second  ', section: 'next', due: '2026-12-24' } });
    assert.strictEqual(b.status, 200);
    assert.ok(/^p[0-9a-z]+[0-9a-z]{3}$/.test(b.json.item.id));
    assert.strictEqual(b.json.item.title, 'Second');
    assert.strictEqual(b.json.item.section, 'next');
    assert.strictEqual(b.json.item.due, '2026-12-24');
    assert.strictEqual(b.json.item.done, false);
    assert.strictEqual(b.json.item.doneAt, null);
    assert.strictEqual(typeof b.json.item.createdAt, 'number');
    assert.strictEqual(b.json.rev, a.json.rev + 1);
    const list = await request(P, 'GET', '/api/todo', { token: TOKEN });
    assert.deepStrictEqual(list.json.items.map((i) => i.title), ['Second', 'First']);
  });

  await check('POST /api/todo rejects a bad title, section and due date', async () => {
    for (const body of [{}, { title: '' }, { title: 'x'.repeat(81) }, { title: 'ok', section: 'later' }, { title: 'ok', due: '24/12/2026' }]) {
      const r = await request(P, 'POST', '/api/todo', { token: TOKEN, body: body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error && r.json.error.length > 5);
    }
  });

  await check('to-do level: POST /api/todo takes it, none stays none, a bad one is refused, the TV can set it', async () => {
    const a = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Must one', level: 'must' } });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.json.item.level, 'must');
    const b = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'No level' } });
    assert.ok(!('level' in b.json.item));
    const bad = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'ok', level: 'urgent' } });
    assert.strictEqual(bad.status, 400);
    assert.ok(/level must be must, optional or passive/.test(bad.json.error));
    let r = await request(P, 'POST', '/todo/ops', { body: { ops: [{ op: 'set', id: b.json.item.id, fields: { level: 'passive' }, to: 'end' }] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.items.find((i) => i.id === b.json.item.id).level, 'passive');
    r = await request(P, 'POST', '/todo/ops', { body: { ops: [{ op: 'set', id: a.json.item.id, fields: { level: null } }] } });
    assert.ok(!('level' in r.json.items.find((i) => i.id === a.json.item.id)));
    await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'remove', id: a.json.item.id }, { op: 'remove', id: b.json.item.id }] } });
  });

  await check('to-do lead: POST /api/todo takes 0 to 30, none stays none, a bad one is refused, set and clear it', async () => {
    const a = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'School meeting', level: 'passive', due: '2026-11-20', lead: 3 } });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.json.item.lead, 3);
    const z = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Only on the day', level: 'passive', lead: 0 } });
    assert.strictEqual(z.json.item.lead, 0);
    const b = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'No lead', level: 'passive' } });
    assert.ok(!('lead' in b.json.item));
    for (const lead of [31, -1, 2.5, '3', true]) {
      const bad = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'ok', lead: lead } });
      assert.strictEqual(bad.status, 400, JSON.stringify(lead));
      assert.ok(/lead must be a whole number of days from 0 to 30/.test(bad.json.error), bad.json.error);
    }
    let r = await request(P, 'POST', '/todo/ops', { body: { ops: [{ op: 'set', id: b.json.item.id, fields: { lead: 30 } }] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.items.find((i) => i.id === b.json.item.id).lead, 30);
    r = await request(P, 'POST', '/todo/ops', { body: { ops: [{ op: 'set', id: a.json.item.id, fields: { lead: null } }] } });
    assert.ok(!('lead' in r.json.items.find((i) => i.id === a.json.item.id)));
    await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [a, z, b].map((x) => ({ op: 'remove', id: x.json.item.id })) } });
  });

  await check('hubctl lead: a field wins over a "[lead:N]" tag, words for 0, 1 and N days, list shows it', () => {
    assert.strictEqual(hubctl.leadOf({ title: 'A' }), null);
    assert.strictEqual(hubctl.leadOf({ title: 'A', notes: 'x [lead:5] [level:passive]' }), 5);
    assert.strictEqual(hubctl.leadOf({ title: 'A', lead: 0, notes: '[lead:5]' }), 0);
    assert.strictEqual(hubctl.leadOf({ title: 'A', notes: '[lead:31]' }), null);
    assert.strictEqual(hubctl.todoLeadText({ title: 'A', lead: 3 }), '"A" shows under Coming up from 3 days before it is due.');
    assert.strictEqual(hubctl.todoLeadText({ title: 'A', lead: 1 }), '"A" shows under Coming up from 1 day before it is due.');
    assert.strictEqual(hubctl.todoLeadText({ title: 'A', lead: 0 }), '"A" shows under Coming up only on the day it is due.');
    assert.strictEqual(hubctl.todoLeadText({ title: 'A' }), '"A" shows under Coming up from 2 days before it is due (the default).');
    assert.strictEqual(hubctl.todoAddText({ item: { title: 'A', level: 'passive', due: '2026-11-20', lead: 3 } }),
      'Added "A" to Coming up, due 2026-11-20, shown from 3 days before it is due.');
    assert.deepStrictEqual(hubctl.todoListLines([{ id: 'x1', title: 'A', level: 'passive', due: '2026-11-20', lead: 3, done: false }]),
      ['Coming up:', '  [ ] A (due 2026-11-20, lead 3 days)   id x1']);
  });

  await check('to-do ops: add top/end, set, move to end, remove, last one wins', async () => {
    const ops = [
      { op: 'remove', id: 'nothere' },
      { op: 'add', item: { id: 'a1', title: 'A' }, at: 'top' },
      { op: 'add', item: { id: 'b1', title: 'B' }, at: 'end' },
      { op: 'add', item: { id: 'c1', title: 'C' } },
      { op: 'set', id: 'a1', fields: { title: 'A2', done: true }, to: 'end' },
      { op: 'set', id: 'ghost', fields: { title: 'ignored' } },
      { op: 'add', item: { id: 'b1', title: 'B2', section: 'waiting' } },
      { op: 'set', id: 'c1', fields: { title: 'C2' } },
      { op: 'set', id: 'c1', fields: { title: 'C3' } }
    ];
    const r = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: ops } });
    assert.strictEqual(r.status, 200, r.text);
    const titles = r.json.items.map((i) => i.title);
    assert.deepStrictEqual(titles, ['Second', 'First', 'B2', 'C3', 'A2']);
    const a = r.json.items.find((i) => i.id === 'a1');
    assert.strictEqual(a.done, true);
    assert.strictEqual(typeof a.doneAt, 'number');
    assert.strictEqual(r.json.items.find((i) => i.id === 'b1').section, 'waiting');
    const r2 = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'set', id: 'a1', fields: { done: false } }, { op: 'remove', id: 'c1' }] } });
    assert.strictEqual(r2.json.items.find((i) => i.id === 'a1').doneAt, null);
    assert.ok(!r2.json.items.some((i) => i.id === 'c1'));
    assert.strictEqual(r2.json.rev, r.json.rev + 1);
  });

  await check('to-do ops: unknown small fields are kept; due can be cleared', async () => {
    const r = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [
      { op: 'add', item: { id: 'x1', title: 'Extra', note: 'kitchen', due: '2027-01-02' } },
      { op: 'set', id: 'x1', fields: { due: null, colour: 'red' } }
    ] } });
    const it = r.json.items.find((i) => i.id === 'x1');
    assert.strictEqual(it.note, 'kitchen');
    assert.strictEqual(it.colour, 'red');
    assert.ok(!('due' in it));
  });

  await check('to-do notes: optional, tidied, capped at 300, empty or null removes them', async () => {
    const plain = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'No notes' } });
    assert.ok(!('notes' in plain.json.item));
    const blank = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Blank notes', notes: '   ' } });
    assert.ok(!('notes' in blank.json.item));
    const es = 'Llevar la mochila con las acuarelas, ¡no olvidar el cuaderno de dibujo! Ñandú, pingüino y camión. ' + 'á'.repeat(202);
    assert.strictEqual(Array.from(es).length, 300);
    const a = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Con notas', notes: '  Llevar la mochila\n\t con   las acuarelas.  ' } });
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(a.json.item.notes, 'Llevar la mochila con las acuarelas.');
    const full = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'x'.repeat(80), notes: es } });
    assert.strictEqual(full.status, 200, full.text);
    assert.strictEqual(full.json.item.notes, es);
    const long = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Too long', notes: es + 'x' } });
    assert.strictEqual(long.status, 400);
    assert.ok(/notes are longer than 300/.test(long.json.error), long.json.error);
    const notText = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Bad', notes: ['a'] } });
    assert.strictEqual(notText.status, 400);
    const id = a.json.item.id;
    // A change from the TV (done, section) keeps the notes.
    let r = await request(P, 'POST', '/todo/ops', { body: { ops: [{ op: 'set', id: id, fields: { done: true, doneAt: Date.now() } }, { op: 'set', id: id, fields: { section: 'next' }, to: 'end' }] } });
    let it = r.json.items.find((i) => i.id === id);
    assert.strictEqual(it.notes, a.json.item.notes);
    r = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'set', id: id, fields: { notes: 'Short' } }] } });
    assert.strictEqual(r.json.items.find((i) => i.id === id).notes, 'Short');
    r = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'set', id: id, fields: { notes: '' } }] } });
    assert.ok(!('notes' in r.json.items.find((i) => i.id === id)));
    await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'set', id: id, fields: { notes: 'Again' } }] } });
    r = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'set', id: id, fields: { notes: null } }] } });
    assert.ok(!('notes' in r.json.items.find((i) => i.id === id)));
    await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [plain, blank, a, full].map((x) => ({ op: 'remove', id: x.json.item.id })) } });
  });

  await check('to-do ops: bad ops are 400 and change nothing', async () => {
    const before = (await request(P, 'GET', '/api/todo', { token: TOKEN })).json;
    const bads = [
      { ops: 'nope' },
      { ops: [{ op: 'add', item: { id: 'ok1', title: 'fine' } }, { op: 'jump' }] },
      { ops: [{ op: 'add', item: { id: 'bad id!', title: 'x' } }] },
      { ops: [{ op: 'add', item: { id: 'big', title: 'x', note: 'y'.repeat(1980) } }] },
      { ops: [{ op: 'add', item: { id: 'n1', title: 'x', notes: 'y'.repeat(301) } }] },
      { ops: [{ op: 'add', item: { id: 'n2', title: 'x', notes: 42 } }] },
      { ops: [{ op: 'add', item: { id: 'ok2', title: 'x' }, at: 'middle' }] },
      { ops: [{ op: 'set', id: 'a1', fields: { done: 'yes' } }] },
      { ops: [{ op: 'set', id: 'a1', fields: {}, to: 'top' }] },
      { ops: new Array(101).fill({ op: 'remove', id: 'zz' }) }
    ];
    for (const body of bads) {
      const r = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: body });
      assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.ok(r.json.error);
    }
    const big = await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'add', item: { id: 'big', title: 'x', note: 'y'.repeat(1980) } }] } });
    assert.ok(/2000 bytes/.test(big.json.error), big.json.error);
    const after = (await request(P, 'GET', '/api/todo', { token: TOKEN })).json;
    assert.deepStrictEqual(after, before);
  });

  await check('to-do ops: at most 200 items', async () => {
    const d = tmpDir();
    const h2 = await start({ dataDir: d });
    for (let n = 0; n < 4; n++) {
      const ops = [];
      for (let i = 0; i < 50; i++) ops.push({ op: 'add', item: { id: 'i' + n + '_' + i, title: 't' } });
      const r = await request(h2.port, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: ops } });
      assert.strictEqual(r.status, 200);
    }
    const r = await request(h2.port, 'POST', '/api/todo', { token: TOKEN, body: { title: 'one too many' } });
    assert.strictEqual(r.status, 400);
    assert.ok(/full/.test(r.json.error));
    const r2 = await request(h2.port, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [{ op: 'add', item: { id: 'z', title: 'z' } }] } });
    assert.strictEqual(r2.status, 400);
    await stop(h2);
  });

  await check('done items ticked over 48 hours ago are dropped on the next write', async () => {
    const old = Date.now() - 49 * 3600 * 1000;
    const recent = Date.now() - 47 * 3600 * 1000;
    await request(P, 'POST', '/api/todo/ops', { token: TOKEN, body: { ops: [
      { op: 'add', item: { id: 'old1', title: 'Old', done: true, doneAt: old } },
      { op: 'add', item: { id: 'new1', title: 'Recent', done: true, doneAt: recent } }
    ] } });
    const r = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Trigger' } });
    assert.ok(r.status === 200);
    const items = (await request(P, 'GET', '/api/todo', { token: TOKEN })).json.items;
    assert.ok(!items.some((i) => i.id === 'old1'));
    assert.ok(items.some((i) => i.id === 'new1'));
  });

  /* ---------- screen API ---------- */

  await check('GET /live/state: v, server, epoch, rev, resources', async () => {
    const r = await request(P, 'GET', '/live/state');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.v, 1);
    assert.strictEqual(r.json.server, hubServer.SERVER_VERSION);
    assert.ok(Array.isArray(r.json.resources.todo.data.items));
    assert.strictEqual(r.json.resources.todo.rev, r.json.rev);
    assert.strictEqual(r.json.resources.calendar.data.configured, false);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  });

  await check('POST /todo/ops from a screen (no token) works and returns items', async () => {
    const r = await request(P, 'POST', '/todo/ops', { body: { ops: [{ op: 'add', item: { id: 'tv1', title: 'From TV' }, at: 'top' }] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.items[0].id, 'tv1');
    assert.strictEqual(typeof r.json.rev, 'number');
  });

  await check('CORS: allowed origin echoed with Vary, others not; preflight', async () => {
    const ok = await request(P, 'GET', '/live/state', { headers: { Origin: 'http://127.0.0.1:8081' } });
    assert.strictEqual(ok.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
    assert.ok(/Origin/.test(ok.headers.vary));
    const no = await request(P, 'GET', '/live/state', { headers: { Origin: 'http://evil.example' } });
    assert.strictEqual(no.headers['access-control-allow-origin'], undefined);
    assert.ok(/Origin/.test(no.headers.vary));
    const pre = await request(P, 'OPTIONS', '/todo/ops', { headers: { Origin: 'http://127.0.0.1:8081', 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
    assert.ok(/POST/.test(pre.headers['access-control-allow-methods']));
    assert.ok(/Content-Type/i.test(pre.headers['access-control-allow-headers']));
    const preBad = await request(P, 'OPTIONS', '/todo/ops', { headers: { Origin: 'http://evil.example' } });
    assert.strictEqual(preBad.headers['access-control-allow-origin'], undefined);
    const post = await request(P, 'POST', '/todo/ops', { headers: { Origin: 'http://evil.example' }, body: { ops: [] } });
    assert.strictEqual(post.status, 403);
  });

  await check('SSE: headers, retry, hello, change, command, ping', async () => {
    const es = await openEvents(P, { Origin: 'http://127.0.0.1:8081' });
    assert.ok(/text\/event-stream/.test(es.res.headers['content-type']));
    assert.strictEqual(es.res.headers['cache-control'], 'no-store');
    assert.strictEqual(es.res.headers['x-accel-buffering'], 'no');
    assert.strictEqual(es.res.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
    const hello = await es.waitFor((e) => e.event === 'hello');
    assert.strictEqual(es.events[0].retry, 5000);
    assert.strictEqual(hello.data.v, 1);
    assert.strictEqual(typeof hello.data.epoch, 'string');
    assert.strictEqual(typeof hello.data.rev, 'number');
    await waitUntil(() => h._debug().sse === 1);
    const add = await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Pushed' } });
    const ch = await es.waitFor((e) => e.event === 'change');
    assert.strictEqual(ch.data.resource, 'todo');
    assert.strictEqual(ch.data.rev, add.json.rev);
    assert.ok(ch.data.data.items.some((i) => i.title === 'Pushed'));
    const c = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'show', data: { widget: 'weather', mode: 'full' } } });
    assert.strictEqual(c.json.delivered, 1);
    const cmd = await es.waitFor((e) => e.event === 'command');
    assert.strictEqual(cmd.data.type, 'show');
    assert.deepStrictEqual(cmd.data.data, { widget: 'weather', mode: 'full' });
    assert.ok(/^c[0-9a-z]+$/.test(cmd.data.id));
    const ping = await es.waitFor((e) => e.event === 'ping', 1000);
    assert.strictEqual(ping.data.rev, add.json.rev);
    es.raw.text.split('\n').filter((l) => l.indexOf('data:') === 0).forEach((l) => JSON.parse(l.slice(5)));
    const st = await request(P, 'GET', '/api/status', { token: TOKEN });
    assert.strictEqual(st.json.screens.length, 1);
    assert.strictEqual(st.json.screens[0].via, 'events');
    es.close();
    await waitUntil(() => h._debug().sse === 0);
    assert.strictEqual(h._debug().pingTimer, false);
    const after = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'home' } });
    assert.strictEqual(after.json.delivered, 0);
  });

  await check('SSE: at most 20 screens, the 21st gets 503', async () => {
    const list = [];
    for (let i = 0; i < 20; i++) list.push(await openEvents(P));
    await waitUntil(() => h._debug().sse === 20);
    const r = await request(P, 'GET', '/live/events');
    assert.strictEqual(r.status, 503);
    const c = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'reload' } });
    assert.strictEqual(c.json.delivered, 20);
    list.forEach((e) => e.close());
    await waitUntil(() => h._debug().sse === 0);
  });

  await check('poll: answers at once when rev or epoch differ', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    const t0 = Date.now();
    const r = await request(P, 'GET', '/live/poll?epoch=old&rev=0');
    assert.ok(Date.now() - t0 < 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.v, 1);
    assert.strictEqual(r.json.epoch, st.epoch);
    assert.ok(r.json.resources.todo);
    assert.deepStrictEqual(r.json.commands, []);
    assert.ok(/^c[0-9a-z]+$/.test(r.json.cursor));
    const r2 = await request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + (st.rev - 1) + '&cursor=' + r.json.cursor);
    assert.ok(r2.json.resources.todo);
    assert.strictEqual(r2.json.rev, st.rev);
  });

  await check('poll: waits when nothing is new, returns empty resources after the wait', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    const first = await request(P, 'GET', '/live/poll');
    const t0 = Date.now();
    const r = await request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + st.rev + '&cursor=' + first.json.cursor);
    const took = Date.now() - t0;
    assert.ok(took >= 350 && took < 1500, 'took ' + took);
    assert.deepStrictEqual(r.json.resources, {});
    assert.deepStrictEqual(r.json.commands, []);
    assert.strictEqual(r.json.cursor, first.json.cursor);
  });

  await check('poll: a waiting poll wakes on a change', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    const cur = (await request(P, 'GET', '/live/poll')).json.cursor;
    const pending = request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + st.rev + '&cursor=' + cur);
    await waitUntil(() => h._debug().polls === 1);
    await request(P, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Wake' } });
    const r = await pending;
    assert.strictEqual(r.json.rev, st.rev + 1);
    assert.ok(r.json.resources.todo.data.items.some((i) => i.title === 'Wake'));
  });

  await check('poll: a waiting poll gets a command and it counts as delivered', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    const cur = (await request(P, 'GET', '/live/poll')).json.cursor;
    const pending = request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + st.rev + '&cursor=' + cur);
    await waitUntil(() => h._debug().polls === 1);
    const c = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'say', data: { text: 'Dinner in 10', seconds: 8 } } });
    assert.strictEqual(c.json.delivered, 1);
    const r = await pending;
    assert.strictEqual(r.json.commands.length, 1);
    assert.strictEqual(r.json.commands[0].type, 'say');
    assert.deepStrictEqual(r.json.commands[0].data, { text: 'Dinner in 10', seconds: 8 });
    assert.strictEqual(r.json.cursor, r.json.commands[0].id);
    assert.deepStrictEqual(r.json.resources, {});
  });

  await check('poll: play reaches a screen with the trimmed address and title', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    const cur = (await request(P, 'GET', '/live/poll')).json.cursor;
    const pending = request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + st.rev + '&cursor=' + cur);
    await waitUntil(() => h._debug().polls === 1);
    const c = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'play', data: { url: ' https://example.com/n.mp3 ', title: ' NPR News Now, 7pm ET ' } } });
    assert.strictEqual(c.json.delivered, 1);
    const r = await pending;
    assert.strictEqual(r.json.commands[0].type, 'play');
    assert.deepStrictEqual(r.json.commands[0].data, { url: 'https://example.com/n.mp3', title: 'NPR News Now, 7pm ET' });
  });

  await check('poll: a command sent between polls is picked up, then forgotten after the time limit', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    const cur = (await request(P, 'GET', '/live/poll')).json.cursor;
    const c = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'home' } });
    assert.strictEqual(c.json.delivered, 0);
    assert.ok(h._debug().commands >= 1);
    const r = await request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + st.rev + '&cursor=' + cur);
    assert.strictEqual(r.json.commands.length, 1);
    assert.strictEqual(r.json.commands[0].type, 'home');
    await sleep(450);
    assert.strictEqual(h._debug().commands, 0);
    const r2 = await request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + st.rev + '&cursor=' + cur);
    assert.deepStrictEqual(r2.json.commands, []);
  });

  await check('poll: a first poll with no cursor never replays old commands', async () => {
    await request(P, 'GET', '/live/poll');
    await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'reload' } });
    const r = await request(P, 'GET', '/live/poll');
    assert.deepStrictEqual(r.json.commands, []);
  });

  await check('poll: at most 20 remembered commands', async () => {
    await request(P, 'GET', '/live/poll');
    for (let i = 0; i < 25; i++) await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'home' } });
    assert.ok(h._debug().commands <= 20);
  });

  await check('with no screen left, nothing is held and nothing is kept', async () => {
    await waitUntil(() => {
      const d = h._debug();
      return d.sse === 0 && d.polls === 0 && d.commands === 0 && d.pollScreens === 0;
    }, 3000);
    const c = await request(P, 'POST', '/api/command', { token: TOKEN, body: { type: 'show', data: { widget: 'todo' } } });
    assert.strictEqual(c.json.delivered, 0);
    assert.deepStrictEqual(h._debug(), { sse: 0, polls: 0, commands: 0, pollScreens: 0, pingTimer: false, calendar: NO_CALENDAR, spotify: NO_SPOTIFY });
  });

  /* ---------- layout ---------- */

  const LAYOUT = [
    { widget: 'weather', x: 0, y: 0, w: 3, h: 2 },
    { widget: 'todo', x: 3, y: 0, w: 3, h: 4 },
    { widget: 'calendar', x: 6, y: 0, w: 6, h: 6 }
  ];

  await check('layout validator: good layouts pass and keep only the five fields', () => {
    assert.strictEqual(hubServer.normalizeLayout(null), null);
    assert.deepStrictEqual(hubServer.normalizeLayout(LAYOUT), LAYOUT);
    const extra = hubServer.normalizeLayout([{ widget: 'a-1', x: 11, y: 5, w: 1, h: 1, note: 'drop me', __proto__x: 1 }]);
    assert.deepStrictEqual(extra, [{ widget: 'a-1', x: 11, y: 5, w: 1, h: 1 }]);
    const full = [];
    for (let i = 0; i < 24; i++) full.push({ widget: 't' + i, x: (i % 6) * 2, y: Math.floor(i / 6), w: 2, h: 1 });
    assert.strictEqual(hubServer.normalizeLayout(full).length, 24);
    // Touching edges is not overlapping.
    hubServer.normalizeLayout([{ widget: 'a', x: 0, y: 0, w: 6, h: 6 }, { widget: 'b', x: 6, y: 0, w: 6, h: 6 }]);
  });

  await check('layout validator: each bad layout is a 400 with a readable message', () => {
    const tile = (o) => Object.assign({ widget: 'weather', x: 0, y: 0, w: 3, h: 2 }, o);
    const cases = [
      ['not a list', { widget: 'x' }, /list of tiles/],
      ['empty', [], /no tiles/],
      ['not an object', [5], /must be an object \(tile 1\)/],
      ['no widget', [tile({ widget: undefined })], /"widget" must be/],
      ['capital letters', [tile({ widget: 'Weather' })], /"widget" must be/],
      ['underscore', [tile({ widget: 'my_tile' })], /"widget" must be/],
      ['too long id', [tile({ widget: 'a'.repeat(33) })], /"widget" must be/],
      ['fraction', [tile({ x: 1.5 })], /"x" must be a whole number \(tile 1, weather\)/],
      ['string', [tile({ w: '3' })], /"w" must be a whole number/],
      ['NaN', [tile({ h: NaN })], /"h" must be a whole number/],
      ['negative x', [tile({ x: -1 })], /0 or more/],
      ['negative y', [tile({ y: -1 })], /0 or more/],
      ['zero width', [tile({ w: 0 })], /1 or more/],
      ['zero height', [tile({ h: 0 })], /1 or more/],
      ['past the right', [tile({ x: 10, w: 3 })], /right edge/],
      ['past the bottom', [tile({ y: 5, h: 2 })], /bottom edge/],
      ['duplicate', [tile({}), tile({ x: 6 })], /"weather" is in the layout twice \(tile 2, weather\)/],
      ['overlap', [tile({}), tile({ widget: 'todo', x: 2, y: 1 })], /overlaps "weather" \(tile 2, todo\)/]
    ];
    cases.forEach(([name, raw, re]) => {
      let err = null;
      try { hubServer.normalizeLayout(raw); } catch (e) { err = e; }
      assert.ok(err, name + ' was accepted');
      assert.strictEqual(err.status, 400, name);
      assert.ok(re.test(err.message), name + ': ' + err.message);
    });
    const many = [];
    for (let i = 0; i < 25; i++) many.push({ widget: 't' + i, x: i % 12, y: Math.floor(i / 12), w: 1, h: 1 });
    assert.throws(() => hubServer.normalizeLayout(many), /too many tiles \(at most 24\)/);
  });

  await check('layout API: needs the token; starts as null (the built-in layout)', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/layout')).status, 401);
    assert.strictEqual((await request(P, 'POST', '/api/layout', { body: { layout: null } })).status, 401);
    const g = await request(P, 'GET', '/api/layout', { token: TOKEN });
    assert.deepStrictEqual(g.json, { ok: true, rev: 0, layout: null });
    const st = (await request(P, 'GET', '/live/state')).json;
    assert.deepStrictEqual(st.resources.layout, { rev: 0, data: { layout: null } });
    const m = await request(P, 'PUT', '/api/layout', { token: TOKEN, body: { layout: null } });
    assert.strictEqual(m.status, 405);
    assert.strictEqual(m.headers.allow, 'GET, POST');
  });

  await check('layout API: a new layout saves, bumps rev and reaches screens; a repeat is a no-op', async () => {
    const es = await openEvents(P);
    await es.waitFor((e) => e.event === 'hello');
    const before = (await request(P, 'GET', '/live/state')).json.rev;
    const r = await request(P, 'POST', '/api/layout', { token: TOKEN, body: { layout: LAYOUT } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, rev: before + 1, changed: true, layout: LAYOUT });
    const ch = await es.waitFor((e) => e.event === 'change' && e.data.resource === 'layout');
    assert.deepStrictEqual(ch.data, { resource: 'layout', rev: before + 1, data: { layout: LAYOUT } });
    const again = await request(P, 'POST', '/api/layout', { token: TOKEN, body: { layout: LAYOUT.map((t) => Object.assign({ extra: 1 }, t)) } });
    assert.deepStrictEqual(again.json, { ok: true, rev: before + 1, changed: false, layout: LAYOUT });
    assert.strictEqual((await request(P, 'GET', '/live/state')).json.rev, before + 1);
    await sleep(50);
    assert.strictEqual(es.events.filter((e) => e.event === 'change').length, 1);
    es.close();
    await waitUntil(() => h._debug().sse === 0);
    const g = await request(P, 'GET', '/api/layout', { token: TOKEN });
    assert.deepStrictEqual(g.json, { ok: true, rev: before + 1, layout: LAYOUT });
  });

  await check('layout API: the snapshot and the poll carry the layout', async () => {
    const st = (await request(P, 'GET', '/live/state')).json;
    assert.deepStrictEqual(st.resources.layout.data.layout, LAYOUT);
    const p = (await request(P, 'GET', '/live/poll?epoch=old&rev=0')).json;
    assert.deepStrictEqual(p.resources.layout.data.layout, LAYOUT);
    const p2 = (await request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + (st.resources.layout.rev - 1) + '&cursor=' + p.cursor)).json;
    assert.deepStrictEqual(p2.resources.layout.data.layout, LAYOUT);
  });

  await check('layout API: bad bodies are 400 and change nothing; null resets', async () => {
    const rev = (await request(P, 'GET', '/live/state')).json.rev;
    for (const body of [{}, [], { layout: 'weather' }, { layout: [] }, { layout: [{ widget: 'a', x: 0, y: 0, w: 13, h: 1 }] }]) {
      const r = await request(P, 'POST', '/api/layout', { token: TOKEN, body: body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.strictEqual(r.json.ok, false);
      assert.ok(typeof r.json.error === 'string' && r.json.error.length > 10);
    }
    assert.strictEqual((await request(P, 'GET', '/live/state')).json.rev, rev);
    const reset = await request(P, 'POST', '/api/layout', { token: TOKEN, body: { layout: null } });
    assert.deepStrictEqual(reset.json, { ok: true, rev: rev + 1, changed: true, layout: null });
    const again = await request(P, 'POST', '/api/layout', { token: TOKEN, body: { layout: null } });
    assert.strictEqual(again.json.changed, false);
    assert.strictEqual(again.json.rev, rev + 1);
  });

  await check('layout in the state file: survives a restart; old or damaged files mean null', async () => {
    const d = tmpDir();
    const h2 = await start({ dataDir: d });
    await request(h2.port, 'POST', '/api/layout', { token: TOKEN, body: { layout: LAYOUT } });
    await stop(h2);
    const h3 = await start({ dataDir: d });
    const g = (await request(h3.port, 'GET', '/api/layout', { token: TOKEN })).json;
    assert.deepStrictEqual(g, { ok: true, rev: 1, layout: LAYOUT });
    await stop(h3);
    // A file from before layouts existed.
    const old = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    delete old.resources.layout;
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(old));
    const h4 = await start({ dataDir: d });
    const s4 = (await request(h4.port, 'GET', '/live/state')).json;
    assert.deepStrictEqual(s4.resources.layout, { rev: 0, data: { layout: null } });
    assert.strictEqual(s4.epoch, old.epoch);
    assert.strictEqual(s4.resources.todo.rev, old.resources.todo.rev);
    await stop(h4);
    // A damaged layout falls back to null; the rest of the file stays.
    const bent = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    bent.resources.layout = { rev: 7, data: { layout: [{ widget: 'x', x: 0, y: 0, w: 99, h: 1 }] } };
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(bent));
    const h5 = await start({ dataDir: d });
    const s5 = (await request(h5.port, 'GET', '/live/state')).json;
    assert.deepStrictEqual(s5.resources.layout, { rev: 7, data: { layout: null } });
    assert.strictEqual(s5.epoch, bent.epoch);
    assert.ok(!fs.readdirSync(d).some((f) => /^state\.bad-/.test(f)), 'not moved aside');
    await stop(h5);
  });

  /* ---------- A World Worth Saving snapshot ---------- */

  const AWWS_EMPTY = { v: 1, sentAt: null, receivedAt: null };
  const SAMPLE_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'awws-sample.json'), 'utf8');
  // The made-up sample, sent a minute ago (its own sentAt may be ahead of this computer's clock).
  const awwsSample = (minutesAgo) => {
    const s = JSON.parse(SAMPLE_TEXT);
    s.sentAt = new Date(Date.now() - (minutesAgo === undefined ? 1 : minutesAgo) * 60000).toISOString();
    return s;
  };
  const ALL_SECTIONS = ['todos', 'handoffs', 'outreach', 'khaya', 'pipeline', 'money', 'reach'];

  await check('awws API: needs the token; starts empty ("Not synced yet")', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/awws')).status, 401);
    assert.strictEqual((await request(P, 'POST', '/api/awws', { body: { snapshot: null } })).status, 401);
    assert.strictEqual((await request(P, 'POST', '/api/awws', { token: 'wrong', body: { snapshot: null } })).status, 401);
    const g = await request(P, 'GET', '/api/awws', { token: TOKEN });
    assert.deepStrictEqual(g.json, { ok: true, rev: 0, data: AWWS_EMPTY, tz: 'America/Chicago' });
    const st = (await request(P, 'GET', '/live/state')).json;
    assert.deepStrictEqual(st.resources.awws, { rev: 0, data: AWWS_EMPTY });
    const m = await request(P, 'PUT', '/api/awws', { token: TOKEN, body: { snapshot: null } });
    assert.strictEqual(m.status, 405);
    assert.strictEqual(m.headers.allow, 'GET, POST');
  });

  await check('awws API: a snapshot is stored, arrives as a change event, and is in /live/state and the poll', async () => {
    const es = await openEvents(P);
    await es.waitFor((e) => e.event === 'hello');
    const before = (await request(P, 'GET', '/live/state')).json.rev;
    const snap = awwsSample();
    const r = await request(P, 'POST', '/api/awws', { token: TOKEN, body: { snapshot: snap } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.rev, before + 1);
    assert.strictEqual(r.json.changed, true);
    assert.deepStrictEqual(r.json.accepted, ALL_SECTIONS);
    assert.deepStrictEqual(r.json.cleared, []);
    assert.deepStrictEqual(r.json.rejected, []);
    assert.ok(r.json.bytes > 1000 && r.json.bytes < 49152);
    const ch = await es.waitFor((e) => e.event === 'change' && e.data.resource === 'awws');
    assert.strictEqual(ch.data.rev, before + 1);
    assert.strictEqual(ch.data.data.sentAt, snap.sentAt);
    assert.ok(typeof ch.data.data.receivedAt === 'string');
    assert.strictEqual(ch.data.data.todos.items.length, snap.todos.items.length);
    es.close();
    await waitUntil(() => h._debug().sse === 0);
    const st = (await request(P, 'GET', '/live/state')).json;
    assert.deepStrictEqual(st.resources.awws, { rev: before + 1, data: ch.data.data });
    const p = (await request(P, 'GET', '/live/poll?epoch=old&rev=0')).json;
    assert.deepStrictEqual(p.resources.awws.data, ch.data.data);
    const p2 = (await request(P, 'GET', '/live/poll?epoch=' + st.epoch + '&rev=' + before + '&cursor=' + p.cursor)).json;
    assert.deepStrictEqual(Object.keys(p2.resources), ['awws']);
    const g = (await request(P, 'GET', '/api/awws', { token: TOKEN })).json;
    assert.deepStrictEqual(g.data, ch.data.data);
    assert.strictEqual(g.rev, before + 1);
  });

  await check('awws API: the same contents again still store the new sentAt and push to screens (changed false)', async () => {
    const es = await openEvents(P);
    await es.waitFor((e) => e.event === 'hello');
    const before = (await request(P, 'GET', '/api/awws', { token: TOKEN })).json;
    const snap = awwsSample(0);
    const r = await request(P, 'POST', '/api/awws', { token: TOKEN, body: { snapshot: snap } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changed, false);
    assert.strictEqual(r.json.rev, before.rev + 1);
    const ch = await es.waitFor((e) => e.event === 'change' && e.data.resource === 'awws');
    assert.strictEqual(ch.data.data.sentAt, snap.sentAt);
    assert.notStrictEqual(ch.data.data.sentAt, before.data.sentAt);
    es.close();
    await waitUntil(() => h._debug().sse === 0);
  });

  await check('awws API: a bad section is refused by name with 200; the others are stored', async () => {
    const before = (await request(P, 'GET', '/api/awws', { token: TOKEN })).json;
    const snap = { v: 1, sentAt: new Date().toISOString(), khaya: { done: 12, total: 12 }, money: { currency: 'dollars', spent: 1, earned: 1 } };
    const r = await request(P, 'POST', '/api/awws', { token: TOKEN, body: { snapshot: snap } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.accepted, ['khaya']);
    assert.deepStrictEqual(r.json.rejected, [{ section: 'money', error: '"currency" must be three capital letters, like USD' }]);
    const after = (await request(P, 'GET', '/api/awws', { token: TOKEN })).json.data;
    assert.strictEqual(after.khaya.done, 12);
    assert.deepStrictEqual(after.money, before.data.money);
    assert.deepStrictEqual(after.todos, before.data.todos);
  });

  await check('awws API: a wrong snapshot, or one where every section is refused, is 400 and changes nothing', async () => {
    const rev = (await request(P, 'GET', '/live/state')).json.rev;
    const now = new Date().toISOString();
    const cases = [
      [{}, /send \{ "snapshot"/],
      [[], /send \{ "snapshot"/],
      [{ snapshot: 'big' }, /must be a JSON object/],
      [{ snapshot: { v: 2, sentAt: now, khaya: { done: 0, total: 1 } } }, /"v" must be 1/],
      [{ snapshot: { v: 1, sentAt: new Date(Date.now() + 3600000).toISOString(), khaya: { done: 0, total: 1 } } }, /10 minutes in the future/],
      [{ snapshot: { v: 1, sentAt: now } }, /no sections/],
      [{ snapshot: { v: 1, sentAt: now, khaya: { done: 3, total: 2 }, reach: {} } }, /every section was rejected: khaya: "done" \(3\) is more than "total" \(2\); reach: the section must hold at least one of "visits", "buyClicks", "subscribers" or "scans"/]
    ];
    for (const [body, re] of cases) {
      const r = await request(P, 'POST', '/api/awws', { token: TOKEN, body: body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.strictEqual(r.json.ok, false);
      assert.ok(re.test(r.json.error), r.json.error);
    }
    assert.strictEqual((await request(P, 'GET', '/live/state')).json.rev, rev);
  });

  await check('body limit: 64 KB on POST /api/awws, still 8 KB on every other call', async () => {
    // About 21 KB: over the old 8 KB, fine here.
    const mid = { v: 1, sentAt: new Date().toISOString(), todos: { items: [] } };
    for (let i = 0; i < 160; i++) mid.todos.items.push({ id: 'm' + i, title: 'Item number ' + i + ' ' + 'z'.repeat(60), owner: 'ian', section: 'later' });
    const midText = JSON.stringify({ snapshot: mid });
    assert.ok(midText.length > 16 * 1024 && midText.length < 48 * 1024, 'size ' + midText.length);
    const ok = await request(P, 'POST', '/api/awws', { token: TOKEN, raw: midText });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.json.accepted[0], 'todos');
    // About 60 KB: through the door, then refused by the 48 KB snapshot cap.
    const big = JSON.stringify({ snapshot: { v: 1, sentAt: new Date().toISOString(), khaya: { done: 0, total: 1 }, pad: 'p'.repeat(60 * 1024 - 200) } });
    assert.ok(big.length < 64 * 1024 && big.length > 59 * 1024);
    const b = await request(P, 'POST', '/api/awws', { token: TOKEN, raw: big });
    assert.strictEqual(b.status, 400);
    assert.ok(/at most 48 KB \(49,152 bytes\)/.test(b.json.error), b.json.error);
    // Over 64 KB: refused at the door.
    const huge = await request(P, 'POST', '/api/awws', { token: TOKEN, raw: JSON.stringify({ snapshot: { pad: 'p'.repeat(66 * 1024) } }) });
    assert.strictEqual(huge.status, 413);
    assert.deepStrictEqual(huge.json, { ok: false, error: 'request body too large (at most 64 KB)' });
    // Other calls keep 8 KB.
    const tiles = [];
    for (let i = 0; i < 24; i++) tiles.push({ widget: 't' + i, x: (i % 6) * 2, y: Math.floor(i / 6), w: 2, h: 1, note: 'n'.repeat(400) });
    const lay = await request(P, 'POST', '/api/layout', { token: TOKEN, raw: JSON.stringify({ layout: tiles }) });
    assert.strictEqual(lay.status, 413);
    assert.deepStrictEqual(lay.json, { ok: false, error: 'request body too large (at most 8 KB)' });
    for (const p of ['/api/todo', '/api/todo/ops', '/api/command']) {
      const r = await request(P, 'POST', p, { token: TOKEN, raw: JSON.stringify({ title: 'x'.repeat(20000) }) });
      assert.strictEqual(r.status, 413, p);
      assert.ok(/at most 8 KB/.test(r.json.error), p);
    }
    const scr = await request(P, 'POST', '/todo/ops', { raw: JSON.stringify({ ops: [], pad: 'x'.repeat(20000) }) });
    assert.strictEqual(scr.status, 413);
  });

  await check('awws API: null clears everything; clearing again changes nothing', async () => {
    const before = (await request(P, 'GET', '/live/state')).json.rev;
    const r = await request(P, 'POST', '/api/awws', { token: TOKEN, body: { snapshot: null } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changed, true);
    assert.strictEqual(r.json.rev, before + 1);
    assert.ok(r.json.cleared.indexOf('todos') >= 0);
    assert.deepStrictEqual((await request(P, 'GET', '/api/awws', { token: TOKEN })).json.data, AWWS_EMPTY);
    const again = await request(P, 'POST', '/api/awws', { token: TOKEN, body: { snapshot: null } });
    assert.deepStrictEqual(again.json, { ok: true, rev: before + 1, changed: false, bytes: 0, accepted: [], cleared: [], rejected: [] });
    assert.strictEqual((await request(P, 'GET', '/live/state')).json.rev, before + 1);
  });

  await check('awws in the state file: survives a restart; an old file without it, or a damaged one, reads as empty', async () => {
    const d = tmpDir();
    const lines = [];
    const h2 = await start({ dataDir: d, log: (s) => lines.push(s) });
    const snap = awwsSample();
    await request(h2.port, 'POST', '/api/todo', { token: TOKEN, body: { title: 'Keep me too' } });
    const set = await request(h2.port, 'POST', '/api/awws', { token: TOKEN, body: { snapshot: snap } });
    assert.strictEqual(set.status, 200);
    await stop(h2);
    // The log notes the call without any of the snapshot's text.
    const note = lines.find((l) => /control POST \/api\/awws -> 200/.test(l));
    assert.ok(note && /7 sections stored, [\d.]+ KB, rev 2/.test(note), note);
    assert.ok(lines.every((l) => l.indexOf('Maple Grove') < 0 && l.indexOf('Luma') < 0));
    const h3 = await start({ dataDir: d });
    const g = (await request(h3.port, 'GET', '/api/awws', { token: TOKEN })).json;
    assert.strictEqual(g.rev, 2);
    assert.strictEqual(g.data.sentAt, snap.sentAt);
    assert.deepStrictEqual(awws.sectionsIn(g.data), ALL_SECTIONS);
    await stop(h3);
    // A file from before the snapshot existed.
    const old = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    delete old.resources.awws;
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(old));
    const h4 = await start({ dataDir: d });
    const s4 = (await request(h4.port, 'GET', '/live/state')).json;
    assert.deepStrictEqual(s4.resources.awws, { rev: 0, data: AWWS_EMPTY });
    assert.strictEqual(s4.epoch, old.epoch);
    assert.strictEqual(s4.resources.todo.data.items[0].title, 'Keep me too');
    await stop(h4);
    // A damaged one: the broken section goes, the rest of the file stays.
    const bent = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    bent.resources.awws = { rev: 5, data: { v: 1, sentAt: snap.sentAt, receivedAt: 'soon', khaya: { done: 9, total: 3 }, reach: { visits: { week: 1, prev: 2 } } } };
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(bent));
    const h5 = await start({ dataDir: d });
    const s5 = (await request(h5.port, 'GET', '/live/state')).json;
    assert.deepStrictEqual(s5.resources.awws, { rev: 5, data: { v: 1, sentAt: snap.sentAt, receivedAt: null, reach: { asOf: snap.sentAt, visits: { week: 1, prev: 2 } } } });
    assert.ok(!fs.readdirSync(d).some((f) => /^state\.bad-/.test(f)), 'not moved aside');
    await stop(h5);
  });

  /* ---------- personal budget snapshot ---------- */

  const BUDGET_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'budget-sample.json'), 'utf8');
  const budgetSample = () => {
    const s = JSON.parse(BUDGET_TEXT);
    s.sentAt = new Date(Date.now() - 60000).toISOString();
    return s;
  };

  await check('budget API: needs the token; starts empty; a snapshot is stored, pushed and survives a restart', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/budget')).status, 401);
    assert.strictEqual((await request(P, 'POST', '/api/budget', { body: { snapshot: null } })).status, 401);
    const g0 = await request(P, 'GET', '/api/budget', { token: TOKEN });
    assert.deepStrictEqual(g0.json, { ok: true, rev: 0, data: AWWS_EMPTY, tz: 'America/Chicago' });
    assert.deepStrictEqual((await request(P, 'GET', '/live/state')).json.resources.budget, { rev: 0, data: AWWS_EMPTY });
    const es = await openEvents(P);
    await es.waitFor((e) => e.event === 'hello');
    const snap = budgetSample();
    snap.alerts.items[0].amount = 6.5; // never stored
    const r = await request(P, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: snap } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.accepted, ['room', 'cardDay', 'goals', 'alerts', 'lab', 'merchants', 'pace', 'runway', 'investments']);
    const ch = await es.waitFor((e) => e.event === 'change' && e.data.resource === 'budget');
    assert.strictEqual(ch.data.data.room.cap, 60);
    assert.deepStrictEqual(ch.data.data.alerts.items[0], { id: 'a-1042', label: 'Corner Bakery Stand' });
    assert.strictEqual(ch.data.data.merchants.items.length, 5);
    assert.strictEqual(ch.data.data.runway.steps.length, 3);
    es.close();
    await waitUntil(() => h._debug().sse === 0);
    // A bad section is refused by name; a snapshot with no good section is a 400.
    const part = await request(P, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: { v: 1, sentAt: new Date().toISOString(), goals: [], room: { cap: 0 } } } });
    assert.strictEqual(part.status, 200);
    assert.deepStrictEqual(part.json.rejected.map((x) => x.section), ['room']);
    const no = await request(P, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: { v: 1, sentAt: new Date().toISOString(), room: { cap: 0 } } } });
    assert.strictEqual(no.status, 400);
    const m = await request(P, 'PUT', '/api/budget', { token: TOKEN, body: { snapshot: null } });
    assert.strictEqual(m.status, 405);
    const g = (await request(P, 'GET', '/api/budget', { token: TOKEN })).json;
    assert.strictEqual(g.data.room.roomPerDay, 42.5);
    assert.deepStrictEqual(g.data.goals.items, []);
    const c = await request(P, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: null } });
    assert.deepStrictEqual(c.json.cleared, ['room', 'cardDay', 'goals', 'alerts', 'lab', 'merchants', 'pace', 'runway', 'investments']);
    assert.deepStrictEqual((await request(P, 'GET', '/api/budget', { token: TOKEN })).json.data, AWWS_EMPTY);
    // Kept in data/state.json, and a file from before budget existed still loads.
    const d = tmpDir();
    const h2 = await start({ dataDir: d });
    await request(h2.port, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: budgetSample() } });
    await stop(h2);
    const h3 = await start({ dataDir: d });
    assert.strictEqual((await request(h3.port, 'GET', '/api/budget', { token: TOKEN })).json.data.cardDay.daysAway, 3);
    await stop(h3);
    const old = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    delete old.resources.budget;
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(old));
    const h4 = await start({ dataDir: d });
    assert.deepStrictEqual((await request(h4.port, 'GET', '/live/state')).json.resources.budget, { rev: 0, data: AWWS_EMPTY });
    await stop(h4);
  });

  await stop(h);

  /* ---------- allow-list over HTTP ---------- */

  await check('screen API refuses public addresses with 403 "screen not allowed"', async () => {
    const h2 = await start({ clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress });
    for (const ip of ['8.8.8.8', '::ffff:1.2.3.4']) {
      for (const [m, p] of [['GET', '/live/state'], ['GET', '/live/events'], ['GET', '/live/poll'], ['POST', '/todo/ops']]) {
        const r = await request(h2.port, m, p, { headers: { 'x-test-ip': ip }, body: m === 'POST' ? { ops: [] } : undefined });
        assert.strictEqual(r.status, 403, ip + ' ' + p);
        assert.deepStrictEqual(r.json, { ok: false, error: 'screen not allowed' });
      }
    }
    assert.strictEqual((await request(h2.port, 'GET', '/live/state', { headers: { 'x-test-ip': '192.168.1.9' } })).status, 200);
    assert.strictEqual(h2._debug().sse, 0);
    await stop(h2);
  });

  await check('screen API refuses a request whose Host is another site\'s name', async () => {
    const h2 = await start();
    for (const host of ['evil.example.com', 'evil.example.com:8097', '192.168.1.219.evil.example.com']) {
      const r = await request(h2.port, 'GET', '/live/state', { headers: { Host: host } });
      assert.strictEqual(r.status, 403, host);
    }
    for (const host of ['192.168.1.219:8097', '127.0.0.1', 'localhost:8097', 'raspberrypi.local:8097', '[::1]:8097']) {
      const r = await request(h2.port, 'GET', '/live/state', { headers: { Host: host } });
      assert.strictEqual(r.status, 200, host);
    }
    await stop(h2);
  });

  await check('HUB_TV_IPS: only the listed TV plus loopback', async () => {
    const h2 = await start({ tvIps: '192.168.1.50, 192.168.1.51', clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress });
    const get = (ip) => request(h2.port, 'GET', '/live/state', { headers: ip ? { 'x-test-ip': ip } : {} });
    assert.strictEqual((await get('192.168.1.50')).status, 200);
    assert.strictEqual((await get('::ffff:192.168.1.51')).status, 200);
    assert.strictEqual((await get('192.168.1.60')).status, 403);
    assert.strictEqual((await get(null)).status, 200);
    await stop(h2);
  });

  /* ---------- no token / short token ---------- */

  await check('no token or a short token: control API 503, screens still work', async () => {
    for (const token of [undefined, 'short-token']) {
      const h2 = await start({ token: token });
      const r = await request(h2.port, 'GET', '/api/status', { token: 'short-token' });
      assert.strictEqual(r.status, 503);
      assert.deepStrictEqual(r.json, { ok: false, error: 'no token set on the server' });
      assert.strictEqual((await request(h2.port, 'GET', '/live/state')).status, 200);
      assert.strictEqual((await request(h2.port, 'GET', '/health')).status, 200);
      await stop(h2);
    }
  });

  /* ---------- side door ---------- */

  await check('side door: control API and /health only, screen routes are 404', async () => {
    const h2 = await start({ tunnelPort: 0 });
    assert.ok(h2.tunnelPort > 0 && h2.tunnelPort !== h2.port);
    const T = h2.tunnelPort;
    assert.strictEqual((await request(T, 'GET', '/health')).status, 200);
    assert.strictEqual((await request(T, 'GET', '/api/status', { token: TOKEN })).status, 200);
    assert.strictEqual((await request(T, 'GET', '/api/status')).status, 401);
    const c = await request(T, 'POST', '/api/command', { token: TOKEN, body: { type: 'home' } });
    assert.deepStrictEqual(c.json, { ok: true, delivered: 0 });
    for (const [m, p] of [['GET', '/live/state'], ['GET', '/live/events'], ['GET', '/live/poll'], ['POST', '/todo/ops'], ['OPTIONS', '/todo/ops']]) {
      const r = await request(T, m, p, { body: m === 'POST' ? { ops: [] } : undefined });
      assert.strictEqual(r.status, 404, p);
    }
    assert.strictEqual(h2._debug().sse, 0);
    await stop(h2);
  });

  await check('logs never contain the token', async () => {
    const lines = [];
    const h2 = await start({ log: (s) => lines.push(s), tunnelPort: 0 });
    await request(h2.port, 'GET', '/api/status', { token: TOKEN });
    await request(h2.port, 'GET', '/api/status', { token: 'wrong' });
    await stop(h2);
    assert.ok(lines.length >= 3);
    assert.ok(lines.every((l) => l.indexOf(TOKEN) < 0));
    assert.ok(lines.some((l) => /control GET \/api\/status -> 200/.test(l)));
  });

  /* ---------- recent log lines (GET /api/log, logscrub.js) ---------- */

  await check('scrub: IPv4 and IPv6 addresses (also ::ffff: forms) become [address]', () => {
    assert.strictEqual(logscrub.scrub('screen connected (live line) 192.168.1.20'), 'screen connected (live line) [address]');
    assert.strictEqual(logscrub.scrub('screen connected (poll) ::ffff:192.168.1.5'), 'screen connected (poll) [address]');
    assert.strictEqual(logscrub.scrub('from ::1, fe80::1%eth0 and fd12:3456::1.'), 'from [address], [address] and [address].');
    assert.strictEqual(logscrub.scrub('2001:db8:0:0:0:0:2:1 and [::1]:8097'), '[address] and [[address]]:8097');
  });

  await check('scrub: secret names in any case, longest first; short ones ignored', () => {
    const secrets = ['Rosen Family', 'Rosen', 'ab', '', null];
    assert.strictEqual(logscrub.scrub('calendar rOSEN fAMILY: timed out', secrets), 'calendar [name]: timed out');
    assert.strictEqual(logscrub.scrub('Rosen and ROSEN', secrets), '[name] and [name]');
    assert.strictEqual(logscrub.scrub('ab cab abc', ['ab']), 'ab cab abc');
    assert.strictEqual(logscrub.scrub('a.b(c) here', ['a.b(c)']), '[name] here', 'regex characters are plain text');
  });

  await check('scrub: cut to 300 characters; a line with nothing to hide is unchanged', () => {
    assert.strictEqual(logscrub.scrub('x'.repeat(500)).length, 300);
    const plain = 'control GET /api/status -> 200 at 15:10:00, server 0.9.0, rev 12, 2026-11-17T15:10:00.000Z';
    assert.strictEqual(logscrub.scrub(plain, ['Rosen Family']), plain);
    assert.strictEqual(logscrub.scrub(''), '');
  });

  await check('log level: real problems are error, everyday lines are info', () => {
    const error = [
      'control GET /api/log -> 400', 'control POST /api/todo -> 500', 'control GET /api/status -> 401',
      'Claude mailbox: todo.add (c123456) -> failed', 'Claude mailbox: rejected cmd1 (the file is not valid JSON)',
      'Claude mailbox: cannot reach R2 (R2 did not answer in time); trying again quietly, up to once a minute',
      'Claude mailbox: c1234567 was interrupted by a restart; marked as not finished',
      'Claude mailbox: off (HUB_MAILBOX_ACCESS_KEY_ID missing in pi/.env)',
      'the data file was damaged (missing epoch, rev or resources); moved it to x and started fresh',
      'could not save the data file: EACCES', 'error: boom', 'final save failed: EROFS',
      'unexpected error (still running): TypeError: x', 'main door could not listen on port 8097: that port is already in use',
      'HUB_TIMEZONE "Mars/Base" is not a known time zone; using America/Chicago',
      'CALENDAR_REFRESH_MINUTES is not a number; using 15', 'calendar Work: timed out',
      'calendar Work: could not be reached (connection refused)', 'calendar Work: did not look like a calendar',
      'calendar Work: the link must start with https://, skipped', 'calendar: the refresh failed (TypeError)',
      'Spotify: the sign-in is no longer good; run ./hub spotify login', 'Spotify: unexpected problem (x)',
      'Spotify: could not save the renewed sign-in (EACCES)', 'Spotify: refused the request (403)',
      'Spotify: did not accept the client ID or secret in pi/.env', 'Spotify: off (SPOTIFY_CLIENT_ID is missing in pi/.env)',
      'Vibe: could not save vibes.json (EACCES)', 'no token set (or shorter than 24 characters): the control API is off, screens still work'
    ];
    const info = [
      'screen connected (live line) 192.168.1.20', 'screen disconnected (live line) 192.168.1.20 (write error)',
      'screen connected (poll) ::ffff:192.168.1.5', 'control GET /api/status -> 200',
      'control POST /api/awws -> 200 3 sections stored, 1 rejected, 12.4 KB, rev 58', 'calendar changed: 12 events (rev 40)',
      'calendars: Family, Work (busy only); time zone America/Chicago', 'calendar Work: can be read again',
      'Claude mailbox: todo.add (c123456) -> ok', 'Claude mailbox: connected to bucket home-hub-mailbox',
      'Claude mailbox: connected again after 3 failed tries', 'Claude mailbox: off (no HUB_MAILBOX_ settings in .env)',
      'Home Hub live server 0.9.0 listening on port 8097', 'started a new data file /app/data/state.json',
      'Spotify: signed in, watching what plays', 'Spotify: set up, not signed in yet (run ./hub spotify login)',
      'Spotify: working again', 'SIGTERM received, stopping', 'side door (control API only) on 127.0.0.1:8098'
    ];
    error.forEach((t) => assert.strictEqual(logscrub.level(t), 'error', t));
    info.forEach((t) => assert.strictEqual(logscrub.level(t), 'info', t));
  });

  const logHub = await start({
    allowHttp: true, calendarTimeout: 400,
    calendars: [{ name: 'Rosen Family', url: 'http://127.0.0.1:1/family.ics' }]
  });
  const LP = logHub.port;
  const getLog = (q, token) => request(LP, 'GET', '/api/log' + (q || ''), { token: token === undefined ? TOKEN : token });

  await check('GET /api/log needs the token, and only GET', async () => {
    assert.strictEqual((await getLog('', null)).status, 401);
    assert.strictEqual((await getLog('', 'wrong')).status, 401);
    const r = await request(LP, 'POST', '/api/log', { token: TOKEN, body: {} });
    assert.strictEqual(r.status, 405);
    assert.strictEqual(r.headers.allow, 'GET');
  });

  await check('GET /api/log: { ok, lines: [{ t, text, level }], errors24h, kept }, 50 lines by default', async () => {
    await waitUntil(() => logHub._debug().calendar.refreshing === false, 3000);
    for (let i = 0; i < 60; i++) await request(LP, 'GET', '/api/status', { token: TOKEN });
    const r = await getLog();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['errors24h', 'kept', 'lines', 'ok']);
    assert.strictEqual(r.json.lines.length, 50);
    r.json.lines.forEach((l) => {
      assert.deepStrictEqual(Object.keys(l), ['t', 'text', 'level']);
      assert.ok(isFinite(Date.parse(l.t)) && /Z$/.test(l.t));
      assert.ok(!/^\d{4}-\d{2}-\d{2} /.test(l.text), 'no time stamp in the text');
    });
    assert.strictEqual(r.json.lines[49].text, 'control GET /api/status -> 200');
    assert.strictEqual(r.json.lines[49].level, 'info');
    assert.ok(r.json.kept >= 62 && r.json.kept <= 400);
    assert.ok(r.json.errors24h >= 1, 'the calendar that cannot be reached counts');
  });

  await check('GET /api/log: lines and errors are checked; bad values are 400', async () => {
    assert.strictEqual((await getLog('?lines=1')).json.lines.length, 1);
    assert.strictEqual((await getLog('?lines=200')).json.lines.length, Math.min(200, (await getLog()).json.kept));
    for (const q of ['?lines=0', '?lines=201', '?lines=-1', '?lines=abc', '?lines=1.5', '?lines=', '?errors=yes', '?errors=2', '?scrub=true']) {
      const r = await getLog(q);
      assert.strictEqual(r.status, 400, q);
      assert.strictEqual(r.json.ok, false, q);
    }
    assert.ok(/"lines" must be a whole number from 1 to 200/.test((await getLog('?lines=500')).json.error));
    const e = await getLog('?errors=1&lines=200');
    assert.ok(e.json.lines.length >= 1);
    assert.ok(e.json.lines.every((l) => l.level === 'error'));
    assert.ok(e.json.lines.some((l) => /control GET \/api\/log -> 400/.test(l.text)), 'a bad call to /api/log is kept');
    assert.strictEqual((await getLog('?errors=0&lines=3')).json.lines.length, 3);
  });

  await check('reading the log does not fill it', async () => {
    const a = (await getLog()).json.kept;
    const b = (await getLog('?lines=5')).json.kept;
    const c = (await getLog('?errors=1&scrub=1')).json.kept;
    assert.strictEqual(b, a);
    assert.strictEqual(c, a);
    assert.ok((await getLog('?lines=200')).json.lines.every((l) => !/control GET \/api\/log -> 200/.test(l.text)));
  });

  await check('the ring keeps the last 400 lines', async () => {
    for (let i = 0; i < 420; i++) logHub.note('filler ' + i);
    const r = await getLog('?lines=1');
    assert.strictEqual(r.json.kept, 400);
    assert.strictEqual(r.json.lines[0].text, 'filler 419');
  });

  await check('GET /api/log?scrub=1 hides the calendar name and the screen address; plain keeps them', async () => {
    const ev = await openEvents(LP);
    await ev.waitFor((e) => e.event === 'hello');
    logHub.note('calendar Rosen Family: could not be reached (connection refused)');
    const raw = (await getLog('?lines=10')).json.lines.map((l) => l.text).join('\n');
    assert.ok(raw.indexOf('Rosen Family') >= 0);
    assert.ok(/screen connected \(live line\) (::ffff:)?127\.0\.0\.1/.test(raw), raw);
    const lines = (await getLog('?lines=10&scrub=1')).json.lines;
    const text = lines.map((l) => l.text).join('\n');
    assert.ok(text.indexOf('Rosen') < 0, text);
    assert.ok(text.indexOf('127.0.0.1') < 0 && text.indexOf('::ffff') < 0, text);
    assert.ok(text.indexOf('screen connected (live line) [address]') >= 0, text);
    assert.ok(text.indexOf('calendar [name]: could not be reached (connection refused)') >= 0, text);
    assert.strictEqual(lines[lines.length - 2].level, 'info');
    assert.strictEqual(lines[lines.length - 1].level, 'error', 'the level comes from the unscrubbed line');
    ev.close();
  });

  await check('./hub log text: local time, the line, then the count', () => {
    const r = { ok: true, errors24h: 3, kept: 2, lines: [
      { t: '2026-11-17T15:10:00.000Z', text: 'calendar changed: 3 events (rev 4)', level: 'info' },
      { t: '2026-11-17T15:11:00.000Z', text: 'calendar Work: timed out', level: 'error' }] };
    const out = hubctl.logLines(r, false);
    assert.strictEqual(out.length, 3);
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} calendar changed: 3 events \(rev 4\)$/.test(out[0]), out[0]);
    assert.strictEqual(out[2], '3 problems in the last 24 hours.');
    assert.deepStrictEqual(hubctl.logLines({ lines: [], errors24h: 1 }, true), ['No problems in the log the server keeps.', '1 problem in the last 24 hours.']);
    assert.strictEqual(hubctl.logSummaryText(r, false), '2 lines, 3 problems in the last 24 hours.');
    assert.strictEqual(hubctl.logQuery(120, true, true), '/api/log?lines=120&errors=1&scrub=1');
    assert.strictEqual(hubctl.logQuery(undefined, false, false), '/api/log');
  });
  await stop(logHub);

  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
