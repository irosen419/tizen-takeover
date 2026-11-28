'use strict';
/*
 * Tests for dev/moods-ha.js (the Home Assistant YAML for Moods, plan section 5).
 * No HA, no network. Run: node dev/moods-ha-test.js
 *
 * Checks: every exposed mood once (dashboards, package scripts, test script),
 * hidden moods never; ids unique and wall_mood_*; no tabs, 2-space indentation;
 * no address or light entity id (only HUB_BASE), only !secret hub_lights_auth;
 * stage A calls only rest_command.hub_command; no rest_command: block anywhere;
 * the CLI writes the files; YAML parses (PyYAML, when python3 has it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const ha = require('./moods-ha.js');
const { catalog } = require('../pi/moods/catalog.js').load();

let fails = 0, passes = 0;
function check(ok, what) {
  if (ok) { passes++; return; }
  fails++;
  console.log('FAIL ' + what);
}

const dashA = ha.dashboardYaml(catalog, { stage: 'a' });
const dashB = ha.dashboardYaml(catalog, { stage: 'b' });
const pkg = ha.packageYaml(catalog, {});
const sh = ha.testScript(catalog);
const yamls = { 'dashboard a': dashA, 'dashboard b': dashB, package: pkg };
const all = Object.assign({ 'test script': sh }, yamls);

const exposed = catalog.moods.filter((m) => !m.hidden && m.ha && m.ha.expose === true);
const hidden = catalog.moods.filter((m) => m.hidden || !m.ha || m.ha.expose !== true);
check(exposed.length === 22, '22 exposed moods (got ' + exposed.length + ')');
check(ha.exposed(catalog).length === exposed.length, 'exposed() agrees with the catalog');
const count = (text, s) => text.split(s).length - 1;

// Every exposed mood once, hidden never.
['dashboard a', 'dashboard b'].forEach((k) => {
  exposed.forEach((m) => {
    check(count(yamls[k], 'data: {"id":"' + m.id + '"}') === 1, k + ': ' + m.id + ' once');
    check(yamls[k].indexOf('icon: ' + m.ha.icon) >= 0, k + ': icon of ' + m.id);
    check(yamls[k].indexOf('name: ' + JSON.stringify(m.name)) >= 0, k + ': name of ' + m.id);
  });
  hidden.forEach((m) => check(yamls[k].indexOf('"' + m.id + '"') < 0, k + ': hidden ' + m.id + ' absent'));
  check(count(yamls[k], 'data: {"id":"off"}') === 1, k + ': Off once');
  check(count(yamls[k], 'data: {"event":"thunder"}') === 1, k + ': Thunder once');
  ha.BRIGHTNESS.forEach((b) => check(count(yamls[k], 'data: {"bri":' + b + '}') === 1, k + ': brightness ' + b));
  check(count(yamls[k], '- type: button') === 22 + 2 + 5, k + ': 29 buttons');
  check(/heading: "Whole wall"/.test(yamls[k]) && /heading: "Vases"/.test(yamls[k]), k + ': two groups');
  // Group order: each mood under its own group heading.
  const wallAt = yamls[k].indexOf('heading: "Whole wall"'), vaseAt = yamls[k].indexOf('heading: "Vases"');
  exposed.forEach((m) => {
    const at = yamls[k].indexOf('data: {"id":"' + m.id + '"}');
    const ok = m.group === 'wall' ? (at > wallAt && (vaseAt < wallAt || at < vaseAt)) : (at > vaseAt && (wallAt < vaseAt || at < wallAt));
    check(ok, k + ': ' + m.id + ' under its group');
  });
});
exposed.forEach((m) => {
  const s = 'wall_mood_' + m.id.replace(/-/g, '_');
  check(count(pkg, '\n  ' + s + ':\n') === 1, 'package: script ' + s + ' once');
  check(count(pkg, 'data: {"id":"' + m.id + '"}') === 1, 'package: ' + m.id + ' command once');
  check(count(pkg, ': "' + m.id.replace(/-/g, '_') + '"\n') === 1, 'package: select maps to ' + m.id);
  check(new RegExp('\\b' + m.id.replace(/-/g, '\\-') + '\\b').test(sh.split('MOODS="')[1].split('"')[0]), 'test script: ' + m.id);
});
check(count(pkg, '\n  wall_mood_off:\n') === 1, 'package: script wall_mood_off');
hidden.forEach((m) => {
  check(pkg.indexOf('"' + m.id + '"') < 0 && pkg.indexOf('wall_mood_' + m.id.replace(/-/g, '_') + ':') < 0, 'package: hidden ' + m.id + ' absent');
  check(sh.indexOf(m.id) < 0, 'test script: hidden ' + m.id + ' absent');
});
check(sh.split('MOODS="')[1].split('"')[0].trim().split(/\s+/).length === exposed.length, 'test script: exactly the exposed moods');

// Ids unique and wall_mood_*.
const ids = [];
(pkg.match(/^\s+unique_id: (\S+)$/gm) || []).forEach((l) => ids.push(l.trim().split(' ')[1]));
(pkg.match(/^  (\w+):$/gm) || []).forEach((l) => ids.push(l.trim().slice(0, -1)));
check(ids.length === 2 + exposed.length + 1, 'package: ' + ids.length + ' ids');
check(new Set(ids).size === ids.length, 'package: ids unique');
ids.forEach((id) => check(/^wall_mood(_[a-z0-9_]+)?$/.test(id), 'id ' + id + ' is wall_mood_*'));
check(!/scene\.mood_|\bmood_[a-z]/.test(pkg.replace(/wall_mood_/g, '')), 'package: clear of the existing mood_* ids');
check(/name: "Wall mood"/.test(pkg) && /unique_id: wall_mood_select/.test(pkg), 'package: select "Wall mood"');
check(/resource: HUB_BASE\/api\/moods\/now/.test(pkg) && /scan_interval: 10\n/.test(pkg), 'package: sensor from /api/moods/now every 10 s');
check(/json_attributes: \[name, bri, path, stale\]/.test(pkg), 'package: sensor attributes');
check(/entity_id: "script\.wall_mood_\{\{ ids\[option\] \}\}"/.test(pkg), 'package: select_option runs the script');

// Formatting: no tabs, 2-space indentation, children at most one level deeper.
Object.keys(yamls).forEach((k) => {
  const lines = yamls[k].split('\n');
  check(yamls[k].indexOf('\t') < 0, k + ': no tabs');
  let prev = 0;
  lines.forEach((l, i) => {
    if (!l.trim() || /^\s*#/.test(l)) return;
    const ind = l.match(/^ */)[0].length;
    check(ind % 2 === 0, k + ' line ' + (i + 1) + ': even indentation');
    check(ind <= prev + 2, k + ' line ' + (i + 1) + ': at most one level deeper');
    check(!/\s$/.test(l), k + ' line ' + (i + 1) + ': no trailing space');
    prev = /^\s*- /.test(l) ? ind + 2 : ind;
  });
});
check(sh.indexOf('\t') < 0, 'test script: no tabs');

