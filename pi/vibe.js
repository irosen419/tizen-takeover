/*
 * The "vibe" of the song that plays, for the visualizer on the TV's full
 * screen Now Playing page.
 *
 * Spotify's own audio features are closed to apps made after November 2024,
 * so the Pi asks two other places, in order:
 *
 *   1. ReccoBeats (api.reccobeats.com), free and without a key:
 *      GET /v1/audio-features?ids=<Spotify track id>. It answers with tempo,
 *      energy, valence, danceability and acousticness for songs it knows.
 *      Only the track id is sent (and, as with any request, the Pi's address).
 *      SPOTIFY_VIBE=off in pi/.env turns this off.
 *   2. The artist's genres from Spotify (GET /v1/artists/{id}), turned into a
 *      rough vibe with the small table below. Genres may be empty or missing,
 *      and the call may be refused: that is just "no genres".
 *   3. Neither: no vibe, and the TV uses a calm default.
 *
 * A vibe is { id, source: 'features'|'genres', tempo, energy, valence, dance,
 * acoustic, genres }: id is the track it belongs to, tempo is beats per minute
 * (40 to 220, or 0 when unknown), the rest 0 to 1 with two decimals, genres
 * up to three short words. cleanVibe() rebuilds one from known fields only.
 *
 * Answers are kept per track, in memory and in data/vibes.json (500 at most,
 * the oldest go first). A song nobody knows is asked about again after a day;
 * one that only failed (timed out, "slow down"), after a while. One lookup
 * runs at a time and the player's poll never waits for it.
 *
 * Node 14 or newer, no npm packages. Nothing here logs a token or a secret.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const RECCOBEATS = 'https://api.reccobeats.com';
const CACHE_FILE = 'vibes.json';
const MAX_ITEMS = 500;
const TIMEOUT_MS = 6000;
const MAX_REPLY = 256 * 1024;
const DAY = 24 * 3600000;
const UNKNOWN_RETRY_MS = DAY;          // nobody knew the song: ask again after a day
const GENRES_RETRY_MS = 7 * DAY;       // ReccoBeats did not know it, genres did
const FAILED_RETRY_MS = 30 * 60000;    // a lookup that only failed
const MAX_WAIT_MS = 3600000;           // the longest "slow down" honored
const USER_AGENT = 'HomeHub/1.0 (+home screen)';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const r2 = (x) => Math.round(x * 100) / 100;
const unit = (v) => (isNum(v) ? r2(Math.max(0, Math.min(1, v))) : null);

// Spotify ids are 22 letters and digits; anything plain and short is let
// through (the stand-in uses its own), nothing else is ever sent.
function goodId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{1,64}$/.test(id);
}

function cleanTempo(t) {
  return isNum(t) && t >= 40 && t <= 220 ? Math.round(t * 10) / 10 : 0;
}

function cleanGenres(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((g) => {
    if (out.length >= 3 || typeof g !== 'string') return;
    const t = g.replace(/[^\p{L}\p{N} &'\-]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const s = Array.from(t).slice(0, 32).join('').trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

// Rebuilds a vibe from known fields only. Returns null for anything that is
// not a usable vibe.
function cleanVibe(v) {
  if (!isObj(v)) return null;
  const source = v.source === 'features' || v.source === 'genres' ? v.source : '';
  const energy = unit(v.energy);
  const valence = unit(v.valence);
  if (!source || energy === null || valence === null) return null;
  const out = {
    source: source,
    tempo: cleanTempo(v.tempo),
    energy: energy,
    valence: valence,
    dance: unit(v.dance) === null ? 0.5 : unit(v.dance),
    acoustic: unit(v.acoustic) === null ? 0.3 : unit(v.acoustic),
    genres: cleanGenres(v.genres)
  };
  if (goodId(v.id)) out.id = v.id;
  return out;
}

/* ---------- ReccoBeats' answer ---------- */

// The first item whose numbers are sane: from { content: [...] }, a bare
// list, or a bare object. null when there is none.
function readFeatures(json, id) {
  let list = [];
  if (Array.isArray(json)) list = json;
  else if (isObj(json) && Array.isArray(json.content)) list = json.content;
  else if (isObj(json) && Array.isArray(json.data)) list = json.data;
  else if (isObj(json)) list = [json];
  for (let i = 0; i < list.length && i < 20; i++) {
    const f = list[i];
    if (!isObj(f)) continue;
    // When the item names its song, it must be this one.
    const href = typeof f.href === 'string' ? f.href : '';
    const m = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(href);
    if (m && id && m[1] !== id) continue;
    const ok = (k) => isNum(f[k]) && f[k] >= 0 && f[k] <= 1;
    if (!ok('energy') || !ok('valence')) continue;
    return cleanVibe({
      source: 'features', tempo: f.tempo, energy: f.energy, valence: f.valence,
      dance: ok('danceability') ? f.danceability : null, acoustic: ok('acousticness') ? f.acousticness : null,
      genres: []
    });
  }
  return null;
}

