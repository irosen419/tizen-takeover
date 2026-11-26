/*
 * Working chips (app/motion.js, app/hub.js), end to end: node dev/working-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js),
 * the hub server from pi/ and a stand-in for Spotify (dev/mock-spotify.js),
 * all on spare ports with a fresh data folder, like dev/motion-test.js. Every
 * signal is sent the real way: a say command to the hub server
 * (POST /api/command, { type: 'say', data: { text: 'hub:working todo' } }),
 * which the server passes to the TV unchanged.
 *
 * Checks: a "hub:working todo" say shows no message and one quiet working
 * chip in the To-do tile, whose only running animation is the breathing
 * icon and which has no edge light; a new to-do then turns that same chip
 * into "Incoming to-do" (the same element, the edge sweeps), which goes by
 * itself and leaves nothing; "hub:working todo 10" ends by itself; "done"
 * ends it quietly; unchanged data ends it about 1.5 s later; a panel takes
 * it away and closing it brings it back; off with the activity switch, in
 * fade mode and on a slow TV (and still no message); malformed hub: texts
 * show nothing at all while an ordinary say still does; an unknown kind
 * shows nothing; A World Worth Saving: one chip, on the first declaring tile
 * in layout order, and the calendar's on the calendar tile; Spanish (from
 * app/i18n.js) on one line in 3-column
 * tiles at 22px+; a repeated start keeps the element and extends the time;
 * a layout switch (in place, and one that reloads the page) puts the chip on
 * the new layout's tile; on the focused tile the whole focus highlight is
 * off while the light laps the border (the ring hidden, or without the ring
 * the tile's whole border in the plain line colour, same size) and comes
 * back when the lap ends, the focus moves or a panel opens, never on an
 * unfocused tile, and nothing is left behind.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * WORKING_GREP=<text> runs only the checks whose name contains it.
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
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host')];
const BUILD = /var BUILD = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'hub.js'), 'utf8'))[1];

const WORK_ES = { todo: 'Preparando tareas', calendar: 'Revisando el calendario', awws: 'Reuniendo datos' };
const WORK_EN = { todo: 'Working on to-dos', calendar: 'Checking calendar', awws: 'Gathering data' };

// Notes every chip the page adds (window.__chips) and every message the toast shows (window.__toasts).
const WATCH = '(function () { window.__chips = []; window.__toasts = []; function watch() {' +
  ' new MutationObserver(function (ms) { ms.forEach(function (m) {' +
  '  Array.prototype.forEach.call(m.addedNodes, function (n) {' +
  '   if (n.nodeType === 1 && /(^| )fx-chip( |$)/.test(n.className)) { var c = n.closest(".cell");' +
  '    window.__chips.push({ w: c && c.getAttribute("data-widget"), text: n.textContent, cls: n.className, t: Date.now() }); } });' +
  '  var t = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentNode);' +
  '  var toast = t && t.closest ? t.closest("#toast") : null;' +
  '  if (toast && toast.textContent && window.__toasts[window.__toasts.length - 1] !== toast.textContent) window.__toasts.push(toast.textContent);' +
  ' }); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });' +
  ' } if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch); })();';

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
  if (process.env.WORKING_GREP && name.indexOf(process.env.WORKING_GREP) < 0) return;
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

/* ---------- servers (as in dev/motion-test.js) ---------- */

async function startPi() {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-working-test-'));
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

// The real way: a say command to the hub server, which every screen gets.
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

/* ---------- pages ---------- */

// o: { pi, query, config (JS appended to config.js), init (JS before the page), slow ({ mode, fps }) }
async function open(o) {
  o = o || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (BLOCKED.indexOf(u.hostname) >= 0) return route.abort();
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
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) page.errors.push(m.text()); });
  // ?agent=off: these checks are about the chips themselves, which are now
  // the fallback when the character (app/agents.js) cannot come; with her
  // on she replaces the chip once her pictures load (dev/agents-test.js).
  await page.goto(PAGE + '/hub.html?clay=off&agent=off&live=' + encodeURIComponent(o.pi.url) + '&' + (o.query || 'motion=push'));
  await ready(page);
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'the hub did not go live');
  await idle(page);
  await sleep(400);
}

const fx = (page) => page.evaluate(() => window.HUB_TEST.fx());
const idle = (page) => until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
const toasts = (page) => page.evaluate(() => window.__toasts.slice());
const chipLog = (page) => page.evaluate(() => window.__chips.slice());
function noErrors(page) { assert(!page.errors.length, 'page errors: ' + page.errors.join(' | ')); }

// Every chip on the page now: where, what, and how.
const chipsNow = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.fx-chip'), (c) => {
  const cell = c.closest('.cell');
  return { w: cell && cell.getAttribute('data-widget'), text: c.textContent, working: c.classList.contains('fx-chip-working'),
    out: c.classList.contains('is-out'), edge: !!(cell && cell.querySelector('.fx-edge')) };
}));

