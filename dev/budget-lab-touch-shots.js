/*
 * Pictures of Budget lab's cap on the wall tablet (tablet mode), before and
 * after the drag change, with the made-up late-November figures of
 * dev/budget-planned-shots.js:
 *   node dev/budget-lab-touch-shots.js --out <folder> [--scale 1] [--langs en,es]
 *
 * Shots: cap-<lang> (the cap's box), full-<lang> (the whole full screen),
 * and, where the drag exists, cap-60-<lang> (dragged onto the saved $60).
 * Run it in a checkout of main for the before pictures.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-lab-touch-shots');
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
  const env = await H.start({ at: AT, budgetGoals: [{ from: '2026-11-24', goal: 60 }] });
  async function capShot(page, name) {
    const r = await page.evaluate(() => { const b = document.querySelector('#panel .bl-hero').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
    const pad = 16;
    const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + 2 * pad, height: r.height + 2 * pad };
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file, clip: clip });
    console.log(file);
  }
  try {
    await env.setBudget(snapshot());
    for (const lang of LANGS) {
      const page = await env.newPage({ layout: LAYOUT, scale: SCALE, touch: true, query: 'as=tablet', storage: { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '[]' } });
      try {
        await H.sleep(1200);
        await H.openPanel(page, 'budget-lab');
        if (await page.evaluate(() => window.HUB_TEST.mode()) !== 'full') await H.fullScreen(page);
        await H.sleep(2500);
        await capShot(page, 'cap-' + lang);
        const file = path.join(OUT, 'full-' + lang + '.png');
        await page.screenshot({ path: file });
        console.log(file);
        if (await page.evaluate(() => !!document.querySelector('#panel .bl-knob'))) {
          const cdp = await page.ctx.newCDPSession(page);
          const t = await page.evaluate(() => { const r = window.HUB_BUDGET_LAB_TEST.result(); const b = document.querySelector('#panel .bl-track').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width, max: r.capMax, cap: r.cap }; });
          const from = t.x + t.w * t.cap / t.max;
          const to = t.x + t.w * 61 / t.max;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y: t.y }] });
          for (let i = 1; i <= 12; i++) {
            await H.sleep(16);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 12, y: t.y }] });
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await H.sleep(600);
          await capShot(page, 'cap-60-' + lang);
        }
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
