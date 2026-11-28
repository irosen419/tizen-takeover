'use strict';
/*
 * Moods engine adapter: starts the Pi-drawn renderer (pi/moods/forest-render.js,
 * or the general pi/moods/mood-render.js) as a child process with its real
 * flags, cues it on its real trigger port and reads its real log lines.
 *
 *   createEngine({ kind, script, wledHost, controlPort, spawn, udp, log, now, timers, onExit, env })
 *   createFakeEngine(script)
 *
 * Both return { kind, can(plan), argsFor(plan, tune), start(plan, tune), event(name, n), stop(), status() }.
 * The WLED host only ever travels in the child's WLED_HOST variable: never in
 * the argument list, a log line, a reason or status(). Log lines start "moods:"
 * and hold fixed words only. An unexpected exit is logged once and reported to
 * onExit; nothing is restarted.
 */
const path = require('path');

const KINDS = ['none', 'fake', 'forest', 'mood'];
const DEFAULT_PORT = 4810;
const START_TIMEOUT_MS = 20000; // DNS + WLED probe (2 s timeouts) + the fixed power scale on a Pi
const QUIT_WAIT_MS = 700;
const KILL_AT_MS = 2000;
const GIVE_UP_MS = 3000;
const LAST_LINE_MAX = 160;
const EXIT_LINE = 'moods: renderer stopped, wall on its own effects';

// forest-render's thunder: pickGroup() in forest-render.js hard-codes these.
const FOREST_THUNDER = { size: [2, 4], depth: [0.5, 0.75], hold: [1, 2.5] };

const STREAMING_RE = /streaming (\d+) LEDs at (\d+) fps, cycle (\d+(?:\.\d+)?) s, gamma (\d+(?:\.\d+)?), scale (\d+(?:\.\d+)?), est (\d+) mA/;

function scriptFor(kind) {
  return path.join(__dirname, kind === 'mood' ? 'mood-render.js' : 'forest-render.js');
}

// "http://wall.local:8080/" -> "wall.local:8080"; null when not usable.
function hostFromUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u;
  try { u = new URL(url.trim()); } catch (e) { return null; }
  if (u.protocol !== 'http:' || !u.hostname || u.hostname.charAt(0) === '[') return null;
  return u.port ? u.hostname + ':' + u.port : u.hostname;
}