const workingOf = async (page, kind) => ((await fx(page)).working || []).filter((w) => w.kind === kind)[0] || null;

async function workingChip(page, widget, text) {
  return until(async () => {
    const list = await chipsNow(page);
    const c = list.filter((x) => x.w === widget && x.working && !x.out)[0];
    return c && (!text || c.text === text) ? c : false;
  }, 3000, 'no working chip in ' + widget);
}

const noneLeft = (page, ms, text) => until(() => page.evaluate(() => !document.querySelector('.fx-chip, .fx-edge')), ms, text);

/* ---------- the checks ---------- */

async function check1(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo');
  const c = await workingChip(page, 'todo', WORK_EN.todo);
  await sleep(500);   // past the 220 ms entrance
  const info = await page.evaluate(() => {
    const chip = document.querySelector('.cell[data-widget="todo"] .fx-chip');
    const anims = chip.getAnimations({ subtree: true }).filter((a) => a.playState === 'running')
      .map((a) => a.animationName || (a.transitionProperty ? 'transition:' + a.transitionProperty : 'other'));
    const ico = getComputedStyle(chip.querySelector('.fx-act-ico'));
    return { anims: anims, n: document.querySelectorAll('.fx-chip').length, edges: document.querySelectorAll('.fx-edge').length,
      ico: { name: ico.animationName, ms: ico.animationDuration, iter: ico.animationIterationCount } };
  });
  assert(info.n === 1 && info.edges === 0, 'chips or edges: ' + JSON.stringify(info));
  assert(info.anims.length === 1 && info.anims[0] === 'fx-act-breathe', 'running animations: ' + JSON.stringify(info.anims));
  assert(info.ico.iter === 'infinite' && /1\.6s|1600ms/.test(info.ico.ms), 'the breathing: ' + JSON.stringify(info.ico));
  const w = await workingOf(page, 'todo');
  assert(w && w.shown && w.left > 110000 && w.left <= 120000, 'state: ' + JSON.stringify(w));
  assert(!(await toasts(page)).length, 'a message showed: ' + JSON.stringify(await toasts(page)));
  assert(c.text === 'Working on to-dos', 'label: ' + c.text);
  noErrors(page);
}

async function check2(pi) {
  const page = await open({ pi: pi });
  const kidsBefore = await page.evaluate(() => document.querySelector('.cell[data-widget="todo"] .tile').children.length);
  await say(pi, 'hub:working todo 300');
  await workingChip(page, 'todo');
  await page.evaluate(() => { window.__w = document.querySelector('.cell[data-widget="todo"] .fx-chip'); window.__log = [];
    new MutationObserver(() => { window.__log.push(window.__w.className); }).observe(window.__w, { attributes: true }); });
  await postTodo(pi, 'Handed over ' + Date.now());
  await until(() => page.evaluate(() => /Incoming to-do/.test((document.querySelector('.cell[data-widget="todo"] .fx-chip') || {}).textContent || '')),
    4000, 'the chip did not become "Incoming to-do"');
  const mid = await page.evaluate(() => {
    const tile = document.querySelector('.cell[data-widget="todo"] .tile');
    const c = tile.querySelector('.fx-chip');
    const e = tile.querySelector('.fx-edge');
    return { same: c === window.__w, cls: c.className, n: document.querySelectorAll('.fx-chip').length, edge: !!e,
      sweep: e ? Array.prototype.map.call(e.querySelectorAll('i'), (n) => getComputedStyle(n).animationName).join(', ').split(', ').filter((v, i, a) => a.indexOf(v) === i).sort().join() : '', log: window.__log, ico: getComputedStyle(c.querySelector('.fx-act-ico')).animationName,
      pen: c.querySelector('.fx-act-pen') ? getComputedStyle(c.querySelector('.fx-act-pen')).animationName : '' };
  });
  assert(mid.same, 'not the same element');
  assert(!/fx-chip-working/.test(mid.cls) && /is-in/.test(mid.cls) && !/is-out/.test(mid.cls), 'class: ' + mid.cls);
  assert(mid.log.every((c) => !/is-out/.test(c)), 'it faded on the way: ' + JSON.stringify(mid.log));
  // The light laps the whole border: the four sides and the four corners.
  assert(mid.n === 1 && mid.edge && mid.sweep === 'fx-lap-bl-in,fx-lap-bl-out,fx-lap-br-in,fx-lap-br-out,fx-lap-off,fx-lap-tl-in,fx-lap-tl-out,fx-lap-tr-in,fx-lap-tr-out,fx-lap-x,fx-lap-y', 'edge: ' + JSON.stringify(mid));
  assert(mid.ico === 'none' && mid.pen === 'fx-act-pen', 'the icon loops do not run: ' + JSON.stringify(mid));
  assert(!(await workingOf(page, 'todo')), 'the working state stayed');
  await sleep(1500);
  assert(await page.evaluate(() => !!document.querySelector('.fx-chip.is-in')), 'the arrival chip went too soon');
  await noneLeft(page, 2500, 'the chip stayed');
  // The accent edge (motionFx.edge) stays about a minute after the arrival chip, by design: not counted, but there.
  const after = await page.evaluate(() => {
    const tile = document.querySelector('.cell[data-widget="todo"] .tile');
    return { kids: Array.prototype.filter.call(tile.children, (n) => !n.classList.contains('fx-accent')).length, accent: !!tile.querySelector(':scope > .fx-accent') };
  });
  assert(after.kids === kidsBefore, 'something left in the tile: ' + kidsBefore + ' -> ' + after.kids);
  assert(after.accent, 'no accent edge after the arrival chip');
  await sleep(1300);   // past a reconcile tick: no working chip comes back
  assert(!(await chipsNow(page)).length && !(await fx(page)).working.length, 'something came back: ' + JSON.stringify(await fx(page)));
  const log = await chipLog(page);
  assert(log.length === 1, 'chips added: ' + JSON.stringify(log));
  noErrors(page);
}

