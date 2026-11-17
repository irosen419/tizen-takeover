/*
 * Motion extras (app/motion.js), end to end: node dev/motion-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js),
 * the hub server from pi/ and a stand-in for Spotify (dev/mock-spotify.js),
 * all on spare ports with a fresh data folder. Nothing reaches the internet.
 * Needs Playwright (require('playwright')).
 *
 * Checks: with the switches off (motionFx: false, ?fx=off) nothing extra is
 * added, not an element, not a class; in 'fade' mode, on a TV that measured
 * slow, and after auto stepped down to expand, each motion is off (focus is
 * the plain border, items, rows, the cover and the app just show); quiet
 * waiting tiles are one small line, in English and in Spanish, with nothing
 * cut or clipped, while tiles with real data are left alone; the ring sits
 * on the focused tile, glides on a press, jumps on a held key, and is right
 * after a layout switch and a window resize; the stagger; a new to-do from
 * a sync just shows its row, nothing added; the cover's flight; the bloom.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * It cannot prove the TV: a desktop browser runs far faster.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const mockSpotify = require('./mock-spotify');
const { SPANISH: AWWS_ES } = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];
const BUILD = /var BUILD = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'hub.js'), 'utf8'))[1];

// The default layout with Weather and Now Playing swapped: the same widgets.
const SWAPPED = [
  { widget: 'today', x: 0, y: 0, w: 3, h: 1 },
  { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 },
  { widget: 'awws', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'nowplaying', x: 9, y: 0, w: 3, h: 2 },
  { widget: 'todo', x: 0, y: 1, w: 3, h: 4 },
  { widget: 'mirror', x: 9, y: 2, w: 3, h: 4 },
  { widget: 'ambiance', x: 3, y: 4, w: 6, h: 1 },
  { widget: 'weather', x: 0, y: 5, w: 3, h: 1 },
  { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
];

// Spanish for the waiting tiles (about a quarter longer than English).
const CAL_ES = {
  states: {
    off: { head: 'El calendario necesita la Raspberry Pi', short: 'Las actualizaciones en vivo están apagadas.' },
    quiet: { head: 'El calendario necesita la Raspberry Pi', short: 'Esperando al servidor del hub en la Pi.' },
    lost: { head: 'No se puede conectar con la Pi', short: 'Volviendo a intentarlo sin molestar.' },
    loading: { head: 'Cargando el calendario…' }
  }
};
const PLANNED_ES = { texts: {
  mirror: 'Un espejo con cámara para las mañanas y las salidas de noche.',
  ambiance: 'Elegir el ambiente de luz desde el televisor, sin levantarse del sofá.'
}, note: 'Todavía no está hecho. Este espacio está reservado.' };
const TODO_ES = { sub: 'En este televisor', emptyTitle: 'Todavía no hay nada en la lista.', emptyHint: 'Pulsa OK para añadir algo.' };
const SPANISH_INIT = 'window.HUB_AWWS_STRINGS = ' + JSON.stringify(AWWS_ES) + ';' +
  'window.HUB_CALENDAR_STRINGS = ' + JSON.stringify(CAL_ES) + ';' +
  'window.HUB_PLANNED_STRINGS = ' + JSON.stringify(PLANNED_ES) + ';' +
  'window.HUB_TODO_STRINGS = ' + JSON.stringify(TODO_ES) + ';';

let PAGE_PORT, PAGE, preview = null, browser = null, mock = null;
const pis = [];
const tmp = [];
const results = [];
const openContexts = new Set();

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
    await sleep(40);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

async function check(name, fn) {
  if (process.env.MOTION_GREP && name.indexOf(process.env.MOTION_GREP) < 0) return;
  const started = Date.now();
  try {
    await fn();
    results.push(true);
    console.log('ok    ' + name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    results.push(false);
    console.log('FAIL  ' + name + ': ' + (e && e.message ? e.message : e));
  }
  for (const c of Array.from(openContexts)) {
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

/* ---------- servers ---------- */

async function startPi() {
  const port = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-motion-test-'));
  tmp.push(dir);
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const h = server.start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    spotifyEnv: { SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback' },
    spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 }
  });
  await h.ready;
  const pi = { h: h, port: port, url: 'http://127.0.0.1:' + port, dir: dir };
  pis.push(pi);
  const l = h.spotify.loginUrl();
  await new Promise((resolve, reject) => {
    http.get(l.url, (res) => { res.resume(); h.spotify.finishLogin(res.headers.location || '').then(resolve, reject); }).on('error', reject);
  });
  return pi;
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

