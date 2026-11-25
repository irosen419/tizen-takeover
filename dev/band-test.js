/*
 * Ian and Ember on the Now Playing page (app/widgets/nowplaying-band.js):
 * node dev/band-test.js
 *
 * The real hub in headless Chromium, the real hub server from pi/ and the
 * Spotify stand-in (dev/mock-spotify.js), as in dev/nowplaying-test.js.
 * Checks: genres to outfits; the stage on full screen with the visualizer
 * (the outfit scene first, with its "Dressed for" chip in English and
 * Spanish, then band, singer and encore), every character inside the screen
 * and clear of the song card; any key sends them off; a pause too; the
 * corner on the expanded page never covers a word or a button; the off
 * switch; the stylesheet animates only transform and opacity and uses no
 * clip-path or filter; the files are ES5.
 *
 * SHOTS=/some/folder saves screenshots (1920x1080).
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
const mockHa = require('./mock-ha');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const SHOTS = process.env.SHOTS || '';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', '192.168.1.219'];

let PAGE_PORT, PAGE, preview = null, browser = null, mock = null, ha = null;
const pis = [];
const tmp = [];
const results = [];

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
    await sleep(60);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

async function check(name, fn) {
  if (process.env.NP_GREP && name.indexOf(process.env.NP_GREP) < 0) return;   // only some checks (while working on them)
  try { await fn(); results.push(true); console.log('ok   ' + name); }
  catch (e) { results.push(false); console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}

/* ---------- servers ---------- */

// withHa: the Pi also reads a pretend Home Assistant (dev/mock-ha.js), so
// "allsounds" has an Echo in it.
async function startPi(env, withHa) {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-np-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    spotifyEnv: env === 'off' ? {} : {
      SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret,
      SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback'
    },
    spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 },
    allsoundsEnv: withHa ? { HA_URL: ha.url, HA_TOKEN: ha.token } : {},
    allsounds: { allowHttp: true, manual: true, timeoutMs: 400 }
  });
  await h.ready;
  const pi = { h: h, port: port, url: 'http://127.0.0.1:' + port, dir: dir };
  pis.push(pi);
  if (env === 'signed-in') await signIn(pi);
  return pi;
}

function signIn(pi) {
  const l = pi.h.spotify.loginUrl();
  return new Promise((resolve, reject) => {
    http.get(l.url, (res) => { res.resume(); pi.h.spotify.finishLogin(res.headers.location || '').then(resolve, reject); }).on('error', reject);
  });
}

function stopPi(pi) {
  return new Promise((resolve) => {
    const i = pis.indexOf(pi);
    if (i >= 0) pis.splice(i, 1);
    pi.h.close(() => resolve());
  });
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

const ONLY = (w, h, x, y) => [{ widget: 'nowplaying', x: x || 0, y: y || 0, w: w, h: h }];

async function open(pi, layout, opts) {
  const o = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: o.locale || 'en-US' });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (BLOCKED.indexOf(u.hostname) >= 0) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await context.addInitScript((lay) => {
    try { localStorage.setItem('homeHub.layout', JSON.stringify(lay)); } catch (e) { /* ignore */ }
  }, layout);
  if (pi) await control(pi, 'POST', '/api/layout', { layout: layout });
  if (o.config) {
    // Changes HUB_CONFIG as the TV would get it from config.js.
    await context.route('**/config.js', async (route) => {
      const r = await route.fetch();
      route.fulfill({ response: r, body: (await r.text()) + '\n' + o.config + '\n' });
    });
  }
  if (o.unreadableArt) {
    // The tiny picture without permission for this page to read it (its
    // CORS header names another site; Playwright adds one of its own when
    // none is given).
    await context.route('**/art/*-64.svg', async (route) => {
      const r = await route.fetch();
      route.fulfill({ status: 200, headers: { 'content-type': 'image/svg+xml', 'access-control-allow-origin': 'http://another.invalid' }, body: await r.text() });
    });
  }
  await page.goto(PAGE + '/hub.html?live=' + (pi ? encodeURIComponent(pi.url) : 'off') + '&motion=' + (o.motion || 'fade') + (o.query || ''));
  await page.waitForSelector('.tile');
  return { page: page, context: context, errors: errors };
}


async function openPage(page) {
  await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 5000, 'the page did not open');
}
// The Visualizer button has the focus while a song plays: Enter opens full screen with it on.
async function openFull(page) {
  await openPage(page);
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page.is-full.np-card')), 6000, 'full screen with the card did not open');
}
const band = (page) => page.evaluate(() => window.HUB_NP_BAND.status());
// Skips the wait for a quiet remote and the time between visits.
const hurry = (page) => page.evaluate(() => window.HUB_NP_BAND.test.quiet());

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), type: name.endsWith('.png') ? 'png' : 'jpeg', quality: name.endsWith('.png') ? undefined : 88 });
}

