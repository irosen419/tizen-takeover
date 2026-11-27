#!/usr/bin/env node
/*
 * The music light engine: the Govee lamp and light bars follow the sound the
 * Pi plays (phone over Bluetooth, Spotify, anything going to the speaker).
 *
 * Runs on the Pi itself, not in Docker (it needs the Pi's audio), as the
 * systemd user unit music-lights (pi/lights/music-lights.service). It knows
 * nothing about songs or screens: the hub server keeps the settings
 * (./hub lights, the mailbox's lights.* commands) and the engine asks for
 * them once a second over 127.0.0.1, reporting what it is doing in the same
 * call. When the hub is down it keeps its last settings.
 *
 *   On      saves how each light is (Home Assistant), fades in, follows the music
 *   quiet   between songs: holds the palette and dims to a calm glow
 *   quiet 15 min (setting; can be never)   turns itself Off, puts the lights back
 *   Off     fades out, puts the lights back
 *   a light set another way (Govee app, voice, a scene, the hub's own
 *   Ambience)   gives way at once: Off, that light is left as it was set,
 *   the others are put back
 *
 * Listening: pw-record on the default output's monitor (16 kHz mono). Only
 * while On. If it fails (the speaker dropped) it waits and tries again every
 * 30 s; it never touches the audio services.
 *
 * Settings (pi/.env, next to this folder): HUB_TOKEN, HUB_PORT (the hub);
 * GOVEE_LAMP_IP, GOVEE_BARS_IP (LAN Control on in Govee Home); HA_TOKEN,
 * HA_URL, LIGHTS_HA_LAMP, LIGHTS_HA_BARS (save, put back, notice changes;
 * see ha.js); LIGHTS_DELAY_MS 0-1000 (default 0: lights wait this long, to
 * line up with the Bluetooth speaker); LIGHTS_WATCH full|power|off.
 *
 *   node pi/lights/engine.js            run (what the unit does)
 *   node pi/lights/engine.js --check    say what is set up, then exit
 *
 * Logs a few plain lines: states and counts only, never a song, an address
 * or an entity id. Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const childProcess = require('child_process');
const govee = require('./govee');
const look = require('./look');
const sessionLib = require('./session');
const settingsLib = require('./settings');
const haLib = require('./ha');

const ENV_FILE = path.join(__dirname, '..', '.env');
const HUB_EVERY_MS = 1000;
const WATCH_EVERY_MS = 3000;
const WATCH_SETTLE_MS = 5000;
const CAPTURE_RETRY_MS = 30000;
const START_BRIGHTNESS = 55;            // the demo's device brightness
const CAPTURE_CMD = ['pw-record', '-P', '{ stream.capture.sink=true }', '--rate', String(look.RATE), '--channels', '1', '--format', 's16', '-'];

function parseEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t[0] === '#') return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) return;
    let v = m[2];
    if ((v[0] === '"' || v[0] === "'") && v.length >= 2 && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  });
  return out;
}

function readEnv(file) {
  let env = {};
  try { env = parseEnv(fs.readFileSync(file || ENV_FILE, 'utf8')); } catch (e) { /* no .env */ }
  return Object.assign(env, pickEnv(process.env));
}

function pickEnv(e) {
  const out = {};
  ['HUB_TOKEN', 'HUB_PORT', 'GOVEE_LAMP_IP', 'GOVEE_BARS_IP', 'HA_TOKEN', 'HA_URL', 'LIGHTS_HA_LAMP', 'LIGHTS_HA_BARS',
    'SOUNDLIGHTS_HA_LAMP', 'LIGHTS_DELAY_MS', 'LIGHTS_WATCH'].forEach((k) => { if (e[k]) out[k] = e[k]; });
  return out;
}

