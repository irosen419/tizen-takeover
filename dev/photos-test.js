/*
 * Photo album on the TV (app/widgets/photos.js, photos.css): node dev/photos-test.js
 *
 * Runs the real hub in headless Chromium against the preview (needs port
 * 8095 free, like the other browser tests) with a stand-in Pi on a spare
 * port (?live=<it>): GET /photos/list and GET /photos/img/<id>?size=full|thumb
 * in the Pi's shape. Every image is SYNTHETIC: gradients and shapes drawn on
 * a canvas here, never a real photo. Nothing reaches the internet. Checks:
 *
 *   - photos.js is plain ES5; the CSS has no grid, no flex gap, animates only
 *     opacity and transform, blurs only the static fill, ends with .css-end;
 *     hub.html loads it; every photos.* key has Spanish; the Photos layout.
 *   - The logic: fit (portrait on a landscape tile is contained), month names.
 *   - The tile: the first photo shows with its month; a portrait photo is
 *     contained (object-fit contain, the whole image inside the frame) over a
 *     blurred fill; a landscape one covers; the slideshow advances by itself
 *     with an opacity crossfade; an unchanged rev redraws nothing, a new rev
 *     brings the new photos.
 *   - Full screen: OK opens straight to the grid (thumbnails by month, no CSS
 *     grid); arrows move focus; OK opens the viewer ("2 of 7"); Left/Right go
 *     back and on; a tap on the left or right half too; Back goes to the grid
 *     (focus on the photo it showed), then closes.
 *   - Live photos (video: 1, needs ffmpeg here to make a synthetic H.264 clip
 *     the way the Pi does): the tile shows the still, plays the clip ONCE
 *     (muted, inline), then moves on and frees the video; a clip that will
 *     not load leaves the still up for the usual time; the grid thumb has a
 *     play mark and "Video from ..."; the viewer plays it once too.
 *   - No photos: "No photos yet"; no Pi: "Photos live on the Pi"; no error box.
 *   - Sizes 1x1, 3x1, 3x2, 6x4 and Spanish with every photos text 25% longer
 *     (Á É ñ ¿ ¡): nothing outside its box, line-height at least 1.3.
 *
 * --shots <folder> (or PHOTOS_SHOTS) saves pictures at device scale 1.
 * Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OCEAN_JPG = fs.readFileSync(path.join(ROOT, 'app', 'backgrounds', 'ocean.jpg'));
const argShots = process.argv.indexOf('--shots');
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.PHOTOS_SHOTS || '');
let passed = 0;
let failed = 0;

function assert(ok, text) { if (!ok) throw new Error(text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(80);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + ': ' + String(e && e.message).split('\n')[0]);
  }
}
function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getOk(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  });
}

/* ---------- the stand-in Pi, with synthetic pictures ---------- */

// id, w, h, month, palette (sky top, sky bottom, ground, sun)
const PHOTOS = [
  ['p7', 1080, 1440, '2026-11', ['#2a3d66', '#e8a07a', '#2f4a3a', '#ffd9a0']],   // portrait first
  ['p6', 1440, 1080, '2026-11', ['#14324a', '#6fb3c9', '#20402e', '#fff2c4']],
  ['p5', 1080, 1440, '2026-11', ['#41295a', '#2f0743', '#1b1b2f', '#ffb199']],
  ['p4', 1440, 1080, '2026-10', ['#0f2027', '#2c5364', '#3a2f1f', '#f6d365']],
  ['p3', 1440, 960, '2026-10', ['#355c7d', '#c06c84', '#2b2d42', '#f8b195']],
  ['p2', 1080, 1440, '2026-08', ['#134e5e', '#71b280', '#233d2b', '#fffbd5']],
  ['p1', 1440, 1080, '2026-08', ['#3e5151', '#decba4', '#4b3b2a', '#ffffff']]
];
const EXTRA = ['p8', 1440, 1080, '2026-11', ['#1d2b64', '#f8cdda', '#24324a', '#fff0f5']];
// A live photo: a still (the clip's first frame) plus a short H.264 clip.
const VIDEO = ['v1', 720, 1280, '2026-11', ['#16222a', '#3a6073', '#1e2a22', '#fceabb'], 2];
const PI = { mode: 'ok', rev: 'r1', items: PHOTOS.slice(), lists: 0, imgs: {}, imgHits: 0, clip: null, clipHits: 0, clipOff: false };

// The clip the way photos-sync.sh makes it (H.264 Main, yuv420p, faststart, no sound). null without ffmpeg.
function makeClip() {
  const out = path.join(require('os').tmpdir(), 'hub-photos-clip-' + process.pid + '.mp4');
  try {
    childProcess.execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', String(VIDEO[5]), '-an',
      '-vf', 'format=yuv420p', '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart', out], { stdio: 'ignore' });
    const b = fs.readFileSync(out);
    fs.unlinkSync(out);
    return b;
  } catch (e) { return null; }
}

