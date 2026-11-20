/*
 * A stand-in for Home Assistant's REST API, for tests and screenshots of the
 * All sounds widget (pi/allsounds.js, app/widgets/allsounds.js). It answers:
 *
 *   GET /api/states            every entity: Echo speakers as media_player.*
 *                              (in the Alexa Media Player integration's shapes)
 *                              plus a few other entities to skip
 *   GET /api/states/<id>       one entity, 404 when unknown
 *   POST /api/services/<domain>/<service>   a service call: answers 200 with [] and
 *                              records it (see ha.services); ha.serviceStatus can
 *                              make it answer another status (401, 500...)
 *   GET /art/<name>.svg        made-up cover pictures (with CORS)
 *
 * Every /api call needs "Authorization: Bearer <token>" (401 otherwise, as
 * Home Assistant does). Nothing here reaches the internet or Amazon.
 *
 *   const ha = await require('./mock-ha').start({ token });
 *   ha.url                 'http://127.0.0.1:PORT'
 *   ha.token               the token it wants
 *   ha.set('radio')        radio | music | paused | idle | off | long |
 *                          amazonmusic, pandora, tunein, tuneinstart, npr (shapes seen
 *                          on a real Echo Show, 2026-11-17: Amazon Music with
 *                          title and picture but no source or app name; TuneIn
 *                          with the station name as the title and a picture,
 *                          no artist, album or source; tuneinstart is TuneIn's
 *                          first seconds, playing with nothing at all; NPR
 *                          reported as idle) | stale (an Echo still
 *                          "playing" a song that ended minutes ago, as when
 *                          Audible takes over) | twoplaying (the Echo Show plays KERA on
 *                          TuneIn at 35%, the Echo Dot an iHeartRadio stream at 60%) |
 *                          unauthorized (401 to everything) | down (drops the
 *                          connection) | slow (never answers) | broken (not JSON)
 *   ha.calls               { states, one, art } counters
 *   ha.services            [{ domain, service, body }] every service call seen
 *   ha.serviceStatus       0 (answer 200) or the status to answer service calls with
 *   ha.lastAuth            the last Authorization header it saw
 *   ha.close()
 */
'use strict';

const http = require('http');

const MODES = ['radio', 'music', 'paused', 'idle', 'off', 'long', 'amazonmusic', 'pandora', 'tunein', 'tuneinstart', 'npr', 'stale', 'twoplaying', 'unauthorized', 'down', 'slow', 'broken'];
// The real picture hosts of the two samples. They do not resolve here: a test
// browser answers them itself (see dev/allsounds-test.js), keyed by the cover
// name in /art/<name>.svg.
const AMAZON_ART = 'https://m.media-amazon.com/images/I/51GoldenHourDrive._SX300_.jpg';
const PANDORA_ART = 'https://content-images.p-cdn.com/images/public/int/5/1/2/golden-hour-drive_500W_500H.jpg';
const ART_HOSTS = { 'm.media-amazon.com': 'album', 'content-images.p-cdn.com': 'album', 'i.iheart.com': 'long' };
const TOKEN = 'mock-ha-token-not-a-secret-0123456789abcdef';

// Two made-up covers: a radio show's square logo and an album.
const ART = {
  radio: ['#0f4c5c', '#e36414', 'ON AIR'],
  album: ['#3a0ca3', '#f72585', 'LP'],
  long: ['#264653', '#e9c46a', 'Ñ']
};

function svg(name) {
  const a = ART[name] || ART.album;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + a[0] + '"/><stop offset="1" stop-color="' + a[1] + '"/></linearGradient></defs>' +
    '<rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="78" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="10"/>' +
    '<text x="150" y="162" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">' + a[2] + '</text></svg>';
}

function stamp(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60000).toISOString();
}

// An Echo as Alexa Media Player shows it (last_called, bluetooth_list...).
function speaker(id, name, state, attrs, minutesAgo) {
  return {
    entity_id: 'media_player.' + id, state: state,
    attributes: Object.assign({
      friendly_name: name, supported_features: 56253, available: true, last_called: false,
      bluetooth_list: [], history_records: [], volume_level: 0.4,
      media_content_type: state === 'idle' ? 'idle' : 'music'
    }, attrs || {}),
    last_changed: stamp(minutesAgo), last_updated: stamp(minutesAgo)
  };
}

