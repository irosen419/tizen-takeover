/*
 * Before and after pictures, a filmstrip and clips of the characters
 * (app/agents.js):
 *   node dev/agents-shots.js --out <folder> [--clip] [--only <text>]
 *
 * Uses the preview (node dev/preview.js on 8090, with its hub server on
 * 8097, the sample calendars and the Spotify stand-in); starts it when it
 * isn't running. 1920x1080 at device scale 2, wanderers off (?clay=off).
 * Her pictures are loaded at once on the page that has her.
 *
 * Each pair changes only the character: two pages open side by side, one
 * with ?agent=off (the chip, as before), get the same signal at the same
 * moment (a say to the preview's hub server, or a calendar change), and
 * when she is at work every running animation on both pages is paused at
 * the same time point before the two screenshots, in the same minute (the
 * clock tile). The script then counts the pixels that differ outside her
 * box and the off page's chip: it should be 0.
 *
 *   todo-working-{off,on}.png       "Working on to-dos" vs Lift at work (no chip)
 *   calendar-arrival-{off,on}.png   "Updating calendar" vs Lift at work at the first event, mid-sequence
 *   todo-working-es-{off,on}.png    the same in Spanish
 *   lift-1080p.png                  her at work at her size on the 1080p screen (a crop at scale 1)
 *   lift-phases.png                 the to-do tile through the whole sequence (working,
 *                                   then a new to-do), one real capture per phase, labelled
 *   --clip: lift-sequence.mp4 (the to-do tile: working, then a new to-do)
 *           and lift-calendar.mp4 (a calendar change alone); webm without ffmpeg.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const PAGE = 'http://127.0.0.1:8090';
const SERVICE = 'http://127.0.0.1:8095';
const LIVE = 'http://127.0.0.1:8097';
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['192.168.1.219', 'api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io'];
const LIVE_Q = 'live=' + encodeURIComponent(LIVE) + '&motion=push';
const ES_INIT = 'try { localStorage.setItem("homeHub.lang", "es"); } catch (e) {}';

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'agents-shots');
const CLIP = args.indexOf('--clip') >= 0;
const ONLY = arg('--only') || '';

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
const calendarMode = (mode) => up(SERVICE + '/preview?calendar=' + mode);
const postTodo = (title) => post('/api/todo', { title: title, section: 'now' });

async function newPage(o) {
  const opts = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: o.scale || 2 };
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
  await page.goto(PAGE + '/hub.html?clay=off&' + LIVE_Q + (o.off ? '&agent=off' : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, 'not live');
  await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 6000, 'no glass');
  await sleep(o.settle || 1500);
  if (!o.off) {
    await page.evaluate(() => window.HUB_AGENTS.test.load());
    await until(() => page.evaluate(() => window.HUB_AGENTS.test.state().pictures === 'ready'), 8000, 'her pictures did not load');
  }
  return page;
}

// Pauses every running animation at the same point, so two pages draw the same frame.
const freeze = (page, t) => page.evaluate((at) => {
  document.getAnimations().forEach((a) => {
    try {
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      const delay = timing && timing.delay ? timing.delay : 0;
      a.pause();
      // A loop with a negative delay joins the wall clock (the weather
      // scene's): paused where it is, it matches the other page, paused a
      // few ms apart. Every other one: the same active time on both pages;
      // a finite one past its end stays there.
      if (delay < 0) return;
      if (timing && timing.endTime !== Infinity && timing.endTime <= at) a.currentTime = timing.endTime;
      else a.currentTime = at;
    } catch (e) { /* leave it */ }
  });
}, t);

// The box of the character (as drawn, raised to where she works) and any
// burst, in screen px; with chips: every chip's too (the off page's).
const herBox = (page, chips) => page.evaluate((withChips) => {
  const list = document.querySelectorAll('.ag-ride, .ag-burst' + (withChips ? ', .fx-chip' : ''));
  if (!list.length) return null;
  const b = { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 };
  list.forEach((n) => {
    const r = n.getBoundingClientRect();
    b.left = Math.min(b.left, r.left); b.top = Math.min(b.top, r.top); b.right = Math.max(b.right, r.right); b.bottom = Math.max(b.bottom, r.bottom);
  });
  return b;
}, !!chips);

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

// Waits until widget's character is in phase want (or later).
const atPhase = (page, widget, want, ms) => until(() => page.evaluate((a) => {
  const f = window.HUB_AGENTS.test.state().figs.filter((x) => x.widget === a[0])[0];
  return !!f && f.phases.indexOf(a[1]) >= 0;
}, [widget, want]), ms || 8000, 'she did not reach ' + want + ' on ' + widget);

