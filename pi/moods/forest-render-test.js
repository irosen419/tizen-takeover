// Tests for forest-render.js. Run: node forest-render-test.js
// No real device or outside network: time is a counter, random is seeded.
// The CLI checks talk only to a fake WLED on 127.0.0.1 with ephemeral ports.
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const F = require('./forest-render.js');

const SCRIPT = path.join(__dirname, 'forest-render.js');
let passed = 0;
let failed = 0;
const checks = [];

function check(name, fn) { checks.push({ name, fn }); }

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), (msg || '') + ' ' + a + ' vs ' + b);
const hex = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const nonDim = (led) => (led >= 0 && led <= 28) || (led >= 112 && led <= 140) || led >= 162;
const inRange = (g) => F.DIM_RANGES.some((r) => g.first >= r[0] && g.last <= r[1]);
const RENDER = { cycle: 65.5, spans: 1, gamma: 2.8 };

// ---------- palette ----------

check('palette has the 16 Forest steps', () => {
  const want = '006400 006400 556B2F 006400 008000 228B22 6B8E23 008000 2E8B57 66CDAA 32CD32 9ACD32 90EE90 7CFC00 66CDAA 228B22'.split(' ');
  assert.deepStrictEqual(F.PALETTE_HEX, want);
  assert.deepStrictEqual(F.PALETTE.map((c) => c.join(',')), want.map((h) => hex(h).join(',')));
});

check('palette lands on each step at index 16*k', () => {
  for (let k = 0; k < 16; k++) assert.deepStrictEqual(F.paletteColor(16 * k), F.PALETTE[k]);
});

check('palette blends linearly between neighbours', () => {
  const c = F.paletteColor(24);
  near(c[0], 0x55 / 2); near(c[1], (0x64 + 0x6B) / 2); near(c[2], 0x2F / 2);
  const q = F.paletteColor(16 + 4);
  near(q[0], 0x55 * 0.25); near(q[1], 0x64 + (0x6B - 0x64) * 0.25);
});

check('palette wraps from step 15 back to step 0', () => {
  const c = F.paletteColor(248);
  const a = F.PALETTE[15], b = F.PALETTE[0];
  for (let j = 0; j < 3; j++) near(c[j], (a[j] + b[j]) / 2);
  assert.deepStrictEqual(F.paletteColor(256), F.paletteColor(0));
  const m = F.paletteColor(-8);
  for (let j = 0; j < 3; j++) near(m[j], c[j]);
});

// ---------- span and drift ----------

check('each section shows one palette span (spans 1) and two with spans 2', () => {
  for (const s of F.WALL.sections) {
    const len = s.end - s.start + 1;
    near(F.paletteIndex(0, len, 0, 65.5, 1), 0);
    near(F.paletteIndex(len - 1, len, 0, 65.5, 1), 255 * (len - 1) / len);
    near(F.paletteIndex(len / 2, len, 0, 65.5, 2), F.wrap256(255));
    const lin = F.renderLinear(0, 65.5, 1);
    assert.deepStrictEqual(Array.from(lin.slice(s.start * 3, s.start * 3 + 3)), F.paletteColor(0));
  }
});

check('spare LEDs 162-163 render black', () => {
  const lin = F.renderLinear(12.3, 65.5, 1);
  for (let k = 162 * 3; k < 164 * 3; k++) assert.strictEqual(lin[k], 0);
});

check('drift moves 256 steps per cycle, quarter cycle is 64 steps', () => {
  for (const cyc of [65.5, 4, 10]) {
    const a = F.paletteIndex(10, 62, 3, cyc, 1);
    near(F.paletteIndex(10, 62, 3 + cyc / 4, cyc, 1), F.wrap256(a - 64), 1e-6);
    near(F.paletteIndex(10, 62, 3 + cyc, cyc, 1), a, 1e-6);
    near(F.paletteIndex(10, 62, 3 + 1 / 30, cyc, 1), F.wrap256(a - 256 / cyc / 30), 1e-6);
  }
});

check('cycle from preset speed', () => {
  near(F.cycleFromSpeed(128), 65.536 / 17);
  near(F.cycleFromSpeed(7), 65.536);
  assert.strictEqual(F.cycleFromSpeed(0), 65.5);
  assert.strictEqual(F.cycleFromSpeed(undefined), 65.5);
});

// ---------- gamma ----------

check('gamma 2.8 table: 0, 255 fixed, mid darker, rising', () => {
  const t = F.gammaTable(2.8);
  assert.strictEqual(t[0], 0); near(t[255], 255);
  near(t[128], 255 * Math.pow(128 / 255, 2.8));
  for (let i = 1; i < 256; i++) assert.ok(t[i] > t[i - 1]);
});

check('gamma off is identity', () => {
  const t = F.gammaTable(1);
  for (let i = 0; i < 256; i++) assert.strictEqual(t[i], i);
  assert.strictEqual(F.decideGamma({}, 'off').gamma, 1);
  assert.strictEqual(F.decideGamma({ noGc: false }, 2.2).gamma, 2.2);
});

check('gamma decision from probe', () => {
  assert.strictEqual(F.decideGamma(F.parseProbe({}), null).gamma, 2.8);
  assert.strictEqual(F.decideGamma({ noGc: false, gcCol: 2.2 }, null).gamma, 1);
  assert.strictEqual(F.decideGamma({ noGc: true, gcCol: 2.2 }, null).gamma, 2.2);
  assert.strictEqual(F.decideGamma({ gcCol: 1 }, null).gamma, 1);
});

check('gamma from cfg colour gamma: 1.0 means raw, clamped to 1..3', () => {
  const g = (col, noGc) => F.decideGamma(F.parseProbe({ cfg: { if: { live: { 'no-gc': noGc } }, light: { gc: { col } } } }), null).gamma;
  assert.strictEqual(g(1, true), 1);
  assert.strictEqual(g(1), 1);
  assert.strictEqual(g(2.2, true), 2.2);
  assert.strictEqual(g(3.5, true), 3);
  assert.strictEqual(g(0.5, true), 1);
  assert.strictEqual(g(2.2, false), 1);
  assert.strictEqual(g('2.2', true), 2.8);
  assert.strictEqual(g(undefined, true), 2.8);
  assert.strictEqual(F.decideGamma({ gcCol: 1 }, 2.8).gamma, 2.8);
});

