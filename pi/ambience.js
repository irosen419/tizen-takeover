/*
 * Ambience: the room's lights from the TV, through Home Assistant, plus the
 * plant wall's WLED controller when there is one. The TV widget
 * (app/widgets/ambience.js) draws the "ambience" resource from here and
 * sends its choices back through the screen API (POST /ambience/scene,
 * /ambience/light, /ambience/mood). The TV never talks to Home Assistant or
 * WLED itself and never sees the token or an address.
 *
 * Settings (pi/.env):
 *   HA_TOKEN   a long-lived access token from Home Assistant (your profile,
 *              Security tab). Without it Ambience is "not set up".
 *   HA_URL     Home Assistant's address; http://127.0.0.1:8123 when left out
 *              (it runs on the same Pi).
 *   WLED_URL   optional: the plant wall's WLED controller, e.g.
 *              http://192.168.1.50 (no token; WLED has none).
 *
 * The lights, scenes and plant wall moods live in data/ambience.json
 * (written from the defaults below when missing; a damaged file is moved
 * aside). ./hub ambience set <file.json> replaces it; see
 * pi/ambience.example.json for the shape.
 *
 * A scene asks every one of its lights at once. A light that does not answer
 * (the Sengled bulbs often drop off the network) never stops the others: the
 * scene is then "partial" and the TV names the light that did not answer.
 *
 * The log only ever gets fixed words and counts (Ian's rule): every line
 * starts "ambience:", and never holds the token, an address, an entity id,
 * a light, scene or mood name, or anything Home Assistant sent back.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:8123';
const REQUEST_MS = 4000;          // per call to Home Assistant or WLED
const MAX_REPLY = 256 * 1024;
const SCREEN_MS = 10000;          // poll while a screen is on
const IDLE_MS = 60000;            // and with none
const MAX_BACKOFF_MS = 5 * 60000;
const FAILS_BEFORE_ERROR = 2;     // one hiccup keeps the last picture
const MAX_CONFIG_BYTES = 8 * 1024;
const MAX_LIGHTS = 12;
const MAX_SCENES = 10;
const MAX_MOODS = 12;
const MAX_NAME = 24;
const MAX_SEGMENTS = 16;
const RATE_EVERY_MS = 400;        // screen commands: one per 400 ms ...
const RATE_BURST = 3;             // ... with a burst of 3
const MATCH_PCT = 5;              // a light still "in the scene" within 5 points
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const ENTITY_RE = /^(light|switch)\.[a-z0-9_]{1,80}$/;
const ICONS = ['moon', 'sun', 'book', 'film', 'power', 'sparkle', 'bulb', 'leaf', 'sofa', 'bed'];
const STATES = ['notset', 'ok', 'error'];
const PROBLEMS = ['', 'noha', 'nolights', 'auth', 'unreachable', 'reply'];
const RESULTS = ['ok', 'partial', 'failed'];
const FILE = 'ambience.json';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// One plain line: no control or invisible characters, spaces squeezed.
function cleanName(v, max) {
  const t = str(v).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

/* ---------- settings from .env ---------- */

function cleanUrl(raw) {
  const s = str(raw).trim().replace(/\/+$/, '');
  let u = null;
  try { u = new URL(s); } catch (e) { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return '';
  return s;
}

// { configured, problem, url, token, wledUrl }. problem is a fixed phrase,
// never what was given.
function configFromEnv(env) {
  const e = env || {};
  const token = str(e.HA_TOKEN).trim();
  const wledRaw = str(e.WLED_URL).trim();
  const wledUrl = wledRaw ? cleanUrl(wledRaw) : '';
  const wledProblem = wledRaw && !wledUrl ? 'WLED_URL does not look right (it is like http://192.168.1.50)' : '';
  if (!token) return { configured: false, problem: '', wledUrl: wledUrl, wledProblem: wledProblem };
  if (!/^[A-Za-z0-9._-]{20,2000}$/.test(token)) {
    return { configured: false, problem: 'HA_TOKEN does not look like a Home Assistant token', wledUrl: wledUrl, wledProblem: wledProblem };
  }
  const url = cleanUrl(str(e.HA_URL).trim() || DEFAULT_URL);
  if (!url) return { configured: false, problem: 'HA_URL does not look right (it is like http://127.0.0.1:8123)', wledUrl: wledUrl, wledProblem: wledProblem };
  return { configured: true, problem: '', url: url, token: token, wledUrl: wledUrl, wledProblem: wledProblem };
}

/* ---------- the saved lights, scenes and moods ---------- */

// The built-in defaults: no lights (the TV says "Set up lights"), so no
// scenes; three plant wall moods that only use on and brightness, which mean
// the same on every WLED build (effect and palette numbers do not).
function defaultConfig() {
  return {
    lights: [],
    scenes: [],
    moods: [
      { id: 'off', name: 'Off', state: { on: false } },
      { id: 'dim', name: 'Dim', state: { on: true, bri: 40 } },
      { id: 'bright', name: 'Bright', state: { on: true, bri: 200 } }
    ]
  };
}

function onlyKeys(o, allowed, what) {
  Object.keys(o).forEach((k) => {
    if (allowed.indexOf(k) < 0) throw bad(what + ' has an unknown field "' + k.slice(0, 24) + '" (allowed: ' + allowed.join(', ') + ')');
  });
}

function checkId(v, what) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw bad(what + ' needs an "id" of 1 to 32 characters: a-z, 0-9, _ or -');
  return v;
}

