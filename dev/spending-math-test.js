/*
 * The Spending widget's arithmetic, in Node: node dev/spending-math-test.js
 *
 * Loads app/spending-math.js the two ways it is used (in a vm with a stub
 * window, as the TV does, and through require) and checks the rules in its
 * header: the goal in force on a day (a goal change mid-window never rewrites
 * a past day, days before the first entry are not judged), ties count as
 * under, the 7-day and 30-day averages (a missing date is no data, not $0),
 * the median (odd and even), the under count, kept (negative too), the
 * streak, today left out, the direction, the chart rows, and empty, one day,
 * partial and broken data; stale data (the windows end yesterday when today
 * is given: a gap of one day, several, none, no data, a goal change in the
 * gap); and the Where it goes page (sorting, the usual, weekdays over the
 * goal, empty and partial sections). The figures are made up (this repository is
 * public). Only what ships with Node is used. Prints one line per check, then
 * "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FILE = path.join(__dirname, '..', 'app', 'spending-math.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const M = require(FILE);

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

// Day n after Oct 16, 2026, as a date.
function date(n) { return new Date(Date.UTC(2026, 9, 16 + n)).toISOString().slice(0, 10); }
function days(list, from) { return { days: list.map((s, i) => ({ date: date((from || 0) + i), spent: s })) }; }

// The made-up month of dev/budget-sample.js (Oct 16 to Nov 15), worked by hand below.
const SAMPLE = require('./budget-sample').spendingDays();
const HISTORY = [{ from: '2026-10-16', goal: 75 }, { from: '2026-11-09', goal: 60 }];
const TODAY = '2026-11-16';

check('loads in a browser-like window and through require, the same API', () => {
  const box = { window: {} };
  vm.runInNewContext(SOURCE, box);
  const w = box.window.HUB_SPENDING_MATH;
  assert.ok(w && typeof w.compute === 'function');
  same(Object.keys(w).sort(), Object.keys(M).sort());
});

check('plain ES5: no let, const, arrow functions or template strings', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/(^|[^.\w])(let|const|class)\s|=>|`/.test(code));
});

check('goalFor: the last entry on or before the day; none before the first', () => {
  assert.strictEqual(M.goalFor(HISTORY, '2026-10-15'), null);
  assert.strictEqual(M.goalFor(HISTORY, '2026-10-16'), 75);
  assert.strictEqual(M.goalFor(HISTORY, '2026-11-08'), 75);
  assert.strictEqual(M.goalFor(HISTORY, '2026-11-09'), 60);
  assert.strictEqual(M.goalFor(HISTORY, '2026-12-25'), 60);
  assert.strictEqual(M.goalFor([], '2026-11-09'), null);
  assert.strictEqual(M.goalFor(HISTORY, 'soon'), null);
});

check('goal history: unsorted, bad rows skipped, the same date twice keeps the last one sent', () => {
  const h = M.readHistory([{ from: '2026-11-09', goal: 60 }, null, { from: 'x', goal: 5 }, { from: '2026-11-01', goal: 0 },
    { from: '2026-11-02', goal: -4 }, { from: '2026-11-03', goal: NaN }, { from: '2026-10-16', goal: 75 }, { from: '2026-11-09', goal: 55 },
    { from: '2026-02-30', goal: 10 }]);
  same(h.map((e) => [e.from, e.c]), [['2026-10-16', 7500], ['2026-11-09', 5500]]);
});

check('a goal change mid-window never rewrites past days', () => {
  const pace = days([70, 70, 70, 70, 70, 70]);
  const before = M.judgedDays(M.readDays(pace), [{ from: date(0), goal: 75 }]);
  const after = M.judgedDays(M.readDays(pace), [{ from: date(0), goal: 75 }, { from: date(3), goal: 60 }]);
  same(after.slice(0, 3), before.slice(0, 3), 'the first three days changed');
  same(after.map((d) => d.under), [true, true, true, false, false, false]);
  same(after.map((d) => d.goal), [75, 75, 75, 60, 60, 60]);
});

check('days before the first goal are not judged and not counted', () => {
  const pace = days([90, 90, 90, 40, 40]);
  const h = [{ from: date(3), goal: 50 }];
  same(M.judgedDays(M.readDays(pace), h).map((d) => d.date), [date(3), date(4)]);
  same(M.underCount(M.readDays(pace), h), { under: 2, judged: 2 });
  assert.strictEqual(M.kept(M.readDays(pace), h), 20);
  assert.strictEqual(M.streak(M.readDays(pace), h), 2);
});

check('a tie counts as under (cents exact: 60.10 against a 60.10 goal)', () => {
  const pace = days([60.1, 60.11]);
  const j = M.judgedDays(M.readDays(pace), [{ from: date(0), goal: 60.1 }]);
  same(j.map((d) => d.under), [true, false]);
  assert.strictEqual(j[1].by, -0.01);
});

check('averages: mean of the days present; a missing date is no data, not $0', () => {
  // Seven dates, two missing: the mean is of the five present.
  const pace = { days: [{ date: date(0), spent: 10 }, { date: date(2), spent: 20 }, { date: date(3), spent: 30 }, { date: date(5), spent: 40 }, { date: date(6), spent: 50 }] };
  assert.strictEqual(M.avg7(M.readDays(pace)), 30);
  // A $0 day sent is a real day.
  assert.strictEqual(M.avg7(M.readDays(days([0, 0, 30]))), 10);
  // Cents stay exact: 0.1 + 0.2 + 0.3 over 3.
  assert.strictEqual(M.avg7(M.readDays(days([0.1, 0.2, 0.3]))), 0.2);
});

check('the sample month: $42 a day this week, $59 over 30 days, typical $51, 12 of 14, $306 kept, 5 in a row', () => {
  const r = M.compute({ pace: { days: SAMPLE }, history: HISTORY, today: TODAY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.end, '2026-11-15');
  assert.strictEqual(Math.round(r.avg7), 42);
  assert.strictEqual(Math.round(r.avg30), 59);
  assert.strictEqual(r.dir, 'down');
  assert.strictEqual(Math.round(r.typical), 51);
  same(r.under, { under: 12, judged: 14 });
  assert.strictEqual(r.kept, 306);
  assert.strictEqual(r.streak, 5);
  assert.strictEqual(r.goal, 60);
  assert.strictEqual(r.chart.length, 31);
  assert.strictEqual(r.change, 24, 'Nov 9 is chart day 24');
  assert.strictEqual(r.chart[24].date, '2026-11-09');
  same(r.history, [{ from: '2026-11-09', goal: 60 }, { from: '2026-10-16', goal: 75 }]);
});

check('the chart rows: spend, goal, the part over it, and the 7-day line from day 7', () => {
  const r = M.compute({ pace: { days: SAMPLE }, history: HISTORY, today: TODAY });
  const nov10 = r.chart[25];
  same([nov10.date, nov10.spent, nov10.goal, nov10.over], ['2026-11-10', 73, 60, 13]);
  const zero = r.chart.filter((d) => d.spent === 0)[0];
  assert.ok(zero && zero.over === 0, 'a $0 day is under');
  for (let i = 0; i < 6; i++) assert.strictEqual(r.chart[i].avg7, null, 'line on day ' + i);
  assert.ok(r.chart[6].avg7 > 0);
  assert.strictEqual(Math.round(r.chart[30].avg7), 42);
  assert.ok(r.max >= Math.max.apply(null, SAMPLE.map((d) => d.spent)));
});

check('today is partial and left out; so is anything later', () => {
  const pace = days([10, 20, 30, 500, 900]);
  const r = M.compute({ pace: pace, history: [], today: date(3) });
  assert.strictEqual(r.days, 3);
  assert.strictEqual(r.end, date(2));
  assert.strictEqual(r.avg7, 20);
  // With no today, every row is used.
  assert.strictEqual(M.compute({ pace: pace }).days, 5);
});

check('the streak: ends at an over day, a missing date or a day with no goal', () => {
  const h = [{ from: date(0), goal: 50 }];
  assert.strictEqual(M.streak(M.readDays(days([40, 60, 40, 40, 50])), h), 3);
  const gap = { days: [{ date: date(0), spent: 10 }, { date: date(1), spent: 10 }, { date: date(3), spent: 10 }] };
  assert.strictEqual(M.streak(M.readDays(gap), h), 1);
  assert.strictEqual(M.streak(M.readDays(days([40, 40])), [{ from: date(1), goal: 50 }]), 1);
  assert.strictEqual(M.streak(M.readDays(days([40, 99])), h), 0);
  assert.strictEqual(M.streak([], h), 0);
});

check('kept can be negative; the window is the last 14 calendar days', () => {
  const h = [{ from: date(0), goal: 50 }];
  assert.strictEqual(M.kept(M.readDays(days([80, 80, 40])), h), -50);
  // 20 days: only the last 14 count.
  const list = []; for (let i = 0; i < 20; i++) list.push(i < 6 ? 0 : 45);
  assert.strictEqual(M.kept(M.readDays(days(list)), h), 70);
  same(M.underCount(M.readDays(days(list)), h), { under: 14, judged: 14 });
  assert.strictEqual(M.kept(M.readDays(days([10])), []), null);
});

check('median: odd and even counts, cents exact, empty', () => {
  assert.strictEqual(M.median([300, 100, 200]), 2);
  assert.strictEqual(M.median([100, 200, 301, 401]), 2.51);
  assert.strictEqual(M.median([5]), 0.05);
  assert.strictEqual(M.median([]), null);
  assert.strictEqual(M.median([NaN, 100]), 1);
  // typical: the middle of the last 30, a $300 day ignored
  assert.strictEqual(M.typical(M.readDays(days([40, 41, 300, 42, 43]))), 42);
});

check('direction: down, up, level in whole dollars; none until 14 days in the 30-day window', () => {
  assert.strictEqual(M.direction(42.4, 59), 'down');
  assert.strictEqual(M.direction(59.4, 59.1), 'level');
  assert.strictEqual(M.direction(70, 59), 'up');
  assert.strictEqual(M.direction(null, 59), null);
  const short = M.compute({ pace: days([10, 10, 10, 10, 10, 10, 10, 10, 90, 90]), history: [] });
  assert.strictEqual(short.dir, null);
});

check('the 7-day series: null until a whole window, then the mean of the days present', () => {
  same(M.avg7Series(M.readDays(days([7, 7, 7, 7, 7, 7, 14, 21])), date(0), date(7)), [null, null, null, null, null, null, 8, 10]);
  same(M.avg7Series([], date(0), date(3)), []);
});

check('empty, one day and two days: no figures to judge, "building" until 3 days', () => {
  const none = M.compute({ pace: { days: [] }, history: HISTORY, today: TODAY });
  same([none.ok, none.building, none.days, none.avg7, none.end, none.chart.length], [false, false, 0, null, null, 0]);
  same(none.history.length, 2);
  const one = M.compute({ pace: days([12.34]), history: [], today: date(1) });
  same([one.ok, one.building, one.days, one.avg7, one.typical, one.kept, one.hasGoal], [false, true, 1, 12.34, 12.34, null, false]);
  const two = M.compute({ pace: days([1, 2]), history: [] });
  assert.strictEqual(two.building, true);
  assert.strictEqual(M.compute({ pace: days([1, 2, 3]), history: [] }).ok, true);
});

check('no goal at all: averages and the typical day, nothing judged', () => {
  const r = M.compute({ pace: { days: SAMPLE }, history: [], today: TODAY });
  same([r.ok, r.hasGoal, r.goal, r.kept, r.streak, r.change], [true, false, null, null, 0, -1]);
  same(r.under, { under: 0, judged: 0 });
  assert.strictEqual(Math.round(r.avg7), 42);
  assert.ok(r.chart.every((d) => d.goal === null && d.over === null));
});

check('a goal that starts mid-chart steps in on its day (change index), grey before it', () => {
  const r = M.compute({ pace: { days: SAMPLE }, history: [{ from: '2026-11-01', goal: 60 }], today: TODAY });
  assert.strictEqual(r.chart[r.change].date, '2026-11-01');
  assert.strictEqual(r.chart[r.change - 1].goal, null);
  assert.strictEqual(r.chart[r.change - 1].over, null);
});

check('all zero days: averages $0, every judged day under, the chart has a top', () => {
  const r = M.compute({ pace: days([0, 0, 0, 0]), history: [{ from: date(0), goal: 40 }] });
  same([r.avg7, r.typical, r.kept, r.streak], [0, 0, 160, 4]);
  same(r.under, { under: 4, judged: 4 });
  assert.ok(r.max > 0);
  const nogoal = M.compute({ pace: days([0, 0, 0]), history: [] });
  assert.ok(nogoal.max > 0);
});

check('broken data never throws: bad rows skipped, a date twice keeps the first', () => {
  const junk = [undefined, null, 'x', 3, {}, { days: 'no' }, { days: [null, 4, 'x'] }];
  junk.forEach((j) => {
    const r = M.compute({ pace: j, history: j, today: j });
    assert.strictEqual(r.ok, false);
  });
  M.compute();
  const r = M.compute({ pace: { days: [{ date: date(0), spent: -5 }, { date: date(0), spent: NaN }, { date: date(1), spent: '7' },
    { date: 'soon', spent: 4 }, { date: date(2), spent: 10 }, { date: date(2), spent: 99 }, { date: date(3), spent: Infinity }, { date: date(4), spent: 20 }] } });
  same([r.days, r.avg7], [2, 15]);
});

check('partial data: unsorted rows are put in order; a gap leaves its chart day empty', () => {
  const pace = { days: [{ date: date(4), spent: 40 }, { date: date(0), spent: 20 }, { date: date(1), spent: 30 }] };
  const r = M.compute({ pace: pace, history: [] });
  same(r.chart.map((d) => d.spent), [20, 30, null, null, 40]);
  assert.strictEqual(r.end, date(4));
});

check('cents: 1.005 rounds to 101 cents; readDays(p) with no today drops no valid day', () => {
  assert.strictEqual(M.readDays({ days: [{ date: '', spent: 1 }, { date: '2026-02-30', spent: 1 }, { date: date(0), spent: 1.005 }] })[0].c, 101);
});

/* ---------- stale data: windows end yesterday when today is given ---------- */

