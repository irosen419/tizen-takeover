/*
 * hubctl: the command line for the Home Hub live server. Claude on the Pi
 * (or you) runs it to change what the TV shows and to edit the to-do list.
 * Usually you run it through the "hub" script in this folder:
 *
 *   ./hub show weather [--full]      open a widget on the TV
 *   ./hub home                       close whatever is open
 *   ./hub say "Dinner in 10" [--seconds 8]
 *   ./hub reload                     load the hub afresh
 *   ./hub todo add "Buy milk" [--section now|next|waiting] [--due 2026-12-24]
 *   ./hub todo list
 *   ./hub todo done <id or exact title>
 *   ./hub todo remove <id or exact title>
 *   ./hub calendar status            each calendar, and the next event
 *   ./hub calendar refresh           read the calendars again now
 *   ./hub layout show                the home-screen tile layout
 *   ./hub layout set <file.json|->   a new layout (a list of tiles, or { layout: [...] })
 *   ./hub layout reset               back to the layout in app/config.js
 *   ./hub awws show                  the A World Worth Saving snapshot: when sent, size, sections
 *   ./hub awws set <file.json|->     store one (the snapshot, or { snapshot: {...} })
 *   ./hub awws clear                 remove it; the TV tiles say "Not synced yet"
 *   ./hub status                     is the server up, which screens are on
 *   ./hub mailbox status             is the Claude mailbox (Cloudflare R2) connected
 *   ./hub token                      create the password, once
 *   ./hub help
 *
 * It reads HUB_TOKEN and HUB_PORT from pi/.env next to this file (real
 * environment variables win) and talks to http://127.0.0.1:<port>, or to
 * HUB_URL if that is set. It never prints the token.
 * Node 14 or newer, no npm packages. Exit code 0 on success, 1 otherwise.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const awws = require('./awws');

const ENV_FILE = path.join(__dirname, '.env');
const EXAMPLE_FILE = path.join(__dirname, '.env.example');
const WIDGETS = ['weather', 'todo', 'calendar', 'entertainment', 'awws', 'awws-visits', 'awws-agenda', 'awws-todo', 'awws-reach'];

/* ---------- settings ---------- */

function parseEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t[0] === '#') return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) return;
    let v = m[2];
    if ((v[0] === '"' || v[0] === "'") && v.length >= 2 && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  });
  return out;
}

function settings() {
  let file = {};
  try { file = parseEnv(fs.readFileSync(ENV_FILE, 'utf8')); } catch (e) { /* no .env yet */ }
  const pick = (k) => (process.env[k] ? process.env[k] : file[k] || '');
  const port = pick('HUB_PORT') || '8097';
  return {
    token: pick('HUB_TOKEN'),
    port: port,
    url: (pick('HUB_URL') || 'http://127.0.0.1:' + port).replace(/\/+$/, '')
  };
}

/* ---------- output ---------- */

class Stop extends Error {}

function say(line) {
  process.stdout.write(line + '\n');
}

function stop(line) {
  const e = new Stop(line);
  throw e;
}

/* ---------- talking to the server ---------- */

const WAIT_STEP_MS = 500;
const WAIT_TRIES = Number(process.env.HUB_WAIT_TRIES || 10); // about 5 seconds in all

function call(method, p, body, timeoutMs) {
  const s = settings();
  if (!s.token) stop('There is no token in pi/.env yet. Run ./hub token first, then restart the server.');
  let url;
  try { url = new URL(s.url + p); } catch (e) { stop('HUB_URL is not a valid address: ' + s.url); }
  const lib = url.protocol === 'https:' ? https : http;
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const once = () => new Promise((resolve) => {
    const req = lib.request(url, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + s.token, Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      timeout: timeoutMs || 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* handled below */ }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: e }));
    if (data) req.write(data);
    req.end();
  });
  // A server that was started a moment ago may not be listening yet, so
  // "nothing answered" is tried again for a few seconds before it is believed.
  const patient = (triesLeft) => once().then((r) => {
    if (r.error && r.error.code === 'ECONNREFUSED' && triesLeft > 0) {
      return new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS)).then(() => patient(triesLeft - 1));
    }
    return r;
  });
  return patient(WAIT_TRIES).then((r) => {
    const where = process.env.HUB_URL ? s.url : 'this Pi';
    if (r.error) {
      if (r.error.code === 'ECONNREFUSED') {
        stop('The server is not running on ' + where + ' (nothing answered on port ' + (url.port || s.port) + ').');
      }
      if (r.error.message === 'timeout') stop('The server did not answer in time.');
      stop('Could not reach the server (' + (r.error.code || r.error.message) + ').');
    }
    if (!r.json) stop('Something answered at ' + s.url + ', but it is not the Home Hub server.');
    if (r.status === 401) stop('The server rejected the token in pi/.env.');
    if (r.status === 503 && /no token/.test(r.json.error || '')) {
      stop('The server has no token yet. Run ./hub token, then restart the server.');
    }
    if (!r.json.ok) stop('The server said no: ' + (r.json.error || 'error ' + r.status) + '.');
    return r.json;
  });
}

