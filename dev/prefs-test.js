/*
 * Widget preferences shared by every screen (app/prefs.js): node dev/prefs-test.js
 *
 * Runs the real hub in headless Chromium against the preview, with the live
 * line stubbed (dev/pin-live-stub.js answers POST /prefs like pi/prefs.js
 * and pushes the result back). No Pi server, nothing reaches the internet.
 *
 *   - prefs.js is plain ES5, loads before the widgets, keys match pi/prefs.js.
 *   - A Clock choice made on this screen before (homeHub.clock.hours) is
 *     read once and sent up when the Pi has none; the old key is gone.
 *   - The Pi's copy wins over an older per-screen choice.
 *   - Analog picked on another screen: this tile turns analog, live.
 *   - 24-hour picked on the Clock page: POST /prefs, and the show times'
 *     hours24 follows (shows.js reads the shared value).
 *   - An older Pi (POST /prefs refused): the choice still holds here.
 *   - Budget lab's saved cap is the shared 'budget.capPref'.
 * Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const childProcess = require('child_process');
const clockPage = require('./clock-page');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OCEAN_JPG = fs.readFileSync(path.join(ROOT, 'app', 'backgrounds', 'ocean.jpg'));
const STUB = fs.readFileSync(path.join(__dirname, 'pin-live-stub.js'), 'utf8');
let passed = 0;
let failed = 0;

function assert(ok, text) { if (!ok) throw new Error(text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + ': ' + String(e && e.message).split('\n')[0]);
  }
}
function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getOk(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  });
}

const LAYOUT = [{ widget: 'today', x: 0, y: 0, w: 3, h: 2 }];
const env = {};

// o: { storage: extra localStorage, noPrefs: an older Pi }
async function open(o) {
  o = o || {};
  const context = await env.browser.newContext({ viewport: { width: 1920, height: 1080 } });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev') return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*' }, body: OCEAN_JPG });
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return route.abort();
    return route.fallback();
  });
  await context.route(/\/live\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  const storage = Object.assign({ 'homeHub.layout': JSON.stringify(LAYOUT), 'homeHub.lang': 'en' }, o.storage || {});
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('prefs-seeded')) return;
      sessionStorage.setItem('prefs-seeded', '1');
      localStorage.clear();
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, storage);
  await page.goto(env.PAGE + '/?motion=fade&clay=off&live=off');
  await page.waitForFunction(() => window.HUB_TEST && window.HUB_PREFS && window.PIN_STUB && document.querySelector('.cell[data-widget="today"]'), null, { timeout: 15000 });
  if (o.noPrefs) await page.evaluate(() => { window.PIN_STUB.noPrefs = true; });
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(200);
  page.ctx = context;
  return page;
}

const analogTile = (p) => p.evaluate(() => !!document.querySelector('.cell[data-widget="today"] svg'));
const prefPosts = (p) => p.evaluate(() => window.PIN_STUB.posts.filter((x) => x.path === '/prefs').map((x) => x.body));

async function main() {
  env.PAGE_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', LIGHTS_MODE: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();

  try {
    await check('prefs.js is plain ES5, loads before the widgets; its keys match pi/prefs.js', () => {
      const text = fs.readFileSync(path.join(ROOT, 'app/prefs.js'), 'utf8');
      assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
      const hub = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      assert(hub.indexOf('src="prefs.js"') > 0 && hub.indexOf('src="prefs.js"') < hub.indexOf('src="widgets/today.js"'), 'hub.html order');
      const keys = /var KEYS = (\[[^\]]+\])/.exec(text)[1].replace(/'/g, '"');
      assert(JSON.stringify(JSON.parse(keys)) === JSON.stringify(require('../pi/prefs').KEYS), 'keys differ from pi/prefs.js');
    });

    await check('an older per-screen choice is read once and sent up when the Pi has none; the old key is gone', async () => {
      const p = await open({ storage: { 'homeHub.clock.hours': '24', 'homeHub.clock.face': 'analog' } });
      assert(await analogTile(p), 'the tile is not analog');
      await p.evaluate(() => window.PIN_STUB.push('prefs', { values: {}, at: {} }));
      await until(async () => (await prefPosts(p)).length >= 2, 3000, 'not sent up');
      const posts = await prefPosts(p);
      assert(posts.some((b) => b.key === 'clock.hours' && b.value === '24') && posts.some((b) => b.key === 'clock.face' && b.value === 'analog'), JSON.stringify(posts));
      assert(await p.evaluate(() => localStorage.getItem('homeHub.clock.hours') === null), 'old key still there');
      assert(await analogTile(p), 'lost analog after the push back');
      await p.ctx.close();
    });

    await check('the Pi\'s copy wins over an older per-screen choice', async () => {
      const p = await open({ storage: { 'homeHub.clock.face': 'analog' } });
      await p.evaluate(() => window.PIN_STUB.push('prefs', { values: { 'clock.face': 'digital' }, at: { 'clock.face': 'x' } }));
      await until(async () => !(await analogTile(p)), 3000, 'still analog');
      assert(!(await prefPosts(p)).length, 'sent its own over the Pi\'s');
      await p.ctx.close();
    });

    await check('analog picked on another screen: this tile follows, live; 24-hour on the Clock page is sent, 12-hour from another screen arrives', async () => {
      const p = await open();
      assert(!(await analogTile(p)), 'analog at the start');
      await p.evaluate(() => window.PIN_STUB.push('prefs', { values: { 'clock.face': 'analog' }, at: {} }));
      await until(() => analogTile(p), 3000, 'the tile did not follow');
      await p.evaluate(() => window.PIN_STUB.push('prefs', { values: {}, at: {} }));
      await until(async () => !(await analogTile(p)), 3000, 'did not go back to digital');
      assert(await p.evaluate(() => window.HUB_TEST.openPanel('today')), 'no panel');
      await until(() => p.evaluate(() => !!document.querySelector('#panel [data-key="hours-24"]')), 5000, 'no 24-hour option');
      await clockPage.pick(p, 'hours-24');
      await until(async () => (await prefPosts(p)).some((b) => b.key === 'clock.hours' && b.value === '24'), 3000, 'not sent');
      assert(await p.evaluate(() => window.HUB_PREFS.get('clock.hours') === '24'), 'not kept');
      // Another screen picks 12-hour: this one follows.
      await p.evaluate(() => window.PIN_STUB.push('prefs', { values: { 'clock.hours': '12' }, at: {} }));
      await until(() => p.evaluate(() => window.HUB_PREFS.get('clock.hours') === '12'), 3000, '12-hour did not arrive');
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    await check('an older Pi refuses POST /prefs: the choice still holds on this screen', async () => {
      const p = await open({ noPrefs: true });
      await p.evaluate(() => window.HUB_PREFS.set('clock.face', 'analog'));
      await until(() => analogTile(p), 3000, 'the tile did not change');
      await p.reload();
      await p.waitForFunction(() => window.HUB_PREFS && document.querySelector('.cell[data-widget="today"]'), null, { timeout: 15000 });
      await until(() => analogTile(p), 3000, 'lost after a reload');
      await p.ctx.close();
    });

    await check('Budget lab\'s saved cap is the shared budget.capPref (the old key moves over)', async () => {
      const cap = { v: 1, cardDate: '2026-12-01', keep: 214, at: '2026-11-24T20:00:00Z' };
      const p = await open({ storage: { 'homeHub.budget.capPref.v1': JSON.stringify(cap) } });
      const got = await p.evaluate(() => window.HUB_PREFS.get('budget.capPref'));
      assert(JSON.stringify(got) === JSON.stringify(cap), JSON.stringify(got));
      const src = fs.readFileSync(path.join(ROOT, 'app/widgets/budget-lab.js'), 'utf8');
      assert(/PREFS\(\)\.set\('budget\.capPref', p\)/.test(src) && /PREFS\(\)\.get\('budget\.capPref'\)/.test(src), 'budget-lab.js does not use it');
      await p.ctx.close();
    });
  } finally {
    await env.browser.close();
    env.preview.kill();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); try { env.preview.kill(); } catch (e2) { /* gone */ } process.exit(1); });
