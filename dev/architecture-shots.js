/*
 * Screenshots of the Architecture widget on the TV: node dev/architecture-shots.js <folder>
 *
 * The real hub in headless Chromium at 1920x1080, deviceScaleFactor 1, on the
 * preview (dev/preview.js, no live updates), driven with the remote's keys.
 *
 *   01-home-tiles.png          the tile as a strip (6x1), standard (3x2) and tall (3x4) beside others
 *   02-big-picture.png         full screen, Cloud focused
 *   03-big-picture-flows.png   the Data flows chip focused
 *   04-group-cloud.png         the Cloud group
 *   05-group-pi.png            The Raspberry Pi (16 parts), a card in the second row focused
 *   06-group-deeper.png        one level deeper (the R2 pictures bucket's parts or the GitHub repo's)
 *   07-drawer.png              the detail drawer over the dimmed diagram
 *   08-drawer-talks-to.png     the drawer scrolled to its "Talks to" links
 *   09-flows-list.png          the data flow list
 *   10-flow-step.png           a flow, stepped to its third step
 *   es-*.png                   the Big picture, the Pi, a drawer and a flow with every text 25% longer (accents added)
 *
 * Needs Playwright and port 8095 free.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const OUT = process.argv[2];
if (!OUT) { console.log('usage: node dev/architecture-shots.js <folder>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spare = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// Every text grows by a quarter, with accents (runs before the data file sets HUB_ARCH).
function longer() {
  let real;
  const grow = (t) => {
    if (typeof t !== 'string' || t.length < 4) return t;
    const words = t.split(' ');
    const per = Math.max(1, Math.ceil(Math.ceil(t.length * 0.25) / words.length));
    return words.map((w) => (w.length > 2 ? w + 'áéíñóú'.slice(0, per) : w)).join(' ');
  };
  const walk = (n) => {
    ['title', 'summary', 'label', 'say'].forEach((k) => { if (n[k]) n[k] = grow(n[k]); });
    ['details', 'notes'].forEach((k) => { if (n[k]) n[k] = n[k].map(grow); });
    (n.talksTo || []).forEach((t) => { if (t.label) t.label = grow(t.label); });
    (n.children || []).forEach(walk);
  };
  Object.defineProperty(window, 'HUB_ARCH', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v;
      try {
        v.tree.forEach(walk);
        (v.flows || []).forEach((f) => { f.title = grow(f.title); f.summary = grow(f.summary); f.steps.forEach((s) => { s.say = grow(s.say); }); });
        v.overview.boxes.forEach((b) => { b.title = grow(b.title); b.lines = b.lines.map(grow); });
        v.overview.edges.forEach((e) => { if (e.label) e.label = grow(e.label); });
      } catch (e) { /* plain text then */ }
    }
  });
}

