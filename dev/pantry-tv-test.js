/*
 * Pantry and List on the TV (app/widgets/pantry-tv.js, pantry-tv.css): node dev/pantry-tv-test.js
 *
 * Runs the real hub in headless Chromium against the preview (needs port
 * 8095 free, like the other browser tests). The live line is stubbed:
 * app/live.js is served as dev/pantry-tv-live-stub.js, which sends the
 * resource "pantry" in the Pi's shape (pi/pantrydb.js view()) and answers
 * POST /pantry/screen-ops like pi/server.js. No Pi server is started and
 * nothing reaches the internet. Checks:
 *
 *   - pantry-tv.js is plain ES5 and Node can require its logic; the CSS has
 *     no grid, no flex gap, animates only transform and opacity and ends
 *     with .css-end; hub.html loads pantry-tv.js (never the phone's
 *     pantry.js) and touch.html the other way round; every pantry.* key the
 *     file uses has Spanish and no key is listed twice; the Groceries layout
 *     is Pantry left, List right.
 *   - The logic: the Pi's rows map to the widget's shape, page changes map
 *     to the Pi's ops (set, edit), a tick is shown at once (applyLocal), the
 *     list puts ticked rows last, 0 left = out, the field checks.
 *   - The Groceries layout in English and in Spanish with every pantry text
 *     25% longer (Á É ñ ¿ ¡), and each tile at 1x1, 3x1, 3x2 and 6x6: what
 *     each size shows, nothing outside the tile, nothing cut sideways but a
 *     name, every text line at least 1.3 times its type.
 *   - The panel: Out rows carry an Out chip; OK on a row in the small panel
 *     goes full screen with the product page and the Back chip says "Back
 *     for the list"; + and - post "set" and the tile follows; a pill and a
 *     number box post "edit"; a bad number is a toast and posts nothing;
 *     Back closes the page with focus on the row it came from.
 *   - The List: OK ticks a row (op "check"), it moves under In the cart,
 *     dimmed, focus on the next row, the counts follow; OK unticks it; Right
 *     then OK on Details opens the product; a refusal takes the tick back
 *     with a toast; a quantity drop on an auto-add product adds a row (Auto).
 *   - Filters: Place and Store chips on the expanded Pantry, Store chips on
 *     the List (never the tile), single pick, All clears, reset on close;
 *     each row's meta ends with its preferred store.
 *   - Spanish +25%: the product page, the chips and a ticked List, nothing cut.
 *
 * --shots <folder> (or PANTRY_SHOTS) saves pictures at device scale 2: the
 * Groceries layout, the product page and a ticked List, English and Spanish.
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
const STUB = fs.readFileSync(path.join(__dirname, 'pantry-tv-live-stub.js'), 'utf8');
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
  await context.route(/\/live\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
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
function lastOps(page) { return page.evaluate(() => { const p = window.PANTRY_STUB.posts; return p.length ? Object.assign({ path: p[p.length - 1].path }, p[p.length - 1].body) : null; }); }
function hint(page) { return page.evaluate(() => { const h = document.querySelector('#panel .panel-hint'); return h ? h.textContent : ''; }); }

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
    await check('pantry-tv.js is plain ES5 and a Node module; hub.html loads it (not the phone\'s pantry.js), touch.html the other way; every pantry.* key has Spanish, none twice', () => {
      let acorn = null;
      for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
        try { acorn = require(p); break; } catch (e) { /* next */ }
      }
      const text = fs.readFileSync(path.join(ROOT, 'app/widgets/pantry-tv.js'), 'utf8');
      if (acorn) acorn.parse(text, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
      const P = require('../app/widgets/pantry-tv.js');
      assert(typeof P.clean === 'function' && typeof P.api.saveProduct === 'function' && typeof P.api.check === 'function', 'the logic is not exported');
      assert(!/mockData|api\.mock|pantry\.mock/.test(text), 'mock data left in the widget');
      const hub = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      const touch = fs.readFileSync(path.join(ROOT, 'app/touch.html'), 'utf8');
      assert(hub.indexOf('widgets/pantry-tv.js') > 0 && hub.indexOf('widgets/pantry-tv.css') > 0, 'hub.html');
      assert(hub.indexOf('widgets/pantry.js') < 0 && touch.indexOf('widgets/pantry-tv.js') < 0 && touch.indexOf('widgets/pantry.js') > 0, 'one pantry widget per page');
      assert(hub.indexOf('widgets/pantry-tv.js') < hub.indexOf('src="hub.js"'), 'pantry-tv.js after hub.js');
      assert(hub.indexOf('pantry-tv-live-stub') < 0, 'the test stub is in hub.html');
      const box = { window: {}, location: { search: '' } };
      box.window = box;
      vm.runInNewContext(I18N, box);
      const es = box.HUB_I18N.strings.es;
      const esBlock = I18N.slice(I18N.indexOf('var ES = {'));
      const seen = {}, twice = [];
      (esBlock.match(/^\s*'pantry\.[\w.]+':/gm) || []).forEach((k) => { k = k.trim(); if (seen[k]) twice.push(k); seen[k] = 1; });
      assert(!twice.length, 'listed twice: ' + twice.join(', '));
      const keys = {};
      let m;
      const re = /tr\('(pantry\.[\w.]+)'/g;
      while ((m = re.exec(text))) if (!/\.$/.test(m[1])) keys[m[1]] = 1;
      ['pantry.title', 'pantry.titleShort', 'pantry.listTitle', 'pantry.listTitleShort'].forEach((k) => { keys[k] = 1; });
      P.UNITS.forEach((u) => { keys['pantry.unit.' + u] = 1; });
      P.LOCATIONS.forEach((u) => { keys['pantry.place.' + u] = 1; });
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

    await check('logic: the Pi\'s rows map to the widget\'s shape; page changes become set and edit ops; a tick shows at once; ticked rows last', async () => {
      const P = require('../app/widgets/pantry-tv.js');
      const box = { window: {}, setTimeout: setTimeout, Date: Date, JSON: JSON };
      box.window = box;
      vm.runInNewContext(STUB, box);
      const d = P.fromServer(box.PANTRY_STUB.data);
      assert(d && d.products.length === 20 && d.list.items.length === 8, 'mapped ' + (d && d.products.length));
      const milk = P.productById(d, 1);
      assert(milk.quantity_remaining === 0 && milk.restock_at === 1 && milk.purchase_quantity === 2 && milk.auto_add === 1 && P.brandName(d, milk) === 'Organic Valley', JSON.stringify(milk));
      const pan = P.pantryOf(d.products);
      assert(pan.every((p) => p.owned) && pan.length === 18, 'pantry ' + pan.length);
      assert(P.stateOf(pan[0]) === 'out', 'out first: ' + pan[0].name);
      const c = P.pantryCounts(d.products);
      assert(c.out === 5 && c.low > 0, JSON.stringify(c));
      const ops = P.opsFor(5, { quantity_remaining: 2, purchase_quantity: 3, auto_add: 0, substitution_mode: 'refund', brand: '' });
      assert(JSON.stringify(ops) === JSON.stringify([{ op: 'set', id: 5, qty: 2 }, { op: 'edit', id: 5, purchaseQuantity: 3, autoAdd: false, substitutionMode: 'refund', brandId: null }]), JSON.stringify(ops));
      assert(JSON.stringify(P.opsFor(5, { unit: 'lb' })) === JSON.stringify([{ op: 'edit', id: 5, unit: 'lb' }]), 'unit');
      const local = P.applyLocal(d, [{ op: 'check', list_item_id: 1, checked: true }, { op: 'set', id: 5, qty: 0 }, { op: 'edit', id: 5, brand: 'barilla' }]);
      assert(local.list.items[0].checked && !d.list.items[0].checked, 'the tick changed the Pi\'s copy or did not show');
      assert(P.productById(local, 5).quantity_remaining === 0 && P.productById(local, 5).brand_id === 4, 'local set or brand');
      const order = P.listOf(local).map((i) => i.id);
      assert(order[order.length - 1] === 1, 'ticked not last: ' + order);
      assert(P.clean('size', '15.5').value === 15.5 && P.clean('size', '').value === null && P.clean('size', '-1').error, 'size');
      assert(P.clean('purchase_quantity', '2').value === 2 && P.clean('purchase_quantity', '1.5').error && P.clean('purchase_quantity', '0').error, 'purchase quantity');
      assert(P.clean('quantity_remaining', '0').value === 0 && P.clean('quantity_remaining', 'x').error && P.clean('quantity_remaining', '1.5').error === 'whole0', 'remaining (whole numbers, as the Pi)');
      assert(P.clean('restock_at', '1000').error && P.clean('purchase_quantity', '100').error, 'the Pi\'s limits');
      assert(P.clean('unit', 'fl_oz').value === 'fl_oz' && P.clean('unit', 'cup').error, 'unit');
      assert(P.clean('substitution_mode', 'contact_me').value && P.clean('location', 'garage').error, 'enums');
      assert(P.clean('name', '  ').error === 'name', 'empty name');
      assert(P.brandKey('Rao’s') === P.brandKey('raos') && P.brandKey('Héinz') === 'heinz', 'brand key');
      assert(P.fromServer(null) === null && P.fromServer({}) === null, 'no data is null');
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
      assert(!s.mock, 'the sample-data note is still there');
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
      assert(/Back for the list/.test(await hint(page)), 'Back chip: ' + await hint(page));
      env.pageFrom = k;
    });

    await check('+ and - change Remaining at once and the tile follows; a pill picks the unit; focus stays put', async () => {
      const id = Number(env.pageFrom.slice(5));
      const was = (await product(page, id)).quantity_remaining;
      await focusKey(page, 'step:quantity_remaining:1');
      await key(page, 'Enter');
      await until(async () => (await product(page, id)).quantity_remaining === was + 1, 2000, 'not saved');
      const set = await lastOps(page);
      assert(set.path === '/pantry/screen-ops' && JSON.stringify(set.ops) === JSON.stringify([{ op: 'set', id: id, qty: was + 1 }]), JSON.stringify(set));
      await until(() => page.evaluate(() => window.PANTRY_STUB.posts.length && !document.querySelector('.is-pending') && window.HUB_PANTRY_TV.api.snapshot() && true), 2000, 'no answer');
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
      assert(JSON.stringify((await lastOps(page)).ops) === JSON.stringify([{ op: 'edit', id: id, unit: 'lb' }]), JSON.stringify(await lastOps(page)));
      await until(() => page.evaluate((i) => window.PANTRY_STUB.data.products.filter((p) => p.id === i)[0].unit === 'lb', id), 2000, 'the Pi did not take the unit');
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
      assert(JSON.stringify((await lastOps(page)).ops) === JSON.stringify([{ op: 'edit', id: id, purchaseQuantity: 5 }]), JSON.stringify(await lastOps(page)));
      const posts = await page.evaluate(() => window.PANTRY_STUB.posts.length);
      await key(page, 'Enter');
      await page.keyboard.press('Control+A');
      await page.keyboard.type('2.5');
      await key(page, 'Enter');
      await until(async () => /whole number/.test(await toast(page)), 2000, 'no toast');
      assert((await product(page, id)).purchase_quantity === 5, 'changed');
      assert(await page.evaluate(() => window.PANTRY_STUB.posts.length) === posts, 'a bad number was posted');
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

    await check('List: OK ticks a row (op check); it moves under In the cart, dimmed; focus on the next row; counts follow; OK unticks', async () => {
      await openPanel(page, 'list');
      assert(await focused(page) === 'tick:1', 'focus ' + await focused(page));
      assert(/Back to close/.test(await hint(page)), 'Back chip: ' + await hint(page));
      await key(page, 'Enter');
      await until(() => page.evaluate(() => !!document.querySelector('#panel .pn-sec-cart [data-key="untick:1"]')), 2000, 'not under In the cart');
      const op = await lastOps(page);
      assert(op.path === '/pantry/screen-ops' && JSON.stringify(op.ops) === JSON.stringify([{ op: 'check', list_item_id: 1, checked: true }]), JSON.stringify(op));
      assert(await focused(page) === 'tick:2', 'focus ' + await focused(page));
      const s = await page.evaluate(() => ({
        secs: [].map.call(document.querySelectorAll('#panel .pn-sec-head'), (n) => n.querySelector('.pn-sec-name').textContent + ' ' + n.querySelector('.pn-sec-count').textContent),
        dim: parseFloat(getComputedStyle(document.querySelector('#panel .pn-sec-cart .pn-row-main')).opacity),
        struck: getComputedStyle(document.querySelector('#panel .pn-sec-cart .pn-name')).textDecorationLine,
        sub: (document.querySelector('#panel .panel-sub') || {}).textContent || document.querySelector('#panel').innerText.slice(0, 200),
        tile: document.querySelector('.cell[data-widget="list"] .tile-body').innerText.replace(/\s+/g, ' ')
      }));
      assert(s.secs.join('|') === 'To get 7|In the cart 1', s.secs.join('|'));
      assert(s.dim < 0.8 && s.struck === 'line-through', JSON.stringify(s));
      assert(/7 to buy · 1 in the cart/.test(s.sub), 'sub: ' + s.sub);
      assert(/^7 to buy\b/.test(s.tile.trim()) || /\b7\b/.test(s.tile) && /1 in the cart/.test(s.tile), 'tile: ' + s.tile);
      await until(() => page.evaluate(() => window.PANTRY_STUB.data.list[0].checked === true), 2000, 'the Pi did not take the tick');
      await focusKey(page, 'untick:1');
      await key(page, 'Enter');
      await until(() => page.evaluate(() => !document.querySelector('#panel .pn-sec-cart')), 2000, 'still ticked');
      assert(JSON.stringify((await lastOps(page)).ops) === JSON.stringify([{ op: 'check', list_item_id: 1, checked: false }]), 'untick op');
      await until(() => page.evaluate(() => window.PANTRY_STUB.data.list[0].checked === false), 2000, 'the Pi did not take the untick');
    });

    await check('List: Right then OK on Details opens the product; Back goes back to Details', async () => {
      await focusKey(page, 'tick:2');
      await key(page, 'ArrowRight');
      assert(await focused(page) === 'item:2', 'Right went to ' + await focused(page));
      await key(page, 'Enter');
      await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !!document.querySelector('#panel .pn-page')), 4000, 'no page');
      await settle(page);
      const name = await page.evaluate(() => document.querySelector('#panel .pn-ph-name').textContent);
      assert(name === 'Large brown eggs', name);
      assert(/Back for the list/.test(await hint(page)), 'Back chip: ' + await hint(page));
      await key(page, 'Escape');
      await until(() => page.evaluate(() => !document.querySelector('#panel .pn-page') && !!document.querySelector('#panel .pn-row')), 2000, 'page still open');
      assert(await focused(page) === 'item:2', 'focus ' + await focused(page));
      assert(/Back to shrink/.test(await hint(page)), 'Back chip: ' + await hint(page));
    });

    await check('List: a refusal takes the tick back with a toast; an Out product on the list is flagged', async () => {
      await page.evaluate(() => { window.PANTRY_STUB.refuse = 'nope'; });
      await focusKey(page, 'tick:3');
      await key(page, 'Enter');
      assert(await page.evaluate(() => !!document.querySelector('#panel [data-key="untick:3"]')), 'not shown at once');
      await until(async () => /didn’t save: nope/.test(await toast(page)), 3000, 'no toast');
      await until(() => page.evaluate(() => !!document.querySelector('#panel [data-key="tick:3"]') && !document.querySelector('#panel .pn-sec-cart')), 2000, 'the tick stayed');
      await page.evaluate(() => { window.PANTRY_STUB.refuse = ''; });
      const flagged = await page.evaluate(() => [].filter.call(document.querySelectorAll('#panel .pn-lrow'), (r) => r.querySelector('.pn-chip-out')).length);
      assert(flagged === 4, 'Out chips on the list: ' + flagged);
    });

    await check('List: a quantity drop on an auto-add product adds a row (Auto chip)', async () => {
      // Yogurt: 2 left, restock at 1, auto-add on, not on the list.
      const before = await page.evaluate(() => document.querySelectorAll('#panel .pn-lrow').length);
      await page.evaluate(() => new Promise((r) => window.HUB_PANTRY_TV.api.saveProduct(3, { quantity_remaining: 1 }, r)));
      await until(() => page.evaluate((n) => document.querySelectorAll('#panel .pn-lrow').length === n + 1, before), 2000, 'the list did not grow');
      const op = await lastOps(page);
      assert(JSON.stringify(op.ops) === JSON.stringify([{ op: 'set', id: 3, qty: 1 }]), JSON.stringify(op));
      assert(await page.evaluate(() => [].some.call(document.querySelectorAll('#panel .pn-lrow'), (r) => /Greek yogurt/.test(r.textContent) && r.querySelector('.pn-chip-auto'))), 'no Auto chip');
      assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
    });
    await page.ctx.close();

    await check('filters: Place and Store chips on the expanded Pantry, Store chips on the List, one pick each, All clears; rows end with their store; the tile ignores them', async () => {
      const P = require('../app/widgets/pantry-tv.js');
      const box = { window: {}, setTimeout: setTimeout, Date: Date, JSON: JSON };
      box.window = box;
      vm.runInNewContext(STUB, box);
      const d = P.fromServer(box.PANTRY_STUB.data);
      const prow = P.pantryOf(d.products).map((x) => ({ product: x }));
      const ch = P.filterChoices(prow, d.stores);
      assert(ch.places.join() === 'fridge,freezer,pantry,other' && ch.stores.join() === 'Costco,CVS,Tom Thumb,Whole Foods', JSON.stringify(ch));
      assert(P.filterChoices(prow.filter((r) => r.product.location === 'fridge'), d.stores).places.length === 0, 'one place in use still shows chips');
      assert(P.filterRows(prow, 'fridge', 'Tom Thumb').map((r) => r.product.name).sort().join() === 'Orange juice,Salted butter,Whole milk', 'filterRows');

      const q = await open({});
      await openPanel(q, 'pantry');
      const rowsNow = () => q.evaluate(() => [].map.call(document.querySelectorAll('#panel .pn-row'), (r) => r.querySelector('.pn-name').textContent));
      const chips = await q.evaluate(() => [].map.call(document.querySelectorAll('#panel .pn-fchip'), (n) => n.getAttribute('data-key') + '=' + n.textContent));
      assert(chips.join() === 'fplace:all=All,fplace:fridge=Fridge,fplace:freezer=Freezer,fplace:pantry=Pantry,fplace:other=Other,fstore:all=All,fstore:0=Costco,fstore:1=CVS,fstore:2=Tom Thumb,fstore:3=Whole Foods', chips.join());
      assert(/^prod:\d+$/.test(await focused(q)), 'focus did not start on a row: ' + await focused(q));
      assert(await q.evaluate(() => !document.querySelector('.cell .tile .pn-fchip')), 'chips on the tile');
      const milkMeta = await q.evaluate(() => [].filter.call(document.querySelectorAll('#panel .pn-row'), (r) => /Whole milk/.test(r.textContent))[0].querySelector('.pn-meta').textContent);
      assert(milkMeta === 'Organic Valley · 0.5 gal · Fridge · Tom Thumb', milkMeta);
      assert((await rowsNow()).length === 18, 'rows ' + (await rowsNow()).length);
      await focusKey(q, 'fplace:fridge');
      await key(q, 'Enter');
      await until(async () => (await rowsNow()).length === 6, 2000, 'fridge rows: ' + (await rowsNow()).join());
      assert(await focused(q) === 'fplace:fridge', 'focus left the chip: ' + await focused(q));
      await focusKey(q, 'fstore:2');
      await key(q, 'Enter');
      await until(async () => (await rowsNow()).sort().join() === 'Orange juice,Salted butter,Whole milk', 2000, 'fridge + Tom Thumb: ' + (await rowsNow()).join());
      const on = await q.evaluate(() => [].map.call(document.querySelectorAll('#panel .pn-fchip.is-on'), (n) => n.getAttribute('data-key')));
      assert(on.join() === 'fplace:fridge,fstore:2', 'on: ' + on.join());
      await focusKey(q, 'fplace:freezer');
      await key(q, 'Enter');
      await until(() => q.evaluate(() => /Nothing matches these filters/.test((document.querySelector('#panel .pn-empty') || {}).textContent || '')), 2000, 'no empty note');
      const tile = await q.evaluate(() => document.querySelector('.cell[data-widget="pantry"] .tile-body').innerText);
      assert(/Whole milk|21 Whole Grains/.test(tile), 'the tile was filtered: ' + tile.slice(0, 80));
      await focusKey(q, 'fstore:all');
      await key(q, 'Enter');
      await focusKey(q, 'fplace:all');
      await key(q, 'Enter');
      await until(async () => (await rowsNow()).length === 18, 2000, 'All did not clear');
      await focusKey(q, 'fstore:0');
      await key(q, 'Enter');
      await until(async () => (await rowsNow()).length === 3, 2000, 'Costco');
      await q.evaluate(() => window.HUB_TEST.closePanel());
      await settle(q);
      await openPanel(q, 'pantry');
      assert((await rowsNow()).length === 18, 'filters kept after close');
      await q.evaluate(() => window.HUB_TEST.closePanel());
      await settle(q);

      await openPanel(q, 'list');
      const lchips = await q.evaluate(() => [].map.call(document.querySelectorAll('#panel .pn-fchip'), (n) => n.textContent));
      assert(lchips.join() === 'All,Tom Thumb,Whole Foods', 'list chips: ' + lchips.join());
      await focusKey(q, 'fstore:1');
      await key(q, 'Enter');
      await until(async () => (await rowsNow()).join() === 'Large brown eggs,Oat milk', 2000, 'Whole Foods: ' + (await rowsNow()).join());
      await focusKey(q, 'tick:2');
      await key(q, 'Enter');
      await until(() => q.evaluate(() => !!document.querySelector('#panel .pn-sec-cart [data-key="untick:2"]')), 2000, 'not ticked');
      assert(await focused(q) === 'tick:6', 'focus after a tick: ' + await focused(q));
      const sub = await q.evaluate(() => document.querySelector('#panel').innerText);
      assert(/7 to buy · 1 in the cart/.test(sub), 'the counts follow the whole list');
      assert(!q.ctx.errors.length, 'console: ' + q.ctx.errors.join(' | '));
      await q.ctx.close();
    });

    await check('Spanish +25%: the product page and a ticked List in full screen, nothing cut or outside the screen', async () => {
      const p = await open({ lang: 'es', grow: true });
      await openPanel(p, 'pantry');
      await key(p, 'Enter');
      await until(() => p.evaluate(() => !!document.querySelector('#panel .pn-page')), 4000, 'no page');
      await settle(p);
      let r = await measure(p, '#panel');
      assert(!r.problems.length, 'page: ' + r.problems.slice(0, 4).join(', '));
      const over = await p.evaluate(() => { const b = document.querySelector('#panel .pn-page').getBoundingClientRect(); return b.right > window.innerWidth + 1; });
      assert(!over, 'wider than the screen');
      await key(p, 'Escape');
      await until(() => p.evaluate(() => !document.querySelector('#panel .pn-page') && !!document.querySelector('#panel .pn-fchip')), 2000, 'no chips in full screen');
      await settle(p);
      r = await measure(p, '#panel');
      assert(!r.problems.length, 'pantry with chips: ' + r.problems.slice(0, 4).join(', '));
      assert(/Lugar/.test(r.text) && /Tienda/.test(r.text), 'no Spanish chip labels: ' + r.text.slice(0, 120));
      await p.evaluate(() => window.HUB_TEST.closePanel());
      await settle(p);
      await openPanel(p, 'list');
      await key(p, 'Enter');
      await key(p, 'Enter');
      await until(() => p.evaluate(() => document.querySelectorAll('#panel .pn-sec-cart .pn-lrow').length === 2), 3000, 'not ticked');
      // Full screen the remote's way: Details, then Back to the list.
      await focusKey(p, 'item:3');
      await key(p, 'Enter');
      await until(() => p.evaluate(() => window.HUB_TEST.mode() === 'full' && !!document.querySelector('#panel .pn-page')), 4000, 'no page');
      await settle(p);
      await key(p, 'Escape');
      await until(() => p.evaluate(() => !document.querySelector('#panel .pn-page')), 2000, 'page still open');
      await settle(p);
      r = await measure(p, '#panel');
      assert(!r.problems.length, 'list: ' + r.problems.slice(0, 4).join(', '));
      assert(/En el carrito/.test(r.text) && /Detalles/.test(r.text), r.text.slice(0, 120));
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    if (SHOTS) {
      await check('pictures (device scale 2): the Groceries layout, the product page and a ticked List, EN and ES', async () => {
        for (const lang of ['en', 'es']) {
          const p = await open({ lang: lang, scale: 2 });
          await p.evaluate(() => Promise.all([1, 2, 5].map((id) => new Promise((r) => window.HUB_PANTRY_TV.api.check(id, true, r)))));
          await sleep(600);
          await shot(p, 'groceries-layout-' + lang + '.png');
          await openPanel(p, 'pantry');
          await sleep(400);
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
          await shot(p, 'list-ticked-panel-' + lang + '.png', '#panel');
          await focusKey(p, 'item:3');
          await key(p, 'Enter');
          await until(() => p.evaluate(() => window.HUB_TEST.mode() === 'full' && !!document.querySelector('#panel .pn-page')), 4000, 'no page');
          await settle(p);
          await key(p, 'Escape');
          await settle(p);
          await sleep(400);
          await shot(p, 'list-ticked-full-' + lang + '.png');
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
