/*
 * Tests for the budget snapshot checks (budget.js). Run from the repo root
 * with:
 *
 *   node pi/budget-test.js
 *
 * It checks the made-up sample in pi/fixtures, every section's rules (the
 * Budget lab sections lab, merchants, pace and runway too, and trends), list sections
 * sent as a plain list, merging, the size cap, a damaged state file, a
 * snapshot with only the first four sections, and the texts ./hub prints
 * (never a label or an amount). The HTTP side is
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
const OLD4 = ['room', 'cardDay', 'goals', 'alerts'];
const ALL8 = ['room', 'cardDay', 'goals', 'alerts', 'lab', 'merchants', 'pace', 'runway', 'investments'];
const LAB = { room: 186.4, spentToday: 23.75, daysLeft: 3, cardDate: '2026-11-19', monthDay: 16 };
const MERCH = { month: '2026-11', combined: 120, items: [{ label: 'Hilltop Grocer', mtd: 80, count: 2 }, { label: 'Riverside Fuel', mtd: 50, count: 1 }] };
const RUNWAY = { start: 300, end: '2026-11-19', steps: [{ date: '2026-11-17', delta: 1200, kind: 'pay' }, { date: '2026-11-17', delta: -80, kind: 'bill' }, { date: '2026-11-19', delta: -415, kind: 'reserve' }] };
const INVEST = {
  total: 48210.55, cost: 40100, gain: 8110.55,
  accounts: [{ label: 'Roth Contributory IRA', value: 30110.2, gain: 5200.1 }, { label: 'Individual Brokerage', value: 18100.35 }],
  top: [{ ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', value: 21000, gain: -3100.126 }, { ticker: '', name: 'Cash and money market', value: 2100.25 }],
  history: [{ date: '2026-11-17', total: 48020.55 }, { date: '2026-11-18', total: 48100 }]
};
const withField = (o, k, v) => { const c = Object.assign({}, o); c[k] = v; return c; };

async function main() {
  await check('the made-up sample passes as it is, every section accepted', () => {
    const n = budget.normalizeSnapshot(sample(), NOW);
    assert.deepStrictEqual(n.rejected, []);
    assert.deepStrictEqual(Object.keys(n.sections), ALL8);
    assert.strictEqual(n.sections.room.roomPerDay, 42.5);
    assert.strictEqual(n.sections.cardDay.transfers.length, 3);
    assert.strictEqual(n.sections.goals.items.length, 5);
    assert.deepStrictEqual(n.sections.alerts.items, [{ id: 'a-1042', label: 'Corner Bakery Stand' }]);
    assert.strictEqual(n.sections.lab.room, 186.4);
    assert.strictEqual(n.sections.merchants.items.length, 5);
    assert.strictEqual(n.sections.pace.days.length, 14);
    // The sample's runway ends on card day at exactly the lab's room.
    const rw = n.sections.runway;
    const end = rw.steps.reduce((t, x) => t + x.delta, rw.start);
    assert.strictEqual(Math.round(end * 100) / 100, n.sections.lab.room);
    // combined counts a shared order once, so it is below the sum.
    const sum = n.sections.merchants.items.reduce((t, x) => t + x.mtd, 0);
    assert.ok(n.sections.merchants.combined < sum);
  });

  await check('a snapshot with only the first four sections is stored and shown exactly as before', () => {
    const s = sample();
    ['lab', 'merchants', 'pace', 'runway', 'investments'].forEach((k) => delete s[k]);
    const n = budget.normalizeSnapshot(s, NOW);
    assert.deepStrictEqual(n.rejected, []);
    assert.deepStrictEqual(Object.keys(n.sections), OLD4);
    const m = budget.merge(null, n, NOW);
    assert.deepStrictEqual(m.accepted, OLD4);
    const lines = budget.summaryLines(m.data);
    assert.strictEqual(lines.length, 5);
    assert.strictEqual(lines[1], '  room     9 days left through 2026-11-24, under the daily cap, a refund pending, as of 2026-11-16 15:05 UTC');
    assert.strictEqual(lines[4], '  alerts   1 new charge at a merchant you cut, as of 2026-11-16 15:05 UTC');
    // A later snapshot with the lab sections keeps the old four as they were.
    const m2 = budget.merge(m.data, budget.normalizeSnapshot(snap({ lab: LAB }), NOW), NOW);
    assert.deepStrictEqual(m2.accepted, ['lab']);
    OLD4.forEach((k) => assert.deepStrictEqual(m2.data[k], m.data[k]));
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

  await check('cardDay outlook: strict shape, a bad outlook is dropped and card day kept', () => {
    const M = (n) => ({ month: '2026-1' + n, days: 30, paydays: ['2026-1' + n + '-05'], paycheck: 4000, bills: 2000.004, cardRecurring: 300, planned: 0 });
    const OUT = { start: { date: '2026-12-01', behind: 0, ahead: 120 }, dailyAverage: 47.5, averageMonths: 3, months: [M(0), M(1), M(2)] };
    const c = (o) => one('cardDay', Object.assign({}, CARD, { outlook: o })).clean;
    const good = c(OUT);
    assert.strictEqual(good.outlook.months.length, 3);
    assert.strictEqual(good.outlook.months[0].bills, 2000);
    assert.strictEqual(good.outlook.start.ahead, 120);
    const extra = c(Object.assign({}, OUT, { balance: 5, months: [Object.assign({}, M(0), { note: 'x' })] }));
    assert.ok(!('balance' in extra.outlook) && !('note' in extra.outlook.months[0]));
    const bads = [
      'x', null, [],
      Object.assign({}, OUT, { months: [] }),
      Object.assign({}, OUT, { months: [M(0), M(1), M(2), M(3)] }),
      Object.assign({}, OUT, { months: [Object.assign({}, M(0), { paydays: ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22'] })] }),
      Object.assign({}, OUT, { months: [Object.assign({}, M(0), { month: '2026-13' })] }),
      Object.assign({}, OUT, { months: [Object.assign({}, M(0), { days: 40 })] }),
      Object.assign({}, OUT, { months: [Object.assign({}, M(0), { paycheck: -1 })] }),
      Object.assign({}, OUT, { months: [Object.assign({}, M(0), { bills: 2000000 })] }),
      Object.assign({}, OUT, { start: { date: '2026-12-01', behind: -5, ahead: 0 } }),
      Object.assign({}, OUT, { start: { date: 'soon', behind: 0, ahead: 0 } }),
      Object.assign({}, OUT, { start: { date: '2026-12-01', behind: 5 } }),
      Object.assign({}, OUT, { dailyAverage: 'a lot' }),
      Object.assign({}, OUT, { averageMonths: 2.5 })
    ];
    bads.forEach((b, n) => {
      const r = one('cardDay', Object.assign({}, CARD, { outlook: b }));
      if (b === null) return;
      assert.ok(r.clean && !('outlook' in r.clean), 'bad outlook ' + n + ' is dropped');
      assert.strictEqual(r.clean.date, '2026-11-19');
    });
  });

  await check('cardDay autopay days: byAutopay, autopayShortBy and the payment plan', () => {
    const short = Object.assign({}, CARD, { covered: false, shortBy: 954.2 });
    const plan = [
      { label: 'Sapphire Reserve', date: '2026-12-01', amount: 1200, kind: 'first' },
      { label: 'Sapphire Reserve', date: '2026-12-07', amount: 400.004, kind: 'autopay', note: 'dropped' }
    ];
    const ok = one('cardDay', Object.assign({}, short, { byAutopay: true, plan: plan })).clean;
    assert.strictEqual(ok.byAutopay, true);
    assert.strictEqual(ok.shortBy, 954.2);
    assert.deepStrictEqual(ok.plan[1], { label: 'Sapphire Reserve', date: '2026-12-07', amount: 400, kind: 'autopay' });
    assert.strictEqual(one('cardDay', Object.assign({}, short, { byAutopay: false, autopayShortBy: 120.5 })).clean.autopayShortBy, 120.5);
    // Left out stays left out: a snapshot from the old budget app is unchanged.
    const old = one('cardDay', short).clean;
    assert.ok(!('byAutopay' in old) && !('plan' in old) && !('autopayShortBy' in old));
    // Refused: byAutopay on a covered card day (true or false), autopayShortBy without byAutopay false.
    assert.ok(/"byAutopay" is only for a card day that is not covered/.test(one('cardDay', Object.assign({}, CARD, { byAutopay: true })).error));
    assert.ok(/"byAutopay" is only for a card day that is not covered/.test(one('cardDay', Object.assign({}, CARD, { byAutopay: false })).error));
    assert.ok(/"byAutopay" must be true or false/.test(one('cardDay', Object.assign({}, short, { byAutopay: 'yes' })).error));
    assert.ok(/"autopayShortBy" is only for/.test(one('cardDay', Object.assign({}, short, { byAutopay: true, autopayShortBy: 5 })).error));
    assert.ok(/"autopayShortBy" is only for/.test(one('cardDay', Object.assign({}, short, { autopayShortBy: 5 })).error));
    assert.ok(/"autopayShortBy" must be a number/.test(one('cardDay', Object.assign({}, short, { byAutopay: false, autopayShortBy: -1 })).error));
    // Plan rows: at most 6, each field checked, the covered case may carry a plan.
    const row = plan[0];
    assert.ok(/"plan" has 7 entries; at most 6/.test(one('cardDay', Object.assign({}, CARD, { plan: [row, row, row, row, row, row, row] })).error));
    assert.strictEqual(one('cardDay', Object.assign({}, CARD, { plan: [row, row, row, row, row, row] })).clean.plan.length, 6);
    assert.ok(/"kind" must be first or autopay \(payment 1\)/.test(one('cardDay', Object.assign({}, CARD, { plan: [withField(row, 'kind', 'later')] })).error));
    assert.ok(/"date" must be a real date like 2026-12-01 \(payment 1\)/.test(one('cardDay', Object.assign({}, CARD, { plan: [withField(row, 'date', 'Dec 1')] })).error));
    assert.ok(/"amount" is missing \(payment 1\)/.test(one('cardDay', Object.assign({}, CARD, { plan: [{ label: 'x', date: '2026-12-01', kind: 'first' }] })).error));
    assert.ok(/"amount" must be a number from 0 to 1,000,000 \(payment 1\)/.test(one('cardDay', Object.assign({}, CARD, { plan: [withField(row, 'amount', -3)] })).error));
    assert.ok(/"label" is missing \(payment 1\)/.test(one('cardDay', Object.assign({}, CARD, { plan: [{ date: '2026-12-01', amount: 1, kind: 'first' }] })).error));
    assert.strictEqual(one('cardDay', Object.assign({}, CARD, { plan: [withField(row, 'label', 'A card with a very long name indeed')] })).clean.plan[0].label.length, 24);
    assert.ok(/holds a link/.test(one('cardDay', Object.assign({}, CARD, { plan: [withField(row, 'label', 'https://x')] })).error));
  });

  await check('cardDay.receipt: the sample is kept whole, field by field, and unknown fields are dropped', () => {
    const n = budget.normalizeSnapshot(sample(), NOW);
    const r = n.sections.cardDay.receipt;
    assert.deepStrictEqual(r, sample().cardDay.receipt);
    assert.deepStrictEqual(r.lines.map((l) => l.key), ['checking', 'paychecks', 'billsBefore', 'cardsToday', 'billsAfter', 'buys']);
    assert.strictEqual(r.bottom, 430);
    assert.strictEqual(r.lines[3].items[0].autopay, '2026-11-27');
    const extra = sample().cardDay.receipt;
    extra.account = '1234';
    extra.lines[2].items[0].merchantId = 'x';
    extra.lines[2].items[0].new = false;
    const clean = one('cardDay', Object.assign({}, CARD, { receipt: extra })).clean.receipt;
    assert.ok(!('account' in clean) && !('merchantId' in clean.lines[2].items[0]) && !('new' in clean.lines[2].items[0]));
    // A card day with no receipt is stored as before.
    assert.ok(!('receipt' in one('cardDay', CARD).clean));
  });

  await check('cardDay.receipt: limits, signs, sums to the cent', () => {
    const base = () => sample().cardDay.receipt;
    const bad = (mut, re) => {
      const r = base();
      mut(r);
      const out = one('cardDay', Object.assign({}, CARD, { receipt: r }));
      assert.ok(out.error && re.test(out.error), out.error || 'was accepted');
    };
    bad((r) => { r.bottom = 430.01; }, /the lines do not add up to "bottom" \(receipt\)/);
    bad((r) => { r.lines[2].items[0].amount = 85.01; }, /its items do not add up to "amount" .*receipt line 3, billsBefore/);
    bad((r) => { r.lines[0].items = []; }, /"items" is not for the checking line/);
    bad((r) => { r.lines.shift(); }, /the first line must be "checking"/);
    bad((r) => { r.lines.push(r.lines[1]); }, /"paychecks" is used twice/);
    bad((r) => { r.lines[1].key = 'rent'; }, /"key" must be checking, paychecks/);
    bad((r) => { r.lines = []; }, /"lines" must have at least 1 entry/);
    bad((r) => { delete r.lines; }, /"lines" is missing/);
    bad((r) => { delete r.bottom; }, /"bottom" is missing/);
    bad((r) => { delete r.asOf; }, /"asOf" is missing/);
    bad((r) => { r.next.date = 'Nov 20'; }, /"date" must be a real date/);
    bad((r) => { r.perDay = -1; }, /"perDay" must be a number/);
    bad((r) => { r.lines[2].items[0].label = 'https://x.example'; }, /holds a link/);
    bad((r) => { r.lines[2].items[1].label = 'a@b.example'; }, /holds an email address/);
    bad((r) => { r.lines[2].items[0].date = '11/17'; }, /"date" must be a real date/);
    bad((r) => { r.lines[3].items[0].autopay = 'soon'; }, /"autopay" must be a real date/);
    bad((r) => { r.lines[3].items[0].pay = -5; }, /"pay" must be a number from 0 to 1,000,000/);
    bad((r) => { r.lines[3].items[0].new = 'yes'; }, /"new" must be true or false/);
    bad((r) => { r.lines[4].amount = 'lots'; }, /"amount" must be a number/);
    bad((r) => { r.lines[4].amount = -2000000; }, /"amount" must be a number from -1,000,000/);
    // Labels are cut, not refused: 30 for an item, 60 for a line.
    const long = base();
    long.lines[2].items[0].label = 'B'.repeat(45);
    long.lines[2].label = 'L'.repeat(80);
    const ok = one('cardDay', Object.assign({}, CARD, { receipt: long })).clean.receipt;
    assert.strictEqual(Array.from(ok.lines[2].items[0].label).length, 30);
    assert.strictEqual(Array.from(ok.lines[2].label).length, 60);
    // At most 12 items a line (13 refused), and at most 8 lines.
    const items = (n, amt) => Array.from({ length: n }, (_, i) => ({ label: 'Bill ' + i, amount: amt, date: '2026-11-18' }));
    const twelve = { asOf: SENT, bottom: 1000 - 12, lines: [{ key: 'checking', amount: 1000 }, { key: 'billsBefore', amount: -12, items: items(12, 1) }] };
    assert.strictEqual(one('cardDay', Object.assign({}, CARD, { receipt: twelve })).clean.receipt.lines[1].items.length, 12);
    const thirteen = { asOf: SENT, bottom: 1000 - 13, lines: [{ key: 'checking', amount: 1000 }, { key: 'billsBefore', amount: -13, items: items(13, 1) }] };
    assert.ok(/"items" has 13 entries; at most 12/.test(one('cardDay', Object.assign({}, CARD, { receipt: thirteen })).error));
    const nine = base();
    nine.lines = Array.from({ length: 9 }, () => nine.lines[0]);
    assert.ok(/"lines" has 9 entries; at most 8/.test(one('cardDay', Object.assign({}, CARD, { receipt: nine })).error));
    // Cents are compared whole: three 0.1 bills are 0.3.
    const cents = { asOf: SENT, bottom: 99.7, lines: [{ key: 'checking', amount: 100 }, { key: 'billsBefore', amount: -0.3, items: items(3, 0.1) }] };
    assert.strictEqual(one('cardDay', Object.assign({}, CARD, { receipt: cents })).clean.receipt.bottom, 99.7);
    // Paychecks add; a receipt may be short (negative bottom) and have no next paycheck.
    const short = { asOf: SENT, bottom: -50, lines: [{ key: 'checking', amount: 100 }, { key: 'paychecks', amount: 200, items: [{ label: 'Paycheck', amount: 200, date: '2026-11-18' }] }, { key: 'cardsToday', amount: -350, items: [{ label: 'Card', amount: 350 }] }] };
    const sh = one('cardDay', Object.assign({}, CARD, { covered: false, shortBy: 50, receipt: short })).clean.receipt;
    assert.strictEqual(sh.bottom, -50);
    assert.ok(!('next' in sh) && !('perDay' in sh));
  });

  await check('a snapshot with a receipt stays under the size cap and the receipt survives a merge', () => {
    const n = budget.normalizeSnapshot(sample(), NOW);
    const m = budget.merge(null, n, NOW);
    assert.strictEqual(m.data.cardDay.receipt.bottom, 430);
    assert.ok(budget.MAX_BYTES >= JSON.stringify(m.data).length);
    // The text ./hub prints never says a label or an amount of the receipt.
    const text = budget.summaryLines(m.data).join('\n');
    assert.ok(!/Rent|Phone|Headphones|4,200|4200/.test(text), text);
  });

  await check('room.basis and lab.autopayRoom / autopayDate', () => {
    assert.strictEqual(one('room', Object.assign({}, ROOM, { basis: 'autopay' })).clean.basis, 'autopay');
    assert.strictEqual(one('room', Object.assign({}, ROOM, { basis: 'first' })).clean.basis, 'first');
    assert.ok(!('basis' in one('room', ROOM).clean));
    assert.ok(/"basis" must be first or autopay/.test(one('room', Object.assign({}, ROOM, { basis: 'short' })).error));
    const lab = one('lab', Object.assign({}, LAB, { room: -954.2, autopayRoom: 61.255, autopayDate: '2026-12-07' })).clean;
    assert.strictEqual(lab.autopayRoom, 61.26);
    assert.strictEqual(lab.autopayDate, '2026-12-07');
    assert.strictEqual(one('lab', Object.assign({}, LAB, { autopayRoom: -20 })).clean.autopayRoom, -20);
    assert.ok(!('autopayRoom' in one('lab', LAB).clean));
    assert.ok(/"autopayRoom" must be a number/.test(one('lab', Object.assign({}, LAB, { autopayRoom: 'lots' })).error));
    assert.ok(/"autopayDate" must be a real date/.test(one('lab', Object.assign({}, LAB, { autopayDate: 'Dec 7' })).error));
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

  await check('goals: spent and limit go together; pace only beside them', () => {
    const g = { label: 'Dining', state: 'over', text: '$62 over', pct: 100 };
    const full = one('goals', [Object.assign({}, g, { spent: 462.404, limit: 400, pace: 801 })]).clean.items[0];
    assert.deepStrictEqual(full, Object.assign({}, g, { spent: 462.4, limit: 400, pace: 801 }));
    assert.ok(/"spent" and "limit" go together/.test(one('goals', [Object.assign({}, g, { spent: 10 })]).error));
    assert.ok(/"limit" must be a number more than 0/.test(one('goals', [Object.assign({}, g, { spent: 0, limit: 0 })]).error));
    assert.strictEqual('pace' in one('goals', [Object.assign({}, g, { pace: 5 })]).clean.items[0], false);
  });

  await check('alerts: id and label only (an amount is dropped), unique ids, at most 5', () => {
    const a = one('alerts', [{ id: 'x1', label: 'Corner Bakery Stand', amount: 6.5 }]).clean;
    assert.deepStrictEqual(a.items, [{ id: 'x1', label: 'Corner Bakery Stand' }]);
    assert.ok(/used twice/.test(one('alerts', [{ id: 'x1', label: 'A' }, { id: 'x1', label: 'B' }]).error));
    assert.ok(/at most 5/.test(one('alerts', [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'x' + n, label: 'L' }))).error));
    assert.deepStrictEqual(one('alerts', []).clean.items, []);
  });

  await check('lab: required fields, signed room, days, month day, the split', () => {
    assert.deepStrictEqual(one('lab', LAB).clean, Object.assign({ asOf: SENT }, LAB));
    const neg = one('lab', withField(LAB, 'room', -9.544)).clean;
    assert.strictEqual(neg.room, -9.54);
    assert.strictEqual(one('lab', withField(LAB, 'daysLeft', 0)).clean.daysLeft, 0);
    ['room', 'spentToday', 'daysLeft', 'cardDate', 'monthDay'].forEach((k) => {
      const l = Object.assign({}, LAB);
      delete l[k];
      assert.ok(new RegExp('"' + k + '" is missing').test(one('lab', l).error), k);
    });
    assert.ok(/"spentToday" must be a number from 0 to 1,000,000/.test(one('lab', withField(LAB, 'spentToday', -1)).error));
    assert.ok(/"daysLeft" must be a whole number from 0 to 366/.test(one('lab', withField(LAB, 'daysLeft', 367)).error));
    assert.ok(/"monthDay" must be a whole number from 1 to 31/.test(one('lab', withField(LAB, 'monthDay', 0)).error));
    assert.ok(/"monthDay" must be a whole number from 1 to 31/.test(one('lab', withField(LAB, 'monthDay', 32)).error));
    assert.ok(/"cardDate" must be a real date/.test(one('lab', withField(LAB, 'cardDate', '2026-12')).error));
    const split = [{ key: 'savings', amount: 500 }, { key: 'awws', amount: 150 }, { key: 'buffer', amount: 350 }, { key: 'extra', amount: 0, note: 'x' }];
    assert.deepStrictEqual(one('lab', withField(LAB, 'split', split)).clean.split, split.map((e) => ({ key: e.key, amount: e.amount })));
    assert.ok(/"split" has 5 entries; at most 4/.test(one('lab', withField(LAB, 'split', split.concat([split[0]]))).error));
    assert.ok(/"key" must be savings, awws, buffer or extra \(split entry 1\)/.test(one('lab', withField(LAB, 'split', [{ key: 'rent', amount: 1 }])).error));
    assert.ok(/the key "awws" is used twice \(split entry 2\)/.test(one('lab', withField(LAB, 'split', [split[1], split[1]])).error));
    assert.ok(/"amount" is missing \(split entry 1\)/.test(one('lab', withField(LAB, 'split', [{ key: 'savings' }])).error));
    // A balance sent alongside is dropped, never stored.
    assert.ok(!('checking' in one('lab', withField(LAB, 'checking', 2400)).clean));
  });

  await check('merchants: month, at most 5, label text 30, mtd, count 0 to 999, combined required', () => {
    assert.deepStrictEqual(one('merchants', MERCH).clean, Object.assign({ asOf: SENT }, MERCH));
    assert.ok(/"month" must be a month like 2026-11/.test(one('merchants', withField(MERCH, 'month', '2026-13')).error));
    assert.ok(/"combined" is missing/.test(one('merchants', { month: '2026-11', items: [] }).error));
    assert.ok(/"items" is missing/.test(one('merchants', { month: '2026-11', combined: 0 }).error));
    const six = [1, 2, 3, 4, 5, 6].map((n) => ({ label: 'M' + n, mtd: n, count: 1 }));
    assert.ok(/"items" has 6 entries; at most 5/.test(one('merchants', withField(MERCH, 'items', six)).error));
    assert.ok(/"count" must be a whole number from 0 to 999 \(merchant 1\)/.test(one('merchants', withField(MERCH, 'items', [{ label: 'A', mtd: 1, count: 1000 }])).error));
    assert.ok(/"mtd" must be a number from 0 to 1,000,000 \(merchant 1\)/.test(one('merchants', withField(MERCH, 'items', [{ label: 'A', mtd: -1, count: 1 }])).error));
    assert.ok(/"label" is missing \(merchant 1\)/.test(one('merchants', withField(MERCH, 'items', [{ mtd: 1, count: 1 }])).error));
    assert.ok(/holds a link/.test(one('merchants', withField(MERCH, 'items', [{ label: 'See www.example.com', mtd: 1, count: 1 }])).error));
    const long = one('merchants', withField(MERCH, 'items', [{ label: 'A very long merchant name that runs on', mtd: 1, count: 1, transactions: [1, 2] }])).clean.items[0];
    assert.strictEqual(Array.from(long.label).length, 30);
    assert.ok(!('transactions' in long));
    assert.ok(/must be an object/.test(one('merchants', [MERCH.items[0]]).error), 'not a list section');
  });

  await check('pace: one total per day, oldest first, each date once, cap above 0 or left out, at most 31', () => {
    const days = [{ date: '2026-11-14', spent: 71.204, cap: 95.29 }, { date: '2026-11-15', spent: 0 }];
    assert.deepStrictEqual(one('pace', { days: days }).clean, { asOf: SENT, days: [{ date: '2026-11-14', spent: 71.2, cap: 95.29 }, { date: '2026-11-15', spent: 0 }] });
    assert.deepStrictEqual(one('pace', { days: [] }).clean.days, []);
    assert.ok(/"days" is missing/.test(one('pace', {}).error));
    assert.ok(/"cap" must be a number more than 0 and up to 1,000,000 \(day 1\)/.test(one('pace', { days: [{ date: '2026-11-14', spent: 1, cap: 0 }] }).error));
    assert.ok(/"spent" is missing \(day 1\)/.test(one('pace', { days: [{ date: '2026-11-14' }] }).error));
    assert.ok(/oldest first, each date once\) \(day 2\)/.test(one('pace', { days: [days[1], days[0]] }).error));
    assert.ok(/oldest first, each date once/.test(one('pace', { days: [days[0], days[0]] }).error));
    const many = [];
    for (let d = 1; d <= 32; d++) many.push({ date: new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10), spent: 1 });
    assert.ok(/"days" has 32 entries; at most 31/.test(one('pace', { days: many }).error));
    assert.strictEqual(one('pace', { days: many.slice(1) }).clean.days.length, 31);
    // Charges inside a day are dropped, never stored.
    assert.ok(!('charges' in one('pace', { days: [{ date: '2026-11-14', spent: 5, charges: [{ label: 'x', amount: 5 }] }] }).clean.days[0]));
  });

  await check('runway: signed start, end, steps in date order up to card day, pay up, bill and reserve down, no names', () => {
    assert.deepStrictEqual(one('runway', RUNWAY).clean, Object.assign({ asOf: SENT }, RUNWAY));
    assert.strictEqual(one('runway', withField(RUNWAY, 'start', -731.004)).clean.start, -731);
    assert.ok(/"start" is missing/.test(one('runway', { end: '2026-11-19', steps: [] }).error));
    assert.ok(/"end" must be a real date/.test(one('runway', withField(RUNWAY, 'end', 'Dec 1')).error));
    assert.ok(/"steps" is missing/.test(one('runway', { start: 1, end: '2026-11-19' }).error));
    const step = { date: '2026-11-17', delta: -1, kind: 'bill' };
    assert.ok(/"steps" has 41 entries; at most 40/.test(one('runway', withField(RUNWAY, 'steps', new Array(41).fill(step))).error));
    assert.strictEqual(one('runway', withField(RUNWAY, 'steps', new Array(40).fill(step))).clean.steps.length, 40);
    assert.ok(/"kind" must be pay, bill or reserve \(step 1\)/.test(one('runway', withField(RUNWAY, 'steps', [withField(step, 'kind', 'transfer')])).error));
    assert.ok(/"delta" must be 0 or more for a pay step/.test(one('runway', withField(RUNWAY, 'steps', [{ date: '2026-11-17', delta: -5, kind: 'pay' }])).error));
    assert.ok(/"delta" must be 0 or less for a bill step/.test(one('runway', withField(RUNWAY, 'steps', [withField(step, 'delta', 5)])).error));
    assert.ok(/"delta" must be 0 or less for a reserve step/.test(one('runway', withField(RUNWAY, 'steps', [{ date: '2026-11-19', delta: 5, kind: 'reserve' }])).error));
    assert.ok(/steps in date order\) \(step 2\)/.test(one('runway', withField(RUNWAY, 'steps', [withField(step, 'date', '2026-11-18'), step])).error));
    assert.ok(/must not come after "end"/.test(one('runway', withField(RUNWAY, 'steps', [withField(step, 'date', '2026-11-20')])).error));
    // A bill's name, or a checking balance, is dropped.
    const named = one('runway', Object.assign({ checking: 2400 }, withField(RUNWAY, 'steps', [withField(step, 'label', 'Phone bill')]))).clean;
    assert.deepStrictEqual(named.steps[0], step);
    assert.ok(!('checking' in named));
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
    assert.deepStrictEqual(first.accepted, ALL8);
    const next = budget.normalizeSnapshot(snap({ alerts: null, room: Object.assign({}, ROOM, { cap: -1 }), goals: [], pace: null,
      merchants: withField(MERCH, 'month', 'Nov'), runway: RUNWAY }), NOW);
    const m = budget.merge(first.data, next, NOW);
    assert.deepStrictEqual(m.accepted, ['goals', 'runway']);
    assert.deepStrictEqual(m.cleared, ['alerts', 'pace']);
    assert.deepStrictEqual(m.rejected.map((r) => r.section), ['room', 'merchants']);
    assert.deepStrictEqual(m.data.room, first.data.room);
    assert.deepStrictEqual(m.data.merchants, first.data.merchants);
    assert.deepStrictEqual(m.data.lab, first.data.lab);
    assert.deepStrictEqual(m.data.runway, Object.assign({ asOf: SENT }, RUNWAY));
    assert.ok(!('alerts' in m.data) && !('pace' in m.data));
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
    const r = budget.cleanResource({ rev: 4, data: { v: 1, sentAt: SENT, receivedAt: 'later', room: ROOM, cardDay: { date: 'x' }, lab: LAB, pace: { days: 'x' } } });
    assert.strictEqual(r.rev, 4);
    assert.strictEqual(r.data.receivedAt, null);
    assert.strictEqual(r.data.room.cap, 60);
    assert.strictEqual(r.data.lab.room, 186.4);
    assert.ok(!('cardDay' in r.data));
    assert.ok(!('pace' in r.data));
  });

  await check('./hub budget show: times, counts and states, never a label or an amount', () => {
    assert.deepStrictEqual(budget.summaryLines(budget.emptyData()), ['No budget snapshot yet. The TV tiles say "Waiting for the budget app".']);
    const m = budget.merge(null, budget.normalizeSnapshot(sample(), NOW), NOW);
    const lines = budget.summaryLines(m.data);
    assert.ok(/^Budget snapshot sent 2026-11-16 15:10 UTC, received 2026-11-16 15:12 UTC\. [\d.]+ (KB|bytes) of 48 KB\.$/.test(lines[0]), lines[0]);
    assert.deepStrictEqual(lines.slice(1), [
      '  room         9 days left through 2026-11-24, under the daily cap, a refund pending, as of 2026-11-16 15:05 UTC',
      '  cardDay      2026-11-19 (in 3 days), covered, 3 transfers, 2 paychecks, as of 2026-11-16 15:05 UTC',
      '  goals        5 goals (2 clean, 1 on pace, 1 over, 1 under), as of 2026-11-16 15:05 UTC',
      '  alerts       1 new charge at a merchant you cut, as of 2026-11-16 15:05 UTC',
      '  lab          2026-11-19 (3 days left), day 16 of the month, room to spare, split in 3, as of 2026-11-16 15:05 UTC',
      '  merchants    5 merchants in 2026-11, as of 2026-11-16 15:05 UTC',
      '  pace         14 days (13 with a cap), 2026-11-02 to 2026-11-15, as of 2026-11-16 15:05 UTC',
      '  runway       3 steps to 2026-11-19 (0 paydays, 2 bills, 1 reserve), as of 2026-11-16 15:05 UTC',
      '  investments  2 accounts, 5 holdings, 13 days of history, 2026-11-06 to 2026-11-18, as of 2026-11-16 15:05 UTC'
    ]);
    const all = JSON.stringify(lines) + JSON.stringify(budget.summaryData(m.data));
    // No label, merchant name or amount from any section, Budget lab's included.
    const s = sample();
    const words = ['Bakery', 'Groceries', 'checking', '42.5', '310', '$', '186.4', '23.75', '498.57', '766.9', '415', '71.2', 'Roth', 'Vanguard', '48210', '30110', '8110', '21000'];
    s.merchants.items.forEach((x) => words.push(x.label, String(x.mtd)));
    words.forEach((w) => assert.ok(all.indexOf(w) < 0, 'shows ' + w));
    const sum = budget.summaryData(m.data).sections;
    assert.deepStrictEqual(sum.goals, { asOf: '2026-11-16T15:05:00Z', goals: 5, clean: 2, 'on-pace': 1, over: 1, under: 1 });
    assert.deepStrictEqual(sum.lab, { asOf: '2026-11-16T15:05:00Z', cardDate: '2026-11-19', daysLeft: 3, monthDay: 16, state: 'spare', split: 3 });
    assert.deepStrictEqual(sum.merchants, { asOf: '2026-11-16T15:05:00Z', month: '2026-11', merchants: 5 });
    assert.deepStrictEqual(sum.pace, { asOf: '2026-11-16T15:05:00Z', days: 14, capped: 13, from: '2026-11-02', to: '2026-11-15' });
    assert.deepStrictEqual(sum.runway, { asOf: '2026-11-16T15:05:00Z', end: '2026-11-19', steps: 3, pay: 0, bill: 2, reserve: 1 });
  });

  await check('./hub budget show for the lab sections: short, no room, no days yet, paydays', () => {
    const n = budget.normalizeSnapshot(snap({ lab: withField(withField(LAB, 'room', -9.54), 'daysLeft', 1), pace: { days: [] }, runway: RUNWAY, merchants: withField(MERCH, 'items', [MERCH.items[0]]) }), NOW);
    const lines = budget.summaryLines(budget.merge(null, n, NOW).data);
    assert.deepStrictEqual(lines.slice(1), [
      '  lab        2026-11-19 (1 day left), day 16 of the month, room short, as of 2026-11-16 15:10 UTC',
      '  merchants  1 merchant in 2026-11, as of 2026-11-16 15:10 UTC',
      '  pace       no days yet, as of 2026-11-16 15:10 UTC',
      '  runway     3 steps to 2026-11-19 (1 payday, 1 bill, 1 reserve), as of 2026-11-16 15:10 UTC'
    ]);
    const zero = budget.normalizeSnapshot(snap({ lab: withField(LAB, 'room', 0) }), NOW);
    assert.ok(/, no room, as of/.test(budget.summaryLines(budget.merge(null, zero, NOW).data)[1]));
  });

  await check('investments: the clean copy, signed gains, a blank ticker, optional parts', () => {
    const c = one('investments', INVEST).clean;
    assert.strictEqual(c.asOf, SENT);
    assert.strictEqual(c.total, 48210.55);
    assert.strictEqual(c.cost, 40100);
    assert.strictEqual(c.gain, 8110.55);
    assert.strictEqual(c.top[0].gain, -3100.13);
    assert.ok(!('ticker' in c.top[1]), 'blank ticker is left out');
    assert.ok(!('gain' in c.top[1]));
    assert.ok(!('gain' in c.accounts[1]));
    const min = one('investments', { total: 10, accounts: [{ label: 'IRA', value: 10 }] }).clean;
    assert.deepStrictEqual(Object.keys(min), ['asOf', 'total', 'accounts']);
    assert.strictEqual(one('investments', withField(INVEST, 'gain', -250.5)).clean.gain, -250.5);
    assert.strictEqual(one('investments', withField(INVEST, 'total', 0)).clean.total, 0);
    assert.strictEqual(one('investments', withField(INVEST, 'total', 10000000)).clean.total, 10000000);
    assert.deepStrictEqual(one('investments', withField(INVEST, 'history', [])).clean.history, []);
    assert.deepStrictEqual(one('investments', withField(INVEST, 'top', [])).clean.top, []);
    const both = one('investments', withField(withField(INVEST, 'top', []), 'history', [])).clean;
    assert.deepStrictEqual([both.top, both.history], [[], []]);
    // Unknown fields (a quantity, an account number) are dropped, never stored.
    const x = one('investments', withField(INVEST, 'accounts', [{ label: 'IRA', value: 5, number: '1234', qty: 9 }])).clean;
    assert.deepStrictEqual(x.accounts, [{ label: 'IRA', value: 5 }]);
  });

  await check('investments: amounts 0 to 10,000,000, gain signed, required fields, counts', () => {
    const err = (k, v) => one('investments', withField(INVEST, k, v)).error;
    assert.ok(/"total" must be a number from 0 to 10,000,000/.test(err('total', -1)));
    assert.ok(/"total" must be a number from 0 to 10,000,000/.test(err('total', 10000000.01)));
    assert.ok(/"total" must be a number/.test(err('total', '48000')));
    assert.ok(/"cost" must be a number from 0 to 10,000,000/.test(err('cost', -5)));
    assert.ok(/"gain" must be a number from -10,000,000 to 10,000,000/.test(err('gain', 10000001)));
    assert.ok(/"total" is missing/.test(one('investments', { accounts: INVEST.accounts }).error));
    assert.ok(/"accounts" is missing/.test(one('investments', { total: 1 }).error));
    assert.ok(/"accounts" must have at least 1 entry/.test(err('accounts', [])));
    const six = []; for (let i = 0; i < 7; i++) six.push({ label: 'A' + i, value: 1 });
    assert.ok(/"accounts" has 7 entries; at most 6/.test(err('accounts', six)));
    assert.strictEqual(one('investments', withField(INVEST, 'accounts', six.slice(0, 6))).clean.accounts.length, 6);
    assert.ok(/"value" must be a number from 0 to 10,000,000/.test(err('accounts', [{ label: 'IRA', value: -1 }])));
    assert.ok(/"label" is missing/.test(err('accounts', [{ value: 1 }])));
    assert.ok(/"name" is missing/.test(err('top', [{ ticker: 'VTI', value: 1 }])));
    const nine = []; for (let i = 0; i < 9; i++) nine.push({ name: 'H' + i, value: 1 });
    assert.ok(/"top" has 9 entries; at most 8/.test(err('top', nine)));
    assert.strictEqual(one('investments', withField(INVEST, 'top', nine.slice(0, 8))).clean.top.length, 8);
    assert.ok(/"gain" must be a number/.test(err('top', [{ name: 'H', value: 1, gain: 'up' }])));
  });

  await check('investments: text limits (30, 10, 40), no emails or links', () => {
    const acc = one('investments', withField(INVEST, 'accounts', [{ label: 'L'.repeat(40), value: 1 }])).clean.accounts[0].label;
    assert.strictEqual(Array.from(acc).length, 30);
    assert.ok(/…$/.test(acc));
    const top = one('investments', withField(INVEST, 'top', [{ ticker: 'T'.repeat(14), name: 'N'.repeat(60), value: 1 }])).clean.top[0];
    assert.strictEqual(Array.from(top.ticker).length, 10);
    assert.strictEqual(Array.from(top.name).length, 40);
    assert.ok(/holds an email address/.test(one('investments', withField(INVEST, 'accounts', [{ label: 'me@example.com', value: 1 }])).error));
    assert.ok(/holds a link/.test(one('investments', withField(INVEST, 'top', [{ name: 'www.example.com fund', value: 1 }])).error));
    assert.ok(/holds a link/.test(one('investments', withField(INVEST, 'top', [{ ticker: 'VTI', name: 'See https://x.test', value: 1 }])).error));
    assert.strictEqual(one('investments', withField(INVEST, 'top', [{ ticker: 'BRK.B', name: 'Berkshire Hathaway B', value: 1 }])).clean.top[0].ticker, 'BRK.B');
  });

  await check('investments: history is oldest first, each date once, real dates, at most 92', () => {
    const err = (h) => one('investments', withField(INVEST, 'history', h)).error;
    assert.ok(/"date" must come after the day before it/.test(err([{ date: '2026-11-18', total: 1 }, { date: '2026-11-18', total: 2 }])));
    assert.ok(/"date" must come after the day before it/.test(err([{ date: '2026-11-18', total: 1 }, { date: '2026-11-17', total: 2 }])));
    assert.ok(/"date" must be a real date/.test(err([{ date: '2026-02-30', total: 1 }])));
    assert.ok(/"total" is missing/.test(err([{ date: '2026-11-18' }])));
    assert.ok(/"total" must be a number from 0 to 10,000,000/.test(err([{ date: '2026-11-18', total: -3 }])));
    const day = (i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), total: 100 + i });
    const h92 = []; for (let i = 0; i < 92; i++) h92.push(day(i));
    assert.strictEqual(one('investments', withField(INVEST, 'history', h92)).clean.history.length, 92);
    assert.ok(/"history" has 93 entries; at most 92/.test(err(h92.concat([day(92)]))));
  });

  await check('investments: null clears it, other sections are kept, a bad one is refused by name', () => {
    const m = budget.merge(null, budget.normalizeSnapshot(snap({ room: ROOM, investments: INVEST }), NOW), NOW);
    assert.deepStrictEqual(m.accepted, ['room', 'investments']);
    const m2 = budget.merge(m.data, budget.normalizeSnapshot(snap({ investments: null }), NOW), NOW);
    assert.deepStrictEqual(m2.cleared, ['investments']);
    assert.ok(!('investments' in m2.data));
    assert.deepStrictEqual(m2.data.room, m.data.room);
    // A bad investments section is rejected alone and the last good copy stays.
    const m3 = budget.merge(m.data, budget.normalizeSnapshot(snap({ room: ROOM, investments: withField(INVEST, 'total', -1) }), NOW), NOW);
    assert.strictEqual(m3.rejected.length, 1);
    assert.strictEqual(m3.rejected[0].section, 'investments');
    assert.deepStrictEqual(m3.data.investments, m.data.investments);
    // A section already stored that no longer passes is dropped on load.
    const broken = JSON.parse(JSON.stringify(m.data)); broken.investments.accounts = [];
    assert.ok(!('investments' in budget.cleanResource({ rev: 1, data: broken }).data));
  });

  await check('./hub budget show for investments: counts and dates only, never a name or an amount', () => {
    const n = budget.normalizeSnapshot(snap({ investments: INVEST }), NOW);
    const data = budget.merge(null, n, NOW).data;
    const lines = budget.summaryLines(data);
    assert.strictEqual(lines[1], '  investments  2 accounts, 2 holdings, 2 days of history, 2026-11-17 to 2026-11-18, as of 2026-11-16 15:10 UTC');
    const all = JSON.stringify(lines) + JSON.stringify(budget.summaryData(data));
    ['Roth', 'Vanguard', 'VTI', '48210', '30110', '8110', '40100', '48020', 'Cash'].forEach((w) => assert.ok(all.indexOf(w) < 0, 'shows ' + w));
    assert.deepStrictEqual(budget.summaryData(data).sections.investments, { asOf: SENT, accounts: 2, holdings: 2, days: 2, from: '2026-11-17', to: '2026-11-18' });
    const none = budget.normalizeSnapshot(snap({ investments: { total: 5, accounts: [{ label: 'IRA', value: 5 }] } }), NOW);
    assert.ok(/1 account, 0 holdings, no history yet, as of/.test(budget.summaryLines(budget.merge(null, none, NOW).data)[1]));
  });

  const TRENDS = {
    month: '2026-11',
    categories: [{ label: 'Food', mtd: 412.004, usual: 520 }, { label: 'Getting around', mtd: 96, usual: null }, { label: 'Everything else', mtd: 251 }],
    merchants: [{ label: 'Hilltop Grocer', mtd: 184, usual: 205 }],
    weekdays: [38, 35, null, 41, 71, 96.555, 83]
  };

  await check('trends: month required, every list optional, usual optional or null, cents, unknown fields dropped', () => {
    const c = one('trends', Object.assign({ days: [{ date: '2026-11-15', spent: 3 }], combined: 9 }, TRENDS)).clean;
    assert.deepStrictEqual(c, { asOf: SENT, month: '2026-11',
      categories: [{ label: 'Food', mtd: 412, usual: 520 }, { label: 'Getting around', mtd: 96 }, { label: 'Everything else', mtd: 251 }],
      merchants: [{ label: 'Hilltop Grocer', mtd: 184, usual: 205 }], weekdays: [38, 35, null, 41, 71, 96.56, 83] });
    assert.deepStrictEqual(one('trends', { month: '2026-11' }).clean, { asOf: SENT, month: '2026-11' });
    assert.deepStrictEqual(one('trends', { month: '2026-11', categories: [] }).clean.categories, []);
    assert.ok(/"month" is missing/.test(one('trends', { categories: [] }).error));
    assert.ok(/"month" must be a month like 2026-11/.test(one('trends', withField(TRENDS, 'month', 'Nov')).error));
    const extra = one('trends', withField(TRENDS, 'categories', [{ label: 'Food', mtd: 1, usual: 2, transactions: [1], note: 'x' }])).clean.categories[0];
    assert.deepStrictEqual(extra, { label: 'Food', mtd: 1, usual: 2 });
  });

  await check('trends: at most 8 rows a list, label text 30, no links or emails, amounts 0 to 1,000,000', () => {
    const nine = []; for (let i = 0; i < 9; i++) nine.push({ label: 'Row ' + i, mtd: i });
    assert.ok(/"categories" has 9 entries; at most 8/.test(one('trends', withField(TRENDS, 'categories', nine)).error));
    assert.ok(/"merchants" has 9 entries; at most 8/.test(one('trends', withField(TRENDS, 'merchants', nine)).error));
    assert.strictEqual(one('trends', withField(TRENDS, 'merchants', nine.slice(1))).clean.merchants.length, 8);
    assert.ok(/"label" is missing \(category 1\)/.test(one('trends', withField(TRENDS, 'categories', [{ mtd: 1 }])).error));
    assert.ok(/"mtd" is missing \(merchant 1\)/.test(one('trends', withField(TRENDS, 'merchants', [{ label: 'A' }])).error));
    assert.ok(/"mtd" must be a number from 0 to 1,000,000 \(category 1\)/.test(one('trends', withField(TRENDS, 'categories', [{ label: 'A', mtd: -1 }])).error));
    assert.ok(/"usual" must be a number from 0 to 1,000,000 \(merchant 1\)/.test(one('trends', withField(TRENDS, 'merchants', [{ label: 'A', mtd: 1, usual: 'lots' }])).error));
    assert.ok(/holds a link/.test(one('trends', withField(TRENDS, 'merchants', [{ label: 'See www.example.com', mtd: 1 }])).error));
    assert.ok(/holds an email address|email/.test(one('trends', withField(TRENDS, 'categories', [{ label: 'me@example.com', mtd: 1 }])).error));
    const long = one('trends', withField(TRENDS, 'categories', [{ label: 'A very long category name that runs on and on', mtd: 1 }])).clean.categories[0].label;
    assert.ok(long.length <= 30 && /…$/.test(long), long);
    assert.ok(/each category must be an object/.test(one('trends', withField(TRENDS, 'categories', ['Food'])).error));
  });

  await check('trends: weekdays exactly 7, Monday to Sunday, each dollars or null', () => {
    assert.ok(/exactly 7 entries, Monday to Sunday/.test(one('trends', withField(TRENDS, 'weekdays', [1, 2, 3])).error));
    assert.ok(/"weekdays" has 8 entries; at most 7/.test(one('trends', withField(TRENDS, 'weekdays', [1, 2, 3, 4, 5, 6, 7, 8])).error));
    assert.ok(/"weekdays" must be a list/.test(one('trends', withField(TRENDS, 'weekdays', { mon: 1 })).error));
    assert.ok(/"weekdays" must be a number from 0 to 1,000,000 \(weekday 3\)/.test(one('trends', withField(TRENDS, 'weekdays', [1, 2, -3, 4, 5, 6, 7])).error));
    assert.ok(/\(weekday 7\)/.test(one('trends', withField(TRENDS, 'weekdays', [1, 2, 3, 4, 5, 6, '7'])).error));
    assert.deepStrictEqual(one('trends', withField(TRENDS, 'weekdays', [null, null, null, null, null, null, null])).clean.weekdays, [null, null, null, null, null, null, null]);
  });

  await check('trends: stored next to the others, null clears it, a bad one keeps the last good copy, 48 KB still holds', () => {
    const m = budget.merge(null, budget.normalizeSnapshot(snap({ room: ROOM, trends: TRENDS }), NOW), NOW);
    assert.deepStrictEqual(m.accepted, ['room', 'trends']);
    const m2 = budget.merge(m.data, budget.normalizeSnapshot(snap({ room: ROOM, trends: withField(TRENDS, 'weekdays', [1]) }), NOW), NOW);
    assert.deepStrictEqual(m2.rejected.map((r) => r.section), ['trends']);
    assert.deepStrictEqual(m2.data.trends, m.data.trends);
    const m3 = budget.merge(m.data, budget.normalizeSnapshot(snap({ trends: null }), NOW), NOW);
    assert.deepStrictEqual(m3.cleared, ['trends']);
    assert.ok(!('trends' in m3.data) && m3.data.room);
    // Full lists stay far under the cap: 8 + 8 rows of 30-character labels and 7 weekdays.
    const row = (i) => ({ label: 'x'.repeat(29) + i, mtd: 999999.99, usual: 999999.99 });
    const full = { month: '2026-11', categories: [0, 1, 2, 3, 4, 5, 6, 7].map(row), merchants: [0, 1, 2, 3, 4, 5, 6, 7].map(row), weekdays: [1, 2, 3, 4, 5, 6, 7] };
    const big = budget.merge(null, budget.normalizeSnapshot(snap({ trends: full }), NOW), NOW);
    assert.ok(big.bytes < 2500, big.bytes + ' bytes');
    // A stored trends section that no longer passes is dropped on load.
    const broken = JSON.parse(JSON.stringify(m.data)); broken.trends.weekdays = [1, 2];
    assert.ok(!('trends' in budget.cleanResource({ rev: 1, data: broken }).data));
    assert.ok(budget.cleanResource({ rev: 1, data: m.data }).data.trends);
  });

  await check('./hub budget show for trends: counts only, never a label or an amount', () => {
    const data = budget.merge(null, budget.normalizeSnapshot(snap({ trends: TRENDS }), NOW), NOW).data;
    const lines = budget.summaryLines(data);
    assert.strictEqual(lines[1], '  trends  3 categories, 1 merchant, 6 of 7 weekdays in 2026-11, as of 2026-11-16 15:10 UTC');
    assert.deepStrictEqual(budget.summaryData(data).sections.trends, { asOf: SENT, month: '2026-11', categories: 3, merchants: 1, weekdays: 6 });
    const all = JSON.stringify(lines) + JSON.stringify(budget.summaryData(data));
    ['Food', 'Hilltop', 'Getting', 'Everything', '412', '520', '184', '205', '96.56', '71'].forEach((w) => assert.ok(all.indexOf(w) < 0, 'shows ' + w));
    const bare = budget.summaryLines(budget.merge(null, budget.normalizeSnapshot(snap({ trends: { month: '2026-11', categories: [{ label: 'A', mtd: 1 }] } }), NOW), NOW).data);
    assert.ok(/  trends  1 category, 0 merchants, no weekdays in 2026-11, as of/.test(bare[1]), bare[1]);
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