function delayFromEnv(env) {
  const n = parseInt(env.LIGHTS_DELAY_MS, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : 0;
}

// Strips a WAV header if the capture starts with one.
function createWavSkip() {
  let buf = Buffer.alloc(0);
  let done = false;
  return function push(data) {
    if (done) return data;
    buf = Buffer.concat([buf, data]);
    if (buf.length < 4) return Buffer.alloc(0);
    if (buf.toString('latin1', 0, 4) !== 'RIFF') { done = true; const o = buf; buf = null; return o; }
    let i = 12;
    while (i + 8 <= buf.length) {
      const id = buf.toString('latin1', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'data') { done = true; const o = buf.slice(i + 8); buf = null; return o; }
      i += 8 + size + (size & 1);
    }
    if (buf.length > 65536) { done = true; const o = buf.slice(44); buf = null; return o; }
    return Buffer.alloc(0);
  };
}

/*
 * The engine itself, with everything outside passed in so tests can drive it:
 *   o.addresses  { lamp: '...', bars: '...' } (only the lights to drive)
 *   o.send(key, buffer)          one UDP message to that light
 *   o.ha                         from ha.createHa (or a stand-in)
 *   o.now()                      milliseconds
 *   o.log(line)
 *   o.capture  { start(onData), stop() }  raw s16 PCM chunks
 *   o.delayMs                    0-1000
 */
function createEngine(o) {
  const keys = Object.keys(govee.LIGHTS).filter((k) => o.addresses && o.addresses[k]);
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const ha = o.ha || { configured: false, has: () => false, snapshot: async () => null, restore: async () => false, fingerprint: () => '', watch: 'off' };
  let settings = settingsLib.defaults();
  let suppressRev = -1;                  // ignore "on" until the hub has seen our own off
  const session = sessionLib.createSession();
  const pal = () => settingsLib.paletteById(settings.palette).colors;
  const lk = look.createLook({ palette: pal(), vibrancy: settings.vibrancy, beat: settings.beat });
  let saved = {};
  let baseline = {};
  let watchFrom = 0;
  let restoreKeys = keys.slice();
  let lastSent = {};
  let events = [];
  let capturing = false;
  let captureState = 'off';
  let pcm = Buffer.alloc(0);
  let soundInFrame = false;
  let lastBlockAt = 0;
  let lastFrame = { state: 'off', gain: 0, rest: 1 };
  let watching = false;
  let skip = null;

  function report() {
    const f = lk.features();
    return {
      state: session.isOn() ? lastFrame.state : 'off',
      sound: !!f.sound,
      bpm: f.bpm || 0,
      vibe: Math.round(f.vibe * 100) / 100,
      quietFor: Math.round(session.quietFor(now()) / 1000),
      capture: captureState,
      lights: keys.slice(),
      ha: ha.configured,
      events: events.slice()
    };
  }

  // The hub's answer to a report: settings and the song's tempo.
  function applyHub(reply, sentEvents) {
    if (!reply || !reply.settings) return;
    events = events.slice(sentEvents || 0);
    const s = settingsLib.clean(reply.settings);
    const prev = settings;
    settings = s;
    lk.setSongBpm(reply.song && reply.song.bpm);
    if (s.palette !== prev.palette) lk.setPalette(pal());
    lk.setDials(s.vibrancy, s.beat);
    session.setQuietMin(s.quietMin);
    if (s.on && s.rev > suppressRev && !session.isOn()) start();
    else if (s.on && s.rev > suppressRev && session.state() === 'stopping') session.on(now());
    else if (!s.on && session.isOn() && session.state() !== 'stopping') {
      if (s.offReason === 'gave-way') {
        restoreKeys = s.gaveWay.indexOf('hub') >= 0 ? [] : keys.filter((k) => s.gaveWay.indexOf(k) < 0);
        log('music lights: off (the lights were set another way)');
      } else {
        restoreKeys = keys.slice();
        log('music lights: off');
      }
      session.off(now(), restoreKeys.length > 0);
    }
  }

  function start() {
    if (!keys.length) { log('music lights: no light addresses set (GOVEE_LAMP_IP, GOVEE_BARS_IP)'); suppressRev = settings.rev; events.push({ type: 'no-lights' }); return; }
    session.on(now());
    saved = {};
    baseline = {};
    lastSent = {};
    restoreKeys = keys.slice();
    watchFrom = now() + WATCH_SETTLE_MS;
    log('music lights: on');
    Promise.all(keys.map((k) => ha.snapshot(k).then((s) => { if (s) saved[k] = s; }))).then(() => {
      if (!session.isOn()) return;
      keys.forEach((k) => {
        o.send(k, govee.turn(true));
        o.send(k, govee.colorwc([47, 181, 163]));      // leaves any music mode, as the demo does
        o.send(k, govee.brightness(START_BRIGHTNESS));
      });
      watchFrom = now() + WATCH_SETTLE_MS;
    });
    startCapture();
  }

  function startCapture() {
    if (capturing || !o.capture) return;
    capturing = true;
    captureState = 'starting';
    skip = createWavSkip();
    o.capture.start((chunk) => {
      if (chunk === null) {
        if (captureState !== 'down') log('music lights: listening stopped; trying again every 30 s');
        captureState = 'down';
        return;
      }
      if (captureState === 'down') log('music lights: listening again');
      captureState = 'ok';
      data(chunk);
    });
  }

  function stopCapture() {
    if (!capturing) return;
    capturing = false;
    captureState = 'off';
    pcm = Buffer.alloc(0);
    if (o.capture) o.capture.stop();
  }

  function data(chunk) {
    const d = skip ? skip(chunk) : chunk;
    if (!d.length) return;
    pcm = pcm.length ? Buffer.concat([pcm, d]) : d;
    const bytes = look.BLOCK * 2;
    while (pcm.length >= bytes) {
      const b = new Int16Array(look.BLOCK);
      for (let i = 0; i < look.BLOCK; i++) b[i] = pcm.readInt16LE(i * 2);
      pcm = pcm.slice(bytes);
      block(b);
    }
  }

  // One 50 ms block (tests call this straight).
  function block(samples) {
    lastBlockAt = now();
    const due = lk.block(samples);
    if (lk.features().sound) soundInFrame = true;
    if (due) frame();
  }

  // No sound arriving (capture down or starting): keep time moving.
  function idle() {
    if (!session.isOn()) return;
    if (now() - lastBlockAt < 300) return;
    block(new Int16Array(look.BLOCK));
    block(new Int16Array(look.BLOCK));
  }

  function frame() {
    if (!session.isOn()) return;
    const r = session.tick(now(), soundInFrame);
    soundInFrame = false;
    lastFrame = r;
    if (r.events.indexOf('quiet') >= 0) {
      const m = settings.quietMin;
      log('music lights: off after ' + m + ' quiet minute' + (m === 1 ? '' : 's'));
      events.push({ type: 'quiet' });
      suppressRev = settings.rev;
      restoreKeys = keys.slice();
    }
    if (r.events.indexOf('end') >= 0) { finish(r.restore ? restoreKeys : []); return; }
    const cols = lk.render(r.gain, r.rest);
    keys.forEach((k) => {
      const c = cols[k];
      const sig = JSON.stringify(c);
      if (lastSent[k] === sig) return;
      lastSent[k] = sig;
      const msgs = govee.sectionMessages(c);
      const go = () => msgs.forEach((m) => o.send(k, m));
      if (o.delayMs > 0) setTimeout(go, o.delayMs); else go();
    });
  }

  function finish(putBack) {
    stopCapture();
    const list = putBack.filter((k) => saved[k]);
    const missing = putBack.filter((k) => !saved[k]);
    // Without a saved state (no Home Assistant) the light is switched off,
    // as the demo did, rather than left on the last music color.
    missing.forEach((k) => o.send(k, govee.turn(false)));
    if (!putBack.length) return Promise.resolve(0);
    return Promise.all(list.map((k) => ha.restore(k, saved[k]))).then((r) => {
      const n = r.filter(Boolean).length;
      log('music lights: lights put back (' + n + ' of ' + list.length + ')' + (missing.length ? ', ' + missing.length + ' switched off' : ''));
      return n;
    });
  }

  // Every few seconds while On: was a light set another way?
  async function watch() {
    if (watching || ha.watch === 'off' || !session.isOn() || session.state() === 'stopping' || now() < watchFrom) return [];
    watching = true;
    const changed = [];
    try {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!ha.has(k)) continue;
        const s = await ha.snapshot(k);
        if (!s) continue;
        const fp = ha.fingerprint(s);
        if (baseline[k] === undefined) baseline[k] = fp;
        else if (baseline[k] !== fp) changed.push(k);
      }
    } finally {
      watching = false;
    }
    if (changed.length && session.isOn() && session.state() !== 'stopping') giveWay(changed);
    return changed;
  }

  function giveWay(changed) {
    session.drop();
    log('music lights: gave way (' + changed.map((k) => govee.LIGHTS[k].name.toLowerCase()).join(', ') + ' set another way)');
    events.push({ type: 'gave-way', lights: changed });
    suppressRev = settings.rev;
    return finish(keys.filter((k) => changed.indexOf(k) < 0));
  }

  // Stop now (shutting down): put everything back, no fade.
  function shutdown() {
    if (!session.isOn()) { stopCapture(); return Promise.resolve(0); }
    session.drop();
    return finish(restoreKeys);
  }

  return {
    keys: keys,
    report: report,
    applyHub: applyHub,
    pendingEvents: () => events.length,
    block: block,
    data: data,
    idle: idle,
    watch: watch,
    shutdown: shutdown,
    session: session,
    settings: () => settings,
    captureFailed: () => { capturing = false; captureState = 'down'; },
    wantsCapture: () => session.isOn() && !capturing,
    restartCapture: () => { if (session.isOn()) startCapture(); }
  };
}

