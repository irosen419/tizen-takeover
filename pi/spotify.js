/*
 * Spotify "Now Playing" for the Home Hub live server.
 *
 * The Pi is the only thing that talks to Spotify. It holds the client secret
 * (pi/.env) and the long-lived sign-in (data/spotify.json), asks Spotify what
 * is playing every few seconds, and keeps one resource, "nowplaying", that
 * the TV draws. The TV never sees a secret or a token: only the track, the
 * artist, the album, picture addresses and where the song is.
 *
 * Signing in happens once (see "Spotify" in README.md):
 *   1. loginUrl() makes a link to Spotify's approval page.
 *   2. Spotify sends the browser to the redirect address with a one-time code.
 *      Spotify only allows http://127.0.0.1 or https there, so on a phone or a
 *      laptop that page does not load; the address in the address bar is
 *      pasted back instead (finishLogin). If the browser can reach this
 *      server at that address, GET /spotify/callback finishes it by itself.
 *   3. The code is swapped for a refresh token, saved in the data folder with
 *      owner-only permissions. From then on access tokens are renewed here.
 *
 * Nothing in this file logs or returns the client secret, a token or a code.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vibeLib = require('./vibe');

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com';
// Reading only, plus playback control so that buttons can be added later
// without signing in again. Nothing here uses the control scope yet.
const SCOPES = ['user-read-playback-state', 'user-read-currently-playing', 'user-modify-playback-state'];
const TOKEN_FILE = 'spotify.json';
const LOGIN_MINUTES = 15;
const REQUEST_MS = 10000;
const MAX_REPLY = 512 * 1024;
const PLAY_MS = 5000;        // a screen is on and something is playing
const IDLE_MS = 10000;       // a screen is on, nothing playing
const AWAY_MS = 60000;       // no screen is on
const DRIFT_MS = 2500;       // a jump in the song's position bigger than this is a seek
const FAILS_BEFORE_ERROR = 3;
const MAX_WAIT_MS = 5 * 60000;
const MAX_TEXT = 200;
const STATES = ['off', 'signin', 'idle', 'playing', 'paused', 'error'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 0);

function cleanText(v, max) {
  const t = str(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return Array.from(t).slice(0, max || MAX_TEXT).join('');
}

// Only https picture addresses reach the TV (http is allowed for the mock).
function cleanUrl(v, allowHttp) {
  const s = str(v).trim();
  if (s.length > 500) return '';
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (allowHttp && /^http:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return '';
}

/* ---------- settings ---------- */

// SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and optionally
// SPOTIFY_REDIRECT_URI from pi/.env. port is the hub's main door.
function configFromEnv(env, port) {
  const e = env || {};
  const id = str(e.SPOTIFY_CLIENT_ID).trim();
  const secret = str(e.SPOTIFY_CLIENT_SECRET).trim();
  const redirect = str(e.SPOTIFY_REDIRECT_URI).trim() || 'http://127.0.0.1:' + (port || 8097) + '/spotify/callback';
  if (!id && !secret) return { configured: false, problem: '', redirectUri: redirect };
  if (!id) return { configured: false, problem: 'SPOTIFY_CLIENT_ID is missing in pi/.env', redirectUri: redirect };
  if (!secret) return { configured: false, problem: 'SPOTIFY_CLIENT_SECRET is missing in pi/.env', redirectUri: redirect };
  if (!/^[A-Za-z0-9]{16,64}$/.test(id)) return { configured: false, problem: 'SPOTIFY_CLIENT_ID does not look right (it is 32 letters and digits)', redirectUri: redirect };
  if (!/^[A-Za-z0-9]{16,64}$/.test(secret)) return { configured: false, problem: 'SPOTIFY_CLIENT_SECRET does not look right (it is 32 letters and digits)', redirectUri: redirect };
  if (!/^https:\/\/\S+$|^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?(\/\S*)?$/.test(redirect)) {
    return { configured: false, problem: 'SPOTIFY_REDIRECT_URI must start with https:// or http://127.0.0.1 (Spotify allows nothing else)', redirectUri: redirect };
  }
  return { configured: true, problem: '', clientId: id, clientSecret: secret, redirectUri: redirect };
}

/* ---------- the resource the TV gets ---------- */