/* ---------- genres to a rough vibe ---------- */

// Each row: words to look for in a genre, then energy, valence, dance,
// acoustic and a tempo guess. Rough on purpose: it only picks how the
// visualizer moves.
const GENRE_TABLE = [
  [['death metal', 'black metal', 'grindcore', 'thrash'], 0.95, 0.2, 0.35, 0.02, 170],
  [['metal', 'hardcore', 'punk', 'screamo'], 0.9, 0.3, 0.4, 0.03, 160],
  [['drum and bass', 'dnb', 'jungle', 'breakcore'], 0.9, 0.5, 0.65, 0.02, 172],
  [['techno', 'hardstyle', 'trance', 'edm', 'electro house', 'dubstep'], 0.85, 0.5, 0.75, 0.03, 130],
  [['house', 'disco', 'dance', 'eurodance', 'nu disco'], 0.75, 0.75, 0.85, 0.05, 124],
  [['reggaeton', 'latin', 'salsa', 'cumbia', 'bachata', 'merengue', 'dembow', 'afrobeats', 'dancehall'], 0.75, 0.78, 0.85, 0.15, 98],
  [['funk', 'boogie'], 0.7, 0.8, 0.85, 0.1, 110],
  [['k-pop', 'j-pop', 'pop'], 0.65, 0.7, 0.7, 0.15, 118],
  [['hip hop', 'rap', 'trap', 'drill', 'grime'], 0.7, 0.5, 0.78, 0.1, 140],
  [['rock', 'grunge', 'garage'], 0.75, 0.5, 0.45, 0.08, 128],
  [['indie', 'alternative', 'shoegaze', 'dream pop'], 0.55, 0.5, 0.5, 0.25, 115],
  [['r&b', 'rnb', 'soul', 'neo soul', 'motown'], 0.5, 0.6, 0.65, 0.25, 92],
  [['jazz', 'bossa nova', 'swing', 'bebop'], 0.4, 0.6, 0.55, 0.65, 110],
  [['blues'], 0.45, 0.35, 0.5, 0.55, 90],
  [['reggae', 'ska', 'dub'], 0.55, 0.75, 0.75, 0.2, 80],
  [['country', 'bluegrass', 'americana'], 0.5, 0.6, 0.55, 0.6, 108],
  [['folk', 'singer-songwriter', 'acoustic'], 0.35, 0.55, 0.45, 0.85, 96],
  [['lo-fi', 'lofi', 'chillhop', 'chill'], 0.3, 0.55, 0.6, 0.6, 80],
  [['ambient', 'drone', 'new age', 'sleep', 'meditation'], 0.15, 0.4, 0.2, 0.75, 70],
  [['classical', 'orchestra', 'baroque', 'opera', 'piano', 'soundtrack', 'score'], 0.25, 0.45, 0.25, 0.9, 80],
  [['emo', 'sad', 'doom', 'dark', 'gothic', 'slowcore', 'post-rock'], 0.45, 0.2, 0.35, 0.3, 90],
  [['gospel', 'worship', 'christian'], 0.5, 0.7, 0.45, 0.4, 100]
];

function fromGenres(genres) {
  const list = (Array.isArray(genres) ? genres : []).filter((g) => typeof g === 'string').slice(0, 8);
  const hits = [];
  list.forEach((g, gi) => {
    const t = g.toLowerCase();
    // The first row that matches a genre counts for it; the artist's first
    // genres count a little more.
    for (let i = 0; i < GENRE_TABLE.length; i++) {
      if (GENRE_TABLE[i][0].some((w) => t.indexOf(w) >= 0)) { hits.push({ row: GENRE_TABLE[i], w: 1 / (1 + gi * 0.35) }); break; }
    }
  });
  // "sad", "dark" and the like pull the whole song down, wherever they are.
  const moody = list.some((g) => /\b(sad|dark|doom|emo|gothic|slowcore|melanchol)/i.test(g));
  if (!hits.length) return null;
  let wsum = 0;
  const acc = [0, 0, 0, 0, 0];
  hits.forEach((h) => { wsum += h.w; for (let k = 0; k < 5; k++) acc[k] += h.row[k + 1] * h.w; });
  const avg = acc.map((x) => x / wsum);
  return cleanVibe({
    source: 'genres', energy: avg[0], valence: moody ? Math.min(avg[1], 0.3) : avg[1],
    dance: avg[2], acoustic: avg[3], tempo: avg[4], genres: list
  });
}

