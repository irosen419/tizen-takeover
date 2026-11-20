/*
 * Pictures of the day and night look (app/theme.css, the day and night code in
 * app/hub.js) on the Main layout:
 *   node dev/theme-shots.js --out <folder> [--tag before|after] [--only <text>]
 *
 * Runs the real hub against the preview and the real hub server from pi/
 * (dev/awws-harness.js: the clock at Monday 16 November 2026, 10:40 AM in
 * Chicago, the sample calendars and budget, three to-dos), 1920x1080, in
 * English, on three pictures: the real ocean (ocean) and the two stress
 * pictures in dev/samples (bright: a bright sky, busy: a busy scene).
 *
 *   theme-<night|day>-<ocean|bright|busy>-<tag>.png
 *
 * Night and day are asked for with ?theme=night and ?theme=day. Code from
 * before the look ignores that, so --tag before on the old code gives the
 * comparison pictures. --tag names the pictures (default "after"). Needs
 * Playwright and port 8095 free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'theme-shots');
const TAG = arg('--tag') || 'after';
const ONLY = arg('--only') || '';

function mainLayout() {
  const vm = require('vm');
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + ';this.C = HUB_CONFIG;', box);
  return box.C.layouts.filter((l) => l.id === 'main')[0].layout;
}
const MAIN = mainLayout();
// The sample's charge alert counts as shown, so the banner doesn't cover the tiles.
const SEEN = { 'homeHub.budget.seen.v1': '["a-1042"]' };
const PICTURES = { ocean: null, bright: path.join(__dirname, 'samples', 'bright.jpg'), busy: path.join(__dirname, 'samples', 'busy.jpg') };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start();
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z') }));
    for (const t of ['TODO!: Renew the car registration', 'Pick up the grow light timers', 'TODO~: Book the vet for Ember']) {
      await env.control('POST', '/api/todo', { title: t, section: 'now' });
    }
    for (const look of ['night', 'day']) {
      for (const pic of Object.keys(PICTURES)) {
        const name = 'theme-' + look + '-' + pic + '-' + TAG + '.png';
        if (ONLY && name.indexOf(ONLY) < 0) continue;
        const file = PICTURES[pic];
        const page = await env.newPage({
          layout: MAIN, storage: Object.assign({ 'homeHub.lang': 'en' }, SEEN),
          route: file ? async (ctx) => ctx.route(/backgrounds\/ocean\.jpg/, (r) => r.fulfill({ path: file, contentType: 'image/jpeg' })) : undefined
        });
        await page.goto(page.url() + '&theme=' + look);
        await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
        await H.until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 8000, 'no glass');
        await H.sleep(1000);
        await page.screenshot({ path: path.join(OUT, name) });
        const errs = page.context().errors.filter((e) => !/net::|Failed to load/.test(e));
        console.log('  ' + name + (errs.length ? ' ' + JSON.stringify(errs.slice(0, 2)) : ''));
        await page.context().close();
      }
    }
  } finally { await env.stop(); }
}

main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
