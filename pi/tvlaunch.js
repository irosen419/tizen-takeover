/*
 * Open things on the TV from the Pi (POST /tv/launch), for a tablet or phone
 * that has no service.js. The Pi answers at once and works in the background:
 *
 *   1. Home Assistant: turn the TV on if it is off, wait until it has stayed on.
 *   2. Open it. An app: media_player.select_source with the app's name from the
 *      TV's source list. If the TV's list has no such name (or Home Assistant
 *      cannot), the Pi's own remote link opens it by app name (tvremote.js).
 *      A key: media_player.play_media send_key. A webhook: a POST to the same
 *      path on Home Assistant.
 *
 * Settings in .env: HA_TOKEN and HA_URL (as for echo.js), TV_ENTITY (default
 * media_player.living_room_tv). No token: the Pi's remote link is all there is.
 * One launch at a time. The log holds the kind and what happened,
 * never an app's name, the token, an address, an entity id or a webhook id.
 *
 * Node 14 or newer, no npm packages. Tests: node pi/tvlaunch-test.js
 */
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://127.0.0.1:8123';
const DEFAULT_ENTITY = 'media_player.living_room_tv';
const KINDS = ['app', 'tizentube', 'key', 'webhook'];
const FIELDS = ['kind', 'name', 'match', 'key', 'url'];
const NAME_RE = /^[\p{L}\p{N} .+&'_-]{1,40}$/u;
const KEY_RE = /^KEY_[A-Z0-9_]{1,30}$/;
const HOOK_RE = /^\/api\/webhook\/[A-Za-z0-9_-]{1,100}$/;
const OFF_STATES = ['off', 'unavailable', 'unknown', ''];
const MAX_REPLY = 512 * 1024;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

function bad(msg, status) {
  const e = new Error(msg);
  e.status = status || 400;
  return e;
}

function configFromEnv(env) {
  const e = env || {};
  const token = str(e.HA_TOKEN).trim();
  const entity = str(e.TV_ENTITY).trim() || DEFAULT_ENTITY;
  if (!token) return { configured: false, problem: '', entity: entity };
  if (!/^[A-Za-z0-9._-]{20,2000}$/.test(token)) return { configured: false, problem: 'HA_TOKEN does not look like a Home Assistant token', entity: entity };
  if (!/^media_player\.[a-z0-9_]{1,80}$/.test(entity)) return { configured: false, problem: 'TV_ENTITY must look like media_player.living_room_tv', entity: entity };
  const url = (str(e.HA_URL).trim() || DEFAULT_URL).replace(/\/+$/, '');
  let u = null;
  try { u = new URL(url); } catch (err) { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) {
    return { configured: false, problem: 'HA_URL does not look right (it is like http://127.0.0.1:8123)', entity: entity };
  }
  return { configured: true, problem: '', url: url, token: token, entity: entity };
}

// The request, checked. Throws a 400 that names the problem.
function normalize(raw) {
  if (!isObj(raw)) throw bad('send { "kind": "app", "name": "Netflix" }');
  Object.keys(raw).forEach((k) => { if (FIELDS.indexOf(k) < 0) throw bad('"' + k + '" is not something a launch takes (use ' + FIELDS.join(', ') + ')'); });
  if (KINDS.indexOf(raw.kind) < 0) throw bad('"kind" must be one of: ' + KINDS.join(', '));
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) throw bad('"name" must be 1 to 40 letters, digits, spaces or . + & \' _ -');
  const req = { kind: raw.kind, name: raw.name, match: [], key: '', hook: '' };
  if (raw.match !== undefined && raw.match !== null) {
    if (!Array.isArray(raw.match) || raw.match.length > 8 || raw.match.some((m) => typeof m !== 'string' || !NAME_RE.test(m))) throw bad('"match" must be up to 8 app names');
    req.match = raw.match.slice();
  }
  if (!req.match.length) req.match = [raw.name];
  req.match = withAliases(req.match);
  if (raw.kind === 'key') {
    if (typeof raw.key !== 'string' || !KEY_RE.test(raw.key)) throw bad('"key" must look like KEY_HDMI1');
    req.key = raw.key;
  } else if (raw.key !== undefined && raw.key !== null) throw bad('"key" goes with kind "key"');
  if (raw.kind === 'webhook') {
    let u = null;
    try { u = new URL(str(raw.url)); } catch (e) { u = null; }
    // Only the path counts: the call always goes to Home Assistant itself.
    if (!u || !HOOK_RE.test(u.pathname)) throw bad('"url" must be a Home Assistant webhook (/api/webhook/<id>)');
    req.hook = u.pathname;
  } else if (raw.url !== undefined && raw.url !== null) throw bad('"url" goes with kind "webhook"');
  return req;
}

