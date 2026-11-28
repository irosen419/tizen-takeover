'use strict';
/*
 * Moods compiler, Pi-drawn form (plan section 3). Pure: no I/O, no clock.
 *
 *   compileRender(mood, ctx) -> RenderPlan v1 | null   (null for wled-effects moods)
 *   forestArgs(plan, tune, opts) -> string[]           forest-render's flags, never the host
 *
 * ctx is compileWled's (catalog, wall, night, date, have, sides).
 *
 * engine "forest" (rainforest, rainforest-storm): exactly what engine.can()
 * accepts: the forest table, wall.sections, one palette layer over the three
 * sections, black 162-163, and only the thunder dim with forest-render's own
 * numbers (the director's auto gaps, zones and effects-form fallback stay in
 * the catalog, not in the plan).
 *
 * engine "mood": layers in the shape pi/moods/mood-render.js documents
 * (palette, solid, breathe, sparkle, chase, pixels; ranges are inclusive bulb
 * numbers). The catalog's recipes map onto them like this; the approximations
 * are the general renderer's, not the data's:
 *   solid     -> solid
 *   breathe   -> breathe { min: low * level, period }
 *   sparkle   -> sparkle; a palette sparkle (h-xmas) -> a pixels base at its
 *                floor and one sparkle per palette colour on every n-th bulb
 *   palette   -> palette { spans: spread (0.1 to 8), level: the top of its range }
 *   chase     -> comet: an optional solid base + chase { width: tail, speed: bulbs a lap };
 *                stripes: solid in colour 2 + chase in colour 1 { width: period / 2, gap: period }
 *   candle    -> solid in colour 1 + a quick sparkle toward a dimmer colour (the flicker)
 *   strike    -> a sparse, very short sparkle (random strikes; the general
 *                renderer has no whole-frame flash)
 *   pixels    -> menorah: a solid base at baseLevel, solid flames on the lit
 *                candles and the shamash, and a flicker sparkle on them
 * Every level is multiplied by the zone's brightness (vases.bri or halos.bri
 * over 255), so the balance between vases and halos stays as authored.
 * "$sx" periods come from the mood's vase speed, as WLED would play them.
 * Identical layers on different bulbs are merged when nothing between them
 * overlaps, to stay inside the renderer's 32 layers.
 */
const C = require('./catalog');
const W = require('./compile');
const F = require('./forest-render');

const PAINTINGS = C.PAINTINGS;
const MAX_LAYERS = 32;
const MAX_RANGES = 64;

