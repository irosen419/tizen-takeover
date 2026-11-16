/*
 * The clay wanderers (app/clay.js): node dev/clay-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js,
 * with its own hub server on a spare port): nothing clay loads before the
 * first scene; nothing plays before idle; every scene plays to the end with
 * no console errors, leaves nothing behind and only ever changes transform
 * and opacity; a key press clears the screen in the same tick and focus
 * still moves; a panel clears and blocks scenes; a layout change ends one;
 * the layout bar blocks scenes and a layout picked there is measured anew;
 * clay: false and ?clay=off load nothing; a missing sprite skips the scene;
 * night hours pick night scenes; a ticked to-do item queues a cheer; the
 * status (HUB_CLAY.status(), shown in the About panel) says what is going
 * on and why not; no stylesheet is fetched; a failed sprite list is tried
 * again at the next visit and a skipped scene after 10 minutes; slow frames
 * are not marked broken and the next visit comes 20 s later (three times);
 * frames load ahead; at most 200 unanswered images are kept. The About
 * panel: its keys, its rows, a long problem that wraps, and that a visit
 * loads and plays with it open.
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

// A route that never answers (the request just hangs).
const HANG = -1;

// opts: { clay: value for HUB_CONFIG.clay (undefined = config.js as it is),
// query, missing: [url parts that answer 404] (may be changed later),
// serve: { url part: { type, body, delay } }, slowOnce: { url part: delay }
// (only the first request for each address waits), storage }
async function newHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  context.errors = [];
  context.requests = [];
  context.seen = new Set();
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    for (const host of BLOCKED_HOSTS) {
      if (url.indexOf('://' + host + '/') > 0 || url.indexOf('://' + host + ':') > 0) return route.abort();
    }
    context.requests.push(url);
    if ((opts.missing || []).some((m) => url.indexOf(m) >= 0)) return route.fulfill({ status: 404, body: 'not found' });
    for (const part in (opts.slowOnce || {})) {
      if (url.indexOf(part) < 0 || context.seen.has(url)) continue;
      context.seen.add(url);
      if (opts.slowOnce[part] === HANG) return new Promise(() => {});
      await sleep(opts.slowOnce[part]);
      try { return await route.continue(); } catch (e) { return; }
    }
    for (const part in (opts.serve || {})) {
      if (url.indexOf(part) < 0) continue;
      const a = opts.serve[part];
      if (a.delay) await sleep(a.delay);
      try { return await route.fulfill({ status: 200, contentType: a.type, body: a.body }); } catch (e) { return; }
    }
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
  // { now, visits, last, loading, problem, text }: the About panel's Wanderers rows.
  st: (page) => page.evaluate(() => window.HUB_CLAY.status()),
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
  const s0 = await look.st(page);
  const m = /^due back in (\d+) s$/.exec(s0.now);
  assert(s0.visits === '0 played · 0 slow · 0 failed' && !s0.last && !s0.loading && !s0.problem, 'status: ' + JSON.stringify(s0));
  assert(m && Math.abs(Number(m[1]) * 1000 - st.nextIn) < 1500, 'status: ' + s0.now + ' (next in ' + st.nextIn + ' ms)');
  assert(!(await page.evaluate(() => document.getElementById('clay-style'))), 'the clay styles are in before the first visit');
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
  await page.keyboard.press('ArrowRight');
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
    const text = (await look.st(page)).now;
    const want = opts.query ? 'off (?clay=off)' : 'off (config)';
    assert(text === want, JSON.stringify(opts) + ': status ' + JSON.stringify(text));
    assert(!(await page.evaluate(() => window.HUB_TEST.clay.play('stroll'))), JSON.stringify(opts) + ': play() worked');
    await page.keyboard.press('ArrowRight');
    await sleep(1500);
    assert(!clayRequests(page).length, JSON.stringify(opts) + ' loaded: ' + clayRequests(page).join(', '));
    assert(!(await look.layer(page)), JSON.stringify(opts) + ': layer');
    assert(!(await page.evaluate(() => document.getElementById('clay-style'))), JSON.stringify(opts) + ': the styles went in');
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
  assert(st.phase === 'waiting' && st.last.result === 'failed: frame ember/trot-1 failed (onerror)', 'state: ' + JSON.stringify(st));
  let s1 = await look.st(page);
  assert(/^due back in \d+ s$/.test(s1.now) && s1.visits === '0 played · 0 slow · 1 failed' && /^stroll failed, \d+ s ago$/.test(s1.last), 'status: ' + JSON.stringify(s1));
  assert(/^sprite list \d+ ms · stroll \d+\/\d+ frames, then one failed$/.test(s1.loading), 'loading: ' + s1.loading);
  assert(/^scene stroll skipped: frame ember\/trot-1 failed \(onerror\), \d+ s ago$/.test(s1.problem), 'problem: ' + s1.problem);
  assert(st.broken.indexOf('stroll') >= 0, 'stroll is not marked broken: ' + JSON.stringify(st.broken));
  assert(!(await look.layer(page)), 'a layer was left');
  const before = await look.focused(page);
  await page.keyboard.press('ArrowRight');
  assert((await look.focused(page)) !== before, 'focus did not move');
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(5));
  await playing(page, 'perch', { seed: 8, pose: 'sit-edge' });
  await until(async () => (await look.state(page)).phase === 'waiting', 10000, 'perch did not end');
  assert((await look.state(page)).last.result === 'done', 'perch: ' + JSON.stringify((await look.state(page)).last));
  // The problem stays after a good visit.
  s1 = await look.st(page);
  assert(s1.visits === '1 played · 0 slow · 1 failed' && /^perch finished, \d+ s ago$/.test(s1.last), 'status after perch: ' + JSON.stringify(s1));
  assert(/ · perch (\d+)\/\1 frames in (\d+ ms|\d+\.\d s)$/.test(s1.loading), 'loading after perch: ' + s1.loading);
  assert(/^scene stroll skipped: frame ember\/trot-1 failed \(onerror\), \d+ s ago$/.test(s1.problem), 'problem after perch: ' + s1.problem);
  noErrors(page, /Clay: scene stroll skipped/);
  await page.ctx.close();

  // No sprite list at all: nothing shows, nothing breaks.
  page = await newHub({ missing: ['clay/sprites.js'] });
  await page.evaluate(() => window.HUB_TEST.clay.play('fetch', { seed: 9 }));
  await until(async () => (await look.state(page)).last, 10000, 'fetch did not give up');
  st = await look.state(page);
  assert(st.assets === 'failed' && st.spriteEvent === 'onerror' && !(await look.layer(page)), 'state: ' + JSON.stringify(st));
  s1 = await look.st(page);
  assert(s1.visits === '0 played · 0 slow · 1 failed' && /^fetch failed, \d+ s ago$/.test(s1.last) && /^due back in \d+ s$/.test(s1.now), 'status: ' + JSON.stringify(s1));
  assert(/^sprite list onerror after \d+ ms$/.test(s1.loading), 'loading: ' + s1.loading);
  assert(/^sprite list did not load \(onerror\), \d+ s ago$/.test(s1.problem), 'problem: ' + s1.problem);
  const f0 = await look.focused(page);
  await page.keyboard.press('ArrowRight');
  assert((await look.focused(page)) !== f0, 'focus did not move');
  noErrors(page, /Clay: sprite list/);
}

// Playing, a busy hub and a page that reports hidden, in the status.
async function checkStatus() {
  const page = await newHub();
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(page, 'stroll', { seed: 21, dir: 'right' });
  let s1 = await look.st(page);
  assert(s1.now === 'on screen now: stroll' && s1.visits === '1 played · 0 slow · 0 failed', 'playing: ' + JSON.stringify(s1));
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  s1 = await look.st(page);
  assert(/^due back in \d+ s$/.test(s1.now) && /^stroll stopped, \d+ s ago$/.test(s1.last), 'after stop: ' + JSON.stringify(s1));
  // A panel open: busy, and which.
  await page.evaluate(() => window.HUB_TEST.openPanel('weather'));
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'weather' && !window.HUB_TEST.busy()), 4000, 'the panel did not open');
  s1 = await look.st(page);
  assert(s1.now === 'waiting: hub busy (a page is open)', 'panel: ' + s1.now);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 4000, 'the panel did not close');
  // The page says it is hidden (as a TV may while the hub is in front).
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  s1 = await look.st(page);
  assert(s1.now === 'waiting: page reports hidden', 'hidden: ' + s1.now);
  assert(!(await page.evaluate(() => window.HUB_TEST.clay.play('zoomies'))) || (await look.state(page)).phase !== 'playing', 'played while hidden');
  noErrors(page);
}

// The sprite list: a slow one (no event in 8 s), one that is not valid,
// and one that fails, then comes back: tried again at the next visit.
async function checkSpriteList() {
  // Not valid.
  let page = await newHub({ serve: { 'clay/sprites.js': { type: 'application/javascript', body: 'window.CLAY_SPRITES = { sprites: {} };' } } });
  await page.evaluate(() => window.HUB_TEST.clay.play('fetch', { seed: 31 }));
  await until(async () => (await look.state(page)).last, 10000, 'fetch did not give up');
  let st = await look.state(page);
  let s1 = await look.st(page);
  assert(st.assets === 'failed' && st.spriteEvent === 'onload', 'state: ' + JSON.stringify(st));
  assert(/^sprite list \d+ ms$/.test(s1.loading), 'loading: ' + s1.loading);
  assert(/^sprite list loaded but is not valid \(onload, no sprites or sequences\), \d+ s ago$/.test(s1.problem), 'problem: ' + s1.problem);
  noErrors(page, /Clay: sprite list/);
  await page.ctx.close();

  // No answer within the limit (2 s here, 30 s for real): slow, not
  // failed; the <script> goes on loading, and the next try uses it, with
  // no second request.
  page = await newHub({ slowOnce: { 'clay/sprites.js': 3500 } });
  await page.evaluate(() => { window.HUB_TEST.clay.setLoadMs(2000); window.HUB_TEST.clay.play('fetch', { seed: 32 }); });
  s1 = await look.st(page);
  assert(/^loading fetch \(sprite list\), \d+ s$/.test(s1.now), 'loading: ' + s1.now);
  await until(async () => (await look.state(page)).last, 10000, 'fetch did not give up');
  st = await look.state(page);
  s1 = await look.st(page);
  assert(st.spriteEvent === 'timeout' && st.slow === 1 && st.failed === 0 && s1.visits === '0 played · 1 slow · 0 failed' &&
    /^fetch too slow, \d+ s ago$/.test(s1.last), 'status: ' + JSON.stringify(s1));
  assert(/^sprite list not in after (\d+ ms|\d+\.\d s)$/.test(s1.loading), 'loading: ' + s1.loading);
  assert(/^sprite list did not load \(no onload or onerror in 2 s\), \d+ s ago$/.test(s1.problem), 'problem: ' + s1.problem);
  await until(async () => (await look.state(page)).spriteMs !== null, 5000, 'the sprite list never came');
  s1 = await look.st(page);
  assert(/^sprite list \d+\.\d s \(over 2 s\)$/.test(s1.loading), 'loading late: ' + s1.loading);
  assert(/^sprite list did not load \(no onload or onerror in 2 s\), then came in \d+ ms, \d+ s ago$/.test(s1.problem), 'problem late: ' + s1.problem);
  await page.evaluate(() => window.HUB_TEST.clay.play('fetch', { seed: 32 }));
  await until(async () => (await look.state(page)).phase === 'playing', 10000, 'fetch did not play after the late sprite list');
  const asked = page.ctx.requests.filter((u) => /\/clay\/sprites\.js/.test(u)).length;
  assert(asked === 1, 'sprites.js asked for ' + asked + ' times');
  noErrors(page, /Clay: sprite list/);
  await page.ctx.close();

  // Fails, then is back: the next visit (every[0] later) loads it and plays.
  const missing = ['clay/sprites.js'];
  page = await newHub({ clay: { idleAfter: 1, every: [3, 3] }, missing: missing });
  await page.evaluate(() => window.HUB_TEST.clay.dueIn(0));
  await until(async () => (await look.state(page)).assets === 'failed', 10000, 'the sprite list did not fail');
  const failedAt = Date.now();
  missing.length = 0;
  await until(async () => (await look.state(page)).phase === 'playing', 15000, 'no visit after the sprite list came back');
  const waited = Date.now() - failedAt;
  const asks = page.ctx.requests.filter((u) => /\/clay\/sprites\.js/.test(u)).length;
  assert(asks === 2, 'sprites.js asked for ' + asks + ' times');
  assert(waited < 10000, 'the retry took ' + waited + ' ms');
  s1 = await look.st(page);
  assert(/^on screen now: \S+$/.test(s1.now) && s1.visits === '1 played · 0 slow · 1 failed' && /^\S+ failed, \d+ s ago$/.test(s1.last), 'status: ' + JSON.stringify(s1));
  assert(!page.ctx.requests.some((u) => /clay\.css/.test(u)), 'clay.css was asked for');
  noErrors(page, /Clay: sprite list/);
}

// No stylesheet to wait for: the styles go in with the first visit (no
// request), and the layer is fixed, click-through and above the tiles.
async function checkNoStylesheet() {
  const page = await newHub({ missing: ['clay.css'] });
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(page, 'stroll', { seed: 41 });
  await page.evaluate(() => window.HUB_TEST.clay.step());
  const css = await page.evaluate(() => {
    const l = getComputedStyle(document.querySelector('.clay-layer'));
    const img = getComputedStyle(document.querySelector('.clay-actor img'));
    return { position: l.position, events: l.pointerEvents, z: l.zIndex, imgPos: img.position, links: document.querySelectorAll('link[href*="clay"]').length };
  });
  assert(css.position === 'fixed' && css.events === 'none' && css.z === '9' && css.imgPos === 'absolute' && !css.links, 'styles: ' + JSON.stringify(css));
  assert(!page.ctx.requests.some((u) => /clay\.css/.test(u)), 'clay.css was asked for');
  noErrors(page);
}

// A frame that loads but does not decode (onload, naturalWidth 0) is told
// apart from onerror; a skipped scene is left out for 10 minutes, then back.
async function checkBrokenScene() {
  const page = await newHub({ serve: { 'clay/sprites/ember/trot-1.webp': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>' } } });
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 51 }));
  await until(async () => (await look.state(page)).last, 10000, 'stroll did not finish loading');
  const st = await look.state(page);
  const text = (await look.st(page)).problem;
  assert(st.last.result === 'failed: frame ember/trot-1 failed (loaded, 0 px wide: did not decode)', 'state: ' + JSON.stringify(st.last));
  assert(/^scene stroll skipped: frame ember\/trot-1 failed \(loaded, 0 px wide: did not decode\), \d+ s ago$/.test(text), 'problem: ' + text);
  const picks = await page.evaluate(() => {
    const C = window.HUB_TEST.clay;
    C.setHour(14);
    const now = [];
    for (let i = 0; i < 60; i++) now.push(C.choose());
    // Eleven minutes on (clay.js reads the time with new Date().getTime()).
    const real = Date.prototype.getTime;
    Date.prototype.getTime = function () { return real.call(this) + 11 * 60000; };
    const later = [];
    try { for (let i = 0; i < 60; i++) later.push(C.choose()); } finally { Date.prototype.getTime = real; }
    C.setHour(null);
    return { now, later };
  });
  assert(picks.now.indexOf('stroll') < 0, 'stroll was picked again at once: ' + picks.now.join(','));
  assert(picks.later.indexOf('stroll') >= 0, 'stroll never came back: ' + picks.later.join(','));
  noErrors(page, /Clay: scene stroll skipped/);
}

// Frames that come too slowly: the visit is skipped, the scene is not
// marked broken, and the same scene comes again at the next visit and plays
// (its frames from the first try are in the cache by then).
async function checkSlowFrames() {
  const page = await newHub({ clay: { idleAfter: 1, every: [3, 3] }, slowOnce: { 'clay/sprites/': 2500 } });
  await page.evaluate(() => { window.HUB_TEST.clay.setLoadMs(1000); window.HUB_TEST.clay.setHour(14); window.HUB_TEST.clay.dueIn(0); });
  const first = await until(async () => {
    const st = await look.state(page);
    return st.last && st.last.result.indexOf('slow:') === 0 ? st : false;
  }, 15000, 'no visit was too slow');
  const name = first.last.name;
  assert(first.broken.length === 0 && first.slow === 1 && first.failed === 0, 'state after the slow visit: ' + JSON.stringify(first));
  assert(/^slow: its frames took over 1 s \(\d+ of \d+ in\)$/.test(first.last.result), 'result: ' + first.last.result);
  const s1 = await look.st(page);
  assert(s1.visits === '0 played · 1 slow · 0 failed' && /^\S+ too slow, \d+ s ago$/.test(s1.last) && /^due back in \d+ s$/.test(s1.now), 'status: ' + JSON.stringify(s1));
  const second = await until(async () => {
    const st = await look.state(page);
    return st.phase === 'playing' ? st : false;
  }, 15000, 'no visit after the slow one');
  assert(second.scene === name, 'the next visit was ' + second.scene + ', not ' + name + ' again');
  assert(second.played === 1 && second.slow === 1 && second.broken.length === 0, 'state: ' + JSON.stringify(second));
  const detail = (await look.st(page)).loading;
  assert(new RegExp(' · ' + name + ' (\\d+)/\\1 frames in (\\d+ ms|\\d+\\.\\d s)').test(detail), 'loading: ' + detail);
  noErrors(page, /Clay: scene \S+ skipped: its frames took/);
}

// After a visit, the next one's frames load ahead (one scene), and that
// scene comes at the next visit, which is not any earlier for it.
async function checkAhead() {
  const page = await newHub({ clay: { idleAfter: 1, every: [8, 8] } });
  await page.evaluate(() => { window.HUB_TEST.clay.setHour(14); window.HUB_TEST.clay.setSpeed(1); window.HUB_TEST.clay.dueIn(0); });
  await until(async () => { const st = await look.state(page); return st.last && st.last.result === 'done'; }, 20000, 'no visit finished');
  const endedAt = Date.now();
  const st = await until(async () => { const s = await look.state(page); return s.ahead && s.ahead.of && s.ahead.got === s.ahead.of ? s : false; }, 8000, 'nothing loaded ahead');
  assert(st.phase === 'waiting' && st.nextIn > 2000, 'state while ahead: ' + JSON.stringify(st));
  const next = await until(async () => { const s = await look.state(page); return s.phase !== 'waiting' ? s : false; }, 15000, 'no next visit');
  const gap = Date.now() - endedAt;
  assert(next.scene === st.ahead.name, 'the next visit was ' + next.scene + ', loaded ahead ' + st.ahead.name);
  assert(gap >= 7800, 'the next visit came after ' + gap + ' ms, not 8 s');
  noErrors(page);
}

// The default pause after a finished daytime visit is 90 to 150 s, from
// config.js and from clay.js's own default when the config leaves it out.
async function checkDefaultEvery() {
  for (const opts of [{}, { clay: { idleAfter: 20 } }]) {
    const page = await newHub(opts);
    await page.evaluate(() => { window.HUB_TEST.clay.setHour(14); window.HUB_TEST.clay.setSpeed(1); });
    const gaps = [];
    for (let i = 0; i < 6; i++) {
      await playing(page, 'zoomies', { seed: 70 + i });
      await until(async () => (await look.state(page)).phase === 'waiting', 10000, 'zoomies did not end');
      const st = await look.state(page);
      assert(st.last.result === 'done', 'zoomies: ' + JSON.stringify(st.last));
      gaps.push(st.nextIn);
    }
    assert(gaps.every((g) => g >= 89000 && g <= 150000), JSON.stringify(opts) + ' gaps: ' + gaps.join(', '));
    noErrors(page);
    await page.ctx.close();
  }
}

// A visit skipped as slow comes back 20 s later (its files are still
// coming), for three slow visits in a row; then every[0], until one plays.
// The idle rule still applies.
async function checkSlowRetry() {
  const page = await newHub({ clay: { idleAfter: 1, every: [60, 60] }, slowOnce: { 'clay/sprites/': HANG } });
  await page.evaluate(() => { window.HUB_TEST.clay.setLoadMs(500); window.HUB_TEST.clay.setHour(14); });
  const gaps = [];
  for (let i = 0; i < 4; i++) {
    const before = (await look.state(page)).slow;
    await page.evaluate(() => window.HUB_TEST.clay.dueIn(0));
    const st = await until(async () => { const s = await look.state(page); return s.slow === before + 1 && s.phase === 'waiting' ? s : false; }, 8000, 'visit ' + (i + 1) + ' was not slow');
    gaps.push(st.nextIn);
  }
  assert(gaps.slice(0, 3).every((g) => g > 18500 && g <= 20000) && gaps[3] > 58500 && gaps[3] <= 60000, 'gaps after slow visits: ' + gaps.join(', '));
  // One plays (with new frames: a seed whose scene is not stuck), and the count starts over.
  await page.evaluate(() => { window.HUB_TEST.clay.setLoadMs(null); window.HUB_TEST.clay.setSpeed(1); });
  await page.unroute('**/*');
  await page.ctx.unroute('**/*');
  await playing(page, 'perch', { seed: 3, pose: 'sit-edge' });
  await until(async () => (await look.state(page)).phase === 'waiting', 10000, 'perch did not end');
  assert((await look.state(page)).slowRun === 0, 'the slow count did not start over');
  // A key press after a slow visit: the idle wait still holds (idleAfter 1 s is short, so
  // only that nothing comes before it).
  noErrors(page, /Clay: (scene \S+ skipped: its frames took|sprite list)/);
}

