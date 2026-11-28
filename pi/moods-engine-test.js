/*
 * Tests for the Moods engine adapter (pi/moods/engine.js) and the vendored
 * renderer (pi/moods/forest-render.js, pi/moods/forest-render-test.js).
 * Run from the repo root with:
 *
 *   node pi/moods-engine-test.js
 *
 * Fake spawn, fake UDP and fake timers for the adapter; one real run of the
 * vendored script with --dry-run on loopback (it never touches WLED: a sink on
 * 127.0.0.1 checks nothing arrives). Ports are picked free at run time. No clock
 * times, no time zone. Prints one line per check, then "N passed, M failed".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const cp = require('child_process');
const { EventEmitter } = require('events');
const E = require('./moods/engine.js');
const F = require('./moods/forest-render.js');

const SCRIPT = path.join(__dirname, 'moods', 'forest-render.js');
const VENDOR_TEST = path.join(__dirname, 'moods', 'forest-render-test.js');
// Pinned: copied byte for byte from the Pi-render thread. A new version there: copy again, update both.
const SHA_SCRIPT = '37f5fd236d239931eace7dd7e38cc507bb524467a365814448120b6381750928';
const SHA_TEST = 'ac27dae557452e100375cec3a368e0a7f216a2fa93e0608c7266a8edbc58f671';
const HOST = 'wall-test.invalid:81';

const checks = [];
let passed = 0;
let failed = 0;
function check(name, fn) { checks.push({ name, fn }); }

// ---------- fixtures ----------

function rainforestPlan() {
  return {
    v: 1, id: 'rainforest', engine: 'forest', leds: 164, fps: 30, maxMa: 800,
    palette: F.PALETTE_HEX.slice(), drift: { cycleSeconds: null, spans: 1 }, groups: 1,
    sections: F.WALL.sections.map((s) => ({ start: s.start, end: s.end, dim: s.dim.slice() })),
    black: [[162, 163]],
    layers: [{ kind: 'palette', ranges: [[0, 49], [50, 111], [112, 161]] }],
    events: {},
  };
}
function stormPlan() {
  const p = rainforestPlan();
  p.id = 'rainforest-storm';
  p.events = { thunder: { kind: 'dim', size: [2, 4], depth: [0.5, 0.75], attack: 0.25, hold: [1, 2.5], release: 0.9, floor: 0.15 } };
  return p;
}

function fakeTimers() {
  let t = 0;
  let seq = 0;
  const list = [];
  return {
    setTimeout(fn, ms) { const h = { id: ++seq, at: t + ms, fn }; list.push(h); return h; },
    clearTimeout(h) { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        list.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!list.length || list[0].at > end) break;
        const h = list.shift();
        t = h.at;
        h.fn();
      }
      t = end;
    },
    pending() { return list.length; },
  };
}

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.kills = [];
  c.kill = (sig) => { c.kills.push(sig); return true; };
  c.out = (line) => c.stdout.emit('data', line + '\n');
  c.err = (line) => c.stderr.emit('data', line + '\n');
  c.exit = (code, signal) => { c.exitCode = code; c.signalCode = signal || null; c.emit('exit', code, signal || null); };
  return c;
}

function rig(extra) {
  const timers = fakeTimers();
  const logs = [];
  const sends = [];
  const spawns = [];
  const exits = [];
  let child = null;
  const eng = E.createEngine(Object.assign({
    kind: 'forest', wledHost: HOST, controlPort: 4999, timers,
    log: (m) => logs.push(m), now: () => 1234,
    udp: (text, port, address) => { sends.push([text, port, address]); return Promise.resolve(); },
    spawn: (cmd, args, opts) => { child = fakeChild(); spawns.push({ cmd, args, opts, child }); return child; },
    onExit: (info) => exits.push(info),
  }, extra || {}));
  return { eng, timers, logs, sends, spawns, exits, child: () => child };
}

const STREAM_LINE = F.streamingLine(30, 65.5, 2.8, 0.4245, 799);
const tick = () => new Promise((r) => setImmediate(r));

async function startRunning(r, plan, tune) {
  const p = r.eng.start(plan || stormPlan(), tune);
  await tick();
  r.child().out('forest-render: dry run, nothing is sent');
  r.child().out(STREAM_LINE);
  return p;
}

// ---------- vendoring ----------

check('vendored script and test match their SHA-256 pins', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.strictEqual(sha(SCRIPT), SHA_SCRIPT, 'pi/moods/forest-render.js changed');
  assert.strictEqual(sha(VENDOR_TEST), SHA_TEST, 'pi/moods/forest-render-test.js changed');
});

check('pi/forest-render-test.js is a one-line shim to the vendored test', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forest-render-test.js'), 'utf8');
  assert.strictEqual(src.trim(), "require('./moods/forest-render-test.js');");
});

check('the script exports what the adapter reads', () => {
  for (const k of ['WALL', 'PALETTE_HEX', 'BASE_MA', 'DEFAULTS', 'ATTACK', 'RELEASE', 'DIM_FLOOR', 'STOPPED_LINE',
    'parseArgs', 'parseHost', 'streamingLine', 'thunderLine', 'parseTrigger', 'renderFrame', 'buildFramePacket']) {
    assert.ok(k in F, k);
  }
  assert.strictEqual(F.LED_COUNT, 164);
  assert.strictEqual(F.BASE_MA, 264);
  assert.strictEqual(F.DEFAULTS.controlPort, E.DEFAULT_PORT);
  // the script reads its host from WLED_HOST (the adapter relies on it)
  assert.deepStrictEqual(F.parseArgs([], { WLED_HOST: 'wall.local' }).opts.host, { hostname: 'wall.local', port: 80 });
  // the streaming line the adapter parses is the one the script prints
  const m = E.STREAMING_RE.exec(STREAM_LINE);
  assert.deepStrictEqual(m.slice(1).map(Number), [164, 30, 65.5, 2.8, 0.42, 799]);
});

// ---------- can, argsFor ----------

check('can(): true only for the forest plans', () => {
  const eng = rig().eng;
  assert.deepStrictEqual(eng.can(rainforestPlan()), { ok: true, why: '' });
  assert.deepStrictEqual(eng.can(stormPlan()), { ok: true, why: '' });
  const lower = rainforestPlan(); lower.palette = lower.palette.map((h) => '#' + h.toLowerCase());
  assert.strictEqual(eng.can(lower).ok, true, 'hex case and # do not matter');
  const bad = [
    [null, /no plan/],
    [Object.assign(rainforestPlan(), { v: 2 }), /version/],
    [Object.assign(rainforestPlan(), { engine: 'mood' }), /another engine/],
    [Object.assign(rainforestPlan(), { leds: 150 }), /LED count/],
    [Object.assign(rainforestPlan(), { palette: ['ff0500', 'c43902', '067e02', '1d3fc0'] }), /palette/],
    [(() => { const p = rainforestPlan(); p.palette[3] = '006401'; return p; })(), /palette/],
    [(() => { const p = rainforestPlan(); p.sections[1].dim = [60, 111]; return p; })(), /sections/],
    [(() => { const p = rainforestPlan(); p.sections.pop(); return p; })(), /sections/],
    [(() => { const p = rainforestPlan(); p.layers.push({ kind: 'sparkle', ranges: [[29, 49]] }); return p; })(), /layers/],
    [(() => { const p = rainforestPlan(); p.events = { lightning: {} }; return p; })(), /other than thunder/],
    [(() => { const p = stormPlan(); p.events.thunder.depth = [0.2, 0.4]; return p; })(), /depth/],
    [(() => { const p = stormPlan(); p.events.thunder.attack = 1; return p; })(), /attack/],
    [Object.assign(rainforestPlan(), { fps: 90 }), /setting refused: --fps/],
    [Object.assign(rainforestPlan(), { maxMa: 1500 }), /setting refused: --max-ma/],
  ];
  for (const [plan, re] of bad) {
    const r = eng.can(plan);
    assert.strictEqual(r.ok, false, JSON.stringify(plan && plan.id));
    assert.match(r.why, re);
  }
  assert.deepStrictEqual(E.createEngine({ kind: 'none' }).can(stormPlan()), { ok: false, why: 'engine off' });
  assert.strictEqual(E.createEngine({ kind: 'nonsense' }).kind, 'none');
});

check('argsFor: exact flags, --no-preset always, no --cycle when null, never --auto or the host', () => {
  const eng = rig().eng;
  assert.deepStrictEqual(eng.argsFor(stormPlan()),
    ['--no-preset', '--fps', '30', '--spans', '1', '--groups', '1', '--max-ma', '800', '--control-port', '4999']);
  const p = stormPlan(); p.drift = { cycleSeconds: 40, spans: 2 };
  assert.deepStrictEqual(eng.argsFor(p),
    ['--no-preset', '--fps', '30', '--cycle', '40', '--spans', '2', '--groups', '1', '--max-ma', '800', '--control-port', '4999']);
  // tune wins; cycleSeconds null in the tune means "read preset 2"
  assert.deepStrictEqual(eng.argsFor(p, { cycleSeconds: null, spans: 1.5, gamma: 'off' }),
    ['--no-preset', '--fps', '30', '--spans', '1.5', '--groups', '1', '--max-ma', '800', '--gamma', 'off', '--control-port', '4999']);
  assert.deepStrictEqual(eng.argsFor(stormPlan(), { cycleSeconds: 65.5, gamma: 2.2, seed: 7 }),
    ['--no-preset', '--fps', '30', '--cycle', '65.5', '--spans', '1', '--groups', '1', '--max-ma', '800', '--gamma', '2.2', '--control-port', '4999', '--seed', '7']);
  // pure: same in, same out, inputs untouched
  const before = JSON.stringify(p);
  assert.deepStrictEqual(eng.argsFor(p), eng.argsFor(p));
  assert.strictEqual(JSON.stringify(p), before);
  for (const plan of [rainforestPlan(), stormPlan(), p]) {
    const a = eng.argsFor(plan, { cycleSeconds: 30 });
    assert.ok(a.indexOf('--no-preset') === 0);
    assert.ok(a.indexOf('--auto') < 0 && a.indexOf('--host') < 0);
    assert.ok(JSON.stringify(a).indexOf('wall-test') < 0);
    assert.ok(F.parseArgs(a.concat(['--dry-run']), {}).ok, 'the script accepts them');
  }
  // the default port is the script's
  assert.ok(E.createEngine({ kind: 'forest' }).argsFor(stormPlan()).join(' ').indexOf('--control-port 4810') > 0);
});

check('hostFromUrl: host[:port] from WLED_URL, null when not usable', () => {
  assert.strictEqual(E.hostFromUrl('http://wall.local/'), 'wall.local');
  assert.strictEqual(E.hostFromUrl('http://10.0.0.5:8080'), '10.0.0.5:8080');
  assert.strictEqual(E.hostFromUrl('https://wall.local'), null);
  assert.strictEqual(E.hostFromUrl('http://[::1]/'), null);
  assert.strictEqual(E.hostFromUrl(''), null);
  assert.strictEqual(E.hostFromUrl('not a url'), null);
});

// ---------- start, event, stop with fakes ----------

check('start: spawns the script with the flags, host only in WLED_HOST; streaming line fills status()', async () => {
  const r = rig();
  assert.strictEqual(r.eng.status().running, false);
  const res = await startRunning(r);
  assert.deepStrictEqual(res, { ok: true, why: '' });
  assert.strictEqual(r.spawns.length, 1);
  const s = r.spawns[0];
  assert.strictEqual(s.cmd, process.execPath);
  assert.strictEqual(s.args[0], SCRIPT);
  assert.deepStrictEqual(s.args.slice(1), r.eng.argsFor(stormPlan()));
  assert.ok(JSON.stringify(s.args).indexOf('wall-test') < 0);
  assert.strictEqual(s.opts.env.WLED_HOST, HOST);
  assert.deepStrictEqual(Object.keys(s.opts.env).sort(), ['PATH', 'WLED_HOST'], 'no hub secrets passed on');
  const st = r.eng.status();
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.id, 'rainforest-storm');
  assert.strictEqual(st.since, 1234);
  assert.strictEqual(st.fps, 30); assert.strictEqual(st.cycle, 65.5); assert.strictEqual(st.gamma, 2.8);
  assert.strictEqual(st.scale, 0.42); assert.strictEqual(st.estMa, 799);
  assert.match(st.lastLine, /^streaming 164 LEDs/);
  r.child().out(F.thunderLine({ first: 73, last: 75, depth: 0.62, hold: 1.8 }));
  assert.strictEqual(r.eng.status().lastLine, 'thunder, LEDs 73-75 down 62% for 1.8 s');
  assert.ok(JSON.stringify(r.eng.status()).indexOf('wall-test') < 0);
});

check('event: "thunder n" to 127.0.0.1 on the control port; bad counts and names refused', async () => {
  const r = rig();
  assert.deepStrictEqual(await r.eng.event('thunder', 3), { ok: false, why: 'renderer not running' });
  await startRunning(r);
  assert.deepStrictEqual(await r.eng.event('thunder', 3), { ok: true });
  assert.deepStrictEqual(await r.eng.event('thunder'), { ok: true });
  assert.deepStrictEqual(r.sends, [['thunder 3', 4999, '127.0.0.1'], ['thunder 1', 4999, '127.0.0.1']]);
  for (const n of [0, 7, 2.5, -1, '3']) assert.strictEqual((await r.eng.event('thunder', n)).ok, false, String(n));
  assert.deepStrictEqual(await r.eng.event('rain', 1), { ok: false, why: 'unknown event' });
  assert.strictEqual(r.sends.length, 2);
  // a send that fails answers ok: false
  const r2 = rig({ udp: () => Promise.reject(new Error('x')) });
  await startRunning(r2);
  assert.deepStrictEqual(await r2.eng.event('thunder', 1), { ok: false, why: 'cue not sent' });
  // control port busy: cues refused, streaming carries on
  const r3 = rig();
  await startRunning(r3);
  r3.child().out('forest-render: control port busy, carrying on without it');
  assert.deepStrictEqual(await r3.eng.event('thunder', 1), { ok: false, why: 'control port busy' });
  assert.strictEqual(r3.eng.status().running, true);
});

check('stop: quit, then SIGTERM at 700 ms, SIGKILL at 2 s (fake timers)', async () => {
  const r = rig();
  await startRunning(r);
  const c = r.child();
  let done = null;
  r.eng.stop().then((v) => { done = v; });
  await tick();
  assert.deepStrictEqual(r.sends, [['quit', 4999, '127.0.0.1']]);
  assert.strictEqual(r.eng.status().state, 'stopping');
  r.timers.advance(699);
  assert.deepStrictEqual(c.kills, []);
  r.timers.advance(1);
  assert.deepStrictEqual(c.kills, ['SIGTERM']);
  r.timers.advance(1299);
  assert.deepStrictEqual(c.kills, ['SIGTERM']);
  r.timers.advance(1);
  assert.deepStrictEqual(c.kills, ['SIGTERM', 'SIGKILL']);
  c.exit(null, 'SIGKILL');
  await tick();
  assert.deepStrictEqual(done, { ok: true });
  assert.strictEqual(r.eng.status().running, false);
  assert.strictEqual(r.timers.pending(), 0);
  assert.deepStrictEqual(r.exits, [], 'an asked-for stop is not an unexpected exit');
  assert.ok(r.logs.indexOf(E.EXIT_LINE) < 0);
});

check('stop: a clean quit needs no signal; stop twice shares one stop; stop when idle is ok', async () => {
  const r = rig();
  assert.deepStrictEqual(await r.eng.stop(), { ok: true });
  await startRunning(r);
  const c = r.child();
  const a = r.eng.stop();
  const b = r.eng.stop();
  assert.strictEqual(a, b);
  await tick();
  c.out(F.STOPPED_LINE);
  c.exit(0, null);
  assert.deepStrictEqual(await a, { ok: true });
  r.timers.advance(5000);
  assert.deepStrictEqual(c.kills, []);
  assert.strictEqual(r.sends.filter((s) => s[0] === 'quit').length, 1);
  assert.strictEqual(r.eng.status().lastLine, 'stopped, WLED back on its own');
});

check('stop: a child that never exits gives up at 3 s with ok: false', async () => {
  const r = rig();
  await startRunning(r);
  let done = null;
  r.eng.stop().then((v) => { done = v; });
  await tick();
  r.timers.advance(3000);
  await tick();
  assert.deepStrictEqual(done, { ok: false, why: 'renderer did not exit' });
  assert.ok(r.logs.indexOf('moods: renderer did not exit') >= 0);
});

check('start fails with the script\'s reason when it exits before streaming', async () => {
  const r = rig();
  const p = r.eng.start(stormPlan());
  await tick();
  r.child().out('forest-render: WLED did not answer, nothing sent');
  r.child().exit(1, null);
  assert.deepStrictEqual(await p, { ok: false, why: 'WLED did not answer, nothing sent' });
  assert.strictEqual(r.eng.status().running, false);
  assert.deepStrictEqual(r.exits, []);
  // exit 2 (refused flags): the first error line is the reason
  const r2 = rig();
  const p2 = r2.eng.start(stormPlan());
  await tick();
  r2.child().err('forest-render: unknown flag --x');
  r2.child().err('usage: node forest-render.js --host <ip[:port]> ...');
  r2.child().exit(2, null);
  assert.deepStrictEqual(await p2, { ok: false, why: 'unknown flag --x' });
  // spawn error (no node binary, say)
  const r3 = rig();
  const p3 = r3.eng.start(stormPlan());
  await tick();
  r3.child().emit('error', new Error('ENOENT'));
  assert.deepStrictEqual(await p3, { ok: false, why: 'could not start the renderer' });
});

check('start refused before spawning: engine off, no host, bad host, plan not drawable, bad tune', async () => {
  assert.deepStrictEqual(await E.createEngine({ kind: 'none' }).start(stormPlan()), { ok: false, why: 'engine off' });
  const r1 = rig({ wledHost: '' });
  assert.deepStrictEqual(await r1.eng.start(stormPlan()), { ok: false, why: 'no WLED host' });
  const r2 = rig({ wledHost: 'http://x/' });
  assert.deepStrictEqual(await r2.eng.start(stormPlan()), { ok: false, why: 'WLED host not usable' });
  const r3 = rig();
  const p = stormPlan(); p.palette = ['ff0000'];
  assert.strictEqual((await r3.eng.start(p)).ok, false);
  assert.match((await r3.eng.start(stormPlan(), { spans: 99 })).why, /setting refused: --spans/);
  assert.match((await r3.eng.start(stormPlan(), { cycleSeconds: 0.5 })).why, /setting refused: --cycle/);
  for (const x of [r1, r2, r3]) assert.strictEqual(x.spawns.length, 0);
});

check('start times out at 20 s with no streaming line, and stops the child', async () => {
  const r = rig();
  let res = null;
  r.eng.start(stormPlan()).then((v) => { res = v; });
  await tick();
  r.timers.advance(E.START_TIMEOUT_MS - 1);
  await tick();
  assert.strictEqual(res, null);
  r.timers.advance(1);
  await tick();
  assert.deepStrictEqual(res, { ok: false, why: 'renderer did not start in time' });
  assert.deepStrictEqual(r.sends, [['quit', 4999, '127.0.0.1']]);
  r.child().exit(0, null);
  await tick();
  assert.strictEqual(r.eng.status().state, 'off');
});

check('stop during start: start fails, no unexpected-exit line', async () => {
  const r = rig();
  const p = r.eng.start(stormPlan());
  await tick();
  const s = r.eng.stop();
  await tick();
  r.child().exit(0, null);
  assert.deepStrictEqual(await p, { ok: false, why: 'stopped before it started' });
  assert.deepStrictEqual(await s, { ok: true });
  assert.deepStrictEqual(r.exits, []);
});

check('unexpected exit: logged once with a moods: line, onExit told, never restarted', async () => {
  const r = rig();
  await startRunning(r);
  r.child().exit(1, null);
  r.child().exit(1, null); // a second exit event changes nothing
  await tick();
  r.timers.advance(60000);
  assert.deepStrictEqual(r.logs.filter((l) => l === E.EXIT_LINE), [E.EXIT_LINE]);
  assert.strictEqual(E.EXIT_LINE, 'moods: renderer stopped, wall on its own effects');
  assert.deepStrictEqual(r.exits, [{ code: 1, signal: null }]);
  assert.strictEqual(r.spawns.length, 1);
  assert.strictEqual(r.eng.status().running, false);
  assert.deepStrictEqual(await r.eng.event('thunder', 1), { ok: false, why: 'renderer not running' });
});

check('start while running stops the old renderer first (one at a time)', async () => {
  const r = rig();
  await startRunning(r);
  const first = r.child();
  const p = r.eng.start(rainforestPlan());
  await tick();
  assert.deepStrictEqual(r.sends, [['quit', 4999, '127.0.0.1']]);
  first.exit(0, null);
  await tick(); await tick();
  assert.strictEqual(r.spawns.length, 2);
  r.child().out(STREAM_LINE);
  assert.strictEqual((await p).ok, true);
  assert.strictEqual(r.eng.status().id, 'rainforest');
  assert.deepStrictEqual(r.exits, []);
});

check('every log line starts "moods:" and holds no host', async () => {
  const r = rig();
  await startRunning(r);
  r.child().exit(1, null);
  const p = r.eng.start(stormPlan());
  await tick();
  r.child().out('forest-render: could not look up the WLED host, nothing sent');
  r.child().exit(1, null);
  await p;
  assert.ok(r.logs.length >= 3);
  for (const l of r.logs) {
    assert.ok(/^moods: /.test(l), l);
    assert.ok(l.indexOf('wall-test') < 0 && !/\d+\.\d+\.\d+\.\d+/.test(l), l);
  }
});

check('createFakeEngine: same shape, records calls, crash() reports like the real one', async () => {
  const logs = [];
  const exits = [];
  const fake = E.createFakeEngine({ log: (m) => logs.push(m), onExit: (i) => exits.push(i) });
  const real = rig().eng;
  for (const k of ['kind', 'can', 'argsFor', 'start', 'event', 'stop', 'status']) assert.ok(k in fake, k);
  assert.strictEqual(fake.kind, 'fake');
  assert.deepStrictEqual(fake.argsFor(stormPlan()), E.createEngine({ kind: 'forest' }).argsFor(stormPlan()));
  assert.deepStrictEqual(fake.can(stormPlan()), real.can(stormPlan()));
  assert.strictEqual(fake.can({ v: 1 }).ok, false);
  assert.deepStrictEqual(await fake.start(stormPlan()), { ok: true, why: '' });
  assert.strictEqual(fake.status().running, true);
  assert.deepStrictEqual(await fake.event('thunder', 2), { ok: true });
  fake.crash();
  assert.deepStrictEqual(logs, [E.EXIT_LINE]);
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(fake.status().running, false);
  assert.deepStrictEqual(await fake.stop(), { ok: true });
  assert.deepStrictEqual(fake.calls.map((c) => c.fn), ['start', 'event', 'stop']);
  const refusing = E.createEngine({ kind: 'fake', script: { start: { ok: false, why: 'WLED did not answer, nothing sent' } } });
  assert.deepStrictEqual(await refusing.start(stormPlan()), { ok: false, why: 'WLED did not answer, nothing sent' });
  assert.strictEqual(refusing.status().running, false);
});

// ---------- one real run ----------

function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

check('real run: vendored script, --dry-run --seed 1, loopback "thunder 2" then quit', async () => {
  // A sink standing in for WLED on 127.0.0.1: http on a free port, plus WLED's UDP port if it is free.
  const httpHits = [];
  const sink = http.createServer((req, res) => { httpHits.push(req.url); res.end('{}'); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const udpHits = [];
  const udpSink = dgram.createSocket('udp4');
  const udpBound = await new Promise((r) => { udpSink.once('error', () => r(false)); udpSink.bind(F.DEFAULTS.udpPort, '127.0.0.1', () => r(true)); });
  udpSink.on('message', (m) => udpHits.push(m.length));
  const port = await freeUdpPort();
  let out = '';
  let exit = null;
  let realChild = null;
  const eng = E.createEngine({
    kind: 'forest', wledHost: '127.0.0.1:' + sink.address().port, controlPort: port, log: () => {},
    // the real spawn, with --dry-run added so nothing is ever sent
    spawn: (cmd, args, opts) => {
      realChild = cp.spawn(cmd, args.concat(['--dry-run']), opts);
      realChild.stdout.on('data', (d) => { out += d; });
      realChild.on('exit', (code, signal) => { exit = { code, signal }; });
      return realChild;
    },
  });
  const THUNDER = /^forest-render: thunder, LEDs \d+-\d+ down \d+% for \d\.\d s$/gm;
  const count = () => (out.match(THUNDER) || []).length;
  try {
    const res = await eng.start(stormPlan(), { seed: 1 });
    assert.deepStrictEqual(res, { ok: true, why: '' }, out);
    assert.ok(/--seed 1/.test(realChild.spawnargs.join(' ')));
    const st = eng.status();
    assert.strictEqual(st.running, true);
    assert.strictEqual(st.fps, 30);
    assert.strictEqual(st.cycle, 65.5);
    assert.ok(st.scale > 0 && st.scale <= 1 && st.estMa <= 800, JSON.stringify(st));
    // The control socket binds as the streaming line prints: resend only while nothing was heard.
    for (let i = 0; i < 20 && count() === 0; i++) {
      assert.deepStrictEqual(await eng.event('thunder', 2), { ok: true });
      await wait(400);
    }
    assert.strictEqual(count(), 2, out);
    assert.deepStrictEqual(await eng.stop(), { ok: true });
    await wait(50);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, out);
    assert.match(out, /^forest-render: stopped, WLED back on its own$/m);
    assert.match(out, /^forest-render: dry run, nothing is sent$/m);
    assert.strictEqual(httpHits.length, 0, 'no http to the pretend WLED');
    if (udpBound) assert.strictEqual(udpHits.length, 0, 'no frames to the pretend WLED');
    assert.ok(out.indexOf('127.0.0.1') < 0, 'the script never prints the host');
  } finally {
    if (realChild && exit == null) realChild.kill('SIGKILL');
    sink.close();
    udpSink.close();
  }
});

// ---------- run ----------

(async () => {
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    try {
      await c.fn();
      passed++;
      console.log('ok ' + (i + 1) + ' - ' + c.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + (i + 1) + ' - ' + c.name + ': ' + (e && e.message ? e.message.split('\n')[0] : e));
    }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
