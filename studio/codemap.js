/*
 * The code map for the Architecture page: reads docs/CODE-MAP.md and works out, for
 * every part on the map, which of its files the code map explains, where to start
 * reading, what to check when it breaks and which recipe it belongs to.
 *
 *   const cm = require('./codemap');
 *   cm.parse(markdown)        -> the map as data (folders, reading order, flows, fixes, recipes)
 *   cm.attach(data, markdown) -> a copy of data.json with `codemap` added (what the Studio and the TV draw)
 *
 * Used by studio/build-architecture.js (so the page is regenerated from the map, never
 * copied by hand), dev/architecture-test.js and dev/codemap-test.js. Node only.
 *
 * Each part gets an entry in codemap.parts[id] that only points into the lists:
 *   start   { path, read: i | -1, folder: i | -1 }   read = codemap.read[i] when the path is
 *                                                      in the reading order, else the part's main file
 *   files   [{ path, read: i } | { path, flow: [i, j] }, also: [flow i, ...]]
 *   fixes   [i]                                         codemap.fixes[i]
 *   recipe  { i } | absent                              codemap.recipes[i], for adding one like it
 * A part with no files of its own uses its parts' files; a top-level group with none
 * instead gets { folders: [i, ...], read: [i, ...] }: the code-map folders most of its
 * parts live in, and the steps of the reading order about its parts' files.
 * Parts the map says nothing about get no entry.
 */
'use strict';

const PATHLIKE = /^(app|pi|dev|studio|docs|art)\/|^[A-Za-z0-9_.-]+\.(js|md|json|html|sh|css|yml)$/;
const MAX_FILES = 5, MAX_FIXES = 3;

