/*
 * The clay wanderers (app/clay.js): node dev/clay-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js,
 * with its own hub server on a spare port): nothing clay loads before the
 * first scene; nothing plays before idle; every scene plays to the end with
 * no console errors, leaves nothing behind and only ever changes transform
 * and opacity; a key press clears the screen in the same tick and focus
 * still moves; a panel clears and blocks scenes; a layout change ends one;
 * clay: false and ?clay=off load nothing; a missing sprite skips the scene;
 * night hours pick night scenes; a ticked to-do item queues a cheer.
 * Needs Playwright and port 8095 free.
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

const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

// config.js's layout with Weather and Now Playing swapped: the same widgets, so no reload.
const SWAPPED = [
  { widget: 'today',         x: 0, y: 0, w: 3, h: 1 },
  { widget: 'calendar',      x: 3, y: 0, w: 3, h: 4 },
  { widget: 'awws',          x: 6, y: 0, w: 3, h: 4 },
  { widget: 'nowplaying',    x: 9, y: 0, w: 3, h: 2 },
  { widget: 'todo',          x: 0, y: 1, w: 3, h: 4 },
  { widget: 'mirror',        x: 9, y: 2, w: 3, h: 4 },
  { widget: 'ambiance',      x: 3, y: 4, w: 6, h: 1 },
  { widget: 'weather',       x: 0, y: 5, w: 3, h: 1 },
  { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
];

// Every scene, and the variants that use other frames.
const PLAYS = [
  ['stroll', { dir: 'right' }], ['stroll', { dir: 'left' }],
  ['fetch', { dir: 'right' }], ['fetch', { dir: 'left' }],
  ['sock-heist', {}], ['zoomies', {}],
  ['perch', { pose: 'sit-edge' }], ['perch', { pose: 'lie-chin' }], ['perch', { pose: 'climb' }],
  ['morning', {}], ['evening', {}], ['night', { nap: true }], ['night', { nap: false }],
  ['weather', { outfit: 'umbrella' }], ['weather', { outfit: 'sunny' }], ['weather', { outfit: 'cold' }],
  ['weather', { outfit: 'hot' }], ['weather', { outfit: 'windy' }],
  ['cheer', {}], ['shrug', {}]
];

let PAGE_PORT, LIVE_PORT, PAGE, LIVE;
let preview = null;
let browser = null;
let dataDir = null;
const openContexts = new Set();
const results = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function assert(cond, text) { if (!cond) throw new Error(text); }

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(50);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
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
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('not JSON: ' + out.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/* ---------- pages ---------- */

// opts: { clay: value for HUB_CONFIG.clay (undefined = config.js as it is),
// query, missing: [url parts that answer 404], storage }
async function newHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  context.errors = [];
  context.requests = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    for (const host of BLOCKED_HOSTS) {
      if (url.indexOf('://' + host + '/') > 0 || url.indexOf('://' + host + ':') > 0) return route.abort();
    }
    context.requests.push(url);
    if ((opts.missing || []).some((m) => url.indexOf(m) >= 0)) return route.fulfill({ status: 404, body: 'not found' });
    if (opts.clay !== undefined && /\/config\.js$/.test(url)) {
      const res = await route.fetch();
      const body = (await res.text()) + '\nHUB_CONFIG.clay = ' + JSON.stringify(opts.clay) + ';\n';
      return route.fulfill({ response: res, body: body });
    }
    return route.continue();
  });
  if (opts.storage) {
    await context.addInitScript((items) => {
      try { for (const k in items) localStorage.setItem(k, items[k]); } catch (e) { /* ignore */ }
    }, opts.storage);
  }
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (/Failed to load resource|ERR_CONNECTION_REFUSED|Weather|Live:/.test(text)) return;
    context.errors.push(text);
  });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  await page.goto(PAGE + '/hub.html?' + (opts.query || 'live=off'));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 10000 });
  page.ctx = context;
  return page;
}

