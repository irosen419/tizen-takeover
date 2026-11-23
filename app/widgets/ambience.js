/*
 * Ambience: the room's lights from the TV. Scenes ("Chill night"), each
 * light's level, and the plant wall's moods when there is one.
 *
 * Everything comes from the Pi (pi/ambience.js) through the live line, as
 * the resource "ambience": the lights (name, on, level, answering, flaky),
 * the scenes (name, icon, tone), the active scene, the plant wall's moods
 * and the last scene's result. The TV never talks to Home Assistant or the
 * plant wall itself: its choices go back to the Pi as saved ids only
 * (ctx.live.post('/ambience/scene', { id }) and /light, /mood), the same
 * way the to-do list sends its ticks, with no secret on the TV.
 *
 * The tile: the active scene's name big (else "Lights on", "Lights off" or
 * "2 of 3 on"), a row of bulb dots (lit, off, crossed when a light doesn't
 * answer), and a quiet line when the last scene was only partly applied
 * ("Sengled lamp didn't answer"). Sizes follow docs/tile-sizes.md: one
 * column is the bulb and a count; a strip is one line; two rows add the
 * dots; wide and tall tiles add a row per light with its level.
 *
 * The panel: Scenes (cards on a rail; Left/Right, OK applies), Room lights
 * (one row each; Left/Right dim or brighten by 10, faster when held, OK
 * turns it on or off) and Plant wall (mood chips) when the Pi has one.
 * A choice shows at once ("Sending...") and is confirmed by the Pi's push,
 * or rolled back with a plain message. No typing, no on/off switches.
 *
 * Words: English here, Spanish in app/i18n.js under 'ambience.'. Names of
 * lights, scenes and moods come from the Pi's settings and are never
 * translated. Plain ES5; only transform and opacity animate.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var C = null;            // a ctx, kept from init for the live hooks
  var data = null;         // the last ambience data from the Pi, or null
  var page = null;         // the open panel's parts, or null
  var lastSig = '';
  var pendingScene = null; // { id, at } while a scene is on its way
  var pendingMood = null;  // { id, at }
  var pendingLight = {};   // id -> { on, pct, at, timer, sent }
  var note = null;         // { text, kind: 'ok'|'warn'|'bad', at } shown in the panel
  var noteTimer = null;
  var lastCard = '';       // the scene card focused last (for Up from the lights)
  var steps = {};          // id -> { at, streak } for holding Left/Right
  var PENDING_MS = 12000;  // a send that never answers stops looking pending
  var SEND_MS = 320;       // a level is sent once the arrows rest this long
  var NOTE_MS = 6000;

  /* ---------- small helpers ---------- */

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function T(key, en, vars) {
    var L = window.HUB_I18N;
    if (L && typeof L.t === 'function') {
      try { return String(L.t('ambience.' + key, en, vars)); } catch (e) { /* English */ }
    }
    return en.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m; });
  }

  function now() { return new Date().getTime(); }

  function str(v, max) {
    var s = typeof v === 'string' ? v : '';
    return s.length > max ? s.slice(0, max) : s;
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        if (window.console && console.warn) console.warn('Ambience: ' + (e && e.message));
        return undefined;
      }
    };
  }

  function hasClass(node, c) { return !!node && (' ' + node.className + ' ').indexOf(' ' + c + ' ') >= 0; }

  function rem() {
    return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  }

  // '#ff9227' -> 'rgba(255, 146, 39, a)'; '' or bad -> a soft white.
  function rgba(hex, a) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    var r = m ? parseInt(m[1], 16) : 255;
    var g = m ? parseInt(m[2], 16) : 214;
    var b = m ? parseInt(m[3], 16) : 170;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  }

  // The colour mixed toward white by k (0 to 1), for a bulb's lit core.
  function lift(hex, k) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    var c = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 214, 170];
    for (var i = 0; i < 3; i++) c[i] = Math.round(c[i] + (255 - c[i]) * k);
    return 'rgb(' + c.join(', ') + ')';
  }

  // The colour made deep enough to read on the light day glass: the same hue,
  // saturation at least 0.85 and lightness at most 0.55 (warm white becomes
  // amber, a blue stays blue). theme-day uses it through --am-deep.
  function deep(hex) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    var r = (m ? parseInt(m[1], 16) : 255) / 255, g = (m ? parseInt(m[2], 16) : 214) / 255, b = (m ? parseInt(m[3], 16) : 170) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, d = max - min;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    var l = Math.min((max + min) / 2, 0.55);
    var sat = d ? Math.max(d / (1 - Math.abs(max + min - 1)), 0.85) : 0;
    return 'hsl(' + Math.round(h) + ', ' + Math.round(sat * 100) + '%, ' + Math.round(l * 100) + '%)';
  }

  // The scene icons, drawn like app/icons.js (24 x 24 lines).
  var GLYPH = {
    moon: '<path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
    book: '<path d="M12 6.5c-1.8-1.3-4.3-2-7.5-2v13c3.2 0 5.7.7 7.5 2 1.8-1.3 4.3-2 7.5-2v-13c-3.2 0-5.7.7-7.5 2z"/><path d="M12 6.5v13"/>',
    film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
    power: '<path d="M12 3.5v8"/><path d="M7 6.6a7.5 7.5 0 1 0 10 0"/>',
    sparkle: '<path d="M11 3l1.8 4.9L17.5 9.7l-4.7 1.8L11 16.5l-1.8-5L4.5 9.7l4.7-1.8z"/><path d="M18.5 14.5l.8 2.1 2.2.9-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.9z"/>',
    bulb: '<path d="M9 17.5h6M10 20.5h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v1.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
    leaf: '<path d="M5 19c0-8 5-13.5 14.5-14-0.5 9.5-6 14.5-14 14.5z"/><path d="M5 19l7.5-7.5"/>',
    sofa: '<path d="M5 11V8.5A2.5 2.5 0 0 1 7.5 6h9A2.5 2.5 0 0 1 19 8.5V11"/><path d="M3.5 11.5a1.5 1.5 0 0 1 3 0V14h11v-2.5a1.5 1.5 0 0 1 3 0V17a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M6 18v1.5M18 18v1.5"/>',
    bed: '<path d="M3.5 18.5v-11M3.5 14h17v4.5M20.5 14v-2.5a2.5 2.5 0 0 0-2.5-2.5h-7v5"/><circle cx="7" cy="11" r="1.6"/>'
  };

  function glyph(name, cls, parent) {
    var box = el('span', 'am-glyph ' + (cls || ''), parent);
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' + (GLYPH[name] || GLYPH.bulb) + '</svg>';
    return box;
  }

  // Ends a text in "..." after n lines (old WebKit's line clamp); 0 hides it.
  function clamp(node, n) {
    if (!node) return;
    node.style.display = '';
    node.style.webkitLineClamp = '';
    node.style.webkitBoxOrient = '';
    node.style.overflow = '';
    if (n <= 0) { node.style.display = 'none'; return; }
    if (n >= 99) return;
    node.style.display = '-webkit-box';
    node.style.webkitBoxOrient = 'vertical';
    node.style.webkitLineClamp = String(n);
    node.style.overflow = 'hidden';
  }

  function shown(node) { return !!node && node.style.display !== 'none' && node.offsetHeight > 0; }

  /* ---------- reading the data ---------- */

  function list(v) { return isArr(v) ? v : []; }

  function lightsOf(d) {
    var out = [];
    var src = list(d && d.lights);
    for (var i = 0; i < src.length && i < 12; i++) {
      var l = src[i];
      if (!l || typeof l.id !== 'string') continue;
      var p = pendingLight[l.id];
      var on = l.on === true;
      var pct = typeof l.pct === 'number' ? Math.max(0, Math.min(100, Math.round(l.pct))) : 0;
      var waiting = false;
      if (p && now() - p.at < PENDING_MS) { on = p.on; pct = p.on ? p.pct : 0; waiting = true; }
      out.push({
        id: l.id, name: str(l.name, 40) || l.id, kind: l.kind === 'switch' ? 'switch' : 'light',
        on: on, pct: on ? (l.kind === 'switch' ? 100 : pct) : 0, reachable: l.reachable === true, flaky: l.flaky === true,
        tone: typeof l.tone === 'string' ? l.tone : '', pending: waiting
      });
    }
    return out;
  }

  function scenesOf(d) {
    var out = [];
    var src = list(d && d.scenes);
    for (var i = 0; i < src.length && i < 10; i++) {
      var s = src[i];
      if (!s || typeof s.id !== 'string') continue;
      out.push({ id: s.id, name: str(s.name, 40) || s.id, icon: GLYPH[s.icon] ? s.icon : 'bulb', tone: typeof s.tone === 'string' ? s.tone : '' });
    }
    return out;
  }

  function moodsOf(d) {
    var out = [];
    var src = list(d && d.moods);
    for (var i = 0; i < src.length && i < 12; i++) {
      var m = src[i];
      if (m && typeof m.id === 'string') out.push({ id: m.id, name: str(m.name, 40) || m.id });
    }
    return out;
  }

  function find(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  // "Sengled lamp" / "Sengled lamp and Desk lamp" / "Sengled lamp and 2 more".
  function names(arr) {
    if (!arr.length) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return T('and', '{a} and {b}', { a: arr[0], b: arr[1] });
    return T('andMore', '{a} and {n} more', { a: arr[0], n: arr.length - 1 });
  }

  // kind: ready, notset, waiting, offline, update, liveoff.
  function view() {
    var live = C && C.live ? C.live : null;
    var ls = 'off';
    try { ls = live ? live.status().state : 'off'; } catch (e) { ls = 'off'; }
    var d = data;
    var v = { kind: 'ready', stale: false, big: '', meta: '', note: '', noteKind: '', msg: '', hint: '',
      lights: [], scenes: [], moods: [], active: null, tone: '', haProblem: '' };
    if (!live || ls === 'off') {
      v.kind = 'liveoff';
      v.msg = T('liveOff', 'Live updates are off');
      v.hint = T('liveOffHint', 'Ambience needs the Pi. Check HUB_CONFIG.live in config.js.');
      return v;
    }
    if (!d || typeof d !== 'object') {
      if (ls === 'live') {
        v.kind = 'update';
        v.msg = T('update', 'The Pi needs an update');
        v.hint = T('updateHint', 'On the Pi: git pull, then docker compose restart hub.');
      } else {
        v.kind = ls === 'lost' ? 'offline' : 'waiting';
        v.msg = v.kind === 'offline' ? T('offline', 'Can’t reach the Pi') : T('waiting', 'Waiting for the Pi');
        v.hint = T('waitingHint', 'The lights come from the Pi.');
      }
      return v;
    }
    v.stale = ls !== 'live' && ls !== 'connecting';
    if (d.state === 'notset' || (d.state !== 'error' && !list(d.lights).length && !list(d.moods).length)) {
      v.kind = 'notset';
      v.msg = T('setUp', 'Set up lights');
      v.hint = d.problem === 'noha' ? T('noHa', 'Home Assistant isn’t connected yet') : T('noLights', 'No lights added yet');
      return v;
    }
    v.lights = lightsOf(d);
    v.scenes = scenesOf(d);
    v.moods = moodsOf(d);
    v.active = pendingScene && now() - pendingScene.at < PENDING_MS ? pendingScene.id : (typeof d.active === 'string' ? d.active : null);
    var scene = find(v.scenes, v.active);
    var on = 0;
    var gone = [];
    for (var i = 0; i < v.lights.length; i++) {
      if (v.lights[i].on) on += 1;
      if (!v.lights[i].reachable) gone.push(v.lights[i].name);
    }
    var total = v.lights.length;
    var count = !total ? '' : on === total ? T('lightsOn', 'Lights on') : !on ? T('lightsOff', 'Lights off')
      : T('someOn', '{n} of {m} on', { n: on, m: total });
    v.big = scene ? scene.name : (count || T('noLightsShort', 'No lights yet'));
    v.meta = scene && total ? T('someOn', '{n} of {m} on', { n: on, m: total }) : '';
    v.tone = scene ? scene.tone : '';
    if (!scene) {
      for (var j = 0; j < v.lights.length; j++) if (v.lights[j].on && v.lights[j].tone) { v.tone = v.lights[j].tone; break; }
    }
    if (!v.tone && on) v.tone = '#ffd6aa';
    var lr = d.lastResult;
    if (d.state === 'error') {
      v.haProblem = d.problem === 'auth' ? 'auth' : 'away';
      v.note = d.problem === 'auth' ? T('haAuth', 'Home Assistant refused the token') : T('haAway', 'Home Assistant isn’t answering');
      v.noteKind = 'bad';
      v.stale = true;
    } else if (lr && lr.result === 'partial' && lr.scene && lr.scene === d.active && list(lr.missing).length) {
      var miss = [];
      for (var k = 0; k < lr.missing.length; k++) miss.push(str(lr.missing[k], 40));
      v.note = T(miss.length > 1 ? 'didntAnswerMany' : 'didntAnswer', '{names} didn’t answer', { names: names(miss) });
      v.noteKind = 'warn';
    } else if (gone.length === 1) {
      v.note = T('notAnswering', '{name} isn’t answering', { name: gone[0] });
      v.noteKind = 'warn';
    } else if (gone.length > 1) {
      v.note = T('manyNotAnswering', '{n} lights aren’t answering', { n: gone.length });
      v.noteKind = 'warn';
    }
    return v;
  }

  /* ---------- pieces ---------- */

  // A row of small bulbs: lit (in its colour, breathing), off, or crossed.
  function dots(parent, lights) {
    var row = el('div', 'am-dots', parent);
    for (var i = 0; i < lights.length; i++) {
      var l = lights[i];
      var d = el('span', 'am-dot' + (l.kind === 'switch' ? ' is-switch' : '') + (!l.reachable ? ' is-gone' : l.on ? ' is-on' : ' is-off'), row);
      if (l.reachable && l.on) {
        // The core is the light's colour, lifted toward white so it reads as
        // lit; the halo is its glow, stronger the brighter the light.
        var halo = el('i', 'am-halo', d);
        var lvl = l.kind === 'switch' ? 0.7 : 0.35 + 0.65 * (l.pct / 100);
        d.style.backgroundColor = lift(l.tone || '#ffd6aa', 0.35);
        d.style.setProperty('--am-deep', deep(l.tone || '#ffd6aa'));
        halo.style.boxShadow = '0 0 ' + (0.35 + 0.5 * lvl).toFixed(2) + 'rem ' + (0.1 + 0.18 * lvl).toFixed(2) + 'rem ' + rgba(l.tone || '#ffd6aa', 0.9);
      }
    }
    return row;
  }

  // One light: its name, a bar, and what it is doing.
  // inline: one line (the panel's rows): name, bar, state. Otherwise the
  // name and state over the bar (the tile's rows).
  function lightRow(parent, l, cls, inline) {
    var row = el('div', 'am-lrow ' + (inline ? 'am-inline ' : '') + (cls || '') + (!l.reachable ? ' is-gone' : l.on ? ' is-on' : ' is-off') + (l.pending ? ' is-pending' : ''), parent);
    var top = el('div', 'am-lrow-top', row);
    var dot = el('span', 'am-dot am-lrow-dot' + (l.kind === 'switch' ? ' is-switch' : '') + (!l.reachable ? ' is-gone' : l.on ? ' is-on' : ' is-off'), top);
    if (l.reachable && l.on) {
      dot.style.backgroundColor = lift(l.tone || '#ffd6aa', 0.2);
      dot.style.setProperty('--am-deep', deep(l.tone || '#ffd6aa'));
    }
    el('span', 'am-lrow-name', top, l.name);
    var stateText = !l.reachable ? T('gone', 'Not answering') : !l.on ? T('off', 'Off')
      : l.kind === 'switch' ? T('on', 'On') : T('pct', '{n}%', { n: l.pct });
    var state = el('span', 'am-lrow-state', top, stateText);
    // A switch (the camera's plug) has no level: no bar, only its state.
    if (l.kind === 'switch') {
      var none = el('div', 'am-bar am-bar-none', inline ? top : row);
      if (inline) top.insertBefore(none, state);
      return row;
    }
    var bar = el('div', 'am-bar', inline ? top : row);
    if (inline) top.insertBefore(bar, state);
    var fill = el('i', 'am-bar-fill', bar);
    var k = l.reachable && l.on ? Math.max(0.02, l.pct / 100) : 0;
    fill.style.webkitTransform = 'scaleX(' + k + ')';
    fill.style.transform = 'scaleX(' + k + ')';
    if (l.reachable && l.on) fill.style.backgroundColor = rgba(l.tone || '#ffd6aa', 0.9);
    return row;
  }

  function layoutFor(size) {
    if (!size) return 'card';
    if (size.cols <= 1) return 'one';
    if (size.tier === 'strip') return 'strip';
    if (size.width === 'narrow') return 'stack';
    if (size.width === 'wide') return 'wide';
    if (size.tier === 'tall') return 'tall';
    return 'card';
  }

  /* ---------- the tile ---------- */

  function drawTile(body, ctx) {
    body.style.overflow = '';
    var size = ctx.size ? ctx.size() : null;
    var v = view();
    var layout = layoutFor(size);
    var root = el('div', 'am-tile am-l-' + layout + ' am-k-' + v.kind + (v.stale ? ' is-stale' : ''), body);
    var dormant = v.kind === 'waiting' || v.kind === 'offline' || v.kind === 'update' || v.kind === 'liveoff';
    if (dormant) root.className += ' hub-dormant';
    if (ctx.setBadge) {
      ctx.setBadge(v.kind === 'notset' ? T('badge.setUp', 'Set up') : v.stale && v.kind === 'ready' ? T('lastKnown', 'Last known') : '');
    }

    if (v.kind !== 'ready') {
      if (layout === 'one') {
        glyph('bulb', 'am-one-glyph is-quiet', root);
        root.title = v.msg;
        return;
      }
      // Waiting for the Pi: the hub's one quiet line (style.css, body.fx-quiet).
      var msg = el('div', 'am-msg' + (dormant ? ' hub-quiet-line' : ''), root, v.msg);
      var hint = layout === 'strip' ? null : el('div', 'am-hint' + (dormant ? ' hub-quiet-hide' : ''), root, v.hint);
      fitBlocks(body, [hint], [msg]);
      return;
    }

    // The scene's light, a soft glow from the lower right corner that
    // breathes. It covers the whole tile (placed in washTo below).
    var wash = null;
    if (v.tone) {
      wash = el('div', 'am-wash', root);
      wash.style.background = 'radial-gradient(ellipse at 100% 100%, ' + rgba(v.tone, 0.36) + ' 0%, ' + rgba(v.tone, 0.12) + ' 40%, ' + rgba(v.tone, 0) + ' 74%)';
    }

    if (layout === 'one') {
      var g = glyph(sceneIcon(v), 'am-one-glyph', root);
      if (v.tone) g.style.color = rgba(v.tone, 1);
      var on = 0;
      for (var i = 0; i < v.lights.length; i++) if (v.lights[i].on) on += 1;
      el('div', 'am-one-count', root, on + '/' + v.lights.length);
      root.title = v.big;
      washTo(wash, body, root);
      return;
    }

    if (layout === 'strip') {
      var line = el('div', 'am-sline', root);
      el('div', 'am-big', line, v.big);
      var sd = size && size.cols >= 5 ? dots(line, v.lights) : null;
      var sm = v.meta && size && size.cols >= 8 ? el('div', 'am-meta', line, v.meta) : null;
      var sn = v.note && size && size.cols >= 8 ? el('div', 'am-note am-' + v.noteKind, line, (sm ? '· ' : '') + v.note) : null;
      fitStrip(line, sd, sn, sm);
      washTo(wash, body, root);
      return;
    }

    var main = el('div', 'am-main', root);
    var big = el('div', 'am-big', main, v.big);
    var metaRow = el('div', 'am-metarow', main);
    var dt = dots(metaRow, v.lights);
    var meta = v.meta ? el('div', 'am-meta', metaRow, v.meta) : null;
    var rows = null;
    if (layout === 'wide' || layout === 'tall') {
      rows = el('div', 'am-rows', layout === 'wide' ? root : main);
      for (var r = 0; r < v.lights.length; r++) lightRow(rows, v.lights[r], 'am-tile-row');
    }
    // Wide and tall: the scenes as a quiet list at the foot, the active one lit.
    var ladder = null;
    if (layout === 'wide' && size && size.rows >= 3 && v.scenes.length) ladder = sceneLadder(main, v);
    var noteEl = v.note ? el('div', 'am-note am-' + v.noteKind, main, v.note) : null;
    fitTile(body, root, layout, { big: big, metaRow: metaRow, dots: dt, meta: meta, note: noteEl, rows: rows, main: main, ladder: ladder });
    washTo(wash, body, root);
  }

  function sceneLadder(parent, v) {
    var box = el('div', 'am-ladder', parent);
    for (var i = 0; i < v.scenes.length; i++) {
      var s = v.scenes[i];
      var on = s.id === v.active;
      var item = el('div', 'am-step' + (on ? ' is-active' : ''), box);
      var g = glyph(s.icon, 'am-step-icon', item);
      if (on && s.tone) g.style.color = rgba(s.tone, 1);
      el('span', 'am-step-name', item, s.name);
    }
    return box;
  }

  // Sizes the glow to the whole tile, whatever the tile's padding.
  function washTo(wash, body, root) {
    if (!wash) return;
    var tile = body.parentNode;
    if (!tile || !tile.clientWidth) return;
    // Narrow tiles and strips clip their body; the glow must reach the
    // tile's own rounded edge (everything else here is fitted to the body).
    body.style.overflow = 'visible';
    var top = body.offsetTop + root.offsetTop;
    var left = body.offsetLeft + root.offsetLeft;
    wash.style.top = (-top) + 'px';
    wash.style.left = (-left) + 'px';
    wash.style.right = 'auto';
    wash.style.bottom = 'auto';
    wash.style.width = tile.clientWidth + 'px';
    wash.style.height = tile.clientHeight + 'px';
  }

  function sceneIcon(v) {
    var s = find(v.scenes, v.active);
    return s ? s.icon : 'bulb';
  }

  // Does everything (but the glow, which reaches past the body on purpose)
  // sit inside the tile's body?
  function fits(body) {
    var box = body.getBoundingClientRect();
    var bad = false;
    function walk(node, depth) {
      for (var i = 0; i < node.childNodes.length && !bad; i++) {
        var c = node.childNodes[i];
        if (c.nodeType !== 1 || hasClass(c, 'am-wash') || c.style.display === 'none') continue;
        var r = c.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.bottom > box.bottom + 1 || r.right > box.right + 1) { bad = true; return; }
        if (depth < 2) walk(c, depth + 1);
      }
    }
    walk(body, 0);
    return !bad;
  }

  // Message tiles: the first list gives up lines first, then goes.
  function fitBlocks(body, drop, keep) {
    var i;
    for (i = 0; i < keep.length; i++) clamp(keep[i], 2);
    for (i = 0; i < drop.length; i++) clamp(drop[i], 3);
    for (i = 0; i < drop.length && !fits(body); i++) {
      clamp(drop[i], 2);
      if (!fits(body)) clamp(drop[i], 1);
      if (!fits(body)) clamp(drop[i], 0);
    }
    for (i = 0; i < keep.length && !fits(body); i++) clamp(keep[i], 1);
  }

  // A strip: the big line first; the note, then the dots, leave when short.
  function fitStrip(line, sd, sn, sm) {
    if (sn && line.scrollWidth > line.clientWidth + 1) { sn.style.display = 'none'; }
    if (sm && line.scrollWidth > line.clientWidth + 1) { sm.style.display = 'none'; }
    if (sd && line.scrollWidth > line.clientWidth + 1) { sd.style.display = 'none'; }
  }

  function fitTile(body, root, layout, p) {
    var r = rem();
    clamp(p.big, layout === 'card' || layout === 'stack' ? 2 : 2);
    if (p.note) clamp(p.note, 2);
    if (p.rows) {
      // As many light rows as fit; the rest go (the panel has them all).
      var kids = p.rows.childNodes;
      for (var i = kids.length - 1; i >= 0 && !fits(body); i--) kids[i].style.display = 'none';
      if (p.rows && !shown(kids[0])) p.rows.style.display = 'none';
    }
    if (!fits(body) && p.ladder) p.ladder.style.display = 'none';
    if (!fits(body) && p.note) clamp(p.note, 1);
    if (!fits(body) && p.meta) p.meta.style.display = 'none';
    if (!fits(body)) clamp(p.big, 1);
    if (!fits(body) && p.note) clamp(p.note, 0);
    if (!fits(body) && p.metaRow) p.metaRow.style.display = 'none';
    // Dots that run out of room wrap; at most two lines of them.
    if (p.dots && shown(p.dots) && p.dots.offsetHeight > 2.6 * r) p.dots.className += ' is-small';
  }

  /* ---------- the panel ---------- */

  function drawPanel(body, ctx) {
    var v = view();
    var full = ctx.mode && ctx.mode() === 'full';
    var root = el('div', 'am-page am-k-' + v.kind + (full ? ' is-full' : '') + (v.stale ? ' is-stale' : ''), body);
    page = { root: root, v: v, full: full, cards: [], rows: [], chips: [] };
    if (v.kind !== 'ready') {
      var box = el('div', 'am-empty', root);
      glyph('bulb', 'am-empty-glyph', box);
      el('div', 'am-empty-title', box, v.msg);
      el('div', 'am-empty-hint', box, v.hint);
      if (v.kind === 'notset') el('div', 'am-empty-how', box, T('setUpHow', 'On the Pi: add HA_TOKEN to pi/.env, then ./hub ambience set with your lights (see pi/README.md).'));
      return;
    }

    if (v.scenes.length) {
      var sec = el('div', 'am-sec am-sec-scenes', root);
      el('div', 'am-label', sec, T('scenes', 'Scenes'));
      var rail = el('div', 'am-rail', sec);
      var track = el('div', 'am-track', rail);
      page.rail = rail;
      page.track = track;
      for (var i = 0; i < v.scenes.length; i++) page.cards.push(sceneCard(track, v.scenes[i], v));
    }
    if (v.lights.length) {
      var ls = el('div', 'am-sec am-sec-lights', root);
      el('div', 'am-label', ls, T('lights', 'Room lights'));
      var wrap = el('div', 'am-lights', ls);
      for (var j = 0; j < v.lights.length; j++) {
        var row = lightRow(wrap, v.lights[j], 'f am-prow', true);
        row.setAttribute('data-key', 'light:' + v.lights[j].id);
        row.setAttribute('data-light', v.lights[j].id);
        page.rows.push(row);
      }
    } else {
      el('div', 'am-hint am-nolights', root, T('noLights', 'No lights added yet'));
    }
    if (v.moods.length) {
      var ms = el('div', 'am-sec am-sec-moods', root);
      var lab = el('div', 'am-label', ms, T('wall', 'Plant wall'));
      var w = data && data.wled;
      if (w && w.reachable === false) el('span', 'am-label-note', lab, T('wallGone', 'not answering'));
      var chips = el('div', 'am-chips', ms);
      var activeMood = pendingMood && now() - pendingMood.at < PENDING_MS ? pendingMood.id : (w && typeof w.mood === 'string' ? w.mood : null);
      for (var k = 0; k < v.moods.length; k++) {
        var m = v.moods[k];
        var chip = el('div', 'f am-chip' + (m.id === activeMood ? ' is-active' : '') + (pendingMood && pendingMood.id === m.id ? ' is-pending' : ''), chips);
        chip.setAttribute('data-key', 'mood:' + m.id);
        chip.setAttribute('data-mood', m.id);
        el('span', 'am-chip-text', chip, m.name);
        page.chips.push(chip);
      }
    }
    paintStatus();
    // First focus: the active scene, else the first scene, else the first light.
    var first = null;
    for (var c = 0; c < page.cards.length; c++) if (hasClass(page.cards[c], 'is-active')) first = page.cards[c];
    first = first || page.cards[0] || page.rows[0] || page.chips[0];
    if (first) first.setAttribute('data-autofocus', '');
  }

  function sceneCard(track, s, v) {
    var active = s.id === v.active;
    var sending = pendingScene && pendingScene.id === s.id && now() - pendingScene.at < PENDING_MS;
    var card = el('div', 'f am-card' + (active ? ' is-active' : '') + (sending ? ' is-pending' : '') + (s.tone ? '' : ' is-dark'), track);
    card.setAttribute('data-key', 'scene:' + s.id);
    card.setAttribute('data-scene', s.id);
    // The active scene: a glow in the scene's own colour (it breathes) and
    // a thin ring of it inside the card's edge, so focus (the white border)
    // and "on now" never hide each other.
    if (active) {
      var glow = el('i', 'am-card-glow', card);
      glow.style.boxShadow = '0 0 1rem 0.05rem ' + rgba(s.tone || '#9aa4bd', 0.5) + ', inset 0 0 1.6rem ' + rgba(s.tone || '#9aa4bd', 0.22);
      var ring = el('i', 'am-card-ring', card);
      ring.style.borderColor = rgba(s.tone || '#9aa4bd', 0.9);
    }
    var ic = glyph(s.icon, 'am-card-icon', card);
    ic.style.color = s.tone ? rgba(s.tone, active ? 1 : 0.8) : '';
    el('div', 'am-card-name', card, s.name);
    el('div', 'am-card-state', card, sending ? T('sending', 'Sending…') : active ? T('onNow', 'On now') : '');
    return card;
  }

  // The panel head's small line: what was just sent or went wrong, else
  // the scene's partial note, else what OK and the arrows do here.
  function paintStatus() {
    if (!page || !C || !C.setSub) return;
    var v = page.v;
    var text = page.hint || '';
    var kind = '';
    if (note && now() - note.at < NOTE_MS) { text = note.text; kind = note.kind; }
    else if (v.note) { text = v.note; kind = v.noteKind; }
    C.setSub(text);
    var sub = document.querySelector('#panel .panel-sub');
    if (sub) {
      sub.className = sub.className.replace(/\s*am-sub-\w+/g, '') + (kind === 'warn' || kind === 'bad' ? ' am-sub-' + kind : '');
    }
  }

  function clearSub() {
    var sub = document.querySelector('#panel .panel-sub');
    if (sub) sub.className = sub.className.replace(/\s*am-sub-\w+/g, '');
  }

  function setNote(text, kind) {
    note = { text: text, kind: kind || 'ok', at: now() };
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { noteTimer = null; note = null; paintStatus(); }, NOTE_MS);
    paintStatus();
  }

  function paintFoot(target) {
    if (!page) return;
    var text = '';
    if (target && target.getAttribute) {
      if (target.getAttribute('data-scene')) text = T('hintScene', 'OK sets the scene');
      else if (target.getAttribute('data-light')) {
        var l = find(lightsOf(data), target.getAttribute('data-light'));
        text = l && !l.reachable ? T('hintGone', 'It isn’t answering, so nothing can be sent to it')
          : l && l.kind === 'switch' ? T('hintSwitch', 'OK turns it on or off')
            : T('hintLight', '◀ ▶ dimmer or brighter · OK turns it on or off');
      } else if (target.getAttribute('data-mood')) text = T('hintMood', 'OK sets the plant wall');
    }
    page.hint = text;
    paintStatus();
  }

  // Keeps the focused card on the rail in view (instant: focus never animates).
  function railTo(card) {
    if (!page || !page.rail || !card) return;
    var railW = page.rail.clientWidth;
    var left = card.offsetLeft;
    var right = left + card.offsetWidth;
    var shift = page.shift || 0;
    var pad = 0.6 * rem();
    if (right - shift > railW - pad) shift = right - railW + pad;
    if (left - shift < pad) shift = Math.max(0, left - pad);
    var max = Math.max(0, page.track.scrollWidth - railW);
    shift = Math.max(0, Math.min(max, shift));
    page.shift = shift;
    page.track.style.webkitTransform = 'translateX(' + (-shift) + 'px)';
    page.track.style.transform = 'translateX(' + (-shift) + 'px)';
  }

  /* ---------- sending ---------- */

  function failText(err, code) {
    if (code === 429) return T('errBusy', 'Too many presses. Try again in a moment.');
    if (code === 409) return T('errHa', 'Home Assistant isn’t connected yet.');
    if (code === 400) return T('errGone', 'That isn’t saved on the Pi any more.');
    return T('errPi', 'Couldn’t reach the Pi. Nothing changed.');
  }

  function post(path, body, cb) {
    if (!C || !C.live || typeof C.live.post !== 'function') { cb('live updates are off', null, 0); return; }
    C.live.post(path, body, cb);
  }

  function applyScene(id) {
    var s = find(scenesOf(data), id);
    if (!s) return;
    var mine = { id: id, at: now() };
    pendingScene = mine;
    setNote(T('sending', 'Sending…'), 'ok');
    redraw();
    post('/ambience/scene', { id: id }, safe(function (err, r, code) {
      // Another scene went after this one: its answer is the one to show.
      // (The Pi's push may already have confirmed this one: pendingScene is
      // null then, and the answer still says how it went.)
      if (pendingScene && pendingScene !== mine) return;
      pendingScene = null;
      if (err) {
        setNote(failText(err, code), 'bad');
      } else if (r.result === 'failed') {
        setNote(T('errFailed', 'No light answered. Nothing changed.'), 'bad');
      } else if (r.result === 'partial') {
        var miss = [];
        for (var i = 0; i < list(r.missing).length; i++) miss.push(str(r.missing[i], 40));
        setNote(T(miss.length > 1 ? 'didntAnswerMany' : 'didntAnswer', '{names} didn’t answer', { names: names(miss) }), 'warn');
      } else {
        setNote(T('sceneOn', '{name} is on', { name: s.name }), 'ok');
      }
      redraw();
    }));
  }

  // dir: -1 or +1 (Left / Right), or 0 for OK (on or off).
  function changeLight(id, dir) {
    var l = find(lightsOf(data), id);
    if (!l) return;
    if (!l.reachable) { setNote(T('lightGone', '{name} isn’t answering.', { name: l.name }), 'warn'); return; }
    if (dir && l.kind === 'switch') return;
    var t = now();
    var st = steps[id] || { at: 0, streak: 0 };
    st.streak = dir && t - st.at < 260 ? st.streak + 1 : 0;
    st.at = t;
    steps[id] = st;
    var step = st.streak >= 3 ? 20 : 10;
    var on, pct;
    if (!dir) { on = !l.on; pct = on ? (l.kind === 'switch' ? 100 : 0) : 0; }
    else {
      // To the next step of 10 that way (85 goes to 90 or 80).
      var base = l.on ? l.pct : 0;
      var from = dir > 0 ? Math.floor(base / 10) * 10 : Math.ceil(base / 10) * 10;
      pct = Math.max(0, Math.min(100, from + dir * step));
      if (dir > 0 && pct < 10) pct = 10;
      on = pct > 0;
    }
    sendLight(id, l, on, pct, dir, t);
  }

  // Shows the light's new state at once and sends it (a level after the
  // arrows, or a finger, rest SEND_MS). level: 0 for an on/off, else a level.
  function sendLight(id, l, on, pct, level, t) {
    var p = pendingLight[id] || {};
    if (p.timer) clearTimeout(p.timer);
    // An "on" from OK keeps the level the Pi knew (pct 0 here means "as it was").
    var showPct = on ? (pct || (l.kind === 'switch' ? 100 : Math.max(10, lastPct(id)))) : 0;
    pendingLight[id] = { on: on, pct: showPct, at: t, timer: null, seq: (p.seq || 0) + 1 };
    paintRow(id);
    var dir = level;
    var body = { id: id };
    if (!dir) body.on = on;
    else if (on) body.pct = pct;
    else body.on = false;
    var seq = pendingLight[id].seq;
    pendingLight[id].timer = setTimeout(function () {
      if (!pendingLight[id] || pendingLight[id].seq !== seq) return;
      pendingLight[id].timer = null;
      post('/ambience/light', body, safe(function (err, r, code) {
        var cur = pendingLight[id];
        if (!cur || cur.seq !== seq) return;
        delete pendingLight[id];
        if (err) setNote(failText(err, code), 'bad');
        else if (r.result === 'no-answer') setNote(T('lightGone', '{name} isn’t answering.', { name: l.name }), 'warn');
        else if (r.result === 'refused') setNote(T('errRefused', 'Home Assistant refused that.'), 'bad');
        else if (data && isArr(data.lights)) {
          // Hold what the Pi said until its push lands.
          for (var i = 0; i < data.lights.length; i++) {
            if (data.lights[i].id === id) { data.lights[i].on = r.on === true; data.lights[i].pct = typeof r.pct === 'number' ? r.pct : data.lights[i].pct; }
          }
        }
        redraw();
      }));
    }, dir ? SEND_MS : 0);
  }

  var known = {};
  function lastPct(id) { return known[id] || 60; }

  // Tablet mode (ctx.tablet; no remote): a finger on a light's bar sets its
  // level where it touches, and a drag scrubs it. Never an on/off: the touch
  // is kept from becoming the click that the hub treats as OK. A tap on the
  // name still turns it on or off, as OK does. Chrome 52: touch events and a
  // mouse fallback, no Pointer Events.
  function setLightAt(id, rect, x) {
    var l = find(lightsOf(data), id);
    if (!l || l.kind === 'switch') return;
    if (!l.reachable) { setNote(T('lightGone', '{name} isn’t answering.', { name: l.name }), 'warn'); return; }
    var pct = Math.round(Math.max(0, Math.min(1, (x - rect.left) / (rect.width || 1))) * 100);
    sendLight(id, l, true, Math.max(1, pct), 1, now());
  }

  function barOf(node) {
    for (var n = node; n && n.getAttribute; n = n.parentNode) {
      if (hasClass(n, 'am-bar')) {
        var row = n.parentNode && n.parentNode.parentNode;
        var id = row && row.getAttribute ? row.getAttribute('data-light') : null;
        return id && !hasClass(n, 'am-bar-none') ? { bar: n, row: row, id: id } : null;
      }
      if (hasClass(n, 'panel-body')) return null;
    }
    return null;
  }

  function touchBars(body) {
    if (body.__amTouch) return;
    body.__amTouch = true;
    var mouse = null;
    // The bar is drawn again on every move, so the finger's own target
    // (which keeps getting its touch events) carries the drag.
    body.addEventListener('touchstart', function (e) {
      var b = page && C && C.tablet ? barOf(e.target) : null;
      if (!b || !e.touches || e.touches.length !== 1) return;
      e.preventDefault();
      var rect = b.bar.getBoundingClientRect();
      var node = e.target;
      if (C.focus) C.focus(b.row);
      setLightAt(b.id, rect, e.touches[0].clientX);
      function move(ev) { if (ev.touches && ev.touches.length) { ev.preventDefault(); setLightAt(b.id, rect, ev.touches[0].clientX); } }
      function end(ev) {
        if (ev.cancelable) ev.preventDefault();
        node.removeEventListener('touchmove', move);
        node.removeEventListener('touchend', end);
        node.removeEventListener('touchcancel', end);
      }
      node.addEventListener('touchmove', move);
      node.addEventListener('touchend', end);
      node.addEventListener('touchcancel', end);
    });
    body.addEventListener('mousedown', function (e) {
      var b = page && C && C.tablet ? barOf(e.target) : null;
      if (!b) return;
      e.preventDefault();
      mouse = { id: b.id, rect: b.bar.getBoundingClientRect() };
      if (C.focus) C.focus(b.row);
      setLightAt(mouse.id, mouse.rect, e.clientX);
    });
    document.addEventListener('mousemove', function (e) { if (mouse && page) setLightAt(mouse.id, mouse.rect, e.clientX); });
    document.addEventListener('mouseup', function () { mouse = null; });
    // The click that follows a press on a bar is not an OK.
    body.addEventListener('click', function (e) {
      if (page && C && C.tablet && barOf(e.target)) e.stopPropagation();
    });
  }

  // Repaints one light's row in place while the arrows are held (the
  // element stays, so focus stays on it).
  function paintRow(id) {
    if (!page) return;
    var l = find(lightsOf(data), id);
    if (!l) return;
    for (var i = 0; i < page.rows.length; i++) {
      var row = page.rows[i];
      if (row.getAttribute('data-light') !== id) continue;
      var focused = hasClass(row, 'is-focused');
      var fresh = lightRow(document.createElement('div'), l, 'f am-prow', true);
      row.className = fresh.className + (focused ? ' is-focused' : '');
      while (row.firstChild) row.removeChild(row.firstChild);
      while (fresh.firstChild) row.appendChild(fresh.firstChild);
    }
  }

  function applyMood(id) {
    var m = find(moodsOf(data), id);
    if (!m) return;
    pendingMood = { id: id, at: now() };
    redraw();
    post('/ambience/mood', { id: id }, safe(function (err, r, code) {
      if (!pendingMood || pendingMood.id !== id) return;
      pendingMood = null;
      if (err) setNote(failText(err, code), 'bad');
      else if (r.result === 'no-answer') setNote(T('moodGone', 'The plant wall didn’t answer.'), 'warn');
      else if (r.result === 'refused') setNote(T('errRefused', 'Home Assistant refused that.'), 'bad');
      else setNote(T('moodOn', 'Plant wall: {name}', { name: m.name }), 'ok');
      redraw();
    }));
  }

  /* ---------- keeping up ---------- */

  function signature() {
    var v = view();
    var L = window.HUB_I18N;
    var lang = '';
    try { lang = L && L.lang ? L.lang() : ''; } catch (e) { lang = ''; }
    return JSON.stringify([lang, v.kind, v.stale, v.big, v.meta, v.note, v.tone, v.active, v.lights, v.scenes, v.moods, data && data.wled,
      pendingScene && pendingScene.id, pendingMood && pendingMood.id]);
  }

  function redraw() {
    if (!C) return;
    lastSig = signature();
    C.redrawTile();
    if (page && C.isOpen && C.isOpen()) C.redrawPanel();
  }

  function refresh(force) {
    if (!C) return;
    var sig = signature();
    if (!force && sig === lastSig) return;
    redraw();
  }

  function remember(d) {
    var ls = list(d && d.lights);
    for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].on && ls[i].pct > 0) known[ls[i].id] = ls[i].pct;
  }

  function onLang() {
    if (!C) return;
    if (C.isOpen && C.isOpen()) {
      var pt = document.querySelector('#panel .panel-title');
      if (pt) pt.textContent = T('title', 'Ambience');
    }
    if (C.retitle) C.retitle();
    refresh(true);
  }

  /* ---------- the widget ---------- */

  var w = {
    id: 'ambience',
    icon: 'bulb',

    init: safe(function (ctx) {
      C = ctx;
      if (ctx.live) {
        var held = ctx.live.get('ambience');
        if (held && typeof held === 'object') { data = held; remember(held); }
        ctx.live.on('ambience', safe(function (d) {
          data = d && typeof d === 'object' ? d : null;
          remember(data);
          // The Pi's push confirms a scene that was on its way.
          if (pendingScene && data && data.active === pendingScene.id) pendingScene = null;
          refresh(false);
        }));
        ctx.live.onStatus(safe(function () { refresh(false); }));
      }
      try {
        var L = window.HUB_I18N;
        if (L && typeof L.onChange === 'function') L.onChange(safe(onLang));
      } catch (e) { /* stays in the language it started in */ }
    }),

    renderTile: function (body, ctx) {
      C = ctx;
      lastSig = signature();
      drawTile(body, ctx);
    },

    renderPanel: function (body, ctx) {
      C = ctx;
      page = null;
      try {
        drawPanel(body, ctx);
        // Always listening; each touch asks ctx.tablet then (it can turn on a moment after start).
        touchBars(body);
      } catch (e) {
        if (window.console && console.warn) console.warn('Ambience panel: ' + (e && e.message));
        page = null;
        body.innerHTML = '';
        el('div', 'am-fallback', body, T('broken', 'Ambience couldn’t be shown.'));
      }
    },

    onFocus: safe(function (target) {
      if (!page) return;
      if (target && target.getAttribute && target.getAttribute('data-scene')) {
        lastCard = target.getAttribute('data-scene');
        railTo(target);
      }
      paintFoot(target);
    }),

    onSelect: safe(function (target) {
      if (!target || !target.getAttribute) return;
      var s = target.getAttribute('data-scene');
      var l = target.getAttribute('data-light');
      var m = target.getAttribute('data-mood');
      if (s) applyScene(s);
      else if (l) changeLight(l, 0);
      else if (m) applyMood(m);
    }),

    onMove: safe(function (dir, from) {
      if (!page || !from || !from.getAttribute) return undefined;
      var cards = page.cards;
      var rows = page.rows;
      var chips = page.chips;
      var at;
      var cardBack = function () {
        for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-scene') === lastCard) return cards[i];
        for (var j = 0; j < cards.length; j++) if (hasClass(cards[j], 'is-active')) return cards[j];
        return cards[0] || null;
      };
      if (from.getAttribute('data-scene')) {
        at = cards.indexOf(from);
        if (dir === 'left') return at > 0 ? cards[at - 1] : true;
        if (dir === 'right') return at < cards.length - 1 ? cards[at + 1] : true;
        if (dir === 'down') return rows[0] || chips[0] || true;
        return undefined;   // Up: the hub's Full screen button
      }
      if (from.getAttribute('data-light')) {
        at = rows.indexOf(from);
        if (dir === 'left' || dir === 'right') { changeLight(from.getAttribute('data-light'), dir === 'left' ? -1 : 1); return true; }
        if (dir === 'up') return at > 0 ? rows[at - 1] : (cardBack() || undefined);
        if (dir === 'down') return at < rows.length - 1 ? rows[at + 1] : (chips[0] || true);
      }
      if (from.getAttribute('data-mood')) {
        at = chips.indexOf(from);
        if (dir === 'left') return at > 0 ? chips[at - 1] : true;
        if (dir === 'right') return at < chips.length - 1 ? chips[at + 1] : true;
        if (dir === 'up') return rows[rows.length - 1] || cardBack() || undefined;
        if (dir === 'down') return true;
      }
      // From the Full screen button: Down goes to the scenes.
      if (dir === 'down') return cardBack() || rows[0] || chips[0] || undefined;
      return undefined;
    }),

    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onClose: function () { page = null; clearSub(); },
    onStatus: safe(function () { refresh(false); })
  };
  // Read whenever the hub draws a title, so it follows the language.
  Object.defineProperty(w, 'title', {
    get: function () { return T('title', 'Ambience'); }, enumerable: true, configurable: true
  });
  // For tests: what the widget holds (never sent anywhere).
  window.HUB_AMBIENCE_DEBUG = function () {
    return { pendingScene: pendingScene, pendingLight: Object.keys(pendingLight), note: note && note.text };
  };
  return w;
})());