check('ledma per output: parsing with bad and missing entries', () => {
  const r = F.parseLedMa({ hw: { led: { ins: [
    { start: 0, len: 50, ledma: 35 },
    { start: 50, len: 62, ledma: 255 },
    { start: 112, len: 30, ledma: '20' },
    { start: 142, len: 10 },
    null,
    { start: 'x', len: 5, ledma: 20 },
    { start: 152, len: 20, ledma: 12.5 },
  ] } } });
  assert.deepStrictEqual(r.outputs, [
    { start: 0, len: 50, ledma: 35 }, { start: 50, len: 62, ledma: null }, { start: 112, len: 30, ledma: null },
    { start: 142, len: 10, ledma: null }, { start: 152, len: 20, ledma: 12.5 },
  ]);
  assert.strictEqual(r.ledMa.length, 164);
  assert.strictEqual(r.ledMa[0], 35); assert.strictEqual(r.ledMa[49], 35);
  assert.strictEqual(r.ledMa[50], 55); assert.strictEqual(r.ledMa[120], 55); assert.strictEqual(r.ledMa[145], 55);
  assert.strictEqual(r.ledMa[152], 12.5); assert.strictEqual(r.ledMa[163], 12.5);
  for (const bad of [undefined, null, {}, { hw: { led: { ins: 'x' } } }, { hw: { led: { ins: [{ start: 0, len: 164, ledma: 0 }] } } }]) {
    const d = F.parseLedMa(bad).ledMa;
    assert.ok(d.every((v) => v === 55));
  }
  assert.ok(F.parseProbe({}).ledMa.every((v) => v === 55));
  assert.strictEqual(F.parseProbe({ cfg: { hw: { led: { ins: [{ start: 0, len: 2, ledma: 30 }] } } } }).ledMa[1], 30);
});

check('ledma changes the estimate and the fixed scale', () => {
  const ledMa = F.parseLedMa({ hw: { led: { ins: [{ start: 0, len: 50, ledma: 35 }, { start: 50, len: 114, ledma: 255 }] } } }).ledMa;
  const white = new Uint8Array(164 * 3).fill(255);
  near(F.estimateMa(white, 255, ledMa), 264 + 50 * 35 + 114 * 55, 1e-6);
  near(F.estimateMa(white, 51, ledMa), 264 + (50 * 35 + 114 * 55) / 5, 1e-6);
  near(F.estimateMa(white, 255, F.defaultLedMa()), F.estimateMa(white, 255), 1e-9);
  const low = new Float64Array(164).fill(20);
  const sDef = F.fixedScale({ spans: 1, gamma: 2.8, maxMa: 800, bri: 255 });
  const sLow = F.fixedScale({ spans: 1, gamma: 2.8, maxMa: 800, bri: 255, ledMa: low });
  assert.ok(sLow > sDef, sLow + ' vs ' + sDef);
  near(F.peakLedPart({ spans: 1, gamma: 2.8, bri: 255, ledMa: low }), F.peakLedPart({ spans: 1, gamma: 2.8, bri: 255 }) * 20 / 55, 1e-6);
  const o = { cycle: 65.5, spans: 1, gamma: 2.8, scale: sLow };
  for (let f = 0; f < 65.5 * 30; f++) assert.ok(F.estimateMa(F.renderFrame(f / 30, o, null), 255, low) <= 800);
});

check('brightness from state: re-read, fallback, maxbri', () => {
  assert.strictEqual(F.briFromState({ bri: 64 }, false, 200), 64);
  assert.strictEqual(F.briFromState(null, false, 200), 200);
  assert.strictEqual(F.briFromState({ bri: 'x' }, false, 200), 200);
  assert.strictEqual(F.briFromState({ bri: 64 }, true, 200), 255);
});

// ---------- thunder ----------

check('groups: 2-4 long, one dimmable range, never 0-28/112-140/162-163, all ranges used', () => {
  const rng = F.mulberry32(7);
  const used = new Set();
  const lens = new Set();
  for (let i = 0; i < 20000; i++) {
    const g = F.pickGroup(rng, 0);
    const len = g.last - g.first + 1;
    assert.ok(len >= 2 && len <= 4, 'len ' + len);
    lens.add(len);
    assert.ok(inRange(g), 'range ' + g.first + '-' + g.last);
    for (let led = g.first; led <= g.last; led++) assert.ok(!nonDim(led), 'led ' + led);
    used.add(F.DIM_RANGES.findIndex((r) => g.first >= r[0] && g.last <= r[1]));
  }
  assert.strictEqual(used.size, 3);
  assert.strictEqual(lens.size, 3);
});

check('depth 50-75% and hold 1-2.5 s', () => {
  const rng = F.mulberry32(11);
  let dmin = 1, dmax = 0, hmin = 9, hmax = 0;
  for (let i = 0; i < 20000; i++) {
    const g = F.pickGroup(rng, 0);
    dmin = Math.min(dmin, g.depth); dmax = Math.max(dmax, g.depth);
    hmin = Math.min(hmin, g.hold); hmax = Math.max(hmax, g.hold);
  }
  assert.ok(dmin >= 0.5 && dmax <= 0.75 && dmin < 0.51 && dmax > 0.74, dmin + ' ' + dmax);
  assert.ok(hmin >= 1 && hmax <= 2.5 && hmin < 1.05 && hmax > 2.45, hmin + ' ' + hmax);
});

check('envelope: ease down 0.25 s, hold, ease back 0.9 s to exactly 1', () => {
  const g = { first: 60, last: 62, depth: 0.6, hold: 1.5, t0: 100 };
  assert.strictEqual(F.envelope(g, 100), 1);
  near(F.envelope(g, 100.25), 0.4);
  near(F.envelope(g, 101), 0.4);
  near(F.envelope(g, 101.75), 0.4);
  near(F.envelope(g, 101.75 + 0.45), 0.7);
  assert.strictEqual(F.envelope(g, 102.65), 1);
  assert.strictEqual(F.envelope(g, 105), 1);
  near(F.groupEnd(g), 102.65);
});

