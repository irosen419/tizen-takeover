'use strict';
/*
 * Run only the test suites a change can affect, and print one line per suite.
 *
 *   npm test                      suites affected by this branch (vs origin/main) and uncommitted files
 *   npm test -- --list            show which suites would run, run nothing
 *   npm test -- --failed          run again only the suites that failed last time
 *   npm test -- --full            every suite (slow: the full set takes 45+ minutes)
 *   npm test -- --base=<ref>      compare against another ref
 *   npm test -- foo bar           run dev/foo-test.js and dev/bar-test.js (and pi/foo-test.js when it exists)
 *
 * Suites run one after another (each browser suite uses fixed ports). A failing
 * suite prints its last lines; a passing one prints a single "ok" line.
 * How a change maps to suites, in order:
 *   1. a changed test file runs itself;
 *   2. a changed file whose name matches a suite (app/widgets/soundctl.js ->
 *      dev/soundctl-test.js, pi/echo.js -> pi/echo-test.js);
 *   3. any suite whose source mentions the changed file (dev/awws-harness.js);
 *   4. the RULES below for shared files (hub.js, config.js, studio, ...);
 *   5. an unknown file under app/ runs the CORE set.
 * Plain docs and images (*.md, *.png, *.jpg) run nothing, except docs/CODE-MAP.md
 * (the Architecture page is built from it: codemap and architecture suites).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.indexOf('--' + n) >= 0;
const opt = (n) => { const a = args.find((x) => x.indexOf('--' + n + '=') === 0); return a ? a.slice(n.length + 3) : ''; };
const names = args.filter((a) => a.indexOf('--') !== 0);
const FAILED_FILE = path.join(os.tmpdir(), 'hub-run-affected-failed-' + require('crypto').createHash('md5').update(root).digest('hex').slice(0, 8) + '.json');
const TIMEOUT_MS = 20 * 60 * 1000;

function listSuites() {
  const out = [];
  ['dev', 'pi'].forEach((d) => {
    fs.readdirSync(path.join(root, d)).forEach((f) => {
      if (/-test\.js$/.test(f) || (d === 'pi' && f === 'test.js')) out.push(d + '/' + f);
    });
  });
  return out.sort();
}
const ALL = listSuites();

// The fast, broad set for changes to the shared page files.
const CORE = ['dev/version-test.js', 'dev/layout-test.js', 'dev/live-test.js', 'dev/update-test.js', 'dev/clock-test.js',
  'dev/i18n-es-test.js', 'dev/i18n-dyn-test.js', 'dev/styles-test.js', 'dev/headers-test.js', 'dev/scripts-test.js'];

// [pattern on the changed path, suites]. Patterns are tested in order; all that match add suites.
const RULES = [
  [/^app\/(hub\.js|hub\.html|index\.html|config\.js|style\.css|theme\.css|live\.js|update\.js|icons\.js|logos\.js)$/, CORE],
  [/^app\/(i18n|i18n-dyn)\.js$/, ['dev/i18n-es-test.js', 'dev/i18n-dyn-test.js', 'dev/i18n-dyn-wire-test.js', 'dev/i18n-es-awws-test.js', 'dev/money-i18n-test.js', 'dev/layout-test.js']],
  [/^app\/motion\.js$/, ['dev/motion-test.js', 'dev/layout-test.js']],
  [/^app\/(clay|clay\/.*)\.js$|^app\/clay\//, ['dev/clay-test.js']],
  [/^app\/agents(\.js|\.css|\/)/, ['dev/agents-test.js']],
  [/^app\/backgrounds\//, ['dev/backgrounds-test.js']],
  [/^app\/budget-lab-math\.js$/, ['dev/budget-lab-math-test.js']],
  [/^app\/widgets\/(budget|budget-lab)\.(js|css)$/, ['dev/budget-receipt-test.js', 'dev/budget-lab-math-test.js', 'dev/money-test.js']],
  [/^app\/widgets\/(today|clock)\.(js|css)$/, ['dev/clock-test.js']],
  [/^app\/widgets\/(nowplaying|nowplaying-viz)\.(js|css)$/, ['dev/nowplaying-test.js', 'dev/nowplaying-chip-test.js']],
  [/^app\/widgets\/(soundctl|ambience)\.(js|css)$/, ['dev/soundctl-test.js', 'dev/ambience-test.js']],
  [/^app\/widgets\/(architecture|architecture-data)\.(js|css)$|^studio\/architecture\//, ['dev/architecture-test.js', 'dev/architecture-tv-test.js', 'dev/studio-sync-test.js']],
  [/^app\/widgets\/(awws)\.(js|css)$|^pi\/awws\.js$/, ['dev/awws-test.js', 'dev/i18n-es-awws-test.js', 'pi/awws-test.js']],
  [/^app\/widgets\/(todo)\.(js|css)$/, ['dev/todo-levels-test.js', 'dev/todo-completed-test.js', 'dev/todo-bulk-test.js']],
  [/^app\/widgets\/(entertainment|shows|planned|linktest)\.(js|css)$/, ['dev/shows-test.js']],
  [/^app\/widgets\/(weather)\.(js|css)$/, ['dev/weather-scene-test.js']],
  [/^app\/widgets\/(sunpath)\.(js|css)$/, ['dev/sunpath-test.js']],
  [/^app\/widgets\/wotd\.(js|css)$|^app\/wotd-data\.js$/, ['dev/wotd-test.js']],
  [/^app\/widgets\/investments\.(js|css)$/, ['dev/investments-test.js']],
  [/^studio\//, ['dev/studio-sync-test.js', 'dev/architecture-test.js']],
  [/^(package\.json|package-lock\.json|service\.js)$/, ['dev/version-test.js', 'dev/update-test.js', 'dev/live-test.js']],
  [/^pi\/(server|hubctl|logscrub|mailbox)\.js$/, ['pi/test.js', 'pi/mailbox-test.js']],
  [/^pi\/test\.js$/, ['pi/test.js']],
  [/^pi\/(fixtures|hub)\//, ['pi/test.js']],
  [/^dev\/(preview|mock-[a-z]+|.*-harness|.*-sample|samples\/.*)\.js(on)?$/, []],
];
const DOCS = /\.(md|png|jpe?g|gif|mp4|wav|mp3|txt)$|^(docs|art)\//;

function sh(cmd) {
  try { return cp.execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean); }
  catch (e) { return []; }
}

function changedFiles() {
  const base = opt('base') || 'origin/main';
  const hasBase = sh('git rev-parse --verify ' + base).length;
  const files = {};
  (hasBase ? sh('git diff --name-only ' + base + '...HEAD') : sh('git diff --name-only HEAD~1')).forEach((f) => { files[f] = 1; });
  sh('git diff --name-only HEAD').forEach((f) => { files[f] = 1; });
  sh('git ls-files --others --exclude-standard').forEach((f) => { files[f] = 1; });
  return Object.keys(files);
}

const sourceCache = {};
function suiteMentions(suite, rel) {
  if (!sourceCache[suite]) sourceCache[suite] = fs.readFileSync(path.join(root, suite), 'utf8');
  const base = path.basename(rel);
  const src = sourceCache[suite];
  if (src.indexOf(rel) >= 0) return true;
  if (/^(hub|config|style|theme)\./.test(base)) return false;
  if (base.length > 8 && src.indexOf(base) >= 0) return true;
  // require('./awws-harness') and require('./version') leave the .js off.
  const stem = base.replace(/\.js$/, '');
  return /\.js$/.test(base) && (src.indexOf("'./" + stem + "'") >= 0 || src.indexOf("'../" + path.dirname(rel) + "/" + stem + "'") >= 0 || src.indexOf("'../" + rel.replace(/\.js$/, '') + "'") >= 0);
}

function pick(files) {
  const chosen = {};
  const why = {};
  const add = (s, f) => { if (ALL.indexOf(s) >= 0) { chosen[s] = 1; why[s] = why[s] || []; if (why[s].indexOf(f) < 0) why[s].push(f); } };
  files.forEach((f) => {
    if (ALL.indexOf(f) >= 0) add(f, f);
    const stem = path.basename(f).replace(/\.[a-z]+$/, '');
    const dir = f.indexOf('pi/') === 0 ? 'pi' : 'dev';
    if (/^(app|pi)\//.test(f) && !DOCS.test(f)) {
      add(dir + '/' + stem + '-test.js', f);
      if (f.indexOf('app/') === 0) ALL.filter((s) => s.indexOf('dev/' + stem + '-') === 0).forEach((s) => add(s, f));
    }
    // The code map is a doc, but the Architecture page is built from it.
    if (f === 'docs/CODE-MAP.md') ['dev/codemap-test.js', 'dev/architecture-test.js'].forEach((x) => add(x, f));
    if (/^studio\/codemap\.js$/.test(f)) ['dev/codemap-test.js', 'dev/architecture-test.js', 'dev/architecture-tv-test.js'].forEach((x) => add(x, f));
    if (DOCS.test(f)) return;
    ALL.forEach((s) => { if (s !== f && suiteMentions(s, f)) add(s, f); });
    let ruled = false;
    RULES.forEach((r) => { if (r[0].test(f)) { ruled = true; r[1].forEach((s) => add(s, f)); } });
    if (!ruled && f.indexOf('app/') === 0 && !Object.keys(why).some((s) => why[s].indexOf(f) >= 0)) CORE.forEach((s) => add(s, f));
  });
  // The version check is instant; it always runs when anything runs.
  if (Object.keys(chosen).length) add('dev/version-test.js', 'always');
  return { suites: Object.keys(chosen).sort(), why: why };
}

function run(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = cp.spawn(process.execPath, [suite], { cwd: root, env: process.env });
    let out = '';
    const grab = (d) => { out += d; if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    const timer = setTimeout(() => { out += '\nTIMEOUT after ' + TIMEOUT_MS / 60000 + ' minutes'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ suite: suite, code: code, secs: Math.round((Date.now() - t0) / 1000), out: out }); });
  });
}

(async () => {
  let suites;
  if (flag('full')) suites = ALL.slice();
  else if (flag('failed')) {
    try { suites = JSON.parse(fs.readFileSync(FAILED_FILE, 'utf8')); } catch (e) { suites = []; }
    if (!suites.length) { console.log('No failed suites recorded. Run: npm test'); return; }
  } else if (names.length) {
    suites = [];
    names.forEach((n) => {
      n = n.replace(/\.js$/, '').replace(/-test$/, '');
      const hits = ALL.filter((s) => s === n + '-test.js' || s === n + '.js' || s === 'dev/' + n + '-test.js' || s === 'pi/' + n + '-test.js');
      (hits.length ? hits : [n + '-test.js']).forEach((s) => { if (suites.indexOf(s) < 0) suites.push(s); });
    });
  } else {
    const files = changedFiles();
    const p = pick(files);
    suites = p.suites;
    console.log(files.length + ' changed file(s) -> ' + suites.length + ' suite(s)' + (flag('list') ? ':' : ''));
    if (flag('list')) suites.forEach((s) => console.log('  ' + s + '   (' + p.why[s].slice(0, 3).join(', ') + ')'));
    if (!suites.length) { console.log('Nothing to run (docs and images only). Use --full to run everything.'); return; }
  }
  if (flag('list')) { if (flag('full') || flag('failed') || names.length) suites.forEach((s) => console.log('  ' + s)); return; }

  const failed = [];
  const t0 = Date.now();
  for (const s of suites) {
    if (!fs.existsSync(path.join(root, s))) { console.log('FAIL ' + s + ' (no such suite)'); failed.push(s); continue; }
    const r = await run(s);
    const summary = (r.out.trim().split('\n').pop() || '').slice(0, 100);
    if (r.code === 0) console.log('ok   ' + s + '  ' + r.secs + 's  ' + summary);
    else {
      failed.push(s);
      console.log('FAIL ' + s + '  ' + r.secs + 's  (exit ' + r.code + ')');
      const lines = r.out.trim().split('\n');
      const bad = lines.filter((l) => /^(FAIL|not ok|Error|AssertionError)|FAIL/.test(l)).slice(0, 8);
      (bad.length ? bad : lines.slice(-12)).forEach((l) => console.log('     ' + l.slice(0, 200)));
    }
  }
  try { fs.writeFileSync(FAILED_FILE, JSON.stringify(failed)); } catch (e) { /* ignore */ }
  const mins = Math.round((Date.now() - t0) / 6000) / 10;
  if (failed.length) {
    console.log(failed.length + ' of ' + suites.length + ' failed in ' + mins + ' min. After a fix run only those: npm test -- --failed');
    process.exit(1);
  }
  console.log('all ' + suites.length + ' suite(s) passed in ' + mins + ' min');
})();