/* ---------- pages ---------- */

// o: { pi, query, config (JS appended to config.js), init (JS before the page), slow ({ mode, fps }) }
async function open(o) {
  o = o || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (BLOCKED.indexOf(u.hostname) >= 0) return route.abort();
    return route.continue();
  });
  if (o.config) {
    await context.route('**/config.js', async (route) => {
      const r = await route.fetch();
      route.fulfill({ response: r, body: (await r.text()) + '\n' + o.config + '\n' });
    });
  }
  if (o.slow) {
    await context.addInitScript((rec) => { try { localStorage.setItem('homeHub.motion', JSON.stringify(rec)); } catch (e) { /* ignore */ } },
      { mode: o.slow.mode, build: BUILD, fps: o.slow.fps });
  }
  if (o.init) await context.addInitScript(o.init);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) page.errors.push(m.text()); });
  const live = o.pi ? 'live=' + encodeURIComponent(o.pi.url) : (o.live || 'live=off');
  await page.goto(PAGE + '/hub.html?' + (o.clay ? '' : 'clay=off&') + live + (o.query ? '&' + o.query : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  if (o.pi) await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'the hub did not go live');
  await sleep(200);
  return page;
}

const fx = (page) => page.evaluate(() => window.HUB_TEST.fx());
const idle = (page) => until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
const focused = (page) => page.evaluate(() => {
  const t = document.querySelector('#grid .tile.is-focused');
  return t ? t.parentNode.getAttribute('data-widget') : null;
});

// Everything the extras could have added.
const extras = (page) => page.evaluate(() => ({
  nodes: document.querySelectorAll('.fx-ring, .fx-fly, .fx-bloom').length,
  body: document.body.className.split(' ').filter((c) => /^fx-/.test(c)),
  dormant: document.querySelectorAll('.tile.is-dormant').length
}));

function noErrors(page) { assert(!page.errors.length, 'page errors: ' + page.errors.join(' | ')); }

// Opens Entertainment and looks at its items while it grows.
async function openEntertainment(page) {
  await page.evaluate(() => {
    window.__items = [];
    const seen = [];
    const t0 = performance.now();
    (function look() {
      const items = document.querySelectorAll('.panel .ent-item');
      if (items.length) {
        const s = items[items.length - 1].style;
        const cs = getComputedStyle(items[0]);
        seen.push({ t: performance.now() - t0, opacity: items[0].style.opacity, last: s.opacity, transition: items[0].style.transition, lastTransition: s.transition,
          transform: items[0].style.transform, shownOpacity: cs.opacity, shownTransform: cs.transform });
      }
      if (performance.now() - t0 < 900) requestAnimationFrame(look);
      else window.__items = seen;
    })();
    window.HUB_TEST.openPanel('entertainment');
  });
  await sleep(1000);
  return page.evaluate(() => window.__items);
}

// Netflix, the first item, then OK: the app "opens" (the preview prints it).
async function launchFirstApp(page) {
  await until(() => page.evaluate(() => !!document.querySelector('.panel .ent-item.is-focused')), 3000, 'no focused app');
  await page.evaluate(() => {
    const first = document.querySelector('.panel .ent-item');
    first.click();
  });
}

async function postTodo(pi, title) {
  const r = await control(pi, 'POST', '/api/todo', { title: title, section: 'now' });
  assert(r.ok, 'the server refused the to-do: ' + JSON.stringify(r));
  return r.item.id;
}

/* ---------- the checks ---------- */

async function checkOff(pi) {
  for (const how of [{ query: 'fx=off' }, { config: 'HUB_CONFIG.motionFx = false;' }]) {
    const page = await open(Object.assign({ pi: pi }, how));
    await idle(page);
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) { await page.keyboard.press(k); await sleep(80); }
    let x = await extras(page);
    assert(!x.nodes && !x.body.length && !x.dormant, (how.query || 'config') + ': extras at home: ' + JSON.stringify(x));
    const items = await openEntertainment(page);
    assert(items.length && items.every((s) => !s.opacity && !s.transform), 'items were moved: ' + JSON.stringify(items.slice(0, 2)));
    await launchFirstApp(page);
    await sleep(200);
    x = await extras(page);
    assert(!x.nodes, 'a bloom: ' + JSON.stringify(x));
    await page.keyboard.press('Escape');
    await idle(page);
    await sleep(300);
    await postTodo(pi, 'Off check ' + Date.now());
    await until(() => page.evaluate(() => document.querySelectorAll('.todo-tile-row').length > 0), 4000, 'the to-do did not arrive');
    await sleep(400);
    x = await extras(page);
    assert(!x.nodes && !x.body.length && !x.dormant, 'extras after a new to-do: ' + JSON.stringify(x));
    const about = await page.evaluate(() => { window.HUB_TEST.about.open(); const r = window.HUB_TEST.about.rows().filter((r) => r.label === 'Motion')[0]; window.HUB_TEST.about.close(); return r && r.value; });
    assert(about && !/extras/.test(about), 'About Motion row: ' + about);
    noErrors(page);
    await page.context().close();
  }
}

