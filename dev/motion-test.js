/*
 * Motion extras (app/motion.js), end to end: node dev/motion-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js),
 * the hub server from pi/ and a stand-in for Spotify (dev/mock-spotify.js),
 * all on spare ports with a fresh data folder. Nothing reaches the internet.
 * Needs Playwright (require('playwright')).
 *
 * Checks: with the switches off (motionFx: false, ?fx=off) nothing extra is
 * added, not an element, not a class; in 'fade' mode, on a TV that measured
 * slow, and after auto stepped down to expand, each motion is off (focus is
 * the plain border, items, rows, the cover and the app just show); quiet
 * waiting tiles are one small line, in English and in Spanish, with nothing
 * cut or clipped, while tiles with real data are left alone; the ring sits
 * on the focused tile, glides on a press, jumps on a held key, and is right
 * after a layout switch and a window resize; the stagger; a new to-do from
 * a sync shows its row at once (no slide), nothing left after; the cover's
 * flight; the bloom. Then the activity chips: off with their switch, in fade
 * mode and on a slow TV; never for the first data after the hub starts or a
 * refetch with the same data, or a to-do only ticked done on the Pi; one
 * chip in the To-do tile for a new to-do that goes by itself and leaves
 * nothing behind, and one for a to-do whose notes changed on the Pi; none while the wanderers
 * are on screen; the Spanish words fit one line in 3-column tiles (3x1, 3x2,
 * 3x4) without "…", at 22px or more, with 4.5:1 contrast.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * It cannot prove the TV: a desktop browser runs far faster.
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
const { SPANISH: AWWS_ES } = require('./awws-harness');
const calendarSample = require('./calendar-sample');
const awwsSample = require('./awws-sample');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];
const BUILD = /var BUILD = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'hub.js'), 'utf8'))[1];

// The default layout with Weather and Now Playing swapped: the same widgets.
const SWAPPED = [
  { widget: 'today', x: 0, y: 0, w: 3, h: 1 },
  { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 },
  { widget: 'awws', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'nowplaying', x: 9, y: 0, w: 3, h: 2 },
  { widget: 'todo', x: 0, y: 1, w: 3, h: 4 },
  { widget: 'mirror', x: 9, y: 2, w: 3, h: 4 },
  { widget: 'ambiance', x: 3, y: 4, w: 6, h: 1 },
  { widget: 'weather', x: 0, y: 5, w: 3, h: 1 },
  { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
];

// Spanish for the waiting tiles (about a quarter longer than English).
const CAL_ES = {
  states: {
    off: { head: 'El calendario necesita la Raspberry Pi', short: 'Las actualizaciones en vivo están apagadas.' },
    quiet: { head: 'El calendario necesita la Raspberry Pi', short: 'Esperando al servidor del hub en la Pi.' },
    lost: { head: 'No se puede conectar con la Pi', short: 'Volviendo a intentarlo sin molestar.' },
    loading: { head: 'Cargando el calendario…' }
  }
};
const PLANNED_ES = { texts: {
  mirror: 'Un espejo con cámara para las mañanas y las salidas de noche.',
  ambiance: 'Elegir el ambiente de luz desde el televisor, sin levantarse del sofá.'
}, note: 'Todavía no está hecho. Este espacio está reservado.' };
const TODO_ES = { sub: 'En este televisor', emptyTitle: 'Todavía no hay nada en la lista.', emptyHint: 'Pulsa OK para añadir algo.' };
const SPANISH_INIT = 'window.HUB_AWWS_STRINGS = ' + JSON.stringify(AWWS_ES) + ';' +
  'window.HUB_CALENDAR_STRINGS = ' + JSON.stringify(CAL_ES) + ';' +
  'window.HUB_PLANNED_STRINGS = ' + JSON.stringify(PLANNED_ES) + ';' +
  'window.HUB_TODO_STRINGS = ' + JSON.stringify(TODO_ES) + ';';

// The hub's Spanish table (app/i18n.js), read the way the TV runs it: the
// activity chips' Spanish comes from there ('motion.activity.<kind>').
const I18N_ES = (function () {
  const ctx = { window: { location: { search: '' } }, document: { documentElement: { setAttribute() {} } }, location: { search: '' } };
  require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8'), ctx);
  return ctx.window.HUB_I18N.strings.es;
})();
const KINDS = ['todo', 'calendar', 'awws'];
const MOTION_ES = {};
KINDS.forEach((k) => { MOTION_ES[k] = I18N_ES['motion.activity.' + k]; });


// Notes every chip the page ever adds (window.__chips), from the first moment.
const CHIP_WATCH = '(function () { window.__chips = []; function watch() {' +
  ' new MutationObserver(function (ms) { ms.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) {' +
  ' if (n.nodeType === 1 && /(^| )fx-chip( |$)/.test(n.className)) { var c = n.closest(".cell");' +
  ' window.__chips.push({ w: c && c.getAttribute("data-widget"), text: n.textContent, t: Date.now() }); } }); }); })' +
  '.observe(document.documentElement, { childList: true, subtree: true }); }' +
  ' if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch); })();';

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
  if (process.env.MOTION_GREP && name.indexOf(process.env.MOTION_GREP) < 0) return;
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

/* ---------- servers ---------- */

async function startPi() {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-motion-test-'));
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
  await context.addInitScript(CHIP_WATCH);
  if (o.init) await context.addInitScript(o.init);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) page.errors.push(m.text()); });
  const live = o.pi ? 'live=' + encodeURIComponent(o.pi.url) : (o.live || 'live=off');
  // ?agent=off: these checks are about the chips themselves, which are now
  // the fallback when the character (app/agents.js) cannot come; with her
  // on she replaces the chip once her pictures load (dev/agents-test.js).
  await page.goto(PAGE + '/hub.html?agent=off&' + (o.clay ? '' : 'clay=off&') + live + (o.query ? '&' + o.query : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  if (o.pi) await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'the hub did not go live');
  await sleep(200);
  return page;
}

const fx = (page) => page.evaluate(() => window.HUB_TEST.fx());
const idle = (page) => until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
const focused = (page) => page.evaluate(() => {
  const t = document.querySelector('#grid .tile.is-focused');
  return t ? t.parentNode.getAttribute('data-widget') : null;
});

// Everything the extras could have added.
const extras = (page) => page.evaluate(() => ({
  nodes: document.querySelectorAll('.fx-ring, .fx-fly, .fx-bloom, .fx-chip, .fx-edge, .fx-accent').length,
  body: document.body.className.split(' ').filter((c) => /^fx-/.test(c)),
  dormant: document.querySelectorAll('.tile.is-dormant').length
}));

function noErrors(page) { assert(!page.errors.length, 'page errors: ' + page.errors.join(' | ')); }

// Opens Entertainment and looks at its items while it grows.
async function openEntertainment(page) {
  await page.evaluate(() => {
    window.__items = [];
    const seen = [];
    const t0 = performance.now();
    (function look() {
      const items = document.querySelectorAll('.panel .ent-item');
      if (items.length) {
        const s = items[items.length - 1].style;
        const cs = getComputedStyle(items[0]);
        seen.push({ t: performance.now() - t0, opacity: items[0].style.opacity, last: s.opacity, transition: items[0].style.transition, lastTransition: s.transition,
          transform: items[0].style.transform, shownOpacity: cs.opacity, shownTransform: cs.transform });
      }
      if (performance.now() - t0 < 900) requestAnimationFrame(look);
      else window.__items = seen;
    })();
    // These checks are about the small panel; config.js opens Entertainment
    // straight to full screen.
    window.HUB_CONFIG.widgets.entertainment.openMode = 'panel'; window.HUB_TEST.openPanel('entertainment');
  });
  await sleep(1000);
  return page.evaluate(() => window.__items);
}

