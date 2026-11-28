'use strict';
/*
 * Moods compiler, WLED effects form (plan section 3). Pure: no I/O, no clock,
 * no random unless passed in.
 *
 *   compileWled(mood, ctx) -> { bodies: [state, ...], budget: { ma, scale }, approx: [], uses: { fx: [], pal: [] } }
 *   checkState(body, wall) -> string[]      [] = safe to send; anything else is refused
 *   budgetMa(body | [body, ...], ctx) -> mA  WLED's own sum, an upper bound
 *   restoreBodies(snapshot, wall) -> [state, ...]
 *   eventBodies(mood, name, ctx, rng) -> { down, up, holdMs } | null
 *
 * ctx = { catalog, wall, briPct, night, date: { y, m, d }, fxIds, palIds, ledMa,
 *         have: { mic: true | false | null }, presetBri, segBri, sides }
 *   briPct    1-100, the user's brightness for this mood (default: the mood's bri)
 *   night     Menorah night 1-8 (else nightFor(date), else 8: all candles)
 *   fxIds     WLED's /json/effects (array of names) or { name: id }; effects are
 *             resolved by NAME so a firmware that moved an id still gets the right one
 *   palIds    WLED's /json/palettes, the same way
 *   ledMa     measured mA per bulb at full white (default wall.power.ledMa)
 *   have.mic  false = the probe found no sound-reactive effects: mic designs swap
 *             to their fallback; null/undefined = not probed: sent as written,
 *             tagged "mic-unverified"
 *   presetBri the saved brightness of the preset a preset mood selects, when known
 *             (the snapshot's bri when it was taken on that preset)
 *   segBri    { segmentId: bri } for eventBodies on a preset mood (default 255)
 *   sides     "force" = one segment per frame side even while wall.sides is unsure
 *
 * Body layout (the artifact's allSegs()): segments 0-3 vases, 4-15 halos (one
 * per frame, or one per side), 16-31 extras (Menorah candles, the check mood's
 * drops and candles); every unused id is sent { id, stop: 0 }. stop is
 * exclusive and never above 162 (bulbs 162-163 are spare and stay dark).
 *
 * Power (WLED's sum, forest-render's constants): baseMa + sum over lit bulbs of
 * (r+g+b)/255 * ledMa/3 * segBri/255 * B/255, each segment at its brightest
 * colour or palette step (twinkles count as fully lit). The scale is worked out
 * at B = 255, so a brightness change only ever changes the top-level bri, and
 * at 100% every body is at or under wall.power.budgetMa (the hidden check mood,
 * which has no brightness control, is fitted at its own 20%). Flash effects are first
 * capped so all of them together add at most wall.power.flashMa.
 * A preset mood (wled.preset) selects the preset and, when the forest wash at
 * that brightness would top the budget, a second body caps bri; its estimate is
 * forest-render's own (gamma 2.8 peak of the drift), since the preset is the wash.
 */
const C = require('./catalog');
const F = require('./forest-render');

const TOP_KEYS = ['on', 'bri', 'transition', 'tt', 'seg', 'ps'];
const SEG_KEYS = ['id', 'start', 'stop', 'grp', 'spc', 'of', 'on', 'bri', 'col', 'fx', 'sx', 'ix', 'pal', 'c1', 'c2', 'o1', 'o2', 'o3'];
const BOOL_KEYS = ['on', 'o1', 'o2', 'o3'];
const MAX_ID = 31;
const VASE_IDS = [0, 1, 2, 3];
const HALO_FIRST = 4;
const EXTRA_FIRST = 16;
const TRANSITION = 7;
const STOP_MAX = 162; // exclusive: bulbs 0..161
const PAINTINGS = C.PAINTINGS;
const VASE_ZONES = ['vase1', 'vase2', 'vase3', 'vase4'];
const BLACK = '#000000';
// Effects that draw a palette even on palette 0 ("Default"); pacifica always uses its own.
const PALETTE_FX = { rainbow: 'rainbow', colorloop: 'rainbow', colorwaves: 'rainbow', aurora: 'rainbow', palette: 'rainbow' };
const OWN_PALETTE_FX = { pacifica: 'ocean' };
const PRESET_GAMMA = 2.8;

// ---------- small helpers ----------

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isByte = (n) => Number.isInteger(n) && n >= 0 && n <= 255;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rgb = (h) => C.hexToRgb(h);
const hex = (c) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sum3 = (c) => c[0] + c[1] + c[2];
const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);