async function checkDisabled(pi) {
  const cases = [
    { name: 'fade', o: { query: 'motion=fade' }, why: 'fade' },
    { name: 'measured slow (24 fps)', o: { slow: { mode: 'push', fps: 24 } }, why: 'slow' },
    { name: 'auto stepped down to expand', o: { slow: { mode: 'expand', fps: 52 } }, why: 'slow' }
  ];
  for (const c of cases) {
    const page = await open(Object.assign({ pi: pi }, c.o));
    await idle(page);
    const st = await fx(page);
    assert(st.speed === c.why, c.name + ': speed ' + st.speed);
    // Ring: the plain border swap.
    await page.keyboard.press('ArrowLeft');
    await sleep(60);
    let x = await extras(page);
    assert(!x.nodes, c.name + ': a ring: ' + JSON.stringify(x));
    const border = await page.evaluate(() => getComputedStyle(document.querySelector('#grid .tile.is-focused')).borderTopColor);
    assert(/255, 255, 255(, 1)?\)/.test(border), c.name + ': the focused tile lost its border: ' + border);
    await page.keyboard.press('ArrowRight');
    // Stagger: items just show.
    const items = await openEntertainment(page);
    assert(items.length && items.every((s) => !s.opacity && !s.transform), c.name + ': items moved: ' + JSON.stringify(items[0]));
    // Bloom: nothing.
    await launchFirstApp(page);
    await sleep(150);
    x = await extras(page);
    assert(!x.nodes, c.name + ': a bloom: ' + JSON.stringify(x));
    await page.keyboard.press('Escape');
    await idle(page);
    await sleep(300);
    // A new to-do: the row just shows.
    const id = await postTodo(pi, 'Slow ' + c.name);
    await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
    await sleep(100);
    const row = await page.evaluate((i) => { const r = document.querySelector('.todo-tile-row[data-id="' + i + '"]'); return { o: r.style.opacity, t: r.style.transform }; }, id);
    x = await extras(page);
    assert(!x.nodes && !row.o && !row.t, c.name + ': the new row moved: ' + JSON.stringify({ x, row }));
    // Cover: no flight to the card.
    await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await idle(page);
    await until(() => page.evaluate(() => !!document.querySelector('.panel .np-page [data-share]')), 4000, 'no cover on the page');
    await page.evaluate(() => { document.querySelector('.panel-btn').click(); });
    await sleep(120);
    x = await extras(page);
    assert(!x.nodes, c.name + ': the cover flew: ' + JSON.stringify(x));
    await idle(page);
    const about = await page.evaluate(() => { window.HUB_TEST.about.close(); return true; });
    assert(about, 'about');
    noErrors(page);
    await page.context().close();
  }
}

