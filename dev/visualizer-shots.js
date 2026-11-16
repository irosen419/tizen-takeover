/*
 * Pictures and a short clip of the Now Playing visualizer:
 *   node dev/visualizer-shots.js --out <folder> [--only <text>] [--scale 2] [--clip]
 *
 * Runs the preview's page server, the Pi's real hub server and the Spotify
 * (and ReccoBeats) stand-in from dev/mock-spotify.js, then headless Chromium
 * at 1920x1080. Each shot opens Now Playing full screen on one of the
 * stand-in's songs: calm, moody, upbeat, hard, paused, a song known only by
 * its genres, one with no vibe, the still wash, long Spanish words, and the
 * small (not full screen) page, which has no visualizer. --clip also records
 * an upbeat song pulsing, then a change to a calm one (an .mp4 when ffmpeg
 * is there, else .webm).
 *
 * Needs Playwright and port 8095 free. Nothing reaches the internet.
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

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = path.resolve(arg('--out') || path.join(os.tmpdir(), 'visualizer-shots'));
const ONLY = arg('--only');
const SCALE = parseFloat(arg('--scale')) || 2;
const CLIP = args.indexOf('--clip') >= 0;
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const written = [];

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
    try { if (await fn()) return; } catch (e) { /* again */ }
    await sleep(60);
  }
  throw new Error(text);
}

const ONLY_NP = [{ widget: 'nowplaying', x: 9, y: 2, w: 3, h: 2 }, { widget: 'today', x: 0, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 }];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pagePort = await spare();
  const PAGE = 'http://127.0.0.1:' + pagePort;
  const mock = await mockSpotify.start({});
  const preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(pagePort), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await until(() => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: pagePort, path: '/', timeout: 500 }, (r) => { r.resume(); resolve(true); }).on('error', () => resolve(false));
  }), 10000, 'the preview did not start');
  const piPort = await spare();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-viz-shots-'));
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  const pi = server.start({
    token: TOKEN, port: piPort, host: '127.0.0.1', origins: [PAGE], dataDir: dir, log: false, timezone: 'America/Chicago',
    spotifyEnv: { SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + piPort + '/spotify/callback' },
    spotify: { accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, playMs: 400, idleMs: 400, awayMs: 400 }
  });
  await pi.ready;
  const l = pi.spotify.loginUrl();
  await new Promise((resolve, reject) => http.get(l.url, (res) => { res.resume(); pi.spotify.finishLogin(res.headers.location).then(resolve, reject); }).on('error', reject));
  const browser = await chromium.launch();

  async function open(query, opts) {
    const o = opts || {};
    const context = await browser.newContext(Object.assign({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE }, o.context || {}));
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (BLOCKED.indexOf(u.hostname) >= 0) return route.abort();
      return route.continue();
    });
    await context.addInitScript((lay) => { try { localStorage.setItem('homeHub.layout', JSON.stringify(lay)); } catch (e) { /* */ } }, ONLY_NP);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('page error: ' + e.message));
    await page.goto(PAGE + '/hub.html?live=' + encodeURIComponent('http://127.0.0.1:' + piPort) + '&motion=push&clay=off' + (query || ''));
    await page.waitForSelector('.tile');
    return { page: page, context: context };
  }

  async function full(page, small) {
    await page.evaluate(() => window.HUB_TEST.openPanel('nowplaying'));
    await until(() => page.evaluate(() => window.HUB_TEST.open() === 'nowplaying' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page .np-title')), 5000, 'no page');
    if (small) return;
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy() && !!document.querySelector('.np-page.is-full')), 5000, 'no full screen');
  }

  async function song(n, mode) {
    mock.play(n);
    if (mode) mock.set(mode);
    await pi.spotify.poll();
    await until(() => { const d = pi._debug().spotify.vibe; return !d.busy && !d.queued; }, 8000, 'vibe');
  }

  async function shot(name, n, opts) {
    if (ONLY && name.indexOf(ONLY) < 0) return;
    const o = opts || {};
    mock.set('playing');
    await song(n);
    const s = await open(o.query === undefined ? '&viz=full' : o.query);
    const want = mockSpotify.SONGS[n].name;
    await until(() => s.page.evaluate((t) => { const e = document.querySelector('.np-tile .np-title'); return e && e.textContent === t; }, want), 8000, 'no ' + want);
    await full(s.page, o.small);
    if (o.before) await o.before(s.page);
    await sleep(o.wait || 3200);
    const file = path.join(OUT, name + '.jpg');
    await s.page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    const dbg = await s.page.evaluate(() => (window.HUB_NP_VIZ ? JSON.stringify(window.HUB_NP_VIZ.debug()) : ''));
    written.push(file + '  ' + dbg);
    await s.context.close();
  }

  // 0 upbeat, 1 long Spanish calm, 2 moody, 3 hard, 4 calm acoustic, 5 genres only, 6 nothing
  await shot('viz-01-calm', 4);
  await shot('viz-02-moody', 2);
  await shot('viz-03-upbeat', 0);
  await shot('viz-04-hard', 3);
  await shot('viz-05-paused', 0, { before: async () => { mock.set('paused'); await pi.spotify.poll(); }, wait: 3500 });
  await shot('viz-06-genres-only', 5);
  await shot('viz-07-no-vibe', 6);
  await shot('viz-08-still-wash', 0, { query: '&viz=wash' });
  await shot('viz-09-spanish-long', 1, {
    before: async (page) => {
      // Spanish chips run longer; the title and artist are the stand-in's own.
      await page.evaluate(() => {
        const t = document.querySelector('.np-page .np-title');
        t.textContent = 'Canción de la Mañana: Ñandú Áspero bajo el Ámbar de Júpiter (Versión Acústica Íntima)';
        const chips = document.querySelectorAll('.np-page .np-chip');
        const es = { 'On Living room': 'En Altavoz de la sala de estar', 'Shuffle': 'Orden aleatorio', 'Explicit': 'Explícito' };
        Array.prototype.forEach.call(chips, (c) => { if (es[c.textContent]) c.textContent = es[c.textContent]; });
        const lab = document.querySelector('.np-page .np-label-text');
        if (lab) lab.textContent = 'Reproduciendo ahora';
      });
    }
  });
  await shot('viz-10-small-page', 0, { small: true });

  if (CLIP && (!ONLY || 'clip'.indexOf(ONLY) >= 0)) {
    mock.set('playing');
    await song(0);
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-clip-'));
    const s = await open('&viz=full', { context: { deviceScaleFactor: 1, recordVideo: { dir: vdir, size: { width: 1280, height: 720 } } } });
    await until(() => s.page.evaluate(() => { const e = document.querySelector('.np-tile .np-title'); return e && e.textContent === 'Golden Hour Drive'; }), 8000, 'clip song');
    await full(s.page);
    await sleep(5500);
    await song(4);
    await sleep(6000);
    const video = s.page.video();
    await s.context.close();
    const webm = await video.path();
    const mp4 = path.join(OUT, 'viz-clip-upbeat-to-calm.mp4');
    try {
      // Skip the hub's own start (the first ~1.5 s) and keep 12 s.
      childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.5', '-i', webm, '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4]);
      written.push(mp4);
    } catch (e) {
      const out = path.join(OUT, 'viz-clip-upbeat-to-calm.webm');
      fs.copyFileSync(webm, out);
      written.push(out);
    }
  }

  await browser.close();
  await new Promise((r) => pi.close(r));
  await mock.close();
  preview.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  written.forEach((f) => console.log(f));
}

main().then(() => process.exit(0), (e) => { console.log('failed: ' + (e && e.stack)); process.exit(1); });
