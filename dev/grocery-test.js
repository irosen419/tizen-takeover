/*
 * Groceries on the TV (app/widgets/grocery.js, grocery.css): node dev/grocery-test.js
 *
 * Runs the real hub in headless Chromium against the Pi's hub server from
 * pi/ (in this process, with a throwaway data folder) and the preview for
 * the page (needs port 8095 free, like the other browser tests). Nothing
 * here reaches the internet. Checks:
 *
 *   - grocery.js is plain ES5 and Node can still require its logic; the CSS
 *     has no grid, no flex gap, animates only transform and opacity and ends
 *     with .css-end; hub.html loads both, touch.html still loads the file.
 *   - The tile at 1x1, 3x1, 3x2, 3x4 and 6x2 in English and in Spanish with
 *     every grocery text 25% longer (Á É ñ ¿ ¡): what each size shows,
 *     nothing outside the tile, nothing cut sideways but an item name, every
 *     text line at least 1.3 times its type. An empty list says so; with no
 *     Pi the tile waits quietly (hub-dormant).
 *   - The panel: OK ticks a row at once (before the Pi answers) and focus
 *     stays on that row (data-key); Right goes to its Remove, OK twice
 *     removes; the Add box takes "a, b" as two items, says "Already on the
 *     list" and "At most 60 characters"; Clear ticked. Each reaches the Pi.
 *   - A change from elsewhere (the control API, as a phone or Claude would)
 *     replaces the list on the tile and in the open panel.
 *   - A refused post (400) and an unreachable Pi each take the change back
 *     with a toast, and nothing throws.
 *   - The log names the TV as a screen and never an item.
 *
 * --shots <folder> (or GROCERY_SHOTS) saves pictures at device scale 2: the
 * tile at 3x2 and 3x4 and the open panel, in English and Spanish, and a
 * focused row. Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const OCEAN_JPG = fs.readFileSync(path.join(ROOT, 'app', 'backgrounds', 'ocean.jpg'));
const argShots = process.argv.indexOf('--shots');
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.GROCERY_SHOTS || '');
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
function api(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Authorization: 'Bearer ' + TOKEN };
    const req = http.request({ host: '127.0.0.1', port: port, path: route, method: method, headers: headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) { j = out; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/* Spanish 25% longer: every grocery text grown (with Á, É, ñ, ¿, ¡). */
const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚÁÉñ¿¡áéíóú";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k) || !/^grocery\\./.test(k)) continue;' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.replace(/\\{\\w+\\}/g, "").length * 0.25)); es[k] = s + add.slice(0, n); } })();\n';

const SIZES = [[1, 1], [3, 1], [3, 2], [3, 4], [6, 2]];
const LIST = ['Milk', 'Eggs', 'Sourdough bread', 'Bananas', 'Oat milk', 'Spinach', 'Coffee beans', 'Árboles de Navidad pequeños para la mesa'];

const env = { lines: [] };

async function startPi() {
  const port = await spare();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-grocery-'));
  const server = require('../pi/server').start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [env.PAGE], dataDir: dataDir, allowHttp: true,
    calendars: [], log: (s) => env.lines.push(String(s))
  });
  await Promise.resolve(server.ready);
  await until(() => getOk('http://127.0.0.1:' + port + '/health'), 5000, 'the hub server did not start');
  return { port: port, url: 'http://127.0.0.1:' + port, server: server, dataDir: dataDir };
}