function sameNum(a, b) { return typeof a === 'number' && Math.abs(a - b) < 1e-9; }
function samePair(a, b) { return Array.isArray(a) && a.length === 2 && sameNum(a[0], b[0]) && sameNum(a[1], b[1]); }
function hexKey(h) { return typeof h === 'string' ? h.replace(/^#/, '').toUpperCase() : ''; }

// '' = the forest script can draw this plan as it is; else a plain reason.
function forestWhy(plan, F) {
  if (!plan || typeof plan !== 'object') return 'no plan';
  if (plan.v !== 1) return 'plan version not supported';
  if (plan.engine != null && plan.engine !== 'forest') return 'plan is for another engine';
  if (plan.leds != null && plan.leds !== F.LED_COUNT) return 'LED count differs';
  const pal = plan.palette;
  if (!Array.isArray(pal) || pal.length !== F.PALETTE_HEX.length ||
      pal.some((h, i) => hexKey(h) !== F.PALETTE_HEX[i].toUpperCase())) return 'palette differs from the forest table';
  const secs = plan.sections;
  if (!Array.isArray(secs) || secs.length !== F.WALL.sections.length ||
      secs.some((s, i) => {
        const w = F.WALL.sections[i];
        return !s || s.start !== w.start || s.end !== w.end || !samePair(s.dim, w.dim);
      })) return 'sections differ from the forest wall map';
  if (plan.black != null) {
    const ok = Array.isArray(plan.black) && plan.black.every((r) => Array.isArray(r) && r[0] >= F.WALL.spare[0] && r[1] <= F.WALL.spare[1]);
    if (!ok) return 'black bulbs differ from the forest wall map';
  }
  if (plan.layers != null) {
    if (!Array.isArray(plan.layers) || plan.layers.some((l) => !l || l.kind !== 'palette')) return 'layers other than the palette wash';
  }
  const ev = plan.events == null ? {} : plan.events;
  if (typeof ev !== 'object' || Array.isArray(ev)) return 'events not readable';
  for (const name of Object.keys(ev)) {
    if (name !== 'thunder') return 'event other than thunder';
    const t = ev.thunder || {};
    if (t.kind != null && t.kind !== 'dim') return 'thunder is not a dim';
    const fixed = { attack: F.ATTACK, release: F.RELEASE, floor: F.DIM_FLOOR };
    for (const k of Object.keys(fixed)) if (t[k] != null && !sameNum(t[k], fixed[k])) return 'thunder ' + k + ' differs from the script';
    for (const k of Object.keys(FOREST_THUNDER)) if (t[k] != null && !samePair(t[k], FOREST_THUNDER[k])) return 'thunder ' + k + ' differs from the script';
  }
  return '';
}

function num(v) { return typeof v === 'number' && isFinite(v); }

// The renderer's flags. Pure: no host, never --auto, --no-preset always.
function buildArgs(kind, plan, tune, controlPort, F) {
  const p = plan || {};
  const t = tune || {};
  const D = F.DEFAULTS;
  const drift = p.drift || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(t, k) && t[k] !== undefined;
  const cycle = has('cycleSeconds') ? t.cycleSeconds : drift.cycleSeconds;
  const spans = has('spans') && t.spans != null ? t.spans : (drift.spans != null ? drift.spans : D.spans);
  const gamma = has('gamma') ? t.gamma : p.gamma;
  const a = ['--no-preset', '--fps', String(num(p.fps) ? p.fps : D.fps)];
  if (cycle != null) a.push('--cycle', String(cycle));
  a.push('--spans', String(spans));
  a.push('--groups', String(num(p.groups) ? p.groups : D.groups));
  a.push('--max-ma', String(num(p.maxMa) ? p.maxMa : D.maxMa));
  if (gamma === 'off' || gamma === false) a.push('--gamma', 'off');
  else if (num(gamma)) a.push('--gamma', String(gamma));
  a.push('--control-port', String(controlPort));
  if (has('seed') && t.seed != null) a.push('--seed', String(t.seed));
  if (kind === 'mood') a.push('--plan', '-');
  return a;
}

// Flags the script would refuse (exit 2), checked with the script's own parser.
function argsWhy(args, F) {
  const r = F.parseArgs(args.filter((x, i) => !(x === '--plan' || args[i - 1] === '--plan')).concat(['--dry-run']), {});
  return r.ok ? '' : 'setting refused: ' + r.error;
}

function thunderCount(n) {
  if (n == null) return 1;
  if (!Number.isInteger(n) || n < 1 || n > 6) return null;
  return n;
}

function defaultUdp(text, port, address) {
  const dgram = require('dgram');
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', (e) => { try { s.close(); } catch (x) { /* closed */ } reject(e); });
    s.send(Buffer.from(text, 'utf8'), port, address, (err) => {
      try { s.close(); } catch (x) { /* closed */ }
      if (err) reject(err); else resolve();
    });
  });
}

function emptyStatus() {
  return { running: false, id: null, since: null, fps: null, cycle: null, gamma: null, scale: null, estMa: null, lastLine: '' };
}

