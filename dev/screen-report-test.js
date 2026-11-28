/*
 * The screen report and the TV-only commands from Home Assistant's Home Hub
 * dashboard (app/hub.js "the screen report", liveLayout, liveScene;
 * pi/screenreport.js): node dev/screen-report-test.js
 *
 * The real hub in headless Chromium against the real hub server (through
 * dev/awws-harness.js), with three saved layouts (A and B the same tiles, C
 * other ones). Checks: the report reaches the Pi (layout, layouts, widgets,
 * home screen, the wanderers' scenes); a command for the TV only is left
 * alone by a browser; a layout by id switches (and reloads for other
 * tiles) and the report follows; an unknown layout and a refused animation
 * say so on screen in English and Spanish, whole; an animation on the home
 * screen goes to the wanderers; with a panel open it is refused and the
 * report says panel with no scenes. The stage scenes are in dev/band-test.js.
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
const C = [{ widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'todo', x: 3, y: 0, w: 3, h: 4 }];
const LAYS = [{ id: 'a', name: 'A', layout: A }, { id: 'b', name: 'B', layout: B }, { id: 'c', name: 'C', layout: C }];
const CONFIG = 'var lays = ' + JSON.stringify(LAYS) + '; var cfg; Object.defineProperty(window, "HUB_CONFIG", { configurable: true, get: function () { return cfg; },' +
  ' set: function (v) { cfg = v; if (v) v.layouts = lays; } });';

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

// The wanderers stood in for: what they offer and what was asked of them.
const STUB = () => {
  window.__asked = [];
  window.HUB_CLAY.scenes = function () { return ['stroll', 'fetch', 'night']; };
  window.HUB_CLAY.play = function (n) { window.__asked.push(n); return ''; };
};

(async () => {
  const env = await H.start({ snapshot: false, calendars: false, ownService: true });
  const screen = () => env.control('GET', '/api/screen?screen=browser');
  const cmd = (type, data) => env.control('POST', '/api/command', { type: type, data: data });
  const toastText = (page) => page.evaluate(() => {
    const t = document.querySelector('.toast.is-shown');
    return t ? { text: t.textContent, whole: t.scrollWidth <= t.clientWidth + 1 && t.scrollHeight <= t.clientHeight + 1 } : null;
  });
  try {
    for (const lang of ['en', 'es']) {
      const page = await env.newPage({ layout: A, motion: 'fade', config: CONFIG, lang: lang === 'es' ? 'es' : undefined });
      await page.evaluate(STUB);

      if (lang === 'en') {
        await check('the report reaches the Pi: layout A, the three layouts, the widgets, home screen, the wanderers', async () => {
          const r = await H.until(() => screen().then((x) => (x.on && x.scenes.length ? x : false)), 8000, 'no report');
          assert(r.kind === 'browser' && r.place === 'home' && r.layout === 'a' && r.layoutName === 'A', JSON.stringify(r));
          assert(r.layouts.map((l) => l.id).join() === 'a,b,c', JSON.stringify(r.layouts));
          assert(r.widgets.indexOf('calendar') >= 0 && r.widgets.indexOf('todo') < 0, JSON.stringify(r.widgets));
          assert(r.animations === 'wanderers' && r.scenes.join() === 'stroll,fetch,night', JSON.stringify(r));
        });

        await check('a command for the TV only is left alone here', async () => {
          await cmd('layout', { id: 'b' });
          await cmd('scene', { name: 'fetch' });
          await H.sleep(800);
          const s = await page.evaluate(() => ({ asked: window.__asked.length, lay: JSON.stringify(window.HUB_TEST.layout()) }));
          assert(s.asked === 0 && s.lay === JSON.stringify(A), JSON.stringify(s));
        });

        await check('a layout by id: B moves the tiles; the report follows', async () => {
          await cmd('layout', { id: 'b', screen: 'all' });
          await H.until(() => page.evaluate((b) => JSON.stringify(window.HUB_TEST.layout()) === b, JSON.stringify(B)), 5000, 'B did not show');
          await H.until(() => screen().then((x) => x.layout === 'b'), 6000, 'the report did not say b');
        });

        await check('an animation on the home screen goes to the wanderers; the report says it played', async () => {
          await cmd('scene', { name: 'fetch', screen: 'all' });
          await H.until(() => page.evaluate(() => window.__asked.join() === 'fetch'), 4000, 'not asked');
          await H.until(() => screen().then((x) => x.last && x.last.scene === 'fetch' && x.last.ok), 6000, 'the report did not say played');
        });
      }

      await check('(' + lang + ') an unknown layout says so, whole', async () => {
        await cmd('layout', { id: 'nosuch', screen: 'all' });
        const t = await H.until(() => toastText(page).then((x) => (x && /nosuch/.test(x.text) ? x : false)), 4000, 'no toast');
        const want = lang === 'es' ? 'Se pidió el diseño "nosuch", que este hub no tiene.' : 'Asked for the "nosuch" layout, which this hub doesn\'t have.';
        assert(t.text.indexOf(want) >= 0 && t.whole, JSON.stringify(t));
      });

      await check('(' + lang + ') with a panel open an animation is refused, said whole; the report says panel, no scenes', async () => {
        await H.openPanel(page, 'calendar');
        await cmd('scene', { name: 'stroll', screen: 'all' });
        const want = lang === 'es' ? 'Cierra el panel para ver esa animación.' : 'Close the panel to see that animation.';
        const t = await H.until(() => toastText(page).then((x) => (x && x.text.indexOf(want) >= 0 ? x : false)), 4000, 'no toast');
        assert(t.whole, 'the words are cut: ' + JSON.stringify(t));
        const r = await H.until(() => screen().then((x) => (x.place === 'panel' ? x : false)), 6000, 'the report did not say panel');
        assert(r.open === 'calendar' && r.animations === 'none' && !r.scenes.length && r.last.scene === 'stroll' && r.last.why === 'busy', JSON.stringify(r));
        assert(await page.evaluate(() => window.__asked.indexOf('stroll') < 0), 'the wanderers were asked anyway');
        await page.keyboard.press('Escape');
        await H.idle(page);
      });

      if (lang === 'en') {
        await check('layout C (other tiles) reloads into C; the report says c', async () => {
          await cmd('layout', { id: 'c', screen: 'all' });
          await H.until(() => page.evaluate((c) => window.HUB_TEST && JSON.stringify(window.HUB_TEST.layout()) === c, JSON.stringify(C)).catch(() => false), 10000, 'C did not show');
          await H.until(() => screen().then((x) => x.layout === 'c' && x.widgets.indexOf('todo') >= 0), 8000, 'the report did not say c');
        });
      }

      await check('(' + lang + ') no console errors', async () => {
        const errs = H.errorsOf(page, true);
        assert(!errs.length, errs.join('\n'));
      });
    }
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