/* ---------- arguments ---------- */

// Splits "--name value" and "--flag" options from the plain words.
function parseArgs(args, valued) {
  const words = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.indexOf('--') === 0) {
      const name = a.slice(2);
      if (valued.indexOf(name) >= 0) {
        if (i + 1 >= args.length) stop('--' + name + ' needs a value.');
        opts[name] = args[++i];
      } else {
        opts[name] = true;
      }
    } else {
      words.push(a);
    }
  }
  return { words: words, opts: opts };
}

function screens(n) {
  return n === 1 ? '1 screen' : n + ' screens';
}

// The text for each answer lives in these small functions, so the Claude
// mailbox (mailbox.js) reports exactly what ./hub prints.
function commandText(r) {
  if (r.delivered > 0) return 'Sent. ' + screens(r.delivered) + ' showed it.';
  return 'Sent, but no screen is listening (is the TV on with Home Hub open?).';
}

async function command(type, data) {
  const r = await call('POST', '/api/command', { type: type, data: data || {} });
  say(commandText(r));
}

/* ---------- to-do helpers ---------- */

async function findItem(what) {
  const r = await call('GET', '/api/todo');
  return matchItem(r.items || [], what);
}

// The item with this id, or the one with this exact title (case is ignored
// when nothing matches exactly). Stops with a plain message otherwise.
function matchItem(items, what) {
  let hit = items.find((i) => i.id === what);
  if (hit) return hit;
  let matches = items.filter((i) => i.title === what);
  if (!matches.length) matches = items.filter((i) => i.title.toLowerCase() === what.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    stop('More than one to-do is called "' + what + '". Use its id instead: ' + matches.map((i) => i.id).join(', ') + '.');
  }
  stop('No to-do has the id or title "' + what + '". Run ./hub todo list to see them.');
  return null;
}

const SECTION_NAMES = { now: 'Now', next: 'Next', waiting: 'Waiting on' };

function todoAddText(r) {
  return 'Added "' + r.item.title + '" to ' + SECTION_NAMES[r.item.section] + (r.item.due ? ', due ' + r.item.due : '') + '.';
}

function todoListLines(items) {
  if (!items.length) return ['The to-do list is empty.'];
  const out = [];
  Object.keys(SECTION_NAMES).forEach((sec) => {
    const inSec = items.filter((i) => i.section === sec);
    if (!inSec.length) return;
    out.push(SECTION_NAMES[sec] + ':');
    inSec.forEach((i) => out.push('  [' + (i.done ? 'x' : ' ') + '] ' + i.title + (i.due ? ' (due ' + i.due + ')' : '') + '   id ' + i.id));
  });
  return out;
}

function todoChangeText(sub, item) {
  return (sub === 'done' ? 'Ticked "' : 'Removed "') + item.title + '".';
}

