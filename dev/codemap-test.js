/* Checks docs/CODE-MAP.md: node dev/codemap-test.js (npm test runs it when the map changes).
 * Every backticked repo path must exist (bare names like hub.js only somewhere in the repo).
 * The Architecture page's drawer reads the map (studio/codemap.js): its sections must still
 * parse, and the Studio and the TV's data must carry the current map
 * (after editing the map: node studio/build-architecture.js). */
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
var text = fs.readFileSync(path.join(root, 'docs', 'CODE-MAP.md'), 'utf8');
var names = {};
(function walk(d) {
  fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
    if (e.name === '.git' || e.name === 'node_modules') return;
    if (e.isDirectory()) walk(path.join(d, e.name)); else names[e.name] = 1;
  });
})(root);
var bad = [];
var n = 0;
(text.match(/`[^`\n]+`/g) || []).forEach(function (t) {
  var p = t.slice(1, -1).trim();
  if (!/^(app|pi|dev|studio|docs|art)\/|^[A-Za-z0-9_.-]+\.(js|md|json|html|sh|css)$/.test(p)) return;
  if (/[<>*\s]/.test(p) || /\.\.\./.test(p)) return;
  n++;
  var ok = p.indexOf('/') < 0 ? names[p] : fs.existsSync(path.join(root, p.replace(/\/$/, '')));
  if (!ok) bad.push(p);
});
if (bad.length) { console.log('FAIL: missing paths in docs/CODE-MAP.md: ' + bad.join(', ')); process.exit(1); }
console.log('ok: ' + n + ' paths in docs/CODE-MAP.md exist');

// The drawer's code map: the sections parse, and the built pages carry them.
var cm;
try { cm = require('../studio/codemap').parse(text); } catch (e) { console.log('FAIL: ' + e.message); process.exit(1); }
var empty = cm.read.filter(function (r) { return !r.about.length; }).map(function (r) { return 'step ' + r.n; });
if (empty.length) { console.log('FAIL: reading-order steps that name no file before their colon: ' + empty.join(', ')); process.exit(1); }
console.log('ok: the drawer reads ' + cm.folders.length + ' folders, ' + cm.read.length + ' reading steps, ' + cm.flows.length + ' flows, ' + cm.fixes.length + ' fixes, ' + cm.recipes.length + ' recipes');
var out = require('child_process').spawnSync(process.execPath, [path.join(root, 'studio', 'build-architecture.js'), '--check'], { encoding: 'utf8' });
if (out.status !== 0) { console.log('FAIL: the Architecture page is behind the map: run node studio/build-architecture.js\n' + out.stdout); process.exit(1); }
console.log('ok: the Studio and the TV carry this map');
