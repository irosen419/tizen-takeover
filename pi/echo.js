/*
 * Echo controls: start and steer what plays on Ian's Echo speakers through
 * Home Assistant's Alexa Media Player (AMP) integration, and remember what
 * the hub itself started so "All sounds" (allsounds.js) can say so.
 *
 * Settings (pi/.env), all optional:
 *   HA_TOKEN, HA_URL   as for allsounds.js (no token: Echo controls are off)
 *   ECHO_TARGETS       a comma list of key=media_player.id, for example
 *                      show=media_player.ian_s_echo_show,dot=media_player.ian_s_echo_dot,everywhere=media_player.everywhere
 *                      (key: a-z 0-9 and -, 1 to 20 characters; up to 8). The
 *                      first is the default target. A target named
 *                      "everywhere" (or media_player.everywhere) is Alexa's
 *                      group: one call goes to it, and every other target is
 *                      a member of it.
 *
 * Apps are fixed presets (APPS below); nothing else can be started. Audible
 * and the Alexa news are "hidden": AMP cannot see or control them as a media
 * player, so while the hub's label says one of them is running, pause,
 * resume, next and stop are sent as spoken commands instead.
 *
 * Labels ("started by us"): entity id -> { app, label, title, hidden, at,
 * playing, via, base }. Kept in <dataDir>/echo.json, cleared when stopped,
 * when allsounds.js sees something else start (clearLabel) and after six
 * hours. There is no book title or chapter: Amazon does not tell us.
 *
 * The log only ever gets fixed words and target keys: never the query, a
 * speaker's name, a title, an address or the token.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://127.0.0.1:8123';
const DEFAULT_TARGETS = 'show=media_player.ian_s_echo_show,dot=media_player.ian_s_echo_dot,everywhere=media_player.everywhere';
const REQUEST_MS = 8000;
const MAX_REPLY = 256 * 1024;
const MAX_TARGETS = 8;
const MAX_QUERY = 100;
const LABEL_MAX_MS = 6 * 60 * 60 * 1000;
const RATE_COUNT = 10;
const RATE_MS = 10000;
const GROUP_VIA = 'Everywhere';
const FILE = 'echo.json';

const APPS = {
  audible: { label: 'Audible', hidden: true, query: 'no', title: '' },
  pandora: { label: 'Pandora', hidden: false, query: 'optional', title: '' },
  'amazon-music': { label: 'Amazon Music', hidden: false, query: 'optional', title: '' },
  tunein: { label: 'TuneIn', hidden: false, query: 'required', title: '' },
  kera: { label: 'TuneIn', hidden: false, query: 'no', title: 'KERA 90.1' },
  news: { label: 'Alexa news', hidden: true, query: 'no', title: '' }
};
const APP_KEYS = Object.keys(APPS);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

function plain(v, max) {
  const t = str(v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('').trim() : t;
}

/* ---------- settings ---------- */

function configFromEnv(env) {
  const e = env || {};
  const token = str(e.HA_TOKEN).trim();
  const rawUrl = str(e.HA_URL).trim();
  if (!token) return { configured: false, problem: '' };
  if (!/^[A-Za-z0-9._-]{20,2000}$/.test(token)) return { configured: false, problem: 'HA_TOKEN does not look like a Home Assistant token' };
  const url = (rawUrl || DEFAULT_URL).replace(/\/+$/, '');
  let u = null;
  try { u = new URL(url); } catch (err) { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) {
    return { configured: false, problem: 'HA_URL does not look right (it is like http://127.0.0.1:8123)' };
  }
  const rawList = str(e.ECHO_TARGETS).trim() || DEFAULT_TARGETS;
  const targets = [];
  const items = rawList.split(',').map((x) => x.trim()).filter(Boolean);
  const badTargets = { configured: false, problem: 'ECHO_TARGETS must look like show=media_player.ian_s_echo_show, separated by commas' };
  for (let i = 0; i < items.length; i++) {
    const m = /^([a-z0-9-]{1,20})=(media_player\.[a-z0-9_]{1,80})$/.exec(items[i].toLowerCase());
    if (!m || targets.some((t) => t.key === m[1])) return badTargets;
    targets.push({ key: m[1], entity: m[2], group: m[1] === 'everywhere' || m[2] === 'media_player.everywhere' });
  }
  if (!targets.length) return badTargets;
  if (targets.length > MAX_TARGETS) return { configured: false, problem: 'ECHO_TARGETS lists more than ' + MAX_TARGETS };
  const members = targets.filter((t) => !t.group).map((t) => t.entity);
  targets.forEach((t) => { if (t.group) t.members = members.slice(); });
  return { configured: true, problem: '', url: url, token: token, targets: targets };
}

