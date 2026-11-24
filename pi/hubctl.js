/*
 * hubctl: the command line for the Home Hub live server. Claude on the Pi
 * (or you) runs it to change what the TV shows and to edit the to-do list.
 * Usually you run it through the "hub" script in this folder:
 *
 *   ./hub show weather [--full]      open a widget on the TV
 *   ./hub home                       close whatever is open
 *   ./hub say "Dinner in 10" [--seconds 8]
 *   ./hub play <http(s) audio address> [--title "Doorbell"]   play audio on the TV
 *   ./hub stop                       stop what the TV is playing
 *   ./hub news                       play the newest NPR News Now newscast on the TV
 *   ./hub reload                     load the hub afresh
 *   ./hub todo add "Buy milk" [--level must|optional|passive] [--due 2026-12-24] [--lead 3] [--notes "Oat, not dairy"]
 *   ./hub todo list
 *   ./hub todo level <id or exact title> must|optional|passive
 *   ./hub todo lead <id or exact title> 3   (days, 0 to 30; or --clear for the default 2)
 *   ./hub todo notes <id or exact title> "Oat, not dairy"   (or --clear)
 *   ./hub todo done <id or exact title>
 *   ./hub todo remove <id or exact title>
 *   ./hub grocery add "Milk" "Eggs"    (one item per quoted name, up to 20)
 *   ./hub grocery list | done <id or name> | remove <id or name> | clear | export
 *   ./hub pantry add "Eggs" [--qty 12] [--at 6] [--place fridge] [--brand "Vital Farms"] [--auto off]
 *   ./hub pantry set <id or name> [--qty 2] [--at 6] [--place fridge] [--auto on|off]
 *   ./hub pantry list | low
 *   ./hub calendar status            each calendar, and the next event
 *   ./hub calendar refresh           read the calendars again now
 *   ./hub layout show                the home-screen tile layout
 *   ./hub layout set <file.json|->   a new layout (a list of tiles, or { layout: [...] })
 *   ./hub layout reset               back to the layout in app/config.js
 *   ./hub awws show                  the A World Worth Saving snapshot: when sent, size, sections
 *   ./hub awws set <file.json|->     store one (the snapshot, or { snapshot: {...} })
 *   ./hub awws clear                 remove it; the TV tiles say "Not synced yet"
 *   ./hub budget show                the budget snapshot: when sent, size, sections (no amounts)
 *   ./hub budget set <file.json|->   store one (the snapshot, or { snapshot: {...} })
 *   ./hub budget clear               remove it; the TV tiles say "Waiting for the budget app"
 *   ./hub budget goal [60]           the daily spending goal: show when it was set, or set it from today on
 *   ./hub shows list                 the TV show list: running or ended, what airs next
 *   ./hub shows add "Stick" --service "Apple TV" [--id 12345] [--watch Hulu] [--also "Hulu,Peacock"] [--via "Prime Video"] [--link 80123456]
 *   ./hub shows remove "Stick"       take a show off the list
 *   ./hub shows refresh              ask TVmaze about every show now
 *   ./hub shows watched "Stick" [S3E4]   mark an episode watched (none named: the earliest out and unmarked)
 *   ./hub shows unwatch "Stick" S3E4     take a watched mark off
 *   ./hub shows upto "Stick" S3E4        watched up to and including S3E4 (binge: everything before it counts)
 *   ./hub shows caughtup "Stick"         watched every episode that has aired
 *   ./hub linktests                  the TV's watch link test answers
 *   ./hub tvremote                   the TV remote from the Pi: paired or not, the last run
 *   ./hub tvremote run '<json>'      a two-step launch (see pi/README.md)
 *   ./hub spotify status             is Spotify connected, and what is playing
 *   ./hub spotify login              connect Spotify (once): a link to open, then paste the address back
 *   ./hub spotify code "<address>"   the second half of login, without the prompt
 *   ./hub spotify logout             forget the Spotify sign-in
 *   ./hub allsounds status           what plays anywhere (Echo speakers through Home Assistant, Spotify)
 *   ./hub echo status                the Echo targets and what the hub started on them
 *   ./hub echo start <app> [--on show|dot|everywhere] [--query "..."]   audible, pandora, amazon-music, tunein, kera, news, npr or spotify
 *   ./hub echo audible | kera | news     the same as start with that app
 *   ./hub echo pause|resume|next|stop [--on <target>]
 *   ./hub echo volume <0-100|up|down> [--on <target>]
 *   ./hub ambience status            the room's lights: how many answer, the scene
 *   ./hub ambience scenes            the saved scenes, lights and plant wall moods, with ids
 *   ./hub ambience scene <id>        apply a scene
 *   ./hub ambience light <id> on|off|<1-100>   one light
 *   ./hub ambience mood <id>         a plant wall mood (WLED)
 *   ./hub ambience set <file.json|->   new lights, scenes and moods (see ambience.example.json)
 *   ./hub ambience reset             back to the defaults (no lights)
 *   ./hub guest-pin status           is a Guest mode PIN set (never the PIN itself)
 *   ./hub guest-pin reset            forget it; the TV asks for a new PIN next time
 *   ./hub photos status              the photo album: how many photos, the last sync from the wall calendar
 *   ./hub status                     is the server up, which screens are on
 *   ./hub mailbox status             is the Claude mailbox (Cloudflare R2) connected
 *   ./hub log [--errors] [--lines 120]   the server's recent log lines (50 unless --lines says)
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
const budget = require('./budget');
const budgetgoal = require('./budgetgoal');
const shows = require('./shows');
const linktests = require('./linktests');
const tvremote = require('./tvremote');
const news = require('./news');
const grocery = require('./grocery');
const pantrydb = require('./pantrydb');

const ENV_FILE = path.join(__dirname, '.env');
const EXAMPLE_FILE = path.join(__dirname, '.env.example');
const WIDGETS = ['weather', 'todo', 'calendar', 'entertainment', 'nowplaying', 'today', 'awws', 'awws-visits', 'awws-agenda', 'awws-todo', 'awws-reach',
  'awws-money', 'budget-room', 'budget-card', 'budget-goals', 'budget-lab', 'investments', 'allsounds', 'soundctl'];

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
    // The Echo controls answer 200 with ok: false when Home Assistant said no; the message is the answer.
    if (!r.json.ok && !(r.status === 200 && p === '/api/echo' && typeof r.json.message === 'string')) stop('The server said no: ' + (r.json.error || 'error ' + r.status) + '.');
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

// ./hub news and the mailbox's "news": the play command for the newest
// newscast, and the line naming it.
function newsPlay(ep) {
  return { url: ep.url, title: news.playTitle(ep) };
}

function newsText(ep, r) {
  return news.playTitle(ep) + '. ' + commandText(r);
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

// Sections are from before levels; still taken and kept, no longer shown.
const SECTION_NAMES = { now: 'Now', next: 'Next', waiting: 'Waiting on' };
// Levels, as the TV names them. An item without one is optional; one may
// also carry its level as a "[level:must]" tag in its notes (how it travels
// through a server older than 0.6.0).
const LEVEL_NAMES = { must: 'Must today', optional: 'If you can', passive: 'Coming up' };
const LEVELS = Object.keys(LEVEL_NAMES);

function levelOf(item) {
  if (LEVELS.indexOf(item.level) >= 0) return item.level;
  const m = typeof item.notes === 'string' ? /\[level:(must|optional|passive)\]/.exec(item.notes) : null;
  return m ? m[1] : 'optional';
}

// A passive item's "Coming up" lead: how many days before its due date the
// TV shows it. A "lead" field, else a "[lead:3]" tag in its notes (how it
// travels through a server older than 0.7.0), else null (the TV's 2).
const MAX_LEAD = 30;
const DEFAULT_LEAD = 2;

function isLead(n) {
  return Number.isInteger(n) && n >= 0 && n <= MAX_LEAD;
}

function leadOf(item) {
  if (isLead(item.lead)) return item.lead;
  const m = typeof item.notes === 'string' ? /\[lead:(\d{1,2})\]/.exec(item.notes) : null;
  const n = m ? parseInt(m[1], 10) : -1;
  return isLead(n) ? n : null;
}

// "3" -> 3; anything but a whole number from 0 to 30 -> null.
function parseLead(text) {
  const t = String(text).trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = parseInt(t, 10);
  return isLead(n) ? n : null;
}

function leadWords(n) {
  if (n === 0) return 'only on the day it is due';
  return 'from ' + n + (n === 1 ? ' day' : ' days') + ' before it is due';
}

function todoAddText(r) {
  const lead = leadOf(r.item);
  return 'Added "' + r.item.title + '" to ' + LEVEL_NAMES[levelOf(r.item)] + (r.item.due ? ', due ' + r.item.due : '') +
    (lead !== null ? ', shown ' + leadWords(lead) : '') + (r.item.notes ? ', with notes' : '') + '.';
}

function todoLeadText(item) {
  const lead = leadOf(item);
  if (lead === null) return '"' + item.title + '" shows under Coming up ' + leadWords(DEFAULT_LEAD) + ' (the default).';
  return '"' + item.title + '" shows under Coming up ' + leadWords(lead) + '.';
}

// Sets (or, with null, removes) the lead of one item. Returns the item as
// the server now holds it.
async function setLead(callFn, item, lead) {
  const r = await callFn('POST', '/api/todo/ops', { ops: [{ op: 'set', id: item.id, fields: { lead: lead === null ? null : lead } }] });
  return (r.items || []).find((i) => i.id === item.id) || item;
}

function todoLevelText(item) {
  return 'Moved "' + item.title + '" to ' + LEVEL_NAMES[levelOf(item)] + '.';
}

// Sets the level of one item. Returns the item as the server now holds it.
async function setLevel(callFn, item, level) {
  const r = await callFn('POST', '/api/todo/ops', { ops: [{ op: 'set', id: item.id, fields: { level: level } }] });
  return (r.items || []).find((i) => i.id === item.id) || item;
}

function todoListLines(items) {
  if (!items.length) return ['The to-do list is empty.'];
  const out = [];
  LEVELS.forEach((lv) => {
    const inSec = items.filter((i) => levelOf(i) === lv);
    if (!inSec.length) return;
    out.push(LEVEL_NAMES[lv] + ':');
    inSec.forEach((i) => {
      const lead = leadOf(i);
      const when = [];
      if (i.due) when.push('due ' + i.due);
      if (lead !== null) when.push('lead ' + lead + (lead === 1 ? ' day' : ' days'));
      out.push('  [' + (i.done ? 'x' : ' ') + '] ' + i.title + (when.length ? ' (' + when.join(', ') + ')' : '') + '   id ' + i.id);
      if (i.notes) out.push('      notes: ' + i.notes);
    });
  });
  return out;
}

function todoChangeText(sub, item) {
  return (sub === 'done' ? 'Ticked "' : 'Removed "') + item.title + '".';
}

// item is the item after the change (from the server's answer).
function todoNotesText(item) {
  return item.notes ? 'Notes on "' + item.title + '": ' + item.notes : 'Removed the notes from "' + item.title + '".';
}

// Sets (or, with empty notes, removes) the notes of one item. Returns the
// item as the server now holds it.
async function setNotes(callFn, item, notes) {
  const r = await callFn('POST', '/api/todo/ops', { ops: [{ op: 'set', id: item.id, fields: { notes: notes || null } }] });
  return (r.items || []).find((i) => i.id === item.id) || item;
}

async function todo(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'add') {
    const a = parseArgs(rest, ['section', 'level', 'due', 'notes', 'lead']);
    const title = a.words.join(' ').trim();
    if (!title) stop('Say what to add, for example: ./hub todo add "Buy milk"');
    const body = { title: title };
    if (a.opts.section) body.section = a.opts.section;
    if (a.opts.level) {
      if (LEVELS.indexOf(a.opts.level) < 0) stop('--level must be must, optional or passive.');
      body.level = a.opts.level;
    }
    if (a.opts.due) body.due = a.opts.due;
    if (a.opts.lead !== undefined) {
      const lead = parseLead(a.opts.lead);
      if (lead === null) stop('--lead must be a whole number of days from 0 to ' + MAX_LEAD + '.');
      body.lead = lead;
    }
    if (a.opts.notes) body.notes = a.opts.notes;
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
  if (sub === 'notes') {
    const a = parseArgs(rest, []);
    const what = (a.words[0] || '').trim();
    const notes = a.words.slice(1).join(' ').trim();
    if (!what || (!notes && !a.opts.clear)) {
      stop('Say which to-do and the notes, for example: ./hub todo notes "Buy milk" "Oat, not dairy" (or --clear to remove them).');
    }
    const item = await findItem(what);
    say(todoNotesText(await setNotes(call, item, a.opts.clear ? '' : notes)));
    return;
  }
  if (sub === 'level') {
    const a = parseArgs(rest, []);
    const what = (a.words[0] || '').trim();
    const level = (a.words[1] || '').trim();
    if (!what || LEVELS.indexOf(level) < 0) {
      stop('Say which to-do and its level, for example: ./hub todo level "Buy milk" must (must, optional or passive).');
    }
    const item = await findItem(what);
    say(todoLevelText(await setLevel(call, item, level)));
    return;
  }
  if (sub === 'lead') {
    const a = parseArgs(rest, []);
    const what = (a.words[0] || '').trim();
    const lead = a.opts.clear ? null : parseLead(a.words[1] || '');
    if (!what || (lead === null && !a.opts.clear)) {
      stop('Say which to-do and how many days before its due date it shows, for example: ./hub todo lead "School meeting" 3 (0 to ' +
        MAX_LEAD + '; or --clear for the default ' + DEFAULT_LEAD + ').');
    }
    const item = await findItem(what);
    say(todoLeadText(await setLead(call, item, lead)));
    return;
  }
  stop('Use one of: todo add, todo list, todo notes, todo level, todo lead, todo done, todo remove. Run ./hub help for examples.');
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

// kind: 'snapshot' words for the errors; clearCmd: how to remove it instead.
function readAwwsFile(name, clearCmd, example) {
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
    stop('The file must hold one snapshot, like {"v": 1, "sentAt": "2026-11-16T15:10:00Z", ' + (example || '"todos": {...}') +
      '}, or {"snapshot": {...}}. To remove it, use ./hub ' + (clearCmd || 'awws') + ' clear.');
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
  if (sub === 'resync') {
    say(awws.resyncText(await call('POST', '/api/awws/resync', {})));
    return;
  }
  stop('Use one of: awws show, awws set <file.json|->, awws clear, awws resync. Run ./hub help for examples.');
}

/* ---------- Guest mode PIN ---------- */

