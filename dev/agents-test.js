/*
 * Characters (app/agents.js), end to end: node dev/agents-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js),
 * the hub server from pi/ and a stand-in for Spotify (dev/mock-spotify.js),
 * all on spare ports with a fresh data folder, like dev/working-test.js.
 * Signals go the real way: a say command to the hub server ("hub:working
 * todo"), a new to-do, a calendar change, a changed snapshot.
 *
 * Checks: Lift glides in beside a working chip, idles at the tile's bottom
 * right clear of the chip, and pulses and glides out when it ends, leaving
 * nothing; she comes with an arrival chip (to-do, calendar) and leaves as it
 * fades; a working chip turning into the arrival chip sends her out; never
 * in fade mode, on a slow screen (where the chips still show) or with
 * agents off (config, on: false, ?agent=off: nothing loads), and an unknown
 * `who` is off without an error; at most two on screen and one per tile
 * (three arrival chips at once); only transform and opacity animate; a
 * picture that fails (three tries) means no swoop and no broken picture;
 * a panel ends her at once; a tile at the right screen edge has her come
 * from the left, one at the left from the right; three layouts; the About
 * panel's Characters rows, in English and Spanish.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * AGENTS_GREP=<text> runs only the checks whose name contains it. It cannot
 * prove the TV: a desktop browser runs far faster.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const mockSpotify = require('./mock-spotify');
const calendarSample = require('./calendar-sample');
const awwsSample = require('./awws-sample');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];
const BUILD = /var BUILD = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'hub.js'), 'utf8'))[1];

let PAGE_PORT, PAGE, preview = null, browser = null, mock = null, feeds = null;
const pis = [];
const tmp = [];
const results = [];
const openContexts = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, t) { if (!c) throw new Error(t); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(40);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

async function check(name, fn) {
  if (process.env.AGENTS_GREP && name.indexOf(process.env.AGENTS_GREP) < 0) return;
  const started = Date.now();
  try {
    await fn();
    results.push(true);
    console.log('ok    ' + name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    results.push(false);
    console.log('FAIL  ' + name + ': ' + (e && e.message ? e.message : e));
  }
  for (const c of Array.from(openContexts)) {
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

/* ---------- servers (as in dev/working-test.js) ---------- */

async function startPi() {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agents-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    calendars: feeds ? feeds.calendars : [], allowHttp: true,
    spotifyEnv: { SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback' },
    spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 }
  });
  await h.ready;
  const pi = { h: h, port: port, url: 'http://127.0.0.1:' + port, dir: dir };
  pis.push(pi);
  const l = h.spotify.loginUrl();
  await new Promise((resolve, reject) => {
    http.get(l.url, (res) => { res.resume(); h.spotify.finishLogin(res.headers.location || '').then(resolve, reject); }).on('error', reject);
  });
  return pi;
}

function control(pi, method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: pi.port, path: route, method: method,
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

async function say(pi, text) {
  const r = await control(pi, 'POST', '/api/command', { type: 'say', data: { text: text } });
  assert(r && r.ok, 'the server refused the say "' + text + '": ' + JSON.stringify(r));
}

async function postTodo(pi, title) {
  const r = await control(pi, 'POST', '/api/todo', { title: title, section: 'now' });
  assert(r.ok, 'the server refused the to-do: ' + JSON.stringify(r));
  return r.item.id;
}

function snapshotNow(opts) {
  const snap = awwsSample.snapshot(Object.assign({ today: awwsSample.chicagoToday() }, opts || {}));
  snap.sentAt = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, 'Z');
  delete snap.receivedAt;
  return snap;
}

async function postSnapshot(pi, snap) {
  const r = await control(pi, 'POST', '/api/awws', { snapshot: snap });
  assert(r && r.ok, 'the server refused the snapshot: ' + JSON.stringify(r));
}

