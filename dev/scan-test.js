/*
 * The barcode scanner in the touch app (app/scan.js, the Scan button and
 * product rows in app/widgets/grocery.js): node dev/scan-test.js
 *
 * Starts the real Pi server (pi/server.js, web lookups off) with a throwaway
 * data folder and drives the phone view in headless Chromium with a fake
 * camera. window.HUB_SCAN_TEST.detector stands in for the reader, so a test
 * "shows" a code by queueing it. Checks: Scan loads no reader until tapped;
 * found product -> confirm -> add reaches the Pi with its upc and the row
 * shows the picture and "Brand · size"; not found -> the form (with a
 * photo) saves and the next scan finds it; typing the number; the calm
 * message without a secure address; Spanish fits 25% longer with accents
 * unclipped; the Add to chip (Groceries | Pantry, remembered per view); and
 * the vendored polyfill really decodes an EAN-13 picture
 * with the wasm served by the Pi while nothing leaves localhost.
 * SCAN_SHOTS=dir/ keeps screenshots (device scale 2). Needs Playwright.
 * Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const hubServer = require('../pi/server');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SCAN_SHOTS || '';
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      '));
  }
}
function assert(ok, text) { if (!ok) throw new Error(text); }

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

// Valid EAN-13 codes (check digits worked out by hand).
const KNOWN = '0012345678905';      // UPC-A 012345678905, saved before the tests
const UNKNOWN = '0070123456787';    // not in the catalog; web lookups are off
const FRESH = '5012345678900';      // valid, never saved: not found
const PRINTED = '4006381333931';    // drawn as bars for the real decoder

// In the page: a fake reader that returns whatever the test queues.
function hook() {
  window.HUB_SCAN_TEST = {
    queue: [],
    calls: 0,
    detector: {
      detect: function () {
        window.HUB_SCAN_TEST.calls += 1;
        var q = window.HUB_SCAN_TEST.queue;
        return Promise.resolve(q.length ? [q.shift()] : []);
      }
    }
  };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-scan-'));
  const hub = hubServer.start({ port: 0, token: 'scan-test-token-0123456789abcdef', log: false, dataDir: dataDir, appDir: path.join(ROOT, 'app'), products: { web: false } });
  await hub.ready;
  const base = 'http://127.0.0.1:' + hub.port;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['camera'] };

  async function open(opts) {
    opts = opts || {};
    const ctx = await browser.newContext(phone);
    await ctx.addInitScript((l) => { try { localStorage.setItem('homeHub.lang', l); } catch (e) { /* */ } }, opts.lang || 'en');
    if (opts.hook !== false) await ctx.addInitScript(hook);
    if (opts.insecure) await ctx.addInitScript(() => { Object.defineProperty(window, 'isSecureContext', { get: () => false }); });
    const page = await ctx.newPage();
    const errors = [], urls = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(base + (opts.url || '/app/touch.html#/grocery'));
    await page.waitForSelector('.gx-input');
    page.errors = errors;
    page.urls = urls;
    page.ctx = ctx;
    return page;
  }
  const groceryItems = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).resources.grocery.data.items;
  const show = (page, code, format) => page.evaluate((c) => window.HUB_SCAN_TEST.queue.push({ rawValue: c[0], format: c[1] || 'ean_13' }), [code, format]);
  async function openScanner(page) {
    await page.click('.gx-scan');
    await page.waitForSelector('.sc.is-on');
    await page.waitForFunction(() => document.querySelector('.sc').getAttribute('data-camera'));
    await page.waitForTimeout(300); // the overlay's rise ends
  }

  // A product in the catalog to find, saved the way the phone saves one.
  const saved = await fetch(base + '/products/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Hub-Touch': '1' },
    body: JSON.stringify({ upc: KNOWN, brand: 'Riverbend Farms', name: 'Oat milk, barista', size: '64 fl oz' })
  }).then((r) => r.json());

  try {
    await check('the catalog took the test product (the Pi side is there)', async () => {
      assert(saved && saved.ok && saved.product && saved.product.upc === KNOWN, JSON.stringify(saved));
    });

    await check('Scan opens the camera overlay; no reader is fetched before the tap', async () => {
      const page = await open();
      await page.waitForTimeout(300);
      assert(!page.urls.some((u) => /vendor\//.test(u)), 'reader fetched early: ' + page.urls.filter((u) => /vendor\//.test(u)).join(', '));
      assert(await page.getAttribute('.gx-scan', 'aria-label') === 'Scan a barcode', 'aria-label');
      await openScanner(page);
      assert(await page.getAttribute('.sc', 'data-camera') === 'on', 'camera on: ' + await page.getAttribute('.sc', 'data-camera'));
      await page.waitForFunction(() => window.HUB_SCAN_TEST.calls > 2, null, { timeout: 5000 });
      assert(/Point at the barcode/.test(await page.textContent('.sc-aim')), await page.textContent('.sc-aim'));
      await shot(page, 'scan-camera-en.png');
      const small = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('.sc button, .sc input'), (b) => {
        const r = b.getBoundingClientRect();
        return r.width && getComputedStyle(b).visibility !== 'hidden' && (r.height < 47.5 || r.width < 47.5);
      }).map((b) => b.className));
      assert(!small.length, 'targets under 48 px: ' + small.join(', '));
      await page.click('.sc-close');
      await page.waitForFunction(() => !document.querySelector('.sc'));
      assert(await page.evaluate(() => document.activeElement && document.activeElement.className) === 'gx-scan', 'focus back on Scan');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('a found product: confirm card, Add reaches the Pi with its upc, the row shows picture and "Brand · size"', async () => {
      const page = await open();
      await openScanner(page);
      await show(page, '012345678905', 'upc_a');
      await page.waitForSelector('.sc-sheet.is-on .sc-add');
      assert((await page.textContent('.sc-name')) === 'Oat milk, barista', await page.textContent('.sc-name'));
      assert((await page.textContent('.sc-brand')) === 'Riverbend Farms', 'brand');
      assert(/64 fl oz/.test(await page.textContent('.sc-meta')) && /0 012345 678905/.test(await page.textContent('.sc-meta')), await page.textContent('.sc-meta'));
      assert((await page.textContent('.sc-add')) === 'Add to Groceries', await page.textContent('.sc-add'));
      await shot(page, 'scan-found-en.png');
      await page.click('.sc-add');
      await page.waitForSelector('.sc-toast.is-on');
      assert(/Added to Groceries/.test(await page.textContent('.sc-toast')), 'toast');
      assert(await page.getAttribute('.sc', 'data-state') === 'scan', 'back to scanning');
      await page.waitForFunction(() => !document.querySelector('.gx-row.is-pending'));
      await page.waitForTimeout(200);
      const it = groceryItems().find((i) => i.upc === KNOWN);
      assert(it && !it.done && /Oat milk/.test(it.name), JSON.stringify(groceryItems()));
      // The same pack again: the card says it is on the list, and adding does not double it.
      await page.waitForTimeout(100);
      await show(page, KNOWN, 'ean_13');
      await page.waitForTimeout(400);
      assert(await page.getAttribute('.sc', 'data-state') === 'scan', 'the same code right after a resume is ignored');
      await page.evaluate(() => { window.HUB_SCAN_TEST.queue.length = 0; });
      await page.click('.sc-close');
      await page.click('.gx-scan');
      await page.waitForSelector('.sc.is-on');
      await show(page, KNOWN, 'ean_13');
      // Already there: a status in the Add button's place, no Add to tap twice.
      await page.waitForSelector('.sc-sheet.is-on .sc-have');
      assert((await page.textContent('.sc-have')) === 'Already on the list', await page.textContent('.sc-have'));
      assert(await page.getAttribute('.sc-have', 'role') === 'status', 'announced');
      assert(!(await page.$('.sc-sheet .sc-add')) && !(await page.$('.sc-sheet .sc-note')), 'no Add, no small print');
      assert(await page.evaluate(() => document.activeElement && document.activeElement.className.indexOf('sc-again') >= 0), 'focus on Scan another');
      assert((await page.textContent('.sc-anyway')) === 'Add anyway', 'a quiet way through for an old copy');
      await shot(page, 'scan-already-listed-en.png');
      await page.click('.sc-anyway');
      await page.waitForSelector('.sc-toast.is-on');
      assert(/It was on the list already/.test(await page.textContent('.sc-toast')), await page.textContent('.sc-toast'));
      await page.waitForTimeout(300);
      await page.waitForTimeout(200);
      assert(groceryItems().filter((i) => i.upc === KNOWN).length === 1, 'no double');
      await page.click('.sc-close');
      await page.evaluate(() => window.HUB_TOUCH.poll());
      await page.waitForSelector('.gx-row.has-product .gx-thumb.is-none'); // saved without a photo: a quiet placeholder
      const sub = await page.textContent('.gx-row.has-product .gx-sub');
      assert(sub === 'Riverbend Farms · 64 fl oz', sub);
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('edit: the pencil on a scanned row opens the form with its details, saving fixes the brand and the row', async () => {
      const page = await open();
      await page.evaluate(() => window.HUB_TOUCH.poll());
      await page.waitForSelector('.gx-row.has-product .gx-edit');
      await page.click('.gx-row.has-product .gx-edit');
      await page.waitForSelector('.sc.is-edit .sc-form');
      assert((await page.inputValue('.sc-field.is-brand input')) === 'Riverbend Farms', 'prefilled brand');
      assert(!(await page.isVisible('.sc-dock')), 'no camera or number box in edit mode');
      await page.fill('.sc-field.is-brand input', 'Riverbend Dairy');
      await page.click('.sc-save');
      await page.waitForSelector('.sc', { state: 'detached' });
      await page.waitForFunction(() => /Riverbend Dairy/.test((document.querySelector('.gx-row.has-product .gx-sub') || {}).textContent || ''));
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('not found: the form (with a photo) saves, the card follows, and the next scan finds it', async () => {
      const page = await open();
      const png = path.join(dataDir, 'pack.png');
      const data = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 900; c.height = 1200;
        const g = c.getContext('2d');
        g.fillStyle = '#e8d9b5'; g.fillRect(0, 0, 900, 1200);
        g.fillStyle = '#7a3b1d'; g.fillRect(120, 200, 660, 800);
        return c.toDataURL('image/png').split(',')[1];
      });
      fs.writeFileSync(png, Buffer.from(data, 'base64'));
      await openScanner(page);
      await show(page, UNKNOWN);
      await page.waitForSelector('.sc-sheet.is-on .sc-form');
      assert(/0 070123 456787/.test(await page.textContent('.sc-sheet .sc-code')), 'code shown');
      assert(/New to the hub/.test(await page.textContent('.sc-form-title')), 'form title');
      await page.click('.sc-save');
      assert(/name/.test(await page.textContent('.sc-form-msg')), 'name needed');
      await page.fill('.sc-field.is-brand input', 'Corner Bakery');
      await page.fill('.sc-field.is-name input', 'Seeded rye');
      await page.fill('.sc-field.is-size input', '24 oz');
      await page.setInputFiles('.sc-file', png);
      await page.waitForSelector('.sc-pick .sc-photo img');
      const photo = await page.evaluate(() => {
        const i = document.querySelector('.sc-pick .sc-photo img');
        return { w: i.naturalWidth, h: i.naturalHeight, jpeg: /^data:image\/jpeg/.test(i.src), bytes: i.src.length * 0.75 };
      });
      assert(photo.jpeg && Math.max(photo.w, photo.h) === 320 && photo.bytes < 150 * 1024, JSON.stringify(photo));
      await shot(page, 'scan-form-en.png');
      await page.click('.sc-save');
      await page.waitForSelector('.sc-sheet.is-on .sc-add');
      assert((await page.textContent('.sc-name')) === 'Seeded rye', 'card after save');
      assert(/\/products\/image\//.test(await page.getAttribute('.sc-card .sc-photo img', 'src')), 'saved picture');
      await page.waitForFunction(() => { const i = document.querySelector('.sc-card .sc-photo img'); return i && i.complete && i.naturalWidth > 0; });
      await page.click('.sc-again');
      await page.waitForTimeout(REPEAT_WAIT);
      await show(page, UNKNOWN);
      await page.waitForSelector('.sc-sheet.is-on .sc-add');
      assert((await page.textContent('.sc-name')) === 'Seeded rye', 'second lookup found');
      await page.click('.sc-add');
      await page.waitForTimeout(400);
      assert(groceryItems().some((i) => i.upc === UNKNOWN && /Seeded rye/.test(i.name)), JSON.stringify(groceryItems()));
      await page.click('.sc-close');
      await page.waitForFunction(() => { const i = document.querySelector('.gx-row.has-product .gx-thumb img'); return i && i.complete && i.naturalWidth > 0; });
      assert((await page.textContent('.gx-row.has-product .gx-sub')) === 'Corner Bakery · 24 oz', 'row sub');
      await page.evaluate(() => fetch('/grocery/ops', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Touch': '1' },
        body: JSON.stringify({ ops: ['Bananas', 'Coffee beans', 'Spinach'].map((n) => ({ op: 'add', name: n })) }) }).then(() => window.HUB_TOUCH.poll()));
      await page.waitForFunction(() => /Spinach/.test(document.querySelector('.gx-list').textContent));
      await page.waitForTimeout(300);
      await shot(page, 'grocery-rows-en.png');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('type the number: a bad one says so, a good one (with spaces) finds the product', async () => {
      const page = await open();
      await openScanner(page);
      await page.fill('.sc-type', '12345');
      await page.press('.sc-type', 'Enter');
      await page.waitForSelector('.sc-dock-msg.is-bad');
      assert(/isn.t a valid barcode/.test(await page.textContent('.sc-dock-msg')), await page.textContent('.sc-dock-msg'));
      await page.fill('.sc-type', '0012345678904'); // wrong check digit: the Pi says no
      await page.press('.sc-type', 'Enter');
      await page.waitForFunction(() => /valid barcode/.test(document.querySelector('.sc-dock-msg').textContent) && document.querySelector('.sc').getAttribute('data-state') === 'scan');
      await page.fill('.sc-type', '0 12345 67890 5');
      await page.click('.sc-look');
      await page.waitForSelector('.sc-sheet.is-on .sc-name');
      assert((await page.textContent('.sc-name')) === 'Oat milk, barista', 'typed lookup');
      await page.click('.sc-done');
      await page.waitForFunction(() => !document.querySelector('.sc'));
      await page.ctx.close();
    });

    await check('paste a list: added, not found (with details), not valid, repeats skipped; Spanish fits', async () => {
      const page = await open();
      await openScanner(page);
      await page.click('.sc-many-toggle');
      await page.fill('.sc-many-in', [KNOWN, FRESH, '12345', '0 12345 67890 5'].join('\n') + '\n' + KNOWN);
      await shot(page, 'scan-many-en.png');
      await page.click('.sc-many-go');
      await page.waitForSelector('.sc-bulk-done');
      const rows = await page.$$eval('.sc-bulk-row', (n) => n.map((x) => x.className.replace('sc-bulk-row ', '')));
      assert(rows.join() === 'is-have,is-missing,is-invalid', rows.join());
      assert(/1 already in/.test(await page.textContent('.sc-bulk-sum')) && /1 not found/.test(await page.textContent('.sc-bulk-sum')), await page.textContent('.sc-bulk-sum'));
      assert(/Skipped 2 repeated/.test(await page.textContent('.sc-bulk-repeats')), await page.textContent('.sc-bulk-repeats'));
            await shot(page, 'scan-bulk-en.png');
      await page.click('.sc-bulk-details');
      await page.waitForSelector('.sc-sheet .sc-form');
      await page.fill('.sc-field.is-name input', 'Test jam');
      await page.click('.sc-save');
      await page.waitForSelector('.sc-bulk-done');
      const after = await page.$$eval('.sc-bulk-row', (n) => n.map((x) => x.className.replace('sc-bulk-row ', '')));
      assert(after.join() === 'is-have,is-added,is-invalid', after.join());
      // the same list again: everything found is already on the list
      await page.click('.sc-bulk-more');
      await page.fill('.sc-type', KNOWN + ', ' + FRESH);
      await page.press('.sc-type', 'Enter');
      await page.waitForSelector('.sc-bulk-done');
      const again = await page.$$eval('.sc-bulk-row', (n) => n.map((x) => x.className.replace('sc-bulk-row ', '')));
      assert(again.join() === 'is-have,is-have', again.join());
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
      const es = await open({ lang: 'es' });
      await openScanner(es);
      await es.click('.sc-many-toggle');
      await es.fill('.sc-many-in', [KNOWN, '99999'].join('\n'));
      await es.click('.sc-many-go');
      await es.waitForSelector('.sc-bulk-done');
      await shot(es, 'scan-bulk-es.png');
      const t = await es.evaluate(() => document.querySelector('.sc-sheet').innerText);
      assert(/Ya está en|no válido/.test(t) && !/\b(Added|Checked|Done)\b/.test(t), t);
      const sideways = await es.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!sideways, 'page scrolls sideways');
      await es.ctx.close();
    });

    await check('no secure address: a calm message, no camera asked for, typing still works', async () => {
      const page = await open({ insecure: true });
      await openScanner(page);
      assert(await page.getAttribute('.sc', 'data-camera') === 'insecure', 'insecure');
      assert(/secure address \(https\)/.test(await page.textContent('.sc-msg')), await page.textContent('.sc-msg'));
      assert(!(await page.isVisible('.sc-video')), 'no camera picture');
      await shot(page, 'scan-insecure-en.png');
      await page.fill('.sc-type', KNOWN);
      await page.press('.sc-type', 'Enter');
      await page.waitForSelector('.sc-sheet.is-on .sc-name');
      await page.ctx.close();
    });

    await check('Spanish: no English left, 25% longer still fits, accents unclipped (camera, card, form, row)', async () => {
      const page = await open({ lang: 'es' });
      await page.waitForSelector('.gx-row.has-product');
      assert(await page.getAttribute('.gx-scan', 'aria-label') === 'Escanear un código de barras', 'aria-label');
      await openScanner(page);
      await page.waitForFunction(() => /Apunta/.test(document.querySelector('.sc-aim').textContent));
      const inflate = (sel) => page.evaluate((s) => {
        const out = [];
        document.querySelectorAll(s).forEach((n) => {
          if (!n.textContent || n.children.length) return;
          n.textContent = n.textContent + ' ' + n.textContent.slice(0, Math.ceil(n.textContent.length / 4)) + 'Ñá';
        });
        document.querySelectorAll(s).forEach((n) => {
          const r = n.getBoundingClientRect();
          if (r.width <= 1 || !n.textContent) return;
          const cs = getComputedStyle(n);
          const lh = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
          if (lh < 1.29) out.push(n.className + ' line-height ' + lh.toFixed(2));
          if (r.right > window.innerWidth + 0.5 || r.left < -0.5) out.push(n.className + ' past the edge');
          if (n.scrollHeight > n.clientHeight + 1 && cs.overflow !== 'visible') out.push(n.className + ' clipped');
          const b = n.closest('button');
          if (b && b.scrollWidth > b.clientWidth + 1) out.push(b.className + ' text wider than the button');
        });
        if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways');
        return out;
      }, sel);
      const english = async () => {
        const t = await page.evaluate(() => document.querySelector('.sc').innerText + ' ' + Array.prototype.map.call(document.querySelectorAll('.sc [aria-label], .sc [placeholder]'), (n) => (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('placeholder') || '')).join(' '));
        return ['Scan', 'Close', 'Point at', 'type the number', 'Look up', 'Add to', 'Groceries', 'Done', 'Brand', 'Product', 'Size', 'Save', 'Cancel', 'photo', 'light'].filter((w) => new RegExp('\\b' + w + '\\b').test(t));
      };
      let left = await english();
      assert(!left.length, 'English left: ' + left.join(', '));
      await shot(page, 'scan-camera-es.png');
      let bad = await inflate('.sc-title-word, .sc-title-dest, .sc-aim, .sc-dock-label');
      assert(!bad.length, 'camera: ' + bad.join('; '));
      await show(page, KNOWN);
      // On the list already (the first test put it there): the status, in Spanish.
      await page.waitForSelector('.sc-sheet.is-on .sc-have');
      assert((await page.textContent('.sc-have')) === 'Ya está en la lista', await page.textContent('.sc-have'));
      left = await english();
      assert(!left.length, 'English left: ' + left.join(', '));
      await page.waitForTimeout(350);
      await shot(page, 'scan-found-es.png');
      bad = await inflate('.sc-sheet .sc-btn-word, .sc-brand, .sc-name, .sc-note, .sc-size, .sc-have');
      assert(!bad.length, 'card: ' + bad.join('; '));
      await page.click('.sc-again');
      await page.fill('.sc-type', '5901234123457');
      await page.press('.sc-type', 'Enter');
      await page.waitForSelector('.sc-sheet.is-on .sc-form');
      left = await english();
      assert(!left.length, 'English left: ' + left.join(', '));
      await page.waitForTimeout(350);
      await shot(page, 'scan-form-es.png');
      bad = await inflate('.sc-form-title, .sc-form-text, .sc-field-label, .sc-pick-btn .sc-btn-word, .sc-save, .sc-cancel .sc-btn-word');
      assert(!bad.length, 'form: ' + bad.join('; '));
      await page.click('.sc-cancel');
      await page.click('.sc-close');
      await page.waitForTimeout(300);
      await shot(page, 'grocery-rows-es.png');
      bad = await inflate('.gx-sub, .gx-name');
      assert(!bad.length, 'rows: ' + bad.join('; '));
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('the vendored polyfill decodes a drawn EAN-13 with the Pi\'s wasm; nothing leaves localhost', async () => {
      const ctx = await browser.newContext(phone);
      await ctx.addInitScript(() => { window.HUB_SCAN_TEST = { forcePolyfill: true }; });
      const outside = [];
      await ctx.route('**/*', (r) => {
        const u = r.request().url();
        if (!/^(https?:\/\/(127\.0\.0\.1|localhost)[:/]|data:|blob:)/.test(u)) { outside.push(u); return r.abort(); }
        return r.continue();
      });
      const page = await ctx.newPage();
      const urls = [];
      page.on('request', (r) => urls.push(r.url()));
      await page.goto(base + '/app/touch.html#/grocery');
      await page.waitForSelector('.gx-input');
      const got = await page.evaluate((code) => {
        // EAN-13 bars: L/G/R patterns, first digit picks the L/G parity.
        const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
        const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
        const R = L.map((p) => p.replace(/./g, (b) => (b === '1' ? '0' : '1')));
        const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLG', 'LGLGGL', 'LGLGLG', 'LGGLGL'];
        const d = code.split('').map(Number);
        let bits = '101';
        for (let i = 1; i <= 6; i++) bits += (PAR[d[0]][i - 1] === 'L' ? L : G)[d[i]];
        bits += '01010';
        for (let i = 7; i <= 12; i++) bits += R[d[i]];
        bits += '101';
        const m = 4, quiet = 14, c = document.createElement('canvas');
        c.width = (bits.length + quiet * 2) * m; c.height = 220;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#000';
        for (let i = 0; i < bits.length; i++) if (bits[i] === '1') g.fillRect((quiet + i) * m, 20, m, 180);
        return window.HUB_SCAN.detector().then((det) => det.detect(c)).then((list) => list.map((x) => ({ raw: x.rawValue, format: x.format })));
      }, PRINTED);
      assert(got.length === 1 && got[0].raw === PRINTED && got[0].format === 'ean_13', JSON.stringify(got));
      const wasm = urls.filter((u) => /\.wasm/.test(u));
      assert(wasm.length >= 1 && wasm.every((u) => u === base + '/app/vendor/barcode-detector/zxing_reader.wasm'), 'wasm from: ' + wasm.join(', '));
      assert(!outside.length && urls.every((u) => /^(http:\/\/127\.0\.0\.1:|data:|blob:)/.test(u)), 'left localhost: ' + outside.concat(urls.filter((u) => !/^(http:\/\/127\.0\.0\.1:|data:|blob:)/.test(u))).join(', '));
      const head = await page.evaluate(() => fetch('/app/vendor/barcode-detector/zxing_reader.wasm', { method: 'HEAD', headers: { 'X-Hub-Touch': '1' } }).then((r) => r.headers.get('content-type')));
      assert(head === 'application/wasm', 'wasm type ' + head);
      await ctx.close();
    });

    await check('Add to chip: Groceries | Pantry; a pick goes to the pantry and is remembered for the view that opened Scan', async () => {
      const page = await open();
      await openScanner(page);
      await show(page, KNOWN);
      await page.waitForSelector('.sc-sheet.is-on .sc-dests');
      let chips = await page.$$eval('.sc-dest', (b) => b.map((x) => x.textContent + ':' + x.getAttribute('aria-pressed')));
      assert(chips.join(',') === 'Groceries:true,Pantry:false', chips.join(','));
      await page.click('.sc-dest[data-dest="pantry"]');
      assert((await page.textContent('.sc-add')) === 'Add to Pantry', await page.textContent('.sc-add'));
      assert((await page.textContent('.sc-title-dest')) === 'Pantry', 'title follows the pick');
      await shot(page, 'scan-dest-pantry-en.png');
      await page.click('.sc-add');
      await page.waitForSelector('.sc-toast.is-on');
      await page.waitForFunction(() => document.querySelector('.sc').getAttribute('data-state') === 'scan');
      await page.waitForTimeout(500);
      const got = hub.pantry.ownedList().find((p) => p.upc === KNOWN);
      assert(got && got.qty === 1 && got.brand, JSON.stringify(got));
      await page.click('.sc-close');
      await openScanner(page);
      await show(page, KNOWN);
      await page.waitForSelector('.sc-sheet.is-on .sc-dests');
      chips = await page.$$eval('.sc-dest', (b) => b.map((x) => x.textContent + ':' + x.getAttribute('aria-pressed')));
      assert(chips.join(',') === 'Groceries:false,Pantry:true', 'remembered: ' + chips.join(','));
      // At home: the button itself says what a tap does, with Leave as is beside it.
      assert((await page.textContent('.sc-add')) === 'Add 1 more (1 at home)', await page.textContent('.sc-add'));
      assert((await page.textContent('.sc-again')) === 'Leave as is', await page.textContent('.sc-again'));
      assert(!(await page.$('.sc-sheet .sc-note')), 'no small print repeating it');
      await shot(page, 'scan-at-home-en.png');
      const small = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('.sc-dest'), (b) => b.getBoundingClientRect().height < 43.5).length);
      assert(!small, 'chips under 44 px');
      await page.click('.sc-add');
      await page.waitForSelector('.sc-toast.is-on');
      assert(/One more added to Pantry/.test(await page.textContent('.sc-toast')), await page.textContent('.sc-toast'));
      await page.waitForTimeout(500);
      assert(hub.pantry.ownedList().find((p) => p.upc === KNOWN).qty === 2, 'counted one more');
      // Leave as is changes nothing.
      await page.waitForTimeout(3100);
      await show(page, KNOWN);
      await page.waitForSelector('.sc-sheet.is-on .sc-add');
      assert((await page.textContent('.sc-add')) === 'Add 1 more (2 at home)', await page.textContent('.sc-add'));
      await page.click('.sc-again');
      await page.waitForTimeout(300);
      assert(hub.pantry.ownedList().find((p) => p.upc === KNOWN).qty === 2, 'left as is');
      // A pasted list: the Pi leaves what is at home even when this phone has not seen it yet.
      await page.evaluate(() => { var d = window.HUB_TOUCH.store ? window.HUB_TOUCH.store.data.pantry : null; if (d) d.products = []; });
      await page.click('.sc-many-toggle');
      await page.fill('.sc-many-in', KNOWN);
      await page.click('.sc-many-go');
      await page.waitForSelector('.sc-bulk-done');
      assert(/is-have/.test(await page.getAttribute('.sc-bulk-row', 'class')), await page.getAttribute('.sc-bulk-row', 'class'));
      await page.waitForTimeout(300);
      assert(hub.pantry.ownedList().find((p) => p.upc === KNOWN).qty === 2, 'not counted twice by a paste');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
      // Spanish: the at-home button and Leave as is fit, accents unclipped.
      const es = await open({ lang: 'es' });
      await openScanner(es);
      await show(es, KNOWN);
      await es.waitForSelector('.sc-sheet.is-on .sc-have');
      assert((await es.textContent('.sc-have')) === 'Ya está en la lista', await es.textContent('.sc-have'));
      await shot(es, 'scan-already-listed-es.png');
      await es.click('.sc-dest[data-dest="pantry"]');
      await es.waitForSelector('.sc-sheet.is-on .sc-add');
      assert((await es.textContent('.sc-add')) === 'Agregar 1 más (2 en casa)', await es.textContent('.sc-add'));
      assert((await es.textContent('.sc-again')) === 'Dejarlo así', await es.textContent('.sc-again'));
      await shot(es, 'scan-at-home-es.png');
      const clipped = await es.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('.sc-have, .sc-add, .sc-again'), (n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).length);
      assert(!clipped, 'clipped in Spanish');
      assert(!es.errors.length, es.errors.join('; '));
      await es.ctx.close();
    });

    await check('files: scan.js and grocery.js are ES5; vendor README names the versions; the TV never loads the scanner', async () => {
      ['app/scan.js', 'app/widgets/grocery.js'].forEach((f) => {
        const js = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert(!/=>|`|\b(let|const|class)\s/.test(js), f + ' is not ES5');
      });
      const readme = fs.readFileSync(path.join(ROOT, 'app/vendor/barcode-detector/README.md'), 'utf8');
      assert(/barcode-detector 3\.2\.4/.test(readme) && /zxing-wasm 3\.1\.7/.test(readme), 'versions');
      ['LICENSE-barcode-detector', 'LICENSE-zxing-wasm', 'barcode-detector.js', 'zxing_reader.wasm'].forEach((f) => {
        assert(fs.existsSync(path.join(ROOT, 'app/vendor/barcode-detector', f)), f);
      });
      const bundle = fs.readFileSync(path.join(ROOT, 'app/vendor/barcode-detector/barcode-detector.js'), 'utf8');
      assert(/ne=`3\.1\.7`/.test(bundle), 'the bundle expects zxing-wasm 3.1.7');
      ['index.html', 'hub.html'].forEach((f) => {
        const html = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
        assert(!/scan\.js|vendor\//.test(html), f + ' loads the scanner');
      });
      const css = fs.readFileSync(path.join(ROOT, 'app/touch.css'), 'utf8');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'touch.css end marker');
    });
  } finally {
    await browser.close();
    await new Promise((r) => hub.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

const REPEAT_WAIT = 3100; // app/scan.js REPEAT_MS: the same code is ignored this long after a resume

main().catch((e) => { console.error(e); process.exit(1); });
