/*
 * The Clock tile and the face choice, end to end: node dev/clock-test.js
 *
 * Runs the real hub in headless Chromium at 1920x1080 against the preview
 * (dev/preview.js, without live updates): the tile on Digital 12-hour,
 * Digital 24-hour and Analog; the tile changing at once when the face or
 * the clock changes on the Clock page; no digital time anywhere on the
 * analog tile, nor on the page on Analog (which also has no 12/24 group);
 * the second hand turning once a second, from one loop that stops when the
 * tile goes back to Digital; and the date window fitting at many tile sizes,
 * in English and in Spanish. No console errors anywhere.
 *
 * Spanish: the hub asks for 'en-US' dates; the page here is given a
 * toLocaleDateString that asks for 'es-ES' instead (opts.spanish).
 *
 * CLOCK_TEST_SHOTS=<folder> also saves screenshots and a short clip of the
 * face being switched (needs ffmpeg for the .mp4). Needs Playwright and
 * port 8095 free. Prints one line per check and "N passed, M failed";
 * exits 1 on a failure. Nothing here reaches the internet.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const clockPage = require('./clock-page');

const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', '192.168.1.219'];
const SHOTS = process.env.CLOCK_TEST_SHOTS || '';
const ZONE = 'America/Chicago';
// Sunday 15 November 2026, 10:09:30 in Chicago: the hands well apart.
const SUNDAY = Date.parse('2026-11-15T16:09:30Z');
const AFTERNOON = Date.parse('2026-11-15T20:41:12Z');   // 2:41 PM, 14:41
const SATURDAY = Date.parse('2026-11-21T16:09:30Z');
const WEDNESDAY = Date.parse('2026-11-18T16:09:30Z');

const SIZES = [[12, 1], [6, 1], [4, 1], [3, 1], [2, 1], [1, 1], [2, 2], [3, 2], [6, 2], [3, 4], [2, 6], [6, 3], [1, 3]];

let PAGE_PORT, PAGE;
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

/* ---------- pages ---------- */

// The hub asks for 'en-US'; this asks for Spanish instead.
function spanishDates() {
  const orig = Date.prototype.toLocaleDateString;
  Date.prototype.toLocaleDateString = function (loc, opts) { return orig.call(this, 'es-ES', opts); };
}

// opts: { face, hours, layout: [{ widget, x, y, w, h }] or [w, h] for the
// clock alone, at: fixed time (ms), spanish }
async function openHub(opts) {
  opts = opts || {};
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: ZONE,
    recordVideo: opts.video ? { dir: opts.video, size: { width: 1920, height: 1080 } } : undefined
  });
  context.errors = [];
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (BLOCKED_HOSTS.indexOf(host) >= 0) return route.abort();
    return route.continue();
  });
  const storage = {};
  if (opts.face) storage['homeHub.clock.face'] = opts.face;
  if (opts.hours) storage['homeHub.clock.hours'] = opts.hours;
  if (opts.layout) {
    storage['homeHub.layout'] = JSON.stringify(typeof opts.layout[0] === 'number' ?
      [{ widget: 'today', x: 0, y: 0, w: opts.layout[0], h: opts.layout[1] }] : opts.layout);
  }
  await context.addInitScript((items) => {
    try {
      // Only the first load: a reload keeps what the page itself saved.
      if (!sessionStorage.getItem('clockTestSeeded')) {
        sessionStorage.setItem('clockTestSeeded', '1');
        localStorage.clear();
        for (const k in items) localStorage.setItem(k, items[k]);
      }
    } catch (e) { /* ignore */ }
  }, storage);
  if (opts.spanish) await context.addInitScript(spanishDates);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    context.errors.push(m.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  if (opts.at) await page.clock.install({ time: opts.at });
  await page.goto(PAGE + '/?motion=' + (opts.motion || 'push') + '&live=off');
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="today"] .tile-body *'));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  return page;
}

function noErrors(page) {
  const errors = page.context().errors.filter((e) => !/net::ERR_FAILED|Failed to load resource/.test(e));
  assert(!errors.length, 'console errors: ' + errors.join(' | '));
}

// Every number on the analog tile is the window's day: no "9:41", no AM/PM.
function assertNoDigitalTime(t, where) {
  assert(!/\d{1,2}:\d{2}/.test(t.text), where + ': a digital time is showing: "' + t.text + '"');
  assert(!/\b(AM|PM)\b/.test(t.text), where + ': AM/PM is showing: "' + t.text + '"');
}

