/*
 * Screenshots of Moods: node dev/moods-shots.js <folder> [--scale 2] [--only name,name]
 *
 * The real hub in headless Chromium at 1920x1080 on the shared harness
 * (dev/awws-harness.js), against the made-up moods resource
 * (dev/samples/moods-sample.json, served by the fake in dev/moods-test.js
 * until the Pi's moods controller lands). Wanderers off, the weather picture
 * still.
 *
 *   layout-en.png, layout-es.png, layout-day.png   the "Moods test" layout
 *   tiles-en.png, tiles-es.png                     the tile at 1x1, 3x1, 6x1, 3x2, 6x2, 6x4
 *   panel-en.png, panel-es.png, panel-preview.png  the panel (and a card previewed)
 *   full-en.png, full-es.png, full-menorah.png     full screen
 *   tablet.png                                     the wall tablet (?as=tablet), full screen
 *   phone-en.png, phone-es.png                     the phone (touch.html?as=phone, 390 wide)
 *   notset.png, away.png                           not set up, not answering
 *
 * Needs Playwright and port 8095 free. Writes only into <folder>.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = process.argv[2];
if (!OUT) { console.log('usage: node dev/moods-shots.js <folder> [--scale 2] [--only a,b]'); process.exit(1); }
const si = process.argv.indexOf('--scale');
const SCALE = si > 0 ? Number(process.argv[si + 1]) || 1 : 1;
const oi = process.argv.indexOf('--only');
const ONLY = oi > 0 ? process.argv[oi + 1].split(',') : null;
fs.mkdirSync(OUT, { recursive: true });

const ROOT = path.join(__dirname, '..');
const box = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
const LAYOUT = box.c.layouts.filter((l) => l.id === 'moods-test')[0].layout;
// A layout shows a widget once, so each size is its own page; the shots of
// the tiles are put together on one sheet.
const SIZES = [[1, 1], [3, 1], [6, 1], [3, 2], [6, 2], [6, 4], [8, 6]];
const sizeLayout = (w, h) => [{ widget: 'moods', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: w < 12 ? w : 0, y: 0, w: 12 - w, h: 6 }];

const STILL = new Function('let cfg; Object.defineProperty(window, "HUB_CONFIG", { configurable: true, get: () => cfg, set: (v) => {' +
  ' cfg = v; try { v.clay = false; v.widgets.weather.scene = "calm"; } catch (e) {} } });');

(async function main() {
  const H = require('./awws-harness');
  const T = require('./moods-test');
  const env = await H.start({ at: Date.now() });
  const want = (n) => !ONLY || ONLY.indexOf(n) >= 0;
  async function page(o) {
    const fake = T.fakePi(o.fake || {});
    const p = await env.newPage(Object.assign({ layout: o.layout || LAYOUT, at: Date.now(), config: o.config || STILL, scale: SCALE,
      storage: { 'homeHub.lang': o.lang || 'en' }, live: T.FAKE, route: fake.route, waitLive: false, motion: o.motion || 'fade' }, o.extra || {}));
    await H.until(() => p.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'fake live');
    await H.sleep(700);
    p.fake = fake;
    return p;
  }
  async function save(p, name) {
    await p.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('saved ' + name + '.png');
    const errs = H.errorsOf(p, true);
    if (errs.length) console.log('console in ' + name + ': ' + errs.join(' | '));
  }
  try {
    for (const lang of ['en', 'es']) {
      if (want('layout-' + lang) || want('panel-' + lang) || want('full-' + lang)) {
        const p = await page({ lang });
        await save(p, 'layout-' + lang);
        await H.openPanel(p, 'moods');
        await H.sleep(300);
        await save(p, 'panel-' + lang);
        if (lang === 'en') {
          await H.key(p, 'ArrowRight', 2);
          await H.sleep(250);
          await save(p, 'panel-preview');
        }
        await H.fullScreen(p);
        await H.sleep(400);
        await save(p, 'full-' + lang);
        await p.ctx.close();
      }
      if (want('tiles-' + lang)) {
        const shots = [];
        for (const [w, h] of SIZES) {
          const p = await page({ lang, layout: sizeLayout(w, h) });
          const cell = await p.$('.cell[data-widget="moods"]');
          shots.push({ w, h, src: 'data:image/png;base64,' + (await cell.screenshot()).toString('base64') });
          const errs = H.errorsOf(p, true);
          if (errs.length) console.log('console in tiles ' + w + 'x' + h + ': ' + errs.join(' | '));
          await p.ctx.close();
        }
        const ctx = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
        const sheet = await ctx.newPage();
        await sheet.setContent('<body style="margin:0;background:#07080b;font:14px sans-serif;color:#888">' +
          '<div style="position:relative;width:1920px;height:1080px">' + shots.map((s, i) => {
            const pos = [[20, 20], [200, 20], [800, 20], [20, 200], [560, 200], [20, 420], [700, 420]][i];
            const scale = s.w === 8 ? 0.42 : s.w === 6 && s.h === 4 ? 0.62 : 0.5;
            return '<figure style="position:absolute;margin:0;left:' + pos[0] + 'px;top:' + pos[1] + 'px"><img style="zoom:' + scale + '" src="' + s.src + '"><figcaption>' + s.w + 'x' + s.h + '</figcaption></figure>';
          }).join('') + '</div></body>');
        await sheet.waitForTimeout(200);
        await sheet.screenshot({ path: path.join(OUT, 'tiles-' + lang + '.png') });
        console.log('saved tiles-' + lang + '.png');
        await ctx.close();
      }
    }
    if (want('layout-day')) {
      const p = await page({ extra: { query: 'theme=day' } });
      await save(p, 'layout-day');
      await p.ctx.close();
    }
    if (want('full-menorah')) {
      const p = await page({ fake: { now: { id: 'menorah', bri: 80, night: 3, pair: true } } });
      await H.openPanel(p, 'moods');
      await H.fullScreen(p);
      await H.sleep(400);
      await save(p, 'full-menorah');
      await p.ctx.close();
    }
    if (want('tablet')) {
      const p = await page({ extra: { query: 'as=tablet', touch: true } });
      await p.evaluate(() => { const t = document.querySelector('.cell[data-widget="moods"] .tile'); if (t) t.click(); });
      await H.sleep(1200);
      await save(p, 'tablet');
      await p.ctx.close();
    }
    if (want('notset')) {
      const p = await page({ fake: { state: 'notset' } });
      await save(p, 'notset');
      await p.ctx.close();
    }
    if (want('away')) {
      const p = await page({ fake: { state: 'error', problem: 'away' } });
      await save(p, 'away');
      await p.ctx.close();
    }
    for (const lang of ['en', 'es']) {
      if (!want('phone-' + lang)) continue;
      const fake = T.fakePi({});
      const ctx = await env.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await ctx.addInitScript((l) => { try { localStorage.setItem('homeHub.lang', l); } catch (e) { /* */ } }, lang);
      await fake.touchRoute(ctx, env.PAGE);
      const p = await ctx.newPage();
      await p.goto(env.PAGE + '/touch.html?as=phone#/moods');
      await p.waitForSelector('.mt-hero', { timeout: 10000 });
      await H.sleep(500);
      await p.screenshot({ path: path.join(OUT, 'phone-' + lang + '.png'), fullPage: true });
      console.log('saved phone-' + lang + '.png');
      await ctx.close();
    }
  } finally {
    await env.stop();
  }
  process.exit(0);
})().catch((e) => { console.log('FAILED: ' + (e && e.stack)); process.exit(1); });