check('fade is smooth and monotonic (1 ms steps)', () => {
  const g = { first: 60, last: 62, depth: 0.75, hold: 1, t0: 0 };
  let prev = 1, maxStep = 0;
  for (let ms = 0; ms <= 2300; ms++) {
    const t = ms / 1000;
    const e = F.envelope(g, t);
    maxStep = Math.max(maxStep, Math.abs(e - prev));
    if (t <= 0.25) assert.ok(e <= prev + 1e-12);
    if (t >= 1.25) assert.ok(e >= prev - 1e-12);
    prev = e;
  }
  assert.ok(maxStep < 0.005, 'step ' + maxStep);
  assert.strictEqual(prev, 1);
});

check('finished groups are removed', () => {
  const g = { first: 60, last: 62, depth: 0.6, hold: 1, t0: 0 };
  assert.strictEqual(F.pruneThunder([g], 2.14).length, 1);
  assert.strictEqual(F.pruneThunder([g], 2.15).length, 0);
});

check('overlaps multiply, floor 0.15', () => {
  const a = { first: 60, last: 63, depth: 0.5, hold: 2, t0: 0 };
  const b = { first: 62, last: 65, depth: 0.5, hold: 2, t0: 0 };
  const m = F.dimMultipliers([a, b], 1);
  near(m[60], 0.5); near(m[62], 0.25); near(m[65], 0.5); assert.strictEqual(m[66], 1);
  const c = { first: 62, last: 63, depth: 0.75, hold: 2, t0: 0 };
  const d = { first: 62, last: 63, depth: 0.75, hold: 2, t0: 0 };
  const m2 = F.dimMultipliers([c, d], 1);
  assert.strictEqual(m2[62], 0.15);
});

check('addThunder adds N groups; auto gap is 8-25 s', () => {
  const rng = F.mulberry32(3);
  const r = F.addThunder([], 5, rng, 3);
  assert.strictEqual(r.groups.length, 3);
  assert.strictEqual(r.added.length, 3);
  for (let i = 0; i < 5000; i++) {
    const gap = F.nextAutoGap(rng);
    assert.ok(gap >= 8 && gap <= 25);
  }
});

check('seeded random repeats', () => {
  const a = F.mulberry32(42), b = F.mulberry32(42);
  for (let i = 0; i < 100; i++) assert.strictEqual(a(), b());
});

check('hue unchanged: equal channel ratios before rounding, rounded within 1', () => {
  const o = Object.assign({ scale: 0.8 }, RENDER);
  const base = F.renderBase(20, o);
  const undimmed = F.applyDim(base, null);
  const g = { first: 70, last: 73, depth: 0.62, hold: 1.5, t0: 19 };
  const mult = F.dimMultipliers([g], 20);
  const dimmed = F.applyDim(base, mult);
  for (let led = 70; led <= 73; led++) {
    const m = mult[led];
    near(m, 0.38);
    const k = led * 3;
    const pre = [base[k] * m, base[k + 1] * m, base[k + 2] * m];
    for (let j = 0; j < 3; j++) {
      if (base[k + j] > 0) near(pre[j] / pre[1], base[k + j] / base[k + 1], 1e-9);
      assert.ok(Math.abs(dimmed[k + j] - m * undimmed[k + j]) <= 1, 'led ' + led);
    }
  }
  for (let led = 0; led < 70; led++) assert.strictEqual(dimmed[led * 3 + 1], undimmed[led * 3 + 1]);
});

// ---------- power ----------

check('power estimate: black 264 mA, full white 55 mA per LED, scales with bri', () => {
  const black = new Uint8Array(164 * 3);
  near(F.estimateMa(black, 255), 264);
  const white = new Uint8Array(164 * 3).fill(255);
  near(F.estimateMa(white, 255), 264 + 164 * 55, 1e-6);
  near(F.estimateMa(white, 0), 264);
  near(F.ledPartMa(white, 127.5), 164 * 55 / 2, 1e-6);
});

check('fixed scale formula: min(1, (maxMa - 264) / peak)', () => {
  const peak = F.peakLedPart({ spans: 1, gamma: 2.8, bri: 255 }, 256);
  const s = F.fixedScale({ spans: 1, gamma: 2.8, maxMa: 800, bri: 255 });
  assert.ok(s <= Math.min(1, 536 / peak) + 1e-12 && s > 0.97 * Math.min(1, 536 / peak));
  assert.strictEqual(F.fixedScale({ spans: 1, gamma: 2.8, maxMa: 1000, bri: 20 }), 1);
});

check('whole cycle stays under max-ma (800, 300; gamma 2.8 and off; bri 255 and 128)', () => {
  for (const maxMa of [800, 300]) for (const gamma of [2.8, 1]) for (const bri of [255, 128]) {
    const scale = F.fixedScale({ spans: 1, gamma, maxMa, bri });
    const o = { cycle: 65.5, spans: 1, gamma, scale };
    for (let f = 0; f < 65.5 * 30; f++) {
      const ma = F.estimateMa(F.renderFrame(f / 30, o, null), bri);
      assert.ok(ma <= maxMa, maxMa + '/' + gamma + '/' + bri + ' frame ' + f + ' ' + ma);
    }
  }
});

// ---------- packets ----------

check('frame packet is 494 bytes starting 2,2 with LEDs 162-163 black', () => {
  const frame = new Uint8Array(164 * 3).fill(200);
  const p = F.buildFramePacket(frame);
  assert.strictEqual(p.length, 494);
  assert.strictEqual(p[0], 2); assert.strictEqual(p[1], 2);
  assert.strictEqual(p[2], 200); assert.strictEqual(p[2 + 161 * 3 + 2], 200);
  for (let k = 2 + 162 * 3; k < 494; k++) assert.strictEqual(p[k], 0);
  const q = F.buildFramePacket(F.renderFrame(3, Object.assign({ scale: 1 }, RENDER), null));
  assert.strictEqual(q.length, 494);
});

