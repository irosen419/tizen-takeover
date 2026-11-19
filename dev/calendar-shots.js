/*
 * Screenshots of the Calendar widget: node dev/calendar-shots.js
 *
 * Runs the preview (dev/preview.js, without its own hub server), the Pi's
 * real hub server reading the sample calendars (dev/calendar-sample.js), and
 * headless Chromium at 1920x1080 with the clock fixed at Sunday 15 November
 * 2026, 10:40 AM in Chicago. Writes docs/screenshots/calendar-*.jpg (whole
 * screen) and calendar-*-tile.png (the tile alone): the home screen, the
 * panel in each view, full screen, and every state. It also checks a few
 * things on the way (keys, selection kept across a live change, no console
 * errors) and exits 1 if one fails. Needs Playwright and port 8095 free.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const sample = require('./calendar-sample');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const TOKEN = 'preview-token-not-a-secret-000000';
const MORNING = Date.parse('2026-11-15T16:40:00Z');   // 10:40 AM in Chicago
const EVENING = Date.parse('2026-11-16T03:00:00Z');   // 9:00 PM in Chicago
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', '192.168.1.219'];

let PAGE_PORT, LIVE_PORT, PAGE, LIVE, DEAD;
let preview = null;
let pi = null;
let feeds = null;
let browser = null;
let fixedNow = MORNING;
const problems = [];
const written = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    await sleep(100);
  }
  throw new Error(text);
}

function expect(cond, text) {
  if (!cond) { problems.push(text); console.log('PROBLEM ' + text); }
}

function control(method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: LIVE_PORT, path: route, method: method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function feedMode(mode) {
  feeds.setMode(mode);
  await control('POST', '/api/calendar/refresh', {});
}

/* ---------- servers ---------- */

async function startAll() {
  PAGE_PORT = await spare();
  LIVE_PORT = await spare();
  DEAD = 'http://127.0.0.1:' + (await spare());
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  LIVE = 'http://127.0.0.1:' + LIVE_PORT;
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  feeds = await sample.feedServer({ today: () => sample.chicagoToday(fixedNow) });
  pi = require(path.join(ROOT, 'pi', 'server.js')).start({
    token: TOKEN, port: LIVE_PORT, host: '127.0.0.1', origins: [PAGE], log: false,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cal-shots-')),
    calendars: feeds.calendars, allowHttp: true, timezone: sample.TZ, now: () => new Date(fixedNow)
  });
  await pi.ready;
  await until(async () => {
    const d = (await control('GET', '/api/calendar'));
    return d && d.ok !== false && JSON.stringify(d).indexOf('Grandma') > 0;
  }, 10000, 'the hub server did not read the sample calendars');
  await until(() => new Promise((resolve) => {
    http.get(PAGE + '/', (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
}

async function stopAll() {
  if (browser) await browser.close().catch(() => {});
  if (pi) await new Promise((r) => pi.close(r));
  if (feeds) await feeds.close();
  if (preview) preview.kill();
}

/* ---------- pages ---------- */

// opts: { live: address | 'off', at, storage: {key: value}, stretch, route(context) }
async function openHub(opts) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: opts.tvZone || sample.TZ });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const host = new URL(route.request().url()).hostname;
    if (BLOCKED.indexOf(host) >= 0) return route.abort();
    return route.fallback();
  });
  if (opts.route) await opts.route(context);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push(String(e)));
  await page.clock.setFixedTime(new Date(opts.at || MORNING));
  if (opts.storage) {
    await page.addInitScript((items) => {
      try { for (const k in items) localStorage.setItem(k, items[k]); } catch (e) { /* ignore */ }
    }, opts.storage);
  }
  if (opts.stretch) await page.addInitScript(stretchStrings);
  const live = opts.live === undefined ? LIVE : opts.live;
  await page.goto(PAGE + '/?motion=push&live=' + encodeURIComponent(live));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="calendar"] .tile-body'));
  page.context_ = context;
  return page;
}

