/*
 * Tests for Budget lab's planned buys (budgetplanned.js, the budget
 * snapshot's planned section in budget.js, and POST /budget/planned in
 * server.js): node pi/budgetplanned-test.js
 *
 * The change a screen may send (add, edit, remove; label, amount, date),
 * the request each makes to the budget app, the snapshot section's rules,
 * and on a real server with a stand-in budget app: the change passed on
 * with the token, the budget app's list pushed to screens at once, a
 * refusal and a budget app that is down, and log lines with no label or
 * amount. Dates are relative to today. Prints one line per check, then
 * "N passed, M failed". Node only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const P = require('./budgetplanned');
const budget = require('./budget');
const hubServer = require('./server');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const SAMPLE_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'budget-sample.json'), 'utf8');
let passed = 0;
let failed = 0;
const dirs = [];

function day(offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); }

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

function throws(fn, re, status) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'did not throw');
  if (status) assert.strictEqual(err.status, status);
  assert.ok(re.test(err.message), err.message);
}

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = {};
    const body = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A stand-in budget app: keeps a list, answers like the real one.
function fakeBudgetApp() {
  const seen = [];
  let items = [{ id: 'a1b2c3d4', label: 'Winter boots', amount: 120, date: day(5), match: null, state: 'upcoming' }];
  let next = 2;
  let refuse = false;
  const srv = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const body = text ? JSON.parse(text) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: body });
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (refuse) return send(400, { ok: false, error: 'that date is too far off' });
      const m = /^\/api\/planned(?:\/([^/]+))?(\/unmatch)?$/.exec(req.url);
      if (!m) return send(404, { error: 'not found' });
      let code = 200;
      if (req.method === 'POST' && m[2]) items = items.map((i) => (i.id === m[1] ? Object.assign({}, i, { state: 'upcoming' }) : i));
      else if (req.method === 'POST') { items.push(Object.assign({ id: 'e0e0e0' + (10 + next++), date: null, match: null, state: 'upcoming' }, body)); code = 201; }
      else if (req.method === 'PUT') items = items.map((i) => (i.id === m[1] ? Object.assign({}, i, body) : i));
      else if (req.method === 'DELETE') items = items.filter((i) => i.id !== m[1]);
      send(code, { asOf: 'whenever', cardDay: day(4), items: items });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    srv: srv, port: srv.address().port, seen: seen, refuse: (on) => { refuse = on; }
  })));
}

async function main() {
  await check('checkOp: add needs a label and an amount over 0, date and shop optional; edit, remove and unmatch need an id', () => {
    assert.deepStrictEqual(P.checkOp({ op: 'add', label: '  Winter\nboots ', amount: 119.999, date: '2026-12-04', match: ' Zappos ' }),
      { op: 'add', label: 'Winter boots', amount: 120, date: '2026-12-04', match: 'Zappos' });
    assert.deepStrictEqual(P.checkOp({ op: 'add', label: 'Rug', amount: 5 }), { op: 'add', label: 'Rug', amount: 5, date: null, match: null });
    assert.deepStrictEqual(P.checkOp({ op: 'remove', id: 'p-12', label: 'ignored' }), { op: 'remove', id: 'p-12' });
    assert.deepStrictEqual(P.checkOp({ op: 'unmatch', id: '3f9a12c0' }), { op: 'unmatch', id: '3f9a12c0' });
    throws(() => P.checkOp({ op: 'buy' }), /"op"/, 400);
    throws(() => P.checkOp({ op: 'add', label: '', amount: 5, date: '2026-12-04' }), /"label"/, 400);
    throws(() => P.checkOp({ op: 'add', label: 'x'.repeat(25), amount: 5, date: '2026-12-04' }), /at most 24/, 400);
    throws(() => P.checkOp({ op: 'add', label: 'Boots', amount: 5, match: 'y'.repeat(41) }), /at most 40/, 400);
    throws(() => P.checkOp({ op: 'add', label: 'see www.shop.example', amount: 5, date: '2026-12-04' }), /link/, 400);
    throws(() => P.checkOp({ op: 'add', label: 'Boots', amount: 0, date: '2026-12-04' }), /"amount"/, 400);
    throws(() => P.checkOp({ op: 'add', label: 'Boots', amount: 5, date: '2026-02-30' }), /"date"/, 400);
    throws(() => P.checkOp({ op: 'edit', label: 'Boots', amount: 5, date: '2026-12-04' }), /"id"/, 400);
  });

  await check('requestFor and listFrom: the budget app\'s paths, and its list in either form', () => {
    assert.deepStrictEqual(P.requestFor({ op: 'add', label: 'A', amount: 1, date: '2026-12-04', match: null }),
      { method: 'POST', path: '/api/planned', body: { label: 'A', amount: 1, date: '2026-12-04' } });
    assert.deepStrictEqual(P.requestFor({ op: 'edit', id: 'p-1', label: 'A', amount: 1, date: null, match: null }),
      { method: 'PUT', path: '/api/planned/p-1', body: { label: 'A', amount: 1, date: null, match: null } });
    assert.deepStrictEqual(P.requestFor({ op: 'remove', id: 'p-1' }), { method: 'DELETE', path: '/api/planned/p-1', body: null });
    assert.deepStrictEqual(P.requestFor({ op: 'unmatch', id: 'p-1' }), { method: 'POST', path: '/api/planned/p-1/unmatch', body: null });
    assert.deepStrictEqual(P.listFrom({ asOf: 'x', cardDay: '2026-12-01', items: [] }), { items: [], cardDay: '2026-12-01' });
    assert.deepStrictEqual(P.listFrom({ planned: { items: [] } }), { items: [] });
    throws(() => P.listFrom({ ok: true }), /list back/, 502);
  });

  await check('snapshot: the planned section is checked, matched ones keep when and what matched, show prints counts only', () => {
    const items = [
      { id: 'p-1', label: 'Winter boots', amount: 120, date: day(5), match: null, state: 'upcoming', matchedDate: day(1) },
      { id: 'p-2', label: 'Gift', amount: 40, date: day(-3), state: 'overdue' },
      { id: 'p-3', label: 'Desk lamp', amount: 35, date: day(-2), match: 'lamps', state: 'matched', matchedDate: day(-1), matchedAmount: 34.5 },
      { id: 'p-4', label: 'Sofa', amount: 900, date: null, state: 'later' }
    ];
    const s = budget.checkSection('planned', { cardDay: day(4), items: items }, '2026-11-27T12:00:00Z');
    assert.strictEqual(s.cardDay, day(4));
    assert.strictEqual(s.items.length, 4);
    assert.ok(!('matchedDate' in s.items[0]), 'only a matched buy keeps matchedDate');
    assert.deepStrictEqual([s.items[2].matchedAmount, s.items[2].match], [34.5, 'lamps']);
    assert.deepStrictEqual([s.items[3].date, s.items[3].match, s.items[1].match], [null, null, null]);
    assert.throws(() => budget.checkSection('planned', { items: [{ id: 'p-1', label: 'A', amount: 1, date: day(1), state: 'bought' }] }));
    const snap = JSON.parse(SAMPLE_TEXT);
    snap.sentAt = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    snap.planned = { items: items };
    const n = budget.normalizeSnapshot(snap, Date.now());
    const lines = budget.summaryLines(budget.merge(budget.emptyData(), n, Date.now()).data).join('\n');
    assert.ok(/4 planned buys \(1 upcoming, 1 later, 1 overdue, 1 matched\)/.test(lines), lines);
    assert.ok(!/boots|Gift|Lamp|120|34/.test(lines), 'no label, shop or amount: ' + lines);
  });

  await check('server: a change goes to the budget app with the token, its list reaches screens at once, logs say no label or amount', async () => {
    const app = await fakeBudgetApp();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-planned-'));
    dirs.push(dir);
    const lines = [];
    const h = hubServer.start({ port: 0, token: TOKEN, log: (s) => lines.push(s), dataDir: dir, calendars: [],
      budgetApp: { url: 'http://127.0.0.1:' + app.port, token: 'budget-app-token' } });
    await h.ready;
    try {
      const snap = JSON.parse(SAMPLE_TEXT);
      snap.sentAt = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
      assert.strictEqual((await request(h.port, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: snap } })).status, 200);

      let r = await request(h.port, 'POST', '/budget/planned', { body: { op: 'add', label: 'Concert tickets', amount: 85, date: day(10) } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(app.seen[0], { method: 'POST', url: '/api/planned', auth: 'Bearer budget-app-token', body: { label: 'Concert tickets', amount: 85, date: day(10) } });
      assert.strictEqual(r.json.planned.cardDay, day(4));
      let planned = (await request(h.port, 'GET', '/live/state')).json.resources.budget.data.planned;
      assert.deepStrictEqual(planned.items.map((i) => i.label), ['Winter boots', 'Concert tickets']);

      const added = r.json.planned.items[1].id;
      r = await request(h.port, 'POST', '/budget/planned', { body: { op: 'edit', id: added, label: 'Concert tickets', amount: 90, date: null } });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([r.json.planned.items[1].amount, r.json.planned.items[1].date], [90, null]);
      assert.deepStrictEqual(app.seen[1].body, { label: 'Concert tickets', amount: 90, date: null, match: null });
      r = await request(h.port, 'POST', '/budget/planned', { body: { op: 'unmatch', id: added } });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([app.seen[2].method, app.seen[2].url], ['POST', '/api/planned/' + added + '/unmatch']);
      r = await request(h.port, 'POST', '/budget/planned', { body: { op: 'remove', id: 'a1b2c3d4' } });
      planned = (await request(h.port, 'GET', '/live/state')).json.resources.budget.data.planned;
      assert.deepStrictEqual(planned.items.map((i) => i.id), [added]);

      // A refusal comes back as a 400 with the budget app's reason; nothing changes.
      app.refuse(true);
      r = await request(h.port, 'POST', '/budget/planned', { body: { op: 'add', label: 'Rug', amount: 200, date: day(400) } });
      assert.strictEqual(r.status, 400);
      assert.ok(/too far off/.test(r.json.error), r.json.error);
      assert.strictEqual((await request(h.port, 'POST', '/budget/planned', { body: { op: 'add', label: '', amount: 1, date: day(1) } })).status, 400);

      // Down: a 502 and one log line.
      await new Promise((res) => app.srv.close(res));
      r = await request(h.port, 'POST', '/budget/planned', { body: { op: 'remove', id: added } });
      assert.strictEqual(r.status, 502);

      const text = lines.join('\n');
      assert.ok(/screen added a planned buy/.test(text) && /screen changed a planned buy/.test(text) && /screen removed a planned buy/.test(text) &&
        /screen said a planned buy's charge was not it/.test(text), text);
      assert.ok(/planned buy: the budget app is not answering/.test(text), text);
      assert.ok(!/Concert|Rug|boots|\b85\b|\b90\b|budget-app-token/.test(text), 'no label, amount or token in the log');
    } finally {
      await new Promise((res) => h.close(res));
      try { app.srv.close(); } catch (e) { /* closed */ }
    }
  });

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* left behind */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