function checkName(v, what) {
  const n = cleanName(v, 1000);
  if (!n) throw bad(what + ' needs a "name"');
  if (Array.from(n).length > MAX_NAME) throw bad(what + ' has a name longer than ' + MAX_NAME + ' characters');
  return n;
}

function checkMoodState(s, what) {
  if (!isObj(s)) throw bad(what + ' needs a "state" object (a WLED /json/state body)');
  onlyKeys(s, ['on', 'bri', 'ps', 'transition', 'seg'], what + "'s state");
  const out = {};
  if (s.on !== undefined) { if (typeof s.on !== 'boolean') throw bad(what + ': "on" must be true or false'); out.on = s.on; }
  if (s.bri !== undefined) { if (!isInt(s.bri, 0, 255)) throw bad(what + ': "bri" must be a whole number from 0 to 255'); out.bri = s.bri; }
  if (s.ps !== undefined) { if (!isInt(s.ps, -1, 250)) throw bad(what + ': "ps" must be a whole number from -1 to 250'); out.ps = s.ps; }
  if (s.transition !== undefined) {
    if (!isInt(s.transition, 0, 255)) throw bad(what + ': "transition" must be a whole number from 0 to 255');
    out.transition = s.transition;
  }
  if (s.seg !== undefined) {
    if (!Array.isArray(s.seg) || s.seg.length > MAX_SEGMENTS) throw bad(what + ': "seg" must be a list of at most ' + MAX_SEGMENTS + ' segments');
    out.seg = s.seg.map((g) => {
      if (!isObj(g)) throw bad(what + ': each segment must be an object');
      onlyKeys(g, ['id', 'on', 'bri', 'col', 'fx', 'sx', 'ix', 'pal'], what + "'s segment");
      const o = {};
      if (g.id !== undefined) { if (!isInt(g.id, 0, 31)) throw bad(what + ': a segment "id" must be 0 to 31'); o.id = g.id; }
      if (g.on !== undefined) { if (typeof g.on !== 'boolean') throw bad(what + ': a segment "on" must be true or false'); o.on = g.on; }
      ['bri', 'fx', 'sx', 'ix', 'pal'].forEach((k) => {
        if (g[k] === undefined) return;
        if (!isInt(g[k], 0, 255)) throw bad(what + ': a segment "' + k + '" must be a whole number from 0 to 255');
        o[k] = g[k];
      });
      if (g.col !== undefined) {
        if (!Array.isArray(g.col) || g.col.length > 3) throw bad(what + ': a segment "col" must be a list of up to 3 colours');
        o.col = g.col.map((c) => {
          if (!Array.isArray(c) || (c.length !== 3 && c.length !== 4) || !c.every((n) => isInt(n, 0, 255))) {
            throw bad(what + ': each colour in "col" must be [r, g, b] (or [r, g, b, w]) of 0 to 255');
          }
          return c.slice();
        });
      }
      return o;
    });
  }
  if (!Object.keys(out).length) throw bad(what + "'s state is empty");
  return out;
}