// Spaces and punctuation ignored, so "Tizen Brew" and "TizenBrew" are one name.
function lower(s) { return str(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

// Names the TV lists differently from what a caller says (its source list reads
// "TizenBrewNextGeneration" for TizenBrew). Keys are lower(); extras are tried after the asked name.
const ALIASES = { tizenbrew: ['TizenBrewNextGeneration', 'TizenBrew Next Generation'] };
function withAliases(names) {
  const out = names.slice();
  names.forEach((n) => (ALIASES[lower(n)] || []).forEach((a) => { if (out.map(lower).indexOf(lower(a)) < 0) out.push(a); }));
  return out;
}

// The TV's own name for an app, from its source list: an exact match on any
// wanted name first, then a name that starts with one. '' when none.
function pickSource(list, wanted) {
  const names = (Array.isArray(list) ? list : []).filter((n) => typeof n === 'string');
  const want = wanted.map(lower).filter(Boolean);
  for (let i = 0; i < want.length; i++) {
    const hit = names.filter((n) => lower(n) === want[i])[0];
    if (hit) return hit;
  }
  for (let i = 0; i < want.length; i++) {
    const hit = names.filter((n) => lower(n).indexOf(want[i]) === 0)[0];
    if (hit) return hit;
  }
  return '';
}

function ha(cfg, method, urlPath, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(cfg.url + urlPath); } catch (e) { resolve({ status: 0, kind: 'network' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let finished = false;
    const end = (v) => { if (finished) return; finished = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { req.destroy(); } catch (e) { /* gone */ } end({ status: 0, kind: 'timeout' }); }, timeoutMs);
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + cfg.token };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = lib.request(u, { method: method, headers: headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_REPLY) res.destroy(); else chunks.push(c); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        end({ status: res.statusCode, json: json });
      });
      res.on('error', () => end({ status: 0, kind: 'network' }));
    });
    req.on('error', () => end({ status: 0, kind: 'network' }));
    if (data) req.write(data);
    req.end();
  });
}

/*
 * o.config   from configFromEnv
 * o.remote   the tvremote controller (run, address), for the fallback
 * o.log      o.sleep(ms)  o.timeoutMs  (tests make waits short)
 * o.pollMs, o.onSteadyMs, o.bootMs, o.settleMs   waits (ms)
 */
