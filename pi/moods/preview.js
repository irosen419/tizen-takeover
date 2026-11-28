'use strict';
/*
 * Moods preview for the TV drawing (app/moods-wall.js paints it). Pure.
 *
 *   previewOf(mood, ctx) -> { z: { "<zone>": ["#hex", ...] }, pat: { "<zone>": "solid|gradient|stripe|dots" },
 *                             glint: "#hex" | null, anim: "still|twinkle|breathe|drift", lvl: { "<zone>": 0..1 } }
 *
 * ctx is compileWled's. The preview shows what the effects form sends: the
 * same mic and missing-effect swaps, and one blended colour around a frame
 * while its sides are unsure. Dark zones are left out. lvl is a perceived
 * level (square root of the zone's WLED brightness), clamped to 0.12..1; the
 * mood's own brightness is applied by the drawing (opts.level). A wash (the
 * forest moods) samples the palette at each zone's place in its section.
 */
const C = require('./catalog');
const W = require('./compile');

const ANIM = { still: 'still', breathe: 'breathe', twinkle: 'twinkle', flicker: 'breathe', cycle: 'drift', drift: 'drift', chase: 'drift', flash: 'twinkle', beat: 'breathe' };
const WASH_LVL = 0.75;
const MAX_COLS = 8;

const lower = (h) => String(h).toLowerCase();
const lvlOf = (bri) => Math.round(Math.max(0.12, Math.min(1, Math.sqrt(Math.max(0, bri) / 255))) * 100) / 100;
const firstStr = (a) => a.find((x) => typeof x === 'string' && x) || null;

// Palette colour at index 0..255 (WLED's spacing), as hex.
function paletteAt(pal, index) {
  const n = pal.length;
  const pos = (((index % 256) + 256) % 256) / (256 / n);
  const i0 = Math.floor(pos) % n;
  const f = pos - Math.floor(pos);
  return W.hex(W.mix(C.hexToRgb(pal[i0]), C.hexToRgb(pal[(i0 + 1) % n]), f));
}

function washPreview(mood, ctx) {
  const pal = ctx.catalog.palettes[mood.wash.palette] || [];
  const out = { z: {}, pat: {}, glint: null, anim: 'drift', lvl: {} };
  Object.keys(ctx.wall.zones).forEach((zone) => {
    const bulbs = C.zoneBulbs(ctx.wall, zone);
    const cols = [];
    const step = Math.max(1, Math.ceil(bulbs.length / MAX_COLS));
    for (let k = 0; k < bulbs.length; k += step) {
      const led = bulbs[k];
      const sec = ctx.wall.sections.find((s) => led >= s.start && led <= s.end);
      if (!sec) continue;
      const len = sec.end - sec.start + 1;
      cols.push(paletteAt(pal, (led - sec.start) * 255 / len));
    }
    if (!cols.length) return;
    out.z[zone] = cols;
    out.pat[zone] = 'gradient';
    out.lvl[zone] = WASH_LVL;
  });
  return out;
}

// Colours and pattern of one halo design on a painting.
function haloLook(d, painting, mood, ctx, night) {
  const zone = 'halo.' + painting;
  const pv = d.pv || {};
  const w = d.wled;
  if (w.menorah) return { cols: [lower(w.menorah.base.col[0])], pat: 'solid' };
  if (W.isPerSide(d)) {
    if (W.sidesOk(zone, mood, ctx)) {
      const cols = W.sideColours(d, painting, mood, ctx.wall).map((s) => s.color).filter(Boolean);
      return { cols, pat: cols.length > 1 ? 'gradient' : 'solid' };
    }
    const one = W.blendedSide(d, painting, mood, ctx.wall);
    return { cols: one ? [one] : [], pat: 'solid' };
  }
  const anim = pv.anim;
  const base = pv.base && pv.base.charAt(0) === '$' ? W.designCol1(d, painting, mood, ctx.wall) : pv.base;
  let cols = Array.isArray(pv.sw) && pv.sw.length ? pv.sw.map(lower) : [lower(base)];
  if (w.colBy && w.colBy[painting]) cols = [lower(w.colBy[painting][0])];
  if (pv.base === '$col1') cols = [W.designCol1(d, painting, mood, ctx.wall)];
  const stripes = (d.pi || []).some((L) => L.kind === 'chase' && L.mode === 'stripes');
  let pat = cols.length > 1 ? 'gradient' : 'solid';
  if (anim === 'twinkle' || anim === 'flash') pat = cols.length > 1 ? 'dots' : 'solid';
  if (stripes) pat = 'stripe';
  return { cols: cols.slice(0, MAX_COLS), pat };
}

function previewOf(mood, ctx) {
  if (!ctx || !ctx.catalog || !ctx.wall) throw new Error('previewOf needs ctx.catalog and ctx.wall');
  if (mood.wash) return washPreview(mood, ctx);
  const out = { z: {}, pat: {}, glint: null, anim: 'still', lvl: {} };
  const night = W.nightOf(mood, ctx);
  const anims = [];
  const glints = [];
  if (mood.halos) {
    C.PAINTINGS.forEach((p) => {
      const pick = W.pickDesign(mood.halos[p], ctx, []);
      if (!pick) return;
      const look = haloLook(pick.d, p, mood, ctx, night);
      if (!look.cols.length) return;
      const zone = 'halo.' + p;
      out.z[zone] = look.cols;
      out.pat[zone] = look.pat;
      out.lvl[zone] = lvlOf(mood.halos.bri);
      anims.push(pick.d.wled.menorah ? 'still' : ANIM[pick.d.pv.anim] || 'still');
      glints.push({ anim: anims[anims.length - 1], c: pick.d.pv.glint });
    });
  }
  if (mood.vases) {
    const pick = W.pickDesign(mood.vases.design, ctx, []);
    if (pick) {
      W.VASE_ZONES.forEach((z, i) => {
        out.z[z] = [lower(mood.vases.c[i])];
        out.pat[z] = 'solid';
        out.lvl[z] = lvlOf(mood.vases.bri);
      });
      anims.push(ANIM[pick.d.pv.anim] || 'still');
      glints.push({ anim: ANIM[pick.d.pv.anim] || 'still', c: pick.d.pv.glint || pick.d.wled.glint });
    }
  }
  const x = mood.extras || {};
  if (x.drops) ['drops.left', 'drops.right'].forEach((z) => { out.z[z] = [lower(x.drops)]; out.pat[z] = 'solid'; out.lvl[z] = 1; });
  out.anim = anims[0] || 'still';
  // A twinkling design's glint first (the drawing's glint dots), else any.
  let glint = firstStr(glints.filter((g) => g.anim === 'twinkle').map((g) => g.c)) || firstStr(glints.map((g) => g.c));
  if (mood.halos && C.PAINTINGS.some((p) => { const d = C.designById(ctx.catalog, mood.halos[p]); return d && d.wled.menorah; })) {
    const d = C.designById(ctx.catalog, 'h-menorah');
    glint = d.pv.glint || glint;
  }
  if (!glint && x.candles) glint = lower(x.candles);
  if (out.anim === 'twinkle' && !glint) {
    const all = [].concat.apply([], Object.keys(out.z).map((k) => out.z[k]));
    glint = all.reduce((best, h) => (!best || C.hexToRgb(h).reduce((a, b) => a + b) > C.hexToRgb(best).reduce((a, b) => a + b) ? h : best), null);
  }
  out.glint = glint ? lower(glint) : null;
  return out;
}

module.exports = { previewOf, ANIM };