check('stop packet is 2,0', () => {
  assert.deepStrictEqual(Array.from(F.buildStopPacket()), [2, 0]);
});

// ---------- probe parsing ----------

check('probe parsing: nothing at all falls back safely', () => {
  for (const raw of [undefined, {}, { cfg: null, state: null, presets: null }, { cfg: 'x', state: 5, presets: [] }]) {
    const p = F.parseProbe(raw);
    assert.strictEqual(p.realtime, true);
    assert.strictEqual(p.mainSegmentOnly, false);
    assert.strictEqual(p.port, 21324);
    assert.strictEqual(p.bri, 255);
    assert.strictEqual(p.cycleSeconds, 65.5);
    assert.strictEqual(p.maxPwr, undefined);
    assert.strictEqual(F.decideGamma(p, null).gamma, 2.8);
  }
});

check('probe parsing: full answer', () => {
  const p = F.parseProbe({
    cfg: { if: { live: { en: true, mso: false, 'no-gc': true, maxbri: false }, sync: { port0: 21325 } },
      light: { gc: { col: 2.2 } }, hw: { led: { maxpwr: 1000 } } },
    state: { on: true, bri: 128 },
    presets: { 2: { seg: [{ sx: 128 }] } },
  });
  assert.strictEqual(p.port, 21325); assert.strictEqual(p.bri, 128); assert.strictEqual(p.on, true);
  assert.strictEqual(p.sx, 128); near(p.cycleSeconds, 65.536 / 17); assert.strictEqual(p.maxPwr, 1000);
  assert.strictEqual(F.decideGamma(p, null).gamma, 2.2);
});

check('probe parsing: realtime off, main segment only, maxbri, bad fields', () => {
  assert.strictEqual(F.parseProbe({ cfg: { if: { live: { en: false } } } }).realtime, false);
  assert.strictEqual(F.parseProbe({ cfg: { if: { live: { mso: true } } } }).mainSegmentOnly, true);
  assert.strictEqual(F.parseProbe({ cfg: { if: { live: { maxbri: true } } }, state: { bri: 40 } }).bri, 255);
  const p = F.parseProbe({ cfg: { if: { live: { en: 'yes' }, sync: { port0: 99999 } }, light: { gc: { col: 'x' } } },
    state: { bri: 900 }, presets: { 2: { seg: 'none' } } });
  assert.strictEqual(p.realtime, true); assert.strictEqual(p.port, 21324);
  assert.strictEqual(p.bri, 255); assert.strictEqual(p.cycleSeconds, 65.5);
});

// ---------- trigger and args ----------

check('trigger text parsing', () => {
  assert.deepStrictEqual(F.parseTrigger('thunder'), { cmd: 'thunder', n: 1 });
  assert.deepStrictEqual(F.parseTrigger(' thunder 3\n'), { cmd: 'thunder', n: 3 });
  assert.deepStrictEqual(F.parseTrigger('THUNDER 9'), { cmd: 'thunder', n: 6 });
  assert.deepStrictEqual(F.parseTrigger('thunder 0'), { cmd: 'thunder', n: 1 });
  assert.deepStrictEqual(F.parseTrigger('quit'), { cmd: 'quit' });
  for (const bad of ['', 'thunderx', 'thunder three', 'rain', null, 'quit now']) assert.strictEqual(F.parseTrigger(bad), null);
});

check('arg parsing: defaults, env host, host:port', () => {
  const r = F.parseArgs([], { WLED_HOST: 'wall.local' });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.opts.host, { hostname: 'wall.local', port: 80 });
  assert.strictEqual(r.opts.fps, 30); assert.strictEqual(r.opts.maxMa, 800); assert.strictEqual(r.opts.groups, 1);
  assert.strictEqual(r.opts.controlPort, 4810); assert.strictEqual(r.opts.cycle, null); assert.strictEqual(r.opts.gamma, null);
  const s = F.parseArgs(['--host', '127.0.0.1:8080', '--auto', '--fps=20', '--gamma', 'off', '--cycle', '30',
    '--spans', '2', '--groups', '3', '--max-ma', '600', '--no-preset', '--seed', '5', '--control-port', '5000'], {});
  assert.ok(s.ok, s.error);
  assert.deepStrictEqual(s.opts.host, { hostname: '127.0.0.1', port: 8080 });
  assert.strictEqual(s.opts.auto, true); assert.strictEqual(s.opts.fps, 20); assert.strictEqual(s.opts.gamma, 'off');
  assert.strictEqual(s.opts.cycle, 30); assert.strictEqual(s.opts.spans, 2); assert.strictEqual(s.opts.groups, 3);
  assert.strictEqual(s.opts.maxMa, 600); assert.strictEqual(s.opts.noPreset, true); assert.strictEqual(s.opts.seed, 5);
  assert.strictEqual(s.opts.controlPort, 5000);
  assert.ok(F.parseArgs(['--dry-run'], {}).ok);
});

check('arg parsing: missing host and bad numbers are errors (exit 2)', () => {
  const bad = [[], ['--host', 'a', '--fps', '0'], ['--host', 'a', '--fps', '61'], ['--host', 'a', '--max-ma', '299'],
    ['--host', 'a', '--max-ma', '1001'], ['--host', 'a', '--groups', '7'], ['--host', 'a', '--cycle', '1'],
    ['--host', 'a', '--spans', '0.05'], ['--host', 'a', '--spans', '9'], ['--host', 'a', '--gamma', 'x'],
    ['--host', 'a', '--bogus'], ['--host'], ['--host', 'a:99999'], ['--probe', '--dry-run']];
  for (const argv of bad) {
    const r = F.parseArgs(argv, {});
    assert.ok(!r.ok, argv.join(' '));
    assert.strictEqual(r.code, 2);
  }
});

check('log lines in the plan style', () => {
  assert.strictEqual(F.streamingLine(30, 65.5, 2.8, 1, 412),
    'forest-render: streaming 164 LEDs at 30 fps, cycle 65.5 s, gamma 2.8, scale 1.00, est 412 mA');
  assert.strictEqual(F.thunderLine({ first: 73, last: 75, depth: 0.62, hold: 1.8 }),
    'forest-render: thunder, LEDs 73-75 down 62% for 1.8 s');
  assert.strictEqual(F.STOPPED_LINE, 'forest-render: stopped, WLED back on its own');
});

