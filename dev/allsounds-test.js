/*
 * All sounds (the test widget), end to end: node dev/allsounds-test.js
 *
 * Runs the real hub in headless Chromium against the real hub server from
 * pi/ and the pretend Home Assistant (dev/mock-ha.js), on spare ports, with
 * a fresh data folder. Nothing reaches the internet, Home Assistant or
 * Amazon. Needs Playwright (require('playwright')) and port 8095 free.
 *
 * Checks: the "All sounds test" layout in the switcher (the one added pill,
 * the others as before) and the widget filling the screen there; every state
 * (a radio show with its picture, music, paused, nothing playing, not set
 * up, Home Assistant refusing the token or away, the Pi lost) in English and
 * Spanish; several tile sizes in English, Spanish and Spanish 25% longer
 * (nothing outside the tile, nothing overlapping, line heights with room for
 * accents); the page and full screen; a language change redrawing it; no
 * Home Assistant token or address on the page.
 *
 * SHOTS=/some/folder also saves screenshots (1920x1080, device scale 1).
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
const mockHa = require('./mock-ha');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const SHOTS = process.env.SHOTS || '';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', '192.168.1.219', 'api.github.com'];

let PAGE_PORT, PAGE, preview = null, browser = null, ha = null;
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
  if (process.env.AS_GREP && name.indexOf(process.env.AS_GREP) < 0) return;
  try { await fn(); results.push(true); console.log('ok   ' + name); }
  catch (e) { results.push(false); console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}

/* ---------- servers ---------- */

// withHa false: no HA_TOKEN, so All sounds is "not set up".
async function startPi(withHa) {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-as-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    allsoundsEnv: withHa === false ? {} : { HA_URL: ha.url, HA_TOKEN: ha.token },
    echoEnv: withHa === false ? {} : { HA_URL: ha.url, HA_TOKEN: ha.token },
    allsounds: { allowHttp: true, manual: true, timeoutMs: 400 }
  });
  await h.ready;
  const pi = { h: h, port: port, url: 'http://127.0.0.1:' + port, dir: dir };
  pis.push(pi);
  return pi;
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

// The pretend house in a mode, read now (twice: a network error needs two).
async function house(pi, mode) {
  ha.set(mode);
  await pi.h.allsounds.poll();
  await pi.h.allsounds.poll();
}

/* ---------- pages ---------- */

const ONLY = (w, h, x, y) => [{ widget: 'allsounds', x: x || 0, y: y || 0, w: w, h: h }];
const TEST_LAYOUT = ONLY(12, 6);

async function open(pi, layout, opts) {
  const o = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-US' });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (BLOCKED.indexOf(u.hostname) >= 0) return route.abort();
    // The real picture hosts of the samples answer with a made-up cover.
    if (mockHa.ART_HOSTS[u.hostname]) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: mockHa.svg(mockHa.ART_HOSTS[u.hostname]) });
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await context.addInitScript((a) => {
    try {
      if (a.lay) localStorage.setItem('homeHub.layout', JSON.stringify(a.lay));
      localStorage.setItem('homeHub.lang', a.lang);
    } catch (e) { /* ignore */ }
  }, { lay: layout, lang: o.lang || 'en' });
  if (pi && layout) await control(pi, 'POST', '/api/layout', { layout: layout });
  await page.goto(PAGE + '/hub.html?live=' + (pi ? encodeURIComponent(pi.url) : 'off') + '&motion=fade&clay=off' + (o.query || ''));
  await page.waitForSelector('.tile', { state: 'attached' });   // a one-widget layout keeps its tile hidden while its window opens
  return { page: page, context: context, errors: errors };
}

const tileText = (page) => page.evaluate(() => {
  const vis = (e) => !!e && e.offsetParent !== null && getComputedStyle(e).display !== 'none';
  const t = (s) => { const e = document.querySelector('.as-tile ' + s); return vis(e) ? e.textContent : null; };
  return {
    kind: ((document.querySelector('.as-tile') || {}).className || '').replace(/.*as-k-(\w+).*/, '$1'),
    head: t('.tile-title'), badge: t('.tile-badge'), label: t('.as-label-text'),
    title: t('.as-title') || t('.as-msg'), sub: t('.as-sub'), hint: t('.as-hint'), plat: t('.as-plat'), device: t('.as-device'), stale: t('.as-stale')
  };
});

