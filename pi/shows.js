/*
 * The TV show schedule for the Entertainment panel's Schedule. The owner keeps
 * a short list of shows (data/shows.json on the Pi, started from
 * pi/shows-seed.json the first time); this file looks each one up on TVmaze
 * (https://api.tvmaze.com, public, no key), works out what airs next and
 * hands the result to server.js, which keeps it as the resource "shows" and
 * pushes it to the TV. The contract is docs/shows-snapshot.md.
 *
 *   list entry   { name, service?, tvmazeId?, serviceOverride?, alsoOn?, via? }
 *                name: as the owner says it; service: the show's watch app,
 *                its badge on the TV (wins over what TVmaze says);
 *                serviceOverride: the app "Watch on" opens when it differs
 *                from the badge; alsoOn: other apps that carry it (the TV
 *                offers them as "Also on ..."); via: the app it is
 *                billed through and opened in ("Prime Video" for HBO Max
 *                through Prime Video Channels; the badge still says
 *                HBO Max); tvmazeId: filled in by the
 *                first lookup and kept. The TV may also send a whole
 *                service elsewhere (widgets.entertainment.watchAliases in
 *                app/config.js, Hulu -> Disney+ by default).
 *
 * Watched episodes: each list entry may carry watched: [{ s, e, at }] (season,
 * episode, when it was marked). The TV marks one when the person answers
 * "Did you finish?" or taps the check on a row (POST /shows/watched and
 * POST /shows/unwatch from the screen);
 * ./hub shows watched / unwatch and the mailbox (shows.watched, shows.unwatch)
 * correct mistakes. The snapshot gets shows[].watched and watched: true on
 * the matching upcoming / next episodes (docs/shows-snapshot.md).
 *
 * Progress beyond single episodes (server 0.12.0): an entry may also carry
 * upTo: { s, e, at } ("watched up to here": every numbered episode of an
 * earlier season, or of that season up to that number, counts as watched) and
 * unwatched: [{ s, e }] (at most 200 episodes inside that range that were NOT
 * seen). An episode is watched when it is in the watched list, or is covered
 * by upTo and not in unwatched; specials (no season or number) never are.
 * POST /shows/upto and /shows/caughtup (and ./hub shows upto / caughtup, the
 * mailbox's shows.upto / shows.caughtup) set it, no TVmaze call. Setting upTo
 * to an EARLIER point than before replaces it: the episodes between the new
 * point and the old one become unwatched again, except those still in the
 * watched list. "Caught up" is upTo = the latest episode already aired.
 * The snapshot gets shows[].progress { upTo, unwatched, aired, seen,
 * caughtUp, next } (docs/shows-snapshot.md).
 *
 * Every show's full episode list (numbered episodes only, season, number,
 * name, airstamp, runtime; at most 800) comes from the same GET /shows/<id>/
 * episodes call and is kept in data/show-episodes.json (keyed by the show's
 * id, written only when it changes). It never goes to the TV in the snapshot:
 * the TV asks for it with GET /shows/episodes?id=<show id>, one show at a
 * time. In sample mode the lists come from the fixture's per-show "episodes".
 *
 * TVmaze calls, per show and refresh: GET /singlesearch/shows?q=<name> once
 * (until the id is known), then GET /shows/<id>?embed[]=nextepisode&
 * embed[]=previousepisode and GET /shows/<id>/episodes. At most 20 calls in
 * any 10 seconds (TVmaze's limit), one at a time; a 429 waits and tries again.
 * Every 6 hours, and on ./hub shows refresh.
 *
 * A show that can't be read keeps its last good copy (state.json holds the
 * resource, so this survives a restart), marked stale; a TVmaze outage never
 * blanks the TV.
 *
 * Times go to the TV as UTC ("2026-11-18T02:00:00Z"); the TV shows them in
 * its own time zone.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_API = 'https://api.tvmaze.com';
const SEED_FILE = path.join(__dirname, 'shows-seed.json');
const LIST_NAME = 'shows.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RATE_CALLS = 20;
const RATE_WINDOW_MS = 10000;
const FETCH_TIMEOUT = 10000;
const BODY_LIMIT = 4 * 1024 * 1024;
const RETRY_429_MS = 2500;
const MAX_429_TRIES = 3;
const DAY_MS = 86400000;
const BACK_MS = 7 * DAY_MS;      // the week view shows the days already gone
const AHEAD_MS = 60 * DAY_MS;
const MAX_SHOWS = 40;
const MAX_UPCOMING = 40;         // episodes per show
const MAX_NAME = 80;
const MAX_SERVICE = 24;
const MAX_EP_NAME = 80;
const MAX_ALSO = 4;
const MAX_UNWATCHED = 200;      // exceptions inside the up-to point kept per show
const MAX_EPISODES = 800;        // episodes kept in a show's full list
const EPISODES_NAME = 'show-episodes.json';
const MAX_WATCHED = 400;         // watched episodes kept per show (the oldest go first)
const SEND_WATCHED = 60;         // watched episodes the TV is sent per show (the newest)
const MAX_EP_NUM = 9999;
const STATUSES = ['Running', 'Ended', 'To Be Determined', 'In Development'];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/* ---------- small helpers ---------- */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

function plural(n, word, many) {
  return n + ' ' + (n === 1 ? word : (many || word + 's'));
}

// Plain one-line text: control characters out, cut with "…" past max.
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
}

// TVmaze's episode names may carry HTML entities; the TV shows plain text.
function plainName(v, max) {
  const t = typeof v === 'string' ? v.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
  return cleanText(t, max);
}

// "Hell's Kitchen" -> "hells-kitchen". The show's id on the TV.
function slug(name) {
  const s = String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'show').slice(0, 40).replace(/-+$/, '');
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/* ---------- services ---------- */

// TVmaze's channel names, as the TV's badges and its Entertainment items say them.
const SERVICE_NAMES = {
  'apple tv+': 'Apple TV', 'apple tv': 'Apple TV',
  'netflix': 'Netflix',
  'disney+': 'Disney+', 'disney plus': 'Disney+',
  'hulu': 'Hulu',
  'peacock': 'Peacock', 'peacock premium': 'Peacock',
  'prime video': 'Prime Video', 'amazon prime video': 'Prime Video', 'amazon': 'Prime Video',
  'hbo max': 'HBO Max', 'max': 'HBO Max', 'hbo': 'HBO Max',
  'paramount+': 'Paramount+', 'paramount plus': 'Paramount+'
};

function serviceName(v) {
  const t = cleanText(v, MAX_SERVICE);
  const k = t.toLowerCase();
  return has(SERVICE_NAMES, k) ? SERVICE_NAMES[k] : t;
}

// Streaming shows: the web channel. Broadcast: the network.
function channelOf(show) {
  if (!isObj(show)) return '';
  if (isObj(show.webChannel) && typeof show.webChannel.name === 'string') return serviceName(show.webChannel.name);
  if (isObj(show.network) && typeof show.network.name === 'string') return serviceName(show.network.name);
  return '';
}

/* ---------- the owner's list ---------- */