// Weighted average of [hex, weight] pairs (null colours skipped); null if none.
function blend(pairs) {
  let w = 0;
  const acc = [0, 0, 0];
  pairs.forEach((p) => {
    if (!p[0] || !(p[1] > 0)) return;
    const c = rgb(p[0]);
    acc[0] += c[0] * p[1]; acc[1] += c[1] * p[1]; acc[2] += c[2] * p[1];
    w += p[1];
  });
  return w ? hex(acc.map((v) => v / w)) : null;
}

function ledMaOf(ctx) {
  const w = ctx && ctx.wall;
  return ctx && typeof ctx.ledMa === 'number' && ctx.ledMa > 0 ? ctx.ledMa : (w && w.power ? w.power.ledMa : F.DEFAULT_LED_MA);
}

function briPctOf(mood, ctx) {
  const p = ctx && typeof ctx.briPct === 'number' && isFinite(ctx.briPct) ? ctx.briPct : mood.bri;
  return clamp(Math.round(p), 1, 100);
}
const masterOf = (pct) => Math.round(255 * pct / 100);

// Menorah night: ctx.night, else nightFor(ctx.date), else the param's max (8).
function nightOf(mood, ctx) {
  const p = mood && mood.param && mood.param.night;
  if (!p) return null;
  let n = ctx && Number.isInteger(ctx.night) ? ctx.night : null;
  if (n == null && ctx && ctx.date) n = C.nightFor(ctx.date, ctx.catalog);
  if (n == null) n = p.max;
  return clamp(n, p.min, p.max);
}

// id for a WLED name from a probe list: an array of names (index = id) or { name: id }.
function idFromList(list, name) {
  if (Array.isArray(list)) { const i = list.indexOf(name); return i >= 0 ? i : null; }
  if (isObj(list) && Number.isInteger(list[name])) return list[name];
  return null;
}
function nameFromList(list, id) {
  if (Array.isArray(list)) return typeof list[id] === 'string' ? list[id] : null;
  if (isObj(list)) { const k = Object.keys(list).find((n) => list[n] === id); return k || null; }
  return null;
}

// { id, name, ok } for a catalog fx key, by name against ctx.fxIds when given.
function resolveFx(key, ctx) {
  const f = C.fxByKey(ctx.catalog, key);
  if (!f) return { id: 0, name: 'Solid', ok: false };
  if (ctx.fxIds == null) return { id: f.id, name: f.name, ok: true };
  const id = idFromList(ctx.fxIds, f.name);
  return id == null ? { id: null, name: f.name, ok: false } : { id, name: f.name, ok: true };
}

// { id, name } for a catalog palette number, by name against ctx.palIds when given (missing: 0).
function resolvePal(n, ctx) {
  const num = n == null ? 0 : n;
  const p = C.palByNumber(ctx.catalog, num);
  if (!p) return { id: num, name: null };
  if (ctx.palIds == null) return { id: p.id, name: p.name };
  const id = idFromList(ctx.palIds, p.name);
  return id == null ? { id: 0, name: 'Default' } : { id, name: p.name };
}

// The catalog fx key for a WLED effect number (through the probe's names when given).
function fxKeyOf(id, ctx) {
  const cat = ctx && ctx.catalog;
  if (!cat) return null;
  const fx = cat.fx || {};
  if (ctx.fxIds != null) {
    const name = nameFromList(ctx.fxIds, id);
    return Object.keys(fx).find((k) => fx[k].name === name) || null;
  }
  return Object.keys(fx).find((k) => fx[k].id === id) || null;
}
function palKeyOf(id, ctx) {
  const cat = ctx && ctx.catalog;
  if (!cat) return null;
  const pals = cat.pals || {};
  if (ctx.palIds != null) {
    const name = nameFromList(ctx.palIds, id);
    return Object.keys(pals).find((k) => pals[k].name === name) || null;
  }
  return Object.keys(pals).find((k) => pals[k].id === id) || null;
}

// ---------- designs: swaps and colours (shared with render.js and preview.js) ----------

// The design actually played for a design id, after the mic and missing-effect
// swaps. tags collects approx tags. Returns { id, d } or null.
function pickDesign(id, ctx, tags) {
  if (!id) return null;
  const cat = ctx.catalog;
  let d = C.designById(cat, id);
  if (!d) return null;
  const add = (t) => { if (tags && tags.indexOf(t) < 0) tags.push(t); };
  const mic = d.needs.indexOf('mic') >= 0;
  const have = ctx.have || {};
  if (mic && have.mic === false && d.fallback) {
    add('mic-fallback');
    return { id: d.fallback, d: C.designById(cat, d.fallback), swapped: true };
  }
  if (ctx.fxIds != null && !resolveFx(d.wled.fx, ctx).ok && d.fallback) {
    add(mic ? 'mic-fallback' : 'fx-missing');
    return { id: d.fallback, d: C.designById(cat, d.fallback), swapped: true };
  }
  if (mic && have.mic !== true) add('mic-unverified');
  return { id, d, swapped: false };
}

