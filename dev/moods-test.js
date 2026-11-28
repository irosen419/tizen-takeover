/*
 * Moods (app/widgets/moods.js, app/moods-wall.js, app/widgets/moods-touch.js,
 * app/widgets/moods.css): node dev/moods-test.js
 *
 * The real hub in headless Chromium on the shared harness (dev/awws-harness.js),
 * first against a made-up Pi that serves the live resource "moods"
 * (dev/samples/moods-sample.json, checked below to have the real resource's
 * shape) and takes POST /moods/set (it can fail on cue and grow the Spanish
 * names), then against the real hub server (pi/server.js, pi/moods/controller.js)
 * in this process with dev/mock-wall.js as the wall, dev/mock-lights.js as
 * Home Assistant, the fake Pi-drawn engine (pi/moods/engine.js) and a
 * throwaway data folder. Nothing reaches the internet, a real wall or the
 * Pi. Checks:
 *   - the files are plain ES5; moods.css has no grid, no flex gap, animates
 *     only opacity and transform and ends with .css-end; hub.html, touch.html,
 *     dev/styles-test.js ORDER, app/touch.js and app/config.js know Moods; every
 *     word the widget prints has Spanish in app/i18n.js;
 *   - the "Moods test" layout (moods 8x6, ambience 4x6) fills the grid, Main
 *     is untouched;
 *   - the wall drawing places 162 bulbs, LEDs 0 to 161, none for 162 or 163;
 *   - the tile at 1x1, 3x1, 6x1, 3x2, 6x2, 6x4 and 8x6 in English, Spanish and
 *     Spanish +25% with accents: something to read, nothing outside the tile,
 *     line height 1.3 or more, no clipped accents;
 *   - the panel: focus starts on what is on; focus on a card previews it in
 *     the hero ("Preview"); Back returns the hero to what is on; OK shows
 *     "Sending..." at once, the Pi got exactly { id }, and its push confirms;
 *     rollback with a plain line when the wall does not answer and when the
 *     Pi can't be reached; brightness pips (Right, sent once); Lamp and bars
 *     (OK); the night stepper only for Menorah (Right, sent, candles follow);
 *   - full screen fits the screen in English and Spanish;
 *   - not set up, not answering and changed somewhere else;
 *   - the wall tablet (?as=tablet) by touch: every control 2.75rem or more,
 *     a tap applies;
 *   - the phone (touch.html?as=phone, 390 wide): the wall, a real slider,
 *     cards in two columns, a tap applies, nothing wider than the screen;
 *   - no console errors;
 *   - the real Pi: nothing sent at start; 162 bulbs and all 22 moods from the
 *     real resource ("Pi-drawn" only where the engine can draw it); OK sends
 *     { id } and the wall gets exactly the golden body (pi/fixtures/moods/);
 *     brightness pips; Off puts the wall back; Menorah nights 1, 2 and 8;
 *     changed somewhere else; the wall not answering and back; the phone
 *     door (/touch/state, touch.html?as=phone, a Spanish refusal); no
 *     WLED_URL; no log line with the wall's address.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 *
 * require('./moods-test') gives the made-up Pi to dev/moods-shots.js:
 * { FAKE, fakePi(opts) } (runs no checks).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SAMPLE = fs.readFileSync(path.join(__dirname, 'samples', 'moods-sample.json'), 'utf8');
const FAKE = 'http://127.0.0.1:1';
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const AMB = {
  state: 'ok',
  lights: [
    { id: 'lamp', name: 'Floor lamp', kind: 'light', on: true, pct: 60, reachable: true, tone: '#ffb877' },
    { id: 'desk', name: 'Desk lamp', kind: 'light', on: true, pct: 40, reachable: true, tone: '#ffcf9a' },
    { id: 'shelf', name: 'Shelf light', kind: 'light', on: false, pct: 0, reachable: true, tone: '' }
  ],
  scenes: [{ id: 'chill', name: 'Chill night', icon: 'moon', tone: '#ff9a52' }, { id: 'read', name: 'Reading', icon: 'book', tone: '#ffe2b0' },
    { id: 'movie', name: 'Movie', icon: 'film', tone: '#7d8cff' }],
  active: 'chill', moods: []
};

/*
 * The made-up Pi. opts: { state, problem, now (merged into now), grow (Spanish
 * names 25% longer) }. Returns { route(context), touchRoute(context, page),
 * posts, res, set(fn), mode(m) ('ok' | 'wall' | 'down' | 'failed'), hold(ms) }.
 */
function fakePi(opts) {
  opts = opts || {};
  const res = JSON.parse(SAMPLE);
  if (opts.state) res.state = opts.state;
  if (opts.problem) res.problem = opts.problem;
  if (opts.now) res.now = Object.assign({}, res.now, opts.now);
  if (opts.grow) {
    res.moods.forEach((m) => {
      ['es', 'descEs'].forEach((k) => { const add = Math.ceil(m[k].length / 4); let pad = ' ÁÉñíóú'; while (pad.length < add) pad += 'ÁÉñíóú'; m[k] = m[k] + pad.slice(0, add); });
    });
  }
  const st = { rev: 2, mode: 'ok', hold: 0, waiters: [] };
  const posts = [];
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Touch', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  function snapshot() {
    return { ok: true, v: 1, epoch: 'moods-fake', rev: st.rev, cursor: String(st.rev), commands: [],
      resources: { moods: { rev: st.rev, data: res }, ambience: { rev: 1, data: AMB } } };
  }
  function bump() {
    st.rev += 1;
    const w = st.waiters.splice(0);
    w.forEach((f) => f());
  }
  function set(fn) { fn(res); bump(); }
  async function moodsSet(body) {
    posts.push(body);
    if (st.hold) await sleep(st.hold);
    if (st.mode === 'down') return null;
    if (st.mode === 'wall') return { status: 502, body: { ok: false, error: 'the wall did not answer' } };
    if (st.mode === 'failed') return { status: 200, body: { ok: true, result: 'failed' } };
    const n = res.now || {};
    if (body.off) res.now = { id: 'off', bri: null, path: null, approx: [], night: null, pair: n.pair !== false, govee: 'set', stale: false, at: 0 };
    else if (body.id && body.id !== n.id) {
      const m = res.moods.filter((x) => x.id === body.id)[0];
      res.now = { id: body.id, bri: m ? m.bri : 100, path: 'wled-effects', approx: [], night: null, pair: n.pair !== false, govee: 'set', stale: false, at: 0 };
    }
    if (typeof body.bri === 'number') res.now.bri = body.bri;
    if (typeof body.night === 'number') res.now.night = body.night;
    if (typeof body.pair === 'boolean') res.now.pair = body.pair;
    res.last = { result: 'ok', at: 0 };
    setTimeout(bump, 150);
    return { status: 200, body: { ok: true, result: 'ok' } };
  }
  async function reply(route, out) {
    if (!out) return route.abort('connectionrefused');
    return route.fulfill({ status: out.status, headers: cors, contentType: 'application/json', body: JSON.stringify(out.body) });
  }
  const route = (context) => context.route(FAKE + '/**', async (r) => {
    const req = r.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (/\/live\/events/.test(url)) return r.abort('connectionrefused');
    if (/\/live\/state/.test(url)) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(snapshot()) });
    if (/\/live\/poll/.test(url)) {
      const m = /[?&]rev=(\d+)/.exec(url);
      if (m && Number(m[1]) >= st.rev) await new Promise((ok) => { st.waiters.push(ok); setTimeout(ok, 2500); });
      return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(snapshot()) }).catch(() => {});
    }
    if (/\/moods\/set$/.test(url)) return reply(r, await moodsSet(JSON.parse(req.postData() || '{}')));
    return r.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"ok":false,"error":"not here"}' });
  });
  const touchRoute = async (context, page) => {
    await context.route(page + '/touch/state', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, moods: { rev: st.rev, data: res } }) }));
    await context.route(page + '/moods/set', async (r) => reply(r, await moodsSet(JSON.parse(r.request().postData() || '{}'))));
  };
  return { route, touchRoute, posts, res, set, mode: (m) => { st.mode = m; }, hold: (ms) => { st.hold = ms; } };
}

