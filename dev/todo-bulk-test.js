/*
 * dev/todo-bulk.sh in --dry-run: node dev/todo-bulk-test.js
 * No network. Checks the command files it would send.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'todo-bulk.sh');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function run(input, flags, signal) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tbt-'));
  fs.rmSync(out, { recursive: true });
  const args = ['--dry-run'].concat(signal ? [] : ['--no-signal'], flags || [], ['-']);
  const r = spawnSync('bash', [SCRIPT].concat(args), { input, encoding: 'utf8', env: Object.assign({}, process.env, { TODO_BULK_OUT: out }) });
  let files = [];
  if (fs.existsSync(out)) {
    files = fs.readdirSync(out).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')));
    fs.rmSync(out, { recursive: true });
  }
  files.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, files };
}

check('JSON objects: reversed, increasing created, args kept', () => {
  const r = run(JSON.stringify([{ title: 'A', level: 'must', due: '2026-12-01', lead: 3, notes: 'n' }, { title: 'B' }, { title: 'C', section: 'next' }]));
  assert(r.code === 0, 'exit ' + r.code + ' ' + r.stderr);
  assert(r.files.length === 3, 'files ' + r.files.length);
  assert(r.files.map((f) => f.args.title).join() === 'C,B,A', 'order ' + r.files.map((f) => f.args.title));
  const t = r.files.map((f) => Date.parse(f.created));
  assert(t[1] - t[0] === 1 && t[2] - t[1] === 1, 'not 1 ms apart: ' + t);
  assert(/\.\d{3}Z$/.test(r.files[0].created), 'no ms in ' + r.files[0].created);
  assert(t[2] < Date.now(), 'created in the future');
  const a = r.files[2].args;
  assert(a.level === 'must' && a.due === '2026-12-01' && a.lead === 3 && a.notes === 'n', JSON.stringify(a));
  r.files.forEach((f) => { assert(f.cmd === 'todo.add', 'cmd'); assert(/^[A-Za-z0-9_-]{6,64}$/.test(f.id), 'id ' + f.id); });
  assert(new Set(r.files.map((f) => f.id)).size === 3, 'ids not unique');
});

check('JSON strings with --level and --due defaults; own values win', () => {
  const r = run(JSON.stringify(['One', { title: 'Two', level: 'passive' }, { title: 'Three', due: '2027-01-02' }]), ['--level', 'optional', '--due', '2026-12-24']);
  assert(r.code === 0, r.stderr);
  const by = {};
  r.files.forEach((f) => { by[f.args.title] = f.args; });
  assert(by.One.level === 'optional' && by.One.due === '2026-12-24', JSON.stringify(by.One));
  assert(by.Two.level === 'passive' && by.Two.due === '2026-12-24', JSON.stringify(by.Two));
  assert(by.Three.level === 'optional' && by.Three.due === '2027-01-02', JSON.stringify(by.Three));
});

check('text lines: blanks and # skipped, order reversed', () => {
  const r = run('# my list\nMilk\n\n  Eggs  \n#skip\nBread\n');
  assert(r.code === 0, r.stderr);
  assert(r.files.map((f) => f.args.title).join('|') === 'Bread|Eggs|Milk', r.files.map((f) => f.args.title).join('|'));
});

check('working signal: say file comes first; --no-signal leaves it out', () => {
  const r = run('A\nB\n', [], true);
  assert(r.files.length === 3 && r.files[0].cmd === 'say' && r.files[0].args.text === 'hub:working todo 90', JSON.stringify(r.files[0]));
  assert(run('A\nB\n').files.every((f) => f.cmd === 'todo.add'), 'say present');
});

const bad = {
  'title over 80 characters': JSON.stringify(['ok', { title: 'x'.repeat(81) }]),
  'missing title': JSON.stringify([{ level: 'must' }]),
  'bad level': JSON.stringify([{ title: 'a', level: 'urgent' }]),
  'bad due': JSON.stringify([{ title: 'a', due: '2026-02-30' }]),
  'bad lead': JSON.stringify([{ title: 'a', lead: 31 }]),
  'long notes': JSON.stringify([{ title: 'a', notes: 'n'.repeat(301) }]),
  'unknown key': JSON.stringify([{ title: 'a', color: 'red' }]),
  'more than 40 items': JSON.stringify(Array.from({ length: 41 }, (_, i) => 'item ' + i)),
  'empty input': '\n# nothing\n'
};
Object.keys(bad).forEach((k) => {
  check('rejected, nothing written: ' + k, () => {
    const r = run(bad[k]);
    assert(r.code !== 0, 'exit 0');
    assert(r.files.length === 0, r.files.length + ' files written');
    assert(/nothing was sent/.test(r.stderr), 'stderr ' + r.stderr);
  });
});
check('bad entry is named', () => {
  const r = run(JSON.stringify(['fine', { title: 'a', level: 'urgent' }]));
  assert(/entry 2: level/.test(r.stderr), r.stderr);
});
check('bad --level flag rejected', () => {
  const r = run('A\n', ['--level', 'huge']);
  assert(r.code !== 0 && r.files.length === 0, 'accepted');
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
