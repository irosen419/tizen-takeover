/*
 * Screenshots and videos of the clay wanderers: node dev/clay-shots.js [OUT_DIR] [scene ...]
 *
 * Runs the preview (dev/preview.js, with its own hub server and the sample
 * calendars) and headless Chromium at 1920x1080, with a few to-do items on
 * the TV, and plays every scene (each time of day, each weather outfit, each
 * perch pose, the reactions) through HUB_TEST.clay. The scene clock is
 * moved by hand (setSpeed(0), then advance(1000 / 30) once per frame), so
 * every frame is captured exactly as the TV would draw it, smoothly, at 30
 * frames a second; the films play at the real speed. CLAY_FPS sets another
 * rate (7 films one frame per tick, as the stepped drawing looks).
 *
 * Writes to OUT_DIR (default docs/screenshots/clay):
 *   <scene>-1.jpg ... <scene>-4.jpg   moments of each scene (entry, key beat, exit)
 *   <scene>.mp4                       each scene start to finish (needs ffmpeg)
 *   perch-<pose>.jpg                  each perch pose on a ledge
 *   perch-other-layout.jpg            a perch on a different tile layout
 *   vanish-before.jpg, vanish-after.jpg, vanish-on-key.mp4   a key press mid-scene
 *   highlights.mp4                    three scenes back to back (about 50 s)
 *   all-scenes.jpg                    one frame of every scene, with its name
 * Names given after OUT_DIR limit the run to those scenes (and skip the rest).
 * Needs Playwright and port 8095 free; ffmpeg for the videos (skipped without it).
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots', 'clay'));
const ONLY = process.argv.slice(3);
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host')];
const TICK = 140;
const FPS = Number(process.env.CLAY_FPS) > 0 ? Number(process.env.CLAY_FPS) : 30;
const PER_TICK = TICK * FPS / 1000;     // film frames per scene tick
const QUALITY = 85;

// A layout unlike config.js's, to show the ledges follow the tiles.
const OTHER_LAYOUT = [
  { widget: 'today',         x: 0, y: 0, w: 4, h: 2 },
  { widget: 'weather',       x: 4, y: 0, w: 4, h: 2 },
  { widget: 'calendar',      x: 8, y: 0, w: 4, h: 4 },
  { widget: 'todo',          x: 0, y: 2, w: 5, h: 4 },
  { widget: 'entertainment', x: 5, y: 2, w: 3, h: 3 },
  { widget: 'nowplaying',    x: 5, y: 5, w: 3, h: 1 },
  { widget: 'awws',          x: 8, y: 4, w: 4, h: 2 }
];

function day(h, m) { return new Date(2026, 10, 16, h, m || 0, 0).getTime(); }

// Every scene to film: name (file name), the scene, play() options, the
// TV clock, and which frames to keep as stills: a fraction of the scene, or
// '@signal+n', n ticks after the scene gave that signal (see clay.js).
const SHOTS = [
  { name: 'stroll', scene: 'stroll', opts: { seed: 3, dir: 'right' }, at: day(14, 10), stills: [0.12, '@phone+4', '@rub+12', 0.92] },
  { name: 'fetch', scene: 'fetch', opts: { seed: 5, dir: 'right' }, at: day(15, 20), stills: ['@fake+8', '@throw+7', '@caught', '@swap+10'] },
  { name: 'fetch-bolt', scene: 'fetch-bolt', opts: { seed: 5, dir: 'right' }, at: day(15, 40), stills: ['@pick+2', '@gone+4', '@bark-6', '@bark+10', '@point+4'] },
  { name: 'fetch-snub', scene: 'fetch-snub', opts: { seed: 6, dir: 'right' }, at: day(15, 50), stills: ['@drop+3', '@snub+6', '@what+4', '@lifted+2', '@sat+10'] },
  { name: 'sock-heist', scene: 'sock-heist', opts: { seed: 2, dir: 'right' }, at: day(16, 5), stills: ['@found-4', '@seen+3', '@grab+8', 0.9] },
  { name: 'zoomies', scene: 'zoomies', opts: { seed: 4, dir: 'left' }, at: day(11, 30), stills: [0.2, 0.42, 0.62, 0.8] },
  { name: 'perch', scene: 'perch', opts: { seed: 1, pose: 'climb', ledge: 0 }, at: day(13, 0), stills: [0.04, 0.2, 0.45, 0.8] },
  { name: 'morning', scene: 'morning', opts: { seed: 6, dir: 'right' }, at: day(7, 45), stills: [0.15, 0.4, 0.55, 0.85] },
  { name: 'evening', scene: 'evening', opts: { seed: 7, dir: 'right' }, at: day(20, 30), stills: [0.12, '@sit+12', '@popcorn+10', 0.92] },
  { name: 'night', scene: 'night', opts: { seed: 8, dir: 'right', nap: true }, at: day(23, 40), stills: [0.06, 0.22, 0.5, 0.95] },
  { name: 'night-alone', scene: 'night', opts: { seed: 9, dir: 'left', nap: false }, at: day(2, 15), stills: [0.06, 0.3, 0.6, 0.95] },
  { name: 'weather-umbrella', scene: 'weather', opts: { seed: 10, dir: 'right', outfit: 'umbrella' }, at: day(12, 0), stills: [0.15, '@dress+8', '@settled-10', 0.88] },
  { name: 'weather-sunny', scene: 'weather', opts: { seed: 11, dir: 'left', outfit: 'sunny' }, at: day(12, 30), stills: [0.15, '@dress+8', '@settled-10', 0.88] },
  { name: 'weather-cold', scene: 'weather', opts: { seed: 12, dir: 'right', outfit: 'cold' }, at: day(9, 30), stills: [0.15, '@dress+8', 0.88] },
  { name: 'weather-hot', scene: 'weather', opts: { seed: 13, dir: 'left', outfit: 'hot' }, at: day(15, 0), stills: [0.15, '@dress+8', 0.88] },
  { name: 'weather-windy', scene: 'weather', opts: { seed: 14, dir: 'right', outfit: 'windy' }, at: day(17, 0), stills: [0.15, '@dress+8', 0.88] },
  { name: 'cheer', scene: 'cheer', opts: { seed: 15, dir: 'right' }, at: day(18, 0), stills: [0.15, '@cheer-4', '@cheer+3', 0.85] },
  { name: 'shrug', scene: 'shrug', opts: { seed: 16, dir: 'left' }, at: day(18, 30), stills: [0.15, 0.5, 0.85] }
];
const PERCH_POSES = ['sit-edge', 'lie-chin', 'climb'];
const HIGHLIGHTS = ['fetch', 'perch', 'zoomies'];

let PAGE_PORT, LIVE_PORT, PAGE, LIVE;
let preview = null;
let browser = null;
let dataDir = null;
let ffmpeg = null;
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

function findFfmpeg() {
  const tries = ['ffmpeg'];
  try { tries.push(require('child_process').execSync('python3 -c "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch (e) { /* none */ }
  for (const t of tries) {
    try { childProcess.execFileSync(t, ['-version'], { stdio: 'ignore' }); return t; } catch (e) { /* next */ }
  }
  return null;
}

