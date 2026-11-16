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
    spotify: { accounts: mock.url, api: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 }
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
  await page.goto(PAGE + '/hub.html?live=' + (pi ? encodeURIComponent(pi.url) : 'off') + '&motion=fade');
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

main().catch((e) => {
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
