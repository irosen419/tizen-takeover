/*
 * Screenshots of the A World Worth Saving tiles: node dev/awws-shots.js
 *
 * Runs the preview, the sample calendars (dev/awws-sample.js) and the Pi's
 * real hub server with the sample snapshot stored through POST /api/awws,
 * then headless Chromium at 1920x1080 with the clock fixed at Monday
 * 16 November 2026, 10:40 AM in Chicago. Writes docs/screenshots/awws-*.jpg:
 * the two AWWS layouts, the Main layout, a size sheet for each tile size,
 * the placeholders, Reach at every size (two sheets with all its figures,
 * one with the hand-counted subscribers alone), the panels and full
 * screens, and the states. Every shot
 * is taken in English and again with the Spanish words (-es), which are
 * longer and carry accents.
 *
 *   --scale 2 --out <folder>   sharper copies (3840x2160) somewhere else
 *   --only <text>              only the shots whose name holds <text>
 *   --clip <folder>            record the short walk-through as a video instead
 *                              (with --only, the matching pictures too)
 *
 * Needs Playwright and port 8095 free. Prints the files it wrote.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const SCALE = parseFloat(arg('--scale')) || 1;
const OUT = path.resolve(arg('--out') || path.join(__dirname, '..', 'docs', 'screenshots'));
const ONLY = arg('--only');
const CLIP = arg('--clip');

const written = [];
const problems = [];
let env = null;

const L = {
  desk: [
    { widget: 'awws-visits', x: 0, y: 0, w: 3, h: 2 }, { widget: 'awws-agenda', x: 3, y: 0, w: 6, h: 2 },
    { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'awws-todo', x: 0, y: 2, w: 4, h: 4 },
    { widget: 'calendar', x: 4, y: 2, w: 5, h: 4 }, { widget: 'today', x: 9, y: 2, w: 3, h: 1 },
    { widget: 'entertainment', x: 9, y: 3, w: 3, h: 3 }
  ],
  oneScreen: [
    { widget: 'awws', x: 0, y: 0, w: 9, h: 6 }, { widget: 'today', x: 9, y: 0, w: 3, h: 1 },
    { widget: 'weather', x: 9, y: 1, w: 3, h: 2 }, { widget: 'calendar', x: 9, y: 3, w: 3, h: 3 }
  ],
  main: [
    { widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'weather', x: 9, y: 0, w: 3, h: 2 },
    { widget: 'todo', x: 0, y: 2, w: 3, h: 4 }, { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 },
    { widget: 'nowplaying', x: 9, y: 2, w: 3, h: 2 }, { widget: 'awws', x: 6, y: 0, w: 3, h: 4 },
    { widget: 'ambiance', x: 3, y: 4, w: 3, h: 2 }, { widget: 'mirror', x: 6, y: 4, w: 3, h: 2 },
    { widget: 'entertainment', x: 9, y: 4, w: 3, h: 2 }
  ]
};

const REAL = ['awws', 'awws-visits', 'awws-agenda', 'awws-todo'];

// One size for the four real tiles, placed left to right, then down.
function sheet(w, h, ids) {
  ids = ids || REAL;
  const out = [];
  let x = 0;
  let y = 0;
  for (const id of ids) {
    if (x + w > 12) { x = 0; y += h; }
    out.push({ widget: id, x: x, y: y, w: w, h: h });
    x += w;
  }
  return out;
}

const SHEETS = [
  ['1x1', sheet(1, 1)], ['2x1', sheet(2, 1)], ['3x1', sheet(3, 1)], ['6x1', sheet(6, 1)],
  ['12x1', sheet(12, 1)], ['2x2', sheet(2, 2)], ['3x2', sheet(3, 2)], ['6x2', sheet(6, 2)],
  ['3x4', sheet(3, 4)], ['6x4-a', sheet(6, 4, ['awws', 'awws-visits'])], ['6x4-b', sheet(6, 4, ['awws-agenda', 'awws-todo'])],
  ['9x6', [{ widget: 'awws', x: 0, y: 0, w: 9, h: 6 }, { widget: 'awws-visits', x: 9, y: 0, w: 3, h: 2 },
    { widget: 'awws-agenda', x: 9, y: 2, w: 3, h: 2 }, { widget: 'awws-todo', x: 9, y: 4, w: 3, h: 2 }]],
  ['placeholders', [{ widget: 'awws-outreach', x: 0, y: 0, w: 3, h: 2 }, { widget: 'awws-pipeline', x: 3, y: 0, w: 3, h: 4 },
    { widget: 'awws-money', x: 6, y: 0, w: 6, h: 1 }]]
];

// Reach at every size the other sheets use. A layout holds a widget once, so
// each tile is taken alone in its spot and the sheet is put together after
// (see composite). Two sheets, because every size doesn't fit on one screen.
function at(x, y, w, h) { return { widget: 'awws-reach', x: x, y: y, w: w, h: h }; }
const REACH_A = [at(0, 0, 6, 2), at(6, 0, 3, 1), at(9, 0, 2, 1), at(11, 0, 1, 1), at(6, 1, 6, 1),
  at(0, 2, 6, 4), at(6, 2, 3, 4), at(9, 2, 2, 2), at(9, 4, 3, 2)];
const REACH_B = [at(0, 0, 12, 1), at(0, 1, 4, 2), at(4, 1, 5, 3), at(9, 1, 3, 3), at(0, 4, 12, 2)];
// [name, the reach section's shape (dev/awws-sample.js), layout]
const REACH_SHEETS = [['reach-a', 'both', REACH_A], ['reach-b', 'both', REACH_B], ['reach-subscribers', 'subscribers', REACH_A]];
// The AWWS desk with Reach where Entertainment was, for the panel shots.
const REACH_DESK = L.desk.map((t) => (t.widget === 'entertainment' ? at(t.x, t.y, t.w, t.h) : t));

function wanted(name) { return !ONLY || name.indexOf(ONLY) >= 0; }

/*
 * One sheet from tiles of one widget: each entry of layout is opened alone
 * at its own place on the grid, its tile is cut out, and the pieces go back
 * onto the first page's background, where they stood. Only the first tile
 * keeps the focus ring, as on the other sheets.
 */
