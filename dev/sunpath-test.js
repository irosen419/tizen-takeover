/*
 * Plant sun, end to end: node dev/sunpath-test.js
 *
 * Runs the real hub in headless Chromium at 1920x1080 against the preview
 * (dev/preview.js, without live updates), with the TV's clock faked by
 * Playwright (page.clock) in Chicago, so every answer is fixed:
 *
 *   - The sun: sunpos() against an independent formula (the Astronomical
 *     Almanac's low-precision sun, about 0.01 degrees) within 0.5 degrees at
 *     several moments, solar noon on Jun 21 and Dec 21 against 90 - lat +/-
 *     23.44, and Ian's own look on Nov 17 2026 at 3:05 PM (sun about 226
 *     degrees, 22 up, nowhere near the window's 263.3 degree edge).
 *   - The window and the plants with the default settings (the plants run
 *     2 to 6 ft into the room): June 21 evening sun reaches them (5:15 to
 *     7:07 PM, 6:10 PM in it), Dec 21 has none, Nov 17 has no sun through
 *     the window at all. A single plant spot (an older config's one number)
 *     still works and gives its own, shorter window (5:20 to 6:26 PM).
 *   - The next sun: Nov 17 gives Mar 9, Jun 21 at 2 PM a time the same day,
 *     at 6:10 PM "now" with its end, at 7:30 PM tomorrow; the search is
 *     cached and cheap.
 *   - The room plan draws the three plants near, middle and far along the
 *     wall, not in a clump.
 *   - The tile at 1x1, 2x1, 3x1, 6x1, 3x2, 3x4, 6x3 and 12x6, lit (Jun 21,
 *     6:10 PM) and in winter (Nov 17, 3:05 PM), in English and in Spanish
 *     with every Spanish sunpath text 25% longer (with Á, É, ñ, ¿, ¡): what
 *     each size says, nothing past the tile, nothing cut sideways or at the
 *     top or bottom, no type under 0.85rem (0.8rem in one column), line
 *     height 1.25 or more, picture words only when they are big enough.
 *   - The panel and full screen in both languages, lit and in winter, in
 *     each of the panel's three views: all of it inside, the placeholder
 *     note there (and gone with placeholder: false, with the tile's badge).
 *   - The remote: Left and Right on the time slider move 15 minutes, on the
 *     day chooser through today, Dec 21, Mar 20, Jun 21, Sep 22; OK on a
 *     view chip shows that view; the status follows ("Direct sun on the
 *     wall..." while in the beam).
 *   - Care (the fourth view, from calendar live data injected into the
 *     page): the notes cut into 1 top paragraph, 4 plants and 1 bottom
 *     paragraph; the "Water plants" event picked (past ones skipped, title
 *     case aside, no data gives nothing); the light line matched by name;
 *     the header ("Next watering: Sat, Nov 21, 10 AM", "Now", none), cards
 *     with their Light lines, the warning, two columns in full screen, one
 *     scrolling column in the panel (Down and Up, Up at the top leaves for
 *     the panel's button), English, Spanish and Spanish +25% (words and
 *     notes) without cut text; the tile's "Water plants Sat 10 AM" line
 *     (and gone when it does not fit); data arriving after the first draw.
 *   - The minute timer: the tile turns from "now" to "tomorrow" when the
 *     sun leaves, without a reload.
 *   - No console errors anywhere.
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
const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', '192.168.1.219'];
const ZONE = 'America/Chicago';

// Sunday 21 June 2026, 6:10 PM in Chicago (CDT): sun on the plants.
const LIT = Date.parse('2026-06-21T23:10:00Z');
// The same day at 2 PM: the next sun later today.
const AFTERNOON = Date.parse('2026-06-21T19:00:00Z');
// Tuesday 17 November 2026, 3:05 PM in Chicago (CST): Ian's own look.
const NOV17 = Date.parse('2026-11-17T21:05:00Z');

const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [3, 2], [3, 4], [6, 3], [12, 6]];

let PAGE;
let preview = null;
let browser = null;
const openContexts = new Set();
let passed = 0;
let failed = 0;

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

// Runs before the hub's scripts: when app/i18n.js sets HUB_I18N, every
// Spanish sunpath text grows by a quarter (placeholders kept whole).
function longer() {
  let real;
  Object.defineProperty(window, 'HUB_I18N', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v;
      try {
        const es = v.strings.es;
        const extra = 'ÁÉñíóú';
        Object.keys(es).forEach((k) => {
          if (!/^sunpath\./.test(k)) return;
          const text = es[k];
          const words = text.replace(/\{\w+\}/g, '').match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/g);
          if (!words) return;
          let add = Math.ceil(text.length * 0.25);
          let i = 0;
          es[k] = text.replace(/(\{\w+\})|([A-Za-zÁÉÍÓÚáéíóúñÑ]{3,})/g, (all, ph, word) => {
            if (ph || add <= 0) return all;
            const share = Math.max(1, Math.ceil(add / Math.max(1, words.length - i)));
            i++;
            let s = '';
            for (let j = 0; j < share; j++) s += extra.charAt((j + i) % extra.length);
            add -= share;
            return word + s;
          });
          if (/^[A-ZÁÉ]/.test(es[k])) es[k] = '¿' + es[k] + '?';
          else if (es[k].length > 8) es[k] = '¡' + es[k] + '!';
        });
      } catch (e) { /* the checks then see the plain Spanish */ }
    }
  });
}

// Runs before the hub's scripts, with the calendar data (or null): the hub's
// live data answers get('calendar') with it and hands the listeners to
// window.__calHandlers (window.__setCal(data) sends new data to them).
function calInject(D) {
  let real;
  window.__calHandlers = [];
  window.__setCal = (d) => { D = d; window.__calHandlers.forEach((fn) => fn(d, 2)); };
  Object.defineProperty(window, 'HUB_LIVE', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v;
      const g = v.get;
      const on = v.on;
      v.get = function (r) { return r === 'calendar' ? D : g.apply(v, arguments); };
      v.on = function (r, fn) { if (r === 'calendar') window.__calHandlers.push(fn); return on.apply(v, arguments); };
    }
  });
}

const NOTES = 'Check each plant with a finger in the soil first. Water slowly until it drains, then empty the saucer so roots never sit in water. Winter light is low, so they drink less until March.\n\n' +
  'Gold Lines maranta\nWater when the top inch is dry, usually every week. Keep it evenly moist but never soggy. Use filtered water or tap water left out overnight, since it browns from chlorine and fluoride. Mist the leaves or keep it near a humidifier.\n\n' +
  'Birkin philodendron\nWater when the top 1 to 2 inches are dry, usually every 7 to 10 days in winter. Yellow leaves mean too much water. Wipe dust off the leaves once a month.\n\n' +
  'Golden pothos\nWater only when the top half of the soil is dry, usually every other week in winter. Drooping, soft leaves mean it is thirsty. It handles drying out better than overwatering.\n\n' +
  'Cuttings in the glass wall vases\nTop up the water weekly and swap it out fully every two weeks.\n\n' +
  'Keep the Birkin and pothos out of Ember\u2019s reach, since both are toxic to dogs.';
function calData(events) {
  return { configured: true, tz: 'America/Chicago', from: '2026-11-19T06:00:00Z', to: '2027-01-18T06:00:00Z', updatedAt: '2026-11-19T21:00:00Z', calendars: [], events: events, notes: { n1: NOTES } };
}
const WATER = { id: 'wp1', cal: 'home', title: 'Water plants', start: '2026-11-21T16:00:00Z', end: '2026-11-21T16:15:00Z', allDay: false, location: '', note: 'n1' };
// Thursday 19 November 2026, 3:05 PM in Chicago: two days before the watering.
const NOV19 = Date.parse('2026-11-19T21:05:00Z');

