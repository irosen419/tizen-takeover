/*
 * A stand-in for Spotify, for tests and the preview. It answers the three
 * things pi/spotify.js uses, in Spotify's own shapes:
 *
 *   GET  /authorize          the approval page: sends the browser straight on
 *                            to the redirect address with a one-time code
 *   POST /api/token          swaps a code or a refresh token for an access token
 *   GET  /v1/me              the account's display name
 *   GET  /v1/me/player       what is playing
 *   GET  /v1/artists/<id>    an artist's genres
 *   GET  /art/<n>-<px>.svg   made-up album covers (with CORS, so the TV can
 *                            read their colors as it reads Spotify's)
 *
 * and stands in for ReccoBeats (pi/vibe.js) on the same address:
 *
 *   GET  /v1/audio-features?ids=<track id>   tempo, energy, mood... per song
 *
 * Nothing here reaches the internet, and no real Spotify account is involved.
 *
 *   const mock = await require('./mock-spotify').start({ clientId, clientSecret });
 *   mock.url                 'http://127.0.0.1:PORT' (both the accounts and the API side)
 *   mock.set('paused')       playing | paused | idle | long | episode | advert |
 *                            down | ratelimit | forbidden | revoked
 *   mock.next()              the next song
 *   mock.seek(ms)            jump inside the song
 *   mock.reset()             back to the first song, playing, at 1:02
 *   mock.vibes(mode, delayMs)   the ReccoBeats stand-in: ok | empty | garbage |
 *                            slow (never answers) | ratelimit | down; delayMs
 *                            holds each answer back (the preview uses 1.2 s)
 *   mock.calls               { token, player, me, authorize, features, artists } counters
 *   mock.close()
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const MODES = ['playing', 'paused', 'idle', 'long', 'episode', 'advert', 'down', 'ratelimit', 'forbidden', 'revoked'];

// Made-up songs. The second has long Spanish text with accents and ñ, to
// check that nothing clips or runs out of its box. Each has its own vibe for
// the visualizer: f is what the ReccoBeats stand-in answers (null: it does
// not know the song), genres what Spotify says of the first artist (null:
// the artist call fails).
const SONGS = [
  { id: 'mock0001', name: 'Golden Hour Drive', artists: ['The Lanterns'], album: 'Slow Coast', ms: 214000, art: 0,
    f: { tempo: 124.0, energy: 0.78, valence: 0.82, danceability: 0.84, acousticness: 0.08 }, genres: ['indie pop', 'nu disco'] },
  { id: 'mock0002', name: 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)',
    artists: ['Los Ángeles del Sur', 'María José Peñalosa', 'Ñengo Ávila'],
    album: 'Corazón, raíz y añoranza: edición de aniversario', ms: 288000, art: 1, explicit: true,
    f: { tempo: 72.0, energy: 0.26, valence: 0.74, danceability: 0.42, acousticness: 0.88 }, genres: ['latin folk', 'bolero'] },
  { id: 'mock0003', name: 'Paper Moons', artists: ['Juniper & the Tide'], album: 'Night Garden', ms: 187000, art: 2,
    f: { tempo: 76.0, energy: 0.3, valence: 0.16, danceability: 0.38, acousticness: 0.52 }, genres: ['dream pop', 'slowcore'] },
  { id: 'mock0004', name: 'Él', artists: ['Zoé'], album: 'Ámbar', ms: 201000, art: 3,
    f: { tempo: 172.0, energy: 0.94, valence: 0.2, danceability: 0.48, acousticness: 0.02 }, genres: ['rock en espanol', 'alternative metal'] },
  { id: 'mock0005', name: 'Linen & Light', artists: ['Maren Holt'], album: 'Kitchen Window', ms: 196000, art: 5,
    f: { tempo: 70.0, energy: 0.22, valence: 0.78, danceability: 0.4, acousticness: 0.9 }, genres: ['folk', 'singer-songwriter'] },
  { id: 'mock0006', name: 'Harbor Lights', artists: ['Ostara Bay'], album: 'Low Tide', ms: 233000, art: 6,
    f: null, genres: ['indie folk', 'chamber pop'] },
  { id: 'mock0007', name: 'Untitled Demo 3', artists: ['Basement Tapes Collective'], album: 'Demos', ms: 158000, art: 7,
    f: null, genres: null }
];
const VIBE_MODES = ['ok', 'empty', 'garbage', 'slow', 'ratelimit', 'down'];
const EPISODE = { id: 'mockep01', name: 'Episode 212: Why octopuses dream', show: 'The Curious Hour', publisher: 'Fieldnote Radio', ms: 2892000, art: 4 };

/* ---------- covers ---------- */