// The line for ./hub guest-pin status, from GET /api/guest-pin.
function guestPinStatusText(r) {
  if (!r || !r.set) return 'No Guest mode PIN is set. The TV asks for a new one the next time Guest mode is turned on or off.';
  return 'A Guest mode PIN is set.' + (r.locked_for > 0 ? ' Locked for ' + r.locked_for + ' s after wrong tries.' : '');
}

function guestPinResetText(r) {
  return r && r.removed
    ? 'Guest mode PIN forgotten. The TV asks you to create a new one the next time Guest mode is turned on or off.'
    : 'No Guest mode PIN was set. The TV asks you to create one the next time Guest mode is turned on or off.';
}

async function guestPinCommand(args) {
  const sub = args[0];
  if (sub === 'status') return say(guestPinStatusText(await call('GET', '/api/guest-pin')));
  if (sub === 'reset') return say(guestPinResetText(await call('POST', '/api/guest-pin/reset', {})));
  stop('Use one of: guest-pin status, guest-pin reset. Run ./hub help for examples.');
}

/* ---------- Photo album ---------- */

// The line for ./hub photos status (and the mailbox's photos.status), from
// GET /api/photos. Counts and a time only, never a file name.
function photosStatusText(r) {
  const head = 'Photo album: ' + plural(r.count || 0, 'photo') + '.';
  if (!r.lastRun) return head + ' Never synced from the wall calendar (see pi/README.md, "Photo album").';
  const at = Date.parse(r.lastRun);
  const t = isNaN(at) ? r.lastRun : new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return head + ' Last sync ' + t + ' (' + (r.syncOk === false ? 'some files could not be copied' : 'ok') + ', ' + (r.newCount || 0) + ' new).';
}

async function photosCommand(args) {
  if (args[0] !== 'status') stop('Use: ./hub photos status. Run ./hub help for examples.');
  say(photosStatusText(await call('GET', '/api/photos')));
}

/* ---------- TV show schedule ---------- */

function showsListLines(r) {
  return shows.listLines(Object.assign({}, r, { tz: r && zoneOk(r.tz) ? r.tz : 'America/Chicago' }));
}

