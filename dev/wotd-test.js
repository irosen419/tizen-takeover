/*
 * Word of the day and the hub's languages, end to end: node dev/wotd-test.js
 *
 * Runs the real hub in headless Chromium at 1920x1080 against the preview
 * (dev/preview.js, without live updates), with the clock fixed in Chicago:
 *
 *   - app/i18n.js: Spanish strings, the English fallback for a missing key,
 *     {vars}, onChange and stopping it, the choice kept in localStorage,
 *     ?lang=es for one load only (not saved), a TV whose storage throws,
 *     and the Spanish day and month names (not the browser's).
 *   - The word list: 366 words, every field filled, an article on every
 *     noun, no word longer than 12 letters.
 *   - The pick: by the local day of the year (1 January is the first word,
 *     31 December the 365th or, in a leap year, the 366th), the same from
 *     00:00:01 to 23:59:59, across both 2026 clock changes, and a new word
 *     just after midnight without a reload.
 *   - The tile at 1x1, 2x1, 3x1, 6x1, 12x1, 1x3, 2x2, 3x2, 6x2, 3x4, 4x3 and
 *     2x6, in English and in Spanish, for today's word and the longest one:
 *     what each size shows, nothing past the tile's body, nothing cut
 *     sideways, no type under 0.85rem (0.8rem for the one word in a
 *     1-column tile), every line at least 1.25 times its type size (room
 *     for á, É, ñ, ¿ and ¡). Then every one of the 366 words at the tight
 *     sizes in Spanish.
 *   - The panel and full screen in both languages, for every word: all of
 *     it inside the panel.
 *   - A language change redraws the tile and the open panel with their
 *     Spanish title.
 *
 * --shots <folder> (or WOTD_TEST_SHOTS) also saves the docs/screenshots/
 * pictures: each size in English and Spanish, the panel, full screen and
 * the Clock page's Language choice.
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
const clockPage = require('./clock-page');

const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host')];
const ZONE = 'America/Chicago';
const argShots = process.argv.indexOf('--shots');
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.WOTD_TEST_SHOTS || '');

// Tuesday 17 November 2026, 10:40 AM in Chicago: the 321st day, "darse cuenta".
const TODAY = Date.parse('2026-11-17T16:40:00Z');
// Thursday 26 November 2026: the longest word, "el Día de Acción de Gracias".
const LONGEST = Date.parse('2026-11-26T16:40:00Z');

const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [1, 3], [2, 2], [3, 2], [6, 2], [3, 4], [4, 3], [2, 6]];
const TIGHT = [[1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [3, 4]];

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

// opts: { lang, layout: [w, h] for the word tile alone, or a full layout,
// at: fixed time (ms), query: extra address text, storageThrows }
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
  const storage = {};
  if (opts.lang) storage['homeHub.lang'] = opts.lang;
  if (opts.layout) {
    storage['homeHub.layout'] = JSON.stringify(typeof opts.layout[0] === 'number' ?
      [{ widget: 'wotd', x: 0, y: 0, w: opts.layout[0], h: opts.layout[1] }] : opts.layout);
  }
  await context.addInitScript((items) => {
    try {
      if (!sessionStorage.getItem('wotdTestSeeded')) {
        sessionStorage.setItem('wotdTestSeeded', '1');
        localStorage.clear();
        for (const k in items) localStorage.setItem(k, items[k]);
      }
    } catch (e) { /* ignore */ }
  }, storage);
  if (opts.storageThrows) {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('storage is off'); } });
    });
  }
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    context.errors.push(m.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  if (opts.at) await page.clock.install({ time: opts.at });
  await page.goto(PAGE + '/?motion=' + (opts.motion || 'push') + '&live=off&clay=off' + (opts.query || ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelector('#grid .tile-body *'));
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  return page;
}

function noErrors(page) {
  const errors = page.context().errors.filter((e) => !/net::ERR_FAILED|Failed to load resource/.test(e));
  assert(!errors.length, 'console errors: ' + errors.join(' | '));
}

// Redraws the tile (and an open panel) for the page's clock now, the way a
// language change does, without changing the language.
function redraw(page) {
  return page.evaluate(() => {
    const L = window.HUB_I18N;
    const was = L.lang();
    L.setLang(was === 'en' ? 'es' : 'en');
    L.setLang(was);
  });
}

/* ---------- measuring ---------- */

// Everything about the drawn word tile, and every fit problem in it.
function measureTile(page) {
  return page.evaluate(() => {
    const cell = document.querySelector('.cell[data-widget="wotd"]');
    const tile = cell.querySelector('.tile');
    const body = cell.querySelector('.tile-body');
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const one = body.classList.contains('wotd-tile-one');
    const b = body.getBoundingClientRect();
    const problems = [];
    const shown = (el) => { for (let e = el; e && e !== body; e = e.parentElement) { if (getComputedStyle(e).display === 'none') return false; } return true; };
    const els = body.querySelectorAll('*');
    for (const el of els) {
      if (!shown(el) || !el.textContent.trim()) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const name = el.className + ' "' + el.textContent.slice(0, 30) + '"';
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
        problems.push(name + ' is outside the tile body (' + [r.left - b.left, b.right - r.right, r.top - b.top, b.bottom - r.bottom].map((n) => n.toFixed(1)).join(', ') + ')');
      }
      if (el.scrollWidth > el.clientWidth + 1 && cs.display !== 'inline') problems.push(name + ' is cut sideways');
      if (el.children.length) continue;
      const fs = parseFloat(cs.fontSize);
      const min = one ? 0.8 : 0.85;
      if (fs < min * rem - 0.2) problems.push(name + ' type ' + (fs / rem).toFixed(2) + 'rem');
      const lh = parseFloat(cs.lineHeight);
      if (lh && lh < fs * 1.25 - 0.2) problems.push(name + ' line-height ' + (lh / fs).toFixed(2) + ' of its type');
      if (cs.webkitLineClamp === 'none' && cs.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 1) problems.push(name + ' is cut at the top or bottom');
    }
    if (body.querySelector('.is-cut')) problems.push('the strip ends in "..."');
    const q = (sel) => { const e = body.querySelector(sel); return e && shown(e) ? e.textContent : null; };
    const head = tile.querySelector('.tile-head');
    const title = tile.querySelector('.tile-title');
    return {
      problems: problems,
      tier: one ? 'one' : body.classList.contains('wotd-tile-strip') ? 'strip' : body.classList.contains('wotd-tile-tall') ? 'tall' : 'standard',
      index: +body.getAttribute('data-word'),
      text: body.textContent,
      es: q('.wotd-es'), en: q('.wotd-en'), pos: q('.wotd-pos'), say: q('.wotd-say'), def: q('.wotd-def'), ex: q('.wotd-ex'), exEn: q('.wotd-ex-en'),
      headShown: !!head && getComputedStyle(head).display !== 'none',
      // The full name (a narrow tile shows its short form, keeping the name in data-full).
      title: title ? (title.getAttribute('data-full') || title.textContent) : null,
      shown: title ? title.textContent : null
    };
  });
}