// Pseudo-translation: every label a quarter longer, with accents on top.
function stretchStrings() {
  const MAP = { a: 'á', e: 'é', i: 'í', o: 'ö', u: 'ü', n: 'ñ', A: 'Á', E: 'É', O: 'Ö', N: 'Ñ', c: 'ç' };
  function stretch(s) {
    if (typeof s !== 'string') return s;
    const parts = s.split(/(\{\w+\})/);
    const body = parts.map((p) => (/^\{\w+\}$/.test(p) ? p : p.replace(/[aeiounAEONc]/g, (ch) => MAP[ch] || ch))).join('');
    const extra = Math.ceil(s.length * 0.25);
    return body + (extra > 0 ? ' ' + 'ẃ'.repeat(Math.max(1, extra - 1)) : '');
  }
  function walk(o) {
    for (const k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (typeof o[k] === 'string') o[k] = stretch(o[k]);
      else if (o[k] && typeof o[k] === 'object') walk(o[k]);
    }
  }
  let held;
  Object.defineProperty(window, 'HUB_CALENDAR_TEST', {
    configurable: true,
    get: () => held,
    set: (v) => { held = v; try { walk(v.STRINGS); } catch (e) { /* ignore */ } }
  });
}

async function liveState(page) {
  return page.evaluate(() => (window.HUB_LIVE ? window.HUB_LIVE.status().state : 'none'));
}

async function waitTile(page, text) {
  await until(() => page.evaluate((t) => {
    const b = document.querySelector('.cell[data-widget="calendar"] .tile-body');
    return !!b && b.textContent.indexOf(t) >= 0;
  }, text), 15000, 'the tile never showed "' + text + '"');
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) {
    await page.keyboard.press(k);
    await sleep(60);
  }
}

function focusedKey(page) {
  return page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || f.className : ''; });
}

// Up until a tab has focus (never past it, so the hub's button isn't reached).
async function toTabs(page) {
  for (let i = 0; i < 12; i++) {
    const k = await focusedKey(page);
    if (/^tab-|^today$/.test(k)) return k;
    await key(page, 'ArrowUp');
  }
  return focusedKey(page);
}

async function idle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(250);
}

async function focusCalendarTile(page) {
  for (let i = 0; i < 6; i++) {
    const on = await page.evaluate(() => !!document.querySelector('.cell[data-widget="calendar"] .tile.is-focused'));
    if (on) return;
    const at = await page.evaluate(() => {
      const f = document.querySelector('.tile.is-focused');
      return f ? f.parentNode.getAttribute('data-widget') : '';
    });
    // Ian's layout (app/config.js): the calendar is top left of centre, with
    // Ambiance and Entertainment below it, the clock and the to-do list to its left.
    await key(page, at === 'entertainment' || at === 'ambiance' || at === 'nowplaying' ? 'ArrowUp' :
      at === 'weather' || at === 'awws' || at === 'mirror' ? 'ArrowLeft' : 'ArrowRight');
  }
  const on = await page.evaluate(() => !!document.querySelector('.cell[data-widget="calendar"] .tile.is-focused'));
  expect(on, 'could not focus the calendar tile with the arrows');
}

async function openPanel(page) {
  await focusCalendarTile(page);
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'calendar'), 5000, 'the panel did not open');
  await idle(page);
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.jpg');
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  written.push(file);
}

async function tileShot(page, name) {
  const box = await page.locator('.cell[data-widget="calendar"]').boundingBox();
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  written.push(file);
}

async function done(page, label, allowNetwork) {
  // ERR_FAILED is the weather services this script blocks.
  const errs = page.context_.errors.filter((e) => !/net::ERR_FAILED/.test(e) &&
    !(allowNetwork && /Failed to load resource|ERR_CONNECTION_REFUSED|Live: /.test(e)));
  expect(!errs.length, label + ': console errors: ' + errs.join(' | '));
  await page.context_.close();
}

function selected(page) {
  return page.evaluate(() => {
    const s = document.querySelector('#panel .cal-ev.is-sel .cal-ev-title, #panel .cal-chip.is-sel, #panel .cal-wev.is-sel .cal-wev-title');
    return s ? s.textContent : '';
  });
}

function label(page) {
  return page.evaluate(() => (document.querySelector('#panel .cal-label') || {}).textContent || '');
}

/* ---------- the shots ---------- */