async function check3(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo 10');
  await workingChip(page, 'todo');
  const w = await workingOf(page, 'todo');
  assert(w && w.left > 8500 && w.left <= 10000, 'time left: ' + JSON.stringify(w));
  await page.evaluate(() => { window.__out = false; const c = document.querySelector('.fx-chip');
    new MutationObserver(() => { if (c.classList.contains('is-out')) window.__out = true; }).observe(c, { attributes: true }); });
  await sleep(8000);
  assert((await chipsNow(page)).length === 1, 'it went too soon');
  await until(async () => !(await chipsNow(page)).length, 4000, 'it did not end by itself');
  assert(await page.evaluate(() => window.__out), 'it did not fade');
  assert(!(await fx(page)).working.length, 'the state stayed');
  assert(!(await toasts(page)).length, 'a message: ' + JSON.stringify(await toasts(page)));
  noErrors(page);
}

async function check4(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo');
  await workingChip(page, 'todo');
  await say(pi, 'hub:working todo done');
  await noneLeft(page, 1500, 'done did not end it');
  assert(!(await fx(page)).working.length, 'the state stayed');
  const log = await chipLog(page);
  assert(log.length === 1 && log.every((c) => /fx-chip-working/.test(c.cls)), 'chips: ' + JSON.stringify(log));
  assert(!(await toasts(page)).length, 'a message: ' + JSON.stringify(await toasts(page)));
  noErrors(page);
}

async function check5(pi) {
  // A snapshot the TV already has: sent again unchanged (a new sentAt), the
  // hub server pushes it, nothing is news.
  const snap = snapshotNow({ reach: 'both' });
  await postSnapshot(pi, snap);
  const page = await open({ pi: pi });
  await say(pi, 'hub:working awws');
  await workingChip(page, 'awws', WORK_EN.awws);
  const rev = await page.evaluate(() => window.HUB_LIVE.rev('awws'));
  const again = JSON.parse(JSON.stringify(snap));
  again.sentAt = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  await postSnapshot(pi, again);
  await until(() => page.evaluate((r) => window.HUB_LIVE.rev('awws') > r, rev), 4000, 'the snapshot did not arrive again');
  const t0 = Date.now();
  await sleep(900);
  assert((await chipsNow(page)).some((c) => c.w === 'awws' && c.working && !c.out), 'it ended too soon');
  await noneLeft(page, 2500, 'unchanged data did not end it');
  const took = Date.now() - t0;
  assert(took >= 1000 && took < 2600, 'ended after ' + took + ' ms');
  assert(!(await fx(page)).working.length, 'the state stayed');
  assert((await chipLog(page)).every((c) => /fx-chip-working/.test(c.cls)), 'an arrival chip: ' + JSON.stringify(await chipLog(page)));
  // A to-do that only changed (renamed): pushed, not news, so the same.
  const id = await postTodo(pi, 'To rename ' + Date.now());
  await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
  await noneLeft(page, 4000, 'the chip of the new to-do stayed');
  await say(pi, 'hub:working todo');
  await workingChip(page, 'todo');
  await control(pi, 'POST', '/api/todo/ops', { ops: [{ op: 'set', id: id, fields: { title: 'Renamed ' + Date.now() } }] });
  await noneLeft(page, 3500, 'a renamed to-do did not end it');
  assert(!(await fx(page)).working.length, 'the to-do state stayed');
  noErrors(page);
}

async function check6(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo 120');
  await workingChip(page, 'todo');
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  await until(async () => !(await chipsNow(page)).length, 1500, 'the chip stayed behind the panel');
  await idle(page);
  await sleep(1500);
  assert(!(await chipsNow(page)).length, 'a chip came behind the panel');
  const w = await workingOf(page, 'todo');
  assert(w && !w.shown && w.left > 100000, 'the state: ' + JSON.stringify(w));
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await idle(page);
  await workingChip(page, 'todo', WORK_EN.todo);
  assert((await chipsNow(page)).length === 1, 'chips: ' + JSON.stringify(await chipsNow(page)));
  noErrors(page);
}

