/*
 * Characters (app/agents.js), end to end: node dev/agents-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js),
 * the hub server from pi/ and a stand-in for Spotify (dev/mock-spotify.js),
 * all on spare ports with a fresh data folder, like dev/working-test.js.
 * Signals go the real way: a say command to the hub server ("hub:working
 * todo"), a new to-do, a calendar change, a changed snapshot. Each page
 * loads her pictures at once (HUB_AGENTS.test.load) unless a check is about
 * the pictures.
 *
 * Checks: with her in use the tile gets no chip, only her and the border
 * light; a working state plays enter, travel (with the skid), work, and on
 * done the exit, leaving nothing; an arrival alone plays enter, travel,
 * work, reveal, exit in about 5 to 7 s while the border light laps; a
 * working state that turns into news plays the reveal, never a chip; the
 * chip comes back as the fallback (fade mode, a slow screen, agents off, an
 * unknown who, pictures not loaded yet or failed, the caps full); at most
 * two on screen and one per tile; only transform and opacity animate and
 * the work loop is CSS only (nothing in her changes while she works); the
 * work spot is the widget's [data-agent-spot], kept inside the tile; a
 * small tile plays the short sequence; a language change while she works
 * changes nothing; a panel ends her at once and a resize gives the working
 * chip back; a tile at the right screen edge has her come from the left;
 * three layouts; the About panel's Characters rows, in English and Spanish.
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

// Notes every character, chip, border light and burst the page adds (window.__figs, __chips, __laps,
// __bursts); open() counts every request for her pictures.
const WATCH = '(function () { window.__figs = []; window.__chips = []; window.__laps = []; window.__bursts = []; function watch() {' +
  ' new MutationObserver(function (ms) { ms.forEach(function (m) {' +
  '  Array.prototype.forEach.call(m.addedNodes, function (n) {' +
  '   if (n.nodeType === 1 && n.classList && n.classList.contains("ag-fig")) window.__figs.push({ t: Date.now() });' +
  '   if (n.nodeType === 1 && n.classList && n.classList.contains("fx-chip")) window.__chips.push({ t: Date.now(), text: n.textContent });' +
  '   if (n.nodeType === 1 && n.classList && n.classList.contains("fx-lap")) window.__laps.push({ t: Date.now() });' +
  '   if (n.nodeType === 1 && n.classList && n.classList.contains("ag-burst")) window.__bursts.push({ t: Date.now() }); }); }); })' +
  '.observe(document.documentElement, { childList: true, subtree: true });' +
  ' } if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch); })();';

// o: { pi, query, config (JS appended to config.js), init, slow ({ mode, fps }), failPics (n: abort the first n fetches
// of each picture; Infinity), failOnly (only that file fails), noLoad (do not load her pictures at once), size }
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
      if (o.failPics && picHits[m[1]] <= o.failPics && (!o.failOnly || o.failOnly === m[1])) return route.abort();
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
  if (!o.noLoad && !o.failPics) await picsReady(page);
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'the hub did not go live');
  await idle(page);
  await sleep(400);
}

// Her pictures, loaded now (they would load 6 s after start).
async function picsReady(page) {
  const st = await page.evaluate(() => window.HUB_AGENTS && window.HUB_AGENTS.test.state());
  if (!st || !st.on) return;
  await page.evaluate(() => window.HUB_AGENTS.test.load());
  await until(() => page.evaluate(() => window.HUB_AGENTS.test.state().pictures === 'ready'), 6000, 'her pictures did not load');
}

const idle = (page) => until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
function noErrors(page) { assert(!page.errors.length, 'page errors: ' + page.errors.join(' | ')); }
const state = (page) => page.evaluate(() => window.HUB_AGENTS ? window.HUB_AGENTS.test.state() : null);
const figLog = (page) => page.evaluate(() => window.__figs.slice());

// Every character on screen now: its tile, rect, the tile's and the chip's rects, its pictures.
// (The rect is her ride's: the box as drawn, raised to where she works.)
const figsNow = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.ag-fig'), (n) => {
  const r = n.querySelector('.ag-ride').getBoundingClientRect();
  const st = window.HUB_AGENTS.test.state();
  const f = st.figs.filter((x) => Math.abs(x.x - r.left) < 40 && Math.abs(x.y - r.top) < 40)[0] || null;
  const imgs = Array.prototype.map.call(n.querySelectorAll('img'), (i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') }));
  return { rect: [r.left, r.top, r.width, r.height].map(Math.round), imgs: imgs, cls: n.className, widget: f ? f.widget : '', state: f ? f.state : '' };
}));

async function figOn(page, widget, wantState, ms) {
  return until(async () => {
    const s = await state(page);
    const f = s && s.figs.filter((x) => x.widget === widget)[0];
    return f && (!wantState || f.state === wantState) ? f : false;
  }, ms || 4000, 'no character on ' + widget);
}

async function noneLeft(page, ms, text) {
  try {
    await until(() => page.evaluate(() => !document.querySelector('.ag-layer, .ag-fig, .ag-burst')), ms, text);
  } catch (e) {
    const s = await state(page).catch(() => null);
    throw new Error(text + ': ' + JSON.stringify(s && s.figs.map((f) => [f.widget, f.state, f.phases, f.mode])));
  }
}
// None on widget's tile (another tile's arrival, a new song say, may come meanwhile).
const noneOn = (page, widget, ms, text) => until(async () => { const s = await state(page); return !!s && !s.figs.some((f) => f.widget === widget); }, ms, text);
const chipsIn = (page, widget) => page.evaluate((w) => document.querySelectorAll('.cell[data-widget="' + w + '"] .fx-chip').length, widget);
// The phases she went through on widget (the last one seen there), polled while she lives.
async function watchPhases(page, widget) {
  await page.evaluate((w) => {
    window.__ph = window.__ph || {};
    window.__ph[w] = [];
    const t = setInterval(() => {
      const f = window.HUB_AGENTS.test.state().figs.filter((x) => x.widget === w)[0];
      if (f) window.__ph[w] = f.phases;
    }, 30);
    window.__phT = (window.__phT || []).concat([t]);
  }, widget);
}
const phasesOf = (page, widget) => page.evaluate((w) => (window.__ph && window.__ph[w]) || [], widget);

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
  await watchPhases(page, 'todo');
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo');
  // She works; the tile has no chip, the act is hers.
  const f1 = await figOn(page, 'todo', 'work');
  await sleep(300);
  assert(await chipsIn(page, 'todo') === 0, 'a chip beside her');
  const fx = await page.evaluate(() => window.HUB_FX.state());
  assert(fx.figures.indexOf('todo') >= 0 && fx.chips.indexOf('todo') < 0, 'motion state: ' + JSON.stringify([fx.chips, fx.figures]));
  const list = await figsNow(page);
  assert(list.length === 1 && list[0].imgs.length === 6 && list[0].imgs.every((i) => i.ok), 'the character: ' + JSON.stringify(list));
  assert(/is-pose-crouch/.test(list[0].cls) && /is-work/.test(list[0].cls), 'not crouching at work: ' + list[0].cls);
  const rc = await rects(page, 'todo');
  const r = { left: list[0].rect[0], top: list[0].rect[1], right: list[0].rect[0] + list[0].rect[2], bottom: list[0].rect[1] + list[0].rect[3] };
  // Inside the tile (her box may rise a quarter above its top, never out of its sides or bottom).
  assert(r.right <= rc.tile.right + 1 && r.left >= rc.tile.left - 1 && r.bottom <= rc.tile.bottom + 1, 'not in the tile: ' + JSON.stringify([r, rc]));
  // About 112 to 126 px tall at 1080p.
  assert(list[0].rect[3] >= 108 && list[0].rect[3] <= 140, 'height: ' + list[0].rect[3]);
  // The todo tile is on the left half: she came from its right.
  assert(f1.fromLeft === false, 'came from the left on a left tile');
  const pixel = await page.evaluate(() => getComputedStyle(document.querySelector('.ag-fig img')).imageRendering);
  assert(pixel === 'pixelated', 'image-rendering: ' + pixel);
  // Her layer is over the tiles and under the panel.
  const z = await page.evaluate(() => getComputedStyle(document.querySelector('.ag-layer')).zIndex + ' ' + getComputedStyle(document.querySelector('.ag-layer')).pointerEvents);
  assert(z === '9 none', 'layer: ' + z);
  await say(pi, 'hub:working todo done');
  await figOn(page, 'todo', 'exit');
  await noneLeft(page, 2500, 'she stayed');
  const ph = (await phasesOf(page, 'todo')).join();
  assert(ph === 'enter,travel,skid,work,exit', 'phases: ' + ph);
  await sleep(300);
  const after = await page.evaluate(() => document.querySelectorAll('*').length);
  assert(after <= before + 2, 'elements left: ' + before + ' -> ' + after);   // (the accent edge is not shown for a working state)
  assert((await figLog(page)).length === 1, 'added: ' + JSON.stringify(await figLog(page)));
  assert(!(await page.evaluate(() => window.__chips.length)), 'a chip showed: ' + JSON.stringify(await page.evaluate(() => window.__chips)));
  assert(!(await page.evaluate(() => window.__bursts.length)), 'a reveal without news');
  const s = await state(page);
  assert(s.seen === 1, 'seen: ' + s.seen);
  noErrors(page);
}

async function arrival(page, widget, signal) {
  await watchPhases(page, widget);
  const t0 = Date.now();
  await signal();
  await figOn(page, widget);
  // The border light laps the tile, with no chip.
  await until(() => page.evaluate((w) => !!document.querySelector('.cell[data-widget="' + w + '"] .tile .fx-lap'), widget), 2000, widget + ': no border light');
  assert(await chipsIn(page, widget) === 0, widget + ': a chip beside her');
  await figOn(page, widget, 'reveal');
  assert(await chipsIn(page, widget) === 0, widget + ': a chip at the reveal');
  await noneLeft(page, 6000, widget + ': she stayed');
  const ms = Date.now() - t0;
  const ph = (await phasesOf(page, widget)).join();
  assert(ph === 'enter,travel,skid,work,reveal,exit', widget + ': phases: ' + ph);
  assert(ms > 4000 && ms < 8500, widget + ': the sequence took ' + ms + ' ms');
  assert(!(await page.evaluate(() => window.__chips.length)), widget + ': a chip showed');
}

async function check2(pi) {
  const page = await open({ pi: pi });
  await arrival(page, 'todo', () => postTodo(pi, 'Agents arrival ' + Date.now()));
  assert((await page.evaluate(() => window.__bursts.length)) === 1, 'bursts: ' + (await page.evaluate(() => window.__bursts.length)));
  // The accent edge stays after her (as with a chip).
  assert(await page.evaluate(() => !!document.querySelector('.cell[data-widget="todo"] .fx-accent')), 'no accent edge');
  // The calendar's, twice: to no events (her default spot), then back to
  // the sample, where she works at its first event row (its data-agent-spot).
  await calendarChange(pi);
  await arrival(page, 'calendar', async () => { /* already sent */ });
  await calendarChange(pi);
  await page.evaluate(() => { window.__calSpot = null; const t = setInterval(() => {
    const f = window.HUB_AGENTS.test.state().figs.filter((x) => x.widget === 'calendar')[0];
    if (f) { window.__calSpot = f; clearInterval(t); } }, 30); });
  await arrival(page, 'calendar', async () => { /* already sent */ });
  const f = await page.evaluate(() => window.__calSpot);
  assert(f && f.spot.marker, 'calendar: no spot marker: ' + JSON.stringify(f));
  noErrors(page);
}

