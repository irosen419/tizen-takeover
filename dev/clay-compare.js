/*
 * Before and after films of the clay wanderers: node dev/clay-compare.js [OUT_DIR]
 *
 * "Before" is the real old engine: the tree at OLD_REF (default b119887,
 * the last version drawn only on the ticks, 7 times a second) is taken out
 * with git archive into a temporary folder and run there with its own art.
 * "After" is this tree as it is. Each runs in its own preview (dev/preview.js
 * on spare ports, so port 8095 need not be free) and headless Chromium at
 * 1920x1080, with the TV clock and the scene fixed so both play the same
 * thing. Before is filmed one frame per tick (step()); after at 30 frames a
 * second (advance(1000 / 30)), as the TV would draw it smoothly. Each frame
 * is cropped to where the scene happens and labelled in the picture.
 *
 * Writes to OUT_DIR (default docs/screenshots/clay/compare), with ffmpeg:
 *   compare-stroll.mp4         stroll, before above after (35 s)
 *   compare-perch.mp4          perch (the climb), before above after (23 s)
 *   about-panel-drawing.jpg    the About panel with its Drawing row, during zoomies
 * The frames are kept in OUT_DIR/frames. Headless desktop Chromium shows the
 * drawing logic, not how smooth the TV is.
 * Needs Playwright, git and ffmpeg. Nothing here reaches the internet.
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
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots', 'clay', 'compare'));
const OLD_REF = process.env.OLD_REF || 'b119887';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'cdn.jsdelivr.net', '192.168.1.219'];
const FPS = 30;
const TICK = 140;
const QUALITY = 88;

// What to film: the scene, its play() options, the TV clock, the crop and
// how long the film is (the shorter old scene holds its last frame).
const STRIP = { x: 0, y: 740, width: 1920, height: 340 };
const FILMS = [
  { name: 'stroll', opts: { seed: 3, dir: 'right' }, at: '2026-11-16T14:10:00', clip: STRIP, seconds: 35, scale: 1280 },
  { name: 'perch', opts: { seed: 1, pose: 'climb', ledge: 0 }, at: '2026-11-16T13:00:00', clip: { x: 0, y: 0, width: 640, height: 420 }, seconds: 23 }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sparePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// Starts dev/preview.js of the tree at root on spare ports. { page, stop }.
async function preview(root) {
  const pagePort = await sparePort();
  const env = Object.assign({}, process.env, {
    HUB_PAGE_PORT: String(pagePort),
    HUB_SERVICE_PORT: String(await sparePort()),
    HUB_LIVE_PORT: String(await sparePort()),
    HUB_LIVE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'clay-compare-live-'))
  });
  const child = childProcess.spawn(process.execPath, [path.join(root, 'dev', 'preview.js')], { env: env, stdio: 'ignore' });
  const page = 'http://127.0.0.1:' + pagePort;
  for (let i = 0; i < 150; i++) {
    const up = await new Promise((r) => http.get(page + '/', (res) => { res.resume(); r(true); }).on('error', () => r(false)));
    if (up) return { page: page, stop: () => child.kill() };
    await sleep(100);
  }
  child.kill();
  throw new Error('the preview in ' + root + ' did not start');
}

async function openHub(browser, base, at) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return BLOCKED.indexOf(host) >= 0 ? route.abort() : route.fallback();
  });
  const page = await context.newPage();
  page.errs = [];
  page.on('pageerror', (e) => page.errs.push(String(e)));
  // The TV clock fixed for the films (the About shot runs on real time, as
  // the drawing rate is measured with it).
  if (at) await page.clock.setFixedTime(new Date(at));
  await page.goto(base + '/hub.html?motion=push&live=off');
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await sleep(2500);
  return page;
}

// Films one scene into dir as f00000.jpg ...: one frame per tick (old) or
// at FPS (new). Returns the number of frames.
async function film(browser, base, f, old, label, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const page = await openHub(browser, base, f.at);
  await page.evaluate(([text, c]) => {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'position:fixed;z-index:99;left:' + (c.x + 16) + 'px;top:' + (c.y + 12) + 'px;' +
      'font:700 34px Arial,sans-serif;color:#fff;background:rgba(0,0,0,0.55);padding:4px 14px;border-radius:8px';
    document.body.appendChild(d);
  }, [label, f.clip]);
  await page.evaluate(([n, o]) => { window.HUB_TEST.clay.setSpeed(0); window.HUB_TEST.clay.play(n, o); }, [f.name, f.opts]);
  await page.waitForFunction(() => window.HUB_TEST.clay.state().phase === 'playing');
  let n = 0;
  const shot = () => page.screenshot({ path: path.join(dir, 'f' + String(n++).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: QUALITY, clip: f.clip });
  while ((await page.evaluate(() => window.HUB_TEST.clay.state().phase)) === 'playing' && n < 5000) {
    await shot();
    if (old) await page.evaluate(() => window.HUB_TEST.clay.step());
    else await page.evaluate((ms) => window.HUB_TEST.clay.advance(ms), 1000 / FPS);
  }
  await shot();
  if (page.errs.length) console.log('  ' + label + ': ' + page.errs.join(' | '));
  await page.context().close();
  return n;
}

function ffmpeg(args) {
  const r = childProcess.spawnSync('ffmpeg', ['-loglevel', 'error', '-y'].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-compare-old-'));
  const tar = childProcess.spawnSync('sh', ['-c', 'git archive ' + OLD_REF + ' | tar -x -C "' + oldRoot + '"'], { cwd: ROOT, stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('could not take out ' + OLD_REF);
  const browser = await chromium.launch();
  const before = await preview(oldRoot);
  const after = await preview(ROOT);
  try {
    for (const f of FILMS) {
      const oldDir = path.join(OUT, 'frames', 'old-' + f.name);
      const newDir = path.join(OUT, 'frames', 'new-' + f.name);
      const a = await film(browser, before.page, f, true, 'Before', oldDir);
      const b = await film(browser, after.page, f, false, 'After', newDir);
      // Before at its real 7 frames a second, held on its last frame; after at 30.
      const scale = f.scale ? ',scale=' + f.scale + ':-2' : '';
      ffmpeg(['-framerate', '1000/' + TICK, '-i', path.join(oldDir, 'f%05d.jpg'), '-framerate', String(FPS), '-i', path.join(newDir, 'f%05d.jpg'),
        '-filter_complex', '[0]fps=' + FPS + ',tpad=stop_mode=clone:stop_duration=30[a];[1]tpad=stop_mode=clone:stop_duration=30[b];[a][b]vstack=2' + scale + ',trim=duration=' + f.seconds,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart',
        path.join(OUT, 'compare-' + f.name + '.mp4')]);
      console.log('ok    compare-' + f.name + '.mp4 (before ' + a + ' frames, after ' + b + ')');
    }
    // The About panel during a visit, once the drawing has been measured.
    const page = await openHub(browser, after.page, null);
    await page.evaluate(() => window.HUB_TEST.clay.play('zoomies', { seed: 4, dir: 'right' }));
    await page.waitForFunction(() => window.HUB_TEST.clay.state().phase === 'playing');
    await sleep(4000);
    await page.evaluate(() => window.HUB_TEST.about.open());
    await sleep(2600);
    const rows = await page.evaluate(() => window.HUB_TEST.about.rows().map((r) => r.label + ': ' + r.value));
    await page.screenshot({ path: path.join(OUT, 'about-panel-drawing.jpg'), type: 'jpeg', quality: 90 });
    console.log('ok    about-panel-drawing.jpg (' + rows.filter((r) => /^Drawing/.test(r)).join('') + ')');
    await page.context().close();
  } finally {
    before.stop();
    after.stop();
    await browser.close();
    fs.rmSync(oldRoot, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
