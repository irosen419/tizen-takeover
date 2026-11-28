#!/usr/bin/env node
// forest-render: the Pi draws WLED's "Slow forest" itself and streams every
// LED to the plant wall over UDP (DRGB, 30 fps), so thunder can dim just 2 to 4
// bulbs behind a canvas, same hue, and let them fade back.
//
// Run:
//   node forest-render.js --host <ip> --probe      (see what WLED reports, send nothing)
//   node forest-render.js --host <ip> --auto       (stream, thunder every 8-25 s)
//   node forest-render.js --dry-run --auto         (draw only, no network)
//   echo -n "thunder 3" > /dev/udp/127.0.0.1/4810  (cue thunder; or kill -USR1 <pid>)
// Flags: --host (or WLED_HOST), --auto, --fps, --cycle, --spans, --gamma <n|off>,
//   --groups, --max-ma, --no-preset, --probe, --dry-run, --seed, --control-port.
//
// It only reads /json/cfg, /json/state and /presets.json and sends one
// {"on":true,"ps":2}. It never edits or saves WLED presets or config.
// On stop it sends the DRGB "leave stream" packet; WLED also falls back by
// itself 2 s after the last frame.
'use strict';

const NAME = 'forest-render';
const LED_COUNT = 164;

// Wall map (28 Nov numbering).
const WALL = {
  total: LED_COUNT,
  sections: [
    { name: 'guitar', start: 0, end: 49, dim: [29, 49] },
    { name: 'drum', start: 50, end: 111, dim: [50, 111] },
    { name: 'mic', start: 112, end: 161, dim: [141, 161] },
  ],
  spare: [162, 163],
};

// WLED firmware Forest palette, 16 steps.
const PALETTE_HEX = [
  '006400', '006400', '556B2F', '006400', '008000', '228B22', '6B8E23', '008000',
  '2E8B57', '66CDAA', '32CD32', '9ACD32', '90EE90', '7CFC00', '66CDAA', '228B22',
];
const PALETTE = PALETTE_HEX.map((h) => [
  parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
]);

const DEFAULTS = {
  fps: 30, cycle: 65.5, spans: 1, gamma: 2.8, groups: 1, maxMa: 800,
  controlPort: 4810, udpPort: 21324, bri: 255,
};
const BASE_MA = 100 + 1 * LED_COUNT; // controller + 1 mA standby per LED
const DEFAULT_LED_MA = 55; // mA per LED at full white
const MA_PER_CHANNEL = DEFAULT_LED_MA / 3;
const ATTACK = 0.25;
const RELEASE = 0.9;
const DIM_FLOOR = 0.15;

// ---------- random ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- palette and drift ----------

function wrap256(x) {
  const m = x % 256;
  return m < 0 ? m + 256 : m;
}