async function check3(pi) {
  const page = await open({ pi: pi });
  await watchPhases(page, 'todo');
  await say(pi, 'hub:working todo 300');
  await figOn(page, 'todo', 'work');
  await sleep(500);
  await postTodo(pi, 'Handed over ' + Date.now());
  // The news: she springs up, sparks, the border light; never a chip.
  await figOn(page, 'todo', 'reveal');
  await until(() => page.evaluate(() => window.__laps.length > 0 && window.__bursts.length === 1), 2000, 'no border light or burst');
  await noneLeft(page, 4000, 'she stayed after the reveal');
  const ph = (await phasesOf(page, 'todo')).join();
  assert(ph === 'enter,travel,skid,work,reveal,exit', 'phases: ' + ph);
  assert(!(await page.evaluate(() => window.__chips.length)), 'a chip showed: ' + JSON.stringify(await page.evaluate(() => window.__chips)));
  assert((await figLog(page)).length === 1, 'she came again: ' + JSON.stringify(await figLog(page)));
  // News while she is still on her way in: she works a moment, then the reveal.
  await watchPhases(page, 'todo');
  await say(pi, 'hub:working todo 300');
  await figOn(page, 'todo', 'enter');
  await postTodo(pi, 'Early news ' + Date.now());
  await figOn(page, 'todo', 'reveal');
  await noneLeft(page, 4000, 'she stayed (early news)');
  const ph2 = (await phasesOf(page, 'todo')).join();
  assert(ph2 === 'enter,travel,skid,work,reveal,exit', 'phases (early news): ' + ph2);
  assert(!(await page.evaluate(() => window.__chips.length)), 'a chip showed (early news)');
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
    { name: '?agent=nobody', o: { query: 'motion=push&agent=nobody' }, chips: true, row: 'off (no character called nobody)', nothing: true },
    // Before her pictures are in (they load 6 s after start), the chip: it never waits for her.
    { name: 'pictures not loaded yet', o: { noLoad: true }, chips: true, row: 'on' }
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
    if (c.name === 'pictures not loaded yet') {
      // The pictures came while the chip shows: she does not join it (no chip beside her, ever).
      await until(() => page.evaluate(() => window.HUB_AGENTS.test.state().pictures === 'ready'), 9000, 'the pictures did not load by themselves');
      await sleep(1500);
      assert(!(await figLog(page)).length && (await chipsIn(page, 'todo')) === 1, 'she joined the chip');
    }
    await say(pi, 'hub:working todo done');
    noErrors(page);
    await page.context().close();
  }
}

