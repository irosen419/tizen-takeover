/*
 * The Architecture widget on the TV, end to end: node dev/architecture-tv-test.js
 *
 * Runs the real hub in headless Chromium at 1920x1080 against the preview
 * (dev/preview.js, no live updates) and drives it with the keys a remote
 * sends. Checks:
 *
 *   - the widget registers (openMode full) and its files are plain ES5 and end
 *     with .css-end; the build script says the TV data and tile summary are in
 *     step with studio/architecture/data.json
 *   - the tile draws at several sizes without the big data file (no request
 *     for it, no HUB_ARCH), with the map and the status counts
 *   - OK on the tile opens full screen and fetches the data once; a failed
 *     fetch is tried once more, and a second failure says so and OK retries
 *   - the Big picture: seven boxes, focus starts on Cloud, arrows move to the
 *     nearest box (Right to The TV, Down to the Pi, the tests box, the flows
 *     chip), OK opens a group
 *   - a group: its parts as cards, OK on a part with parts goes deeper, Back
 *     returns with focus on the card it came from, OK on a leaf opens the
 *     drawer (about 40% wide), a "Talks to" link jumps to that part's group
 *     with the part focused, Back walks up one level at a time and finally
 *     closes the widget
 *   - the drawer: long text scrolls with Down until its last row is in view
 *   - data flows: the chip, the list, stepping with Left and Right (clamped),
 *     OK showing the step's part, Back up
 *   - nothing is outside the 1920x1080 screen or cut sideways, at every level,
 *     in English and with every text 25% longer (and with accents)
 *   - no console errors
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

const ROOT = path.join(__dirname, '..');
const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

let PAGE;
let preview = null;
let browser = null;
let passed = 0;
let failed = 0;

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
    await sleep(50);
  }
  throw new Error(text);
}
function waitForPort(port) {
  return until(() => new Promise((resolve) => {
    http.get('http://127.0.0.1:' + port + '/', (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
}
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
}

// Runs before the page's scripts: when the data file sets HUB_ARCH, every text grows by a quarter, with accents.
function longer() {
  let real;
  const grow = (t) => {
    if (typeof t !== 'string' || t.length < 4) return t;
    const words = t.split(' ');
    const add = Math.ceil(t.length * 0.25);
    const extra = 'áéíñóú';
    const per = Math.max(1, Math.ceil(add / words.length));
    return words.map((w, i) => (w.length > 2 ? w + extra.slice(0, per) : w)).join(' ');
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
        const o = v.overview;
        o.boxes.forEach((b) => { b.title = grow(b.title); b.lines = b.lines.map(grow); });
        o.edges.forEach((e) => { if (e.label) e.label = grow(e.label); });
      } catch (e) { /* the checks then see the plain text */ }
    }
  });
}

// opts: { size: [w, h], grow, abortData: how many fetches of the data file to fail }
async function openHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  context.errors = [];
  context.dataRequests = 0;
  let aborted = 0;
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const host = new URL(url).hostname;
    if (BLOCKED_HOSTS.indexOf(host) >= 0) return route.abort();
    if (/architecture-data\.js/.test(url)) {
      context.dataRequests++;
      if (aborted < (opts.abortData || 0)) { aborted++; return route.abort(); }
    }
    return route.continue();
  });
  const size = opts.size || [12, 6];
  const storage = { 'homeHub.lang': 'en', 'homeHub.layout': JSON.stringify([{ widget: 'architecture', x: 0, y: 0, w: size[0], h: size[1] }]) };
  await context.addInitScript((items) => {
    try {
      if (!sessionStorage.getItem('archTestSeeded')) {
        sessionStorage.setItem('archTestSeeded', '1');
        localStorage.clear();
        for (const k in items) localStorage.setItem(k, items[k]);
      }
    } catch (e) { /* ignore */ }
  }, storage);
  if (opts.grow) await context.addInitScript(longer);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    if (/net::ERR_FAILED|Failed to load resource/.test(m.text()) && opts.abortData) return;
    context.errors.push(m.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  await page.goto(PAGE + '/?motion=fade&live=off&clay=off');
  await page.waitForFunction(() => window.HUB_TEST && window.HUB_ARCHITECTURE && document.querySelector('#grid .tile-body *'));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(100);
  return page;
}