async function setLayout(pi, layout) {
  const r = await control(pi, 'POST', '/api/layout', { layout: layout });
  assert(r && r.ok, 'the server refused the layout: ' + JSON.stringify(r));
}

async function calendarChange(pi) {
  feeds.setMode(feeds.mode() === 'empty' ? 'sample' : 'empty');
  await control(pi, 'POST', '/api/calendar/refresh', {});
}

/* ---------- pages ---------- */

// Notes every character the page adds (window.__figs) and every request for her pictures.
const WATCH = '(function () { window.__figs = []; function watch() {' +
  ' new MutationObserver(function (ms) { ms.forEach(function (m) {' +
  '  Array.prototype.forEach.call(m.addedNodes, function (n) {' +
  '   if (n.nodeType === 1 && n.classList && n.classList.contains("ag-fig")) window.__figs.push({ t: Date.now() }); }); }); })' +
  '.observe(document.documentElement, { childList: true, subtree: true });' +
  ' } if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch); })();';

// o: { pi, query, config (JS appended to config.js), init, slow ({ mode, fps }), failPics (n: abort the first n fetches of each picture; Infinity), size }
async function open(o) {
  o = o || {};
  const size = o.size || { width: 1920, height: 1080 };
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  const picHits = {};
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (BLOCKED.indexOf(u.hostname) >= 0) return route.abort();
    const m = /\/agents\/[a-z]+\/([a-z-]+\.webp)$/.exec(u.pathname);
    if (m) {
      picHits[m[1]] = (picHits[m[1]] || 0) + 1;
      if (o.failPics && picHits[m[1]] <= o.failPics) return route.abort();
    }
    return route.continue();
  });
  if (o.config) {
    await context.route('**/config.js', async (route) => {
      const r = await route.fetch();
      route.fulfill({ response: r, body: (await r.text()) + '\n' + o.config + '\n' });
    });
  }
  if (o.slow) {
    await context.addInitScript((rec) => { try { localStorage.setItem('homeHub.motion', JSON.stringify(rec)); } catch (e) { /* ignore */ } },
      { mode: o.slow.mode, build: BUILD, fps: o.slow.fps });
  }
  await context.addInitScript(WATCH);
  if (o.init) await context.addInitScript(o.init);
  const page = await context.newPage();
  page.errors = [];
  page.picHits = picHits;
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(PAGE + '/hub.html?clay=off&live=' + encodeURIComponent(o.pi.url) + '&' + (o.query || 'motion=push'));
  await ready(page);
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'the hub did not go live');
  await idle(page);
  await sleep(400);
}

const idle = (page) => until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
function noErrors(page) { assert(!page.errors.length, 'page errors: ' + page.errors.join(' | ')); }
const state = (page) => page.evaluate(() => window.HUB_AGENTS ? window.HUB_AGENTS.test.state() : null);
const figLog = (page) => page.evaluate(() => window.__figs.slice());

// Every character on screen now: its tile, rect, the tile's and the chip's rects, its pictures.
const figsNow = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.ag-fig'), (n) => {
  const r = n.getBoundingClientRect();
  const st = window.HUB_AGENTS.test.state();
  const f = st.figs.filter((x) => Math.abs(x.y - r.top) < 40)[0] || null;
  const imgs = Array.prototype.map.call(n.querySelectorAll('img'), (i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') }));
  return { rect: [r.left, r.top, r.width, r.height].map(Math.round), imgs: imgs, cls: n.className, widget: f ? f.widget : '', state: f ? f.state : '' };
}));

async function figOn(page, widget, wantState) {
  return until(async () => {
    const s = await state(page);
    const f = s && s.figs.filter((x) => x.widget === widget)[0];
    return f && (!wantState || f.state === wantState) ? f : false;
  }, 4000, 'no character on ' + widget);
}

const noneLeft = (page, ms, text) => until(() => page.evaluate(() => !document.querySelector('.ag-layer, .ag-fig, .ag-pulse')), ms, text);