// Images that never answer are kept at most 200 at a time.
async function checkSettlingCap() {
  const page = await newHub({ clay: { idleAfter: 3600 }, slowOnce: { 'clay/sprites/': HANG } });
  await page.evaluate(() => { window.HUB_TEST.clay.setLoadMs(200); window.HUB_TEST.clay.setHour(14); });
  const names = ['stroll', 'fetch', 'sock-heist', 'zoomies', 'morning', 'evening', 'cheer', 'shrug'];
  let st;
  for (let round = 0; round < 3; round++) {
    for (const n of names) {
      await page.evaluate((x) => window.HUB_TEST.clay.play(x, { seed: 5 }), n);
      await until(async () => (await look.state(page)).phase === 'waiting', 5000, n + ' did not give up');
    }
    st = await look.state(page);
  }
  assert(st.settling > 150 && st.settling <= 200, 'images kept: ' + st.settling);
  noErrors(page, /Clay: scene \S+ skipped: its frames took/);
}

/* ---------- the About panel (app/hub.js) ---------- */

const about = {
  isOpen: (page) => page.evaluate(() => window.HUB_TEST.about.isOpen()),
  shown: (page) => page.evaluate(() => document.getElementById('about').classList.contains('is-shown')),
  rows: (page) => page.evaluate(() => window.HUB_TEST.about.rows()),
  value: async (page, label) => {
    const r = (await about.rows(page)).filter((x) => x.label === label)[0];
    return r ? r.value : null;
  },
  bar: (page) => page.evaluate(() => document.getElementById('switcher').classList.contains('is-shown'))
};