function clayRequests(page) {
  return page.ctx.requests.filter((u) => /\/clay\.css|\/clay\//.test(u));
}

function noErrors(page, extra) {
  const errors = page.ctx.errors.filter((e) => !extra || !extra.test(e));
  assert(!errors.length, 'console: ' + errors.join(' | '));
}

const look = {
  state: (page) => page.evaluate(() => window.HUB_TEST.clay.state()),
  layer: (page) => page.evaluate(() => !!document.querySelector('.clay-layer')),
  focused: (page) => page.evaluate(() => {
    const t = document.querySelector('#grid .tile.is-focused');
    return t ? t.parentNode.getAttribute('data-widget') : null;
  })
};

async function playing(page, name, opts) {
  const ok = await page.evaluate(([n, o]) => window.HUB_TEST.clay.play(n, o), [name, opts || {}]);
  assert(ok, name + ' did not start');
  await until(async () => (await look.state(page)).phase === 'playing', 10000, name + ' did not load');
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

async function checkNothingAtStart() {
  const page = await newHub();
  await sleep(3000);
  const st = await look.state(page);
  assert(st.on && st.phase === 'waiting' && st.assets === 'none', 'state: ' + JSON.stringify(st));
  assert(st.nextIn > 15000, 'the first visit is due too soon: ' + st.nextIn);
  assert(!clayRequests(page).length, 'loaded: ' + clayRequests(page).join(', '));
  assert(!(await look.layer(page)), 'a clay layer is there');
  assert(await page.evaluate(() => !document.querySelector('img[src*="clay/"]') && !window.CLAY_SPRITES), 'clay images or the sprite list are there');
  noErrors(page);
}

async function checkWaitsForIdle() {
  const page = await newHub({ clay: { idleAfter: 2, every: [30, 30] } });
  // Keys every 0.8 s for 5 s: never idle long enough.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight');
    await sleep(800);
    const st = await look.state(page);
    assert(st.phase === 'waiting', 'a scene started while keys were pressed: ' + JSON.stringify(st));
  }
  const lastKey = Date.now();
  await until(async () => (await look.state(page)).phase !== 'waiting', 12000, 'no scene came after idle');
  const waited = Date.now() - lastKey;
  assert(waited >= 2000, 'came after only ' + waited + ' ms');
  await until(() => look.layer(page), 10000, 'the scene never showed');
  noErrors(page);
}

// Plays every scene (frame by frame), checking each tick: at most 2
// characters and 3 props, only transform and opacity change, no layout reads.
async function checkEveryScene() {
  const page = await newHub();
  await page.evaluate(() => {
    window.__clay = { bad: [], reads: 0 };
    const parse = (text) => {
      const out = {};
      String(text || '').split(';').forEach((p) => {
        const i = p.indexOf(':');
        if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
      });
      return out;
    };
    const watch = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type !== 'attributes') continue;
        if (m.attributeName !== 'style') { window.__clay.bad.push('attribute ' + m.attributeName); continue; }
        const a = parse(m.oldValue);
        const b = parse(m.target.getAttribute('style'));
        const keys = Object.keys(Object.assign({}, a, b));
        for (const k of keys) if (a[k] !== b[k] && k !== 'transform' && k !== 'opacity') window.__clay.bad.push(k);
      }
    });
    new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (n.className === 'clay-layer') watch.observe(n, { attributes: true, attributeOldValue: true, subtree: true });
        }
      }
    }).observe(document.body, { childList: true });
    // Layout reads made by clay.js while a scene plays.
    const wrap = (proto, name) => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d) return;
      const spy = function () {
        if (window.HUB_TEST.clay.state().phase === 'playing' && /clay\.js/.test(new Error().stack)) window.__clay.reads++;
      };
      if (typeof d.value === 'function') {
        const f = d.value;
        Object.defineProperty(proto, name, Object.assign({}, d, { value: function () { spy(); return f.apply(this, arguments); } }));
      } else if (d.get) {
        const g = d.get;
        Object.defineProperty(proto, name, Object.assign({}, d, { get: function () { spy(); return g.call(this); } }));
      }
    };
    wrap(Element.prototype, 'getBoundingClientRect');
    ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop'].forEach((n) => wrap(HTMLElement.prototype, n));
    window.HUB_TEST.clay.setSpeed(0);
  });
  const names = await page.evaluate(() => window.HUB_TEST.clay.scenes());
  for (const n of names) assert(PLAYS.some((p) => p[0] === n), 'scene ' + n + ' is not in this test');
  for (let i = 0; i < PLAYS.length; i++) {
    const [name, opts] = PLAYS[i];
    const label = name + ' ' + JSON.stringify(opts);
    await playing(page, name, Object.assign({ seed: 100 + i }, opts));
    let ticks = 0;
    let shown = false;
    for (;;) {
      const st = await page.evaluate(() => window.HUB_TEST.clay.step());
      if (st.phase !== 'playing') break;
      assert(st.chars <= 2 && st.props <= 3, label + ': ' + st.chars + ' characters and ' + st.props + ' props at tick ' + st.tick);
      if (st.chars) shown = true;
      assert(++ticks < 900, label + ' never ended');
    }
    const st = await look.state(page);
    assert(st.last && st.last.name === name && st.last.result === 'done', label + ' ended with ' + JSON.stringify(st.last));
    assert(shown, label + ': nobody showed');
    assert(!(await look.layer(page)), label + ' left its layer');
    const seen = await page.evaluate(() => window.__clay);
    assert(!seen.bad.length, label + ' changed ' + seen.bad.slice(0, 5).join(', '));
    assert(!seen.reads, label + ' read the layout ' + seen.reads + ' times while playing');
    // Real time: about 7 ticks a second.
    if (i === 0) {
      const seconds = ticks * 0.14;
      assert(seconds >= 8 && seconds <= 30, 'stroll would last ' + seconds.toFixed(1) + ' s');
    }
  }
  noErrors(page);
}