// Netflix, the first item, then OK: the app "opens" (the preview prints it).
async function launchFirstApp(page) {
  await until(() => page.evaluate(() => !!document.querySelector('.panel .ent-item.is-focused')), 3000, 'no focused app');
  await page.evaluate(() => {
    const first = document.querySelector('.panel .ent-item');
    first.click();
  });
}

async function postTodo(pi, title) {
  const r = await control(pi, 'POST', '/api/todo', { title: title, section: 'now' });
  assert(r.ok, 'the server refused the to-do: ' + JSON.stringify(r));
  return r.item.id;
}

/* ---------- the checks ---------- */

async function checkOff(pi) {
  for (const how of [{ query: 'fx=off' }, { config: 'HUB_CONFIG.motionFx = false;' }]) {
    const page = await open(Object.assign({ pi: pi }, how));
    await idle(page);
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) { await page.keyboard.press(k); await sleep(80); }
    let x = await extras(page);
    assert(!x.nodes && !x.body.length && !x.dormant, (how.query || 'config') + ': extras at home: ' + JSON.stringify(x));
    const items = await openEntertainment(page);
    assert(items.length && items.every((s) => !s.opacity && !s.transform), 'items were moved: ' + JSON.stringify(items.slice(0, 2)));
    await launchFirstApp(page);
    await sleep(200);
    x = await extras(page);
    assert(!x.nodes, 'a bloom: ' + JSON.stringify(x));
    await page.keyboard.press('Escape');
    await idle(page);
    await sleep(300);
    await postTodo(pi, 'Off check ' + Date.now());
    await until(() => page.evaluate(() => document.querySelectorAll('.todo-tile-row').length > 0), 4000, 'the to-do did not arrive');
    await sleep(400);
    x = await extras(page);
    assert(!x.nodes && !x.body.length && !x.dormant, 'extras after a new to-do: ' + JSON.stringify(x));
    const about = await page.evaluate(() => { window.HUB_TEST.about.open(); const r = window.HUB_TEST.about.rows().filter((r) => r.label === 'Motion')[0]; window.HUB_TEST.about.close(); return r && r.value; });
    assert(about && !/extras/.test(about), 'About Motion row: ' + about);
    noErrors(page);
    await page.context().close();
  }
}

// Frame times (ms) of a run: n frames of 'gap' ms, with the given long gaps put in.
function runOf(n, gap, longs) {
  const times = [0];
  for (let i = 1; i <= n; i++) times.push(times[i - 1] + (longs && longs[i] ? longs[i] : gap));
  return times;
}

async function checkDetection(pi) {
  const page = await open({ pi: pi });
  const run = (runs) => page.evaluate((r) => window.HUB_TEST.motionRuns(r), runs);
  // Smooth runs (~100 fps, then ~71 fps) settle on push.
  let r = await run([runOf(30, 10), runOf(30, 14), runOf(30, 10)]);
  assert(r.mode === 'push' && !r.measuring, 'smooth runs: ' + JSON.stringify(r));
  // The reported case: runs that are fast but each carry one 180 ms stall do not step down.
  r = await run([runOf(30, 10, { 12: 180 }), runOf(30, 10, { 12: 180 }), runOf(30, 10, { 12: 180 }), runOf(30, 10, { 12: 180 })]);
  assert(r.mode === 'push', 'one stall per run stepped down: ' + JSON.stringify(r));
  // Three stalls in a run is janky, but needs three such runs to step down.
  const jerky = () => runOf(30, 10, { 8: 130, 14: 130, 20: 130 });
  r = await run([jerky(), jerky()]);
  assert(r.mode === 'push', 'two janky runs stepped down: ' + JSON.stringify(r));
  r = await run([jerky(), jerky(), jerky()]);
  assert(r.mode === 'expand' && r.worst === 130, 'three janky runs: ' + JSON.stringify(r));
  // A real slow rate (25 fps) steps down after three runs too.
  r = await run([runOf(30, 40), runOf(30, 40), runOf(30, 40)]);
  assert(r.mode === 'expand' && r.fps >= 24 && r.fps <= 26, 'slow runs: ' + JSON.stringify(r));
  // A step-down is forgotten after a day: the stored record goes back to push.
  await page.evaluate((b) => localStorage.setItem('homeHub.motion', JSON.stringify({ mode: 'expand', build: b, fps: 71, at: Date.now() - 25 * 3600 * 1000 })), BUILD);
  await page.reload();
  await page.waitForFunction(() => window.HUB_TEST);
  const st = await fx(page);
  assert(st.speed === 'ok', 'a day-old step-down still on: ' + st.speed);
  await page.evaluate((b) => localStorage.setItem('homeHub.motion', JSON.stringify({ mode: 'expand', build: b, fps: 71, at: Date.now() - 3600 * 1000 })), BUILD);
  await page.reload();
  await page.waitForFunction(() => window.HUB_TEST);
  assert((await fx(page)).speed === 'slow', 'a fresh step-down was forgotten');
  noErrors(page);
  await page.context().close();
}

// A new build keeps a clean push result (timed again later) but not a step-down,
// and nothing is timed in the first minute after a load.
async function checkSettle(pi) {
  const page = await open({ pi: pi });
  const state = () => page.evaluate(() => window.HUB_TEST.motionState());
  const reloadWith = async (rec) => {
    await page.evaluate((r) => localStorage.setItem('homeHub.motion', JSON.stringify(r)), rec);
    await page.reload();
    await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  };
  // An older build's clean push: push at once, extras on, timed again later.
  await reloadWith({ mode: 'push', build: 'v0.0.1', fps: 61, at: Date.now() });
  let s = await state();
  assert(s.mode === 'push' && s.measuring, 'an older clean push: ' + JSON.stringify(s));
  assert((await fx(page)).speed === 'ok', 'extras off after an older clean push');
  // An older build's step-down: back to the top rung, timed again.
  await reloadWith({ mode: 'expand', build: 'v0.0.1', fps: 50, measuring: true, at: Date.now() });
  s = await state();
  assert(s.mode === 'push' && s.measuring, 'an older step-down kept: ' + JSON.stringify(s));
  // This build's step-down still holds (for its day).
  await reloadWith({ mode: 'expand', build: BUILD, fps: 50, at: Date.now() });
  assert((await state()).mode === 'expand', 'this build\'s step-down was dropped');
  // In the first minute: opening and closing a panel is not timed.
  await reloadWith({ mode: 'push', build: 'v0.0.1', fps: 61, at: Date.now() });
  await idle(page);
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Enter');
    await sleep(900);
    await page.keyboard.press('Escape');
    await sleep(900);
  }
  s = await state();
  assert(s.runs === 0 && s.measuring, 'timed while settling: ' + JSON.stringify(s));
  noErrors(page);
  await page.context().close();
  // With ?settle=0 the same opens are timed.
  const now = await open({ pi: pi, query: 'settle=0' });
  await idle(now);
  for (let i = 0; i < 2; i++) {
    await now.keyboard.press('Enter');
    await sleep(900);
    await now.keyboard.press('Escape');
    await sleep(900);
  }
  s = await now.evaluate(() => window.HUB_TEST.motionState());
  assert(s.runs > 0 || !s.measuring, 'not timed with settle=0: ' + JSON.stringify(s));
  noErrors(now);
  await now.context().close();
}

