/*
 * Tests for the daily spending goal's history (budgetgoal.js) and its
 * routes in server.js: node pi/budgetgoal-test.js
 *
 * The history's rules (whole dollars 1-1,000, oldest first, a date once, a
 * change never rewrites a past day, at most 200 entries), the goal in force
 * on a date, the merge into the budget's pace section, and on a real server:
 * POST /budget/goal from the TV, POST/GET /api/budget/goal with the token,
 * the push to screens as pace.goals, the budget app unable to send or
 * overwrite it, the history surviving a restart, and log lines with no amount.
 * Prints one line per check, then "N passed, M failed". Node only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('./budgetgoal');
const hubServer = require('./server');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const SAMPLE_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'budget-sample.json'), 'utf8');
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-goal-'));
  dirs.push(d);
  return d;
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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function throws(fn, re) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'did not throw');
  assert.strictEqual(err.status, 400);
  assert.ok(re.test(err.message), err.message);
}

async function main() {
  await check('setGoal: whole dollars 1-1,000, from a date on, the same date replaced, never before the last change', () => {
    let r = G.setGoal([], 60, '2026-11-24');
    assert.deepStrictEqual(r, { history: [{ from: '2026-11-24', goal: 60 }], changed: true });
    r = G.setGoal(r.history, 55, '2026-11-24');
    assert.deepStrictEqual(r.history, [{ from: '2026-11-24', goal: 55 }], 'same day replaced');
    r = G.setGoal(r.history, 50, '2026-11-26');
    assert.deepStrictEqual(r.history, [{ from: '2026-11-24', goal: 55 }, { from: '2026-11-26', goal: 50 }]);
    assert.strictEqual(G.setGoal(r.history, 50, '2026-11-27').changed, false, 'the goal already in force');
    throws(() => G.setGoal(r.history, 40, '2026-11-25'), /applies from today on/);
    throws(() => G.setGoal([], 0, '2026-11-24'), /whole number of dollars from 1 to 1,000/);
    throws(() => G.setGoal([], 1001, '2026-11-24'), /from 1 to 1,000/);
    throws(() => G.setGoal([], 60.5, '2026-11-24'), /whole number/);
    throws(() => G.setGoal([], '60', '2026-11-24'), /whole number/);
    throws(() => G.setGoal([], 60, '2026-02-30'), /"date"/);
  });

  await check('cleanHistory: bad entries dropped, oldest first, a date once, at most 200; goalOn', () => {
    const h = G.cleanHistory([{ from: '2026-11-26', goal: 50 }, null, { from: 'soon', goal: 5 }, { from: '2026-11-20', goal: 60 }, { from: '2026-11-21', goal: 0 }]);
    assert.deepStrictEqual(h, [{ from: '2026-11-20', goal: 60 }, { from: '2026-11-26', goal: 50 }]);
    assert.strictEqual(G.goalOn(h, '2026-11-19'), null, 'before the first entry: no goal');
    assert.strictEqual(G.goalOn(h, '2026-11-25'), 60);
    assert.strictEqual(G.goalOn(h, '2026-11-26'), 50);
    const many = [];
    for (let i = 0; i < 230; i++) many.push({ from: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), goal: 60 });
    const c = G.cleanHistory(many);
    assert.strictEqual(c.length, G.MAX_ENTRIES);
    assert.strictEqual(c[0].from, many[30].from, 'the oldest go first');
  });

  await check('attach: pace.goals on a copy, only with a pace section; texts carry no amount', () => {
    const data = { v: 1, sentAt: 'x', pace: { days: [] } };
    const out = G.attach(data, [{ from: '2026-11-24', goal: 60 }]);
    assert.deepStrictEqual(out.pace.goals, [{ from: '2026-11-24', goal: 60 }]);
    assert.ok(!data.pace.goals, 'the input is left alone');
    assert.ok(!('goals' in G.attach(out, []).pace), 'an empty history removes it');
    assert.deepStrictEqual(G.attach({ v: 1 }, [{ from: '2026-11-24', goal: 60 }]), { v: 1 });
    const t = G.setText({ changed: true, from: '2026-11-24' }) + G.showText([{ from: '2026-11-24', goal: 60 }]);
    assert.ok(!/60/.test(t), t);
    assert.strictEqual(G.showText([]), 'No daily goal yet. Budget lab on the TV asks for one.');
  });

  await check('server: the TV sets the goal, it is pushed as pace.goals, the budget app cannot overwrite it, and it survives a restart', async () => {
    const dir = tmpDir();
    const lines = [];
    const now = () => new Date('2026-11-24T18:00:00Z');
    let h = hubServer.start({ port: 0, token: TOKEN, log: (s) => lines.push(s), dataDir: dir, timezone: 'America/Chicago', now: now, calendars: [] });
    await h.ready;
    try {
      const snap = JSON.parse(SAMPLE_TEXT);
      snap.sentAt = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
      snap.pace.goals = [{ from: '2020-01-01', goal: 999 }];
      snap.pace.goal = 999;
      assert.strictEqual((await request(h.port, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: snap } })).status, 200);
      let pace = (await request(h.port, 'GET', '/live/state')).json.resources.budget.data.pace;
      assert.ok(!('goals' in pace) && !('goal' in pace), 'the budget app never sends the goal');
      assert.deepStrictEqual((await request(h.port, 'GET', '/api/budget/goal', { token: TOKEN })).json.goals, []);

      assert.strictEqual((await request(h.port, 'POST', '/budget/goal', { body: { goal: 0 } })).status, 400);
      const r = await request(h.port, 'POST', '/budget/goal', { body: { goal: 60 } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.from, '2026-11-24', 'the Pi\'s local date');
      assert.strictEqual(r.json.changed, true);
      pace = (await request(h.port, 'GET', '/live/state')).json.resources.budget.data.pace;
      assert.deepStrictEqual(pace.goals, [{ from: '2026-11-24', goal: 60 }]);
      assert.deepStrictEqual((await request(h.port, 'GET', '/api/budget', { token: TOKEN })).json.data.pace.goals, pace.goals);

      // A new snapshot from the budget app keeps the Pi's history on.
      snap.sentAt = new Date(Date.now() - 30000).toISOString().replace(/\.\d+Z$/, 'Z');
      await request(h.port, 'POST', '/api/budget', { token: TOKEN, body: { snapshot: snap } });
      pace = (await request(h.port, 'GET', '/live/state')).json.resources.budget.data.pace;
      assert.deepStrictEqual(pace.goals, [{ from: '2026-11-24', goal: 60 }]);

      // The control API: needs the token, same rules.
      assert.strictEqual((await request(h.port, 'POST', '/api/budget/goal', { body: { goal: 55 } })).status, 401);
      const c = await request(h.port, 'POST', '/api/budget/goal', { token: TOKEN, body: { goal: 55 } });
      assert.deepStrictEqual(c.json.goals, [{ from: '2026-11-24', goal: 55 }]);
      assert.ok(lines.some((l) => /screen set the daily budget goal \(from 2026-11-24\)/.test(l)), lines.join('\n'));
      assert.ok(!lines.some((l) => /goal.*\b(55|60)\b/.test(l)), 'no amount in the log');
    } finally {
      await new Promise((res) => h.close(res));
    }
    // Kept in data/budget-goal.json and back on after a restart.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'budget-goal.json'), 'utf8')), { v: 1, history: [{ from: '2026-11-24', goal: 55 }] });
    h = hubServer.start({ port: 0, token: TOKEN, log: false, dataDir: dir, timezone: 'America/Chicago', now: now, calendars: [] });
    await h.ready;
    try {
      const pace = (await request(h.port, 'GET', '/live/state')).json.resources.budget.data.pace;
      assert.deepStrictEqual(pace.goals, [{ from: '2026-11-24', goal: 55 }]);
    } finally {
      await new Promise((res) => h.close(res));
    }
  });

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* left behind */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