function create(o) {
  const cfg = o.config || { configured: false, problem: '', entity: DEFAULT_ENTITY };
  const log = typeof o.log === 'function' ? o.log : () => {};
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 8000;
  const pollMs = typeof o.pollMs === 'number' ? o.pollMs : 3000;
  const steadyMs = typeof o.onSteadyMs === 'number' ? o.onSteadyMs : 6000; // on for this long counts as awake
  const bootMs = typeof o.bootMs === 'number' ? o.bootMs : 150000;         // give up waiting after this
  const settleMs = typeof o.settleMs === 'number' ? o.settleMs : 4000;     // let the TV finish booting
  const verifyMs = typeof o.verifyMs === 'number' ? o.verifyMs : 8000;
  const remote = o.remote || null;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  let busy = null;   // { name }
  let last = null;   // { kind, name, at, ok, steps: [..] }

  const entityPath = () => '/api/states/' + cfg.entity;

  async function tvState() {
    const r = await ha(cfg, 'GET', entityPath(), undefined, timeoutMs);
    if (r.status === 200 && isObj(r.json)) return { ok: true, state: str(r.json.state), attrs: isObj(r.json.attributes) ? r.json.attributes : {} };
    if (r.status === 401 || r.status === 403) return { ok: false, problem: 'Home Assistant refused the token' };
    if (r.status === 404) return { ok: false, problem: 'Home Assistant does not know the TV (check TV_ENTITY in .env)' };
    return { ok: false, problem: r.status ? 'Home Assistant answered HTTP ' + r.status : 'Home Assistant could not be reached' };
  }

  async function service(domain, name, data) {
    const r = await ha(cfg, 'POST', '/api/services/' + domain + '/' + name, data, timeoutMs);
    return r.status === 200 || r.status === 201;
  }

  // Turn the TV on if it is off and wait until it has stayed on a few seconds.
  async function ensureOn(rec) {
    let s = await tvState();
    if (!s.ok) { rec.steps.push('tv state: ' + s.problem); return s; }
    if (OFF_STATES.indexOf(s.state) < 0) { rec.steps.push('tv already on'); return s; }
    const t0 = now();
    const sent = await service('media_player', 'turn_on', { entity_id: cfg.entity });
    rec.steps.push(sent ? 'turn on sent' : 'turn on refused');
    if (!sent) return { ok: false, problem: 'Home Assistant would not turn the TV on' };
    let onSince = 0;
    while (now() - t0 < bootMs) {
      await sleep(pollMs);
      s = await tvState();
      if (s.ok && OFF_STATES.indexOf(s.state) < 0) {
        if (!onSince) onSince = now();
        if (now() - onSince >= steadyMs) {
          await sleep(settleMs);
          rec.steps.push('tv on after ' + Math.round((now() - t0) / 1000) + ' s');
          return s;
        }
      } else onSince = 0; // the TV flaps off and on while it boots
    }
    rec.steps.push('tv did not come on');
    return { ok: false, problem: 'the TV did not come on' };
  }

  function haveApp(attrs, want) {
    const cur = [attrs.app_name].filter((x) => typeof x === 'string' && x).map(lower);
    if (!cur.length) return null; // Home Assistant says nothing about the running app
    return want.some((w) => cur.some((c) => c === lower(w) || c.indexOf(lower(w)) === 0));
  }

  async function viaRemote(req, names, rec) {
    if (!remote) { rec.steps.push('no remote link'); return false; }
    for (let i = 0; i < names.length; i++) {
      if (!/^[A-Za-z0-9 .+&'_-]{1,40}$/.test(names[i])) continue;
      try {
        const r = remote.run({ id: 'launch', appId: 'launch', appName: names[i], open: true, waitOpen: 0, enter: false, link: 'none' });
        const rec2 = await r.done;
        // Only a name the TV's own list knows counts: else the open went to a guessed id.
        const found = rec2.ok && (rec2.steps || []).some((s) => s.step === 'find' && /^found/.test(s.detail || ''));
        rec.steps.push('remote link ' + (found ? 'sent' : rec2.ok ? 'name not on the TV' : 'failed'));
        if (found) return true;
      } catch (e) {
        rec.steps.push('remote link: ' + (e && e.message ? e.message.slice(0, 80) : 'failed'));
        return false;
      }
    }
    return false;
  }

  async function openApp(req, names, rec) {
    let tv = null;
    if (cfg.configured) {
      tv = await tvState();
      if (tv.ok) {
        const src = pickSource(tv.attrs.source_list, names);
        if (src) {
          const sent = await service('media_player', 'select_source', { entity_id: cfg.entity, source: src });
          rec.steps.push(sent ? 'select source sent' : 'select source refused');
          if (sent) {
            await sleep(verifyMs);
            const again = await tvState();
            const seen = again.ok ? haveApp(again.attrs, names.concat([src])) : null;
            if (seen !== false) return true;
            rec.steps.push('app did not open; trying the remote link');
          }
        } else rec.steps.push('not in the TV\'s source list');
      }
    }
    return viaRemote(req, names, rec);
  }

  async function job(req, rec) {
    if (req.kind === 'webhook') {
      if (!cfg.configured) { rec.steps.push('no Home Assistant'); return false; }
      const r = await ha(cfg, 'POST', req.hook, {}, timeoutMs);
      rec.steps.push('webhook HTTP ' + r.status);
      return r.status >= 200 && r.status < 300;
    }
    if (cfg.configured) {
      const on = await ensureOn(rec);
      if (!on.ok && req.kind === 'key') return false;
    }
    if (req.kind === 'key') {
      const sent = await service('media_player', 'play_media', { entity_id: cfg.entity, media_content_type: 'send_key', media_content_id: req.key });
      rec.steps.push(sent ? 'key sent' : 'key refused');
      return sent;
    }
    // TizenTube is its own app only when sideloaded; else the plain YouTube app opens.
    const names = req.kind === 'tizentube' ? ['TizenTube', 'YouTube'] : req.match;
    return openApp(req, names, rec);
  }

  // Starts a launch and returns at once. Throws a 400 for a bad request, a 409
  // when one is already going, a 503 when there is no way to reach the TV.
  function launch(raw) {
    const req = normalize(raw);
    if (!cfg.configured && req.kind !== 'app' && req.kind !== 'tizentube') throw bad('Home Assistant is not set up on the Pi (HA_TOKEN in pi/.env)', 503);
    if (!cfg.configured && !remote) throw bad('Home Assistant is not set up on the Pi (HA_TOKEN in pi/.env)', 503);
    if (busy) throw bad('Already opening ' + busy.name + ' on the TV', 409);
    busy = { name: req.name };
    const rec = { kind: req.kind, name: req.name, at: new Date(now()).toISOString(), ok: false, steps: [] };
    last = rec;
    const done = job(req, rec).then((ok) => ok, (e) => { rec.steps.push('error: ' + (e && e.message ? e.message.slice(0, 80) : 'failed')); return false; }).then((ok) => {
      rec.ok = ok;
      busy = null;
      try { log('tvlaunch: ' + req.kind + ': ' + (ok ? 'ok' : 'failed') + ' (' + rec.steps.join(', ') + ')'); } catch (e) { /* never stops */ }
      return rec;
    });
    return { queued: true, done: done };
  }

  // What Home Assistant knows about the TV: its state and the names it can open.
  async function status() {
    const out = { configured: cfg.configured, problem: cfg.problem, busy: !!busy, last: last };
    if (cfg.configured) {
      const s = await tvState();
      if (s.ok) {
        out.state = s.state;
        out.source = str(s.attrs.source);
        out.app = str(s.attrs.app_name);
        out.sources = (Array.isArray(s.attrs.source_list) ? s.attrs.source_list : []).filter((n) => typeof n === 'string').slice(0, 200);
      } else out.problem = s.problem;
    }
    return out;
  }

  return { launch: launch, status: status };
}

function lines(s) {
  if (!s.configured) return ['TV launch: Home Assistant is not set up' + (s.problem ? ' (' + s.problem + ')' : ' (no HA_TOKEN in .env)') + '; only the Pi\'s remote link can open apps.'];
  const out = ['TV launch: ' + (s.problem ? s.problem : 'TV is ' + (s.state || 'unknown') + (s.app ? ', showing ' + s.app : '')) + (s.busy ? '; a launch is going now' : '') + '.'];
  if (s.sources) out.push('The TV can open: ' + (s.sources.length ? s.sources.join(', ') : '(its source list is empty)') + '.');
  if (s.last) out.push('Last: ' + s.last.kind + ' ' + s.last.name + ' ' + (s.last.ok ? 'worked' : 'failed') + ' (' + s.last.steps.join(', ') + ').');
  return out;
}

module.exports = { create: create, configFromEnv: configFromEnv, normalize: normalize, pickSource: pickSource, withAliases: withAliases, lines: lines, KINDS: KINDS };