// Left until the panel opens (at most 6 presses); returns the tile it opened from.
async function leftToAbout(page) {
  for (let i = 0; i < 6 && !(await about.isOpen(page)); i++) {
    await page.keyboard.press('ArrowLeft');
    await sleep(60);
  }
  assert(await about.isOpen(page), 'Left did not open the About panel');
  return look.focused(page);
}

// Everything inside the strip, at this screen size: each row's text wraps
// inside the box, nothing is cut or hidden, the box is on screen.
function aboutFit(page) {
  return page.evaluate(() => {
    const box = document.querySelector('#about .about-box');
    const b = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const inner = { left: b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - 0.5,
      right: b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 0.5 };
    const bad = [];
    if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) bad.push('box off screen ' + JSON.stringify(b));
    if (box.scrollHeight > box.clientHeight + 1) bad.push('box taller than its room: ' + box.scrollHeight + ' > ' + box.clientHeight);
    box.querySelectorAll('.about-group, .about-label, .about-value').forEach((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      if (r.left < inner.left || r.right > inner.right) bad.push(e.textContent.slice(0, 30) + ' sticks out');
      if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) bad.push(e.textContent.slice(0, 30) + ' is cut');
      if (s.textOverflow === 'ellipsis' || s.whiteSpace === 'nowrap') bad.push(e.textContent.slice(0, 30) + ' does not wrap');
      if (e.className === 'about-value' && parseFloat(s.lineHeight) / parseFloat(s.fontSize) < 1.35) bad.push('value line-height ' + s.lineHeight);
    });
    const values = Array.prototype.slice.call(box.querySelectorAll('.about-value'));
    const last = values[values.length - 1];
    const lines = last ? Math.round(last.getBoundingClientRect().height / parseFloat(getComputedStyle(last).lineHeight)) : 0;
    return { bad: bad, lastLines: lines, width: Math.round(b.width), rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
}

// Left from a left-most tile opens it, Up does not (Up still drops the layout
// bar); Right, Back and a click outside close it with focus where it was; OK,
// Up and Down do nothing else; it never opens over a panel or the layout bar.
async function checkAboutKeys() {
  const page = await newHub();
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'busy');
  const from = await leftToAbout(page);
  const left = await page.evaluate((id) => {
    const rects = window.HUB_TEST.homeRects();
    return Math.round(rects[id].left) === Math.round(Math.min.apply(null, Object.values(rects).map((r) => r.left)));
  }, from);
  assert(left, 'opened from a tile that is not left-most: ' + from);
  await until(() => about.shown(page), 1000, 'the panel did not slide in');
  const z = await page.evaluate(() => Number(getComputedStyle(document.getElementById('about')).zIndex));
  assert(z === 15, 'z-index ' + z);
  for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft']) {
    await page.keyboard.press(key);
    await sleep(100);
    assert(await about.isOpen(page), key + ' closed it');
    assert((await page.evaluate(() => window.HUB_TEST.open())) === null && !(await about.bar(page)), key + ' opened something');
    assert((await look.focused(page)) === from, key + ' moved focus');
  }
  await page.keyboard.press('ArrowRight');
  assert(!(await about.isOpen(page)) && (await look.focused(page)) === from, 'Right: open ' + (await about.isOpen(page)) + ', focus ' + (await look.focused(page)));
  await until(async () => !(await page.evaluate(() => document.getElementById('about').classList.contains('is-on'))), 1000, 'still drawn after closing');
  await page.keyboard.press('ArrowLeft');
  assert(await about.isOpen(page), 'Left did not open it again');
  await page.keyboard.press('Escape');
  assert(!(await about.isOpen(page)) && (await look.focused(page)) === from && (await page.evaluate(() => window.HUB_TEST.open())) === null, 'Back');
  await page.keyboard.press('ArrowLeft');
  await page.mouse.click(1500, 540);
  await sleep(300);
  assert(!(await about.isOpen(page)) && (await page.evaluate(() => window.HUB_TEST.open())) === null, 'a click outside did not just close it');
  // Up from a top tile: the layout bar, never the About panel; not over the bar.
  for (let i = 0; i < 6 && !(await about.bar(page)); i++) {
    await page.keyboard.press('ArrowUp');
    await sleep(60);
    assert(!(await about.isOpen(page)), 'Up opened the About panel');
  }
  assert(await about.bar(page), 'Up did not open the layout bar');
  assert(!(await page.evaluate(() => window.HUB_TEST.about.open())), 'it opened over the layout bar');
  await page.keyboard.press('Escape');
  await until(async () => !(await about.bar(page)), 2000, 'the bar did not close');
  // Not over a panel.
  await page.evaluate(() => window.HUB_TEST.openPanel('weather'));
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'weather' && !window.HUB_TEST.busy()), 4000, 'the panel did not open');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  assert(!(await about.isOpen(page)) && !(await page.evaluate(() => window.HUB_TEST.about.open())), 'it opened over a panel');
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 4000, 'the panel did not close');
  // A panel opened while it is open (as the Pi can) closes it first.
  assert(await page.evaluate(() => window.HUB_TEST.about.open()), 'it did not open from the test hook');
  await page.evaluate(() => window.HUB_TEST.openPanel('weather'));
  assert(!(await about.isOpen(page)), 'it stayed open under a panel');
  noErrors(page);
}

