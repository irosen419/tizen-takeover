/*
 * Paired presets ("looks"): one named setting for the floor lamp and the
 * light bars together, so both match. Built-in ones are in looks.json next to
 * this file; ones saved on the Pi are in data/lights-looks.json (same shape).
 *
 *   { "id": "octane", "name": "Octane", "es": "Octane",
 *     "lamp": { "brightness": 40, "gradient": [[0,120,20], [90,255,0]] },
 *     "bars": { "brightness": 40, "color": [0,120,20] },
 *     "motion": "drift" }
 *
 * Each light takes a brightness (1-100) and exactly one of:
 *   color      one color for the whole light
 *   gradient   2-12 colors spread along the light: the lamp bottom to top,
 *              the bars up the left bar and down the right (govee.PATHS)
 *   sections   one color per section (lamp 7, bars 12, by section number)
 *   palette    a music lights palette id (palettes.json), spread as a gradient
 *   snapshot   the name of a Snapshot saved in the Govee Home app for that
 *              light (an app scene, which may move); fired through Govee's
 *              cloud (govee-cloud.js). Brightness is then optional (the
 *              snapshot has its own). Snapshot names are the owner's: they
 *              go in presets saved on the Pi, not in looks.json.
 * motion: "still" (the default); "drift": the colors glide slowly along the
 * light and back (about a minute there and back); "wave": a slow sine wave
 * rolls through the light's colors, each section a tenth of a wave behind
 * the one before (17 s a wave, ten updates a second; the "Chill moving"
 * lamp Ian approved on 2026-11-27). Neither cycles to new colors. A snapshot
 * light does its own thing either way.
 *
 * resolve() turns a look into { lamp: { brightness, colors[7] }, bars: {
 * brightness, colors[12] } }, colors by section number, which is what the
 * engine paints. Pure; no lights, no files except loading looks.json.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const govee = require('./govee');
const settingsLib = require('./settings');

const FILE = path.join(__dirname, 'looks.json');
const SAVED_FILE = 'lights-looks.json';
const MAX_SAVED = 24;
const MOTIONS = ['still', 'drift', 'wave'];
const DRIFT_PERIOD_MS = 60000;           // there and back
const WAVE_PERIOD_MS = 17000;            // one wave
const WAVE_PHASE = 0.1;                  // each section a tenth of a wave behind
const UPDATE_MS = { still: 0, drift: 500, wave: 100 };
const NAME_MAX = 32;
const SNAPSHOT_MAX = 60;

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

function checkLight(L, key, what) {
  const n = govee.LIGHTS[key].sections;
  if (!L || typeof L !== 'object' || Array.isArray(L)) throw bad(what + ': "' + key + '" must be an object');
  Object.keys(L).forEach((k) => {
    if (['brightness', 'color', 'gradient', 'sections', 'palette', 'snapshot'].indexOf(k) < 0) throw bad(what + ': "' + key + '.' + k + '" is not a look setting');
  });
  const kinds = ['color', 'gradient', 'sections', 'palette', 'snapshot'].filter((k) => L[k] !== undefined);
  if (kinds.length !== 1) throw bad(what + ': ' + key + ' needs exactly one of color, gradient, sections, palette, snapshot');
  const optional = L.snapshot !== undefined && L.brightness === undefined;
  if (!optional && (!Number.isInteger(L.brightness) || L.brightness < 1 || L.brightness > 100)) throw bad(what + ': ' + key + ' brightness must be 1-100');
  const out = optional ? {} : { brightness: L.brightness };
  if (L.snapshot !== undefined) {
    const n = typeof L.snapshot === 'string' ? L.snapshot.trim() : '';
    if (!n || n.length > SNAPSHOT_MAX || /[<>\u0000-\u001f]/.test(n)) throw bad(what + ': ' + key + ' snapshot must be the snapshot\'s name in the Govee app (1-' + SNAPSHOT_MAX + ' characters)');
    out.snapshot = n;
  }
  if (L.color !== undefined) {
    if (!isRgb(L.color)) throw bad(what + ': ' + key + ' color must be [r, g, b], 0-255');
    out.color = L.color.slice();
  }
  if (L.gradient !== undefined) {
    if (!Array.isArray(L.gradient) || L.gradient.length < 2 || L.gradient.length > 12 || !L.gradient.every(isRgb)) throw bad(what + ': ' + key + ' gradient must be 2-12 [r, g, b] colors');
    out.gradient = L.gradient.map((c) => c.slice());
  }
  if (L.sections !== undefined) {
    if (!Array.isArray(L.sections) || L.sections.length !== n || !L.sections.every(isRgb)) throw bad(what + ': ' + key + ' sections must be ' + n + ' [r, g, b] colors');
    out.sections = L.sections.map((c) => c.slice());
  }
  if (L.palette !== undefined) {
    if (settingsLib.paletteIds().indexOf(L.palette) < 0) throw bad(what + ': ' + key + ' palette must be one of ' + settingsLib.paletteIds().join(', '));
    out.palette = L.palette;
  }
  return out;
}

function checkName(v, what) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s || s.length > NAME_MAX || /[<>\u0000-\u001f]/.test(s)) throw bad(what + ': a name of 1-' + NAME_MAX + ' characters, no < or >');
  return s;
}

// One look, checked. Throws a 400 with a plain reason.
function check(x, what) {
  const w = what || 'look';
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(w + ' must be an object');
  Object.keys(x).forEach((k) => {
    if (['id', 'name', 'es', 'lamp', 'bars', 'motion', 'saved'].indexOf(k) < 0) throw bad(w + ': "' + k + '" is not a look setting');
  });
  if (typeof x.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(x.id)) throw bad(w + ': id must be 1-40 of a-z 0-9 -');
  const out = { id: x.id, name: checkName(x.name, w), es: x.es === undefined ? checkName(x.name, w) : checkName(x.es, w) };
  out.lamp = checkLight(x.lamp, 'lamp', w);
  out.bars = checkLight(x.bars, 'bars', w);
  const m = x.motion === undefined ? 'still' : x.motion;
  if (MOTIONS.indexOf(m) < 0) throw bad(w + ': motion must be ' + MOTIONS.join(' or '));
  out.motion = m;
  if (x.saved === true) out.saved = true;
  return out;
}

function checkList(list, what) {
  if (!Array.isArray(list)) throw bad(what + ' must be a list');
  const ids = {};
  return list.map((x, i) => {
    const l = check(x, what + ' ' + (i + 1));
    if (ids[l.id]) throw bad(what + ' ' + (i + 1) + ' has the same id as another');
    ids[l.id] = 1;
    return l;
  });
}

const BUILT_IN = checkList(JSON.parse(fs.readFileSync(FILE, 'utf8')).looks, 'built-in look');

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// A color at position p (0 = first stop, 1 = last) along the stops.
function along(stops, p) {
  const q = Math.max(0, Math.min(1, p)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(q));
  return lerp(stops[i], stops[i + 1], q - i);
}

function stopsOf(L) {
  if (L.color) return [L.color, L.color];
  if (L.gradient) return L.gradient;
  if (L.palette) return settingsLib.paletteById(L.palette).colors;
  return null;
}

// Colors by section number for one light. shift (-0.5..0.5) slides a
// gradient along the light (drift); a still look uses 0.
function colorsFor(L, key, shift) {
  if (L.snapshot) return null;             // the Govee app's scene: no colors known here
  const n = govee.LIGHTS[key].sections;
  const pathOrder = govee.PATHS[key];
  const out = new Array(n);
  if (L.sections) {
    // Drift on hand-set sections: each section leans toward its neighbour along the path.
    pathOrder.forEach((sec, i) => {
      const j = Math.max(0, Math.min(n - 1, i + Math.round(shift * 2)));
      out[sec] = L.sections[pathOrder[j]].slice();
    });
    return out.map((c) => c.map((v) => Math.round(v)));
  }
  const stops = stopsOf(L);
  pathOrder.forEach((sec, i) => {
    const p = n === 1 ? 0 : i / (n - 1);
    // Shrink the range a little so a drift has room to slide without clipping.
    const span = shift === 0 ? 1 : 0.8;
    out[sec] = along(stops, (p - 0.5) * span + 0.5 + shift * 0.2).map((v) => Math.round(v));
  });
  return out;
}

function lightOut(L, colors) {
  const o = { brightness: L.brightness === undefined ? null : L.brightness, colors: colors };
  if (L.snapshot) o.snapshot = L.snapshot;
  return o;
}

// The wave: section i (along the path) sits at a point on the colors that
// follows a sine, a tenth of a wave behind the one before. Colors rounded to
// even steps so a frame is resent only when something visibly moved.
function waveFor(L, key, t) {
  if (L.snapshot) return null;
  const n = govee.LIGHTS[key].sections;
  const pathOrder = govee.PATHS[key];
  const stops = L.sections ? pathOrder.map((sec) => L.sections[sec]) : stopsOf(L);
  const out = new Array(n);
  pathOrder.forEach((sec, i) => {
    const p = 0.5 + 0.5 * Math.sin(2 * Math.PI * ((t || 0) / WAVE_PERIOD_MS + i * WAVE_PHASE));
    out[sec] = along(stops, p).map((v) => Math.min(254, Math.round(v / 2) * 2));
  });
  return out;
}

// What the engine paints at time t (ms; only matters for drift and wave).
function resolve(look, t) {
  const l = look;
  if (l.motion === 'wave') {
    return { id: l.id, motion: l.motion, lamp: lightOut(l.lamp, waveFor(l.lamp, 'lamp', t)), bars: lightOut(l.bars, waveFor(l.bars, 'bars', t)) };
  }
  const shift = l.motion === 'drift' ? Math.sin((2 * Math.PI * (t || 0)) / DRIFT_PERIOD_MS) * 0.5 : 0;
  return {
    id: l.id,
    motion: l.motion,
    lamp: lightOut(l.lamp, colorsFor(l.lamp, 'lamp', shift)),
    bars: lightOut(l.bars, colorsFor(l.bars, 'bars', l.motion === 'drift' ? -shift : 0))
  };
}

// A short id from a name: "Magenta dusk" -> "my-magenta-dusk".
function idFromName(name) {
  const base = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return 'my-' + (base || 'look');
}

// A saved look from what Home Assistant reads now (one color per light;
// Govee reports nothing finer). st: { lamp: readState(), bars: readState() }.
function fromStates(name, st) {
  const light = (s, key) => {
    if (!s || !s.available) throw bad('cannot read the ' + govee.LIGHTS[key].name.toLowerCase() + ' from Home Assistant right now');
    if (!s.on) throw bad('the ' + govee.LIGHTS[key].name.toLowerCase() + ' is off; turn it on first');
    const pct = s.brightness === null ? 100 : Math.max(1, Math.min(100, Math.round(s.brightness / 2.55)));
    const rgb = Array.isArray(s.rgb) ? s.rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))) : [255, 190, 110];
    return { brightness: pct, color: rgb };
  };
  const nm = checkName(name, 'the name');
  return check({ id: idFromName(nm), name: nm, es: nm, lamp: light(st.lamp, 'lamp'), bars: light(st.bars, 'bars'), saved: true });
}

module.exports = {
  FILE: FILE,
  SAVED_FILE: SAVED_FILE,
  MAX_SAVED: MAX_SAVED,
  MOTIONS: MOTIONS,
  DRIFT_PERIOD_MS: DRIFT_PERIOD_MS,
  WAVE_PERIOD_MS: WAVE_PERIOD_MS,
  UPDATE_MS: UPDATE_MS,
  BUILT_IN: BUILT_IN,
  check: check,
  checkList: checkList,
  colorsFor: colorsFor,
  resolve: resolve,
  idFromName: idFromName,
  fromStates: fromStates
};