async function makeImages(browser) {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  for (const p of PHOTOS.concat([EXTRA, VIDEO])) {
    for (const size of ['full', 'thumb']) {
      const scale = size === 'full' ? 0.5 : 480 / p[1] / 1.6;
      const w = Math.round(p[1] * scale);
      const h = Math.round(p[2] * scale);
      const b64 = await page.evaluate((o) => {
        const c = document.getElementById('c');
        c.width = o.w; c.height = o.h;
        const g = c.getContext('2d');
        const sky = g.createLinearGradient(0, 0, 0, o.h);
        sky.addColorStop(0, o.pal[0]); sky.addColorStop(1, o.pal[1]);
        g.fillStyle = sky; g.fillRect(0, 0, o.w, o.h);
        // a sun
        g.fillStyle = o.pal[3]; g.globalAlpha = 0.9;
        g.beginPath(); g.arc(o.w * 0.68, o.h * 0.32, Math.min(o.w, o.h) * 0.11, 0, Math.PI * 2); g.fill();
        // two hills
        g.globalAlpha = 1; g.fillStyle = o.pal[2];
        g.beginPath(); g.moveTo(0, o.h * 0.72);
        g.quadraticCurveTo(o.w * 0.3, o.h * 0.52, o.w * 0.62, o.h * 0.7);
        g.quadraticCurveTo(o.w * 0.85, o.h * 0.8, o.w, o.h * 0.66);
        g.lineTo(o.w, o.h); g.lineTo(0, o.h); g.fill();
        g.globalAlpha = 0.55; g.fillStyle = '#000';
        g.beginPath(); g.moveTo(0, o.h * 0.86);
        g.quadraticCurveTo(o.w * 0.5, o.h * 0.74, o.w, o.h * 0.88);
        g.lineTo(o.w, o.h); g.lineTo(0, o.h); g.fill();
        // a marker at each edge, so a crop would show in a screenshot
        g.globalAlpha = 1; g.fillStyle = '#ffffff';
        g.fillRect(0, 0, o.w, Math.max(2, o.h * 0.012));
        g.fillRect(0, o.h - Math.max(2, o.h * 0.012), o.w, Math.max(2, o.h * 0.012));
        return c.toDataURL('image/jpeg', 0.85).split(',')[1];
      }, { w, h, pal: p[4] });
      PI.imgs[p[0] + ':' + size] = Buffer.from(b64, 'base64');
    }
  }
  await page.close();
}

function startPi(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (PI.mode === 'down') { res.writeHead(503, Object.assign({ 'Content-Type': 'application/json' }, cors)); return res.end('{"error":"down"}'); }
    if (u.pathname === '/photos/list') {
      PI.lists++;
      const items = PI.mode === 'empty' ? [] : PI.items.map((p) => (p[5] ? { id: p[0], w: p[1], h: p[2], month: p[3], video: 1, dur: p[5] } : { id: p[0], w: p[1], h: p[2], month: p[3] }));
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      return res.end(JSON.stringify({ rev: PI.mode === 'empty' ? 'r0' : PI.rev, count: items.length, items }));
    }
    const c = /^\/photos\/clip\/([\w-]+)$/.exec(u.pathname);
    if (c) {
      if (c[1] !== VIDEO[0] || !PI.clip || PI.clipOff) { res.writeHead(404, cors); return res.end(); }
      PI.clipHits++;
      res.writeHead(200, Object.assign({ 'Content-Type': 'video/mp4', 'Content-Length': PI.clip.length }, cors));
      return res.end(PI.clip);
    }
    const m = /^\/photos\/img\/([\w-]+)$/.exec(u.pathname);
    if (m) {
      const body = PI.imgs[m[1] + ':' + (u.searchParams.get('size') === 'thumb' ? 'thumb' : 'full')];
      if (!body) { res.writeHead(404, cors); return res.end(); }
      PI.imgHits++;
      res.writeHead(200, Object.assign({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' }, cors));
      return res.end(body);
    }
    // The live line: not this test's business.
    res.writeHead(404, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end('{"error":"not here"}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ---------- the page ---------- */

const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const CONFIG = fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚÁÉñ¿¡áéíóú";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k) || !/^photos\\./.test(k)) continue;' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.replace(/\\{\\w+\\}/g, "").length * 0.25)); es[k] = s + add.slice(0, n); } })();\n';

const LAYOUT = [
  { widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'photos', x: 3, y: 0, w: 6, h: 4 }, { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
  { widget: 'calendar', x: 0, y: 2, w: 3, h: 4 }, { widget: 'todo', x: 9, y: 2, w: 3, h: 4 }, { widget: 'entertainment', x: 3, y: 4, w: 6, h: 2 }
];
const env = {};

async function open(o) {
  o = o || {};
  const context = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: o.scale || 1 });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev') return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*' }, body: OCEAN_JPG });
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return route.abort();
    return route.fallback();
  });
  const cfgExtra = '\n;HUB_CONFIG.widgets.photos = { seconds: ' + (o.seconds || 60) + ", order: '" + (o.order || 'newest') + "' };\n";
  await context.route(/\/config\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: CONFIG + cfgExtra }));
  if (o.grow) await context.route(/\/i18n\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: I18N + GROW }));
  // "Before": the hub without the Photo album (its files answer with nothing in them).
  if (o.without) {
    await context.route(/\/widgets\/photos\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: ';(function () {})();' }));
    await context.route(/\/widgets\/photos\.css(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '.css-end { top: 0; }' }));
  }
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|EventSource/.test(m.text())) context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('ph-seeded')) return;
      sessionStorage.setItem('ph-seeded', '1');
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, { 'homeHub.layout': JSON.stringify(o.layout || LAYOUT), 'homeHub.layoutChoice': JSON.stringify({ id: o.choice || 'photos', piSig: '' }), 'homeHub.lang': o.lang || 'en' });
  await page.goto(env.PAGE + '/hub.html?motion=' + (o.motion || 'fade') + '&clay=off&live=' + encodeURIComponent(env.PI) + (o.lang ? '&lang=' + o.lang : ''));
  await page.waitForFunction(() => window.HUB_TEST && window.HUB_TEST.busy, null, { timeout: 15000 });
  if (!o.without && (o.layout || LAYOUT).some((e) => e.widget === 'photos')) await page.waitForFunction(() => document.querySelector('.cell[data-widget="photos"] .ph-frame:not(.hub-dormant)'), null, { timeout: 15000 });
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(500);
  page.ctx = context;
  return page;
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) { await page.keyboard.press(k); await sleep(140); }
}
async function settle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'busy');
  await sleep(250);
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function close(page) {
  const errors = page.ctx.errors.slice();
  await page.ctx.close();
  assert(!errors.length, 'console: ' + errors.join(' | '));
}

