/*
 * What dev/shows-test.js and dev/shows-shots.js share: the preview (its own
 * ports), the Pi's hub server with the made-up show sample
 * (pi/fixtures/shows-sample.json) and its clock fixed, and a headless
 * Chromium page of the hub at 1920x1080 in Chicago. Nothing here reaches the
 * internet: TVmaze is never asked (the sample needs no lookups).
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const TOKEN = 'preview-token-not-a-secret-000000';
const TZ = 'America/Chicago';
// Tuesday 17 November 2026, 7:25 PM in Chicago: Paradise starts in 35 minutes.
const TUESDAY = Date.parse('2026-11-18T01:25:00Z');
const SAMPLE = path.join(__dirname, '..', 'pi', 'fixtures', 'shows-sample.json');
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219', 'api.tvmaze.com'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spare() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { /* not yet */ }
    await sleep(100);
  }
  throw new Error(what);
}

function getOk(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  });
}

/*
 * opts: { at (UTC ms), shows: 'sample' | 'none' (a Pi that sends no shows) }.
 * Returns { PAGE, LIVE, pi, logs, newPage(o), stop(), launches }.
 */
async function start(opts) {
  opts = opts || {};
  const env = { at: opts.at || TUESDAY, logs: [], launches: [] };
  env.PAGE_PORT = await spare();
  env.SERVICE_PORT = await spare();
  env.LIVE_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.LIVE = 'http://127.0.0.1:' + env.LIVE_PORT;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: String(env.SERVICE_PORT), HUB_LIVE_PORT: 'off' }),
    stdio: ['ignore', 'pipe', 'ignore']
  });
  env.preview.stdout.on('data', (c) => {
    String(c).split('\n').forEach((l) => { if (/launch/.test(l)) env.launches.push(l.replace(/^\[[^\]]*\] /, '')); });
  });
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shows-'));
  const server = require('../pi/server');
  env.pi = server.start({
    port: env.LIVE_PORT, host: '127.0.0.1', token: TOKEN, origins: [env.PAGE], dataDir: env.dataDir,
    log: (s) => env.logs.push(s), now: () => new Date(env.at),
    shows: opts.shows === 'none' ? undefined : { sampleFile: SAMPLE }
  });
  await env.pi.ready;
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();
  env.newPage = (o) => openHub(env, o || {});
  env.stop = async () => {
    try { await env.browser.close(); } catch (e) { /* ignore */ }
    await new Promise((r) => env.pi.close(r));
    try { env.preview.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(env.dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };
  return env;
}

/*
 * o: { lang: 'es', hours: '24', live ('off' or an address), storage {}, layout [...] }.
 */
async function openHub(env, o) {
  const context = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: TZ });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const u = route.request().url();
    const host = new URL(u).hostname;
    if (BLOCKED.indexOf(host) >= 0) return route.abort();
    if (u.indexOf('127.0.0.1:8095/') >= 0) return route.continue({ url: u.replace(':8095/', ':' + env.SERVICE_PORT + '/') });
    return route.fallback();
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  await page.clock.setFixedTime(new Date(o.at || env.at));
  const storage = Object.assign({}, o.storage || {});
  if (o.lang) storage['homeHub.lang'] = o.lang;
  if (o.hours) storage['homeHub.clock.hours'] = o.hours;
  if (o.layout) {
    storage['homeHub.layout'] = JSON.stringify(o.layout);
    storage['homeHub.layoutChoice'] = JSON.stringify({ id: 'test', piSig: '' });
  }
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('shows-seeded')) return;
      sessionStorage.setItem('shows-seeded', '1');
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, storage);
  const live = o.live === undefined ? env.LIVE : o.live;
  await page.goto(env.PAGE + '/hub.html?motion=fade&clay=off&live=' + encodeURIComponent(live));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
  if (live !== 'off' && o.waitLive !== false) {
    await page.waitForFunction(() => window.HUB_SHOWS && window.HUB_SHOWS.state() === 'data', null, { timeout: 15000 });
  }
  page.ctx = context;
  return page;
}

// Opens Entertainment on one of its views (schedule, linktests) the way the
// About panel's action does: the widget's openView hook, then the panel.
async function openView(page, name, tab) {
  if (tab) await page.evaluate((t) => window.HUB_SHOWS._test.tab(t), tab);
  const ok = await page.evaluate((n) => {
    const list = window.HUB_WIDGETS || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === 'entertainment') {
        if (list[i].openView(n) === false) return false;
        return window.HUB_TEST.openPanel('entertainment');
      }
    }
    return false;
  }, name);
  if (!ok) throw new Error('could not open ' + name);
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy()), 6000, 'the panel did not open');
  await sleep(400);
}

// Up to the panel's Full screen button, OK, then back down into the view.
async function fullScreen(page) {
  for (let i = 0; i < 14; i++) {
    const on = await page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !!f && !document.querySelector('#panel .panel-body').contains(f); });
    if (on) break;
    await key(page, 'ArrowUp');
  }
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy()), 6000, 'full screen did not open');
  await sleep(400);
}

// Presses Down (then Up) until the focused element's data-key starts with want.
async function focusKey(page, want) {
  const at = () => page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || '' : ''; });
  for (const dir of ['ArrowDown', 'ArrowUp']) {
    for (let i = 0; i < 12; i++) {
      const k = await at();
      if (k.indexOf(want) === 0) return true;
      // On the row's "Also on" chip: Left is the row itself.
      if (k.indexOf('sh:alt:') === 0 && want.indexOf('sh:row:') === 0 && k.slice(7).indexOf(want.slice(7)) === 0) await key(page, 'ArrowLeft');
      else await key(page, dir);
    }
  }
  if ((await at()).indexOf(want) === 0) return true;
  throw new Error('could not focus ' + want);
}

const openSchedule = (page, tab) => openView(page, 'schedule', tab);

async function key(page, k, n) {
  for (let i = 0; i < (n || 1); i++) { await page.keyboard.press(k); await sleep(120); }
}

module.exports = { start, openView, fullScreen, focusKey, openSchedule, key, sleep, until, TUESDAY, TZ, TOKEN, SAMPLE };
