/*
 * Before and after stills of the arrival sweep on a focused tile:
 *   node dev/shimmer-shots.js --out <folder> [--before <git ref>]
 *
 * BEFORE comes from <git ref> (68c339a, the parent of the fix, unless told), checked out in a
 * scratch git worktree in a temp folder; AFTER from this checkout. Each side
 * gets its own preview (dev/preview.js from that tree, on a spare page port,
 * service port 8095, its own hub server off) and a fresh hub server from
 * pi/ with the same data (the sample calendars, the same A World Worth
 * Saving snapshot, the same to-dos), Spotify paused on the same song, and
 * the browser's clock started at the same moment (today, 9:41 in Chicago).
 * Everything else is the same too: 1920x1080, English, wanderers off, the
 * To-do tile focused, and the same arrival (a new to-do from a sync). As
 * soon as the edge sweep is there, every animation on the page is paused at
 * the same currentTime (500 ms, the light about halfway along the first
 * pass), so both frames show the same moment.
 *
 * Writes shimmer-crop-before.png and -after.png (the To-do tile's top at
 * device scale 2), shimmer-full-before.png and -after.png (1920x1080), and
 * shimmer-crop-side-by-side.png and shimmer-full-side-by-side.png, labelled
 * "Before" and "After" (with Python's PIL, else ImageMagick).
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const mockSpotify = require('./mock-spotify');
const calendarSample = require('./calendar-sample');
const awwsSample = require('./awws-sample');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host')];
const AT_MS = 500;                       // the moment shown, into the sweep
const TODOS = ['Order more activity sheets', 'Call Cedar Hollow back', 'Write to the library about the visit'];
const ARRIVAL = 'Send the Maple Grove photos';

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || 'shimmer-shots');
const BEFORE_REF = arg('--before') || '68c339a';

// The snapshot's time, the same for both sides (a whole minute, in the past).
const SENT_AT = new Date(Math.floor((Math.min(Date.now(), startTimeAt()) - 120000) / 60000) * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
function startTimeAt() { return startTime().getTime(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, t) { if (!c) throw new Error(t); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { /* again */ } await sleep(50); }
  throw new Error(text);
}

function up(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 600 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false)).on('timeout', () => resolve(false));
  });
}

function control(pi, method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: pi.port, path: route, method: method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('not JSON: ' + out.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

// Today in Chicago at 9:41 (the hub server's timezone), as an instant.
function startTime() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (const off of ['-06:00', '-05:00']) {
    const d = new Date(day + 'T09:41:00' + off);
    const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d);
    if (Number(h) === 9) return d;
  }
  return new Date(day + 'T09:41:00-06:00');
}

// One side: a preview from tree, a fresh hub server, one page, the stills.
async function side(name, tree, browser, mock, feeds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shimmer-'));
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const port = await spare();
  const pagePort = await spare();
  const PAGE = 'http://127.0.0.1:' + pagePort;
  let preview = null;
  let h = null;
  try {
    h = server.start({
      token: TOKEN, port: port, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
      calendars: feeds.calendars, allowHttp: true,
      spotifyEnv: { SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + port + '/spotify/callback' },
      spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 }
    });
    await h.ready;
    const pi = { port: port, url: 'http://127.0.0.1:' + port };
    const l = h.spotify.loginUrl();
    await new Promise((resolve, reject) => {
      http.get(l.url, (res) => { res.resume(); h.spotify.finishLogin(res.headers.location || '').then(resolve, reject); }).on('error', reject);
    });
    const snap = awwsSample.snapshot({ today: awwsSample.chicagoToday(), reach: 'both' });
    snap.sentAt = SENT_AT;
    delete snap.receivedAt;
    assert((await control(pi, 'POST', '/api/awws', { snapshot: snap })).ok, 'snapshot refused');
    for (const t of TODOS) assert((await control(pi, 'POST', '/api/todo', { title: t, section: 'now' })).ok, 'to-do refused');

    preview = childProcess.spawn(process.execPath, [path.join(tree, 'dev', 'preview.js')], {
      env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(pagePort), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
      stdio: 'ignore'
    });
    await until(() => up(PAGE + '/'), 10000, name + ': the preview did not start');

    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      timezoneId: 'America/Chicago', locale: 'en-US' });
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      return BLOCKED.indexOf(u.hostname) >= 0 ? route.abort() : route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('  ' + name + ' page error: ' + e.message));
    await page.clock.install({ time: startTime() });
    await page.clock.resume();
    await page.goto(PAGE + '/hub.html?clay=off&live=' + encodeURIComponent(pi.url) + '&motion=push');
    await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
    await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 8000, name + ': not live');
    await until(() => page.evaluate(() => document.body.classList.contains('is-glass')), 6000, name + ': no glass');
    await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, name + ': busy');
    await sleep(1500);
    await focusOn(page, 'todo');
    await sleep(600);

    assert((await control(pi, 'POST', '/api/todo', { title: ARRIVAL, section: 'now' })).ok, 'the arrival was refused');
    await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="todo"] .tile .fx-edge')), 5000, name + ': no sweep');
    const info = await page.evaluate((at) => {
      const list = document.getAnimations();
      list.forEach((a) => { a.pause(); a.currentTime = at; });
      const sweep = list.filter((a) => a.animationName === 'fx-act-sweep')[0];
      const ring = document.querySelector('.fx-ring');
      return { n: list.length, sweep: sweep ? sweep.currentTime : null,
        ring: ring ? ring.className : 'none', tile: document.querySelector('.cell[data-widget="todo"] .tile').className };
    }, AT_MS);
    assert(info.sweep === AT_MS, name + ': the sweep is not at ' + AT_MS + ' ms: ' + JSON.stringify(info));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(200);
    const r = await page.evaluate(() => {
      const b = document.querySelector('.cell[data-widget="todo"] .tile').getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width };
    });
    await page.screenshot({ path: path.join(OUT, 'shimmer-full-' + name + '.png'), scale: 'css' });
    await page.screenshot({ path: path.join(OUT, 'shimmer-crop-' + name + '.png'),
      clip: { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 16), width: r.w + 32, height: 110 } });
    console.log('  ' + name + ': ' + info.n + ' animations paused at ' + AT_MS + ' ms; ring "' + info.ring + '"; tile "' + info.tile + '"');
    await context.close();
  } finally {
    if (preview) preview.kill();
    if (h) await new Promise((r) => h.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
    await sleep(400);
  }
}