function measurePanel(page) {
  return page.evaluate(() => {
    const body = document.querySelector('#panel .panel-body');
    const b = body.getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const problems = [];
    for (const el of body.querySelectorAll('.wotd-panel *')) {
      if (!el.textContent.trim()) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const name = el.className + ' "' + el.textContent.slice(0, 30) + '"';
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) problems.push(name + ' is outside the panel');
      if (el.scrollWidth > el.clientWidth + 1) problems.push(name + ' is cut sideways');
      if (el.children.length) continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < rem - 0.2 && !/wotd-p-date|wotd-sec-label|wotd-ex-en|wotd-def-other/.test(el.className)) problems.push(name + ' type ' + (fs / rem).toFixed(2) + 'rem');
      if (fs < 0.75 * rem - 0.2) problems.push(name + ' type ' + (fs / rem).toFixed(2) + 'rem');
      const lh = parseFloat(cs.lineHeight);
      if (lh && lh < fs * 1.2 - 0.2) problems.push(name + ' line-height ' + (lh / fs).toFixed(2));
    }
    const q = (sel) => { const e = body.querySelector(sel); return e ? e.textContent : null; };
    return {
      problems: problems,
      title: document.querySelector('#panel .panel-title').textContent,
      date: q('.wotd-p-date'), es: q('.wotd-es'), say: q('.wotd-say'), def: q('.wotd-def'), other: q('.wotd-def-other'),
      ex: q('.wotd-ex'), exEn: q('.wotd-ex-en'), labels: Array.prototype.map.call(body.querySelectorAll('.wotd-sec-label'), (e) => e.textContent)
    };
  });
}