const round = (v, d) => { const k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hexL = (h) => String(h).toLowerCase();
const withHash = (h) => (String(h).charAt(0) === '#' ? hexL(h) : '#' + hexL(h));

// WLED's breathe period and colorloop cycle for a speed, in seconds.
const breatheSeconds = (sx) => round(clamp(65.536 / ((sx >> 3) + 10), 0.5, 600), 2);
const loopSeconds = (sx) => round(clamp(65.536 / ((sx >> 2) + 2), 1.5, 600), 2);

function blackRanges(wall) {
  const s = wall.spare || [];
  return s.length ? [[s[0], s[s.length - 1]]] : [];
}

// Thunder with only the keys the renderer reads (kind and forest-render's numbers).
function eventsOf(render) {
  const out = {};
  const ev = (render && render.events) || {};
  Object.keys(ev).forEach((name) => {
    const e = ev[name];
    out[name] = { kind: e.kind, size: e.size, depth: e.depth, attack: e.attack, hold: e.hold, release: e.release, floor: e.floor };
  });
  return out;
}

function forestPlan(mood, ctx) {
  const r = mood.render;
  const pal = ctx.catalog.palettes[r.palette] || [];
  return {
    v: 1, id: mood.id, engine: 'forest', leds: ctx.wall.leds, fps: r.fps, maxMa: r.maxMa,
    palette: pal.slice(),
    drift: { cycleSeconds: r.drift && r.drift.cycleSeconds != null ? r.drift.cycleSeconds : null, spans: r.drift && r.drift.spans != null ? r.drift.spans : 1 },
    groups: r.groups != null ? r.groups : 1,
    sections: ctx.wall.sections.map((s) => ({ start: s.start, end: s.end, dim: s.dim.slice() })),
    black: blackRanges(ctx.wall),
    layers: [{ kind: 'palette', ranges: ctx.wall.sections.map((s) => [s.start, s.end]) }],
    events: eventsOf(r),
  };
}

// ---------- general layers ----------

function tokenColour(c, t) {
  if (c === '$vase') return t.vase;
  if (c === '$side') return t.side;
  if (c === '$col1') return t.col1;
  if (c === '$col2') return t.col2;
  return c ? hexL(c) : null;
}

function levelOf(l) {
  if (Array.isArray(l.level)) return Math.max(l.level[0], l.level[1]);
  return typeof l.level === 'number' ? l.level : 1;
}

function rangeLen(ranges) { return ranges.reduce((t, r) => t + r[1] - r[0] + 1, 0); }

// Every n-th bulb of the ranges, starting at offset k, as one-bulb ranges.
function everyNth(ranges, n, k) {
  const out = [];
  ranges.forEach((r) => { for (let led = r[0] + k; led <= r[1]; led += n) out.push([led, led]); });
  return out;
}

// One catalog recipe layer -> renderer layers, on the given bulbs.
function mapLayer(L, ranges, lvl, t, ctx, sx) {
  const col = (c) => tokenColour(c, t);
  const lv = clamp(levelOf(L) * lvl, 0, 1);
  const out = [];
  if (L.kind === 'solid') {
    const c = col(L.color);
    if (c) out.push({ kind: 'solid', ranges, color: c, level: round(lv) });
  } else if (L.kind === 'breathe') {
    const c = col(L.color);
    const period = L.period === '$sx' ? breatheSeconds(sx) : (typeof L.period === 'number' ? L.period : 6);
    if (c) out.push({ kind: 'breathe', ranges, color: c, level: round(lv), min: round(clamp((L.low == null ? 0.2 : L.low) * lv, 0, 1)), period });
  } else if (L.kind === 'sparkle') {
    const spark = (c, rr, level) => ({ kind: 'sparkle', ranges: rr, color: c, level: round(level), density: L.density, rise: L.rise, hold: L.hold.slice(), fall: L.fall });
    if (L.palette) {
      const pal = (ctx.catalog.palettes[L.palette] || []).map(withHash);
      const floor = L.floor == null ? 0 : L.floor;
      if (floor > 0) out.push({ kind: 'pixels', ranges, colors: pal, level: round(clamp(floor * lv, 0, 1)) });
      pal.forEach((c, k) => {
        const rr = everyNth(ranges, pal.length, k);
        if (rr.length) out.push(spark(c, rr, lv));
      });
    } else {
      const c = col(L.color);
      if (c) out.push(spark(c, ranges, lv));
    }
  } else if (L.kind === 'palette') {
    const pal = (ctx.catalog.palettes[L.palette] || []).map(withHash);
    const cyc = L.cycleSeconds === '$sx' ? loopSeconds(sx) : L.cycleSeconds;
    const p = { kind: 'palette', ranges, palette: pal, level: round(lv) };
    if (typeof cyc === 'number') p.cycleSeconds = Math.max(1.5, cyc);
    p.spans = round(clamp(typeof L.spread === 'number' ? L.spread : 1, 0.1, 8));
    out.push(p);
  } else if (L.kind === 'chase') {
    const len = rangeLen(ranges) / ranges.length;
    if (L.mode === 'stripes') {
      const cs = (L.colors || []).map(col);
      const period = L.period || 8;
      if (cs[1]) out.push({ kind: 'solid', ranges, color: cs[1], level: round(lv) });
      if (cs[0]) out.push({ kind: 'chase', ranges, color: cs[0], level: round(lv), width: round(period / 2, 2), speed: round(period / (L.seconds || 8), 2), gap: period });
    } else {
      if (L.base) out.push({ kind: 'solid', ranges, color: col(L.base), level: round(lv) });
      const c = col(L.color);
      if (c) out.push({ kind: 'chase', ranges, color: c, level: round(lv), width: L.tail || 3, speed: round(len / (L.lapSeconds || 6), 2) });
    }
  } else if (L.kind === 'candle') {
    const cs = (L.colors || []).map(col).filter(Boolean);
    if (cs.length) {
      out.push({ kind: 'solid', ranges, color: cs[0], level: round(lv) });
      const dim = cs[cs.length - 1];
      out.push({ kind: 'sparkle', ranges, color: dim, level: round(clamp(lv * (L.low == null ? 0.35 : L.low), 0, 1)), density: 0.5, rise: 0.08, hold: [0.05, 0.3], fall: 0.2 });
    }
  } else if (L.kind === 'strike') {
    const c = col(L.color);
    if (c) out.push({ kind: 'sparkle', ranges, color: c, level: round(lv), density: 0.03, rise: 0.03, hold: [0.03, 0.1], fall: 0.3 });
  }
  return out;
}

// Menorah pixels on one painting: base, flames, shamash, flicker.
function menorahLayers(L, zoneRanges, lvl, ctx, night) {
  const out = [];
  const lo = zoneRanges[0][0], hi = zoneRanges[zoneRanges.length - 1][1];
  const inZone = (led) => led >= lo && led <= hi;
  const mb = C.menorahBulbs(ctx.wall, night == null ? 8 : night);
  out.push({ kind: 'solid', ranges: zoneRanges, color: hexL(L.base), level: round(clamp((L.baseLevel == null ? 1 : L.baseLevel) * lvl, 0, 1)) });
  const flame = mb.lit.filter(inZone).map((b) => [b, b]);
  const sh = mb.shamash.filter(inZone).map((b) => [b, b]);
  const pair = (rr, cols) => {
    if (!rr.length) return;
    out.push({ kind: 'solid', ranges: rr, color: hexL(cols[cols.length - 1]), level: round(lvl) });
    out.push({ kind: 'sparkle', ranges: rr, color: hexL(cols[0]), level: round(lvl), density: 0.6, rise: 0.06, hold: [0.05, 0.25], fall: 0.2 });
  };
  pair(flame, L.flame);
  pair(sh, L.shamash);
  return out;
}

// The recipe of a design (its fallback's when it has none).
function recipeOf(pick, ctx) {
  if (pick.d.pi) return pick.d.pi;
  const f = pick.d.fallback && C.designById(ctx.catalog, pick.d.fallback);
  return f && f.pi ? f.pi : [];
}

const sameButRanges = (a, b) => {
  const x = Object.assign({}, a, { ranges: null });
  const y = Object.assign({}, b, { ranges: null });
  return JSON.stringify(x) === JSON.stringify(y);
};
const overlaps = (ra, rb) => ra.some((a) => rb.some((b) => a[0] <= b[1] && b[0] <= a[1]));

// Merge identical layers when no layer between them touches the later one's bulbs.
function mergeLayers(layers) {
  const out = [];
  layers.forEach((l) => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (sameButRanges(out[i], l) && out[i].ranges.length + l.ranges.length <= MAX_RANGES) {
        const between = out.slice(i + 1);
        if (!between.some((m) => overlaps(m.ranges, l.ranges))) {
          out[i].ranges = out[i].ranges.concat(l.ranges);
          return;
        }
      }
      if (overlaps(out[i].ranges, l.ranges)) break;
    }
    out.push(l);
  });
  return out;
}

