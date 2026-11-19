/*
 * Pictures and a clip of the working chips (app/motion.js):
 *   node dev/working-shots.js --out <folder> [--clip] [--only <text>]
 *
 * Uses the preview (node dev/preview.js on 8090, with its hub server on
 * 8097, the sample calendars and the Spotify stand-in); starts it when it
 * isn't running. 1920x1080 at device scale 2, wanderers off (?clay=off).
 * The signal goes the real way: a say command to the preview's hub server.
 *
 *   working-todo-en.png, working-calendar-en.png, working-awws-en.png,
 *     working-all-en.png (and -es): the working chips a moment after
 *     "hub:working <kind>" arrived (all three at once for -all).
 *   handoff-todo-en.png: just after a new to-do turned the working chip into
 *     "Incoming to-do".
 *   --clip: working-handoff.mp4 (webm without ffmpeg): the signal arrives,
 *     the chip breathes a few seconds, the to-do lands, the chip becomes
 *     "Incoming to-do" with the light lapping the border, then fades.
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
const BLOCKED = ['192.168.1.219', 'api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev'];

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'working-shots');
const CLIP = args.indexOf('--clip') >= 0;
const ONLY = arg('--only') || '';

// Spanish for the rest of the screen (as in dev/motion-shots.js) and the chips.
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
  ';window.HUB_PLANNED_STRINGS = ' + JSON.stringify(PLANNED_ES) + ';window.HUB_TODO_STRINGS = ' + JSON.stringify(TODO_ES) +
  ';try { localStorage.setItem("homeHub.lang", "es"); } catch (e) {}';
const LIVE_Q = 'live=' + encodeURIComponent(LIVE) + '&motion=push';

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

const say = (text) => post('/api/command', { type: 'say', data: { text: text } });
const TODO_TITLES = ['Write to the library about the visit', 'Send the Maple Grove photos', 'Order more activity sheets', 'Call Cedar Hollow back'];
let todoN = 0;
const newTodo = () => post('/api/todo', { title: TODO_TITLES[todoN++ % TODO_TITLES.length], section: 'now' });

async function newPage(o) {
  const opts = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: o.video ? 1 : 2 };
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
  await page.goto(PAGE + '/hub.html?clay=off&' + LIVE_Q);
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'not live');
  await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 6000, 'no glass');
  await sleep(o.settle || 1500);
  return page;
}

// Ends every working chip, so the next page starts clean (they end by themselves anyway).
async function clear() { for (const k of ['todo', 'calendar', 'awws']) await say('hub:working ' + k + ' done'); }

async function shots() {
  for (const lang of ['en', 'es']) {
    for (const kind of ['todo', 'calendar', 'awws', 'all']) {
      const name = 'working-' + kind + '-' + lang + '.png';
      if (ONLY && name.indexOf(ONLY) < 0) continue;
      const page = await newPage({ init: lang === 'es' ? SPANISH_INIT : undefined });
      const kinds = kind === 'all' ? ['todo', 'calendar', 'awws'] : [kind];
      for (const k of kinds) await say('hub:working ' + k);
      await until(() => page.evaluate((n) => document.querySelectorAll('.fx-chip-working.is-in').length >= n, kinds.length), 5000, 'no chip for ' + name);
      await sleep(600);
      await page.screenshot({ path: path.join(OUT, name) });
      const words = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.fx-chip'), (c) => c.textContent).join(', '));
      console.log('  ' + name + ' (' + words + ')');
      await clear();
      await page.context().close();
    }
  }
  const name = 'handoff-todo-en.png';
  if (!ONLY || name.indexOf(ONLY) >= 0) {
    const page = await newPage({});
    await say('hub:working todo');
    await until(() => page.evaluate(() => !!document.querySelector('.fx-chip-working.is-in')), 5000, 'no working chip');
    await sleep(1200);
    await newTodo();
    await until(() => page.evaluate(() => /Incoming to-do/.test((document.querySelector('.fx-chip') || {}).textContent || '')), 5000, 'no hand-off');
    await sleep(350);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('  ' + name);
    await page.context().close();
  }
}

function hasFfmpeg() {
  try { childProcess.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

async function clip() {
  const tmpDir = path.join(OUT, '.video');
  const ff = hasFfmpeg();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const page = await newPage({ video: tmpDir });
  const start = (Date.now() - page.bornAt) / 1000;
  await sleep(800);
  await say('hub:working todo');
  await sleep(4200);              // the chip breathes
  await newTodo();                // the to-do lands: the chip becomes "Incoming to-do"
  await sleep(3600);              // the hold, the sweep, the fade
  const video = page.video();
  await page.context().close();
  const src = await video.path();
  const dest = path.join(OUT, 'working-handoff' + (ff ? '.mp4' : '.webm'));
  if (ff) {
    childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', Math.max(0, start).toFixed(2), '-i', src,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium', '-r', '30', '-movflags', '+faststart', dest]);
  } else {
    fs.copyFileSync(src, dest);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  ' + path.basename(dest));
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
  if (CLIP) { console.log('Clip:'); await clip(); }
}

main().catch((e) => { console.error(e && e.stack); process.exitCode = 1; }).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  if (preview) preview.kill();
});
