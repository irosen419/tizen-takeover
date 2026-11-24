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
 * partial and broken data. The figures are made up (this repository is
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
  const one = M.compute({ pace: days([12.34]), history: [], today: TODAY });
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

check('no long dashes in the file or this test (house style)', () => {
  const dashes = new RegExp(String.fromCharCode(0x2014));
  assert.ok(!dashes.test(SOURCE), 'app/spending-math.js');
  assert.ok(!dashes.test(fs.readFileSync(__filename, 'utf8')), 'dev/spending-math-test.js');
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
