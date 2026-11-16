/*
 * Tests for the A World Worth Saving snapshot checks (awws.js). Run from the
 * repo root with:
 *
 *   node pi/awws-test.js
 *
 * It checks the made-up sample in pi/fixtures, every section's rules, merging,
 * the size cap and the texts ./hub prints. The HTTP side is in pi/test.js and
 * the mailbox side in pi/mailbox-test.js. It prints one line per check, then
 * "N passed, 0 failed". Only what ships with Node is used.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const awws = require('./awws');

const NOW = Date.parse('2026-11-16T15:12:00Z');
const SENT = '2026-11-16T15:10:00Z';
const SAMPLE_FILE = path.join(__dirname, 'fixtures', 'awws-sample.json');
const SAMPLE_TEXT = fs.readFileSync(SAMPLE_FILE, 'utf8');
let passed = 0;
let failed = 0;

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

const copy = (v) => JSON.parse(JSON.stringify(v));
const sample = () => JSON.parse(SAMPLE_TEXT);

function snap(sections) {
  return Object.assign({ v: 1, sentAt: SENT }, sections);
}

// Normalizes and expects a 400 for the snapshot as a whole.
function throws400(raw, re, nowMs) {
  let err = null;
  try { awws.normalizeSnapshot(raw, nowMs === undefined ? NOW : nowMs); } catch (e) { err = e; }
  assert.ok(err, 'was accepted');
  assert.strictEqual(err.status, 400);
  assert.ok(re.test(err.message), err.message);
  return err;
}

// One section alone: its clean copy, or its error text.
function one(name, section) {
  const s = {};
  s[name] = section;
  const n = awws.normalizeSnapshot(snap(s), NOW);
  if (n.rejected.length) return { error: n.rejected[0].error, rejected: n.rejected };
  return { clean: n.sections[name] };
}

function todo(over) {
  return Object.assign({ id: 'a1', title: 'Water the plants', owner: 'ian', section: 'now' }, over || {});
}

function todosWith(items) {
  return { items: items };
}

const MIN = {
  todos: { items: [] },
  handoffs: { open: 0, blocked: 0 },
  outreach: { replied: 0, booked: 0, visited: 0, waitingOnIan: 0 },
  khaya: { done: 0, total: 1 },
  pipeline: { stages: ['Write', 'Live'], items: [] },
  money: { currency: 'EUR', spent: 19.999, earned: 3.14159 },
  reach: { visits: { week: 1, prev: 2 } }
};

// A todos section of about the given size in bytes (stays under 200 items).
function bigTodos(targetBytes) {
  const items = [];
  let n = 0;
  while (n < 200) {
    const id = 'big' + n;
    items.push({ id: id, title: 'T'.repeat(70) + ' ' + n, owner: 'both', section: 'later', stream: 'S'.repeat(24), due: 'D'.repeat(40), waitingOn: 'W'.repeat(40) });
    n++;
    if (Buffer.byteLength(JSON.stringify(items)) >= targetBytes) break;
  }
  return { items: items };
}

async function main() {
  /* ---------- the sample ---------- */

  await check('the made-up sample passes untouched: nothing rejected, all seven sections kept', () => {
    const raw = sample();
    const n = awws.normalizeSnapshot(raw, NOW);
    assert.deepStrictEqual(n.rejected, []);
    assert.deepStrictEqual(Object.keys(n.sections), awws.SECTIONS);
    // The clean copy is the sample itself.
    const want = sample();
    awws.SECTIONS.forEach((k) => assert.deepStrictEqual(n.sections[k], want[k], k));
    assert.deepStrictEqual(raw, sample(), 'the input object is not changed');
    assert.strictEqual(fs.readFileSync(SAMPLE_FILE, 'utf8'), SAMPLE_TEXT, 'the file is not changed');
  });

  await check('the sample merged into an empty store; reloading it from a state file gives the same data', () => {
    const m = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW);
    assert.strictEqual(m.changed, true);
    assert.deepStrictEqual(m.accepted, awws.SECTIONS);
    assert.deepStrictEqual(m.cleared, []);
    assert.strictEqual(m.data.v, 1);
    assert.strictEqual(m.data.sentAt, SENT);
    assert.strictEqual(m.data.receivedAt, '2026-11-16T15:12:00Z');
    assert.strictEqual(m.bytes, Buffer.byteLength(JSON.stringify(m.data)));
    assert.ok(m.bytes < awws.MAX_BYTES);
    const again = awws.cleanResource({ rev: 9, data: copy(m.data) });
    assert.deepStrictEqual(again, { rev: 9, data: m.data });
  });

  await check('the sample holds no email addresses or links', () => {
    assert.ok(!/@|https?:\/\/|www\./i.test(SAMPLE_TEXT));
  });

  /* ---------- each section's happy path ---------- */

  await check('happy path: the smallest valid copy of every section; asOf defaults to sentAt', () => {
    awws.SECTIONS.forEach((k) => {
      const r = one(k, MIN[k]);
      assert.ok(r.clean, k + ': ' + r.error);
      assert.strictEqual(r.clean.asOf, SENT, k);
    });
    assert.deepStrictEqual(one('khaya', MIN.khaya).clean, { asOf: SENT, done: 0, total: 1 });
    assert.deepStrictEqual(one('pipeline', MIN.pipeline).clean, { asOf: SENT, stages: ['Write', 'Live'], items: [] });
  });

  await check('happy path: todos with every field, dueISO as a date or a time (fractions allowed)', () => {
    const r = one('todos', {
      asOf: '2026-11-16T15:08:00.250Z',
      items: [
        todo({ stream: 'Visits', due: 'Dec 1, 12:15 PM', dueISO: '2026-12-01T18:15:00Z', waitingOn: 'The printer' }),
        todo({ id: 'b-2_X', owner: 'claude', section: 'later', dueISO: '2028-02-29', done: true, doneAt: '2026-11-15T20:30:00.5Z' })
      ],
      totals: { ian: { now: 17, next: 9, later: 30 }, claude: { now: 0, next: 0, later: 0 }, both: { now: 1, next: 2, later: 3 } }
    });
    assert.ok(r.clean, r.error);
    assert.strictEqual(r.clean.asOf, '2026-11-16T15:08:00.250Z');
    assert.deepStrictEqual(r.clean.items[0], {
      id: 'a1', title: 'Water the plants', owner: 'ian', section: 'now', stream: 'Visits', due: 'Dec 1, 12:15 PM',
      dueISO: '2026-12-01T18:15:00Z', waitingOn: 'The printer'
    });
    assert.strictEqual(r.clean.items[1].dueISO, '2028-02-29');
    assert.strictEqual(r.clean.items[1].done, true);
    assert.strictEqual(r.clean.totals.ian.later, 30);
  });

  await check('happy path: handoffs, outreach, pipeline, money and reach with their optional parts', () => {
    const h = one('handoffs', { open: 1, blocked: 1, items: [{ id: 'h1', title: 'Read the flier', state: 'open' }, { id: 'h2', title: 'Logo', state: 'blocked' }] });
    assert.strictEqual(h.clean.items.length, 2);
    const o = one('outreach', {
      emailed: 40, replied: 9, booked: 3, visited: 1, waitingOnIan: 5,
      schools: [{ school: 'Willow Creek School', state: 'waiting-them', since: '2026-11-10' }, { school: 'Pine Hill', state: 'visited' }],
      log: [{ date: '2026-11-14', school: 'Pine Hill', what: 'Sent the outline' }]
    });
    assert.ok(o.clean, o.error);
    assert.strictEqual(o.clean.emailed, 40);
    assert.deepStrictEqual(o.clean.schools[1], { school: 'Pine Hill', state: 'visited' });
    const p = one('pipeline', { stages: ['A', 'B', 'C'], items: [{ id: 'p1', title: 'Book', stage: 0 }, { id: 'p2', title: 'Book', format: 'Hardcover', stage: 3, next: 'Ship', waitingOn: 'Proof', blocked: true }] });
    assert.ok(p.clean, p.error);
    assert.deepStrictEqual(p.clean.items[0], { id: 'p1', title: 'Book', stage: 0 }, 'blocked: false is left out');
    assert.strictEqual(p.clean.items[1].blocked, true);
    assert.ok(!('done' in one('todos', todosWith([todo({ done: false })])).clean.items[0]), 'done: false is left out');
    const m = one('money', {
      currency: 'USD', spent: 1840.504, earned: 0,
      months: [{ month: '2026-10', spent: 0.1 + 0.2, earned: 80 }],
      claude: { month: '2026-11', cost: 41.2 }, nextTransfer: { date: '2026-12-01' }
    });
    assert.ok(m.clean, m.error);
    assert.strictEqual(m.clean.spent, 1840.5);
    assert.strictEqual(m.clean.months[0].spent, 0.3);
    assert.deepStrictEqual(m.clean.nextTransfer, { date: '2026-12-01' });
    assert.deepStrictEqual(one('money', MIN.money).clean, { asOf: SENT, currency: 'EUR', spent: 20, earned: 3.14 });
    const r = one('reach', { visits: { week: 0, prev: 1000000, days: [1, 2, 3] }, buyClicks: { week: 2, prev: 3 }, subscribers: 7, scans: [{ school: 'Pine Hill', count: 4 }] });
    assert.ok(r.clean, r.error);
    assert.deepStrictEqual(r.clean.visits, { week: 0, prev: 1000000, days: [1, 2, 3] });
  });

  /* ---------- each rule, at least once ---------- */

  const items3 = (over) => todosWith([todo({ id: 't01' }), todo({ id: 't02' }), todo(Object.assign({ id: 't03' }, over))]);
  const many = (n, make) => { const a = []; for (let i = 0; i < n; i++) a.push(make(i)); return a; };
  const rules = [
    ['todos: owner', 'todos', items3({ owner: 'ann' }), /^"owner" must be ian, claude or both \(item 3, t03\)$/],
    ['todos: section', 'todos', items3({ section: 'waiting' }), /"section" must be now, next or later \(item 3, t03\)/],
    ['todos: title missing', 'todos', items3({ title: undefined }), /"title" is missing \(item 3, t03\)/],
    ['todos: title empty after trimming', 'todos', items3({ title: ' \t ' }), /"title" is empty/],
    ['todos: title not text', 'todos', items3({ title: 5 }), /"title" must be text/],
    ['todos: id with a space', 'todos', items3({ id: 'a b' }), /"id" must be 1 to 40 .*\(item 3\)$/],
    ['todos: id too long', 'todos', items3({ id: 'x'.repeat(41) }), /"id" must be 1 to 40/],
    ['todos: id used twice', 'todos', todosWith([todo({ id: 'same' }), todo({ id: 'same' })]), /the id "same" is used twice \(item 2, same\)/],
    ['todos: more than 200 items', 'todos', todosWith(many(201, (i) => todo({ id: 'i' + i }))), /"items" has 201 entries; at most 200/],
    ['todos: items missing', 'todos', {}, /"items" is missing/],
    ['todos: dueISO not a real date', 'todos', items3({ dueISO: '2026-02-30' }), /"dueISO" must be a date like 2026-12-01 or a UTC time/],
    ['todos: dueISO time without Z', 'todos', items3({ dueISO: '2026-11-18T22:00:00' }), /"dueISO" must be/],
    ['todos: dueISO time with an offset', 'todos', items3({ dueISO: '2026-11-18T22:00:00+01:00' }), /"dueISO" must be/],
    ['todos: doneAt a date, not a time', 'todos', items3({ doneAt: '2026-11-15' }), /"doneAt" must be a UTC time/],
    ['todos: done not true or false', 'todos', items3({ done: 'yes' }), /"done" must be true or false \(item 3, t03\)/],
    ['todos: an item that is not an object', 'todos', todosWith([5]), /each item must be an object \(item 1\)/],
    ['todos: totals missing an owner', 'todos', { items: [], totals: { ian: { now: 1, next: 1, later: 1 }, claude: { now: 1, next: 1, later: 1 } } }, /"totals\.both" is missing/],
    ['todos: totals not whole', 'todos', { items: [], totals: { ian: { now: 1.5, next: 1, later: 1 }, claude: { now: 1, next: 1, later: 1 }, both: { now: 1, next: 1, later: 1 } } }, /"totals\.ian\.now" must be a whole number from 0 to 1,000,000/],
    ['handoffs: open negative', 'handoffs', { open: -1, blocked: 0 }, /"open" must be a whole number from 0 to 1,000,000/],
    ['handoffs: over a million', 'handoffs', { open: 1000001, blocked: 0 }, /"open" must be a whole number/],
    ['handoffs: blocked missing', 'handoffs', { open: 1 }, /"blocked" is missing/],
    ['handoffs: state', 'handoffs', { open: 1, blocked: 0, items: [{ id: 'h1', title: 'x', state: 'done' }] }, /"state" must be open or blocked \(item 1, h1\)/],
    ['handoffs: more than 20 items', 'handoffs', { open: 0, blocked: 0, items: many(21, (i) => ({ id: 'h' + i, title: 'x', state: 'open' })) }, /at most 20/],
    ['outreach: waitingOnIan missing', 'outreach', { replied: 1, booked: 1, visited: 1 }, /"waitingOnIan" is missing/],
    ['outreach: school state', 'outreach', Object.assign({}, MIN.outreach, { schools: [{ school: 'Pine Hill', state: 'maybe' }] }), /"state" must be waiting-ian, waiting-them, booked or visited \(school 1\)/],
    ['outreach: since not a real date', 'outreach', Object.assign({}, MIN.outreach, { schools: [{ school: 'Pine Hill', state: 'booked', since: '2026-13-01' }] }), /"since" must be a real date/],
    ['outreach: log entry without what', 'outreach', Object.assign({}, MIN.outreach, { log: [{ date: '2026-11-14', school: 'Pine Hill' }] }), /"what" is missing \(log entry 1\)/],
    ['outreach: more than 30 schools', 'outreach', Object.assign({}, MIN.outreach, { schools: many(31, () => ({ school: 'S', state: 'booked' })) }), /at most 30/],
    ['khaya: done more than total', 'khaya', { done: 13, total: 12 }, /"done" \(13\) is more than "total" \(12\)/],
    ['khaya: total 0', 'khaya', { done: 0, total: 0 }, /"total" must be a whole number from 1 to 1,000,000/],
    ['pipeline: stage past the number of stages', 'pipeline', { stages: ['A', 'B'], items: [{ id: 'p1', title: 'x', stage: 3 }] }, /"stage" must be a whole number from 0 to 2 \(item 1, p1\)/],
    ['pipeline: one stage only', 'pipeline', { stages: ['A'], items: [] }, /2 to 7 stage names/],
    ['pipeline: eight stages', 'pipeline', { stages: many(8, (i) => 'S' + i), items: [] }, /at most 7/],
    ['pipeline: a stage name that is not text', 'pipeline', { stages: ['A', 2], items: [] }, /"stages" must be text \(stage 2\)/],
    ['pipeline: more than 12 items', 'pipeline', { stages: ['A', 'B'], items: many(13, (i) => ({ id: 'p' + i, title: 'x', stage: 0 })) }, /at most 12/],
    ['pipeline: blocked not true or false', 'pipeline', { stages: ['A', 'B'], items: [{ id: 'p1', title: 'x', stage: 0, blocked: 1 }] }, /"blocked" must be true or false/],
    ['money: currency in small letters', 'money', Object.assign({}, MIN.money, { currency: 'usd' }), /"currency" must be three capital letters/],
    ['money: over a billion', 'money', Object.assign({}, MIN.money, { spent: 1e9 + 1 }), /"spent" must be a number from 0 to 1,000,000,000/],
    ['money: negative', 'money', Object.assign({}, MIN.money, { earned: -5 }), /"earned" must be a number from 0/],
    ['money: month not a month', 'money', Object.assign({}, MIN.money, { months: [{ month: '2026-13', spent: 1, earned: 1 }] }), /"month" must be a month like 2026-11 \(month 1\)/],
    ['money: claude without cost', 'money', Object.assign({}, MIN.money, { claude: { month: '2026-11' } }), /"claude\.cost" is missing/],
    ['money: nextTransfer date', 'money', Object.assign({}, MIN.money, { nextTransfer: { date: 'Dec 1' } }), /"nextTransfer\.date" must be a real date/],
    ['reach: visits missing', 'reach', { subscribers: 4 }, /"visits" is missing/],
    ['reach: more than 28 days', 'reach', { visits: { week: 1, prev: 1, days: many(29, () => 1) } }, /"visits\.days" has 29 entries; at most 28/],
    ['reach: a day that is not whole', 'reach', { visits: { week: 1, prev: 1, days: [1, 2.5] } }, /"visits\.days" must be a whole number .*\(day 2\)/],
    ['reach: more than 10 scans', 'reach', { visits: { week: 1, prev: 1 }, scans: many(11, () => ({ school: 'S', count: 1 })) }, /at most 10/],
    ['any section: asOf not a time', 'khaya', { asOf: 'yesterday', done: 0, total: 1 }, /"asOf" must be a UTC time/],
    ['any section: not an object', 'reach', 'lots', /the section must be an object, or null to clear it/],
    ['any section: a list instead of an object', 'todos', [], /the section must be an object/]
  ];
  for (const [name, section, value, re] of rules) {
    await check('rule: ' + name, () => {
      const r = one(section, value);
      assert.ok(r.error, 'was accepted');
      assert.strictEqual(r.rejected[0].section, section);
      assert.ok(re.test(r.error), r.error);
    });
  }

  /* ---------- the snapshot as a whole ---------- */

  await check('whole snapshot: not an object, wrong v, no sentAt, bad sentAt, no sections are 400', () => {
    throws400(null, /must be a JSON object/);
    throws400([], /must be a JSON object/);
    throws400({ v: 2, sentAt: SENT, khaya: MIN.khaya }, /"v" must be 1/);
    throws400({ sentAt: SENT, khaya: MIN.khaya }, /"v" must be 1/);
    throws400({ v: 1, khaya: MIN.khaya }, /"sentAt" is missing/);
    throws400({ v: 1, sentAt: '2026-11-16 15:10', khaya: MIN.khaya }, /"sentAt" must be a UTC time/);
    throws400({ v: 1, sentAt: '2026-11-31T10:00:00Z', khaya: MIN.khaya }, /"sentAt" must be/);
    throws400({ v: 1, sentAt: '2026-11-16T24:00:00Z', khaya: MIN.khaya }, /"sentAt" must be/);
    throws400({ v: 1, sentAt: SENT }, /no sections/);
    throws400({ v: 1, sentAt: SENT, notes: {} }, /no sections/);
  });

  await check('sentAt: up to 10 minutes ahead is fine, more is refused', () => {
    const at = (ms) => new Date(NOW + ms).toISOString();
    assert.ok(awws.normalizeSnapshot({ v: 1, sentAt: at(9 * 60000), khaya: MIN.khaya }, NOW));
    assert.ok(awws.normalizeSnapshot({ v: 1, sentAt: at(10 * 60000), khaya: MIN.khaya }, NOW));
    throws400({ v: 1, sentAt: at(10 * 60000 + 1000), khaya: MIN.khaya }, /more than 10 minutes in the future/);
    assert.ok(awws.normalizeSnapshot({ v: 1, sentAt: '2020-01-01T00:00:00Z', khaya: MIN.khaya }, NOW), 'an old one is fine (the TV calls it stale)');
  });

  await check('a bad section is rejected by name while the rest are kept', () => {
    const raw = sample();
    raw.money.currency = 'dollars';
    raw.todos.items[2].owner = 'ann';
    const n = awws.normalizeSnapshot(raw, NOW);
    assert.deepStrictEqual(n.rejected.map((r) => r.section), ['todos', 'money']);
    assert.strictEqual(n.rejected[0].error, '"owner" must be ian, claude or both (item 3, t03)');
    assert.deepStrictEqual(Object.keys(n.sections), ['handoffs', 'outreach', 'khaya', 'pipeline', 'reach']);
    const stored = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW).data;
    const m = awws.merge(stored, n, NOW + 60000);
    assert.deepStrictEqual(m.accepted, ['handoffs', 'outreach', 'khaya', 'pipeline', 'reach']);
    assert.deepStrictEqual(m.data.todos, stored.todos, 'todos keeps its last good copy');
    assert.deepStrictEqual(m.data.money, stored.money, 'money keeps its last good copy');
    assert.strictEqual(m.rejected.length, 2);
  });

  await check('every section rejected: 400 that names each one, nothing stored', () => {
    const n = awws.normalizeSnapshot(snap({ khaya: { done: 5, total: 2 }, money: { currency: 'x' } }), NOW);
    let err = null;
    try { awws.merge(awws.emptyData(), n, NOW); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.status, 400);
    assert.ok(/every section was rejected: khaya: "done" \(5\) is more than "total" \(2\); money: "currency"/.test(err.message), err.message);
  });

  await check('a partial sync keeps the sections it leaves out', () => {
    const first = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW).data;
    const later = '2026-11-16T15:40:00Z';
    const n = awws.normalizeSnapshot({ v: 1, sentAt: later, todos: { items: [todo()] } }, NOW + 30 * 60000);
    const m = awws.merge(first, n, NOW + 30 * 60000);
    assert.strictEqual(m.changed, true);
    assert.deepStrictEqual(m.accepted, ['todos']);
    assert.strictEqual(m.data.sentAt, later);
    assert.strictEqual(m.data.todos.items.length, 1);
    assert.strictEqual(m.data.todos.asOf, later);
    ['handoffs', 'outreach', 'khaya', 'pipeline', 'money', 'reach'].forEach((k) => assert.deepStrictEqual(m.data[k], first[k], k));
  });

  await check('null clears one section; clearing what is not there is harmless', () => {
    const first = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW).data;
    const n = awws.normalizeSnapshot(snap({ money: null, khaya: { done: 12, total: 12 } }), NOW);
    assert.deepStrictEqual(n.sections.money, null);
    const m = awws.merge(first, n, NOW);
    assert.ok(!('money' in m.data));
    assert.deepStrictEqual(m.cleared, ['money']);
    assert.deepStrictEqual(m.accepted, ['khaya']);
    assert.strictEqual(m.data.khaya.done, 12);
    assert.ok(m.data.todos);
    const only = awws.merge(m.data, awws.normalizeSnapshot(snap({ money: null }), NOW), NOW);
    assert.strictEqual(only.changed, false);
    assert.deepStrictEqual(only.cleared, ['money']);
  });

  await check('the same contents again: changed false, but sentAt and receivedAt move on', () => {
    const first = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW).data;
    const raw = sample();
    raw.sentAt = '2026-11-16T15:40:00Z';
    awws.SECTIONS.forEach((k) => { raw[k].asOf = sample()[k].asOf; });
    const m = awws.merge(first, awws.normalizeSnapshot(raw, NOW + 1800000), NOW + 1800000);
    assert.strictEqual(m.changed, false);
    assert.strictEqual(m.data.sentAt, '2026-11-16T15:40:00Z');
    assert.strictEqual(m.data.receivedAt, '2026-11-16T15:42:00Z');
    assert.ok(/Nothing changed, but the TV now knows the data is fresh\./.test(awws.setText(m)));
  });

  await check('clear all: empty data, and the texts for it', () => {
    assert.deepStrictEqual(awws.emptyData(), { v: 1, sentAt: null, receivedAt: null });
    assert.deepStrictEqual(awws.summaryLines(awws.emptyData()), ['No A World Worth Saving snapshot yet. The TV tiles say "Not synced yet".']);
    assert.strictEqual(awws.clearText({ changed: true, cleared: ['todos', 'khaya'] }), 'Cleared the A World Worth Saving snapshot (todos and khaya). The TV tiles say "Not synced yet".');
    assert.strictEqual(awws.clearText({ changed: false, cleared: [] }), 'There is no A World Worth Saving snapshot to clear. Nothing changed.');
    assert.deepStrictEqual(awws.summaryData(awws.emptyData()), { sentAt: null, receivedAt: null, bytes: 0, sections: {} });
  });

  await check('unknown fields are dropped, at the top, in sections and in items', () => {
    const raw = snap({
      extraTop: 'x', notes: { text: 'never stored' },
      todos: { items: [todo({ notes: 'secret', priority: 3 })], colour: 'red' },
      reach: { visits: { week: 1, prev: 2, month: 9 }, mystery: true }
    });
    const n = awws.normalizeSnapshot(raw, NOW);
    assert.deepStrictEqual(n.rejected, []);
    assert.deepStrictEqual(Object.keys(n.sections), ['todos', 'reach']);
    assert.deepStrictEqual(Object.keys(n.sections.todos), ['asOf', 'items']);
    assert.deepStrictEqual(Object.keys(n.sections.todos.items[0]).sort(), ['id', 'owner', 'section', 'title']);
    assert.deepStrictEqual(n.sections.reach, { asOf: SENT, visits: { week: 1, prev: 2 } });
    const m = awws.merge(awws.emptyData(), n, NOW);
    assert.ok(JSON.stringify(m.data).indexOf('never stored') < 0);
    assert.ok(JSON.stringify(m.data).indexOf('secret') < 0);
  });

  /* ---------- text ---------- */

  await check('text: trimmed, control characters become spaces, empty optional text is left out', () => {
    const r = one('todos', todosWith([todo({ title: '  Buy\tthe\n\u0007paint  ', stream: '   ', due: '\u0085Nov 30\u0000' })]));
    assert.strictEqual(r.clean.items[0].title, 'Buy the paint');
    assert.ok(!('stream' in r.clean.items[0]));
    assert.strictEqual(r.clean.items[0].due, 'Nov 30');
  });

  await check('text: cut to the limit ending in "…", counted in characters ("ñ" and emoji)', () => {
    const r = one('todos', todosWith([
      todo({ id: 'n1', title: 'ñ'.repeat(85), waitingOn: '😀'.repeat(50) }),
      todo({ id: 'n2', title: 'ñ'.repeat(80), waitingOn: '😀'.repeat(40) }),
      todo({ id: 'n3', title: 'word '.repeat(30) })
    ]));
    assert.ok(r.clean, r.error);
    const [a, b, c] = r.clean.items;
    assert.strictEqual(a.title, 'ñ'.repeat(79) + '…');
    assert.strictEqual(Array.from(a.title).length, 80);
    assert.strictEqual(a.waitingOn, '😀'.repeat(39) + '…');
    assert.strictEqual(Array.from(a.waitingOn).length, 40);
    assert.strictEqual(b.title, 'ñ'.repeat(80), 'exactly at the limit is kept whole');
    assert.strictEqual(b.waitingOn, '😀'.repeat(40), '40 emoji are 80 UTF-16 units but 40 characters');
    assert.ok(Array.from(c.title).length <= 80 && /word…$/.test(c.title), c.title);
    const p = one('pipeline', { stages: ['Ñandú stage name too long', 'B'], items: [] });
    assert.strictEqual(p.clean.stages[0], 'Ñandú stage nam…');
    assert.strictEqual(Array.from(p.clean.stages[0]).length, 16);
  });

  await check('text: email addresses and links refuse the section, naming the field, never echoing it', () => {
    const cases = [
      ['todos', todosWith([todo({ id: 'e1', title: 'Write to ann.lee@example.org today' })]), /^"title" holds an email address, which the snapshot must never carry \(item 1, e1\)$/],
      ['todos', todosWith([todo({ id: 'e2', waitingOn: 'see https://example.test/form' })]), /"waitingOn" holds a link/],
      ['todos', todosWith([todo({ id: 'e3', due: 'http://example.test' })]), /"due" holds a link/],
      ['outreach', Object.assign({}, MIN.outreach, { log: [{ date: '2026-11-14', school: 'Pine Hill', what: 'Booked at WWW.example.test' }] }), /"what" holds a link, .*\(log entry 1\)/],
      ['pipeline', { stages: ['a@b.co', 'B'], items: [] }, /"stages" holds an email address, .*\(stage 1\)/],
      ['khaya', { done: 1, total: 2, label: 'mail me: x@y.zz' }, /"label" holds an email address/]
    ];
    cases.forEach(([section, value, re]) => {
      const r = one(section, value);
      assert.ok(r.error, section + ' was accepted');
      assert.ok(re.test(r.error), r.error);
      assert.ok(!/example|@|x@y|a@b|https?:|www\./i.test(r.error.replace(/email address/, '')), 'echoed: ' + r.error);
    });
    // An "@" on its own, or a dot in a word, is fine.
    assert.ok(one('todos', todosWith([todo({ title: 'Meet @ 3, then lunch. Then www-ish words' })])).clean);
  });

  /* ---------- size ---------- */

  await check('48 KB cap: a snapshot over 49,152 bytes is refused whole, with its size', () => {
    const raw = snap({ todos: bigTodos(50 * 1024) });
    const size = Buffer.byteLength(JSON.stringify(raw));
    assert.ok(size > 49152, 'test data is ' + size);
    const err = throws400(raw, /^the snapshot is \d+(\.\d)? KB \([\d,]+ bytes\); at most 48 KB \(49,152 bytes\)\. Nothing was stored$/);
    assert.ok(err.message.indexOf(size.toLocaleString('en-US')) > 0, err.message);
  });

  await check('48 KB cap: on what the Pi would hold after merging', () => {
    const stored = awws.merge(awws.emptyData(), awws.normalizeSnapshot(snap({ todos: bigTodos(44 * 1024) }), NOW), NOW).data;
    assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 49152);
    const outreach = Object.assign({}, MIN.outreach, {
      schools: Array.from({ length: 30 }, (x, i) => ({ school: 'School number ' + i + ' ' + 'x'.repeat(20), state: 'booked', since: '2026-11-01' })),
      log: Array.from({ length: 30 }, (x, i) => ({ date: '2026-11-01', school: 'School number ' + i, what: 'y'.repeat(80) }))
    });
    const n = awws.normalizeSnapshot(snap({ outreach: outreach }), NOW);
    assert.deepStrictEqual(n.rejected, []);
    let err = null;
    try { awws.merge(stored, n, NOW); } catch (e) { err = e; }
    assert.ok(err, 'was accepted');
    assert.strictEqual(err.status, 400);
    assert.ok(/^with this snapshot the Pi would hold [\d.]+ KB \([\d,]+ bytes\); at most 48 KB/.test(err.message), err.message);
    // With todos cleared in the same snapshot it fits.
    const m = awws.merge(stored, awws.normalizeSnapshot(snap({ outreach: outreach, todos: null }), NOW), NOW);
    assert.deepStrictEqual(m.accepted, ['outreach']);
    assert.deepStrictEqual(m.cleared, ['todos']);
  });

  /* ---------- the state file ---------- */

  await check('state file: missing or damaged means empty; a broken section is dropped, the rest kept', () => {
    const empty = { rev: 0, data: awws.emptyData() };
    assert.deepStrictEqual(awws.cleanResource(undefined), empty);
    assert.deepStrictEqual(awws.cleanResource('nonsense'), empty);
    assert.deepStrictEqual(awws.cleanResource({ rev: -3, data: null }), empty);
    assert.deepStrictEqual(awws.cleanResource({ rev: 4, data: { v: 2, sentAt: SENT } }), { rev: 4, data: awws.emptyData() });
    assert.deepStrictEqual(awws.cleanResource({ rev: 4, data: { v: 1, sentAt: 'later' } }), { rev: 4, data: awws.emptyData() });
    const good = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW).data;
    const bent = copy(good);
    bent.khaya.done = 99;
    bent.money = 'gone';
    bent.receivedAt = 12;
    bent.extra = { a: 1 };
    const r = awws.cleanResource({ rev: 7, data: bent });
    assert.strictEqual(r.rev, 7);
    assert.ok(!('khaya' in r.data) && !('money' in r.data) && !('extra' in r.data));
    assert.strictEqual(r.data.receivedAt, null);
    assert.deepStrictEqual(r.data.todos, good.todos);
    assert.deepStrictEqual(awws.sectionsIn(r.data), ['todos', 'handoffs', 'outreach', 'pipeline', 'reach']);
  });

  /* ---------- prototype pollution ---------- */

  await check('"__proto__", "constructor" and "prototype" keys anywhere do no harm', () => {
    const text = '{"v":1,"sentAt":"' + SENT + '","__proto__":{"polluted":1},"constructor":{"prototype":{"bad":1}},' +
      '"todos":{"__proto__":{"items":[]},"items":[{"id":"a1","title":"x","owner":"ian","section":"now",' +
      '"__proto__":{"isAdmin":true},"constructor":{"prototype":{"bad":1}},"prototype":{"x":1}}],' +
      '"totals":{"__proto__":{"ian":{"now":1}},"ian":{"now":1,"next":2,"later":3},"claude":{"now":0,"next":0,"later":0},"both":{"now":0,"next":0,"later":0}}},' +
      '"reach":{"visits":{"__proto__":{"week":5},"week":1,"prev":2}}}';
    const raw = JSON.parse(text);
    const n = awws.normalizeSnapshot(raw, NOW);
    assert.deepStrictEqual(n.rejected, []);
    const item = n.sections.todos.items[0];
    assert.strictEqual(Object.getPrototypeOf(item), Object.prototype);
    assert.strictEqual(item.isAdmin, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(item, '__proto__'));
    assert.ok(!Object.prototype.hasOwnProperty.call(item, 'constructor'));
    assert.strictEqual(Object.getPrototypeOf(n.sections.todos.totals), Object.prototype);
    const m = awws.merge(awws.emptyData(), n, NOW);
    assert.strictEqual(Object.getPrototypeOf(m.data), Object.prototype);
    assert.strictEqual(JSON.stringify(m.data).indexOf('__proto__'), -1);
    assert.strictEqual(JSON.stringify(m.data).indexOf('constructor'), -1);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(({}).isAdmin, undefined);
    assert.strictEqual(({}).bad, undefined);
    // A section only on the prototype does not count, and sections named
    // after those keys are not sections.
    throws400(Object.create({ v: 1, sentAt: SENT, khaya: MIN.khaya }), /"v" must be 1/);
    const proto = Object.create({ khaya: MIN.khaya });
    proto.v = 1;
    proto.sentAt = SENT;
    throws400(proto, /no sections/);
    throws400(JSON.parse('{"v":1,"sentAt":"' + SENT + '","__proto__":{"khaya":{"done":0,"total":1}}}'), /no sections/);
    // A stored copy with such keys loads clean too.
    const loaded = awws.cleanResource(JSON.parse('{"rev":1,"data":{"v":1,"sentAt":"' + SENT + '","__proto__":{"x":1},"khaya":{"done":1,"total":2,"__proto__":{"y":1}}}}'));
    assert.deepStrictEqual(loaded.data, { v: 1, sentAt: SENT, receivedAt: null, khaya: { asOf: SENT, done: 1, total: 2 } });
    assert.strictEqual(({}).x, undefined);
    assert.strictEqual(({}).y, undefined);
  });

  /* ---------- texts ---------- */

  await check('./hub awws show text: sent, received, size, one aligned line per section', () => {
    const data = awws.merge(awws.emptyData(), awws.normalizeSnapshot(sample(), NOW), NOW).data;
    const lines = awws.summaryLines(data, { when: (ms) => new Date(ms).toISOString().slice(11, 16) });
    assert.strictEqual(lines[0], 'Snapshot sent 15:10, received 15:12. 5.8 KB of 48 KB.');
    assert.strictEqual(lines.length, 8);
    assert.strictEqual(lines[1], '  todos     25 items, 23 open (14 for Ian), 2 done, as of 15:08');
    assert.strictEqual(lines[4], '  khaya     11 of 12 done, as of 15:00');
    assert.ok(/^  money     figures in USD, 6 months .*as of 12:00$/.test(lines[6]), lines[6]);
    const all = lines.join('\n');
    assert.ok(all.indexOf('Maple Grove') < 0 && all.indexOf('1840') < 0, 'no titles, names or amounts');
    const noTz = awws.summaryLines(data);
    assert.ok(/^Snapshot sent 2026-11-16 15:10 UTC/.test(noTz[0]), noTz[0]);
  });

  await check('./hub awws set text: stored, cleared, rejected', () => {
    assert.strictEqual(awws.setText({ changed: true, bytes: 12600, accepted: ['todos', 'khaya'], cleared: [], rejected: [] }),
      'Stored todos and khaya (12.3 KB of 48 KB). Screens that are on change now.');
    assert.strictEqual(awws.setText({ changed: true, bytes: 900, accepted: ['todos'], cleared: ['money'], rejected: [{ section: 'reach', error: '"visits" is missing' }] }),
      'Stored todos, cleared money (900 bytes of 48 KB). Screens that are on change now.\nRejected reach: "visits" is missing.\nRejected sections keep their last good copy on the Pi.');
    assert.strictEqual(awws.setText({ changed: false, bytes: 2048, accepted: [], cleared: ['money'], rejected: [] }),
      'Cleared money (2 KB of 48 KB). Nothing changed, but the TV now knows the data is fresh.');
  });

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
