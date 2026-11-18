/*
 * "All sounds": whatever is playing in the house, from any source, for the
 * test-only All sounds widget on the TV (app/widgets/allsounds.js).
 *
 * Two sources:
 *   - Home Assistant's REST API (GET {HA_URL}/api/states), for the Echo
 *     speakers that the Alexa Media Player integration shows as
 *     media_player.* entities: TuneIn, iHeartRadio, Amazon Music, Spotify on
 *     an Echo, and so on.
 *   - The Spotify module (spotify.js), through the "nowplaying" resource the
 *     server already keeps. Spotify wins when both are playing.
 *
 * Out of it comes one small resource, "allsounds", that the TV draws:
 *   { v, state, from, source, device, title, artist, album, art, problem, stale }
 *   state    playing | paused | idle | off | notset | error
 *   from     'echo', 'spotify' or ''
 *   source   the app or service ("TuneIn", "Spotify"), up to 30 characters.
 *            An Echo names none, so it is inferred from the picture's host
 *            or an artist that is a service's name (inferPlatform); '' when
 *            unknown. Only the label, never the host, is kept.
 *   device   the speaker's name ("Living room Echo"), up to 60
 *   title, artist, album   up to 200 / 120 / 120 characters
 *   art      an absolute https picture address (Amazon's or Spotify's
 *            picture servers), or ''. Never a Home Assistant address: those
 *            only work with the token, which never leaves the Pi.
 *   problem  '' or a fixed word: 'auth' (Home Assistant refused the token),
 *            'unreachable', 'reply' (an answer that could not be read)
 *   stale    true when an Echo says "playing" a song that should have ended
 *            over a minute ago (staleEcho). Alexa Media Player keeps the last
 *            title when an app it does not understand (Audible) takes over.
 *            Only ever for an Echo that is playing, never for Spotify.
 *
 * Settings (pi/.env), all optional:
 *   HA_TOKEN            a long-lived access token from Home Assistant (your
 *                       profile, Security). Without it this is "not set up".
 *   HA_URL              Home Assistant's address; http://127.0.0.1:8123 when
 *                       left out (it runs on the same Pi).
 *   ALLSOUNDS_ENTITIES  a comma list of media_player ids to watch, e.g.
 *                       media_player.ian_s_echo_show,media_player.ian_s_echo_dot.
 *                       Left out: every Echo-style speaker (isAlexaSpeaker),
 *                       which may include speakers on someone else's account.
 *
 * The log only ever gets fixed words (Ian's rule, 2026-11-17): never the
 * token, an address, a title, a device name or anything from Amazon.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://127.0.0.1:8123';
const REQUEST_MS = 8000;
const MAX_REPLY = 4 * 1024 * 1024;   // /api/states lists every entity in the house
const PLAY_MS = 5000;                // something plays
const IDLE_MS = 20000;               // nothing plays, or not set up
const MAX_BACKOFF_MS = 120000;
const FAILS_BEFORE_ERROR = 2;        // a network hiccup keeps the last picture once
const MAX_ENTITIES = 12;
const STATES = ['playing', 'paused', 'idle', 'off', 'notset', 'error'];
const PROBLEMS = ['', 'auth', 'unreachable', 'reply'];
const STALE_AFTER_S = 60;            // past the end of the song by this much

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

// Plain one-line text: no control characters, no invisible direction marks,
// spaces squeezed, cut to max characters (whole characters, not halves).
function cleanText(v, max) {
  const t = str(v)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max - 1).join('').trim() + '…' : t;
}

// Only absolute https pictures reach the TV (http too for the stand-in).
function cleanArt(v, allowHttp) {
  const s = str(v).trim();
  if (!s || s.length > 600) return '';
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s"'<>\\]*$/.test(s) && !/^https:\/\/[^/]*@/.test(s)) return s;
  if (allowHttp && /^http:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s"'<>\\]*$/.test(s)) return s;
  return '';
}

/* ---------- settings ---------- */