/* ---------- checks the server and the mailbox share ---------- */

// The query as it will be sent ('' when there is none). Throws nothing.
function cleanQuery(q) {
  return plain(q, 1000);
}

// '' when this app and query may be started, else the words to say why.
function checkStart(app, query) {
  const a = APPS[app];
  if (!a) return 'app must be one of: ' + APP_KEYS.join(', ');
  if (query !== undefined && query !== null && typeof query !== 'string') return 'query must be text';
  const q = cleanQuery(query);
  if (Array.from(q).length > MAX_QUERY) return 'query is longer than ' + MAX_QUERY + ' characters';
  if (q && a.query === 'no') return app + ' does not take a query';
  if (!q && a.query === 'required') return 'tunein needs a query (a station or show name)';
  return '';
}

// '' when level is 0 to 100 (a whole number) or up or down.
function checkVolume(level) {
  if (level === 'up' || level === 'down') return '';
  if (typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 100) return '';
  return 'level must be a whole number from 0 to 100, or up or down';
}

// The play_media body for an app (without entity_id).
function playBody(app, query) {
  const q = cleanQuery(query);
  if (app === 'audible') return { media_content_type: 'custom', media_content_id: 'resume my book on Audible' };
  if (app === 'news') return { media_content_type: 'sequence', media_content_id: 'Alexa.FlashBriefing.Play' };
  if (app === 'kera') return { media_content_type: 'TUNEIN', media_content_id: 'KERA 90.1' };
  if (app === 'tunein') return { media_content_type: 'TUNEIN', media_content_id: q };
  if (app === 'pandora') return q ? { media_content_type: 'PANDORA', media_content_id: q } : { media_content_type: 'custom', media_content_id: 'play Pandora' };
  return q ? { media_content_type: 'AMAZON_MUSIC', media_content_id: q } : { media_content_type: 'custom', media_content_id: 'play Amazon Music' };
}

/* ---------- labels ---------- */

function cleanLabel(l, nowMs) {
  if (!isObj(l) || !APPS[l.app]) return null;
  const at = Number(l.at);
  if (!isFinite(at) || at <= 0) return null;
  if (nowMs - at > LABEL_MAX_MS) return null;
  return {
    app: l.app, label: plain(l.label, 30) || APPS[l.app].label, title: plain(l.title, 60),
    hidden: APPS[l.app].hidden, at: at, playing: l.playing !== false,
    via: plain(l.via, 30), base: typeof l.base === 'string' && l.base.length <= 2000 ? l.base : null
  };
}

function cleanLabels(m, nowMs) {
  const out = {};
  if (!isObj(m)) return out;
  Object.keys(m).forEach((id) => {
    if (!/^media_player\.[a-z0-9_]{1,80}$/.test(id)) return;
    const c = cleanLabel(m[id], nowMs);
    if (c) out[id] = c;
  });
  return out;
}

function loadLabels(dir, nowMs) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return cleanLabels(isObj(j) ? j.labels : null, nowMs);
  } catch (e) {
    return {};
  }
}

function saveLabels(dir, labels) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, labels: labels }, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* best effort */ }
}

/* ---------- a small web request ---------- */

// POST JSON to Home Assistant. Resolves { status }; rejects with e.kind
// 'timeout' or 'network'. Never follows redirects.
function request(url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { const err = new Error('network'); err.kind = 'network'; reject(err); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    let finished = false;
    const end = (fn, v) => { if (finished) return; finished = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      const err = new Error('timeout'); err.kind = 'timeout';
      try { req.destroy(); } catch (e) { /* gone */ }
      end(reject, err);
    }, timeoutMs || REQUEST_MS);
    const fail = () => { const err = new Error('network'); err.kind = 'network'; end(reject, err); };
    const req = lib.request(u, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_REPLY) res.destroy(); });
      res.on('end', () => end(resolve, { status: res.statusCode }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.write(data);
    req.end();
  });
}

/* ---------- the controller ---------- */

/*
 * o.config      from configFromEnv
 * o.dataDir     where echo.json lives
 * o.log, o.now  (now returns ms)
 * o.changed()   called after every successful action
 * o.timeoutMs   for tests
 */
