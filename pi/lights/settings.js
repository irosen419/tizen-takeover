/*
 * Music lights settings: one small object shared by the hub server (which
 * keeps it in data/lights.json), the engine (which follows it) and ./hub.
 *
 *   on        true while music lights run
 *   palette   an id from palettes.json
 *   vibrancy  'low' | 'medium' | 'high'   how rich and bright
 *   beat      'low' | 'medium' | 'high'   how much the rhythm shows
 *   quietMin  minutes of quiet before it turns itself off and puts the lights
 *             back (1-240), or 0 for never. Default 15.
 *   offReason why it is off: '' | 'you' | 'quiet' | 'gave-way'
 *   gaveWay   which lights were set another way ('lamp', 'bars', 'hub')
 *   rev       goes up on every change
 *
 * Presets: chill = low/low, groove = medium/medium (the demo), party = high/high.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = ['low', 'medium', 'high'];
const PRESETS = {
  chill: { vibrancy: 'low', beat: 'low' },
  groove: { vibrancy: 'medium', beat: 'medium' },
  party: { vibrancy: 'high', beat: 'high' }
};
const DEFAULT_QUIET_MIN = 15;
const MAX_QUIET_MIN = 240;
const OFF_REASONS = ['', 'you', 'quiet', 'gave-way'];

const PALETTE_FILE = path.join(__dirname, 'palettes.json');

function loadPalettes(file) {
  const j = JSON.parse(fs.readFileSync(file || PALETTE_FILE, 'utf8'));
  return { default: j.default, palettes: j.palettes };
}

const PALETTES = loadPalettes();
const paletteIds = () => PALETTES.palettes.map((p) => p.id);
const paletteById = (id) => PALETTES.palettes.find((p) => p.id === id) || PALETTES.palettes.find((p) => p.id === PALETTES.default);

function defaults() {
  return { on: false, palette: PALETTES.default, vibrancy: 'medium', beat: 'medium', quietMin: DEFAULT_QUIET_MIN, offReason: '', gaveWay: [], rev: 0 };
}

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// A settings object read from disk: anything odd falls back to the default.
function clean(s) {
  const d = defaults();
  if (!s || typeof s !== 'object') return d;
  return {
    on: s.on === true,
    palette: paletteIds().indexOf(s.palette) >= 0 ? s.palette : d.palette,
    vibrancy: LEVELS.indexOf(s.vibrancy) >= 0 ? s.vibrancy : d.vibrancy,
    beat: LEVELS.indexOf(s.beat) >= 0 ? s.beat : d.beat,
    quietMin: Number.isInteger(s.quietMin) && s.quietMin >= 0 && s.quietMin <= MAX_QUIET_MIN ? s.quietMin : d.quietMin,
    offReason: OFF_REASONS.indexOf(s.offReason) >= 0 ? s.offReason : '',
    gaveWay: Array.isArray(s.gaveWay) ? s.gaveWay.filter((x) => ['lamp', 'bars', 'hub'].indexOf(x) >= 0).slice(0, 3) : [],
    rev: Number.isInteger(s.rev) && s.rev >= 0 ? s.rev : 0
  };
}

// A change asked for by a person ({ on, palette, vibrancy, beat, preset,
// quietMin }). Throws a 400 with a plain reason; returns only the fields to set.
function checkChange(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('send a JSON object such as { "on": true }');
  const allowed = ['on', 'palette', 'vibrancy', 'beat', 'preset', 'quietMin'];
  Object.keys(body).forEach((k) => { if (allowed.indexOf(k) < 0) throw bad('"' + k + '" is not a music lights setting (use ' + allowed.join(', ') + ')'); });
  const out = {};
  if (body.preset !== undefined) {
    if (!PRESETS[body.preset]) throw bad('preset must be one of ' + Object.keys(PRESETS).join(', '));
    Object.assign(out, PRESETS[body.preset]);
  }
  if (body.on !== undefined) {
    if (typeof body.on !== 'boolean') throw bad('on must be true or false');
    out.on = body.on;
  }
  if (body.palette !== undefined) {
    if (paletteIds().indexOf(body.palette) < 0) throw bad('palette must be one of ' + paletteIds().join(', '));
    out.palette = body.palette;
  }
  ['vibrancy', 'beat'].forEach((k) => {
    if (body[k] === undefined) return;
    if (LEVELS.indexOf(body[k]) < 0) throw bad(k + ' must be low, medium or high');
    out[k] = body[k];
  });
  if (body.quietMin !== undefined) {
    const q = body.quietMin === 'never' ? 0 : body.quietMin;
    if (!Number.isInteger(q) || q < 0 || q > MAX_QUIET_MIN) throw bad('quietMin must be whole minutes from 1 to ' + MAX_QUIET_MIN + ', or 0 / "never"');
    out.quietMin = q;
  }
  if (!Object.keys(out).length) throw bad('nothing to change');
  return out;
}

// Which preset these dials make, or ''.
function presetOf(s) {
  const k = Object.keys(PRESETS).find((p) => PRESETS[p].vibrancy === s.vibrancy && PRESETS[p].beat === s.beat);
  return k || '';
}

module.exports = {
  LEVELS: LEVELS,
  PRESETS: PRESETS,
  DEFAULT_QUIET_MIN: DEFAULT_QUIET_MIN,
  MAX_QUIET_MIN: MAX_QUIET_MIN,
  PALETTES: PALETTES,
  loadPalettes: loadPalettes,
  paletteIds: paletteIds,
  paletteById: paletteById,
  defaults: defaults,
  clean: clean,
  checkChange: checkChange,
  presetOf: presetOf
};