module.exports = { FAKE, fakePi };
if (require.main !== module) return;

/* ---------------------------------------------------------------------- */

const H = require('./awws-harness');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
}
function assert(ok, msg) { if (!ok) throw new Error(msg); }
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const box = {};
vm.runInNewContext(read('app/config.js') + '\nthis.c = HUB_CONFIG;', box);
const CFG = box.c;
const TEST = CFG.layouts.filter((l) => l.id === 'moods-test')[0];

// Every moods Spanish text 25% longer, with accents, before the widget loads.
const GROW = new Function('var real; Object.defineProperty(window, "HUB_I18N", { configurable: true, get: function () { return real; }, set: function (v) {' +
  ' real = v; var es = v.strings.es; for (var k in es) if (k.indexOf("moods.") === 0) {' +
  ' var s = es[k]; var add = Math.ceil(s.replace(/\\{\\w+\\}/g, "").length / 4); var pad = " "; while (pad.length < add) pad += "ÁÉñíóú"; es[k] = s + pad.slice(0, add); } } });');

const SIZES = [[1, 1], [3, 1], [6, 1], [3, 2], [6, 2], [6, 4], [8, 6]];

// What a moods tile (or the panel) shows, and what does not fit.
function survey(where) {
  const host = where === 'panel' ? document.querySelector('#panel') : document.querySelector('.cell[data-widget="moods"] .tile');
  if (!host) return null;
  const body = where === 'panel' ? host.querySelector('.panel-body') : host.querySelector('.tile-body');
  const hr = host.getBoundingClientRect();
  const out = { text: (body ? body.innerText : '').trim(), outside: [], tight: [], clipped: [], leds: [], vw: window.innerWidth, vh: window.innerHeight };
  const all = body ? body.querySelectorAll('*') : [];
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (n.closest('svg')) continue;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // Inside a rail that slides, a card past the edge is fine (it scrolls into view).
    if (!n.closest('.md-track') && (r.right > hr.right + 1 || r.bottom > hr.bottom + 1 || r.left < hr.left - 1 || r.top < hr.top - 1)) out.outside.push((n.className || n.tagName) + ' ' + Math.round(r.right - hr.right) + ',' + Math.round(r.bottom - hr.bottom));
    const own = [].some.call(n.childNodes, (c) => c.nodeType === 3 && c.textContent.trim());
    if (!own) continue;
    const lh = parseFloat(cs.lineHeight), fs2 = parseFloat(cs.fontSize);
    if (lh && fs2 && lh / fs2 < 1.29) out.tight.push(n.className + ' ' + (lh / fs2).toFixed(2));
    if (cs.webkitLineClamp === 'none' && cs.textOverflow !== 'ellipsis' && cs.whiteSpace !== 'nowrap' && n.scrollHeight > n.clientHeight + 1 && cs.overflow === 'hidden') out.clipped.push(n.className + ': ' + n.textContent.slice(0, 30));
  }
  const svg = body && body.querySelector('svg.mw-svg');
  if (svg) out.leds = [].map.call(svg.querySelectorAll('[data-led]'), (c) => Number(c.getAttribute('data-led')));
  return out;
}

const panelInfo = (page) => page.evaluate(() => {
  const f = document.querySelector('#panel .is-focused');
  const chip = document.querySelector('#panel .md-chip');
  const sub = document.querySelector('#panel .panel-sub');
  return {
    focus: f ? (f.getAttribute('data-key') || 'hub') : '',
    chip: chip ? chip.textContent : '', chipCls: chip ? chip.className : '',
    cap: (document.querySelector('#panel .md-cap-name') || {}).textContent || '',
    sub: sub ? sub.textContent : '', subCls: sub ? sub.className : '',
    active: [].map.call(document.querySelectorAll('#panel .md-card.is-active'), (c) => c.getAttribute('data-mood')),
    pendingCards: [].map.call(document.querySelectorAll('#panel .md-card.is-pending'), (c) => c.getAttribute('data-mood')),
    night: !!document.querySelector('#panel [data-ctl="night"]'),
    pips: document.querySelectorAll('#panel .md-pip.is-on').length,
    bri: (document.querySelector('#panel .md-ctl-bri .md-ctl-value') || {}).textContent || '',
    pair: (document.querySelector('#panel .md-switch-text') || {}).textContent || '',
    candles: document.querySelectorAll('#panel .md-candle.is-lit').length,
    debug: window.HUB_MOODS_DEBUG ? window.HUB_MOODS_DEBUG() : null
  };
});

// Left along the rail until the controls have focus (a Left more would dim).
async function leftToControls(page) {
  for (let i = 0; i < 30; i++) {
    if (/^ctl:/.test((await panelInfo(page)).focus)) return;
    await H.key(page, 'ArrowLeft');
  }
}