/* ---------- pages ---------- */

// opts: { at, size: [w, h] | layout, lang, grow, install (a running fake
// clock instead of a fixed one), config (text replacements in config.js) }
async function openHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: ZONE });
  context.errors = [];
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const host = new URL(url).hostname;
    if (BLOCKED_HOSTS.indexOf(host) >= 0) return route.abort();
    if (opts.config && /\/config\.js(\?|$)/.test(url)) {
      let body = fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8');
      opts.config.forEach((r) => { body = body.replace(r[0], r[1]); });
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: body });
    }
    return route.continue();
  });
  const storage = { 'homeHub.lang': opts.lang || 'en' };
  const size = opts.size || [3, 2];
  storage['homeHub.layout'] = JSON.stringify(opts.layout || [{ widget: 'sunpath', x: 0, y: 0, w: size[0], h: size[1] }]);
  await context.addInitScript((items) => {
    try {
      if (!sessionStorage.getItem('sunpathTestSeeded')) {
        sessionStorage.setItem('sunpathTestSeeded', '1');
        localStorage.clear();
        for (const k in items) localStorage.setItem(k, items[k]);
      }
    } catch (e) { /* ignore */ }
  }, storage);
  if (opts.grow) await context.addInitScript(longer);
  if (opts.cal !== undefined) await context.addInitScript(calInject, opts.cal);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const where = (m.location() && m.location().url) || '';
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    context.errors.push(m.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  if (opts.install) await page.clock.install({ time: opts.at });
  else await page.clock.setFixedTime(new Date(opts.at || LIT));
  await page.goto(PAGE + '/?motion=fade&live=off&clay=off');
  await page.waitForFunction(() => window.HUB_TEST && window.HUB_SUNPATH && document.querySelector('#grid .tile-body *'));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(150);
  return page;
}

function noErrors(page) {
  const errors = page.context().errors.filter((e) => !/net::ERR_FAILED|Failed to load resource/.test(e));
  assert(!errors.length, 'console: ' + errors.join(' | '));
}

/* ---------- measuring ---------- */

// Every fit problem inside root (a selector), and the words shown.
function inspect(page, sel, minRem, oneMinRem) {
  return page.evaluate((a) => {
    const [sel, minRem, oneMinRem] = a;
    const root = document.querySelector(sel);
    if (!root) return { problems: ['no ' + sel], text: '' };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const b = root.getBoundingClientRect();
    const one = !!root.querySelector('.sp-one');
    const min = one ? oneMinRem : minRem;
    const problems = [];
    const shown = (el) => { for (let e = el; e && e !== root.parentNode; e = e.parentElement) { if (getComputedStyle(e).display === 'none') return false; } return true; };
    const cuts = (cs) => cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none');
    root.querySelectorAll('*').forEach((el) => {
      if (!shown(el)) return;
      const isSvg = el instanceof SVGElement;
      if (isSvg && el.tagName.toLowerCase() !== 'text') return;
      if (!el.textContent.trim()) return;
      const r = el.getBoundingClientRect();
      const name = (isSvg ? 'svg ' : '') + (el.getAttribute('class') || el.tagName) + ' "' + el.textContent.slice(0, 32) + '"';
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
        problems.push(name + ' is outside (' + [r.left - b.left, b.right - r.right, r.top - b.top, b.bottom - r.bottom].map((n) => n.toFixed(1)).join(', ') + ')');
      }
      if (isSvg) {
        // A picture's words: inside their picture and big enough on screen.
        const svg = el.ownerSVGElement.getBoundingClientRect();
        if (r.left < svg.left - 1 || r.right > svg.right + 1 || r.top < svg.top - 1 || r.bottom > svg.bottom + 1) problems.push(name + ' leaves its picture');
        if (r.height < 0.8 * rem) problems.push(name + ' is only ' + (r.height / rem).toFixed(2) + 'rem tall');
        return;
      }
      const cs = getComputedStyle(el);
      if (cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 1 && !cuts(cs)) problems.push(name + ' is cut sideways');
      if (cs.display !== 'inline' && !cuts(cs) && /hidden/.test(cs.overflowY + cs.overflow) && el.scrollHeight > el.clientHeight + 1 && !el.classList.contains('panel-body')) problems.push(name + ' is cut at the top or bottom');
      if (el.children.length) return;
      const fs = parseFloat(cs.fontSize);
      if (fs < min * rem - 0.2) problems.push(name + ' type ' + (fs / rem).toFixed(2) + 'rem');
      const lh = parseFloat(cs.lineHeight);
      if (lh && lh < fs * 1.25 - 0.2) problems.push(name + ' line-height ' + (lh / fs).toFixed(2));
    });
    if (root.querySelector('.is-cut')) problems.push('the strip ends in "..."');
    return { problems: problems, text: root.innerText.replace(/\s+/g, ' ').trim(), state: (root.getAttribute('data-state') || '') };
  }, [sel, minRem, oneMinRem]);
}

const TILE = '.cell[data-widget="sunpath"] .tile-body';
const PANEL = '#panel .panel-body';

async function openPanel(page) {
  assert(await page.evaluate(() => window.HUB_TEST.openPanel('sunpath')), 'the panel did not open');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'sunpath' && !window.HUB_TEST.busy() && !!document.querySelector('.sp-panel')), 4000, 'the panel did not open');
  await sleep(100);
}

async function fullScreen(page) {
  await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.sp-panel.is-full')), 4000, 'no full screen');
  await sleep(100);
}

async function showView(page, view) {
  await page.evaluate((v) => document.querySelector('.sp-view-chip[data-view="' + v + '"]').click(), view);
  await sleep(80);
}

/* ---------- the checks ---------- */

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log('ok    ' + name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n').join('\n      '));
  }
  for (const c of Array.from(openContexts)) {
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

// The Astronomical Almanac's low-precision sun (about 0.01 degrees), an
// independent check on the NOAA formulas in sunpath.js.
function almanac(ms, lat, lon) {
  const r = Math.PI / 180;
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * r;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r;
  const eps = (23.439 - 0.0000004 * n) * r;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = ((gmst * 15 + lon) * r - ra);
  const la = lat * r;
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha)) / r;
  az = ((az % 360) + 360) % 360;
  return { alt: alt / r, az: az };
}

