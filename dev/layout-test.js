/*
 * Tile layout from the Pi, end to end: node dev/layout-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js)
 * and the hub server from pi/, on spare ports with a fresh data folder:
 * the TV-side layout check, the saved layout at start, a new layout that
 * moves tiles in place, waiting while a panel is open, a new set of widgets
 * that reloads once, the reset, the guard against a reload loop, and
 * config.js's Budget layout with Budget lab.
 * Needs Playwright (require('playwright')).
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * Nothing here reaches the internet.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

// app/config.js's layout with Weather and Now Playing swapped: the same widgets.
const SWAPPED = [
  { widget: 'today',         x: 0, y: 0, w: 3, h: 1 },
  { widget: 'calendar',      x: 3, y: 0, w: 3, h: 4 },
  { widget: 'awws',          x: 6, y: 0, w: 3, h: 4 },
  { widget: 'nowplaying',    x: 9, y: 0, w: 3, h: 2 },
  { widget: 'todo',          x: 0, y: 1, w: 3, h: 4 },
  { widget: 'mirror',        x: 9, y: 2, w: 3, h: 2 },
  { widget: 'wotd',          x: 9, y: 4, w: 3, h: 2 },
  { widget: 'ambiance',      x: 3, y: 4, w: 6, h: 1 },
  { widget: 'weather',       x: 0, y: 5, w: 3, h: 1 },
  { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
];

// Fewer widgets: a different set, so the hub reloads.
const SMALL = [
  { widget: 'today',         x: 0, y: 0, w: 3, h: 2 },
  { widget: 'entertainment', x: 3, y: 0, w: 9, h: 2 },
  { widget: 'todo',          x: 0, y: 2, w: 6, h: 4 },
  { widget: 'weather',       x: 6, y: 2, w: 6, h: 4 }
];

let PAGE_PORT, LIVE_PORT, PAGE, LIVE;
let dataDir;
let preview = null;
let pi = null;
let browser = null;
const openContexts = new Set();
const results = [];

/* ---------- small helpers ---------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function assert(cond, text) {
  if (!cond) throw new Error(text);
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

function waitForPort(port) {
  return until(() => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/', timeout: 500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  }), 10000, 'port ' + port + ' did not open');
}

function control(method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: LIVE_PORT, path: route, method: method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('not JSON: ' + out.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function setLayout(layout) {
  const r = await control('POST', '/api/layout', { layout: layout });
  assert(r.ok, 'the server refused the layout: ' + JSON.stringify(r));
  return r;
}

/* ---------- pages ---------- */

async function newContext(initScript) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  context.log = { errors: [] };
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const url = route.request().url();
    for (const host of BLOCKED_HOSTS) {
      if (url.indexOf('://' + host + '/') > 0 || url.indexOf('://' + host + ':') > 0) return route.abort();
    }
    return route.continue();
  });
  if (initScript) await context.addInitScript(initScript);
  return context;
}

// Opens the hub and counts its loads (a reload adds one).
async function openHub(context, query) {
  const page = await context.newPage();
  page.loads = 0;
  page.on('load', () => { page.loads++; });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = (msg.location() && msg.location().url) || '';
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    context.log.errors.push(msg.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.log.errors.push('page error: ' + e.message));
  await page.goto(PAGE + '/' + (query ? '?' + query : ''));
  await ready(page);
  return page;
}

function ready(page) {
  return page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 10000 });
}

function liveQuery() { return 'live=' + encodeURIComponent(LIVE); }

const look = {
  ids: (page) => page.$$eval('#grid .cell', (els) => els.map((e) => e.getAttribute('data-widget')).sort()),
  cell: (page, id) => page.evaluate((w) => {
    const c = document.querySelector('.cell[data-widget="' + w + '"]');
    return c ? { left: c.style.left, top: c.style.top, width: c.style.width, height: c.style.height } : null;
  }, id),
  home: (page, id) => page.evaluate((w) => window.HUB_TEST.homeRects()[w], id),
  focused: (page) => page.evaluate(() => {
    const t = document.querySelector('#grid .tile.is-focused');
    return t ? t.parentNode.getAttribute('data-widget') : null;
  }),
  open: (page) => page.evaluate(() => window.HUB_TEST.busy() ? 'busy' : window.HUB_TEST.open()),
  saved: (page) => page.evaluate(() => { try { return localStorage.getItem('homeHub.layout'); } catch (e) { return 'error'; } }),
  live: (page) => page.evaluate(() => window.HUB_LIVE ? window.HUB_LIVE.status().state : 'none')
};

