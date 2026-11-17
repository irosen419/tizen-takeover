/*
 * A stand-in for Home Assistant's REST API (lights and switches only) and
 * for a WLED controller, for the Ambience tests and screenshots
 * (pi/ambience.js, app/widgets/ambience.js). Everything is made up and
 * stays on this machine.
 *
 * Home Assistant side (every call needs "Authorization: Bearer <token>",
 * 401 otherwise, as Home Assistant does):
 *   GET  /api/states/<entity>                       one entity, 404 when unknown
 *   POST /api/services/light|switch/turn_on|turn_off { entity_id, brightness_pct,
 *                                                    color_temp_kelvin, rgb_color }
 * WLED side (no token, like WLED):
 *   GET  /json/state, POST /json/state
 *
 *   const m = await require('./mock-lights').start({ latency: 0 });
 *   m.url, m.token          Home Assistant's address and the token it wants
 *   m.wledUrl               the WLED stand-in's address
 *   m.entities              the made-up entity ids (light.example_geeni_1 ...)
 *   m.light(entity, mode)   ok | unavailable (the Sengled case) | slow (never
 *                           answers) | refuse (400 to a change) | missing (404)
 *   m.mode(mode)            ok | unauthorized | down (drops connections) |
 *                           slow | broken (not JSON)  for all of Home Assistant
 *   m.wled(mode)            ok | down | slow
 *   m.state(entity)         { state, attributes } as it stands
 *   m.set(entity, on, pct)  change a light behind the hub's back
 *   m.calls                 [{ method, path, body, at, end }] every call seen
 *   m.reset()               all ok, the sample room as at the start
 *   m.close()
 *
 * Run it on its own for the preview: node dev/mock-lights.js (prints the
 * lines to put in the preview's environment).
 */
'use strict';

const http = require('http');

const TOKEN = 'mock-ha-token-not-a-secret-0123456789abcdef';

// The made-up room: two Geeni lamps, four Sengled bulbs (flaky), the camera's
// plug. Names here are what Home Assistant would call them; the hub's own
// names come from data/ambience.json.
function sampleRoom() {
  const lamp = (name, on, bri, k) => ({ state: on ? 'on' : 'off', attributes: Object.assign({ friendly_name: name, supported_color_modes: ['color_temp', 'rs'] }, on ? { brightness: bri, color_temp_kelvin: k, color_mode: 'color_temp' } : {}) });
  return {
    'light.example_geeni_1': lamp('Geeni lamp 1', true, 51, 2200),
    'light.example_geeni_2': lamp('Geeni lamp 2', false),
    'light.example_sengled_1': lamp('Sengled bulb 1', true, 38, 2200),
    'light.example_sengled_2': lamp('Sengled bulb 2', false),
    'light.example_sengled_3': lamp('Sengled bulb 3', false),
    'light.example_sengled_4': lamp('Sengled bulb 4', false),
    'switch.example_camera_plug': { state: 'on', attributes: { friendly_name: 'Camera plug' } }
  };
}