async function checkMath() {
  const page = await openHub({ at: LIT });
  const moments = ['2026-06-21T23:10:00Z', '2026-06-21T17:00:00Z', '2026-12-21T21:30:00Z', '2026-03-20T23:30:00Z',
    '2026-09-22T23:00:00Z', '2026-11-17T21:05:00Z', '2027-01-05T15:00:00Z'].map((t) => Date.parse(t));
  const r = await page.evaluate((list) => {
    const H = window.HUB_SUNPATH;
    const st = H.settings();
    const at = (y, m, d, h, mi) => new Date(y, m, d, h, mi).getTime();
    const fmt = (ms) => { const d = new Date(ms); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
    const spans = (y, m, d, which) => H.daySpans(new Date(y, m, d), which).map((s) => fmt(s.start) + '-' + fmt(s.end));
    // Solar noon: the highest the sun gets that day.
    const noon = (y, m, d) => { let best = -90; for (let mi = 10 * 60; mi <= 15 * 60; mi++) best = Math.max(best, H.sunpos(at(y, m, d, 0, mi), st.lat, st.lon).alt); return best; };
    return {
      st: st,
      c: H.constants,
      pos: list.map((ms) => H.sunpos(ms, st.lat, st.lon)),
      noonJun: noon(2026, 5, 21),
      noonDec: noon(2026, 11, 21),
      ian: H.sunpos(Date.parse('2026-11-17T21:05:00Z'), st.lat, st.lon),
      ian3: H.sunpos(Date.parse('2026-11-17T21:00:00Z'), st.lat, st.lon),
      ian330: H.sunpos(Date.parse('2026-11-17T21:30:00Z'), st.lat, st.lon),
      litNow: H.hitsPlant(H.sunpos(at(2026, 5, 21, 18, 10), st.lat, st.lon)),
      jun: spans(2026, 5, 21, 'plants'),
      junWin: spans(2026, 5, 21, 'window'),
      mar: spans(2026, 2, 20, 'plants'),
      marWin: spans(2026, 2, 20, 'window'),
      dec: spans(2026, 11, 21, 'plants'),
      decWin: spans(2026, 11, 21, 'window'),
      nov: spans(2026, 10, 17, 'plants'),
      novWin: spans(2026, 10, 17, 'window')
    };
  }, moments);
  // The settings: the weather's rounded location and the defaults, placeholders marked.
  assert(r.st.lat === 32.78 && r.st.lon === -96.78, 'location: ' + r.st.lat + ', ' + r.st.lon);
  assert(r.st.roof === 40 && r.st.gap === 2 && r.st.placeholder === true && r.st.near === 2 && r.st.far === 6 && r.st.height === 3, 'settings: ' + JSON.stringify(r.st));
  assert(r.st.shy === 'Maranta Gold Lines' && r.st.plants.length === 3, 'plants: ' + JSON.stringify(r.st.plants));
  assert(r.c.MAG_DECLINATION === 3.3 && Math.abs(r.c.AZ_LO - 263.3) < 1e-9 && Math.abs(r.c.AZ_HI - 348.3) < 1e-9 && Math.abs(r.c.FACE - 305.8) < 1e-9, 'window: ' + JSON.stringify(r.c));
  moments.forEach((ms, i) => {
    const ref = almanac(ms, 32.78, -96.78);
    const got = r.pos[i];
    const dAz = Math.abs(((got.az - ref.az + 540) % 360) - 180);
    assert(Math.abs(got.alt - ref.alt) < 0.5 && (ref.alt < 1 || dAz < 0.5),
      new Date(ms).toISOString() + ': ' + got.alt.toFixed(2) + '/' + got.az.toFixed(2) + ' against ' + ref.alt.toFixed(2) + '/' + ref.az.toFixed(2));
  });
  assert(Math.abs(r.noonJun - (90 - 32.78 + 23.44)) < 0.5, 'June noon ' + r.noonJun.toFixed(2));
  assert(Math.abs(r.noonDec - (90 - 32.78 - 23.44)) < 0.5, 'December noon ' + r.noonDec.toFixed(2));
  // Ian, Nov 17 2026 about 3:05 PM: sun just touching the balcony edge,
  // nothing inside. The coordinator's figures for that afternoon: 223.9° /
  // 24.4° up at 3:00, 229.7° / 19.8° at 3:30, about 226° / 22° around 3:05.
  assert(Math.abs(r.ian3.az - 223.9) < 0.5 && Math.abs(r.ian3.alt - 24.4) < 0.5, 'Nov 17 3:00 PM: ' + r.ian3.az.toFixed(2) + '° / ' + r.ian3.alt.toFixed(2) + '°');
  assert(Math.abs(r.ian330.az - 229.7) < 0.5 && Math.abs(r.ian330.alt - 19.8) < 0.5, 'Nov 17 3:30 PM: ' + r.ian330.az.toFixed(2) + '° / ' + r.ian330.alt.toFixed(2) + '°');
  assert(Math.abs(r.ian.az - 226) < 1.5 && Math.abs(r.ian.alt - 22) < 2, 'Nov 17 3:05 PM: ' + r.ian.az.toFixed(2) + '° / ' + r.ian.alt.toFixed(2) + '° up');
  assert(r.ian.az < r.c.AZ_LO - 30, 'Nov 17: the sun should be far left of the view');
  assert(r.litNow, 'June 21 at 6:10 PM should reach the plants');
  assert(r.jun.length === 1 && r.jun[0] === '17:15-19:07', 'June 21 on the plants: ' + r.jun.join(', '));
  // Mar 20 and Sep 22: what gets through the window lands on the plants.
  assert(r.mar.length === 1 && r.mar[0] === r.marWin[0], 'Mar 20: ' + r.mar.join(',') + ' / ' + r.marWin.join(','));
  assert(r.junWin.length >= 1, 'June 21 through the window: none');
  assert(!r.dec.length && !r.decWin.length, 'Dec 21: ' + r.dec.join(',') + ' / ' + r.decWin.join(','));
  assert(!r.nov.length && !r.novWin.length, 'Nov 17 should have no sun through the window at all: ' + r.novWin.join(','));
  noErrors(page);
}

async function checkSearch() {
  const page = await openHub({ at: LIT });
  const r = await page.evaluate(() => {
    const H = window.HUB_SUNPATH;
    const at = (y, m, d, h, mi) => new Date(y, m, d, h, mi).getTime();
    const brief = (a) => ({ k: a.k, days: a.days, start: a.start ? new Date(a.start).toString() : '', end: a.end ? new Date(a.end).toString() : '' });
    const t0 = performance.now();
    const nov = H.search(at(2026, 10, 17, 15, 5));
    const ms = performance.now() - t0;
    return {
      nov: brief(nov), novMonth: nov.start ? new Date(nov.start).getMonth() : -1, ms: ms,
      afternoon: brief(H.search(at(2026, 5, 21, 14, 0))),
      lit: brief(H.search(at(2026, 5, 21, 18, 10))),
      late: brief(H.search(at(2026, 5, 21, 19, 5))),
      evening: brief(H.search(at(2026, 5, 21, 19, 30))),
      feb: brief(H.search(at(2027, 1, 20, 12, 0)))
    };
  });
  assert(r.nov.k === 'later' && r.nov.days > 90 && r.novMonth === 2 && /Mar 09 2027 18:15/.test(r.nov.start), 'Nov 17: ' + JSON.stringify(r.nov));
  assert(r.afternoon.k === 'later' && r.afternoon.days === 0 && /Jun 21 2026 17:/.test(r.afternoon.start), 'Jun 21 at 2 PM: ' + JSON.stringify(r.afternoon));
  assert(r.lit.k === 'now' && /Jun 21 2026 19:07/.test(r.lit.end), 'Jun 21 at 6:10 PM: ' + JSON.stringify(r.lit));
  assert(r.late.k === 'now', 'Jun 21 at 7:05 PM: ' + JSON.stringify(r.late));
  assert(r.evening.k === 'later' && r.evening.days === 1 && /Jun 22 2026 17:/.test(r.evening.start), 'Jun 21 at 7:30 PM: ' + JSON.stringify(r.evening));
  assert(r.feb.k === 'later' && /Mar /.test(r.feb.start), 'Feb 20: ' + JSON.stringify(r.feb));
  assert(r.ms < 400, 'the winter search took ' + r.ms.toFixed(0) + ' ms');
  // Cached: the same answer is not worked out again within the hour.
  const c = await page.evaluate(() => {
    const H = window.HUB_SUNPATH;
    const t = new Date(2026, 10, 17, 15, 5).getTime();
    H.answer(t);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) H.answer(t + i * 60000);
    return performance.now() - t0;
  });
  assert(c < 30, '50 cached answers took ' + c.toFixed(1) + ' ms');
  noErrors(page);
}

// A one-widget (12x6) layout opens as a window over its hidden tile: Back shows the tile.
async function showSoloTile(page) {
  await page.waitForFunction(() => window.HUB_TEST.open() === 'sunpath' && !window.HUB_TEST.busy(), null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.HUB_TEST.open() && !window.HUB_TEST.busy(), null, { timeout: 5000 });
}

