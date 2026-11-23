/*
 * Pantry and List on the TV (app/widgets/pantry-tv.js, pantry-tv.css): node dev/pantry-tv-test.js
 *
 * Runs the real hub in headless Chromium against the preview (needs port
 * 8095 free, like the other browser tests). The widgets run on the mock data
 * in HUB_PANTRY_TV.api (the Pi's pantry routes are not built yet), so no Pi
 * server is started. Nothing here reaches the internet. Checks:
 *
 *   - pantry-tv.js is plain ES5 and Node can require its logic; the CSS has no
 *     grid, no flex gap, animates only transform and opacity and ends with
 *     .css-end; hub.html loads both before hub.js; every pantry.* key the
 *     file uses has Spanish; the Groceries layout is Pantry left, List right.
 *   - The logic: the pantry is a filter (owned, not archived), 0 left = out,
 *     the field checks, the brand key, auto-add on a save.
 *   - The Groceries layout in English and in Spanish with every pantry text
 *     25% longer (Á É ñ ¿ ¡), and each tile at 1x1, 3x1, 3x2 and 6x6: what
 *     each size shows, nothing outside the tile, nothing cut sideways but a
 *     name, every text line at least 1.3 times its type.
 *   - The panel: Out rows carry an Out chip; OK on a row in the small panel
 *     goes full screen with the product page; + and - change Remaining and
 *     the tile follows; a pill picks the unit; a number box saves on Enter;
 *     a bad number is a toast and changes nothing; Back closes the page with
 *     focus on the row it came from, Back again shrinks to the panel.
 *   - From the List: OK on a row opens that product; Remaining to 0 on a
 *     product with auto-add puts it on the list (Auto chip).
 *   - The product page in Spanish +25%: nothing cut or outside the screen.
 *
 * --shots <folder> (or PANTRY_SHOTS) saves pictures at device scale 2: the
 * Groceries layout, both panels and the product page in English and Spanish.
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
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.PANTRY_SHOTS || '');
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

/* Spanish 25% longer: every pantry text grown (with Á, É, ñ, ¿, ¡). */
const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚÁÉñ¿¡áéíóú";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k) || !/^pantry\\./.test(k) || /^pantry\\.unit\\./.test(k)) continue;' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.replace(/\\{\\w+\\}/g, "").length * 0.25)); es[k] = s + add.slice(0, n); } })();\n';

const GROCERIES = [{ widget: 'pantry', x: 0, y: 0, w: 6, h: 6 }, { widget: 'list', x: 6, y: 0, w: 6, h: 6 }];
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
  if (o.grow) await context.route(/\/i18n\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: I18N + GROW }));
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('pn-seeded')) return;
      sessionStorage.setItem('pn-seeded', '1');
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, { 'homeHub.layout': JSON.stringify(o.layout || GROCERIES), 'homeHub.layoutChoice': JSON.stringify({ id: 'groceries', piSig: '' }), 'homeHub.lang': o.lang || 'en' });
  await page.goto(env.PAGE + '/?motion=fade&clay=off&live=off' + (o.lang ? '&lang=' + o.lang : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell .pn-tile:not(.hub-dormant)'), null, { timeout: 15000 });
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(500);
  page.ctx = context;
  return page;
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) { await page.keyboard.press(k); await sleep(120); }
}
async function openPanel(page, id) {
  assert(await page.evaluate((w) => window.HUB_TEST.openPanel(w), id), 'no panel');
  await until(() => page.evaluate((w) => window.HUB_TEST.open() === w && !window.HUB_TEST.busy() && !!document.querySelector('#panel .pn-panel'), id), 5000, 'the panel did not open');
  await sleep(300);
}
async function settle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'busy');
  await sleep(250);
}
function focused(page) {
  return page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || 'hub' : ''; });
}
async function focusKey(page, k) {
  // Step toward the element with data-key k with the arrows, as a person would.
  for (let i = 0; i < 40; i++) {
    const dir = await page.evaluate((want) => {
      const f = document.querySelector('#panel .is-focused');
      const t = document.querySelector('#panel [data-key="' + want + '"]');
      if (!t) return 'missing';
      if (f === t) return '';
      if (!f) return 'ArrowDown';
      const a = f.getBoundingClientRect(), b = t.getBoundingClientRect();
      const dy = (b.top + b.bottom) / 2 - (a.top + a.bottom) / 2, dx = (b.left + b.right) / 2 - (a.left + a.right) / 2;
      if (Math.abs(dy) > Math.min(a.height, b.height) / 2) return dy > 0 ? 'ArrowDown' : 'ArrowUp';
      return dx > 0 ? 'ArrowRight' : 'ArrowLeft';
    }, k);
    if (!dir) return;
    assert(dir !== 'missing', 'no ' + k);
    await key(page, dir);
  }
  assert(await focused(page) === k, 'never reached ' + k + ' (at ' + await focused(page) + ')');
}
function toast(page) { return page.evaluate(() => { const t = document.getElementById('toast'); return t ? t.textContent : ''; }); }
function product(page, id) { return page.evaluate((i) => window.HUB_PANTRY_TV.productById(window.HUB_PANTRY_TV.api.snapshot(), i), id); }

