/*
 * Pictures of Budget lab's planned buys at full screen, before and after,
 * with made-up figures shaped like the owner's late November (the same
 * snapshot as dev/budget-lab-explain-shots.js):
 *   node dev/budget-planned-shots.js --out <folder> [--scale 1] [--langs en,es]
 *
 * Shots: before-full-<lang> (no planned buys sent: the lab as it is today),
 * after-full-<lang> (the list), after-form-<lang> (Add a planned buy open),
 * after-guest-<lang> (Guest mode). Labels and amounts are made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-planned-shots');
const SCALE = Number(arg('--scale') || 1);
const LANGS = (arg('--langs') || 'en,es').split(',');
const AT = Date.parse('2026-11-25T01:40:00Z'); // Tue Nov 24, 7:40 PM in Chicago
const FRESH = new Date(AT - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'spending', x: 4, y: 0, w: 8, h: 3 },
  { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 3, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 3, w: 4, h: 3 }
];
const PLANNED = { cardDay: '2026-12-01', items: [
  { id: 'b1000001', label: 'Winter boots', amount: 120, date: '2026-11-30', match: 'zappos', state: 'upcoming' },
  { id: 'b1000002', label: 'Birthday gift', amount: 40, date: '2026-11-22', match: null, state: 'overdue' },
  { id: 'b1000003', label: 'Desk lamp', amount: 35, date: '2026-11-21', match: null, state: 'matched', matchedDate: '2026-11-23', matchedAmount: 34.5, matchedMerchant: 'Lamp Shop' },
  { id: 'b1000004', label: 'Concert tickets', amount: 85, date: '2026-12-05', match: null, state: 'later' },
  { id: 'b1000005', label: 'Haircut', amount: 30, date: null, match: null, state: 'upcoming' }
] };

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
  const shot = async (page, name, lang) => {
    const file = path.join(OUT, name + '-' + lang + '.png');
    await page.screenshot({ path: file });
    console.log(file);
  };
  async function open(lang) {
    const storage = { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '[]' };
    const page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: storage });
    await H.sleep(1200);
    await H.openPanel(page, 'budget-lab');
    if (await page.evaluate(() => window.HUB_TEST.mode()) !== 'full') await H.fullScreen(page);
    await H.sleep(2500);
    return page;
  }
  try {
    for (const lang of LANGS) {
      await env.setBudget(snapshot());
      let page = await open(lang);
      try { await shot(page, 'before-full', lang); } finally { await page.ctx.close(); }
      const s = snapshot();
      s.planned = PLANNED;
      await env.setBudget(s);
      page = await open(lang);
      try {
        await shot(page, 'after-full', lang);
        for (let i = 0; i < 12 && await page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !f || f.getAttribute('data-key') !== 'planned-add'; }); i++) await H.key(page, 'ArrowDown');
        await H.key(page, 'Enter');
        await H.sleep(400);
        await shot(page, 'after-form', lang);
        await H.key(page, 'Escape');
        await H.sleep(300);
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(800);
        await shot(page, 'after-guest', lang);
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