function expectTile(t, size, when, lang, name) {
  const [cols, rows] = size;
  assert(!t.problems.length, name + ': ' + t.problems.join('; '));
  assert(t.text.length > 0, name + ': blank');
  const es = lang === 'es';
  if (when === 'lit') {
    assert(t.state === 'now', name + ': state ' + t.state);
    if (cols === 1) assert(/Now|Ahora/.test(t.text), name + ': ' + t.text);
    else if (rows === 1) assert(/Sun|Sol/.test(t.text), name + ': ' + t.text);
    else {
      assert(/Sun on the plants now|Sol en las plantas ahora/.test(t.text.replace(/[ÁÉñíóú¿?¡!]/g, '')) && /7:07/.test(t.text), name + ': ' + t.text);
      assert(/Maranta Gold Lines/.test(t.text), name + ': no Maranta warning: ' + t.text);
    }
  } else if (when === 'winter') {
    assert(t.state === 'date', name + ': state ' + t.state);
    assert(!/on the plants now|en las plantas ahora/i.test(t.text), name + ': says sun now: ' + t.text);
    assert(/Mar|mar/.test(t.text) && /\b9\b/.test(t.text), name + ': no March date: ' + t.text);
    if (rows >= 2 && cols >= 3 && !es) assert(/Grow lights/.test(t.text), name + ': no grow lights line: ' + t.text);
  } else if (when === 'today') {
    assert(t.state === 'today', name + ': state ' + t.state);
    assert(/5:15/.test(t.text), name + ': ' + t.text);
  }
  if (rows >= 4 && cols >= 3 && when !== 'today') assert(/Dec 21|21 dic/.test(t.text) && /Jun 21|21 jun/.test(t.text), name + ': no season table: ' + t.text);
}

async function checkTiles(lang, grow) {
  const runs = [['lit', LIT], ['winter', NOV17], ['today', AFTERNOON]];
  for (const [when, at] of runs) {
    for (const size of SIZES) {
      if (when === 'today' && size[0] * size[1] > 12) continue;
      const page = await openHub({ at: at, size: size, lang: lang, grow: grow });
      if (size[0] === 12 && size[1] === 6) await showSoloTile(page);
      const t = await inspect(page, TILE, 0.85, 0.8);
      expectTile(t, size, when, lang, when + ' ' + size.join('x') + ' ' + lang + (grow ? ' +25%' : ''));
      if (size[1] >= 2 && size[0] >= 2) {
        const badge = await page.evaluate(() => document.querySelector('.cell[data-widget="sunpath"] .tile-badge').textContent);
        assert(badge.indexOf(lang === 'es' ? 'Estimado' : 'Estimate') >= 0, 'badge: ' + badge);
      }
      noErrors(page);
      await page.context().close();
    }
  }
}

async function checkPanels(lang, grow) {
  for (const [when, at] of [['lit', LIT], ['winter', NOV17]]) {
    const page = await openHub({ at: at, size: [12, 5], lang: lang, grow: grow });   // 12x6 alone opens full screen by itself
    await openPanel(page);
    for (const v of ['plan', 'arc', 'table']) {
      await showView(page, v);
      const p = await inspect(page, PANEL, 0.75, 0.75);
      const name = when + ' panel ' + v + ' ' + lang + (grow ? ' +25%' : '');
      assert(!p.problems.length, name + ': ' + p.problems.join('; '));
      assert(/Placeholder|Provisional/i.test(p.text) && /40°/.test(p.text), name + ': no placeholder note');
      if (when === 'lit') assert(/Maranta Gold Lines/.test(p.text) && /(Direct sun on the wall|Sol directo en la pared)/.test(p.text.replace(/[ÁÉñíóú¿?¡!]/g, '')), name + ': status ' + p.text.slice(0, 160));
      // At +25% the panel may keep only the grow lights note (full screen has both).
      if (v === 'table') assert(/11 ?W/.test(p.text) && (grow || /Birkin/.test(p.text)), name + ': notes');
    }
    await fullScreen(page);
    const f = await inspect(page, PANEL, 0.75, 0.75);
    const name = when + ' full ' + lang + (grow ? ' +25%' : '');
    assert(!f.problems.length, name + ': ' + f.problems.join('; '));
    assert(/11 ?W/.test(f.text) && /Birkin/.test(f.text) && /Placeholder|Provisional/i.test(f.text), name + ': ' + f.text.slice(0, 200));
    const parts = await page.evaluate(() => ['.sp-plan svg', '.sp-arc svg', '.sp-seasons .sp-table'].map((s) => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().height > 50; }));
    assert(parts.every(Boolean), name + ': plan, arc and table all shown: ' + parts);
    noErrors(page);
    await page.context().close();
  }
}

async function checkKeys() {
  const page = await openHub({ at: LIT, size: [12, 5] });
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'sunpath' && !window.HUB_TEST.busy()), 4000, 'OK did not open the panel');
  const st = () => page.evaluate(() => ({
    p: window.HUB_SUNPATH.panel(),
    focus: (document.querySelector('#panel .is-focused') || {}).getAttribute ? document.querySelector('#panel .is-focused').getAttribute('data-key') : null,
    when: document.querySelector('.sp-when').textContent,
    say: document.querySelector('.sp-say').textContent,
    day: document.querySelector('.sp-step-text').textContent
  }));
  let s = await st();
  assert(s.focus === 'time' && s.p.minute === 18 * 60 + 15 && s.p.day === 'today', 'start: ' + JSON.stringify(s));
  assert(/Direct sun on the wall\. Keep the Maranta Gold Lines out of the beam\./.test(s.say), 'lit status: ' + s.say);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  s = await st();
  assert(s.p.minute === 19 * 60 + 15 && /7:15/.test(s.when), 'four steps right: ' + JSON.stringify(s));
  assert(!/Direct sun on the wall/.test(s.say), 'at 7:15 the sun has left the plants: ' + s.say);
  await page.keyboard.press('ArrowLeft');
  s = await st();
  assert(s.p.minute === 19 * 60 && s.focus === 'time', 'one step left: ' + JSON.stringify(s));
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
  s = await st();
  assert(s.p.minute === 12 * 60, 'stops at noon: ' + s.p.minute);
  await page.keyboard.press('ArrowDown');
  s = await st();
  assert(s.focus === 'day', 'down to the day chooser: ' + JSON.stringify(s));
  const seen = [s.p.day];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowRight'); seen.push((await st()).p.day); }
  assert(seen.join() === 'today,dec,mar,jun,sep,today', 'days: ' + seen.join());
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  s = await st();
  assert(s.p.day === 'mar' && /Mar\s20/.test(s.day), 'Mar 20: ' + JSON.stringify(s));
  await page.keyboard.press('ArrowLeft');
  s = await st();
  assert(s.p.day === 'dec', 'back to Dec 21: ' + s.p.day);
  // Up past the controls to a view chip, OK shows that view.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const chip = await page.evaluate(() => (document.querySelector('#panel .is-focused') || {}).className || '');
  if (/sp-view-chip/.test(chip)) {
    await page.keyboard.press('Enter');
  } else {
    await page.evaluate(() => document.querySelector('.sp-view-chip[data-view="arc"]').click());
  }
  await sleep(100);
  const view = await page.evaluate(() => window.HUB_SUNPATH.panel().view);
  assert(view !== 'plan' || /sp-view-chip/.test(chip), 'a view chip: ' + chip + ' ' + view);
  await page.evaluate(() => document.querySelector('.sp-view-chip[data-view="arc"]').click());
  const arc = await page.evaluate(() => ({ v: window.HUB_SUNPATH.panel().view, shown: getComputedStyle(document.querySelector('.sp-arc')).display !== 'none', plan: getComputedStyle(document.querySelector('.sp-plan')).display }));
  assert(arc.v === 'arc' && arc.shown && arc.plan === 'none', 'arc view: ' + JSON.stringify(arc));
  // Back closes; the next open starts again at now.
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => !window.HUB_TEST.open() && !window.HUB_TEST.busy()), 4000, 'Back did not close');
  assert(await page.evaluate(() => window.HUB_SUNPATH.panel()) === null, 'the panel state stays after closing');
  noErrors(page);
}