/* Every fit problem inside root (a tile or the panel). */
function measure(page, sel) {
  return page.evaluate((s) => {
    const box = document.querySelector(s);
    const b = box.getBoundingClientRect();
    const problems = [];
    const shown = (el) => { for (let e = el; e && e !== box; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false; return true; };
    box.querySelectorAll('*').forEach((el) => {
      if (!shown(el) || el.closest('svg') || el.tagName === 'INPUT') return;
      const own = [].some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const name = el.className + ' "' + el.textContent.slice(0, 24) + '"';
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || (r.bottom > b.bottom + 0.5 && s.indexOf('.tile') >= 0)) problems.push(name + ' is outside');
      const named = /\bpn-(t?name|meta)\b/.test(el.className) || el.closest('.pn-tname');
      if (!named && cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 1 && (el.closest('.tile-body') || el.closest('.panel-body'))) problems.push(name + ' is cut sideways');
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      if (lh && lh < fs * 1.3 - 0.3 && !/pn-hero-num|pn-one-num/.test(el.className)) problems.push(name + ' line-height ' + (lh / fs).toFixed(2));
    });
    return { problems: problems, text: box.innerText.replace(/\s+/g, ' ').trim() };
  }, sel);
}

async function shot(page, file, sel) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!sel) { await page.screenshot({ path: path.join(SHOTS, file) }); return; }
  const box = await page.locator(sel).first().boundingBox();
  const pad = 8;
  await page.screenshot({ path: path.join(SHOTS, file), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
}

async function main() {
  env.PAGE_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', LIGHTS_MODE: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();

  try {
    await check('pantry-tv.js is plain ES5 and a Node module; hub.html loads it and pantry-tv.css before hub.js; every pantry.* key has Spanish', () => {
      let acorn = null;
      for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
        try { acorn = require(p); break; } catch (e) { /* next */ }
      }
      const text = fs.readFileSync(path.join(ROOT, 'app/widgets/pantry-tv.js'), 'utf8');
      if (acorn) acorn.parse(text, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
      const P = require('../app/widgets/pantry-tv.js');
      assert(typeof P.clean === 'function' && typeof P.api.saveProduct === 'function', 'the logic is not exported');
      const hub = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      assert(hub.indexOf('widgets/pantry-tv.js') > 0 && hub.indexOf('widgets/pantry-tv.css') > 0, 'hub.html');
      assert(hub.indexOf('widgets/pantry-tv.js') < hub.indexOf('src="hub.js"'), 'pantry.js after hub.js');
      const box = { window: {}, location: { search: '' } };
      box.window = box;
      vm.runInNewContext(I18N, box);
      const es = box.HUB_I18N.strings.es;
      const keys = {};
      let m;
      const re = /tr\('(pantry\.[\w.]+)'/g;
      while ((m = re.exec(text))) if (!/\.$/.test(m[1])) keys[m[1]] = 1;
      ['pantry.title', 'pantry.titleShort', 'pantry.listTitle', 'pantry.listTitleShort'].forEach((k) => { keys[k] = 1; });
      P.UNITS.forEach((u) => { keys['pantry.unit.' + u] = 1; });
      P.LOCATIONS.forEach((u) => { keys['pantry.loc.' + u] = 1; });
      P.MODES.forEach((u) => { keys['pantry.mode.' + u] = 1; });
      const missing = Object.keys(keys).filter((k) => !es[k]);
      assert(Object.keys(keys).length > 50, 'only ' + Object.keys(keys).length + ' keys found');
      assert(!missing.length, 'no Spanish for ' + missing.join(', '));
      assert(es['hub.layout.groceries'], 'no Spanish layout name');
    });

    await check('pantry-tv.css: no grid, no flex gap, only transform and opacity animate, ends with .css-end; the Groceries layout is Pantry left, List right', () => {
      const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'pantry-tv.css'), 'utf8');
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/display\s*:\s*(inline-)?grid|grid-template/.test(bare), 'CSS grid');
      assert(!/(^|[\s;{])(row-|column-)?gap\s*:/.test(bare), 'flex gap');
      assert(!/oklch|dvh|filter\s*:/.test(bare), 'oklch, dvh or a filter');
      assert(!/transition\s*:|@(-webkit-)?keyframes/.test(bare), 'an animation');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'no .css-end at the end');
      const box = {};
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/config.js'), 'utf8') + '\nthis.cfg = HUB_CONFIG;', box);
      const g = box.cfg.layouts.filter((l) => l.id === 'groceries')[0];
      assert(g && g.name === 'Groceries', 'no Groceries layout');
      assert(JSON.stringify(g.layout) === JSON.stringify(GROCERIES), JSON.stringify(g.layout));
    });

    await check('logic: the pantry is a filter of products, 0 left is out, fields are checked, brands match by key, a save can auto-add', async () => {
      const P = require('../app/widgets/pantry-tv.js');
      P.reset();
      const d = P.api.snapshot();
      const pan = P.pantryOf(d.products);
      assert(pan.every((p) => p.owned && !p.archived), 'an unowned product in the pantry');
      assert(pan.length === d.products.filter((p) => p.owned).length && pan.length < d.products.length, 'pantry ' + pan.length);
      assert(P.stateOf(pan[0]) === 'out', 'out first: ' + pan[0].name);
      const c = P.pantryCounts(d.products);
      assert(c.out === pan.filter((p) => p.quantity_remaining === 0).length && c.low > 0, JSON.stringify(c));
      assert(P.clean('size', '15.5').value === 15.5 && P.clean('size', '').value === null && P.clean('size', '-1').error, 'size');
      assert(P.clean('purchase_quantity', '2').value === 2 && P.clean('purchase_quantity', '1.5').error && P.clean('purchase_quantity', '0').error, 'purchase quantity');
      assert(P.clean('quantity_remaining', '0').value === 0 && P.clean('quantity_remaining', 'x').error, 'remaining');
      assert(P.clean('unit', 'fl_oz').value === 'fl_oz' && P.clean('unit', 'cup').error, 'unit');
      assert(P.clean('substitution_mode', 'contact_me').value && P.clean('location', 'garage').error, 'enums');
      assert(P.clean('name', '  ').error === 'name', 'empty name');
      assert(P.brandKey('Rao’s') === P.brandKey('raos') && P.brandKey('Héinz') === 'heinz', 'brand key');
      const spaghetti = d.products.filter((p) => p.name === 'Spaghetti')[0];
      const before = d.list.items.length;
      await new Promise((r) => P.api.saveProduct(spaghetti.id, { quantity_remaining: 0, brand: 'barilla' }, r));
      const after = P.api.snapshot();
      const row = after.list.items.filter((i) => i.product_id === spaghetti.id)[0];
      assert(after.list.items.length === before + 1 && row && row.source === 'auto' && row.quantity === spaghetti.purchase_quantity, 'no auto row');
      assert(P.productById(after, spaghetti.id).brand_id === spaghetti.brand_id && after.brands.length === d.brands.length, 'barilla made a second brand');
      await new Promise((r) => P.api.saveProduct(spaghetti.id, { quantity_remaining: 0 }, r));
      assert(P.api.snapshot().list.items.length === before + 1, 'a second auto row');
    });

    for (const v of [{ name: 'English', lang: 'en' }, { name: 'Spanish +25%', lang: 'es', grow: true }]) {
      await check('Groceries layout and each tile at 1x1, 3x1, 3x2, 6x6 in ' + v.name + ': what each size shows, nothing outside or clipped', async () => {
        const page = await open({ lang: v.lang, grow: v.grow });
        const out = [];
        const es = v.lang === 'es';
        const rects = await page.evaluate(() => ['pantry', 'list'].map((w) => document.querySelector('.cell[data-widget="' + w + '"]').getBoundingClientRect().left));
        if (!(rects[0] < rects[1])) out.push('pantry is not left of list');
        for (const w of ['pantry', 'list']) {
          const r = await measure(page, '.cell[data-widget="' + w + '"] .tile');
          if (r.problems.length) out.push('6x6 ' + w + ': ' + r.problems.slice(0, 3).join(', '));
          if (w === 'pantry' && !(es ? /en la despensa/ : /in the pantry/).test(r.text)) out.push('pantry 6x6: ' + r.text.slice(0, 60));
          if (w === 'pantry' && !(es ? /Agotado/ : /\bOut\b/).test(r.text)) out.push('pantry 6x6 has no Out chip');
          if (w === 'list' && !(es ? /8 por comprar/ : /8 to buy/).test(r.text)) out.push('list 6x6: ' + r.text.slice(0, 60));
        }
        for (const s of [[1, 1], [3, 1], [3, 2]]) {
          await page.evaluate((l) => { localStorage.setItem('homeHub.layout', JSON.stringify(l)); },
            [{ widget: 'pantry', x: 0, y: 0, w: s[0], h: s[1] }, { widget: 'list', x: 6, y: 0, w: s[0], h: s[1] }]);
          await page.reload();
          await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('.cell .pn-tile:not(.hub-dormant)').length === 2, null, { timeout: 15000 });
          await sleep(700);
          for (const w of ['pantry', 'list']) {
            const r = await measure(page, '.cell[data-widget="' + w + '"] .tile');
            const where = s[0] + 'x' + s[1] + ' ' + w;
            if (r.problems.length) out.push(where + ': ' + r.problems.slice(0, 3).join(', '));
            const body = await page.evaluate((x) => document.querySelector('.cell[data-widget="' + x + '"] .tile-body').innerText.replace(/\s+/g, ' ').trim(), w);
            if (s[0] === 1 && body !== (w === 'pantry' ? '5' : '8')) out.push(where + ': "' + body + '"');
            if (s[1] === 1 && s[0] > 1 && !(w === 'pantry' ? (es ? /5 agotados/ : /5 out/) : (es ? /8 por comprar/ : /8 to buy/)).test(body)) out.push(where + ': "' + body + '"');
            if (s[1] === 2 && !/\+\d+/.test(body)) out.push(where + ': no "+N more" in "' + body.slice(0, 60) + '"');
          }
        }
        assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
        await page.ctx.close();
        assert(!out.length, out.join('; '));
      });
    }

    const page = await open({});

    await check('pantry panel: rows grouped Out, Running low, In stock; Out rows carry an Out chip; focus on the first row', async () => {
      await openPanel(page, 'pantry');
      const s = await page.evaluate(() => ({
        secs: [].map.call(document.querySelectorAll('#panel .pn-sec-name'), (n) => n.textContent),
        outChips: document.querySelectorAll('#panel .pn-sec-out .pn-row .pn-chip-out').length,
        outRows: document.querySelectorAll('#panel .pn-sec-out .pn-row').length,
        mock: !!document.querySelector('#panel .pn-mock')
      }));
      assert(s.secs.join() === 'Out,Running low,In stock', s.secs.join());
      assert(s.outRows === 5 && s.outChips === 5, JSON.stringify(s));
      assert(s.mock, 'no sample-data note');
      assert(/^prod:\d+$/.test(await focused(page)), 'focus ' + await focused(page));
    });

    await check('OK on a row in the small panel goes full screen with that product page', async () => {
      const k = await focused(page);
      await key(page, 'Enter');
      await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !!document.querySelector('#panel .pn-page')), 4000, 'no page');
      await settle(page);
      const want = await product(page, Number(k.slice(5)));
      const name = await page.evaluate(() => document.querySelector('#panel .pn-ph-name').textContent);
      assert(name === want.name, name + ' vs ' + want.name);
      const keys = await page.evaluate(() => [].map.call(document.querySelectorAll('#panel .pn-page .f'), (n) => n.getAttribute('data-key')));
      ['in:brand', 'in:name', 'in:size', 'pick:unit:fl_oz', 'in:quantity_remaining', 'in:restock_at', 'in:purchase_quantity', 'pick:auto_add:1', 'pick:auto_add:0',
        'pick:substitution_mode:contact_me', 'pick:location:freezer', 'in:notes', 'step:quantity_remaining:1'].forEach((x) => assert(keys.indexOf(x) >= 0, 'no ' + x));
      assert(await focused(page) === 'in:quantity_remaining', 'focus ' + await focused(page));
      env.pageFrom = k;
    });

    await check('+ and - change Remaining at once and the tile follows; a pill picks the unit; focus stays put', async () => {
      const id = Number(env.pageFrom.slice(5));
      const was = (await product(page, id)).quantity_remaining;
      await focusKey(page, 'step:quantity_remaining:1');
      await key(page, 'Enter');
      await until(async () => (await product(page, id)).quantity_remaining === was + 1, 2000, 'not saved');
      await until(() => page.evaluate((n) => document.querySelector('#panel [data-key="in:quantity_remaining"]').value === String(n), was + 1), 2000, 'the box did not follow');
      assert(await focused(page) === 'step:quantity_remaining:1', 'focus moved to ' + await focused(page));
      const outNow = await page.evaluate(() => window.HUB_PANTRY_TV.pantryCounts(window.HUB_PANTRY_TV.api.snapshot().products).out);
      assert(outNow === 4, 'out count ' + outNow);
      await focusKey(page, 'step:quantity_remaining:-1');
      await key(page, 'Enter');
      await until(async () => (await product(page, id)).quantity_remaining === was, 2000, 'minus not saved');
      await key(page, 'Enter');
      await sleep(300);
      assert((await product(page, id)).quantity_remaining === 0, 'went below 0');
      await focusKey(page, 'pick:unit:lb');
      await key(page, 'Enter');
      await until(async () => (await product(page, id)).unit === 'lb', 2000, 'unit not saved');
      assert(await page.evaluate(() => document.querySelector('#panel [data-key="pick:unit:lb"]').className.indexOf('is-on') >= 0), 'pill not on');
    });

    await check('a number box saves on Enter; a bad number is a toast and changes nothing', async () => {
      const id = Number(env.pageFrom.slice(5));
      await focusKey(page, 'in:purchase_quantity');
      await key(page, 'Enter');
      await page.keyboard.press('Control+A');
      await page.keyboard.type('5');
      await key(page, 'Enter');
      await until(async () => (await product(page, id)).purchase_quantity === 5, 2000, 'not saved');
      await key(page, 'Enter');
      await page.keyboard.press('Control+A');
      await page.keyboard.type('2.5');
      await key(page, 'Enter');
      await until(async () => /whole number/.test(await toast(page)), 2000, 'no toast');
      assert((await product(page, id)).purchase_quantity === 5, 'changed');
      await until(() => page.evaluate(() => document.querySelector('#panel [data-key="in:purchase_quantity"]').value === '5'), 2000, 'the box kept the bad number');
    });

    await check('Back closes the page with focus on the row it came from; Back again shrinks to the panel', async () => {
      await sleep(400); // Back right after typing ends is ignored (hub.js typingEndedAt)
      if (await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'INPUT')) await key(page, 'Escape');
      await sleep(400);
      await key(page, 'Escape');
      await until(() => page.evaluate(() => !document.querySelector('#panel .pn-page') && !!document.querySelector('#panel .pn-row')), 2000, 'page still open');
      assert(await page.evaluate(() => window.HUB_TEST.mode()) === 'full', 'left full screen');
      assert(await focused(page) === env.pageFrom, 'focus ' + await focused(page) + ' not ' + env.pageFrom);
      await key(page, 'Escape');
      await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'panel'), 3000, 'not back to the panel');
      await settle(page);
      await page.evaluate(() => window.HUB_TEST.closePanel());
      await settle(page);
    });

    await check('List: OK on a row opens that product; Remaining to 0 on an auto-add product puts it on the list (Auto chip)', async () => {
      await openPanel(page, 'list');
      const k = await focused(page);
      assert(/^item:\d+$/.test(k), 'focus ' + k);
      await key(page, 'Enter');
      await until(() => page.evaluate(() => !!document.querySelector('#panel .pn-page')), 4000, 'no page');
      await settle(page);
      await key(page, 'Escape');
      await until(() => page.evaluate(() => !!document.querySelector('#panel .pn-row')), 2000, 'page still open');
      // Yogurt: 2 left, restock at 1, auto-add on, not on the list.
      const yog = await page.evaluate(() => window.HUB_PANTRY_TV.api.snapshot().products.filter((p) => p.name === 'Plain Greek yogurt')[0].id);
      const before = await page.evaluate(() => document.querySelectorAll('#panel .pn-row').length);
      await page.evaluate((id) => new Promise((r) => window.HUB_PANTRY_TV.api.saveProduct(id, { quantity_remaining: 1 }, r)), yog);
      await until(() => page.evaluate((n) => document.querySelectorAll('#panel .pn-row').length === n + 1, before), 2000, 'the list did not grow');
      assert(await page.evaluate(() => !!document.querySelector('#panel .pn-row .pn-chip-auto')), 'no Auto chip');
      assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
    });
    await page.ctx.close();

    await check('the product page in Spanish +25%: nothing cut or outside the screen', async () => {
      const p = await open({ lang: 'es', grow: true });
      await openPanel(p, 'pantry');
      await key(p, 'Enter');
      await until(() => p.evaluate(() => !!document.querySelector('#panel .pn-page')), 4000, 'no page');
      await settle(p);
      const r = await measure(p, '#panel');
      assert(!r.problems.length, r.problems.slice(0, 4).join(', '));
      const over = await p.evaluate(() => { const b = document.querySelector('#panel .pn-page').getBoundingClientRect(); return b.right > window.innerWidth + 1; });
      assert(!over, 'wider than the screen');
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    if (SHOTS) {
      await check('pictures (device scale 2): the Groceries layout, both panels, the product page, EN and ES', async () => {
        for (const lang of ['en', 'es']) {
          const p = await open({ lang: lang, scale: 2 });
          await shot(p, 'groceries-layout-' + lang + '.png');
          await openPanel(p, 'pantry');
          await sleep(600);
          await shot(p, 'pantry-panel-' + lang + '.png', '#panel');
          await key(p, 'Enter');
          await until(() => p.evaluate(() => !!document.querySelector('#panel .pn-page')), 4000, 'no page');
          await settle(p);
          await sleep(400);
          await shot(p, 'product-page-' + lang + '.png');
          await key(p, 'Escape');
          await settle(p);
          await sleep(400);
          await shot(p, 'pantry-full-' + lang + '.png');
          await key(p, 'Escape');
          await settle(p);
          await p.evaluate(() => window.HUB_TEST.closePanel());
          await settle(p);
          await openPanel(p, 'list');
          await sleep(600);
          await shot(p, 'list-panel-' + lang + '.png', '#panel');
          await p.ctx.close();
        }
      });
    }
  } finally {
    await env.browser.close();
    env.preview.kill();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
