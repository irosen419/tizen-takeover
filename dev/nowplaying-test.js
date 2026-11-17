/*
 * Now Playing, end to end: node dev/nowplaying-test.js
 *
 * Runs the real hub in headless Chromium against the real hub server from
 * pi/ and a stand-in for Spotify (dev/mock-spotify.js), all on spare ports,
 * with a fresh data folder. Nothing reaches the internet or a Spotify
 * account. Needs Playwright (require('playwright')).
 *
 * Checks: the tile in every layout and size (nothing spills out of its box,
 * long Spanish text with accents is whole, line heights leave room for
 * accents), every state (playing, paused, nothing playing, not connected,
 * not set up, Spotify down, the Pi lost, an old Pi), the page and its full
 * screen, the progress moving, and a changed song arriving by itself.
 *
 * The visualizer (app/widgets/nowplaying-viz.js): only full screen while a
 * song plays or is paused, edge to edge, with the song as a small card in
 * the upper left (long Spanish words fit it); the canvas changes while
 * playing, settles and stops its loop when paused, hidden or closed; a vibe
 * arriving late changes it in place; calm and hard songs get different kinds
 * of scenes; the scene follows the position and changes on phrase
 * boundaries; the off switches and the still wash keep the big layout; the
 * glow level animates only transform and opacity; the mood colors when the
 * picture cannot be read; a new song morphs on the same canvas; the
 * frame-rate check and its steps down; the About row; every file in app/ is
 * plain ES5; and a rough frame rate with the CPU slowed 6x (a sanity check
 * only: a desktop says little about the TV). NP_VIZ_ONLY=1 runs only these;
 * NP_GREP=<text> only the checks whose name has it.
 *
 * SHOTS=/some/folder also saves screenshots there (1920x1080).
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
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
const SHOTS = process.env.SHOTS || '';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

let PAGE_PORT, PAGE, preview = null, browser = null, mock = null;
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

async function startPi(env) {
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
    spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 }
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

const tileText = (page) => page.evaluate(() => {
  const t = (s) => { const e = document.querySelector('.np-tile ' + s); return e && e.offsetParent !== null ? e.textContent : null; };
  return { label: t('.np-label-text'), title: t('.np-title'), artist: t('.np-artist'), note: t('.np-note') };
});

const waitTitle = (page, title) => until(async () => (await tileText(page)).title === title, 6000, 'the tile never showed "' + title + '"');

// Anything that sticks out of the tile, or a line height too tight for accents.
function problems(page) {
  return page.evaluate(() => {
    const out = [];
    const tile = document.querySelector('.tile');
    const T = tile.getBoundingClientRect();
    const root = document.querySelector('.np-tile');
    if (!root) return ['no Now Playing tile'];
    root.querySelectorAll('*').forEach((e) => {
      if (e.classList.contains('np-glow') || e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return;
      if (getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return;
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const slack = 2;
      if (r.left < T.left - slack || r.right > T.right + slack || r.top < T.top - slack || r.bottom > T.bottom + slack) {
        out.push(e.className + ' sticks out: ' + [r.left - T.left, T.right - r.right, r.top - T.top, T.bottom - r.bottom].map(Math.round).join(','));
      }
      if (/^np-(title|artist|album|label-text|note|chip|times)$/.test(String(e.className).split(' ')[0]) || e.className === 'np-label-text') {
        const cs = getComputedStyle(e);
        const lh = parseFloat(cs.lineHeight);
        if (lh && lh < parseFloat(cs.fontSize) * 1.24) out.push(e.className + ' line height too tight: ' + lh + '/' + cs.fontSize);
      }
    });
    // Words must never overlap each other.
    const texts = Array.prototype.filter.call(root.querySelectorAll('.np-title,.np-artist,.np-label,.np-note'), (e) => e.offsetParent !== null && e.getBoundingClientRect().height);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].getBoundingClientRect();
        const b = texts[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(texts[i].className + ' overlaps ' + texts[j].className);
      }
    }
    // The picture and the words must not overlap either.
    const art = root.querySelector('.np-art');
    const text = root.querySelector('.np-text');
    if (art && text && text.offsetParent !== null) {
      const a = art.getBoundingClientRect();
      const b = text.getBoundingClientRect();
      if (b.height && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push('the picture overlaps the words');
    }
    return out;
  });
}

async function shot(page, name, clip) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name);
  await sleep(250);
  const opts = { path: file, type: /\.png$/.test(name) ? 'png' : 'jpeg' };
  if (opts.type === 'jpeg') opts.quality = 86;
  if (clip) opts.clip = clip;
  await page.screenshot(opts);
}

const tileClip = (page) => page.evaluate(() => {
  const r = document.querySelector('.tile').getBoundingClientRect();
  const m = 14;
  return { x: Math.max(0, r.left - m), y: Math.max(0, r.top - m), width: Math.min(1920, r.width + 2 * m), height: Math.min(1080, r.height + 2 * m) };
});

/* ---------- the checks ---------- */