function createController(o) {
  const cfg = o.config || { configured: false, problem: '' };
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const changed = typeof o.changed === 'function' ? o.changed : () => {};
  const timeoutMs = o.timeoutMs || REQUEST_MS;
  const targets = cfg.configured ? cfg.targets : [];
  const stamps = [];
  let problem = '';
  let labels = o.dataDir ? loadLabels(o.dataDir, now()) : {};

  function save() {
    if (!o.dataDir) return;
    try { saveLabels(o.dataDir, labels); } catch (e) { log('echo: could not write the labels file'); }
  }

  // The key to name an entity by in the log ('speaker' when it is not a target).
  function keyOf(entity) {
    const t = targets.filter((x) => !x.group && x.entity === entity)[0] || targets.filter((x) => x.entity === entity)[0];
    return t ? t.key : 'speaker';
  }

  function sweep() {
    const t = now();
    let any = false;
    Object.keys(labels).forEach((id) => {
      if (t - labels[id].at > LABEL_MAX_MS) {
        delete labels[id];
        any = true;
        log('echo: label cleared on ' + keyOf(id) + ' (timeout)');
      }
    });
    if (any) save();
  }

  function labelsCopy() {
    sweep();
    return cleanLabels(JSON.parse(JSON.stringify(labels)), now());
  }

  function clearLabel(id, reason) {
    sweep();
    if (!labels[id]) return false;
    delete labels[id];
    save();
    log('echo: label cleared on ' + keyOf(id) + ' (' + (reason === 'stop' ? 'stop' : reason === 'timeout' ? 'timeout' : 'other playback') + ')');
    return true;
  }

  function setBase(id, sig) {
    if (!labels[id] || typeof sig !== 'string' || sig.length > 2000) return false;
    labels[id].base = sig;
    save();
    return true;
  }

  function allowed() {
    const t = now();
    while (stamps.length && t - stamps[0] >= RATE_MS) stamps.shift();
    if (stamps.length >= RATE_COUNT) return false;
    stamps.push(t);
    return true;
  }

  function targetOf(key) {
    if (!targets.length) return null;
    if (key === undefined || key === null || key === '') return targets[0];
    return targets.filter((t) => t.key === key)[0] || null;
  }

  function entitiesOf(t) {
    return t.group ? t.members.slice() : [t.entity];
  }

  // One Home Assistant service call; resolves { ok } or { ok: false, problem, message }.
  function service(domain, name, data) {
    return request(cfg.url + '/api/services/' + domain + '/' + name, cfg.token, data, timeoutMs).then((r) => {
      if (r.status === 200 || r.status === 201) { problem = ''; return { ok: true }; }
      if (r.status === 401 || r.status === 403) {
        problem = 'auth';
        log('echo: Home Assistant refused the token (' + r.status + ')');
        return { ok: false, problem: 'auth', message: 'Home Assistant refused the token.' };
      }
      problem = 'status';
      log('echo: Home Assistant answered HTTP ' + (Number(r.status) || 0));
      return { ok: false, problem: 'status', message: 'Home Assistant answered HTTP ' + (Number(r.status) || 0) + '.' };
    }, (e) => {
      problem = e && e.kind === 'timeout' ? 'timeout' : 'unreachable';
      log('echo: Home Assistant could not be reached');
      return { ok: false, problem: problem, message: 'Home Assistant could not be reached.' };
    });
  }

  // Common gate: configured, target known, not too fast. Returns { t } or a failure.
  function gate(key) {
    if (!cfg.configured) {
      return { fail: { ok: false, problem: 'off', message: 'Echo controls are off (' + (cfg.problem || 'no HA_TOKEN in .env') + ').' } };
    }
    const t = targetOf(key);
    if (!t) return { fail: { ok: false, problem: 'target', message: 'Unknown target; use one of: ' + targets.map((x) => x.key).join(', ') + '.' } };
    if (!allowed()) return { fail: { ok: false, problem: 'rate', message: 'Too many Echo commands; wait a few seconds.' } };
    return { t: t };
  }

  function done(r, message) {
    if (!r.ok) return r;
    try { changed(); } catch (e) { /* never stops the action */ }
    return { ok: true, message: message };
  }

  function start(app, key, query) {
    return Promise.resolve().then(() => {
      const why = checkStart(app, query);
      if (why) return { ok: false, problem: 'input', message: why[0].toUpperCase() + why.slice(1) + '.' };
      const g = gate(key);
      if (g.fail) return g.fail;
      const t = g.t;
      const a = APPS[app];
      const body = Object.assign({ entity_id: t.entity }, playBody(app, query));
      return service('media_player', 'play_media', body).then((r) => {
        if (!r.ok) return r;
        sweep();
        entitiesOf(t).forEach((id) => {
          labels[id] = {
            app: app, label: a.label, title: a.title, hidden: a.hidden, at: now(), playing: true,
            via: t.group ? GROUP_VIA : '', base: null
          };
        });
        save();
        log('echo: started ' + a.label + ' on ' + t.key);
        return done(r, 'Started ' + a.label + ' on ' + t.key + '.');
      });
    });
  }

  const VOICE = { pause: 'pause', resume: 'resume', next: 'next', stop: 'stop' };
  const SERVICE = { pause: 'media_pause', resume: 'media_play', next: 'media_next_track', stop: 'media_pause' };
  const PAST = { pause: 'Paused', resume: 'Resumed', next: 'Skipped to the next one on', stop: 'Stopped' };

  function transport(action, key) {
    return Promise.resolve().then(() => {
      const g = gate(key);
      if (g.fail) return g.fail;
      const t = g.t;
      sweep();
      const ids = entitiesOf(t);
      const voice = ids.some((id) => labels[id] && labels[id].hidden);
      const call = voice
        ? service('media_player', 'play_media', { entity_id: t.entity, media_content_type: 'custom', media_content_id: VOICE[action] })
        : service('media_player', SERVICE[action], { entity_id: t.entity });
      return call.then((r) => {
        if (!r.ok) return r;
        ids.forEach((id) => {
          if (!labels[id]) return;
          if (action === 'pause') labels[id].playing = false;
          if (action === 'resume') labels[id].playing = true;
          if (action === 'stop') { delete labels[id]; log('echo: label cleared on ' + keyOf(id) + ' (stop)'); }
        });
        save();
        log('echo: ' + action + ' on ' + t.key + (voice ? ' (voice)' : ''));
        return done(r, PAST[action] + ' ' + t.key + (voice ? ' (by voice).' : '.'));
      });
    });
  }

  function volume(level, key) {
    return Promise.resolve().then(() => {
      const why = checkVolume(level);
      if (why) return { ok: false, problem: 'input', message: why[0].toUpperCase() + why.slice(1) + '.' };
      const g = gate(key);
      if (g.fail) return g.fail;
      const t = g.t;
      let call;
      let text;
      if (level === 'up' || level === 'down') {
        call = service('media_player', 'volume_' + level, { entity_id: t.entity });
        text = 'Turned ' + t.key + ' ' + level + '.';
      } else {
        call = service('media_player', 'volume_set', { entity_id: t.entity, volume_level: Number((level / 100).toFixed(2)) });
        text = 'Set ' + t.key + ' volume to ' + level + '.';
      }
      return call.then((r) => {
        if (r.ok) log('echo: volume on ' + t.key);
        return done(r, text);
      });
    });
  }

  function status() {
    sweep();
    const list = Object.keys(labels).map((id) => {
      const l = labels[id];
      return { target: keyOf(id) === 'speaker' ? id : keyOf(id), app: l.app, label: l.label, playing: l.playing, since: new Date(l.at).toISOString() };
    });
    return {
      configured: !!cfg.configured, problem: str(cfg.problem) || (cfg.configured ? problem : ''),
      targets: targets.map((t) => ({ key: t.key, entity: t.entity, group: t.group === true })),
      labels: list
    };
  }

  function startLog() {
    if (!cfg.configured) log(cfg.problem ? 'echo: off (' + cfg.problem + ')' : 'echo: off (no HA_TOKEN in .env)');
    else log('echo: ready (' + targets.length + ' targets)');
  }

  return {
    startLog: startLog, start: start, volume: volume, status: status,
    pause: (key) => transport('pause', key),
    resume: (key) => transport('resume', key),
    next: (key) => transport('next', key),
    stop: (key) => transport('stop', key),
    labels: labelsCopy, clearLabel: clearLabel, setBase: setBase,
    targetKeys: () => targets.map((t) => t.key),
    configured: !!cfg.configured
  };
}

module.exports = {
  APPS: APPS,
  APP_KEYS: APP_KEYS,
  LABEL_MAX_MS: LABEL_MAX_MS,
  MAX_QUERY: MAX_QUERY,
  configFromEnv: configFromEnv,
  checkStart: checkStart,
  checkVolume: checkVolume,
  cleanQuery: cleanQuery,
  playBody: playBody,
  cleanLabels: cleanLabels,
  createController: createController
};