function configFromEnv(env) {
  const e = env || {};
  const token = str(e.HA_TOKEN).trim();
  const rawUrl = str(e.HA_URL).trim();
  const rawList = str(e.ALLSOUNDS_ENTITIES).trim();
  const entities = rawList ? rawList.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : [];
  if (!token) return { configured: false, problem: '' };
  if (!/^[A-Za-z0-9._-]{20,2000}$/.test(token)) return { configured: false, problem: 'HA_TOKEN does not look like a Home Assistant token' };
  let url = (rawUrl || DEFAULT_URL).replace(/\/+$/, '');
  let u = null;
  try { u = new URL(url); } catch (err) { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) {
    return { configured: false, problem: 'HA_URL does not look right (it is like http://127.0.0.1:8123)' };
  }
  const bad = entities.filter((x) => !/^media_player\.[a-z0-9_]{1,80}$/.test(x));
  if (bad.length) return { configured: false, problem: 'ALLSOUNDS_ENTITIES must be media_player ids, separated by commas' };
  if (entities.length > MAX_ENTITIES) return { configured: false, problem: 'ALLSOUNDS_ENTITIES lists more than ' + MAX_ENTITIES };
  return { configured: true, problem: '', url: url, token: token, entities: entities };
}

/* ---------- the resource the TV gets ---------- */

function notsetData() {
  return { v: 1, state: 'notset', from: '', source: '', device: '', title: '', artist: '', album: '', art: '', problem: '', stale: false };
}

// Rebuilds data from known fields only, for the state file and the TV.
function cleanData(d, allowHttp) {
  if (!isObj(d)) return notsetData();
  let state = STATES.indexOf(d.state) >= 0 ? d.state : 'notset';
  const out = {
    v: 1, state: state,
    from: d.from === 'echo' || d.from === 'spotify' ? d.from : '',
    source: cleanText(d.source, 30), device: cleanText(d.device, 60),
    title: cleanText(d.title, 200), artist: cleanText(d.artist, 120), album: cleanText(d.album, 120),
    art: cleanArt(d.art, allowHttp),
    problem: PROBLEMS.indexOf(d.problem) >= 0 ? d.problem : '',
    stale: d.stale === true
  };
  // Playing with nothing known (TuneIn on an Echo sends no title, artist,
  // picture or app): still playing, as long as the speaker is known.
  if ((state === 'playing' || state === 'paused') && !out.title && !out.source && !out.device) out.state = 'idle';
  if (out.state !== 'playing' && out.state !== 'paused') {
    out.from = ''; out.title = ''; out.artist = ''; out.album = ''; out.art = '';
    if (out.state !== 'idle' && out.state !== 'off') out.device = '';
    if (out.state === 'notset' || out.state === 'error') out.source = '';
  }
  if (out.state !== 'error') out.problem = '';
  if (out.state !== 'playing' || out.from !== 'echo') out.stale = false;
  return out;
}

function cleanResource(r, allowHttp) {
  if (!isObj(r)) return { rev: 0, data: notsetData() };
  const rev = Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  return { rev: rev, data: cleanData(r.data, allowHttp) };
}

// The app's name as people say it. Unknown names pass through, cleaned.
const KNOWN_SOURCES = [
  [/tune\s*in/i, 'TuneIn'],
  [/spotify/i, 'Spotify'],
  [/i\s*heart/i, 'iHeartRadio'],
  [/amazon\s*music|cloud\s*player|prime\s*music|amazon_music/i, 'Amazon Music'],
  [/apple\s*music/i, 'Apple Music'],
  [/pandora/i, 'Pandora'],
  [/audible/i, 'Audible'],
  [/sirius/i, 'SiriusXM'],
  [/deezer/i, 'Deezer'],
  [/youtube/i, 'YouTube Music'],
  [/bluetooth/i, 'Bluetooth']
];
const NOT_A_SOURCE = /^(local speaker|default|none|unknown|tv|alexa)$/i;

function sourceLabel(attrs) {
  const a = isObj(attrs) ? attrs : {};
  const tries = [a.app_name, a.provider, a.source, a.media_channel_provider];
  for (let i = 0; i < tries.length; i++) {
    const t = cleanText(tries[i], 40);
    if (!t || NOT_A_SOURCE.test(t)) continue;
    for (let k = 0; k < KNOWN_SOURCES.length; k++) if (KNOWN_SOURCES[k][0].test(t)) return KNOWN_SOURCES[k][1];
    return cleanText(t, 30);
  }
  // Alexa Media Player often names no app at all (Amazon Music, TuneIn): ''
  // here; readEntity then tries inferPlatform.
  return '';
}