// The sample month with its last n days taken away (the Pi was off), read on Nov 16.
function cut(n) { return { days: SAMPLE.slice(0, SAMPLE.length - n) }; }

check('no gap: data through yesterday, gap null, the same figures as before', () => {
  const r = M.compute({ pace: { days: SAMPLE }, history: HISTORY, today: TODAY });
  same([r.gap, r.end, r.streak], [null, '2026-11-15', 5]);
});

check('a gap of 1 day: the streak is 0 (never carried over), yesterday is an empty chart day, the averages use the days present', () => {
  const r = M.compute({ pace: cut(1), history: HISTORY, today: TODAY });
  same(r.gap, { since: '2026-11-14', days: 1 });
  assert.strictEqual(r.end, '2026-11-15');
  assert.strictEqual(r.streak, 0, 'a stale streak');
  // Without today the old rule still runs from the last day of data.
  assert.strictEqual(M.compute({ pace: cut(1), history: HISTORY }).streak, 4);
  assert.strictEqual(r.chart.length, 31);
  same(r.chart[30], { date: '2026-11-15', spent: null, goal: 60, ref: null, cap: null, over: null, avg7: r.chart[30].avg7 });
  // The 7-day window Nov 9 to 15 holds 6 days: their mean.
  const six = SAMPLE.slice(-7, -1).reduce((t, d) => t + d.spent * 100, 0);
  assert.strictEqual(r.avg7, Math.round(six / 6) / 100);
  // The missing day is unjudged: 13 judged, not 14, and never counted over or under.
  same(r.under, { under: 11, judged: 13 });
});