// The colour of a vase index, or half way between two.
function vaseColour(mood, ref) {
  const c = mood.vases && mood.vases.c;
  if (!c) return null;
  if (Array.isArray(ref)) return hex(mix(rgb(c[ref[0]]), rgb(c[ref[1]]), 0.5));
  return Number.isInteger(ref) && c[ref] ? c[ref].toLowerCase() : null;
}

// True when a design paints each frame side on its own.
const isPerSide = (d) => !!(d && d.wled && (d.wled.sides || (d.wled.colFrom === 'vases' && d.wled.perSide)));

// Each side of a frame in bulb order: [{ side, a, b, color|null }].
function sideColours(d, painting, mood, wall) {
  const zone = 'halo.' + painting;
  const sd = wall.sides && wall.sides[zone];
  if (!sd) return [];
  const w = d.wled;
  return sd.s.map((row) => {
    const side = C.physicalSide(wall, zone, row[0]);
    let color = null;
    if (w.sides) color = w.sides[painting] ? w.sides[painting][side] : null;
    else if (w.colFrom === 'vases') color = vaseColour(mood, w.vaseMap[painting][side]);
    return { side, a: row[1], b: row[2], color: color ? color.toLowerCase() : null };
  });
}

// One colour around the whole frame: the lit sides blended by bulb count.
function blendedSide(d, painting, mood, wall) {
  return blend(sideColours(d, painting, mood, wall).map((s) => [s.color, s.b - s.a + 1]));
}

// Whether per-side segments may be sent for a frame.
function sidesOk(zone, mood, ctx) {
  if (mood.hidden || (ctx && ctx.sides === 'force')) return true;
  const sd = ctx.wall.sides && ctx.wall.sides[zone];
  return !!(sd && sd.sure);
}

// Colour 1 and 2 of a single-segment design on a painting.
function designCol1(d, painting, mood, wall) {
  const w = d.wled;
  if (w.col && w.col.length) return w.col[0].toLowerCase();
  if (w.colBy && w.colBy[painting]) return w.colBy[painting][0].toLowerCase();
  if (w.colFrom === 'vases') return vaseColour(mood, w.vaseMap[painting].top);
  if (w.sides) return blendedSide(d, painting, mood, wall);
  return '#ffffff';
}
function designCol2(d, painting) {
  const w = d.wled;
  if (w.col && w.col[1]) return w.col[1].toLowerCase();
  if (w.colBy && w.colBy[painting] && w.colBy[painting][1]) return w.colBy[painting][1].toLowerCase();
  if (w.col2) return w.col2.toLowerCase();
  if (w.glint) return w.glint.toLowerCase();
  return BLACK;
}

// ---------- WLED segments ----------

// Effect settings for a segment (fx, sx, ix, pal, colours, o1, c1, c2): each fx
// segment sets all of them so nothing is left over from the last mood.
function fxSettings(spec, ctx, uses, tags) {
  let r = resolveFx(spec.fx, ctx);
  if (!r.ok) {
    if (tags && tags.indexOf('fx-missing') < 0) tags.push('fx-missing');
    r = resolveFx('solid', ctx);
    if (!r.ok) r = { id: 0, name: 'Solid', ok: true };
  }
  const p = resolvePal(spec.pal, ctx);
  if (uses.fx.indexOf(r.name) < 0) uses.fx.push(r.name);
  if (p.name && uses.pal.indexOf(p.name) < 0) uses.pal.push(p.name);
  const cols = (spec.col || []).slice(0, 3).map((h) => rgb(h));
  while (cols.length < 2) cols.push([0, 0, 0]);
  return {
    col: cols, fx: r.id, sx: isByte(spec.sx) ? spec.sx : 128, ix: isByte(spec.ix) ? spec.ix : 128, pal: p.id,
    c1: isByte(spec.c1) ? spec.c1 : 128, c2: isByte(spec.c2) ? spec.c2 : 128, o1: !!spec.o1,
    _fx: spec.fx, _pal: spec.pal == null ? 0 : spec.pal,
  };
}

function wspec(w, col, extra) {
  return Object.assign({ fx: w.fx, sx: w.sx, ix: w.ix, pal: w.pal, c1: w.c1, c2: w.c2, o1: w.o1, col }, extra || {});
}