// Checks one list entry. Throws a 400 error that names the problem.
function normalizeEntry(raw, where) {
  const at = where ? ' (' + where + ')' : '';
  if (typeof raw === 'string') raw = { name: raw };
  if (!isObj(raw)) throw bad('each show must be an object like {"name": "Stick", "service": "Apple TV"}' + at);
  Object.keys(raw).forEach((k) => {
    if (['name', 'service', 'tvmazeId', 'serviceOverride', 'alsoOn', 'via', 'watched', 'upTo', 'unwatched'].indexOf(k) < 0) {
      throw bad('unknown field "' + cleanText(k, 30) + '" (use name, service, tvmazeId, serviceOverride, alsoOn, via, watched, upTo, unwatched)' + at);
    }
  });
  const name = cleanText(raw.name, MAX_NAME + 1);
  if (!name) throw bad('"name" is missing or empty' + at);
  if (Array.from(name).length > MAX_NAME) throw bad('"name" is longer than ' + MAX_NAME + ' characters' + at);
  const out = { name: name };
  ['service', 'serviceOverride', 'via'].forEach((k) => {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') return;
    if (typeof raw[k] !== 'string') throw bad('"' + k + '" must be text' + at);
    const t = cleanText(raw[k], MAX_SERVICE + 1);
    if (Array.from(t).length > MAX_SERVICE) throw bad('"' + k + '" is longer than ' + MAX_SERVICE + ' characters' + at);
    if (t) out[k] = serviceName(t);
  });
  if (raw.tvmazeId !== undefined && raw.tvmazeId !== null && raw.tvmazeId !== '') {
    const n = typeof raw.tvmazeId === 'string' && /^\d{1,9}$/.test(raw.tvmazeId) ? Number(raw.tvmazeId) : raw.tvmazeId;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999999999) throw bad('"tvmazeId" must be a whole number' + at);
    out.tvmazeId = n;
  }
  if (raw.alsoOn !== undefined && raw.alsoOn !== null) {
    const list = typeof raw.alsoOn === 'string' ? raw.alsoOn.split(',') : raw.alsoOn;
    if (!Array.isArray(list)) throw bad('"alsoOn" must be a list of app names, like ["Hulu"]' + at);
    const also = [];
    list.forEach((v) => {
      if (typeof v !== 'string') throw bad('"alsoOn" must be a list of app names' + at);
      const t = cleanText(v, MAX_SERVICE + 1);
      if (Array.from(t).length > MAX_SERVICE) throw bad('an "alsoOn" app is longer than ' + MAX_SERVICE + ' characters' + at);
      const name = t ? serviceName(t) : '';
      if (name && also.indexOf(name) < 0) also.push(name);
    });
    if (also.length > MAX_ALSO) throw bad('"alsoOn" has ' + also.length + ' apps; at most ' + MAX_ALSO + at);
    if (also.length) out.alsoOn = also;
  }
  if (raw.watched !== undefined && raw.watched !== null) {
    const w = cleanWatched(raw.watched);
    if (w === null) throw bad('"watched" must be a list like [{"s": 3, "e": 4, "at": "2026-11-17T20:00:00Z"}]' + at);
    if (w.length) out.watched = w;
  }
  if (raw.upTo !== undefined && raw.upTo !== null) {
    const u = cleanUpTo(raw.upTo);
    if (u === null) throw bad('"upTo" must look like {"s": 3, "e": 4, "at": "2026-11-17T20:00:00Z"}' + at);
    out.upTo = u;
  }
  if (raw.unwatched !== undefined && raw.unwatched !== null) {
    const x = cleanUnwatched(raw.unwatched);
    if (x === null) throw bad('"unwatched" must be a list like [{"s": 3, "e": 2}]' + at);
    // Only episodes inside the up-to point can be exceptions to it.
    const inside = out.upTo ? x.filter((y) => covers(out.upTo, y.s, y.e)) : [];
    if (inside.length) out.unwatched = inside;
  }
  return out;
}

/* ---------- watched episodes ---------- */

// [{ s, e, at }] cleaned: whole numbers, one per episode, oldest first, at
// most MAX_WATCHED. null when it is not a list of such objects.
function cleanWatched(v) {
  if (!Array.isArray(v)) return null;
  const seen = {};
  const out = [];
  for (const x of v) {
    if (!isObj(x) || !Number.isInteger(x.s) || !Number.isInteger(x.e) || x.s < 0 || x.e < 0 || x.s > MAX_EP_NUM || x.e > MAX_EP_NUM) return null;
    const k = x.s + 'x' + x.e;
    if (seen[k]) continue;
    seen[k] = true;
    out.push({ s: x.s, e: x.e, at: timeOf(x.at) || iso(0) });
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out.slice(-MAX_WATCHED);
}

// "S3E4", "s3e4", "3x4" or "S3 E4" -> { season: 3, number: 4 }, else null.
function parseEpisode(text) {
  const m = /^\s*s?(\d{1,4})\s*[ex]\s*(\d{1,4})\s*$/i.exec(String(text === undefined || text === null ? '' : text));
  return m ? { season: Number(m[1]), number: Number(m[2]) } : null;
}

// { s, e, at } cleaned, or null when it is not one.
function cleanUpTo(v) {
  if (!isObj(v) || !Number.isInteger(v.s) || !Number.isInteger(v.e) || v.s < 0 || v.e < 0 || v.s > MAX_EP_NUM || v.e > MAX_EP_NUM) return null;
  return { s: v.s, e: v.e, at: timeOf(v.at) || iso(0) };
}

// [{ s, e }] cleaned: whole numbers, one per episode, at most MAX_UNWATCHED
// (the newest in the list). null when it is not a list of such objects.
function cleanUnwatched(v) {
  if (!Array.isArray(v)) return null;
  const seen = {};
  const out = [];
  for (const x of v) {
    if (!isObj(x) || !Number.isInteger(x.s) || !Number.isInteger(x.e) || x.s < 0 || x.e < 0 || x.s > MAX_EP_NUM || x.e > MAX_EP_NUM) return null;
    const k = x.s + 'x' + x.e;
    if (seen[k]) continue;
    seen[k] = true;
    out.push({ s: x.s, e: x.e });
  }
  return out.slice(-MAX_UNWATCHED);
}

// Is the numbered episode inside the up-to point of upTo ({ s, e })?
function covers(upTo, season, number) {
  if (!upTo || !Number.isInteger(season) || !Number.isInteger(number)) return false;
  return season < upTo.s || (season === upTo.s && number <= upTo.e);
}

// Watched: in the watched list, or inside the up-to point and not one of its
// exceptions. A special (no season or number) never is.
function isWatched(entry, season, number) {
  if (!entry || !Number.isInteger(season) || !Number.isInteger(number)) return false;
  if (Array.isArray(entry.watched) && entry.watched.some((w) => w.s === season && w.e === number)) return true;
  if (!covers(entry.upTo, season, number)) return false;
  return !(Array.isArray(entry.unwatched) && entry.unwatched.some((w) => w.s === season && w.e === number));
}

// Does the list entry carry any progress at all?
function hasProgress(entry) {
  return !!(entry && ((entry.watched && entry.watched.length) || entry.upTo || (entry.unwatched && entry.unwatched.length)));
}

function lastOf(a, b) {
  return a.season !== b.season ? a.season - b.season : a.number - b.number;
}

// A show's progress for the TV, from its list entry and its full episode list
// ([{ season, number, ... }], numbered, sorted) as of nowMs. aired = numbered
// episodes already out, seen = how many of those are watched, next = the
// earliest aired one that is not.
function progressOf(entry, eps, nowMs) {
  const aired = (eps || []).filter((x) => Date.parse(x.airstamp) <= nowMs);
  let seen = 0;
  let next = null;
  aired.forEach((x) => {
    if (isWatched(entry, x.season, x.number)) seen++;
    else if (!next || lastOf(x, next) < 0) next = { season: x.season, number: x.number };
  });
  const u = entry && entry.upTo;
  return {
    upTo: u ? { season: u.s, number: u.e, at: u.at } : null,
    unwatched: ((entry && entry.unwatched) || []).map((x) => ({ season: x.s, number: x.e })),
    aired: aired.length,
    seen: seen,
    caughtUp: aired.length > 0 && seen === aired.length,
    next: next
  };
}

// Marks watched on a built show (fresh or a last good copy) from its list
// entry: show.watched (the newest SEND_WATCHED), watched: true on episodes and
// show.progress (eps: the show's full episode list, [] when not known).
function applyWatched(show, entry, eps, nowMs) {
  const list = entry && Array.isArray(entry.watched) ? entry.watched : [];
  const mark = (e) => {
    if (!e) return;
    if (isWatched(entry, e.season, e.number)) e.watched = true; else delete e.watched;
  };
  mark(show.nextEpisode);
  (show.upcoming || []).forEach(mark);
  show.watched = list.slice(-SEND_WATCHED).map((w) => ({ season: w.s, number: w.e, at: w.at }));
  show.progress = progressOf(entry, eps, nowMs === undefined ? Date.now() : nowMs);
  return show;
}

// TVmaze's episode list as kept: numbered episodes only, no doubles, in
// order, at most MAX_EPISODES (the latest). [{ season, number, name, airstamp, runtime? }]
function compactEpisodes(raw) {
  const seen = {};
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((r) => {
    const e = episodeOf(r);
    if (!e || e.season === null || e.number === null) return;
    const k = e.season + 'x' + e.number;
    if (seen[k]) return;
    seen[k] = true;
    out.push(epOut(e));
  });
  out.sort(lastOf);
  return out.slice(-MAX_EPISODES);
}

function normalizeList(raw) {
  if (!Array.isArray(raw)) throw bad('the show list must be a list, like [{"name": "Stick", "service": "Apple TV"}]');
  if (raw.length > MAX_SHOWS) throw bad('the show list has ' + raw.length + ' shows; at most ' + MAX_SHOWS);
  const out = [];
  raw.forEach((r, n) => {
    const e = normalizeEntry(r, 'show ' + (n + 1));
    if (out.some((o) => sameName(o.name, e.name) || slug(o.name) === slug(e.name))) throw bad('"' + e.name + '" is on the list twice');
    out.push(e);
  });
  return out;
}

// The list from data/shows.json, or the seed when there is none yet. A
// damaged file is moved aside and the seed used.
function readList(file, seedFile, log) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
  if (text !== null) {
    try {
      const raw = JSON.parse(text);
      return { list: normalizeList(isObj(raw) && Array.isArray(raw.shows) ? raw.shows : raw), seeded: false };
    } catch (e) {
      const aside = file.replace(/\.json$/, '') + '.bad-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      try { fs.renameSync(file, aside); } catch (e2) { /* nothing more to do */ }
      // Logs never carry show names or paths (Ian's rule): counts and codes only.
      if (log) log('shows: the show list file was damaged; moved it aside and started from the seed list');
    }
  }
  let seed = [];
  try { seed = normalizeList(JSON.parse(fs.readFileSync(seedFile || SEED_FILE, 'utf8')).shows); } catch (e) { seed = []; }
  return { list: seed, seeded: true };
}