// The face and its window inside the tile; the window's text inside the window.
function measure(page) {
  return page.evaluate(() => {
    const cell = document.querySelector('.cell[data-widget="today"]');
    const tile = cell.querySelector('.tile').getBoundingClientRect();
    const dial = cell.querySelector('.clock-dial');
    const out = { tile: { w: tile.width, h: tile.height } };
    if (!dial) return out;
    const d = dial.getBoundingClientRect();
    out.dial = { w: d.width, h: d.height };
    out.dialInside = d.left >= tile.left - 0.5 && d.right <= tile.right + 0.5 && d.top >= tile.top - 0.5 && d.bottom <= tile.bottom + 0.5;
    out.offCentre = Math.abs((d.left + d.right) / 2 - (tile.left + tile.right) / 2);
    out.fill = Math.max(d.width / tile.width, d.height / tile.height);
    const rect = cell.querySelector('.clock-window');
    const text = cell.querySelector('.clock-window-text');
    if (rect && text) {
      const r = rect.getBoundingClientRect();
      const t = text.getBoundingClientRect();
      const box = text.getBBox();
      out.win = {
        text: text.textContent,
        rectW: +rect.getAttribute('width'),
        rectH: +rect.getAttribute('height'),
        rectY: +rect.getAttribute('y'),
        len: text.textLength && text.textLength.baseVal ? text.textLength.baseVal.value : 0,
        computed: text.getComputedTextLength(),
        squeezed: text.getAttribute('textLength'),
        bbox: { x: box.x, y: box.y, w: box.width, h: box.height },
        inside: t.left >= r.left - 0.5 && t.right <= r.right + 0.5,
        px: r.width
      };
    }
    return out;
  });
}

function checkWindowFits(m, where) {
  assert(m.dial, where + ': no face');
  assert(m.dialInside, where + ': the face spills out of the tile');
  if (!m.win) return;
  const w = m.win;
  // Width: the text (squeezed or not) is inside the window with a margin.
  const textW = w.squeezed ? +w.squeezed : w.computed;
  assert(textW <= w.rectW - 4, where + ': "' + w.text + '" is ' + textW.toFixed(1) + ' wide in a ' + w.rectW + ' window');
  assert(w.inside, where + ': "' + w.text + '" paints past its window');
  // Height: the text's line box (ascent, with room for Á and É, to descent)
  // is inside the window.
  assert(w.bbox.y >= w.rectY - 0.5 && w.bbox.y + w.bbox.h <= w.rectY + w.rectH + 0.5,
    where + ': "' + w.text + '" line box ' + w.bbox.y.toFixed(1) + '+' + w.bbox.h.toFixed(1) + ' outside the window ' + w.rectY + '+' + w.rectH);
}

/* ---------- the checks ---------- */

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

async function checkDigital12() {
  const page = await openHub({ face: 'digital', hours: '12', at: AFTERNOON });
  const t = await clockPage.tile(page);
  assert(t.face === 'digital', 'face: ' + t.face);
  assert(t.digits === '2:41' && t.ampm === 'PM', 'time: ' + t.digits + ' ' + t.ampm);
  assert(/Sunday/.test(t.text) && /November 15/.test(t.text), 'date: ' + t.text);
  assert(!(await page.$('.cell[data-widget="today"] svg')), 'an analog face on the digital tile');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '1-tile-digital-12h.png') });
  noErrors(page);
}

async function checkDigital24() {
  const page = await openHub({ face: 'digital', hours: '24', at: AFTERNOON });
  const t = await clockPage.tile(page);
  assert(t.face === 'digital', 'face: ' + t.face);
  assert(t.digits === '14:41' && t.ampm === '', 'time: ' + t.digits + ' "' + t.ampm + '"');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '2-tile-digital-24h.png') });
  noErrors(page);
}

async function checkAnalog() {
  // Ian's layout: the clock is a 3x1 strip, so the small face with the
  // digital time and the short date beside it (12/24 applies there).
  const page = await openHub({ face: 'analog', hours: '12', at: SUNDAY });
  const t = await clockPage.tile(page);
  assert(t.face === 'mini', 'face: ' + t.face);
  assert(t.digits === '10:09' && t.ampm === 'AM', 'time: ' + t.digits + ' ' + t.ampm);
  assert(/Sun, Nov 15/.test(t.text), 'date: ' + t.text);
  assert(t.window === null && t.second === null, 'the small face has a window or a second hand');
  // 10:09:30: hour 304.5, minute 57.
  assert(t.hands[0] === 'rotate(304.50 100 100)' && t.hands[1] === 'rotate(57.00 100 100)', 'hands: ' + t.hands.join(', '));
  const clipped = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('.today-mini-time, .today-mini-date'),
    (n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
  assert(!clipped.length, 'cut: ' + clipped.join(' | '));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '3-tile-analog-strip.png') });
  noErrors(page);
  await page.context().close();

  // A 2x1 strip is too narrow for the time: the face alone, "15" in the window.
  const p2 = await openHub({ face: 'analog', hours: '24', layout: [2, 1], at: SUNDAY });
  const t2 = await clockPage.tile(p2);
  assert(t2.face === 'analog', '2x1 face: ' + t2.face);
  assertNoDigitalTime(t2, '2x1 analog tile');
  assert(t2.windowMode === 'day' && t2.window === '15', 'window: ' + t2.windowMode + ' "' + t2.window + '"');
  const hands = await p2.evaluate(() => ['h', 'm', 's'].map((k) =>
    document.querySelector('.cell[data-widget="today"] .clock-hand-' + k).getAttribute('transform')));
  // 10:09:30: hour 304.5, minute 57, second 180.
  assert(hands[0] === 'rotate(304.50 100 100)' && hands[1] === 'rotate(57.00 100 100)' && hands[2] === 'rotate(180.00 100 100)',
    'hands: ' + hands.join(', '));
  checkWindowFits(await measure(p2), '2x1');
  if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, '3-tile-analog.png') });
  noErrors(p2);
}