// The list on the Pi: these names (newest first, as the Pi keeps them), the
// ones in `ticked` ticked.
async function seed(names, ticked) {
  const cur = (await api(env.pi.port, 'GET', '/api/grocery')).body.items;
  const ops = cur.map((i) => ({ op: 'remove', id: i.id }));
  names.slice().reverse().forEach((n) => ops.push({ op: 'add', name: n }));
  let r = await api(env.pi.port, 'POST', '/api/grocery/ops', { ops: ops.length ? ops : [{ op: 'clear' }] });
  assert(r.status === 200, 'seed: ' + JSON.stringify(r.body));
  const tick = r.body.items.filter((i) => (ticked || []).indexOf(i.name) >= 0).map((i) => ({ op: 'check', id: i.id, done: true }));
  if (tick.length) r = await api(env.pi.port, 'POST', '/api/grocery/ops', { ops: tick });
  return r.body.items;
}
async function piItems() { return (await api(env.pi.port, 'GET', '/api/grocery')).body.items; }

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
  const layout = o.layout || [{ widget: 'grocery', x: 0, y: 0, w: 3, h: 4 }, { widget: 'today', x: 3, y: 0, w: 3, h: 2 }];
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('gt-seeded')) return;
      sessionStorage.setItem('gt-seeded', '1');
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, { 'homeHub.layout': JSON.stringify(layout), 'homeHub.layoutChoice': JSON.stringify({ id: 'test', piSig: '' }), 'homeHub.lang': o.lang || 'en' });
  const live = o.live === false ? 'off' : encodeURIComponent(env.pi.url);
  await page.goto(env.PAGE + '/?motion=fade&clay=off&live=' + live + (o.lang ? '&lang=' + o.lang : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="grocery"] .tile'), null, { timeout: 15000 });
  if (o.live !== false) await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 10000, 'the hub did not go live');
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(500);
  page.ctx = context;
  return page;
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) { await page.keyboard.press(k); await sleep(110); }
}
async function openPanel(page) {
  assert(await page.evaluate(() => window.HUB_TEST.openPanel('grocery')), 'no panel');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'grocery' && !window.HUB_TEST.busy() && !!document.querySelector('#panel .gt-panel')), 5000, 'the panel did not open');
  await sleep(300);
}
function focused(page) {
  return page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || 'hub' : ''; });
}
function keyOf(items, name, prefix) { const it = items.find((i) => i.name === name); return (prefix || 'item:') + (it ? it.id : '?'); }
function toast(page) { return page.evaluate(() => { const t = document.getElementById('toast'); return t ? t.textContent : ''; }); }
function panelState(page) {
  return page.evaluate(() => ({
    left: [].map.call(document.querySelectorAll('#panel .gt-sec-left .gt-name'), (n) => n.textContent),
    done: [].map.call(document.querySelectorAll('#panel .gt-sec-done .gt-name'), (n) => n.textContent),
    pending: document.querySelectorAll('#panel .gt-row.is-pending').length
  }));
}
function tileText(page) {
  return page.evaluate(() => { const b = document.querySelector('.cell[data-widget="grocery"] .tile-body'); return b ? b.innerText.replace(/\s+/g, ' ').trim() : ''; });
}

/* What the tile shows, and every fit problem in it. */
function measureTile(page) {
  return page.evaluate(() => {
    const tile = document.querySelector('.cell[data-widget="grocery"] .tile');
    const body = tile.querySelector('.tile-body');
    const b = tile.getBoundingClientRect();
    const problems = [];
    const shown = (el) => { for (let e = el; e && e !== tile; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false; return true; };
    tile.querySelectorAll('.tile-body *, .tile-title').forEach((el) => {
      if (!shown(el) || !el.textContent.trim() || el.closest('svg')) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const name = (el.className.baseVal === undefined ? el.className : 'svg') + ' "' + el.textContent.slice(0, 24) + '"';
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) problems.push(name + ' is outside the tile');
      const named = /\bgt-t?name\b/.test(el.className);
      if (!named && cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 1 && el.closest('.tile-body')) problems.push(name + ' is cut sideways');
      if (el.children.length) return;
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      if (el.closest('.tile-body') && lh && lh < fs * 1.3 - 0.3 && !/gt-hero-num|gt-one-num/.test(el.className)) problems.push(name + ' line-height ' + (lh / fs).toFixed(2));
    });
    return {
      problems: problems,
      text: body.innerText.replace(/\s+/g, ' ').trim(),
      rows: body.querySelectorAll('.gt-trow').length,
      done: body.querySelectorAll('.gt-trow.is-done').length,
      dormant: !!body.querySelector('.hub-dormant'),
      tier: (body.querySelector('.gt-tile') || { className: '' }).className
    };
  });
}

