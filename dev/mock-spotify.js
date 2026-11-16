/*
 * A stand-in for Spotify, for tests and the preview. It answers the three
 * things pi/spotify.js uses, in Spotify's own shapes:
 *
 *   GET  /authorize          the approval page: sends the browser straight on
 *                            to the redirect address with a one-time code
 *   POST /api/token          swaps a code or a refresh token for an access token
 *   GET  /v1/me              the account's display name
 *   GET  /v1/me/player       what is playing
 *   GET  /art/<n>-<px>.svg   made-up album covers
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
 *   mock.calls               { token, player, me, authorize } counters
 *   mock.close()
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const MODES = ['playing', 'paused', 'idle', 'long', 'episode', 'advert', 'down', 'ratelimit', 'forbidden', 'revoked'];

// Made-up songs. The second has long Spanish text with accents and ñ, to
// check that nothing clips or runs out of its box.
const SONGS = [
  { id: 'mock0001', name: 'Golden Hour Drive', artists: ['The Lanterns'], album: 'Slow Coast', ms: 214000, art: 0 },
  { id: 'mock0002', name: 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)',
    artists: ['Los Ángeles del Sur', 'María José Peñalosa', 'Ñengo Ávila'],
    album: 'Corazón, raíz y añoranza: edición de aniversario', ms: 288000, art: 1, explicit: true },
  { id: 'mock0003', name: 'Paper Moons', artists: ['Juniper & the Tide'], album: 'Night Garden', ms: 187000, art: 2 },
  { id: 'mock0004', name: 'Él', artists: ['Zoé'], album: 'Ámbar', ms: 201000, art: 3 }
];
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
    '<circle cx="320" cy="300" r="60" fill="#fb8b24"/>'
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
  const calls = { token: 0, player: 0, me: 0, authorize: 0, refreshes: 0 };
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
      artists: item.artists.map((a) => ({ name: a })), album: { name: item.album, images: images(item.art) }
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
    if (u.pathname.indexOf('/art/') === 0) {
      const m = /^\/art\/(\d+)-(\d+)\.svg$/.exec(u.pathname);
      if (!m) { res.writeHead(404); return res.end(); }
      const svg = cover(Number(m[1]), Number(m[2]));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'max-age=3600' });
      return res.end(svg);
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
        expireAccess: () => { accessTokens = new Set(); },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

module.exports = { start: start, MODES: MODES, SONGS: SONGS, EPISODE: EPISODE };
