/*
 * Keeps the Layout Studio in step with the hub: node dev/studio-sync-test.js
 *
 * Reads app/config.js and the widget files, and studio/layout-studio.html, and
 * checks that the Studio knows every widget the hub registers, holds a size
 * preview for each, copies the hub's built-in layout (TV_DEFAULT) and every
 * saved layout in HUB_CONFIG.layouts (TV_LAYOUTS) exactly, and only keeps a
 * widget the hub lacks when it is marked soon (a proposal). When this fails,
 * a widget or layout landed without the Studio: update studio/layout-studio.html
 * (WIDGETS, SIZE_MATRIX, SZ_ORDER, TV_DEFAULT, TV_LAYOUTS) and docs/tile-sizes.md,
 * publish the page, and see studio/README.md.
 *
 * No browser and no network. Prints one line per check and "N passed, M failed";
 * exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail ? ': ' + detail : '')); }
}

// The hub's settings.
const cfgBox = {};
vm.runInNewContext(read('app/config.js') + '\nthis.cfg = HUB_CONFIG;', cfgBox);
const cfg = cfgBox.cfg;

// Widget ids the hub registers: real(...) and placeholder(...) in the widget files, id: in a widget's own record, planned.js.
const hubIds = {};
const dir = path.join(root, 'app/widgets');
fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).forEach((f) => {
  const src = read('app/widgets/' + f);
  let m;
  const re1 = /\breal\('([\w-]+)'/g;
  while ((m = re1.exec(src))) hubIds[m[1]] = f;
  const re2 = /\bplaceholder\('(\w+)'\)/g;
  while ((m = re2.exec(src))) hubIds[f === 'awws.js' ? 'awws-' + m[1] : m[1]] = f;
  const re3 = /^    id: '([\w-]+)',/gm;
  while ((m = re3.exec(src))) hubIds[m[1]] = f;
  const re4 = /\{ id: '([\w-]+)', title:/g;
  while ((m = re4.exec(src))) hubIds[m[1]] = f;
});

// The Studio's own copies.
const html = read('studio/layout-studio.html');
function slice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('Studio: cannot find ' + from);
  return html.slice(a, b);
}
const box = {};
vm.runInNewContext(slice('  var WIDGETS = {', '  var BASE = [') + '\n' +
  slice('  var TV_DEFAULT = [', '  var TV_LAYOUTS = [') + '\n' +
  slice('  var TV_LAYOUTS = [', '  // A preset hides') + '\n' +
  slice('  var SZ_ORDER = [', '  var TIER_EN') + '\nthis.out = { WIDGETS: WIDGETS, TV_DEFAULT: TV_DEFAULT, TV_LAYOUTS: TV_LAYOUTS, SZ_ORDER: SZ_ORDER };', box);
const S = box.out;
// SIZE_MATRIX keys: read the object's top-level keys by name.
const matrixSrc = slice('  var SIZE_MATRIX = {', '  var CELLS = [');
const matrixKeys = {};
let mm;
const reKey = /^    '?([\w-]+)'?: (?:\{|plannedEntry|awwsPlanned|budgetPlanned)/gm;
while ((mm = reKey.exec(matrixSrc))) matrixKeys[mm[1]] = true;

const norm = (list, idKey) => list.map((e) => [e[idKey], e.x, e.y, e.w, e.h].join(',')).sort().join(' ');

const hubList = Object.keys(hubIds).sort();
check('the hub registers widgets (read ' + hubList.length + ')', hubList.length >= 15, hubList.join(' '));
const missingW = hubList.filter((id) => !S.WIDGETS[id]);
check('the Studio knows every widget the hub registers', !missingW.length, 'missing: ' + missingW.join(', '));
const missingM = hubList.filter((id) => !matrixKeys[id]);
check('the Studio has a size preview (SIZE_MATRIX) for every hub widget', !missingM.length, 'missing: ' + missingM.join(', '));
const missingO = hubList.filter((id) => S.SZ_ORDER.indexOf(id) < 0);
check('every hub widget is listed in SZ_ORDER', !missingO.length, 'missing: ' + missingO.join(', '));
const extra = Object.keys(S.WIDGETS).filter((id) => !hubIds[id] && !S.WIDGETS[id].soon);
check('a Studio widget the hub lacks is marked soon (a proposal)', !extra.length, 'not on the hub and not soon: ' + extra.join(', '));
const stale = Object.keys(S.WIDGETS).filter((id) => hubIds[id] && S.WIDGETS[id].soon && !/^budget-(runway|pace)$/.test(id) && !/^awws-(outreach|pipeline)$/.test(id) && id !== 'ambiance' && id !== 'mirror');
check('a built widget is not still marked soon in the Studio', !stale.length, stale.join(', '));
check('TV_DEFAULT is the hub\'s built-in layout (HUB_CONFIG.layout)', norm(S.TV_DEFAULT, 'id') === norm(cfg.layout, 'widget'),
  '\n  Studio: ' + norm(S.TV_DEFAULT, 'id') + '\n  hub:    ' + norm(cfg.layout, 'widget'));
const saved = cfg.layouts.filter((l) => l.layout);
check('TV_LAYOUTS has every saved layout in HUB_CONFIG.layouts (ids)', S.TV_LAYOUTS.map((l) => l.id).sort().join() === saved.map((l) => l.id).sort().join(),
  'Studio: ' + S.TV_LAYOUTS.map((l) => l.id).join() + ' hub: ' + saved.map((l) => l.id).join());
saved.forEach((l) => {
  const t = S.TV_LAYOUTS.filter((x) => x.id === l.id)[0];
  check('TV_LAYOUTS "' + l.id + '" matches the hub tile for tile', !!t && norm(t.layout, 'id') === norm(l.layout, 'widget'),
    t ? '\n  Studio: ' + norm(t.layout, 'id') + '\n  hub:    ' + norm(l.layout, 'widget') : 'missing');
});
const unknown = [];
cfg.layout.concat(...saved.map((l) => l.layout)).forEach((e) => { if (!S.WIDGETS[e.widget]) unknown.push(e.widget); });
check('every widget on a hub layout is known to the Studio', !unknown.length, unknown.join(', '));

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