// The tile's rect and its chip's, for where she stands.
const rects = (page, widget) => page.evaluate((w) => {
  const tile = document.querySelector('.cell[data-widget="' + w + '"] .tile');
  const chip = tile && tile.querySelector('.fx-chip');
  const R = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  return { tile: tile ? R(tile) : null, chip: chip ? R(chip) : null };
}, widget);

function overlaps(a, b) { return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1; }

/* ---------- the checks ---------- */

async function check1(pi) {
  const page = await open({ pi: pi });
  const before = await page.evaluate(() => document.querySelectorAll('*').length);
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo');
  // Mid-glide: still moving in.
  const f1 = await figOn(page, 'todo', 'idle');
  await sleep(300);
  const list = await figsNow(page);
  assert(list.length === 1 && list[0].imgs.length === 2 && list[0].imgs.every((i) => i.ok), 'the character: ' + JSON.stringify(list));
  const rc = await rects(page, 'todo');
  const r = { left: list[0].rect[0], top: list[0].rect[1], right: list[0].rect[0] + list[0].rect[2], bottom: list[0].rect[1] + list[0].rect[3] };
  // At the tile's bottom right, inside it, and clear of the chip.
  assert(r.right <= rc.tile.right + 1 && r.left >= rc.tile.left - 1 && r.bottom <= rc.tile.bottom + 1 && r.right > rc.tile.right - 30, 'not at the bottom right: ' + JSON.stringify([r, rc]));
  assert(!overlaps(r, rc.chip), 'she covers the chip: ' + JSON.stringify([r, rc]));
  // About 112 px tall at 1080p.
  assert(list[0].rect[3] >= 108 && list[0].rect[3] <= 140, 'height: ' + list[0].rect[3]);
  // The todo tile is on the left half: she came from its right.
  assert(f1.fromLeft === false, 'came from the left on a left tile');
  const pixel = await page.evaluate(() => getComputedStyle(document.querySelector('.ag-fig img')).imageRendering);
  assert(pixel === 'pixelated', 'image-rendering: ' + pixel);
  // Her layer is over the tiles and under the panel.
  const z = await page.evaluate(() => getComputedStyle(document.querySelector('.ag-layer')).zIndex + ' ' + getComputedStyle(document.querySelector('.ag-layer')).pointerEvents);
  assert(z === '9 none', 'layer: ' + z);
  await say(pi, 'hub:working todo done');
  await until(() => page.evaluate(() => !!document.querySelector('.ag-pulse')), 1500, 'no pulse');
  const out = await figOn(page, 'todo', 'out');
  assert(out, 'not leaving');
  await noneLeft(page, 2500, 'she stayed');
  await sleep(300);
  const after = await page.evaluate(() => document.querySelectorAll('*').length);
  assert(after <= before + 2, 'elements left: ' + before + ' -> ' + after);   // (the accent edge is not shown for a working chip)
  assert((await figLog(page)).length === 1, 'added: ' + JSON.stringify(await figLog(page)));
  const s = await state(page);
  assert(s.seen === 1, 'seen: ' + s.seen);
  noErrors(page);
}

async function check2(pi) {
  const page = await open({ pi: pi });
  await postTodo(pi, 'Agents arrival ' + Date.now());
  await until(() => page.evaluate(() => /Incoming to-do/.test((document.querySelector('.cell[data-widget="todo"] .fx-chip') || {}).textContent || '')), 4000, 'no arrival chip');
  await figOn(page, 'todo');
  // She leaves as the chip fades (about 2.4 s), and is gone soon after it.
  await until(() => page.evaluate(() => !!document.querySelector('.fx-chip.is-out')), 4000, 'the chip did not fade');
  await figOn(page, 'todo', 'out');
  await noneLeft(page, 2000, 'she stayed after the chip');
  // The calendar's arrival chip.
  await calendarChange(pi);
  await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="calendar"] .fx-chip')), 6000, 'no calendar chip');
  await figOn(page, 'calendar');
  await noneLeft(page, 5000, 'she stayed on the calendar');
  noErrors(page);
}