function offData() {
  return {
    v: 1, configured: false, signedIn: false, state: 'off', problem: '',
    track: null, progressMs: 0, at: 0, device: null, shuffle: false, repeat: 'off', playedAt: 0, vibe: null
  };
}

// SPOTIFY_VIBE=off in pi/.env: never ask ReccoBeats (see vibe.js).
function vibeOffFromEnv(env) {
  return /^(off|no|false|0)$/i.test(str((env || {}).SPOTIFY_VIBE).trim());
}

// A song's vibe, only when it belongs to this very track.
function cleanVibeFor(v, track) {
  if (!track || track.kind !== 'track' || !track.id) return null;
  const c = vibeLib.cleanVibe(v);
  return c && c.id === track.id ? c : null;
}

function cleanTrack(t, allowHttp) {
  if (!isObj(t)) return null;
  const title = cleanText(t.title);
  if (!title) return null;
  return {
    id: cleanText(t.id, 80), kind: t.kind === 'episode' ? 'episode' : 'track', title: title,
    artist: cleanText(t.artist), album: cleanText(t.album),
    art: cleanUrl(t.art, allowHttp), artSmall: cleanUrl(t.artSmall, allowHttp), artTiny: cleanUrl(t.artTiny, allowHttp),
    durationMs: num(t.durationMs), explicit: t.explicit === true
  };
}

// Rebuilds stored data from known fields only, so a damaged or hand-edited
// state.json cannot break the server or pass anything unexpected to the TV.
function cleanData(d, allowHttp) {
  if (!isObj(d)) return offData();
  const track = cleanTrack(d.track, allowHttp);
  let state = STATES.indexOf(d.state) >= 0 ? d.state : 'off';
  if ((state === 'playing' || state === 'paused') && !track) state = 'idle';
  const device = isObj(d.device) && cleanText(d.device.name, 60)
    ? { name: cleanText(d.device.name, 60), type: cleanText(d.device.type, 30) } : null;
  return {
    v: 1, configured: d.configured === true, signedIn: d.signedIn === true, state: state,
    problem: cleanText(d.problem, 160), track: track,
    progressMs: track ? Math.min(num(d.progressMs), track.durationMs || num(d.progressMs)) : 0,
    at: num(d.at), device: device, shuffle: d.shuffle === true,
    repeat: d.repeat === 'track' || d.repeat === 'context' ? d.repeat : 'off', playedAt: num(d.playedAt),
    vibe: cleanVibeFor(d.vibe, track)
  };
}

function cleanResource(r, allowHttp) {
  if (!isObj(r)) return { rev: 0, data: offData() };
  const rev = Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  return { rev: rev, data: cleanData(r.data, allowHttp) };
}

// Picks three sizes from Spotify's picture list (largest first, usually
// 640, 300 and 64 pixels): the page, the tile, and a tiny one that the TV
// stretches into a soft color wash.
function pickArt(images, allowHttp) {
  const list = (Array.isArray(images) ? images : []).filter((i) => isObj(i) && cleanUrl(i.url, allowHttp))
    .map((i) => ({ url: cleanUrl(i.url, allowHttp), w: num(i.width) }))
    .sort((a, b) => b.w - a.w);
  if (!list.length) return { art: '', artSmall: '', artTiny: '' };
  const big = list[0];
  const tiny = list[list.length - 1];
  let mid = list[0];
  list.forEach((i) => { if (i.w && i.w >= 200 && i.w <= mid.w) mid = i; });
  return { art: big.url, artSmall: mid.url, artTiny: tiny.url };
}