async function checkDisabled(pi) {
  const cases = [
    { name: 'fade', o: { query: 'motion=fade' }, why: 'fade' },
    { name: 'measured slow (24 fps)', o: { slow: { mode: 'push', fps: 24 } }, why: 'slow' },
    { name: 'auto stepped down to expand', o: { slow: { mode: 'expand', fps: 52 } }, why: 'slow' }
  ];
  for (const c of cases) {
    const page = await open(Object.assign({ pi: pi }, c.o));
    await idle(page);
    const st = await fx(page);
    assert(st.speed === c.why && st.lightSpeed === c.why, c.name + ': speed ' + st.speed + ', light ' + st.lightSpeed);
    // Ring: the plain border swap.
    await page.keyboard.press('ArrowLeft');
    await sleep(60);
    let x = await extras(page);
    // The still accent edge (a tile updating, or an event within the hour) stays on
    // purpose and is checked as a still line below; it is not a ring.
    const loud = await page.evaluate(() => document.querySelectorAll('.fx-ring, .fx-fly, .fx-bloom, .fx-chip, .fx-edge').length);
    assert(!loud, c.name + ': a ring: ' + JSON.stringify(x));
    const border = await page.evaluate(() => getComputedStyle(document.querySelector('#grid .tile.is-focused')).borderTopColor);
    assert(/255, 255, 255(, 1)?\)/.test(border), c.name + ': the focused tile lost its border: ' + border);
    await page.keyboard.press('ArrowRight');
    // Stagger: items just show.
    const items = await openEntertainment(page);
    assert(items.length && items.every((s) => !s.opacity && !s.transform), c.name + ': items moved: ' + JSON.stringify(items[0]));
    // Bloom: nothing.
    await launchFirstApp(page);
    await sleep(150);
    x = await extras(page);
    const bloomLoud = await page.evaluate(() => document.querySelectorAll('.fx-ring, .fx-fly, .fx-bloom, .fx-chip, .fx-edge').length);
    assert(!bloomLoud, c.name + ': a bloom: ' + JSON.stringify(x));
    await page.keyboard.press('Escape');
    await idle(page);
    await sleep(300);
    // A new to-do: the row just shows.
    const id = await postTodo(pi, 'Slow ' + c.name);
    await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
    await sleep(100);
    const row = await page.evaluate((i) => { const r = document.querySelector('.todo-tile-row[data-id="' + i + '"]'); return { o: r.style.opacity, t: r.style.transform }; }, id);
    x = await extras(page);
    // The accent edge stays, but as a still border: no lap, nothing animating.
    const edge = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.fx-accent'), (n) => {
      const cs = getComputedStyle(n);
      return { sweep: !!n.querySelector('.fx-accent-sweep, .fx-lap'), anim: cs.animationName, tr: n.style.transition, opacity: cs.opacity };
    }));
    assert(edge.every((e) => !e.sweep && (e.anim === 'none' || !e.anim) && (!e.tr || e.tr === 'none')), c.name + ': the accent edge moved: ' + JSON.stringify(edge));
    assert(x.nodes === edge.length && !row.o && !row.t, c.name + ': the new row moved: ' + JSON.stringify({ x, row }));
    // Cover: no flight to the card.
    await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await idle(page);
    await until(() => page.evaluate(() => !!document.querySelector('.panel .np-page [data-share]')), 4000, 'no cover on the page');
    await page.evaluate(() => { document.querySelector('.panel-btn').click(); });
    await sleep(120);
    x = await extras(page);
    // (the still accent edge from the to-do above may still show)
    const still = await page.evaluate(() => document.querySelectorAll('.fx-accent').length);
    assert(x.nodes === still, c.name + ': the cover flew: ' + JSON.stringify(x));
    await idle(page);
    const about = await page.evaluate(() => { window.HUB_TEST.about.close(); return true; });
    assert(about, 'about');
    noErrors(page);
    await page.context().close();
  }
}

async function checkQuiet(pi) {
  for (const lang of ['en', 'es']) {
    // The Pi can't be reached (config.js's address is blocked here): waiting tiles.
    const page = await open({ live: 'x=1', init: lang === 'es' ? SPANISH_INIT : undefined });
    await sleep(600);
    const info = await page.evaluate(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const out = { dormant: [], loud: [], problems: [] };
      document.querySelectorAll('#grid .cell').forEach((cell) => {
        const id = cell.getAttribute('data-widget');
        const tile = cell.querySelector('.tile');
        (tile.classList.contains('is-dormant') ? out.dormant : out.loud).push(id);
        if (!tile.classList.contains('is-dormant')) return;
        const body = tile.querySelector('.tile-body');
        const T = tile.getBoundingClientRect();
        body.querySelectorAll('*').forEach((e) => {
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height || cs.visibility === 'hidden') return;
          const own = Array.prototype.some.call(e.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
          if (/(cal|aw|planned)-mark|np-art/.test(e.className) && !/is-solo/.test(e.className)) out.problems.push(id + ': a big mark shows (' + e.className + ')');
          if (!own) return;
          const fs = parseFloat(cs.fontSize);
          const lh = parseFloat(cs.lineHeight) / fs;
          if (fs > 1.05 * rem) out.problems.push(id + ': text ' + (fs / rem).toFixed(2) + 'rem: ' + e.textContent.slice(0, 30));
          if (fs < 0.85 * rem - 0.05) out.problems.push(id + ': text too small ' + (fs / rem).toFixed(2) + 'rem');
          if (lh < 1.25) out.problems.push(id + ': line height ' + lh.toFixed(2));
          if (/hub-quiet-line|planned-text/.test(e.className)) {
            if (r.height > fs * 1.9) out.problems.push(id + ': more than one line (' + Math.round(r.height) + ' px)');
            if (cs.textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 1) out.problems.push(id + ': cut without "…"');
            // Room for accents: the line box is at least the line height, and the glyphs sit inside the tile.
            if (e.clientHeight + 0.5 < parseFloat(cs.lineHeight)) out.problems.push(id + ': the line box is shorter than its line height');
          }
          if (r.left < T.left - 1 || r.right > T.right + 1 || r.top < T.top - 1 || r.bottom > T.bottom + 1) out.problems.push(id + ': sticks out of the tile');
        });
      });
      return out;
    });
    const want = ['ambiance', 'awws', 'calendar', 'mirror', 'nowplaying'];
    assert(JSON.stringify(info.dormant.sort()) === JSON.stringify(want), lang + ': quiet tiles ' + JSON.stringify(info.dormant));
    assert(!info.problems.length, lang + ': ' + info.problems.join(' | '));
    if (lang === 'es') {
      const t = await page.evaluate(() => document.querySelector('.cell[data-widget="calendar"] .hub-quiet-line').textContent);
      assert(/Raspberry/.test(t), 'the Spanish words did not reach the calendar: ' + t);
    }
    noErrors(page);
    await page.context().close();
  }
  // With the Pi: tiles with real data are not quiet.
  const page = await open({ pi: pi });
  await until(() => page.evaluate(() => {
    const t = document.querySelector('.cell[data-widget="nowplaying"] .tile');
    return t && !t.classList.contains('is-dormant');
  }), 6000, 'Now Playing stayed quiet with a song');
  const d = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.tile.is-dormant'), (t) => t.parentNode.getAttribute('data-widget')).sort());
  assert(JSON.stringify(d) === JSON.stringify(['ambiance', 'mirror']) || JSON.stringify(d) === JSON.stringify(['ambiance', 'calendar', 'mirror']) ||
    JSON.stringify(d) === JSON.stringify(['ambiance', 'awws', 'calendar', 'mirror']) || JSON.stringify(d) === JSON.stringify(['ambiance', 'awws', 'mirror']),
    'quiet with the Pi: ' + JSON.stringify(d));
  noErrors(page);
}

