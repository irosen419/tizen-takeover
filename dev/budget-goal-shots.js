/*
 * Pictures of Budget lab's daily goal and spending graph, before and after:
 *   node dev/budget-goal-shots.js --out <folder> --prefix <before|after> [--scale 2]
 *
 * The Budget layout and the made-up sample (dev/budget-sample.js, the 14 day
 * payday window, pace 'month': 31 days of spending) with the Pi's goal
 * history (budget-sample GOALS: $60 from Oct 26), clock Monday 16 November
 * 2026, 10:40 AM in Chicago. Run it from a checkout of each version so only
 * the widget changes. Each in English and Spanish (<prefix>-<shot>-<en|es>.png):
 *
 *   tile        the Budget lab tile alone (4 x 3)
 *   strip       the tile as a 6 x 1 strip
 *   full        the full screen as it opens
 *   full-goal   the full screen scrolled down to the goal (the same scroll before and after)
 *   guest       full-goal with Guest mode on (English only)
 *
 * Needs Playwright and port 8095 free. Nothing reaches the internet; every
 * figure is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-goal-shots');
const PREFIX = arg('--prefix') || 'after';
const SCALE = Number(arg('--scale') || 2);
const SCROLL = 720;
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 0, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 },
  { widget: 'today', x: 4, y: 3, w: 8, h: 3 }
];
const STRIP = [
  { widget: 'budget-lab', x: 0, y: 0, w: 6, h: 1 }, { widget: 'budget-room', x: 6, y: 0, w: 6, h: 1 },
  { widget: 'budget-card', x: 0, y: 1, w: 6, h: 5 }, { widget: 'today', x: 6, y: 1, w: 6, h: 5 }
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
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true, pace: 'month' }));
    for (const lang of ['en', 'es']) {
      const storage = { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '["a-1042"]' };
      let page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: storage });
      try {
        await H.sleep(800);
        await shot(page, 'tile', lang, await page.$('.cell[data-widget="budget-lab"] .tile'));
      } finally { await page.ctx.close(); }
      page = await env.newPage({ layout: STRIP, scale: SCALE, storage: storage });
      try {
        await H.sleep(800);
        await shot(page, 'strip', lang, await page.$('.cell[data-widget="budget-lab"] .tile'));
      } finally { await page.ctx.close(); }
      const guests = lang === 'en' ? [false, true] : [false];
      for (const guest of guests) {
        const st = Object.assign({}, storage);
        if (guest) st['homeHub.guest.v1'] = 'on';
        page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: st });
        try {
          await H.openPanel(page, 'budget-lab');
          await H.fullScreen(page);
          // Past the "Cap saved" toast the harness's OK leaves.
          await H.sleep(4200);
          if (!guest) await shot(page, 'full', lang);
          await page.evaluate((y) => { const b = document.querySelector('#panel .panel-body'); if (b) b.scrollTop = y; }, SCROLL);
          await H.sleep(400);
          await shot(page, guest ? 'guest' : 'full-goal', lang);
        } finally { await page.ctx.close(); }
      }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
