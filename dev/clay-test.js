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
 * night hours pick night scenes; by day, over 4000 picks fed their last
 * scene with HUB_TEST.clay.setLast(name) (a test-only hook: the scene choose()
 * treats as played last), sock-heist and the fetch family (fetch, fetch-bolt,
 * fetch-snub) each come 17 to 23 % of the time and no family comes twice in
 * a row; a ticked to-do item queues a cheer; the
 * status (HUB_CLAY.status(), shown in the About panel) says what is going
 * on and why not; no stylesheet is fetched; a failed sprite list is tried
 * again at the next visit and a skipped scene after 10 minutes; slow frames
 * are not marked broken and the next visit comes 20 s later (three times);
 * frames load ahead; at most 200 unanswered images are kept. The drawing:
 * between ticks by fractions and exactly on each tick at its end, a teleport
 * or a turn never glides, a walk's picture by distance (and a longer cycle
 * from the sprite list drops in), breathing, leaning, MOVE_WITH_POSE and the
 * blend experiment; at the real speed only transform and opacity change;
 * slow frames go stepped and are remembered, no requestAnimationFrame is
 * stepped; every scene's length is in its range with 40 pictures or fewer;
 * gait art of any shape (cycles of any length, lifts, shares, Ian side-on)
 * works. The About panel: its keys,
 * its rows (Drawing too), a long problem that wraps and every row 25 %
 * longer still fitting, and that a visit loads and plays with it open.
 * Needs Playwright and port 8095 free. CLAY_ART=old runs it all against
 * the sprite list's old two-picture shape (see OLD_ART below).
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
  { widget: 'mirror',        x: 9, y: 2, w: 3, h: 2 },
  { widget: 'wotd',          x: 9, y: 4, w: 3, h: 2 },
  { widget: 'ambiance',      x: 3, y: 4, w: 6, h: 1 },
  { widget: 'weather',       x: 0, y: 5, w: 3, h: 1 },
  { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
];

// Every scene, and the variants that use other frames.
const PLAYS = [
  ['stroll', { dir: 'right' }], ['stroll', { dir: 'left' }],
  ['fetch', { dir: 'right' }], ['fetch', { dir: 'left' }],
  ['fetch-bolt', { dir: 'right' }], ['fetch-bolt', { dir: 'left' }],
  ['fetch-snub', { dir: 'right' }], ['fetch-snub', { dir: 'left' }],
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

// CLAY_ART=old node dev/clay-test.js runs every check against the sprite
// list's old shape, from before the walk cycles were drawn: two pictures a
// gait, no strides, no lifts, no carrying cycles and no ian/stand-side (the
// old pictures are still in the list). The engine must work with both.
const OLD_ART = process.env.CLAY_ART === 'old';
const OLD_ART_JS = `
(function (S) {
  S.sequences['ian.walk'] = ['ian/walk-1', 'ian/walk-2'];
  S.sequences['ian.run'] = ['ian/run-1', 'ian/run-2'];
  S.sequences['ember.trot'] = ['ember/trot-1', 'ember/trot-2'];
  S.sequences['ember.run'] = ['ember/run-1', 'ember/run-2'];
  delete S.sequences['ember.ball-trot'];
  delete S.sequences['ember.sock-run'];
  delete S.strides;
  delete S.lifts;
  delete S.shares;
  delete S.sprites['ian/stand-side'];
})(CLAY_SPRITES);
`;

// A route that never answers (the request just hangs).
const HANG = -1;

// opts: { clay: value for HUB_CONFIG.clay (undefined = config.js as it is),
// query, missing: [url parts that answer 404] (may be changed later),
// serve: { url part: { type, body, delay } }, slowOnce: { url part: delay }
// (only the first request for each address waits), failFirst: { url part: n }
// (the first n requests for it answer 404, later ones are served), storage }
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
    for (const part in (opts.failFirst || {})) {
      if (url.indexOf(part) < 0) continue;
      context.failed = context.failed || {};
      context.failed[part] = (context.failed[part] || 0) + 1;
      if (context.failed[part] <= opts.failFirst[part]) return route.fulfill({ status: 404, body: 'not found' });
    }
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
    if (OLD_ART && /\/clay\/sprites\.js(\?|$)/.test(url)) {
      const res = await route.fetch();
      return route.fulfill({ response: res, body: (await res.text()) + OLD_ART_JS });
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
  const m = /^Due back in (\d+) s$/.exec(s0.now);
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
    // The same length as the script says (checkLengths checks the ranges).
    const dry = await page.evaluate(([n, o]) => window.HUB_TEST.clay.dry(n, o), [name, Object.assign({ seed: 100 + i }, opts)]);
    assert(dry && Math.abs(dry.ticks - st.last.ticks) <= 1, label + ': played ' + st.last.ticks + ' ticks, the script says ' + (dry && dry.ticks));
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
    const want = opts.query ? 'Off (?clay=off)' : 'Off (config)';
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

async function checkAskedAgain() {
  // A picture whose first request fails is asked for again and the scene
  // plays; the status says how many were asked for again.
  let page = await newHub({ failFirst: { 'clay/sprites/ember/stand-wag.webp': 1 } });
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 7 }));
  await until(async () => (await look.state(page)).phase === 'playing', 10000, 'stroll did not start after one failed request');
  let st = await look.state(page);
  assert(st.failed === 0 && st.broken.length === 0, 'state: ' + JSON.stringify(st));
  let s1 = await look.st(page);
  assert(/^sprite list \d+ ms · stroll (\d+)\/\1 frames in [\d.]+ (ms|s) \(1 asked for again\)$/.test(s1.loading), 'loading: ' + s1.loading);
  assert(!s1.problem, 'a problem was reported: ' + s1.problem);
  const wag = page.context().requests.filter((u) => u.indexOf('clay/sprites/ember/stand-wag.webp') >= 0).length;
  assert(wag === 2, 'stand-wag was requested ' + wag + ' times');
  await page.context().close();
  // Two failures: the third try still saves the scene.
  page = await newHub({ failFirst: { 'clay/sprites/ember/stand-wag.webp': 2 } });
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 7 }));
  await until(async () => (await look.state(page)).phase === 'playing', 12000, 'stroll did not start after two failed requests');
  s1 = await look.st(page);
  assert(/\(2 asked for again\)$/.test(s1.loading), 'loading: ' + s1.loading);
  await page.context().close();
}