function writeList(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ shows: list }, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// The entry named by text: its exact name (any case) or its id ("hells-kitchen").
function findEntry(list, text) {
  const t = String(text || '').trim();
  return list.find((e) => sameName(e.name, t)) || list.find((e) => slug(e.name) === t.toLowerCase()) || null;
}

/* ---------- reading TVmaze's answers ---------- */

function timeOf(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return isFinite(ms) ? iso(ms) : null;
}

function episodeOf(ep) {
  if (!isObj(ep)) return null;
  const airstamp = timeOf(ep.airstamp);
  if (!airstamp) return null;
  const season = Number.isInteger(ep.season) && ep.season >= 0 ? ep.season : null;
  const number = Number.isInteger(ep.number) && ep.number >= 0 ? ep.number : null;
  const out = { season: season, number: number, name: plainName(ep.name, MAX_EP_NAME), airstamp: airstamp };
  if (Number.isInteger(ep.runtime) && ep.runtime >= 1 && ep.runtime <= 600) out.runtime = ep.runtime;
  if (typeof ep.airdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate)) out.airdate = ep.airdate;
  return out;
}

// An episode as the TV gets it (the runtime in minutes only when TVmaze has one).
function epOut(e) {
  const o = { season: e.season, number: e.number, name: e.name, airstamp: e.airstamp };
  if (e.runtime) o.runtime = e.runtime;
  return o;
}

// One show for the TV, from TVmaze's show (with its embeds) and episode list.
function buildShow(entry, show, episodes, nowMs) {
  const s = isObj(show) ? show : {};
  const status = STATUSES.indexOf(s.status) >= 0 ? s.status : (typeof s.status === 'string' ? cleanText(s.status, 24) : '');
  const channel = channelOf(s);
  const emb = isObj(s._embedded) ? s._embedded : {};
  const eps = (Array.isArray(episodes) ? episodes : []).map(episodeOf).filter(Boolean)
    .sort((a, b) => Date.parse(a.airstamp) - Date.parse(b.airstamp));
  let next = episodeOf(emb.nextepisode);
  if (!next) next = eps.find((e) => Date.parse(e.airstamp) > nowMs) || null;
  const prev = episodeOf(emb.previousepisode);
  const upcoming = eps.filter((e) => {
    const t = Date.parse(e.airstamp);
    return t >= nowMs - BACK_MS && t <= nowMs + AHEAD_MS;
  }).slice(0, MAX_UPCOMING);
  let lastSeason = 0;
  eps.forEach((e) => { if (e.season > lastSeason) lastSeason = e.season; });
  if (prev && prev.season > lastSeason) lastSeason = prev.season;
  let returning = null;
  if (status !== 'Ended') {
    if (next && (next.number === 1 || Date.parse(next.airstamp) > nowMs + AHEAD_MS)) {
      returning = { season: next.season, label: 'Season ' + next.season, date: next.airdate || next.airstamp.slice(0, 10), airstamp: next.airstamp };
      if (next.number !== 1) returning.episode = next.number;
    } else if (!next) {
      returning = { season: lastSeason ? lastSeason + 1 : null, label: lastSeason ? 'Season ' + (lastSeason + 1) : 'New season', date: null, airstamp: null };
    }
  }
  const out = {
    id: slug(entry.name),
    name: entry.name,
    service: entry.service || channel,
    watch: entry.serviceOverride || entry.service || channel,
    channel: channel,
    alsoOn: (entry.alsoOn || []).slice(),
    via: entry.via || null,
    status: status,
    running: status !== 'Ended',
    tvmazeId: Number.isInteger(s.id) ? s.id : entry.tvmazeId || null,
    checkedAt: iso(nowMs),
    nextEpisode: next ? epOut(next) : null,
    upcoming: upcoming.map(epOut),
    returning: returning
  };
  return applyWatched(out, entry, compactEpisodes(episodes), nowMs);
}

// A show from the list that has no TVmaze copy yet.
function placeholder(entry, error, nowMs) {
  return applyWatched({
    id: slug(entry.name), name: entry.name, service: entry.service || '', watch: entry.serviceOverride || entry.service || '',
    channel: '', alsoOn: (entry.alsoOn || []).slice(), via: entry.via || null, status: '', running: null, tvmazeId: entry.tvmazeId || null, checkedAt: null,
    nextEpisode: null, upcoming: [], returning: null, error: error || 'not looked up yet'
  }, entry, [], nowMs);
}

/* ---------- the resource ---------- */

function emptyData() {
  return { v: 1, updatedAt: null, shows: [] };
}

const T = (v) => (typeof v === 'string' ? timeOf(v) : null);