// With the remote, to a card on the rail (from a card or from the controls).
async function goCard(page, id) {
  for (let i = 0; i < 45; i++) {
    const step = await page.evaluate((want) => {
      const f = document.querySelector('#panel .is-focused');
      const t = document.querySelector('#panel .md-card[data-mood="' + want + '"]');
      if (!t) return 'missing';
      if (f === t) return 'done';
      const k = f ? f.getAttribute('data-key') || '' : '';
      if (k === 'ctl:pair') return 'ArrowRight';
      if (k === 'ctl:night') return 'ArrowUp';
      if (/^ctl:/.test(k)) return 'ArrowDown';
      if (!f || !f.getAttribute('data-row')) return 'ArrowDown';
      if (f.getAttribute('data-row') !== t.getAttribute('data-row')) return t.getAttribute('data-row') === 'vases' ? 'ArrowDown' : 'ArrowUp';
      const cards = [].slice.call(document.querySelectorAll('#panel .md-card[data-row="' + t.getAttribute('data-row') + '"]'));
      return cards.indexOf(t) > cards.indexOf(f) ? 'ArrowRight' : 'ArrowLeft';
    }, id);
    if (step === 'done') return;
    if (step === 'missing') throw new Error('no card ' + id);
    await H.key(page, step);
  }
  throw new Error('could not reach the card ' + id);
}

/* ---------- the real Pi: pi/server.js in this process ---------- */

const TOKEN = 'moods-ui-test-token-not-a-secret-0123';
const TODAY = { y: 2026, m: 11, d: 28 };
const os = require('os');
const http = require('http');
const C = require('../pi/moods/catalog');
const W = require('../pi/moods/compile');
const E = require('../pi/moods/engine');
const ctlLib = require('../pi/moods/controller');
const FIX = path.join(ROOT, 'pi', 'fixtures', 'moods');
const fakeEngine = (h) => E.createFakeEngine({ log: h.log, onExit: h.onExit, start: () => ({ ok: true, why: '' }) });

// The resource the real controller builds (the fake engine stands in for the forest one).
function realResource(env) {
  return ctlLib.createController({ env: env || { WLED_URL: 'http://127.0.0.1:9' }, engine: fakeEngine, today: () => TODAY }).start();
}

// The WLED bodies the real controller sends for a mood (compileWled with its context).
function bodiesFor(id, extra) {
  const L = C.load(null);
  const m = C.moodById(L.catalog, id);
  const ctx = Object.assign({ catalog: L.catalog, wall: L.wall, date: TODAY, fxIds: null, palIds: null, have: { mic: null }, briPct: m.bri }, extra || {});
  return W.compileWled(m, ctx).bodies;
}
const golden = (file) => JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8')).bodies;

function httpJson(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }, headers || {});
    const req = http.request({ host: '127.0.0.1', port: port, path: route, method: method, headers: h }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) { j = out; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/*
 * The hub server in this process, as on the Pi: the pretend wall
 * (dev/mock-wall.js) as WLED_URL, a pretend Home Assistant (dev/mock-lights.js)
 * so Ambience reads the wall (its read feeds "changed somewhere else"), the
 * fake Pi-drawn engine and a throwaway data folder. o: { page, wall, ha, wled
 * (false: no WLED_URL for Moods) }.
 */
async function startRealPi(o) {
  const ambience = require('../pi/ambience');
  const hubServer = require('../pi/server');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-moods-ui-'));
  const example = ambience.validateConfig(JSON.parse(read('pi/ambience.example.json')));
  ambience.saveConfig(dataDir, example);
  const lines = [];
  const server = hubServer.start({
    token: TOKEN, port: 0, host: '127.0.0.1', origins: [o.page], dataDir: dataDir, allowHttp: true, calendars: [], appDir: path.join(ROOT, 'app'),
    log: (s) => lines.push(String(s)),
    ambienceEnv: { HA_URL: o.ha.url, HA_TOKEN: o.ha.token, WLED_URL: o.wall.url }, ambience: { timeoutMs: 700, screenMs: 1500, idleMs: 1500 },
    moodsEnv: o.wled === false ? {} : { WLED_URL: o.wall.url },
    moods: { engine: fakeEngine, today: () => TODAY }
  });
  await server.ready;
  return {
    server: server, port: server.port, url: 'http://127.0.0.1:' + server.port, dataDir: dataDir, lines: lines,
    api: (method, route, body) => httpJson(server.port, method, route, body, { Authorization: 'Bearer ' + TOKEN }),
    close: () => new Promise((r) => { server.close(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* gone */ } r(); }); })
  };
}