async function ringRect(page) {
  return page.evaluate(() => {
    const r = document.querySelector('.fx-ring');
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height, transition: r.style.transition, opacity: getComputedStyle(r).opacity };
  });
}

function same(a, b, slack) {
  slack = slack || 1;
  return !!a && !!b && Math.abs(a.left - b.left) <= slack && Math.abs(a.top - b.top) <= slack &&
    Math.abs(a.width - b.width) <= slack && Math.abs(a.height - b.height) <= slack;
}

async function checkRing(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  let r = await ringRect(page);
  let want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(same(r, want), 'the ring is not on the focused tile at start: ' + JSON.stringify({ r, want }));
  const border = await page.evaluate(() => getComputedStyle(document.querySelector('#grid .tile.is-focused')).borderTopColor);
  assert(!/^rgb\(255, 255, 255\)$/.test(border), 'the tile still draws its own white border under the ring: ' + border);
  // A press glides (190 ms), ending on the new tile.
  await page.keyboard.press('ArrowLeft');
  r = await ringRect(page);
  assert(/transform 190ms/.test(r.transition), 'no glide: ' + r.transition);
  await sleep(320);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert((await focused(page)) === 'nowplaying' && same(r, want), 'after the glide: ' + JSON.stringify({ r, want }));
  // A held key jumps (no motion for repeats).
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.up('ArrowUp');
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(r.transition === 'none' && same(r, want), 'a held key glided: ' + JSON.stringify({ r, want }));
  // Back to Entertainment, then the layout switches under it.
  await page.evaluate(() => { const t = document.querySelector('.cell[data-widget="entertainment"] .tile'); t.click(); });
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  await sleep(100);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(r && r.opacity === '1' && same(r, want), 'the ring after a panel: ' + JSON.stringify({ r, want }));
  await control(pi, 'POST', '/api/layout', { layout: SWAPPED });
  await until(() => page.evaluate(() => window.HUB_TEST.homeRects().weather.left < 200), 4000, 'the layout did not switch');
  await sleep(80);
  await page.keyboard.press('ArrowLeft');
  await sleep(320);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.homeRects().weather);
  assert((await focused(page)) === 'weather' && same(r, want), 'the ring after the layout switch: ' + JSON.stringify({ r, want }));
  // The window changes size: the ring follows the tile.
  await page.setViewportSize({ width: 1280, height: 720 });
  await sleep(450);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(want.width < 600 && same(r, want), 'the ring after a resize: ' + JSON.stringify({ r, want }));
  await control(pi, 'POST', '/api/layout', { layout: null });
  noErrors(page);
}

async function checkStagger(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  const seen = await openEntertainment(page);
  assert(seen.length > 5, 'too few samples');
  const first = seen[0];
  assert(parseFloat(first.shownOpacity) < 0.05, 'the first item was not hidden at the start: ' + JSON.stringify(first));
  // From the tile's side: Entertainment sits below the panel, so the items rise from 50px lower.
  const rise = /^matrix\(0\.85, 0, 0, 0\.85, 0, 50\)$/.test(first.shownTransform);
  assert(rise, 'the items do not come from below: ' + JSON.stringify(seen.slice(0, 2)));
  const any = seen.some((s) => /ms/.test(s.lastTransition || ''));
  assert(any, 'no transitions on the items: ' + JSON.stringify(seen.slice(0, 3)));
  const last = await page.evaluate(() => {
    const items = document.querySelectorAll('.panel .ent-item');
    return { n: items.length, styled: Array.prototype.filter.call(items, (i) => i.style.transition || i.style.opacity || i.style.transform).length };
  });
  assert(last.styled === 0, 'items still styled after 1 s: ' + JSON.stringify(last));
  // The longest delay keeps the whole stagger within 500 ms.
  const delayOf = (t) => { const m = /transform 260ms cubic-bezier\([^)]*\) ([\d.]+)ms/.exec(t || ''); return m ? parseFloat(m[1]) : 0; };
  const minDelay = delayOf(seen[0].transition);
  const maxDelay = Math.max.apply(null, seen.map((s) => {
    const m = /transform 260ms cubic-bezier\([^)]*\) ([\d.]+)ms/.exec(s.lastTransition || '');
    return m ? parseFloat(m[1]) : 0;
  }));
  // From the first item starting to the last one in: at most 500 ms.
  assert(maxDelay > minDelay && maxDelay - minDelay + 260 <= 500, 'the stagger runs long: delays ' + minDelay + ' to ' + maxDelay + ' ' + JSON.stringify(seen.slice(0, 2)));
  noErrors(page);
}

async function checkNewTodo(pi) {
  // A to-do that a sync brings just shows its row: no element, class or style is added.
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await sleep(300);
  const look = () => page.evaluate(() => ({
    // The accent edge (motionFx.edge) stays about a minute by design: checked on its own.
    fx: Array.prototype.filter.call(document.querySelectorAll('[class*="fx-"]'), (n) => !n.closest('.fx-accent')).map((n) => n.className).sort().join(' | '),
    tile: document.querySelector('.cell[data-widget="todo"] .tile').className,
    styles: document.querySelectorAll('style').length
  }));
  const before = await look();
  const id = await postTodo(pi, 'Write to the library ' + Date.now());
  await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
  for (let k = 0; k < 6; k++) {
    const row = await page.evaluate((i) => { const r = document.querySelector('.todo-tile-row[data-id="' + i + '"]'); return { o: r.style.opacity, t: r.style.transform, tr: r.style.transition }; }, id);
    assert(!row.o && !row.t && !row.tr, 'the new row moved: ' + JSON.stringify(row));
    await sleep(120);
  }
  // The activity chip (checks 9 to 15) goes by itself; nothing is left.
  await until(() => page.evaluate(() => !document.querySelector('.fx-chip, .fx-edge')), 4000, 'the chip stayed');
  const after = await look();
  assert(after.fx === before.fx && after.tile === before.tile && after.styles === before.styles, 'something was left: ' + JSON.stringify({ before, after }));
  noErrors(page);
}

