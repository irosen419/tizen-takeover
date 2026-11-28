/*
 * Tests for the Moods catalog: pi/moods/catalog.js and its two data files,
 * pi/moods/moods.json and pi/moods/wall.json. Run from the repo root with:
 *
 *   node pi/moods-data-test.js
 *
 * Pure: no network, no clock, no time zone. The tables below are copied from
 * the Plant Wall Moods artifact (PRESETS, FX, HALOS) so a drift in the data
 * is caught. Prints one line per check, then "N passed, M failed".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalogLib = require('./moods/catalog');
const looksLib = require('./lights/looks');

const MOODS_TEXT = fs.readFileSync(path.join(__dirname, 'moods', 'moods.json'), 'utf8');
const WALL_TEXT = fs.readFileSync(path.join(__dirname, 'moods', 'wall.json'), 'utf8');
const catalog = JSON.parse(MOODS_TEXT);
const wall = JSON.parse(WALL_TEXT);
const copy = (o) => JSON.parse(JSON.stringify(o));
let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r === 'skip') { skipped++; return; }
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

// forest-render: the repo copy (WP3), or the Pi-render thread's original.
function forestRender() {
  const tries = [path.join(__dirname, 'moods', 'forest-render.js'), '/mnt/project-files/plant-wall/pi-render/forest-render.js'];
  for (let i = 0; i < tries.length; i++) if (fs.existsSync(tries[i])) return require(tries[i]);
  return null;
}

// The 22 visible moods of plan section 2.3, in order, with the artifact preset each comes from.
const IDS = [
  ['match-the-art', 'Match the art'], ['paint-splash', 'Paint splash'], ['lofi-chill', 'Lo-fi chill'],
  ['rainforest', 'Rainforest'], ['rainforest-night', 'Rainforest v2'], ['thunderstorm', 'Thunderstorm'],
  ['rainforest-storm', 'Rainforest storm'], ['aurora', 'Aurora'], ['christmas', 'Christmas'],
  ['santa', 'Santa Claus Is Coming to Town'], ['carol-of-the-bells', 'Carol of the Bells'], ['hanukkah', 'Hanukkah'],
  ['dreidel', 'Dreidel, Dreidel, Dreidel'], ['menorah', 'Menorah'], ['ocean-drift', 'Ocean drift'],
  ['movie-night', 'Movie night'], ['tv-glow', 'TV glow'], ['dinner-party', 'Dinner party'],
  ['dance-party', 'Dance party'], ['sunset', 'Sunset'], ['game-day', 'Game day'], ['goodnight', 'Goodnight']
];
const FOREST = ['rainforest', 'rainforest-storm'];
// Halos per mood from plan 2.3 (guitar, drum, mic; null = dark); vase moods follow the vases.
const HALO_PLAN = {
  'rainforest-night': ['h-fireflies', 'h-fireflies', 'h-fireflies'], thunderstorm: ['h-storm', 'h-thunder', 'h-storm'],
  aurora: ['h-aurora', 'h-aurora', 'h-aurora'], christmas: ['h-xmas', 'h-candycane', 'h-xmas'],
  santa: ['h-peaks', 'h-ripples', 'h-peaks'], 'carol-of-the-bells': ['h-peaks', 'h-ripples', 'h-peaks'],
  hanukkah: ['h-bluesilver', 'h-bluewave', 'h-bluesilver'], dreidel: ['h-peaks', 'h-spin', 'h-peaks'],
  menorah: ['h-menorah', 'h-menorah', 'h-menorah'], 'dinner-party': ['h-candle', 'h-candle', 'h-candle'],
  'dance-party': ['h-rainbow', 'h-rainbow', 'h-rainbow'],
  'movie-night': [null, null, null], 'tv-glow': [null, null, null], goodnight: [null, null, null]
};
const WLED_EFFECTS = ['santa', 'carol-of-the-bells', 'dreidel'];

// Artifact FX (vase effects): key, WLED id, ix, pal, glint, mic.
const FX = [
  ['static', 0], ['breathe', 2], ['cycle', 8], ['candle', 88],
  ['fireflies', 51, 0, 2, '#c8ff14'], ['rain', 51, 220, 2, '#a9c8ff'], ['twinkle', 51, 150, 2, '#fff1d6'],
  ['meter', 132, 128, 2, null, true]
];

const PRESETS = [
  ['Match the art', ['#ff5163', '#ff8d42', '#ff6b53', '#ff5a47'], 'static', 120, 128],
  ['Paint splash', ['#ff4f8a', '#ff8a3d', '#8f5bd6', '#2fbf8f'], 'breathe', 130, 30],
  ['Lo-fi chill', ['#2fb5a3', '#e8a24a', '#8e7cc3', '#4fa36b'], 'breathe', 90, 40],
  ['Rainforest', ['#2f9a52', '#8cc63f', '#16775c', '#e0a33a'], 'static', 115, 128, 95, ['canopy', 'canopy', 'canopy']],
  ['Rainforest v2', ['#1f8a4a', '#3e9a35', '#13705a', '#2c8f6c'], 'fireflies', 95, 150, 120, ['fireflies', 'fireflies', 'fireflies']],
  ['Thunderstorm', ['#24479a', '#1a3577', '#24479a', '#1a3577'], 'rain', 70, 200, 200, ['storm', 'thunder', 'storm']],
  ['Rainforest storm', ['#1f8a4a', '#3e9a35', '#13705a', '#2c8f6c'], 'fireflies', 95, 150, 120, ['stormflies', 'stormflies', 'stormflies']],
  ['Aurora', ['#19e3a0', '#2fa8e0', '#7a4fd8', '#22c47a'], 'breathe', 100, 22, 130, ['aurora', 'aurora', 'aurora']],
  ['Christmas', ['#ff1a1a', '#14a03c', '#14a03c', '#ff1a1a'], 'twinkle', 120, 150, 150, ['xmas', 'candycane', 'xmas']],
  ['Santa Claus Is Coming to Town', ['#ff1a1a', '#14a03c', '#14a03c', '#ff1a1a'], 'meter', 170, 128, 190, ['peaks', 'ripples', 'peaks']],
  ['Carol of the Bells', ['#ff1a1a', '#14a03c', '#14a03c', '#ff1a1a'], 'meter', 170, 128, 190, ['peaks', 'ripples', 'peaks']],
  ['Hanukkah', ['#1d4fe0', '#dfe8ff', '#dfe8ff', '#1d4fe0'], 'breathe', 110, 30, 140, ['bluesilver', 'bluewave', 'bluesilver']],
  ['Dreidel, Dreidel, Dreidel', ['#1d4fe0', '#dfe8ff', '#dfe8ff', '#1d4fe0'], 'meter', 160, 128, 180, ['peaks', 'spin', 'peaks']],
  ['Menorah', ['#1d4fe0', '#dfe8ff', '#dfe8ff', '#1d4fe0'], 'static', 40, 128, 200, ['menorah', 'menorah', 'menorah']],
  ['Ocean drift', ['#1e6fd9', '#22b8cf', '#3a4fd0', '#5fd3c6'], 'breathe', 100, 25],
  ['Movie night', ['#ff8a2a', '#ff8a2a', '#ff8a2a', '#ff8a2a'], 'static', 18, 128],
  ['TV glow', ['#6f8cff', '#6f8cff', '#8a7dff', '#8a7dff'], 'static', 30, 128],
  ['Dinner party', ['#ff9b3d', '#ffb35c', '#ff9b3d', '#ffb35c'], 'candle', 120, 90],
  ['Dance party', ['#ff3d7f', '#ffd23d', '#3dd6ff', '#9b3dff'], 'cycle', 200, 180],
  ['Sunset', ['#ffb347', '#ff6a3d', '#e2457a', '#8f3fbf'], 'static', 140, 128],
  ['Game day', ['#2b6bff', '#c9d3e0', '#2b6bff', '#c9d3e0'], 'static', 160, 128],
  ['Goodnight', ['#ff2a10', '#ff2a10', '#ff2a10', '#ff2a10'], 'breathe', 10, 15],
];
const HALOS = {
  art: {fx: 0},
  vases: {fx: 0},
  warm: {fx: 0, one: '#ffa25a'},
  splash: {fx: 0},
  gallery: {fx: 0},
  breathe: {fx: 2, sx: 40},
  candle: {fx: 88, sx: 90, one: '#ff9b3d'},
  twinkle: {fx: 17, sx: 110, one: '#ffd9a0'},
  comet: {fx: 41, sx: 120},
  rainbow: {fx: 9, sx: 60},
  ocean: {fx: 101, sx: 100},
  canopy: {fx: 67, sx: 40, ix: 110, pal: 10},
  fireflies: {fx: 80, sx: 90, ix: 24, pal: 2, o1: true, cols: ['#c8ff14', '#146e32']},
  storm: {fx: 57, sx: 210, ix: 120, cols: ['#d2e1ff', '#0c1a40']},
  thunder: {fx: 144, sx: 120, ix: 255, c1: 6, c2: 40, cols: ['#e2ecff', '#0c1a40']},
  stormflies: {fx: 80, sx: 90, ix: 24, pal: 2, o1: true, cols: ['#c8ff14', '#146e32']},
  drumbeat: {fx: 144, sx: 150, ix: 255, c1: 6, c2: 40, cols: ['#d2e1ff', '#000000']},
  aurora: {fx: 38, sx: 24, ix: 128, pal: 50},
  xmas: {fx: 80, sx: 70, ix: 230, pal: 53, cols: ['#ff0500', '#200800']},
  candycane: {fx: 15, sx: 16, ix: 128, cols: ['#ff1020', '#ffffff']},
  bluesilver: {fx: 80, sx: 70, ix: 200, pal: 3, cols: ['#ffffff', '#1440c8']},
  bluewave: {fx: 15, sx: 12, ix: 64, cols: ['#ffffff', '#1440c8']},
  peaks: {fx: 144, sx: 150, ix: 200, c1: 6, c2: 40},
  ripples: {fx: 148, sx: 140, ix: 120, pal: 53, c1: 6, c2: 40, cols: ['#ff0500', '#000000']},
  spin: {fx: 41, sx: 120, ix: 200, cols: ['#ffffff', '#0c2a8a']},
  menorah: {fx: 88},
};

const byId = {};
catalog.moods.forEach((m) => { byId[m.id] = m; });
const fxId = (key) => catalog.fx[key].id;
const visible = catalog.moods.filter((m) => !m.hidden);
const lookIds = looksLib.BUILT_IN.map((l) => l.id);

check('validate() finds nothing wrong (with the built-in look ids)', () => {
  assert.deepStrictEqual(catalogLib.validate(catalog, wall, { lookIds }), []);
});

check('load() reads both files and agrees with them', () => {
  const r = catalogLib.load(null);
  assert.deepStrictEqual(r.catalog, catalog);
  assert.deepStrictEqual(r.wall, wall);
  assert.strictEqual(r.override, null);
});

check('22 visible moods with exactly the ids of plan 2.3, in order, n 1 to 22', () => {
  assert.deepStrictEqual(visible.map((m) => m.id), IDS.map((x) => x[0]));
  assert.deepStrictEqual(visible.map((m) => m.n), IDS.map((x, i) => i + 1));
  assert.strictEqual(new Set(catalog.moods.map((m) => m.id)).size, catalog.moods.length);
  assert.strictEqual(new Set(catalog.moods.map((m) => m.n)).size, catalog.moods.length);
});

check('the hidden check mood: 20%, red green blue yellow vases, white drops, gold candles, not in HA', () => {
  const m = byId.check;
  assert.strictEqual(m.hidden, true);
  assert.strictEqual(m.ha.expose, false);
  assert.strictEqual(m.bri, 20);
  assert.deepStrictEqual(m.vases.c, ['#ff0000', '#00ff00', '#0000ff', '#ffff00']);
  assert.strictEqual(m.vases.design, 'v-static');
  assert.strictEqual(m.extras.drops, '#ffffff');
  assert.strictEqual(m.extras.candles, '#ffb000');
  const d = catalog.designs['h-check'];
  assert.strictEqual(d.hidden, true);
  ['guitar', 'drum', 'mic'].forEach((p) => {
    assert.strictEqual(m.halos[p], 'h-check');
    const s = d.wled.sides[p];
    assert.strictEqual(new Set([s.top, s.left, s.right, s.bottom]).size, 4, p + ': each side its own colour');
  });
});

check('all 8 vase and 26 halo designs present (plus only the hidden check design)', () => {
  const vase = Object.keys(catalog.designs).filter((k) => catalog.designs[k].for === 'vase');
  const halo = Object.keys(catalog.designs).filter((k) => catalog.designs[k].for === 'halo' && !catalog.designs[k].hidden);
  assert.deepStrictEqual(vase, FX.map((f) => 'v-' + f[0]));
  assert.deepStrictEqual(vase, catalogLib.VASE_DESIGNS);
  assert.deepStrictEqual(halo, Object.keys(HALOS).map((k) => 'h-' + k));
  assert.strictEqual(halo.length, 26);
  assert.deepStrictEqual(Object.keys(catalog.designs).filter((k) => catalog.designs[k].hidden), ['h-check']);
});

check('vase designs equal the artifact FX (effect, ix, palette, glint, mic)', () => {
  FX.forEach((f) => {
    const d = catalog.designs['v-' + f[0]];
    assert.strictEqual(fxId(d.wled.fx), f[1], f[0]);
    assert.strictEqual(d.wled.ix, f[2] === undefined ? undefined : f[2], f[0] + ' ix');
    assert.strictEqual(d.wled.pal, f[3] === undefined ? undefined : f[3], f[0] + ' pal');
    assert.strictEqual(d.wled.glint, f[4] || undefined, f[0] + ' glint');
    assert.strictEqual(d.needs.indexOf('mic') >= 0, !!f[5], f[0] + ' mic');
  });
});

check('halo designs equal the artifact HALOS (fx, sx, ix, pal, o1, c1, c2, colours)', () => {
  Object.keys(HALOS).forEach((k) => {
    const H = HALOS[k];
    const w = catalog.designs['h-' + k].wled;
    assert.strictEqual(fxId(w.fx), H.fx, k + ' fx');
    ['sx', 'ix', 'pal', 'c1', 'c2'].forEach((f) => assert.strictEqual(w[f], H[f], k + ' ' + f));
    assert.strictEqual(!!w.o1, !!H.o1, k + ' o1');
    if (H.cols) assert.deepStrictEqual(w.col, H.cols, k + ' colours');
    if (H.one) assert.deepStrictEqual(w.col, [H.one], k + ' colour');
  });
  assert.deepStrictEqual(catalog.designs['h-art'].wled.sides.guitar, { top: '#ff4d71', left: '#ff632d', right: '#ffb128', bottom: '#ff5613' });
  assert.deepStrictEqual(catalog.designs['h-splash'].wled.sides.mic, { top: '#2fbf6f', left: '#2fbf6f', right: '#e0409a', bottom: '#e0409a' });
  assert.deepStrictEqual(catalog.designs['h-comet'].wled.colBy, { guitar: ['#ff4d71'], drum: ['#ff5468'], mic: ['#ff683c'] });
  assert.strictEqual(catalog.designs['h-peaks'].wled.colFrom, 'vases');
  const mw = catalog.designs['h-menorah'].wled.menorah;
  assert.deepStrictEqual([mw.flame.sx, mw.flame.ix, mw.shamash.ix], [96, 160, 120]);
});

check('vase colours, brightness and speed equal the artifact PRESETS (forest moods: colours in sw)', () => {
  PRESETS.forEach((p) => {
    const id = IDS.find((x) => x[1] === p[0])[0];
    const m = byId[id];
    assert.deepStrictEqual(m.sw, p[1], id + ' sw');
    if (FOREST.indexOf(id) >= 0) {
      assert.strictEqual(m.vases, null, id);
      assert.strictEqual(m.halos, null, id);
      return;
    }
    assert.strictEqual(m.vases.design, 'v-' + p[2], id + ' design');
    assert.deepStrictEqual(m.vases.c, p[1], id + ' colours');
    assert.strictEqual(m.vases.bri, p[3], id + ' bri');
    assert.strictEqual(m.vases.sx, p[4], id + ' sx');
    if (p[5] !== undefined && id !== 'rainforest-storm') {
      assert.strictEqual(m.halos.bri, p[5], id + ' halo bri');
      assert.deepStrictEqual([m.halos.guitar, m.halos.drum, m.halos.mic], p[6].map((k) => 'h-' + k), id + ' halos');
    }
  });
});

check('halos per plan 2.3; vase moods follow the vases at half the vase brightness', () => {
  visible.forEach((m) => {
    if (FOREST.indexOf(m.id) >= 0) return;
    const got = [m.halos.guitar, m.halos.drum, m.halos.mic];
    if (HALO_PLAN[m.id]) assert.deepStrictEqual(got, HALO_PLAN[m.id], m.id);
    else {
      assert.deepStrictEqual(got, ['h-vases', 'h-vases', 'h-vases'], m.id);
      assert.strictEqual(m.halos.bri, Math.round(m.vases.bri / 2), m.id + ' half');
    }
  });
});

check('render: forest moods on the forest engine with preset 2, three on WLED effects, the rest the mood engine', () => {
  visible.forEach((m) => {
    if (FOREST.indexOf(m.id) >= 0) {
      assert.deepStrictEqual(m.wled, { preset: 2 }, m.id);
      assert.deepStrictEqual(m.wash, { palette: 'forest' }, m.id);
      assert.strictEqual(m.render.engine, 'forest', m.id);
      assert.deepStrictEqual(m.render.drift, { cycleSeconds: null, spans: 1 }, m.id);
    } else if (WLED_EFFECTS.indexOf(m.id) >= 0) assert.strictEqual(m.render.type, 'wled-effects', m.id);
    else assert.deepStrictEqual([m.render.type, m.render.engine], ['pi-drawn', 'mood'], m.id);
  });
  assert.strictEqual(byId.rainforest.render.events, undefined);
  const t = byId['rainforest-storm'].render.events.thunder;
  assert.deepStrictEqual([t.kind, t.size, t.depth, t.attack, t.hold, t.release, t.floor, t.auto], ['dim', [2, 4], [0.5, 0.75], 0.25, [1, 2.5], 0.9, 0.15, [20, 75]]);
  assert.deepStrictEqual(t.fallback, { dimSegment: 'halo.drum' });
});

check('needs: mic for the music and thunder moods, songs not built, candles for the Menorah', () => {
  assert.deepStrictEqual(visible.filter((m) => m.needs.mic).map((m) => m.id), ['thunderstorm', 'santa', 'carol-of-the-bells', 'dreidel']);
  assert.deepStrictEqual(byId['carol-of-the-bells'].needs.song, { id: 'carol', built: false });
  assert.deepStrictEqual(byId.dreidel.needs.song, { id: 'dreidel', built: false });
  assert.strictEqual(byId.santa.needs.song, null);
  assert.deepStrictEqual(visible.filter((m) => m.needs.candles).map((m) => m.id), ['menorah']);
});

check('every referenced design, palette, fx, pal and look exists', () => {
  Object.keys(catalog.designs).forEach((k) => {
    const d = catalog.designs[k];
    assert.ok(catalog.fx[d.wled.fx], k + ' fx');
    if (d.wled.pal !== undefined) assert.ok(catalogLib.palByNumber(catalog, d.wled.pal), k + ' pal');
    if (d.fallback) assert.ok(catalog.designs[d.fallback], k + ' fallback');
    (d.pi || []).forEach((L) => { if (L.palette) assert.ok(catalog.palettes[L.palette], k + ' palette'); });
  });
  catalog.moods.forEach((m) => {
    catalogLib.designsOf(m).forEach((id) => assert.ok(catalog.designs[id], m.id + ' ' + id));
    if (m.wash) assert.ok(catalog.palettes[m.wash.palette], m.id);
    if (m.render.palette) assert.ok(catalog.palettes[m.render.palette], m.id);
    if (m.govee && m.govee.ref) assert.ok(lookIds.indexOf(m.govee.ref) >= 0, m.id + ' look ' + m.govee.ref);
  });
  assert.strictEqual(Object.keys(catalog.fx).length, 18);
  assert.deepStrictEqual(byId.rainforest.govee, { ref: 'rainforest' });
  assert.deepStrictEqual(byId.thunderstorm.govee, { ref: 'thunderstorm' });
});

check('every govee look passes looksLib.check (as the mood-<id> look)', () => {
  let n = 0;
  catalog.moods.forEach((m) => {
    const l = catalogLib.goveeLook(m);
    if (!l || l.ref) return;
    assert.strictEqual(l.id, 'mood-' + m.id);
    looksLib.check(l, m.id);
    n++;
  });
  assert.ok(n >= 15, 'looks checked: ' + n);
  assert.strictEqual(byId.check.govee, null);
});

check('EN and ES names and descriptions present and inside the limits, sentence case, no dashes', () => {
  const items = catalog.moods.map((m) => ['mood ' + m.id, m]).concat(Object.keys(catalog.designs).map((k) => ['design ' + k, catalog.designs[k]]));
  items.forEach(([what, o]) => {
    assert.ok(o.name && o.name.length <= 32, what + ' name');
    assert.ok(o.es && o.es.length <= 40, what + ' es');
    assert.ok(o.desc && o.desc.length <= 90, what + ' desc ' + (o.desc || '').length);
    assert.ok(o.descEs && o.descEs.length <= 115, what + ' descEs ' + (o.descEs || '').length);
    [o.name, o.es, o.desc, o.descEs].forEach((s) => {
      assert.ok(!/[‐-―−]| - /.test(s), what + ' dash: ' + s);
      assert.ok(/^[A-ZÁÉÍÓÚÑ0-9]/.test(s), what + ' capital: ' + s);
    });
    // Sentence case: no capital after the first word, except names, the songs and C9.
    [o.desc, o.descEs].forEach((s) => {
      const words = s.replace(/[.:;] [A-ZÁÉÍÓÚÑ]/g, '. x').split(/\s+/).slice(1);
      words.forEach((w) => assert.ok(!/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(w) || /^(Santa|Claus|Carol|Bells|Hanukkah|Janucá|Menorah|Menorá|Echo|Rainforest)/.test(w), what + ' sentence case: ' + s));
    });
  });
  visible.forEach((m) => { if (m.sound) assert.ok(m.sound.hint && m.sound.hintEs, m.id + ' sound'); });
});

check('Spanish is real Spanish, not a copy (except the song title and Aurora)', () => {
  const same = visible.filter((m) => m.es === m.name).map((m) => m.id);
  assert.deepStrictEqual(same, ['aurora', 'carol-of-the-bells']);
  visible.forEach((m) => assert.notStrictEqual(m.descEs, m.desc, m.id));
  assert.strictEqual(byId.hanukkah.es, 'Janucá');
  assert.strictEqual(byId.menorah.es, 'Menorá');
});

check('hex colours valid and numbers 0 to 255 everywhere in both files', () => {
  const walk = (v, where) => {
    if (typeof v === 'string' && v[0] === '#') assert.ok(/^#[0-9a-f]{6}$/i.test(v), where + ' ' + v);
    else if (typeof v === 'number') assert.ok(v >= 0 && v <= 255 || /power|geometry|render\.maxMa|hanukkah/.test(where), where + ' ' + v);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, where + '[' + i + ']'));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], where + '.' + k));
  };
  walk(catalog, 'moods');
  walk(copy(wall), 'wall');
  Object.keys(catalog.palettes).forEach((k) => catalog.palettes[k].forEach((h) => assert.ok(/^[0-9a-f]{6}$/i.test(h), k)));
});

check('zones inside 0 to 161, no overlap between vases, drops, runs and tails; 162 and 163 never used', () => {
  const seen = {};
  Object.keys(wall.zones).forEach((z) => {
    catalogLib.zoneBulbs(wall, z).forEach((led) => {
      assert.ok(led >= 0 && led <= 161, z + ' ' + led);
      assert.ok(!seen[led], 'bulb ' + led + ' in ' + seen[led] + ' and ' + z);
      seen[led] = z;
    });
  });
  assert.strictEqual(Object.keys(seen).length, 162, 'every lit bulb belongs to a zone');
  assert.deepStrictEqual(wall.spare, [162, 163]);
  assert.deepStrictEqual(catalogLib.zoneBulbs(wall, 'vase1'), [9, 10, 11, 12, 13, 14, 15]);
  assert.deepStrictEqual(catalogLib.zoneBulbs(wall, 'run.left'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 27, 28]);
  assert.deepStrictEqual(catalogLib.zoneBulbs(wall, 'nope'), []);
});

check('sure flags: halos sure, vases, drops, runs, sides and menorah not', () => {
  Object.keys(wall.zones).forEach((z) => assert.strictEqual(wall.zones[z].sure, /^halo\./.test(z), z));
  Object.keys(wall.sides).forEach((z) => assert.strictEqual(wall.sides[z].sure, false, z));
  assert.strictEqual(wall.menorah.sure, false);
});

check('sides add up to their zone; inside and outside map to left and right', () => {
  Object.keys(wall.sides).forEach((z) => {
    const got = [];
    wall.sides[z].s.forEach((row) => { for (let i = row[1]; i <= row[2]; i++) got.push(i); });
    assert.deepStrictEqual(got, catalogLib.zoneBulbs(wall, z), z);
  });
  assert.deepStrictEqual(wall.sides['halo.guitar'].s.map((r) => r[2] - r[1] + 1), [5, 5, 7, 4]);
  assert.deepStrictEqual(wall.sides['halo.drum'].s.map((r) => r[2] - r[1] + 1), [14, 17, 14, 17]);
  assert.deepStrictEqual(catalogLib.sideBulbs(wall, 'halo.guitar', 'right'), [29, 30, 31, 32, 33]);
  assert.deepStrictEqual(catalogLib.sideBulbs(wall, 'halo.mic', 'left'), [141, 142, 143, 144, 145]);
  assert.deepStrictEqual(catalogLib.sideBulbs(wall, 'halo.mic', 'outside'), [151, 152, 153, 154, 155, 156, 157]);
  assert.deepStrictEqual(catalogLib.whereIs(wall, 90), { zone: 'halo.drum', side: 'top' });
});

check('8 candles and a shamash, all on top sides, numbered from the right', () => {
  assert.strictEqual(wall.menorah.candles.length, 8);
  assert.deepStrictEqual(wall.menorah.shamash, [87, 88]);
  wall.menorah.candles.concat(wall.menorah.shamash).forEach((led) => assert.strictEqual(catalogLib.whereIs(wall, led).side, 'top', 'bulb ' + led));
  const xy = catalogLib.bulbXY(wall);
  const xs = wall.menorah.candles.map((led) => xy[led][0]);
  xs.forEach((x, i) => { if (i) assert.ok(x < xs[i - 1], 'candle ' + (i + 1) + ' left of candle ' + i); });
  assert.deepStrictEqual(catalogLib.menorahBulbs(wall, 3), { lit: [150, 148, 146], unlit: [94, 81, 34, 36, 38], shamash: [87, 88] });
  assert.strictEqual(catalogLib.menorahBulbs(wall, 8).unlit.length, 0);
});

check('Menorah night param and the Hanukkah table; nightFor for 2026 dates given as numbers', () => {
  assert.deepStrictEqual(byId.menorah.param, { night: { min: 1, max: 8, auto: 'hanukkah' } });
  visible.forEach((m) => { if (m.id !== 'menorah') assert.strictEqual(m.param, null, m.id); });
  assert.deepStrictEqual(catalog.hanukkah, { '2026': '12-04' });
  const nf = (y, m, d) => catalogLib.nightFor({ y, m, d }, catalog);
  assert.strictEqual(nf(2026, 12, 3), null);
  assert.strictEqual(nf(2026, 12, 4), 1);
  assert.strictEqual(nf(2026, 12, 7), 4);
  assert.strictEqual(nf(2026, 12, 11), 8);
  assert.strictEqual(nf(2026, 12, 12), null);
  assert.strictEqual(nf(2027, 12, 4), null);
  assert.strictEqual(nf(2026, 11, 28), null);
  assert.strictEqual(catalogLib.nightFor({ y: 2026, m: 12 }, catalog), null);
  // A Hanukkah that crosses New Year.
  const cross = { hanukkah: { '2027': '12-29' } };
  assert.strictEqual(catalogLib.nightFor({ y: 2027, m: 12, d: 31 }, cross), 3);
  assert.strictEqual(catalogLib.nightFor({ y: 2028, m: 1, d: 5 }, cross), 8);
  assert.strictEqual(catalogLib.nightFor({ y: 2028, m: 1, d: 6 }, cross), null);
});

check('sections and baseMa equal forest-render\'s; forest palette equals its PALETTE_HEX', () => {
  const fr = forestRender();
  if (!fr) { console.log('skip forest-render not found (pi/moods/forest-render.js)'); return 'skip'; }
  assert.deepStrictEqual(wall.sections.map((s) => [s.start, s.end, s.dim]), fr.WALL.sections.map((s) => [s.start, s.end, s.dim]));
  assert.deepStrictEqual(wall.sections.map((s) => s.id), fr.WALL.sections.map((s) => s.name));
  assert.deepStrictEqual(wall.spare, fr.WALL.spare);
  assert.strictEqual(wall.leds, fr.LED_COUNT);
  assert.strictEqual(wall.power.baseMa, fr.BASE_MA);
  assert.strictEqual(wall.power.ledMa, fr.DEFAULT_LED_MA);
  assert.deepStrictEqual(catalog.palettes.forest, fr.PALETTE_HEX);
  assert.strictEqual(byId['rainforest-storm'].render.maxMa, fr.DEFAULTS.maxMa);
});

check('live segments, protected presets and power as plan 2.1', () => {
  assert.deepStrictEqual(wall.live.segments, [{ id: 0, start: 0, stop: 50 }, { id: 1, start: 50, stop: 112 }, { id: 2, start: 112, stop: 162 }]);
  assert.deepStrictEqual(wall.live.protectedPresets, [1, 2]);
  assert.strictEqual(wall.live.restorePreset, 2);
  assert.strictEqual(wall.live.maxSegments, 32);
  assert.deepStrictEqual(wall.power, { limiterMa: 1000, budgetMa: 800, baseMa: 264, ledMa: 55, flashMa: 250 });
});

check('geometry: the artifact canvases and vases; a position for every lit bulb, none for 162 and 163', () => {
  const g = wall.geometry;
  assert.deepStrictEqual(g.canvases.map((c) => [c.id, c.x, c.y, c.w, c.h]), [['guitar', 0, 52.25, 20, 28], ['drum', 34.25, 52.25, 20, 28], ['mic', 68.5, 52.25, 20, 28]]);
  assert.deepStrictEqual(g.vases.map((v) => [v.zone, v.x, v.y]), [['vase1', 27.125, 72.25], ['vase2', 27.125, 60.25], ['vase3', 61.375, 72.25], ['vase4', 61.375, 60.25]]);
  assert.deepStrictEqual(g.paths['halo.guitar'], [[19.25, 61], [19.25, 79.5], [0.75, 79.5], [0.75, 53], [19.25, 53]]);
  const xy = catalogLib.bulbXY(wall);
  assert.strictEqual(Object.keys(xy).length, 162);
  for (let i = 0; i <= 161; i++) assert.ok(Array.isArray(xy[i]), 'bulb ' + i);
  assert.ok(!xy[162] && !xy[163]);
  Object.keys(xy).forEach((k) => assert.ok(xy[k][0] >= 0 && xy[k][0] <= 89 && xy[k][1] >= 50 && xy[k][1] <= 81, 'bulb ' + k + ' on the wall'));
  // halo bulbs sit on their frame, vase bulbs by their vase
  assert.ok(Math.abs(xy[29][0] - 19.25) < 0.01 && xy[29][1] > 61);
  assert.ok(Math.hypot(xy[12][0] - 27.125, xy[12][1] - 72.25) < 3);
});

check('Pi-only override: merges zones, sides, menorah, power; refuses anything else; load() picks it up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-moods-data-'));
  try {
    const o = { zones: { vase1: { r: [[10, 16]], sure: true }, 'drops.left': { r: [[17, 19]], sure: false } }, menorah: { sure: true }, power: { ledMa: 60 } };
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), JSON.stringify(o));
    const r = catalogLib.load(dir);
    assert.deepStrictEqual(r.wall.zones.vase1, { r: [[10, 16]], sure: true });
    assert.strictEqual(r.wall.menorah.sure, true);
    assert.deepStrictEqual(r.wall.menorah.candles, wall.menorah.candles);
    assert.strictEqual(r.wall.power.ledMa, 60, 'a higher bulb current tightens the budget: taken');
    assert.strictEqual(r.wall.power.budgetMa, 800);
    assert.deepStrictEqual(wall.zones.vase1.r, [[9, 15]], 'the file is untouched');
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), JSON.stringify({ zones: { vase1: { r: [[18, 24]], sure: true } } }));
    assert.throws(() => catalogLib.load(dir), /bulb \d+ is in vase1/);
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), JSON.stringify({ live: { maxSegments: 99 } }));
    assert.throws(() => catalogLib.load(dir), /cannot be changed/);
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), '{nope');
    assert.throws(() => catalogLib.load(dir), /not valid JSON/);
    assert.deepStrictEqual(catalogLib.checkOverride(null), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('Pi-only override cannot raise or bypass the power budget, or reach a prototype', () => {
  const pw = wall.power;
  // The limiter and the base current can never be changed.
  ['limiterMa', 'baseMa', 'maxMa'].forEach((k) => {
    const p = catalogLib.checkOverride({ power: { [k]: 5000 } });
    assert.ok(p.length && /cannot be changed/.test(p[0]), k + ': ' + JSON.stringify(p));
  });
  assert.ok(/power must be an object/.test(catalogLib.checkOverride({ power: 3 })[0]));
  // budgetMa and flashMa only down, ledMa only up.
  const up = catalogLib.mergeWall(wall, { power: { budgetMa: 990, flashMa: 900, ledMa: 20 } });
  assert.strictEqual(up.power.budgetMa, pw.budgetMa);
  assert.strictEqual(up.power.flashMa, pw.flashMa);
  assert.strictEqual(up.power.ledMa, pw.ledMa);
  assert.strictEqual(up.power.limiterMa, pw.limiterMa);
  assert.strictEqual(up.power.baseMa, pw.baseMa);
  const down = catalogLib.mergeWall(wall, { power: { budgetMa: 600, flashMa: 100, ledMa: 70 } });
  assert.deepStrictEqual([down.power.budgetMa, down.power.flashMa, down.power.ledMa], [600, 100, 70]);
  // A merge that skips checkOverride still never takes the limiter or the base.
  const sneak = catalogLib.mergeWall(wall, { power: { limiterMa: 5000, baseMa: 1 } });
  assert.strictEqual(sneak.power.limiterMa, pw.limiterMa);
  assert.strictEqual(sneak.power.baseMa, pw.baseMa);
  // Not a number: kept as sent so validate() refuses it (no coercion of "900").
  const str = catalogLib.mergeWall(wall, { power: { budgetMa: '900' } });
  assert.ok(catalogLib.validate(catalog, str).some((x) => /power needs/.test(x)));
  // Only finite numbers above 0, in checkOverride, mergeWall and validate.
  [JSON.parse('1e999'), -JSON.parse('1e999'), NaN, 0, -5, '700', null, true].forEach((v) => {
    const p = catalogLib.checkOverride({ power: { budgetMa: v } });
    assert.ok(p.length && /number above 0/.test(p[0]), String(v) + ': ' + JSON.stringify(p));
    const m = catalogLib.mergeWall(wall, { power: { budgetMa: v } });
    assert.ok(catalogLib.validate(catalog, m).some((x) => /power needs/.test(x)), 'validate refuses ' + String(v));
  });
  const infWall = copy(wall);
  infWall.power.limiterMa = JSON.parse('1e999');
  assert.ok(catalogLib.validate(catalog, infWall).some((x) => /power needs/.test(x)), 'validate refuses Infinity in the file too');
  // Prototype keys, at any depth, are refused and never merged.
  ['{"__proto__":{"x":1}}', '{"zones":{"__proto__":{"r":[[0,1]],"sure":true}}}', '{"power":{"constructor":{"prototype":{"budgetMa":5000}}}}', '{"menorah":{"prototype":1}}']
    .forEach((t) => {
      const o = JSON.parse(t);
      const p = catalogLib.checkOverride(o);
      assert.ok(p.length && /not allowed/.test(p[0]), t + ': ' + JSON.stringify(p));
      const m = catalogLib.mergeWall(wall, o);
      assert.strictEqual(Object.getPrototypeOf(m.zones), Object.prototype, t);
      assert.strictEqual(Object.getPrototypeOf(m.power), Object.prototype, t);
      assert.strictEqual(m.power.budgetMa, pw.budgetMa, t);
      assert.strictEqual({}.x, undefined, t);
    });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-moods-data-'));
  try {
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), JSON.stringify({ power: { budgetMa: 2000, ledMa: 1 } }));
    const r = catalogLib.load(dir);
    assert.strictEqual(r.wall.power.budgetMa, pw.budgetMa, 'load clamps too');
    assert.strictEqual(r.wall.power.ledMa, pw.ledMa);
    // An old fix with limiterMa or baseMa: its power part is ignored (reported), its zones kept, Moods stays on.
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), JSON.stringify({ zones: { vase1: { r: [[9, 15]], sure: true } }, power: { limiterMa: 2000, budgetMa: 700 } }));
    const old = catalogLib.load(dir);
    assert.deepStrictEqual(old.ignored, ['power']);
    assert.deepStrictEqual(old.wall.power, pw, 'the map\'s power');
    assert.deepStrictEqual(old.wall.zones.vase1, { r: [[9, 15]], sure: true }, 'the zones are kept');
    // 1e999 is Infinity in JSON: never taken, in a file or through checkOverride.
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), '{"power":{"budgetMa":1e999}}');
    const inf = catalogLib.load(dir);
    assert.deepStrictEqual(inf.ignored, ['power']);
    assert.strictEqual(inf.wall.power.budgetMa, pw.budgetMa);
    fs.writeFileSync(path.join(dir, catalogLib.OVERRIDE_FILE), JSON.stringify({ power: { ledMa: 60 } }));
    assert.deepStrictEqual(catalogLib.load(dir).ignored, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('validate() catches bad data', () => {
  const bad = (fn, re) => {
    const c = copy(catalog);
    const w = copy(wall);
    fn(c, w);
    const p = catalogLib.validate(c, w, { lookIds });
    assert.ok(p.some((x) => re.test(x)), 'expected ' + re + ', got ' + JSON.stringify(p.slice(0, 3)));
  };
  bad((c) => { c.moods[0].vases.design = 'v-nope'; }, /not a vase design/);
  bad((c) => { c.moods[5].halos.drum = 'v-static'; }, /not a halo design/);
  bad((c) => { c.moods[1].desc = 'x'.repeat(91); }, /desc is 91/);
  bad((c) => { c.moods[1].descEs = 'Una – raya'; }, /dash/);
  bad((c) => { c.moods[2].sw[0] = '#12345'; }, /not #rrggbb/);
  bad((c) => { c.moods[2].vases.bri = 256; }, /0-255/);
  bad((c) => { c.moods[3].wled = { preset: 2, psave: 2 }; }, /preset: N/);
  bad((c) => { c.moods[3].wled = { preset: 7 }; }, /live presets/);
  bad((c) => { c.moods[5].govee = { ref: 'nope' }; }, /not a look/);
  bad((c) => { c.moods[6].n = 1; }, /n repeats/);
  bad((c) => { c.moods[7].id = c.moods[8].id; }, /id repeats/);
  bad((c) => { c.designs['h-storm'].wled.fx = 'nope'; }, /not in fx/);
  bad((c) => { c.designs['h-storm'].wled.pal = 77; }, /not in pals/);
  bad((c) => { c.designs['h-thunder'].fallback = null; }, /no fallback/);
  bad((c) => { c.moods[5].needs.mic = false; }, /needs.mic does not match/);
  bad((c) => { c.moods[6].render.events.thunder.zones.push('halo.nope'); }, /zone halo.nope/);
  bad((c, w) => { w.zones.vase2.r = [[15, 21]]; }, /bulb 15 is in vase1 and vase2/);
  bad((c, w) => { w.zones['halo.mic'].r = [[141, 162]]; }, /outside 0-161/);
  bad((c, w) => { w.sides['halo.drum'].s[3][2] = 110; }, /do not add up/);
  bad((c, w) => { w.menorah.candles[0] = 152; }, /not on a top side/);
  bad((c, w) => { w.menorah.candles.pop(); }, /8 candles/);
});

check('no IP address, entity id, token or address in either file', () => {
  [['moods.json', MOODS_TEXT], ['wall.json', WALL_TEXT]].forEach(([f, t]) => {
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(t), f + ': IP address');
    assert.ok(!/\b(light|switch|sensor|scene|script|media_player|input_select|select|automation)\.[a-z0-9_]+\b/.test(t), f + ': entity id');
    assert.ok(!/https?:\/\/|\.local\b|:\d{4,5}\b/.test(t), f + ': address');
    assert.ok(!/token|secret|password|bearer|api[_-]?key/i.test(t), f + ': secret word');
    assert.ok(!/[A-Za-z0-9_-]{32,}/.test(t), f + ': long key-like string');
  });
});

console.log(passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exit(failed ? 1 : 0);
