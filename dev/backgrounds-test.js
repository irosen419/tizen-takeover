/*
 * The day and night pictures, end to end: node dev/backgrounds-test.js
 *
 * Runs the real hub in headless Chromium at 1920x1080 against the preview
 * (dev/preview.js, without live updates), with its own HUB_BACKGROUNDS list
 * (3 day pictures, 2 night pictures; every file is the ocean picture's bytes):
 *
 *   - ?bg=day/N and ?bg=night/N pick entry N of that list (and wrap).
 *   - Without ?bg=, the entry is dayNumber % length on the TV's local date,
 *     and it changes with the date.
 *   - A file path in HUB_CONFIG.background is one picture for both looks;
 *     '' is none.
 *   - The About panel's Picture row says "title · credit".
 *   - When the look switches (day to night at 6 PM), the picture swaps to a
 *     night one, together with the look.
 *   - If the new picture fails, the old picture stays and the look still
 *     switches.
 *
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure. Nothing here reaches the internet.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];
const ZONE = 'America/Chicago';
const PICTURE = fs.readFileSync(path.join(__dirname, '..', 'app', 'backgrounds', 'ocean.jpg'));

const MANIFEST = 'var HUB_BACKGROUNDS = { day: [' +
  '{ file: "backgrounds/test/d0.jpg", title: "Day zero", credit: "Photo: A" },' +
  '{ file: "backgrounds/test/d1.jpg", title: "Day one", credit: "Photo: B, CC BY 4.0" },' +
  '{ file: "backgrounds/test/d2.jpg", title: "Day two", credit: "Photo: C" }],' +
  ' night: [' +
  '{ file: "backgrounds/test/n0.jpg", title: "Night zero", credit: "Photo: D" },' +
  '{ file: "backgrounds/test/n1.jpg", title: "Night one", credit: "Photo: E" }] };';

let PAGE_PORT, PAGE;
let preview = null;
let browser = null;
const results = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, text) { if (!cond) throw new Error(text); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { /* try again */ }
    await sleep(60);
  }
  throw new Error(text);
}

function waitForPort(port) {
  return until(() => new Promise((resolve) => {
    http.get('http://127.0.0.1:' + port + '/', (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
}

// opts: { query, at (ms), config (JS run after config.js), failFiles: [names that 404] }
async function openHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: ZONE });
  context.errors = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    // No weather either, so the look follows the plain 7 AM to 6 PM clock.
    if (BLOCKED_HOSTS.indexOf(url.hostname) >= 0 || url.pathname === '/fetch') return route.abort();
    if (/\/backgrounds\/backgrounds\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: MANIFEST });
    const m = /\/backgrounds\/test\/(\w+\.jpg)$/.exec(url.pathname);
    if (m) {
      if ((opts.failFiles || []).indexOf(m[1]) >= 0) return route.fulfill({ status: 404, body: 'no' });
      return route.fulfill({ contentType: 'image/jpeg', body: PICTURE });
    }
    if (opts.config && /\/config\.js$/.test(url.pathname)) {
      return route.fetch().then((res) => res.text().then((body) => route.fulfill({ response: res, body: body + '\n' + opts.config })));
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  if (opts.at) await page.clock.install({ time: opts.at });
  await page.goto(PAGE + '/?motion=fade&live=off&clay=off' + (opts.query || ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('#grid .tile-body *'));
  return page;
}

// The picture file on the backdrop, once it is there ('' = none).
function backdrop(page) {
  return page.evaluate(() => {
    const el = document.getElementById('backdrop') || document.querySelector('.backdrop');
    const bg = el ? el.style.backgroundImage : '';
    const m = /([\w]+)\.jpg/.exec(bg || '');
    return m ? m[1] : '';
  });
}

async function expectBackdrop(page, name, text) {
  await until(async () => (await backdrop(page)) === name, 4000, text + ': backdrop is "' + (await backdrop(page)) + '", wanted "' + name + '"');
}

function pictureRow(page) {
  return page.evaluate(() => {
    window.HUB_TEST.about.open();
    const rows = window.HUB_TEST.about.rows().filter((r) => r.label === 'Picture');
    window.HUB_TEST.about.close && window.HUB_TEST.about.close();
    return rows.length ? rows[0].value : null;
  });
}

function dayNumberOf(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)).split('-');
  return Math.floor(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]) / 86400000);
}

const NOON = Date.parse('2026-11-17T18:00:00Z');   // 12:00 in Chicago
const DUSK = Date.parse('2026-11-17T23:58:00Z');   // 5:58 PM in Chicago: the look changes at 6:00 PM