async function check7(pi) {
  const cases = [
    { name: '?fx=ring (activity off)', o: { query: 'motion=push&fx=ring' } },
    { name: '?fx=off', o: { query: 'motion=push&fx=off' } },
    { name: 'motionFx: { activity: false }', o: { config: 'HUB_CONFIG.motionFx = { activity: false };' } },
    { name: 'fade', o: { query: 'motion=fade' } },
    { name: 'measured slow (24 fps)', o: { slow: { mode: 'push', fps: 24 }, query: 'x=1' } },
    { name: 'auto stepped down', o: { slow: { mode: 'expand', fps: 52 }, query: 'x=1' } }
  ];
  for (const c of cases) {
    const page = await open(Object.assign({ pi: pi }, c.o));
    await say(pi, 'hub:working todo');
    await say(pi, 'hub:working awws');
    await sleep(1600);
    const seen = await chipLog(page);
    const t = await toasts(page);
    assert(!seen.length, c.name + ': chips: ' + JSON.stringify(seen));
    assert(!t.length, c.name + ': a message: ' + JSON.stringify(t));
    assert(!(await page.evaluate(() => document.querySelectorAll('.fx-chip, .fx-edge').length)), c.name + ': elements');
    noErrors(page);
    await page.context().close();
  }
}

async function check8(pi) {
  const page = await open({ pi: pi });
  for (const text of ['hub:working', 'hub:working TODO', 'hub:working todo 5x', 'hub:nope', 'hub:working todo  done extra', 'hub:']) await say(pi, text);
  await sleep(1500);
  assert(!(await chipLog(page)).length, 'a chip: ' + JSON.stringify(await chipLog(page)));
  assert(!(await toasts(page)).length, 'a message: ' + JSON.stringify(await toasts(page)));
  assert(!(await fx(page)).working.length, 'a state: ' + JSON.stringify((await fx(page)).working));
  await say(pi, 'Dinner in 10');
  await until(async () => (await toasts(page)).indexOf('Dinner in 10') >= 0, 3000, 'an ordinary say did not show');
  assert((await toasts(page)).length === 1, 'messages: ' + JSON.stringify(await toasts(page)));
  noErrors(page);
}

async function check9(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working nosuch');
  await say(pi, 'hub:working nosuch done');
  await say(pi, 'hub:working weather 30');
  await sleep(1500);
  assert(!(await chipLog(page)).length, 'a chip: ' + JSON.stringify(await chipLog(page)));
  assert(!(await toasts(page)).length, 'a message');
  assert(!(await fx(page)).working.length, 'a state: ' + JSON.stringify((await fx(page)).working));
  // Straight in, too: false, nothing thrown.
  const r = await page.evaluate(() => [window.HUB_FX.working('nosuch', 30), window.HUB_FX.workingDone('nosuch'), window.HUB_FX.working('', null), window.HUB_FX.working('todo', 'x')]);
  assert(r.every((x) => x === false), 'answers: ' + JSON.stringify(r));
  noErrors(page);
}

// A World Worth Saving tiles in a list order that is not the reading order:
// awws-visits (draws from the calendar, not declared) first, then awws-todo
// (lower left), which must get the chip, then awws-agenda (top) and awws.
const AWWS_LAYOUT = [
  { widget: 'awws-visits', x: 0, y: 0, w: 3, h: 2 },
  { widget: 'awws-todo', x: 0, y: 2, w: 4, h: 4 },
  { widget: 'awws-agenda', x: 3, y: 0, w: 6, h: 2 },
  { widget: 'awws', x: 4, y: 2, w: 5, h: 4 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
  { widget: 'today', x: 9, y: 2, w: 3, h: 1 },
  { widget: 'todo', x: 9, y: 3, w: 3, h: 3 }
];
// The same tiles, awws-agenda listed first.
const AWWS_LAYOUT_2 = [AWWS_LAYOUT[0], AWWS_LAYOUT[2], AWWS_LAYOUT[1]].concat(AWWS_LAYOUT.slice(3));

async function check10(pi) {
  // Calendar first, in the built-in layout.
  let page = await open({ pi: pi });
  await say(pi, 'hub:working calendar');
  await workingChip(page, 'calendar', WORK_EN.calendar);
  assert((await chipsNow(page)).length === 1, 'chips: ' + JSON.stringify(await chipsNow(page)));
  noErrors(page);
  await page.context().close();
  await setLayout(pi, AWWS_LAYOUT);
  try {
    page = await open({ pi: pi });
    await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="awws-todo"]')), 6000, 'the layout did not arrive');
    await ready(page);
    await say(pi, 'hub:working awws');
    await workingChip(page, 'awws-todo', WORK_EN.awws);
    await sleep(1200);
    const list = await chipsNow(page);
    assert(list.length === 1 && list[0].w === 'awws-todo', 'chips: ' + JSON.stringify(list));
    // A changed snapshot: the chip becomes the arrival chip there, and the other snapshot tiles say so as before.
    await page.evaluate(() => { window.__w = document.querySelector('.cell[data-widget="awws-todo"] .fx-chip'); });
    await postSnapshot(pi, snapshotNow({ reach: Math.random() < 0.5 ? 'subscribers' : 'traffic' }));
    await until(async () => (await chipsNow(page)).filter((c) => !c.working).length >= 3, 4000, 'no arrival chips');
    const arr = await chipsNow(page);
    const same = await page.evaluate(() => window.__w === document.querySelector('.cell[data-widget="awws-todo"] .fx-chip'));
    assert(same, 'the awws-todo chip was replaced');
    assert(arr.length === 3 && arr.every((c) => !c.working && c.text === 'Syncing data' && c.edge) &&
      arr.map((c) => c.w).sort().join(',') === 'awws,awws-agenda,awws-todo', 'arrival chips: ' + JSON.stringify(arr));
    noErrors(page);
  } finally {
    await setLayout(pi, null);
  }
}

