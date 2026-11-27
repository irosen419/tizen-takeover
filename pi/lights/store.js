/*
 * Music lights on the hub server: keeps the settings (data/lights.json),
 * hears the engine's report once a second, and answers ./hub lights, the
 * mailbox and (later) the phone and TV.
 *
 *   GET  /api/lights          settings, palettes, and what the engine is doing
 *   POST /api/lights          a change: { on, palette, vibrancy, beat, preset, quietMin }
 *   POST /api/lights/engine   the engine's report; answers settings and the song's tempo
 *
 * Any other way of setting the lights wins: the hub's own Ambience scene,
 * light or mood calls giveWay('hub'), which turns music lights off without
 * putting old state back over the new one. The engine notices changes made
 * outside the hub (Govee app, voice, Home Assistant) itself and reports them.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const settingsLib = require('./settings');

const FILE = 'lights.json';
const ENGINE_STALE_MS = 10000;

function createStore(opt) {
  const o = opt || {};
  const file = path.join(o.dataDir, FILE);
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const songBpm = o.songBpm || (() => 0);
  let s = settingsLib.defaults();
  try { s = settingsLib.clean(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* first run */ }
  let engine = null;
  let engineAt = 0;

  function save() {
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2) + '\n');
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      log('music lights: could not save the settings (' + (e && e.code) + ')');
    }
  }

  function setAll(fields) {
    s = settingsLib.clean(Object.assign({}, s, fields, { rev: s.rev + 1 }));
    save();
    return s;
  }

  // A person's change. Throws a 400 with a plain reason.
  function change(body) {
    const c = settingsLib.checkChange(body);
    const extra = {};
    if (c.on === true) { extra.offReason = ''; extra.gaveWay = []; }
    if (c.on === false && s.on) { extra.offReason = 'you'; extra.gaveWay = []; }
    const was = s.on;
    setAll(Object.assign(c, extra));
    if (was !== s.on) log('music lights: switched ' + (s.on ? 'on' : 'off'));
    else log('music lights: settings changed');
    return status();
  }

  // The lights were set another way through the hub (Ambience).
  function giveWay(who) {
    if (!s.on) return false;
    setAll({ on: false, offReason: 'gave-way', gaveWay: [who || 'hub'] });
    log('music lights: off, the lights were set another way');
    return true;
  }

  // The engine's once-a-second report.
  function engineReport(body) {
    const b = body && typeof body === 'object' ? body : {};
    engine = {
      state: typeof b.state === 'string' ? b.state.slice(0, 20) : 'off',
      sound: b.sound === true,
      bpm: Number.isFinite(b.bpm) ? Math.round(b.bpm) : 0,
      vibe: Number.isFinite(b.vibe) ? b.vibe : 0,
      quietFor: Number.isFinite(b.quietFor) ? b.quietFor : 0,
      capture: typeof b.capture === 'string' ? b.capture.slice(0, 12) : '',
      lights: Array.isArray(b.lights) ? b.lights.filter((k) => k === 'lamp' || k === 'bars') : [],
      ha: b.ha === true
    };
    engineAt = now();
    (Array.isArray(b.events) ? b.events : []).slice(0, 10).forEach((e) => {
      if (!e || typeof e !== 'object') return;
      if (e.type === 'quiet' && s.on) setAll({ on: false, offReason: 'quiet', gaveWay: [] });
      if (e.type === 'no-lights' && s.on) setAll({ on: false, offReason: '', gaveWay: [] });
      if (e.type === 'gave-way' && s.on) {
        const lights = Array.isArray(e.lights) ? e.lights.filter((k) => k === 'lamp' || k === 'bars') : [];
        setAll({ on: false, offReason: 'gave-way', gaveWay: lights });
      }
    });
    const bpm = songBpm();
    return { ok: true, settings: s, song: { bpm: Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : 0 } };
  }

  function status() {
    const fresh = engine && now() - engineAt < ENGINE_STALE_MS;
    return {
      settings: s,
      preset: settingsLib.presetOf(s),
      palettes: settingsLib.PALETTES.palettes.map((p) => ({ id: p.id, name: p.name, es: p.es, colors: p.colors })),
      engine: fresh ? Object.assign({ running: true, seenAgo: Math.round((now() - engineAt) / 1000) }, engine) : { running: false, seenAgo: engine ? Math.round((now() - engineAt) / 1000) : null }
    };
  }

  return { change: change, giveWay: giveWay, engineReport: engineReport, status: status, settings: () => s };
}

module.exports = { FILE: FILE, ENGINE_STALE_MS: ENGINE_STALE_MS, createStore: createStore };