/* ---------- the real world: hub, UDP, pw-record ---------- */

function hubExchange(env, body) {
  const port = parseInt(env.HUB_PORT, 10) || 8097;
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: port, method: 'POST', path: '/api/lights/engine', timeout: 3000,
      headers: { Authorization: 'Bearer ' + env.HUB_TOKEN, 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('hub answered ' + res.statusCode)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('hub answer unreadable')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('hub did not answer')));
    req.on('error', reject);
    req.end(data);
  });
}

function pwCapture(log) {
  let proc = null;
  return {
    start(onData) {
      try {
        proc = childProcess.spawn(CAPTURE_CMD[0], CAPTURE_CMD.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        log('music lights: cannot start listening (' + (e && e.code) + ')');
        onData(null);
        return;
      }
      const p = proc;
      p.on('error', (e) => { log('music lights: cannot start listening (' + (e && e.code) + ')'); onData(null); });
      p.stdout.on('data', (c) => onData(c));
      p.on('exit', () => { if (proc === p) { proc = null; onData(null); } });
    },
    stop() {
      const p = proc;
      proc = null;
      if (p) { try { p.kill('SIGTERM'); } catch (e) { /* already gone */ } }
    }
  };
}

function check(env) {
  const addr = govee.addressesFromEnv(env);
  const haCfg = haLib.configFromEnv(env, govee.LIGHTS);
  const lines = [];
  Object.keys(govee.LIGHTS).forEach((k) => {
    const L = govee.LIGHTS[k];
    lines.push(L.name + ': ' + (addr[k] ? 'address set' : 'no address (' + L.env + ')') +
      (haCfg.configured && haCfg.entities[k] ? ', Home Assistant entity set' : ', no Home Assistant entity (' + L.haEnv[0] + ')'));
  });
  lines.push('Home Assistant: ' + (haCfg.configured ? 'token set' : 'no HA_TOKEN: lights are switched off at the end instead of put back'));
  lines.push('Hub token: ' + (env.HUB_TOKEN ? 'set' : 'missing (run ./hub token)'));
  lines.push('Delay: ' + delayFromEnv(env) + ' ms; noticing changes: ' + haCfg.watch);
  return lines;
}

function main(argv) {
  const env = readEnv();
  const log = (s) => process.stdout.write(s + '\n');
  if (argv.indexOf('--check') >= 0) { check(env).forEach(log); return; }
  if (!env.HUB_TOKEN) { log('music lights: no HUB_TOKEN in pi/.env; waiting is pointless, stopping'); process.exitCode = 1; return; }
  const addresses = govee.addressesFromEnv(env);
  const sock = dgram.createSocket('udp4');
  sock.on('error', () => { /* a send to an absent light; nothing to do */ });
  const ha = haLib.createHa(haLib.configFromEnv(env, govee.LIGHTS));
  const capture = pwCapture(log);
  const engine = createEngine({
    addresses: addresses,
    send: (k, buf) => sock.send(buf, govee.PORT, addresses[k]),
    ha: ha, log: log, capture: capture, delayMs: delayFromEnv(env)
  });
  log('music lights: engine started (' + (engine.keys.length ? engine.keys.join(', ') : 'no lights set') + '; Home Assistant ' + (ha.configured ? 'on' : 'off') + ')');

  let hubOk = null;
  let busy = false;
  const toHub = () => {
    if (busy) return;
    busy = true;
    const body = engine.report();
    const n = body.events.length;
    hubExchange(env, body).then((r) => {
      if (hubOk === false) log('music lights: hub reachable again');
      hubOk = true;
      engine.applyHub(r, n);
    }).catch(() => {
      if (hubOk !== false) log('music lights: cannot reach the hub; keeping the last settings');
      hubOk = false;
    }).then(() => { busy = false; });
  };
  let lastRetry = 0;
  const timers = [
    setInterval(toHub, HUB_EVERY_MS),
    setInterval(() => engine.idle(), 100),
    setInterval(() => { engine.watch().catch(() => {}); }, WATCH_EVERY_MS),
    setInterval(() => {
      if (engine.report().capture === 'down' && Date.now() - lastRetry > CAPTURE_RETRY_MS) {
        lastRetry = Date.now();
        capture.stop();
        engine.captureFailed();
        engine.restartCapture();
      }
    }, 1000)
  ];
  toHub();
  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    const t = setTimeout(() => process.exit(code), 5000);
    engine.shutdown().catch(() => {}).then(() => { clearTimeout(t); sock.close(); log('music lights: engine stopped'); process.exit(code); });
  };
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  process.on('uncaughtException', (e) => { log('music lights: crashed (' + (e && e.message) + '); putting the lights back'); stop(1); });
}

module.exports = {
  CAPTURE_CMD: CAPTURE_CMD,
  WATCH_SETTLE_MS: WATCH_SETTLE_MS,
  parseEnv: parseEnv,
  delayFromEnv: delayFromEnv,
  createWavSkip: createWavSkip,
  createEngine: createEngine,
  check: check
};

if (require.main === module) main(process.argv.slice(2));