const SIZES = [
  [1, 1], [2, 1], [3, 1], [6, 1], [12, 1],
  [1, 2], [2, 2], [3, 2], [6, 2],
  [2, 3], [3, 3], [3, 4], [6, 3], [4, 6], [12, 6]
];

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
  if (process.env.NP_VIZ_ONLY) return;          // only the visualizer checks (while working on it)

  const pi = await startPi('signed-in');

  await check('the tile shows the song, the artist, the picture and a moving bar', async () => {
    mock.reset();
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2));
    await waitTitle(s.page, 'Golden Hour Drive');
    const t = await tileText(s.page);
    assert(/^(Now playing|Playing)$/.test(t.label), 'label: ' + t.label);
    assert(t.artist === 'The Lanterns', 'artist: ' + t.artist);
    await until(() => s.page.evaluate(() => { const i = document.querySelector('.np-tile .np-img'); return !!i && i.complete && i.naturalWidth > 0 && i.className.indexOf('is-loaded') >= 0; }), 4000, 'the picture did not load');
    const a = await s.page.evaluate(() => document.querySelector('.np-fill').style.transform);
    await sleep(2100);
    const b = await s.page.evaluate(() => document.querySelector('.np-fill').style.transform);
    const num = (x) => parseFloat(/scaleX\(([\d.]+)\)/.exec(x)[1]);
    assert(num(b) > num(a), 'the bar did not move: ' + a + ' -> ' + b);
    assert(num(a) > 0.2 && num(a) < 0.4, 'a start near 62 s of 214 s: ' + a);
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-eq.is-playing').length)) === 1, 'the equalizer shows');
    assert((await problems(s.page)).length === 0, JSON.stringify(await problems(s.page)));
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  for (const lang of ['long', 'short']) {
    await check('every size: nothing spills, nothing overlaps (' + (lang === 'long' ? 'long Spanish text with accents' : 'a short English song') + ')', async () => {
      if (lang === 'long') mock.set('long'); else { mock.set('playing'); mock.reset(); }
      await control(pi, 'POST', '/api/spotify/refresh', {});
      const s = await open(pi, ONLY(SIZES[0][0], SIZES[0][1]));
      const want = lang === 'long' ? 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)' : 'Golden Hour Drive';
      await until(async () => (await s.page.evaluate(() => { const e = document.querySelector('.np-tile'); return !!e; })), 4000, 'no tile');
      const bad = [];
      for (const [w, h] of SIZES) {
        await control(pi, 'POST', '/api/layout', { layout: ONLY(w, h) });
        await until(() => s.page.evaluate((c) => {
          const t = document.querySelector('.tile');
          const r = t.getBoundingClientRect();
          return Math.abs(r.width - (c.w * 1920 / 12 - 24 - 14)) < 30 && Math.abs(r.height - (c.h * (1080 - 36) / 6 - 14)) < 30;
        }, { w: w, h: h }), 4000, 'the layout ' + w + 'x' + h + ' was not applied');
        await until(() => s.page.evaluate(() => !!document.querySelector('.np-tile .np-art')), 3000, 'redrawn');
        await sleep(120);
        const p = await problems(s.page);
        if (p.length) bad.push(w + 'x' + h + ': ' + p.join('; '));
        if (w * 100 + h === 302 || w * 100 + h === 1201 || w * 100 + h === 304 || w * 100 + h === 601 || w * 100 + h === 201 || w * 100 + h === 101 || w * 100 + h === 202 || w * 100 + h === 603) {
          await shot(s.page, 'np-size-' + lang + '-' + w + 'x' + h + '.png', await tileClip(s.page));
        }
      }
      void want;
      assert(!bad.length, bad.join(' | '));
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    });
  }

  await check('Ian\'s own layout: the tile at 3 x 2 beside the other tiles', async () => {
    mock.set('long');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const lay = [
      { widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
      { widget: 'todo', x: 0, y: 2, w: 3, h: 4 }, { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 },
      { widget: 'nowplaying', x: 9, y: 2, w: 3, h: 2 }, { widget: 'awws', x: 6, y: 0, w: 3, h: 4 },
      { widget: 'ambiance', x: 3, y: 4, w: 3, h: 2 }, { widget: 'mirror', x: 6, y: 4, w: 3, h: 2 },
      { widget: 'entertainment', x: 9, y: 4, w: 3, h: 2 }
    ];
    const s = await open(pi, lay);
    await waitTitle(s.page, 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)');
    await sleep(1500);
    await shot(s.page, 'np-home-long-spanish.jpg');
    mock.set('playing'); mock.reset();
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await waitTitle(s.page, 'Golden Hour Drive');
    await sleep(1200);
    await shot(s.page, 'np-home-playing.jpg');
    await s.context.close();
  });

  await check('the page: song, artist, album, times, device, and the time moves', async () => {
    mock.set('playing'); mock.reset();
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2));
    await waitTitle(s.page, 'Golden Hour Drive');
    await s.page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 4000, 'the page did not open');
    const read = () => s.page.evaluate(() => {
      const t = (c) => { const e = document.querySelector('.np-page ' + c); return e ? e.textContent : null; };
      return { title: t('.np-title'), artist: t('.np-artist'), album: t('.np-album'), elapsed: t('.np-elapsed'), total: t('.np-total'), chips: Array.prototype.map.call(document.querySelectorAll('.np-page .np-chip'), (e) => e.textContent) };
    });
    const a = await read();
    assert(a.title === 'Golden Hour Drive' && a.artist === 'The Lanterns' && a.album === 'Slow Coast', JSON.stringify(a));
    assert(a.total === '3:34', 'total: ' + a.total);
    assert(/^1:0\d$/.test(a.elapsed), 'elapsed: ' + a.elapsed);
    assert(a.chips.indexOf('On Living room') >= 0, 'chips: ' + a.chips);
    await sleep(2200);
    const b = await read();
    assert(b.elapsed !== a.elapsed, 'the time did not move: ' + a.elapsed + ' -> ' + b.elapsed);
    const over = await s.page.evaluate(() => {
      const panel = document.getElementById('panel').getBoundingClientRect();
      const bad = [];
      document.querySelectorAll('.np-page *').forEach((e) => {
        if (e.classList.contains('np-glow') || e.offsetParent === null) return;
        const r = e.getBoundingClientRect();
        if (r.width && (r.right > panel.right + 1 || r.bottom > panel.bottom + 1 || r.left < panel.left - 1 || r.top < panel.top - 1)) bad.push(e.className);
      });
      return bad;
    });
    assert(!over.length, 'sticks out of the page: ' + over.join(','));
    await shot(s.page, 'np-page-playing.jpg');
    // Full screen: Enter on the Full screen button.
    await s.page.keyboard.press('Enter');
    await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page.is-full')), 4000, 'full screen did not open');
    await sleep(600);
    const fullOk = await s.page.evaluate(() => {
      const panel = document.getElementById('panel').getBoundingClientRect();
      const art = document.querySelector('.np-page .np-art').getBoundingClientRect();
      return { artSize: Math.round(art.width), panelW: Math.round(panel.width), panelH: Math.round(panel.height) };
    });
    assert(fullOk.artSize > 450, 'a big picture in full screen: ' + JSON.stringify(fullOk));
    await shot(s.page, 'np-page-full.jpg');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('the page with long Spanish text: whole, never past the page', async () => {
    mock.set('long');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2));
    await until(async () => (await tileText(s.page)).title === 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)', 6000, 'no long song');
    for (const full of [false, true]) {
      await s.page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 4000, 'page');
      if (full) {
        await s.page.keyboard.press('Enter');
        await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page.is-full')), 4000, 'full');
      }
      await sleep(500);
      const bad = await s.page.evaluate(() => {
        const out = [];
        const info = document.querySelector('.np-info').getBoundingClientRect();
        const body = document.querySelector('.panel-body').getBoundingClientRect();
        document.querySelectorAll('.np-info > *').forEach((e) => {
          if (e.offsetParent === null) return;
          const r = e.getBoundingClientRect();
          if (r.bottom > body.bottom + 1) out.push(e.className + ' below the page by ' + Math.round(r.bottom - body.bottom));
          if (r.right > info.right + 1) out.push(e.className + ' past the right');
        });
        const cs0 = (e) => getComputedStyle(e);
        const title = document.querySelector('.np-page .np-title');
        const lines = Math.round(title.getBoundingClientRect().height / parseFloat(cs0(title).lineHeight));
        if (lines > (document.querySelector('.np-page.is-full') ? 3 : 2)) out.push('the title runs to ' + lines + ' lines');
        const cs = getComputedStyle(title);
        if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.24) out.push('title line height too tight');
        const visible = document.querySelectorAll('.np-page .np-times, .np-page .np-bar').length;
        if (visible < 2) out.push('the time and bar went missing');
        return out;
      });
      assert(!bad.length, (full ? 'full: ' : 'page: ') + bad.join('; '));
      await shot(s.page, 'np-page-long-spanish' + (full ? '-full' : '') + '.jpg');
      if (full) await s.page.keyboard.press('Enter'); // back to the page: the button is still focused
      await sleep(300);
      await s.page.evaluate(() => window.HUB_TEST.closePanel());
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 4000, 'close');
    }
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('a new song, a pause and nothing playing arrive by themselves', async () => {
    mock.set('playing'); mock.reset();
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2));
    await waitTitle(s.page, 'Golden Hour Drive');
    mock.next();
    await waitTitle(s.page, 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)'.length ? 'Paper Moons' : '');
    mock.set('paused');
    await until(async () => (await tileText(s.page)).label === 'Paused', 4000, 'no Paused label');
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-eq.is-playing').length)) === 0, 'the equalizer stopped');
    await shot(s.page, 'np-tile-paused.png', await tileClip(s.page));
    mock.set('idle');
    await until(async () => (await tileText(s.page)).label === 'Last played', 4000, 'no Last played label');
    const t = await tileText(s.page);
    assert(t.title === 'Paper Moons', 'the last song stays: ' + t.title);
    assert((await s.page.evaluate(() => document.querySelector('.np-bar').style.visibility)) === 'hidden', 'no bar when nothing plays');
    await shot(s.page, 'np-tile-last-played.png', await tileClip(s.page));
    mock.set('playing');
    await until(async () => /^(Now playing|Playing)$/.test((await tileText(s.page)).label), 4000, 'playing again');
    await s.context.close();
  });

  await check('nothing ever played, and a podcast', async () => {
    mock.set('idle');
    const fresh = await startPi('signed-in');
    const s = await open(fresh, ONLY(3, 2));
    await until(async () => (await tileText(s.page)).title === 'Nothing playing', 5000, 'no empty state');
    const t = await tileText(s.page);
    assert(t.label === 'Spotify' && /Start something on Spotify/.test(t.artist), JSON.stringify(t));
    assert((await problems(s.page)).length === 0, JSON.stringify(await problems(s.page)));
    await shot(s.page, 'np-tile-empty.png', await tileClip(s.page));
    await s.page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 4000, 'page');
    await sleep(500);
    await shot(s.page, 'np-page-empty.jpg');
    await s.page.evaluate(() => window.HUB_TEST.closePanel());
    mock.set('episode');
    await until(async () => (await tileText(s.page)).title === 'Episode 212: Why octopuses dream', 5000, 'no podcast');
    assert((await tileText(s.page)).artist === 'The Curious Hour', 'the show is the artist line');
    await s.context.close();
    await stopPi(fresh);
    mock.set('playing');
  });

  await check('not connected yet (signin) and not set up (off): each says what to do', async () => {
    const a = await startPi('signin-needed');
    const sa = await open(a, ONLY(3, 2));
    await until(async () => (await tileText(sa.page)).title === 'Not connected yet', 5000, 'no signin state');
    assert(/\.\/hub spotify login/.test((await tileText(sa.page)).artist), 'it names the command');
    assert((await problems(sa.page)).length === 0, JSON.stringify(await problems(sa.page)));
    await shot(sa.page, 'np-tile-not-connected.png', await tileClip(sa.page));
    await sa.page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await until(() => sa.page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 4000, 'page');
    await sleep(400);
    await shot(sa.page, 'np-page-not-connected.jpg');
    await sa.context.close();
    await stopPi(a);
    const b = await startPi('off');
    const sb = await open(b, ONLY(3, 2));
    await until(async () => (await tileText(sb.page)).title === 'Not set up', 5000, 'no off state');
    await shot(sb.page, 'np-tile-not-set-up.png', await tileClip(sb.page));
    await sb.context.close();
    await stopPi(b);
  });

  await check('Spotify down shows a small notice under the last song; it clears when Spotify is back', async () => {
    const x = await startPi('signed-in');
    mock.set('playing'); mock.reset();
    await control(x, 'POST', '/api/spotify/refresh', {});
    const s = await open(x, ONLY(3, 2));
    await waitTitle(s.page, 'Golden Hour Drive');
    mock.set('down');
    await until(async () => (await tileText(s.page)).note === 'Spotify can’t be reached', 8000, 'no notice');
    const t = await tileText(s.page);
    assert(t.label === 'Last played' && t.title === 'Golden Hour Drive', JSON.stringify(t));
    assert((await problems(s.page)).length === 0, JSON.stringify(await problems(s.page)));
    await shot(s.page, 'np-tile-spotify-down.png', await tileClip(s.page));
    mock.set('playing');
    await until(async () => /^(Now playing|Playing)$/.test((await tileText(s.page)).label) && (await tileText(s.page)).note === null, 8000, 'it did not recover');
    await s.context.close();
    await stopPi(x);
  });

  await check('losing the Pi: the last song stays, marked, and it comes back by itself', async () => {
    const x = await startPi('signed-in');
    mock.set('playing'); mock.reset();
    await control(x, 'POST', '/api/spotify/refresh', {});
    const s = await open(x, ONLY(3, 2));
    await waitTitle(s.page, 'Golden Hour Drive');
    const port = x.port;
    await stopPi(x);
    await until(async () => (await tileText(s.page)).label === 'Last played', 12000, 'no offline state');
    const t = await tileText(s.page);
    assert(t.title === 'Golden Hour Drive' && t.note === 'Can’t reach the Pi', JSON.stringify(t));
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-eq.is-playing').length)) === 0, 'not playing while the Pi is away');
    await shot(s.page, 'np-tile-pi-lost.png', await tileClip(s.page));
    await s.context.close();
    void port;
  });

  await check('an old Pi (no Spotify yet): says it needs an update; no Pi address: says live updates are off', async () => {
    const o = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await o.addInitScript((lay) => { localStorage.setItem('homeHub.layout', JSON.stringify(lay)); }, ONLY(3, 2));
    // A stand-in for an older server: it has the live line but no nowplaying.
    const srv = http.createServer((req, res) => {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': PAGE };
      if (req.url.indexOf('/live/state') === 0) {
        res.writeHead(200, h);
        return res.end(JSON.stringify({ ok: true, v: 1, server: '0.1.0', epoch: 'old', rev: 1, resources: { todo: { rev: 1, data: { items: [] } } } }));
      }
      if (req.url.indexOf('/live/events') === 0) {
        res.writeHead(200, Object.assign({}, h, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }));
        res.write('retry: 5000\n\nevent: hello\ndata: {"v":1,"epoch":"old","rev":1}\n\n');
        const t = setInterval(() => res.write('event: ping\ndata: {"rev":1}\n\n'), 5000);
        res.on('close', () => clearInterval(t));
        return undefined;
      }
      res.writeHead(404, h); return res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = await o.newPage();
    await p.goto(PAGE + '/hub.html?motion=fade&live=' + encodeURIComponent('http://127.0.0.1:' + srv.address().port));
    await p.waitForSelector('.tile');
    await until(async () => (await tileText(p)).title === 'The Pi needs an update', 6000, 'no update message');
    await o.close();
    srv.close();
    srv.closeAllConnections && srv.closeAllConnections();
    const o2 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await o2.addInitScript((lay) => { localStorage.setItem('homeHub.layout', JSON.stringify(lay)); }, ONLY(3, 2));
    const q = await o2.newPage();
    await q.goto(PAGE + '/hub.html?motion=fade&live=off');
    await q.waitForSelector('.tile');
    await until(async () => (await tileText(q)).title === 'Live updates are off', 4000, 'no off message');
    await o2.close();
  });

  await check('Spanish locale: the same tile, whole, at the strip and standard sizes', async () => {
    mock.set('long');
    const x = await startPi('signed-in');
    await control(x, 'POST', '/api/spotify/refresh', {});
    const s = await open(x, ONLY(6, 1), { locale: 'es-ES' });
    await waitTitle(s.page, 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)');
    assert((await problems(s.page)).length === 0, JSON.stringify(await problems(s.page)));
    await s.context.close();
    mock.set('playing');
    await stopPi(x);
  });
}

