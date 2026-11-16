/*
 * For the tests that read the hub's status lines (version, motion, live
 * updates, updates). They live in "About this hub" on the Clock page, so
 * these open the page the way OK on the Clock tile would (through
 * HUB_TEST.openPanel, which doesn't count as a key press and so leaves the
 * idle timer alone), read it, and close it again.
 *
 *   const clockPage = require('./clock-page');
 *   const lines = await clockPage.lines(page);          // ['v0.17.0 · Chrome 120', 'Motion: ...']
 *   const text = await clockPage.line(page, 'updates'); // the updates line, or null
 *   await clockPage.waitFor(page, (about) => about.live === 'Live', 3000, 'no Live line');
 *
 * waitFor keeps the page open while it waits, so it also checks that the
 * page redraws by itself when a status changes.
 *
 * The face and 12/24 choices (dev/clock-test.js):
 *
 *   await clockPage.open(page);
 *   await clockPage.pick(page, 'face-analog');   // with the arrows and OK, like the remote
 *   const s = await clockPage.state(page);       // { face, keys, readout, focused, text }
 *   const t = await clockPage.tile(page);        // { face, digits, ampm, window, windowMode, text }
 *
 * On Analog the page has no digital time (readout false) and no 12/24
 * group (keys has no hours-*); on Digital it has both.
 */
'use strict';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// { lines: [...], live: text or null, updates: text or null } from the open page.
function read(page) {
  return page.evaluate(() => {
    const text = (sel) => { const e = document.querySelector(sel); return e ? e.textContent : null; };
    return {
      lines: Array.prototype.map.call(document.querySelectorAll('.clock-about-line'), (e) => e.textContent),
      live: text('.clock-about-live'),
      updates: text('.clock-about-updates')
    };
  });
}

async function settle(page, test, ms, text) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(test)) return;
    await sleep(40);
  }
  throw new Error(text);
}

// Opens the Clock page. Returns true when this call opened it.
async function open(page) {
  await settle(page, () => !window.HUB_TEST.busy(), 4000, 'the hub stayed busy');
  const now = await page.evaluate(() => window.HUB_TEST.open());
  if (now === 'today') return false;
  if (now) throw new Error('another panel is open: ' + now);
  const ok = await page.evaluate(() => window.HUB_TEST.openPanel('today'));
  if (!ok) throw new Error('the Clock page did not open');
  await settle(page, () => window.HUB_TEST.open() === 'today' && !window.HUB_TEST.busy() &&
    !!document.querySelector('.clock-about-line'), 4000, 'the Clock page did not open');
  return true;
}

async function close(page) {
  await settle(page, () => !window.HUB_TEST.busy(), 4000, 'the hub stayed busy');
  if (await page.evaluate(() => window.HUB_TEST.open()) !== 'today') return;
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await settle(page, () => window.HUB_TEST.open() === null && !window.HUB_TEST.busy(), 4000, 'the Clock page did not close');
}

async function about(page) {
  const opened = await open(page);
  try {
    return await read(page);
  } finally {
    if (opened) await close(page);
  }
}

async function lines(page) { return (await about(page)).lines; }

// kind: 'live' or 'updates'.
async function line(page, kind) { return (await about(page))[kind]; }

// Opens the page, waits until fn(about) is truthy, closes the page. Returns
// fn's value. A reload on the way is fine: the page is opened again.
async function waitFor(page, fn, ms, text) {
  const wasOpen = await page.evaluate(() => window.HUB_TEST.open() === 'today');
  const end = Date.now() + ms;
  let last;
  try {
    while (Date.now() < end) {
      try {
        await open(page);
        last = await read(page);
        const v = fn(last);
        if (v) return v;
      } catch (e) { last = e.message; }
      await sleep(100);
    }
  } finally {
    if (!wasOpen) { try { await close(page); } catch (e) { /* the page went away */ } }
  }
  throw new Error(text + ' (last: ' + JSON.stringify(last) + ')');
}

// The open page: which face, the option keys in order, whether a digital
// time is shown, the focused option, and the display's text.
function state(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.clock-page');
    const f = document.querySelector('#panel .is-focused');
    return {
      face: root ? (/\bis-analog\b/.test(root.className) ? 'analog' : 'digital') : null,
      keys: Array.prototype.map.call(document.querySelectorAll('.clock-opt'), (e) => e.getAttribute('data-key')),
      readout: !!document.querySelector('.clock-page .clock-digits, .clock-page .clock-readout, .clock-page .clock-ampm'),
      focused: f ? f.getAttribute('data-key') || f.className : null,
      text: root ? (root.querySelector('.clock-display') || root).textContent : ''
    };
  });
}

// The Clock tile on the home screen.
function tile(page) {
  return page.evaluate(() => {
    const body = document.querySelector('.cell[data-widget="today"] .tile-body');
    if (!body) return null;
    const q = (sel) => body.querySelector(sel);
    const win = q('.clock-window-text');
    return {
      face: q('.today-face svg') ? 'analog' : q('.today-time') ? 'digital' : null,
      digits: q('.today-digits') ? q('.today-digits').textContent : null,
      ampm: q('.today-ampm') && q('.today-ampm').style.display !== 'none' ? q('.today-ampm').textContent : '',
      window: win ? win.textContent : null,
      windowMode: q('.today-face') ? q('.today-face').getAttribute('data-window') : null,
      second: q('.clock-hand-s') ? q('.clock-hand-s').getAttribute('transform') : null,
      text: body.textContent
    };
  });
}

// Moves to an option with the arrows and presses OK, as the remote would.
async function pick(page, key) {
  for (let i = 0; i < 8; i++) {
    const at = (await state(page)).focused || '';
    if (at === key) {
      await page.keyboard.press('Enter');
      await settle(page, () => !window.HUB_TEST.busy(), 4000, 'the hub stayed busy');
      await sleep(80);
      return;
    }
    const wantGroup = key.split('-')[0];
    const atGroup = at.split('-')[0];
    let k;
    if (atGroup !== 'face' && atGroup !== 'hours') k = 'ArrowDown';
    else if (wantGroup !== atGroup) k = wantGroup === 'hours' ? 'ArrowDown' : 'ArrowUp';
    else k = /analog|24/.test(key) ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.press(k);
    await sleep(80);
  }
  throw new Error('could not reach ' + key + ' with the arrows (focus on ' + (await state(page)).focused + ')');
}

module.exports = { open, close, read, about, lines, line, waitFor, state, tile, pick };
