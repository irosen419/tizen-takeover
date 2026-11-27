/*
 * The music look: listens to the sound in 10 ms steps and draws colors onto
 * the sections. Pure math, no lights, no clock: tests feed it made-up audio.
 *
 * Three things move the lights:
 *   1. The beat, locked. Onsets (a kick, a snare, any sudden rise, bass
 *      weighted) are found every 10 ms. The tempo is the strongest repeat
 *      in the last 6 s (the song's own tempo from the hub wins when the two
 *      agree). A beat clock then predicts each next beat and is pulled
 *      toward where the beats are actually heard, so pulses land on the beat
 *      and stay there. When no steady beat is heard, pulses fade away rather
 *      than fire at random.
 *   2. The Beat dial sets how dense the pulses are, not how wild:
 *        low     once a bar (the downbeat)
 *        medium  every beat (the downbeat a little stronger)
 *        high    every beat plus the eighth notes when the song has them
 *                (softer), and the pulse travels up the lamp and along the bars
 *   3. Song sections. Loudness is followed over about a second against the
 *      last 30 s, so a quiet verse sits low and a chorus or drop lifts the
 *      brightness and color richness within a couple of seconds. A lasting
 *      jump or fall in loudness counts as a new section: the palette then
 *      glides one color on (over 2 s). Between sections the colors drift
 *      slowly, as in the demo.
 *   The Vibrancy dial sets how rich and bright all of that can get.
 *
 * Fixed limits at every level (tests check them):
 *   - nothing reads white: every color keeps at least MIN_RICH saturation;
 *   - a beat changes brightness only, never the color;
 *   - a pulse fades over more than 150 ms, and eighth notes only show up to
 *     150 BPM (at most 5 soft pulses a second).
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const govee = require('./govee');

const RATE = 16000;
const BLOCK = 160;                       // 10 ms
const BLOCK_S = BLOCK / RATE;
const HOPS_PER_S = 1 / BLOCK_S;          // 100
const FRAME_HOPS = 10;                   // a frame every 100 ms ...
const BEAT_FRAME_HOPS = 7;               // ... or sooner (70 ms) when a pulse starts
const ENV_LEN = 600;                     // 6 s of onset strength
const PHASE_LEN = 400;                   // 4 s to place the beat
const MIN_BPM = 60;
const MAX_BPM = 180;
const EIGHTHS_MAX_BPM = 150;
const MIN_RICH = 0.35;                   // saturation floor (max-min)/max, promised
const RICH_AIM = 0.42;                   // what enforceRich aims for, so rounding never dips under the floor
const MUSIC_RMS = 200;                   // s16 RMS above this counts as sound (about -44 dBFS)
const PULSE_TAU_S = 0.13;                // a pulse fades with this time constant (about 0.3 at 150 ms)
const RIPPLE_HOPS = 40;                  // High: the pulse reaches the far end 400 ms later

// How rich and bright. medium = the demo's ranges.
const VIBRANCY = {
  low: { base: 0.15, span: 0.25, sat0: 0.9, satK: 0.1, drift0: 1 / 32, driftK: 1 / 10, spread: 1.0 },
  medium: { base: 0.3, span: 0.6, sat0: 1.0, satK: 0.5, drift0: 1 / 16, driftK: 1 / 4, spread: 1.5 },
  high: { base: 0.4, span: 0.55, sat0: 1.15, satK: 0.6, drift0: 1 / 16, driftK: 1 / 2.5, spread: 2.2 }
};
// How dense the pulses are; depth is how much brightness a full pulse adds.
const BEAT = {
  low: { every: 'bar', depth: 0.22, down: 1, beat: 0, eighth: 0, ripple: false },
  medium: { every: 'beat', depth: 0.26, down: 1, beat: 0.75, eighth: 0, ripple: false },
  high: { every: 'eighth', depth: 0.3, down: 1, beat: 0.85, eighth: 0.45, ripple: true }
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ema = (tauS) => 1 - Math.exp(-BLOCK_S / tauS);

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

// Push a color away from grey until it has at least RICH_AIM saturation.
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

// A ring of numbers, newest last; at(0) is the newest.
function ring(n) {
  const a = new Float64Array(n);
  let i = 0, count = 0;
  return {
    push(v) { a[i] = v; i = (i + 1) % n; if (count < n) count++; },
    at(back) { return back < count ? a[(i - 1 - back + n * 2) % n] : 0; },
    count: () => count,
    size: n
  };
}

// opts: { palette: [[r,g,b]...], vibrancy, beat }
function createLook(opts) {
  const o = opts || {};
  let pal = o.palette;
  let vib = VIBRANCY[o.vibrancy] || VIBRANCY.medium;
  let bt = BEAT[o.beat] || BEAT.medium;

  // Onsets
  const lpA = 1 - Math.exp(-2 * Math.PI * 150 / RATE);
  let lp = 0;
  const hist = [];                       // last few log levels, for the rise
  const env = ring(ENV_LEN);             // onset strength per hop
  let envMean = 0.01;
  let lastRms = 0;
  let hop = 0;

  // Tempo and the beat clock
  let songBpm = 0;
  let bpm = 0;                           // what the clock runs at
  let pendingBpm = 0;                    // a new tempo must be heard twice
  let period = 0;                        // hops per beat
  let phase = 0;                         // hops since the last beat
  let conf = 0;                          // 0-1, how steady the heard beat is
  let repeat = 0;                        // how strongly the onsets repeat at the tempo
  let beatCount = 0;
  let halfDone = false;
  const barAcc = [0, 0, 0, 0];
  let downSlot = 0;
  let pulseWaiting = false;
  let offRatio = 0;
  let onAvg = 0.01, offAvg = 0;

  // Sections
  let fastL = 0, midL = 0, peakL = 600;
  let energy = 0.3, vibe = 0.3;
  let strong = 0;                        // strong onsets, smoothed per second
  let sectionHold = 0;
  let lastSection = -1e9;
  let sections = 0;
  let offset = 0, offsetTarget = 0;
  let drift = 0;

  // Pulses and frames
  let pulse = 0;
  const pulses = ring(RIPPLE_HOPS + 1);
  let pulseCount = 0;
  let sinceFrame = 0;
  let pulseStarted = false;

  function onsetOf(samples) {
    let sq = 0, bsq = 0, y = lp;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      sq += x * x;
      y += lpA * (x - y);
      bsq += y * y;
    }
    lp = y;
    const n = Math.max(1, samples.length);
    const rms = Math.sqrt(sq / n);
    const bass = Math.sqrt(bsq / n);
    lastRms = rms;
    const lf = Math.log(1 + rms / 50);
    const lb = Math.log(1 + bass / 50);
    let pf = lf, pb = lb;
    if (hist.length) { pf = 0; pb = 0; hist.forEach((h) => { pf += h[0]; pb += h[1]; }); pf /= hist.length; pb /= hist.length; }
    hist.push([lf, lb]);
    if (hist.length > 3) hist.shift();
    return { rms: rms, strength: Math.max(0, lf - pf) * 0.6 + Math.max(0, lb - pb) * 1.0 };
  }

  function prior(b) {
    const x = Math.log2(b / 120) / 0.9;
    return Math.exp(-0.5 * x * x);
  }

  // Strongest repeat in the onsets, as BPM (0 when nothing stands out).
  function heardTempo() {
    const n = env.count();
    if (n < 300) return 0;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += env.at(i);
    mean /= n;
    const minLag = Math.floor(HOPS_PER_S * 60 / MAX_BPM), maxLag = Math.ceil(HOPS_PER_S * 60 / MIN_BPM);
    const sc = [];
    let zero = 0;
    for (let i = 0; i < n; i++) { const d = env.at(i) - mean; zero += d * d; }
    if (zero <= 1e-9) return 0;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += (env.at(i) - mean) * (env.at(i + lag) - mean);
      s /= zero;
      sc[lag] = s;
      const w = s * prior(60 * HOPS_PER_S / lag);
      if (w > best) { best = w; bestLag = lag; }
    }
    // How strongly the onsets repeat at the beat: near 0 for noise or a
    // song with no steady beat, 0.3 and up for a clear one.
    repeat += (Math.max(0, sc[bestLag] || 0) - repeat) * 0.5;
    if (!bestLag || sc[bestLag] < 0.08) return 0;
    // Refine between the neighbors.
    const a = sc[bestLag - 1] || 0, b = sc[bestLag], c = sc[bestLag + 1] || 0;
    const den = a - 2 * b + c;
    const lag = den < 0 ? bestLag + 0.5 * (a - c) / den : bestLag;
    return 60 * HOPS_PER_S / lag;
  }

  function chooseTempo() {
    const heard = heardTempo();
    let want = heard;
    if (songBpm) {
      const cands = [songBpm / 2, songBpm, songBpm * 2].filter((b) => b >= MIN_BPM && b <= MAX_BPM);
      if (heard) {
        const near = cands.find((b) => Math.abs(b - heard) / heard <= 0.06);
        if (near) want = near;
      } else {
        want = cands.sort((x, y) => Math.abs(Math.log2(x / 120)) - Math.abs(Math.log2(y / 120)))[0] || 0;
      }
    }
    if (!want) return;
    if (!bpm) { setBpm(want); return; }
    if (Math.abs(want - bpm) / bpm <= 0.04) { setBpm(bpm * 0.8 + want * 0.2); pendingBpm = 0; return; }
    // A different tempo must be heard twice in a row before the clock jumps.
    if (pendingBpm && Math.abs(want - pendingBpm) / pendingBpm <= 0.04) { setBpm(want); pendingBpm = 0; } else pendingBpm = want;
  }

  function setBpm(b) {
    bpm = b;
    period = 60 * HOPS_PER_S / b;
    if (phase >= period) phase %= period;
  }

  // Where in the beat the heard onsets sit; pulls the clock toward it.
  function alignPhase() {
    if (!period || env.count() < PHASE_LEN / 2) return;
    const P = period;
    const steps = Math.max(1, Math.floor(P));
    let best = -1, bestPh = 0, total = 0;
    const len = Math.min(env.count(), PHASE_LEN);
    for (let ph = 0; ph < steps; ph++) {
      let s = 0, w = 1;
      for (let k = 0; ; k++) {
        const back = Math.round(ph + k * P);
        if (back >= len) break;
        s += w * (env.at(back) + 0.5 * (env.at(back + 1) + (back > 0 ? env.at(back - 1) : 0)));
        w *= 0.9;
      }
      total += s;
      if (s > best) { best = s; bestPh = ph; }
    }
    const mean = total / steps;
    const sharp = clamp01((best / Math.max(mean, 1e-9) - 1.3) / 2);
    conf = clamp01(conf * 0.6 + 0.4 * sharp * clamp01((repeat - 0.1) / 0.25));
    // bestPh = hops since the last heard beat. Nudge the clock toward it.
    let e = bestPh - phase;
    if (e > P / 2) e -= P;
    if (e < -P / 2) e += P;
    // No wrapping here: the beat clock in block() counts every crossing,
    // so a nudge can neither skip a beat nor play one twice.
    phase = Math.max(0, phase + 0.4 * e);
  }

  function startPulse(s) {
    const v = s * conf;
    if (v <= 0.05) return;
    if (v > pulse) pulse = v;
    pulseCount++;
    pulseStarted = true;
  }

  // One 10 ms block of mono s16 samples. Returns true when a frame is due.
  function block(samples) {
    hop++;
    const on = onsetOf(samples);
    envMean += (on.strength - envMean) * ema(4);
    env.push(on.strength);
    if (on.strength > Math.max(0.04, envMean * 3)) strong += 1;
    strong *= Math.exp(-BLOCK_S / 4);       // strong onsets in the last ~4 s

    if (hop % 50 === 0) chooseTempo();
    if (hop % 25 === 0) alignPhase();

    // Sections: loudness now, over a few seconds, and the loudest lately.
    fastL += (on.rms - fastL) * ema(1.0);
    midL += (on.rms - midL) * ema(6);
    peakL = Math.max(fastL, peakL * Math.exp(-BLOCK_S / 30), 600);
    energy += (Math.pow(clamp01(fastL / peakL), 0.8) - energy) * ema(0.8);
    const ratio = midL > 1 ? fastL / midL : 1;
    if ((ratio > 1.35 || ratio < 0.7) && on.rms >= MUSIC_RMS) sectionHold += BLOCK_S; else sectionHold = 0;
    if (sectionHold >= 1.5 && hop - lastSection >= 6 * HOPS_PER_S) {
      sections++;
      lastSection = hop;
      offsetTarget += 1;
      midL = fastL;
      sectionHold = 0;
    }
    const tempoN = bpm ? clamp01((bpm - 70) / 80) : 0.3;
    const densN = clamp01(strong / 4 / 3);
    vibe += (0.55 * energy + 0.2 * tempoN + 0.25 * densN - vibe) * ema(1.2);
    drift += BLOCK_S * (vib.drift0 + vib.driftK * vibe);
    offset += (offsetTarget - offset) * ema(0.7);

    // The beat clock.
    pulse *= Math.exp(-BLOCK_S / PULSE_TAU_S);
    pulseStarted = false;
    if (period) {
      phase += 1;
      if (!halfDone && phase >= period / 2) {
        halfDone = true;
        // Is there sound off the beat (eighth notes)?
        offAvg += (env.at(0) + env.at(1) - offAvg) * 0.1;
        if (bt.eighth && offRatio > 0.4 && bpm <= EIGHTHS_MAX_BPM) startPulse(bt.eighth);
      }
      if (phase >= period) {
        phase -= period;
        halfDone = false;
        beatCount++;
        const here = env.at(0) + env.at(1) + env.at(2);
        onAvg += (here - onAvg) * 0.1;
        offRatio = onAvg > 1e-6 ? offAvg / onAvg : 0;
        const slot = beatCount % 4;
        // Each slot keeps its own average, so the slot just heard never
        // looks stronger only because the others have faded.
        barAcc[slot] += (here - barAcc[slot]) * (barAcc[slot] ? 0.15 : 1);
        // The downbeat is the strongest beat of four; it only moves when
        // another beat is clearly stronger, so equal beats keep a steady bar.
        for (let i = 0; i < 4; i++) if (barAcc[i] > barAcc[downSlot] * 1.15) downSlot = i;
        const isDown = slot === downSlot;
        if (isDown) startPulse(bt.down);
        else if (bt.beat) startPulse(bt.beat);
      }
    }
    pulses.push(pulse);
    sinceFrame++;
    // A new pulse goes out with the next frame that the light can take, so
    // it is never left to fade until the regular frame.
    if (pulseStarted) pulseWaiting = true;
    if (sinceFrame >= FRAME_HOPS || (pulseWaiting && sinceFrame >= BEAT_FRAME_HOPS)) { sinceFrame = 0; pulseWaiting = false; return true; }
    return false;
  }

  // Colors for every section of each light, index = section number.
  // gain 0-1 fades everything (start, stop); rest 0-1 blends to the resting
  // glow (quiet between songs, paused).
  function render(gainIn, restIn) {
    const gain = gainIn === undefined ? 1 : clamp01(gainIn);
    const rest = restIn === undefined ? 0 : clamp01(restIn);
    const live = 1 - rest;
    const v = vibe * live;
    const out = {};
    Object.keys(govee.LIGHTS).forEach((key) => {
      const n = govee.LIGHTS[key].sections;
      const path = govee.PATHS[key];
      const cols = new Array(n);
      for (let i = 0; i < n; i++) {
        const along = bt.ripple ? path.indexOf(i) / Math.max(1, n - 1) : 0;
        const lift = pulses.at(bt.ripple ? Math.round(along * RIPPLE_HOPS) : 0);
        let c = colorAt(pal, drift + offset + (i / n) * vib.spread);
        const restF = vib.base * 0.8;
        const f = (vib.base + vib.span * v + bt.depth * lift) * live + restF * rest;
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
    return out;
  }

  return {
    block: block,
    render: render,
    setSongBpm: (b) => { songBpm = typeof b === 'number' && b >= 40 && b <= 220 ? b : 0; },
    setPalette: (p) => { if (Array.isArray(p) && p.length) pal = p; },
    setDials: (v, b) => { vib = VIBRANCY[v] || vib; bt = BEAT[b] || bt; },
    features: () => ({
      rms: lastRms, sound: lastRms >= MUSIC_RMS, bpm: Math.round(bpm), confidence: Math.round(conf * 100) / 100, repeat: Math.round(repeat * 100) / 100,
      vibe: vibe, energy: energy, sections: sections, pulses: pulseCount, pulse: pulse,
      phase: period ? phase / period : 0, beats: beatCount, eighths: offRatio > 0.4 && bpm <= EIGHTHS_MAX_BPM
    })
  };
}

module.exports = {
  RATE: RATE,
  BLOCK: BLOCK,
  BLOCK_S: BLOCK_S,
  MIN_RICH: MIN_RICH,
  MUSIC_RMS: MUSIC_RMS,
  PULSE_TAU_S: PULSE_TAU_S,
  EIGHTHS_MAX_BPM: EIGHTHS_MAX_BPM,
  VIBRANCY: VIBRANCY,
  BEAT: BEAT,
  createLook: createLook,
  colorAt: colorAt,
  enforceRich: enforceRich,
  richness: richness,
  hueOf: hueOf,
  rmsOf: rmsOf
};