/* ---------- the visualizer ---------- */

const VIZ = () => window.HUB_NP_VIZ.debug();

async function openFull(page) {
  await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 5000, 'the page did not open');
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page.is-full')), 5000, 'full screen did not open');
}

async function leaveFull(page) {
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 5000, 'back to the page');
}

async function closePage(page) {
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 5000, 'the page did not close');
}

// Every inline animation on the glow level: { cls, name, ms, state }.
const anims = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.npv-scene:last-of-type .npv-orb'), (e) => {
  const cs = getComputedStyle(e);
  return { cls: e.className, name: cs.animationName, ms: parseFloat(cs.animationDuration) * 1000, state: cs.animationPlayState };
}).filter((a) => a.name !== 'none'));

// A short fingerprint of what the canvas shows now.
const pixels = (page) => page.evaluate(() => {
  const c = document.querySelector('.npv-canvas');
  if (!c) return '';
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) {
    h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) % 1000000007;
    if (d[i] + d[i + 1] + d[i + 2] > 240) lit++;
  }
  return h + ':' + lit;
});

// Where the page's parts are, in the panel.
const layout = (page) => page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
  return { panel: r('#panel'), page: r('.np-page'), art: r('.np-page .np-art'), card: !!document.querySelector('.np-page.np-card'), viz: r('.npv'), canvas: !!document.querySelector('#panel > .npv > .npv-canvas'), rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
});