/* ---------- care ---------- */

async function checkCareParse() {
  const page = await openHub({ at: NOV19, cal: null });
  const r = await page.evaluate((a) => {
    const H = window.HUB_SUNPATH;
    const at = Date.parse('2026-11-19T21:05:00Z');
    const ev = (title, start, end, extra) => Object.assign({ id: title + start, cal: 'c', title: title, start: start, end: end, allDay: false, location: '', note: 'n1' }, extra || {});
    return {
      notes: H.parseNotes(a.notes),
      empty: H.parseNotes(''),
      none: H.parseNotes(undefined),
      allPlain: H.parseNotes('One line.\n\nAnother, with two\nlines of it.'),
      shortEnds: H.parseNotes('Is this a plant?\nNo, a question.\n\nWater first:\nthen wait'),
      longName: H.parseNotes('This first line is far too long to be a plant name at all, really\nso it is general'),
      crlf: H.parseNotes('Intro text.\r\n\r\nFern\r\nWater twice a week.\r\n'),
      past: H.pickCare({ events: [ev('Water plants', '2026-11-14T16:00:00Z', '2026-11-14T16:15:00Z'), ev('Water plants', '2026-11-21T16:00:00Z', '2026-11-21T16:15:00Z')] }, at, 'Water plants'),
      onlyPast: H.pickCare({ events: [ev('Water plants', '2026-11-14T16:00:00Z', '2026-11-14T16:15:00Z')] }, at, 'Water plants'),
      sorted: H.pickCare({ events: [ev('Water plants', '2026-11-28T16:00:00Z', '2026-11-28T16:15:00Z'), ev('Water plants', '2026-11-21T16:00:00Z', '2026-11-21T16:15:00Z')] }, at, 'Water plants'),
      cased: H.pickCare({ events: [ev('  WATER   plants ', '2026-11-21T16:00:00Z', '2026-11-21T16:15:00Z')] }, at, 'water plants'),
      other: H.pickCare({ events: [ev('Water the lawn', '2026-11-21T16:00:00Z', '2026-11-21T16:15:00Z'), ev('Plants', '2026-11-22T16:00:00Z', '2026-11-22T16:15:00Z')] }, at, 'Water plants'),
      running: H.pickCare({ events: [ev('Water plants', '2026-11-21T16:00:00Z', '2026-11-21T16:15:00Z')] }, Date.parse('2026-11-21T16:05:00Z'), 'Water plants'),
      ended: H.pickCare({ events: [ev('Water plants', '2026-11-21T16:00:00Z', '2026-11-21T16:15:00Z')] }, Date.parse('2026-11-21T16:15:00Z'), 'Water plants'),
      allDay: H.pickCare({ events: [ev('Water plants', '2026-11-21', '2026-11-22', { allDay: true })] }, at, 'Water plants'),
      nothing: [H.pickCare(null, at), H.pickCare(undefined, at), H.pickCare({}, at), H.pickCare({ events: 'x' }, at), H.pickCare({ events: [] }, at), H.pickCare({ events: [null, {}, { title: 5 }] }, at)],
      light: ['Gold Lines maranta', 'Birkin philodendron', 'Golden pothos', 'Cuttings in the glass wall vases', 'Snake plant', 'Pothos Birkin'].map((n) => H.lightFor(n, a.light)),
      lightNone: [H.lightFor('Fern', null), H.lightFor('Fern', {}), H.lightFor(null, a.light)],
      st: H.settings()
    };
  }, { notes: NOTES, light: { maranta: 'M light', birkin: 'B light', pothos: 'P light', cuttings: 'C light' } });
  const n = r.notes;
  assert(n.top.length === 1 && n.plants.length === 4 && n.bottom.length === 1, 'parse: ' + n.top.length + ' top, ' + n.plants.length + ' plants, ' + n.bottom.length + ' bottom');
  assert(/^Check each plant with a finger/.test(n.top[0]) && /until March\.$/.test(n.top[0]), 'top: ' + n.top[0]);
  assert(n.plants.map((p) => p.name).join('|') === 'Gold Lines maranta|Birkin philodendron|Golden pothos|Cuttings in the glass wall vases', 'names: ' + n.plants.map((p) => p.name).join('|'));
  assert(/^Water when the top inch is dry/.test(n.plants[0].care) && /humidifier\.$/.test(n.plants[0].care) && n.plants[3].care === 'Top up the water weekly and swap it out fully every two weeks.', 'care texts');
  assert(/^Keep the Birkin and pothos out of Ember/.test(n.bottom[0]) && /dogs\.$/.test(n.bottom[0]), 'bottom: ' + n.bottom[0]);
  assert(!r.empty.top.length && !r.empty.plants.length && !r.empty.bottom.length && !r.none.plants.length, 'no text, no paragraphs');
  assert(r.allPlain.top.length === 1 && r.allPlain.plants.length === 1 && r.allPlain.plants[0].name === 'Another, with two', 'a plain note: ' + JSON.stringify(r.allPlain));
  assert(r.shortEnds.plants.length === 0 && r.shortEnds.top.length === 2, 'a first line ending in ? or : is not a name: ' + JSON.stringify(r.shortEnds));
  assert(r.longName.plants.length === 0 && r.longName.top.length === 1, 'a long first line is not a name');
  assert(r.crlf.plants.length === 1 && r.crlf.plants[0].name === 'Fern' && r.crlf.plants[0].care === 'Water twice a week.', 'CRLF: ' + JSON.stringify(r.crlf));
  assert(r.past && r.past.ev.start === '2026-11-21T16:00:00Z', 'past events are skipped');
  assert(r.onlyPast === null, 'only a past event gives null');
  assert(r.sorted && r.sorted.ev.start === '2026-11-21T16:00:00Z', 'the earliest start wins');
  assert(r.cased && r.cased.ev.title.indexOf('WATER') > 0, 'the title matches without case or extra spaces');
  assert(r.other === null, 'other titles do not match');
  assert(r.running && r.running.start === Date.parse('2026-11-21T16:00:00Z'), 'a running event is still the one');
  assert(r.ended === null, 'an event that just ended is not');
  assert(r.allDay && r.allDay.allDay === true && r.allDay.end > r.allDay.start, 'an all-day event');
  assert(r.nothing.every((x) => x === null), 'missing or odd data gives null: ' + JSON.stringify(r.nothing));
  assert(r.light.join('|') === 'M light|B light|P light|C light||B light', 'light by name: ' + r.light.join('|'));
  assert(r.lightNone.every((x) => x === ''), 'no light without a match: ' + JSON.stringify(r.lightNone));
  assert(r.st.careEvent === 'Water plants' && r.st.light.maranta && r.st.light.birkin && r.st.light.pothos && r.st.light.cuttings, 'settings: ' + JSON.stringify(r.st.light));
  noErrors(page);
}