// index 0..256 (fractional, wraps). Returns [r,g,b] floats.
function paletteColor(index) {
  const pos = wrap256(index) / 16;
  const i0 = Math.floor(pos) % 16;
  const i1 = (i0 + 1) % 16;
  const f = pos - Math.floor(pos);
  const a = PALETTE[i0];
  const b = PALETTE[i1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Same sum as WLED's Palette effect, with fractions.
function paletteIndex(i, len, t, cycleSeconds, spans) {
  return wrap256((i * 255) / len * spans - (t * 256) / cycleSeconds);
}

// Undimmed, un-gamma'd picture: Float64Array of 164*3 in 0..255.
function renderLinear(t, cycleSeconds, spans) {
  const out = new Float64Array(LED_COUNT * 3);
  for (const s of WALL.sections) {
    const len = s.end - s.start + 1;
    for (let i = 0; i < len; i++) {
      const c = paletteColor(paletteIndex(i, len, t, cycleSeconds, spans));
      const k = (s.start + i) * 3;
      out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2];
    }
  }
  return out;
}

// ---------- gamma ----------

function gammaValue(v, g) {
  if (g === 1) return v;
  return 255 * Math.pow(v / 255, g);
}

function gammaTable(g) {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = gammaValue(i, g);
  return t;
}

// ---------- frame ----------

// Gamma then fixed power scale, before dimming and rounding.
function renderBase(t, o) {
  const lin = renderLinear(t, o.cycle, o.spans);
  const scale = o.scale == null ? 1 : o.scale;
  for (let k = 0; k < lin.length; k++) lin[k] = gammaValue(lin[k], o.gamma) * scale;
  return lin;
}

// One multiplier per LED, equal on r,g,b, then round.
function applyDim(base, mult) {
  const out = new Uint8Array(LED_COUNT * 3);
  for (let led = 0; led < LED_COUNT; led++) {
    const m = mult ? mult[led] : 1;
    const k = led * 3;
    out[k] = Math.round(base[k] * m);
    out[k + 1] = Math.round(base[k + 1] * m);
    out[k + 2] = Math.round(base[k + 2] * m);
  }
  for (let led = WALL.spare[0]; led <= WALL.spare[1]; led++) {
    out[led * 3] = 0; out[led * 3 + 1] = 0; out[led * 3 + 2] = 0;
  }
  return out;
}

function renderFrame(t, o, mult) {
  return applyDim(renderBase(t, o), mult);
}

// ---------- power ----------

// ledMa: per-LED mA at full white (array of 164); missing = 55 for all.
function ledPartMa(frame, bri, ledMa) {
  let sum = 0;
  for (let led = 0; led < LED_COUNT; led++) {
    const k = led * 3;
    const per = ledMa ? ledMa[led] : DEFAULT_LED_MA;
    sum += ((frame[k] + frame[k + 1] + frame[k + 2]) / 255) * (per / 3);
  }
  return sum * ((bri == null ? 255 : bri) / 255);
}

function estimateMa(frame, bri, ledMa) {
  return BASE_MA + ledPartMa(frame, bri, ledMa);
}

function defaultLedMa() {
  return new Float64Array(LED_COUNT).fill(DEFAULT_LED_MA);
}

// cfg.hw.led.ins -> { outputs: [{start, len, ledma|null}], ledMa: Float64Array(164) }.
// ledma counts only as a number 1..100; anything else (255, 0, text) uses 55.
function parseLedMa(cfg) {
  const ledMa = defaultLedMa();
  const outputs = [];
  const ins = get(cfg, ['hw', 'led', 'ins']);
  if (!Array.isArray(ins)) return { outputs, ledMa };
  for (const o of ins) {
    if (!o || typeof o !== 'object') continue;
    const start = o.start, len = o.len;
    if (!Number.isInteger(start) || !Number.isInteger(len) || start < 0 || len <= 0) continue;
    const ok = typeof o.ledma === 'number' && isFinite(o.ledma) && o.ledma >= 1 && o.ledma <= 100;
    outputs.push({ start, len, ledma: ok ? o.ledma : null });
    if (!ok) continue;
    for (let led = start; led < Math.min(LED_COUNT, start + len); led++) ledMa[led] = o.ledma;
  }
  return { outputs, ledMa };
}

// Worst LED part over one whole drift cycle, gamma only, no dimming.
function peakLedPart(o, steps) {
  const n = steps || 256;
  let peak = 0;
  for (let k = 0; k < n; k++) {
    const base = renderBase(k / n, { cycle: 1, spans: o.spans, gamma: o.gamma, scale: 1 });
    peak = Math.max(peak, ledPartMa(base, o.bri, o.ledMa));
  }
  return peak;
}

// One scale for every frame. The plan's formula, then a trim (at any scale,
// 1 included) until the rounded frames of 1024 cycle samples stay 1% under
// max-ma, which also covers the moments between samples.
function fixedScale(o) {
  const peak = peakLedPart(o, 256);
  const budget = o.maxMa - BASE_MA;
  let scale = peak > 0 ? Math.min(1, budget / peak) : 1;
  const limit = o.maxMa - Math.max(1, 0.01 * o.maxMa);
  for (let tries = 0; tries < 400; tries++) {
    if (peakRoundedMa(o, scale, 1024) <= limit) break;
    scale *= 0.995;
  }
  return scale;
}

function peakRoundedMa(o, scale, steps) {
  let peak = 0;
  for (let k = 0; k < steps; k++) {
    const f = renderFrame(k / steps, { cycle: 1, spans: o.spans, gamma: o.gamma, scale });
    peak = Math.max(peak, estimateMa(f, o.bri, o.ledMa));
  }
  return peak;
}

// ---------- thunder ----------

const DIM_RANGES = WALL.sections.map((s) => s.dim);

function pickGroup(rng, t) {
  const total = DIM_RANGES.reduce((n, r) => n + (r[1] - r[0] + 1), 0);
  let pick = rng() * total;
  let range = DIM_RANGES[DIM_RANGES.length - 1];
  for (const r of DIM_RANGES) {
    const n = r[1] - r[0] + 1;
    if (pick < n) { range = r; break; }
    pick -= n;
  }
  const len = 2 + Math.min(2, Math.floor(rng() * 3));
  const span = range[1] - range[0] + 1;
  const first = range[0] + Math.min(span - len, Math.floor(rng() * (span - len + 1)));
  const depth = 0.5 + rng() * 0.25;
  const hold = 1 + rng() * 1.5;
  return { first, last: first + len - 1, depth, hold, t0: t };
}

const MAX_NEW_PER_FRAME = 6;
const MAX_ACTIVE = 12;

// Adds up to n groups, at most 6 per call (one call per frame) and 12 active.
function addThunder(groups, t, rng, n) {
  const room = Math.max(0, Math.min(MAX_NEW_PER_FRAME, MAX_ACTIVE - groups.length));
  const take = Math.max(0, Math.min(n, room));
  const added = [];
  for (let i = 0; i < take; i++) added.push(pickGroup(rng, t));
  return { groups: groups.concat(added), added, dropped: Math.max(0, n - take) };
}

function groupEnd(g) {
  return g.t0 + ATTACK + g.hold + RELEASE;
}

// Multiplier for one group at time t (cosine ease down, hold, ease back to 1).
function envelope(g, t) {
  const dt = t - g.t0;
  if (dt <= 0) return 1;
  if (dt < ATTACK) return 1 - g.depth * (1 - Math.cos(Math.PI * dt / ATTACK)) / 2;
  if (dt < ATTACK + g.hold) return 1 - g.depth;
  if (dt < ATTACK + g.hold + RELEASE) {
    const u = (dt - ATTACK - g.hold) / RELEASE;
    return 1 - g.depth * (1 + Math.cos(Math.PI * u)) / 2;
  }
  return 1;
}

function pruneThunder(groups, t) {
  return groups.filter((g) => t < groupEnd(g));
}

// Float64Array(164) of multipliers; overlaps multiply, floor 0.15.
function dimMultipliers(groups, t) {
  const m = new Float64Array(LED_COUNT).fill(1);
  for (const g of groups) {
    const e = envelope(g, t);
    for (let led = g.first; led <= g.last; led++) m[led] *= e;
  }
  for (let led = 0; led < LED_COUNT; led++) if (m[led] < DIM_FLOOR) m[led] = DIM_FLOOR;
  return m;
}

function nextAutoGap(rng) {
  return 8 + rng() * 17;
}

// ---------- packets ----------

function buildFramePacket(frame) {
  const buf = Buffer.alloc(2 + LED_COUNT * 3);
  buf[0] = 2; // DRGB
  buf[1] = 2; // back to normal 2 s after the last packet
  for (let k = 0; k < LED_COUNT * 3; k++) buf[2 + k] = frame[k] || 0;
  for (let led = WALL.spare[0]; led <= WALL.spare[1]; led++) buf.fill(0, 2 + led * 3, 2 + led * 3 + 3);
  return buf;
}

function buildStopPacket() {
  return Buffer.from([2, 0]);
}

// ---------- probe ----------

function get(obj, path) {
  let o = obj;
  for (const p of path) {
    if (o == null || typeof o !== 'object') return undefined;
    o = o[p];
  }
  return o;
}

function cycleFromSpeed(sx) {
  if (typeof sx !== 'number' || !isFinite(sx)) return DEFAULTS.cycle;
  const v = Math.max(0, Math.min(255, Math.floor(sx)));
  if (v === 0) return DEFAULTS.cycle;
  return 65.536 / ((v >> 3) + 1);
}

// raw = { cfg, state, presets }, each may be null.
function parseProbe(raw) {
  const r = raw || {};
  const cfg = r.cfg, state = r.state, presets = r.presets;
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const liveEn = bool(get(cfg, ['if', 'live', 'en']));
  const mso = bool(get(cfg, ['if', 'live', 'mso']));
  const noGc = bool(get(cfg, ['if', 'live', 'no-gc']));
  const gcCol = num(get(cfg, ['light', 'gc', 'col']));
  const port0 = num(get(cfg, ['if', 'sync', 'port0']));
  const maxbri = bool(get(cfg, ['if', 'live', 'maxbri']));
  const maxPwr = num(get(cfg, ['hw', 'led', 'maxpwr']));
  const on = bool(get(state, ['on']));
  const sx = num(get(presets, ['2', 'seg', 0, 'sx']));
  const cfgOk = cfg != null && typeof cfg === 'object';
  const stateBri = briFromState(state, false, undefined);
  // worst case: unknown cfg (maxbri unknown) or forced max brightness -> 255
  const bri = cfgOk && maxbri !== true && stateBri != null ? stateBri : 255;
  const led = parseLedMa(cfg);
  return {
    realtime: liveEn !== false,
    mainSegmentOnly: mso === true,
    noGc,
    gcCol,
    port: port0 != null && port0 >= 1 && port0 <= 65535 && Number.isInteger(port0) ? port0 : DEFAULTS.udpPort,
    cfgOk,
    maxbri: maxbri === true,
    stateBri,
    bri,
    on,
    sx,
    cycleSeconds: cycleFromSpeed(sx),
    maxPwr,
    outputs: led.outputs,
    ledMa: led.ledMa,
  };
}

// Brightness from a /json/state answer; realtime max brightness forces 255.
function briFromState(state, maxbri, fallback) {
  if (maxbri) return 255;
  const b = get(state, ['bri']);
  return typeof b === 'number' && isFinite(b) && b >= 0 && b <= 255 ? b : fallback;
}

// Brightness for the power scale after the preset call: the re-read, else 255.
function briAfterPreset(probe, state) {
  if (!probe || !probe.cfgOk || probe.maxbri) return 255;
  return briFromState(state, false, 255);
}

// UDP send result -> a log message on change of reachability, else null.
function trackSend(st, err) {
  if (err && !st.down) { st.down = true; return 'WLED not reachable, still trying'; }
  if (!err && st.down) { st.down = false; return 'WLED reachable again'; }
  return null;
}

// flag: null (not given), 'off', or a number.
function decideGamma(probe, flag) {
  if (flag === 'off') return { gamma: 1, why: 'set by --gamma' };
  if (typeof flag === 'number') return { gamma: flag, why: 'set by --gamma' };
  const p = probe || {};
  if (p.noGc === false) return { gamma: 1, why: 'WLED corrects streamed colours itself' };
  if (typeof p.gcCol === 'number' && isFinite(p.gcCol)) {
    const g = Math.max(1, Math.min(3, p.gcCol));
    return { gamma: g, why: g === 1 ? 'WLED colour gamma off, sending raw' : 'WLED colour gamma' };
  }
  return { gamma: DEFAULTS.gamma, why: 'default' };
}

// ---------- trigger text ----------

function parseTrigger(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (s === 'quit') return { cmd: 'quit' };
  const m = /^thunder(?:\s+(-?\d+))?$/.exec(s);
  if (!m) return null;
  let n = m[1] == null ? 1 : parseInt(m[1], 10);
  n = Math.max(1, Math.min(6, n));
  return { cmd: 'thunder', n };
}

// ---------- args ----------

// host or host:port (IPv4 address or name; no IPv6 literals).
function parseHost(s) {
  const str = String(s == null ? '' : s).trim();
  const parts = str.split(':');
  if (parts.length > 2) return null;
  const hostname = parts[0];
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostname)) return null;
  if (parts.length === 1) return { hostname, port: 80 };
  if (!/^\d{1,5}$/.test(parts[1])) return null;
  const port = parseInt(parts[1], 10);
  if (port < 1 || port > 65535) return null;
  return { hostname, port };
}

