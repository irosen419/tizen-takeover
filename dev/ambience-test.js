/*
 * The Ambience widget end to end: node dev/ambience-test.js
 *
 * Runs the real hub in headless Chromium against the Pi's hub server from
 * pi/ (in this process) and a made-up Home Assistant and plant wall
 * (dev/mock-lights.js) with the room of pi/ambience.example.json. The
 * preview serves the page (needs port 8095 free, like the other browser
 * tests). Nothing here reaches the internet. Checks:
 *
 *   - app/widgets/ambience.js and app/i18n.js are plain ES5; the CSS has no
 *     grid, no flex gap, animates only transform and opacity, and ends with
 *     .css-end { top: 0; }.
 *   - The tile at 1x1, 2x1, 3x1, 6x1, 12x1, 2x2, 3x2, 3x4, 6x2 and 6x4, in
 *     English, Spanish and Spanish with every Ambience text 25% longer:
 *     something to read, nothing outside the tile, no "Ambience couldn't
 *     be shown", and the header's title.
 *   - The panel: the scenes, the room lights and the plant wall; the active
 *     scene is marked; keyboard: Left/Right along the scenes, Down to the
 *     lights and the moods, Up back to the scene focused last.
 *   - Optimistic: OK on a scene shows "Sending..." at once, then the Pi's
 *     push marks it on (and the made-up lamp is at the scene's level). A
 *     light's level: Right shows the new level at once and the lamp follows.
 *   - Rollback: a scene no light answers, a light Home Assistant refuses,
 *     and a Pi that can't be reached all put things back as they were, with
 *     a plain message in the panel's head.
 *   - Partial: the Sengled lamp drops; the scene still applies to the
 *     others and both the panel and the tile say which lamp didn't answer.
 *   - Not set up (no HA_TOKEN): the 6x2 tile says "Set up lights" over its hint, the panel
 *     says how. Error: Home Assistant stops answering, or refuses the
 *     token; the tile keeps the last known lights with a plain note.
 *   - Full screen shows the three sections, all on one screen.
 *   - The TV only talks to the Pi (never Home Assistant or the plant wall);
 *     the screen door takes saved ids only, refuses another site's page and
 *     slows a screen that sends too fast; every log line about lights starts
 *     with "ambience:" and holds no token, address, entity id or name.
 *   - No console errors.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const OCEAN_JPG = fs.readFileSync(path.join(__dirname, '..', 'app', 'backgrounds', 'ocean.jpg'));
const http = require('http');
const net = require('net');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const mockLights = require('./mock-lights');
const ambience = require('../pi/ambience');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
let passed = 0;
let failed = 0;

function assert(ok, text) { if (!ok) throw new Error(text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(80);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + ': ' + (e && e.message));
  }
}
function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getOk(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  });
}
// A request to the hub server. headers: extra ones (Origin); token: false for none.
function request(port, method, route, body, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }, o.headers || {});
    if (o.token !== false) headers.Authorization = 'Bearer ' + TOKEN;
    const req = http.request({ host: '127.0.0.1', port: port, path: route, method: method, headers: headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) { j = out; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/* Spanish 25% longer: every Ambience text grown (with Á, É, ñ, ¿, ¡). */
const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚÁÉñ¿¡áéíóú";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k) || !/^ambience\\./.test(k)) continue;' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.replace(/\\{\\w+\\}/g, "").length * 0.25)); es[k] = s + add.slice(0, n); } })();\n';

const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [3, 4], [6, 2], [6, 4]];

const env = { lines: [] };