async function checkKeyClears() {
  const page = await newHub();
  await page.evaluate(() => {
    window.__atKey = [];
    window.addEventListener('keydown', () => { window.__atKey.push(!!document.querySelector('.clay-layer')); });
  });
  await playing(page, 'stroll', { seed: 1, dir: 'right' });
  await until(async () => (await look.state(page)).tick > 12, 5000, 'the scene did not run');
  assert(await look.layer(page), 'no layer while playing');
  const before = await look.focused(page);
  await page.keyboard.press('ArrowLeft');
  const atKey = await page.evaluate(() => window.__atKey);
  assert(atKey.length === 1 && atKey[0] === false, 'the layer was still there when the hub saw the key: ' + JSON.stringify(atKey));
  assert((await look.focused(page)) !== before, 'focus did not move: ' + before);
  const st = await look.state(page);
  assert(st.phase === 'waiting' && st.last.result === 'interrupted', 'state: ' + JSON.stringify(st));
  // A click too.
  await playing(page, 'zoomies', { seed: 2 });
  await page.mouse.click(5, 5);
  assert(!(await look.layer(page)) && (await look.state(page)).phase === 'waiting', 'a click did not clear it');
  noErrors(page);
}

async function checkPanelBlocks() {
  const page = await newHub({ clay: { idleAfter: 1, every: [1, 1] } });
  await playing(page, 'fetch', { seed: 3 });
  await page.evaluate(() => window.HUB_TEST.openPanel('weather'));
  assert(!(await look.layer(page)), 'the layer stayed when a panel opened');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'weather' && !window.HUB_TEST.busy()), 4000, 'the panel did not open');
  assert(!(await page.evaluate(() => window.HUB_TEST.clay.play('stroll'))), 'play() worked with a panel open');
  await page.evaluate(() => window.HUB_TEST.clay.dueIn(0));
  await sleep(4000);
  assert((await look.state(page)).phase === 'waiting' && !(await look.layer(page)), 'a scene came while the panel was open');
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 4000, 'the panel did not close');
  // Idle starts over after the panel: a visit comes again, by itself.
  await until(async () => (await look.state(page)).phase !== 'waiting', 15000, 'no scene after the panel closed');
  noErrors(page);
}