async function check5(pi) {
  // Three arrival chips at once (the snapshot tiles): at most two characters, one per tile; the third tile gets its chip.
  await setLayout(pi, AWWS_LAYOUT);
  try {
    const page = await open({ pi: pi });
    await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="awws-todo"]')), 6000, 'the layout did not arrive');
    await ready(page);
    await page.evaluate(() => {
      window.__max = 0; window.__perTile = 0; window.__both = 0;
      setInterval(() => {
        const st = window.HUB_AGENTS.test.state();
        window.__max = Math.max(window.__max, document.querySelectorAll('.ag-fig').length);
        const seen = {};
        st.figs.forEach((f) => {
          seen[f.widget] = (seen[f.widget] || 0) + 1;
          window.__perTile = Math.max(window.__perTile, seen[f.widget]);
          // Never a chip on a tile she is on.
          if (f.state !== 'exit' && document.querySelector('.cell[data-widget="' + f.widget + '"] .fx-chip:not(.is-out)')) window.__both += 1;
        });
      }, 30);
    });
    await postSnapshot(pi, snapshotNow({ reach: Math.random() < 0.5 ? 'subscribers' : 'traffic' }));
    await until(() => page.evaluate(() => { const s = window.HUB_FX.state(); return s.chips.length + s.figures.length >= 3; }), 5000, 'no three arrivals');
    const s1 = await page.evaluate(() => window.HUB_FX.state());
    assert(s1.figures.length === 2 && s1.chips.length >= 1, 'two with her, the rest chips: ' + JSON.stringify([s1.chips, s1.figures]));
    await sleep(600);
    // A to-do too while they are out: still no more than two (it gets a chip).
    await postTodo(pi, 'Fourth ' + Date.now());
    await sleep(900);
    const m = await page.evaluate(() => ({ max: window.__max, per: window.__perTile, both: window.__both }));
    assert(m.max === 2 && m.per === 1 && m.both === 0, 'on screen: ' + JSON.stringify(m));
    await noneLeft(page, 8000, 'they stayed');
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
  await figOn(page, 'todo', 'work');
  await sleep(1300);   // the vine has grown
  // The work loop: CSS only, nothing faster than 1.5 s a cycle, and nothing in her changes while she works.
  const loop = await page.evaluate(() => document.querySelector('.ag-layer').getAnimations({ subtree: true })
    .filter((a) => a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity)
    .map((a) => a.animationName + ':' + a.effect.getTiming().duration));
  const names = loop.map((x) => x.split(':')[0]).sort().join();
  assert(names === 'ag-bob,ag-curl,ag-flow,ag-flow,ag-flow,ag-ring,ag-ring', 'work loop: ' + names);
  assert(loop.every((x) => Number(x.split(':')[1]) >= 1500), 'a fast loop: ' + loop.join());
  const changes = await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const mo = new MutationObserver((ms) => { n += ms.length; });
    mo.observe(document.querySelector('.ag-layer'), { subtree: true, attributes: true, childList: true });
    setTimeout(() => { mo.disconnect(); resolve(n); }, 3200);
  }));
  assert(changes === 0, 'her elements changed ' + changes + ' times in one work loop');
  await say(pi, 'hub:working todo done');
  await noneLeft(page, 2500, 'she stayed');
  await postTodo(pi, 'Animated ' + Date.now());
  await figOn(page, 'todo');
  await noneLeft(page, 8000, 'she stayed (arrival)');
  const bad = await page.evaluate(() => window.__bad);
  assert(!bad.length, 'other properties animate: ' + JSON.stringify(bad.slice(0, 5)));
  // No timer of hers runs faster than needed: agents.js has no setInterval or requestAnimationFrame.
  const src = fs.readFileSync(path.join(ROOT, 'app', 'agents.js'), 'utf8');
  assert(!/setInterval|requestAnimationFrame/.test(src), 'agents.js polls');
  noErrors(page);
}

