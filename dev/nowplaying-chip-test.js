/*
 * The "New song" chip (app/widgets/nowplaying.js, app/motion.js), end to
 * end: node dev/nowplaying-chip-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js),
 * the hub server from pi/ and the Spotify stand-in (dev/mock-spotify.js), on
 * spare ports with a fresh data folder, like dev/working-test.js. Songs change
 * the real way: the stand-in skips, the Pi notices and sends "nowplaying".
 *
 * Checks: no chip for the first data after the hub starts; a new song shows
 * one "New song" chip in the Now Playing tile (with the edge light), which
 * goes by itself; a pause, a resume and a seek show none; songs skipped fast
 * give at most one chip in about 8 s, and a song after that gives the next;
 * Spanish ("Canción nueva", from app/i18n.js) on one line at 22px+ in the
 * 3x2 and the 3x1 tiles; none under a panel or in fade mode; Guest mode
 * (which hides only money) does not stop it; "hub:working nowplaying" shows
 * no working chip; the kinds table names every kind, and the working rules
 * are the shared ones.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * NPCHIP_GREP=<text> runs only the checks whose name contains it. It needs
 * port 8095 free.
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

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

// The hub's Spanish table (app/i18n.js), read the way the TV runs it.
const I18N_ES = (function () {
  const ctx = { window: { location: { search: '' } }, document: { documentElement: { setAttribute() {} } }, location: { search: '' } };
  require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8'), ctx);
  return ctx.window.HUB_I18N.strings.es;
})();
const NEW_SONG_EN = 'New song';
const NEW_SONG_ES = 'Canción nueva';

// Notes every chip the page adds (window.__chips), every message (window.__toasts),
// and every activity the hub asks motion.js for (window.__acts).
const WATCH = '(function () { window.__chips = []; window.__toasts = []; window.__acts = []; function watch() {' +
  ' new MutationObserver(function (ms) { ms.forEach(function (m) {' +
  '  Array.prototype.forEach.call(m.addedNodes, function (n) {' +
  '   if (n.nodeType === 1 && /(^| )fx-chip( |$)/.test(n.className)) { var c = n.closest(".cell");' +
  '    window.__chips.push({ w: c && c.getAttribute("data-widget"), text: n.textContent, cls: n.className, t: Date.now() }); } });' +
  '  var t = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentNode);' +
  '  var toast = t && t.closest ? t.closest("#toast") : null;' +
  '  if (toast && toast.textContent && window.__toasts[window.__toasts.length - 1] !== toast.textContent) window.__toasts.push(toast.textContent);' +
  ' }); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });' +
  ' var tries = 0; (function wrap() { var F = window.HUB_FX; if (F && F.activity && !F.__wrapped) { var a = F.activity;' +
  '  F.activity = function (tile, kind) { window.__acts.push({ kind: kind, t: Date.now() }); return a.apply(this, arguments); }; F.__wrapped = true; return; }' +
  '  if (++tries < 400) setTimeout(wrap, 5); })();' +
  ' } if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch); })();';

let PAGE_PORT, PAGE, preview = null, browser = null, mock = null;
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
  if (process.env.NPCHIP_GREP && name.indexOf(process.env.NPCHIP_GREP) < 0) return;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-npchip-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    calendars: [], allowHttp: true,
    spotifyEnv: { SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback' },
    spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 300, idleMs: 300, awayMs: 300 }
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

async function setLayout(pi, layout) {
  const r = await control(pi, 'POST', '/api/layout', { layout: layout });
  assert(r && r.ok, 'the server refused the layout: ' + JSON.stringify(r));
}

/* ---------- pages ---------- */

// o: { pi, query, init (JS before the page) }
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
  await context.addInitScript(WATCH);
  if (o.init) await context.addInitScript(o.init);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(PAGE + '/hub.html?clay=off&live=' + encodeURIComponent(o.pi.url) + '&' + (o.query || 'motion=push'));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'the hub did not go live');
  await until(() => page.evaluate(() => { const d = window.HUB_LIVE.get('nowplaying'); return !!(d && d.track); }), 6000, 'no song arrived');
  await idle(page);
  await sleep(500);
  return page;
}

