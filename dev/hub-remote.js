#!/usr/bin/env node
/* Run a Pi chore from the cloud through the Claude mailbox (R2) and print ONE line.
 *
 *   node dev/hub-remote.js status                       Pi alive? version, TV, age of the last check
 *   node dev/hub-remote.js <cmd> ['{"json":"args"}']    e.g. calendar.refresh, todo.add, shows.refresh
 *   node dev/hub-remote.js --file cmd.json              a whole {cmd,args} envelope from a file
 *   node dev/hub-remote.js log                          the server's last 50 log lines (log.tail)
 *
 * Commands and arguments: the COMMANDS table in pi/mailbox.js (also pi/CLAUDE.md).
 * Needs curl with the cloud proxy (no key on your side). Prints the reply's
 * message only, never raw JSON, so a chore costs a few lines of context.
 * It cannot restart the Pi or run git/docker: those stay with Ian (hubup alias).
 */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const B = 'https://api.cloudflare.com/client/v4/accounts/f24d1741cf57727291b631def49ffacb/r2/buckets/home-hub-mailbox/objects';
const POLL_MS = 3000;
const WAIT_MS = 60000;

function get(key) {
  const r = cp.spawnSync('curl', ['-sS', '--max-time', '20', B + '/' + encodeURIComponent(key)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('curl failed: ' + (r.stderr || '').trim().slice(0, 120));
  try { return JSON.parse(r.stdout); } catch (e) { return null; }
}
function put(key, body) {
  const r = cp.spawnSync('curl', ['-sS', '--max-time', '20', '-X', 'PUT', B + '/' + encodeURIComponent(key),
    '-H', 'content-type: application/json', '--data-binary', '@-'], { input: body, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('curl failed: ' + (r.stderr || '').trim().slice(0, 120));
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? s + ' s' : Math.round(s / 60) + ' min';
}

function status() {
  const s = get('status.json');
  if (!s || !s.updated) { console.log('Pi mailbox: no status file (Pi off or mailbox down).'); return 1; }
  const age = (Date.now() - Date.parse(s.updated)) / 1000;
  const bits = ['Pi ' + (age < 150 ? 'alive' : 'STALE') + ' (checked ' + ago(s.updated) + ' ago)'];
  if (s.version) bits.push('server ' + s.version);
  if (s.hubVersion) bits.push('hub ' + s.hubVersion);
  if (s.summary) bits.push(String(s.summary).slice(0, 160));
  console.log(bits.join(', '));
  return age < 150 ? 0 : 1;
}

function run(env) {
  const id = 'c' + Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1e5);
  env.id = id;
  env.created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  put('inbox/' + id + '.json', JSON.stringify(env));
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    sleep(POLL_MS);
    const o = get('outbox/' + id + '.json');
    if (o && o.state === 'done') {
      const msg = String(o.message || (o.ok ? 'done' : 'failed')).split('\n').slice(0, 60).join('\n');
      console.log((o.ok ? '' : 'FAILED: ') + msg);
      return o.ok ? 0 : 1;
    }
  }
  console.log('No answer after ' + WAIT_MS / 1000 + ' s (id ' + id + '). Run: node dev/hub-remote.js status');
  return 2;
}

const a = process.argv.slice(2);
if (!a.length || a[0] === '-h' || a[0] === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[^\n]*\n/, '')); process.exit(0); }
try {
  if (a[0] === 'status') process.exit(status());
  if (a[0] === '--file') process.exit(run(JSON.parse(fs.readFileSync(a[1], 'utf8'))));
  const cmd = a[0] === 'log' ? 'log.tail' : a[0];
  process.exit(run({ cmd: cmd, args: a[1] ? JSON.parse(a[1]) : {} }));
} catch (e) { console.log('hub-remote: ' + e.message); process.exit(1); }