async function showsCommand(args) {
  const sub = args[0];
  if (!sub || sub === 'list' || sub === 'show') {
    const r = await call('GET', '/api/shows');
    showsListLines(r).forEach(say);
    return;
  }
  if (sub === 'add') {
    const a = parseArgs(args.slice(1), ['service', 'id', 'watch', 'also', 'via', 'link']);
    const name = a.words.join(' ').trim();
    if (!name) stop('Say which show, for example: ./hub shows add "Stick" --service "Apple TV"');
    const entry = { name: name };
    if (a.opts.service !== undefined) entry.service = a.opts.service;
    if (a.opts.watch !== undefined) entry.serviceOverride = a.opts.watch;
    if (a.opts.via !== undefined) entry.via = a.opts.via;
    if (a.opts.link !== undefined) entry.link = String(a.opts.link);
    if (a.opts.also !== undefined) entry.alsoOn = String(a.opts.also).split(',').map((x) => x.trim()).filter(Boolean);
    if (a.opts.id !== undefined) {
      if (!/^\d{1,9}$/.test(String(a.opts.id))) stop('--id must be the TVmaze show number, like 12345.');
      entry.tvmazeId = Number(a.opts.id);
    }
    const r = await call('POST', '/api/shows', { add: entry });
    say(shows.addText(r));
    return;
  }
  if (sub === 'remove') {
    const name = args.slice(1).join(' ').trim();
    if (!name) stop('Say which show, for example: ./hub shows remove "Stick"');
    const r = await call('POST', '/api/shows', { remove: name });
    say(shows.removeText(r.removed));
    return;
  }
  if (sub === 'refresh') {
    const r = await call('POST', '/api/shows/refresh', {}, 40000);
    say(shows.refreshText(r));
    return;
  }
  if (sub === 'watched' || sub === 'unwatch') {
    // The last word is the episode (S3E4) when it looks like one; the rest is the show.
    const words = args.slice(1);
    let ep = null;
    if (words.length > 1 && shows.parseEpisode(words[words.length - 1])) ep = words.pop();
    const name = words.join(' ').trim();
    if (!name) stop('Say which show, for example: ./hub shows ' + sub + ' "Stick" S3E4');
    if (sub === 'unwatch' && !ep) stop('Say which episode, for example: ./hub shows unwatch "Stick" S3E4');
    const body = { show: name };
    if (ep) body.episode = ep;
    const r = await call('POST', sub === 'watched' ? '/api/shows/watched' : '/api/shows/unwatch', body);
    say(sub === 'watched' ? shows.watchedText(r) : shows.unwatchText(r));
    return;
  }
  if (sub === 'upto') {
    const words = args.slice(1);
    let ep = null;
    if (words.length > 1 && shows.parseEpisode(words[words.length - 1])) ep = words.pop();
    const name = words.join(' ').trim();
    if (!name || !ep) stop('Say which show and episode, for example: ./hub shows upto "Stick" S3E4');
    const r = await call('POST', '/api/shows/upto', { show: name, episode: ep });
    say(shows.upToText(r));
    return;
  }
  if (sub === 'caughtup') {
    const name = args.slice(1).join(' ').trim();
    if (!name) stop('Say which show, for example: ./hub shows caughtup "Stick"');
    const r = await call('POST', '/api/shows/caughtup', { show: name });
    say(shows.caughtUpText(r));
    return;
  }
  stop('Use one of: shows list, shows add "<name>" --service <app>, shows remove "<name>", shows refresh, shows watched "<name>" [S3E4], shows unwatch "<name>" S3E4, shows upto "<name>" S3E4, shows caughtup "<name>". Run ./hub help for examples.');
}

async function linktestsCommand() {
  const r = await call('GET', '/api/linktests');
  linktests.lines(r.data).forEach(say);
}

async function tvremoteCommand(args) {
  if (!args.length || args[0] === 'status') {
    const r = await call('GET', '/api/tvremote');
    tvremote.lines(r).forEach(say);
    return;
  }
  if (args[0] === 'run') {
    const text = args[1] === '-' ? fs.readFileSync(0, 'utf8') : args.slice(1).join(' ');
    if (!text || !text.trim()) stop('Give the run as JSON, for example: ./hub tvremote run \'{"id":"x","appId":"3201907018807","link":"none"}\'');
    let spec;
    try { spec = JSON.parse(text); } catch (e) { stop('That is not valid JSON.'); }
    const r = await call('POST', '/api/tvremote/run', spec);
    say('Started' + (r.paired ? '' : '; the TV will ask to allow "Home Hub Pi" (choose Allow on the TV)') + '. See how it went with ./hub tvremote.');
    return;
  }
  stop('Use ./hub tvremote (status) or ./hub tvremote run \'<json>\'. Run ./hub help for examples.');
}

/* ---------- budget snapshot ---------- */

// The lines for ./hub budget show: times in the hub's time zone, no amounts.
function budgetShowLines(r) {
  const tz = r && zoneOk(r.tz) ? r.tz : 'America/Chicago';
  return budget.summaryLines(r && r.data, { when: (ms) => when(ms, tz) });
}

async function budgetCommand(args) {
  const sub = args[0];
  if (sub === 'show') {
    const r = await call('GET', '/api/budget');
    budgetShowLines(r).forEach(say);
    return;
  }
  if (sub === 'set') {
    const name = args[1];
    if (!name) stop('Say which file holds the snapshot, or - to read it from standard input. For example: ./hub budget set budget.json');
    const r = await call('POST', '/api/budget', { snapshot: readAwwsFile(name, 'budget', '"room": {...}') });
    say(budget.setText(r));
    return;
  }
  if (sub === 'clear') {
    const r = await call('POST', '/api/budget', { snapshot: null });
    say(budget.clearText(r));
    return;
  }
  if (sub === 'goal') {
    if (args[1] === undefined) {
      const g = await call('GET', '/api/budget/goal');
      say(budgetgoal.showText(g.goals));
      return;
    }
    const n = Number(args[1]);
    if (!Number.isInteger(n)) stop('Give the goal in whole dollars a day, 1 to 1,000. For example: ./hub budget goal 60');
    say(budgetgoal.setText(await call('POST', '/api/budget/goal', { goal: n })));
    return;
  }
  stop('Use one of: budget show, budget set <file.json|->, budget clear, budget goal [dollars]. Run ./hub help for examples.');
}

/* ---------- Spotify ---------- */

const SPOTIFY_SETUP = 'Spotify is not set up yet: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to pi/.env, then restart the server (docker compose restart hub). See "Spotify" in pi/README.md.';

function spotifyOld() {
  return ['This server does not know Spotify yet. Run git pull, then docker compose restart hub.'];
}

function spotifyStatusLines(sp) {
  if (!sp) return spotifyOld();
  if (!sp.configured) return [sp.problem ? 'Spotify is not set up: ' + sp.problem + '. Fix it, then restart the server.' : SPOTIFY_SETUP];
  if (!sp.signedIn) return ['Spotify is set up but not signed in. Run ./hub spotify login (once).'];
  const out = ['Spotify: signed in' + (sp.user ? ' as ' + sp.user : '') + '.'];
  const t = sp.track;
  const song = t ? '"' + t.title + '"' + (t.artist ? ' by ' + t.artist : '') : '';
  if (sp.state === 'playing') out.push('Playing ' + song + (sp.device ? ' on ' + sp.device : '') + '.');
  else if (sp.state === 'paused') out.push('Paused: ' + song + (sp.device ? ' on ' + sp.device : '') + '.');
  else if (sp.state === 'error') out.push('Problem: ' + (sp.note || 'Spotify could not be read') + '.' + (song ? ' Last seen: ' + song + '.' : ''));
  else out.push('Nothing is playing.' + (song ? ' Last played: ' + song + '.' : ''));
  if (sp.lastOkAt) out.push('Last answer from Spotify ' + ago(sp.lastOkAt) + '.');
  const vibe = vibeLine(sp.vibe, sp.track);
  if (vibe) out.push(vibe);
  return out;
}

// One line on the song's vibe (for the TV's visualizer), or '' from an
// older server. Example: "Vibe: features, 120 BPM, energy 0.8."
function vibeLine(v, track) {
  if (!v || typeof v !== 'object') return '';
  const n = (x) => String(Math.round(x * 100) / 100);
  let text;
  if (v.now && v.now.source === 'features') {
    text = 'Vibe: features, ' + (v.now.tempo ? Math.round(v.now.tempo) + ' BPM, ' : '') + 'energy ' + n(v.now.energy) + ', mood ' + n(v.now.valence) + '.';
  } else if (v.now && v.now.source === 'genres') {
    text = 'Vibe: from genres' + (v.now.genres && v.now.genres.length ? ' (' + v.now.genres.join(', ') + ')' : '') + '.';
  } else if (!track) {
    text = 'Vibe: none (nothing has played yet).';
  } else if (track.kind === 'episode') {
    text = 'Vibe: none (songs only, not podcasts).';
  } else {
    text = v.pending ? 'Vibe: looking it up.' : 'Vibe: none yet.';
  }
  if (v.lookups === 'off') text += ' Vibe lookups: off (SPOTIFY_VIBE=off).';
  if (v.problem) text += ' Last lookup problem: ' + v.problem + (v.problemAt ? ' (' + ago(v.problemAt) + ')' : '') + '.';
  return text;
}