// Turns Spotify's "what is playing" answer into the fields the TV needs.
// Returns { track, playing, progressMs, device, shuffle, repeat }, with
// track null when Spotify names no song (an advert, a private session).
function readPlayback(json, allowHttp) {
  const j = isObj(json) ? json : {};
  const item = isObj(j.item) ? j.item : null;
  let track = null;
  if (item) {
    const episode = item.type === 'episode' || j.currently_playing_type === 'episode';
    const show = isObj(item.show) ? item.show : {};
    const album = isObj(item.album) ? item.album : {};
    const artists = (Array.isArray(item.artists) ? item.artists : []).map((a) => cleanText(a && a.name, 80)).filter(Boolean);
    const art = pickArt(episode ? (item.images && item.images.length ? item.images : show.images) : album.images, allowHttp);
    track = cleanTrack({
      id: str(item.id) || str(item.uri), kind: episode ? 'episode' : 'track', title: item.name,
      artist: episode ? (show.name || show.publisher) : artists.join(', '),
      album: episode ? '' : album.name,
      art: art.art, artSmall: art.artSmall, artTiny: art.artTiny,
      durationMs: item.duration_ms, explicit: item.explicit === true
    }, allowHttp);
  }
  const dev = isObj(j.device) ? j.device : null;
  return {
    track: track,
    playing: j.is_playing === true,
    progressMs: num(j.progress_ms),
    device: dev && cleanText(dev.name, 60) ? { name: cleanText(dev.name, 60), type: cleanText(dev.type, 30) } : null,
    shuffle: j.shuffle_state === true,
    repeat: j.repeat_state === 'track' || j.repeat_state === 'context' ? j.repeat_state : 'off'
  };
}

// The first artist's Spotify id (for the genres in vibe.js), or ''.
function readArtistId(json) {
  const item = isObj(json) && isObj(json.item) ? json.item : null;
  const a = item && Array.isArray(item.artists) && isObj(item.artists[0]) ? item.artists[0] : null;
  const id = a ? str(a.id) : '';
  return /^[A-Za-z0-9]{1,64}$/.test(id) ? id : '';
}

// What makes two pictures of the playback "the same" for the TV: everything
// except the clock. The position is compared separately (a seek). The vibe
// counts: it arrives a moment after the song, as one more push.
function signature(d) {
  return JSON.stringify([d.configured, d.signedIn, d.state, d.problem, d.track, d.device, d.shuffle, d.repeat, d.vibe || null]);
}

// Where the song should be at time `now`, going by an earlier picture.
function expectedProgress(d, now) {
  if (!d || !d.track) return 0;
  const p = d.progressMs + (d.state === 'playing' && d.at ? Math.max(0, now - d.at) : 0);
  return d.track.durationMs ? Math.min(p, d.track.durationMs) : p;
}

/* ---------- a small web request ---------- */