// Runs { a, b, bri, spec } (inclusive bulbs) for one painting's halo.
function haloRuns(painting, mood, ctx, tags, extras, night) {
  const h = mood.halos;
  const pick = pickDesign(h && h[painting], ctx, tags);
  if (!pick) return [];
  const d = pick.d;
  const w = d.wled;
  const zone = 'halo.' + painting;
  const bulbs = C.zoneBulbs(ctx.wall, zone);
  if (!bulbs.length) return [];
  const a0 = bulbs[0], b0 = bulbs[bulbs.length - 1];
  const bri = h.bri;
  if (w.menorah) {
    const m = w.menorah;
    const mb = C.menorahBulbs(ctx.wall, night == null ? 8 : night);
    const baseBri = Math.max(m.base.briMin || 0, Math.round(bri * (m.base.briScale == null ? 1 : m.base.briScale)));
    const inZone = (led) => led >= a0 && led <= b0;
    mb.lit.filter(inZone).forEach((led) => extras.push({ a: led, b: led, bri, spec: wspec(m.flame, m.flame.col) }));
    const sh = mb.shamash.filter(inZone).sort((x, y) => x - y);
    if (sh.length) extras.push({ a: sh[0], b: sh[sh.length - 1], bri, spec: wspec(m.shamash, m.shamash.col) });
    if (ctx.wall.menorah && ctx.wall.menorah.sure === false && tags.indexOf('candles') < 0) tags.push('candles');
    return [{ a: a0, b: b0, bri: baseBri, spec: wspec(m.base, m.base.col) }];
  }
  if (isPerSide(d)) {
    const col2 = designCol2(d, painting);
    if (sidesOk(zone, mood, ctx)) {
      return sideColours(d, painting, mood, ctx.wall).filter((s) => s.color)
        .map((s) => ({ a: s.a, b: s.b, bri, spec: wspec(w, [s.color, col2]) }));
    }
    if (tags.indexOf('sides') < 0) tags.push('sides');
    const one = blendedSide(d, painting, mood, ctx.wall);
    return one ? [{ a: a0, b: b0, bri, spec: wspec(w, [one, col2]) }] : [];
  }
  const cols = [designCol1(d, painting, mood, ctx.wall), designCol2(d, painting)];
  if (w.col && w.col[2]) cols.push(w.col[2].toLowerCase());
  return [{ a: a0, b: b0, bri, spec: wspec(w, cols) }];
}

// Remove the extras' bulbs from the runs (a run may split in two).
function carve(runs, extras) {
  let out = runs;
  extras.forEach((e) => {
    const next = [];
    out.forEach((r) => {
      if (e.b < r.a || e.a > r.b) { next.push(r); return; }
      if (r.a < e.a) next.push(Object.assign({}, r, { b: e.a - 1 }));
      if (r.b > e.b) next.push(Object.assign({}, r, { a: e.b + 1 }));
    });
    out = next;
  });
  return out;
}

// Every mood segment resets grouping, spacing and offset, so a segment left
// grouped or spaced by an earlier look (or by hand in WLED) lights every bulb.
function segOf(id, run, settings) {
  const s = { id, start: run.a, stop: run.b + 1, grp: 1, spc: 0, of: 0, on: true, bri: run.bri };
  s.col = settings.col; s.fx = settings.fx; s.sx = settings.sx; s.ix = settings.ix; s.pal = settings.pal;
  s.c1 = settings.c1; s.c2 = settings.c2; s.o1 = settings.o1;
  return s;
}

// ---------- power ----------

function paletteMax(name, catalog) {
  const p = catalog && catalog.palettes && catalog.palettes[name];
  return p ? Math.max.apply(null, p.map((h) => sum3(rgb(h)))) : 0;
}

// The brightest a segment's bulbs can be, as r+g+b (0..765).
function segMaxSum(seg, ctx) {
  let m = 0;
  (Array.isArray(seg.col) ? seg.col : []).forEach((c) => {
    if (Array.isArray(c)) m = Math.max(m, (c[0] || 0) + (c[1] || 0) + (c[2] || 0));
    else if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) m = Math.max(m, sum3(rgb(c)));
  });
  const cat = ctx && ctx.catalog;
  if (!cat) return seg.fx != null && seg.fx !== 0 ? Math.max(m, 765) : m;
  const fxKey = seg.fx == null ? null : fxKeyOf(seg.fx, ctx);
  const palKey = seg.pal == null ? null : palKeyOf(seg.pal, ctx);
  const pal = palKey ? cat.pals[palKey] : null;
  if (pal && pal.steps) m = Math.max(m, paletteMax(pal.steps, cat));
  if (fxKey && OWN_PALETTE_FX[fxKey]) m = Math.max(m, paletteMax(OWN_PALETTE_FX[fxKey], cat));
  if (fxKey && PALETTE_FX[fxKey] && (!seg.pal || palKey === 'default')) m = Math.max(m, paletteMax(PALETTE_FX[fxKey], cat));
  if (seg.fx != null && !fxKey) m = 765; // an effect we do not know: count it as white
  return m;
}