// The house in each mode. base is the stand-in's own address, for pictures.
function entities(mode, base) {
  // Not Echo speakers: a TV and a browser_mod panel that are playing, and
  // Alexa's "everywhere" group. None of these may ever be picked.
  const others = [
    { entity_id: 'sun.sun', state: 'above_horizon', attributes: { friendly_name: 'Sun' }, last_changed: stamp(90) },
    { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living room lights' }, last_changed: stamp(30) },
    { entity_id: 'media_player.living_room_tv', state: 'playing', attributes: { friendly_name: 'Living room TV', media_title: 'A TV show', app_name: 'Netflix' }, last_changed: stamp(1) },
    { entity_id: 'media_player.browser_mod_kitchen', state: 'playing', attributes: { friendly_name: 'Kitchen panel', media_title: 'Panel sound' }, last_changed: stamp(1) },
    { entity_id: 'media_player.everywhere', state: 'playing', attributes: { friendly_name: 'Everywhere', media_title: 'Group copy', last_called: false }, last_changed: stamp(0) }
  ];
  if (mode === 'amazonmusic' || mode === 'pandora' || mode === 'tunein' || mode === 'tuneinstart' || mode === 'npr' || mode === 'stale' || mode === 'twoplaying') {
    const dot = mode === 'twoplaying'
      ? speaker('ian_s_echo_dot', 'Ian\'s Echo Dot', 'playing', {
        media_title: 'Classic Rock 101', media_artist: null, media_album_name: null, volume_level: 0.6,
        entity_picture: 'https://i.iheart.com/v3/re/new_assets/radio.png'
      }, 5)
      : speaker('ian_s_echo_dot', 'Ian\'s Echo Dot', 'idle', {}, 200);
    let show;
    if (mode === 'twoplaying') {
      show = speaker('ian_s_echo_show', 'Ian\'s Echo Show', 'playing', {
        media_title: 'KERA', media_artist: null, media_album_name: null, volume_level: 0.35,
        entity_picture: base + '/art/radio.svg'
      }, 2);
    } else if (mode === 'amazonmusic' || mode === 'pandora') {
      show = speaker('ian_s_echo_show', 'Ian\'s Echo Show', 'playing', {
        media_title: 'Golden Hour Drive', media_artist: 'The Lanterns', media_album_name: 'Slow Coast',
        media_duration: 214, media_position: 62, media_position_updated_at: stamp(0),
        entity_picture: mode === 'pandora' ? PANDORA_ART : AMAZON_ART, entity_picture_local: '/api/media_player_proxy/media_player.ian_s_echo_show?token=abc123'
      }, 2);
    } else if (mode === 'tunein') {
      show = speaker('ian_s_echo_show', 'Ian\'s Echo Show', 'playing', {
        media_title: 'KERA', media_artist: null, media_album_name: null,
        entity_picture: base + '/art/radio.svg', entity_picture_local: '/api/media_player_proxy/media_player.ian_s_echo_show?token=abc123'
      }, 2);
    } else if (mode === 'stale') {
      // Audible took over and Alexa Media Player kept the last song: still
      // "playing" a 3:34 song whose position was 1:02 ten minutes ago.
      show = speaker('ian_s_echo_show', 'Ian\'s Echo Show', 'playing', {
        media_title: 'Golden Hour Drive', media_artist: 'The Lanterns', media_album_name: 'Slow Coast',
        media_duration: 214, media_position: 62, media_position_updated_at: stamp(10),
        entity_picture: base + '/art/album.svg'
      }, 12);
    } else if (mode === 'tuneinstart') {
      show = speaker('ian_s_echo_show', 'Ian\'s Echo Show', 'playing', {}, 0);
    } else {
      show = speaker('ian_s_echo_show', 'Ian\'s Echo Show', 'idle', {}, 2);
    }
    return others.concat([show, dot]);
  }
  const kitchen = speaker('kitchen_echo', 'Kitchen Echo Dot', 'idle', { source: 'Local Speaker' }, 120);
  const bedroom = speaker('bedroom_echo', 'Bedroom Echo', 'unavailable', {}, 600);
  let living;
  if (mode === 'radio') {
    living = speaker('living_room_echo', 'Living room Echo', 'playing', {
      media_content_type: 'music', media_title: 'Morning Edition', media_artist: '',
      media_album_name: 'KERA 90.1 Dallas', source: 'TuneIn', app_name: 'TuneIn',
      entity_picture: base + '/art/radio.svg'
    }, 4);
  } else if (mode === 'music' || mode === 'paused') {
    living = speaker('living_room_echo', 'Living room Echo', mode === 'paused' ? 'paused' : 'playing', {
      media_content_type: 'music', media_title: 'Golden Hour Drive', media_artist: 'The Lanterns',
      media_album_name: 'Slow Coast', source: 'Amazon Music', entity_picture: base + '/art/album.svg'
    }, 3);
  } else if (mode === 'long') {
    living = speaker('living_room_echo', 'Echo de la sala de estar (planta baja)', 'playing', {
      media_content_type: 'music',
      media_title: 'Canción para una mañana de otoño en Ciudad de México (Versión acústica en vivo)',
      media_artist: 'Los Ángeles del Sur, María José Peñalosa, Ñengo Ávila',
      media_album_name: 'Corazón, raíz y añoranza: edición de aniversario', source: 'iHeartRadio',
      entity_picture: base + '/art/long.svg'
    }, 2);
  } else if (mode === 'idle') {
    living = speaker('living_room_echo', 'Living room Echo', 'idle', { source: 'Local Speaker' }, 40);
  } else {
    living = speaker('living_room_echo', 'Living room Echo', 'off', {}, 300);
    kitchen.state = 'off';
  }
  // A speaker with a picture only Home Assistant can serve (a relative
  // address that needs the token): it must never reach the TV.
  // Paused long ago, so the living room wins whenever it plays or pauses.
  const office = speaker('office_echo', 'Office Echo', mode === 'off' ? 'off' : mode === 'idle' ? 'idle' : 'paused', {
    media_title: 'Old podcast', media_artist: 'Someone', source: 'Audible',
    entity_picture: '/api/media_player_proxy/media_player.office_echo?token=abc123&cache=1'
  }, 900);
  return others.concat([living, kitchen, bedroom, office]);
}

function start(opts) {
  const o = opts || {};
  const token = o.token || TOKEN;
  let mode = MODES.indexOf(o.mode) >= 0 ? o.mode : 'radio';
  const calls = { states: 0, one: 0, art: 0 };
  const hanging = new Set();
  const api = {
    url: '', token: token, modes: MODES.slice(), calls: calls, lastAuth: '', services: [], serviceStatus: 0,
    set: (m) => { if (MODES.indexOf(m) < 0) return false; mode = m; return true; },
    mode: () => mode
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const m = /^\/art\/([a-z]+)\.svg$/.exec(p);
    if (m) {
      calls.art += 1;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(svg(m[1]));
      return;
    }
    if (p.indexOf('/api/') !== 0) { res.writeHead(404); res.end('not found'); return; }
    api.lastAuth = String(req.headers.authorization || '');
    if (mode === 'down') { req.socket.destroy(); return; }
    if (mode === 'slow') { hanging.add(res); res.on('close', () => hanging.delete(res)); return; }
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (mode === 'unauthorized' || api.lastAuth !== 'Bearer ' + token) { send(401, { message: 'Invalid authentication' }); return; }
    if (mode === 'broken') { send(200, '<html>not json'); return; }
    const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(p);
    if (svc && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { body = null; }
        api.services.push({ domain: svc[1], service: svc[2], body: body });
        if (api.serviceStatus) send(api.serviceStatus, { message: 'service answer ' + api.serviceStatus });
        else send(200, []);
      });
      return;
    }
    const all = entities(mode, api.url);
    if (p === '/api/states') { calls.states += 1; send(200, all); return; }
    const one = /^\/api\/states\/([a-z_]+\.[a-z0-9_]+)$/.exec(p);
    if (one) {
      calls.one += 1;
      const hit = all.filter((e) => e.entity_id === one[1])[0];
      if (hit) send(200, hit); else send(404, { message: 'Entity not found.' });
      return;
    }
    send(404, { message: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      api.url = 'http://127.0.0.1:' + server.address().port;
      api.close = () => new Promise((r) => {
        hanging.forEach((res) => { try { res.socket.destroy(); } catch (e) { /* gone */ } });
        server.close(() => r());
        if (server.closeAllConnections) server.closeAllConnections();
      });
      resolve(api);
    });
  });
}

module.exports = { start: start, MODES: MODES, TOKEN: TOKEN, entities: entities, svg: svg, ART_HOSTS: ART_HOSTS };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 8123, mode: process.argv[2] }).then((ha) => {
    console.log('Pretend Home Assistant on ' + ha.url + ' (token ' + ha.token + ', mode ' + ha.mode() + ')');
  });
}
