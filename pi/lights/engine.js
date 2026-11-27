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
 *   a paired preset (looks.js)   painted once (or drifting slowly) while
 *   music lights are off; music lights On pause it, and when they stop the
 *   preset is painted again instead of putting back what was saved. A light
 *   then set another way ends the preset (the hub is told).
 *
 * Listening: pw-record on the default output's monitor (16 kHz mono, 20 ms
 * buffers so beats arrive on time rather than in 100 ms bursts). Only
 * while On. If it fails (the speaker dropped) it waits and tries again every
 * 30 s; it never touches the audio services.
 *
 * Settings (pi/.env, next to this folder): HUB_TOKEN, HUB_PORT (the hub);
 * GOVEE_LAMP_IP, GOVEE_BARS_IP (LAN Control on in Govee Home); HA_TOKEN,
 * HA_URL, LIGHTS_HA_LAMP, LIGHTS_HA_BARS (save, put back, notice changes;
 * see ha.js); LIGHTS_DELAY_MS 0-1000 (default 0: lights wait this long, to
 * line up with the Bluetooth speaker); LIGHTS_WATCH full|color|power|off.
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
const looksLib = require('./looks');
const cloudLib = require('./govee-cloud');

const ENV_FILE = path.join(__dirname, '..', '.env');
const HUB_EVERY_MS = 1000;
const WATCH_EVERY_MS = 3000;
const WATCH_SETTLE_MS = 5000;
const COLOR_REPEATS = 3;               // a new color must hold for 3 checks (~9 s)
const CAPTURE_RETRY_MS = 30000;
const START_BRIGHTNESS = 55;            // the demo's device brightness
const LOOK_SEND_MS = [250, 1000];       // a preset's colors go out twice (UDP can drop one)
const CAPTURE_CMD = ['pw-record', '-P', '{ stream.capture.sink=true }', '--rate', String(look.RATE), '--channels', '1', '--format', 's16', '--latency', '20ms', '-'];

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
const OFF_EVENTS = ['quiet', 'gave-way', 'no-lights'];

