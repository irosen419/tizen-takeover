/*
 * Tests for music lights (pi/lights/): the shared Govee config, the music
 * look with made-up audio, On/Off and quiet, giving way when a light is set
 * another way, and the hub's settings, ./hub lights and mailbox commands.
 * Run from the repo root with:
 *
 *   node pi/lights-test.js
 *
 * No real light, Home Assistant or sound card: audio is made here (click
 * tracks at a known tempo, silence, a loud jump), lights are a list of the
 * messages that would have gone out. Time is a counter starting at 0, so no
 * clock time or time zone matters. Prints one line per check.
 */
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const govee = require('./lights/govee');
const look = require('./lights/look');
const sessionLib = require('./lights/session');
const settingsLib = require('./lights/settings');
const haLib = require('./lights/ha');
const engineLib = require('./lights/engine');
const storeLib = require('./lights/store');
const looksLib = require('./lights/looks');
const cloudLib = require('./lights/govee-cloud');
const hubServer = require('./server');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const mockLights = require('../dev/mock-lights');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
let passed = 0;
let failed = 0;
const tmpDirs = [];

async function check(name, fn) {
  if (process.env.LIGHTS_GREP && name.indexOf(process.env.LIGHTS_GREP) < 0) return;
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lights-'));
  tmpDirs.push(d);
  return d;
}

/* ---------- made-up audio ---------- */

// A steady seeded noise (mulberry32) so runs are the same every time.
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PER_S = look.RATE / look.BLOCK;      // blocks a second