// What is wrong with the Care text inside .sp-care: type, line height, sideways cuts.
function inspectCare(page) {
  return page.evaluate(() => {
    const care = document.querySelector('.sp-care');
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const problems = [];
    if (!care) return { problems: ['no .sp-care'], text: '' };
    const cb = care.getBoundingClientRect();
    const shown = (el) => { for (let e = el; e && e !== care.parentNode; e = e.parentElement) { if (getComputedStyle(e).display === 'none') return false; } return true; };
    care.querySelectorAll('*').forEach((el) => {
      if (!shown(el) || !el.textContent.trim()) return;
      const cs = getComputedStyle(el);
      const name = (el.getAttribute('class') || el.tagName) + ' "' + el.textContent.slice(0, 30) + '"';
      const r = el.getBoundingClientRect();
      if (r.left < cb.left - 0.5 || r.right > cb.right + 0.5) problems.push(name + ' is outside sideways');
      if (cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 1) problems.push(name + ' is cut sideways');
      if (el.children.length) return;
      const fs = parseFloat(cs.fontSize);
      if (fs < 0.75 * rem - 0.2) problems.push(name + ' type ' + (fs / rem).toFixed(2) + 'rem');
      const lh = parseFloat(cs.lineHeight);
      if (lh && lh < fs * 1.25 - 0.2) problems.push(name + ' line-height ' + (lh / fs).toFixed(2));
    });
    const view = care.querySelector('.sp-care-view');
    const inner = care.querySelector('.sp-care-in');
    return {
      problems: problems,
      text: care.innerText.replace(/\s+/g, ' ').trim(),
      scrolls: !!view && inner.offsetHeight > view.clientHeight + 2,
      cards: care.querySelectorAll('.sp-card').length,
      lights: care.querySelectorAll('.sp-card-light').length,
      lefts: Array.prototype.map.call(care.querySelectorAll('.sp-card'), (c) => Math.round(c.getBoundingClientRect().left)),
      hint: (care.querySelector('.sp-care-hint') || {}).offsetHeight > 0
    };
  });
}

// Spanish 25% longer for the Care words and for the owner's text (dyn).
async function growCare(page) {
  await page.evaluate(() => {
    const I = window.HUB_I18N;
    const grow = (text, mark) => {
      const words = text.replace(/\{\w+\}/g, '').match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/g) || [];
      let add = Math.ceil(text.length * 0.25);
      let i = 0;
      return text.replace(/(\{\w+\})|([A-Za-zÁÉÍÓÚáéíóúñÑ]{3,})/g, (all, ph, w) => {
        if (ph || add <= 0) return all;
        const share = Math.max(1, Math.ceil(add / Math.max(1, words.length - i)));
        i++;
        add -= share;
        return w + mark.repeat(share);
      });
    };
    Object.keys(I.strings.es).forEach((k) => { if (/^sunpath\.(care\.|panel\.views\.(care|sun))/.test(k)) I.strings.es[k] = grow(I.strings.es[k], 'ñá'.charAt(k.length % 2)); });
    I.dyn = (t) => (I.lang() === 'es' ? grow(t, 'ó') : t);
    I.setLang('en');
    I.setLang('es');
  });
  await sleep(200);
}

async function checkCareView() {
  for (const [lang, grow] of [['en', false], ['es', false], ['es', true]]) {
    const tag = lang + (grow ? ' +25%' : '');
    // The panel: one column, scrolling.
    let page = await openHub({ at: NOV19, size: [12, 5], lang: lang, cal: calData([WATER]) });
    if (grow) await growCare(page);
    await openPanel(page);
    await showView(page, 'care');
    let c = await inspectCare(page);
    assert(!c.problems.length, 'panel ' + tag + ': ' + c.problems.join('; '));
    if (lang === 'en') {
      assert(/Next watering: Sat, Nov 21, 10 AM/.test(c.text), 'header: ' + c.text.slice(0, 80));
      assert(/Check each plant with a finger/.test(c.text) && /Gold Lines maranta/.test(c.text) && /Water when the top inch is dry/.test(c.text), 'text: ' + c.text.slice(0, 200));
      assert(c.cards >= 1 && c.lights >= 1 && /LIGHT|Light/i.test(c.text) && /Bright, indirect light\. Direct sun bleaches/.test(c.text), 'light: ' + c.text.slice(0, 300));
    } else {
      assert(grow ? /Pr.ximo/.test(c.text) && /desplaz/.test(c.text) : /Próximo riego: sáb, 21 nov, 10 a\. m\./.test(c.text), 'Spanish header: ' + c.text.slice(0, 100));
      assert(/Luz|LUZ/i.test(c.text) || /L.{0,3}u.{0,3}z/i.test(c.text), 'Spanish Light: ' + c.text.slice(0, 300));
    }
    assert(c.scrolls && c.hint, 'the panel text scrolls (' + tag + ')');
    assert(new Set(c.lefts).size === 1, 'one column in the panel: ' + c.lefts);
    // The chips, Care last and chosen; the other views are hidden.
    const chips = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sp-view-chip'), (e) => e.getAttribute('data-view') + (e.classList.contains('is-on') ? '*' : '')).join());
    assert(chips === 'plan,arc,table,care*', 'chips: ' + chips);
    // Keys: Down moves to the chip, then scrolls to the end; the end shows the warning; Up comes back and leaves for the button.
    await page.keyboard.press('ArrowDown');
    let st = await page.evaluate(() => ({ f: (document.querySelector('#panel .is-focused') || {}).getAttribute('data-key'), y: window.HUB_SUNPATH.panel().careY }));
    assert(st.f === 'view-care' && st.y > 0, 'Down on the Care chip scrolls: ' + JSON.stringify(st));
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
    st = await page.evaluate(() => window.HUB_SUNPATH.panel().careY);
    assert(st === 0, 'Up scrolls back to the top: ' + st);
    await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
    st = await page.evaluate(() => {
      const v = document.querySelector('.sp-care-view').getBoundingClientRect();
      const w = document.querySelector('.sp-care-warn').getBoundingClientRect();
      const inner = document.querySelector('.sp-care-in');
      return { y: window.HUB_SUNPATH.panel().careY, warnBottom: w.bottom - v.bottom, warnTop: w.top - v.top, tf: inner.style.transform || inner.style.webkitTransform, f: document.querySelector('#panel .is-focused').getAttribute('data-key') };
    });
    assert(st.y > 0 && st.warnBottom <= 1 && st.warnTop >= 0 && /translateY\(-/.test(st.tf) && st.f === 'view-care', 'scrolled to the end (' + tag + '): ' + JSON.stringify(st));
    c = await inspectCare(page);
    assert(!c.problems.length, 'panel scrolled ' + tag + ': ' + c.problems.join('; '));
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
    st = await page.evaluate(() => ({ y: window.HUB_SUNPATH.panel().careY, f: document.querySelector('#panel .is-focused').className }));
    assert(st.y === 0 && /panel-btn/.test(st.f), 'Up scrolls back, then leaves for the panel button: ' + JSON.stringify(st));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    st = await page.evaluate(() => (document.querySelector('#panel .is-focused') || {}).getAttribute && document.querySelector('#panel .is-focused').getAttribute('data-key'));
    assert(st === 'view-care', 'Right at the last chip stays (' + st + ')');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    assert((await page.evaluate(() => window.HUB_SUNPATH.panel().view)) === 'table', 'Left then OK chooses Seasons');
    assert(await page.evaluate(() => getComputedStyle(document.querySelector('.sp-care')).display === 'none' && getComputedStyle(document.querySelector('.sp-col-mid')).display !== 'none'), 'Seasons brings the moment column back');
    noErrors(page);
    await page.context().close();

    // Full screen: two columns, all of it without scrolling.
    page = await openHub({ at: NOV19, size: [12, 5], lang: lang, cal: calData([WATER]) });
    if (grow) await growCare(page);
    await openPanel(page);
    await fullScreen(page);
    await showView(page, 'care');
    c = await inspectCare(page);
    assert(!c.problems.length, 'full ' + tag + ': ' + c.problems.join('; '));
    assert(c.cards === 4 && c.lights === 4, 'four cards with their Light lines (' + tag + '): ' + c.cards + '/' + c.lights);
    assert(new Set(c.lefts).size === 2, 'two columns in full screen: ' + c.lefts);
    // At +25% it may need the scroll (with its hint); otherwise all of it shows.
    assert(grow ? c.hint === c.scrolls : !c.scrolls, 'full screen shows all of it, or scrolls with its hint (' + tag + ')');
    assert(/dogs/.test(c.text) || lang === 'es', 'the dog line: ' + c.text.slice(-120));
    const chips2 = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.sp-view-chip'), (e) => e.getAttribute('data-view') + (e.classList.contains('is-on') ? '*' : '')).join());
    assert(chips2 === 'plan,care*', 'full chips: ' + chips2);
    await showView(page, 'plan');
    const parts = await page.evaluate(() => ['.sp-plan svg', '.sp-arc svg', '.sp-seasons .sp-table'].map((s) => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().height > 50; }));
    assert(parts.every(Boolean), 'the Sun chip brings the three pictures back: ' + parts);
    noErrors(page);
    await page.context().close();
  }
}