async function checkSecondHand() {
  // The real clock here: the second hand must turn by itself.
  const page = await openHub({ face: 'analog', layout: [3, 2] });
  const a = (await clockPage.tile(page)).second;
  await sleep(1300);
  const b = (await clockPage.tile(page)).second;
  assert(a && b && a !== b, 'the second hand did not turn: ' + a + ' then ' + b);
  // Exactly one turn per second: count the changes over 3 s.
  const changes = await page.evaluate(() => new Promise((resolve) => {
    const hand = document.querySelector('.cell[data-widget="today"] .clock-hand-s');
    let n = 0;
    const mo = new MutationObserver((list) => { n += list.length; });
    mo.observe(hand, { attributes: true });
    setTimeout(() => { mo.disconnect(); resolve(n); }, 3050);
  }));
  assert(changes >= 2 && changes <= 4, changes + ' second hand changes in 3 s');
  noErrors(page);
}

// Counts the hub's timers that look like a once-a-second loop.
function countTimers() {
  window.__secondTimers = 0;
  const orig = window.setTimeout;
  window.setTimeout = function (fn, ms) {
    if (typeof ms === 'number' && ms >= 10 && ms <= 1010) window.__secondTimers++;
    return orig.apply(this, arguments);
  };
}

async function secondTimersIn(page, ms) {
  await page.evaluate(() => { window.__secondTimers = 0; });
  await sleep(ms);
  return page.evaluate(() => window.__secondTimers);
}

async function checkLiveSwitch() {
  const page = await openHub({ face: 'digital', hours: '12', layout: [3, 2], at: AFTERNOON });
  await page.evaluate(countTimers);
  const base = await secondTimersIn(page, 2100);

  await clockPage.open(page);
  let s = await clockPage.state(page);
  assert(s.face === 'digital' && s.readout, 'page on Digital has no digital time');
  assert(s.keys.join(',') === 'face-digital,face-analog,face-sun,hours-12,hours-24,look-auto,look-day,look-night,lang-en,lang-es,guest-off,guest-on', 'Digital page options: ' + s.keys.join(','));
  assert(s.focused === 'face-digital', 'opened on ' + s.focused);

  await clockPage.pick(page, 'face-analog');
  s = await clockPage.state(page);
  assert(s.face === 'analog', 'the page did not switch to Analog');
  assert(!s.readout, 'the page on Analog still shows a digital time');
  assert(s.keys.join(',') === 'face-digital,face-analog,face-sun,look-auto,look-day,look-night,lang-en,lang-es,guest-off,guest-on', 'Analog page options: ' + s.keys.join(','));
  assert(s.focused === 'face-analog', 'focus after the switch: ' + s.focused);
  assert(!/\d{1,2}:\d{2}|\b[AP]M\b/.test(s.text), 'the Analog page text has a time: ' + s.text);
  let t = await clockPage.tile(page);
  assert(t.face === 'analog', 'the tile did not follow to Analog');
  assertNoDigitalTime(t, 'tile after the switch');
  // With no 12/24 group, Down goes straight to the language; Up comes back
  // to the face choice, Up again reaches the page's button and Down comes
  // back to the face choice.
  await page.keyboard.press('ArrowDown');
  await sleep(100);
  s = await clockPage.state(page);
  assert(/^look-/.test(s.focused || ''), 'focus after Down: ' + s.focused);
  await page.keyboard.press('ArrowUp');
  await sleep(100);
  s = await clockPage.state(page);
  assert(/^face-/.test(s.focused || ''), 'focus after Down, Up: ' + s.focused);
  await page.keyboard.press('ArrowUp');
  await sleep(100);
  s = await clockPage.state(page);
  assert(/panel-btn/.test(s.focused || ''), 'focus after Up: ' + s.focused);
  await page.keyboard.press('ArrowDown');
  await sleep(100);
  s = await clockPage.state(page);
  assert(/^face-/.test(s.focused || ''), 'focus after Up, Down: ' + s.focused);

  await clockPage.pick(page, 'face-digital');
  t = await clockPage.tile(page);
  assert(t.face === 'digital' && t.digits === '2:41' && t.ampm === 'PM', 'tile back on Digital: ' + JSON.stringify(t));
  await clockPage.pick(page, 'hours-24');
  t = await clockPage.tile(page);
  assert(t.digits === '14:41' && t.ampm === '', 'tile on 24-hour: ' + t.digits);
  s = await clockPage.state(page);
  assert(s.focused === 'hours-24', 'focus after 24-hour: ' + s.focused);
  // Analog again from the 12/24 group: the group goes, focus lands on the face choice.
  await clockPage.pick(page, 'face-analog');
  s = await clockPage.state(page);
  assert(s.focused === 'face-analog' && s.keys.length === 10, 'Analog from 24-hour: ' + JSON.stringify(s));
  await clockPage.close(page);

  // Closed, on Analog: one more once-a-second loop (the tile's), not more.
  const analogTimers = await secondTimersIn(page, 2100);
  assert(analogTimers >= base + 1 && analogTimers <= base + 3, 'timers in 2 s: ' + analogTimers + ' (digital: ' + base + ')');

  // Back to Digital: the tile's loop stops.
  await clockPage.open(page);
  await clockPage.pick(page, 'face-digital');
  await clockPage.close(page);
  const after = await secondTimersIn(page, 2100);
  assert(after <= base, 'timers in 2 s back on Digital: ' + after + ' (before: ' + base + ')');
  t = await clockPage.tile(page);
  assert(t.face === 'digital' && t.digits === '14:41', 'tile: ' + JSON.stringify(t));

  // Remembered: a reload comes back on Digital 24-hour; Analog keeps 24 for later.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.cell[data-widget="today"] .today-digits'));
  t = await clockPage.tile(page);
  assert(t.digits === '14:41', 'after a reload: ' + t.digits);
  noErrors(page);
}