check('a gap of several days: the 14-day count and kept shrink, nothing stale is judged', () => {
  const r = M.compute({ pace: cut(5), history: HISTORY, today: TODAY });
  same(r.gap, { since: '2026-11-10', days: 5 });
  assert.strictEqual(r.streak, 0);
  assert.strictEqual(r.under.judged, 9);
  assert.strictEqual(r.chart.slice(-5).filter((d) => d.spent !== null).length, 0);
  assert.strictEqual(r.chart[25].date, '2026-11-10');
  assert.strictEqual(r.chart[25].spent, 73);
  // A gap longer than the 7-day window: no 7-day average at all, the 30-day one still.
  const long = M.compute({ pace: cut(9), history: HISTORY, today: TODAY });
  same([long.gap.days, long.avg7, long.avg30 > 0, long.dir], [9, null, true, null]);
  // Past the whole chart: every chart day empty, averages and typical null.
  const old = M.compute({ pace: { days: SAMPLE.slice(0, 5) }, history: HISTORY, today: '2026-12-31' });
  same([old.ok, old.gap.since, old.avg7, old.avg30, old.typical, old.streak, old.kept], [true, '2026-10-20', null, null, null, 0, null]);
  assert.ok(old.chart.length === 31 && old.chart.every((d) => d.spent === null));
  same(old.under, { under: 0, judged: 0 });
});