(async function main() {
  const env = await H.start({ at: Date.now() });
  async function open(o) {
    o = o || {};
    const fake = fakePi(o.fake || {});
    const page = await env.newPage({ layout: o.layout || TEST.layout, at: Date.now(), live: FAKE, route: fake.route, waitLive: false,
      storage: { 'homeHub.lang': o.lang || 'en' }, config: o.config, query: o.query, touch: o.touch, motion: o.motion });
    await H.until(() => page.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'the fake Pi did not go live');
    await H.sleep(500);
    page.fake = fake;
    return page;
  }
  try {
    await check('ES5, CSS rules, and every place that lists widgets knows Moods', () => {
      let acorn = null;
      for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) { try { acorn = require(p); break; } catch (e) { /* next */ } }
      ['app/moods-wall.js', 'app/widgets/moods.js', 'app/widgets/moods-touch.js'].forEach((f) => {
        const text = read(f);
        if (acorn) acorn.parse(text, { ecmaVersion: 5 });
        else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), f + ': ES2015 syntax');
      });
      const css = read('app/widgets/moods.css');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'moods.css does not end with .css-end');
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/display:\s*(inline-)?grid|grid-template|[^-]gap:/.test(bare), 'grid or gap in moods.css');
      assert(!/\btransition\s*:/.test(bare) || /transition\s*:\s*(opacity|transform)/.test(bare), 'a transition on something else');
      (bare.match(/@(-webkit-)?keyframes[^{]+\{([^{}]*\{[^}]*\})+\s*\}/g) || []).forEach((k) => {
        const props = (k.match(/([a-z-]+)\s*:/g) || []).map((p) => p.replace(/\s*:/, ''));
        props.forEach((p) => assert(p === 'opacity' || p === 'transform' || p === '-webkit-transform', 'keyframes animate ' + p));
      });
      assert(!/text-transform:\s*uppercase/.test(bare), 'an uppercase label');
      const hub = read('app/hub.html');
      assert(hub.indexOf('src="moods-wall.js"') > 0 && hub.indexOf('src="moods-wall.js"') < hub.indexOf('widgets/moods.js') && hub.indexOf('widgets/moods.js') < hub.indexOf('src="hub.js"'), 'hub.html script order');
      assert(hub.indexOf('widgets/ambience.css') < hub.indexOf('widgets/moods.css'), 'hub.html: moods.css after ambience.css');
      const touch = read('app/touch.html');
      assert(touch.indexOf('moods-wall.js') > 0 && touch.indexOf('widgets/moods-touch.js') > touch.indexOf('moods-wall.js') && touch.indexOf('widgets/moods.css') > 0, 'touch.html');
      assert(/widgets\/ambience\.css widgets\/moods\.css/.test(read('dev/styles-test.js')), 'dev/styles-test.js ORDER');
      assert(/moods: \['moods\.title', 'Moods'\]/.test(read('app/touch.js')), 'app/touch.js NAMES');
      // Every word the widget prints has Spanish.
      const i18n = read('app/i18n.js');
      const keys = {};
      ['app/widgets/moods.js', 'app/widgets/moods-touch.js'].forEach((f) => { (read(f).match(/T\('([\w.]+)'/g) || []).forEach((m) => { keys[m.slice(3, -1)] = 1; }); });
      const missing = Object.keys(keys).filter((k) => i18n.indexOf("'moods." + k + "':") < 0);
      assert(Object.keys(keys).length > 40 && !missing.length, 'no Spanish for ' + missing.join(', '));
    });

    await check('the "Moods test" layout: moods 8x6 beside ambience 4x6, filling the grid; Main untouched', () => {
      assert(TEST && TEST.name === 'Moods test' && TEST.rotate === false, 'no Moods test layout');
      assert(TEST.layout.map((e) => e.widget + e.x + e.y + e.w + e.h).join() === 'moods0086,ambience8046', JSON.stringify(TEST.layout));
      const cells = {};
      TEST.layout.forEach((e) => { for (let x = e.x; x < e.x + e.w; x++) for (let y = e.y; y < e.y + e.h; y++) { assert(!cells[x + ',' + y], 'overlap'); cells[x + ',' + y] = 1; } });
      assert(Object.keys(cells).length === 72, 'not 72 cells');
      const main = CFG.layouts.filter((l) => l.id === 'main')[0];
      assert(main && !main.layout.some((e) => e.widget === 'moods') && !CFG.layout.some((e) => e.widget === 'moods'), 'Main or the stock layout changed');
    });

    const page = await open();
    await check('the wall drawing: 162 bulbs, LEDs 0 to 161, none for 162 or 163', async () => {
      const s = await page.evaluate(survey, 'tile');
      assert(s, 'no tile');
      const leds = s.leds.slice().sort((a, b) => a - b);
      assert(leds.length === 162, leds.length + ' bulbs');
      for (let i = 0; i < 162; i++) assert(leds[i] === i, 'LED ' + i + ' missing (got ' + leds[i] + ')');
      const fromMap = await page.evaluate(() => window.HUB_MOODS_WALL.bulbs(window.HUB_LIVE.get('moods').wall).map((b) => b.led));
      assert(fromMap.length === 162 && fromMap.indexOf(162) < 0 && fromMap.indexOf(163) < 0, 'bulbs(): ' + fromMap.length);
    });
    await check('the 8x6 tile: the lit wall, the name and the description, all inside', async () => {
      const s = await page.evaluate(survey, 'tile');
      assert(/Christmas/.test(s.text) && /candy cane/.test(s.text) && /On now/.test(s.text), s.text);
      assert(!s.outside.length, 'outside: ' + s.outside.join(' | '));
      assert(!s.tight.length, 'tight lines: ' + s.tight.join(' | '));
      const lit = await page.evaluate(() => document.querySelectorAll('.cell[data-widget="moods"] .mw-core.is-on').length);
      assert(lit > 60, lit + ' lit bulbs');
    });

    await check('the panel: focus starts on what is on, Right previews the next card, Back returns to what is on', async () => {
      await H.openPanel(page, 'moods');
      let p = await panelInfo(page);
      assert(p.focus === 'mood:christmas' && /On now/.test(p.chip) && p.cap === 'Christmas', JSON.stringify(p));
      await H.key(page, 'ArrowRight');
      p = await panelInfo(page);
      assert(p.focus === 'mood:santa' && p.chip === 'Preview' && /is-preview/.test(p.chipCls) && p.cap === 'Santa Claus Is Coming to Town', JSON.stringify(p));
      const painted = await page.evaluate(() => { const v = document.querySelector('#panel .md-hero svg'); return v ? v.getAttribute('class') : ''; });
      assert(/mw-a-breathe/.test(painted), 'hero not repainted: ' + painted);
      await H.key(page, 'Escape');
      await H.sleep(300);
      p = await panelInfo(page);
      assert(await page.evaluate(() => window.HUB_TEST.open()) === 'moods', 'Back closed the panel');
      assert(p.focus === 'mood:christmas' && /On now/.test(p.chip) && p.cap === 'Christmas', JSON.stringify(p));
    });

    await check('OK applies: "Sending..." at once, the Pi gets exactly { id }, its push confirms', async () => {
      page.fake.hold(900);
      await H.key(page, 'ArrowDown');
      let p = await panelInfo(page);
      assert(/^mood:/.test(p.focus) && p.focus !== 'mood:christmas', 'Down: ' + p.focus);
      const want = p.focus.slice(5);
      await H.key(page, 'Enter');
      await H.sleep(150);
      p = await panelInfo(page);
      assert(p.pendingCards.indexOf(want) >= 0 && /Sending/.test(p.chip), 'not pending: ' + JSON.stringify(p));
      await H.until(() => page.fake.posts.length > 0, 3000, 'nothing sent');
      assert(JSON.stringify(page.fake.posts[0]) === JSON.stringify({ id: want }), 'sent ' + JSON.stringify(page.fake.posts[0]));
      await H.until(async () => { const q = await panelInfo(page); return q.active[0] === want && !q.pendingCards.length ? q : false; }, 5000, 'not confirmed');
      p = await panelInfo(page);
      assert(/is on/.test(p.sub) && /On now/.test(p.chip), JSON.stringify(p));
      page.fake.hold(0);
      page.fake.posts.length = 0;
    });

    await check('rollback with a plain line: the wall does not answer, then the Pi can\'t be reached', async () => {
      const before = (await panelInfo(page)).active[0];
      page.fake.mode('wall');
      await H.key(page, 'ArrowRight');
      await H.key(page, 'Enter');
      await H.until(async () => /didn’t answer/.test((await panelInfo(page)).sub), 4000, 'no plain line');
      let p = await panelInfo(page);
      assert(p.active[0] === before && !p.pendingCards.length && /md-sub-bad/.test(p.subCls), JSON.stringify(p));
      page.fake.mode('down');
      await H.key(page, 'Enter');
      await H.until(async () => /Couldn’t reach the Pi/.test((await panelInfo(page)).sub), 4000, 'no plain line for the Pi');
      p = await panelInfo(page);
      assert(p.active[0] === before, JSON.stringify(p));
      page.fake.mode('ok');
      page.fake.posts.length = 0;
    });

    await check('brightness pips: Left from the rail reaches them, Right or Left moves one pip at once and is sent once', async () => {
      // Back to the first card, then Left into the controls.
      await leftToControls(page);
      let p = await panelInfo(page);
      assert(p.focus === 'ctl:bri', 'focus ' + p.focus);
      const pipsBefore = p.pips;
      const dir = pipsBefore < 5 ? 1 : -1;
      await H.key(page, dir > 0 ? 'ArrowRight' : 'ArrowLeft');
      p = await panelInfo(page);
      assert(p.pips === pipsBefore + dir && p.focus === 'ctl:bri', 'pips ' + pipsBefore + ' -> ' + p.pips + ', focus ' + p.focus);
      await H.until(() => page.fake.posts.length > 0, 3000, 'nothing sent');
      await H.sleep(500);
      assert(page.fake.posts.length === 1 && typeof page.fake.posts[0].bri === 'number' && page.fake.posts[0].id, JSON.stringify(page.fake.posts));
      page.fake.posts.length = 0;
    });

    await check('Lamp and bars: OK switches to "Leave as they are" and tells the Pi', async () => {
      await H.key(page, 'ArrowDown');
      let p = await panelInfo(page);
      assert(p.focus === 'ctl:pair' && /With the mood/.test(p.pair), JSON.stringify(p));
      await H.key(page, 'Enter');
      p = await panelInfo(page);
      assert(/Leave as they are/.test(p.pair), 'still ' + p.pair);
      await H.until(() => page.fake.posts.length > 0, 3000, 'nothing sent');
      assert(page.fake.posts[0].pair === false && page.fake.posts[0].step === true, JSON.stringify(page.fake.posts));
      assert(!p.night, 'a night stepper for a mood that is not Menorah');
      page.fake.posts.length = 0;
    });
    await check('no console errors (English panel)', async () => {
      const errs = H.errorsOf(page, true);
      assert(!errs.length, errs.join(' | '));
    });
    await page.ctx.close();

    await check('Menorah: the night stepper, Right sends the next night, the candles follow', async () => {
      const p = await open({ fake: { now: { id: 'menorah', bri: 80, night: 3 } } });
      await H.openPanel(p, 'moods');
      let q = await panelInfo(p);
      assert(q.night && q.candles === 3, JSON.stringify(q));
      const heroLit = () => p.evaluate(() => document.querySelectorAll('#panel .md-hero .mw-core.is-on').length);
      const before = await heroLit();
      // Left into the controls, then down to the night.
      await leftToControls(p);
      await H.key(p, 'ArrowDown', 2);
      q = await panelInfo(p);
      assert(q.focus === 'ctl:night', 'focus ' + q.focus);
      await H.key(p, 'ArrowRight');
      q = await panelInfo(p);
      assert(q.candles === 4, 'candles ' + q.candles);
      await H.until(() => p.fake.posts.length > 0, 3000, 'nothing sent');
      assert(JSON.stringify(p.fake.posts[0]) === JSON.stringify({ id: 'menorah', night: 4, step: true }), JSON.stringify(p.fake.posts));
      assert(await heroLit() >= before, 'the hero lost bulbs');
      const errs = H.errorsOf(p, true);
      assert(!errs.length, errs.join(' | '));
      await p.ctx.close();
    });

    for (const [tag, o] of [['English', { lang: 'en' }], ['Spanish', { lang: 'es' }], ['Spanish +25%', { lang: 'es', config: GROW, fake: { grow: true } }]]) {
      await check(tag + ': the tile at 1x1, 3x1, 6x1, 3x2, 6x2, 6x4 and 8x6 reads and fits', async () => {
        const bad = [];
        for (const [w, h] of SIZES) {
          const layout = [{ widget: 'moods', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: w < 12 ? w : 0, y: w < 12 ? 0 : h, w: w < 12 ? 12 - w : 12, h: w < 12 ? 6 : 6 - h }];
          const p = await open(Object.assign({ layout: layout }, o));
          const s = await p.evaluate(survey, 'tile');
          const where = w + 'x' + h;
          if (!s) { bad.push(where + ' no tile'); await p.ctx.close(); continue; }
          if (w > 1 && !s.text) bad.push(where + ' nothing to read');
          if (w === 1 && !(await p.evaluate(() => !!document.querySelector('.cell[data-widget="moods"] .md-one-dot.is-on')))) bad.push(where + ' no lit dot');
          if (/couldn/.test(s.text)) bad.push(where + ' broken');
          if (s.outside.length) bad.push(where + ' outside: ' + s.outside.join(', '));
          if (s.tight.length) bad.push(where + ' tight: ' + s.tight.join(', '));
          if (s.clipped.length) bad.push(where + ' clipped: ' + s.clipped.join(', '));
          if (o.lang === 'es' && w >= 3 && !/Navidad/.test(s.text)) bad.push(where + ' not Spanish: ' + s.text.slice(0, 60));
          if (h >= 2 && w >= 3 && s.leds.length !== 162) bad.push(where + ' wall has ' + s.leds.length + ' bulbs');
          const errs = H.errorsOf(p, true);
          if (errs.length) bad.push(where + ' console: ' + errs.join(' | '));
          await p.ctx.close();
        }
        assert(!bad.length, bad.join(' ;; '));
      });
      await check(tag + ': the panel and full screen fit, no English left in Spanish', async () => {
        const p = await open(o);
        await H.openPanel(p, 'moods');
        for (const mode of ['panel', 'full']) {
          if (mode === 'full') await H.fullScreen(p);
          const s = await p.evaluate(survey, 'panel');
          assert(!s.outside.length, mode + ' outside: ' + s.outside.join(' | '));
          assert(!s.tight.length, mode + ' tight: ' + s.tight.join(' | '));
          if (o.lang === 'es') {
            const eng = /\b(Whole wall|Vases|Brightness|Lamp and bars|On now|Preview|Off now|Leave as they are|With the mood)\b/.exec(s.text);
            assert(!eng, mode + ': English "' + (eng && eng[0]) + '"');
            assert(/Toda la pared/.test(s.text) && /Brillo/.test(s.text) && /Navidad/.test(s.text), mode + ': ' + s.text.slice(0, 120));
          }
        }
        const errs = H.errorsOf(p, true);
        assert(!errs.length, errs.join(' | '));
        await p.ctx.close();
      });
    }

    await check('not set up: the tile and the panel say so, and how', async () => {
      const p = await open({ fake: { state: 'notset' } });
      const s = await p.evaluate(survey, 'tile');
      assert(/Not set up/.test(s.text) && !s.outside.length, s.text);
      await H.openPanel(p, 'moods');
      const t = await p.evaluate(survey, 'panel');
      assert(/WLED_URL/.test(t.text), t.text);
      await p.ctx.close();
    });
    await check('not answering, and changed somewhere else: plain notes on the tile and in the panel', async () => {
      let p = await open({ fake: { state: 'error', problem: 'away' } });
      let s = await p.evaluate(survey, 'tile');
      assert(/The wall isn’t answering/.test(s.text), s.text);
      await H.openPanel(p, 'moods');
      let q = await panelInfo(p);
      assert(/isn’t answering/.test(q.sub) && /md-sub-bad/.test(q.subCls), JSON.stringify(q));
      await p.ctx.close();
      p = await open({ fake: { now: { stale: true } } });
      s = await p.evaluate(survey, 'tile');
      assert(/Changed somewhere else/.test(s.text), s.text);
      await p.ctx.close();
    });
    await check('waiting for the Pi: the tile waits quietly (hub-dormant)', async () => {
      const p = await env.newPage({ layout: TEST.layout, at: Date.now(), live: 'http://127.0.0.1:9', waitLive: false });
      await H.sleep(600);
      const d = await p.evaluate(() => !!document.querySelector('.cell[data-widget="moods"] .hub-dormant'));
      assert(d, 'not dormant');
      await p.ctx.close();
    });

    await check('the wall tablet by touch: every control 2.75rem or more, a tap applies', async () => {
      const p = await open({ query: 'as=tablet', touch: true });
      await p.evaluate(() => document.querySelector('.cell[data-widget="moods"] .tile').click());
      await H.until(() => p.evaluate(() => window.HUB_TEST.open() === 'moods'), 5000, 'did not open');
      await H.idle(p);
      const small = await p.evaluate(() => {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const out = [];
        document.querySelectorAll('#panel .panel-body .f, #panel .md-pip, #panel .md-step-btn').forEach((n) => {
          const r = n.getBoundingClientRect();
          if (r.width && (r.height < 2.75 * rem - 1 || r.width < 2.75 * rem - 1)) out.push((n.getAttribute('data-key') || n.className) + ' ' + (r.width / rem).toFixed(2) + 'x' + (r.height / rem).toFixed(2));
        });
        return out;
      });
      assert(!small.length, 'small targets: ' + small.join(', '));
      await p.evaluate(() => document.querySelector('#panel .md-card[data-mood="aurora"]').click());
      await H.until(() => p.fake.posts.length > 0, 3000, 'nothing sent');
      assert(JSON.stringify(p.fake.posts[0]) === JSON.stringify({ id: 'aurora' }), JSON.stringify(p.fake.posts));
      await H.until(async () => (await panelInfo(p)).active[0] === 'aurora', 4000, 'not confirmed');
      const errs = H.errorsOf(p, true);
      assert(!errs.length, errs.join(' | '));
      await p.ctx.close();
    });

    await check('the phone (touch.html?as=phone, 390 wide): wall, a real slider, two columns, a tap applies', async () => {
      const fake = fakePi({});
      const ctx = await env.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      const errors = [];
      await fake.touchRoute(ctx, env.PAGE);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(env.PAGE + '/touch.html?as=phone#/moods');
      await p.waitForSelector('.mt-hero svg', { timeout: 10000 });
      const s = await p.evaluate(() => {
        const cards = document.querySelectorAll('.mt-card');
        const a = cards[0].getBoundingClientRect(), b = cards[1].getBoundingClientRect();
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return { wide: document.documentElement.scrollWidth, range: !!document.querySelector('input[type="range"].mt-range'),
          cols: Math.abs(a.top - b.top) < 2 && b.left > a.right - 2, small: [].filter.call(document.querySelectorAll('.mt-root button, .mt-root input'), (n) => n.getBoundingClientRect().height < 2.75 * rem - 1).length,
          leds: document.querySelectorAll('.mt-hero [data-led]').length, name: (document.querySelector('.mt-name') || {}).textContent };
      });
      assert(s.wide <= 390 && s.range && s.cols && !s.small && s.leds === 162 && s.name === 'Christmas', JSON.stringify(s));
      await p.click('.mt-card[data-mood="sunset"]');
      await H.until(() => fake.posts.length > 0, 3000, 'nothing sent');
      assert(JSON.stringify(fake.posts[0]) === JSON.stringify({ id: 'sunset' }), JSON.stringify(fake.posts));
      await H.until(() => p.evaluate(() => (document.querySelector('.mt-name') || {}).textContent === 'Sunset'), 6000, 'the phone did not follow');
      assert(!errors.length, errors.join(' | '));
      await ctx.close();
    });

    /* ----- the same widget against the real Pi (pi/server.js in this process) ----- */

    await check('dev/samples/moods-sample.json has the real resource\'s shape: the same moods (tags, pv, param) and wall', () => {
      const real = realResource();
      const sample = JSON.parse(SAMPLE);
      assert(JSON.stringify(Object.keys(sample)) === JSON.stringify(Object.keys(real)), 'keys ' + Object.keys(sample) + ' vs ' + Object.keys(real));
      assert(JSON.stringify(Object.keys(sample.now).sort()) === JSON.stringify(Object.keys(real.now).sort()), 'now keys');
      const bad = real.moods.filter((m, i) => JSON.stringify(m) !== JSON.stringify(sample.moods[i])).map((m) => m.id);
      assert(sample.moods.length === real.moods.length && !bad.length, 'moods differ: ' + bad.join(', ') + ' (rebuild the sample from the controller)');
      assert(JSON.stringify(sample.wall) === JSON.stringify(real.wall), 'the wall differs from pi/moods/wall.json');
    });

    env.wall = await require('./mock-wall').start();
    env.ha = await require('./mock-lights').start({});
    env.real = await startRealPi({ page: env.PAGE, wall: env.wall, ha: env.ha });
    const W0 = env.wall.state();
    async function openReal(pi, o) {
      o = o || {};
      const p = await env.newPage({ layout: o.layout || TEST.layout, at: Date.now(), live: pi.url, waitLive: false,
        storage: { 'homeHub.lang': o.lang || 'en' }, query: o.query, touch: o.touch });
      p.sent = [];
      p.on('request', (r) => { if (r.method() === 'POST' && /\/moods\/set$/.test(r.url())) { try { p.sent.push(JSON.parse(r.postData() || '{}')); } catch (e) { p.sent.push(null); } } });
      await H.until(() => p.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'the real Pi did not go live');
      await H.until(() => p.evaluate(() => !!window.HUB_LIVE.get('moods')), 5000, 'no moods resource from the real Pi');
      await H.sleep(500);
      return p;
    }
    const wallPosts = () => env.wall.posts();
    // Waits for the panel to confirm a mood, then the wall's new bodies since mark.
    async function confirmed(p, want, mark) {
      await H.until(async () => { const q = await panelInfo(p); return (want === 'off' ? !q.active.length || q.active[0] === 'off' : q.active[0] === want) && !q.pendingCards.length; }, 6000, want + ' not confirmed');
      return wallPosts().slice(mark);
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const rp = await openReal(env.real);
    await check('real Pi: nothing reaches the wall at start; the resource draws 162 bulbs and all 22 moods on the rail', async () => {
      assert(!wallPosts().length, 'the wall got ' + wallPosts().length + ' changes at start');
      const s = await rp.evaluate(survey, 'tile');
      const leds = s.leds.slice().sort((a, b) => a - b);
      assert(leds.length === 162 && leds[0] === 0 && leds[161] === 161, leds.length + ' bulbs in the tile');
      assert(/No mood on/.test(s.text), s.text);
      await H.openPanel(rp, 'moods');
      const ids = await rp.evaluate(() => [].map.call(document.querySelectorAll('#panel .md-card'), (c) => c.getAttribute('data-mood')));
      const real = realResource().moods.map((m) => m.id);
      assert(ids[0] === 'off' && ids.length === 23, ids.join());
      assert(same(ids.slice(1).sort(), real.slice().sort()), 'rail ' + ids.join());
      const hero = await rp.evaluate(() => document.querySelectorAll('#panel .md-hero [data-led]').length);
      assert(hero === 162, hero + ' bulbs in the hero');
      // The real resource tags "Pi-drawn" only where an engine can draw the mood.
      const tags = await rp.evaluate(() => { const o = {}; document.querySelectorAll('#panel .md-card').forEach((c) => { o[c.getAttribute('data-mood')] = [].map.call(c.querySelectorAll('.md-tag'), (t) => t.textContent).join('/'); }); return o; });
      assert(/Pi-drawn/.test(tags.rainforest) && /Pi-drawn/.test(tags['rainforest-storm']) && !/Pi-drawn/.test(tags.christmas) && /Approximate/.test(tags.sunset), JSON.stringify(tags));
      assert((await panelInfo(rp)).focus === 'mood:off', 'first focus');
    });

    await check('real Pi: OK on Christmas sends { id }; the wall gets exactly the golden body (pi/fixtures/moods/christmas.json); the push confirms', async () => {
      const mark = wallPosts().length;
      await goCard(rp, 'christmas');
      await H.key(rp, 'Enter');
      const got = await confirmed(rp, 'christmas', mark);
      assert(same(rp.sent, [{ id: 'christmas' }]), 'sent ' + JSON.stringify(rp.sent));
      assert(same(got, golden('christmas.json')), 'the wall got ' + JSON.stringify(got).slice(0, 200));
      assert(env.wall.calls.some((c) => c.method === 'GET' && c.path === '/json/state'), 'no snapshot read');
      const p = await panelInfo(rp);
      assert(/is on/.test(p.sub) && /On now/.test(p.chip), JSON.stringify(p));
      const now = (await env.real.api('GET', '/api/moods/now')).body;
      assert(now.id === 'christmas' && now.on === true, JSON.stringify(now));
      rp.sent.length = 0;
    });

    await check('real Pi: brightness pips send { id, bri } once; the wall gets only the new master brightness (the mood is not sent again)', async () => {
      await leftToControls(rp);
      let p = await panelInfo(rp);
      assert(p.focus === 'ctl:bri', 'focus ' + p.focus);
      const before = p.pips;
      const mark = wallPosts().length;
      await H.key(rp, before > 1 ? 'ArrowLeft' : 'ArrowRight');
      p = await panelInfo(rp);
      assert(p.pips === before + (before > 1 ? -1 : 1), 'pips ' + before + ' -> ' + p.pips);
      await H.until(() => wallPosts().length > mark, 4000, 'the wall got nothing');
      await H.sleep(600);
      assert(rp.sent.length === 1 && rp.sent[0].id === 'christmas' && typeof rp.sent[0].bri === 'number', JSON.stringify(rp.sent));
      const pct = rp.sent[0].bri;
      assert(same(wallPosts().slice(mark), [{ bri: bodiesFor('christmas', { briPct: pct })[0].bri }]), 'not the brightness alone at ' + pct + '%: ' + JSON.stringify(wallPosts().slice(mark)).slice(0, 120));
      await H.until(async () => (await env.real.api('GET', '/api/moods/now')).body.bri === pct, 3000, 'the Pi did not keep ' + pct);
      rp.sent.length = 0;
    });

    await check('real Pi: Off restores the wall as it was before the first mood (segments and preset)', async () => {
      const mark = wallPosts().length;
      await goCard(rp, 'off');
      await H.key(rp, 'Enter');
      await confirmed(rp, 'off', mark);
      assert(same(rp.sent, [{ off: true }]), JSON.stringify(rp.sent));
      const s = env.wall.state();
      assert(s.ps === W0.ps && same(s.seg.map((x) => [x.id, x.start, x.stop]), W0.seg.map((x) => [x.id, x.start, x.stop])), 'the wall is ' + JSON.stringify({ ps: s.ps, seg: s.seg.map((x) => x.id) }));
      assert(wallPosts().length > mark, 'nothing sent for Off');
      rp.sent.length = 0;
    });

    await check('real Pi: Menorah sends no night until it is stepped (tonight\'s: 8 outside Hanukkah); the stepper changes the bodies (golden nights 8 and 1); the candles follow', async () => {
      let mark = wallPosts().length;
      await goCard(rp, 'menorah');
      await H.key(rp, 'Enter');
      let got = await confirmed(rp, 'menorah', mark);
      assert(same(rp.sent, [{ id: 'menorah' }]), JSON.stringify(rp.sent));
      assert(same(got, golden('menorah-night-8.json')), 'tonight (8) is not the golden body');
      let q = await panelInfo(rp);
      assert(q.night && q.candles === 8, JSON.stringify(q));
      await leftToControls(rp);
      await H.key(rp, 'ArrowDown', 2);
      q = await panelInfo(rp);
      assert(q.focus === 'ctl:night', 'focus ' + q.focus);
      rp.sent.length = 0;
      mark = wallPosts().length;
      await H.key(rp, 'ArrowLeft');
      await H.until(() => wallPosts().length > mark, 4000, 'night 7 not sent');
      await H.sleep(400);
      got = wallPosts().slice(mark);
      assert(same(rp.sent, [{ id: 'menorah', night: 7, step: true }]), JSON.stringify(rp.sent));
      assert(same(got, bodiesFor('menorah', { night: 7 })) && !same(got, golden('menorah-night-8.json')), 'night 7 bodies');
      assert((await panelInfo(rp)).candles === 7, 'candles');
      rp.sent.length = 0;
      mark = wallPosts().length;
      await H.key(rp, 'ArrowLeft', 6);
      await H.until(async () => (await env.real.api('GET', '/api/moods/now')).body.night === 1, 5000, 'night 1 not kept');
      await H.sleep(300);
      got = wallPosts().slice(mark);
      assert(same(got.slice(-golden('menorah-night-1.json').length), golden('menorah-night-1.json')), 'night 1 is not the golden body');
      assert((await panelInfo(rp)).candles === 1, 'candles');
      rp.sent.length = 0;
    });

    await check('real Pi: changed somewhere else (the wall turned off behind the hub\'s back, seen by Ambience\'s read)', async () => {
      env.wall.set({ on: false });
      await env.real.server.ambience.poll();
      await H.until(async () => /Changed somewhere else/.test((await rp.evaluate(survey, 'tile')).text), 5000, 'no note on the tile');
      assert((await env.real.api('GET', '/api/moods/now')).body.stale === true, 'not stale on the Pi');
      env.wall.set({ on: true });
    });

    await check('real Pi: the wall stops answering: rollback with a plain line, then "isn\'t answering"; back again on the next pick', async () => {
      const before = (await panelInfo(rp)).active[0];
      env.wall.mode('down');
      await goCard(rp, 'aurora');
      await H.key(rp, 'Enter');
      await H.until(async () => /didn’t answer/.test((await panelInfo(rp)).sub), 9000, 'no plain line');
      let p = await panelInfo(rp);
      assert(p.active[0] === before && !p.pendingCards.length, JSON.stringify(p));
      await H.until(async () => /The wall isn’t answering/.test((await rp.evaluate(survey, 'tile')).text), 5000, 'the tile does not say so');
      assert((await env.real.api('GET', '/api/moods')).body.state === 'error', 'the resource is not "error"');
      env.wall.mode('ok');
      const mark = wallPosts().length;
      await H.key(rp, 'Enter');
      const got = await confirmed(rp, 'aurora', mark);
      assert(same(got, golden('aurora.json')), 'aurora is not the golden body');
      assert((await env.real.api('GET', '/api/moods')).body.state === 'ok', 'still "error"');
      const errs = H.errorsOf(rp, true);
      assert(!errs.length, errs.join(' | '));
    });
    await rp.ctx.close();

    await check('real Pi: the phone door: /touch/state carries moods; touch.html?as=phone draws the wall, a tap sends and the wall follows; Spanish refusal', async () => {
      const ts = await httpJson(env.real.port, 'GET', '/touch/state');
      assert(ts.status === 200 && ts.body.moods && ts.body.moods.data && ts.body.moods.data.moods.length === 22 && ts.body.moods.data.now.id === 'aurora', JSON.stringify(ts.body).slice(0, 200));
      const ctx = await env.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      const errors = [];
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(env.real.url + '/app/touch.html?as=phone#/moods');
      await p.waitForSelector('.mt-hero svg', { timeout: 10000 });
      const s = await p.evaluate(() => ({ wide: document.documentElement.scrollWidth, leds: document.querySelectorAll('.mt-hero [data-led]').length, name: (document.querySelector('.mt-name') || {}).textContent, cards: document.querySelectorAll('.mt-card').length }));
      assert(s.wide <= 390 && s.leds === 162 && s.name === 'Aurora' && s.cards >= 22, JSON.stringify(s));
      const mark = wallPosts().length;
      await p.click('.mt-card[data-mood="sunset"]');
      await H.until(() => p.evaluate(() => (document.querySelector('.mt-name') || {}).textContent === 'Sunset'), 6000, 'the phone did not follow');
      assert(same(wallPosts().slice(mark), golden('sunset.json')), 'sunset is not the golden body');
      await ctx.close();
      // A refusal in the phone's own words, in Spanish.
      const es = await env.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await es.addInitScript(() => { try { localStorage.setItem('homeHub.lang', 'es'); } catch (e) { /* */ } });
      const q = await es.newPage();
      await q.goto(env.real.url + '/app/touch.html?as=phone#/moods');
      await q.waitForSelector('.mt-hero svg', { timeout: 10000 });
      env.wall.mode('down');
      await q.click('.mt-card[data-mood="goodnight"]');
      await H.until(() => q.evaluate(() => (document.querySelector('.mt-note') || {}).textContent === 'La pared no respondió. No cambió nada.'), 9000, 'no Spanish line');
      env.wall.mode('ok');
      await es.close();
      assert(!errors.length, errors.join(' | '));
    });

    await check('real Pi with no WLED_URL: not set up on the tile and in the panel; the screen door says 409 and the wall hears nothing', async () => {
      const bare = await startRealPi({ page: env.PAGE, wall: env.wall, ha: env.ha, wled: false });
      try {
        const p = await openReal(bare);
        const s = await p.evaluate(survey, 'tile');
        assert(/Not set up/.test(s.text) && !s.outside.length, s.text);
        await H.openPanel(p, 'moods');
        const t = await p.evaluate(survey, 'panel');
        assert(/WLED_URL/.test(t.text) && t.leds.length === 162, t.text.slice(0, 80) + ' / ' + t.leds.length + ' bulbs');
        await p.ctx.close();
        const mark = env.wall.calls.length;
        const r = await httpJson(bare.port, 'POST', '/moods/set', { id: 'christmas' });
        assert(r.status === 409 && env.wall.calls.slice(mark).every((c) => c.method === 'GET'), r.status + ' ' + JSON.stringify(r.body));
      } finally { await bare.close(); }
    });

    await check('real Pi: no log line names the wall\'s address', () => {
      const leak = env.real.lines.filter((l) => l.indexOf(env.wall.url) >= 0 || l.indexOf(':' + env.wall.port) >= 0);
      assert(!leak.length, leak.join(' | '));
    });
  } finally {
    try { if (env.real) await env.real.close(); } catch (e) { /* ignore */ }
    try { if (env.wall) await env.wall.close(); } catch (e) { /* ignore */ }
    try { if (env.ha) await env.ha.close(); } catch (e) { /* ignore */ }
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAILED: ' + (e && e.stack)); process.exit(1); });
