/*
 * The Menu on a TV: node dev/tvmenu-test.js   (SHOTS=<dir> also saves screenshots)
 *
 * The tablet's Menu sheet (Settings, About, Layouts, Photos) on a TV, worked
 * by the remote (hub.js "the Menu on a TV", docs/tv-menu.md). Runs the real
 * hub in headless Chromium at 1920x1080 and checks:
 *   - the tab is out of sight until Down off a bottom tile raises it,
 *     focused (the tile lets go of its focus); Up or Back puts it away and
 *     the tile has its focus back
 *   - OK on the tab opens the sheet with the focus on Look's choice
 *   - the arrows move the focus between the settings, over to the layouts,
 *     and to Close; Up and Down stay in their column, which scrolls when
 *     nothing more is below; OK on a choice uses it (Language), and the focus stays
 *   - Rotate layouts (below Guest mode) turns on and off with OK
 *   - Guest mode still asks for the PIN, and the sheet stays behind it
 *   - OK on a layout uses it and closes the sheet; Back closes it and the
 *     tile it came from has its focus back
 *   - Spanish: the tab and the sheet, accents not clipped, room to spare
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const path = require('path');
const H = require('./awws-harness');

const SHOTS = process.env.SHOTS || '';
const LAYOUT = [
  { widget: 'todo', x: 0, y: 0, w: 3, h: 4 }, { widget: 'today', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'entertainment', x: 3, y: 4, w: 9, h: 2 }
];

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
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); }

function st(page) {
  return page.evaluate(() => {
    const tab = document.querySelector('.tablet-tab');
    const r = tab.getBoundingClientRect();
    const f = document.querySelector('.tile.is-focused');
    return Object.assign(window.HUB_TEST.tablet(), {
      tabTop: Math.round(r.top), tabOp: getComputedStyle(tab).opacity,
      tile: f ? f.parentNode.getAttribute('data-widget') : null,
      shown: document.querySelector('.tsheet').classList.contains('is-shown'),
      rings: document.querySelectorAll('.tsheet .is-tvfocus').length
    });
  });
}

async function keys(page, list) {
  for (const k of list) { await page.keyboard.press(k); await H.sleep(120); }
}

(async () => {
  const env = await H.start({ snapshot: false, calendars: false, ownService: true });
  try {
    const page = await env.newPage({ layout: LAYOUT, live: 'off', motion: 'fade' });

    await check('The tab stays out of sight on the home screen', async () => {
      const s = await st(page);
      assert(!s.on && !s.peek && s.tabTop >= 1079 && s.tabOp === '0', JSON.stringify(s));
    });

    await check('Down off a bottom tile raises the tab, focused; Up puts it back', async () => {
      await H.focusTile(page, 'entertainment');
      await shot(page, 'before-bottom-tile.png');
      await page.keyboard.press('ArrowDown');
      await H.sleep(400);
      let s = await st(page);
      assert(s.peek && s.tabTop < 1080 && s.tabTop > 1000 && s.tabOp === '1' && s.tile === null, JSON.stringify(s));
      await shot(page, 'after-tab-peek.png');
      await page.keyboard.press('ArrowUp');
      await H.sleep(300);
      s = await st(page);
      assert(!s.peek && s.tile === 'entertainment', JSON.stringify(s));
      await keys(page, ['ArrowDown', 'Escape']);
      s = await st(page);
      assert(!s.peek && s.tile === 'entertainment', 'Back: ' + JSON.stringify(s));
      // Left and Right leave it up.
      await keys(page, ['ArrowDown', 'ArrowLeft']);
      s = await st(page);
      assert(s.peek, 'Left put it away');
    });

    await check('OK opens the sheet, focus on Look', async () => {
      await page.keyboard.press('Enter');
      await H.sleep(500);
      const s = await st(page);
      assert(s.sheet && s.shown && !s.peek && s.focus === 'set:look-auto' && s.rings === 1, JSON.stringify(s));
      const t = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.tsheet-title'), (n) => n.textContent).join('|'));
      assert(t === 'Settings|About this hub|Layouts|Photos', t);
      await shot(page, 'after-sheet-en.png');
    });

    await check('The arrows move through the settings, to the layouts and to Close', async () => {
      await keys(page, ['ArrowDown', 'ArrowDown']);
      let s = await st(page);
      assert(s.focus === 'set:guest-off', JSON.stringify(s));
      await keys(page, ['ArrowRight']);
      s = await st(page);
      assert(s.focus === 'set:guest-on', JSON.stringify(s));
      await shot(page, 'after-sheet-guest-focus.png');
      // Down stays in the column: About's button row, then the column scrolls.
      // Down: Rotate layouts (On, the same column), OK turns it on and off.
      await keys(page, ['ArrowDown']);
      s = await st(page);
      assert(s.focus === 'set:rotate-on', 'Down from Guest mode: ' + JSON.stringify(s));
      await keys(page, ['Enter']);
      let r = await page.evaluate(() => window.HUB_TEST.rotate.state());
      s = await st(page);
      assert(r.on && s.focus === 'set:rotate-on' && s.rings === 1, 'Rotate on: ' + JSON.stringify([r, s]));
      await keys(page, ['ArrowLeft', 'Enter']);
      r = await page.evaluate(() => window.HUB_TEST.rotate.state());
      assert(!r.on, 'Rotate off: ' + JSON.stringify(r));
      await keys(page, ['ArrowDown']);
      s = await st(page);
      assert(/^about:/.test(s.focus), 'Down from Rotate layouts: ' + JSON.stringify(s));
      await shot(page, 'after-sheet-about-focus.png');
      const top0 = await page.evaluate(() => document.querySelector('.tsheet-left').scrollTop);
      await keys(page, ['ArrowDown', 'ArrowDown']);
      const top1 = await page.evaluate(() => document.querySelector('.tsheet-left').scrollTop);
      assert(top1 > top0, 'the column did not scroll: ' + top0 + ' ' + top1);
      await keys(page, ['ArrowUp', 'ArrowUp']);
      s = await st(page);
      assert(/^set:guest-/.test(s.focus), 'Up back to Guest mode: ' + JSON.stringify(s));
      await page.evaluate(() => { document.querySelector('.tsheet-left').scrollTop = 0; });
      if (s.focus !== 'set:guest-on') await keys(page, ['ArrowRight']);
      await keys(page, ['ArrowRight']);
      s = await st(page);
      assert(/^lay:\d+$/.test(s.focus) || s.focus === 'show', 'Right off the settings: ' + JSON.stringify(s));
      await keys(page, ['ArrowLeft']);
      s = await st(page);
      assert(/^set:/.test(s.focus), 'Left back: ' + JSON.stringify(s));
      await keys(page, ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']);
      s = await st(page);
      assert(s.focus === 'close', JSON.stringify(s));
      await keys(page, ['ArrowDown']);
      s = await st(page);
      assert(/^set:look-/.test(s.focus), 'Down from Close: ' + JSON.stringify(s));
    });

    await check('Guest mode asks for the PIN; the sheet stays behind it', async () => {
      await keys(page, ['ArrowDown', 'ArrowDown']);
      let s = await st(page);
      if (s.focus !== 'set:guest-on') await keys(page, ['ArrowRight']);
      s = await st(page);
      assert(s.focus === 'set:guest-on', JSON.stringify(s));
      await page.keyboard.press('Enter');
      await H.until(() => page.evaluate(() => window.HUB_PIN.isOpen()), 3000, 'no PIN pop-up');
      await shot(page, 'after-guest-pin.png');
      // The PIN pad has every key: Back cancels it, the sheet is still up.
      await page.keyboard.press('Escape');
      await H.sleep(400);
      s = await st(page);
      const g = await page.evaluate(() => ({ guest: window.HUB_GUEST.on(), pin: window.HUB_PIN.isOpen() }));
      assert(!g.guest && !g.pin && s.sheet && s.focus === 'set:guest-on' && s.rings === 1, JSON.stringify([g, s]));
    });

    await check('OK on Español switches the language; the focus stays on it', async () => {
      await keys(page, ['ArrowUp']);
      let s = await st(page);
      if (s.focus !== 'set:lang-es') await keys(page, ['ArrowRight']);
      s = await st(page);
      assert(s.focus === 'set:lang-es', JSON.stringify(s));
      await page.keyboard.press('Enter');
      await H.sleep(400);
      s = await st(page);
      const t = await page.evaluate(() => ({ lang: window.HUB_I18N.lang(), title: document.querySelector('.tsheet-title').textContent }));
      assert(t.lang === 'es' && t.title === 'Ajustes' && s.focus === 'set:lang-es' && s.rings === 1, JSON.stringify([t, s]));
      await shot(page, 'after-sheet-es.png');
    });

    await check('Spanish: nothing clipped in the sheet or the tab', async () => {
      const bad = await page.evaluate(() => {
        const out = [];
        const nodes = document.querySelectorAll('.tsheet-title, .tsheet-set-label, .tsheet-opt, .tsheet-close-label, .tsheet-btn-label, .switcher-name, .tablet-tab-label');
        for (const n of nodes) {
          if (!n.offsetWidth) continue;
          const cs = getComputedStyle(n);
          if (parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) < 1.29) out.push(n.className + ' line-height');
          if (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1) out.push(n.className + ' clipped');
        }
        // Each settings row on one line, with room for 25% more.
        for (const r of document.querySelectorAll('.tsheet-set')) {
          if (r.getBoundingClientRect().height > 70) out.push('row wraps: ' + r.textContent);
        }
        return out;
      });
      assert(!bad.length, bad.join(', '));
    });

    await check('Back closes the sheet; the tile has its focus back', async () => {
      await page.keyboard.press('Escape');
      await H.sleep(500);
      const s = await st(page);
      assert(!s.sheet && !s.shown && !s.peek && s.tile === 'entertainment' && s.rings === 0, JSON.stringify(s));
      // English again for the rest.
      await page.evaluate(() => window.HUB_I18N.setLang('en'));
      await H.sleep(300);
    });

    await check('Spanish tab: Menú, accent not clipped', async () => {
      await page.evaluate(() => window.HUB_I18N.setLang('es'));
      await H.sleep(200);
      await keys(page, ['ArrowDown']);
      await H.sleep(300);
      const s = await page.evaluate(() => {
        const n = document.querySelector('.tablet-tab-label');
        return { text: n.textContent, clip: n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1 };
      });
      assert(s.text === 'Menú' && !s.clip, JSON.stringify(s));
      await shot(page, 'after-tab-peek-es.png');
      await keys(page, ['ArrowUp']);
      await page.evaluate(() => window.HUB_I18N.setLang('en'));
      await H.sleep(300);
    });

    await check('OK on a layout uses it and closes the sheet', async () => {
      await keys(page, ['ArrowDown', 'Enter']);
      await H.sleep(500);
      const n = await page.evaluate(() => document.querySelectorAll('.tsheet .switcher-item').length);
      assert(n >= 2, 'layouts: ' + n);
      // Over to the layouts, then to one that is not in use.
      await keys(page, ['ArrowRight', 'ArrowRight', 'ArrowRight']);
      let s = await st(page);
      for (let i = 0; i < 4 && !/^lay:/.test(s.focus); i++) { await keys(page, ['ArrowUp']); s = await st(page); }
      assert(/^lay:/.test(s.focus), JSON.stringify(s));
      const pick = await page.evaluate(() => {
        const items = document.querySelectorAll('.tsheet .switcher-item');
        for (let i = 0; i < items.length; i++) if (!items[i].classList.contains('is-active')) return i;
        return -1;
      });
      let at = +s.focus.slice(4);
      while (at !== pick) { await keys(page, [at < pick ? 'ArrowRight' : 'ArrowLeft']); const was = at; s = await st(page); at = +s.focus.slice(4); if (at === was) break; }
      assert(at === pick, 'could not reach layout ' + pick + ': ' + JSON.stringify(s));
      await shot(page, 'after-sheet-layout-focus.png');
      await page.keyboard.press('Enter');
      await H.sleep(900);
      s = await st(page);
      assert(!s.sheet, 'still up: ' + JSON.stringify(s));
    });

    const errs = (H.errorsOf(page) || []).filter((e) => !/Failed to load resource|net::/.test(e));
    await check('No console errors', async () => { assert(!errs.length, errs.join(' | ')); });
    await page.ctx.close();
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
