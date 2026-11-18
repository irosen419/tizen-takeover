/*
 * Screenshots of Plant sun: node dev/sunpath-shots.js <folder> [--before <root>]
 *
 * The real hub in headless Chromium at 1920x1080, deviceScaleFactor 1, on
 * the shared harness (dev/awws-harness.js: the preview, the Pi's hub server
 * and its sample data), with the TV's clock fixed in Chicago. Every shot
 * uses the same sample data; the wanderers are off and the weather picture
 * is still (in every shot, before and after alike), so only what a shot is
 * about changes.
 *
 *   plant-wall-1-lit.png            "Plant wall" layout, Jun 21 2026 6:10 PM (sun on the plants)
 *   plant-wall-2-later-today.png    the same, 2:00 PM ("Next sun at 5:15 PM")
 *   plant-wall-3-nov17.png          Nov 17 2026 3:05 PM ("Next sun Mar 9, 6:15 PM")
 *   panel-lit.png, full-lit.png     the panel and full screen at 6:10 PM, slider one step back (6:00 PM)
 *   panel-lit-arc.png, panel-lit-seasons.png   the panel's other two views
 *   panel-nov17.png, full-nov17.png the same on Nov 17, slider six steps on (4:30 PM)
 *   es-*.png                        the same in Spanish (tile, panel, full screen)
 *   sizes-lit.png, sizes-nov17.png  the tile at 1x1, 3x1, 3x2, 3x4 and 6x3, side by side
 *   placeholder-tag.png             the panel's Placeholder note, close up
 *   stock-before.png, stock-after.png  the stock layout (HUB_CONFIG.layout) on
 *                                   Mon Nov 16 2026 10:40 AM, with the hub
 *                                   from <root> (a copy of origin/main) and
 *                                   from this tree with the Ambiance
 *                                   placeholder's entry given to sunpath (same
 *                                   x, y, w, h). stock-diff.txt says which
 *                                   pixels differ.
 *
 * Needs Playwright and port 8095 free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = process.argv[2];
if (!OUT) { console.log('usage: node dev/sunpath-shots.js <folder> [--before <root of origin/main>]'); process.exit(1); }
const bi = process.argv.indexOf('--before');
const BEFORE_ROOT = bi > 0 ? process.argv[bi + 1] : '';
fs.mkdirSync(OUT, { recursive: true });

const ROOT = path.join(__dirname, '..');
const LIT = Date.parse('2026-06-21T23:10:00Z');        // 6:10 PM CDT
const AFTERNOON = Date.parse('2026-06-21T19:00:00Z');  // 2:00 PM CDT
const NOV17 = Date.parse('2026-11-17T21:05:00Z');      // 3:05 PM CST

function readConfig(root) {
  const box = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
  return box.c;
}
const CFG = readConfig(ROOT);
const PLANT_WALL = CFG.layouts.filter((l) => l.id === 'plant-wall')[0].layout;

// The same in every shot: no wanderers, a still weather picture.
const STILL = new Function('let cfg; Object.defineProperty(window, "HUB_CONFIG", { configurable: true, get: () => cfg, set: (v) => {' +
  ' cfg = v; try { v.clay = false; v.widgets.weather.scene = "calm"; } catch (e) {} } });');

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('saved ' + name);
}

async function crop(page, sel, pad) {
  const box = await page.locator(sel).first().boundingBox();
  pad = pad || 8;
  return page.screenshot({ clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(1920, box.width + 2 * pad), height: Math.min(1080, box.height + 2 * pad) } });
}

// Pictures side by side on a dark page, saved as one.
async function sideBySide(env, pics, labels, name) {
  const ctx = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const html = '<body style="margin:0;background:#0b0d12;font:20px Arial;color:#a4a8b3;padding:24px">' + pics.map((p, i) =>
    '<div style="display:inline-block;vertical-align:top;margin:0 24px 24px 0"><div style="margin-bottom:8px">' + labels[i] + '</div><img src="data:image/png;base64,' + p.toString('base64') + '"></div>').join('') + '</body>';
  await page.setContent(html);
  const size = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
  await page.setViewportSize({ width: Math.min(3800, size.w), height: Math.min(2400, size.h) });
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log('saved ' + name);
  await ctx.close();
}

async function plantWall(H, env) {
  for (const lang of ['en', 'es']) {
    const pre = lang === 'es' ? 'es-' : '';
    const runs = lang === 'es' ? [['1-lit', LIT], ['3-nov17', NOV17]] : [['1-lit', LIT], ['2-later-today', AFTERNOON], ['3-nov17', NOV17]];
    for (const [tag, at] of runs) {
      const page = await env.newPage({ layout: PLANT_WALL, at: at, config: STILL, storage: { 'homeHub.lang': lang } });
      await shot(page, pre + 'plant-wall-' + tag + '.png');
      if (tag !== '2-later-today') {
        const lit = tag === '1-lit';
        await H.openPanel(page, 'sunpath');
        // Scrub: one step back to 6:00 PM in June, six on to 4:30 PM in November.
        await H.key(page, lit ? 'ArrowLeft' : 'ArrowRight', lit ? 1 : 6);
        await H.sleep(200);
        await shot(page, pre + 'panel-' + (lit ? 'lit' : 'nov17') + '.png');
        if (lit && lang === 'en') {
          await crop(page, '.sp-place', 14).then((b) => fs.writeFileSync(path.join(OUT, 'placeholder-tag.png'), b));
          console.log('saved placeholder-tag.png');
          for (const v of ['arc', 'table']) {
            await page.evaluate((x) => document.querySelector('.sp-view-chip[data-view="' + x + '"]').click(), v);
            await H.sleep(150);
            await shot(page, 'panel-lit-' + (v === 'arc' ? 'arc' : 'seasons') + '.png');
          }
          await page.evaluate(() => document.querySelector('.sp-view-chip[data-view="plan"]').click());
        }
        await H.fullScreen(page);
        await H.sleep(200);
        await shot(page, pre + 'full-' + (lit ? 'lit' : 'nov17') + '.png');
      }
      const errs = H.errorsOf(page, true);
      if (errs.length) console.log('console in ' + tag + ' ' + lang + ': ' + errs.join(' | '));
      await page.ctx.close();
    }
  }
}

async function sizes(H, env) {
  const SIZES = [[1, 1], [3, 1], [3, 2], [3, 4], [6, 3]];
  for (const [tag, at] of [['lit', LIT], ['nov17', NOV17]]) {
    const pics = [];
    for (const [w, h] of SIZES) {
      const page = await env.newPage({ layout: [{ widget: 'sunpath', x: 0, y: 0, w: w, h: h }], at: at, config: STILL });
      pics.push(await crop(page, '.cell[data-widget="sunpath"] .tile', 6));
      await page.ctx.close();
    }
    await sideBySide(env, pics, SIZES.map((s) => s.join('×')), 'sizes-' + tag + '.png');
  }
}

// The stock layout, before (origin/main) and after (Ambiance's place given to sunpath).
async function beforeAfter() {
  if (!BEFORE_ROOT) { console.log('no --before root: before/after skipped'); return; }
  const stock = CFG.layout.map((e) => Object.assign({}, e));
  const after = stock.map((e) => e.widget === 'ambiance' ? Object.assign({}, e, { widget: 'sunpath' }) : e);
  const amb = stock.filter((e) => e.widget === 'ambiance')[0];
  const mainCfg = readConfig(BEFORE_ROOT);
  if (JSON.stringify(mainCfg.layout) !== JSON.stringify(CFG.layout)) throw new Error('the stock layout differs from origin/main');
  const shots = {};
  for (const [name, root, layout] of [['before', BEFORE_ROOT, stock], ['after', ROOT, after]]) {
    const H = require(path.join(root, 'dev', 'awws-harness'));
    const env = await H.start();
    try {
      const page = await env.newPage({ layout: layout, config: STILL });
      await H.sleep(600);
      shots[name] = await page.screenshot({ path: path.join(OUT, 'stock-' + name + '.png') });
      console.log('saved stock-' + name + '.png');
      if (name === 'after') shots.rect = await page.evaluate(() => { const r = document.querySelector('.cell[data-widget="sunpath"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await page.ctx.close();
      // Which pixels differ, in a page of its own.
      if (name === 'after') {
        const ctx = await env.browser.newContext();
        const p = await ctx.newPage();
        const d = await p.evaluate(async (pics) => {
          const load = (b64) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + b64; });
          const [a, b] = await Promise.all([load(pics[0]), load(pics[1])]);
          const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
          const g = c.getContext('2d');
          g.drawImage(a, 0, 0); const A = g.getImageData(0, 0, 1920, 1080).data;
          g.drawImage(b, 0, 0); const B = g.getImageData(0, 0, 1920, 1080).data;
          let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (let i = 0; i < A.length; i += 4) {
            if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2]) {
              n++; const x = (i / 4) % 1920, y = Math.floor(i / 4 / 1920);
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
          return { n: n, box: n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
        }, [shots.before.toString('base64'), shots.after.toString('base64')]);
        await ctx.close();
        const r = shots.rect;
        const inside = !d.box || (d.box.x >= r.x - 2 && d.box.y >= r.y - 2 && d.box.x + d.box.w <= r.x + r.w + 2 && d.box.y + d.box.h <= r.y + r.h + 2);
        const text = 'Stock layout, Mon Nov 16 2026 10:40 AM Chicago, same sample data, wanderers off, weather still.\n' +
          'Before: origin/main. After: this tree, with the layout entry ' + JSON.stringify(amb) + ' given to sunpath.\n' +
          'Pixels that differ: ' + d.n + ', inside ' + JSON.stringify(d.box) + '; the tile cell is ' + JSON.stringify(r) + '.\n' +
          (inside ? 'Every differing pixel is inside that cell.\n' : 'SOME DIFFERING PIXELS ARE OUTSIDE THAT CELL.\n');
        fs.writeFileSync(path.join(OUT, 'stock-diff.txt'), text);
        console.log(text.trim());
      }
    } finally {
      await env.stop();
    }
  }
}

(async function main() {
  const H = require('./awws-harness');
  const env = await H.start();
  try {
    await plantWall(H, env);
    await sizes(H, env);
  } finally {
    await env.stop();
  }
  await beforeAfter();
  process.exit(0);
})().catch((e) => { console.log('FAILED: ' + (e && e.stack)); process.exit(1); });