async function startPi(o) {
  const port = await spare();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ambience-'));
  if (o.config) ambience.saveConfig(dataDir, o.config);
  const server = require('../pi/server').start({
    token: TOKEN, port: port, host: '127.0.0.1', origins: [env.PAGE], dataDir: dataDir, allowHttp: true,
    calendars: [], log: (s) => env.lines.push(String(s).replace(/^(\S+\s)?\d\d:\d\d:\d\d\S*\s/, '')),
    ambienceEnv: o.env || {}, ambience: { timeoutMs: 700, screenMs: 1500, idleMs: 1500 }
  });
  await Promise.resolve(server.ready);
  await until(() => getOk('http://127.0.0.1:' + port + '/health'), 5000, 'the hub server did not start');
  return { port: port, url: 'http://127.0.0.1:' + port, server: server, dataDir: dataDir };
}

async function open(o) {
  o = o || {};
  const context = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  context.errors = [];
  context.foreign = [];
  await context.route(/.*/, (route) => {
    const u = new URL(route.request().url());
    const port = Number(u.port);
    // The background pictures' host (the R2 bucket): the local ocean picture stands in.
    if (u.hostname === 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev') return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*' }, body: OCEAN_JPG });
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') { context.foreign.push(u.hostname); return route.abort(); }
    if (env.mockPorts.indexOf(port) >= 0) { context.foreign.push('mock lights'); return route.abort(); }
    return route.fallback();
  });
  if (o.grow) await context.route(/\/i18n\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: I18N + GROW }));
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  // Not the whole screen: a one-widget 12x6 layout opens straight to full
  // screen (hub.js openSolo), and these checks start from the tile and panel.
  const layout = o.layout || [{ widget: 'ambience', x: 0, y: 0, w: 6, h: 4 }];
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('am-seeded')) return;
      sessionStorage.setItem('am-seeded', '1');
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, { 'homeHub.layout': JSON.stringify(layout), 'homeHub.layoutChoice': JSON.stringify({ id: 'test', piSig: '' }), 'homeHub.lang': o.lang || 'en' });
  const live = (o.pi || env.pi).url;
  await page.goto(env.PAGE + '/?motion=fade&clay=off&live=' + encodeURIComponent(live) + (o.lang ? '&lang=' + o.lang : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 10000, 'the hub did not go live');
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(400);
  page.ctx = context;
  return page;
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) { await page.keyboard.press(k); await sleep(90); }
}
async function openPanel(page) {
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'ambience'), 5000, 'the panel did not open');
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'busy');
  await sleep(300);
}
function focused(page) {
  return page.evaluate(() => {
    const f = document.querySelector('#panel .is-focused');
    if (!f) return '';
    return f.getAttribute('data-key') || 'hub:' + (f.textContent || '').trim();
  });
}
function sub(page) {
  return page.evaluate(() => {
    const s = document.querySelector('#panel .panel-sub');
    return s ? { text: s.textContent, cls: s.className } : { text: '', cls: '' };
  });
}
function tileText(page) {
  return page.evaluate(() => { const b = document.querySelector('.cell[data-widget="ambience"] .tile'); return b ? b.innerText : ''; });
}
// Holds the page's next scene or mood on its way to the Pi for ms, so what
// shows before the Pi answers can be seen.
async function hold(page, ms) {
  await page.route(/\/ambience\/(scene|mood)$/, async (route) => { await sleep(ms); route.continue().catch(() => {}); });
}
async function settle() {
  await env.pi.server.ambience.poll();
  await sleep(250);
}

/* What a tile shows, and what of it is outside the tile. */
function tileProblems(page) {
  return page.evaluate(() => {
    const tile = document.querySelector('.cell[data-widget="ambience"] .tile');
    if (!tile) return { bad: ['no tile'], text: '' };
    const box = tile.getBoundingClientRect();
    const bad = [];
    const body = tile.querySelector('.tile-body') || tile;
    body.querySelectorAll('*').forEach((n) => {
      if (n.closest('.am-wash')) return;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
        bad.push((n.className && n.className.baseVal === undefined ? n.className : n.tagName) + ' "' + (n.textContent || '').slice(0, 30) + '" outside');
      }
    });
    const title = tile.querySelector('.tile-title');
    return { bad: bad, text: body.innerText.trim(), title: title ? title.textContent : '', glyph: !!body.querySelector('.am-one-glyph') };
  });
}