async function checkQuiet(pi) {
  for (const lang of ['en', 'es']) {
    // The Pi can't be reached (config.js's address is blocked here): waiting tiles.
    const page = await open({ live: 'x=1', init: lang === 'es' ? SPANISH_INIT : undefined });
    await sleep(600);
    const info = await page.evaluate(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const out = { dormant: [], loud: [], problems: [] };
      document.querySelectorAll('#grid .cell').forEach((cell) => {
        const id = cell.getAttribute('data-widget');
        const tile = cell.querySelector('.tile');
        (tile.classList.contains('is-dormant') ? out.dormant : out.loud).push(id);
        if (!tile.classList.contains('is-dormant')) return;
        const body = tile.querySelector('.tile-body');
        const T = tile.getBoundingClientRect();
        body.querySelectorAll('*').forEach((e) => {
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height || cs.visibility === 'hidden') return;
          const own = Array.prototype.some.call(e.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
          if (/(cal|aw|planned)-mark|np-art/.test(e.className) && !/is-solo/.test(e.className)) out.problems.push(id + ': a big mark shows (' + e.className + ')');
          if (!own) return;
          const fs = parseFloat(cs.fontSize);
          const lh = parseFloat(cs.lineHeight) / fs;
          if (fs > 1.05 * rem) out.problems.push(id + ': text ' + (fs / rem).toFixed(2) + 'rem: ' + e.textContent.slice(0, 30));
          if (fs < 0.85 * rem - 0.05) out.problems.push(id + ': text too small ' + (fs / rem).toFixed(2) + 'rem');
          if (lh < 1.25) out.problems.push(id + ': line height ' + lh.toFixed(2));
          if (/hub-quiet-line|planned-text/.test(e.className)) {
            if (r.height > fs * 1.9) out.problems.push(id + ': more than one line (' + Math.round(r.height) + ' px)');
            if (cs.textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 1) out.problems.push(id + ': cut without "…"');
            // Room for accents: the line box is at least the line height, and the glyphs sit inside the tile.
            if (e.clientHeight + 0.5 < parseFloat(cs.lineHeight)) out.problems.push(id + ': the line box is shorter than its line height');
          }
          if (r.left < T.left - 1 || r.right > T.right + 1 || r.top < T.top - 1 || r.bottom > T.bottom + 1) out.problems.push(id + ': sticks out of the tile');
        });
      });
      return out;
    });
    const want = ['ambiance', 'awws', 'calendar', 'mirror', 'nowplaying'];
    assert(JSON.stringify(info.dormant.sort()) === JSON.stringify(want), lang + ': quiet tiles ' + JSON.stringify(info.dormant));
    assert(!info.problems.length, lang + ': ' + info.problems.join(' | '));
    if (lang === 'es') {
      const t = await page.evaluate(() => document.querySelector('.cell[data-widget="calendar"] .hub-quiet-line').textContent);
      assert(/Raspberry/.test(t), 'the Spanish words did not reach the calendar: ' + t);
    }
    noErrors(page);
    await page.context().close();
  }
  // With the Pi: tiles with real data are not quiet.
  const page = await open({ pi: pi });
  await until(() => page.evaluate(() => {
    const t = document.querySelector('.cell[data-widget="nowplaying"] .tile');
    return t && !t.classList.contains('is-dormant');
  }), 6000, 'Now Playing stayed quiet with a song');
  const d = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.tile.is-dormant'), (t) => t.parentNode.getAttribute('data-widget')).sort());
  assert(JSON.stringify(d) === JSON.stringify(['ambiance', 'mirror']) || JSON.stringify(d) === JSON.stringify(['ambiance', 'calendar', 'mirror']) ||
    JSON.stringify(d) === JSON.stringify(['ambiance', 'awws', 'calendar', 'mirror']) || JSON.stringify(d) === JSON.stringify(['ambiance', 'awws', 'mirror']),
    'quiet with the Pi: ' + JSON.stringify(d));
  noErrors(page);
}

async function ringRect(page) {
  return page.evaluate(() => {
    const r = document.querySelector('.fx-ring');
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height, transition: r.style.transition, opacity: getComputedStyle(r).opacity };
  });
}

function same(a, b, slack) {
  slack = slack || 1;
  return !!a && !!b && Math.abs(a.left - b.left) <= slack && Math.abs(a.top - b.top) <= slack &&
    Math.abs(a.width - b.width) <= slack && Math.abs(a.height - b.height) <= slack;
}

