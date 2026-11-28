'use strict';
/*
 * Moods controller (plan section 4.2): the one place that talks to the plant
 * wall's WLED for Moods, pairs the lamp and bars, starts the Pi-drawn
 * renderer and times the auto events. The server, ./hub moods and the
 * mailbox are thin doors onto http() below.
 *
 *   createController({ env, dataDir, log, now, request, engine, lights, wledSeen,
 *                      timers, rng, put, current, today, timeoutMs })
 *     -> { start (-> the resource, to hold without a push), close, refresh, status, nowFlat, list, set(id, opts), off(opts),
 *          bri(pct, id, opts), event(name, n, opts), probe(opts), tune(id, t), wall(override),
 *          looks, screenAllowed, screenSet(body), command(data), http(method, sub, body),
 *          resource, debug }
 *
 *   env       WLED_URL (the same setting Ambience reads, cleaned the same way),
 *             MOODS_ENGINE none (default) | forest | mood, MOODS_ENGINE_PORT (4810),
 *             MOODS_DRY=1 (never send anything: every call answers as a dry run)
 *   request   (method, url, body, timeoutMs) -> Promise<{ status, json }>; rejects on
 *             no answer. Default: a small http request with a 4 s timeout.
 *   engine    an engine (pi/moods/engine.js shape), or a function (hooks) -> engine
 *             where hooks = { log, now, timers, onExit }. Default: createEngine from env.
 *   lights    the music lights store (pi/lights/store.js): settings(), change(), lookById()
 *   wledSeen  () -> { reachable, on, bri } | null: what Ambience's own 10 s read saw
 *   timers    { setTimeout, clearTimeout } (fake ones in tests); rng () -> [0, 1)
 *   put(data) publish the live resource "moods"; current() -> the resource held now
 *   today     () -> { y, m, d } for Menorah's automatic night (default: the Pi's date)
 *   presetSettleMs, presetPollMs  after a body that selects a preset (ps), wait
 *             presetSettleMs (700), then read /json/state every presetPollMs (200)
 *             until it reports that preset (at most about 2 s), before the next body
 *
 * Passive: nothing is sent to WLED until a person sets a mood or runs a probe.
 * The first mood takes a snapshot of /json/state; Off puts it back
 * (restoreBodies) and forgets it. State lives in data/moods-state.json.
 * Every log line starts "moods:" and holds fixed words and counts only: never
 * an address, a token or a mood's name or id.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const C = require('./catalog');
const W = require('./compile');
const R = require('./render');
const P = require('./preview');
const E = require('./engine');
const ambience = require('../ambience');

const STATE_FILE = 'moods-state.json';
const REQUEST_MS = 4000;
const MAX_REPLY = 512 * 1024;
const RATE_BURST = 3;
const RATE_EVERY_MS = 400;
const PAUSE_MS = 5 * 60 * 1000;
const ENGINE_LEAD_MS = 300;
const PRESET_SETTLE_MS = 700;
const PRESET_POLL_MS = 200;
const PRESET_WAIT_MAX_MS = 2000;
// WLED's colour gamma that the power estimate and forest-render assume.
const GAMMA = 2.8;
const BRI_MIN = 10;
const BRI_MAX = 100;
const MAX_N = 6;
const STALE_BRI = 3;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EVENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PROBE_PATHS = ['/json/info', '/json/effects', '/json/palettes', '/json/cfg', '/json/state'];
const RESULTS = ['ok', 'partial', 'failed'];
const TUNE_KEYS = ['cycleSeconds', 'spans', 'gamma'];

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isByte = (n) => Number.isInteger(n) && n >= 0 && n <= 255;
const copy = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const PLURALS = { body: 'bodies', mismatch: 'mismatches' };
const plural = (n, w) => n + ' ' + (n === 1 ? w : (PLURALS[w] || w + 's'));

function err(status, msg, extra) {
  return Object.assign(new Error(msg), { status }, extra || {});
}
const bad = (msg) => err(400, msg);

/* ---------- settings ---------- */

function configFromEnv(env) {
  const e = env || {};
  const a = ambience.configFromEnv({ WLED_URL: e.WLED_URL });
  const kind = String(e.MOODS_ENGINE || '').trim().toLowerCase();
  const port = Number(String(e.MOODS_ENGINE_PORT || '').trim());
  return {
    wledUrl: a.wledUrl || '',
    wledProblem: a.wledProblem ? 'badurl' : '',
    engine: ['forest', 'mood'].indexOf(kind) >= 0 ? kind : 'none',
    enginePort: Number.isInteger(port) && port > 1024 && port < 65536 ? port : E.DEFAULT_PORT,
    dry: String(e.MOODS_DRY || '').trim() === '1'
  };
}

/* ---------- a small web request (the pattern of pi/ambience.js) ---------- */

function request(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(Object.assign(new Error('network'), { kind: 'network' })); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    let finished = false;
    const fail = (kind) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(kind), { kind }));
    };
    const timer = setTimeout(() => { fail('timeout'); try { req.destroy(); } catch (e) { /* gone */ } }, timeoutMs || REQUEST_MS);
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY) { res.destroy(); fail('reply'); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', () => fail('network'));
    });
    req.on('error', () => fail('network'));
    if (data) req.write(data);
    req.end();
  });
}

/* ---------- the live resource when nothing is known yet ---------- */

function offNow(pair) {
  return { id: 'off', bri: null, path: null, approx: [], night: null, pair: pair !== false, govee: '', stale: false, at: 0 };
}

function notsetData() {
  return { state: 'notset', problem: 'nowled', now: offNow(true), moods: [], wall: null, last: null };
}

// A resource from a state file: kept only when it still looks like one (the
// controller rebuilds it as the server starts anyway).
function cleanResource(r) {
  const rev = isObj(r) && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  const d = isObj(r) ? r.data : null;
  if (!isObj(d) || ['ok', 'notset', 'error'].indexOf(d.state) < 0 || !isObj(d.now) || !Array.isArray(d.moods)) return { rev, data: notsetData() };
  return {
    rev,
    data: {
      state: d.state, problem: typeof d.problem === 'string' ? d.problem.slice(0, 20) : '',
      now: d.now, moods: d.moods, wall: isObj(d.wall) ? d.wall : null,
      last: isObj(d.last) && RESULTS.indexOf(d.last.result) >= 0 ? { result: d.last.result, at: Number(d.last.at) || 0 } : null
    }
  };
}

/* ---------- the state file ---------- */

function emptyState() {
  return { v: 1, current: null, briByMood: {}, pair: true, tune: {}, snapshot: null, probe: null, last: null, offAt: 0 };
}

function cleanSnapshot(s) {
  if (!isObj(s)) return null;
  const o = {};
  if (typeof s.on === 'boolean') o.on = s.on;
  if (isByte(s.bri)) o.bri = s.bri;
  if (Number.isInteger(s.ps)) o.ps = s.ps;
  if (Array.isArray(s.seg)) o.seg = copy(s.seg.filter(isObj).slice(0, 32));
  return o;
}