const CHECKS = [
  ['?bg=day/N and ?bg=night/N pick entry N of their list', async () => {
    let p = await openHub({ query: '&theme=day&bg=day/1' });
    await expectBackdrop(p, 'd1', 'day/1');
    p = await openHub({ query: '&theme=night&bg=night/1' });
    await expectBackdrop(p, 'n1', 'night/1');
    p = await openHub({ query: '&theme=day&bg=day/5' });
    await expectBackdrop(p, 'd2', 'day/5 wraps to 2');
    // ?bg= for the other look does not touch this look's pick.
    p = await openHub({ query: '&theme=day&bg=night/1', at: NOON });
    await expectBackdrop(p, 'd' + (dayNumberOf(NOON) % 3), 'night/1 leaves the day pick alone');
  }],
  ['without ?bg=, dayNumber % length on the local date, and a new one each day', async () => {
    let p = await openHub({ query: '&theme=day', at: NOON });
    await expectBackdrop(p, 'd' + (dayNumberOf(NOON) % 3), 'day pick');
    p = await openHub({ query: '&theme=night', at: NOON });
    await expectBackdrop(p, 'n' + (dayNumberOf(NOON) % 2), 'night pick');
    const next = NOON + 86400000;
    p = await openHub({ query: '&theme=day', at: next });
    await expectBackdrop(p, 'd' + (dayNumberOf(next) % 3), 'next day pick');
    assert(dayNumberOf(next) === dayNumberOf(NOON) + 1, 'test dates are a day apart');
  }],
  ['a file in the config is one picture for both looks; \'\' is none', async () => {
    let p = await openHub({ query: '&theme=night', config: "HUB_CONFIG.background = 'backgrounds/test/d2.jpg';" });
    await expectBackdrop(p, 'd2', 'one picture at night');
    p = await openHub({ query: '&theme=day', config: "HUB_CONFIG.background = 'backgrounds/test/d2.jpg';" });
    await expectBackdrop(p, 'd2', 'one picture by day');
    p = await openHub({ query: '&theme=day', config: "HUB_CONFIG.background = '';" });
    await sleep(500);
    assert((await backdrop(p)) === '', 'a picture with background \'\'');
    assert(!(await p.evaluate(() => document.body.classList.contains('has-picture'))), 'has-picture with no picture');
  }],
  ['About: the Picture row says title and credit', async () => {
    const p = await openHub({ query: '&theme=day&bg=day/1' });
    await expectBackdrop(p, 'd1', 'day/1');
    const v = await pictureRow(p);
    assert(v === 'Day one · Photo: B, CC BY 4.0', 'Picture row: ' + v);
  }],
  ['the corner label names the picture, hides under a panel, and can be turned off', async () => {
    let p = await openHub({ query: '&theme=day&bg=day/1' });
    await expectBackdrop(p, 'd1', 'day/1');
    const label = () => p.evaluate(() => { const e = document.getElementById('picLabel'); return { text: e.textContent, on: e.classList.contains('is-on'), z: getComputedStyle(e).zIndex }; });
    let l = await label();
    assert(l.text === 'Day one' && l.on, 'label: ' + JSON.stringify(l));
    await p.evaluate(() => window.HUB_TEST.about.close());
    const opened = await p.evaluate(() => { const w = document.querySelector('.cell[data-widget="today"]'); return !!w; });
    assert(opened, 'no today tile');
    await p.keyboard.press('Enter');
    await until(async () => (await p.evaluate(() => window.HUB_TEST.open())) !== null, 4000, 'no panel opened');
    l = await label();
    assert(!l.on, 'label shows over a panel: ' + JSON.stringify(l));
    await until(() => p.evaluate(() => !window.HUB_TEST.busy()), 4000, 'stayed busy');
    await p.keyboard.press('Escape');
    await until(async () => (await label()).on, 4000, 'label did not come back');
    p = await openHub({ query: '&theme=day&bg=day/1', config: 'HUB_CONFIG.pictureLabel = false;' });
    await expectBackdrop(p, 'd1', 'no label');
    l = await label();
    assert(l.text === '' && !l.on, 'label with pictureLabel false: ' + JSON.stringify(l));
  }],
  ['the look switches at 6 PM and the picture swaps with it', async () => {
    const p = await openHub({ at: DUSK });
    const day = 'd' + (dayNumberOf(DUSK) % 3);
    await expectBackdrop(p, day, 'day picture at 5:58 PM');
    assert(await p.evaluate(() => document.body.classList.contains('theme-day')), 'not the day look');
    const glassBefore = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glass-img').length);
    assert(glassBefore > 20, '--glass-img not set');
    const night = 'n' + (dayNumberOf(DUSK) % 2);
    await p.clock.runFor(300000);
    await until(async () => {
      await p.clock.runFor(300);
      return (await backdrop(p)) === night && await p.evaluate(() => document.body.classList.contains('theme-night'));
    }, 8000, 'no swap to ' + night + ' (backdrop "' + (await backdrop(p)) + '")');
    assert(await p.evaluate(() => document.body.classList.contains('is-glass') && !document.body.classList.contains('glass-tint-only')), 'glass lost on the swap');
    const v = await pictureRow(p);
    assert(/^Night (zero|one) · Photo: [DE]$/.test(v), 'Picture row after the swap: ' + v);
  }],
  ['a picture that fails keeps the old one and the look still switches', async () => {
    const night = 'n' + (dayNumberOf(DUSK) % 2);
    const p = await openHub({ at: DUSK, failFiles: [night + '.jpg'] });
    const day = 'd' + (dayNumberOf(DUSK) % 3);
    await expectBackdrop(p, day, 'day picture');
    await p.clock.runFor(300000);
    await until(async () => {
      await p.clock.runFor(300);
      return p.evaluate(() => document.body.classList.contains('theme-night'));
    }, 8000, 'the look did not switch');
    assert((await backdrop(p)) === day, 'backdrop changed to "' + (await backdrop(p)) + '"');
    assert(await p.evaluate(() => document.body.classList.contains('has-picture')), 'the picture was lost');
  }]
];

async function main() {
  PAGE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await waitForPort(PAGE_PORT);
  browser = await chromium.launch();
  for (const c of CHECKS) {
    try { await c[1](); results.push([c[0], null]); console.log('ok   ' + c[0]); }
    catch (e) { results.push([c[0], e]); console.log('FAIL ' + c[0] + '\n     ' + e.message); }
  }
  await browser.close();
  if (preview) preview.kill();
  const failed = results.filter((r) => r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); if (preview) preview.kill(); process.exit(1); });