// The tile's front layer: which photo, its fit, and whether the image sits whole inside the frame.
function tileState(page) {
  return page.evaluate(() => {
    const cell = document.querySelector('.cell[data-widget="photos"]');
    const frame = cell && cell.querySelector('.ph-frame');
    const on = frame && frame.querySelector('.ph-layer.is-on');
    if (!on) return { on: false, text: frame ? frame.innerText : '' };
    const img = on.querySelector('.ph-img');
    const fill = on.querySelector('.ph-fill');
    const cs = getComputedStyle(img);
    const fr = frame.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    // the painted picture inside the img box (object-fit contain)
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const k = Math.min(ir.width / nw, ir.height / nh);
    const fcs = fill ? getComputedStyle(fill) : null;
    return {
      on: true, id: on.getAttribute('data-id'), fit: on.getAttribute('data-fit'), objectFit: cs.objectFit,
      painted: { w: nw * k, h: nh * k }, box: { w: ir.width, h: ir.height }, frame: { w: fr.width, h: fr.height },
      fill: !!(fill && fill.getAttribute('src')) && fcs.display !== 'none', fillFilter: fcs ? (fcs.filter || fcs.webkitFilter) : '',
      layerTransition: getComputedStyle(on).transitionProperty,
      caption: (on.querySelector('.ph-cap-text') || {}).textContent || '',
      layers: frame.querySelectorAll('.ph-layer').length,
      onCount: frame.querySelectorAll('.ph-layer.is-on').length,
      error: !!cell.querySelector('.tile-error, .widget-error')
    };
  });
}

// Every text in root: inside root's box, not cut sideways, line-height >= 1.3.
function textProblems(page, sel) {
  return page.evaluate((s) => {
    const out = [];
    document.querySelectorAll(s).forEach((root) => {
      const rr = root.getBoundingClientRect();
      root.querySelectorAll('.ph-quiet-head, .ph-quiet-hint, .ph-cap-text, .ph-month, .ph-view-month, .ph-view-count, .ph-view-tip').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || !el.textContent) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        if (r.left < rr.left - 1 || r.right > rr.right + 1 || r.top < rr.top - 1 || r.bottom > rr.bottom + 1) out.push('outside: ' + el.className + ' "' + el.textContent + '"');
        if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.push('cut: ' + el.className);
        const lh = parseFloat(cs.lineHeight), fs = parseFloat(cs.fontSize);
        if (lh && lh < fs * 1.3 - 0.1) out.push('line-height: ' + el.className + ' ' + lh + '/' + fs);
      });
    });
    return out;
  }, sel);
}