function generalPlan(mood, ctx) {
  const r = mood.render;
  const wall = ctx.wall;
  const night = W.nightOf(mood, ctx);
  const sx = mood.vases ? mood.vases.sx : 128;
  let layers = [];
  if (mood.vases) {
    const pick = W.pickDesign(mood.vases.design, ctx, []);
    const lvl = mood.vases.bri / 255;
    if (pick) {
      recipeOf(pick, ctx).forEach((L) => {
        W.VASE_ZONES.forEach((z, i) => {
          const t = { vase: hexL(mood.vases.c[i]) };
          layers = layers.concat(mapLayer(L, wall.zones[z].r.map((x) => x.slice()), lvl, t, ctx, sx));
        });
      });
    }
  }
  if (mood.halos) {
    const lvl = mood.halos.bri / 255;
    PAINTINGS.forEach((p) => {
      const pick = W.pickDesign(mood.halos[p], ctx, []);
      if (!pick) return;
      const zone = 'halo.' + p;
      const zr = wall.zones[zone].r.map((x) => x.slice());
      const t = { col1: W.designCol1(pick.d, p, mood, wall), col2: W.designCol2(pick.d, p) };
      recipeOf(pick, ctx).forEach((L) => {
        if (L.kind === 'pixels' && L.from === 'menorah') { layers = layers.concat(menorahLayers(L, zr, lvl, ctx, night)); return; }
        const usesSide = L.color === '$side' || L.base === '$side';
        if (usesSide && W.isPerSide(pick.d) && W.sidesOk(zone, mood, ctx)) {
          W.sideColours(pick.d, p, mood, wall).forEach((s) => {
            if (s.color) layers = layers.concat(mapLayer(L, [[s.a, s.b]], lvl, Object.assign({}, t, { side: s.color }), ctx, sx));
          });
        } else if (usesSide) {
          const one = W.blendedSide(pick.d, p, mood, wall);
          if (one) layers = layers.concat(mapLayer(L, zr, lvl, Object.assign({}, t, { side: one }), ctx, sx));
        } else {
          layers = layers.concat(mapLayer(L, zr, lvl, t, ctx, sx));
        }
      });
    });
  }
  layers = mergeLayers(layers);
  if (!layers.length) {
    // A wall with nothing lit still needs one layer for the renderer: black.
    layers = [{ kind: 'solid', ranges: [[0, wall.lastLit]], color: '#000000', level: 0 }];
  }
  if (layers.length > MAX_LAYERS) throw new Error('mood needs more than ' + MAX_LAYERS + ' layers');
  return {
    v: 1, id: mood.id, engine: 'mood', leds: wall.leds, fps: r.fps, maxMa: r.maxMa,
    drift: { cycleSeconds: r.drift && r.drift.cycleSeconds != null ? r.drift.cycleSeconds : null, spans: r.drift && r.drift.spans != null ? r.drift.spans : 1 },
    groups: r.groups != null ? r.groups : 1,
    black: blackRanges(wall),
    layers,
    events: eventsOf(r),
  };
}

