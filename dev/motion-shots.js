/*
 * Pictures and clips of the motion extras (app/motion.js):
 *   node dev/motion-shots.js --out <folder> [--clip] [--fps] [--only <text>]
 *
 * Uses the preview (node dev/preview.js on 8090, with its hub server on
 * 8097, the sample calendars and the Spotify stand-in); starts it when it
 * isn't running. 1920x1080, wanderers off (?clay=off).
 *
 *   quiet-before-en.png, quiet-after-en.png (and -es): the waiting tiles
 *     (the Pi out of reach) with the extras off (?fx=off, as before) and on.
 *   --clip: one mp4 per moment (needs ffmpeg; webm without it): quiet tiles,
 *     ring, stagger, handoff, cover, bloom, in the real hub.
 *   --fps: the frame rate headless Chromium reached during each motion
 *     (three runs each), printed and saved as fps.json. A desktop is not the
 *     TV: these numbers say the motion is cheap, not that the TV is smooth.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const { SPANISH: AWWS_ES } = require('./awws-harness');

const PAGE = 'http://127.0.0.1:8090';
const LIVE = 'http://127.0.0.1:8097';
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['192.168.1.219', 'api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io'];

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'motion-shots');
const CLIP = args.indexOf('--clip') >= 0;
const FPS = args.indexOf('--fps') >= 0;
const ONLY = arg('--only') || '';

const CAL_ES = { states: {
  quiet: { head: 'El calendario necesita la Raspberry Pi', short: 'Esperando al servidor del hub en la Pi.' },
  off: { head: 'El calendario necesita la Raspberry Pi', short: 'Las actualizaciones en vivo están apagadas.' }
} };
const PLANNED_ES = { texts: {
  mirror: 'Un espejo con cámara para las mañanas y las salidas de noche.',
  ambiance: 'Elegir el ambiente de luz desde el televisor, sin levantarse del sofá.'
} };
const TODO_ES = { sub: 'En este televisor', emptyTitle: 'Todavía no hay nada en la lista.', emptyHint: 'Pulsa OK para añadir algo.' };
const SPANISH_INIT = 'window.HUB_AWWS_STRINGS = ' + JSON.stringify(AWWS_ES) + ';window.HUB_CALENDAR_STRINGS = ' + JSON.stringify(CAL_ES) +
  ';window.HUB_PLANNED_STRINGS = ' + JSON.stringify(PLANNED_ES) + ';window.HUB_TODO_STRINGS = ' + JSON.stringify(TODO_ES) + ';';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
let preview = null;

function up(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 600 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false)).on('timeout', () => resolve(false));
  });
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { /* again */ } await sleep(50); }
  throw new Error(text);
}

function post(route, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(LIVE + route, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function newPage(o) {
  const opts = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 };
  if (o.video) opts.recordVideo = { dir: o.video, size: { width: 1920, height: 1080 } };
  const context = await browser.newContext(opts);
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return BLOCKED.indexOf(u.hostname) >= 0 ? route.abort() : route.continue();
  });
  if (o.init) await context.addInitScript(o.init);
  const page = await context.newPage();
  page.bornAt = Date.now();
  page.on('pageerror', (e) => console.log('  page error: ' + e.message));
  await page.goto(PAGE + '/hub.html?clay=off' + (o.query ? '&' + o.query : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  if (/live=/.test(o.query || '')) await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'not live');
  await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 6000, 'no glass');
  await sleep(o.settle || 800);
  return page;
}

const LIVE_Q = 'live=' + encodeURIComponent(LIVE) + '&motion=push';

/* ---------- the moments ---------- */