async function main() {
  env.PAGE_PORT = await spare();
  env.PI_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.PI = 'http://127.0.0.1:' + env.PI_PORT;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', LIGHTS_MODE: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();
  await makeImages(env.browser);
  PI.clip = makeClip();
  env.pi = await startPi(env.PI_PORT);

  try {
    await check('photos.js is plain ES5; the CSS: no grid, no flex gap, only opacity/transform animate, blur only on the static fill, ends with .css-end; hub.html loads it; every photos.* key has Spanish; the Photos layout', () => {
      let acorn = null;
      for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
        try { acorn = require(p); break; } catch (e) { /* next */ }
      }
      const text = fs.readFileSync(path.join(ROOT, 'app/widgets/photos.js'), 'utf8');
      if (acorn) acorn.parse(text, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
      const css = fs.readFileSync(path.join(ROOT, 'app/widgets/photos.css'), 'utf8');
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/display\s*:\s*(inline-)?grid|grid-template/.test(bare), 'CSS grid');
      assert(!/(^|[\s;{])(row-|column-)?gap\s*:/.test(bare), 'flex gap');
      assert(!/oklch|dvh/.test(bare), 'oklch or dvh');
      (bare.match(/transition(-property)?\s*:[^;]+/g) || []).forEach((t) => {
        const props = t.replace(/^[^:]+:/, '').replace(/cubic-bezier\([^)]*\)/g, '');
        assert(!/\b(width|height|top|left|right|bottom|filter|margin|padding|all|background)\b/.test(props), 'animates more than opacity/transform: ' + t);
      });
      assert(!/@(-webkit-)?keyframes/.test(bare), 'keyframes');
      const filters = bare.match(/[^{}]+\{[^}]*\bfilter\s*:[^}]*\}/g) || [];
      filters.forEach((r) => assert(/^\s*\.ph-fill\s*\{/.test(r), 'a filter outside the static fill: ' + r.trim().slice(0, 40)));
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'no .css-end at the end');
      const hub = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      assert(hub.indexOf('widgets/photos.js') > 0 && hub.indexOf('widgets/photos.css') > 0, 'hub.html');
      assert(hub.indexOf('widgets/photos.js') < hub.indexOf('src="hub.js"'), 'photos.js after hub.js');
      const box = { window: {}, location: { search: '' }, document: { documentElement: { setAttribute() {} } } };
      box.window = box;
      vm.runInNewContext(I18N, box);
      const es = box.HUB_I18N.strings.es;
      const keys = {};
      let m;
      const re = /T\('(photos\.[\w.]+)'/g;
      while ((m = re.exec(text))) keys[m[1]] = 1;
      const missing = Object.keys(keys).filter((k) => !es[k]);
      assert(Object.keys(keys).length >= 12, 'only ' + Object.keys(keys).length + ' keys found');
      assert(!missing.length, 'no Spanish for ' + missing.join(', '));
      assert(es['hub.layout.photos'], 'no Spanish layout name');
      const cb = {};
      vm.runInNewContext(CONFIG + '\nthis.cfg = HUB_CONFIG;', cb);
      const lay = cb.cfg.layouts.filter((l) => l.id === 'photos')[0];
      assert(lay && lay.name === 'Photos', 'no Photos layout');
      const ph = lay.layout.filter((e) => e.widget === 'photos')[0];
      assert(ph && ph.w === 6 && ph.h === 4, 'photos is not 6x4');
      assert(lay.layout.some((e) => e.widget === 'today') && lay.layout.some((e) => e.widget === 'weather'), 'no today/weather');
    });

    const page = await open({ seconds: 3 });

    await check('The logic: a portrait photo on a landscape tile is contained, a landscape one covers; months in English and Spanish', async () => {
      const r = await page.evaluate(() => {
        const P = window.HUB_PHOTOS;
        return {
          portrait: P.fitFor({ w: 1080, h: 1440 }, 900, 600), land: P.fitFor({ w: 1440, h: 1080 }, 900, 680),
          wide: P.fitFor({ w: 3000, h: 1000 }, 900, 680), none: P.fitFor({ w: 0, h: 0 }, 900, 680),
          en: P.monthLabel('2026-11'), es: (function () { window.HUB_I18N.setLang('es'); const t = P.monthLabel('2026-11'); window.HUB_I18N.setLang('en'); return t; })(),
          bad: P.monthLabel('nope')
        };
      });
      assert(r.portrait === 'contain' && r.land === 'cover' && r.wide === 'contain' && r.none === 'contain', JSON.stringify(r));
      assert(r.en === 'November 2026' && r.es === 'Noviembre de 2026' && r.bad === '', JSON.stringify(r));
    });

    await check('The tile shows the newest photo, a portrait: contained whole (object-fit contain) over a blurred fill, with its month', async () => {
      const s = await until(async () => { const t = await tileState(page); return t.on && t.id ? t : false; }, 8000, 'no photo on the tile');
      assert(s.id === 'p7' && s.fit === 'contain' && s.objectFit === 'contain', JSON.stringify(s));
      assert(s.fill && /blur/.test(s.fillFilter), 'no blurred fill: ' + JSON.stringify(s));
      assert(s.painted.w <= s.box.w + 1 && s.painted.h <= s.box.h + 1 && Math.abs(s.painted.h - s.box.h) < 2, 'cropped: ' + JSON.stringify(s));
      assert(s.box.w >= s.frame.w - 1 && s.box.h >= s.frame.h - 1, 'the image box is not the frame');
      assert(s.caption === 'November 2026', 'caption: ' + s.caption);
      assert(s.layers === 2 && s.onCount === 1 && /opacity/.test(s.layerTransition), JSON.stringify(s));
      assert(!s.error, 'an error box');
      await shot(page, '02-photos-layout');
    });

    await check('The slideshow advances by itself (3 s here), crossfading by opacity; the landscape photo covers, without a fill', async () => {
      const s = await until(async () => { const t = await tileState(page); return t.id === 'p6' && t.onCount === 1 ? t : false; }, 9000, 'it did not advance');
      assert(s.fit === 'cover' && s.objectFit === 'cover' && !s.fill, JSON.stringify(s));
      const st = await page.evaluate(() => window.HUB_PHOTOS.state());
      assert(st.index === 1 && st.count === 7, JSON.stringify(st));
    });

    await check('An unchanged rev redraws nothing; a new rev brings the new photo', async () => {
      await page.evaluate(() => { document.querySelector('.cell[data-widget="photos"] .ph-frame').phMark = 1; });
      const before = PI.lists;
      await page.evaluate(() => { window.HUB_PHOTOS.refresh(); });
      await until(() => PI.lists > before, 4000, 'no refetch');
      await sleep(300);
      const kept = await page.evaluate(() => !!document.querySelector('.cell[data-widget="photos"] .ph-frame').phMark);
      assert(kept, 'the frame was redrawn for the same rev');
      PI.items = [EXTRA].concat(PHOTOS);
      PI.rev = 'r2';
      await page.evaluate(() => window.HUB_PHOTOS.refresh());
      await until(() => page.evaluate(() => window.HUB_PHOTOS.state().count === 8), 4000, 'the new list did not arrive');
      PI.items = PHOTOS.slice();
      PI.rev = 'r3';
      await page.evaluate(() => window.HUB_PHOTOS.refresh());
      await until(() => page.evaluate(() => window.HUB_PHOTOS.state().count === 7), 4000, 'the list did not go back');
    });

    await check('OK opens straight to full screen: thumbnails by month (inline blocks), arrows move focus', async () => {
      await page.evaluate(() => window.HUB_TEST.openPanel('photos'));
      await until(() => page.evaluate(() => window.HUB_TEST.open() === 'photos' && window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && document.querySelectorAll('#panel .ph-thumb').length === 7), 6000, 'the grid did not open');
      await sleep(600);
      const g = await page.evaluate(() => ({
        months: Array.prototype.map.call(document.querySelectorAll('#panel .ph-month'), (e) => e.textContent),
        display: getComputedStyle(document.querySelector('#panel .ph-thumb')).display,
        focus: (document.querySelector('#panel .ph-thumb.is-focused') || {}).getAttribute ? document.querySelector('#panel .ph-thumb.is-focused').getAttribute('data-i') : null,
        loaded: document.querySelectorAll('#panel .ph-thumb.is-loaded').length,
        sub: (document.querySelector('#panel .panel-sub') || {}).textContent
      }));
      assert(g.months.join('|') === 'November 2026|October 2026|August 2026', g.months.join('|'));
      assert(g.display === 'inline-block' && g.focus === '0', JSON.stringify(g));
      assert(g.loaded >= 6 && g.sub === '7 photos', JSON.stringify(g));
      await key(page, 'ArrowRight');
      const f = await page.evaluate(() => document.querySelector('#panel .ph-thumb.is-focused').getAttribute('data-i'));
      assert(f === '1', 'focus ' + f);
      await shot(page, '04-grid');
    });

    await check('OK opens the viewer ("2 of 7"); Right and Left go on and back; a tap on a half too; Back: the grid on the same photo, then closed', async () => {
      await key(page, 'Enter');
      await until(() => page.evaluate(() => { const c = document.querySelector('#panel .ph-view-count'); return c && c.textContent === '2 of 7' && document.querySelector('#panel .ph-viewer .ph-layer.is-on'); }), 5000, 'no viewer');
      await sleep(500);
      const v = await page.evaluate(() => {
        const on = document.querySelector('#panel .ph-viewer .ph-layer.is-on');
        return { id: on.getAttribute('data-id'), fit: on.getAttribute('data-fit'), month: document.querySelector('#panel .ph-view-month').textContent,
          hint: (document.querySelector('#panel .panel-hint') || {}).textContent || '' };
      });
      assert(v.id === 'p6' && v.fit === 'contain' && v.month === 'November 2026', JSON.stringify(v));
      await shot(page, '05-viewer');
      await key(page, 'ArrowRight');
      await until(() => page.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '3 of 7'), 3000, 'Right did nothing');
      await key(page, 'ArrowLeft', 2);
      await until(() => page.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '1 of 7'), 3000, 'Left did nothing');
      await key(page, 'ArrowLeft');
      await until(() => page.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '7 of 7'), 3000, 'Left from the first does not wrap');
      const r = await page.evaluate(() => { const b = document.querySelector('#panel .ph-viewer').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
      await page.mouse.click(r.x + r.w * 0.85, r.y + r.h * 0.5);
      await until(() => page.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '1 of 7'), 3000, 'a tap on the right half did nothing');
      await page.mouse.click(r.x + r.w * 0.15, r.y + r.h * 0.5);
      await until(() => page.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '7 of 7'), 3000, 'a tap on the left half did nothing');
      await key(page, 'ArrowRight', 2);
      await key(page, 'Escape');
      await until(() => page.evaluate(() => { const f = document.querySelector('#panel .ph-thumb.is-focused'); return f && f.getAttribute('data-i') === '1' && !document.querySelector('#panel .ph-viewer'); }), 4000, 'Back did not go to the grid on the photo');
      assert(await page.evaluate(() => window.HUB_TEST.open() === 'photos'), 'Back closed it all');
      await key(page, 'Escape');
      await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 5000, 'the second Back did not close');
    });
    await close(page);

    // The tile's video, if any: { id, playing, ended, muted, src }.
    const clipState = (p) => p.evaluate(() => {
      const v = document.querySelector('.cell[data-widget="photos"] .ph-frame video');
      if (!v) return null;
      const lay = v.parentNode;
      return { id: lay.getAttribute('data-id'), on: / is-on/.test(' ' + lay.className), playing: / is-playing/.test(' ' + v.className),
        ended: v.ended, muted: v.muted, inline: v.hasAttribute('playsinline'), loop: v.loop, fit: getComputedStyle(v).objectFit, t: v.currentTime };
    });

    await check('Live photo on the tile: the still first, the clip plays ONCE (muted, inline, no loop), then the next photo; the video is freed', async () => {
      if (!PI.clip) { console.log('      (no ffmpeg here: live photo checks skipped)'); return; }
      PI.items = [PHOTOS[0], VIDEO, PHOTOS[1]];
      PI.rev = 'rv1';
      const p = await open({ seconds: 3 });
      await until(async () => (await tileState(p)).id === 'v1', 8000, 'the video item never came up');
      const still = await tileState(p);
      assert(still.fit === 'contain' && still.fill, 'the still: ' + JSON.stringify(still));
      const playing = await until(async () => { const c = await clipState(p); return c && c.playing ? c : false; }, 6000, 'the clip did not play');
      assert(playing.id === 'v1' && playing.muted && playing.inline && !playing.loop && playing.fit === 'contain', JSON.stringify(playing));
      assert((await p.evaluate(() => window.HUB_PHOTOS.state().clipping)), 'not marked as playing');
      await shot(p, '11-live-photo-playing');
      // It moves on only after the clip ended (2 s), not on the 3 s timer counted from the still.
      await until(async () => { const c = await clipState(p); return c && c.ended; }, 6000, 'the clip did not end');
      const atEnd = await tileState(p);
      assert(atEnd.id === 'v1', 'left before the end: ' + atEnd.id);
      await until(async () => (await tileState(p)).id === 'p6', 4000, 'did not move on after the clip');
      await until(async () => !(await clipState(p)), 4000, 'the video element was not freed');
      // Wraps round: p7 (3 s), then the clip plays again, once.
      await until(async () => { const c = await clipState(p); return c && c.playing; }, 12000, 'the clip did not play the second time round');
      await close(p);
      PI.items = PHOTOS.slice();
      PI.rev = 'r4';
    });

    await check('The tablet Slideshow plays a live photo once, then moves on', async () => {
      if (!PI.clip) return;
      PI.items = [VIDEO, PHOTOS[1]];
      PI.rev = 'rv4';
      const p = await open({ seconds: 3, layout: [{ widget: 'today', x: 0, y: 0, w: 3, h: 2 }] });
      await p.evaluate(() => {
        const box = document.createElement('div');
        box.id = 'ss';
        box.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:99';
        document.body.appendChild(box);
        window.ssRun = window.HUB_PHOTOS.slideshow(box, { getJSON: function (u, ms, cb) { fetch(u).then((r) => r.json()).then((d) => cb(null, d), (e) => cb(e)); } });
      });
      await until(() => p.evaluate(() => { const v = document.querySelector('#ss video.is-playing'); return v && v.muted; }), 8000, 'no clip in the slideshow');
      await until(() => p.evaluate(() => { const on = document.querySelector('#ss .ph-layer.is-on'); return on && on.getAttribute('data-id') === 'p6'; }), 8000, 'did not move on');
      await p.evaluate(() => window.ssRun.stop());
      await close(p);
      PI.items = PHOTOS.slice();
      PI.rev = 'r7';
    });

    await check('A clip that will not load: the still stays up for the usual time, then the next photo; no error box', async () => {
      if (!PI.clip) return;
      PI.items = [VIDEO, PHOTOS[1]];
      PI.rev = 'rv2';
      PI.clipOff = true;
      const p = await open({ seconds: 3 });
      await until(async () => (await tileState(p)).id === 'v1', 8000, 'no still');
      const t0 = Date.now();
      await until(async () => (await tileState(p)).id === 'p6', 9000, 'stuck on the still');
      assert(Date.now() - t0 > 1500, 'moved on too soon');
      const s = await tileState(p);
      assert(!s.error, 'error box');
      await close(p);
      PI.clipOff = false;
      PI.items = PHOTOS.slice();
      PI.rev = 'r5';
    });

    await check('Live photo in full screen: a play mark and "Video from November 2026" on its thumb; the viewer plays it once', async () => {
      if (!PI.clip) return;
      PI.items = [PHOTOS[0], VIDEO, PHOTOS[1], PHOTOS[3]];
      PI.rev = 'rv3';
      const p = await open({ seconds: 60 });
      await p.evaluate(() => window.HUB_TEST.openPanel('photos'));
      await until(() => p.evaluate(() => document.querySelectorAll('#panel .ph-thumb').length === 4 && !window.HUB_TEST.busy()), 6000, 'no grid');
      await sleep(500);
      const g = await p.evaluate(() => {
        const cells = document.querySelectorAll('#panel .ph-thumb');
        const v = cells[1];
        const mark = v.querySelector('.ph-play');
        const r = mark && mark.getBoundingClientRect();
        const cr = v.getBoundingClientRect();
        return { label: v.getAttribute('aria-label'), mark: !!mark, inside: !!r && r.right <= cr.right && r.top >= cr.top && r.width > 10,
          others: document.querySelectorAll('#panel .ph-play').length, photoLabel: cells[0].getAttribute('aria-label') };
      });
      assert(g.mark && g.inside && g.others === 1 && g.label === 'Video from November 2026' && g.photoLabel === 'Photo from November 2026', JSON.stringify(g));
      await key(p, 'ArrowRight');
      await shot(p, '12-grid-live-photo');
      if (SHOTS) {
        // Before/after of the one thing that changed: the play mark on the thumb.
        const r = await p.evaluate(() => { const b = document.querySelector('#panel .ph-row').getBoundingClientRect(); return { x: b.left - 24, y: b.top - 70, width: b.width + 48, height: b.height + 70 }; });
        await p.screenshot({ path: path.join(SHOTS, '13-grid-row-after.png'), clip: r });
        await p.evaluate(() => document.querySelectorAll('#panel .ph-play').forEach((e) => { e.style.display = 'none'; }));
        await p.screenshot({ path: path.join(SHOTS, '13-grid-row-before.png'), clip: r });
        await p.evaluate(() => document.querySelectorAll('#panel .ph-play').forEach((e) => { e.style.display = ''; }));
      }
      await key(p, 'Enter');
      const v = await until(() => p.evaluate(() => {
        const el = document.querySelector('#panel .ph-viewer video.is-playing');
        return el ? { muted: el.muted, loop: el.loop } : false;
      }), 6000, 'the viewer did not play the clip');
      assert(v.muted && !v.loop, JSON.stringify(v));
      // Ends and stays on its last frame (the viewer does not move on by itself).
      await until(() => p.evaluate(() => { const el = document.querySelector('#panel .ph-viewer video'); return el && el.ended; }), 6000, 'did not end');
      assert(await p.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '2 of 4'), 'the viewer moved on');
      await key(p, 'ArrowRight');
      await until(() => p.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '3 of 4'), 3000, 'Right did nothing');
      await until(() => p.evaluate(() => !document.querySelector('#panel .ph-viewer video')), 4000, 'the viewer kept the old video');
      // Spanish: "Vídeo de ..."
      await p.evaluate(() => window.HUB_I18N.setLang('es'));
      await key(p, 'Escape');
      await until(() => p.evaluate(() => { const c = document.querySelectorAll('#panel .ph-thumb')[1]; return c && /^Vídeo de noviembre de 2026$|^Vídeo de Noviembre de 2026$/.test(c.getAttribute('aria-label')); }), 4000, 'no Spanish label');
      await close(p);
      PI.items = PHOTOS.slice();
      PI.rev = 'r6';
    });

    await check('Viewer: a clip that would not start shows a big play mark; a tap in the middle plays it (inside the tap); OK then goes on', async () => {
      if (!PI.clip) return;
      PI.items = [PHOTOS[0], VIDEO, PHOTOS[1]];
      PI.rev = 'rv4';
      PI.clipOff = true;
      const p = await open({ seconds: 60 });
      await p.evaluate(() => window.HUB_TEST.openPanel('photos'));
      await until(() => p.evaluate(() => document.querySelectorAll('#panel .ph-thumb').length === 3 && !window.HUB_TEST.busy()), 6000, 'no grid');
      await key(p, 'ArrowRight');
      await key(p, 'Enter');
      // It tries twice by itself, then waits with the mark up.
      await until(() => p.evaluate(() => { const v = document.querySelector('#panel .ph-viewer.is-paused .ph-view-play'); return v && getComputedStyle(v).opacity === '1'; }), 8000, 'no play mark');
      assert(!(await p.evaluate(() => document.querySelector('#panel .ph-viewer video'))), 'a dead video was left');
      if (SHOTS) {
        const r = await p.evaluate(() => { const b = document.querySelector('#panel .ph-viewer').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
        await p.screenshot({ path: path.join(SHOTS, '14-viewer-play-after.png'), clip: r });
        await p.evaluate(() => { document.querySelector('#panel .ph-view-play').style.display = 'none'; });
        await p.screenshot({ path: path.join(SHOTS, '14-viewer-play-before.png'), clip: r });
        await p.evaluate(() => { document.querySelector('#panel .ph-view-play').style.display = ''; });
      }
      PI.clipOff = false;
      const box = await p.evaluate(() => { const b = document.querySelector('#panel .ph-viewer').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      await p.mouse.click(box.x, box.y);
      await until(() => p.evaluate(() => document.querySelector('#panel .ph-viewer video.is-playing')), 6000, 'the tap did not play it');
      assert(await p.evaluate(() => !document.querySelector('#panel .ph-viewer.is-paused') && document.querySelector('#panel .ph-view-count').textContent === '2 of 3'), 'mark still up, or moved on');
      await until(() => p.evaluate(() => { const el = document.querySelector('#panel .ph-viewer video'); return el && el.ended && document.querySelector('#panel .ph-viewer.is-paused'); }), 6000, 'no replay mark at the end');
      // After it played, OK goes on.
      await key(p, 'Enter');
      await until(() => p.evaluate(() => document.querySelector('#panel .ph-view-count').textContent === '3 of 3' && !document.querySelector('#panel .ph-viewer.is-paused')), 3000, 'OK did not go on');
      await close(p);
      PI.items = PHOTOS.slice();
      PI.rev = 'r7';
    });

    await check('Random order by default: every photo once per pass, never the same twice in a row', async () => {
      const p = await open({ seconds: 60, order: 'shuffle' });
      const seen = [await p.evaluate(() => window.HUB_PHOTOS.state().index)];
      for (let k = 0; k < 13; k++) {
        await p.evaluate(() => window.HUB_PHOTOS.advance());
        seen.push(await p.evaluate(() => window.HUB_PHOTOS.state().index));
        await sleep(60);
      }
      const first = seen.slice(0, 7);
      assert(new Set(first).size === 7, 'first pass ' + seen.join(','));
      for (let k = 1; k < seen.length; k++) assert(seen[k] !== seen[k - 1], 'twice in a row ' + seen.join(','));
      assert(seen.join(',') !== '0,1,2,3,4,5,6,0,1,2,3,4,5,6', 'not shuffled');
      await close(p);
    });

    await check('No photos: a quiet "No photos yet" with a hint; the grid says so too; no error box', async () => {
      PI.mode = 'empty';
      const p = await open({});
      const t = await p.evaluate(() => document.querySelector('.cell[data-widget="photos"]').innerText);
      assert(/No photos yet/.test(t) && /friends share/.test(t), t);
      assert(!(await p.evaluate(() => document.querySelector('.cell[data-widget="photos"] .tile-error, .cell[data-widget="photos"] .widget-error'))), 'error box');
      await shot(p, '08-empty');
      await p.evaluate(() => window.HUB_TEST.openPanel('photos'));
      await until(() => p.evaluate(() => /No photos yet/.test((document.querySelector('#panel .ph-panel') || {}).innerText || '')), 5000, 'the panel does not say so');
      await close(p);
      PI.mode = 'ok';
    });

    await check('No Pi: "Photos live on the Pi", calm, no error box', async () => {
      PI.mode = 'down';
      const p = await open({});
      const t = await p.evaluate(() => document.querySelector('.cell[data-widget="photos"]').innerText);
      assert(/Photos live on the Pi/.test(t), t);
      await shot(p, '09-no-pi');
      await close(p);
      PI.mode = 'ok';
    });

    const SIZES = [[1, 1], [3, 1], [3, 2], [6, 4]];
    for (const lang of ['en', 'es']) {
      await check('Sizes 1x1, 3x1, 3x2, 6x4 in ' + (lang === 'es' ? 'Spanish +25% (Á É ñ ¿ ¡)' : 'English') + ', with photos and empty: nothing outside its box, line-height 1.3+', async () => {
        const bad = [];
        for (const mode of ['ok', 'empty']) {
          PI.mode = mode;
          const layout = [{ widget: 'today', x: 0, y: 0, w: 3, h: 1 }];
          // one photos tile per page: each size is its own open
          for (const z of SIZES) {
            const p = await open({ lang, grow: lang === 'es', layout: [{ widget: 'photos', x: 3, y: 1, w: z[0], h: z[1] }].concat(layout) });
            if (mode === 'ok') await until(async () => (await tileState(p)).on, 6000, 'no photo at ' + z.join('x'));
            const probs = await textProblems(p, '.cell[data-widget="photos"] .ph-frame');
            probs.forEach((x2) => bad.push(z.join('x') + ' ' + mode + ': ' + x2));
            if (mode === 'ok') {
              const s = await tileState(p);
              if (z[0] === 1 && s.caption) {
                const shown = await p.evaluate(() => !!document.querySelector('.cell[data-widget="photos"] .ph-cap'));
                if (shown) bad.push('1x1 has a caption');
              }
              if (lang === 'es' && z[0] > 1 && !/^Noviembre de 2026/.test(s.caption)) bad.push('caption ' + s.caption);
            }
            if (SHOTS && lang === 'en' && mode === 'ok') await shot(p, '03-tile-' + z.join('x'));
            if (SHOTS && lang === 'es' && mode === 'empty' && z[0] === 3 && z[1] === 2) await shot(p, '10-empty-es-3x2');
            await close(p);
          }
        }
        PI.mode = 'ok';
        assert(!bad.length, bad.join('; '));
      });
    }

    await check('Spanish +25%: the Photos layout, grid and viewer; texts inside, "2 de 7", the Back chip', async () => {
      const p = await open({ lang: 'es', grow: true });
      await until(async () => (await tileState(p)).on, 6000, 'no photo');
      await shot(p, '07-photos-layout-es');
      await p.evaluate(() => window.HUB_TEST.openPanel('photos'));
      await until(() => p.evaluate(() => document.querySelectorAll('#panel .ph-thumb').length === 7 && !window.HUB_TEST.busy()), 6000, 'no grid');
      await sleep(500);
      const months = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .ph-month'), (e) => e.textContent).join('|'));
      const want = ['Noviembre de 2026', 'Octubre de 2026', 'Agosto de 2026'];
      assert(months.split('|').every((m, i) => m.indexOf(want[i]) === 0), months);
      let probs = await textProblems(p, '#panel .ph-panel');
      await shot(p, '06-grid-es');
      await key(p, 'ArrowRight');
      await key(p, 'Enter');
      await until(() => p.evaluate(() => { const c = document.querySelector('#panel .ph-view-count'); return c && /^2 de 7/.test(c.textContent) && document.querySelector('#panel .ph-viewer .ph-layer.is-on'); }), 5000, 'no viewer');
      await sleep(500);
      probs = probs.concat(await textProblems(p, '#panel .ph-viewer'));
      const hint = await p.evaluate(() => (document.querySelector('#panel .panel-hint') || {}).textContent || '');
      await shot(p, '06-viewer-es');
      assert(!probs.length, probs.join('; '));
      assert(/Atrás para ver todas las fotos/.test(hint), 'hint: ' + hint);
      await close(p);
    });

    if (SHOTS) {
      await check('Shots: the Main layout before and after (it has no Photos tile and must look the same)', async () => {
        const MAIN = (() => { const cb = {}; vm.runInNewContext(CONFIG + '\nthis.cfg = HUB_CONFIG;', cb); return cb.cfg.layouts.filter((l) => l.id === 'main')[0].layout; })();
        const a = await open({ layout: MAIN, choice: 'main', without: true });
        await shot(a, '01-main-before');
        await close(a);
        const b = await open({ layout: MAIN, choice: 'main' });
        await shot(b, '01-main-after');
        await close(b);
      });
    }
  } finally {
    await env.browser.close();
    env.preview.kill();
    env.pi.close();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('FAIL  ' + (e && e.stack));
  try { env.preview.kill(); } catch (x) { /* ignore */ }
  try { env.pi.close(); } catch (x) { /* ignore */ }
  process.exit(1);
});
