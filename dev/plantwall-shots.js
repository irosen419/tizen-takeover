/*
 * Screenshots of Plant wall: node dev/plantwall-shots.js <folder> [--scale 2]
 *
 * The real hub in headless Chromium at 1920x1080 on the shared harness
 * (dev/awws-harness.js), wanderers off and the weather picture still, so
 * only the layout changes between before and after.
 *
 *   plants-before.png      the "Plants" layout as on main: Plant sun alone, 12x6
 *   plants-after.png       the new one: Plant wall 12x4 over Plant sun 12x2
 *   plants-after-es.png    the same in Spanish
 *   full-en.png, full-es.png   Plant wall opened (full screen)
 *
 * Needs Playwright and port 8095 free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = process.argv[2];
if (!OUT) { console.log('usage: node dev/plantwall-shots.js <folder> [--scale 2]'); process.exit(1); }
const si = process.argv.indexOf('--scale');
const SCALE = si > 0 ? Number(process.argv[si + 1]) || 1 : 1;
fs.mkdirSync(OUT, { recursive: true });

const ROOT = path.join(__dirname, '..');
const box = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
const AFTER = box.c.layouts.filter((l) => l.id === 'plant-wall')[0].layout;
const BEFORE = [{ widget: 'sunpath', x: 0, y: 0, w: 12, h: 6 }];

const STILL = new Function('let cfg; Object.defineProperty(window, "HUB_CONFIG", { configurable: true, get: () => cfg, set: (v) => {' +
  ' cfg = v; try { v.clay = false; v.widgets.weather.scene = "calm"; } catch (e) {} } });');

(async function main() {
  const H = require('./awws-harness');
  const env = await H.start({ at: Date.now() });
  try {
    const runs = [['plants-before', BEFORE, 'en', false], ['plants-after', AFTER, 'en', true], ['plants-after-es', AFTER, 'es', true]];
    for (const [name, layout, lang, full] of runs) {
      const page = await env.newPage({ layout: layout, at: Date.now(), config: STILL, scale: SCALE, storage: { 'homeHub.lang': lang } });
      await H.sleep(500);
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      console.log('saved ' + name + '.png');
      if (full) {
        await H.openPanel(page, 'plantwall');
        await H.sleep(300);
        const fname = 'full-' + lang + '.png';
        await page.screenshot({ path: path.join(OUT, fname) });
        console.log('saved ' + fname);
      }
      const errs = H.errorsOf(page, true);
      if (errs.length) console.log('console in ' + name + ': ' + errs.join(' | '));
      await page.ctx.close();
    }
  } finally {
    await env.stop();
  }
  process.exit(0);
})().catch((e) => { console.log('FAILED: ' + (e && e.stack)); process.exit(1); });