function createEngine(opts) {
  const o = opts || {};
  const kind = KINDS.indexOf(o.kind) >= 0 ? o.kind : 'none';
  if (kind === 'fake') return createFakeEngine(o.script && typeof o.script === 'object' ? o.script : {});
  const controlPort = Number.isInteger(o.controlPort) ? o.controlPort : DEFAULT_PORT;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const timers = o.timers || { setTimeout, clearTimeout };
  const udp = typeof o.udp === 'function' ? o.udp : defaultUdp;
  const spawn = typeof o.spawn === 'function' ? o.spawn : require('child_process').spawn;
  const onExit = typeof o.onExit === 'function' ? o.onExit : () => {};
  const script = typeof o.script === 'string' && o.script ? o.script : scriptFor(kind);
  const baseEnv = o.env || { PATH: process.env.PATH || '' };

  // The forest exports (WALL, PALETTE_HEX, parseArgs, ...): the mood renderer re-exports them.
  let mod = null;
  let modWhy = '';
  if (kind !== 'none') {
    try { mod = require(script); } catch (e) { modWhy = 'renderer script not found'; }
  }
  const F = kind === 'mood' && mod ? mod.forest || require('./forest-render.js') : (mod || require('./forest-render.js'));

  let st = emptyStatus();
  let child = null;
  let state = 'off'; // off | starting | running | stopping
  let stopping = null; // shared stop promise
  let controlOk = true;

  function can(plan) {
    if (kind === 'none') return { ok: false, why: 'engine off' };
    if (!mod) return { ok: false, why: modWhy };
    const why = kind === 'mood' ? (typeof mod.checkPlan === 'function' ? mod.checkPlan(plan) : 'renderer cannot check plans') : forestWhy(plan, F);
    if (why) return { ok: false, why };
    const a = argsWhy(buildArgs(kind, plan, {}, controlPort, F), F);
    return a ? { ok: false, why: a } : { ok: true, why: '' };
  }

  function argsFor(plan, tune) { return buildArgs(kind, plan, tune, controlPort, F); }

  function status() {
    const s = Object.assign({}, st);
    s.running = state === 'running';
    s.state = state;
    s.kind = kind;
    return s;
  }

  function start(plan, tune) {
    const c = can(plan);
    if (!c.ok) return Promise.resolve(c);
    const args = argsFor(plan, tune);
    const bad = argsWhy(args, F);
    if (bad) return Promise.resolve({ ok: false, why: bad });
    const host = typeof o.wledHost === 'string' ? o.wledHost.trim() : '';
    if (!host) return Promise.resolve({ ok: false, why: 'no WLED host' });
    if (!F.parseHost(host)) return Promise.resolve({ ok: false, why: 'WLED host not usable' });
    const before = state === 'off' ? Promise.resolve() : stop();
    return before.then(() => launch(plan, args, host));
  }

  function launch(plan, args, host) {
    return new Promise((resolve) => {
      let settled = false;
      let startTimer = null;
      const settle = (v) => { if (!settled) { settled = true; timers.clearTimeout(startTimer); resolve(v); } };
      st = emptyStatus();
      st.id = plan && typeof plan.id === 'string' ? plan.id : null;
      controlOk = true;
      state = 'starting';
      let c;
      try {
        c = spawn(process.execPath, [script].concat(args), {
          env: Object.assign({}, baseEnv, { WLED_HOST: host }),
          stdio: [kind === 'mood' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        state = 'off';
        log('moods: renderer could not be started');
        return settle({ ok: false, why: 'could not start the renderer' });
      }
      child = c;
      let lastErr = '';
      let exited = false;
      startTimer = timers.setTimeout(() => {
        if (settled || child !== c) return;
        log('moods: renderer did not start in time');
        settle({ ok: false, why: 'renderer did not start in time' });
        stop();
      }, START_TIMEOUT_MS);

      const onLine = (raw, isErr) => {
        if (child !== c) return;
        const line = String(raw).replace(/\r$/, '');
        if (!line.trim()) return;
        const text = line.replace(/^[a-z][a-z-]*: /, '').slice(0, LAST_LINE_MAX);
        st.lastLine = text;
        if (isErr) lastErr = lastErr || text;
        const m = STREAMING_RE.exec(line);
        if (m) {
          st.fps = Number(m[2]); st.cycle = Number(m[3]); st.gamma = Number(m[4]);
          st.scale = Number(m[5]); st.estMa = Number(m[6]);
          if (state === 'starting') {
            state = 'running';
            st.since = now();
            log('moods: renderer streaming');
            settle({ ok: true, why: '' });
          }
          return;
        }
        if (/control port busy/.test(line)) controlOk = false;
      };
      const reader = (stream, isErr) => {
        if (!stream || typeof stream.on !== 'function') return;
        let buf = '';
        if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
        stream.on('data', (d) => {
          buf += String(d);
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i), isErr); buf = buf.slice(i + 1); }
          if (buf.length > 4096) buf = '';
        });
        stream.on('end', () => { if (buf) { onLine(buf, isErr); buf = ''; } });
      };
      reader(c.stdout, false);
      reader(c.stderr, true);

      const finished = (code, signal) => {
        if (exited) return;
        exited = true;
        if (child !== c) return;
        const was = state;
        child = null;
        state = 'off';
        st.since = null;
        if (was === 'starting') {
          const why = (code === 2 && lastErr) ? lastErr : (st.lastLine || 'renderer stopped before it started');
          log('moods: renderer did not start');
          settle({ ok: false, why });
        } else if (was === 'running') {
          log(EXIT_LINE);
          try { onExit({ code: code == null ? null : code, signal: signal || null }); } catch (e) { /* caller's problem */ }
        }
        // 'stopping': the stop promise settles from its own listener; a start still waiting fails.
        settle({ ok: false, why: 'stopped before it started' });
      };
      c.on('exit', finished);
      c.on('error', () => {
        if (child !== c) return;
        if (state === 'starting') {
          child = null;
          state = 'off';
          log('moods: renderer could not be started');
          settle({ ok: false, why: 'could not start the renderer' });
        }
      });
      if (kind === 'mood' && c.stdin) {
        c.stdin.on('error', () => {});
        c.stdin.end(JSON.stringify(plan));
      }
    });
  }

  function event(name, n) {
    if (state !== 'running') return Promise.resolve({ ok: false, why: 'renderer not running' });
    if (!controlOk) return Promise.resolve({ ok: false, why: 'control port busy' });
    let text;
    if (name === 'thunder') {
      const k = thunderCount(n);
      if (k == null) return Promise.resolve({ ok: false, why: 'thunder count must be 1 to 6' });
      text = 'thunder ' + k;
    } else if (kind === 'mood' && typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name)) {
      const k = thunderCount(n);
      if (k == null) return Promise.resolve({ ok: false, why: 'count must be 1 to 6' });
      text = 'event ' + name + ' ' + k;
    } else {
      return Promise.resolve({ ok: false, why: 'unknown event' });
    }
    return udp(text, controlPort, '127.0.0.1').then(() => ({ ok: true }), () => ({ ok: false, why: 'cue not sent' }));
  }

  function stop() {
    if (stopping) return stopping;
    const c = child;
    if (!c) { state = 'off'; return Promise.resolve({ ok: true }); }
    // A stop during start: the start promise fails from the exit listener in launch().
    state = 'stopping';
    stopping = new Promise((resolve) => {
      const handles = [];
      let done = false;
      const alive = () => c.exitCode == null && c.signalCode == null && !gone;
      let gone = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        handles.forEach((h) => timers.clearTimeout(h));
        if (child === c) child = null;
        state = 'off';
        st.since = null;
        stopping = null;
        resolve(ok ? { ok: true } : { ok: false, why: 'renderer did not exit' });
      };
      c.on('exit', () => { gone = true; finish(true); });
      if (!alive()) return finish(true);
      udp('quit', controlPort, '127.0.0.1').catch(() => {});
      handles.push(timers.setTimeout(() => { if (alive()) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } }, QUIT_WAIT_MS));
      handles.push(timers.setTimeout(() => { if (alive()) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } } }, KILL_AT_MS));
      handles.push(timers.setTimeout(() => { if (!done) { log('moods: renderer did not exit'); finish(false); } }, GIVE_UP_MS));
    });
    return stopping;
  }

  return { kind, can, argsFor, start, event, stop, status };
}