const idle = (page) => until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
const chipLog = (page) => page.evaluate(() => window.__chips.slice());
const actLog = (page) => page.evaluate(() => window.__acts.filter((a) => a.kind === 'nowplaying'));
const songNow = (page) => page.evaluate(() => { const d = window.HUB_LIVE.get('nowplaying'); return d && d.track ? d.track.id : ''; });
function noErrors(page) { assert(!page.errors.length, 'page errors: ' + page.errors.join(' | ')); }

const chipsNow = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.fx-chip'), (c) => {
  const cell = c.closest('.cell');
  return { w: cell && cell.getAttribute('data-widget'), text: c.textContent, working: c.classList.contains('fx-chip-working'),
    out: c.classList.contains('is-out'), edge: !!(cell && cell.querySelector('.fx-edge')) };
}));

// The stand-in skips to the next song; resolves once the TV has it.
async function skip(page) {
  const before = await songNow(page);
  mock.next();
  await until(async () => { const s = await songNow(page); return s && s !== before ? s : false; }, 4000, 'the next song did not reach the TV');
}

const noneLeft = (page, ms, text) => until(() => page.evaluate(() => !document.querySelector('.fx-chip')), ms, text);

/* ---------- the checks ---------- */

async function check1(pi) {
  mock.set('playing'); mock.reset();
  await sleep(700);
  const page = await open({ pi: pi });
  // A few more pushes of the same song (the vibe, the position) after the first.
  await sleep(2500);
  assert(!(await chipLog(page)).length, 'a chip on the first data: ' + JSON.stringify(await chipLog(page)));
  assert(!(await actLog(page)).length, 'an activity asked for on the first data: ' + JSON.stringify(await actLog(page)));
  // A reload, with the song already held: still none.
  await page.reload();
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'not live after the reload');
  await sleep(2000);
  assert(!(await chipLog(page)).length, 'a chip after a reload: ' + JSON.stringify(await chipLog(page)));
  noErrors(page);
}

async function check2(pi) {
  mock.set('playing'); mock.reset();
  await sleep(700);
  const page = await open({ pi: pi });
  const kidsBefore = await page.evaluate(() => document.querySelector('.cell[data-widget="nowplaying"] .tile').children.length);
  await skip(page);
  const c = await until(async () => (await chipsNow(page)).filter((x) => x.w === 'nowplaying' && !x.out)[0] || false, 3000, 'no chip for the new song');
  assert(c.text === NEW_SONG_EN && !c.working && c.edge, 'the chip: ' + JSON.stringify(c));
  const ico = await page.evaluate(() => {
    const n = document.querySelector('.cell[data-widget="nowplaying"] .fx-chip .fx-act-note');
    return n ? getComputedStyle(n).animationName : '';
  });
  assert(ico === 'fx-act-note', 'the note does not move: ' + ico);
  assert((await chipsNow(page)).length === 1, 'chips: ' + JSON.stringify(await chipsNow(page)));
  await noneLeft(page, 4000, 'the chip stayed');
  const kids = await page.evaluate(() => Array.prototype.filter.call(document.querySelector('.cell[data-widget="nowplaying"] .tile').children,
    (n) => !n.classList.contains('fx-accent')).length);
  assert(kids === kidsBefore, 'something left in the tile: ' + kidsBefore + ' -> ' + kids);
  assert((await chipLog(page)).length === 1 && (await actLog(page)).length === 1, 'chips added: ' + JSON.stringify(await chipLog(page)));
  noErrors(page);
}

async function check3(pi) {
  mock.set('playing'); mock.reset();
  await sleep(700);
  const page = await open({ pi: pi });
  const state = () => page.evaluate(() => (window.HUB_LIVE.get('nowplaying') || {}).state);
  mock.set('paused');
  await until(async () => (await state()) === 'paused', 4000, 'the pause did not reach the TV');
  await sleep(800);
  mock.set('playing');
  await until(async () => (await state()) === 'playing', 4000, 'the resume did not reach the TV');
  await sleep(800);
  const rev = await page.evaluate(() => window.HUB_LIVE.rev('nowplaying'));
  mock.seek(150000);
  await until(() => page.evaluate((r) => window.HUB_LIVE.rev('nowplaying') > r && (window.HUB_LIVE.get('nowplaying').progressMs || 0) > 140000, rev), 4000, 'the seek did not reach the TV');
  await sleep(1200);
  assert(!(await chipLog(page)).length, 'a chip on a pause, resume or seek: ' + JSON.stringify(await chipLog(page)));
  assert(!(await actLog(page)).length, 'an activity on a pause, resume or seek: ' + JSON.stringify(await actLog(page)));
  noErrors(page);
}

