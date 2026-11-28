/*
 * Music lights on the hub server: keeps the settings (data/lights.json),
 * hears the engine's report once a second, and answers ./hub lights, the
 * mailbox and (later) the phone and TV.
 *
 *   GET  /api/lights          settings, palettes, and what the engine is doing
 *   POST /api/lights          a change: { on, palette, vibrancy, beat, preset, quietMin, look }
 *   POST /api/lights/looks    { save: "Name" } (what the lights show now), { add: {preset} }
 *                             (a whole preset, e.g. one that fires Govee snapshots), { forget: "my-id" }
 *   POST /api/lights/engine   the engine's report; answers settings and the song's tempo
 *
 * Any other way of setting the lights wins: an Ambience scene or light that
 * includes the Govee lights calls giveWay('hub'), which turns music lights off without
 * putting old state back over the new one. The engine notices changes made
 * outside the hub (Govee app, voice, Home Assistant) itself and reports them.
 *
 * Paired presets (looks.js): picking one turns music lights off (at once, no
 * put-back) and the engine paints it. Switching music lights on pauses it;
 * when they stop, the engine paints the look again instead of putting back
 * what Home Assistant saved. Anything else that sets the lights (an Ambience
 * scene, the Govee app) ends the look.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const settingsLib = require('./settings');
const looksLib = require('./looks');

const FILE = 'lights.json';
const ENGINE_STALE_MS = 10000;

function createStore(opt) {
  const o = opt || {};
  const file = path.join(o.dataDir, FILE);
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const songBpm = o.songBpm || (() => 0);
  const onChange = o.onChange || (() => {});   // presets, the preset on, or music on/off changed (the screens' resource)
  let s = settingsLib.defaults();
  try { s = settingsLib.clean(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* first run */ }
  let engine = null;
  let engineAt = 0;
  let onRev = s.on ? s.rev : 0;          // the rev of the last switch on
  let waiters = [];                      // giveWay() calls waiting for the engine to stop
  const savedFile = path.join(o.dataDir, looksLib.SAVED_FILE);
  let saved = [];
  try { saved = looksLib.checkList(JSON.parse(fs.readFileSync(savedFile, 'utf8')).looks, 'saved look').map((l) => Object.assign(l, { saved: true })); } catch (e) { saved = []; }

  const allLooks = () => looksLib.BUILT_IN.concat(saved);
  // o.extraLooks: () => [look, ...] found by id but never listed (Moods' own lamp and bars looks).
  const extraLooks = typeof o.extraLooks === 'function' ? o.extraLooks : () => [];
  const lookById = (id) => allLooks().find((l) => l.id === id) || (extraLooks() || []).find((l) => l && l.id === id) || null;

  function saveLooks() {
    try {
      fs.writeFileSync(savedFile + '.tmp', JSON.stringify({ v: 1, looks: saved }, null, 2) + '\n');
      fs.renameSync(savedFile + '.tmp', savedFile);
    } catch (e) {
      log('music lights: could not save the presets (' + (e && e.code) + ')');
    }
  }

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
    onChange();
    return s;
  }

  function lookList() {
    return allLooks().map((l) => {
      const r = looksLib.resolve(Object.assign({}, l, { motion: 'still' }), 0);
      return { id: l.id, name: l.name, es: l.es, motion: l.motion, saved: !!l.saved, lamp: r.lamp, bars: r.bars };
    });
  }

  // What the TV and phone draw: the presets (colors only), the one on, and
  // whether music lights run (a preset is then paused).
  function screenData() {
    return {
      looks: lookList().map((l) => ({ id: l.id, name: l.name, es: l.es, motion: l.motion, saved: l.saved, lamp: l.lamp.colors, bars: l.bars.colors })),
      on: s.look,
      music: s.on
    };
  }

  // A person's change. Throws a 400 with a plain reason.
  function change(body) {
    const c = settingsLib.checkChange(body);
    const extra = {};
    if (c.look) {
      if (!lookById(c.look)) throw Object.assign(new Error('no preset "' + c.look + '" (./hub lights presets lists them)'), { status: 400 });
      // A preset wins over music lights: off at once, nothing put back.
      extra.lookAt = s.rev + 1;
      if (s.on || c.on === true) { c.on = false; extra.offReason = s.on ? 'look' : s.offReason; extra.gaveWay = []; }
    } else {
      if (c.on === true) { extra.offReason = ''; extra.gaveWay = []; }
      if (c.on === false && s.on) { extra.offReason = 'you'; extra.gaveWay = []; }
    }
    const was = s.on;
    setAll(Object.assign(c, extra));
    if (!was && s.on) onRev = s.rev;
    if (c.look) log('music lights: preset picked' + (was ? ', music lights off' : ''));
    else if (c.look === '') log('music lights: preset cleared');
    else if (was !== s.on) log('music lights: switched ' + (s.on ? 'on' : 'off'));
    else log('music lights: settings changed');
    return status();
  }

  // The lights are about to be set another way through the hub (Ambience).
  // Resolves true once the engine has stopped (its next report says off),
  // or after waitMs, so the new setting is not painted over by a last frame.
  // Resolves false at once when music lights were off.
  function giveWay(who, waitMs) {
    if (!s.on) {
      if (s.look) { setAll({ look: '' }); log('music lights: preset ended, the lights were set another way'); }
      return Promise.resolve(false);
    }
    setAll({ on: false, offReason: 'gave-way', gaveWay: [who || 'hub'], look: '' });
    log('music lights: off, the lights were set another way');
    if (!(engine && now() - engineAt < ENGINE_STALE_MS) || engine.state === 'off') return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { resolve: resolve, timer: null };
      w.timer = setTimeout(() => { waiters = waiters.filter((x) => x !== w); resolve(true); }, waitMs === undefined ? 2500 : waitMs);
      waiters.push(w);
    });
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
      ha: b.ha === true,
      look: typeof b.look === 'string' && settingsLib.LOOK_ID.test(b.look) ? b.look : '',
      snapshots: cleanSnapshots(b.snapshots)
    };
    engineAt = now();
    if (engine.state === 'off' && waiters.length) {
      waiters.forEach((w) => { clearTimeout(w.timer); w.resolve(true); });
      waiters = [];
    }
    (Array.isArray(b.events) ? b.events : []).slice(0, 10).forEach((e) => {
      if (!e || typeof e !== 'object') return;
      // The look the engine painted was changed another way: it has ended.
      if (e.type === 'look-changed') {
        if (s.look && !s.on && e.lookAt === s.lookAt) { setAll({ look: '' }); log('music lights: preset ended, the lights were set another way'); }
        return;
      }
      // Raised before the latest switch on (a resend, or news from an older
      // session): it must not turn the new session off.
      if (Number.isInteger(e.rev) && e.rev < onRev) return;
      if (e.type === 'quiet' && s.on) setAll({ on: false, offReason: 'quiet', gaveWay: [] });
      if (e.type === 'no-lights' && s.on) setAll({ on: false, offReason: '', gaveWay: [] });
      if (e.type === 'gave-way' && s.on) {
        const lights = Array.isArray(e.lights) ? e.lights.filter((k) => k === 'lamp' || k === 'bars') : [];
        setAll({ on: false, offReason: 'gave-way', gaveWay: lights, look: '' });
      }
    });
    const bpm = songBpm();
    return { ok: true, settings: s, look: s.look ? lookById(s.look) : null, song: { bpm: Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : 0 } };
  }

  // The Govee app snapshots each light has, as the engine read them (names only).
  function cleanSnapshots(x) {
    const out = {};
    if (!x || typeof x !== 'object') return out;
    ['lamp', 'bars'].forEach((k) => {
      if (Array.isArray(x[k])) out[k] = x[k].filter((n) => typeof n === 'string' && n.length <= 60).slice(0, 40);
    });
    return out;
  }

  function status() {
    const fresh = engine && now() - engineAt < ENGINE_STALE_MS;
    return {
      settings: s,
      preset: settingsLib.presetOf(s),
      palettes: settingsLib.PALETTES.palettes.map((p) => ({ id: p.id, name: p.name, es: p.es, colors: p.colors })),
      // Presets with the colors each light shows (still), for pickers to draw.
      looks: lookList(),
      engine: fresh ? Object.assign({ running: true, seenAgo: Math.round((now() - engineAt) / 1000) }, engine) : { running: false, seenAgo: engine ? Math.round((now() - engineAt) / 1000) : null }
    };
  }

  // Save a preset (an object from looksLib.fromStates) or forget a saved one.
  // Saving under a name already saved replaces it.
  function saveLook(look) {
    const l = looksLib.check(Object.assign({}, look, { saved: true }), 'the preset');
    if (looksLib.BUILT_IN.some((b) => b.id === l.id)) throw Object.assign(new Error('that name belongs to a built-in preset; pick another'), { status: 400 });
    const rest = saved.filter((x) => x.id !== l.id);
    if (rest.length >= looksLib.MAX_SAVED) throw Object.assign(new Error('already ' + looksLib.MAX_SAVED + ' saved presets; forget one first'), { status: 400 });
    saved = rest.concat([l]);
    saveLooks();
    onChange();
    if (s.look === l.id) setAll({ lookAt: s.rev + 1 });   // repaint the new colors
    log('music lights: preset saved (' + saved.length + ' saved)');
    return status();
  }

  function forgetLook(id) {
    const l = saved.find((x) => x.id === id);
    if (!l) throw Object.assign(new Error(lookById(id) ? 'built-in presets cannot be forgotten' : 'no saved preset "' + id + '"'), { status: 400 });
    saved = saved.filter((x) => x.id !== id);
    saveLooks();
    onChange();
    if (s.look === id) setAll({ look: '' });
    log('music lights: preset forgotten (' + saved.length + ' saved)');
    return status();
  }

  return { change: change, giveWay: giveWay, engineReport: engineReport, status: status, settings: () => s, screenData: screenData, saveLook: saveLook, forgetLook: forgetLook, lookById: lookById };
}

module.exports = { FILE: FILE, ENGINE_STALE_MS: ENGINE_STALE_MS, createStore: createStore };