// Echo entities from Alexa Media Player never carry source or app_name, but
// the picture's host says who made it. Only the host is looked at, and only
// the label below ever leaves this function: never the host or the address.
// Amazon's own picture servers are Amazon Music (an audiobook cannot be told
// apart from there, so it is not guessed to be Audible).
const PLATFORM_HOSTS = [
  [/(^|\.)i\.scdn\.co$/, 'Spotify'],
  [/(^|\.)spotifycdn\.com$/, 'Spotify'],
  [/(^|\.)audible\.com$/, 'Audible'],
  [/(^|\.)media-amazon\.com$/, 'Amazon Music'],
  [/(^|\.)ssl-images-amazon\.com$/, 'Amazon Music'],
  [/(^|\.)pandora\.com$/, 'Pandora'],
  [/(^|\.)p-cdn\.(us|com)$/, 'Pandora'],
  [/^cdn-profiles\.tunein\.com$/, 'TuneIn'],
  [/(^|\.)radiotime\.com$/, 'TuneIn'],
  [/(^|\.)iheart\.com$/, 'iHeartRadio'],
  [/(^|\.)ihrhls\.com$/, 'iHeartRadio'],
  [/(^|\.)mzstatic\.com$/, 'Apple Music'],
  [/(^|\.)siriusxm\.com$/, 'SiriusXM']
];
// A radio station that names itself as the artist.
const ARTIST_PLATFORMS = ['iHeartRadio', 'TuneIn', 'Pandora', 'SiriusXM'];

function platformFromPicture(pic) {
  const s = str(pic).trim();
  if (!s || s.length > 600) return '';
  let host = '';
  try { host = new URL(s).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return ''; }
  for (let i = 0; i < PLATFORM_HOSTS.length; i++) if (PLATFORM_HOSTS[i][0].test(host)) return PLATFORM_HOSTS[i][1];
  return '';
}

function platformFromArtist(artist) {
  const t = cleanText(artist, 120);
  for (let i = 0; i < ARTIST_PLATFORMS.length; i++) if (t === ARTIST_PLATFORMS[i]) return ARTIST_PLATFORMS[i];
  return '';
}

// The platform of an Echo entity's attributes, or '' when unknown. A picture
// host wins, except that Amazon's (the catch-all) gives way to a station that
// names itself as the artist.
function inferPlatform(attrs) {
  const a = isObj(attrs) ? attrs : {};
  const fromPic = platformFromPicture(a.entity_picture);
  const fromArtist = platformFromArtist(a.media_artist);
  if (fromPic && (fromPic !== 'Amazon Music' || !fromArtist)) return fromPic;
  return fromArtist || fromPic;
}

// An Echo-style entity from the Alexa Media Player integration: it carries
// last_called or bluetooth_list. TVs, game consoles, browser_mod panels and
// car head units do not. media_player.everywhere is Alexa's "every speaker"
// group, which only repeats the others.
function isAlexaSpeaker(e) {
  if (!isObj(e)) return false;
  const id = str(e.entity_id);
  if (!/^media_player\./.test(id) || id === 'media_player.everywhere' || /^media_player\.browser_mod/.test(id)) return false;
  const a = isObj(e.attributes) ? e.attributes : {};
  return Object.prototype.hasOwnProperty.call(a, 'last_called') || Object.prototype.hasOwnProperty.call(a, 'bluetooth_list');
}

// Is this playing entity's song over a minute past its end? Only with a
// duration: a radio stream has none and may rightly stay the same for hours.
// The position is where it was at media_position_updated_at.
function staleEcho(a, now) {
  const dur = Number(a.media_duration);
  const pos = Number(a.media_position);
  const at = Date.parse(str(a.media_position_updated_at));
  if (a.media_duration == null || a.media_position == null || !isFinite(dur) || dur <= 0 || !isFinite(pos) || pos < 0 || !isFinite(at)) return false;
  const est = pos + Math.max(0, (now - at) / 1000);
  return est > dur + STALE_AFTER_S;
}

