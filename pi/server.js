/*
 * Home Hub live server. It runs on the Raspberry Pi, next to Home Assistant,
 * and is the one place the hub's shared data lives. The TV keeps one open
 * line to it and redraws when something changes. Claude (through hubctl.js)
 * sends it commands and to-do changes.
 *
 * Screen API (no token, home network addresses only, or HUB_TV_IPS):
 *   GET  /live/state     the full current picture
 *   GET  /live/events    the push line (Server-Sent Events)
 *   GET  /live/poll      the fallback for browsers without the push line
 *   POST /todo/ops       to-do changes made on the TV
 *   GET  /touch/state    the touch app's data (grocery, to-dos, the catalog products of the
 *                        codes on it, and the pantry; no screen is registered)
 *   POST /touch/todo/ops to-do changes made in the touch app (the same ops as /todo/ops)
 *   POST /grocery/ops    grocery changes made in the touch app or on the TV (it answers the
 *                        browser's OPTIONS preflight for an Origin on HUB_ORIGINS) ({ op: 'add', upc } names
 *                        the item from the products catalog)
 *   GET  /products/lookup?upc=<code>&format=<hint>   a scanned code: the catalog, then the
 *                        web (products.js) -> { ok, upc, found, product }; needs a same-host
 *                        Origin, Sec-Fetch-Site: same-origin or X-Hub-Touch: 1; 10 web lookups a minute per phone
 *   POST /products/save  { upc, brand, name, size?, photo? } a product typed in by hand
 *   GET  /products/image/<upc>   a product's saved thumbnail
 *   POST /pantry/ops     pantry changes from the touch app (pantrydb.js): add, adjust, set,
 *                        edit, want, remove, brand, category, check, listQty, listMode
 *   POST /pantry/screen-ops   the same ops from the TV (no token; the same trust as the TV's
 *                        POST /grocery/ops: home addresses, a listed Origin, OPTIONS answered).
 *                        The pantry is also a live resource ("pantry") in /live/state
 *   POST /budget/goal    Budget lab's daily goal from the TV: { goal } (whole dollars, 1-1,000),
 *                        from today on (the Pi's local date); past days keep theirs (budgetgoal.js,
 *                        data/budget-goal.json). The history reaches the TV as the budget's pace.goals
 *   POST /guest/pin      the Guest mode PIN from the TV's Clock page (guestpin.js; a screen route:
 *                        home addresses, or only HUB_TV_IPS when set, a listed Origin, OPTIONS answered):
 *                        { action: 'status' | 'check' | 'set', pin }.
 *                        Only a salted scrypt hash is kept (data/guest-pin.json); 3 wrong in a row lock it.
 *                        { all: true, on } with a right PIN turns Guest mode on or off on every screen
 *                        (the "guestall" live resource, prefs.js; server 0.37.0)
 *   POST /prefs          a widget preference shared by every screen: { key, value } (prefs.js KEYS;
 *                        null removes it). The "prefs" live resource carries them all
 *   GET  /photos/list    the photo album (photos.js): { ok, rev, count, items: [{ id, w, h, month, video?, dur? }] },
 *                        newest first, at most 500; rev changes only when the album does.
 *                        video: 1 marks a clip ("live photo"); img/ then gives its still frame
 *   GET  /photos/clip/<id>  a video's small H.264 clip (video/mp4), with Range (206) for players
 *   GET  /photos/img/<id>?size=full|thumb   one photo (image/webp, image/jpeg or image/png),
 *                        Cache-Control: public, max-age=86400, immutable; id is 12 hex digits.
 *                        Both are read only, on the touch door's trust (home and Tailscale
 *                        addresses, even when HUB_TV_IPS is set), so the TV and the tablet can read
 *   GET  /, /app/...     the touch app (app/touch.html) and the files it loads, read only
 *                        (the touch routes accept home and Tailscale addresses even when HUB_TV_IPS is set)
 *   POST /linktests      one watch link test answer from the About panel
 *   POST /tvremote/run   start a two-step launch from the Pi (tvremote.js): { id, appId, ... }
 *   POST /shows/watched  the TV marks an episode watched: { id, season, number }
 *   POST /shows/unwatch  the TV takes a watched mark off an episode: { id, season, number }
 *   POST /shows/upto     the TV marks a show watched up to an episode: { id, season, number }
 *   POST /shows/caughtup the TV marks a show caught up (every aired episode): { id }
 *   GET  /shows/episodes?id=<show id>  a show's seasons and episodes with watched flags and progress
 *   POST /tv/launch      open an app, key or webhook on the TV from a tablet or phone (tvlaunch.js): 202 at once
 *   POST /echo/run       the Echo controls from the TV (soundctl.js): presets only, rate limited
 *   POST /ambience/scene, /ambience/light, /ambience/mood   the room's lights
 *                        from the TV (ambience.js): saved ids only, rate limited
 *   GET  /spotify/callback   where Spotify's sign-in page can land (see spotify.js)
 *
 * Control API (needs "Authorization: Bearer <token>"):
 *   POST /api/command    show / home / say / reload on every screen now on
 *   GET  /api/todo       the to-do list
 *   POST /api/todo       add one to-do
 *   POST /api/todo/ops   several to-do changes at once
 *   GET  /api/grocery    the grocery list (grocery.js)
 *   POST /api/grocery/ops  grocery changes: add, check, remove, clear
 *   GET  /api/grocery/export   the list for a shopping run: each item with its product's
 *                        brand, name, size and a "search" text (products.js), and
 *                        store (the product's preferred store), fromPantry / reason (low, manual or '') from the pantry
 *   GET  /api/pantry     the pantry (pantrydb.js, SQLite data/pantry.db): products, brands, categories
 *   POST /api/pantry/ops pantry changes (the same ops as POST /pantry/ops)
 *   GET  /api/pantry/low the pantry items at or under their restock point
 *   GET  /api/products?upc=<code>   look a code up (the catalog, then the web)
 *   GET  /api/products/image?upc=<code>   a product's saved thumbnail (JPEG, PNG or WebP)
 *   GET  /api/layout     the home-screen tile layout (null = the hub's own)
 *   POST /api/layout     set it, { layout: [...] }, or { layout: null } to reset
 *   GET  /api/awws       the A World Worth Saving snapshot (awws.js)
 *   POST /api/awws       store one, { snapshot: {...} }, or { snapshot: null } to clear
 *   GET  /api/budget     the personal budget snapshot (budget.js)
 *   POST /api/budget     store one (sent by the budget app on the Pi), or null to clear
 *   GET  /api/budget/goal    the daily spending goal's history (budgetgoal.js)
 *   GET  /api/prefs      the shared widget preferences: keys and when each was set (never values)
 *   POST /api/budget/goal    { goal }: a whole-dollar daily goal from today (the Pi's date) on
 *   GET  /api/shows      the show list and the schedule from TVmaze (shows.js)
 *   POST /api/shows      { add: {name, service, ...} }, { remove: "name" } or { set: [...] }
 *   POST /api/shows/refresh   ask TVmaze about every show now and wait for it
 *   POST /api/shows/watched   { show, episode? }: mark an episode watched (none named = the earliest out and unmarked)
 *   POST /api/shows/unwatch   { show, episode }: take a watched mark off
 *   POST /api/shows/upto      { show, episode }: watched up to and including that episode
 *   POST /api/shows/caughtup  { show }: watched every episode aired so far
 *   GET  /api/linktests  the TV's watch link test answers (linktests.js)
 *   GET  /api/tv         what Home Assistant knows about the TV and the last launch (tvlaunch.js)
 *   POST /api/tv/launch  the same body as POST /tv/launch
 *   GET  /api/tvremote   the TV remote from the Pi: paired or not, last run and its steps (tvremote.js)
 *   POST /api/tvremote/run   start a run, the same body as POST /tvremote/run
 *   GET  /api/status     version, rev, connected screens, calendar summary
 *   GET  /api/log        the last log lines kept in memory (?lines=1-200,
 *                        ?errors=1 for problems only, ?scrub=1 hides addresses
 *                        and names; see logscrub.js)
 *   GET  /api/calendar   the calendar events (never the secret links)
 *   POST /api/calendar/refresh   read every calendar now and wait for it
 *   GET  /api/spotify    is Spotify set up and signed in, and what is playing
 *   POST /api/spotify/login    make a sign-in link
 *   POST /api/spotify/code     finish signing in, { input: the pasted address }
 *   POST /api/spotify/logout   forget the sign-in
 *   POST /api/spotify/refresh  ask Spotify what is playing right now
 *   GET  /api/allsounds  what plays anywhere in the house (allsounds.js): state,
 *                        source, speaker, title and artist
 *   GET  /api/echo       the Echo controls: targets and what the hub started (echo.js)
 *   POST /api/echo      { action, target?, app?, query?, level? }: start an app on an
 *                        Echo, or pause, resume, next, stop, volume (server 0.22.0)
 *   GET  /api/ambience   the room's lights, scenes and plant wall (ambience.js)
 *   POST /api/ambience/scene   apply a scene, { id }
 *   POST /api/ambience/light   one light, { id, on?, pct? }
 *   POST /api/ambience/mood    a plant wall mood, { id }
 *   GET  /api/ambience/config  the saved lights, scenes and moods
 *   POST /api/ambience/config  replace them, { config }, or { config: null } for the defaults
 *   GET  /health         no token, just "is it running", and app: the BUILD of the
 *                        hub.js it serves (server 0.32.0; app/appver.js compares it
 *                        with its own, so the tablet and phone reload after a pull)
 *
 * The Claude mailbox (mailbox.js, off unless HUB_MAILBOX_ settings are in
 * .env) polls a Cloudflare R2 bucket and runs the same control API calls.
 *
 * The full contract is in docs/live-updates.md ("Reference for builders").
 *
 * Commands are never stored for a TV that is off. Only the fallback poll
 * remembers them, for 10 seconds, at most 20. With no TV connected the
 * server holds nothing open. Data (the to-do list, the calendar events, the
 * tile layout, the A World Worth Saving and budget snapshots) lives in
 * data/state.json. The calendar reader is in calendar.js, the snapshot checks
 * in awws.js and budget.js,
 * what plays on Spotify comes from spotify.js, and what plays on any speaker
 * (Home Assistant's Echo speakers plus Spotify) from allsounds.js.
 * what plays on Spotify comes from spotify.js, and the room's lights
 * (Home Assistant, and the plant wall's WLED) from ambience.js.
 *
 *   POST /api/translate  { to: "es", texts: [...] } -> { map } (translate.js; the TV uses POST /translate)
 *   GET  /api/translate/usage -> lines, Gemini calls, tokens and estimated cost today, this month, in all
 *   GET  /api/guest-pin  -> { set, locked_for } (never the PIN or its hash)
 *   GET  /api/photos     -> { count, lastRun, syncOk, newCount, store }: the photo album and its last
 *                        sync from the wall calendar (photos-sync.sh on the Pi host); counts only
 *   POST /api/guest-pin/reset -> { removed }: forget the Guest mode PIN; the TV asks for a new one (./hub guest-pin reset)
 *
 * Node 14 or newer, no npm packages. Run it with: node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const calendar = require('./calendar');
const todoconvert = require('./todoconvert');
const gcal = require('./gcal');
const awws = require('./awws');
const budget = require('./budget');
const mailbox = require('./mailbox');
const spotify = require('./spotify');
const shows = require('./shows');
const linktests = require('./linktests');
const tvremote = require('./tvremote');
const tvlaunch = require('./tvlaunch');
const ambience = require('./ambience');
const logscrub = require('./logscrub');
const allsounds = require('./allsounds');
const echo = require('./echo');
const translate = require('./translate');
const grocery = require('./grocery');
const products = require('./products');
const pantrydb = require('./pantrydb');
const guestpin = require('./guestpin');
const photos = require('./photos');
const budgetgoal = require('./budgetgoal');
const prefs = require('./prefs');

const SERVER_VERSION = '0.39.0';
const PROTOCOL = 1;

const DEFAULT_PORT = 8097;
const DEFAULT_ORIGINS = ['http://127.0.0.1:8081'];
const MIN_TOKEN = 24;
const BODY_LIMIT = 8 * 1024;
const AWWS_BODY_LIMIT = 64 * 1024; // POST /api/awws and /api/budget only; a snapshot is at most 48 KB
const PRODUCT_BODY_LIMIT = 220 * 1024; // POST /products/save only: a photo of at most 150 KB, as base64
const MAX_SSE = 20;
const MAX_POLLS = 20;
const MAX_COMMANDS = 20;
const MAX_ITEMS = 200;
const MAX_OPS = 100;
const MAX_ITEM_BYTES = 2000; // room for full notes in any script
const MAX_TITLE = 80;
const MAX_NOTES = 300;
const MAX_SAY = 140;
// play: an audio address the TV plays (http or https only), and its title.
const MAX_PLAY_URL = 2048;
const MAX_PLAY_TITLE = 140;
const DONE_KEEP_MS = 48 * 60 * 60 * 1000;
const SSE_MAX_BUFFER = 64 * 1024; // a screen this far behind is dropped
const SECTIONS = ['now', 'next', 'waiting'];
const LEVELS = ['must', 'optional', 'passive'];
const MAX_LEAD = 30; // a passive to-do's "Coming up" lead, in days
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DUE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WIDGET_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GRID_COLS = 12;
const GRID_ROWS = 6;
const MAX_TILES = 24;
const TILE_ID_RE = /^[a-z0-9-]{1,32}$/;
const LOG_KEEP = 400;      // log lines kept in memory for GET /api/log
const LOG_LINES = 50;      // the default answer
const LOG_MAX_LINES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- small helpers ---------- */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Copies plain fields, skipping keys that could change an object's prototype.
function copyPlain(src) {
  const out = {};
  Object.keys(src).forEach((k) => {
    if (!BAD_KEYS.has(k)) out[k] = src[k];
  });
  return out;
}

function toList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function randomBase36(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += (bytes[i] % 36).toString(36);
  return s;
}

function newTodoId() {
  return 'p' + Date.now().toString(36) + randomBase36(3);
}

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------- .env reader ---------- */

// Reads KEY=value lines. "#" starts a comment line. Values may be wrapped in
// single or double quotes. Returns {} when the file is missing.
function parseEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t[0] === '#') return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) return;
    let v = m[2];
    if ((v[0] === '"' || v[0] === "'") && v.length >= 2 && v[v.length - 1] === v[0]) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, '').trim(); // "value  # note" drops the note
    }
    out[m[1]] = v;
  });
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

// .env values, with real environment variables winning. An empty
// environment variable counts as not set.
function loadSettings(file) {
  const fromFile = readEnvFile(file);
  const out = Object.assign({}, fromFile);
  Object.keys(process.env).forEach((k) => {
    if (/^(HUB_|CALENDAR_|SPOTIFY_|HA_|ALLSOUNDS_|WLED_|GEMINI_VIDEO_GEN_KEY$)/.test(k) && process.env[k] !== '') out[k] = process.env[k];
  });
  return out;
}

/* ---------- addresses ---------- */

// Strips the "::ffff:" that IPv4 addresses get on a dual-stack socket.
function plainAddress(ip) {
  let a = String(ip || '').trim().toLowerCase();
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct); // fe80::1%eth0
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return m ? m[1] : a;
}