async function checkMissing() {
  // One frame missing: that scene is skipped, others play, the hub is fine.
  let page = await newHub({ missing: ['clay/sprites/ember/stand-wag.webp'] });
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 7 }));
  await until(async () => (await look.state(page)).last, 10000, 'stroll did not finish loading');
  let st = await look.state(page);
  assert(st.phase === 'waiting' && st.last.result === 'failed: frame ember/stand-wag failed (onerror, 3 tries)', 'state: ' + JSON.stringify(st));
  let s1 = await look.st(page);
  assert(/^Due back in \d+ s$/.test(s1.now) && s1.visits === '0 played · 0 slow · 1 failed' && /^stroll failed, \d+ s ago$/.test(s1.last), 'status: ' + JSON.stringify(s1));
  assert(/^sprite list \d+ ms · stroll \d+\/\d+ frames, then one failed$/.test(s1.loading), 'loading: ' + s1.loading);
  assert(/^scene stroll skipped: frame ember\/stand-wag failed \(onerror, 3 tries\), \d+ s ago$/.test(s1.problem), 'problem: ' + s1.problem);
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
  assert(/^scene stroll skipped: frame ember\/stand-wag failed \(onerror, 3 tries\), \d+ s ago$/.test(s1.problem), 'problem after perch: ' + s1.problem);
  noErrors(page, /Clay: scene stroll skipped/);
  await page.ctx.close();

  // No sprite list at all: nothing shows, nothing breaks.
  page = await newHub({ missing: ['clay/sprites.js'] });
  await page.evaluate(() => window.HUB_TEST.clay.play('fetch', { seed: 9 }));
  await until(async () => (await look.state(page)).last, 10000, 'fetch did not give up');
  st = await look.state(page);
  assert(st.assets === 'failed' && st.spriteEvent === 'onerror' && !(await look.layer(page)), 'state: ' + JSON.stringify(st));
  s1 = await look.st(page);
  assert(s1.visits === '0 played · 0 slow · 1 failed' && /^fetch failed, \d+ s ago$/.test(s1.last) && /^Due back in \d+ s$/.test(s1.now), 'status: ' + JSON.stringify(s1));
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
  assert(s1.now === 'On screen now: stroll' && s1.visits === '1 played · 0 slow · 0 failed', 'playing: ' + JSON.stringify(s1));
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  s1 = await look.st(page);
  assert(/^Due back in \d+ s$/.test(s1.now) && /^stroll stopped, \d+ s ago$/.test(s1.last), 'after stop: ' + JSON.stringify(s1));
  // A panel open: busy, and which.
  await page.evaluate(() => window.HUB_TEST.openPanel('weather'));
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'weather' && !window.HUB_TEST.busy()), 4000, 'the panel did not open');
  s1 = await look.st(page);
  assert(s1.now === 'Waiting: hub busy (a page is open)', 'panel: ' + s1.now);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 4000, 'the panel did not close');
  // The page says it is hidden (as a TV may while the hub is in front).
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  s1 = await look.st(page);
  assert(s1.now === 'Waiting: page reports hidden', 'hidden: ' + s1.now);
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
  assert(/^Loading fetch \(sprite list\), \d+ s$/.test(s1.now), 'loading: ' + s1.now);
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
  assert(/^On screen now: \S+$/.test(s1.now) && s1.visits === '1 played · 0 slow · 1 failed' && /^\S+ failed, \d+ s ago$/.test(s1.last), 'status: ' + JSON.stringify(s1));
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
  const page = await newHub({ serve: { 'clay/sprites/ember/stand-wag.webp': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>' } } });
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 51 }));
  await until(async () => (await look.state(page)).last, 10000, 'stroll did not finish loading');
  const st = await look.state(page);
  const text = (await look.st(page)).problem;
  assert(st.last.result === 'failed: frame ember/stand-wag failed (loaded, 0 px wide: did not decode)', 'state: ' + JSON.stringify(st.last));
  assert(/^scene stroll skipped: frame ember\/stand-wag failed \(loaded, 0 px wide: did not decode\), \d+ s ago$/.test(text), 'problem: ' + text);
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
  assert(s1.visits === '0 played · 1 slow · 0 failed' && /^\S+ too slow, \d+ s ago$/.test(s1.last) && /^Due back in \d+ s$/.test(s1.now), 'status: ' + JSON.stringify(s1));
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


/* ---------- drawing between ticks ---------- */