function start(opts) {
  const o = opts || {};
  const latency = o.latency || 0;
  let room = sampleRoom();
  let lightModes = {};
  let haMode = 'ok';
  let wledMode = 'ok';
  let wledState = { on: true, bri: 40 };
  const calls = [];
  const hanging = new Set();

  function send(res, status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  }

  function readBody(req, cb) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let j = null;
      try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (e) { j = undefined; }
      cb(j);
    });
  }

  function hang(res) {
    hanging.add(res);
    res.on('close', () => hanging.delete(res));
  }

  function view(id) {
    const e = room[id];
    return { entity_id: id, state: e.state, attributes: e.attributes, last_changed: new Date().toISOString() };
  }

  function apply(id, domain, service, body) {
    const e = room[id];
    if (service === 'turn_off') {
      e.state = 'off';
      e.attributes = { friendly_name: e.attributes.friendly_name };
      return;
    }
    e.state = 'on';
    if (domain === 'light') {
      const a = Object.assign({}, e.attributes);
      if (typeof body.brightness_pct === 'number') a.brightness = Math.round(body.brightness_pct * 255 / 100);
      else if (typeof a.brightness !== 'number') a.brightness = 255;
      if (typeof body.color_temp_kelvin === 'number') { a.color_temp_kelvin = body.color_temp_kelvin; delete a.rgb_color; a.color_mode = 'color_temp'; }
      if (Array.isArray(body.rgb_color)) { a.rgb_color = body.rgb_color.slice(); delete a.color_temp_kelvin; a.color_mode = 'rgb'; }
      e.attributes = a;
    }
  }

  const haServer = http.createServer((req, res) => {
    const call = { method: req.method, path: req.url, body: null, at: Date.now(), end: 0 };
    calls.push(call);
    res.on('finish', () => { call.end = Date.now(); });
    const go = () => {
      if (haMode === 'down') { req.socket.destroy(); return; }
      if (haMode === 'slow') { hang(res); return; }
      if (req.headers.authorization !== 'Bearer ' + TOKEN || haMode === 'unauthorized') return send(res, 401, '401: Unauthorized');
      if (haMode === 'broken') return send(res, 200, '<html>not json');
      let m = /^\/api\/states\/([a-z_]+\.[a-z0-9_]+)$/.exec(req.url);
      if (m && req.method === 'GET') {
        const id = m[1];
        const mode = lightModes[id] || 'ok';
        if (!room[id] || mode === 'missing') return send(res, 404, { message: 'Entity not found.' });
        if (mode === 'slow') { hang(res); return; }
        if (mode === 'unavailable') return send(res, 200, { entity_id: id, state: 'unavailable', attributes: { friendly_name: room[id].attributes.friendly_name, restored: true } });
        return send(res, 200, view(id));
      }
      m = /^\/api\/services\/(light|switch)\/(turn_on|turn_off)$/.exec(req.url);
      if (m && req.method === 'POST') {
        readBody(req, (body) => {
          call.body = body;
          if (!body || typeof body.entity_id !== 'string') return send(res, 400, { message: 'Invalid JSON' });
          const id = body.entity_id;
          const mode = lightModes[id] || 'ok';
          if (mode === 'slow') { hang(res); return; }
          if (mode === 'refuse') return send(res, 400, { message: 'Bad request for ' + id });
          if (!room[id] || mode === 'missing') return send(res, 400, { message: 'Entity not found' });
          if (id.split('.')[0] !== m[1]) return send(res, 400, { message: 'wrong domain' });
          // An unavailable bulb: Home Assistant takes the call, nothing changes.
          if (mode === 'unavailable') return send(res, 200, []);
          apply(id, m[1], m[2], body);
          return send(res, 200, [view(id)]);
        });
        return;
      }
      send(res, 404, { message: 'not found' });
    };
    if (latency) setTimeout(go, latency); else go();
  });

  const wledServer = http.createServer((req, res) => {
    const call = { method: req.method, path: 'wled:' + req.url, body: null, at: Date.now(), end: 0 };
    calls.push(call);
    res.on('finish', () => { call.end = Date.now(); });
    if (wledMode === 'down') { req.socket.destroy(); return; }
    if (wledMode === 'slow') { hang(res); return; }
    if (req.url !== '/json/state') return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return send(res, 200, Object.assign({ transition: 7, ps: -1, pl: -1, seg: [{ id: 0, fx: 0, pal: 0 }] }, wledState));
    if (req.method === 'POST') {
      readBody(req, (body) => {
        call.body = body;
        if (!body || typeof body !== 'object') return send(res, 400, { error: 9 });
        if (typeof body.on === 'boolean') wledState.on = body.on;
        if (typeof body.bri === 'number') wledState.bri = body.bri;
        send(res, 200, { success: true });
      });
      return;
    }
    send(res, 405, { error: 'method' });
  });

  const listen = (s, port) => new Promise((resolve) => s.listen(port || 0, '127.0.0.1', () => resolve(s.address().port)));
  return Promise.all([listen(haServer, o.port), listen(wledServer, o.wledPort)]).then((ports) => ({
    url: 'http://127.0.0.1:' + ports[0],
    wledUrl: 'http://127.0.0.1:' + ports[1],
    token: TOKEN,
    entities: Object.keys(room),
    calls: calls,
    light: (id, mode) => { lightModes[id] = mode || 'ok'; },
    mode: (m) => { haMode = m || 'ok'; },
    wled: (m) => { wledMode = m || 'ok'; },
    wledState: () => Object.assign({}, wledState),
    state: (id) => (room[id] ? JSON.parse(JSON.stringify(room[id])) : null),
    set: (id, on, pct) => {
      if (!room[id]) return;
      apply(id, id.split('.')[0], on ? 'turn_on' : 'turn_off', pct ? { brightness_pct: pct } : {});
    },
    reset: () => {
      room = sampleRoom();
      lightModes = {};
      haMode = 'ok';
      wledMode = 'ok';
      wledState = { on: true, bri: 40 };
      calls.length = 0;
    },
    close: () => new Promise((resolve) => {
      hanging.forEach((r) => { try { r.destroy(); } catch (e) { /* gone */ } });
      let left = 2;
      const one = () => { if (--left === 0) resolve(); };
      [haServer, wledServer].forEach((s) => {
        s.close(one);
        if (s.closeAllConnections) s.closeAllConnections();
      });
    })
  }));
}

module.exports = { start: start, TOKEN: TOKEN };

if (require.main === module) {
  start({ port: Number(process.env.MOCK_HA_PORT) || 8123, wledPort: Number(process.env.MOCK_WLED_PORT) || 8124 }).then((m) => {
    console.log('Pretend Home Assistant on ' + m.url + ', pretend WLED on ' + m.wledUrl);
    console.log('For the preview: HA_URL=' + m.url + ' HA_TOKEN=' + m.token + ' WLED_URL=' + m.wledUrl);
  });
}