async function todo(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'add') {
    const a = parseArgs(rest, ['section', 'due']);
    const title = a.words.join(' ').trim();
    if (!title) stop('Say what to add, for example: ./hub todo add "Buy milk"');
    const body = { title: title };
    if (a.opts.section) body.section = a.opts.section;
    if (a.opts.due) body.due = a.opts.due;
    const r = await call('POST', '/api/todo', body);
    say(todoAddText(r));
    return;
  }
  if (sub === 'list') {
    const r = await call('GET', '/api/todo');
    todoListLines(r.items || []).forEach(say);
    return;
  }
  if (sub === 'done' || sub === 'remove') {
    const what = rest.join(' ').trim();
    if (!what) stop('Say which to-do, by its id or exact title. Run ./hub todo list to see them.');
    const item = await findItem(what);
    const op = sub === 'done'
      ? { op: 'set', id: item.id, fields: { done: true } }
      : { op: 'remove', id: item.id };
    await call('POST', '/api/todo/ops', { ops: [op] });
    say(todoChangeText(sub, item));
    return;
  }
  stop('Use one of: todo add, todo list, todo done, todo remove. Run ./hub help for examples.');
}

/* ---------- calendar ---------- */

const NO_CALENDARS = 'No calendars are set up yet. See pi/README.md.';

function zoneOk(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// "7:10 AM" today, otherwise "Thursday 7:10 AM" within a week, otherwise "Nov 30, 7:10 AM".
function when(ms, tz, allDay) {
  const dayOf = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const time = new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const diff = Math.round((Date.parse(dayOf(ms)) - Date.parse(dayOf(Date.now()))) / 86400000);
  let day;
  if (diff === 0) day = allDay ? 'Today' : '';
  else if (diff === 1) day = 'Tomorrow';
  else if (diff === -1) day = 'Yesterday';
  else if (diff > 1 && diff < 7) day = new Date(ms).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  else day = new Date(ms).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' }) + ',';
  if (allDay) return day.replace(/,$/, '') + ' (all day)';
  return (day ? day + ' ' : '') + time;
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// All-day events are dated in the hub's zone; this finds the instant they start.
function allDayStart(text, tz) {
  const guess = Date.parse(text + 'T12:00:00Z');
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).forEach((p) => { parts[p.type] = p.value; });
  const offset = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute) - guess;
  return Date.parse(text + 'T00:00:00Z') - offset;
}

function calendarStatusLines(d) {
  if (!d || !d.configured || !(d.calendars || []).length) return [NO_CALENDARS];
  const out = [];
  const tz = zoneOk(d.tz) ? d.tz : 'America/Chicago';
  d.calendars.forEach((c) => {
    const at = c.updatedAt ? when(Date.parse(c.updatedAt), tz) : '';
    if (c.ok) {
      out.push(c.name + ': ' + plural(c.count, 'event') + ', read at ' + at + (c.skipped ? ' (' + c.skipped + ' left out: repeats this reader cannot follow)' : ''));
    } else if (c.count > 0 && at) {
      out.push(c.name + ': ' + c.error + ', showing the ' + plural(c.count, 'event') + ' from ' + at);
    } else {
      out.push(c.name + ': ' + c.error + ', no events to show');
    }
  });
  if (d.truncated) out.push('Only the first 500 events are kept.');
  const now = Date.now();
  let next = null;
  (d.events || []).forEach((e) => {
    const t = e.allDay ? allDayStart(e.start, tz) : Date.parse(e.start);
    if (!(t > now)) return;
    if (!next || t < next.t) next = { t: t, e: e };
  });
  if (next) out.push('Next: ' + when(next.t, tz, next.e.allDay) + ', ' + next.e.title);
  else out.push('No upcoming events in the next 60 days.');
  return out;
}

function calendarRefreshLines(r) {
  const list = r.calendars || [];
  if (!list.length) return [NO_CALENDARS];
  if (!r.done) return ['Still reading the calendars after 25 seconds. Run ./hub calendar status in a minute.'];
  const events = list.reduce((n, c) => n + (c.count || 0), 0);
  const out = ['Refreshed. ' + plural(list.length, 'calendar') + ', ' + plural(events, 'event') + (r.changed ? ' (changed).' : ' (no change).')];
  list.filter((c) => !c.ok).forEach((c) => out.push(c.name + ': ' + c.error + '.'));
  return out;
}

async function calendar(args) {
  const sub = args[0];
  if (sub === 'status') {
    const r = await call('GET', '/api/calendar');
    calendarStatusLines(r.data || {}).forEach(say);
    return;
  }
  if (sub === 'refresh') {
    const r = await call('POST', '/api/calendar/refresh', {}, 40000);
    calendarRefreshLines(r).forEach(say);
    return;
  }
  stop('Use one of: calendar status, calendar refresh. Run ./hub help for examples.');
}