// No addresses, entity ids of lights, or tokens.
Object.keys(all).forEach((k) => {
  const t = all[k];
  check(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(t), k + ': no IP address');
  check(!/https?:\/\//.test(t) && !/localhost|:8123|\.local\b|ts\.net/.test(t), k + ': no URL or host');
  check(!/\b(light|switch|scene|media_player|input_select|input_boolean|automation|button|number)\.[a-z0-9_]+/.test(t), k + ': no other entity id');
  check(!/Bearer|token|password/i.test(t), k + ': no token');
  const secrets = t.match(/!secret \S+/g) || [];
  secrets.forEach((s) => check(s === '!secret hub_lights_auth', k + ': only !secret hub_lights_auth (' + s + ')'));
  check(!/^\s*rest_command:/m.test(t), k + ': no rest_command: block');
  check(!/^\s*hub_command:/m.test(t), k + ': never redefines hub_command');
});
check(count(pkg, '!secret hub_lights_auth') === 1, 'package: one secret');
check(dashA.indexOf('!secret') < 0 && dashA.indexOf('HUB_BASE') < 0, 'dashboard a: no secret, no address');

// Stage A: only rest_command.hub_command, no sensor or select.
const actions = (dashA.match(/perform_action: \S+/g) || []).map((s) => s.split(' ')[1]);
check(actions.length === 29 && actions.every((a) => a === 'rest_command.hub_command'), 'dashboard a: only rest_command.hub_command');
check(!/(sensor|select|script)\.wall_mood/.test(dashA), 'dashboard a: needs nothing from stage B');
check(/sensor\.wall_mood/.test(dashB) && /entity: select\.wall_mood/.test(dashB), 'dashboard b: Now line and select');
check(dashA.indexOf('type: sections') >= 0 && dashA.indexOf('title: "Wall moods"') >= 0, 'dashboard a: sections view "Wall moods"');
(pkg.match(/- action: \S+/g) || []).forEach((a) => check(/rest_command\.hub_command|script\.turn_on/.test(a), 'package: action ' + a));

// Test script.
check(/^#!\/bin\/sh\n/.test(sh) && /watching/.test(sh.split('\n').slice(0, 4).join('\n')), 'test script: header says Ian must be watching');
check(/\.\/hub moods set "\$m" --no-pair/.test(sh), 'test script: --no-pair');
check(/\noff\n$/.test(sh) && /\.\/hub moods off/.test(sh) && /trap 'off/.test(sh), 'test script: ends with moods off, also on Ctrl-C');
check(/>\/dev\/null 2>&1/.test(sh), 'test script: prints only ids and ok/failed');
check(cp.spawnSync('sh', ['-n'], { input: sh }).status === 0, 'test script: sh -n');

// The CLI.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moods-ha-'));
const run = (args) => cp.spawnSync(process.execPath, [path.join(root, 'dev/moods-ha.js')].concat(args), { encoding: 'utf8' });
let r = run(['--out', path.join(tmp, 'all')]);
check(r.status === 0, 'cli: all files');
['moods-dashboard.yaml', 'moods-dashboard-b.yaml', 'moods-package.yaml', 'moods-test.sh'].forEach((f) => {
  check(fs.existsSync(path.join(tmp, 'all', f)), 'cli: wrote ' + f);
});
check(fs.readFileSync(path.join(tmp, 'all', 'moods-dashboard.yaml'), 'utf8') === dashA, 'cli: dashboard is stage a');
check((fs.statSync(path.join(tmp, 'all', 'moods-test.sh')).mode & 0o111) !== 0, 'cli: test script executable');
r = run(['--out', path.join(tmp, 'a'), '--stage', 'a']);
check(r.status === 0 && fs.readdirSync(path.join(tmp, 'a')).sort().join() === 'moods-dashboard.yaml,moods-test.sh', 'cli: stage a files');
r = run(['--out', path.join(tmp, 'b'), '--stage', 'b']);
check(r.status === 0 && fs.readdirSync(path.join(tmp, 'b')).sort().join() === 'moods-dashboard-b.yaml,moods-package.yaml', 'cli: stage b files');
check(run(['--stage', 'c', '--out', tmp]).status === 2 && run([]).status === 2, 'cli: refuses bad arguments');

// A real YAML parse when python3 has PyYAML (skipped otherwise).
const py = [
  'import sys, json, yaml',
  'class L(yaml.SafeLoader): pass',
  "L.add_constructor('!secret', lambda l, n: '!secret ' + l.construct_scalar(n))",
  'out = {}',
  'for p in sys.argv[1:]:',
  '    d = yaml.load(open(p, encoding="utf-8"), Loader=L)',
  '    out[p.rsplit("/", 1)[-1]] = d',
  'print(json.dumps(out))'
].join('\n');
const files = ['moods-dashboard.yaml', 'moods-dashboard-b.yaml', 'moods-package.yaml'].map((f) => path.join(tmp, 'all', f));
const pr = cp.spawnSync('python3', ['-I', '-c', py].concat(files), { encoding: 'utf8' });
if (pr.status === 0) {
  const d = JSON.parse(pr.stdout);
  const secs = d['moods-dashboard.yaml'].views[0].sections;
  check(secs.length === 3, 'yaml: stage a has 3 sections');
  const btns = [].concat.apply([], secs.map((s) => s.cards)).filter((c) => c.type === 'button');
  check(btns.length === 29, 'yaml: 29 buttons');
  check(btns.every((b) => b.tap_action.perform_action === 'rest_command.hub_command' && b.tap_action.data.type === 'mood'), 'yaml: every button is a mood command');
  const p = d['moods-package.yaml'];
  check(p.rest[0].headers.Authorization === '!secret hub_lights_auth', 'yaml: sensor uses the secret');
  check(Object.keys(p.script).length === exposed.length + 1, 'yaml: ' + (exposed.length + 1) + ' scripts');
  check(Object.keys(p).sort().join() === 'rest,script,template', 'yaml: package has only rest, script, template');
  const sel = p.template[0].select[0];
  check(Object.keys(sel.select_option[0].variables.ids).length === exposed.length + 1, 'yaml: select maps every option');
  const opts = JSON.parse(sel.options.replace(/^\{\{\s*|\s*\}\}$/g, ''));
  check(opts.length === exposed.length + 1 && opts.every((o) => sel.select_option[0].variables.ids[o]), 'yaml: options and map agree');
  check(new Set(opts).size === opts.length, 'yaml: option names unique');
} else if (/No module named/.test(pr.stderr || '') || pr.error) {
  console.log('skip yaml parse (no python3 PyYAML)');
} else {
  check(false, 'yaml parse: ' + String(pr.stderr).split('\n').slice(-3).join(' '));
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails ? fails + ' failed, ' + passes + ' passed' : 'moods-ha: all ' + passes + ' checks passed');
process.exit(fails ? 1 : 0);