async function composite(layout, es, name) {
  const parts = [];
  let base = null;
  for (let i = 0; i < layout.length; i++) {
    const page = await env.newPage({ layout: [layout[i]], spanish: es, scale: SCALE });
    if (i > 0) await page.evaluate(() => document.querySelectorAll('#grid .is-focused').forEach((n) => n.classList.remove('is-focused')));
    await H.sleep(200);
    const r = await page.evaluate((id) => {
      const b = document.querySelector('.cell[data-widget="' + id + '"]').getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    }, layout[i].widget);
    const pad = 10;
    const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + 2 * pad, height: r.height + 2 * pad };
    clip.width = Math.min(clip.width, 1920 - clip.x);
    clip.height = Math.min(clip.height, 1080 - clip.y);
    parts.push({ clip: clip, png: await page.screenshot({ clip: clip, type: 'png' }) });
    if (!base) base = await page.screenshot({ type: 'png' });
    await done(page, name + ' ' + layout[i].w + 'x' + layout[i].h);
  }
  const ctx = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
  try {
    const page = await ctx.newPage();
    const img = (png, c) => '<img style="position:absolute;left:' + c.x + 'px;top:' + c.y + 'px;width:' + c.width + 'px;height:' + c.height +
      'px" src="data:image/png;base64,' + png.toString('base64') + '">';
    let html = '<body style="margin:0;width:1920px;height:1080px;overflow:hidden;position:relative">' +
      img(base, { x: 0, y: 0, width: 1920, height: 1080 });
    for (const p of parts) html += img(p.png, p.clip);
    await page.setContent(html + '</body>');
    await page.evaluate(() => Promise.all(Array.prototype.map.call(document.images, (i) => i.decode())));
    await shot(page, name);
  } finally {
    await ctx.close();
  }
}