// The drawn position of an actor: [x, y] from its transform.
function drawn(t) {
  const m = /translate3d\(([-\d.]+)px, ?([-\d.]+)px/.exec(t || '');
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

// Steps through a scene 35 ms at a time (four draws a tick, by hand) and
// checks every draw: a character is between where it was and where it is
// going (a teleport, a first appearance and a show after a hide are where
// they are at once, never on the way); the last draw of a tick is exactly
// on the tick's position; facing flips only on the first draw of a tick and
// never by a fraction; the shadow never breathes. Returns what it saw.
async function drawThrough(page, name, opts, each) {
  await playing(page, name, opts);
  // Pictures in mid-air (CLAY_SPRITES.lifts) are drawn that much higher than
  // their position; the checks below are on the position under the lift.
  const lifts = await page.evaluate(() => window.CLAY_SPRITES.lifts || {});
  const seen = { fractions: 0, ticks: 0, jumps: 0, flips: 0, draws: 0, walking: 0, lifted: 0 };
  let last = null;
  for (let n = 0; n < 4000; n++) {
    const tickBefore = (await look.state(page)).tick;
    const st = await page.evaluate(() => window.HUB_TEST.clay.advance(35));
    if (st.phase !== 'playing') return seen;
    const actors = await page.evaluate(() => window.HUB_TEST.clay.actors());
    const firstOfTick = st.tick !== tickBefore;
    const endOfTick = (n + 1) % 4 === 0;
    seen.draws++;
    for (const a of actors) {
      if (!a.shown) continue;
      const d = drawn(a.transform);
      assert(d, name + ': ' + a.name + ' has no position: ' + a.transform);
      const lift = lifts[a.shown] || 0;
      assert(a.lift === lift, name + ': ' + a.name + ' showing ' + a.shown + ' is lifted ' + a.lift + ', not ' + lift);
      if (lift) {
        seen.lifted++;
        const sh = drawn(a.shadow);
        assert(!sh || Math.abs(sh[0] - d[0]) <= 0.11, name + ': the shadow left a lifted ' + a.name);
        d[1] += lift;
      }
      assert(!/scaleX\((?!-1\))/.test(a.transform) && !/scale\(-/.test(a.transform), name + ': a squashed flip: ' + a.transform);
      assert(!/scale|rotate/.test(a.shadow), name + ': the shadow moves with the body: ' + a.shadow);
      if (a.jumped && !a.arc) {
        seen.jumps++;
        assert(Math.abs(d[0] - a.x) <= 0.11 && Math.abs(d[1] - a.y) <= 0.11, name + ': ' + a.name + ' glided after a jump: ' + JSON.stringify([d, a.x, a.y]));
      } else if (!a.arc) {
        const lo = [Math.min(a.px, a.x) - 0.11, Math.min(a.py, a.y) - 0.11];
        const hi = [Math.max(a.px, a.x) + 0.11, Math.max(a.py, a.y) + 0.11];
        assert(d[0] >= lo[0] && d[0] <= hi[0] && d[1] >= lo[1] && d[1] <= hi[1], name + ': ' + a.name + ' is off its way: ' + JSON.stringify({ d, a }));
        if (Math.abs(d[0] - a.x) > 0.5 && Math.abs(d[0] - a.px) > 0.5) seen.fractions++;
      }
      if (endOfTick && !a.arc) {
        assert(Math.abs(d[0] - a.x) <= 0.11 && Math.abs(d[1] - a.y) <= 0.11, name + ': ' + a.name + ' did not end the tick on its position: ' + JSON.stringify([d, a.x, a.y]));
        seen.ticks++;
      }
      if (a.walking) seen.walking++;
      const key = a.name;
      const flip = /scaleX\(-1\)/.test(a.transform);
      if (last && last[key] && last[key].flip !== flip && last[key].shown) {
        assert(firstOfTick, name + ': ' + key + ' turned round in the middle of a tick');
        seen.flips++;
      }
      if (each) await each(a, d, firstOfTick);
    }
    last = {};
    for (const a of actors) last[a.name] = { flip: /scaleX\(-1\)/.test(a.transform), shown: a.shown };
  }
  throw new Error(name + ' never ended');
}

async function checkSmoothDraw() {
  const page = await newHub();
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  // A walk: fractions between ticks, exactly on each tick at its end, and
  // the picture by distance walked (stride), not by tick.
  const gaits = { checked: 0, midTick: 0 };
  let lastShown = {};
  const seen = await drawThrough(page, 'stroll', { seed: 3, dir: 'right' }, async (a, d, first) => {
    if (a.gait && a.gait.d !== null) {
      const n = a.gait.keys.length;
      let k = Math.floor(a.gait.d / a.gait.stride * n + 1e-6) % n;
      if (a.gait.cuts) {
        const f = (a.gait.d / a.gait.stride + 1e-6) % 1;
        for (k = n - 1; k > 0 && f < a.gait.cuts[k]; k--);
      }
      const want = a.gait.keys[k];
      assert(a.shown === want, 'stroll: ' + a.name + ' shows ' + a.shown + ' after ' + a.gait.d + ' px, not ' + want);
      gaits.checked++;
      if (!first && lastShown[a.name] && lastShown[a.name] !== a.shown) gaits.midTick++;
    }
    lastShown[a.name] = a.shown;
  });
  assert(seen.fractions > 100 && seen.ticks > 100 && seen.walking > 100, 'stroll: ' + JSON.stringify(seen));
  assert(gaits.checked > 100 && gaits.midTick > 0, 'pictures by distance: ' + JSON.stringify(gaits));
  // Teleports (a high five after a hide, the ball thrown from the hand) and turns.
  const f = await drawThrough(page, 'fetch', { seed: 5, dir: 'left' });
  assert(f.jumps > 3 && f.flips > 2, 'fetch: ' + JSON.stringify(f));
  const z = await drawThrough(page, 'zoomies', { seed: 4, dir: 'right' });
  assert(z.flips >= 2 && z.fractions > 50, 'zoomies: ' + JSON.stringify(z));
  // When her run has pictures in mid-air (lifts in the sprite list), some of
  // the zoomies' draws are lifted, and were checked above under their lift.
  const runLifted = await page.evaluate(() => {
    const S = window.CLAY_SPRITES;
    return (S.sequences['ember.run'] || []).some((k) => (S.lifts || {})[k] > 0);
  });
  assert(!runLifted || z.lifted > 0, 'zoomies: no lifted picture was drawn: ' + JSON.stringify(z));
  noErrors(page);
}

// A held pose breathes (a scale about the feet), a walk leans, the shadow
// does neither; MOVE_WITH_POSE moves a walk only with its picture; the
// blend experiment keeps the old picture fully drawn while the new one comes.
async function checkLife() {
  const page = await newHub();
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(page, 'perch', { seed: 2, pose: 'sit-edge', ledge: 0 });
  const scales = new Set();
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.HUB_TEST.clay.advance(50));
    const a = (await page.evaluate(() => window.HUB_TEST.clay.actors()))[0];
    const m = /scale\(([\d.]+), ?([\d.]+)\)/.exec(a.transform);
    if (m) scales.add(m[2]);
    if (m) assert(Math.abs(parseFloat(m[2]) - 1) < 0.02, 'breathing too much: ' + a.transform);
  }
  assert(scales.size > 10, 'a held pose does not breathe: ' + Array.from(scales).join(', '));
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  // Leaning into a walk, and the walk's position: continuous by default,
  // only with the picture when MOVE_WITH_POSE is on.
  for (const withPose of [false, true]) {
    await page.evaluate((w) => window.HUB_TEST.clay.setMoveWithPose(w), withPose);
    await playing(page, 'stroll', { seed: 3, dir: 'right' });
    let moves = 0;
    let movesAlone = 0;
    let leans = 0;
    let prev = null;
    for (let i = 0; i < 160; i++) {
      await page.evaluate(() => window.HUB_TEST.clay.advance(20));
      const a = (await page.evaluate(() => window.HUB_TEST.clay.actors()))[0];
      if (!a.walking || !a.shown) { prev = null; continue; }
      if (/rotate\(\d/.test(a.transform)) leans++;
      const d = drawn(a.transform);
      if (prev && d[0] !== prev.x) {
        moves++;
        if (a.shown === prev.shown) movesAlone++;
      }
      prev = { x: d[0], shown: a.shown };
    }
    assert(moves > (withPose ? 6 : 20) && leans > 20, 'withPose ' + withPose + ': moves ' + moves + ', leans ' + leans);
    if (withPose) assert(movesAlone <= 2, 'with MOVE_WITH_POSE the position moved without the picture ' + movesAlone + ' times');
    else assert(movesAlone > 20, 'the position only moved with the picture (' + movesAlone + ')');
    await page.evaluate(() => window.HUB_TEST.clay.stop());
  }
  await page.evaluate(() => window.HUB_TEST.clay.setMoveWithPose(null));
  // The blend (off by default): never two half-drawn pictures; the old one stays at 1.
  await page.evaluate(() => window.HUB_TEST.clay.setBlend(90));
  await playing(page, 'stroll', { seed: 3, dir: 'right' });
  let blends = 0;
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => window.HUB_TEST.clay.advance(20));
    for (const a of await page.evaluate(() => window.HUB_TEST.clay.actors())) {
      const ops = Object.values(a.opacities).map(Number);
      if (ops.length > 1) {
        blends++;
        assert(ops.length === 2 && ops.some((v) => v === 1), a.name + ' blends ' + JSON.stringify(a.opacities));
      }
    }
  }
  assert(blends > 5, 'no blends seen');
  await page.evaluate(() => { window.HUB_TEST.clay.stop(); window.HUB_TEST.clay.setBlend(null); });
  noErrors(page);
}