async function check3(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo 300');
  await figOn(page, 'todo', 'idle');
  await postTodo(pi, 'Handed over ' + Date.now());
  await until(() => page.evaluate(() => /Incoming to-do/.test((document.querySelector('.cell[data-widget="todo"] .fx-chip') || {}).textContent || '')), 4000, 'no hand-off');
  // The chip became the arrival chip: she pulses and goes, while it stays.
  await figOn(page, 'todo', 'out');
  await noneLeft(page, 1500, 'she stayed after the hand-off');
  assert(await page.evaluate(() => !!document.querySelector('.fx-chip.is-in')), 'the arrival chip went with her');
  assert((await figLog(page)).length === 1, 'she came again: ' + JSON.stringify(await figLog(page)));
  noErrors(page);
}

async function check4(pi) {
  const cases = [
    { name: 'fade', o: { query: 'motion=fade' }, chips: false, row: 'off (fade mode)' },
    { name: 'slow screen, chips still on (expand at 71 fps)', o: { slow: { mode: 'expand', fps: 71 }, query: 'x=1' }, chips: true, row: 'chips only (slow screen)' },
    { name: 'measured slow (24 fps)', o: { slow: { mode: 'push', fps: 24 }, query: 'x=1' }, chips: false, row: 'off (slow screen)' },
    { name: 'agents: false', o: { config: 'HUB_CONFIG.agents = false;' }, chips: true, row: 'off (config)', nothing: true },
    { name: 'on: false', o: { config: 'HUB_CONFIG.agents = { on: false, who: "lift" };' }, chips: true, row: 'off (config)', nothing: true },
    { name: '?agent=off', o: { query: 'motion=push&agent=off' }, chips: true, row: 'off (?agent=off)', nothing: true },
    { name: 'unknown who', o: { config: 'HUB_CONFIG.agents = { on: true, who: "hoid" };' }, chips: true, row: 'off (no character called hoid)', nothing: true },
    { name: '?agent=nobody', o: { query: 'motion=push&agent=nobody' }, chips: true, row: 'off (no character called nobody)', nothing: true }
  ];
  for (const c of cases) {
    const page = await open(Object.assign({ pi: pi }, c.o));
    await say(pi, 'hub:working todo');
    await sleep(1500);
    const chips = await page.evaluate(() => document.querySelectorAll('.fx-chip').length);
    assert(!!chips === c.chips, c.name + ': chips ' + chips);
    assert(!(await figLog(page)).length && !(await page.evaluate(() => document.querySelector('.ag-layer'))), c.name + ': a character');
    if (c.row) {
      const row = await page.evaluate(() => window.HUB_AGENTS.status().drawing);
      assert(row === c.row, c.name + ': row ' + row);
    }
    if (c.nothing) {
      await sleep(6500);    // past the time the pictures would load
      assert(!Object.keys(page.picHits).length, c.name + ': pictures loaded: ' + JSON.stringify(page.picHits));
    }
    await say(pi, 'hub:working todo done');
    noErrors(page);
    await page.context().close();
  }
}

async function check5(pi) {
  // Three arrival chips at once (the snapshot tiles): at most two characters, one per tile.
  await setLayout(pi, AWWS_LAYOUT);
  try {
    const page = await open({ pi: pi });
    await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="awws-todo"]')), 6000, 'the layout did not arrive');
    await ready(page);
    await page.evaluate(() => {
      window.__max = 0; window.__perTile = 0;
      setInterval(() => {
        const st = window.HUB_AGENTS.test.state();
        window.__max = Math.max(window.__max, document.querySelectorAll('.ag-fig').length);
        const seen = {};
        st.figs.forEach((f) => { seen[f.widget] = (seen[f.widget] || 0) + 1; window.__perTile = Math.max(window.__perTile, seen[f.widget]); });
      }, 30);
    });
    await postSnapshot(pi, snapshotNow({ reach: Math.random() < 0.5 ? 'subscribers' : 'traffic' }));
    await until(() => page.evaluate(() => document.querySelectorAll('.fx-chip').length >= 3), 5000, 'no three chips');
    await sleep(600);
    // A to-do too while they are out: still no more than two.
    await postTodo(pi, 'Fourth ' + Date.now());
    await sleep(900);
    const m = await page.evaluate(() => ({ max: window.__max, per: window.__perTile }));
    assert(m.max === 2 && m.per === 1, 'on screen: ' + JSON.stringify(m));
    await noneLeft(page, 6000, 'they stayed');
    noErrors(page);
  } finally {
    await setLayout(pi, null);
  }
}