function createEngine(o) {
  const keys = Object.keys(govee.LIGHTS).filter((k) => o.addresses && o.addresses[k]);
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const ha = o.ha || { configured: false, has: () => false, snapshot: async () => null, restore: async () => false, fingerprint: () => '', watch: 'off' };
  let settings = settingsLib.defaults();
  const session = sessionLib.createSession();
  const pal = () => settingsLib.paletteById(settings.palette).colors;
  const lk = look.createLook({ palette: pal(), vibrancy: settings.vibrancy, beat: settings.beat });
  let saved = {};
  let baseline = {};
  let armColor = {};
  let armBright = {};
  let colorHold = {};
  const why = {};
  let sentColors = {};                   // per light: colors sent lately (the color check)
  let watchFrom = 0;
  let restoreKeys = keys.slice();
  let lastSent = {};
  let events = [];
  let gen = 0;                           // goes up whenever sending must stop (delayed frames check it)
  let snapping = Promise.resolve();      // the start's snapshots
  let restoring = Promise.resolve();     // the last put-back
  let capturing = false;
  let captureState = 'off';
  let pcm = Buffer.alloc(0);
  let soundInFrame = false;
  let lastBlockAt = 0;
  let lastFrame = { state: 'off', gain: 0, rest: 1 };
  let watching = false;
  let skip = null;
  let lookDef = null;                    // the preset the hub says is on (checked by the hub)
  let looking = null;                    // a preset being shown: { def, at, start, step, last, base, bright }
  let paintedAt = -1;                    // settings.lookAt of the preset last painted
  let restoringNow = false;              // a put-back (or a preset after music) is on its way
  const cloud = o.cloud || { configured: false, fire: async () => false, snapshotNames: async () => ({}) };
  let snapshotNames = {};                // per light: the Govee app snapshots it has (names)

  // An off the engine decided itself (quiet, gave way) that the hub has not
  // confirmed yet: until it has, an "on" in the settings is stale.
  const offPending = () => events.some((e) => OFF_EVENTS.indexOf(e.type) >= 0);
  const raise = (e) => events.push(Object.assign({ rev: settings.rev }, e));

  function report() {
    const f = lk.features();
    return {
      state: session.isOn() ? lastFrame.state : 'off',
      sound: !!f.sound,
      bpm: f.bpm || 0,
      beat: f.confidence || 0,
      vibe: Math.round(f.vibe * 100) / 100,
      quietFor: Math.round(session.quietFor(now()) / 1000),
      capture: captureState,
      lights: keys.slice(),
      ha: ha.configured,
      look: looking ? looking.def.id : '',
      snapshots: snapshotNames,
      events: events.slice()
    };
  }

  // The hub's answer to a report: settings and the song's tempo.
  // sentEvents: how many events that report carried (the hub has them now).
  function applyHub(reply, sentEvents) {
    if (!reply || !reply.settings) return;
    events = events.slice(sentEvents || 0);
    const s = settingsLib.clean(reply.settings);
    lookDef = s.look && reply.look && reply.look.id === s.look ? reply.look : null;
    const prev = settings;
    settings = s;
    lk.setSongBpm(reply.song && reply.song.bpm);
    if (s.palette !== prev.palette) lk.setPalette(pal());
    lk.setDials(s.vibrancy, s.beat);
    session.setQuietMin(s.quietMin);
    if (!s.look && looking) stopLook();
    if (s.on) {
      if (offPending()) return;
      if (!session.isOn()) start();
      else if (session.state() === 'stopping') { session.on(now()); restoreKeys = keys.slice(); }
      return;
    }
    if (!session.isOn()) {
      if (lookDef && s.lookAt !== paintedAt && !restoringNow) paintLook();
      return;
    }
    if (s.offReason === 'look' && lookDef) {
      // A preset picked while music played: stop at once and paint it.
      log('music lights: off (a preset was picked)');
      session.drop();
      gen++;
      finish([], true);
      return;
    }
    if (session.state() === 'stopping' && s.offReason !== 'gave-way') return;
    if (s.offReason === 'gave-way') {
      const hub = s.gaveWay.indexOf('hub') >= 0;
      restoreKeys = hub ? [] : keys.filter((k) => s.gaveWay.indexOf(k) < 0);
      log('music lights: off (the lights were set another way)');
      // At once, no fade: a fade would paint over what was just set.
      session.drop();
      gen++;
      finish(restoreKeys);
      return;
    }
    restoreKeys = keys.slice();
    log('music lights: off');
    session.off(now(), true);
  }

  function start() {
    if (!keys.length) { log('music lights: no light addresses set (GOVEE_LAMP_IP, GOVEE_BARS_IP)'); raise({ type: 'no-lights' }); return; }
    stopLook();
    session.on(now());
    gen++;
    const myGen = gen;
    saved = {};
    baseline = {};
    armColor = {};
    armBright = {};
    colorHold = {};
    sentColors = {};
    keys.forEach((k) => remember(k, [[47, 181, 163]]));
    lastSent = {};
    restoreKeys = keys.slice();
    watchFrom = Infinity;
    log('music lights: on');
    // Let a put-back still on its way finish first, so it is not saved as "how the lights were".
    snapping = restoring.then(() => Promise.all(keys.map((k) => ha.snapshot(k).then((st) => {
      if (st && st.available) saved[k] = st;
    })))).then(() => {
      if (gen !== myGen || !session.isOn()) return;
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

  // One 10 ms block (tests call this straight).
  function block(samples) {
    lastBlockAt = now();
    const due = lk.block(samples);
    if (lk.features().sound) soundInFrame = true;
    if (due) frame();
  }

  // No sound arriving (capture down or starting): keep time moving.
  function idle() {
    if (!session.isOn()) { lookTick(); return; }
    if (now() - lastBlockAt < 300) return;
    const silent = new Int16Array(look.BLOCK);
    for (let i = 0; i < 0.1 / look.BLOCK_S; i++) block(silent);
  }

  function frame() {
    if (!session.isOn()) return;
    const r = session.tick(now(), soundInFrame);
    soundInFrame = false;
    lastFrame = r;
    if (r.events.indexOf('quiet') >= 0) {
      const m = settings.quietMin;
      log('music lights: off after ' + m + ' quiet minute' + (m === 1 ? '' : 's'));
      raise({ type: 'quiet' });
      restoreKeys = keys.slice();
    }
    if (r.events.indexOf('end') >= 0) { gen++; finish(r.restore ? restoreKeys : [], true); return; }
    const cols = lk.render(r.gain, r.rest);
    const myGen = gen;
    keys.forEach((k) => {
      const c = cols[k];
      const sig = JSON.stringify(c);
      if (lastSent[k] === sig) return;
      lastSent[k] = sig;
      remember(k, c);
      const msgs = govee.sectionMessages(c);
      const go = () => { if (gen === myGen) msgs.forEach((m) => o.send(k, m)); };
      if (o.delayMs > 0) setTimeout(go, o.delayMs); else go();
    });
  }

  // Keep the last 400 distinct colors sent to a light.
  function remember(k, cols) {
    const list = sentColors[k] || (sentColors[k] = []);
    cols.forEach((c) => {
      if (Math.max(c[0], c[1], c[2]) < 30) return;
      const key = c.join(',');
      if (list.some((x) => x.join(',') === key)) return;
      list.push(c.slice());
      if (list.length > 400) list.shift();
    });
  }

  // Stop sending and put these lights back (after the start's snapshots, if
  // they are still coming). withLook: when a preset is on, paint it instead.
  function finish(putBack, withLook) {
    stopCapture();
    restoringNow = true;
    restoring = snapping.then(() => {
      if (withLook && lookDef && settings.look === lookDef.id) {
        paintLook();
        log('music lights: preset painted again');
        return 0;
      }
      const list = putBack.filter((k) => saved[k]);
      const missing = putBack.filter((k) => !saved[k]);
      // Without a saved state (no Home Assistant) the light is switched off,
      // as the demo did, rather than left on the last music color.
      missing.forEach((k) => o.send(k, govee.turn(false)));
      if (!putBack.length) return 0;
      return Promise.all(list.map((k) => ha.restore(k, saved[k]))).then((r) => {
        const n = r.filter(Boolean).length;
        log('music lights: lights put back (' + n + ' of ' + list.length + ')' + (missing.length ? ', ' + missing.length + ' switched off' : ''));
        return n;
      });
    }).catch(() => 0).then((n) => { restoringNow = false; return n; });
    return restoring;
  }

  /* ---------- paired presets ---------- */

  // Paint the preset the hub says is on: power, brightness, then the section
  // colors (twice, a moment apart). A drifting one keeps updating in lookTick.
  function paintLook() {
    if (!lookDef || !keys.length) return;
    gen++;
    paintedAt = settings.lookAt;
    const first = looksLib.resolve(lookDef, 0);
    keys.forEach((k) => {
      o.send(k, govee.turn(true));
      if (first[k].snapshot) {
        // The Govee app's own scene, through the cloud (rate-limited there).
        const b = first[k].brightness;
        cloud.fire(k, first[k].snapshot).then((ok) => {
          if (ok && b && looking && looking.at === paintedAt) o.send(k, govee.brightness(b));
        });
        return;
      }
      o.send(k, govee.colorwc(first[k].colors[0]));   // leaves any scene or music mode
      o.send(k, govee.brightness(first[k].brightness));
    });
    looking = { def: lookDef, at: settings.lookAt, start: now(), step: 0, last: {}, base: {}, bright: {}, watchFrom: now() + WATCH_SETTLE_MS };
  }

  function stopLook() {
    looking = null;
  }

  function sendLookColors(force) {
    const r = looksLib.resolve(looking.def, now() - looking.start);
    keys.forEach((k) => {
      if (!r[k].colors) return;                      // a snapshot light
      const sig = JSON.stringify(r[k].colors);
      if (!force && looking.last[k] === sig) return;
      looking.last[k] = sig;
      govee.sectionMessages(r[k].colors).forEach((m) => o.send(k, m));
    });
  }

  // Every 100 ms while music lights are off (the main loop's idle timer).
  function lookTick() {
    if (!looking) return;
    const t = now() - looking.start;
    if (looking.step < LOOK_SEND_MS.length) {
      if (t >= LOOK_SEND_MS[looking.step]) { looking.step++; sendLookColors(true); }
      return;
    }
    const every = looksLib.UPDATE_MS[looking.def.motion] || 0;
    if (every && t - (looking.lastDrift || 0) >= every) {
      looking.lastDrift = t;
      sendLookColors(false);
    }
  }

  // While a preset shows: was a light set another way (power, effect, white,
  // brightness more than ~10%)? Then the preset has ended; tell the hub.
  async function watchLook() {
    if (!looking || watching || ha.watch === 'off' || now() < looking.watchFrom) return [];
    watching = true;
    const mine = looking;
    const changed = [];
    try {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!ha.has(k)) continue;
        const st = await ha.snapshot(k);
        if (!st || !st.available) continue;
        if (mine.base[k] === undefined) { mine.base[k] = ha.fingerprint(st); mine.bright[k] = st.brightness; continue; }
        if (mine.base[k] !== ha.fingerprint(st) || haLib.brightnessMoved(mine.bright[k], st.brightness)) changed.push(k);
      }
    } finally {
      watching = false;
    }
    if (changed.length && looking === mine && !session.isOn()) {
      log('music lights: preset ended (' + changed.map((k) => govee.LIGHTS[k].name.toLowerCase()).join(', ') + ' set another way)');
      raise({ type: 'look-changed', lookAt: mine.at, lights: changed });
      stopLook();
    }
    return changed;
  }

  // Every few seconds while On: was a light set another way? Armed only once
  // Home Assistant shows the engine's own start (on, brightness 55%), so a
  // late poll of the old state is never taken for a change.
  async function watch() {
    if (!session.isOn() && looking) return watchLook();
    if (watching || ha.watch === 'off' || !session.isOn() || session.state() === 'stopping' || now() < watchFrom) return [];
    watching = true;
    const myGen = gen;
    const changed = [];
    try {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!ha.has(k)) continue;
        const st = await ha.snapshot(k);
        if (!st || !st.available) continue;              // a light dropping off for a moment is not a change
        if (baseline[k] === undefined) {
          if (looksStarted(st)) { baseline[k] = ha.fingerprint(st); armBright[k] = st.brightness; armColor[k] = st.rgb ? [st.rgb] : []; }
          continue;
        }
        if (baseline[k] !== ha.fingerprint(st)) { changed.push(k); why[k] = 'power or effect'; continue; }
        if (haLib.brightnessMoved(armBright[k], st.brightness)) { changed.push(k); why[k] = 'brightness'; continue; }
        // A color alone counts only when it is none the engine sent, not the
        // one Home Assistant showed at the start (a stale read-back), and it
        // reads the same on COLOR_REPEATS checks in a row: while the engine
        // draws, the read-back keeps moving.
        const odd = ha.watch === 'color' && st.colorMode !== 'color_temp' && Array.isArray(st.rgb) &&
          !haLib.colorIsOurs(st.rgb, sentColors[k]) && !haLib.colorIsOurs(st.rgb, armColor[k]);
        const sig = odd ? st.rgb.map((v) => Math.round(v)).join(',') : '';
        if (!odd) { colorHold[k] = null; continue; }
        if (colorHold[k] && colorHold[k].sig === sig) colorHold[k].n++;
        else colorHold[k] = { sig: sig, n: 1 };
        if (colorHold[k].n >= COLOR_REPEATS) { changed.push(k); why[k] = 'color'; }
      }
    } finally {
      watching = false;
    }
    if (changed.length && gen === myGen && session.isOn() && session.state() !== 'stopping') giveWay(changed);
    return changed;
  }

  function looksStarted(st) {
    return st.on && (st.brightness === null || Math.abs(st.brightness - Math.round(START_BRIGHTNESS * 2.55)) <= 8);
  }

  function giveWay(changed) {
    session.drop();
    gen++;
    log('music lights: gave way (' + changed.map((k) => govee.LIGHTS[k].name.toLowerCase() + ': ' + (why[k] || 'changed')).join(', ') + ')');
    raise({ type: 'gave-way', lights: changed });
    return finish(keys.filter((k) => changed.indexOf(k) < 0), false);
  }

  // Stop now (shutting down): put everything back, no fade.
  function shutdown() {
    gen++;
    if (!session.isOn()) { stopCapture(); return restoring; }
    session.drop();
    return finish(restoreKeys);
  }

  return {
    keys: keys,
    report: report,
    applyHub: applyHub,
    pendingEvents: () => events.length,
    lookTick: lookTick,
    setSnapshotNames: (n) => { snapshotNames = n && typeof n === 'object' ? n : {}; },
    looking: () => (looking ? { id: looking.def.id, at: looking.at, motion: looking.def.motion } : null),
    block: block,
    data: data,
    idle: idle,
    watch: watch,
    shutdown: shutdown,
    session: session,
    settings: () => settings,
    settled: () => Promise.all([snapping, restoring]),
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
  lines.push('Govee snapshots: ' + (String(env.GOVEE_API_KEY || '').trim() ? 'GOVEE_API_KEY set' : 'no GOVEE_API_KEY (presets that fire Govee app snapshots will not work)'));
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
  const cloud = cloudLib.createCloud({ key: env.GOVEE_API_KEY, log: log });
  const engine = createEngine({
    addresses: addresses,
    send: (k, buf) => sock.send(buf, govee.PORT, addresses[k]),
    ha: ha, log: log, capture: capture, delayMs: delayFromEnv(env), cloud: cloud
  });
  // The Govee app snapshots each light has (names only), for ./hub lights snapshots.
  const readSnapshots = () => { if (cloud.configured) cloud.snapshotNames(false).then((n) => engine.setSnapshotNames(n)).catch(() => {}); };
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
    setInterval(readSnapshots, cloudLib.LIST_EVERY_MS),
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
  readSnapshots();
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
