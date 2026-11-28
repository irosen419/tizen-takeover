/*
 * Tests for the Moods compilers: pi/moods/compile.js (WLED effects form,
 * checks, power, restore, events), pi/moods/render.js (RenderPlan v1 and the
 * forest flags) and pi/moods/preview.js (the TV drawing's preview).
 * Golden WLED bodies live in pi/fixtures/moods/*.json; after a deliberate
 * change, rewrite them with MOODS_GOLDEN=update node pi/moods-compile-test.js
 * and review the diff.
 *
 * No clock, no time zone, no network; random only from a seeded function.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const catalogLib = require('./moods/catalog');
const W = require('./moods/compile');
const R = require('./moods/render');
const P = require('./moods/preview');
const E = require('./moods/engine');
const F = require('./moods/forest-render');
const M = require('./moods/mood-render');

const FIX = path.join(__dirname, 'fixtures', 'moods');
const UPDATE = process.env.MOODS_GOLDEN === 'update';
const { catalog, wall } = catalogLib.load(null);
const ctx0 = (extra) => Object.assign({ catalog, wall }, extra || {});
const mood = (id) => catalogLib.moodById(catalog, id);
const VISIBLE = catalogLib.visibleMoods(catalog);
const ALL = catalog.moods;
const segMoods = ALL.filter((m) => !m.wled);
const presetMoods = ALL.filter((m) => m.wled && m.wled.preset);
const HEX = /^#[0-9a-f]{6}$/;

const checks = [];
let passed = 0;
let failed = 0;
function check(name, fn) { checks.push({ name, fn }); }

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lit = (body) => (body.seg || []).filter((s) => s.stop > 0);
const withoutBri = (b) => { const o = JSON.parse(JSON.stringify(b)); delete o.bri; return o; };

// ---------- golden bodies ----------

function goldenCases() {
  const out = ALL.map((m) => ({ file: m.id + '.json', mood: m, ctx: ctx0() }));
  out.push({ file: 'menorah-night-1.json', mood: mood('menorah'), ctx: ctx0({ night: 1 }) });
  out.push({ file: 'menorah-night-8.json', mood: mood('menorah'), ctx: ctx0({ night: 8 }) });
  return out;
}

check('golden WLED bodies: 22 moods, Menorah nights 1 and 8, and the check mood', () => {
  const cases = goldenCases();
  assert.strictEqual(VISIBLE.length, 22);
  assert.ok(cases.some((c) => c.file === 'check.json'));
  assert.strictEqual(cases.length, 25);
  if (UPDATE && !fs.existsSync(FIX)) fs.mkdirSync(FIX, { recursive: true });
  cases.forEach((c) => {
    const got = W.compileWled(c.mood, c.ctx);
    const file = path.join(FIX, c.file);
    if (UPDATE) fs.writeFileSync(file, JSON.stringify(got, null, 1) + '\n');
    assert.ok(fs.existsSync(file), 'missing fixture ' + c.file + ' (run with MOODS_GOLDEN=update)');
    assert.deepStrictEqual(got, JSON.parse(fs.readFileSync(file, 'utf8')), c.file + ' differs from its golden body');
  });
  const extra = fs.readdirSync(FIX).filter((f) => cases.every((c) => c.file !== f));
  assert.deepStrictEqual(extra, [], 'fixtures without a case');
});

// ---------- layout ----------

check('body layout: 32 ids, vases 0-3, halos from 4, extras from 16, unused ids deleted', () => {
  segMoods.forEach((m) => {
    const body = W.compileWled(m, ctx0()).bodies[0];
    assert.deepStrictEqual(Object.keys(body), ['on', 'bri', 'transition', 'seg'], m.id);
    assert.strictEqual(body.on, true);
    assert.strictEqual(body.transition, 7);
    assert.deepStrictEqual(body.seg.map((s) => s.id), Array.from({ length: 32 }, (x, i) => i), m.id);
    body.seg.filter((s) => !(s.stop > 0)).forEach((s) => assert.deepStrictEqual(s, { id: s.id, stop: 0 }, m.id));
    const ls = lit(body);
    ['vase1', 'vase2', 'vase3', 'vase4'].forEach((z, i) => {
      const r = wall.zones[z].r[0];
      assert.strictEqual(ls[i].id, i);
      assert.deepStrictEqual([ls[i].start, ls[i].stop], [r[0], r[1] + 1], m.id + ' ' + z);
    });
    ls.forEach((s) => {
      assert.ok(s.stop <= 162 && s.start >= 0, m.id + ' covers 162/163');
      ['pal', 'col', 'o1', 'sx', 'ix', 'c1', 'c2'].forEach((k) => assert.ok(s[k] !== undefined, m.id + ' segment ' + s.id + ' lacks ' + k));
      assert.ok(s.col.length >= 2 && s.col.length <= 3, m.id + ' second colour');
    });
    // No two lit segments share a bulb.
    const seen = {};
    ls.forEach((s) => { for (let i = s.start; i < s.stop; i++) { assert.ok(!seen[i], m.id + ' bulb ' + i + ' twice'); seen[i] = 1; } });
  });
});

check('B = round(255 * briPct / 100); brightness 20 to 100 only changes bri', () => {
  segMoods.filter((m) => !m.hidden).forEach((m) => {
    const ref = W.compileWled(m, ctx0({ briPct: 100 })).bodies[0];
    [20, 35, 50, 60, 85, 100].forEach((p) => {
      const b = W.compileWled(m, ctx0({ briPct: p })).bodies[0];
      assert.strictEqual(b.bri, Math.round(255 * p / 100), m.id + ' ' + p);
      assert.deepStrictEqual(withoutBri(b), withoutBri(ref), m.id + ' at ' + p + '% changed more than bri');
    });
  });
  assert.strictEqual(W.compileWled(mood('check'), ctx0()).bodies[0].bri, Math.round(255 * 0.2), 'check mood at 20%');
});

check('wled.preset moods select preset 2 and add bri only when needed', () => {
  assert.deepStrictEqual(presetMoods.map((m) => m.id), ['rainforest', 'rainforest-storm']);
  const cap = W.presetCap(ctx0());
  assert.ok(cap > 50 && cap < 255, 'cap ' + cap);
  presetMoods.forEach((m) => {
    // Preset brightness known and inside the budget, user did not change it: just the preset.
    assert.deepStrictEqual(W.compileWled(m, ctx0({ presetBri: 80 })).bodies, [{ on: true, ps: 2 }]);
    assert.deepStrictEqual(W.compileWled(m, ctx0({ presetBri: 80, briPct: 100 })).bodies, [{ on: true, ps: 2 }]);
    // Changed by the user: the new brightness, never past the cap.
    assert.deepStrictEqual(W.compileWled(m, ctx0({ briPct: 30 })).bodies, [{ on: true, ps: 2 }, { bri: Math.round(255 * 0.3) }]);
    assert.deepStrictEqual(W.compileWled(m, ctx0({ briPct: 90 })).bodies, [{ on: true, ps: 2 }, { bri: Math.min(cap, Math.round(255 * 0.9)) }]);
    // Not known: counted as full, so capped.
    assert.deepStrictEqual(W.compileWled(m, ctx0()).bodies, [{ on: true, ps: 2 }, { bri: cap }]);
    W.compileWled(m, ctx0()).bodies.forEach((b) => assert.ok(!b.seg, 'ps never with seg'));
  });
});

// ---------- checkState ----------

function everyBody() {
  const out = [];
  goldenCases().forEach((c) => W.compileWled(c.mood, c.ctx).bodies.forEach((b) => out.push([c.file, b])));
  [{ mic: false }, { mic: true }].forEach((have) => ALL.forEach((m) => W.compileWled(m, ctx0({ have })).bodies.forEach((b) => out.push([m.id, b]))));
  [20, 100].forEach((p) => ALL.forEach((m) => W.compileWled(m, ctx0({ briPct: p })).bodies.forEach((b) => out.push([m.id + p, b]))));
  return out;
}

check('checkState passes every compiled, restore and event body', () => {
  everyBody().forEach((x) => assert.deepStrictEqual(W.checkState(x[1], wall), [], x[0]));
  restoreCases().forEach((c) => W.restoreBodies(c, wall).forEach((b) => assert.deepStrictEqual(W.checkState(b, wall), [], JSON.stringify(b))));
  const ev = W.eventBodies(mood('rainforest-storm'), 'thunder', ctx0(), rng(3));
  assert.deepStrictEqual(W.checkState(ev.down, wall), []);
  assert.deepStrictEqual(W.checkState(ev.up, wall), []);
});

check('checkState rejects bad bodies', () => {
  const good = W.compileWled(mood('christmas'), ctx0()).bodies[0];
  const edit = (fn) => { const b = JSON.parse(JSON.stringify(good)); fn(b); return W.checkState(b, wall); };
  const bad = [
    ['stop 163', (b) => { b.seg[4].stop = 163; }, /start and stop/],
    ['covers 162', (b) => { b.seg[6].stop = 163; b.seg[6].start = 150; }, /start and stop/],
    ['stop 162 start 162', (b) => { b.seg[6].start = 162; b.seg[6].stop = 162; }, /start and stop/],
    ['psave', (b) => { b.psave = 3; }, /psave/],
    ['pdel', (b) => { b.pdel = 2; }, /pdel/],
    ['playlist', (b) => { b.playlist = { ps: [1] }; }, /playlist/],
    ['live', (b) => { b.live = true; }, /live/],
    ['udpn', (b) => { b.udpn = { send: true }; }, /udpn/],
    ['nl', (b) => { b.nl = { on: true }; }, /nl/],
    ['lor', (b) => { b.lor = 1; }, /lor/],
    ['segment n', (b) => { b.seg[0].n = 'Vase'; }, /"n"/],
    ['duplicate id', (b) => { b.seg[5].id = 4; }, /repeats/],
    ['id 32', (b) => { b.seg[31].id = 32; }, /id must be/],
    ['33 segments', (b) => { b.seg.push({ id: 31, stop: 0 }); }, /more than 32/],
    ['ps with seg', (b) => { b.ps = 2; }, /ps may not be sent with seg/],
    ['bri 256', (b) => { b.bri = 256; }, /bri/],
    ['sx -1', (b) => { b.seg[0].sx = -1; }, /sx/],
    ['4 colours', (b) => { b.seg[0].col = [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]]; }, /col/],
    ['colour 300', (b) => { b.seg[0].col = [[300, 0, 0]]; }, /colour/],
    ['start without stop', (b) => { delete b.seg[0].stop; }, /together/],
    ['o1 not boolean', (b) => { b.seg[0].o1 = 1; }, /o1/],
    ['grp 0', (b) => { b.seg[0].grp = 0; }, /grp/],
    ['spc 300', (b) => { b.seg[0].spc = 300; }, /spc/],
    ['of -1', (b) => { b.seg[0].of = -1; }, /of must/],
  ];
  bad.forEach((x) => {
    const errs = edit(x[1]);
    assert.ok(errs.length && errs.some((e) => x[2].test(e)), x[0] + ': ' + JSON.stringify(errs));
  });
  assert.ok(W.checkState({ ps: 5 }, wall).length, 'ps 5 is not a live preset');
  assert.ok(W.checkState({ ps: 2, psave: 2 }, wall).length);
  assert.ok(W.checkState('x', wall).length);
  assert.deepStrictEqual(W.checkState({ on: true, ps: 2 }, wall), []);
  assert.deepStrictEqual(W.checkState({ tt: 3, seg: [{ id: 1, bri: 90 }] }, wall), []);
});

check('every lit mood segment resets grouping, spacing and offset (grp 1, spc 0, of 0)', () => {
  let n = 0;
  everyBody().forEach((x) => (x[1].seg || []).forEach((s) => {
    if (s.stop === 0 || s.start === undefined) return;
    n++;
    assert.deepStrictEqual([s.grp, s.spc, s.of], [1, 0, 0], x[0] + ' segment ' + s.id);
  }));
  assert.ok(n > 100, n + ' segments');
});

check('no compiled body ever holds psave, pdel or playlist', () => {
  const text = JSON.stringify(everyBody().map((x) => x[1])) + JSON.stringify(restoreCases().map((c) => W.restoreBodies(c, wall)));
  ['psave', 'pdel', 'playlist', '"live"', 'udpn', '"nl"'].forEach((k) => assert.ok(text.indexOf(k) < 0, k));
});

// ---------- power ----------

check('every compiled body of every mood is at or under 800 mA at 100% brightness', () => {
  const budget = wall.power.budgetMa;
  [ctx0({ briPct: 100 }), ctx0({ briPct: 100, have: { mic: false } }), ctx0({ briPct: 100, have: { mic: true } }), ctx0({ briPct: 100, sides: 'force' })].forEach((c) => {
    ALL.concat([mood('menorah')]).forEach((m) => {
      const r = W.compileWled(m, c);
      // Each body by itself (a preset body counted at full brightness)...
      r.bodies.filter((b) => b.seg).forEach((b) => assert.ok(W.budgetMa(b, c) <= budget, m.id + ' ' + W.budgetMa(b, c)));
      // ...and the state the bodies leave together.
      assert.ok(W.budgetMa(r.bodies, c) <= budget, m.id + ' sequence ' + W.budgetMa(r.bodies, c));
      assert.ok(r.budget.ma <= budget, m.id + ' reported ' + r.budget.ma);
      assert.ok(r.budget.scale > 0 && r.budget.scale <= 1);
    });
  });
  [1, 8].forEach((night) => {
    const r = W.compileWled(mood('menorah'), ctx0({ night, briPct: 100 }));
    assert.ok(W.budgetMa(r.bodies, ctx0()) <= budget);
  });
  // The forest wash at full brightness tops the budget, so the cap is needed at all.
  assert.ok(W.presetMa(255, ctx0()) > budget);
  assert.ok(W.presetMa(W.presetCap(ctx0()), ctx0()) <= budget);
});

check('budget: one fixed scale, the flash cap holds, a measured bulb current changes the scale', () => {
  const flashKeys = Object.keys(catalog.fx).filter((k) => catalog.fx[k].flash).map((k) => catalog.fx[k].id);
  ['thunderstorm', 'santa', 'carol-of-the-bells', 'dreidel'].forEach((id) => {
    const r = W.compileWled(mood(id), ctx0({ briPct: 100 }));
    const fl = lit(r.bodies[0]).filter((s) => flashKeys.indexOf(s.fx) >= 0);
    assert.ok(fl.length, id + ' has flash segments');
    const ma = fl.reduce((t, s) => t + W.segMa(s, 255, ctx0()), 0);
    assert.ok(ma <= wall.power.flashMa + 1e-9, id + ' flash adds ' + ma);
    assert.ok(r.budget.flash < 1);
  });
  // A white flash on the 62 drum bulbs lands under 8% (plan section 3).
  const drum = { id: 5, start: 50, stop: 112, bri: 255, col: [[255, 255, 255]], fx: catalog.fx.lightning.id };
  assert.ok(wall.power.flashMa / W.segMa(drum, 255, ctx0()) < 0.08);
  // Vase-only dim moods need no scale.
  ['movie-night', 'tv-glow', 'goodnight'].forEach((id) => assert.strictEqual(W.compileWled(mood(id), ctx0()).budget.scale, 1));
  // The scale is one number: every lit segment's bri is its authored bri times it (floored, at least 1).
  const m = mood('aurora');
  const r = W.compileWled(m, ctx0());
  const s = r.budget.scale;
  assert.ok(s < 1);
  lit(r.bodies[0]).forEach((g) => {
    const authored = g.id < 4 ? m.vases.bri : m.halos.bri;
    assert.ok(Math.abs(g.bri - Math.max(1, Math.floor(authored * s))) <= Math.ceil(authored * 0.03) + 1, g.id + ' ' + g.bri);
  });
  const low = W.compileWled(m, ctx0({ ledMa: 20 }));
  assert.ok(low.budget.scale > s, 'lower bulb current: brighter');
  assert.ok(W.budgetMa(low.bodies, ctx0({ ledMa: 20 })) <= wall.power.budgetMa);
});

// ---------- approximations ----------

check('mic fallback swaps designs when the probe says the mic effects are missing', () => {
  const santaFx = (have) => lit(W.compileWled(mood('santa'), ctx0({ have })).bodies[0]).map((s) => s.fx);
  const un = W.compileWled(mood('santa'), ctx0());
  assert.deepStrictEqual(un.approx, ['mic-unverified']);
  assert.ok(un.uses.fx.indexOf('Gravimeter') >= 0 && un.uses.fx.indexOf('Puddlepeak') >= 0 && un.uses.fx.indexOf('Ripple Peak') >= 0);
  const yes = W.compileWled(mood('santa'), ctx0({ have: { mic: true } }));
  assert.deepStrictEqual(yes.approx, []);
  const no = W.compileWled(mood('santa'), ctx0({ have: { mic: false } }));
  assert.deepStrictEqual(no.approx, ['mic-fallback']);
  const fx = santaFx({ mic: false });
  assert.deepStrictEqual(fx.slice(0, 4), [2, 2, 2, 2], 'v-meter -> v-breathe');
  assert.strictEqual(fx[4], catalog.fx.twinkle.id, 'h-peaks -> h-twinkle');
  assert.strictEqual(fx[5], catalog.fx.twinklefox.id, 'h-ripples -> h-xmas');
  ['Gravimeter', 'Puddlepeak', 'Ripple Peak'].forEach((n) => assert.ok(no.uses.fx.indexOf(n) < 0, n));
  // Thunderstorm: only the drum halo needs the mic.
  const ts = lit(W.compileWled(mood('thunderstorm'), ctx0({ have: { mic: false } })).bodies[0]);
  assert.strictEqual(ts[5].fx, catalog.fx.lightning.id, 'h-thunder -> h-storm');
  // A probe that lists the effects but not Gravimeter swaps it too.
  const names = Object.keys(catalog.fx).map((k) => catalog.fx[k]).sort((a, b) => a.id - b.id);
  const list = []; names.forEach((f) => { if (f.name !== 'Gravimeter') list[f.id] = f.name; });
  const r = W.compileWled(mood('dreidel'), ctx0({ fxIds: list, have: { mic: true } }));
  assert.strictEqual(lit(r.bodies[0])[0].fx, 2);
  assert.ok(r.approx.indexOf('mic-fallback') >= 0);
});

check('unsure sides give one blended colour per frame and the "sides" tag', () => {
  const m = mood('match-the-art');
  const r = W.compileWled(m, ctx0());
  assert.deepStrictEqual(r.approx, ['sides']);
  const halos = lit(r.bodies[0]).filter((s) => s.id >= 4);
  assert.strictEqual(halos.length, 3);
  halos.forEach((s, i) => {
    const z = wall.zones['halo.' + catalogLib.PAINTINGS[i]].r[0];
    assert.deepStrictEqual([s.start, s.stop], [z[0], z[1] + 1]);
  });
  // Guitar: top and inside(right) from vase 1, outside(left) and bottom from vase 2, by bulb count.
  const c = m.vases.c.map(catalogLib.hexToRgb);
  const g = [0, 1, 2].map((k) => Math.round((c[0][k] * 10 + c[1][k] * 11) / 21));
  assert.deepStrictEqual(halos[0].col[0], g);
  // Sure sides (a Pi-only fix of the wall map): one segment per side, no tag.
  const sure = catalogLib.mergeWall(wall, { sides: Object.keys(wall.sides).reduce((o, k) => { o[k] = Object.assign({}, wall.sides[k], { sure: true }); return o; }, {}) });
  const r2 = W.compileWled(m, { catalog, wall: sure });
  assert.deepStrictEqual(r2.approx, []);
  const side = lit(r2.bodies[0]).filter((s) => s.id >= 4);
  assert.strictEqual(side.length, 12);
  assert.deepStrictEqual(side.map((s) => s.id), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepStrictEqual(W.compileWled(m, ctx0({ sides: 'force' })).bodies, r2.bodies);
  // Preview follows what is sent.
  assert.deepStrictEqual(P.previewOf(m, ctx0()).z['halo.guitar'], [W.hex(g)]);
  assert.strictEqual(P.previewOf(m, { catalog, wall: sure }).z['halo.drum'].length, 4);
});

check('candles: Menorah nights, the shamash, and the "candles" tag', () => {
  const m = mood('menorah');
  const n8 = W.compileWled(m, ctx0({ night: 8 }));
  const n1 = W.compileWled(m, ctx0({ night: 1 }));
  assert.deepStrictEqual(n8.approx, ['candles']);
  assert.strictEqual(lit(n8.bodies[0]).length, 25, 'night 8: 4 vases, 12 blue runs, 8 candles, the shamash');
  const flame = (r) => lit(r.bodies[0]).filter((s) => s.id >= 16 && s.stop - s.start === 1);
  assert.strictEqual(flame(n8).length, 8);
  assert.strictEqual(flame(n1).length, 1);
  assert.strictEqual(flame(n1)[0].start, wall.menorah.candles[0], 'night 1 lights the rightmost candle');
  const sh = lit(n1.bodies[0]).filter((s) => s.start === wall.menorah.shamash[0]);
  assert.strictEqual(sh.length, 1);
  assert.strictEqual(sh[0].stop, wall.menorah.shamash[1] + 1);
  assert.deepStrictEqual(W.compileWled(m, ctx0()).bodies, n8.bodies, 'no night given: all eight');
  for (let n = 1; n <= 8; n++) assert.deepStrictEqual(W.checkState(W.compileWled(m, ctx0({ night: n })).bodies[0], wall), []);
  // The night from the Hanukkah table, the date given as numbers.
  assert.deepStrictEqual(W.compileWled(m, ctx0({ date: { y: 2026, m: 12, d: 6 } })).bodies, W.compileWled(m, ctx0({ night: 3 })).bodies);
});

check('nightFor: the 2026 dates given as numbers', () => {
  const nf = (m, d) => catalogLib.nightFor({ y: 2026, m, d }, catalog);
  assert.strictEqual(nf(12, 3), null);
  assert.strictEqual(nf(12, 4), 1);
  assert.strictEqual(nf(12, 5), 2);
  assert.strictEqual(nf(12, 11), 8);
  assert.strictEqual(nf(12, 12), null);
  assert.strictEqual(nf(11, 28), null);
  assert.strictEqual(catalogLib.nightFor({ y: 2027, m: 12, d: 4 }, catalog), null, 'no 2027 row yet');
});

check('effects and palettes are resolved by name when the probe moved an id', () => {
  const fxList = [];
  Object.keys(catalog.fx).forEach((k) => { fxList[catalog.fx[k].id] = catalog.fx[k].name; });
  // Move Twinklefox from 80 to 90 and Running from 15 to 16.
  fxList[80] = 'Something else'; fxList[90] = 'Twinklefox';
  fxList[15] = 'Something'; fxList[16] = 'Running';
  const palList = { 'Default': 0, '* Color 1': 2, '* Colors 1&2': 3, 'Forest': 10, 'Aurora': 50, 'C9 New': 60 };
  const r = W.compileWled(mood('christmas'), ctx0({ fxIds: fxList, palIds: palList }));
  const ls = lit(r.bodies[0]);
  assert.strictEqual(ls[4].fx, 90);
  assert.strictEqual(ls[4].pal, 60);
  assert.strictEqual(ls[5].fx, 16);
  assert.deepStrictEqual(r.approx, []);
  // Same names, same ids: the same bodies as without a probe.
  const same = []; Object.keys(catalog.fx).forEach((k) => { same[catalog.fx[k].id] = catalog.fx[k].name; });
  assert.deepStrictEqual(W.compileWled(mood('aurora'), ctx0({ fxIds: same })).bodies, W.compileWled(mood('aurora'), ctx0()).bodies);
  // A missing effect with no fallback plays Solid and says so.
  const noAurora = same.slice(); noAurora[catalog.fx.aurora.id] = undefined;
  const r2 = W.compileWled(mood('aurora'), ctx0({ fxIds: noAurora }));
  assert.ok(r2.approx.indexOf('fx-missing') >= 0);
  assert.strictEqual(lit(r2.bodies[0])[4].fx, 0);
  assert.deepStrictEqual(W.checkState(r2.bodies[0], wall), []);
});

// ---------- restore ----------

function restoreCases() {
  const liveSeg = (id, start, stop, extra) => Object.assign({ id, start, stop, len: stop - start, grp: 1, spc: 0, of: 0, on: true, frz: false, bri: 255, cct: 127, set: 0, n: 'x', col: [[0, 100, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], fx: 65, sx: 8, ix: 128, pal: 10, c1: 128, c2: 128, c3: 16, sel: true, rev: false, mi: false, o1: false, o2: false, o3: false, si: 0, m12: 0 }, extra || {});
  return [
    { on: true, bri: 128, transition: 7, ps: 2, pl: -1, seg: [liveSeg(0, 0, 50), liveSeg(1, 50, 112), liveSeg(2, 112, 162)] },
    { on: false, bri: 40, ps: -1, seg: [liveSeg(0, 0, 164, { bri: 90 })] },
    { on: true, bri: 200, ps: 7, seg: [liveSeg(0, 0, 80), liveSeg(4, 80, 162)] },
    null,
    { on: true },
  ];
}

check('restore bodies delete every extra segment, then put the snapshot back', () => {
  const [onPreset, noPreset, otherPreset, none, empty] = restoreCases();
  const a = W.restoreBodies(onPreset, wall);
  assert.deepStrictEqual(a[0].seg.map((s) => s.id), Array.from({ length: 29 }, (x, i) => i + 3));
  a[0].seg.forEach((s) => assert.deepStrictEqual(Object.keys(s), ['id', 'stop']));
  assert.deepStrictEqual(a.slice(1), [{ on: true, ps: 2 }, { on: true, bri: 128 }]);
  const b = W.restoreBodies(noPreset, wall);
  assert.strictEqual(b[0].seg.length, 31);
  assert.strictEqual(b[1].on, false);
  assert.strictEqual(b[1].bri, 40);
  assert.deepStrictEqual(b[1].seg, [{ id: 0, start: 0, stop: 162, on: true, bri: 90, fx: 65, sx: 8, ix: 128, pal: 10, c1: 128, c2: 128, spc: 0, of: 0, grp: 1, col: [[0, 100, 0], [0, 0, 0], [0, 0, 0]], o1: false, o2: false, o3: false }]);
  const c = W.restoreBodies(otherPreset, wall);
  assert.ok(!c.some((x) => x.ps), 'preset 7 is not selected; its segments are sent');
  assert.deepStrictEqual(c[0].seg.map((s) => s.id).indexOf(4), -1);
  assert.deepStrictEqual(c[c.length - 1].seg.map((s) => s.id), [0, 4]);
  [none, empty].forEach((s) => {
    const d = W.restoreBodies(s, wall);
    assert.deepStrictEqual(d[0].seg.map((x) => x.id), Array.from({ length: 29 }, (x, i) => i + 3));
    assert.deepStrictEqual(d[1], { on: true, ps: 2 });
  });
});

// ---------- events ----------

check('effects-form thunder dims the Drums segment 50 to 75% and brings it back', () => {
  const m = mood('rainforest-storm');
  const r = rng(11);
  for (let i = 0; i < 50; i++) {
    const e = W.eventBodies(m, 'thunder', ctx0(), r);
    assert.strictEqual(e.down.tt, 3);
    assert.strictEqual(e.up.tt, 9);
    assert.strictEqual(e.down.seg.length, 1);
    assert.strictEqual(e.down.seg[0].id, 1, 'live segment 1 is the drum strip');
    const depth = 1 - e.down.seg[0].bri / 255;
    assert.ok(depth >= 0.49 && depth <= 0.76, 'depth ' + depth);
    assert.deepStrictEqual(e.up.seg, [{ id: 1, bri: 255 }]);
    assert.ok(e.holdMs >= 1300 && e.holdMs <= 2800, 'hold ' + e.holdMs);
  }
  const e2 = W.eventBodies(m, 'thunder', ctx0({ segBri: { 1: 200 } }));
  assert.deepStrictEqual(e2.up.seg, [{ id: 1, bri: 200 }]);
  assert.strictEqual(e2.down.seg[0].bri, Math.round(200 * (1 - 0.625)), 'no rng: the middle of the range');
  assert.strictEqual(W.eventBodies(m, 'lightning', ctx0(), r), null);
  assert.strictEqual(W.eventBodies(mood('christmas'), 'thunder', ctx0(), r), null);
  assert.strictEqual(W.eventBodies(mood('rainforest'), 'thunder', ctx0(), r), null);
});

// ---------- RenderPlan ----------

function forestExpected(id, events) {
  return {
    v: 1, id, engine: 'forest', leds: 164, fps: 30, maxMa: 800,
    palette: F.PALETTE_HEX.slice(), drift: { cycleSeconds: null, spans: 1 }, groups: 1,
    sections: F.WALL.sections.map((s) => ({ start: s.start, end: s.end, dim: s.dim.slice() })),
    black: [[162, 163]],
    layers: [{ kind: 'palette', ranges: [[0, 49], [50, 111], [112, 161]] }],
    events,
  };
}

check('RenderPlan for the two forest moods is exactly what engine.can() accepts', () => {
  const rf = R.compileRender(mood('rainforest'), ctx0());
  const rs = R.compileRender(mood('rainforest-storm'), ctx0());
  assert.deepStrictEqual(rf, forestExpected('rainforest', {}));
  assert.deepStrictEqual(rs, forestExpected('rainforest-storm', { thunder: { kind: 'dim', size: [2, 4], depth: [0.5, 0.75], attack: 0.25, hold: [1, 2.5], release: 0.9, floor: 0.15 } }));
  const fake = E.createFakeEngine();
  const real = E.createEngine({ kind: 'forest', log: () => {} });
  [rf, rs].forEach((p) => {
    assert.deepStrictEqual(fake.can(p), { ok: true, why: '' });
    assert.deepStrictEqual(real.can(p), { ok: true, why: '' });
    assert.strictEqual(E.forestWhy(p, F), '');
  });
  // The general renderer's forest contract: these plans are its byte-for-byte forest wash.
  assert.strictEqual(M.checkPlan(rf), '');
  assert.strictEqual(M.checkPlan(rs), '');
  // No general plan is mistaken for a forest one.
  segMoods.forEach((m) => { const p = R.compileRender(m, ctx0()); if (p) assert.strictEqual(fake.can(p).ok, false, m.id); });
});

check('forestArgs equals engine.argsFor exactly, flag order included, and never the host', () => {
  const rs = R.compileRender(mood('rainforest-storm'), ctx0());
  assert.deepStrictEqual(R.forestArgs(rs), ['--no-preset', '--fps', '30', '--spans', '1', '--groups', '1', '--max-ma', '800', '--control-port', '4810']);
  assert.deepStrictEqual(R.forestArgs(rs, { cycleSeconds: 65.5, spans: 2, gamma: 'off', seed: 7 }),
    ['--no-preset', '--fps', '30', '--cycle', '65.5', '--spans', '2', '--groups', '1', '--max-ma', '800', '--gamma', 'off', '--control-port', '4810', '--seed', '7']);
  assert.deepStrictEqual(R.forestArgs(rs, { gamma: 2.2 }, { controlPort: 4999 }),
    ['--no-preset', '--fps', '30', '--spans', '1', '--groups', '1', '--max-ma', '800', '--gamma', '2.2', '--control-port', '4999']);
  const tunes = [undefined, {}, { cycleSeconds: 40 }, { spans: 2 }, { gamma: 'off' }, { gamma: false }, { gamma: 2.8 }, { cycleSeconds: 30.5, spans: 0.5, gamma: 1.8, seed: 3 }, { cycleSeconds: null }, { spans: null }, { seed: null }];
  const fake = E.createFakeEngine();
  const real = E.createEngine({ kind: 'forest', log: () => {} });
  const other = E.createEngine({ kind: 'forest', controlPort: 4999, log: () => {} });
  [rs, R.compileRender(mood('rainforest'), ctx0())].forEach((p) => {
    tunes.forEach((t) => {
      assert.deepStrictEqual(R.forestArgs(p, t), real.argsFor(p, t), JSON.stringify(t));
      assert.deepStrictEqual(R.forestArgs(p, t), fake.argsFor(p, t), JSON.stringify(t));
      assert.deepStrictEqual(R.forestArgs(p, t, { controlPort: 4999 }), other.argsFor(p, t), JSON.stringify(t));
      const a = R.forestArgs(p, t);
      assert.ok(a.indexOf('--host') < 0 && a.indexOf('--auto') < 0 && a[0] === '--no-preset');
      assert.strictEqual(E.argsWhy(a, F), '');
    });
  });
});

check('general RenderPlans: the renderer accepts every one, bulbs resolved, null for effects-only moods', () => {
  ALL.forEach((m) => {
    const p = R.compileRender(m, ctx0());
    if (m.render.type !== 'pi-drawn') { assert.strictEqual(p, null, m.id); return; }
    assert.strictEqual(p.v, 1);
    assert.strictEqual(p.id, m.id);
    assert.strictEqual(p.engine, m.render.engine);
    assert.deepStrictEqual(p.black, [[162, 163]]);
    assert.strictEqual(M.checkPlan(p), '', m.id + ': ' + M.checkPlan(p));
    assert.ok(p.layers.length >= 1 && p.layers.length <= 32, m.id);
    p.layers.forEach((l) => l.ranges.forEach((r) => assert.ok(r[0] >= 0 && r[1] <= 161 && r[0] <= r[1], m.id)));
    // Lit bulbs match the effects form (vases and halos; wire runs and drops dark).
    if (m.render.engine === 'mood') {
      const covered = {};
      p.layers.forEach((l) => { if (l.level > 0) l.ranges.forEach((r) => { for (let i = r[0]; i <= r[1]; i++) covered[i] = 1; }); });
      const sent = {};
      lit(W.compileWled(m, ctx0()).bodies[0]).forEach((s) => { for (let i = s.start; i < s.stop; i++) sent[i] = 1; });
      assert.deepStrictEqual(Object.keys(covered).sort(), Object.keys(sent).sort(), m.id + ' lights other bulbs than its effects form');
    }
  });
  // The forest frames are the forest script's own.
  const rf = R.compileRender(mood('rainforest'), ctx0());
  const o = { cycle: 65.5, spans: 1, gamma: 2.8, scale: 1, seed: 1 };
  for (let k = 0; k < 20; k++) assert.ok(Buffer.from(F.renderFrame(k * 0.9, o, null)).equals(Buffer.from(M.renderPlanFrame(rf, k * 0.9, o, null))));
  // Menorah: the night changes the flames, and the general renderer draws it.
  const n1 = R.compileRender(mood('menorah'), ctx0({ night: 1 }));
  const n8 = R.compileRender(mood('menorah'), ctx0({ night: 8 }));
  assert.notDeepStrictEqual(n1, n8);
  const flames = (p) => p.layers.filter((l) => l.kind === 'solid' && l.color === '#ffb347').reduce((t, l) => t + l.ranges.length, 0);
  assert.strictEqual(flames(n1), 1);
  assert.strictEqual(flames(n8), 8);
  // Mic designs in a Pi-drawn plan fall back to the fallback's recipe.
  const t = R.compileRender(mood('thunderstorm'), ctx0());
  assert.ok(t.layers.some((l) => l.kind === 'sparkle' && l.color === '#e2ecff'));
});

// ---------- preview ----------

check('preview zones for every mood', () => {
  const zones = Object.keys(wall.zones);
  ALL.forEach((m) => {
    const p = P.previewOf(m, ctx0());
    assert.deepStrictEqual(Object.keys(p), ['z', 'pat', 'glint', 'anim', 'lvl'], m.id);
    assert.ok(['still', 'twinkle', 'breathe', 'drift'].indexOf(p.anim) >= 0, m.id + ' anim ' + p.anim);
    assert.ok(p.glint === null || HEX.test(p.glint), m.id);
    Object.keys(p.z).forEach((z) => {
      assert.ok(zones.indexOf(z) >= 0, m.id + ' zone ' + z);
      assert.ok(p.z[z].length >= 1 && p.z[z].length <= 8 && p.z[z].every((h) => HEX.test(h)), m.id + ' ' + z);
      assert.ok(['solid', 'gradient', 'stripe', 'dots'].indexOf(p.pat[z]) >= 0, m.id + ' ' + z);
      assert.ok(p.lvl[z] >= 0.12 && p.lvl[z] <= 1, m.id + ' ' + z);
    });
    assert.deepStrictEqual(Object.keys(p.pat).sort(), Object.keys(p.z).sort());
    assert.deepStrictEqual(Object.keys(p.lvl).sort(), Object.keys(p.z).sort());
    if (m.wash) assert.deepStrictEqual(Object.keys(p.z).sort(), zones.slice().sort(), m.id + ' wash lights every zone');
    else {
      ['vase1', 'vase2', 'vase3', 'vase4'].forEach((z, i) => assert.deepStrictEqual(p.z[z], [m.vases.c[i].toLowerCase()], m.id));
      catalogLib.PAINTINGS.forEach((k) => assert.strictEqual(!!p.z['halo.' + k], !!m.halos[k], m.id + ' halo ' + k));
    }
  });
  assert.deepStrictEqual(P.previewOf(mood('christmas'), ctx0()).pat['halo.drum'], 'stripe');
  assert.strictEqual(P.previewOf(mood('rainforest-night'), ctx0()).anim, 'twinkle');
  assert.strictEqual(P.previewOf(mood('rainforest-night'), ctx0()).glint, '#c8ff14');
  assert.strictEqual(P.previewOf(mood('menorah'), ctx0()).anim, 'still');
  assert.deepStrictEqual(P.previewOf(mood('check'), ctx0()).z['drops.left'], ['#ffffff']);
  // Mic swap shows in the preview.
  assert.notDeepStrictEqual(P.previewOf(mood('santa'), ctx0({ have: { mic: false } })), P.previewOf(mood('santa'), ctx0()));
});

// ---------- purity ----------

check('pi/moods/compile.js, pi/moods/render.js and pi/moods/preview.js are pure', () => {
  ['compile.js', 'render.js', 'preview.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, 'moods', f), 'utf8');
    [/Date\.now/, /new Date/, /Math\.random/, /require\(['"](fs|http|https|net|dgram|child_process)['"]\)/, /process\.env/].forEach((re) => assert.ok(!re.test(src), f + ' uses ' + re));
  });
  // Same input, same output; the catalog is not changed.
  const before = JSON.stringify(catalog) + JSON.stringify(wall);
  ALL.forEach((m) => {
    assert.deepStrictEqual(W.compileWled(m, ctx0()), W.compileWled(m, ctx0()));
    R.compileRender(m, ctx0()); P.previewOf(m, ctx0());
  });
  assert.strictEqual(JSON.stringify(catalog) + JSON.stringify(wall), before);
});

// ---------- run ----------

(async () => {
  for (const c of checks) {
    try {
      await c.fn();
      passed++;
      console.log('ok   ' + c.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + c.name + '\n     ' + (e && e.message ? e.message.split('\n').slice(0, 6).join('\n     ') : e));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