async function check4(pi) {
  mock.set('playing'); mock.reset();
  await sleep(700);
  const page = await open({ pi: pi });
  const t0 = Date.now();
  await skip(page);
  await until(async () => (await chipsNow(page)).length === 1, 3000, 'no chip for the first skip');
  await skip(page);
  await sleep(600);
  // The first chip has gone well before 8 s: further skips still show none.
  await noneLeft(page, 4000, 'the first chip stayed');
  await skip(page);
  await sleep(800);
  await skip(page);
  await sleep(600);
  const mid = Date.now() - t0;
  assert(mid < 7600, 'the skips took too long to test the limit: ' + mid + ' ms');
  assert((await chipLog(page)).length === 1, 'more than one chip within 8 s: ' + JSON.stringify(await chipLog(page)));
  assert((await actLog(page)).length === 1, 'more than one activity within 8 s: ' + JSON.stringify(await actLog(page)));
  // Past the 8 s: the next song shows the next chip.
  await sleep(Math.max(0, 8300 - (Date.now() - t0)));
  await skip(page);
  await until(async () => (await chipLog(page)).length === 2, 3000, 'no chip for a song after 8 s');
  const acts = await actLog(page);
  assert(acts.length === 2 && acts[1].t - acts[0].t >= 8000, 'the activities: ' + JSON.stringify(acts));
  noErrors(page);
}

// Now Playing as 3x2 (and To-do 3x1, for a short tile next to it).
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

