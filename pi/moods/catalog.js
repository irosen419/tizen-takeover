/*
 * Moods catalog: reads and checks the two data files that every part of
 * Moods works from (plan D4), and a few small pure helpers.
 *
 *   pi/moods/moods.json   palettes, WLED effects (by name), the vase and halo
 *                         designs, the moods, the Hanukkah table
 *   pi/moods/wall.json    the plant wall's map: sections, zones (inclusive
 *                         bulb ranges), frame sides, menorah bulbs, WLED's
 *                         live segments, power, and the drawing's geometry
 *   data/moods-wall.json  Pi-only fix of the wall map (same shape, any subset
 *                         of zones, sides, menorah, power); wins over the file
 *
 * Design fields (moods.json "designs"):
 *   for       "vase" or "halo"; hidden: true keeps one off every list
 *   wled      fx (a key of "fx"), sx, ix, pal (WLED palette number, one of
 *             "pals"), o1, c1, c2, and the colours:
 *               col       literal colours, up to 3
 *               colBy     { guitar|drum|mic: [colours] } one list per painting
 *               colFrom   "vases": colour 1 from the mood's vase colours through
 *                         vaseMap (painting -> side -> vase index, or [a, b] =
 *                         half way between two); perSide: one segment per side
 *               col2      second colour when colFrom gives the first
 *               sides     { painting: { top, left, right, bottom } } colour or
 *                         null (dark); "inside"/"outside" map through wall.sides
 *               glint     vase designs: colour 2 (colour 1 is the vase colour)
 *               menorah   flame, shamash, base segment settings (candle bulbs
 *                         from wall.menorah)
 *   pi        Pi-drawn layers, or null (mic designs: use the fallback's).
 *             kinds: solid, breathe, sparkle, chase, palette, candle, strike,
 *             pixels. Colour tokens: $vase (the vase colour), $side (the side's
 *             colour), $col1/$col2 (the design's resolved colours); "$sx" for a
 *             period or cycle means "from the mood's speed".
 *   pv        preview hints { base, glint?, anim, sw? } for the TV drawing
 *   needs     any of "mic", "sides", "candles"; fallback: design id or null
 *
 * Node 14 or newer, no npm packages. No clock, no network.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const MOODS_FILE = path.join(DIR, 'moods.json');
const WALL_FILE = path.join(DIR, 'wall.json');
const OVERRIDE_FILE = 'moods-wall.json';
const OVERRIDE_KEYS = ['zones', 'sides', 'menorah', 'power'];

const LIMITS = { name: 32, es: 40, desc: 90, descEs: 115 };
const VASE_DESIGNS = ['v-static', 'v-breathe', 'v-cycle', 'v-candle', 'v-fireflies', 'v-rain', 'v-twinkle', 'v-meter'];
const PAINTINGS = ['guitar', 'drum', 'mic'];
const SIDE_NAMES = ['top', 'left', 'right', 'bottom'];
const LAYER_KINDS = ['solid', 'breathe', 'sparkle', 'chase', 'palette', 'candle', 'strike', 'pixels'];
const ANIMS = ['still', 'breathe', 'twinkle', 'flicker', 'cycle', 'drift', 'chase', 'flash', 'beat'];
const NEEDS = ['mic', 'sides', 'candles'];
const TOKENS = ['$vase', '$side', '$col1', '$col2'];
const DASHES = /[‐-―−]| - /;

const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const isHex6 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{6}$/.test(s);
const isByte = (n) => Number.isInteger(n) && n >= 0 && n <= 255;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const copy = (o) => JSON.parse(JSON.stringify(o));

function hexToRgb(h) {
  const s = String(h).replace(/^#/, '');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readJson(file, what) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(what + ' is missing'); }
  try { return JSON.parse(text); } catch (e) { throw new Error(what + ' is not valid JSON'); }
}

// ---------- the wall ----------

// The bulbs of a zone, in order (inclusive ranges). [] for an unknown zone.
function zoneBulbs(wall, zone) {
  const z = wall && wall.zones && wall.zones[zone];
  if (!z) return [];
  const out = [];
  z.r.forEach((r) => { for (let i = r[0]; i <= r[1]; i++) out.push(i); });
  return out;
}

// Physical side name for a frame: "inside"/"outside" resolve through the
// zone's `inside` ("left" or "right"); the others pass through.
function physicalSide(wall, zone, side) {
  const sd = wall.sides && wall.sides[zone];
  if (!sd || !sd.inside) return side;
  const other = sd.inside === 'left' ? 'right' : 'left';
  if (side === 'inside') return sd.inside;
  if (side === 'outside') return other;
  return side;
}

// The bulbs of one side of a frame. side may be the stored name
// ("inside") or the physical one ("right").
function sideBulbs(wall, zone, side) {
  const sd = wall.sides && wall.sides[zone];
  if (!sd) return [];
  const row = sd.s.find((x) => x[0] === side || physicalSide(wall, zone, x[0]) === side);
  if (!row) return [];
  const out = [];
  for (let i = row[1]; i <= row[2]; i++) out.push(i);
  return out;
}

// { zone, side } for a bulb (side is the physical name, or null).
function whereIs(wall, led) {
  const zones = Object.keys(wall.zones);
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (zoneBulbs(wall, z).indexOf(led) >= 0) {
      const sd = wall.sides && wall.sides[z];
      const row = sd ? sd.s.find((x) => led >= x[1] && led <= x[2]) : null;
      return { zone: z, side: row ? physicalSide(wall, z, row[0]) : null };
    }
  }
  return null;
}

// Menorah bulbs for night n (1-8): the first n candles (numbered from the
// right) are lit, the rest unlit, plus the shamash.
function menorahBulbs(wall, night) {
  const m = wall.menorah;
  const n = Math.max(0, Math.min(m.candles.length, night | 0));
  return { lit: m.candles.slice(0, n), unlit: m.candles.slice(n), shamash: m.shamash.slice() };
}

// Even points along a polyline (the way the artifact's tail() walks a path).
function pointsAlong(poly, count) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, L, at: total });
    total += L;
  }
  const out = [];
  for (let k = 0; k < count; k++) {
    const d = total * (k + 0.5) / count;
    const s = segs.find((x) => d >= x.at && d <= x.at + x.L) || segs[segs.length - 1];
    const u = s.L ? (d - s.at) / s.L : 0;
    out.push([+(s.a[0] + (s.b[0] - s.a[0]) * u).toFixed(3), +(s.a[1] + (s.b[1] - s.a[1]) * u).toFixed(3)]);
  }
  return out;
}

// The path for range i of a zone: "zone" for a one-range zone, "zone#i" otherwise.
function pathFor(wall, zone, i) {
  const p = wall.geometry && wall.geometry.paths;
  if (!p) return null;
  return p[zone + '#' + i] || (i === 0 ? p[zone] : null) || null;
}

// Where every lit bulb sits, in inches (y up): { "<led>": [x, y] }. Vase
// bulbs ring the vase like the artifact's seven beads.
function bulbXY(wall) {
  const out = {};
  const g = wall.geometry || {};
  (g.vases || []).forEach((v) => {
    const leds = zoneBulbs(wall, v.zone);
    leds.forEach((led, k) => {
      const a = Math.PI * (0.12 + 0.76 * k / Math.max(1, leds.length - 1));
      out[led] = [+(v.x - Math.cos(a) * 1.6).toFixed(3), +(v.y - 0.4 - Math.sin(a) * 1.0).toFixed(3)];
    });
  });
  Object.keys(wall.zones).forEach((z) => {
    if (/^vase\d$/.test(z)) return;
    wall.zones[z].r.forEach((r, i) => {
      const poly = pathFor(wall, z, i);
      if (!poly) return;
      const pts = pointsAlong(poly, r[1] - r[0] + 1);
      pts.forEach((p, k) => { out[r[0] + k] = p; });
    });
  });
  return out;
}

// Pi-only override: string[] of problems ([] = fine).
function checkOverride(o) {
  if (o === null || o === undefined) return [];
  if (!isObj(o)) return ['wall override must be an object'];
  const bad = Object.keys(o).filter((k) => OVERRIDE_KEYS.indexOf(k) < 0 && k !== 'v');
  return bad.length ? ['wall override: "' + bad[0] + '" cannot be changed (only ' + OVERRIDE_KEYS.join(', ') + ')'] : [];
}

// The wall with an override applied: zones and sides merge by zone name,
// menorah and power replace their fields.
function mergeWall(base, override) {
  const w = copy(base);
  if (!override) return w;
  if (isObj(override.zones)) Object.keys(override.zones).forEach((k) => { w.zones[k] = copy(override.zones[k]); });
  if (isObj(override.sides)) Object.keys(override.sides).forEach((k) => { w.sides[k] = copy(override.sides[k]); });
  if (isObj(override.menorah)) Object.assign(w.menorah, copy(override.menorah));
  if (isObj(override.power)) Object.assign(w.power, copy(override.power));
  return w;
}

// ---------- the catalog ----------

const moodById = (catalog, id) => (catalog.moods || []).find((m) => m.id === id) || null;
const designById = (catalog, id) => (catalog.designs && Object.prototype.hasOwnProperty.call(catalog.designs, id) ? catalog.designs[id] : null);
const visibleMoods = (catalog) => (catalog.moods || []).filter((m) => !m.hidden);
const fxByKey = (catalog, key) => (catalog.fx && catalog.fx[key]) || null;
const palByNumber = (catalog, n) => {
  const k = Object.keys(catalog.pals || {}).find((x) => catalog.pals[x].id === n);
  return k ? Object.assign({ key: k }, catalog.pals[k]) : null;
};
const paletteRgb = (catalog, name) => ((catalog.palettes && catalog.palettes[name]) || []).map(hexToRgb);

// The designs a mood uses (vase design, halo designs), unique, in order.
function designsOf(mood) {
  const out = [];
  const add = (id) => { if (id && out.indexOf(id) < 0) out.push(id); };
  if (mood.vases) add(mood.vases.design);
  if (mood.halos) PAINTINGS.forEach((p) => add(mood.halos[p]));
  return out;
}

// The lamp and bars look for a mood: { ref } as stored, or the full look in
// pi/lights/looks.js shape with id "mood-<id>", or null.
function goveeLook(mood) {
  const g = mood && mood.govee;
  if (!g) return null;
  if (g.ref) return { ref: g.ref };
  const l = copy(g.look);
  return Object.assign({ id: 'mood-' + mood.id, name: mood.name, es: mood.es }, l);
}

// Night of Hanukkah for a date given as numbers (m 1-12), or null. The table
// holds each year's first evening ("MM-DD"); night 1 is that date. Pure: the
// date is passed in, never read from a clock.
function nightFor(date, catalog) {
  const tbl = (catalog && catalog.hanukkah) || {};
  if (!date || !Number.isInteger(date.y) || !Number.isInteger(date.m) || !Number.isInteger(date.d)) return null;
  const day = Date.UTC(date.y, date.m - 1, date.d) / 86400000;
  const years = [date.y, date.y - 1];
  for (let i = 0; i < years.length; i++) {
    const s = tbl[String(years[i])];
    if (typeof s !== 'string' || !/^\d\d-\d\d$/.test(s)) continue;
    const start = Date.UTC(years[i], +s.slice(0, 2) - 1, +s.slice(3, 5)) / 86400000;
    const n = day - start + 1;
    if (n >= 1 && n <= 8) return n;
  }
  return null;
}

// ---------- validation ----------

function validateWall(wall, problems) {
  const p = (m) => problems.push('wall: ' + m);
  if (!isObj(wall)) { p('not an object'); return; }
  if (wall.v !== 1) p('v must be 1');
  if (!Number.isInteger(wall.leds) || !Number.isInteger(wall.lastLit) || wall.lastLit >= wall.leds) p('leds and lastLit');
  const max = wall.lastLit;
  if (!Array.isArray(wall.sections) || !wall.sections.length) p('sections missing');
  if (!isObj(wall.zones)) { p('zones missing'); return; }
  const owner = {};
  Object.keys(wall.zones).forEach((z) => {
    const Z = wall.zones[z];
    if (!isObj(Z) || !Array.isArray(Z.r) || !Z.r.length || typeof Z.sure !== 'boolean') { p('zone ' + z + ' needs r and sure'); return; }
    Z.r.forEach((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 0 || r[1] > max || r[0] > r[1]) { p('zone ' + z + ' range ' + JSON.stringify(r) + ' outside 0-' + max); return; }
      for (let i = r[0]; i <= r[1]; i++) {
        if (owner[i]) p('bulb ' + i + ' is in ' + owner[i] + ' and ' + z);
        owner[i] = z;
      }
    });
  });
  Object.keys(wall.sides || {}).forEach((z) => {
    const sd = wall.sides[z];
    const bulbs = zoneBulbs(wall, z);
    if (!bulbs.length) { p('sides for unknown zone ' + z); return; }
    if (!isObj(sd) || !Array.isArray(sd.s) || typeof sd.sure !== 'boolean') { p('sides ' + z + ' needs s and sure'); return; }
    if (sd.inside !== undefined && sd.inside !== 'left' && sd.inside !== 'right') p('sides ' + z + ' inside must be left or right');
    const got = [];
    sd.s.forEach((row) => {
      const name = physicalSide(wall, z, row[0]);
      if (SIDE_NAMES.indexOf(name) < 0) p('sides ' + z + ' side ' + row[0] + ' is not a side');
      for (let i = row[1]; i <= row[2]; i++) got.push(i);
    });
    if (got.join() !== bulbs.join()) p('sides ' + z + ' do not add up to the zone');
  });
  const m = wall.menorah;
  if (!isObj(m) || !Array.isArray(m.candles) || m.candles.length !== 8 || !Array.isArray(m.shamash) || !m.shamash.length) p('menorah needs 8 candles and a shamash');
  else {
    m.candles.concat(m.shamash).forEach((led) => {
      const w = whereIs(wall, led);
      if (!w || !/^halo\./.test(w.zone) || w.side !== 'top') p('menorah bulb ' + led + ' is not on a top side');
    });
    if (new Set(m.candles.concat(m.shamash)).size !== m.candles.length + m.shamash.length) p('menorah bulbs repeat');
  }
  const pw = wall.power;
  if (!isObj(pw) || ['limiterMa', 'budgetMa', 'baseMa', 'ledMa', 'flashMa'].some((k) => !(typeof pw[k] === 'number' && pw[k] > 0))) p('power needs limiterMa, budgetMa, baseMa, ledMa, flashMa');
  else if (pw.budgetMa > pw.limiterMa) p('power budget over the limiter');
  const lv = wall.live;
  if (!isObj(lv) || !Array.isArray(lv.segments) || !Array.isArray(lv.protectedPresets) || !Number.isInteger(lv.restorePreset) || !(lv.maxSegments > 0 && lv.maxSegments <= 32)) p('live needs segments, protectedPresets, restorePreset, maxSegments');
  else lv.segments.forEach((s) => { if (!(s.start >= 0 && s.stop > s.start && s.stop <= max + 1)) p('live segment ' + s.id + ' outside the lit bulbs'); });
  const g = wall.geometry;
  if (!isObj(g) || !Array.isArray(g.canvases) || !Array.isArray(g.vases) || !isObj(g.paths)) p('geometry needs canvases, vases, paths');
  else g.vases.forEach((v) => { if (!wall.zones[v.zone]) p('geometry vase for unknown zone ' + v.zone); });
}

function checkText(o, what, p) {
  ['name', 'es', 'desc', 'descEs'].forEach((k) => {
    const s = o[k];
    if (typeof s !== 'string' || !s.trim()) { p(what + ' ' + k + ' missing'); return; }
    if (s.length > LIMITS[k]) p(what + ' ' + k + ' is ' + s.length + ' characters (limit ' + LIMITS[k] + ')');
    if (DASHES.test(s)) p(what + ' ' + k + ' has a dash');
    if (s !== s.trim() || /\s\s/.test(s)) p(what + ' ' + k + ' has extra spaces');
    if (!/^[A-ZÁÉÍÓÚÑ0-9]/.test(s)) p(what + ' ' + k + ' must start with a capital');
  });
}

function checkColour(c, what, p, tokens) {
  if (isHex(c)) return;
  if (tokens && TOKENS.indexOf(c) >= 0) return;
  p(what + ' colour ' + JSON.stringify(c) + ' is not #rrggbb');
}

function checkWledDesign(d, id, catalog, p) {
  const w = d.wled;
  const what = 'design ' + id + ' wled';
  if (!isObj(w)) { p(what + ' missing'); return; }
  if (!fxByKey(catalog, w.fx)) p(what + ' fx ' + w.fx + ' is not in fx');
  ['sx', 'ix', 'c1', 'c2'].forEach((k) => { if (w[k] !== undefined && !isByte(w[k])) p(what + ' ' + k + ' must be 0-255'); });
  if (w.pal !== undefined && (!isByte(w.pal) || !palByNumber(catalog, w.pal))) p(what + ' pal ' + w.pal + ' is not in pals');
  if (w.o1 !== undefined && typeof w.o1 !== 'boolean') p(what + ' o1 must be true or false');
  if (w.col !== undefined && (!Array.isArray(w.col) || !w.col.length || w.col.length > 3)) p(what + ' col must hold 1-3 colours');
  (w.col || []).forEach((c) => checkColour(c, what, p));
  if (w.col2 !== undefined) checkColour(w.col2, what, p);
  if (w.glint !== undefined) checkColour(w.glint, what, p);
  if (w.colBy !== undefined) PAINTINGS.forEach((k) => { if (!Array.isArray(w.colBy[k])) p(what + ' colBy ' + k + ' missing'); else w.colBy[k].forEach((c) => checkColour(c, what, p)); });
  if (w.sides !== undefined) {
    PAINTINGS.forEach((k) => {
      const s = w.sides[k];
      if (!isObj(s)) { p(what + ' sides ' + k + ' missing'); return; }
      SIDE_NAMES.forEach((n) => { if (s[n] !== null) checkColour(s[n], what + ' sides ' + k, p); });
    });
  }
  if (w.colFrom !== undefined) {
    if (w.colFrom !== 'vases') p(what + ' colFrom must be "vases"');
    if (!isObj(w.vaseMap)) p(what + ' colFrom needs vaseMap');
    else PAINTINGS.forEach((k) => {
      const m = w.vaseMap[k];
      if (!isObj(m)) { p(what + ' vaseMap ' + k + ' missing'); return; }
      SIDE_NAMES.forEach((n) => {
        const v = m[n];
        const ok = (x) => Number.isInteger(x) && x >= 0 && x <= 3;
        if (!(ok(v) || (Array.isArray(v) && v.length === 2 && v.every(ok)))) p(what + ' vaseMap ' + k + '.' + n);
      });
    });
  }
  if (w.menorah !== undefined) {
    ['flame', 'shamash', 'base'].forEach((r) => {
      const s = w.menorah[r];
      if (!isObj(s) || !fxByKey(catalog, s.fx) || !Array.isArray(s.col)) { p(what + ' menorah ' + r); return; }
      s.col.forEach((c) => checkColour(c, what + ' menorah', p));
      ['sx', 'ix', 'briMin'].forEach((k) => { if (s[k] !== undefined && !isByte(s[k])) p(what + ' menorah ' + r + ' ' + k); });
    });
  }
}

function checkLayers(d, id, catalog, p) {
  if (d.pi === null) {
    if (!d.fallback) p('design ' + id + ' has no pi layers and no fallback');
    return;
  }
  if (!Array.isArray(d.pi) || !d.pi.length) { p('design ' + id + ' pi must be a list or null'); return; }
  d.pi.forEach((L, i) => {
    const what = 'design ' + id + ' pi ' + (i + 1);
    if (!isObj(L) || LAYER_KINDS.indexOf(L.kind) < 0) { p(what + ' kind'); return; }
    ['color', 'base'].forEach((k) => { if (L[k] !== undefined) checkColour(L[k], what, p, true); });
    ['colors', 'flame', 'shamash'].forEach((k) => { if (L[k] !== undefined) (Array.isArray(L[k]) ? L[k] : [null]).forEach((c) => checkColour(c, what, p, true)); });
    if (L.palette !== undefined && !(catalog.palettes || {})[L.palette]) p(what + ' palette ' + L.palette + ' is not in palettes');
  });
}

function validateCatalog(catalog, wall, opt, problems) {
  const p = (m) => problems.push(m);
  if (!isObj(catalog)) { p('catalog is not an object'); return; }
  if (catalog.v !== 1) p('catalog v must be 1');
  Object.keys(catalog.palettes || {}).forEach((k) => {
    const a = catalog.palettes[k];
    if (!Array.isArray(a) || a.length < 2 || !a.every(isHex6)) p('palette ' + k + ' must be 2 or more rrggbb');
  });
  Object.keys(catalog.fx || {}).forEach((k) => {
    const f = catalog.fx[k];
    if (!isByte(f.id) || typeof f.name !== 'string' || !f.name) p('fx ' + k + ' needs id 0-255 and name');
  });
  Object.keys(catalog.pals || {}).forEach((k) => {
    const f = catalog.pals[k];
    if (!isByte(f.id) || typeof f.name !== 'string') p('pal ' + k + ' needs id 0-255 and name');
    if (f.steps !== undefined && !(catalog.palettes || {})[f.steps]) p('pal ' + k + ' steps ' + f.steps + ' is not in palettes');
  });
  const H = catalog.hanukkah;
  if (!isObj(H) || Object.keys(H).some((y) => !/^\d{4}$/.test(y) || !/^(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(H[y]))) p('hanukkah must map "YYYY" to "MM-DD"');

  const designs = catalog.designs || {};
  Object.keys(designs).forEach((id) => {
    const d = designs[id];
    if (d.for !== 'vase' && d.for !== 'halo') { p('design ' + id + ' for must be vase or halo'); return; }
    if ((d.for === 'vase') !== /^v-/.test(id)) p('design ' + id + ' id must start v- or h- to match its "for"');
    checkText(d, 'design ' + id, p);
    checkWledDesign(d, id, catalog, p);
    checkLayers(d, id, catalog, p);
    if (!isObj(d.pv) || ANIMS.indexOf(d.pv.anim) < 0) p('design ' + id + ' pv needs anim');
    else {
      checkColour(d.pv.base, 'design ' + id + ' pv', p, true);
      if (d.pv.glint !== undefined) checkColour(d.pv.glint, 'design ' + id + ' pv', p);
      (d.pv.sw || []).forEach((c) => checkColour(c, 'design ' + id + ' pv', p));
    }
    if (!Array.isArray(d.needs) || d.needs.some((n) => NEEDS.indexOf(n) < 0)) p('design ' + id + ' needs must list ' + NEEDS.join(', '));
    if (d.fallback !== null) {
      const f = designs[d.fallback];
      if (!f) p('design ' + id + ' fallback ' + d.fallback + ' does not exist');
      else if (f.for !== d.for) p('design ' + id + ' fallback is a ' + f.for + ' design');
      else if (f.needs.indexOf('mic') >= 0) p('design ' + id + ' fallback also needs the mic');
    }
    if (d.needs.indexOf('mic') >= 0 && !d.fallback) p('design ' + id + ' needs the mic but has no fallback');
  });

  const moods = catalog.moods;
  if (!Array.isArray(moods)) { p('moods must be a list'); return; }
  const ids = {};
  const ns = {};
  const lookIds = opt && opt.lookIds;
  moods.forEach((m, i) => {
    const what = 'mood ' + (m && m.id ? m.id : i + 1);
    if (!isObj(m) || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,34}$/.test(m.id)) { p(what + ' id must be a-z 0-9 -, up to 35'); return; }
    if (ids[m.id]) p(what + ' id repeats');
    ids[m.id] = 1;
    if (!Number.isInteger(m.n) || m.n < 1) p(what + ' n must be a whole number');
    else if (ns[m.n]) p(what + ' n repeats');
    ns[m.n] = 1;
    checkText(m, what, p);
    if (m.group !== 'wall' && m.group !== 'vases') p(what + ' group must be wall or vases');
    if (!Array.isArray(m.sw) || m.sw.length !== 4) p(what + ' sw needs 4 colours');
    else m.sw.forEach((c) => checkColour(c, what + ' sw', p));
    if (!Number.isInteger(m.bri) || m.bri < 1 || m.bri > 100) p(what + ' bri must be 1-100 (percent)');
    if (m.wash) {
      if (!(catalog.palettes || {})[m.wash.palette]) p(what + ' wash palette ' + m.wash.palette + ' is not in palettes');
      if (m.vases !== null || m.halos !== null) p(what + ' a wash replaces vases and halos (both null)');
    } else {
      const v = m.vases;
      if (!isObj(v)) p(what + ' vases missing');
      else {
        const d = designs[v.design];
        if (!d || d.for !== 'vase') p(what + ' vase design ' + v.design + ' is not a vase design');
        if (!Array.isArray(v.c) || v.c.length !== 4) p(what + ' vases c needs 4 colours');
        else v.c.forEach((c) => checkColour(c, what + ' vases', p));
        if (!isByte(v.bri) || !isByte(v.sx)) p(what + ' vases bri and sx must be 0-255');
      }
      const h = m.halos;
      if (!isObj(h)) p(what + ' halos missing');
      else {
        if (!isByte(h.bri)) p(what + ' halos bri must be 0-255');
        PAINTINGS.forEach((k) => {
          if (h[k] === null) return;
          const d = designs[h[k]];
          if (!d || d.for !== 'halo') p(what + ' halo ' + k + ' ' + h[k] + ' is not a halo design');
        });
      }
    }
    if (m.wled !== null) {
      if (!isObj(m.wled) || Object.keys(m.wled).join() !== 'preset' || !Number.isInteger(m.wled.preset)) p(what + ' wled may only be { preset: N }');
      else if (wall && wall.live && wall.live.protectedPresets.indexOf(m.wled.preset) < 0) p(what + ' wled preset must be one of the live presets');
    }
    const r = m.render;
    if (!isObj(r) || (r.type !== 'pi-drawn' && r.type !== 'wled-effects')) p(what + ' render type must be pi-drawn or wled-effects');
    else if (r.type === 'pi-drawn') {
      if (r.engine !== 'forest' && r.engine !== 'mood') p(what + ' render engine must be forest or mood');
      if (r.engine === 'forest' && !(catalog.palettes || {})[r.palette]) p(what + ' render palette ' + r.palette + ' is not in palettes');
      if (!(r.fps > 0 && r.fps <= 60)) p(what + ' render fps');
      if (wall && wall.power && !(r.maxMa > 0 && r.maxMa <= wall.power.budgetMa)) p(what + ' render maxMa over the budget');
      Object.keys(r.events || {}).forEach((e) => {
        const ev = r.events[e];
        (ev.zones || []).forEach((z) => { if (wall && !wall.zones[z]) p(what + ' event ' + e + ' zone ' + z + ' does not exist'); });
        if (ev.fallback && ev.fallback.dimSegment && wall && !wall.zones[ev.fallback.dimSegment]) p(what + ' event ' + e + ' fallback zone');
      });
    }
    const nd = m.needs;
    if (!isObj(nd) || typeof nd.mic !== 'boolean' || typeof nd.sides !== 'boolean' || typeof nd.candles !== 'boolean') p(what + ' needs { mic, sides, candles, song }');
    else {
      const want = {};
      designsOf(m).forEach((id) => { (designs[id] ? designs[id].needs : []).forEach((n) => { want[n] = true; }); });
      if (m.extras && (m.extras.candles || m.extras.shamash)) want.candles = true;
      NEEDS.forEach((n) => { if (!!want[n] !== nd[n]) p(what + ' needs.' + n + ' does not match its designs'); });
      if (nd.song !== null && !(isObj(nd.song) && typeof nd.song.id === 'string' && nd.song.built === false)) p(what + ' needs.song must be null or { id, built: false }');
    }
    if (m.param !== null) {
      const n = m.param && m.param.night;
      if (!isObj(n) || n.min !== 1 || n.max !== 8 || n.auto !== 'hanukkah') p(what + ' param may only be the Menorah night');
    }
    if (m.govee !== null) {
      if (!isObj(m.govee) || (!!m.govee.ref === !!m.govee.look)) p(what + ' govee needs ref or look');
      else if (m.govee.ref && lookIds && lookIds.indexOf(m.govee.ref) < 0) p(what + ' govee ref ' + m.govee.ref + ' is not a look');
      else if (m.govee.look && Object.keys(m.govee.look).some((k) => ['lamp', 'bars', 'motion'].indexOf(k) < 0)) p(what + ' govee look holds only lamp, bars, motion');
    }
    if (m.sound !== null && !(isObj(m.sound) && typeof m.sound.kind === 'string' && typeof m.sound.hint === 'string' && typeof m.sound.hintEs === 'string')) p(what + ' sound needs kind, hint, hintEs');
    if (!isObj(m.ha) || typeof m.ha.expose !== 'boolean') p(what + ' ha needs expose');
    if (m.hidden && m.ha && m.ha.expose) p(what + ' is hidden but exposed to Home Assistant');
    if (m.extras !== undefined) {
      if (m.id !== 'check') p(what + ' only the check mood has extras');
      Object.keys(m.extras || {}).forEach((k) => checkColour(m.extras[k], what + ' extras', p));
    }
  });
  const vis = moods.filter((m) => m && !m.hidden).map((m) => m.n).sort((a, b) => a - b);
  if (vis.some((n, i) => n !== i + 1)) p('visible moods must be numbered 1 to ' + vis.length);
}

// [] = good; otherwise one plain line per problem. opt.lookIds: the looks a
// govee ref may name (left out: refs are not checked here).
function validate(catalog, wall, opt) {
  const problems = [];
  validateWall(wall, problems);
  validateCatalog(catalog, wall, opt, problems);
  return problems;
}

// Both files plus the Pi-only override in dataDir. Throws a plain reason.
function load(dataDir) {
  const catalog = readJson(MOODS_FILE, 'pi/moods/moods.json');
  const base = readJson(WALL_FILE, 'pi/moods/wall.json');
  let override = null;
  if (dataDir) {
    const f = path.join(dataDir, OVERRIDE_FILE);
    if (fs.existsSync(f)) override = readJson(f, OVERRIDE_FILE);
  }
  const ob = checkOverride(override);
  if (ob.length) throw new Error(ob[0]);
  const wall = mergeWall(base, override);
  const problems = validate(catalog, wall);
  if (problems.length) throw new Error((override ? 'moods (with ' + OVERRIDE_FILE + '): ' : 'moods: ') + problems[0]);
  return { catalog, wall, override };
}

module.exports = {
  MOODS_FILE, WALL_FILE, OVERRIDE_FILE, OVERRIDE_KEYS, LIMITS, VASE_DESIGNS, PAINTINGS, LAYER_KINDS,
  load, validate, nightFor, checkOverride, mergeWall,
  moodById, designById, visibleMoods, designsOf, fxByKey, palByNumber, paletteRgb, goveeLook,
  zoneBulbs, sideBulbs, physicalSide, whereIs, menorahBulbs, pathFor, pointsAlong, bulbXY,
  isHex, hexToRgb
};