async function checkPageOpensOnAnalog() {
  const page = await openHub({ face: 'analog', hours: '12', at: SUNDAY });
  await clockPage.open(page);
  const s = await clockPage.state(page);
  assert(s.face === 'analog' && !s.readout && s.keys.join(',') === 'face-digital,face-analog,face-sun,look-auto,look-day,look-night,lang-en,lang-es,guest-off,guest-on', JSON.stringify(s));
  assert(s.focused === 'face-analog', 'opened on ' + s.focused);
  const win = await page.evaluate(() => document.querySelector('#panel .clock-window-text').textContent);
  assert(win === 'SUN 15', 'page window: ' + win);
  // Right then Left moves along the one group; OK on Digital works.
  await page.keyboard.press('ArrowLeft');
  await sleep(100);
  assert((await clockPage.state(page)).focused === 'face-digital', 'Left did not reach Digital');
  if (SHOTS) {
    await page.keyboard.press('ArrowRight');
    await sleep(150);
    await page.screenshot({ path: path.join(SHOTS, '6-page-analog.png') });
  }
  await clockPage.pick(page, 'face-digital');
  const d = await clockPage.state(page);
  assert(d.readout && d.keys.indexOf('hours-12') >= 0, 'Digital page: ' + JSON.stringify(d));
  if (SHOTS) {
    await clockPage.pick(page, 'hours-12');
    await page.screenshot({ path: path.join(SHOTS, '7-page-digital.png') });
  }
  noErrors(page);
}

async function checkSizes(spanish, at, crops) {
  const expectDay = { '1x1': 'day', '2x1': 'day', '2x2': 'full', '3x4': 'full' };
  for (const [w, h] of SIZES) {
    const page = await openHub({ face: 'analog', layout: [w, h], at: at, spanish: spanish });
    const name = w + 'x' + h;
    if (h === 1 && w >= 3) {
      // A wide strip: the small face, the time and the date, nothing cut.
      const t = await clockPage.tile(page);
      assert(t.face === 'mini', name + ': face ' + t.face);
      const cut = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('.today-mini-time, .today-mini-date'),
        (n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).map((n) => n.textContent));
      assert(!cut.length, name + ': cut ' + cut.join(' | '));
      if (crops) {
        const box = await page.locator('.cell[data-widget="today"]').boundingBox();
        crops.push({ name: name, png: (await page.screenshot({ clip: box })).toString('base64'), w: box.width, h: box.height, win: '' });
      }
      noErrors(page);
      await page.context().close();
      continue;
    }
    const m = await measure(page);
    checkWindowFits(m, name);
    const t = await clockPage.tile(page);
    assertNoDigitalTime(t, name);
    if (expectDay[name]) assert(t.windowMode === expectDay[name], name + ': window ' + t.windowMode);
    // The face fills the short side (less the padding) and is centred.
    assert(m.fill > 0.62, name + ': the face is small for the tile (' + m.fill.toFixed(2) + ')');
    assert(m.offCentre < 1.5, name + ': the face is ' + m.offCentre.toFixed(1) + 'px off centre');
    if (spanish && t.windowMode === 'full') {
      assert(/^(SÁB|MIÉ) \d+$/.test(t.window), name + ': Spanish window "' + t.window + '"');
    }
    if (crops) {
      const box = await page.locator('.cell[data-widget="today"]').boundingBox();
      crops.push({ name: name, png: (await page.screenshot({ clip: box })).toString('base64'), w: box.width, h: box.height, win: t.window });
    }
    noErrors(page);
    await page.context().close();
  }
}