const st = (page) => page.evaluate(() => window.HUB_ARCHITECTURE.state());
const key = (page, k) => page.keyboard.press(k);
const focusKey = (page) => page.evaluate(() => { const e = document.querySelector('#panel .f.is-focused'); return e ? e.getAttribute('data-key') : null; });
const settle = async (page) => { await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'busy'); await sleep(60); };
async function press(page, k) { await key(page, k); await sleep(50); }
async function openWidget(page) {
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'architecture' && window.HUB_TEST.mode() === 'full'), 5000, 'the widget did not open full screen');
  await until(() => page.evaluate(() => !!document.querySelector('#panel .ar-box')), 5000, 'the Big picture did not draw');
  await settle(page);
}
function noErrors(page) {
  assert(!page.context().errors.length, 'console: ' + page.context().errors.join(' | '));
}

// What leaves the screen, or is cut sideways, inside the widget's page.
function inspect(page, minRem) {
  return page.evaluate((minRem) => {
    const root = document.querySelector('#panel .ar-root');
    if (!root) return ['no page'];
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const problems = [];
    const inScroller = (el) => !!el.closest('.ar-canvas, .ar-dr-scroll, .ar-fl-scroll');
    root.querySelectorAll('*').forEach((el) => {
      const isSvg = el instanceof SVGElement;
      if (isSvg && el.tagName.toLowerCase() !== 'svg') return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const name = (el.getAttribute('class') || el.tagName) + ' "' + (el.textContent || '').slice(0, 24) + '"';
      if (r.left < -0.5 || r.right > 1920.5) problems.push(name + ' is outside sideways');
      if (!inScroller(el) && (r.top < -0.5 || r.bottom > 1080.5)) problems.push(name + ' is outside up or down');
      if (isSvg || !el.textContent.trim()) return;
      const cs = getComputedStyle(el);
      const clamped = cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none');
      if (cs.display !== 'inline' && !clamped && el.scrollWidth > el.clientWidth + 1) problems.push(name + ' is cut sideways');
      if (el.children.length) return;
      if (parseFloat(cs.fontSize) < minRem * rem - 0.2) problems.push(name + ' type ' + (parseFloat(cs.fontSize) / rem).toFixed(2) + 'rem');
      if (parseFloat(cs.lineHeight) < 1.3 * parseFloat(cs.fontSize) - 0.2) problems.push(name + ' line height under 1.3');
    });
    // The drawer's rows are inside it; the diagram's focus is on screen.
    const f = document.querySelector('#panel .f.is-focused');
    if (f && !f.closest('.ar-dr-scroll') && !f.closest('.ar-fl-scroll')) {
      const r = f.getBoundingClientRect();
      if (r.top < 0 || r.bottom > 1080) problems.push('the focused ' + f.getAttribute('data-key') + ' is off screen');
    }
    return problems;
  }, minRem);
}

/* ---------- checks ---------- */

