/*
 * The music visualizer behind the full screen Now Playing page.
 *
 * Soft color fields from the album picture, moving with the song: glows that
 * breathe and drift, a halo that pulses behind the picture, and rings that
 * ripple out from it on the beat, all set by the song's "vibe" (tempo,
 * energy, mood, danceability, acousticness), which the Pi looks up (see
 * pi/vibe.js). Only the full screen page has it; the tile and the smaller
 * page stay as they are.
 *
 * Built for a slow TV:
 *   - Only transform and opacity move, on at most ten layers, each one a
 *     pre-drawn radial gradient. No filters, no blur, no blend modes.
 *   - The movement is CSS keyframe animation run by the compositor, with
 *     durations worked out from the tempo and negative delays that line the
 *     rhythm up with the song's position. No JavaScript runs per frame. A
 *     once-a-second call (the page's own tick) eases the overall strength
 *     over the song, through an opacity transition.
 *   - A two second frame-rate check after it starts steps down from rings +
 *     glows to glows only, then to a still wash, and remembers that for this
 *     build. On the plainest motion setting ('fade') it starts at the still
 *     wash.
 *
 * Spotify gives no beat grid, so beats are counted from the song's start at
 * its tempo: the pulse runs at the song's speed, not exactly on its beats.
 *
 * Plain ES5. window.HUB_NP_VIZ:
 *   sync(host, info)   show, update in place, or (info null) stop; true
 *                      while it shows.
 *                      info: { id, art, vibe, playing, positionMs, durationMs,
 *                      config, motionFade, center: {x, y, size}, textLeft }
 *   tick(positionMs)   the song's position now (the slow strength curve)
 *   status()           one line for the About panel, '' before the first show
 *   debug()            what runs now (tests)
 *   palette(id)        the colors used for a song (tests)
 */