async function checkCareEdges() {
  // No event in the data: the line says so, no cards.
  let page = await openHub({ at: NOV19, size: [12, 5], cal: calData([]) });
  await openPanel(page);
  await showView(page, 'care');
  let c = await inspectCare(page);
  assert(!c.problems.length && /No “Water plants” event in the next 60 days/.test(c.text) && c.cards === 0, 'none: ' + c.text);
  noErrors(page);
  await page.context().close();
  // Without any calendar data at all.
  page = await openHub({ at: NOV19, size: [12, 5] });
  await openPanel(page);
  await showView(page, 'care');
  c = await inspectCare(page);
  assert(/No “Water plants” event/.test(c.text) && !c.problems.length, 'no data: ' + c.text);
  noErrors(page);
  await page.context().close();
  // An event with no notes.
  const bare = calData([Object.assign({}, WATER, { note: '' })]);
  page = await openHub({ at: NOV19, size: [12, 5], cal: bare });
  await openPanel(page);
  await showView(page, 'care');
  c = await inspectCare(page);
  assert(/Next watering: Sat, Nov 21, 10 AM/.test(c.text) && /no care notes/.test(c.text) && !c.problems.length, 'no notes: ' + c.text);
  await page.context().close();
  // Today, tomorrow, now, all day, a title in other letters, and the setting.
  const times = [
    ['Saturday 10 AM, on Saturday at 8 AM: Today', '2026-11-21T14:00:00Z', WATER, /Next watering: Today, 10 AM/],
    ['the day before: Tomorrow', '2026-11-20T21:00:00Z', WATER, /Next watering: Tomorrow, 10 AM/],
    ['running: Now', '2026-11-21T16:05:00Z', WATER, /Next watering: Now/],
    ['after it ended: none', '2026-11-21T16:20:00Z', WATER, /No “Water plants” event/],
    ['all day', '2026-11-19T21:05:00Z', Object.assign({}, WATER, { start: '2026-11-24', end: '2026-11-25', allDay: true }), /Next watering: Tue, Nov 24(?!,)/],
    ['other letters', '2026-11-19T21:05:00Z', Object.assign({}, WATER, { title: 'WATER PLANTS' }), /Next watering: Sat, Nov 21, 10 AM/]
  ];
  for (const [name, at, ev, re] of times) {
    page = await openHub({ at: Date.parse(at), size: [12, 5], cal: calData([ev]) });
    await openPanel(page);
    await showView(page, 'care');
    c = await inspectCare(page);
    assert(re.test(c.text) && !c.problems.length, name + ': ' + c.text.slice(0, 90) + ' ' + c.problems.join('; '));
    await page.context().close();
  }
  page = await openHub({ at: NOV19, size: [12, 5], cal: calData([Object.assign({}, WATER, { title: 'Feed the ferns' })]), config: [[/careEvent: 'Water plants'/, "careEvent: 'feed the FERNS'"]] });
  await openPanel(page);
  await showView(page, 'care');
  c = await inspectCare(page);
  assert(/Next watering: Sat, Nov 21, 10 AM/.test(c.text), 'careEvent in config: ' + c.text.slice(0, 80));
  await page.context().close();
}

async function checkCareTile() {
  for (const lang of ['en', 'es']) {
    // The line where there is room (3x4), and every size without a problem.
    for (const size of [[1, 1], [2, 1], [3, 1], [3, 2], [3, 4], [6, 3], [12, 6]]) {
      const page = await openHub({ at: NOV19, size: size, lang: lang, cal: calData([WATER]) });
      if (size[0] === 12 && size[1] === 6) await showSoloTile(page);
      const t = await inspect(page, TILE, 0.85, 0.8);
      assert(!t.problems.length, 'care tile ' + size.join('x') + ' ' + lang + ': ' + t.problems.join('; '));
      const has = lang === 'en' ? /Water plants Sat 10 AM/.test(t.text) : /Regar plantas s.b 10 a\. m\./.test(t.text);
      if (size[0] > 1 && size[1] >= 3) assert(has, 'the watering line on ' + size.join('x') + ' ' + lang + ': ' + t.text);
      if (size[1] === 1 || size[0] === 1) assert(!has, 'no watering line on ' + size.join('x') + ': ' + t.text);
      await page.context().close();
    }
  }
  // At 3x2 it is the first to go when there is not room (the others stay).
  let page = await openHub({ at: NOV19, size: [3, 2], cal: calData([WATER]) });
  let t = await inspect(page, TILE, 0.85, 0.8);
  assert(/Mar/.test(t.text) && /Grow lights do the work/.test(t.text), 'the 3x2 tile keeps its words: ' + t.text);
  await page.context().close();
  // Today and now on the tile.
  page = await openHub({ at: Date.parse('2026-11-21T14:00:00Z'), size: [3, 4], cal: calData([WATER]) });
  t = await inspect(page, TILE, 0.85, 0.8);
  assert(/Water plants today 10 AM/.test(t.text) && !t.problems.length, 'today: ' + t.text);
  await page.context().close();
  page = await openHub({ at: Date.parse('2026-11-21T16:05:00Z'), size: [3, 4], cal: calData([WATER]) });
  t = await inspect(page, TILE, 0.85, 0.8);
  assert(/Water plants now/.test(t.text) && !t.problems.length, 'now: ' + t.text);
  await page.context().close();
  // No calendar data: no line.
  page = await openHub({ at: NOV19, size: [3, 4] });
  t = await inspect(page, TILE, 0.85, 0.8);
  assert(!/Water plants/.test(t.text), 'no data, no line: ' + t.text);
  noErrors(page);
  await page.context().close();
}

async function checkCareLate() {
  // The hub drawn before the calendar arrives: the tile line and the Care view follow.
  const page = await openHub({ at: NOV19, size: [3, 4], cal: null });
  let t = await inspect(page, TILE, 0.85, 0.8);
  assert(!/Water plants/.test(t.text), 'before: ' + t.text);
  await page.evaluate((d) => window.__setCal(d), calData([WATER]));
  await until(async () => /Water plants Sat 10 AM/.test((await inspect(page, TILE, 0.85, 0.8)).text), 3000, 'the tile did not get the watering line');
  await openPanel(page);
  await showView(page, 'care');
  let c = await inspectCare(page);
  assert(/Next watering: Sat, Nov 21, 10 AM/.test(c.text), 'care after data: ' + c.text.slice(0, 80));
  // New notes while Care is open: the panel is drawn again with them.
  const next = calData([WATER]);
  next.notes.n1 = NOTES.replace('Golden pothos', 'Marble queen pothos');
  await page.evaluate((d) => window.__setCal(d), next);
  await until(async () => /Marble queen pothos/.test((await inspectCare(page)).text), 3000, 'an open Care view did not follow new notes');
  // A calendar change that leaves the watering alone does not redraw the panel.
  await page.evaluate(() => document.querySelector('.sp-panel').setAttribute('data-mark', 'same'));
  const other = JSON.parse(JSON.stringify(next));
  other.events.push({ id: 'x', cal: 'c', title: 'Dentist', start: '2026-11-23T16:00:00Z', end: '2026-11-23T17:00:00Z', allDay: false, location: '', note: '' });
  await page.evaluate((d) => window.__setCal(d), other);
  await sleep(300);
  assert(await page.evaluate(() => !!document.querySelector('.sp-panel[data-mark="same"]')), 'an unrelated calendar change redrew the Care view');
  noErrors(page);
}