/* ---------- layout ---------- */

function layoutLines(layout) {
  if (!layout) return ['The TV uses its built-in layout (HUB_CONFIG.layout in app/config.js).'];
  const out = [plural(layout.length, 'tile') + ' on the 12 x 6 grid:'];
  const width = Math.max.apply(null, layout.map((t) => t.widget.length));
  layout.forEach((t) => {
    out.push('  ' + t.widget + ' '.repeat(width - t.widget.length) + '  at x ' + t.x + ', y ' + t.y + ', ' + t.w + ' wide, ' + t.h + ' high');
  });
  return out;
}

function layoutSetText(r) {
  if (!r.changed) return 'That is already the layout. Nothing changed.';
  return 'Layout saved (' + plural(r.layout.length, 'tile') + '). Screens that are on change now.';
}

function layoutResetText(r) {
  return r.changed ? 'Back to the built-in layout. Screens that are on change now.' : 'The TV already uses its built-in layout. Nothing changed.';
}

function readLayoutFile(name) {
  let text;
  try {
    text = name === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(name, 'utf8');
  } catch (e) {
    stop(name === '-' ? 'Could not read the layout from standard input.' : 'Could not read ' + name + ' (' + (e.code || e.message) + ').');
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { stop((name === '-' ? 'The input' : name) + ' is not valid JSON.'); }
  if (data && typeof data === 'object' && !Array.isArray(data) && 'layout' in data) data = data.layout;
  if (!Array.isArray(data)) stop('The file must hold a list of tiles, like [{"widget":"weather","x":0,"y":0,"w":3,"h":2}], or {"layout": [...]}.');
  return data;
}

async function layout(args) {
  const sub = args[0];
  if (sub === 'show') {
    const r = await call('GET', '/api/layout');
    layoutLines(r.layout).forEach(say);
    return;
  }
  if (sub === 'set') {
    const name = args[1];
    if (!name) stop('Say which file holds the layout, or - to read it from standard input. For example: ./hub layout set layout.json');
    const r = await call('POST', '/api/layout', { layout: readLayoutFile(name) });
    say(layoutSetText(r));
    return;
  }
  if (sub === 'reset') {
    const r = await call('POST', '/api/layout', { layout: null });
    say(layoutResetText(r));
    return;
  }
  stop('Use one of: layout show, layout set <file.json|->, layout reset. Run ./hub help for examples.');
}

/* ---------- A World Worth Saving snapshot ---------- */

// The lines for ./hub awws show, from a GET /api/awws answer. Times read the
// same way as in ./hub calendar status, in the hub's time zone (HUB_TIMEZONE).
function awwsShowLines(r) {
  const tz = r && zoneOk(r.tz) ? r.tz : 'America/Chicago';
  return awws.summaryLines(r && r.data, { when: (ms) => when(ms, tz) });
}

function readAwwsFile(name) {
  let text;
  try {
    text = name === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(name, 'utf8');
  } catch (e) {
    stop(name === '-' ? 'Could not read the snapshot from standard input.' : 'Could not read ' + name + ' (' + (e.code || e.message) + ').');
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { stop((name === '-' ? 'The input' : name) + ' is not valid JSON.'); }
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  if (isObj(data) && own(data, 'snapshot') && !own(data, 'v')) data = data.snapshot;
  if (!isObj(data)) {
    stop('The file must hold one snapshot, like {"v": 1, "sentAt": "2026-11-16T15:10:00Z", "todos": {...}}, or {"snapshot": {...}}. To remove it, use ./hub awws clear.');
  }
  return data;
}

async function awwsCommand(args) {
  const sub = args[0];
  if (sub === 'show') {
    const r = await call('GET', '/api/awws');
    awwsShowLines(r).forEach(say);
    return;
  }
  if (sub === 'set') {
    const name = args[1];
    if (!name) stop('Say which file holds the snapshot, or - to read it from standard input. For example: ./hub awws set snapshot.json');
    const r = await call('POST', '/api/awws', { snapshot: readAwwsFile(name) });
    say(awws.setText(r));
    return;
  }
  if (sub === 'clear') {
    const r = await call('POST', '/api/awws', { snapshot: null });
    say(awws.clearText(r));
    return;
  }
  stop('Use one of: awws show, awws set <file.json|->, awws clear. Run ./hub help for examples.');
}

/* ---------- token ---------- */

function token() {
  let text = null;
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch (e) { /* not there yet */ }
  if (text !== null && parseEnv(text).HUB_TOKEN) {
    say('A token already exists in pi/.env. Nothing was changed.');
    return;
  }
  if (text === null) {
    try { text = fs.readFileSync(EXAMPLE_FILE, 'utf8'); } catch (e) { text = ''; }
  }
  const value = crypto.randomBytes(24).toString('hex');
  const line = 'HUB_TOKEN=' + value;
  if (/^[ \t]*#?[ \t]*HUB_TOKEN[ \t]*=.*$/m.test(text)) {
    text = text.replace(/^[ \t]*#?[ \t]*HUB_TOKEN[ \t]*=.*$/m, line);
  } else {
    text = (text && !/\n$/.test(text) ? text + '\n' : text) + line + '\n';
  }
  const tmp = ENV_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, ENV_FILE);
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { /* not fatal */ }
  say('Token created and saved in pi/.env. If the server is already running, restart it so it uses the token.');
}

/* ---------- status ---------- */

function statusLines(r) {
  const mins = Math.round(r.uptime / 60);
  const up = mins < 1 ? 'less than a minute' : mins < 120 ? mins + ' minutes' : Math.round(mins / 60) + ' hours';
  const out = ['The server is running (version ' + r.server + ', up ' + up + ', data revision ' + r.rev + ').'];
  if (r.calendar && r.calendar.configured) {
    out.push(plural(r.calendar.calendars, 'calendar') + ' set up' + (r.calendar.lastRefresh ? ', last read at ' + new Date(r.calendar.lastRefresh).toLocaleTimeString() : ', not read yet') + '.');
  }
  if (r.mailbox) out.push(mailboxShort(r.mailbox));
  const list = r.screens || [];
  if (!list.length) {
    out.push('No screen is connected right now.');
    return out;
  }
  out.push(screens(list.length) + ' connected:');
  list.forEach((sc) => {
    const t = new Date(sc.since);
    out.push('  ' + sc.address + ', since ' + t.toLocaleTimeString() + (sc.via === 'poll' ? ' (fallback mode)' : ''));
  });
  return out;
}

async function status() {
  const r = await call('GET', '/api/status');
  statusLines(r).forEach(say);
}

/* ---------- Claude mailbox ---------- */

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!(s >= 0)) return 'just now';
  if (s < 90) return s + ' seconds ago';
  if (s < 5400) return Math.round(s / 60) + ' minutes ago';
  return Math.round(s / 3600) + ' hours ago';
}

