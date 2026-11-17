/*
 * Tests for the budget snapshot checks (budget.js). Run from the repo root
 * with:
 *
 *   node pi/budget-test.js
 *
 * It checks the made-up sample in pi/fixtures, every section's rules, list
 * sections sent as a plain list, merging, the size cap, a damaged state file
 * and the texts ./hub prints (never a label or an amount). The HTTP side is
 * in pi/test.js and the mailbox side in pi/mailbox-test.js. It prints one
 * line per check, then "N passed, 0 failed". Only what ships with Node is used.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const budget = require('./budget');

const NOW = Date.parse('2026-11-16T15:12:00Z');
const SENT = '2026-11-16T15:10:00Z';
const SAMPLE_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'budget-sample.json'), 'utf8');
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

const sample = () => JSON.parse(SAMPLE_TEXT);

function snap(sections) {
  return Object.assign({ v: 1, sentAt: SENT }, sections);
}

function throws400(raw, re) {
  let err = null;
  try { budget.normalizeSnapshot(raw, NOW); } catch (e) { err = e; }
  assert.ok(err, 'was accepted');
  assert.strictEqual(err.status, 400);
  assert.ok(re.test(err.message), err.message);
}

// One section alone: its clean copy, or its error text.
function one(name, section) {
  const s = {};
  s[name] = section;
  const n = budget.normalizeSnapshot(snap(s), NOW);
  if (n.rejected.length) return { error: n.rejected[0].error };
  return { clean: n.sections[name] };
}

const ROOM = { cap: 60, roomPerDay: 42.5, daysLeft: 9, throughDate: '2026-11-24' };
const CARD = { date: '2026-11-19', daysAway: 3, covered: true };

async function main() {
  await check('the made-up sample passes as it is, every section accepted', () => {
    const n = budget.normalizeSnapshot(sample(), NOW);
    assert.deepStrictEqual(n.rejected, []);
    assert.deepStrictEqual(Object.keys(n.sections), ['room', 'cardDay', 'goals', 'alerts']);
    assert.strictEqual(n.sections.room.roomPerDay, 42.5);
    assert.strictEqual(n.sections.cardDay.transfers.length, 3);
    assert.strictEqual(n.sections.goals.items.length, 5);
    assert.deepStrictEqual(n.sections.alerts.items, [{ id: 'a-1042', label: 'Corner Bakery Stand' }]);
  });

  await check('the whole snapshot: v, sentAt, no sections, too far ahead, not an object, over 48 KB', () => {
    throws400([], /JSON object/);
    throws400({ sentAt: SENT, room: ROOM }, /"v" must be 1/);
    throws400({ v: 1, room: ROOM }, /"sentAt" is missing/);
    throws400({ v: 1, sentAt: '2026-11-16 15:10', room: ROOM }, /"sentAt" must be a UTC time/);
    throws400({ v: 1, sentAt: '2026-11-16T16:10:00Z', room: ROOM }, /in the future/);
    throws400({ v: 1, sentAt: SENT, todos: { items: [] } }, /no sections/);
    throws400(snap({ room: ROOM, junk: 'x'.repeat(50000) }), /at most 48 KB/);
  });

  await check('room: required fields, cents, negative room, cap above 0, the refund figure', () => {
    assert.deepStrictEqual(one('room', ROOM).clean, Object.assign({ asOf: SENT }, ROOM));
    const neg = one('room', Object.assign({}, ROOM, { roomPerDay: -12.345, roomIfRefund: 3.999 })).clean;
    assert.strictEqual(neg.roomPerDay, -12.35);
    assert.strictEqual(neg.roomIfRefund, 4);
    assert.ok(/"cap" must be a number more than 0/.test(one('room', Object.assign({}, ROOM, { cap: 0 })).error));
    assert.ok(/"cap" is missing/.test(one('room', { roomPerDay: 1, daysLeft: 1, throughDate: '2026-11-24' }).error));
    assert.ok(/"daysLeft" must be a whole number from 0 to 366/.test(one('room', Object.assign({}, ROOM, { daysLeft: 2.5 })).error));
    assert.ok(/"throughDate" must be a real date/.test(one('room', Object.assign({}, ROOM, { throughDate: '2026-02-30' })).error));
    assert.ok(/"roomPerDay" must be a number from -1,000,000/.test(one('room', Object.assign({}, ROOM, { roomPerDay: '42' })).error));
    // Unknown fields (a balance, say) are dropped, never stored.
    const extra = one('room', Object.assign({}, ROOM, { balance: 9000 })).clean;
    assert.ok(!('balance' in extra));
  });

  await check('cardDay: covered or short by, transfers, paychecks', () => {
    assert.deepStrictEqual(one('cardDay', CARD).clean, Object.assign({ asOf: SENT }, CARD));
    const short = one('cardDay', Object.assign({}, CARD, { covered: false, shortBy: 120.004 })).clean;
    assert.strictEqual(short.shortBy, 120);
    assert.ok(/"shortBy" is only for a card day that is not covered/.test(one('cardDay', Object.assign({}, CARD, { shortBy: 5 })).error));
    assert.ok(/"covered" is missing/.test(one('cardDay', { date: '2026-11-19', daysAway: 3 }).error));
    assert.ok(/"covered" must be true or false/.test(one('cardDay', Object.assign({}, CARD, { covered: 'yes' })).error));
    const t = { label: 'From checking', amount: 10 };
    assert.ok(/"transfers" has 7 entries; at most 6/.test(one('cardDay', Object.assign({}, CARD, { transfers: [t, t, t, t, t, t, t] })).error));
    assert.ok(/"label" is missing \(transfer 1\)/.test(one('cardDay', Object.assign({}, CARD, { transfers: [{ amount: 1 }] })).error));
    const long = one('cardDay', Object.assign({}, CARD, { transfers: [{ label: 'A very long label for one transfer', amount: 1 }] })).clean;
    assert.strictEqual(Array.from(long.transfers[0].label).length, 24);
    assert.ok(/…$/.test(long.transfers[0].label));
    assert.ok(/"paychecks" has 5 entries; at most 4/.test(one('cardDay', Object.assign({}, CARD, { paychecks: ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'] })).error));
    assert.ok(/"paychecks" must be a real date like 2026-12-01 \(paycheck 2\)/.test(one('cardDay', Object.assign({}, CARD, { paychecks: ['2026-11-20', 'Friday'] })).error));
  });

  await check('goals: a plain list or { items }; states; pct 0 to 100; at most 8', () => {
    const g = { label: 'Groceries', state: 'on-pace', text: '$214 of $400', pct: 53.54 };
    const a = one('goals', [g]).clean;
    const b = one('goals', { items: [g] }).clean;
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.items[0], { label: 'Groceries', state: 'on-pace', text: '$214 of $400', pct: 53.5 });
    assert.ok(/"state" must be clean, on-pace, over or under/.test(one('goals', [Object.assign({}, g, { state: 'fine' })]).error));
    assert.ok(/"pct" must be a number from 0 to 100/.test(one('goals', [Object.assign({}, g, { pct: 120 })]).error));
    assert.ok(/at most 8/.test(one('goals', new Array(9).fill(g)).error));
    assert.strictEqual(Array.from(one('goals', [Object.assign({}, g, { text: 'x'.repeat(30) })]).clean.items[0].text).length, 20);
    assert.ok(/must be a list, or an object with "items"/.test(one('goals', 'many').error));
  });

  await check('alerts: id and label only (an amount is dropped), unique ids, at most 5', () => {
    const a = one('alerts', [{ id: 'x1', label: 'Corner Bakery Stand', amount: 6.5 }]).clean;
    assert.deepStrictEqual(a.items, [{ id: 'x1', label: 'Corner Bakery Stand' }]);
    assert.ok(/used twice/.test(one('alerts', [{ id: 'x1', label: 'A' }, { id: 'x1', label: 'B' }]).error));
    assert.ok(/at most 5/.test(one('alerts', [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'x' + n, label: 'L' }))).error));
    assert.deepStrictEqual(one('alerts', []).clean.items, []);
  });

  await check('text rules: no email addresses, no links (the text itself is never echoed)', () => {
    const e = one('alerts', [{ id: 'x1', label: 'pay me at someone@example.com' }]).error;
    assert.ok(/holds an email address/.test(e) && e.indexOf('example.com') < 0, e);
    assert.ok(/holds a link/.test(one('goals', [{ label: 'See www.example.com', state: 'over' }]).error));
    assert.ok(/holds a link/.test(one('cardDay', Object.assign({}, CARD, { transfers: [{ label: 'https://x', amount: 1 }] })).error));
  });

  await check('merge: a section left out is kept, null clears one, a bad one keeps its last good copy', () => {
    const first = budget.merge(null, budget.normalizeSnapshot(sample(), NOW), NOW);
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.accepted, ['room', 'cardDay', 'goals', 'alerts']);
    const next = budget.normalizeSnapshot(snap({ alerts: null, room: Object.assign({}, ROOM, { cap: -1 }), goals: [] }), NOW);
    const m = budget.merge(first.data, next, NOW);
    assert.deepStrictEqual(m.accepted, ['goals']);
    assert.deepStrictEqual(m.cleared, ['alerts']);
    assert.strictEqual(m.rejected[0].section, 'room');
    assert.deepStrictEqual(m.data.room, first.data.room);
    assert.ok(!('alerts' in m.data));
    assert.deepStrictEqual(m.data.goals.items, []);
    let err = null;
    try { budget.merge(m.data, budget.normalizeSnapshot(snap({ room: { cap: 1 } }), NOW), NOW); } catch (e) { err = e; }
    assert.ok(err && err.status === 400 && /every section was rejected/.test(err.message));
    const same = budget.merge(m.data, budget.normalizeSnapshot(snap({ goals: [] }), NOW), NOW);
    assert.strictEqual(same.changed, false);
  });

  await check('cleanResource: damaged or old state files give an empty resource or drop a bad section', () => {
    assert.deepStrictEqual(budget.cleanResource(undefined), { rev: 0, data: budget.emptyData() });
    assert.deepStrictEqual(budget.cleanResource({ rev: 3, data: { v: 2 } }), { rev: 3, data: budget.emptyData() });
    const r = budget.cleanResource({ rev: 4, data: { v: 1, sentAt: SENT, receivedAt: 'later', room: ROOM, cardDay: { date: 'x' } } });
    assert.strictEqual(r.rev, 4);
    assert.strictEqual(r.data.receivedAt, null);
    assert.strictEqual(r.data.room.cap, 60);
    assert.ok(!('cardDay' in r.data));
  });

  await check('./hub budget show: times, counts and states, never a label or an amount', () => {
    assert.deepStrictEqual(budget.summaryLines(budget.emptyData()), ['No budget snapshot yet. The TV tiles say "Waiting for the budget app".']);
    const m = budget.merge(null, budget.normalizeSnapshot(sample(), NOW), NOW);
    const lines = budget.summaryLines(m.data);
    assert.ok(/^Budget snapshot sent 2026-11-16 15:10 UTC, received 2026-11-16 15:12 UTC\. [\d.]+ (KB|bytes) of 48 KB\.$/.test(lines[0]), lines[0]);
    assert.strictEqual(lines[1], '  room     9 days left through 2026-11-24, under the daily cap, a refund pending, as of 2026-11-16 15:05 UTC');
    assert.strictEqual(lines[2], '  cardDay  2026-11-19 (in 3 days), covered, 3 transfers, 2 paychecks, as of 2026-11-16 15:05 UTC');
    assert.strictEqual(lines[3], '  goals    5 goals (2 clean, 1 on pace, 1 over, 1 under), as of 2026-11-16 15:05 UTC');
    assert.strictEqual(lines[4], '  alerts   1 new charge at a merchant you cut, as of 2026-11-16 15:05 UTC');
    const all = JSON.stringify(lines) + JSON.stringify(budget.summaryData(m.data));
    ['Bakery', 'Groceries', 'checking', '42.5', '310', '$'].forEach((w) => assert.ok(all.indexOf(w) < 0, 'shows ' + w));
    assert.deepStrictEqual(budget.summaryData(m.data).sections.goals, { asOf: '2026-11-16T15:05:00Z', goals: 5, clean: 2, 'on-pace': 1, over: 1, under: 1 });
  });

  await check('set and clear texts', () => {
    assert.strictEqual(budget.setText({ accepted: ['room'], cleared: ['alerts'], rejected: [{ section: 'goals', error: '"pct" must be a number from 0 to 100 (goal 1)' }], bytes: 300, changed: true }),
      'Stored room, cleared alerts (300 bytes of 48 KB). Screens that are on change now.\nRejected goals: "pct" must be a number from 0 to 100 (goal 1).\nRejected sections keep their last good copy on the Pi.');
    assert.strictEqual(budget.clearText({ changed: false }), 'There is no budget snapshot to clear. Nothing changed.');
    assert.strictEqual(budget.clearText({ changed: true, cleared: ['room', 'goals'] }), 'Cleared the budget snapshot (room and goals). The TV tiles say "Waiting for the budget app".');
  });
}

main().then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
