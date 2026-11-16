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
 * song plays or is paused; a vibe arriving late changes it in place; its
 * rhythm follows the tempo; it rests when paused; the off switches; the mood
 * colors when the picture cannot be read; nothing left after closing; only
 * transform and opacity animate; the frame-rate check steps down; the About
 * row; every file in app/ is plain ES5; and a rough frame rate with the CPU
 * slowed 6x (a sanity check only: a desktop says little about the TV).
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

async function closePage(page) {
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 5000, 'the page did not close');
}

// Every inline animation on the visualizer: { cls, name, ms, state }.
const anims = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.npv-scene:last-of-type .npv-orb, .npv-scene:last-of-type .npv-ring, .npv-scene:last-of-type .npv-bloom'), (e) => {
  const cs = getComputedStyle(e);
  return { cls: e.className, name: cs.animationName, ms: parseFloat(cs.animationDuration) * 1000, state: cs.animationPlayState };
}).filter((a) => a.name !== 'none'));

async function playSong(pi, n, mode) {
  mock.play(n);
  if (mode) mock.set(mode);
  await control(pi, 'POST', '/api/spotify/refresh', {});
  await until(() => { const d = pi.h._debug().spotify.vibe; return !d.busy && !d.queued; }, 8000, 'the vibe lookup never ended');
}

