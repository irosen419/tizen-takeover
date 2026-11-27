/*
 * Pictures of the Daily room tile and its panel, before and after:
 *   node dev/budget-room-shots.js --out <folder> --prefix <before|after> [--scale 2]
 *
 * The made-up sample (dev/budget-sample.js) with Ian's Nov 27 shape: a
 * calculated cap of $561.81, $90 spent today, 4 days left, so the room is
 * $539.31 a day. Since v0.86 the cap rounds down ($561, as Budget lab says)
 * and the room says what today used. English and Spanish:
 * <prefix>-<tile|panel>-<en|es>.png. Needs Playwright and port 8095 free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-room-shots');
const PREFIX = arg('--prefix') || 'after';
const SCALE = Number(arg('--scale') || 2);
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [{ widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 4, y: 0, w: 4, h: 3 }];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({});
  const shot = async (el, name, lang) => {
    const file = path.join(OUT, PREFIX + '-' + name + '-' + lang + '.png');
    await el.screenshot({ path: file });
    console.log(file);
  };
  try {
    const snap = H.budgetSample.snapshot({ sentAt: FRESH });
    Object.assign(snap.room, { cap: 561.81, roomPerDay: 539.31, daysLeft: 4 });
    Object.assign(snap.lab, { spentToday: 90 });
    await env.setBudget(snap);
    for (const lang of ['en', 'es']) {
      const storage = { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '["a-1042"]' };
      const page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: storage });
      try {
        await H.sleep(800);
        await shot(await page.$('.cell[data-widget="budget-room"] .tile'), 'tile', lang);
        await H.openPanel(page, 'budget-room');
        await H.sleep(600);
        await shot(await page.$('#panel'), 'panel', lang);
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
