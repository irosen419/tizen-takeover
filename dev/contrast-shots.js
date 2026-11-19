/*
 * Before and after pictures for the day-mode contrast fixes and the
 * one-widget layout: node dev/contrast-shots.js --out <folder> [--tag before|after]
 *
 * Runs the real hub in headless Chromium (1920x1080) against the preview, the
 * Pi's hub server from pi/ and the made-up lights (dev/mock-lights.js: the
 * Geeni lamp on, the Sengled lamp and the camera plug off, the plant wall off).
 *
 *   ambience-<day|night>[-es]-<tag>.png   the Ambience tile (3x2), cropped
 *   clock-<day|night>-<tag>.png           the analog Clock tile (3x2), cropped
 *   arch-solo-<tag>.png                   the "Hub architecture" layout as it starts
 *   arch-tile-<tag>.png                   the Architecture tile at 6x3 (its counts)
 *
 * "-es" is the hub in Spanish with every Ambience text 25% longer (accents
 * added). Day and night are asked for with ?theme=day|night. Needs
 * Playwright and port 8095 free. Nothing here reaches the internet.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const mockLights = require('./mock-lights');
const ambience = require('../pi/ambience');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'contrast-shots');
const TAG = arg('--tag') || 'after';
const TOKEN = 'preview-token-not-a-secret-000000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spare = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const getOk = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw new Error(what);
}

const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚÁÉñ¿¡áéíóú";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k) || !/^ambience\\./.test(k)) continue;' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.replace(/\\{\\w+\\}/g, "").length * 0.25)); es[k] = s + add.slice(0, n); } })();\n';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const PAGE_PORT = await spare();
  const PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  const preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', LIGHTS_MODE: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  const mock = await mockLights.start({});
  const mockPorts = [Number(new URL(mock.url).port), Number(new URL(mock.wledUrl).port)];
  const example = ambience.validateConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'pi', 'ambience.example.json'), 'utf8')));
  const livePort = await spare();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-contrast-'));
  ambience.saveConfig(dataDir, example);
  const server = require('../pi/server').start({
    token: TOKEN, port: livePort, host: '127.0.0.1', origins: [PAGE], dataDir: dataDir, allowHttp: true,
    calendars: [], log: () => {},
    ambienceEnv: { HA_URL: mock.url, HA_TOKEN: mock.token, WLED_URL: mock.wledUrl }, ambience: { timeoutMs: 700, screenMs: 1500, idleMs: 1500 }
  });
  await Promise.resolve(server.ready);
  const LIVE = 'http://127.0.0.1:' + livePort;
  await until(() => getOk(LIVE + '/health'), 5000, 'the hub server did not start');
  await until(() => getOk(PAGE + '/'), 10000, 'the preview did not start');
  // One of four on, as on Ian's TV: the Geeni lamp warm at 60%.
  mock.set(mock.entities[0], true, 60);
  for (let i = 1; i < mock.entities.length; i++) mock.set(mock.entities[i], false, 0);
  await server.ambience.poll();
  const browser = await chromium.launch();

  async function open(o) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route(/.*/, (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return route.abort();
      if (mockPorts.indexOf(Number(u.port)) >= 0) return route.abort();
      return route.fallback();
    });
    if (o.grow) await context.route(/\/i18n\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: I18N + GROW }));
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('  page error: ' + e.message));
    await page.addInitScript((items) => {
      try {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.clear();
        for (const k in items) localStorage.setItem(k, items[k]);
      } catch (e) { /* ignore */ }
    }, Object.assign({ 'homeHub.layout': JSON.stringify(o.layout), 'homeHub.layoutChoice': JSON.stringify({ id: 'test', piSig: '' }),
      'homeHub.lang': o.lang || 'en', 'homeHub.clock.face': 'analog' }, o.storage || {}));
    await page.goto(PAGE + '/?motion=fade&clay=off&theme=' + o.theme + '&live=' + encodeURIComponent(LIVE) + (o.lang ? '&lang=' + o.lang : ''));
    await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
    await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 8000, 'no glass');
    await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'busy');
    await sleep(1500);
    return page;
  }
  async function crop(page, sel, name, pad) {
    const box = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, sel);
    const p = pad || 24;
    await page.screenshot({ path: path.join(OUT, name), clip: { x: Math.max(0, box.x - p), y: Math.max(0, box.y - p), width: box.width + 2 * p, height: box.height + 2 * p } });
    console.log('saved ' + name);
  }

  try {
    // A small grid: the analog clock and Ambience side by side, the focus on neither.
    const pair = [
      { widget: 'wotd', x: 0, y: 0, w: 3, h: 2 },
      { widget: 'today', x: 3, y: 0, w: 3, h: 2 },
      { widget: 'ambience', x: 6, y: 0, w: 3, h: 2 }
    ];
    for (const theme of ['day', 'night']) {
      let page = await open({ layout: pair, theme: theme });
      await crop(page, '.cell[data-widget="today"]', 'clock-' + theme + '-' + TAG + '.png');
      await crop(page, '.cell[data-widget="ambience"]', 'ambience-' + theme + '-' + TAG + '.png');
      await page.context().close();
      page = await open({ layout: pair, theme: theme, lang: 'es', grow: true });
      await crop(page, '.cell[data-widget="ambience"]', 'ambience-' + theme + '-es-' + TAG + '.png');
      // The panel's light rows use the same dots.
      await page.keyboard.press('ArrowRight'); await sleep(100);
      await page.keyboard.press('ArrowRight'); await sleep(100);
      await page.keyboard.press('Enter');
      await until(() => page.evaluate(() => window.HUB_TEST.open() === 'ambience' && !window.HUB_TEST.busy()), 5000, 'no panel');
      await sleep(800);
      await page.screenshot({ path: path.join(OUT, 'ambience-panel-' + theme + '-es-' + TAG + '.png') });
      console.log('saved ambience-panel-' + theme + '-es-' + TAG + '.png');
      await page.context().close();
    }

    // The Hub architecture layout: one widget, the whole screen.
    let page = await open({ layout: [{ widget: 'architecture', x: 0, y: 0, w: 12, h: 6 }], theme: 'day' });
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, 'arch-solo-' + TAG + '.png') });
    console.log('saved arch-solo-' + TAG + '.png');
    await page.context().close();
    // The tile beside others, where it is still a tile.
    page = await open({ layout: [{ widget: 'architecture', x: 0, y: 0, w: 6, h: 3 }, { widget: 'today', x: 6, y: 0, w: 3, h: 2 }], theme: 'day' });
    await crop(page, '.cell[data-widget="architecture"]', 'arch-tile-' + TAG + '.png');
    await page.context().close();
  } finally {
    await browser.close();
    try { server.close(); } catch (e) { /* ignore */ }
    try { await mock.close(); } catch (e) { /* ignore */ }
    preview.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