function cleanEp(e) {
  if (!isObj(e) || !T(e.airstamp)) return null;
  const out = {
    season: Number.isInteger(e.season) ? e.season : null,
    number: Number.isInteger(e.number) ? e.number : null,
    name: cleanText(e.name, MAX_EP_NAME),
    airstamp: T(e.airstamp)
  };
  if (Number.isInteger(e.runtime) && e.runtime >= 1 && e.runtime <= 600) out.runtime = e.runtime;
  if (e.watched === true) out.watched = true;
  return out;
}

// shows[].progress as the TV gets it; anything missing or damaged becomes "no progress".
function cleanProgress(p) {
  const out = { upTo: null, unwatched: [], aired: 0, seen: 0, caughtUp: false, next: null };
  if (!isObj(p)) return out;
  const num = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_EP_NUM;
  const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 99999 ? v : 0);
  if (isObj(p.upTo) && num(p.upTo.season) && num(p.upTo.number)) out.upTo = { season: p.upTo.season, number: p.upTo.number, at: T(p.upTo.at) || iso(0) };
  (Array.isArray(p.unwatched) ? p.unwatched : []).forEach((x) => {
    if (isObj(x) && num(x.season) && num(x.number) && out.unwatched.length < MAX_UNWATCHED) out.unwatched.push({ season: x.season, number: x.number });
  });
  out.aired = count(p.aired);
  out.seen = Math.min(count(p.seen), out.aired);
  out.caughtUp = p.caughtUp === true && out.aired > 0 && out.seen === out.aired;
  if (isObj(p.next) && num(p.next.season) && num(p.next.number)) out.next = { season: p.next.season, number: p.next.number };
  return out;
}

function cleanShow(s) {
  if (!isObj(s) || typeof s.name !== 'string' || !cleanText(s.name, MAX_NAME)) return null;
  const out = {
    id: typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/.test(s.id) ? s.id : slug(s.name),
    name: cleanText(s.name, MAX_NAME),
    service: cleanText(s.service, MAX_SERVICE),
    watch: cleanText(s.watch, MAX_SERVICE),
    channel: cleanText(s.channel, MAX_SERVICE),
    alsoOn: (Array.isArray(s.alsoOn) ? s.alsoOn : []).map((x) => cleanText(x, MAX_SERVICE)).filter(Boolean).slice(0, MAX_ALSO),
    via: cleanText(s.via, MAX_SERVICE) || null,
    status: cleanText(s.status, 24),
    running: typeof s.running === 'boolean' ? s.running : null,
    tvmazeId: Number.isInteger(s.tvmazeId) ? s.tvmazeId : null,
    checkedAt: T(s.checkedAt),
    nextEpisode: cleanEp(s.nextEpisode),
    upcoming: (Array.isArray(s.upcoming) ? s.upcoming : []).map(cleanEp).filter(Boolean).slice(0, MAX_UPCOMING),
    returning: null
  };
  if (isObj(s.returning)) {
    const r = s.returning;
    out.returning = {
      season: Number.isInteger(r.season) ? r.season : null,
      label: cleanText(r.label, 40),
      date: typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
      airstamp: T(r.airstamp)
    };
    if (Number.isInteger(r.episode)) out.returning.episode = r.episode;
  }
  out.watched = [];
  if (Array.isArray(s.watched)) {
    s.watched.forEach((w) => {
      if (isObj(w) && Number.isInteger(w.season) && Number.isInteger(w.number) && out.watched.length < SEND_WATCHED) {
        out.watched.push({ season: w.season, number: w.number, at: T(w.at) || iso(0) });
      }
    });
  }
  out.progress = cleanProgress(s.progress);
  if (s.stale === true) out.stale = true;
  if (typeof s.error === 'string' && s.error) out.error = cleanText(s.error, 140);
  return out;
}

function cleanData(d) {
  if (!isObj(d)) return emptyData();
  const out = { v: 1, updatedAt: T(d.updatedAt), shows: (Array.isArray(d.shows) ? d.shows : []).map(cleanShow).filter(Boolean).slice(0, MAX_SHOWS) };
  if (T(d.checkedAt)) out.checkedAt = T(d.checkedAt);
  if (typeof d.error === 'string' && d.error) out.error = cleanText(d.error, 300);
  if (d.sample === true) out.sample = true;
  return out;
}

// The shows resource from a state file. Anything damaged means "nothing yet".
function cleanResource(r) {
  const rev = isObj(r) && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  return { rev: rev, data: cleanData(isObj(r) ? r.data : null) };
}

// Same contents, leaving out when it was checked.
function sameData(a, b) {
  const strip = (d) => {
    const c = JSON.parse(JSON.stringify(d || {}));
    delete c.updatedAt;
    delete c.checkedAt;
    (c.shows || []).forEach((s) => { delete s.checkedAt; });
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
}

/* ---------- the sample (dev/preview.js and the screenshots) ---------- */

// How far the sample moves to make its "today" today: whole days, in ms.
function sampleShift(raw, nowMs) {
  const anchor = Date.parse(raw.sampleToday || '');
  return isFinite(anchor) ? Math.floor((nowMs - anchor) / DAY_MS) * DAY_MS : 0;
}

// The sample's full episode lists (a show's optional "episodes" in the
// fixture), moved the same way: { show id: [{ season, number, name, airstamp }] }.
function sampleEpisodes(file, nowMs) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shift = sampleShift(raw, nowMs);
  const out = {};
  (raw.shows || []).forEach((s) => {
    if (!Array.isArray(s.episodes)) return;
    const id = typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/.test(s.id) ? s.id : slug(s.name);
    out[id] = compactEpisodes(s.episodes.map((e) => (isObj(e) && typeof e.airstamp === 'string' && isFinite(Date.parse(e.airstamp))
      ? Object.assign({}, e, { airstamp: iso(Date.parse(e.airstamp) + shift) }) : e)));
  });
  return out;
}

// The made-up sample, moved by whole days so that its "today" is today.
// (The full episode lists are not part of it: see sampleEpisodes.)
function sampleData(file, nowMs) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shift = sampleShift(raw, nowMs);
  const move = (v) => (typeof v === 'string' && isFinite(Date.parse(v)) ? iso(Date.parse(v) + shift) : v);
  const moveDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? iso(Date.parse(v + 'T12:00:00Z') + shift).slice(0, 10) : v);
  (raw.shows || []).forEach((s) => {
    if (s.nextEpisode) s.nextEpisode.airstamp = move(s.nextEpisode.airstamp);
    (s.upcoming || []).forEach((e) => { e.airstamp = move(e.airstamp); });
    if (s.returning) { s.returning.airstamp = move(s.returning.airstamp); s.returning.date = moveDate(s.returning.date); }
    s.checkedAt = iso(nowMs);
  });
  raw.updatedAt = iso(nowMs);
  raw.sample = true;
  return cleanData(raw);
}

/* ---------- talking to TVmaze ---------- */

// An error with a short code ("not-found", "http-503", "timeout"...). The log
// gets only the code: never a show name, an address or a path.
function coded(msg, code) {
  const e = new Error(msg);
  e.hubCode = code;
  return e;
}

function codeOf(e) {
  if (e && typeof e.hubCode === 'string') return e.hubCode;
  if (e && typeof e.code === 'string' && /^[A-Z0-9_]{2,30}$/.test(e.code)) return e.code;
  return 'error';
}