const USAGE = 'usage: node forest-render.js --host <ip[:port]> [--auto] [--fps 30] [--cycle <s>] ' +
  '[--spans 1] [--gamma <n|off>] [--groups 1] [--max-ma 800] [--no-preset] [--probe] ' +
  '[--dry-run] [--seed <n>] [--control-port 4810]   (host also from WLED_HOST)';

function parseArgs(argv, env) {
  const valued = ['host', 'fps', 'cycle', 'spans', 'gamma', 'groups', 'max-ma', 'seed', 'control-port'];
  const bools = ['auto', 'no-preset', 'probe', 'dry-run', 'help'];
  const raw = {};
  const fail = (error) => ({ ok: false, error, code: 2 });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return fail('unexpected argument ' + a);
    let key = a.slice(2), val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (bools.includes(key)) {
      if (val !== undefined) return fail('--' + key + ' takes no value');
      raw[key] = true;
    } else if (valued.includes(key)) {
      if (val === undefined) {
        if (i + 1 >= argv.length) return fail('--' + key + ' needs a value');
        val = argv[++i];
      }
      raw[key] = val;
    } else {
      return fail('unknown flag --' + key);
    }
  }
  if (raw.help) return { ok: false, help: true, code: 0 };

  const numFlag = (key, lo, hi, int) => {
    if (raw[key] === undefined) return { v: undefined };
    const v = Number(raw[key]);
    if (raw[key] === '' || !isFinite(v) || (int && !Number.isInteger(v)) || v < lo || v > hi) {
      return { err: '--' + key + ' must be ' + (int ? 'a whole number ' : 'a number ') + lo + ' to ' + hi };
    }
    return { v };
  };
  const o = {
    host: null, auto: !!raw.auto, noPreset: !!raw['no-preset'], probe: !!raw.probe,
    dryRun: !!raw['dry-run'], fps: DEFAULTS.fps, cycle: null, spans: DEFAULTS.spans,
    gamma: null, groups: DEFAULTS.groups, maxMa: DEFAULTS.maxMa, seed: null,
    controlPort: DEFAULTS.controlPort,
  };
  const checks = [
    ['fps', 'fps', 1, 60, true],
    ['spans', 'spans', 0.1, 8, false],
    ['groups', 'groups', 1, 6, true],
    ['max-ma', 'maxMa', 300, 1000, false],
    ['control-port', 'controlPort', 1, 65535, true],
    ['seed', 'seed', -4294967296, 4294967296, true],
  ];
  for (const [key, field, lo, hi, int] of checks) {
    const r = numFlag(key, lo, hi, int);
    if (r.err) return fail(r.err);
    if (r.v !== undefined) o[field] = r.v;
  }
  if (raw.cycle !== undefined) {
    const v = Number(raw.cycle);
    if (raw.cycle === '' || !isFinite(v) || v <= 1) return fail('--cycle must be a number above 1');
    o.cycle = v;
  }
  if (raw.gamma !== undefined) {
    if (String(raw.gamma).toLowerCase() === 'off') o.gamma = 'off';
    else {
      const v = Number(raw.gamma);
      if (raw.gamma === '' || !isFinite(v) || v < 0.1 || v > 5) return fail('--gamma must be off or a number 0.1 to 5');
      o.gamma = v;
    }
  }
  const hostStr = raw.host !== undefined ? raw.host : (env && env.WLED_HOST) || '';
  if (hostStr) {
    o.host = parseHost(hostStr);
    if (!o.host) return fail('--host must be host or host:port');
  }
  if (o.probe && o.dryRun) return fail('--probe and --dry-run cannot be used together');
  if (!o.host && !o.dryRun) return fail('no host given');
  return { ok: true, opts: o };
}