// The rows: which are there and when, they refresh by themselves, and a
// long problem wraps inside the strip at 1920x1080 and 1280x720.
async function checkAboutRows() {
  const page = await newHub({ missing: ['clay/sprites/ember/trot-1.webp'], clay: { idleAfter: 3600 } });
  assert(await page.evaluate(() => window.HUB_TEST.about.open()), 'did not open');
  let rows = await about.rows(page);
  const names = rows.map((r) => r.group + '/' + r.label).join(', ');
  // ?live=off and no TizenBrew: nothing to say about updates; no visit yet.
  assert(names === 'This hub/Version, This hub/Browser, This hub/Motion, Wanderers/Now, Wanderers/Visits', 'rows at start: ' + names);
  const groups = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#about .about-group'), (e) => e.textContent).join(','));
  assert(groups === 'This hub,Wanderers', 'groups: ' + groups);
  assert(/^v0\.\d+\.\d+/.test(rows[0].value) && !/^Motion/.test(rows[2].value), 'values: ' + JSON.stringify(rows));
  // The countdown ticks with nothing calling it.
  // (The strip redraws once a second, so a read can be up to a second behind.)
  const n1 = await about.value(page, 'Now');
  await sleep(3200);
  const n2 = await about.value(page, 'Now');
  const m1 = /^due back in (?:(\d+) min )?(\d+) s$/.exec(n1);
  const m2 = /^due back in (?:(\d+) min )?(\d+) s$/.exec(n2);
  const secs = (m) => Number(m[1] || 0) * 60 + Number(m[2]);
  assert(m1 && m2 && secs(m2) <= secs(m1) - 2, 'the countdown did not tick: ' + n1 + ' / ' + n2);
  // A visit that fails: Last visit, Loading and Last problem come in by themselves.
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 7 }));
  await until(async () => (await about.value(page, 'Last problem')) !== null, 5000, 'no Last problem row');
  rows = await about.rows(page);
  assert(rows.map((r) => r.label).join(',') === 'Version,Browser,Motion,Now,Visits,Last visit,Loading,Last problem', 'rows after a failure: ' + rows.map((r) => r.label));
  const p1 = await about.value(page, 'Last problem');
  assert(/^scene stroll skipped: frame ember\/trot-1 failed \(onerror\), \d+ s ago$/.test(p1), 'problem: ' + p1);
  await until(async () => (await about.value(page, 'Last problem')) !== p1, 3000, 'the problem\'s age did not change by itself');
  // A long problem, with a long unbroken word: it wraps, nothing is cut.
  await page.evaluate(() => {
    const K = window.HUB_CLAY;
    const real = K.status;
    K.status = function () {
      const s = real.call(K);
      s.problem = 'scene sock-heist skipped: frame ember/sock-proud failed (loaded, 0 px wide: did not decode) at ' +
        'https://cdn.jsdelivr.net/gh/example/tizen-takeover@0123456789abcdef0123456789abcdef01234567/app/clay/sprites/ember/sock-proud.webp, 12 s ago';
      return s;
    };
  });
  await sleep(1300);
  for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await sleep(400);
    const fit = await aboutFit(page);
    assert(!fit.bad.length, size.width + 'x' + size.height + ': ' + fit.bad.join('; '));
    assert(fit.lastLines >= 4, size.width + 'x' + size.height + ': the long problem is on ' + fit.lastLines + ' lines');
    assert(fit.width <= 26 * fit.rem, size.width + 'x' + size.height + ': ' + fit.width + ' px wide');
  }
  noErrors(page, /Clay: scene stroll skipped/);
}