function netError(e) {
  const code = String((e && e.code) || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'TVmaze could not be reached (the address was not found)';
  if (code === 'ECONNREFUSED') return 'TVmaze could not be reached (connection refused)';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'TVmaze could not be read (the connection broke)';
  return 'TVmaze could not be reached' + (/^[A-Z0-9_]{2,40}$/.test(code) ? ' (' + code + ')' : '');
}

// GET JSON. Resolves { status, json } or { error }, never rejects.
function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) { try { req.destroy(); } catch (e) { /* gone */ } }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ error: 'TVmaze timed out' }), timeoutMs || FETCH_TIMEOUT);
    let u;
    try { u = new URL(url); } catch (e) { return finish({ error: 'a bad TVmaze address' }); }
    const lib = u.protocol === 'http:' ? http : https;
    try {
      req = lib.request(u, { method: 'GET', agent: false, headers: { 'User-Agent': 'HomeHub', Accept: 'application/json' } }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > BODY_LIMIT) return finish({ error: 'TVmaze sent more than 4 MB' });
          chunks.push(c);
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
          finish({ status: res.statusCode, json: json, retryAfter: Number(res.headers['retry-after']) || 0 });
        });
        res.on('error', () => finish({ error: 'TVmaze could not be read (the connection broke)' }));
        res.on('aborted', () => finish({ error: 'TVmaze could not be read (the connection broke)' }));
      });
    } catch (e) {
      return finish({ error: 'TVmaze could not be reached' });
    }
    req.on('error', (e) => finish({ error: netError(e) }));
    req.end();
  });
}

// At most `calls` starts in any `windowMs`, one call at a time, in order.
// o: { calls, windowMs, now(), sleep(ms) } (the last two for tests)
function createLimiter(o) {
  const calls = o && o.calls ? o.calls : RATE_CALLS;
  const windowMs = o && o.windowMs ? o.windowMs : RATE_WINDOW_MS;
  const now = o && o.now ? o.now : () => Date.now();
  const sleep = o && o.sleep ? o.sleep : (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  const starts = [];
  let chain = Promise.resolve();
  let waited = 0;
  function run(fn) {
    const p = chain.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length && t - starts[0] >= windowMs) starts.shift();
        if (starts.length < calls) break;
        const ms = starts[0] + windowMs - t;
        waited += ms;
        await sleep(ms);
      }
      starts.push(now());
      return fn();
    });
    chain = p.catch(() => {});
    return p;
  }
  return { run: run, waitedMs: () => waited, recent: () => starts.length };
}

/* ---------- the tracker ---------- */