check('thunder flood is capped: 6 new per frame, 12 active', () => {
  const rng = F.mulberry32(9);
  const a = F.addThunder([], 0, rng, 20);
  assert.strictEqual(a.added.length, 6); assert.strictEqual(a.dropped, 14);
  const b = F.addThunder(a.groups, 0.03, rng, 6);
  assert.strictEqual(b.groups.length, 12); assert.strictEqual(b.dropped, 0);
  const c = F.addThunder(b.groups, 0.06, rng, 3);
  assert.strictEqual(c.added.length, 0); assert.strictEqual(c.dropped, 3);
  const d = F.addThunder(b.groups.slice(0, 10), 0.1, rng, 6);
  assert.strictEqual(d.added.length, 2); assert.strictEqual(d.dropped, 4);
  // after all end there is room again
  const e = F.addThunder(F.pruneThunder(c.groups, 10), 10, rng, 2);
  assert.strictEqual(e.added.length, 2);
});

check('fixedScale at scale 1 never goes over max-ma once rounded', () => {
  for (const [gamma, bri] of [[2.8, 255], [2.8, 100], [1, 40], [2.2, 180]]) {
    const peak = F.peakLedPart({ spans: 1, gamma, bri });
    const maxMa = 264 + peak; // the formula alone gives exactly 1
    const scale = F.fixedScale({ spans: 1, gamma, maxMa, bri });
    assert.ok(scale <= 1);
    const o = { cycle: 65.5, spans: 1, gamma, scale };
    for (let f = 0; f < 65.5 * 30; f++) {
      const ma = F.estimateMa(F.renderFrame(f / 30, o, null), bri);
      assert.ok(ma <= maxMa, gamma + '/' + bri + ' frame ' + f + ' ' + ma + ' > ' + maxMa);
    }
  }
  assert.strictEqual(F.fixedScale({ spans: 1, gamma: 2.8, maxMa: 1000, bri: 10 }), 1);
});

check('preset speed is clamped to 0..255', () => {
  near(F.cycleFromSpeed(300), 65.536 / 32);
  near(F.cycleFromSpeed(255), 65.536 / 32);
  assert.strictEqual(F.cycleFromSpeed(-5), 65.5);
  assert.strictEqual(F.cycleFromSpeed('128'), 65.5);
  assert.strictEqual(F.cycleFromSpeed(NaN), 65.5);
  assert.strictEqual(F.parseProbe({ presets: { 2: { seg: [{ sx: 999 }] } } }).cycleSeconds, 65.536 / 32);
});

check('--host rejects IPv6, empty port, bad port, flags', () => {
  for (const h of ['::1', '[::1]:80', 'fe80::1', 'host:', 'host:0', 'host:65536', 'host:8x', ':80', '--auto', '-x', 'a b', 'a/b', '']) {
    assert.strictEqual(F.parseHost(h), null, h);
  }
  assert.deepStrictEqual(F.parseHost('wled-wall.local:81'), { hostname: 'wled-wall.local', port: 81 });
  assert.deepStrictEqual(F.parseHost('10.0.0.5'), { hostname: '10.0.0.5', port: 80 });
  for (const argv of [['--host', '--auto'], ['--host', 'host:'], ['--host', '::1'], ['--host=']]) {
    const r = F.parseArgs(argv, {});
    assert.ok(!r.ok && r.code === 2, argv.join(' '));
  }
});

check('brightness is worst case when unknown', () => {
  assert.strictEqual(F.parseProbe({ state: { bri: 64 } }).bri, 255); // no cfg: maxbri unknown
  assert.strictEqual(F.parseProbe({ cfg: {}, state: { bri: 64 } }).bri, 64);
  assert.strictEqual(F.parseProbe({ cfg: {}, state: null }).bri, 255);
  const p = F.parseProbe({ cfg: {}, state: { bri: 64 } });
  assert.strictEqual(F.briAfterPreset(p, { bri: 32 }), 32);
  assert.strictEqual(F.briAfterPreset(p, null), 255);
  assert.strictEqual(F.briAfterPreset(F.parseProbe({ state: { bri: 64 } }), { bri: 32 }), 255);
  assert.strictEqual(F.briAfterPreset(F.parseProbe({ cfg: { if: { live: { maxbri: true } } } }), { bri: 32 }), 255);
});

check('UDP send errors: one line down, one line back', () => {
  const st = { down: false };
  assert.strictEqual(F.trackSend(st, null), null);
  assert.strictEqual(F.trackSend(st, new Error('x')), 'WLED not reachable, still trying');
  assert.strictEqual(F.trackSend(st, new Error('x')), null);
  assert.strictEqual(F.trackSend(st, null), 'WLED reachable again');
  assert.strictEqual(F.trackSend(st, null), null);
});

// ---------- 10-minute simulation ----------

