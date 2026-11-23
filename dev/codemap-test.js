/* Manual check (npm test skips *.md changes, so run it yourself after editing the map).
 * Bare names like hub.js only need to exist somewhere in the repo.
 * Every backticked repo path in docs/CODE-MAP.md must exist: node dev/codemap-test.js */
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