async function check6(pi) {
  const page = await open({ pi: pi });
  await page.evaluate(() => {
    window.__bad = [];
    const ok = (p) => ['transform', 'opacity', 'offset', 'easing', 'composite', 'computedOffset'].indexOf(p) >= 0;
    setInterval(() => {
      const layer = document.querySelector('.ag-layer');
      if (!layer) return;
      layer.getAnimations({ subtree: true }).forEach((a) => {
        if (a.transitionProperty) { if (!ok(a.transitionProperty)) window.__bad.push('transition ' + a.transitionProperty); return; }
        (a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : []).forEach((k) => {
          Object.keys(k).forEach((p) => { if (!ok(p)) window.__bad.push(a.animationName + ' ' + p); });
        });
      });
    }, 20);
  });
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo', 'idle');
  const idleAnims = await page.evaluate(() => document.querySelector('.ag-layer').getAnimations({ subtree: true }).map((a) => a.animationName || a.transitionProperty).sort().join());
  assert(idleAnims === 'ag-bob,ag-sway', 'idle animations: ' + idleAnims);
  await say(pi, 'hub:working todo done');
  await noneLeft(page, 2500, 'she stayed');
  await postTodo(pi, 'Animated ' + Date.now());
  await figOn(page, 'todo');
  await noneLeft(page, 5000, 'she stayed (arrival)');
  const bad = await page.evaluate(() => window.__bad);
  assert(!bad.length, 'other properties animate: ' + JSON.stringify(bad.slice(0, 5)));
  noErrors(page);
}