// Three-column tiles in three heights: To-do 3x1, Calendar 3x2, A World Worth Saving 3x4.
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

async function check11(pi) {
  await setLayout(pi, NARROW);
  try {
    const variants = [
      { name: 'Spanish (app/i18n.js)', init: 'try { localStorage.setItem("homeHub.lang", "es"); } catch (e) {}', want: WORK_ES },
      { name: 'English', init: undefined, want: WORK_EN }
    ];
    for (const v of variants) {
      const page = await open({ pi: pi, init: v.init });
      await until(() => page.evaluate(() => { const r = window.HUB_TEST.homeRects(); return r.todo && r.todo.height < 200; }), 4000, 'the layout did not arrive');
      await sleep(300);
      for (const k of ['todo', 'calendar', 'awws']) await say(pi, 'hub:working ' + k);
      for (const k of ['todo', 'calendar', 'awws']) await workingChip(page, k);
      await sleep(400);
      const info = await page.evaluate(() => {
        function lum(c) {
          const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        }
        function rgba(s) { const m = s.match(/[\d.]+/g).map(Number); return { c: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; }
        return ['todo', 'calendar', 'awws'].map((k) => {
          const tile = document.querySelector('.cell[data-widget="' + k + '"] .tile');
          const c = tile.querySelector('.fx-chip');
          const t = c.querySelector('.fx-chip-text');
          const cs = getComputedStyle(t);
          const T = tile.getBoundingClientRect();
          const R = c.getBoundingClientRect();
          const lh = parseFloat(cs.lineHeight);
          const bg = rgba(getComputedStyle(c).backgroundColor);
          const fg = rgba(cs.color).c;
          const ratios = [255, 0].map((under) => {
            const mix = bg.c.map((x) => x * bg.a + under * (1 - bg.a));
            const a = lum(fg);
            const b = lum(mix);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
          return { k: k, text: t.textContent, tileW: Math.round(T.width), tileH: Math.round(T.height), chipW: Math.round(R.width),
            fits: t.scrollWidth <= t.clientWidth, lines: t.getBoundingClientRect().height / lh, boxOk: t.clientHeight + 0.5 >= lh,
            font: parseFloat(cs.fontSize), maxOk: R.width <= T.width - 56 + 1,
            inside: R.left >= T.left && R.right <= T.right && R.top >= T.top && R.bottom <= T.bottom, contrast: Math.min.apply(null, ratios) };
        });
      });
      for (const i of info) {
        const where = v.name + ' ' + i.k + ' (' + i.tileW + 'x' + i.tileH + ', "' + i.text + '")';
        assert(i.text === v.want[i.k], where + ': not the words wanted (' + v.want[i.k] + ')');
        assert(i.fits, where + ': cut (' + i.chipW + ' px)');
        assert(i.lines < 1.5 && i.boxOk, where + ': not one line: ' + JSON.stringify(i));
        assert(i.font >= 22, where + ': text ' + i.font + ' px');
        assert(i.maxOk && i.inside, where + ': wider than the tile minus 56 px, or outside it: ' + JSON.stringify(i));
        assert(i.contrast >= 4.5, where + ': contrast ' + i.contrast.toFixed(2));
      }
      console.log('      ' + v.name + ': ' + info.map((i) => i.k + ' ' + i.chipW + '/' + i.tileW + ' px, ' + i.contrast.toFixed(1) + ':1').join('; '));
      for (const k of ['todo', 'calendar', 'awws']) await say(pi, 'hub:working ' + k + ' done');
      await noneLeft(page, 2000, 'done did not clear them');
      noErrors(page);
      await page.context().close();
    }
  } finally {
    await setLayout(pi, null);
  }
}

async function check12(pi) {
  const page = await open({ pi: pi });
  await say(pi, 'hub:working todo 60');
  await workingChip(page, 'todo');
  await sleep(400);
  await page.evaluate(() => { window.__w = document.querySelector('.fx-chip'); window.__added = 0;
    new MutationObserver((ms) => ms.forEach((m) => { window.__added += m.addedNodes.length + m.removedNodes.length; }))
      .observe(document.querySelector('.cell[data-widget="todo"] .tile'), { childList: true });
    window.__cls = []; new MutationObserver(() => window.__cls.push(window.__w.className)).observe(window.__w, { attributes: true }); });
  const a = await workingOf(page, 'todo');
  await say(pi, 'hub:working todo 300');
  await until(async () => (await workingOf(page, 'todo')).left > 290000, 3000, 'not extended');
  await say(pi, 'hub:working todo 30');   // a shorter time does not cut it short
  await sleep(1500);
  const b = await workingOf(page, 'todo');
  const r = await page.evaluate(() => ({ same: window.__w === document.querySelector('.fx-chip'), added: window.__added, cls: window.__cls, n: document.querySelectorAll('.fx-chip').length }));
  assert(a.left <= 60000 && b.left > 290000, 'times: ' + JSON.stringify([a, b]));
  assert(r.same && r.added === 0 && r.n === 1 && !r.cls.length, 'the chip changed: ' + JSON.stringify(r));
  noErrors(page);
}

async function check13(pi) {
  // In place (the same widgets): the awws chip moves to the tile now first.
  await setLayout(pi, AWWS_LAYOUT);
  try {
    const page = await open({ pi: pi });
    await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="awws-todo"]')), 6000, 'the layout did not arrive');
    await ready(page);
    await say(pi, 'hub:working awws 300');
    await say(pi, 'hub:working todo 300');
    await workingChip(page, 'awws-todo');
    await workingChip(page, 'todo');
    const todoChip = await page.evaluateHandle(() => document.querySelector('.cell[data-widget="todo"] .fx-chip'));
    await setLayout(pi, AWWS_LAYOUT_2);
    await until(() => page.evaluate(() => window.HUB_TEST.layout()[1].widget === 'awws-agenda'), 4000, 'the second layout did not arrive');
    await workingChip(page, 'awws-agenda', WORK_EN.awws);
    let list = await chipsNow(page);
    assert(list.length === 2 && list.filter((c) => c.w === 'awws-agenda').length === 1 && list.filter((c) => c.w === 'todo').length === 1, 'chips: ' + JSON.stringify(list));
    assert(await todoChip.evaluate((n) => n.isConnected), 'the to-do chip was replaced on an in-place switch');
    // Other widgets: the page reloads, and the chips come back on the new layout's tiles.
    const NEXT = [
      { widget: 'todo', x: 0, y: 0, w: 4, h: 6 },
      { widget: 'awws-reach', x: 4, y: 0, w: 4, h: 3 },
      { widget: 'awws', x: 4, y: 3, w: 4, h: 3 },
      { widget: 'weather', x: 8, y: 0, w: 4, h: 3 },
      { widget: 'calendar', x: 8, y: 3, w: 4, h: 3 }
    ];
    page.errors = [];
    const loaded = page.waitForEvent('load', { timeout: 8000 });
    await setLayout(pi, NEXT);
    await loaded;
    await ready(page);
    await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="awws-reach"]')), 6000, 'the page did not rebuild');
    await workingChip(page, 'awws-reach', WORK_EN.awws);
    await workingChip(page, 'todo', WORK_EN.todo);
    list = await chipsNow(page);
    assert(list.length === 2, 'chips after the reload: ' + JSON.stringify(list));
    const st = (await fx(page)).working;
    assert(st.length === 2 && st.every((w) => w.left > 250000), 'states after the reload: ' + JSON.stringify(st));
    // The first sync after the reload did not end them; a done still does.
    await say(pi, 'hub:working awws done');
    await say(pi, 'hub:working todo done');
    await noneLeft(page, 2000, 'done after the reload');
    assert(!(await toasts(page)).length, 'a message: ' + JSON.stringify(await toasts(page)));
    noErrors(page);
  } finally {
    await setLayout(pi, null);
  }
}

// Moves the focus with the arrow keys to the tile of widget (always toward
// it, so it never steps off an edge into the layout bar or About).
async function focusOn(page, widget) {
  for (let n = 0; n < 12; n++) {
    const d = await page.evaluate((w) => {
      const f = document.querySelector('#grid .tile.is-focused');
      const t = document.querySelector('.cell[data-widget="' + w + '"] .tile');
      if (!t) return 'none';
      if (f === t) return '';
      const a = f.getBoundingClientRect();
      const b = t.getBoundingClientRect();
      const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
      const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      if (b.top >= a.bottom - 1) return 'ArrowDown';
      if (b.bottom <= a.top + 1) return 'ArrowUp';
      return dx > 0 ? 'ArrowRight' : dx < 0 ? 'ArrowLeft' : (dy > 0 ? 'ArrowDown' : 'ArrowUp');
    }, widget);
    if (d === '') { await sleep(300); return; }
    assert(d !== 'none', 'no ' + widget + ' tile');
    await page.keyboard.press(d);
    await sleep(250);
  }
  throw new Error('could not focus the ' + widget + ' tile');
}

// The focus highlight around the lap, now: the ring's class and opacity,
// which tiles carry the tile class, the To-do tile's border colours and size.
const edgeState = (page) => page.evaluate(() => {
  const ring = document.querySelector('.fx-ring');
  const tile = document.querySelector('.cell[data-widget="todo"] .tile');
  const cs = getComputedStyle(tile);
  const r = tile.getBoundingClientRect();
  const chip = tile.querySelector('.fx-chip');
  return {
    ring: !!ring, ringCls: !!(ring && ring.classList.contains('fx-ring-lap')),
    ringOp: ring ? getComputedStyle(ring).opacity : null,
    tiles: Array.prototype.map.call(document.querySelectorAll('.fx-lap-focus'), (t) => { const c = t.closest('.cell'); return c && c.getAttribute('data-widget'); }),
    left: document.querySelectorAll('.fx-lap-focus, .fx-ring-lap').length,
    edge: !!tile.querySelector('.fx-edge'), out: !!(chip && chip.classList.contains('is-out')),
    focused: tile.classList.contains('is-focused'),
    top: cs.borderTopColor, side: cs.borderLeftColor, right: cs.borderRightColor, bottom: cs.borderBottomColor, topW: cs.borderTopWidth,
    box: [r.left, r.top, r.width, r.height].map((x) => Math.round(x * 100) / 100).join(',')
  };
});

// Samples every frame: is the lap running (its overlay there), and is the
// highlight off (ring class, or the To-do tile's class)?
async function edgeWatch(page) {
  await page.evaluate(() => {
    window.__edge = [];
    const tile = document.querySelector('.cell[data-widget="todo"] .tile');
    function frame() {
      const ring = document.querySelector('.fx-ring');
      const chip = tile.querySelector('.fx-chip');
      window.__edge.push({ edge: !!tile.querySelector('.fx-edge'), out: !!(chip && chip.classList.contains('is-out')),
        focused: tile.classList.contains('is-focused'),
        hidden: !!(ring && ring.classList.contains('fx-ring-lap')) || tile.classList.contains('fx-lap-focus'),
        others: document.querySelectorAll('.fx-lap-focus').length - (tile.classList.contains('fx-lap-focus') ? 1 : 0) });
      if (window.__edge.length < 400) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

const WHITE = 'rgb(255, 255, 255)';
// theme=night: the focused tile's own border is white at night and dark ink by day (the test's clock is 10:40 AM).
const NO_RING = 'motion=push&theme=night&fx=quietTiles,stagger,cover,bloom,activity';

async function arrival(pi, page) {
  await postTodo(pi, 'Arrived ' + Date.now());
  await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="todo"] .tile .fx-edge')), 4000, 'no lap');
}

async function check14(pi) {
  // With the ring: it is invisible (the whole highlight off) while the lap runs, then back.
  let page = await open({ pi: pi });
  await focusOn(page, 'todo');
  let before = await edgeState(page);
  assert(before.ring && !before.ringCls && before.ringOp === '1' && !before.left, 'before: ' + JSON.stringify(before));
  await edgeWatch(page);
  await arrival(pi, page);
  let mid = await edgeState(page);
  assert(mid.ringCls && mid.ringOp === '0' && !mid.tiles.length, 'ring still showing during the lap: ' + JSON.stringify(mid));
  assert(mid.box === before.box && mid.top === before.top, 'the tile itself changed under the ring: ' + JSON.stringify([before, mid]));
  await sleep(1200);
  assert((await edgeState(page)).ringCls, 'the ring came back before the lap ended');
  await noneLeft(page, 3000, 'the chip stayed');
  let after = await edgeState(page);
  assert(!after.ringCls && after.ringOp === '1' && !after.left, 'left behind with the ring: ' + JSON.stringify(after));
  let log = await page.evaluate(() => window.__edge);
  let bad = log.filter((s) => s.hidden !== (s.edge && s.focused) || s.others);
  assert(log.some((s) => s.hidden) && !bad.length, 'the ring did not follow the lap: ' + JSON.stringify(bad.slice(0, 3)));
  noErrors(page);

  // Focus moving to another tile mid-lap: everything back at once, the ring showing on the new tile.
  await arrival(pi, page);
  assert((await edgeState(page)).ringCls, 'second lap: the ring showed');
  await page.keyboard.press('ArrowUp');
  let moved = await edgeState(page);
  assert(!moved.focused && moved.edge, 'the focus did not move off the To-do tile mid-sweep: ' + JSON.stringify(moved));
  assert(!moved.ringCls && moved.ringOp === '1' && !moved.left, 'not restored at once on the move: ' + JSON.stringify(moved));
  await sleep(400);
  assert(!(await edgeState(page)).left, 'hidden after the glide');
  await noneLeft(page, 3500, 'the chip stayed (moved)');

  // An unfocused tile's arrival changes nothing about the ring.
  await edgeWatch(page);
  await arrival(pi, page);
  const other = await edgeState(page);
  assert(!other.focused && !other.ringCls && other.ringOp === '1' && !other.left, 'an unfocused tile changed the ring: ' + JSON.stringify(other));
  await noneLeft(page, 3500, 'the chip stayed (unfocused)');
  log = await page.evaluate(() => window.__edge);
  assert(log.some((s) => s.edge) && log.every((s) => !s.hidden && !s.others), 'hidden on an unfocused tile');

  // A panel opening mid-lap: everything back.
  await focusOn(page, 'todo');
  await arrival(pi, page);
  assert((await edgeState(page)).ringCls, 'third lap: the ring showed');
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  const panel = await edgeState(page);
  assert(!panel.edge && !panel.ringCls && !panel.left, 'not restored on a panel: ' + JSON.stringify(panel));
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await idle(page);
  await sleep(400);
  assert(!(await edgeState(page)).left, 'left behind after the panel');
  noErrors(page);
  await page.context().close();

  // Without the ring: the tile's whole border takes the plain line colour (same size), then back.
  page = await open({ pi: pi, query: NO_RING });
  await focusOn(page, 'todo');
  before = await edgeState(page);
  assert(!before.ring && before.top === WHITE && !before.left, 'before (no ring): ' + JSON.stringify(before));
  await edgeWatch(page);
  await arrival(pi, page);
  mid = await edgeState(page);
  assert(mid.tiles.join() === 'todo' && [mid.right, mid.bottom, mid.side].every((c) => c === mid.top) && mid.top !== WHITE && /^rgba\(255, 255, 255, 0\.1/.test(mid.top), 'highlight not off the whole border: ' + JSON.stringify(mid));
  assert(mid.box === before.box && mid.topW === before.topW, 'the tile moved or resized: ' + JSON.stringify([before, mid]));
  await noneLeft(page, 3500, 'the chip stayed (no ring)');
  after = await edgeState(page);
  assert(!after.left && [after.top, after.right, after.bottom, after.side].every((c) => c === WHITE), 'not restored (no ring): ' + JSON.stringify(after));
  log = await page.evaluate(() => window.__edge);
  bad = log.filter((s) => s.hidden !== (s.edge && s.focused) || s.others);
  assert(log.some((s) => s.hidden) && !bad.length, 'the tile class did not follow the lap: ' + JSON.stringify(bad.slice(0, 3)));
  // Focus moving away mid-sweep, and a panel, without the ring.
  await arrival(pi, page);
  await page.keyboard.press('ArrowUp');
  moved = await edgeState(page);
  assert(!moved.focused && moved.edge && !moved.left, 'not restored at once on the move (no ring): ' + JSON.stringify(moved));
  await noneLeft(page, 3500, 'the chip stayed (no ring, moved)');
  await focusOn(page, 'todo');
  await arrival(pi, page);
  assert((await edgeState(page)).tiles.join() === 'todo', 'no ring, third lap: not off');
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  assert(!(await edgeState(page)).left, 'not restored on a panel (no ring)');
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await idle(page);
  assert(!(await edgeState(page)).left, 'left behind after the panel (no ring)');
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

  await check('1. "hub:working todo": no message, one quiet chip in the To-do tile that only breathes, no edge', () => check1(pi));
  await check('2. A new to-do turns that same chip into "Incoming to-do" (edge sweeps), which goes and leaves nothing', () => check2(pi));
  await check('3. "hub:working todo 10" ends by itself after about 10 s', () => check3(pi));
  await check('4. "hub:working todo done" ends it quietly', () => check4(pi));
  await check('5. Unchanged data (a snapshot sent again, a renamed to-do) ends it about 1.5 s later', () => check5(pi));
  await check('6. A panel takes it away; closing the panel brings it back while time is left', () => check6(pi));
  await check('7. Off with the activity switch, in fade mode and on a slow TV: no chip and no message', () => check7(pi));
  await check('8. Malformed hub: texts show nothing at all; an ordinary say still shows', () => check8(pi));
  await check('9. An unknown kind shows nothing and throws nothing', () => check9(pi));
  await check('10. Calendar on the calendar tile; A World Worth Saving: one chip, first declaring tile in layout order, then arrival', () => check10(pi));
  await check('11. Spanish (app/i18n.js) and English on one line in 3-column tiles, 22px+, 4.5:1', () => check11(pi));
  await check('12. A repeated start extends the time and keeps the same element', () => check12(pi));
  await check('13. A layout switch (in place, and one that reloads) puts the chip on the new layout\'s tile', () => check13(pi));
  await check('14. On the focused tile the whole highlight is off while the light laps the border (ring hidden, or the tile\'s whole border plain), and comes back on its end, a focus move or a panel', () => check14(pi));
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
