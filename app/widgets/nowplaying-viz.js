/*
 * The music visualizer of the full screen Now Playing page.
 *
 * In the spirit of the old MilkDrop / Winamp / iTunes visualizers: bright
 * shapes roam the whole screen and leave trails, tunnels and swirls behind,
 * in the album picture's colors, moving with the song's "vibe" (tempo,
 * energy, mood, danceability, acousticness), which the Pi looks up (see
 * pi/vibe.js). Only the full screen page has it; the tile and the smaller
 * page stay as they are. While it runs, the page shrinks to a small card in
 * the upper left (nowplaying.js).
 *
 * How it draws (levels 'classic' and 'lite'): one small canvas (480 x 270,
 * or 320 x 180), stretched over the panel. Each frame (at most 30 a second):
 *   1. the previous frame is drawn back onto it a little zoomed, turned and
 *      shifted, faded toward a deep tint of the album's main color: the
 *      "feedback" that turns a few lines into trails and tunnels;
 *   2. a few new bright shapes are drawn on top, by the scene playing now.
 * Scenes: spirograph, tunnel, kaleidoscope, ribbons, starburst, lattice.
 * Which one plays is worked out from the song's id and position (they change
 * every 16 or 32 beats), so a seek lands in the right scene.
 *
 * There is no audio here: Spotify sends none. The beat is counted from the
 * song's start at its tempo, and the "waves" are sums of sines. It moves at
 * the song's speed and feel, not to its actual sound.
 *
 * Radiant (the top level, v0.25.0): the same scenes on a 960 x 540 canvas
 * with a wide faint halo under every line, soft light sprites on the
 * sparks, drifting motes of light at three depths, a bloom (the picture
 * shrunk to 1/4 and 1/16 and stretched back over itself, added on) and a
 * vignette. The trails live on a hidden state canvas; the shown canvas is a
 * copy plus motes plus bloom, so the bloom never feeds back. It draws at 60
 * frames a second, or 30 when a frame costs over 11 ms, and steps down to
 * classic at once when a frame costs over 24 ms.
 *
 * Built for a slow TV: no getImageData, shadows, filters or gradients per
 * frame, no new arrays or objects per frame. A frame-rate check after it
 * starts steps down: classic (480 x 270 at 30 fps, colors that add up to
 * white where they cross) to lite (320 x 180 at 24 fps, fewer shapes, plain
 * alpha) to glow (soft CSS glows only, moved by the compositor) to a still
 * wash (and the big picture layout again). The answer is kept for this
 * build. On the plainest motion setting ('fade') it starts at the still wash.
 * Paused, it settles and the drawing loop stops; nothing runs while it is
 * hidden or closed.
 *
 * Plain ES5. window.HUB_NP_VIZ:
 *   plan(info)         the level it would show for info: 'off', 'wash',
 *                      'glow', 'lite' or 'classic' (decides the page layout)
 *   compact(level)     true when that level goes with the small card
 *   sync(host, info)   show, update in place, or (info null) stop; true
 *                      while it shows.
 *                      info: { id, art, vibe, playing, positionMs, durationMs,
 *                      config, motionFade, center: {x, y, size}, textLeft,
 *                      relayout() (called when a step down changes layout) }
 *   tick(positionMs)   the song's position now
 *   status()           one line for the About panel, '' before the first show
 *   debug()            what runs now (tests)
 *   palette(id)        the colors read for a song (tests)
 *   sceneAt(id, vibe, positionMs)   the scene for that point of a song (tests)
 *   test               hooks for the tests (shorter phrases and checks)
 */