// Resolves to { status, headers, text }; rejects on network trouble with a
// short reason. Never follows redirects.
function request(method, url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad address')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const body = o.body === undefined ? null : Buffer.from(o.body);
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    if (body) headers['Content-Length'] = body.length;
    const req = lib.request(u, { method: method, headers: headers, timeout: o.timeoutMs || REQUEST_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY) { req.destroy(new Error('the reply was too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new Error('the reply broke off')));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => reject(new Error(e && e.message === 'timed out' ? 'timed out' : 'could not be reached')));
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(text) {
  try { const j = JSON.parse(text); return isObj(j) ? j : null; } catch (e) { return null; }
}

function stop(message, status) {
  const e = new Error(message);
  e.status = status || 400;
  return e;
}

/* ---------- the player ---------- */

/*
 * o.config      from configFromEnv
 * o.dataDir     where spotify.json lives
 * o.current()   the nowplaying data held by the server
 * o.publish(data, changed)   changed false = only the clock moved: keep it
 *               in memory, do not save or push
 * o.screens()   how many screens are connected now
 * o.log, o.now
 * o.accounts, o.api   other base addresses (the mock, in tests and the preview)
 * o.allowHttp   let http picture addresses through (the mock)
 * o.playMs, o.idleMs, o.awayMs   how often to ask
 * o.manual      no timers: tests call poll() themselves
 * o.vibe        ReccoBeats' address (the stand-in); o.vibeOff never ask it
 */
function createPlayer(o) {
  const cfg = o.config || { configured: false };
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const accounts = str(o.accounts).replace(/\/+$/, '') || ACCOUNTS;
  const api = str(o.api).replace(/\/+$/, '') || API;
  const allowHttp = o.allowHttp === true;
  const file = path.join(o.dataDir, TOKEN_FILE);
  const playMs = o.playMs || PLAY_MS;
  const idleMs = o.idleMs || IDLE_MS;
  const awayMs = o.awayMs || AWAY_MS;
  const screens = typeof o.screens === 'function' ? o.screens : () => 0;

  let refreshToken = '';
  let user = '';
  let access = '';
  let accessUntil = 0;
  let pending = null;       // { state, until } while a sign-in link is out
  let timer = null;
  let polling = null;       // the poll in flight, so two never overlap
  let closed = false;
  let fails = 0;
  let waitUntil = 0;        // Spotify asked us to slow down until then
  let lastPollAt = 0;
  let lastOkAt = 0;
  let lastProblem = '';

  // The song's vibe (vibe.js): looked up in the background when a new song
  // shows, then pushed as one more change.
  const vibes = vibeLib.createVibes({
    dataDir: o.dataDir, base: o.vibe, off: o.vibeOff === true, log: log, now: now,
    timeoutMs: o.vibeTimeoutMs,
    genres: artistGenres,
    found: vibeArrived
  });

  /* --- the saved sign-in --- */

  function loadToken() {
    try {
      const j = parseJson(fs.readFileSync(file, 'utf8'));
      if (j && typeof j.refreshToken === 'string' && j.refreshToken.length >= 10) {
        refreshToken = j.refreshToken;
        user = cleanText(j.user, 80);
      }
    } catch (e) { /* not signed in yet */ }
  }

  function saveToken() {
    fs.mkdirSync(o.dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ refreshToken: refreshToken, user: user, savedAt: new Date(now()).toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) { /* not fatal */ }
  }

  function forgetToken() {
    refreshToken = '';
    access = '';
    accessUntil = 0;
    user = '';
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
  }

  function basicAuth() {
    return 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
  }

  // POST to Spotify's token address. Resolves to the JSON; rejects with
  // e.kind 'network', 'client' (the ID or secret is wrong), 'grant' (the
  // sign-in or the code is no longer good) or 'other'.
  function tokenCall(form) {
    const body = Object.keys(form).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&');
    return request('POST', accounts + '/api/token', {
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
    }).then((r) => {
      const j = parseJson(r.text) || {};
      if (r.status === 200 && typeof j.access_token === 'string') return j;
      const code = str(j.error);
      const e = new Error('Spotify said ' + (code ? cleanText(code, 40) : 'HTTP ' + r.status));
      e.kind = code === 'invalid_client' || r.status === 401 ? 'client' : code === 'invalid_grant' ? 'grant' : r.status >= 500 || r.status === 429 ? 'network' : 'other';
      throw e;
    }, (err) => {
      const e = new Error('Spotify ' + err.message);
      e.kind = 'network';
      throw e;
    });
  }

  function takeTokens(j) {
    access = j.access_token;
    const secs = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600;
    accessUntil = now() + secs * 1000;
    if (typeof j.refresh_token === 'string' && j.refresh_token && j.refresh_token !== refreshToken) {
      refreshToken = j.refresh_token;
      return true;
    }
    return false;
  }

  function freshAccess() {
    if (access && accessUntil - 60000 > now()) return Promise.resolve(access);
    return tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }).then((j) => {
      if (takeTokens(j)) { try { saveToken(); } catch (e) { log('Spotify: could not save the renewed sign-in (' + e.message + ')'); } }
      return access;
    });
  }

  function apiGet(route) {
    const once = (token) => request('GET', api + route, { headers: { Authorization: 'Bearer ' + token } });
    return freshAccess().then((token) => once(token).then((r) => {
      if (r.status !== 401) return r;
      // The access token went stale early: renew it once and ask again.
      access = '';
      return freshAccess().then(once);
    }));
  }

  // Spotify's genres for an artist; [] on any problem (never an error state).
  function artistGenres(artist) {
    if (!cfg.configured || !refreshToken) return Promise.resolve([]);
    return apiGet('/v1/artists/' + encodeURIComponent(artist)).then((r) => {
      if (r.status !== 200) return [];
      const j = parseJson(r.text);
      return j && Array.isArray(j.genres) ? j.genres : [];
    }, () => []);
  }

  // A lookup ended: if that song still plays and its vibe is new, push it.
  // The position is brought up to now, since the TV counts from arrival.
  function vibeArrived(id) {
    if (closed) return;
    const cur = cleanData(o.current(), allowHttp);
    if (!cur.track || cur.track.kind !== 'track' || cur.track.id !== id) return;
    const v = cleanVibeFor(vibes.get(id), cur.track);
    if (JSON.stringify(v) === JSON.stringify(cur.vibe)) return;
    const t = now();
    if (cur.state === 'playing') {
      cur.progressMs = expectedProgress(cur, t);
      cur.at = t;
    }
    cur.vibe = v;
    o.publish(cur, true);
  }

  /* --- publishing --- */

  function base() {
    const d = offData();
    d.configured = !!cfg.configured;
    d.signedIn = !!refreshToken;
    return d;
  }

  // Keeps the last song for "Last played" when nothing plays any more.
  function carry(next, prev) {
    if (!next.track && prev && prev.track) {
      next.track = prev.track;
      next.progressMs = 0;
      next.playedAt = prev.playedAt || prev.at || 0;
    }
    return next;
  }

  function put(next) {
    next.vibe = next.track ? cleanVibeFor(vibes.get(next.track.id), next.track) : null;
    const prev = cleanData(o.current(), allowHttp);
    let changed = signature(prev) !== signature(next);
    if (!changed && next.state === 'playing') {
      changed = Math.abs(expectedProgress(prev, next.at) - next.progressMs) > DRIFT_MS;
    } else if (!changed && next.state === 'paused') {
      changed = Math.abs(prev.progressMs - next.progressMs) > 500;
    }
    if (!changed && next.state !== 'playing') {
      // Nothing moved: leave the stored copy exactly as it is.
      return false;
    }
    o.publish(next, changed);
    return changed;
  }

  function putOff() {
    const d = base();
    d.state = !cfg.configured ? 'off' : 'signin';
    d.problem = !cfg.configured ? str(cfg.problem) : '';
    if (cfg.configured) carry(d, cleanData(o.current(), allowHttp));
    return put(d);
  }

  function putError(problem) {
    const prev = cleanData(o.current(), allowHttp);
    const d = base();
    d.state = 'error';
    d.problem = problem;
    carry(d, prev);
    d.device = null;
    return put(d);
  }

  /* --- asking Spotify --- */

  function note(problem) {
    if (problem !== lastProblem) {
      lastProblem = problem;
      log(problem ? 'Spotify: ' + problem : 'Spotify: working again');
    }
  }

  function pollOnce() {
    lastPollAt = now();
    if (!cfg.configured || !refreshToken) {
      putOff();
      return Promise.resolve({ ok: false });
    }
    if (waitUntil > now()) return Promise.resolve({ ok: false, waiting: true });
    return apiGet('/v1/me/player?additional_types=track,episode').then((r) => {
      const t = now();
      if (r.status === 429) {
        const secs = Number(r.headers['retry-after']);
        waitUntil = t + Math.min(MAX_WAIT_MS, (isFinite(secs) && secs > 0 ? secs : 30) * 1000);
        note('asked us to slow down for ' + Math.round((waitUntil - t) / 1000) + ' seconds');
        return { ok: false };
      }
      if (r.status === 204 || r.status === 202) {
        fails = 0;
        lastOkAt = t;
        note('');
        const d = base();
        d.state = 'idle';
        carry(d, cleanData(o.current(), allowHttp));
        return { ok: true, changed: put(d) };
      }
      if (r.status === 200) {
        const json = parseJson(r.text);
        const p = readPlayback(json, allowHttp);
        fails = 0;
        lastOkAt = t;
        note('');
        const d = base();
        d.device = p.device;
        d.shuffle = p.shuffle;
        d.repeat = p.repeat;
        if (p.track) {
          d.track = p.track;
          d.state = p.playing ? 'playing' : 'paused';
          d.progressMs = p.track.durationMs ? Math.min(p.progressMs, p.track.durationMs) : p.progressMs;
          d.at = t;
          d.playedAt = t;
          // Songs only: an episode has no tempo to follow.
          if (p.track.kind === 'track' && p.track.id) vibes.want(p.track.id, readArtistId(json));
        } else {
          d.state = 'idle';
          carry(d, cleanData(o.current(), allowHttp));
        }
        return { ok: true, changed: put(d) };
      }
      if (r.status === 403) {
        const j = parseJson(r.text) || {};
        const why = cleanText(isObj(j.error) ? j.error.message : '', 80);
        fails += 1;
        note('refused the request (403' + (why ? ', ' + why : '') + ')');
        putError('Spotify refused the request');
        return { ok: false };
      }
      throw new Error('Spotify answered HTTP ' + r.status);
    }).catch((e) => {
      if (e && e.kind === 'grant') {
        log('Spotify: the sign-in is no longer good; run ./hub spotify login');
        forgetToken();
        putOff();
        return { ok: false };
      }
      if (e && e.kind === 'client') {
        note('did not accept the client ID or secret in pi/.env');
        putError('Spotify did not accept the app’s ID or secret');
        return { ok: false };
      }
      fails += 1;
      note(cleanText(e && e.message, 80) || 'could not be reached');
      if (fails >= FAILS_BEFORE_ERROR) putError('Spotify could not be reached');
      return { ok: false };
    });
  }

  function poll() {
    if (polling) return polling;
    polling = pollOnce().then((r) => { polling = null; return r; }, (e) => {
      polling = null;
      log('Spotify: unexpected problem (' + cleanText(e && e.message, 80) + ')');
      return { ok: false };
    });
    return polling;
  }

  function delay() {
    if (!cfg.configured || !refreshToken) return 0;      // nothing to ask until someone signs in
    const wait = waitUntil > now() ? waitUntil - now() : 0;
    const d = cleanData(o.current(), allowHttp);
    const base2 = screens() > 0 ? (d.state === 'playing' ? playMs : idleMs) : awayMs;
    // Trouble: back off a little, up to a minute.
    const slow = fails > 1 ? Math.min(60000, base2 * fails) : base2;
    return Math.max(wait, slow);
  }

  function schedule() {
    if (closed || o.manual) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const ms = delay();
    if (!ms) return;
    timer = setTimeout(() => {
      timer = null;
      poll().then(schedule);
    }, ms);
    if (timer.unref) timer.unref();
  }

  // A screen just connected: make sure what it shows is fresh.
  function wake() {
    if (closed || o.manual || !cfg.configured || !refreshToken) return;
    if (now() - lastPollAt < 3000) { schedule(); return; }
    poll().then(schedule);
  }

  /* --- signing in --- */

  function loginUrl() {
    if (!cfg.configured) throw stop(cfg.problem ? cfg.problem + '.' : 'Spotify is not set up: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to pi/.env, then restart the server.');
    pending = { state: crypto.randomBytes(16).toString('hex'), until: now() + LOGIN_MINUTES * 60000 };
    const q = {
      response_type: 'code', client_id: cfg.clientId, scope: SCOPES.join(' '),
      redirect_uri: cfg.redirectUri, state: pending.state
    };
    const url = accounts + '/authorize?' + Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
    return { url: url, redirectUri: cfg.redirectUri, minutes: LOGIN_MINUTES };
  }

  // input: the whole address the browser ended on, its "?code=...&state=..."
  // part, or the bare code. Resolves to { user }.
  function finishLogin(input) {
    if (!cfg.configured) return Promise.reject(stop('Spotify is not set up in pi/.env.'));
    let text = str(input).trim().replace(/^["'<]+|["'>]+$/g, '');
    if (!text) return Promise.reject(stop('Paste the address from the browser’s address bar.'));
    if (text.length > 4000) return Promise.reject(stop('That is too long to be the address from Spotify.'));
    let code = '';
    let state = '';
    let error = '';
    const q = text.indexOf('?') >= 0 ? text.slice(text.indexOf('?') + 1) : (/(^|&)(code|error)=/.test(text) ? text : '');
    if (q) {
      const p = new URLSearchParams(q.replace(/#.*$/, ''));
      code = p.get('code') || '';
      state = p.get('state') || '';
      error = p.get('error') || '';
    } else if (/^[A-Za-z0-9_-]{20,}$/.test(text)) {
      code = text;
    }
    if (error) {
      return Promise.reject(stop(error === 'access_denied' ? 'Spotify says the request was declined. Run ./hub spotify login again and choose Agree.'
        : 'Spotify answered with an error (' + cleanText(error, 40) + '). Run ./hub spotify login again.'));
    }
    if (!code) return Promise.reject(stop('That does not look like the address Spotify sent the browser to. It starts with ' + cfg.redirectUri + '?code='));
    if (!pending || pending.until < now()) {
      pending = null;
      return Promise.reject(stop('The sign-in link is more than ' + LOGIN_MINUTES + ' minutes old (or the server restarted). Run ./hub spotify login again.'));
    }
    if (state && state !== pending.state) return Promise.reject(stop('That address belongs to an older sign-in link. Run ./hub spotify login again and use the new link.'));
    if (!state && q) return Promise.reject(stop('The address is missing its "state" part. Copy the whole address from the address bar.'));
    return tokenCall({ grant_type: 'authorization_code', code: code, redirect_uri: cfg.redirectUri }).then((j) => {
      if (typeof j.refresh_token !== 'string' || !j.refresh_token) throw stop('Spotify did not send a sign-in to keep. Try again.', 502);
      pending = null;
      takeTokens(j);
      refreshToken = j.refresh_token;
      user = '';
      fails = 0;
      waitUntil = 0;
      lastProblem = '';
      // The name is only for "Signed in as ...": not having it is fine.
      return request('GET', api + '/v1/me', { headers: { Authorization: 'Bearer ' + access } })
        .then((r) => { user = r.status === 200 ? cleanText((parseJson(r.text) || {}).display_name, 80) : ''; }, () => {})
        .then(() => {
          saveToken();
          log('Spotify: signed in' + (user ? ' as ' + user : ''));
          return poll().then(() => { schedule(); return { user: user }; });
        });
    }, (e) => {
      if (e.kind === 'grant') throw stop('Spotify did not accept that code. Codes work once and only for a few minutes: run ./hub spotify login again.');
      if (e.kind === 'client') throw stop('Spotify did not accept the client ID or secret in pi/.env. Check both, restart the server and try again.');
      if (e.kind === 'network') throw stop('Spotify could not be reached from the Pi. Check its internet connection and try again.', 502);
      throw stop(e.message + '. Check that ' + cfg.redirectUri + ' is listed under Redirect URIs in the Spotify app’s settings.');
    });
  }

  function logout() {
    const was = !!refreshToken;
    forgetToken();
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
    putOff();
    if (was) log('Spotify: signed out');
    return was;
  }

  function status() {
    const d = cleanData(o.current(), allowHttp);
    return {
      configured: !!cfg.configured, problem: str(cfg.problem), signedIn: !!refreshToken, user: user,
      redirectUri: str(cfg.redirectUri), state: d.state, note: d.problem,
      track: d.track ? { title: d.track.title, artist: d.track.artist, album: d.track.album, kind: d.track.kind } : null,
      device: d.device ? d.device.name : '',
      lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
      loginWaiting: !!(pending && pending.until > now()),
      vibe: vibeStatus(d)
    };
  }

  // For ./hub spotify status: the song's vibe, and how the lookups go.
  function vibeStatus(d) {
    const s = vibes.status();
    const v = d.vibe;
    return {
      lookups: s.lookups,
      song: !!(d.track && d.track.kind === 'track'),
      now: v ? { source: v.source, tempo: v.tempo, energy: v.energy, valence: v.valence, genres: v.genres } : null,
      pending: !!(d.track && vibes.pending(d.track.id)),
      problem: cleanText(s.problem, 120),
      problemAt: s.problemAt
    };
  }

  function start() {
    loadToken();
    if (!cfg.configured) {
      log('Spotify: off' + (cfg.problem ? ' (' + cfg.problem + ')' : ' (no SPOTIFY_ settings in .env)'));
      putOff();
      return;
    }
    if (!refreshToken) {
      log('Spotify: set up, not signed in yet (run ./hub spotify login)');
      putOff();
      return;
    }
    log('Spotify: signed in' + (user ? ' as ' + user : '') + ', watching what plays');
    if (!o.manual) poll().then(schedule);
  }

  function close() {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    vibes.close();
  }

  return {
    start: start, close: close, poll: poll, wake: wake, status: status,
    loginUrl: loginUrl, finishLogin: finishLogin, logout: logout,
    configured: !!cfg.configured,
    debug: () => ({ timer: !!timer, fails: fails, signedIn: !!refreshToken, pending: !!pending, delay: delay(), vibe: vibes.debug() })
  };
}

module.exports = {
  SCOPES: SCOPES,
  configFromEnv: configFromEnv,
  offData: offData,
  cleanData: cleanData,
  cleanResource: cleanResource,
  readPlayback: readPlayback,
  readArtistId: readArtistId,
  vibeOffFromEnv: vibeOffFromEnv,
  pickArt: pickArt,
  expectedProgress: expectedProgress,
  createPlayer: createPlayer
};
