/*
 * Tests for the song "vibe" (pi/vibe.js) and how the Spotify player sends it
 * to the TV. Run from the repo root with:
 *
 *   node pi/vibe-test.js
 *
 * A stand-in for ReccoBeats runs on this machine (and dev/mock-spotify.js for
 * Spotify); nothing reaches the internet. Uses only what ships with Node.
 * Prints one line per check, then "N passed, 0 failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const vibe = require('./vibe');
const spotify = require('./spotify');
const hubServer = require('./server');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const mockSpotify = require('../dev/mock-spotify');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
let passed = 0;
let failed = 0;
const tmpDirs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vibe-'));
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

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(15);
  }
  throw new Error(text);
}

/* ---------- a stand-in for ReccoBeats ---------- */

// answer(id, req, res) decides each reply; requests are kept for checking.
function standIn() {
  const s = { requests: [], answer: null };
  s.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    s.requests.push({ path: u.pathname, query: u.search, headers: req.headers });
    const id = u.searchParams.get('ids');
    if (s.answer) return s.answer(id, req, res);
    res.writeHead(404);
    return res.end();
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => {
    s.url = 'http://127.0.0.1:' + s.server.address().port;
    resolve(s);
  }));
}

function json(res, status, body, extra) {
  const t = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extra || {}));
  res.end(t);
}

const FEATURES = (id, extra) => ({ content: [Object.assign({
  id: 'rb1', href: 'https://open.spotify.com/track/' + id, acousticness: 0.1, danceability: 0.7, energy: 0.8,
  instrumentalness: 0, key: 5, liveness: 0.1, loudness: -5.2, mode: 1, speechiness: 0.05, tempo: 120.0, valence: 0.6
}, extra || {})] });

