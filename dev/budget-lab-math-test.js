/*
 * Budget lab's arithmetic, in Node: node dev/budget-lab-math-test.js
 *
 * Loads app/budget-lab-math.js the two ways it is used (in a vm with a stub
 * window, as the TV does, and through require) and checks the plan's worked
 * examples A and B and every row of its edge case table: card day today, no
 * lab, a negative room, one day left, the 1st and 2nd of the month, a saved
 * cap from the last cycle, new data while the tab is open and a pinned Daily
 * room cap. Then the cuts' limits, the destinations, the streak and
 * yesterday, each suggested move, the key steps, the runway line, the
 * runway chart's days and fixed y range, and broken data. The figures are made up (this repository is public). Only what ships
 * with Node is used. Prints one line per check, then "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FILE = path.join(__dirname, '..', 'app', 'budget-lab-math.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const L = require(FILE);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.message));
  }
}
function same(a, b, text) { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), text); }

// Today Nov 17, card day Dec 1: D = 14, E = 17.
const TODAY = '2026-11-17';
function lab(room, extra) {
  return Object.assign({ asOf: '2026-11-17T14:00:00Z', room: room, spentToday: 0, daysLeft: 14, cardDate: '2026-12-01', monthDay: 17 }, extra || {});
}
// Amazon 495 over 17 days projects to 408 over 14; DoorDash 120 to 99.
const MERCHANTS = {
  asOf: '2026-11-17T14:00:00Z',
  month: '2026-11',
  combined: 640,
  items: [
    { label: 'Amazon', mtd: 495, count: 11 },
    { label: 'DoorDash', mtd: 120, count: 4 },
    { label: 'Corner Bakery Stand', mtd: 40, count: 8 }
  ]
};
function pace(list) { return { asOf: '2026-11-17T14:00:00Z', days: list }; }
// Ten under days ending yesterday.
function underDays(n, endDate) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ date: L.addDays(endDate || '2026-11-16', -i), spent: 60, cap: 95.29 });
  return out;
}
function run(over) {
  return L.compute(Object.assign({ lab: lab(1334), merchants: MERCHANTS, pace: pace(underDays(10)), today: TODAY, session: L.newSession() }, over || {}));
}

/* ---------- the file ---------- */

check('loads in a vm with a stub window as window.HUB_BUDGET_LAB_MATH', () => {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(SOURCE, box, { filename: FILE });
  const api = box.window.HUB_BUDGET_LAB_MATH;
  assert.ok(api && typeof api.compute === 'function');
  assert.strictEqual(api.compute({ lab: lab(1334) }).c0, 95.29);
});