// The arrow keys, always toward the tile, until it has focus.
async function focusOn(page, widget) {
  for (let n = 0; n < 12; n++) {
    const d = await page.evaluate((w) => {
      const f = document.querySelector('#grid .tile.is-focused');
      const t = document.querySelector('.cell[data-widget="' + w + '"] .tile');
      if (f === t) return '';
      const a = f.getBoundingClientRect();
      const b = t.getBoundingClientRect();
      if (b.top >= a.bottom - 1) return 'ArrowDown';
      if (b.bottom <= a.top + 1) return 'ArrowUp';
      return b.left > a.left ? 'ArrowRight' : 'ArrowLeft';
    }, widget);
    if (d === '') return;
    await page.keyboard.press(d);
    await sleep(250);
  }
  throw new Error('could not focus ' + widget);
}

function compose() {
  const py = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'out = sys.argv[1]',
    'def font(px):',
    '    for f in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]:',
    '        try: return ImageFont.truetype(f, px)',
    '        except Exception: pass',
    '    return ImageFont.load_default()',
    'for kind, px, gap in (("crop", 44, 32), ("full", 40, 24)):',
    '    a = Image.open(out + "/shimmer-" + kind + "-before.png").convert("RGB")',
    '    b = Image.open(out + "/shimmer-" + kind + "-after.png").convert("RGB")',
    '    head = px + 36',
    '    W = a.width + b.width + gap * 3',
    '    H = max(a.height, b.height) + head + gap',
    '    img = Image.new("RGB", (W, H), (24, 26, 30))',
    '    d = ImageDraw.Draw(img)',
    '    f = font(px)',
    '    img.paste(a, (gap, head))',
    '    img.paste(b, (gap * 2 + a.width, head))',
    '    d.text((gap, 14), "Before", fill=(235, 235, 235), font=f)',
    '    d.text((gap * 2 + a.width, 14), "After", fill=(235, 235, 235), font=f)',
    '    img.save(out + "/shimmer-" + kind + "-side-by-side.png")'
  ].join('\n');
  try {
    childProcess.execFileSync('python3', ['-I', '-c', py, OUT], { stdio: 'inherit' });
    return;
  } catch (e) {
    console.log('  PIL failed (' + e.message + '), trying ImageMagick');
  }
  for (const kind of ['crop', 'full']) {
    childProcess.execFileSync('montage', ['-label', 'Before', path.join(OUT, 'shimmer-' + kind + '-before.png'),
      '-label', 'After', path.join(OUT, 'shimmer-' + kind + '-after.png'),
      '-tile', '2x1', '-geometry', '+24+24', '-pointsize', '40', '-background', '#181a1e', '-fill', '#ebebeb',
      path.join(OUT, 'shimmer-' + kind + '-side-by-side.png')]);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  assert(!(await up('http://127.0.0.1:8095/')), 'port 8095 is busy: stop the preview or a test first');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shimmer-before-'));
  childProcess.execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', wt, BEFORE_REF], { stdio: 'ignore' });
  let browser = null;
  let mock = null;
  let feeds = null;
  try {
    mock = await mockSpotify.start({ mode: 'paused' });
    feeds = await calendarSample.feedServer({ mode: 'sample' });
    browser = await chromium.launch();
    console.log('Stills (before: ' + BEFORE_REF + ', after: this checkout):');
    await side('before', wt, browser, mock, feeds);
    await side('after', ROOT, browser, mock, feeds);
    compose();
    console.log('  written to ' + OUT);
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { if (mock) await mock.close(); } catch (e) { /* ignore */ }
    try { if (feeds) await feeds.close(); } catch (e) { /* ignore */ }
    try { childProcess.execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error(e && e.stack); process.exitCode = 1; });