async function checkRing(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  let r = await ringRect(page);
  let want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(same(r, want), 'the ring is not on the focused tile at start: ' + JSON.stringify({ r, want }));
  const border = await page.evaluate(() => getComputedStyle(document.querySelector('#grid .tile.is-focused')).borderTopColor);
  assert(!/^rgb\(255, 255, 255\)$/.test(border), 'the tile still draws its own white border under the ring: ' + border);
  // A press glides (190 ms), ending on the new tile.
  await page.keyboard.press('ArrowLeft');
  r = await ringRect(page);
  assert(/transform 190ms/.test(r.transition), 'no glide: ' + r.transition);
  await sleep(320);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert((await focused(page)) === 'nowplaying' && same(r, want), 'after the glide: ' + JSON.stringify({ r, want }));
  // A held key jumps (no motion for repeats).
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.up('ArrowUp');
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(r.transition === 'none' && same(r, want), 'a held key glided: ' + JSON.stringify({ r, want }));
  // Back to Entertainment, then the layout switches under it.
  await page.evaluate(() => { const t = document.querySelector('.cell[data-widget="entertainment"] .tile'); t.click(); });
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  await sleep(100);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(r && r.opacity === '1' && same(r, want), 'the ring after a panel: ' + JSON.stringify({ r, want }));
  await control(pi, 'POST', '/api/layout', { layout: SWAPPED });
  await until(() => page.evaluate(() => window.HUB_TEST.homeRects().weather.left < 200), 4000, 'the layout did not switch');
  await sleep(80);
  await page.keyboard.press('ArrowLeft');
  await sleep(320);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.homeRects().weather);
  assert((await focused(page)) === 'weather' && same(r, want), 'the ring after the layout switch: ' + JSON.stringify({ r, want }));
  // The window changes size: the ring follows the tile.
  await page.setViewportSize({ width: 1280, height: 720 });
  await sleep(450);
  r = await ringRect(page);
  want = await page.evaluate(() => window.HUB_TEST.focusRect());
  assert(want.width < 600 && same(r, want), 'the ring after a resize: ' + JSON.stringify({ r, want }));
  await control(pi, 'POST', '/api/layout', { layout: null });
  noErrors(page);
}

async function checkStagger(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  const seen = await openEntertainment(page);
  assert(seen.length > 5, 'too few samples');
  const first = seen[0];
  assert(parseFloat(first.shownOpacity) < 0.05, 'the first item was not hidden at the start: ' + JSON.stringify(first));
  // From the tile's side: Entertainment sits below the panel, so the items rise from 50px lower.
  const rise = /^matrix\(0\.85, 0, 0, 0\.85, 0, 50\)$/.test(first.shownTransform);
  assert(rise, 'the items do not come from below: ' + JSON.stringify(seen.slice(0, 2)));
  const any = seen.some((s) => /ms/.test(s.lastTransition || ''));
  assert(any, 'no transitions on the items: ' + JSON.stringify(seen.slice(0, 3)));
  const last = await page.evaluate(() => {
    const items = document.querySelectorAll('.panel .ent-item');
    return { n: items.length, styled: Array.prototype.filter.call(items, (i) => i.style.transition || i.style.opacity || i.style.transform).length };
  });
  assert(last.styled === 0, 'items still styled after 1 s: ' + JSON.stringify(last));
  // The longest delay keeps the whole stagger within 500 ms.
  const delayOf = (t) => { const m = /transform 260ms cubic-bezier\([^)]*\) ([\d.]+)ms/.exec(t || ''); return m ? parseFloat(m[1]) : 0; };
  const minDelay = delayOf(seen[0].transition);
  const maxDelay = Math.max.apply(null, seen.map((s) => {
    const m = /transform 260ms cubic-bezier\([^)]*\) ([\d.]+)ms/.exec(s.lastTransition || '');
    return m ? parseFloat(m[1]) : 0;
  }));
  // From the first item starting to the last one in: at most 500 ms.
  assert(maxDelay > minDelay && maxDelay - minDelay + 260 <= 500, 'the stagger runs long: delays ' + minDelay + ' to ' + maxDelay + ' ' + JSON.stringify(seen.slice(0, 2)));
  noErrors(page);
}

async function checkNewTodo(pi) {
  // A to-do that a sync brings just shows its row: no element, class or style is added.
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await sleep(300);
  const look = () => page.evaluate(() => ({
    fx: Array.prototype.map.call(document.querySelectorAll('[class*="fx-"]'), (n) => n.className).sort().join(' | '),
    tile: document.querySelector('.cell[data-widget="todo"] .tile').className,
    styles: document.querySelectorAll('style').length
  }));
  const before = await look();
  const id = await postTodo(pi, 'Write to the library ' + Date.now());
  await until(() => page.evaluate((i) => !!document.querySelector('.todo-tile-row[data-id="' + i + '"]'), id), 4000, 'the to-do did not arrive');
  for (let k = 0; k < 6; k++) {
    const row = await page.evaluate((i) => { const r = document.querySelector('.todo-tile-row[data-id="' + i + '"]'); return { o: r.style.opacity, t: r.style.transform, tr: r.style.transition }; }, id);
    assert(!row.o && !row.t && !row.tr, 'the new row moved: ' + JSON.stringify(row));
    await sleep(120);
  }
  const after = await look();
  assert(after.fx === before.fx && after.tile === before.tile && after.styles === before.styles, 'something was added: ' + JSON.stringify({ before, after }));
  noErrors(page);
}