// One picture of the crops, each with its size under it.
async function composite(crops, file, title) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 400 }, deviceScaleFactor: 1 });
  const html = '<body style="margin:0;padding:28px;background:#14161b;font:16px Arial,sans-serif;color:#c9ccd3">' +
    '<div style="font-size:20px;color:#fff;margin:0 0 18px">' + title + '</div>' +
    '<div style="display:flex;flex-wrap:wrap;align-items:flex-end">' +
    crops.map((c) => '<div style="margin:0 26px 26px 0"><img style="display:block;width:' + c.w + 'px;height:' + c.h + 'px" src="data:image/png;base64,' + c.png + '">' +
      '<div style="margin-top:6px">' + c.name + (c.win ? ' · window “' + c.win + '”' : '') + '</div></div>').join('') + '</div></body>';
  await page.setContent(html);
  const h = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 1920, height: Math.ceil(h) });
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

async function checkSizesEnglish() {
  const crops = SHOTS ? [] : null;
  await checkSizes(false, SUNDAY, crops);
  if (SHOTS) {
    const want = ['12x1', '3x1', '2x1', '1x1', '2x2', '3x4'];
    await composite(want.map((n) => crops.find((c) => c.name === n)), path.join(SHOTS, '4-analog-sizes.png'),
      'Analog Clock tile at 12×1, 3×1, 2×1, 1×1, 2×2 and 3×4 (Sunday 15 November 2026, 10:09)');
    await composite(crops, path.join(SHOTS, '4b-analog-all-sizes.png'), 'Analog Clock tile at every size tested');
  }
}

async function checkSizesSpanish() {
  const crops = SHOTS ? [] : null;
  await checkSizes(true, SATURDAY, crops);
  const crops2 = SHOTS ? [] : null;
  await checkSizes(true, WEDNESDAY, crops2);
  if (SHOTS) {
    const want = ['2x2', '3x2', '3x4', '6x3', '1x1', '3x1'];
    const pick = (list, label) => want.map((n) => { const c = list.find((x) => x.name === n); return Object.assign({}, c, { name: label + ' ' + n }); });
    await composite(pick(crops, 'sábado').concat(pick(crops2, 'miércoles')), path.join(SHOTS, '5-analog-spanish.png'),
      'Analog Clock tile with Spanish dates: sábado 21 and miércoles 18 de noviembre de 2026');
  }
  // The page's window too, in Spanish.
  const page = await openHub({ face: 'analog', at: SATURDAY, spanish: true });
  await clockPage.open(page);
  const w = await page.evaluate(() => {
    const t = document.querySelector('#panel .clock-window-text');
    return { text: t.textContent, len: t.getAttribute('textLength') ? +t.getAttribute('textLength') : t.getComputedTextLength() };
  });
  assert(w.text === 'SÁB 21' && w.len <= 56, 'page window: ' + JSON.stringify(w));
  noErrors(page);
}

// The controls column on the open page: every label whole, with room for
// 25% longer text, and tall enough for accents (Á, Ñ) above the capitals.
function controlsFit(page) {
  return page.evaluate(() => {
    const out = [];
    const box = document.querySelector('.clock-controls').getBoundingClientRect();
    const labels = document.querySelectorAll('.clock-controls .clock-group-label, .clock-controls .clock-opt-label');
    for (const el of labels) {
      const text = el.textContent;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      const r = el.getBoundingClientRect();
      if (el.scrollWidth > el.clientWidth + 1) out.push('"' + text + '" is cut');
      if (el.scrollHeight > el.clientHeight + 1 || r.height < fs * 1.25 - 0.5) out.push('"' + text + '" is too short for accents (' + r.height.toFixed(1) + ' for ' + fs + 'px)');
      if (r.right > box.right + 0.5 || r.left < box.left - 0.5) out.push('"' + text + '" spills out of the controls');
      el.textContent = text + text.slice(0, Math.ceil(text.length * 0.25));
      if (el.scrollWidth > el.clientWidth + 1) out.push('"' + el.textContent + '" (+25%) would be cut');
      el.textContent = text;
    }
    const panel = document.querySelector('#panel .panel-body').getBoundingClientRect();
    if (box.bottom > panel.bottom + 0.5 || box.top < panel.top - 0.5) out.push('the controls do not fit the panel body');
    return out;
  });
}

