/*
 * Sound control (the test widget), end to end: node dev/soundctl-test.js
 *
 * Runs the real hub in headless Chromium against the real hub server from
 * pi/ and the pretend Home Assistant (dev/mock-ha.js), on spare ports, with
 * a fresh data folder. Nothing reaches the internet, Home Assistant or
 * Amazon. Needs Playwright (require('playwright')) and port 8095 free.
 *
 * Checks: the "Sound control test" layout in the switcher (the one added pill,
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
  if (process.env.SC_GREP && name.indexOf(process.env.SC_GREP) < 0) return;
  try { await fn(); results.push(true); console.log('ok   ' + name); }
  catch (e) { results.push(false); console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message : e)); }
}

/* ---------- servers ---------- */

// withHa false: no HA_TOKEN, so All sounds is "not set up".
async function startPi(withHa, noEcho) {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sc-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    allsoundsEnv: withHa === false ? {} : { HA_URL: ha.url, HA_TOKEN: ha.token },
    echoEnv: withHa === false || noEcho ? {} : { HA_URL: ha.url, HA_TOKEN: ha.token },
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

const ONLY = (w, h, x, y) => [{ widget: 'soundctl', x: x || 0, y: y || 0, w: w, h: h }];
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
  const t = (s) => { const e = document.querySelector('.sc-tile ' + s); return vis(e) ? e.textContent : null; };
  return {
    kind: ((document.querySelector('.sc-tile') || {}).className || '').replace(/.*sc-k-(\w+).*/, '$1'),
    head: t('.tile-title'), badge: t('.tile-badge'), label: t('.sc-label-text'),
    title: t('.sc-title') || t('.sc-msg'), sub: t('.sc-sub'), hint: t('.sc-hint'), plat: t('.sc-plat'), device: t('.sc-device'), stale: t('.sc-stale')
  };
});

const waitKind = (page, kind, title) => until(async () => {
  const t = await tileText(page);
  return t.kind === kind && (!title || t.title === title) ? t : false;
}, 6000, 'the tile never showed ' + kind + (title ? ' "' + title + '"' : ''));