const waitKind = (page, kind, title) => until(async () => {
  const t = await tileText(page);
  return t.kind === kind && (!title || t.title === title) ? t : false;
}, 6000, 'the tile never showed ' + kind + (title ? ' "' + title + '"' : '')).catch(async (e) => {
  throw new Error(e.message + ' (it shows ' + JSON.stringify(await tileText(page)) + ')');
});

// Anything that sticks out of the tile, overlapping words, tight line heights.
function problems(page, rootSel) {
  return page.evaluate((sel) => {
    const out = [];
    const root = document.querySelector(sel || '.as-tile');
    if (!root) return ['no All sounds ' + (sel || 'tile')];
    const box = (sel === '.as-page' ? document.querySelector('#panel') : root.closest('.tile')).getBoundingClientRect();
    root.querySelectorAll('*').forEach((e) => {
      if (e.offsetParent === null || getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return;
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (r.left < box.left - 2 || r.right > box.right + 2 || r.top < box.top - 2 || r.bottom > box.bottom + 2) {
        out.push(e.className + ' sticks out: ' + [r.left - box.left, box.right - r.right, r.top - box.top, box.bottom - r.bottom].map(Math.round).join(','));
      }
      if (/^as-(title|sub|album|label-text|plat-name|chip|device|msg|hint)$/.test(String(e.className).split(' ')[0])) {
        const cs = getComputedStyle(e);
        const lh = parseFloat(cs.lineHeight);
        if (lh && lh < parseFloat(cs.fontSize) * 1.24) out.push(e.className + ' line height too tight: ' + lh + '/' + cs.fontSize);
        if (parseFloat(cs.fontSize) < (e.className === 'as-plat-name' ? 0.7 : 0.8) * 16 - 0.5) out.push(e.className + ' type too small: ' + cs.fontSize);
        // Cut sideways without "...": only the one-line pieces may end in "...".
        if (e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.push(e.className + ' cut sideways');
      }
    });
    const texts = Array.prototype.filter.call(root.querySelectorAll('.as-title,.as-sub,.as-album,.as-label,.as-meta,.as-msg,.as-hint,.tile-head,.as-chips'),
      (e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].getBoundingClientRect();
        const b = texts[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(texts[i].className + ' overlaps ' + texts[j].className);
      }
    }
    const art = root.querySelector('.as-art');
    const text = root.querySelector('.as-text, .as-info');
    if (art && text && text.offsetParent !== null) {
      const a = art.getBoundingClientRect();
      const b = text.getBoundingClientRect();
      if (b.height && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push('the picture overlaps the words');
    }
    return out;
  }, rootSel || '');
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, name), type: 'png' });
}

// Spanish 25% longer for every All sounds word (with accents and ñ), then a
// redraw through a language change, as dev/money-i18n-test.js does.
async function longerSpanish(page) {
  await page.evaluate(() => {
    const L = window.HUB_I18N;
    const t = L.t;
    L.t = function (key, en, vars) {
      const s = t.call(L, key, en, vars);
      if (L.lang() !== 'es' || String(key).indexOf('allsounds.') !== 0) return s;
      const extra = Math.ceil(s.length * 0.25);
      let pad = '';
      while (pad.length < extra) pad += ' ÁÉñ¿¡';
      return s + pad.slice(0, extra);
    };
    L.setLang('en');
    L.setLang('es');
  });
}

const SIZES = [[2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 3], [3, 4], [6, 3], [4, 6], [12, 6]];