// Checks and tidies a whole config. Throws a 400 error with a readable
// reason that never repeats a token or an address (there are none in it).
function validateConfig(c) {
  if (!isObj(c)) throw bad('the settings must be a JSON object with "lights", "scenes" and "moods"');
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(c)); } catch (e) { throw bad('the settings could not be read'); }
  if (bytes > MAX_CONFIG_BYTES) throw bad('the settings are larger than 8 KB');
  onlyKeys(c, ['lights', 'scenes', 'moods'], 'the settings');
  const lightsIn = c.lights === undefined ? [] : c.lights;
  const scenesIn = c.scenes === undefined ? [] : c.scenes;
  const moodsIn = c.moods === undefined ? [] : c.moods;
  if (!Array.isArray(lightsIn) || lightsIn.length > MAX_LIGHTS) throw bad('"lights" must be a list of at most ' + MAX_LIGHTS);
  if (!Array.isArray(scenesIn) || scenesIn.length > MAX_SCENES) throw bad('"scenes" must be a list of at most ' + MAX_SCENES);
  if (!Array.isArray(moodsIn) || moodsIn.length > MAX_MOODS) throw bad('"moods" must be a list of at most ' + MAX_MOODS);

  const lights = [];
  const lightIds = {};
  const entities = {};
  lightsIn.forEach((l, i) => {
    const what = 'light ' + (i + 1);
    if (!isObj(l)) throw bad(what + ' must be an object');
    onlyKeys(l, ['id', 'name', 'entity', 'flaky', 'kind'], what);
    const id = checkId(l.id, what);
    if (lightIds[id]) throw bad(what + ' has the same id as another light');
    const name = checkName(l.name, what);
    if (typeof l.entity !== 'string' || !ENTITY_RE.test(l.entity)) {
      throw bad(what + ' needs an "entity" like light.desk_lamp or switch.camera_plug');
    }
    if (entities[l.entity]) throw bad(what + ' uses the same entity as another light');
    const domain = l.entity.split('.')[0];
    const kind = l.kind === undefined ? domain : l.kind;
    if (kind !== 'light' && kind !== 'switch') throw bad(what + ': "kind" must be light or switch');
    if (kind !== domain) throw bad(what + ': "kind" ' + kind + ' does not match its entity (a ' + domain + ')');
    if (l.flaky !== undefined && typeof l.flaky !== 'boolean') throw bad(what + ': "flaky" must be true or false');
    lightIds[id] = { kind: kind };
    entities[l.entity] = 1;
    lights.push({ id: id, name: name, entity: l.entity, flaky: l.flaky === true, kind: kind });
  });

  const moods = [];
  const moodIds = {};
  moodsIn.forEach((m, i) => {
    const what = 'mood ' + (i + 1);
    if (!isObj(m)) throw bad(what + ' must be an object');
    onlyKeys(m, ['id', 'name', 'state'], what);
    const id = checkId(m.id, what);
    if (moodIds[id]) throw bad(what + ' has the same id as another mood');
    moodIds[id] = 1;
    moods.push({ id: id, name: checkName(m.name, what), state: checkMoodState(m.state, what) });
  });

  const scenes = [];
  const sceneIds = {};
  scenesIn.forEach((s, i) => {
    const what = 'scene ' + (i + 1);
    if (!isObj(s)) throw bad(what + ' must be an object');
    onlyKeys(s, ['id', 'name', 'icon', 'lights', 'wled'], what);
    const id = checkId(s.id, what);
    if (sceneIds[id]) throw bad(what + ' has the same id as another scene');
    sceneIds[id] = 1;
    const name = checkName(s.name, what);
    const icon = s.icon === undefined ? 'bulb' : s.icon;
    if (ICONS.indexOf(icon) < 0) throw bad(what + ': "icon" must be one of ' + ICONS.join(', '));
    const tl = s.lights === undefined ? {} : s.lights;
    if (!isObj(tl)) throw bad(what + ': "lights" must be an object of { lightId: { on, pct, kelvin, color } }');
    const outLights = {};
    Object.keys(tl).forEach((lid) => {
      if (!lightIds[lid]) throw bad(what + ' uses a light id that is not in "lights"');
      const t = tl[lid];
      if (!isObj(t)) throw bad(what + ': each light must be { on, pct, kelvin, color }');
      onlyKeys(t, ['on', 'pct', 'kelvin', 'color'], what + "'s light");
      if (typeof t.on !== 'boolean') throw bad(what + ': each light needs "on": true or false');
      const o = { on: t.on };
      const isSwitch = lightIds[lid].kind === 'switch';
      if (t.pct !== undefined) {
        if (!isInt(t.pct, 1, 100)) throw bad(what + ': "pct" must be a whole number from 1 to 100');
        if (isSwitch) throw bad(what + ': a switch has no brightness ("pct")');
        o.pct = t.pct;
      }
      if (t.kelvin !== undefined) {
        if (!isInt(t.kelvin, 1500, 6500)) throw bad(what + ': "kelvin" must be a whole number from 1500 to 6500');
        if (isSwitch) throw bad(what + ': a switch has no colour ("kelvin")');
        o.kelvin = t.kelvin;
      }
      if (t.color !== undefined) {
        if (!Array.isArray(t.color) || t.color.length !== 3 || !t.color.every((n) => isInt(n, 0, 255))) {
          throw bad(what + ': "color" must be [r, g, b] of 0 to 255');
        }
        if (isSwitch) throw bad(what + ': a switch has no colour ("color")');
        if (o.kelvin !== undefined) throw bad(what + ': give "kelvin" or "color", not both');
        o.color = t.color.slice();
      }
      if (!o.on && (o.pct !== undefined || o.kelvin !== undefined || o.color !== undefined)) {
        throw bad(what + ': a light that is off takes no "pct", "kelvin" or "color"');
      }
      outLights[lid] = o;
    });
    const scene = { id: id, name: name, icon: icon, lights: outLights };
    if (s.wled !== undefined && s.wled !== null) {
      if (typeof s.wled !== 'string' || !moodIds[s.wled]) throw bad(what + ': "wled" must be the id of one of the moods');
      scene.wled = s.wled;
    }
    if (!Object.keys(outLights).length && !scene.wled) throw bad(what + ' changes no light');
    scenes.push(scene);
  });
  return { lights: lights, scenes: scenes, moods: moods };
}