// At the real speed: drawn by requestAnimationFrame, smoothly, with only
// transform and opacity changing; the About panel says so.
async function checkSmoothLive() {
  const page = await newHub({ clay: { idleAfter: 3600 } });
  await page.evaluate(() => {
    window.__clay = { bad: [], fractions: 0 };
    new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (n.className !== 'clay-layer') continue;
          new MutationObserver((ms) => {
            for (const x of ms) {
              if (x.attributeName !== 'style') { window.__clay.bad.push(x.attributeName); continue; }
              const was = String(x.oldValue || '').replace(/(transform|opacity):[^;]*;?/g, '').trim();
              const now = String(x.target.getAttribute('style') || '').replace(/(transform|opacity):[^;]*;?/g, '').trim();
              if (was !== now) window.__clay.bad.push(was + ' -> ' + now);
              if (/translate3d\(-?\d+\.\dpx/.test(x.target.style.transform)) window.__clay.fractions++;
            }
          }).observe(n, { attributes: true, attributeOldValue: true, subtree: true });
        }
      }
    }).observe(document.body, { childList: true });
  });
  await playing(page, 'zoomies', { seed: 9 });
  await sleep(3000);
  const d = await page.evaluate(() => window.HUB_TEST.clay.drawing());
  const seen = await page.evaluate(() => window.__clay);
  assert(d.mode === 'smooth' && d.fps >= 20, 'drawing: ' + JSON.stringify(d));
  assert(/^Smooth, \d+ frames a second$/.test(d.text), 'text: ' + d.text);
  assert(!seen.bad.length, 'changed: ' + seen.bad.slice(0, 5).join(' | '));
  assert(seen.fractions > 20, 'no positions between pixels: ' + seen.fractions);
  assert(await page.evaluate(() => window.HUB_TEST.about.open()), 'the About panel did not open');
  await until(async () => /^Smooth, \d+ frames a second$/.test(await about.value(page, 'Drawing')), 3000, 'no Drawing row');
  const rows = (await about.rows(page)).map((r) => r.label).join(',');
  assert(rows === 'Version,Browser,Motion,Look,Watch link test,Now,Visits,Drawing,Loading', 'rows: ' + rows);
  noErrors(page);
}

// Slow frames: stepped for the rest of the scene and remembered for the
// next visits; no requestAnimationFrame at all: stepped from the start.
async function checkStepped() {
  let page = await newHub({ clay: { idleAfter: 3600 } });
  // About 11 frames a second.
  await page.evaluate(() => {
    window.__raf = [window.requestAnimationFrame, window.cancelAnimationFrame];
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 90);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  });
  await playing(page, 'stroll', { seed: 5 });
  const d = await until(async () => { const x = await page.evaluate(() => window.HUB_TEST.clay.drawing()); return x.mode === 'stepped' ? x : false; }, 4000, 'slow frames did not go stepped');
  assert(d.why === 'slow' && d.fps >= 5 && d.fps < 20 && d.text === 'Stepped: the screen managed ' + d.fps + ' frames a second', 'drawing: ' + JSON.stringify(d));
  // It goes on, a tick a timer, at whole pixels.
  const t0 = (await look.state(page)).tick;
  await sleep(1000);
  const t1 = (await look.state(page)).tick;
  assert(t1 - t0 >= 5 && t1 - t0 <= 9, 'stepped ticks in a second: ' + (t1 - t0));
  const tf = (await page.evaluate(() => window.HUB_TEST.clay.actors())).filter((a) => a.shown).map((a) => a.transform);
  assert(tf.length && tf.every((t) => /^translate3d\(-?\d+px, ?-?\d+px, ?0(px)?\)( scaleX\(-1\))?$/.test(t)), 'stepped transforms: ' + tf.join(' | '));
  // The next visit starts stepped, remembered.
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  await playing(page, 'zoomies', { seed: 6 });
  let d2 = await page.evaluate(() => window.HUB_TEST.clay.drawing());
  assert(d2.mode === 'stepped' && d2.why === 'remembered' && /^Stepped: the screen managed \d+ frames a second \d+ s ago; smooth is tried again in \d+ min \d+ s$/.test(d2.text), 'remembered: ' + JSON.stringify(d2));
  // After 30 minutes it tries again (and the frames are fine now).
  await page.evaluate(() => { window.HUB_TEST.clay.stop(); window.HUB_TEST.clay.forgetSlow(); window.requestAnimationFrame = window.__raf[0]; window.cancelAnimationFrame = window.__raf[1]; });
  await playing(page, 'zoomies', { seed: 7 });
  d2 = await page.evaluate(() => window.HUB_TEST.clay.drawing());
  assert(d2.mode === 'smooth', 'did not try smooth again: ' + JSON.stringify(d2));
  noErrors(page);
  await page.ctx.close();
  // No requestAnimationFrame at all.
  page = await newHub({ clay: { idleAfter: 3600 } });
  await page.evaluate(() => { window.requestAnimationFrame = undefined; });
  await playing(page, 'zoomies', { seed: 8 });
  const d3 = await page.evaluate(() => window.HUB_TEST.clay.drawing());
  assert(d3.mode === 'stepped' && d3.why === 'no-raf' && d3.text === 'Stepped: this browser has no requestAnimationFrame', 'no rAF: ' + JSON.stringify(d3));
  const a0 = (await look.state(page)).tick;
  await sleep(700);
  assert((await look.state(page)).tick - a0 >= 3, 'no ticks without requestAnimationFrame');
  assert(await page.evaluate(() => window.HUB_TEST.about.open()), 'the About panel did not open');
  await until(async () => (await about.value(page, 'Drawing')) === 'Stepped: this browser has no requestAnimationFrame', 3000, 'Drawing row');
  noErrors(page);
}