async function main() {
  const rb = await standIn();
  const mock = await mockSpotify.start({});

  // A vibe looker with the stand-in; found() calls are kept.
  function looker(extra) {
    const seen = [];
    const genreCalls = [];
    const v = vibe.createVibes(Object.assign({
      dataDir: tmpDir(), base: rb.url, timeoutMs: 400,
      genres: (a) => { genreCalls.push(a); return Promise.resolve(['indie rock', 'garage rock']); },
      found: (id) => seen.push(id)
    }, extra || {}));
    v.seen = seen;
    v.genreCalls = genreCalls;
    return v;
  }
  const settle = (v) => until(() => !v.debug().busy && !v.debug().queued, 4000, 'the lookup never finished');

  /* ---------- pure pieces ---------- */

  await check('ReccoBeats\' reply: { content: [...] }, a bare list, a bare object; empty and insane ones give nothing', () => {
    const want = { source: 'features', tempo: 120, energy: 0.8, valence: 0.6, dance: 0.7, acoustic: 0.1, genres: [] };
    assert.deepStrictEqual(vibe.readFeatures(FEATURES('abc'), 'abc'), want);
    assert.deepStrictEqual(vibe.readFeatures(FEATURES('abc').content, 'abc'), want);
    assert.deepStrictEqual(vibe.readFeatures(FEATURES('abc').content[0], 'abc'), want);
    assert.strictEqual(vibe.readFeatures({ content: [] }, 'abc'), null);
    assert.strictEqual(vibe.readFeatures(null, 'abc'), null);
    assert.strictEqual(vibe.readFeatures('junk', 'abc'), null);
    assert.strictEqual(vibe.readFeatures({ content: [{ energy: 7, valence: 0.5 }] }, 'abc'), null, 'energy past 1');
    assert.strictEqual(vibe.readFeatures({ content: [{ energy: '0.5', valence: 0.5 }] }, 'abc'), null, 'a string');
    assert.strictEqual(vibe.readFeatures(FEATURES('other'), 'abc'), null, 'another song');
    // The first sane item wins; a tempo out of range is "unknown".
    const two = { content: [{ energy: NaN }, Object.assign(FEATURES('abc').content[0], { tempo: 260 })] };
    assert.strictEqual(vibe.readFeatures(two, 'abc').tempo, 0);
    assert.strictEqual(vibe.readFeatures(FEATURES('abc', { tempo: 39.9 }), 'abc').tempo, 0);
    assert.strictEqual(vibe.readFeatures(FEATURES('abc', { tempo: 128.04 }), 'abc').tempo, 128);
  });

  await check('cleanVibe: numbers clamped and rounded, unknown fields dropped, junk refused', () => {
    const c = vibe.cleanVibe({ id: 'abc', source: 'features', tempo: 99.96, energy: 1.7, valence: -2, dance: 0.333333, acoustic: 'x',
      genres: ['Indie Rock', 'indie rock', '<script>', 42, 'a'.repeat(80), 'pop'], token: 'nope' });
    assert.deepStrictEqual(c, { source: 'features', tempo: 100, energy: 1, valence: 0, dance: 0.33, acoustic: 0.3, genres: ['indie rock', 'script', 'a'.repeat(32)], id: 'abc' });
    assert.strictEqual(vibe.cleanVibe({ source: 'magic', energy: 0.5, valence: 0.5 }), null);
    assert.strictEqual(vibe.cleanVibe({ source: 'genres', energy: 0.5 }), null);
    assert.strictEqual(vibe.cleanVibe([]), null);
    assert.strictEqual(vibe.cleanVibe({ id: '../x', source: 'genres', energy: 0.5, valence: 0.5 }).id, undefined);
  });

  await check('genres to a vibe: metal is hard, ambient calm and acoustic, sad is low, dance is danceable, unknown is nothing', () => {
    const metal = vibe.fromGenres(['metal', 'hardcore punk']);
    const amb = vibe.fromGenres(['ambient', 'sleep']);
    const sad = vibe.fromGenres(['indie pop', 'sad indie']);
    const dance = vibe.fromGenres(['disco', 'dance pop']);
    assert.ok(metal.energy >= 0.85 && metal.tempo >= 150, JSON.stringify(metal));
    assert.ok(amb.energy <= 0.2 && amb.acoustic >= 0.7 && amb.tempo <= 80, JSON.stringify(amb));
    assert.ok(sad.valence <= 0.3, JSON.stringify(sad));
    assert.ok(dance.dance >= 0.8 && dance.valence >= 0.7, JSON.stringify(dance));
    assert.strictEqual(metal.source, 'genres');
    assert.deepStrictEqual(metal.genres, ['metal', 'hardcore punk']);
    assert.strictEqual(vibe.fromGenres(['polka-step-zz']), null);
    assert.strictEqual(vibe.fromGenres([]), null);
    assert.strictEqual(vibe.fromGenres(undefined), null);
  });

  await check('the TV\'s data: the vibe only with its own song, never with an episode, rebuilt from known fields', () => {
    const base = { state: 'playing', track: { id: 'abc', title: 'T', durationMs: 1000 } };
    const v = { id: 'abc', source: 'features', tempo: 500, energy: 0.5, valence: 0.5, dance: 0.5, acoustic: 0.5, genres: [], secret: 'x' };
    const d = spotify.cleanData(Object.assign({}, base, { vibe: v }));
    assert.deepStrictEqual(d.vibe, { source: 'features', tempo: 0, energy: 0.5, valence: 0.5, dance: 0.5, acoustic: 0.5, genres: [], id: 'abc' });
    assert.strictEqual(spotify.cleanData(Object.assign({}, base, { vibe: Object.assign({}, v, { id: 'other' }) })).vibe, null, 'another song\'s vibe');
    assert.strictEqual(spotify.cleanData(Object.assign({}, base, { vibe: Object.assign({}, v, { id: undefined }) })).vibe, null, 'a vibe without its song');
    assert.strictEqual(spotify.cleanData(Object.assign({}, base, { vibe: 'loud' })).vibe, null);
    const ep = { state: 'playing', track: { id: 'abc', kind: 'episode', title: 'E' }, vibe: v };
    assert.strictEqual(spotify.cleanData(ep).vibe, null);
    assert.strictEqual(spotify.offData().vibe, null);
    assert.strictEqual(spotify.vibeOffFromEnv({ SPOTIFY_VIBE: ' OFF ' }), true);
    assert.strictEqual(spotify.vibeOffFromEnv({ SPOTIFY_VIBE: 'on' }), false);
    assert.strictEqual(spotify.vibeOffFromEnv({}), false);
  });

  /* ---------- lookups against the stand-in ---------- */

  await check('found: one request with the track id only and a plain User-Agent; kept, and kept on disk', async () => {
    rb.requests = [];
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    const v = looker();
    assert.strictEqual(v.want('abc123', 'art1'), true);
    await settle(v);
    assert.deepStrictEqual(v.seen, ['abc123']);
    assert.strictEqual(rb.requests.length, 1);
    assert.strictEqual(rb.requests[0].path, '/v1/audio-features');
    assert.strictEqual(rb.requests[0].query, '?ids=abc123');
    assert.ok(/^HomeHub\//.test(rb.requests[0].headers['user-agent']), rb.requests[0].headers['user-agent']);
    assert.strictEqual(rb.requests[0].headers.authorization, undefined);
    assert.strictEqual(rb.requests[0].headers.cookie, undefined);
    assert.strictEqual(v.genreCalls.length, 1, 'the artist\'s genres are asked for too (outfits on the TV)');
    assert.deepStrictEqual(v.get('abc123'), { source: 'features', tempo: 120, energy: 0.8, valence: 0.6, dance: 0.7, acoustic: 0.1, genres: ['indie rock', 'garage rock'], id: 'abc123' });
    // A cache hit: no second request.
    assert.strictEqual(v.want('abc123', 'art1'), false);
    await sleep(50);
    assert.strictEqual(rb.requests.length, 1);
    v.flush();
    v.close();
  });

  await check('a song kept from before genres were added: only its genres are asked for, once', async () => {
    rb.requests = [];
    const dir = tmpDir();
    const old = { source: 'features', tempo: 120, energy: 0.8, valence: 0.6, dance: 0.7, acoustic: 0.1, genres: [] };
    fs.writeFileSync(path.join(dir, 'vibes.json'), JSON.stringify({ v: 1, items: [{ id: 'old1', vibe: old, at: Date.now(), retryAt: 0 }] }));
    const v = looker({ dataDir: dir });
    assert.strictEqual(v.want('old1', 'art9'), true);
    await settle(v);
    assert.strictEqual(rb.requests.length, 0, 'ReccoBeats is not asked again');
    assert.deepStrictEqual(v.genreCalls, ['art9']);
    assert.deepStrictEqual(v.get('old1').genres, ['indie rock', 'garage rock']);
    assert.strictEqual(v.want('old1', 'art9'), false, 'now fresh');
    v.flush();
    v.close();
    const again = looker({ dataDir: dir });
    assert.strictEqual(again.want('old1', 'art9'), false, 'the genres-asked mark survives a restart');
    again.close();
  });

  await check('Spotify could not give the genres: the vibe is kept, the genres are asked again after a while, not on every poll', async () => {
    rb.requests = [];
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    let t = Date.now();
    let answer = null;
    const calls = [];
    const v = looker({ now: () => t, genres: (a) => { calls.push(a); return Promise.resolve(answer); } });
    v.want('fail1', 'art2');
    await settle(v);
    assert.strictEqual(v.get('fail1').source, 'features');
    assert.deepStrictEqual(v.get('fail1').genres, []);
    assert.strictEqual(v.want('fail1', 'art2'), false, 'not asked again at once');
    t += 31 * 60000;
    answer = ['pop punk'];
    assert.strictEqual(v.want('fail1', 'art2'), true, 'asked again later');
    await settle(v);
    assert.strictEqual(rb.requests.length, 1, 'ReccoBeats only once');
    assert.deepStrictEqual(calls, ['art2', 'art2']);
    assert.deepStrictEqual(v.get('fail1').genres, ['pop punk']);
    assert.strictEqual(v.want('fail1', 'art2'), false);
    v.close();
  });

  await check('the file survives a restart (no new request); damaged files and 500+ songs are handled', async () => {
    rb.requests = [];
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    const dir = tmpDir();
    const a = looker({ dataDir: dir });
    a.want('keep1', '');
    await settle(a);
    a.close();
    const file = path.join(dir, 'vibes.json');
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.statSync(file).mode & 0o002, 0, 'not world-writable');
    const b = looker({ dataDir: dir });
    assert.strictEqual(b.get('keep1').tempo, 120);
    assert.strictEqual(b.want('keep1', ''), false);
    assert.strictEqual(rb.requests.length, 1);
    b.close();
    fs.writeFileSync(file, '{not json');
    const c = looker({ dataDir: dir });
    assert.strictEqual(c.get('keep1'), null, 'a damaged file starts empty');
    c.close();
    // Over the cap: the oldest go.
    const items = [];
    for (let i = 0; i < 520; i++) items.push({ id: 'old' + i, vibe: null, at: i, retryAt: 0 });
    items.push({ id: 'bad/id', vibe: null, at: 1, retryAt: 0 }, { id: 'badvibe', vibe: { source: 'x' }, at: 1, retryAt: 0 });
    fs.writeFileSync(file, JSON.stringify({ v: 1, items: items }));
    const d = looker({ dataDir: dir });
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    d.want('newest', '');
    await settle(d);
    d.close();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).items;
    assert.ok(saved.length <= 500, String(saved.length));
    assert.strictEqual(saved[saved.length - 1].id, 'newest');
    assert.ok(!saved.some((e) => e.id === 'old0' || e.id === 'bad/id' || e.id === 'badvibe'));
  });

  await check('not found: the artist\'s genres instead; nothing known: no vibe, asked again only after a day', async () => {
    rb.requests = [];
    rb.answer = (id, req, res) => json(res, 200, { content: [] });
    const v = looker();
    v.want('nope1', 'artistA');
    await settle(v);
    assert.deepStrictEqual(v.genreCalls, ['artistA']);
    const g = v.get('nope1');
    assert.strictEqual(g.source, 'genres');
    assert.deepStrictEqual(g.genres, ['indie rock', 'garage rock']);
    assert.ok(g.energy >= 0.6, JSON.stringify(g));
    v.close();
    let t = 1000000;
    const w = looker({ now: () => t, genres: () => Promise.resolve([]) });
    w.want('nope2', 'artistB');
    await settle(w);
    assert.strictEqual(w.get('nope2'), null);
    assert.deepStrictEqual(w.seen, ['nope2'], 'found() is still called, so the player knows');
    assert.strictEqual(w.want('nope2', 'artistB'), false, 'not again at once');
    t += 23 * 3600000;
    assert.strictEqual(w.want('nope2', 'artistB'), false, 'not within the day');
    t += 2 * 3600000;
    assert.strictEqual(w.want('nope2', 'artistB'), true, 'again after a day');
    await settle(w);
    assert.strictEqual(rb.requests.length, 3);
    w.close();
    // A genre call that fails is just "no genres".
    const x = looker({ genres: () => Promise.reject(new Error('403')) });
    x.want('nope3', 'artistC');
    await settle(x);
    assert.strictEqual(x.get('nope3'), null);
    assert.strictEqual(x.status().problem, '');
    x.close();
  });

  await check('a garbage reply and a 500: a problem is noted, genres are used, ReccoBeats is tried again later', async () => {
    let t = 5000000;
    rb.answer = (id, req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope</html>'); };
    const v = looker({ now: () => t });
    v.want('gar1', 'artistA');
    await settle(v);
    assert.strictEqual(v.get('gar1').source, 'genres');
    assert.ok(/not JSON/.test(v.status().problem), v.status().problem);
    assert.strictEqual(v.want('gar1', 'artistA'), false);
    t += 31 * 60000;
    rb.answer = (id, req, res) => json(res, 500, { error: 'x' });
    assert.strictEqual(v.want('gar1', 'artistA'), true, 'tried again after half an hour');
    await settle(v);
    assert.ok(/HTTP 500/.test(v.status().problem), v.status().problem);
    t += 31 * 60000;
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    v.want('gar1', 'artistA');
    await settle(v);
    assert.strictEqual(v.get('gar1').source, 'features', 'features replace the genres once known');
    assert.strictEqual(v.status().problem, '');
    v.close();
    // A reply far too large is refused, not read.
    rb.answer = (id, req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[' + '1,'.repeat(300000) + '1]'); };
    const big = looker();
    big.want('big1', '');
    await settle(big);
    assert.ok(/too large/.test(big.status().problem), big.status().problem);
    big.close();
  });

  await check('a timeout ends the lookup by itself and never blocks the next', async () => {
    const hung = [];
    rb.answer = (id, req, res) => { hung.push(res); };
    const v = looker({ timeoutMs: 250 });
    const t0 = Date.now();
    v.want('slow1', '');
    await settle(v);
    assert.ok(Date.now() - t0 < 1500, 'gave up in time: ' + (Date.now() - t0));
    assert.ok(/timed out/.test(v.status().problem), v.status().problem);
    hung.forEach((r) => { try { r.end(); } catch (e) { /* gone */ } });
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    v.want('slow2', '');
    await settle(v);
    assert.strictEqual(v.get('slow2').tempo, 120);
    v.close();
  });

  await check('429: Retry-After is honored (capped), nothing is asked meanwhile', async () => {
    rb.requests = [];
    let t = 9000000;
    rb.answer = (id, req, res) => json(res, 429, { error: 'Too Many Requests' }, { 'Retry-After': '999999' });
    const v = looker({ now: () => t });
    v.want('rl1', 'a');
    await settle(v);
    assert.ok(/slow down for 3600 s/.test(v.status().problem), v.status().problem);
    assert.strictEqual(v.get('rl1').source, 'genres', 'genres meanwhile');
    v.want('rl2', 'a');
    await settle(v);
    assert.strictEqual(rb.requests.length, 1, 'no call during the wait');
    t += 3601000;
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    v.want('rl3', 'a');
    await settle(v);
    assert.strictEqual(rb.requests.length, 2);
    assert.strictEqual(v.get('rl3').source, 'features');
    v.close();
  });

  await check('the off switch: ReccoBeats is never asked; genres still work', async () => {
    rb.requests = [];
    rb.answer = (id, req, res) => json(res, 200, FEATURES(id));
    const v = looker({ off: true });
    v.want('off1', 'artistA');
    await settle(v);
    assert.strictEqual(rb.requests.length, 0);
    assert.strictEqual(v.get('off1').source, 'genres');
    assert.strictEqual(v.status().lookups, 'off');
    v.close();
  });

  await check('one lookup at a time; songs skipped past are not looked up; results stay with their own song', async () => {
    rb.requests = [];
    rb.answer = (id, req, res) => setTimeout(() => json(res, 200, FEATURES(id, { tempo: id === 'q1' ? 90 : 150 })), 150);
    const v = looker();
    v.want('q1', '');
    v.want('q2', '');
    v.want('q3', '');
    assert.strictEqual(rb.requests.length <= 1, true);
    await settle(v);
    assert.deepStrictEqual(rb.requests.map((r) => r.query), ['?ids=q1', '?ids=q3']);
    assert.deepStrictEqual(v.seen, ['q1', 'q3']);
    assert.strictEqual(v.get('q1').tempo, 90);
    assert.strictEqual(v.get('q3').tempo, 150);
    assert.strictEqual(v.get('q2'), null);
    v.close();
  });

  /* ---------- through the server, with the Spotify stand-in ---------- */

  const ENV = { SPOTIFY_CLIENT_ID: mock.clientId, SPOTIFY_CLIENT_SECRET: mock.clientSecret, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8097/spotify/callback' };
  async function start(env, extraSpotify) {
    const dir = tmpDir();
    const h = hubServer.start({
      token: TOKEN, port: 0, host: '127.0.0.1', dataDir: dir, log: () => {},
      spotifyEnv: Object.assign({}, ENV, env || {}),
      spotify: Object.assign({ accounts: mock.url, api: mock.url, vibe: mock.url, allowHttp: true, manual: true }, extraSpotify || {})
    });
    await h.ready;
    const l = h.spotify.loginUrl();
    const landed = await new Promise((resolve, reject) => http.get(l.url, (res) => { res.resume(); resolve(res.headers.location); }).on('error', reject));
    await h.spotify.finishLogin(landed);
    h.dir = dir;
    return h;
  }
  const stop = (h) => new Promise((r) => h.close(r));
  const state = async (h) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: h.port, path: '/live/state' }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve(JSON.parse(t).resources.nowplaying));
    }).on('error', reject);
  });
  const piSettle = (h) => until(() => { const d = h._debug().spotify.vibe; return !d.busy && !d.queued; }, 8000, 'the lookup never finished');

  await check('the song shows at once; its vibe follows as one more push, and later polls push nothing', async () => {
    mock.reset();
    mock.vibes('ok', 250);
    const h = await start();
    let r = await state(h);
    assert.strictEqual(r.data.track.title, 'Golden Hour Drive');
    assert.strictEqual(r.data.vibe, null, 'not known yet: the song does not wait');
    const rev0 = r.rev;
    await piSettle(h);
    r = await state(h);
    assert.strictEqual(r.rev, rev0 + 1);
    assert.deepStrictEqual(r.data.vibe, { source: 'features', tempo: 124, energy: 0.78, valence: 0.82, dance: 0.84, acoustic: 0.08, genres: ['indie pop', 'nu disco'], id: 'mock0001' });
    assert.ok(Math.abs(r.data.progressMs - 62000 - (Date.now() - r.data.at)) < 4000, 'the position was brought up to date');
    for (let i = 0; i < 3; i++) { await sleep(60); await h.spotify.poll(); }
    assert.strictEqual((await state(h)).rev, rev0 + 1, 'no flicker, no repeats');
    const calls = mock.calls.features;
    mock.set('paused');
    await h.spotify.poll();
    mock.set('playing');
    await h.spotify.poll();
    assert.strictEqual(mock.calls.features, calls, 'pause and play do not ask again');
    const lines = hubctl.spotifyStatusLines(h.spotify.status());
    assert.ok(lines.indexOf('Vibe: features, 124 BPM, energy 0.78, mood 0.82.') >= 0, lines.join(' | '));
    await stop(h);
  });

  await check('a song change mid-lookup: the first answer is not put on the second song', async () => {
    mock.reset();
    mock.vibes('ok', 300);
    const h = await start();
    const pushes = [];
    const req = http.get({ host: '127.0.0.1', port: h.port, path: '/live/events' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => pushes.push(c));
    });
    await sleep(50);
    mock.next();                                    // Paper Moons, while Golden Hour Drive is still being looked up
    await h.spotify.poll();
    let r = await state(h);
    assert.strictEqual(r.data.track.id, 'mock0003');
    await piSettle(h);
    r = await state(h);
    assert.strictEqual(r.data.vibe.id, 'mock0003');
    assert.strictEqual(r.data.vibe.tempo, 76);
    const text = pushes.join('');
    assert.ok(text.indexOf('"tempo":124') < 0, 'the first song\'s vibe was never pushed with the second');
    req.destroy();
    await stop(h);
  });

  await check('genres when ReccoBeats does not know the song; nothing when neither does; episodes are not looked up', async () => {
    mock.reset();
    mock.vibes('ok', 0);
    const h = await start();
    await piSettle(h);
    mock.play(5);                                    // Harbor Lights: genres only
    await h.spotify.poll();
    await piSettle(h);
    let r = await state(h);
    assert.strictEqual(r.data.vibe.source, 'genres');
    assert.deepStrictEqual(r.data.vibe.genres, ['indie folk', 'chamber pop']);
    assert.ok(/^Vibe: from genres \(indie folk, chamber pop\)\.$/.test(hubctl.spotifyStatusLines(h.spotify.status()).slice(-1)[0]));
    mock.play(6);                                    // Untitled Demo 3: nothing, and the artist call is a 404
    await h.spotify.poll();
    await piSettle(h);
    r = await state(h);
    assert.strictEqual(r.data.state, 'playing', 'a 404 for the artist is not an error');
    assert.strictEqual(r.data.vibe, null);
    assert.strictEqual(hubctl.spotifyStatusLines(h.spotify.status()).slice(-1)[0], 'Vibe: none yet.');
    const before = mock.calls.features;
    mock.set('episode');
    await h.spotify.poll();
    await sleep(80);
    assert.strictEqual(mock.calls.features, before, 'no lookup for a podcast');
    r = await state(h);
    assert.strictEqual(r.data.vibe, null);
    assert.strictEqual(hubctl.spotifyStatusLines(h.spotify.status()).slice(-1)[0], 'Vibe: none (songs only, not podcasts).');
    mock.set('playing');
    await stop(h);
  });

  await check('SPOTIFY_VIBE=off: no ReccoBeats call, the genres still give a vibe, and status says so', async () => {
    mock.reset();
    const before = mock.calls.features;
    const h = await start({ SPOTIFY_VIBE: 'off' });
    await piSettle(h);
    const r = await state(h);
    assert.strictEqual(mock.calls.features, before);
    assert.strictEqual(r.data.vibe.source, 'genres');
    const last = hubctl.spotifyStatusLines(h.spotify.status()).slice(-1)[0];
    assert.ok(/^Vibe: from genres \(indie pop, nu disco\)\. Vibe lookups: off \(SPOTIFY_VIBE=off\)\.$/.test(last), last);
    await stop(h);
  });

  await check('a lookup problem shows on the status line and in the mailbox; no token anywhere', async () => {
    mock.reset();
    mock.vibes('down', 0);
    const h = await start();
    await piSettle(h);
    const last = hubctl.spotifyStatusLines(h.spotify.status()).slice(-1)[0];
    assert.ok(/^Vibe: from genres \(indie pop, nu disco\)\. Last lookup problem: ReccoBeats answered HTTP 500 \(\d+ seconds ago\)\.$/.test(last), last);
    const call = async (method, route, body) => {
      const r = await h.api(method, route, body);
      if (!r.body.ok) throw new Error(r.body.error);
      return r.body;
    };
    const st = await mailbox.COMMANDS['spotify.status'].run({}, { call: call });
    assert.ok(/Vibe: from genres/.test(st.message), st.message);
    mock.vibes('ok', 0);
    await stop(h);                                   // closing writes vibes.json at once
    const file = fs.readFileSync(path.join(h.dir, 'vibes.json'), 'utf8');
    assert.ok(/"mock0001"/.test(file));
    [mock.clientSecret, 'mock-refresh-', 'mock-access-'].forEach((bad) => {
      assert.ok(JSON.stringify(st).indexOf(bad) < 0 && file.indexOf(bad) < 0, 'found ' + bad.slice(0, 10));
    });
  });

  await check('an older server sends no vibe: the status lines stay as they were', () => {
    assert.deepStrictEqual(hubctl.spotifyStatusLines({ configured: true, signedIn: true, user: '', state: 'idle', track: null }),
      ['Spotify: signed in.', 'Nothing is playing.']);
    assert.strictEqual(hubctl.vibeLine({ lookups: 'on', now: null, pending: true, problem: '' }, { kind: 'track' }), 'Vibe: looking it up.');
  });

  await mock.close();
  await new Promise((r) => rb.server.close(r));
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
