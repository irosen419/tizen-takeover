/*
 * Pictures of the Goals tile (monthly spending limits), before and after:
 *   node dev/budget-goals-shots.js --out <folder> --prefix <before|after> [--scale 2]
 *
 * The Budget layout (Spending, Budget lab, Card day, Goals) with the made-up
 * sample (dev/budget-sample.js) and four made-up goals in the shape the budget
 * app sends (label, state, text, pct, and since v0.74.0 spent, limit, pace).
 * A checkout that predates spent/limit drops them, so the same script serves
 * both versions. Each in English and Spanish (<prefix>-<shot>-<en|es>.png):
 *
 *   tile    the Goals tile alone (4 x 3)
 *   panel   its panel, as OK opens it
 *   screen  the whole Budget layout
 *
 * Needs Playwright and port 8095 free. Nothing reaches the internet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-goals-shots');
const PREFIX = arg('--prefix') || 'after';
const SCALE = Number(arg('--scale') || 2);
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'spending', x: 4, y: 0, w: 8, h: 3 },
  { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 3, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 3, w: 4, h: 3 }
];
// Made up, in the budget app's own words (budget_export.goal_item).
const GOALS = [
  { label: 'Restaurants', state: 'over', text: '$62 over', pct: 100, spent: 462.4, limit: 400, pace: 801 },
  { label: 'DoorDash', state: 'over', text: '$2 over', pct: 100, spent: 151.2, limit: 150, pace: 290 },
  { label: 'Shopping', state: 'on-pace', text: '$118 of $200', pct: 59, spent: 118, limit: 200, pace: 229 },
  { label: 'Coffee', state: 'under', text: '$18 left', pct: 64, spent: 32, limit: 50, pace: 46 }
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({ budgetGoals: H.budgetSample.GOALS });
  const shot = async (page, name, lang, el) => {
    const file = path.join(OUT, PREFIX + '-' + name + '-' + lang + '.png');
    if (el) await el.screenshot({ path: file }); else await page.screenshot({ path: file });
    console.log(file);
  };
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true, pace: 'month', goals: GOALS }));
    for (const lang of ['en', 'es']) {
      const storage = { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '["a-1042"]' };
      const page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: storage });
      try {
        await H.sleep(800);
        await shot(page, 'screen', lang);
        await shot(page, 'tile', lang, await page.$('.cell[data-widget="budget-goals"] .tile'));
        await H.openPanel(page, 'budget-goals');
        await H.sleep(600);
        await shot(page, 'panel', lang, await page.$('#panel'));
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
