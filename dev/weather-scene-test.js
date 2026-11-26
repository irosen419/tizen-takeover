/*
 * The living Weather picture, end to end: node dev/weather-scene-test.js
 *
 * Runs the real hub in headless Chromium at 1920x1080 against the preview
 * (dev/preview.js, without live updates). The forecast is the sample one; the
 * page's ?wxscene=KIND[-LEVEL][-night|-day|-dawn|-dusk][-wind] makes it say
 * clear, partly, cloudy, fog, drizzle, rain, snow or storm. Checks:
 *   - every kind, day and night, draws one picture on the tile with a few
 *     layers, no console errors;
 *   - the picture never moves the text (same boxes with the picture off);
 *   - only transform and opacity are animated, and ES5 only;
 *   - the panel gets its own picture, the tile's pauses meanwhile, it goes
 *     when the panel closes, and another widget's panel never has one;
 *   - moving by default; still on ?weatherscene=calm, when the hub is on plain
 *     fades, when the TV measures too few frames a second, and from a result
 *     saved earlier; off on ?weatherscene=off; the About panel says which;
 *   - Spanish (longer words, accents) fits on the tile and the panel.
 *
 * WEATHER_TEST_SHOTS=<folder> also saves screenshots of every kind (tile,
 * panel, full screen, English and Spanish) and numbered frames for clips.
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

const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host')];
const SHOTS = process.env.WEATHER_TEST_SHOTS || '';
const ZONE = 'America/Chicago';
const KINDS = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain-3', 'snow-2', 'storm'];
const REPO = path.join(__dirname, '..');

let PAGE;
let preview = null;
let browser = null;
const openContexts = new Set();
const results = [];

/* ---------- small helpers ---------- */

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

// The words the Weather widget prints, in Spanish a quarter longer (and with
// accents). Applied as the widget sets its text, so its own fitting sees them.
const SPANISH = {
  'Thunderstorm': 'Tormenta eléctrica', 'Thunderstorm with hail': 'Tormenta eléctrica con granizo',
  'Heavy rain': 'Lluvia muy intensa', 'Heavy snow': 'Nevada muy intensa', 'Snow': 'Nieve', 'Drizzle': 'Llovizna',
  'Light rain': 'Lluvia ligera', 'Partly cloudy': 'Parcialmente nublado', 'Cloudy': 'Nublado', 'Fog': 'Niebla',
  'Sunny': 'Soleado', 'Clear': 'Despejado', 'Mostly sunny': 'Mayormente soleado', 'Mostly clear': 'Mayormente despejado',
  'Wind': 'Viento', 'Rain today': 'Lluvia hoy', 'Sunrise': 'Amanecer', 'Sunset': 'Atardecer',
  'Update now': 'Actualizar ahora', 'Wrong city?': '¿Ciudad equivocada?', 'Full screen': 'Pantalla completa',
  'Day': 'Día', 'Week': 'Semana', 'Today': 'Hoy', 'Now': 'Ahora', 'Sample': 'Muestra'
};

function spanishInit(dict) {
  const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: true,
    get: d.get,
    set(v) {
      if (typeof v === 'string') {
        if (dict[v]) v = dict[v];
        else if (/^Feels like /.test(v)) v = v.replace('Feels like', 'Sensación térmica');
      }
      d.set.call(this, v);
    }
  });
}

