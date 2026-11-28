/*
 * Tests for Moods' controller and wiring: pi/moods/controller.js and its doors
 * in pi/server.js (the /api/moods* routes, POST /api/command { type: "mood" },
 * POST /moods/set, /touch/state), pi/hubctl.js (./hub moods, ./hub ambiance),
 * pi/mailbox.js (moods.*) and the extraLooks option of pi/lights/store.js.
 * Run from the repo root with:
 *
 *   node pi/moods-test.js
 *
 * The real hub server runs in this process against dev/mock-wall.js (a
 * pretend WLED on 127.0.0.1 that records every call), a fake Pi-drawn engine
 * (pi/moods/engine.js createFakeEngine), fake timers, a seeded random and
 * the real looks store in a throwaway folder. Nothing reaches a real wall,
 * Home Assistant or Govee. No clock times or time zones: "today" is passed in
 * as numbers and the controller's clock is a counter.
 * Prints one line per check, then "N passed, M failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const hubServer = require('./server');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const storeLib = require('./lights/store');
const C = require('./moods/catalog');
const W = require('./moods/compile');
const R = require('./moods/render');
const E = require('./moods/engine');
const F = require('./moods/forest-render');
const ctl = require('./moods/controller');
const mockWall = require('../dev/mock-wall');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const ORIGIN = 'http://127.0.0.1:8081';
const TODAY = { y: 2026, m: 12, d: 6 }; // Hanukkah 2026 starts on the evening of 12-04: night 3
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-md-'));
  tmpDirs.push(d);
  return d;
}

async function check(name, fn) {
  if (process.env.MOODS_GREP && name.indexOf(process.env.MOODS_GREP) < 0) return;
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
    const text = opt.body === undefined ? '' : JSON.stringify(opt.body);
    const headers = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }, opt.headers || {});
    if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (text) req.write(text);
    req.end();
  });
}

// Timers the test drives: short waits (the renderer's 300 ms lead) run at once,
// longer ones (director gaps, the end of a dim) wait in .list until run().
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout(fn, ms) {
      if (ms <= 500) return { real: setTimeout(fn, 0) };
      const h = { fn, ms };
      list.push(h);
      return h;
    },
    clearTimeout(h) {
      if (!h) return;
      if (h.real) { clearTimeout(h.real); return; }
      const i = list.indexOf(h);
      if (i >= 0) list.splice(i, 1);
    },
    run() { const h = list.shift(); if (h) h.fn(); return h; },
    clear() { list.length = 0; }
  };
}

const cat = C.load(null);
const moodBy = (id) => C.moodById(cat.catalog, id);
// The context the controller builds before any probe.
function baseCtx(mood, x) {
  return Object.assign({ catalog: cat.catalog, wall: cat.wall, date: TODAY, fxIds: null, palIds: null, have: { mic: null } }, x || {});
}
const posts = (from) => (w) => w.posts().slice(from);

async function main() {
  const wall = await mockWall.start();
  const timers = fakeTimers();
  let clock = 1000000;
  let fake = null;
  let refuse = false;
  const logs = [];
  const engineFactory = (h) => {
    fake = E.createFakeEngine({ log: h.log, onExit: h.onExit, start: () => (refuse ? { ok: false, why: 'test refusal' } : { ok: true, why: '' }) });
    return fake;
  };
  let rng = F.mulberry32(7);
  function startHub(dataDir, x) {
    const o = x || {};
    const h = hubServer.start(Object.assign({
      port: 0, token: TOKEN, dataDir, log: (s) => logs.push(String(s)),
      moodsEnv: Object.assign({ WLED_URL: wall.url }, o.env || {}),
      moods: { engine: engineFactory, timers, rng: () => rng(), now: () => clock, today: () => TODAY, presetSettleMs: 0, presetPollMs: 1 }
    }, o.opt || {}));
    return h.ready.then(() => h);
  }
  const stop = (h) => new Promise((r) => h.close(r));
  const dir = tmpDir();
  let h = await startHub(dir);
  const api = (method, p, body) => request(h.port, method, p, { token: TOKEN, body });
  const scr = (method, p, body, headers) => request(h.port, method, p, { body, headers: Object.assign({ Origin: ORIGIN }, headers || {}) });
  const nowOf = async () => (await api('GET', '/api/moods/now')).body;
  const lightsSt = async () => (await api('GET', '/api/lights')).body;
  const stateFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'moods-state.json'), 'utf8'));

  await check('passive: nothing is sent to the wall at start, by status reads or by the screens\' state', async () => {
    assert.strictEqual(wall.calls.length, 0);
    const st = (await api('GET', '/api/moods')).body;
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.configured, true);
    assert.strictEqual(st.now.id, 'off');
    assert.strictEqual(st.moods.length, 22);
    const live = (await scr('GET', '/live/state')).body.resources.moods.data;
    assert.strictEqual(live.state, 'ok');
    assert.strictEqual(live.moods.length, 22);
    assert.ok(!live.moods.some((m) => m.id === 'check'), 'the hidden check mood is not on the rail');
    assert.deepStrictEqual(Object.keys(live).sort(), ['last', 'moods', 'now', 'problem', 'state', 'wall']);
    assert.deepStrictEqual(Object.keys(live.moods[0]).sort(), ['bri', 'desc', 'descEs', 'es', 'group', 'id', 'name', 'param', 'pv', 'sw', 'tags']);
    assert.deepStrictEqual(Object.keys(live.wall).sort(), ['geometry', 'leds', 'menorah', 'zones']);
    assert.ok(live.moods.find((m) => m.id === 'rainforest-storm').tags.indexOf('pi') >= 0, 'the forest moods can be drawn by the (fake) engine');
    assert.ok(live.moods.find((m) => m.id === 'santa').tags.indexOf('mic') >= 0);
    assert.ok(live.moods.find((m) => m.id === 'carol-of-the-bells').tags.indexOf('song') >= 0);
    assert.ok(live.moods.find((m) => m.id === 'menorah').param.night);
    const touch = (await scr('GET', '/touch/state')).body;
    assert.strictEqual(touch.moods.data.moods.length, 22);
    assert.ok(Number.isInteger(touch.moods.rev));
    assert.strictEqual(wall.calls.length, 0);
  });

  await check('dry run: nothing is sent, no state changes, and the exact bodies come back', async () => {
    const r = await api('POST', '/api/moods/set', { id: 'christmas', dry: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dry, true);
    const want = W.compileWled(moodBy('christmas'), baseCtx(moodBy('christmas'), { briPct: 100 }));
    assert.deepStrictEqual(r.body.plan.wled, want.bodies.map((b) => ({ method: 'POST', path: '/json/state', body: b })));
    assert.deepStrictEqual(r.body.plan.reads, [{ method: 'GET', path: '/json/state' }]);
    assert.deepStrictEqual(r.body.plan.budget, want.budget);
    assert.deepStrictEqual(r.body.plan.checks, []);
    assert.strictEqual(r.body.plan.govee.look.id, 'mood-christmas');
    assert.strictEqual(r.body.plan.engine, null, 'christmas is not a forest mood');
    const f = (await api('POST', '/api/moods/set', { id: 'rainforest-storm', dry: true })).body.plan;
    assert.strictEqual(f.engine.kind, 'fake');
    assert.deepStrictEqual(f.engine.env, ['WLED_HOST']);
    assert.deepStrictEqual(f.engine.args, R.forestArgs(R.compileRender(moodBy('rainforest-storm'), baseCtx()), {}, {}));
    assert.ok(!JSON.stringify(f).includes(String(wall.port)) && !JSON.stringify(f).includes('127.0.0.1'), 'never the address');
    assert.deepStrictEqual(f.events, { thunder: { auto: [20, 75] } });
    assert.deepStrictEqual(f.wled.map((x) => x.body), [{ on: true, ps: 2 }, { bri: W.compileWled(moodBy('rainforest-storm'), baseCtx()).bodies[1].bri }]);
    assert.strictEqual(wall.calls.length, 0);
    assert.strictEqual((await nowOf()).id, 'off');
    assert.ok(!fs.existsSync(path.join(dir, 'moods-state.json')) || stateFile().current === null);
  });

  await check('set, then off: a snapshot first, the compiled bodies, then the snapshot put back', async () => {
    const before = wall.state();
    const r = await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.result, 'ok');
    assert.deepStrictEqual(wall.calls.map((c) => c.method + ' ' + c.path), ['GET /json/state', 'POST /json/state']);
    const want = W.compileWled(moodBy('christmas'), baseCtx(moodBy('christmas'), { briPct: 100 }));
    assert.deepStrictEqual(wall.posts(), want.bodies);
    const n = await nowOf();
    assert.strictEqual(n.id, 'christmas');
    assert.strictEqual(n.name, 'Christmas');
    assert.strictEqual(n.path, 'wled-effects');
    assert.strictEqual(n.on, true);
    assert.deepStrictEqual(Object.keys(n).sort(), ['bri', 'id', 'name', 'night', 'on', 'ok', 'pair', 'path', 'since', 'stale'].sort());
    const saved = stateFile();
    assert.strictEqual(saved.snapshot.ps, 2);
    assert.strictEqual(saved.current.id, 'christmas');
    const live = (await scr('GET', '/live/state')).body.resources.moods.data;
    assert.strictEqual(live.now.id, 'christmas');
    assert.strictEqual(live.last.result, 'ok');
    // Off
    const k = wall.posts().length;
    const off = await api('POST', '/api/moods/off', {});
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.result, 'ok');
    assert.deepStrictEqual(posts(k)(wall), W.restoreBodies(saved.snapshot, cat.wall));
    const after = wall.state();
    assert.strictEqual(after.ps, 2);
    assert.deepStrictEqual(after.seg.map((s) => s.id), before.seg.map((s) => s.id));
    assert.strictEqual(stateFile().snapshot, null);
    assert.strictEqual((await nowOf()).id, 'off');
    // Off again: nothing on, nothing sent.
    const n2 = wall.calls.length;
    const again = await api('POST', '/api/moods/off', {});
    assert.strictEqual(again.body.nothing, true);
    assert.strictEqual(wall.calls.length, n2);
  });

  await check('a snapshot survives a hub restart; nothing is sent or started by the restart', async () => {
    wall.reset();
    await api('POST', '/api/moods/set', { id: 'aurora', pair: false });
    const snap = stateFile().snapshot;
    assert.ok(snap && snap.ps === 2);
    await stop(h);
    wall.reset();
    h = await startHub(dir);
    assert.strictEqual(wall.calls.length, 0);
    const n = await nowOf();
    assert.strictEqual(n.id, 'aurora');
    assert.strictEqual(n.path, 'wled-effects');
    assert.strictEqual(timers.list.length, 0, 'no director after a restart');
    const off = await api('POST', '/api/moods/off', {});
    assert.strictEqual(off.status, 200);
    assert.strictEqual(wall.calls[0].method, 'POST', 'no new snapshot: the saved one is put back');
    assert.ok(wall.calls.filter((c) => c.method === 'GET').every((c, i, a) => wall.calls.indexOf(c) > wall.calls.findIndex((x) => x.body && x.body.ps === 2)), 'the only reads wait for the preset');
    assert.deepStrictEqual(wall.posts(), W.restoreBodies(snap, cat.wall));
  });

  await check('brightness: the mood on now changes only bri; another mood keeps it for later; limits', async () => {
    wall.reset();
    await api('POST', '/api/moods/set', { id: 'movie-night', pair: false });
    const k = wall.posts().length;
    const r = await api('POST', '/api/moods/bri', { pct: 40 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.applied, true);
    assert.deepStrictEqual(posts(k)(wall), [{ bri: Math.round(255 * 40 / 100) }]);
    assert.strictEqual((await nowOf()).bri, 40);
    const later = await api('POST', '/api/moods/bri', { pct: 50, id: 'christmas' });
    assert.strictEqual(later.body.applied, false);
    assert.strictEqual(wall.posts().length, k + 1);
    await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    assert.strictEqual(wall.posts()[wall.posts().length - 1].bri, Math.round(255 * 50 / 100));
    assert.strictEqual((await scr('GET', '/live/state')).body.resources.moods.data.moods.find((m) => m.id === 'christmas').bri, 50);
    assert.strictEqual((await api('POST', '/api/moods/bri', { pct: 5 })).status, 400);
    assert.strictEqual((await api('POST', '/api/moods/set', { id: 'christmas', bri: 101 })).status, 400);
    await api('POST', '/api/moods/off', {});
    assert.strictEqual((await api('POST', '/api/moods/bri', { pct: 40 })).status, 409, 'no mood on and no id');
  });

  await check('Menorah: a given night, and the automatic one from today\'s date (numbers, no clock)', async () => {
    wall.reset();
    const r = await api('POST', '/api/moods/set', { id: 'menorah', night: 5, pair: false });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(wall.posts(), W.compileWled(moodBy('menorah'), baseCtx(null, { briPct: 100, night: 5 })).bodies);
    assert.strictEqual((await nowOf()).night, 5);
    await api('POST', '/api/moods/set', { id: 'menorah', pair: false });
    assert.strictEqual((await nowOf()).night, 5, 'Menorah on again with no night keeps the night on now');
    await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    await api('POST', '/api/moods/set', { id: 'menorah', pair: false });
    assert.strictEqual((await nowOf()).night, 3, 'from another mood: tonight\'s night');
    assert.deepStrictEqual(wall.posts()[wall.posts().length - 1], W.compileWled(moodBy('menorah'), baseCtx(null, { briPct: 100, night: 3 })).bodies[0]);
    assert.strictEqual((await api('POST', '/api/moods/set', { id: 'christmas', night: 2 })).status, 400);
    assert.strictEqual((await api('POST', '/api/moods/set', { id: 'menorah', night: 9 })).status, 400);
    await api('POST', '/api/moods/off', {});
  });

  await check('lamp and bars: a mood sets its look (own or ref), Off clears it, music lights win and are never switched on', async () => {
    wall.reset();
    const r = await api('POST', '/api/moods/set', { id: 'christmas', pair: true });
    assert.strictEqual(r.body.govee, 'set');
    let ls = await lightsSt();
    assert.strictEqual(ls.settings.look, 'mood-christmas');
    assert.strictEqual(ls.settings.on, false);
    assert.ok(!ls.looks.some((l) => /^mood-/.test(l.id)), 'never in the presets list');
    const eng = await api('POST', '/api/lights/engine', { state: 'off', events: [] });
    assert.strictEqual(eng.body.look.id, 'mood-christmas', 'the engine gets the look itself');
    assert.deepStrictEqual(eng.body.look.bars, moodBy('christmas').govee.look.bars);
    const looks = (await scr('GET', '/live/state')).body.resources.lightlooks.data.looks;
    assert.ok(looks.length > 0 && !looks.some((l) => /^mood-/.test(l.id)), 'never in lightlooks');
    await api('POST', '/api/moods/set', { id: 'rainforest' });
    assert.strictEqual((await lightsSt()).settings.look, 'rainforest');
    await api('POST', '/api/moods/off', {});
    assert.strictEqual((await lightsSt()).settings.look, '', 'Off clears the look it set');
    // A look picked by hand after the mood is left alone by Off.
    await api('POST', '/api/moods/set', { id: 'christmas' });
    await api('POST', '/api/lights', { look: 'octane' });
    await api('POST', '/api/moods/off', {});
    assert.strictEqual((await lightsSt()).settings.look, 'octane');
    // Music lights on: skipped, reported, still on.
    await api('POST', '/api/lights', { on: true });
    const m = await api('POST', '/api/moods/set', { id: 'aurora' });
    assert.strictEqual(m.body.govee, 'music');
    assert.strictEqual((await nowOf()).pair, true);
    ls = await lightsSt();
    assert.strictEqual(ls.settings.on, true);
    await api('POST', '/api/lights', { on: false });
    // pair: false is remembered and leaves the lights alone.
    await api('POST', '/api/lights', { look: 'off' });
    const p = await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    assert.strictEqual(p.body.govee, 'off');
    assert.strictEqual((await lightsSt()).settings.look, '');
    assert.strictEqual((await nowOf()).pair, false);
    await api('POST', '/api/moods/set', { id: 'aurora' });
    assert.strictEqual((await lightsSt()).settings.look, '', 'still unpaired');
    await api('POST', '/api/moods/set', { id: 'aurora', pair: true });
    assert.strictEqual((await lightsSt()).settings.look, 'mood-aurora');
    await api('POST', '/api/moods/off', {});
    assert.strictEqual((await lightsSt()).settings.on, false, 'Moods never switches music lights on');
  });

  await check('store: extraLooks are found by id, left out of lookList and screenData (pi/lights/store.js)', () => {
    const d = tmpDir();
    const extra = [{ id: 'mood-x', name: 'X', lamp: { brightness: 10, color: [1, 2, 3] }, bars: { brightness: 10, color: [1, 2, 3] } }];
    const s = storeLib.createStore({ dataDir: d, extraLooks: () => extra });
    assert.strictEqual(s.lookById('mood-x').id, 'mood-x');
    assert.ok(!s.status().looks.some((l) => l.id === 'mood-x'));
    assert.ok(!s.screenData().looks.some((l) => l.id === 'mood-x'));
    s.change({ look: 'mood-x' });
    assert.strictEqual(s.settings().look, 'mood-x');
    assert.strictEqual(s.engineReport({ state: 'off' }).look.id, 'mood-x');
    const plain = storeLib.createStore({ dataDir: tmpDir() });
    assert.throws(() => plain.change({ look: 'mood-x' }), /no preset/);
  });

  await check('director: automatic thunder at seeded random gaps on the hub\'s timers; an outside cue pauses it 5 minutes', async () => {
    wall.reset();
    timers.clear();
    rng = F.mulberry32(11);
    const twin = F.mulberry32(11);
    const gap = () => Math.max(1000, Math.round((20 + twin() * 55) * 1000));
    const r = await api('POST', '/api/moods/set', { id: 'rainforest-storm', pair: false });
    assert.strictEqual(r.body.engine.ok, true);
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    assert.strictEqual(fake.calls.filter((c) => c.fn === 'start').pop().id, 'rainforest-storm');
    fake.calls.length = 0;
    assert.strictEqual(timers.list.length, 1);
    assert.strictEqual(timers.list[0].ms, gap());
    timers.run();
    await sleep(20);
    assert.deepStrictEqual(fake.calls, [{ fn: 'event', name: 'thunder', n: 1 }]);
    assert.strictEqual(timers.list.length, 1);
    assert.strictEqual(timers.list[0].ms, gap());
    // An outside cue goes to the renderer and pauses the automatic ones.
    const ev = await api('POST', '/api/moods/event', { name: 'thunder', n: 3 });
    assert.strictEqual(ev.body.to, 'renderer');
    assert.deepStrictEqual(fake.calls.filter((c) => c.fn === 'event').pop(), { fn: 'event', name: 'thunder', n: 3 });
    timers.run();
    await sleep(20);
    assert.strictEqual(fake.calls.filter((c) => c.fn === 'event').length, 2, 'paused: nothing fired');
    assert.strictEqual(timers.list.length, 1);
    gap();
    clock += ctl.PAUSE_MS + 1;
    timers.run();
    await sleep(20);
    assert.strictEqual(fake.calls.filter((c) => c.fn === 'event').length, 3, 'fires again after 5 minutes');
    assert.strictEqual((await api('POST', '/api/moods/event', { name: 'thunder', n: 7 })).status, 400);
    assert.strictEqual(wall.posts().length, 2, 'only the underlay went to WLED: { ps: 2 } and the brightness');
  });

  await check('renderer exit marks the mood as the effects form; set and off stop the renderer and the director', async () => {
    fake.crash();
    assert.strictEqual((await nowOf()).path, 'wled-effects');
    assert.strictEqual(logs.filter((l) => l.indexOf(E.EXIT_LINE) >= 0).length, 1);
    await api('POST', '/api/moods/set', { id: 'rainforest-storm', pair: false });
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    const stops = fake.calls.filter((c) => c.fn === 'stop').length;
    await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    assert.strictEqual(fake.calls.filter((c) => c.fn === 'stop').length, stops + 1);
    assert.strictEqual(timers.list.length, 0, 'no automatic thunder for christmas');
    await api('POST', '/api/moods/off', {});
  });

  await check('engine start refused: the wall plays the effects form and the reply says so; events then go to WLED', async () => {
    wall.reset();
    timers.clear();
    refuse = true;
    const r = await api('POST', '/api/moods/set', { id: 'rainforest-storm', pair: false });
    refuse = false;
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.engine, { ok: false, why: 'test refusal' });
    assert.match(r.body.message, /effects form/);
    assert.strictEqual((await nowOf()).path, 'wled-effects');
    assert.ok(logs.some((l) => /moods: renderer refused/.test(l)));
    // Thunder now dims the Drums segment in WLED, and comes back on the timer.
    const k = wall.posts().length;
    const ev = await api('POST', '/api/moods/event', { name: 'thunder' });
    assert.strictEqual(ev.body.to, 'wall');
    const down = wall.posts()[k];
    assert.strictEqual(down.tt, 3);
    assert.deepStrictEqual(down.seg.map((s) => s.id), [1]);
    assert.ok(down.seg[0].bri < 255);
    const up = timers.list.find((t) => t.ms === ev.body.holdMs);
    assert.ok(up, 'the end of the dim waits on the hub\'s timer');
    timers.list.splice(timers.list.indexOf(up), 1);
    up.fn();
    await sleep(20);
    assert.deepStrictEqual(wall.posts()[k + 1], { tt: 9, seg: [{ id: 1, bri: 255 }] });
    assert.strictEqual((await api('POST', '/api/moods/event', { name: 'thunder', dry: true })).body.plan.wled.length, 2);
    await api('POST', '/api/moods/off', {});
    assert.strictEqual((await api('POST', '/api/moods/event', { name: 'thunder' })).status, 409, 'no mood on');
  });

  await check('the wall not answering: 502, nothing remembered, the resource says error; a refusal says so', async () => {
    wall.reset();
    wall.mode('down');
    const r = await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.result, 'failed');
    assert.match(r.body.error, /did not answer/);
    assert.strictEqual((await nowOf()).id, 'off');
    assert.strictEqual((await scr('GET', '/live/state')).body.resources.moods.data.state, 'error');
    wall.mode('failAfter:0');
    const ref = await api('POST', '/api/moods/set', { id: 'christmas', pair: false });
    assert.strictEqual(ref.status, 502);
    assert.match(ref.body.error, /refused/);
    wall.mode('ok');
    const ok = await api('POST', '/api/moods/set', { id: 'menorah', night: 8, pair: false });
    assert.strictEqual(ok.body.result, 'ok');
    assert.strictEqual((await scr('GET', '/live/state')).body.resources.moods.data.state, 'ok');
    await api('POST', '/api/moods/off', {});
  });

  await check('probe: read-only GETs, counts and mismatches; moved and missing effects change what is sent', async () => {
    wall.reset();
    wall.effects((n) => {
      const tf = n.indexOf('Twinklefox');
      n[tf] = n[tf + 1];
      n[tf + 1] = 'Twinklefox';
      n[n.indexOf('Puddlepeak')] = 'Something else';
      return n;
    });
    const r = await api('POST', '/api/moods/probe', {});
    assert.strictEqual(r.status, 200);
    assert.ok(wall.calls.every((c) => c.method === 'GET'));
    assert.deepStrictEqual(wall.calls.map((c) => c.path), ctl.PROBE_PATHS);
    assert.strictEqual(r.body.read, 5);
    assert.ok(r.body.mismatches.indexOf('effect "Twinklefox" is number 81 here, not 80') >= 0, r.body.mismatches.join(' | '));
    assert.ok(r.body.mismatches.indexOf('effect "Puddlepeak" is missing') >= 0);
    assert.strictEqual(r.body.mic, false);
    assert.strictEqual(r.body.ledMa, 55);
    assert.strictEqual(r.body.realtime, true);
    assert.strictEqual(r.body.counts.segments, 3);
    assert.strictEqual(r.body.gamma, 2.8);
    assert.deepStrictEqual(r.body.notes, []);
    assert.ok(!r.body.mismatches.some((x) => /gamma/.test(x)));
    const dry = (await api('POST', '/api/moods/set', { id: 'rainforest-night', dry: true })).body.plan.wled[0].body;
    assert.ok(dry.seg.some((s) => s.fx === 81) && !dry.seg.some((s) => s.fx === 80), 'Twinklefox by name');
    const storm = (await api('POST', '/api/moods/set', { id: 'santa', dry: true })).body.plan.wled[0].body;
    assert.ok(!storm.seg.some((s) => s.fx === 144), 'no missing mic effect is sent');
    const st = (await api('GET', '/api/moods')).body.probe;
    assert.strictEqual(st.effects, 190);
    assert.ok(hubctl.moodsProbeLines(r.body)[0].indexOf('Read 5 of 5') === 0);
    wall.reset();
  });

  await check('tune and the wall map fix (Pi-only, data/moods-wall.json)', async () => {
    const t = await api('POST', '/api/moods/tune', { id: 'rainforest', cycleSeconds: 65.5, spans: 2 });
    assert.strictEqual(t.status, 200);
    assert.ok(t.body.args.join(' ').indexOf('--cycle 65.5 --spans 2') >= 0);
    assert.deepStrictEqual(stateFile().tune.rainforest, { cycleSeconds: 65.5, spans: 2 });
    const f = (await api('POST', '/api/moods/set', { id: 'rainforest', dry: true })).body.plan.engine.args;
    assert.ok(f.join(' ').indexOf('--cycle 65.5 --spans 2') >= 0);
    assert.strictEqual((await api('POST', '/api/moods/tune', { id: 'santa', spans: 2 })).status, 400, 'only Pi-drawn moods');
    assert.strictEqual((await api('POST', '/api/moods/tune', { id: 'rainforest', gamma: 9 })).status, 400);
    await api('POST', '/api/moods/tune', { id: 'rainforest', cycleSeconds: null, spans: null });
    assert.strictEqual(stateFile().tune.rainforest, undefined);
    const w = await api('POST', '/api/moods/wall', { override: { zones: { vase1: { r: [[9, 15]], sure: true } } } });
    assert.strictEqual(w.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'moods-wall.json')));
    assert.strictEqual((await scr('GET', '/live/state')).body.resources.moods.data.wall.zones.vase1.sure, true);
    assert.strictEqual((await api('POST', '/api/moods/wall', { override: { leds: 200 } })).status, 400);
    assert.strictEqual((await api('POST', '/api/moods/wall', { override: { zones: { vase1: { r: [[150, 170]], sure: true } } } })).status, 400);
    const back = await api('POST', '/api/moods/wall', { override: null });
    assert.strictEqual(back.body.override, false);
    assert.strictEqual((await scr('GET', '/live/state')).body.resources.moods.data.wall.zones.vase1.sure, false);
  });

  await check('screen door POST /moods/set: saved ids only, never a dry run, other sites refused, rate limited', async () => {
    wall.reset();
    clock += 10000;
    const pre = await request(h.port, 'OPTIONS', '/moods/set', { headers: { Origin: ORIGIN } });
    assert.strictEqual(pre.status, 204);
    assert.match(pre.headers['access-control-allow-methods'], /POST/);
    const ok = await scr('POST', '/moods/set', { id: 'christmas', pair: false, dry: true });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.result, 'ok');
    assert.strictEqual(ok.body.now.id, 'christmas');
    assert.ok(wall.posts().length > 0, 'a screen never gets a dry run');
    clock += 10000;
    assert.strictEqual((await scr('POST', '/moods/set', { id: 'check' })).status, 400, 'the hidden check mood is not for screens');
    assert.strictEqual((await scr('POST', '/moods/set', { id: 'nope' })).status, 400);
    assert.strictEqual((await scr('POST', '/moods/set', { id: 'christmas' }, { Origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await scr('GET', '/moods/set')).status, 405);
    clock += 10000;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await scr('POST', '/moods/set', { id: 'nope' })).status);
    assert.deepStrictEqual(codes, [400, 400, 400, 429]);
    assert.ok(logs.some((l) => /moods: a screen sent commands too fast/.test(l)));
    clock += 10000;
    const off = await scr('POST', '/moods/set', { off: true });
    assert.strictEqual(off.body.result, 'ok');
    assert.strictEqual(off.body.now.id, 'off');
    wall.mode('down');
    clock += 10000;
    assert.strictEqual((await scr('POST', '/moods/set', { id: 'christmas' })).status, 502);
    wall.mode('ok');
  });

  await check('POST /api/command type mood: handled on the Pi (id, off, bri, event); never sent to screens', async () => {
    wall.reset();
    assert.deepStrictEqual(hubServer.normalizeCommand({ type: 'mood', data: { id: 'christmas', pair: false } }), { type: 'mood', data: { id: 'christmas', pair: false } });
    assert.deepStrictEqual(hubServer.normalizeCommand({ type: 'mood', data: { event: 'thunder' } }).data, { event: 'thunder' });
    assert.deepStrictEqual(hubServer.normalizeCommand({ type: 'mood', data: { bri: 60 } }).data, { bri: 60 });
    ['{}', '{"id":"Christmas"}', '{"bri":5}', '{"id":"off","bri":40}', '{"id":"x","event":"thunder"}', '{"n":2}', '{"id":"x","color":"red"}']
      .forEach((d) => assert.throws(() => hubServer.normalizeCommand({ type: 'mood', data: JSON.parse(d) }), (e) => e.status === 400, d));
    const cmd = (data) => api('POST', '/api/command', { type: 'mood', data });
    const a = await cmd({ id: 'christmas', pair: false });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(a.body.result, 'ok');
    assert.strictEqual(a.body.delivered, undefined);
    assert.strictEqual((await nowOf()).id, 'christmas');
    const b = await cmd({ bri: 60 });
    assert.strictEqual(b.body.applied, true);
    assert.strictEqual((await nowOf()).bri, 60);
    assert.strictEqual((await cmd({ event: 'thunder' })).status, 400, 'christmas has no thunder');
    assert.strictEqual((await cmd({ id: 'nope' })).status, 400);
    const o = await cmd({ id: 'off' });
    assert.strictEqual(o.body.result, 'ok');
    assert.strictEqual((await nowOf()).id, 'off');
    assert.ok(logs.some((l) => /control POST \/api\/command -> 200 mood, ok/.test(l)));
  });

  await check('./hub moods: the one line, list, texts, and a non-zero exit when a command fails (./hub ambiance too)', async () => {
    assert.ok(hubctl.WIDGETS.indexOf('moods') >= 0);
    assert.deepStrictEqual(hubServer.normalizeCommand({ type: 'show', data: { widget: 'moods' } }).data.widget, 'moods');
    const st = (await api('GET', '/api/moods')).body;
    assert.strictEqual(hubctl.moodsLine(st), 'Moods: off, the wall as it was (22 moods). Pi-drawn engine: fake, idle.');
    assert.strictEqual(hubctl.moodsLine({ now: { id: 'off' }, configured: false, moods: [] }), 'Moods: not set up (add WLED_URL to pi/.env, then restart the hub).');
    assert.strictEqual(hubctl.moodsLine(null), 'This server does not know Moods yet (it needs an update): run git pull, then restart the hub (hubup).');
    const lines = hubctl.moodsListLines(st.moods);
    assert.strictEqual(lines[0], '22 moods (id, name, group, brightness, tags):');
    assert.ok(lines.some((l) => l === '  menorah  Menorah  (wall, 100%, approx, night 1-8)'), lines.join('\n'));
    const run = (args) => new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, 'hubctl.js')].concat(args), {
        env: Object.assign({}, process.env, { HUB_URL: 'http://127.0.0.1:' + h.port, HUB_TOKEN: TOKEN, HUB_WAIT_TRIES: '0' })
      }, (e, out) => resolve({ code: e ? e.code : 0, out: String(out) }));
    });
    let r = await run(['moods']);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /^Moods: off/);
    r = await run(['ambiance', 'set', 'christmas', '--no-pair']);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.out, 'Christmas is on (effects form; lamp and bars left alone).\n');
    r = await run(['moods', 'set', 'christmas', '--dry-run']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /^Dry run, nothing sent: 1 change for the wall/);
    assert.ok(JSON.parse(r.out.split('\n').slice(1).join('\n')).wled.length === 1);
    r = await run(['moods', 'bri', '40']);
    assert.strictEqual(r.out, 'Brightness 40%.\n');
    r = await run(['moods', 'set', 'nope']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /The server said no: there is no mood with that id/);
    r = await run(['moods', 'event', 'thunder']);
    assert.strictEqual(r.code, 1, 'christmas has no thunder');
    wall.mode('down');
    r = await run(['moods', 'off']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /did not answer/);
    wall.mode('ok');
    r = await run(['moods', 'off']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out, 'The wall is back to how it was.\n');
    r = await run(['moods', 'frobnicate']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /^Use one of: moods/);
  });

  await check('mailbox: moods.status, list, set (dry and real), bri, event, probe, tune, wall, off', async () => {
    wall.reset();
    const mail = async (cmd, args) => {
      const env = mailbox.checkEnvelope('md-test-1', Buffer.from(JSON.stringify({ id: 'md-test-1', created: new Date().toISOString(), cmd, args })), Date.now());
      try {
        return await mailbox.COMMANDS[env.cmd].run(env.args, { call: async (m, r, b) => { const x = await h.api(m, r, b); if (!x.body.ok) { const e = new Error('The server said no: ' + x.body.error + '.'); e.serverSaidNo = true; throw e; } return x.body; } });
      } catch (e) { return { ok: false, message: e.message }; }
    };
    ['moods.status', 'moods.list', 'moods.set', 'moods.off', 'moods.bri', 'moods.event', 'moods.probe', 'moods.tune', 'moods.wall']
      .forEach((c) => assert.ok(mailbox.COMMANDS[c], c));
    assert.match((await mail('moods.status')).message, /^Moods: off/);
    assert.match((await mail('moods.list')).message, /^22 moods/);
    const d = await mail('moods.set', { id: 'christmas', dry: true });
    assert.strictEqual(d.data.dry, true);
    assert.strictEqual(wall.calls.length, 0);
    const s = await mail('moods.set', { id: 'christmas', pair: false });
    assert.strictEqual(s.message, 'Christmas is on (effects form; lamp and bars left alone).');
    assert.strictEqual(s.data.result, 'ok');
    assert.strictEqual((await mail('moods.bri', { pct: 60 })).message, 'Brightness 60%.');
    assert.strictEqual((await mail('moods.event', { name: 'thunder' })).ok, false);
    assert.match((await mail('moods.probe')).message, /^Read 5 of 5/);
    assert.match((await mail('moods.tune', { id: 'rainforest', spans: 2 })).message, /^Saved for rainforest: spans 2/);
    assert.match((await mail('moods.tune', { id: 'rainforest', spans: null })).message, /^Back to the defaults/);
    assert.match((await mail('moods.wall', { override: { power: { ledMa: 50 } } })).message, /^Wall map fix saved/);
    assert.match((await mail('moods.wall', { override: null })).message, /^Wall map fix removed/);
    assert.strictEqual((await mail('moods.off')).message, 'The wall is back to how it was.');
    assert.throws(() => mailbox.checkEnvelope('md-test-2', Buffer.from(JSON.stringify({ id: 'md-test-2', created: new Date().toISOString(), cmd: 'moods.set', args: { id: 'x', color: 'red' } })), Date.now()), /does not take/);
    assert.throws(() => mailbox.checkEnvelope('md-test-3', Buffer.from(JSON.stringify({ id: 'md-test-3', created: new Date().toISOString(), cmd: 'moods.bri', args: { pct: 5 } })), Date.now()), /10 to 100/);
  });

  await check('hub close() stops the renderer', async () => {
    wall.reset();
    await api('POST', '/api/moods/set', { id: 'rainforest-storm', pair: false });
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    const stops = fake.calls.filter((c) => c.fn === 'stop').length;
    await stop(h);
    assert.strictEqual(fake.calls.filter((c) => c.fn === 'stop').length, stops + 1);
    h = await startHub(dir);
    assert.strictEqual((await nowOf()).path, 'wled-effects');
    await api('POST', '/api/moods/off', {});
  });

  await check('MOODS_DRY=1: every call answers as a dry run and nothing reaches the wall', async () => {
    const d2 = tmpDir();
    const hd = await startHub(d2, { env: { MOODS_DRY: '1' } });
    wall.reset();
    const a = (m, p, b) => request(hd.port, m, p, { token: TOKEN, body: b });
    const s = await a('POST', '/api/moods/set', { id: 'christmas' });
    assert.strictEqual(s.body.dry, true);
    assert.strictEqual((await a('POST', '/api/moods/off', {})).body.dry, true);
    assert.strictEqual((await a('POST', '/api/moods/probe', {})).body.dry, true);
    assert.strictEqual((await a('GET', '/api/moods')).body.dry, true);
    assert.strictEqual((await a('GET', '/api/moods/now')).body.id, 'off');
    const t = await a('POST', '/api/moods/tune', { id: 'rainforest', spans: 2 });
    assert.strictEqual(t.body.dry, true);
    assert.ok(t.body.args.join(' ').indexOf('--spans 2') >= 0);
    assert.ok(!fs.existsSync(path.join(d2, 'moods-state.json')) || !(JSON.parse(fs.readFileSync(path.join(d2, 'moods-state.json'), 'utf8')).tune || {}).rainforest, 'tune not saved');
    const wl = await a('POST', '/api/moods/wall', { override: { zones: { vase1: { r: [[9, 15]], sure: true } } } });
    assert.strictEqual(wl.body.dry, true);
    assert.ok(!fs.existsSync(path.join(d2, 'moods-wall.json')), 'wall fix not written');
    assert.strictEqual((await a('POST', '/api/moods/wall', { override: null })).body.dry, true);
    assert.strictEqual(wall.calls.length, 0);
    await stop(hd);
  });

  await check('not set up: no WLED_URL answers 409 and the resource says notset; a bad one says so', async () => {
    const hn = await startHub(tmpDir(), { env: { WLED_URL: '' } });
    const a = (m, p, b) => request(hn.port, m, p, { token: TOKEN, body: b });
    assert.strictEqual((await a('POST', '/api/moods/set', { id: 'christmas' })).status, 409);
    const live = (await request(hn.port, 'GET', '/live/state')).body.resources.moods.data;
    assert.strictEqual(live.state, 'notset');
    assert.strictEqual(live.problem, 'nowled');
    assert.strictEqual(live.moods.length, 22, 'the drawing still has its moods');
    await stop(hn);
    const c = ctl.configFromEnv({ WLED_URL: 'ftp://nope', MOODS_ENGINE: 'Forest', MOODS_ENGINE_PORT: '5000', MOODS_DRY: '1' });
    assert.deepStrictEqual(c, { wledUrl: '', wledProblem: 'badurl', engine: 'forest', enginePort: 5000, dry: true });
    assert.strictEqual(ctl.configFromEnv({}).engine, 'none');
    assert.strictEqual(ctl.cleanResource({ rev: 4, data: { nonsense: 1 } }).data.state, 'notset');
  });

  await check('stale: Ambience\'s wall read differing from what was set marks it, only after a new read (controller)', async () => {
    wall.reset();
    let seen = { reachable: true, on: true, bri: 40 };
    let pushed = null;
    const c = ctl.createController({
      env: { WLED_URL: wall.url }, dataDir: tmpDir(), engine: E.createFakeEngine(), timers, rng: F.mulberry32(3), now: () => clock, today: () => TODAY, presetSettleMs: 0, presetPollMs: 1,
      wledSeen: () => seen, put: (d) => { pushed = d; }
    });
    assert.strictEqual(c.start().now.id, 'off');
    assert.strictEqual(pushed, null, 'start pushes nothing');
    await c.set('christmas', { bri: 60, pair: false });
    assert.strictEqual(pushed.now.stale, false, 'the old read does not count');
    seen = { reachable: true, on: true, bri: 153 };
    c.refresh();
    assert.strictEqual(pushed.now.stale, false, 'matches');
    seen = { reachable: true, on: true, bri: 90 };
    c.refresh();
    assert.strictEqual(pushed.now.stale, true, 'brightness changed elsewhere');
    seen = { reachable: true, on: false, bri: 153 };
    c.refresh();
    assert.strictEqual(pushed.now.stale, true, 'switched off elsewhere');
    seen = { reachable: false, on: false, bri: 0 };
    c.refresh();
    assert.strictEqual(pushed.now.stale, false, 'not answering is not stale');
    assert.strictEqual(c.nowFlat().stale, false);
    await c.off({});
    assert.strictEqual(wall.calls.filter((x) => x.method === 'GET').length, 2, 'the snapshot, and one read for the restored preset');
    await c.close();
  });

  /* ---------- review fixes (WP8) ---------- */

  const FAKE_URL = 'http://plant-wall.test';
  // A pretend wall in memory (no socket): records every call; answers GETs.
  function fakeWled(o) {
    const x = o || {};
    const st = { on: true, bri: 128, ps: 2, seg: mockWall.LIVE.map((s) => Object.assign({ on: true, bri: 255 }, s)) };
    const posts = [];
    const calls = [];
    const ok = (json) => Promise.resolve({ status: 200, json });
    const fw = { posts, calls, st, release: null };
    fw.request = (method, url, body) => {
      const p = url.slice(FAKE_URL.length);
      calls.push({ method, path: p, body });
      if (method === 'POST') {
        posts.push(body);
        if (Number.isInteger(body.ps)) st.ps = body.ps;
        if (Array.isArray(body.seg) && body.seg.length) st.ps = -1;
        if (typeof body.bri === 'number') st.bri = body.bri;
        return ok({ success: true });
      }
      if (p === '/json/state' && x.hang && !fw.released) return new Promise((resolve) => { fw.release = () => { fw.released = true; resolve({ status: 200, json: copy(st) }); }; });
      if (p === '/json/state') return ok(copy(st));
      if (p === '/json/cfg') return ok(x.cfg || { hw: { led: { maxpwr: 1000, ledma: 55 } }, light: { gc: { col: 2.8 } }, if: { live: { en: true } } });
      if (p === '/json/info') return ok({ ver: '16.0.1', leds: { count: 164 } });
      return Promise.resolve({ status: 404, json: null });
    };
    return fw;
  }
  const fakeCtl = (fw, extra) => ctl.createController(Object.assign({
    env: { WLED_URL: FAKE_URL }, dataDir: tmpDir(), engine: E.createFakeEngine(), timers: fakeTimers(), rng: F.mulberry32(5),
    now: () => clock, today: () => TODAY, request: fw.request, presetSettleMs: 0, presetPollMs: 1, log: (l) => logs.push(String(l))
  }, extra || {}));

  await check('brightness never tops the power budget: every mood set and dimmed at 10, 50 and 100%; the hidden check mood takes none', async () => {
    const fw = fakeWled();
    const c = fakeCtl(fw);
    c.start();
    const budget = cat.wall.power.budgetMa;
    const ctxFor = (m) => baseCtx(m, { presetBri: 128 }); // the wall's brightness when the snapshot was taken
    let n = 0;
    for (const m of C.visibleMoods(cat.catalog)) {
      for (const pct of [10, 50, 100]) {
        const k = fw.posts.length;
        await c.set(m.id, { bri: pct, pair: false });
        const setBodies = fw.posts.slice(k);
        assert.ok(W.budgetMa(setBodies, ctxFor(m)) <= budget + 0.5, m.id + ' set at ' + pct + '%');
        for (const p2 of [10, 50, 100]) {
          const j = fw.posts.length;
          const r = await c.bri(p2);
          assert.strictEqual(r.applied, true);
          const sent = fw.posts.slice(j);
          assert.deepStrictEqual(sent.map((b) => Object.keys(b)), [['bri']], m.id + ': only the master brightness');
          const ma = W.budgetMa(setBodies.concat(sent), ctxFor(m));
          assert.ok(ma <= budget + 0.5, m.id + ' set ' + pct + '%, then ' + p2 + '%: ' + Math.round(ma) + ' mA');
          n++;
        }
      }
    }
    assert.strictEqual(n, 22 * 9);
    await c.set('check', { pair: false });
    assert.ok(W.budgetMa(fw.posts.slice(-1), baseCtx()) <= budget + 0.5);
    const k = fw.posts.length;
    for (const p of [10, 50, 100]) {
      await assert.rejects(c.bri(p), (e) => e.status === 400 && /no brightness control/.test(e.message));
      await assert.rejects(c.bri(p, 'check'), (e) => e.status === 400);
    }
    assert.strictEqual(fw.posts.length, k, 'nothing sent for the check mood');
    await c.close();
  });

  await check('probe: a low bulb current never loosens the budget; the colour gamma is read, compared and its assumption stated', async () => {
    const fw = fakeWled({ cfg: { hw: { led: { maxpwr: 1000, ledma: 30 } }, light: { gc: { bri: 1, col: 2.2, val: 2.2 } }, if: { live: { en: true } } } });
    const c = fakeCtl(fw);
    const r = await c.probe({});
    assert.strictEqual(r.ledMa, 30);
    assert.strictEqual(r.budgetLedMa, 55);
    assert.ok(r.mismatches.some((x) => /bulb current is 30 mA.*budget keeps 55/.test(x)), r.mismatches.join(' | '));
    assert.strictEqual(r.gamma, 2.2);
    assert.ok(r.mismatches.indexOf('the colour gamma is 2.2, the power estimate assumes 2.8') >= 0, r.mismatches.join(' | '));
    assert.deepStrictEqual(r.notes, []);
    const plan = (await c.set('christmas', { dry: true })).plan;
    assert.deepStrictEqual(plan.budget, W.compileWled(moodBy('christmas'), baseCtx(null, { briPct: 100 })).budget, 'budgeted at the map\'s 55 mA');
    assert.ok(hubctl.moodsProbeLines(r)[0].indexOf('colour gamma 2.2') > 0);
    const cases = [[{ hw: {} }, null], [{ light: { gc: { col: true, val: 2.8 } } }, 2.8], [{ light: { gc: { col: 1 } } }, 1], [{ light: { gc: { col: 2.8 } } }, 2.8]];
    for (const [cfg, want] of cases) {
      const f2 = fakeWled({ cfg });
      const r2 = await fakeCtl(f2).probe({});
      assert.strictEqual(r2.gamma, want, JSON.stringify(cfg));
      const gm = r2.mismatches.filter((x) => /gamma/.test(x));
      if (want === null) {
        assert.ok(/colour gamma not read: 2.8/.test(r2.notes[0]), JSON.stringify(r2.notes));
        assert.ok(hubctl.moodsProbeLines(r2).some((l) => /^Note: colour gamma not read/.test(l)));
      } else if (want === 1) assert.deepStrictEqual(gm, ['the colour gamma is off, the power estimate assumes 2.8']);
      else assert.deepStrictEqual(gm, []);
    }
    await c.close();
  });

  await check('Menorah from a screen: tonight\'s night (2026-12-07 = night 4), a stepped night kept by brightness and pairing, list follows the day', async () => {
    let day = { y: 2026, m: 12, d: 7 };
    const fw = fakeWled();
    const c = fakeCtl(fw, { today: () => day });
    c.start();
    const menorahIn = () => c.resource().moods.find((m) => m.id === 'menorah');
    assert.strictEqual(menorahIn().param.night.tonight, 4);
    let a = await c.screenSet({ id: 'menorah' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(c.nowFlat().night, 4);
    assert.deepStrictEqual(fw.posts.slice(-1), W.compileWled(moodBy('menorah'), baseCtx(null, { date: day, briPct: 100, night: 4 })).bodies);
    a = await c.screenSet({ id: 'menorah', night: 6 });
    assert.strictEqual(c.nowFlat().night, 6);
    let k = fw.posts.length;
    a = await c.screenSet({ id: 'menorah', bri: 50 });
    assert.strictEqual(a.body.applied, true);
    assert.deepStrictEqual(fw.posts.slice(k), [{ bri: 128 }], 'brightness only: not the mood again');
    assert.strictEqual(c.nowFlat().night, 6);
    k = fw.posts.length;
    a = await c.screenSet({ id: 'menorah', pair: false });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(fw.posts.length, k, 'pairing only: nothing to the wall');
    await c.screenSet({ id: 'menorah' });
    assert.strictEqual(c.nowFlat().night, 6, 'picked again with no night: the night on now');
    assert.strictEqual(c.nowFlat().bri, 50);
    day = { y: 2026, m: 12, d: 8 };
    assert.strictEqual(menorahIn().param.night.tonight, 5, 'the list is built again for the new day');
    await c.screenSet({ off: true });
    await c.screenSet({ id: 'menorah' });
    assert.strictEqual(c.nowFlat().night, 5);
    day = { y: 2026, m: 12, d: 20 };
    await c.screenSet({ id: 'christmas' });
    await c.screenSet({ id: 'menorah' });
    assert.strictEqual(c.nowFlat().night, 8, 'outside Hanukkah: all eight');
    assert.strictEqual((await c.screenSet({ bri: 40 })).body.applied, true, '{ bri } alone: the mood on now');
    await c.screenSet({ off: true });
    assert.strictEqual((await c.screenSet({ bri: 40 })).status, 409);
    await c.close();
  });

  await check('screen brightness and pairing for the mood on now: no resend, the renderer keeps running', async () => {
    wall.reset();
    timers.clear();
    clock += 10000;
    let r = await scr('POST', '/moods/set', { id: 'rainforest-storm', pair: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    fake.calls.length = 0;
    const dir0 = timers.list.length;
    let k = wall.posts().length;
    clock += 10000;
    r = await scr('POST', '/moods/set', { id: 'rainforest-storm', bri: 40 });
    assert.strictEqual(r.body.applied, true);
    assert.deepStrictEqual(posts(k)(wall).map((b) => Object.keys(b)), [['bri']]);
    k = wall.posts().length;
    clock += 10000;
    r = await scr('POST', '/moods/set', { id: 'rainforest-storm', pair: true });
    assert.strictEqual(r.body.govee, 'set');
    assert.strictEqual(wall.posts().length, k, 'nothing to the wall');
    assert.strictEqual((await lightsSt()).settings.look, 'rainforest');
    assert.strictEqual((await nowOf()).pair, true);
    assert.deepStrictEqual(fake.calls.filter((c) => c.fn === 'start' || c.fn === 'stop'), [], 'the renderer was not restarted');
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    assert.strictEqual(timers.list.length, dir0, 'the director was not restarted');
    clock += 10000;
    r = await scr('POST', '/moods/set', { id: 'christmas', bri: 30, pair: false });
    assert.strictEqual((await nowOf()).id, 'christmas', 'another mood with a brightness is a full set');
    clock += 10000;
    await scr('POST', '/moods/set', { off: true });
  });

  await check('a failed set or Off after the renderer stopped: the path says effects form, not Pi-drawn', async () => {
    wall.reset();
    timers.clear();
    await api('POST', '/api/moods/set', { id: 'rainforest-storm', pair: false });
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    wall.mode('down');
    assert.strictEqual((await api('POST', '/api/moods/set', { id: 'christmas', pair: false })).status, 502);
    let n = await nowOf();
    assert.strictEqual(n.id, 'rainforest-storm');
    assert.strictEqual(n.path, 'wled-effects');
    wall.mode('ok');
    await api('POST', '/api/moods/set', { id: 'rainforest-storm', pair: false });
    assert.strictEqual((await nowOf()).path, 'pi-drawn');
    wall.mode('down');
    assert.strictEqual((await api('POST', '/api/moods/off', {})).status, 502);
    n = await nowOf();
    assert.strictEqual(n.path, 'wled-effects');
    assert.strictEqual(stateFile().current.path, 'wled-effects');
    wall.mode('ok');
    await api('POST', '/api/moods/off', {});
  });

  await check('preset race: after { ps } the hub waits for the wall to report the preset before the next body (mock wall lands presets late)', async () => {
    wall.reset();
    wall.presetLag(80);
    // The race is real: sent back to back, the late preset wins over the next body.
    await ctl.request('POST', wall.url + '/json/state', { on: true, ps: 2 });
    await ctl.request('POST', wall.url + '/json/state', { on: false, bri: 40 });
    await sleep(160);
    assert.strictEqual(wall.state().on, true, 'without a wait the preset lands over the brightness');
    wall.reset();
    wall.presetLag(80);
    wall.set({ on: false, bri: 40 });
    const c = ctl.createController({
      env: { WLED_URL: wall.url }, dataDir: tmpDir(), engine: E.createFakeEngine(), rng: F.mulberry32(3), now: () => clock, today: () => TODAY,
      presetSettleMs: 20, presetPollMs: 10, log: (l) => logs.push(String(l))
    });
    await c.set('christmas', { pair: false }); // segments: the wall leaves its preset (ps -1)
    let k = wall.calls.length;
    await c.set('rainforest', { bri: 60, pair: false });
    let seq = wall.calls.slice(k).map((x) => x.method + (x.body && x.body.ps ? ' ps' : x.body && x.body.bri !== undefined ? ' bri' : ''));
    assert.ok(seq.indexOf('POST ps') >= 0 && seq.indexOf('GET') > seq.indexOf('POST ps') && seq.lastIndexOf('POST bri') > seq.indexOf('GET'), seq.join(', '));
    await sleep(150);
    const cap = wall.posts().filter((b) => b.bri !== undefined && b.ps === undefined && !b.seg).pop().bri;
    assert.strictEqual(wall.state().bri, cap, 'the cap stands: it came after the preset landed');
    assert.strictEqual(wall.state().ps, 2);
    await c.set('christmas', { pair: false });
    k = wall.calls.length;
    await c.off({});
    seq = wall.calls.slice(k).map((x) => x.method + (x.body && x.body.ps ? ' ps' : ''));
    assert.ok(seq.indexOf('GET') > seq.indexOf('POST ps'), seq.join(', '));
    await sleep(150);
    const s = wall.state();
    assert.strictEqual(s.on, false, 'Off put back "off", after the preset landed');
    assert.strictEqual(s.bri, 40);
    await c.close();
    wall.reset();
  });

  await check('close(): a set waiting on the wall or on the renderer\'s lead stops there (no renderer, no director, no timers left)', async () => {
    const fw = fakeWled({ hang: true });
    let eng = null;
    const c = fakeCtl(fw, { engine: (hk) => { eng = E.createFakeEngine({ log: hk.log, onExit: hk.onExit }); return eng; } });
    const p = c.set('rainforest-storm', { pair: false });
    await sleep(10);
    assert.ok(fw.release, 'the snapshot read is waiting');
    await c.close();
    fw.release();
    await assert.rejects(p, (e) => e.status === 503);
    assert.deepStrictEqual(fw.posts, [], 'nothing sent after close');
    assert.ok(!eng.calls.some((x) => x.fn === 'start'));
    assert.strictEqual(c.debug().director, 0);
    // Closed during the 300 ms lead before the renderer starts.
    const held = [];
    const hold = { setTimeout: (fn, ms) => { if (ms === ctl.ENGINE_LEAD_MS) { const h = { fn }; held.push(h); return h; } return setTimeout(fn, 0); }, clearTimeout: (h) => { if (h && !h.fn) clearTimeout(h); } };
    const fw2 = fakeWled();
    let eng2 = null;
    const c2 = fakeCtl(fw2, { timers: hold, engine: (hk) => { eng2 = E.createFakeEngine({ log: hk.log, onExit: hk.onExit }); return eng2; } });
    const p2 = c2.set('rainforest-storm', { pair: false });
    for (let i = 0; i < 50 && !held.length; i++) await sleep(2);
    assert.strictEqual(held.length, 1, 'waiting on the lead');
    await c2.close();
    await assert.rejects(p2, (e) => e.status === 503);
    assert.ok(!eng2.calls.some((x) => x.fn === 'start'), 'the renderer never starts after close');
    assert.strictEqual(c2.debug().director, 0);
  });

  await check('wall map fix through the API: limiter and base refused, a looser budget kept at the file\'s, prototype keys refused', async () => {
    assert.strictEqual((await api('POST', '/api/moods/wall', { override: { power: { limiterMa: 2000 } } })).status, 400);
    assert.strictEqual((await api('POST', '/api/moods/wall', { override: { power: { baseMa: 10 } } })).status, 400);
    const r = await api('POST', '/api/moods/wall', { override: { power: { budgetMa: 950, flashMa: 400, ledMa: 20 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.clamped, ['budgetMa 800', 'flashMa 250', 'ledMa 55']);
    assert.match(hubctl.moodsWallText(r.body), /Kept at the file's values .*budgetMa 800/);
    const plan = (await api('POST', '/api/moods/set', { id: 'christmas', dry: true })).body.plan;
    assert.ok(plan.budget.ma <= 800);
    const proto = await request(h.port, 'POST', '/api/moods/wall', { token: TOKEN, body: JSON.parse('{"override":{"zones":{"__proto__":{"r":[[0,1]],"sure":true}}}}') });
    assert.strictEqual(proto.status, 400);
    assert.match(proto.body.error, /not allowed/);
    await api('POST', '/api/moods/wall', { override: null });
  });

  await check('./hub moods texts: refused vs did not answer; a dry run with failed checks counts as a failure', () => {
    const base = { configured: true, moods: [], now: { id: 'off' }, state: 'error' };
    assert.match(hubctl.moodsLine(Object.assign({ problem: 'refused' }, base)), /Last change: the wall refused it\.$/);
    assert.match(hubctl.moodsLine(Object.assign({ problem: 'noanswer' }, base)), /Last change: the wall did not answer\.$/);
    assert.strictEqual(hubctl.moodsDryFailed({ dry: true, ok: false, plan: { checks: ['segment 4: id repeats'] } }), true);
    assert.strictEqual(hubctl.moodsDryFailed({ dry: true, ok: true, plan: { checks: [] } }), false);
    assert.strictEqual(hubctl.moodsDryFailed({ result: 'ok' }), false);
    assert.match(hubctl.moodsTuneText({ dry: true, id: 'rainforest', tune: { spans: 2 } }), /^Dry run, nothing saved/);
  });

  await check('logs: every Moods line starts "moods:" and holds no address, token, mood name or id', () => {
    const strip = (l) => l.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, '');
    const lines = logs.map(strip);
    const mine = lines.filter((l) => /mood/i.test(l) && !/^control /.test(l));
    assert.ok(mine.length > 10, mine.length + ' lines');
    mine.forEach((l) => assert.ok(/^moods: /.test(l), l));
    const words = [];
    cat.catalog.moods.filter((m) => m.id !== 'check').forEach((m) => { words.push(m.id, m.name); });
    lines.forEach((l) => {
      assert.ok(l.indexOf(String(wall.port)) < 0 || /listening on port/.test(l), l);
      assert.ok(l.indexOf(TOKEN) < 0, l);
      words.forEach((w) => assert.ok(!new RegExp('\\b' + w.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(l), w + ' in: ' + l));
    });
  });

  await stop(h);
  await wall.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('FAIL (crash) ' + (e && e.stack)); process.exit(1); });