async function checkLayoutEnds() {
  await control('POST', '/api/layout', { layout: null });
  const page = await newHub({ query: 'live=' + encodeURIComponent(LIVE) });
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'not live');
  await playing(page, 'stroll', { seed: 4 });
  const r = await control('POST', '/api/layout', { layout: SWAPPED });
  assert(r.ok, 'the server refused the layout');
  await until(async () => (await look.state(page)).phase === 'waiting', 4000, 'the scene went on after the layout changed');
  assert(!(await look.layer(page)), 'layer left');
  assert((await look.state(page)).last.result === 'interrupted', 'result');
  // A perch on the new layout measures the new tiles.
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(page, 'perch', { seed: 5, pose: 'lie-chin', ledge: 0 });
  await page.evaluate(() => window.HUB_TEST.clay.step());
  await page.evaluate(() => window.HUB_TEST.clay.step());
  const where = await page.evaluate(() => {
    const ys = Object.values(window.HUB_TEST.homeRects()).map((r) => Math.round(r.top));
    const actor = document.querySelector('.clay-actor');
    const m = /translate3d\(([-\d.]+)px, ?([-\d.]+)px/.exec(actor.style.transform);
    return { y: m ? Math.round(parseFloat(m[2])) : null, tops: ys };
  });
  assert(where.tops.some((t) => Math.abs(t + 2 - where.y) <= 1), 'not on a ledge: ' + JSON.stringify(where));
  // A resize ends a scene too.
  await page.evaluate(() => { window.HUB_TEST.clay.stop(); window.HUB_TEST.clay.setSpeed(null); });
  await playing(page, 'zoomies', { seed: 6 });
  await page.setViewportSize({ width: 1920, height: 1000 });
  await until(async () => (await look.state(page)).phase === 'waiting', 4000, 'the scene went on after a resize');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await control('POST', '/api/layout', { layout: null });
  noErrors(page);
}

async function checkOff() {
  for (const opts of [{ clay: false }, { clay: { on: false } }, { query: 'live=off&clay=off' }]) {
    const page = await newHub(opts);
    const st = await look.state(page);
    assert(!st.on && st.phase === 'off', JSON.stringify(opts) + ': ' + JSON.stringify(st));
    assert(!(await page.evaluate(() => window.HUB_TEST.clay.play('stroll'))), JSON.stringify(opts) + ': play() worked');
    await page.keyboard.press('ArrowLeft');
    await sleep(1500);
    assert(!clayRequests(page).length, JSON.stringify(opts) + ' loaded: ' + clayRequests(page).join(', '));
    assert(!(await look.layer(page)), JSON.stringify(opts) + ': layer');
    noErrors(page);
    await page.ctx.close();
  }
}

async function checkMissing() {
  // One frame missing: that scene is skipped, others play, the hub is fine.
  let page = await newHub({ missing: ['clay/sprites/ember/trot-1.webp'] });
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 7 }));
  await until(async () => (await look.state(page)).last, 10000, 'stroll did not finish loading');
  let st = await look.state(page);
  assert(st.phase === 'waiting' && /^failed: missing ember\/trot-1/.test(st.last.result), 'state: ' + JSON.stringify(st));
  assert(!(await look.layer(page)), 'a layer was left');
  const before = await look.focused(page);
  await page.keyboard.press('ArrowLeft');
  assert((await look.focused(page)) !== before, 'focus did not move');
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(5));
  await playing(page, 'perch', { seed: 8, pose: 'sit-edge' });
  await until(async () => (await look.state(page)).phase === 'waiting', 10000, 'perch did not end');
  assert((await look.state(page)).last.result === 'done', 'perch: ' + JSON.stringify((await look.state(page)).last));
  noErrors(page, /Clay: scene stroll skipped/);
  await page.ctx.close();

  // No sprite list at all: nothing shows, nothing breaks.
  page = await newHub({ missing: ['clay/sprites.js'] });
  await page.evaluate(() => window.HUB_TEST.clay.play('fetch', { seed: 9 }));
  await until(async () => (await look.state(page)).last, 10000, 'fetch did not give up');
  st = await look.state(page);
  assert(st.assets === 'failed' && !(await look.layer(page)), 'state: ' + JSON.stringify(st));
  const f0 = await look.focused(page);
  await page.keyboard.press('ArrowLeft');
  assert((await look.focused(page)) !== f0, 'focus did not move');
  noErrors(page, /Clay: the sprite list/);
}