const COVERS = [
  // A low sun over a road.
  (s) => '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a5a"/><stop offset=".55" stop-color="#e2466f"/><stop offset="1" stop-color="#3a1c5c"/></linearGradient></defs>' +
    '<rect width="640" height="640" fill="url(#g)"/><circle cx="320" cy="360" r="150" fill="#ffd27a"/>' +
    '<rect y="400" width="640" height="240" fill="#24123d"/><path d="M250 640L305 400h30l55 240z" fill="#3b2260"/>' +
    '<path d="M316 640l2-60h4l2 60zM317 540l1-40h4l1 40zM318 470l1-30h2l1 30z" fill="#ffd27a"/>',
  // Warm paper shapes.
  (s) => '<rect width="640" height="640" fill="#e8d5b5"/><circle cx="210" cy="250" r="170" fill="#c8553d"/>' +
    '<path d="M0 420Q160 330 320 420T640 400V640H0z" fill="#2f5d50"/><path d="M0 500Q180 430 340 500T640 480V640H0z" fill="#1d3b34"/>' +
    '<circle cx="470" cy="170" r="54" fill="#f2b441"/>',
  // A night garden.
  (s) => '<defs><radialGradient id="g" cx=".7" cy=".25" r=".9"><stop offset="0" stop-color="#3d5a80"/><stop offset="1" stop-color="#0b132b"/></radialGradient></defs>' +
    '<rect width="640" height="640" fill="url(#g)"/><circle cx="450" cy="170" r="70" fill="#f1f5f9"/><circle cx="478" cy="150" r="62" fill="#3d5a80"/>' +
    '<path d="M120 640C120 470 200 400 190 300M260 640C260 500 330 450 340 360M420 640C430 520 500 480 520 420" stroke="#5fbf8f" stroke-width="10" fill="none" stroke-linecap="round"/>' +
    '<circle cx="190" cy="290" r="26" fill="#e07a9b"/><circle cx="340" cy="350" r="22" fill="#f2c14e"/><circle cx="520" cy="410" r="24" fill="#e07a9b"/>',
  // Amber rings.
  (s) => '<rect width="640" height="640" fill="#1a1205"/><g fill="none" stroke="#ffb703" stroke-width="18">' +
    '<circle cx="320" cy="320" r="70"/><circle cx="320" cy="320" r="130" opacity=".75"/><circle cx="320" cy="320" r="190" opacity=".5"/><circle cx="320" cy="320" r="250" opacity=".3"/></g>' +
    '<circle cx="320" cy="320" r="26" fill="#fb8500"/>',
  // A podcast cover.
  (s) => '<rect width="640" height="640" fill="#0f4c5c"/><rect x="60" y="60" width="520" height="520" rx="40" fill="#e36414"/>' +
    '<circle cx="320" cy="300" r="120" fill="#0f4c5c"/><rect x="290" y="400" width="60" height="110" rx="20" fill="#0f4c5c"/>' +
    '<circle cx="320" cy="300" r="60" fill="#fb8b24"/>',
  // Morning linen.
  (s) => '<rect width="640" height="640" fill="#efe6d8"/><rect y="380" width="640" height="260" fill="#d9c7ad"/>' +
    '<circle cx="410" cy="250" r="120" fill="#f3b38a"/><path d="M90 640V300q60-40 120 0v340z" fill="#9db59a"/>' +
    '<path d="M150 300v-80" stroke="#6f8f6c" stroke-width="8"/><circle cx="150" cy="210" r="22" fill="#e9a1a0"/>',
  // A harbor at night.
  (s) => '<rect width="640" height="640" fill="#0e3b46"/><rect y="400" width="640" height="240" fill="#082a33"/>' +
    '<g fill="#ffb15e"><circle cx="120" cy="380" r="9"/><circle cx="210" cy="372" r="7"/><circle cx="360" cy="385" r="10"/><circle cx="500" cy="376" r="8"/></g>' +
    '<g stroke="#ffb15e" stroke-width="4" opacity=".55"><path d="M120 420v60M210 410v40M360 425v70M500 415v50"/></g>' +
    '<circle cx="470" cy="150" r="46" fill="#cfe3e0"/>',
  // A grey demo sleeve.
  (s) => '<rect width="640" height="640" fill="#3a3c40"/><rect x="80" y="80" width="480" height="480" fill="#4a4d52"/>' +
    '<path d="M150 360q80-120 160-10t170-40" stroke="#c8c9cc" stroke-width="10" fill="none" stroke-linecap="round"/>' +
    '<text x="150" y="480" font-family="monospace" font-size="44" fill="#c8c9cc">DEMO 3</text>'
];

function cover(n, px) {
  const f = COVERS[n % COVERS.length];
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" width="' + px + '" height="' + px + '">' + f(px) + '</svg>';
}

/* ---------- the server ---------- */