function spotifyLoginLines(r) {
  return [
    'Connect Spotify to Home Hub (once):',
    '',
    '1. Open this link on your phone or computer and choose Agree:',
    '',
    r.url,
    '',
    '2. The browser then goes to an address starting with',
    '   ' + r.redirectUri + '?code=',
    '   and shows an error page ("can\'t be reached"). That is expected.',
    '3. Copy that whole address from the address bar and paste it here.',
    '',
    'The link works for ' + r.minutes + ' minutes.'
  ];
}

function spotifyCodeText(r) {
  return 'Spotify is connected' + (r.user ? ' (signed in as ' + r.user + ')' : '') + '. The TV shows what is playing within a few seconds.';
}

function spotifyLogoutText(r) {
  return r.changed ? 'Signed out of Spotify. Run ./hub spotify login to connect again.' : 'Spotify was not signed in. Nothing changed.';
}

/* ---------- All sounds ---------- */

// ./hub allsounds status: the state, the source, the speaker, and the title
// and artist only (allsounds.js). Example:
//   All sounds: playing from TuneIn on Living room Echo.
//   Now: "Morning Edition".
function allsoundsStatusLines(a) {
  if (!a || typeof a !== 'object') return ['This server does not know All sounds yet (it needs an update): run git pull, then docker compose restart hub.'];
  if (!a.configured && a.problem) return ['All sounds: not set up (' + a.problem + '). Fix it in pi/.env, then docker compose restart hub.'];
  const from = (a.source ? ' from ' + a.source : '') + (a.device ? ' on ' + a.device : '');
  const song = a.title ? 'Now: "' + a.title + '"' + (a.artist ? ' by ' + a.artist : '') + '.' : '';
  if (a.state === 'playing') return ['All sounds: playing' + from + '.'].concat(song ? [song] : []);
  if (a.state === 'paused') return ['All sounds: paused,' + from + '.'].concat(song ? [song] : []);
  if (a.state === 'error') {
    return [a.haProblem === 'auth' ? 'All sounds: Home Assistant refused the token (make a new one, put it in pi/.env as HA_TOKEN).'
      : 'All sounds: Home Assistant cannot be reached right now (it keeps trying).'];
  }
  if (!a.configured && a.state === 'notset') return ['All sounds: not set up (add HA_TOKEN to pi/.env, then docker compose restart hub).'];
  return ['All sounds: nothing playing' + (a.device ? ' (' + a.device + ' is on)' : '') + '.'];
}

/* ---------- Echo controls ---------- */

// What the server answered to POST /api/echo, in one line (echo.js).
function echoText(r) {
  const m = r && typeof r.message === 'string' ? r.message : '';
  if (m) return m;
  return r && r.ok ? 'Done.' : 'The Echo command did not go through.';
}

// ./hub echo status (echo.js status()). No titles: Amazon sends none we use.
function echoStatusLines(s) {
  if (!s || typeof s !== 'object') return ['This server does not know Echo controls yet (it needs 0.22.0): run git pull, then docker compose restart hub.'];
  if (!s.configured) return ['Echo controls: off (' + (s.problem || 'no HA_TOKEN in .env') + '). Fix it in pi/.env, then docker compose restart hub.'];
  const targets = Array.isArray(s.targets) ? s.targets : [];
  const out = ['Echo controls: on. Targets: ' + targets.map((t, i) => t.key + (i === 0 ? ' (default)' : '') + (t.group ? ' (group)' : '')).join(', ') + '.'];
  if (s.problem) out.push('Last problem: ' + (s.problem === 'auth' ? 'Home Assistant refused the token.' : 'Home Assistant did not answer well.'));
  const labels = Array.isArray(s.labels) ? s.labels : [];
  if (!labels.length) out.push('The hub has not started anything on an Echo.');
  labels.forEach((l) => out.push('Started by the hub: ' + l.label + ' on ' + l.target + (l.playing ? '' : ' (paused)') + '.'));
  return out;
}

const ECHO_USE = 'Use: ./hub echo status | start <app> | audible | kera | news | pause | resume | next | stop | volume <0-100|up|down> (add --on show|dot|everywhere). Run ./hub help for examples.';

async function echoCommand(args) {
  const sub = args[0];
  const a = parseArgs(args.slice(1), ['on', 'query']);
  if (!sub) stop(ECHO_USE);
  if (sub === 'status') {
    const r = await call('GET', '/api/echo');
    echoStatusLines(r.echo).forEach(say);
    return;
  }
  const body = {};
  if (typeof a.opts.on === 'string') body.target = a.opts.on.trim().toLowerCase();
  else if (a.opts.on) stop('--on needs a target, for example --on dot.');
  if (a.opts.query !== undefined && typeof a.opts.query !== 'string') stop('--query needs the words to look for, for example --query "jazz".');
  let words = a.words;
  if (sub === 'start' || ['audible', 'pandora', 'amazon-music', 'tunein', 'kera', 'news', 'npr', 'spotify'].indexOf(sub) >= 0) {
    body.action = 'start';
    if (sub === 'start') {
      body.app = (words[0] || '').toLowerCase();
      words = words.slice(1);
      if (!body.app) stop('Say which app: audible, pandora, amazon-music, tunein, kera, news, npr or spotify.');
    } else {
      body.app = sub;
    }
    if (a.opts.query !== undefined) body.query = a.opts.query;
  } else if (['pause', 'resume', 'next', 'stop'].indexOf(sub) >= 0) {
    body.action = sub;
  } else if (sub === 'volume') {
    body.action = 'volume';
    const v = (words[0] || '').toLowerCase();
    words = words.slice(1);
    if (v === 'up' || v === 'down') body.level = v;
    else if (/^\d{1,3}$/.test(v)) body.level = Number(v);
    else stop('Say the volume: a number from 0 to 100, or up or down.');
  } else {
    stop(ECHO_USE);
  }
  if (words.length) stop('Too many words. ' + ECHO_USE);
  if (a.opts.query !== undefined && body.action !== 'start') stop('--query goes with start.');
  const r = await call('POST', '/api/echo', body);
  say(echoText(r));
  if (!r.ok) process.exitCode = 1;
}

async function allsoundsCmd(args) {
  if (args[0] !== 'status') stop('Use: ./hub allsounds status. Run ./hub help for examples.');
  const r = await call('GET', '/api/allsounds');
  allsoundsStatusLines(r.allsounds).forEach(say);
}

// One line of typed input, or '' when there is none (not a terminal, or closed).
function readLine(prompt) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let done = false;
    const finish = (v) => { if (done) return; done = true; rl.close(); resolve(v); };
    process.stdout.write(prompt);
    rl.once('line', (line) => finish(String(line).trim()));
    rl.once('close', () => finish(''));
  });
}