// o: { dataDir, seedFile, listFile, api, refreshMs, timeoutMs, rate: { calls, windowMs, now, sleep },
//      sampleFile, now(), log(s), current() -> the stored data, publish(data, changed) }
function createTracker(o) {
  const log = o.log || (() => {});
  const now = () => (o.now ? o.now().getTime() : Date.now());
  const api = String(o.api || DEFAULT_API).replace(/\/+$/, '');
  const listFile = o.listFile || path.join(o.dataDir || path.join(__dirname, 'data'), LIST_NAME);
  const refreshMs = o.refreshMs || REFRESH_MS;
  const limiter = createLimiter(o.rate);
  const sleep = o.rate && o.rate.sleep ? o.rate.sleep : (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  const episodesFile = o.episodesFile || path.join(path.dirname(listFile), EPISODES_NAME);
  let list = readList(listFile, o.seedFile, log).list;
  let episodeLists = {};          // show id -> [{ season, number, name, airstamp, runtime? }]
  let episodesText = '';          // what the file holds now
  let running = null;
  let timer = null;
  let closed = false;
  let lastRefresh = null;
  let calls = 0;

  // The kept episode lists: read once at start (a sample brings its own).
  function readEpisodes() {
    if (o.sampleFile) {
      try { episodeLists = sampleEpisodes(o.sampleFile, now()); } catch (e) { episodeLists = {}; }
      return;
    }
    try {
      const text = fs.readFileSync(episodesFile, 'utf8');
      const raw = JSON.parse(text);
      const src = isObj(raw) && isObj(raw.shows) ? raw.shows : {};
      Object.keys(src).forEach((id) => {
        if (/^[a-z0-9-]{1,40}$/.test(id) && list.some((x) => slug(x.name) === id)) episodeLists[id] = compactEpisodes(src[id]);
      });
      episodesText = text;
    } catch (e) {
      episodeLists = {};
    }
  }

  // Writes the lists of the shows on the list, only when they changed.
  function saveEpisodes() {
    if (o.sampleFile) return;
    const keep = {};
    list.forEach((x) => { const id = slug(x.name); if (episodeLists[id]) keep[id] = episodeLists[id]; });
    episodeLists = keep;
    const text = JSON.stringify({ v: 1, shows: keep }) + '\n';
    if (text === episodesText) return;
    try {
      fs.mkdirSync(path.dirname(episodesFile), { recursive: true });
      const tmp = episodesFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, episodesFile);
      episodesText = text;
    } catch (err) {
      log('shows: could not save the episode lists (' + codeOf(err) + ')');
    }
  }
  readEpisodes();

  async function get(p) {
    for (let tries = 1; ; tries++) {
      if (closed) throw new Error('stopped');
      const r = await limiter.run(() => { calls++; return getJson(api + p, o.timeoutMs); });
      if (r.error) throw coded(r.error, /timed out/.test(r.error) ? 'timeout' : 'unreachable');
      if (r.status === 429 && tries < MAX_429_TRIES) {
        await sleep(Math.max(RETRY_429_MS, Math.min(r.retryAfter * 1000, 20000)));
        continue;
      }
      if (r.status === 404) {
        const e = coded('not found on TVmaze', 'not-found');
        e.notFound = true;
        throw e;
      }
      if (r.status === 429) throw coded('TVmaze is busy (too many calls); trying again later', 'rate-limited');
      if (r.status !== 200) throw coded('TVmaze answered HTTP ' + r.status, 'http-' + r.status);
      if (r.json === null) throw coded('TVmaze sent something that is not JSON', 'not-json');
      return r.json;
    }
  }

  // The data for the TV from what is known now: each show on the list, from
  // fresh (a map id -> show) or else its last good copy.
  function assemble(fresh, problems, t) {
    const cur = cleanData(o.current());
    const old = {};
    cur.shows.forEach((s) => { old[s.id] = s; });
    const shows = list.map((e) => {
      const id = slug(e.name);
      if (fresh && fresh[id]) return applyWatched(fresh[id], e, episodeLists[id], t);
      const prev = old[id];
      const why = problems && problems[id];
      if (!prev || prev.checkedAt === null) return placeholder(e, why || (prev && prev.error) || 'not looked up yet', t);
      const copy = JSON.parse(JSON.stringify(prev));
      copy.name = e.name;
      copy.service = e.service || copy.channel;
      copy.watch = e.serviceOverride || e.service || copy.channel;
      copy.alsoOn = (e.alsoOn || []).slice();
      copy.via = e.via || null;
      copy.upcoming = copy.upcoming.filter((x) => Date.parse(x.airstamp) >= t - BACK_MS);
      if (why) { copy.stale = true; copy.error = why; }
      return applyWatched(copy, e, episodeLists[id], t);
    });
    const data = { v: 1, updatedAt: cur.updatedAt, shows: shows };
    if (fresh && Object.keys(fresh).length) data.updatedAt = iso(t);
    if (fresh) data.checkedAt = iso(t);
    else if (cur.checkedAt) data.checkedAt = cur.checkedAt;
    const names = problems ? Object.keys(problems) : [];
    if (names.length) data.error = names.length === list.length && names.length > 1 ? 'No show could be read: ' + problems[names[0]] : names.map((k) => problems[k]).join('; ').slice(0, 300);
    return cleanData(data);
  }

  function publishNow(data) {
    const changed = !sameData(data, o.current());
    o.publish(data, changed);
    return changed;
  }

  async function readAll() {
    const t = now();
    const fresh = {};
    const newLists = {};
    const problems = {};
    const codes = {};   // id -> an error code, the only part that is logged
    let listChanged = false;
    for (const e of list.slice()) {
      if (closed) return null;
      const id = slug(e.name);
      try {
        let tvId = e.tvmazeId;
        if (!tvId) {
          const found = await get('/singlesearch/shows?q=' + encodeURIComponent(e.name));
          if (!isObj(found) || !Number.isInteger(found.id)) throw coded('TVmaze sent no show id', 'no-id');
          tvId = found.id;
          const at = list.indexOf(e);
          if (at >= 0) { list[at] = Object.assign({}, e, { tvmazeId: tvId }); listChanged = true; }
        }
        const show = await get('/shows/' + tvId + '?embed[]=nextepisode&embed[]=previousepisode');
        const eps = await get('/shows/' + tvId + '/episodes');
        fresh[id] = buildShow(Object.assign({}, e, { tvmazeId: tvId }), show, eps, now());
        newLists[id] = compactEpisodes(eps);
      } catch (err) {
        if (closed) return null;
        problems[id] = e.name + ': ' + (err.notFound && !e.tvmazeId ? 'not found on TVmaze (check the name, or add --id)' : err.message);
        codes[id] = codeOf(err);
      }
    }
    if (listChanged) {
      try { writeList(listFile, list); } catch (err) { log('shows: could not save the show list (' + codeOf(err) + ')'); }
    }
    Object.keys(newLists).forEach((k) => { episodeLists[k] = newLists[k]; });
    saveEpisodes();
    const data = assemble(fresh, problems, t);
    lastRefresh = t;
    const failed = Object.keys(codes).map((k) => codes[k]).sort();
    log('shows refresh: ' + (list.length - failed.length) + ' of ' + list.length + ' shows read' +
      (failed.length ? ', ' + failed.length + ' failed (' + failed.join(', ') + ')' : ''));
    const changed = publishNow(data);
    return { changed: changed, data: data, problems: Object.keys(problems).map((k) => problems[k]) };
  }

  // Looks every show up now. A second call while one runs joins it.
  function refresh() {
    if (closed) return Promise.resolve({ changed: false, data: o.current(), problems: [] });
    if (o.sampleFile) {
      readEpisodes();
      const changed = publishNow(sampleWatched(sampleData(o.sampleFile, now())));
      return Promise.resolve({ changed: changed, data: o.current(), problems: [] });
    }
    if (running) return running;
    running = readAll().catch((e) => {
      log('shows refresh: failed (' + codeOf(e) + ')');
      return null;
    }).then((r) => {
      running = null;
      return r;
    });
    return running;
  }

  function schedule(ms) {
    if (closed) return;
    timer = setTimeout(() => {
      timer = null;
      refresh().then(() => schedule(refreshMs));
    }, ms);
    if (timer.unref) timer.unref();
  }

  // A change to the list: saved, the TV told at once (from what is known),
  // and the new list looked up in the background.
  function changeList(next) {
    try { writeList(listFile, next); } catch (err) {
      const e = new Error('the show list could not be saved (' + codeOf(err) + ')');
      e.status = 500;
      throw e;
    }
    list = next;
    saveEpisodes();   // a show that left the list takes its episode list with it
    if (!o.sampleFile) publishNow(assemble(null, null, now()));
    if (o.autoRefresh !== false) refresh();
  }

  function add(raw) {
    const e = normalizeEntry(raw);
    if (list.length >= MAX_SHOWS) throw bad('the show list is full (' + MAX_SHOWS + ' shows)');
    const at = list.findIndex((x) => sameName(x.name, e.name) || slug(x.name) === slug(e.name));
    const next = list.slice();
    let replaced = false;
    if (at >= 0) {
      // The same show again: a new badge or id replaces the old one.
      const merged = Object.assign({}, list[at], e);
      if (e.tvmazeId === undefined && list[at].tvmazeId) merged.tvmazeId = list[at].tvmazeId;
      next[at] = merged;
      replaced = true;
    } else {
      next.push(e);
    }
    changeList(next);
    return { entry: next[at >= 0 ? at : next.length - 1], replaced: replaced };
  }

  function remove(text) {
    const e = findEntry(list, text);
    if (!e) {
      const err = bad('"' + cleanText(String(text || ''), 80) + '" is not on the show list. Run ./hub shows list to see it.');
      err.notOnList = true;
      throw err;
    }
    changeList(list.filter((x) => x !== e));
    return e;
  }

  function set(raw) {
    const next = normalizeList(raw).map((e) => {
      if (hasProgress(e)) return e;
      const old = list.find((x) => slug(x.name) === slug(e.name));
      if (!old || !hasProgress(old)) return e;
      const c = Object.assign({}, e);
      if (old.watched) c.watched = old.watched.slice();
      if (old.upTo) c.upTo = Object.assign({}, old.upTo);
      if (old.unwatched) c.unwatched = old.unwatched.slice();
      return c;
    });
    changeList(next);
    return next;
  }

  // The earliest episode out already that is not marked: from the data the
  // TV gets (a week back, so it is what the Schedule shows as aired).
  function nextUnwatched(e) {
    const cur = cleanData(o.current());
    const s = cur.shows.find((x) => x.id === slug(e.name));
    const t = now();
    const eps = ((s && s.upcoming) || []).filter((x) => Date.parse(x.airstamp) <= t && x.season !== null && x.number !== null && !isWatched(e, x.season, x.number));
    return eps.length ? eps[0] : null;
  }

  // The made-up sample (the preview and the tests): marks from the list
  // go onto the sample's shows that are also on the list, and every show
  // gets its progress counts from the sample's episode list.
  function sampleWatched(data) {
    const t = now();
    data.shows.forEach((sh) => {
      const e = list.find((x) => slug(x.name) === sh.id);
      if (e && hasProgress(e)) applyWatched(sh, e, episodeLists[sh.id], t);   // a sample's own marks stay unless the list has some
      else sh.progress = progressOf(e || {}, episodeLists[sh.id], t);
    });
    return data;
  }

  // The sample after a mark came off: the flags of the episodes that are no
  // longer watched go from the sample's copy too (it keeps its own marks otherwise).
  function sampleAfter(before, entry) {
    const data = cleanData(o.current());
    const sh = data.shows.find((x) => x.id === slug(entry.name));
    if (sh) {
      const lost = (s, n) => isWatched(before, s, n) && !isWatched(entry, s, n);
      (sh.upcoming || []).concat(sh.nextEpisode ? [sh.nextEpisode] : []).forEach((ep) => { if (lost(ep.season, ep.number)) delete ep.watched; });
      sh.watched = (sh.watched || []).filter((x) => !lost(x.season, x.number));
    }
    return sampleWatched(data);
  }

  // Saves changed progress (fields: watched, upTo, unwatched; an empty list
  // or null takes it off the entry) and tells the TV at once. No TVmaze call.
  function saveEntry(e, fields) {
    const at = list.indexOf(e);
    const entry = Object.assign({}, e);
    Object.keys(fields).forEach((k) => {
      const v = fields[k];
      if (v === null || v === undefined || (Array.isArray(v) && !v.length)) delete entry[k]; else entry[k] = v;
    });
    const next = list.slice();
    next[at] = entry;
    try { writeList(listFile, next); } catch (err) {
      const x = new Error('the show list could not be saved (' + codeOf(err) + ')');
      x.status = 500;
      throw x;
    }
    list = next;
    publishNow(o.sampleFile ? sampleAfter(e, entry) : assemble(null, null, now()));
    return entry;
  }

  function entryOrThrow(text) {
    const e = findEntry(list, text);
    if (!e) {
      const err = bad('"' + cleanText(String(text || ''), 80) + '" is not on the show list. Run ./hub shows list to see it.');
      err.notOnList = true;
      throw err;
    }
    return e;
  }

  // Marks one episode watched: ep { season, number } or, left out, the
  // earliest episode already out that is not marked. Returns
  // { entry, season, number, changed }.
  function markWatched(text, ep) {
    const e = entryOrThrow(text);
    let season;
    let number;
    if (ep) {
      season = ep.season;
      number = ep.number;
      if (!Number.isInteger(season) || !Number.isInteger(number) || season < 0 || number < 0 || season > MAX_EP_NUM || number > MAX_EP_NUM) {
        throw bad('the episode must be a season and a number, like S3E4');
      }
    } else {
      const x = nextUnwatched(e);
      if (!x) throw bad('there is no episode out in the last week that is not marked watched yet; name one, like S3E4');
      season = x.season;
      number = x.number;
    }
    if (isWatched(e, season, number)) return { entry: e, season: season, number: number, changed: false };
    // Inside the up-to point it is an exception being lifted; outside it joins the list.
    const fields = covers(e.upTo, season, number)
      ? { unwatched: (e.unwatched || []).filter((w) => !(w.s === season && w.e === number)) }
      : { watched: (e.watched || []).concat([{ s: season, e: number, at: iso(now()) }]).slice(-MAX_WATCHED) };
    return { entry: saveEntry(e, fields), season: season, number: number, changed: true };
  }

  // Takes a mark off (a mistake). Returns { entry, season, number, changed }.
  function unwatch(text, ep) {
    const e = entryOrThrow(text);
    if (!ep || !Number.isInteger(ep.season) || !Number.isInteger(ep.number)) throw bad('say which episode, like S3E4');
    if (!isWatched(e, ep.season, ep.number)) return { entry: e, season: ep.season, number: ep.number, changed: false };
    const fields = {};
    if ((e.watched || []).some((w) => w.s === ep.season && w.e === ep.number)) {
      fields.watched = e.watched.filter((w) => !(w.s === ep.season && w.e === ep.number));
    }
    // Inside the up-to point it becomes an exception.
    if (covers(e.upTo, ep.season, ep.number)) fields.unwatched = (e.unwatched || []).concat([{ s: ep.season, e: ep.number }]).slice(-MAX_UNWATCHED);
    return { entry: saveEntry(e, fields), season: ep.season, number: ep.number, changed: true };
  }

  // The same checks for an episode named by the screen or by hand.
  function checkEpisode(ep) {
    if (!ep || !Number.isInteger(ep.season) || !Number.isInteger(ep.number) || ep.season < 0 || ep.number < 0 || ep.season > MAX_EP_NUM || ep.number > MAX_EP_NUM) {
      throw bad('the episode must be a season and a number, like S3E4');
    }
  }

  // Sets "watched up to here" for a show. Everything up to and including the
  // episode counts as watched (the marks and exceptions inside it go); a
  // point EARLIER than the old one replaces it, so the episodes after the new
  // point become unwatched again, except those marked one by one.
  function setUpTo(e, season, number) {
    const cur = e.upTo;
    const same = !!cur && cur.s === season && cur.e === number;
    const watched = (e.watched || []).filter((w) => !covers({ s: season, e: number }, w.s, w.e));
    if (same && watched.length === (e.watched || []).length && !(e.unwatched || []).length) {
      return { entry: e, season: season, number: number, changed: false };
    }
    const entry = saveEntry(e, { upTo: { s: season, e: number, at: iso(now()) }, watched: watched, unwatched: [] });
    return { entry: entry, season: season, number: number, changed: true };
  }

  // "I'm watched up to S3E4." Returns { entry, season, number, changed }.
  function upTo(text, ep) {
    const e = entryOrThrow(text);
    checkEpisode(ep);
    return setUpTo(e, ep.season, ep.number);
  }

  // The latest numbered episode already out: from the full list, else from
  // the episodes in the TV's snapshot.
  function latestAired(e) {
    const id = slug(e.name);
    const t = now();
    let eps = episodeLists[id] || [];
    if (!eps.length) {
      const s = cleanData(o.current()).shows.find((x) => x.id === id);
      eps = s ? (s.upcoming || []).concat(s.nextEpisode ? [s.nextEpisode] : []).filter((x) => x.season !== null && x.number !== null) : [];
    }
    let last = null;
    eps.forEach((x) => { if (Date.parse(x.airstamp) <= t && (!last || lastOf(x, last) > 0)) last = x; });
    return last;
  }

  // "Seen it all": up to the latest episode already out. Returns { entry, season, number, changed }.
  function caughtUp(text) {
    const e = entryOrThrow(text);
    const last = latestAired(e);
    if (!last) throw bad('no episode of that show has aired yet, so there is nothing to catch up on');
    return setUpTo(e, last.season, last.number);
  }

  // The page of a show for GET /shows/episodes: every season and episode
  // known, with the watched flags and the progress; null when the id is not
  // on the list. partial: true when only the episodes in the TV's snapshot
  // are known (the full list has not been read from TVmaze yet).
  function episodesView(text) {
    const e = findEntry(list, text);
    if (!e) return null;
    const id = slug(e.name);
    const t = now();
    const s = cleanData(o.current()).shows.find((x) => x.id === id) || null;
    let eps = episodeLists[id] || [];
    let partial = false;
    if (!eps.length) {
      partial = true;
      const seen = {};
      eps = [];
      (s ? (s.upcoming || []).concat(s.nextEpisode ? [s.nextEpisode] : []) : []).forEach((x) => {
        const k = x.season + 'x' + x.number;
        if (x.season === null || x.number === null || seen[k]) return;
        seen[k] = true;
        eps.push(epOut(x));
      });
      eps.sort(lastOf);
    }
    const seasons = [];
    eps.forEach((x) => {
      let sea = seasons.length ? seasons[seasons.length - 1] : null;
      if (!sea || sea.season !== x.season) { sea = { season: x.season, episodes: [] }; seasons.push(sea); }
      const row = { number: x.number, name: x.name, airstamp: x.airstamp };
      if (x.runtime) row.runtime = x.runtime;
      if (isWatched(e, x.season, x.number)) row.watched = true;
      sea.episodes.push(row);
    });
    const out = { id: id, checkedAt: s ? s.checkedAt : null, seasons: seasons, progress: progressOf(e, partial ? [] : eps, t) };
    if (partial) out.partial = true;
    return out;
  }

  return {
    start: () => { if (o.sampleFile) refresh(); else if (o.enabled !== false) schedule(o.firstDelayMs || 0); },
    refresh: refresh,
    list: () => list.map((e) => Object.assign({}, e)),
    add: add,
    remove: remove,
    set: set,
    markWatched: markWatched,
    unwatch: unwatch,
    upTo: upTo,
    caughtUp: caughtUp,
    episodes: episodesView,
    lastRefresh: () => (lastRefresh === null ? null : iso(lastRefresh)),
    running: () => !!running,
    debug: () => ({ shows: list.length, timer: !!timer, refreshing: !!running, calls: calls, waitedMs: limiter.waitedMs(), sample: !!o.sampleFile }),
    close: () => {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
    }
  };
}