// Reads data/ambience.json, or writes the defaults when it is missing. A
// damaged file is moved aside (like state.json) and the defaults used.
function loadConfig(dir, log) {
  const file = path.join(dir, FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const c = defaultConfig();
    try { saveConfig(dir, c); } catch (e2) { log('ambience: could not write the settings file'); }
    return c;
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (e) {
    const aside = path.join(dir, 'ambience.bad-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    try { fs.renameSync(file, aside); } catch (e2) { /* nothing more to do */ }
    log('ambience: the settings file was damaged; moved it aside and started from the defaults');
    const c = defaultConfig();
    try { saveConfig(dir, c); } catch (e2) { log('ambience: could not write the settings file'); }
    return c;
  }
}

function saveConfig(dir, c) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

/* ---------- colour of a scene (the TV's glow) ---------- */

function hex(rgb) {
  return '#' + rgb.map((n) => {
    const v = Math.max(0, Math.min(255, Math.round(n)));
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

// Roughly the colour of white light at a colour temperature.
function kelvinRgb(k) {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((n) => Math.max(0, Math.min(255, n)));
}

// The scene's tone: the colour of its first light that is on and coloured,
// or a soft white for one with no colour; '' when it turns everything off.
function sceneTone(scene) {
  const ids = Object.keys(scene.lights || {});
  let plain = false;
  for (let i = 0; i < ids.length; i++) {
    const t = scene.lights[ids[i]];
    if (!t.on) continue;
    if (t.color) return hex(t.color);
    if (t.kelvin) return hex(kelvinRgb(t.kelvin));
    plain = true;
  }
  return plain ? hex(kelvinRgb(4000)) : '';
}

/* ---------- the resource the TV gets ---------- */

function notsetData(problem) {
  return {
    v: 1, state: 'notset', problem: problem === 'nolights' ? 'nolights' : 'noha',
    lights: [], scenes: [], active: null, moods: [], wled: null, lastResult: null
  };
}

const TONE_RE = /^#[0-9a-f]{6}$/;

// Rebuilds data from known fields only (the state file, and what goes out).
function cleanData(d) {
  if (!isObj(d)) return notsetData('noha');
  const state = STATES.indexOf(d.state) >= 0 ? d.state : 'notset';
  if (state === 'notset') return notsetData(d.problem);
  const ids = {};
  const lights = (Array.isArray(d.lights) ? d.lights : []).slice(0, MAX_LIGHTS).filter((l) => isObj(l) && ID_RE.test(str(l.id))).map((l) => {
    ids[l.id] = 1;
    const o = {
      id: l.id, name: cleanName(l.name, MAX_NAME), kind: l.kind === 'switch' ? 'switch' : 'light',
      on: l.on === true, pct: isInt(l.pct, 0, 100) ? l.pct : 0, reachable: l.reachable === true, flaky: l.flaky === true
    };
    if (typeof l.tone === 'string' && TONE_RE.test(l.tone)) o.tone = l.tone;
    return o;
  });
  const sceneIds = {};
  const scenes = (Array.isArray(d.scenes) ? d.scenes : []).slice(0, MAX_SCENES).filter((s) => isObj(s) && ID_RE.test(str(s.id))).map((s) => {
    sceneIds[s.id] = 1;
    return {
      id: s.id, name: cleanName(s.name, MAX_NAME), icon: ICONS.indexOf(s.icon) >= 0 ? s.icon : 'bulb',
      tone: typeof s.tone === 'string' && TONE_RE.test(s.tone) ? s.tone : ''
    };
  });
  const moodIds = {};
  const moods = (Array.isArray(d.moods) ? d.moods : []).slice(0, MAX_MOODS).filter((m) => isObj(m) && ID_RE.test(str(m.id))).map((m) => {
    moodIds[m.id] = 1;
    return { id: m.id, name: cleanName(m.name, MAX_NAME) };
  });
  let wled = null;
  if (isObj(d.wled)) {
    wled = {
      reachable: d.wled.reachable === true, on: d.wled.on === true,
      bri: isInt(d.wled.bri, 0, 255) ? d.wled.bri : 0,
      mood: typeof d.wled.mood === 'string' && moodIds[d.wled.mood] ? d.wled.mood : null
    };
  }
  let lastResult = null;
  if (isObj(d.lastResult) && RESULTS.indexOf(d.lastResult.result) >= 0) {
    lastResult = {
      scene: typeof d.lastResult.scene === 'string' && sceneIds[d.lastResult.scene] ? d.lastResult.scene : null,
      result: d.lastResult.result,
      missing: (Array.isArray(d.lastResult.missing) ? d.lastResult.missing : []).slice(0, MAX_LIGHTS).map((n) => cleanName(n, MAX_NAME)).filter(Boolean),
      at: typeof d.lastResult.at === 'string' && isFinite(Date.parse(d.lastResult.at)) ? d.lastResult.at : ''
    };
  }
  return {
    v: 1, state: state, problem: state === 'error' && PROBLEMS.indexOf(d.problem) >= 0 ? d.problem : '',
    lights: lights, scenes: scenes,
    active: typeof d.active === 'string' && sceneIds[d.active] ? d.active : null,
    moods: moods, wled: wled, lastResult: lastResult
  };
}

function cleanResource(r) {
  if (!isObj(r)) return { rev: 0, data: notsetData('noha') };
  const rev = Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  return { rev: rev, data: cleanData(r.data) };
}

/* ---------- a small web request ---------- */

// Resolves to { status, json } (json null when the body was not JSON);
// rejects with e.kind 'timeout' or 'network'. Never follows redirects.
function request(method, url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { const err = new Error('network'); err.kind = 'network'; reject(err); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      const err = new Error('timeout'); err.kind = 'timeout';
      try { req.destroy(); } catch (e) { /* gone */ }
      reject(err);
    }, timeoutMs || REQUEST_MS);
    const req = lib.request(u, { method: method, headers: headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY) { res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json });
      });
      res.on('error', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const err = new Error('network'); err.kind = 'network'; reject(err);
      });
    });
    req.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const err = new Error('network'); err.kind = 'network'; reject(err);
    });
    if (data) req.write(data);
    req.end();
  });
}