// One line for ./hub status.
function mailboxShort(m) {
  if (!m.configured) return 'Claude mailbox: off.';
  if (m.connected) return 'Claude mailbox: connected' + (m.lastOkAt ? ', checked ' + ago(m.lastOkAt) : '') + '.';
  if (!m.lastOkAt && !m.lastError) return 'Claude mailbox: starting.';
  return 'Claude mailbox: NOT connected (' + (m.lastError || 'no answer yet') + ').';
}

function mailboxLines(m) {
  if (!m) return ['This server does not know the Claude mailbox yet. Run git pull, then docker compose restart hub.'];
  if (!m.configured) {
    return ['The Claude mailbox is off' + (m.problem ? ': ' + m.problem : '') + '.',
      'To turn it on, add the HUB_MAILBOX_ lines to pi/.env (see "Claude mailbox" in pi/README.md), then docker compose restart hub.'];
  }
  const out = [mailboxShort(m)];
  out.push('Bucket ' + m.bucket + ' at ' + m.host + ', checked every ' + m.pollSeconds + ' seconds.');
  if (m.connected && m.lastError) out.push('Last problem (now fixed): ' + m.lastError + '.');
  if (m.lastCommandId) out.push('Last command: ' + m.lastCommand + ' (' + m.lastCommandId + '), ' + ago(m.lastCommandAt) + (m.lastCommandOk ? ', ok.' : ', failed.'));
  else out.push('No command has come in since the server started.');
  if (m.pendingResults) out.push(m.pendingResults + ' result(s) waiting to be written back.');
  return out;
}