check('no data at all: no gap to report', () => {
  const r = M.compute({ pace: { days: [] }, history: HISTORY, today: TODAY });
  same([r.gap, r.end, r.streak, r.ok], [null, null, 0, false]);
});

check('a goal change during the gap: drawn on its day, no missing day judged against either goal', () => {
  const h = HISTORY.concat([{ from: '2026-11-14', goal: 50 }]);
  const r = M.compute({ pace: cut(3), history: h, today: TODAY });
  same(r.gap, { since: '2026-11-12', days: 3 });
  assert.strictEqual(r.goal, 50, 'the goal in force yesterday');
  assert.strictEqual(r.chart[r.change].date, '2026-11-14');
  same(r.chart.slice(-3).map((d) => [d.goal, d.over]), [[60, null], [50, null], [50, null]]);
  const before = M.compute({ pace: cut(3), history: HISTORY, today: TODAY });
  same(r.under, before.under);
  assert.strictEqual(r.kept, before.kept);
});

/* ---------- the Where it goes page ---------- */

// Shares come back to 4 places.
const F = (x) => Math.round(x * 10000) / 10000;

const TRENDS = {
  month: '2026-11',
  categories: [{ label: 'Getting around', mtd: 96, usual: 84 }, { label: 'Food', mtd: 412, usual: 520 }, { label: 'Everything else', mtd: 251, usual: 330 }],
  merchants: [{ label: 'Hilltop Grocer', mtd: 184, usual: 205 }, { label: 'Corner Bakery Stand', mtd: 88, usual: 61 }, { label: 'Riverside Fuel', mtd: 55 }],
  weekdays: [38, 35, 44, 41, 71, 96, 83]
};