async function shot(page, name) {
  const file = path.join(OUT, 'awws-' + name + '.jpg');
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  written.push(file);
}

async function done(page, label, allowNetwork) {
  const errs = H.errorsOf(page, allowNetwork);
  if (errs.length) { problems.push(label + ': ' + errs.join(' | ')); console.log('PROBLEM ' + label + ': ' + errs.join(' | ')); }
  await page.ctx.close();
}

// Runs fn(name, spanish, nm) once in English and once in Spanish. nm(part)
// names a further shot of the same run: awws-<name><part>[-es].jpg.
async function both(name, fn) {
  for (const es of [false, true]) {
    const full = name + (es ? '-es' : '');
    const nm = (part) => name + part + (es ? '-es' : '');
    if (!wanted(full)) continue;
    try { await fn(full, es, nm); } catch (e) {
      problems.push(full + ': ' + (e && e.message));
      console.log('PROBLEM ' + full + ': ' + (e && e.message));
    }
  }
}

async function home(name, layout, focus) {
  await both(name, async (full, es) => {
    const page = await env.newPage({ layout: layout, spanish: es, scale: SCALE });
    if (focus) await H.focusTile(page, focus);
    await H.sleep(250);
    await shot(page, full);
    await done(page, full);
  });
}

async function layouts() {
  await home('layout-desk', L.desk, 'awws-todo');
  await home('layout-one-screen', L.oneScreen, 'awws');
  await home('layout-main', L.main, 'awws');
}

async function sheets() {
  for (const s of SHEETS) await home('sizes-' + s[0], s[1], null);
  for (const s of REACH_SHEETS) {
    await both('sizes-' + s[0], async (full, es) => {
      if (s[1] !== 'both') await env.setSnapshot(H.sample.snapshot({ reach: s[1] }));
      try {
        await composite(s[2], es, full);
      } finally {
        if (s[1] !== 'both') await env.setSnapshot(H.sample.snapshot());
      }
    });
  }
}

async function panels() {
  // The Glance's launcher, a view opened from it, and full screen.
  await both('panel-glance', async (full, es, nm) => {
    const page = await env.newPage({ layout: L.main, spanish: es, scale: SCALE });
    await H.openPanel(page, 'awws');
    await shot(page, nm('-launcher'));
    await H.key(page, 'ArrowDown');
    await H.key(page, 'Enter');
    await H.idle(page);
    await shot(page, nm('-this-week'));
    await H.key(page, 'Escape');
    await H.idle(page);
    await H.fullScreen(page);
    await shot(page, nm('-full'));
    await done(page, full);
  });
  // Reach: its panel and full screen; then with the subscribers alone.
  await both('panel-reach', async (full, es, nm) => {
    const page = await env.newPage({ layout: REACH_DESK, spanish: es, scale: SCALE });
    await H.openPanel(page, 'awws-reach');
    await shot(page, full);
    await H.fullScreen(page);
    await shot(page, nm('-full'));
    await done(page, full);
  });
  await both('panel-reach-subscribers', async (full, es) => {
    await env.setSnapshot(H.sample.snapshot({ reach: 'subscribers' }));
    try {
      const page = await env.newPage({ layout: REACH_DESK, spanish: es, scale: SCALE });
      await H.openPanel(page, 'awws-reach');
      await shot(page, full);
      await done(page, full);
    } finally {
      await env.setSnapshot(H.sample.snapshot());
    }
  });
  await both('panel-visits', async (full, es, nm) => {
    const page = await env.newPage({ layout: L.desk, spanish: es, scale: SCALE });
    await H.openPanel(page, 'awws-visits');
    await shot(page, full);
    await H.fullScreen(page);
    await shot(page, nm('-full'));
    await done(page, full);
  });
  await both('panel-agenda', async (full, es, nm) => {
    const page = await env.newPage({ layout: L.desk, spanish: es, scale: SCALE });
    await H.openPanel(page, 'awws-agenda');
    await H.key(page, 'ArrowDown', 2);
    await shot(page, full);
    await H.fullScreen(page);
    await shot(page, nm('-full'));
    await done(page, full);
  });
  await both('panel-todo', async (full, es, nm) => {
    const page = await env.newPage({ layout: L.desk, spanish: es, scale: SCALE });
    await H.openPanel(page, 'awws-todo');
    await H.key(page, 'ArrowRight');
    await shot(page, nm('-ian'));
    await H.key(page, 'ArrowLeft');
    await H.fullScreen(page);
    await shot(page, nm('-full'));
    await done(page, full);
  });
}

