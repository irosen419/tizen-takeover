/*
 * The Pantry phone view (app/widgets/pantry.js, pantry.css): node dev/pantry-test.js
 *
 * Starts the real Pi server (pi/server.js with pi/pantrydb.js, web lookups
 * off) on a throwaway data folder and drives the touch app at phone size in
 * headless Chromium. Checks: Stock lists owned items low first with the
 * Low badge and its restock value; the stepper changes the count and a drop
 * to the restock point puts the item on the grocery list (the cart fills);
 * place chips filter; Usual items search ignores case and accents; the row
 * sheet saves place, restock, auto-add, mode, unit, and picks an existing
 * brand for a differently spelled one (never a second brand), refusing a
 * number out of range; Spanish has no English left and 25% longer strings
 * still fit with accents unclipped; tap targets are 44 px or more; files.
 * PANTRY_SHOTS=dir keeps screenshots (default /mnt/project-files/pantry/shots
 * when that folder's parent exists). Needs Playwright.
 * Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const hubServer = require('../pi/server');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.PANTRY_SHOTS !== undefined ? process.env.PANTRY_SHOTS
  : (fs.existsSync('/mnt/project-files/pantry') ? '/mnt/project-files/pantry/shots' : '');
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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pantry-ui-'));
  const hub = hubServer.start({ port: 0, token: 'pantry-ui-token-0123456789abcdef', log: false, dataDir: dataDir, appDir: path.join(ROOT, 'app'), products: { web: false } });
  await hub.ready;
  const base = 'http://127.0.0.1:' + hub.port;
  const browser = await chromium.launch();
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
  const small = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

  const post = (ops) => fetch(base + '/pantry/ops', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Hub-Touch': '1' }, body: JSON.stringify({ ops: ops })
  }).then((r) => r.json());
  const groceryItems = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).resources.grocery.data.items;
  const byName = (n) => hub.pantry.ownedList().find((p) => p.name === n);

  async function open(opts) {
    opts = opts || {};
    const ctx = await browser.newContext(opts.size || phone);
    await ctx.addInitScript((l) => { try { localStorage.setItem('homeHub.lang', l); } catch (e) { /* */ } }, opts.lang || 'en');
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/app/touch.html#/pantry');
    await page.waitForSelector('.px-row');
    page.errors = errors;
    page.ctx = ctx;
    return page;
  }
  const texts = (page, sel) => page.$$eval(sel, (n) => n.map((x) => x.textContent));

  // The house, seeded the way the phone or Claude would.
  const seeded = await post([
    { op: 'brand', name: 'Lala' },
    { op: 'add', name: 'Eggs', qty: 7, location: 'fridge' },
    { op: 'add', name: 'Leche entera', brand: 'Lala', qty: 1, location: 'fridge' },
    { op: 'add', name: 'Paper towels', qty: 2, location: 'pantry' },
    { op: 'add', name: 'Café molido tostado oscuro para cafetera de goteo', brand: 'Café Bustelo', qty: 3, location: 'pantry' },
    { op: 'add', name: 'Frozen peas', qty: 4, location: 'freezer' }
  ]);

  try {
    await check('the Pi took the seed (5 items, one low)', async () => {
      assert(seeded.ok && seeded.data.counts.items === 5 && seeded.data.counts.low === 1, JSON.stringify(seeded.data && seeded.data.counts));
    });

    await check('Stock: low first with "Low · buy at n", brand over name, the menu line counts low', async () => {
      const page = await open();
      const names = await texts(page, '.px-row .px-name');
      assert(names[0] === 'Leche entera', 'low first: ' + names.join(' | '));
      assert((await page.textContent('.px-row.is-low .px-badge')) === 'Low · buy at 1', await page.textContent('.px-row.is-low .px-badge'));
      assert((await page.textContent('.px-row.is-low .px-brand')) === 'Lala', 'brand over name');
      assert((await page.textContent('.px-big')) === '1', 'big low count');
      assert((await page.textContent('.px-total')) === '5 at home', await page.textContent('.px-total'));
      const towels = await page.$$eval('.px-row', (rows) => rows.filter((r) => /Paper towels/.test(r.textContent)).map((r) => r.querySelector('.px-at').textContent));
      assert(towels[0] === 'Buy at 1', 'two rolls of paper towels is not low: ' + towels[0]);
      await shot(page, 'pantry-stock-en.png');
      await page.goto(base + '/app/touch.html#');
      await page.waitForSelector('[data-widget="pantry"]');
      assert((await page.textContent('[data-widget="pantry"] .t-row-datum')) === '1 low', 'menu line');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('stepper: one less takes Eggs to 6, which puts them on the grocery list once (the cart fills)', async () => {
      const page = await open();
      const eggs = byName('Eggs');
      const row = '.px-row[data-id="' + eggs.id + '"]';
      assert((await page.textContent(row + ' .px-qty')) === '7', 'starts at 7');
      await page.click(row + ' .px-step-btn[aria-label="One less"]');
      await page.waitForFunction((r) => document.querySelector(r + ' .px-qty').textContent === '6' && document.querySelector(r + ' .px-cart').getAttribute('aria-pressed') === 'true', row);
      await page.waitForTimeout(300);
      assert(byName('Eggs').qty === 6 && byName('Eggs').onList, JSON.stringify(byName('Eggs')));
      assert(groceryItems().filter((i) => i.name === 'Eggs').length === 1, 'one grocery row');
      await page.click(row + ' .px-step-btn[aria-label="One less"]');
      await page.waitForTimeout(500);
      assert(groceryItems().filter((i) => i.name === 'Eggs').length === 1, 'never a second row');
      assert((await page.textContent(row + ' .px-badge')) === 'Low · buy at 6', 'eggs default to 6');
      // The cart button takes it off by hand.
      await page.click(row + ' .px-cart');
      await page.waitForFunction((r) => document.querySelector(r + ' .px-cart').getAttribute('aria-pressed') === 'false', row);
      await page.waitForTimeout(300);
      assert(!groceryItems().some((i) => i.name === 'Eggs'), 'off the list');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('place chips filter and wrap; Usual items search ignores case and accents', async () => {
      const page = await open();
      await page.click('.px-chip:has-text("Fridge")');
      let names = await texts(page, '.px-row .px-name');
      assert(names.length === 2 && names.indexOf('Eggs') >= 0 && names.indexOf('Leche entera') >= 0, names.join(' | '));
      await page.click('.px-chip:has-text("All")');
      await page.click('.px-seg-btn:has-text("Usual items")');
      await page.waitForSelector('.px-search-input', { state: 'visible' });
      await page.fill('.px-search-input', 'CAFE');
      names = await texts(page, '.px-row .px-name');
      assert(names.length === 1 && /Café molido/.test(names[0]), 'cafe: ' + names.join(' | '));
      await page.fill('.px-search-input', 'bustélo');
      names = await texts(page, '.px-row .px-name');
      assert(names.length === 1, 'brand search: ' + names.join(' | '));
      await page.fill('.px-search-input', 'lala leche');
      names = await texts(page, '.px-row .px-name');
      assert(names.length === 1 && names[0] === 'Leche entera', 'brand and name: ' + names.join(' | '));
      await page.fill('.px-search-input', 'zzz');
      assert(/Nothing matches/.test(await page.textContent('.px-empty')), 'no match');
      await page.fill('.px-search-input', '');
      await shot(page, 'pantry-usual-en.png');
      // The name clamps to two lines.
      const clamp = await page.$eval('.px-row .px-name', () => {
        const n = Array.prototype.find.call(document.querySelectorAll('.px-name'), (x) => /Café molido/.test(x.textContent));
        return { h: n.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(n).lineHeight) };
      });
      assert(clamp.h <= clamp.lh * 2 + 3, 'two lines at most: ' + JSON.stringify(clamp));
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('row sheet: number boxes refuse a bad value; saves place, restock, auto-add, mode, unit; "lála" picks the brand Lala', async () => {
      const page = await open();
      const towels = byName('Paper towels');
      await page.click('.px-row[data-id="' + towels.id + '"] .px-open');
      await page.waitForSelector('.px-sheet.is-on');
      assert(await page.getAttribute('.px-restock input', 'type') === 'number' && await page.getAttribute('.px-buy input', 'type') === 'number', 'number inputs');
      assert(await page.$eval('.px-unit select', (s) => s.tagName) === 'SELECT', 'unit is a select');
      await page.fill('.px-restock input', '1000');
      await page.click('.px-sheet .px-primary');
      assert(/from 0 to 999/.test(await page.textContent('.px-restock .px-error')), 'range message');
      assert(await page.isVisible('.px-sheet'), 'the sheet stays open');
      await page.fill('.px-restock input', '3');
      await page.click('.px-sheet .px-chip:has-text("Other")');
      await page.click('.px-switch');
      assert(await page.getAttribute('.px-switch', 'aria-checked') === 'false', 'switch off');
      await page.selectOption('.px-mode select', 'contact_me');
      await page.selectOption('.px-unit select', 'pack');
      await page.fill('.px-size input', '6');
      await page.fill('.px-picker-brand input', 'lála');
      const opts = await texts(page, '.px-picker-brand .px-option');
      assert(opts.length === 1 && opts[0] === 'Lala', 'an existing brand, no create option: ' + opts.join(' | '));
      await page.click('.px-picker-brand .px-option');
      await page.fill('.px-picker-category input', 'paper');
      await page.click('.px-picker-category .px-option:has-text("Paper goods")');
      await shot(page, 'pantry-sheet-en.png');
      await page.click('.px-sheet .px-primary');
      await page.waitForSelector('.px-sheet', { state: 'detached' });
      await page.waitForTimeout(400);
      const t = byName('Paper towels');
      assert(t.restockAt === 3 && t.location === 'other' && t.autoAdd === false && t.mode === 'contact_me' && t.unit === 'pack' && t.size === 6, JSON.stringify(t));
      assert(t.brand === 'Lala' && hub.pantry.view([]).data.brands.length === 2, 'one Lala: ' + JSON.stringify(hub.pantry.view([]).data.brands.map((b) => b.name)));
      // A new brand is created once, under the spelling typed first.
      await page.click('.px-row[data-id="' + t.id + '"] .px-open');
      await page.waitForSelector('.px-sheet.is-on');
      await page.fill('.px-picker-brand input', 'Bounty');
      assert((await texts(page, '.px-picker-brand .px-option')).join('|') === 'Add “Bounty”', 'create option');
      await page.click('.px-picker-brand .px-option');
      await page.click('.px-sheet .px-primary');
      await page.waitForTimeout(400);
      assert(byName('Paper towels').brand === 'Bounty', 'new brand');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('typing a name adds it to the pantry in the chosen place', async () => {
      const page = await open();
      await page.click('.px-chip:has-text("Freezer")');
      await page.fill('.px-add .px-input', 'Ice cream');
      await page.press('.px-add .px-input', 'Enter');
      await page.waitForFunction(() => /Ice cream/.test(document.querySelector('.px-list').textContent) && !document.querySelector('.px-row.is-pending'));
      await page.waitForTimeout(300);
      const ice = byName('Ice cream');
      assert(ice && ice.location === 'freezer' && ice.qty === 1 && ice.restockAt === 2, JSON.stringify(ice));
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('tap targets are 44 px or more; nothing scrolls sideways at 360 px', async () => {
      const page = await open({ size: small });
      const bad = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('.px button, .px input'), (b) => {
        const r = b.getBoundingClientRect();
        return r.width && (r.height < 43.5 || r.width < 43.5);
      }).map((b) => b.className));
      assert(!bad.length, 'small: ' + bad.join(', '));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sideways scroll');
      await page.ctx.close();
    });

    await check('Spanish at 360 px: no English left, 25% longer still fits, accents unclipped (rows, chips, sheet)', async () => {
      const page = await open({ lang: 'es', size: small });
      const english = async (scope) => {
        const t = await page.evaluate((s) => {
          const root = document.querySelector(s);
          return root.innerText + ' ' + Array.prototype.map.call(root.querySelectorAll('[aria-label], [placeholder]'), (n) => (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('placeholder') || '')).join(' ');
        }, scope);
        return ['Stock', 'Usual', 'All', 'Fridge', 'Freezer', 'Other', 'Low', 'Buy at', 'at home', 'Add', 'Scan', 'Search', 'Edit', 'One less', 'One more', 'grocery list', 'Save', 'Remove', 'Brand', 'Category', 'Size', 'Unit', 'Close', 'Place', 'automatically', 'None']
          .filter((w) => new RegExp('\\b' + w + '\\b').test(t));
      };
      let left = await english('.px');
      assert(!left.length, 'English left: ' + left.join(', '));
      assert((await page.textContent('.px-row.is-low .px-badge')).indexOf('Por acabarse') === 0, 'badge');
      await shot(page, 'pantry-stock-es.png');
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
          if (lh < 1.35 - 0.001) out.push(n.className + ' line-height ' + lh.toFixed(2));
          if (r.right > window.innerWidth + 0.5 || r.left < -0.5) out.push(n.className + ' past the edge');
          // The two-line name clamps on purpose (ellipsis); anything else must not clip.
          if (!/px-name/.test(n.className) && n.scrollHeight > n.clientHeight + 1 && cs.overflow !== 'visible') out.push(n.className + ' clipped');
          const b = n.closest('button');
          if (b && b.scrollWidth > b.clientWidth + 1) out.push(b.className + ' text wider than the button');
        });
        if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways');
        return out;
      }, sel);
      let bad = await inflate('.px-big-word, .px-total, .px-seg-btn, .px-chip, .px-btn-word, .px-badge, .px-at, .px-where, .px-brand, .px-name');
      assert(!bad.length, 'view: ' + bad.join('; '));
      await shot(page, 'pantry-stock-es-125.png');
      await page.reload();
      await page.waitForSelector('.px-row');
      await page.click('.px-row .px-open');
      await page.waitForSelector('.px-sheet.is-on');
      await page.waitForTimeout(300);
      left = await english('.px-sheet');
      assert(!left.length, 'sheet English left: ' + left.join(', '));
      await shot(page, 'pantry-sheet-es.png');
      bad = await inflate('.px-sheet .px-field-label, .px-sheet .px-hint, .px-sheet .px-chip, .px-sheet .px-btn-word, .px-sheet-title, .px-picked-name');
      assert(!bad.length, 'sheet: ' + bad.join('; '));
      await shot(page, 'pantry-sheet-es-125.png');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('files: pantry.js is ES5; pantry.css ends with .css-end, is in the loader list and touch.html; the TV never loads pantry.js', async () => {
      const js = fs.readFileSync(path.join(ROOT, 'app/widgets/pantry.js'), 'utf8');
      assert(!/=>|`|\b(let|const|class)\s/.test(js), 'pantry.js is not ES5');
      const css = fs.readFileSync(path.join(ROOT, 'app/widgets/pantry.css'), 'utf8');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'end marker');
      assert(/widgets\/grocery\.css widgets\/pantry\.css/.test(fs.readFileSync(path.join(ROOT, 'dev/styles-test.js'), 'utf8')), 'ORDER');
      const touch = fs.readFileSync(path.join(ROOT, 'app/touch.html'), 'utf8');
      assert(/widgets\/pantry\.css/.test(touch) && /widgets\/pantry\.js/.test(touch), 'touch.html');
      const hubHtml = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      assert(/widgets\/pantry\.css/.test(hubHtml) && !/widgets\/pantry\.js/.test(hubHtml), 'hub.html: css only');
      assert(!/^\s*\.(?!px|css-end)[\w-]+/m.test(css.replace(/body\.px-open/g, '')), 'only .px rules (the TV links this file)');
    });
  } finally {
    await browser.close();
    await new Promise((r) => hub.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