// opts: { scene, query, spanish, storage, slow (frames at 10 a second), motion }
async function openHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: ZONE });
  context.errors = [];
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (BLOCKED_HOSTS.indexOf(host) >= 0) return route.abort();
    return route.continue();
  });
  if (opts.spanish) await context.addInitScript(spanishInit, SPANISH);
  if (opts.slow) {
    await context.addInitScript(() => {
      window.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(performance.now()); }, 110); };
    });
  }
  if (opts.layout) {
    await context.addInitScript((layout) => {
      try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('homeHub.layout', layout); } } catch (e) { /* ignore */ }
    }, JSON.stringify(opts.layout));
  }
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    if (/net::ERR_FAILED|Failed to load resource/.test(m.text())) return;
    context.errors.push(m.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  let url = PAGE + '/?motion=' + (opts.motion || 'push') + '&live=off';
  if (opts.scene) url += '&wxscene=' + opts.scene;
  if (opts.query) url += '&' + opts.query;
  await page.goto(url);
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="weather"] .wx-tile'));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  if (opts.storage) {
    await page.evaluate((items) => { for (const k in items) localStorage.setItem(k, items[k]); }, opts.storage);
    await page.reload();
    await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="weather"] .wx-tile'));
  }
  return page;
}

function noErrors(page) {
  const errors = page.context().errors;
  assert(!errors.length, 'console errors: ' + errors.join(' | '));
}

const openWeather = (page) => page.evaluate(() => window.HUB_TEST.openPanel('weather'));
// What the About panel's Weather picture row says ('' when it has no row: the
// picture is moving), and the full status the widget would give.
const aboutRow = (page) => page.evaluate(() => {
  window.HUB_TEST.about.open();
  const row = window.HUB_TEST.about.rows().filter((r) => r.label === 'Weather picture')[0];
  window.HUB_TEST.about.close();
  return row ? row.value : '';
});
const fullStatus = (page) => page.evaluate(() => {
  const w = window.HUB_WIDGETS.filter((x) => x.id === 'weather')[0];
  return w.sceneStatus(true);
});

// What is moving in the picture: a count of running animations and of those
// that animate anything other than transform and opacity.
const animationFacts = (page) => page.evaluate(() => {
  const scene = document.querySelector('.cell[data-widget="weather"] .wx-scene');
  if (!scene) return null;
  const all = scene.querySelectorAll('*');
  let running = 0;
  for (let i = 0; i < all.length; i++) {
    const n = getComputedStyle(all[i]).animationName;
    if (n && n !== 'none') running++;
  }
  return { layers: all.length, running: running, cls: scene.className };
});