// What one media_player entity says, in our words, or null when it is not one.
// now: the time in ms (Date.now() when left out).
function readEntity(e, allowHttp, now) {
  if (!isObj(e) || !/^media_player\.[a-z0-9_]{1,80}$/.test(str(e.entity_id))) return null;
  const a = isObj(e.attributes) ? e.attributes : {};
  const raw = str(e.state).toLowerCase();
  const state = raw === 'playing' || raw === 'buffering' ? 'playing'
    : raw === 'paused' ? 'paused'
      : raw === 'idle' || raw === 'on' || raw === 'standby' ? 'idle' : 'off';
  const changed = Date.parse(str(e.last_changed) || str(e.last_updated));
  const title = cleanText(a.media_title, 200);
  // A radio show often has no artist: the station (media_channel or the
  // album) stands in for it so the second line says something useful.
  const artist = cleanText(a.media_artist, 120) || cleanText(a.media_album_artist, 120);
  const album = cleanText(a.media_album_name, 120) || cleanText(a.media_channel, 120);
  return {
    id: e.entity_id, state: state, changedAt: isFinite(changed) ? changed : 0,
    device: cleanText(a.friendly_name, 60) || cleanText(e.entity_id.slice(13).replace(/_/g, ' '), 60),
    source: sourceLabel(a) || inferPlatform(a), title: title, artist: artist, album: album === title ? '' : album,
    art: cleanArt(a.entity_picture, allowHttp),
    stale: state === 'playing' && staleEcho(a, typeof now === 'number' ? now : Date.now())
  };
}

// Picks the one to show: the newest playing one, else the newest paused one.
// list: entities from readEntity. Returns the house in one picture.
function pickActive(list) {
  const ok = (Array.isArray(list) ? list : []).filter(Boolean);
  const newest = (s) => ok.filter((x) => x.state === s).sort((a, b) => b.changedAt - a.changedAt)[0] || null;
  const hit = newest('playing') || newest('paused');
  if (hit) {
    return { v: 1, state: hit.state, from: 'echo', source: hit.source, device: hit.device, title: hit.title,
      artist: hit.artist, album: hit.album, art: hit.art, problem: '', stale: hit.stale === true };
  }
  const d = notsetData();
  const idle = newest('idle');
  d.state = idle ? 'idle' : 'off';
  d.device = idle ? idle.device : '';
  return d;
}

// Spotify's "nowplaying" data (spotify.js) as an All sounds picture, or null
// when Spotify is not playing or paused.
function fromSpotify(np, allowHttp) {
  if (!isObj(np) || (np.state !== 'playing' && np.state !== 'paused') || !isObj(np.track)) return null;
  const t = np.track;
  return cleanData({
    v: 1, state: np.state, from: 'spotify', source: 'Spotify',
    device: isObj(np.device) ? np.device.name : '',
    title: t.title, artist: t.artist, album: t.album, art: t.artSmall || t.art, problem: '', stale: false
  }, allowHttp);
}

// The house (from Home Assistant, or its notset/error picture) and Spotify,
// together: Spotify playing wins; then the house playing; then whichever is
// paused (the house first). One exception: Spotify keeps saying "playing" on
// an Echo for a while after that Echo has moved on to another app (seen
// 2026-11-17: Spotify still "playing" while the Echo Show played iHeartRadio).
// So when the house reports that same speaker playing something else, the
// speaker wins.
function sameName(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function merge(house, sp) {
  const h = house || notsetData();
  if (sp && sp.state === 'playing' && h.state === 'playing' && sameName(sp.device, h.device) &&
      h.title && !sameName(h.title, sp.title)) return h;
  if (sp && sp.state === 'playing') return sp;
  if (h.state === 'playing' || h.state === 'paused') return h;
  if (sp) return sp;
  return h;
}

function signature(d) {
  return JSON.stringify([d.state, d.from, d.source, d.device, d.title, d.artist, d.album, d.art, d.problem, d.stale === true]);
}

/* ---------- a small web request ---------- */

// Resolves to { status, text }; rejects with e.kind 'timeout' or 'network'.
// Never follows redirects.
function request(url, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { const err = new Error('bad address'); err.kind = 'network'; reject(err); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET', timeout: timeoutMs || REQUEST_MS,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY) { const err = new Error('too large'); err.kind = 'reply'; req.destroy(err); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => { const err = new Error('broke off'); err.kind = 'network'; reject(err); });
    });
    req.on('timeout', () => { const err = new Error('timed out'); err.kind = 'timeout'; req.destroy(err); });
    req.on('error', (e) => {
      const err = new Error('network');
      err.kind = e && (e.kind === 'timeout' || e.kind === 'reply') ? e.kind : 'network';
      reject(err);
    });
    req.end();
  });
}