// The About panel is not "busy": with it open a visit loads and plays, and
// the panel shows the countdown, then loading, then on screen, as they come.
async function checkAboutNotBusy() {
  const page = await newHub({ clay: { idleAfter: 1, every: [60, 60] }, slowOnce: { 'clay/sprites/': 2500 } });
  await page.evaluate(() => window.HUB_TEST.clay.setHour(14));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'busy');
  await leftToAbout(page);
  await page.evaluate(() => window.HUB_TEST.clay.dueIn(4000));
  const seen = [];
  let st;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const v = await about.value(page, 'Now');
    if (v && seen[seen.length - 1] !== v) seen.push(v);
    st = await look.state(page);
    if (st.phase === 'playing' && /^on screen now: /.test(v || '')) break;
    await sleep(100);
  }
  const kinds = [];
  for (const v of seen) {
    const k = /^due back in /.test(v) ? 'countdown' : /^loading \S+(, \d+ of \d+ frames| \([a-z ]+\)), \d+ s$/.test(v) ? 'loading' : /^on screen now: \S+$/.test(v) ? 'on screen' : 'other: ' + v;
    if (kinds[kinds.length - 1] !== k) kinds.push(k);
  }
  assert(kinds.join(' > ') === 'countdown > loading > on screen', 'the panel showed: ' + seen.join(' | '));
  assert(seen.some((v) => /^loading \S+, \d+ of \d+ frames, [1-9]\d* s$/.test(v)), 'no frame count while loading: ' + seen.join(' | '));
  assert(await about.isOpen(page), 'the panel closed');
  assert(await look.layer(page), 'no clay layer while the panel is open');
  const z = await page.evaluate(() => [Number(getComputedStyle(document.getElementById('about')).zIndex), Number(getComputedStyle(document.querySelector('.clay-layer')).zIndex)]);
  assert(z[0] > z[1], 'the panel is not above the wanderers: ' + z.join(' / '));
  // It plays on with the panel open, and Right ends it like any key.
  await sleep(1500);
  assert((await look.state(page)).phase === 'playing' && (await about.isOpen(page)), 'the visit or the panel ended by itself');
  await page.keyboard.press('ArrowRight');
  assert(!(await about.isOpen(page)) && (await look.state(page)).phase === 'waiting', 'Right did not close the panel and clear the screen');
  noErrors(page);
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