/* ---------- checks ---------- */

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(true);
    console.log('ok    ' + name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    results.push(false);
    console.log('FAIL  ' + name + ': ' + (e && e.message));
  }
  for (const c of Array.from(openContexts)) {
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

async function checkEveryKind() {
  for (const kind of KINDS) {
    for (const when of ['day', 'night']) {
      const page = await openHub({ scene: kind + '-' + when, query: 'weatherscene=full' });
      const f = await animationFacts(page);
      assert(f, kind + ' ' + when + ': no picture on the tile');
      assert(f.layers >= 2 && f.layers <= 24 && f.running <= 14, kind + ' ' + when + ': ' + f.layers + ' elements, ' + f.running + ' animated');
      assert(f.cls.indexOf('wx-sc-' + kind.split('-')[0]) !== -1, kind + ': class is ' + f.cls);
      assert(f.cls.indexOf(when === 'day' ? 'is-day' : 'is-night') !== -1, kind + ': ' + f.cls);
      const n = await page.evaluate(() => document.querySelectorAll('.wx-scene').length);
      assert(n === 1, kind + ': ' + n + ' pictures when only the tile shows');
      noErrors(page);
      await page.context().close();
    }
  }
}

async function checkTextStays() {
  const boxes = (page) => page.evaluate(() => {
    const out = {};
    // The place is the hub header's title since design pass 2 (.tile-title).
    ['.tile-title', '.wx-tile-temp', '.wx-tile-cond', '.wx-hl-val', '.wx-rain-val'].forEach((s) => {
      const e = document.querySelector('.cell[data-widget="weather"] ' + s);
      const r = e.getBoundingClientRect();
      out[s] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    });
    return JSON.stringify(out);
  });
  for (const kind of ['rain-3', 'storm', 'clear-night']) {
    const on = await openHub({ scene: kind });
    const a = await boxes(on);
    const off = await openHub({ scene: kind, query: 'weatherscene=off' });
    const b = await boxes(off);
    assert(a === b, kind + ': the text moved with the picture on: ' + a + ' vs ' + b);
  }
}

async function checkCleanCode() {
  const css = fs.readFileSync(path.join(REPO, 'app/widgets/weather.css'), 'utf8');
  const frames = css.match(/@(-webkit-)?keyframes [^{]+\{(?:[^{}]*\{[^}]*\})+\s*\}/g) || [];
  assert(frames.length >= 20, 'found only ' + frames.length + ' keyframes');
  frames.forEach((k) => {
    const body = k.slice(k.indexOf('{') + 1).replace(/\d+(\.\d+)?%(,\s*\d+(\.\d+)?%)*\s*\{/g, '{');
    const props = (body.match(/([a-z-]+)\s*:/g) || []).map((p) => p.replace(/[\s:]/g, ''));
    props.forEach((p) => assert(p === 'transform' || p === '-webkit-transform' || p === 'opacity', 'a keyframe animates ' + p + ': ' + k.slice(0, 40)));
  });
  let acorn = null;
  for (const p of ['acorn', '/opt/node-tools/node_modules/acorn']) {
    try { acorn = require(p); break; } catch (e) { /* next */ }
  }
  if (acorn) {
    ['app/widgets/weather.js', 'app/hub.js'].forEach((f) => acorn.parse(fs.readFileSync(path.join(REPO, f), 'utf8'), { ecmaVersion: 5 }));
  } else console.log('      (acorn not found: the ES5 check was skipped)');
}

async function checkPanel() {
  const page = await openHub({ scene: 'snow-2', query: 'weatherscene=full' });
  await page.evaluate(() => { document.querySelector('.cell[data-widget="weather"] .wx-scene').setAttribute('data-mine', '1'); });
  await openWeather(page);
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'weather'), 4000, 'the panel did not open');
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => ({
    panel: !!document.querySelector('.panel .wx-scene-panel'),
    tilePaused: /is-paused/.test(document.querySelector('.cell[data-widget="weather"] .wx-scene').className),
    count: document.querySelectorAll('.wx-scene').length,
    headOver: getComputedStyle(document.querySelector('.panel-head')).zIndex
  }));
  assert(state.panel && state.count === 2, 'the panel has no picture of its own: ' + JSON.stringify(state));
  assert(state.tilePaused, 'the tile picture keeps running under the panel');
  assert(state.headOver === '1', 'the panel head is not above the picture');
  // Full screen: the corners go square, the picture stays.
  await page.evaluate(() => window.HUB_TEST.mode());
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null), 4000, 'the panel did not close');
  const after = await page.evaluate(() => ({
    count: document.querySelectorAll('.wx-scene').length,
    mine: !!document.querySelector('.cell[data-widget="weather"] .wx-scene[data-mine]'),
    paused: /is-paused/.test(document.querySelector('.cell[data-widget="weather"] .wx-scene').className)
  }));
  assert(after.count === 1, 'the panel picture stayed after closing');
  assert(after.mine, 'the tile picture was rebuilt (its phase would restart)');
  assert(!after.paused, 'the tile picture stayed paused');
  // Another widget's panel never gets one.
  const other = await page.evaluate(() => window.HUB_TEST.openPanel('todo'));
  assert(other, 'the To-do panel did not open');
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => !document.querySelector('.panel .wx-scene')), 'the To-do panel has a weather picture');
  noErrors(page);
}