function segMa(seg, B, ctx) {
  if (!isObj(seg) || seg.on === false || !Number.isInteger(seg.start) || !Number.isInteger(seg.stop) || seg.stop <= seg.start) return 0;
  const n = seg.stop - seg.start;
  const bri = isByte(seg.bri) ? seg.bri : 255;
  return n * segMaxSum(seg, ctx) / 255 * ledMaOf(ctx) / 3 * bri / 255 * B / 255;
}

// The forest wash (the live preset) at WLED brightness bri: forest-render's own peak.
function presetMa(bri, ctx) {
  const lm = ledMaOf(ctx);
  const ledMa = lm === F.DEFAULT_LED_MA ? null : new Float64Array(F.LED_COUNT).fill(lm);
  const base = ctx && ctx.wall && ctx.wall.power ? ctx.wall.power.baseMa : F.BASE_MA;
  return base + F.peakLedPart({ spans: 1, gamma: PRESET_GAMMA, bri, ledMa }, 256);
}

// Highest brightness at which the preset's wash stays inside the budget.
function presetCap(ctx) {
  const pw = ctx.wall.power;
  const full = presetMa(255, ctx) - pw.baseMa;
  if (full <= 0) return 255;
  return clamp(Math.floor(255 * (pw.budgetMa - pw.baseMa) / full), 1, 255);
}

// mA for a body, or for the state a list of bodies leaves (later keys win).
// A body that selects a preset is estimated as the forest wash at its bri
// (or ctx.presetBri, or 255 when not known).
function budgetMa(body, ctx) {
  const c = ctx || {};
  const base = c.wall && c.wall.power ? c.wall.power.baseMa : F.BASE_MA;
  const list = Array.isArray(body) ? body : [body];
  let preset = false;
  let bri = null;
  const segs = {};
  list.forEach((b) => {
    if (!isObj(b)) return;
    if (b.ps != null) { preset = true; bri = null; Object.keys(segs).forEach((k) => { delete segs[k]; }); }
    if (isByte(b.bri)) bri = b.bri;
    (Array.isArray(b.seg) ? b.seg : []).forEach((s) => {
      if (!isObj(s)) return;
      const prev = segs[s.id] || {};
      segs[s.id] = s.stop === 0 ? null : Object.assign({}, prev, s);
    });
  });
  if (preset) {
    const pb = bri != null ? bri : (isByte(c.presetBri) ? c.presetBri : 255);
    return presetMa(pb, c);
  }
  const B = bri != null ? bri : (isByte(c.bri) ? c.bri : 255);
  let ma = base;
  Object.keys(segs).forEach((k) => { if (segs[k]) ma += segMa(segs[k], B, c); });
  return ma;
}

// The flash cap, then one fixed scale for every segment, both at master
// brightness Bref (255 for every mood a person can dim, so dimming only changes bri).
function fitBudget(segs, ctx, Bref) {
  const pw = ctx.wall.power;
  const flashOf = (s) => { const k = s._fx; const f = k && C.fxByKey(ctx.catalog, k); return !!(f && f.flash); };
  const flash = segs.filter(flashOf);
  const flashMa = flash.reduce((t, s) => t + segMa(s, Bref, ctx), 0);
  let flashScale = 1;
  if (flashMa > pw.flashMa) {
    flashScale = pw.flashMa / flashMa;
    flash.forEach((s) => { s.bri = Math.max(1, Math.floor(s.bri * flashScale)); });
    while (flash.reduce((t, s) => t + segMa(s, Bref, ctx), 0) > pw.flashMa && flash.some((s) => s.bri > 1)) {
      flash.forEach((s) => { if (s.bri > 1) s.bri -= 1; });
    }
  }
  const orig = segs.map((s) => s.bri);
  const total = () => pw.baseMa + segs.reduce((t, s) => t + segMa(s, Bref, ctx), 0);
  let scale = 1;
  const t0 = total();
  if (t0 > pw.budgetMa) {
    scale = (pw.budgetMa - pw.baseMa) / (t0 - pw.baseMa);
    for (let tries = 0; tries < 200; tries++) {
      segs.forEach((s, i) => { s.bri = Math.max(1, Math.floor(orig[i] * scale)); });
      if (total() <= pw.budgetMa) break;
      scale *= 0.98;
    }
  }
  return { scale: Math.round(scale * 10000) / 10000, flash: Math.round(flashScale * 10000) / 10000 };
}

