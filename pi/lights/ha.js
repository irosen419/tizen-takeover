/*
 * Home Assistant for the light engine: save each light's state when music
 * lights start, put it back when they stop, and notice when a light is set
 * another way (the Govee app, a voice command, a Home Assistant scene or
 * automation) so music lights give way instead of fighting it.
 *
 * Settings (pi/.env): HA_TOKEN, HA_URL (default http://127.0.0.1:8123), and
 * each light's entity id in LIGHTS_HA_LAMP (or the older SOUNDLIGHTS_HA_LAMP)
 * and LIGHTS_HA_BARS. Entity ids never appear in a log line or the repo.
 *
 * Noticing a change: after music lights have started and a few seconds have
 * passed (our own start commands settle), the light's state is noted. It is
 * read again every few seconds; a different power, brightness, color mode,
 * color temperature, effect or color means someone else set it. Home
 * Assistant itself only learns of a Govee app change on its next poll of the
 * light, so that can take a little while. LIGHTS_WATCH=power compares power,
 * brightness and effect only (in case the section frames ever show up as a
 * color change); LIGHTS_WATCH=off turns noticing off.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const http = require('http');
const https = require('https');

function defaultHttp(method, url, body, timeoutMs, token) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad Home Assistant address')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = lib.request(u, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 256 * 1024) chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('Home Assistant answered ' + res.statusCode)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Home Assistant did not answer')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function configFromEnv(env, lights) {
  const e = env || {};
  const token = String(e.HA_TOKEN || '').trim();
  const url = (String(e.HA_URL || '').trim() || 'http://127.0.0.1:8123').replace(/\/+$/, '');
  const entities = {};
  Object.keys(lights).forEach((k) => {
    const id = lights[k].haEnv.map((name) => String(e[name] || '').trim()).find((x) => x);
    if (id && /^light\.[a-z0-9_]+$/.test(id)) entities[k] = id;
  });
  const w = String(e.LIGHTS_WATCH || '').trim().toLowerCase();
  return { token: token, url: url, entities: entities, watch: w === 'off' || w === 'power' ? w : 'full', configured: !!token };
}

// The parts of a state that matter, from GET /api/states/<id>.
function readState(st) {
  if (!st || typeof st !== 'object') return null;
  const a = st.attributes || {};
  return {
    on: st.state === 'on',
    available: st.state !== 'unavailable' && st.state !== 'unknown',
    brightness: typeof a.brightness === 'number' ? a.brightness : null,
    colorMode: a.color_mode || null,
    rgb: Array.isArray(a.rgb_color) ? a.rgb_color.slice(0, 3) : null,
    kelvin: typeof a.color_temp_kelvin === 'number' ? a.color_temp_kelvin : null,
    effect: typeof a.effect === 'string' ? a.effect : null
  };
}

// What counts as "someone else set it".
function fingerprint(s, watch) {
  if (!s) return '';
  if (watch === 'power') return JSON.stringify([s.on, s.brightness, s.effect]);
  return JSON.stringify([s.on, s.brightness, s.colorMode, s.kelvin, s.effect, s.rgb]);
}

// The body that puts a saved state back.
function restoreCall(entity, s) {
  if (!s.on) return { service: 'turn_off', body: { entity_id: entity } };
  const body = { entity_id: entity };
  if (s.brightness !== null) body.brightness = Math.round(s.brightness);
  if (s.effect) body.effect = s.effect;
  else if (s.colorMode === 'color_temp' && s.kelvin) body.color_temp_kelvin = Math.round(s.kelvin);
  else if (s.rgb) body.rgb_color = s.rgb.map((v) => Math.round(v));
  else if (s.kelvin) body.color_temp_kelvin = Math.round(s.kelvin);
  return { service: 'turn_on', body: body };
}

function createHa(cfg, opt) {
  const o = opt || {};
  const request = o.http || ((m, u, b, t) => defaultHttp(m, u, b, t, cfg.token));
  const call = (method, p, body, t) => request(method, cfg.url + p, body, t || 2000);
  const has = (key) => !!(cfg.configured && cfg.entities[key]);

  async function snapshot(key) {
    if (!has(key)) return null;
    try { return readState(await call('GET', '/api/states/' + cfg.entities[key])); } catch (e) { return null; }
  }

  async function restore(key, s) {
    if (!has(key) || !s) return false;
    const c = restoreCall(cfg.entities[key], s);
    try { await call('POST', '/api/services/light/' + c.service, c.body, 4000); return true; } catch (e) { return false; }
  }

  return { configured: !!cfg.configured, watch: cfg.watch, has: has, snapshot: snapshot, restore: restore, fingerprint: (s) => fingerprint(s, cfg.watch) };
}

module.exports = {
  configFromEnv: configFromEnv,
  readState: readState,
  fingerprint: fingerprint,
  restoreCall: restoreCall,
  createHa: createHa
};