// The browser rounds the percentages it hands back (33.3333%), so compare loosely.
function near(text, n, of) { return /%$/.test(text) && Math.abs(parseFloat(text) - n / of * 100) < 0.01; }

async function cellAt(page, id, x, y, w, h) {
  const c = await look.cell(page, id);
  return !!c && near(c.left, x, 12) && near(c.top, y, 6) && near(c.width, w, 12) && near(c.height, h, 6);
}

function noErrors(context) {
  const errors = context.log.errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e));
  assert(!errors.length, 'console errors: ' + errors.join(' | '));
}

async function waitIdle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
}

/* ---------- the checks ---------- */

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(true);
    console.log('ok    ' + name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    results.push(false);
    console.log('FAIL  ' + name + ': ' + (e && e.message));
  }
  for (const c of Array.from(openContexts)) {
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

async function checkValidator() {
  const context = await newContext();
  const page = await openHub(context, 'live=off');
  const out = await page.evaluate(() => {
    const clean = window.HUB_TEST.cleanLayout;
    const t = (o) => Object.assign({ widget: 'weather', x: 0, y: 0, w: 3, h: 2 }, o);
    const many = [];
    for (let i = 0; i < 30; i++) many.push({ widget: 't' + i, x: i % 12, y: Math.floor(i / 12), w: 1, h: 1 });
    return {
      good: clean([t({ note: 'dropped' }), t({ widget: 'todo', x: 3, h: 4 })]),
      notList: [clean(null), clean({}), clean('x'), clean([])],
      skipped: clean([
        5, null, t({ widget: 'Bad' }), t({ widget: 'my_tile' }), t({ widget: 'a'.repeat(33) }),
        t({ x: 1.5 }), t({ w: '3' }), t({ x: -1 }), t({ w: 0 }), t({ x: 10 }), t({ y: 5 }),
        t({ widget: 'keep' }), t({ widget: 'keep', x: 6 }), t({ widget: 'over', x: 2, y: 1 }), t({ widget: 'next', x: 3 })
      ]),
      nothing: clean([t({ w: 99 })]),
      capped: clean(many).length
    };
  });
  assert(JSON.stringify(out.good) === JSON.stringify([{ widget: 'weather', x: 0, y: 0, w: 3, h: 2 }, { widget: 'todo', x: 3, y: 0, w: 3, h: 4 }]),
    'good: ' + JSON.stringify(out.good));
  assert(out.notList.every((v) => v === null), 'not a list: ' + JSON.stringify(out.notList));
  assert(JSON.stringify(out.skipped) === JSON.stringify([{ widget: 'keep', x: 0, y: 0, w: 3, h: 2 }, { widget: 'next', x: 3, y: 0, w: 3, h: 2 }]),
    'skipped: ' + JSON.stringify(out.skipped));
  assert(out.nothing === null, 'nothing valid: ' + JSON.stringify(out.nothing));
  assert(out.capped === 24, 'at most 24: ' + out.capped);
  noErrors(context);
}

async function checkSavedAtStart() {
  // A saved layout is used at start.
  let context = await newContext(() => { try { localStorage.setItem('homeHub.layout', JSON.stringify([
    { widget: 'weather', x: 0, y: 0, w: 6, h: 3 }, { widget: 'todo', x: 6, y: 0, w: 6, h: 6 }, { widget: 'nope', x: 0, y: 3, w: 6, h: 3 }
  ])); } catch (e) { /* ignore */ } });
  let page = await openHub(context, 'live=off');
  let ids = await look.ids(page);
  assert(JSON.stringify(ids) === '["todo","weather"]', 'tiles from the saved layout: ' + JSON.stringify(ids));
  assert(await cellAt(page, 'weather', 0, 0, 6, 3), 'weather cell: ' + JSON.stringify(await look.cell(page, 'weather')));
  assert(await cellAt(page, 'todo', 6, 0, 6, 6), 'todo cell: ' + JSON.stringify(await look.cell(page, 'todo')));
  noErrors(context);
  await context.close();

  // Broken, unusable or unknown-only saved layouts fall back to config.js.
  for (const saved of ['{not json', JSON.stringify([{ widget: 'weather', x: 0, y: 0, w: 99, h: 1 }]), JSON.stringify([{ widget: 'nope', x: 0, y: 0, w: 1, h: 1 }]), '"text"']) {
    context = await newContext(`try { localStorage.setItem('homeHub.layout', ${JSON.stringify(saved)}); } catch (e) {}`);
    page = await openHub(context, 'live=off');
    ids = await look.ids(page);
    assert(ids.length === 10, 'fallback for ' + saved + ': ' + JSON.stringify(ids));
    assert(await cellAt(page, 'weather', 9, 0, 3, 2), 'weather where config.js puts it, for ' + saved + ': ' + JSON.stringify(await look.cell(page, 'weather')));
    noErrors(context);
    await context.close();
  }

  // Storage that throws on every call: the built-in layout, no errors.
  context = await newContext(() => {
    const no = () => { throw new Error('storage blocked'); };
    Storage.prototype.getItem = no;
    Storage.prototype.setItem = no;
    Storage.prototype.removeItem = no;
  });
  page = await openHub(context, 'live=off');
  assert((await look.ids(page)).length === 10, 'blocked storage: tiles');
  noErrors(context);
}

async function checkMove() {
  await setLayout(null);
  const context = await newContext();
  const page = await openHub(context, liveQuery());
  await until(async () => (await look.live(page)) === 'live', 8000, 'the hub did not go live');
  await waitIdle(page);
  await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 6000, 'the frosted glass never came on');
  assert((await look.focused(page)) === 'entertainment', 'start focus: ' + (await look.focused(page)));
  // With config.js's layout, Left from Entertainment reaches Now Playing.
  await page.keyboard.press('ArrowLeft');
  assert((await look.focused(page)) === 'nowplaying', 'Left before: ' + (await look.focused(page)));
  await page.keyboard.press('ArrowRight');
  assert((await look.focused(page)) === 'entertainment', 'Right before: ' + (await look.focused(page)));
  const before = await look.home(page, 'weather');
  await page.evaluate(() => { window.__sameLoad = true; });

  await setLayout(SWAPPED);
  await until(() => cellAt(page, 'weather', 0, 5, 3, 1), 4000, 'the weather tile did not move');
  assert(await cellAt(page, 'nowplaying', 9, 0, 3, 2), 'now playing did not move');
  const after = await look.home(page, 'weather');
  const today = await look.home(page, 'nowplaying');
  assert(after.left < before.left && after.left < today.left, 'measured rects: ' + JSON.stringify({ before, after, today }));
  assert(await page.evaluate(() => window.__sameLoad === true) && page.loads === 1, 'the page reloaded (loads ' + page.loads + ')');
  assert((await look.ids(page)).length === 10, 'tile count changed');
  // Focus follows the new places: Left from Entertainment now reaches Weather.
  assert((await look.focused(page)) === 'entertainment', 'focus moved by itself');
  await page.keyboard.press('ArrowLeft');
  assert((await look.focused(page)) === 'weather', 'Left after: ' + (await look.focused(page)));
  // The glass lines up with the tile's new place.
  const glass = await page.evaluate(() => {
    const t = document.querySelector('.cell[data-widget="weather"] .tile');
    const home = window.HUB_TEST.homeRects().weather;
    return { gx: t.style.getPropertyValue('--gx'), want: -(home.left + t.clientLeft) + 'px' };
  });
  assert(glass.gx === glass.want, 'glass: ' + JSON.stringify(glass));
  const saved = JSON.parse(await look.saved(page));
  assert(JSON.stringify(saved) === JSON.stringify(SWAPPED), 'saved: ' + JSON.stringify(saved));
  assert(JSON.stringify(await page.evaluate(() => window.HUB_TEST.layout())) === JSON.stringify(SWAPPED), 'HUB_TEST.layout');

  // Reset: back to config.js, also in place, and the saved copy is gone.
  await setLayout(null);
  await until(() => cellAt(page, 'weather', 9, 0, 3, 2), 4000, 'reset did not move weather back');
  assert(page.loads === 1, 'reset reloaded');
  assert((await look.saved(page)) === null, 'saved copy not cleared: ' + (await look.saved(page)));
  noErrors(context);
}

