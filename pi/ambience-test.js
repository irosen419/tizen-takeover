/*
 * Tests for Ambience (pi/ambience.js): the room's lights through Home
 * Assistant, and the plant wall's WLED. Run from the repo root with:
 *
 *   node pi/ambience-test.js
 *
 * It uses the pretend Home Assistant and WLED in dev/mock-lights.js and the
 * real hub server with throwaway data folders. Nothing reaches the
 * internet, Home Assistant or a real light. Uses only what ships with Node.
 * Prints one line per check, then "N passed, M failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const hubServer = require('./server');
const ambience = require('./ambience');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const logscrub = require('./logscrub');
const mockLights = require('../dev/mock-lights');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const ORIGIN = 'http://127.0.0.1:8081';
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'ambience.example.json'), 'utf8'));
let passed = 0;
let failed = 0;
const tmpDirs = [];
const hubs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ambience-'));
  tmpDirs.push(d);
  return d;
}

async function check(name, fn) {
  if (process.env.AM_GREP && name.indexOf(process.env.AM_GREP) < 0) return;
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const copy = (o) => JSON.parse(JSON.stringify(o));

function request(port, method, p, o) {
  const opt = o || {};
  return new Promise((resolve, reject) => {
    const text = opt.body === undefined ? '' : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body));
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
    if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
    if (opt.origin) headers.Origin = opt.origin;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(t); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, text: t, json: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

// A hub server with Ambience. env: the .env lines; manual: no timers.
async function startHub(m, env, extra) {
  const logs = [];
  const dir = (extra && extra.dataDir) || tmpDir();
  const h = hubServer.start(Object.assign({
    token: TOKEN, port: 0, host: '127.0.0.1', dataDir: dir, origins: [ORIGIN],
    log: (s) => logs.push(String(s).replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, '')),
    ambienceEnv: env === undefined ? { HA_URL: m.url, HA_TOKEN: m.token, WLED_URL: m.wledUrl } : env,
    ambience: { manual: true, timeoutMs: 300 }
  }, extra || {}));
  await h.ready;
  hubs.push(h);
  h.logs = logs;
  h.dir = dir;
  h.call = (method, route, body) => h.api(method, route, body).then((r) => r.body);
  h.data = async () => (await request(h.port, 'GET', '/live/state')).json.resources.ambience;
  return h;
}

function stopHub(h) {
  return new Promise((resolve) => {
    const i = hubs.indexOf(h);
    if (i >= 0) hubs.splice(i, 1);
    h.close(() => resolve());
  });
}

// What the mailbox would run for { cmd, args }, through the server's api.
async function mail(h, cmd, args) {
  const env = mailbox.checkEnvelope('am-test-1', Buffer.from(JSON.stringify({
    id: 'am-test-1', created: new Date().toISOString(), cmd: cmd, args: args
  })), Date.now());
  const ctx = {
    version: hubServer.SERVER_VERSION,
    call: async (method, route, body) => {
      const r = await h.api(method, route, body);
      if (!r.body || !r.body.ok) throw new Error('The server said no: ' + ((r.body && r.body.error) || r.status) + '.');
      return r.body;
    }
  };
  return mailbox.COMMANDS[env.cmd].run(env.args, ctx);
}

function rejects(fn, re) {
  try { fn(); } catch (e) { if (!re.test(e.message)) throw new Error('wrong reason: ' + e.message); return e; }
  throw new Error('it was accepted');
}

async function main() {
  const m = await mockLights.start({});
  const secretish = [m.token, m.url, m.wledUrl, '127.0.0.1', m.url.split(':').pop(), m.wledUrl.split(':').pop()];
  const names = [].concat(EXAMPLE.lights.map((l) => l.name), EXAMPLE.scenes.map((s) => s.name), EXAMPLE.moods.map((x) => x.name),
    EXAMPLE.lights.map((l) => l.entity), m.entities, ['Geeni lamp 1', 'Sengled bulb', 'Bad request']);
  const allLogs = [];

  /* ---------- settings ---------- */

  await check('settings: no token is "not set up"; token, HA_URL and WLED_URL are checked and never echoed', () => {
    const none = ambience.configFromEnv({});
    assert.strictEqual(none.configured, false);
    assert.strictEqual(none.problem, '');
    const ok = ambience.configFromEnv({ HA_TOKEN: m.token });
    assert.strictEqual(ok.configured, true);
    assert.strictEqual(ok.url, 'http://127.0.0.1:8123', 'Home Assistant on the same Pi when HA_URL is left out');
    assert.strictEqual(ambience.configFromEnv({ HA_TOKEN: m.token, HA_URL: m.url + '/' }).url, m.url);
    const badTok = ambience.configFromEnv({ HA_TOKEN: 'paste here' });
    assert.ok(!badTok.configured && /HA_TOKEN/.test(badTok.problem));
    const creds = ambience.configFromEnv({ HA_TOKEN: m.token, HA_URL: 'http://user:pw@192.0.2.9:8123' });
    assert.ok(!creds.configured && creds.problem.indexOf('pw') < 0 && creds.problem.indexOf('192.0.2.9') < 0 && creds.problem.indexOf(m.token) < 0);
    const w = ambience.configFromEnv({ HA_TOKEN: m.token, WLED_URL: 'ftp://192.0.2.50' });
    assert.ok(w.configured && !w.wledUrl && /WLED_URL/.test(w.wledProblem) && w.wledProblem.indexOf('192.0.2.50') < 0);
    assert.strictEqual(ambience.configFromEnv({ HA_TOKEN: m.token, WLED_URL: m.wledUrl }).wledUrl, m.wledUrl);
  });

  await check('config: the example passes; the defaults have no lights, no scenes and three on/bri moods', () => {
    const c = ambience.validateConfig(EXAMPLE);
    assert.strictEqual(c.lights.length, 3);
    assert.strictEqual(c.lights[1].flaky, true);
    assert.deepStrictEqual(c.scenes.map((s) => s.id), ['chill', 'lights-on', 'reading', 'movie', 'all-off']);
    assert.deepStrictEqual(c.scenes[0].lights, { geeni: { on: true, pct: 20, kelvin: 2200 }, sengled: { on: true, pct: 15, kelvin: 2200 } });
    const d = ambience.defaultConfig();
    assert.deepStrictEqual([d.lights.length, d.scenes.length], [0, 0]);
    assert.deepStrictEqual(d.moods.map((x) => Object.keys(x.state).sort().join(',')), ['on', 'bri,on', 'bri,on']);
    assert.deepStrictEqual(ambience.validateConfig(d), d);
    assert.strictEqual(ambience.sceneTone(c.scenes[0]), '#ff9227', 'Chill night glows warm amber');
    assert.strictEqual(ambience.sceneTone(c.scenes[3]), '#563cc4', 'Movie glows blue-violet');
    assert.strictEqual(ambience.sceneTone(c.scenes[4]), '', 'All off has no glow');
  });

  await check('config: bad input is refused with a readable reason that never repeats the entity', () => {
    const v = (f) => () => { const c = copy(EXAMPLE); f(c); ambience.validateConfig(c); };
    rejects(v((c) => { c.lights[0].id = 'Geeni Lamp'; }), /"id" of 1 to 32 characters/);
    rejects(v((c) => { c.lights[0].id = 'x'.repeat(33); }), /1 to 32/);
    rejects(v((c) => { c.lights[0].name = 'A name that is far too long for a tile'; }), /longer than 24/);
    rejects(v((c) => { c.lights[0].name = ' '; }), /needs a "name"/);
    const e = rejects(v((c) => { c.lights[0].entity = 'media_player.secret_room_echo'; }), /light\.desk_lamp or switch\.camera_plug/);
    assert.ok(e.message.indexOf('secret_room') < 0);
    rejects(v((c) => { c.lights[0].entity = 'light.Bad-Name'; }), /entity/);
    rejects(v((c) => { c.lights[0].kind = 'switch'; }), /does not match/);
    rejects(v((c) => { c.lights[0].flaky = 'yes'; }), /flaky/);
    rejects(v((c) => { c.lights[0].colour = 1; }), /unknown field "colour"/);
    rejects(v((c) => { c.lights[1].entity = c.lights[0].entity; }), /same entity/);
    rejects(v((c) => { c.lights[1].id = 'geeni'; }), /same id/);
    rejects(v((c) => { c.lights = Array.from({ length: 13 }, (x, i) => ({ id: 'l' + i, name: 'L' + i, entity: 'light.l' + i })); c.scenes = []; }), /at most 12/);
    rejects(v((c) => { c.scenes = Array.from({ length: 11 }, (x, i) => ({ id: 's' + i, name: 'S' + i, lights: { geeni: { on: true } } })); }), /at most 10/);
    rejects(v((c) => { c.moods = Array.from({ length: 13 }, (x, i) => ({ id: 'm' + i, name: 'M' + i, state: { on: true } })); c.scenes = []; }), /at most 12/);
    rejects(v((c) => { c.scenes[0].lights.nope = { on: true }; }), /not in "lights"/);
    rejects(v((c) => { c.scenes[0].lights.geeni.pct = 0; }), /1 to 100/);
    rejects(v((c) => { c.scenes[0].lights.geeni.kelvin = 9000; }), /1500 to 6500/);
    rejects(v((c) => { c.scenes[0].lights.geeni.color = [1, 2, 3]; }), /not both/);
    rejects(v((c) => { c.scenes[0].lights.camera = { on: true, pct: 50 }; }), /switch has no brightness/);
    rejects(v((c) => { c.scenes[0].lights.sengled = { on: false, pct: 10 }; }), /off takes no/);
    rejects(v((c) => { c.scenes[0].icon = 'rocket'; }), /"icon" must be one of/);
    rejects(v((c) => { c.scenes[0].wled = 'party'; }), /id of one of the moods/);
    rejects(v((c) => { c.scenes[0].lights = {}; delete c.scenes[0].wled; }), /changes no light/);
    rejects(v((c) => { c.moods[1].state = { on: true, fx: 9 }; }), /unknown field "fx"/);
    rejects(v((c) => { c.moods[1].state = { bri: 300 }; }), /0 to 255/);
    rejects(v((c) => { c.moods[1].state = { seg: [{ col: [[1, 2]] }] }; }), /\[r, g, b\]/);
    rejects(v((c) => { c.extra = 1; }), /unknown field "extra"/);
    rejects(v((c) => { c.lights[0].name = 'x'.repeat(9000); }), /larger than 8 KB/);
    rejects(() => ambience.validateConfig([]), /JSON object/);
  });

  await check('config file: written from the defaults when missing; a damaged one is moved aside', () => {
    const dir = tmpDir();
    const lines = [];
    const c = ambience.loadConfig(dir, (s) => lines.push(s));
    assert.deepStrictEqual(c, ambience.defaultConfig());
    assert.ok(fs.existsSync(path.join(dir, 'ambience.json')));
    fs.writeFileSync(path.join(dir, 'ambience.json'), '{"lights": [ broken');
    const c2 = ambience.loadConfig(dir, (s) => lines.push(s));
    assert.deepStrictEqual(c2, ambience.defaultConfig());
    assert.ok(fs.readdirSync(dir).some((f) => /^ambience\.bad-.*\.json$/.test(f)), 'moved aside');
    assert.deepStrictEqual(lines, ['ambience: the settings file was damaged; moved it aside and started from the defaults']);
    allLogs.push(...lines);
  });

  await check('cleanData keeps only known fields and the TV-safe shape', () => {
    const d = ambience.cleanData({
      v: 1, state: 'ok', problem: 'auth', token: m.token, url: m.url,
      lights: [{ id: 'geeni', name: 'Geeni lamp', entity: 'light.example_geeni_1', kind: 'light', on: true, pct: 20, reachable: true, tone: 'red' }],
      scenes: [{ id: 'chill', name: 'Chill night', icon: 'moon', tone: '#ff9227', lights: {} }],
      active: 'nope', moods: [], wled: null, lastResult: { scene: 'chill', result: 'partial', missing: ['Sengled lamp'], at: '2026-11-17T22:00:00Z' }
    });
    assert.strictEqual(JSON.stringify(d).indexOf('example_geeni'), -1, 'no entity');
    assert.strictEqual(JSON.stringify(d).indexOf(m.token), -1);
    assert.strictEqual(d.problem, '', 'a problem only goes with error');
    assert.strictEqual(d.active, null, 'an unknown scene is not active');
    assert.strictEqual(d.lights[0].tone, undefined);
    assert.deepStrictEqual(Object.keys(d), ['v', 'state', 'problem', 'lights', 'scenes', 'active', 'moods', 'wled', 'lastResult']);
    assert.deepStrictEqual(ambience.cleanData(null), ambience.notsetData('noha'));
  });

  /* ---------- the server, not set up ---------- */

  await check('no HA_TOKEN: the resource says notset (Home Assistant), no polling, no calls', async () => {
    m.reset();
    const h = await startHub(m, {}, { ambience: {} });
    const d = (await h.data()).data;
    assert.deepStrictEqual(d, ambience.notsetData('noha'));
    assert.strictEqual(h.ambience.debug().timer, false, 'no timer');
    await sleep(100);
    assert.strictEqual(m.calls.length, 0, 'nothing asked');
    assert.ok(h.logs.indexOf('ambience: off (no HA_TOKEN in .env)') >= 0);
    const r = await request(h.port, 'POST', '/ambience/scene', { body: { id: 'chill' }, origin: ORIGIN });
    assert.strictEqual(r.status, 409);
    assert.ok(/not set up/.test(r.json.error));
    const st = await request(h.port, 'GET', '/api/status', { token: TOKEN });
    assert.deepStrictEqual(st.json.ambience, { configured: false, state: 'notset', lights: 0, answering: 0, scenes: 0, wled: false });
    allLogs.push(...h.logs);
    await stopHub(h);
  });

  await check('set up, no lights yet: notset (no lights), no polling; HA_TOKEN only', async () => {
    m.reset();
    const h = await startHub(m, { HA_URL: m.url, HA_TOKEN: m.token }, { ambience: {} });
    await sleep(50);
    assert.deepStrictEqual((await h.data()).data, ambience.notsetData('nolights'));
    assert.strictEqual(h.ambience.debug().delay, 0);
    assert.strictEqual(m.calls.length, 0);
    allLogs.push(...h.logs);
    await stopHub(h);
  });

  /* ---------- the server, with the example room ---------- */

  m.reset();
  const hub = await startHub(m);
  const P = hub.port;

  await check('settings saved through the control API reach the screen (lights, scenes with tones, moods)', async () => {
    const r = await hub.call('POST', '/api/ambience/config', { config: EXAMPLE });
    assert.strictEqual(r.ok, true);
    await hub.ambience.poll();
    const d = (await hub.data()).data;
    assert.strictEqual(d.state, 'ok');
    assert.deepStrictEqual(d.lights.map((l) => [l.id, l.name, l.kind, l.on, l.pct, l.reachable, l.flaky]), [
      ['geeni', 'Geeni lamp', 'light', true, 20, true, false],
      ['sengled', 'Sengled lamp', 'light', true, 15, true, true],
      ['camera', 'Camera plug', 'switch', true, 100, true, false]
    ]);
    assert.deepStrictEqual(d.scenes.map((s) => s.id + ':' + s.icon), ['chill:moon', 'lights-on:sun', 'reading:book', 'movie:film', 'all-off:power']);
    assert.deepStrictEqual(d.moods, [{ id: 'off', name: 'Off' }, { id: 'dim', name: 'Dim' }, { id: 'bright', name: 'Bright' }]);
    assert.deepStrictEqual(d.wled, { reachable: true, on: true, bri: 40, mood: null });
    const saved = JSON.parse(fs.readFileSync(path.join(hub.dir, 'ambience.json'), 'utf8'));
    assert.deepStrictEqual(saved, ambience.validateConfig(EXAMPLE));
    const text = JSON.stringify(d);
    secretish.concat(m.entities).forEach((s) => assert.strictEqual(text.indexOf(s), -1, 'the resource holds ' + s));
  });

  await check('a scene asks every light at once (in parallel), then reads them back', async () => {
    m.reset();
    const slowMock = await mockLights.start({ latency: 150 });
    const h = await startHub(slowMock, { HA_URL: slowMock.url, HA_TOKEN: slowMock.token }, { ambience: { manual: true, timeoutMs: 2000 } });
    await h.call('POST', '/api/ambience/config', { config: EXAMPLE });
    slowMock.calls.length = 0;
    const t0 = Date.now();
    const r = await h.call('POST', '/api/ambience/scene', { id: 'lights-on' });
    const took = Date.now() - t0;
    assert.strictEqual(r.result, 'ok');
    const posts = slowMock.calls.filter((c) => c.method === 'POST');
    assert.strictEqual(posts.length, 2);
    assert.ok(posts[1].at < posts[0].end, 'the second call started before the first ended');
    assert.ok(took < 150 * 2 + 150 * 3 + 200, 'took ' + took + ' ms');
    assert.deepStrictEqual(posts.map((c) => c.body.entity_id).sort(), ['light.example_geeni_1', 'light.example_sengled_1']);
    const g = posts.filter((c) => c.body.entity_id === 'light.example_geeni_1')[0];
    assert.deepStrictEqual(g.body, { entity_id: 'light.example_geeni_1', brightness_pct: 100, color_temp_kelvin: 4000 });
    allLogs.push(...h.logs);
    await stopHub(h);
    await slowMock.close();
  });

  await check('Chill night with every light answering: ok, active, the plant wall dimmed', async () => {
    m.reset();
    m.set('light.example_geeni_1', false);
    m.set('light.example_sengled_1', false);
    const r = await hub.call('POST', '/api/ambience/scene', { id: 'chill' });
    assert.deepStrictEqual([r.result, r.answered, r.total, r.missing, r.mood], ['ok', 2, 2, [], 'ok']);
    assert.strictEqual(m.state('light.example_geeni_1').attributes.brightness, Math.round(20 * 255 / 100));
    assert.strictEqual(m.state('light.example_geeni_1').attributes.color_temp_kelvin, 2200);
    assert.deepStrictEqual(m.wledState(), { on: true, bri: 40 });
    const d = (await hub.data()).data;
    assert.strictEqual(d.active, 'chill');
    assert.strictEqual(d.wled.mood, 'dim');
    assert.strictEqual(d.lastResult.result, 'ok');
    assert.deepStrictEqual(d.lastResult.missing, []);
  });

  await check('the Sengled is unavailable: partial, names it, the Geeni alone still changes, still active', async () => {
    m.reset();
    m.light('light.example_sengled_1', 'unavailable');
    const r = await hub.call('POST', '/api/ambience/scene', { id: 'chill' });
    assert.deepStrictEqual([r.result, r.answered, r.total, r.missing], ['partial', 1, 2, ['Sengled lamp']]);
    assert.deepStrictEqual(r.lights, [{ id: 'geeni', result: 'ok' }, { id: 'sengled', result: 'no-answer' }]);
    const d = (await hub.data()).data;
    assert.strictEqual(d.active, 'chill', 'a flaky light never stops the scene being active');
    assert.deepStrictEqual(d.lastResult.missing, ['Sengled lamp']);
    assert.strictEqual(d.lights[1].reachable, false);
    assert.strictEqual(d.lights[0].pct, 20);
  });

  await check('a light that never answers (timeout) and one that refuses: no-answer and refused, never a failed scene', async () => {
    m.reset();
    m.light('light.example_sengled_1', 'slow');
    let r = await hub.call('POST', '/api/ambience/scene', { id: 'reading' });
    assert.deepStrictEqual([r.result, r.missing], ['partial', ['Sengled lamp']]);
    assert.strictEqual(r.lights[1].result, 'no-answer');
    m.light('light.example_sengled_1', 'refuse');
    r = await hub.call('POST', '/api/ambience/scene', { id: 'chill' });
    assert.deepStrictEqual([r.result, r.lights[1].result], ['partial', 'refused']);
    assert.strictEqual((await hub.data()).data.active, 'chill');
  });

  await check('Home Assistant away: the scene failed; two misses make the resource "error", last known kept', async () => {
    m.reset();
    await hub.ambience.poll();
    m.mode('down');
    const r = await hub.call('POST', '/api/ambience/scene', { id: 'lights-on' });
    assert.deepStrictEqual([r.result, r.answered], ['failed', 0]);
    await hub.ambience.poll();
    const d = (await hub.data()).data;
    assert.strictEqual(d.state, 'error');
    assert.strictEqual(d.problem, 'unreachable');
    assert.strictEqual(d.lights.length, 3, 'last known lights kept');
    assert.strictEqual(d.lastResult.result, 'failed');
    assert.ok(hub.ambience.debug().fails >= 2);
    m.mode('ok');
    await hub.ambience.poll();
    const d2 = (await hub.data()).data;
    assert.strictEqual(d2.state, 'ok');
    assert.ok(hub.logs.indexOf('ambience: Home Assistant answering again') >= 0);
  });

  await check('a refused token: error "auth" at once', async () => {
    m.reset();
    m.mode('unauthorized');
    await hub.ambience.poll();
    const d = (await hub.data()).data;
    assert.deepStrictEqual([d.state, d.problem], ['error', 'auth']);
    assert.ok(hub.logs.indexOf('ambience: Home Assistant refused the token (401)') >= 0);
    m.mode('ok');
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).data.state, 'ok');
  });

  await check('active scene: within 5 points still active; a real change clears it; flaky lights do not count', async () => {
    m.reset();
    await hub.call('POST', '/api/ambience/scene', { id: 'chill' });
    m.set('light.example_geeni_1', true, 24);
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).data.active, 'chill', '24% against 20% is close enough');
    m.set('light.example_sengled_1', true, 90);
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).data.active, 'chill', 'the flaky Sengled does not count');
    m.set('light.example_geeni_1', true, 60);
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).data.active, null);
    await hub.call('POST', '/api/ambience/scene', { id: 'all-off' });
    assert.strictEqual((await hub.data()).data.active, 'all-off');
    m.set('light.example_geeni_1', true, 50);
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).data.active, null, 'off in the scene, on now');
  });

  await check('polling: pushes only on a real change; 10 s with a screen, 60 s without; backs off on errors', async () => {
    m.reset();
    await hub.ambience.poll();
    const rev0 = (await hub.data()).rev;
    await hub.ambience.poll();
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).rev, rev0, 'nothing changed, nothing pushed');
    m.set('light.example_geeni_2', true, 50);
    await hub.ambience.poll();
    assert.strictEqual((await hub.data()).rev, rev0, 'a light not in the settings is not news');
    m.set('light.example_geeni_1', false);
    await hub.ambience.poll();
    assert.ok((await hub.data()).rev > rev0, 'a light going off is');
    const lines = [];
    const fake = { n: 0 };
    const c = ambience.createController({
      env: ambience.configFromEnv({ HA_URL: m.url, HA_TOKEN: m.token }), dataDir: tmpDir(), manual: true, timeoutMs: 200,
      log: (s) => lines.push(s), current: () => null, publish: () => {}, screens: () => fake.n
    });
    c.setConfig(EXAMPLE);
    assert.strictEqual(c.debug().delay, 60000);
    fake.n = 1;
    assert.strictEqual(c.debug().delay, 10000);
    m.mode('down');
    await c.poll();
    assert.strictEqual(c.debug().delay, 20000);
    await c.poll();
    await c.poll();
    assert.strictEqual(c.debug().delay, 80000);
    for (let i = 0; i < 4; i++) await c.poll();
    assert.strictEqual(c.debug().delay, 160000, 'capped at 2^4');
    fake.n = 0;
    assert.strictEqual(c.debug().delay, 300000, 'never more than 5 minutes');
    m.mode('ok');
    await c.poll();
    assert.strictEqual(c.debug().delay, 60000);
    assert.strictEqual(lines.filter((l) => /did not answer/.test(l)).length, 1, 'a run of misses is logged once: ' + JSON.stringify(lines));
    allLogs.push(...lines);
    c.close();
  });

  await check('polling with timers: reads soon after start and keeps going; close stops it', async () => {
    m.reset();
    const dir = tmpDir();
    ambience.saveConfig(dir, ambience.validateConfig(EXAMPLE));
    const h = await startHub(m, undefined, { dataDir: dir, ambience: { timeoutMs: 300, screenMs: 80, idleMs: 80 } });
    await sleep(400);
    const reads = m.calls.filter((x) => x.method === 'GET' && /^\/api\/states\//.test(x.path)).length;
    assert.ok(reads >= 9, 'about three rounds of 3 lights, got ' + reads);
    assert.strictEqual(h.ambience.debug().timer, true);
    allLogs.push(...h.logs);
    await stopHub(h);
    const after = m.calls.length;
    await sleep(250);
    assert.strictEqual(m.calls.length, after, 'nothing after close');
  });

  await check('one light: toggle, level, off; a switch has no level; unknown ids are refused', async () => {
    m.reset();
    await hub.ambience.poll();
    let r = await hub.call('POST', '/api/ambience/light', { id: 'geeni', pct: 70 });
    assert.deepStrictEqual([r.result, r.on, r.pct], ['ok', true, 70]);
    r = await hub.call('POST', '/api/ambience/light', { id: 'geeni' });
    assert.deepStrictEqual([r.result, r.on], ['ok', false], 'no on and no pct toggles');
    r = await hub.call('POST', '/api/ambience/light', { id: 'camera', on: false });
    assert.deepStrictEqual([r.result, r.on], ['ok', false]);
    assert.strictEqual(m.state('switch.example_camera_plug').state, 'off');
    const s = await hub.api('POST', '/api/ambience/light', { id: 'camera', pct: 20 });
    assert.strictEqual(s.status, 400);
    const u = await hub.api('POST', '/api/ambience/light', { id: 'light.example_geeni_1', on: true });
    assert.strictEqual(u.status, 400, 'an entity id is not a light id');
    m.light('light.example_sengled_1', 'unavailable');
    r = await hub.call('POST', '/api/ambience/light', { id: 'sengled', on: true });
    assert.strictEqual(r.result, 'no-answer');
  });

  await check('plant wall moods: applied, read back, no answer, and off without WLED_URL', async () => {
    m.reset();
    let r = await hub.call('POST', '/api/ambience/mood', { id: 'bright' });
    assert.strictEqual(r.result, 'ok');
    assert.deepStrictEqual(m.wledState(), { on: true, bri: 200 });
    assert.strictEqual((await hub.data()).data.wled.mood, 'bright');
    m.wled('down');
    r = await hub.call('POST', '/api/ambience/mood', { id: 'off' });
    assert.strictEqual(r.result, 'no-answer');
    assert.strictEqual((await hub.data()).data.wled.reachable, false);
    m.wled('ok');
    assert.strictEqual((await hub.api('POST', '/api/ambience/mood', { id: 'party' })).status, 400);
    const h = await startHub(m, { HA_URL: m.url, HA_TOKEN: m.token });
    await h.call('POST', '/api/ambience/config', { config: EXAMPLE });
    const d = (await h.data()).data;
    assert.deepStrictEqual([d.moods, d.wled], [[], null], 'no plant wall without WLED_URL');
    assert.strictEqual((await h.api('POST', '/api/ambience/mood', { id: 'dim' })).status, 409);
    const sc = await h.call('POST', '/api/ambience/scene', { id: 'chill' });
    assert.strictEqual(sc.result, 'ok', 'a scene with a mood still works without the plant wall');
    allLogs.push(...h.logs);
    await stopHub(h);
  });

  /* ---------- the screen's door ---------- */

  await check('screen door: POST /ambience/scene with a saved id works without a token', async () => {
    m.reset();
    await sleep(1300);   // a full bucket
    const r = await request(P, 'POST', '/ambience/scene', { body: { id: 'chill' }, origin: ORIGIN });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.result, 'ok');
    assert.strictEqual(r.headers['access-control-allow-origin'], ORIGIN);
    const l = await request(P, 'POST', '/ambience/light', { body: { id: 'geeni', pct: 40 } });
    assert.strictEqual(l.json.pct, 40);
  });

  await check('screen door: only saved ids; anything else is 400; no config, no GET, no foreign origin', async () => {
    await sleep(1300);
    const bad = await request(P, 'POST', '/ambience/scene', { body: { id: 'party' } });
    assert.strictEqual(bad.status, 400);
    await sleep(450);
    assert.strictEqual((await request(P, 'POST', '/ambience/light', { body: { id: 'light.example_geeni_1' } })).status, 400);
    await sleep(450);
    assert.strictEqual((await request(P, 'POST', '/ambience/scene', { body: { id: 7 } })).status, 400);
    await sleep(450);
    assert.strictEqual((await request(P, 'POST', '/ambience/config', { body: { config: null } })).status, 404);
    assert.strictEqual((await request(P, 'GET', '/ambience/scene')).status, 405);
    assert.strictEqual((await request(P, 'POST', '/ambience/scene', { body: { id: 'chill' }, origin: 'http://evil.example' })).status, 403);
    assert.strictEqual((await request(P, 'POST', '/ambience/mood', { body: 'not json' })).status, 400);
  });

  await check('screen door: rate limited (3 at once, then one every 400 ms) and says "slow down"', async () => {
    await sleep(1300);
    const all = await Promise.all([0, 1, 2, 3, 4].map(() => request(P, 'POST', '/ambience/light', { body: { id: 'geeni', pct: 30 } })));
    const codes = all.map((x) => x.status).sort();
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
    assert.strictEqual(all.filter((x) => x.status === 429)[0].json.error, 'slow down');
    await sleep(450);
    assert.strictEqual((await request(P, 'POST', '/ambience/light', { body: { id: 'geeni', pct: 35 } })).status, 200);
    let fakeNow = 1000;
    const c = ambience.createController({ env: { configured: false }, manual: true, now: () => fakeNow, log: () => {} });
    assert.deepStrictEqual([c.screenAllowed(), c.screenAllowed(), c.screenAllowed(), c.screenAllowed()], [true, true, true, false]);
    fakeNow += 399;
    assert.strictEqual(c.screenAllowed(), false);
    fakeNow += 2;
    assert.strictEqual(c.screenAllowed(), true);
  });

  /* ---------- ./hub and the mailbox ---------- */

  await check('./hub ambience text: one status line, per-light lines, scene, light, mood and set answers', async () => {
    m.reset();
    m.light('light.example_sengled_1', 'unavailable');
    await hub.call('POST', '/api/ambience/scene', { id: 'chill' });
    const a = (await hub.call('GET', '/api/ambience')).ambience;
    assert.strictEqual(hubctl.ambienceLine(a), '3 lights, 2 answering, 2 on, scene Chill night. Plant wall: Dim.');
    const lines = hubctl.ambienceStatusLines(a);
    assert.deepStrictEqual(lines.slice(1), [
      '  Geeni lamp (geeni): on at 20%', '  Sengled lamp (sengled): not answering (flaky)', '  Camera plug (camera): on',
      'Last scene: Sengled lamp didn\'t answer.'
    ]);
    assert.ok(hubctl.ambienceScenesLines(a).indexOf('  chill  Chill night  (now)') >= 0);
    assert.strictEqual(hubctl.ambienceSceneText({ result: 'partial', answered: 1, total: 2, missing: ['Sengled lamp'] }, 'Chill night'),
      'Chill night: partly applied (1 of 2 lights answered; Sengled lamp didn\'t answer).');
    assert.strictEqual(hubctl.ambienceSceneText({ result: 'ok', answered: 2, total: 2, missing: [] }, 'Movie'), 'Movie: applied (2 of 2 lights answered).');
    assert.strictEqual(hubctl.ambienceLightText({ result: 'ok', on: true, pct: 40 }, 'Geeni lamp'), 'Geeni lamp is on at 40%.');
    assert.strictEqual(hubctl.ambienceLightText({ result: 'no-answer' }, 'Sengled lamp'), 'Sengled lamp didn\'t answer. Nothing changed.');
    assert.strictEqual(hubctl.ambienceMoodText({ result: 'ok' }, 'Dim'), 'Plant wall: Dim.');
    assert.strictEqual(hubctl.ambienceLine(undefined), 'This server does not know Ambience yet (it needs an update): run git pull, then docker compose restart hub.');
    assert.strictEqual(hubctl.ambienceLine({ configured: false, problem: '' }), 'Ambience: not set up (add HA_TOKEN to pi/.env, then docker compose restart hub).');
    assert.ok(/no lights added yet/.test(hubctl.ambienceLine({ configured: true, state: 'notset', lights: [] })));
    assert.ok(/^Home Assistant is not answering/.test(hubctl.ambienceLine(Object.assign({}, a, { state: 'error', haProblem: 'unreachable' }))));
  });

  await check('./hub ambience runs end to end (status, scene, light, mood, set, reset)', async () => {
    m.reset();
    const file = path.join(tmpDir(), 'room.json');
    fs.writeFileSync(file, JSON.stringify({ config: EXAMPLE }));
    // Not spawnSync: the server answering runs in this same process.
    const run = (args) => new Promise((resolve) => {
      require('child_process').execFile(process.execPath, [path.join(__dirname, 'hubctl.js')].concat(args), {
        env: Object.assign({}, process.env, { HUB_TOKEN: TOKEN, HUB_URL: 'http://127.0.0.1:' + P }), encoding: 'utf8'
      }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout: stdout, stderr: stderr }));
    });
    let r = await run(['ambience', 'set', file]);
    assert.strictEqual(r.stdout, 'Saved: 3 lights, 5 scenes, 3 moods. Screens that are on change now.\n', r.stdout + r.stderr);
    await sleep(1300);
    r = await run(['ambience', 'scene', 'movie']);
    assert.strictEqual(r.stdout, 'Movie: applied (2 of 2 lights answered).\n', r.stdout);
    r = await run(['ambience', 'light', 'geeni', '35']);
    assert.strictEqual(r.stdout, 'Geeni lamp is on at 35%.\n');
    r = await run(['ambience', 'light', 'geeni', 'loud']);
    assert.strictEqual(r.status, 1);
    r = await run(['ambience', 'mood', 'dim']);
    assert.strictEqual(r.stdout, 'Plant wall: Dim.\n');
    r = await run(['ambience', 'scene', 'party']);
    assert.strictEqual(r.stdout, 'The server said no: there is no scene with that id.\n');
    r = await run(['ambience', 'status']);
    assert.ok(/^3 lights, 3 answering/.test(r.stdout), r.stdout);
    r = await run(['ambience', 'reset']);
    assert.strictEqual(r.stdout, 'Back to the defaults: 0 lights, 0 scenes, 3 moods. Screens that are on change now.\n');
    const left = (await hub.data()).data;
    assert.deepStrictEqual([left.lights.length, left.scenes.length, left.moods.length], [0, 0, 3], 'with WLED_URL the moods stay');
    r = await run(['ambience', 'nonsense']);
    assert.ok(/Use one of: ambience status/.test(r.stdout));
    [r.stdout].concat((await run(['help'])).stdout).forEach((t) => assert.strictEqual(t.indexOf(m.token), -1));
    assert.ok(/\.\/hub ambience scene chill/.test((await run(['help'])).stdout));
  });

  await check('mailbox: ambience.status is one plain line; scene, light, mood, set and reset; args checked', async () => {
    m.reset();
    let r = await mail(hub, 'ambience.set', { config: EXAMPLE });
    assert.strictEqual(r.message, 'Saved: 3 lights, 5 scenes, 3 moods. Screens that are on change now.');
    assert.deepStrictEqual(r.data, { lights: 3, scenes: 5, moods: 3 }, 'counts only, no entity ids');
    await hub.ambience.poll();
    m.light('light.example_sengled_1', 'unavailable');
    r = await mail(hub, 'ambience.scene', { id: 'chill' });
    assert.strictEqual(r.message, 'Chill night: partly applied (1 of 2 lights answered; Sengled lamp didn\'t answer).');
    assert.deepStrictEqual(r.data, { result: 'partial', answered: 1, total: 2, missing: ['Sengled lamp'] });
    r = await mail(hub, 'ambience.status', {});
    assert.strictEqual(r.message, '3 lights, 2 answering, 2 on, scene Chill night. Plant wall: Dim.');
    assert.strictEqual(r.message.indexOf('\n'), -1, 'one line');
    r = await mail(hub, 'ambience.light', { id: 'geeni', on: true, pct: 45 });
    assert.strictEqual(r.message, 'Geeni lamp is on at 45%.');
    r = await mail(hub, 'ambience.mood', { id: 'bright' });
    assert.strictEqual(r.message, 'Plant wall: Bright.');
    await assert.rejects(mail(hub, 'ambience.scene', { id: 'party' }), /no scene with that id/);
    await assert.rejects(mail(hub, 'ambience.light', { id: 'geeni', pct: 4.5 }), /whole number/);
    await assert.rejects(mail(hub, 'ambience.light', { id: 'geeni', on: false, pct: 40 }), /goes with a light that is on/);
    await assert.rejects(mail(hub, 'ambience.scene', {}), /needs "id"/);
    await assert.rejects(mail(hub, 'ambience.scene', { id: 'chill', entity: 'x' }), /does not take "entity"/);
    const big = copy(EXAMPLE);
    big.lights[0].name = 'x'.repeat(9000);
    await assert.rejects(mail(hub, 'ambience.set', { config: big }), /larger than 8 KB/);
    await assert.rejects(mail(hub, 'ambience.set', { config: Object.assign(copy(EXAMPLE), { lights: [] }) }), /not in "lights"/);
    r = await mail(hub, 'ambience.reset', {});
    assert.deepStrictEqual(r.data, { lights: 0, scenes: 0, moods: 3 });
    const st = await mail(hub, 'ambience.status', {});
    const text = JSON.stringify(st);
    secretish.forEach((s) => assert.strictEqual(text.indexOf(s), -1, 'mailbox answer holds ' + s));
  });

  /* ---------- logs and secrets ---------- */

  await check('every ambience log line is a fixed line: no token, address, port, entity or name', async () => {
    allLogs.push(...hub.logs);
    const am = allLogs.filter((l) => /^ambience/i.test(l));
    allLogs.forEach((l) => {
      secretish.slice(0, 3).concat(names).forEach((s) => assert.strictEqual(l.indexOf(s), -1, l + ' holds ' + s));
    });
    assert.ok(am.length > 10, 'some lines: ' + am.length);
    am.forEach((l) => {
      assert.ok(/^ambience: /.test(l), 'starts with "ambience:": ' + l);
      secretish.concat(names).forEach((s) => assert.strictEqual(l.indexOf(String(s)), -1, l + ' holds ' + s));
      assert.strictEqual(logscrub.scrub(l, []), l, 'nothing for the scrubber to take out: ' + l);
    });
    // The control lines carry a result word at most.
    allLogs.filter((l) => /^control \S+ \/api\/ambience/.test(l)).forEach((l) => {
      assert.ok(/^control (GET|POST) \/api\/ambience(\/\w+)? -> \d{3}( (ok|partial|failed|no-answer|refused|saved|defaults))?$/.test(l), l);
    });
    const ALLOWED = [
      /^ambience: off \(no HA_TOKEN in \.env\)$/, /^ambience: off \(HA_TOKEN or HA_URL does not look right\)$/,
      /^ambience: plant wall off \(WLED_URL does not look right\)$/,
      /^ambience: on \(\d+ lights?, \d+ scenes?, \d+ moods?\)$/, /^ambience: settings saved \(\d+ lights?, \d+ scenes?, \d+ moods?\)$/,
      /^ambience: the settings file was damaged; moved it aside and started from the defaults$/,
      /^ambience: could not write the settings file$/,
      /^ambience: Home Assistant did not answer \((timeout|network)\)$/, /^ambience: Home Assistant refused the token \(401\)$/,
      /^ambience: Home Assistant sent a reply that could not be read$/, /^ambience: Home Assistant answering again$/,
      /^ambience: scene (applied|failed) \(\d+ of \d+ lights answered\)$/,
      /^ambience: light set$/, /^ambience: light did not answer$/, /^ambience: light refused the change$/,
      /^ambience: mood applied$/, /^ambience: plant wall did not answer$/, /^ambience: plant wall refused the mood$/,
      /^ambience: plant wall answering again$/,
      /^ambience: a screen sent commands too fast \(asked it to slow down\)$/,
      /^ambience: unexpected problem (while reading the lights|with a command)$/
    ];
    am.forEach((l) => assert.ok(ALLOWED.some((re) => re.test(l)), 'not a known line: ' + l));
    // The lines are sorted the way GET /api/log sorts them.
    assert.strictEqual(logscrub.level('ambience: Home Assistant did not answer (timeout)'), 'error');
    assert.strictEqual(logscrub.level('ambience: scene failed (0 of 2 lights answered)'), 'error');
    assert.strictEqual(logscrub.level('ambience: scene applied (1 of 2 lights answered)'), 'info');
    assert.strictEqual(logscrub.level('ambience: Home Assistant answering again'), 'info');
  });

  await check('no token or address in /api/ambience, /api/status, /live/state or the state file', async () => {
    await hub.call('POST', '/api/ambience/config', { config: EXAMPLE });
    await hub.ambience.poll();
    const texts = [
      (await request(P, 'GET', '/api/ambience', { token: TOKEN })).text,
      (await request(P, 'GET', '/api/status', { token: TOKEN })).text,
      (await request(P, 'GET', '/live/state')).text,
      fs.readFileSync(path.join(hub.dir, 'state.json'), 'utf8')
    ];
    texts.forEach((t, i) => {
      [m.token, m.url, m.wledUrl].forEach((s) => assert.strictEqual(t.indexOf(s), -1, 'text ' + i + ' holds ' + s));
      m.entities.forEach((s) => assert.strictEqual(t.indexOf(s), -1, 'text ' + i + ' holds ' + s));
    });
    assert.strictEqual(JSON.parse(texts[1]).ambience.lights, 3);
  });

  await check('a restart keeps the settings and the last picture (state file), and an old state file loads', async () => {
    const dir = hub.dir;
    await stopHub(hub);
    const h = await startHub(m, undefined, { dataDir: dir });
    const d = (await h.data()).data;
    assert.strictEqual(d.lights.length, 3);
    assert.deepStrictEqual(h.ambience.getConfig(), ambience.validateConfig(EXAMPLE));
    await stopHub(h);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    delete st.resources.ambience;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const h2 = await startHub(m, {}, { dataDir: dir });
    assert.deepStrictEqual((await h2.data()).data, ambience.notsetData('noha'));
    await stopHub(h2);
  });

  for (const h of hubs.slice()) await stopHub(h);
  await m.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('crashed: ' + (e && e.stack)); process.exit(1); });
