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
 *   - The window and the plants with the default settings: June 21 evening
 *     sun reaches the plant spot (6:10 PM is in it), Dec 21 has none, Nov 17
 *     has no sun through the window at all.
 *   - The next sun: Nov 17 gives a date in March, Jun 21 at 2 PM a time the
 *     same day, at 6:10 PM "now" with its end, at 7 PM tomorrow; the search
 *     is cached and cheap.
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
const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];
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
      dec: spans(2026, 11, 21, 'plants'),
      decWin: spans(2026, 11, 21, 'window'),
      nov: spans(2026, 10, 17, 'plants'),
      novWin: spans(2026, 10, 17, 'window')
    };
  }, moments);
  // The settings: the weather's rounded location and the defaults, placeholders marked.
  assert(r.st.lat === 32.78 && r.st.lon === -96.78, 'location: ' + r.st.lat + ', ' + r.st.lon);
  assert(r.st.roof === 40 && r.st.gap === 2 && r.st.placeholder === true && Math.abs(r.st.depth - 4.67) < 0.01 && r.st.height === 3, 'settings: ' + JSON.stringify(r.st));
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
  assert(r.litNow, 'June 21 at 6:10 PM should reach the plant spot');
  assert(r.jun.length === 1 && /^17:/.test(r.jun[0]) && /-18:/.test(r.jun[0]), 'June 21 on the plants: ' + r.jun.join(', '));
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
      evening: brief(H.search(at(2026, 5, 21, 19, 0))),
      feb: brief(H.search(at(2027, 1, 20, 12, 0)))
    };
  });
  assert(r.nov.k === 'later' && r.nov.days > 90 && r.novMonth === 2, 'Nov 17: ' + JSON.stringify(r.nov));
  assert(r.afternoon.k === 'later' && r.afternoon.days === 0 && /Jun 21 2026 17:/.test(r.afternoon.start), 'Jun 21 at 2 PM: ' + JSON.stringify(r.afternoon));
  assert(r.lit.k === 'now' && /Jun 21 2026 18:/.test(r.lit.end), 'Jun 21 at 6:10 PM: ' + JSON.stringify(r.lit));
  assert(r.evening.k === 'later' && r.evening.days === 1 && /Jun 22 2026 17:/.test(r.evening.start), 'Jun 21 at 7 PM: ' + JSON.stringify(r.evening));
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
      assert(/Sun on the plants now|Sol en las plantas ahora/.test(t.text.replace(/[ÁÉñíóú¿?¡!]/g, '')) && /6:26/.test(t.text), name + ': ' + t.text);
      assert(/Maranta Gold Lines/.test(t.text), name + ': no Maranta warning: ' + t.text);
    }
  } else if (when === 'winter') {
    assert(t.state === 'date', name + ': state ' + t.state);
    assert(!/on the plants now|en las plantas ahora/i.test(t.text), name + ': says sun now: ' + t.text);
    assert(/Mar|mar/.test(t.text) && /14/.test(t.text), name + ': no March date: ' + t.text);
    if (rows >= 2 && cols >= 3 && !es) assert(/Grow lights/.test(t.text), name + ': no grow lights line: ' + t.text);
  } else if (when === 'today') {
    assert(t.state === 'today', name + ': state ' + t.state);
    assert(/5:20/.test(t.text), name + ': ' + t.text);
  }
  if (rows >= 4 && cols >= 3 && when !== 'today') assert(/Dec 21|21 dic/.test(t.text) && /Jun 21|21 jun/.test(t.text), name + ': no season table: ' + t.text);
}

async function checkTiles(lang, grow) {
  const runs = [['lit', LIT], ['winter', NOV17], ['today', AFTERNOON]];
  for (const [when, at] of runs) {
    for (const size of SIZES) {
      if (when === 'today' && size[0] * size[1] > 12) continue;
      const page = await openHub({ at: at, size: size, lang: lang, grow: grow });
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
    const page = await openHub({ at: at, size: [12, 6], lang: lang, grow: grow });
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
  const page = await openHub({ at: LIT, size: [12, 6] });
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
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  s = await st();
  assert(s.p.minute === 18 * 60 + 45 && /6:45/.test(s.when), 'two steps right: ' + JSON.stringify(s));
  assert(!/Direct sun on the wall/.test(s.say), 'at 6:45 the sun has left the plants: ' + s.say);
  await page.keyboard.press('ArrowLeft');
  s = await st();
  assert(s.p.minute === 18 * 60 + 30 && s.focus === 'time', 'one step left: ' + JSON.stringify(s));
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

async function checkTimer() {
  // 6:24 PM: two minutes of sun left. The minute timer turns the tile over.
  const page = await openHub({ at: Date.parse('2026-06-21T23:24:00Z'), size: [3, 2], install: true });
  let t = await inspect(page, TILE, 0.85, 0.8);
  assert(t.state === 'now', 'before: ' + t.state);
  await page.clock.runFor(4 * 60000);
  await until(async () => (await inspect(page, TILE, 0.85, 0.8)).state === 'tomorrow', 3000, 'the tile did not turn to tomorrow');
  t = await inspect(page, TILE, 0.85, 0.8);
  assert(/tomorrow/i.test(t.text) && /5:2\d/.test(t.text) && !t.problems.length, 'after: ' + t.text + ' ' + t.problems.join('; '));
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
    await check('the minute timer turns the tile over when the sun leaves', checkTimer);
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