async function sizeSweep(pi, s, label) {
  const bad = [];
  for (const [w, h] of SIZES) {
    await control(pi, 'POST', '/api/layout', { layout: ONLY(w, h) });
    await until(() => s.page.evaluate((c) => {
      const t = document.querySelector('.tile');
      const r = t.getBoundingClientRect();
      return Math.abs(r.width - (c.w * 1920 / 12 - 24 - 14)) < 30 && Math.abs(r.height - (c.h * (1080 - 36) / 6 - 14)) < 30 && !!document.querySelector('.as-tile');
    }, { w: w, h: h }), 5000, 'the layout ' + w + 'x' + h + ' was not applied');
    await sleep(150);
    const p = await problems(s.page);
    if (p.length) bad.push(label + ' ' + w + 'x' + h + ': ' + p.join('; '));
  }
  return bad;
}

/* ---------- the checks ---------- */

async function main() {
  PAGE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  ha = await mockHa.start({ mode: 'radio' });
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PAGE_PORT, path: '/', timeout: 500 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  browser = await chromium.launch();

  const pi = await startPi(true);
  const noHa = await startPi(false);

  await check('the switcher: the stock pills as before plus "All sounds test" at the end, none cut; it is the active one', async () => {
    await house(pi, 'radio');
    const s = await open(pi, TEST_LAYOUT);
    await waitKind(s.page, 'playing', 'Morning Edition');
    const cfg = await s.page.evaluate(() => window.HUB_CONFIG.layouts.map((l) => l.name));
    assert(cfg.join('|') === 'Default|Main|Get ready|AWWS desk|AWWS one screen|AWWS money|Budget|All sounds test|Plants|Ambience test|Hub architecture', 'layouts: ' + cfg.join(', '));
    // A one-widget layout opens straight into its window: Back to its tile, then Up.
    if (TEST_LAYOUT.length === 1 && TEST_LAYOUT[0].w === 12 && TEST_LAYOUT[0].h === 6) {
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'allsounds' && !window.HUB_TEST.busy()), 5000, 'the one-widget layout did not open');
      await s.page.keyboard.press('Escape');
      await until(() => s.page.evaluate(() => !window.HUB_TEST.open() && !window.HUB_TEST.busy()), 5000, 'Back did not close it');
    }
    await s.page.keyboard.press('ArrowUp');
    await until(() => s.page.evaluate(() => document.querySelectorAll('.switcher-item').length > 0), 3000, 'the switcher did not open');
    await sleep(400);
    const bar = await s.page.evaluate(() => {
      const b = document.querySelector('.switcher-bar');
      return {
        over: b.scrollWidth > b.clientWidth + 1, w: window.innerWidth,
        active: (document.querySelector('.switcher-item.is-active') || {}).textContent,
        items: Array.prototype.map.call(document.querySelectorAll('.switcher-item'), (n) => {
          const r = n.getBoundingClientRect();
          const name = n.querySelector('.switcher-name');
          return { name: n.textContent, l: r.left, r: r.right, cut: name.scrollWidth > name.clientWidth + 1 };
        })
      };
    });
    assert(bar.items.map((i) => i.name).join('|') === cfg.join('|'), 'pills: ' + bar.items.map((i) => i.name).join(', '));
    assert(!bar.over, 'the bar overflows');
    for (const it of bar.items) assert(it.l >= 0 && it.r <= bar.w && !it.cut, 'pill cut: ' + it.name);
    assert(bar.active === 'All sounds test', 'active: ' + bar.active);
    await shot(s.page, 'allsounds-switcher-en.png');
    const cells = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell'), (c) => c.getAttribute('data-widget')).join());
    assert(cells === 'allsounds', 'one widget: ' + cells);
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
  });

  // Every state, full screen tile, both languages: the words and the fit.
  const STATES = [
    { name: 'radio', mode: 'radio', kind: 'playing', en: { title: 'Morning Edition', sub: 'KERA 90.1 Dallas', plat: '(TuneIn)', device: 'Living room Echo', label: 'Now playing' }, es: { label: 'Sonando ahora' }, art: true },
    { name: 'music', mode: 'music', kind: 'playing', en: { title: 'Golden Hour Drive', sub: 'The Lanterns', plat: '(Amazon Music)', device: 'Living room Echo', stale: null }, art: true },
    { name: 'paused', mode: 'paused', kind: 'paused', en: { title: 'Golden Hour Drive', label: 'Paused' }, es: { label: 'En pausa' }, art: true },
    // Real shapes from an Echo Show: Amazon Music names no app (its platform
    // comes from the picture's host);
    // TuneIn sends the station name and a picture, no artist (the title, then
    // the speaker); in its first seconds it sends nothing at all (plain
    // words, the speaker, the music mark).
    { name: 'amazonmusic', mode: 'amazonmusic', kind: 'playing', en: { title: 'Golden Hour Drive', sub: 'The Lanterns', plat: '(Amazon Music)', device: "Ian's Echo Show", stale: null }, es: { stale: null }, art: true },
    // The same shape from Pandora's picture host: "(Pandora)" after the label.
    { name: 'pandora', mode: 'pandora', kind: 'playing', en: { title: 'Golden Hour Drive', sub: 'The Lanterns', plat: '(Pandora)', device: "Ian's Echo Show", label: 'Now playing' }, es: { label: 'Sonando ahora' }, art: true },
    // Audible took over and the Echo still says it plays a song that ended
    // minutes ago: the song, with a small quiet line under the title.
    { name: 'stale', mode: 'stale', kind: 'playing', en: { title: 'Golden Hour Drive', sub: 'The Lanterns', device: "Ian's Echo Show", stale: 'May be out of date' },
      es: { stale: 'Puede que no esté al día' }, art: true },
    { name: 'tunein', mode: 'tunein', kind: 'playing', en: { title: 'KERA', sub: null, plat: null, device: "Ian's Echo Show", label: 'Now playing' },
      es: { sub: null, plat: null, label: 'Sonando ahora' }, art: true },
    { name: 'tunein-start', mode: 'tuneinstart', kind: 'playing', en: { title: 'Something is playing', sub: null, plat: null, device: "Ian's Echo Show", label: 'Now playing' },
      es: { title: 'Algo está sonando', sub: null, plat: null, device: "Ian's Echo Show", label: 'Sonando ahora' }, noArt: true },
    { name: 'nothing', mode: 'npr', kind: 'idle', en: { title: 'Nothing playing', badge: 'Quiet', head: 'All sounds' }, es: { title: 'Nada sonando', badge: 'En silencio', head: 'Todo lo que suena' } },
    { name: 'notset', pi: 'noHa', kind: 'notset', en: { title: 'Not set up yet' }, es: { title: 'Aún sin configurar' } },
    { name: 'cant-reach', mode: 'down', kind: 'error', en: { title: 'Can’t reach Home Assistant', hint: 'It keeps trying by itself.' }, es: { title: 'No se puede conectar con Home Assistant' } },
    { name: 'refused', mode: 'unauthorized', kind: 'error', en: { hint: 'Home Assistant refused the token. Make a new one and put it in pi/.env.' } }
  ];
  for (const lang of ['en', 'es']) {
    for (const st of STATES) {
      await check('state "' + st.name + '" (' + lang + '): the words, the picture, nothing outside the tile', async () => {
        const p = st.pi === 'noHa' ? noHa : pi;
        if (st.mode) await house(p, st.mode);
        const s = await open(p, TEST_LAYOUT, { lang: lang });
        const want = Object.assign({}, lang === 'en' ? st.en : {}, lang === 'es' ? (st.es || {}) : {});
        if (lang === 'es') ['plat', 'device', 'sub'].forEach((k) => { if (st.en[k]) want[k] = st.en[k]; });
        if (lang === 'es' && st.en.title && !(st.es && st.es.title) && st.kind !== 'idle' && st.kind !== 'notset' && st.kind !== 'error') want.title = st.en.title;
        const t = await waitKind(s.page, st.kind, want.title);
        Object.keys(want).forEach((k) => assert(t[k] === want[k], k + ': ' + JSON.stringify(t[k]) + ', wanted ' + JSON.stringify(want[k])));
        if (st.art) {
          await until(() => s.page.evaluate(() => { const i = document.querySelector('.as-tile .as-img'); return !!i && i.complete && i.naturalWidth > 0 && /is-loaded/.test(i.className); }), 4000, 'the picture did not load');
        }
        if (st.noArt) {
          await sleep(300);
          assert(await s.page.evaluate(() => !document.querySelector('.as-tile .as-img') && !!document.querySelector('.as-tile .as-mark')), 'no picture, the music mark instead');
        }
        const bad = await problems(s.page);
        assert(!bad.length, bad.join('; '));
        const html = await s.page.content();
        [ha.token, 'abc123', 'media_player_proxy', ':8123'].forEach((x) => assert(html.indexOf(x) < 0, x + ' is on the page'));
        if (st.name !== 'refused') await shot(s.page, 'allsounds-' + lang + '-' + st.name + '.png');
        assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
        await s.context.close();
      });
    }
  }

  await check('Spotify playing wins over the Echo and shows with its own platform; Now Playing still has its own data', async () => {
    const sp = await require('./mock-spotify').start({});
    const port = await spare();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-as-test-'));
    tmp.push(dir);
    const h = require(path.join(ROOT, 'pi', 'server.js')).start({
      token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
      allsoundsEnv: { HA_URL: ha.url, HA_TOKEN: ha.token }, allsounds: { allowHttp: true, manual: true, timeoutMs: 400 },
      spotifyEnv: { SPOTIFY_CLIENT_ID: sp.clientId, SPOTIFY_CLIENT_SECRET: sp.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback' },
      spotify: { accounts: sp.url, api: sp.url, vibe: sp.url, allowHttp: true, manual: true, vibeOff: true }
    });
    await h.ready;
    const p5 = { h: h, port: port, url: 'http://127.0.0.1:' + port, dir: dir };
    pis.push(p5);
    await house(p5, 'radio');
    const s = await open(p5, TEST_LAYOUT);
    await waitKind(s.page, 'playing', 'Morning Edition');
    const l = h.spotify.loginUrl();
    await new Promise((resolve, reject) => http.get(l.url, (res) => { res.resume(); h.spotify.finishLogin(res.headers.location || '').then(resolve, reject); }).on('error', reject));
    const t = await waitKind(s.page, 'playing', 'Golden Hour Drive');
    assert(t.plat === '(Spotify)', 'platform: ' + t.plat);
    assert(t.sub === 'The Lanterns', 'sub: ' + t.sub);
    await until(() => s.page.evaluate(() => { const i = document.querySelector('.as-tile .as-img'); return !!i && /is-loaded/.test(i.className); }), 4000, 'the picture did not load');
    const np = await s.page.evaluate(() => window.HUB_LIVE.get('nowplaying'));
    assert(np && np.state === 'playing' && np.track && np.track.title === 'Golden Hour Drive', 'nowplaying as before');
    await shot(s.page, 'allsounds-en-spotify.png');
    await s.context.close();
    await stopPi(p5);
    await sp.close();
  });

  await check('a long Spanish song and speaker name at every size; English, Spanish and Spanish 25% longer; the "may be out of date" line too', async () => {
    const p2 = await startPi(true);
    await house(p2, 'long');
    const bad = [];
    for (const lang of ['en', 'es', 'es+25']) {
      const s = await open(p2, ONLY(SIZES[0][0], SIZES[0][1]), { lang: lang === 'en' ? 'en' : 'es' });
      await waitKind(s.page, 'playing');
      if (lang === 'es+25') await longerSpanish(s.page);
      bad.push.apply(bad, await sizeSweep(p2, s, lang));
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    }
    // The "may be out of date" line at every size (it goes before the title does).
    await house(p2, 'stale');
    for (const lang of ['en', 'es+25']) {
      const s = await open(p2, ONLY(SIZES[0][0], SIZES[0][1]), { lang: lang === 'en' ? 'en' : 'es' });
      await waitKind(s.page, 'playing');
      if (lang === 'es+25') await longerSpanish(s.page);
      bad.push.apply(bad, await sizeSweep(p2, s, 'stale ' + lang));
      await s.context.close();
    }
    for (const mode of ['idle', 'down']) {
      await house(p2, mode);
      for (const lang of ['en', 'es+25']) {
        const s = await open(p2, ONLY(SIZES[0][0], SIZES[0][1]), { lang: lang === 'en' ? 'en' : 'es' });
        await waitKind(s.page, mode === 'idle' ? 'idle' : 'error');
        if (lang === 'es+25') await longerSpanish(s.page);
        bad.push.apply(bad, await sizeSweep(p2, s, mode + ' ' + lang));
        await s.context.close();
      }
    }
    await stopPi(p2);
    assert(!bad.length, bad.join(' | '));
  });

  // Echo controls: the hub started Audible on the Echo Show, which still
  // reports its old song. The tile names the app and the speaker, with a
  // quiet "Started from the hub" line, at every size and in Spanish +25%.
  await check('started from the hub: Audible on the Echo Show replaces the stale song, every size, English and Spanish', async () => {
    const p2 = await startPi(true);
    await house(p2, 'stale');
    const r = await control(p2, 'POST', '/api/echo', { action: 'start', app: 'audible', target: 'show' });
    assert(r.ok === true, 'start: ' + JSON.stringify(r));
    await p2.h.allsounds.poll();
    const bad = [];
    for (const lang of ['en', 'es', 'es+25']) {
      const s = await open(p2, TEST_LAYOUT, { lang: lang === 'en' ? 'en' : 'es' });
      const t = await waitKind(s.page, 'playing', 'Audible');
      const want = { title: 'Audible', device: "Ian's Echo Show", stale: lang === 'en' ? 'Started from the hub' : 'Iniciado desde el hub', sub: null };
      if (lang !== 'es+25') Object.keys(want).forEach((k) => assert(t[k] === want[k], lang + ' ' + k + ': ' + JSON.stringify(t[k])));
      if (lang !== 'es+25') await shot(s.page, 'allsounds-started-' + lang + '.png');
      await s.context.close();
      const s2 = await open(p2, ONLY(SIZES[0][0], SIZES[0][1]), { lang: lang === 'en' ? 'en' : 'es' });
      await waitKind(s2.page, 'playing');
      if (lang === 'es+25') await longerSpanish(s2.page);
      bad.push.apply(bad, await sizeSweep(p2, s2, 'started ' + lang));
      assert(s2.errors.length === 0, 'page errors: ' + s2.errors.join(' | '));
      await s2.context.close();
    }
    await stopPi(p2);
    assert(!bad.length, bad.join(' | '));
  });

  await check('sound the TV plays itself (./hub news) comes first, "Living room TV" as the speaker, every size, English and Spanish; stop gives the Echo back', async () => {
    const n = 8000 * 30;
    const wav = Buffer.alloc(44 + n, 128);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + n, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(n, 40);
    const audio = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); });
    await new Promise((r) => audio.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + audio.address().port + '/news.wav';
    const p5 = await startPi(true);
    await house(p5, 'stale');
    await control(p5, 'POST', '/api/echo', { action: 'start', app: 'audible', target: 'show' });
    await p5.h.allsounds.poll();
    const bad = [];
    try {
      for (const lang of ['en', 'es', 'es+25']) {
        const s = await open(p5, TEST_LAYOUT, { lang: lang === 'en' ? 'en' : 'es' });
        await waitKind(s.page, 'playing', 'Audible');
        const r = await control(p5, 'POST', '/api/command', { type: 'play', data: { url: url, title: 'NPR News Now, 8pm ET, November 19' } });
        assert(r.delivered === 1, 'play: ' + JSON.stringify(r));
        const t = await waitKind(s.page, 'playing', 'NPR News Now');
        if (lang !== 'es+25') {
          assert(t.sub === '8pm ET, November 19', lang + ' sub: ' + t.sub);
          assert(t.device === (lang === 'en' ? 'Living room TV' : 'Televisor de la sala'), lang + ' device: ' + t.device);
          assert(t.stale === null && t.plat === null, lang + ' extra lines: ' + JSON.stringify(t));
          if (SHOTS) await sleep(7000);   // the "Playing" toast has gone, so only the tile differs
          await shot(s.page, 'allsounds-tv-' + lang + '.png');
        }
        await control(p5, 'POST', '/api/command', { type: 'stop', data: {} });
        await waitKind(s.page, 'playing', 'Audible');
        await s.context.close();
        const s2 = await open(p5, ONLY(SIZES[0][0], SIZES[0][1]), { lang: lang === 'en' ? 'en' : 'es' });
        await waitKind(s2.page, 'playing');   // the smallest size has no words
        await control(p5, 'POST', '/api/command', { type: 'play', data: { url: url, title: 'NPR News Now, 8pm ET, November 19' } });
        await until(() => s2.page.evaluate(() => { const n = window.HUB_AUDIO.now(); return !!n && n.state === 'playing'; }), 5000, 'the TV did not play');
        if (lang === 'es+25') await longerSpanish(s2.page);
        bad.push.apply(bad, await sizeSweep(p5, s2, 'tv ' + lang));
        assert(s2.errors.length === 0, 'page errors: ' + s2.errors.join(' | '));
        await s2.context.close();
      }
    } finally {
      await stopPi(p5);
      audio.close();
    }
    assert(!bad.length, bad.join(' | '));
  });

  await check('the page and full screen: the words, the platform after the label, the speaker chip, nothing outside the panel', async () => {
    const p3 = await startPi(true);
    await house(p3, 'radio');
    for (const lang of ['en', 'es']) {
      const s = await open(p3, ONLY(3, 2), { lang: lang });
      await waitKind(s.page, 'playing', 'Morning Edition');
      await s.page.evaluate(() => window.HUB_TEST.openPanel('allsounds'));
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'allsounds' && !window.HUB_TEST.busy() && !!document.querySelector('.as-page .as-title')), 5000, 'the page did not open');
      const chips = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.as-page .as-chip'), (c) => c.textContent));
      assert(chips.join('|') === (lang === 'en' ? 'On Living room Echo' : 'En Living room Echo'), 'chips: ' + chips.join(', '));
      const plat = await s.page.evaluate(() => (document.querySelector('.as-page .as-label .as-plat') || {}).textContent);
      assert(plat === '(TuneIn)', 'platform on the page: ' + plat);
      const head = await s.page.evaluate(() => (document.querySelector('#panel .panel-title') || {}).textContent);
      assert(head === (lang === 'en' ? 'All sounds' : 'Todo lo que suena'), 'panel title: ' + head);
      let bad = await problems(s.page, '.as-page');
      assert(!bad.length, 'page: ' + bad.join('; '));
      await shot(s.page, 'allsounds-' + lang + '-page.png');
      await s.page.keyboard.press('Enter');
      await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.as-page.is-full')), 5000, 'full screen did not open');
      bad = await problems(s.page, '.as-page');
      assert(!bad.length, 'full: ' + bad.join('; '));
      await shot(s.page, 'allsounds-' + lang + '-full.png');
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    }
    await stopPi(p3);
  });

  await check('a language change redraws the tile; the Pi lost says so', async () => {
    const p4 = await startPi(true);
    await house(p4, 'idle');
    const s = await open(p4, TEST_LAYOUT);
    await waitKind(s.page, 'idle', 'Nothing playing');
    await s.page.evaluate(() => window.HUB_I18N.setLang('es'));
    await waitKind(s.page, 'idle', 'Nada sonando');
    await s.page.evaluate(() => window.HUB_I18N.setLang('en'));
    await waitKind(s.page, 'idle', 'Nothing playing');
    await stopPi(p4);
    await waitKind(s.page, 'offline', 'Can’t reach the Pi');
    assert(!(await problems(s.page)).length, 'fits');
    await s.context.close();
  });
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  for (const p of pis.slice()) { try { await stopPi(p); } catch (e) { /* ignore */ } }
  try { if (ha) await ha.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  tmp.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  const passed = results.filter(Boolean).length;
  console.log(passed + ' passed, ' + (results.length - passed) + ' failed');
  process.exit(results.length - passed ? 1 : 0);
});
