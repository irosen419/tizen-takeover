#!/usr/bin/env node
// mood-render: the general Pi-drawn renderer for Moods. Same flags, trigger
// port, log lines, start and stop as forest-render.js (which it requires for
// gamma, power, dim envelopes, packets, probe and trigger parsing), plus
// `--plan <file|->` (a RenderPlan v1; `-` reads it from standard input) and
// `event <name> [n]` on the trigger port. For the rainforest plan (one palette
// layer, the forest table, over the three sections) its frames equal
// forest-render's byte for byte.
//
// Run:
//   node mood-render.js --plan plan.json --dry-run       (draw only, no network)
//   WLED_HOST=<ip> node mood-render.js --plan - < plan.json --no-preset
//
// Layers (drawn in order; each bulb ends as out * (1 - a) + colour * a):
//   palette  { palette?: [hex x2..64] (else plan.palette), level?: 0..1, cycleSeconds?, spans? }
//            one palette span per range, drifting like WLED's Palette effect (a = 1)
//   solid    { color, level?: 0..1 }                                  (a = 1)
//   breathe  { color, level?: 0..1, min?: 0..1 (0.2), period?: s (6) }  (a = 1)
//   sparkle  { color, level?, density: 0..1, rise?: s (1), hold?: [s, s] ([0.3, 1.2]), fall?: s (1.5) }
//            a = the twinkle's envelope; stateless, seeded from --seed
//   chase    { color, level?, width?: bulbs (3), speed?: bulbs/s (10), gap?: bulbs (range length) }
//            a = 1 at a head, fading to 0 over `width` bulbs behind it
//   pixels   { colors: [hex, ...] (one per bulb, repeated), level? }    (a = 1)
// Every layer has `ranges: [[first, last], ...]` (inclusive, 0..161). Bulbs no
// layer covers, `plan.black` and 162-163 stay dark. Only the "thunder" event
// (forest-render's dim groups) is drawn.
'use strict';

const F = require('./forest-render.js');

const NAME = 'mood-render';
const LAST_LIT = F.WALL.spare[0] - 1; // 161
const KINDS = ['palette', 'solid', 'breathe', 'sparkle', 'chase', 'pixels'];
const FOREST_THUNDER = { size: [2, 4], depth: [0.5, 0.75], hold: [1, 2.5] };
const MAX_LAYERS = 32;
const MAX_RANGES = 64;
const MAX_PLAN_BYTES = 256 * 1024;

// ---------- plan checks ----------

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;
const optIn = (v, lo, hi) => v == null || inRange(v, lo, hi);
const samePair = (a, b) => Array.isArray(a) && a.length === 2 && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

function hexRgb(h) {
  const s = String(h).replace(/^#/, '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function layerWhy(l, plan, i) {
  const at = 'layer ' + (i + 1) + ': ';
  if (!l || typeof l !== 'object') return at + 'not readable';
  if (KINDS.indexOf(l.kind) < 0) return at + 'unknown kind';
  if (!Array.isArray(l.ranges) || !l.ranges.length || l.ranges.length > MAX_RANGES) return at + 'needs ranges';
  for (const r of l.ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) ||
        r[0] < 0 || r[1] < r[0] || r[1] > LAST_LIT) return at + 'range outside 0 to ' + LAST_LIT;
  }
  if (!optIn(l.level, 0, 1)) return at + 'level must be 0 to 1';
  if (l.kind === 'palette') {
    const pal = l.palette != null ? l.palette : plan.palette;
    if (!Array.isArray(pal) || pal.length < 2 || pal.length > 64 || !pal.every((h) => HEX_RE.test(h))) return at + 'needs a palette of 2 to 64 colours';
    if (l.cycleSeconds != null && !(isNum(l.cycleSeconds) && l.cycleSeconds > 1)) return at + 'cycleSeconds must be above 1';
    if (!optIn(l.spans, 0.1, 8)) return at + 'spans must be 0.1 to 8';
    return '';
  }
  if (l.kind === 'pixels') {
    if (!Array.isArray(l.colors) || !l.colors.length || l.colors.length > F.LED_COUNT || !l.colors.every((h) => HEX_RE.test(h))) return at + 'needs colours';
    return '';
  }
  if (!HEX_RE.test(l.color || '')) return at + 'needs a colour';
  if (l.kind === 'breathe') {
    if (!optIn(l.min, 0, 1) || !optIn(l.period, 0.2, 600)) return at + 'min 0 to 1, period 0.2 to 600 s';
  } else if (l.kind === 'sparkle') {
    if (!(isNum(l.density) && l.density > 0 && l.density <= 1)) return at + 'density must be above 0, up to 1';
    if (!optIn(l.rise, 0.01, 60) || !optIn(l.fall, 0.01, 60)) return at + 'rise and fall 0.01 to 60 s';
    if (l.hold != null && !(Array.isArray(l.hold) && l.hold.length === 2 && inRange(l.hold[0], 0, 60) &&
        inRange(l.hold[1], l.hold[0], 60))) return at + 'hold must be [min, max] seconds';
  } else if (l.kind === 'chase') {
    if (!optIn(l.width, 0.5, F.LED_COUNT) || !optIn(l.speed, 0, 200) || !optIn(l.gap, 1, F.LED_COUNT)) return at + 'width, speed or gap out of range';
  }
  return '';
}