// Every scene's length (at the real speed) is inside its range, whichever
// way it goes and whatever the dice say, with 40 pictures or fewer (the
// engine's limit, MAX_FRAMES).
const LENGTHS = {
  perch: [20, 30], zoomies: [18, 25], stroll: [30, 40], morning: [30, 40], evening: [30, 40], weather: [30, 40],
  fetch: [35, 45], 'fetch-bolt': [30, 45], 'fetch-snub': [30, 45], 'sock-heist': [35, 45], cheer: [15, 20], shrug: [15, 20], night: [40, 60]
};
async function checkLengths() {
  const page = await newHub();
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(page, 'shrug', { seed: 1 });
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  const out = await page.evaluate(([plays, L]) => {
    const bad = [];
    const seen = {};
    for (const [n, o] of plays) {
      for (let s = 1; s <= 12; s++) {
        for (const dir of ['left', 'right']) {
          const d = window.HUB_TEST.clay.dry(n, Object.assign({ seed: s * 7, dir: dir }, o));
          if (!d) { bad.push(n + ' did not build'); continue; }
          const r = L[n];
          if (d.seconds < r[0] || d.seconds > r[1]) bad.push(n + ' ' + JSON.stringify(o) + ' seed ' + s * 7 + ' ' + dir + ': ' + d.seconds + ' s');
          if (d.frames > 40) bad.push(n + ': ' + d.frames + ' pictures');
          seen[n] = (seen[n] || 0) + 1;
        }
      }
    }
    return { bad, seen };
  }, [PLAYS, LENGTHS]);
  assert(!out.bad.length, out.bad.slice(0, 6).join('; '));
  assert(Object.keys(out.seen).length === Object.keys(LENGTHS).length, 'scenes: ' + JSON.stringify(out.seen));
  // Longer walk cycles drop in through the sprite list: a sequence of any
  // length and its stride, with no change to clay.js.
  const longer = await page.evaluate(() => {
    const S = window.CLAY_SPRITES;
    S.sequences['ian.walk'] = ['ian/walk-1', 'ian/stand', 'ian/walk-2', 'ian/stand'];
    S.strides = { 'ian.walk': 100 };
    return window.HUB_TEST.clay.dry('stroll', { seed: 3, dir: 'right' });
  });
  assert(longer.gaits['ian.walk'] === 4, 'a longer cycle: ' + JSON.stringify(longer.gaits));
  await playing(page, 'stroll', { seed: 3, dir: 'right' });
  const g = await until(async () => {
    await page.evaluate(() => window.HUB_TEST.clay.advance(35));
    const a = (await page.evaluate(() => window.HUB_TEST.clay.actors()))[0];
    return a.gait && a.gait.d > 60 ? a : false;
  }, 8000, 'Ian never walked');
  assert(g.gait.keys.length === 4 && g.gait.stride === 100 && g.shown === g.gait.keys[Math.floor(g.gait.d / 25 + 1e-6) % 4], 'with the longer cycle: ' + JSON.stringify(g.gait) + ' shows ' + g.shown);
  await page.evaluate(() => { window.HUB_TEST.clay.stop(); });
  // With 8-picture cycles for every gait, every scene still loads 40 or
  // fewer pictures (fetch and sock-heist leave the carrying cycles out).
  const eight = await page.evaluate(([plays]) => {
    const S = window.CLAY_SPRITES;
    const names = ['ian.walk', 'ian.run', 'ember.trot', 'ember.run', 'ember.ball-trot', 'ember.sock-run'];
    S.strides = {};
    for (const n of names) {
      S.sequences[n] = [];
      for (let i = 1; i <= 8; i++) {
        const key = 'test/' + n + '-' + i;
        S.sprites[key] = Object.assign({}, S.sprites[n.indexOf('ian') === 0 ? 'ian/walk-1' : 'ember/trot-1']);
        S.sequences[n].push(key);
      }
      S.strides[n] = 160;
    }
    const out = {};
    for (const [n, o] of plays) {
      const d = window.HUB_TEST.clay.dry(n, Object.assign({ seed: 5, dir: 'right' }, o));
      out[n + (o.outfit ? '-' + o.outfit : o.pose ? '-' + o.pose : o.nap !== undefined ? '-' + o.nap : '')] = { frames: d.frames, gaits: d.gaits };
    }
    return out;
  }, [PLAYS]);
  const over = Object.keys(eight).filter((k) => eight[k].frames > 40);
  assert(!over.length, 'over 40 pictures with 8-picture cycles: ' + over.map((k) => k + ' ' + eight[k].frames).join(', '));
  assert(eight.stroll.gaits['ian.walk'] === 8 && eight.fetch.frames <= 40 && !eight.fetch.gaits['ember.ball-trot'], 'fetch: ' + JSON.stringify(eight.fetch));
  if (process.env.CLAY_EIGHT) console.log(JSON.stringify(eight));
  noErrors(page);
}