async function main() {
  env.PAGE_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', LIGHTS_MODE: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  env.mock = await mockLights.start({});
  env.mockPorts = [Number(new URL(env.mock.url).port), Number(new URL(env.mock.wledUrl).port)];
  const example = ambience.validateConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'pi', 'ambience.example.json'), 'utf8')));
  env.example = example;
  env.pi = await startPi({ config: example, env: { HA_URL: env.mock.url, HA_TOKEN: env.mock.token, WLED_URL: env.mock.wledUrl } });
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  await until(async () => (await request(env.pi.port, 'GET', '/api/ambience')).body.ambience.state === 'ok', 5000, 'the hub server did not read the lights');
  env.browser = await chromium.launch();

  await check('app/widgets/ambience.js and app/i18n.js are plain ES5', () => {
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    ['app/widgets/ambience.js', 'app/i18n.js'].forEach((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (acorn) acorn.parse(text, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), f + ': ES2015 syntax');
    });
    if (!acorn) console.log('      (no ES5 parser found here: a simpler check was used)');
    const html = fs.readFileSync(path.join(ROOT, 'app', 'hub.html'), 'utf8');
    assert(html.indexOf('widgets/ambience.js') > 0 && html.indexOf('widgets/ambience.css') > 0, 'hub.html loads the widget and its CSS');
  });

  await check('ambience.css: no grid, no flex gap, only transform and opacity animate, ends with .css-end', () => {
    const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'ambience.css'), 'utf8');
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/display\s*:\s*(inline-)?grid|grid-template/.test(bare), 'CSS grid');
    assert(!/(^|[\s;{])(row-|column-)?gap\s*:/.test(bare), 'flex gap');
    assert(!/display\s*:\s*contents/.test(bare), 'display: contents');
    const frames = bare.match(/@(-webkit-)?keyframes[^{]+\{([^{}]*\{[^}]*\})+\s*\}/g) || [];
    frames.forEach((f) => {
      const props = (f.match(/([a-z-]+)\s*:/g) || []).map((p) => p.replace(/\s*:$/, ''));
      props.forEach((p) => assert(/^(-webkit-)?(transform|opacity)$/.test(p), 'a keyframe animates ' + p));
    });
    (bare.match(/transition(-property)?\s*:[^;}]+/g) || []).forEach((t) => {
      const v = t.replace(/^transition(-property)?\s*:/, '');
      v.split(',').forEach((part) => {
        const prop = part.trim().split(/\s+/)[0];
        assert(/^(-webkit-)?(transform|opacity|none)$/.test(prop), 'a transition on ' + prop);
      });
    });
    assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'the file does not end with .css-end { top: 0; }');
  });

  // Chill night on, everything answering.
  await request(env.pi.port, 'POST', '/api/ambience/scene', { id: 'chill' });
  await settle();

  for (const lang of [{ name: 'English', lang: 'en' }, { name: 'Spanish', lang: 'es' }, { name: 'Spanish +25%', lang: 'es', grow: true }]) {
    await check('the tile at ' + SIZES.map((s) => s[0] + 'x' + s[1]).join(', ') + ' in ' + lang.name + ': readable, nothing outside it', async () => {
      const page = await open({ lang: lang.lang, grow: lang.grow, layout: [{ widget: 'ambience', x: 0, y: 0, w: 1, h: 1 }] });
      const out = [];
      for (const s of SIZES) {
        await page.evaluate((l) => { localStorage.setItem('homeHub.layout', JSON.stringify(l)); }, [{ widget: 'ambience', x: 0, y: 0, w: s[0], h: s[1] }]);
        await page.reload();
        await page.waitForFunction(() => window.HUB_TEST && document.querySelector('.cell[data-widget="ambience"] .tile'), null, { timeout: 15000 });
        await until(() => page.evaluate(() => window.HUB_LIVE.status().state === 'live'), 10000, 'not live');
        await until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="ambience"] .am-k-ready')), 5000, 'the tile did not get the lights');
        await sleep(250);
        const r = await tileProblems(page);
        const where = s[0] + 'x' + s[1];
        if (r.bad.length) out.push(where + ': ' + r.bad.slice(0, 3).join(', '));
        if (s[0] === 1) { if (!r.glyph || !/\d\/\d/.test(r.text)) out.push(where + ': no bulb and count'); }
        else if (r.text.indexOf('Chill night') < 0) out.push(where + ': no scene name ("' + r.text.slice(0, 40) + '")');
        if (/couldn/i.test(r.text)) out.push(where + ': broken');
        if (s[1] >= 2 && s[0] >= 2 && !r.title) out.push(where + ': no title');
      }
      assert(!page.ctx.errors.length, 'console: ' + page.ctx.errors.join(' | '));
      await page.ctx.close();
      assert(!out.length, out.join('; '));
    });
  }

  const page = await open({});
  env.page = page;

  await check('the panel: five scenes, three lights, three plant wall moods; Chill night marked on', async () => {
    await openPanel(page);
    const r = await page.evaluate(() => ({
      cards: [].map.call(document.querySelectorAll('#panel .am-card'), (c) => c.getAttribute('data-scene')),
      rows: document.querySelectorAll('#panel .am-prow').length,
      chips: document.querySelectorAll('#panel .am-chip').length,
      active: [].map.call(document.querySelectorAll('#panel .am-card.is-active'), (c) => c.getAttribute('data-scene')),
      labels: [].map.call(document.querySelectorAll('#panel .am-label'), (c) => c.firstChild.textContent)
    }));
    assert(r.cards.join(',') === 'chill,lights-on,reading,movie,all-off', 'cards ' + r.cards);
    assert(r.rows === 3 && r.chips === 3, r.rows + ' rows, ' + r.chips + ' chips');
    assert(r.active.join() === 'chill', 'active ' + r.active);
    assert(r.labels.join('|') === 'Scenes|Lamp and bars|Room lights|Plant wall', 'labels ' + r.labels);
    assert(await focused(page) === 'scene:chill', 'first focus ' + await focused(page));
  });

  await check('keyboard: Right along the scenes, Down to the lights and moods, Up back to the last scene', async () => {
    await key(page, 'ArrowRight');
    assert(await focused(page) === 'scene:lights-on', 'Right: ' + await focused(page));
    await key(page, 'ArrowRight', 2);
    assert(await focused(page) === 'scene:movie', 'Right x2: ' + await focused(page));
    await key(page, 'ArrowDown');
    assert(await focused(page) === 'look:octane', 'Down to the presets: ' + await focused(page));
    await key(page, 'ArrowDown');
    assert(await focused(page) === 'light:geeni', 'Down: ' + await focused(page));
    assert(/dimmer or brighter/.test((await sub(page)).text), 'the hint for a light: ' + (await sub(page)).text);
    await key(page, 'ArrowDown', 2);
    assert(await focused(page) === 'light:camera', 'Down x2: ' + await focused(page));
    await key(page, 'ArrowDown');
    assert(await focused(page) === 'mood:off', 'Down to the moods: ' + await focused(page));
    await key(page, 'ArrowRight');
    assert(await focused(page) === 'mood:dim', 'Right on the moods: ' + await focused(page));
    await key(page, 'ArrowUp');
    assert(await focused(page) === 'light:camera', 'Up: ' + await focused(page));
    await key(page, 'ArrowUp', 3);
    assert(await focused(page) === 'look:octane', 'Up to the presets (the first, none on): ' + await focused(page));
    await key(page, 'ArrowUp');
    assert(await focused(page) === 'scene:movie', 'Up to the scene focused last: ' + await focused(page));
    await key(page, 'ArrowLeft', 2);
    assert(await focused(page) === 'scene:lights-on', 'Left x2: ' + await focused(page));
  });

  await check('lamp and bars presets: a picture of each, OK sets one ("Sending..." then On now), Up goes back to the scene', async () => {
    const cards = await page.evaluate(() => [].map.call(document.querySelectorAll('#panel .am-look'), (c) => ({
      id: c.getAttribute('data-look'), name: c.querySelector('.am-look-name').textContent,
      lamp: c.querySelector('.am-look-lamp').style.background, bars: c.querySelectorAll('.am-look-bar').length
    })));
    assert(cards.map((c) => c.id).join(',') === 'octane,rainforest,thunderstorm,warm-drift', 'presets ' + cards.map((c) => c.id));
    assert(cards.every((c) => /gradient/.test(c.lamp) && c.bars === 2), 'pictures ' + JSON.stringify(cards[0]));
    await key(page, 'ArrowDown');
    await key(page, 'ArrowRight');
    assert(await focused(page) === 'look:rainforest', 'Right: ' + await focused(page));
    assert(/lamp and bars together/.test((await sub(page)).text), 'the hint: ' + (await sub(page)).text);
    await page.keyboard.press('Enter');
    await sleep(60);
    const at = await page.evaluate(() => document.querySelector('#panel .am-look[data-look="rainforest"]').textContent);
    assert(/Sending|On now/.test(at), 'right after OK: ' + at);
    await until(() => page.evaluate(() => /is-active/.test(document.querySelector('#panel .am-look[data-look="rainforest"]').className)), 4000, 'Rainforest not marked on');
    assert((await request(env.pi.port, 'GET', '/api/lights')).body.settings.look === 'rainforest', 'the Pi has it');
    assert(/Rainforest on the lamp and bars/.test((await sub(page)).text), 'the head says ' + (await sub(page)).text);
    await key(page, 'ArrowUp');
    assert(await focused(page) === 'scene:lights-on', 'Up: ' + await focused(page));
  });

  await check('a scene: "Sending..." at once, then marked on by the Pi\'s push; the lamp is at the scene\'s level', async () => {
    await key(page, 'ArrowRight');
    assert(await focused(page) === 'scene:reading', 'on Reading');
    await hold(page, 500);
    await page.keyboard.press('Enter');
    await sleep(120);
    const at = await page.evaluate(() => {
      const c = document.querySelector('#panel .am-card[data-scene="reading"]');
      return { cls: c.className, state: c.querySelector('.am-card-state').textContent };
    });
    assert(/is-pending/.test(at.cls) && /Sending/.test(at.state), 'right after OK: ' + JSON.stringify(at));
    await until(() => page.evaluate(() => {
      const c = document.querySelector('#panel .am-card[data-scene="reading"]');
      return c && /is-active/.test(c.className) && !/is-pending/.test(c.className);
    }), 5000, 'Reading did not become the active scene').catch(async (e) => {
      throw new Error(e.message + ' ' + JSON.stringify(await sub(page)) + ' ' + JSON.stringify(await page.evaluate(() => window.HUB_AMBIENCE_DEBUG())) + ' ' + JSON.stringify(env.mock.calls.map((c) => c.method + ' ' + c.path)) + ' ' + env.lines.slice(-6).join(' / '));
    });
    const s = env.mock.state('light.example_geeni_1');
    assert(s.state === 'on' && Math.round(s.attributes.brightness * 100 / 255) === 85 && s.attributes.color_temp_kelvin === 3500, 'the Geeni lamp: ' + JSON.stringify(s));
    assert(/Reading is on/.test((await sub(page)).text), 'the head says ' + (await sub(page)).text);
    assert(await focused(page) === 'scene:reading', 'focus stayed on Reading');
  });

  await check('a light: Right shows the new level at once, the lamp follows, focus stays', async () => {
    await key(page, 'ArrowDown', 2);
    assert(await focused(page) === 'light:geeni', 'on the Geeni lamp');
    await page.keyboard.press('ArrowRight');
    await sleep(40);
    const now = await page.evaluate(() => document.querySelector('#panel .am-prow[data-light="geeni"] .am-lrow-state').textContent);
    assert(now === '90%', 'right away (85% to the next step): ' + now);
    await until(() => Math.round(env.mock.state('light.example_geeni_1').attributes.brightness * 100 / 255) === 90, 4000, 'the lamp did not go to 90%');
    await settle();
    assert(await focused(page) === 'light:geeni', 'focus moved: ' + await focused(page));
    assert(await page.evaluate(() => document.querySelector('#panel .am-prow[data-light="geeni"] .am-lrow-state').textContent) === '90%', 'after the push');
  });

  await check('rollback: Home Assistant refuses a light; the level goes back and the head says so', async () => {
    env.mock.light('light.example_geeni_1', 'refuse');
    await page.keyboard.press('ArrowLeft');
    await sleep(40);
    assert(await page.evaluate(() => document.querySelector('#panel .am-prow[data-light="geeni"] .am-lrow-state').textContent) === '80%', 'not shown at once');
    await until(async () => /refused/.test((await sub(page)).text), 4000, 'no message');
    const s = await sub(page);
    assert(/am-sub-bad/.test(s.cls), 'not marked as a problem: ' + s.cls);
    await until(() => page.evaluate(() => document.querySelector('#panel .am-prow[data-light="geeni"] .am-lrow-state').textContent === '90%'), 3000, 'the level did not go back');
    env.mock.light('light.example_geeni_1', 'ok');
  });

  await check('rollback: no light answers a scene; Reading stays the active one, "Nothing changed"', async () => {
    await key(page, 'ArrowUp', 2);
    assert(await focused(page) === 'scene:reading', 'back on Reading: ' + await focused(page));
    await key(page, 'ArrowRight');
    assert(await focused(page) === 'scene:movie', 'on Movie');
    env.mock.mode('down');
    await page.keyboard.press('Enter');
    await sleep(120);
    assert(await page.evaluate(() => /is-active/.test(document.querySelector('#panel .am-card[data-scene="movie"]').className)), 'Movie is not shown on at once');
    await until(async () => /Nothing changed/.test((await sub(page)).text), 6000, 'no message');
    assert(/am-sub-bad/.test((await sub(page)).cls), 'not marked as a problem');
    const active = await page.evaluate(() => [].map.call(document.querySelectorAll('#panel .am-card.is-active'), (c) => c.getAttribute('data-scene')).join());
    assert(active === 'reading', 'active after the rollback: ' + active);
    env.mock.mode('ok');
    await settle();
    await settle();
  });

  await check('rollback: the Pi can\'t be reached; nothing changes and the head says so', async () => {
    await page.unroute(/\/ambience\/(scene|mood)$/);
    await page.route(/\/ambience\/scene$/, (route) => route.abort());
    await page.keyboard.press('Enter');
    await until(async () => /Couldn.t reach the Pi/.test((await sub(page)).text), 5000, 'no message');
    const active = await page.evaluate(() => [].map.call(document.querySelectorAll('#panel .am-card.is-active'), (c) => c.getAttribute('data-scene')).join());
    assert(active === 'reading', 'active: ' + active);
    await page.unroute(/\/ambience\/scene$/);
  });

  await check('partial: the Sengled lamp drops; Chill night still applies to the Geeni lamp, the panel and the tile name the lamp', async () => {
    env.mock.light('light.example_sengled_1', 'unavailable');
    await key(page, 'ArrowLeft', 3);
    assert(await focused(page) === 'scene:chill', 'on Chill night: ' + await focused(page));
    await page.keyboard.press('Enter');
    await until(async () => /Sengled lamp didn.t answer/.test((await sub(page)).text), 6000, 'no partial message');
    assert(/am-sub-warn/.test((await sub(page)).cls), 'not a warning');
    const g = env.mock.state('light.example_geeni_1');
    assert(Math.round(g.attributes.brightness * 100 / 255) === 20 && g.attributes.color_temp_kelvin === 2200, 'the Geeni lamp: ' + JSON.stringify(g.attributes));
    await until(() => page.evaluate(() => /is-active/.test(document.querySelector('#panel .am-card[data-scene="chill"]').className)), 3000, 'Chill night not on');
    const row = await page.evaluate(() => document.querySelector('#panel .am-prow[data-light="sengled"]').className + ' ' + document.querySelector('#panel .am-prow[data-light="sengled"] .am-lrow-state').textContent);
    assert(/is-gone/.test(row) && /Not answering/.test(row), 'the Sengled row: ' + row);
    await key(page, 'Escape');
    await until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, 'the panel did not close');
    await sleep(400);
    assert(/Sengled lamp didn.t answer/.test(await tileText(page)), 'the tile: ' + await tileText(page));
    env.mock.light('light.example_sengled_1', 'ok');
    await settle();
  });

  await check('error: Home Assistant stops answering; the tile keeps the last known lights with a plain note', async () => {
    env.mock.mode('down');
    await settle();
    await settle();
    await until(async () => /Home Assistant isn.t answering/.test(await tileText(page)), 4000, 'no note');
    const t = await page.evaluate(() => {
      const tile = document.querySelector('.cell[data-widget="ambience"] .tile');
      return { stale: !!tile.querySelector('.am-tile.is-stale'), text: tile.innerText };
    });
    assert(t.stale && /Chill night/.test(t.text) && /Geeni lamp/.test(t.text), 'the tile: ' + JSON.stringify(t));
    env.mock.mode('unauthorized');
    await settle();
    await until(async () => /refused the token/.test(await tileText(page)), 4000, 'no note for a refused token');
    env.mock.mode('ok');
    await settle();
    await until(async () => !/Home Assistant/.test(await tileText(page)), 4000, 'the note stayed');
  });

  await check('full screen: the three sections, bigger', async () => {
    await openPanel(page);
    for (let i = 0; i < 6; i++) {
      const on = await page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !!f && !document.querySelector('#panel .panel-body').contains(f); });
      if (on) break;
      await key(page, 'ArrowUp');
    }
    await key(page, 'Enter');
    await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'full screen did not open');
    await sleep(500);
    const r = await page.evaluate(() => ({
      full: !!document.querySelector('#panel .am-page.is-full'),
      secs: document.querySelectorAll('#panel .am-sec').length,
      card: document.querySelector('#panel .am-card').getBoundingClientRect().width,
      chips: document.querySelector('#panel .am-chips').getBoundingClientRect().bottom <= window.innerHeight
    }));
    assert(r.full && r.secs === 4 && r.card > 180 && r.chips, 'everything on one screen: ' + JSON.stringify(r));
    await key(page, 'ArrowDown');
    assert(/^scene:/.test(await focused(page)), 'Down from the button: ' + await focused(page));
    await key(page, 'Escape');
    await key(page, 'Escape');
  });

  await check('not set up (no HA_TOKEN): the tile says "Set up lights", the panel says how', async () => {
    const bare = await startPi({ env: {} });
    const p = await open({ pi: bare, layout: [{ widget: 'ambience', x: 0, y: 0, w: 6, h: 2 }] });
    const t = await tileText(p);
    assert(/Set up lights/.test(t) && /Home Assistant isn.t connected yet/.test(t), 'the tile: ' + t);
    const stacked = await p.evaluate(() => {
      const m = document.querySelector('.am-msg').getBoundingClientRect();
      const h = document.querySelector('.am-hint').getBoundingClientRect();
      return h.top >= m.bottom - 1;
    });
    assert(stacked, 'the message and its hint share a line at 6x2');
    await openPanel(p);
    const how = await p.evaluate(() => (document.querySelector('#panel .am-empty') || {}).innerText || '');
    assert(/HA_TOKEN/.test(how) && /pi\/README\.md/.test(how), 'the panel: ' + how);
    assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
    await p.ctx.close();
    await bare.server.close();
  });

  await check('the TV never talks to Home Assistant or the plant wall, and there were no console errors', async () => {
    assert(!page.ctx.foreign.length, 'the page asked ' + page.ctx.foreign.join(', '));
    // The one test that cuts the line to the Pi leaves "Failed to load resource" behind.
    const errs = page.ctx.errors.filter((e) => !/net::ERR_FAILED/.test(e));
    assert(!errs.length, 'console: ' + errs.join(' | '));
    const html = await page.content();
    assert(html.indexOf(env.mock.token) < 0 && html.indexOf(env.mock.url) < 0 && html.indexOf('light.example') < 0, 'a secret or an entity id on the page');
  });

  await check('the screen door: saved ids only, no other site, slows a screen that sends too fast', async () => {
    const pi = env.pi.port;
    const o = { token: false, headers: { Origin: env.PAGE } };
    let r = await request(pi, 'POST', '/ambience/scene', { id: 'light.example_geeni_1' }, o);
    assert(r.status === 400, 'an entity id: ' + r.status);
    r = await request(pi, 'POST', '/ambience/light', { id: 'geeni', pct: 'lots' }, o);
    assert(r.status === 400, 'a bad level: ' + r.status);
    r = await request(pi, 'POST', '/ambience/scene', { id: 'chill' }, { token: false, headers: { Origin: 'http://example.com' } });
    assert(r.status === 403, 'another site: ' + r.status);
    await sleep(1300);
    const before = env.lines.length;
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await request(pi, 'POST', '/ambience/mood', { id: 'dim' }, o)).status);
    assert(codes.indexOf(429) > 0 && codes[0] === 200, 'codes ' + codes.join(','));
    const slow = env.lines.slice(before).filter((l) => /slow down/.test(l));
    assert(slow.length <= 1, slow.length + ' "slow down" lines');
    const body = JSON.stringify((await request(pi, 'GET', '/api/ambience')).body);
    assert(body.indexOf(env.mock.token) < 0 && body.indexOf(env.mock.url) < 0 && body.indexOf(env.mock.wledUrl) < 0, 'GET /api/ambience shows a secret or an address');
  });

  await check('log lines: about the lights they start with "ambience:", with no token, address, entity id or name', async () => {
    const names = ['Geeni', 'Sengled', 'Camera plug', 'Chill', 'Reading', 'Movie', 'Lights on', 'All off', 'Dim', 'Bright'];
    const am = env.lines.filter((l) => /^ambience|Home Assistant|plant wall|\bscenes?\b|\bmoods?\b|\blights?\b/i.test(l) && !/^control |^screen /.test(l));
    assert(am.length >= 5, 'only ' + am.length + ' lines');
    const bad = [];
    env.lines.forEach((l) => {
      if (am.indexOf(l) >= 0 && !/^(ambience|music lights): /.test(l)) bad.push('no prefix: ' + l);
      if (l.indexOf(env.mock.token) >= 0 || /light\.example|switch\.example/.test(l)) bad.push('a secret or an entity id: ' + l);
      if ((am.indexOf(l) >= 0 || /^control .*ambience/.test(l)) && /127\.0\.0\.1|localhost|:\d{4,5}\b/.test(l)) bad.push('an address: ' + l);
      if (/^(ambience|music lights): /.test(l) && names.some((n) => l.indexOf(n) >= 0)) bad.push('a name: ' + l);
    });
    assert(!bad.length, bad.slice(0, 4).join(' | '));
  });
}

main().catch((e) => {
  failed++;
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (env.browser) await env.browser.close(); } catch (e) { /* ignore */ }
  try { if (env.pi) await env.pi.server.close(); } catch (e) { /* ignore */ }
  try { if (env.mock) await env.mock.close(); } catch (e) { /* ignore */ }
  try { if (env.preview) env.preview.kill(); } catch (e) { /* ignore */ }
  try { if (env.pi) fs.rmSync(env.pi.dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
