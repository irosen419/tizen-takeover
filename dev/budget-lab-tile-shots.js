/*
 * Pictures of the Budget lab tile alone, for before and after comparisons:
 *   node dev/budget-lab-tile-shots.js --out <folder> --prefix <before|after> [--scale 2]
 *
 * The Budget layout and the made-up sample (dev/budget-sample.js, 14 day
 * payday window), clock Monday 16 November 2026, 10:40 AM in Chicago. Run it
 * from a checkout of each version so only the widget changes. Cases, each in
 * English and Spanish (<prefix>-<case>-<en|es>.png):
 *
 *   fresh     no streak yet (no capped day logged)
 *   over      yesterday went over the cap
 *   streak3   three days under in a row
 *   streak12  twelve days under in a row
 *   short     short even at $0 a day
 *   autopay   short on card day, covered by waiting for autopay days
 *
 * The picture is the tile's own box. Needs Playwright and port 8095 free.
 * Nothing reaches the internet; every figure is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-lab-tile');
const PREFIX = arg('--prefix') || 'after';
const SCALE = Number(arg('--scale') || 2);
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 0, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 },
  { widget: 'today', x: 4, y: 3, w: 8, h: 3 }
];
const CASES = [
  { name: 'fresh', opts: { payday: true, pace: 'fresh' } },
  { name: 'over', opts: { payday: true, pace: 'over' } },
  { name: 'streak3', opts: { payday: true, pace: 3 } },
  { name: 'streak12', opts: { payday: true, pace: 12 } },
  { name: 'short', opts: { payday: true, pace: 'fresh', shortZero: true } },
  { name: 'autopay', opts: { payday: true, pace: 'fresh', autopay: true } }
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({});
  try {
    for (const c of CASES) {
      await env.setBudget(H.budgetSample.snapshot(Object.assign({ sentAt: FRESH }, c.opts)));
      for (const lang of ['en', 'es']) {
        const page = await env.newPage({ layout: LAYOUT, scale: SCALE,
          storage: { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '["a-1042"]' } });
        try {
          await H.sleep(800);
          const tile = await page.$('.cell[data-widget="budget-lab"] .tile');
          const file = path.join(OUT, PREFIX + '-' + c.name + '-' + lang + '.png');
          await tile.screenshot({ path: file });
          console.log(file);
        } finally { await page.ctx.close(); }
      }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