// A page with the AWWS desk layout plus the Glance, for the state shots.
const STATE_LAYOUT = [
  { widget: 'awws', x: 0, y: 0, w: 3, h: 4 }, { widget: 'awws-visits', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'awws-agenda', x: 6, y: 0, w: 6, h: 2 }, { widget: 'awws-todo', x: 3, y: 2, w: 3, h: 4 },
  { widget: 'calendar', x: 6, y: 2, w: 3, h: 4 }, { widget: 'weather', x: 9, y: 2, w: 3, h: 2 },
  { widget: 'today', x: 9, y: 4, w: 3, h: 2 }, { widget: 'awws-outreach', x: 0, y: 4, w: 3, h: 2 }
];

async function states() {
  const sample = H.sample;
  // Stale: the snapshot was sent at 7:10 AM the day before, over 19 hours ago.
  await both('state-stale', async (full, es) => {
    await env.setSnapshot(sample.snapshot({ sentAt: '2026-11-15T13:10:00Z' }));
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE });
    await shot(page, full);
    await done(page, full);
    await env.setSnapshot(sample.snapshot());
  });
  // Not synced yet: nothing stored on the Pi.
  await both('state-not-synced', async (full, es, nm) => {
    await env.control('POST', '/api/awws', { snapshot: null });
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE });
    await shot(page, full);
    await H.openPanel(page, 'awws-todo');
    await shot(page, nm('-panel'));
    await done(page, full);
    await env.setSnapshot(sample.snapshot());
  });
  // The calendar names in config.js aren't on the Pi.
  await both('state-calendar-missing', async (full, es, nm) => {
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE,
      config: () => {
        // Runs before config.js: catch its HUB_CONFIG on the way in and rename the calendars.
        let cfg;
        Object.defineProperty(window, 'HUB_CONFIG', { configurable: true, get: () => cfg, set: (v) => {
          cfg = v;
          if (v && v.widgets && v.widgets.awws) v.widgets.awws.calendars = { visits: ['School Trips'], awws: ['Book Project'] };
        } });
      } });
    await shot(page, full);
    await H.openPanel(page, 'awws-visits');
    await shot(page, nm('-panel'));
    await done(page, full);
  });
  // School Visits can't be read.
  await both('state-calendar-error', async (full, es) => {
    await env.feedMode('fail');
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE });
    await shot(page, full);
    await done(page, full);
    await env.feedMode('sample');
  });
  // Loading: the Pi hasn't answered yet.
  await both('state-loading', async (full, es) => {
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE, waitLive: false,
      route: (c) => c.route('**/live/state', () => { /* never answers */ }) });
    await shot(page, full);
    await done(page, full, true);
  });
  // The Pi never reached from this TV.
  await both('state-pi-never-reached', async (full, es) => {
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE, live: env.DEAD, waitLive: false });
    await H.until(() => page.evaluate(() => window.HUB_LIVE.status().state === 'quiet'), 10000, 'not quiet');
    await H.sleep(300);
    await shot(page, full);
    await done(page, full, true);
  });
  // Live updates off on this TV.
  await both('state-pi-off', async (full, es) => {
    const page = await env.newPage({ layout: STATE_LAYOUT, spanish: es, scale: SCALE, live: 'off' });
    await shot(page, full);
    await done(page, full, true);
  });
}