// Every cast picture loaded, inside the screen; and the boxes it must not touch.
const layout = (page) => page.evaluate(() => {
  const layer = document.querySelector('.npb');
  if (!layer) return null;
  const R = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const cast = Array.prototype.map.call(layer.querySelectorAll('.npb-a'), (a) => {
    const img = a.querySelector('img');
    return { key: a.getAttribute('data-key'), box: R(a), ok: !!img && img.complete && img.naturalWidth > 0 };
  });
  const avoid = [];
  const card = document.querySelector('.np-page.np-card');
  if (card) avoid.push({ what: 'card', box: R(card) });
  else {
    document.querySelectorAll('.np-page .np-art, .np-page .np-chip, .np-page .np-viz-btn, .np-page .np-times, .np-page .np-bar, .np-page .np-title, .np-page .np-artist').forEach((n) => {
      if (n.offsetHeight) avoid.push({ what: n.className, box: R(n) });
    });
  }
  return { scene: layer.getAttribute('data-scene'), inPanel: !!layer.parentNode && layer.parentNode.id === 'panel', cast: cast, avoid: avoid,
    W: window.innerWidth, H: window.innerHeight, chip: (document.querySelector('.np-chip-band') || {}).textContent || '' };
});
const hit = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
function clear(L) {
  const bad = [];
  L.cast.forEach((c) => {
    if (!c.ok) bad.push(c.key + ' did not load');
    if (c.box.l < -1 || c.box.r > L.W + 1 || c.box.t < -1 || c.box.b > L.H + 1) bad.push(c.key + ' is off the screen ' + JSON.stringify(c.box));
    L.avoid.forEach((o) => { if (hit(c.box, o.box)) bad.push(c.key + ' covers ' + o.what); });
  });
  return bad;
}