async function check7(pi) {
  // One pose picture fails every try: no character at all (never half of one), the chip, the row says so.
  let page = await open({ pi: pi, failPics: Infinity, failOnly: 'crouch.webp' });
  await page.evaluate(() => window.HUB_AGENTS.test.load());
  await until(() => page.evaluate(() => window.HUB_AGENTS.test.state().pictures === 'failed'), 8000, 'the pictures did not fail');
  await say(pi, 'hub:working todo');
  await sleep(1200);
  assert(!(await figLog(page)).length && !(await page.evaluate(() => document.querySelectorAll('.ag-layer, .ag-fig, img[src*="agents/"]').length)), 'a character or picture showed');
  const hits = page.picHits;
  assert(hits['crouch.webp'] === 3, 'tries: ' + JSON.stringify(hits));
  assert(await page.evaluate(() => !!document.querySelector('.fx-chip')), 'no chip');
  const row = await page.evaluate(() => window.HUB_AGENTS.status().drawing);
  assert(/^off \(pictures did not load/.test(row), 'row: ' + row);
  await say(pi, 'hub:working todo done');
  noErrors(page);
  await page.context().close();
  // The first try of each fails: the second comes and she works, with no chip.
  page = await open({ pi: pi, failPics: 1 });
  await picsReadyAfterRetry(page);
  await say(pi, 'hub:working todo');
  await figOn(page, 'todo', 'work');
  const list = await figsNow(page);
  assert(list.length === 1 && list[0].imgs.length === 6 && list[0].imgs.every((i) => i.ok), 'pictures: ' + JSON.stringify(list));
  assert(await chipsIn(page, 'todo') === 0, 'a chip beside her');
  await say(pi, 'hub:working todo done');
  noErrors(page);
}

async function picsReadyAfterRetry(page) {
  await page.evaluate(() => window.HUB_AGENTS.test.load());
  await until(() => page.evaluate(() => window.HUB_AGENTS.test.state().pictures === 'ready'), 8000, 'the pictures did not load on the second try');
}

async function check8(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo 120');
  await figOn(page, 'todo', 'work');
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  // At once: no glide out behind the panel.
  await noneLeft(page, 300, 'she stayed when the panel opened');
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await idle(page);
  // The working state comes back, and so does she (no chip).
  await figOn(page, 'todo', 'work');
  assert((await state(page)).seen === 2, 'seen: ' + (await state(page)).seen);
  assert(await chipsIn(page, 'todo') === 0, 'a chip beside her');
  // A resize ends her at once; the working state then shows its chip.
  await page.setViewportSize({ width: 1600, height: 900 });
  await noneLeft(page, 300, 'she stayed on a resize');
  await until(() => page.evaluate(() => /Working on to-dos/.test((document.querySelector('.cell[data-widget="todo"] .fx-chip') || {}).textContent || '')), 2500, 'no chip after the resize');
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

// A 2x1 to-do tile, far too small for the whole sequence.
const TINY = NARROW.map((e) => e.widget === 'todo' ? { widget: 'todo', x: 0, y: 1, w: 2, h: 1 } : e);

async function onLayout(pi, layout, widget, kind, wantFromLeft, wantSmall) {
  await setLayout(pi, layout);
  try {
    const page = await open({ pi: pi });
    if (layout) await until(() => page.evaluate((w) => !!document.querySelector('.cell[data-widget="' + w + '"]'), widget), 6000, 'the layout did not arrive');
    await ready(page);
    await picsReady(page);
    await watchPhases(page, widget);
    await say(pi, 'hub:working ' + kind);
    const f = await figOn(page, widget, 'work');
    await sleep(200);
    const list = await figsNow(page);
    const rc = await rects(page, widget);
    const r = { left: list[0].rect[0], top: list[0].rect[1], right: list[0].rect[0] + list[0].rect[2], bottom: list[0].rect[1] + list[0].rect[3] };
    const W = await page.evaluate(() => window.innerWidth);
    assert(f.fromLeft === wantFromLeft, widget + ': fromLeft ' + f.fromLeft);
    assert(f.small === wantSmall, widget + ': small ' + f.small + ' ' + JSON.stringify(f.tile));
    assert(r.left >= 0 && r.right <= W && r.right <= rc.tile.right + 1 && r.left >= rc.tile.left - 1 && r.bottom <= rc.tile.bottom + 1, widget + ': off the tile or screen: ' + JSON.stringify([r, rc, W]));
    assert(!rc.chip, widget + ': a chip beside her');
    // Facing her way: mirrored when she came from the right.
    assert(/is-mirrored/.test(await page.evaluate(() => document.querySelector('.ag-flip').className)) === !wantFromLeft, widget + ': facing the wrong way');
    await say(pi, 'hub:working ' + kind + ' done');
    await noneLeft(page, 2500, 'she stayed');
    const ph = (await phasesOf(page, widget)).join();
    assert(ph === (wantSmall ? 'enter,work,exit' : 'enter,travel,skid,work,exit'), widget + ': phases ' + ph);
    noErrors(page);
    await page.context().close();
  } finally {
    await setLayout(pi, null);
  }
}

async function check9(pi) {
  // Right edge: from the left. Built-in layout's calendar (left of middle): from the right.
  await onLayout(pi, AWWS_LAYOUT, 'todo', 'todo', true, false);
  await onLayout(pi, null, 'calendar', 'calendar', false, false);
  // Narrow tiles: To-do 3x1, Calendar 3x2 (room for the whole sequence);
  // To-do 2x1 (too small: enter, work, exit).
  await onLayout(pi, NARROW, 'todo', 'todo', false, false);
  await onLayout(pi, NARROW, 'calendar', 'calendar', false, false);
  await onLayout(pi, TINY, 'todo', 'todo', false, true);
  await onLayout(pi, AWWS_LAYOUT, 'awws-todo', 'awws', false, false);
}

async function check11(pi) {
  // A marker far outside the tile: used, but the spot (and her hand) stays inside the tile.
  const page = await open({ pi: pi });
  await page.evaluate(() => {
    const tile = document.querySelector('.cell[data-widget="todo"] .tile');
    tile.querySelectorAll('[data-agent-spot]').forEach((n) => n.removeAttribute('data-agent-spot'));
    const m = document.createElement('div');
    m.setAttribute('data-agent-spot', '');
    m.style.cssText = 'position:absolute;left:3000px;top:2000px;width:20px;height:20px;';
    tile.appendChild(m);
  });
  await say(pi, 'hub:working todo');
  const f = await figOn(page, 'todo', 'work');
  assert(f.spot.marker === true, 'the marker was not used');
  const t = f.tile;
  assert(f.spot.x >= t.left && f.spot.x <= t.right && f.spot.y >= t.top && f.spot.y <= t.bottom, 'spot outside the tile: ' + JSON.stringify(f));
  assert(f.at.x >= t.left && f.at.x <= t.right && f.at.y >= t.top && f.at.y <= t.bottom, 'her hand outside the tile: ' + JSON.stringify(f));
  await say(pi, 'hub:working todo done');
  await noneOn(page, 'todo', 2500, 'she stayed (far marker)');
  // A real to-do list: the widget's own marker (the end of the list) is used, her hand on it.
  await page.evaluate(() => { const m = document.querySelector('.cell[data-widget="todo"] .tile > div[style*="3000px"]'); if (m) m.remove(); });
  await postTodo(pi, 'Spot one ' + Date.now());
  // (Wait for its arrival to come and go, so it cannot land while she works below.)
  await figOn(page, 'todo', null, 12000);
  await noneOn(page, 'todo', 9000, 'she stayed (first to-do)');
  await say(pi, 'hub:working todo');
  const g = await figOn(page, 'todo', 'work');
  const row = await page.evaluate(() => { const n = document.querySelector('.cell[data-widget="todo"] [data-agent-spot]'); const r = n && n.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cls: n.className, text: n.textContent } : null; });
  // The marker is the row where the new to-do showed (new ones go to the top of their level).
  assert(row && /todo-tile-row/.test(row.cls) && /Spot one/.test(row.text) && g.spot.marker, 'the to-do marker: ' + JSON.stringify([row, g.spot]));
  assert(Math.abs(g.at.x - g.spot.x) < 40 && Math.abs(g.at.y - g.spot.y) < 40, 'her hand is not at the spot: ' + JSON.stringify([g.at, g.spot]));
  // She crouches on the row's top edge (her feet on it), not over its words.
  assert(Math.abs(g.spot.y - row.top) < 2 && g.at.y <= row.top + 6, 'she covers the row: ' + JSON.stringify([g.at, row]));
  // A language change while she works: still no chip, she carries on.
  await page.evaluate(() => window.HUB_I18N.setLang('es'));
  await sleep(1200);
  assert(await chipsIn(page, 'todo') === 0, 'a chip after the language change');
  assert((await state(page)).figs.filter((x) => x.widget === 'todo')[0].state === 'work', 'she stopped working');
  await say(pi, 'hub:working todo done');
  await noneOn(page, 'todo', 2500, 'she stayed (after the language change)');
  await page.evaluate(() => window.HUB_I18N.setLang('en'));
  noErrors(page);
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
  await figOn(page, 'todo', 'work');
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
  await figOn(page, 'todo', 'work');
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

  await check('1. A working state: no chip, she enters, travels, skids and works in the tile; on done she exits, nothing left', () => check1(pi));
  await check('2. An arrival alone (a new to-do, changed calendar events): no chip, the border light laps, enter, travel, work, reveal, exit in 4 to 8.5 s; the calendar\'s spot marker', () => check2(pi));
  await check('3. A working state turning into news: the reveal (burst, border light), never a chip; news while she is still coming in too', () => check3(pi));
  await check('4. The chip as the fallback: fade mode, a slow screen, agents off (config, on: false, ?agent=off), an unknown who, pictures not loaded yet; off loads nothing', () => check4(pi));
  await check('5. Three arrivals at once: at most two characters, one per tile, the third tile gets its chip; never a chip beside her', () => check5(pi));
  await check('6. Only transform and opacity animate; the work loop is CSS only (nothing changes in 3 s, no loop under 1.5 s)', () => check6(pi));
  await check('7. One pose picture failing three times: no character, no picture, the chip; one failed try is asked for again', () => check7(pi));
  await check('8. A panel ends her at once and she comes back with the working state; a resize ends her and gives the chip back', () => check8(pi));
  await check('9. Layouts: a tile at the right edge has her come from the left, others from the right, facing her way, always on the tile; a 2x1 tile plays the short sequence', () => check9(pi));
  await check('10. The About panel\'s Characters rows (none before the first chip), in English and Spanish, nothing clipped', () => check10(pi));
  await check('11. The work spot: a [data-agent-spot] marker is used and kept inside the tile; the to-do list\'s own marker; a language change while she works', () => check11(pi));
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