function loadState(file) {
  const st = emptyState();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return st; }
  if (!isObj(raw)) return st;
  const c = raw.current;
  if (isObj(c) && typeof c.id === 'string' && ID_RE.test(c.id)) {
    st.current = {
      id: c.id, at: Number(c.at) || 0, path: c.path === 'pi-drawn' ? 'pi-drawn' : 'wled-effects',
      bri: Number.isInteger(c.bri) ? c.bri : null, night: Number.isInteger(c.night) ? c.night : null,
      master: isByte(c.master) ? c.master : null, look: typeof c.look === 'string' ? c.look : '',
      govee: typeof c.govee === 'string' ? c.govee : '', approx: Array.isArray(c.approx) ? c.approx.filter((x) => typeof x === 'string') : []
    };
  }
  if (isObj(raw.briByMood)) Object.keys(raw.briByMood).forEach((k) => { const v = raw.briByMood[k]; if (ID_RE.test(k) && Number.isInteger(v) && v >= BRI_MIN && v <= BRI_MAX) st.briByMood[k] = v; });
  if (typeof raw.pair === 'boolean') st.pair = raw.pair;
  if (isObj(raw.tune)) Object.keys(raw.tune).forEach((k) => { if (ID_RE.test(k) && isObj(raw.tune[k])) st.tune[k] = raw.tune[k]; });
  st.snapshot = cleanSnapshot(raw.snapshot);
  if (isObj(raw.probe)) st.probe = raw.probe;
  if (isObj(raw.last) && RESULTS.indexOf(raw.last.result) >= 0) st.last = { result: raw.last.result, at: Number(raw.last.at) || 0, why: typeof raw.last.why === 'string' ? raw.last.why : '' };
  st.offAt = Number(raw.offAt) || 0;
  return st;
}

/* ---------- the controller ---------- */

