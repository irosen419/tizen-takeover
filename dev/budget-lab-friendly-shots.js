/*
 * Before and after pictures of the Budget lab as Ian sees it on the TV:
 *   node dev/budget-lab-friendly-shots.js --out <folder> --prefix <before|after> [--full] [--es] [--scale 2]
 *
 * The same layout, made-up sample (dev/budget-sample.js with the 14 day
 * payday window), clock (Monday 16 November 2026, 10:40 AM in Chicago) and
 * language for every picture; run it from a checkout of each version to
 * change only the widget. Two cases:
 *
 *   <prefix>-covered.png   the calculated cap covers card day
 *   <prefix>-short.png     short even at $0 a day (the room is below zero)
 *
 * It presses OK on the Budget lab tile and takes the picture of what opens:
 * the small centered panel before this change, full screen after it. --full
 * goes on to full screen from the panel (names the files <prefix>-full-...).
 * --es adds the Spanish short case (<prefix>-short-es.png). 1920x1080 at
 * deviceScaleFactor 2 unless --scale says otherwise. Needs Playwright and
 * port 8095 free. Nothing reaches the internet; every figure is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-lab-friendly');
const PREFIX = arg('--prefix') || 'after';
const SCALE = Number(arg('--scale') || 2);
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 0, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 },
  { widget: 'today', x: 4, y: 3, w: 8, h: 3 }
];
const CASES = [
  { name: 'covered', lang: 'en', opts: { payday: true } },
  { name: 'short', lang: 'en', opts: { payday: true, shortZero: true } }
];
if (args.indexOf('--es') >= 0) CASES.push({ name: 'short-es', lang: 'es', opts: { payday: true, shortZero: true } });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({});
  try {
    for (const c of CASES) {
      await env.setBudget(H.budgetSample.snapshot(Object.assign({ sentAt: FRESH }, c.opts)));
      const page = await env.newPage({ layout: LAYOUT, scale: SCALE,
        storage: { 'homeHub.lang': c.lang, 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        await H.sleep(500);
        let file = path.join(OUT, PREFIX + '-' + c.name + '.png');
        await page.screenshot({ path: file });
        console.log(file);
        if (args.indexOf('--full') >= 0) {
          await H.fullScreen(page);
          await H.sleep(500);
          file = path.join(OUT, PREFIX + '-full-' + c.name + '.png');
          await page.screenshot({ path: file });
          console.log(file);
        }
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