// '' = drawable; else a plain reason.
function checkPlan(plan) {
  if (!plan || typeof plan !== 'object') return 'no plan';
  if (plan.v !== 1) return 'plan version not supported';
  if (plan.leds != null && plan.leds !== F.LED_COUNT) return 'LED count differs';
  if (!Array.isArray(plan.layers) || !plan.layers.length || plan.layers.length > MAX_LAYERS) return 'plan needs 1 to ' + MAX_LAYERS + ' layers';
  for (let i = 0; i < plan.layers.length; i++) {
    const why = layerWhy(plan.layers[i], plan, i);
    if (why) return why;
  }
  if (plan.black != null && !(Array.isArray(plan.black) && plan.black.every((r) => Array.isArray(r) && r.length === 2 &&
      Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] >= r[0] && r[1] < F.LED_COUNT))) return 'black ranges not readable';
  const d = plan.drift || {};
  if (d.cycleSeconds != null && !(isNum(d.cycleSeconds) && d.cycleSeconds > 1)) return 'drift cycle must be above 1';
  if (!optIn(d.spans, 0.1, 8)) return 'drift spans must be 0.1 to 8';
  const ev = plan.events == null ? {} : plan.events;
  if (typeof ev !== 'object' || Array.isArray(ev)) return 'events not readable';
  for (const name of Object.keys(ev)) {
    if (name !== 'thunder') return 'event other than thunder';
    const t = ev.thunder || {};
    if (t.kind != null && t.kind !== 'dim') return 'thunder is not a dim';
    const fixed = { attack: F.ATTACK, release: F.RELEASE, floor: F.DIM_FLOOR };
    for (const k of Object.keys(fixed)) if (t[k] != null && Math.abs(t[k] - fixed[k]) > 1e-9) return 'thunder ' + k + ' differs from the script';
    for (const k of Object.keys(FOREST_THUNDER)) if (t[k] != null && !samePair(t[k], FOREST_THUNDER[k])) return 'thunder ' + k + ' differs from the script';
  }
  return '';
}

// ---------- compile ----------

const compiled = new WeakMap();

function compile(plan) {
  if (compiled.has(plan)) return compiled.get(plan);
  const layers = plan.layers.map((l) => {
    const c = { kind: l.kind, ranges: l.ranges.map((r) => [r[0], r[1]]), level: l.level == null ? 1 : l.level };
    if (l.kind === 'palette') {
      c.table = (l.palette != null ? l.palette : plan.palette).map(hexRgb);
      c.cycle = l.cycleSeconds == null ? null : l.cycleSeconds;
      c.spans = l.spans == null ? null : l.spans;
    } else if (l.kind === 'pixels') {
      c.colors = l.colors.map(hexRgb);
    } else {
      c.color = hexRgb(l.color);
      c.min = l.min == null ? 0.2 : l.min;
      c.period = l.period == null ? 6 : l.period;
      c.density = l.density;
      c.rise = l.rise == null ? 1 : l.rise;
      c.fall = l.fall == null ? 1.5 : l.fall;
      c.hold = l.hold == null ? [0.3, 1.2] : l.hold;
      c.width = l.width == null ? 3 : l.width;
      c.speed = l.speed == null ? 10 : l.speed;
      c.gap = l.gap == null ? null : l.gap;
    }
    return c;
  });
  const black = Array.isArray(plan.black) ? plan.black.map((r) => [r[0], r[1]]) : [];
  const out = { layers, black, forest: isForestWash(plan) };
  compiled.set(plan, out);
  return out;
}