// ---------- log text ----------

function fmtGamma(g) {
  return Number.isInteger(g * 10) ? g.toFixed(1) : g.toFixed(2);
}

function streamingLine(fps, cycle, gamma, scale, ma) {
  return NAME + ': streaming ' + LED_COUNT + ' LEDs at ' + fps + ' fps, cycle ' + cycle.toFixed(1) +
    ' s, gamma ' + fmtGamma(gamma) + ', scale ' + scale.toFixed(2) + ', est ' + Math.round(ma) + ' mA';
}

function thunderLine(g) {
  return NAME + ': thunder, LEDs ' + g.first + '-' + g.last + ' down ' + Math.round(g.depth * 100) +
    '% for ' + g.hold.toFixed(1) + ' s';
}

const STOPPED_LINE = NAME + ': stopped, WLED back on its own';

module.exports = {
  NAME, LED_COUNT, WALL, PALETTE_HEX, PALETTE, DEFAULTS, BASE_MA, MA_PER_CHANNEL,
  ATTACK, RELEASE, DIM_FLOOR, DIM_RANGES, USAGE, STOPPED_LINE,
  DEFAULT_LED_MA, defaultLedMa, parseLedMa, briFromState, briAfterPreset, trackSend,
  MAX_NEW_PER_FRAME, MAX_ACTIVE,
  mulberry32, wrap256, paletteColor, paletteIndex, renderLinear, gammaValue, gammaTable,
  renderBase, applyDim, renderFrame, ledPartMa, estimateMa, peakLedPart, fixedScale,
  pickGroup, addThunder, groupEnd, envelope, pruneThunder, dimMultipliers, nextAutoGap,
  buildFramePacket, buildStopPacket, cycleFromSpeed, parseProbe, decideGamma,
  parseTrigger, parseHost, parseArgs, fmtGamma, streamingLine, thunderLine,
};

