/*
 * Pictures and a short clip of the Now Playing visualizer:
 *   node dev/visualizer-shots.js --out <folder> [--only <text>] [--scale 2] [--clip | --compare]
 *
 * Runs the preview's page server, the Pi's real hub server and the Spotify
 * (and ReccoBeats) stand-in from dev/mock-spotify.js, then headless Chromium
 * at 1920x1080. Each shot opens Now Playing full screen on one of the
 * stand-in's songs and lets it run a few seconds: each of the six scenes
 * (held by a test hook), a calm and a hard song as they play, paused, a song
 * known only by its genres, one with no vibe, the card with long Spanish
 * words, the sharp, sharp-lite, classic, lite, glow and still wash levels, the visualizer off, and the
 * small (not full screen) page, which has no visualizer. --clip also records
 * an upbeat song through two scene changes, then a change to a calm one (an
 * .mp4 when ffmpeg is there, else .webm). --compare instead shoots four
 * scenes at the same moment of the same song at classic, sharp-lite, sharp
 * and radiant (<scene>-<level>.jpg) and puts classic and sharp side by side
 * (compare-classic-vs-sharp.jpg).
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
const COMPARE = args.indexOf('--compare') >= 0;
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
    if (COMPARE || (ONLY && name.indexOf(ONLY) < 0)) return;
    const o = opts || {};
    mock.set('playing');
    await song(n);
    const s = await open(o.query === undefined ? '&viz=radiant' : o.query);
    if (o.scene) await s.page.evaluate((n) => window.HUB_NP_VIZ.test.scene(n), o.scene);
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

  // --compare: one scene of one song at the same moment (the visualizer's
  // own clock passing AT ms into the song) at each canvas level, then
  // classic and sharp side by side.
  const AT = 37000;
  async function levelShot(scene, n, level) {
    mock.set('playing');
    await song(n);
    const s = await open('&viz=' + level);
    await s.page.evaluate((x) => window.HUB_NP_VIZ.test.scene(x), scene);
    const want = mockSpotify.SONGS[n].name;
    await until(() => s.page.evaluate((t) => { const e = document.querySelector('.np-tile .np-title'); return e && e.textContent === t; }, want), 8000, 'no ' + want);
    await full(s.page);
    // Waits in the page, frame by frame, so the shot follows at once.
    await s.page.evaluate((at) => new Promise((resolve) => {
      (function look() { if (window.HUB_NP_VIZ.debug().position >= at) resolve(); else requestAnimationFrame(look); })();
    }), AT);
    const file = path.join(OUT, scene + '-' + level + '.jpg');
    await s.page.screenshot({ path: file, type: 'jpeg', quality: 90 });
    const dbg = await s.page.evaluate(() => JSON.stringify(window.HUB_NP_VIZ.debug()));
    written.push(file + '  ' + dbg);
    await s.context.close();
    return file;
  }
  if (COMPARE) {
    const LEVELS = ['classic', 'sharplite', 'sharp', 'native', 'radiant'];
    const files = {};
    for (const [scene, n] of [['tunnel', 3], ['kaleidoscope', 0], ['spirograph', 4], ['ribbons', 2]]) {
      if (ONLY && scene.indexOf(ONLY) < 0) continue;
      files[scene] = {};
      for (const level of LEVELS) files[scene][level] = await levelShot(scene, n, level);
    }
    // Spirograph's soft curves show the difference best; else the first scene shot.
    const first = files.spirograph ? 'spirograph' : Object.keys(files)[0];
    if (first) {
      // Classic | sharp: the middle half of each, full height, at the TV's
      // own 1920 x 1080 pixels, so the same shapes sit side by side.
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const b64 = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
      await page.setContent('<body style="margin:0;background:#000;display:flex;font:600 28px sans-serif;color:#fff">' +
        ['classic', 'sharp'].map((l) => '<div style="position:relative;width:960px;height:1080px;overflow:hidden">' +
          '<img src="' + b64(files[first][l]) + '" style="position:absolute;left:-480px;top:0;width:1920px;height:1080px">' +
          '<div style="position:absolute;right:16px;bottom:12px;background:rgba(0,0,0,.6);padding:4px 12px">' + l + '</div></div>').join('') +
        '</body>');
      await page.waitForFunction(() => Array.prototype.every.call(document.images, (i) => i.complete));
      const out = path.join(OUT, 'compare-classic-vs-sharp.jpg');
      await page.screenshot({ path: out, type: 'jpeg', quality: 92 });
      written.push(out);
      await ctx.close();
    }
  }

  // 0 upbeat, 1 long Spanish calm, 2 moody, 3 hard, 4 calm acoustic, 5 genres only, 6 nothing
  const SCENE_SONG = { spirograph: 4, tunnel: 3, kaleidoscope: 0, ribbons: 2, starburst: 0, lattice: 5 };
  for (const name of COMPARE ? [] : Object.keys(SCENE_SONG)) {
    await shot('viz-scene-' + name, SCENE_SONG[name], { scene: name, wait: 6000 });
  }
  await shot('viz-calm-song', 4, { wait: 6000 });
  await shot('viz-hard-song', 3, { wait: 6000 });
  await shot('viz-paused', 0, { before: async () => { mock.set('paused'); await pi.spotify.poll(); }, wait: 4000 });
  await shot('viz-genres-only', 5);
  await shot('viz-no-vibe', 6);
  await shot('viz-spanish-card', 1, {
    wait: 5000,
    before: async (page) => {
      // A longer Spanish title in the card; the artist and album are the stand-in's own.
      await page.evaluate(() => {
        const t = document.querySelector('.np-page .np-title');
        t.textContent = 'Canción de la Mañana: Ñandú Áspero bajo el Ámbar de Júpiter (Versión Acústica Íntima)';
        const lab = document.querySelector('.np-page .np-label-text');
        if (lab) lab.textContent = 'Reproduciendo ahora';
      });
    }
  });
  await shot('viz-level-sharp', 0, { query: '&viz=sharp', wait: 6000 });
  await shot('viz-level-sharplite', 0, { query: '&viz=sharplite', wait: 6000 });
  await shot('viz-level-classic', 0, { query: '&viz=classic', wait: 6000 });
  await shot('viz-level-lite', 0, { query: '&viz=lite', wait: 6000 });
  await shot('viz-level-glow', 0, { query: '&viz=glow' });
  await shot('viz-level-wash', 0, { query: '&viz=wash' });
  await shot('viz-off', 0, { query: '&viz=off' });
  await shot('viz-small-page', 0, { small: true });

  if (CLIP && (!ONLY || 'clip'.indexOf(ONLY) >= 0)) {
    mock.set('playing');
    await song(0);
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-clip-'));
    const s = await open('&viz=radiant', { context: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: { width: 1280, height: 720 } } } });
    // Phrases of 8 beats (a test hook) instead of 32, so the clip shows
    // two scene changes before the song changes.
    await s.page.evaluate(() => window.HUB_NP_VIZ.test.phraseBeats(8));
    await until(() => s.page.evaluate(() => { const e = document.querySelector('.np-tile .np-title'); return e && e.textContent === 'Golden Hour Drive'; }), 8000, 'clip song');
    await full(s.page);
    await sleep(10500);
    await song(4);
    await sleep(6500);
    const video = s.page.video();
    await s.context.close();
    const webm = await video.path();
    const mp4 = path.join(OUT, 'viz-clip-upbeat-to-calm.mp4');
    try {
      // Skip the hub's own start (the first ~2 s) and keep 15 s.
      childProcess.execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2', '-i', webm, '-t', '15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4]);
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
