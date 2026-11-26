/*
 * Sound control (the test widget), end to end: node dev/soundctl-test.js
 *
 * Runs the real hub in headless Chromium against the real hub server from
 * pi/ and the pretend Home Assistant (dev/mock-ha.js), on spare ports, with
 * a fresh data folder. Nothing reaches the internet, Home Assistant or
 * Amazon. Needs Playwright (require('playwright')) and port 8095 free.
 *
 * Checks: the switcher (no sound test pills) and the widget filling the screen
 * when a layout holds it alone; every state
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
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host'), 'api.github.com'];

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
async function startPi(withHa, noEcho, extra) {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sc-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start(Object.assign({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    allsoundsEnv: withHa === false ? {} : { HA_URL: ha.url, HA_TOKEN: ha.token },
    echoEnv: withHa === false || noEcho ? {} : { HA_URL: ha.url, HA_TOKEN: ha.token },
    allsounds: { allowHttp: true, manual: true, timeoutMs: 400 }
  }, extra || {}));
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

// The annotated test guide: the page's picture with numbered callouts and a
// legend panel beside it (a second page composes picture, lines and legend).
async function guide(s, file, everywhere) {
  const page = s.page;
  const spots = await page.evaluate((all) => {
    const sub = document.querySelector('#panel .panel-sub');
    // The feedback note as it looks right after a press (the picture only).
    if (sub) { sub.textContent = all ? 'Paused on Echo Dot' : 'Paused on Echo Show'; sub.style.display = ''; }
    const R = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const U = (a, b) => { if (!a || !b) return a || b; const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x: x, y: y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
    let note = null;
    if (sub && sub.firstChild) { const rg = document.createRange(); rg.selectNodeContents(sub); const r = rg.getBoundingClientRect(); note = { x: r.left, y: r.top, w: r.width, h: r.height }; }
    return {
      seg: U(R('.sc-seg'), R('.sc-showing')),
      info: all ? R('.sc-members') : R('.sc-info'), rowCtl: all ? R('.sc-mrow .sc-mctl') : null,
      toggle: R('.sc-tc-main'), step: R('.sc-trans .sc-step'), stop: R('.sc-tc-stop'), quick: R('.sc-rail'),
      all: U(R('.sc-row-tr .sc-rlabel'), R('.sc-trans')), note: note
    };
  }, !!everywhere);
  const png = await page.screenshot({ type: 'png' });
  const W = 1920, H = 1080, LEG = 760;
  // [number, target, title, text, side of the picture the badge sits on]
  const items = everywhere ? [
    [1, spots.seg, 'Speaker switch', 'Green dot = playing. Second line = what it plays, or Paused / Idle / Off. Blue fill = the one shown (here, all speakers). White ring = where the remote is. The line beside it says what is shown.', 'R'],
    [2, spots.info, 'One row per speaker', 'Cover, name, what it plays and from where, its state, and its own Play/Pause and volume. Up and Down move between rows.', 'R'],
    [3, spots.rowCtl, 'A row\'s own controls', 'Left and Right inside the row. OK on Pause stops only that speaker; - and + change only its volume (by 10).', 'R'],
    [4, spots.all, 'All speakers', 'The big buttons act on every speaker: Pause, Next, Volume, Stop. Quick starts play on all speakers too.', 'R'],
    [5, spots.quick, 'Start row', 'Audiobook, KERA 90.1, NPR newscast, Spotify, Pandora, Amazon Music. Slides sideways with the remote.', 'R'],
    [6, spots.note, 'Feedback note', 'Sending..., then what happened ("Paused on Echo Dot"), or what went wrong. Under the title.', 'R']
  ] : [
    [1, spots.seg, 'Speaker switch', 'Blue fill = selected (the one shown). White ring = focused (where the remote is). Green dot = playing. Second line = what it plays, or Paused / Idle / Off. The line beside it says which speaker is shown.', 'R'],
    [2, spots.info, 'Info area', 'What the selected speaker itself plays: state, source in brackets, title, artist, cover. Never the house-wide winner.', 'R'],
    [3, spots.toggle, 'Play / Pause, Next', 'The big green circle is Play or Pause for the selected speaker; Next is beside it.', 'L'],
    [4, spots.step, 'Volume', '- and + move this speaker by 10. The number changes at once, then the Pi confirms.', 'R'],
    [5, spots.stop, 'Stop', 'Stops this speaker (its word shows when focused).', 'R'],
    [6, spots.quick, 'Start row', 'Audiobook, KERA 90.1, NPR newscast, Spotify, Pandora, Amazon Music. Slides sideways with the remote.', 'R'],
    [7, spots.note, 'Feedback note', 'Sending..., then what happened ("Paused on Echo Show"), or what went wrong. Under the title.', 'R']
  ];
  const RX = 1575, LX = 360;
  const placed = { R: [], L: [] };
  const live = items.filter((it) => it[1]).map((it) => ({ it: it, cy: it[1].y + it[1].h / 2 })).sort((a, b) => a.cy - b.cy);
  live.forEach((o) => {
    const side = o.it[4];
    let y = o.cy;
    const last = placed[side].length ? placed[side][placed[side].length - 1] : -100;
    if (y < last + 46) y = last + 46;
    placed[side].push(y);
    o.by = y;
  });
  let marks = '';
  let legend = '';
  items.forEach((it) => {
    const o = live.filter((l) => l.it === it)[0];
    if (!o) return;
    const r = it[1];
    const left = it[4] === 'L';
    const sx = left ? r.x - 4 : r.x + r.w + 4, sy = r.y + r.h / 2;
    const bx = left ? LX : RX;
    marks += '<div class="ring" style="left:' + (r.x - 4) + 'px;top:' + (r.y - 4) + 'px;width:' + (r.w + 8) + 'px;height:' + (r.h + 8) + 'px"></div>';
    marks += '<svg class="ln"><polyline points="' + sx + ',' + sy + ' ' + (left ? bx + 40 : bx - 40) + ',' + sy + ' ' + (left ? bx + 16 : bx - 16) + ',' + o.by + '"/></svg>';
    marks += '<div class="num" style="left:' + (bx - 16) + 'px;top:' + (o.by - 16) + 'px">' + it[0] + '</div>';
    legend += '<div class="it"><div class="num s">' + it[0] + '</div><div><b>' + it[2] + '</b><br>' + it[3] + '</div></div>';
  });
  const g = await s.context.newPage();
  await g.setViewportSize({ width: W + LEG, height: H });
  await g.setContent('<!doctype html><meta charset="utf-8"><style>' +
    'body{margin:0;width:' + (W + LEG) + 'px;height:' + H + 'px;background:#0e1118;font:20px/1.35 system-ui,sans-serif;color:#e8ecf4;position:relative;overflow:hidden}' +
    'img{position:absolute;left:0;top:0;width:' + W + 'px;height:' + H + 'px}' +
    '.ring{position:absolute;border:3px solid #ffd24a;border-radius:14px;box-sizing:border-box}' +
    '.ln{position:absolute;left:0;top:0;width:' + W + 'px;height:' + H + 'px;pointer-events:none}.ln polyline{fill:none;stroke:#ffd24a;stroke-width:2}' +
    '.num{position:absolute;width:32px;height:32px;border-radius:50%;background:#ffd24a;color:#1a1a1a;font-weight:700;text-align:center;line-height:32px;font-size:20px}' +
    '.num.s{position:static;flex:0 0 32px;margin-right:14px}' +
    '.leg{position:absolute;left:' + W + 'px;top:0;width:' + LEG + 'px;height:' + H + 'px;box-sizing:border-box;padding:28px 30px;background:#161b26;border-left:2px solid #2a3142}' +
    '.leg h1{margin:0 0 16px;font-size:28px}.it{display:flex;margin-bottom:16px;font-size:20px}.it b{font-size:22px;color:#fff}' +
    '</style><img src="data:image/png;base64,' + png.toString('base64') + '">' + marks + '<div class="leg"><h1>' + (everywhere ? 'Everywhere view' : 'Echo Show view') + '</h1>' + legend + '</div>');
  fs.mkdirSync(SHOTS, { recursive: true });
  await g.screenshot({ path: path.join(SHOTS, file), type: 'png' });
  await g.close();
  // Put the note line back as it was.
  await page.evaluate(() => { const sub = document.querySelector('#panel .panel-sub'); if (sub) sub.textContent = ' '; });
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

  await check('the switcher: the stock pills only (no sound test pills), none cut; the widget fills the screen when a layout holds it', async () => {
    await house(pi, 'radio');
    const s = await open(pi, TEST_LAYOUT);
    await waitKind(s.page, 'playing', 'Morning Edition');
    const cfg = await s.page.evaluate(() => window.HUB_CONFIG.layouts.map((l) => l.name));
    assert(cfg.join('|') === 'Default|Main|Get ready|AWWS desk|AWWS one screen|AWWS money|Budget|Plants|Ambience test|Hub architecture|Groceries test', 'layouts: ' + cfg.join(', '));
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
    await house(p3, 'amazonmusic');
    for (const lang of ['en', 'es']) {
      const s = await open(p3, ONLY(3, 2), { lang: lang });
      await waitKind(s.page, 'playing', 'Golden Hour Drive');
      await s.page.evaluate(() => window.HUB_TEST.openPanel('soundctl'));
      await until(() => s.page.evaluate(() => window.HUB_TEST.open() === 'soundctl' && !window.HUB_TEST.busy() && !!document.querySelector('.sc-page .sc-title')), 5000, 'the page did not open');
      const chips = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-page .sc-chip'), (c) => c.textContent));
      assert(chips.length === 0, 'with the controls the picker names the speaker, no chip: ' + chips.join(', '));
      const pt = await s.page.evaluate(() => (document.querySelector('.sc-page .sc-info .sc-title') || {}).textContent);
      assert(pt === 'Golden Hour Drive', 'the page follows the Echo Show: ' + pt);
      const plat = await s.page.evaluate(() => (document.querySelector('.sc-page .sc-label .sc-plat') || {}).textContent);
      assert(plat === '(Amazon Music)', 'platform on the page: ' + plat);
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
      const members = main.querySelector('.sc-members');
      if (shown && members) {
        const mr = main.getBoundingClientRect();
        if (members.scrollHeight > members.clientHeight + 1 && members.getBoundingClientRect().bottom > cr.top + 1) out.push('the speaker rows overlap the deck');
        members.querySelectorAll('.sc-mrow').forEach((row) => {
          const rr = row.getBoundingClientRect();
          if (rr.bottom > cr.top + 1 || rr.top < mr.top - 1) out.push('a speaker row is outside its room: ' + Math.round(rr.top - mr.top) + ',' + Math.round(cr.top - rr.bottom));
          const nm = row.querySelector('.sc-mname');
          if (nm && nm.scrollWidth > nm.clientWidth + 1) out.push('a speaker name ends in "...": ' + nm.textContent);
        });
      } else if (shown) {
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
      const items = Array.prototype.slice.call(document.querySelectorAll('.sc-page .f:not(.sc-q)'));
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
      document.querySelectorAll('.sc-page .sc-q-text,.sc-page .sc-spk-name,.sc-page .sc-spk-sub,.sc-page .sc-showing,.sc-page .sc-mname,.sc-page .sc-mdetail,.sc-page .sc-mstate,.sc-page .sc-rlabel,.sc-page .sc-vol,.sc-page .sc-tcap,.sc-page .sc-sb-t').forEach((e) => {
        if (e.offsetParent === null) return;
        const cs = getComputedStyle(e);
        const fs = parseFloat(cs.fontSize);
        const min = /sc-tcap|sc-spk-sub/.test(e.className) ? 0.85 : /sc-sb-t/.test(e.className) ? 1.4 : 0.92;
        if (fs < min * px - 0.5) out.push(e.className + ' too small: ' + fs);
        const lh = parseFloat(cs.lineHeight);
        if (!/sc-sb-t/.test(e.className) && lh < fs * 1.24) out.push(e.className + ' line height too tight');
        if (e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.push(e.className + ' cut sideways: "' + e.textContent + '"');
        if (e.scrollHeight > e.clientHeight + 1 && cs.overflow !== 'visible' && !/sc-showing/.test(e.className)) out.push(e.className + ' cut at the bottom: "' + e.textContent + '"');
        if (e.getBoundingClientRect().height > lh * (/is-wrap/.test(e.className) ? 3.1 : /sc-showing/.test(e.className) ? 2.1 : 1.5) + 1) out.push(e.className + ' wraps onto too many lines: "' + e.textContent + '"');
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
      assert(spk.join('|') === (en ? 'Echo Show Amazon Music|Echo Dot Idle|Everywhere 1 playing' : 'Echo Show Amazon Music|Echo Dot Inactivo|En todas partes 1 sonando'), 'speakers: ' + spk.join('|'));
      const showing = await texts(s.page, '.sc-showing');
      assert(showing.join() === (en ? 'Showing Echo Show' : 'Mostrando Echo Show'), 'the hint: ' + showing.join());
      const sel = await texts(s.page, '.sc-spk.is-sel .sc-spk-name');
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
      assert(glyphs === 'true,true,true,true,true,true', 'quick start glyphs: ' + glyphs);
      const labels = (await texts(s.page, '.sc-rlabel')).filter(Boolean);
      assert(labels.join('|').toLowerCase() === (en ? 'speaker|start' : 'altavoz|iniciar'), 'labels: ' + labels.join('|'));
      assert((await focusKey(s.page)) === 'act:toggle', 'first focus: ' + (await focusKey(s.page)));
      // Playing and paused dots differ by shape, and the group has none while the others idle... it is playing here.
      const dots = await s.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sc-dot'), (d) => d.className.replace('sc-dot', '').trim()));
      assert(dots.join('|') === 'is-on||is-on', 'dots: ' + dots.join('|'));
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
    await until(async () => (await texts(s.page, '.sc-spk.is-sel .sc-spk-name'))[0] === 'Echo Dot', 3000, 'the Dot was not selected');
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
    await until(async () => (await texts(s.page, '.sc-spk.is-sel .sc-spk-name'))[0] === 'Everywhere', 3000, 'the group was not selected');
    // Down from the picker: the two speaker rows, then the group's own transport.
    for (let i = 0; i < 3; i++) { await s.page.keyboard.press('ArrowDown'); await sleepMs(80); }
    for (let i = 0; i < 6 && (await focusKey(s.page)) !== 'act:toggle'; i++) { await s.page.keyboard.press('ArrowLeft'); await sleepMs(60); }
    assert((await focusKey(s.page)) === 'act:toggle', 'on the group transport: ' + (await focusKey(s.page)));
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

  /* ---------- v3: the page follows the speaker picked ---------- */

  // Goes to the speaker row and picks a speaker by the keys.
  async function pickSpk(page, key) {
    if (!(await focusKey(page))) { await page.keyboard.press('ArrowDown'); await sleepMs(100); }   // from the Full screen button
    for (let i = 0; i < 4 && !/^spk:/.test(await focusKey(page)); i++) { await page.keyboard.press('ArrowUp'); await sleepMs(80); }
    for (let i = 0; i < 4 && (await focusKey(page)) !== 'spk:show'; i++) { await page.keyboard.press('ArrowLeft'); await sleepMs(60); }
    for (let i = 0; i < 4 && (await focusKey(page)) !== 'spk:' + key; i++) { await page.keyboard.press('ArrowRight'); await sleepMs(60); }
    if (process.env.DBG) console.log('before enter focus', await focusKey(page));
    await page.keyboard.press('Enter');
    if (process.env.DBG) { await sleepMs(300); console.log('after enter focus', await focusKey(page), await page.evaluate(() => document.querySelectorAll('.f').length + ' f; sel=' + (document.querySelector('.sc-spk.is-sel')||{}).textContent)); }
    await until(() => page.evaluate((k) => { const c = document.querySelector('.sc-spk.is-sel'); return !!c && c.getAttribute('data-spk') === k; }, key), 3000, 'the speaker ' + key + ' was not selected (focus ' + (await focusKey(page)) + ')');
    await sleepMs(150);
  }
  const info = (page) => page.evaluate(() => {
    const q = (s) => { const e = document.querySelector('.sc-page ' + s); return e && e.offsetParent !== null ? e.innerText.replace(/\s+/g, ' ').trim() : null; };
    return { label: q('.sc-info .sc-label'), title: q('.sc-info .sc-title'), sub: q('.sc-info .sc-sub'), plat: q('.sc-info .sc-plat'), stale: q('.sc-info .sc-stale'), hasInfo: !!document.querySelector('.sc-page .sc-info'), members: !!document.querySelector('.sc-page .sc-members') };
  });

  await check('v3: the info area follows the speaker picked (Show plays KERA, Dot a radio stream); Spotify on the house never shows there; Everywhere lists both', async () => {
    const sp = await require('./mock-spotify').start({});
    const port = await spare();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sc-test-'));
    tmp.push(dir);
    const h = require(path.join(ROOT, 'pi', 'server.js')).start({
      token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
      allsoundsEnv: { HA_URL: ha.url, HA_TOKEN: ha.token }, echoEnv: { HA_URL: ha.url, HA_TOKEN: ha.token }, allsounds: { allowHttp: true, manual: true, timeoutMs: 400 },
      spotifyEnv: { SPOTIFY_CLIENT_ID: sp.clientId, SPOTIFY_CLIENT_SECRET: sp.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback' },
      spotify: { accounts: sp.url, api: sp.url, vibe: sp.url, allowHttp: true, manual: true, vibeOff: true }
    });
    await h.ready;
    const p5 = { h: h, port: port, url: 'http://127.0.0.1:' + port, dir: dir };
    pis.push(p5);
    await house(p5, 'twoplaying');
    const l = h.spotify.loginUrl();
    await new Promise((resolve, reject) => http.get(l.url, (res) => { res.resume(); h.spotify.finishLogin(res.headers.location || '').then(resolve, reject); }).on('error', reject));
    const s = await openPage(p5, 'en', false, 3, 2, false);
    // The tile is the house-wide winner (Spotify), as All sounds; the page is not.
    const tile = await tileText(s.page);
    assert(tile.title === 'Golden Hour Drive', 'the tile still shows the winner: ' + tile.title);
    let i = await info(s.page);
    const sel = (await texts(s.page, '.sc-spk.is-sel .sc-spk-name'))[0];
    assert(i.title !== 'Golden Hour Drive' && /^(KERA|Classic Rock 101)$/.test(i.title), 'the page showed ' + i.title + ' for ' + sel);
    await pickSpk(s.page, 'show');
    i = await info(s.page);
    assert(i.title === 'KERA' && /^now playing/i.test(i.label) && i.plat === null && i.hasInfo && !i.members, 'Show: ' + JSON.stringify(i));
    assert((await texts(s.page, '.sc-vol'))[0] === '35%', 'the Show volume: ' + (await texts(s.page, '.sc-vol')));
    assert((await texts(s.page, '.sc-showing'))[0] === 'Showing Echo Show', 'hint');
    await pickSpk(s.page, 'dot');
    i = await info(s.page);
    assert(i.title === 'Classic Rock 101' && i.plat.replace(/\s/g, '') === '(iHeartRadio)' && /^now playing/i.test(i.label), 'Dot: ' + JSON.stringify(i));
    assert((await texts(s.page, '.sc-vol'))[0] === '60%', 'the Dot volume: ' + (await texts(s.page, '.sc-vol')));
    assert((await texts(s.page, '.sc-showing'))[0] === 'Showing Echo Dot', 'hint dot');
    const mainText = await s.page.evaluate(() => document.querySelector('.sc-main').innerText);
    assert(mainText.indexOf('Golden Hour Drive') < 0 && mainText.indexOf('Spotify') < 0, 'Spotify leaked into the info area');
    // Everywhere: one row for each speaker, nothing of the winner.
    await pickSpk(s.page, 'everywhere');
    i = await info(s.page);
    assert(!i.hasInfo && i.members, 'Everywhere shows the rows, not the song');
    const rows = await texts(s.page, '.sc-mrow');
    assert(rows.length === 2 && /^Echo Show KERA Playing/.test(rows[0]) && /35%/.test(rows[0]) && /^Echo Dot Classic Rock 101 · iHeartRadio Playing/.test(rows[1]) && /60%/.test(rows[1]), 'rows: ' + rows.join(' || '));
    assert((await texts(s.page, '.sc-showing'))[0] === 'Showing all speakers', 'hint all');
    assert((await texts(s.page, '.sc-main')).join().indexOf('Golden Hour Drive') < 0, 'Spotify leaked into the rows');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await shot(s.page, 'soundctl-v3-everywhere-en.png');
    await s.context.close();
    await stopPi(p5);
    await sp.close();
  });

  await check('v3: the switch says what each speaker plays; selected is a tinted fill, focused a ring, the dot only for a playing speaker; the track itself has no fill', async () => {
    const p = await startPi(true);
    await house(p, 'twoplaying');
    const s = await openPage(p, 'en', false, 3, 2, false);
    const read = () => s.page.evaluate(() => {
      const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const seg = document.querySelector('.sc-seg');
      return {
        seg: getComputedStyle(seg).backgroundColor,
        chips: Array.prototype.map.call(document.querySelectorAll('.sc-spk'), (c) => {
          const cs = getComputedStyle(c);
          const dot = c.querySelector('.sc-dot');
          const sub = c.querySelector('.sc-spk-sub');
          return {
            key: c.getAttribute('data-spk'), sel: /is-sel/.test(c.className), focus: /is-focused/.test(c.className), bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor,
            dot: dot ? getComputedStyle(dot).backgroundColor : '', name: c.querySelector('.sc-spk-name').textContent, sub: sub.textContent, subPx: parseFloat(getComputedStyle(sub).fontSize) / px
          };
        })
      };
    });
    const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); const a = m ? m[1].split(',').map(Number) : [0, 0, 0, 0]; return a.length > 3 ? a[3] : 1; };
    await pickSpk(s.page, 'show');
    // Focus now on the Show chip: selected and focused at once.
    let r = await read();
    assert(alpha(r.seg) === 0, 'the track has no fill: ' + r.seg);
    const by = (k) => r.chips.filter((c) => c.key === k)[0];
    assert(by('show').sel && by('show').focus && alpha(by('show').bg) >= 0.25, 'selected and focused: ' + JSON.stringify(by('show')));
    assert(!by('dot').sel && !by('dot').focus && alpha(by('dot').bg) === 0, 'unselected is transparent: ' + by('dot').bg);
    assert(alpha(by('show').border) > 0.9 && alpha(by('dot').border) === 0, 'only the focused one has a ring: ' + by('show').border + ' / ' + by('dot').border);
    assert(by('show').color !== by('dot').color, 'the selected text is brighter than the others');
    assert(by('show').sub === 'KERA' && by('dot').sub === 'Classic Rock 101' && by('everywhere').sub === '2 playing', 'second lines: ' + r.chips.map((c) => c.sub).join(' | '));
    assert(r.chips.every((c) => c.dot !== '' && alpha(c.dot) > 0), 'both speakers and the group are playing: dots');
    assert(r.chips.every((c) => c.subPx >= 0.85), 'the second line is at least 0.85rem');
    // Move the focus off the selected chip: the ring moves, the fill stays.
    await s.page.keyboard.press('ArrowRight');
    await sleepMs(80);
    r = await read();
    assert(by('show').sel && !by('show').focus && by('dot').focus && !by('dot').sel, 'the ring and the fill are separate: ' + JSON.stringify([by('show').sel, by('show').focus, by('dot').focus, by('dot').sel]));
    assert(alpha(by('show').bg) >= 0.25 && alpha(by('dot').bg) === 0 && alpha(by('show').border) === 0, 'fill stays on the selected, ring on the focused');
    // Dot idle, Show paused: no dots, "Paused" / "Idle".
    ha.set('amazonmusic');
    await p.h.allsounds.poll();
    await until(async () => { r = await read(); return by('dot').sub === 'Idle' ? r : false; }, 4000, 'the Dot never said Idle');
    assert(alpha(by('dot').dot) === 0 && alpha(by('show').dot) > 0, 'the dot only for a speaker that plays');
    ha.set('paused');
    await p.h.allsounds.poll();
    await sleepMs(300);
    r = await read();
    assert(r.chips.map((c) => c.sub).join('|').indexOf('Paused') >= 0 || r.chips.every((c) => c.sub), 'paused: ' + r.chips.map((c) => c.sub).join('|'));
    ha.set('twoplaying');
    await s.context.close();
    await stopPi(p);
  });

  await check('v3: Everywhere rows have their own Play/Pause and volume (they act on that speaker only); the big transport acts on all; quick starts play on all; D-pad goes through the rows', async () => {
    const p = await startPi(true, false, { echoScreenMax: 100 });
    await house(p, 'twoplaying');
    ha.services.length = 0;
    const s = await openPage(p, 'en', false, 3, 2, false);
    await pickSpk(s.page, 'everywhere');
    const key = () => focusKey(s.page);
    const press = async (k) => { await s.page.keyboard.press(k); await sleepMs(90); return key(); };
    // The group's transport is labelled for all speakers.
    const lab = (await texts(s.page, '.sc-rlabel')).filter(Boolean);
    assert(lab.join('|').toLowerCase() === 'speaker|all speakers|start', 'labels: ' + lab.join('|'));
    assert((await press('ArrowDown')) === 'm:show:toggle' || /^m:show:/.test(await key()), 'Down from the picker enters the first row: ' + (await key()));
    for (let i = 0; i < 4 && (await key()) !== 'm:show:toggle'; i++) await press('ArrowLeft');
    assert((await key()) === 'm:show:toggle', 'row 1 starts at Play/Pause');
    assert((await press('ArrowRight')) === 'm:show:volDown' && (await press('ArrowRight')) === 'm:show:volUp' && (await press('ArrowRight')) === 'm:show:volUp', 'Left and Right stay in the row');
    assert(/^m:dot:/.test(await press('ArrowDown')), 'Down: the next row');
    assert(/^m:show:/.test(await press('ArrowUp')), 'Up: the row above');
    assert((await press('ArrowDown')) && /^m:dot:/.test(await key()), 'back to row 2');
    for (let i = 0; i < 4 && (await key()) !== 'm:dot:toggle'; i++) await press('ArrowLeft');
    // The Dot's own pause: only the Dot.
    await s.page.keyboard.press('Enter');
    await until(() => ha.services.length >= 1, 3000, 'no call');
    assert(ha.services[0].service === 'media_pause' && ha.services[0].body.entity_id === 'media_player.ian_s_echo_dot', 'the Dot only: ' + JSON.stringify(ha.services[0]));
    await sleepMs(150);
    const rowDot = (await texts(s.page, '.sc-mrow'))[1];
    assert(/Paused/.test(rowDot), 'the row says Paused at once: ' + rowDot);
    assert(/^m:dot:toggle$/.test(await key()), 'the focus stayed: ' + (await key()));
    assert((await texts(s.page, '.sc-mrow'))[0].indexOf('Playing') > 0, 'the Show row is untouched');
    // The Show's own volume: 35 -> 25, only the Show.
    await press('ArrowUp');
    for (let i = 0; i < 4 && (await key()) !== 'm:show:volDown'; i++) await press(/toggle/.test(await key()) ? 'ArrowRight' : 'ArrowLeft');
    await s.page.keyboard.press('Enter');
    await until(() => ha.services.length >= 2, 3000, 'no volume call');
    assert(ha.services[1].service === 'volume_set' && ha.services[1].body.entity_id === 'media_player.ian_s_echo_show' && ha.services[1].body.volume_level === 0.25, 'the Show volume: ' + JSON.stringify(ha.services[1]));
    assert((await texts(s.page, '.sc-mrow'))[0].indexOf('25%') > 0, 'shown at once: ' + (await texts(s.page, '.sc-mrow'))[0]);
    assert((await texts(s.page, '.sc-mrow'))[1].indexOf('60%') > 0, 'the Dot stays at 60%');
    await sleepMs(300);
    // The big transport: all speakers (the group), and the quick starts too.
    for (let i = 0; i < 5 && !/^act:/.test(await key()); i++) await press('ArrowDown');
    for (let i = 0; i < 6 && (await key()) !== 'act:toggle'; i++) await press('ArrowLeft');
    assert((await key()) === 'act:toggle', 'on the group transport');
    await s.page.keyboard.press('Enter');
    await until(() => ha.services.length >= 3, 3000, 'no group call');
    assert(ha.services[2].body.entity_id === 'media_player.everywhere', 'the group: ' + JSON.stringify(ha.services[2]));
    await sleepMs(300);
    await press('ArrowDown');
    for (let i = 0; i < 6 && (await key()) !== 'q:kera'; i++) await press((await key()) === 'q:audible' ? 'ArrowRight' : 'ArrowRight');
    await s.page.keyboard.press('Enter');
    await until(() => ha.services.length >= 4, 3000, 'no quick call');
    assert(ha.services[3].service === 'play_media' && ha.services[3].body.entity_id === 'media_player.everywhere', 'the quick start plays on all: ' + JSON.stringify(ha.services[3]));
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    await s.context.close();
    await stopPi(p);
  });

  await check('v3: the Everywhere rows and the new switch fit, English, Spanish and Spanish 25% longer, page and full screen, three tile sizes', async () => {
    const p = await startPi(true);
    await house(p, 'twoplaying');
    const bad = [];
    for (const [w, h] of [[3, 2], [6, 3], [4, 6]]) {
      for (const [lang, longer] of LONGS) {
        for (const full of [false, true]) {
          const s = await openPage(p, lang, longer, w, h, full);
          const label = w + 'x' + h + ' ' + lang + (longer ? '+25' : '') + (full ? ' full' : ' page');
          for (const who of ['show', 'everywhere']) {
            try { await pickSpk(s.page, who); } catch (e) { throw new Error(label + ' ' + who + ': ' + e.message); }
            const pr = (await problems(s.page, '.sc-page')).concat(await ctlProblems(s.page));
            if (pr.length) bad.push(label + ' ' + who + ': ' + pr.join('; '));
            if (who === 'everywhere') {
              await s.page.keyboard.press('ArrowDown');
              await sleepMs(100);
              const pr2 = await ctlProblems(s.page);
              if (pr2.length) bad.push(label + ' everywhere (row focused): ' + pr2.join('; '));
            }
          }
          await s.context.close();
        }
      }
    }
    assert(!bad.length, bad.join(' | '));
    await stopPi(p);
  });

  // The v3 screenshots and the annotated test guides (only with SHOTS=folder).
  await check('v3 screenshots: Show, Dot, Everywhere (English, Spanish, a row focused), the Start row, and the annotated guides', async () => {
    if (!SHOTS) return;
    const p = await startPi(true, false, { echoScreenMax: 100 });
    await house(p, 'twoplaying');
    const focusTo = async (s, want, moves) => {
      for (let i = 0; i < 12 && (await focusKey(s.page)) !== want; i++) { await s.page.keyboard.press(moves[i % moves.length]); await sleepMs(80); }
      assert((await focusKey(s.page)) === want, 'could not reach ' + want + ': ' + (await focusKey(s.page)));
    };
    // The Echo Show (focus on Play/Pause) and the guide over it.
    let s = await openPage(p, 'en', false, 3, 2, false);
    await pickSpk(s.page, 'show');
    await s.page.keyboard.press('ArrowDown'); await sleepMs(100);
    await focusTo(s, 'act:toggle', ['ArrowLeft']);
    if (process.env.DBG) console.log(JSON.stringify(await s.page.evaluate(() => { const g = (q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height), e.className]; }; return { body: g('#panel .panel-body'), main: g('.sc-main'), ctl: g('.sc-ctl'), r1: g('.sc-row-spk'), r2: g('.sc-row-tr'), r3: g('.sc-row-quick'), art: g('.sc-art'), tbox: g('.sc-tbox') }; })));
    await shot(s.page, 'v3-show-en.png');
    await guide(s, 'guide-annotated-en.png', false);
    await pickSpk(s.page, 'dot');
    await shot(s.page, 'v3-dot-en.png');
    await pickSpk(s.page, 'everywhere');
    await shot(s.page, 'v3-everywhere-en.png');
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(100);
    await focusTo(s, 'm:dot:volUp', ['ArrowDown', 'ArrowRight', 'ArrowRight']);
    await shot(s.page, 'v3-everywhere-focus-row-en.png');
    await guide(s, 'guide-everywhere-en.png', true);
    await s.context.close();
    s = await openPage(p, 'es', false, 3, 2, false);
    await pickSpk(s.page, 'everywhere');
    await shot(s.page, 'v3-everywhere-es.png');
    await s.context.close();
    // The Start row, focused, with Spotify and the NPR newscast in view.
    s = await openPage(p, 'en', false, 3, 2, false);
    await pickSpk(s.page, 'show');
    await s.page.keyboard.press('ArrowDown'); await sleepMs(100);
    await focusTo(s, 'act:toggle', ['ArrowLeft']);
    await s.page.keyboard.press('ArrowDown');
    await sleepMs(100);
    await focusTo(s, 'q:spotify', ['ArrowRight']);
    await shot(s.page, 'start-row-after.png');
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
    assert(apps.join() === 'audible,kera,npr,spotify,pandora,amazon-music', 'quick starts: ' + apps.join());
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
