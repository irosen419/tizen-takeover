/*
 * Checks the Architecture page's data: node dev/architecture-test.js
 *
 * Reads studio/architecture/data.json and the Studio page. Fails when: an id repeats,
 * a talksTo link or a data-flow step points at an id that does not exist, a status or kind
 * is not one the page knows, a file path named by a live node is missing from the repo,
 * the data looks like it holds a secret or personal detail (key, token, email, IP address,
 * Cloudflare account id), the diagram layout in arch.js throws, overlaps boxes or points at a
 * missing part for any group, or the Studio page does not carry the same data
 * (run node studio/build-architecture.js).
 * No browser and no network. Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail ? ': ' + detail : '')); }
}
const raw = fs.readFileSync(path.join(root, 'studio/architecture/data.json'), 'utf8');
const D = JSON.parse(raw);
const STATUS = ['live', 'unverified', 'draft', 'planned'];
const KIND = ['group', 'component', 'file', 'service', 'data', 'script', 'test', 'external', 'task', 'doc'];

const byId = {}, dup = [], bad = [], missingFiles = [];
(function walk(n, parent) {
  if (byId[n.id]) dup.push(n.id);
  byId[n.id] = n;
  if (!n.title || !n.summary) bad.push(n.id + ' needs a title and a summary');
  if (STATUS.indexOf(n.status) < 0 && n.kind !== 'group') bad.push(n.id + ' status ' + n.status);
  if (KIND.indexOf(n.kind) < 0) bad.push(n.id + ' kind ' + n.kind);
  if (n.status === 'draft' && !n.pr) bad.push(n.id + ' is a draft with no pr');
  if (parent && parent.id && n.id.indexOf(parent.id + '.') !== 0) bad.push(n.id + ' is not under ' + parent.id);
  (n.files || []).forEach((f) => {
    if (/^\(PR/.test(f) || n.status === 'draft' || n.status === 'planned') return;
    if (!fs.existsSync(path.join(root, f.replace(/\/$/, '')))) missingFiles.push(n.id + ' -> ' + f);
  });
  (n.children || []).forEach((c) => walk(c, n));
})(D.tree.reduce((a, n) => { a.children.push(n); return a; }, { id: '', children: [], title: 'x', summary: 'x', kind: 'group' }), null);
delete byId[''];

check('every id is unique', dup.length === 0, dup.join(', '));
check('every node has a title, summary, known status and kind', bad.length === 0, bad.slice(0, 5).join('; '));
check('files named by live nodes exist in the repo', missingFiles.length === 0, missingFiles.slice(0, 6).join('; '));

const dangling = [];
Object.keys(byId).forEach((id) => (byId[id].talksTo || []).forEach((t) => { if (!byId[t.to]) dangling.push(id + ' -> ' + t.to); else if (['out', 'in', 'both'].indexOf(t.dir) < 0) dangling.push(id + ' dir ' + t.dir); }));
check('every talksTo link points at a real node', dangling.length === 0, dangling.slice(0, 6).join('; '));
const flowBad = [];
(D.flows || []).forEach((f) => { if (!f.id || !f.title || !(f.steps || []).length) flowBad.push(f.id + ' is empty'); (f.steps || []).forEach((s) => { if (!byId[s.node]) flowBad.push(f.id + ' -> ' + s.node); if (!s.say) flowBad.push(f.id + ' step without text'); }); });
check('every data-flow step points at a real node', flowBad.length === 0, flowBad.slice(0, 6).join('; '));
const mapBad = [];
((D.overview || {}).boxes || []).forEach((b) => { if (!byId[b.group]) mapBad.push(b.group); });
check('every Big picture box opens a real group', mapBad.length === 0, mapBad.join(', '));

// Privacy: no secrets or personal details in the shipped data.
const lower = raw;
const leaks = [];
if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(lower)) leaks.push('an email address');
if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(lower.replace(/127\.0\.0\.1/g, ''))) leaks.push('an IP address');
if (/\b[0-9a-f]{32}\b/i.test(lower)) leaks.push('a 32-character id (Cloudflare account?)');
if (/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|xox[bp]-|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})/.test(lower)) leaks.push('a token');
if (/api\.cloudflare\.com\/client\/v4\/accounts\//.test(lower)) leaks.push('a Cloudflare account URL');
check('the data holds no email, IP address, account id or token', leaks.length === 0, leaks.join(', '));

// The diagrams: run the layout engine from arch.js (it is pure, no DOM) on every group and every part
// with parts, closed and with everything open, and check the drawing is sound.
const archJs = fs.readFileSync(path.join(root, 'studio/architecture/arch.js'), 'utf8');
const lm = archJs.match(/\/\*LAYOUT-BEGIN\*\/([\s\S]*?)\/\*LAYOUT-END\*\//);
let makeLayout = null;
try { makeLayout = lm && new Function(lm[1] + '; return makeLayout;')(); } catch (e) { /* reported below */ }
check('arch.js holds the diagram layout between LAYOUT markers', typeof makeLayout === 'function');
if (makeLayout) {
  const M = makeLayout(D.tree);
  const thrown = [], over = [], missing = [], labelHits = [];
  const allOpen = (id) => { const o = {}; (function w(i) { M.kids(i).forEach((k) => { if (M.kids(k).length) { o[k] = 1; w(k); } }); })(id); return o; };
  const roots = Object.keys(byId).filter((id) => (byId[id].children || []).length);
  roots.forEach((rid) => [{}, allOpen(rid)].forEach((open) => {
    let L;
    try { L = M.layout(rid, open); } catch (e) { thrown.push(rid + ': ' + e.message); return; }
    const solid = L.boxes.filter((b) => !b.open).concat(L.chips);
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) if (M.hit(solid[i], solid[j], -0.5)) over.push(rid + ': ' + solid[i].id + ' / ' + solid[j].id);
    L.boxes.forEach((b) => { if (!byId[b.id]) missing.push(rid + ' box ' + b.id); });
    L.chips.forEach((c) => { if (!byId[c.key]) missing.push(rid + ' chip ' + c.key); });
    L.edges.forEach((e) => [e.a, e.b].forEach((x) => { const id = x.replace(/^(in|out):/, ''); if (!byId[id] || !L.pos[x] || !e.d || /NaN|undefined/.test(e.d)) missing.push(rid + ' edge ' + x); }));
    const rects = L.boxes.map((b) => b.open ? { x: b.x, y: b.y, w: b.w, h: M.C.HEAD } : b).concat(L.chips);
    L.labels.filter((l) => !l.over).forEach((l) => rects.forEach((r) => { if (M.hit(l, r, -0.5)) labelHits.push(rid + ': "' + l.text.slice(0, 24) + '" on ' + r.id); }));
  }));
  check('every part with parts lays out as a diagram without throwing (' + roots.length + ' diagrams, closed and all open)', thrown.length === 0, thrown.slice(0, 4).join('; '));
  check('no two boxes or chips overlap in any diagram', over.length === 0, over.slice(0, 4).join('; '));
  check('every drawn box, chip and arrow points at a real part', missing.length === 0, missing.slice(0, 4).join('; '));
  check('no shown arrow label sits on a box', labelHits.length === 0, labelHits.slice(0, 4).join('; '));
}

// The Studio page carries the same data.
const html = fs.readFileSync(path.join(root, 'studio/layout-studio.html'), 'utf8');
const m = html.match(/<script type="application\/json" id="archData">([\s\S]*?)<\/script>/);
let same = false;
try { same = !!m && JSON.stringify(JSON.parse(m[1].replace(/<\\\//g, '</').replace(/<\\!--/g, '<!--'))) === JSON.stringify(D); } catch (e) { /* not equal */ }
check('studio/layout-studio.html carries the same data (run node studio/build-architecture.js)', same);
check('the Studio page has the Architecture chip and view', /data-view="arch"/.test(html) && /id="archView"/.test(html) && /window\.HHArch/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