// Blocks of 10 ms: a bed of noise with a 40 ms click on every beat; o.hat
// adds a softer click on the off-beats (eighth notes), o.accent makes beat 1
// of 4 louder, o.start shifts where the first beat falls (samples).
function clickTrack(bpm, seconds, o) {
  const opt = o || {};
  const r = rng(opt.seed || 7);
  const bed = opt.bed === undefined ? 900 : opt.bed;
  const click = opt.click || 14000;
  const n = Math.round(seconds * look.RATE);
  const every = (60 / bpm) * look.RATE;
  const clickLen = Math.round(0.04 * look.RATE);
  const start = opt.start || 0;
  const out = [];
  for (let b = 0; b * look.BLOCK < n; b++) {
    const blk = new Int16Array(look.BLOCK);
    for (let i = 0; i < look.BLOCK; i++) {
      const t = b * look.BLOCK + i + start;
      const inBeat = t % every;
      let v = (r() * 2 - 1) * bed;
      if (inBeat < clickLen) v += (r() * 2 - 1) * click * (opt.accent && Math.floor(t / every) % 4 === 0 ? 1.6 : 1);
      if (opt.hat && Math.abs(inBeat - every / 2) < clickLen / 2) v += (r() * 2 - 1) * opt.hat;
      blk[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    out.push(blk);
  }
  return out;
}

function noise(seconds, amp, seed) {
  const r = rng(seed || 5);
  const out = [];
  for (let b = 0; b < Math.round(seconds * PER_S); b++) {
    const blk = new Int16Array(look.BLOCK);
    for (let i = 0; i < look.BLOCK; i++) blk[i] = Math.round((r() * 2 - 1) * amp * (0.6 + 0.4 * Math.sin(b / 37)));
    out.push(blk);
  }
  return out;
}

function silence(seconds) {
  const out = [];
  for (let i = 0; i < Math.round(seconds * PER_S); i++) out.push(new Int16Array(look.BLOCK));
  return out;
}

function sat(c) { return look.richness(c); }

// Feed blocks; note the block index of every new pulse.
function pulsesOf(l, blocks) {
  const at = [];
  let seen = l.features().pulses;
  blocks.forEach((b, i) => {
    if (l.block(b)) l.render(1, 0);
    const n = l.features().pulses;
    if (n > seen) { at.push(i); seen = n; }
  });
  return at;
}

// How far (ms) a block index sits from the nearest beat of the track.
function offBeatMs(i, bpm, start) {
  const t = i * look.BLOCK + (start || 0);
  const every = (60 / bpm) * look.RATE;
  let d = t % every;
  if (d > every / 2) d -= every;
  return (d / look.RATE) * 1000;
}

/* ---------- a stand-in Home Assistant ---------- */

function fakeHa(initial, slowMs) {
  const states = JSON.parse(JSON.stringify(initial));
  const calls = [];
  return {
    states: states,
    calls: calls,
    configured: true,
    watch: 'full',
    has: (k) => !!states[k],
    snapshot: async (k) => {
      const copy = states[k] ? JSON.parse(JSON.stringify(states[k])) : null;
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      return copy;
    },
    restore: async (k, s) => { calls.push({ k: k, s: s }); states[k] = JSON.parse(JSON.stringify(s)); return true; },
    fingerprint: (s) => haLib.fingerprint(s, 'full')
  };
}

const LAMP_BEFORE = { on: true, available: true, brightness: 120, colorMode: 'color_temp', rgb: null, kelvin: 2700, effect: null };
const BARS_BEFORE = { on: false, available: true, brightness: null, colorMode: null, rgb: null, kelvin: null, effect: null };

// An engine with a pretend clock, pretend lights and a pretend HA.
function rig(o) {
  const opt = o || {};
  const t = { now: 0 };
  const sent = [];
  const logs = [];
  const ha = opt.ha === undefined ? fakeHa({ lamp: LAMP_BEFORE, bars: BARS_BEFORE }) : opt.ha;
  const e = engineLib.createEngine({
    addresses: opt.addresses || { lamp: 'x', bars: 'y' },
    send: (k, buf) => {
      const msg = JSON.parse(buf.toString()).msg;
      sent.push({ k: k, t: t.now, msg: msg });
      // Home Assistant sees the engine's own start (its next poll of the light).
      if (ha && ha.states && ha.states[k] && msg.cmd === 'brightness') {
        ha.states[k] = { on: true, available: true, brightness: Math.round(msg.data.value * 2.55), colorMode: 'rgb', rgb: [47, 181, 163], kelvin: null, effect: null };
      }
    },
    ha: ha, now: () => t.now, log: (s) => logs.push(s), capture: null, delayMs: opt.delayMs || 0
  });
  let rev = 1;
  const settings = Object.assign(settingsLib.defaults(), opt.settings || {});
  const hub = (fields) => {
    Object.assign(settings, fields, { rev: ++rev });
    e.applyHub({ settings: Object.assign({}, settings), song: { bpm: 0 } }, 0);
  };
  const feed = async (blocks) => {
    for (const b of blocks) { t.now += 1000 / PER_S; e.block(b); }
    await new Promise((r) => setImmediate(r));
    await e.settled();
  };
  const types = () => e.report().events.map((x) => x.type);
  return { t: t, sent: sent, logs: logs, ha: ha, e: e, hub: hub, feed: feed, settings: settings, types: types };
}

async function main() {
  /* ---------- govee.js ---------- */

  await check('govee: a section frame is 20 bytes, ptReal 33 05 15 01, color, mask, XOR last', () => {
    const b = Buffer.from(govee.segmentFrame([10, 20, 30], [0, 2, 9]), 'base64');
    assert.strictEqual(b.length, 20);
    assert.deepStrictEqual([...b.slice(0, 7)], [0x33, 0x05, 0x15, 0x01, 10, 20, 30]);
    assert.strictEqual(b[12], 0b00000101);
    assert.strictEqual(b[13], 0b00000010);
    let x = 0;
    for (let i = 0; i < 19; i++) x ^= b[i];
    assert.strictEqual(b[19], x);
  });

  await check('govee: same colors share a frame, at most 6 frames a message', () => {
    const same = govee.sectionMessages(new Array(12).fill([30, 60, 90]));
    assert.strictEqual(same.length, 1);
    assert.strictEqual(JSON.parse(same[0]).msg.data.command.length, 1);
    const all = govee.sectionMessages(Array.from({ length: 12 }, (_, i) => [i * 6, 0, 0]));
    assert.strictEqual(all.length, 2);
    all.forEach((m) => assert.ok(JSON.parse(m).msg.data.command.length <= 6));
    assert.strictEqual(JSON.parse(all[0]).msg.cmd, 'ptReal');
  });

  await check('govee: geometry is lamp 7, bars 12 (two bars of 6); no address in the file', () => {
    assert.strictEqual(govee.LIGHTS.lamp.sections, 7);
    assert.strictEqual(govee.LIGHTS.bars.sections, 12);
    assert.deepStrictEqual(govee.PATHS.bars.slice().sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
    const src = fs.readFileSync(path.join(__dirname, 'lights', 'govee.js'), 'utf8');
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(src), 'an IP address in govee.js');
    assert.deepStrictEqual(govee.addressesFromEnv({ GOVEE_LAMP_IP: '10.0.0.5', GOVEE_BARS_IP: 'not an ip!' }), { lamp: '10.0.0.5' });
  });

  /* ---------- palettes and settings ---------- */

  await check('palettes: eight, Warm drift is the default, no color reads white', () => {
    const p = settingsLib.PALETTES;
    assert.strictEqual(p.palettes.length, 8);
    assert.strictEqual(p.default, 'warm-drift');
    assert.deepStrictEqual(settingsLib.paletteById('warm-drift').colors, [[220, 120, 30], [200, 70, 55], [150, 65, 135], [20, 130, 110]]);
    p.palettes.forEach((pal) => pal.colors.forEach((c) => assert.ok(sat(c) >= 0.5, pal.id + ' ' + c + ' is too pale')));
    p.palettes.forEach((pal) => assert.ok(pal.es && pal.name, 'Spanish name for ' + pal.id));
  });

  await check('settings: defaults 15 quiet minutes, Groove; checkChange refuses bad values in plain words', () => {
    const d = settingsLib.defaults();
    assert.strictEqual(d.quietMin, 15);
    assert.strictEqual(settingsLib.presetOf(d), 'groove');
    assert.deepStrictEqual(settingsLib.checkChange({ preset: 'party' }), { vibrancy: 'high', beat: 'high' });
    assert.deepStrictEqual(settingsLib.checkChange({ quietMin: 'never' }), { quietMin: 0 });
    assert.throws(() => settingsLib.checkChange({ beat: 'loud' }), /beat must be low, medium or high/);
    assert.throws(() => settingsLib.checkChange({ tempo: 3 }), /not a music lights setting/);
    assert.throws(() => settingsLib.checkChange({ quietMin: 9999 }), /quietMin/);
    assert.throws(() => settingsLib.checkChange({}), /nothing to change/);
    assert.strictEqual(settingsLib.clean({ vibrancy: 'x', quietMin: -1, on: 'yes' }).vibrancy, 'medium');
  });

  /* ---------- the look, with made-up audio ---------- */

  await check('tempo: 120, 100, 90 and 140 BPM click tracks read right (within 2) after 10 s', () => {
    [120, 100, 90, 140].forEach((bpm, k) => {
      const l = look.createLook({ palette: settingsLib.paletteById('warm-drift').colors });
      clickTrack(bpm, 10, { seed: k + 3, bed: 2500 }).forEach((b) => l.block(b));
      assert.ok(Math.abs(l.features().bpm - bpm) <= 2, bpm + ' heard as ' + l.features().bpm);
      assert.ok(l.features().sound);
    });
  });

  await check('beat lock: once settled, every pulse lands within 30 ms of a beat (Medium: one a beat)', () => {
    [[120, 3000], [96, 11000], [132, 500]].forEach(([bpm, start]) => {
      const l = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]], beat: 'medium' });
      const at = pulsesOf(l, clickTrack(bpm, 16, { start: start, bed: 2000 })).filter((i) => i > 8 * PER_S);
      const worst = Math.max.apply(null, at.map((i) => Math.abs(offBeatMs(i, bpm, start))));
      assert.ok(worst <= 30, bpm + ' BPM: a pulse ' + Math.round(worst) + ' ms off the beat');
      const perS = at.length / 8;
      assert.ok(Math.abs(perS - bpm / 60) <= 0.15, bpm + ' BPM: ' + perS.toFixed(2) + ' pulses a second');
    });
  });

  await check('beat lock: the song\'s own tempo wins when listening agrees, and fills in before it settles', () => {
    const l = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]] });
    l.setSongBpm(60);
    clickTrack(121, 10).forEach((b) => l.block(b));
    assert.ok(Math.abs(l.features().bpm - 120) <= 1, 'double of the song\'s 60: ' + l.features().bpm);
    const m = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]] });
    m.setSongBpm(118);
    silence(4).concat(clickTrack(118, 1)).forEach((b) => m.block(b));
    assert.strictEqual(m.features().bpm, 118);
  });

  await check('Beat dial is density: Low once a bar, Medium every beat, High adds the eighth notes', () => {
    const rate = (beat, o) => {
      const l = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]], beat: beat });
      return pulsesOf(l, clickTrack(120, 16, o)).filter((i) => i > 8 * PER_S).length / 8;
    };
    const hats = { hat: 6000, accent: true, bed: 1500 };
    const lo = rate('low', hats), mid = rate('medium', hats), hi = rate('high', hats);
    assert.ok(Math.abs(lo - 0.5) <= 0.15, 'low ' + lo);
    assert.ok(Math.abs(mid - 2) <= 0.15, 'medium ' + mid);
    assert.ok(Math.abs(hi - 4) <= 0.3, 'high ' + hi);
    const plain = rate('high', { accent: true });
    assert.ok(Math.abs(plain - 2) <= 0.15, 'high with no eighth notes in the song stays on the beat: ' + plain);
  });

  await check('no steady beat (noise, a pad): no pulses, only the overall mood moves', () => {
    const l = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]], beat: 'high' });
    let mx = 0;
    noise(16, 5000).forEach((b, i) => { l.block(b); if (i > 8 * PER_S) mx = Math.max(mx, l.features().pulse); });
    assert.ok(l.features().confidence < 0.2, 'confidence ' + l.features().confidence);
    assert.ok(mx < 0.15, 'pulse reached ' + mx.toFixed(2));
  });

  await check('sections: a quiet verse then a loud chorus lifts brightness within 3 s and counts a new section', () => {
    const pal = settingsLib.paletteById('warm-drift').colors;
    const l = look.createLook({ palette: pal, vibrancy: 'medium', beat: 'low' });
    const level = () => { const o = l.render(1, 0); return o.lamp.concat(o.bars).reduce((a, c) => a + Math.max.apply(null, c), 0) / 19; };
    clickTrack(110, 20, { click: 3000, bed: 400 }).forEach((b) => l.block(b));
    const verse = level();
    const before = l.features().sections;
    clickTrack(110, 3, { click: 16000, bed: 5000, seed: 9 }).forEach((b) => l.block(b));
    const chorus = level();
    assert.ok(chorus > verse * 1.4, 'verse ' + verse.toFixed(0) + ', chorus ' + chorus.toFixed(0));
    assert.strictEqual(l.features().sections, before + 1, 'a new section');
    clickTrack(110, 12, { click: 3000, bed: 400, seed: 4 }).forEach((b) => l.block(b));
    assert.ok(level() < chorus, 'back to the verse calms down');
  });

  await check('limits: no color reads white, at any dial, palette or loudness', () => {
    let worst = 1;
    settingsLib.PALETTES.palettes.forEach((p) => {
      settingsLib.LEVELS.forEach((v) => settingsLib.LEVELS.forEach((bt) => {
        const l = look.createLook({ palette: p.colors, vibrancy: v, beat: bt });
        clickTrack(150, 6, { click: 30000, bed: 4000, hat: 9000 }).concat(silence(2)).forEach((b) => {
          if (!l.block(b)) return;
          const out = l.render(1, 0);
          // Very dim colors cannot read white; there the rounding to steps of 6 decides.
          out.lamp.concat(out.bars).forEach((c) => { if (Math.max.apply(null, c) >= 60) worst = Math.min(worst, sat(c)); });
        });
      }));
    });
    assert.ok(worst >= look.MIN_RICH, 'palest color has saturation ' + worst.toFixed(2));
  });

  await check('limits: a beat changes brightness only, never the color', () => {
    const pal = settingsLib.paletteById('sunset').colors;
    const a = look.createLook({ palette: pal, vibrancy: 'medium', beat: 'high' });
    const b = look.createLook({ palette: pal, vibrancy: 'medium', beat: 'low' });
    let n = 0, worst = 0;
    clickTrack(110, 10, { hat: 5000 }).forEach((blk) => {
      const due = a.block(blk); b.block(blk);
      if (!due) return;
      const x = a.render(1, 0), y = b.render(1, 0);
      x.lamp.forEach((c, i) => {
        const d = y.lamp[i];
        if (Math.max.apply(null, c) < 60 || Math.max.apply(null, d) < 60 || Math.max.apply(null, c) >= 250) return;
        let dh = Math.abs(look.hueOf(c) - look.hueOf(d));
        if (dh > 180) dh = 360 - dh;
        worst = Math.max(worst, dh);
        n++;
      });
    });
    assert.ok(n > 100);
    assert.ok(worst <= 12, 'hue moved ' + worst.toFixed(1) + ' degrees with the beat');
  });

  await check('limits: a pulse fades over more than 150 ms; eighth notes stop above 150 BPM', () => {
    const l = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]], beat: 'medium' });
    let peak = 0, peakAt = -1, later = -1;
    clickTrack(120, 10).forEach((b, i) => {
      l.block(b);
      const p = l.features().pulse;
      if (i > 8 * PER_S && peakAt < 0 && p > 0.5) { peak = p; peakAt = i; }
      if (peakAt >= 0 && i === peakAt + Math.round(0.15 * PER_S)) later = p;
    });
    assert.ok(peakAt > 0, 'a pulse');
    assert.ok(later > 0.25 * peak, 'faded too fast: ' + later.toFixed(2) + ' of ' + peak.toFixed(2));
    const fast = look.createLook({ palette: [[200, 60, 20], [20, 120, 100]], beat: 'high' });
    const at = pulsesOf(fast, clickTrack(170, 14, { hat: 8000 })).filter((i) => i > 8 * PER_S);
    assert.ok(at.length / 6 <= 170 / 60 + 0.2, (at.length / 6).toFixed(2) + ' pulses a second at 170 BPM');
  });

  await check('dials: Low stays dim, High reaches brighter', () => {
    const pal = settingsLib.paletteById('warm-drift').colors;
    const peakOf = (v) => {
      const l = look.createLook({ palette: pal, vibrancy: v, beat: 'medium' });
      let mx = 0;
      clickTrack(140, 12, { click: 20000, bed: 3000 }).forEach((b) => {
        if (!l.block(b)) return;
        l.render(1, 0).lamp.forEach((c) => { mx = Math.max(mx, Math.max.apply(null, c)); });
      });
      return mx;
    };
    const lo = peakOf('low'), mid = peakOf('medium'), hi = peakOf('high');
    assert.ok(lo < mid && mid <= hi, [lo, mid, hi].join(' < '));
    assert.ok(lo <= 255 * 0.55, 'Low reached ' + lo);
  });

  await check('High beat: the pulse travels up the lamp (bottom first)', () => {
    const l = look.createLook({ palette: [[200, 60, 20], [200, 60, 20]], vibrancy: 'medium', beat: 'high' });
    let checked = 0, seen = 0, fresh = false;
    clickTrack(100, 12).forEach((b, i) => {
      const due = l.block(b);
      if (l.features().pulses > seen) { seen = l.features().pulses; fresh = true; }
      if (due && fresh && i > 8 * PER_S) {
        fresh = false;
        const lamp = l.render(1, 0).lamp;
        assert.ok(Math.max.apply(null, lamp[0]) > Math.max.apply(null, lamp[6]), 'bottom lit before top');
        checked++;
      }
    });
    assert.ok(checked > 0);
  });

  /* ---------- session: On, Off and quiet ---------- */

  await check('session: On fades in; quiet between songs dims; 15 quiet minutes turns it off and puts back', () => {
    const s = sessionLib.createSession();
    s.setQuietMin(15);
    assert.deepStrictEqual(s.on(0), ['begin']);
    let r = s.tick(500, false);
    assert.ok(r.gain > 0 && r.gain < 1);
    let t = 0;
    for (; t < 30000; t += 100) r = s.tick(t, true);
    assert.strictEqual(r.state, 'playing');
    assert.ok(r.rest < 0.05);
    for (; t < 35000; t += 100) r = s.tick(t, false);
    assert.strictEqual(r.state, 'between');
    assert.ok(r.rest > 0.3 && r.rest < 1, 'dims slowly: ' + r.rest);
    for (; t < 60000; t += 100) r = s.tick(t, false);
    assert.strictEqual(r.state, 'resting');
    for (; t < 30000 + 15 * 60000 - 1000; t += 1000) { r = s.tick(t, false); assert.deepStrictEqual(r.events, []); }
    let ev = [];
    for (; t < 30000 + 15 * 60000 + 5000; t += 100) ev = ev.concat(s.tick(t, false).events);
    assert.deepStrictEqual(ev, ['quiet', 'end']);
    assert.strictEqual(s.state(), 'off');
  });

  await check('session: music back fades up within a second; a short gap is not quiet; never = stays on', () => {
    const s = sessionLib.createSession();
    s.setQuietMin(0);
    s.on(0);
    let t = 0, r;
    for (; t < 60000; t += 100) r = s.tick(t, false);
    assert.ok(r.rest > 0.99);
    for (; t < 61000 + 800 + 100; t += 100) r = s.tick(t, true);
    assert.ok(r.rest < 0.01, 'rest ' + r.rest);
    r = s.tick(t += 100, false); r = s.tick(t += 100, false);
    assert.strictEqual(r.state, 'playing', 'a 0.2 s gap is still music');
    for (t += 100; t < 4 * 3600000; t += 5000) assert.deepStrictEqual(s.tick(t, false).events, []);
    assert.ok(s.isOn());
  });

  /* ---------- engine: settings, quiet, giving way ---------- */

  await check('engine: On saves the lights, takes them over, follows the music; Off fades and puts them back', async () => {
    const g = rig();
    g.hub({ on: true });
    await g.feed(clickTrack(120, 4));
    assert.ok(g.logs.indexOf('music lights: on') >= 0);
    assert.ok(g.sent.some((m) => m.msg.cmd === 'turn' && m.msg.data.value === 1));
    assert.ok(g.sent.some((m) => m.msg.cmd === 'ptReal' && m.k === 'lamp'));
    assert.ok(g.sent.some((m) => m.msg.cmd === 'ptReal' && m.k === 'bars'));
    const perSecond = g.sent.filter((m) => m.k === 'lamp' && m.msg.cmd === 'ptReal' && m.t > 2000 && m.t <= 3000).length;
    assert.ok(perSecond <= 10 * 2, perSecond + ' lamp messages in a second');
    g.hub({ on: false, offReason: 'you' });
    await g.feed(silence(2));
    assert.deepStrictEqual(g.ha.calls.map((c) => c.k).sort(), ['bars', 'lamp']);
    assert.deepStrictEqual(g.ha.states.lamp, LAMP_BEFORE);
    assert.ok(g.logs.indexOf('music lights: lights put back (2 of 2)') >= 0, g.logs.join(' | '));
    assert.strictEqual(g.e.report().state, 'off');
  });

  await check('engine: quiet for the set minutes turns off, tells the hub once, and is not restarted by the old "on"', async () => {
    const g = rig({ settings: { quietMin: 1 } });
    g.hub({ on: true });
    await g.feed(clickTrack(120, 3));
    await g.feed(silence(63));
    assert.ok(g.logs.indexOf('music lights: off after 1 quiet minute') >= 0, g.logs.join(' | '));
    assert.deepStrictEqual(g.types(), ['quiet']);
    assert.strictEqual(g.e.report().events[0].rev, g.settings.rev, 'the event carries the rev it was raised at');
    assert.strictEqual(g.ha.calls.length, 2);
    // The hub has not taken the event yet and still says on, even at a newer rev (a palette change): stays off.
    g.e.applyHub({ settings: Object.assign({}, g.settings), song: {} }, 0);
    g.e.applyHub({ settings: Object.assign({}, g.settings, { palette: 'sunset', rev: g.settings.rev + 5 }), song: {} }, 0);
    await g.feed(silence(1));
    assert.strictEqual(g.e.session.state(), 'off');
    // The hub takes it and answers off.
    g.e.applyHub({ settings: Object.assign({}, g.settings, { on: false, offReason: 'quiet', rev: g.settings.rev + 6 }), song: {} }, 1);
    assert.strictEqual(g.e.report().events.length, 0, 'event cleared once the hub took it');
    g.hub({ on: true, rev: 0 });
    assert.ok(g.e.session.isOn(), 'switching on again works');
  });

  await check('engine: a light set another way (Govee app, voice, HA) makes it give way: that light left alone, the other put back', async () => {
    const g = rig();
    g.hub({ on: true });
    await g.feed(clickTrack(120, 2));
    await g.e.watch();                                   // too soon: start commands still settling
    g.t.now += engineLib.WATCH_SETTLE_MS;
    await g.feed(clickTrack(120, 1));
    assert.deepStrictEqual(await g.e.watch(), []);       // notes how they are (Home Assistant shows the start)
    assert.deepStrictEqual(await g.e.watch(), []);       // nothing changed
    const keep = g.ha.states.bars;
    g.ha.states.bars = { on: false, available: false, brightness: null, colorMode: null, rgb: null, kelvin: null, effect: null };
    assert.deepStrictEqual(await g.e.watch(), [], 'a light dropping off for a moment is not a change');
    g.ha.states.bars = keep;
    // While sections are drawn, Home Assistant reads back odd or engine colors: not a change.
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { rgb: [6, 0, 0] });
    assert.deepStrictEqual(await g.e.watch(), [], 'a near-black read-back is ours');
    const lastLamp = g.sent.filter((x) => x.k === 'lamp' && x.msg.cmd === 'ptReal').pop();
    const fb = Buffer.from(lastLamp.msg.data.command[0], 'base64');
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { rgb: [fb[4], fb[5], fb[6]].map((v) => Math.min(255, v * 2)) });
    assert.deepStrictEqual(await g.e.watch(), [], 'a color the engine sent (any brightness) is ours');
    assert.ok(g.e.session.isOn());
    // Home Assistant's brightness read-back drifts a few steps: not a change.
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { brightness: 132 });
    assert.deepStrictEqual(await g.e.watch(), [], 'brightness 140 read back as 132 is ours');
    // By default a color alone is never a change (the read-back wanders).
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { rgb: [54, 114, 138] });
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(await g.e.watch(), [], 'a wandering color is not a change');
    // With LIGHTS_WATCH=color: same brightness, a color the engine never sent: Ian picked it in the Govee app.
    g.ha.watch = 'color';
    const mine = { on: true, available: true, brightness: 140, colorMode: 'rgb', rgb: [0, 0, 255], kelvin: null, effect: null };
    g.ha.states.lamp = mine;                              // Ian picks blue in the Govee app
    const before = g.sent.length;
    assert.deepStrictEqual(await g.e.watch(), [], 'a new color must hold first');
    assert.deepStrictEqual(await g.e.watch(), []);
    assert.deepStrictEqual(await g.e.watch(), ['lamp'], 'held for 3 checks: Ian set it');
    assert.strictEqual(g.e.session.state(), 'off');
    assert.deepStrictEqual(g.ha.calls.map((c) => c.k), ['bars'], 'only the bars are put back');
    assert.deepStrictEqual(g.ha.states.lamp, mine, 'the lamp keeps what Ian set');
    await g.feed(clickTrack(120, 2));
    assert.ok(!g.sent.slice(before).some((m) => m.k === 'lamp'), 'nothing more sent to the lamp');
    assert.deepStrictEqual(g.e.report().events.map((x) => [x.type, x.lights]), [['gave-way', ['lamp']]]);
    assert.ok(g.logs.indexOf('music lights: gave way (floor lamp: color)') >= 0, g.logs.join(' | '));
  });

  await check('engine: the hub\'s own scene or light gives way with nothing put back', async () => {
    const g = rig();
    g.hub({ on: true });
    await g.feed(clickTrack(120, 2));
    g.hub({ on: false, offReason: 'gave-way', gaveWay: ['hub'] });
    await g.feed(silence(2));
    assert.strictEqual(g.e.session.state(), 'off');
    assert.deepStrictEqual(g.ha.calls, []);
  });

  await check('engine: palette and dials change live; no addresses means nothing starts', async () => {
    const g = rig();
    g.hub({ on: true, palette: 'ocean', vibrancy: 'low', beat: 'low' });
    await g.feed(clickTrack(120, 3));
    const last = g.sent.filter((m) => m.msg.cmd === 'ptReal').pop();
    const b = Buffer.from(last.msg.data.command[0], 'base64');
    assert.ok(b[6] >= b[4], 'ocean leans blue, not amber');
    const n = rig({ addresses: {} });
    n.hub({ on: true });
    assert.strictEqual(n.e.session.isOn(), false);
    assert.deepStrictEqual(n.types(), ['no-lights']);
  });

  await check('engine: without Home Assistant, Off switches the lights off rather than leaving music colors', async () => {
    const g = rig({ ha: null });
    g.hub({ on: true });
    await g.feed(clickTrack(120, 2));
    g.hub({ on: false, offReason: 'you' });
    await g.feed(silence(2));
    const offs = g.sent.filter((m) => m.msg.cmd === 'turn' && m.msg.data.value === 0).map((m) => m.k).sort();
    assert.deepStrictEqual(offs, ['bars', 'lamp']);
  });

  await check('engine: a late Home Assistant poll of the old state is not taken for a change', async () => {
    const ha = fakeHa({ lamp: LAMP_BEFORE, bars: BARS_BEFORE });
    const g = rig({ ha: ha });
    g.hub({ on: true });
    await g.feed(clickTrack(120, 1));
    ha.states.lamp = LAMP_BEFORE;                          // HA has not polled the lamp since the start
    g.t.now += engineLib.WATCH_SETTLE_MS;
    await g.feed(clickTrack(120, 1));
    assert.deepStrictEqual(await g.e.watch(), []);
    ha.states.lamp = { on: true, available: true, brightness: 140, colorMode: 'rgb', rgb: [47, 181, 163], kelvin: null, effect: null };
    assert.deepStrictEqual(await g.e.watch(), [], 'now it arms');
    assert.ok(g.e.session.isOn());
  });

  await check('engine: frames waiting on the speaker delay are dropped once it gives way', async () => {
    const g = rig({ delayMs: 40 });
    g.hub({ on: true });
    await g.feed(clickTrack(120, 2));
    g.hub({ on: false, offReason: 'gave-way', gaveWay: ['hub'] });
    const at = g.sent.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!g.sent.slice(at).some((m) => m.msg.cmd === 'ptReal'), 'a delayed frame landed after giving way');
  });

  await check('engine: Off right after On waits for the saved state, then puts it back (not switched off)', async () => {
    const g = rig({ ha: fakeHa({ lamp: LAMP_BEFORE, bars: BARS_BEFORE }, 40) });
    g.hub({ on: true });
    const s = g.e.shutdown();
    await s;
    await g.e.settled();
    assert.deepStrictEqual(g.ha.states.lamp, LAMP_BEFORE);
    assert.ok(!g.sent.some((m) => m.msg.cmd === 'turn' && m.msg.data.value === 0 && m.k === 'lamp'));
  });

  await check('engine: a WAV header from the capture is skipped', () => {
    const skip = engineLib.createWavSkip();
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0, 'latin1'); hdr.write('WAVE', 8, 'latin1'); hdr.write('fmt ', 12, 'latin1');
    hdr.writeUInt32LE(16, 16); hdr.write('data', 36, 'latin1');
    const pcm = Buffer.from([1, 2, 3, 4]);
    assert.deepStrictEqual([...skip(Buffer.concat([hdr, pcm]))], [1, 2, 3, 4]);
    assert.deepStrictEqual([...skip(Buffer.from([5]))], [5]);
  });

  await check('ha: restore puts back color temp, color or off; entity ids only from .env, never invented', () => {
    assert.deepStrictEqual(haLib.restoreCall('light.a', LAMP_BEFORE), { service: 'turn_on', body: { entity_id: 'light.a', brightness: 120, color_temp_kelvin: 2700 } });
    assert.deepStrictEqual(haLib.restoreCall('light.a', BARS_BEFORE).service, 'turn_off');
    const c = haLib.configFromEnv({ HA_TOKEN: 't', SOUNDLIGHTS_HA_LAMP: 'light.lamp_1', LIGHTS_HA_BARS: 'not an id' }, govee.LIGHTS);
    assert.deepStrictEqual(c.entities, { lamp: 'light.lamp_1' });
    assert.strictEqual(haLib.configFromEnv({ LIGHTS_WATCH: 'power' }, govee.LIGHTS).watch, 'power');
    assert.strictEqual(haLib.configFromEnv({ LIGHTS_WATCH: 'color' }, govee.LIGHTS).watch, 'color');
    assert.strictEqual(haLib.brightnessMoved(140, 132), false, 'read-back drift');
    assert.strictEqual(haLib.brightnessMoved(140, 60), true, 'dimmed in the app');
    const a = haLib.readState({ state: 'on', attributes: { rgb_color: [1, 2, 3], brightness: 9, color_mode: 'rgb' } });
    const b = Object.assign({}, a, { rgb: [9, 9, 9] });
    assert.strictEqual(haLib.fingerprint(a, 'power'), haLib.fingerprint(b, 'power'));
    assert.strictEqual(haLib.fingerprint(a, 'full'), haLib.fingerprint(b, 'full'), 'the color is checked on its own');
    assert.notStrictEqual(haLib.fingerprint(a, 'full'), haLib.fingerprint(Object.assign({}, a, { colorMode: 'color_temp', kelvin: 3000 }), 'full'));
    assert.strictEqual(haLib.colorIsOurs([6, 0, 0], []), true, 'dim read-back');
    assert.strictEqual(haLib.colorIsOurs([220, 120, 30], [[110, 60, 15]]), true, 'same mix, other brightness');
    assert.strictEqual(haLib.colorIsOurs([0, 0, 255], [[110, 60, 15]]), false);
  });

  /* ---------- the hub: store, routes, ./hub, mailbox ---------- */

  await check('store: settings saved to data/lights.json; the engine report answers settings and the song tempo', () => {
    const dir = tmpDir();
    let bpm = 0;
    const st = storeLib.createStore({ dataDir: dir, songBpm: () => bpm });
    st.change({ on: true, preset: 'chill' });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'lights.json'), 'utf8'));
    assert.strictEqual(saved.on, true);
    assert.strictEqual(saved.vibrancy, 'low');
    bpm = 121.4;
    const r = st.engineReport({ state: 'playing', lights: ['lamp', 'bars', 'evil'], events: [] });
    assert.strictEqual(r.song.bpm, 121);
    assert.strictEqual(r.settings.on, true);
    assert.deepStrictEqual(st.status().engine.lights, ['lamp', 'bars']);
    st.engineReport({ events: [{ type: 'quiet' }] });
    assert.strictEqual(st.settings().offReason, 'quiet');
    assert.strictEqual(storeLib.createStore({ dataDir: dir }).settings().on, false, 'kept across a restart');
  });

  await check('store: an event raised before the latest switch on is ignored (a resend cannot turn a new session off)', () => {
    const st = storeLib.createStore({ dataDir: tmpDir() });
    st.change({ on: true });
    const old = st.settings().rev;
    st.engineReport({ events: [{ type: 'quiet', rev: old }] });
    assert.strictEqual(st.settings().on, false);
    st.change({ on: true });
    st.engineReport({ events: [{ type: 'quiet', rev: old }] });
    assert.strictEqual(st.settings().on, true, 'the resent quiet was ignored');
  });

  await check('store: giveWay waits for the engine to report off (or gives up), and is instant without an engine', async () => {
    const st = storeLib.createStore({ dataDir: tmpDir() });
    assert.strictEqual(await st.giveWay('hub'), false);
    st.change({ on: true });
    assert.strictEqual(await st.giveWay('hub'), true, 'no engine running: at once');
    st.change({ on: true });
    st.engineReport({ state: 'playing', events: [] });
    let done = false;
    const p = st.giveWay('hub', 1000).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(done, false, 'waits while the engine still plays');
    st.engineReport({ state: 'off', events: [] });
    await p;
    assert.strictEqual(done, true);
  });

  await check('store: giving way only when on; the engine\'s gave-way names the light', async () => {
    const st = storeLib.createStore({ dataDir: tmpDir() });
    assert.strictEqual(await st.giveWay('hub'), false);
    st.change({ on: true });
    st.engineReport({ events: [{ type: 'gave-way', lights: ['bars'] }] });
    assert.deepStrictEqual([st.settings().on, st.settings().offReason, st.settings().gaveWay], [false, 'gave-way', ['bars']]);
    st.change({ on: true });
    assert.deepStrictEqual([st.settings().offReason, st.settings().gaveWay], ['', []]);
  });

  /* ---------- paired presets (looks.js) ---------- */

  const DUSK_LAMP = [[255, 19, 200], [230, 20, 240], [180, 30, 255], [140, 40, 255], [100, 50, 255], [60, 60, 255], [40, 70, 255]];
  // Magenta presets live on the Pi (they fire Ian's Govee snapshots), so
  // the tests bring LAN-only ones of their own.
  const LOCAL = {
    'magenta-dusk': looksLib.check({ id: 'magenta-dusk', name: 'Magenta dusk', lamp: { brightness: 48, gradient: DUSK_LAMP }, bars: { brightness: 48, color: [255, 19, 247] } }),
    'magenta-wave': looksLib.check({ id: 'magenta-wave', name: 'Magenta wave', motion: 'wave', lamp: { brightness: 48, gradient: DUSK_LAMP }, bars: { brightness: 48, gradient: [[255, 19, 247], [200, 25, 255], [255, 19, 247]] } })
  };
  const lookById = (id) => LOCAL[id] || looksLib.BUILT_IN.find((l) => l.id === id);
  // Hand the rig's engine settings plus the preset the hub would send.
  const hubLook = (g, fields, def) => {
    // The engine's first hub answer (no preset yet), as when it starts.
    if (!g.started) { g.started = true; g.e.applyHub({ settings: Object.assign({}, g.settings), look: null, song: { bpm: 0 } }, 0); }
    Object.assign(g.settings, fields, { rev: g.settings.rev + 1 });
    if (fields.look) g.settings.lookAt = g.settings.rev;
    g.e.applyHub({ settings: Object.assign({}, g.settings), look: g.settings.look ? (def || lookById(g.settings.look)) : null, song: { bpm: 0 } }, 0);
  };
  const tick = async (g, ms) => { for (let i = 0; i < ms / 100; i++) { g.t.now += 100; g.e.idle(); } await new Promise((r) => setImmediate(r)); await g.e.settled(); };
  const ptReals = (g, k, from) => g.sent.filter((x) => x.k === k && x.msg.cmd === 'ptReal' && x.t >= (from || 0));
  // The colors one light shows after these messages (by section).
  const shown = (msgs, n) => {
    const out = new Array(n).fill(null);
    msgs.forEach((x) => x.msg.data.command.forEach((f) => {
      const b = Buffer.from(f, 'base64');
      const mask = b[12] | (b[13] << 8);
      for (let i = 0; i < n; i++) if (mask & (1 << i)) out[i] = [b[4], b[5], b[6]];
    }));
    return out;
  };

  await check('looks: built-ins check out; a gradient lamp reads bottom to top (Magenta dusk) with solid magenta bars', () => {
    assert.ok(looksLib.BUILT_IN.length >= 4);
    ['octane', 'rainforest', 'thunderstorm', 'warm-drift'].forEach((id) => assert.ok(looksLib.BUILT_IN.find((l) => l.id === id), id));
    looksLib.BUILT_IN.forEach((l) => assert.ok(l.name && l.es, 'Spanish name for ' + l.id));
    const r = looksLib.resolve(lookById('magenta-dusk'), 0);
    assert.deepStrictEqual(r.lamp.colors, DUSK_LAMP);
    assert.deepStrictEqual(r.bars.colors, new Array(12).fill([255, 19, 247]));
    assert.deepStrictEqual([r.lamp.brightness, r.bars.brightness], [48, 48]);
    // Octane: gold at the top of both bars (sections 0 and 6), emerald at the bottom.
    const o = looksLib.resolve(lookById('octane'), 0);
    assert.deepStrictEqual([o.bars.colors[0], o.bars.colors[6], o.bars.colors[5]], [[255, 150, 0], [255, 150, 0], [0, 120, 20]]);
    assert.deepStrictEqual(o.lamp.colors[0], [0, 120, 20]);
    assert.deepStrictEqual(o.lamp.colors[6], [255, 150, 0]);
  });

  await check('looks: drift and wave move the colors along the lamp without new colors; checks refuse bad presets plainly', () => {
    const w = lookById('magenta-wave');
    const w0 = looksLib.resolve(w, 0).lamp.colors;
    const w1 = looksLib.resolve(w, looksLib.WAVE_PERIOD_MS / 4).lamp.colors;
    assert.notDeepStrictEqual(w0, w1);
    assert.deepStrictEqual(looksLib.resolve(w, looksLib.WAVE_PERIOD_MS).lamp.colors, w0, 'one wave is 17 s');
    assert.notDeepStrictEqual(w0[0], w0[3], 'each section is behind the one before');
    [w0, w1].forEach((cols) => cols.forEach((c) => c.forEach((v) => assert.strictEqual(v % 2, 0, 'rounded to even steps'))));
    const d = looksLib.check({ id: 'd', name: 'D', motion: 'drift', lamp: lookById('magenta-dusk').lamp, bars: { brightness: 40, color: [255, 19, 247] } });
    const a = looksLib.resolve(d, 0).lamp.colors;
    const b = looksLib.resolve(d, looksLib.DRIFT_PERIOD_MS / 4).lamp.colors;
    assert.notDeepStrictEqual(a, b, 'a quarter period later the lamp has moved');
    const inRange = (c) => c[0] >= 40 && c[0] <= 255 && c[2] >= 200;
    [a, b, w0, w1].forEach((cols) => cols.forEach((c) => assert.ok(inRange(c), c + ' is not a pink-purple-blue')));
    assert.throws(() => looksLib.check({ id: 'x', name: 'X', lamp: { brightness: 50 }, bars: { brightness: 50, color: [1, 2, 3] } }), /exactly one of/);
    assert.throws(() => looksLib.check({ id: 'x', name: 'X', lamp: { brightness: 0, color: [1, 2, 3] }, bars: { brightness: 50, color: [1, 2, 3] } }), /brightness must be 1-100/);
    assert.throws(() => looksLib.check({ id: 'x', name: 'X', lamp: { brightness: 5, sections: [[1, 2, 3]] }, bars: { brightness: 50, color: [1, 2, 3] } }), /sections must be 7/);
    assert.throws(() => looksLib.check({ id: 'Bad id', name: 'X' }), /id must be/);
    assert.strictEqual(looksLib.idFromName('Café rosado!'), 'my-cafe-rosado');
    const saved = looksLib.fromStates('Pink', { lamp: { on: true, available: true, brightness: 122, rgb: [255, 19, 247] }, bars: { on: true, available: true, brightness: 122, rgb: [255, 19, 247] } });
    assert.deepStrictEqual([saved.id, saved.lamp.brightness, saved.lamp.color], ['my-pink', 48, [255, 19, 247]]);
    assert.throws(() => looksLib.fromStates('Pink', { lamp: { on: false, available: true }, bars: { on: true, available: true } }), /floor lamp is off/);
  });

  await check('engine: a preset paints both lights (power, brightness, then section colors twice), nothing put back', async () => {
    const g = rig();
    hubLook(g, { look: 'magenta-dusk' });
    const setup = g.sent.filter((x) => x.t === 0).map((x) => x.k + ':' + x.msg.cmd);
    assert.deepStrictEqual(setup, ['lamp:turn', 'lamp:colorwc', 'lamp:brightness', 'bars:turn', 'bars:colorwc', 'bars:brightness']);
    assert.strictEqual(g.sent.find((x) => x.k === 'lamp' && x.msg.cmd === 'brightness').msg.data.value, 48);
    await tick(g, 1200);
    assert.deepStrictEqual(shown(ptReals(g, 'lamp'), 7), DUSK_LAMP);
    assert.deepStrictEqual(shown(ptReals(g, 'bars'), 12), new Array(12).fill([255, 19, 247]));
    const n = ptReals(g, 'lamp').length;
    assert.ok(n >= 2, 'sent twice');
    await tick(g, 3000);
    assert.strictEqual(ptReals(g, 'lamp').length, n, 'a still preset is not resent over and over');
    assert.deepStrictEqual(g.ha.calls, []);
    // The same settings resent do not paint again; a new pick of the same preset does.
    const before = g.sent.length;
    g.e.applyHub({ settings: Object.assign({}, g.settings), look: lookById('magenta-dusk'), song: { bpm: 0 } }, 0);
    assert.strictEqual(g.sent.length, before);
    hubLook(g, { look: 'magenta-dusk' });
    assert.ok(g.sent.length > before);
  });

  await check('engine: a wave preset keeps moving (ten updates a second at most); clearing it stops sending', async () => {
    const g = rig();
    hubLook(g, { look: 'magenta-wave' });
    await tick(g, 1200);
    const t0 = g.t.now;
    await tick(g, 10000);
    const n = ptReals(g, 'lamp', t0 + 1).length;
    assert.ok(n >= 30 && n <= 10 * 10 * 2, n + ' lamp messages in 10 s');
    hubLook(g, { look: '' });
    const t1 = g.t.now;
    await tick(g, 3000);
    assert.strictEqual(ptReals(g, 'lamp', t1 + 1).length, 0);
  });

  await check('engine: music lights pause a preset and paint it again when they stop (not the saved state)', async () => {
    const g = rig();
    hubLook(g, { look: 'magenta-dusk' });
    await tick(g, 1200);
    hubLook(g, { on: true });
    await g.feed(clickTrack(120, 3));
    assert.notStrictEqual(g.e.session.state(), 'off');
    const t0 = g.t.now;
    hubLook(g, { on: false, offReason: 'you' });
    await g.feed(silence(2));
    await tick(g, 1200);
    assert.strictEqual(g.e.session.state(), 'off');
    assert.deepStrictEqual(g.ha.calls, [], 'nothing put back from Home Assistant');
    assert.ok(g.logs.indexOf('music lights: preset painted again') >= 0, g.logs.join(' | '));
    assert.deepStrictEqual(shown(ptReals(g, 'lamp', t0), 7), DUSK_LAMP);
  });

  await check('engine: a preset picked while music plays stops it at once (no fade) and paints the preset', async () => {
    const g = rig();
    hubLook(g, { on: true });
    await g.feed(clickTrack(120, 3));
    hubLook(g, { on: false, offReason: 'look', look: 'octane' });
    assert.strictEqual(g.e.session.state(), 'off', 'no fade');
    await g.e.settled();
    const t0 = g.t.now;
    await tick(g, 1200);
    assert.deepStrictEqual(g.ha.calls, []);
    const o = looksLib.resolve(lookById('octane'), 0);
    assert.deepStrictEqual(shown(ptReals(g, 'bars', t0), 12), o.bars.colors);
  });

  await check('engine: a light set another way ends the preset and tells the hub (look-changed)', async () => {
    const g = rig();
    hubLook(g, { look: 'magenta-dusk' });
    await tick(g, 1200);
    g.t.now += engineLib.WATCH_SETTLE_MS;
    await g.e.watch();                       // notes the preset's state
    assert.deepStrictEqual(await g.e.watch(), []);
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { brightness: 250 });
    assert.deepStrictEqual(await g.e.watch(), ['lamp']);
    const ev = g.e.report().events.find((x) => x.type === 'look-changed');
    assert.ok(ev && ev.lookAt === g.settings.lookAt);
    assert.strictEqual(g.e.looking(), null);
  });

  await check('engine: after a restart a still preset is not painted over the lights; a moving one carries on', async () => {
    const g = rig();
    g.started = true;
    Object.assign(g.settings, { look: 'octane', lookAt: 7, rev: 8 });
    g.e.applyHub({ settings: Object.assign({}, g.settings), look: lookById('octane'), song: { bpm: 0 } }, 0);
    await tick(g, 3000);
    assert.strictEqual(g.sent.length, 0, 'nothing sent');
    const w = rig();
    w.started = true;
    Object.assign(w.settings, { look: 'magenta-wave', lookAt: 7, rev: 8 });
    w.e.applyHub({ settings: Object.assign({}, w.settings), look: lookById('magenta-wave'), song: { bpm: 0 } }, 0);
    await tick(w, 2000);
    assert.ok(!w.sent.some((x) => x.msg.cmd === 'turn' || x.msg.cmd === 'brightness'), 'no setup sent');
    assert.ok(ptReals(w, 'lamp').length >= 5, 'the wave carries on');
  });

  await check('engine: a slow Home Assistant read of the old state right after a preset is not taken for a change', async () => {
    const g = rig();
    hubLook(g, { look: 'magenta-dusk' });
    await tick(g, 1200);
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { brightness: 200 });   // still the old, brighter state
    g.t.now += engineLib.WATCH_SETTLE_MS;
    await g.e.watch();
    g.ha.states.lamp = Object.assign({}, g.ha.states.lamp, { brightness: 122 });   // now it shows 48%
    assert.deepStrictEqual(await g.e.watch(), []);
    assert.deepStrictEqual(await g.e.watch(), []);
    assert.ok(g.e.looking(), 'the preset is still on');
  });

  await check('store: picking a preset turns music lights off (reason look), unknown ids refused; a scene or the engine ends it', async () => {
    const st = storeLib.createStore({ dataDir: tmpDir() });
    st.change({ on: true });
    const r = st.change({ look: 'octane' });
    assert.deepStrictEqual([r.settings.on, r.settings.offReason, r.settings.look, r.settings.lookAt], [false, 'look', 'octane', r.settings.rev]);
    assert.throws(() => st.change({ look: 'nope' }), /no preset "nope"/);
    assert.deepStrictEqual(settingsLib.checkChange({ look: 'off' }), { look: '' }, 'Home Assistant sends "off"');
    assert.deepStrictEqual(settingsLib.checkChange({ look: 'none' }), { look: '' });
    assert.strictEqual(st.engineReport({}).look.id, 'octane');
    st.change({ on: true });
    assert.strictEqual(st.settings().look, 'octane', 'music on pauses the preset, it is kept');
    st.change({ on: false });
    assert.strictEqual(st.settings().look, 'octane');
    assert.strictEqual(await st.giveWay('hub'), false);
    assert.strictEqual(st.settings().look, '', 'an Ambience scene ends the preset');
    st.change({ look: 'rainforest' });
    st.engineReport({ events: [{ type: 'look-changed', lookAt: st.settings().lookAt - 1 }] });
    assert.strictEqual(st.settings().look, 'rainforest', 'news about an older pick is ignored');
    st.engineReport({ events: [{ type: 'look-changed', lookAt: st.settings().lookAt }] });
    assert.strictEqual(st.settings().look, '');
    assert.deepStrictEqual(Object.keys(st.screenData()), ['looks', 'on', 'music']);
  });

  await check('store: saved presets kept in data/lights-looks.json; built-in names protected; forget', () => {
    const dir = tmpDir();
    const st = storeLib.createStore({ dataDir: dir });
    const look = looksLib.fromStates('Pink', { lamp: { on: true, available: true, brightness: 122, rgb: [255, 19, 247] }, bars: { on: true, available: true, brightness: 122, rgb: [255, 19, 247] } });
    st.saveLook(look);
    const again = storeLib.createStore({ dataDir: dir });
    assert.ok(again.lookById('my-pink') && again.lookById('my-pink').saved);
    assert.throws(() => again.forgetLook('octane'), /built-in presets cannot be forgotten/);
    again.change({ look: 'my-pink' });
    again.forgetLook('my-pink');
    assert.strictEqual(again.settings().look, '');
    assert.strictEqual(storeLib.createStore({ dataDir: dir }).lookById('my-pink'), null);
  });

  const logs = [];
  const m = await mockLights.start({});
  const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'ambience.example.json'), 'utf8'));
  const h = hubServer.start({
    token: TOKEN, port: 0, host: '127.0.0.1', dataDir: tmpDir(), origins: ['http://127.0.0.1:8081'],
    log: (s) => logs.push(String(s)), ambience: { manual: true, timeoutMs: 300 },
    // Pretend the "geeni" light in the example is the Govee lamp.
    ambienceEnv: { HA_URL: m.url, HA_TOKEN: m.token, WLED_URL: m.wledUrl, LIGHTS_HA_LAMP: 'light.example_geeni_1' },
    lightsHa: fakeHa({ lamp: { on: true, available: true, brightness: 122, colorMode: 'rgb', rgb: [255, 19, 247], kelvin: null, effect: null }, bars: { on: true, available: true, brightness: 122, colorMode: 'rgb', rgb: [255, 19, 247], kelvin: null, effect: null } })
  });
  await h.ready;
  await h.api('POST', '/api/ambience/config', { config: EXAMPLE });
  const api = (m, r, b) => h.api(m, r, b).then((x) => x.body);

  await check('server: GET/POST /api/lights, engine report, Ambience scene turns music lights off (gave way)', async () => {
    const st = await api('GET', '/api/lights');
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.settings.on, false);
    assert.strictEqual(st.engine.running, false);
    assert.strictEqual(st.palettes.length, 8);
    const on = await api('POST', '/api/lights', { on: true, palette: 'sunset' });
    assert.strictEqual(on.settings.on, true);
    const bad = await h.api('POST', '/api/lights', { beat: 'max' });
    assert.strictEqual(bad.status, 400);
    const rep = await api('POST', '/api/lights/engine', { state: 'playing', lights: ['lamp'], ha: true, bpm: 120, events: [] });
    assert.strictEqual(rep.settings.palette, 'sunset');
    assert.strictEqual((await api('GET', '/api/lights')).engine.running, true);
    await h.api('POST', '/api/ambience/scene', { id: 'nope' });
    assert.strictEqual((await api('GET', '/api/lights')).settings.on, true, 'an unknown scene changes nothing');
    await h.api('POST', '/api/ambience/light', { id: 'camera', on: true });
    assert.strictEqual((await api('GET', '/api/lights')).settings.on, true, 'a light that is not the lamp or bars: music lights stay on');
    // The engine is running and playing: the scene waits until it reports off.
    const t0 = Date.now();
    const scene = h.api('POST', '/api/ambience/scene', { id: 'chill' });
    await new Promise((r) => setTimeout(r, 50));
    await api('POST', '/api/lights/engine', { state: 'off', events: [] });
    await scene;
    assert.ok(Date.now() - t0 < 2000, 'answered as soon as the engine stopped');
    const after = await api('GET', '/api/lights');
    assert.deepStrictEqual([after.settings.on, after.settings.offReason, after.settings.gaveWay], [false, 'gave-way', ['hub']]);
  });

  await check('./hub lights text: status, change and palettes read plainly', async () => {
    await api('POST', '/api/lights', { on: true, preset: 'groove', palette: 'warm-drift', quietMin: 15 });
    await api('POST', '/api/lights/engine', { state: 'resting', lights: ['lamp', 'bars'], ha: true, bpm: 0, events: [] });
    const lines = hubctl.lightsStatusLines(await api('GET', '/api/lights'));
    assert.deepStrictEqual(lines, [
      'Music lights: on, quiet, holding a calm glow (Warm drift, Groove: Vibrancy medium, Beat medium).',
      'Engine: running, drives the lamp and the light bars.',
      'Turns itself off after 15 quiet minutes and puts the lights back.'
    ]);
    const off = await api('POST', '/api/lights', { on: false });
    assert.strictEqual(hubctl.lightsChangeText(off, { on: false }), 'Music lights off (Warm drift, Groove: Vibrancy medium, Beat medium).');
    assert.strictEqual(hubctl.lightsChangeText(await api('POST', '/api/lights', { preset: 'groove' }), { preset: 'groove' }),
      'Music lights off (Warm drift, Groove: Vibrancy medium, Beat medium). Saved; still off: ./hub lights on starts them.');
    await api('POST', '/api/lights', { on: true });
    await api('POST', '/api/lights/engine', { events: [{ type: 'gave-way', lights: ['lamp'] }] });
    assert.strictEqual(hubctl.lightsStatusLines(await api('GET', '/api/lights'))[0],
      'Music lights: off: the lamp set another way, left as set (Warm drift, Groove: Vibrancy medium, Beat medium).');
    const pl = hubctl.lightsPaletteLines(await api('GET', '/api/lights'));
    assert.strictEqual(pl[0], 'warm-drift  Warm drift  (current)');
  });

  await check('mailbox: lights.on, lights.set (quiet "never"), lights.status; bad args refused before running', async () => {
    const mail = async (cmd, args) => {
      const env = mailbox.checkEnvelope('lt-test-1', Buffer.from(JSON.stringify({ id: 'lt-test-1', created: new Date().toISOString(), cmd: cmd, args: args })), Date.now());
      return mailbox.COMMANDS[env.cmd].run(env.args, { call: async (m, r, b) => { const x = await h.api(m, r, b); if (!x.body.ok) throw new Error(x.body.error); return x.body; } });
    };
    const r = await mail('lights.set', { preset: 'party', quiet: 'never', palette: 'aurora' });
    assert.match(r.message, /^Music lights off \(Aurora, Party: Vibrancy high, Beat high\)\. Saved; still off/);
    assert.strictEqual(r.data.settings.quietMin, 0);
    assert.match((await mail('lights.on')).message, /^Music lights on/);
    assert.match((await mail('lights.status')).message, /Never turns itself off\./);
    assert.throws(() => mailbox.checkEnvelope('lt-test-2', Buffer.from(JSON.stringify({ id: 'lt-test-2', created: new Date().toISOString(), cmd: 'lights.set', args: { beat: 'max' } })), Date.now()), /beat/);
    assert.throws(() => mailbox.checkEnvelope('lt-test-3', Buffer.from(JSON.stringify({ id: 'lt-test-3', created: new Date().toISOString(), cmd: 'lights.set', args: {} })), Date.now()), /say what to set/);
  });

  // A screen's call (the TV or phone: no token), over real HTTP.
  const scr = (method, p, body) => new Promise((resolve, reject) => {
    const http = require('http');
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: h.port, method: method, path: p, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(text);
  });

  await check('server: presets through /api/lights, save and forget, the screens\' /lights/look and lightlooks resource', async () => {
    await api('POST', '/api/lights', { on: false });
    const st0 = await scr('GET', '/live/state');
    assert.ok(st0.body.resources.lightlooks.data.looks.some((l) => l.id === 'octane'));
    const picked = await api('POST', '/api/lights', { look: 'octane' });
    assert.strictEqual(picked.settings.look, 'octane');
    assert.strictEqual(hubctl.lightsLookText(picked, 'octane').indexOf('Octane on the lamp and light bars'), 0);
    assert.strictEqual((await h.api('POST', '/api/lights', { look: 'nope' })).status, 400);
    const sv = await api('POST', '/api/lights/looks', { save: 'Pink evening' });
    assert.strictEqual(hubctl.lightsSavedText(sv), 'Saved "Pink evening" (lamp 48%, bars 48%, one color each); ./hub lights preset my-pink-evening sets it.');
    const lines = hubctl.lightsLookLines(await api('GET', '/api/lights'));
    assert.ok(lines.indexOf('octane  Octane  (on)') >= 0, lines.join(' | '));
    assert.ok(lines.indexOf('my-pink-evening  Pink evening  (saved)') >= 0);
    // The TV picks one (no token), and the resource follows.
    const tv = await scr('POST', '/lights/look', { id: 'my-pink-evening' });
    assert.strictEqual(tv.status, 200, JSON.stringify(tv.body));
    assert.strictEqual(tv.body.lightlooks.on, 'my-pink-evening');
    assert.strictEqual((await scr('POST', '/lights/look', { id: 'nope' })).status, 400);
    assert.strictEqual((await scr('GET', '/live/state')).body.resources.lightlooks.data.on, 'my-pink-evening');
    assert.strictEqual((await h.api('POST', '/api/lights/looks', { forget: 'octane' })).status, 400);
    await api('POST', '/api/lights/looks', { forget: 'my-pink-evening' });
    assert.strictEqual((await api('GET', '/api/lights')).settings.look, '');
  });

  /* ---------- Govee app snapshots (govee-cloud.js) ---------- */

  const DEVICES = { code: 200, data: [
    { sku: 'H6076', device: 'AA:BB', capabilities: [{ type: 'devices.capabilities.dynamic_scene', instance: 'snapshot', parameters: { options: [{ name: 'Chill magenta and blue', value: 101 }] } }] },
    { sku: 'H6056', device: 'CC:DD', capabilities: [{ type: 'devices.capabilities.dynamic_scene', instance: 'snapshot', parameters: { options: [{ name: 'Chill purple and blue', value: 202 }] } }] },
    { sku: 'H9999', device: 'EE:FF', capabilities: [] }
  ] };
  const CHILL = { id: 'my-chill', name: 'Chill', lamp: { snapshot: 'Chill magenta and blue' }, bars: { snapshot: 'Chill purple and blue' } };
  const CHILL_MOVING = { id: 'my-chill-moving', name: 'Chill moving', motion: 'wave',
    lamp: { brightness: 48, gradient: [[255, 19, 200], [230, 20, 240], [180, 30, 255], [140, 40, 255], [100, 50, 255], [60, 60, 255], [40, 70, 255]] }, bars: { snapshot: 'Chill purple and blue' } };

  await check('cloud: snapshots found by light model and name; calls to one light kept 6.5 s apart; a newer call replaces a waiting one', async () => {
    const calls = [];
    const t = { now: 100000 };
    const waits = [];
    const c = cloudLib.createCloud({
      key: 'k', now: () => t.now,
      wait: (ms) => { waits.push(ms); t.now += ms; return Promise.resolve(); },
      http: async (m, p, b) => { calls.push({ m: m, p: p, b: b }); return m === 'GET' ? DEVICES : { code: 200 }; }
    });
    assert.deepStrictEqual(await c.snapshotNames(), { lamp: ['Chill magenta and blue'], bars: ['Chill purple and blue'] });
    assert.strictEqual(await c.fire('bars', 'chill PURPLE and blue'), true);
    const ctl = calls.find((x) => x.m === 'POST');
    assert.deepStrictEqual(ctl.b.payload, { sku: 'H6056', device: 'CC:DD', capability: { type: 'devices.capabilities.dynamic_scene', instance: 'snapshot', value: 202 } });
    assert.strictEqual(await c.fire('bars', 'Chill purple and blue'), true);
    assert.ok(waits[0] >= 6000, 'waited ' + waits[0]);
    assert.strictEqual(await c.fire('lamp', 'Nope'), false, 'an unknown name');
    assert.strictEqual(calls.filter((x) => x.m === 'GET').length, 2, 'an unknown name reads the list again once');
    const noKey = cloudLib.createCloud({ key: '', log: () => {} });
    assert.strictEqual(await noKey.fire('lamp', 'x'), false);
  });

  await check('looks + engine: a snapshot preset fires both snapshots in the cloud; Chill moving waves the lamp under the bars\' snapshot', async () => {
    const chill = looksLib.check(CHILL);
    assert.throws(() => looksLib.check({ id: 'x', name: 'X', lamp: { snapshot: '' }, bars: { snapshot: 'a' } }), /snapshot must be/);
    const fired = [];
    const mk = () => {
      const g = rig();
      g.e = engineLib.createEngine({
        addresses: { lamp: 'x', bars: 'y' }, send: (k, buf) => g.sent.push({ k: k, t: g.t.now, msg: JSON.parse(buf.toString()).msg }),
        ha: g.ha, now: () => g.t.now, log: (s) => g.logs.push(s), capture: null, delayMs: 0,
        cloud: { configured: true, fire: async (k, n) => { fired.push(k + ':' + n); return true; }, snapshotNames: async () => ({}) }
      });
      return g;
    };
    const g = mk();
    hubLook(g, { look: 'my-chill' }, chill);
    await tick(g, 1500);
    assert.deepStrictEqual(fired, ['lamp:Chill magenta and blue', 'bars:Chill purple and blue']);
    assert.strictEqual(ptReals(g, 'lamp').length + ptReals(g, 'bars').length, 0, 'no section colors over a snapshot');
    assert.ok(!g.sent.some((x) => x.msg.cmd === 'colorwc'), 'colorwc would leave the snapshot');
    fired.length = 0;
    const g2 = mk();
    hubLook(g2, { look: 'my-chill-moving' }, looksLib.check(CHILL_MOVING));
    await tick(g2, 1200);
    const t0 = g2.t.now;
    await tick(g2, 6000);
    assert.deepStrictEqual(fired, ['bars:Chill purple and blue']);
    assert.ok(ptReals(g2, 'lamp', t0 + 1).length >= 20, 'the lamp waves');
    assert.strictEqual(ptReals(g2, 'bars').length, 0);
  });

  await check('server + ./hub: add a snapshot preset, list snapshots from the engine report; the screens see no colors for it', async () => {
    await api('POST', '/api/lights/engine', { state: 'off', lights: ['lamp', 'bars'], ha: true, events: [], snapshots: { lamp: ['Chill magenta and blue'], bars: ['Chill purple and blue'] } });
    assert.deepStrictEqual(hubctl.lightsSnapshotLines(await api('GET', '/api/lights')), ['Floor lamp: "Chill magenta and blue"', 'Light bars: "Chill purple and blue"']);
    const r = await api('POST', '/api/lights/looks', { add: CHILL });
    assert.strictEqual(hubctl.lightsSavedText(r), 'Saved "Chill" (lamp Govee snapshot "Chill magenta and blue", bars Govee snapshot "Chill purple and blue"); ./hub lights preset my-chill sets it.');
    const l = (await scr('GET', '/live/state')).body.resources.lightlooks.data.looks.find((x) => x.id === 'my-chill');
    assert.deepStrictEqual([l.lamp, l.bars], [null, null]);
    assert.strictEqual((await h.api('POST', '/api/lights/looks', { add: { id: 'octane', name: 'Octane', lamp: { snapshot: 'a' }, bars: { snapshot: 'b' } } })).status, 400);
    assert.strictEqual((await h.api('POST', '/api/lights/looks', { add: { id: 'x' } })).status, 400);
    await api('POST', '/api/lights/looks', { forget: 'my-chill' });
  });

  await check('mailbox: lights.presets, lights.preset (off clears), refused without an id', async () => {
    const mail = async (cmd, args) => {
      const env = mailbox.checkEnvelope('lp-test-1', Buffer.from(JSON.stringify({ id: 'lp-test-1', created: new Date().toISOString(), cmd: cmd, args: args })), Date.now());
      return mailbox.COMMANDS[env.cmd].run(env.args, { call: async (mm, r, b) => { const x = await h.api(mm, r, b); if (!x.body.ok) throw new Error(x.body.error); return x.body; } });
    };
    assert.match((await mail('lights.presets')).message, /octane {2}Octane/);
    assert.match((await mail('lights.preset', { id: 'rainforest' })).message, /^Rainforest on the lamp and light bars/);
    assert.strictEqual((await mail('lights.preset', { id: 'off' })).message, 'No preset on; the lights stay as they are.');
    assert.throws(() => mailbox.checkEnvelope('lp-test-2', Buffer.from(JSON.stringify({ id: 'lp-test-2', created: new Date().toISOString(), cmd: 'lights.preset', args: {} })), Date.now()), /id/);
  });

  await check('server log: the engine\'s once-a-second report is never logged; changes are, without names', async () => {
    const before = logs.length;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => {
      const http = require('http');
      const body = JSON.stringify({ state: 'playing', events: [] });
      const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/api/lights/engine', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
      req.end(body);
    });
    assert.ok(!logs.slice(before).some((l) => /lights\/engine/.test(l)), logs.slice(before).join(' | '));
    assert.ok(logs.some((l) => /music lights: switched on/.test(l)));
  });

  await new Promise((r) => h.close(r));
  await m.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('FAIL (crash) ' + (e && e.stack)); process.exit(1); });