async function checkCover(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
  await idle(page);
  await until(() => page.evaluate(() => !!document.querySelector('.panel .np-page [data-share]')), 5000, 'no cover on the page');
  await page.evaluate(() => { document.querySelector('.panel-btn').click(); });
  await until(() => page.evaluate(() => !!document.querySelector('.fx-fly')), 1500, 'the cover did not fly');
  const mid = await page.evaluate(() => {
    const f = document.querySelector('.fx-fly');
    const d = document.querySelector('.panel [data-share]');
    return { t: f.style.transition, hidden: d && d.style.visibility, compact: !!document.querySelector('.np-card') };
  });
  assert(/transform 520ms/.test(mid.t) && mid.hidden === 'hidden', 'flight: ' + JSON.stringify(mid));
  await sleep(700);
  const after = await page.evaluate(() => {
    const d = document.querySelector('.panel [data-share]');
    const r = d.getBoundingClientRect();
    return { fly: !!document.querySelector('.fx-fly'), vis: d.style.visibility, left: r.left, top: r.top };
  });
  assert(!after.fly && after.vis === '' && after.left < 400 && after.top < 400, 'after the flight: ' + JSON.stringify(after));
  // And back.
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => !!document.querySelector('.fx-fly')), 1500, 'the cover did not fly back');
  const back = await page.evaluate(() => document.querySelector('.fx-fly').style.transition);
  assert(/transform 420ms/.test(back), 'back: ' + back);
  await sleep(600);
  assert(!(await page.evaluate(() => !!document.querySelector('.fx-fly'))), 'the copy stayed');
  noErrors(page);
}

async function checkBloom(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await page.evaluate(() => { window.HUB_CONFIG.widgets.entertainment.openMode = 'panel'; window.HUB_TEST.openPanel('entertainment'); });
  await idle(page);
  await sleep(600);
  await launchFirstApp(page);
  await sleep(30);
  const b = await page.evaluate(() => {
    const n = document.querySelector('.fx-bloom');
    if (!n) return null;
    const m = /scale\(([\d.]+)/.exec(n.style.transform);
    return { k: m ? parseFloat(m[1]) : 0, t: n.style.transition };
  });
  assert(b && b.k > 8 && /transform 480ms/.test(b.t), 'bloom: ' + JSON.stringify(b));
  await sleep(600);
  const cover = await page.evaluate(() => {
    const r = document.querySelector('.fx-bloom').getBoundingClientRect();
    return r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight;
  });
  assert(cover, 'the bloom does not cover the screen');
  await until(() => page.evaluate(() => !document.querySelector('.fx-bloom')), 4500, 'the bloom stayed');
  // An app that isn't on this TV (Peacock in the preview): no bloom.
  await page.evaluate(() => {
    const items = document.querySelectorAll('.panel .ent-item.is-missing');
    if (items[0]) items[0].click();
  });
  await sleep(100);
  assert(!(await page.evaluate(() => !!document.querySelector('.fx-bloom'))), 'a missing app bloomed');
  noErrors(page);
}

/* ---------- activity chips ---------- */

const chips = (page) => page.evaluate(() => window.__chips.slice());

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

async function calendarMode(pi, mode) {
  feeds.setMode(mode);
  await control(pi, 'POST', '/api/calendar/refresh', {});
}

// A new to-do, a calendar change and a changed snapshot, one after another.
async function everyKind(pi, tag) {
  await postTodo(pi, 'Activity ' + tag + ' ' + Date.now());
  await calendarMode(pi, feeds.mode() === 'empty' ? 'sample' : 'empty');
  await postSnapshot(pi, snapshotNow({ reach: Math.random() < 0.5 ? 'subscribers' : 'traffic', sentAt: undefined }));
}

async function checkActivityOff(pi) {
  // Only this switch off: the other extras still run (the ring is there).
  const page = await open({ pi: pi, query: 'motion=push', config: 'HUB_CONFIG.motionFx = { activity: false };' });
  await idle(page);
  await sleep(300);
  const st = await fx(page);
  assert(st.flags.activity === false && st.flags.ring === true, 'flags: ' + JSON.stringify(st.flags));
  assert(await page.evaluate(() => !!document.querySelector('.fx-ring')), 'the other extras went off too');
  await everyKind(pi, 'off');
  await sleep(1500);
  const c = await chips(page);
  const x = await page.evaluate(() => document.querySelectorAll('.fx-chip, .fx-edge').length);
  assert(!c.length && !x, 'a chip with activity off: ' + JSON.stringify(c));
  noErrors(page);
}

async function checkActivitySlow(pi) {
  for (const c of [{ name: 'fade', o: { query: 'motion=fade' } }, { name: 'measured slow (24 fps)', o: { slow: { mode: 'push', fps: 24 } } },
    { name: 'auto stepped down', o: { slow: { mode: 'expand', fps: 52 } } }]) {
    const page = await open(Object.assign({ pi: pi }, c.o));
    await idle(page);
    await sleep(300);
    const id = await postTodo(pi, 'Slow chip ' + Date.now());
    await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
    await calendarMode(pi, feeds.mode() === 'empty' ? 'sample' : 'empty');
    await postSnapshot(pi, snapshotNow({ reach: 'subscribers' }));
    await sleep(1500);
    const seen = await chips(page);
    assert(!seen.length, c.name + ': chips: ' + JSON.stringify(seen));
    noErrors(page);
    await page.context().close();
  }
}

async function checkActivityFirst(pi) {
  // The Pi already has a to-do, events and a snapshot this TV has never seen:
  // the first data after the start is no news.
  await postTodo(pi, 'Already on the Pi ' + Date.now());
  await calendarMode(pi, 'sample');
  await postSnapshot(pi, snapshotNow({ reach: 'both' }));
  const page = await open({ pi: pi, query: 'motion=push' });
  await until(() => page.evaluate(() => document.querySelectorAll('.todo-tile-row').length > 0), 5000, 'the first sync did not arrive');
  await sleep(2000);
  const seen = await chips(page);
  assert(!seen.length, 'chips for the first data: ' + JSON.stringify(seen));
  // The TV restarts while everything changes on the Pi: its own saved copies
  // are old, but the first data after the start is still no news.
  const url = page.url();
  await page.goto('about:blank');
  await everyKind(pi, 'while away');
  await sleep(600);
  await page.goto(url);
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'not live after the restart');
  await sleep(2000);
  const again = await chips(page);
  assert(!again.length, 'chips after a restart: ' + JSON.stringify(again));
  noErrors(page);
}

