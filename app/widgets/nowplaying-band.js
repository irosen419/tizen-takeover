/*
 * Ian and Ember on the Now Playing page: the clay puppets come out and play
 * along while a song plays (docs/band.md).
 *
 * Two kinds of visit, picked by nowplaying.js from what the page shows:
 *
 *   - stage: full screen with the visualizer moving and the small card in
 *     the upper left. A stage floor rises along the bottom with footlights
 *     and spotlights, and one of the scenes plays: "band" (Ian on drums,
 *     Ember on guitar), "singer" (Ember at the mic, Ian on drums), "encore"
 *     (a clay backing band behind them, Ian's knee-slide air guitar, Ember
 *     howling into a mic) or "outfit" (both dressed for the song's genre,
 *     with a "Dressed for punk" chip on the card while it plays).
 *   - corner: the expanded page, or full screen without the visualizer. The
 *     two stand small on the panel's bottom edge, in the free corner right
 *     of the chips and the button: "headphones" (both nodding along) or
 *     "dance". Never over a word or a button; no room, no visit.
 *
 * A visit starts once the song plays and the remote has been left alone for
 * a few seconds, lasts about half a minute, and the next comes a minute or
 * so later. Any key, a pause, the page closing or changing sends them off at
 * once. A song in a new genre brings the outfit scene a few seconds later.
 * They bounce on the song's tempo (the vibe's BPM when known); they don't
 * follow the beats themselves.
 *
 * Light on the TV, like the wanderers (app/clay.js): nothing loads until the
 * first visit, then app/clay/music.js (the sprite list) and that scene's
 * pictures. Only transform and opacity move (CSS animations); no filters
 * (the backing band is darkened in its pictures). The backing band, the
 * spotlights and the notes come only at the visualizer's richer levels
 * (radiant, sharp), so a slow TV gets just the two of them. Reduced motion
 * (prefers-reduced-motion) keeps them still, with fades only. Chrome 52 safe (the
 * tablet): no grid, no flex gap, no clip-path.
 *
 * Off: HUB_CONFIG.widgets.nowplaying.band false, or ?band=off.
 * window.HUB_NP_BAND = { sync(host, info), stop(), status(), outfit(), test }.
 */