/* ---------- the controller ---------- */

/*
 * o.env          from configFromEnv
 * o.dataDir      where ambience.json lives
 * o.current()    the ambience data the server holds
 * o.publish(data)   a real change: save and push it
 * o.screens()    how many screens are on now
 * o.log, o.now
 * o.timeoutMs, o.screenMs, o.idleMs, o.rateEveryMs   for tests
 * o.manual       no timers: tests call poll() themselves
 */
function createController(o) {
  const env = o.env || { configured: false, problem: '' };
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const screens = typeof o.screens === 'function' ? o.screens : () => 0;
  const timeoutMs = o.timeoutMs || REQUEST_MS;
  const screenMs = o.screenMs || SCREEN_MS;
  const idleMs = o.idleMs || IDLE_MS;
  const rateEvery = o.rateEveryMs || RATE_EVERY_MS;
  const dataDir = o.dataDir;

  let config = dataDir ? loadConfig(dataDir, log) : defaultConfig();
  // What each light said last: id -> { on, pct, reachable, tone }
  let seen = {};
  let wledSeen = null;           // { reachable, on, bri }
  const held = cleanData(o.current ? o.current() : null);
  let lastScene = held.active;   // the scene last applied, while it still holds
  let lastMood = held.wled ? held.wled.mood : null;
  let lastResult = held.lastResult;
  let haProblem = '';            // '' | 'auth' | 'unreachable' | 'reply'
  let fails = 0;
  let wledFails = 0;
  let timer = null;
  let polling = null;
  let closed = false;
  let lastProblemLogged = '';
  let tokens = RATE_BURST;
  let tokensAt = now();
  let slowLogged = false;
  (held.lights || []).forEach((l) => { seen[l.id] = { on: l.on, pct: l.pct, reachable: l.reachable, tone: l.tone || '' }; });
  if (held.wled) wledSeen = { reachable: held.wled.reachable, on: held.wled.on, bri: held.wled.bri };

  const ha = (p, body) => request(body === undefined ? 'GET' : 'POST', env.url + p, env.token, body, timeoutMs);
  const wledCall = (body) => request(body === undefined ? 'GET' : 'POST', env.wledUrl + '/json/state', '', body, timeoutMs);
  const wledOn = () => !!env.wledUrl;
  const lightById = (id) => config.lights.filter((l) => l.id === id)[0] || null;
  const sceneById = (id) => config.scenes.filter((s) => s.id === id)[0] || null;
  const moodById = (id) => config.moods.filter((m) => m.id === id)[0] || null;

  // Is the room still as the scene left it? Only lights that are not flaky
  // and that answered count.
  function stillMatches(scene) {
    if (!scene) return false;
    const ids = Object.keys(scene.lights);
    for (let i = 0; i < ids.length; i++) {
      const l = lightById(ids[i]);
      const s = seen[ids[i]];
      if (!l || l.flaky || !s || !s.reachable) continue;
      const t = scene.lights[ids[i]];
      if (t.on !== s.on) return false;
      if (t.on && t.pct !== undefined && l.kind === 'light' && Math.abs(t.pct - s.pct) > MATCH_PCT) return false;
    }
    return true;
  }

  function moodMatches(mood) {
    if (!mood || !wledSeen || !wledSeen.reachable) return false;
    const st = mood.state;
    if (st.on !== undefined && st.on !== wledSeen.on) return false;
    if (st.on !== false && st.bri !== undefined && Math.abs(st.bri - wledSeen.bri) > 3) return false;
    return true;
  }

  // The resource as it stands, from the config and what was seen.
  function build() {
    if (!env.configured) return notsetData('noha');
    if (!config.lights.length && !(wledOn() && config.moods.length)) return notsetData('nolights');
    if (lastScene && !stillMatches(sceneById(lastScene))) lastScene = null;
    if (lastMood && !moodMatches(moodById(lastMood))) lastMood = null;
    const d = {
      v: 1, state: haProblem ? 'error' : 'ok', problem: haProblem,
      lights: config.lights.map((l) => {
        const s = seen[l.id] || { on: false, pct: 0, reachable: false, tone: '' };
        const out = { id: l.id, name: l.name, kind: l.kind, on: !!s.on, pct: s.on ? (l.kind === 'switch' ? 100 : s.pct) : 0, reachable: !!s.reachable, flaky: l.flaky };
        if (s.on && s.tone) out.tone = s.tone;
        return out;
      }),
      scenes: config.lights.length ? config.scenes.map((s) => ({ id: s.id, name: s.name, icon: s.icon, tone: sceneTone(s) })) : [],
      active: lastScene && sceneById(lastScene) ? lastScene : null,
      moods: wledOn() ? config.moods.map((m) => ({ id: m.id, name: m.name })) : [],
      wled: wledOn() ? { reachable: !!(wledSeen && wledSeen.reachable), on: !!(wledSeen && wledSeen.on), bri: wledSeen ? wledSeen.bri : 0, mood: lastMood } : null,
      lastResult: lastResult && (lastResult.scene === null || sceneById(lastResult.scene)) ? lastResult : null
    };
    return cleanData(d);
  }

  function put() {
    if (closed) return false;
    const next = build();
    const prev = cleanData(o.current ? o.current() : null);
    if (JSON.stringify(prev) === JSON.stringify(next)) return false;
    o.publish(next);
    return true;
  }

  function problemLine(p) {
    if (p === lastProblemLogged) return;
    lastProblemLogged = p;
    if (p === 'auth') log('ambience: Home Assistant refused the token (401)');
    else if (p === 'timeout') log('ambience: Home Assistant did not answer (timeout)');
    else if (p === 'network') log('ambience: Home Assistant did not answer (network)');
    else if (p === 'reply') log('ambience: Home Assistant sent a reply that could not be read');
    else if (p === '') log('ambience: Home Assistant answering again');
  }

  // Reads one entity. Resolves { reachable, on, pct, tone } or { fail: kind }
  // where kind is 'auth', 'timeout', 'network' or 'reply'.
  function readLight(l) {
    return ha('/api/states/' + l.entity).then((r) => {
      if (r.status === 401 || r.status === 403) return { fail: 'auth' };
      if (r.status === 404) return { reachable: false, on: false, pct: 0, tone: '' };
      if (r.status !== 200 || !isObj(r.json)) return { fail: 'reply' };
      const st = str(r.json.state).toLowerCase();
      if (st !== 'on' && st !== 'off') return { reachable: false, on: false, pct: 0, tone: '' };
      const a = isObj(r.json.attributes) ? r.json.attributes : {};
      const on = st === 'on';
      let pct = 0;
      if (on) pct = l.kind === 'switch' ? 100 : (isInt(a.brightness, 0, 255) ? Math.max(1, Math.round(a.brightness * 100 / 255)) : 100);
      let tone = '';
      if (on && Array.isArray(a.rgb_color) && a.rgb_color.length === 3 && a.rgb_color.every((n) => typeof n === 'number')) tone = hex(a.rgb_color);
      else if (on && typeof a.color_temp_kelvin === 'number' && a.color_temp_kelvin > 0) tone = hex(kelvinRgb(a.color_temp_kelvin));
      return { reachable: true, on: on, pct: pct, tone: tone };
    }, (e) => ({ fail: e && e.kind === 'timeout' ? 'timeout' : 'network' }));
  }

  function readWled() {
    if (!wledOn()) return Promise.resolve();
    return wledCall().then((r) => {
      if (r.status !== 200 || !isObj(r.json) || typeof r.json.on !== 'boolean') throw new Error('reply');
      wledSeen = { reachable: true, on: r.json.on, bri: isInt(r.json.bri, 0, 255) ? r.json.bri : 0 };
      if (wledFails) log('ambience: plant wall answering again');
      wledFails = 0;
    }).catch(() => {
      wledFails += 1;
      if (wledFails === 1) log('ambience: plant wall did not answer');
      wledSeen = { reachable: false, on: wledSeen ? wledSeen.on : false, bri: wledSeen ? wledSeen.bri : 0 };
    });
  }

  function pollOnce() {
    if (!env.configured) { put(); return Promise.resolve({ ok: false, problem: 'notset' }); }
    const lights = config.lights.slice();
    return Promise.all([Promise.all(lights.map(readLight)), readWled()]).then((all) => {
      const res = all[0];
      const fresh = {};
      let hard = '';
      let answered = 0;
      res.forEach((r, i) => {
        const id = lights[i].id;
        if (r.fail) {
          if (r.fail === 'auth') hard = 'auth';
          else if (!hard) hard = r.fail;
          const was = seen[id] || { on: false, pct: 0, tone: '' };
          fresh[id] = { on: was.on, pct: was.pct, tone: was.tone, reachable: false };
        } else {
          answered += 1;
          fresh[id] = r;
        }
      });
      if (hard === 'auth') {
        fails += 1;
        haProblem = 'auth';
        problemLine('auth');
      } else if (lights.length && !answered && hard) {
        // Nobody answered at all: Home Assistant itself is away.
        fails += 1;
        problemLine(hard);
        if (fails >= FAILS_BEFORE_ERROR) haProblem = hard === 'reply' ? 'reply' : 'unreachable';
        // Keep what was seen last ("Last known" on the TV).
        put();
        return { ok: false, problem: haProblem || hard };
      } else {
        if (fails || haProblem) problemLine('');
        fails = 0;
        haProblem = '';
      }
      if (haProblem !== 'auth') seen = fresh;
      put();
      return { ok: !haProblem, answered: answered, total: lights.length };
    });
  }

  function poll() {
    if (polling) return polling;
    polling = pollOnce().then((r) => { polling = null; return r; }, () => {
      polling = null;
      log('ambience: unexpected problem while reading the lights');
      return { ok: false };
    });
    return polling;
  }

  function delay() {
    if (!env.configured || (!config.lights.length && !wledOn())) return 0;
    const base = screens() > 0 ? screenMs : idleMs;
    if (!fails) return base;
    return Math.min(MAX_BACKOFF_MS, base * Math.pow(2, Math.min(fails, 4)));
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

  // A screen came on: look sooner than the idle wait.
  function screensChanged() {
    if (closed || o.manual || !timer) return;
    if (screens() > 0) schedule();
  }

  /* --- commands --- */

  function needReady() {
    if (!env.configured) {
      const e = new Error('Home Assistant is not set up on the Pi (HA_TOKEN in pi/.env)');
      e.status = 409;
      throw e;
    }
  }

  // Sends one light to a target. Resolves 'ok', 'no-answer' or 'refused'
  // (or 'auth' when the token was refused).
  function sendLight(l, t) {
    const domain = l.kind === 'switch' ? 'switch' : 'light';
    const body = { entity_id: l.entity };
    if (t.on && l.kind === 'light') {
      if (t.pct !== undefined) body.brightness_pct = t.pct;
      if (t.kelvin !== undefined) body.color_temp_kelvin = t.kelvin;
      if (t.color !== undefined) body.rgb_color = t.color.slice();
    }
    return ha('/api/services/' + domain + '/' + (t.on ? 'turn_on' : 'turn_off'), body).then((r) => {
      if (r.status === 401 || r.status === 403) return 'auth';
      if (r.status >= 200 && r.status < 300) return 'ok';
      return 'refused';
    }, () => 'no-answer');
  }

  // After the calls: a light Home Assistant took but that is "unavailable"
  // did not really answer.
  function settle(results) {
    // A read that started before the calls may miss them: wait for it, then
    // read again.
    const before = polling || Promise.resolve();
    return before.then(() => poll()).then(() => results.map((x) => {
      if (x.result === 'ok') {
        const s = seen[x.id];
        if (s && !s.reachable) return Object.assign({}, x, { result: 'no-answer' });
      }
      if (x.result === 'auth') return Object.assign({}, x, { result: 'refused' });
      return x;
    }));
  }

  function applyScene(id) {
    needReady();
    const scene = sceneById(id);
    if (!scene || !config.lights.length) throw bad('there is no scene with that id');
    const ids = Object.keys(scene.lights);
    const calls = ids.map((lid) => {
      const l = lightById(lid);
      return sendLight(l, scene.lights[lid]).then((result) => ({ id: lid, result: result }));
    });
    const mood = scene.wled && wledOn() ? moodById(scene.wled) : null;
    const moodCall = mood ? sendMood(mood) : Promise.resolve(null);
    return Promise.all([Promise.all(calls), moodCall]).then((both) => {
      if (both[0].some((x) => x.result === 'auth')) { haProblem = 'auth'; problemLine('auth'); }
      return settle(both[0]).then((list) => {
        const okCount = list.filter((x) => x.result === 'ok').length;
        const total = list.length;
        const result = !total ? (both[1] === 'ok' ? 'ok' : 'failed') : okCount === total ? 'ok' : okCount ? 'partial' : 'failed';
        const missing = list.filter((x) => x.result !== 'ok').map((x) => lightById(x.id).name);
        lastResult = { scene: scene.id, result: result, missing: missing, at: new Date(now()).toISOString() };
        // A scene no light took changed nothing: the one before still holds.
        if (result !== 'failed') lastScene = scene.id;
        if (mood && both[1] === 'ok') lastMood = mood.id;
        log('ambience: scene ' + (result === 'failed' ? 'failed' : 'applied') + ' (' + okCount + ' of ' + total + ' lights answered)');
        put();
        return { result: result, answered: okCount, total: total, missing: missing, lights: list, mood: both[1] };
      });
    });
  }

  // { on?, pct? }: pct alone turns the light on at that level; neither
  // toggles it.
  function setLight(id, want) {
    needReady();
    const l = lightById(id);
    if (!l) throw bad('there is no light with that id');
    const w = isObj(want) ? want : {};
    if (w.on !== undefined && typeof w.on !== 'boolean') throw bad('"on" must be true or false');
    if (w.pct !== undefined && !isInt(w.pct, 1, 100)) throw bad('"pct" must be a whole number from 1 to 100');
    if (w.pct !== undefined && l.kind === 'switch') throw bad('a switch has no brightness');
    const was = seen[l.id] || { on: false };
    const on = w.on !== undefined ? w.on : (w.pct !== undefined ? true : !was.on);
    const t = { on: on };
    if (on && w.pct !== undefined) t.pct = w.pct;
    return sendLight(l, t).then((result) => {
      if (result === 'auth') { haProblem = 'auth'; problemLine('auth'); }
      return settle([{ id: l.id, result: result }]);
    }).then((list) => {
      const r = list[0].result;
      log(r === 'ok' ? 'ambience: light set' : r === 'no-answer' ? 'ambience: light did not answer' : 'ambience: light refused the change');
      put();
      const s = seen[l.id] || { on: false, pct: 0 };
      return { result: r, on: !!s.on, pct: s.on ? s.pct : 0 };
    });
  }

  function sendMood(mood) {
    return wledCall(mood.state).then((r) => (r.status >= 200 && r.status < 300 ? 'ok' : 'refused'), () => 'no-answer');
  }

  function applyMood(id) {
    if (!wledOn()) {
      const e = new Error('the plant wall is not set up on the Pi (WLED_URL in pi/.env)');
      e.status = 409;
      throw e;
    }
    const mood = moodById(id);
    if (!mood) throw bad('there is no mood with that id');
    return sendMood(mood).then((r) => readWled().then(() => {
      if (r === 'ok') lastMood = mood.id;
      log(r === 'ok' ? 'ambience: mood applied' : r === 'no-answer' ? 'ambience: plant wall did not answer' : 'ambience: plant wall refused the mood');
      put();
      return { result: r };
    }));
  }

  /* --- settings --- */

  function setConfig(c) {
    const next = validateConfig(c);
    saveConfig(dataDir, next);
    config = next;
    const keep = {};
    config.lights.forEach((l) => { if (seen[l.id]) keep[l.id] = seen[l.id]; });
    seen = keep;
    if (lastScene && !sceneById(lastScene)) lastScene = null;
    if (lastMood && !moodById(lastMood)) lastMood = null;
    if (lastResult && lastResult.scene && !sceneById(lastResult.scene)) lastResult = null;
    log('ambience: settings saved (' + counts() + ')');
    put();
    if (!o.manual) poll().then(schedule);
    return getConfig();
  }

  function resetConfig() {
    return setConfig(defaultConfig());
  }

  function getConfig() {
    return JSON.parse(JSON.stringify(config));
  }

  function counts() {
    const n = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
    return n(config.lights.length, 'light') + ', ' + n(config.scenes.length, 'scene') + ', ' + n(config.moods.length, 'mood');
  }

  /* --- the screen's door: ids only, and not too fast --- */

  // true when a screen command may go now (a token bucket: 3 at once, then
  // one every 400 ms).
  function screenAllowed() {
    const t = now();
    tokens = Math.min(RATE_BURST, tokens + (t - tokensAt) / rateEvery);
    tokensAt = t;
    if (tokens >= 1) {
      tokens -= 1;
      slowLogged = false;
      return true;
    }
    if (!slowLogged) { slowLogged = true; log('ambience: a screen sent commands too fast (asked it to slow down)'); }
    return false;
  }

  /* --- for status lines (./hub, the mailbox) --- */

  function status() {
    const d = build();
    return {
      configured: !!env.configured, problem: str(env.problem), wled: wledOn(), wledProblem: str(env.wledProblem),
      state: d.state, haProblem: d.problem,
      lights: d.lights, scenes: d.scenes, moods: d.moods, active: d.active, wledState: d.wled, lastResult: d.lastResult
    };
  }

  // Counts only, for GET /api/status.
  function summary() {
    const d = build();
    return {
      configured: !!env.configured, state: d.state, lights: d.lights.length,
      answering: d.lights.filter((l) => l.reachable).length, scenes: d.scenes.length, wled: wledOn()
    };
  }

  function start() {
    if (!env.configured) {
      log(env.problem ? 'ambience: off (HA_TOKEN or HA_URL does not look right)' : 'ambience: off (no HA_TOKEN in .env)');
      put();
      return;
    }
    if (env.wledProblem) log('ambience: plant wall off (WLED_URL does not look right)');
    log('ambience: on (' + counts() + ')');
    put();
    if (!o.manual) poll().then(schedule);
  }

  function close() {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start: start, close: close, poll: poll, status: status, summary: summary,
    applyScene: applyScene, setLight: setLight, applyMood: applyMood,
    setConfig: setConfig, resetConfig: resetConfig, getConfig: getConfig,
    screenAllowed: screenAllowed, screensChanged: screensChanged,
    configured: !!env.configured,
    debug: () => ({ timer: !!timer, fails: fails, delay: delay(), tokens: tokens })
  };
}

module.exports = {
  configFromEnv: configFromEnv,
  defaultConfig: defaultConfig,
  validateConfig: validateConfig,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  notsetData: notsetData,
  cleanData: cleanData,
  cleanResource: cleanResource,
  sceneTone: sceneTone,
  kelvinRgb: kelvinRgb,
  createController: createController,
  ICONS: ICONS,
  MAX_CONFIG_BYTES: MAX_CONFIG_BYTES
};
