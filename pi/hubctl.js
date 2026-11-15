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
 *   ./hub status                     is the server up, which screens are on
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

const ENV_FILE = path.join(__dirname, '.env');
const EXAMPLE_FILE = path.join(__dirname, '.env.example');
const WIDGETS = ['weather', 'todo', 'entertainment'];

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

async function command(type, data) {
  const r = await call('POST', '/api/command', { type: type, data: data || {} });
  if (r.delivered > 0) say('Sent. ' + screens(r.delivered) + ' showed it.');
  else say('Sent, but no screen is listening (is the TV on with Home Hub open?).');
}

/* ---------- to-do helpers ---------- */

async function findItem(what) {
  const r = await call('GET', '/api/todo');
  const items = r.items || [];
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
    say('Added "' + r.item.title + '" to ' + SECTION_NAMES[r.item.section] + (r.item.due ? ', due ' + r.item.due : '') + '.');
    return;
  }
  if (sub === 'list') {
    const r = await call('GET', '/api/todo');
    const items = r.items || [];
    if (!items.length) { say('The to-do list is empty.'); return; }
    Object.keys(SECTION_NAMES).forEach((sec) => {
      const inSec = items.filter((i) => i.section === sec);
      if (!inSec.length) return;
      say(SECTION_NAMES[sec] + ':');
      inSec.forEach((i) => say('  [' + (i.done ? 'x' : ' ') + '] ' + i.title + (i.due ? ' (due ' + i.due + ')' : '') + '   id ' + i.id));
    });
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
    say((sub === 'done' ? 'Ticked "' : 'Removed "') + item.title + '".');
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

async function calendar(args) {
  const sub = args[0];
  if (sub === 'status') {
    const r = await call('GET', '/api/calendar');
    const d = r.data || {};
    if (!d.configured || !(d.calendars || []).length) { say(NO_CALENDARS); return; }
    const tz = zoneOk(d.tz) ? d.tz : 'America/Chicago';
    d.calendars.forEach((c) => {
      const at = c.updatedAt ? when(Date.parse(c.updatedAt), tz) : '';
      if (c.ok) {
        say(c.name + ': ' + plural(c.count, 'event') + ', read at ' + at + (c.skipped ? ' (' + c.skipped + ' left out: repeats this reader cannot follow)' : ''));
      } else if (c.count > 0 && at) {
        say(c.name + ': ' + c.error + ', showing the ' + plural(c.count, 'event') + ' from ' + at);
      } else {
        say(c.name + ': ' + c.error + ', no events to show');
      }
    });
    if (d.truncated) say('Only the first 500 events are kept.');
    const now = Date.now();
    let next = null;
    (d.events || []).forEach((e) => {
      const t = e.allDay ? allDayStart(e.start, tz) : Date.parse(e.start);
      if (!(t > now)) return;
      if (!next || t < next.t) next = { t: t, e: e };
    });
    if (next) say('Next: ' + when(next.t, tz, next.e.allDay) + ', ' + next.e.title);
    else say('No upcoming events in the next 60 days.');
    return;
  }
  if (sub === 'refresh') {
    const r = await call('POST', '/api/calendar/refresh', {}, 40000);
    const list = r.calendars || [];
    if (!list.length) { say(NO_CALENDARS); return; }
    if (!r.done) {
      say('Still reading the calendars after 25 seconds. Run ./hub calendar status in a minute.');
      return;
    }
    const events = list.reduce((n, c) => n + (c.count || 0), 0);
    say('Refreshed. ' + plural(list.length, 'calendar') + ', ' + plural(events, 'event') + (r.changed ? ' (changed).' : ' (no change).'));
    list.filter((c) => !c.ok).forEach((c) => say(c.name + ': ' + c.error + '.'));
    return;
  }
  stop('Use one of: calendar status, calendar refresh. Run ./hub help for examples.');
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

async function status() {
  const r = await call('GET', '/api/status');
  const mins = Math.round(r.uptime / 60);
  const up = mins < 1 ? 'less than a minute' : mins < 120 ? mins + ' minutes' : Math.round(mins / 60) + ' hours';
  say('The server is running (version ' + r.server + ', up ' + up + ', data revision ' + r.rev + ').');
  if (r.calendar && r.calendar.configured) {
    say(plural(r.calendar.calendars, 'calendar') + ' set up' + (r.calendar.lastRefresh ? ', last read at ' + new Date(r.calendar.lastRefresh).toLocaleTimeString() : ', not read yet') + '.');
  }
  const list = r.screens || [];
  if (!list.length) {
    say('No screen is connected right now.');
    return;
  }
  say(screens(list.length) + ' connected:');
  list.forEach((sc) => {
    const t = new Date(sc.since);
    say('  ' + sc.address + ', since ' + t.toLocaleTimeString() + (sc.via === 'poll' ? ' (fallback mode)' : ''));
  });
}

/* ---------- help ---------- */

const HELP = [
  'Home Hub commands (run from the pi folder):',
  '  ./hub show weather          open a widget: weather, todo or entertainment',
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
  '  ./hub status                is the server running, which screens are on',
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
  if (cmd === 'status') return status();
  if (cmd === 'token') return token();
  stop('I do not know "' + cmd + '". Run ./hub help to see the commands.');
}

main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
  if (e instanceof Stop) say(e.message);
  else say('Something went wrong: ' + (e && e.message));
  process.exit(1);
});