async function main() {
  const port = await spare();
  const base = 'http://127.0.0.1:' + port;
  const preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(port), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise((r) => http.get(base + '/', (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
      if (ok) break;
      await sleep(100);
    }
    const open = async (layout, grow) => {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      await context.route('**/*', (route) => (BLOCKED_HOSTS.indexOf(new URL(route.request().url()).hostname) >= 0 ? route.abort() : route.continue()));
      await context.addInitScript((items) => {
        try { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.clear(); for (const k in items) localStorage.setItem(k, items[k]); } } catch (e) { /* ignore */ }
      }, { 'homeHub.lang': 'en', 'homeHub.layout': JSON.stringify(layout) });
      if (grow) await context.addInitScript(longer);
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('page error: ' + e.message));
      await page.goto(base + '/?motion=fade&live=off&clay=off');
      await page.waitForFunction(() => window.HUB_TEST && window.HUB_ARCHITECTURE && document.querySelector('#grid .tile-body *'));
      await sleep(400);
      return page;
    };
    const shot = async (page, name) => { await sleep(350); await page.screenshot({ path: path.join(OUT, name) }); console.log('saved ' + name); };
    const press = async (page, k, n) => { for (let i = 0; i < (n || 1); i++) { await page.keyboard.press(k); await sleep(60); } };
    const fullScreen = async (page) => {
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.HUB_TEST.open() === 'architecture' && !!document.querySelector('#panel .ar-box'));
      await sleep(300);
    };
    const full = [{ widget: 'architecture', x: 0, y: 0, w: 12, h: 6 }];

    // The tile among others.
    let page = await open([
      { widget: 'today', x: 0, y: 0, w: 3, h: 1 },
      { widget: 'architecture', x: 3, y: 0, w: 6, h: 1 },
      { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
      { widget: 'architecture', x: 0, y: 1, w: 3, h: 2 },
      { widget: 'architecture', x: 3, y: 1, w: 3, h: 4 },
      { widget: 'entertainment', x: 6, y: 2, w: 6, h: 2 },
      { widget: 'wotd', x: 0, y: 3, w: 3, h: 2 }
    ]);
    await shot(page, '01-home-tiles.png');
    await page.context().close();

    // Full screen, in English then with +25% text.
    for (const grow of [false, true]) {
      const pre = grow ? 'es-' : '';
      page = await open(full, grow);
      await fullScreen(page);
      await shot(page, pre + '02-big-picture.png');
      if (!grow) {
        await press(page, 'ArrowDown', 3);
        await shot(page, '03-big-picture-flows.png');
        await press(page, 'ArrowUp', 3);
      }
      await press(page, 'Enter');
      await shot(page, pre + '04-group-cloud.png');
      await press(page, 'Escape');
      await press(page, 'ArrowDown');
      await press(page, 'Enter');                                // The Raspberry Pi
      await press(page, 'ArrowDown', 1);
      await press(page, 'ArrowRight', 1);
      await shot(page, pre + '05-group-pi.png');
      // A part with parts, one level deeper.
      const deep = await page.evaluate(() => { const c = [].filter.call(document.querySelectorAll('#panel .ar-card'), (x) => x.querySelector('.ar-more'))[0]; return c ? c.getAttribute('data-id') : null; });
      if (deep) {
        for (let i = 0; i < 12 && await page.evaluate(() => document.querySelector('#panel .f.is-focused').getAttribute('data-key')) !== 'g:' + deep; i++) await press(page, ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'][i % 4]);
        await press(page, 'Enter');
        if (!grow) await shot(page, '06-group-deeper.png');
        await press(page, 'Escape');
      }
      // The drawer of a leaf with links, then scrolled to its Talks to.
      const talker = await page.evaluate(() => {
        const by = {}, par = {};
        (function walk(n, p) { by[n.id] = n; par[n.id] = p; (n.children || []).forEach((c) => walk(c, n.id)); })({ id: null, children: window.HUB_ARCH.tree }, null);
        const ids = Object.keys(by);
        let best = null, score = 0;
        ids.forEach((id) => { const n = by[id]; if (!par[id] || (n.children || []).length) return; const s = (n.talksTo || []).length * 3 + (n.details || []).length + (n.files || []).length; if (s > score && (n.talksTo || []).length >= 2) { score = s; best = id; } });
        return best;
      });
      await page.evaluate((id) => window.HUB_ARCHITECTURE.goto(id, true), talker);
      await shot(page, pre + '07-drawer.png');
      if (!grow) {
        await press(page, 'ArrowDown', 30);
        await shot(page, '08-drawer-talks-to.png');
      }
      await page.evaluate(() => window.HUB_ARCHITECTURE.flow('flow.tv-live-todo', 2));
      await shot(page, pre + '10-flow-step.png');
      await press(page, 'Escape');
      if (!grow) await shot(page, '09-flows-list.png');
      await page.context().close();
    }
  } finally {
    await browser.close();
    preview.kill();
  }
}
main().catch((e) => { console.log(e); process.exit(1); });