async function checkLook() {
  const page = await openHub({ face: 'digital', hours: '12', layout: [3, 2], at: AFTERNOON });
  const body = (c) => page.evaluate((k) => document.body.classList.contains(k), c);
  await clockPage.open(page);
  let label = await page.evaluate(() => document.querySelectorAll('.clock-group-label')[2].textContent);
  assert(label === 'Look', 'group label: ' + label);
  assert(await page.evaluate(() => document.querySelector('.clock-opt[data-key="look-auto"]').classList.contains('is-selected')), 'Auto not marked at first');
  await clockPage.pick(page, 'look-night');
  await until(() => body('theme-night'), 3000, 'Dark did not paint the night look');
  assert(await page.evaluate(() => localStorage.getItem('homeHub.look') === 'night'), 'Dark not remembered');
  await clockPage.pick(page, 'look-day');
  await until(() => body('theme-day'), 3000, 'Light did not paint the day look');
  assert(await page.evaluate(() => localStorage.getItem('homeHub.look') === 'day'), 'Light not remembered');
  await clockPage.pick(page, 'look-auto');
  assert(await page.evaluate(() => localStorage.getItem('homeHub.look') === null), 'Auto should clear the choice');
  await clockPage.pick(page, 'look-night');
  await page.reload();
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="today"] .tile-body *'));
  assert(await body('theme-night'), 'Dark not kept after a reload');
  await clockPage.open(page);
  await clockPage.pick(page, 'lang-es');
  label = await page.evaluate(() => document.querySelectorAll('.clock-group-label')[2].textContent);
  assert(label === 'Aspecto', 'Spanish label: ' + label);
  let bad = await controlsFit(page);
  assert(!bad.length, 'Spanish panel: ' + bad.join('; '));
  await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() &&
    !!document.querySelector('.clock-page.is-full')), 4000, 'no full screen');
  bad = await controlsFit(page);
  assert(!bad.length, 'Spanish full screen: ' + bad.join('; '));
  const fs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.clock-opt[data-key="lang-en"]')).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize));
  assert(fs > 1, 'full screen pills shrank: ' + fs + 'rem');
  noErrors(page);
}

async function checkLanguage() {
  const page = await openHub({ face: 'digital', hours: '12', layout: [3, 2], at: AFTERNOON });
  assert(await page.evaluate(() => window.HUB_I18N.lang()) === 'en', 'starts in English');
  await clockPage.open(page);
  let label = await page.evaluate(() => document.querySelectorAll('.clock-group-label')[3].textContent);
  assert(label === 'Language', 'group label: ' + label);
  let s = await clockPage.state(page);
  assert(s.keys.slice(-4, -2).join(',') === 'lang-en,lang-es', 'keys: ' + s.keys.join(','));
  let bad = await controlsFit(page);
  assert(!bad.length, 'English panel: ' + bad.join('; '));
  await clockPage.pick(page, 'lang-es');
  s = await clockPage.state(page);
  assert(s.focused === 'lang-es', 'focus after Español: ' + s.focused);
  label = await page.evaluate(() => document.querySelectorAll('.clock-group-label')[3].textContent);
  assert(label === 'Idioma', 'group label in Spanish: ' + label);
  assert(await page.evaluate(() => window.HUB_I18N.lang() === 'es' && localStorage.getItem('homeHub.lang') === 'es' &&
    document.documentElement.lang === 'es'), 'not saved as Spanish');
  assert(await page.evaluate(() => document.querySelector('.clock-opt[data-key="lang-es"]').classList.contains('is-selected')), 'Español not marked');
  bad = await controlsFit(page);
  assert(!bad.length, 'Spanish panel: ' + bad.join('; '));
  // Full screen, Digital and Analog.
  await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() &&
    !!document.querySelector('.clock-page.is-full')), 4000, 'no full screen');
  bad = await controlsFit(page);
  assert(!bad.length, 'Spanish full screen: ' + bad.join('; '));
  await clockPage.pick(page, 'face-analog');
  bad = await controlsFit(page);
  assert(!bad.length, 'Spanish full screen, Analog: ' + bad.join('; '));
  await clockPage.close(page);
  // Remembered after a reload; back to English from the page.
  await page.reload();
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="today"] .tile-body *'));
  assert(await page.evaluate(() => window.HUB_I18N.lang()) === 'es', 'not Spanish after a reload');
  await clockPage.open(page);
  bad = await controlsFit(page);
  assert(!bad.length, 'Spanish panel, Analog: ' + bad.join('; '));
  await clockPage.pick(page, 'lang-en');
  assert(await page.evaluate(() => window.HUB_I18N.lang() === 'en' && localStorage.getItem('homeHub.lang') === 'en'), 'not back to English');
  noErrors(page);
}

// A short clip: open the Clock page, Digital to Analog (the tile behind
// changes), back to Digital, then 12/24 and back. Motion "fade" leaves the
// tiles where they are, so the Clock tile shows beside the page.
async function clip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-clip-'));
  const page = await openHub({ face: 'digital', hours: '12', video: dir, motion: 'fade' });
  const pause = (ms) => sleep(ms);
  await pause(700);
  await clockPage.open(page);
  await pause(900);
  await clockPage.pick(page, 'face-analog');
  await pause(2000);
  await clockPage.pick(page, 'face-digital');
  await pause(1100);
  await clockPage.pick(page, 'hours-24');
  await pause(1000);
  await clockPage.pick(page, 'hours-12');
  await pause(800);
  await clockPage.pick(page, 'face-analog');
  await pause(1000);
  await clockPage.close(page);
  await pause(1000);
  const video = page.video();
  await page.context().close();
  const webm = await video.path();
  const out = path.join(SHOTS, 'clock-face-switch.mp4');
  childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', out]);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Every Sun path text on the tile and the page whole (it may shrink to