async function check7(pi) {
  // Every try fails: no swoop, no picture element, the row says so.
  let page = await open({ pi: pi, failPics: Infinity });
  await say(pi, 'hub:working todo');
  await until(() => page.evaluate(() => window.HUB_AGENTS.test.state().pictures === 'failed'), 8000, 'the pictures did not fail');
  await sleep(500);
  assert(!(await figLog(page)).length && !(await page.evaluate(() => document.querySelectorAll('.ag-layer, .ag-fig, img[src*="agents/"]').length)), 'a character or picture showed');
  const hits = page.picHits;
  assert(hits['lift.webp'] === 3, 'tries: ' + JSON.stringify(hits));
  assert(await page.evaluate(() => !!document.querySelector('.fx-chip')), 'the chip did not stay');
  const row = await page.evaluate(() => window.HUB_AGENTS.status().drawing);
  assert(/^off \(pictures did not load/.test(row), 'row: ' + row);
  await say(pi, 'hub:working todo done');
  noErrors(page);
  await page.context().close();
  // The first try fails: the second comes and she swoops.
  page = await open({ pi: pi, failPics: 1 });
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo', 'idle');
  const list = await figsNow(page);
  assert(list.length === 1 && list[0].imgs.every((i) => i.ok), 'pictures: ' + JSON.stringify(list));
  await say(pi, 'hub:working todo done');
  noErrors(page);
}

async function check8(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo 120');
  await figOn(page, 'todo', 'idle');
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  // At once: no glide out behind the panel.
  await noneLeft(page, 300, 'she stayed when the panel opened');
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await idle(page);
  // The working chip comes back, and so does she.
  await figOn(page, 'todo', 'idle');
  assert((await state(page)).seen === 2, 'seen: ' + (await state(page)).seen);
  // A resize ends her at once too.
  await page.setViewportSize({ width: 1600, height: 900 });
  await noneLeft(page, 300, 'she stayed on a resize');
  await say(pi, 'hub:working todo done');
  noErrors(page);
}

// To-do on the right edge (x 9, w 3).
const AWWS_LAYOUT = [
  { widget: 'awws-visits', x: 0, y: 0, w: 3, h: 2 },
  { widget: 'awws-todo', x: 0, y: 2, w: 4, h: 4 },
  { widget: 'awws-agenda', x: 3, y: 0, w: 6, h: 2 },
  { widget: 'awws', x: 4, y: 2, w: 5, h: 4 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
  { widget: 'today', x: 9, y: 2, w: 3, h: 1 },
  { widget: 'todo', x: 9, y: 3, w: 3, h: 3 }
];
// Three-column tiles in three heights: To-do 3x1, Calendar 3x2.
const NARROW = [
  { widget: 'today', x: 0, y: 0, w: 3, h: 1 },
  { widget: 'calendar', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'awws', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'nowplaying', x: 9, y: 0, w: 3, h: 2 },
  { widget: 'todo', x: 0, y: 1, w: 3, h: 1 },
  { widget: 'weather', x: 0, y: 2, w: 3, h: 2 },
  { widget: 'mirror', x: 9, y: 2, w: 3, h: 4 },
  { widget: 'ambiance', x: 3, y: 4, w: 6, h: 1 },
  { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
];

async function onLayout(pi, layout, widget, kind, wantFromLeft) {
  await setLayout(pi, layout);
  try {
    const page = await open({ pi: pi });
    if (layout) await until(() => page.evaluate((w) => !!document.querySelector('.cell[data-widget="' + w + '"]'), widget), 6000, 'the layout did not arrive');
    await ready(page);
    await say(pi, 'hub:working ' + kind);
    const f = await figOn(page, widget, 'idle');
    await sleep(200);
    const list = await figsNow(page);
    const rc = await rects(page, widget);
    const r = { left: list[0].rect[0], top: list[0].rect[1], right: list[0].rect[0] + list[0].rect[2], bottom: list[0].rect[1] + list[0].rect[3] };
    const W = await page.evaluate(() => window.innerWidth);
    assert(f.fromLeft === wantFromLeft, widget + ': fromLeft ' + f.fromLeft);
    assert(r.left >= 0 && r.right <= W && r.right <= rc.tile.right + 1 && r.left >= rc.tile.left - 1, widget + ': off the tile or screen: ' + JSON.stringify([r, rc, W]));
    assert(!overlaps(r, rc.chip), widget + ': covers the chip: ' + JSON.stringify([r, rc]));
    await say(pi, 'hub:working ' + kind + ' done');
    await noneLeft(page, 2500, 'she stayed');
    noErrors(page);
    await page.context().close();
  } finally {
    await setLayout(pi, null);
  }
}

async function check9(pi) {
  // Right edge: from the left. Built-in layout's calendar (left of middle): from the right.
  await onLayout(pi, AWWS_LAYOUT, 'todo', 'todo', true);
  await onLayout(pi, null, 'calendar', 'calendar', false);
  // Narrow tiles: To-do 3x1 (she stands beside or above the chip, inside the tile), Calendar 3x2.
  await onLayout(pi, NARROW, 'calendar', 'calendar', false);
  await onLayout(pi, AWWS_LAYOUT, 'awws-todo', 'awws', false);
}

async function check10(pi) {
  // English rows, then Spanish; none before the first chip.
  let page = await open({ pi: pi });
  await page.evaluate(() => window.HUB_TEST.about.open());
  await sleep(300);
  const early = await page.evaluate(() => window.HUB_TEST.about.rows().filter((x) => x.group === 'Characters').length);
  assert(early === 0, 'Characters rows before any chip: ' + early);
  await page.evaluate(() => window.HUB_TEST.about.close());
  await sleep(400);
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo', 'idle');
  const rows = (p) => p.evaluate(() => {
    const out = {};
    let group = '';
    document.querySelectorAll('#about .about-box > div').forEach((n) => {
      if (n.classList.contains('about-group')) group = n.textContent;
      else if (n.classList.contains('about-row')) out[group + '/' + n.querySelector('.about-label').textContent] = n.querySelector('.about-value').textContent;
    });
    return out;
  });
  const openAbout = async (p) => {
    await p.evaluate(() => window.HUB_TEST.about.open());
    await until(() => p.evaluate(() => !!document.querySelector('#about.is-shown')), 2000, 'the About panel did not open');
  };
  await openAbout(page);
  let r = await rows(page);
  assert(r['Characters/Now'] === 'Lift, on To-do' && /^1.swoop$/.test(r['Characters/Seen'] || ''), 'rows: ' + JSON.stringify(r));
  assert(r['Characters/Drawing'] === 'on', 'drawing: ' + JSON.stringify(r));
  await say(pi, 'hub:working todo done');
  noErrors(page);
  await page.context().close();
  page = await open({ pi: pi, init: 'try { localStorage.setItem("homeHub.lang", "es"); } catch (e) {}' });
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo', 'idle');
  await openAbout(page);
  r = await rows(page);
  const now = r['Personajes/Ahora'] || '';
  assert(/^Lift, en /.test(now), 'Spanish rows: ' + JSON.stringify(r));
  assert(/^1.pasada$/.test(r['Personajes/Pasadas'] || '') && r['Personajes/Dibujo'] === 'activado', 'Spanish rows: ' + JSON.stringify(r));
  // Nothing clipped: every row's text fits its box (diacritics included).
  const clip = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('#about .about-value, #about .about-label, #about .about-group'),
    (n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).map((n) => n.textContent));
  assert(!clip.length, 'clipped: ' + JSON.stringify(clip));
  await say(pi, 'hub:working todo done');
  noErrors(page);
}

/* ---------- run ---------- */

async function main() {
  PAGE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  mock = await mockSpotify.start({});
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PAGE_PORT, path: '/', timeout: 500 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  browser = await chromium.launch();
  feeds = await calendarSample.feedServer({ mode: 'sample' });
  const pi = await startPi();
  await postSnapshot(pi, snapshotNow({ reach: 'both' }));

  await check('1. A working chip: Lift glides in from the side, idles at the bottom right clear of the chip, pulses and glides out on done, nothing left', () => check1(pi));
  await check('2. Arrival chips (a new to-do, changed calendar events): she comes and leaves as the chip fades', () => check2(pi));
  await check('3. A working chip turning into the arrival chip sends her out; the chip stays', () => check3(pi));
  await check('4. Never in fade mode, on a slow screen, with agents off (config, on: false, ?agent=off) or an unknown who; off loads nothing', () => check4(pi));
  await check('5. Three arrival chips at once: at most two on screen, one per tile', () => check5(pi));
  await check('6. Only transform and opacity animate (glide, idle, pulse, out)', () => check6(pi));
  await check('7. A picture that fails three times: no swoop, no broken picture, the chip alone; one failed try is asked for again', () => check7(pi));
  await check('8. A panel and a resize end her at once; the working chip coming back brings her back', () => check8(pi));
  await check('9. Layouts: a tile at the right edge has her come from the left, others from the right, always on the tile and clear of the chip', () => check9(pi));
  await check('10. The About panel\'s Characters rows (none before the first chip), in English and Spanish, nothing clipped', () => check10(pi));
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  for (const pi of pis) await new Promise((r) => pi.h.close(() => r()));
  try { if (mock) await mock.close(); } catch (e) { /* ignore */ }
  try { if (feeds) await feeds.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