// ---------- compileWled ----------

function needCtx(ctx) {
  if (!ctx || !ctx.catalog || !ctx.wall) throw new Error('compile needs ctx.catalog and ctx.wall');
}

function compileWled(mood, ctx) {
  needCtx(ctx);
  if (!mood) throw new Error('no mood');
  const tags = [];
  const uses = { fx: [], pal: [] };
  const pct = briPctOf(mood, ctx);
  const B = masterOf(pct);
  const pw = ctx.wall.power;

  if (mood.wled && Number.isInteger(mood.wled.preset)) {
    const changed = typeof ctx.briPct === 'number' && pct !== mood.bri;
    const cap = presetCap(ctx);
    const bodies = [{ on: true, ps: mood.wled.preset }];
    let sent = null;
    if (changed) sent = Math.min(B, cap);
    else if (!isByte(ctx.presetBri) || ctx.presetBri > cap) sent = cap;
    if (sent != null) bodies.push({ bri: sent });
    const known = isByte(ctx.presetBri) ? ctx.presetBri : 255;
    const ma = budgetMa(bodies, Object.assign({}, ctx, { presetBri: known }));
    const scale = sent == null ? 1 : sent / Math.max(1, changed ? B : known);
    return { bodies, budget: { ma: Math.round(ma), scale: Math.round(Math.min(1, scale) * 10000) / 10000 }, approx: tags, uses };
  }

  const night = nightOf(mood, ctx);
  const runs = []; // { kind: 'vase'|'halo'|'extra', a, b, bri, spec }
  const extras = [];
  if (mood.vases) {
    const pick = pickDesign(mood.vases.design, ctx, tags);
    if (pick) {
      const w = pick.d.wled;
      VASE_ZONES.forEach((z, i) => {
        const r = ctx.wall.zones[z].r[0];
        const col = [mood.vases.c[i].toLowerCase(), (w.glint || BLACK).toLowerCase()];
        runs.push({ kind: 'vase', a: r[0], b: r[1], bri: mood.vases.bri, spec: wspec(w, col, { sx: isByte(w.sx) ? w.sx : mood.vases.sx }) });
      });
    }
  }
  let halo = [];
  PAINTINGS.forEach((p) => { halo = halo.concat(haloRuns(p, mood, ctx, tags, extras, night)); });
  const x = mood.extras || {};
  if (x.drops) ['drops.left', 'drops.right'].forEach((z) => {
    C.zoneBulbs(ctx.wall, z).length && ctx.wall.zones[z].r.forEach((r) => extras.push({ a: r[0], b: r[1], bri: 255, spec: { fx: 'solid', col: [x.drops] } }));
  });
  if (x.candles || x.shamash) {
    const mb = C.menorahBulbs(ctx.wall, 8);
    if (x.candles) mb.lit.forEach((led) => extras.push({ a: led, b: led, bri: 255, spec: { fx: 'solid', col: [x.candles] } }));
    if (x.shamash && mb.shamash.length) {
      const sh = mb.shamash.slice().sort((p, q) => p - q);
      extras.push({ a: sh[0], b: sh[sh.length - 1], bri: 255, spec: { fx: 'solid', col: [x.shamash] } });
    }
    if (ctx.wall.menorah && ctx.wall.menorah.sure === false && tags.indexOf('candles') < 0) tags.push('candles');
  }
  extras.sort((p, q) => p.a - q.a);
  halo = carve(halo, extras);

  // Ids: vases 0-3, halos from 4, extras from 16 (or right after the halos).
  const segs = [];
  runs.forEach((r, i) => segs.push(Object.assign(segOf(VASE_IDS[i], r, fxSettings(r.spec, ctx, uses, tags)), { _fx: r.spec.fx })));
  halo.forEach((r, i) => segs.push(Object.assign(segOf(HALO_FIRST + i, r, fxSettings(r.spec, ctx, uses, tags)), { _fx: r.spec.fx })));
  const ex0 = Math.max(EXTRA_FIRST, HALO_FIRST + halo.length);
  extras.forEach((r, i) => segs.push(Object.assign(segOf(ex0 + i, r, fxSettings(r.spec, ctx, uses, tags)), { _fx: r.spec.fx })));
  if (segs.some((s) => s.id > MAX_ID)) throw new Error('mood needs more than 32 segments');

  // The hidden check mood has no brightness control: it is fitted at its own 20%.
  const fit = fitBudget(segs, ctx, mood.hidden ? B : 255);
  const byId = {};
  segs.forEach((s) => { delete s._fx; byId[s.id] = s; });
  const seg = [];
  for (let id = 0; id <= MAX_ID; id++) seg.push(byId[id] || { id, stop: 0 });
  const body = { on: true, bri: B, transition: TRANSITION, seg };
  const budget = { ma: Math.round(budgetMa(body, ctx)), scale: fit.scale };
  if (fit.flash < 1) budget.flash = fit.flash;
  return { bodies: [body], budget, approx: tags, uses };
}

