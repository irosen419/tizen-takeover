'use strict';
/*
 * Stamp the hub's version. PRs do NOT bump it: the version is a label set once,
 * right before a PR is merged, so open PRs never fight over the same lines.
 *
 *   node dev/bump.js patch|minor|major     next version, counted from origin/main
 *   node dev/bump.js 0.40.0                an exact version
 *   node dev/bump.js --sync                make every place match package.json
 *   node dev/bump.js --check               list the places and say if they agree
 *
 * Add --from=<ref> to count from another ref (default origin/main, falling back
 * to the version in this checkout). Add --dry to print without writing.
 *
 * The places (kept in step by this script, checked by dev/version-test.js):
 *   package.json, package-lock.json (two spots), app/hub.js (BUILD),
 *   service.js (VERSION), README.md (the About-panel example line).
 * Version-looking text elsewhere (README history, tile-sizes notes, test names
 * such as "v0.39.0") is history and is never touched.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.some((a) => a === '--' + n);
const opt = (n) => { const a = args.find((x) => x.indexOf('--' + n + '=') === 0); return a ? a.slice(n.length + 3) : ''; };
const positional = args.filter((a) => a.indexOf('--') !== 0)[0] || '';
const DRY = flag('dry');

const abs = (f) => path.join(root, f);
const read = (f) => fs.readFileSync(abs(f), 'utf8');

// Each place: how to read its version, and how to write a new one.
const PLACES = [
  { file: 'package.json', re: /("version":\s*")([^"]+)(")/ },
  { file: 'package-lock.json', re: /("version":\s*")([^"]+)(")/, all: 2 },
  { file: 'app/hub.js', re: /(var BUILD = 'v)([^']+)(')/ },
  { file: 'service.js', re: /(var VERSION = ')([^']+)(')/ },
  { file: 'README.md', re: /(\*\*Version\*\* \(for example `v)([^ `]+)( \(newest\)`)/ },
];

function current(p) {
  const m = read(p.file).match(p.re);
  return m ? m[2] : null;
}

function writeAll(version) {
  PLACES.forEach((p) => {
    let text = read(p.file);
    let n = 0;
    const re = new RegExp(p.re.source, 'g');
    text = text.replace(re, (all, a, v, c) => {
      n += 1;
      // package-lock.json: only the first two "version" keys are the project's own.
      if (p.all && n > p.all) return all;
      return a + version + c;
    });
    if (!n) throw new Error('could not find the version in ' + p.file);
    if (!DRY) fs.writeFileSync(abs(p.file), text);
  });
}

function mainVersion() {
  const ref = opt('from') || 'origin/main';
  try {
    return JSON.parse(cp.execSync('git show ' + ref + ':package.json', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString()).version;
  } catch (e) {
    return JSON.parse(read('package.json')).version;
  }
}

const SEMVER = /^\d+\.\d+\.\d+$/;

if (flag('check') || (!positional && !flag('sync'))) {
  const base = JSON.parse(read('package.json')).version;
  let bad = 0;
  PLACES.forEach((p) => {
    const v = current(p);
    const ok = v === base;
    if (!ok) bad += 1;
    console.log((ok ? 'ok   ' : 'FAIL ') + p.file + ' ' + v);
  });
  if (bad) { console.log(bad + ' place(s) differ from package.json. Fix: node dev/bump.js --sync'); process.exit(1); }
  console.log('version ' + base + ' agrees everywhere');
  process.exit(0);
}

let next;
if (flag('sync')) {
  next = JSON.parse(read('package.json')).version;
} else if (SEMVER.test(positional)) {
  next = positional;
} else if (/^(patch|minor|major)$/.test(positional)) {
  const v = mainVersion().split('.').map(Number);
  if (positional === 'major') { v[0] += 1; v[1] = 0; v[2] = 0; }
  else if (positional === 'minor') { v[1] += 1; v[2] = 0; }
  else { v[2] += 1; }
  next = v.join('.');
} else {
  console.error('Usage: node dev/bump.js patch|minor|major|x.y.z|--sync|--check [--from=ref] [--dry]');
  process.exit(2);
}

writeAll(next);
console.log((DRY ? 'would stamp ' : 'stamped ') + next + ' in ' + PLACES.map((p) => p.file).join(', '));
