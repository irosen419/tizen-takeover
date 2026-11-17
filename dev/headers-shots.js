/*
 * Pictures of the tile headers, the accent edge and the opened panel:
 *   node dev/headers-shots.js --out <folder> [--tag before|after] [--only <text>] [--clip] [--fps]
 *
 * Runs the real hub against the preview and the real hub server from pi/
 * (dev/awws-harness.js: the clock at Monday 16 November 2026, 10:40 AM in
 * Chicago, the sample calendars, the AWWS snapshot and the budget sample),
 * 1920x1080, wanderers off. Needs Playwright and port 8095 free.
 *
 *   layout-<name>-<lang>-<tag>.png   Main, AWWS desk, AWWS one screen, AWWS
 *     money and Budget, in English and in Spanish (the hub's Language,
 *     homeHub.lang, with the words in app/i18n.js), plus the stock layout.
 *   panel-entertainment-<tag>.png    the Entertainment panel, opened.
 *   --clip: edge-appears.mp4, a new to-do arriving on the stock layout and its
 *     accent edge sweeping in along the To-do tile's top (needs ffmpeg).
 *   --fps: the frame rate headless Chromium reached while an edge swept in,
 *     while one faded out, and while a panel opened, saved as fps.json. A
 *     desktop is not the TV: these say the motion is cheap, not that the TV
 *     is smooth.
 *
 * --tag names the pictures (default "after"); run it on the old code with
 * --tag before for the comparison.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'headers-shots');
const TAG = arg('--tag') || 'after';
const ONLY = arg('--only') || '';
const CLIP = args.indexOf('--clip') >= 0;
const FPS = args.indexOf('--fps') >= 0;
// --pairs: English only, named <tag>-<layout>.png (before-main.png,
// after-main.png ...) for a true before/after of the same data and clock;
// --stitch then puts each pair side by side (pair-<layout>.png, needs ffmpeg).
const PAIRS = args.indexOf('--pairs') >= 0;
const STITCH = args.indexOf('--stitch') >= 0;
const PAIR_LAYOUTS = ['main', 'awws-desk', 'awws-money', 'budget'];

// The layouts from app/config.js, read the way the TV runs it.
function configLayouts() {
  const vm = require('vm');
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + ';this.C = HUB_CONFIG;', box);
  const out = { stock: box.C.layout };
  box.C.layouts.forEach((l) => { if (l.layout) out[l.id] = l.layout; });
  return out;
}
const LAYOUTS = configLayouts();
const NAMES = ['main', 'awws-desk', 'awws-one-screen', 'awws-money', 'budget', 'stock'];
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
// The sample's charge alert counts as shown, so the banner doesn't cover the tiles.
const SEEN = { 'homeHub.budget.seen.v1': '["a-1042"]' };

function want(name) { return !ONLY || name.indexOf(ONLY) >= 0; }

async function layoutShots(env) {
  for (const id of (PAIRS ? PAIR_LAYOUTS : NAMES)) {
    for (const lang of (PAIRS ? ['en'] : ['en', 'es'])) {
      const name = PAIRS ? TAG + '-' + id + '.png' : 'layout-' + id + '-' + lang + '-' + TAG + '.png';
      if (!want(name)) continue;
      const page = await env.newPage({ layout: LAYOUTS[id], storage: Object.assign({ 'homeHub.lang': lang }, SEEN) });
      await H.sleep(600);
      await page.screenshot({ path: path.join(OUT, name) });
      console.log('  ' + name);
      await page.context().close();
    }
  }
}

async function panelShots(env) {
  for (const lang of (PAIRS ? ['en'] : ['en', 'es'])) {
    const name = PAIRS ? TAG + '-entertainment-panel.png' : 'panel-entertainment-' + lang + '-' + TAG + '.png';
    if (!want(name)) continue;
    const page = await env.newPage({ layout: LAYOUTS.stock, storage: Object.assign({ 'homeHub.lang': lang }, SEEN) });
    await page.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
    await H.until(() => page.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy()), 5000, 'no panel');
    await H.sleep(700);
    await page.screenshot({ path: path.join(OUT, name) });
    const box = await page.evaluate(() => {
      const g = document.getElementById('ghost').getBoundingClientRect();
      const items = document.querySelectorAll('#panel .ent-item');
      let bottom = 0;
      for (let i = 0; i < items.length; i++) bottom = Math.max(bottom, items[i].getBoundingClientRect().bottom);
      return { panelHeight: Math.round(g.height), emptyBelowItems: Math.round(g.bottom - bottom) };
    });
    console.log('  ' + name + ' (' + JSON.stringify(box) + ')');
    await page.context().close();
  }
}

function hasFfmpeg() {
  try { childProcess.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

// A new to-do from the hub server: the To-do tile's activity chip and accent edge.
let todoN = 0;
async function newTodo(env) {
  await env.control('POST', '/api/todo', { title: ['Send the Maple Grove photos', 'Order more activity sheets', 'Call Cedar Hollow back'][todoN++ % 3], section: 'now' });
}

// The accent edge needs the motion extras, so these pages run in push mode.
function pushQuery(page) {
  return page.evaluate(() => {
    try { localStorage.setItem('homeHub.motion', JSON.stringify({ mode: 'push', build: window.HUB_BUILD, fps: 60 })); } catch (e) { /* ignore */ }
  });
}