// Anything that sticks out of the tile, overlapping words, tight line heights.
function problems(page, rootSel) {
  return page.evaluate((sel) => {
    const out = [];
    const root = document.querySelector(sel || '.sc-tile');
    if (!root) return ['no All sounds ' + (sel || 'tile')];
    const box = (sel === '.sc-page' ? document.querySelector('#panel') : root.closest('.tile')).getBoundingClientRect();
    root.querySelectorAll('*').forEach((e) => {
      if (e.offsetParent === null || getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return;
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) return;
      // The quick-start rail runs past the edge on purpose (it moves): only its height is checked.
      const onRail = !!(e.closest && e.closest('.sc-track'));
      if ((!onRail && (r.left < box.left - 2 || r.right > box.right + 2)) || r.top < box.top - 2 || r.bottom > box.bottom + 2) {
        out.push(e.className + ' sticks out: ' + [r.left - box.left, box.right - r.right, r.top - box.top, box.bottom - r.bottom].map(Math.round).join(','));
      }
      if (/^sc-(title|sub|album|label-text|plat-name|chip|device|msg|hint)$/.test(String(e.className).split(' ')[0])) {
        const cs = getComputedStyle(e);
        const lh = parseFloat(cs.lineHeight);
        if (lh && lh < parseFloat(cs.fontSize) * 1.24) out.push(e.className + ' line height too tight: ' + lh + '/' + cs.fontSize);
        if (parseFloat(cs.fontSize) < (e.className === 'sc-plat-name' ? 0.7 : 0.8) * 16 - 0.5) out.push(e.className + ' type too small: ' + cs.fontSize);
        // Cut sideways without "...": only the one-line pieces may end in "...".
        if (e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.push(e.className + ' cut sideways');
      }
    });
    const texts = Array.prototype.filter.call(root.querySelectorAll('.sc-title,.sc-sub,.sc-album,.sc-label,.sc-meta,.sc-msg,.sc-hint,.tile-head,.sc-chips'),
      (e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i].getBoundingClientRect();
        const b = texts[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(texts[i].className + ' overlaps ' + texts[j].className);
      }
    }
    const art = root.querySelector('.sc-art');
    const text = root.querySelector('.sc-text, .sc-info');
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
      if (L.lang() !== 'es' || String(key).indexOf('soundctl.') !== 0) return s;
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
      return Math.abs(r.width - (c.w * 1920 / 12 - 24 - 14)) < 30 && Math.abs(r.height - (c.h * (1080 - 36) / 6 - 14)) < 30 && !!document.querySelector('.sc-tile');
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

  await check('the switcher: the stock pills as before plus "Sound control test" at the end, none cut; it is the active one', async () => {
    await house(pi, 'radio');
    const s = await open(pi, TEST_LAYOUT);
    await waitKind(s.page, 'playing', 'Morning Edition');
    const cfg = await s.page.evaluate(() => window.HUB_CONFIG.layouts.map((l) => l.name));
    assert(cfg.join('|') === 'Default|Main|Get ready|AWWS desk|AWWS one screen|AWWS money|Budget|All sounds test|Sound control test|Plants|Ambience test|Hub architecture', 'layouts: ' + cfg.join(', '));
    // A one-widget layout opens straight into its window: Back to its tile, then Up.
    if (TEST_LAYOUT.length === 1 && TEST_LAYOUT[0].w === 12 && TEST_LAYOUT[0].h === 6) {
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'soundctl' && !window.HUB_TEST.busy()), 5000, 'the one-widget layout did not open');
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
    assert(bar.active === 'Sound control test', 'active: ' + bar.active);
    await shot(s.page, 'soundctl-switcher-en.png');
    const cells = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell'), (c) => c.getAttribute('data-widget')).join());
    assert(cells === 'soundctl', 'one widget: ' + cells);
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
    { name: 'nothing', mode: 'npr', kind: 'idle', en: { title: 'Nothing playing', badge: 'Quiet', head: 'Sound control' }, es: { title: 'Nada sonando', badge: 'En silencio', head: 'Control de sonido' } },
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
          await until(() => s.page.evaluate(() => { const i = document.querySelector('.sc-tile .sc-img'); return !!i && i.complete && i.naturalWidth > 0 && /is-loaded/.test(i.className); }), 4000, 'the picture did not load');
        }
        if (st.noArt) {
          await sleep(300);
          assert(await s.page.evaluate(() => !document.querySelector('.sc-tile .sc-img') && !!document.querySelector('.sc-tile .sc-mark')), 'no picture, the music mark instead');
        }
        const bad = await problems(s.page);
        assert(!bad.length, bad.join('; '));
        const html = await s.page.content();
        [ha.token, 'abc123', 'media_player_proxy', ':8123'].forEach((x) => assert(html.indexOf(x) < 0, x + ' is on the page'));
        if (st.name !== 'refused') await shot(s.page, 'soundctl-' + lang + '-' + st.name + '.png');
        assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
        await s.context.close();
      });
    }
  }

  await check('Spotify playing wins over the Echo and shows with its own platform; Now Playing still has its own data', async () => {
    const sp = await require('./mock-spotify').start({});
    const port = await spare();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sc-test-'));
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
    await until(() => s.page.evaluate(() => { const i = document.querySelector('.sc-tile .sc-img'); return !!i && /is-loaded/.test(i.className); }), 4000, 'the picture did not load');
    const np = await s.page.evaluate(() => window.HUB_LIVE.get('nowplaying'));
    assert(np && np.state === 'playing' && np.track && np.track.title === 'Golden Hour Drive', 'nowplaying as before');
    await shot(s.page, 'soundctl-en-spotify.png');
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
      if (lang !== 'es+25') await shot(s.page, 'soundctl-started-' + lang + '.png');
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

  await check('the page and full screen: the words, the platform after the label, the speaker chip, nothing outside the panel', async () => {
    const p3 = await startPi(true);
    await house(p3, 'radio');
    for (const lang of ['en', 'es']) {
      const s = await open(p3, ONLY(3, 2), { lang: lang });
      await waitKind(s.page, 'playing', 'Morning Edition');
      await s.page.evaluate(() => window.HUB_TEST.openPanel('soundctl'));
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'soundctl' && !window.HUB_TEST.busy() && !!document.querySelector('.sc-page .sc-title')), 5000, 'the page did not open');
      const chips = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-page .sc-chip'), (c) => c.textContent));
      assert(chips.join('|') === (lang === 'en' ? 'On Living room Echo' : 'En Living room Echo'), 'chips: ' + chips.join(', '));
      const plat = await s.page.evaluate(() => (document.querySelector('.sc-page .sc-label .sc-plat') || {}).textContent);
      assert(plat === '(TuneIn)', 'platform on the page: ' + plat);
      const head = await s.page.evaluate(() => (document.querySelector('#panel .panel-title') || {}).textContent);
      assert(head === (lang === 'en' ? 'Sound control' : 'Control de sonido'), 'panel title: ' + head);
      let bad = await problems(s.page, '.sc-page');
      assert(!bad.length, 'page: ' + bad.join('; '));
      await shot(s.page, 'soundctl-' + lang + '-page.png');
      await s.page.keyboard.press('ArrowUp');
      await s.page.keyboard.press('ArrowUp');
      await s.page.keyboard.press('Enter');
      await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.sc-page.is-full')), 5000, 'full screen did not open');
      bad = await problems(s.page, '.sc-page');
      assert(!bad.length, 'full: ' + bad.join('; '));
      await shot(s.page, 'soundctl-' + lang + '-full.png');
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    }
    await stopPi(p3);
  });


  /* ---------- the Echo control panel ---------- */

  const sleepMs = sleep;
  const LONGS = [['en', false], ['es', false], ['es', true]];

  // Opens the page (or full screen) of the widget in a tile of w x h; the
  // Echo Show plays (the pretend house's amazonmusic mode).
  async function openPage(pi, lang, longer, w, h, full) {
    const s = await open(pi, ONLY(w, h), { lang: lang });
    s.label = w + 'x' + h + ' ' + lang + (longer ? '+25' : '') + (full ? ' full' : '');
    await until(() => s.page.evaluate(() => !!document.querySelector('.sc-tile')), 6000, 'no tile');
    await s.page.evaluate(() => window.HUB_TEST.openPanel('soundctl'));
    await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'soundctl' && !window.HUB_TEST.busy() && !!document.querySelector('.sc-page .sc-title')), 5000, 'the page did not open');
    if (longer && lang === 'es') await longerSpanish(s.page);
    if (full) {
      await s.page.keyboard.press('ArrowUp');
      await sleepMs(120);
      await s.page.keyboard.press('ArrowUp');
      await sleepMs(120);
      await s.page.keyboard.press('Enter');
      await until(() => s.page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.sc-page.is-full')), 5000, 'full screen did not open (' + s.label + ': focus ' + (await focusKey(s.page)) + ')');
    }
    await sleepMs(250);
    return s;
  }

  const mainWord = (page) => page.evaluate(() => (document.querySelector('.sc-tc-main') || { getAttribute: () => '' }).getAttribute('aria-label'));
  const focusKey = (page) => page.evaluate(() => (document.querySelector('#panel .f.is-focused') || {}).getAttribute ? document.querySelector('#panel .f.is-focused').getAttribute('data-key') : null);
  const sub = (page) => page.evaluate(() => { const e = document.querySelector('#panel .panel-sub'); return e && e.style.display !== 'none' ? e.textContent : ''; });
  const texts = (page, sel) => page.evaluate((q) => Array.prototype.map.call(document.querySelectorAll(q), (n) => (n.innerText || '').replace(/\s+/g, ' ').trim()), sel);

  // The controls' own checks: inside the panel, readable, nothing cut or overlapping.
  function ctlProblems(page) {
    return page.evaluate(() => {
      const out = [];
      const ctl = document.querySelector('.sc-page .sc-ctl');
      if (!ctl) return ['no controls'];
      const body = document.querySelector('#panel .panel-body').getBoundingClientRect();
      const panel = document.querySelector('#panel').getBoundingClientRect();
      const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const cr = ctl.getBoundingClientRect();
      if (cr.bottom > body.bottom + 1 || cr.top < body.top - 1) out.push('the deck leaves the panel: ' + Math.round(cr.top - body.top) + ',' + Math.round(body.bottom - cr.bottom));
      const main = document.querySelector('.sc-page .sc-main');
      const shown = getComputedStyle(main).display !== 'none';
      if (shown) {
        const mr = main.getBoundingClientRect();
        if (mr.bottom > cr.top + 1) out.push('the song overlaps the deck');
        const art = main.querySelector('.sc-art');
        if (art && getComputedStyle(art).display !== 'none' && art.getBoundingClientRect().width < 6.4 * px) out.push('the cover is smaller than 6.4rem');
        const head = main.querySelector('.sc-label');
        if (!head || !head.getBoundingClientRect().height) out.push('the NOW PLAYING label is hidden');
        const ttl = main.querySelector('.sc-title');
        const inf = main.querySelector('.sc-info');
        const tr = ttl.getBoundingClientRect();
        const ir = inf.getBoundingClientRect();
        if (!tr.height) out.push('the title is hidden');
        else if (tr.bottom > ir.bottom + 1 || tr.top < ir.top - 1) out.push('the title is cut by its box');
        if (ttl.scrollHeight > ttl.clientHeight + 1) out.push('the title is cut');
        main.querySelectorAll('.sc-sub, .sc-label').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.height && r.bottom > ir.bottom + 1) out.push(e.className + ' is cut by its box');
        });
      }
      // The rail's chips may run past the edge (they move); the others stay inside.
      const items = Array.prototype.slice.call(ctl.querySelectorAll('.f:not(.sc-q)'));
      items.forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.left < panel.left || r.right > panel.right || r.top < body.top - 1 || r.bottom > body.bottom + 1) out.push(e.getAttribute('data-key') + ' sticks out');
      });
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i].getBoundingClientRect();
          const b = items[j].getBoundingClientRect();
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(items[i].getAttribute('data-key') + ' overlaps ' + items[j].getAttribute('data-key'));
        }
      }
      // The rail: one line, every chip the same top, and the focused one is inside the rail.
      const rail = ctl.querySelector('.sc-rail').getBoundingClientRect();
      const qs = Array.prototype.slice.call(ctl.querySelectorAll('.sc-q'));
      qs.forEach((q) => { if (Math.abs(q.getBoundingClientRect().top - qs[0].getBoundingClientRect().top) > 1) out.push('the quick starts are on two lines'); });
      const fq = ctl.querySelector('.sc-q.is-focused');
      if (fq) { const r = fq.getBoundingClientRect(); if (r.left < rail.left - 1 || r.right > rail.right + 1) out.push('the focused quick start is outside the rail'); }
      const caps = Array.prototype.slice.call(ctl.querySelectorAll('.sc-tcap')).filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden');
      for (let i = 0; i < caps.length; i++) {
        for (let j = i + 1; j < caps.length; j++) {
          const a = caps[i].getBoundingClientRect();
          const b = caps[j].getBoundingClientRect();
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push('captions overlap');
        }
      }
      // Text: readable, whole, on one line where it must be.
      ctl.querySelectorAll('.sc-q-text,.sc-spk-name,.sc-rlabel,.sc-vol,.sc-tcap,.sc-sb-t').forEach((e) => {
        if (e.offsetParent === null) return;
        const cs = getComputedStyle(e);
        const fs = parseFloat(cs.fontSize);
        const min = /sc-tcap/.test(e.className) ? 0.85 : /sc-sb-t/.test(e.className) ? 1.4 : 0.92;
        if (fs < min * px - 0.5) out.push(e.className + ' too small: ' + fs);
        const lh = parseFloat(cs.lineHeight);
        if (!/sc-sb-t/.test(e.className) && lh < fs * 1.24) out.push(e.className + ' line height too tight');
        if (e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.push(e.className + ' cut sideways: "' + e.textContent + '"');
        if (e.scrollHeight > e.clientHeight + 1 && cs.overflow !== 'visible') out.push(e.className + ' cut at the bottom: "' + e.textContent + '"');
        if (e.getBoundingClientRect().height > lh * 1.5 + 1) out.push(e.className + ' wraps onto two lines: "' + e.textContent + '"');
        if (e.scrollWidth > e.clientWidth + 1 && /sc-spk-name|sc-rlabel/.test(e.className)) out.push(e.className + ' ends in "..." : "' + e.textContent + '"');
      });
      return out;
    });
  }

  await check('the controls show with speakers: the row, the five buttons, the quick starts; English and Spanish words; first focus is Play/Pause', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    for (const lang of ['en', 'es']) {
      const s = await openPage(p, lang, false, 3, 2, false);
      const en = lang === 'en';
      const spk = await texts(s.page, '.sc-spk');
      assert(spk.join('|') === (en ? 'Echo Show|Echo Dot|Everywhere' : 'Echo Show|Echo Dot|En todas partes'), 'speakers: ' + spk.join('|'));
      const sel = await texts(s.page, '.sc-spk.is-sel');
      assert(sel.join() === 'Echo Show', 'selected: ' + sel.join());
      const aria = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-ctl .f[data-act]'), (n) => n.getAttribute('aria-label')));
      assert(aria.join('|') === (en ? 'Pause|Next|Volume down|Volume up|Stop' : 'Pausa|Siguiente|Bajar volumen|Subir volumen|Detener'), 'buttons: ' + aria.join('|'));
      const caps = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-tcap'), (n) => n.textContent));
      assert(caps.join('|') === (en ? 'Pause|Next|Volume|Stop' : 'Pausa|Siguiente|Volumen|Detener'), 'captions: ' + caps.join('|'));
      const vol = await texts(s.page, '.sc-vol');
      assert(vol.join() === '40%', 'volume: ' + vol.join());
      const q = await texts(s.page, '.sc-q');
      assert(q.join('|') === (en ? 'Resume audiobook|KERA 90.1|NPR newscast|Spotify|Pandora|Amazon Music' : 'Reanudar audiolibro|KERA 90.1|Noticiero de NPR|Spotify|Pandora|Amazon Music'), 'quick: ' + q.join('|'));
      const glyphs = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-q .sc-q-ic svg'), (n) => n.querySelectorAll('path,circle').length > 0).join());
      assert(glyphs === 'true,true,true,true,true', 'quick start glyphs: ' + glyphs);
      const labels = (await texts(s.page, '.sc-rlabel')).filter(Boolean);
      assert(labels.join('|').toLowerCase() === (en ? 'speaker|start' : 'altavoz|iniciar'), 'labels: ' + labels.join('|'));
      assert((await focusKey(s.page)) === 'act:toggle', 'first focus: ' + (await focusKey(s.page)));
      // Playing and paused dots differ by shape, and the group has none while the others idle... it is playing here.
      const dots = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-dot'), (d) => d.className.replace('sc-dot', '').trim()));
      assert(dots.join('|') === '|', 'dots: ' + dots.join('|'));
      // The info above is the All sounds page as it was.
      assert((await texts(s.page, '.sc-info .sc-title'))[0] === 'Golden Hour Drive', 'the title is still there');
      const lab = await s.page.evaluate(() => { const l = document.querySelector('.sc-page .sc-info .sc-label'); return l ? [l.innerText.replace(/\s+/g, ' ').trim(), l.querySelectorAll('.sc-eq i').length, !!l.querySelector('.sc-plat')] : null; });
      assert(lab && lab[1] === 3 && lab[2] && lab[0].toLowerCase().indexOf(en ? 'now playing' : 'sonando ahora') === 0, 'the label line: ' + JSON.stringify(lab));
      const bad = (await problems(s.page, '.sc-page')).concat(await ctlProblems(s.page));
      assert(!bad.length, lang + ': ' + bad.join('; '));
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
    }
    await stopPi(p);
  });

  await check('without speakers (an older Pi, or Echo controls off) the page is plain All sounds; with no Home Assistant too', async () => {
    const p = await startPi(true, true);
    await house(p, 'amazonmusic');
    const s = await openPage(p, 'en', false, 3, 2, false);
    assert(!(await s.page.evaluate(() => !!document.querySelector('.sc-ctl, .sc-tc, .sc-spk, .sc-q'))), 'controls without speakers');
    assert(!(await s.page.evaluate(() => document.querySelector('.sc-page').className.indexOf('has-ctl') >= 0)), 'has-ctl without speakers');
    const bad = await problems(s.page, '.sc-page');
    assert(!bad.length, bad.join('; '));
    await s.context.close();
    // The "before" picture is the real All sounds page (allsounds.js, untouched).
    const old = await open(p, [{ widget: 'allsounds', x: 0, y: 0, w: 3, h: 2 }], { lang: 'en' });
    await old.page.waitForSelector('.as-tile');
    await old.page.evaluate(() => window.HUB_TEST.openPanel('allsounds'));
    await until(() => old.page.evaluate(() => window.HUB_TEST.open() === 'allsounds' && !window.HUB_TEST.busy() && !!document.querySelector('.as-page .as-title')), 5000, 'the All sounds page did not open');
    await shot(old.page, 'soundctl-panel-before-en.png');
    await old.context.close();
    const n = await startPi(false);
    const s2 = await open(n, ONLY(3, 2), {});
    await s2.page.waitForSelector('.sc-tile');
    await s2.page.evaluate(() => window.HUB_TEST.openPanel('soundctl'));
    await sleepMs(500);
    assert(!(await s2.page.evaluate(() => !!document.querySelector('.sc-ctl'))), 'controls when not set up');
    await s2.context.close();
    await stopPi(p);
    await stopPi(n);
  });

  await check('D-pad: Right and Left inside a row, Up and Down between rows by position, Down stops at the last row, Up from the top leaves for the Full screen button', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    const s = await openPage(p, 'en', false, 3, 2, false);
    const key = () => focusKey(s.page);
    const seq = [];
    const press = async (k) => { await s.page.keyboard.press(k); await sleepMs(80); seq.push(await key()); };
    await press('ArrowRight'); await press('ArrowRight'); await press('ArrowRight'); await press('ArrowRight'); await press('ArrowRight');
    await press('ArrowLeft'); await press('ArrowLeft'); await press('ArrowLeft'); await press('ArrowLeft'); await press('ArrowLeft');
    assert(seq.join() === 'act:next,act:volDown,act:volUp,act:stop,act:stop,act:volUp,act:volDown,act:next,act:toggle,act:toggle', 'row: ' + seq.join());
    seq.length = 0;
    await press('ArrowDown');
    assert(/^q:/.test(seq[0]), 'down from Play/Pause: ' + seq[0]);
    await press('ArrowDown');
    assert(seq[1] === seq[0], 'Down from the last row stays: ' + seq.join());
    await press('ArrowUp'); await press('ArrowUp');
    assert(/^spk:/.test(seq[3]), 'two ups reach the speakers: ' + seq.join());
    for (let i = 0; i < 4 && (await key()) !== 'spk:show'; i++) await press('ArrowLeft');
    await press('ArrowRight');
    assert(seq[seq.length - 1] === 'spk:dot', 'right in the speaker row: ' + seq[seq.length - 1]);
    await press('ArrowUp');
    const onBtn = await s.page.evaluate(() => !!document.querySelector('#panel .panel-btn.is-focused'));
    assert(onBtn, 'Up from the speaker row reaches the Full screen button');
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(80);
    assert((await key()) === 'act:toggle' || /^act:|^spk:/.test(await key()), 'Down from the button returns to the controls: ' + (await key()));
    await s.context.close();
    await stopPi(p);
  });

  await check('OK sends: Pause goes to the Echo Show only; "Sending…" first, then "Paused on Echo Show"; the button turns to Play; a refusal rolls it back; Spanish words', async () => {
    const p = await startPi(true);
    for (const lang of ['en', 'es']) {
      await house(p, 'amazonmusic');
      ha.services.length = 0;
      const s = await openPage(p, lang, false, 3, 2, false);
      const en = lang === 'en';
      // Slow the answer a little so "Sending…" can be seen.
      await s.page.route('**/echo/run', async (route) => { await sleepMs(700); route.continue(); });
      await s.page.keyboard.press('Enter');
      await until(async () => (await sub(s.page)) === (en ? 'Sending…' : 'Enviando…'), 2000, 'no "Sending…": ' + (await sub(s.page)));
      assert((await mainWord(s.page)) === (en ? 'Play' : 'Reproducir'), 'the button did not turn to Play at once');
      await until(async () => (await sub(s.page)) === (en ? 'Paused on Echo Show' : 'En pausa en Echo Show'), 3000, 'no outcome: ' + (await sub(s.page)));
      assert(ha.services.length === 1 && ha.services[0].service === 'media_pause' && ha.services[0].body.entity_id === 'media_player.ian_s_echo_show', 'service calls: ' + JSON.stringify(ha.services.map((x) => x.service)));
      // Now Play (resume) with Home Assistant refusing: rolled back, and said so.
      ha.serviceStatus = 500;
      await sleepMs(300);
      assert((await focusKey(s.page)) === 'act:toggle', 'focus kept on Play/Pause: ' + (await focusKey(s.page)));
      await s.page.keyboard.press('Enter');
      await until(async () => (await sub(s.page)) === (en ? 'Home Assistant refused the request' : 'Home Assistant rechazó la solicitud'), 4000, 'no refusal note: ' + (await sub(s.page)));
      ha.serviceStatus = 0;
      await until(async () => (await mainWord(s.page)) === (en ? 'Pause' : 'Pausa'), 3000, 'not rolled back');
      assert(ha.services.length === 2 && ha.services[1].service === 'media_play', 'second call: ' + JSON.stringify(ha.services.map((x) => x.service)));
      // Next, volume, stop: one call each, our words.
      const want = [['ArrowRight', 'media_next_track', en ? 'Skipped' : 'Se saltó a la siguiente'], ['ArrowRight', 'volume_set', en ? 'Volume down' : 'Volumen bajado'],
        ['ArrowRight', 'volume_set', en ? 'Volume up' : 'Volumen subido'], ['ArrowRight', 'media_pause', en ? 'Stopped' : 'Detenido']];
      for (const w of want) {
        await s.page.keyboard.press(w[0]);
        await sleepMs(60);
        await s.page.keyboard.press('Enter');
        await until(async () => (await sub(s.page)) === w[2], 4000, 'no note "' + w[2] + '": ' + (await sub(s.page)));
        assert(ha.services[ha.services.length - 1].service === w[1], w[2] + ' sent ' + ha.services[ha.services.length - 1].service);
        await sleepMs(150);
      }
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      await s.context.close();
      await sleepMs(300);
    }
    await stopPi(p);
  });

  await check('a quick start sends start on the chosen speaker; the speaker row picks the speaker; the group goes to the group; unreachable says so', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    ha.services.length = 0;
    const s = await openPage(p, 'en', false, 3, 2, false);
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(80);
    assert(/^q:audible$/.test(await focusKey(s.page)) || /^q:/.test(await focusKey(s.page)), 'on a quick start');
    await s.page.evaluate(() => document.querySelector('[data-q="kera"]').scrollIntoView && 0);
    // Go to KERA 90.1 by the keys.
    for (let i = 0; i < 6 && (await focusKey(s.page)) !== 'q:kera'; i++) { await s.page.keyboard.press((await focusKey(s.page)) === 'q:audible' ? 'ArrowRight' : 'ArrowLeft'); await sleepMs(60); }
    assert((await focusKey(s.page)) === 'q:kera', 'could not reach KERA');
    await s.page.keyboard.press('Enter');
    await until(async () => (await sub(s.page)) === 'Starting KERA 90.1 on Echo Show', 4000, 'start note: ' + (await sub(s.page)));
    const call = ha.services[ha.services.length - 1];
    assert(call.service === 'play_media' && call.body.entity_id === 'media_player.ian_s_echo_show' && call.body.media_content_id === 'KERA 90.1', 'start: ' + JSON.stringify(call));
    // Pick the Echo Dot, then Resume audiobook on it.
    await s.page.keyboard.press('ArrowUp'); await s.page.keyboard.press('ArrowUp');
    await sleepMs(80);
    for (let i = 0; i < 4 && (await focusKey(s.page)) !== 'spk:show'; i++) { await s.page.keyboard.press('ArrowLeft'); await sleepMs(60); }
    assert((await focusKey(s.page)) === 'spk:show', 'on the speakers: ' + (await focusKey(s.page)));
    await s.page.keyboard.press('ArrowRight');
    await s.page.keyboard.press('Enter');
    await until(async () => (await texts(s.page, '.sc-spk.is-sel'))[0] === 'Echo Dot', 3000, 'the Dot was not selected');
    assert((await focusKey(s.page)) === 'spk:dot', 'focus stayed on the chip: ' + (await focusKey(s.page)));
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(80);
    for (let i = 0; i < 6 && (await focusKey(s.page)) !== 'q:audible'; i++) { await s.page.keyboard.press('ArrowLeft'); await sleepMs(60); }
    await s.page.keyboard.press('Enter');
    await until(async () => (await sub(s.page)) === 'Starting Audible on Echo Dot', 4000, 'Audible note: ' + (await sub(s.page)));
    const call2 = ha.services[ha.services.length - 1];
    assert(call2.body.entity_id === 'media_player.ian_s_echo_dot' && /audiobook|book/i.test(call2.body.media_content_id), 'audible: ' + JSON.stringify(call2));
    // The group: Everywhere.
    await s.page.keyboard.press('ArrowUp'); await sleepMs(80); await s.page.keyboard.press('ArrowUp'); await sleepMs(80);
    for (let i = 0; i < 4 && (await focusKey(s.page)) !== 'spk:everywhere'; i++) { await s.page.keyboard.press('ArrowRight'); await sleepMs(60); }
    await s.page.keyboard.press('Enter');
    await until(async () => (await texts(s.page, '.sc-spk.is-sel'))[0] === 'Everywhere', 3000, 'the group was not selected');
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(80);
    await s.page.keyboard.press('Enter');
    await sleepMs(900);
    const call3 = ha.services[ha.services.length - 1];
    assert(call3.body.entity_id === 'media_player.everywhere', 'the group call: ' + JSON.stringify(call3));
    // Home Assistant down: "Couldn't reach the Echo".
    await sleepMs(600);
    await s.page.keyboard.press('ArrowRight');
    ha.set('down');
    await s.page.keyboard.press('Enter');
    await until(async () => (await sub(s.page)) === 'Couldn’t reach the Echo', 5000, 'unreachable note: ' + (await sub(s.page)));
    ha.set('amazonmusic');
    await s.context.close();
    await stopPi(p);
  });

  await check('the volume stepper: shows the speaker volume, the press shows the expected number at once, the Pi confirms or it rolls back; only minus and plus take focus', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    ha.services.length = 0;
    const s = await openPage(p, 'en', false, 3, 2, false);
    const vol = () => texts(s.page, '.sc-vol').then((t) => t[0]);
    assert((await vol()) === '40%', 'start: ' + (await vol()));
    const focusables = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-step .f'), (n) => n.getAttribute('data-key')));
    assert(focusables.join() === 'act:volDown,act:volUp', 'stepper focus: ' + focusables.join());
    // Slow the answer so the optimistic number can be seen.
    await s.page.route('**/echo/run', async (route) => { await sleepMs(600); route.continue(); });
    await s.page.keyboard.press('ArrowRight'); await sleepMs(60);
    await s.page.keyboard.press('ArrowRight'); await sleepMs(60);
    assert((await focusKey(s.page)) === 'act:volDown', 'on minus: ' + (await focusKey(s.page)));
    await s.page.keyboard.press('ArrowRight'); await sleepMs(60);
    assert((await focusKey(s.page)) === 'act:volUp', 'on plus');
    await shot(s.page, 'soundctl-panel-focus-volume-en.png');
    await s.page.keyboard.press('Enter');
    await sleepMs(150);
    assert((await vol()) === '50%', 'not shown at once: ' + (await vol()));
    await until(async () => (await sub(s.page)) === 'Volume up', 3000, 'no note');
    assert(ha.services.length === 1 && ha.services[0].service === 'volume_set' && ha.services[0].body.volume_level === 0.5, 'sent: ' + JSON.stringify(ha.services));
    assert((await focusKey(s.page)) === 'act:volUp', 'focus stayed on plus');
    // A refusal: back to what the speaker says.
    await sleepMs(300);
    ha.serviceStatus = 500;
    await s.page.keyboard.press('Enter');
    await until(async () => (await sub(s.page)) === 'Home Assistant refused the request', 4000, 'no refusal');
    ha.serviceStatus = 0;
    await until(async () => (await vol()) === '40%', 3000, 'not rolled back: ' + (await vol()));
    await s.context.close();
    await stopPi(p);
  });

  await check('the tile does not move or change when the page opens (the deck shares no class with the tile)', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    const s = await open(p, ONLY(3, 2), { lang: 'en' });
    await s.page.waitForSelector('.sc-tile');
    await sleepMs(400);
    const rects = () => s.page.evaluate(() => ['.sc-tile', '.sc-tile .sc-art', '.sc-tile .sc-title', '.sc-tile .sc-meta'].map((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [q, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(); }).join('|'));
    const before = await rects();
    await s.page.evaluate(() => window.HUB_TEST.openPanel('soundctl'));
    await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'soundctl' && !window.HUB_TEST.busy()), 5000, 'no page');
    await sleepMs(400);
    const after = await rects();
    assert(before === after, 'the tile moved: ' + before + ' -> ' + after);
    await s.context.close();
    await stopPi(p);
  });

  await check('the Pi refuses what the TV may not send: no query, no tunein (the page never offers them)', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    const s = await openPage(p, 'en', false, 3, 2, false);
    const apps = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('[data-q]'), (n) => n.getAttribute('data-q')));
    assert(apps.join() === 'audible,kera,news,pandora,amazon-music', 'quick starts: ' + apps.join());
    const html = await s.page.content();
    ['tunein', 'media_player', 'Bearer', ha.token, ha.url].forEach((x) => assert(html.indexOf(x) < 0, 'the page holds ' + x));
    await s.context.close();
    await stopPi(p);
  });

  await check('the page and full screen at every language: the controls inside the panel, readable, nothing cut or overlapping', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    const bad = [];
    for (const [w, h] of [[3, 2], [6, 3], [4, 6]]) {
      for (const [lang, longer] of LONGS) {
        for (const full of [false, true]) {
          const s = await openPage(p, lang, longer, w, h, full);
          const pr = (await problems(s.page, '.sc-page')).concat(await ctlProblems(s.page));
          const label = w + 'x' + h + ' ' + lang + (longer ? '+25' : '') + (full ? ' full' : ' page');
          if (pr.length) bad.push(label + ': ' + pr.join('; '));
          if (w === 3 && h === 2) {
            if (!longer && !full) await shot(s.page, 'soundctl-panel-after-' + lang + '.png');
            if (!longer && full) await shot(s.page, 'soundctl-panel-full-' + lang + '.png');
            if (longer && !full) await shot(s.page, 'soundctl-panel-es25.png');
          }
          // With a chip focused the head shows its hint line: nothing may move out of the panel.
          await s.page.keyboard.press('ArrowDown');
          await sleepMs(120);
          const pr2 = await ctlProblems(s.page);
          if (pr2.length) bad.push(label + ' (quick focused): ' + pr2.join('; '));
          await s.page.keyboard.press('ArrowUp');
          await s.page.keyboard.press('ArrowUp');
          await sleepMs(120);
          const pr3 = await ctlProblems(s.page);
          if (pr3.length) bad.push(label + ' (speaker focused): ' + pr3.join('; '));
          await s.context.close();
        }
      }
    }
    assert(!bad.length, bad.join(' | '));
    await stopPi(p);
  });

  await check('screenshot: focus on a quick-start chip', async () => {
    const p = await startPi(true);
    await house(p, 'amazonmusic');
    const s = await openPage(p, 'en', false, 3, 2, false);
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(100);
    await shot(s.page, 'soundctl-panel-focus-quick-en.png');
    await s.context.close();
    await stopPi(p);
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
