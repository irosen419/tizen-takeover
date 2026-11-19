/*
 * Pictures of the Card day receipt prototype (tile, panel, level 2):
 *   node dev/budget-receipt-shots.js --out <folder> --scenes <list> [--snapshot <file.json>]
 *        [--kind autopay|covered|short] [--lang en|es] [--prefix <name>] [--scale 2]
 *
 * scenes (comma separated): tile, panel, bills, cards. Each writes
 * <prefix>-<scene>.png (prefix default "after"; a Spanish scene ends -es).
 *   tile    the Budget layout (the same one dev/budget-autopay-shots.js takes)
 *   panel   the Card day panel, OK on the tile
 *   bills   level 2 on "Bills from Dec 1 until the Dec 2 paycheck"
 *   cards   level 2 on "Cards today, pending included"
 *
 * The clock is the harness's (Monday 16 November 2026, 10:40 AM in Chicago),
 * 1920x1080 at deviceScaleFactor 2. The snapshot, receipt and all, goes
 * through the Pi's own validator (pi/budget.js) and reaches the TV the way a
 * live copy does. An older checkout ignores the receipt, which is how the
 * "before" pictures are taken: same snapshot file (--snapshot), same layout,
 * same clock.
 * Needs Playwright and port 8095 free. Every figure is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-receipt-shots');
const SCENES = (arg('--scenes') || 'tile,panel').split(',');
const LANG = arg('--lang') || 'en';
const PREFIX = arg('--prefix') || 'after';
const KIND = arg('--kind') || 'autopay';
const SCALE = Number(arg('--scale') || 2);
const SUFFIX = LANG === 'en' ? '' : '-' + LANG;
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 0, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 },
  { widget: 'today', x: 4, y: 3, w: 8, h: 3 }
];

function snapshot() {
  const file = arg('--snapshot');
  const s = file ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : H.budgetSample.snapshot({ sentAt: FRESH, payday: true, receipt: KIND });
  s.sentAt = FRESH;
  Object.keys(s).forEach((k) => { if (s[k] && typeof s[k] === 'object' && s[k].asOf) s[k].asOf = FRESH; });
  return s;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({});
  try {
    const snap = snapshot();
    await env.setBudget(snap);
    const page = await env.newPage({ layout: LAYOUT, scale: SCALE, storage: { 'homeHub.lang': LANG, 'homeHub.budget.seen.v1': '["a-1042"]' } });
    try {
      await H.sleep(1000);
      for (const scene of SCENES) {
        const file = path.join(OUT, PREFIX + '-' + scene + SUFFIX + '.png');
        if (scene === 'tile') {
          await page.screenshot({ path: file });
        } else {
          if (!await page.evaluate(() => window.HUB_TEST.open())) await H.openPanel(page, 'budget-card');
          if (scene === 'bills' || scene === 'cards') {
            const want = scene === 'bills' ? 'rc-billsAfter' : 'rc-cardsToday';
            for (let n = 0; n < 10; n++) {
              if (await page.evaluate((k) => { const f = document.querySelector('#panel .is-focused'); return !!f && f.getAttribute('data-key') === k; }, want)) break;
              await H.key(page, 'ArrowDown');
            }
            await H.key(page, 'Enter');
            await H.sleep(600);
          }
          await H.idle(page);
          await page.screenshot({ path: file });
          // Back out to the tile for the next scene.
          while (await page.evaluate(() => window.HUB_TEST.open())) { await H.key(page, 'Escape'); await H.sleep(500); }
          await H.idle(page);
        }
        console.log(file);
      }
      const errs = H.errorsOf(page, false);
      if (errs.length) console.log('console problems: ' + errs.join(' | '));
    } finally { await page.ctx.close(); }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