/* ---------- a small web request ---------- */

// Resolves to { status, headers, text } or rejects with a short reason.
// A hard deadline on top of the socket timeout, so a slow drip ends too.
function getText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad address')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(deadline); fn(v); } };
    const req = lib.request(u, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY) { req.destroy(); finish(reject, new Error('the reply was too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish(reject, new Error('the reply broke off')));
    });
    const deadline = setTimeout(() => { req.destroy(); finish(reject, new Error('timed out')); }, timeoutMs);
    req.on('timeout', () => { req.destroy(); finish(reject, new Error('timed out')); });
    req.on('error', () => finish(reject, new Error('could not be reached')));
    req.end();
  });
}

/* ---------- the lookups ---------- */

/*
 * o.dataDir       where vibes.json lives (null: memory only)
 * o.base          ReccoBeats' address (the stand-in in tests and the preview)
 * o.off           true: never ask ReccoBeats (SPOTIFY_VIBE=off)
 * o.genres(artistId)   resolves to Spotify's genre list for an artist ([] when there are none, null when Spotify could not answer)
 * o.found(trackId)     a lookup for this track finished (called whatever the result)
 * o.log, o.now, o.timeoutMs
 */
function createVibes(o) {
  const opts = o || {};
  const base = (typeof opts.base === 'string' && opts.base ? opts.base : RECCOBEATS).replace(/\/+$/, '');
  const off = opts.off === true;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const genresOf = typeof opts.genres === 'function' ? opts.genres : () => Promise.resolve([]);
  const found = typeof opts.found === 'function' ? opts.found : () => {};
  const file = opts.dataDir ? path.join(opts.dataDir, CACHE_FILE) : '';

  // id -> { vibe, at, retryAt }; retryAt 0 means keep for good.
  const items = new Map();
  let busy = null;          // the track id being looked up
  let queued = null;        // { id, artist } wanted next
  let waitUntil = 0;        // ReccoBeats asked us to slow down until then
  let lastProblem = '';
  let lastProblemAt = 0;
  let lookups = 0;
  let closed = false;
  let saveTimer = null;

  function load() {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = isObj(j) && Array.isArray(j.items) ? j.items : [];
      list.slice(-MAX_ITEMS).forEach((e) => {
        if (!isObj(e) || !goodId(e.id) || !isNum(e.at)) return;
        const v = e.vibe === null ? null : cleanVibe(e.vibe);
        if (e.vibe !== null && !v) return;
        items.set(e.id, { vibe: v, at: e.at, retryAt: isNum(e.retryAt) ? e.retryAt : 0, g: e.g === true });
      });
    } catch (e) { /* none yet, or damaged: start empty */ }
  }

  function save() {
    if (!file || closed) return;
    if (saveTimer) return;
    // Several answers in a row are written once.
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, 500);
    if (saveTimer.unref) saveTimer.unref();
  }

  function writeNow() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const list = [];
      items.forEach((e, id) => list.push({ id: id, vibe: e.vibe, at: e.at, retryAt: e.retryAt, g: e.g === true }));
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: list }) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      log('Vibe: could not save ' + CACHE_FILE + ' (' + (e && e.code ? e.code : 'write failed') + ')');
    }
  }

  // g: the artist's genres were asked for too (a vibe from ReccoBeats has
  // none of its own; the TV dresses Ian and Ember by them).
  function remember(id, vibe, retryAfter, g) {
    items.delete(id);                  // re-adding puts it last: newest
    items.set(id, { vibe: vibe, at: now(), retryAt: retryAfter ? now() + retryAfter : 0, g: g === true });
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    save();
  }

  function problem(text) {
    lastProblem = text;
    lastProblemAt = now();
  }

  // The vibe kept for a track, or null. Does not start anything.
  function get(id) {
    const e = goodId(id) ? items.get(id) : null;
    if (!e || !e.vibe) return null;
    return Object.assign({}, e.vibe, { id: id });
  }

  function fresh(id) {
    const e = items.get(id);
    // A ReccoBeats vibe whose genres are still to add (kept from before, or
    // Spotify could not answer last time and its wait is over).
    if (e && e.vibe && e.vibe.source === 'features' && !e.g && (!e.retryAt || e.retryAt <= now())) return false;
    return !!e && (!e.retryAt || e.retryAt > now());
  }

  // Asks about a track if nothing fresh is kept for it. Never waits.
  function want(id, artist) {
    if (closed || !goodId(id) || fresh(id)) return false;
    if (busy) {
      if (busy !== id) queued = { id: id, artist: artist };
      return true;
    }
    run(id, artist);
    return true;
  }

  function askRecco(id) {
    if (off) return Promise.resolve({ kind: 'skipped' });
    if (waitUntil > now()) return Promise.resolve({ kind: 'failed', why: 'waiting after a "slow down"' });
    return getText(base + '/v1/audio-features?ids=' + encodeURIComponent(id), timeoutMs).then((r) => {
      if (r.status === 429) {
        const secs = Number(r.headers['retry-after']);
        waitUntil = now() + Math.min(MAX_WAIT_MS, (isFinite(secs) && secs > 0 ? secs : 60) * 1000);
        return { kind: 'failed', why: 'ReccoBeats asked us to slow down for ' + Math.round((waitUntil - now()) / 1000) + ' s' };
      }
      if (r.status === 404) return { kind: 'unknown' };
      if (r.status !== 200) return { kind: 'failed', why: 'ReccoBeats answered HTTP ' + r.status };
      let json;
      try { json = JSON.parse(r.text); } catch (e) { return { kind: 'failed', why: 'ReccoBeats sent something that is not JSON' }; }
      const v = readFeatures(json, id);
      if (v) return { kind: 'found', vibe: v };
      // An answer with nothing usable in it: the song is not known there.
      return { kind: 'unknown' };
    }, (e) => ({ kind: 'failed', why: 'ReccoBeats ' + (e && e.message ? e.message : 'could not be reached') }));
  }

  function askGenres(artist) {
    if (!goodId(artist)) return Promise.resolve(null);
    return Promise.resolve().then(() => genresOf(artist)).then((list) => fromGenres(list), () => null);
  }

  // A ReccoBeats vibe with the artist's genres added (or none, when Spotify
  // has none or refuses).
  // When Spotify can't answer (null), the vibe is kept without them and the
  // genres are asked for again after FAILED_RETRY_MS.
  function withGenres(id, vibe, artist) {
    const ask = goodId(artist) ? Promise.resolve().then(() => genresOf(artist)).catch(() => null) : Promise.resolve([]);
    return ask.then((list) => {
      if (Array.isArray(list)) remember(id, Object.assign({}, vibe, { genres: cleanGenres(list) }), 0, true);
      else remember(id, Object.assign({}, vibe, { genres: [] }), FAILED_RETRY_MS, false);
    });
  }

  function run(id, artist) {
    busy = id;
    lookups += 1;
    const kept = items.get(id);
    const first = kept && kept.vibe && kept.vibe.source === 'features' && !kept.g
      ? Promise.resolve({ kind: 'kept', vibe: kept.vibe }) : askRecco(id);
    first.then((r) => {
      if (r.kind === 'kept') return withGenres(id, r.vibe, artist);
      if (r.kind === 'found') {
        lastProblem = '';
        return withGenres(id, r.vibe, artist);
      }
      if (r.kind === 'failed') problem(r.why);
      return askGenres(artist).then((g) => {
        if (r.kind === 'failed') {
          // Try ReccoBeats again later; meanwhile the genres (or nothing).
          remember(id, g, FAILED_RETRY_MS);
        } else {
          remember(id, g, g ? GENRES_RETRY_MS : UNKNOWN_RETRY_MS);
        }
      });
    }).catch((e) => {
      problem('unexpected (' + (e && e.message ? String(e.message).slice(0, 60) : 'error') + ')');
      remember(id, null, FAILED_RETRY_MS);
    }).then(() => {
      busy = null;
      if (!closed) {
        try { found(id); } catch (e) { log('Vibe: ' + (e && e.message)); }
      }
      const next = queued;
      queued = null;
      if (next && !closed) want(next.id, next.artist);
    });
  }

  function status() {
    return {
      lookups: off ? 'off' : 'on',
      busy: !!busy,
      kept: items.size,
      problem: lastProblem,
      problemAt: lastProblemAt ? new Date(lastProblemAt).toISOString() : null
    };
  }

  function close() {
    closed = true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeNow(); }
  }

  load();
  return {
    want: want, get: get, status: status, close: close,
    pending: (id) => busy === id || !!(queued && queued.id === id),
    debug: () => ({ busy: busy, queued: queued ? queued.id : null, kept: items.size, lookups: lookups, waitUntil: waitUntil }),
    flush: writeNow
  };
}

module.exports = {
  RECCOBEATS: RECCOBEATS,
  createVibes: createVibes,
  cleanVibe: cleanVibe,
  readFeatures: readFeatures,
  fromGenres: fromGenres,
  GENRE_TABLE: GENRE_TABLE
};
