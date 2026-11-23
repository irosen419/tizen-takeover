/*
 * Newer code on the Pi, for pages the Pi serves (app/appver.js): node dev/appver-test.js
 *
 * Runs the real hub page in headless Chromium, served by the real hub server
 * from pi/ at /app/hub.html (as the wall tablet loads it). GET /health is
 * answered by Playwright routing, so each check picks the version the "Pi"
 * reports. Covers: off under TizenBrew (managed) and off the Pi's /app/ path;
 * current; an update available (the About text, the dot on the Clock tile,
 * a tap that reloads); Spanish; unreachable; no reload while the hub is in
 * use; one reload by itself when idle, and never a second for the same
 * version. Needs Playwright. Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const hubServer = require('../pi/server');

const ROOT = path.join(__dirname, '..');
const BUILD = /var BUILD = 'v([\d.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'hub.js'), 'utf8'))[1];
const NEWER = '99.0.0';
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n').slice(0, 4).join('\n      '));
  }
}
function assert(ok, text) { if (!ok) throw new Error(text); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-appver-'));
  const hub = hubServer.start({ port: 0, token: 'appver-test-token-0123456789abcdef', log: false, dataDir: dataDir, appDir: path.join(ROOT, 'app') });
  await hub.ready;
  const base = 'http://127.0.0.1:' + hub.port;
  const browser = await chromium.launch();

  // A page on /app/hub.html; the Pi says `app` (null: unreachable), after `delay` ms.
  async function open(opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    if (opts.lang) await ctx.addInitScript((l) => { try { localStorage.setItem('homeHub.lang', l); } catch (e) { /* */ } }, opts.lang);
    const page = await ctx.newPage();
    page.app = opts.app === undefined ? BUILD : opts.app;
    page.loads = 0;
    page.health = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) page.loads++; });
    await page.route(/\/health(\?|$)/, async (route) => {
      page.health++;
      if (opts.delay) await sleep(opts.delay);
      if (page.app === null) return route.abort();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, server: '0.32.0', app: page.app }) });
    });
    // Outside addresses (fonts, weather) are not needed here.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    await page.goto(base + '/app/hub.html' + (opts.query || ''));
    await page.waitForFunction(() => window.HUB_TEST && window.HUB_TEST.about && window.HUB_APPVER, null, { timeout: 15000 });
    page.ctx = ctx;
    return page;
  }
  const state = (page) => page.evaluate(() => window.HUB_APPVER.status());
  const waitState = (page, s) => page.waitForFunction((x) => window.HUB_APPVER.status().state === x, s, { timeout: 8000 });
  const about = (page) => page.evaluate(() => {
    window.HUB_TEST.about.open();
    const rows = window.HUB_TEST.about.rows();
    const acts = Array.prototype.map.call(document.querySelectorAll('#about .about-row'), (r) => r.className.indexOf('is-action') >= 0);
    return { rows: rows, acts: acts };
  });
  const row = (a, label) => a.rows.filter((r) => r.label === label)[0] || null;
  const dotOn = (page) => page.evaluate(() => {
    const d = document.querySelector('.cell[data-widget="today"] .update-dot');
    return !!d && d.className.indexOf('is-on') >= 0 && getComputedStyle(d).opacity !== '0';
  });

  await check('off under TizenBrew (update.js managed) and off the Pi\'s /app/ path', async () => {
    const page = await open({ delay: 300 });
    const s = await page.evaluate(() => new Promise((res) => {
      window.HUB_UPDATE.status = () => ({ managed: true, state: 'current', text: '' });
      window.HUB_APPVER.check((st) => res(st.state));
    }));
    assert(s === 'off', 'managed: ' + s);
    const s2 = await page.evaluate(() => new Promise((res) => {
      window.HUB_UPDATE.status = () => ({ managed: false, state: 'off', text: '' });
      history.replaceState(null, '', '/elsewhere/hub.html');
      window.HUB_APPVER.check((st) => res(st.state));
    }));
    assert(s2 === 'off', 'not on /app/: ' + s2);
    await page.ctx.close();
  });

  await check('current: "Up to date", the Version row says newest, no dot', async () => {
    const page = await open();
    await waitState(page, 'current');
    const a = await about(page);
    assert(row(a, 'Version check').value === 'Up to date', JSON.stringify(a.rows));
    assert(row(a, 'Version').value === 'v' + BUILD + ' (newest)', row(a, 'Version').value);
    assert(!(await dotOn(page)), 'dot shown');
    assert(page.health === 1, 'checks: ' + page.health);
    await page.ctx.close();
  });

  await check('available while in use: text, OK row, dot, no reload; a tap reloads', async () => {
    const page = await open({ app: NEWER, delay: 600 });
    await page.evaluate(() => window.HUB_TEST.setIdle(false));
    await waitState(page, 'available');
    const a = await about(page);
    const r = row(a, 'Version check');
    assert(r && r.value === 'Update available: v' + NEWER + ' (tap to reload)', JSON.stringify(a.rows));
    assert(a.acts[a.rows.indexOf(r)] === true, 'row not an action');
    assert(row(a, 'Version').value === 'v' + BUILD, row(a, 'Version').value);
    assert(await dotOn(page), 'no dot');
    await page.evaluate(() => { window.__same = 1; });
    await sleep(1500);
    assert(await page.evaluate(() => window.__same === 1), 'reloaded while in use');
    await page.click('#about .about-row.is-action >> text=tap to reload');
    await page.waitForFunction(() => window.__same === undefined && window.HUB_APPVER, null, { timeout: 8000 });
    await page.ctx.close();
  });

  await check('Spanish: the row is in Spanish; unreachable says so', async () => {
    const page = await open({ app: NEWER, delay: 600, lang: 'es' });
    await page.evaluate(() => window.HUB_TEST.setIdle(false));
    await waitState(page, 'available');
    let a = await about(page);
    const v = row(a, 'Version check').value;
    assert(v === 'Hay versión nueva: v' + NEWER + ' (toca para recargar)', JSON.stringify(v));
    page.app = null;
    await page.evaluate(() => new Promise((res) => window.HUB_APPVER.check(res)));
    await sleep(1200);   // the strip redraws once a second
    a = await about(page);
    assert(row(a, 'Version check').value === 'Sin conexión con la Pi', row(a, 'Version check').value);
    assert((await state(page)).text === 'Can’t reach the Pi', 'English text');
    await page.ctx.close();
  });

  await check('idle: reloads by itself once, and never again for the same version', async () => {
    const page = await open({ app: NEWER });
    // Idle from the start (no input yet): the first answer reloads; the page
    // still has the old hub.js afterwards, and must not reload again.
    await page.waitForFunction(() => { try { return sessionStorage.getItem('homeHub.appver.reloaded'); } catch (e) { return false; } }, null, { timeout: 8000 });
    await page.waitForFunction(() => window.HUB_APPVER && window.HUB_APPVER.status().state === 'available', null, { timeout: 15000 });
    await page.evaluate(() => new Promise((res) => window.HUB_APPVER.check(res)));
    await sleep(2000);
    assert(page.loads === 2, 'loads: ' + page.loads + ' idle ' + (await page.evaluate(() => window.HUB_TEST.idle())) + ' busy ' + (await page.evaluate(() => window.HUB_TEST.busy())));
    const kept = await page.evaluate(() => sessionStorage.getItem('homeHub.appver.reloaded'));
    assert(kept === NEWER, kept);
    // A still newer version gets its one reload too.
    page.app = '99.0.1';
    await page.evaluate(() => { window.HUB_TEST.setIdle(true); window.HUB_APPVER.check(); });
    await sleep(2500);
    assert(page.loads === 3, 'loads after a newer one: ' + page.loads);
    await page.ctx.close();
  });

  await browser.close();
  await new Promise((r) => hub.close(r));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* left over */ }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