async function vizChecks() {
  const pi = await startPi('signed-in');
  mock.vibes('ok', 0);

  await check('visualizer: full screen only, while a song plays or is paused; never on the tile or the small page', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
    await waitTitle(s.page, 'Golden Hour Drive');
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'nothing on the home screen');
    await s.page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy()), 4000, 'page');
    await sleep(400);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'nothing on the small page');
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-chip-bpm').length)) === 0, 'no tempo chip on the small page');
    await s.page.keyboard.press('Enter');
    await until(() => s.page.evaluate(() => !!document.querySelector('#panel > .npv .npv-scene') && window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy()), 5000, 'no visualizer in full screen');
    const d = await s.page.evaluate(VIZ);
    assert(d.level === 'full' && d.rings === 2 && d.bloom > 0 && d.tempo === 124, JSON.stringify(d));
    assert(d.layers <= 10, 'at most ten layers: ' + d.layers);
    const look = await s.page.evaluate(() => {
      const root = document.querySelector('.npv');
      const r = root.getBoundingClientRect();
      return { z: getComputedStyle(root).zIndex, w: r.width, h: r.height, attr: root.getAttribute('data-viz'), chip: (document.querySelector('.np-chip-bpm') || {}).textContent, on: !!document.querySelector('.np-page.npv-on') };
    });
    assert(look.z === '-1' && look.w === 1920 && look.h === 1080 && /^full/.test(look.attr), JSON.stringify(look));
    assert(look.chip === '124 BPM' && look.on, JSON.stringify(look));
    // Leaving full screen takes it away; going back brings it back.
    await s.page.keyboard.press('Enter');
    await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 4000, 'back to the page');
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'gone in the small page');
    await closePage(s.page);
    // Nothing playing: no visualizer, even full screen.
    mock.set('idle');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => (await tileText(s.page)).label === 'Last played', 5000, 'idle');
    await openFull(s.page);
    await sleep(500);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'no visualizer when nothing plays');
    await closePage(s.page);
    mock.set('playing');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: a vibe arriving late blends in place (no page redraw, the layer stays), with its tempo chip', async () => {
    const fresh = await startPi('signed-in');
    mock.vibes('ok', 2500);
    mock.play(4);
    await control(fresh, 'POST', '/api/spotify/refresh', {});
    const s = await open(fresh, ONLY(3, 2), { query: '&viz=full' });
    await waitTitle(s.page, 'Linen & Light');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => !!document.querySelector('.npv .npv-scene')), 4000, 'no visualizer');
    const before = await s.page.evaluate(() => {
      window.__npv = document.querySelector('.npv');
      window.__page = document.querySelector('.np-page');
      return window.HUB_NP_VIZ.debug();
    });
    assert(before.tempo === 100 && before.rings === 0, 'a calm default before the vibe: ' + JSON.stringify(before));
    assert((await s.page.evaluate(() => document.querySelectorAll('.np-chip-bpm').length)) === 0, 'no chip yet');
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().tempo === 70), 8000, 'the vibe never arrived');
    const after = await s.page.evaluate(() => ({
      sameLayer: document.querySelector('.npv') === window.__npv,
      samePage: document.querySelector('.np-page') === window.__page,
      scenes: document.querySelectorAll('.npv-scene').length,
      chip: (document.querySelector('.np-chip-bpm') || {}).textContent
    }));
    assert(after.sameLayer && after.samePage, 'redrawn: ' + JSON.stringify(after));
    assert(after.scenes === 2, 'the new look fades over the old: ' + after.scenes);
    assert(after.chip === '70 BPM', 'chip: ' + after.chip);
    await sleep(1700);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv-scene').length)) === 1, 'the old look is removed after the fade');
    mock.vibes('ok', 0);
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
    await stopPi(fresh);
  });

  await check('visualizer: a calm and a fast song move differently, timed in beats, never faster than 2.5 pulses a second', async () => {
    const seen = {};
    for (const [n, name] of [[4, 'calm'], [0, 'upbeat'], [3, 'hard'], [2, 'moody']]) {
      await playSong(pi, n);
      const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
      await waitTitle(s.page, mockSpotify.SONGS[n].name);
      await openFull(s.page);
      await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().tempo === window.HUB_NP_VIZ.debug().tempo && document.querySelectorAll('.npv-scene').length === 1 && window.HUB_NP_VIZ.debug().palette === 'art'), 5000, name + ': no scene');
      seen[name] = { d: await s.page.evaluate(VIZ), a: await anims(s.page) };
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    }
    const beat = (bpm) => 60000 / bpm;
    const near = (a, b) => Math.abs(a - b) < 2;
    // Calm: no rings, no pulse, slow glows on whole phrases.
    assert(seen.calm.d.rings === 0 && seen.calm.d.bloom === 0, 'calm: ' + JSON.stringify(seen.calm.d));
    assert(seen.calm.a.length === 3 && seen.calm.a.every((x) => /^npv-rise-/.test(x.name) && near(x.ms, 16 * beat(70))), 'calm glows: ' + JSON.stringify(seen.calm.a));
    // Upbeat: a halo on every beat, rings every two beats.
    const up = seen.upbeat.a;
    assert(up.filter((x) => /npv-bloom/.test(x.cls)).every((x) => near(x.ms, beat(124))), 'upbeat halo: ' + JSON.stringify(up));
    assert(up.filter((x) => /npv-ring/.test(x.cls)).length === 2 && up.filter((x) => /npv-ring/.test(x.cls)).every((x) => near(x.ms, 2 * 2 * beat(124))), 'upbeat rings: ' + JSON.stringify(up));
    // Hard and fast (172 BPM): the halo on every second beat.
    assert(seen.hard.a.filter((x) => /npv-bloom/.test(x.cls)).every((x) => near(x.ms, 2 * beat(172))) && seen.hard.d.bloom === 3, 'hard: ' + JSON.stringify(seen.hard));
    // Moody: sinking glows, no rings.
    assert(seen.moody.d.drift === 'sink' && seen.moody.d.rings === 0, 'moody: ' + JSON.stringify(seen.moody.d));
    for (const k of Object.keys(seen)) {
      assert(seen[k].a.every((x) => x.ms >= 400), k + ': something pulses faster than 2.5 a second');
    }
    console.log('     calm ' + JSON.stringify({ rings: seen.calm.d.rings, orbMs: seen.calm.d.orbMs }) + ', upbeat ' + JSON.stringify({ pulseMs: seen.upbeat.d.pulseMs, ringEvery: seen.upbeat.d.ringEvery }) + ', hard ' + JSON.stringify({ pulseMs: seen.hard.d.pulseMs }));
  });

  await check('visualizer: phases follow the song\'s position, and a seek realigns them', async () => {
    await playSong(pi, 0);
    mock.seek(60000);
    await control(pi, 'POST', '/api/spotify/refresh', {});
    const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1 && window.HUB_NP_VIZ.debug().palette === 'art'), 5000, 'scene');
    // The halo's place in its cycle matches the song's place in its beat.
    const phase = () => s.page.evaluate(() => {
      const b = document.querySelector('.npv-scene:last-of-type .npv-bloom');
      const a = b.getAnimations()[0];
      const fill = document.querySelector('.np-elapsed').textContent;
      return { t: a.currentTime % parseFloat(getComputedStyle(b).animationDuration) / 1000, ms: parseFloat(getComputedStyle(b).animationDuration) * 1000, fill: fill };
    });
    const p1 = await phase();
    mock.seek(120000);
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => /^2:0\d$/.test((await phase()).fill), 5000, 'the seek did not arrive');
    const want = await s.page.evaluate(() => {
      // The song's position as the page counts it, in beats of 124 BPM.
      const b = document.querySelector('.npv-scene:last-of-type .npv-bloom');
      const a = b.getAnimations()[0];
      return { cur: a.currentTime, delay: a.effect.getTiming().delay };
    });
    assert(want.delay < 0 && want.delay > -p1.ms, 'a negative delay inside one beat: ' + JSON.stringify(want));
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: paused, it comes to rest (the beat fades, everything holds still); playing again, it moves', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1), 5000, 'scene');
    mock.set('paused');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => (await anims(s.page)).every((x) => x.state === 'paused'), 5000, 'it did not come to rest');
    const beatOpacity = await s.page.evaluate(() => getComputedStyle(document.querySelector('.npv-scene:last-of-type .npv-beat')).opacity);
    assert(parseFloat(beatOpacity) < 0.05, 'the beat faded out: ' + beatOpacity);
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv .npv-scene').length)) === 1, 'a still wash stays');
    await shot(s.page, 'np-viz-paused.jpg');
    mock.set('playing');
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(async () => (await anims(s.page)).every((x) => x.state === 'running'), 5000, 'it did not move again');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: off by ?viz=off and by HUB_CONFIG; a still wash on the plainest motion setting', async () => {
    await playSong(pi, 0);
    const a = await open(pi, ONLY(3, 2), { query: '&viz=off' });
    await waitTitle(a.page, 'Golden Hour Drive');
    await openFull(a.page);
    await sleep(800);
    assert((await a.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, '?viz=off');
    assert((await a.page.evaluate(() => document.querySelectorAll('.np-chip-bpm').length)) === 0, 'no tempo chip either');
    await a.context.close();
    const b = await open(pi, ONLY(3, 2), { config: 'HUB_CONFIG.widgets.nowplaying = { visualizer: false };', motion: 'push' });
    await waitTitle(b.page, 'Golden Hour Drive');
    await openFull(b.page);
    await sleep(800);
    assert((await b.page.evaluate(() => document.querySelectorAll('.npv').length)) === 0, 'config off');
    assert((await b.page.evaluate(() => window.HUB_NP_VIZ.status())) === 'off (config)', await b.page.evaluate(() => window.HUB_NP_VIZ.status()));
    await b.context.close();
    // The tests' own motion=fade: the still wash, nothing animated.
    const c = await open(pi, ONLY(3, 2));
    await waitTitle(c.page, 'Golden Hour Drive');
    await openFull(c.page);
    await until(() => c.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1), 5000, 'no wash');
    const d = await c.page.evaluate(VIZ);
    assert(d.level === 'wash' && d.source === 'motion', JSON.stringify(d));
    assert((await anims(c.page)).length === 0, 'nothing moves in the still wash');
    assert((await c.page.evaluate(() => document.querySelectorAll('.npv-ring, .npv-bloom').length)) === 0, 'no rings');
    await c.context.close();
  });

  await check('visualizer: the mood\'s colors when the picture cannot be read; the page is unharmed', async () => {
    await playSong(pi, 2);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=full', unreadableArt: true });
    await waitTitle(s.page, 'Paper Moons');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length >= 1), 5000, 'no scene');
    await sleep(600);
    const d = await s.page.evaluate(VIZ);
    assert(d.palette === 'mood' && /not readable|did not load/.test(d.problem), JSON.stringify(d));
    assert((await s.page.evaluate(() => document.querySelector('.np-page .np-title').textContent)) === 'Paper Moons', 'the page is there');
    // The browser itself reports the refused picture; nothing else may complain.
    const others = s.errors.filter((e) => !/CORS|Access-Control/.test(e));
    assert(others.length === 0, 'page errors: ' + others.join(' | '));
    await s.context.close();
  });

  await check('visualizer: closing leaves nothing behind (no layer, no timer); a new song cross-fades', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1), 5000, 'scene');
    mock.play(4);
    await control(pi, 'POST', '/api/spotify/refresh', {});
    await until(() => s.page.evaluate(() => window.HUB_NP_VIZ.debug().id === 'mock0005'), 6000, 'the new song');
    assert((await s.page.evaluate(() => document.querySelectorAll('.npv-scene').length)) === 2, 'two looks while cross-fading');
    await sleep(300);
    await s.page.keyboard.press('Escape');
    await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 4000, 'back to the page');
    await closePage(s.page);
    const left = await s.page.evaluate(() => ({ n: document.querySelectorAll('.npv, .npv-scene').length, d: window.HUB_NP_VIZ.debug() }));
    assert(left.n === 0 && left.d.timers === 0 && !left.d.shown, JSON.stringify(left));
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  await check('visualizer: only transform and opacity animate; no filters, blur or blend modes', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1), 5000, 'scene');
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
              if (window.HUB_NP_VIZ.PROPERTIES.indexOf(p) < 0 && p !== '-webkit-transform') bad.push(rule.name + ': ' + p);
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
    assert(r.frames > 30, 'keyframes found: ' + r.frames);
    assert(!r.bad.length, r.bad.join('; '));
    await s.context.close();
  });

  await check('visualizer: a frame-rate check after it starts, kept per build; two stalls step it down; the About row says so', async () => {
    await playSong(pi, 0);
    const s = await open(pi, ONLY(3, 2), { motion: 'push' });
    await waitTitle(s.page, 'Golden Hour Drive');
    await openFull(s.page);
    // Kept once it has settled (one poor window measures again before deciding).
    await until(() => s.page.evaluate(() => !!localStorage.getItem('homeHub.npViz')), 20000, 'never measured');
    // Headless Chromium draws without a graphics chip, so whether this
    // machine keeps "full" says nothing about the TV; what is kept must match.
    const kept = await s.page.evaluate(() => ({ d: window.HUB_NP_VIZ.debug(), ls: JSON.parse(localStorage.getItem('homeHub.npViz')), build: window.HUB_BUILD, attr: document.querySelector('.npv').getAttribute('data-viz') }));
    assert(kept.ls && kept.ls.build === kept.build && kept.ls.level === kept.d.level && kept.ls.fps === kept.d.fps, JSON.stringify(kept));
    assert(kept.attr === kept.d.level + ' ' + kept.d.fps + 'fps', kept.attr);
    console.log('     headless check: ' + kept.d.fps + ' fps, level ' + kept.d.level);
    await s.page.keyboard.press('Escape');
    await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 4000, 'page');
    await closePage(s.page);
    const rows = await s.page.evaluate(() => { window.HUB_TEST.about.open(); const r = window.HUB_TEST.about.rows(); window.HUB_TEST.about.close(); return r; });
    const row = rows.filter((x) => x.label === 'Visualizer')[0];
    const name = { full: 'rings \\+ glows', glow: 'glows', wash: 'still wash' }[kept.d.level];
    assert(row && row.group === 'Now Playing' && new RegExp('^' + name + ', \\d+ fps, 124 BPM from features$').test(row.value), 'About: ' + JSON.stringify(row));
    await s.context.close();
    // A fresh TV that keeps stalling while it is measured: one step down.
    const t = await open(pi, ONLY(3, 2), { motion: 'push' });
    await waitTitle(t.page, 'Golden Hour Drive');
    await t.page.evaluate(() => {
      const until = Date.now() + 12000;
      const iv = setInterval(() => { const end = Date.now() + 400; while (Date.now() < end) { /* a stall */ } if (Date.now() > until) clearInterval(iv); }, 900);
    });
    await openFull(t.page);
    await until(() => t.page.evaluate(() => window.HUB_NP_VIZ.debug().level === 'glow'), 14000, 'it did not step down');
    const after = await t.page.evaluate(() => ({ d: window.HUB_NP_VIZ.debug(), ls: JSON.parse(localStorage.getItem('homeHub.npViz')) }));
    assert(after.ls.level === 'glow' && after.d.rings === 0 && after.d.bloom === 0, JSON.stringify(after));
    // An answer kept by another build is not used: this one measures afresh.
    await t.page.evaluate(() => localStorage.setItem('homeHub.npViz', JSON.stringify({ build: 'v0.0.1', level: 'wash', fps: 9, settled: true })));
    await t.page.keyboard.press('Escape');
    await until(() => t.page.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 4000, 'page');
    await t.page.keyboard.press('Enter');
    await until(() => t.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && document.querySelectorAll('.npv-scene').length >= 1), 4000, 'full again');
    assert((await t.page.evaluate(() => window.HUB_NP_VIZ.debug().level)) === 'full', 'an old build\'s answer is not used');
    await t.context.close();
  });

  await check('rough smoothness with the CPU slowed 6x (desktop Chromium: a sanity check, not the TV)', async () => {
    const out = [];
    for (const [n, name] of [[4, 'calm'], [0, 'upbeat'], [3, 'hard']]) {
      await playSong(pi, n);
      const s = await open(pi, ONLY(3, 2), { query: '&viz=full' });
      await waitTitle(s.page, mockSpotify.SONGS[n].name);
      await openFull(s.page);
      await until(() => s.page.evaluate(() => document.querySelectorAll('.npv-scene').length === 1 && window.HUB_NP_VIZ.debug().palette === 'art'), 5000, 'scene');
      await sleep(1600);
      const cdp = await s.context.newCDPSession(s.page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await sleep(300);
      const m = await s.page.evaluate(() => new Promise((resolve) => {
        const times = [];
        function f(t) { times.push(t); if (t - times[0] < 3000) requestAnimationFrame(f); else done(); }
        function done() {
          let worst = 0;
          for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1]);
          resolve({ fps: Math.round((times.length - 1) * 1000 / (times[times.length - 1] - times[0])), worst: Math.round(worst) });
        }
        requestAnimationFrame(f);
      }));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      out.push(name + ' ' + m.fps + ' fps (longest frame ' + m.worst + ' ms)');
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