function createController(opts) {
  const o = opts || {};
  const cfg = configFromEnv(o.env);
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? () => +o.now() : Date.now;
  const timers = o.timers || { setTimeout, clearTimeout };
  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  const req = typeof o.request === 'function' ? o.request : request;
  const timeoutMs = o.timeoutMs || REQUEST_MS;
  const lights = o.lights || null;
  const wledSeen = typeof o.wledSeen === 'function' ? o.wledSeen : () => null;
  const put = typeof o.put === 'function' ? o.put : () => {};
  const current = typeof o.current === 'function' ? o.current : () => null;
  const today = typeof o.today === 'function' ? o.today : () => { const d = new Date(now()); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; };
  const settleMs = Number.isFinite(o.presetSettleMs) && o.presetSettleMs >= 0 ? o.presetSettleMs : PRESET_SETTLE_MS;
  const pollMs = Number.isFinite(o.presetPollMs) && o.presetPollMs > 0 ? o.presetPollMs : PRESET_POLL_MS;
  const dataDir = o.dataDir || null;
  const stateFile = dataDir ? path.join(dataDir, STATE_FILE) : null;

  let catalog = null;
  let wallMap = null;
  let catProblem = '';
  let st = stateFile ? loadState(stateFile) : emptyState();
  let closed = false;
  let chain = Promise.resolve();
  let dirGen = 0;
  const dirHandles = new Set();
  const upHandles = new Set();
  let pausedUntil = 0;
  let seenAtSet = null;
  let lastSig = '';
  let listCache = null;
  let listDay = '';
  const waits = new Map(); // handle -> resolve, so close() can end every wait
  let looksCache = null;
  let tokens = RATE_BURST;
  let tokensAt = now();
  let slowLogged = false;

  function loadCatalog() {
    try {
      const l = C.load(dataDir);
      catalog = l.catalog;
      wallMap = l.wall;
      catProblem = '';
      if (l.ignored && l.ignored.indexOf('power') >= 0) log('moods: wall override ignored (power keys), the map\'s power budget is used');
    } catch (e) {
      catalog = null;
      wallMap = null;
      catProblem = 'catalog';
    }
    listCache = null;
    looksCache = null;
  }
  loadCatalog();

  // After a restart the renderer is gone (it was the hub's child): the wall
  // plays the effects form. Nothing is started by itself.
  if (st.current && (!catalog || !C.moodById(catalog, st.current.id))) st.current = null;
  if (st.current) st.current.path = 'wled-effects';

  const hooks = {
    log, now, timers,
    onExit: () => {
      if (st.current && st.current.path === 'pi-drawn') {
        st.current.path = 'wled-effects';
        save();
        push();
      }
    }
  };
  let engine;
  if (typeof o.engine === 'function') engine = o.engine(hooks);
  else if (o.engine && typeof o.engine === 'object') engine = o.engine;
  else engine = E.createEngine({ kind: cfg.engine, wledHost: E.hostFromUrl(cfg.wledUrl), controlPort: cfg.enginePort, log, now, timers, onExit: hooks.onExit });
  const engineOn = () => !!engine && engine.kind !== 'none';
  // Is this plan for the engine that runs here? (The fake one stands in for the forest.)
  const engineFor = (plan) => !!plan && engineOn() && plan.engine === (engine.kind === 'fake' ? 'forest' : engine.kind);

  /* --- small helpers --- */

  function queue(fn) {
    const p = chain.then(() => fn());
    chain = p.then(() => {}, () => {});
    return p;
  }

  // A timer that never keeps the process alive and that close() ends at once.
  function later(fn, ms) {
    const h = timers.setTimeout(fn, ms);
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  }

  function wait(ms) {
    if (closed) return Promise.resolve();
    return new Promise((resolve) => {
      const h = later(() => { waits.delete(h); resolve(); }, ms);
      waits.set(h, resolve);
    });
  }

  // After an await: nothing more happens once the hub is closing.
  function alive() {
    if (closed) throw err(503, 'the hub is shutting down; set the mood again once it is back');
  }

  function save() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = stateFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n');
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      log('moods: could not save the state file');
    }
  }

  function needWall() {
    if (catProblem) throw err(503, 'the moods catalog could not be read on the Pi (pi/moods/moods.json, wall.json or data/moods-wall.json)');
    if (!cfg.wledUrl) {
      throw err(409, cfg.wledProblem ? 'WLED_URL in pi/.env does not look right (it is like http://plant-wall.local)'
        : 'the plant wall is not set up on the Pi (WLED_URL in pi/.env)');
    }
  }

  function moodOf(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('send a mood id, like christmas (./hub moods list)');
    const m = C.moodById(catalog, id);
    if (!m) throw bad('there is no mood with that id (./hub moods list)');
    return m;
  }

  function briArg(v, what) {
    if (!Number.isInteger(v) || v < BRI_MIN || v > BRI_MAX) throw bad('"' + (what || 'bri') + '" must be a whole number from ' + BRI_MIN + ' to ' + BRI_MAX);
    return v;
  }

  const isPreset = (mood) => !!(mood && mood.wled && Number.isInteger(mood.wled.preset));

  function ctxFor(mood, extra) {
    const x = extra || {};
    const pr = st.probe || {};
    const ctx = {
      catalog, wall: wallMap, date: today(),
      fxIds: Array.isArray(pr.fx) ? pr.fx : null,
      palIds: Array.isArray(pr.pal) ? pr.pal : null,
      have: { mic: typeof pr.mic === 'boolean' ? pr.mic : null }
    };
    // A bulb current the probe read only ever tightens the budget: never below the map's.
    if (typeof pr.ledMa === 'number' && pr.ledMa > 0) ctx.ledMa = Math.max(pr.ledMa, wallMap.power.ledMa);
    if (typeof x.briPct === 'number') ctx.briPct = x.briPct;
    if (Number.isInteger(x.night)) ctx.night = x.night;
    const snap = st.snapshot;
    if (isPreset(mood) && snap && snap.ps === mood.wled.preset) {
      if (isByte(snap.bri)) ctx.presetBri = snap.bri;
      if (Array.isArray(snap.seg)) {
        ctx.segBri = {};
        snap.seg.forEach((s) => { if (Number.isInteger(s.id) && isByte(s.bri)) ctx.segBri[s.id] = s.bri; });
      }
    }
    return ctx;
  }

  // The master brightness a body list sends last (null: the preset's own).
  function masterOf(bodies) {
    let m = null;
    bodies.forEach((b) => { if (isByte(b.bri)) m = b.bri; });
    return m;
  }

  function checksOf(bodies) {
    let out = [];
    bodies.forEach((b) => { out = out.concat(W.checkState(b, wallMap)); });
    return out;
  }

  // One call to the wall. Never rejects: { ok, status, json, why } where why
  // is noanswer, refused or reply.
  function wled(method, p, body) {
    return req(method, cfg.wledUrl + p, body, timeoutMs).then((r) => {
      if (!r || r.status < 200 || r.status >= 300) return { ok: false, why: 'refused' };
      if (method === 'GET' && (r.json === null || typeof r.json !== 'object')) return { ok: false, why: 'reply' };
      return { ok: true, json: r.json };
    }, () => ({ ok: false, why: 'noanswer' }));
  }

  // WLED loads a preset a moment after it answers, and the load brings the
  // preset's own on and bri. So after a body that selects one, and before the
  // next body: wait, then read the state until it reports that preset (about
  // 2 s at most; a wall that does not say goes on after the wait).
  async function presetLanded(n) {
    await wait(settleMs);
    if (closed) return false;
    const tries = Math.max(1, Math.ceil(Math.max(0, PRESET_WAIT_MAX_MS - settleMs) / pollMs));
    for (let i = 0; i < tries; i++) {
      const r = await wled('GET', '/json/state');
      if (closed) return false;
      if (!r.ok) return false;
      if (r.json.ps === n) return true;
      await wait(pollMs);
    }
    log('moods: the preset did not report in time, going on');
    return false;
  }

  // POSTs the bodies in order; stops at the first that fails. A sequence once
  // started is sent to the end even when the hub closes meanwhile (the waits
  // are skipped then), so a preset mood cut short still gets its brightness cap.
  async function sendAll(bodies) {
    for (let i = 0; i < bodies.length; i++) {
      const r = await wled('POST', '/json/state', bodies[i]);
      if (!r.ok) {
        log(r.why === 'refused' ? 'moods: the wall refused a change' : 'moods: the wall did not answer');
        return { n: i, why: r.why };
      }
      if (Number.isInteger(bodies[i].ps) && i < bodies.length - 1) await presetLanded(bodies[i].ps);
    }
    return { n: bodies.length, why: '' };
  }

  function wallFailed(why, what) {
    st.last = { result: 'failed', at: now(), why: why || 'noanswer' };
    save();
    push();
    const words = why === 'refused' ? 'The wall refused the change.' : 'The wall did not answer.';
    return err(502, words + ' ' + what, { result: 'failed' });
  }

  /* --- the renderer and the director --- */

  function engineBusy() {
    if (!engineOn()) return false;
    const s = engine.status();
    return !!(s.running || (s.state && s.state !== 'off'));
  }

  function stopDirector() {
    dirGen += 1;
    dirHandles.forEach((h) => timers.clearTimeout(h));
    dirHandles.clear();
  }

  async function stopActive() {
    stopDirector();
    upHandles.forEach((h) => timers.clearTimeout(h));
    upHandles.clear();
    if (engineBusy()) {
      await engine.stop().catch(() => ({ ok: false }));
      log('moods: renderer stopped');
    }
    // A stop we asked for: the wall is on its own effects from here, even when
    // the set or Off that asked for it then fails.
    if (st.current && st.current.path === 'pi-drawn') st.current.path = 'wled-effects';
  }

  function startDirector(mood) {
    stopDirector();
    const gen = dirGen;
    const evs = (mood.render && mood.render.events) || {};
    const next = (name, a) => {
      const gap = Math.max(1000, Math.round((a[0] + rng() * (a[1] - a[0])) * 1000));
      const h = later(() => {
        dirHandles.delete(h);
        if (closed || gen !== dirGen || !st.current || st.current.id !== mood.id) return;
        if (now() < pausedUntil) { next(name, a); return; }
        queue(() => (gen === dirGen ? fire(mood, name, 1, false) : null)).catch(() => {
          log('moods: an automatic event could not be sent');
        }).then(() => { if (gen === dirGen && !closed) next(name, a); });
      }, gap);
      dirHandles.add(h);
    };
    Object.keys(evs).forEach((name) => {
      const a = evs[name] && evs[name].auto;
      if (Array.isArray(a) && a.length === 2 && a[1] >= a[0] && a[0] > 0) next(name, a);
    });
  }

  // One event: to the renderer when it runs, else the effects form to WLED.
  async function fire(mood, name, n, dry) {
    if (engineBusy() && engine.status().running) {
      if (dry) return { ok: true, dry: true, plan: { engine: { event: name, n } } };
      const r = await engine.event(name, n).catch(() => ({ ok: false }));
      if (r && r.ok) {
        log('moods: event cue sent to the renderer');
        return { ok: true, result: 'ok', to: 'renderer', n };
      }
    }
    const cur = st.current || {};
    const eb = W.eventBodies(mood, name, ctxFor(mood, { briPct: cur.bri, night: cur.night }), rng);
    if (!eb) throw bad('this mood has no effects form for that event');
    const checks = checksOf([eb.down, eb.up]);
    if (checks.length) throw err(500, 'the event did not pass the safety checks; nothing was sent', { checks });
    if (dry) return { ok: true, dry: true, plan: { wled: [eb.down, eb.up].map((b) => ({ method: 'POST', path: '/json/state', body: b })), holdMs: eb.holdMs } };
    const r = await wled('POST', '/json/state', eb.down);
    if (!r.ok) {
      log(r.why === 'refused' ? 'moods: the wall refused an event' : 'moods: the wall did not answer an event');
      throw err(502, 'The wall did not take the event.', { result: 'failed' });
    }
    const h = later(() => {
      upHandles.delete(h);
      if (closed) return;
      queue(() => wled('POST', '/json/state', eb.up)).then((u) => {
        if (!u.ok) log('moods: the wall did not take the end of an event');
      });
    }, eb.holdMs);
    upHandles.add(h);
    log('moods: event dim sent to the wall');
    return { ok: true, result: 'ok', to: 'wall', n: 1, holdMs: eb.holdMs };
  }

  /* --- what the screens see --- */

  function lookOfMood(mood) {
    const g = C.goveeLook(mood);
    if (!g) return null;
    if (g.ref) return { id: g.ref, look: (lights && lights.lookById(g.ref)) || { id: g.ref } };
    return { id: g.id, look: g };
  }

  // The full looks of the moods that carry their own (id "mood-<id>"), for
  // the music lights store's extraLooks: found by id, never listed.
  function looks() {
    if (looksCache) return looksCache;
    const looksLib = require('../lights/looks');
    const out = [];
    (catalog ? catalog.moods : []).forEach((m) => {
      const g = C.goveeLook(m);
      if (!g || g.ref) return;
      try { out.push(looksLib.check(g, 'mood look')); } catch (e) { /* the data test catches these */ }
    });
    looksCache = out;
    return out;
  }

  function tagsOf(mood, comp) {
    const t = [];
    const needs = mood.needs || {};
    if (needs.mic) t.push('mic');
    if (needs.song) t.push('song');
    if (mood.render && mood.render.type === 'pi-drawn' && engineOn()) {
      try {
        const plan = R.compileRender(mood, ctxFor(mood));
        if (engineFor(plan) && engine.can(plan).ok) t.push('pi');
      } catch (e) { /* not drawable */ }
    }
    if (comp && comp.approx.some((a) => a !== 'mic-unverified')) t.push('approx');
    return t;
  }

  // The list the screens draw. Menorah's preview and its automatic night
  // follow the day, so the list is built again when the date changes.
  function moodList() {
    const day = JSON.stringify(today());
    if (listCache && day === listDay) return listCache;
    if (!catalog) return [];
    listDay = day;
    listCache = C.visibleMoods(catalog).map((m) => {
      const ctx = ctxFor(m);
      let comp = null;
      let pv = null;
      try { comp = W.compileWled(m, ctx); } catch (e) { comp = null; }
      try { pv = P.previewOf(m, ctx); } catch (e) { pv = null; }
      const param = m.param ? copy(m.param) : null;
      if (param && param.night) param.night.tonight = W.nightOf(m, ctx); // tonight's night (8 outside Hanukkah)
      return {
        id: m.id, name: m.name, es: m.es, desc: m.desc, descEs: m.descEs, group: m.group, sw: (m.sw || []).slice(0, 4),
        bri: m.bri, tags: tagsOf(m, comp), param, pv
      };
    });
    return listCache;
  }

  function wallView() {
    if (!wallMap) return null;
    const zones = {};
    Object.keys(wallMap.zones).forEach((k) => { zones[k] = { r: copy(wallMap.zones[k].r), sure: wallMap.zones[k].sure !== false }; });
    return { leds: wallMap.leds, zones, menorah: { candles: copy(wallMap.menorah.candles), shamash: copy(wallMap.menorah.shamash) }, geometry: copy(wallMap.geometry) };
  }

  function stale() {
    const c = st.current;
    if (!c) return false;
    const seen = wledSeen();
    if (!seen || !seen.reachable) return false;
    if (JSON.stringify(seen) === seenAtSet) return false; // no read since the mood was set
    if (seen.on === false) return true;
    return c.master != null && typeof seen.bri === 'number' && Math.abs(seen.bri - c.master) > STALE_BRI;
  }

  function nowOf() {
    const c = st.current;
    if (!c) return Object.assign(offNow(st.pair), { at: st.offAt || 0 });
    return { id: c.id, bri: c.bri, path: c.path, approx: c.approx.slice(), night: c.night, pair: st.pair, govee: c.govee, stale: stale(), at: c.at };
  }

  function build() {
    let state = 'ok';
    let problem = '';
    if (catProblem) { state = 'error'; problem = catProblem; } else if (!cfg.wledUrl) { state = 'notset'; problem = cfg.wledProblem || 'nowled'; } else if (st.last && st.last.result === 'failed') { state = 'error'; problem = st.last.why || 'noanswer'; }
    const moods = moodList().map((m) => Object.assign({}, m, { bri: st.briByMood[m.id] || m.bri }));
    return { state, problem, now: nowOf(), moods, wall: wallView(), last: st.last ? { result: st.last.result, at: st.last.at } : null };
  }

  function push() {
    if (closed) return false;
    const next = build();
    const sig = JSON.stringify(next);
    if (sig === lastSig) return false;
    let held = '';
    try { held = JSON.stringify(current()); } catch (e) { held = ''; }
    lastSig = sig;
    if (held === sig) return false;
    try { put(next); } catch (e) { /* the server logged it */ }
    return true;
  }

  /* --- the calls --- */

  async function doSet(id, opt) {
    needWall();
    const mood = moodOf(id);
    const x = opt || {};
    if (x.bri !== undefined && x.bri !== null) briArg(x.bri);
    if (x.night !== undefined && x.night !== null) {
      const p = mood.param && mood.param.night;
      if (!p) throw bad('only Menorah takes a night');
      if (!Number.isInteger(x.night) || x.night < p.min || x.night > p.max) throw bad('"night" must be a whole number from ' + p.min + ' to ' + p.max);
    }
    if (x.pair !== undefined && x.pair !== null && typeof x.pair !== 'boolean') throw bad('"pair" must be true or false');
    const dry = x.dry === true || cfg.dry;
    const pct = Number.isInteger(x.bri) ? x.bri : (st.briByMood[mood.id] || mood.bri);
    // Menorah's night: as sent; else the night on now when Menorah is on (a
    // screen sends it only when a person stepped it); else tonight's (nightFor),
    // else 8 (compile's nightOf does those two).
    let night = Number.isInteger(x.night) ? x.night : undefined;
    if (night === undefined && mood.param && mood.param.night && st.current && st.current.id === mood.id && Number.isInteger(st.current.night)) night = st.current.night;
    const ctx = ctxFor(mood, { briPct: pct, night });
    const comp = W.compileWled(mood, ctx);
    const checks = checksOf(comp.bodies);
    const plan = mood.render && mood.render.type === 'pi-drawn' ? R.compileRender(mood, ctx) : null;
    const can = engineFor(plan) ? engine.can(plan) : null;
    const tune = st.tune[mood.id] || {};
    const pairOn = typeof x.pair === 'boolean' ? x.pair : st.pair;
    let govee = { word: 'off' };
    if (pairOn) {
      const lk = lookOfMood(mood);
      if (!lk || !lights) govee = { word: 'none' };
      else if (lights.settings().on) govee = { word: 'music' };
      else govee = { word: 'set', id: lk.id, look: lk.look };
    }
    const events = {};
    const evs = (mood.render && mood.render.events) || {};
    Object.keys(evs).forEach((k) => { if (Array.isArray(evs[k].auto)) events[k] = { auto: evs[k].auto.slice() }; });

    if (dry) {
      log('moods: dry run, nothing sent');
      return {
        ok: checks.length === 0, dry: true,
        plan: {
          wled: comp.bodies.map((b) => ({ method: 'POST', path: '/json/state', body: b })),
          reads: st.snapshot ? [] : [{ method: 'GET', path: '/json/state' }],
          govee: govee.word === 'set' ? { look: govee.look } : govee.word === 'music' ? { skip: 'music' } : null,
          engine: can ? (can.ok ? { kind: engine.kind, args: engine.argsFor(plan, tune), env: ['WLED_HOST'] } : { kind: engine.kind, refused: can.why }) : null,
          events, budget: comp.budget, checks, approx: comp.approx
        }
      };
    }
    if (checks.length) {
      log('moods: a mood did not pass the safety checks, nothing sent');
      throw err(500, 'the mood did not pass the safety checks; nothing was sent', { checks });
    }

    alive();
    if (!st.snapshot) {
      const r = await wled('GET', '/json/state');
      alive();
      if (!r.ok) throw wallFailed(r.why, 'Nothing changed.');
      st.snapshot = cleanSnapshot(r.json);
      log('moods: snapshot taken (' + plural((st.snapshot.seg || []).length, 'segment') + ')');
      save();
    }
    await stopActive();
    alive();
    const sent = await sendAll(comp.bodies);
    alive();
    if (sent.n === 0) throw wallFailed(sent.why, 'Nothing changed.');
    const result = sent.n === comp.bodies.length ? 'ok' : 'partial';

    let gWord = govee.word;
    if (gWord === 'set') {
      try {
        lights.change({ look: govee.id });
        log('moods: lamp and bars paired');
      } catch (e) {
        gWord = 'failed';
        log('moods: lamp and bars could not be paired');
      }
    } else if (gWord === 'music') {
      log('moods: lamp and bars left alone, music lights are on');
    }
    if (typeof x.pair === 'boolean') st.pair = x.pair;
    if (Number.isInteger(x.bri)) st.briByMood[mood.id] = x.bri;

    let pathWord = 'wled-effects';
    let engineOut = null;
    if (can && !can.ok) engineOut = { ok: false, why: can.why };
    if (result === 'ok' && can && can.ok) {
      await wait(ENGINE_LEAD_MS);
      alive();
      const r = await engine.start(plan, tune).catch(() => ({ ok: false, why: 'the renderer could not start' }));
      if (closed) {
        // close() ran while it started: stop it again, nothing is left behind.
        if (engineBusy()) await engine.stop().catch(() => ({ ok: false }));
        alive();
      }
      if (r && r.ok) {
        pathWord = 'pi-drawn';
        engineOut = { ok: true };
        log('moods: renderer started');
      } else {
        engineOut = { ok: false, why: (r && r.why) || 'the renderer could not start' };
        log('moods: renderer refused, the wall plays the effects form');
      }
    }
    st.current = {
      id: mood.id, at: now(), path: pathWord, bri: pct, night: W.nightOf(mood, ctx), master: masterOf(comp.bodies),
      look: gWord === 'set' ? govee.id : '', govee: gWord, approx: comp.approx.slice()
    };
    st.offAt = 0;
    st.last = { result, at: now(), why: '' };
    const seen = wledSeen();
    seenAtSet = seen ? JSON.stringify(seen) : null;
    startDirector(mood);
    save();
    push();
    log('moods: mood set (' + sent.n + ' of ' + plural(comp.bodies.length, 'body') + ' sent, ' + (pathWord === 'pi-drawn' ? 'Pi-drawn' : 'effects form') + ')');
    const out = { ok: true, result, now: nowOf(), budget: comp.budget, approx: comp.approx, govee: gWord };
    if (engineOut) out.engine = engineOut;
    if (engineOut && !engineOut.ok) out.message = 'The Pi-drawn form did not start (' + engineOut.why + '); the wall plays the effects form.';
    return out;
  }

  async function doOff(opt) {
    needWall();
    const dry = (opt && opt.dry === true) || cfg.dry;
    const cur = st.current;
    if (!cur && !st.snapshot) {
      return dry ? { ok: true, dry: true, plan: { wled: [], govee: null, engine: null } } : { ok: true, result: 'ok', nothing: true, now: nowOf() };
    }
    let bodies = W.restoreBodies(st.snapshot, wallMap);
    if (checksOf(bodies).length) {
      bodies = W.restoreBodies(null, wallMap);
      log('moods: the snapshot could not be put back as it was, the live preset is used');
    }
    const clearLook = !!(cur && cur.look && lights && lights.settings().look === cur.look);
    if (dry) {
      log('moods: dry run, nothing sent');
      return {
        ok: true, dry: true,
        plan: { wled: bodies.map((b) => ({ method: 'POST', path: '/json/state', body: b })), govee: clearLook ? { clear: cur.look } : null, engine: engineBusy() ? { stop: true } : null }
      };
    }
    await stopActive();
    alive();
    const sent = await sendAll(bodies);
    alive();
    if (sent.n === 0) throw wallFailed(sent.why, cur ? 'It still shows the mood.' : 'Nothing changed.');
    const result = sent.n === bodies.length ? 'ok' : 'partial';
    if (clearLook) {
      try { lights.change({ look: '' }); log('moods: lamp and bars preset cleared'); } catch (e) { log('moods: lamp and bars preset could not be cleared'); }
    }
    st.current = null;
    if (result === 'ok') st.snapshot = null;
    st.offAt = now();
    st.last = { result, at: now(), why: '' };
    save();
    push();
    log('moods: wall put back (' + sent.n + ' of ' + plural(bodies.length, 'body') + ' sent)');
    return { ok: true, result, now: nowOf() };
  }

  async function doBri(pct, id, opt) {
    needWall();
    briArg(pct, 'pct');
    const dry = (opt && opt.dry === true) || cfg.dry;
    const cur = st.current;
    if (id === undefined || id === null) {
      if (!cur) throw err(409, 'no mood is on; say which mood (id) to keep this brightness for');
      id = cur.id;
    }
    const mood = moodOf(id);
    // The hidden check mood is fitted to the power budget at its own level
    // only, so a brighter master could top the budget: it takes no brightness.
    if (mood.hidden) throw bad('this mood has no brightness control (it is fitted to the power budget at its own level)');
    if (!cur || cur.id !== mood.id) {
      if (dry) return { ok: true, dry: true, plan: { wled: [], saved: { id: mood.id, bri: pct } } };
      st.briByMood[mood.id] = pct;
      save();
      push();
      log('moods: brightness kept for later');
      return { ok: true, result: 'saved', applied: false, now: nowOf() };
    }
    const ctx = ctxFor(mood, { briPct: pct, night: cur.night });
    const comp = W.compileWled(mood, ctx);
    let master = masterOf(comp.bodies);
    if (master === null) master = isByte(ctx.presetBri) ? ctx.presetBri : W.masterOf(pct);
    const body = { bri: master };
    const checks = checksOf([body]);
    if (checks.length) throw err(500, 'the change did not pass the safety checks; nothing was sent', { checks });
    if (dry) return { ok: true, dry: true, plan: { wled: [{ method: 'POST', path: '/json/state', body }] } };
    const r = await wled('POST', '/json/state', body);
    alive();
    if (!r.ok) throw wallFailed(r.why, 'The brightness did not change.');
    cur.bri = pct;
    cur.master = master;
    st.briByMood[mood.id] = pct;
    st.last = { result: 'ok', at: now(), why: '' };
    const seen = wledSeen();
    seenAtSet = seen ? JSON.stringify(seen) : null;
    save();
    push();
    log('moods: brightness changed');
    return { ok: true, result: 'ok', applied: true, now: nowOf() };
  }

  // The lamp and bars only, for the mood on now (a screen's pairing switch):
  // the wall and the renderer are left as they are.
  // id: the mood the switch was for; when another mood (or none) is on by
  // now, only the remembered choice changes and the lights are left alone.
  function doPair(pair, id) {
    if (typeof pair !== 'boolean') throw bad('"pair" must be true or false');
    if (cfg.dry) return { ok: true, dry: true, plan: { pair } };
    const cur = st.current && (id === undefined || id === null || st.current.id === id) ? st.current : null;
    const mood = cur ? C.moodById(catalog, cur.id) : null;
    st.pair = pair;
    let word = 'off';
    if (cur && mood && pair) {
      const lk = lookOfMood(mood);
      if (!lk || !lights) word = 'none';
      else if (lights.settings().on) { word = 'music'; log('moods: lamp and bars left alone, music lights are on'); } else {
        try {
          lights.change({ look: lk.id });
          word = 'set';
          cur.look = lk.id;
          log('moods: lamp and bars paired');
        } catch (e) {
          word = 'failed';
          log('moods: lamp and bars could not be paired');
        }
      }
    }
    if (cur && !pair) { cur.look = ''; log('moods: lamp and bars left as they are from now on'); }
    if (cur) cur.govee = word;
    save();
    push();
    return { ok: true, result: cur ? 'ok' : 'saved', applied: !!cur, now: nowOf(), govee: word };
  }

  async function doEvent(name, n, opt) {
    needWall();
    const x = opt || {};
    if (typeof name !== 'string' || !EVENT_RE.test(name)) throw bad('send an event name, like thunder');
    const count = n === undefined || n === null ? 1 : n;
    if (!Number.isInteger(count) || count < 1 || count > MAX_N) throw bad('"n" must be a whole number from 1 to ' + MAX_N);
    const dry = x.dry === true || cfg.dry;
    const cur = st.current;
    if (!cur) throw err(409, 'no mood is on');
    const mood = C.moodById(catalog, cur.id);
    const ev = mood && mood.render && mood.render.events && mood.render.events[name];
    if (!ev) throw bad('the mood on now has no "' + name + '" event');
    if (x.outside !== false && !dry) {
      if (now() >= pausedUntil) log('moods: outside cue, automatic events paused for 5 minutes');
      pausedUntil = now() + PAUSE_MS;
    }
    return fire(mood, name, count, dry);
  }

  async function doProbe(opt) {
    needWall();
    if ((opt && opt.dry === true) || cfg.dry) return { ok: true, dry: true, plan: { wled: PROBE_PATHS.map((p) => ({ method: 'GET', path: p })) } };
    const res = [];
    for (let i = 0; i < PROBE_PATHS.length; i++) res.push(await wled('GET', PROBE_PATHS[i]));
    const read = res.filter((r) => r.ok).length;
    if (!read) throw wallFailed(res[0].why, 'Nothing was read.');
    const [info, fx, pal, conf, state] = res.map((r) => (r.ok ? r.json : null));
    const mism = [];
    const names = (list) => (Array.isArray(list) && list.every((s) => typeof s === 'string') ? list : null);
    const fxNames = names(fx);
    const palNames = names(pal);
    const compare = (table, list, what) => {
      Object.keys(table || {}).forEach((k) => {
        const t = table[k];
        const at = list.indexOf(t.name);
        if (at < 0) mism.push(what + ' "' + t.name + '" is missing');
        else if (at !== t.id) mism.push(what + ' "' + t.name + '" is number ' + at + ' here, not ' + t.id);
      });
    };
    if (fxNames) compare(catalog.fx, fxNames, 'effect'); else mism.push('the effect list could not be read');
    if (palNames) compare(catalog.pals, palNames, 'palette'); else mism.push('the palette list could not be read');
    const leds = info && isObj(info.leds) && Number.isInteger(info.leds.count) ? info.leds.count : null;
    if (leds !== null && leds !== wallMap.leds) mism.push('the wall has ' + leds + ' LEDs, the map says ' + wallMap.leds);
    const hw = conf && isObj(conf.hw) && isObj(conf.hw.led) ? conf.hw.led : {};
    let maxPwr = Number.isInteger(hw.maxpwr) ? hw.maxpwr : (info && isObj(info.leds) && Number.isInteger(info.leds.maxpwr) ? info.leds.maxpwr : null);
    if (maxPwr !== null && maxPwr !== wallMap.power.limiterMa) mism.push('the power limit is ' + maxPwr + ' mA, the map says ' + wallMap.power.limiterMa);
    let ledMa = Number.isInteger(hw.ledma) ? hw.ledma : (Array.isArray(hw.ins) && hw.ins[0] && Number.isInteger(hw.ins[0].ledma) ? hw.ins[0].ledma : null);
    if (ledMa !== null && (ledMa < 1 || ledMa > 254)) ledMa = null;
    if (ledMa !== null && ledMa !== wallMap.power.ledMa) {
      mism.push('the bulb current is ' + ledMa + ' mA, the map assumes ' + wallMap.power.ledMa + (ledMa < wallMap.power.ledMa ? ' (the budget keeps ' + wallMap.power.ledMa + ')' : ''));
    }
    // WLED's colour gamma (cfg.light.gc.col): the power estimate and the
    // Pi-drawn renderer assume 2.8 (WLED's default). Newer WLED stores the
    // value itself (1 = off); older WLED a true/false with the value in gc.val.
    const gc = conf && isObj(conf.light) && isObj(conf.light.gc) ? conf.light.gc : null;
    let gamma = null;
    if (gc && typeof gc.col === 'number' && isFinite(gc.col)) gamma = gc.col > 1 ? gc.col : 1;
    else if (gc && typeof gc.col === 'boolean') gamma = gc.col ? (typeof gc.val === 'number' && isFinite(gc.val) ? gc.val : GAMMA) : 1;
    if (gamma !== null) gamma = Math.round(gamma * 100) / 100;
    const notes = [];
    if (gamma === null) notes.push('colour gamma not read: ' + GAMMA + ' (WLED\'s default) is assumed for the power estimate');
    else if (Math.abs(gamma - GAMMA) > 0.05) mism.push('the colour gamma is ' + (gamma === 1 ? 'off' : gamma) + ', the power estimate assumes ' + GAMMA);
    const live = conf && isObj(conf.if) && isObj(conf.if.live) ? conf.if.live : null;
    const realtime = live && typeof live.en === 'boolean' ? live.en : null;
    if (realtime === false) mism.push('receive realtime is off');
    const segments = state && Array.isArray(state.seg) ? state.seg.length : null;
    if (segments !== null && segments !== wallMap.live.segments.length) mism.push('the wall has ' + plural(segments, 'segment') + ' now, the live preset has ' + wallMap.live.segments.length);
    let mic = null;
    if (fxNames) {
      const micFx = Object.keys(catalog.fx).filter((k) => catalog.fx[k].mic);
      mic = micFx.every((k) => fxNames.indexOf(catalog.fx[k].name) >= 0);
    }
    if (maxPwr === null) maxPwr = st.probe && st.probe.maxPwr != null ? st.probe.maxPwr : null;
    st.probe = {
      at: now(), fx: fxNames, pal: palNames, ledMa, maxPwr, segments, realtime, leds, mic, gamma,
      ver: info && typeof info.ver === 'string' ? info.ver.slice(0, 20) : null
    };
    listCache = null;
    save();
    push();
    log('moods: probe read ' + read + ' of ' + PROBE_PATHS.length + ', ' + plural(mism.length, 'mismatch'));
    return {
      ok: true, read, of: PROBE_PATHS.length, mismatches: mism, notes,
      counts: { effects: fxNames ? fxNames.length : null, palettes: palNames ? palNames.length : null, segments },
      leds, maxPwr, ledMa, budgetLedMa: ledMa === null ? wallMap.power.ledMa : Math.max(ledMa, wallMap.power.ledMa), gamma, realtime, mic, ver: st.probe.ver
    };
  }

  function doTune(id, t) {
    if (catProblem) needWall();
    const mood = moodOf(id);
    if (!mood.render || mood.render.type !== 'pi-drawn') throw bad('only Pi-drawn moods take a tune');
    const b = isObj(t) ? t : {};
    const dry = b.dry === true || cfg.dry;
    const given = TUNE_KEYS.filter((k) => b[k] !== undefined);
    if (!given.length) throw bad('say what to tune: cycleSeconds, spans or gamma');
    const next = Object.assign({}, st.tune[mood.id] || {});
    given.forEach((k) => {
      const v = b[k];
      if (v === null) { delete next[k]; return; }
      if (k === 'cycleSeconds' && !(typeof v === 'number' && isFinite(v) && v >= 1 && v <= 3600)) throw bad('"cycleSeconds" must be a number from 1 to 3600, or null');
      if (k === 'spans' && !(Number.isInteger(v) && v >= 1 && v <= 16)) throw bad('"spans" must be a whole number from 1 to 16, or null');
      if (k === 'gamma' && !(v === 'off' || (typeof v === 'number' && isFinite(v) && v >= 0.5 && v <= 5))) throw bad('"gamma" must be off, a number from 0.5 to 5, or null');
      next[k] = v;
    });
    const plan = R.compileRender(mood, ctxFor(mood));
    const args = R.forestArgs(plan, next, { controlPort: cfg.enginePort });
    const why = E.argsWhy(args, require('./forest-render'));
    if (why) throw bad(why);
    if (dry) {
      log('moods: dry run, nothing saved');
      return { ok: true, dry: true, id: mood.id, tune: next, args, plan: { tune: next, args } };
    }
    if (Object.keys(next).length) st.tune[mood.id] = next;
    else delete st.tune[mood.id];
    save();
    log(Object.keys(next).length ? 'moods: tune saved (' + plural(Object.keys(next).length, 'setting') + ')' : 'moods: tune back to the defaults');
    return { ok: true, id: mood.id, tune: next, args };
  }

  function doWall(override, opt) {
    if (override === undefined) throw bad('send { "override": {...} }, or { "override": null } to remove the fix');
    const dry = (opt && opt.dry === true) || cfg.dry;
    if (!dataDir && !dry) throw err(500, 'no data folder');
    const file = dataDir ? path.join(dataDir, C.OVERRIDE_FILE) : '';
    if (override === null && dry) {
      log('moods: dry run, nothing saved');
      return { ok: true, dry: true, override: false, plan: { remove: true } };
    }
    if (override === null) {
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw err(500, 'the wall map fix could not be removed'); }
      loadCatalog();
      push();
      log('moods: wall map fix removed');
      return { ok: true, override: false, problem: catProblem || '' };
    }
    const ob = C.checkOverride(override);
    if (ob.length) throw bad(ob[0]);
    let base;
    try { base = JSON.parse(fs.readFileSync(C.WALL_FILE, 'utf8')); } catch (e) { throw err(500, 'pi/moods/wall.json could not be read'); }
    let cat = catalog;
    if (!cat) { try { cat = JSON.parse(fs.readFileSync(C.MOODS_FILE, 'utf8')); } catch (e) { throw err(500, 'pi/moods/moods.json could not be read'); } }
    const merged = C.mergeWall(base, override);
    const problems = C.validate(cat, merged);
    if (problems.length) throw bad('the wall map fix does not fit: ' + problems[0]);
    // Power values the fix asked for that would loosen the budget are kept at the file's.
    const asked = isObj(override.power) ? override.power : {};
    const clamped = Object.keys(asked).filter((k) => typeof asked[k] === 'number' && merged.power[k] !== asked[k]).map((k) => k + ' ' + merged.power[k]);
    if (dry) {
      log('moods: dry run, nothing saved');
      const sureD = Object.keys(merged.zones).filter((k) => merged.zones[k].sure !== false).length;
      return { ok: true, dry: true, override: true, zones: Object.keys(merged.zones).length, sure: sureD, clamped, plan: { power: copy(merged.power) } };
    }
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(override, null, 1) + '\n');
      fs.renameSync(file + '.tmp', file);
    } catch (e) { throw err(500, 'the wall map fix could not be saved'); }
    loadCatalog();
    push();
    log('moods: wall map fix saved (' + plural(Object.keys(override).filter((k) => k !== 'v').length, 'part') + ')');
    const sure = Object.keys(wallMap.zones).filter((k) => wallMap.zones[k].sure !== false).length;
    return { ok: true, override: true, zones: Object.keys(wallMap.zones).length, sure, clamped, problem: catProblem || '' };
  }

  /* --- status --- */

  function status() {
    const d = build();
    const es = engineOn() ? engine.status() : null;
    const pr = st.probe;
    const cur = st.current ? C.moodById(catalog, st.current.id) : null;
    return {
      configured: !!cfg.wledUrl, state: d.state, problem: d.problem, dry: cfg.dry,
      now: Object.assign({ name: cur ? cur.name : '' }, d.now),
      moods: d.moods.map((m) => ({ id: m.id, name: m.name, group: m.group, bri: m.bri, tags: m.tags, night: !!(m.param && m.param.night) })),
      engine: { kind: engine ? engine.kind : 'none', running: !!(es && es.running), fps: es ? es.fps : null, scale: es ? es.scale : null, estMa: es ? es.estMa : null },
      probe: pr ? { at: pr.at, effects: pr.fx ? pr.fx.length : null, palettes: pr.pal ? pr.pal.length : null, ledMa: pr.ledMa, maxPwr: pr.maxPwr, segments: pr.segments, realtime: pr.realtime, mic: pr.mic, gamma: pr.gamma === undefined ? null : pr.gamma, ver: pr.ver } : null,
      snapshot: !!st.snapshot, pair: st.pair, last: d.last,
      director: { events: dirHandles.size, pausedFor: Math.max(0, Math.round((pausedUntil - now()) / 1000)) },
      tune: copy(st.tune)
    };
  }

  // Flat, for Home Assistant's REST sensor.
  function nowFlat() {
    const n = nowOf();
    const cur = st.current ? C.moodById(catalog, st.current.id) : null;
    return { ok: true, id: n.id, name: cur ? cur.name : 'Off', on: !!st.current, bri: n.bri, path: n.path, stale: n.stale, night: n.night, pair: n.pair, since: n.at };
  }

  function list() {
    return build().moods.map((m) => ({ id: m.id, name: m.name, group: m.group, bri: m.bri, tags: m.tags, night: !!(m.param && m.param.night) }));
  }

  /* --- doors --- */

  function screenAllowed() {
    const t = now();
    tokens = Math.min(RATE_BURST, tokens + (t - tokensAt) / RATE_EVERY_MS);
    tokensAt = t;
    if (tokens >= 1) {
      tokens -= 1;
      slowLogged = false;
      return true;
    }
    if (!slowLogged) { slowLogged = true; log('moods: a screen sent commands too fast (asked it to slow down)'); }
    return false;
  }

  const answer = (p, note) => Promise.resolve().then(p).then((body) => ({ status: 200, body, note: note ? note(body) : (body.dry ? 'dry run' : body.result || 'ok') }), (e) => {
    const status = e && e.status ? e.status : 500;
    if (status === 500 && !(e && e.checks)) log('moods: unexpected problem with a command');
    const body = { ok: false, error: e && e.status ? e.message : 'the server had a problem' };
    if (e && e.result) body.result = e.result;
    if (e && e.checks) body.checks = e.checks;
    return { status, body, note: e && e.result ? e.result : 'refused' };
  });

  // The screens' door: saved ids only, never a dry run.
  //   { id, pair?, night?, bri? }  pick a mood (sent in full); { off: true }
  //   { id, bri }                  brightness only (bri(): the mood on now gets
  //                                just its master brightness, another one keeps it for later)
  //   { id, pair | night, step: true }   a control moved on a screen, for that
  //                                mood: pairing changes only the lamp and bars,
  //                                night sends the mood again with that night.
  //   { bri }                      the brightness of the mood on now
  // A step that arrives after the mood went off (or another came on) never
  // turns it back on: bri is kept for later, pairing only remembered, night ignored.
  function screenSet(body) {
    const b = isObj(body) ? body : {};
    const keys = Object.keys(b).filter((k) => b[k] !== undefined);
    const only = (list) => keys.every((k) => list.indexOf(k) >= 0);
    return answer(() => {
      if (b.off === true) return off({});
      if (b.id === undefined && keys.length === 1 && keys[0] === 'bri') return bri(b.bri, null, {});
      if (typeof b.id !== 'string' || !catalog || !C.visibleMoods(catalog).some((m) => m.id === b.id)) throw bad('send the id of a saved mood, or { "off": true }');
      if (b.step !== undefined && b.step !== true) throw bad('"step" must be true');
      const x = {};
      ['bri', 'night', 'pair'].forEach((k) => { if (b[k] !== undefined) x[k] = b[k]; });
      const step = b.step === true;
      if (b.bri !== undefined && only(['id', 'bri', 'step'])) return bri(b.bri, b.id, {});
      if (step && b.pair !== undefined && only(['id', 'pair', 'step'])) return queue(() => doPair(b.pair, b.id));
      if (step && b.night !== undefined && only(['id', 'night', 'step'])) {
        return queue(() => (st.current && st.current.id === b.id ? doSet(b.id, x) : { ok: true, result: 'ignored', applied: false, now: nowOf() }));
      }
      if (step) throw bad('a step sends one of bri, night or pair with the id');
      return set(b.id, x);
    });
  }

  // The command { type: "mood", data } from POST /api/command (Home Assistant):
  // { id }, { id: "off" }, { bri } (the mood on now), { event, n? }; pair, night, bri with an id.
  function command(data) {
    const d = isObj(data) ? data : {};
    return answer(() => {
      if (d.event !== undefined) return event(d.event, d.n, { outside: true });
      if (d.id === 'off') return off({});
      if (d.id !== undefined) {
        const x = {};
        ['bri', 'night', 'pair'].forEach((k) => { if (d[k] !== undefined) x[k] = d[k]; });
        return set(d.id, x);
      }
      if (d.bri !== undefined) return bri(d.bri);
      throw bad('the mood command needs an id, bri or event');
    });
  }

  // The control API: sub is '/moods', '/moods/now', '/moods/set', ...
  function httpCall(method, sub, body) {
    const b = isObj(body) ? body : {};
    if (method === 'GET' && sub === '/moods') return Promise.resolve({ status: 200, body: Object.assign({ ok: true }, status()) });
    if (method === 'GET' && sub === '/moods/now') return Promise.resolve({ status: 200, body: nowFlat() });
    if (method !== 'POST') return Promise.resolve({ status: 405, body: { ok: false, error: 'use POST for /api' + sub } });
    const opt = (keys) => { const x = {}; keys.forEach((k) => { if (b[k] !== undefined) x[k] = b[k]; }); return x; };
    if (sub === '/moods/set') return answer(() => set(b.id, opt(['bri', 'night', 'pair', 'dry'])));
    if (sub === '/moods/off') return answer(() => off(opt(['dry'])));
    if (sub === '/moods/bri') return answer(() => bri(b.pct, b.id, opt(['dry'])));
    if (sub === '/moods/event') return answer(() => event(b.name, b.n, Object.assign({ outside: true }, opt(['dry']))));
    if (sub === '/moods/probe') return answer(() => probe(opt(['dry'])), (r) => (r.dry ? 'dry run' : 'read ' + r.read + ' of ' + r.of));
    if (sub === '/moods/tune') return answer(() => tune(b.id, b), (r) => (r.dry ? 'dry run' : 'saved'));
    if (sub === '/moods/wall') return answer(() => wall(b.override, opt(['dry'])), (r) => (r.dry ? 'dry run' : r.override ? 'saved' : 'removed'));
    return Promise.resolve({ status: 404, body: { ok: false, error: 'no such call' } });
  }

  function set(id, x) { return queue(() => doSet(id, x)); }
  function off(x) { return queue(() => doOff(x)); }
  function bri(pct, id, x) { return queue(() => doBri(pct, id, x)); }
  function event(name, n, x) { return queue(() => doEvent(name, n, x)); }
  function probe(x) { return queue(() => doProbe(x)); }
  function tune(id, t) { return queue(() => doTune(id, t)); }
  function wall(override, x) { return queue(() => doWall(override, x)); }

  function start() {
    if (catProblem) log('moods: the catalog could not be read, moods off');
    else if (!cfg.wledUrl) log(cfg.wledProblem ? 'moods: off (WLED_URL does not look right)' : 'moods: off (no WLED_URL in .env)');
    else log('moods: on (' + plural(C.visibleMoods(catalog).length, 'mood') + ', engine ' + (engine ? engine.kind : 'none') + (cfg.dry ? ', dry run only' : '') + ')');
    // The resource as it stands, for the caller to hold quietly (no new rev, no
    // push); later changes are pushed through put() as usual.
    const d = build();
    lastSig = JSON.stringify(d);
    return d;
  }

  // Ambience read the wall again (or anything else that may change "stale").
  function refresh() { return push(); }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    stopDirector();
    upHandles.forEach((h) => timers.clearTimeout(h));
    upHandles.clear();
    // End every wait now: the call waiting on it sees closed and stops.
    waits.forEach((resolve, h) => { timers.clearTimeout(h); resolve(); });
    waits.clear();
    if (engineBusy()) return engine.stop().then(() => {}, () => {});
    return Promise.resolve();
  }

  return {
    start, close, refresh, status, nowFlat, list, set, off, bri, event, probe, tune, wall, looks,
    screenAllowed, screenSet, command, http: httpCall,
    resource: build, engine: () => engine,
    debug: () => ({ director: dirHandles.size, ups: upHandles.size, pausedUntil, snapshot: copy(st.snapshot), state: copy(st) })
  };
}

module.exports = { createController, configFromEnv, request, notsetData, cleanResource, offNow, STATE_FILE, PAUSE_MS, ENGINE_LEAD_MS, PROBE_PATHS };