function start(options) {
  const o = options || {};
  const clientId = o.clientId || 'mockclientid0123456789abcdef0123';
  const clientSecret = o.clientSecret || 'mocksecret0123456789abcdef012345';
  const expiresIn = o.expiresIn || 3600;
  const calls = { token: 0, player: 0, me: 0, authorize: 0, refreshes: 0, features: 0, artists: 0 };
  let vibeMode = VIBE_MODES.indexOf(o.vibeMode) >= 0 ? o.vibeMode : 'ok';
  let vibeDelay = o.vibeDelayMs || 0;
  const codes = new Map();      // code -> redirect_uri
  let refresh = '';
  let accessTokens = new Set();
  let mode = MODES.indexOf(o.mode) >= 0 ? o.mode : 'playing';
  let song = 0;
  let offsetMs = typeof o.progressMs === 'number' ? o.progressMs : 62000;   // where the song was at startedAt
  let startedAt = Date.now();
  let base = '';

  function progress() {
    const item = current();
    if (!item) return 0;
    const moving = mode === 'playing' || mode === 'long' || mode === 'episode';
    let p = offsetMs + (moving ? Date.now() - startedAt : 0);
    if (p >= item.ms) {
      // The song ended: the next one starts, as on a playlist.
      if (mode === 'playing') { song = (song + 1) % SONGS.length; if (song === 1) song = 2; }
      offsetMs = 0;
      startedAt = Date.now();
      p = 0;
    }
    return p;
  }

  function current() {
    if (mode === 'episode') return EPISODE;
    if (mode === 'long') return SONGS[1];
    return SONGS[song];
  }

  function images(n) {
    return [640, 300, 64].map((px) => ({ url: base + '/art/' + n + '-' + px + '.svg', width: px, height: px }));
  }

  function playerBody() {
    const p = progress();
    const item = current();
    const out = {
      device: { id: 'mockdevice', name: mode === 'episode' ? 'Kitchen speaker' : 'Living room', type: 'Speaker', is_active: true, volume_percent: 48 },
      shuffle_state: mode === 'long', repeat_state: 'off', timestamp: Date.now(),
      progress_ms: p, is_playing: mode !== 'paused', currently_playing_type: 'track', item: null
    };
    if (mode === 'advert') { out.currently_playing_type = 'ad'; return out; }
    if (item === EPISODE) {
      out.currently_playing_type = 'episode';
      out.item = {
        id: item.id, type: 'episode', name: item.name, duration_ms: item.ms, explicit: false, images: images(item.art),
        show: { name: item.show, publisher: item.publisher, images: images(item.art) }
      };
      return out;
    }
    out.item = {
      id: item.id, type: 'track', name: item.name, duration_ms: item.ms, explicit: item.explicit === true,
      artists: item.artists.map((a, i) => ({ name: a, id: 'artist' + item.id.slice(4) + 'n' + i })), album: { name: item.album, images: images(item.art) }
    };
    return out;
  }

  function json(res, status, body, extra) {
    const text = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }, extra || {}));
    res.end(text);
  }

  function bearerOk(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && accessTokens.has(m[1]);
  }

  function newAccess() {
    const t = 'mock-access-' + crypto.randomBytes(8).toString('hex');
    accessTokens.add(t);
    return t;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock.local');
    if (u.pathname === '/authorize') {
      calls.authorize += 1;
      const redirect = u.searchParams.get('redirect_uri') || '';
      if (u.searchParams.get('client_id') !== clientId || !redirect) { res.writeHead(400); return res.end('INVALID_CLIENT'); }
      const to = new URL(redirect);
      if (u.searchParams.get('deny') === '1') {
        to.searchParams.set('error', 'access_denied');
      } else {
        const code = 'mock-code-' + crypto.randomBytes(12).toString('hex');
        codes.set(code, redirect);
        to.searchParams.set('code', code);
      }
      to.searchParams.set('state', u.searchParams.get('state') || '');
      res.writeHead(302, { Location: to.toString() });
      return res.end();
    }
    if (u.pathname === '/api/token' && req.method === 'POST') {
      calls.token += 1;
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        const want = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
        if (req.headers.authorization !== want) return json(res, 400, { error: 'invalid_client', error_description: 'Invalid client' });
        const f = new URLSearchParams(text);
        if (f.get('grant_type') === 'authorization_code') {
          const code = f.get('code');
          if (!codes.has(code) || codes.get(code) !== f.get('redirect_uri')) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
          }
          codes.delete(code);    // a code works once
          refresh = 'mock-refresh-' + crypto.randomBytes(12).toString('hex');
          return json(res, 200, { access_token: newAccess(), token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh, scope: f.get('scope') || '' });
        }
        if (f.get('grant_type') === 'refresh_token') {
          calls.refreshes += 1;
          if (mode === 'revoked' || !refresh || f.get('refresh_token') !== refresh) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
          }
          return json(res, 200, { access_token: newAccess(), token_type: 'Bearer', expires_in: expiresIn });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      });
      return undefined;
    }
    if (u.pathname === '/v1/audio-features') return features(u, res);
    if (u.pathname.indexOf('/art/') === 0) {
      const m = /^\/art\/(\d+)-(\d+)\.svg$/.exec(u.pathname);
      if (!m) { res.writeHead(404); return res.end(); }
      const svg = cover(Number(m[1]), Number(m[2]));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
      return res.end(svg);
    }
    const artist = /^\/v1\/artists\/([A-Za-z0-9]+)$/.exec(u.pathname);
    if (artist) {
      if (!bearerOk(req)) return json(res, 401, { error: { status: 401, message: 'The access token expired' } });
      calls.artists += 1;
      const song = SONGS.filter((x) => artist[1].indexOf('artist' + x.id.slice(4) + 'n') === 0)[0];
      if (!song || !song.genres) return json(res, 404, { error: { status: 404, message: 'Not found.' } });
      return json(res, 200, { id: artist[1], type: 'artist', name: song.artists[0], genres: song.genres });
    }
    if (u.pathname === '/v1/me' || u.pathname === '/v1/me/player') {
      if (!bearerOk(req)) return json(res, 401, { error: { status: 401, message: 'The access token expired' } });
      if (u.pathname === '/v1/me') {
        calls.me += 1;
        return json(res, 200, { display_name: 'Mock Listener', id: 'mocklistener' });
      }
      calls.player += 1;
      if (mode === 'down') return json(res, 503, { error: { status: 503, message: 'Service unavailable' } });
      if (mode === 'ratelimit') return json(res, 429, { error: { status: 429, message: 'API rate limit exceeded' } }, { 'Retry-After': '2' });
      if (mode === 'forbidden') return json(res, 403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } });
      if (mode === 'idle') { res.writeHead(204); return res.end(); }
      return json(res, 200, playerBody());
    }
    res.writeHead(404);
    return res.end();
  });

  // The ReccoBeats stand-in, in its own reply shape.
  function features(u, res) {
    calls.features += 1;
    const id = u.searchParams.get('ids') || '';
    const answer = () => {
      if (vibeMode === 'slow') return;            // never answers: the Pi must give up by itself
      if (vibeMode === 'ratelimit') return json(res, 429, { error: 'Too Many Requests' }, { 'Retry-After': '2' });
      if (vibeMode === 'down') return json(res, 500, { error: 'Internal Server Error' });
      if (vibeMode === 'garbage') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>oops</html>');
      }
      const song = SONGS.filter((x) => x.id === id)[0];
      if (vibeMode === 'empty' || !song || !song.f) return json(res, 200, { content: [] });
      return json(res, 200, { content: [Object.assign({
        id: 'rb-' + id, href: 'https://open.spotify.com/track/' + id, key: 5, mode: 1, loudness: -6.1,
        speechiness: 0.04, instrumentalness: 0, liveness: 0.12
      }, song.f)] });
    };
    if (vibeDelay) setTimeout(answer, vibeDelay); else answer();
    return undefined;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve({
        url: base,
        port: server.address().port,
        clientId: clientId,
        clientSecret: clientSecret,
        calls: calls,
        modes: MODES,
        mode: () => mode,
        set: (m) => {
          if (MODES.indexOf(m) < 0) return false;
          // Keep the song where it is when only pausing or resuming.
          offsetMs = progress();
          startedAt = Date.now();
          if ((m === 'long' || m === 'episode') && m !== mode) offsetMs = m === 'episode' ? 1154000 : 97000;
          mode = m;
          return true;
        },
        next: () => { song = (song + 1) % SONGS.length; if (song === 1) song = 2; offsetMs = 0; startedAt = Date.now(); },
        seek: (ms) => { offsetMs = ms; startedAt = Date.now(); },
        reset: () => { mode = 'playing'; song = 0; offsetMs = 62000; startedAt = Date.now(); },
        // Jump to a song by its index in SONGS (the shots use it).
        play: (n) => { if (SONGS[n]) { mode = 'playing'; song = n; offsetMs = 30000; startedAt = Date.now(); } },
        vibes: (m, delayMs) => {
          if (VIBE_MODES.indexOf(m) < 0) return false;
          vibeMode = m;
          if (typeof delayMs === 'number') vibeDelay = delayMs;
          return true;
        },
        vibeModes: VIBE_MODES,
        expireAccess: () => { accessTokens = new Set(); },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

module.exports = { start: start, MODES: MODES, SONGS: SONGS, EPISODE: EPISODE, VIBE_MODES: VIBE_MODES };
