/*
 * Pictures of Budget lab and Spending with figures shaped like the owner's
 * Nov 24 evening (the 1st short, the autopay plan covering it, a $60 goal
 * from Nov 24, a cap saved at $60), before and after the explainer work:
 *   node dev/budget-lab-explain-shots.js --out <folder> --prefix <before|after> [--scale 1]
 *
 * Shots (<prefix>-<shot>-<en|es>.png): tile (Budget lab 4 x 3), full (Budget
 * lab full screen as it opens), full-2 and full-3 (scrolled down), spending
 * (the Spending tile). Merchant names and their totals are made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-lab-explain-shots');
const PREFIX = arg('--prefix') || 'after';
const SCALE = Number(arg('--scale') || 1);
const LANGS = (arg('--langs') || 'en,es').split(',');
const AT = Date.parse('2026-11-25T01:40:00Z'); // Tue Nov 24, 7:40 PM in Chicago
const FRESH = new Date(AT - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'spending', x: 4, y: 0, w: 8, h: 3 },
  { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 3, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 3, w: 4, h: 3 }
];

function snapshot() {
  const s = H.budgetSample.snapshot({ sentAt: FRESH });
  const asOf = FRESH;
  s.room = { asOf: asOf, cap: 409.09, roomPerDay: 409.09, basis: 'autopay', daysLeft: 6, throughDate: '2026-11-30' };
  s.lab = { asOf: asOf, room: -1558.49, spentToday: 0, daysLeft: 6, cardDate: '2026-12-01', monthDay: 24,
    autopayRoom: 2454.51, autopayDate: '2026-12-07',
    split: [{ key: 'savings', amount: 500 }, { key: 'awws', amount: 150 }, { key: 'buffer', amount: 350 }] };
  s.cardDay = Object.assign({}, s.cardDay, { date: '2026-12-01', daysAway: 7, covered: false, byAutopay: true, shortBy: 1558.49,
    plan: [
      { label: 'Card A', date: '2026-12-01', amount: 2309.23, kind: 'first' },
      { label: 'Card B', date: '2026-12-07', amount: 246.01, kind: 'autopay' },
      { label: 'Card C', date: '2026-12-08', amount: 563.58, kind: 'autopay' },
      { label: 'Card D', date: '2026-12-09', amount: 117.99, kind: 'autopay' }
    ] });
  delete s.cardDay.autopayShortBy;
  s.runway = { asOf: asOf, start: 679.59, end: '2026-12-01', steps: [
    { date: '2026-11-25', delta: -60, kind: 'bill' }, { date: '2026-11-27', delta: -23.79, kind: 'bill' },
    { date: '2026-12-01', delta: -2154.29, kind: 'reserve' }] };
  s.alerts = { asOf: asOf, items: [] };
  s.merchants = { asOf: asOf, month: '2026-11', combined: 1093.4, items: [
    { label: 'Hilltop Grocer', mtd: 402.1, count: 9 }, { label: 'Honda Financial', mtd: 349, count: 1 },
    { label: 'Quick Bites Delivery', mtd: 166.5, count: 8 }, { label: 'Corner Bakery Stand', mtd: 98.6, count: 12 },
    { label: 'Riverside Fuel', mtd: 77.2, count: 2 }] };
  const days = [];
  const spent = [48, 72, 35, 90, 61, 44, 120, 58, 39, 77, 66, 52, 83, 41, 95, 70, 57, 64, 49, 88, 102, 59, 45];
  for (let i = 0; i < spent.length; i++) {
    const d = new Date(Date.UTC(2026, 9, 25 + i));
    days.push({ date: d.toISOString().slice(0, 10), spent: spent[i] });
  }
  days.push({ date: '2026-11-17', spent: 59.93 }, { date: '2026-11-18', spent: 144.58 },
    { date: '2026-11-19', spent: 66.42, cap: 168.43 }, { date: '2026-11-20', spent: 114.69, cap: 110.86 },
    { date: '2026-11-21', spent: 126.17, cap: 198.92 }, { date: '2026-11-22', spent: 31.95, cap: 226.22 },
    { date: '2026-11-23', spent: 29.29, cap: 241.82 });
  s.pace = { asOf: asOf, days: days };
  return s;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({ at: AT, budgetGoals: [{ from: arg('--goal-from') || '2026-11-24', goal: 60 }] });
  const shot = async (page, name, lang, el) => {
    const file = path.join(OUT, PREFIX + '-' + name + '-' + lang + '.png');
    if (el) await el.screenshot({ path: file }); else await page.screenshot({ path: file });
    console.log(file);
  };
  try {
    await env.setBudget(snapshot());
    for (const lang of LANGS) {
      const storage = { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '[]',
        'homeHub.budget.capPref.v1': JSON.stringify({ v: 1, cardDate: '2026-12-01', keep: 2094.51, at: '2026-11-25T01:39:00Z' }) };
      let page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: storage });
      try {
        await H.sleep(1200);
        await shot(page, 'tile', lang, await page.$('.cell[data-widget="budget-lab"] .tile'));
        await shot(page, 'spending', lang, await page.$('.cell[data-widget="spending"] .tile'));
        await H.openPanel(page, 'budget-lab');
        if (await page.evaluate(() => window.HUB_TEST.mode()) !== 'full') await H.fullScreen(page);
        await H.sleep(4200);
        await shot(page, 'full', lang);
        for (const [n, y] of [[2, 640], [3, 1300]]) {
          await page.evaluate((v) => { const b = document.querySelector('#panel .panel-body'); if (b) b.scrollTop = v; }, y);
          await H.sleep(400);
          await shot(page, 'full-' + n, lang);
        }
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