async function checkSwitcher() {
  const page = await newHub();
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'busy');
  // Up to a top tile; one more Up drops the layout bar.
  for (let i = 0; i < 4 && (await look.focused(page)) !== 'awws' && (await look.focused(page)) !== 'calendar'; i++) await page.keyboard.press('ArrowUp');
  const top = await look.focused(page);
  assert(top === 'calendar' || top === 'awws', 'not on a top tile: ' + top);
  await playing(page, 'stroll', { seed: 11 });
  await page.keyboard.press('ArrowUp');
  const bar = () => page.evaluate(() => document.getElementById('switcher').classList.contains('is-shown'));
  assert(await bar(), 'the layout bar did not open');
  assert(!(await look.layer(page)), 'the scene stayed under the bar');
  assert(!(await page.evaluate(() => window.HUB_TEST.clay.play('zoomies'))), 'play() worked with the bar open');
  await page.evaluate(() => window.HUB_TEST.clay.dueIn(0));
  await sleep(3000);
  assert((await look.state(page)).phase === 'waiting', 'a scene came while the bar was open');
  // Pick another layout: the tiles move, and the next scene measures them anew.
  const before = await page.evaluate(() => JSON.stringify(window.HUB_TEST.layout()));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await until(async () => !(await bar()), 3000, 'the bar did not close');
  await until(() => page.evaluate((b) => JSON.stringify(window.HUB_TEST.layout()) !== b, before), 3000, 'the layout did not change');
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  for (let ledge = 0; ledge < 3; ledge++) {
    await playing(page, 'perch', { seed: 12, pose: 'lie-chin', ledge: ledge });
    await page.evaluate(() => { window.HUB_TEST.clay.step(); window.HUB_TEST.clay.step(); });
    const where = await page.evaluate(() => {
      const rects = window.HUB_TEST.homeRects();
      const top = Math.min.apply(null, Object.values(rects).map((r) => r.top));
      const actor = document.querySelector('.clay-actor');
      const m = /translate3d\(([-\d.]+)px, ?([-\d.]+)px/.exec(actor.style.transform);
      const x = parseFloat(m[1]);
      const y = parseFloat(m[2]);
      const on = Object.keys(rects).filter((id) => rects[id].top > top + 8 && Math.abs(rects[id].top + 2 - y) <= 1 &&
        x >= rects[id].left && x <= rects[id].left + rects[id].width);
      return { x, y, on };
    });
    assert(where.on.length === 1, 'perch ' + ledge + ' is not on a ledge of the new layout: ' + JSON.stringify(where));
    await page.evaluate(() => window.HUB_TEST.clay.stop());
  }
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
  await check('6b. The layout bar ends a scene and blocks new ones; a layout picked there is measured anew', checkSwitcher);
  await check('7. clay: false, on: false and ?clay=off load and show nothing', checkOff);
  await check('8. A missing sprite skips that scene; a missing sprite list skips all; the hub is fine', checkMissing);
  await check('9. Night hours pick night scenes; a ticked to-do item queues a cheer', checkChoosing);
  await check('10. The status: playing, stopped, a busy hub, a page that reports hidden', checkStatus);
  await check('11. The sprite list: not valid, too slow (and used when it comes late), and a failure tried again at the next visit', checkSpriteList);
  await check('12. No stylesheet to wait for: a scene plays with clay.css never asked for', checkNoStylesheet);
  await check('13. A frame that does not decode is told apart; a skipped scene is back after 10 minutes', checkBrokenScene);
  await check('14. The About panel: Left from a left-most tile opens it, Up does not; Right, Back and a click close it; never over a panel', checkAboutKeys);
  await check('14b. The About panel\'s rows: present or absent, refreshed by themselves; a long problem wraps at 1920x1080 and 1280x720', checkAboutRows);
  await check('14c. The About panel is not busy: a visit loads and plays with it open, and it shows countdown, loading, on screen', checkAboutNotBusy);
  await check('15. Slow frames: the visit is skipped, not marked broken, and the same scene plays at the next visit', checkSlowFrames);
  await check('16. The next visit\'s frames load ahead; that scene comes, no earlier', checkAhead);
  await check('17. The default pause after a daytime visit is 90 to 150 s', checkDefaultEvery);
  await check('18. After a slow visit the next comes 20 s later, three times in a row, then every[0]', checkSlowRetry);
  await check('19. Images that never answer are kept at most 200 at a time', checkSettlingCap);
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