/* ---------- servers ---------- */

async function startAll() {
  PAGE_PORT = await spare();
  LIVE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  LIVE = 'http://127.0.0.1:' + LIVE_PORT;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-clay-shots-'));
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, {
      HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: String(LIVE_PORT), HUB_LIVE_DATA_DIR: dataDir
    }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get(PAGE + '/', (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  await until(() => new Promise((resolve) => {
    http.get(LIVE + '/live/state', (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview\'s hub server did not start');
}

async function stopAll() {
  if (browser) await browser.close().catch(() => {});
  if (preview) preview.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/* ---------- pages ---------- */

function todoItems(at) {
  const items = [
    ['Call the vet about Ember\'s checkup', 'now'], ['Pick up dry cleaning', 'now'], ['Order more coffee beans', 'now'],
    ['Fix the porch light', 'next'], ['Book flights for December', 'next'], ['Package from Mom', 'waiting']
  ].map((t, i) => ({ id: 'shot' + i, title: t[0], section: t[1], done: false, doneAt: null, createdAt: at - 86400000 + i }));
  items.push({ id: 'shotd', title: 'Walk Ember', section: 'now', done: true, doneAt: at - 3600000, createdAt: at - 90000000 });
  return JSON.stringify({ v: 1, items: items });
}

// opts: { at, layout }
async function openHub(opts) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const host = new URL(route.request().url()).hostname;
    if (BLOCKED.indexOf(host) >= 0) return route.abort();
    return route.fallback();
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;   // the blocked weather hosts
    context.errors.push(m.text());
  });
  page.on('pageerror', (e) => context.errors.push(String(e)));
  await page.clock.setFixedTime(new Date(opts.at));
  const storage = { 'homeHub.todo.v1': todoItems(opts.at) };
  if (opts.layout) storage['homeHub.layout'] = JSON.stringify(opts.layout);
  await page.addInitScript((items) => {
    try { for (const k in items) localStorage.setItem(k, items[k]); } catch (e) { /* ignore */ }
  }, storage);
  await page.goto(PAGE + '/hub.html?motion=push&live=' + encodeURIComponent(opts.layout ? 'off' : LIVE));
  await page.waitForFunction(() => window.HUB_TEST && window.HUB_TEST.clay && document.querySelectorAll('#grid .tile').length > 0);
  // The forecast and the calendar, then the glass.
  await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 8000, 'no glass');
  await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="weather"] .wx-temp, .cell[data-widget="weather"] [class*="temp"]')), 8000, 'no forecast')
    .catch(() => console.log('  (the weather tile has no forecast)'));
  await sleep(opts.layout ? 600 : 2500);
  page.context_ = context;
  return page;
}

async function frame(page, file) {
  await page.screenshot({ path: file, type: 'jpeg', quality: QUALITY });
}

// Plays a scene frame by frame into dir/f00000.jpg ...; returns the frame
// count (and remembers the scene's signals in film.beats).
async function film(page, scene, opts, dir, extra) {
  fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(() => { window.HUB_TEST.clay.setSpeed(0); });
  const started = await page.evaluate(([n, o]) => window.HUB_TEST.clay.play(n, o), [scene, opts]);
  if (!started) throw new Error(scene + ' did not start');
  await until(() => page.evaluate(() => window.HUB_TEST.clay.state().phase === 'playing'), 10000, scene + ' did not load');
  let n = 0;
  let beats = {};
  const boxes = [];
  for (;;) {
    const st = await page.evaluate(() => window.HUB_TEST.clay.state());
    if (st.phase !== 'playing') break;
    beats = st.beats;
    boxes[n] = await page.evaluate(() => {
      let b = null;
      for (const img of document.querySelectorAll('.clay-actor img')) {
        if (img.style.opacity !== '1') continue;
        const r = img.getBoundingClientRect();
        if (r.right < 0 || r.left > 1920) continue;
        b = b ? { l: Math.min(b.l, r.left), t: Math.min(b.t, r.top), r: Math.max(b.r, r.right), b: Math.max(b.b, r.bottom) } :
          { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
      return b;
    });
    expect(st.chars <= 2 && st.props <= 3, scene + ': too much on screen at tick ' + st.tick + ' (' + st.chars + ' characters, ' + st.props + ' props)');
    await frame(page, path.join(dir, 'f' + String(n).padStart(5, '0') + '.jpg'));
    n++;
    if (extra && (await extra(page, n))) break;
    await page.evaluate((ms) => window.HUB_TEST.clay.advance(ms), 1000 / FPS);
    if (n > 120 * FPS) throw new Error(scene + ' never ended');
  }
  film.beats = beats;
  film.boxes = boxes;
  const last = await page.evaluate(() => window.HUB_TEST.clay.state().last);
  if (!extra) expect(last && last.result === 'done', scene + ' ended with ' + JSON.stringify(last));
  expect(await page.evaluate(() => !document.querySelector('.clay-layer')), scene + ' left its layer behind');
  return n;
}

// Adds n copies of the last frame (a pause), for joining scenes.
function pad(dir, count, n) {
  const lastFile = path.join(dir, 'f' + String(count - 1).padStart(5, '0') + '.jpg');
  n = Math.round(n * PER_TICK);
  for (let i = 0; i < n; i++) fs.copyFileSync(lastFile, path.join(dir, 'f' + String(count + i).padStart(5, '0') + '.jpg'));
  return count + n;
}

function encode(dir, file) {
  if (!ffmpeg) return;
  childProcess.execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', file]);
  written.push(file);
}

function keep(src, name) {
  const file = path.join(OUT, name);
  fs.copyFileSync(src, file);
  written.push(file);
}

// Frame 0 shows the scene at the end of tick 1; tick t ends PER_TICK frames later each.
function stillIndex(s, count, beats) {
  let i;
  if (typeof s === 'string') {
    const m = /^@([\w-]+?)([+-]\d+)?$/.exec(s);
    if (!m || !beats || !beats[m[1]]) throw new Error('no signal ' + s);
    i = Math.round((beats[m[1]] - 1 + (m[2] ? parseInt(m[2], 10) : 0)) * PER_TICK);
  } else {
    i = Math.round(s * (count - 1));
  }
  return Math.max(0, Math.min(count - 1, i));
}

/* ---------- the runs ---------- */

const keyFrames = [];   // [file, label, box of the characters] for the contact sheet
const allStills = [];   // the same for every still (REVIEW=1)
const frameDirs = {};   // name -> { dir, count }

async function sceneShots(work) {
  for (const s of SHOTS) {
    if (ONLY.length && ONLY.indexOf(s.name) < 0) continue;
    const page = await openHub({ at: s.at });
    const dir = path.join(work, s.name);
    const count = await film(page, s.scene, s.opts, dir);
    s.stills.forEach((f, i) => {
      const at = stillIndex(f, count, film.beats);
      keep(path.join(dir, 'f' + String(at).padStart(5, '0') + '.jpg'), s.name + '-' + (i + 1) + '.jpg');
      allStills.push([path.join(OUT, s.name + '-' + (i + 1) + '.jpg'), s.name + '-' + (i + 1), film.boxes[at]]);
      if (i === (s.key || 1)) keyFrames.push(allStills[allStills.length - 1]);
    });
    encode(dir, path.join(OUT, s.name + '.mp4'));
    frameDirs[s.name] = { dir, count };
    expect(!page.context_.errors.length, s.name + ': console errors: ' + page.context_.errors.join(' | '));
    console.log('ok    ' + s.name + ' (' + count + ' frames, ' + (count / FPS).toFixed(1) + ' s, ' + (await page.evaluate(() => window.HUB_TEST.clay.drawing().text)) + ')');
    await page.context_.close();
  }
}

// One still per perch pose, mid-rest, and one on another layout.
async function perchShots(work) {
  if (ONLY.length && ONLY.indexOf('perch') < 0) return;
  const runs = PERCH_POSES.map((p, i) => ({ name: 'perch-' + p, opts: { seed: 20 + i, pose: p, ledge: i }, layout: null }));
  runs.push({ name: 'perch-other-layout', opts: { seed: 31, pose: 'sit-edge', ledge: 2 }, layout: OTHER_LAYOUT });
  runs.push({ name: 'stroll-other-layout', scene: 'stroll', opts: { seed: 32, dir: 'left' }, layout: OTHER_LAYOUT, at: 0.45 });
  for (const r of runs) {
    const page = await openHub({ at: day(13, 30), layout: r.layout });
    const dir = path.join(work, r.name);
    const count = await film(page, r.scene || 'perch', r.opts, dir);
    const at = stillIndex(r.at || 0.5, count);
    keep(path.join(dir, 'f' + String(at).padStart(5, '0') + '.jpg'), r.name + '.jpg');
    allStills.push([path.join(OUT, r.name + '.jpg'), r.name, film.boxes[at]]);
    if (r.name !== 'stroll-other-layout') keyFrames.push(allStills[allStills.length - 1]);
    expect(!page.context_.errors.length, r.name + ': console errors: ' + page.context_.errors.join(' | '));
    console.log('ok    ' + r.name);
    await page.context_.close();
  }
}

// A scene interrupted by a key press: the frame before, the frame after, and a clip.
async function vanishShots(work) {
  if (ONLY.length && ONLY.indexOf('vanish') < 0) return;
  const page = await openHub({ at: day(14, 45) });
  const dir = path.join(work, 'vanish');
  // Calm first: a few seconds of the plain home screen.
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  await frame(page, path.join(dir, 'f00000.jpg'));
  n = pad(dir, 1, 13);   // in ticks' worth of frames
  const sub = path.join(work, 'vanish-scene');
  let pressedAt = -1;
  let after = 0;
  const count = await film(page, 'fetch', { seed: 41, dir: 'right' }, sub, async (p, i) => {
    if (pressedAt < 0 && i === Math.round(80 * PER_TICK)) {
      keep(path.join(sub, 'f' + String(i - 1).padStart(5, '0') + '.jpg'), 'vanish-before.jpg');
      const before = await p.evaluate(() => document.querySelector('#grid .tile.is-focused').parentNode.getAttribute('data-widget'));
      await p.keyboard.press('ArrowRight');
      const st = await p.evaluate(() => ({ layer: !!document.querySelector('.clay-layer'), focus: document.querySelector('#grid .tile.is-focused').parentNode.getAttribute('data-widget') }));
      expect(!st.layer && st.focus !== before, 'vanish: layer ' + st.layer + ', focus ' + before + ' -> ' + st.focus);
      pressedAt = i;
      return true;
    }
    return false;
  });
  const afterFile = path.join(sub, 'f' + String(count).padStart(5, '0') + '.jpg');
  await frame(page, afterFile);
  keep(afterFile, 'vanish-after.jpg');
  // A second key press a moment later, to show focus keeps moving at once.
  for (let i = 0; i < count + 1; i++) fs.copyFileSync(path.join(sub, 'f' + String(i).padStart(5, '0') + '.jpg'), path.join(dir, 'f' + String(n + i).padStart(5, '0') + '.jpg'));
  n = pad(dir, n + count + 1, 6);
  await page.keyboard.press('ArrowRight');
  await frame(page, path.join(dir, 'f' + String(n).padStart(5, '0') + '.jpg'));
  n = pad(dir, n + 1, 14);
  after = n;
  encode(dir, path.join(OUT, 'vanish-on-key.mp4'));
  expect(!page.context_.errors.length, 'vanish: console errors: ' + page.context_.errors.join(' | '));
  console.log('ok    vanish (' + after + ' frames, key at frame ' + pressedAt + ')');
  await page.context_.close();
}

// Three scenes back to back, with a short clean screen between.
function highlights(work) {
  const have = HIGHLIGHTS.filter((n) => frameDirs[n]);
  if (have.length < 2 || !ffmpeg) return;
  const dir = path.join(work, 'highlights');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const name of have) {
    const src = frameDirs[name];
    for (let i = 0; i < src.count; i++) {
      fs.copyFileSync(path.join(src.dir, 'f' + String(i).padStart(5, '0') + '.jpg'), path.join(dir, 'f' + String(n++).padStart(5, '0') + '.jpg'));
    }
    n = pad(dir, n, 10);
  }
  encode(dir, path.join(OUT, 'highlights.mp4'));
  console.log('ok    highlights (' + (n / FPS).toFixed(1) + ' s)');
}

// One frame per scene with its name, four across, each a 960x540 window
// on the characters (half the screen), so they are big enough to see.
async function contactSheet(list, name) {
  if (!list.length) return;
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cols = 4;
  const rows = Math.ceil(list.length / cols);
  const cells = list.map(([file, label, box]) => {
    const cx = box ? (box.l + box.r) / 2 : 960;
    const cy = box ? (box.t + box.b) / 2 : 540;
    const x = Math.max(0, Math.min(960, cx - 480));
    const y = Math.max(0, Math.min(540, cy - 270));
    // The 960x540 window from (x, y), shown at 465 px wide.
    const k = 465 / 960;
    return '<figure><div class="w"><img src="data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64') +
      '" style="left:' + (-x * k) + 'px;top:' + (-y * k) + 'px"></div><figcaption>' + label + '</figcaption></figure>';
  }).join('');
  await page.setViewportSize({ width: 1920, height: rows * 316 + 20 });
  await page.setContent('<!doctype html><style>body{margin:0;padding:10px;background:#0b0e14;font:600 20px Arial,sans-serif;color:#e8eaf0}' +
    'figure{display:inline-block;margin:0 0 6px 8px;width:465px;vertical-align:top}' +
    '.w{position:relative;width:465px;height:262px;overflow:hidden;border-radius:6px}' +
    '.w img{position:absolute;width:930px;height:523px}figcaption{padding:6px 2px 8px}</style>' + cells);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, type: 'jpeg', quality: QUALITY, fullPage: true });
  written.push(file);
  await context.close();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  ffmpeg = findFfmpeg();
  if (!ffmpeg) console.log('No ffmpeg: stills only.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-clay-frames-'));
  await startAll();
  browser = await chromium.launch();
  try {
    await sceneShots(work);
    await perchShots(work);
    await vanishShots(work);
    highlights(work);
    if (!ONLY.length) await contactSheet(keyFrames, 'all-scenes.jpg');
    if (process.env.REVIEW) await contactSheet(allStills, 'review.jpg');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  problems.push(String(e && e.stack));
  console.log('FAIL  ' + (e && e.stack));
}).then(async () => {
  await stopAll();
  for (const f of written) {
    try { console.log((fs.statSync(f).size / 1024).toFixed(0).padStart(7) + ' KB  ' + path.basename(f)); } catch (e) { /* ignore */ }
  }
  console.log(written.length + ' files in ' + OUT + (problems.length ? '; ' + problems.length + ' problems' : ''));
  process.exit(problems.length ? 1 : 0);
});