async function checkWaitsForPanel() {
  await setLayout(null);
  const context = await newContext();
  const page = await openHub(context, liveQuery());
  await until(async () => (await look.live(page)) === 'live', 8000, 'the hub did not go live');
  await waitIdle(page);
  await page.click('.cell[data-widget="todo"] .tile');
  await until(async () => (await look.open(page)) === 'todo', 4000, 'the to-do panel did not open');
  await setLayout(SWAPPED);
  await until(() => page.evaluate(() => window.HUB_TEST.layoutWaiting()), 4000, 'the layout did not arrive');
  await sleep(300);
  assert(await cellAt(page, 'weather', 9, 0, 3, 2), 'a tile moved while the panel was open');
  assert(await look.saved(page), 'the layout was not saved while waiting');
  await waitIdle(page);
  await sleep(350);
  await page.keyboard.press('Escape');
  await until(async () => (await look.open(page)) === null, 4000, 'the panel did not close');
  await until(() => cellAt(page, 'weather', 0, 5, 3, 1), 4000, 'the tile did not move after closing');
  assert(page.loads === 1, 'reloaded');
  assert((await look.focused(page)) === 'todo', 'focus after close: ' + (await look.focused(page)));
  noErrors(context);
}

async function checkReload() {
  await setLayout(null);
  const context = await newContext();
  const page = await openHub(context, liveQuery());
  await until(async () => (await look.live(page)) === 'live', 8000, 'the hub did not go live');
  await waitIdle(page);
  await setLayout(SMALL);
  await until(() => page.loads >= 2, 6000, 'the hub did not reload for a new set of widgets');
  await ready(page);
  await until(async () => JSON.stringify(await look.ids(page)) === '["entertainment","today","todo","weather"]', 4000, 'tiles after the reload');
  assert(await cellAt(page, 'weather', 6, 2, 6, 4), 'weather after the reload');
  await until(async () => (await look.live(page)) === 'live', 8000, 'not live after the reload');
  await sleep(1500);
  assert(page.loads === 2, 'reloaded more than once: ' + page.loads);
  assert(await page.evaluate(() => { try { return sessionStorage.getItem('homeHub.layout.reloaded'); } catch (e) { return 'error'; } }) === null,
    'the reload note was not cleared after a good start');

  // Reset brings the full set back: one more reload, and the saved copy is gone.
  await setLayout(null);
  await until(() => page.loads >= 3, 6000, 'no reload for the reset');
  await ready(page);
  await until(async () => (await look.ids(page)).length === 10, 4000, 'tiles after the reset');
  await sleep(1500);
  assert(page.loads === 3, 'loads after the reset: ' + page.loads);
  assert((await look.saved(page)) === null, 'saved copy after reset');
  noErrors(context);
}