// Gait art of any shape: made-up 6- and 7-picture cycles with their
// strides, lifts (pictures drawn above the floor, the shadow staying down,
// and no hand-made bob on top), shares (pictures covering different parts of
// the stride) and Ian standing side-on to stop out of a walk; then the
// sprite list as it is.
async function checkGaitArt() {
  const page = await newHub();
  await page.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(page, 'shrug', { seed: 1 });
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  const plan = await page.evaluate(([plays, L]) => {
    const S = window.CLAY_SPRITES;
    const sets = { 'ian.walk': 6, 'ian.run': 6, 'ember.trot': 6, 'ember.run': 7, 'ember.ball-trot': 6, 'ember.sock-run': 7 };
    S.strides = { 'ian.walk': 86, 'ian.run': 230, 'ember.trot': 90, 'ember.run': 120, 'ember.ball-trot': 90, 'ember.sock-run': 120 };
    S.lifts = {};
    for (const n of Object.keys(sets)) {
      S.sequences[n] = [];
      for (let i = 1; i <= sets[n]; i++) {
        const key = 'art/' + n + '-' + i;
        S.sprites[key] = Object.assign({}, S.sprites[n.indexOf('ian') === 0 ? 'ian/walk-1' : 'ember/trot-1']);
        S.sequences[n].push(key);
      }
    }
    S.lifts['art/ian.walk-2'] = 6;
    S.lifts['art/ember.run-1'] = 14;
    S.lifts['art/ember.run-4'] = 11;
    S.lifts['art/ian.run-5'] = 12;
    S.shares = { 'ian.walk': [2, 1, 1, 1, 1, 1], 'ember.trot': [1, 1] };
    S.sprites['ian/stand-side'] = Object.assign({}, S.sprites['ian/walk-1']);
    const bad = [];
    const frames = {};
    for (const [n, o] of plays) {
      for (const dir of ['left', 'right']) {
        const d = window.HUB_TEST.clay.dry(n, Object.assign({ seed: 9, dir: dir }, o));
        if (!d) { bad.push(n + ' did not build'); continue; }
        frames[n + (o.outfit ? '-' + o.outfit : o.pose ? '-' + o.pose : o.nap !== undefined ? '-' + o.nap : '')] = { frames: d.frames, seconds: d.seconds, gaits: d.gaits };
        if (d.frames > 40) bad.push(n + ': ' + d.frames + ' pictures');
        if (d.seconds < L[n][0] || d.seconds > L[n][1]) bad.push(n + ' ' + dir + ': ' + d.seconds + ' s');
      }
    }
    const stroll = window.HUB_TEST.clay.dry('stroll', { seed: 3, dir: 'right' });
    return { bad, frames, side: stroll.keys.indexOf('ian/stand-side') >= 0, gaits: stroll.gaits };
  }, [PLAYS, LENGTHS]);
  if (process.env.CLAY_EIGHT) console.log(JSON.stringify(plan.frames));
  assert(!plan.bad.length, plan.bad.slice(0, 6).join('; '));
  assert(plan.side && plan.gaits['ian.walk'] === 6, 'stroll with the new art: ' + JSON.stringify(plan));
  // Both carrying cycles fit (fetch leaves its heart out to make room).
  assert(plan.frames.fetch.gaits['ember.ball-trot'] === 6 && plan.frames['sock-heist'].gaits['ember.sock-run'] === 7,
    'carrying cycles: ' + JSON.stringify([plan.frames.fetch, plan.frames['sock-heist']]));
  await playing(page, 'stroll', { seed: 3, dir: 'right' });
  const ty = (s) => Number((/translate3d\([-\d.]+px, ?([-\d.]+)px/.exec(s) || [])[1]);
  let lifted = null;
  let plain = null;
  let sharesOk = 0;
  for (let i = 0; i < 400 && !(lifted && plain && sharesOk > 20); i++) {
    await page.evaluate(() => window.HUB_TEST.clay.advance(23));
    const a = (await page.evaluate(() => window.HUB_TEST.clay.actors()))[0];
    if (!a.gait || a.gait.d === null) continue;
    assert(!a.gait.bob, 'a gait with lifts kept its bob');
    const cuts = [0, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7];
    assert(JSON.stringify(a.gait.cuts.map((c) => c.toFixed(4))) === JSON.stringify(cuts.map((c) => c.toFixed(4))), 'cuts: ' + JSON.stringify(a.gait.cuts));
    const f = ((a.gait.d / 86) + 1e-6) % 1;
    let k = 5;
    while (k > 0 && f < cuts[k]) k--;
    assert(a.shown === a.gait.keys[k], 'by shares, ' + a.gait.d.toFixed(1) + ' px should show ' + a.gait.keys[k] + ', shows ' + a.shown);
    sharesOk++;
    const gap = ty(a.shadow) - ty(a.transform);
    if (a.shown === 'art/ian.walk-2') { lifted = { lift: a.lift, gap: gap }; } else { plain = { lift: a.lift, gap: gap }; }
  }
  assert(lifted && plain, 'saw no lifted and plain pictures: ' + JSON.stringify({ lifted, plain }));
  assert(lifted.lift === 6 && plain.lift === 0 && Math.abs((lifted.gap - plain.gap) - 6) < 0.6,
    'the lifted picture should be 6 px higher over the same shadow: ' + JSON.stringify({ lifted, plain }));
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  // The sprite list as it is (the real art, or its old shape with
  // CLAY_ART=old): a gait keeps its hand-made bob only when none of its
  // pictures has a lift, every draw is lifted by its picture's lift, Ian
  // stops side-on only when the list has that picture, and the carrying
  // cycles the list has are used.
  const today = await newHub();
  await today.evaluate(() => window.HUB_TEST.clay.setSpeed(0));
  await playing(today, 'stroll', { seed: 3, dir: 'right' });
  const list = await today.evaluate(() => {
    const S = window.CLAY_SPRITES;
    const L = S.lifts || {};
    const C = window.HUB_TEST.clay;
    const has = (q) => !!(S.sequences[q] && S.sequences[q].length);
    return {
      lifts: L,
      walkLifted: (S.sequences['ian.walk'] || []).some((k) => L[k] > 0),
      side: !!S.sprites['ian/stand-side'],
      sideUsed: C.dry('stroll', { seed: 3, dir: 'right' }).keys.indexOf('ian/stand-side') >= 0,
      ball: has('ember.ball-trot'),
      ballUsed: (C.dry('fetch', { seed: 5, dir: 'right' }).gaits['ember.ball-trot'] || 0) > 1,
      sock: has('ember.sock-run'),
      sockUsed: (C.dry('sock-heist', { seed: 5, dir: 'right' }).gaits['ember.sock-run'] || 0) > 1
    };
  });
  assert(list.side === list.sideUsed && list.ball === list.ballUsed && list.sock === list.sockUsed, 'the list as it is: ' + JSON.stringify(list));
  let walked = 0;
  await until(async () => {
    await today.evaluate(() => window.HUB_TEST.clay.advance(35));
    const a = (await today.evaluate(() => window.HUB_TEST.clay.actors()))[0];
    if (!a.gait || a.gait.d === null) return false;
    assert(a.gait.bob === !list.walkLifted && a.gait.cuts === null && a.lift === (list.lifts[a.shown] || 0),
      'the list as it is: ' + JSON.stringify(a.gait) + ' shows ' + a.shown + ' lifted ' + a.lift);
    return ++walked > 20;
  }, 8000, 'Ian never walked');
  await today.evaluate(() => window.HUB_TEST.clay.stop());
  noErrors(page);
  noErrors(today);
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
// scroll: the box may be taller than the screen (Up and Down scroll it): then
// what matters is that its end can be scrolled to and nothing is cut.
function aboutFit(page, scroll) {
  return page.evaluate((scroll) => {
    const box = document.querySelector('#about .about-box');
    const b = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const inner = { left: b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - 0.5,
      right: b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 0.5 };
    const bad = [];
    if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) bad.push('box off screen ' + JSON.stringify(b));
    if (box.scrollHeight > box.clientHeight + 1 && !scroll) bad.push('box taller than its room: ' + box.scrollHeight + ' > ' + box.clientHeight);
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
  }, !!scroll);
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
  // (Enter is the Watch link test row's action since v0.28.16; checked below.)
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft']) {
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
  // (closePanel is refused while the panel is still opening, so ask until it goes.)
  await until(() => page.evaluate(() => { window.HUB_TEST.closePanel(); return window.HUB_TEST.open() === null && !window.HUB_TEST.busy(); }), 4000, 'the weather panel did not close');
  // Enter: the About panel's one action, the Watch link test (v0.28.16): it
  // closes About and opens Entertainment on the test.
  assert(await page.evaluate(() => window.HUB_TEST.about.open()), 'it did not open again');
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy()), 4000, 'Enter did not open the watch link test');
  assert(!(await about.isOpen(page)), 'About stayed open over the link test');
  noErrors(page);
}