async function mailbox(args) {
  if (args[0] !== 'status') stop('Use: ./hub mailbox status. Run ./hub help for examples.');
  const r = await call('GET', '/api/status');
  mailboxLines(r.mailbox).forEach(say);
}

/* ---------- help ---------- */

const HELP = [
  'Home Hub commands (run from the pi folder):',
  '  ./hub show weather          open a widget: weather, todo, calendar, entertainment,',
  '                              awws, awws-visits, awws-agenda, awws-todo or awws-reach',
  '  ./hub show todo --full      the same, full screen',
  '  ./hub home                  close whatever is open',
  '  ./hub say "Dinner in 10"    a short message on the TV (add --seconds 8)',
  '  ./hub reload                load the hub afresh',
  '  ./hub todo add "Buy milk"   add a to-do (add --section next, --due 2026-12-24)',
  '  ./hub todo list             show the to-do list with ids',
  '  ./hub todo done "Buy milk"  tick a to-do, by id or exact title',
  '  ./hub todo remove "Buy milk"',
  '  ./hub calendar status       each calendar, and the next event',
  '  ./hub calendar refresh      read the calendars again now (after adding an event)',
  '  ./hub layout show           the home-screen tile layout',
  '  ./hub layout set file.json  a new tile layout (a list of tiles; - reads it from input)',
  '  ./hub layout reset          back to the layout in app/config.js',
  '  ./hub awws show             the A World Worth Saving snapshot: when sent, size, sections',
  '  ./hub awws set file.json    store a snapshot (- reads it from input; see docs/awws-snapshot.md)',
  '  ./hub awws clear            remove it; the TV tiles say "Not synced yet"',
  '  ./hub status                is the server running, which screens are on',
  '  ./hub mailbox status        is the Claude mailbox (Cloudflare R2) connected',
  '  ./hub token                 create the password in pi/.env (only once)'
].join('\n');

/* ---------- main ---------- */

async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { say(HELP); return; }
  if (cmd === 'show') {
    const a = parseArgs(rest, []);
    const widget = a.words[0];
    if (!widget) stop('Say which widget: ' + WIDGETS.join(', ') + '. For example: ./hub show weather');
    if (WIDGETS.indexOf(widget) < 0) stop('"' + widget + '" is not a widget. Use one of: ' + WIDGETS.join(', ') + '.');
    return command('show', { widget: widget, mode: a.opts.full ? 'full' : 'panel' });
  }
  if (cmd === 'home' || cmd === 'reload') return command(cmd, {});
  if (cmd === 'say') {
    const a = parseArgs(rest, ['seconds']);
    const text = a.words.join(' ').trim();
    if (!text) stop('Say what to show, for example: ./hub say "Dinner in 10"');
    const data = { text: text };
    if (a.opts.seconds !== undefined) {
      const n = Number(a.opts.seconds);
      if (!(n >= 1 && n <= 60)) stop('--seconds must be a number from 1 to 60.');
      data.seconds = n;
    }
    return command('say', data);
  }
  if (cmd === 'todo') return todo(rest);
  if (cmd === 'calendar') return calendar(rest);
  if (cmd === 'layout') return layout(rest);
  if (cmd === 'awws') return awwsCommand(rest);
  if (cmd === 'status') return status();
  if (cmd === 'mailbox') return mailbox(rest);
  if (cmd === 'token') return token();
  stop('I do not know "' + cmd + '". Run ./hub help to see the commands.');
}

module.exports = {
  Stop: Stop,
  WIDGETS: WIDGETS,
  SECTION_NAMES: SECTION_NAMES,
  commandText: commandText,
  matchItem: matchItem,
  todoAddText: todoAddText,
  todoListLines: todoListLines,
  todoChangeText: todoChangeText,
  calendarStatusLines: calendarStatusLines,
  calendarRefreshLines: calendarRefreshLines,
  layoutLines: layoutLines,
  layoutSetText: layoutSetText,
  layoutResetText: layoutResetText,
  awwsShowLines: awwsShowLines,
  statusLines: statusLines,
  mailboxLines: mailboxLines
};

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    if (e instanceof Stop) say(e.message);
    else say('Something went wrong: ' + (e && e.message));
    process.exit(1);
  });
}