function simulate(maxMa, bri, seed, minutes) {
  const rng = F.mulberry32(seed);
  const gamma = 2.8;
  const scale = F.fixedScale({ spans: 1, gamma, maxMa, bri });
  const o = { cycle: 65.5, spans: 1, gamma, scale };
  const fps = 30;
  const total = minutes * 60 * fps;
  let groups = [];
  let thunders = 0, dimmedFrames = 0, cleanFrames = 0;
  for (let f = 0; f < total; f++) {
    const t = f / fps;
    // many random thunders, none in the last 5 s so every group ends
    if (t < minutes * 60 - 5 && rng() < 1 / 45) {
      const n = 1 + Math.floor(rng() * 6);
      groups = F.addThunder(groups, t, rng, n).groups;
      thunders++;
    }
    groups = F.pruneThunder(groups, t);
    const base = F.renderBase(t, o);
    const undimmed = F.applyDim(base, null);
    const mult = F.dimMultipliers(groups, t);
    const frame = F.applyDim(base, groups.length ? mult : null);
    for (let led = 0; led < 164; led++) {
      const k = led * 3;
      if (nonDim(led)) {
        for (let j = 0; j < 3; j++) if (frame[k + j] < undimmed[k + j]) throw new Error('LED ' + led + ' dimmed at frame ' + f);
      }
      if (led >= 162 && (frame[k] || frame[k + 1] || frame[k + 2])) throw new Error('spare lit at frame ' + f);
      if (mult[led] < 0.15 || mult[led] > 1) throw new Error('multiplier ' + mult[led] + ' at frame ' + f);
      if (mult[led] < 1) {
        for (let j = 0; j < 3; j++) {
          if (Math.abs(frame[k + j] - mult[led] * undimmed[k + j]) > 1) throw new Error('hue at frame ' + f);
        }
      }
    }
    const ma = F.estimateMa(frame, bri);
    if (ma > maxMa) throw new Error(ma + ' mA at frame ' + f);
    if (groups.length === 0) {
      cleanFrames++;
      for (let k = 0; k < frame.length; k++) if (frame[k] !== undimmed[k]) throw new Error('not clean at frame ' + f);
    } else dimmedFrames++;
  }
  assert.strictEqual(groups.length, 0);
  assert.ok(thunders > 20 * minutes, 'thunders ' + thunders);
  assert.ok(dimmedFrames > 100 * minutes && cleanFrames > 150, dimmedFrames + ' ' + cleanFrames);
}

check('10-minute run, 30 fps, many thunders, max-ma 800, bri 255', () => simulate(800, 255, 1, 10));
check('2-minute run, many thunders, max-ma 300, bri 128', () => simulate(300, 128, 2, 2));

// ---------- CLI as a child ----------

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts the CLI; returns { child, out(), done }. done resolves { code, signal, out }.
function start(args) {
  const child = spawn(process.execPath, [SCRIPT].concat(args), { env: Object.assign({}, process.env, { WLED_HOST: '' }) });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => { clearTimeout(kill); resolve({ code, signal, out }); });
    child.on('error', reject);
  });
  return { child, out: () => out, done };
}

async function runChild(args) {
  return start(args).done;
}

// Resolves when re matches the output; rejects with the output on timeout.
function waitFor(getOut, re, ms) {
  return new Promise((resolve, reject) => {
    let left = Math.ceil((ms || 8000) / 20);
    const iv = setInterval(() => {
      if (re.test(getOut())) { clearInterval(iv); resolve(); } else if (--left <= 0) {
        clearInterval(iv);
        reject(new Error('timed out waiting for ' + re + '; output: ' + JSON.stringify(getOut().slice(-400))));
      }
    }, 20);
  });
}

// Runs fn(c) with a started child, kills it if fn throws, returns the exit.
async function withChild(args, fn) {
  const c = start(args);
  try { await fn(c); } catch (e) { c.child.kill('SIGKILL'); await c.done; throw e; }
  return c.done;
}

const STREAMING = /^forest-render: streaming 164 LEDs at 30 fps, cycle \d+\.\d s, gamma \d\.\d+, scale \d\.\d\d, est \d+ mA$/m;
const STOPPED = /^forest-render: stopped, WLED back on its own$/m;
const THUNDER = /^forest-render: thunder, LEDs \d+-\d+ down \d+% for \d\.\d s$/gm;
const countThunder = (out) => (out.match(THUNDER) || []).length;

// Fake WLED on 127.0.0.1: http on an ephemeral port plus a UDP sink.
// o.cfg, o.states (successive /json/state GET replies), o.route(req) -> {status, body} to override.
function fakeWled(o) {
  const opt = o || {};
  const stateReplies = opt.states || [{ on: true, bri: 128 }];
  let stateGets = 0;
  return new Promise((resolve) => {
    const udp = dgram.createSocket('udp4');
    const packets = [];
    udp.on('message', (m) => packets.push(m));
    udp.bind(0, '127.0.0.1', () => {
      const udpPort = udp.address().port;
      const cfg = opt.cfg || {
        if: { live: { en: true, mso: false, 'no-gc': true }, sync: { port0: udpPort } },
        light: { gc: { col: 2.8 } },
        hw: { led: { maxpwr: 1000, ins: [{ start: 0, len: 50, ledma: 35 }, { start: 50, len: 114, ledma: 255 }] } },
      };
      const requests = [];
      const w = { udpPort, packets, requests, cfg, onRequest: null };
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          const q = { method: req.method, url: req.url, body };
          requests.push(q);
          if (w.onRequest) w.onRequest(q);
          const send = (status, payload) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
          };
          const over = opt.route && opt.route(q, { stateGets }, cfg);
          if (req.method === 'GET' && req.url === '/json/state') stateGets++;
          if (over) {
            const go = () => send(over.status, over.body);
            return over.delay ? setTimeout(go, over.delay) : go();
          }
          if (req.method === 'GET' && req.url === '/json/cfg') return send(200, cfg);
          if (req.method === 'GET' && req.url === '/json/state') return send(200, stateReplies[Math.min(stateGets - 1, stateReplies.length - 1)]);
          if (req.method === 'GET' && req.url === '/presets.json') return send(200, { 2: { seg: [{ sx: 128 }] } });
          if (req.method === 'POST' && req.url === '/json/state') return send(200, { success: true });
          res.writeHead(404); res.end();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        w.httpPort = server.address().port;
        w.close = () => new Promise((r) => { udp.close(); server.closeAllConnections(); server.close(() => r()); });
        resolve(w);
      });
    });
  });
}

const wantLine = (w, bri) => {
  const ledMa = F.parseLedMa(w.cfg).ledMa;
  const sc = F.fixedScale({ spans: 1, gamma: 2.8, maxMa: 800, bri, ledMa });
  const ma = 264 + F.peakLedPart({ spans: 1, gamma: 2.8, bri, ledMa }) * sc;
  return F.streamingLine(30, 65.536 / 17, 2.8, sc, ma);
};