/* ---------- describing it (./hub shows ... and the mailbox) ---------- */

function epCode(e) {
  if (!e) return '';
  const s = e.season === null || e.season === undefined ? '' : 'S' + e.season;
  const n = e.number === null || e.number === undefined ? '' : 'E' + e.number;
  return (s + (s && n ? ' ' : '') + n) || 'special';
}

// "Wed Nov 18, 7:00 PM" in the hub's time zone.
function whenText(ms, tz) {
  const o = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try { return new Date(ms).toLocaleString('en-US', Object.assign({ timeZone: tz || 'America/Chicago' }, o)); } catch (e) {
    return new Date(ms).toLocaleString('en-US', o);
  }
}

// The lines for ./hub shows list. r: GET /api/shows's answer.
function listLines(r) {
  const list = (r && r.list) || [];
  const d = cleanData(r && r.data);
  const tz = r && r.tz;
  if (!list.length) return ['The show list is empty. Add one: ./hub shows add "Stick" --service "Apple TV"'];
  const byId = {};
  d.shows.forEach((s) => { byId[s.id] = s; });
  const out = [plural(list.length, 'show') + ' on the list' + (d.sample ? ' (the TV shows the made-up sample)' : '') +
    (d.updatedAt ? ', last read from TVmaze ' + whenText(Date.parse(d.updatedAt), tz) : ', not read from TVmaze yet') + '.'];
  list.forEach((e) => {
    const s = byId[slug(e.name)];
    const badge = e.service || (s && s.channel) || 'no service';
    let line = '  ' + e.name + ' (' + badge + (e.serviceOverride ? ', watch on ' + e.serviceOverride : '') +
      (e.alsoOn && e.alsoOn.length ? ', also on ' + e.alsoOn.join(', ') : '') + (e.via ? ', via ' + e.via : '') + ')';
    if (!s || s.checkedAt === null) line += ': ' + ((s && s.error) || 'not looked up yet');
    else {
      line += ': ' + (s.running === false ? 'ended' : 'still running' + (s.status && s.status !== 'Running' ? ' (' + s.status.toLowerCase() + ')' : ''));
      if (s.returning) line += '; ' + s.returning.label + (s.returning.date ? ' returns ' + s.returning.date : ', no date yet');
      else if (s.nextEpisode) line += '; next ' + epCode(s.nextEpisode) + ' ' + whenText(Date.parse(s.nextEpisode.airstamp), tz);
      if (s.stale) line += ' [last good copy: ' + s.error + ']';
    }
    if (e.tvmazeId) line += ' [TVmaze ' + e.tvmazeId + ']';
    if (e.watched && e.watched.length) line += ' [watched ' + watchedWords(e.watched) + ']';
    if (e.upTo) line += ' [up to S' + e.upTo.s + 'E' + e.upTo.e + (e.unwatched && e.unwatched.length ? ', not seen ' + e.unwatched.length : '') + ']';
    out.push(line);
  });
  return out;
}