// Each: { name, query, init, run(page) } where run plays the moment once.
const MOMENTS = [
  { name: '1-quiet-tiles', query: 'motion=push', async run(page) {
    // The waiting tiles brighten only when focused; the ring passes over them.
    for (const k of ['ArrowUp', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowDown']) { await page.keyboard.press(k); await sleep(650); }
  } },
  { name: '2-stagger', query: LIVE_Q, async run(page) {
    await page.keyboard.press('Enter');
    await sleep(1600);
    await page.keyboard.press('Escape');
    await sleep(700);
    await page.keyboard.press('Enter');
    await sleep(1600);
    await page.keyboard.press('Escape');
    await sleep(500);
  } },
  { name: '3-focus-ring', query: LIVE_Q, async run(page) {
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowLeft']) {
      await page.keyboard.press(k);
      await sleep(520);
    }
  } },
  { name: '4-handoff', query: LIVE_Q, async run(page) {
    await sleep(400);
    await post('/api/todo', { title: 'Write to the library about the visit', section: 'now' });
    await sleep(2600);
  } },
  { name: '5-cover-flight', query: LIVE_Q, async run(page) {
    await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await sleep(1300);
    await page.evaluate(() => document.querySelector('.panel-btn').click());
    await sleep(2400);
    await page.keyboard.press('Escape');
    await sleep(1400);
    await page.keyboard.press('Escape');
    await sleep(700);
  } },
  { name: '6-launch-bloom', query: LIVE_Q, async run(page) {
    await page.keyboard.press('Enter');
    await sleep(1300);
    await page.keyboard.press('Enter');         // Netflix, the first item
    await sleep(2200);
  } }
];

async function shots() {
  for (const lang of ['en', 'es']) {
    for (const when of ['before', 'after']) {
      const name = 'quiet-' + when + '-' + lang + '.png';
      if (ONLY && name.indexOf(ONLY) < 0) continue;
      const page = await newPage({ query: 'motion=push' + (when === 'before' ? '&fx=off' : ''), init: lang === 'es' ? SPANISH_INIT : undefined, settle: 1500 });
      await page.screenshot({ path: path.join(OUT, name) });
      console.log('  ' + name);
      await page.context().close();
    }
  }
}

function hasFfmpeg() {
  try { childProcess.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

async function clips() {
  const tmpDir = path.join(OUT, '.video');
  const ff = hasFfmpeg();
  for (const m of MOMENTS) {
    if (ONLY && m.name.indexOf(ONLY) < 0) continue;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const page = await newPage({ query: m.query, init: m.init, video: tmpDir });
    const start = (Date.now() - page.bornAt) / 1000;
    await sleep(500);
    await m.run(page);
    await sleep(400);
    const video = page.video();
    await page.context().close();
    const src = await video.path();
    const dest = path.join(OUT, m.name + (ff ? '.mp4' : '.webm'));
    if (ff) {
      childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', Math.max(0, start).toFixed(2), '-i', src,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium', '-r', '30', '-movflags', '+faststart', dest]);
    } else {
      fs.copyFileSync(src, dest);
    }
    console.log('  ' + path.basename(dest));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/* ---------- frame rates ---------- */

// Counts frames in the page from now for ms; { fps, worst, frames }.
function sampler(page, ms) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const t = [];
    const t0 = performance.now();
    (function f(now) { t.push(now); if (now - t0 < ms) requestAnimationFrame(f); else {
      let worst = 0;
      for (let i = 1; i < t.length; i++) worst = Math.max(worst, t[i] - t[i - 1]);
      const span = t[t.length - 1] - t[0];
      resolve({ fps: Math.round((t.length - 1) * 1000 / span), worst: Math.round(worst), frames: t.length });
    } })(performance.now());
  }), ms);
}

const MEASURE = [
  { name: 'ring glide (190 ms)', query: LIVE_Q, ms: 260, async go(page, i) { await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowLeft'); } },
  { name: 'open Entertainment: grow + stagger (500 ms)', query: LIVE_Q, ms: 600, async go(page) { await page.keyboard.press('Enter'); }, async reset(page) { await page.keyboard.press('Escape'); await sleep(700); } },
  { name: 'handoff dot + row + pulse (900 + 260 ms)', query: LIVE_Q, ms: 1300, async go(page, i) { await post('/api/todo', { title: 'Measure ' + Date.now() + ' ' + i, section: 'now' }); await sleep(120); } },
  { name: 'cover flight to the card (520 ms, visualizer on)', query: LIVE_Q, ms: 600, async pre(page) { await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying')); await sleep(1200); },
    async go(page) { await page.evaluate(() => document.querySelector('.panel-btn').click()); }, async reset(page) { await sleep(400); await page.keyboard.press('Escape'); await sleep(900); } },
  { name: 'launch bloom (480 ms)', query: LIVE_Q, ms: 560, async pre(page) { await page.keyboard.press('Enter'); await sleep(1200); },
    async go(page) { await page.keyboard.press('Enter'); }, async reset(page) { await sleep(3400); } },
  { name: 'idle home screen (for comparison)', query: LIVE_Q, ms: 1000, async go() {} }
];

async function rates() {
  const out = [];
  for (const m of MEASURE) {
    const page = await newPage({ query: m.query, settle: 1200 });
    if (m.pre) await m.pre(page);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = sampler(page, m.ms);
      await m.go(page, i);
      runs.push(await s);
      if (m.reset) await m.reset(page); else await sleep(700);
    }
    const fps = runs.map((r) => r.fps).sort((a, b) => a - b);
    const row = { motion: m.name, fps: runs.map((r) => r.fps), worstFrameMs: runs.map((r) => r.worst), medianFps: fps[1] };
    out.push(row);
    console.log('  ' + m.name + ': ' + row.fps.join(', ') + ' fps (worst frame ' + row.worstFrameMs.join(', ') + ' ms)');
    await page.context().close();
  }
  fs.writeFileSync(path.join(OUT, 'fps.json'), JSON.stringify({ note: 'Headless Chromium ' + browser.version() + ' on a cloud machine, no GPU. Not the TV.', results: out }, null, 2) + '\n');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!(await up(PAGE + '/'))) {
    preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], { stdio: 'ignore' });
    await until(() => up(PAGE + '/'), 10000, 'the preview did not start');
    await until(() => up(LIVE + '/health'), 10000, 'the preview hub server did not start');
    await sleep(1500);
  }
  browser = await chromium.launch();
  console.log('Pictures:');
  await shots();
  if (CLIP) { console.log('Clips:'); await clips(); }
  if (FPS) { console.log('Frame rates (headless, not the TV):'); await rates(); }
}

main().catch((e) => { console.error(e && e.stack); process.exitCode = 1; }).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
});