// 72%, never be cut), and tall enough for accents.
function sunCut(page) {
  return page.evaluate(() => Array.prototype.filter.call(
    document.querySelectorAll('.today-sun-time, .today-sun-date, .today-sun-next, .sun-time, .sun-k, .sun-v, .sun-note, .sun-date'),
    (n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).map((n) => n.className + ' "' + n.textContent + '"'));
}

const SUN_DAY = Date.parse('2026-11-15T16:09:30Z');      // Sun 15 Nov, 10:09 AM Central
const SUN_NIGHT = Date.parse('2026-11-16T03:40:00Z');    // Sun 15 Nov, 9:40 PM
const NEW_MOON = Date.parse('2026-11-10T03:40:00Z');     // Mon 9 Nov, 9:40 PM: the new moon

async function checkSunPath() {
  // Day, on Ian's 3x1: the arc with the sun, "Nov 15", "Sunset 5:2x PM".
  let page = await openHub({ face: 'sun', hours: '12', at: SUN_DAY });
  let t = await clockPage.tile(page);
  assert(t.face === 'sun' && !t.night && !t.moon, 'day tile: ' + JSON.stringify(t));
  assert(/10:09/.test(t.text) && /Nov 15/.test(t.text) && /Sunset 5:2\d\u00a0PM/.test(t.text), 'day tile text: ' + t.text);
  let cut = await sunCut(page);
  assert(!cut.length, 'day tile cut: ' + cut.join(' | '));
  await clockPage.open(page);
  let s = await clockPage.state(page);
  assert(s.face === 'sun' && s.readout, 'page: ' + JSON.stringify(s));
  assert(s.keys.join(',') === 'face-digital,face-analog,face-sun,hours-12,hours-24,look-auto,look-day,look-night,lang-en,lang-es,guest-off,guest-on', 'keys: ' + s.keys.join(','));
  assert(s.focused === 'face-sun', 'opened on ' + s.focused);
  // Dallas, 15 November: sunrise about 6:58 AM, sunset about 5:24 PM (NOAA).
  assert(/Sunrise6:5\d\u00a0AM/.test(s.text) && /Daylight left7 h \d+ min/.test(s.text) && /Sunset5:2\d\u00a0PM/.test(s.text), 'day page: ' + s.text);
  assert(/Day length 10 h \d+ min · 1 min shorter than yesterday/.test(s.text), 'day note: ' + s.text);
  assert(/Sunday, November 15/.test(s.text) && !/2026/.test(s.text), 'date: ' + s.text);
  cut = await sunCut(page);
  assert(!cut.length, 'day page cut: ' + cut.join(' | '));
  let bad = await controlsFit(page);
  assert(!bad.length, 'controls: ' + bad.join('; '));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '11-sun-page-day.png') });
  // 24-hour applies here too.
  await clockPage.pick(page, 'hours-24');
  t = await clockPage.tile(page);
  assert(/10:09/.test(t.text) && /Sunset 17:2\d/.test(t.text), '24-hour tile: ' + t.text);
  noErrors(page);
  await page.context().close();

  // Night: the same arc, sunset to sunrise, the moon (waxing crescent) on it.
  page = await openHub({ face: 'sun', hours: '12', at: SUN_NIGHT });
  t = await clockPage.tile(page);
  assert(t.face === 'sun' && t.night && t.moon === 'lit', 'night tile: ' + JSON.stringify(t));
  assert(/9:40/.test(t.text) && /Sunrise 6:5\d\u00a0AM/.test(t.text), 'night tile text: ' + t.text);
  await clockPage.open(page);
  s = await clockPage.state(page);
  assert(/Sunset5:2\d\u00a0PM/.test(s.text) && /Sunrise in9 h \d+ min/.test(s.text) && /Sunrise6:5\d\u00a0AM/.test(s.text), 'night page: ' + s.text);
  assert(/Tomorrow: 10 h \d+ min of daylight/.test(s.text), 'night note: ' + s.text);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '12-sun-page-night.png') });
  // Back to Analog from the page: the tile follows.
  await clockPage.pick(page, 'face-analog');
  t = await clockPage.tile(page);
  assert(t.face === 'mini', 'tile after Analog: ' + t.face);
  noErrors(page);
  await page.context().close();

  // The new moon: only the dark disc.
  page = await openHub({ face: 'sun', at: NEW_MOON });
  t = await clockPage.tile(page);
  assert(t.night && t.moon === 'new', 'new moon: ' + JSON.stringify(t));
  noErrors(page);
  await page.context().close();
}