// Moves along the open switcher to the layout called name, then OK.
async function pickLayout(page, name) {
  const names = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.switcher-item'), (n) => n.textContent));
  const want = names.indexOf(name);
  if (want < 0) throw new Error('no layout ' + name + ' in ' + names.join(', '));
  for (let i = 0; i < 8; i++) {
    const at = names.indexOf(await page.evaluate(() => (document.querySelector('.switcher-item.is-focused') || {}).textContent || ''));
    if (at === want) break;
    await H.key(page, at < want ? 'ArrowRight' : 'ArrowLeft');
    await H.sleep(350);
  }
  await H.key(page, 'Enter');
}

// A walk through: AWWS one screen, the switcher to AWWS desk, the to-do
// board with a filter, back, the Main layout, the Glance's launcher, Next
// visit, Back.
async function clip(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const page = await env.newPage({ layout: L.oneScreen, video: { dir: dir } });
  const slow = (ms) => H.sleep(ms);
  await slow(1500);
  await H.focusTile(page, 'awws');
  await slow(600);
  await H.key(page, 'ArrowUp');                       // the switcher drops down
  await H.until(() => page.evaluate(() => document.querySelectorAll('.switcher-item').length > 0), 3000, 'the switcher did not open');
  await slow(900);
  await pickLayout(page, 'AWWS desk');
  await H.until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="awws-todo"]')), 10000, 'AWWS desk did not load');
  await slow(1800);
  await H.openPanel(page, 'awws-todo');
  await slow(1200);
  await H.key(page, 'ArrowRight');
  await slow(1200);
  await H.key(page, 'ArrowRight');
  await slow(1000);
  await H.key(page, 'ArrowDown', 3);
  await slow(800);
  await H.key(page, 'Escape');
  await H.idle(page);
  await slow(700);
  await H.key(page, 'ArrowUp', 2);
  await slow(400);
  await H.key(page, 'ArrowUp');                       // the switcher again
  await H.until(() => page.evaluate(() => document.querySelectorAll('.switcher-item').length > 0), 3000, 'the switcher did not open again');
  await slow(700);
  await pickLayout(page, 'Main');
  await H.until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="nowplaying"]')), 10000, 'Main did not load');
  await slow(1500);
  await H.openPanel(page, 'awws');
  await slow(1500);
  await H.key(page, 'Enter');                         // Next visit
  await slow(2000);
  await H.key(page, 'Escape');                        // back to the launcher
  await slow(1500);
  const video = page.video();
  await page.ctx.close();
  const webm = await video.path();
  const out = path.join(dir, 'awws-walkthrough.webm');
  fs.renameSync(webm, out);
  let result = out;
  try {
    const mp4 = out.replace(/\.webm$/, '.mp4');
    childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', mp4]);
    result = mp4;
  } catch (e) { /* keep the .webm */ }
  written.push(result);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // A full run replaces the old pictures; --only, --out and --clip leave them.
  if (!ONLY && !CLIP && !arg('--out')) {
    for (const f of fs.readdirSync(OUT)) if (/^awws-.*\.jpg$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  }
  env = await H.start({});
  try {
    if (!CLIP || ONLY) {
      await layouts();
      await sheets();
      await panels();
      await states();
    }
    if (CLIP) await clip(path.resolve(CLIP));
  } finally {
    await env.stop();
  }
  for (const f of written) {
    const kb = Math.round(fs.statSync(f).size / 1024);
    console.log(path.relative(process.cwd(), f) + '  ' + kb + ' KB');
  }
  console.log(written.length + ' files written');
  console.log(problems.length ? problems.length + ' problems' : 'no problems');
  process.exit(problems.length ? 1 : 0);
}

main().catch(async (e) => {
  console.log('FAIL ' + (e && e.stack));
  if (env) await env.stop().catch(() => {});
  process.exit(1);
});