// For tests and dry runs. script: { can, start, event, stop, status } where each
// is a reply object or a function returning one; status fills the streaming numbers.
function createFakeEngine(script) {
  const s = script || {};
  const F = require('./forest-render.js');
  const calls = [];
  const controlPort = Number.isInteger(s.controlPort) ? s.controlPort : DEFAULT_PORT;
  const pick = (v, args, dflt) => (typeof v === 'function' ? v.apply(null, args) : (v || dflt));
  let st = emptyStatus();
  const fake = {
    kind: 'fake',
    calls,
    can(plan) {
      if (s.can) return pick(s.can, [plan]);
      const why = forestWhy(plan, F) || argsWhy(buildArgs('forest', plan, {}, controlPort, F), F);
      return why ? { ok: false, why } : { ok: true, why: '' };
    },
    argsFor(plan, tune) { return buildArgs('forest', plan, tune, controlPort, F); },
    start(plan, tune) {
      calls.push({ fn: 'start', id: plan && plan.id, args: fake.argsFor(plan, tune) });
      const c = fake.can(plan);
      const r = c.ok ? pick(s.start, [plan, tune], { ok: true, why: '' }) : c;
      if (r.ok) {
        st = Object.assign(emptyStatus(), { fps: 30, cycle: 65.5, gamma: 2.8, scale: 1, estMa: 400 }, s.status || {});
        st.running = true;
        st.id = plan && plan.id;
        st.since = typeof s.now === 'function' ? s.now() : 0;
        st.lastLine = 'streaming';
      }
      return Promise.resolve(r);
    },
    event(name, n) {
      calls.push({ fn: 'event', name, n: n == null ? 1 : n });
      if (!st.running) return Promise.resolve({ ok: false, why: 'renderer not running' });
      return Promise.resolve(pick(s.event, [name, n], { ok: true }));
    },
    stop() {
      calls.push({ fn: 'stop' });
      st = emptyStatus();
      return Promise.resolve(pick(s.stop, [], { ok: true }));
    },
    status() { return Object.assign({}, st, { state: st.running ? 'running' : 'off', kind: 'fake' }); },
    // Pretend the renderer died: the same once-only line and onExit as the real one.
    crash() {
      if (!st.running) return;
      st = emptyStatus();
      if (typeof s.log === 'function') s.log(EXIT_LINE);
      if (typeof s.onExit === 'function') s.onExit({ code: 1, signal: null });
    },
  };
  return fake;
}

module.exports = {
  createEngine, createFakeEngine, hostFromUrl, forestWhy, buildArgs, argsWhy,
  KINDS, DEFAULT_PORT, START_TIMEOUT_MS, QUIT_WAIT_MS, KILL_AT_MS, GIVE_UP_MS, EXIT_LINE, FOREST_THUNDER, STREAMING_RE,
};