async function checkChoosing() {
  const now = Date.now();
  const page = await newHub({ storage: { 'homeHub.todo.v1': JSON.stringify({ v: 1, items: [
    { id: 'a1', title: 'Walk Ember', section: 'now', done: false, doneAt: null, createdAt: now - 1000 }
  ] }) } });
  const picks = await page.evaluate(() => {
    const C = window.HUB_TEST.clay;
    const out = {};
    for (const h of [23, 2, 5, 14, 7, 20]) {
      C.setHour(h);
      out[h] = [];
      for (let i = 0; i < 40; i++) out[h].push(C.choose());
    }
    C.setHour(null);
    return out;
  });
  for (const h of [23, 2, 5]) assert(picks[h].every((n) => n === 'night'), 'hour ' + h + ': ' + picks[h].join(','));
  assert(picks[14].every((n) => n !== 'night' && n !== 'morning' && n !== 'evening'), 'hour 14: ' + picks[14].join(','));
  assert(picks[7].indexOf('morning') >= 0 && picks[20].indexOf('evening') >= 0, 'no morning or evening scene');
  // Ticking off an item in the To-do panel queues a cheer for the next visit.
  await page.evaluate(() => window.HUB_TEST.openPanel('todo'));
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'todo' && !window.HUB_TEST.busy()), 4000, 'to-do did not open');
  const target = await page.evaluate(() => { const f = document.querySelector('.panel .is-focused'); return f ? f.getAttribute('data-key') : null; });
  assert(target === 'item:a1', 'focus in the to-do panel: ' + target);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 4000, 'to-do did not close');
  const next = await page.evaluate(() => { window.HUB_TEST.clay.setHour(14); return [window.HUB_TEST.clay.choose(), window.HUB_TEST.clay.choose()]; });
  assert(next[0] === 'cheer' && next[1] !== 'cheer', 'after a tick: ' + next.join(','));
  // The weather getter is read-only and gives the sample forecast.
  const w = await until(() => page.evaluate(() => {
    const list = window.HUB_WIDGETS || [];
    for (const x of list) if (x.id === 'weather' && typeof x.current === 'function') return x.current();
    return null;
  }), 8000, 'no weather reading');
  assert(typeof w.code === 'number' && typeof w.temp === 'number' && w.units === 'fahrenheit', 'weather: ' + JSON.stringify(w));
  noErrors(page);
}

/* ---------- run ---------- */

async function main() {
  PAGE_PORT = await spare();
  LIVE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  LIVE = 'http://127.0.0.1:' + LIVE_PORT;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-clay-test-'));
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, {
      HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: String(LIVE_PORT), HUB_LIVE_DATA_DIR: dataDir
    }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get(LIVE + '/live/state', (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  browser = await chromium.launch();

  await check('1. Nothing clay loads or shows before the first visit', checkNothingAtStart);
  await check('2. Nothing plays while keys are pressed; a visit comes after idleAfter', checkWaitsForIdle);
  await check('3. Every scene plays to the end, clean: 2 characters, 3 props, only transform and opacity', checkEveryScene);
  await check('4. A key press clears the screen before the hub handles it; focus moves', checkKeyClears);
  await check('5. A panel clears a scene and blocks new ones until idle again', checkPanelBlocks);
  await check('6. A layout from the Pi or a resize ends a scene; ledges follow the new layout', checkLayoutEnds);
  await check('7. clay: false, on: false and ?clay=off load and show nothing', checkOff);
  await check('8. A missing sprite skips that scene; a missing sprite list skips all; the hub is fine', checkMissing);
  await check('9. Night hours pick night scenes; a ticked to-do item queues a cheer', checkChoosing);
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
