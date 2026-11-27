/*
 * On, Off and quiet: what the engine should be doing right now. Pure, with
 * the clock passed in (milliseconds), so tests can run hours in a moment.
 *
 *   off        nothing is sent; the lights are whatever you or a mood set
 *   starting   switched On: the lights' state was saved, fading in (1.5 s)
 *   playing    sound is coming out of the Pi
 *   between    quiet for under 20 s: holds the palette, slowly dims
 *   resting    quiet 20 s or more (or no music yet): a calm glow
 *   stopping   fading out (1.5 s), then the lights are put back
 *
 * Quiet for quietMin minutes (default 15; 0 = never) turns it off and puts
 * the lights back. "Sound" is RMS above a small noise floor for about a
 * second (look.MUSIC_RMS); a gap under half a second does not count as quiet.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const FADE_MS = 1500;
const SOUND_START_MS = 1000;   // this much sound in a row is music
const GAP_OK_MS = 500;         // a gap this short is still music
const BETWEEN_MS = 20000;      // quiet under this is "between songs"
const REST_IN_MS = 8000;       // slowly dims to the resting glow over this
const REST_OUT_MS = 800;       // music back: fades up within a second

function createSession() {
  let state = 'off';
  let fadeFrom = 0;
  let soundSince = -1;
  let lastSound = 0;
  let music = false;
  let heard = false;
  let quietFrom = 0;
  let rest = 1;
  let restore = true;
  let last = 0;
  let quietMin = 15;

  function on(now) {
    if (state !== 'off' && state !== 'stopping') return [];
    const wasStopping = state === 'stopping';
    state = 'starting';
    fadeFrom = now;
    soundSince = -1;
    music = false;
    heard = false;
    quietFrom = now;
    rest = 1;
    last = now;
    return wasStopping ? [] : ['begin'];
  }

  // restoreLights: put the lights back when the fade ends (false when the
  // lights were set another way and must be left alone).
  function off(now, restoreLights) {
    if (state === 'off' || state === 'stopping') return [];
    state = 'stopping';
    fadeFrom = now;
    restore = restoreLights !== false;
    return [];
  }

  // At once, no fade: the lights were changed elsewhere.
  function drop() {
    const was = state;
    state = 'off';
    return was !== 'off';
  }

  // Each frame. sound: was this moment above the noise floor.
  // Returns { state, gain, rest, events } where events may hold
  // 'quiet' (quiet timer ran out: now stopping) and
  // 'end' (the fade-out ended: put the lights back when restore is true).
  function tick(now, sound) {
    const events = [];
    const dt = Math.max(0, now - last);
    last = now;
    if (state === 'off') return { state: state, gain: 0, rest: 1, events: events, restore: restore };
    if (sound) {
      if (soundSince < 0) soundSince = now;
      lastSound = now;
      if (!music && now - soundSince >= SOUND_START_MS) { music = true; heard = true; }
    } else if (now - lastSound > GAP_OK_MS) {
      if (music) quietFrom = lastSound;
      soundSince = -1;
      music = false;
    }
    if (music) rest = Math.max(0, rest - dt / REST_OUT_MS);
    else rest = Math.min(1, rest + dt / REST_IN_MS);

    let gain = 1;
    if (state === 'starting') {
      gain = Math.min(1, (now - fadeFrom) / FADE_MS);
      if (gain >= 1) state = 'running';
    }
    if (state === 'stopping') {
      gain = Math.max(0, 1 - (now - fadeFrom) / FADE_MS);
      if (gain <= 0) { state = 'off'; events.push('end'); }
      return { state: state, gain: gain, rest: rest, events: events, restore: restore };
    }
    if (!music && quietMin > 0 && now - quietFrom >= quietMin * 60000) {
      events.push('quiet');
      off(now, true);
      return { state: 'stopping', gain: 1, rest: rest, events: events, restore: true };
    }
    return { state: label(now), gain: gain, rest: rest, events: events, restore: restore };
  }

  function label(now) {
    if (state === 'off' || state === 'stopping' || state === 'starting') return state;
    if (music) return 'playing';
    if (heard && now - quietFrom < BETWEEN_MS) return 'between';
    return 'resting';
  }

  return {
    on: on,
    off: off,
    drop: drop,
    tick: tick,
    setQuietMin: (m) => { quietMin = Number.isInteger(m) && m >= 0 ? m : 15; },
    state: () => state,
    isOn: () => state !== 'off',
    quietFor: (now) => (music || state === 'off' ? 0 : now - quietFrom)
  };
}

module.exports = {
  FADE_MS: FADE_MS,
  SOUND_START_MS: SOUND_START_MS,
  BETWEEN_MS: BETWEEN_MS,
  createSession: createSession
};