async function checkNoLoop() {
  await setLayout(null);
  // localStorage that cannot save: after the reload the hub starts with
  // config.js again, the Pi still says SMALL, and it must not reload again.
  const context = await newContext(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'homeHub.layout') throw new Error('storage full');
      return real.call(this, k, v);
    };
  });
  const page = await openHub(context, liveQuery());
  await until(async () => (await look.live(page)) === 'live', 8000, 'the hub did not go live');
  await waitIdle(page);
  await setLayout(SMALL);
  await until(() => page.loads >= 2, 6000, 'the hub did not reload once');
  await ready(page);
  await until(async () => (await look.live(page)) === 'live', 8000, 'not live after the reload');
  await sleep(2500);
  assert(page.loads === 2, 'reload loop: ' + page.loads + ' loads');
  assert((await look.ids(page)).length === 10, 'tiles: ' + JSON.stringify(await look.ids(page)));
  noErrors(context);
}

async function checkBudgetLayout() {
  // config.js's "Budget" layout: Budget lab at 4 x 3 under Daily room, the
  // whole grid covered, every tile drawn, and Down from Daily room reaches it.
  await setLayout(null);
  const box = { window: {} };
  require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + ';this.C = HUB_CONFIG;', box);
  const budget = box.C.layouts.filter((l) => l.id === 'budget')[0].layout;
  const cells = {};
  for (const t of budget) {
    for (let x = t.x; x < t.x + t.w; x++) for (let y = t.y; y < t.y + t.h; y++) {
      assert(!cells[x + ',' + y], 'overlap at ' + x + ',' + y);
      cells[x + ',' + y] = t.widget;
    }
  }
  assert(Object.keys(cells).length === 72, 'gaps: ' + Object.keys(cells).length + ' of 72 cells');
  const lab = budget.filter((t) => t.widget === 'budget-lab')[0];
  assert(lab && lab.x === 0 && lab.y === 3 && lab.w === 4 && lab.h === 3, 'budget-lab: ' + JSON.stringify(lab));
  const context = await newContext();
  const page = await openHub(context, liveQuery());
  await until(async () => (await look.live(page)) === 'live', 8000, 'the hub did not go live');
  await waitIdle(page);
  await setLayout(budget);
  await until(() => page.loads >= 2, 6000, 'the hub did not reload for the Budget layout');
  await ready(page);
  await until(async () => JSON.stringify(await look.ids(page)) === JSON.stringify(budget.map((t) => t.widget).sort()), 4000, 'tiles on the Budget layout');
  assert(await cellAt(page, 'budget-lab', 0, 3, 4, 3), 'budget-lab cell: ' + JSON.stringify(await look.cell(page, 'budget-lab')));
  await waitIdle(page);
  await page.evaluate(() => { const t = document.querySelector('.cell[data-widget="budget-room"] .tile'); if (t) t.click(); });
  await until(async () => (await look.open(page)) === 'budget-room', 4000, 'Daily room did not open');
  await page.keyboard.press('Escape');
  await until(async () => (await look.open(page)) === null, 4000, 'the panel did not close');
  await waitIdle(page);
  await page.keyboard.press('ArrowDown');
  assert((await look.focused(page)) === 'budget-lab', 'Down from Daily room: ' + (await look.focused(page)));
  await setLayout(null);
  noErrors(context);
}

/* ---------- run ---------- */

async function main() {
  PAGE_PORT = await spare();
  LIVE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  LIVE = 'http://127.0.0.1:' + LIVE_PORT;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-layout-test-'));

  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await waitForPort(PAGE_PORT);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  pi = server.start({ token: TOKEN, port: LIVE_PORT, host: '127.0.0.1', origins: [PAGE], dataDir: dataDir, log: false });
  await pi.ready;
  browser = await chromium.launch();

  await check('1. The TV checks a layout the way the Pi does, skipping bad entries', checkValidator);
  await check('2. A saved layout is used at start; a bad one falls back to config.js', checkSavedAtStart);
  await check('3. Same widgets: tiles move in place, focus and glass follow; reset moves back', checkMove);
  await check('4. A layout waits while a panel is open, then applies', checkWaitsForPanel);
  await check('5. A new set of widgets reloads once; the reset reloads once more', checkReload);
  await check('6. A layout that cannot be saved does not reload in a loop', checkNoLoop);
  await check('7. config.js\'s Budget layout: Budget lab at 4 x 3 under Daily room, no gaps', checkBudgetLayout);
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  if (pi) await new Promise((r) => pi.close(r));
  if (preview) preview.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