async function checkActivitySame(pi) {
  await postTodo(pi, 'To rename later ' + Date.now());
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await sleep(600);
  const snap = snapshotNow({ reach: 'both' });
  await postSnapshot(pi, snap);
  await sleep(600);
  // (If that one was news, its chip goes first: one chip per tile.)
  await until(() => page.evaluate(() => !document.querySelector('.fx-chip')), 4000, 'a chip stayed');
  await page.evaluate(() => { window.__chips = []; });
  const revs = await page.evaluate(() => ({ cal: window.HUB_LIVE.rev('calendar'), awws: window.HUB_LIVE.rev('awws'), todo: window.HUB_LIVE.rev('todo') }));
  // The same snapshot sent again (a new sentAt), the calendars read again
  // unchanged, an empty change list for the to-dos, and a to-do that is only
  // ticked done (from the Pi, not this TV): no chip.
  const again = JSON.parse(JSON.stringify(snap));
  again.sentAt = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  await postSnapshot(pi, again);
  await control(pi, 'POST', '/api/calendar/refresh', {});
  await control(pi, 'POST', '/api/todo/ops', { ops: [] });
  const list = await control(pi, 'GET', '/api/todo');
  const items = (list && (list.items || (list.data && list.data.items))) || [];
  const open1 = items.filter((i) => !i.done)[0];
  if (open1) await control(pi, 'POST', '/api/todo/ops', { ops: [{ op: 'set', id: open1.id, fields: { done: true } }] });
  // (The hub server pushes the unchanged snapshot again; unchanged calendars
  // and to-dos it doesn't push at all, so only those two can be watched.)
  await until(() => page.evaluate((r) => window.HUB_LIVE.rev('awws') > r.awws, revs), 5000, 'the snapshot did not arrive again');
  assert(open1, 'no open to-do to tick');
  await until(() => page.evaluate((r) => window.HUB_LIVE.rev('todo') > r.todo, revs), 4000, 'the ticked to-do did not arrive');
  await sleep(1200);
  const seen = await chips(page);
  assert(!seen.length, 'chips for unchanged data: ' + JSON.stringify(seen));
  // And the other way round: changed events and a changed snapshot each say so, in their own tile.
  await calendarMode(pi, feeds.mode() === 'empty' ? 'sample' : 'empty');
  await until(async () => (await chips(page)).some((c) => c.w === 'calendar'), 4000, 'no chip for changed events');
  const changed = JSON.parse(JSON.stringify(snap));
  changed.reach = awwsSample.reach('subscribers');
  changed.sentAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await postSnapshot(pi, changed);
  await until(async () => (await chips(page)).some((c) => c.w === 'awws'), 4000, 'no chip for a changed snapshot');
  const both = await chips(page);
  assert(both.length === 2 && both.filter((c) => c.w === 'calendar' && c.text === 'Updating calendar').length === 1 &&
    both.filter((c) => c.w === 'awws' && c.text === 'Syncing data').length === 1, 'chips: ' + JSON.stringify(both));
  noErrors(page);
}

async function checkActivityTodoEdit(pi) {
  // A to-do with notes already on the Pi: the first list is no news.
  const r = await control(pi, 'POST', '/api/todo', { title: 'Edited later ' + Date.now(), section: 'now' });
  const id = r && (r.item ? r.item.id : r.id);
  assert(id, 'no id for the to-do: ' + JSON.stringify(r));
  await control(pi, 'POST', '/api/todo/ops', { ops: [{ op: 'set', id: id, fields: { notes: 'First note' } }] });
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 5000, 'the to-do did not arrive');
  await sleep(1500);
  assert(!(await chips(page)).length, 'a chip for the first list: ' + JSON.stringify(await chips(page)));
  const rev = () => page.evaluate(() => window.HUB_LIVE.rev('todo'));
  // Its notes change on the Pi: one chip, in the To-do tile.
  let before = await rev();
  await control(pi, 'POST', '/api/todo/ops', { ops: [{ op: 'set', id: id, fields: { notes: 'Second note' } }] });
  await until(async () => (await rev()) > before, 4000, 'the changed notes did not arrive');
  await until(async () => (await chips(page)).length > 0, 3000, 'no chip for changed notes');
  await sleep(1500);
  let seen = await chips(page);
  assert(seen.length === 1 && seen[0].w === 'todo', 'chips for changed notes: ' + JSON.stringify(seen));
  await until(() => page.evaluate(() => !document.querySelector('.fx-chip')), 4000, 'the chip stayed');
  await page.evaluate(() => { window.__chips = []; });
  // The same list again (an empty change list): none.
  await control(pi, 'POST', '/api/todo/ops', { ops: [] });
  await sleep(1500);
  assert(!(await chips(page)).length, 'a chip for an unchanged list: ' + JSON.stringify(await chips(page)));
  // Only ticked done on the Pi: none.
  before = await rev();
  await control(pi, 'POST', '/api/todo/ops', { ops: [{ op: 'set', id: id, fields: { done: true } }] });
  await until(async () => (await rev()) > before, 4000, 'the tick did not arrive');
  await sleep(1500);
  assert(!(await chips(page)).length, 'a chip for a tick: ' + JSON.stringify(await chips(page)));
  await control(pi, 'POST', '/api/todo/ops', { ops: [{ op: 'remove', id: id }] });
  noErrors(page);
  await page.context().close();
}

async function checkLightStepped(pi) {
  // Auto stepped down from push to expand, but the screen measured 71 fps:
  // the heavy extras stay off, the chips and the edge's light still run.
  const page = await open({ pi: pi, slow: { mode: 'expand', fps: 71 } });
  await idle(page);
  const st = await fx(page);
  assert(st.speed === 'slow' && st.lightSpeed === 'ok', 'speeds: ' + JSON.stringify([st.speed, st.lightSpeed]));
  await page.keyboard.press('ArrowLeft');
  await sleep(60);
  assert(!(await page.evaluate(() => document.querySelectorAll('.fx-ring').length)), 'a ring after stepping down');
  const row = await page.evaluate(() => window.HUB_FX.statusText());
  assert(row === 'extras: chips and light only (slow screen)', 'the Motion row: ' + row);
  await page.evaluate(() => { window.__chips = []; });
  await postTodo(pi, 'Stepped down ' + Date.now());
  await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="todo"] .fx-chip')), 4000, 'no chip after stepping down');
  const lit = await page.evaluate(() => ({ lap: !!document.querySelector('.cell[data-widget="todo"] .fx-edge'),
    accent: !!document.querySelector('.cell[data-widget="todo"] .fx-accent') }));
  assert(lit.lap && lit.accent, 'no light or edge: ' + JSON.stringify(lit));
  await until(() => page.evaluate(() => !document.querySelector('.fx-chip, .fx-edge')), 4000, 'the chip stayed');
  noErrors(page);
  await page.context().close();
  // Under 60 fps at expand it stays all off (check 2 covers 52 fps); in
  // Spanish the row says so too.
  const es = await open({ pi: pi, slow: { mode: 'expand', fps: 71 }, init: 'try { localStorage.setItem("homeHub.lang", "es"); } catch (e) {}' });
  const rowEs = await es.evaluate(() => window.HUB_FX.statusText());
  assert(rowEs === 'extras: solo avisos y luz (pantalla lenta)', 'the Motion row in Spanish: ' + rowEs);
  await es.context().close();
}

