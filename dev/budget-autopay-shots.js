/*
 * Pictures of the Card day tile and Budget lab's full screen for one snapshot:
 *   node dev/budget-autopay-shots.js --out <folder> --name <before|after> [--lang en|es]
 *        [--snapshot <file.json>] [--autopay] [--scale 2]
 *
 * Runs the real hub against the preview and the real hub server from pi/
 * (dev/awws-harness.js: the clock at Monday 16 November 2026, 10:40 AM in
 * Chicago), 1920x1080 at deviceScaleFactor 2 unless --scale says otherwise.
 * The snapshot is the made-up sample (dev/budget-sample.js) with the payday
 * window, short on card day by $954.20; with --autopay it also carries the
 * autopay days fields (byAutopay, the payment plan, room.basis, autopayRoom).
 * --snapshot reads the snapshot from a JSON file instead, which is how a
 * "before" picture is taken from another checkout. sentAt and every asOf are
 * set to the clock's minute, so the pictures never say "as of".
 * Needs Playwright and port 8095 free.
 *
 *   <name>-<lang>-card.png   the Budget layout: Daily room, Card day, Goals, Budget lab and Today
 *   <name>-<lang>-lab.png    Budget lab at full screen, the cap as calculated
 *
 * Nothing reaches the internet; every figure is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-autopay-shots');
const NAME = arg('--name') || 'after';
const LANG = arg('--lang') || 'en';
const SCALE = Number(arg('--scale') || 2);
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 0, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 },
  { widget: 'today', x: 4, y: 3, w: 8, h: 3 }
];

function snapshot() {
  const file = arg('--snapshot');
  const s = file ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : H.budgetSample.snapshot({ sentAt: FRESH, payday: true, shortFirst: true, autopay: args.indexOf('--autopay') >= 0 });
  s.sentAt = FRESH;
  Object.keys(s).forEach((k) => { if (s[k] && typeof s[k] === 'object' && s[k].asOf) s[k].asOf = FRESH; });
  return s;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({});
  try {
    await env.setBudget(snapshot());
    const page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: { 'homeHub.lang': LANG, 'homeHub.budget.seen.v1': '["a-1042"]' } });
    try {
      await H.sleep(500);
      const card = path.join(OUT, NAME + '-' + LANG + '-card.png');
      await page.screenshot({ path: card });
      console.log(card);
      await H.openPanel(page, 'budget-lab');
      // Up to the hub's Full screen button, checking where focus is before OK (OK on the cap would save it).
      for (let n = 0; n < 12; n++) {
        const on = await page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !!f && !document.querySelector('#panel .panel-body').contains(f); });
        if (on) break;
        await H.key(page, 'ArrowUp');
      }
      await H.key(page, 'Enter');
      await H.until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'full screen did not open');
      await H.idle(page);
      // OK on the way in can land on the cap and save it (the toast, "Saved $15 a day"): undo that, so the picture shows the unsaved screen.
      await page.evaluate(() => { try { localStorage.removeItem('homeHub.budget.capPref.v1'); } catch (e) { /* none */ } });
      await H.sleep(3500);
      await page.evaluate((l) => window.HUB_I18N.setLang(l === 'en' ? 'es' : 'en'), LANG);
      await page.evaluate((l) => window.HUB_I18N.setLang(l), LANG);
      await H.sleep(600);
      const lab = path.join(OUT, NAME + '-' + LANG + '-lab.png');
      await page.screenshot({ path: lab });
      console.log(lab);
    } finally { await page.ctx.close(); }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