async function mainShots() {
  const page = await openHub({});
  await waitTile(page, 'Call with the contractor');
  await focusCalendarTile(page);
  await sleep(300);
  await shot(page, 'calendar-1-home');
  await tileShot(page, 'calendar-1-home-tile');

  await openPanel(page);
  const swatches = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cal-legend .cal-swatch'), (n) => getComputedStyle(n).backgroundColor));
  expect(swatches.length === 4 && swatches[2] === 'rgb(255, 107, 107)' && swatches[0] === 'rgb(124, 196, 255)',
    'COLOR from the Pi wins (Work is red), the others keep the palette: ' + JSON.stringify(swatches));
  expect((await selected(page)) === 'Call with the contractor', 'Day opens on the event happening now, got "' + (await selected(page)) + '"');
  await shot(page, 'calendar-2-day');

  await key(page, 'ArrowDown', 2);
  expect((await selected(page)) === 'Lunch with Ángel and Sofía', 'Down twice picks lunch, got "' + (await selected(page)) + '"');
  await shot(page, 'calendar-3-day-lunch');

  // A live change (a calendar fails, the events stay) keeps the chosen event.
  await feedMode('partial');
  await until(() => page.evaluate(() => /couldn/.test((document.querySelector('#panel .cal-foot') || {}).textContent || '')), 8000,
    'the panel did not show the failed calendar');
  expect((await selected(page)) === 'Lunch with Ángel and Sofía', 'a live change kept the chosen event, got "' + (await selected(page)) + '"');
  await feedMode('sample');
  await until(() => page.evaluate(() => !/couldn/.test((document.querySelector('#panel .cal-foot') || {}).textContent || '')), 8000,
    'the failed calendar note did not go');

  await key(page, 'ArrowRight');
  expect(/Tomorrow/.test(await label(page)), 'Right moves to tomorrow, label "' + (await label(page)) + '"');
  await shot(page, 'calendar-4-day-tomorrow');
  await key(page, 'ArrowLeft');

  // Up from the first event reaches the tabs; Right on the tabs shows Week.
  const onTab = await toTabs(page);
  expect(onTab === 'tab-day', 'Up from the first event reaches the Day tab, got ' + onTab);
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  await shot(page, 'calendar-5-week');
  await key(page, 'ArrowRight', 2);
  await key(page, 'ArrowDown');
  await shot(page, 'calendar-6-week-tuesday');

  await toTabs(page);
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  await shot(page, 'calendar-7-month');
  // Enter opens that day in Day view.
  await key(page, 'Enter');
  const view = await page.evaluate(() => (document.querySelector('#panel .cal-tab.is-selected') || {}).getAttribute('data-key'));
  expect(view === 'tab-day', 'OK on Month opens the Day, got ' + view);

  // Full screen: Up to the tabs, Up to the hub's button, OK.
  await toTabs(page);
  await key(page, 'ArrowUp');
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'full screen did not open');
  await idle(page);
  await key(page, 'ArrowDown');   // to the Day tab
  await key(page, 'ArrowLeft');
  expect((await focusedKey(page)) === 'today', 'Left from the Day tab reaches Today');
  await key(page, 'Enter');       // back to today
  await key(page, 'ArrowDown');   // into the calendar
  await shot(page, 'calendar-8-full-day');
  await toTabs(page);
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  await shot(page, 'calendar-9-full-week');
  await toTabs(page);
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  await shot(page, 'calendar-10-full-month');

  // Back shrinks, Back closes, focus returns to the tile.
  await key(page, 'Escape');
  await idle(page);
  await key(page, 'Escape');
  await idle(page);
  const back = await page.evaluate(() => !!document.querySelector('.cell[data-widget="calendar"] .tile.is-focused') && !window.HUB_TEST.open());
  expect(back, 'Back twice closes and leaves focus on the tile');
  await done(page, 'main');
}