(function () {
  'use strict';

  var STORE_KEY = 'homeHub.npViz';
  var LEVELS = ['off', 'wash', 'glow', 'full'];
  var NAMES = { full: 'rings + glows', glow: 'glows', wash: 'still wash', off: 'off' };
  var FADE_MS = 1400;          // a new song's colors cross-fade over this long
  var REST_MS = 1300;          // pausing: the beat fades out (1.2 s), then everything stops
  var MEASURE_AFTER_MS = 3500; // the frame-rate check starts this long after showing...
  var MEASURE_MS = 2000;       // ...runs this long...
  var MEASURE_AGAIN_MS = 800;  // ...and, when poor, once more this long after
  var MIN_FPS = 24;
  var MAX_GAP_MS = 250;
  var SAMPLE_WAIT_MS = 700;    // wait this long for the album colors before using a fallback

  var st = {
    host: null, root: null, scene: null, leaving: [],
    level: 'full', source: 'auto', fps: 0, measured: false,
    info: null, anchorAt: 0, anchorPos: 0, playing: false,
    palettes: {}, sampling: {}, problem: '',
    timers: [], measureRaf: 0, restTimer: null, waitTimer: null,
    shown: false, lastStrength: -1, listening: false
  };

  /* ---------- small helpers ---------- */

  function now() { return new Date().getTime(); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

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

  /* ---------- the song's look, from its vibe ---------- */

  function params(info, level) {
    var v = info.vibe;
    var tempo = v && v.tempo >= 40 && v.tempo <= 220 ? v.tempo : 100;
    // No vibe: a calm middle (slow glows, no rings).
    var energy = v ? v.energy : 0.4;
    var valence = v ? v.valence : 0.55;
    var dance = v ? v.dance : 0.4;
    var acoustic = v ? v.acoustic : 0.4;
    var beat = 60000 / tempo;
    // Pulses never come faster than 2.5 a second; a fast song pulses every
    // second beat.
    var pulseBeats = tempo > 140 ? 2 : 1;
    while (beat * pulseBeats < 400) pulseBeats *= 2;
    var pulseMs = beat * pulseBeats;
    var ringDrive = clamp(0.55 * dance + 0.65 * energy - 0.45 * acoustic - 0.2, 0, 1);
    var rings = level === 'full' && ringDrive >= 0.12 ? 2 : 0;
    // A weak drive: fewer, slower, fainter rings.
    var ringEvery = ringDrive > 0.5 ? pulseMs : pulseMs * 2;
    while (ringEvery < 700) ringEvery *= 2;
    // The glows' slow cycle: a whole number of 8-beat phrases, 9 to 20 s.
    var cycleBeats = 8;
    while (cycleBeats * beat < 9000 && cycleBeats < 128) cycleBeats *= 2;
    var rnd = seeded(info.id + '|look');
    return {
      tempo: tempo, beat: beat, pulseBeats: pulseBeats, pulseMs: pulseMs,
      energy: energy, valence: valence, dance: dance, acoustic: acoustic,
      rings: rings, ringEvery: ringEvery, ringDrive: ringDrive,
      crisp: clamp(dance * 1.2 - acoustic * 0.5, 0, 1),
      bloom: level === 'full' && energy >= 0.3 ? (energy >= 0.8 ? 3 : energy >= 0.55 ? 2 : 1) : 0,
      drift: valence >= 0.58 ? 'rise' : valence <= 0.38 ? 'sink' : 'side',
      orbMs: cycleBeats * beat,
      orbSize: 0.36 + 0.14 * (1 - energy),
      phraseBeats: tempo >= 110 ? 32 : 16,
      wavePhase: rnd() * Math.PI * 2,
      animated: level === 'full' || level === 'glow'
    };
  }

  function vibeKey(v) {
    return v ? [v.source, v.tempo, v.energy, v.valence, v.dance, v.acoustic].join(',') : 'none';
  }

  /* ---------- building a scene ---------- */

  // Sets an animation, with the -webkit- spelling the TV may need.
  function animate(node, name, ms, timing, delay) {
    var a = name + ' ' + Math.round(ms) + 'ms ' + timing + ' ' + Math.round(delay) + 'ms infinite both';
    node.style.webkitAnimation = a;
    node.style.animation = a;
    node._anim = { name: name, ms: ms, timing: timing };
  }

  // The delay that puts an animation of length ms at `offset` into its cycle
  // when the song is at pos: a negative delay starts it part way through.
  function phaseDelay(pos, offset, ms) {
    var p = (pos - offset) % ms;
    if (p < 0) p += ms;
    return -p;
  }

  function buildScene(info, level, pal) {
    var P = params(info, level);
    var host = st.host;
    var W = host.clientWidth || 1920;
    var H = host.clientHeight || 1080;
    var rnd = seeded(info.id + '|place');
    var scene = el('div', 'npv-scene');
    scene.style.opacity = '0';
    var anim = [];

    // The wash: an opaque base in the song's colors, deep but never black,
    // with soft light pooled on the left, where the picture is.
    var wash = el('div', 'npv-wash', scene);
    var deepA = deep(pal.dom, 0.25);
    var deepB = deep(pal.acc, 0.2);
    var lx = Math.round(info.center.x / W * 100);
    // A gentle shade under the words, from a little before them to the edge.
    var tx = clamp(Math.round((info.textLeft || W * 0.5) / W * 100), 20, 90);
    wash.style.backgroundColor = rgba(deepA, 1);     // solid: what is under it need not be drawn
    wash.style.backgroundImage =
      'linear-gradient(90deg, rgba(8,10,14,0) ' + (tx - 12) + '%, rgba(8,10,14,0.24) ' + tx + '%, rgba(8,10,14,0.32) 100%),' +
      'radial-gradient(ellipse ' + Math.round(W * 0.55) + 'px ' + Math.round(H * 0.75) + 'px at ' + lx + '% 52%, ' + rgba(pal.dom, 0.5) + ', ' + rgba(pal.dom, 0) + '),' +
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
      if (P.animated) {
        var path = 'npv-' + P.drift + '-' + (['a', 'b', 'c'])[Math.floor(rnd() * 3) % 3];
        orb._offset = (i / 3 + rnd() * 0.1) * P.orbMs;
        orb._ms = P.orbMs;
        orb._name = path;
        orb._timing = 'linear';
        anim.push(orb);
      } else {
        orb.style.opacity = '0.9';
      }
    }

    // The beat: a halo behind the picture and rings from it.
    var beat = null;
    if (P.bloom || P.rings) {
      beat = el('div', 'npv-group npv-beat', scene);
      var art = info.center.size || Math.min(W, H) * 0.5;
      if (P.bloom) {
        var bloom = el('div', 'npv-bloom', beat);
        var bs = Math.round(art * 1.32);
        bloom.style.width = bs + 'px';
        bloom.style.height = bs + 'px';
        bloom.style.left = Math.round(info.center.x - bs / 2) + 'px';
        bloom.style.top = Math.round(info.center.y - bs / 2) + 'px';
        // Only its rim shows around the picture.
        bloom.style.backgroundImage = 'radial-gradient(circle closest-side, ' + rgba(pal.light, 0.6) + ' 70%, ' +
          rgba(pal.acc, 0.32) + ' 84%, ' + rgba(pal.acc, 0) + ' 100%)';
        bloom._offset = 0;
        bloom._ms = P.pulseMs;
        bloom._name = 'npv-pulse-' + P.bloom;
        bloom._timing = 'cubic-bezier(0.2, 0.7, 0.3, 1)';
        anim.push(bloom);
      }
      if (P.rings) {
        // Drawn at the largest size it reaches, so it is never rastered larger.
        var rs = Math.round(Math.min(art * 1.5, W * 0.8));
        // Crisp for a dance song: a thin bright band. Soft otherwise.
        var mid = 88;
        var half = Math.round(lerp(9, 3, P.crisp));
        var ringA = lerp(0.4, 0.72, P.crisp);
        var ringMs = P.ringEvery * P.rings;
        for (var k = 0; k < P.rings; k++) {
          var ring = el('div', 'npv-ring', beat);
          ring.style.width = rs + 'px';
          ring.style.height = rs + 'px';
          ring.style.left = Math.round(info.center.x - rs / 2) + 'px';
          ring.style.top = Math.round(info.center.y - rs / 2) + 'px';
          ring.style.backgroundImage = 'radial-gradient(circle closest-side, ' + rgba(pal.light, 0) + ' ' + (mid - half) + '%, ' +
            rgba(pal.light, ringA) + ' ' + mid + '%, ' + rgba(pal.acc, ringA * 0.4) + ' ' + (mid + Math.round(half * 0.6)) + '%, ' +
            rgba(pal.acc, 0) + ' ' + Math.min(100, mid + half) + '%)';
          ring._offset = k * P.ringEvery;
          ring._ms = ringMs;
          ring._name = 'npv-ring';
          ring._timing = 'cubic-bezier(0.1, 0.55, 0.35, 1)';
          anim.push(ring);
        }
      }
    }
    return { node: scene, glows: glows, beat: beat, anim: anim, P: P, level: level, id: info.id, pal: pal };
  }

  // (Re)starts every animation at the right point for the song's position.
  function align(scene, pos, running) {
    var a = scene.anim;
    var i;
    if (!a.length) return;
    for (i = 0; i < a.length; i++) { a[i].style.webkitAnimation = 'none'; a[i].style.animation = 'none'; }
    void scene.node.offsetWidth;   // one style flush, so the next line starts them afresh
    for (i = 0; i < a.length; i++) {
      animate(a[i], a[i]._name, a[i]._ms, a[i]._timing, phaseDelay(pos, a[i]._offset, a[i]._ms));
      playState(a[i], running);
    }
  }

  function playState(node, running) {
    var s = running ? 'running' : 'paused';
    node.style.webkitAnimationPlayState = s;
    node.style.animationPlayState = s;
  }

  /* ---------- strength over the song ---------- */

  // 0..1: eases in over the first 8 %, swells and settles in long phrases,
  // and calms over the last 6 %.
  function strength(scene, pos, dur) {
    var P = scene.P;
    var f = dur ? clamp(pos / dur, 0, 1) : 0.3;
    var inA = smooth(0, 0.08, f);
    var outA = 1 - 0.55 * smooth(0.94, 1, f);
    var beats = pos / P.beat;
    var wave = 0.8 + 0.2 * Math.sin(2 * Math.PI * beats / (P.phraseBeats * 2) + P.wavePhase);
    return clamp((0.3 + 0.7 * inA) * wave * outA, 0, 1);
  }

  function applyStrength(force) {
    var sc = st.scene;
    if (!sc || !st.info) return;
    var pos = position();
    var s = strength(sc, pos, st.info.durationMs);
    if (!force && Math.abs(s - st.lastStrength) < 0.015) return;
    st.lastStrength = s;
    var glow = st.playing ? 0.62 + 0.38 * s : 0.7;
    sc.glows.style.opacity = String(Math.round(glow * 1000) / 1000);
    if (sc.beat) {
      var b = st.playing ? (0.35 + 0.65 * sc.P.ringDrive) * (0.25 + 0.75 * s) : 0;
      if (!sc.P.rings) b = st.playing ? 0.45 + 0.4 * s : 0;
      sc.beat.style.opacity = String(Math.round(b * 1000) / 1000);
    }
  }

  function position() {
    if (!st.playing) return st.anchorPos;
    return st.anchorPos + Math.max(0, now() - st.anchorAt);
  }

  /* ---------- levels and the frame-rate check ---------- */

  function decide(info) {
    var q = readQuery('viz');
    if (q && LEVELS.indexOf(q) >= 0) return { level: q, source: 'URL' };
    var cfg = info.config || {};
    if (cfg.visualizer === false) return { level: 'off', source: 'config' };
    if (typeof cfg.visualizer === 'string' && LEVELS.indexOf(cfg.visualizer) >= 0) return { level: cfg.visualizer, source: 'config' };
    if (info.motionFade) return { level: 'wash', source: 'motion' };
    var kept = lsGet();
    if (kept) {
      st.fps = kept.fps || 0;
      st.measured = !!kept.settled;
      return { level: kept.level, source: 'auto' };
    }
    return { level: 'full', source: 'auto' };
  }

  // Times frames (only times them: nothing moves from here) for two
  // seconds, once the first drawing and the cross-fade are over. A poor
  // result is checked once more before stepping down, as the hub's motion
  // ladder does, so one hiccup does not cost the rings.
  function measure(again) {
    if (st.measured || st.source !== 'auto' || st.level === 'wash' || st.level === 'off' || !window.requestAnimationFrame) return;
    var level = st.level;
    later(function () {
      if (!st.root || document.hidden || !st.playing || st.level !== level) { st.measureStarted = false; return; }
      var times = [];
      var start = 0;
      function frame(t) {
        st.measureRaf = 0;
        if (!st.root || document.hidden) { st.measureStarted = false; return; }
        if (!start) start = t;
        times.push(t);
        if (t - start < MEASURE_MS) { st.measureRaf = requestAnimationFrame(frame); return; }
        judge(times, again);
      }
      st.measureRaf = requestAnimationFrame(frame);
    }, again ? MEASURE_AGAIN_MS : MEASURE_AFTER_MS);
  }

  function judge(times, again) {
    if (times.length < 3) return;
    var worst = 0;
    for (var i = 2; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1]);
    var fps = Math.round((times.length - 2) * 1000 / (times[times.length - 1] - times[1]));
    st.fps = fps;
    var level = st.level;
    var poor = fps < MIN_FPS || worst > MAX_GAP_MS;
    if (poor && !again) { mark(); measure(true); return; }
    if (poor) {
      level = level === 'full' ? 'glow' : 'wash';
      lsSet({ build: window.HUB_BUILD, level: level, fps: fps, settled: level === 'wash' });
      st.measured = level === 'wash';
      st.level = level;
      if (st.info) rebuild();
      if (!st.measured) measure();
    } else {
      st.measured = true;
      lsSet({ build: window.HUB_BUILD, level: level, fps: fps, settled: true });
    }
    mark();
  }

  function mark() {
    if (st.root) st.root.setAttribute('data-viz', st.level + (st.fps ? ' ' + st.fps + 'fps' : ''));
  }

  /* ---------- showing, updating, stopping ---------- */

  function ensureRoot(host) {
    if (st.root && st.host === host && st.root.parentNode === host) return;
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.host = host;
    st.root = el('div', 'npv');
    host.insertBefore(st.root, host.firstChild);
    st.scene = null;
    st.leaving = [];
    listen();
  }

  function keyOf(info) {
    return info.id + '|' + vibeKey(info.vibe) + '|' + st.level;
  }

  // The colors for the song now: the picture's (kept per song, as read),
  // or the mood's; tuned with the vibe known now.
  function colorsFor(info) {
    var raw = st.palettes[info.id];
    return finish(raw && raw.from === 'art' ? raw : fallbackPalette(info.vibe), info.vibe);
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
      if (!st.info || st.info.id !== id || !st.root) return;
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

  function setPlaying(playing) {
    var sc = st.scene;
    if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
    if (!sc) return;
    if (playing) {
      align(sc, position(), true);
    } else {
      // The beat fades out first, then everything holds still.
      st.restTimer = setTimeout(function () {
        st.restTimer = null;
        if (st.scene && !st.playing) for (var i = 0; i < st.scene.anim.length; i++) playState(st.scene.anim[i], false);
      }, REST_MS);
    }
    applyStrength(true);
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
    var newSong = !prev || prev.id !== info.id || !st.scene;
    if (newSong || Math.abs(pos - expected) > 150 || wasPlaying !== st.playing) {
      st.anchorPos = pos;
      st.anchorAt = now();
    }
    if (st.sceneKey !== keyOf(info)) {
      rebuild();
      if (!st.measureStarted) { st.measureStarted = true; measure(); }
      return true;
    }
    if (wasPlaying !== st.playing) { setPlaying(st.playing); return true; }
    if (Math.abs(pos - expected) > 150 && st.playing) align(st.scene, pos, true);
    applyStrength(false);
    return true;
  }

  function tick(positionMs) {
    if (!st.root || !st.scene || !st.info) return;
    if (st.playing && Math.abs(num(positionMs, 0) - position()) > 400) {
      st.anchorPos = num(positionMs, 0);
      st.anchorAt = now();
      align(st.scene, st.anchorPos, true);
    }
    applyStrength(false);
  }

  function stop() {
    var i;
    for (i = 0; i < st.timers.length; i++) clearTimeout(st.timers[i]);
    st.timers = [];
    if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
    if (st.measureRaf && window.cancelAnimationFrame) cancelAnimationFrame(st.measureRaf);
    st.measureRaf = 0;
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
        if (!st.scene) return;
        var i;
        if (document.hidden) {
          if (st.measureRaf && window.cancelAnimationFrame) cancelAnimationFrame(st.measureRaf);
          st.measureRaf = 0;
          for (i = 0; i < st.scene.anim.length; i++) playState(st.scene.anim[i], false);
        } else if (st.playing) {
          align(st.scene, position(), true);
        }
      } catch (e) { warn(e); }
    }, false);
  }

  function status() {
    if (!st.shown) return '';
    var name = NAMES[st.level] || st.level;
    var parts = [name];
    if (st.level !== 'off') {
      if (st.fps) parts.push(st.fps + ' fps');
      else if (st.source === 'auto' && !st.measured && st.level !== 'wash') parts.push('measuring');
      var info = st.info || st.lastInfo;
      var v = info && info.vibe;
      if (info) {
        var bpm = v && v.tempo ? Math.round(v.tempo) + ' BPM' : '100 BPM';
        parts.push(bpm + (v ? (v.source === 'features' ? ' from features' : ' guessed from genres') : ' (no vibe)'));
      }
    }
    var text = parts.join(', ');
    if (st.source !== 'auto') text += ' (' + st.source + ')';
    return text;
  }

  function debug() {
    var sc = st.scene;
    return {
      level: st.level, source: st.source, fps: st.fps, shown: !!st.root, playing: st.playing,
      timers: st.timers.length + (st.restTimer ? 1 : 0) + (st.measureRaf ? 1 : 0),
      scenes: st.root ? st.root.querySelectorAll('.npv-scene').length : 0,
      layers: st.root ? st.root.querySelectorAll('.npv-scene > *, .npv-orb, .npv-ring, .npv-bloom').length : 0,
      id: sc ? sc.id : '', palette: sc ? sc.pal.from : '',
      tempo: sc ? sc.P.tempo : 0, pulseMs: sc ? Math.round(sc.P.pulseMs) : 0, rings: sc ? sc.P.rings : 0,
      ringEvery: sc ? Math.round(sc.P.ringEvery) : 0, orbMs: sc ? Math.round(sc.P.orbMs) : 0,
      bloom: sc ? sc.P.bloom : 0, drift: sc ? sc.P.drift : '', problem: st.problem
    };
  }

  function guard(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { warn(e); try { stop(); } catch (e2) { /* nothing more */ } return undefined; }
    };
  }

  window.HUB_NP_VIZ = {
    sync: guard(sync),
    tick: guard(tick),
    status: function () { try { return status(); } catch (e) { return ''; } },
    debug: debug,
    palette: function (id) { return st.palettes[id] || null; },
    // Tests only: what the visualizer animates.
    PROPERTIES: ['transform', 'opacity']
  };
})();