function codes(text) { // backticked words that look like repo paths (patterns like app/widgets/<id>.js kept)
  const out = [];
  (text.match(/`[^`\n]+`/g) || []).forEach((t) => {
    const p = t.slice(1, -1).trim();
    if (!PATHLIKE.test(p) || /\s|\.\.\.|\*/.test(p) || /^(inbox|outbox)\//.test(p)) return;
    if (out.indexOf(p) < 0) out.push(p);
  });
  return out;
}
const clean = (s) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
function sentences(text) { // split on ". " outside backticks
  const out = [];
  let cur = '', tick = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    cur += c;
    if (c === '`') tick = !tick;
    if (!tick && c === '.' && (i === text.length - 1 || (text[i + 1] === ' ' && /[A-Z`(]/.test(text[i + 2] || '')))) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function cells(line) { return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()); }

function sections(md) {
  const out = {};
  let key = null;
  md.split('\n').forEach((line) => {
    const m = line.match(/^## (\d+)\. (.+)$/);
    if (m) { key = m[1]; out[key] = { title: m[2].trim(), lines: [] }; return; }
    if (key) out[key].lines.push(line);
  });
  return out;
}

function parse(md) {
  const S = sections(md);
  const need = (n, what) => { if (!S[n]) throw new Error('docs/CODE-MAP.md has no section "## ' + n + '. ' + what + '"'); return S[n].lines; };

  // 2. Folders: | `app/` | language | runs where | `start` |
  const folders = [];
  need('2', 'Folders').forEach((l) => {
    if (!/^\s*\|\s*`/.test(l)) return;
    const c = cells(l);
    const p = (c[0].match(/`([^`]+)`/) || [])[1];
    const st = (c[3].match(/`([^`]+)`/) || [])[1] || '';
    let where = clean(c[2]);
    if (/^same$/i.test(where) && folders.length) where = folders[folders.length - 1].where; // "same" as the row above
    if (/^n\/a$/i.test(where)) where = ''; // docs run nowhere
    if (p) folders.push({ path: p, lang: clean(c[1]), where: where, start: st });
  });

  // 3. Read these first: numbered; the paths before the first colon are what the step is about.
  const read = [];
  need('3', 'Read these first').forEach((l) => {
    const m = l.match(/^(\d+)\.\s+(.+)$/);
    if (!m) return;
    const text = clean(m[2]);
    const colon = text.replace(/`[^`]*`/g, (x) => x.replace(/:/g, ' ')).indexOf(':');
    const subject = codes(colon > 0 ? text.slice(0, colon) : text);
    read.push({ n: +m[1], text: text, about: subject, paths: codes(text) });
  });

  // 4. How things flow: **a. Boot.** sentences...
  const flows = [];
  need('4', 'How things flow').forEach((l) => {
    const m = l.match(/^\*\*([a-z])\. ([^*]+?)\.\*\*\s*(.+)$/);
    if (!m) return;
    flows.push({ key: m[1], title: m[2].trim(), says: sentences(clean(m[3])).map((s) => ({ text: s, paths: codes(s) })) });
  });

  // 6. Recipes: **Title.** then a numbered list or one paragraph.
  const recipes = [];
  let r = null;
  need('6', 'Recipes').forEach((l) => {
    const m = l.match(/^\*\*([^*]+?)\.\*\*\s*(.*)$/);
    if (m) {
      r = { title: m[1].trim(), steps: [] };
      recipes.push(r);
      if (m[2].trim()) sentences(clean(m[2])).forEach((s) => r.steps.push({ text: s, paths: codes(s) }));
      return;
    }
    const n = l.match(/^\d+\.\s+(.+)$/);
    if (n && r) r.steps.push({ text: clean(n[1]), paths: codes(n[1]) });
    else if (/^\S/.test(l) && r && r.steps.length) r = null; // "More detail: ..." ends the recipes
  });

  // 8. Where to look when...: | symptom | look at |
  const fixes = [];
  need('8', 'Where to look when').forEach((l) => {
    if (!/^\s*\|/.test(l) || /^\s*\|\s*-/.test(l)) return;
    const c = cells(l);
    if (c.length < 2 || c[0] === 'Symptom') return;
    fixes.push({ when: clean(c[0]), look: clean(c[1]), paths: codes(c[1]) });
  });

  if (!folders.length || !read.length || !flows.length || !fixes.length || !recipes.length) throw new Error('docs/CODE-MAP.md: a section came out empty');
  return { src: 'docs/CODE-MAP.md', folders: folders, read: read, flows: flows, fixes: fixes, recipes: recipes };
}

/* ---------- matching a part's files ---------- */

function base(f) { return f.slice(f.lastIndexOf('/') + 1); }
// How a code-map path names a repo file: 3 exact, 2 a pattern like app/widgets/<id>.js, 1 a folder, 0 not.
function names(p, f) {
  if (p === f) return 3;
  if (p.indexOf('/') < 0) return base(f) === p ? 3 : 0;
  if (/</.test(p)) return (/test\.js$/.test(f) && !/test/.test(p)) ? 0 : new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[^/]+') + '$').test(f) ? 2 : 0;
  if (/\/$/.test(p)) return f.indexOf(p) === 0 ? 1 : 0;
  return 0;
}
function ownFiles(n) { return (n.files || []).map((f) => f.replace(/^\(PR \d+\)\s*/, '')).filter((f) => f && !/\s/.test(f)); }
function filesOf(n) {
  const own = ownFiles(n);
  if (own.length || !(n.children || []).length) return { files: own, own: true };
  const all = [];
  (function walk(list) { list.forEach((c) => { ownFiles(c).forEach((f) => { if (all.indexOf(f) < 0) all.push(f); }); walk(c.children || []); }); })(n.children);
  return { files: all, own: false };
}

function folderOf(f, M) { // the code-map folder row a file sits in (the longest match)
  let best = -1, len = -1;
  M.folders.forEach((d, i) => { if (names(d.path, f) && d.path.length > len) { best = i; len = d.path.length; } });
  return best;
}

function forPart(n, M, top) {
  const got = filesOf(n), files = got.files;
  if (!files.length) return null;
  if (top && !got.own) return forGroup(files, M);
  const exact = (list, f) => list.some((p) => names(p, f) === 3);
  const readOf = (f) => { for (let i = 0; i < M.read.length; i++) if (exact(M.read[i].about, f)) return i; return -1; };
  const flowsOf = (f) => {
    const out = [];
    M.flows.forEach((fl, i) => fl.says.forEach((s, j) => { if (exact(s.paths, f) && !out.some((o) => o[0] === i)) out.push([i, j]); }));
    return out;
  };

  // Start at the part's main file (its first), with its step in the reading order when it has one.
  const start = { path: files[0], read: readOf(files[0]) };
  start.folder = folderOf(start.path, M);

  const list = [];
  files.forEach((f) => {
    if (f === start.path) return;
    const i = readOf(f), fl = flowsOf(f);
    if (i >= 0) list.push({ path: f, read: i, also: fl.map((x) => x[0]) });
    else if (fl.length) list.push({ path: f, flow: fl[0], also: fl.slice(1).map((x) => x[0]) });
  });
  list.sort((a, b) => (a.read >= 0 ? a.read : 99) - (b.read >= 0 ? b.read : 99));
  const startFlows = flowsOf(start.path);

  const fixes = [], code = files.filter((f) => !/\.md$/.test(f)); // a shared doc is no clue to what broke
  M.fixes.forEach((x, i) => { if (code.some((f) => x.paths.some((p) => names(p, f)))) fixes.push(i); });

  // A recipe for adding one like it: the recipe's subject (the first path it names) is a
  // pattern like app/widgets/<id>.js that the main file fits, and the file is not one the
  // recipes name outright (pi/server.js is where Pi data is wired in, not a new one).
  // attach() then keeps it only on the part that owns the file (see keepRecipes).
  let recipe = null;
  if (got.own) M.recipes.forEach((rc, i) => {
    const subject = (rc.steps[0] && rc.steps[0].paths[0]) || '';
    const named = M.recipes.some((r2) => r2.steps.some((s) => s.paths.some((q) => names(q, files[0]) === 3)));
    if (!recipe && /</.test(subject) && names(subject, files[0]) === 2 && !named) recipe = { i: i };
  });

  if (start.read < 0 && start.folder < 0 && !startFlows.length && !list.length && !fixes.length && !recipe) return null;
  const out = { start: start };
  if (start.read < 0 && startFlows.length) out.start.flow = startFlows[0];
  if (list.length) out.files = list.slice(0, MAX_FILES).map((x) => { if (!x.also.length) delete x.also; return x; });
  if (list.length > MAX_FILES) out.more = list.length - MAX_FILES;
  if (fixes.length) out.fixes = fixes.slice(0, MAX_FIXES);
  if (recipe) out.recipe = recipe;
  return out;
}

// A top-level group: the folders most of its parts live in, and its steps of the reading order.
function forGroup(files, M) {
  const support = (i) => (/^(dev|docs)\/$/.test(M.folders[i].path) ? 1 : 0); // tests and docs after the code
  const count = {};
  files.forEach((f) => { const i = folderOf(f, M); if (i >= 0) count[i] = (count[i] || 0) + 1; });
  const ids = Object.keys(count).map(Number).filter((i) => count[i] >= files.length * 0.15).sort((a, b) => support(a) - support(b) || count[b] - count[a] || a - b).slice(0, 3);
  // The steps of the reading order that are about files in this group.
  const read = [];
  M.read.forEach((r, i) => { if (r.about.some((p) => files.some((f) => names(p, f) === 3 && ids.indexOf(folderOf(f, M)) >= 0))) read.push(i); });
  if (!ids.length && !read.length) return null;
  const out = { folders: ids };
  if (read.length) out.read = read;
  return out;
}

// A recipe for adding one like it belongs on the part that owns its main file, not on
// every part that mentions it: the part must sit in the top-level group that holds most
// of the recipe's folder (app/widgets/ -> The TV, pi/ -> The Raspberry Pi), and be the
// shallowest part with that main file (the To-do widget, not its lead-times feature).
function keepRecipes(parts, where, M) {
  const owner = {}; // folder row -> top-level group with most files in it
  M.folders.forEach((d, i) => {
    const count = {};
    Object.keys(where).forEach((id) => { const w = where[id]; if (w.main && folderOf(w.main, M) === i) count[w.top] = (count[w.top] || 0) + 1; });
    owner[i] = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  });
  const best = {};
  Object.keys(parts).forEach((id) => {
    const e = parts[id], w = where[id];
    if (!e.recipe) return;
    const subject = M.recipes[e.recipe.i].steps[0].paths[0];
    if (owner[folderOf(subject.replace(/<[^>]+>/g, 'x'), M)] !== w.top) { delete e.recipe; return; }
    const b = best[w.main];
    if (!b || w.depth < where[b].depth) best[w.main] = id;
  });
  Object.keys(parts).forEach((id) => { const e = parts[id]; if (e.recipe && best[where[id].main] !== id) delete e.recipe; });
}

function attach(data, md) {
  const M = parse(md);
  const parts = {};
  const where = {};
  (function walk(list, top, depth) {
    list.forEach((n) => {
      const e = forPart(n, M, !top);
      if (e) parts[n.id] = e;
      where[n.id] = { top: top || n.id, depth: depth, main: filesOf(n).files[0] };
      walk(n.children || [], top || n.id, depth + 1);
    });
  })(data.tree || [], null, 0);
  keepRecipes(parts, where, M);
  // The pages only need the words; the paths were for matching.
  M.read.forEach((r) => { delete r.about; delete r.paths; });
  M.flows.forEach((f) => f.says.forEach((s) => { delete s.paths; }));
  M.fixes.forEach((x) => { delete x.paths; });
  M.recipes.forEach((r) => r.steps.forEach((s) => { delete s.paths; }));
  const out = {};
  Object.keys(data).forEach((k) => { out[k] = data[k]; });
  M.parts = parts;
  out.codemap = M;
  return out;
}

module.exports = { parse: parse, attach: attach, names: names };