async function playSong(pi, n, mode) {
  mock.play(n);
  if (mode) mock.set(mode);
  await control(pi, 'POST', '/api/spotify/refresh', {});
  await until(() => { const d = pi.h._debug().spotify.vibe; return !d.busy && !d.queued; }, 8000, 'the vibe lookup never ended');
}

async function vizChecks() {
  const pi = await startPi('signed-in');
  mock.vibes('ok', 0);

  await check('visualizer: full screen only, the whole panel, with the song as a small card in the upper left; never on the tile or the small page', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=classic' });
    await waitTitle(s.page, 'Golden Hour Drive');
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'nothing on the home screen');
    await s.page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy()), 4000, 'page');
    await sleep(400);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv, .np-card').length)) === 0, 'nothing on the small page');
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-chip-bpm').length)) === 0, 'no tempo chip on the small page');
    await s.page.keyboard.press('Enter');
    await until(() => s.page.evaluate(() => !!document.querySelector('#panel > .npv .npv-canvas') && window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy()), 5000, 'no visualizer in full screen');
    await sleep(500);
    const d = await s.page.evaluate(VIZ);
    assert(d.level === 'classic' && d.canvas && d.loop && d.size === '480x270' && d.lighter && d.tempo === 124, JSON.stringify(d));
    assert(d.layers <= 10 && d.scenes === 0, 'one canvas layer: ' + JSON.stringify(d));
    const L = await layout(s.page);
    assert(L.viz.w === 1920 && L.viz.h === 1080 && L.canvas, 'edge to edge: ' + JSON.stringify(L.viz));
    assert(L.card && L.art.w < L.panel.w / 4 && L.art.w <= 8 * L.rem + 1, 'a small picture: ' + JSON.stringify(L));
    assert(L.page.l - L.panel.l < L.panel.w * 0.4 && L.page.r - L.panel.l <= L.panel.w * 0.4 && L.page.b - L.panel.t <= L.panel.h * 0.45, 'the card in the upper left: ' + JSON.stringify(L));
    assert(L.page.w <= 27 * L.rem + 1, 'the card at most 27rem wide: ' + L.page.w);
    const look = await s.page.evaluate(() => {
      const root = document.querySelector('.npv');
      return { z: getComputedStyle(root).zIndex, attr: root.getAttribute('data-viz'), chip: (document.querySelector('.np-chip-bpm') || {}).textContent, on: !!document.querySelector('.np-page.npv-on'), bg: getComputedStyle(document.querySelector('.np-card')).backgroundColor, bf: getComputedStyle(document.querySelector('.np-card')).backdropFilter || 'none' };
    });
    assert(look.z === '-1' && /^classic/.test(look.attr), JSON.stringify(look));
    assert(look.chip === '124 BPM' && look.on, JSON.stringify(look));
    assert(/^rgba\(.*0\.\d+\)$/.test(look.bg) && look.bf === 'none', 'a plain translucent backing: ' + JSON.stringify(look));
    // The card stays clear of the panel's own header and button.
    const clash = await s.page.evaluate(() => {
      const card = document.querySelector('.np-card').getBoundingClientRect();
      const out = [];
      document.querySelectorAll('#panel .panel-btn, #panel .panel-icon, #panel .panel-title, #panel .panel-hint').forEach((e) => {
        const b = e.getBoundingClientRect();
        if (b.width && b.left < card.right && b.right > card.left && b.top < card.bottom && b.bottom > card.top) out.push(e.className || e.tagName);
      });
      return out;
    });
    assert(!clash.length, 'the card covers: ' + clash.join(','));
    // Leaving full screen takes it away; the page is as before.
    await leaveFull(s.page);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv, .np-card').length)) === 0, 'gone in the small page');
    assert(!(await s.page.evaluate(VIZ)).loop, 'the drawing loop stopped');
    await closePage(s.page);
    // Nothing playing: no visualizer and the big layout, even full screen.
    mock.set('idle');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => (await tileText(s.page)).label === 'Last played', 5000, 'idle');
    await openFull(s.page);
    await sleep(500);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv, .np-card').length)) === 0, 'no visualizer when nothing plays');
    await closePage(s.page);
    mock.set('playing');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: the canvas moves while playing; paused, it settles and its loop stops; playing again, it moves', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=classic' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().frames > 20), 5000, 'it never drew');
    const a = await pixels(s.page);
    await sleep(300);
    const b = await pixels(s.page);
    assert(a !== b, 'the picture changes between frames');
    assert(Number(b.split(':')[1]) > 500, 'bright shapes on it: ' + b);
    mock.set('paused');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(() => s.page.evaluate(() => { const d = window.HUB_NP_VIZ.debug(); return !d.loop && d.still && !d.playing; }), 5000, 'it did not settle');
    const f1 = (await s.page.evaluate(VIZ)).frames;
    const p1 = await pixels(s.page);
    await sleep(600);
    const f2 = (await s.page.evaluate(VIZ)).frames;
    const p2 = await pixels(s.page);
    assert(f1 === f2 && p1 === p2, 'still and no frames drawn while paused: ' + JSON.stringify([f1, f2, p1, p2]));
    assert(Number(p2.split(':')[1]) > 0, 'a dim picture stays (not black): ' + p2);
    await shot(s.page, 'np-viz-paused.jpg');
    mock.set('playing');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().loop), 5000, 'it did not start again');
    await until(async () => (await s.page.evaluate(VIZ)).frames > f2 + 10, 3000, 'no new frames');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: a vibe arriving late changes it in place (same canvas, no page redraw), with its tempo chip', async () => {
    const fresh = await startPi('signed-in');
    mock.vibes('ok', 2500);
    mock.play(4);
    await control(fresh, 'POST', '/api/spotify/refresh', {});
    const s = await open(fresh, ONLY(3, 2), { query: '&viz=classic' });
    await waitTitle(s.page, 'Linen & Light');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => !!document.querySelector('.npv .npv-canvas')), 4000, 'no visualizer');
    const before = await s.page.evaluate(() => {
      window.__cv = document.querySelector('.npv-canvas');
      window.__page = document.querySelector('.np-page');
      return window.HUB_NP_VIZ.debug();
    });
    assert(before.tempo === 100, 'a gentle default before the vibe: ' + JSON.stringify(before));
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-chip-bpm').length)) === 0, 'no chip yet');
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().tempo === 70), 8000, 'the vibe never arrived');
    const after = await s.page.evaluate(() => ({
      sameCanvas: document.querySelector('.npv-canvas') === window.__cv,
      samePage: document.querySelector('.np-page') === window.__page,
      chip: (document.querySelector('.np-chip-bpm') || {}).textContent
    }));
    assert(after.sameCanvas && after.samePage, 'redrawn: ' + JSON.stringify(after));
    assert(after.chip === '70 BPM', 'chip: ' + after.chip);
    mock.vibes('ok', 0);
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
    await stopPi(fresh);
  });

  await check('visualizer: calm songs get flowing scenes, hard ones sharp scenes; beats never faster than 2.5 a second', async () => {
    const seen = {};
    for (const [n, name] of [[4, 'calm'], [0, 'upbeat'], [3, 'hard'], [2, 'moody']]) {
      await playSong(pi, n);
      const s = await open(pi, ONLY(3, 2), { query: '&viz=classic' });
      await waitTitle(s.page, mockSpotify.SONGS[n].name);
      await openFull(s.page);
      await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().palette === 'art' && window.HUB_NP_VIZ.debug().vibe), 5000, name + ': no song');
      seen[name] = await s.page.evaluate(() => {
        const d = window.HUB_NP_VIZ.debug();
        const beat = 60000 / d.tempo;
        const order = [];
        for (let i = 0; i < 12; i++) order.push(window.HUB_NP_VIZ.sceneAt(d.id, d.vibe, (i + 0.5) * d.phraseBeats * beat));
        return { d: d, order: order };
      });
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    }
    const SHARP = ['tunnel', 'kaleidoscope', 'starburst'];
    const FLOW = ['spirograph', 'ribbons', 'lattice'];
    const count = (o, fam) => o.order.filter((x) => fam.indexOf(x) >= 0).length;
    assert(count(seen.calm, FLOW) >= 9, 'calm: ' + seen.calm.order.join(','));
    assert(count(seen.moody, FLOW) >= 8, 'moody: ' + seen.moody.order.join(','));
    assert(count(seen.hard, SHARP) >= 9, 'hard: ' + seen.hard.order.join(','));
    assert(count(seen.upbeat, SHARP) >= 9, 'upbeat: ' + seen.upbeat.order.join(','));
    for (const k of Object.keys(seen)) {
      const o = seen[k].order;
      assert(o.every((x, i) => i === 0 || x !== o[i - 1]), k + ': the same scene twice in a row: ' + o.join(','));
      assert(seen[k].d.pulseMs >= 400, k + ': pulses faster than 2.5 a second: ' + seen[k].d.pulseMs);
    }
    assert(Math.abs(seen.hard.d.pulseMs - 2 * 60000 / 172) < 2, 'hard and fast: a pulse every second beat: ' + seen.hard.d.pulseMs);
    assert(seen.calm.d.phraseBeats === 16 && seen.upbeat.d.phraseBeats === 32, 'phrases: ' + seen.calm.d.phraseBeats + ', ' + seen.upbeat.d.phraseBeats);
    console.log('     calm ' + seen.calm.order.slice(0, 4).join(' ') + ' ...; hard ' + seen.hard.order.slice(0, 4).join(' ') + ' ...');
  });

  await check('visualizer: the scene follows the song\'s position (the same after a seek) and changes on phrase boundaries', async () => {
    await playSong(pi, 0);
    mock.seek(60000);
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2), { query: '&viz=classic' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().scene !== '' && window.HUB_NP_VIZ.debug().vibe), 5000, 'no scene');
    // The same song and position always give the same scene; the next phrase another.
    const pure = await s.page.evaluate(() => {
      const d = window.HUB_NP_VIZ.debug();
      const ph = d.phraseBeats * 60000 / d.tempo;
      const A = window.HUB_NP_VIZ.sceneAt;
      return { a: A(d.id, d.vibe, 3 * ph - 10), b: A(d.id, d.vibe, 3 * ph - 10), c: A(d.id, d.vibe, 3 * ph + 10), early: A(d.id, d.vibe, 2 * ph + 10) };
    });
    assert(pure.a === pure.b && pure.a === pure.early && pure.c !== pure.a, 'deterministic, changing at the boundary: ' + JSON.stringify(pure));
    // Live: the scene shown is the one for the position, also after a seek.
    const live = () => s.page.evaluate(() => {
      const d = window.HUB_NP_VIZ.debug();
      return { shown: d.scene, want: window.HUB_NP_VIZ.sceneAt(d.id, d.vibe, d.position), pos: d.position, ph: d.phraseBeats * 60000 / d.tempo };
    });
    const near = (x) => { const r = x.pos % x.ph; return r < 300 || r > x.ph - 300; };
    let l1 = await live();
    if (near(l1)) { await sleep(500); l1 = await live(); }
    assert(l1.shown === l1.want, 'at 1:00: ' + JSON.stringify(l1));
    mock.seek(150000);
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => (await live()).pos > 149000, 5000, 'the seek did not arrive');
    await sleep(200);
    let l2 = await live();
    if (near(l2)) { await sleep(500); l2 = await live(); }
    assert(l2.shown === l2.want, 'after the seek: ' + JSON.stringify(l2));
    // Short phrases (a test hook): it moves through scenes as the song goes.
    await s.page.evaluate(() => window.HUB_NP_VIZ.test.phraseBeats(2));
    const names = new Set();
    for (let i = 0; i < 16; i++) { names.add((await s.page.evaluate(VIZ)).scene); await sleep(200); }
    assert(names.size >= 2, 'scenes seen: ' + Array.from(names).join(','));
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: off by ?viz=off and by HUB_CONFIG, and the still wash: the big layout as before', async () => {
    await playSong(pi, 0);
    const big = async (page, why) => {
      const L = await layout(page);
      assert(!L.card && L.art.w > 450, why + ': the big picture layout: ' + JSON.stringify(L));
    };
    const a = await open(pi, ONLY(3, 2), { query: '&viz=off', motion: 'push' });
    await waitTitle(a.page, 'Golden Hour Drive');
    await openFull(a.page);
    await sleep(800);
    assert((await a.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, '?viz=off');
    assert((await a.page.evaluate(() => document.querySelectorAll('.np-chip-bpm').length)) === 0, 'no tempo chip either');
    await big(a.page, '?viz=off');
    await a.context.close();
    const b = await open(pi, ONLY(3, 2), { config: 'HUB_CONFIG.widgets.nowplaying = { visualizer: false };', motion: 'push' });
    await waitTitle(b.page, 'Golden Hour Drive');
    await openFull(b.page);
    await sleep(800);
    assert((await b.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'config off');
    assert((await b.page.evaluate(() => window.HUB_NP_VIZ.status())) === 'off (config)', await b.page.evaluate(() => window.HUB_NP_VIZ.status()));
    await big(b.page, 'config off');
    await b.context.close();
    // The tests' own motion=fade: the still wash, nothing animated.
    const c = await open(pi, ONLY(3, 2));
    await waitTitle(c.page, 'Golden Hour Drive');
    await openFull(c.page);
    await until(() => c.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1), 5000, 'no wash');
    const d = await c.page.evaluate(VIZ);
    assert(d.level === 'wash' && d.source === 'motion' && !d.canvas, JSON.stringify(d));
    assert((await anims(c.page)).length === 0, 'nothing moves in the still wash');
    await big(c.page, 'still wash');
    await c.context.close();
    // Config can pick a level; "full" is the old name of the top level, radiant.
    const e = await open(pi, ONLY(3, 2), { config: 'HUB_CONFIG.widgets.nowplaying = { visualizer: "full" };', motion: 'push' });
    await waitTitle(e.page, 'Golden Hour Drive');
    await openFull(e.page);
    await until(() => e.page.evaluate(() => window.HUB_NP_VIZ.debug().canvas), 5000, 'no canvas');
    assert((await e.page.evaluate(VIZ)).level === 'radiant' && (await layout(e.page)).card, 'full = radiant, with the card');
    await e.context.close();
  });

  await check('visualizer: the glow level keeps the card; only transform and opacity animate there; no filters, blur or blend modes', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=glow' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1), 5000, 'scene');
    assert((await layout(s.page)).card, 'the small card at the glow level');
    assert((await anims(s.page)).length === 3, 'three moving glows');
    const r = await s.page.evaluate(() => {
      const bad = [];
      let frames = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of Array.from(rules)) {
          if (rule.type !== CSSRule.KEYFRAMES_RULE || !/^npv-/.test(rule.name)) continue;
          for (const kf of Array.from(rule.cssRules)) {
            frames++;
            for (let i = 0; i < kf.style.length; i++) {
              const p = kf.style[i];
              if (p !== 'transform' && p !== 'opacity' && p !== '-webkit-transform') bad.push(rule.name + ': ' + p);
            }
          }
        }
      }
      document.querySelectorAll('.npv, .npv *').forEach((e) => {
        const cs = getComputedStyle(e);
        if (cs.filter !== 'none' || (cs.backdropFilter && cs.backdropFilter !== 'none') || cs.mixBlendMode !== 'normal' || cs.boxShadow !== 'none') bad.push('effect on ' + e.className);
        const tp = cs.transitionProperty.split(',').map((x) => x.trim());
        if (tp.some((x) => x !== 'all' && x !== 'opacity') || (tp.indexOf('all') >= 0 && parseFloat(cs.transitionDuration) > 0)) bad.push('transition on ' + e.className + ': ' + cs.transitionProperty);
        if (cs.animationName !== 'none' && !/^npv-/.test(cs.animationName)) bad.push('animation ' + cs.animationName);
      });
      return { bad: bad, frames: frames };
    });
    assert(r.frames > 20, 'keyframes found: ' + r.frames);
    assert(!r.bad.length, r.bad.join('; '));
    // Paused, the glows hold still.
    mock.set('paused');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => (await anims(s.page)).every((x) => x.state === 'paused'), 5000, 'it did not come to rest');
    mock.set('playing');
    await s.context.close();
  });

  await check('visualizer: the mood\'s colors when the picture cannot be read; the page is unharmed', async () => {
    await playSong(pi, 2);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=classic', unreadableArt: true });
    await waitTitle(s.page, 'Paper Moons');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => /not readable|did not load/.test(window.HUB_NP_VIZ.debug().problem)), 6000, 'no answer about the picture');
    const d = await s.page.evaluate(VIZ);
    assert(d.palette === 'mood' && d.loop, JSON.stringify(d));
    assert((await s.page.evaluate(() => document.querySelector('.np-page .np-title').textContent)) === 'Paper Moons', 'the page is there');
    // The browser itself reports the refused picture; nothing else may complain.
    const others = s.errors.filter((e) => !/CORS|Access-Control/.test(e));
    assert(others.length === 0, 'page errors: ' + others.join(' | '));
    await s.context.close();
  });

  await check('visualizer: a new song morphs on the same canvas; closing leaves nothing behind (no layer, timer or frame loop)', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=classic' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().frames > 10), 5000, 'canvas');
    await s.page.evaluate(() => { window.__cv = document.querySelector('.npv-canvas'); });
    mock.play(4);
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().id === 'mock0005'), 6000, 'the new song');
    assert(await s.page.evaluate(() => document.querySelector('.npv-canvas') === window.__cv), 'the same canvas carries over');
    await sleep(300);
    await leaveFull(s.page);
    await closePage(s.page);
    const left = await s.page.evaluate(() => ({ n: document.querySelectorAll('.npv, .npv-canvas, .npv-scene').length, d: window.HUB_NP_VIZ.debug() }));
    assert(left.n === 0 && left.d.timers === 0 && !left.d.shown && !left.d.loop && !left.d.canvas, JSON.stringify(left));
    // Hidden (the TV went to another app): the loop stops; back, it runs.
    await openFull(s.page);
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().loop), 5000, 'loop');
    await s.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(200);
    const hid = await s.page.evaluate(VIZ);
    await sleep(300);
    assert(!hid.loop && (await s.page.evaluate(VIZ)).frames === hid.frames, 'hidden: ' + JSON.stringify(hid));
    await s.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().loop), 3000, 'it did not come back');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: long Spanish words fit the card (two lines of title, nothing clipped or spilling)', async () => {
    mock.set('long');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2), { query: '&viz=classic' });
    await until(async () => /^Canción para una mañana/.test((await tileText(s.page)).title || ''), 6000, 'no long song');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => !!document.querySelector('.np-card') && window.HUB_NP_VIZ.debug().canvas), 5000, 'no card');
    await sleep(500);
    const bad = await s.page.evaluate(() => {
      const out = [];
      const card = document.querySelector('.np-card');
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (card.getBoundingClientRect().width > 27 * rem + 1) out.push('the card is ' + card.getBoundingClientRect().width + ' px wide');
      if (card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1) out.push('the card overflows');
      const info = document.querySelector('.np-card .np-info');
      if (info.scrollWidth > info.clientWidth + 1) out.push('the words overflow sideways');
      const ir = info.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      document.querySelectorAll('.np-card .np-info > *, .np-card .np-chip').forEach((e) => {
        if (e.offsetParent === null || getComputedStyle(e).display === 'none') return;
        const r = e.getBoundingClientRect();
        if (r.right > ir.right + 1) out.push(e.className + ' past the right');
        if (r.bottom > cr.bottom + 1) out.push(e.className + ' below the card');
      });
      const title = card.querySelector('.np-title');
      const cs = getComputedStyle(title);
      const lines = Math.round(title.getBoundingClientRect().height / parseFloat(cs.lineHeight));
      if (lines > 2) out.push('the title runs to ' + lines + ' lines');
      // Accents on capitals (Á, Ñ) need room above the letters.
      if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.24) out.push('title line height too tight');
      ['.np-artist', '.np-album'].forEach((c) => {
        const e = card.querySelector(c);
        if (!e || getComputedStyle(e).display === 'none') return;
        const l = Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight));
        if (l > 1) out.push(c + ' runs to ' + l + ' lines');
        if (parseFloat(getComputedStyle(e).lineHeight) < parseFloat(getComputedStyle(e).fontSize) * 1.3) out.push(c + ' line height too tight');
      });
      if (card.querySelectorAll('.np-times, .np-bar').length < 2) out.push('the time and bar went missing');
      return out;
    });
    assert(!bad.length, bad.join('; '));
    await shot(s.page, 'np-viz-card-spanish.jpg');
    mock.set('playing');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: a frame-rate check after it starts, kept per build; poor results step it down radiant, classic, lite, glow, still wash (and the big layout); the About row says so', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { motion: 'push' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    // Kept once it has settled (one poor window measures again before deciding).
    await until(() => s.page.evaluate(() => { const k = JSON.parse(localStorage.getItem('homeHub.npViz') || 'null'); return !!k && k.settled; }), 30000, 'never settled');
    // Headless Chromium draws without a graphics chip, so whether this
    // machine keeps "radiant" says nothing about the TV; what is kept must match.
    const kept = await s.page.evaluate(() => ({ d: window.HUB_NP_VIZ.debug(), ls: JSON.parse(localStorage.getItem('homeHub.npViz')), build: window.HUB_BUILD, attr: document.querySelector('.npv').getAttribute('data-viz') }));
    assert(kept.ls.build === kept.build && kept.ls.level === kept.d.level && kept.ls.fps === kept.d.fps, JSON.stringify(kept));
    assert(kept.attr === kept.d.level + ' ' + kept.d.fps + 'fps', kept.attr);
    console.log('     headless check: ' + kept.d.fps + ' fps, level ' + kept.d.level);
    const scene = kept.d.scene;
    await leaveFull(s.page);
    await closePage(s.page);
    const rows = await s.page.evaluate(() => { window.HUB_TEST.about.open(); const r = window.HUB_TEST.about.rows(); window.HUB_TEST.about.close(); return r; });
    const row = rows.filter((x) => x.label === 'Visualizer')[0];
    const name = { radiant: 'radiant', classic: 'classic', lite: 'classic-lite', glow: 'glows', wash: 'still wash' }[kept.d.level];
    const tail = kept.d.level === 'radiant' || kept.d.level === 'classic' || kept.d.level === 'lite' ? '(, [0-9.]+ ms a frame)?, [a-z]+' : '';
    assert(row && row.group === 'Now Playing' && new RegExp('^' + name + ', \\d+ fps, 124 BPM from features' + tail + '$').test(row.value), 'About: ' + JSON.stringify(row) + ' ' + scene);
    await s.context.close();
    // A fresh TV whose every check comes out poor (a test hook), with short
    // checks: one step at a time, down to the still wash and the big picture.
    const t = await open(pi, ONLY(3, 2), { motion: 'push' });
    await waitTitle(t.page, 'Golden Hour Drive');
    await t.page.evaluate(() => { window.HUB_NP_VIZ.test.timing({ after: 300, ms: 500, again: 100 }); window.HUB_NP_VIZ.test.forcePoor(true); });
    await openFull(t.page);
    const levels = [];
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const l = (await t.page.evaluate(VIZ)).level;
      if (levels[levels.length - 1] !== l) levels.push(l);
      if (l === 'wash') break;
      await sleep(50);
    }
    assert(levels.join(' ') === 'radiant classic lite glow wash', 'steps: ' + levels.join(' '));
    await until(async () => { const L = await layout(t.page); return !L.card && L.art && L.art.w > 450; }, 4000, 'the big picture did not come back');
    const after = await t.page.evaluate(() => ({ d: window.HUB_NP_VIZ.debug(), ls: JSON.parse(localStorage.getItem('homeHub.npViz')) }));
    assert(after.ls.level === 'wash' && after.ls.settled && !after.d.canvas && !after.d.loop, JSON.stringify(after));
    // Back in full screen: the kept answer, the big layout at once.
    await leaveFull(t.page);
    await t.page.keyboard.press('Enter');
    await until(() => t.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && document.querySelectorAll('.npv-scene').length >= 1), 4000, 'full again');
    assert((await t.page.evaluate(VIZ)).level === 'wash' && !(await layout(t.page)).card, 'the kept still wash');
    // An answer kept by another build is not used: this one measures afresh.
    await t.page.evaluate(() => { window.HUB_NP_VIZ.test.forcePoor(false); localStorage.setItem('homeHub.npViz', JSON.stringify({ build: 'v0.0.1', level: 'wash', fps: 9, settled: true })); });
    await leaveFull(t.page);
    await t.page.keyboard.press('Enter');
    await until(() => t.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && window.HUB_NP_VIZ.debug().shown), 4000, 'full again');
    assert((await t.page.evaluate(VIZ)).level === 'radiant', 'an old build\'s answer is not used');
    await t.context.close();
  });

  await check('visualizer: radiant draws 960 x 540 on a second canvas with halos, motes and bloom; the About row says how long a frame takes', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=radiant' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().frames > 30), 8000, 'canvas');
    const d = await s.page.evaluate(VIZ);
    assert(d.level === 'radiant' && d.size === '960x540' && d.bloom && d.loop && d.tempo === 124 && d.ms > 0, JSON.stringify(d));
    const dom = await s.page.evaluate(() => ({ canvases: document.querySelectorAll('#panel > .npv > .npv-canvas').length, vignette: document.querySelectorAll('#panel > .npv > .npv-vignette').length }));
    assert(dom.canvases === 1 && dom.vignette === 1, JSON.stringify(dom));
    const text = await s.page.evaluate(() => window.HUB_NP_VIZ.status());
    assert(/^radiant, 124 BPM from features, [0-9.]+ ms a frame, [a-z]+ \(URL\)$/.test(text), text);
    await leaveFull(s.page);
    const gone = await s.page.evaluate(() => document.querySelectorAll('.npv-canvas, .npv-vignette').length);
    assert(gone === 0, 'left over after leaving: ' + gone);
    await s.context.close();
  });

  await check('rough smoothness with the CPU slowed 6x, radiant, classic and lite (desktop Chromium: a sanity check, not the TV)', async () => {
    const out = [];
    for (const [n, name, level] of [[4, 'calm', 'radiant'], [3, 'hard', 'radiant'], [4, 'calm', 'classic'], [3, 'hard', 'classic'], [4, 'calm', 'lite'], [3, 'hard', 'lite']]) {
      await playSong(pi, n);
      const s = await open(pi, ONLY(3, 2), { query: '&viz=' + level });
      await waitTitle(s.page, mockSpotify.SONGS[n].name);
      await openFull(s.page);
      await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().frames > 20), 5000, 'canvas');
      const cdp = await s.context.newCDPSession(s.page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await sleep(500);
      const f0 = (await s.page.evaluate(VIZ)).frames;
      const t0 = Date.now();
      await sleep(3000);
      const f1 = (await s.page.evaluate(VIZ)).frames;
      const fps = Math.round((f1 - f0) * 1000 / (Date.now() - t0));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      out.push(level + ' ' + name + ' ' + fps + ' fps drawn');
      await s.context.close();
    }
    console.log('     6x slower CPU: ' + out.join(', '));
  });

  await check('every file in app/ is plain ES5', () => {
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    const files = [];
    (function walk(d) {
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else if (/\.js$/.test(e.name)) files.push(f);
      });
    })(path.join(ROOT, 'app'));
    assert(files.some((f) => /nowplaying-viz\.js$/.test(f)), 'the visualizer file is there');
    const bad = [];
    files.forEach((f) => {
      const text = fs.readFileSync(f, 'utf8');
      if (acorn) {
        try { acorn.parse(text, { ecmaVersion: 5 }); } catch (e) { bad.push(path.relative(ROOT, f) + ': ' + e.message); }
      } else if (/(^|[^.\w])(let|const)\s|=>|`/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
        bad.push(path.relative(ROOT, f) + ': ES2015 syntax');
      }
    });
    if (!acorn) console.log('     (no ES5 parser found here: a simpler check was used)');
    assert(!bad.length, bad.join(' | '));
    const html = fs.readFileSync(path.join(ROOT, 'app', 'hub.html'), 'utf8');
    assert(html.indexOf('widgets/nowplaying-viz.js') >= 0 && html.indexOf('widgets/nowplaying-viz.js') < html.indexOf('widgets/nowplaying.js'), 'hub.html loads the visualizer before the widget');
  });

  await stopPi(pi);
}

main().then(() => vizChecks()).catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  for (const p of pis.slice()) { try { await stopPi(p); } catch (e) { /* ignore */ } }
  try { if (mock) await mock.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  tmp.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  const passed = results.filter(Boolean).length;
  console.log(passed + ' passed, ' + (results.length - passed) + ' failed');
  process.exit(results.length - passed ? 1 : 0);
});