// "S3E4, S3E5 and 7 more": the newest five marks.
function watchedWords(w) {
  const last = w.slice(-5).map((x) => 'S' + x.s + 'E' + x.e);
  return last.join(', ') + (w.length > 5 ? ' and ' + (w.length - 5) + ' earlier' : '');
}

function summaryData(r) {
  const d = cleanData(r && r.data);
  const byId = {};
  d.shows.forEach((s) => { byId[s.id] = s; });
  return {
    updatedAt: d.updatedAt,
    sample: !!d.sample,
    shows: ((r && r.list) || []).map((e) => {
      const s = byId[slug(e.name)] || null;
      const o = { name: e.name, service: e.service || (s && s.channel) || '', running: s ? s.running : null };
      if (e.serviceOverride) o.serviceOverride = e.serviceOverride;
      if (e.alsoOn) o.alsoOn = e.alsoOn.slice();
      if (e.via) o.via = e.via;
      if (e.tvmazeId) o.tvmazeId = e.tvmazeId;
      if (e.watched && e.watched.length) o.watched = e.watched.map((x) => ({ season: x.s, number: x.e, at: x.at }));
      if (e.upTo) o.upTo = { season: e.upTo.s, number: e.upTo.e, at: e.upTo.at };
      if (s && s.status) o.status = s.status;
      if (s && s.nextEpisode) o.next = s.nextEpisode.airstamp;
      if (s && s.error) o.problem = s.error;
      return o;
    })
  };
}

function addText(r) {
  const e = r.entry || {};
  return (r.replaced ? 'Updated ' : 'Added ') + e.name + (e.service ? ' (' + e.service + ')' : '') +
    '. Looking it up on TVmaze now; ./hub shows list in a few seconds shows what it found.';
}

function removeText(e) {
  return 'Removed ' + e.name + ' from the show list. The TV drops it now.';
}

function watchedText(r) {
  const code = 'S' + r.season + 'E' + r.number;
  return r.changed ? 'Marked ' + code + ' of ' + r.entry.name + ' as watched. The TV counts and dims it now.' : code + ' of ' + r.entry.name + ' was already marked watched.';
}

function unwatchText(r) {
  const code = 'S' + r.season + 'E' + r.number;
  return r.changed ? 'Took the watched mark off ' + code + ' of ' + r.entry.name + '. The TV counts it again.' : code + ' of ' + r.entry.name + ' was not marked watched.';
}

function upToText(r) {
  const code = 'S' + r.season + 'E' + r.number;
  return r.changed ? 'Marked ' + r.entry.name + ' as watched up to ' + code + '. The TV shows it now.' : r.entry.name + ' was already marked watched up to ' + code + '.';
}

function caughtUpText(r) {
  const code = 'S' + r.season + 'E' + r.number;
  return r.changed ? 'Marked ' + r.entry.name + ' as caught up, watched through ' + code + '. The TV shows it now.' : r.entry.name + ' was already caught up, through ' + code + '.';
}

function setText(list) {
  return 'The show list now has ' + plural(list.length, 'show') + '. Looking them up on TVmaze now.';
}

function refreshText(r) {
  if (!r.done) return 'Still asking TVmaze after 25 seconds. Run ./hub shows list in a minute.';
  const n = (r.problems || []).length;
  return 'Read ' + plural(r.count || 0, 'show') + ' from TVmaze' + (r.changed ? ' (changed).' : ' (no change).') +
    (n ? ' ' + plural(n, 'problem') + ': ' + r.problems.join('; ') + '. Those keep their last good copy.' : '');
}

module.exports = {
  DEFAULT_API: DEFAULT_API,
  SEED_FILE: SEED_FILE,
  REFRESH_MS: REFRESH_MS,
  RATE_CALLS: RATE_CALLS,
  RATE_WINDOW_MS: RATE_WINDOW_MS,
  slug: slug,
  serviceName: serviceName,
  channelOf: channelOf,
  normalizeEntry: normalizeEntry,
  normalizeList: normalizeList,
  parseEpisode: parseEpisode,
  cleanWatched: cleanWatched,
  watchedText: watchedText,
  upToText: upToText,
  caughtUpText: caughtUpText,
  isWatched: isWatched,
  progressOf: progressOf,
  compactEpisodes: compactEpisodes,
  sampleEpisodes: sampleEpisodes,
  MAX_UNWATCHED: MAX_UNWATCHED,
  MAX_EPISODES: MAX_EPISODES,
  unwatchText: unwatchText,
  readList: readList,
  writeList: writeList,
  findEntry: findEntry,
  buildShow: buildShow,
  emptyData: emptyData,
  cleanData: cleanData,
  cleanResource: cleanResource,
  sameData: sameData,
  sampleData: sampleData,
  getJson: getJson,
  createLimiter: createLimiter,
  createTracker: createTracker,
  listLines: listLines,
  summaryData: summaryData,
  addText: addText,
  removeText: removeText,
  setText: setText,
  refreshText: refreshText
};