async function checkModes() {
  const moving = await openHub({ scene: 'rain-3' });
  const f = await animationFacts(moving);
  assert(f.running >= 4, 'moving: only ' + f.running + ' animations run');
  assert((await aboutRow(moving)) === '' && /^Moving/.test(await fullStatus(moving)), 'about: ' + (await aboutRow(moving)) + ' / ' + (await fullStatus(moving)));

  const calm = await openHub({ scene: 'rain-3', query: 'weatherscene=calm' });
  const c = await animationFacts(calm);
  assert(c.running === 0, 'calm: ' + c.running + ' animations still run');
  assert(/^Still, set to calm/.test(await aboutRow(calm)), 'about (calm): ' + (await aboutRow(calm)));

  const off = await openHub({ scene: 'rain-3', query: 'weatherscene=off' });
  assert(await animationFacts(off) === null, 'off: a picture is showing');
  assert(/^Off/.test(await aboutRow(off)), 'about (off): ' + (await aboutRow(off)));

  const saved = await openHub({ scene: 'rain-3' });
  const build = await saved.evaluate(() => window.HUB_BUILD);
  const fromSaved = await openHub({ scene: 'rain-3', storage: { 'homeHub.weather.scene': JSON.stringify({ build, calm: true, fps: 14, at: Date.now() }) } });
  assert((await animationFacts(fromSaved)).running === 0, 'a saved slow result did not stop the picture');
  assert(/this TV drew 14 frames a second/.test(await aboutRow(fromSaved)), 'about (saved): ' + (await aboutRow(fromSaved)));
  const old = await openHub({ scene: 'rain-3', storage: { 'homeHub.weather.scene': JSON.stringify({ build, calm: true, fps: 14, at: Date.now() - 7 * 3600000 }) } });
  assert((await animationFacts(old)).running >= 4, 'an old slow result still stops the picture');
}

async function checkFadeMode() {
  const page = await openHub({ scene: 'storm', motion: 'fade' });
  await until(() => page.evaluate(() => /Still, the hub is on plain fades/.test(
    (() => { window.HUB_TEST.about.open(); const r = window.HUB_TEST.about.rows().filter((x) => x.label === 'Weather picture')[0]; window.HUB_TEST.about.close(); return r ? r.value : ''; })())), 12000,
    'on plain fades the picture kept moving: ' + (await aboutRow(page)));
  assert((await animationFacts(page)).running === 0, 'animations still run on plain fades');
}

async function checkSlowTv() {
  const page = await openHub({ scene: 'rain-3', slow: true, motion: 'expand' });
  await until(async () => /^Still/.test((await aboutRow(page)) || ''), 20000, 'a TV drawing 9 frames a second still got the moving picture: ' + (await aboutRow(page)));
  assert((await animationFacts(page)).running === 0, 'animations run on a slow TV');
}

async function checkFastTv() {
  const page = await openHub({ scene: 'rain-3' });
  await until(async () => /^Moving, \d+ frames a second/.test(await fullStatus(page)), 12000, 'the speed was never measured: ' + (await fullStatus(page)));
  assert((await aboutRow(page)) === '', 'a moving picture has an About row: ' + (await aboutRow(page)));
  noErrors(page);
}

