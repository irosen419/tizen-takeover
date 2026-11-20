/*
 * Tests for "All sounds" (pi/allsounds.js), the test-only widget's Pi side.
 * Run from the repo root with:
 *
 *   node pi/allsounds-test.js
 *
 * It uses the pretend Home Assistant (dev/mock-ha.js) and the pretend
 * Spotify (dev/mock-spotify.js) on this machine, and the real hub server
 * with a throwaway data folder. Nothing reaches the internet, Home
 * Assistant or Amazon. Uses only what ships with Node. Prints one line per
 * check, then "N passed, M failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const hubServer = require('./server');
const allsounds = require('./allsounds');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const mockHa = require('../dev/mock-ha');
const mockSpotify = require('../dev/mock-spotify');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const CLIENT_ID = 'testclientid0123456789abcdef0123';
const CLIENT_SECRET = 'testsecretDONOTLEAK0123456789abc';
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-allsounds-'));
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

function request(port, method, p, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, text: text, json: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function entity(id, state, attrs, minutesAgo) {
  return {
    entity_id: 'media_player.' + id, state: state, attributes: attrs || {},
    last_changed: new Date(Date.UTC(2026, 10, 17, 12, 0) - (minutesAgo || 0) * 60000).toISOString()
  };
}

async function main() {
  const ha = await mockHa.start({});
  const sp = await mockSpotify.start({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const HA_ENV = { HA_URL: ha.url + '/', HA_TOKEN: ha.token };
  const logs = [];

  /* ---------- pure pieces ---------- */

  await check('settings: no token is "not set up"; token, address and entity list checked', () => {
    assert.deepStrictEqual(allsounds.configFromEnv({}), { configured: false, problem: '' });
    assert.deepStrictEqual(allsounds.configFromEnv({ HA_URL: 'http://127.0.0.1:8123' }), { configured: false, problem: '' });
    const ok = allsounds.configFromEnv({ HA_TOKEN: ha.token });
    assert.strictEqual(ok.configured, true);
    assert.strictEqual(ok.url, 'http://127.0.0.1:8123', 'Home Assistant on the same Pi when HA_URL is left out');
    assert.strictEqual(allsounds.configFromEnv(HA_ENV).url, ha.url, 'trailing slash dropped');
    assert.ok(/HA_TOKEN/.test(allsounds.configFromEnv({ HA_TOKEN: 'paste here' }).problem));
    const creds = allsounds.configFromEnv({ HA_TOKEN: ha.token, HA_URL: 'http://user:pw@127.0.0.1:8123' });
    assert.strictEqual(creds.configured, false);
    assert.ok(creds.problem.indexOf('pw') < 0 && creds.problem.indexOf(ha.token) < 0, 'the problem never repeats what was given');
    assert.strictEqual(allsounds.configFromEnv({ HA_TOKEN: ha.token, HA_URL: 'ftp://x' }).configured, false);
    const list = allsounds.configFromEnv({ HA_TOKEN: ha.token, ALLSOUNDS_ENTITIES: ' media_player.living_room_echo , media_player.kitchen_echo ' });
    assert.deepStrictEqual(list.entities, ['media_player.living_room_echo', 'media_player.kitchen_echo']);
    assert.strictEqual(allsounds.configFromEnv({ HA_TOKEN: ha.token, ALLSOUNDS_ENTITIES: 'light.kitchen' }).configured, false);
  });

  await check('state mapping: playing, buffering, paused, idle, on, standby, off, unavailable, unknown', () => {
    const m = (s) => allsounds.readEntity(entity('x', s, { friendly_name: 'X' })).state;
    assert.deepStrictEqual(['playing', 'buffering', 'paused', 'idle', 'on', 'standby', 'off', 'unavailable', 'unknown', 'PLAYING'].map(m),
      ['playing', 'playing', 'paused', 'idle', 'idle', 'idle', 'off', 'off', 'off', 'playing']);
    assert.strictEqual(allsounds.readEntity({ entity_id: 'light.x', state: 'on' }), null, 'only media players');
    assert.strictEqual(allsounds.readEntity(null), null);
  });

  await check('selection: newest playing wins over paused; newest paused over older; idle and off', () => {
    const r = (list) => allsounds.pickActive(list.map((e) => allsounds.readEntity(e)));
    const a = r([
      entity('office', 'paused', { friendly_name: 'Office', media_title: 'Old' }, 1),
      entity('kitchen', 'playing', { friendly_name: 'Kitchen', media_title: 'Older song' }, 30),
      entity('living', 'playing', { friendly_name: 'Living room Echo', media_title: 'Newer song' }, 5)
    ]);
    assert.strictEqual(a.state, 'playing');
    assert.strictEqual(a.device, 'Living room Echo');
    assert.strictEqual(a.title, 'Newer song');
    const b = r([entity('a', 'paused', { friendly_name: 'A', media_title: 'A' }, 50), entity('b', 'paused', { friendly_name: 'B', media_title: 'B' }, 10)]);
    assert.strictEqual(b.device, 'B');
    assert.strictEqual(b.state, 'paused');
    assert.strictEqual(r([entity('a', 'idle', { friendly_name: 'A' }), entity('b', 'off')]).state, 'idle');
    assert.strictEqual(r([entity('b', 'off'), entity('c', 'unavailable')]).state, 'off');
    assert.strictEqual(r([]).state, 'off');
  });

  await check('labels: the app\'s name as people say it; radio with no artist keeps the station', () => {
    const L = (a) => allsounds.sourceLabel(a);
    assert.strictEqual(L({ app_name: 'TuneIn Radio' }), 'TuneIn');
    assert.strictEqual(L({ source: 'iHeart' }), 'iHeartRadio');
    assert.strictEqual(L({ source: 'CLOUDPLAYER' }), 'Amazon Music');
    assert.strictEqual(L({ source: 'Local Speaker' }), '', 'no app named: no chip');
    assert.strictEqual(L({}), '');
    assert.strictEqual(L({ source: 'A very long and unusual music service name indeed' }).length <= 30, true);
    const radio = allsounds.readEntity(entity('l', 'playing', { media_title: 'Morning Edition', media_album_name: 'KERA 90.1', source: 'TuneIn' }));
    assert.strictEqual(radio.artist, '');
    assert.strictEqual(radio.album, 'KERA 90.1');
    assert.strictEqual(radio.device, 'l', 'the id stands in for a missing name');
  });

  await check('platform from the picture host (an Echo names no app): every mapping, unknown hosts, the artist rule, no host leaks', () => {
    const P = (pic, artist) => allsounds.inferPlatform({ entity_picture: pic, media_artist: artist });
    const MAP = [
      ['https://i.scdn.co/image/ab67616d0000b273', 'Spotify'],
      ['https://mosaic.spotifycdn.com/x/y', 'Spotify'],
      ['https://m.media-amazon.com/images/I/x.jpg', 'Amazon Music'],
      ['https://images-na.ssl-images-amazon.com/images/I/x.jpg', 'Amazon Music'],
      ['https://content-images.p-cdn.com/images/x.jpg', 'Pandora'],
      ['https://content-images.p-cdn.us/images/x.jpg', 'Pandora'],
      ['https://cdn-img.pandora.com/x.jpg', 'Pandora'],
      ['https://cdn-profiles.tunein.com/s1/images/logo.png', 'TuneIn'],
      ['https://d1.radiotime.com/x.png', 'TuneIn'],
      ['https://i.iheart.com/v3/surl/x', 'iHeartRadio'],
      ['https://iscale.iheart.com/x', 'iHeartRadio'],
      ['https://n1.ihrhls.com/x.png', 'iHeartRadio'],
      ['https://m.media.audible.com/images/x.jpg', 'Audible'],
      ['https://is1-ssl.mzstatic.com/image/x.jpg', 'Apple Music'],
      ['https://www.siriusxm.com/x.png', 'SiriusXM'],
      ['HTTPS://I.SCDN.CO/x', 'Spotify']
    ];
    MAP.forEach((m) => assert.strictEqual(P(m[0], ''), m[1], m[0]));
    // Unknown, look-alike and unusable pictures: nothing, not a guess.
    ['https://example.com/x.jpg', 'https://evil-media-amazon.com/x', 'https://media-amazon.com.evil.net/x', 'https://scdn.co.example/x',
      'https://notpandora.com/x', 'http://127.0.0.1:8123/art/album.svg', '/api/media_player_proxy/x?token=1', 'not a url', '', null, undefined, 5]
      .forEach((u) => assert.strictEqual(P(u, ''), '', String(u)));
    // An audiobook title on Amazon's host stays Amazon Music: no Audible guess.
    assert.strictEqual(allsounds.inferPlatform({ entity_picture: 'https://m.media-amazon.com/x.jpg', media_title: 'Chapter 4', media_album_name: 'Project Hail Mary (Unabridged)' }), 'Amazon Music');
    // The artist rule: exactly a service's name.
    ['iHeartRadio', 'TuneIn', 'Pandora', 'SiriusXM'].forEach((n) => assert.strictEqual(P('', n), n));
    ['iheartradio', 'Pandora Radio', 'The Pandora', 'Spotify', 'Amazon Music', ''].forEach((n) => assert.strictEqual(P('', n), '', n));
    assert.strictEqual(P('https://example.com/x.jpg', 'iHeartRadio'), 'iHeartRadio');
    assert.strictEqual(P('https://m.media-amazon.com/x.jpg', 'iHeartRadio'), 'iHeartRadio', 'a station naming itself beats Amazon\'s catch-all host');
    assert.strictEqual(P('https://i.scdn.co/x', 'Pandora'), 'Spotify', 'a real artist called Pandora on Spotify art stays Spotify');
    assert.strictEqual(allsounds.inferPlatform(null), '');
    // An audiobook: the author as "By ..." with Amazon's picture is Audible.
    assert.strictEqual(P('https://m.media-amazon.com/images/I/x.jpg', 'By Pierce Brown'), 'Audible');
    assert.strictEqual(P('', 'by  Andy Weir'), 'Audible');
    assert.strictEqual(P('https://i.scdn.co/image/x', 'By The Sea'), 'Spotify');
    assert.strictEqual(P('https://m.media-amazon.com/x.jpg', 'Byrds'), 'Amazon Music');
    // A named app still wins over the inference (readEntity), and nothing keeps the host.
    const named = allsounds.readEntity(entity('l', 'playing', { media_title: 'x', source: 'TuneIn', entity_picture: 'https://i.scdn.co/x' }));
    assert.strictEqual(named.source, 'TuneIn');
    const inferred = allsounds.cleanData(allsounds.pickActive([allsounds.readEntity(entity('l', 'playing', { media_title: 'x', entity_picture: 'https://content-images.p-cdn.com/secret-path/x.jpg' }))]));
    assert.strictEqual(inferred.source, 'Pandora');
    assert.ok(inferred.source.length <= 30);
    assert.deepStrictEqual(Object.keys(inferred).sort(), ['album', 'art', 'artist', 'device', 'from', 'problem', 'source', 'stale', 'started', 'state', 'title', 'v']);
    ['p-cdn', 'secret-path'].forEach((bad) => assert.ok(JSON.stringify(Object.assign({}, inferred, { art: '' })).indexOf(bad) < 0, bad + ' leaked beyond the picture address'));
  });

  await check('selection without ALLSOUNDS_ENTITIES: Echo-style speakers only (not TVs, browser_mod, the "everywhere" group)', () => {
    const E = allsounds.isAlexaSpeaker;
    assert.strictEqual(E({ entity_id: 'media_player.ian_s_echo_show', attributes: { last_called: false } }), true);
    assert.strictEqual(E({ entity_id: 'media_player.ian_s_echo_dot', attributes: { bluetooth_list: [] } }), true);
    assert.strictEqual(E({ entity_id: 'media_player.everywhere', attributes: { last_called: false } }), false);
    assert.strictEqual(E({ entity_id: 'media_player.living_room_tv', attributes: { app_name: 'Netflix' } }), false);
    assert.strictEqual(E({ entity_id: 'media_player.browser_mod_abc', attributes: { last_called: false } }), false);
    assert.strictEqual(E({ entity_id: 'light.x', attributes: { last_called: false } }), false);
    assert.strictEqual(E(null), false);
  });

  await check('real Echo shapes: Amazon Music with no app name, TuneIn station only (and nothing in its first seconds), NPR as idle', () => {
    const r = (list) => allsounds.cleanData(allsounds.pickActive(list.map((e) => allsounds.readEntity(e))));
    const am = r([entity('ian_s_echo_show', 'playing', { friendly_name: 'Ian\'s Echo Show', last_called: false, media_title: 'Song', media_artist: 'Band',
      media_album_name: 'LP', media_content_type: 'music', entity_picture: 'https://m.media-amazon.com/images/I/x.jpg', entity_picture_local: '/api/media_player_proxy/x?token=1' })]);
    assert.deepStrictEqual([am.state, am.source, am.title, am.art], ['playing', 'Amazon Music', 'Song', 'https://m.media-amazon.com/images/I/x.jpg']);
    const ti = r([entity('ian_s_echo_show', 'playing', { friendly_name: 'Ian\'s Echo Show', last_called: false, media_content_type: 'music' })]);
    assert.deepStrictEqual([ti.state, ti.from, ti.source, ti.device, ti.title, ti.art], ['playing', 'echo', '', 'Ian\'s Echo Show', '', ''], 'still playing, with the speaker');
    const st = r([entity('ian_s_echo_show', 'playing', { friendly_name: 'Ian\'s Echo Show', last_called: false, media_content_type: 'music', media_title: 'KERA',
      media_artist: null, media_album_name: null, entity_picture: 'https://cdn-profiles.tunein.com/s1/images/logo.png', entity_picture_local: '/api/media_player_proxy/x?token=1' })]);
    assert.deepStrictEqual([st.state, st.source, st.device, st.title, st.artist, st.album, st.art], ['playing', 'TuneIn', 'Ian\'s Echo Show', 'KERA', '', '', 'https://cdn-profiles.tunein.com/s1/images/logo.png'], 'the station name, no artist');
    const npr = r([entity('ian_s_echo_show', 'idle', { friendly_name: 'Ian\'s Echo Show', last_called: false, media_content_type: 'idle' })]);
    assert.strictEqual(npr.state, 'idle');
  });

  await check('"may be out of date": an Echo past the end of its song by over a minute; never radio, paused or Spotify', () => {
    const T0 = Date.parse('2026-11-17T20:00:00Z');
    const at = (s) => new Date(T0 - s * 1000).toISOString();
    const song = (state, attrs) => entity('ian_s_echo_show', state, Object.assign({ friendly_name: 'Ian\'s Echo Show', last_called: false, media_title: 'Song', media_artist: 'Band' }, attrs));
    const read = (e) => allsounds.readEntity(e, false, T0);
    const r = (e) => allsounds.cleanData(allsounds.pickActive([read(e)]));
    // 214 s song at 62 s, 10 minutes ago: 662 s > 274 s.
    assert.strictEqual(r(song('playing', { media_duration: 214, media_position: 62, media_position_updated_at: at(600) })).stale, true);
    // Just inside and just past the minute.
    assert.strictEqual(read(song('playing', { media_duration: 200, media_position: 0, media_position_updated_at: at(259) })).stale, false);
    assert.strictEqual(read(song('playing', { media_duration: 200, media_position: 0, media_position_updated_at: at(261) })).stale, true);
    // Fresh, no duration (radio), no position, no time, odd values, paused.
    assert.strictEqual(read(song('playing', { media_duration: 214, media_position: 62, media_position_updated_at: at(5) })).stale, false);
    assert.strictEqual(read(song('playing', { media_position: 62, media_position_updated_at: at(36000) })).stale, false, 'radio for ten hours');
    assert.strictEqual(read(song('playing', { media_duration: 214, media_position_updated_at: at(36000) })).stale, false);
    assert.strictEqual(read(song('playing', { media_duration: 214, media_position: 62 })).stale, false);
    assert.strictEqual(read(song('playing', { media_duration: 0, media_position: 62, media_position_updated_at: at(600) })).stale, false);
    assert.strictEqual(read(song('playing', { media_duration: 'x', media_position: 62, media_position_updated_at: at(600) })).stale, false);
    assert.strictEqual(r(song('paused', { media_duration: 214, media_position: 62, media_position_updated_at: at(600) })).stale, false);
    // Only an Echo that plays: cleanData drops it for Spotify and every other state.
    assert.strictEqual(allsounds.cleanData({ state: 'playing', from: 'spotify', source: 'Spotify', title: 'x', stale: true }).stale, false);
    assert.strictEqual(allsounds.cleanData({ state: 'paused', from: 'echo', title: 'x', stale: true }).stale, false);
    assert.strictEqual(allsounds.cleanData({ state: 'playing', from: 'echo', title: 'x', stale: 'yes' }).stale, false);
    assert.strictEqual(allsounds.notsetData().stale, false);
    // Spotify playing still wins over a stale Echo, and is never stale.
    const sp = allsounds.fromSpotify({ state: 'playing', track: { title: 'S', artist: 'A' }, device: { name: 'Phone' } });
    const both = allsounds.cleanData(allsounds.merge(r(song('playing', { media_duration: 214, media_position: 62, media_position_updated_at: at(600) })), sp));
    assert.deepStrictEqual([both.from, both.title, both.stale], ['spotify', 'S', false]);
    // Spotify paused: the stale Echo that plays shows, as before.
    const sp2 = allsounds.fromSpotify({ state: 'paused', track: { title: 'S', artist: 'A' } });
    const h = allsounds.cleanData(allsounds.merge(r(song('playing', { media_duration: 214, media_position: 62, media_position_updated_at: at(600) })), sp2));
    assert.deepStrictEqual([h.from, h.state, h.stale], ['echo', 'playing', true]);
  });

  await check('cleaning: control characters, direction marks, length caps, art only absolute https', () => {
    const d = allsounds.cleanData({
      state: 'playing', from: 'echo', source: 'Tune\u0000In', device: 'Living‮ room\nEcho',
      title: 'x'.repeat(500), artist: 'y'.repeat(300), album: '<b>z</b>', art: 'https://m.media-amazon.com/images/I/abc.jpg', problem: 'auth'
    });
    assert.strictEqual(d.source, 'Tune In');
    assert.strictEqual(d.device, 'Living room Echo');
    assert.strictEqual(Array.from(d.title).length, 200);
    assert.strictEqual(Array.from(d.artist).length, 120);
    assert.strictEqual(d.art, 'https://m.media-amazon.com/images/I/abc.jpg');
    assert.strictEqual(d.problem, '', 'a problem only goes with the error state');
    const art = allsounds.cleanArt;
    assert.strictEqual(art('/api/media_player_proxy/media_player.x?token=abc'), '');
    assert.strictEqual(art('http://192.168.1.219:8123/api/x'), '');
    assert.strictEqual(art('https://user:pw@example.com/a.jpg'), '');
    assert.strictEqual(art('javascript:alert(1)'), '');
    assert.strictEqual(art('https://a.com/x" onerror="y'), '');
    assert.strictEqual(art('http://127.0.0.1:9/a.svg', true), 'http://127.0.0.1:9/a.svg', 'http only for the stand-in');
    assert.strictEqual(allsounds.cleanData({ state: 'nonsense' }).state, 'notset');
    assert.strictEqual(allsounds.cleanData({ state: 'playing' }).state, 'idle', 'playing with nothing to show is idle');
    const e = allsounds.cleanData({ state: 'error', problem: 'something new', title: 'x', device: 'y' });
    assert.strictEqual(e.problem, '');
    assert.strictEqual(e.title + e.device, '', 'an error picture carries no words');
    assert.deepStrictEqual(allsounds.cleanResource({ rev: 4, data: { state: 'idle', device: 'K' } }).data.device, 'K');
    assert.strictEqual(allsounds.cleanResource(null).rev, 0);
  });

  await check('Spotify folded in: Spotify playing wins; the house playing beats Spotify paused', () => {
    const house = { v: 1, state: 'playing', from: 'echo', source: 'TuneIn', device: 'Living room Echo', title: 'Show', artist: '', album: 'Station', art: '', problem: '' };
    const npPlaying = { state: 'playing', device: { name: 'Laptop' }, track: { title: 'Song', artist: 'Band', album: 'LP', art: 'https://i.scdn.co/image/a', artSmall: 'https://i.scdn.co/image/b' } };
    const fs1 = allsounds.fromSpotify(npPlaying);
    assert.strictEqual(fs1.source, 'Spotify');
    assert.strictEqual(fs1.from, 'spotify');
    assert.strictEqual(fs1.art, 'https://i.scdn.co/image/b');
    assert.strictEqual(allsounds.merge(house, fs1).source, 'Spotify');
    const fsPaused = allsounds.fromSpotify(Object.assign({}, npPlaying, { state: 'paused' }));
    assert.strictEqual(allsounds.merge(house, fsPaused).source, 'TuneIn');
    const idle = { v: 1, state: 'idle', device: 'K' };
    assert.strictEqual(allsounds.merge(idle, fsPaused).state, 'paused');
    assert.strictEqual(allsounds.merge(idle, null).state, 'idle');
    assert.strictEqual(allsounds.merge(allsounds.notsetData(), fs1).state, 'playing', 'Spotify shows even without Home Assistant');
    // Spotify still says "playing" on an Echo that has moved on to another app: the Echo wins.
    const npOnEcho = allsounds.fromSpotify(Object.assign({}, npPlaying, { device: { name: 'Living room Echo' } }));
    assert.strictEqual(allsounds.merge(house, npOnEcho).title, 'Show', 'the Echo playing something else beats a stale Spotify on that Echo');
    const houseSame = Object.assign({}, house, { title: 'Song' });
    assert.strictEqual(allsounds.merge(houseSame, npOnEcho).source, 'Spotify', 'same song on that Echo: Spotify (richer) wins');
    const houseNoTitle = Object.assign({}, house, { title: '' });
    assert.strictEqual(allsounds.merge(houseNoTitle, npOnEcho).source, 'Spotify', 'the Echo with no details yet does not beat Spotify');
    assert.strictEqual(allsounds.fromSpotify({ state: 'idle', track: { title: 'x' } }), null);
    assert.strictEqual(allsounds.fromSpotify(null), null);
  });

  /* ---------- the watcher against the pretend Home Assistant ---------- */

  async function watcher(env, extra) {
    let cur = allsounds.notsetData();
    const pushes = [];
    const w = allsounds.createWatcher(Object.assign({
      config: allsounds.configFromEnv(env), current: () => cur, publish: (d) => { cur = d; pushes.push(d); },
      log: (s) => logs.push(s), allowHttp: true, manual: true, timeoutMs: 400
    }, extra || {}));
    w.start();
    return { w: w, pushes: pushes, cur: () => cur };
  }

  await check('the pretend house in every mode, and one push per real change only', async () => {
    const x = await watcher(HA_ENV);
    ha.set('radio');
    await x.w.poll();
    let d = x.cur();
    assert.strictEqual(d.state, 'playing');
    assert.strictEqual(d.source, 'TuneIn');
    assert.strictEqual(d.device, 'Living room Echo');
    assert.strictEqual(d.title, 'Morning Edition');
    assert.strictEqual(d.artist, '');
    assert.strictEqual(d.album, 'KERA 90.1 Dallas');
    assert.strictEqual(d.art, ha.url + '/art/radio.svg');
    const n = x.pushes.length;
    await x.w.poll();
    await x.w.poll();
    assert.strictEqual(x.pushes.length, n, 'nothing new: no push');
    ha.set('music');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.state, d.source, d.title, d.artist, d.album], ['playing', 'Amazon Music', 'Golden Hour Drive', 'The Lanterns', 'Slow Coast']);
    ha.set('paused');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'paused');
    assert.strictEqual(x.cur().device, 'Living room Echo', 'the newest paused speaker, not the office');
    ha.set('idle');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'idle');
    ha.set('off');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'off');
    ha.set('unauthorized');
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().problem], ['error', 'auth']);
    ha.set('broken');
    await x.w.poll();
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().problem], ['error', 'reply']);
    ha.set('down');
    await x.w.poll();
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().problem], ['error', 'unreachable']);
    ha.set('radio');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'playing', 'back by itself');
    // The shapes a real Echo Show sent. A playing TV, a browser_mod panel and
    // the "everywhere" group are in every mode and never picked.
    ha.set('amazonmusic');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.state, d.source, d.device, d.title, d.artist, d.art], ['playing', 'Amazon Music', 'Ian\'s Echo Show', 'Golden Hour Drive', 'The Lanterns', 'https://m.media-amazon.com/images/I/51GoldenHourDrive._SX300_.jpg']);
    ha.set('pandora');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.state, d.source, d.title], ['playing', 'Pandora', 'Golden Hour Drive']);
    ha.set('tunein');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.state, d.source, d.device, d.title, d.artist, d.art], ['playing', '', 'Ian\'s Echo Show', 'KERA', '', ha.url + '/art/radio.svg']);
    ha.set('tuneinstart');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.state, d.source, d.device, d.title, d.art], ['playing', '', 'Ian\'s Echo Show', '', '']);
    assert.strictEqual(d.stale, false);
    ha.set('stale');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.state, d.title, d.stale], ['playing', 'Golden Hour Drive', true], 'past the end of the song');
    ha.set('amazonmusic');
    await x.w.poll();
    assert.strictEqual(x.cur().stale, false, 'a fresh position is not stale');
    ha.set('npr');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'idle');
    ha.set('idle');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'idle', 'the playing TV and group are not speakers');
    x.w.close();
  });

  await check('one network hiccup keeps the picture; the second says "can\'t reach"; timeouts too', async () => {
    const x = await watcher(HA_ENV);
    ha.set('music');
    await x.w.poll();
    ha.set('slow');
    const t0 = Date.now();
    await x.w.poll();
    assert.ok(Date.now() - t0 < 2000, 'the timeout holds');
    assert.strictEqual(x.cur().state, 'playing');
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().problem], ['error', 'unreachable']);
    x.w.close();
    ha.set('radio');
  });

  await check('only the listed speakers when ALLSOUNDS_ENTITIES is set (one small call each)', async () => {
    const before = Object.assign({}, ha.calls);
    const x = await watcher(Object.assign({}, HA_ENV, { ALLSOUNDS_ENTITIES: 'media_player.kitchen_echo,media_player.gone_echo' }));
    ha.set('radio');
    await x.w.poll();
    assert.strictEqual(x.cur().state, 'idle', 'the living room is not listed');
    assert.strictEqual(x.cur().device, 'Kitchen Echo Dot');
    assert.strictEqual(ha.calls.states, before.states, 'no /api/states');
    assert.strictEqual(ha.calls.one - before.one, 2);
    x.w.close();
  });

  await check('how often it asks: 5 s while playing, 20 s otherwise, backing off on trouble up to 2 minutes', async () => {
    const x = await watcher(HA_ENV);
    ha.set('radio');
    await x.w.poll();
    assert.strictEqual(x.w.debug().delay, 5000);
    ha.set('idle');
    await x.w.poll();
    assert.strictEqual(x.w.debug().delay, 20000);
    ha.set('down');
    await x.w.poll();
    assert.strictEqual(x.w.debug().delay, 40000);
    for (let i = 0; i < 6; i++) await x.w.poll();
    assert.strictEqual(x.w.debug().delay, 120000);
    x.w.close();
    ha.set('radio');
    const n = await watcher({});
    assert.strictEqual(n.w.debug().delay, 0, 'not set up: never asks');
    assert.strictEqual(n.cur().state, 'notset');
  });

  /* ---------- in the hub server ---------- */

  const allLogs = [];
  async function start(extra) {
    const o = Object.assign({
      token: TOKEN, port: 0, host: '127.0.0.1', dataDir: tmpDir(), log: (s) => allLogs.push(s),
      allsoundsEnv: HA_ENV, allsounds: { allowHttp: true, manual: true, timeoutMs: 400 }
    }, extra || {});
    const h = hubServer.start(o);
    await h.ready;
    return h;
  }
  const stop = (h) => new Promise((r) => h.close(r));
  const live = async (h) => (await request(h.port, 'GET', '/live/state')).json.resources.allsounds;

  await check('server: the resource is on the live line; GET /api/allsounds; ./hub words', async () => {
    const h = await start();
    ha.set('radio');
    await h.allsounds.poll();
    const r = await live(h);
    assert.strictEqual(r.data.state, 'playing');
    assert.strictEqual(r.data.source, 'TuneIn');
    const rev = r.rev;
    await h.allsounds.poll();
    assert.strictEqual((await live(h)).rev, rev, 'no change: same rev');
    const st = await request(h.port, 'GET', '/api/allsounds', TOKEN);
    assert.strictEqual(st.status, 200);
    assert.deepStrictEqual(Object.keys(st.json.allsounds).sort(), ['configured', 'device', 'haProblem', 'problem', 'source', 'state', 'title', 'artist'].sort());
    const lines = hubctl.allsoundsStatusLines(st.json.allsounds);
    assert.deepStrictEqual(lines, ['All sounds: playing from TuneIn on Living room Echo.', 'Now: "Morning Edition".']);
    assert.strictEqual((await request(h.port, 'GET', '/api/allsounds')).status, 401, 'needs the hub token');
    await stop(h);
    assert.deepStrictEqual(hubctl.allsoundsStatusLines({ configured: false, problem: '', state: 'notset' }),
      ['All sounds: not set up (add HA_TOKEN to pi/.env, then docker compose restart hub).']);
    assert.ok(/needs an update/.test(hubctl.allsoundsStatusLines(undefined)[0]));
    assert.deepStrictEqual(hubctl.allsoundsStatusLines({ configured: true, state: 'error', haProblem: 'auth' }),
      ['All sounds: Home Assistant refused the token (make a new one, put it in pi/.env as HA_TOKEN).']);
    assert.deepStrictEqual(hubctl.allsoundsStatusLines({ configured: true, state: 'paused', source: 'Amazon Music', device: 'Kitchen', title: 'A', artist: 'B' }),
      ['All sounds: paused, from Amazon Music on Kitchen.', 'Now: "A" by B.']);
  });

  await check('server: not set up by default; an old state file without the resource; a damaged one cleaned', async () => {
    const h = await start({ allsoundsEnv: {} });
    assert.strictEqual((await live(h)).data.state, 'notset');
    await stop(h);
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ epoch: 'abc', rev: 3, resources: { todo: { rev: 1, data: { items: [] } }, allsounds: { rev: 2, data: { state: 'playing', title: 'x'.repeat(900), art: '/api/x?token=1' } } } }));
    const h2 = await start({ dataDir: dir, allsoundsEnv: {} });
    const d = (await live(h2)).data;
    assert.ok(d.title.length <= 200 && d.art === '', JSON.stringify(d).slice(0, 80));
    await stop(h2);
  });

  await check('server: Spotify playing shows in All sounds at once and wins over the house; Now Playing unchanged', async () => {
    const h = await start({
      spotifyEnv: { SPOTIFY_CLIENT_ID: CLIENT_ID, SPOTIFY_CLIENT_SECRET: CLIENT_SECRET, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8097/spotify/callback' },
      spotify: { accounts: sp.url, api: sp.url, vibe: sp.url, allowHttp: true, manual: true, vibeOff: true }
    });
    ha.set('radio');
    await h.allsounds.poll();
    assert.strictEqual((await live(h)).data.source, 'TuneIn');
    sp.set('playing');
    const l = h.spotify.loginUrl();
    const landed = await new Promise((resolve, reject) => http.get(l.url, (res) => { res.resume(); resolve(res.headers.location || ''); }).on('error', reject));
    await h.spotify.finishLogin(landed);
    const d = (await live(h)).data;
    assert.strictEqual(d.source, 'Spotify');
    assert.strictEqual(d.from, 'spotify');
    assert.strictEqual(d.title, 'Golden Hour Drive');
    const np = (await request(h.port, 'GET', '/live/state')).json.resources.nowplaying.data;
    assert.strictEqual(np.state, 'playing', 'Now Playing has its own resource, as before');
    assert.ok(np.track && np.track.title === 'Golden Hour Drive');
    sp.set('idle');
    await h.spotify.poll();
    assert.strictEqual((await live(h)).data.source, 'TuneIn', 'the house again');
    await stop(h);
  });

  await check('mailbox: allsounds.status exists, takes no args, and says the same as ./hub', async () => {
    const C = mailbox.COMMANDS;
    assert.ok(C['allsounds.status']);
    assert.deepStrictEqual(Object.keys(C['allsounds.status'].args), []);
    const h = await start();
    ha.set('music');
    await h.allsounds.poll();
    const call = async (method, route, body) => {
      const r = await h.api(method, route, body);
      if (!r.body.ok) throw new Error(r.body.error);
      return r.body;
    };
    const out = await C['allsounds.status'].run({}, { call: call });
    assert.strictEqual(out.message, 'All sounds: playing from Amazon Music on Living room Echo.\nNow: "Golden Hour Drive" by The Lanterns.');
    assert.deepStrictEqual(Object.keys(out.data.allsounds).sort(), ['artist', 'device', 'source', 'state', 'title']);
    await stop(h);
  });

  /* ---------- what the hub started (echo.js labels) ---------- */

  const SHOW_ID = 'media_player.ian_s_echo_show';
  const mkLabel = (o) => Object.assign({ app: 'audible', label: 'Audible', title: '', hidden: true, at: Date.now() - 1000, playing: true, via: '', base: null }, o || {});
  function labelled(map, extra) {
    const calls = { cleared: [], bases: [] };
    const store = JSON.parse(JSON.stringify(map));
    const hooks = {
      labels: () => JSON.parse(JSON.stringify(store)),
      clearLabel: (id, why) => { calls.cleared.push([id, why]); delete store[id]; },
      setBase: (id, sig) => { calls.bases.push([id, sig]); if (store[id]) store[id].base = sig; }
    };
    return watcher(HA_ENV, Object.assign(hooks, extra || {})).then((x) => Object.assign(x, { calls: calls, store: store }));
  }

  await check('labels: a hidden one (Audible) hides AMP\'s stale title, says started, keeps the Echo\'s name; the first sight sets the base', async () => {
    ha.set('stale');
    const x = await labelled({ [SHOW_ID]: mkLabel() });
    await x.w.poll();
    let d = x.cur();
    assert.deepStrictEqual([d.state, d.from, d.source, d.title, d.artist, d.album, d.art, d.started, d.stale, d.device],
      ['playing', 'echo', 'Audible', '', '', '', '', true, false, 'Ian\'s Echo Show']);
    assert.strictEqual(x.calls.bases.length, 1);
    assert.strictEqual(x.calls.bases[0][0], SHOW_ID);
    assert.strictEqual(x.calls.bases[0][1], JSON.stringify(['Golden Hour Drive', 'The Lanterns', ha.url + '/art/album.svg']));
    await x.w.poll();
    assert.strictEqual(x.calls.bases.length, 1, 'the base is set once');
    assert.strictEqual(x.cur().started, true);
    // Paused by the hub's own pause: shown paused, whatever AMP's stale state says.
    x.store[SHOW_ID].playing = false;
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().started, x.cur().source], ['paused', true, 'Audible']);
    // A group start: shown on "Everywhere".
    x.store[SHOW_ID].playing = true;
    x.store[SHOW_ID].via = 'Everywhere';
    await x.w.poll();
    assert.strictEqual(x.cur().device, 'Everywhere');
    // Something else clearly starts (a new picture): the label goes and the real data shows.
    ha.set('amazonmusic');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual(x.calls.cleared, [[SHOW_ID, 'other']]);
    assert.deepStrictEqual([d.source, d.title, d.started], ['Amazon Music', 'Golden Hour Drive', false]);
    x.w.close();
  });

  await check('labels: a hidden one stays over an empty Echo (idle, off) and wins over an older speaker', async () => {
    ha.set('npr');
    const x = await labelled({ [SHOW_ID]: mkLabel({ base: JSON.stringify(['Golden Hour Drive', 'The Lanterns', 'x']) }) });
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().source, x.cur().started, x.calls.cleared.length], ['playing', 'Audible', true, 0]);
    x.w.close();
    ha.set('radio');
    const y = await labelled({ 'media_player.kitchen_echo': mkLabel({ app: 'news', label: 'Alexa news', base: '[]' }) });
    await y.w.poll();
    assert.deepStrictEqual([y.cur().source, y.cur().device, y.cur().started], ['Alexa news', 'Kitchen Echo Dot', true], 'newer than the living room\'s radio');
    y.w.close();
  });

  await check('labels: a visible one (Pandora, TuneIn) keeps the real data, fills the source and title, and clears when another platform shows', async () => {
    ha.set('pandora');
    // In its first 45 seconds another platform on the Echo is Alexa catching
    // up: the label holds.
    let x = await labelled({ [SHOW_ID]: mkLabel({ app: 'pandora', label: 'Pandora', hidden: false }) });
    ha.set('amazonmusic');
    await x.w.poll();
    let d = x.cur();
    assert.deepStrictEqual([d.source, d.started, x.calls.cleared.length], ['Pandora', true, 0], 'grace');
    x.w.close();
    ha.set('pandora');
    x = await labelled({ [SHOW_ID]: mkLabel({ app: 'pandora', label: 'Pandora', hidden: false, at: Date.now() - 60000 }) });
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.source, d.title, d.artist, d.started, x.calls.cleared.length], ['Pandora', 'Golden Hour Drive', 'The Lanterns', true, 0]);
    ha.set('amazonmusic');
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual(x.calls.cleared, [[SHOW_ID, 'other']]);
    assert.deepStrictEqual([d.source, d.started], ['Amazon Music', false]);
    x.w.close();
    // KERA on TuneIn: no title in its first seconds, so the label's stands in.
    ha.set('tuneinstart');
    x = await labelled({ [SHOW_ID]: mkLabel({ app: 'kera', label: 'TuneIn', title: 'KERA 90.1', hidden: false, via: 'Everywhere' }) });
    await x.w.poll();
    d = x.cur();
    assert.deepStrictEqual([d.source, d.title, d.started, d.device, d.state], ['TuneIn', 'KERA 90.1', true, 'Everywhere', 'playing']);
    ha.set('tunein');
    await x.w.poll();
    assert.deepStrictEqual([x.cur().title, x.cur().source, x.cur().started], ['KERA', 'TuneIn', true], 'the real title once it has one');
    x.w.close();
    // The Echo says idle: a fresh label shows as playing or paused, an old one clears.
    ha.set('npr');
    x = await labelled({ [SHOW_ID]: mkLabel({ app: 'pandora', label: 'Pandora', hidden: false, playing: false }) });
    await x.w.poll();
    assert.deepStrictEqual([x.cur().state, x.cur().source, x.cur().started], ['paused', 'Pandora', true]);
    x.w.close();
    x = await labelled({ [SHOW_ID]: mkLabel({ app: 'pandora', label: 'Pandora', hidden: false, at: Date.now() - 11 * 60000 }) });
    await x.w.poll();
    assert.deepStrictEqual(x.calls.cleared, [[SHOW_ID, 'other']]);
    assert.strictEqual(x.cur().started, false);
    x.w.close();
  });

  await check('labels: Spotify\'s stale "playing" on the same Echo loses to a labelled Echo; a different speaker still wins', async () => {
    ha.set('stale');
    const np = (device) => ({ state: 'playing', track: { title: 'Old Song', artist: 'Someone', album: 'A' }, device: { name: device } });
    let x = await labelled({ [SHOW_ID]: mkLabel() }, { spotify: () => np('Ian\'s Echo Show') });
    await x.w.poll();
    assert.deepStrictEqual([x.cur().from, x.cur().source, x.cur().started], ['echo', 'Audible', true]);
    x.w.close();
    x = await labelled({ [SHOW_ID]: mkLabel() }, { spotify: () => np('Living room speaker') });
    await x.w.poll();
    assert.deepStrictEqual([x.cur().from, x.cur().started], ['spotify', false]);
    x.w.close();
    const house = { v: 1, state: 'playing', from: 'echo', source: 'Audible', device: 'Echo', title: '', artist: '', album: '', art: '', problem: '', stale: false, started: true };
    const sp = allsounds.fromSpotify(np('echo'));
    assert.strictEqual(allsounds.merge(house, sp), house);
    assert.strictEqual(allsounds.merge(Object.assign({}, house, { started: false }), sp), sp, 'an unlabelled, title-less house does not beat Spotify');
  });

  await check('labels: started only for an Echo that plays or pauses; the resource keeps v 1; no label code, no change', async () => {
    const base = Object.assign(allsounds.notsetData(), { state: 'playing', from: 'echo', source: 'Audible', device: 'E', started: true });
    assert.strictEqual(allsounds.cleanData(base).started, true);
    assert.strictEqual(allsounds.cleanData(Object.assign({}, base, { state: 'paused' })).started, true);
    assert.strictEqual(allsounds.cleanData(Object.assign({}, base, { state: 'idle' })).started, false);
    assert.strictEqual(allsounds.cleanData(Object.assign({}, base, { from: 'spotify' })).started, false);
    assert.strictEqual(allsounds.cleanData(Object.assign({}, base, { started: 'yes' })).started, false);
    assert.strictEqual(allsounds.notsetData().started, false);
    assert.strictEqual(allsounds.notsetData().v, 1);
    ha.set('amazonmusic');
    const x = await watcher(HA_ENV);
    await x.w.poll();
    assert.strictEqual(x.cur().started, false);
    x.w.close();
  });

  await check('server: labels from Echo controls reach the TV resource and clear when something else plays; mailbox echo.* with a bad level is refused', async () => {
    const C = mailbox.COMMANDS;
    assert.throws(() => mailbox.checkEnvelope('abcdef12', Buffer.from(JSON.stringify({ id: 'abcdef12', created: new Date().toISOString(), cmd: 'echo.volume', args: { level: 101 } })), Date.now()), /"level" must be a whole number from 0 to 100/);
    assert.throws(() => mailbox.checkEnvelope('abcdef12', Buffer.from(JSON.stringify({ id: 'abcdef12', created: new Date().toISOString(), cmd: 'echo.start', args: { app: 'audible', query: 'x' } })), Date.now()), /does not take a query/);
    assert.ok(C['echo.start'] && C['echo.volume']);
    ha.set('stale');
    ha.serviceStatus = 0;
    const h = await start({ echoEnv: HA_ENV });
    const r = await h.echo.start('audible', 'show');
    assert.strictEqual(r.ok, true);
    await h.allsounds.poll();
    let d = (await live(h)).data;
    assert.deepStrictEqual([d.source, d.title, d.started], ['Audible', '', true]);
    ha.set('amazonmusic');
    await h.allsounds.poll();
    d = (await live(h)).data;
    assert.deepStrictEqual([d.source, d.started], ['Amazon Music', false]);
    assert.deepStrictEqual(h.echo.labels(), {}, 'the label is gone');
    await stop(h);
  });

  await check('the token, Home Assistant addresses and titles never reach a log; no token or HA address reaches a screen', async () => {
    const h = await start();
    for (const m of ['radio', 'music', 'paused', 'long', 'amazonmusic', 'pandora', 'tunein', 'tuneinstart', 'stale', 'npr', 'idle', 'unauthorized', 'down', 'broken', 'radio']) {
      ha.set(m);
      await h.allsounds.poll();
      await h.allsounds.poll();
      const state = (await request(h.port, 'GET', '/live/state')).text;
      [ha.token, 'abc123', 'media_player_proxy', 'Authorization'].forEach((bad) => assert.ok(state.indexOf(bad) < 0, m + ': ' + bad + ' reached the screen'));
    }
    await stop(h);
    const text = logs.concat(allLogs).join('\n');
    [ha.token, ha.url, '127.0.0.1:' + ha.url.split(':').pop(), 'Morning Edition', 'Golden Hour Drive', 'Canción', 'Lanterns', 'KERA',
      'Living room', 'Kitchen', 'Echo Show', 'Ian', 'Amazon', 'TuneIn', 'iHeart', 'Pandora', 'p-cdn', 'Bearer'].forEach((bad) => {
      assert.ok(text.indexOf(bad) < 0, 'the log has "' + bad + '"');
    });
    // Every All sounds line is one of the fixed ones.
    const FIXED = [
      /^allsounds: watching Home Assistant( \(\d+ listed speakers\))?$/, /^allsounds: off \(no HA_TOKEN in \.env\)$/,
      /^allsounds: off \((HA_TOKEN does not look like a Home Assistant token|HA_URL does not look right \(it is like http:\/\/127\.0\.0\.1:8123\)|ALLSOUNDS_ENTITIES must be media_player ids, separated by commas|ALLSOUNDS_ENTITIES lists more than 12)\)$/,
      /^allsounds: playing from (Spotify|an Echo)$/, /^allsounds: paused$/, /^allsounds: nothing playing$/,
      /^allsounds: Home Assistant refused the token \(401\)$/, /^allsounds: Home Assistant could not be reached$/,
      /^allsounds: Home Assistant sent a reply that could not be read$/, /^allsounds: Home Assistant answered HTTP \d+$/,
      /^allsounds: Home Assistant timed out$/, /^allsounds: Home Assistant working again$/, /^allsounds: unexpected problem$/
    ];
    const ours = logs.concat(allLogs).filter((l) => /^allsounds:/.test(l));
    assert.ok(ours.length > 5, 'some lines were logged');
    ours.forEach((l) => assert.ok(FIXED.some((re) => re.test(l)), 'not a fixed line: ' + l));
  });

  await ha.close();
  await sp.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