(function () {
  'use strict';

  var STORE_KEY = 'homeHub.npViz';
  var LEVELS = ['off', 'wash', 'glow', 'lite', 'classic', 'radiant'];
  var ALIAS = { full: 'radiant' };
  var NAMES = { radiant: 'radiant', classic: 'classic', lite: 'classic-lite', glow: 'glows', wash: 'still wash', off: 'off' };
  var LADDER = { radiant: 'classic', classic: 'lite', lite: 'glow', glow: 'wash' };
  var CANVAS = {
    radiant: { w: 960, h: 540, fps: 60, lighter: true, amount: 1, bloom: true },
    classic: { w: 480, h: 270, fps: 30, lighter: true, amount: 1 },
    lite: { w: 320, h: 180, fps: 24, lighter: false, amount: 0.55 }
  };
  var SCENES = ['spirograph', 'tunnel', 'kaleidoscope', 'ribbons', 'starburst', 'lattice'];
  var SHARP = [1, 2, 4];       // tunnel, kaleidoscope, starburst: for dance songs
  var FLOWING = [0, 3, 5];     // spirograph, ribbons, lattice: for calm ones
  var FADE_MS = 1400;          // glow level: a new song's colors cross-fade over this long
  var REST_MS = 1300;          // glow level: pausing fades, then holds still
  var SETTLE_MS = 350;         // canvas: pausing settles over this long, then the loop stops
  var TIMING = { after: 3500, ms: 2000, again: 800 };   // the frame-rate check: start, length, retry
  var QUICK_MS = 24;           // radiant: drawing a frame takes longer than this on average: step down at once
  var HALF_MS = 11;            // radiant: over this a frame, 30 a second instead of 60
  var MIN_FPS = 24;            // glow level
  var MAX_GAP_MS = 250;
  var SAMPLE_WAIT_MS = 700;    // wait this long for the album colors before using a fallback

  var st = {
    host: null, root: null, scene: null, leaving: [],
    level: 'radiant', source: 'auto', fps: 0, measured: false,
    info: null, anchorAt: 0, anchorPos: 0, playing: false,
    palettes: {}, sampling: {}, problem: '',
    timers: [], measureRaf: 0, restTimer: null,
    shown: false, lastStrength: -1, listening: false,
    cv: null, lastScene: '', phraseBeats: 0, forcePoor: false, forceScene: -1
  };

  /* ---------- small helpers ---------- */

  function now() { return new Date().getTime(); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isCanvas(level) { return level === 'radiant' || level === 'classic' || level === 'lite'; }
  function compact(level) { return isCanvas(level) || level === 'glow'; }
  function levelName(q) { q = ALIAS[q] || q; return LEVELS.indexOf(q) >= 0 ? q : null; }

  function later(fn, ms) {
    var t = setTimeout(function () {
      var i = st.timers.indexOf(t);
      if (i >= 0) st.timers.splice(i, 1);
      try { fn(); } catch (e) { warn(e); }
    }, ms);
    st.timers.push(t);
    return t;
  }

  function cancel(t) {
    clearTimeout(t);
    var i = st.timers.indexOf(t);
    if (i >= 0) st.timers.splice(i, 1);
  }

  function warn(e) {
    st.problem = String(e && e.message ? e.message : e).slice(0, 80);
    if (window.console && console.warn) console.warn('Visualizer: ' + st.problem);
  }

  function readQuery(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function lsGet() {
    try {
      var raw = window.localStorage && localStorage.getItem(STORE_KEY);
      var d = raw ? JSON.parse(raw) : null;
      return d && d.build === window.HUB_BUILD && LEVELS.indexOf(d.level) > 0 ? d : null;
    } catch (e) { return null; }
  }

  function lsSet(d) {
    try { if (window.localStorage) localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) { /* not kept */ }
  }

  // A small, fast, seeded random source, so a song always looks like itself.
  function seeded(text) {
    var h = 2166136261;
    var s = String(text || 'none');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return function () {
      h = (h + 0x6D2B79F5) >>> 0;
      var t = h;
      t = Math.imul ? Math.imul(t ^ (t >>> 15), t | 1) : ((t ^ (t >>> 15)) * (t | 1)) >>> 0;
      t ^= t + (Math.imul ? Math.imul(t ^ (t >>> 7), t | 61) : ((t ^ (t >>> 7)) * (t | 61)) >>> 0);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function floats(n) {
    if (window.Float32Array) return new Float32Array(n);
    var a = [];
    for (var i = 0; i < n; i++) a.push(0);
    return a;
  }

  /* ---------- colors ---------- */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) return [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function f(t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }

  function hueDist(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // Moves a hue toward a target by at most `by` degrees, the short way round.
  function nudgeHue(h, target, by) {
    var d = ((target - h + 540) % 360) - 180;
    return h + clamp(d, -by, by);
  }

  // Lifts very dark colors, tames loud ones, keeps grey from going muddy.
  function tune(hsl, minL, maxL, minS, maxS) {
    return [hsl[0], clamp(hsl[1], minS, maxS), clamp(hsl[2], minL, maxL)];
  }

  // A deep tone of a color for the wash. Deep oranges, yellows and olives
  // turn brown, so those lean toward wine instead.
  function deep(hsl, l) {
    var h = hsl[0];
    if (h >= 12 && h <= 95) h = nudgeHue(h, 345, 45);
    return [h, clamp(hsl[1] * 0.8, 0.25, 0.6), l];
  }

  function rgba(hsl, a) {
    var c = hslToRgb(hsl[0], hsl[1], hsl[2]);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (Math.round(a * 1000) / 1000) + ')';
  }

  // Three colors from the mood alone, for when the picture cannot be read.
  function fallbackPalette(vibe) {
    var v = vibe ? vibe.valence : 0.55;
    var e = vibe ? vibe.energy : 0.45;
    var h = (226 + 150 * v) % 360;           // low mood blue, through violet and rose, to warm coral
    return {
      from: 'mood',
      dom: [h, 0.45 + 0.25 * e, 0.5],
      acc: [(h + 38 + 50 * e) % 360, 0.5 + 0.2 * e, 0.58],
      light: [(h + 18) % 360, 0.42, 0.8]
    };
  }

  // Picks a main color, a contrasting one and a soft light from 16 x 16
  // pixels (RGBA bytes).
  function paletteFromPixels(px, vibe) {
    var buckets = [];
    var i, b;
    for (i = 0; i < 12; i++) buckets.push({ w: 0, r: 0, g: 0, b: 0, n: 0 });
    var grey = { w: 0, r: 0, g: 0, b: 0, n: 0 };
    var lights = [];
    var total = 0;
    for (i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      var hsl = rgbToHsl(px[i], px[i + 1], px[i + 2]);
      lights.push({ l: hsl[2], r: px[i], g: px[i + 1], b: px[i + 2] });
      var colorful = hsl[1] > 0.18 && hsl[2] > 0.1 && hsl[2] < 0.93;
      b = colorful ? buckets[Math.floor(hsl[0] / 30) % 12] : grey;
      // Colorful, mid-light pixels count for more than dull or near-black ones.
      var w = colorful ? 1 + 2 * hsl[1] * (1 - Math.abs(hsl[2] - 0.5)) : 0.6;
      b.w += w; b.n += 1; b.r += px[i] * w; b.g += px[i + 1] * w; b.b += px[i + 2] * w;
      total += w;
    }
    if (!total) return null;
    function avg(x) { return rgbToHsl(x.r / x.w, x.g / x.w, x.b / x.w); }
    // A big pale area should not beat a smaller vivid one: score by weight
    // and how colorful the bucket is on average.
    for (i = 0; i < buckets.length; i++) {
      var sat = buckets[i].w ? avg(buckets[i])[1] : 0;
      buckets[i].score = buckets[i].w * (0.3 + sat) * (0.3 + sat);
    }
    var order = buckets.slice().sort(function (p, q) { return q.score - p.score; });
    var mood = fallbackPalette(vibe);
    var dom, acc;
    if (order[0].w > total * 0.12) {
      dom = avg(order[0]);
    } else {
      // A grey or black-and-white picture: its lightness, the mood's hue.
      dom = grey.w ? avg(grey) : mood.dom;
      dom = [mood.dom[0], 0.3, dom[2]];
    }
    for (i = 1; i < order.length && !acc; i++) {
      if (order[i].w > total * 0.04) {
        var c = avg(order[i]);
        if (hueDist(c[0], dom[0]) >= 45) acc = c;
      }
    }
    if (!acc) {
      // No second color in the picture: a neighbor of the first, turned the
      // way that does not land on yellow-olive.
      var up = (dom[0] + 40) % 360;
      var down = (dom[0] + 320) % 360;
      acc = [up > 46 && up < 100 ? down : up, Math.max(0.45, dom[1]), dom[2] + 0.08];
    }
    lights.sort(function (p, q) { return q.l - p.l; });
    var top = lights.slice(0, Math.max(1, Math.floor(lights.length / 5)));
    var lr = 0, lg = 0, lb = 0;
    for (i = 0; i < top.length; i++) { lr += top[i].r; lg += top[i].g; lb += top[i].b; }
    var light = rgbToHsl(lr / top.length, lg / top.length, lb / top.length);
    if (light[1] < 0.12) light = [dom[0], 0.3, light[2]];
    return { from: 'art', dom: dom, acc: acc, light: light };
  }

  // The same rules for every palette: never black, never neon, warmer for a
  // happy song and cooler for a sad one.
  function finish(p, vibe) {
    var v = vibe ? vibe.valence : 0.55;
    var warm = (v - 0.5) * 2;                // -1 .. 1
    var by = Math.abs(warm) * 14;
    function temper(h, k) {
      h = ((h % 360) + 360) % 360;
      // A sad song cools blues and violets toward blue; reds, oranges and
      // yellows go a little toward wine instead (through green is mud).
      var target = warm >= 0 ? 32 : (h <= 110 || h >= 330 ? 350 : 218);
      h = nudgeHue(h, target, by * k);
      h = ((h % 360) + 360) % 360;
      // Glowing yellow-olive reads as mud on a dark screen: gold or green.
      if (h > 46 && h <= 74) h = nudgeHue(h, 40, 24);
      else if (h > 74 && h < 100) h = nudgeHue(h, 118, 26);
      return h;
    }
    return {
      from: p.from,
      dom: tune([temper(p.dom[0], 1), p.dom[1], p.dom[2]], 0.5, 0.66, 0.38, 0.72),
      acc: tune([temper(p.acc[0], 0.6), p.acc[1], p.acc[2]], 0.55, 0.7, 0.42, 0.78),
      light: tune([temper(p.light[0], 0.5), p.light[1], p.light[2]], 0.78, 0.88, 0.22, 0.55)
    };
  }

  // Reads the tiny album picture (64 px) into a 16 x 16 canvas. cb(palette or null).
  function sample(id, url, vibe, cb) {
    if (!url || !document.createElement('canvas').getContext) { cb(null, 'no picture'); return; }
    if (st.sampling[id]) { st.sampling[id].push(cb); return; }
    st.sampling[id] = [cb];
    var called = false;
    function done(p, why) {
      if (called) return;
      called = true;
      var list = st.sampling[id] || [];
      delete st.sampling[id];
      for (var i = 0; i < list.length; i++) { try { list[i](p, why); } catch (e) { warn(e); } }
    }
    var img = new Image();
    var guard = setTimeout(function () { done(null, 'picture too slow'); }, 5000);
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      clearTimeout(guard);
      try {
        var c = document.createElement('canvas');
        c.width = 16;
        c.height = 16;
        var g = c.getContext('2d');
        g.drawImage(img, 0, 0, 16, 16);
        // Throws when the picture came without permission to read it.
        var data = g.getImageData(0, 0, 16, 16).data;
        var p = paletteFromPixels(data, vibe);
        done(p, p ? '' : 'an empty picture');
      } catch (e) {
        done(null, 'picture not readable');
      }
    };
    img.onerror = function () { clearTimeout(guard); done(null, 'picture did not load'); };
    img.src = url;
  }

  /* ---------- the song's feel, from its vibe ---------- */

  function params(info) {
    var v = info.vibe;
    var tempo = v && v.tempo >= 40 && v.tempo <= 220 ? v.tempo : 100;
    // No vibe: a calm middle.
    var energy = v ? v.energy : 0.4;
    var valence = v ? v.valence : 0.55;
    var dance = v ? v.dance : 0.4;
    var acoustic = v ? v.acoustic : 0.4;
    var beat = 60000 / tempo;
    // Pulses never come faster than 2.5 a second; a fast song pulses every
    // second beat.
    var pulseBeats = tempo > 140 ? 2 : 1;
    while (beat * pulseBeats < 400) pulseBeats *= 2;
    // The glows' slow cycle: a whole number of 8-beat phrases, 9 to 20 s.
    var cycleBeats = 8;
    while (cycleBeats * beat < 9000 && cycleBeats < 128) cycleBeats *= 2;
    var rnd = seeded(info.id + '|look');
    return {
      tempo: tempo, beat: beat, pulseBeats: pulseBeats, pulseMs: beat * pulseBeats,
      energy: energy, valence: valence, dance: dance, acoustic: acoustic,
      // How likely a sharp, geometric scene is (else a flowing one).
      sharp: clamp(0.5 + 0.9 * (dance - 0.5) + 0.6 * (energy - 0.5) - 0.8 * (acoustic - 0.35), 0.06, 0.94),
      drift: valence >= 0.58 ? 'rise' : valence <= 0.38 ? 'sink' : 'side',
      orbMs: cycleBeats * beat,
      orbSize: 0.36 + 0.14 * (1 - energy),
      phraseBeats: tempo >= 110 ? 32 : 16,
      wavePhase: rnd() * Math.PI * 2
    };
  }

  function vibeKey(v) {
    return v ? [v.source, v.tempo, v.energy, v.valence, v.dance, v.acoustic].join(',') : 'none';
  }

  // The song's running order of scenes: twelve phrases, then round again.
  // Seeded by the song, so it always plays the same way; weighted by its
  // vibe; never the same scene twice in a row.
  function orderFor(id, P) {
    var rnd = seeded(id + '|scenes');
    var out = [];
    var last = -1;
    for (var i = 0; i < 12; i++) {
      var fam = rnd() < P.sharp ? SHARP : FLOWING;
      var pick = fam[Math.floor(rnd() * 3) % 3];
      if (pick === last || (i === 11 && pick === out[0])) pick = fam[(fam.indexOf(pick) + 1) % 3];
      if (i === 11 && pick === out[0]) pick = fam[(fam.indexOf(pick) + 1) % 3];
      out.push(pick);
      last = pick;
    }
    return out;
  }

  function phraseLen(P) { return st.phraseBeats || P.phraseBeats; }

  function sceneIndex(order, P, pos) {
    var n = Math.floor(Math.max(0, pos) / P.beat / phraseLen(P));
    return order[n % order.length];
  }

  // 0..1 over the song: eases in over the first 8 %, swells and settles in
  // long phrases, and calms over the last 6 %.
  function arc(P, pos, dur) {
    var f = dur ? clamp(pos / dur, 0, 1) : 0.3;
    var inA = smooth(0, 0.08, f);
    var outA = 1 - 0.55 * smooth(0.94, 1, f);
    var wave = 0.8 + 0.2 * Math.sin(2 * Math.PI * (pos / P.beat) / (P.phraseBeats * 2) + P.wavePhase);
    return clamp((0.3 + 0.7 * inA) * wave * outA, 0, 1);
  }

  function position() {
    if (!st.playing) return st.anchorPos;
    return st.anchorPos + Math.max(0, now() - st.anchorAt);
  }

  // The colors for the song now: the picture's (kept per song, as read),
  // or the mood's; tuned with the vibe known now.
  function colorsFor(info) {
    var raw = st.palettes[info.id];
    return finish(raw && raw.from === 'art' ? raw : fallbackPalette(info.vibe), info.vibe);
  }

  // Reads the song's picture once; cb() runs when its colors are known.
  function wantColors(info, cb) {
    var id = info.id;
    if (st.palettes[id]) return;
    sample(id, info.art, info.vibe, function (p, why) {
      st.problem = why || '';
      st.palettes[id] = p || { from: 'mood' };
      if (st.info && st.info.id === id && st.root) cb();
    });
  }

  /* ---------- the canvas: classic and lite ---------- */

  // One frame's facts, shared with the scenes. Reused: nothing is made per frame.
  var F = {
    W: 480, H: 270, s: 1, t: 0, b: 0, kick: 0, e: 0.5, k: 1, amt: 1, sp: 1, dt: 1,
    onBeat: false, flash: 0, h0: 0, h1: 0, h2: 0, hr: 40, sat: 85, lum: 58, alpha: 1,
    tz: 1, tr: 0, tdx: 0, tdy: 0, tdecay: 0.92, tox: 240, toy: 135, glow: false
  };
  var PARTS = 200;   // starburst particles: x, y, vx, vy, life
  var LATTICE = 96;
  var MOTES = 64;    // radiant: drifting motes of light: x, y, depth, phase

  function hsla(h, l, a) {
    h = ((h % 360) + 360) % 360;
    return 'hsla(' + Math.round(h) + ',' + F.sat + '%,' + Math.round(clamp(l, 20, 92)) + '%,' + (Math.round(clamp(a, 0, 1) * 1000) / 1000) + ')';
  }

  // Pen i's color now: the album's three colors in turn, each swinging
  // through a range of hues (wide for a happy song, narrow for a sad one).
  function color(i, dl, a) {
    var m = i % 3;
    var base = m === 0 ? F.h0 : m === 1 ? F.h1 : F.h2;
    return hsla(base + F.hr * Math.sin(F.t * 0.09 + i * 1.7), F.lum + dl, a);
  }

  function rand(C) {
    C.lcg = (C.lcg * 1664525 + 1013904223) >>> 0;
    return C.lcg / 4294967296;
  }

  // Strokes the current path. At the radiant level each line is first drawn
  // wide and faint (a halo) and then sharp on top: the halos add up where
  // lines cross, which is where the glow comes from.
  function ink(g) {
    if (F.glow) {
      var lw = g.lineWidth;
      g.globalAlpha = 0.07;
      g.lineWidth = lw * 3 + F.s * 2.5;
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = lw;
    }
    g.stroke();
  }

  // A soft round light (white hot in the middle, the color around it, then
  // nothing), drawn once per color and stamped with drawImage.
  function makeSprite(hsl) {
    var c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    var g = c.getContext('2d');
    var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.14, rgba([hsl[0], hsl[1], 0.85], 0.95));
    gr.addColorStop(0.45, rgba([hsl[0], hsl[1], 0.58], 0.38));
    gr.addColorStop(1, rgba([hsl[0], hsl[1], 0.5], 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  function stamp(g, spr, x, y, r, a) {
    g.globalAlpha = a;
    g.drawImage(spr, x - r, y - r, r * 2, r * 2);
  }

  // The final picture: the state canvas, plus drifting motes of light at
  // three depths, plus a soft bloom (the picture shrunk and stretched back
  // over itself, added on). Done on a second canvas so the bloom never feeds
  // back into the trails.
  function present(C, pos) {
    var d = C.dg;
    if (!d) return;
    var W = C.W;
    var H = C.H;
    d.globalCompositeOperation = 'copy';
    d.globalAlpha = 1;
    d.drawImage(C.el, 0, 0);
    d.globalCompositeOperation = 'lighter';
    var t = pos / 1000;
    var M = C.motes;
    var P = C.P;
    var sp = C.sprites;
    if (sp && P) {
      var n = MOTES;
      var kick = F.kick;
      for (var i = 0; i < n; i++) {
        var b = i * 4;
        var z = M[b + 2];                               // 0.2 far .. 1 near
        var x = (M[b] + t * 0.012 * z * (P.valence >= 0.5 ? 1 : -1) + 0.02 * Math.sin(t * 0.3 + M[b + 3] * 6)) % 1;
        if (x < 0) x += 1;
        var y = (M[b + 1] - t * (P.drift === 'sink' ? -0.01 : 0.014) * z) % 1;
        if (y < 0) y += 1;
        var tw = 0.5 + 0.5 * Math.sin(t * (0.8 + z) + M[b + 3] * 40);
        var r = (2.5 + 8 * z * z) * C.W / 960 * (1 + 0.7 * kick * z);
        stamp(d, sp[i % 3], x * W, y * H, r * 2, (0.12 + 0.5 * z) * (0.35 + 0.65 * tw) * (0.55 + 0.45 * F.k));
      }
    }
    d.globalAlpha = 0.15;
    d.drawImage(C.mid, 0, 0, W, H);
    d.globalAlpha = 0.18;
    d.drawImage(C.low, 0, 0, W, H);
    d.globalAlpha = 1;
    d.globalCompositeOperation = 'source-over';
  }

  // The shrunk copies the bloom is made of.
  function shrink(C) {
    C.mg.globalCompositeOperation = 'copy';
    C.mg.drawImage(C.el, 0, 0, C.mid.width, C.mid.height);
    C.lg.globalCompositeOperation = 'copy';
    C.lg.drawImage(C.mid, 0, 0, C.low.width, C.low.height);
  }

  function startCanvas() {
    var cfg = CANVAS[st.level];
    var C = st.cv;
    if (C && C.cfg === cfg && C.view.parentNode === st.root) return C;
    stopCanvas();
    var cv = el('canvas', cfg.bloom ? '' : 'npv-canvas', cfg.bloom ? null : null);
    cv.width = cfg.w;
    cv.height = cfg.h;
    var g = cv.getContext && cv.getContext('2d');
    if (!g) throw new Error('no canvas here');
    var buf = document.createElement('canvas');
    buf.width = cfg.w;
    buf.height = cfg.h;
    var disp = null;
    if (cfg.bloom) {
      // The state canvas stays off the page; this one is what shows.
      disp = el('canvas', 'npv-canvas');
      disp.width = cfg.w;
      disp.height = cfg.h;
      st.root.appendChild(disp);
      el('div', 'npv-vignette', st.root);
    } else {
      st.root.appendChild(cv);
    }
    var mid = null, low = null;
    if (cfg.bloom) {
      mid = document.createElement('canvas'); mid.width = Math.round(cfg.w / 4); mid.height = Math.round(cfg.h / 4);
      low = document.createElement('canvas'); low.width = Math.round(cfg.w / 16); low.height = Math.round(cfg.h / 16);
    }
    C = st.cv = {
      el: cv, g: g, view: disp || cv, dg: disp ? disp.getContext('2d') : null,
      mid: mid, low: low, mg: mid ? mid.getContext('2d') : null, lg: low ? low.getContext('2d') : null,
      motes: floats(MOTES * 4), sprites: null, cost: 0, costN: 0, avg: 0, buf: buf, bg: buf.getContext('2d'), cfg: cfg, W: cfg.w, H: cfg.h,
      raf: 0, last: 0, interval: 1000 / cfg.fps, frames: 0, restAt: 0, still: false,
      lastBeat: -1, scene: -1, fz: 1, fr: 0, fdx: 0, fdy: 0, fdecay: 0.92, fox: cfg.w / 2, foy: cfg.h / 2,
      base: '#120a1a', palFrom: '', P: null, order: null, id: '', vkey: '', lcg: 1,
      mt: window.Float64Array ? new Float64Array(200) : floats(200), mn: 0, measuring: false,
      parts: floats(PARTS * 5),
      lx: floats(LATTICE), ly: floats(LATTICE), prm: floats(64)
    };
    g.fillStyle = C.base;
    g.fillRect(0, 0, C.W, C.H);
    if (cfg.bloom) {
      var mr = seeded('motes');
      for (var m = 0; m < MOTES; m++) { C.motes[m * 4] = mr(); C.motes[m * 4 + 1] = mr(); C.motes[m * 4 + 2] = 0.2 + 0.8 * mr(); C.motes[m * 4 + 3] = mr(); }
    }
    return C;
  }

  function stopCanvas() {
    var C = st.cv;
    if (!C) return;
    if (C.raf && window.cancelAnimationFrame) cancelAnimationFrame(C.raf);
    C.raf = 0;
    if (C.view.parentNode) C.view.parentNode.removeChild(C.view);
    var vg = st.root && st.root.querySelector('.npv-vignette');
    if (vg) vg.parentNode.removeChild(vg);
    st.cv = null;
  }

  // A new song (or its vibe arrived): new colors, seed and running order.
  // The picture already drawn stays, so the next song morphs out of it.
  function songSetup(C, info) {
    C.id = info.id;
    C.vkey = vibeKey(info.vibe);
    C.P = params(info);
    C.order = orderFor(info.id, C.P);
    var rnd = seeded(info.id + '|shapes');
    for (var i = 0; i < C.prm.length; i++) C.prm[i] = rnd();
    C.lcg = Math.floor(rnd() * 4294967296) >>> 0;
    setColors(C, info);
    wantColors(info, function () { if (st.cv === C && C.id === info.id) setColors(C, st.info); });
  }

  function setColors(C, info) {
    var pal = colorsFor(info);
    C.pal = pal;
    C.palFrom = pal.from;
    // The base the trails fade into: a deep tint of the main color, never black.
    C.base = rgba(deep(pal.dom, 0.075), 1);
    if (C.cfg.bloom) C.sprites = [makeSprite(pal.dom), makeSprite(pal.acc), makeSprite(pal.light)];
  }

  function run() {
    var C = st.cv;
    if (!C || C.raf || !st.root || document.hidden || !window.requestAnimationFrame) return;
    C.still = false;
    C.last = 0;
    C.raf = requestAnimationFrame(frame);
  }

  function frame(ts) {
    var C = st.cv;
    if (!C) return;
    C.raf = 0;
    if (!st.root || document.hidden) return;
    var keep = true;
    if (!C.last || ts - C.last >= C.interval - 3) {
      var dt = C.last ? ts - C.last : C.interval;
      C.last = !C.last || ts - C.last > C.interval * 2 ? ts : C.last + C.interval;
      var t0 = window.performance && performance.now ? performance.now() : 0;
      try {
        keep = draw(C, dt, position(), st.playing);
        if (t0) {
          var cost = performance.now() - t0;
          C.avg = C.avg ? C.avg * 0.96 + cost * 0.04 : cost;
          if (st.playing && C.cfg.bloom && C.costN < 30) {
            C.costN += 1;
            C.cost += cost;
            if (C.costN === 30 && C.cost / 30 > HALF_MS && C.interval < 40) C.interval = 1000 / 30;
            if (C.costN === 30 && C.cost / 30 > QUICK_MS && st.source === 'auto' && !st.measured) later(function () { quickStep(C); }, 0);
          }
        }
      } catch (e) {
        warn(e);
        keep = false;
      }
      if (C.measuring && C.mn < C.mt.length) C.mt[C.mn++] = ts;
    }
    if (keep && st.cv === C) C.raf = requestAnimationFrame(frame);
    else C.still = true;
  }

  // Draws one frame for the song at pos. False once a pause has settled
  // (nothing left to move).
  function draw(C, dtMs, pos, playing) {
    var g = C.g;
    var W = C.W;
    var H = C.H;
    var P = C.P;
    var cfg = C.cfg;
    var f = clamp(dtMs / 33.33, 0.5, 3);    // the feedback is tuned per 30 fps frame
    var rest = 0;
    if (!playing) {
      if (!C.restAt) C.restAt = now();
      rest = clamp((now() - C.restAt) / SETTLE_MS, 0, 1);
    } else {
      C.restAt = 0;
    }

    F.glow = !!cfg.bloom;
    F.W = W; F.H = H; F.s = W / 480; F.amt = cfg.amount; F.dt = f;
    F.t = pos / 1000;
    F.b = pos / P.beat;
    F.sp = clamp(P.tempo / 110, 0.6, 1.6);
    // The kick: bright and big on each pulse, gone well before the next.
    var ph = (pos / P.pulseMs) % 1;
    F.kick = Math.exp(-ph * 5) * (0.45 + 0.55 * P.energy);
    var bi = Math.floor(pos / P.pulseMs);
    F.onBeat = playing && bi !== C.lastBeat;
    C.lastBeat = bi;
    F.e = P.energy;
    F.k = arc(P, pos, st.info ? st.info.durationMs : 0);
    var inPhrase = F.b % phraseLen(P);
    F.flash = inPhrase < 1 ? 1 - inPhrase : 0;
    var pal = C.pal;
    F.h0 = pal.dom[0]; F.h1 = pal.acc[0]; F.h2 = pal.light[0];
    // Pens in one color look flat: keep the three hues apart.
    if (hueDist(F.h1, F.h0) < 45) F.h1 = F.h0 + (P.valence >= 0.5 ? -55 : 55);
    if (hueDist(F.h2, F.h0) < 30 || hueDist(F.h2, F.h1) < 30) F.h2 = F.h0 + (P.valence >= 0.5 ? 35 : -35);
    F.hr = 14 + 56 * P.valence;
    F.sat = Math.round(72 + 22 * clamp(pal.dom[1] * 1.4, 0, 1));
    F.lum = cfg.lighter ? 56 : 62;
    F.alpha = clamp((0.55 + 0.45 * P.energy) * (0.55 + 0.45 * F.k) + 0.3 * F.kick, 0.3, 1);
    if (cfg.bloom) F.alpha = clamp(F.alpha * Math.min(1, f * 0.72), 0.1, 1);   // more frames a second: each one fainter

    var si = st.forceScene >= 0 ? st.forceScene : sceneIndex(C.order, P, pos);
    if (si !== C.scene) {
      C.scene = si;
      for (var i = 4; i < C.parts.length; i += 5) C.parts[i] = 0;
      st.lastScene = SCENES[si];
    }

    // 1. The last frame, a little zoomed, turned and moved, fading into the base.
    var drive = 0.6 + 0.7 * P.energy;          // calm songs move their trails slower
    var zf = 1 + ((C.fz - 1) * drive + (C.fz >= 1 ? 0.012 : -0.008) * F.kick + 0.03 * F.flash) * f;
    var rot = C.fr * drive * f;
    var dx = C.fdx * f;
    var dy = C.fdy * f;
    var decay = Math.pow(C.fdecay, f);
    if (rest) {
      zf = lerp(zf, 1, rest); rot *= 1 - rest; dx *= 1 - rest; dy *= 1 - rest;
      decay = lerp(decay, 1, rest);
    }
    C.bg.globalCompositeOperation = 'copy';
    C.bg.drawImage(C.el, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = C.base;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = decay;
    var co = Math.cos(rot) * zf;
    var sn = Math.sin(rot) * zf;
    var ox = C.fox;
    var oy = C.foy;
    g.setTransform(co, sn, -sn, co, ox - co * ox + sn * oy + dx, oy - sn * ox - co * oy + dy);
    g.drawImage(C.buf, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    C.frames += 1;
    if (rest >= 1) { if (C.dg) { shrink(C); present(C, pos); } return false; }
    if (!playing) { if (C.dg) { shrink(C); present(C, pos); } return true; }          // settling: no new shapes

    // 2. New shapes. Where they cross, 'lighter' adds them up toward white.
    if (cfg.lighter) g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    DRAW[si](g, C, si * 10);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    if (C.dg) { shrink(C); present(C, pos); }

    // The feedback eases toward what the scene asks for, so scenes blend.
    var a = clamp(0.06 * f, 0, 1);
    var b = clamp(0.15 * f, 0, 1);
    C.fz += (F.tz - C.fz) * a;
    C.fr += (F.tr - C.fr) * a;
    C.fdx += (F.tdx - C.fdx) * a;
    C.fdy += (F.tdy - C.fdy) * a;
    C.fdecay += (F.tdecay - C.fdecay) * a;
    C.fox += (F.tox - C.fox) * b;
    C.foy += (F.toy - C.foy) * b;
    return true;
  }

  // Opened while paused: play the last second and a bit, so the still
  // picture has something in it.
  function prime(C, pos) {
    for (var i = 36; i >= 1; i--) draw(C, 33.33, Math.max(0, pos - i * 33.33), true);
    C.restAt = 0;
  }

  /* ---------- the scenes ---------- */

  // Each draws a few bright shapes and says where the feedback should go:
  // F.tz zoom (over 1 outward), F.tr turn, F.tdx/F.tdy shift, F.tdecay how
  // long the trails last, F.tox/F.toy the point it zooms and turns around.
  // C.prm[o..o+9] are the song's own constants for the scene, 0..1.

  // Spirograph: hypotrochoid pens that wander and turn; their parameters
  // drift, so the figure keeps changing.
  function spirograph(g, C, o) {
    var p = C.prm;
    var W = F.W;
    var H = F.H;
    var t = F.t;
    var pens = 2 + Math.round((0.6 + 1.6 * F.e) * F.amt);
    var n = Math.round(110 + 130 * F.amt);
    F.tz = 1.008; F.tr = (p[o + 5] > 0.5 ? 1 : -1) * 0.006; F.tdx = 0; F.tdy = 0;
    F.tdecay = 0.95 - 0.02 * F.e;
    F.tox = W * (0.5 + 0.22 * Math.sin(t * 0.07 + p[o] * 6.28));
    F.toy = H * (0.5 + 0.22 * Math.sin(t * 0.05 + p[o + 1] * 6.28));
    for (var j = 0; j < pens; j++) {
      var q = p[o + 2 + j] * 6.28;
      var r = 0.2 + 0.2 * (0.5 + 0.5 * Math.sin(t * 0.043 + q));
      var d = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.031 + q * 1.3));
      var k = (1 - r) / r;
      var cx = W * (0.5 + 0.3 * Math.sin(t * (0.11 + 0.03 * j) * F.sp + q));
      var cy = H * (0.5 + 0.27 * Math.sin(t * (0.083 + 0.02 * j) * F.sp + q * 2.1));
      var sc = H * (0.34 + 0.07 * F.kick) / (1 - r + d);
      var turn = t * (0.3 + 0.15 * j) * (j % 2 ? -1 : 1);
      var cr = Math.cos(turn);
      var sr = Math.sin(turn);
      var th0 = t * (1.6 + 1.6 * F.e) * F.sp + j * 2;
      var span = 6 + 5 * F.e;
      g.beginPath();
      for (var i = 0; i <= n; i++) {
        var th = th0 + span * i / n;
        var x = (1 - r) * Math.cos(th) + d * Math.cos(k * th);
        var y = (1 - r) * Math.sin(th) - d * Math.sin(k * th);
        var X = cx + sc * (x * cr - y * sr);
        var Y = cy + sc * (x * sr + y * cr);
        if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
      }
      g.strokeStyle = color(j, 0, F.alpha);
      g.lineWidth = F.s * (1.3 + 1.6 * F.e + 2.5 * F.kick);
      ink(g);
    }
  }

  function poly(g, cx, cy, r, n, star, a) {
    var m = star ? n * 2 : n;
    g.beginPath();
    for (var i = 0; i <= m; i++) {
      var rr = star && i % 2 ? r * 0.45 : r;
      var an = a + i * Math.PI * 2 / m;
      var x = cx + rr * Math.cos(an);
      var y = cy + rr * Math.sin(an);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
  }

  // Tunnel: rings of polygons or stars flying out from a wandering point,
  // each one a little turned from the last, so they read as the walls of a
  // twisting tunnel. Their sizes are worked out from the time (crisp at any
  // size); the feedback only adds a short trail.
  function tunnel(g, C, o) {
    var p = C.prm;
    var W = F.W;
    var H = F.H;
    var t = F.t;
    var sides = 3 + Math.floor(p[o] * 6);
    var star = p[o + 1] > 0.45;
    var dir = p[o + 4] > 0.5 ? 1 : -1;
    var cx = W * (0.5 + 0.3 * Math.sin(t * 0.13 * F.sp + p[o + 2] * 6.28));
    var cy = H * (0.5 + 0.28 * Math.sin(t * 0.1 * F.sp + p[o + 3] * 6.28));
    F.tox = cx; F.toy = cy; F.tz = 1.015; F.tr = 0.008 * dir; F.tdx = 0; F.tdy = 0; F.tdecay = 0.86;
    var rings = Math.round(5 + 4 * F.amt);
    var r0 = H * 0.025;
    var span = Math.log(Math.sqrt(W * W + H * H) / r0);   // from a dot to past the corners
    // One ring is born per beat; they speed up as they come closer.
    var travel = F.b / 2;
    var twist = 0.35 + 0.4 * p[o + 5];
    for (var i = 0; i < rings; i++) {
      var u = (travel + i / rings) % 1;       // 0 born, 1 gone
      var r = r0 * Math.exp(span * u * u);
      var n = Math.floor(travel + i / rings);  // which ring this is, for its turn and color
      poly(g, cx, cy, r, sides, star, dir * (t * 0.5 + n * twist));
      g.strokeStyle = color(n, 6 * F.kick, F.alpha * Math.min(1, u * (F.glow ? 8 : 4)) * (1 - u * 0.5) * (F.glow ? 0.85 : 1));
      g.lineWidth = F.s * (0.8 + 4 * u * u * (0.6 + 0.6 * F.e) + 1.5 * F.kick);
      ink(g);
    }
  }

  // Kaleidoscope: a few pens wander inside one wedge; each pen's last
  // moments are drawn as a curve in every wedge, mirrored, for 6- to 12-fold
  // symmetry. The feedback turns and pulls the strokes inward.
  function kaleidoscope(g, C, o) {
    var p = C.prm;
    var W = F.W;
    var H = F.H;
    var t = F.t;
    var n = 6 + 2 * Math.floor(p[o] * 4);
    var pens = 2 + Math.round(2 * F.e * F.amt);
    var steps = 10;
    var cx = W * (0.5 + 0.12 * Math.sin(t * 0.05 + p[o + 1] * 6.28));
    var cy = H * (0.5 + 0.1 * Math.sin(t * 0.04 + p[o + 2] * 6.28));
    F.tox = cx; F.toy = cy; F.tz = 0.985; F.tr = 0.01 * (p[o + 3] > 0.5 ? 1 : -1); F.tdx = 0; F.tdy = 0; F.tdecay = 0.93;
    var R = Math.sqrt(W * W + H * H) * 0.5;
    var X = C.lx;
    var Y = C.ly;
    for (var j = 0; j < pens; j++) {
      var q = p[o + 4 + (j % 4)] * 6.28 + j;
      var i;
      for (i = 0; i <= steps; i++) {
        var tt = (t - i * 0.05) * F.sp;
        var rad = R * (0.08 + 0.85 * (0.5 + 0.5 * Math.sin(tt * (0.5 + 0.13 * j) + q)));
        var ang = (Math.PI / n) * (0.5 + 0.5 * Math.sin(tt * (0.9 + 0.17 * j) + q * 1.7));
        X[i] = rad * Math.cos(ang);
        Y[i] = rad * Math.sin(ang);
      }
      g.beginPath();
      for (var k = 0; k < n; k++) {
        var a = k * 2 * Math.PI / n;
        var ca = Math.cos(a);
        var sa = Math.sin(a);
        for (i = 0; i <= steps; i++) {
          if (i) g.lineTo(cx + X[i] * ca - Y[i] * sa, cy + X[i] * sa + Y[i] * ca);
          else g.moveTo(cx + X[i] * ca - Y[i] * sa, cy + X[i] * sa + Y[i] * ca);
        }
        for (i = 0; i <= steps; i++) {
          if (i) g.lineTo(cx + X[i] * ca + Y[i] * sa, cy + X[i] * sa - Y[i] * ca);
          else g.moveTo(cx + X[i] * ca + Y[i] * sa, cy + X[i] * sa - Y[i] * ca);
        }
      }
      g.strokeStyle = color(j, 0, F.alpha);
      g.lineWidth = F.s * (1.4 + 1.6 * F.e + 2.5 * F.kick);
      ink(g);
    }
    if (F.onBeat) {
      g.beginPath();
      poly(g, cx, cy, R * (0.1 + 0.5 * rand(C)), n, true, t);
      g.strokeStyle = color(2, 12, 0.9);
      g.lineWidth = F.s * (1.5 + 2 * F.e);
      ink(g);
    }
  }

  // Ribbons: two or three waves across the whole screen (sums of sines at
  // the song's speed; not its sound), shifted up or down every frame by the
  // feedback, so they leave sheets like silk.
  function ribbons(g, C, o) {
    var p = C.prm;
    var W = F.W;
    var H = F.H;
    var t = F.t * F.sp;
    var lines = 2 + Math.round(F.e * F.amt);
    var segs = Math.round(36 + 28 * F.amt);
    var dir = p[o] > 0.5 ? -1 : 1;
    F.tox = W / 2; F.toy = H / 2; F.tz = 1.004; F.tr = 0;
    F.tdx = 0.8 * F.s * Math.sin(F.t * 0.2); F.tdy = dir * (1.4 + 1.4 * F.e) * F.s; F.tdecay = 0.965;
    for (var j = 0; j < lines; j++) {
      var base = H * (0.22 + 0.56 * (j + 0.5) / lines) + H * 0.14 * Math.sin(t * 0.13 + j * 2 + p[o + 1] * 6.28);
      var f1 = 0.7 + 1.6 * p[o + 2 + j];
      var f2 = 2.5 + 3 * p[o + 5 + j];
      var amp = H * (0.15 + 0.1 * F.kick);
      g.beginPath();
      for (var i = 0; i <= segs; i++) {
        var u = i / segs;
        var y = base + amp * Math.sin(u * 6.283 * f1 + t * (1.1 + 0.4 * j) + j) +
          H * 0.06 * Math.sin(u * 6.283 * f2 - t * 2.3 + j * 1.3);
        if (i) g.lineTo(u * W, y); else g.moveTo(0, y);
      }
      g.strokeStyle = color(j, 0, F.alpha);
      g.lineWidth = F.s * (1.5 + 1.5 * F.e + 2 * F.kick);
      ink(g);
    }
  }

  // Starburst: sparks thrown from a wandering point on each beat, swirled
  // by the feedback into a whirlpool, with rays on the beat.
  function starburst(g, C, o) {
    var p = C.prm;
    var w = C.parts;
    var W = F.W;
    var H = F.H;
    var t = F.t;
    var N = Math.round(PARTS * F.amt);
    var cx = W * (0.5 + 0.36 * Math.sin(t * 0.17 * F.sp + p[o] * 6.28));
    var cy = H * (0.5 + 0.33 * Math.sin(t * 0.13 * F.sp + p[o + 1] * 6.28));
    var dir = p[o + 2] > 0.5 ? 1 : -1;
    F.tox = cx; F.toy = cy; F.tz = 1.02; F.tr = 0.03 * dir; F.tdx = 0; F.tdy = 0; F.tdecay = 0.9;
    var emit = F.onBeat ? Math.round((14 + 34 * F.e) * F.amt) : (rand(C) < (F.glow ? 1.2 : 0.6) * Math.min(1, F.dt) ? (F.glow ? 4 : 2) : 0);
    var i;
    var b;
    for (i = 0; i < N && emit > 0; i++) {
      b = i * 5;
      if (w[b + 4] > 0) continue;
      var a = rand(C) * Math.PI * 2;
      var sp = F.s * (2.5 + 6 * rand(C)) * (0.7 + 0.6 * F.e) * (F.onBeat ? 1 : 0.5);
      w[b] = cx; w[b + 1] = cy; w[b + 2] = Math.cos(a) * sp; w[b + 3] = Math.sin(a) * sp; w[b + 4] = 1;
      emit -= 1;
    }
    for (var c = 0; c < 2; c++) {
      g.beginPath();
      for (i = c; i < N; i += 2) {
        b = i * 5;
        if (w[b + 4] <= 0) continue;
        g.moveTo(w[b] - w[b + 2] * 2.5, w[b + 1] - w[b + 3] * 2.5);
        g.lineTo(w[b], w[b + 1]);
      }
      g.strokeStyle = color(c, 8, F.alpha);
      g.lineWidth = F.s * (1.3 + 1.5 * F.e);
      ink(g);
    }
    if (F.onBeat) {
      var rays = 6 + Math.round(6 * F.e);
      var off = rand(C) * 6.28;
      g.beginPath();
      for (i = 0; i < rays; i++) {
        var an = off + i * Math.PI * 2 / rays;
        g.moveTo(cx + Math.cos(an) * H * 0.05, cy + Math.sin(an) * H * 0.05);
        g.lineTo(cx + Math.cos(an) * H * 0.3, cy + Math.sin(an) * H * 0.3);
      }
      g.strokeStyle = color(2, 14, 0.85);
      g.lineWidth = F.s * (1.5 + 1.5 * F.e);
      ink(g);
    }
    for (i = 0; i < N; i++) {
      b = i * 5;
      if (w[b + 4] <= 0) continue;
      if (C.sprites) stamp(g, C.sprites[i % 3], w[b], w[b + 1], F.s * (2.5 + 4 * w[b + 4]), (0.1 + 0.25 * w[b + 4]) * F.dt);
      w[b] += w[b + 2] * F.dt;
      w[b + 1] += w[b + 3] * F.dt;
      w[b + 2] *= 0.975;
      w[b + 3] *= 0.975;
      w[b + 4] -= 0.022 * F.dt;
      if (w[b] < -20 || w[b] > W + 20 || w[b + 1] < -20 || w[b + 1] > H + 20) w[b + 4] = 0;
    }
  }

  // Lattice: points on a rose curve (r = cos k theta) with k morphing,
  // joined across by chords like a turning wireframe, plus its outline.
  function lattice(g, C, o) {
    var p = C.prm;
    var W = F.W;
    var H = F.H;
    var t = F.t;
    var M = Math.round(48 + 40 * F.amt);
    var X = C.lx;
    var Y = C.ly;
    var kk = 2 + 3 * (0.5 + 0.5 * Math.sin(t * 0.045 * F.sp + p[o] * 6.28));
    var cx = W * (0.5 + 0.3 * Math.sin(t * 0.09 * F.sp + p[o + 1] * 6.28));
    var cy = H * (0.5 + 0.24 * Math.sin(t * 0.07 * F.sp + p[o + 2] * 6.28));
    F.tox = cx; F.toy = cy; F.tz = 0.99; F.tr = -0.007; F.tdx = 0; F.tdy = 0; F.tdecay = 0.9;
    var R = H * (0.4 + 0.08 * F.kick);
    var turn = t * 0.25 * F.sp * (p[o + 3] > 0.5 ? 1 : -1);
    var step = Math.max(2, Math.floor(M * (0.18 + 0.2 * (0.5 + 0.5 * Math.sin(t * 0.06 + p[o + 4] * 6.28)))));
    var i;
    for (i = 0; i < M; i++) {
      var th = 2 * Math.PI * i / M;
      var r = R * Math.cos(kk * th);
      X[i] = cx + r * Math.cos(th + turn) * 1.3;
      Y[i] = cy + r * Math.sin(th + turn);
    }
    var gl = F.glow;
    F.glow = false;       // many chords: a halo on each would only wash out
    for (var c = 0; c < 2; c++) {
      g.beginPath();
      for (i = c; i < M; i += 2) {
        var q = (i + step) % M;
        g.moveTo(X[i], Y[i]);
        g.lineTo(X[q], Y[q]);
      }
      g.strokeStyle = color(c * 2, 0, F.alpha * (gl ? 0.2 : 0.6));
      g.lineWidth = F.s * (0.8 + F.e);
      ink(g);
    }
    F.glow = gl;
    g.beginPath();
    for (i = 0; i <= M; i++) {
      if (i) g.lineTo(X[i % M], Y[i % M]); else g.moveTo(X[0], Y[0]);
    }
    g.strokeStyle = color(1, 10, F.alpha);
    g.lineWidth = F.s * (1.4 + 1.5 * F.e + 2 * F.kick);
    ink(g);
  }

  var DRAW = [spirograph, tunnel, kaleidoscope, ribbons, starburst, lattice];

  /* ---------- the glow level (CSS, compositor only) and the still wash ---------- */

  // Sets an animation, with the -webkit- spelling the TV may need.
  function animate(node, name, ms, timing, delay) {
    var a = name + ' ' + Math.round(ms) + 'ms ' + timing + ' ' + Math.round(delay) + 'ms infinite both';
    node.style.webkitAnimation = a;
    node.style.animation = a;
  }

  // The delay that puts an animation of length ms at `offset` into its cycle
  // when the song is at pos: a negative delay starts it part way through.
  function phaseDelay(pos, offset, ms) {
    var p = (pos - offset) % ms;
    if (p < 0) p += ms;
    return -p;
  }

  function buildScene(info, level, pal) {
    var P = params(info);
    var host = st.host;
    var W = host.clientWidth || 1920;
    var H = host.clientHeight || 1080;
    var rnd = seeded(info.id + '|place');
    var scene = el('div', 'npv-scene');
    scene.style.opacity = '0';
    var anim = [];
    var animated = level === 'glow';

    // The wash: an opaque base in the song's colors, deep but never black,
    // with soft light pooled where the picture is.
    var wash = el('div', 'npv-wash', scene);
    var deepA = deep(pal.dom, 0.25);
    var deepB = deep(pal.acc, 0.2);
    var lx = Math.round(info.center.x / W * 100);
    var ly = Math.round(info.center.y / H * 100);
    // A gentle shade under the words, from a little before them to the edge.
    var tx = clamp(Math.round((info.textLeft || W * 0.5) / W * 100), 20, 112);
    wash.style.backgroundColor = rgba(deepA, 1);     // solid: what is under it need not be drawn
    wash.style.backgroundImage =
      'linear-gradient(90deg, rgba(8,10,14,0) ' + (tx - 12) + '%, rgba(8,10,14,0.24) ' + tx + '%, rgba(8,10,14,0.32) ' + Math.max(100, tx) + '%),' +
      'radial-gradient(ellipse ' + Math.round(W * 0.55) + 'px ' + Math.round(H * 0.75) + 'px at ' + lx + '% ' + ly + '%, ' + rgba(pal.dom, 0.5) + ', ' + rgba(pal.dom, 0) + '),' +
      'radial-gradient(ellipse ' + Math.round(W * 0.5) + 'px ' + Math.round(H * 0.6) + 'px at 88% 8%, ' + rgba(pal.acc, 0.34) + ', ' + rgba(pal.acc, 0) + '),' +
      'radial-gradient(ellipse ' + Math.round(W * 0.55) + 'px ' + Math.round(H * 0.5) + 'px at 74% 104%, ' + rgba(pal.light, 0.16) + ', ' + rgba(pal.light, 0) + '),' +
      'linear-gradient(135deg, ' + rgba(deepA, 1) + ' 0%, ' + rgba(deepB, 1) + ' 100%)';

    // The glows: three soft orbs, placed by the song's own seed.
    var glows = el('div', 'npv-group npv-glows', scene);
    var colors = [pal.dom, pal.acc, pal.light];
    var alphas = [0.6, 0.5, 0.32];
    var size = Math.round(W * P.orbSize);
    for (var i = 0; i < 3; i++) {
      var orb = el('div', 'npv-orb', glows);
      var c = colors[i];
      orb.style.width = size + 'px';
      orb.style.height = size + 'px';
      // Spread across the screen: one near the picture, two over the rest.
      var cx = i === 0 ? info.center.x + (rnd() - 0.5) * W * 0.12 : W * (0.42 + rnd() * 0.5);
      var cy = i === 0 ? info.center.y + (rnd() - 0.5) * H * 0.2 : H * (i === 1 ? 0.15 + rnd() * 0.3 : 0.55 + rnd() * 0.35);
      orb.style.left = Math.round(cx - size / 2) + 'px';
      orb.style.top = Math.round(cy - size / 2) + 'px';
      orb.style.backgroundImage = 'radial-gradient(circle closest-side, ' + rgba(c, alphas[i]) + ' 0%, ' +
        rgba(c, alphas[i] * 0.55) + ' 45%, ' + rgba(c, 0) + ' 100%)';
      if (animated) {
        orb._offset = (i / 3 + rnd() * 0.1) * P.orbMs;
        orb._ms = P.orbMs;
        orb._name = 'npv-' + P.drift + '-' + (['a', 'b', 'c'])[Math.floor(rnd() * 3) % 3];
        anim.push(orb);
      } else {
        orb.style.opacity = '0.9';
      }
    }
    return { node: scene, glows: glows, anim: anim, P: P, level: level, id: info.id, pal: pal };
  }

  // (Re)starts every animation at the right point for the song's position.
  function align(scene, pos, running) {
    var a = scene.anim;
    var i;
    if (!a.length) return;
    for (i = 0; i < a.length; i++) { a[i].style.webkitAnimation = 'none'; a[i].style.animation = 'none'; }
    void scene.node.offsetWidth;   // one style flush, so the next line starts them afresh
    for (i = 0; i < a.length; i++) {
      animate(a[i], a[i]._name, a[i]._ms, 'linear', phaseDelay(pos, a[i]._offset, a[i]._ms));
      playState(a[i], running);
    }
  }

  function playState(node, running) {
    var s = running ? 'running' : 'paused';
    node.style.webkitAnimationPlayState = s;
    node.style.animationPlayState = s;
  }

  function applyStrength(force) {
    var sc = st.scene;
    if (!sc || !st.info) return;
    var s = arc(sc.P, position(), st.info.durationMs);
    if (!force && Math.abs(s - st.lastStrength) < 0.015) return;
    st.lastStrength = s;
    var glow = st.playing ? 0.62 + 0.38 * s : 0.7;
    sc.glows.style.opacity = String(Math.round(glow * 1000) / 1000);
  }

  function rebuild() {
    var info = st.info;
    st.sceneKey = keyOf(info);
    if (st.palettes[info.id]) { show(buildScene(info, st.level, colorsFor(info))); return; }
    var id = info.id;
    if (st.sampling[id]) return;                 // already asked: its answer builds the scene
    var asked = later(function () {
      // The picture is slow: use the mood's colors now, the picture's later.
      if (st.info && st.info.id === id && (!st.scene || st.scene.id !== id)) {
        show(buildScene(st.info, st.level, colorsFor(st.info)));
      }
    }, SAMPLE_WAIT_MS);
    sample(id, info.art, info.vibe, function (p, why) {
      st.problem = why || '';
      st.palettes[id] = p || { from: 'mood' };
      cancel(asked);
      if (!st.info || st.info.id !== id || !st.root || isCanvas(st.level)) return;
      // Already showing the mood's colors, and the picture gave none: keep them.
      if (!p && st.scene && st.scene.key === st.sceneKey) return;
      show(buildScene(st.info, st.level, colorsFor(st.info)));
    });
  }

  // Puts a new scene in, fading it over the old one.
  function show(scene) {
    var old = st.scene;
    scene.key = keyOf(st.info);
    st.scene = scene;
    st.lastStrength = -1;
    st.root.appendChild(scene.node);
    align(scene, position(), st.playing);
    applyStrength(true);
    void scene.node.offsetWidth;
    scene.node.style.webkitTransition = 'opacity ' + FADE_MS + 'ms linear';
    scene.node.style.transition = 'opacity ' + FADE_MS + 'ms linear';
    scene.node.style.opacity = '1';
    if (old) {
      st.leaving.push(old);
      later(function () {
        if (old.node.parentNode) old.node.parentNode.removeChild(old.node);
        var i = st.leaving.indexOf(old);
        if (i >= 0) st.leaving.splice(i, 1);
      }, FADE_MS + 100);
    }
    mark();
  }

  function removeScenes() {
    var list = st.root ? st.root.querySelectorAll('.npv-scene') : [];
    for (var i = 0; i < list.length; i++) list[i].parentNode.removeChild(list[i]);
    st.scene = null;
    st.sceneKey = '';
    st.leaving = [];
    if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
  }

  function setPlaying(playing) {
    var sc = st.scene;
    if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
    if (!sc) return;
    if (playing) {
      align(sc, position(), true);
    } else {
      st.restTimer = setTimeout(function () {
        st.restTimer = null;
        if (st.scene && !st.playing) for (var i = 0; i < st.scene.anim.length; i++) playState(st.scene.anim[i], false);
      }, REST_MS);
    }
    applyStrength(true);
  }

  /* ---------- levels and the frame-rate check ---------- */

  function decide(info) {
    var q = levelName(readQuery('viz'));
    if (q) return { level: q, source: 'URL' };
    var cfg = info.config || {};
    if (cfg.visualizer === false) return { level: 'off', source: 'config' };
    var c = typeof cfg.visualizer === 'string' ? levelName(cfg.visualizer) : null;
    if (c) return { level: c, source: 'config' };
    if (info.motionFade) return { level: 'wash', source: 'motion' };
    var kept = lsGet();
    if (kept) {
      st.fps = kept.fps || 0;
      st.measured = !!kept.settled;
      return { level: kept.level, source: 'auto' };
    }
    return { level: 'radiant', source: 'auto' };
  }

  // The level sync() would show for info (the page lays itself out by it).
  function plan(info) {
    if (!info) return 'off';
    var d = decide(info);
    if (d.level !== 'off' && st.root && d.source === 'auto' && st.source === 'auto') return st.level;
    return d.level;
  }

  // Times frames for two seconds, once the start is over: the canvas counts
  // the frames it really drew; the glow level only times frames (nothing
  // moves from here). A poor result is checked once more before stepping
  // down, as the hub's motion ladder does, so one hiccup costs nothing.
  function measure(again) {
    if (st.measured || st.source !== 'auto' || st.level === 'wash' || st.level === 'off') { st.measureStarted = false; return; }
    var level = st.level;
    later(function () {
      if (!st.root || document.hidden || !st.playing || st.level !== level) { st.measureStarted = false; return; }
      var C = st.cv;
      if (isCanvas(level)) {
        if (!C) { st.measureStarted = false; return; }
        C.mn = 0;
        C.measuring = true;
        later(function () {
          C.measuring = false;
          if (st.cv !== C || !st.playing || document.hidden) { st.measureStarted = false; return; }
          judge(C.mt, C.mn, again, (1000 / C.interval) * 0.8);
        }, TIMING.ms);
        return;
      }
      if (!window.requestAnimationFrame) return;
      var times = [];
      var start = 0;
      function tock(t) {
        st.measureRaf = 0;
        if (!st.root || document.hidden) { st.measureStarted = false; return; }
        if (!start) start = t;
        times.push(t);
        if (t - start < TIMING.ms) { st.measureRaf = requestAnimationFrame(tock); return; }
        judge(times, times.length, again, MIN_FPS);
      }
      st.measureRaf = requestAnimationFrame(tock);
    }, again ? TIMING.again : TIMING.after);
  }

  // Drawing a radiant frame is plainly too slow: down one step now, without
  // waiting for the frame-rate check.
  function quickStep(C) {
    if (st.cv !== C || st.level !== 'radiant' || st.measured || st.source !== 'auto') return;
    var next = LADDER.radiant;
    st.fps = 0;
    lsSet({ build: window.HUB_BUILD, level: next, fps: 0, settled: false });
    st.level = next;
    applyLevel();
    st.measureStarted = false;
    if (st.playing) { st.measureStarted = true; measure(); }
    mark();
  }

  function judge(times, n, again, minFps) {
    if (n < 3) { st.measureStarted = false; return; }
    var worst = 0;
    for (var i = 2; i < n; i++) worst = Math.max(worst, times[i] - times[i - 1]);
    var fps = Math.round((n - 2) * 1000 / Math.max(1, times[n - 1] - times[1]));
    st.fps = fps;
    var poor = st.forcePoor || fps < minFps || worst > MAX_GAP_MS;
    if (poor && !again) { mark(); measure(true); return; }
    if (poor) {
      var from = st.level;
      var next = LADDER[from] || 'wash';
      lsSet({ build: window.HUB_BUILD, level: next, fps: fps, settled: next === 'wash' });
      st.measured = next === 'wash';
      st.level = next;
      applyLevel();
      if (compact(from) !== compact(next)) relayout();
      if (!st.measured) measure();
    } else {
      st.measured = true;
      lsSet({ build: window.HUB_BUILD, level: st.level, fps: fps, settled: true });
    }
    mark();
  }

  // The page lays itself out again (a step down to the still wash brings
  // back the big picture).
  function relayout() {
    var info = st.info;
    if (!info || typeof info.relayout !== 'function') return;
    setTimeout(function () { try { info.relayout(); } catch (e) { warn(e); } }, 0);
  }

  function mark() {
    if (st.root) st.root.setAttribute('data-viz', st.level + (st.fps ? ' ' + st.fps + 'fps' : ''));
  }

  /* ---------- showing, updating, stopping ---------- */

  function ensureRoot(host) {
    if (st.root && st.host === host && st.root.parentNode === host) return;
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    stopCanvas();
    st.host = host;
    st.root = el('div', 'npv');
    host.insertBefore(st.root, host.firstChild);
    st.scene = null;
    st.sceneKey = '';
    st.leaving = [];
    listen();
  }

  function keyOf(info) {
    return info.id + '|' + vibeKey(info.vibe) + '|' + st.level;
  }

  // Shows what the level needs, for st.info.
  function applyLevel() {
    var info = st.info;
    if (isCanvas(st.level)) {
      removeScenes();
      var fresh = !st.cv || st.cv.cfg !== CANVAS[st.level];
      var C = startCanvas();
      if (fresh || C.id !== info.id || C.vkey !== vibeKey(info.vibe)) songSetup(C, info);
      if (st.playing) { C.restAt = 0; run(); } else if (fresh) { prime(C, position()); run(); }
      st.sceneKey = keyOf(info);
      mark();
      return;
    }
    stopCanvas();
    if (st.sceneKey !== keyOf(info)) rebuild();
  }

  function sync(host, info) {
    if (!host || !info || !info.id) { stop(); return false; }
    var d = decide(info);
    if (d.level === 'off') { stop(); st.level = 'off'; st.source = d.source; st.shown = true; return false; }
    // A level the frame-rate check chose stays for this showing.
    if (!st.root || d.source !== 'auto') { st.level = d.level; st.source = d.source; }
    var wasPlaying = st.playing;
    var prev = st.info;
    ensureRoot(host);
    st.shown = true;
    var pos = num(info.positionMs, 0);
    var expected = position();
    st.info = info;
    st.playing = !!info.playing;
    var newSong = !prev || prev.id !== info.id;
    var jumped = Math.abs(pos - expected) > 150;
    if (newSong || jumped || wasPlaying !== st.playing || (!st.scene && !st.cv)) {
      st.anchorPos = pos;
      st.anchorAt = now();
    }
    if (isCanvas(st.level)) {
      applyLevel();
    } else if (st.sceneKey !== keyOf(info)) {
      applyLevel();
    } else if (wasPlaying !== st.playing) {
      setPlaying(st.playing);
    } else {
      if (jumped && st.playing) align(st.scene, pos, true);
      applyStrength(false);
    }
    if (!st.measureStarted && st.playing) { st.measureStarted = true; measure(); }
    return true;
  }

  function tick(positionMs) {
    if (!st.root || !st.info) return;
    if (st.playing && Math.abs(num(positionMs, 0) - position()) > 400) {
      st.anchorPos = num(positionMs, 0);
      st.anchorAt = now();
      if (st.scene) align(st.scene, st.anchorPos, true);
    }
    if (st.scene) applyStrength(false);
  }

  function stop() {
    var i;
    for (i = 0; i < st.timers.length; i++) clearTimeout(st.timers[i]);
    st.timers = [];
    if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
    if (st.measureRaf && window.cancelAnimationFrame) cancelAnimationFrame(st.measureRaf);
    st.measureRaf = 0;
    stopCanvas();
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null;
    st.host = null;
    st.scene = null;
    st.sceneKey = '';
    st.leaving = [];
    if (st.info) st.lastInfo = st.info;   // the About row still names the last song's tempo
    st.info = null;
    st.playing = false;
    st.measureStarted = false;
  }

  // The page hidden (the TV went to another app): hold everything still.
  function listen() {
    if (st.listening || !document.addEventListener) return;
    st.listening = true;
    document.addEventListener('visibilitychange', function () {
      try {
        var i;
        if (document.hidden) {
          if (st.measureRaf && window.cancelAnimationFrame) cancelAnimationFrame(st.measureRaf);
          st.measureRaf = 0;
          if (st.cv && st.cv.raf && window.cancelAnimationFrame) { cancelAnimationFrame(st.cv.raf); st.cv.raf = 0; }
          if (st.cv) st.cv.measuring = false;
          if (st.scene) for (i = 0; i < st.scene.anim.length; i++) playState(st.scene.anim[i], false);
          st.measureStarted = false;
        } else if (st.root && st.playing) {
          if (st.cv) run();
          if (st.scene) align(st.scene, position(), true);
          if (!st.measureStarted) { st.measureStarted = true; measure(); }
        }
      } catch (e) { warn(e); }
    }, false);
  }

  function status() {
    if (!st.shown) return '';
    var parts = [NAMES[st.level] || st.level];
    if (st.level !== 'off') {
      if (st.fps) parts.push(st.fps + ' fps');
      else if (st.source === 'auto' && !st.measured && st.level !== 'wash') parts.push('measuring');
      var info = st.info || st.lastInfo;
      var v = info && info.vibe;
      if (info) {
        var bpm = v && v.tempo ? Math.round(v.tempo) + ' BPM' : '100 BPM';
        parts.push(bpm + (v ? (v.source === 'features' ? ' from features' : ' guessed from genres') : ' (no vibe)'));
      }
      if (st.cv && st.cv.avg) parts.push(Math.round(st.cv.avg * 10) / 10 + ' ms a frame');
      if (isCanvas(st.level) && st.lastScene) parts.push(st.lastScene);
    }
    var text = parts.join(', ');
    if (st.source !== 'auto') text += ' (' + st.source + ')';
    return text;
  }

  function debug() {
    var sc = st.scene;
    var C = st.cv;
    var P = C ? C.P : sc ? sc.P : null;
    return {
      level: st.level, source: st.source, fps: st.fps, shown: !!st.root, playing: st.playing,
      timers: st.timers.length + (st.restTimer ? 1 : 0) + (st.measureRaf ? 1 : 0) + (C && C.raf ? 1 : 0),
      canvas: !!C, loop: !!(C && C.raf), frames: C ? C.frames : 0, still: !!(C && C.still),
      size: C ? C.W + 'x' + C.H : '', bloom: !!(C && C.dg), ms: C ? Math.round(C.avg * 10) / 10 : 0, lighter: !!(C && C.cfg.lighter),
      scene: C && C.scene >= 0 ? SCENES[C.scene] : '',
      scenes: st.root ? st.root.querySelectorAll('.npv-scene').length : 0,
      layers: st.root ? st.root.querySelectorAll('.npv-scene > *, .npv-orb, .npv-canvas').length : 0,
      id: C ? C.id : sc ? sc.id : '', palette: C ? C.palFrom : sc ? sc.pal.from : '',
      tempo: P ? P.tempo : 0, pulseMs: P ? Math.round(P.pulseMs) : 0, phraseBeats: P ? phraseLen(P) : 0,
      sharp: P ? Math.round(P.sharp * 100) / 100 : 0,
      orbMs: P ? Math.round(P.orbMs) : 0, drift: P ? P.drift : '', problem: st.problem,
      vibe: st.info ? st.info.vibe || null : null, position: Math.round(position())
    };
  }

  function guard(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { warn(e); try { stop(); } catch (e2) { /* nothing more */ } return undefined; }
    };
  }

  window.HUB_NP_VIZ = {
    plan: function (info) { try { return plan(info); } catch (e) { return 'off'; } },
    compact: compact,
    sync: guard(sync),
    tick: guard(tick),
    status: function () { try { return status(); } catch (e) { return ''; } },
    debug: debug,
    palette: function (id) { return st.palettes[id] || null; },
    sceneAt: function (id, vibe, pos) {
      var P = params({ id: id, vibe: vibe || null });
      return SCENES[sceneIndex(orderFor(id, P), P, pos)];
    },
    SCENES: SCENES.slice(),
    // Tests only.
    test: {
      phraseBeats: function (n) { st.phraseBeats = n > 0 ? n : 0; },
      forcePoor: function (on) { st.forcePoor = !!on; },
      scene: function (name) { st.forceScene = SCENES.indexOf(name); },
      timing: function (o) { for (var k in o) if (Object.prototype.hasOwnProperty.call(TIMING, k)) TIMING[k] = o[k]; }
    }
  };
})();