function compileRender(mood, ctx) {
  if (!ctx || !ctx.catalog || !ctx.wall) throw new Error('compileRender needs ctx.catalog and ctx.wall');
  const r = mood && mood.render;
  if (!r || r.type !== 'pi-drawn') return null;
  return r.engine === 'forest' ? forestPlan(mood, ctx) : generalPlan(mood, ctx);
}

// forest-render's flags for a plan and the Pi-side tune { cycleSeconds, spans,
// gamma, seed }: the same list, in the same order, as engine.argsFor(). Never
// the host, never --auto, always --no-preset. opts.controlPort: default 4810.
function forestArgs(plan, tune, opts) {
  const p = plan || {};
  const t = tune || {};
  const D = F.DEFAULTS;
  const num = (v) => typeof v === 'number' && isFinite(v);
  const has = (k) => Object.prototype.hasOwnProperty.call(t, k) && t[k] !== undefined;
  const drift = p.drift || {};
  const port = opts && Number.isInteger(opts.controlPort) ? opts.controlPort : D.controlPort;
  const cycle = has('cycleSeconds') ? t.cycleSeconds : drift.cycleSeconds;
  const spans = has('spans') && t.spans != null ? t.spans : (drift.spans != null ? drift.spans : D.spans);
  const gamma = has('gamma') ? t.gamma : p.gamma;
  const a = ['--no-preset', '--fps', String(num(p.fps) ? p.fps : D.fps)];
  if (cycle != null) a.push('--cycle', String(cycle));
  a.push('--spans', String(spans));
  a.push('--groups', String(num(p.groups) ? p.groups : D.groups));
  a.push('--max-ma', String(num(p.maxMa) ? p.maxMa : D.maxMa));
  if (gamma === 'off' || gamma === false) a.push('--gamma', 'off');
  else if (num(gamma)) a.push('--gamma', String(gamma));
  a.push('--control-port', String(port));
  if (has('seed') && t.seed != null) a.push('--seed', String(t.seed));
  return a;
}

module.exports = { compileRender, forestArgs, mergeLayers, breatheSeconds, loopSeconds, MAX_LAYERS };