/* ---------- the watcher ---------- */

/*
 * o.config      from configFromEnv
 * o.current()   the allsounds data held by the server
 * o.spotify()   the nowplaying data held by the server (or null)
 * o.publish(data)   a real change: save and push it
 * o.log, o.now
 * o.allowHttp   let http pictures through (the stand-in)
 * o.playMs, o.idleMs, o.timeoutMs   for tests
 * o.manual      no timers: tests call poll() themselves
 */
function createWatcher(o) {
  const cfg = o.config || { configured: false, problem: '' };
  const log = typeof o.log === 'function' ? o.log : () => {};
  const allowHttp = o.allowHttp === true;
  const playMs = o.playMs || PLAY_MS;
  const idleMs = o.idleMs || IDLE_MS;
  const timeoutMs = o.timeoutMs || REQUEST_MS;
  const spotify = typeof o.spotify === 'function' ? o.spotify : () => null;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  let house = cfg.configured ? null : notsetData();   // the last picture from Home Assistant
  let fails = 0;
  let timer = null;
  let polling = null;
  let closed = false;
  let lastLogged = '';

  // One fixed line per change of what is going on. Never a title, a device,
  // an address or the token: only the kind of source.
  function note(d) {
    let line;
    if (d.state === 'playing') line = 'allsounds: playing from ' + (d.from === 'spotify' ? 'Spotify' : 'an Echo');
    else if (d.state === 'paused') line = 'allsounds: paused';
    else if (d.state === 'error') {
      line = d.problem === 'auth' ? 'allsounds: Home Assistant refused the token (401)'
        : d.problem === 'reply' ? 'allsounds: Home Assistant sent a reply that could not be read'
          : 'allsounds: Home Assistant could not be reached';
    } else if (d.state === 'notset') line = '';
    else line = 'allsounds: nothing playing';
    if (line && line !== lastLogged) log(line);
    lastLogged = line || lastLogged;
  }

  // The picture from the house and the given Spotify data, or null when it
  // is the same as the one held now.
  function nextWith(np) {
    if (closed) return null;
    const h = house || notsetData();
    const next = cleanData(merge(h, fromSpotify(np, allowHttp)), allowHttp);
    const prev = cleanData(o.current(), allowHttp);
    if (signature(prev) === signature(next)) return null;
    note(next);
    return next;
  }

  // Works out the picture from the house and Spotify and pushes it if it changed.
  function put() {
    const next = nextWith(spotify());
    if (!next) return false;
    o.publish(next);
    return true;
  }

  function fail(kind, status) {
    fails += 1;
    if (kind === 'auth') {
      // A refused token will not get better by itself: say so at once
      // (note() logs it once).
      house =Object.assign(notsetData(), { state: 'error', problem: 'auth' });
    } else if (kind === 'status') {
      if (fails === 1) log('allsounds: Home Assistant answered HTTP ' + (Number(status) || 0));
      if (fails >= FAILS_BEFORE_ERROR) house = Object.assign(notsetData(), { state: 'error', problem: 'unreachable' });
    } else {
      if (fails === 1 && kind === 'timeout') log('allsounds: Home Assistant timed out');
      if (fails >= FAILS_BEFORE_ERROR || !house) house = Object.assign(notsetData(), { state: 'error', problem: kind === 'reply' ? 'reply' : 'unreachable' });
    }
    put();
    return { ok: false, problem: kind };
  }

  function fetchStates() {
    const base = cfg.url;
    if (!cfg.entities.length) {
      return request(base + '/api/states', cfg.token, timeoutMs).then((r) => {
        if (r.status !== 200) return { status: r.status };
        let j;
        try { j = JSON.parse(r.text); } catch (e) { return { bad: true }; }
        if (!Array.isArray(j)) return { bad: true };
        // No list in .env: Echo-style speakers only (see isAlexaSpeaker).
        return { list: j.filter(isAlexaSpeaker) };
      });
    }
    // Only the listed ones: one small call each, in turn.
    const list = [];
    let chain = Promise.resolve(null);
    cfg.entities.forEach((id) => {
      chain = chain.then((stop) => {
        if (stop) return stop;
        return request(base + '/api/states/' + id, cfg.token, timeoutMs).then((r) => {
          if (r.status === 404) return null;         // gone or renamed: skip it
          if (r.status !== 200) return { status: r.status };
          try { const j = JSON.parse(r.text); if (isObj(j)) list.push(j); } catch (e) { return { bad: true }; }
          return null;
        });
      });
    });
    return chain.then((stop) => stop || { list: list });
  }

  function pollOnce() {
    if (!cfg.configured) {
      house = notsetData();
      put();
      return Promise.resolve({ ok: false, problem: 'notset' });
    }
    return fetchStates().then((r) => {
      if (r.status === 401 || r.status === 403) return fail('auth');
      if (r.status) return fail('status', r.status);
      if (r.bad) return fail('reply');
      if (fails) log('allsounds: Home Assistant working again');
      fails = 0;
      house = pickActive(r.list.map((e) => readEntity(e, allowHttp, now())));
      return { ok: true, changed: put() };
    }, (e) => fail(e && e.kind === 'timeout' ? 'timeout' : e && e.kind === 'reply' ? 'reply' : 'network'));
  }

  function poll() {
    if (polling) return polling;
    polling = pollOnce().then((r) => { polling = null; return r; }, () => {
      polling = null;
      log('allsounds: unexpected problem');
      return { ok: false };
    });
    return polling;
  }

  function delay() {
    if (!cfg.configured) return 0;   // nothing to ask; Spotify changes still come through spotifyChanged()
    const d = cleanData(o.current(), allowHttp);
    const base = d.state === 'playing' ? playMs : idleMs;
    if (!fails) return base;
    return Math.min(MAX_BACKOFF_MS, base * Math.pow(2, Math.min(fails, 5)));
  }

  function schedule() {
    if (closed || o.manual) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const ms = delay();
    if (!ms) return;
    timer = setTimeout(() => { timer = null; poll().then(schedule); }, ms);
    if (timer.unref) timer.unref();
  }

  // Spotify's picture is about to change to np (spotify.js publishing): the
  // All sounds data to save with it in the same change, or null when All
  // sounds stays as it is. The server saves both under one rev, so Now
  // Playing's revs go on exactly as before.
  function withSpotify(np) {
    const next = nextWith(np);
    // Something started playing: ask the house sooner next time.
    if (next && next.state === 'playing' && cleanData(o.current(), allowHttp).state !== 'playing') setTimeout(schedule, 0);
    return next;
  }

  function status() {
    const d = cleanData(o.current(), allowHttp);
    return {
      configured: !!cfg.configured, problem: str(cfg.problem), state: d.state, source: d.source, device: d.device,
      title: d.title, artist: d.artist, haProblem: d.problem
    };
  }

  function start() {
    if (!cfg.configured) {
      log(cfg.problem ? 'allsounds: off (' + cfg.problem + ')' : 'allsounds: off (no HA_TOKEN in .env)');
      put();
      return;
    }
    log('allsounds: watching Home Assistant' + (cfg.entities.length ? ' (' + cfg.entities.length + ' listed speakers)' : ''));
    if (!o.manual) poll().then(schedule);
  }

  function close() {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start: start, close: close, poll: poll, status: status, withSpotify: withSpotify,
    configured: !!cfg.configured,
    debug: () => ({ timer: !!timer, fails: fails, delay: delay() })
  };
}

module.exports = {
  configFromEnv: configFromEnv,
  notsetData: notsetData,
  cleanData: cleanData,
  cleanResource: cleanResource,
  cleanText: cleanText,
  cleanArt: cleanArt,
  sourceLabel: sourceLabel,
  inferPlatform: inferPlatform,
  isAlexaSpeaker: isAlexaSpeaker,
  readEntity: readEntity,
  staleEcho: staleEcho,
  pickActive: pickActive,
  fromSpotify: fromSpotify,
  merge: merge,
  createWatcher: createWatcher
};