// ---------- checkState ----------

function checkState(body, wall) {
  const out = [];
  const p = (m) => out.push(m);
  if (!isObj(body)) return ['body must be an object'];
  const live = (wall && wall.live) || {};
  const maxSeg = live.maxSegments || 32;
  const stopMax = wall && Number.isInteger(wall.lastLit) ? wall.lastLit + 1 : STOP_MAX;
  Object.keys(body).forEach((k) => { if (TOP_KEYS.indexOf(k) < 0) p('key "' + k + '" may not be sent'); });
  if (body.on !== undefined && typeof body.on !== 'boolean') p('on must be true or false');
  ['bri', 'transition', 'tt'].forEach((k) => { if (body[k] !== undefined && !isByte(body[k])) p(k + ' must be 0 to 255'); });
  if (body.ps !== undefined) {
    if (!Number.isInteger(body.ps) || (live.protectedPresets || []).indexOf(body.ps) < 0) p('ps may only select one of the live presets');
    if (body.seg !== undefined) p('ps may not be sent with seg');
  }
  if (body.seg !== undefined) {
    if (!Array.isArray(body.seg)) p('seg must be a list');
    else {
      if (body.seg.length > maxSeg) p('more than ' + maxSeg + ' segments');
      const ids = {};
      body.seg.forEach((s, i) => {
        const at = 'segment ' + (isObj(s) && s.id !== undefined ? s.id : i) + ': ';
        if (!isObj(s)) { p(at + 'not an object'); return; }
        Object.keys(s).forEach((k) => { if (SEG_KEYS.indexOf(k) < 0) p(at + 'key "' + k + '" may not be sent'); });
        if (!Number.isInteger(s.id) || s.id < 0 || s.id > MAX_ID) p(at + 'id must be 0 to ' + MAX_ID);
        else if (ids[s.id]) p(at + 'id repeats');
        else ids[s.id] = true;
        const hasStart = s.start !== undefined;
        const hasStop = s.stop !== undefined;
        if (hasStop && s.stop === 0) {
          if (hasStart && s.start !== 0) p(at + 'a delete sends only stop 0');
        } else if (hasStart || hasStop) {
          if (!hasStart || !hasStop) p(at + 'start and stop go together');
          else if (!Number.isInteger(s.start) || !Number.isInteger(s.stop) || s.start < 0 || s.start >= s.stop || s.stop > stopMax) p(at + 'start and stop must be 0 <= start < stop <= ' + stopMax);
        }
        BOOL_KEYS.forEach((k) => { if (s[k] !== undefined && typeof s[k] !== 'boolean') p(at + k + ' must be true or false'); });
        ['bri', 'fx', 'sx', 'ix', 'pal', 'c1', 'c2', 'spc', 'of'].forEach((k) => { if (s[k] !== undefined && !isByte(s[k])) p(at + k + ' must be 0 to 255'); });
        if (s.grp !== undefined && !(isByte(s.grp) && s.grp >= 1)) p(at + 'grp must be 1 to 255');
        if (s.col !== undefined) {
          if (!Array.isArray(s.col) || s.col.length > 3) p(at + 'col must hold at most 3 colours');
          else s.col.forEach((c) => { if (!Array.isArray(c) || c.length !== 3 || !c.every(isByte)) p(at + 'each colour is [r, g, b], 0 to 255'); });
        }
      });
    }
  }
  return out;
}

// ---------- restore ----------

function cleanSeg(s, stopMax) {
  if (!isObj(s) || !Number.isInteger(s.id) || s.id < 0 || s.id > MAX_ID) return null;
  const o = { id: s.id };
  if (Number.isInteger(s.start) && Number.isInteger(s.stop)) {
    const stop = Math.min(s.stop, stopMax);
    if (s.start >= 0 && s.start < stop) { o.start = s.start; o.stop = stop; } else return { id: s.id, stop: 0 };
  }
  if (typeof s.on === 'boolean') o.on = s.on;
  ['bri', 'fx', 'sx', 'ix', 'pal', 'c1', 'c2', 'spc', 'of'].forEach((k) => { if (isByte(s[k])) o[k] = s[k]; });
  if (isByte(s.grp) && s.grp >= 1) o.grp = s.grp;
  if (Array.isArray(s.col)) {
    const col = s.col.slice(0, 3).filter(Array.isArray).map((c) => [0, 1, 2].map((i) => (isByte(c[i]) ? c[i] : 0)));
    if (col.length) o.col = col;
  }
  ['o1', 'o2', 'o3'].forEach((k) => { if (typeof s[k] === 'boolean') o[k] = s[k]; });
  return o;
}