async function checkSunSpanish() {
  // Spanish, the longest date (miércoles 18), on the tile, the page and full screen.
  for (const at of [Date.parse('2026-11-18T16:09:30Z'), Date.parse('2026-11-19T03:40:00Z')]) {
    const page = await openHub({ face: 'sun', hours: '12', at: at, spanish: true });
    await page.evaluate(() => window.HUB_I18N.setLang('es'));
    await sleep(200);
    const t = await clockPage.tile(page);
    assert(/18 nov/.test(t.text) && /(Atardecer|Amanecer) \d/.test(t.text), 'Spanish tile: ' + t.text);
    let cut = await sunCut(page);
    assert(!cut.length, 'Spanish tile cut: ' + cut.join(' | '));
    await clockPage.open(page);
    const s = await clockPage.state(page);
    assert(/miércoles, 18 de noviembre/.test(s.text), 'Spanish page: ' + s.text);
    assert(/Luz que queda|Amanece en/.test(s.text) && /Duración del día|Mañana:/.test(s.text), 'Spanish figures: ' + s.text);
    cut = await sunCut(page);
    assert(!cut.length, 'Spanish page cut: ' + cut.join(' | '));
    let bad = await controlsFit(page);
    assert(!bad.length, 'Spanish controls: ' + bad.join('; '));
    await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
    await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() &&
      !!document.querySelector('.clock-page.is-full')), 4000, 'no full screen');
    cut = await sunCut(page);
    assert(!cut.length, 'Spanish full screen cut: ' + cut.join(' | '));
    bad = await controlsFit(page);
    assert(!bad.length, 'Spanish full screen controls: ' + bad.join('; '));
    const inside = await page.evaluate(() => {
      const d = document.querySelector('.clock-display').getBoundingClientRect();
      const p = document.querySelector('.sun-page').getBoundingClientRect();
      return p.bottom <= d.bottom + 0.5 && p.top >= d.top - 0.5;
    });
    assert(inside, 'the Sun path page spills out of full screen');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '13-sun-full-es-' + (at % 2) + '.png') });
    noErrors(page);
    await page.context().close();
  }
}

async function checkSunSizes() {
  // Every size: the arc inside the tile, no text cut.
  for (const [w, h] of SIZES) {
    const page = await openHub({ face: 'sun', layout: [w, h], at: SUN_DAY });
    const name = w + 'x' + h;
    const t = await clockPage.tile(page);
    assert(t.face === 'sun', name + ': face ' + t.face);
    const cut = await sunCut(page);
    assert(!cut.length, name + ': cut ' + cut.join(' | '));
    const inside = await page.evaluate(() => {
      const tile = document.querySelector('.cell[data-widget="today"] .tile').getBoundingClientRect();
      const svg = document.querySelector('.cell[data-widget="today"] .sun-svg').getBoundingClientRect();
      return svg.width > 20 && svg.left >= tile.left - 0.5 && svg.right <= tile.right + 0.5 && svg.top >= tile.top - 0.5 && svg.bottom <= tile.bottom + 0.5;
    });
    assert(inside, name + ': the arc spills out of the tile');
    noErrors(page);
    await page.context().close();
  }
}

/* ---------- run ---------- */

async function main() {
  PAGE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await waitForPort(PAGE_PORT);
  browser = await chromium.launch();

  await check('1. Digital, 12-hour: the tile shows 2:41 PM and the date', checkDigital12);
  await check('2. Digital, 24-hour: the tile shows 14:41', checkDigital24);
  await check('3. Analog: a 3x1 strip shows the small face, the time and the date; a 2x1 only the face, the day in the window', checkAnalog);
  await check('4. Analog: the second hand turns once a second', checkSecondHand);
  await check('5. Changes on the page redraw the tile at once; the tile\'s loop starts and stops', checkLiveSwitch);
  await check('6. The page on Analog: no digital time, no 12/24 group, focus and arrows fine', checkPageOpensOnAnalog);
  await check('7. Analog at ' + SIZES.length + ' tile sizes: face inside and centred, the window text fits', checkSizesEnglish);
  await check('8. The same in Spanish (sábado, miércoles), on the tile and the page', checkSizesSpanish);
  await check('8b. Look on the page: Auto, Light, Dark, remembered, Spanish fits', checkLook);
  await check('9. Language on the page: English and Español, remembered, fits +25% in the panel and full screen', checkLanguage);
  await check('11. Sun path: day and night on the tile and the page, sunrise and sunset, the moon', checkSunPath);
  await check('12. Sun path in Spanish: tile, page and full screen, nothing cut', checkSunSpanish);
  await check('13. Sun path at ' + SIZES.length + ' tile sizes: the arc inside, nothing cut', checkSunSizes);
  if (SHOTS) await check('10. Clip of the face switch', clip);
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