check('where: categories and merchants sorted biggest first, the usual compared in whole dollars', () => {
  const w = M.where(TRENDS, 60);
  same([w.has, w.empty, w.month], [true, false, '2026-11']);
  same(w.categories.rows.map((r) => [r.label, r.mtd, r.usual, r.diff, r.vs]),
    [['Food', 412, 520, -108, 'less'], ['Everything else', 251, 330, -79, 'less'], ['Getting around', 96, 84, 12, 'more']]);
  // The scale is the biggest figure (Food's usual, $520) plus 8%.
  assert.strictEqual(w.categories.rows[0].tick, F(520 / (520 * 1.08)));
  assert.strictEqual(w.categories.rows[0].bar, F(412 / (520 * 1.08)));
  same(w.merchants.rows.map((r) => [r.label, r.vs, r.tick === null]), [['Hilltop Grocer', 'less', false], ['Corner Bakery Stand', 'more', false], ['Riverside Fuel', null, true]]);
  assert.strictEqual(w.merchants.ticks, 2);
  assert.strictEqual(M.where({ categories: [{ label: 'A', mtd: 10.4, usual: 9.6 }] }).categories.rows[0].vs, 'same');
  // A tie in mtd keeps the order sent.
  same(M.where({ categories: [{ label: 'B', mtd: 5 }, { label: 'A', mtd: 5 }] }).categories.rows.map((r) => r.label), ['B', 'A']);
});

check('where: weekdays Monday first, over the goal flagged (a tie is under), the goal inside the scale', () => {
  const w = M.where(TRENDS, 60).weekdays;
  same(w.days.map((d) => d.over), [false, false, false, false, true, true, true]);
  same([w.count, w.over, w.goal, w.zero], [7, 3, 60, false]);
  same(w.days[5].by, 36);
  assert.strictEqual(w.days[5].bar, F(1 / 1.08));
  assert.strictEqual(w.days[5].under, F(60 / (96 * 1.08)));
  assert.strictEqual(M.where({ weekdays: [60, 0, 0, 0, 0, 0, 0] }, 60).weekdays.days[0].over, false);
  // A goal above every day still fits.
  assert.strictEqual(M.where({ weekdays: [10, 10, 10, 10, 10, 10, 10] }, 100).weekdays.goalAt, F(1 / 1.08));
  // No goal: no over flags, no goal line.
  const ng = M.where(TRENDS, null).weekdays;
  same([ng.goal, ng.goalAt, ng.over, ng.days.every((d) => d.over === null)], [null, null, 0, true]);
});