// Spanish: wider words, accents. Every text box of the tile and the panel must
// keep its text inside, the condition on one word line or wrapped by words.
async function checkSpanish() {
  for (const scene of ['storm', 'rain-3', 'snow-3', 'clear-dusk']) {
    const page = await openHub({ scene, spanish: true, query: 'weatherscene=full' });
    const tile = await page.evaluate(() => {
      const t = document.querySelector('.cell[data-widget="weather"] .wx-tile');
      const bad = [];
      t.querySelectorAll('*').forEach((e) => {
        if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible' && e.className.indexOf('wx-label') === -1) bad.push(e.className);
      });
      const r = t.getBoundingClientRect();
      const out = [];
      t.querySelectorAll('.wx-tile-temp,.wx-tile-cond,.wx-hl-val,.wx-rain-val').forEach((e) => {
        const b = e.getBoundingClientRect();
        if (b.right > r.right + 1 || b.bottom > r.bottom + 1) out.push(e.className);
      });
      return { bad, out, cond: t.querySelector('.wx-tile-cond').textContent };
    });
    assert(!tile.bad.length && !tile.out.length, scene + ' tile (Spanish): ' + JSON.stringify(tile));
    await openWeather(page);
    await until(() => page.evaluate(() => window.HUB_TEST.open() === 'weather'), 4000, 'the panel did not open');
    await page.waitForTimeout(500);
    const panel = await page.evaluate(() => {
      const cond = document.querySelector('.wx-now-cond');
      const body = document.querySelector('.panel-body');
      const b = body.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(cond).lineHeight) / parseFloat(getComputedStyle(cond).fontSize);
      cond.style.wordWrap = 'normal';
      const wordFits = cond.scrollWidth <= cond.clientWidth + 1;
      cond.style.wordWrap = '';
      let out = 0;
      document.querySelectorAll('.wx-panel *').forEach((e) => {
        if (!e.children.length && e.textContent.trim()) {
          const r = e.getBoundingClientRect();
          if (!r.width) return;
          if (r.right > b.right + 1 || r.left < b.left - 1) out++;
        }
      });
      return { text: cond.textContent, wordFits, lh, out };
    });
    assert(panel.wordFits, scene + ' panel (Spanish): "' + panel.text + '" has a word wider than its room');
    assert(panel.lh >= 1.25, scene + ': line height ' + panel.lh + ' clips accents');
    assert(panel.out === 0, scene + ' panel (Spanish): ' + panel.out + ' texts past the panel');
    noErrors(page);
  }
}

// Screenshots and frames, when asked.
async function shots() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const layout = [
    { widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
    { widget: 'todo', x: 0, y: 2, w: 3, h: 4 }, { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 }
  ];
  const sizes = [[12, 1, 'strip'], [3, 1, '3x1'], [2, 2, '2x2'], [3, 4, '3x4']];
  for (const sc of ['clear-day', 'clear-night', 'clear-dusk', 'partly-day', 'cloudy', 'fog', 'drizzle', 'rain-1', 'rain-3-wind', 'snow-1', 'snow-3', 'storm']) {
    for (const es of [false, true]) {
      const page = await openHub({ scene: sc, spanish: es, layout });
      await page.waitForTimeout(900);
      const cell = page.locator('.cell[data-widget="weather"]');
      await cell.screenshot({ path: path.join(SHOTS, sc + '-tile' + (es ? '-es' : '') + '.png') });
      await openWeather(page);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(SHOTS, sc + '-panel' + (es ? '-es' : '') + '.png') });
      await page.evaluate(() => { const b = document.querySelector('.panel-btn'); if (b) b.click(); });
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(SHOTS, sc + '-full' + (es ? '-es' : '') + '.png') });
      await page.context().close();
    }
  }
  for (const [w, h, name] of sizes) {
    const page = await openHub({ scene: 'storm', spanish: true, layout: [{ widget: 'weather', x: 0, y: 0, w, h }] });
    await page.waitForTimeout(700);
    await page.locator('.cell[data-widget="weather"]').screenshot({ path: path.join(SHOTS, 'size-' + name + '-storm-es.png') });
    await page.context().close();
  }
}

async function main() {
  const port = await spare();
  PAGE = 'http://127.0.0.1:' + port;
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(port), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await waitForPort(port);
  browser = await chromium.launch();

  await check('1. Every kind, day and night: one picture on the tile, a few layers, no errors', checkEveryKind);
  await check('2. The picture never moves the text', checkTextStays);
  await check('3. Only transform and opacity animate; the code is ES5', checkCleanCode);
  await check('4. The panel has its own picture, the tile\'s pauses and returns, no leaks', checkPanel);
  await check('5. Moving, still (setting, saved result), off; the About panel says which', checkModes);
  await check('6. On plain fades the picture stands still', checkFadeMode);
  await check('7. A TV drawing too few frames a second gets the still picture', checkSlowTv);
  await check('8. A fast page measures its speed and keeps moving', checkFastTv);
  await check('9. Spanish words and accents fit on the tile and the panel', checkSpanish);
  if (SHOTS) await check('10. Screenshots', shots);
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