const assertFrames = (w) => {
  const frames = w.packets.filter((p) => p.length !== 2);
  assert.ok(frames.length >= 1, 'no frames');
  for (const p of frames) {
    assert.strictEqual(p.length, 494); assert.strictEqual(p[0], 2); assert.strictEqual(p[1], 2);
    for (let k = 2 + 162 * 3; k < 494; k++) assert.strictEqual(p[k], 0);
  }
};

check('CLI --dry-run --seed 1 --auto: streams, SIGINT exits 0 with stopped line', async () => {
  const port = await freePort();
  const r = await withChild(['--dry-run', '--seed', '1', '--auto', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGINT');
  });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /cycle 65\.5 s, gamma 2\.8/);
  assert.match(r.out, STOPPED);
});

check('CLI dry run: SIGTERM stops cleanly', async () => {
  const port = await freePort();
  const r = await withChild(['--dry-run', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGTERM');
  });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, STOPPED);
});

check('CLI dry run: SIGUSR1 cues one thunder (--groups 2 gives two groups)', async () => {
  const port = await freePort();
  const r = await withChild(['--dry-run', '--groups', '2', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGUSR1');
    await waitFor(() => (countThunder(c.out()) >= 2 ? 'y' : ''), /y/);
    c.child.kill('SIGINT');
  });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(countThunder(r.out), 2, r.out);
  assert.ok(!/Debugger/.test(r.out), r.out);
});

check('CLI dry run: "thunder 2" then "quit" on the control port', async () => {
  const port = await freePort();
  const sender = dgram.createSocket('udp4');
  const r = await withChild(['--dry-run', '--seed', '2', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    // the control socket binds just before the streaming line; resend until heard
    for (let i = 0; i < 50 && countThunder(c.out()) === 0; i++) { sender.send('thunder 2', port, '127.0.0.1'); await wait(100); }
    await waitFor(() => (countThunder(c.out()) >= 2 ? 'y' : ''), /y/);
    sender.send('quit', port, '127.0.0.1');
  }).finally(() => sender.close());
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(countThunder(r.out) >= 2, r.out);
  assert.match(r.out, STOPPED);
});

check('CLI: control port busy is logged once and streaming carries on', async () => {
  const busy = dgram.createSocket('udp4');
  await new Promise((r) => busy.bind(0, '127.0.0.1', r));
  const port = busy.address().port;
  const r = await withChild(['--dry-run', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, /control port busy, carrying on without it/);
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGINT');
  }).finally(() => busy.close());
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual((r.out.match(/control port busy/g) || []).length, 1);
  assert.match(r.out, STOPPED);
});

check('CLI: no host and no --dry-run prints usage, exits 2', async () => {
  const r = await runChild([]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /usage:/);
});

check('CLI: bad --host values exit 2', async () => {
  for (const argv of [['--host', 'host:'], ['--host', '::1'], ['--host', '--auto'], ['--host', 'h:70000']]) {
    const r = await runChild(argv);
    assert.strictEqual(r.code, 2, argv.join(' ') + ' ' + r.out);
    assert.match(r.out, /usage:/);
  }
});

check('CLI against a fake WLED: preset call, bri re-read, 494-byte frames, stop packets, no cfg write', async () => {
  const w = await fakeWled({ states: [{ on: true, bri: 255 }, { on: true, bri: 64 }] });
  const port = await freePort();
  const sender = dgram.createSocket('udp4');
  const r = await withChild(['--host', '127.0.0.1:' + w.httpPort, '--seed', '3', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    for (let i = 0; i < 50 && countThunder(c.out()) === 0; i++) { sender.send('thunder 2', port, '127.0.0.1'); await wait(100); }
    await waitFor(() => (countThunder(c.out()) >= 2 ? 'y' : ''), /y/);
    c.child.kill('SIGINT');
  }).finally(() => sender.close());
  await wait(150);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  const posts = w.requests.filter((q) => q.method !== 'GET');
  assert.strictEqual(posts.length, 1, JSON.stringify(posts));
  assert.strictEqual(posts[0].url, '/json/state');
  assert.deepStrictEqual(JSON.parse(posts[0].body), { on: true, ps: 2 });
  assert.ok(!w.requests.some((q) => q.url.startsWith('/json/cfg') && q.method !== 'GET'));
  assert.ok(!posts.some((q) => /psave/.test(q.body)));
  assertFrames(w);
  const last = w.packets.slice(-2).map((p) => Array.from(p).join(','));
  assert.deepStrictEqual(last, ['2,0', '2,0']);
  assert.match(r.out, /cycle 3\.9 s/); // preset 2 sx 128
  const postAt = w.requests.findIndex((q) => q.method === 'POST');
  assert.strictEqual(w.requests.filter((q) => q.url === '/json/state' && q.method === 'GET').length, 2);
  assert.ok(w.requests.slice(postAt + 1).some((q) => q.url === '/json/state' && q.method === 'GET'));
  assert.ok(r.out.split('\n').includes(wantLine(w, 64)), r.out + ' want ' + wantLine(w, 64));
  assert.notStrictEqual(wantLine(w, 64), wantLine(w, 255));
  assert.match(r.out, STOPPED);
  assert.ok(!/127\.0\.0\.1/.test(r.out) && !r.out.includes(String(w.httpPort)), 'address printed');
});

check('CLI with --host localhost:<port>: logs hold no address', async () => {
  const w = await fakeWled();
  const port = await freePort();
  const r = await withChild(['--host', 'localhost:' + w.httpPort, '--auto', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGINT');
  });
  await wait(150);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  assertFrames(w);
  for (const bad of ['localhost', '127.0.0.1', String(w.httpPort), String(w.udpPort), '::1']) {
    assert.ok(!r.out.includes(bad), 'printed ' + bad + ': ' + r.out);
  }
});

check('CLI: SIGUSR1 during startup is queued, no inspector, then streams with the cue', async () => {
  const w = await fakeWled({ route: (q, s, cfg) => (q.url === '/json/cfg' ? { status: 200, body: cfg, delay: 600 } : null) });
  const port = await freePort();
  const c = start(['--host', '127.0.0.1:' + w.httpPort, '--control-port', String(port)]);
  w.onRequest = () => { if (!w.sent) { w.sent = true; c.child.kill('SIGUSR1'); } };
  try {
    await waitFor(c.out, STREAMING);
    await waitFor(() => (countThunder(c.out()) >= 1 ? 'y' : ''), /y/);
    c.child.kill('SIGINT');
  } catch (e) { c.child.kill('SIGKILL'); await c.done; await w.close(); throw e; }
  const r = await c.done;
  await w.close();
  assert.ok(w.sent);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!/Debugger/.test(r.out), r.out);
  assert.strictEqual(countThunder(r.out), 1, r.out);
  assertFrames(w);
});