async function openPush(env, o) {
  const page = await env.newPage(Object.assign({ layout: LAYOUTS.stock, storage: Object.assign({}, SEEN) }, o || {}));
  // awws-harness opens ?motion=fade; reopen the same page in push mode.
  const url = page.url().replace('motion=fade', 'motion=push') + '&clay=off';
  await page.goto(url);
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await H.until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 10000, 'not live');
  await H.sleep(1500);
  return page;
}

async function clip(env) {
  if (!want('edge-appears')) return;
  const dir = path.join(OUT, '.video');
  fs.rmSync(dir, { recursive: true, force: true });
  const page = await openPush(env, { video: { dir: dir } });
  // The page's clock is fixed for the data; let timers run for the clip.
  const born = Date.now();
  await H.sleep(800);
  await newTodo(env);
  await H.sleep(4200);
  // A short hold, so the clip also shows the edge fading out.
  await page.evaluate(() => window.HUB_FX && window.HUB_FX.edgeHold && window.HUB_FX.edgeHold(0));
  await H.sleep(1500);
  const video = page.video();
  await page.context().close();
  const src = await video.path();
  const ff = hasFfmpeg();
  const dest = path.join(OUT, 'edge-appears' + (ff ? '.mp4' : '.webm'));
  const skip = Math.max(0, (Date.now() - born) / 1000 - 7.2);
  if (ff) {
    childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip.toFixed(2), '-i', src,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium', '-r', '30', '-movflags', '+faststart', dest]);
  } else fs.copyFileSync(src, dest);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ' + path.basename(dest));
}

function sampler(page, ms) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const t = [];
    const t0 = performance.now();
    (function f(now) { t.push(now); if (now - t0 < ms) requestAnimationFrame(f); else {
      let worst = 0;
      for (let i = 1; i < t.length; i++) worst = Math.max(worst, t[i] - t[i - 1]);
      resolve({ fps: Math.round((t.length - 1) * 1000 / (t[t.length - 1] - t[0])), worst: Math.round(worst) });
    } })(performance.now());
  }), ms);
}

async function rates(env) {
  const rows = [];
  async function measure(name, ms, go, reset) {
    const page = await openPush(env);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = sampler(page, ms);
      await go(page);
      runs.push(await s);
      if (reset) await reset(page);
    }
    const sorted = runs.map((r) => r.fps).sort((a, b) => a - b);
    const row = { motion: name, fps: runs.map((r) => r.fps), worstFrameMs: runs.map((r) => r.worst), medianFps: sorted[1] };
    rows.push(row);
    console.log('  ' + name + ': ' + row.fps.join(', ') + ' fps (worst frame ' + row.worstFrameMs.join(', ') + ' ms)');
    await page.context().close();
  }
  await measure('accent edge sweeping in (with the activity chip, 1.4 s)', 1400,
    async () => { await newTodo(env); },
    async (page) => { await page.evaluate(() => window.HUB_FX.edgeClear && window.HUB_FX.edgeClear()); await H.sleep(2800); });
  await measure('accent edge fading out (600 ms)', 700,
    async (page) => { await page.evaluate(() => { const t = document.querySelector('.cell[data-widget="todo"] .tile'); window.HUB_FX.accent(t, 'test'); }); await H.sleep(1400); await page.evaluate(() => window.HUB_FX.edgeHold(0)); },
    async () => { await H.sleep(600); });
  await measure('open Entertainment (sized to its content, push)', 600,
    async (page) => { await page.keyboard.press('Enter'); },
    async (page) => { await page.keyboard.press('Escape'); await H.sleep(800); });
  await measure('idle home screen with one edge showing', 1000,
    async (page) => { await page.evaluate(() => { const t = document.querySelector('.cell[data-widget="todo"] .tile'); window.HUB_FX.accent(t, 'test'); }); },
    async () => { await H.sleep(1600); });
  fs.writeFileSync(path.join(OUT, 'fps.json'), JSON.stringify({ note: 'Headless Chromium ' + env.browser.version() + ' on a cloud machine, no GPU. Not the TV.', results: rows }, null, 2) + '\n');
}

// Before on the left, after on the right, each labelled, at half size.
function stitch() {
  for (const id of PAIR_LAYOUTS.concat(['entertainment-panel'])) {
    const a = path.join(OUT, 'before-' + id + '.png');
    const b = path.join(OUT, 'after-' + id + '.png');
    if (!fs.existsSync(a) || !fs.existsSync(b)) { console.log('  (no pair for ' + id + ')'); continue; }
    const label = (t) => 'scale=960:540,pad=960:600:0:60:0x0b1220,drawtext=text=\'' + t + '\':fontcolor=white:fontsize=34:x=24:y=12';
    childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-i', b, '-filter_complex',
      '[0]' + label('Before (main)') + '[l];[1]' + label('After (design pass 2)') + '[r];[l][r]hstack', path.join(OUT, 'pair-' + id + '.png')]);
    console.log('  pair-' + id + '.png');
  }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (STITCH) { stitch(); return; }
  const env = await H.start();
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
    console.log('Pictures (' + TAG + '):');
    await layoutShots(env);
    await panelShots(env);
    if (CLIP) { console.log('Clip:'); await clip(env); }
    if (FPS) { console.log('Frame rates (headless, not the TV):'); await rates(env); }
  } finally {
    await env.stop();
  }
})().catch((e) => { console.error(e && e.stack); process.exitCode = 1; });