async function main() {
  PAGE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  mock = await mockSpotify.start({});
  ha = await mockHa.start({ token: 'ha-test-token-not-a-secret' });
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PAGE_PORT, path: '/', timeout: 500 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  browser = await chromium.launch();
  const pi = await startPi('signed-in');
  const waitVibe = (page) => until(() => page.evaluate(() => { const s = window.HUB_NP_BAND.status(); return s.on && s.outfit !== undefined; }), 6000, 'no band info');

  await check('genres to outfits: order, artist list, nothing known', async () => {
    mock.reset();
    const s = await open(pi, ONLY(3, 2));
    const r = await s.page.evaluate(() => {
      const o = window.HUB_NP_BAND.outfit;
      return [o(['pop punk', 'rock']), o(['indie pop', 'nu disco']), o(['rock en espanol', 'alternative metal']), o(['country rock']),
        o(['hip hop', 'trap']), o(['folk', 'singer-songwriter']), o([]), o(null, 'Green Day', { 'green day': 'punk' }), o(['post-grunge'], 'X', { X: 'nope' })];
    });
    assert(JSON.stringify(r) === JSON.stringify(['punk', 'synth', 'rock', 'country', 'hiphop', '', '', 'punk', 'rock']), JSON.stringify(r));
    await s.context.close();
  });

  for (const lang of ['en', 'es']) {
    await check('stage (' + lang + '): the outfit scene comes first with its chip, then band, singer, encore; all on screen, clear of the card', async () => {
      mock.reset();
      mock.vibes('ok', 0);
      await control(pi, 'POST', '/api/spotify/refresh', {});
      const s = await open(pi, ONLY(3, 2), { motion: 'push', query: '&lang=' + lang });
      await openFull(s.page);
      await until(() => band(s.page).then((b) => b.mode === 'stage' && b.outfit === 'synth'), 8000, 'the stage with the synth outfit');
      await hurry(s.page);
      await until(() => band(s.page).then((b) => b.scene === 'outfit'), 15000, 'the outfit scene did not come');
      await sleep(900);
      let L = await layout(s.page);
      assert(L && L.inPanel, 'the layer is in the panel');
      const want = lang === 'es' ? 'Vestidos de synth-pop' : 'Dressed for synth-pop';
      assert(L.chip === want, 'chip: ' + L.chip);
      const chipOk = await s.page.evaluate(() => { const c = document.querySelector('.np-chip-band'); return !!c && c.offsetParent !== null && c.scrollWidth <= c.clientWidth + 1; });
      assert(chipOk, 'the chip shows whole');
      let bad = clear(L);
      assert(!bad.length, bad.join('; '));
      assert(L.cast.map((c) => c.key).join() === 'ian/fit-synth,ember/fit-synth', L.cast.map((c) => c.key).join());
      await shot(s.page, 'band-outfit-' + lang + '.jpg');
      if (lang === 'en') {
        const level = await s.page.evaluate(() => window.HUB_NP_VIZ.debug().level);
        for (const name of ['band', 'singer', 'encore']) {
          await s.page.evaluate((n) => window.HUB_NP_BAND.test.play(n), name);
          await until(() => band(s.page).then((b) => b.scene === name), 10000, name + ' did not play');
          await sleep(900);
          L = await layout(s.page);
          bad = clear(L);
          assert(!bad.length, name + ': ' + bad.join('; '));
          assert(L.chip === '', name + ': no outfit chip');
          const keys = L.cast.map((c) => c.key);
          if (name === 'encore') assert((keys.indexOf('band/bass') >= 0) === (level === 'radiant' || level === 'sharp'), 'backing band only at the rich levels: ' + level + ' ' + keys.join());
          await shot(s.page, 'band-' + name + '.jpg');
        }
      }
      await s.context.close();
    });
  }

  await check('any key sends them off at once; a pause too; they come back later', async () => {
    mock.reset();
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2), { motion: 'push' });
    await openFull(s.page);
    await until(() => band(s.page).then((b) => b.mode === 'stage'), 8000, 'stage');
    await hurry(s.page);
    await until(() => band(s.page).then((b) => !!b.scene), 15000, 'no visit');
    await s.page.keyboard.press('ArrowDown');
    await until(() => s.page.evaluate(() => !document.querySelector('.npb') && !document.querySelector('.np-chip-band')), 1500, 'still there after a key');
    let b = await band(s.page);
    assert(b.scene === '' && b.dueIn >= 30, 'the next visit waits: ' + JSON.stringify(b));
    await hurry(s.page);
    await until(() => band(s.page).then((x) => !!x.scene), 15000, 'no second visit');
    mock.set('paused');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(() => s.page.evaluate(() => !document.querySelector('.npb')), 6000, 'still there while paused');
    await hurry(s.page);
    await sleep(2500);
    b = await band(s.page);
    assert(b.scene === '', 'no visit while paused');
    mock.set('playing');
    await s.context.close();
  });

  await check('corner: the expanded page and full screen without the visualizer; never over a word or a button', async () => {
    mock.reset();
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2), { motion: 'push' });
    await openPage(s.page);
    await until(() => band(s.page).then((b) => b.mode === 'corner'), 6000, 'corner');
    for (const name of ['headphones', 'dance']) {
      await hurry(s.page);
      await s.page.evaluate((n) => window.HUB_NP_BAND.test.play(n), name);
      await until(() => band(s.page).then((b) => b.scene === name), 10000, name);
      await sleep(900);
      const L = await layout(s.page);
      const bad = clear(L);
      assert(!bad.length, name + ': ' + bad.join('; '));
      const inside = await s.page.evaluate(() => {
        const p = document.getElementById('panel').getBoundingClientRect();
        return Array.prototype.every.call(document.querySelectorAll('.npb-a'), (a) => { const r = a.getBoundingClientRect(); return r.left >= p.left && r.right <= p.right && r.bottom <= p.bottom + 1; });
      });
      assert(inside, name + ': inside the panel');
      await shot(s.page, 'band-corner-' + name + '.jpg');
    }
    await s.context.close();
  });

  await check('off: ?band=off and widgets.nowplaying.band false', async () => {
    for (const o of [{ query: '&band=off' }, { config: 'HUB_CONFIG.widgets.nowplaying.band = false;' }]) {
      mock.reset();
      const s = await open(pi, ONLY(3, 2), Object.assign({ motion: 'push' }, o));
      await openFull(s.page);
      await sleep(400);
      await s.page.evaluate(() => window.HUB_NP_BAND.test.quiet());
      await sleep(2500);
      const b = await band(s.page);
      assert(!b.on && !b.scene, JSON.stringify(o) + ': ' + JSON.stringify(b));
      await s.context.close();
    }
  });

  await check('the stylesheet animates only transform and opacity; no clip-path, no filter; the script is ES5', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'app/widgets/nowplaying-band.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const frames = css.match(/@keyframes[^{]+\{([^{}]*\{[^}]*\})*\s*\}/g) || [];
    assert(frames.length >= 7, 'keyframes found: ' + frames.length);
    frames.forEach((f) => {
      (f.match(/([a-z-]+)\s*:/g) || []).forEach((p) => { const n = p.replace(/\s*:$/, ''); assert(n === 'transform' || n === 'opacity', 'animates ' + n); });
    });
    assert(!/clip-path|filter\s*:|\bgap\s*:|display:\s*grid/.test(css), 'no clip-path, filter, gap or grid');
    const js = fs.readFileSync(path.join(ROOT, 'app/widgets/nowplaying-band.js'), 'utf8');
    assert(!/=>|\blet\s|\bconst\s|`|\bclass\s/.test(js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'ES5 only');
  });

  const ok = results.filter(Boolean).length;
  console.log(ok + ' passed, ' + (results.length - ok) + ' failed');
  return results.length - ok;
}

main().then((fails) => finish(fails ? 1 : 0), (e) => { console.log('FAIL ' + (e && e.stack || e)); finish(1); });

function finish(code) {
  try { if (preview) preview.kill(); } catch (e) { /* */ }
  Promise.all(pis.map((p) => new Promise((r) => p.h.close(() => r())))).then(() => {
    tmp.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* */ } });
    const done = () => process.exit(code);
    (browser ? browser.close() : Promise.resolve()).then(done, done);
    if (mock) mock.close();
    if (ha) ha.close();
  });
}