check('CLI: SIGINT during startup exits 0, no preset call, nothing sent', async () => {
  const w = await fakeWled({ route: (q) => (q.url === '/json/cfg' ? { status: 200, body: {}, delay: 1500 } : null) });
  const port = await freePort();
  const c = start(['--host', '127.0.0.1:' + w.httpPort, '--control-port', String(port)]);
  w.onRequest = () => { if (!w.sent) { w.sent = true; c.child.kill('SIGINT'); } };
  const r = await c.done;
  await wait(100);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, STOPPED);
  assert.ok(!STREAMING.test(r.out));
  assert.ok(w.requests.every((q) => q.method === 'GET'));
  assert.strictEqual(w.packets.length, 0);
});

check('CLI --no-preset with WLED off: no POST, one state read, first bri used, still streams', async () => {
  const w = await fakeWled({ states: [{ on: false, bri: 64 }, { on: true, bri: 255 }] });
  const port = await freePort();
  const r = await withChild(['--host', '127.0.0.1:' + w.httpPort, '--no-preset', '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGINT');
  });
  await wait(150);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(w.requests.every((q) => q.method === 'GET'));
  assert.strictEqual(w.requests.filter((q) => q.url === '/json/state').length, 1);
  assert.ok(r.out.split('\n').includes(wantLine(w, 64)), r.out);
  assertFrames(w);
});

check('CLI: preset POST failing (500) carries on and streams', async () => {
  const w = await fakeWled({ route: (q) => (q.method === 'POST' ? { status: 500, body: 'no' } : null) });
  const port = await freePort();
  const r = await withChild(['--host', '127.0.0.1:' + w.httpPort, '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGINT');
  });
  await wait(150);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^forest-render: could not select preset 2, carrying on$/m);
  assertFrames(w);
  assert.deepStrictEqual(Array.from(w.packets[w.packets.length - 1]), [2, 0]);
});

check('CLI: brightness re-read failing uses 255 for the scale', async () => {
  const w = await fakeWled({
    states: [{ on: true, bri: 64 }],
    route: (q, s) => (q.method === 'GET' && q.url === '/json/state' && s.stateGets >= 1 ? { status: 500, body: 'x' } : null),
  });
  const port = await freePort();
  const r = await withChild(['--host', '127.0.0.1:' + w.httpPort, '--control-port', String(port)], async (c) => {
    await waitFor(c.out, STREAMING);
    c.child.kill('SIGINT');
  });
  await wait(150);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(w.requests.filter((q) => q.url === '/json/state' && q.method === 'GET').length, 2);
  assert.ok(r.out.split('\n').includes(wantLine(w, 255)), r.out + ' want ' + wantLine(w, 255));
});

check('CLI --probe against a fake WLED: prints the report, sends nothing', async () => {
  const w = await fakeWled();
  const r = await runChild(['--probe', '--host', '127.0.0.1:' + w.httpPort]);
  await wait(100);
  await w.close();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /probe, brightness 128/);
  assert.match(r.out, /probe, gamma 2\.8/);
  assert.match(r.out, /probe, stream port \d+, receive realtime on, main segment only off/);
  assert.match(r.out, /probe, preset 2 speed 128, cycle 3\.9 s/);
  assert.match(r.out, /probe, WLED power limit 1000 mA/);
  assert.match(r.out, /^forest-render: output 1: 50 LEDs, 35 mA each$/m);
  assert.match(r.out, /^forest-render: output 2: 114 LEDs, 55 mA each \(default/m);
  assert.ok(w.requests.every((q) => q.method === 'GET'));
  assert.strictEqual(w.packets.length, 0);
  assert.ok(!/127\.0\.0\.1/.test(r.out));
});

check('CLI: WLED with receive realtime off exits 1 without sending', async () => {
  const w = await fakeWled({ cfg: { if: { live: { en: false } } } });
  const r = await runChild(['--host', '127.0.0.1:' + w.httpPort]);
  await wait(100);
  await w.close();
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.out.trim().split('\n').length, 1);
  assert.match(r.out, /receive realtime/);
  assert.ok(w.requests.every((q) => q.method === 'GET'));
  assert.strictEqual(w.packets.length, 0);
});

check('CLI: WLED with main segment only exits 1 without sending', async () => {
  const w = await fakeWled({ cfg: { if: { live: { mso: true } } } });
  const r = await runChild(['--host', '127.0.0.1:' + w.httpPort]);
  await wait(100);
  await w.close();
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /main segment only/);
  assert.ok(w.requests.every((q) => q.method === 'GET'));
  assert.strictEqual(w.packets.length, 0);
});

check('CLI: unreachable WLED exits 1 with one line', async () => {
  const port = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const r = await runChild(['--host', '127.0.0.1:' + port]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.out.trim().split('\n').length, 1);
  assert.match(r.out, /did not answer/);
});

const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
for (const [what, reply] of [['non-JSON', { status: 200, body: '<html>hello' }], ['500', { status: 500, body: '{}' }],
  ['oversized body', { status: 200, body: big }]]) {
  check('CLI: fake WLED answering ' + what + ' counts as no answer, exit 1', async () => {
    const w = await fakeWled({ route: () => reply });
    const r = await runChild(['--host', '127.0.0.1:' + w.httpPort]);
    await wait(100);
    await w.close();
    assert.strictEqual(r.code, 1, r.out);
    assert.strictEqual(r.out.trim().split('\n').length, 1, r.out);
    assert.match(r.out, /did not answer/);
    assert.ok(w.requests.every((q) => q.method === 'GET'));
    assert.strictEqual(w.packets.length, 0);
  });
}

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