async function openWord(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'busy');
  if (await page.evaluate(() => window.HUB_TEST.open()) === 'wotd') return;
  assert(await page.evaluate(() => window.HUB_TEST.openPanel('wotd')), 'the word panel did not open');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'wotd' && !window.HUB_TEST.busy() && !!document.querySelector('.wotd-panel')), 4000, 'the word panel did not open');
}

async function fullScreen(page) {
  await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.wotd-panel.is-full')), 4000, 'no full screen');
}

async function crop(page, file) {
  const box = await page.locator('.cell[data-widget="wotd"] .tile').boundingBox();
  // The tile's soft edge: a few pixels of the background around it.
  const pad = 6;
  await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
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

async function checkI18n() {
  const page = await openHub({ layout: [3, 2], at: TODAY });
  const r = await page.evaluate(() => {
    const L = window.HUB_I18N;
    const out = {};
    out.start = L.lang();
    out.enTitle = L.t('wotd.title', 'Word of the day');
    out.enMissing = L.t('no.such.key', 'Fallback {n}', { n: 3 });
    out.calls = [];
    const stop = L.onChange((l) => out.calls.push(l));
    out.badLang = L.setLang('fr');
    out.changed = L.setLang('es');
    out.same = L.setLang('es');
    out.esTitle = L.t('wotd.title', 'Word of the day');
    out.esMissing = L.t('no.such.key', 'Only in English');
    out.esVars = L.t('wotd.level', 'Level {level}', { level: 'B1' });
    out.esUnfilled = L.t('wotd.level', 'Level {level}');
    out.keyOnly = L.t('no.such.key');
    out.saved = localStorage.getItem('homeHub.lang');
    out.htmlLang = document.documentElement.lang;
    const d = new Date(2026, 10, 18);
    out.esDate = L.longDate(d);
    out.esShort = L.dayName(d, true) + ' ' + L.monthName(d, true);
    out.enDate = L.longDate(d, 'en');
    stop();
    L.setLang('en');
    out.callsAfterStop = out.calls.slice();
    // The page's own Spanish dates, not the browser's.
    out.usesBrowser = /toLocaleDateString/.test(L.longDate.toString());
    return out;
  });
  assert(r.start === 'en', 'start: ' + r.start);
  assert(r.enTitle === 'Word of the day' && r.esTitle === 'Palabra del día', 'titles: ' + r.enTitle + ' / ' + r.esTitle);
  assert(r.enMissing === 'Fallback 3' && r.esMissing === 'Only in English' && r.keyOnly === 'no.such.key', 'fallback: ' + JSON.stringify(r));
  assert(r.esVars === 'Nivel B1' && r.esUnfilled === 'Nivel {level}', 'vars: ' + r.esVars + ' / ' + r.esUnfilled);
  assert(r.badLang === false && r.changed === true && r.same === false, 'setLang answers: ' + JSON.stringify(r));
  assert(r.callsAfterStop.join(',') === 'es', 'onChange calls: ' + r.callsAfterStop.join(','));
  assert(r.saved === 'es' && r.htmlLang === 'es', 'saved: ' + r.saved + ', html lang ' + r.htmlLang);
  assert(r.esDate === 'miércoles, 18 de noviembre' && r.esShort === 'mié nov' && r.enDate === 'Wednesday, November 18', 'dates: ' + JSON.stringify([r.esDate, r.esShort, r.enDate]));
  assert(!r.usesBrowser, 'longDate uses the browser');
  noErrors(page);
  await page.context().close();

  // ?lang=es: Spanish for this load, nothing saved; a saved choice wins again without it.
  const q = await openHub({ layout: [3, 2], at: TODAY, query: '&lang=es', lang: 'en' });
  let s = await q.evaluate(() => ({ lang: window.HUB_I18N.lang(), saved: localStorage.getItem('homeHub.lang'), title: document.querySelector('.cell[data-widget="wotd"] .tile-title').textContent }));
  assert(s.lang === 'es' && s.saved === 'en' && s.title === 'Palabra del día', '?lang=es: ' + JSON.stringify(s));
  noErrors(q);
  await q.context().close();

  // Saved Spanish comes back after a reload.
  const sv = await openHub({ layout: [3, 2], at: TODAY, lang: 'es' });
  s = await sv.evaluate(() => window.HUB_I18N.lang());
  assert(s === 'es', 'saved es: ' + s);
  await sv.context().close();

  // A TV whose storage throws: English, and switching still works.
  const off = await openHub({ layout: [3, 2], at: TODAY, storageThrows: true });
  s = await off.evaluate(() => { const a = window.HUB_I18N.lang(); const ok = window.HUB_I18N.setLang('es'); return a + ',' + ok + ',' + window.HUB_I18N.lang(); });
  assert(s === 'en,true,es', 'storage off: ' + s);
  noErrors(off);
}

async function checkData() {
  const page = await openHub({ layout: [3, 2], at: TODAY });
  const r = await page.evaluate(() => {
    const d = window.HUB_WOTD_DATA;
    const problems = [];
    const seen = {};
    const fields = ['es', 'en', 'pos', 'say', 'defEn', 'defEs', 'exEs', 'exEn'];
    d.forEach((w, i) => {
      fields.forEach((f) => { if (typeof w[f] !== 'string' || !w[f].trim()) problems.push(i + ' ' + f); });
      if (seen[w.es.toLowerCase()]) problems.push(i + ' repeats ' + w.es);
      seen[w.es.toLowerCase()] = true;
      if (w.pos === 'noun' && !/^(el|la|los|las) /.test(w.es)) problems.push(i + ' noun without its article: ' + w.es);
      w.es.split(/\s+/).forEach((part) => { if (part.replace(/[¿?¡!]/g, '').length > 12) problems.push(i + ' long word ' + part); });
      if (['noun', 'verb', 'adj', 'adv', 'phrase', 'conj', 'interj', 'num', 'prep', 'pron'].indexOf(w.pos) < 0) problems.push(i + ' pos ' + w.pos);
    });
    return { n: d.length, problems: problems };
  });
  assert(r.n === 366, r.n + ' words');
  assert(!r.problems.length, r.problems.slice(0, 10).join('; '));
}

async function checkPick() {
  const page = await openHub({ layout: [3, 2], at: TODAY });
  const r = await page.evaluate(() => {
    const W = window.HUB_WOTD;
    const doy = (y, m, d, h, mi, s) => W.dayOfYear(new Date(y, m, d, h || 0, mi || 0, s || 0));
    return {
      jan1: doy(2026, 0, 1), dec31: doy(2026, 11, 31), leapDec31: doy(2028, 11, 31), leapMar1: doy(2028, 2, 1),
      springForward: [doy(2026, 2, 7, 23, 59, 59), doy(2026, 2, 8, 0, 0, 1), doy(2026, 2, 8, 23, 59, 59), doy(2026, 2, 9, 0, 0, 1)],
      fallBack: [doy(2026, 10, 1, 0, 0, 1), doy(2026, 10, 1, 23, 59, 59), doy(2026, 10, 2, 0, 0, 1)],
      today: [W.pickIndex(new Date(2026, 10, 17, 0, 0, 1)), W.pickIndex(new Date(2026, 10, 17, 23, 59, 59))],
      levels: [W.level(0), W.level(89), W.level(90), W.level(242), W.level(243), W.level(365)],
      word: W.wordFor(new Date(2026, 10, 17, 12)).w.es,
      wrap: W.pickIndex(new Date(2026, 0, 5), 3)
    };
  });
  assert(r.jan1 === 0 && r.dec31 === 364 && r.leapDec31 === 365 && r.leapMar1 === 60, 'days: ' + JSON.stringify(r));
  assert(r.springForward.join(',') === '65,66,66,67', 'spring forward: ' + r.springForward.join(','));
  assert(r.fallBack.join(',') === '304,304,305', 'fall back: ' + r.fallBack.join(','));
  assert(r.today.join(',') === '320,320', 'all day: ' + r.today.join(','));
  assert(r.levels.join(',') === 'A1,A1,A2,A2,B1,B1', 'levels: ' + r.levels.join(','));
  assert(r.word === 'darse cuenta', 'today: ' + r.word);
  assert(r.wrap === 1, 'a shorter list wraps: ' + r.wrap);
  const t = await measureTile(page);
  assert(t.index === 320 && t.es === 'darse cuenta', 'tile: ' + t.index + ' ' + t.es);
  noErrors(page);
  await page.context().close();

  // Midnight: a new word without a reload, within a minute.
  const late = await openHub({ layout: [3, 2], at: Date.parse('2026-11-18T05:59:20Z') });   // 11:59:20 PM in Chicago
  assert((await measureTile(late)).index === 320, 'before midnight');
  await late.clock.runFor(90000);
  await until(async () => (await measureTile(late)).index === 321, 3000, 'no new word after midnight');
  noErrors(late);
}

const DATA = {};

async function loadData() {
  const page = await openHub({ layout: [3, 2], at: TODAY });
  DATA.words = await page.evaluate(() => window.HUB_WOTD_DATA);
  await page.context().close();
}

function expectFor(t, w, size, lang, name) {
  const [cols, rows] = size;
  assert(!t.problems.length, name + ': ' + t.problems.join('; '));
  assert(t.es === w.es, name + ': the Spanish word is "' + t.es + '"');
  if (cols === 1) {
    assert(t.tier === 'one' && t.text === w.es && !t.headShown, name + ': 1 column shows ' + JSON.stringify(t.text) + (t.headShown ? ' and the head' : ''));
    return;
  }
  assert(t.title === (lang === 'es' ? 'Palabra del día' : 'Word of the day'), name + ': title ' + t.title);
  if (t.shown !== t.title) assert(cols <= 2 && t.shown === (lang === 'es' ? 'Palabra' : 'Word'), name + ': title shown as ' + t.shown);
  if (rows === 1) {
    assert(t.tier === 'strip', name + ': tier ' + t.tier);
    if (cols >= 3) assert(t.en === w.en && /\s·\s/.test(t.text), name + ': strip without the English: ' + t.text);
    return;
  }
  assert(t.en === w.en, name + ': English "' + t.en + '"');
  if (rows === 2) {
    assert(t.tier === 'standard', name + ': tier ' + t.tier);
    if (cols >= 3) assert(t.ex === w.exEs && t.pos, name + ': standard without the example or part of speech');
    return;
  }
  assert(t.tier === 'tall', name + ': tier ' + t.tier);
  if (cols >= 3) {
    assert(t.def === (lang === 'es' ? w.defEs : w.defEn), name + ': definition "' + t.def + '"');
    assert(t.say === '[' + w.say + ']', name + ': say "' + t.say + '"');
    assert(t.ex === w.exEs, name + ': example "' + t.ex + '"');
  }
}

async function checkSizes(lang, at, shots) {
  for (const size of SIZES) {
    const page = await openHub({ layout: size, at: at, lang: lang });
    const t = await measureTile(page);
    const name = size.join('x') + ' ' + lang;
    expectFor(t, DATA.words[t.index], size, lang, name);
    if (shots) await crop(page, path.join(SHOTS, 'wotd-' + size.join('x') + '-' + lang + '.png'));
    noErrors(page);
    await page.context().close();
  }
}

// Every word at the tight sizes in Spanish (the longest labels), each drawn
// for its own day.
async function checkEveryWord(lang, sizes) {
  const bad = [];
  for (const size of sizes) {
    const page = await openHub({ layout: size, at: TODAY, lang: lang });
    for (let i = 0; i < DATA.words.length; i++) {
      // Day i of 2028 (a leap year, so all 366), at noon in Chicago.
      await page.clock.setSystemTime(new Date(Date.UTC(2028, 0, 1, 18) + i * 86400000));
      await redraw(page);
      const t = await measureTile(page);
      try { expectFor(t, DATA.words[i], size, lang, size.join('x') + ' ' + lang + ' #' + i); } catch (e) { bad.push(e.message); }
      if (t.index !== i) bad.push(size.join('x') + ': day ' + i + ' drew word ' + t.index);
    }
    noErrors(page);
    await page.context().close();
  }
  assert(!bad.length, bad.length + ' problems: ' + bad.slice(0, 6).join(' | '));
}

async function checkPanel(lang, at, shots) {
  const page = await openHub({ layout: [3, 2], at: at, lang: lang });
  await openWord(page);
  const idx = (await measureTile(page)).index;
  const w = DATA.words[idx];
  let p = await measurePanel(page);
  assert(!p.problems.length, 'panel: ' + p.problems.join('; '));
  assert(p.title === (lang === 'es' ? 'Palabra del día' : 'Word of the day'), 'panel title ' + p.title);
  assert(p.es === w.es && p.say === '[' + w.say + ']' && p.ex === w.exEs && p.exEn === w.exEn, 'panel words: ' + JSON.stringify(p));
  assert(p.def === (lang === 'es' ? w.defEs : w.defEn) && p.other === (lang === 'es' ? w.defEn : w.defEs), 'panel definitions');
  assert(p.labels.join('|') === (lang === 'es' ? 'Qué significa|Ejemplo' : 'What it means|Example'), 'labels: ' + p.labels.join('|'));
  assert(lang === 'es' ? /^Martes, 17 de noviembre · Nivel B1$|^Jueves, 26 de noviembre · Nivel B1$/.test(p.date) :
    /^Tuesday, November 17 · Level B1$|^Thursday, November 26 · Level B1$/.test(p.date), 'date line: ' + p.date);
  if (shots) await page.screenshot({ path: path.join(SHOTS, 'wotd-panel-' + lang + '.png') });
  await fullScreen(page);
  p = await measurePanel(page);
  assert(!p.problems.length, 'full screen: ' + p.problems.join('; '));
  if (shots) await page.screenshot({ path: path.join(SHOTS, 'wotd-full-' + lang + '.png') });
  noErrors(page);
}

async function checkEveryPanel(lang) {
  const page = await openHub({ layout: [3, 2], at: TODAY, lang: lang });
  await openWord(page);
  const bad = [];
  for (const mode of ['panel', 'full']) {
    if (mode === 'full') await fullScreen(page);
    for (let i = 0; i < DATA.words.length; i++) {
      await page.clock.setSystemTime(new Date(Date.UTC(2028, 0, 1, 18) + i * 86400000));
      await redraw(page);
      const p = await measurePanel(page);
      if (p.problems.length) bad.push(mode + ' #' + i + ': ' + p.problems.join('; '));
      if (p.es !== DATA.words[i].es) bad.push(mode + ' #' + i + ' shows ' + p.es);
    }
  }
  assert(!bad.length, bad.length + ' problems: ' + bad.slice(0, 6).join(' | '));
  noErrors(page);
}

async function checkLiveSwitch() {
  const page = await openHub({ layout: [3, 4], at: TODAY });
  let t = await measureTile(page);
  const w = DATA.words[t.index];
  assert(t.title === 'Word of the day' && t.def === w.defEn, 'English first: ' + t.title);
  await openWord(page);
  await page.evaluate(() => window.HUB_I18N.setLang('es'));
  await sleep(100);
  t = await measureTile(page);
  assert(t.title === 'Palabra del día' && t.def === w.defEs, 'the tile did not follow: ' + t.title + ' / ' + t.def);
  const p = await measurePanel(page);
  assert(p.title === 'Palabra del día' && p.def === w.defEs && p.labels[0] === 'Qué significa', 'the panel did not follow: ' + JSON.stringify(p));
  noErrors(page);
}

// The Clock page's Language choice, for the pictures.
async function shotsLanguage() {
  for (const lang of ['en', 'es']) {
    const page = await openHub({ at: TODAY, lang: lang });
    await clockPage.open(page);
    await clockPage.pick(page, 'lang-' + lang);
    await page.screenshot({ path: path.join(SHOTS, 'clock-language-panel-' + lang + '.png') });
    await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
    await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy()), 4000, 'no full screen');
    await clockPage.pick(page, 'lang-' + lang);
    await page.screenshot({ path: path.join(SHOTS, 'clock-language-full-' + lang + '.png') });
    noErrors(page);
    await page.context().close();
  }
  // The home screen with the word in the built-in layout.
  for (const lang of ['en', 'es']) {
    const page = await openHub({ at: TODAY, lang: lang });
    await page.screenshot({ path: path.join(SHOTS, 'wotd-home-' + lang + '.png') });
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
  await loadData();

  await check('1. Languages: Spanish strings, English fallback, vars, onChange, saved, ?lang=es, storage off, own day names', checkI18n);
  await check('2. The word list: 366 words, every field, articles on nouns, no word over 12 letters', checkData);
  await check('3. The pick: by local day of the year, the same all day, clock changes, a new word at midnight', checkPick);
  await check('4. Today\'s word at ' + SIZES.length + ' sizes in English: what each shows, nothing cut or outside', () => checkSizes('en', TODAY, !!SHOTS));
  await check('5. The same in Spanish', () => checkSizes('es', TODAY, !!SHOTS));
  await check('6. The longest word (el Día de Acción de Gracias) at every size, English and Spanish', async () => { await checkSizes('en', LONGEST, false); await checkSizes('es', LONGEST, false); });
  await check('7. Every word at ' + TIGHT.length + ' tight sizes, in Spanish', () => checkEveryWord('es', TIGHT));
  await check('8. Every word at 1x1, 2x1, 3x2 and 3x4, in English', () => checkEveryWord('en', [[1, 1], [2, 1], [3, 2], [3, 4]]));
  await check('9. The panel and full screen, English', () => checkPanel('en', TODAY, !!SHOTS));
  await check('10. The panel and full screen, Spanish', () => checkPanel('es', TODAY, !!SHOTS));
  await check('11. Every word in the panel and full screen, Spanish', () => checkEveryPanel('es'));
  await check('12. Every word in the panel and full screen, English', () => checkEveryPanel('en'));
  await check('13. A language change redraws the tile and the open panel', checkLiveSwitch);
  if (SHOTS) await check('14. Pictures: the Clock page choice, the home screen', shotsLanguage);
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