(function () {
  'use strict';

  var QUIET_MS = 6000;          // the remote left alone this long before a visit
  var FIRST_MS = 5000;          // the first visit, this long after the page opens
  var STAGE_MS = 30000;         // a stage visit
  var CORNER_MS = 18000;        // a corner visit
  var STAGE_GAP = [40, 80];     // seconds between stage visits
  var CORNER_GAP = [60, 120];   // seconds between corner visits
  var OUTFIT_SOON_MS = 3000;    // a new genre's outfit comes this soon (once quiet)
  var LOAD_MS = 20000;          // pictures for a scene, or it is skipped
  var OUT_MS = 450;             // the fade out
  var CHECK_MS = 1000;
  var RICH = { radiant: 1, sharp: 1 };   // visualizer levels with room for the extras

  var M = null;                 // CLAY_MUSIC once loaded
  var listLoading = false;
  var listFailedAt = 0;
  var host = null;              // the panel element the layer goes in
  var info = null;              // the last info from nowplaying.js
  var scene = null;             // { name, layer, endAt, out, chip, hold }
  var dueAt = 0;
  var lastKey = 0;
  var timer = null;
  var cancelLoad = null;
  var lastScene = { stage: '', corner: '' };
  var outfitShown = '';         // the track id whose outfit scene has played
  var lastOutfit = '';
  var gen = 0;                  // counts leaves: a load from before one is dropped
  var visits = 0;
  var problem = '';

  function now() { return new Date().getTime(); }
  function between(a, b) { return a + Math.random() * (b - a); }
  function readQuery(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function off(cfg) { return readQuery('band') === 'off' || (cfg && cfg.band === false); }
  function lessMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  /* ---------- outfits ---------- */

  // Spotify's artist genres (up to eight words) to one outfit. Order matters:
  // "pop punk" is punk, "country rock" is country. The artist list in the
  // config wins ({ "Green Day": "punk" }).
  var OUTFITS = ['punk', 'rock', 'country', 'hiphop', 'synth'];
  var FIT_ART = { rock: 'grunge' };   // the outfit's pictures, when named otherwise
  var RULES = [
    ['punk', /punk|emo\b|\bska\b/],
    ['country', /country|americana|bluegrass|honky|outlaw/],
    ['hiphop', /hip hop|hip-hop|\brap\b|trap\b|drill|r&b|grime/],
    ['synth', /synth|new wave|\b80s\b|disco|electro|edm|house|techno|dance pop|italo/],
    ['rock', /grunge|metal|rock|hardcore|alternative|\balt\b|garage|shoegaze/]
  ];
  function outfitFor(genres, artist, overrides) {
    var o = overrides && typeof overrides === 'object' ? overrides : null;
    if (o && artist) {
      for (var k in o) {
        if (o.hasOwnProperty(k) && String(k).toLowerCase() === String(artist).toLowerCase() && OUTFITS.indexOf(o[k]) >= 0) return o[k];
      }
    }
    var list = genres && genres.length ? genres : [];
    for (var r = 0; r < RULES.length; r++) {
      for (var i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string' && RULES[r][1].test(list[i].toLowerCase())) return RULES[r][0];
      }
    }
    return '';
  }

  /* ---------- loading ---------- */

  function loadList(cb) {
    if (M) { cb(true); return; }
    if (window.CLAY_MUSIC && window.CLAY_MUSIC.sprites) { M = window.CLAY_MUSIC; cb(true); return; }
    if (listLoading || now() - listFailedAt < 60000) { cb(false); return; }
    listLoading = true;
    var s = document.createElement('script');
    var done = false;
    var guard = setTimeout(function () { finish(false); }, LOAD_MS);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(guard);
      listLoading = false;
      if (ok && window.CLAY_MUSIC && window.CLAY_MUSIC.sprites) M = window.CLAY_MUSIC;
      else { listFailedAt = now(); problem = 'sprite list did not load'; }
      cb(!!M);
    }
    s.onload = function () { finish(true); };
    s.onerror = function () { finish(false); };
    s.src = 'clay/music.js';
    (document.head || document.body).appendChild(s);
  }

  function preload(keys, cb) {
    var left = keys.length;
    var done = false;
    var imgs = {};
    var guard = setTimeout(function () { end(false, 'pictures took too long'); }, LOAD_MS);
    function end(ok, why) {
      if (done) return;
      done = true;
      clearTimeout(guard);
      if (!ok) problem = why;
      cb(ok ? imgs : null);
    }
    if (!left) { setTimeout(function () { end(true); }, 0); }
    for (var i = 0; i < keys.length; i++) {
      (function (key) {
        var src = spriteSrc(key);
        if (!src) { setTimeout(function () { end(false, 'no picture ' + key); }, 0); return; }
        var im = new Image();
        im.onload = function () { imgs[key] = im; left -= 1; if (!left) end(true); };
        im.onerror = function () { end(false, 'picture failed: ' + key); };
        im.src = src;
      })(keys[i]);
    }
    return function () { done = true; clearTimeout(guard); };
  }

  function spriteSrc(key) {
    if (key === 'note' || key === 'star') return 'clay/sprites/props/' + key + '.webp';
    var s = M && M.sprites[key];
    return s ? 'clay/' + s.file : null;
  }
  function size(key) {
    if (key === 'note') return { w: 19, h: 26 };
    if (key === 'star') return { w: 24, h: 24 };
    var s = M && M.sprites[key];
    return s ? { w: s.w, h: s.h } : null;
  }

  /* ---------- scenes ---------- */

  // Each scene returns its cast: [{ key, x (0-1 of the width, or px when px),
  // z (zoom against the stage's own), move, delay, back }], plus extras.
  var SCENES = {
    band: function (o) {
      return { cast: [
        { key: 'ian/drums', x: 0.37, z: 1, move: 'hit' },
        { key: 'ember/guitar', x: 0.6, z: 1.15, move: 'lean', delay: 0.25 }
      ], spots: [0.37, 0.6] };
    },
    singer: function (o) {
      return { cast: [
        { key: 'ian/drums', x: 0.3, z: 0.9, move: 'hit' },
        { key: 'ember/mic', x: 0.52, z: 1.2, move: 'bob' }
      ], spots: [0.52], pool: 0.52 };
    },
    encore: function (o) {
      var cast = [
        { key: 'ian/air-guitar', x: 0.46, z: 1.05, move: 'lean' },
        { key: 'ember/howl-mic', x: 0.58, z: 1.15, move: 'bob', delay: 0.25 }
      ];
      if (o.rich) {
        cast.unshift({ key: 'band/bass', x: 0.13, z: 0.95, move: 'bob', back: true, delay: 0.12 },
          { key: 'band/singers', x: 0.28, z: 0.95, move: 'sway', back: true },
          { key: 'band/sax', x: 0.74, z: 0.95, move: 'lean', back: true, delay: 0.4 },
          { key: 'band/keys', x: 0.88, z: 0.95, move: 'bob', back: true, delay: 0.25 });
      }
      return { cast: cast, spots: [0.46, 0.58] };
    },
    outfit: function (o) {
      var f = o.outfit;
      var art = FIT_ART[f] || f;
      return { cast: [
        { key: 'ian/fit-' + art, x: 0.45, z: 1.1, move: f === 'rock' ? 'sway' : 'lean' },
        { key: 'ember/fit-' + art, x: 0.56, z: 1.2, move: 'bob', delay: 0.25 }
      ], spots: [0.5], chip: f };
    },
    headphones: function (o) {
      return { cast: [
        { key: 'ian/headphones', px: o.right - 112, z: 1, move: 'bob' },
        { key: 'ember/headphones', px: o.right - 34, z: 1, move: 'sway', delay: 0.25 }
      ], corner: true };
    },
    dance: function (o) {
      return { cast: [
        { key: 'ian/dance-point', px: o.right - 118, z: 1, move: 'sway' },
        { key: 'ember/dance', px: o.right - 36, z: 1, move: 'bob', delay: 0.25 }
      ], corner: true };
    }
  };
  var STAGE_ORDER = ['band', 'singer', 'encore'];
  var CORNER_ORDER = ['headphones', 'dance'];
  var CORNER_ROOM = 175;        // px at 1x the two need side by side

  function pick(mode, o) {
    if (mode === 'stage') {
      if (o.outfit && outfitShown !== o.trackId) return 'outfit';
      var i = STAGE_ORDER.indexOf(lastScene.stage);
      return STAGE_ORDER[(i + 1) % STAGE_ORDER.length];
    }
    var j = CORNER_ORDER.indexOf(lastScene.corner);
    return CORNER_ORDER[(j + 1) % CORNER_ORDER.length];
  }

  function opts() {
    var i = info || {};
    return {
      rich: !!RICH[i.level] && !lessMotion(),
      outfit: i.outfit || '',
      trackId: i.trackId || '',
      right: i.corner ? i.corner.right : 0
    };
  }

  function keysOf(plan, o) {
    var out = [];
    for (var i = 0; i < plan.cast.length; i++) out.push(plan.cast[i].key);
    if (o.rich || plan.corner) { out.push('note'); out.push('star'); }
    return out;
  }

  /* ---------- drawing ---------- */

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function beat() {
    var t = info && info.tempo;
    if (!t || t < 40) return 0.55;
    var s = 60 / t;
    while (s < 0.36) s *= 2;
    while (s > 1.1) s /= 2;
    return s;
  }

  function build(name, plan, o, imgs) {
    var W = host.offsetWidth, H = host.offsetHeight;
    var layer = el('div', 'npb npb-' + (plan.corner ? 'corner' : 'stage') + (lessMotion() ? ' npb-still' : ''), host);
    layer.setAttribute('data-scene', name);
    var b = beat();
    var stageH = 0, floor, z;
    if (plan.corner) {
      floor = info.corner.floor;
      z = info.corner.z || 1;
    } else {
      z = Math.max(1, Math.min(2.4, H / 1080 * 2));
      stageH = Math.round(H * 0.1);
      floor = H - Math.round(stageH * 0.45);
      var st = el('div', 'npb-floor', layer);
      st.style.height = stageH + 'px';
      if (o.rich) {
        for (var s = 0; s < plan.spots.length; s++) {
          var top = Math.round(W * 0.03), bot = Math.round(W * 0.11), coneH = H + 40;
          var cone = el('div', 'npb-spot', layer);
          cone.style.left = Math.round(plan.spots[s] * W - bot) + 'px';
          cone.style.width = (2 * top) + 'px';
          cone.style.borderLeftWidth = (bot - top) + 'px';
          cone.style.borderRightWidth = (bot - top) + 'px';
          cone.style.borderBottomWidth = coneH + 'px';
          cone.style.animationDelay = (s * b * 2) + 's';
        }
        for (var f = 0; f < 5; f++) {
          var fl = el('div', 'npb-foot', layer);
          fl.style.left = Math.round(W * (0.1 + f * 0.2) - 35) + 'px';
          fl.style.bottom = Math.round(stageH * 0.62) + 'px';
          fl.style.animationDuration = (b * 2) + 's';
          fl.style.animationDelay = (f * b / 2) + 's';
        }
      }
      if (plan.pool && o.rich) {
        var pool = el('div', 'npb-pool', layer);
        pool.style.left = Math.round(plan.pool * W - 150 * z / 2) + 'px';
        pool.style.width = Math.round(150 * z) + 'px';
        pool.style.top = (floor - 22) + 'px';
      }
    }
    var cast = plan.cast.slice().sort(function (a, c) { return (c.back ? 1 : 0) - (a.back ? 1 : 0); });
    for (var i = 0; i < cast.length; i++) {
      var a = cast[i];
      var sz = size(a.key);
      var zz = z * (a.z || 1);
      var w = Math.round(sz.w * zz), h = Math.round(sz.h * zz);
      var cx = a.px !== undefined ? a.px : a.x * W;
      var fy = a.back ? floor - Math.round(stageH * 0.35) : floor;
      var box = el('div', 'npb-a npb-in' + (a.back ? ' npb-back' : ''), layer);
      box.setAttribute('data-key', a.key);
      box.style.left = Math.round(cx - w / 2) + 'px';
      box.style.top = (fy - h) + 'px';
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      box.style.animationDelay = (i * 0.12) + 's';
      var mover = el('div', 'npb-m npb-' + a.move, box);
      var per = a.move === 'sway' || a.move === 'lean' ? 2 * b : a.move === 'hit' ? b / 2 : b;
      mover.style.animationDuration = per + 's';
      mover.style.animationDelay = ((a.delay || 0) * per) + 's';
      var img = imgs[a.key].cloneNode ? imgs[a.key].cloneNode(false) : el('img');
      img.className = 'npb-img';
      img.style.width = w + 'px';
      img.style.height = h + 'px';
      img.alt = '';
      mover.appendChild(img);
    }
    if ((o.rich || plan.corner) && !lessMotion()) {
      var mid = plan.corner ? info.corner.right - 70 : (plan.spots[0] || 0.5) * W;
      var n = plan.corner ? 4 : 6, ns = plan.corner ? 0.8 : 1.4 * z / 2;
      for (var k = 0; k < n; k++) {
        var key = k % 3 === 2 ? 'star' : 'note';
        var d = size(key);
        var note = el('img', 'npb-note', layer);
        note.src = spriteSrc(key);
        note.alt = '';
        note.style.width = Math.round(d.w * ns * 1.4) + 'px';
        note.style.height = Math.round(d.h * ns * 1.4) + 'px';
        note.style.left = Math.round(mid + ((k % 3) - 1) * 40 * ns) + 'px';
        note.style.top = Math.round(floor - (plan.corner ? 190 : 380 * z / 2)) + 'px';
        note.style.animationDelay = (k * 0.55) + 's';
      }
    }
    return layer;
  }

  /* ---------- the visit ---------- */

  function canStart(t) {
    if (!host || !info || !info.playing || scene || cancelLoad) return false;
    if (t < dueAt || t - lastKey < QUIET_MS) return false;
    if (info.mode === 'corner' && (!info.corner || info.corner.room < CORNER_ROOM * (info.corner.z || 1))) return false;
    return true;
  }

  function start(name, hold) {
    var mode = info.mode;
    var o = opts();
    if (name === 'outfit' && !o.outfit) name = pick(mode, { trackId: o.trackId });
    var plan = SCENES[name](o);
    var keys = keysOf(plan, o);
    var forHost = host;
    var mine = ++gen;
    // Still this visit: no leave since, same page and kind, nobody pressed a key.
    var still = function () {
      return mine === gen && host === forHost && !!info && info.mode === mode && (hold || (info.playing && now() - lastKey >= QUIET_MS));
    };
    cancelLoad = function () {};
    loadList(function (ok) {
      if (mine !== gen) return;
      if (!ok) { cancelLoad = null; dueAt = now() + 20000; return; }
      cancelLoad = preload(keys, function (imgs) {
        if (mine !== gen) return;
        cancelLoad = null;
        if (!imgs) {
          dueAt = now() + 20000;
          // An outfit whose pictures fail doesn't hold up the other scenes.
          if (name === 'outfit') outfitShown = o.trackId;
          return;
        }
        if (!still() || scene) return;
        try {
          var layer = build(name, plan, o, imgs);
          scene = { name: name, mode: mode, layer: layer, endAt: hold ? Infinity : now() + (mode === 'stage' ? STAGE_MS : CORNER_MS), chip: plan.chip || '',
            corner: plan.corner ? { right: info.corner.right, floor: info.corner.floor, left: info.corner.right - info.corner.room } : null };
          lastScene[mode] = name;
          if (name === 'outfit') outfitShown = o.trackId;
          visits += 1;
          problem = '';
          chip(scene.chip);
        } catch (e) {
          problem = 'could not draw: ' + (e && e.message);
          dueAt = now() + 60000;
        }
      });
    });
  }

  function chip(word) {
    if (info && typeof info.chip === 'function') {
      try { info.chip(word || ''); } catch (e) { /* the chip just doesn't show */ }
    }
  }

  // Sends them off: a fade, then the layer goes. now: no fade (the host is
  // going away or changing).
  function leave(fast) {
    gen += 1;
    if (cancelLoad) { try { cancelLoad(); } catch (e) { /* */ } cancelLoad = null; }
    if (!scene) return;
    var s = scene;
    scene = null;
    chip('');
    var gap = s.mode === 'stage' ? STAGE_GAP : CORNER_GAP;
    dueAt = now() + between(gap[0], gap[1]) * 1000;
    if (fast || !s.layer.parentNode) { if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer); return; }
    s.layer.className += ' npb-out';
    setTimeout(function () { if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer); }, OUT_MS);
  }

  function check() {
    var t = now();
    if (scene && t >= scene.endAt) leave(false);
    if (canStart(t)) start(pick(info.mode, opts()));
    if (!host && timer) { clearInterval(timer); timer = null; }
  }

  function onKey() {
    lastKey = now();
    if (scene && scene.endAt !== Infinity) leave(false);
    else if (cancelLoad && !(scene && scene.endAt === Infinity)) { gen += 1; try { cancelLoad(); } catch (e) { /* */ } cancelLoad = null; }
  }

  /* ---------- the hub's side ---------- */

  // host: the panel, or null when the page closed. info: { mode: 'stage' |
  // 'corner', playing, tempo, level, genres, artist, trackId, config, corner:
  // { right, floor, room, z }, chip(word) }.
  function sync(h, i) {
    if (!h || !i || off(i.config)) {
      if (host || scene) leave(true);
      host = null;
      info = null;
      return false;
    }
    var outfit = outfitFor(i.genres, i.artist, i.config && i.config.bandOutfits);
    i.outfit = outfit;
    var changedHost = h !== host || !info || info.mode !== i.mode;
    if (changedHost) {
      leave(true);
      host = h;
      dueAt = now() + FIRST_MS;
    }
    info = i;
    if (!i.playing && scene && scene.endAt !== Infinity) leave(false);
    // The corner moved (a chip came, the panel changed): off, rather than
    // stand over a word. They come back at the next visit, measured again.
    var c = scene && scene.corner;
    if (c && i.corner && (i.corner.right - i.corner.room > c.left + 1 || Math.abs(i.corner.floor - c.floor) > 1 || Math.abs(i.corner.right - c.right) > 1)) leave(false);
    if (i.mode === 'stage' && outfit && outfit !== lastOutfit && outfitShown !== i.trackId) {
      lastOutfit = outfit;
      dueAt = Math.min(dueAt, now() + OUTFIT_SOON_MS);
    }
    if (scene && scene.chip) chip(scene.chip);
    if (!timer) timer = setInterval(function () { try { check(); } catch (e) { problem = String(e && e.message); } }, CHECK_MS);
    return true;
  }

  try { document.addEventListener('keydown', function () { try { onKey(); } catch (e) { /* */ } }, true); } catch (e) { /* no keys */ }

  // What a person may ask for now (the Home Assistant dashboard, through
  // hub.js): the stage's scenes in the visualizer, the corner's on the
  // expanded page, nothing while paused or with no room in the corner.
  function askable() {
    if (!host || !info || !info.playing) return [];
    if (info.mode === 'stage') return info.outfit ? ['band', 'singer', 'encore', 'outfit'] : ['band', 'singer', 'encore'];
    if (!info.corner || info.corner.room < CORNER_ROOM * (info.corner.z || 1)) return [];
    return CORNER_ORDER.slice();
  }

  // Plays one now, as a normal visit (a key still sends them off). '' when
  // it starts, else 'unknown' (not one that can play here now).
  function askScene(name) {
    var list = askable();
    var ok = false;
    for (var i = 0; i < list.length; i++) if (list[i] === name) ok = true;
    if (!ok) return 'unknown';
    leave(true);
    lastKey = now() - QUIET_MS;
    start(name, false);
    return '';
  }

  window.HUB_NP_BAND = {
    scenes: function () { try { return askable(); } catch (e) { return []; } },
    play: function (name) { try { return askScene(String(name)); } catch (e) { return 'error'; } },
    sync: sync,
    stop: function () { sync(null); },
    outfit: outfitFor,
    status: function () {
      return { on: !!host, mode: info ? info.mode : '', scene: scene ? scene.name : '', loading: !!cancelLoad,
        dueIn: host ? Math.max(0, Math.round((dueAt - now()) / 1000)) : 0, visits: visits, outfit: info ? info.outfit : '', problem: problem };
    },
    test: {
      // Plays a scene now and holds it until stop() or leave (for screenshots).
      play: function (name) { if (!host || !info || !SCENES[name]) return false; leave(true); start(name, true); return true; },
      leave: function () { leave(true); },
      scenes: function () { var out = []; for (var k in SCENES) if (SCENES.hasOwnProperty(k)) out.push(k); return out; },
      quiet: function (ms) { lastKey = now() - (ms || QUIET_MS); dueAt = 0; }
    }
  };
})();
