/*
 * Pictures of Budget lab's full screen with the runway chart:
 *   node dev/budget-lab-shots.js --out <folder> [--scale 2]
 *
 * Runs the real hub against the preview and the real hub server from pi/
 * (dev/awws-harness.js: the clock at Monday 16 November 2026, 10:40 AM in
 * Chicago) with the made-up budget sample's 14 day window and its payday
 * (dev/budget-sample.js, payday), 1920x1080 at deviceScaleFactor 2 unless
 * --scale says otherwise. Needs Playwright and port 8095 free.
 *
 *   h5-full-<en|es>-covered.png   the cap moved down to $131 a day (16 presses from $146.13): covered,
 *                                 with a figure to spare
 *   h5-full-<en|es>-short.png     the cap moved up to $170 a day: short
 *
 * Nothing reaches the internet; every figure is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'budget-lab-shots');
const SCALE = Number(arg('--scale') || 2);
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [
  { widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 0, w: 4, h: 3 },
  { widget: 'budget-goals', x: 8, y: 0, w: 4, h: 3 }, { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 },
  { widget: 'today', x: 4, y: 3, w: 8, h: 3 }
];
// The sample's calculated cap is $146 a day; these land either side of it.
const STATES = [{ name: 'covered', key: 'ArrowLeft', presses: 16 }, { name: 'short', key: 'ArrowRight', presses: 24 }];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true }));
    for (const lang of ['en', 'es']) {
      for (const st of STATES) {
        const page = await env.newPage({ layout: LAYOUT, scale: SCALE,
          storage: { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '["a-1042"]' } });
        try {
          await H.openPanel(page, 'budget-lab');
          await H.fullScreen(page);
          // From the full screen button: Down into the left column's rows, then Up to the cap.
          const fk = () => page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') : null; });
          for (let i = 0; i < 4 && !/^(cap|mode|save|reset|cut-\d+)$/.test(await fk() || ''); i++) await H.key(page, 'ArrowDown');
          for (let i = 0; i < 16 && (await fk()) !== 'cap'; i++) await H.key(page, 'ArrowUp');
          for (let i = 0; i < st.presses; i++) await page.keyboard.press(st.key);
          await H.sleep(400);
          const file = path.join(OUT, 'h5-full-' + lang + '-' + st.name + '.png');
          await page.screenshot({ path: file });
          console.log(file);
        } finally { await page.ctx.close(); }
      }
    }
  } finally {
    await env.stop();
  }
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