function ipv4Parts(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function isLoopback(ip) {
  const a = plainAddress(ip);
  const p = ipv4Parts(a);
  if (p) return p[0] === 127;
  return a === '::1';
}

// True for loopback, home-network and Tailscale addresses: 10/8, 172.16/12,
// 192.168/16, 169.254/16, 127/8, 100.64/10 (Tailscale), ::1, fc00::/7
// (Tailscale's IPv6 range fd7a:115c:a1e0::/48 is inside it), fe80::/10.
function isPrivateAddress(ip) {
  const a = plainAddress(ip);
  const p = ipv4Parts(a);
  if (p) {
    return p[0] === 10 || p[0] === 127 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  if (a === '::1') return true;
  if (!/^[0-9a-f:]+$/.test(a) || a.indexOf(':') < 0) return false;
  const first = a.split(':')[0];
  if (!first) return false; // "::something" other than ::1
  const n = parseInt(first, 16);
  if ((n & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((n & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

// tvIps empty: any private or loopback address. Otherwise those plus loopback.
function screenAllowed(ip, tvIps) {
  if (tvIps && tvIps.length) {
    if (isLoopback(ip)) return true;
    const a = plainAddress(ip);
    return tvIps.some((t) => plainAddress(t) === a);
  }
  return isPrivateAddress(ip);
}

// A page on another site can point its own name at the Pi's address (called
// DNS rebinding) and then read the lists through a browser at home. Such a
// request still carries that site's name in its Host header, so the screen
// side only answers when Host is an IP address, localhost, a .local name or a
// Tailscale name (.ts.net).
function hostAllowed(hostHeader) {
  let h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return true; // no browser leaves Host out
  if (h[0] === '[') return h.indexOf(']') > 0; // an IPv6 address
  h = h.replace(/:\d+$/, '');
  return h === 'localhost' || /\.local$/.test(h) || /\.ts\.net$/.test(h) || ipv4Parts(h) !== null;
}

/* ---------- to-do validation ---------- */

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// Checks and tidies one item. Throws a 400 error naming the problem.
function normalizeItem(raw, now) {
  if (!isObj(raw)) throw bad('each to-do item must be an object');
  const it = copyPlain(raw);
  if (typeof it.id !== 'string' || !ID_RE.test(it.id)) {
    throw bad('to-do id must be 1 to 40 letters, digits, "_" or "-"');
  }
  if (typeof it.title !== 'string') throw bad('to-do title must be text');
  it.title = it.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const len = Array.from(it.title).length;
  if (len < 1) throw bad('to-do title is empty');
  if (len > MAX_TITLE) throw bad('to-do title is longer than ' + MAX_TITLE + ' characters');
  if (it.section === undefined || it.section === null) it.section = 'now';
  if (SECTIONS.indexOf(it.section) < 0) throw bad('to-do section must be now, next or waiting');
  // Optional level; none means optional (and is how older items stay).
  if (it.level === undefined || it.level === null || it.level === '') delete it.level;
  else if (LEVELS.indexOf(it.level) < 0) throw bad('to-do level must be must, optional or passive');
  // Optional lead: how many days before its due date a passive item shows
  // under "Coming up". None means the TV's default (2).
  if (it.lead === undefined || it.lead === null || it.lead === '') delete it.lead;
  else if (!Number.isInteger(it.lead) || it.lead < 0 || it.lead > MAX_LEAD) throw bad('to-do lead must be a whole number of days from 0 to ' + MAX_LEAD);
  if (it.done === undefined || it.done === null) it.done = false;
  if (typeof it.done !== 'boolean') throw bad('to-do "done" must be true or false');
  if (it.done) {
    if (typeof it.doneAt !== 'number' || !isFinite(it.doneAt)) it.doneAt = now;
  } else {
    it.doneAt = null;
  }
  if (it.createdAt === undefined || it.createdAt === null) it.createdAt = now;
  if (typeof it.createdAt !== 'number' || !isFinite(it.createdAt)) throw bad('to-do createdAt must be a number');
  if (it.due === undefined || it.due === null || it.due === '') {
    delete it.due;
  } else if (typeof it.due !== 'string' || !DUE_RE.test(it.due)) {
    throw bad('to-do due date must look like 2026-12-31');
  }
  // Optional notes: one paragraph of plain text. Empty or null removes them,
  // so an item never carries empty notes.
  if (it.notes === undefined || it.notes === null) {
    delete it.notes;
  } else {
    if (typeof it.notes !== 'string') throw bad('to-do notes must be text');
    it.notes = it.notes.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!it.notes) delete it.notes;
    else if (Array.from(it.notes).length > MAX_NOTES) throw bad('to-do notes are longer than ' + MAX_NOTES + ' characters');
  }
  if (Buffer.byteLength(JSON.stringify(it)) > MAX_ITEM_BYTES) {
    throw bad('a to-do item is larger than ' + MAX_ITEM_BYTES + ' bytes');
  }
  return it;
}

function purgeOld(items, now) {
  return items.filter((it) => !(it.done && typeof it.doneAt === 'number' && now - it.doneAt > DONE_KEEP_MS));
}

// Applies ops to a copy of items. Throws on the first bad op, so a batch is
// all or nothing.
function applyOps(items, ops, now) {
  if (!Array.isArray(ops)) throw bad('"ops" must be a list');
  if (ops.length > MAX_OPS) throw bad('too many ops (at most ' + MAX_OPS + ')');
  let list = purgeOld(items.slice(), now);
  const indexOf = (id) => list.findIndex((it) => it.id === id);

  function setFields(i, fields, to) {
    if (!isObj(fields)) throw bad('"fields" must be an object');
    const merged = copyPlain(list[i]);
    Object.keys(fields).forEach((k) => {
      if (k === 'id' || BAD_KEYS.has(k)) return;
      merged[k] = fields[k];
    });
    const item = normalizeItem(merged, now);
    if (to === 'end') {
      list.splice(i, 1);
      list.push(item);
    } else {
      list[i] = item;
    }
  }

  ops.forEach((op, n) => {
    const where = ' (op ' + (n + 1) + ')';
    if (!isObj(op)) throw bad('each op must be an object' + where);
    try {
      if (op.op === 'add') {
        if (!isObj(op.item)) throw bad('"add" needs an "item" object');
        if (op.at !== undefined && op.at !== 'top' && op.at !== 'end') throw bad('"at" must be "top" or "end"');
        const raw = copyPlain(op.item);
        if (raw.id === undefined || raw.id === null || raw.id === '') raw.id = newTodoId();
        const existing = typeof raw.id === 'string' ? indexOf(raw.id) : -1;
        if (existing >= 0) {
          setFields(existing, raw);
          return;
        }
        const item = normalizeItem(raw, now);
        if (list.length >= MAX_ITEMS) throw bad('the to-do list is full (' + MAX_ITEMS + ' items)');
        if (op.at === 'top') list.unshift(item);
        else list.push(item);
      } else if (op.op === 'set') {
        if (typeof op.id !== 'string' || !ID_RE.test(op.id)) throw bad('"set" needs a valid "id"');
        if (op.to !== undefined && op.to !== null && op.to !== 'end') throw bad('"to" can only be "end"');
        if (!isObj(op.fields)) throw bad('"set" needs a "fields" object');
        const i = indexOf(op.id);
        if (i >= 0) setFields(i, op.fields, op.to);
      } else if (op.op === 'remove') {
        if (typeof op.id !== 'string' || !ID_RE.test(op.id)) throw bad('"remove" needs a valid "id"');
        const i = indexOf(op.id);
        if (i >= 0) list.splice(i, 1);
      } else {
        throw bad('unknown op "' + String(op.op).slice(0, 20) + '" (use add, set or remove)');
      }
    } catch (e) {
      if (e.status === 400 && e.message.indexOf(' (op ') < 0) e.message += where;
      throw e;
    }
  });
  return list;
}

/* ---------- layout ---------- */

// Checks a home-screen layout: null (the hub's built-in one) or a list of
// { widget, x, y, w, h } on the 12 x 6 grid. Returns a tidy copy with only
// those fields, or throws a 400 error that names the entry and the problem.
function normalizeLayout(raw) {
  if (raw === null) return null;
  if (!Array.isArray(raw)) throw bad('"layout" must be a list of tiles, or null for the built-in layout');
  if (!raw.length) throw bad('the layout has no tiles (send null to go back to the built-in layout)');
  if (raw.length > MAX_TILES) throw bad('too many tiles (at most ' + MAX_TILES + ')');
  const out = [];
  const seen = {};
  raw.forEach((e, n) => {
    const where = ' (tile ' + (n + 1) + ')';
    if (!isObj(e)) throw bad('each tile must be an object' + where);
    const id = e.widget;
    if (typeof id !== 'string' || !TILE_ID_RE.test(id)) {
      throw bad('"widget" must be 1 to 32 of a-z, 0-9 or "-"' + where);
    }
    const name = ' (tile ' + (n + 1) + ', ' + id + ')';
    if (Object.prototype.hasOwnProperty.call(seen, id)) throw bad('"' + id + '" is in the layout twice' + name);
    ['x', 'y', 'w', 'h'].forEach((k) => {
      if (typeof e[k] !== 'number' || !Number.isInteger(e[k])) throw bad('"' + k + '" must be a whole number' + name);
    });
    if (e.x < 0 || e.y < 0) throw bad('"x" and "y" must be 0 or more' + name);
    if (e.w < 1 || e.h < 1) throw bad('"w" and "h" must be 1 or more' + name);
    if (e.x + e.w > GRID_COLS) throw bad('the tile runs past the right edge (x + w is at most ' + GRID_COLS + ')' + name);
    if (e.y + e.h > GRID_ROWS) throw bad('the tile runs past the bottom edge (y + h is at most ' + GRID_ROWS + ')' + name);
    const hit = out.find((o) => e.x < o.x + o.w && o.x < e.x + e.w && e.y < o.y + o.h && o.y < e.y + e.h);
    if (hit) throw bad('the tile overlaps "' + hit.widget + '"' + name);
    seen[id] = true;
    out.push({ widget: id, x: e.x, y: e.y, w: e.w, h: e.h });
  });
  return out;
}

// The layout resource from a state file; anything damaged or missing means
// "the built-in layout".
function cleanLayoutResource(r) {
  const rev = isObj(r) && typeof r.rev === 'number' && r.rev >= 0 ? r.rev : 0;
  let layout = null;
  try {
    if (isObj(r) && isObj(r.data) && r.data.layout !== undefined) layout = normalizeLayout(r.data.layout);
  } catch (e) { /* a broken layout falls back to the built-in one */ }
  return { rev: rev, data: { layout: layout } };
}

/* ---------- commands ---------- */

function normalizeCommand(body) {
  if (!isObj(body)) throw bad('the command must be a JSON object');
  const type = body.type;
  const data = body.data === undefined || body.data === null ? {} : body.data;
  if (!isObj(data)) throw bad('"data" must be an object');
  if (type === 'show') {
    if (typeof data.widget !== 'string' || !WIDGET_RE.test(data.widget)) {
      throw bad('"show" needs a widget name, like weather, todo or entertainment');
    }
    const mode = data.mode === undefined || data.mode === null ? 'panel' : data.mode;
    if (mode !== 'panel' && mode !== 'full') throw bad('"mode" must be panel or full');
    return { type: type, data: { widget: data.widget, mode: mode } };
  }
  if (type === 'say') {
    if (typeof data.text !== 'string') throw bad('"say" needs some text');
    const text = data.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!text) throw bad('"say" needs some text');
    if (Array.from(text).length > MAX_SAY) throw bad('the text is longer than ' + MAX_SAY + ' characters');
    const out = { text: text };
    if (data.seconds !== undefined && data.seconds !== null) {
      const s = data.seconds;
      if (typeof s !== 'number' || !isFinite(s) || s < 1 || s > 60) throw bad('"seconds" must be a number from 1 to 60');
      out.seconds = s;
    }
    return { type: type, data: out };
  }
  if (type === 'play') {
    if (typeof data.url !== 'string') throw bad('"play" needs an audio address');
    const url = data.url.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw bad('"url" must be an http or https address');
    if (url.length > MAX_PLAY_URL) throw bad('"url" is longer than ' + MAX_PLAY_URL + ' characters');
    const out = { url: url };
    if (data.title !== undefined && data.title !== null) {
      if (typeof data.title !== 'string') throw bad('"title" must be text');
      const title = data.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      if (Array.from(title).length > MAX_PLAY_TITLE) throw bad('"title" is longer than ' + MAX_PLAY_TITLE + ' characters');
      if (title) out.title = title;
    }
    return { type: type, data: out };
  }
  if (type === 'home' || type === 'reload' || type === 'stop') return { type: type, data: {} };
  throw bad('unknown command type (use show, home, say, play, stop or reload)');
}

/* ---------- state file ---------- */

function freshState() {
  return {
    epoch: crypto.randomBytes(6).readUIntBE(0, 6).toString(36),
    rev: 0,
    resources: {
      todo: { rev: 0, data: { items: [] } },
      grocery: { rev: 0, data: grocery.emptyData() },
      calendar: { rev: 0, data: calendar.unconfiguredData() },
      layout: { rev: 0, data: { layout: null } },
      awws: { rev: 0, data: awws.emptyData() },
      budget: { rev: 0, data: budget.emptyData() },
      nowplaying: { rev: 0, data: spotify.offData() },
      shows: { rev: 0, data: shows.emptyData() },
      linktests: { rev: 0, data: linktests.emptyData() },
      allsounds: { rev: 0, data: allsounds.notsetData() },
      ambience: { rev: 0, data: ambience.notsetData('noha') },
      prefs: { rev: 0, data: prefs.emptyData() },
      guestall: { rev: 0, data: prefs.guestEmpty() }
    }
  };
}

// Loads state.json, or starts a new one. A broken file is moved aside.
function loadState(dir, log) {
  const file = path.join(dir, 'state.json');
  fs.mkdirSync(dir, { recursive: true });
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const st = freshState();
    saveState(dir, st);
    log('started a new data file ' + file);
    return st;
  }
  try {
    const st = JSON.parse(text);
    if (!isObj(st) || typeof st.epoch !== 'string' || !st.epoch ||
        typeof st.rev !== 'number' || !(st.rev >= 0) || Math.floor(st.rev) !== st.rev ||
        !isObj(st.resources)) {
      throw new Error('missing epoch, rev or resources');
    }
    const todo = isObj(st.resources.todo) ? st.resources.todo : { rev: 0, data: { items: [] } };
    const raw = isObj(todo.data) && Array.isArray(todo.data.items) ? todo.data.items : [];
    const now = Date.now();
    const items = [];
    const seen = {};
    raw.forEach((r) => {
      try {
        const it = normalizeItem(r, now);
        if (!seen[it.id] && items.length < MAX_ITEMS) { seen[it.id] = 1; items.push(it); }
      } catch (e) { /* skip one bad item, keep the rest */ }
    });
    st.resources.todo = { rev: typeof todo.rev === 'number' ? todo.rev : 0, data: { items: items } };
    // The grocery list (grocery.js): empty in older files.
    st.resources.grocery = grocery.cleanResource(st.resources.grocery);
    // Older files have no calendar; a damaged one is rebuilt from known fields.
    st.resources.calendar = calendar.cleanResource(st.resources.calendar);
    // Older files have no layout either: null, the hub's built-in one.
    st.resources.layout = cleanLayoutResource(st.resources.layout);
    // Older files have no A World Worth Saving snapshot: empty, "Not synced yet".
    st.resources.awws = awws.cleanResource(st.resources.awws);
    // Nor a budget snapshot: empty, "Waiting for the budget app".
    st.resources.budget = budget.cleanResource(st.resources.budget);
    // And no "now playing"; picture addresses are checked again on the way in.
    st.resources.nowplaying = spotify.cleanResource(st.resources.nowplaying, true);
    // The TV show schedule (shows.js) and the watch link test answers: empty
    // in older files.
    st.resources.shows = shows.cleanResource(st.resources.shows);
    st.resources.linktests = linktests.cleanResource(st.resources.linktests);
    // Nor "all sounds" (allsounds.js), cleaned the same way.
    st.resources.allsounds = allsounds.cleanResource(st.resources.allsounds, true);
    // Nor the room's lights (ambience.js), rebuilt from known fields.
    st.resources.ambience = ambience.cleanResource(st.resources.ambience);
    // Widget preferences shared by every screen, and the last Guest mode
    // "All screens" choice (prefs.js): empty in older files.
    st.resources.prefs = prefs.cleanResource(st.resources.prefs);
    st.resources.guestall = prefs.guestClean(st.resources.guestall);
    return st;
  } catch (e) {
    const aside = path.join(dir, 'state.bad-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    try { fs.renameSync(file, aside); } catch (e2) { /* nothing more to do */ }
    log('the data file was damaged (' + e.message + '); moved it to ' + aside + ' and started fresh');
    const st = freshState();
    saveState(dir, st);
    return st;
  }
}

// Atomic write: a temp file next to it, then rename over the old one.
function saveState(dir, st) {
  const file = path.join(dir, 'state.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

/* ---------- the server ---------- */

function start(options) {
  const opt = options || {};
  const token = typeof opt.token === 'string' ? opt.token : '';
  const tokenOk = token.length >= MIN_TOKEN;
  const tokenBuf = Buffer.from(token);
  const port = opt.port !== undefined && opt.port !== null && opt.port !== '' ? Number(opt.port) : DEFAULT_PORT;
  const tunnelPortWanted = opt.tunnelPort !== undefined && opt.tunnelPort !== null && opt.tunnelPort !== ''
    ? Number(opt.tunnelPort) : null;
  const tvIps = toList(opt.tvIps);
  const origins = opt.origins !== undefined && toList(opt.origins).length ? toList(opt.origins) : DEFAULT_ORIGINS;
  const dataDir = path.resolve(__dirname, opt.dataDir || 'data');
  const pingMs = opt.pingInterval || 20000;
  const pollMs = opt.pollWait || 25000;
  const commandTtl = opt.commandTtl || 10000;
  const clientAddress = typeof opt.clientAddress === 'function'
    ? opt.clientAddress : (req) => (req.socket && req.socket.remoteAddress) || '';
  const logFn = opt.log === false ? () => {} : (typeof opt.log === 'function' ? opt.log : (s) => console.log(s));
  // The last LOG_KEEP lines also stay in memory, without the time stamp, for
  // GET /api/log. quiet: print only, keep nothing (reading the log must not
  // fill it).
  const ring = []; // { t, text, level }
  const remember = (text) => {
    try {
      ring.push({ t: new Date().toISOString(), text: text, level: logscrub.level(text) });
      if (ring.length > LOG_KEEP) ring.shift();
    } catch (e) { /* logging must never break a request */ }
  };
  const log = (s, quiet) => {
    try {
      const text = String(s);
      if (!quiet) remember(text);
      logFn(stamp() + ' ' + text);
    } catch (e) { /* logging must never break a request */ }
  };
  const startedAt = Date.now();

  // The TV's remote from the Pi (tvremote.js). HUB_TV_REMOTE_IP (opt.tvRemoteIp)
  // names the TV; otherwise the address its screen calls from.
  const remote = tvremote.create(Object.assign({ dataDir: dataDir, log: log, host: opt.tvRemoteIp || '' }, isObj(opt.tvremote) ? opt.tvremote : {}));

  // Open things on the TV from the Pi (tvlaunch.js): Home Assistant first, then the remote link.
  const tvLauncher = tvlaunch.create(Object.assign({ config: tvlaunch.configFromEnv(opt.tvLaunchEnv || {}), remote: remote, log: log }, isObj(opt.tvlaunch) ? opt.tvlaunch : {}));

  let state = loadState(dataDir, log);
  // The daily spending goal's history (budgetgoal.js, data/budget-goal.json),
  // owned here: merged into the budget's pace section as pace.goals.
  let goalHistory = budgetgoal.load(dataDir);
  state.resources.budget.data = budgetgoal.attach(state.resources.budget.data, goalHistory);
  // The Guest mode PIN (guestpin.js): a hash in data/guest-pin.json, wrong tries counted in memory.
  const guestPin = guestpin.create(Object.assign({ dataDir: dataDir, log: log }, isObj(opt.guestpin) ? opt.guestpin : {}));
  // The photo album (photos.js): data/photos/, filled by photos-sync.sh on the
  // Pi host. Logs counts only, never a file name or an id.
  const album = photos.createLocalStore({ dir: path.join(dataDir, 'photos') });
  let albumRev = null;
  function albumList() {
    return album.list().then((v) => {
      if (albumRev !== null && v.rev !== albumRev) log('photos: the album now has ' + v.count + ' photos');
      albumRev = v.rev;
      return v;
    });
  }
  albumList().then((v) => { if (v.count) log('photos: ' + v.count + ' in the album'); }, () => {});
  const sse = new Set();      // { res, since, address }
  const polls = new Set();    // { res, epoch, rev, cursor, timer, address }
  const pollSeen = new Map(); // address -> { since, last }
  let remembered = [];        // [{ num, at, cmd }], only for poll screens
  let commandNum = Date.now(); // grows across restarts, so old cursors stay older
  let pingTimer = null;
  let forgetTimer = null;
  let closing = false;

  if (!tokenOk) log('no token set (or shorter than ' + MIN_TOKEN + ' characters): the control API is off, screens still work');

  /* --- calendar --- */

  // opt.calendars is a list of { name, url, details }; opt.calendarEnv is the
  // .env settings (CALENDAR_1_NAME ...). Links are never logged.
  const allowHttp = opt.allowHttp === true;
  const calTz = calendar.timezone(opt.timezone, log);
  const calList = calendar.checkCalendars(
    Array.isArray(opt.calendars) ? opt.calendars : calendar.calendarsFromEnv(opt.calendarEnv || {}), log, allowHttp);
  const calWaitMs = opt.calendarWait || 25000;
  // Calendar events titled TODO: / TODO!: / TODO~: become to-dos right here,
  // each time the calendars are read (todoconvert.js; no Claude task).
  const todoConv = opt.todoConvert === false ? null : todoconvert.create({
    dataDir: dataDir, log: log, tz: calTz,
    items: () => todoItems(),
    // A ticked to-do's event is deleted in Google through a service account
    // (gcal.js, key in data/google-calendar-key.json); no key, no deletes.
    remover: opt.gcal === false ? null : (opt.gcal || gcal.create({ dataDir: dataDir })),
    calendarId: (cal) => { const c = calList.find((x) => x.cal === cal); return c ? calendar.ownerOf(c.url) : ''; },
    add: (list) => {
      const now = Date.now();
      const items = purgeOld(todoItems(), now);
      if (items.length + list.length > MAX_ITEMS) return false;
      const made = list.map((r) => normalizeItem(Object.assign({ id: newTodoId(), done: false, doneAt: null, createdAt: now }, r), now));
      return changeTodo(made.concat(items)) || made.length === 0;
    }
  });
  const calReader = calendar.createReader({
    convert: todoConv ? (events, t) => todoConv.convert(events, t) : null,
    hide: todoConv ? (ev) => todoConv.hides(ev) : null,
    calendars: calList,
    tz: calTz,
    refreshMs: calendar.refreshMinutes(opt.refreshMinutes, log) * 60000,
    allowHttp: allowHttp,
    timeoutMs: opt.calendarTimeout,
    now: typeof opt.now === 'function' ? opt.now : () => new Date(),
    log: log,
    current: () => state.resources.calendar.data,
    publish: (data, changed) => {
      if (!changed) {
        // Only the "read at" times moved: keep them in memory, no push, no write.
        state.resources.calendar = { rev: state.resources.calendar.rev, data: data };
        return;
      }
      try {
        changeResource('calendar', data);
        log('calendar changed: ' + data.events.length + ' events (rev ' + state.rev + ')');
      } catch (e) { /* changeResource already logged it */ }
    }
  });
  if (calList.length) {
    log('calendars: ' + calList.map((c) => c.name + (c.details === 'busy' ? ' (busy only)' : '')).join(', ') + '; time zone ' + calTz);
  } else if (state.resources.calendar.data.configured) {
    try {
      changeResource('calendar', calendar.unconfiguredData());
      log('no calendars are set up any more; cleared the calendar');
    } catch (e) { /* logged */ }
  }
  calReader.start();

  /* --- Spotify (spotify.js) --- */

  // opt.spotifyEnv is the .env settings (SPOTIFY_CLIENT_ID ...). opt.spotify
  // may point at a stand-in for Spotify: { accounts, api, allowHttp, ... }.
  const spOpt = isObj(opt.spotify) ? opt.spotify : {};
  let sounds = null;          // All sounds (below); Spotify's changes are passed on to it
  const player = spotify.createPlayer(Object.assign({}, spOpt, {
    config: spotify.configFromEnv(opt.spotifyEnv || {}, port || DEFAULT_PORT),
    vibeOff: spOpt.vibeOff === true || spotify.vibeOffFromEnv(opt.spotifyEnv),
    dataDir: dataDir,
    log: log,
    screens: () => sse.size + pollSeen.size,
    current: () => state.resources.nowplaying.data,
    publish: (data, changed) => {
      if (!changed) {
        // Only the song's position moved on as expected: no push, no write.
        state.resources.nowplaying = { rev: state.resources.nowplaying.rev, data: data };
        return;
      }
      // All sounds folds Spotify in: its change (if any) goes in the same
      // save and the same rev, so Now Playing's revs are as before.
      const also = sounds ? sounds.withSpotify(data) : null;
      try { changeResource('nowplaying', data, also ? { allsounds: also } : null); } catch (e) { /* changeResource already logged it */ }
    }
  }));

  /* --- All sounds (allsounds.js): Home Assistant's speakers plus Spotify --- */

  // opt.allsoundsEnv is the .env settings (HA_URL, HA_TOKEN,
  // ALLSOUNDS_ENTITIES). opt.allsounds may hold { allowHttp, manual, ... }
  // for tests and the preview.
  const asOpt = isObj(opt.allsounds) ? opt.allsounds : {};
  // Echo controls (echo.js): what the hub started on an Echo is laid over
  // what All sounds reads from Home Assistant. A successful action asks All
  // sounds to look again at once.
  const echoOpt = isObj(opt.echo) ? opt.echo : {};
  const echoCtl = echo.createController(Object.assign({}, echoOpt, {
    config: echo.configFromEnv(opt.echoEnv || {}),
    dataDir: dataDir,
    log: log,
    changed: () => { if (sounds && !closing) sounds.poll(); }
  }));
  echoCtl.startLog();
  sounds = allsounds.createWatcher(Object.assign({}, asOpt, {
    config: allsounds.configFromEnv(opt.allsoundsEnv || {}),
    log: log,
    targets: () => echoCtl.targets(),
    labels: () => echoCtl.labels(),
    clearLabel: (id, reason) => echoCtl.clearLabel(id, reason),
    setBase: (id, sig) => echoCtl.setBase(id, sig),
    current: () => state.resources.allsounds.data,
    spotify: () => state.resources.nowplaying.data,
    publish: (data) => {
      try { changeResource('allsounds', data); } catch (e) { /* changeResource already logged it */ }
    }
  }));
  player.start();
  sounds.start();

  /* --- the TV show schedule (shows.js) --- */

  // opt.shows: { api, sampleFile, refreshMs, rate, ... } turns the TVmaze
  // lookups on (the real server always passes it; tests and the preview pass
  // a stand-in or the sample). Without it nothing is fetched by itself.
  const showsOpt = isObj(opt.shows) ? opt.shows : null;
  const showsWaitMs = opt.showsWait || 25000;
  const tracker = shows.createTracker(Object.assign({}, showsOpt || {}, {
    dataDir: dataDir,
    enabled: !!showsOpt && showsOpt.enabled !== false,
    autoRefresh: !!showsOpt && showsOpt.enabled !== false,
    now: typeof opt.now === 'function' ? opt.now : () => new Date(),
    log: log,
    current: () => state.resources.shows.data,
    publish: (data, changed) => {
      if (!changed) {
        // Only the "checked at" times moved: in memory, no push, no write.
        state.resources.shows = { rev: state.resources.shows.rev, data: data };
        return;
      }
      try {
        changeResource('shows', data);
        log('shows changed: ' + data.shows.length + ' shows (rev ' + state.rev + ')');
      } catch (e) { /* changeResource already logged it */ }
    }
  }));
  tracker.start();

  /* --- Ambience (ambience.js): the room's lights through Home Assistant --- */

  // opt.ambienceEnv is the .env settings (HA_URL, HA_TOKEN, WLED_URL).
  // opt.ambience may hold { manual, timeoutMs, ... } for tests and the preview.
  const amOpt = isObj(opt.ambience) ? opt.ambience : {};
  const lights = ambience.createController(Object.assign({}, amOpt, {
    env: ambience.configFromEnv(opt.ambienceEnv || {}),
    dataDir: dataDir,
    log: log,
    screens: () => sse.size + pollSeen.size,
    current: () => state.resources.ambience.data,
    publish: (data) => {
      try { changeResource('ambience', data); } catch (e) { /* changeResource already logged it */ }
    }
  }));
  lights.start();

  /* --- replies --- */

  function sendJson(res, status, body, extra) {
    if (res.headersSent || res.writableEnded) return;
    const text = JSON.stringify(body);
    const headers = Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store'
    }, extra || {});
    res.writeHead(status, headers);
    res.end(text);
  }

  function corsHeaders(req) {
    const h = { Vary: 'Origin' };
    const origin = req.headers.origin;
    if (origin && origins.indexOf(origin) >= 0) h['Access-Control-Allow-Origin'] = origin;
    return h;
  }

  // A POST from a page of this server itself (the touch app at the Pi's own
  // address) names that same address as its Origin, so it is allowed; so is an
  // Origin on the list. A page on any other site is not.
  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (origins.indexOf(origin) >= 0) return true;
    const host = req.headers.host;
    return !!host && (origin === 'http://' + host || origin === 'https://' + host);
  }

  function touchProof(req) {
    const origin = req.headers.origin;
    if (origin) return originOk(req);
    return req.headers['sec-fetch-site'] === 'same-origin' || req.headers['x-hub-touch'] === '1';
  }

  function readBody(req, res, cb, limitBytes) {
    const limit = limitBytes || BODY_LIMIT;
    const tooLarge = 'request body too large (at most ' + Math.round(limit / 1024) + ' KB)';
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      sendJson(res, 413, { ok: false, error: tooLarge }, { Connection: 'close' });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        sendJson(res, 413, { ok: false, error: tooLarge }, { Connection: 'close' });
        setTimeout(() => req.destroy(), 1000).unref();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: 'the body is not valid JSON' });
        return;
      }
      try {
        cb(body);
      } catch (e) {
        fail(res, e);
      }
    });
    req.on('error', () => { done = true; });
  }

  function fail(res, e, extra) {
    if (e && e.status) {
      sendJson(res, e.status, { ok: false, error: e.message }, extra);
    } else {
      log('error: ' + (e && e.message));
      sendJson(res, 500, { ok: false, error: 'the server had a problem' }, extra);
    }
  }

  /* --- state changes --- */

  function todoItems() {
    return state.resources.todo.data.items;
  }

  /* --- the products catalog (products.js): barcodes, shared by every scanner --- */

  // opt.products may hold { request, resolve, now, web: false, ... } for tests.
  const catalog = products.createCatalog(Object.assign({}, isObj(opt.products) ? opt.products : {}, {
    dataDir: dataDir, log: log,
    keep: () => state.resources.grocery.data.items.map((i) => i.upc).filter(Boolean).concat(pantry ? pantry.barcodes() : [])
  }));

  /* --- the pantry (pantrydb.js): SQLite, the grocery list mirrored into its open list --- */

  let pantry = null;
  if (opt.pantry !== false && pantrydb.available()) {
    try {
      pantry = pantrydb.createPantry({ dataDir: dataDir, log: log, catalogGet: (upc) => catalog.get(upc) });
    } catch (e) {
      log('pantry: off, the database could not open (' + (e.code || e.message) + ')');
      if (pantry) pantry.close();
      pantry = null;
    }
    // A move or mirror that fails is logged and tried again next start; the
    // pantry itself stays on.
    if (pantry) {
      try {
        const m = pantry.migrate({
          productsFile: path.join(dataDir, 'products.json'),
          groceryItems: state.resources.grocery.data.items,
          backupDir: path.join(dataDir, 'pantry-backup')
        });
        if (!m.skipped) log('pantry: moved ' + m.products + ' catalog products and ' + m.grocery + ' grocery rows into pantry.db');
        else pantry.syncGrocery(state.resources.grocery.data.items, []);
      } catch (e) {
        log('pantry: the move into pantry.db stopped (' + (e.code || e.message) + '); trying again next start');
      }
    }
  } else if (opt.pantry !== false) {
    log('pantry: off (this Node has no node:sqlite; it needs Node 22.13 or newer: docker compose pull)');
  }

  function needPantry() {
    if (pantry) return pantry;
    const e = new Error('the pantry is off on this server (it needs Node 22.13 or newer)');
    e.status = 503;
    throw e;
  }

  // Mirrors the grocery list into the pantry's open list. Never fails a
  // grocery change: a problem is logged (no names) and the next change tries again.
  function mirrorGrocery(hints) {
    if (!pantry) return 0;
    try {
      return pantry.syncGrocery(state.resources.grocery.data.items, hints || []);
    } catch (e) {
      log('pantry: could not mirror the grocery list (' + (e.code || e.message) + ')');
      return 0;
    }
  }

  // The pantry is also a live resource ("pantry": rev + the view's data),
  // so the TV reads it over the live line like every other one. pantry.db
  // stays the source; the copy in state is redrawn when the database's own
  // rev moves (publishPantry), never edited.
  // Returns null when the copy is current, else { ok, data }. When the copy
  // cannot be saved, ok is false and publishedDbRev stays behind, so the next
  // change (or GET /api/pantry) tries again; data is still the fresh view.
  let publishedDbRev = -1;
  function publishPantry(atStart) {
    if (!pantry) { delete state.resources.pantry; return null; }
    const dbRev = pantry.rev();
    if (dbRev === publishedDbRev && state.resources.pantry) return null;
    const data = pantry.view(state.resources.grocery.data.items).data;
    if (atStart) { state.resources.pantry = { rev: state.rev, data: data }; publishedDbRev = dbRev; return { ok: true, data: data }; }
    try {
      changeResource('pantry', data);
    } catch (e) {
      log('pantry: the live copy could not be saved; trying again on the next change');
      return { ok: false, data: data };
    }
    publishedDbRev = dbRev;
    return { ok: true, data: data };
  }
  publishPantry(true);

  // The pantry for the phone, the TV and the API: { rev, data }.
  function pantryView() {
    const pub = publishPantry();
    if (pub && !pub.ok) return { rev: state.rev, data: pub.data };
    return state.resources.pantry || { rev: 0, data: null, off: true };
  }

  // Applies pantry ops, then the grocery rows they ask for (want, auto-add).
  // Throws a 400 error (nothing changes) when an op is wrong.
  function pantryOps(body) {
    if (!isObj(body)) throw bad('the body must be a JSON object');
    const p = needPantry();
    // A scanned code is checked and made canonical the way grocery adds are.
    const ops = Array.isArray(body.ops) ? body.ops.map((o) => (isObj(o) && o.op === 'add' && typeof o.upc === 'string' && o.upc ? Object.assign({}, o, { upc: catalog.toKey(o.upc) }) : o)) : body.ops;
    const r = p.applyOps(ops, state.resources.grocery.data.items);
    let added = 0;
    if (r.grocery.length) {
      try {
        const cur = state.resources.grocery.data.items;
        const items = grocery.applyOps(cur, r.grocery, Date.now());
        if (JSON.stringify(items) !== JSON.stringify(cur)) {
          added = items.length - cur.length;
          changeResource('grocery', { items: items });
        }
      } catch (e) {
        log('pantry: the grocery list refused ' + r.grocery.length + ' rows (' + e.message + ')');
      }
      mirrorGrocery(r.hints);
    }
    const pub = publishPantry();
    if (r.auto) log('pantry: ' + r.auto + ' low ' + (r.auto === 1 ? 'item' : 'items') + ' added to grocery');
    // The caller always gets the database as it now is, even when the live
    // copy could not be saved (the phone then never shows stale counts).
    const v = pub && !pub.ok ? { rev: state.rev, data: pub.data } : pantryView();
    return { ok: true, rev: v.rev, data: v.data, results: r.results, auto: r.auto, groceryAdded: Math.max(0, added) };
  }

  // GET /api/grocery/export with the pantry's fromPantry and reason on each row.
  function groceryExport() {
    const r = products.exportList(state.resources.grocery.data.items, catalog.get, Date.now());
    const info = pantry ? pantry.groceryInfo() : {};
    let n = 0;
    r.items.forEach((i) => {
      const x = info[i.id] || { store: '', fromPantry: false, reason: '' };
      i.store = x.store || '';
      i.fromPantry = x.fromPantry;
      i.reason = x.reason;
      if (x.fromPantry) n++;
    });
    r.counts.fromPantry = n;
    return r;
  }

  // An add op with a upc: the code is checked and, with no name, the name
  // comes from the catalog ("Brand Name"). Other ops pass through.
  function withProducts(ops) {
    if (!Array.isArray(ops)) return ops;
    return ops.map((o) => {
      if (!isObj(o) || o.op !== 'add' || o.upc === undefined || o.upc === null || o.upc === '') return o;
      const key = catalog.toKey(o.upc);
      const out = Object.assign({}, o, { upc: key });
      if (o.name === undefined || o.name === null || (typeof o.name === 'string' && !o.name.trim())) {
        const p = catalog.get(key);
        if (!p) throw bad("that barcode isn't in the product catalog yet");
        out.name = products.lineName(p);
      }
      return out;
    });
  }

  // { upc: product } for every code on the grocery list (catalog only).
  function groceryProducts() {
    return catalog.forUpcs(state.resources.grocery.data.items.map((i) => i.upc).filter(Boolean));
  }

  // Sends a product's saved thumbnail, or 404.
  function sendProductImage(req, res, code, extra) {
    let key = null;
    try { key = catalog.toKey(code); } catch (e) { key = null; }
    const img = key ? catalog.imageFile(key) : null;
    if (!img) return sendJson(res, 404, { ok: false, error: 'no picture' }, extra);
    return fs.readFile(img.file, (err, data) => {
      if (err) return sendJson(res, 404, { ok: false, error: 'no picture' }, extra);
      res.writeHead(200, Object.assign({
        'Content-Type': img.type, 'Content-Length': data.length,
        'Cache-Control': 'private, max-age=2592000', 'X-Content-Type-Options': 'nosniff'
      }, extra || {}));
      return res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  // Applies grocery ops: saves, bumps rev, tells every screen. Throws a 400
  // error (nothing changes) when an op is wrong.
  function groceryOps(body) {
    if (!isObj(body)) throw bad('the body must be a JSON object');
    const cur = state.resources.grocery.data.items;
    const results = [];
    const items = grocery.applyOps(cur, withProducts(body.ops), Date.now(), results);
    const changed = JSON.stringify(items) !== JSON.stringify(cur);
    if (changed) {
      changeResource('grocery', { items: items });
      mirrorGrocery([]);
      publishPantry();
    }
    return { ok: true, rev: state.rev, changed: changed, items: state.resources.grocery.data.items, results: results };
  }

  // Applies a change to the to-do list: saves, bumps rev, tells every screen.
  function changeTodo(newItems) {
    if (JSON.stringify(newItems) === JSON.stringify(todoItems())) return false;
    changeResource('todo', { items: newItems });
    return true;
  }

  // Replaces one resource: saves, bumps rev, tells every screen. also:
  // { otherName: data } changed in the same step, with the same rev.
  function changeResource(name, data, also) {
    const next = JSON.parse(JSON.stringify(state));
    next.rev += 1;
    next.resources[name] = { rev: next.rev, data: data };
    const extra = also ? Object.keys(also) : [];
    extra.forEach((k) => { next.resources[k] = { rev: next.rev, data: also[k] }; });
    try {
      saveState(dataDir, next);
    } catch (e) {
      log('could not save the data file: ' + e.message);
      const err = new Error('the server could not save the change');
      err.status = 500;
      throw err;
    }
    state = next;
    broadcast('change', { resource: name, rev: state.rev, data: state.resources[name].data });
    extra.forEach((k) => broadcast('change', { resource: k, rev: state.rev, data: state.resources[k].data }));
    wakePolls();
  }

  // POST /api/awws and POST /api/budget: name is the resource, kind its
  // module (awws.js or budget.js). Returns [body, note] for reply(200, ...),
  // or throws a 400 error that changes nothing. The note for the log never
  // holds titles, labels or amounts.
  function postSnapshot(name, kind, body) {
    if (!isObj(body) || !Object.prototype.hasOwnProperty.call(body, 'snapshot')) {
      throw bad('send { "snapshot": { ... } }, or { "snapshot": null } to clear it');
    }
    const cur = state.resources[name].data;
    if (body.snapshot === null) {
      const empty = kind.emptyData();
      const changed = JSON.stringify(cur) !== JSON.stringify(empty);
      const cleared = kind.sectionsIn(cur);
      if (changed) changeResource(name, empty);
      return [{
        ok: true, rev: state.resources[name].rev, changed: changed, bytes: 0, accepted: [], cleared: cleared, rejected: []
      }, changed ? 'cleared, rev ' + state.rev : 'cleared, nothing was stored'];
    }
    const now = Date.now();
    const m = kind.merge(cur, kind.normalizeSnapshot(body.snapshot, now), now);
    // The budget app never sends the goal history: the Pi's own goes back on.
    if (name === 'budget') m.data = budgetgoal.attach(m.data, goalHistory);
    // Stored and pushed even when no section changed: the new sentAt is what
    // tells the TV the data is still fresh.
    changeResource(name, m.data);
    const note = [plural(m.accepted.length, 'section') + ' stored'];
    if (m.cleared.length) note.push(m.cleared.length + ' cleared');
    if (m.rejected.length) note.push(m.rejected.length + ' rejected');
    note.push(kind.sizeText(m.bytes), m.changed ? 'rev ' + state.rev : 'rev ' + state.rev + ' (same contents)');
    return [{
      ok: true, rev: state.resources[name].rev, changed: m.changed, bytes: m.bytes,
      accepted: m.accepted, cleared: m.cleared, rejected: m.rejected
    }, note.join(', ')];
  }

  // The Pi's local date (the calendar's time zone), for a goal's "from".
  function localToday() {
    const t = typeof opt.now === 'function' ? opt.now() : new Date();
    return new Intl.DateTimeFormat('en-CA', { timeZone: calTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  }

  // POST /budget/goal (the TV) and POST /api/budget/goal (./hub, the
  // mailbox): the daily goal from today on. Saved, then pushed with the
  // budget resource. Never logs the amount.
  function setBudgetGoal(body) {
    if (!isObj(body) || body.goal === undefined) throw bad('send { "goal": 60 } (whole dollars a day, 1 to 1,000)');
    const from = localToday();
    const r = budgetgoal.setGoal(goalHistory, body.goal, from);
    if (r.changed) {
      try {
        budgetgoal.save(dataDir, r.history);
      } catch (e) {
        log('could not save the budget goal: ' + e.message);
        const err = new Error('the server could not save the change');
        err.status = 500;
        throw err;
      }
      goalHistory = r.history;
      const cur = state.resources.budget.data;
      if (cur.pace) changeResource('budget', budgetgoal.attach(cur, goalHistory));
    }
    return { ok: true, from: from, changed: r.changed, goals: goalHistory, rev: state.rev };
  }

  // POST /prefs (a screen): one shared widget preference (prefs.js).
  function setPref(body) {
    const r = prefs.apply(state.resources.prefs.data, body, new Date().toISOString());
    if (r.changed) changeResource('prefs', r.data);
    return { ok: true, key: r.key, changed: r.changed, rev: state.rev };
  }

  // Guest mode on every screen: after a right PIN with { all: true, on },
  // the choice goes out as the guestall resource; each screen applies a new one once.
  function setGuestAll(on) {
    changeResource('guestall', { on: !!on, at: new Date().toISOString() });
  }

  // POST /api/awws/resync and the TV's POST /awws/resync: "sync now". Only
  // stores the time it was asked (awws.js requestResync); the routine that
  // reads the board checks for it. Nothing about it reaches the log but a word.
  function awwsResync() {
    const r = awws.requestResync(state.resources.awws.data, Date.now());
    if (r.changed) changeResource('awws', r.data);
    return r;
  }

  function opsAndReply(res, body, extra) {
    if (!isObj(body)) throw bad('the body must be a JSON object');
    const items = applyOps(todoItems(), body.ops, Date.now());
    changeTodo(items);
    sendJson(res, 200, { ok: true, rev: state.rev, items: todoItems() }, extra);
  }

  /* --- Ambience commands (ambience.js) --- */

  // The control API and the screen's door share this. sub is
  // '/ambience', '/ambience/scene', ... Resolves { status, body, note }; it
  // never rejects. The note (for the control log line) is a result word,
  // never a name.
  function ambienceCall(method, sub, body) {
    const b = isObj(body) ? body : {};
    const idOf = () => {
      if (typeof b.id !== 'string' || !b.id) throw bad('send { "id": "..." }');
      return b.id;
    };
    const done = (p) => p.then((r) => ({ status: 200, body: Object.assign({ ok: true }, r), note: r.result }));
    return Promise.resolve().then(() => {
      if (sub === '/ambience' && method === 'GET') return { status: 200, body: { ok: true, ambience: lights.status() } };
      if (sub === '/ambience/config' && method === 'GET') return { status: 200, body: { ok: true, config: lights.getConfig() } };
      if (sub === '/ambience/config') {
        if (!isObj(body) || body.config === undefined) throw bad('send { "config": { "lights": [...], "scenes": [...], "moods": [...] } }, or { "config": null } for the defaults');
        const c = body.config === null ? lights.resetConfig() : lights.setConfig(body.config);
        return { status: 200, body: { ok: true, config: c, ambience: lights.status() }, note: body.config === null ? 'defaults' : 'saved' };
      }
      if (sub === '/ambience/scene') return done(lights.applyScene(idOf()));
      if (sub === '/ambience/light') {
        const want = {};
        if (b.on !== undefined) want.on = b.on;
        if (b.pct !== undefined) want.pct = b.pct;
        return done(lights.setLight(idOf(), want));
      }
      if (sub === '/ambience/mood') return done(lights.applyMood(idOf()));
      throw bad('no such call');
    }).catch((e) => {
      const status = e && e.status ? e.status : 500;
      if (status === 500) log('ambience: unexpected problem with a command');
      return { status: status, body: { ok: false, error: e && e.status ? e.message : 'the server had a problem' } };
    });
  }

  /* --- Echo controls (echo.js) --- */

  const ECHO_FIELDS = ['action', 'target', 'app', 'query', 'level'];
  const ECHO_ACTIONS = ['start', 'pause', 'resume', 'next', 'stop', 'volume'];

  // POST /api/echo. Bad input is a 400 that names what is valid; a Home
  // Assistant failure is a 200 with ok: false (the message says what).
  function echoPost(body) {
    if (!isObj(body)) throw bad('send { "action": "start", "app": "audible" }');
    Object.keys(body).forEach((k) => { if (ECHO_FIELDS.indexOf(k) < 0) throw bad('unknown field "' + k + '" (use ' + ECHO_FIELDS.join(', ') + ')'); });
    const action = body.action;
    if (typeof action !== 'string' || ECHO_ACTIONS.indexOf(action) < 0) throw bad('"action" must be one of: ' + ECHO_ACTIONS.join(', '));
    let target;
    if (body.target !== undefined && body.target !== null) {
      const keys = echoCtl.targetKeys();
      if (typeof body.target !== 'string' || (keys.length && keys.indexOf(body.target) < 0)) {
        throw bad('"target" must be one of: ' + (keys.length ? keys.join(', ') : '(none: Echo controls are off)'));
      }
      target = body.target;
    }
    let run;
    if (action === 'start') {
      if (body.level !== undefined) throw bad('"level" goes with "volume"');
      if (typeof body.app !== 'string' || echo.APP_KEYS.indexOf(body.app) < 0) throw bad('"app" must be one of: ' + echo.APP_KEYS.join(', '));
      const why = echo.checkStart(body.app, body.query);
      if (why) throw bad(why);
      run = () => echoCtl.start(body.app, target, body.query);
    } else {
      if (body.app !== undefined || body.query !== undefined) throw bad('"app" and "query" go with "start"');
      if (action === 'volume') {
        const why = echo.checkVolume(body.level);
        if (why) throw bad(why);
        run = () => echoCtl.volume(body.level, target);
      } else {
        if (body.level !== undefined) throw bad('"level" goes with "volume"');
        run = () => echoCtl[action](target);
      }
    }
    return run().then((r) => ({
      status: 200,
      body: { ok: r.ok === true, message: r.message, echo: echoCtl.status() },
      note: r.ok ? action : (r.problem || 'failed')
    }));
  }

  /* --- Echo controls from the TV: POST /echo/run (SCREEN API) --- */

  // The TV holds no secret and may only press presets: no search text, no
  // tunein, and a speaker only by its key. Nothing the TV sends reaches the
  // log (only the action and the speaker's key do, from echo.js), and
  // neither a Home Assistant address nor the token is in the reply.
  const SCREEN_ECHO_FIELDS = ['action', 'target', 'app', 'level', 'step'];
  const SCREEN_ECHO_APPS = ['audible', 'pandora', 'amazon-music', 'kera', 'news', 'npr', 'spotify'];
  const echoScreenMax = Number.isInteger(opt.echoScreenMax) && opt.echoScreenMax > 0 ? opt.echoScreenMax : 6;
  const echoStamps = [];
  let echoSlowLogged = false;

  // A token-less rate limit for screens: 6 presses in 5 seconds.
  function echoScreenAllowed() {
    const t = Date.now();
    while (echoStamps.length && t - echoStamps[0] >= 5000) echoStamps.shift();
    if (echoStamps.length >= echoScreenMax) {
      if (!echoSlowLogged) { echoSlowLogged = true; log('echo: a screen sent commands too fast (asked it to slow down)'); }
      return false;
    }
    echoSlowLogged = false;
    echoStamps.push(t);
    return true;
  }

  function echoRun(body) {
    const refuse = (why) => ({ status: 400, body: { ok: false, error: why } });
    if (!isObj(body)) return Promise.resolve(refuse('send { "action": "pause", "target": "show" }'));
    const keys = Object.keys(body);
    for (let i = 0; i < keys.length; i++) if (SCREEN_ECHO_FIELDS.indexOf(keys[i]) < 0) return Promise.resolve(refuse('unknown field'));
    if (typeof body.action !== 'string' || ECHO_ACTIONS.indexOf(body.action) < 0) return Promise.resolve(refuse('"action" must be one of: ' + ECHO_ACTIONS.join(', ')));
    let target;
    if (body.target !== undefined) {
      if (typeof body.target !== 'string' || echoCtl.targetKeys().indexOf(body.target) < 0) return Promise.resolve(refuse('unknown target'));
      target = body.target;
    }
    const a = body.action;
    let run;
    if (a === 'start') {
      if (body.level !== undefined || body.step !== undefined) return Promise.resolve(refuse('"level" and "step" go with "volume"'));
      if (typeof body.app !== 'string' || SCREEN_ECHO_APPS.indexOf(body.app) < 0) return Promise.resolve(refuse('"app" must be one of: ' + SCREEN_ECHO_APPS.join(', ')));
      run = () => echoCtl.start(body.app, target);
    } else if (a === 'volume') {
      if (body.app !== undefined) return Promise.resolve(refuse('"app" goes with "start"'));
      const hasStep = body.step !== undefined;
      const hasLevel = body.level !== undefined;
      if (hasStep === hasLevel) return Promise.resolve(refuse('send "step" (up or down) or "level" (0 to 100)'));
      const v = hasStep ? body.step : body.level;
      if (hasStep && v !== 'up' && v !== 'down') return Promise.resolve(refuse('"step" must be up or down'));
      if (hasLevel && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100)) return Promise.resolve(refuse('"level" must be a whole number from 0 to 100'));
      run = () => echoCtl.volume(v, target);
    } else {
      if (body.app !== undefined || body.level !== undefined || body.step !== undefined) return Promise.resolve(refuse('"app", "level" and "step" do not go with "' + a + '"'));
      run = () => echoCtl[a](target);
    }
    return run().then((r) => ({ status: 200, body: { ok: r.ok === true, message: String(r.message || '') } }));
  }

  /* --- push line --- */

  function sseWrite(client, event, data) {
    try {
      if (client.res.writableLength > SSE_MAX_BUFFER) throw new Error('screen too far behind');
      client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      return true;
    } catch (e) {
      dropSse(client, e.message);
      return false;
    }
  }

  function broadcast(event, data) {
    let n = 0;
    Array.from(sse).forEach((c) => { if (sseWrite(c, event, data)) n++; });
    return n;
  }

  function dropSse(client, why) {
    if (!sse.has(client)) return;
    sse.delete(client);
    log('screen disconnected (live line) ' + client.address + (why ? ' (' + why + ')' : ''));
    try { client.res.end(); } catch (e) { /* already gone */ }
    if (!sse.size && pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function openSse(req, res, address) {
    if (sse.size >= MAX_SSE) {
      sendJson(res, 503, { ok: false, error: 'too many screens connected' }, corsHeaders(req));
      return;
    }
    const sock = req.socket;
    sock.setNoDelay(true);
    sock.setTimeout(0);
    sock.setKeepAlive(true, 30000);
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    }, corsHeaders(req)));
    const client = { res: res, since: Date.now(), address: address };
    sse.add(client);
    log('screen connected (live line) ' + address);
    player.wake();
    lights.screensChanged();
    res.on('close', () => dropSse(client));
    res.on('error', () => dropSse(client, 'write error'));
    try {
      res.write('retry: 5000\n\n');
    } catch (e) {
      dropSse(client, 'write error');
      return;
    }
    sseWrite(client, 'hello', { v: PROTOCOL, epoch: state.epoch, rev: state.rev });
    if (!pingTimer) {
      pingTimer = setInterval(() => broadcast('ping', { rev: state.rev }), pingMs);
    }
  }

  /* --- fallback poll --- */

  function cursorNum(s) {
    if (typeof s !== 'string' || !/^c[0-9a-z]{1,13}$/.test(s)) return null;
    const n = parseInt(s.slice(1), 36);
    return isFinite(n) ? n : null;
  }

  function cursorText(n) {
    return 'c' + n.toString(36);
  }

  function forgetOld() {
    const cut = Date.now() - commandTtl;
    remembered = remembered.filter((r) => r.at > cut);
    pollSeen.forEach((v, k) => {
      if (Date.now() - v.last > pollMs + commandTtl) {
        pollSeen.delete(k);
        log('screen disconnected (poll) ' + k);
      }
    });
    if (!remembered.length && !pollSeen.size && forgetTimer) {
      clearInterval(forgetTimer);
      forgetTimer = null;
    }
  }

  function ensureForgetTimer() {
    if (!forgetTimer) {
      forgetTimer = setInterval(forgetOld, Math.max(200, Math.min(commandTtl, 5000)));
      forgetTimer.unref();
    }
  }

  // What a poll would answer now, or null when it should keep waiting.
  function pollAnswer(p, force) {
    forgetOld();
    const epochChanged = p.epoch !== state.epoch;
    const revChanged = p.rev !== state.rev;
    const cmds = p.cursor === null ? [] : remembered.filter((r) => r.num > p.cursor);
    if (!force && !epochChanged && !revChanged && !cmds.length) return null;
    const resources = {};
    Object.keys(state.resources).forEach((k) => {
      const r = state.resources[k];
      if (epochChanged || p.rev === null || p.rev > state.rev || r.rev > p.rev) resources[k] = r;
    });
    const cursor = cmds.length ? cmds[cmds.length - 1].num : (p.cursor === null ? commandNum : p.cursor);
    return {
      ok: true, v: PROTOCOL, epoch: state.epoch, rev: state.rev, resources: resources,
      commands: cmds.map((r) => r.cmd), cursor: cursorText(cursor), count: cmds.length
    };
  }

  function finishPoll(p, answer) {
    polls.delete(p);
    clearTimeout(p.timer);
    const seen = pollSeen.get(p.address);
    if (seen) seen.last = Date.now();
    const out = Object.assign({}, answer);
    delete out.count;
    sendJson(p.res, 200, out, p.cors);
  }

  function wakePolls() {
    Array.from(polls).forEach((p) => {
      const a = pollAnswer(p, false);
      if (a) finishPoll(p, a);
    });
  }

  function openPoll(req, res, query, address) {
    const seen = pollSeen.get(address);
    if (seen) seen.last = Date.now();
    else {
      if (pollSeen.size >= MAX_POLLS) forgetOld();
      if (pollSeen.size < MAX_POLLS) {
        pollSeen.set(address, { since: Date.now(), last: Date.now() });
        log('screen connected (poll) ' + address);
        player.wake();
        lights.screensChanged();
      }
    }
    ensureForgetTimer();
    const revText = query.get('rev');
    const p = {
      res: res,
      cors: corsHeaders(req),
      epoch: query.get('epoch') || '',
      rev: revText !== null && /^\d{1,15}$/.test(revText) ? Number(revText) : null,
      cursor: cursorNum(query.get('cursor')),
      timer: null,
      address: address
    };
    const now = pollAnswer(p, false);
    if (now) {
      finishPoll(p, now);
      return;
    }
    if (polls.size >= MAX_POLLS) {
      sendJson(res, 503, { ok: false, error: 'too many screens connected' }, p.cors);
      return;
    }
    polls.add(p);
    req.socket.setTimeout(0);
    p.timer = setTimeout(() => {
      if (polls.has(p)) finishPoll(p, pollAnswer(p, true));
    }, pollMs);
    res.on('close', () => {
      polls.delete(p);
      clearTimeout(p.timer);
    });
  }

  /* --- commands --- */

  function sendCommand(cmd) {
    commandNum += 1;
    const full = { id: cursorText(commandNum), type: cmd.type, data: cmd.data };
    let delivered = broadcast('command', full);
    forgetOld();
    // Remember it only while a poll screen is around (seen in the last
    // 10 seconds, or waiting now). With no TV, nothing is kept.
    const pollRecent = polls.size > 0 || Array.from(pollSeen.values()).some((v) => Date.now() - v.last < commandTtl);
    if (pollRecent) {
      remembered.push({ num: commandNum, at: Date.now(), cmd: full });
      if (remembered.length > MAX_COMMANDS) remembered = remembered.slice(-MAX_COMMANDS);
      ensureForgetTimer();
    }
    Array.from(polls).forEach((p) => {
      const a = pollAnswer(p, false);
      if (a) {
        if (a.commands.some((c) => c.id === full.id)) delivered++;
        finishPoll(p, a);
      }
    });
    return { id: full.id, delivered: delivered };
  }

  /* --- routing --- */

  function checkToken(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const given = Buffer.from(m[1].trim());
    if (given.length !== tokenBuf.length) {
      crypto.timingSafeEqual(tokenBuf, tokenBuf); // same work either way
      return false;
    }
    return crypto.timingSafeEqual(given, tokenBuf);
  }

  function screenList() {
    forgetOld();
    const out = [];
    sse.forEach((c) => out.push({ since: new Date(c.since).toISOString(), via: 'events', address: plainAddress(c.address) }));
    pollSeen.forEach((v, k) => out.push({ since: new Date(v.since).toISOString(), via: 'poll', address: plainAddress(k) }));
    return out;
  }

  const ROUTES = {
    '/api/command': ['POST'],
    '/api/todo': ['GET', 'POST'],
    '/api/todo/ops': ['POST'],
    '/api/grocery': ['GET'],
    '/api/grocery/ops': ['POST'],
    '/api/grocery/export': ['GET'],
    '/api/pantry': ['GET'],
    '/api/pantry/ops': ['POST'],
    '/api/pantry/low': ['GET'],
    '/api/products': ['GET'],
    '/api/products/image': ['GET'],
    '/api/layout': ['GET', 'POST'],
    '/api/awws': ['GET', 'POST'],
    '/api/awws/resync': ['POST'],
    '/api/budget': ['GET', 'POST'],
    '/api/budget/goal': ['GET', 'POST'],
    '/api/prefs': ['GET'],
    '/api/status': ['GET'],
    '/api/log': ['GET'],
    '/api/calendar': ['GET'],
    '/api/calendar/refresh': ['POST'],
    '/api/spotify': ['GET'],
    '/api/spotify/login': ['POST'],
    '/api/spotify/code': ['POST'],
    '/api/spotify/logout': ['POST'],
    '/api/spotify/refresh': ['POST'],
    '/api/shows': ['GET', 'POST'],
    '/api/shows/refresh': ['POST'],
    '/api/shows/watched': ['POST'],
    '/api/shows/unwatch': ['POST'],
    '/api/shows/upto': ['POST'],
    '/api/shows/caughtup': ['POST'],
    '/api/linktests': ['GET'],
    '/api/tv': ['GET'],
    '/api/tv/launch': ['POST'],
    '/api/tvremote': ['GET'],
    '/api/tvremote/run': ['POST'],
    '/api/allsounds': ['GET'],
    '/api/echo': ['GET', 'POST'],
    '/api/ambience': ['GET'],
    '/api/ambience/scene': ['POST'],
    '/api/ambience/light': ['POST'],
    '/api/ambience/mood': ['POST'],
    '/api/ambience/config': ['GET', 'POST'],
    '/api/translate': ['POST'],
    '/api/translate/usage': ['GET'],
    '/api/guest-pin': ['GET'],
    '/api/guest-pin/reset': ['POST'],
    '/api/photos': ['GET']
  };

  function statusBody() {
    return {
      ok: true, server: SERVER_VERSION, app: appVersion(), rev: state.rev, epoch: state.epoch,
      uptime: Math.round((Date.now() - startedAt) / 1000), screens: screenList(),
      calendar: { configured: calReader.configured, calendars: calList.length, lastRefresh: calReader.lastRefresh() },
      mailbox: mbox ? mbox.info() : { configured: false, problem: mailboxCfg.problem || '' },
      spotify: player.status(),
      shows: { shows: tracker.list().length, lastRefresh: tracker.lastRefresh(), sample: !!state.resources.shows.data.sample },
      ambience: lights.summary()
    };
  }

  // Names to hide in a scrubbed log line: each calendar's name, the Spotify
  // account's name, and the mailbox's bucket and host.
  function logSecrets() {
    const out = calList.map((c) => c.name);
    try { const u = player.status().user; if (u) out.push(u); } catch (e) { /* no name then */ }
    if (mailboxCfg && mailboxCfg.configured) out.push(mailboxCfg.bucket, mailboxCfg.url.host, mailboxCfg.url.hostname);
    return out.filter((x) => typeof x === 'string' && x);
  }

  // GET /api/log: { ok, lines: [{ t, text, level }], errors24h, kept }.
  function logBody(query) {
    const q = query || new URLSearchParams();
    let n = LOG_LINES;
    const linesText = q.get('lines');
    if (linesText !== null) {
      n = /^\d{1,3}$/.test(linesText) ? Number(linesText) : 0;
      if (n < 1 || n > LOG_MAX_LINES) throw bad('"lines" must be a whole number from 1 to ' + LOG_MAX_LINES);
    }
    const flag = (name) => {
      const v = q.get(name);
      if (v === null || v === '0') return false;
      if (v === '1') return true;
      throw bad('"' + name + '" must be 1 or 0');
    };
    const errorsOnly = flag('errors');
    const scrubbed = flag('scrub');
    const secrets = scrubbed ? logSecrets() : null;
    const from = errorsOnly ? ring.filter((e) => e.level === 'error') : ring;
    const cut = Date.now() - DAY_MS;
    return {
      ok: true,
      lines: from.slice(-n).map((e) => ({ t: e.t, text: scrubbed ? logscrub.scrub(e.text, secrets) : e.text, level: e.level })),
      errors24h: ring.filter((e) => e.level === 'error' && Date.parse(e.t) >= cut).length,
      kept: ring.length
    };
  }

  // The control API itself, once the caller is known to be allowed. The HTTP
  // side door and main door use it, and so does the Claude mailbox
  // (mailbox.js), so every change goes through the same checks. Resolves to
  // { status, body, note }; it never rejects. The query may come as a
  // URLSearchParams or as "?..." on the end of route (the mailbox does that).
  function api(method, routeIn, body, queryIn) {
    let route = String(routeIn || '');
    let query = queryIn || null;
    const qi = route.indexOf('?');
    if (qi >= 0) {
      if (!query) query = new URLSearchParams(route.slice(qi + 1));
      route = route.slice(0, qi);
    }
    return new Promise((resolve) => {
      const reply = (status, b, note) => resolve({ status: status, body: b, note: note });
      const failed = (e) => {
        const status = e && e.status ? e.status : 500;
        if (status === 500) log('error: ' + (e && e.message));
        reply(status, { ok: false, error: e && e.status ? e.message : 'the server had a problem' });
      };
      try {
        if (!ROUTES[route]) return reply(404, { ok: false, error: 'no such call' });
        if (ROUTES[route].indexOf(method) < 0) {
          return reply(405, { ok: false, error: 'use ' + ROUTES[route].join(' or ') + ' for ' + route });
        }
        if (route === '/api/translate') {
          const texts = translate.checkRequest(body);
          translator.translate(texts).then((r) => {
            const out = { ok: true, map: r.map };
            if (r.disabled) out.disabled = true;
            reply(200, out);
          }).catch(failed);
          return undefined;
        }
        if (route === '/api/translate/usage') return reply(200, Object.assign({ ok: true }, translator.info()));
        if (route === '/api/guest-pin') return reply(200, Object.assign({ ok: true }, guestPin.status()));
        if (route === '/api/guest-pin/reset') return reply(200, { ok: true, removed: guestPin.reset() });
        if (route === '/api/photos') {
          album.stat().then((st) => reply(200, {
            ok: true, store: album.kind, count: st.count, lastRun: st.lastRun, syncOk: st.ok, newCount: st.newCount
          })).catch(failed);
          return undefined;
        }
        if (route === '/api/status') return reply(200, statusBody());
        if (route === '/api/log') return reply(200, logBody(query));
        if (route === '/api/calendar') {
          const c = state.resources.calendar;
          return reply(200, { ok: true, rev: c.rev, data: c.data });
        }
        if (route === '/api/calendar/refresh') {
          let waitTimer = null;
          const late = new Promise((r) => { waitTimer = setTimeout(() => r(null), calWaitMs); });
          Promise.race([calReader.refresh().then((r) => ({ r: r })), late]).then((w) => {
            clearTimeout(waitTimer);
            const finished = !!(w && w.r);
            reply(200, {
              ok: true, done: finished || !calReader.configured, changed: finished ? w.r.changed : false,
              calendars: state.resources.calendar.data.calendars
            }, finished ? (w.r.changed ? 'changed' : 'no change') : 'still reading');
          }).catch(failed);
          return undefined;
        }
        if (route === '/api/spotify') return reply(200, { ok: true, spotify: player.status() });
        if (route === '/api/allsounds') return reply(200, { ok: true, allsounds: sounds.status() });
        if (route === '/api/spotify/login') {
          const l = player.loginUrl();
          return reply(200, { ok: true, url: l.url, redirectUri: l.redirectUri, minutes: l.minutes }, 'sign-in link made');
        }
        if (route === '/api/spotify/code') {
          if (!isObj(body) || typeof body.input !== 'string') throw bad('send { "input": "<the address from the browser>" }');
          player.finishLogin(body.input).then((r) => {
            reply(200, { ok: true, user: r.user, spotify: player.status() }, 'signed in');
          }).catch(failed);
          return undefined;
        }
        if (route === '/api/spotify/logout') {
          const was = player.logout();
          return reply(200, { ok: true, changed: was, spotify: player.status() }, was ? 'signed out' : 'was not signed in');
        }
        if (route === '/api/spotify/refresh') {
          player.poll().then(() => reply(200, { ok: true, spotify: player.status() })).catch(failed);
          return undefined;
        }
        if (route === '/api/echo') {
          if (method === 'GET') return reply(200, { ok: true, echo: echoCtl.status() });
          echoPost(body).then((a) => reply(a.status, a.body, a.note)).catch(failed);
          return undefined;
        }
        if (route.indexOf('/api/ambience') === 0) {
          ambienceCall(method, route.slice(4), body).then((a) => reply(a.status, a.body, a.note));
          return undefined;
        }
        if (route === '/api/layout' && method === 'GET') {
          const l = state.resources.layout;
          return reply(200, { ok: true, rev: l.rev, layout: l.data.layout });
        }
        if (route === '/api/awws' && method === 'GET') {
          const a = state.resources.awws;
          return reply(200, { ok: true, rev: a.rev, data: a.data, tz: calTz });
        }
        if (route === '/api/awws/resync') {
          const r = awwsResync();
          return reply(200, { ok: true, requestedAt: r.requestedAt, already: r.already, changed: r.changed }, r.already ? 'sync already asked for' : 'sync asked for');
        }
        if (route === '/api/awws') {
          const answer = postSnapshot('awws', awws, body);
          return reply(200, answer[0], answer[1]);
        }
        if (route === '/api/budget' && method === 'GET') {
          const b = state.resources.budget;
          return reply(200, { ok: true, rev: b.rev, data: b.data, tz: calTz });
        }
        if (route === '/api/prefs') {
          const d = state.resources.prefs.data;
          return reply(200, { ok: true, keys: Object.keys(d.values), at: d.at, guestAll: state.resources.guestall.data, message: prefs.showText(d) });
        }
        if (route === '/api/budget/goal' && method === 'GET') {
          return reply(200, { ok: true, goals: goalHistory, today: localToday() });
        }
        if (route === '/api/budget/goal') {
          const g = setBudgetGoal(body);
          return reply(200, g, g.changed ? 'goal set from ' + g.from : 'goal unchanged');
        }
        if (route === '/api/budget') {
          const answer = postSnapshot('budget', budget, body);
          return reply(200, answer[0], answer[1]);
        }
        if (route === '/api/shows' && method === 'GET') {
          const r = state.resources.shows;
          return reply(200, { ok: true, rev: r.rev, data: r.data, list: tracker.list(), tz: calTz });
        }
        if (route === '/api/shows') {
          if (!isObj(body)) throw bad('send { "add": {...} }, { "remove": "name" } or { "set": [...] }');
          const ops = ['add', 'remove', 'set'].filter((k) => Object.prototype.hasOwnProperty.call(body, k));
          if (ops.length !== 1) throw bad('send exactly one of { "add": {...} }, { "remove": "name" } or { "set": [...] }');
          if (ops[0] === 'add') {
            const a = tracker.add(body.add);
            return reply(200, { ok: true, entry: a.entry, replaced: a.replaced, list: tracker.list() }, (a.replaced ? 'updated ' : 'added ') + 'a show');
          }
          if (ops[0] === 'remove') {
            if (typeof body.remove !== 'string' || !body.remove.trim()) throw bad('"remove" must be the show\'s name');
            const e = tracker.remove(body.remove);
            return reply(200, { ok: true, removed: e, list: tracker.list() }, 'removed a show');
          }
          const list = tracker.set(body.set);
          return reply(200, { ok: true, list: list }, plural(list.length, 'show') + ' on the list');
        }
        if (route === '/api/shows/watched' || route === '/api/shows/unwatch') {
          if (!isObj(body) || typeof body.show !== 'string' || !body.show.trim()) throw bad('send { "show": "name", "episode": "S3E4" }');
          let ep = null;
          if (body.episode !== undefined && body.episode !== null && body.episode !== '') {
            ep = shows.parseEpisode(body.episode);
            if (!ep) throw bad('"episode" must look like S3E4');
          }
          const up = route === '/api/shows/unwatch';
          const r = up ? tracker.unwatch(body.show, ep) : tracker.markWatched(body.show, ep);
          return reply(200, { ok: true, season: r.season, number: r.number, changed: r.changed, entry: r.entry, list: tracker.list() },
            (up ? 'took a watched mark off' : 'marked') + ' an episode' + (up ? '' : ' watched'));
        }
        if (route === '/api/shows/upto' || route === '/api/shows/caughtup') {
          const all = route === '/api/shows/caughtup';
          if (!isObj(body) || typeof body.show !== 'string' || !body.show.trim()) throw bad(all ? 'send { "show": "name" }' : 'send { "show": "name", "episode": "S3E4" }');
          let r;
          if (all) {
            r = tracker.caughtUp(body.show);
          } else {
            const ep = shows.parseEpisode(body.episode);
            if (!ep) throw bad('"episode" must look like S3E4');
            r = tracker.upTo(body.show, ep);
          }
          return reply(200, { ok: true, season: r.season, number: r.number, changed: r.changed, entry: r.entry, list: tracker.list() },
            all ? 'marked a show caught up' : 'marked a show watched up to an episode');
        }
        if (route === '/api/shows/refresh') {
          let waitTimer = null;
          const late = new Promise((r) => { waitTimer = setTimeout(() => r(null), showsWaitMs); });
          Promise.race([tracker.refresh().then((r) => ({ r: r })), late]).then((w) => {
            clearTimeout(waitTimer);
            const finished = !!(w && w.r);
            reply(200, {
              ok: true, done: finished, changed: finished ? w.r.changed : false,
              problems: finished ? w.r.problems || [] : [], count: tracker.list().length,
              data: state.resources.shows.data, list: tracker.list()
            }, finished ? (w.r.changed ? 'changed' : 'no change') : 'still reading');
          }).catch(failed);
          return undefined;
        }
        if (route === '/api/tv') { tvLauncher.status().then((s) => reply(200, { ok: true, tv: s })).catch(failed); return undefined; }
        if (route === '/api/tv/launch') {
          const r = tvLauncher.launch(body);
          return reply(202, { ok: true, queued: r.queued }, 'tv launch queued');
        }
        if (route === '/api/tvremote') return reply(200, Object.assign({ ok: true }, remote.status()));
        if (route === '/api/tvremote/run') {
          const r = remote.run(body);
          return reply(200, { ok: true, started: true, paired: r.paired }, 'tvremote run started');
        }
        if (route === '/api/linktests') {
          const l = state.resources.linktests;
          return reply(200, { ok: true, rev: l.rev, data: l.data });
        }
        if (route === '/api/grocery') {
          return reply(200, { ok: true, rev: state.resources.grocery.rev, items: state.resources.grocery.data.items });
        }
        if (route === '/api/grocery/ops') {
          const r = groceryOps(body);
          return reply(200, r, 'grocery, rev ' + state.rev);
        }
        if (route === '/api/grocery/export') {
          const r = groceryExport();
          return reply(200, r, r.items.length + ' items');
        }
        if (route === '/api/pantry') {
          needPantry();
          const v = pantryView();
          return reply(200, { ok: true, rev: v.rev, data: v.data }, v.data.counts.items + ' items');
        }
        if (route === '/api/pantry/ops') {
          const r = pantryOps(body);
          return reply(200, r, 'pantry, rev ' + r.rev);
        }
        if (route === '/api/pantry/low') {
          const items = needPantry().lowList();
          return reply(200, { ok: true, items: items }, items.length + ' low');
        }
        if (route === '/api/products' || route === '/api/products/image') {
          const q = query || new URLSearchParams();
          if (route === '/api/products/image') {
            // Over HTTP control() sends the picture itself; this answers the mailbox.
            const key = catalog.toKey(q.get('upc') || '');
            const img = catalog.imageFile(key);
            return reply(img ? 200 : 404, img ? { ok: true, upc: key, type: img.type } : { ok: false, error: 'no picture' });
          }
          catalog.lookup(q.get('upc') || '', q.get('format') || '').then((r) => reply(200, r, r.found ? 'found' : 'not found')).catch(failed);
          return undefined;
        }
        if (route === '/api/todo' && method === 'GET') {
          return reply(200, { ok: true, rev: state.rev, items: todoItems() });
        }
        if (route === '/api/command') {
          const cmd = normalizeCommand(body);
          const r = sendCommand(cmd);
          return reply(200, { ok: true, delivered: r.delivered }, cmd.type + ', delivered ' + r.delivered);
        }
        if (route === '/api/layout') {
          if (!isObj(body) || body.layout === undefined) throw bad('send { "layout": [ ... ] }, or { "layout": null } for the built-in layout');
          const layout = normalizeLayout(body.layout);
          const changed = JSON.stringify(layout) !== JSON.stringify(state.resources.layout.data.layout);
          if (changed) changeResource('layout', { layout: layout });
          const l = state.resources.layout;
          return reply(200, { ok: true, rev: l.rev, changed: changed, layout: l.data.layout },
            (layout ? layout.length + ' tiles' : 'built-in') + (changed ? ', rev ' + state.rev : ', no change'));
        }
        if (route === '/api/todo') {
          if (!isObj(body)) throw bad('the body must be a JSON object');
          const raw = { id: newTodoId(), title: body.title, section: body.section, done: false, doneAt: null, createdAt: Date.now() };
          if (body.due !== undefined) raw.due = body.due;
          if (body.notes !== undefined) raw.notes = body.notes;
          if (body.level !== undefined) raw.level = body.level;
          if (body.lead !== undefined) raw.lead = body.lead;
          const item = normalizeItem(raw, Date.now());
          const items = purgeOld(todoItems(), Date.now());
          if (items.length >= MAX_ITEMS) throw bad('the to-do list is full (' + MAX_ITEMS + ' items)');
          items.unshift(item);
          changeTodo(items);
          return reply(200, { ok: true, rev: state.rev, item: item }, 'added ' + item.id);
        }
        // /api/todo/ops
        if (!isObj(body)) throw bad('the body must be a JSON object');
        const items = applyOps(todoItems(), body.ops, Date.now());
        changeTodo(items);
        return reply(200, { ok: true, rev: state.rev, items: todoItems() }, 'rev ' + state.rev);
      } catch (e) {
        failed(e);
      }
      return undefined;
    });
  }

  function control(req, res, route, door, query) {
    const what = req.method + ' ' + route;
    const done = (status, body, note) => {
      sendJson(res, status, body);
      // A good read of the log is printed but not kept, or reading would fill it.
      log('control ' + what + ' -> ' + status + (note ? ' ' + note : '') + (door === 'tunnel' ? ' (side door)' : ''),
        route === '/api/log' && status === 200);
    };
    if (!tokenOk) return done(503, { ok: false, error: 'no token set on the server' });
    if (!checkToken(req)) return done(401, { ok: false, error: 'wrong token' });
    if (ROUTES[route] && ROUTES[route].indexOf(req.method) < 0) res.setHeader('Allow', ROUTES[route].join(', '));
    if (route === '/api/products/image' && req.method === 'GET') {
      req.resume();
      log('control GET ' + route + (door === 'tunnel' ? ' (side door)' : ''), true);
      return sendProductImage(req, res, query.get('upc') || '');
    }
    const run = (body) => api(req.method, route, body, query).then((r) => done(r.status, r.body, r.note));
    if (req.method !== 'POST' || route === '/api/calendar/refresh' || route === '/api/shows/refresh' || !ROUTES[route]) {
      req.resume(); // no body is needed
      return run(undefined);
    }
    readBody(req, res, run, route === '/api/awws' || route === '/api/budget' || route === '/api/translate' ? AWWS_BODY_LIMIT : BODY_LIMIT);
    return undefined;
  }

  /* --- the touch app: its files, its data, its grocery changes --- */

  const appDir = path.resolve(__dirname, opt.appDir || path.join('..', 'app'));
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.wasm': 'application/wasm'
  };

  // The version of the hub the Pi serves now: BUILD in appDir/hub.js, read
  // again only when the file changed (a pull). '' when it can't be read.
  const appVer = { mtime: -1, size: -1, value: '' };
  function appVersion() {
    const file = path.join(appDir, 'hub.js');
    let st;
    try { st = fs.statSync(file); } catch (e) { appVer.mtime = -1; appVer.value = ''; return ''; }
    if (st.mtimeMs === appVer.mtime && st.size === appVer.size) return appVer.value;
    appVer.mtime = st.mtimeMs;
    appVer.size = st.size;
    try {
      const m = /var BUILD = 'v(\d{1,4}\.\d{1,4}\.\d{1,4})'/.exec(fs.readFileSync(file, 'utf8'));
      appVer.value = m ? m[1] : '';
    } catch (e) { appVer.value = ''; }
    return appVer.value;
  }

  // Home, Tailscale and loopback addresses only, whatever HUB_TV_IPS says:
  // the phone is not the TV. The Host rule is the same as the TV's.
  function touchAllowed(req) {
    return isPrivateAddress(clientAddress(req)) && hostAllowed(req.headers.host);
  }

  // GET / (to the app page) and GET /app/<file>: read only, from appDir.
  function appFile(req, res, route, query) {
    if (!touchAllowed(req)) return sendJson(res, 403, { ok: false, error: 'screen not allowed' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'use GET for ' + route }, { Allow: 'GET, HEAD' });
    }
    if (route === '/') {
      const q = query.toString();
      res.writeHead(302, { Location: '/app/touch.html' + (q ? '?' + q : ''), 'Cache-Control': 'no-store' });
      return res.end();
    }
    let rel;
    try { rel = decodeURIComponent(route.slice('/app/'.length)); } catch (e) { rel = ''; }
    const type = TYPES[path.extname(rel).toLowerCase()];
    const file = path.resolve(appDir, rel);
    if (!rel || !type || rel.indexOf('\0') >= 0 || rel.split('/').some((p) => p[0] === '.') ||
        file.indexOf(appDir + path.sep) !== 0) {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    return fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  // GET /photos/list and GET /photos/img/<id>: the photo album, read only.
  // The touch door's trust (home and Tailscale addresses, a safe Host), so the
  // TV and a tablet on Tailscale both read it. Nothing is logged per request.
  function photoRoute(req, res, route, query) {
    const cors = corsHeaders(req);
    if (!touchAllowed(req)) return sendJson(res, 403, { ok: false, error: 'screen not allowed' }, cors);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'use GET for ' + route }, Object.assign({ Allow: 'GET, HEAD' }, cors));
    }
    if (route === '/photos/list') {
      return albumList().then((v) => sendJson(res, 200, {
        ok: true, rev: v.rev, count: v.count,
        items: v.items.map((i) => {
          const o = { id: i.id, w: i.w, h: i.h, month: i.month };
          if (i.video) { o.video = 1; if (i.dur) o.dur = i.dur; }
          return o;
        })
      }, cors), (e) => fail(res, e, cors));
    }
    if (route.indexOf('/photos/clip/') === 0) return photoClip(req, res, route.slice('/photos/clip/'.length), cors);
    const id = route.slice('/photos/img/'.length);
    const size = query.get('size') || 'full';
    if (!photos.isId(id)) return sendJson(res, 404, { ok: false, error: 'not found' }, cors);
    if (size !== 'full' && size !== 'thumb') return sendJson(res, 400, { ok: false, error: 'size is full or thumb' }, cors);
    return (size === 'thumb' ? album.readThumb(id) : album.readOriginal(id)).then((f) => {
      if (!f || !f.type) return sendJson(res, 404, { ok: false, error: 'not found' }, cors);
      const headers = Object.assign({
        'Content-Type': f.type, 'Content-Length': f.size,
        'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff'
      }, cors);
      if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
      const stream = fs.createReadStream(f.file);
      stream.on('error', () => {
        if (!res.headersSent) sendJson(res, 404, { ok: false, error: 'not found' }, cors);
        else res.destroy();
      });
      stream.once('open', () => res.writeHead(200, headers));
      return stream.pipe(res);
    }, (e) => fail(res, e, cors));
  }

  // GET /photos/clip/<id>: the clip, whole or one byte range ("bytes=a-b",
  // "bytes=a-", "bytes=-n"); video players ask for ranges.
  function photoClip(req, res, id, cors) {
    if (!photos.isId(id)) return sendJson(res, 404, { ok: false, error: 'not found' }, cors);
    return album.readClip(id).then((f) => {
      if (!f) return sendJson(res, 404, { ok: false, error: 'not found' }, cors);
      const headers = Object.assign({
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff'
      }, cors);
      let start = 0;
      let end = f.size - 1;
      let status = 200;
      const range = String(req.headers.range || '');
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (range && m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') { start = Math.max(0, f.size - parseInt(m[2], 10)); }
        else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10)); }
        if (start > end || start >= f.size) {
          res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + f.size, 'Content-Length': 0 }, headers));
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + f.size;
      }
      headers['Content-Length'] = end - start + 1;
      if (req.method === 'HEAD' || f.size === 0) { res.writeHead(status, headers); return res.end(); }
      const stream = fs.createReadStream(f.file, { start: start, end: end });
      stream.on('error', () => {
        if (!res.headersSent) sendJson(res, 404, { ok: false, error: 'not found' }, cors);
        else res.destroy();
      });
      stream.once('open', () => res.writeHead(status, headers));
      return stream.pipe(res);
    }, (e) => fail(res, e, cors));
  }

  // GET /touch/state, POST /grocery/ops and the products routes (the TV's grocery tile posts to /grocery/ops too, from another origin, so the browser asks with OPTIONS first). Unlike
  // /live/state this never registers the caller as a screen (so a phone is
  // not taken for the TV) and carries only what the touch app shows.
  function touch(req, res, route, query) {
    const cors = corsHeaders(req);
    if (!touchAllowed(req)) return sendJson(res, 403, { ok: false, error: 'screen not allowed' }, cors);
    if (req.method === 'OPTIONS' && (route === '/grocery/ops' || route === '/pantry/ops' || route === '/pantry/screen-ops')) {
      const h = Object.assign({ 'Cache-Control': 'no-store', 'Content-Length': 0 }, cors);
      if (cors['Access-Control-Allow-Origin']) {
        h['Access-Control-Allow-Methods'] = 'POST';
        h['Access-Control-Allow-Headers'] = 'Content-Type';
        h['Access-Control-Max-Age'] = '600';
      }
      res.writeHead(204, h);
      return res.end();
    }
    const image = route.indexOf('/products/image/') === 0;
    const want = route === '/grocery/ops' || route === '/touch/todo/ops' || route === '/pantry/ops' || route === '/pantry/screen-ops' || route === '/products/save' ? 'POST' : 'GET';
    const okMethod = req.method === want || (image && req.method === 'HEAD');
    if (!okMethod) return sendJson(res, 405, { ok: false, error: 'use ' + want + ' for ' + route }, Object.assign({ Allow: want }, cors));
    if (route === '/touch/state') {
      return sendJson(res, 200, {
        ok: true, v: PROTOCOL, server: SERVER_VERSION, epoch: state.epoch, rev: state.rev,
        grocery: state.resources.grocery, todo: state.resources.todo, products: groceryProducts(), pantry: pantryView()
      }, cors);
    }
    if (image) {
      let code = '';
      try { code = decodeURIComponent(route.slice('/products/image/'.length)); } catch (e) { code = ''; }
      if (!/^\d{8,14}$/.test(code)) return sendJson(res, 404, { ok: false, error: 'not found' }, cors);
      return sendProductImage(req, res, code, cors);
    }
    if (!originOk(req)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' }, cors);
    if (route === '/products/lookup') {
      // A GET that may call the web: it needs proof it comes from the app's
      // own page (a same-host Origin, Sec-Fetch-Site: same-origin, or the
      // X-Hub-Touch: 1 header the app sends, which another site's page
      // cannot send without a preflight this server never allows).
      if (!touchProof(req)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' }, cors);
      let p;
      try { p = catalog.lookup(query.get('upc') || '', query.get('format') || '', { client: plainAddress(clientAddress(req)) }); } catch (e) { return fail(res, e, cors); }
      return p.then((r) => sendJson(res, 200, r, cors), (e) => fail(res, e, cors));
    }
    if (route === '/touch/todo/ops') {
      // The to-do list from the touch app: the same ops as the TV's
      // POST /todo/ops (add, set, remove), only from this app's own page.
      // The TV still gets the change over its live line.
      if (!touchProof(req)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' }, cors);
      return readBody(req, res, (body) => {
        try {
          opsAndReply(res, body, cors);
          log('touch app changed the to-do list (rev ' + state.rev + ')');
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/products/save') {
      return readBody(req, res, (body) => {
        try {
          const product = catalog.save(body);
          // The grocery rows for this code take the corrected "Brand Name", so the TV tile shows the brand too.
          const cur = state.resources.grocery.data.items;
          const line = products.lineName(product);
          let lineOk = !!line && Array.from(line).length <= grocery.MAX_NAME;
          const next = cur.map((i) => {
            if (!lineOk || i.upc !== product.upc || i.name === line) return i;
            // Never make two rows with the same name (name commands pick the first).
            if (cur.some((o) => o !== i && o.name.toLowerCase() === line.toLowerCase())) return i;
            return Object.assign({}, i, { name: line });
          });
          if (JSON.stringify(next) !== JSON.stringify(cur)) changeResource('grocery', { items: next });
          // The pantry's row for this code takes the correction too.
          if (pantry) {
            try { pantry.fromCatalog(product); mirrorGrocery([]); publishPantry(); } catch (e) { log('pantry: could not take a catalog correction (' + (e.code || e.message) + ')'); }
          }
          sendJson(res, 200, { ok: true, product: product }, cors);
        } catch (e) {
          fail(res, e, cors);
        }
      }, PRODUCT_BODY_LIMIT);
    }
    if (route === '/pantry/ops' || route === '/pantry/screen-ops') {
      return readBody(req, res, (body) => {
        try {
          const r = pantryOps(body);
          sendJson(res, 200, r, cors);
          log((route === '/pantry/screen-ops' ? 'screen' : 'touch app') + ' changed the pantry (rev ' + r.rev + ')');
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    return readBody(req, res, (body) => {
      try {
        const r = groceryOps(body);
        sendJson(res, 200, r, cors);
        // A listed Origin is the TV's page; the touch app names the Pi itself.
        const who = req.headers.origin && origins.indexOf(req.headers.origin) >= 0 ? 'screen' : 'touch app';
        log(who + ' changed the grocery list (rev ' + state.rev + ')');
      } catch (e) {
        fail(res, e, cors);
      }
    });
  }

  function screen(req, res, route, query) {
    const address = clientAddress(req);
    const cors = corsHeaders(req);
    if (!screenAllowed(address, tvIps) || !hostAllowed(req.headers.host)) {
      return sendJson(res, 403, { ok: false, error: 'screen not allowed' }, cors);
    }
    if (req.method === 'OPTIONS') {
      const h = Object.assign({ 'Cache-Control': 'no-store', 'Content-Length': 0 }, cors);
      if (cors['Access-Control-Allow-Origin']) {
        h['Access-Control-Allow-Methods'] = 'GET, POST';
        h['Access-Control-Allow-Headers'] = 'Content-Type';
        h['Access-Control-Max-Age'] = '600';
      }
      res.writeHead(204, h);
      return res.end();
    }
    if (route === '/spotify/callback' && req.method === 'GET') return spotifyCallback(res, query);
    const want = route === '/todo/ops' || route === '/translate' || route === '/linktests' || route === '/tvremote/run' || route === '/tv/launch' || route === '/echo/run' || route === '/awws/resync' || route === '/budget/goal' || route === '/prefs' || route === '/shows/watched' || route === '/shows/unwatch' || route === '/shows/upto' || route === '/shows/caughtup' || route === '/guest/pin' || route.indexOf('/ambience/') === 0 ? 'POST' : 'GET';
    if (req.method !== want) {
      return sendJson(res, 405, { ok: false, error: 'use ' + want + ' for ' + route }, Object.assign({ Allow: want }, cors));
    }
    if (route === '/live/state') {
      remote.seen(address, true); // a first guess at the TV's address, for the mailbox
      return sendJson(res, 200, {
        ok: true, v: PROTOCOL, server: SERVER_VERSION, epoch: state.epoch, rev: state.rev, resources: state.resources
      }, cors);
    }
    if (route === '/live/events') return openSse(req, res, address);
    if (route === '/live/poll') return openPoll(req, res, query, address);
    if (route === '/shows/episodes') {
      // One show's seasons and episodes, read by the TV when its show page
      // opens. A plain read like /live/state: nothing is changed and nothing logged.
      const id = query.get('id');
      if (typeof id !== 'string' || !id.trim() || id.length > 80) {
        return sendJson(res, 400, { ok: false, error: 'send ?id=<show id>' }, cors);
      }
      const v = tracker.episodes(id);
      if (!v) return sendJson(res, 404, { ok: false, error: 'that show is not on the list' }, cors);
      return sendJson(res, 200, Object.assign({ ok: true }, v), cors);
    }
    // POST /todo/ops and /ambience/*. A web page on another site must not be
    // able to change the list or the lights through a browser at home, so a
    // foreign Origin is refused.
    if (!originOk(req)) {
      return sendJson(res, 403, { ok: false, error: 'origin not allowed' }, cors);
    }
    if (route === '/guest/pin') {
      // The Guest mode PIN: a screen route, so with HUB_TV_IPS set only the TV
      // (and this Pi) can try PINs; never a phone on the touch door. Never log
      // the PIN; guestpin.js logs wrong tries and locks by count only.
      return readBody(req, res, (body) => {
        guestPin.handle(body).then((r) => {
          // "All screens" in the PIN pop-up: { all: true, on } with a right PIN
          // (check), or with a new one (set), turns Guest mode on or off everywhere.
          const all = isObj(body) && body.all === true && typeof body.on === 'boolean';
          const okPin = isObj(r) && ((body.action === 'check' && r.match === true) || (body.action === 'set' && r.ok === true));
          if (all && okPin) {
            try {
              setGuestAll(body.on);
              r = Object.assign({}, r, { all: true });
              log('screen turned Guest mode ' + (body.on ? 'on' : 'off') + ' on every screen');
            } catch (e) { return fail(res, e, cors); }
          }
          sendJson(res, 200, r, cors);
        }, (e) => fail(res, e, cors));
      });
    }
    if (route === '/translate') {
      return readBody(req, res, (body) => {
        api('POST', '/api/translate', body).then((r) => sendJson(res, r.status, r.body, cors));
      }, AWWS_BODY_LIMIT);
    }
    if (route === '/linktests') {
      return readBody(req, res, (body) => {
        try {
          if (!isObj(body)) throw bad('send { "result": { ... } }');
          const r = linktests.normalizeResult(body.result, Date.now());
          changeResource('linktests', linktests.addResult(state.resources.linktests.data, r));
          sendJson(res, 200, { ok: true, rev: state.rev }, cors);
          log('screen sent a watch link test answer (' + r.outcome + ')');
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/tvremote/run') {
      // The TV asks the Pi to open an app, press Enter and send a link, since
      // the TV refuses key presses it sends to itself. The TV's address is
      // this request's. The run goes on after the reply; nothing about it
      // (link, app id, address) reaches the log here (tvremote.js logs steps).
      return readBody(req, res, (body) => {
        try {
          remote.seen(address);
          const r = remote.run(body, remote.address() || undefined);
          sendJson(res, 200, { ok: true, started: true, paired: r.paired }, cors);
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/tv/launch') {
      // A tablet or phone asks the Pi to open something on the TV. The reply is
      // at once; the work goes on in the background (tvlaunch.js). This is not
      // the TV's own address, so nothing here is saved as the TV's.
      return readBody(req, res, (body) => {
        try {
          const r = tvLauncher.launch(body);
          sendJson(res, 202, { ok: true, queued: r.queued }, cors);
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/budget/goal') {
      // Budget lab's goal control. The amount is never logged.
      return readBody(req, res, (body) => {
        try {
          const g = setBudgetGoal(body);
          sendJson(res, 200, g, cors);
          log(g.changed ? 'screen set the daily budget goal (from ' + g.from + ')' : 'screen set the daily budget goal (unchanged)');
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/prefs') {
      // A widget preference from a screen (prefs.js): { key, value }. Pushed to
      // every screen. The value is never logged (the saved cap is an amount).
      return readBody(req, res, (body) => {
        try {
          const r = setPref(body);
          sendJson(res, 200, r, cors);
          if (r.changed) log('screen set the shared preference ' + r.key);
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/awws/resync') {
      // The TV's "Sync now" button. No body is read.
      return readBody(req, res, () => {
        try {
          const r = awwsResync();
          sendJson(res, 200, { ok: true, requestedAt: r.requestedAt, already: r.already }, cors);
          log(r.already ? 'screen asked for a sync (already waiting)' : 'screen asked for a sync');
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/shows/watched' || route === '/shows/unwatch') {
      // The TV marks an episode (after the person said they watched it) or takes
      // the mark off again. It names the show by its id and the episode by
      // numbers; nothing else, and no name, number or id reaches the log.
      const off = route === '/shows/unwatch';
      return readBody(req, res, (body) => {
        try {
          if (!isObj(body) || typeof body.id !== 'string' || !body.id) throw bad('send { "id": "show-id", "season": 3, "number": 4 }');
          const ep = { season: body.season, number: body.number };
          const r = off ? tracker.unwatch(body.id, ep) : tracker.markWatched(body.id, ep);
          sendJson(res, 200, { ok: true, changed: r.changed }, cors);
          log(off ? 'screen took a watched mark off an episode' : 'screen marked an episode watched' + (r.changed ? '' : ' (already marked)'));
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/shows/upto' || route === '/shows/caughtup') {
      // "Watched up to here" and "caught up" from the show page. Same door as
      // /shows/watched; the log never carries the show, the episode or an address.
      const all = route === '/shows/caughtup';
      return readBody(req, res, (body) => {
        try {
          if (!isObj(body) || typeof body.id !== 'string' || !body.id) throw bad(all ? 'send { "id": "show-id" }' : 'send { "id": "show-id", "season": 3, "number": 4 }');
          const r = all ? tracker.caughtUp(body.id) : tracker.upTo(body.id, { season: body.season, number: body.number });
          const out = { ok: true, changed: r.changed };
          if (all) { out.season = r.season; out.number = r.number; }
          sendJson(res, 200, out, cors);
          log((all ? 'screen marked a show caught up' : 'screen marked a show watched up to an episode') + (r.changed ? '' : ' (already marked)'));
        } catch (e) {
          fail(res, e, cors);
        }
      });
    }
    if (route === '/echo/run') {
      if (!echoScreenAllowed()) {
        req.resume();
        return sendJson(res, 429, { ok: false, error: 'slow down' }, cors);
      }
      readBody(req, res, (body) => {
        echoRun(body).then((a) => sendJson(res, a.status, a.body, cors), () => sendJson(res, 500, { ok: false, error: 'the server had a problem' }, cors));
      });
      return undefined;
    }
    if (route.indexOf('/ambience/') === 0) {
      // The TV holds no secret: it may only name ids from the saved
      // settings, and not too fast. Nothing about it is logged here (the
      // address included); ambience.js logs counts and results.
      if (!lights.screenAllowed()) {
        req.resume();
        return sendJson(res, 429, { ok: false, error: 'slow down' }, cors);
      }
      readBody(req, res, (body) => {
        ambienceCall('POST', route, body).then((a) => sendJson(res, a.status, a.body, cors));
      });
      return undefined;
    }
    readBody(req, res, (body) => {
      try {
        opsAndReply(res, body, cors);
        log('screen changed the to-do list ' + address + ' (rev ' + state.rev + ')');
      } catch (e) {
        fail(res, e, cors);
      }
    });
  }

  // Where Spotify's approval page sends the browser. It only loads when that
  // browser can reach this server at the redirect address (a browser on the
  // Pi, or someone swapped 127.0.0.1 for the Pi's address by hand); otherwise
  // the address is pasted into ./hub spotify login instead. Either way the
  // one-time code is only good together with the link this server made.
  function spotifyCallback(res, query) {
    const page = (status, title, text) => {
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Home Hub</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
        'background:#0b0d11;color:#f4f5f7;font:18px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
        'main{max-width:30em;padding:2em}h1{font-size:1.6em;font-weight:600;margin:0 0 .5em}p{margin:0;color:#b9bdc7}</style></head>' +
        '<body><main><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></main></body></html>';
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      res.end(html);
    };
    const q = query.toString();
    player.finishLogin(q ? '?' + q : '').then((r) => {
      log('Spotify: sign-in finished through the callback page');
      page(200, 'Spotify is connected', (r.user ? 'Signed in as ' + r.user + '. ' : '') + 'You can close this tab. The TV shows what is playing within a few seconds.');
    }, (e) => {
      page(e && e.status === 502 ? 502 : 400, 'That did not work', (e && e.status ? e.message : 'The server had a problem.'));
    });
  }

  const SCREEN_ROUTES = {
    '/live/state': 1, '/live/events': 1, '/live/poll': 1, '/todo/ops': 1, '/translate': 1, '/linktests': 1, '/tvremote/run': 1, '/tv/launch': 1, '/awws/resync': 1, '/budget/goal': 1, '/prefs': 1, '/shows/watched': 1, '/shows/unwatch': 1, '/shows/upto': 1, '/shows/caughtup': 1, '/shows/episodes': 1, '/spotify/callback': 1,
    '/ambience/scene': 1, '/ambience/light': 1, '/ambience/mood': 1,
    '/echo/run': 1, '/guest/pin': 1
  };

  const TOUCH_ROUTES = { '/touch/state': 1, '/grocery/ops': 1, '/touch/todo/ops': 1, '/pantry/ops': 1, '/pantry/screen-ops': 1, '/products/lookup': 1, '/products/save': 1 };

  function handler(door) {
    return (req, res) => {
      try {
        if (closing) return sendJson(res, 503, { ok: false, error: 'the server is shutting down' }, { Connection: 'close' });
        let url;
        try {
          url = new URL(req.url, 'http://hub.local');
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: 'bad address' });
        }
        const route = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
        if (route === '/health') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return sendJson(res, 405, { ok: false, error: 'use GET for /health' }, { Allow: 'GET' });
          }
          return sendJson(res, 200, { ok: true, server: SERVER_VERSION, app: appVersion() });
        }
        if (route === '/api' || route.indexOf('/api/') === 0) return control(req, res, route, door, url.searchParams);
        if (door === 'main' && (route === '/' || route.indexOf('/app/') === 0)) return appFile(req, res, route, url.searchParams);
        if (door === 'main' && (route === '/photos/list' || route.indexOf('/photos/img/') === 0 || route.indexOf('/photos/clip/') === 0)) return photoRoute(req, res, route, url.searchParams);
        if (door === 'main' && (TOUCH_ROUTES[route] || route.indexOf('/products/image/') === 0)) return touch(req, res, route, url.searchParams);
        if (door === 'main' && SCREEN_ROUTES[route]) return screen(req, res, route, url.searchParams);
        return sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        try { fail(res, e); } catch (e2) { /* the socket is gone */ }
      }
    };
  }

  /* --- listeners --- */

  /* --- Spanish for the owner's own text (translate.js) --- */
  const translator = translate.createTranslator({
    dataDir: dataDir, log: log, call: opt.translateCall,
    key: opt.translateKey !== undefined ? opt.translateKey : ''
  });

  /* --- the Claude mailbox (mailbox.js) --- */

  // opt.mailboxEnv is the .env settings (HUB_MAILBOX_...). Off when not set.
  const mailboxCfg = mailbox.configFromEnv(opt.mailboxEnv || {});
  let mbox = null;
  if (mailboxCfg.configured) {
    mbox = mailbox.createMailbox({
      config: mailboxCfg, api: api, version: SERVER_VERSION, log: log,
      healthDir: path.join(dataDir, 'health'),
      onRestart: typeof opt.onRestart === 'function' ? opt.onRestart : null,
      now: typeof opt.mailboxNow === 'function' ? opt.mailboxNow : undefined,
      s3: opt.mailboxS3, manual: opt.mailboxManual === true
    });
    mbox.start();
  } else {
    log('Claude mailbox: off' + (mailboxCfg.problem ? ' (' + mailboxCfg.problem + ')' : ' (no HUB_MAILBOX_ settings in .env)'));
  }

  const servers = [];
  function makeServer(door) {
    const s = http.createServer(handler(door));
    s.headersTimeout = 20000;
    if ('requestTimeout' in s) s.requestTimeout = 30000; // whole request in; does not cut the push line
    s.timeout = 60000; // idle sockets; the push line turns this off for itself
    s.keepAliveTimeout = 5000;
    s.maxConnections = 200;
    s.sockets = new Set();
    s.on('connection', (sock) => {
      s.sockets.add(sock);
      sock.on('close', () => s.sockets.delete(sock));
    });
    s.on('clientError', (err, sock) => {
      try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) { sock.destroy(); }
    });
    servers.push(s);
    return s;
  }

  const main = makeServer('main');
  const tunnel = tunnelPortWanted !== null ? makeServer('tunnel') : null;

  function listen(s, p, host, name) {
    return new Promise((resolve, reject) => {
      const onErr = (e) => {
        log(name + ' could not listen on port ' + p + ': ' + (e.code === 'EADDRINUSE' ? 'that port is already in use' : e.message));
        reject(e);
      };
      s.once('error', onErr);
      s.listen(p, host, () => {
        s.removeListener('error', onErr);
        s.on('error', (e) => log(name + ' error: ' + e.message));
        resolve(s.address().port);
      });
    });
  }

  const handle = {
    port: null,
    tunnelPort: null,
    ready: null,
    close: close,
    api: api,
    mailbox: mbox,
    spotify: player,
    ambience: lights,
    // Keeps a line that was already printed some other way (process events).
    note: (s) => { try { remember(String(s)); } catch (e) { /* never throws */ } },
    shows: tracker,
    allsounds: sounds,
    echo: echoCtl,
    products: catalog,
    pantry: pantry,
    _debug: () => {
      forgetOld();
      return {
        sse: sse.size, polls: polls.size, commands: remembered.length, pollScreens: pollSeen.size, pingTimer: !!pingTimer,
        calendar: calReader.debug(), spotify: player.debug()
      };
    }
  };

  const waits = [listen(main, port, opt.host || undefined, 'main door').then((p) => {
    handle.port = p;
    log('Home Hub live server ' + SERVER_VERSION + ' listening on port ' + p + (tvIps.length ? ' (screens: ' + tvIps.join(', ') + ')' : ''));
  })];
  // With no host given, Node binds at once, so the real port is known now.
  const early = main.address();
  if (early && typeof early === 'object') handle.port = early.port;
  if (tunnel) {
    waits.push(listen(tunnel, tunnelPortWanted, '127.0.0.1', 'side door').then((p) => {
      handle.tunnelPort = p;
      log('side door (control API only) on 127.0.0.1:' + p);
    }));
  }
  handle.ready = Promise.all(waits).then(() => handle);
  handle.ready.catch(() => {}); // the caller decides what a failed start means

  function close(cb) {
    if (closing) { if (cb) setImmediate(cb); return; }
    closing = true;
    calReader.close();
    player.close();
    tracker.close();
    sounds.close();
    lights.close();
    catalog.close();
    if (pantry) pantry.close();
    if (mbox) mbox.close();
    Array.from(sse).forEach((c) => dropSse(c, 'server stopping'));
    Array.from(polls).forEach((p) => finishPoll(p, pollAnswer(p, true)));
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (forgetTimer) { clearInterval(forgetTimer); forgetTimer = null; }
    remembered = [];
    pollSeen.clear();
    try { saveState(dataDir, state); } catch (e) { log('final save failed: ' + e.message); }
    let left = servers.length;
    const one = () => { if (--left === 0 && cb) cb(); };
    servers.forEach((s) => {
      s.close(one);
      s.sockets.forEach((sock) => sock.destroy());
    });
  }

  return handle;
}

module.exports = {
  start: start,
  SERVER_VERSION: SERVER_VERSION,
  parseEnv: parseEnv,
  readEnvFile: readEnvFile,
  loadSettings: loadSettings,
  isPrivateAddress: isPrivateAddress,
  isLoopback: isLoopback,
  screenAllowed: screenAllowed,
  hostAllowed: hostAllowed,
  plainAddress: plainAddress,
  normalizeItem: normalizeItem,
  applyOps: applyOps,
  normalizeCommand: normalizeCommand,
  normalizeLayout: normalizeLayout
};

/* ---------- run directly ---------- */

if (require.main === module) {
  const env = loadSettings(path.join(__dirname, '.env'));
  const hub = start({
    token: env.HUB_TOKEN || '',
    port: env.HUB_PORT || DEFAULT_PORT,
    tvIps: env.HUB_TV_IPS || '',
    tvRemoteIp: env.HUB_TV_REMOTE_IP || '',
    origins: env.HUB_ORIGINS || '',
    tunnelPort: env.HUB_TUNNEL_PORT || null,
    dataDir: env.HUB_DATA_DIR || 'data',
    appDir: env.HUB_APP_DIR || '',
    calendarEnv: env,
    timezone: env.HUB_TIMEZONE || '',
    refreshMinutes: env.CALENDAR_REFRESH_MINUTES || '',
    mailboxEnv: env,
    translateKey: env.HUB_TRANSLATE_KEY || env.GEMINI_VIDEO_GEN_KEY || '',
    spotifyEnv: env,
    // TVmaze for the show schedule. HUB_SHOWS=off stops the lookups;
    // HUB_SHOWS=sample shows the made-up sample instead (for trying the TV).
    shows: {
      enabled: env.HUB_SHOWS !== 'off',
      sampleFile: env.HUB_SHOWS === 'sample' ? path.join(__dirname, 'fixtures', 'shows-sample.json') : undefined
    },
    allsoundsEnv: env,
    echoEnv: env,
    tvLaunchEnv: env,
    ambienceEnv: env,
    // The mailbox's "restart": stop cleanly, and Docker (restart: unless-stopped)
    // or systemd (Restart=always) starts the server again, with any new code.
    onRestart: () => {
      hub.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    }
  });
  hub.ready.catch(() => process.exit(1));
  // Prints exactly as before, and keeps the line for GET /api/log too.
  function note(text) {
    try { console.log(stamp() + ' ' + text); } catch (e) { /* nothing more to do */ }
    try { hub.note(text); } catch (e) { /* never throws */ }
  }
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    note(sig + ' received, stopping');
    hub.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (e) => note('unexpected error (still running): ' + (e && e.stack)));
  process.on('unhandledRejection', (e) => note('unexpected error (still running): ' + (e && e.message)));
}