// Pixels that differ between the two pictures outside box (python3 with Pillow).
function diffOutside(a, b, box, scale) {
  const py = 'import sys\nfrom PIL import Image, ImageChops\n' +
    'a=Image.open(sys.argv[1]).convert("RGB"); b=Image.open(sys.argv[2]).convert("RGB")\n' +
    'd=ImageChops.difference(a,b).convert("L").point(lambda v: 255 if v>6 else 0)\n' +
    'l,t,r,bt=[int(float(x)) for x in sys.argv[3:7]]\n' +
    'from PIL import ImageDraw\nImageDraw.Draw(d).rectangle([l,t,r,bt], fill=0)\n' +
    'print(d.histogram()[255])\n';
  const pad = 6 * scale;
  try {
    return Number(childProcess.execFileSync('python3', ['-c', py, a, b,
      String(box.left * scale - pad), String(box.top * scale - pad), String(box.right * scale + pad), String(box.bottom * scale + pad)]).toString().trim());
  } catch (e) { return 'not measured (' + e.message.split('\n')[0] + ')'; }
}

async function pair(name, o) {
  if (ONLY && name.indexOf(ONLY) < 0) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (o.before) await o.before();
    const off = await newPage({ init: o.init, off: true });
    const on = await newPage({ init: o.init });
    // Same minute on the clock tile for both shots: not within 15 s of a new minute.
    while (new Date().getSeconds() > 45) await sleep(500);
    await o.signal(on, off);
    await atPhase(on, o.widget, 'work');
    await until(() => off.evaluate((w) => !!document.querySelector('.cell[data-widget="' + w + '"] .fx-chip.is-in'), o.widget), 4000, 'no chip on the off page');
    await sleep(o.wait || 900);
    const minute = new Date().getMinutes();
    await Promise.all([freeze(on, 1200), freeze(off, 1200)]);
    const chipsOn = await on.evaluate(() => document.querySelectorAll('.fx-chip').length);
    const words = await off.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.fx-chip'), (c) => c.textContent).join(', '));
    const box = union(await herBox(on), await herBox(off, true));
    const fileOff = path.join(OUT, name + '-off.png');
    const fileOn = path.join(OUT, name + '-on.png');
    await off.screenshot({ path: fileOff });
    await on.screenshot({ path: fileOn });
    const sameMinute = new Date().getMinutes() === minute;
    await off.context().close();
    await on.context().close();
    if (o.after) await o.after();
    const diff = diffOutside(fileOff, fileOn, box, 2);
    if (!sameMinute && attempt < 2) { console.log('  ' + name + ': the minute changed, again'); continue; }
    console.log('  ' + name + '-{off,on}.png (off: ' + words + '; on: ' + chipsOn + ' chips; her box and the chip ' +
      [box.left, box.top, box.right - box.left, box.bottom - box.top].map(Math.round).join(',') + '; pixels that differ outside them: ' + diff + ')');
    return;
  }
}

async function shots() {
  await pair('todo-working', { widget: 'todo', signal: () => say('hub:working todo'), after: () => say('hub:working todo done') });
  // From no events to the sample's: she works at the first event row (the calendar's data-agent-spot).
  await pair('calendar-arrival', { widget: 'calendar', wait: 300, before: async () => { await calendarMode('empty'); await sleep(4000); },
    signal: () => calendarMode('sample'), after: () => sleep(7000) });
  await pair('todo-working-es', { widget: 'todo', init: ES_INIT, signal: () => say('hub:working todo'), after: () => say('hub:working todo done') });
  // Her at her size on the 1080p screen: a crop at device scale 1.
  if (!ONLY || 'lift-1080p'.indexOf(ONLY) >= 0) {
    const page = await newPage({ scale: 1 });
    await say('hub:working todo');
    await atPhase(page, 'todo', 'work');
    await sleep(1300);
    await freeze(page, 1200);
    const b = await herBox(page);
    await page.screenshot({ path: path.join(OUT, 'lift-1080p.png'), clip: { x: Math.round(b.left - 60), y: Math.round(b.top - 50), width: Math.round(b.right - b.left + 120), height: Math.round(b.bottom - b.top + 90) } });
    console.log('  lift-1080p.png (' + Math.round(b.right - b.left) + 'x' + Math.round(b.bottom - b.top) + ' px)');
    await say('hub:working todo done');
    await page.context().close();
  }
  if (!ONLY || 'lift-phases'.indexOf(ONLY) >= 0) await phases();
}