async function shot(page, file, sel) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
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
  env.pi = await startPi();
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();

  try {
    await check('grocery.js is plain ES5 and still a Node module; hub.html loads it and grocery.css; touch.html still loads it', () => {
      let acorn = null;
      for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
        try { acorn = require(p); break; } catch (e) { /* next */ }
      }
      const text = fs.readFileSync(path.join(ROOT, 'app/widgets/grocery.js'), 'utf8');
      if (acorn) acorn.parse(text, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
      const G = require('../app/widgets/grocery.js');
      assert(typeof G.parseAdd === 'function' && typeof G.applyLocal === 'function', 'the logic is not exported');
      const hub = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      assert(hub.indexOf('widgets/grocery.js') > 0 && hub.indexOf('widgets/grocery.css') > 0, 'hub.html');
      assert(hub.indexOf('widgets/grocery.js') < hub.indexOf('src="hub.js"'), 'grocery.js after hub.js');
      assert(!/touch\.(js|css)/.test(hub), 'hub.html loads a touch file');
      assert(fs.readFileSync(path.join(ROOT, 'app/touch.html'), 'utf8').indexOf('widgets/grocery.js') > 0, 'touch.html');
    });

    await check('grocery.css: no grid, no flex gap, only transform and opacity animate, ends with .css-end', () => {
      const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'grocery.css'), 'utf8');
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/display\s*:\s*(inline-)?grid|grid-template/.test(bare), 'CSS grid');
      assert(!/(^|[\s;{])(row-|column-)?gap\s*:/.test(bare), 'flex gap');
      assert(!/oklch|dvh|filter\s*:/.test(bare), 'oklch, dvh or a filter');
      const frames = bare.match(/@(-webkit-)?keyframes[^{]+\{([^{}]*\{[^}]*\})+\s*\}/g) || [];
      frames.forEach((f) => {
        (f.match(/([a-z-]+)\s*:/g) || []).map((p) => p.replace(/\s*:$/, '')).forEach((p) => assert(/^(-webkit-)?(transform|opacity)$/.test(p), 'a keyframe animates ' + p));
      });
      assert(!/transition\s*:/.test(bare), 'a transition');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'no .css-end at the end');
    });

    await seed(LIST, ['Eggs', 'Spinach']);

    for (const v of [{ name: 'English', lang: 'en' }, { name: 'Spanish +25%', lang: 'es', grow: true }]) {
      await check('the tile at ' + SIZES.map((s) => s[0] + 'x' + s[1]).join(', ') + ' in ' + v.name + ': what each size shows, nothing outside it or clipped', async () => {
        const page = await open({ lang: v.lang, grow: v.grow, layout: [{ widget: 'grocery', x: 0, y: 0, w: 1, h: 1 }] });
        const out = [];
        const es = v.lang === 'es';
        for (const s of SIZES) {
          await page.evaluate((l) => { localStorage.setItem('homeHub.layout', JSON.stringify(l)); }, [{ widget: 'grocery', x: 0, y: 0, w: s[0], h: s[1] }]);
          await page.reload();
          await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="grocery"] .gt-tile'), null, { timeout: 15000 });
          await until(() => page.evaluate(() => !document.querySelector('.cell[data-widget="grocery"] .hub-dormant')), 8000, 'the list did not arrive');
          await sleep(600);
          const r = await measureTile(page);
          const where = s[0] + 'x' + s[1];
          if (r.problems.length) out.push(where + ': ' + r.problems.slice(0, 3).join(', '));
          if (s[0] === 1) { if (r.text !== '6') out.push(where + ': shows "' + r.text + '"'); }
          else if (s[1] === 1) {
            if (!(es ? /quedan 6/ : /6 left/).test(r.text) || r.text.indexOf('Milk') < 0) out.push(where + ': strip "' + r.text + '"');
          } else {
            if (!/^6/.test(r.text) || !(es ? /por comprar/ : /to get/).test(r.text)) out.push(where + ': no count "' + r.text.slice(0, 30) + '"');
            if (r.rows < 1) out.push(where + ': no rows');
            if (r.rows < 8 && !(es ? /\+\d+ más/ : /\+\d+ more/).test(r.text)) out.push(where + ': ' + r.rows + ' rows and no "+N more"');
            if (!(es ? /2 en el carrito/ : /2 in the cart/).test(r.text)) out.push(where + ': no cart count');
            if (s[1] >= 4 && r.rows < 5) out.push(where + ': only ' + r.rows + ' rows');
            if (r.rows >= 8 && r.done !== 2) out.push(where + ': ticked rows ' + r.done);
          }
        }
        assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
        await page.ctx.close();
        assert(!out.length, out.join('; '));
      });
    }

    await check('an empty list says so; with no Pi the tile waits quietly (hub-dormant)', async () => {
      await seed([]);
      let page = await open({});
      await until(async () => /List is empty/.test(await tileText(page)), 5000, 'no empty text');
      await openPanel(page);
      assert(await focused(page) === 'add', 'focus on an empty list: ' + await focused(page));
      await page.ctx.close();
      page = await open({ live: false });
      const r = await measureTile(page);
      assert(r.dormant && /lives on the Pi/.test(r.text), JSON.stringify(r));
      assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
      await page.ctx.close();
    });

    const items = await seed(['Milk', 'Eggs', 'Bread', 'Apples'], ['Apples']);
    const page = await open({});
    env.page = page;

    await check('panel: OK ticks the row at once, the Pi gets it, focus stays on that row', async () => {
      await openPanel(page);
      const milk = keyOf(items, 'Milk');
      assert(await focused(page) === milk, 'first focus ' + await focused(page));
      // Hold the post so what shows before the Pi answers can be seen.
      let release;
      const held = new Promise((r) => { release = r; });
      await page.route(/\/grocery\/ops$/, async (route) => { await held; route.continue().catch(() => {}); });
      await key(page, 'Enter');
      let s = await panelState(page);
      assert(s.done.indexOf('Milk') >= 0 && s.left.indexOf('Milk') < 0, 'not ticked at once: ' + JSON.stringify(s));
      assert(await focused(page) === milk, 'focus moved to ' + await focused(page));
      assert(!(await piItems()).find((i) => i.name === 'Milk').done, 'the Pi had it before the post');
      release();
      await page.unroute(/\/grocery\/ops$/);
      await until(async () => (await piItems()).find((i) => i.name === 'Milk').done, 4000, 'the Pi did not get the tick');
      await sleep(300);
      assert(await focused(page) === milk, 'focus after the answer ' + await focused(page));
      // OK again unticks it.
      await key(page, 'Enter');
      await until(async () => !(await piItems()).find((i) => i.name === 'Milk').done, 4000, 'the Pi did not get the untick');
      if (SHOTS) {
        await sleep(300);
        // (pictures come from a scale-2 page below)
      }
    });

    await check('panel: Right goes to the row\'s Remove; OK twice removes it on the Pi; focus goes to the next row', async () => {
      // Focus is on Milk (top of To get after the untick).
      const list = await piItems();
      await key(page, 'ArrowDown');
      const eggs = keyOf(list, 'Eggs');
      assert(await focused(page) === eggs, 'down went to ' + await focused(page));
      await key(page, 'ArrowRight');
      assert(await focused(page) === keyOf(list, 'Eggs', 'del:'), 'right went to ' + await focused(page));
      await key(page, 'Enter');
      assert(await page.evaluate(() => !!document.querySelector('#panel .gt-del.is-armed.is-focused')), 'not armed');
      assert((await piItems()).some((i) => i.name === 'Eggs'), 'removed on the first OK');
      await sleep(500);
      await key(page, 'Enter');
      await until(async () => !(await piItems()).some((i) => i.name === 'Eggs'), 4000, 'the Pi still has Eggs');
      const f = await focused(page);
      assert(f === keyOf(list, 'Bread'), 'focus after remove ' + f);
    });

    await check('panel: the Add box takes "Pears, oranges" as two items; "Already on the list" and the length limit are toasts', async () => {
      for (let i = 0; i < 6 && await focused(page) !== 'add'; i++) await key(page, 'ArrowUp');
      assert(await focused(page) === 'add', 'not on the Add box: ' + await focused(page));
      await key(page, 'Enter');
      await page.keyboard.type('Pears, oranges');
      await key(page, 'Enter');
      await until(async () => { const l = await piItems(); return l.some((i) => i.name === 'Pears') && l.some((i) => i.name === 'oranges'); }, 4000, 'the Pi did not get both');
      await until(async () => (await panelState(page)).left.indexOf('Pears') >= 0 && !(await panelState(page)).pending, 3000, 'not in the panel');
      assert(await page.evaluate(() => document.querySelector('#panel .gt-input').value) === '', 'the box kept the text');
      await key(page, 'Enter');
      await page.keyboard.type('bread');
      await key(page, 'Enter');
      await until(async () => /Already on the list: Bread/.test(await toast(page)), 2000, 'no already toast');
      await key(page, 'Enter');
      await page.keyboard.type('x'.repeat(61));
      await key(page, 'Enter');
      await until(async () => /At most 60 characters/.test(await toast(page)), 2000, 'no too-long toast');
      assert(await page.evaluate(() => document.querySelector('#panel .gt-input').value.length) === 61, 'the long text was dropped');
      await page.evaluate(() => { document.querySelector('#panel .gt-input').value = ''; });
      assert((await piItems()).length === 5, 'the Pi has ' + (await piItems()).length);
    });

    await check('panel: Clear ticked drops the ticked items on the Pi', async () => {
      await page.evaluate(() => window.HUB_TEST.closePanel());
      await sleep(300);
      if (await page.evaluate(() => window.HUB_TEST.open()) !== 'grocery') await openPanel(page);
      const clear = await page.evaluate(() => !!document.querySelector('#panel .gt-clear'));
      assert(clear, 'no Clear ticked button');
      // Walk down until Clear ticked has focus.
      for (let i = 0; i < 12 && await focused(page) !== 'clear'; i++) await key(page, 'ArrowDown');
      assert(await focused(page) === 'clear', 'never reached Clear: ' + await focused(page));
      await key(page, 'Enter');
      await until(async () => !(await piItems()).some((i) => i.done), 4000, 'the Pi still has ticked items');
      assert(!(await page.evaluate(() => !!document.querySelector('#panel .gt-sec-done'))), 'the In the cart section stayed');
    });

    await check('a change from elsewhere replaces the list on the tile and in the open panel', async () => {
      await api(env.pi.port, 'POST', '/api/grocery/ops', { ops: [{ op: 'add', name: 'Lemons' }] });
      await until(async () => (await panelState(page)).left[0] === 'Lemons', 4000, 'the panel did not get Lemons');
      await page.evaluate(() => window.HUB_TEST.closePanel());
      const cur = await piItems();
      await api(env.pi.port, 'POST', '/api/grocery/ops', { ops: cur.map((i) => ({ op: 'remove', id: i.id })).concat([{ op: 'add', name: 'Tea' }]) });
      await until(async () => /^1 to get Tea/.test(await tileText(page)), 4000, 'the tile did not change');
    });

    await check('a refused post and an unreachable Pi each take the change back with a toast; nothing throws', async () => {
      await seed(['Rice', 'Beans']);
      await sleep(400);
      if (await page.evaluate(() => window.HUB_TEST.open()) !== 'grocery') await openPanel(page);
      await until(async () => (await panelState(page)).left.length === 2, 3000, 'not two rows');
      await page.route(/\/grocery\/ops$/, (route) => route.fulfill({ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': env.PAGE }, body: '{"ok":false,"error":"the grocery list is full (200 items)"}' }));
      const first = await focused(page);
      await key(page, 'Enter');
      await until(async () => /didn.t save: the grocery list is full/.test(await toast(page)), 3000, 'no refused toast');
      await until(async () => (await panelState(page)).done.length === 0, 2000, 'not rolled back');
      assert(await focused(page) === first, 'focus ' + await focused(page));
      await page.unroute(/\/grocery\/ops$/);
      await page.route(/\/grocery\/ops$/, (route) => route.abort());
      await key(page, 'Enter');
      await until(async () => /didn.t save: the Pi didn.t answer/.test(await toast(page)), 3000, 'no unreachable toast');
      await until(async () => (await panelState(page)).done.length === 0, 2000, 'not rolled back');
      await page.unroute(/\/grocery\/ops$/);
      assert(!(await piItems()).some((i) => i.done), 'the Pi changed');
      assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
    });

    await check('the log names the TV as a screen and never an item', () => {
      assert(env.lines.some((l) => /screen changed the grocery list/.test(l)), 'no screen line');
      const names = ['Milk', 'Eggs', 'Bread', 'Pears', 'oranges', 'Lemons', 'Tea', 'Rice', 'Beans'];
      const bad = env.lines.filter((l) => names.some((n) => l.indexOf(n) >= 0));
      assert(!bad.length, bad.length + ' log lines name an item');
    });
    await page.ctx.close();

    if (SHOTS) {
      await check('pictures (device scale 2): tile 3x2 and 3x4, the panel, EN and ES, a focused row', async () => {
        await seed(['Milk', 'Eggs', 'Sourdough bread', 'Bananas', 'Oat milk', 'Spinach', 'Coffee beans'], ['Eggs', 'Spinach']);
        for (const lang of ['en', 'es']) {
          const layout = [
            { widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'grocery', x: 3, y: 0, w: 3, h: 4 }, { widget: 'calendar', x: 6, y: 0, w: 3, h: 4 },
            { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'todo', x: 0, y: 2, w: 3, h: 4 }, { widget: 'nowplaying', x: 9, y: 2, w: 3, h: 2 },
            { widget: 'entertainment', x: 3, y: 4, w: 6, h: 2 }, { widget: 'wotd', x: 9, y: 4, w: 3, h: 2 }];
          let p = await open({ lang: lang, scale: 2, layout: layout });
          await shot(p, 'tile-3x4-' + lang + '.png', '.cell[data-widget="grocery"] .tile');
          await openPanel(p);
          await sleep(600);
          await shot(p, 'panel-' + lang + '.png', '#panel');
          if (lang === 'en') {
            await key(p, 'ArrowDown');
            await key(p, 'ArrowRight');
            await sleep(300);
            await shot(p, 'panel-focus-remove-en.png', '#panel');
            await key(p, 'ArrowLeft');
            await sleep(200);
            await shot(p, 'panel-focus-row-en.png', '#panel');
          }
          await p.ctx.close();
          p = await open({ lang: lang, scale: 2, layout: [{ widget: 'grocery', x: 0, y: 0, w: 3, h: 2 }, { widget: 'today', x: 3, y: 0, w: 3, h: 1 }] });
          await shot(p, 'tile-3x2-' + lang + '.png', '.cell[data-widget="grocery"] .tile');
          await p.ctx.close();
        }
      });
    }
  } finally {
    await env.browser.close();
    await new Promise((r) => env.pi.server.close(r));
    env.preview.kill();
    fs.rmSync(env.pi.dataDir, { recursive: true, force: true });
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