async function checkTimer() {
  // 7:05 PM: two minutes of sun left. The minute timer turns the tile over.
  const page = await openHub({ at: Date.parse('2026-06-22T00:05:00Z'), size: [3, 2], install: true });
  let t = await inspect(page, TILE, 0.85, 0.8);
  assert(t.state === 'now', 'before: ' + t.state);
  await page.clock.runFor(4 * 60000);
  await until(async () => (await inspect(page, TILE, 0.85, 0.8)).state === 'tomorrow', 3000, 'the tile did not turn to tomorrow');
  t = await inspect(page, TILE, 0.85, 0.8);
  assert(/tomorrow/i.test(t.text) && /5:1\d/.test(t.text) && !t.problems.length, 'after: ' + t.text + ' ' + t.problems.join('; '));
  noErrors(page);
}

async function checkPlantRange() {
  // The room plan (6x3 tile, Jun 21 at 6:10 PM): three plants down the wall
  // at 2, 4 and 6 ft, not a clump; the near ones in the beam light up.
  let page = await openHub({ at: LIT, size: [6, 3] });
  const plan = await page.evaluate(() => {
    const cs = Array.prototype.slice.call(document.querySelectorAll('.cell[data-widget="sunpath"] .sp-plants circle'));
    return { ys: cs.map((c) => +c.getAttribute('cy')), lit: cs.map((c) => c.classList.contains('is-lit')), run: !!document.querySelector('.cell[data-widget="sunpath"] .sp-plant-run') };
  });
  assert(plan.ys.length === 3 && plan.run, 'plants: ' + JSON.stringify(plan));
  const step1 = plan.ys[1] - plan.ys[0], step2 = plan.ys[2] - plan.ys[1];
  assert(step1 > 60 && Math.abs(step1 - step2) < 0.5, 'plants not spread evenly 2 to 6 ft: ' + plan.ys.join(', '));
  assert(plan.lit.some(Boolean), 'no plant lit at 6:10 PM: ' + plan.lit.join(','));
  await openPanel(page);
  const note = await page.evaluate(() => (document.querySelector('.sp-place') || {}).textContent || '');
  assert(/Roof angle 40° and plant spots 2 to 6 ft are estimates/.test(note), 'note: ' + note);
  noErrors(page);
  await page.close();
  // An older config with one number: a single plant spot, its own window.
  page = await openHub({ at: LIT, config: [[/plantFromWindowFeet: \[2\.0, 6\]/, 'plantFromWindowFeet: 4.67']] });
  const one = await page.evaluate(() => {
    const H = window.HUB_SUNPATH;
    const fmt = (ms) => { const d = new Date(ms); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
    return { st: H.settings(), jun: H.daySpans(new Date(2026, 5, 21), 'plants').map((s) => fmt(s.start) + '-' + fmt(s.end)) };
  });
  assert(Math.abs(one.st.near - 4.67) < 1e-9 && Math.abs(one.st.far - 4.67) < 1e-9, 'one number: ' + JSON.stringify(one.st));
  assert(one.jun.join() === '17:20-18:26', 'one spot, June 21: ' + one.jun.join());
  noErrors(page);
}

async function checkPlaceholderOff() {
  const page = await openHub({ at: LIT, size: [3, 2], config: [[/placeholder: true/, 'placeholder: false']] });
  const badge = await page.evaluate(() => (document.querySelector('.cell[data-widget="sunpath"] .tile-badge') || {}).textContent || '');
  assert(!/Estimate/.test(badge), 'badge: ' + badge);
  await openPanel(page);
  assert(!(await page.evaluate(() => !!document.querySelector('.sp-place'))), 'the placeholder note still shows');
  noErrors(page);
}

async function checkLayout() {
  const box = {};
  require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
  const c = box.c;
  const pw = c.layouts.filter((l) => l.id === 'plant-wall')[0];
  assert(pw && pw.name === 'Plant wall' && pw.layout.length === 1 && pw.layout[0].widget === 'sunpath' && pw.layout[0].w === 12 && pw.layout[0].h === 6, 'Plant wall layout: ' + JSON.stringify(pw));
  assert(!c.layout.some((e) => e.widget === 'sunpath'), 'sunpath is on the default layout');
  const sp = c.widgets.sunpath;
  assert(sp.careEvent === 'Water plants' && sp.light && ['maranta', 'birkin', 'pothos', 'cuttings'].every((k) => typeof sp.light[k] === 'string' && sp.light[k]), 'careEvent and light in the config: ' + JSON.stringify(sp.light));
  c.layouts.forEach((l) => { if (l.id !== 'plant-wall' && l.layout) assert(!l.layout.some((e) => e.widget === 'sunpath'), 'sunpath on ' + l.id); });
  // Never an address or a finer location than the rounded weather point.
  const src = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'sunpath.js'), 'utf8');
  assert(!/\d{3,5}\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Blvd|Rd)\b/.test(src), 'an address in sunpath.js');
  const lat = String(c.widgets.weather.location.latitude);
  assert(/^\d+\.\d{1,2}$/.test(lat), 'the location is not rounded: ' + lat);
  // Plain ES5.
  let acorn = null;
  for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
    try { acorn = require(p); break; } catch (e) { /* next */ }
  }
  if (acorn) ['app/widgets/sunpath.js', 'app/i18n.js', 'app/config.js', 'app/icons.js'].forEach((f) => acorn.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'), { ecmaVersion: 5 }));
  const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'sunpath.css'), 'utf8');
  assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'sunpath.css does not end with .css-end');
  assert(!/display:\s*grid|[^-]gap:/.test(css), 'grid or flex gap in sunpath.css');
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
    await check('config: the Plant wall layout alone, placeholders marked, plain ES5, no address', checkLayout);
    await check('the sun against the almanac, noon heights, Ian\'s Nov 17 look, June yes, December and November no', checkMath);
    await check('the next sun: March from Nov 17, same day, now, tomorrow; cached and cheap', checkSearch);
    await check('every tile size in English: lit, winter, later today', () => checkTiles('en', false));
    await check('every tile size in Spanish +25%', () => checkTiles('es', true));
    await check('the panel views and full screen in English', () => checkPanels('en', false));
    await check('the panel views and full screen in Spanish', () => checkPanels('es', false));
    await check('the panel views and full screen in Spanish +25%', () => checkPanels('es', true));
    await check('the remote: time slider, day chooser, views, Back', checkKeys);
    await check('care: the notes cut into plants, the event picked, the light matched', checkCareParse);
    await check('care view in the panel and full screen: English, Spanish, Spanish +25%, scrolling keys', checkCareView);
    await check('care view: no event, no data, no notes, today, tomorrow, now, all day, the setting', checkCareEdges);
    await check('care line on the tile, every size, English and Spanish', checkCareTile);
    await check('care: data arriving after the first draw, new notes, unrelated changes', checkCareLate);
    await check('the minute timer turns the tile over when the sun leaves', checkTimer);
    await check('the plants run 2 to 6 ft: spread on the plan, the note says so; one number still works', checkPlantRange);
    await check('placeholder: false hides the badge and the note', checkPlaceholderOff);
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