// The to-do tile through the whole sequence: a working state, then a new
// to-do. One real capture (device scale 1) as each phase is reached (the
// page's animations held for the shot), joined into one labelled strip.
async function phases() {
  const page = await newPage({ scale: 1 });
  const tile = await page.evaluate(() => { const r = document.querySelector('.cell[data-widget="todo"] .tile').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const clipBox = { x: Math.max(0, Math.round(tile.x - 40)), y: Math.max(0, Math.round(tile.y - 40)), width: Math.round(tile.w + 80), height: Math.round(tile.h + 60) };
  clipBox.width = Math.min(clipBox.width, 1920 - clipBox.x);
  clipBox.height = Math.min(clipBox.height, 1080 - clipBox.y);
  const frames = [];
  const shot = async (label) => {
    const file = path.join(OUT, '.phase-' + frames.length + '.png');
    await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.pause(); } catch (e) { /* leave it */ } }));
    await page.screenshot({ path: file, clip: clipBox });
    await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.play(); } catch (e) { /* leave it */ } }));
    frames.push([file, label]);
  };
  const t0 = Date.now();
  const mark = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s';
  await say('hub:working todo 300');
  await atPhase(page, 'todo', 'enter');
  await sleep(380);
  await shot('1 enter (' + mark() + ')');
  await atPhase(page, 'todo', 'travel');
  await sleep(90);
  await shot('2 travel (' + mark() + ')');
  await atPhase(page, 'todo', 'skid');
  await sleep(160);
  await shot('3 skid (' + mark() + ')');
  await atPhase(page, 'todo', 'work');
  await sleep(500);
  await shot('4 work (' + mark() + ')');
  await sleep(2200);
  await shot('5 work, loop (' + mark() + ')');
  await postTodo('Fix the porch light ' + Date.now() % 1000);
  await atPhase(page, 'todo', 'reveal');
  const r0 = Date.now();
  await sleep(200);
  await shot('6 reveal (news +' + ((Date.now() - r0) / 1000 + 0.2).toFixed(1) + ' s)');
  await atPhase(page, 'todo', 'exit');
  await sleep(250);
  await shot('7 exit: wave');
  await sleep(720);
  await shot('8 exit: skate out');
  await page.context().close();
  const py = 'import sys, json\nfrom PIL import Image, ImageDraw, ImageFont\n' +
    'fr=json.loads(sys.argv[2]); ims=[Image.open(f).convert("RGB") for f,_ in fr]\n' +
    'w,h=ims[0].size; cols=4; rows=(len(ims)+cols-1)//cols; lab=34\n' +
    'out=Image.new("RGB",(cols*w+(cols+1)*12,rows*(h+lab)+(rows+1)*12),(20,20,24)); d=ImageDraw.Draw(out)\n' +
    'try:\n  font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",22)\nexcept Exception:\n  font=ImageFont.load_default()\n' +
    'for i,(im,(f,l)) in enumerate(zip(ims,fr)):\n  x=12+(i%cols)*(w+12); y=12+(i//cols)*(h+lab+12)\n  d.text((x+4,y+4),l,fill=(235,235,235),font=font); out.paste(im,(x,y+lab))\n' +
    'out.save(sys.argv[1])\n';
  childProcess.execFileSync('python3', ['-c', py, path.join(OUT, 'lift-phases.png'), JSON.stringify(frames)]);
  for (const f of frames) fs.rmSync(f[0], { force: true });
  console.log('  lift-phases.png (' + frames.length + ' frames: ' + frames.map((f) => f[1]).join('; ') + ')');
}

function hasFfmpeg() {
  try { childProcess.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

async function record(name, run) {
  const tmpDir = path.join(OUT, '.video');
  const ff = hasFfmpeg();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const page = await newPage({ video: tmpDir, scale: 1 });
  const start = (Date.now() - page.bornAt) / 1000;
  await sleep(800);
  await run(page);
  const video = page.video();
  await page.context().close();
  const src = await video.path();
  const dest = path.join(OUT, name + (ff ? '.mp4' : '.webm'));
  if (ff) {
    childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', Math.max(0, start).toFixed(2), '-i', src,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium', '-r', '30', '-movflags', '+faststart', dest]);
  } else {
    fs.copyFileSync(src, dest);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  ' + path.basename(dest));
}

async function clip() {
  // The to-do tile: working for a while, then a new to-do (the reveal), then out.
  await record('lift-sequence', async () => {
    await say('hub:working todo 300');
    await sleep(6000);
    await postTodo('Sweep the porch ' + Date.now() % 1000);
    await sleep(4200);
  });
  // A calendar change alone (no events to the sample's): the short fixed sequence.
  await calendarMode('empty');
  await sleep(4000);
  await record('lift-calendar', async () => {
    await calendarMode('sample');
    await sleep(7500);
  });
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
