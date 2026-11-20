/*
 * The touch app (app/touch.html, app/touch.js, app/touch.css and
 * app/widgets/grocery.js): node dev/touch-test.js
 *
 * Starts the real Pi server (pi/server.js) on a free port with a throwaway
 * data folder, serving app/ the way the Pi does, and drives the page in
 * headless Chromium: the phone menu lists every widget in app/config.js
 * ("TV only" for those without a touch view), a grocery add, tick, remove
 * and clear round trip reaches the Pi, Spanish through the language switch
 * (each string fits 25% longer, accents unclipped), ?as= overrides, and the
 * offline state. TOUCH_SHOTS=dir/ keeps screenshots (device scale 2).
 * Needs Playwright. Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const hubServer = require('../pi/server');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TOUCH_SHOTS || '';
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

// Widget ids the config names (the same rule as app/touch.js catalog()).
function configIds() {
  const box = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
  const c = box.c, ids = {};
  c.layout.forEach((e) => { ids[e.widget] = 1; });
  c.layouts.forEach((l) => (l.layout || []).forEach((e) => { ids[e.widget] = 1; }));
  return Object.keys(ids);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-touch-'));
  const hub = hubServer.start({ port: 0, token: 'touch-test-token-0123456789abcdef', log: false, dataDir: dataDir, appDir: path.join(ROOT, 'app') });
  await hub.ready;
  const base = 'http://127.0.0.1:' + hub.port;
  const browser = await chromium.launch();
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
  const tablet = { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, hasTouch: true };

  async function open(opts, url, lang) {
    const ctx = await browser.newContext(opts);
    if (lang) await ctx.addInitScript((l) => { try { localStorage.setItem('homeHub.lang', l); } catch (e) { /* */ } }, lang);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + (url || '/'));
    await page.waitForSelector('.t-app');
    page.errors = errors;
    page.ctx = ctx;
    return page;
  }
  const groceryItems = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).resources.grocery.data.items;

  try {
    await check('GET / redirects to the touch app, and the page loads with no script error', async () => {
      const page = await open(phone);
      assert(/\/app\/touch\.html$/.test(page.url()), page.url());
      await page.waitForSelector('.t-pill.is-ok', { timeout: 5000 });
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('phone menu lists every widget in config.js, touch ones first, the rest "TV only" and disabled', async () => {
      const page = await open(phone);
      const seen = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('[data-widget]'), (n) => ({
        id: n.getAttribute('data-widget'), tv: n.classList.contains('is-tv'), badge: (n.querySelector('.t-badge') || {}).textContent || '',
        disabled: n.getAttribute('aria-disabled') === 'true', tag: n.tagName
      })));
      assert(seen[0].id === 'grocery' && !seen[0].tv && seen[0].tag === 'A', JSON.stringify(seen[0]));
      const ids = seen.map((s) => s.id);
      const missing = configIds().filter((id) => ids.indexOf(id) < 0);
      assert(!missing.length, 'missing: ' + missing.join(', '));
      seen.slice(1).forEach((s) => assert(s.tv && s.badge === 'TV only' && s.disabled && s.tag === 'LI', JSON.stringify(s)));
      assert(ids.indexOf('budget') < 0, 'the budget settings group is not a widget');
      // Every row is a big target.
      const small = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('button, a'), (b) => {
        const r = b.getBoundingClientRect();
        return r.width && (r.height < 47.5 || r.width < 47.5);
      }).map((b) => b.className));
      assert(!small.length, 'targets under 48 px: ' + small.join(', '));
      await page.evaluate(() => fetch('/grocery/ops', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Touch': '1' },
        body: JSON.stringify({ ops: ['Oat milk', 'Eggs', 'Sourdough bread', 'Bananas', 'Coffee beans', 'Spinach'].map((n) => ({ op: 'add', name: n })) }) }));
      await page.evaluate(() => window.HUB_TOUCH.poll());
      await page.waitForFunction(() => /6 to get/.test(document.querySelector('.t-row-datum').textContent));
      await shot(page, 'phone-menu-en.png');
      await page.ctx.close();
    });

    await check('phone: grocery add (commas), tick, remove with undo, clear: each reaches the Pi', async () => {
      const page = await open(phone, '/app/touch.html#/grocery');
      await page.waitForSelector('.gx-input');
      assert(await page.locator('.t-back').isVisible(), 'a back button');
      await page.fill('.gx-input', 'Milk, avocados; eggs');
      await page.press('.gx-input', 'Enter');
      await page.waitForFunction(() => document.querySelectorAll('.gx-row:not(.is-pending)').length === 8);
      assert(/Already on the list: Eggs/.test(await page.textContent('.gx-note')), 'already note');
      assert(groceryItems().length === 8 && groceryItems().some((i) => i.name === 'avocados'), JSON.stringify(groceryItems()));
      assert((await page.textContent('.gx-big')) === '8', 'count 8');
      await page.click('.gx-row[data-id="' + groceryItems().find((i) => i.name === 'Bananas').id + '"] .gx-tick');
      await page.waitForFunction(() => document.querySelectorAll('.gx-list-done .gx-row').length === 1);
      await new Promise((r) => setTimeout(r, 300));
      assert(groceryItems().find((i) => i.name === 'Bananas').done === true, 'ticked on the Pi');
      assert((await page.textContent('.gx-big')) === '7', 'count 7');
      const spinach = groceryItems().find((i) => i.name === 'Spinach').id;
      await page.click('.gx-row[data-id="' + spinach + '"] .gx-del');
      await page.waitForSelector('.gx-toast.is-on');
      await page.waitForFunction(() => !document.querySelector('.gx-row.is-pending'));
      await new Promise((r) => setTimeout(r, 200));
      assert(!groceryItems().some((i) => i.name === 'Spinach'), 'removed on the Pi');
      await page.click('.gx-undo');
      await page.waitForFunction(() => /Spinach/.test(document.querySelector('.gx-list').textContent));
      await new Promise((r) => setTimeout(r, 300));
      assert(groceryItems().some((i) => i.name === 'Spinach' && !i.done), 'undo put it back');
      await shot(page, 'phone-grocery-en.png');
      await page.click('.gx-clear');
      await page.waitForFunction(() => !document.querySelector('.gx-list-done .gx-row'));
      await new Promise((r) => setTimeout(r, 200));
      assert(!groceryItems().some((i) => i.done), 'cleared on the Pi');
      // Buy again: a name this phone added that is gone now; one tap brings it back.
      assert(await page.locator('.gx-chip').count() === 0, 'no chips while all this phone added is on the list');
      await page.click('.gx-row[data-id="' + groceryItems().find((i) => i.name === 'avocados').id + '"] .gx-del');
      await page.waitForSelector('.gx-chip');
      assert(/^avocados$/.test((await page.textContent('.gx-chips')).trim()), await page.textContent('.gx-chips'));
      await page.click('.gx-chip');
      await page.waitForFunction(() => !document.querySelector('.gx-chip') && /avocados/.test(document.querySelector('.gx-list').textContent));
      await page.click('.t-back');
      await page.waitForSelector('.t-menu');
      assert(!page.errors.length, page.errors.join('; '));
      await page.ctx.close();
    });

    await check('a change from elsewhere (Claude) shows within a poll', async () => {
      const page = await open(phone, '/app/touch.html#/grocery');
      await page.waitForSelector('.gx-row');
      await page.evaluate(() => fetch('/grocery/ops', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Touch': '1' }, body: JSON.stringify({ ops: [{ op: 'add', name: 'Lemons' }] }) }));
      await page.waitForFunction(() => /Lemons/.test(document.querySelector('.gx-list').textContent), null, { timeout: 5000 });
      await page.ctx.close();
    });

    await check('Spanish via the language switch: no English left, 25% longer still fits, accents unclipped', async () => {
      const page = await open(phone);
      await page.click('.t-lang-btn[lang="es"]');
      await page.waitForFunction(() => document.documentElement.lang === 'es');
      const menu = await page.textContent('.t-menu');
      ['On this screen', 'On the TV', 'TV only', 'to get', 'Groceries'].forEach((w) => assert(menu.indexOf(w) < 0, 'English left: ' + w));
      assert(/Lista del súper/.test(menu) && /Solo en la TV/.test(menu) && /por comprar/.test(menu), menu.slice(0, 200));
      await shot(page, 'phone-menu-es.png');
      await page.click('a.t-row.is-touch');
      await page.waitForSelector('.gx-input');
      const body = await page.textContent('.t-view');
      assert(/por comprar/.test(body) && /Agregar/.test(body), 'Spanish grocery view');
      assert(await page.getAttribute('.gx-input', 'placeholder') === 'Leche, huevos, pan', 'placeholder');
      await page.waitForTimeout(400); // the slide-in ends
      await shot(page, 'phone-grocery-es.png');
      // Every text box grows by a quarter: nothing may overflow sideways or clip vertically.
      const bad = await page.evaluate(() => {
        const out = [];
        const sel = '.t-bar-title, .t-back-word, .gx-big-word, .gx-cart, .gx-add-word, .gx-note, .gx-label, .gx-clear, .gx-name, .t-pill-word, .gx-empty-title, .gx-empty-text';
        document.querySelectorAll(sel).forEach((n) => {
          if (!n.textContent) return;
          n.textContent = n.textContent + ' ' + n.textContent.slice(0, Math.ceil(n.textContent.length / 4)) + 'Ñá';
        });
        document.querySelectorAll(sel).forEach((n) => {
          const r = n.getBoundingClientRect();
          if (r.width <= 1) return; // visually hidden (read aloud only)
          const lh = parseFloat(getComputedStyle(n).lineHeight) / parseFloat(getComputedStyle(n).fontSize);
          if (lh < 1.29) out.push(n.className + ' line-height ' + lh.toFixed(2));
          if (r.right > window.innerWidth + 0.5 && !n.closest('.t-bar-title')) out.push(n.className + ' past the edge');
          if (n.scrollHeight > n.clientHeight + 1 && getComputedStyle(n).overflow !== 'visible') out.push(n.className + ' clipped');
        });
        if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways');
        return out;
      });
      assert(!bad.length, bad.join('; '));
      await page.ctx.close();
    });

    await check('tablet: widgets side by side with the widget list, no menu first', async () => {
      const page = await open(tablet, '/app/touch.html', 'en');
      await page.waitForSelector('.t-panes .gx-input');
      const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.t-panes')).gridTemplateColumns.split(' ').length);
      assert(cols === 2, 'columns ' + cols);
      assert(await page.evaluate(() => window.HUB_TOUCH.device()) === 'tablet', 'tablet');
      await page.waitForFunction(() => document.querySelector('.gx-big').textContent !== '–');
      await shot(page, 'tablet-en.png');
      await page.ctx.close();
    });

    await check('?as= overrides the width: ?as=phone on a tablet, ?as=tablet and ?as=tv on a phone', async () => {
      let page = await open(tablet, '/app/touch.html?as=phone');
      assert(await page.locator('.t-menu').count() === 1, 'phone menu on a tablet');
      await page.ctx.close();
      page = await open(phone, '/?as=tablet');
      assert(/as=tablet/.test(page.url()), 'the query survives the redirect');
      assert(await page.locator('.t-panes').count() === 1, 'panes on a phone');
      await page.ctx.close();
      page = await open(phone, '/app/touch.html?as=tv');
      assert(await page.locator('.t-tvnote').count() === 1, 'tv note');
      await page.ctx.close();
    });

    await check('offline: the hub gone shows the banner and the status, then recovers', async () => {
      const page = await open(phone, '/app/touch.html#/grocery');
      await page.waitForSelector('.gx-row');
      await page.route('**/touch/state', (r) => r.abort());
      await page.evaluate(() => window.HUB_TOUCH.poll());
      await page.waitForSelector('.gx-banner.is-on');
      assert(await page.locator('.t-pill.is-offline').count() === 1, 'offline pill');
      await page.unroute('**/touch/state');
      await page.click('.t-pill');
      await page.waitForSelector('.t-pill.is-ok');
      assert(await page.locator('.gx-banner.is-on').count() === 0, 'banner gone');
      await page.ctx.close();
    });

    await check('a refused change rolls back and says so', async () => {
      const page = await open(phone, '/app/touch.html#/grocery');
      await page.waitForSelector('.gx-row');
      const before = await page.locator('.gx-row').count();
      await page.route('**/grocery/ops', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"ok":false,"error":"the grocery list is full (200 items)"}' }));
      await page.fill('.gx-input', 'Capers');
      await page.press('.gx-input', 'Enter');
      await page.waitForSelector('.gx-banner.is-on');
      assert(/didn.t save: the grocery list is full/.test(await page.textContent('.gx-banner')), await page.textContent('.gx-banner'));
      assert(await page.locator('.gx-row').count() === before, 'rolled back');
      await page.ctx.close();
    });

    await check('files: touch.css ends with .css-end; grocery.js is plain ES5; the TV pages never load touch.js or touch.css', async () => {
      const css = fs.readFileSync(path.join(ROOT, 'app/touch.css'), 'utf8');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'touch.css end marker');
      const js = fs.readFileSync(path.join(ROOT, 'app/widgets/grocery.js'), 'utf8');
      assert(!/=>|`|\b(let|const|class)\s/.test(js), 'grocery.js is not ES5');
      ['index.html', 'hub.html'].forEach((f) => {
        const html = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
        assert(!/touch\.(js|css)/.test(html), f + ' loads a touch file');
      });
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