check('plain ES5: no let, const, arrows or template strings, and no DOM', () => {
  let acorn = null;
  for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
    try { acorn = require(p); break; } catch (e) { /* next */ }
  }
  if (acorn) acorn.parse(SOURCE, { ecmaVersion: 5 });
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/(^|[^.\w])(let|const)\s|=>|`/.test(code), 'ES2015 syntax');
  assert.ok(!/\bdocument\b|localStorage|Date\.now|new Date\(\)/.test(code), 'no DOM, storage or clock');
});

check('no em dashes or en dashes in the module or this test', () => {
  const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  assert.ok(!dashes.test(SOURCE), 'app/budget-lab-math.js');
  assert.ok(!dashes.test(fs.readFileSync(__filename, 'utf8')), 'dev/budget-lab-math-test.js');
});

/* ---------- example A ---------- */

check('A: R = -9.54 gives $0 a day and short by $10 on Dec 1', () => {
  const r = run({ lab: lab(-9.54) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.R, -9.54);
  assert.strictEqual(r.c0Raw, -0.68);
  assert.strictEqual(r.c0, 0);
  assert.strictEqual(r.cap, 0);
  assert.strictEqual(r.keep, -9.54);
  assert.strictEqual(r.covered, false);
  assert.strictEqual(r.short, 10);
  assert.strictEqual(r.destinations.short, 9.54);
  same(r.destinations.buckets.map((b) => b.funded), [0, 0, 0]);
});

check('A: the move is "move $10 into checking", even at $0 a day', () => {
  same(run({ lab: lab(-9.54) }).move, { kind: 'moveMoney', amount: 10 });
});

check('A: the illustrative inputs sum to R (2,778 + 3,000 - 960 - 4,412.54 - 415 - 0)', () => {
  assert.strictEqual(L.toCents(2778 + 3000 - 960 - 4412.54 - 415 - 0), -9.54);
});

/* ---------- example B ---------- */

check('B: R = 1,334 gives c0 = 95.29 and keeps exactly 0 (covered, nothing to spare)', () => {
  const r = run();
  assert.strictEqual(r.c0, 95.29);
  assert.strictEqual(r.cap, 95.29);
  assert.strictEqual(r.capIsCalculated, true);
  assert.strictEqual(r.keep, 0);
  assert.strictEqual(r.covered, true);
  assert.strictEqual(r.short, 0);
  assert.strictEqual(r.monthly.calculated, 1334);
  assert.strictEqual(r.gap, 0);
  assert.strictEqual(r.capMax, 196, 'max(2 c0, c0 + 100) in whole dollars');
});

check('B: cap $80 keeps $214, savings 214 of 500, monthly $1,120 vs $1,334, gap -$214', () => {
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: {} } });
  assert.strictEqual(r.keep, 214);
  assert.strictEqual(r.planned, 1120);
  same(r.destinations, {
    short: 0,
    card: { planned: 0, funded: 0 },
    buckets: [{ key: 'savings', planned: 500, funded: 214 }, { key: 'awws', planned: 150, funded: 0 }, { key: 'buffer', planned: 350, funded: 0 }],
    extra: 0,
    splitSource: 'default'
  });
  same(r.monthly, { calculated: 1334, saved: null, session: 1120 });
  assert.strictEqual(r.gapBase, 'calculated');
  assert.strictEqual(r.gap, -214);
});

check('B: cutting Amazon $40 and DoorDash $15 gives F 55, ce 76.07, K 269', () => {
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: { Amazon: 40, DoorDash: 15 } } });
  assert.strictEqual(r.cuts, 55);
  assert.strictEqual(r.effectiveCap, 76.07);
  assert.strictEqual(r.planned, 1065);
  assert.strictEqual(r.keep, 269);
  assert.strictEqual(r.destinations.buckets[0].funded, 269);
  assert.strictEqual(r.monthly.session, 1120, 'monthly remaining is the cap times D, cuts aside');
});

check('B: a keep goal of $500 with those cuts solves the cap to 63.50', () => {
  const r = run({ session: { mode: 'keep', cap: null, keep: 500, cuts: { Amazon: 40, DoorDash: 15 } } });
  assert.strictEqual(r.cap, 63.5);
  assert.strictEqual(r.keep, 500);
  assert.strictEqual(r.keepGoal, 500);
  same(r.destinations.buckets.map((b) => b.funded), [500, 0, 0]);
});

check('B: saving at cap $80 stores keep 214; next morning cs = 80.77 against c0 = 97.23', () => {
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: { Amazon: 40 } } });
  const pref = L.makePref(r, '2026-11-17T15:00:00Z');
  same(pref, { v: 1, cardDate: '2026-12-01', keep: 214, at: '2026-11-17T15:00:00Z' }, 'cuts are session only and not saved');
  // He spent $70 on Nov 17.
  const days = underDays(10, '2026-11-16').concat([{ date: '2026-11-17', spent: 70, cap: 95.29 }]);
  const before = run().streak.count;
  const n = L.compute({
    lab: lab(1264, { daysLeft: 13, monthDay: 18 }), merchants: MERCHANTS, pace: pace(days),
    today: '2026-11-18', session: L.newSession(), pref: pref
  });
  assert.strictEqual(n.c0, 97.23);
  assert.strictEqual(n.saved.cap, 80.77);
  assert.strictEqual(n.saved.keep, 214);
  assert.strictEqual(n.gapBase, 'saved');
  assert.strictEqual(n.gap, -214);
  same(n.yesterday, { date: '2026-11-17', spent: 70, cap: 95.29, under: true, by: 25.29 });
  assert.strictEqual(L.wholeDown(n.yesterday.by), 25, '"$70 of $95, $25 under"');
  assert.strictEqual(n.streak.count, before + 1);
});

/* ---------- the edge table ---------- */

check('edge: card day today (D = 0) has no equation; the outcome comes from cardDay', () => {
  const r = run({ lab: lab(-9.54, { daysLeft: 0 }), cardDay: { date: '2026-12-01', daysAway: 0, covered: false, shortBy: 9.54 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cardDayToday');
  same(r.cardDayToday, { covered: false, short: 10 });
  assert.strictEqual(r.cap, undefined, 'no cap, no sliders');
  assert.strictEqual(r.merchants.length, 3, 'merchants still show');
  assert.strictEqual(r.streak.count, 10, 'the streak still shows');
  same(run({ lab: lab(50, { daysLeft: 0 }), cardDay: { covered: true } }).cardDayToday, { covered: true, short: 0 });
});

check('edge: no lab (no payday or checking) still gives merchants, streak and yesterday', () => {
  const r = run({ lab: undefined });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'noLab');
  same(r.merchants.map((m) => [m.label, m.mtd, m.projected]), [['Amazon', 495, null], ['DoorDash', 120, null], ['Corner Bakery Stand', 40, null]]);
  assert.strictEqual(r.streak.count, 10);
  assert.strictEqual(r.yesterday.date, '2026-11-16');
  assert.strictEqual(r.move, null);
});

check('edge: negative room locks the cuts at 0 while the cap is 0', () => {
  const r = run({ lab: lab(-120), session: { mode: 'cap', cap: null, keep: null, cuts: { Amazon: 40 } } });
  assert.strictEqual(r.c0, 0);
  assert.strictEqual(r.locked, true);
  assert.strictEqual(r.cuts, 0);
  assert.strictEqual(r.merchants[0].cut, 0);
  assert.strictEqual(r.short, 120);
  const s = L.nudgeCut(L.newSession(), r, 'Amazon', 1);
  same(s.cuts, {}, 'a key press on a locked cut does nothing');
});

check('edge: negative room, raising the cap deepens the shortfall', () => {
  const r = run({ lab: lab(-9.54), session: { mode: 'cap', cap: 5, keep: null, cuts: {} } });
  assert.strictEqual(r.keep, -79.54);
  assert.strictEqual(r.short, 80);
  assert.strictEqual(r.locked, false);
  same(r.move, { kind: 'moveMoney', amount: 10 }, 'the $0 a day shortfall, not the session one');
});

check('edge: D = 1, every per day figure equals the total', () => {
  const r = run({ lab: lab(83.4, { daysLeft: 1, monthDay: 30, cardDate: '2026-12-01' }), today: '2026-11-30' });
  assert.strictEqual(r.c0, 83.4);
  assert.strictEqual(r.monthly.calculated, 83.4);
  assert.strictEqual(r.planned, r.effectiveCap);
  assert.strictEqual(r.keep, 0);
});

check('edge: on the 1st and 2nd the month to date is the cut limit; from the 3rd it projects', () => {
  const m = { month: '2026-12', combined: 60, items: [{ label: 'Amazon', mtd: 45.5, count: 2 }] };
  [1, 2].forEach((E) => {
    const r = run({ lab: lab(2900, { daysLeft: 31 - E, monthDay: E, cardDate: '2027-01-01' }), merchants: m, today: '2026-12-0' + E });
    assert.strictEqual(r.merchants[0].projected, 45.5, 'E = ' + E);
  });
  const r3 = run({ lab: lab(2900, { daysLeft: 28, monthDay: 3, cardDate: '2027-01-01' }), merchants: m });
  assert.strictEqual(r3.merchants[0].projected, Math.round(45.5 / 3 * 28));
  const big = run({ lab: lab(2900, { daysLeft: 30, monthDay: 1 }), merchants: m, session: { mode: 'cap', cap: null, keep: null, cuts: { Amazon: 45.5 } } });
  assert.strictEqual(big.cuts, 45.5, 'combined 60 does not bind on the 1st');
});

check('edge: a saved cap from the last cycle is dropped, never carried over', () => {
  const pref = { v: 1, cardDate: '2026-11-01', keep: 214, at: '2026-10-20T15:00:00Z' };
  const r = run({ pref: pref });
  assert.strictEqual(r.saved, null);
  assert.strictEqual(r.monthly.saved, null);
  assert.strictEqual(r.gapBase, 'calculated');
  assert.strictEqual(L.readPref(pref, lab(1334)), null);
  assert.ok(L.readPref({ v: 1, cardDate: '2026-12-01', keep: 214 }, lab(1334)));
  [null, 'x', {}, { v: 2, cardDate: '2026-12-01', keep: 1 }, { v: 1, cardDate: '2026-12-01', keep: 'a' }].forEach((p) => {
    assert.strictEqual(L.readPref(p, lab(1334)), null);
  });
  assert.strictEqual(L.readPref({ v: 1, cardDate: '2026-12-01', keep: 1 }, lab(0, { daysLeft: 0 })), null, 'no saved cap on card day');
});

check('edge: a saved cap never goes below $0 a day', () => {
  const r = run({ lab: lab(100), pref: { v: 1, cardDate: '2026-12-01', keep: 214 } });
  assert.strictEqual(r.saved.cap, 0);
});

check('edge: new data, cap mode keeps the cap; cuts above a new p_i clamp down; a gone merchant loses its cut', () => {
  const s = { mode: 'cap', cap: 80, keep: null, cuts: { Amazon: 300, 'Corner Bakery Stand': 20 } };
  const m2 = { month: '2026-11', combined: 640, items: [{ label: 'Amazon', mtd: 340, count: 9 }, { label: 'DoorDash', mtd: 120, count: 4 }] };
  const r = run({ merchants: m2, session: s });
  assert.strictEqual(r.merchants[0].projected, 280);
  assert.strictEqual(r.merchants[0].cut, 280);
  const n = L.normalizeSession(s, r);
  same(n, { mode: 'cap', cap: 80, keep: null, cuts: { Amazon: 280 } });
});

check('edge: new data, keep mode keeps the goal and re-solves the cap', () => {
  const s = { mode: 'keep', cap: null, keep: 214, cuts: {} };
  assert.strictEqual(run({ session: s }).cap, 80);
  const r = run({ lab: lab(1264, { daysLeft: 13, monthDay: 18 }), session: s, today: '2026-11-18' });
  assert.strictEqual(r.cap, 80.77);
  assert.strictEqual(r.keep, 214);
  same(L.normalizeSession(s, r), s);
});

check('edge: a pinned Daily room cap is ignored, and noted', () => {
  const r = run({ room: { cap: 120, roomPerDay: 95.29, daysLeft: 14, throughDate: '2026-11-30' } });
  assert.strictEqual(r.c0, 95.29, 'the lab never uses room.cap');
  same(r.roomCap, { cap: 120 });
  assert.strictEqual(run({ room: { cap: 95.29 } }).roomCap, null);
  same(run({ lab: lab(-9.54), room: { cap: 1 } }).roomCap, { cap: 1 });
});

/* ---------- cuts, destinations ---------- */

check('cuts: each clamps at its own p_i', () => {
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: { DoorDash: 500 } } });
  assert.strictEqual(r.merchants[1].projected, 99);
  assert.strictEqual(r.cuts, 99);
});

check('cuts: together they clamp at combined * D / E, never the sum of the mtd figures', () => {
  // combined 640 over 17 days is 527.06 over 14; the asks sum to 408 + 99 + 33.
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: { Amazon: 408, DoorDash: 99, 'Corner Bakery Stand': 33 } } });
  assert.strictEqual(r.cutsAsked, 540);
  assert.strictEqual(r.cuts, 527.06);
  assert.strictEqual(r.cutsLimited, true);
});

check('cuts: they come out of the cap and cannot make spending negative', () => {
  const r = run({ session: { mode: 'cap', cap: 10, keep: null, cuts: { Amazon: 408 } } });
  assert.strictEqual(r.cuts, 140);
  assert.strictEqual(r.effectiveCap, 0);
  assert.strictEqual(r.planned, 0);
  assert.strictEqual(r.keep, 1334);
});

check('cuts: a key press stops at p_i, at what combined has left, and at c * D', () => {
  // Amazon alone may go to its p_i of 408.
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: {} } });
  assert.strictEqual(r.merchants[0].max, 408);
  assert.strictEqual(L.nudgeCut({ mode: 'cap', cap: 80, cuts: { Amazon: 407 } }, r, 'Amazon', 1, 25).cuts.Amazon, 408);
  // With Amazon and DoorDash at their p_i, the bakery has 527.06 - 507 left: $20, not its 33.
  const s = { mode: 'cap', cap: 80, keep: null, cuts: { Amazon: 408, DoorDash: 99 } };
  const r2 = run({ session: s });
  assert.strictEqual(r2.cutsLimit, 527.06);
  same(r2.merchants.map((m) => [m.projected, m.max]), [[408, 408], [99, 99], [33, 20]]);
  let n = s;
  for (let k = 0; k < 40; k++) n = L.nudgeCut(n, run({ session: n }), 'Corner Bakery Stand', 1);
  assert.strictEqual(n.cuts['Corner Bakery Stand'], 20);
  assert.strictEqual(run({ session: n }).cuts, 527, 'the five together stay under combined');
  // A $10 cap over 14 days: the cuts together stop at $140.
  const r3 = run({ session: { mode: 'cap', cap: 10, keep: null, cuts: { DoorDash: 99 } } });
  assert.strictEqual(r3.merchants[0].max, 41);
  // Locked at $0 a day: every max is 0 and a press does nothing.
  const r4 = run({ session: { mode: 'cap', cap: 0, keep: null, cuts: { Amazon: 40 } } });
  same(r4.merchants.map((m) => m.max), [0, 0, 0]);
  same(L.nudgeCut({ mode: 'cap', cap: 0, cuts: { Amazon: 40 } }, r4, 'Amazon', 1).cuts, { Amazon: 40 }, 'locked: the session cut waits, unchanged');
});

check('destinations: card day first, from the cuts, then savings, AWWS, buffer (example B at a $100 cap)', () => {
  // A $100 cap is short 66 before any cut (1,400 - 1,334).
  const r = run({ session: { mode: 'cap', cap: 100, keep: null, cuts: {} } });
  same(r.destinations.card, { planned: 66, funded: 0 });
  assert.strictEqual(r.destinations.short, 66);
  // Amazon $40 and DoorDash $15 free 55: all of it to card day, still short 11.
  const r2 = run({ session: { mode: 'cap', cap: 100, keep: null, cuts: { Amazon: 40, DoorDash: 15 } } });
  same(r2.destinations.card, { planned: 66, funded: 55 });
  assert.strictEqual(r2.destinations.short, 11);
  same(r2.destinations.buckets.map((b) => b.funded), [0, 0, 0]);
  // Amazon $100: card day covered, 34 on to savings.
  const r3 = run({ session: { mode: 'cap', cap: 100, keep: null, cuts: { Amazon: 100 } } });
  same(r3.destinations.card, { planned: 66, funded: 66 });
  same(r3.destinations.buckets.map((b) => b.funded), [34, 0, 0]);
  // At $40 a day: 774 kept, savings full, AWWS full, buffer 124.
  const r4 = run({ session: { mode: 'cap', cap: 40, keep: null, cuts: {} } });
  same(r4.destinations.buckets.map((b) => b.funded), [500, 150, 124]);
  // Example A: nothing to cut from, the whole 9.54 is still short.
  same(run({ lab: lab(-9.54) }).destinations.card, { planned: 9.54, funded: 0 });
});

check('destinations: past the split is extra; a sent split wins, with fewer keys too', () => {
  const r = run({ session: { mode: 'cap', cap: 0, keep: null, cuts: {} } });
  same(r.destinations.buckets.map((b) => b.funded), [500, 150, 350]);
  assert.strictEqual(r.destinations.extra, 334);
  const sent = run({ lab: lab(1334, { split: [{ key: 'savings', amount: 600 }, { key: 'buffer', amount: 200 }] }), session: { mode: 'cap', cap: 50, keep: null, cuts: {} } });
  assert.strictEqual(sent.destinations.splitSource, 'snapshot');
  same(sent.destinations.buckets, [{ key: 'savings', planned: 600, funded: 600 }, { key: 'buffer', planned: 200, funded: 34 }]);
  assert.strictEqual(sent.destinations.extra, 0);
});

/* ---------- streak and yesterday ---------- */

check('streak: a day with no cap is skipped, a day over breaks it', () => {
  const days = [
    { date: '2026-11-10', spent: 50, cap: 90 },
    { date: '2026-11-11', spent: 140, cap: 90 },
    { date: '2026-11-12', spent: 50, cap: 90 },
    { date: '2026-11-13', spent: 300 },
    { date: '2026-11-14', spent: 90, cap: 90 },
    { date: '2026-11-16', spent: 20, cap: 90 }
  ];
  same(L.streak(pace(days), TODAY), { count: 3, open: false, full: false, logged: 5 });
  assert.strictEqual(L.streak(pace([]), TODAY).count, 0);
  assert.strictEqual(L.streak(undefined, TODAY).logged, 0, 'no log yet: "Starting your streak"');
});

check('streak: today in the list is not counted (the streak ends yesterday)', () => {
  const days = underDays(3).concat([{ date: TODAY, spent: 500, cap: 90 }]);
  assert.strictEqual(L.streak(pace(days), TODAY).count, 3);
});

check('streak: 31 under days runs to the list\'s end ("31+")', () => {
  const s = L.streak(pace(underDays(31)), TODAY);
  same(s, { count: 31, open: true, full: true, logged: 31 });
  assert.strictEqual(L.streak(pace(underDays(5)), TODAY).full, false);
});

check('yesterday: over by, no cap logged, and none in the list', () => {
  same(L.yesterday(pace([{ date: '2026-11-16', spent: 113.29, cap: 95.29 }]), TODAY), { date: '2026-11-16', spent: 113.29, cap: 95.29, under: false, by: 18 });
  same(L.yesterday(pace([{ date: '2026-11-16', spent: 40 }]), TODAY), { date: '2026-11-16', spent: 40, cap: null, under: null, by: null });
  assert.strictEqual(L.yesterday(pace([{ date: '2026-11-14', spent: 40, cap: 90 }]), TODAY), null);
});

/* ---------- the suggested move ---------- */

check('move: short with a merchant that covers it, "Skip $206 at Amazon"', () => {
  same(run({ session: { mode: 'cap', cap: 110, keep: null, cuts: {} } }).move, { kind: 'skipMerchant', amount: 206, merchant: 'Amazon' });
});

check('move: short with no merchant that covers it, "Spend $15 a day less"', () => {
  const r = run({ merchants: undefined, session: { mode: 'cap', cap: 110, keep: null, cuts: {} } });
  same(r.move, { kind: 'spendLess', perDay: 15 });
});

check('move: yesterday over, "Stay under $80 today to start a new streak"', () => {
  const days = underDays(5, '2026-11-15').concat([{ date: '2026-11-16', spent: 120, cap: 95.29 }]);
  same(run({ pace: pace(days), session: { mode: 'cap', cap: 80.6, keep: null, cuts: {} } }).move, { kind: 'newStreak', cap: 80 });
});

check('move: otherwise keep the streak going, with a skip when a merchant is 20% of the cap', () => {
  same(run({ session: { mode: 'cap', cap: 80, keep: null, cuts: {} } }).move, { kind: 'keepStreak', cap: 80, days: 11, skip: 'Amazon' });
  const small = { month: '2026-11', combined: 40, items: [{ label: 'Corner Bakery Stand', mtd: 40, count: 8 }] };
  same(run({ merchants: small }).move, { kind: 'keepStreak', cap: 95, days: 11, skip: null });
});

/* ---------- key presses ---------- */

check('steps: $1 ticks snap off the calculated cap and clamp at both ends', () => {
  const r = run();
  assert.strictEqual(L.nudgeCap(L.newSession(), r, 1).cap, 96);
  assert.strictEqual(L.nudgeCap(L.newSession(), r, -1).cap, 95);
  assert.strictEqual(L.nudgeCap({ mode: 'cap', cap: 0, cuts: {} }, r, -1).cap, 0);
  assert.strictEqual(L.nudgeCap({ mode: 'cap', cap: 195, cuts: {} }, r, 1, 25).cap, 196);
  assert.strictEqual(L.nudgeCut(L.newSession(), r, 'DoorDash', 1, 25).cuts.DoorDash, 25);
  same(L.nudgeCut({ mode: 'cap', cap: null, cuts: { DoorDash: 1 } }, r, 'DoorDash', -1).cuts, {});
});

check('steps: a held key goes $1, $5, $25 on the cap and $5, $25, $100 on the keep goal', () => {
  same([0, 799, 800, 1999, 2000, 9000].map((t) => L.holdStep(t, 'cap')), [1, 1, 5, 5, 25, 25]);
  same([0, 799, 800, 2000].map((t) => L.holdStep(t, 'keep')), [5, 5, 25, 100]);
});

check('mode: toggling never moves a figure; keep goal steps of $5', () => {
  const r = run({ session: { mode: 'cap', cap: 80, keep: null, cuts: {} } });
  const k = L.toggleMode({ mode: 'cap', cap: 80, keep: null, cuts: {} }, r);
  assert.strictEqual(k.mode, 'keep');
  const rk = run({ session: k });
  assert.strictEqual(rk.cap, 80);
  assert.strictEqual(rk.keep, 214);
  const up = L.nudgeKeep(k, rk, 1);
  assert.strictEqual(up.keep, 215);
  assert.strictEqual(run({ session: up }).keep, 215);
  const back = L.toggleMode(up, run({ session: up }));
  assert.strictEqual(back.mode, 'cap');
  assert.strictEqual(run({ session: back }).keep, 215);
  same(L.newSession(), { mode: 'cap', cap: null, keep: null, cuts: {} }, '"Back to calculated"');
});

check('keep goal: clamps to what a cap of 0 to max can keep', () => {
  const r = run({ session: { mode: 'keep', cap: null, keep: 5000, cuts: {} } });
  assert.strictEqual(r.cap, 0);
  assert.strictEqual(r.keep, 1334);
  assert.strictEqual(r.keepMax, 1334);
  assert.strictEqual(r.keepMin, 1334 - 196 * 14);
});

/* ---------- runway and broken data ---------- */

check('runway: two points per step, ending at lab.room', () => {
  const w = L.runwayLine({ start: -1051, end: '2026-12-01', steps: [
    { date: '2026-11-19', delta: 3000, kind: 'pay' }, { date: '2026-11-20', delta: -200, kind: 'bill' },
    { date: '2026-12-01', delta: -415, kind: 'reserve' }
  ] });
  assert.strictEqual(w.points.length, 7);
  assert.strictEqual(w.end, 1334);
  assert.strictEqual(w.end, run().R);
  assert.strictEqual(L.runwayLine(null), null);
});

// Example B's runway (made up): headroom -1,051 this morning, paid on the 19th.
const RUNWAY_B = { start: -1051, end: '2026-12-01', steps: [
  { date: '2026-11-20', delta: -200, kind: 'bill' }, { date: '2026-11-19', delta: 3000, kind: 'pay' },
  { date: '2026-12-01', delta: -415, kind: 'reserve' }
] };

check('runway chart: days from this morning (D before card day) to card day, in date order, ending at R', () => {
  const r = run();
  const c = L.runwayChart(RUNWAY_B, r);
  assert.strictEqual(c.days, 14);
  assert.strictEqual(c.start, '2026-11-17');
  same(c.points.map((p) => [p.day, p.value]), [[0, -1051], [2, -1051], [2, 1949], [3, 1949], [3, 1749], [14, 1749], [14, 1334]]);
  assert.strictEqual(c.end, r.R);
  assert.strictEqual(c.points[c.points.length - 1].value, r.R);
  same(c.paydays, [{ day: 2, date: '2026-11-19', value: 1949 }]);
  // Nov 17 2026 is a Tuesday: one tick a day, card day included.
  assert.strictEqual(c.ticks.length, 15);
  same(c.ticks.slice(0, 3).map((t) => t.dow), [2, 3, 4]);
  assert.strictEqual(c.ticks[14].dow, 2);
});

check('runway chart: the y range holds 0, the line and the owed line at the top of the cap slider', () => {
  const r = run();
  const c = L.runwayChart(RUNWAY_B, r);
  assert.strictEqual(r.capMax, 196);
  assert.strictEqual(c.owedMax, 196 * 14);
  assert.strictEqual(c.lo, -1051);
  assert.strictEqual(c.hi, 2744);
  // The range does not follow the session: a cap or a cut moves only the owed line.
  const moved = L.runwayChart(RUNWAY_B, run({ session: { mode: 'cap', cap: 150, keep: null, cuts: { Amazon: 40 } } }));
  same([moved.lo, moved.hi], [c.lo, c.hi]);
  // The owed line ends at P, which stays inside the range at either end of the slider.
  [0, 196].forEach((cap) => {
    const x = run({ session: { mode: 'cap', cap: cap, keep: null, cuts: {} } });
    assert.ok(x.planned >= c.lo && x.planned <= c.hi, 'P ' + x.planned);
    assert.strictEqual(L.toCents(x.R - x.planned), x.keep);
  });
});

check('runway chart: a flat line still reaches card day; a step out of the window clamps to its edge', () => {
  const r = run();
  const flat = L.runwayChart({ start: 1334, end: '2026-12-01', steps: [] }, r);
  same(flat.points.map((p) => [p.day, p.value]), [[0, 1334], [14, 1334]]);
  const edges = L.runwayChart({ start: 1000, end: '2026-12-01', steps: [
    { date: '2026-11-10', delta: 500, kind: 'pay' }, { date: '2026-12-09', delta: -166, kind: 'bill' }] }, r);
  same(edges.points.map((p) => p.day), [0, 0, 0, 14, 14]);
  assert.strictEqual(edges.end, 1334);
});

check('runway chart: none without an equation, a runway, or for another card day', () => {
  const r = run();
  assert.strictEqual(L.runwayChart(null, r), null);
  assert.strictEqual(L.runwayChart({ start: 'x', steps: [] }, r), null);
  assert.strictEqual(L.runwayChart({ start: 5 }, r), null);
  assert.strictEqual(L.runwayChart(Object.assign({}, RUNWAY_B, { end: '2026-12-02' }), r), null);
  assert.strictEqual(L.runwayChart(RUNWAY_B, run({ lab: lab(1334, { daysLeft: 0 }) })), null);
  assert.strictEqual(L.runwayChart(RUNWAY_B, run({ lab: null })), null);
  assert.strictEqual(L.runwayChart(RUNWAY_B, null), null);
});

check('broken data never throws', () => {
  const junk = [undefined, null, 'x', 3, {}, { room: 'a' }, { room: 5, daysLeft: -1 }];
  junk.forEach((j) => {
    const r = L.compute({ lab: j, merchants: j, pace: j, room: j, cardDay: j, session: j, pref: j, today: j });
    assert.strictEqual(r.ok, false);
  });
  L.compute();
  const r = run({ merchants: { items: [null, { label: 3 }, { label: 'Ok', mtd: 10 }] }, pace: { days: [null, { date: 'soon' }] } });
  same(r.merchants.map((m) => m.label), ['Ok']);
  assert.strictEqual(r.streak.count, 0);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