async function spotifyCmd(args) {
  const sub = args[0];
  if (sub === 'status') {
    const r = await call('GET', '/api/spotify');
    spotifyStatusLines(r.spotify).forEach(say);
    return;
  }
  if (sub === 'login') {
    const r = await call('POST', '/api/spotify/login', {});
    spotifyLoginLines(r).forEach(say);
    say('');
    const input = await readLine('Paste the address here and press Enter: ');
    if (!input) {
      say('');
      stop('Nothing was pasted. When you have the address, run: ./hub spotify code "<the address>" (keep the quotes).');
    }
    const done = await call('POST', '/api/spotify/code', { input: input }, 30000);
    say(spotifyCodeText(done));
    return;
  }
  if (sub === 'code') {
    const input = args.slice(1).join(' ').trim();
    if (!input) stop('Paste the address after the command, in quotes: ./hub spotify code "http://127.0.0.1:.../spotify/callback?code=..."');
    const done = await call('POST', '/api/spotify/code', { input: input }, 30000);
    say(spotifyCodeText(done));
    return;
  }
  if (sub === 'logout') {
    const r = await call('POST', '/api/spotify/logout', {});
    say(spotifyLogoutText(r));
    return;
  }
  stop('Use one of: spotify status, spotify login, spotify code "<address>", spotify logout. Run ./hub help for examples.');
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
  if (r.spotify && r.spotify.configured) out.push(spotifyShort(r.spotify));
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

// One line for ./hub status.
function spotifyShort(sp) {
  if (!sp.signedIn) return 'Spotify: not signed in (run ./hub spotify login).';
  if (sp.state === 'playing' && sp.track) return 'Spotify: playing "' + sp.track.title + '".';
  if (sp.state === 'paused' && sp.track) return 'Spotify: paused.';
  if (sp.state === 'error') return 'Spotify: ' + (sp.note || 'could not be read') + '.';
  return 'Spotify: nothing playing.';
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

/* ---------- Ambience (ambience.js) ---------- */

const AMBIENCE_UPDATE = 'This server does not know Ambience yet (it needs an update): run git pull, then docker compose restart hub.';

function plain(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// The one line that sums the room up, for ./hub ambience status and the
// mailbox's ambience.status. Example: "3 lights, 2 answering, scene Chill night."
function ambienceLine(a) {
  if (!a || typeof a !== 'object') return AMBIENCE_UPDATE;
  if (!a.configured) {
    return a.problem ? 'Ambience: not set up (' + a.problem + '). Fix it in pi/.env, then docker compose restart hub.'
      : 'Ambience: not set up (add HA_TOKEN to pi/.env, then docker compose restart hub).';
  }
  const lights = Array.isArray(a.lights) ? a.lights : [];
  if (a.state === 'notset') return 'Ambience: no lights added yet (./hub ambience set <file.json>; see pi/ambience.example.json).';
  if (a.state === 'error' && a.haProblem === 'auth') return 'Ambience: Home Assistant refused the token (make a new one, put it in pi/.env as HA_TOKEN).';
  const scene = (Array.isArray(a.scenes) ? a.scenes : []).filter((s) => s.id === a.active)[0];
  let line = plain(lights.length, 'light') + ', ' + lights.filter((l) => l.reachable).length + ' answering, ' +
    lights.filter((l) => l.on).length + ' on, ' + (scene ? 'scene ' + scene.name : 'no scene') + '.';
  if (a.state === 'error') line = 'Home Assistant is not answering (it keeps trying). Last known: ' + line;
  if (a.wled && a.wledState) {
    const mood = (Array.isArray(a.moods) ? a.moods : []).filter((m) => m.id === a.wledState.mood)[0];
    line += a.wledState.reachable ? ' Plant wall: ' + (mood ? mood.name : a.wledState.on ? 'on' : 'off') + '.' : ' Plant wall: not answering.';
  }
  return line;
}

// ./hub ambience status: the line above, then one line per light.
function ambienceStatusLines(a) {
  const out = [ambienceLine(a)];
  if (!a || !a.configured || a.state === 'notset') return out;
  (a.lights || []).forEach((l) => {
    const st = !l.reachable ? 'not answering' : !l.on ? 'off' : l.kind === 'switch' ? 'on' : 'on at ' + l.pct + '%';
    out.push('  ' + l.name + ' (' + l.id + '): ' + st + (l.flaky ? ' (flaky)' : ''));
  });
  if (a.lastResult && a.lastResult.result === 'partial' && a.lastResult.missing.length) {
    out.push('Last scene: ' + a.lastResult.missing.join(', ') + ' didn\'t answer.');
  }
  return out;
}

// ./hub ambience scenes: the ids to use with the other commands.
function ambienceScenesLines(a) {
  if (!a || typeof a !== 'object') return [AMBIENCE_UPDATE];
  const out = [];
  const scenes = a.scenes || [];
  out.push(scenes.length ? 'Scenes:' : 'No scenes yet.');
  scenes.forEach((s) => out.push('  ' + s.id + '  ' + s.name + (s.id === a.active ? '  (now)' : '')));
  const lights = a.lights || [];
  if (lights.length) {
    out.push('Lights:');
    lights.forEach((l) => out.push('  ' + l.id + '  ' + l.name + (l.kind === 'switch' ? '  (switch)' : '')));
  }
  if (a.wled) {
    out.push('Plant wall moods:');
    (a.moods || []).forEach((m) => out.push('  ' + m.id + '  ' + m.name));
  }
  return out;
}

// After ./hub ambience scene: "Chill night: applied (2 of 2 lights answered)."
function ambienceSceneText(r, name) {
  const n = name || 'The scene';
  const count = ' (' + r.answered + ' of ' + plain(r.total, 'light') + ' answered)';
  const miss = (r.missing || []).length ? '; ' + r.missing.join(', ') + ' didn\'t answer' : '';
  if (r.result === 'ok') return n + ': applied' + count + '.';
  if (r.result === 'partial') return n + ': partly applied' + count.slice(0, -1) + miss + ').';
  return n + ': did not apply' + count.slice(0, -1) + miss + ').';
}

function ambienceLightText(r, name) {
  const n = name || 'The light';
  if (r.result === 'no-answer') return n + ' didn\'t answer. Nothing changed.';
  if (r.result === 'refused') return 'Home Assistant refused the change to ' + n + '.';
  return n + ' is ' + (r.on ? 'on' + (r.pct && r.pct < 100 ? ' at ' + r.pct + '%' : '') : 'off') + '.';
}

function ambienceMoodText(r, name) {
  const n = name || 'The mood';
  if (r.result === 'no-answer') return 'The plant wall didn\'t answer. Nothing changed.';
  if (r.result === 'refused') return 'The plant wall refused ' + n + '.';
  return 'Plant wall: ' + n + '.';
}

function ambienceSetText(r, reset) {
  const c = (r && r.config) || { lights: [], scenes: [], moods: [] };
  const what = plain(c.lights.length, 'light') + ', ' + plain(c.scenes.length, 'scene') + ', ' + plain(c.moods.length, 'mood');
  return (reset ? 'Back to the defaults: ' : 'Saved: ') + what + '. Screens that are on change now.';
}

function readAmbienceFile(name) {
  let text;
  try {
    text = name === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(name, 'utf8');
  } catch (e) {
    stop(name === '-' ? 'Could not read the settings from standard input.' : 'Could not read ' + name + ' (' + (e.code || e.message) + ').');
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { stop((name === '-' ? 'The input' : name) + ' is not valid JSON.'); }
  if (data && typeof data === 'object' && !Array.isArray(data) && 'config' in data) data = data.config;
  return data;
}

const nameOf = (list, id) => ((list || []).filter((x) => x.id === id)[0] || {}).name || '';

async function ambienceCommand(args) {
  const sub = args[0];
  const use = 'Use one of: ambience status, ambience scenes, ambience scene <id>, ambience light <id> on|off|<1-100>, ' +
    'ambience mood <id>, ambience set <file.json|->, ambience reset. Run ./hub help for examples.';
  const st = async () => (await call('GET', '/api/ambience')).ambience;
  if (sub === 'status') { ambienceStatusLines(await st()).forEach(say); return; }
  if (sub === 'scenes') { ambienceScenesLines(await st()).forEach(say); return; }
  if (sub === 'scene') {
    if (!args[1]) stop('Say which scene, for example: ./hub ambience scene chill (./hub ambience scenes lists them).');
    const a = await st();
    const r = await call('POST', '/api/ambience/scene', { id: args[1] });
    say(ambienceSceneText(r, nameOf(a && a.scenes, args[1])));
    return;
  }
  if (sub === 'light') {
    const id = args[1];
    const v = String(args[2] || '').toLowerCase();
    if (!id || !v) stop('Say which light and what, for example: ./hub ambience light geeni on, off or 40.');
    const body = { id: id };
    if (v === 'on') body.on = true;
    else if (v === 'off') body.on = false;
    else if (/^\d{1,3}%?$/.test(v) && Number(v.replace('%', '')) >= 1 && Number(v.replace('%', '')) <= 100) body.pct = Number(v.replace('%', ''));
    else stop('Use on, off or a number from 1 to 100.');
    const a = await st();
    const r = await call('POST', '/api/ambience/light', body);
    say(ambienceLightText(r, nameOf(a && a.lights, id)));
    return;
  }
  if (sub === 'mood') {
    if (!args[1]) stop('Say which mood, for example: ./hub ambience mood dim (./hub ambience scenes lists them).');
    const a = await st();
    const r = await call('POST', '/api/ambience/mood', { id: args[1] });
    say(ambienceMoodText(r, nameOf(a && a.moods, args[1])));
    return;
  }
  if (sub === 'set') {
    const name = args[1];
    if (!name) stop('Say which file holds the settings, or - to read them from standard input. For example: ./hub ambience set ambience.json');
    const r = await call('POST', '/api/ambience/config', { config: readAmbienceFile(name) });
    say(ambienceSetText(r, false));
    return;
  }
  if (sub === 'reset') {
    const r = await call('POST', '/api/ambience/config', { config: null });
    say(ambienceSetText(r, true));
    return;
  }
  stop(use);
}

/* ---------- recent log lines ---------- */

function problemsText(n) {
  return (n === 1 ? '1 problem' : n + ' problems') + ' in the last 24 hours';
}

// "2026-11-17 09:30:05" in the Pi's own time zone (TZ in Docker).
function localTime(iso) {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return String(iso || '');
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// The lines for ./hub log, from a GET /api/log answer: one per log line,
// then the count.
function logLines(r, errorsOnly) {
  const list = (r && r.lines) || [];
  const out = list.map((l) => localTime(l.t) + ' ' + l.text);
  if (!list.length) out.push(errorsOnly ? 'No problems in the log the server keeps.' : 'The log is empty.');
  out.push(problemsText(r && r.errors24h || 0) + '.');
  return out;
}

// The one-line answer for the mailbox's log.tail.
function logSummaryText(r, errorsOnly) {
  const n = ((r && r.lines) || []).length;
  return n + (errorsOnly ? (n === 1 ? ' problem line' : ' problem lines') : (n === 1 ? ' line' : ' lines')) + ', ' + problemsText(r && r.errors24h || 0) + '.';
}

// The query for GET /api/log. lines: 1-200 or undefined.
function logQuery(lines, errorsOnly, scrub) {
  const q = [];
  if (lines !== undefined) q.push('lines=' + lines);
  if (errorsOnly) q.push('errors=1');
  if (scrub) q.push('scrub=1');
  return '/api/log' + (q.length ? '?' + q.join('&') : '');
}

async function logCommand(args) {
  const a = parseArgs(args, ['lines']);
  if (a.words.length || Object.keys(a.opts).some((k) => k !== 'lines' && k !== 'errors')) {
    stop('Use: ./hub log, ./hub log --errors or ./hub log --lines 120. Run ./hub help for examples.');
  }
  let lines;
  if (a.opts.lines !== undefined) {
    lines = /^\d{1,3}$/.test(a.opts.lines) ? Number(a.opts.lines) : 0;
    if (lines < 1 || lines > 200) stop('--lines must be a whole number from 1 to 200.');
  }
  const r = await call('GET', logQuery(lines, !!a.opts.errors, false));
  logLines(r, !!a.opts.errors).forEach(say);
}

/* ---------- help ---------- */

const HELP = [
  'Home Hub commands (run from the pi folder):',
  '  ./hub show weather          open a widget: weather, todo, calendar, entertainment, nowplaying,',
  '                              today (the clock), awws, awws-visits, awws-agenda, awws-todo,',
  '                              awws-reach, awws-money, budget-room, budget-card, budget-goals,',
  '                              budget-lab, investments, allsounds or soundctl (the test widgets)',
  '  ./hub show todo --full      the same, full screen',
  '  ./hub home                  close whatever is open',
  '  ./hub say "Dinner in 10"    a short message on the TV (add --seconds 8)',
  '  ./hub play https://.../a.mp3   play audio on the TV (add --title "Doorbell"); the hub must be open',
  '  ./hub stop                  stop what the TV is playing',
  '  ./hub news                  play the newest NPR News Now newscast (a new one every hour) on the TV',
  '  ./hub reload                load the hub afresh',
  '  ./hub todo add "Buy milk"   add a to-do (add --level must or passive, --due 2026-12-24; optional when left out)',
  '  ./hub todo level "Buy milk" must   change a to-do\'s level: must, optional or passive',
  '  ./hub todo lead "School meeting" 3   a passive to-do shows 3 days before it is due (0 to 30; --clear for 2)',
  '  ./hub todo list             show the to-do list with ids and notes',
  '  ./hub todo add "Buy milk" --notes "Oat, not dairy"   a to-do with notes (up to 300 characters)',
  '  ./hub todo notes "Buy milk" "Oat, not dairy"   set the notes of a to-do (--clear removes them)',
  '  ./hub todo done "Buy milk"  tick a to-do, by id or exact title',
  '  ./hub todo remove "Buy milk"',
  '  ./hub grocery add "Milk" "Eggs"   add to the grocery list (one quoted name per item, up to 20)',
  '  ./hub grocery list          the grocery list with ids, items to get first',
  '  ./hub grocery done "Milk"   tick an item, by id or name; ./hub grocery remove "Milk" takes it off',
  '  ./hub grocery clear         drop every ticked item',
  '  ./hub grocery export        what to search a store for, one line per item to get (brand, name, size)',
  '  ./hub pantry add "Eggs" --qty 12 --at 6 --place fridge   keep an item in the pantry (--brand, --auto off optional)',
  '  ./hub pantry set "Eggs" --qty 2   change how many are left (--at sets "buy more at", --place, --auto on|off)',
  '  ./hub pantry list           what is at home, low items marked; ./hub pantry low lists only the low ones',
  '  ./hub calendar status       each calendar, and the next event',
  '  ./hub calendar refresh      read the calendars again now (after adding an event)',
  '  ./hub layout show           the home-screen tile layout',
  '  ./hub layout set file.json  a new tile layout (a list of tiles; - reads it from input)',
  '  ./hub layout reset          back to the layout in app/config.js',
  '  ./hub awws show             the A World Worth Saving snapshot: when sent, size, sections',
  '  ./hub awws set file.json    store a snapshot (- reads it from input; see docs/awws-snapshot.md)',
  '  ./hub awws resync           ask for a sync now (the routine that reads the board picks it up)',
  '  ./hub awws clear            remove it; the TV tiles say "Not synced yet"',
  '  ./hub budget show           the budget snapshot: when sent, size, sections (no amounts)',
  '  ./hub budget set file.json  store a budget snapshot (- reads it from input; see docs/budget-snapshot.md)',
  '  ./hub budget clear          remove it; the TV tiles say "Waiting for the budget app"',
  '  ./hub budget goal 60        the daily spending goal from today on (no number: when it was set)',
  '  ./hub shows list            the TV show list: still running or ended, what airs next',
  '  ./hub shows add "Stick" --service "Apple TV"   add a show (--id 12345 sets its TVmaze number,',
  '                              --watch Hulu opens another app than the badge says,',
  '                              --also "Hulu,Peacock" lists other apps that carry it,',
  '                              --via "Prime Video" opens it in the app it is billed through,',
  '                              --link 80123456 its id in its app, kept for later; the app opens)',
  '  ./hub shows remove "Stick"  take a show off the list',
  '  ./hub shows refresh         ask TVmaze about every show now (it also does so every 6 hours)',
  '  ./hub shows watched "Stick" S3E4   mark an episode watched by hand (S3E4 left out: the earliest out and unmarked);',
  '                              the TV marks them when you answer "Did you finish?"; ./hub shows unwatch "Stick" S3E4 takes one off',
  '  ./hub shows upto "Stick" S3E4      watched up to and including S3E4 (binge: all before it count too)',
  '  ./hub shows caughtup "Stick"       watched every episode that has aired so far',
  '  ./hub linktests             what the TV\'s watch link test found (About panel on the TV)',
  '  ./hub tvremote              the TV remote from the Pi: paired or not, and the last run\'s steps',
  '  ./hub tvremote run \'<json>\'   a two-step launch: open the app, Enter, then a link (see README.md)',
  '  ./hub spotify status        is Spotify connected, and what is playing',
  '  ./hub spotify login         connect Spotify, once (a link to open, then paste the address back)',
  '  ./hub spotify logout        forget the Spotify sign-in',
  '  ./hub allsounds status      what plays anywhere: Echo speakers (Home Assistant) and Spotify',
  '  ./hub echo status           the Echo targets (show, dot, everywhere) and what the hub started on them',
  '  ./hub echo audible          resume the Audible book on the Echo Show (add --on dot or everywhere)',
  '  ./hub echo kera             KERA 90.1 on the Echo (TuneIn); ./hub echo news plays the Alexa news',
  '  ./hub echo start pandora --query "jazz"   start an app: audible, pandora, amazon-music, tunein (needs --query), kera, news, npr, spotify',
  '  ./hub echo pause            pause, resume, next or stop what is playing (add --on dot)',
  '  ./hub echo volume 40        volume 0 to 100, or up or down',
  '  ./hub ambience status       the room\'s lights: how many answer, which scene is on',
  '  ./hub ambience scenes       the scenes, lights and plant wall moods, with their ids',
  '  ./hub ambience scene chill  apply a scene (a light that doesn\'t answer never stops the others)',
  '  ./hub ambience light geeni 40   one light: on, off or a level from 1 to 100',
  '  ./hub ambience mood dim     a plant wall mood (needs WLED_URL in pi/.env)',
  '  ./hub ambience set file.json   new lights, scenes and moods (see pi/ambience.example.json)',
  '  ./hub ambience reset        back to the defaults (no lights)',
  '  ./hub guest-pin status     is a Guest mode PIN set (the TV asks for it to turn Guest mode on or off)',
  '  ./hub guest-pin reset      forget the PIN; the TV asks you to create a new one next time',
  '  ./hub photos status        the photo album: how many photos, and the last sync from the wall calendar',
  '  ./hub status                is the server running, which screens are on',
  '  ./hub mailbox status        is the Claude mailbox (Cloudflare R2) connected',
  '  ./hub log                   the server\'s last 50 log lines (add --errors, or --lines 120)',
  '  ./hub token                 create the password in pi/.env (only once)'
].join('\n');

/* ---------- grocery (shared with mailbox.js) ---------- */

const MAX_GROCERY_ADD = 20;

function quoted(names) {
  return names.map((n) => '"' + n + '"').join(', ');
}

function groceryCounts(items) {
  const left = items.filter((i) => !i.done).length;
  return { left: left, ticked: items.length - left };
}

function groceryListLines(items) {
  const c = groceryCounts(items);
  if (!items.length) return grocery.listLines(items);
  const sorted = items.filter((i) => !i.done).concat(items.filter((i) => i.done));
  return [c.left + ' to get, ' + c.ticked + ' ticked.'].concat(grocery.listLines(sorted));
}

// Adds names (already split, one item each). Returns { message, data }.
async function groceryAdd(callFn, list) {
  const names = [];
  list.forEach((n) => { if (!names.some((m) => m.toLowerCase() === n.toLowerCase())) names.push(n); });
  const before = (await callFn('GET', '/api/grocery')).items || [];
  const already = names.filter((n) => { const m = grocery.match(before, n.trim()); return m && !m.done; });
  const r = await callFn('POST', '/api/grocery/ops', { ops: names.map((n) => ({ op: 'add', name: n })) });
  const items = r.items || [];
  const added = names.filter((n) => already.indexOf(n) < 0);
  const parts = [];
  if (added.length) parts.push('Added ' + quoted(added) + ' to the grocery list.');
  if (already.length) parts.push('Already on it: ' + quoted(already) + '.');
  parts.push(groceryCounts(items).left + ' to get.');
  return { message: parts.join(' '), data: { added: added.length, already: already.length, left: groceryCounts(items).left } };
}

// sub: done or remove. what: an id or exact name (any case).
async function groceryChange(callFn, sub, what) {
  const items = (await callFn('GET', '/api/grocery')).items || [];
  const item = grocery.match(items, what);
  if (!item) stop('No grocery item has the id or name "' + what + '". Run ./hub grocery list to see them.');
  const op = sub === 'done' ? { op: 'check', id: item.id, done: true } : { op: 'remove', id: item.id };
  await callFn('POST', '/api/grocery/ops', { ops: [op] });
  return { message: (sub === 'done' ? 'Ticked "' : 'Removed "') + item.name + '" on the grocery list.', data: { id: item.id, name: item.name } };
}

async function groceryClear(callFn) {
  const before = (await callFn('GET', '/api/grocery')).items || [];
  const n = groceryCounts(before).ticked;
  if (!n) return { message: 'No ticked grocery items to clear.', data: { cleared: 0 } };
  await callFn('POST', '/api/grocery/ops', { ops: [{ op: 'clear' }] });
  return { message: 'Cleared ' + n + ' ticked grocery ' + (n === 1 ? 'item' : 'items') + '.', data: { cleared: n } };
}

// The shopping-run view: counts and one search text per item still to get.
async function groceryExport(callFn) {
  const r = await callFn('GET', '/api/grocery/export');
  const items = r.items || [];
  const counts = r.counts || groceryCounts(items);
  const todo = items.filter((i) => !i.done);
  const search = todo.map((i) => i.search || i.name);
  // The shopping run by store: "Tom Thumb: 3 ..." (items with no store last).
  const byStore = {};
  todo.forEach((i) => { const k = i.store || ''; (byStore[k] = byStore[k] || []).push(i.search || i.name); });
  const stores = Object.keys(byStore).filter(Boolean).sort();
  const lines = stores.length ? stores.concat(byStore[''] ? [''] : []).reduce((a, k) => a.concat([k ? '[' + k + ']' : '[no store]'], byStore[k]), []) : search;
  const scannedAll = items.filter((i) => i.upc);
  const head = counts.left + ' to get, ' + counts.ticked + ' ticked.' + (scannedAll.length ? ' Scanned: ' + scannedAll.length + ', no brand: ' + scannedAll.filter((i) => !i.brand).length + ', no picture: ' + scannedAll.filter((i) => !i.imagePath).length + '.' : '');
  return {
    message: [head].concat(lines).join('\n'),
    data: { counts: { left: counts.left, ticked: counts.ticked }, search: search, byStore: byStore, scanned: items.filter((i) => !i.done && i.upc).length, noBrand: items.filter((i) => i.upc && !i.brand).length, noPicture: items.filter((i) => i.upc && !i.imagePath).length }
  };
}

/* ---------- pantry (shared with mailbox.js) ---------- */

const PANTRY_PLACES = ['fridge', 'freezer', 'pantry', 'bathroom', 'other'];

function amount(n) { return String(Math.round(n * 1000) / 1000); }

function pantryLine(p) {
  const name = p.brand ? pantrydb.lineName(p.brand, p.name) : p.name;
  const bits = [amount(p.qty) + ' left', 'buy at ' + amount(p.restockAt), p.location];
  if (!p.autoAdd) bits.push('auto-add off');
  if (p.onList) bits.push(p.inCart ? 'in the cart' : 'on the grocery list');
  return (p.low ? '[low] ' : '      ') + name + ' (' + bits.join(', ') + ')   id ' + p.id;
}

async function pantryData(callFn) {
  return (await callFn('GET', '/api/pantry')).data || { products: [] };
}

// An owned product by id or name ("Name" or "Brand Name", any case or accents).
function pantryMatch(list, what) {
  const w = String(what).trim();
  if (/^\d+$/.test(w)) {
    const hit = list.find((p) => p.id === Number(w));
    if (hit) return hit;
  }
  const k = pantrydb.keyOf(w);
  const hits = list.filter((p) => p.owned && (pantrydb.keyOf(p.name) === k || (p.brand && pantrydb.keyOf(p.brand + ' ' + p.name) === k)));
  if (hits.length > 1) stop('More than one pantry item is called "' + w + '"; use its id (./hub pantry list).');
  if (!hits.length) stop('No pantry item has the id or name "' + w + '". Run ./hub pantry list to see them.');
  return hits[0];
}

function pantryAutoText(r) {
  return r.auto ? ' It is low, so it went on the grocery list.' : '';
}

// a: { name, upc, brand, qty, location, restockAt, autoAdd }
async function pantryAdd(callFn, a) {
  const op = { op: 'add' };
  ['name', 'upc', 'brand', 'qty', 'location', 'restockAt', 'autoAdd'].forEach((k) => { if (a[k] !== undefined) op[k] = a[k]; });
  const r = await callFn('POST', '/api/pantry/ops', { ops: [op] });
  const id = r.results && r.results[0] ? r.results[0].id : null;
  const p = (r.data && r.data.products || []).find((x) => x.id === id);
  if (!p) return { message: 'Added to the pantry.', data: { id: id } };
  const name = p.brand ? pantrydb.lineName(p.brand, p.name) : p.name;
  return {
    message: (r.results[0].existed ? 'Added ' + amount(a.qty === undefined ? 1 : a.qty) + ' more "' + name + '": ' : 'Added "' + name + '" to the pantry: ') +
      amount(p.qty) + ' left, buy at ' + amount(p.restockAt) + ', ' + p.location + '.' + pantryAutoText(r),
    data: { id: p.id, name: p.name, brand: p.brand, qty: p.qty, restockAt: p.restockAt, low: p.low, onList: p.onList, autoAdded: r.auto || 0 }
  };
}

// a: { qty, restockAt, location, autoAdd } (at least one)
async function pantrySet(callFn, what, a) {
  const p = pantryMatch((await pantryData(callFn)).products || [], what);
  const ops = [];
  if (a.qty !== undefined || a.restockAt !== undefined) {
    const o = { op: 'set', id: p.id };
    if (a.qty !== undefined) o.qty = a.qty;
    if (a.restockAt !== undefined) o.restockAt = a.restockAt;
    ops.push(o);
  }
  if (a.location !== undefined || a.autoAdd !== undefined) {
    const o = { op: 'edit', id: p.id };
    if (a.location !== undefined) o.location = a.location;
    if (a.autoAdd !== undefined) o.autoAdd = a.autoAdd;
    ops.push(o);
  }
  if (!ops.length) stop('Say what to change: --qty, --at, --place or --auto.');
  const r = await callFn('POST', '/api/pantry/ops', { ops: ops });
  const after = (r.data && r.data.products || []).find((x) => x.id === p.id) || p;
  return {
    message: 'Pantry: ' + pantryLine(after).trim() + '.' + pantryAutoText(r),
    data: { id: after.id, name: after.name, qty: after.qty, restockAt: after.restockAt, location: after.location, autoAdd: after.autoAdd, low: after.low, onList: after.onList, autoAdded: r.auto || 0 }
  };
}

function pantrySummary(p) {
  return { id: p.id, name: p.name, brand: p.brand, qty: p.qty, restockAt: p.restockAt, location: p.location, low: p.low, onList: p.onList, autoAdd: p.autoAdd };
}

async function pantryList(callFn) {
  const d = await pantryData(callFn);
  const owned = (d.products || []).filter((p) => p.owned);
  owned.sort((x, y) => (PANTRY_PLACES.indexOf(x.location) - PANTRY_PLACES.indexOf(y.location)) || (Number(y.low) - Number(x.low)) || x.name.localeCompare(y.name));
  const low = owned.filter((p) => p.low).length;
  const head = owned.length ? owned.length + ' in the pantry, ' + low + ' low.' : 'The pantry is empty.';
  return { message: [head].concat(owned.map(pantryLine)).join('\n'), data: { counts: { items: owned.length, low: low }, items: owned.map(pantrySummary) } };
}

async function pantryLow(callFn) {
  const items = (await callFn('GET', '/api/pantry/low')).items || [];
  const head = items.length ? items.length + ' low in the pantry.' : 'Nothing in the pantry is low.';
  return { message: [head].concat(items.map(pantryLine)).join('\n'), data: { low: items.length, items: items.map(pantrySummary) } };
}

function pantryNumber(v, flag, min, max) {
  const n = Number(v);
  if (v === true || !isFinite(n) || n < min || n > max || Math.floor(n) !== n) stop('--' + flag + ' must be a whole number from ' + min + ' to ' + max + '.');
  return n;
}

function pantryOpts(o) {
  const a = {};
  if (o.qty !== undefined) a.qty = pantryNumber(o.qty, 'qty', 0, 9999);
  if (o.at !== undefined) a.restockAt = pantryNumber(o.at, 'at', 0, 999);
  if (o.place !== undefined) {
    if (PANTRY_PLACES.indexOf(o.place) < 0) stop('--place is one of ' + PANTRY_PLACES.join(', ') + '.');
    a.location = o.place;
  }
  if (o.auto !== undefined) {
    if (o.auto !== 'on' && o.auto !== 'off') stop('--auto is on or off.');
    a.autoAdd = o.auto === 'on';
  }
  return a;
}

async function pantryCmd(args) {
  const sub = args[0];
  const a = parseArgs(args.slice(1), ['qty', 'at', 'place', 'auto', 'brand']);
  const what = a.words.join(' ').trim();
  if (sub === 'add') {
    if (!what) stop('Say what to add, for example: ./hub pantry add "Eggs" --qty 12 --at 6 --place fridge');
    const o = pantryOpts(a.opts);
    o.name = what;
    if (typeof a.opts.brand === 'string') o.brand = a.opts.brand;
    say((await pantryAdd(call, o)).message);
    return;
  }
  if (sub === 'set') {
    if (!what) stop('Say which item, by its id or name. Run ./hub pantry list to see them.');
    say((await pantrySet(call, what, pantryOpts(a.opts))).message);
    return;
  }
  if (sub === 'list') { (await pantryList(call)).message.split('\n').forEach(say); return; }
  if (sub === 'low') { (await pantryLow(call)).message.split('\n').forEach(say); return; }
  stop('Use one of: pantry add, pantry set, pantry list, pantry low. Run ./hub help for examples.');
}

async function groceryCmd(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'add') {
    const names = rest.map((w) => w.trim()).filter(Boolean);
    if (!names.length) stop('Say what to add, for example: ./hub grocery add "Milk" "Eggs"');
    if (names.length > MAX_GROCERY_ADD) stop('At most ' + MAX_GROCERY_ADD + ' items at a time.');
    say((await groceryAdd(call, names)).message);
    return;
  }
  if (sub === 'list') {
    groceryListLines((await call('GET', '/api/grocery')).items || []).forEach(say);
    return;
  }
  if (sub === 'done' || sub === 'remove') {
    const what = rest.join(' ').trim();
    if (!what) stop('Say which item, by its id or name. Run ./hub grocery list to see them.');
    say((await groceryChange(call, sub, what)).message);
    return;
  }
  if (sub === 'clear') { say((await groceryClear(call)).message); return; }
  if (sub === 'export') { (await groceryExport(call)).message.split('\n').forEach(say); return; }
  stop('Use one of: grocery add, grocery list, grocery done, grocery remove, grocery clear, grocery export. Run ./hub help for examples.');
}

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
  if (cmd === 'play') {
    const a = parseArgs(rest, ['title']);
    const url = (a.words[0] || '').trim();
    if (!url) stop('Say what to play, for example: ./hub play https://example.com/doorbell.mp3');
    if (a.words.length > 1) stop('Give one audio address; put a title in --title "...".');
    if (!/^https?:\/\/\S+$/i.test(url)) stop('The address must start with http:// or https://.');
    const data = { url: url };
    if (typeof a.opts.title === 'string' && a.opts.title.trim()) data.title = a.opts.title.trim();
    return command('play', data);
  }
  if (cmd === 'stop') return command('stop', {});
  if (cmd === 'news') {
    let ep;
    try {
      ep = await news.latestPlayable();
    } catch (e) {
      stop('Could not read the NPR News Now feed: ' + (e && e.message) + '.');
    }
    const r = await call('POST', '/api/command', { type: 'play', data: newsPlay(ep) });
    say(newsText(ep, r));
    return;
  }
  if (cmd === 'todo') return todo(rest);
  if (cmd === 'grocery') return groceryCmd(rest);
  if (cmd === 'pantry') return pantryCmd(rest);
  if (cmd === 'calendar') return calendar(rest);
  if (cmd === 'layout') return layout(rest);
  if (cmd === 'awws') return awwsCommand(rest);
  if (cmd === 'budget') return budgetCommand(rest);
  if (cmd === 'shows') return showsCommand(rest);
  if (cmd === 'linktests') return linktestsCommand(rest);
  if (cmd === 'tvremote') return tvremoteCommand(rest);
  if (cmd === 'guest-pin') return guestPinCommand(rest);
  if (cmd === 'photos') return photosCommand(rest);
  if (cmd === 'status') return status();
  if (cmd === 'mailbox') return mailbox(rest);
  if (cmd === 'log') return logCommand(rest);
  if (cmd === 'spotify') return spotifyCmd(rest);
  if (cmd === 'allsounds') return allsoundsCmd(rest);
  if (cmd === 'echo') return echoCommand(rest);
  if (cmd === 'ambience') return ambienceCommand(rest);
  if (cmd === 'token') return token();
  stop('I do not know "' + cmd + '". Run ./hub help to see the commands.');
}

module.exports = {
  Stop: Stop,
  WIDGETS: WIDGETS,
  SECTION_NAMES: SECTION_NAMES,
  LEVEL_NAMES: LEVEL_NAMES,
  levelOf: levelOf,
  todoLevelText: todoLevelText,
  setLevel: setLevel,
  leadOf: leadOf,
  todoLeadText: todoLeadText,
  setLead: setLead,
  MAX_LEAD: MAX_LEAD,
  commandText: commandText,
  newsPlay: newsPlay,
  newsText: newsText,
  matchItem: matchItem,
  MAX_GROCERY_ADD: MAX_GROCERY_ADD,
  groceryListLines: groceryListLines,
  groceryAdd: groceryAdd,
  groceryChange: groceryChange,
  groceryClear: groceryClear,
  groceryExport: groceryExport,
  pantryAdd: pantryAdd,
  pantrySet: pantrySet,
  pantryList: pantryList,
  pantryLow: pantryLow,
  todoAddText: todoAddText,
  todoListLines: todoListLines,
  todoChangeText: todoChangeText,
  todoNotesText: todoNotesText,
  setNotes: setNotes,
  calendarStatusLines: calendarStatusLines,
  calendarRefreshLines: calendarRefreshLines,
  layoutLines: layoutLines,
  layoutSetText: layoutSetText,
  layoutResetText: layoutResetText,
  awwsShowLines: awwsShowLines,
  guestPinStatusText: guestPinStatusText,
  guestPinResetText: guestPinResetText,
  photosStatusText: photosStatusText,
  budgetShowLines: budgetShowLines,
  showsListLines: showsListLines,
  statusLines: statusLines,
  mailboxLines: mailboxLines,
  logLines: logLines,
  logSummaryText: logSummaryText,
  logQuery: logQuery,
  spotifyStatusLines: spotifyStatusLines,
  vibeLine: vibeLine,
  spotifyLoginLines: spotifyLoginLines,
  spotifyCodeText: spotifyCodeText,
  spotifyLogoutText: spotifyLogoutText,
  allsoundsStatusLines: allsoundsStatusLines,
  echoText: echoText,
  echoStatusLines: echoStatusLines,
  ambienceLine: ambienceLine,
  ambienceStatusLines: ambienceStatusLines,
  ambienceScenesLines: ambienceScenesLines,
  ambienceSceneText: ambienceSceneText,
  ambienceLightText: ambienceLightText,
  ambienceMoodText: ambienceMoodText,
  ambienceSetText: ambienceSetText
};

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    if (e instanceof Stop) say(e.message);
    else say('Something went wrong: ' + (e && e.message));
    process.exit(1);
  });
}
