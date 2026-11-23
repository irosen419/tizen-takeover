/*
 * Tests for the Pi's auto-pull (pi/autopull/autopull.sh). Run from the repo root:
 *
 *   node pi/autopull-test.js
 *
 * Each check makes a bare repository in a temp folder as "origin", a clone of
 * it as the Pi's checkout and another clone to push from, then runs the real
 * script with AUTOPULL_REPO, AUTOPULL_DATA and a fake AUTOPULL_RESTART_CMD
 * that writes down what it was asked to restart. Needs sh and git; nothing
 * leaves this computer. Prints one line per check and "N passed, M failed".
 */
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SCRIPT = path.join(__dirname, 'autopull', 'autopull.sh');
let passed = 0;
let failed = 0;
const tmpDirs = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     '));
  }
}

const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir()
});

function git(dir, args) {
  return cp.execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, text) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

// origin (bare), pi (the checkout the script keeps current), dev (pushes).
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-autopull-test-'));
  tmpDirs.push(root);
  const origin = path.join(root, 'origin.git');
  const dev = path.join(root, 'dev');
  const pi = path.join(root, 'pi');
  const data = path.join(root, 'data');
  const calls = path.join(root, 'calls.txt');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, dev]);
  git(dev, ['checkout', '-q', '-b', 'main']);
  write(dev, 'app/hub.js', "var BUILD = 'v0.1.0';\n");
  write(dev, 'pi/server.js', '// server\n');
  write(dev, '.gitignore', 'pi/data/\n');
  git(dev, ['add', '-A']);
  git(dev, ['commit', '-q', '-m', 'secret commit message one']);
  git(dev, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', origin, pi]);
  // The fake restart: writes each call down; has-budget answers from a file.
  const fake = path.join(root, 'fake-restart.sh');
  fs.writeFileSync(fake, '#!/bin/sh\n' +
    'if [ "$1" = has-budget ]; then [ -f "' + path.join(root, 'budget-exists') + '" ]; exit $?; fi\n' +
    'echo "$1" >> "' + calls + '"\n' +
    '[ -f "' + path.join(root, 'fail-' ) + '$1" ] && exit 1\nexit 0\n');
  fs.chmodSync(fake, 0o755);
  const t = { root, origin, dev, pi, data, calls, fake };
  t.run = (extra) => cp.spawnSync('sh', [SCRIPT], {
    env: Object.assign({}, GIT_ENV, { AUTOPULL_REPO: pi, AUTOPULL_DATA: data, AUTOPULL_RESTART_CMD: fake }, extra || {}),
    encoding: 'utf8', timeout: 60000
  });
  t.push = (files, msg) => {
    Object.keys(files).forEach((k) => write(dev, k, files[k]));
    git(dev, ['add', '-A']);
    git(dev, ['commit', '-q', '-m', msg || 'a private commit message']);
    git(dev, ['push', '-q', 'origin', 'main']);
  };
  t.head = () => git(pi, ['rev-parse', 'HEAD']);
  t.originHead = () => git(dev, ['rev-parse', 'HEAD']);
  t.log = () => { try { return fs.readFileSync(path.join(data, 'autopull.log'), 'utf8'); } catch (e) { return ''; } };
  t.lines = () => t.log().split('\n').filter(Boolean);
  t.calls = () => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
  t.state = () => { try { return fs.readFileSync(path.join(data, 'autopull.state'), 'utf8'); } catch (e) { return ''; } };
  return t;
}

