/*
 * The music look: listens to blocks of sound and draws colors onto the
 * sections. Pure math, no lights, no clock: tests feed it made-up audio.
 *
 * Medium Vibrancy with Medium Beat is the demo Ian approved
 * (~/govee-lights/music_demo.py on the Pi), number for number:
 *   - every 50 ms block: loudness against a slow peak, an onset when the
 *     sound jumps, tempo from the strongest repeat in the last 8 s of onsets,
 *     a "vibe" (0-1) that blends loudness, tempo and beat density and settles
 *     over about 5 s;
 *   - every 100 ms frame: the palette drifts slowly along each light, color
 *     richness grows with the vibe, brightness = 0.3 + 0.65 x vibe, plus a
 *     gentle breath in time with the tempo and a soft lift on each onset.
 * The other dial levels only change how far those are allowed to move.
 *
 * Fixed limits at every level (tests check them):
 *   - nothing reads white: every color keeps at least MIN_RICH saturation;
 *   - a beat changes brightness only, never the color;
 *   - a lift fades over more than 150 ms, and onsets are at least 350 ms
 *     apart (under 3 a second).
 *
 * Tempo: the hub can pass the song's own tempo (pi/vibe.js, ReccoBeats) with
 * setSongBpm(). Listening still finds where the beats fall; the song's
 * number wins when the two agree (or are a half or double of each other),
 * and fills in while listening has not settled.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const govee = require('./govee');

const RATE = 16000;
const BLOCK_HZ = 20;
const BLOCK = RATE / BLOCK_HZ;          // 800 samples, 50 ms
const BLOCK_S = 1 / BLOCK_HZ;
const FRAME_EVERY = 2;                  // a frame every 2 blocks: 10 a second
const HISTORY = 160;                    // 8 s of blocks
const ONSET_GAP = 7;                    // blocks between onsets (350 ms): under 3 a second
const MIN_RICH = 0.35;                  // saturation floor (max-min)/max, promised
const RICH_AIM = 0.42;                  // what enforceRich aims for, so rounding never dips under the floor
const MUSIC_RMS = 200;                  // s16 RMS above this counts as sound (about -44 dBFS)

// How far each dial lets the song move the lights. medium = the demo.
const VIBRANCY = {
  low: { base: 0.15, span: 0.25, sat0: 0.9, satK: 0.1, drift0: 1 / 32, driftK: 1 / 10, spread: 1.0 },
  medium: { base: 0.3, span: 0.65, sat0: 1.0, satK: 0.5, drift0: 1 / 16, driftK: 1 / 4, spread: 1.5 },
  high: { base: 0.4, span: 0.6, sat0: 1.15, satK: 0.6, drift0: 1 / 16, driftK: 1 / 2.5, spread: 2.2 }
};
const BEAT = {
  low: { sway: 0.02, bump: 0, ripple: false },
  medium: { sway: 0.10, bump: 0.18, ripple: false },
  high: { sway: 0.16, bump: 0.30, ripple: true }
};
const RIPPLE_FRAMES = 4;                // a lift reaches the far end 400 ms later

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function colorAt(pal, pos) {
  const n = pal.length;
  const p = ((pos % n) + n) % n;
  const i = Math.floor(p);
  return lerp(pal[i], pal[(i + 1) % n], p - i);
}

function richness(c) {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  return mx > 0 ? (mx - mn) / mx : 0;
}

// Push a color away from grey until it has at least MIN_RICH saturation.
function enforceRich(c) {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= 0) return [0, 0, 0];
  if ((mx - mn) / mx >= RICH_AIM) return c;
  const g = (c[0] + c[1] + c[2]) / 3;
  if (mx - mn < 1e-6) return [g, g * 0.6, g * 0.25];       // pure grey: warm it
  const k = (RICH_AIM * g) / ((mx - mn) - RICH_AIM * (mx - g));
  return c.map((v) => Math.max(0, g + (v - g) * k));
}

function hueOf(c) {
  const r = c[0], g = c[1], b = c[2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d <= 0) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function rmsOf(samples) {
  let sq = 0;
  for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
  return Math.sqrt(sq / Math.max(1, samples.length));
}

// opts: { palette: [[r,g,b]...], vibrancy, beat }
function createLook(opts) {
  const o = opts || {};
  let pal = o.palette;
  let vib = VIBRANCY[o.vibrancy] || VIBRANCY.medium;
  let bt = BEAT[o.beat] || BEAT.medium;

  // The demo's state, same starting values.
  let env = 0.3, peak = 2000, prevRms = 0, fastAvg = 0, lastOnset = -9;
  let flux = [], onsets = [];
  let bpm = 0, vibe = 0.3, beatPhase = 0, nblk = 0, bump = 0, phase = 0;
  let songBpm = 0;
  let lastRms = 0;
  let onsetCount = 0;
  const bumps = [];                    // recent lifts, newest first (ripple)

  function usedBpm() {
    if (!songBpm) return bpm;
    if (!bpm) return songBpm;
    let best = songBpm, bestErr = Infinity;
    [0.5, 1, 2].forEach((m) => {
      const err = Math.abs(songBpm * m - bpm) / bpm;
      if (err < bestErr) { bestErr = err; best = songBpm * m; }
    });
    return bestErr <= 0.12 ? best : bpm;
  }

  // One 50 ms block of mono s16 samples. Returns true when a frame is due.
  function block(samples) {
    nblk++;
    const rms = rmsOf(samples);
    lastRms = rms;
    peak = Math.max(rms, peak * 0.99975, 600);
    const lvl = Math.min(1, rms / peak);
    env = env * 0.9925 + lvl * 0.0075;
    const rise = Math.max(0, rms - prevRms) / Math.max(peak, 1);
    prevRms = rms;
    flux.push(rise);
    fastAvg = fastAvg * 0.9 + rise * 0.1;
    const fired = rise > Math.max(0.04, fastAvg * 2.2) && nblk - lastOnset >= ONSET_GAP ? 1 : 0;
    if (fired) {
      lastOnset = nblk;
      onsetCount++;
      bump = Math.max(bump, Math.min(1, rise / 0.15));
    }
    onsets.push(fired);
    if (flux.length > HISTORY) { flux = flux.slice(-HISTORY); onsets = onsets.slice(-HISTORY); }
    if (nblk % 10 === 0 && flux.length >= 80) {
      let m = 0;
      for (let i = 0; i < flux.length; i++) m += flux[i];
      m /= flux.length;
      const f = flux.map((x) => x - m);
      let best = 0, bestLag = 0;
      for (let lag = 7; lag <= 20; lag++) {
        let s = 0;
        for (let i = lag; i < f.length; i++) s += f[i] * f[i - lag];
        if (s > best) { best = s; bestLag = lag; }
      }
      if (bestLag) {
        const heard = 60 / (bestLag * BLOCK_S);
        bpm = bpm ? bpm * 0.7 + heard * 0.3 : heard;
      }
    }
    let on = 0;
    for (let i = 0; i < onsets.length; i++) on += onsets[i];
    const density = on / (onsets.length * BLOCK_S);
    const b = usedBpm();
    const tempoN = b ? clamp01((b - 70) / 80) : 0.3;
    const densN = Math.min(1, density / 3);
    const target = 0.4 * env + 0.3 * tempoN + 0.3 * densN;
    vibe = vibe * 0.99 + target * 0.01;
    beatPhase += (b ? b / 60 : 1) * BLOCK_S * 2 * Math.PI;
    return nblk % FRAME_EVERY === 0;
  }

  // Colors for every section of each light, index = section number.
  // gain 0-1 fades everything (start, stop); rest 0-1 blends to the resting
  // glow (quiet between songs, paused).
  function render(gainIn, restIn) {
    const gain = gainIn === undefined ? 1 : clamp01(gainIn);
    const rest = restIn === undefined ? 0 : clamp01(restIn);
    const live = 1 - rest;
    const v = vibe * live;
    phase += 0.1 * (vib.drift0 + vib.driftK * v);
    bumps.unshift(bump * bt.bump);
    if (bumps.length > RIPPLE_FRAMES + 1) bumps.length = RIPPLE_FRAMES + 1;
    const out = {};
    Object.keys(govee.LIGHTS).forEach((key) => {
      const n = govee.LIGHTS[key].sections;
      const path = govee.PATHS[key];
      const cols = new Array(n);
      for (let i = 0; i < n; i++) {
        const along = bt.ripple ? path.indexOf(i) / Math.max(1, n - 1) : 0;
        const lift = bumps[bt.ripple ? Math.round(along * RIPPLE_FRAMES) : 0] || 0;
        const sway = (bt.sway * vibe * Math.sin(beatPhase - along * Math.PI) + lift * (0.4 + vibe)) * live;
        let c = colorAt(pal, phase + (i / n) * vib.spread);
        const restF = vib.base * 0.8;
        const f = (vib.base + vib.span * v + sway) * live + restF * rest;
        const g = (c[0] + c[1] + c[2]) / 3;
        const sat = vib.sat0 + vib.satK * v;
        c = c.map((x) => Math.max(0, g + (x - g) * sat));
        c = enforceRich(c.map((x) => Math.min(255, x * f * gain)));
        const top = Math.max(c[0], c[1], c[2]);
        if (top > 255) c = c.map((x) => (x * 255) / top);   // scale, never clip: clipping greys a color
        cols[i] = c.map((x) => Math.floor(Math.max(0, x) / 6) * 6);
      }
      out[key] = cols;
    });
    bump *= 0.55;
    return out;
  }

  return {
    block: block,
    render: render,
    setSongBpm: (b) => { songBpm = typeof b === 'number' && b >= 40 && b <= 220 ? b : 0; },
    setPalette: (p) => { if (Array.isArray(p) && p.length) pal = p; },
    setDials: (v, b) => { vib = VIBRANCY[v] || vib; bt = BEAT[b] || bt; },
    features: () => ({ rms: lastRms, sound: lastRms >= MUSIC_RMS, bpm: Math.round(usedBpm()), heardBpm: Math.round(bpm), vibe: vibe, env: env, onsets: onsetCount, bump: bump })
  };
}

module.exports = {
  RATE: RATE,
  BLOCK: BLOCK,
  BLOCK_S: BLOCK_S,
  FRAME_EVERY: FRAME_EVERY,
  ONSET_GAP: ONSET_GAP,
  MIN_RICH: MIN_RICH,
  MUSIC_RMS: MUSIC_RMS,
  VIBRANCY: VIBRANCY,
  BEAT: BEAT,
  createLook: createLook,
  colorAt: colorAt,
  enforceRich: enforceRich,
  richness: richness,
  hueOf: hueOf,
  rmsOf: rmsOf
};
