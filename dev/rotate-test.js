/*
 * Auto-rotate layouts: node dev/rotate-test.js
 *
 * The Menu sheet's "Rotate layouts" setting (app/hub.js "auto-rotate
 * layouts"). Runs the real hub in headless Chromium with three layouts of
 * the same tiles (so no reload) plus one marked rotate: false, moves the
 * page's clock by hand (relative to the start, never a set time) and checks:
 *   - off: nothing moves, however long
 *   - on: the next layout after 2 minutes, not before
 *   - a key press pushes the next move to 5 minutes after it
 *   - it wraps round and skips layouts with rotate: false
 *   - nothing moves while a tile is open; 5 minutes after it closes it does
 *   - off again: nothing moves
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const H = require('./awws-harness');

const T = (x, y) => [
  { widget: 'today', x: x, y: 0, w: 3, h: 2 }, { widget: 'weather', x: y, y: 0, w: 3, h: 2 },
  { widget: 'calendar', x: 6, y: 2, w: 3, h: 4 }
];
const A = T(0, 3);
const B = T(3, 0);
const C = T(0, 9);
const D = T(9, 0);
const MIN = 60000;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n     '));
  }
}
function assert(ok, text) { if (!ok) throw new Error(text); }

(async () => {
  const env = await H.start({ snapshot: false, calendars: false, ownService: true });
  const start = new Date(env.at).getTime();
  let now = start;
  try {
    const page = await env.newPage({
      layout: A, live: 'off', motion: 'fade',
      // Our layouts in place of config.js's, set as config.js sets HUB_CONFIG.
      config: 'var lays = ' + JSON.stringify([
        { id: 'a', name: 'A', layout: A }, { id: 'b', name: 'B', layout: B },
        { id: 'd', name: 'D', layout: D, rotate: false }, { id: 'c', name: 'C', layout: C }
      ]) + '; var cfg; Object.defineProperty(window, "HUB_CONFIG", { configurable: true, get: function () { return cfg; },' +
        ' set: function (v) { cfg = v; if (v) v.layouts = lays; } });'
    });

    async function later(ms) {
      now += ms;
      await page.clock.setFixedTime(new Date(now));
      await H.sleep(250);              // a few ticks (100 ms each)
    }
    function which() {
      return page.evaluate((all) => {
        const cur = JSON.stringify(window.HUB_TEST.layout());
        for (const k in all) if (JSON.stringify(all[k]) === cur) return k;
        return '?';
      }, { A, B, C, D });
    }

    await check('Off: nothing moves', async () => {
      await page.evaluate(() => window.HUB_TEST.rotate.times(2 * 60000, 5 * 60000, 100));
      await later(30 * MIN);
      const s = await page.evaluate(() => window.HUB_TEST.rotate.state());
      assert(!s.on && (await which()) === 'A', JSON.stringify(s));
    });

    await check('The order leaves out rotate: false', async () => {
      const s = await page.evaluate(() => window.HUB_TEST.rotate.state());
      assert(s.order.join(',') === 'a,b,c', JSON.stringify(s));
    });

    await check('On: the next layout after 2 minutes, not before', async () => {
      await page.evaluate(() => { localStorage.setItem('homeHub.autoRotate', 'on'); window.HUB_TEST.rotate.times(2 * 60000, 5 * 60000, 100); });
      await later(1.5 * MIN);
      assert((await which()) === 'A', 'moved early');
      await later(0.6 * MIN);
      assert((await which()) === 'B', 'did not move: ' + (await which()));
    });

    await check('A key press waits 5 minutes from then', async () => {
      await later(1 * MIN);
      await page.keyboard.press('ArrowRight');
      await later(3 * MIN);
      assert((await which()) === 'B', 'moved while in use');
      await later(2.1 * MIN);
      assert((await which()) === 'C', 'did not move after 5 minutes: ' + (await which()));
    });

    await check('It wraps round to the first', async () => {
      await later(2.1 * MIN);
      assert((await which()) === 'A', await which());
    });

    await check('Nothing moves while a tile is open; 5 minutes after it closes it does', async () => {
      await H.openPanel(page, 'calendar');
      const at = await which();
      await later(20 * MIN);
      assert((await which()) === at, 'moved with a tile open');
      await page.keyboard.press('Escape');
      await H.idle(page);
      await later(3 * MIN);
      assert((await which()) === at, 'moved too soon after closing');
      await later(2.5 * MIN);
      assert((await which()) !== at, 'did not move after closing');
    });

    await check('Off again: nothing moves', async () => {
      await page.evaluate(() => { localStorage.removeItem('homeHub.autoRotate'); window.HUB_TEST.rotate.times(2 * 60000, 5 * 60000, 100); });
      const at = await which();
      await later(30 * MIN);
      assert((await which()) === at, 'moved while off');
    });

    await check('No console errors', async () => {
      const errs = H.errorsOf(page, true);
      assert(!errs.length, errs.join('\n'));
    });
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
