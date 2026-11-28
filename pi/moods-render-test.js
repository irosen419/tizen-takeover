/*
 * Tests for the general Pi-drawn renderer (pi/moods/mood-render.js), and the
 * engine adapter (pi/moods/engine.js) with kind "mood". Run from the repo root:
 *
 *   node pi/moods-render-test.js
 *
 * The contract: for the rainforest plan its frames equal forest-render's
 * renderFrame byte for byte. RenderPlan v1 fixtures are built here by hand.
 * CLI runs use --dry-run only (no network); ports are picked free at run time.
 * Time is a number passed in, random is seeded: no clock or time zone.
 * Prints one line per check, then "N passed, M failed".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const cp = require('child_process');
const F = require('./moods/forest-render.js');
const M = require('./moods/mood-render.js');
const E = require('./moods/engine.js');

const SCRIPT = path.join(__dirname, 'moods', 'mood-render.js');
const checks = [];
let passed = 0;
let failed = 0;
function check(name, fn) { checks.push({ name, fn }); }

// ---------- fixtures (RenderPlan v1, plan section 3) ----------

function rainforestPlan() {
  return {
    v: 1, id: 'rainforest', engine: 'forest', leds: 164, fps: 30, maxMa: 800,
    palette: F.PALETTE_HEX.slice(), drift: { cycleSeconds: null, spans: 1 }, groups: 1,
    sections: F.WALL.sections.map((s) => ({ start: s.start, end: s.end, dim: s.dim.slice() })),
    black: [[162, 163]],
    layers: [{ kind: 'palette', ranges: F.WALL.sections.map((s) => [s.start, s.end]) }],
    events: {},
  };
}
function stormPlan() {
  const p = rainforestPlan();
  p.id = 'rainforest-storm';
  p.events = { thunder: { kind: 'dim', size: [2, 4], depth: [0.5, 0.75], attack: 0.25, hold: [1, 2.5], release: 0.9, floor: 0.15 } };
  return p;
}
function nightPlan() {
  return {
    v: 1, id: 'rainforest-night', engine: 'mood', leds: 164, fps: 30, maxMa: 800,
    drift: { cycleSeconds: null, spans: 1 }, groups: 1, black: [[162, 163]],
    layers: [
      { kind: 'solid', ranges: [[29, 49], [50, 111], [141, 161]], color: '#146e32', level: 0.25 },
      { kind: 'sparkle', ranges: [[29, 49], [50, 111], [141, 161]], color: '#c8ff14', density: 0.08, rise: 1.5, hold: [0.3, 1.2], fall: 2.5 },
      { kind: 'breathe', ranges: [[9, 15], [20, 26], [121, 127], [132, 138]], color: '#20c060', level: 0.8, min: 0.2, period: 6 },
    ],
    events: {},
  };
}
const O = (extra) => Object.assign({ cycle: 65.5, spans: 1, gamma: 2.8, scale: 1, seed: 1 }, extra || {});
const rgbAt = (frame, led) => [frame[led * 3], frame[led * 3 + 1], frame[led * 3 + 2]];

// ---------- contract ----------

check('contract: rainforest frames equal forest-render renderFrame byte for byte', () => {
  const plans = [rainforestPlan(), stormPlan()];
  const variants = [O(), O({ gamma: 1 }), O({ scale: 0.4245409307660322 }), O({ cycle: 40, spans: 2, gamma: 2.2, scale: 0.7 })];
  let frames = 0;
  for (const plan of plans) {
    for (const o of variants) {
      for (let k = 0; k < 300; k++) {
        const t = k * 0.73;
        const a = Buffer.from(F.renderFrame(t, o, null));
        const b = Buffer.from(M.renderPlanFrame(plan, t, o, null));
        assert.ok(a.equals(b), 't=' + t + ' ' + JSON.stringify(o));
        frames++;
      }
    }
  }
  // with thunder dims from forest-render's own groups
  const rng = F.mulberry32(5);
  let groups = F.addThunder([], 0, rng, 6).groups;
  for (let k = 0; k < 120; k++) {
    const t = k / 30;
    groups = F.pruneThunder(groups, t);
    const mult = F.dimMultipliers(groups, t);
    const a = Buffer.from(F.renderFrame(t, O({ scale: 0.42 }), mult));
    const b = Buffer.from(M.renderPlanFrame(stormPlan(), t, O({ scale: 0.42 }), mult));
    assert.ok(a.equals(b), 'dimmed t=' + t);
    assert.ok(F.buildFramePacket(a).equals(F.buildFramePacket(b)));
    frames++;
  }
  assert.ok(frames > 2500);
});

check('contract: the forest wash uses forest-render\'s own power scale and peak', () => {
  assert.strictEqual(M.isForestWash(rainforestPlan()), true);
  assert.strictEqual(M.isForestWash(nightPlan()), false);
  const lower = rainforestPlan(); lower.palette = lower.palette.map((h) => '#' + h.toLowerCase());
  assert.strictEqual(M.isForestWash(lower), true);
  const o = { spans: 1, gamma: 2.8, maxMa: 800, bri: 255, ledMa: F.defaultLedMa() };
  const s = M.planScale(rainforestPlan(), o);
  assert.strictEqual(s, F.fixedScale(o));
  assert.strictEqual(M.peakMa(rainforestPlan(), o, s), F.BASE_MA + F.peakLedPart(o, 256) * s);
});

// ---------- layer kinds ----------

check('solid and pixels: colour times level, gamma off; uncovered bulbs and black stay dark', () => {
  const plan = { v: 1, black: [[40, 41]], layers: [
    { kind: 'solid', ranges: [[30, 49]], color: '#c86432', level: 0.5 },
    { kind: 'pixels', ranges: [[0, 3]], colors: ['ff0000', '00ff00'] },
  ] };
  assert.strictEqual(M.checkPlan(plan), '');
  const f = M.renderPlanFrame(plan, 0, O({ gamma: 1 }), null);
  assert.deepStrictEqual(rgbAt(f, 30), [100, 50, 25]);
  assert.deepStrictEqual(rgbAt(f, 40), [0, 0, 0]);
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => rgbAt(f, i)), [[255, 0, 0], [0, 255, 0], [255, 0, 0], [0, 255, 0]]);
  assert.deepStrictEqual(rgbAt(f, 4), [0, 0, 0]);
  assert.deepStrictEqual(rgbAt(f, 162), [0, 0, 0]);
  assert.deepStrictEqual(rgbAt(f, 163), [0, 0, 0]);
});

check('palette: any table, one span per range, drifts at its own cycle', () => {
  const c9 = ['ff0500', 'c43902', '067e02', '1d3fc0'];
  const plan = { v: 1, layers: [{ kind: 'palette', palette: c9, ranges: [[50, 111]], cycleSeconds: 20 }] };
  assert.strictEqual(M.checkPlan(plan), '');
  const f0 = M.renderPlanFrame(plan, 0, O({ gamma: 1 }), null);
  assert.deepStrictEqual(rgbAt(f0, 50), [255, 5, 0]);
  // after a full cycle the picture repeats; half way it does not
  assert.ok(Buffer.from(M.renderPlanFrame(plan, 20, O({ gamma: 1 }), null)).equals(Buffer.from(f0)));
  assert.ok(!Buffer.from(M.renderPlanFrame(plan, 10, O({ gamma: 1 }), null)).equals(Buffer.from(f0)));
  assert.deepStrictEqual(M.paletteColorOf(c9.map((h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)]), 64), [196, 57, 2]);
});

check('breathe: min at t 0, top at half a period, back at a full period', () => {
  const plan = { v: 1, layers: [{ kind: 'breathe', ranges: [[9, 15]], color: '#ffffff', level: 0.8, min: 0.2, period: 6 }] };
  const at = (t) => rgbAt(M.renderPlanFrame(plan, t, O({ gamma: 1 }), null), 12)[0];
  assert.strictEqual(at(0), Math.round(255 * 0.2));
  assert.strictEqual(at(3), Math.round(255 * 0.8));
  assert.strictEqual(at(6), Math.round(255 * 0.2));
  assert.ok(at(1.5) > at(0) && at(1.5) < at(3));
});

check('sparkle: seeded and stateless, about `density` lit, never above the colour', () => {
  const plan = nightPlan();
  const o = O({ gamma: 1, seed: 7 });
  const a = M.renderPlanFrame(plan, 12.3, o, null);
  assert.ok(Buffer.from(a).equals(Buffer.from(M.renderPlanFrame(plan, 12.3, o, null))), 'same t, same frame');
  assert.ok(!Buffer.from(a).equals(Buffer.from(M.renderPlanFrame(plan, 12.3, O({ gamma: 1, seed: 8 }), null))), 'seed matters');
  const sp = M.compile(plan).layers[1];
  let lit = 0;
  let n = 0;
  for (let k = 0; k < 400; k++) {
    for (let led = 50; led <= 111; led++) {
      const al = M.sparkleAlpha(sp, led, k * 0.37, 7);
      assert.ok(al >= 0 && al <= 1);
      if (al > 0) lit++;
      n++;
    }
  }
  const frac = lit / n;
  assert.ok(frac > 0.03 && frac < 0.1, 'lit fraction ' + frac);
  // base green between twinkles, glint colour at most
  for (let k = 0; k < 50; k++) {
    const f = M.renderPlanFrame(plan, k * 0.9, o, null);
    for (let led = 50; led <= 111; led++) {
      const c = rgbAt(f, led);
      assert.ok(c[0] <= 0xc8 && c[1] <= 0xff && c[2] <= 0x32, led + ' ' + c);
      assert.ok(c[1] >= Math.round(0x6e * 0.25) - 1, 'base stays under the twinkle');
    }
  }
});

check('chase: the head moves at `speed` bulbs a second and fades over `width`', () => {
  const plan = { v: 1, layers: [{ kind: 'chase', ranges: [[50, 111]], color: '#ffffff', width: 4, speed: 10 }] };
  const f0 = M.renderPlanFrame(plan, 0, O({ gamma: 1 }), null);
  assert.deepStrictEqual(rgbAt(f0, 50), [255, 255, 255]);
  assert.deepStrictEqual(rgbAt(f0, 51), [0, 0, 0]);
  const f1 = M.renderPlanFrame(plan, 1, O({ gamma: 1 }), null);
  assert.deepStrictEqual(rgbAt(f1, 60), [255, 255, 255]);
  assert.deepStrictEqual(rgbAt(f1, 59), [191, 191, 191]);
  assert.deepStrictEqual(rgbAt(f1, 56), [0, 0, 0]);
  assert.deepStrictEqual(rgbAt(f1, 61), [0, 0, 0]);
});

check('power: a non-forest plan\'s scale keeps every sampled frame under max-ma', () => {
  const white = { v: 1, layers: [{ kind: 'solid', ranges: [[0, 161]], color: '#ffffff' }] };
  const o = { spans: 1, gamma: 2.8, maxMa: 800, bri: 255, ledMa: F.defaultLedMa() };
  const s = M.planScale(white, o);
  assert.ok(s > 0 && s < 0.1, String(s));
  const f = M.renderPlanFrame(white, 0, O({ scale: s }), null);
  assert.ok(F.estimateMa(f, 255, o.ledMa) <= 792, String(F.estimateMa(f, 255, o.ledMa)));
  const night = nightPlan();
  const sn = M.planScale(night, o);
  for (let k = 0; k < 200; k++) {
    const fr = M.renderPlanFrame(night, k * 0.61, O({ scale: sn }), null);
    assert.ok(F.estimateMa(fr, 255, o.ledMa) <= 800);
  }
  assert.ok(M.peakMa(night, o, sn) <= 800);
  // a dim plan needs no scaling
  assert.strictEqual(M.planScale({ v: 1, layers: [{ kind: 'solid', ranges: [[0, 9]], color: '#202020' }] }, o), 1);
});

check('checkPlan: refuses what it cannot draw', () => {
  assert.strictEqual(M.checkPlan(rainforestPlan()), '');
  assert.strictEqual(M.checkPlan(stormPlan()), '');
  assert.strictEqual(M.checkPlan(nightPlan()), '');
  const bad = [
    [null, /no plan/],
    [{ v: 2, layers: [] }, /version/],
    [{ v: 1, layers: [] }, /layers/],
    [{ v: 1, layers: [{ kind: 'laser', ranges: [[0, 1]] }] }, /unknown kind/],
    [{ v: 1, layers: [{ kind: 'solid', ranges: [[0, 162]], color: '#ffffff' }] }, /range outside/],
    [{ v: 1, layers: [{ kind: 'solid', ranges: [[5, 4]], color: '#ffffff' }] }, /range outside/],
    [{ v: 1, layers: [{ kind: 'solid', ranges: [[0, 4]], color: 'white' }] }, /colour/],
    [{ v: 1, layers: [{ kind: 'solid', ranges: [[0, 4]], color: '#ffffff', level: 2 }] }, /level/],
    [{ v: 1, layers: [{ kind: 'palette', ranges: [[0, 4]] }] }, /palette/],
    [{ v: 1, layers: [{ kind: 'sparkle', ranges: [[0, 4]], color: '#ffffff', density: 0 }] }, /density/],
    [{ v: 1, layers: [{ kind: 'sparkle', ranges: [[0, 4]], color: '#ffffff', density: 0.1, hold: [2, 1] }] }, /hold/],
    [{ v: 1, layers: [{ kind: 'pixels', ranges: [[0, 4]], colors: [] }] }, /colours/],
    [Object.assign(nightPlan(), { events: { lightning: {} } }), /other than thunder/],
    [(() => { const p = stormPlan(); p.events.thunder.hold = [3, 5]; return p; })(), /hold/],
    [Object.assign(nightPlan(), { leds: 100 }), /LED count/],
  ];
  for (const [plan, re] of bad) assert.match(M.checkPlan(plan), re, JSON.stringify(plan));
});

check('trigger and flags: forest-render\'s words plus "event <name> [n]" and --plan', () => {
  assert.deepStrictEqual(M.parseMoodTrigger('thunder 3'), { cmd: 'thunder', n: 3 });
  assert.deepStrictEqual(M.parseMoodTrigger('quit'), { cmd: 'quit' });
  assert.deepStrictEqual(M.parseMoodTrigger('event thunder 2'), { cmd: 'thunder', n: 2 });
  assert.deepStrictEqual(M.parseMoodTrigger('event glint'), { cmd: 'event', name: 'glint', n: 1 });
  assert.deepStrictEqual(M.parseMoodTrigger('event glint 9'), { cmd: 'event', name: 'glint', n: 6 });
  assert.strictEqual(M.parseMoodTrigger('event'), null);
  assert.strictEqual(M.parseMoodTrigger('event Bad_Name'), null);
  const r = M.parseMoodArgs(['--plan', '-', '--no-preset', '--fps', '20', '--dry-run'], {});
  assert.ok(r.ok);
  assert.strictEqual(r.opts.plan, '-');
  assert.strictEqual(r.opts.fps, 20);
  assert.strictEqual(M.parseMoodArgs(['--plan=x.json', '--dry-run'], {}).opts.plan, 'x.json');
  assert.match(M.parseMoodArgs(['--dry-run'], {}).error, /no plan/);
  assert.match(M.parseMoodArgs(['--plan'], {}).error, /needs a value/);
  assert.match(M.parseMoodArgs(['--plan', '-', '--bogus'], {}).error, /unknown flag/);
  assert.match(M.parseMoodArgs(['--plan', '-'], {}).error, /no host/);
  assert.strictEqual(M.streamingLine(30, 65.5, 2.8, 1, 412), 'mood-render: streaming 164 LEDs at 30 fps, cycle 65.5 s, gamma 2.8, scale 1.00, est 412 mA');
  assert.strictEqual(M.STOPPED_LINE, 'mood-render: stopped, WLED back on its own');
  assert.ok(E.STREAMING_RE.test(M.streamingLine(30, 65.5, 2.8, 1, 412)), 'the engine parses it');
});

// ---------- CLI ----------

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(get, re, ms) {
  return new Promise((resolve, reject) => {
    let left = Math.ceil((ms || 8000) / 20);
    const iv = setInterval(() => {
      if (re.test(get())) { clearInterval(iv); resolve(); } else if (--left <= 0) {
        clearInterval(iv); reject(new Error('timed out waiting for ' + re + ': ' + JSON.stringify(get().slice(-300))));
      }
    }, 20);
  });
}
function run(args, stdin) {
  const child = cp.spawn(process.execPath, [SCRIPT].concat(args), { env: { PATH: process.env.PATH || '' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
  const done = new Promise((resolve) => child.on('exit', (code, signal) => { clearTimeout(kill); resolve({ code, signal, out }); }));
  return { child, out: () => out, done };
}
const THUNDER = /^mood-render: thunder, LEDs \d+-\d+ down \d+% for \d\.\d s$/gm;
const countThunder = (s) => (s.match(THUNDER) || []).length;

check('CLI: --plan file, dry run, "event thunder 2" then "quit" on the control port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mood-render-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(nightPlan()));
  const port = await freePort();
  const sender = dgram.createSocket('udp4');
  const c = run(['--plan', file, '--dry-run', '--seed', '1', '--control-port', String(port)]);
  try {
    await waitFor(c.out, /^mood-render: streaming 164 LEDs at 30 fps, cycle 65\.5 s, gamma 2\.8, scale \d\.\d\d, est \d+ mA$/m);
    for (let i = 0; i < 20 && countThunder(c.out()) === 0; i++) { sender.send('event thunder 2', port, '127.0.0.1'); await wait(400); }
    assert.strictEqual(countThunder(c.out()), 2, c.out());
    sender.send('event glint', port, '127.0.0.1');
    await waitFor(c.out, /event not in this mood, ignored/);
    sender.send('quit', port, '127.0.0.1');
    const r = await c.done;
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /^mood-render: dry run, nothing is sent$/m);
    assert.match(r.out, /^mood-render: stopped, WLED back on its own$/m);
  } finally {
    sender.close();
    c.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('CLI: a plan it cannot draw exits 1 with one "nothing sent" line', async () => {
  const r = await run(['--plan', '-', '--dry-run'], JSON.stringify({ v: 1, layers: [{ kind: 'laser', ranges: [[0, 1]] }] })).done;
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.out.trim(), 'mood-render: plan refused, layer 1: unknown kind, nothing sent');
  const r2 = await run(['--plan', '-', '--dry-run'], 'not json').done;
  assert.strictEqual(r2.code, 1);
  assert.match(r2.out, /plan is not JSON, nothing sent/);
  const r3 = await run(['--dry-run']).done;
  assert.strictEqual(r3.code, 2);
  assert.match(r3.out, /no plan given/);
});

check('engine kind "mood": plan over stdin, real dry run, thunder and stop', async () => {
  const port = await freePort();
  let out = '';
  let exit = null;
  let child = null;
  const logs = [];
  const eng = E.createEngine({
    kind: 'mood', wledHost: '127.0.0.1:9', controlPort: port, log: (m) => logs.push(m),
    spawn: (cmd, args, opts) => {
      child = cp.spawn(cmd, args.concat(['--dry-run']), opts);
      child.stdout.on('data', (d) => { out += d; });
      child.on('exit', (code, signal) => { exit = { code, signal }; });
      return child;
    },
  });
  assert.strictEqual(eng.can(nightPlan()).ok, true);
  assert.strictEqual(eng.can(stormPlan()).ok, true, 'the mood engine draws the forest plans too');
  assert.match(eng.can({ v: 1, layers: [] }).why, /layers/);
  assert.deepStrictEqual(eng.argsFor(nightPlan()).slice(-2), ['--plan', '-']);
  try {
    assert.deepStrictEqual(await eng.start(nightPlan(), { seed: 1 }), { ok: true, why: '' }, out);
    assert.strictEqual(eng.status().id, 'rainforest-night');
    for (let i = 0; i < 20 && countThunder(out) === 0; i++) { await eng.event('thunder', 1); await wait(400); }
    assert.strictEqual(countThunder(out), 1, out);
    assert.deepStrictEqual(await eng.event('glint', 1), { ok: true });
    assert.deepStrictEqual(await eng.stop(), { ok: true });
    await wait(50);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, out);
    assert.ok(logs.every((l) => /^moods: /.test(l)));
  } finally {
    if (child && exit == null) child.kill('SIGKILL');
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