async function chipFit(page) {
  return page.evaluate(() => {
    function lum(c) {
      const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    }
    function rgba(s) { const m = s.match(/[\d.]+/g).map(Number); return { c: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; }
    const tile = document.querySelector('.cell[data-widget="nowplaying"] .tile');
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
    return { text: t.textContent, tileW: Math.round(T.width), tileH: Math.round(T.height), chipW: Math.round(R.width),
      fits: t.scrollWidth <= t.clientWidth, lines: t.getBoundingClientRect().height / lh, boxOk: t.clientHeight + 0.5 >= lh,
      font: parseFloat(cs.fontSize), maxOk: R.width <= T.width - 56 + 1,
      inside: R.left >= T.left && R.right <= T.right && R.top >= T.top && R.bottom <= T.bottom, contrast: Math.min.apply(null, ratios) };
  });
}

async function check5(pi) {
  assert(I18N_ES['motion.activity.nowplaying'] === NEW_SONG_ES, 'app/i18n.js motion.activity.nowplaying: ' + I18N_ES['motion.activity.nowplaying']);
  const ES = 'try { localStorage.setItem("homeHub.lang", "es"); } catch (e) {}';
  const seen = [];
  for (const layout of [NARROW, null]) {
    await setLayout(pi, layout);
    try {
      for (const v of [{ name: 'Spanish', init: ES, want: NEW_SONG_ES }, { name: 'English', init: undefined, want: NEW_SONG_EN }]) {
        mock.set('playing'); mock.reset();
        await sleep(700);
        const page = await open({ pi: pi, init: v.init });
        const rows = layout ? 2 : 1;
        await until(() => page.evaluate((n) => { const r = window.HUB_TEST.homeRects(); return r.nowplaying && (n === 2 ? r.nowplaying.height > 250 : r.nowplaying.height < 200); }, rows),
          4000, 'the layout did not arrive');
        await sleep(300);
        await skip(page);
        await until(async () => (await chipsNow(page)).filter((x) => x.w === 'nowplaying').length === 1, 3000, 'no chip');
        await sleep(400);
        const i = await chipFit(page);
        const where = v.name + ' (' + i.tileW + 'x' + i.tileH + ', "' + i.text + '")';
        assert(i.text === v.want, where + ': not the words wanted (' + v.want + ')');
        assert(i.fits, where + ': cut (' + i.chipW + ' px)');
        assert(i.lines < 1.5 && i.boxOk, where + ': not one line: ' + JSON.stringify(i));
        assert(i.font >= 22, where + ': text ' + i.font + ' px');
        assert(i.maxOk && i.inside, where + ': wider than the tile minus 56 px, or outside it: ' + JSON.stringify(i));
        assert(i.contrast >= 4.5, where + ': contrast ' + i.contrast.toFixed(2));
        seen.push(v.name + ' 3x' + rows + ' ' + i.chipW + '/' + i.tileW + ' px');
        noErrors(page);
        await page.context().close();
      }
    } finally {
      await setLayout(pi, null);
    }
  }
  console.log('      ' + seen.join('; '));
}

async function check6(pi) {
  // Under a panel: no chip, then or after it closes (the edge light is the tile's to keep).
  mock.set('playing'); mock.reset();
  await sleep(700);
  let page = await open({ pi: pi });
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  await idle(page);
  await skip(page);
  await sleep(800);
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await idle(page);
  await sleep(1200);
  assert(!(await chipLog(page)).length, 'a chip under a panel: ' + JSON.stringify(await chipLog(page)));
  noErrors(page);
  await page.context().close();
  // Fade mode: none.
  mock.set('playing'); mock.reset();
  await sleep(700);
  page = await open({ pi: pi, query: 'motion=fade' });
  await skip(page);
  await sleep(1200);
  assert(!(await chipLog(page)).length, 'a chip in fade mode: ' + JSON.stringify(await chipLog(page)));
  noErrors(page);
  await page.context().close();
  // Guest mode hides only money: the song chip still shows (it names no song).
  mock.set('playing'); mock.reset();
  await sleep(700);
  page = await open({ pi: pi, init: 'try { localStorage.setItem("homeHub.guest.v1", "on"); } catch (e) {}' });
  assert(await page.evaluate(() => window.HUB_GUEST.on()), 'Guest mode is not on');
  await skip(page);
  const c = await until(async () => (await chipsNow(page)).filter((x) => x.w === 'nowplaying')[0] || false, 3000, 'no chip in Guest mode');
  assert(c.text === NEW_SONG_EN, 'the chip in Guest mode: ' + JSON.stringify(c));
  noErrors(page);
}

async function check7(pi) {
  mock.set('playing'); mock.reset();
  await sleep(700);
  const page = await open({ pi: pi });
  await say(pi, 'hub:working nowplaying');
  await say(pi, 'hub:working nowplaying 60');
  await sleep(1500);
  assert(!(await chipLog(page)).length, 'a working chip: ' + JSON.stringify(await chipLog(page)));
  assert(!(await page.evaluate(() => window.__toasts.length)), 'a message showed');
  const r = await page.evaluate(() => ({ w: window.HUB_FX.working('nowplaying', 30), st: window.HUB_FX.state(), rules: window.HUB_FX.rules(),
    todo: window.HUB_FX.working('todo', 30) }));
  assert(r.w === false && !r.st.working.filter((w) => w.kind === 'nowplaying').length, 'a nowplaying working state: ' + JSON.stringify(r.st.working));
  assert(r.todo === true, 'the to-do working chip no longer starts');
  const L = r.st.labels;
  assert(L.todo === 'Incoming to-do' && L.calendar === 'Updating calendar' && L.awws === 'Syncing data' && L.budget === 'Updating budget' &&
    L.nowplaying === NEW_SONG_EN, 'the kinds: ' + JSON.stringify(L));
  assert(r.rules.defaultS === 120 && r.rules.minS === 10 && r.rules.maxS === 900 && r.rules.settleMs === 1500, 'the rules: ' + JSON.stringify(r.rules));
  await page.evaluate(() => window.HUB_FX.workingDone('todo'));
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
  const pi = await startPi();

  await check('1. No chip for the first data after the hub starts (nor after a reload)', () => check1(pi));
  await check('2. A new song: one "New song" chip in the Now Playing tile with the edge light, which goes and leaves nothing', () => check2(pi));
  await check('3. A pause, a resume and a seek show no chip', () => check3(pi));
  await check('4. Songs skipped fast: at most one chip in 8 s; a song after that shows the next', () => check4(pi));
  await check('5. Spanish (app/i18n.js) and English on one line in the 3x2 and 3x1 tiles, 22px+, 4.5:1', () => check5(pi));
  await check('6. None under a panel or in fade mode; Guest mode does not stop it', () => check6(pi));
  await check('7. No working chip for nowplaying; the kinds table and the shared working rules', () => check7(pi));
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  for (const pi of pis) await new Promise((r) => pi.h.close(() => r()));
  try { if (mock) await mock.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