// The rows: which are there and when, they refresh by themselves, and a
// long problem wraps inside the strip at 1920x1080 and 1280x720.
async function checkAboutRows() {
  const page = await newHub({ missing: ['clay/sprites/ember/stand-wag.webp'], clay: { idleAfter: 3600 } });
  assert(await page.evaluate(() => window.HUB_TEST.about.open()), 'did not open');
  let rows = await about.rows(page);
  const names = rows.map((r) => r.group + '/' + r.label).join(', ');
  // ?live=off and no TizenBrew: nothing to say about updates; no visit yet.
  assert(names === 'This hub/Version, This hub/Browser, This hub/Motion, This hub/Look, This hub/Watch link test, Wanderers/Now, Wanderers/Visits', 'rows at start: ' + names);
  const groups = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#about .about-group'), (e) => e.textContent).join(','));
  assert(groups === 'This hub,Wanderers', 'groups: ' + groups);
  assert(/^v0\.\d+\.\d+/.test(rows[0].value) && !/^Motion/.test(rows[2].value), 'values: ' + JSON.stringify(rows));
  // The countdown ticks with nothing calling it.
  // (The strip redraws once a second, so a read can be up to a second behind.)
  const n1 = await about.value(page, 'Now');
  await sleep(3200);
  const n2 = await about.value(page, 'Now');
  const m1 = /^Due back in (?:(\d+) min )?(\d+) s$/.exec(n1);
  const m2 = /^Due back in (?:(\d+) min )?(\d+) s$/.exec(n2);
  const secs = (m) => Number(m[1] || 0) * 60 + Number(m[2]);
  assert(m1 && m2 && secs(m2) <= secs(m1) - 2, 'the countdown did not tick: ' + n1 + ' / ' + n2);
  // A visit that fails: Last visit, Loading and Last problem come in by themselves.
  await page.evaluate(() => window.HUB_TEST.clay.play('stroll', { seed: 7 }));
  await until(async () => (await about.value(page, 'Last problem')) !== null, 5000, 'no Last problem row');
  rows = await about.rows(page);
  assert(rows.map((r) => r.label).join(',') === 'Version,Browser,Motion,Look,Watch link test,Now,Visits,Last visit,Loading,Last problem', 'rows after a failure: ' + rows.map((r) => r.label));
  const p1 = await about.value(page, 'Last problem');
  assert(/^scene stroll skipped: frame ember\/stand-wag failed \(onerror, 3 tries\), \d+ s ago$/.test(p1), 'problem: ' + p1);
  await until(async () => (await about.value(page, 'Last problem')) !== p1, 3000, 'the problem\'s age did not change by itself');
  // A long problem, with a long unbroken word: it wraps, nothing is cut.
  await page.evaluate(() => {
    const K = window.HUB_CLAY;
    const real = K.status;
    K.status = function () {
      const s = real.call(K);
      // The longest Drawing text, 25 % longer (another wording, a bigger number).
      s.drawing = window.__drawing25;
      s.problem = window.__problem || 'scene sock-heist skipped: frame ember/sock-proud failed (loaded, 0 px wide: did not decode) at ' +
        'https://cdn.jsdelivr.net/gh/example/tizen-takeover@0123456789abcdef0123456789abcdef01234567/app/clay/sprites/ember/sock-proud.webp, 12 s ago';
      return s;
    };
  });
  await page.evaluate(() => {
    const d = 'Stepped: the screen managed 14 frames a second 12 min ago; smooth is tried again in 18 min 30 s';
    window.__drawing25 = d + ' and then some more' + ' words, a bit longer'.repeat(Math.ceil(d.length * 0.25 / 20) - 1);
  });
  // With that very long problem every row wraps inside the strip and its
  // end can be scrolled to (Up and Down); with the longest real texts and
  // the Drawing row 25 % longer, it all fits without scrolling.
  for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => { window.__problem = null; });
    await sleep(1300);
    let fit = await aboutFit(page, true);
    assert(!fit.bad.length, size.width + 'x' + size.height + ': ' + fit.bad.join('; '));
    assert(fit.lastLines >= 4, size.width + 'x' + size.height + ': the long problem is on ' + fit.lastLines + ' lines');
    assert(fit.width <= 26 * fit.rem, size.width + 'x' + size.height + ': ' + fit.width + ' px wide');
    const dr = await about.value(page, 'Drawing');
    assert(dr && /^Stepped: the screen managed 14 frames/.test(dr), size.width + 'x' + size.height + ': Drawing row ' + dr);
    for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowDown'); await sleep(30); }
    const end = await page.evaluate(() => {
      const box = document.querySelector('#about .about-box');
      const vs = box.querySelectorAll('.about-value');
      return vs[vs.length - 1].getBoundingClientRect().bottom - box.getBoundingClientRect().bottom;
    });
    assert(end <= 1, size.width + 'x' + size.height + ': the end of the strip cannot be scrolled to (' + end + ' px short)');
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
    // The longest real problem, 25 % longer.
    await page.evaluate(() => { window.__problem = 'scene sock-heist skipped: frame ember/sock-proud failed (loaded, 0 px wide: did not decode), 12 s ago and then a bit'; });
    await sleep(1300);
    fit = await aboutFit(page);
    assert(!fit.bad.length, size.width + 'x' + size.height + ' (real texts): ' + fit.bad.join('; '));
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
    if (st.phase === 'playing' && /^On screen now: /.test(v || '')) break;
    await sleep(100);
  }
  const kinds = [];
  for (const v of seen) {
    const k = /^Due back in /.test(v) ? 'countdown' : /^Loading \S+(, \d+ of \d+ frames| \([a-z ]+\)), \d+ s$/.test(v) ? 'loading' : /^On screen now: \S+$/.test(v) ? 'on screen' : 'other: ' + v;
    if (kinds[kinds.length - 1] !== k) kinds.push(k);
  }
  assert(kinds.join(' > ') === 'countdown > loading > on screen', 'the panel showed: ' + seen.join(' | '));
  assert(seen.some((v) => /^Loading \S+, \d+ of \d+ frames, [1-9]\d* s$/.test(v)), 'no frame count while loading: ' + seen.join(' | '));
  assert(await about.isOpen(page), 'the panel closed');
  assert(await look.layer(page), 'no clay layer while the panel is open');
  const z = await page.evaluate(() => [Number(getComputedStyle(document.getElementById('about')).zIndex), Number(getComputedStyle(document.querySelector('.clay-layer')).zIndex)]);
  assert(z[0] > z[1], 'the panel is not above the wanderers: ' + z.join(' / '));
  // It plays on with the panel open. Right closes the panel and leaves the
  // visit playing (keys that belong to the panel are not "using the remote");
  // the next key on the tiles sends them away like any key.
  await sleep(1500);
  assert((await look.state(page)).phase === 'playing' && (await about.isOpen(page)), 'the visit or the panel ended by itself');
  await page.keyboard.press('ArrowRight');
  assert(!(await about.isOpen(page)), 'Right did not close the panel');
  assert((await look.state(page)).phase === 'playing', 'closing the panel sent them away');
  await page.keyboard.press('ArrowDown');
  assert((await look.state(page)).phase === 'waiting', 'a key on the tiles did not clear the screen');
  noErrors(page);
}