// True when the plan is the forest wash itself: then the frames and the scale are forest-render's own.
function isForestWash(plan) {
  if (!plan || !Array.isArray(plan.layers) || plan.layers.length !== 1) return false;
  const l = plan.layers[0];
  if (!l || l.kind !== 'palette' || (l.level != null && l.level !== 1) || l.cycleSeconds != null || l.spans != null) return false;
  const pal = l.palette != null ? l.palette : plan.palette;
  if (!Array.isArray(pal) || pal.length !== 16 || pal.some((h, i) => String(h).replace(/^#/, '').toUpperCase() !== F.PALETTE_HEX[i].toUpperCase())) return false;
  const secs = F.WALL.sections;
  return Array.isArray(l.ranges) && l.ranges.length === secs.length &&
    l.ranges.every((r, i) => r[0] === secs[i].start && r[1] === secs[i].end);
}

// ---------- drawing ----------

// forest-render's paletteColor() for any table: the same operations, so the forest table gives the same floats.
function paletteColorOf(table, index) {
  const n = table.length;
  const pos = F.wrap256(index) / (256 / n);
  const i0 = Math.floor(pos) % n;
  const i1 = (i0 + 1) % n;
  const f = pos - Math.floor(pos);
  const a = table[i0];
  const b = table[i1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Stateless hash -> [0, 1).
function hash01(seed, a, b) {
  let h = (seed ^ Math.imul(a + 1, 0x9E3779B1) ^ Math.imul(b + 1, 0x85EBCA77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// One twinkle per slot per bulb; slot length = longest twinkle / density, so about `density` of bulbs are lit.
function sparkleAlpha(c, led, t, seed) {
  const longest = c.rise + c.hold[1] + c.fall;
  const slotLen = longest / c.density;
  const shifted = t + hash01(seed, led, -1) * slotLen;
  const k = Math.floor(shifted / slotLen);
  const u = shifted - k * slotLen;
  const hold = c.hold[0] + hash01(seed, led, 2 * k) * (c.hold[1] - c.hold[0]);
  const dur = c.rise + hold + c.fall;
  const t0 = hash01(seed, led, 2 * k + 1) * (slotLen - dur);
  const dt = u - t0;
  if (dt <= 0 || dt >= dur) return 0;
  if (dt < c.rise) return (1 - Math.cos(Math.PI * dt / c.rise)) / 2;
  if (dt < c.rise + hold) return 1;
  return (1 + Math.cos(Math.PI * (dt - c.rise - hold) / c.fall)) / 2;
}

function chaseAlpha(c, i, len, t) {
  const gap = c.gap == null ? len : c.gap;
  const head = (t * c.speed) % gap;
  let d = (head - (i % gap)) % gap; // bulbs behind the head
  if (d < 0) d += gap;
  return d < c.width ? 1 - d / c.width : 0;
}

function breatheLevel(c, t) {
  return c.min + (c.level - c.min) * (1 - Math.cos(2 * Math.PI * t / c.period)) / 2;
}

// Undimmed, un-gamma'd picture: Float64Array of 164*3 in 0..255.
// o = { cycle, spans, seed }; a palette layer's own cycleSeconds and spans win.
function renderLinearPlan(plan, t, o) {
  const P = compile(plan);
  const out = new Float64Array(F.LED_COUNT * 3);
  const seed = (o && o.seed != null ? o.seed : 1) >>> 0;
  for (const c of P.layers) {
    for (const r of c.ranges) {
      const len = r[1] - r[0] + 1;
      for (let i = 0; i < len; i++) {
        const led = r[0] + i;
        const k = led * 3;
        let col;
        let a = 1;
        let lvl = c.level;
        if (c.kind === 'palette') {
          col = paletteColorOf(c.table, F.paletteIndex(i, len, t, c.cycle != null ? c.cycle : o.cycle, c.spans != null ? c.spans : o.spans));
        } else if (c.kind === 'pixels') {
          col = c.colors[i % c.colors.length];
        } else {
          col = c.color;
          if (c.kind === 'breathe') lvl = breatheLevel(c, t);
          else if (c.kind === 'sparkle') a = sparkleAlpha(c, led, t, seed);
          else if (c.kind === 'chase') a = chaseAlpha(c, i, len, t);
        }
        if (a === 1) {
          if (lvl === 1) { out[k] = col[0]; out[k + 1] = col[1]; out[k + 2] = col[2]; } else {
            out[k] = col[0] * lvl; out[k + 1] = col[1] * lvl; out[k + 2] = col[2] * lvl;
          }
        } else if (a > 0) {
          const w = a * lvl;
          out[k] = out[k] * (1 - a) + col[0] * w;
          out[k + 1] = out[k + 1] * (1 - a) + col[1] * w;
          out[k + 2] = out[k + 2] * (1 - a) + col[2] * w;
        }
      }
    }
  }
  return out;
}

// Gamma then the fixed power scale, as forest-render's renderBase().
function renderPlanBase(plan, t, o) {
  const lin = renderLinearPlan(plan, t, o);
  const scale = o.scale == null ? 1 : o.scale;
  for (let k = 0; k < lin.length; k++) lin[k] = F.gammaValue(lin[k], o.gamma) * scale;
  return lin;
}

function renderPlanFrame(plan, t, o, mult) {
  const out = F.applyDim(renderPlanBase(plan, t, o), mult);
  for (const r of compile(plan).black) out.fill(0, r[0] * 3, (r[1] + 1) * 3);
  return out;
}

// ---------- power ----------

// Brightest each bulb can ever be (per channel, linear): a blend never exceeds its brightest layer.
function peakLinear(plan) {
  const P = compile(plan);
  const out = new Float64Array(F.LED_COUNT * 3);
  for (const c of P.layers) {
    let top;
    if (c.kind === 'palette') top = [0, 1, 2].map((ch) => Math.max.apply(null, c.table.map((x) => x[ch])) * c.level);
    else if (c.kind === 'breathe') top = c.color.map((v) => v * Math.max(c.level, c.min));
    else if (c.kind !== 'pixels') top = c.color.map((v) => v * c.level);
    for (const r of c.ranges) {
      for (let led = r[0]; led <= r[1]; led++) {
        const v = c.kind === 'pixels' ? c.colors[(led - r[0]) % c.colors.length].map((x) => x * c.level) : top;
        for (let ch = 0; ch < 3; ch++) out[led * 3 + ch] = Math.max(out[led * 3 + ch], v[ch]);
      }
    }
  }
  for (const r of P.black) out.fill(0, r[0] * 3, (r[1] + 1) * 3);
  for (let led = F.WALL.spare[0]; led <= F.WALL.spare[1]; led++) out.fill(0, led * 3, led * 3 + 3);
  return out;
}

// One scale for every frame. The forest wash uses forest-render's own; any other
// plan the brightest-possible frame, trimmed until its rounded form stays 1% under max-ma.
function planScale(plan, o) {
  if (compile(plan).forest) return F.fixedScale({ spans: o.spans, gamma: o.gamma, maxMa: o.maxMa, bri: o.bri, ledMa: o.ledMa });
  const peak = peakLinear(plan).map((v) => F.gammaValue(v, o.gamma));
  const part = F.ledPartMa(peak, o.bri, o.ledMa);
  let scale = part > 0 ? Math.min(1, (o.maxMa - F.BASE_MA) / part) : 1;
  const limit = o.maxMa - Math.max(1, 0.01 * o.maxMa);
  const rounded = (s) => F.estimateMa(peak.map((v) => Math.round(v * s)), o.bri, o.ledMa);
  for (let tries = 0; tries < 400 && rounded(scale) > limit; tries++) scale *= 0.995;
  return scale;
}

function peakMa(plan, o, scale) {
  if (compile(plan).forest) return F.BASE_MA + F.peakLedPart({ spans: o.spans, gamma: o.gamma, bri: o.bri, ledMa: o.ledMa }, 256) * scale;
  return F.BASE_MA + F.ledPartMa(peakLinear(plan).map((v) => F.gammaValue(v, o.gamma) * scale), o.bri, o.ledMa);
}

// ---------- trigger, args, lines ----------

// forest-render's words, plus "event <name> [n]".
function parseMoodTrigger(text) {
  const f = F.parseTrigger(text);
  if (f) return f;
  const s = String(text == null ? '' : text).trim().toLowerCase();
  const m = /^event\s+([a-z][a-z0-9-]{0,31})(?:\s+(-?\d+))?$/.exec(s);
  if (!m) return null;
  const n = Math.max(1, Math.min(6, m[2] == null ? 1 : parseInt(m[2], 10)));
  return m[1] === 'thunder' ? { cmd: 'thunder', n } : { cmd: 'event', name: m[1], n };
}

// forest-render's flags plus --plan <file|->.
function parseMoodArgs(argv, env) {
  const rest = [];
  let plan = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') {
      if (i + 1 >= argv.length) return { ok: false, error: '--plan needs a value', code: 2 };
      plan = argv[++i];
    } else if (a.indexOf('--plan=') === 0) {
      plan = a.slice(7);
    } else rest.push(a);
  }
  const r = F.parseArgs(rest, env);
  if (!r.ok) return r;
  if (!plan) return { ok: false, error: 'no plan given (--plan <file|->)', code: 2 };
  r.opts.plan = plan;
  return r;
}

const rename = (line) => line.replace(/^forest-render: /, NAME + ': ');
const streamingLine = function () { return rename(F.streamingLine.apply(null, arguments)); };
const thunderLine = (g) => rename(F.thunderLine(g));
const STOPPED_LINE = rename(F.STOPPED_LINE);
const USAGE = 'usage: node mood-render.js --plan <file|-> ' + F.USAGE.replace(/^usage: node forest-render\.js /, '');

module.exports = {
  NAME, KINDS, LAST_LIT, STOPPED_LINE, USAGE, forest: F,
  checkPlan, isForestWash, compile, paletteColorOf, hash01, sparkleAlpha, chaseAlpha, breatheLevel,
  renderLinearPlan, renderPlanBase, renderPlanFrame, peakLinear, planScale, peakMa,
  parseMoodTrigger, parseMoodArgs, streamingLine, thunderLine,
};

// ---------- CLI (forest-render's loop, drawing the plan) ----------

if (require.main === module) {
  let pending = 0;
  let stopFn = null;
  let earlyStop = false;
  let groupsPerCue = 1;
  process.on('SIGUSR1', () => { pending += groupsPerCue; });
  process.on('SIGINT', () => (stopFn ? stopFn() : (earlyStop = true)));
  process.on('SIGTERM', () => (stopFn ? stopFn() : (earlyStop = true)));

  const fs = require('node:fs');
  const http = require('node:http');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
  const crypto = require('node:crypto');
  const { performance } = require('node:perf_hooks');

  const log = (msg) => console.log(NAME + ': ' + msg);

  const parsed = parseMoodArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    if (parsed.help) { console.log(USAGE); process.exit(0); }
    console.error(NAME + ': ' + parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  const opts = parsed.opts;
  groupsPerCue = opts.groups;

  let address = null; // resolved IPv4, never logged
  let target = null;
  let udp = null;
  let control = null;
  let timer = null;
  let quitting = false;

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
    const pkt = F.buildStopPacket();
    const send = (cb) => { try { udp.send(pkt, target.port, target.address, () => cb()); } catch (e) { cb(); } };
    send(() => setTimeout(() => send(finish), 20));
  }
  stopFn = stop;

  function readPlan() {
    return new Promise((resolve) => {
      const done = (text) => {
        let plan = null;
        try { plan = JSON.parse(text); } catch (e) { return resolve({ why: 'plan is not JSON' }); }
        const why = checkPlan(plan);
        resolve(why ? { why } : { plan });
      };
      if (opts.plan !== '-') {
        let text;
        try {
          if (fs.statSync(opts.plan).size > MAX_PLAN_BYTES) return resolve({ why: 'plan too big' });
          text = fs.readFileSync(opts.plan, 'utf8');
        } catch (e) { return resolve({ why: 'plan file not readable' }); }
        return done(text);
      }
      const chunks = [];
      let size = 0;
      process.stdin.on('data', (c) => {
        size += c.length;
        if (size > MAX_PLAN_BYTES) { resolve({ why: 'plan too big' }); process.stdin.destroy(); return; }
        chunks.push(c);
      });
      process.stdin.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', () => resolve({ why: 'plan not readable' }));
    });
  }

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
    return F.parseProbe({ cfg, state, presets });
  }

  async function run() {
    if (earlyStop) return stop();
    const got = await readPlan();
    if (quitting) return;
    if (!got.plan) { log('plan refused, ' + got.why + ', nothing sent'); process.exit(1); }
    const plan = got.plan;
    if (opts.probe) { log('--probe is forest-render\'s, nothing sent'); process.exit(2); }
    let probe = F.parseProbe({});
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
        probe.bri = F.briAfterPreset(probe, st);
      }
    }

    const gamma = F.decideGamma(probe, opts.gamma).gamma;
    const cycle = opts.cycle != null ? opts.cycle : probe.cycleSeconds;
    const bri = probe.bri;
    const ledMa = probe.ledMa;
    const seed = opts.seed != null ? opts.seed : crypto.randomInt(0, 2 ** 31);
    const powerOpts = { spans: opts.spans, gamma, maxMa: opts.maxMa, bri, ledMa };
    const scale = planScale(plan, powerOpts);
    const estPeak = peakMa(plan, powerOpts, scale);
    const render = { cycle, spans: opts.spans, gamma, scale, seed };
    const rng = F.mulberry32(seed);
    const hasThunder = !!(plan.events && plan.events.thunder);
    if (quitting) return;

    let lastEventLog = -Infinity;
    control = dgram.createSocket('udp4');
    control.on('error', () => {
      log('control port busy, carrying on without it');
      const c = control;
      control = null;
      try { c.close(); } catch (e) { /* closed */ }
    });
    control.on('message', (msg) => {
      const c = parseMoodTrigger(msg.toString('utf8'));
      if (!c) return;
      if (c.cmd === 'quit') stop();
      else if (c.cmd === 'thunder') pending += c.n;
      else {
        const t = performance.now() / 1000;
        if (t - lastEventLog >= 10) { log('event not in this mood, ignored'); lastEventLog = t; }
      }
    });
    control.bind(opts.controlPort, '127.0.0.1');

    if (opts.dryRun) log('dry run, nothing is sent');
    console.log(streamingLine(opts.fps, cycle, gamma, scale, estPeak));

    const period = 1000 / opts.fps;
    const start = performance.now();
    let frameNo = 0;
    let groups = [];
    let autoNext = opts.auto && hasThunder ? F.nextAutoGap(rng) : Infinity;
    let framesThisSecond = 0;
    let nextSummary = 1;
    let lastDropLog = -Infinity;
    const sendState = { down: false };
    const onSent = (err) => { const m = F.trackSend(sendState, err); if (m) log(m); };

    function tick() {
      if (quitting) return;
      const t = (performance.now() - start) / 1000;
      if (t >= autoNext) { pending += opts.groups; autoNext = t + F.nextAutoGap(rng); }
      groups = F.pruneThunder(groups, t);
      if (pending > 0) {
        const r = F.addThunder(groups, t, rng, pending);
        pending = 0;
        groups = r.groups;
        for (const g of r.added) console.log(thunderLine(g));
        if (r.dropped > 0 && t - lastDropLog >= 10) { log('thunder cue dropped, too many at once'); lastDropLog = t; }
      }
      const frame = renderPlanFrame(plan, t, render, groups.length ? F.dimMultipliers(groups, t) : null);
      if (udp && target) {
        try { udp.send(F.buildFramePacket(frame), target.port, target.address, onSent); } catch (e) { onSent(e); }
      }
      framesThisSecond++;
      if (opts.dryRun && t >= nextSummary) {
        log('dry run, ' + framesThisSecond + ' frames, est ' + Math.round(F.estimateMa(frame, bri, ledMa)) +
          ' mA, dim groups ' + groups.length);
        framesThisSecond = 0;
        nextSummary = Math.floor(t) + 1;
      }
      frameNo++;
      let next = start + frameNo * period;
      if (performance.now() - next > 500) {
        frameNo = Math.ceil((performance.now() - start) / period);
        next = start + frameNo * period;
      }
      timer = setTimeout(tick, Math.max(0, next - performance.now()));
    }

    tick();
  }

  run().catch(() => { if (!quitting) { log('failed to start'); process.exit(1); } });
}