// ---------- CLI ----------

if (require.main === module) {
  // Signals first, so SIGUSR1 never opens Node's inspector and a stop during
  // startup is clean. Cues wait in `pending` until the loop runs.
  let pending = 0;
  let stopFn = null;
  let earlyStop = false;
  let groupsPerCue = 1;
  process.on('SIGUSR1', () => { pending += groupsPerCue; });
  process.on('SIGINT', () => (stopFn ? stopFn() : (earlyStop = true)));
  process.on('SIGTERM', () => (stopFn ? stopFn() : (earlyStop = true)));

  const http = require('node:http');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
  const crypto = require('node:crypto');
  const { performance } = require('node:perf_hooks');

  const log = (msg) => console.log(NAME + ': ' + msg);

  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    if (parsed.help) { console.log(USAGE); process.exit(0); }
    console.error(NAME + ': ' + parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  const opts = parsed.opts;
  groupsPerCue = opts.groups;

  let address = null; // resolved IPv4, never logged
  let target = null; // { address, port } once known
  let udp = null;
  let control = null;
  let timer = null;
  let quitting = false;

  // Works at any point, startup included. finish() runs once.
  function stop() {
    if (quitting) return;
    quitting = true;
    clearTimeout(timer);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const s of [control, udp]) { if (s) { try { s.close(); } catch (e) { /* closed */ } } }
      console.log(STOPPED_LINE);
      process.exit(0);
    };
    setTimeout(finish, 500);
    if (!udp || !target) return finish();
    const pkt = buildStopPacket();
    const send = (cb) => { try { udp.send(pkt, target.port, target.address, () => cb()); } catch (e) { cb(); } };
    send(() => setTimeout(() => send(finish), 20));
  }
  stopFn = stop;

  function request(method, path, body) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer2); resolve(v); } };
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: address, port: opts.host.port, method, path,
        headers: Object.assign({ Host: opts.host.hostname + (opts.host.port === 80 ? '' : ':' + opts.host.port) },
          data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 256 * 1024) { req.destroy(); finish(null); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(null); }
        });
        res.on('error', () => finish(null));
      });
      const timer2 = setTimeout(() => { req.destroy(); finish(null); }, 2000);
      req.on('error', () => finish(null));
      if (data) req.write(data);
      req.end();
    });
  }

  async function probeWled() {
    const [cfg, state, presets] = await Promise.all([
      request('GET', '/json/cfg'), request('GET', '/json/state'), request('GET', '/presets.json'),
    ]);
    if (cfg == null && state == null && presets == null) return null;
    return parseProbe({ cfg, state, presets });
  }

  function printProbe(p, g) {
    const yn = (v) => (v ? 'on' : 'off');
    log('probe, brightness ' + (p.stateBri == null ? 'unknown' : p.stateBri) + (p.on === false ? ' (WLED off)' : '') +
      (p.maxbri ? ', realtime forces max brightness' : ''));
    log('probe, gamma ' + fmtGamma(g.gamma) + ' (' + g.why + ')');
    log('probe, stream port ' + p.port + ', receive realtime ' + yn(p.realtime) +
      ', main segment only ' + yn(p.mainSegmentOnly));
    log('probe, preset 2 speed ' + (p.sx == null ? 'unknown' : p.sx) + ', cycle ' + p.cycleSeconds.toFixed(1) + ' s');
    log('probe, WLED power limit ' + (p.maxPwr == null ? 'unknown' : p.maxPwr + ' mA'));
    p.outputs.forEach((o, i) => {
      log('output ' + (i + 1) + ': ' + o.len + ' LEDs, ' +
        (o.ledma == null ? DEFAULT_LED_MA + ' mA each (default, WLED value not usable)' : o.ledma + ' mA each'));
    });
  }

  async function run() {
    if (earlyStop) return stop();
    let probe = parseProbe({});
    if (!opts.dryRun) {
      try {
        address = (await dns.promises.lookup(opts.host.hostname, { family: 4 })).address;
      } catch (e) {
        if (quitting) return;
        log('could not look up the WLED host, nothing sent');
        process.exit(1);
      }
      if (quitting) return;
      udp = dgram.createSocket('udp4');
      udp.on('error', () => {});
      const p = await probeWled();
      if (quitting) return;
      if (!p) { log('WLED did not answer, nothing sent'); process.exit(1); }
      probe = p;
      if (opts.probe) { printProbe(probe, decideGamma(probe, opts.gamma)); process.exit(0); }
      if (!probe.realtime) { log('WLED has "receive realtime" off, nothing sent'); process.exit(1); }
      if (probe.mainSegmentOnly) { log('WLED has "main segment only" on, nothing sent'); process.exit(1); }
      target = { address, port: probe.port };
      if (!opts.noPreset) {
        const r = await request('POST', '/json/state', { on: true, ps: 2 });
        if (quitting) return;
        if (r == null) log('could not select preset 2, carrying on');
        await new Promise((res) => setTimeout(res, 300));
        if (quitting) return;
        const st = await request('GET', '/json/state');
        if (quitting) return;
        probe.bri = briAfterPreset(probe, st);
      }
    }

    const gamma = decideGamma(probe, opts.gamma).gamma;
    const cycle = opts.cycle != null ? opts.cycle : probe.cycleSeconds;
    const bri = probe.bri;
    const ledMa = probe.ledMa;
    const scale = fixedScale({ spans: opts.spans, gamma, maxMa: opts.maxMa, bri, ledMa });
    const peakMa = BASE_MA + peakLedPart({ spans: opts.spans, gamma, bri, ledMa }, 256) * scale;
    const render = { cycle, spans: opts.spans, gamma, scale };
    const seed = opts.seed != null ? opts.seed : crypto.randomInt(0, 2 ** 31);
    const rng = mulberry32(seed);
    if (quitting) return;

    control = dgram.createSocket('udp4');
    control.on('error', () => {
      log('control port busy, carrying on without it');
      const c = control;
      control = null;
      try { c.close(); } catch (e) { /* closed */ }
    });
    control.on('message', (msg) => {
      const c = parseTrigger(msg.toString('utf8'));
      if (!c) return;
      if (c.cmd === 'quit') stop();
      else pending += c.n;
    });
    control.bind(opts.controlPort, '127.0.0.1');

    if (opts.dryRun) log('dry run, nothing is sent');
    console.log(streamingLine(opts.fps, cycle, gamma, scale, peakMa));

    const period = 1000 / opts.fps;
    let start = performance.now();
    let frameNo = 0;
    let groups = [];
    let autoNext = opts.auto ? nextAutoGap(rng) : Infinity;
    let framesThisSecond = 0;
    let nextSummary = 1;
    let lastDropLog = -Infinity;
    const sendState = { down: false };
    const onSent = (err) => { const m = trackSend(sendState, err); if (m) log(m); };

    function tick() {
      if (quitting) return;
      const t = (performance.now() - start) / 1000;
      if (t >= autoNext) { pending += opts.groups; autoNext = t + nextAutoGap(rng); }
      groups = pruneThunder(groups, t);
      if (pending > 0) {
        const r = addThunder(groups, t, rng, pending);
        pending = 0;
        groups = r.groups;
        for (const g of r.added) console.log(thunderLine(g));
        if (r.dropped > 0 && t - lastDropLog >= 10) { log('thunder cue dropped, too many at once'); lastDropLog = t; }
      }
      const frame = renderFrame(t, render, groups.length ? dimMultipliers(groups, t) : null);
      if (udp && target) {
        try { udp.send(buildFramePacket(frame), target.port, target.address, onSent); } catch (e) { onSent(e); }
      }
      framesThisSecond++;
      if (opts.dryRun && t >= nextSummary) {
        log('dry run, ' + framesThisSecond + ' frames, est ' + Math.round(estimateMa(frame, bri, ledMa)) +
          ' mA, dim groups ' + groups.length);
        framesThisSecond = 0;
        nextSummary = Math.floor(t) + 1;
      }
      frameNo++;
      let next = start + frameNo * period;
      if (performance.now() - next > 500) {
        // fell far behind (e.g. suspended): resync instead of bursting frames
        frameNo = Math.ceil((performance.now() - start) / period);
        next = start + frameNo * period;
      }
      timer = setTimeout(tick, Math.max(0, next - performance.now()));
    }

    tick();
  }

  run().catch(() => { if (!quitting) { log('failed to start'); process.exit(1); } });
}