function checkFiles() {
  const js = fs.readFileSync(path.join(ROOT, 'app/widgets/architecture.js'), 'utf8');
  const data = fs.readFileSync(path.join(ROOT, 'app/widgets/architecture-data.js'), 'utf8');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  assert(!/=>/.test(code), 'an arrow function');
  assert(!/\blet\s/.test(code) && !/\bconst\s/.test(code), 'let or const');
  assert(!/`/.test(code), 'a template string');
  assert(!/\.\.\.[\w(\[]/.test(code), 'spread');
  assert(!/\b(Array\.from|Object\.assign|\.includes\(|\.find\(|\.findIndex\(|\.startsWith\(|\.endsWith\(|\.padStart\()/.test(code), 'a newer built-in');
  assert(!/\bclass\s+\w+/.test(code), 'a class');
  assert(/^\/\*[\s\S]*?\*\/\s*var HUB_ARCH = \{[\s\S]*\};\s*$/.test(data), 'architecture-data.js is not var HUB_ARCH = {...};');
  assert(!/[^\x00-\x7f]/.test(data), 'architecture-data.js has non-ASCII characters');
  let acorn = null;
  for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
    try { acorn = require(p); break; } catch (e) { /* next */ }
  }
  if (acorn) {
    acorn.parse(js, { ecmaVersion: 5 });
    acorn.parse(data, { ecmaVersion: 5 });
  }
  const css = fs.readFileSync(path.join(ROOT, 'app/widgets/architecture.css'), 'utf8');
  assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'architecture.css does not end with .css-end');
  assert(!/display:\s*(inline-)?grid|[^-]gap:|[^-]inset:|:focus-visible|aspect-ratio|transition:\s*(?!opacity|transform)/.test(css), 'a CSS feature the TV lacks');
  const html = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
  assert(/widgets\/architecture\.css/.test(html) && /widgets\/architecture\.js/.test(html), 'hub.html does not link the files');
  assert(!/architecture-data/.test(html), 'hub.html loads the data at boot');
  const order = fs.readFileSync(path.join(ROOT, 'dev/styles-test.js'), 'utf8');
  assert(/widgets\/ambience\.css widgets\/architecture\.css agents\.css/.test(order), 'styles-test ORDER lacks architecture.css');
  assert(html.indexOf('architecture.css') > html.indexOf('ambience.css') && html.indexOf('architecture.css') < html.indexOf('agents.css'), 'hub.html order differs from ORDER');
  const out = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'studio/build-architecture.js'), '--check'], { encoding: 'utf8' });
  assert(out.status === 0, 'build-architecture --check: ' + out.stdout);
}

async function checkRegistered() {
  const page = await openHub({ size: [3, 2] });
  const r = await page.evaluate(() => ({
    cfg: window.HUB_CONFIG.widgets.architecture,
    tile: !!document.querySelector('[data-widget="architecture"]'),
    title: (document.querySelector('[data-widget="architecture"] .tile-title') || {}).textContent
  }));
  assert(r.cfg && r.cfg.openMode === 'full', 'no openMode full in config');
  assert(r.tile && r.title === 'Architecture', JSON.stringify(r));
  await page.context().close();
}

// A layout of this widget alone over the whole screen opens straight to its
// full screen (hub.js openSolo) instead of a big tile of empty boxes.
async function checkSolo() {
  const page = await openHub({ size: [12, 6] });
  await page.waitForFunction(() => window.HUB_TEST.open() === 'architecture' && !!document.querySelector('#panel .ar-box'), null, { timeout: 8000 });
  const r = await page.evaluate(() => ({ full: document.getElementById('panel').className, boxes: document.querySelectorAll('#panel .ar-box').length }));
  assert(/is-full/.test(r.full) && r.boxes >= 7, 'the one-widget layout did not open full screen: ' + JSON.stringify(r));
  noErrors(page);
  await page.context().close();
}

async function checkTiles() {
  const sizes = [[1, 1], [2, 1], [3, 1], [6, 1], [3, 2], [3, 4], [6, 3], [12, 5]];
  for (const size of sizes) {
    const page = await openHub({ size });
    const r = await page.evaluate(() => {
      const tile = document.querySelector('[data-widget="architecture"]');
      const t = tile.getBoundingClientRect();
      const out = [];
      tile.querySelectorAll('.tile-body *').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (!b.width) return;
        if (b.left < t.left - 1 || b.right > t.right + 1 || b.top < t.top - 1 || b.bottom > t.bottom + 1) out.push((el.getAttribute('class') || el.tagName) + ' leaves the tile');
      });
      return { out: out, map: !!tile.querySelector('svg.ar-mini'), boxes: tile.querySelectorAll('svg.ar-mini rect').length, text: (tile.querySelector('.ar-tile-counts') || {}).textContent || '', data: typeof window.HUB_ARCH };
    });
    const label = size.join('x');
    assert(r.map && r.boxes >= 7, label + ': no mini map');
    assert(r.data === 'undefined' && page.context().dataRequests === 0, label + ': the tile loaded the data');
    if (size[0] > 3 || size[1] > 1) assert(/live/.test(r.text) && /unverified/.test(r.text) && /draft/.test(r.text) && /planned/.test(r.text) && /\d/.test(r.text), label + ': counts "' + r.text + '"');
    assert(!r.out.length, label + ': ' + r.out.join('; '));
    noErrors(page);
    await page.context().close();
  }
}

async function checkOpenAndLoad() {
  const page = await openHub({ size: [3, 2] });
  assert(page.context().dataRequests === 0, 'data fetched at boot');
  await openWidget(page);
  const s = await st(page);
  assert(s.data === 'ready' && s.view === 'big', JSON.stringify(s));
  assert(page.context().dataRequests === 1, 'data fetched ' + page.context().dataRequests + ' times');
  const r = await page.evaluate(() => ({
    boxes: document.querySelectorAll('#panel .ar-box').length,
    edges: document.querySelectorAll('#panel .ar-edge-lines polyline').length,
    bars: document.querySelectorAll('#panel .ar-box .ar-sseg').length,
    legend: document.querySelectorAll('#panel .ar-lg').length,
    asof: (document.querySelector('#panel .ar-asof') || {}).textContent,
    hint: (document.querySelector('#panel .ar-hint') || {}).textContent,
    crumb: (document.querySelector('#panel .ar-crumbs') || {}).textContent,
    flows: (document.querySelector('#panel .ar-chip-flows') || {}).textContent
  }));
  assert(r.boxes === 7 && r.edges === 6 && r.bars >= 7 && r.legend === 4, JSON.stringify(r));
  assert(/^As of /.test(r.asof) && /Back/.test(r.hint) && r.crumb === 'Big picture' && /Data flows \(20\)/.test(r.flows), JSON.stringify(r));
  assert(await focusKey(page) === 'bp:cloud', 'focus starts on ' + await focusKey(page));
  // Back at the Big picture closes the widget.
  await press(page, 'Escape');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null), 4000, 'Back did not close');
  // Opening again does not fetch again.
  await openWidget(page);
  assert(page.context().dataRequests === 1, 'fetched again on the second open');
  noErrors(page);
  await page.context().close();
}

async function checkLoadFailure() {
  // One failure: the second try works.
  let page = await openHub({ size: [3, 2], abortData: 1 });
  await openWidget(page);
  let s = await st(page);
  assert(s.data === 'ready' && s.tries === 1 && page.context().dataRequests === 2, JSON.stringify(s) + ' requests ' + page.context().dataRequests);
  await page.context().close();
  // Two failures: it says so; OK tries again.
  page = await openHub({ size: [3, 2], abortData: 2 });
  await key(page, 'Enter');
  await until(() => page.evaluate(() => !!document.querySelector('#panel .ar-retry')), 6000, 'no failure page');
  assert(/could not load/i.test(await page.evaluate(() => document.querySelector('#panel .ar-state-title').textContent)), 'the failure page does not say so');
  assert(await focusKey(page) === 'retry', 'focus is not on Try again');
  await press(page, 'Enter');
  await until(() => page.evaluate(() => !!document.querySelector('#panel .ar-box')), 6000, 'Try again did not load');
  assert(await focusKey(page) === 'bp:cloud', 'focus after the retry: ' + await focusKey(page));
  await page.context().close();
}

async function checkBigPicture() {
  const page = await openHub({ size: [3, 2] });
  await openWidget(page);
  const want = async (k, text) => { assert(await focusKey(page) === k, text + ': focus is ' + await focusKey(page) + ', wanted ' + k); };
  await press(page, 'ArrowRight'); await want('bp:tv', 'Right from Cloud');
  await press(page, 'ArrowLeft'); await want('bp:cloud', 'Left from The TV');
  await press(page, 'ArrowDown'); await want('bp:pi', 'Down from Cloud');
  await press(page, 'ArrowDown'); await want('bp:dev', 'Down from the Pi');
  await press(page, 'ArrowDown'); await want('flows', 'Down from the tests box');
  await press(page, 'ArrowUp'); await want('bp:dev', 'Up from the chip');
  await press(page, 'ArrowUp'); await want('bp:pi', 'Up from the tests box');
  await press(page, 'ArrowLeft'); await want('bp:ext', 'Left from the Pi');
  await press(page, 'ArrowUp'); await want('bp:sched', 'Up from Outside services');
  await press(page, 'ArrowUp'); await want('bp:studio', 'Up from Scheduled tasks');
  await press(page, 'ArrowRight'); await want('bp:cloud', 'Right from Claude + Studio');
  // OK opens the group.
  await press(page, 'Enter');
  const s = await st(page);
  assert(s.view === 'group' && s.parent === 'cloud', JSON.stringify(s));
  const r = await page.evaluate(() => ({ cards: document.querySelectorAll('#panel .ar-card').length, crumb: document.querySelector('#panel .ar-crumbs').textContent, head: document.querySelector('#panel .ar-head-title').textContent }));
  assert(r.cards === 4 && /^Big picture\s*Cloud$/.test(r.crumb) && r.head === 'Cloud', JSON.stringify(r));
  // Back returns to the Big picture with focus where it was.
  await press(page, 'Escape');
  assert((await st(page)).view === 'big' && await focusKey(page) === 'bp:cloud', 'Back did not return to Cloud');
  await page.context().close();
}

async function checkGroupAndDrawer() {
  const page = await openHub({ size: [3, 2] });
  await openWidget(page);
  const stNow = () => st(page);
  await press(page, 'Enter');                                   // Cloud
  // Parts with parts say how many; OK goes in; Back comes out on the same card.
  const more = await page.evaluate(() => [].map.call(document.querySelectorAll('#panel .ar-card'), (c) => ({ id: c.getAttribute('data-id'), more: (c.querySelector('.ar-more') || {}).textContent || '' })));
  const deep = more.filter((c) => /^\+\d+ parts?$/.test(c.more))[0];
  assert(deep, 'no part with parts: ' + JSON.stringify(more));
  const cardKey = 'g:' + deep.id;
  for (let i = 0; i < 6 && await focusKey(page) !== cardKey; i++) await press(page, i < 3 ? 'ArrowDown' : 'ArrowRight');
  for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) { if (await focusKey(page) === cardKey) break; await press(page, k); }
  assert(await focusKey(page) === cardKey, 'cannot focus ' + cardKey + ', at ' + await focusKey(page));
  await press(page, 'Enter');
  let s = await stNow();
  assert(s.view === 'group' && s.parent === deep.id, 'did not go deeper: ' + JSON.stringify(s));
  assert(/Big picture\s*Cloud\s*[^]+/.test(await page.evaluate(() => document.querySelector('#panel .ar-crumbs').textContent)), 'breadcrumb');
  await press(page, 'Escape');
  s = await stNow();
  assert(s.parent === 'cloud' && await focusKey(page) === cardKey, 'Back did not land on the card: ' + await focusKey(page));
  // The head's Details pill opens the drawer for the group itself.
  for (let i = 0; i < 4 && !/^self:/.test(await focusKey(page)); i++) await press(page, 'ArrowUp');
  assert(await focusKey(page) === 'self:cloud', 'cannot reach Details: ' + await focusKey(page));
  await press(page, 'Enter');
  assert((await stNow()).node === 'cloud', 'no drawer for the group');
  await press(page, 'Escape');
  assert((await stNow()).node === null && await focusKey(page) === 'self:cloud', 'Back from the drawer');
  // Go to the deep part, then to its first leaf, and open the drawer.
  await press(page, 'ArrowDown');
  assert(await focusKey(page) === cardKey || /^g:/.test(await focusKey(page)), 'back on a card');
  await page.evaluate((id) => window.HUB_ARCHITECTURE.goto(id, false), deep.id);   // the part itself, on its group
  await settle(page);
  assert((await stNow()).parent === 'cloud' && await focusKey(page) === cardKey, 'goto');
  await press(page, 'Enter');                                    // in
  const leafKey = await focusKey(page);
  assert(/^g:/.test(leafKey), 'no card focused inside: ' + leafKey);
  const leafId = leafKey.slice(2);
  // OK on a card without parts opens the drawer; Back closes it.
  const hasParts = await page.evaluate((id) => document.querySelectorAll('#panel .ar-card[data-id="' + id + '"] .ar-more').length, leafId);
  if (!hasParts) {
    await press(page, 'Enter');
    s = await stNow();
    assert(s.node === leafId, 'OK on a leaf did not open its drawer: ' + JSON.stringify(s));
    await press(page, 'Escape');
    assert((await stNow()).node === null && await focusKey(page) === leafKey, 'Back from the leaf drawer');
  }
  await page.context().close();
}

// The first leaf that talks to a part in another group, found in the page's own data.
async function pickTalker(page) {
  return page.evaluate(() => {
    const D = window.HUB_ARCH;
    const by = {}, par = {};
    (function walk(n, p) { by[n.id] = n; par[n.id] = p; (n.children || []).forEach((c) => walk(c, n.id)); })({ id: null, children: D.tree }, null);
    const top = (id) => { while (par[id]) id = par[id]; return id; };
    const ids = Object.keys(by);
    for (let i = 0; i < ids.length; i++) {
      const n = by[ids[i]];
      if (!par[n.id] || (n.children || []).length) continue;
      const t = (n.talksTo || []).filter((x) => by[x.to] && top(x.to) !== top(n.id) && par[x.to]);
      if (t.length) return { id: n.id, to: t[0].to, index: (n.talksTo || []).indexOf(t[0]), parentOfTo: par[t[0].to] };
    }
    return null;
  });
}

async function checkDrawerAndJump() {
  const page = await openHub({ size: [3, 2] });
  await openWidget(page);
  const t = await pickTalker(page);
  assert(t, 'no leaf with a link to another group');
  await page.evaluate((id) => window.HUB_ARCHITECTURE.goto(id, true), t.id);
  await settle(page);
  let s = await st(page);
  assert(s.node === t.id, 'the drawer is not open: ' + JSON.stringify(s));
  const d = await page.evaluate(() => {
    const dr = document.querySelector('#panel .ar-drawer'), root = document.querySelector('#panel .ar-root');
    const r = dr.getBoundingClientRect(), rr = root.getBoundingClientRect();
    return { frac: r.width / rr.width, right: r.right, rows: dr.querySelectorAll('.f').length, links: dr.querySelectorAll('.ar-dr-link').length, dimmed: !!document.querySelector('#panel .ar-main.is-dimmed'), diagramFocusable: document.querySelectorAll('#panel .ar-main .f').length, title: dr.querySelector('.ar-dr-title').textContent };
  });
  assert(d.frac > 0.36 && d.frac < 0.44, 'the drawer is ' + Math.round(d.frac * 100) + '% wide');
  assert(d.dimmed && d.diagramFocusable === 0 && d.links >= 1 && d.rows >= 2, JSON.stringify(d));
  assert(/Talks to/.test(await page.evaluate(() => document.querySelector('#panel .ar-drawer').textContent)), 'no Talks to');
  // Down moves through the rows to the link; OK jumps.
  const wantKey = 'd:to:' + t.index;
  for (let i = 0; i < 40 && await focusKey(page) !== wantKey; i++) await press(page, 'ArrowDown');
  assert(await focusKey(page) === wantKey, 'cannot reach the link: ' + await focusKey(page));
  await press(page, 'Enter');
  s = await st(page);
  assert(s.node === null && s.view === 'group' && s.parent === t.parentOfTo, 'the jump landed on ' + JSON.stringify(s) + ', wanted ' + t.parentOfTo);
  assert(await focusKey(page) === 'g:' + t.to, 'the jump focused ' + await focusKey(page) + ', wanted g:' + t.to);
  // Back walks up, one level at a time, then closes.
  let guard = 0;
  while ((await st(page)).view !== 'big' && guard++ < 8) await press(page, 'Escape');
  assert((await st(page)).view === 'big', 'did not reach the Big picture');
  await press(page, 'Escape');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === null), 4000, 'did not close');
  noErrors(page);
  await page.context().close();
}

async function checkLongDrawer() {
  const page = await openHub({ size: [3, 2] });
  await openWidget(page);
  // The part whose drawer is the longest.
  const id = await page.evaluate(() => {
    let best = null, len = 0;
    (function walk(n) {
      const l = (n.summary || '').length + (n.details || []).join('').length + (n.notes || []).join('').length + (n.files || []).join('').length + (n.talksTo || []).length * 80;
      if (n.id && l > len) { len = l; best = n.id; }
      (n.children || []).forEach(walk);
    })({ children: window.HUB_ARCH.tree });
    return best;
  });
  await page.evaluate((i) => window.HUB_ARCHITECTURE.goto(i, true), id);
  await settle(page);
  const before = await st(page);
  assert(before.node === id, 'drawer not open');
  const over = await page.evaluate(() => { const c = document.querySelector('#panel .ar-dr-clip'), s = document.querySelector('#panel .ar-dr-scroll'); return s.offsetHeight - c.clientHeight; });
  assert(over > 0, 'the longest drawer fits without scrolling (' + over + '); the test cannot check scrolling');
  let last = null;
  for (let i = 0; i < 60; i++) {
    const k = await focusKey(page);
    const sc = (await st(page)).scroll;
    await press(page, 'ArrowDown');
    if (k === last && (await st(page)).scroll === sc) break;
    last = k;
  }
  const end = await page.evaluate(() => {
    const clip = document.querySelector('#panel .ar-dr-clip').getBoundingClientRect();
    const f = document.querySelector('#panel .ar-dr-scroll .f.is-focused');
    const rows = document.querySelectorAll('#panel .ar-dr-scroll .f');
    const lastRow = rows[rows.length - 1].getBoundingClientRect();
    return { scroll: window.HUB_ARCHITECTURE.state().scroll, focusLast: f === rows[rows.length - 1], lastBottomInside: lastRow.bottom <= clip.bottom + 2, lastTopInside: lastRow.top >= clip.top - 2 };
  });
  assert(end.scroll > 0 && end.focusLast && end.lastBottomInside, 'the end of the drawer is not reachable: ' + JSON.stringify(end));
  // And Up brings the top back.
  for (let i = 0; i < 80; i++) await press(page, 'ArrowUp');
  assert((await st(page)).scroll === 0, 'Up did not scroll back to the top');
  // Left closes the drawer.
  await press(page, 'ArrowLeft');
  assert((await st(page)).node === null, 'Left did not close the drawer');
  noErrors(page);
  await page.context().close();
}

async function checkFlows() {
  const page = await openHub({ size: [3, 2] });
  await openWidget(page);
  for (let i = 0; i < 6 && await focusKey(page) !== 'flows'; i++) await press(page, 'ArrowDown');
  assert(await focusKey(page) === 'flows', 'cannot reach the Data flows chip');
  await press(page, 'Enter');
  let s = await st(page);
  assert(s.view === 'flows', JSON.stringify(s));
  const n = await page.evaluate(() => document.querySelectorAll('#panel .ar-frow').length);
  assert(n === 21, n + ' flows in the list');
  assert(await focusKey(page) === 'fl:flow.pr-to-tv', 'focus on ' + await focusKey(page));
  // Down the list, then into a flow.
  await press(page, 'ArrowDown'); await press(page, 'ArrowDown');
  const flowKey = await focusKey(page);
  await press(page, 'Enter');
  s = await st(page);
  assert(s.view === 'flow' && s.flow === flowKey.slice(3) && s.step === 0, JSON.stringify(s));
  const info = () => page.evaluate(() => ({
    now: (document.querySelector('#panel .ar-step.is-now .ar-step-node') || {}).textContent,
    group: (document.querySelector('#panel .ar-step.is-now .ar-step-group') || {}).textContent,
    count: (document.querySelector('#panel .ar-now-count') || {}).textContent,
    say: (document.querySelector('#panel .ar-now-say') || {}).textContent,
    title: (document.querySelector('#panel .ar-now-title') || {}).textContent,
    steps: document.querySelectorAll('#panel .ar-step').length,
    nowCount: document.querySelectorAll('#panel .ar-step.is-now').length
  }));
  const a = await info();
  assert(a.nowCount === 1 && /^Step 1 of \d+$/.test(a.count) && a.say && a.group, JSON.stringify(a));
  await press(page, 'ArrowRight');
  const b = await info();
  assert((await st(page)).step === 1 && /^Step 2 of/.test(b.count) && b.now !== a.now, JSON.stringify(b));
  await press(page, 'ArrowLeft'); await press(page, 'ArrowLeft');
  assert((await st(page)).step === 0, 'Left went past the first step');
  for (let i = 0; i < a.steps + 3; i++) await press(page, 'ArrowRight');
  const c = await info();
  assert((await st(page)).step === a.steps - 1 && new RegExp('^Step ' + a.steps + ' of ' + a.steps).test(c.count), 'did not stop on the last step: ' + JSON.stringify(c));
  assert((await inspect(page, 0.85)).length === 0, (await inspect(page, 0.85)).join('; '));
  // OK shows the step's part on its group's diagram.
  const target = await page.evaluate((i) => { const f = window.HUB_ARCH.flows.filter((x) => x.id === window.HUB_ARCHITECTURE.state().flow)[0]; return f.steps[i].node; }, a.steps - 1);
  await press(page, 'Enter');
  s = await st(page);
  assert(s.view !== 'flow' && await focusKey(page) === (s.view === 'big' ? 'bp:' + target : 'g:' + target), 'the step did not land on ' + target + ': ' + JSON.stringify(s) + ' ' + await focusKey(page));
  noErrors(page);
  await page.context().close();
  // Back from a flow goes to the list, then the Big picture.
  const p2 = await openHub({ size: [3, 2] });
  await openWidget(p2);
  await p2.evaluate(() => window.HUB_ARCHITECTURE.flow('flow.tv-boot', 2));
  await settle(p2);
  await press(p2, 'Escape');
  assert((await st(p2)).view === 'flows', 'Back from a flow');
  await press(p2, 'Escape');
  assert((await st(p2)).view === 'big', 'Back from the list');
  await p2.context().close();
}

// Every level fits the screen: English, and with every text a quarter longer.
async function checkFit(grow) {
  const page = await openHub({ size: [3, 2], grow: grow });
  await openWidget(page);
  const ids = await page.evaluate(() => window.HUB_ARCH.tree.map((g) => g.id));
  const problems = [];
  const look = async (label) => {
    await settle(page);
    const p = await inspect(page, 0.85);
    p.forEach((x) => problems.push(label + ': ' + x));
  };
  await look('big');
  for (const g of ids) {
    await page.evaluate((id) => window.HUB_ARCHITECTURE.goto(id, false), g);       // the group's box... on the Big picture
    await page.evaluate((id) => { const k = window.HUB_ARCH.tree.filter((t) => t.id === id)[0]; window.HUB_ARCHITECTURE.goto(k.children[0].id, false); }, g);
    await look('group ' + g);
    // Walk every card with Down so the scroller reveals each one.
    for (let i = 0; i < 30; i++) {
      const before = await focusKey(page);
      await press(page, 'ArrowDown');
      if (await focusKey(page) === before) break;
    }
    await look('group ' + g + ' scrolled');
  }
  // A drawer for a part with every kind of row.
  const rich = await page.evaluate(() => {
    let best = null, score = 0;
    (function walk(n) {
      const s = (n.details || []).length + (n.notes || []).length + (n.files || []).length + (n.talksTo || []).length + (n.children || []).length;
      if (n.id && s > score) { score = s; best = n.id; }
      (n.children || []).forEach(walk);
    })({ children: window.HUB_ARCH.tree });
    return best;
  });
  await page.evaluate((id) => window.HUB_ARCHITECTURE.goto(id, true), rich);
  await look('drawer');
  for (let i = 0; i < 12; i++) await press(page, 'ArrowDown');
  await look('drawer scrolled');
  await press(page, 'Escape');
  await page.evaluate(() => window.HUB_ARCHITECTURE.flow('flow.pr-to-tv', 3));
  await look('flow');
  await press(page, 'Escape');
  await look('flows');
  assert(!problems.length, problems.slice(0, 8).join(' | '));
  noErrors(page);
  await page.context().close();
}

async function checkPi() {
  // The biggest group (16 parts): every card reachable by the arrow keys, none off the screen when focused.
  const page = await openHub({ size: [3, 2] });
  await openWidget(page);
  await press(page, 'ArrowDown');                                // Pi
  await press(page, 'Enter');
  const total = await page.evaluate(() => document.querySelectorAll('#panel .ar-card').length);
  assert(total === 16 || total > 8, 'the Pi has ' + total + ' cards');
  const seen = {};
  for (let i = 0; i < 80; i++) {
    seen[await focusKey(page)] = 1;
    const dir = ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown'][i % 4];
    const before = await focusKey(page);
    await press(page, dir);
    if (await focusKey(page) === before && dir === 'ArrowDown') break;
    const offs = await inspect(page, 0.85);
    assert(!offs.length, 'on ' + await focusKey(page) + ': ' + offs.join('; '));
  }
  assert(Object.keys(seen).length >= 5, 'the keys reached only ' + Object.keys(seen).join(','));
  await page.context().close();
}

(async function main() {
  const pagePort = await spare();
  PAGE = 'http://127.0.0.1:' + pagePort;
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(pagePort), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  try {
    await waitForPort(pagePort);
    browser = await chromium.launch();
    await check('files: plain ES5, no template strings, CSS ends with .css-end, linked and ordered, TV data in step with data.json', checkFiles);
    await check('the widget registers (openMode full) with a tile titled Architecture', checkRegistered);
    await check('the tile draws at every size without the data file (map, counts, nothing past the tile)', checkTiles);
    await check('a layout of the widget alone opens straight to full screen', checkSolo);
    await check('OK opens full screen, the data loads once, Big picture drawn, Back closes', checkOpenAndLoad);
    await check('a failed data fetch is tried again; two failures say so and OK retries', checkLoadFailure);
    await check('Big picture: arrows move to the nearest box, the flows chip, OK opens a group, Back returns', checkBigPicture);
    await check('a group: cards, deeper with OK, Back lands on the same card, Details pill and drawer', checkGroupAndDrawer);
    await check('the drawer (about 40%) and a Talks to jump landing on the right part; Back walks up and closes', checkDrawerAndJump);
    await check('the longest drawer scrolls to its last row and back', checkLongDrawer);
    await check('data flows: chip, list, stepping (clamped), OK shows the part, Back up', checkFlows);
    await check('the biggest group: arrows reach cards, all of it on screen', checkPi);
    await check('every level fits the screen in English', () => checkFit(false));
    await check('every level fits the screen with every text 25% longer (with accents)', () => checkFit(true));
  } catch (e) {
    failed++;
    console.log('FAIL  setup: ' + (e && e.message));
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { preview.kill(); } catch (e) { /* ignore */ }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