async function checkCover(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
  await idle(page);
  await until(() => page.evaluate(() => !!document.querySelector('.panel .np-page [data-share]')), 5000, 'no cover on the page');
  await page.evaluate(() => { document.querySelector('.panel-btn').click(); });
  await until(() => page.evaluate(() => !!document.querySelector('.fx-fly')), 1500, 'the cover did not fly');
  const mid = await page.evaluate(() => {
    const f = document.querySelector('.fx-fly');
    const d = document.querySelector('.panel [data-share]');
    return { t: f.style.transition, hidden: d && d.style.visibility, compact: !!document.querySelector('.np-card') };
  });
  assert(/transform 520ms/.test(mid.t) && mid.hidden === 'hidden', 'flight: ' + JSON.stringify(mid));
  await sleep(700);
  const after = await page.evaluate(() => {
    const d = document.querySelector('.panel [data-share]');
    const r = d.getBoundingClientRect();
    return { fly: !!document.querySelector('.fx-fly'), vis: d.style.visibility, left: r.left, top: r.top };
  });
  assert(!after.fly && after.vis === '' && after.left < 400 && after.top < 400, 'after the flight: ' + JSON.stringify(after));
  // And back.
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => !!document.querySelector('.fx-fly')), 1500, 'the cover did not fly back');
  const back = await page.evaluate(() => document.querySelector('.fx-fly').style.transition);
  assert(/transform 420ms/.test(back), 'back: ' + back);
  await sleep(600);
  assert(!(await page.evaluate(() => !!document.querySelector('.fx-fly'))), 'the copy stayed');
  noErrors(page);
}

async function checkBloom(pi) {
  const page = await open({ pi: pi, query: 'motion=push' });
  await idle(page);
  await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
  await idle(page);
  await sleep(600);
  await launchFirstApp(page);
  await sleep(30);
  const b = await page.evaluate(() => {
    const n = document.querySelector('.fx-bloom');
    if (!n) return null;
    const m = /scale\(([\d.]+)/.exec(n.style.transform);
    return { k: m ? parseFloat(m[1]) : 0, t: n.style.transition };
  });
  assert(b && b.k > 8 && /transform 480ms/.test(b.t), 'bloom: ' + JSON.stringify(b));
  await sleep(600);
  const cover = await page.evaluate(() => {
    const r = document.querySelector('.fx-bloom').getBoundingClientRect();
    return r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight;
  });
  assert(cover, 'the bloom does not cover the screen');
  await until(() => page.evaluate(() => !document.querySelector('.fx-bloom')), 4500, 'the bloom stayed');
  // An app that isn't on this TV (Peacock in the preview): no bloom.
  await page.evaluate(() => {
    const items = document.querySelectorAll('.panel .ent-item.is-missing');
    if (items[0]) items[0].click();
  });
  await sleep(100);
  assert(!(await page.evaluate(() => !!document.querySelector('.fx-bloom'))), 'a missing app bloomed');
  noErrors(page);
}

/* ---------- run ---------- */

async function main() {
  PAGE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  mock = await mockSpotify.start({});
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PAGE_PORT, path: '/', timeout: 500 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  browser = await chromium.launch();
  const pi = await startPi();

  await check('1. Switches off (?fx=off, motionFx: false): no extra element or class, ever', () => checkOff(pi));
  await check('2. Fade mode, a slow TV and auto stepped down: every motion is off', () => checkDisabled(pi));
  await check('3. Waiting tiles are one quiet line, in English and Spanish; real data stays', () => checkQuiet(pi));
  await check('4. The ring: on the focused tile, glides, jumps on a held key, right after a layout switch and a resize', () => checkRing(pi));
  await check('5. Stagger: the items arrive from the tile side, all in within about 500 ms', () => checkStagger(pi));
  await check('6. A new to-do from a sync just shows its row, nothing added', () => checkNewTodo(pi));
  await check('7. Cover: flies to the full-screen card and back', () => checkCover(pi));
  await check('8. Bloom: an app\'s icon fills the screen, and goes again', () => checkBloom(pi));
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  for (const pi of pis) await new Promise((r) => pi.h.close(() => r()));
  try { if (mock) await mock.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
  for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