async function checkActivityTodo(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await sleep(400);
  const look = () => page.evaluate(() => {
    const out = { tiles: {}, body: document.body.className, styles: document.querySelectorAll('style').length, nodes: Array.prototype.filter.call(document.querySelectorAll('*'), (n) => !n.closest('.fx-accent')).length };
    document.querySelectorAll('#grid .cell').forEach((c) => {
      const t = c.querySelector('.tile');
      const r = t.getBoundingClientRect();
      // The accent edge stays after the chip by design (about a minute): not counted here.
      out.tiles[c.getAttribute('data-widget')] = { cls: t.className, style: t.getAttribute('style') || '', kids: t.querySelectorAll(':scope > :not(.fx-accent)').length,
        rect: [r.left, r.top, r.width, r.height].map(Math.round).join(',') };
    });
    return out;
  });
  const before = await look();
  const rowsBefore = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell[data-widget="todo"] .tile-head, .cell[data-widget="todo"] .tile-body'),
    (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }));
  const id = await postTodo(pi, 'Write to the library ' + Date.now());
  await until(() => page.evaluate(() => !!document.querySelector('.fx-chip.is-in')), 3000, 'no chip');
  await sleep(320);
  const mid = await page.evaluate(() => {
    const list = document.querySelectorAll('.fx-chip');
    const c = list[0];
    const cell = c.closest('.cell');
    const tile = cell.querySelector('.tile');
    const T = tile.getBoundingClientRect();
    const R = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    const ts = getComputedStyle(c.querySelector('.fx-chip-text'));
    const edge = tile.querySelector('.fx-edge');
    return { n: list.length, widget: cell.getAttribute('data-widget'), text: c.textContent, left: R.left - T.left, bottom: T.bottom - R.bottom,
      opacity: cs.opacity, fontPx: parseFloat(ts.fontSize), edge: !!edge, edgeAnim: edge ? Array.prototype.map.call(edge.querySelectorAll('i'), (n) => getComputedStyle(n).animationName).join(', ').split(', ').filter((v, i, a) => a.indexOf(v) === i).sort().join() : '' };
  });
  assert(mid.n === 1 && mid.widget === 'todo' && mid.text === 'Incoming to-do', 'the chip: ' + JSON.stringify(mid));
  assert(Math.abs(mid.left - 28) <= 4 && Math.abs(mid.bottom - 24) <= 4, 'not in the lower left (28px, 24px): ' + JSON.stringify(mid));
  assert(mid.fontPx >= 22 && mid.edge && mid.edgeAnim === 'fx-lap-bl-in,fx-lap-bl-out,fx-lap-br-in,fx-lap-br-out,fx-lap-off,fx-lap-tl-in,fx-lap-tl-out,fx-lap-tr-in,fx-lap-tr-out,fx-lap-x,fx-lap-y', 'text size or edge: ' + JSON.stringify(mid));
  // The new row just appears, and nothing in the tile moved for the chip.
  const row = await page.evaluate((i) => { const r = document.querySelector('.todo-tile-row[data-id="' + i + '"]'); return r && { o: r.style.opacity, t: r.style.transform, tr: r.style.transition }; }, id);
  assert(row && !row.o && !row.t && !row.tr, 'the new row moved: ' + JSON.stringify(row));
  const during = await look();
  for (const k of Object.keys(before.tiles)) {
    assert(during.tiles[k].rect === before.tiles[k].rect && during.tiles[k].cls === before.tiles[k].cls && during.tiles[k].style === before.tiles[k].style,
      'tile ' + k + ' changed: ' + JSON.stringify([before.tiles[k], during.tiles[k]]));
  }
  const rowsDuring = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell[data-widget="todo"] .tile-head, .cell[data-widget="todo"] .tile-body'),
    (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }));
  assert(rowsDuring[0] === rowsBefore[0], 'the tile head moved: ' + JSON.stringify([rowsBefore, rowsDuring]));
  assert(rowsDuring[1] === rowsBefore[1], 'the tile body moved: ' + JSON.stringify([rowsBefore, rowsDuring]));
  // Only the To-do tile: no other chip came.
  const st = await fx(page);
  assert(JSON.stringify(st.chips) === '["todo"]', 'chips now: ' + JSON.stringify(st.chips));
  // About 2.4 s, then a 150 ms fade, then gone, leaving nothing.
  await sleep(1500);
  assert(await page.evaluate(() => !!document.querySelector('.fx-chip.is-in')), 'the chip went too soon');
  await until(() => page.evaluate(() => !!document.querySelector('.fx-chip.is-out')), 1500, 'no fade out');
  const out = await page.evaluate(() => getComputedStyle(document.querySelector('.fx-chip.is-out')).transition);
  assert(/150ms ease-out/.test(out) || /0\.15s ease-out/.test(out), 'the fade out: ' + out);
  await until(() => page.evaluate(() => !document.querySelector('.fx-chip, .fx-edge')), 800, 'the chip stayed');
  const after = await look();
  const extraNodes = after.nodes - during.nodes;
  for (const k of Object.keys(before.tiles)) {
    const a = after.tiles[k];
    const b = before.tiles[k];
    assert(a.cls === b.cls && a.style === b.style && a.rect === b.rect && (k === 'todo' || a.kids === b.kids), 'tile ' + k + ' left changed: ' + JSON.stringify([b, a]));
  }
  assert(after.tiles.todo.kids === before.tiles.todo.kids, 'something left in the To-do tile');
  assert(after.body === before.body && after.styles === before.styles, 'body or styles changed: ' + JSON.stringify({ before: [before.body, before.styles], after: [after.body, after.styles] }));
  assert(extraNodes < 0, 'no fewer nodes after the chip went: ' + extraNodes);
  const seen = await chips(page);
  assert(seen.length === 1, 'chips seen: ' + JSON.stringify(seen));
  noErrors(page);
}