async function main() {
  await check('already current: no pull, no restart, no log line', async () => {
    const t = setup();
    const before = t.head();
    for (let i = 0; i < 3; i++) assert.strictEqual(t.run().status, 0);
    assert.strictEqual(t.head(), before);
    assert.deepStrictEqual(t.calls(), []);
    assert.strictEqual(t.log(), '');
  });

  await check('app/ and docs/ only: fast-forwards, restarts nothing, logs counts', async () => {
    const t = setup();
    t.push({ 'app/hub.js': "var BUILD = 'v0.2.0';\n", 'app/clock.js': '1\n' });
    t.push({ 'docs/process.md': 'x\n' });
    assert.strictEqual(t.run().status, 0);
    assert.strictEqual(t.head(), t.originHead());
    assert.deepStrictEqual(t.calls(), []);
    const l = t.lines();
    assert.strictEqual(l.length, 1, t.log());
    assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d pulled 2 commit\(s\), 3 file\(s\) \(app 2, docs 1\), no restart$/.test(l[0]), l[0]);
    t.run();
    assert.strictEqual(t.lines().length, 1, 'a second run says nothing');
  });

  await check('a pi/ server file: restarts the hub, then the budget, in that order', async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.root, 'budget-exists'), '');
    t.push({ 'pi/server.js': '// new server\n', 'app/hub.js': "var BUILD = 'v0.3.0';\n" });
    t.run();
    assert.deepStrictEqual(t.calls(), ['hub', 'budget']);
    assert.ok(/\(app 1, pi 1\), restarted hub\+budget$/.test(t.lines()[0]), t.log());
  });

  await check('no budget service: the hub only; pi tests and notes restart nothing', async () => {
    const t = setup();
    t.push({ 'pi/server.js': '// again\n' });
    t.run();
    assert.deepStrictEqual(t.calls(), ['hub']);
    assert.ok(/restarted hub$/.test(t.lines()[0]), t.log());
    t.push({ 'pi/server-test.js': 'x\n', 'pi/README.md': 'x\n', 'pi/autopull/autopull.sh': '#\n', 'pi/aliases.sh': '#\n' });
    t.run();
    assert.deepStrictEqual(t.calls(), ['hub']);
    assert.ok(/, no restart$/.test(t.lines()[1]), t.log());
  });

  await check('a failed hub restart is owed and done on the next run', async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.root, 'fail-hub'), '');
    t.push({ 'pi/server.js': '// x\n' });
    t.run();
    assert.ok(/hub restart failed \(1 in a row; next try in 10 min\)$/.test(t.lines()[0]), t.log());
    fs.unlinkSync(path.join(t.root, 'fail-hub'));
    const later = String(Math.floor(Date.now() / 1000) + 3600);
    t.run({ AUTOPULL_NOW: later });
    assert.deepStrictEqual(t.calls(), ['hub', 'hub']);
    assert.ok(/restarted hub \(owed from an earlier pull\)$/.test(t.lines()[1]), t.log());
    t.run({ AUTOPULL_NOW: later });
    assert.strictEqual(t.calls().length, 2);
  });

  await check('files changed on the Pi: skips (logged once), no pull', async () => {
    const t = setup();
    const before = t.head();
    write(t.pi, 'app/hub.js', 'edited by hand\n');
    write(t.pi, 'pi/data/state.json', '{}');      // ignored data never counts
    write(t.pi, 'untracked.txt', 'x');           // nor untracked files
    t.push({ 'app/x.js': '1\n' });
    t.run(); t.run();
    assert.strictEqual(t.head(), before);
    assert.deepStrictEqual(t.lines().map((l) => l.slice(17)), ['skipped: 1 file(s) changed on the Pi']);
    git(t.pi, ['checkout', '--', 'app/hub.js']);
    t.run();
    assert.strictEqual(t.head(), t.originHead());
  });

  await check('not a fast-forward: skips (logged once), keeps the Pi\'s commit', async () => {
    const t = setup();
    write(t.pi, 'app/local.js', 'mine\n');
    git(t.pi, ['add', '-A']);
    git(t.pi, ['commit', '-q', '-m', 'local']);
    const mine = t.head();
    t.push({ 'app/x.js': '1\n' });
    t.run(); t.run();
    assert.strictEqual(t.head(), mine);
    assert.strictEqual(t.lines().length, 1);
    assert.ok(/not a fast-forward$/.test(t.lines()[0]), t.log());
  });

  await check('not on main: skips', async () => {
    const t = setup();
    git(t.pi, ['checkout', '-q', '-b', 'side']);
    t.push({ 'app/x.js': '1\n' });
    t.run();
    assert.ok(/skipped: the checkout is not on main$/.test(t.lines()[0]), t.log());
  });

  await check('kill switch: autopull.off stops it (logged once), removing it goes on', async () => {
    const t = setup();
    fs.mkdirSync(t.data, { recursive: true });
    fs.writeFileSync(path.join(t.data, 'autopull.off'), '');
    const before = t.head();
    t.push({ 'app/x.js': '1\n' });
    t.run(); t.run();
    assert.strictEqual(t.head(), before);
    assert.strictEqual(t.lines().length, 1);
    assert.ok(/ off \(/.test(t.lines()[0]), t.log());
    fs.unlinkSync(path.join(t.data, 'autopull.off'));
    t.run();
    assert.strictEqual(t.head(), t.originHead());
    assert.ok(/on again$/.test(t.lines()[1]), t.log());
  });

  await check('another run holding the lock: does nothing; an hour-old lock is cleared', async () => {
    const t = setup();
    const lock = path.join(t.data, 'autopull.lock');
    fs.mkdirSync(lock, { recursive: true });
    const before = t.head();
    t.push({ 'app/x.js': '1\n' });
    t.run();
    assert.strictEqual(t.head(), before);
    assert.strictEqual(t.log(), '');
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(lock, old, old);
    t.run();
    assert.strictEqual(t.head(), t.originHead());
    assert.ok(!fs.existsSync(lock), 'the lock is gone after the run');
  });

  await check('fetch failures back off (10, 20 min ... at most 6 h) and reset on success', async () => {
    const t = setup();
    const good = git(t.pi, ['remote', 'get-url', 'origin']);
    git(t.pi, ['remote', 'set-url', 'origin', path.join(t.root, 'nowhere.git')]);
    const t0 = Math.floor(Date.now() / 1000);
    t.run({ AUTOPULL_NOW: String(t0) });
    assert.ok(/fetch failed \(1 in a row; next try in 10 min\)$/.test(t.lines()[0]), t.log());
    t.run({ AUTOPULL_NOW: String(t0 + 300) });             // too soon: nothing
    assert.strictEqual(t.lines().length, 1);
    t.run({ AUTOPULL_NOW: String(t0 + 601) });
    assert.ok(/\(2 in a row; next try in 20 min\)$/.test(t.lines()[1]), t.log());
    let now = t0 + 601;
    for (let i = 0; i < 8; i++) { now += 7 * 3600; t.run({ AUTOPULL_NOW: String(now) }); }
    assert.ok(/next try in 360 min\)$/.test(t.lines()[t.lines().length - 1]), t.log());
    git(t.pi, ['remote', 'set-url', 'origin', good]);
    t.push({ 'app/x.js': '1\n' });
    t.run({ AUTOPULL_NOW: String(now + 1000) });           // still waiting
    assert.notStrictEqual(t.head(), t.originHead());
    t.run({ AUTOPULL_NOW: String(now + 6 * 3600 + 1) });
    assert.strictEqual(t.head(), t.originHead());
    assert.ok(/^fails=0$/m.test(t.state()), t.state());
  });

  await check('the log never holds a file name or a commit message, and keeps 200 lines', async () => {
    const t = setup();
    t.push({ 'app/widgets/secret-name.js': '1\n', 'pi/very-private.js': '1\n' }, 'a private commit message');
    t.run();
    const log = t.log();
    assert.ok(!/secret-name|very-private|private commit|\.js/.test(log), log);
    fs.writeFileSync(path.join(t.data, 'autopull.log'), Array.from({ length: 250 }, (x, i) => 'old ' + i).join('\n') + '\n');
    t.push({ 'app/y.js': '1\n' });
    t.run();
    assert.strictEqual(t.lines().length, 200);
    assert.ok(/no restart$/.test(t.lines()[199]));
  });

  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* left over */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