// Bodies that put the wall back as the snapshot of /json/state had it:
// explicit deletes for every id the snapshot did not have, then the preset when
// one was on (and the snapshot's on and bri), else the snapshot's segments.
// No usable snapshot: deletes past the live segments, then the restore preset.
function restoreBodies(snapshot, wall) {
  const live = wall.live;
  const stopMax = Number.isInteger(wall.lastLit) ? wall.lastLit + 1 : STOP_MAX;
  const deletes = (keep) => {
    const seg = [];
    for (let id = 0; id <= MAX_ID; id++) if (keep.indexOf(id) < 0) seg.push({ id, stop: 0 });
    return seg.length ? [{ seg }] : [];
  };
  if (!isObj(snapshot) || !Array.isArray(snapshot.seg) || !snapshot.seg.length) {
    return deletes(live.segments.map((s) => s.id)).concat([{ on: true, ps: live.restorePreset }]);
  }
  const segs = snapshot.seg.map((s) => cleanSeg(s, stopMax)).filter(Boolean);
  const ids = uniq(segs.filter((s) => s.stop !== 0).map((s) => s.id));
  const out = deletes(ids);
  const on = snapshot.on !== false;
  if (Number.isInteger(snapshot.ps) && snapshot.ps > 0 && live.protectedPresets.indexOf(snapshot.ps) >= 0) {
    out.push({ on: true, ps: snapshot.ps });
    const last = { on };
    if (isByte(snapshot.bri)) last.bri = snapshot.bri;
    out.push(last);
    return out;
  }
  const body = { on };
  if (isByte(snapshot.bri)) body.bri = snapshot.bri;
  body.transition = TRANSITION;
  body.seg = segs.filter((s) => s.stop !== 0);
  out.push(body);
  return out;
}

// ---------- events (effects form) ----------

// Thunder in the effects form: the event's fallback segment (the Drums
// segment) dims by the event's depth with a short transition, holds, and comes
// back. rng() in [0, 1) picks depth and hold; without one, the middle of each range.
function eventBodies(mood, name, ctx, rng) {
  const ev = mood && mood.render && mood.render.events && mood.render.events[name];
  if (!ev || !ev.fallback || !ev.fallback.dimSegment) return null;
  needCtx(ctx);
  const zb = C.zoneBulbs(ctx.wall, ev.fallback.dimSegment);
  if (!zb.length) return null;
  const lo = zb[0], hi = zb[zb.length - 1];
  let targets = [];
  if (mood.wled && Number.isInteger(mood.wled.preset)) {
    targets = ctx.wall.live.segments.filter((s) => s.start <= lo && s.stop > hi)
      .map((s) => ({ id: s.id, bri: ctx.segBri && isByte(ctx.segBri[s.id]) ? ctx.segBri[s.id] : 255 }));
  } else {
    const body = compileWled(mood, ctx).bodies[0];
    targets = (body.seg || []).filter((s) => s.stop > 0 && s.start >= lo && s.stop - 1 <= hi).map((s) => ({ id: s.id, bri: s.bri }));
  }
  if (!targets.length) return null;
  const r = typeof rng === 'function' ? rng : () => 0.5;
  const pick = (range, dflt) => (Array.isArray(range) ? range[0] + r() * (range[1] - range[0]) : dflt);
  const depth = clamp(pick(ev.depth, 0.6), 0, 1);
  const hold = Math.max(0, pick(ev.hold, 1.5));
  return {
    down: { tt: 3, seg: targets.map((t) => ({ id: t.id, bri: Math.round(t.bri * (1 - depth)) })) },
    up: { tt: 9, seg: targets.map((t) => ({ id: t.id, bri: t.bri })) },
    holdMs: Math.round(300 + hold * 1000),
  };
}

module.exports = {
  compileWled, checkState, budgetMa, restoreBodies, eventBodies,
  // shared with render.js and preview.js, and for tests
  pickDesign, sideColours, blendedSide, sidesOk, isPerSide, designCol1, designCol2, vaseColour,
  nightOf, briPctOf, masterOf, resolveFx, resolvePal, presetMa, presetCap, segMa, blend, hex, mix,
  TOP_KEYS, SEG_KEYS, TRANSITION, VASE_ZONES, MAX_ID,
};