async function stateShots() {
  // Evening: nothing left today, so the tile names what's next.
  fixedNow = EVENING;
  await control('POST', '/api/calendar/refresh', {});
  let page = await openHub({ at: EVENING });
  await waitTile(page, 'Next');
  await tileShot(page, 'calendar-state-evening-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-evening-panel');
  await done(page, 'evening');
  fixedNow = MORNING;
  await control('POST', '/api/calendar/refresh', {});

  // Longer words (+25%, with accents) everywhere.
  page = await openHub({ stretch: true });
  await waitTile(page, 'Call with');
  await tileShot(page, 'calendar-state-long-text-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-long-text-day');
  await toTabs(page);
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  await key(page, 'ArrowRight', 4);
  await shot(page, 'calendar-state-long-text-week');
  await done(page, 'long text');

  // Live updates off.
  page = await openHub({ live: 'off' });
  await waitTile(page, 'Calendar needs the Pi');
  await tileShot(page, 'calendar-state-off-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-off-panel');
  await done(page, 'off');

  // Never reached the Pi.
  page = await openHub({ live: DEAD });
  await until(async () => (await liveState(page)) === 'quiet', 10000, 'never reached: state did not become quiet');
  await waitTile(page, 'Calendar needs the Pi');
  await tileShot(page, 'calendar-state-never-reached-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-never-reached-panel');
  await done(page, 'never reached', true);

  // Loading: the Pi hasn't answered yet.
  page = await openHub({ route: (c) => c.route('**/live/state', () => { /* never answers */ }) });
  await waitTile(page, 'Loading');
  await tileShot(page, 'calendar-state-loading-tile');
  await done(page, 'loading', true);

  // Connected, no calendars set up.
  page = await openHub({ route: (c) => fakeState(c, () => ({ configured: false, calendars: [], events: [] })) });
  await waitTile(page, 'No calendars set up yet');
  await tileShot(page, 'calendar-state-not-set-up-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-not-set-up-panel');
  await done(page, 'not set up', true);

  // Connected, nothing in the calendars.
  await feedMode('empty');
  page = await openHub({});
  await waitTile(page, 'Nothing coming up');
  await tileShot(page, 'calendar-state-nothing-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-nothing-panel');
  await done(page, 'nothing');

  // One calendar can't be read.
  await feedMode('partial');
  page = await openHub({});
  await waitTile(page, 'couldn');
  await tileShot(page, 'calendar-state-calendar-error-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-calendar-error-panel');
  await done(page, 'calendar error');

  // More than 500 events.
  await feedMode('many');
  page = await openHub({});
  await waitTile(page, 'Slot');
  await openPanel(page);
  await until(() => page.evaluate(() => /first 500/.test(document.querySelector('#panel').textContent)), 5000, 'no "first 500" note');
  await shot(page, 'calendar-state-truncated-panel');
  await done(page, 'truncated');
  await feedMode('sample');

  // Stale: the TV's saved copy, the Pi gone since 7:40 AM.
  const snap = await control('GET', '/api/calendar');
  const data = snap.data || snap;
  data.updatedAt = '2026-11-15T13:40:00Z';
  const at = Date.parse('2026-11-15T13:40:00Z');
  page = await openHub({ live: DEAD, storage: { 'homeHub.live.seen': '1', 'homeHub.calendar.v1': JSON.stringify({ v: 1, at: at, data: data }) } });
  await until(async () => (await liveState(page)) === 'lost', 10000, 'stale: state did not become lost');
  await waitTile(page, 'Last updated');
  await tileShot(page, 'calendar-state-stale-tile');
  await openPanel(page);
  await shot(page, 'calendar-state-stale-panel');
  await done(page, 'stale', true);

  // Lost the Pi, nothing saved.
  page = await openHub({ live: DEAD, storage: { 'homeHub.live.seen': '1' } });
  await waitTile(page, 'reach the Pi');
  await tileShot(page, 'calendar-state-lost-tile');
  await done(page, 'lost', true);

  // The Pi refuses this TV.
  page = await openHub({ route: (c) => c.route('**/live/state', (r) => r.fulfill({ status: 403, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': PAGE }, body: JSON.stringify({ ok: false, error: 'screen not allowed' }) })) });
  await waitTile(page, 'refused');
  await tileShot(page, 'calendar-state-refused-tile');
  await done(page, 'refused', true);
}

// Serves /live/state with the calendar replaced, and keeps the push line quiet.
async function fakeState(context, make) {
  await context.route('**/live/state', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.resources.calendar = { rev: body.rev, data: make(body.resources.calendar.data) };
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await context.route('**/live/events', () => { /* never answers */ });
}

/* ---------- notes: reading an event's notes ---------- */

// Spanish for the notes lines, as the Pi's translator would give them, so
// the shots need no Gemini key (app/i18n-dyn.js keeps these in homeHub.tr.es).
const ES_NOTES = {
  'Water plants': 'Regar las plantas',
  'Library visit': 'Visita a la biblioteca',
  'Call with the contractor': 'Llamada con el contratista',
  'Ask about': 'Preguntar por',
  'the kitchen tile and the this': 'el azulejo de la cocina y esto',
  'Bring the paint chips. Join:': 'Lleva las muestras de pintura. Únete:',
  'Check each plant with a finger in the soil first. Water slowly until it drains, then empty the saucer so roots never sit in water. Winter light is low, so they drink less until March.':
    'Primero revisa cada planta con un dedo en la tierra. Riega despacio hasta que drene y luego vacía el plato para que las raíces nunca queden en agua. En invierno hay poca luz, así que beben menos hasta marzo.',
  'Gold Lines maranta': 'Maranta Gold Lines',
  'Water when the top inch is dry, usually every week. Keep it evenly moist but never soggy. Use filtered water or tap water left out overnight, since it browns from chlorine and fluoride. Mist the leaves or keep it near a humidifier.':
    'Riégala cuando la primera pulgada esté seca, casi siempre cada semana. Mantenla húmeda de forma pareja, nunca empapada. Usa agua filtrada o agua del grifo reposada toda la noche, porque el cloro y el flúor la ponen café. Rocía las hojas o tenla cerca de un humidificador.',
  'Birkin philodendron': 'Filodendro Birkin',
  'Water when the top 1 to 2 inches are dry, usually every 7 to 10 days in winter. Yellow leaves mean too much water. Wipe dust off the leaves once a month.':
    'Riégalo cuando las primeras 1 o 2 pulgadas estén secas, casi siempre cada 7 a 10 días en invierno. Las hojas amarillas indican exceso de agua. Limpia el polvo de las hojas una vez al mes.',
  'Golden pothos': 'Potos dorado',
  'Water only when the top half of the soil is dry, usually every other week in winter. Drooping, soft leaves mean it is thirsty. It handles drying out better than overwatering.':
    'Riégalo solo cuando la mitad superior de la tierra esté seca, casi siempre cada dos semanas en invierno. Las hojas caídas y blandas indican que tiene sed. Aguanta mejor la sequía que el exceso de riego.',
  'Cuttings in the glass wall vases': 'Esquejes en los floreros de vidrio de la pared',
  'Top up the water weekly and swap it out fully every two weeks.': 'Rellena el agua cada semana y cámbiala por completo cada dos semanas.',
  "Keep the Birkin and pothos out of Ember's reach, since both are toxic to dogs.": 'Mantén el Birkin y el potos fuera del alcance de Ember, porque ambos son tóxicos para los perros.'
};

function readingNow(page) {
  return page.evaluate(() => !!document.querySelector('#panel .cal-day.is-reading'));
}

async function notesShots(lang) {
  const tag = lang === 'es' ? '-es' : '';
  const storage = lang === 'es' ? { 'homeHub.lang': 'es', 'homeHub.tr.es': JSON.stringify(ES_NOTES) } : {};
  const page = await openHub({ storage: storage });
  await waitTile(page, lang === 'es' ? 'Llamada con el contratista' : 'Call with the contractor');
  await focusCalendarTile(page);
  await sleep(300);
  const marks = await page.evaluate(() => document.querySelectorAll('.cell[data-widget="calendar"] .cal-has-notes').length);
  expect(marks === 1, lang + ': the tile marks the one event today with notes, got ' + marks);
  const g1 = lang === 'es' ? '1 invitado' : '1 guest';
  const g3 = lang === 'es' ? '3 invitados' : '3 guests';
  const tileText = await page.evaluate(() => document.querySelector('.cell[data-widget="calendar"] .tile-body').textContent);
  expect(tileText.indexOf(g1) >= 0, lang + ': the tile says ' + g1 + ' next to the call');
  await tileShot(page, 'calendar-notes-tile' + tag);

  await openPanel(page);
  await shot(page, 'calendar-notes-1-preview' + tag);
  expect((await page.evaluate(() => document.querySelector('#panel .cal-detail').textContent)).indexOf(g1) >= 0, lang + ': the overlay says ' + g1);
  await key(page, 'Enter');
  expect(await readingNow(page), lang + ': OK on an event with notes opens them');
  const reading = await page.evaluate(() => document.querySelector('#panel .cal-notes-body').textContent);
  expect(reading.indexOf(g1) === 0 && reading.indexOf('Marta Ibáñez') > 0, lang + ': the notes open with the guest count and name: ' + reading.slice(0, 60));
  await shot(page, 'calendar-notes-2-reading' + tag);
  await key(page, 'Escape');
  expect(!(await readingNow(page)) && (await page.evaluate(() => window.HUB_TEST.open() === 'calendar')),
    lang + ': Back closes the notes and keeps the panel open');

  // Tuesday: Library visit has 3 guests and no notes; OK still opens the list.
  await key(page, 'ArrowRight', 2);
  for (let i = 0; i < 6 && (await selected(page)) !== (lang === 'es' ? 'Visita a la biblioteca' : 'Library visit'); i++) await key(page, 'ArrowDown');
  expect((await page.evaluate(() => document.querySelector('#panel .cal-stage').textContent)).indexOf(g3) >= 0, lang + ': the day view says ' + g3);
  await key(page, 'Enter');
  expect(await readingNow(page), lang + ': OK opens the guest list of an event without notes');
  await shot(page, 'calendar-guests-library-reading' + tag);
  await key(page, 'Escape');
  await toTabs(page);
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  await shot(page, 'calendar-guests-week' + tag);
  await toTabs(page);
  await key(page, 'ArrowLeft');
  await key(page, 'ArrowDown');

  // Saturday: Water plants.
  await key(page, 'ArrowRight', 4);
  const sel = await selected(page);
  expect(sel === (lang === 'es' ? 'Regar las plantas' : 'Water plants'), lang + ': Saturday picks Water plants, got "' + sel + '"');
  await shot(page, 'calendar-notes-3-water-preview' + tag);
  await key(page, 'Enter');
  expect(await readingNow(page), lang + ': OK opens the plant notes');
  await shot(page, 'calendar-notes-4-water-reading' + tag);
  const moved = await page.evaluate(() => {
    const b = document.querySelector('#panel .cal-notes-body');
    return b ? b.style.transform : '';
  });
  await key(page, 'ArrowDown');
  const after = await page.evaluate(() => (document.querySelector('#panel .cal-notes-body') || {}).style.transform);
  expect(after !== moved, lang + ': Down scrolls the notes (' + moved + ' -> ' + after + ')');
  await shot(page, 'calendar-notes-5-water-scrolled' + tag);
  await key(page, 'ArrowUp');
  await key(page, 'ArrowUp');
  expect(!(await readingNow(page)), lang + ': Up at the top closes the notes');

  // Full screen reading.
  await toTabs(page);
  await key(page, 'ArrowUp');
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'full screen did not open');
  await idle(page);
  await key(page, 'ArrowDown');
  await key(page, 'ArrowDown');
  await key(page, 'Enter');
  expect(await readingNow(page), lang + ': OK reads the notes at full screen');
  await shot(page, 'calendar-notes-6-water-full' + tag);
  await key(page, 'Escape');
  await key(page, 'Escape');
  await key(page, 'Escape');
  await idle(page);
  await done(page, 'notes ' + lang);

  // Guest mode: no mark, no notes.
  const g = await openHub({ storage: { 'homeHub.guest.v1': 'on' } });
  await waitTile(g, 'Call with the contractor');
  const gm = await g.evaluate(() => document.querySelectorAll('.cal-has-notes').length);
  expect(gm === 0, 'guest: no notes mark on the tile, got ' + gm);
  expect((await g.evaluate(() => document.body.textContent)).indexOf('1 guest') < 0, 'guest mode: no guest count anywhere');
  await openPanel(g);
  const gtext = await g.evaluate(() => document.querySelector('#panel').textContent);
  expect(gtext.indexOf('paint chips') < 0 && /hidden for guests/.test(gtext), 'guest: the panel hides the notes and says so');
  await key(g, 'Enter');
  expect(!(await readingNow(g)), 'guest: OK does not open notes');
  if (lang !== 'es') await shot(g, 'calendar-notes-7-guest');
  await done(g, 'guest');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv.indexOf('--notes') >= 0;
  for (const f of fs.readdirSync(OUT)) if ((only ? /^calendar-notes-/ : /^calendar-/).test(f)) fs.unlinkSync(path.join(OUT, f));
  await startAll();
  browser = await chromium.launch();
  try {
    if (process.argv.indexOf('--notes') < 0) {
      await mainShots();
      await stateShots();
    }
    await notesShots('en');
    await notesShots('es');
  } finally {
    await stopAll();
  }
  console.log(written.length + ' screenshots in docs/screenshots');
  console.log(problems.length ? problems.length + ' problems' : 'no problems');
  process.exit(problems.length ? 1 : 0);
}

main().catch(async (e) => {
  console.log('FAIL ' + (e && e.stack));
  await stopAll().catch(() => {});
  process.exit(1);
});