check('where: empty and partial: no section, fewer than 7 weekdays, nulls, no usual, all zero, junk', () => {
  const none = M.where(undefined, 60);
  same([none.has, none.empty, none.categories.rows.length, none.weekdays.count], [false, true, 0, 0]);
  const emptyObj = M.where({}, 60);
  same([emptyObj.has, emptyObj.empty], [true, true]);
  const few = M.where({ weekdays: [40, null, 70] }, 60).weekdays;
  same([few.count, few.days.length, few.days[1].avg, few.days[1].over, few.days[6].bar], [2, 7, null, null, null]);
  const noUsual = M.where({ categories: [{ label: 'Food', mtd: 50 }] });
  same([noUsual.categories.ticks, noUsual.categories.rows[0].vs, noUsual.categories.rows[0].bar], [0, null, F(1 / 1.08)]);
  const zero = M.where({ categories: [{ label: 'Food', mtd: 0, usual: 0 }], weekdays: [0, 0, 0, 0, 0, 0, 0] }, null);
  same([zero.categories.zero, zero.categories.rows[0].bar, zero.categories.rows[0].vs, zero.weekdays.zero, zero.weekdays.days[0].bar], [true, 0, 'same', true, 0]);
  const junk = M.where({ categories: [null, 'x', { label: '', mtd: 1 }, { label: 'A', mtd: -1 }, { label: 'B', mtd: NaN }, { label: 'C', mtd: 3, usual: -2 }],
    merchants: 'no', weekdays: ['x', -1, Infinity] }, 'sixty');
  same([junk.categories.rows.length, junk.categories.rows[0].usual, junk.merchants.rows.length, junk.weekdays.count], [1, null, 0, 0]);
  const many = []; for (let i = 0; i < 12; i++) many.push({ label: 'M' + i, mtd: i });
  assert.strictEqual(M.where({ merchants: many }).merchants.rows.length, 8);
  [null, 5, 'x', []].forEach((j) => assert.strictEqual(M.where(j).has, false));
});

check('a goal set today: no chart day judged, goalNow has it, every chart day carries it as ref (never judged)', () => {
  const r = M.compute({ pace: SAMPLE, history: [{ from: '2026-11-16', goal: 60 }], today: '2026-11-16' });
  same([r.hasGoal, r.goal, r.goalNow, r.under.judged, r.history.length], [false, null, 60, 0, 1]);
  assert.ok(r.chart.every((c) => c.goal === null && c.ref === 60 && c.over === null));
  assert.ok(r.max >= 60);
  // Once a day is judged the ref stops on the first goal's day.
  const later = M.compute({ pace: SAMPLE, history: [{ from: '2026-11-14', goal: 60 }], today: '2026-11-16' });
  same([later.chart[28].ref, later.chart[28].goal, later.chart[29].ref, later.chart[29].goal, later.goalNow], [60, null, null, 60, 60]);
  // No days at all: goalNow still says it.
  assert.strictEqual(M.compute({ pace: { days: [] }, history: [{ from: '2026-11-16', goal: 60 }], today: '2026-11-17' }).goalNow, 60);
});

check('the Safe-today cap logged each morning: per chart day, capLast the newest, junk skipped, in the scale', () => {
  const days = SAMPLE.map((d, i) => i >= SAMPLE.length - 3 ? Object.assign({ cap: i === SAMPLE.length - 1 ? 180.5 : 74.25 }, d) : d);
  days[days.length - 4] = Object.assign({ cap: -3 }, days[days.length - 4]);
  const r = M.compute({ pace: { days: days }, history: HISTORY, today: '2026-11-16' });
  same([r.hasCap, r.capLast, r.chart[27].cap, r.chart[28].cap, r.chart[30].cap], [true, 180.5, null, 74.25, 180.5]);
  assert.ok(r.max >= 180.5);
  const none = M.compute({ pace: { days: SAMPLE }, history: HISTORY, today: '2026-11-16' });
  same([none.hasCap, none.capLast], [false, null]);
});

check('no long dashes in the file or this test (house style)', () => {
  const dashes = new RegExp(String.fromCharCode(0x2014));
  assert.ok(!dashes.test(SOURCE), 'app/spending-math.js');
  assert.ok(!dashes.test(fs.readFileSync(__filename, 'utf8')), 'dev/spending-math-test.js');
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