// Keys pressed while the About panel is open (scrolling, closing) do not
// restart the wanderers' wait; the next key on the tiles does.
async function checkAboutKeysKeepSchedule() {
  const page = await newHub({ clay: { idleAfter: 20, every: [90, 90] } });
  await page.evaluate(() => window.HUB_TEST.clay.setHour(14));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'busy');
  await leftToAbout(page);
  await page.evaluate(() => window.HUB_TEST.clay.dueIn(8000));
  const before = (await look.state(page)).nextIn;
  assert(before > 6000 && before <= 8000, 'nextIn after dueIn(8000): ' + before);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  const during = (await look.state(page)).nextIn;
  assert(during <= before && during > 4000, 'keys inside the panel moved the visit: ' + before + ' -> ' + during);
  await page.keyboard.press('ArrowRight');
  assert(!(await about.isOpen(page)), 'Right did not close the panel');
  const closed = (await look.state(page)).nextIn;
  assert(closed <= before && closed > 3000, 'closing the panel moved the visit: ' + before + ' -> ' + closed);
  // A key on the tiles is use of the remote: the wait starts over (idleAfter 20 s).
  await page.keyboard.press('ArrowDown');
  const after = (await look.state(page)).nextIn;
  assert(after > 15000, 'a key on the tiles did not restart the wait: ' + after);
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
  // Many visits in a row at 14:00 with no weather outfit, each told the one
  // before: equal shares by family, and never one family twice in a row.
  const run = await page.evaluate(() => {
    const C = window.HUB_TEST.clay;
    const ws = (window.HUB_WIDGETS || []).filter((x) => x && x.id === 'weather');
    const saved = ws.map((x) => ({ x, had: x.hasOwnProperty('current'), real: x.current }));
    for (const x of ws) x.current = function () { return null; };
    const seq = [];
    try {
      C.setHour(14);
      let last = '';
      for (let i = 0; i < 4000; i++) {
        C.setLast(last);
        last = C.choose();
        seq.push(last);
      }
    } finally {
      for (const v of saved) { if (v.had) v.x.current = v.real; else delete v.x.current; }
      C.setLast('');
      C.setHour(null);
    }
    return seq;
  });
  const fam = (n) => /^fetch(-|$)/.test(n) ? 'fetch' : n;
  const count = {};
  for (const n of run) count[fam(n)] = (count[fam(n)] || 0) + 1;
  const share = (f) => (count[f] || 0) / run.length;
  const shares = Object.keys(count).sort().map((f) => f + ' ' + (100 * share(f)).toFixed(1) + '%').join(', ');
  assert(!count.weather && !count.night && !count.morning && !count.evening, 'hour 14 without weather: ' + shares);
  assert(share('sock-heist') >= 0.17 && share('sock-heist') <= 0.23, 'sock-heist share: ' + shares);
  assert(share('fetch') >= 0.17 && share('fetch') <= 0.23, 'fetch family share: ' + shares);
  for (let i = 1; i < run.length; i++) assert(fam(run[i]) !== fam(run[i - 1]), 'same family twice in a row at ' + i + ': ' + run[i - 1] + ', ' + run[i]);
  console.log('    day shares over ' + run.length + ' picks: ' + shares);
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
  await check('9. Night hours pick night scenes; by day each family as likely, never twice in a row; a ticked to-do item queues a cheer', checkChoosing);
  await check('10. The status: playing, stopped, a busy hub, a page that reports hidden', checkStatus);
  await check('11. The sprite list: not valid, too slow (and used when it comes late), and a failure tried again at the next visit', checkSpriteList);
  await check('12. No stylesheet to wait for: a scene plays with clay.css never asked for', checkNoStylesheet);
  await check('13. A frame that does not decode is told apart; a skipped scene is back after 10 minutes', checkBrokenScene);
  await check('14. The About panel: Left from a left-most tile opens it, Up does not; Right, Back and a click close it; never over a panel', checkAboutKeys);
  await check('14b. The About panel\'s rows: present or absent, refreshed by themselves; a long problem wraps at 1920x1080 and 1280x720', checkAboutRows);
  await check('14c. The About panel is not busy: a visit loads and plays with it open, and it shows countdown, loading, on screen', checkAboutNotBusy);
  await check('14d. Keys inside the About panel (scrolling, closing) keep their schedule; the next key on the tiles restarts the wait', checkAboutKeysKeepSchedule);
  await check('15. Slow frames: the visit is skipped, not marked broken, and the same scene plays at the next visit', checkSlowFrames);
  await check('16. The next visit\'s frames load ahead; that scene comes, no earlier', checkAhead);
  await check('17. The default pause after a daytime visit is 90 to 150 s', checkDefaultEvery);
  await check('18. After a slow visit the next comes 20 s later, three times in a row, then every[0]', checkSlowRetry);
  await check('19. Images that never answer are kept at most 200 at a time', checkSettlingCap);
  await check('20. Drawn between ticks: by fractions, exactly on each tick at its end; a teleport or a turn never glides; pictures by distance', checkSmoothDraw);
  await check('21. A held pose breathes, a walk leans, the shadow does neither; MOVE_WITH_POSE; the blend keeps the old picture whole', checkLife);
  await check('22. At the real speed: smooth by requestAnimationFrame, only transform and opacity change; the About panel says so', checkSmoothLive);
  await check('23. Slow frames go stepped and are remembered; no requestAnimationFrame is stepped from the start', checkStepped);
  await check('24. Every scene\'s length is in its range, with 40 pictures or fewer', checkLengths);
  await check('25. Gait art of any shape: 6- and 7-picture cycles, lifts over a grounded shadow and no bob, shares, Ian side-on; the sprite list as it is', checkGaitArt);
  await check('26. A picture that fails once or twice is asked for again and the scene still plays', checkAskedAgain);
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
