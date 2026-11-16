/*
 * Tests for the Spotify part of the Home Hub live server. Run from the repo
 * root with:
 *
 *   node pi/spotify-test.js
 *
 * It starts the server on a free port with a throwaway data folder and a
 * stand-in for Spotify (dev/mock-spotify.js) on this machine. Nothing here
 * reaches the internet or a real Spotify account. Uses only what ships with
 * Node. Prints one line per check, then "N passed, 0 failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const hubServer = require('./server');
const spotify = require('./spotify');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const mockSpotify = require('../dev/mock-spotify');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const CLIENT_ID = 'testclientid0123456789abcdef0123';
const CLIENT_SECRET = 'testsecretDONOTLEAK0123456789abc';
const REDIRECT = 'http://127.0.0.1:8097/spotify/callback';
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spotify-'));
  tmpDirs.push(d);
  return d;
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, p, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    const body = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const api = (h, method, p, body) => request(h.port, method, p, { token: TOKEN, body: body });

// Opens the sign-in link the way a browser would and returns the address
// Spotify sends it to (the mock answers with a redirect straight away).
function approve(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { res.resume(); resolve(res.headers.location || ''); }).on('error', reject);
  });
}

async function main() {
  const mock = await mockSpotify.start({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const ENV = { SPOTIFY_CLIENT_ID: CLIENT_ID, SPOTIFY_CLIENT_SECRET: CLIENT_SECRET, SPOTIFY_REDIRECT_URI: REDIRECT };
  const logs = [];

  async function start(extra) {
    const o = Object.assign({
      token: TOKEN, port: 0, host: '127.0.0.1', dataDir: tmpDir(), log: (s) => logs.push(s),
      spotifyEnv: ENV, spotify: { accounts: mock.url, api: mock.url, allowHttp: true, manual: true }
    }, extra || {});
    const h = hubServer.start(o);
    await h.ready;
    h.dir = path.resolve(__dirname, o.dataDir);
    return h;
  }
  const stop = (h) => new Promise((r) => h.close(r));
  const now = async (h) => (await request(h.port, 'GET', '/live/state')).json.resources.nowplaying;

  async function signIn(h) {
    const l = await api(h, 'POST', '/api/spotify/login', {});
    assert.strictEqual(l.status, 200, l.text);
    const landed = await approve(l.json.url);
    const r = await api(h, 'POST', '/api/spotify/code', { input: landed });
    assert.strictEqual(r.status, 200, r.text);
    return { link: l.json, landed: landed, reply: r.json };
  }

  /* ---------- pure pieces ---------- */

  await check('settings: both values needed, shape checked, redirect must be 127.0.0.1 or https', () => {
    assert.deepStrictEqual(spotify.configFromEnv({}, 8097), { configured: false, problem: '', redirectUri: REDIRECT });
    assert.ok(/SECRET is missing/.test(spotify.configFromEnv({ SPOTIFY_CLIENT_ID: CLIENT_ID }).problem));
    assert.ok(/CLIENT_ID is missing/.test(spotify.configFromEnv({ SPOTIFY_CLIENT_SECRET: CLIENT_SECRET }).problem));
    assert.ok(/does not look right/.test(spotify.configFromEnv({ SPOTIFY_CLIENT_ID: 'paste here', SPOTIFY_CLIENT_SECRET: CLIENT_SECRET }).problem));
    const ok = spotify.configFromEnv({ SPOTIFY_CLIENT_ID: ' ' + CLIENT_ID + ' ', SPOTIFY_CLIENT_SECRET: CLIENT_SECRET }, 8123);
    assert.strictEqual(ok.configured, true);
    assert.strictEqual(ok.clientId, CLIENT_ID);
    assert.strictEqual(ok.redirectUri, 'http://127.0.0.1:8123/spotify/callback');
    const lan = spotify.configFromEnv(Object.assign({}, ENV, { SPOTIFY_REDIRECT_URI: 'http://192.168.1.219:8097/spotify/callback' }));
    assert.strictEqual(lan.configured, false);
    assert.ok(/127\.0\.0\.1/.test(lan.problem));
    assert.strictEqual(spotify.configFromEnv(Object.assign({}, ENV, { SPOTIFY_REDIRECT_URI: 'https://example.org/cb' })).configured, true);
  });

  await check('reading Spotify\'s answer: a song, joined artists, three picture sizes', () => {
    const p = spotify.readPlayback({
      is_playing: true, progress_ms: 61234.4, shuffle_state: true, repeat_state: 'context',
      device: { name: 'Living room', type: 'Speaker' },
      item: {
        id: 'abc', type: 'track', name: 'Canción  de\nprueba', duration_ms: 200000, explicit: true,
        artists: [{ name: 'Ñengo' }, { name: 'María José' }, {}],
        album: { name: 'Añoranza', images: [{ url: 'https://i.scdn.co/image/small', width: 64 }, { url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/mid', width: 300 }] }
      }
    });
    assert.deepStrictEqual(p, {
      track: {
        id: 'abc', kind: 'track', title: 'Canción  de prueba', artist: 'Ñengo, María José', album: 'Añoranza',
        art: 'https://i.scdn.co/image/big', artSmall: 'https://i.scdn.co/image/mid', artTiny: 'https://i.scdn.co/image/small',
        durationMs: 200000, explicit: true
      },
      playing: true, progressMs: 61234, device: { name: 'Living room', type: 'Speaker' }, shuffle: true, repeat: 'context'
    });
  });

  await check('reading Spotify\'s answer: a podcast episode, an advert, junk', () => {
    const ep = spotify.readPlayback({
      is_playing: false, progress_ms: 5, currently_playing_type: 'episode',
      item: { id: 'e1', type: 'episode', name: 'Episode 1', duration_ms: 1000, show: { name: 'The Show', images: [{ url: 'https://i.scdn.co/image/show', width: 640 }] } }
    });
    assert.strictEqual(ep.track.kind, 'episode');
    assert.strictEqual(ep.track.artist, 'The Show');
    assert.strictEqual(ep.track.art, 'https://i.scdn.co/image/show');
    assert.strictEqual(ep.playing, false);
    assert.strictEqual(spotify.readPlayback({ is_playing: true, currently_playing_type: 'ad', item: null }).track, null);
    assert.deepStrictEqual(spotify.readPlayback(null), { track: null, playing: false, progressMs: 0, device: null, shuffle: false, repeat: 'off' });
    // A picture address that is not https never reaches the TV.
    const bad = spotify.readPlayback({ item: { id: 'x', name: 'X', album: { images: [{ url: 'javascript:alert(1)', width: 640 }, { url: 'http://plain.example/a.jpg', width: 300 }] } } });
    assert.strictEqual(bad.track.art, '');
  });

  await check('stored data is rebuilt from known fields only', () => {
    const d = spotify.cleanData({
      configured: true, signedIn: true, state: 'playing', problem: 'x'.repeat(500), secret: 'nope', accessToken: 'nope',
      track: { id: 'a', title: 'T', artist: 'A', album: 'B', art: 'https://i.scdn.co/a', artSmall: 'ftp://x', durationMs: 1000, extra: 1 },
      progressMs: 5000, at: 12, device: { name: 'Den', type: 'TV', id: 'secret-device-id' }, shuffle: 'yes', repeat: 'weird', playedAt: 12
    });
    assert.strictEqual(d.secret, undefined);
    assert.strictEqual(d.accessToken, undefined);
    assert.strictEqual(d.problem.length, 160);
    assert.deepStrictEqual(Object.keys(d.track).sort(), ['album', 'art', 'artSmall', 'artTiny', 'artist', 'durationMs', 'explicit', 'id', 'kind', 'title']);
    assert.strictEqual(d.track.artSmall, '');
    assert.strictEqual(d.progressMs, 1000);                // never past the end of the song
    assert.deepStrictEqual(d.device, { name: 'Den', type: 'TV' });
    assert.strictEqual(d.shuffle, false);
    assert.strictEqual(d.repeat, 'off');
    assert.strictEqual(spotify.cleanData({ state: 'playing' }).state, 'idle');   // playing needs a song
    assert.deepStrictEqual(spotify.cleanData('junk'), spotify.offData());
    assert.deepStrictEqual(spotify.cleanResource(null), { rev: 0, data: spotify.offData() });
  });

  /* ---------- not set up, not signed in ---------- */

  await check('nothing in .env: the resource says off, the control API says how to set it up', async () => {
    const h = await start({ spotifyEnv: {} });
    const r = await now(h);
    assert.strictEqual(r.data.state, 'off');
    assert.strictEqual(r.data.configured, false);
    const s = await api(h, 'GET', '/api/spotify');
    assert.strictEqual(s.json.spotify.configured, false);
    const l = await api(h, 'POST', '/api/spotify/login', {});
    assert.strictEqual(l.status, 400);
    assert.ok(/SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET/.test(l.json.error), l.json.error);
    assert.ok(/not set up yet/.test(hubctl.spotifyStatusLines(s.json.spotify)[0]));
    assert.strictEqual(h._debug().spotify.timer, false);
    await stop(h);
  });

  await check('a mistyped setting is named, never echoed', async () => {
    const h = await start({ spotifyEnv: { SPOTIFY_CLIENT_ID: CLIENT_ID, SPOTIFY_CLIENT_SECRET: 'oops spaces here' } });
    const s = (await api(h, 'GET', '/api/spotify')).json.spotify;
    assert.strictEqual(s.configured, false);
    assert.ok(/SPOTIFY_CLIENT_SECRET does not look right/.test(s.problem));
    assert.ok(JSON.stringify(s).indexOf('oops') < 0);
    await stop(h);
  });

  await check('Spotify calls need the hub token', async () => {
    const h = await start();
    assert.strictEqual((await request(h.port, 'GET', '/api/spotify')).status, 401);
    assert.strictEqual((await request(h.port, 'POST', '/api/spotify/login', { body: {} })).status, 401);
    assert.strictEqual((await request(h.port, 'POST', '/api/spotify/code', { body: { input: 'x' } })).status, 401);
    assert.strictEqual((await api(h, 'GET', '/api/spotify/login')).status, 405);
    await stop(h);
  });

  await check('set up but not signed in: the resource says signin and nothing is asked of Spotify', async () => {
    const before = mock.calls.player + mock.calls.token;
    const h = await start();
    const r = await now(h);
    assert.strictEqual(r.data.state, 'signin');
    assert.strictEqual(r.data.configured, true);
    assert.strictEqual(r.data.signedIn, false);
    await h.spotify.poll();
    assert.strictEqual(mock.calls.player + mock.calls.token, before);
    assert.ok(/not signed in/.test(hubctl.spotifyStatusLines((await api(h, 'GET', '/api/spotify')).json.spotify)[0]));
    await stop(h);
  });

  /* ---------- signing in ---------- */

  let dirSigned;
  await check('sign-in: link, approval, pasted address; the song reaches the resource', async () => {
    mock.reset();
    const h = await start();
    dirSigned = h.dir;
    const s = await signIn(h);
    const u = new URL(s.link.url);
    assert.strictEqual(u.origin, mock.url);
    assert.strictEqual(u.searchParams.get('client_id'), CLIENT_ID);
    assert.strictEqual(u.searchParams.get('redirect_uri'), REDIRECT);
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.strictEqual(u.searchParams.get('scope'), spotify.SCOPES.join(' '));
    assert.ok(/^[0-9a-f]{32}$/.test(u.searchParams.get('state')));
    assert.ok(s.link.url.indexOf(CLIENT_SECRET) < 0);
    assert.strictEqual(s.reply.user, 'Mock Listener');
    assert.ok(/signed in as Mock Listener/.test(hubctl.spotifyCodeText(s.reply)));
    const r = await now(h);
    assert.strictEqual(r.data.state, 'playing');
    assert.strictEqual(r.data.signedIn, true);
    assert.strictEqual(r.data.track.title, 'Golden Hour Drive');
    assert.strictEqual(r.data.track.artist, 'The Lanterns');
    assert.strictEqual(r.data.track.album, 'Slow Coast');
    assert.strictEqual(r.data.track.durationMs, 214000);
    assert.ok(/\/art\/0-640\.svg$/.test(r.data.track.art));
    assert.ok(/\/art\/0-300\.svg$/.test(r.data.track.artSmall));
    assert.ok(/\/art\/0-64\.svg$/.test(r.data.track.artTiny));
    assert.deepStrictEqual(r.data.device, { name: 'Living room', type: 'Speaker' });
    assert.ok(r.data.progressMs >= 62000 && r.data.progressMs < 70000, String(r.data.progressMs));
    assert.ok(Math.abs(r.data.at - Date.now()) < 5000);
    const lines = hubctl.spotifyStatusLines((await api(h, 'GET', '/api/spotify')).json.spotify);
    assert.strictEqual(lines[0], 'Spotify: signed in as Mock Listener.');
    assert.strictEqual(lines[1], 'Playing "Golden Hour Drive" by The Lanterns on Living room.');
    await stop(h);
  });

  await check('the sign-in is kept in the data folder, owner-only, and survives a restart', async () => {
    const file = path.join(dirSigned, 'spotify.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(/^mock-refresh-/.test(saved.refreshToken));
    assert.strictEqual(fs.statSync(file).mode & 0o077, 0, 'only the owner may read it');
    assert.ok(JSON.stringify(saved).indexOf(CLIENT_SECRET) < 0);
    const state = fs.readFileSync(path.join(dirSigned, 'state.json'), 'utf8');
    assert.ok(state.indexOf('mock-refresh-') < 0 && state.indexOf('mock-access-') < 0 && state.indexOf(CLIENT_SECRET) < 0);
    mock.next();
    const h = await start({ dataDir: dirSigned });
    assert.strictEqual(h._debug().spotify.signedIn, true);
    await h.spotify.poll();
    assert.strictEqual((await now(h)).data.track.title, 'Paper Moons');
    await stop(h);
  });

  await check('sign-in problems each get plain words: old link, wrong state, used code, declined, junk', async () => {
    const h = await start();
    const code = (input) => api(h, 'POST', '/api/spotify/code', { input: input });
    let r = await code(REDIRECT + '?code=abc&state=def');
    assert.strictEqual(r.status, 400);
    assert.ok(/Run \.\/hub spotify login again/.test(r.json.error), r.json.error);
    const l = (await api(h, 'POST', '/api/spotify/login', {})).json;
    r = await code(REDIRECT + '?code=abc&state=00000000000000000000000000000000');
    assert.ok(/older sign-in link/.test(r.json.error), r.json.error);
    r = await code(REDIRECT + '?code=abc');
    assert.ok(/missing its "state" part/.test(r.json.error), r.json.error);
    r = await code('hello there');
    assert.ok(/does not look like the address/.test(r.json.error), r.json.error);
    r = await code('');
    assert.strictEqual(r.status, 400);
    r = await api(h, 'POST', '/api/spotify/code', { nope: 1 });
    assert.strictEqual(r.status, 400);
    const denied = await approve(l.url + '&deny=1');
    r = await code(denied);
    assert.ok(/declined/.test(r.json.error), r.json.error);
    const landed = await approve(l.url);
    assert.strictEqual((await code('  "' + landed + '"  ')).status, 200);       // quotes and spaces around a paste are fine
    r = await code(landed);
    assert.strictEqual(r.status, 400);                                          // the link is spent
    // A fresh link, but Spotify refuses the code (used already).
    const l2 = (await api(h, 'POST', '/api/spotify/login', {})).json;
    const state2 = new URL(l2.url).searchParams.get('state');
    r = await code(REDIRECT + '?code=' + new URL(landed).searchParams.get('code') + '&state=' + state2);
    assert.ok(/did not accept that code/.test(r.json.error), r.json.error);
    await stop(h);
  });

  await check('a wrong client secret is reported as that, without showing it', async () => {
    const h = await start({ spotifyEnv: Object.assign({}, ENV, { SPOTIFY_CLIENT_SECRET: 'wrongsecret0123456789abcdef01234' }) });
    const l = (await api(h, 'POST', '/api/spotify/login', {})).json;
    const r = await api(h, 'POST', '/api/spotify/code', { input: await approve(l.url) });
    assert.strictEqual(r.status, 400);
    assert.ok(/did not accept the client ID or secret/.test(r.json.error), r.json.error);
    assert.ok(r.text.indexOf('wrongsecret') < 0);
    await stop(h);
  });

  await check('the callback page finishes the sign-in when the browser can reach it', async () => {
    const h = await start();
    const l = (await api(h, 'POST', '/api/spotify/login', {})).json;
    const landed = new URL(await approve(l.url));
    const bad = await request(h.port, 'GET', '/spotify/callback?code=x&state=y');
    assert.strictEqual(bad.status, 400);
    assert.ok(/That did not work/.test(bad.text));
    const ok = await request(h.port, 'GET', '/spotify/callback' + landed.search);
    assert.strictEqual(ok.status, 200);
    assert.ok(/text\/html/.test(ok.headers['content-type']));
    assert.ok(/Spotify is connected/.test(ok.text) && /Mock Listener/.test(ok.text));
    assert.strictEqual((await now(h)).data.signedIn, true);
    // Not from a public address, and not on the side door.
    const h2 = await start({ clientAddress: () => '8.8.8.8' });
    assert.strictEqual((await request(h2.port, 'GET', '/spotify/callback?code=x&state=y')).status, 403);
    await stop(h2);
    await stop(h);
  });

  /* ---------- watching what plays ---------- */

  await check('a poll that finds the song where it should be pushes nothing; pause, seek, next and stop each push once', async () => {
    mock.reset();
    mock.seek(10000);
    const h = await start();
    await signIn(h);
    let r = await now(h);
    const rev0 = r.rev;
    await sleep(120);
    await h.spotify.poll();
    r = await now(h);
    assert.strictEqual(r.rev, rev0, 'no push for an on-time song');
    assert.ok(r.data.progressMs >= 10100, 'but the copy in memory moved on');

    mock.set('paused');
    await h.spotify.poll();
    r = await now(h);
    assert.strictEqual(r.rev, rev0 + 1);
    assert.strictEqual(r.data.state, 'paused');
    await h.spotify.poll();
    assert.strictEqual((await now(h)).rev, rev0 + 1, 'a paused song pushes nothing more');

    mock.set('playing');
    await h.spotify.poll();
    assert.strictEqual((await now(h)).rev, rev0 + 2);
    mock.seek(120000);
    await h.spotify.poll();
    r = await now(h);
    assert.strictEqual(r.rev, rev0 + 3);
    assert.ok(r.data.progressMs >= 120000 && r.data.progressMs < 125000);

    mock.next();
    await h.spotify.poll();
    r = await now(h);
    assert.strictEqual(r.rev, rev0 + 4);
    assert.strictEqual(r.data.track.title, 'Paper Moons');

    mock.set('idle');
    await h.spotify.poll();
    r = await now(h);
    assert.strictEqual(r.rev, rev0 + 5);
    assert.strictEqual(r.data.state, 'idle');
    assert.strictEqual(r.data.track.title, 'Paper Moons', 'the last song is kept for "Last played"');
    assert.strictEqual(r.data.device, null);
    assert.ok(r.data.playedAt > 0);
    await h.spotify.poll();
    assert.strictEqual((await now(h)).rev, rev0 + 5);
    const lines = hubctl.spotifyStatusLines((await api(h, 'GET', '/api/spotify')).json.spotify);
    assert.strictEqual(lines[1], 'Nothing is playing. Last played: "Paper Moons" by Juniper & the Tide.');
    await stop(h);
  });

  await check('long Spanish titles, a podcast and an advert all arrive whole', async () => {
    const h = await start();
    await signIn(h);
    mock.set('long');
    await h.spotify.poll();
    let d = (await now(h)).data;
    assert.strictEqual(d.track.title, 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)');
    assert.strictEqual(d.track.artist, 'Los Ángeles del Sur, María José Peñalosa, Ñengo Ávila');
    assert.strictEqual(d.track.album, 'Corazón, raíz y añoranza: edición de aniversario');
    assert.strictEqual(d.track.explicit, true);
    assert.strictEqual(d.shuffle, true);
    mock.set('episode');
    await h.spotify.poll();
    d = (await now(h)).data;
    assert.strictEqual(d.track.kind, 'episode');
    assert.strictEqual(d.track.artist, 'The Curious Hour');
    assert.strictEqual(d.device.name, 'Kitchen speaker');
    mock.set('advert');
    await h.spotify.poll();
    d = (await now(h)).data;
    assert.strictEqual(d.state, 'idle');
    assert.strictEqual(d.track.kind, 'episode');
    await stop(h);
  });

  await check('a screen on the push line gets the change', async () => {
    mock.reset();
    const h = await start();
    await signIn(h);
    const events = [];
    const req = http.get({ host: '127.0.0.1', port: h.port, path: '/live/events' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => events.push(c));
    });
    await sleep(80);
    mock.set('paused');
    await h.spotify.poll();
    await sleep(80);
    const text = events.join('');
    assert.ok(/event: change\ndata: \{"resource":"nowplaying"/.test(text), text.slice(0, 300));
    assert.ok(/"state":"paused"/.test(text));
    req.destroy();
    await stop(h);
  });

  await check('an access token that stopped working is renewed without anyone noticing', async () => {
    mock.reset();
    const h = await start();
    await signIn(h);
    const before = mock.calls.refreshes;
    mock.expireAccess();
    await h.spotify.poll();
    assert.strictEqual(mock.calls.refreshes, before + 1);
    assert.strictEqual((await now(h)).data.state, 'playing');
    await stop(h);
  });

  await check('Spotify down: the song stays, an error shows after three misses, and it recovers', async () => {
    mock.reset();
    const h = await start();
    await signIn(h);
    mock.set('down');
    await h.spotify.poll();
    await h.spotify.poll();
    assert.strictEqual((await now(h)).data.state, 'playing', 'two misses are not shown');
    await h.spotify.poll();
    let d = (await now(h)).data;
    assert.strictEqual(d.state, 'error');
    assert.strictEqual(d.problem, 'Spotify could not be reached');
    assert.strictEqual(d.track.title, 'Golden Hour Drive');
    assert.ok(h._debug().spotify.fails >= 3);
    mock.set('playing');
    await h.spotify.poll();
    d = (await now(h)).data;
    assert.strictEqual(d.state, 'playing');
    assert.strictEqual(d.problem, '');
    assert.strictEqual(h._debug().spotify.fails, 0);
    await stop(h);
  });

  await check('"slow down" from Spotify is obeyed, and a refusal is shown as one', async () => {
    mock.reset();
    const h = await start();
    await signIn(h);
    mock.set('ratelimit');
    await h.spotify.poll();
    const asked = mock.calls.player;
    mock.set('playing');
    await h.spotify.poll();
    assert.strictEqual(mock.calls.player, asked, 'no call during the wait');
    assert.ok(h._debug().spotify.delay >= 1000);
    await sleep(2100);
    await h.spotify.poll();
    assert.strictEqual(mock.calls.player, asked + 1);
    mock.set('forbidden');
    await h.spotify.poll();
    const d = (await now(h)).data;
    assert.strictEqual(d.state, 'error');
    assert.strictEqual(d.problem, 'Spotify refused the request');
    mock.set('playing');
    await stop(h);
  });

  await check('a sign-in Spotify no longer accepts: back to "signin", the saved file is removed', async () => {
    mock.reset();
    const h = await start();
    await signIn(h);
    const file = path.join(h.dir, 'spotify.json');
    assert.ok(fs.existsSync(file));
    mock.set('revoked');
    mock.expireAccess();
    await h.spotify.poll();
    const d = (await now(h)).data;
    assert.strictEqual(d.state, 'signin');
    assert.strictEqual(d.signedIn, false);
    assert.strictEqual(d.track.title, 'Golden Hour Drive');
    assert.ok(!fs.existsSync(file));
    mock.set('playing');
    await stop(h);
  });

  await check('logout forgets the sign-in; a second logout changes nothing', async () => {
    const h = await start();
    await signIn(h);
    let r = await api(h, 'POST', '/api/spotify/logout', {});
    assert.strictEqual(r.json.changed, true);
    assert.ok(/Signed out/.test(hubctl.spotifyLogoutText(r.json)));
    assert.ok(!fs.existsSync(path.join(h.dir, 'spotify.json')));
    assert.strictEqual((await now(h)).data.state, 'signin');
    r = await api(h, 'POST', '/api/spotify/logout', {});
    assert.strictEqual(r.json.changed, false);
    await stop(h);
  });

  await check('how often it asks: 5 s with a screen and a song, 10 s idle, a minute with no screen', async () => {
    mock.reset();
    const h = await start();
    await signIn(h);
    assert.strictEqual(h._debug().spotify.delay, 60000);
    const req = http.get({ host: '127.0.0.1', port: h.port, path: '/live/events' }, (res) => res.resume());
    await sleep(80);
    assert.strictEqual(h._debug().spotify.delay, 5000);
    mock.set('idle');
    await h.spotify.poll();
    assert.strictEqual(h._debug().spotify.delay, 10000);
    req.destroy();
    mock.set('playing');
    await stop(h);
  });

  await check('with its own timers: a screen connecting gets a fresh answer, and close stops the timer', async () => {
    mock.set('playing');
    const dir = tmpDir();
    const h1 = await start({ dataDir: dir });
    await signIn(h1);
    await stop(h1);
    const h = await start({ dataDir: dir, spotify: { accounts: mock.url, api: mock.url, allowHttp: true, playMs: 60, idleMs: 60, awayMs: 5000 } });
    await sleep(150);
    const asked = mock.calls.player;
    const req = http.get({ host: '127.0.0.1', port: h.port, path: '/live/events' }, (res) => res.resume());
    await sleep(400);
    assert.ok(mock.calls.player >= asked + 3, 'it asks often while a screen is on: ' + (mock.calls.player - asked));
    assert.strictEqual(h._debug().spotify.timer, true);
    req.destroy();
    await stop(h);
    const after = mock.calls.player;
    await sleep(200);
    assert.strictEqual(mock.calls.player, after, 'nothing is asked after close');
  });

  /* ---------- words and the mailbox ---------- */

  await check('./hub words: login steps, status lines, an older server', () => {
    const lines = hubctl.spotifyLoginLines({ url: 'https://accounts.spotify.com/authorize?x=1', redirectUri: REDIRECT, minutes: 15 });
    assert.ok(lines.indexOf('https://accounts.spotify.com/authorize?x=1') >= 0, 'the link is on a line of its own');
    assert.ok(lines.some((l) => l.indexOf(REDIRECT + '?code=') >= 0));
    assert.ok(/does not know Spotify yet/.test(hubctl.spotifyStatusLines(undefined)[0]));
    assert.deepStrictEqual(hubctl.spotifyStatusLines({ configured: true, signedIn: true, user: '', state: 'paused', track: { title: 'Él', artist: 'Zoé' }, device: 'Den' }),
      ['Spotify: signed in.', 'Paused: "Él" by Zoé on Den.']);
    assert.deepStrictEqual(hubctl.spotifyStatusLines({ configured: true, signedIn: true, user: 'Ian', state: 'idle', track: null }),
      ['Spotify: signed in as Ian.', 'Nothing is playing.']);
    const st = hubctl.statusLines({ uptime: 100, server: '0.1.0', rev: 3, screens: [], spotify: { configured: true, signedIn: true, state: 'playing', track: { title: 'Él' } } });
    assert.ok(st.indexOf('Spotify: playing "Él".') >= 0, st.join('|'));
    assert.ok(hubctl.WIDGETS.indexOf('nowplaying') >= 0);
  });

  await check('mailbox: spotify.status, spotify.login, spotify.code and spotify.logout exist and check their args', async () => {
    const C = mailbox.COMMANDS;
    ['spotify.status', 'spotify.login', 'spotify.code', 'spotify.logout'].forEach((k) => assert.ok(C[k], k));
    assert.deepStrictEqual(Object.keys(C['spotify.code'].args), ['address']);
    assert.strictEqual(C['spotify.code'].args.address[1], true);
    const h = await start();
    const call = async (method, route, body) => {
      const r = await h.api(method, route, body);
      if (!r.body.ok) { const e = new Error(r.body.error); e.serverSaidNo = true; throw e; }
      return r.body;
    };
    const login = await C['spotify.login'].run({}, { call: call });
    assert.ok(login.data.url.indexOf(mock.url + '/authorize?') === 0);
    assert.ok(login.message.indexOf(login.data.url) >= 0);
    const done = await C['spotify.code'].run({ address: await approve(login.data.url) }, { call: call });
    assert.ok(/Spotify is connected/.test(done.message));
    const st = await C['spotify.status'].run({}, { call: call });
    assert.ok(/signed in as Mock Listener/.test(st.message));
    assert.ok(JSON.stringify(st.data).indexOf('mock-') < 0, 'no token in the mailbox answer');
    const out = await C['spotify.logout'].run({}, { call: call });
    assert.strictEqual(out.data.changed, true);
    await stop(h);
  });

  await check('the secret, the tokens and the codes are never logged or sent to a screen', async () => {
    const h = await start();
    const s = await signIn(h);
    const code = new URL(s.landed).searchParams.get('code');
    const state = await request(h.port, 'GET', '/live/state');
    const status = await api(h, 'GET', '/api/status');
    await stop(h);
    const all = logs.join('\n') + state.text + status.text;
    assert.ok(logs.some((l) => /Spotify: signed in as Mock Listener/.test(l)));
    [CLIENT_SECRET, 'mock-refresh-', 'mock-access-', code, 'mock-code-'].forEach((bad) => {
      assert.ok(all.indexOf(bad) < 0, 'found ' + bad.slice(0, 12));
    });
    assert.ok(state.text.indexOf(CLIENT_ID) < 0, 'the screen does not get the client ID either');
  });

  await mock.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