async function checkActivityClay(pi) {
  const page = await open({ pi: pi, query: 'motion=push', clay: true });
  await idle(page);
  await sleep(300);
  const started = await page.evaluate(() => {
    const K = window.HUB_TEST.clay;
    if (!K) return 'no clay';
    const names = K.scenes();
    for (let i = 0; i < names.length; i++) if (K.play(names[i], { seed: 3 })) return K.state().scene;
    return 'nothing played';
  });
  assert(started && !/^no|nothing/.test(started), 'no scene: ' + started);
  const id = await postTodo(pi, 'While they wander ' + Date.now());
  await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
  await postSnapshot(pi, snapshotNow({ reach: 'traffic' }));
  await sleep(500);
  const playing = await page.evaluate(() => window.HUB_TEST.clay.state().scene);
  assert(playing, 'the scene ended by itself before the check');
  const seen = await chips(page);
  assert(!seen.length, 'a chip during a scene: ' + JSON.stringify(seen));
  await page.evaluate(() => window.HUB_TEST.clay.stop());
  // With a panel open, also none (the home screen is covered).
  await page.evaluate(() => { window.HUB_CONFIG.widgets.entertainment.openMode = 'panel'; window.HUB_TEST.openPanel('entertainment'); });
  await idle(page);
  await postTodo(pi, 'Behind a panel ' + Date.now());
  await sleep(800);
  assert(!(await chips(page)).length, 'a chip behind a panel: ' + JSON.stringify(await chips(page)));
  noErrors(page);
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

async function checkActivityText(pi) {
  for (const k of KINDS) assert(typeof MOTION_ES[k] === 'string' && MOTION_ES[k], 'no Spanish in app/i18n.js for motion.activity.' + k);
  await control(pi, 'POST', '/api/layout', { layout: NARROW });
  try {
    // es: the Spanish from app/i18n.js (?lang=es); en: the English.
    for (const lang of ['es', 'en']) {
      const es = lang !== 'en';
      const page = await open({ pi: pi, query: 'motion=push' + (es ? '&lang=es' : ''), });
      await idle(page);
      await until(() => page.evaluate(() => { const r = window.HUB_TEST.homeRects(); return r.todo && r.todo.height < 200; }), 4000, 'the layout did not arrive');
      await sleep(300);
      const shown = await page.evaluate((kinds) => kinds.map((k) =>
        window.HUB_FX.activity(document.querySelector('.cell[data-widget="' + k + '"] .tile'), k)), KINDS);
      assert(shown.every(Boolean), lang + ': not every chip showed: ' + JSON.stringify(shown));
      await sleep(400);
      const info = await page.evaluate((kinds) => {
        function lum(c) {
          const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        }
        function rgba(s) { const m = s.match(/[\d.]+/g).map(Number); return { c: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; }
        return kinds.map((k) => {
          const tile = document.querySelector('.cell[data-widget="' + k + '"] .tile');
          const c = tile.querySelector('.fx-chip');
          const t = c.querySelector('.fx-chip-text');
          const cs = getComputedStyle(t);
          const T = tile.getBoundingClientRect();
          const R = c.getBoundingClientRect();
          const lh = parseFloat(cs.lineHeight);
          // Contrast over the worst backdrop: the chip's color over white and over black.
          const bg = rgba(getComputedStyle(c).backgroundColor);
          const fg = rgba(cs.color).c;
          const ratios = [255, 0].map((under) => {
            const mix = bg.c.map((x) => x * bg.a + under * (1 - bg.a));
            const a = lum(fg);
            const b = lum(mix);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
          return { k: k, text: t.textContent, cols: tile.parentNode.style.gridColumn || '', tileW: Math.round(T.width), chipW: Math.round(R.width),
            fits: t.scrollWidth <= t.clientWidth, lines: t.getBoundingClientRect().height / lh, boxOk: t.clientHeight + 0.5 >= lh, lh: lh / parseFloat(cs.fontSize),
            font: parseFloat(cs.fontSize), maxOk: R.width <= T.width - 56 + 1, inside: R.left >= T.left && R.right <= T.right && R.top >= T.top && R.bottom <= T.bottom,
            contrast: Math.min.apply(null, ratios), tileH: Math.round(T.height) };
        });
      }, KINDS);
      for (const i of info) {
        const where = lang + ' ' + i.k + ' (' + i.tileW + 'x' + i.tileH + ', "' + i.text + '")';
        assert(i.fits, where + ': cut with "…" (' + i.chipW + ' px)');
        assert(i.lines < 1.5 && i.boxOk && i.lh >= 1.3, where + ': not one roomy line: ' + JSON.stringify(i));
        assert(i.font >= 22, where + ': text ' + i.font + ' px');
        assert(i.maxOk && i.inside, where + ': wider than the tile minus 56 px, or outside it: ' + JSON.stringify(i));
        assert(i.contrast >= 4.5, where + ': contrast ' + i.contrast.toFixed(2));
      }
      if (lang === 'es') {
        for (const i of info) assert(i.text === MOTION_ES[i.k], 'the Spanish from app/i18n.js did not arrive for ' + i.k + ': ' + i.text);
      } else {
        assert(info.map((i) => i.text).join('|') === 'Incoming to-do|Updating calendar|Syncing data', 'the English: ' + info.map((i) => i.text).join('|'));
      }
      console.log('      ' + lang + ': ' + info.map((i) => i.k + ' ' + i.chipW + '/' + i.tileW + ' px, ' + i.contrast.toFixed(1) + ':1').join('; '));
      noErrors(page);
      await page.context().close();
    }

    // The language changes live (the Clock page's Language): a chip showing
    // then switches its words, and the next chip shows in the new language.
    const page = await open({ pi: pi, query: 'motion=push' });
    await idle(page);
    await sleep(300);
    const words = () => page.evaluate(() => { const t = document.querySelector('.cell[data-widget="todo"] .fx-chip-text'); return t ? t.textContent : null; });
    const show = (k) => page.evaluate((kind) => window.HUB_FX.activity(document.querySelector('.cell[data-widget="' + kind + '"] .tile'), kind), k);
    assert(await show('todo'), 'the first chip did not show');
    assert((await words()) === 'Incoming to-do', 'English first: ' + (await words()));
    await page.evaluate(() => window.HUB_I18N.setLang('es'));
    assert((await words()) === MOTION_ES.todo, 'the chip showing did not switch to Spanish: ' + (await words()));
    await until(() => page.evaluate(() => !document.querySelector('.fx-chip')), 4000, 'the chip stayed');
    assert(await show('calendar'), 'the chip after the change did not show');
    const cal = await page.evaluate(() => document.querySelector('.cell[data-widget="calendar"] .fx-chip-text').textContent);
    assert(cal === MOTION_ES.calendar, 'the next chip is not in Spanish: ' + cal);
    const about = await page.evaluate(() => window.HUB_FX.statusText());
    assert(about === I18N_ES['motion.extrasOn'], 'the Motion row in Spanish: ' + about);
    await page.evaluate(() => window.HUB_I18N.setLang('en'));
    assert((await page.evaluate(() => window.HUB_FX.statusText())) === 'extras on', 'the Motion row back in English');
    console.log('      live change: "Incoming to-do" -> "' + MOTION_ES.todo + '", next chip "' + cal + '"');
    noErrors(page);
    await page.context().close();
  } finally {
    await control(pi, 'POST', '/api/layout', { layout: null });
  }
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

  await check('1. Switches off (?fx=off, motionFx: false): no extra element or class, ever', () => checkOff(pi));
  await check('2. Fade mode, a slow TV and auto stepped down: every motion is off', () => checkDisabled(pi));
  await check('3. Waiting tiles are one quiet line, in English and Spanish; real data stays', () => checkQuiet(pi));
  await check('4. The ring: on the focused tile, glides, jumps on a held key, right after a layout switch and a resize', () => checkRing(pi));
  await check('5. Stagger: the items arrive from the tile side, all in within about 500 ms', () => checkStagger(pi));
  await check('6. A new to-do from a sync shows its row at once (no slide), nothing left afterwards', () => checkNewTodo(pi));
  await check('7. Cover: flies to the full-screen card and back', () => checkCover(pi));
  await check('8. Bloom: an app\'s icon fills the screen, and goes again', () => checkBloom(pi));
  await check('9. Activity chips: with their switch off, no chip (the other extras still run)', () => checkActivityOff(pi));
  await check('10. Activity chips: in fade mode, on a slow TV and after auto stepped down, no chip', () => checkActivitySlow(pi));
  await check('11. Activity chips: the first data after the hub starts (and after a reload) adds none', () => checkActivityFirst(pi));
  await check('12. Activity chips: a refetch with the same data, or a to-do only ticked done on the Pi, adds none (changed events and snapshot do)', () => checkActivitySame(pi));
  await check('13. Activity chips: a new to-do adds exactly one chip in the To-do tile, which goes by itself and leaves nothing', () => checkActivityTodo(pi));
  await check('14. Activity chips: none while the wanderers are on screen, or behind a panel', () => checkActivityClay(pi));
  await check('15. Activity chips: the Spanish from app/i18n.js fits one line in 3-column tiles (3x1, 3x2, 3x4), 22px+, 4.5:1; a language change applies live', () => checkActivityText(pi));
  await check('16. Motion timing: one stall does not step down, three janky runs do, a step-down lasts a day', () => checkDetection(pi));
  await check('16. Activity chips: a to-do whose notes change on the Pi adds one chip; the first list, an unchanged list and a tick add none', () => checkActivityTodoEdit(pi));
  await check('17. Auto stepped down to expand at 60 fps or more: chips, the accent edge and its light still run, the ring does not; the Motion row says so', () => checkLightStepped(pi));
  await check('18. A new build keeps a clean push (not a step-down); nothing is timed in the first minute after a load', () => checkSettle(pi));
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
