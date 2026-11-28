/*
 * Moods: the plant wall's moods from the TV and the wall tablet (one tap or
 * one OK sets the whole wall: vases, the three painting halos and, when
 * paired, the lamp and bars).
 *
 * Everything comes from the Pi (pi/moods/, plan WP4) through the live line,
 * as the resource "moods": { state, problem, now, moods: [...], wall, last }.
 * Each mood carries its name and description in English and Spanish, four
 * swatches, tags (mic, song, pi, approx) and a preview (pv) that
 * app/moods-wall.js paints onto the drawing of the wall made from
 * wall.geometry. The TV never talks to the wall: choices go back to the Pi as
 * saved ids only, ctx.live.post('/moods/set', { id } | { off: true }, with
 * bri, night and pair), the way Ambience sends its scenes.
 *
 * The tile (docs/tile-sizes.md): one column, the icon and a lit dot; a strip,
 * the mood's name and its four swatches; two rows, a small wall and the name;
 * wide or tall, the lit wall big with the name and description. While the Pi
 * is out of reach the tile waits quietly (hub-dormant).
 *
 * The panel and full screen (remote only, no typing): on the left the hero
 * wall, the mood's name and description, and one control list (Brightness:
 * five pips, Left/Right; Lamp and bars: OK switches; Night 1 to 8, Menorah
 * only, Left/Right). On the right the rail: two labelled rows ("Whole wall",
 * "Vases"), Off first. Focus on a card previews it in the hero at once
 * ("Preview"); OK applies it ("Sending...", then the Pi's push confirms it or
 * it rolls back with a plain line). Back from a preview returns the hero to
 * what is on. Not set up, not answering and changed somewhere else each say so.
 *
 * Words: English here, Spanish in app/i18n.js under 'moods.'. Plain ES5; only
 * transform and opacity animate (moods.css).
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var C = null;            // a ctx, kept from init for the live hooks
  var data = null;         // the last moods resource from the Pi, or null
  var page = null;         // the open panel's parts, or null
  var lastSig = '';
  var pending = null;      // { id, at } while a mood (or 'off') is on its way
  var preview = null;      // the mood id focus is previewing in the hero ('off' for Off)
  var localBri = {};       // id -> pct shown at once while it is sent
  var localNight = null;   // Menorah's night shown at once
  var localPair = null;    // true / false once changed here, until the Pi says
  var sendTimer = null;
  var note = null;         // { text, kind, at } in the panel head
  var noteTimer = null;
  var lastTap = null;      // { node, at }: the last click inside the panel (tablet pips)
  var lastCtl = 'ctl:bri'; // the control focused last
  var lastCard = {};       // row -> card key focused last
  var PENDING_MS = 12000;
  var SEND_MS = 360;
  var NOTE_MS = 6000;
  var BRI = [20, 40, 60, 80, 100];

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
      try { return String(L.t('moods.' + key, en, vars)); } catch (e) { /* English */ }
    }
    return en.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m; });
  }

  function lang() {
    var L = window.HUB_I18N;
    try { return L && L.lang ? L.lang() : 'en'; } catch (e) { return 'en'; }
  }

  function now() { return new Date().getTime(); }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function list(v) { return isArr(v) ? v : []; }
  function str(v, max) { var s = typeof v === 'string' ? v : ''; return s.length > max ? s.slice(0, max) : s; }
  function hasClass(node, c) { return !!node && (' ' + node.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  function isHex(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s); }

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) {
        if (window.console && console.warn) console.warn('Moods: ' + (e && e.message));
        return undefined;
      }
    };
  }

  function rgba(hex, a) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    var r = m ? parseInt(m[1], 16) : 255, g = m ? parseInt(m[2], 16) : 214, b = m ? parseInt(m[3], 16) : 170;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  }

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

  var GLYPH = {
    power: '<path d="M12 3.5v8"/><path d="M7 6.6a7.5 7.5 0 1 0 10 0"/>',
    sparkle: '<path d="M11 3l1.8 4.9L17.5 9.7l-4.7 1.8L11 16.5l-1.8-5L4.5 9.7l4.7-1.8z"/><path d="M18.5 14.5l.8 2.1 2.2.9-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.9z"/>',
    left: '<path d="M14.5 6L8.5 12l6 6"/>',
    right: '<path d="M9.5 6l6 6-6 6"/>'
  };
  function glyph(name, cls, parent) {
    var box = el('span', 'md-glyph ' + (cls || ''), parent);
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' + (GLYPH[name] || GLYPH.sparkle) + '</svg>';
    return box;
  }

  /* ---------- reading the data ---------- */

  function moodsOf(d) {
    var out = [];
    var src = list(d && d.moods);
    for (var i = 0; i < src.length && out.length < 40; i++) {
      var m = src[i];
      if (!m || typeof m.id !== 'string' || m.hidden === true || m.id === 'off') continue;
      var sw = [];
      for (var k = 0; k < list(m.sw).length && sw.length < 4; k++) if (isHex(m.sw[k])) sw.push(m.sw[k]);
      var tags = [];
      for (var t = 0; t < list(m.tags).length; t++) if (/^(mic|song|pi|approx)$/.test(m.tags[t]) && tags.indexOf(m.tags[t]) < 0) tags.push(m.tags[t]);
      var night = m.param && m.param.night && typeof m.param.night === 'object' ? m.param.night : null;
      out.push({
        id: m.id, name: str(m.name, 48) || m.id, es: str(m.es, 60), desc: str(m.desc, 140), descEs: str(m.descEs, 170),
        group: m.group === 'vases' ? 'vases' : 'wall', sw: sw, tags: tags,
        bri: typeof m.bri === 'number' ? Math.max(10, Math.min(100, Math.round(m.bri))) : 100,
        night: night ? { min: Math.max(1, night.min | 0 || 1), max: Math.min(8, night.max | 0 || 8), tonight: night.tonight | 0 || 0 } : null,
        pv: m.pv && typeof m.pv === 'object' ? m.pv : null
      });
    }
    return out;
  }

  function find(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function nameOf(m) { return !m ? T('off', 'Off') : lang() === 'es' && m.es ? m.es : m.name; }
  function descOf(m) { return !m ? T('offDesc', 'The wall goes back to how it was.') : lang() === 'es' && m.descEs ? m.descEs : m.desc; }

  function tagWord(t) {
    return t === 'mic' ? T('tag.mic', 'Mic') : t === 'song' ? T('tag.song', 'Song') : t === 'pi' ? T('tag.pi', 'Pi-drawn') : T('tag.approx', 'Approximate');
  }

  // What is on: the id (or null for off), as sent when a choice is on its way.
  function nowOf(d) {
    var n = d && d.now && typeof d.now === 'object' ? d.now : null;
    return n && typeof n.id === 'string' && n.id !== 'off' && n.id ? n.id : null;
  }
  function currentId() {
    if (pending && now() - pending.at < PENDING_MS) return pending.id === 'off' ? null : pending.id;
    return nowOf(data);
  }

  function briOf(id, m) {
    if (id && localBri[id]) return localBri[id];
    var n = data && data.now;
    if (n && n.id === id && typeof n.bri === 'number') return Math.max(10, Math.min(100, Math.round(n.bri)));
    return m ? m.bri : 100;
  }
  function pairOn() {
    if (localPair !== null) return localPair;
    var n = data && data.now;
    return !(n && n.pair === false);
  }
  function nightOf(m) {
    if (!m || !m.night) return null;
    if (localNight) return Math.max(m.night.min, Math.min(m.night.max, localNight));
    var n = data && data.now;
    // Not on: tonight's night from the Pi (8 outside Hanukkah), what it sets when none is sent.
    var v = n && n.id === m.id && typeof n.night === 'number' ? n.night : (m.night.tonight || m.night.max);
    return Math.max(m.night.min, Math.min(m.night.max, Math.round(v)));
  }

  // kind: ready, notset, error (the wall not answering), waiting, offline, update, liveoff.
  function view() {
    var live = C && C.live ? C.live : null;
    var ls = 'off';
    try { ls = live ? live.status().state : 'off'; } catch (e) { ls = 'off'; }
    var d = data;
    var v = { kind: 'ready', stale: false, changed: false, msg: '', hint: '', moods: [], cur: null, curId: null, note: '', noteKind: '' };
    if (!live || ls === 'off') {
      v.kind = 'liveoff';
      v.msg = T('liveOff', 'Live updates are off');
      v.hint = T('liveOffHint', 'Moods needs the Pi. Check HUB_CONFIG.live in config.js.');
      return v;
    }
    if (!d || typeof d !== 'object') {
      if (ls === 'live') {
        v.kind = 'update';
        v.msg = T('update', 'The Pi needs an update');
        v.hint = T('updateHint', 'On the Pi: git pull, then restart the hub.');
      } else {
        v.kind = ls === 'lost' ? 'offline' : 'waiting';
        v.msg = v.kind === 'offline' ? T('offline', 'Can’t reach the Pi') : T('waiting', 'Waiting for the Pi');
        v.hint = T('waitingHint', 'The moods come from the Pi.');
      }
      return v;
    }
    v.stale = ls !== 'live' && ls !== 'connecting';
    v.moods = moodsOf(d);
    if (d.state === 'notset' || !v.moods.length) {
      v.kind = 'notset';
      v.msg = T('notSet', 'Not set up');
      v.hint = T('notSetHint', 'The Pi doesn’t know the wall’s address yet.');
      return v;
    }
    v.curId = currentId();
    v.cur = find(v.moods, v.curId);
    if (!v.cur) v.curId = null;
    if (d.state === 'error') {
      v.kind = 'error';
      v.note = T('wallAway', 'The wall isn’t answering');
      v.noteKind = 'bad';
    } else if (d.now && d.now.stale === true && !pending) {
      v.changed = true;
      v.note = T('changed', 'Changed somewhere else');
      v.noteKind = 'warn';
    } else if (d.last && d.last.result === 'partial' && v.cur) {
      v.note = T('partial', 'Part of the wall didn’t answer');
      v.noteKind = 'warn';
    }
    return v;
  }

  /* ---------- pieces ---------- */

  function swatches(parent, m, cls) {
    var row = el('span', 'md-sw ' + (cls || ''), parent);
    var sw = m ? m.sw : [];
    for (var i = 0; i < 4; i++) {
      var dot = el('i', 'md-sw-dot' + (sw[i] ? '' : ' is-dark'), row);
      if (sw[i]) { dot.style.backgroundColor = sw[i]; dot.style.boxShadow = '0 0 0.45rem ' + rgba(sw[i], 0.55); }
    }
    if (m && m.pv && isHex(m.pv.glint)) {
      var g = el('i', 'md-sw-glint', row);
      g.style.backgroundColor = m.pv.glint;
      g.style.boxShadow = '0 0 0.4rem 0.08rem ' + rgba(m.pv.glint, 0.75);
    }
    return row;
  }

  function wallOf() { return data && data.wall && typeof data.wall === 'object' ? data.wall : null; }

  function drawWall(host, m, v, cls) {
    var W = window.HUB_MOODS_WALL;
    var wall = wallOf();
    if (!W || !wall || !wall.geometry) return null;
    var box = el('div', 'md-wallbox ' + (cls || ''), host);
    var view2 = W.build(box, wall);
    W.paint(view2, m ? m.pv : null, { level: m ? briOf(m.id, m) / 100 : 1, night: nightOf(m) });
    return view2;
  }

  function layoutFor(size) {
    if (!size) return 'small';
    if (size.cols <= 1) return 'one';
    if (size.tier === 'strip') return 'strip';
    if (size.width === 'narrow') return 'stack';
    if (size.tier === 'standard') return size.cols >= 6 ? 'side' : 'small';
    return 'hero';
  }

  /* ---------- the tile ---------- */

  function drawTile(body, ctx) {
    var size = ctx.size ? ctx.size() : null;
    var v = view();
    var layout = layoutFor(size);
    var root = el('div', 'md-tile md-l-' + layout + ' md-k-' + v.kind + (v.stale || v.changed ? ' is-stale' : ''), body);
    var dormant = v.kind === 'waiting' || v.kind === 'offline' || v.kind === 'update' || v.kind === 'liveoff';
    if (dormant) root.className += ' hub-dormant';
    if (ctx.setBadge) {
      ctx.setBadge(v.kind === 'notset' ? T('badge.setUp', 'Set up') : v.kind === 'error' ? T('badge.away', 'Not answering')
        : v.changed ? T('badge.changed', 'Changed') : v.stale && v.kind === 'ready' ? T('lastKnown', 'Last known') : '');
    }

    if (v.kind !== 'ready' && v.kind !== 'error') {
      if (layout === 'one') { glyph('sparkle', 'md-one-glyph is-quiet', root); root.title = v.msg; return; }
      if ((layout === 'hero' || layout === 'side') && v.kind === 'notset' && wallOf()) {
        var dim = drawWall(root, null, v, 'is-dim');
        if (dim) root.className += ' has-wall';
      }
      var msg = el('div', 'md-msg' + (dormant ? ' hub-quiet-line' : ''), root, v.msg);
      var hint = layout === 'strip' ? null : el('div', 'md-hint' + (dormant ? ' hub-quiet-hide' : ''), root, v.hint);
      fitBlocks(body, [hint], [msg]);
      return;
    }

    var m = v.cur;
    if (layout === 'one') {
      var dot = el('span', 'md-one-dot' + (m ? ' is-on' : ''), root);
      if (m && m.sw[0]) {
        dot.style.backgroundColor = m.sw[0];
        dot.style.boxShadow = '0 0 0.9rem 0.2rem ' + rgba(m.sw[0], 0.55);
      }
      root.title = nameOf(m);
      return;
    }

    if (layout === 'strip') {
      var line = el('div', 'md-sline', root);
      var swRow = swatches(line, m, 'md-sw-strip');
      var sname = el('div', 'md-name', line, nameOf(m));
      var sd = size && size.cols >= 6 ? el('div', 'md-desc', line, descOf(m)) : null;
      // The name gets the room: the description leaves, then the swatches
      // overlap, then one swatch stays.
      var cut = function () { return sname.scrollWidth > sname.clientWidth + 1 || line.scrollWidth > line.clientWidth + 1; };
      if (sd && cut()) sd.style.display = 'none';
      if (cut()) swRow.className += ' is-tight';
      if (cut()) swRow.className += ' is-one';
      return;
    }

    if (layout === 'stack') {
      swatches(root, m, 'md-sw-stack');
      var sn = el('div', 'md-name', root, nameOf(m));
      var sdesc = size && size.rows >= 3 ? el('div', 'md-desc', root, descOf(m)) : null;
      fitWords(body, sn, sdesc, null);
      return;
    }

    var wallHost = el('div', 'md-wallwrap', root);
    var wv = drawWall(wallHost, m, v, '');
    if (!wv) { wallHost.style.display = 'none'; swatches(root, m, 'md-sw-stack'); }
    var words = el('div', 'md-words', root);
    var kick = el('div', 'md-kick', words);
    el('i', 'md-kick-dot' + (m ? ' is-on' : ''), kick).style.backgroundColor = m && m.sw[0] ? m.sw[0] : '';
    el('span', 'md-kick-text', kick, v.kind === 'error' ? T('wallAway', 'The wall isn’t answering') : v.changed ? T('changed', 'Changed somewhere else') : m ? T('onNow', 'On now') : T('noMood', 'No mood on'));
    if (v.kind === 'error' || v.changed) kick.className += ' is-' + (v.kind === 'error' ? 'bad' : 'warn');
    var name = el('div', 'md-name', words, nameOf(m));
    var desc = layout === 'small' ? null : el('div', 'md-desc', words, descOf(m));
    var meta = null;
    if (layout === 'hero' && size && size.rows >= 5 && m) {
      meta = el('div', 'md-meta', words, T('metaLine', 'Brightness {n}% · Lamp and bars {pair}', { n: briOf(m.id, m), pair: pairOn() ? T('pairWithShort', 'with it') : T('pairLeaveShort', 'left alone') }));
    }
    fitWords(body, name, desc, meta, kick);
  }

  // Does everything sit inside the tile's body?
  function fits(body) {
    var box = body.getBoundingClientRect();
    var bad = false;
    function walk(node, depth) {
      for (var i = 0; i < node.childNodes.length && !bad; i++) {
        var c = node.childNodes[i];
        if (c.nodeType !== 1 || c.style.display === 'none' || (c.getAttribute && c.getAttribute('class') && /\bmw-/.test(c.getAttribute('class')))) continue;
        var r = c.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.bottom > box.bottom + 1 || r.right > box.right + 1) { bad = true; return; }
        if (depth < 3) walk(c, depth + 1);
      }
    }
    walk(body, 0);
    return !bad;
  }

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

  // The name keeps two lines as long as it can; the description and the meta line leave first.
  function fitWords(body, name, desc, meta, kick) {
    clamp(name, 2);
    if (desc) clamp(desc, 2);
    if (!fits(body) && meta) meta.style.display = 'none';
    if (!fits(body) && desc) clamp(desc, 1);
    if (!fits(body) && desc) clamp(desc, 0);
    if (!fits(body)) clamp(name, 1);
    if (!fits(body) && kick) kick.style.display = 'none';
  }

  /* ---------- the panel ---------- */

  function drawPanel(body, ctx) {
    var v = view();
    var full = ctx.mode && ctx.mode() === 'full';
    var root = el('div', 'md-page md-k-' + v.kind + (full ? ' is-full' : '') + (v.stale || v.changed ? ' is-stale' : '') + (ctx.tablet ? ' is-tablet' : ''), body);
    page = { root: root, v: v, full: full, rows: {}, cards: [], ctls: [] };
    if (v.kind !== 'ready' && v.kind !== 'error') {
      var box = el('div', 'md-empty', root);
      if (v.kind === 'notset' && wallOf()) drawWall(el('div', 'md-empty-wall', box), null, v, 'is-dim');
      else glyph('sparkle', 'md-empty-glyph', box);
      el('div', 'md-empty-title', box, v.msg);
      el('div', 'md-empty-hint', box, v.hint);
      if (v.kind === 'notset') el('div', 'md-empty-how', box, T('notSetHow', 'On the Pi: add WLED_URL to pi/.env, then restart the hub. ./hub moods probe checks it.'));
      return;
    }

    var left = el('div', 'md-left', root);
    var hero = el('div', 'md-hero', left);
    page.heroHost = el('div', 'md-hero-wall', hero);
    page.heroView = drawWall(page.heroHost, v.cur, v, 'is-hero');
    var chip = el('div', 'md-chip', hero);
    page.chipDot = el('i', 'md-chip-dot', chip);
    page.chipText = el('span', 'md-chip-text', chip);
    var cap = el('div', 'md-caption', left);
    page.capName = el('div', 'md-cap-name', cap);
    page.capDesc = el('div', 'md-cap-desc', cap);
    page.capTags = el('div', 'md-tags md-cap-tags', cap);

    var ctls = el('div', 'md-ctls', left);
    page.ctlBox = ctls;
    drawControls(ctls, v);

    var right = el('div', 'md-right', root);
    var groups = [['wall', T('rowWall', 'Whole wall')], ['vases', T('rowVases', 'Vases')]];
    for (var g = 0; g < groups.length; g++) {
      var sec = el('div', 'md-sec md-sec-' + groups[g][0], right);
      el('div', 'md-label', sec, groups[g][1]);
      var rail = el('div', 'md-rail', sec);
      var track = el('div', 'md-track', rail);
      var row = { name: groups[g][0], rail: rail, track: track, shift: 0, cards: [] };
      page.rows[groups[g][0]] = row;
      if (g === 0) row.cards.push(card(track, null, v, row.name));
      for (var i = 0; i < v.moods.length; i++) if (v.moods[i].group === groups[g][0]) row.cards.push(card(track, v.moods[i], v, row.name));
      page.cards = page.cards.concat(row.cards);
    }
    paintHero();
    paintStatus();
    // First focus: the card that is on (Off when nothing is).
    var first = null;
    for (var c = 0; c < page.cards.length; c++) if (hasClass(page.cards[c], 'is-active')) first = page.cards[c];
    first = first || page.cards[0];
    if (first) first.setAttribute('data-autofocus', '');
    // Each row shows its focused card, else the last one focused, else the one on.
    var mine = page;
    setTimeout(safe(function () { if (page === mine) syncRails(); }), 0);
  }

  function syncRails() {
    for (var name in page.rows) {
      if (!page.rows.hasOwnProperty(name)) continue;
      var row = page.rows[name];
      var pick = null;
      for (var i = 0; i < row.cards.length; i++) {
        var c = row.cards[i];
        if (hasClass(c, 'is-focused')) { pick = c; break; }
        if (!pick && c.getAttribute('data-key') === lastCard[name]) pick = c;
      }
      if (!pick) for (var j = 0; j < row.cards.length; j++) if (hasClass(row.cards[j], 'is-active')) pick = row.cards[j];
      if (pick) railTo(pick);
    }
  }

  function card(track, m, v, rowName) {
    var id = m ? m.id : 'off';
    var active = m ? v.curId === m.id : !v.curId;
    var sending = pending && pending.id === id && now() - pending.at < PENDING_MS;
    var node = el('div', 'f md-card' + (active ? ' is-active' : '') + (sending ? ' is-pending' : '') + (m ? '' : ' is-off'), track);
    node.setAttribute('data-key', 'mood:' + id);
    node.setAttribute('data-mood', id);
    node.setAttribute('data-row', rowName);
    if (active && m && m.sw[0]) {
      var ring = el('i', 'md-card-ring', node);
      ring.style.borderColor = rgba(m.sw[0], 0.85);
      ring.style.boxShadow = '0 0 1rem ' + rgba(m.sw[0], 0.35) + ', inset 0 0 1.2rem ' + rgba(m.sw[0], 0.16);
    }
    var top = el('div', 'md-card-top', node);
    if (m) swatches(top, m, 'md-sw-card');
    else glyph('power', 'md-card-power', top);
    el('div', 'md-card-name', node, nameOf(m));
    el('div', 'md-card-desc', node, descOf(m));
    var foot = el('div', 'md-tags md-card-foot', node);
    if (sending) el('span', 'md-state is-pending', foot, T('sending', 'Sending…'));
    else if (active) el('span', 'md-state is-on', foot, m ? T('onNow', 'On now') : T('offNow', 'Off now'));
    var tags = m ? m.tags : [];
    for (var t = 0; t < tags.length && t < (sending || active ? 1 : 2); t++) el('span', 'md-tag', foot, tagWord(tags[t]));
    return node;
  }

  function drawControls(box, v) {
    var m = v.cur;
    // Brightness: five pips.
    var bri = el('div', 'f md-ctl md-ctl-bri' + (m ? '' : ' is-idle'), box);
    bri.setAttribute('data-key', 'ctl:bri');
    bri.setAttribute('data-ctl', 'bri');
    el('span', 'md-ctl-label', bri, T('bri', 'Brightness'));
    var pips = el('span', 'md-pips', bri);
    var pct = m ? briOf(m.id, m) : 0;
    for (var i = 0; i < BRI.length; i++) {
      var p = el('i', 'md-pip' + (m && pct >= BRI[i] - 9 ? ' is-on' : ''), pips);
      p.setAttribute('data-pip', String(BRI[i]));
      el('b', 'md-pip-dot', p);
      if (m && m.sw[0]) p.style.color = m.sw[0];
    }
    el('span', 'md-ctl-value', bri, m ? T('pct', '{n}%', { n: pct }) : T('offShort', 'Off'));
    page.ctls.push(bri);

    // Lamp and bars: with the mood, or leave them as they are.
    var on = pairOn();
    var pair = el('div', 'f md-ctl md-ctl-pair', box);
    pair.setAttribute('data-key', 'ctl:pair');
    pair.setAttribute('data-ctl', 'pair');
    el('span', 'md-ctl-label', pair, T('pair', 'Lamp and bars'));
    var sw = el('span', 'md-switch' + (on ? ' is-on' : ''), pair);
    el('span', 'md-switch-text', sw, on ? T('pairWith', 'With the mood') : T('pairLeave', 'Leave as they are'));
    el('b', 'md-toggle', sw);
    page.ctls.push(pair);

    // Menorah's night, 1 to 8.
    if (m && m.night) {
      var n = nightOf(m);
      var ni = el('div', 'f md-ctl md-ctl-night', box);
      ni.setAttribute('data-key', 'ctl:night');
      ni.setAttribute('data-ctl', 'night');
      el('span', 'md-ctl-label', ni, T('night', 'Night'));
      var step = el('span', 'md-step', ni);
      var dn = glyph('left', 'md-step-btn' + (n <= m.night.min ? ' is-end' : ''), step);
      dn.setAttribute('data-step', '-1');
      el('span', 'md-step-value', step, T('nightOf', '{n} of {max}', { n: n, max: m.night.max }));
      var up = glyph('right', 'md-step-btn' + (n >= m.night.max ? ' is-end' : ''), step);
      up.setAttribute('data-step', '1');
      var candles = el('span', 'md-candles', ni);
      for (var k = 1; k <= m.night.max; k++) el('i', 'md-candle' + (k <= n ? ' is-lit' : ''), candles);
      page.ctls.push(ni);
    }
  }

  // The hero shows the focused card's mood (Preview) or what is on.
  function paintHero() {
    if (!page || page.v.kind === 'notset') return;
    var v = page.v;
    var curId = currentId();
    var showId = preview !== null ? preview : (curId || 'off');
    var m = showId === 'off' ? null : find(v.moods, showId);
    var isPreview = preview !== null && (preview === 'off' ? curId !== null : preview !== curId);
    if (page.heroView && window.HUB_MOODS_WALL) {
      window.HUB_MOODS_WALL.paint(page.heroView, m ? m.pv : null, { level: m ? briOf(m.id, m) / 100 : 1, night: nightOf(m) });
    }
    var pend = pending && now() - pending.at < PENDING_MS && pending.id === showId;
    page.chipText.textContent = pend ? T('sending', 'Sending…') : isPreview ? T('preview', 'Preview') : m ? T('onNow', 'On now') : T('offNow', 'Off now');
    page.chipText.parentNode.className = 'md-chip' + (isPreview ? ' is-preview' : m ? ' is-on' : ' is-off') + (pend ? ' is-pending' : '');
    page.chipDot.style.backgroundColor = m && m.sw[0] && !isPreview ? m.sw[0] : '';
    page.capName.textContent = nameOf(m);
    page.capDesc.textContent = descOf(m);
    while (page.capTags.firstChild) page.capTags.removeChild(page.capTags.firstChild);
    var tags = m ? m.tags : [];
    for (var i = 0; i < tags.length; i++) el('span', 'md-tag', page.capTags, tagWord(tags[i]));
    page.root.className = page.root.className.replace(/\s*is-previewing/g, '') + (isPreview ? ' is-previewing' : '');
  }

  function paintStatus() {
    if (!page || !C || !C.setSub) return;
    var v = page.v;
    var text = page.hint || '';
    var kind = '';
    if (note && now() - note.at < NOTE_MS) { text = note.text; kind = note.kind; }
    else if (v.note) { text = v.note; kind = v.noteKind; }
    C.setSub(text);
    var sub = document.querySelector('#panel .panel-sub');
    if (sub) sub.className = sub.className.replace(/\s*md-sub-\w+/g, '') + (kind === 'warn' || kind === 'bad' ? ' md-sub-' + kind : '');
  }

  function clearSub() {
    var sub = document.querySelector('#panel .panel-sub');
    if (sub) sub.className = sub.className.replace(/\s*md-sub-\w+/g, '');
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
    var k = target && target.getAttribute ? (target.getAttribute('data-ctl') || (target.getAttribute('data-mood') ? 'mood' : '')) : '';
    if (k === 'mood') text = C && C.tablet ? T('hintCardTap', 'Tap sets the wall') : T('hintCard', 'OK sets the wall · Back shows what is on');
    else if (k === 'bri') text = currentId() ? T('hintBri', '◀ ▶ dimmer or brighter') : T('hintBriOff', 'Pick a mood first');
    else if (k === 'pair') text = T('hintPair', 'OK switches · ▶ back to the moods');
    else if (k === 'night') text = T('hintNight', '◀ ▶ picks the night');
    page.hint = text;
    paintStatus();
  }

  // Keeps the focused card in view (instant: focus never animates). The
  // rail snaps to a card's left edge, so the first card showing is whole.
  function railTo(cardNode) {
    if (!page || !cardNode) return;
    var row = page.rows[cardNode.getAttribute('data-row')];
    if (!row) return;
    var cs = window.getComputedStyle(row.rail);
    var seen = row.rail.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (seen <= 0) return;
    var left = cardNode.offsetLeft;
    var right = left + cardNode.offsetWidth;
    var shift = row.shift || 0;
    if (left < shift) shift = left;
    else if (right > shift + seen) {
      shift = right - seen;
      for (var i = 0; i < row.cards.length; i++) {
        if (row.cards[i].offsetLeft >= shift) { shift = Math.min(left, row.cards[i].offsetLeft); break; }
      }
    }
    var last = row.cards[row.cards.length - 1];
    var max = Math.max(0, (last ? last.offsetLeft + last.offsetWidth : 0) - seen);
    if (shift > max && left >= max) shift = max;
    shift = Math.max(0, shift);
    row.shift = shift;
    row.track.style.webkitTransform = 'translateX(' + (-shift) + 'px)';
    row.track.style.transform = 'translateX(' + (-shift) + 'px)';
  }

  /* ---------- sending ---------- */

  function failText(err, code) {
    if (code === 429) return T('errBusy', 'Too many presses. Try again in a moment.');
    if (code === 409) return T('errNotSet', 'The wall isn’t set up on the Pi yet.');
    if (code === 400) return T('errGone', 'That mood isn’t saved on the Pi any more.');
    if (code === 502 || code === 503 || code === 504) return T('errWall', 'The wall didn’t answer. Nothing changed.');
    return T('errPi', 'Couldn’t reach the Pi. Nothing changed.');
  }

  function post(body, cb) {
    if (!C || !C.live || typeof C.live.post !== 'function') { cb('live updates are off', null, 0); return; }
    C.live.post('/moods/set', body, cb);
  }

  // The Pi may answer with the whole resource, or with what is on now.
  function adopt(r) {
    if (!r || typeof r !== 'object') return;
    if (r.moods && typeof r.moods === 'object' && !isArr(r.moods) && r.moods.now !== undefined) data = r.moods;
    else if (r.now && typeof r.now === 'object' && data) data.now = r.now;
  }

  function apply(id) {
    var v = view();
    var m = id === 'off' ? null : find(v.moods, id);
    if (id !== 'off' && !m) return;
    if (currentId() !== id) localNight = null; // a night stepped earlier was for the mood on then
    var mine = { id: id, at: now() };
    pending = mine;
    preview = null;
    localBri = {};
    setNote(T('sending', 'Sending…'), 'ok');
    redraw();
    var body = id === 'off' ? { off: true } : { id: id };
    if (localPair !== null) body.pair = localPair;
    // Only a night a person stepped: otherwise the Pi keeps the night on now, or tonight's.
    if (m && m.night && localNight !== null) body.night = nightOf(m);
    post(body, safe(function (err, r, code) {
      if (pending && pending !== mine) return;
      if (err || (r && r.result === 'failed')) {
        pending = null;
        setNote(err ? failText(err, code) : T('errWall', 'The wall didn’t answer. Nothing changed.'), 'bad');
      } else {
        adopt(r);
        if (nowOf(data) === (id === 'off' ? null : id)) pending = null;
        if (r && r.result === 'partial') setNote(T('partial', 'Part of the wall didn’t answer'), 'warn');
        else setNote(m ? T('moodOn', '{name} is on', { name: nameOf(m) }) : T('offDone', 'The wall is back to how it was'), 'ok');
      }
      redraw();
    }));
  }

  // A brightness, night or pairing change for what is on: shown at once, sent once the arrows rest.
  function sendLater(build) {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(function () {
      sendTimer = null;
      var body = build();
      if (!body) return;
      post(body, safe(function (err, r, code) {
        if (err) {
          localBri = {};
          localNight = null;
          setNote(failText(err, code), 'bad');
        } else adopt(r);
        redraw();
      }));
    }, SEND_MS);
  }

  function changeBri(dir, toPct) {
    var id = currentId();
    var m = find(moodsOf(data), id);
    if (!m) { setNote(T('hintBriOff', 'Pick a mood first'), 'warn'); return; }
    var cur = briOf(id, m);
    var at = 0;
    for (var i = 0; i < BRI.length; i++) if (Math.abs(BRI[i] - cur) < Math.abs(BRI[at] - cur)) at = i;
    var next = toPct || BRI[Math.max(0, Math.min(BRI.length - 1, at + dir))];
    if (next === cur) return;
    localBri[id] = next;
    repaintControls();
    paintHero();
    sendLater(function () { return currentId() === id ? { id: id, bri: next } : null; });
  }

  function changeNight(dir) {
    var id = currentId();
    var m = find(moodsOf(data), id);
    if (!m || !m.night) return;
    var cur = nightOf(m);
    var next = Math.max(m.night.min, Math.min(m.night.max, cur + dir));
    if (next === cur) return;
    localNight = next;
    repaintControls();
    paintHero();
    sendLater(function () { return currentId() === id ? { id: id, night: next } : null; });
  }

  function togglePair(want) {
    var next = typeof want === 'boolean' ? want : !pairOn();
    if (next === pairOn()) return;
    localPair = next;
    repaintControls();
    var id = currentId();
    if (id) sendLater(function () { return { id: id, pair: next }; });
    var n = data && data.now;
    if (next && n && n.govee === 'music') setNote(T('pairMusic', 'Music lights are on, so the lamp and bars stay as they are'), 'warn');
  }

  // Redraws the control list in place, keeping focus on the same control.
  function repaintControls() {
    if (!page || !page.ctlBox) return;
    var focused = '';
    for (var i = 0; i < page.ctls.length; i++) if (hasClass(page.ctls[i], 'is-focused')) focused = page.ctls[i].getAttribute('data-key');
    while (page.ctlBox.firstChild) page.ctlBox.removeChild(page.ctlBox.firstChild);
    page.ctls = [];
    var v = page.v;
    v.curId = currentId();
    v.cur = find(v.moods, v.curId);
    drawControls(page.ctlBox, v);
    for (var j = 0; j < page.ctls.length; j++) {
      if (page.ctls[j].getAttribute('data-key') === focused) {
        if (C && C.focus) C.focus(page.ctls[j]); else page.ctls[j].className += ' is-focused';
      }
    }
  }

  /* ---------- keeping up ---------- */

  function signature() {
    var v = view();
    return JSON.stringify([lang(), v.kind, v.stale, v.changed, v.note, v.curId, data && data.now, data && data.moods, data && data.wall ? 1 : 0,
      pending && pending.id, localPair]);
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

  function onLang() {
    if (!C) return;
    if (C.isOpen && C.isOpen()) {
      var pt = document.querySelector('#panel .panel-title');
      if (pt) pt.textContent = T('title', 'Moods');
    }
    if (C.retitle) C.retitle();
    refresh(true);
  }

  function listenTaps(body) {
    if (body.__mdTaps) return;
    body.__mdTaps = true;
    body.addEventListener('click', function (e) { lastTap = { node: e.target, at: now() }; }, false);
  }

  function tapped(attr) {
    if (!lastTap || now() - lastTap.at > 600) return null;
    for (var n = lastTap.node; n && n.getAttribute; n = n.parentNode) {
      var a = n.getAttribute(attr);
      if (a !== null && a !== undefined) return a;
      if (hasClass(n, 'f')) break;
    }
    return null;
  }

  /* ---------- the widget ---------- */

  var w = {
    id: 'moods',
    icon: 'sparkle',

    init: safe(function (ctx) {
      C = ctx;
      if (ctx.live) {
        var held = ctx.live.get('moods');
        if (held && typeof held === 'object') data = held;
        ctx.live.on('moods', safe(function (d) {
          data = d && typeof d === 'object' ? d : null;
          // The Pi's push confirms a choice on its way, and says what is on.
          if (pending && nowOf(data) === (pending.id === 'off' ? null : pending.id)) pending = null;
          var n = data && data.now;
          if (n && typeof n.pair === 'boolean' && n.pair === localPair) localPair = null;
          if (n && typeof n.night === 'number' && n.night === localNight) localNight = null;
          if (n && n.id && localBri[n.id] && n.bri === localBri[n.id]) delete localBri[n.id];
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
        listenTaps(body);
      } catch (e) {
        if (window.console && console.warn) console.warn('Moods panel: ' + (e && e.message));
        page = null;
        body.innerHTML = '';
        el('div', 'md-fallback', body, T('broken', 'Moods couldn’t be shown.'));
      }
    },

    onFocus: safe(function (target) {
      if (!page) return;
      var id = target && target.getAttribute ? target.getAttribute('data-mood') : null;
      if (id) {
        lastCard[target.getAttribute('data-row')] = target.getAttribute('data-key');
        railTo(target);
        // A tablet has no focus to preview with: a tap applies at once.
        preview = C && C.tablet ? null : id;
      } else {
        if (target && target.getAttribute && target.getAttribute('data-ctl')) lastCtl = target.getAttribute('data-key');
        preview = null;
      }
      paintHero();
      paintFoot(target);
    }),

    onSelect: safe(function (target) {
      if (!target || !target.getAttribute) return;
      var id = target.getAttribute('data-mood');
      var k = target.getAttribute('data-ctl');
      if (id) { apply(id); return; }
      if (k === 'pair') {
        togglePair();
      } else if (k === 'bri') {
        var pip = tapped('data-pip');
        if (pip) changeBri(0, Number(pip));
      } else if (k === 'night') {
        var st = tapped('data-step');
        if (st) changeNight(Number(st));
      }
    }),

    onMove: safe(function (dir, from) {
      if (!page || !from || !from.getAttribute) return undefined;
      var rowW = page.rows.wall, rowV = page.rows.vases;
      var ctls = page.ctls;
      function remembered(row) {
        if (!row) return null;
        for (var i = 0; i < row.cards.length; i++) if (row.cards[i].getAttribute('data-key') === lastCard[row.name]) return row.cards[i];
        for (var j = 0; j < row.cards.length; j++) if (hasClass(row.cards[j], 'is-active')) return row.cards[j];
        return row.cards[0] || null;
      }
      function ctlBack() {
        for (var i = 0; i < ctls.length; i++) if (ctls[i].getAttribute('data-key') === lastCtl) return ctls[i];
        return ctls[0] || null;
      }
      var id = from.getAttribute('data-mood');
      if (id) {
        var row = page.rows[from.getAttribute('data-row')];
        var at = row.cards.indexOf(from);
        if (dir === 'left') return at > 0 ? row.cards[at - 1] : (ctlBack() || true);
        if (dir === 'right') return at < row.cards.length - 1 ? row.cards[at + 1] : true;
        var other = row === rowW ? rowV : rowW;
        if (dir === 'down') return row === rowW && other && other.cards.length ? (remembered(other)) : true;
        if (dir === 'up') return row === rowV && other && other.cards.length ? remembered(other) : undefined;
      }
      var k = from.getAttribute('data-ctl');
      if (k) {
        var ci = ctls.indexOf(from);
        if (dir === 'left' || dir === 'right') {
          var d = dir === 'left' ? -1 : 1;
          if (k === 'bri') { changeBri(d); return true; }
          if (k === 'night') { changeNight(d); return true; }
          if (k === 'pair') return dir === 'right' ? (remembered(rowW) || true) : true;
        }
        if (dir === 'up') return ci > 0 ? ctls[ci - 1] : undefined;
        if (dir === 'down') return ci < ctls.length - 1 ? ctls[ci + 1] : true;
      }
      // From the hub's Full screen button: Down goes to the rail.
      if (dir === 'down') return remembered(rowW) || ctls[0] || undefined;
      return undefined;
    }),

    // Back while a preview shows: the hero returns to what is on (focus too).
    onBack: safe(function () {
      if (!page || preview === null) return false;
      var curId = currentId() || 'off';
      if (preview === curId) return false;
      preview = null;
      var to = null;
      for (var i = 0; i < page.cards.length; i++) if (page.cards[i].getAttribute('data-mood') === curId) to = page.cards[i];
      if (to && C && C.focus) C.focus(to);
      paintHero();
      return true;
    }),

    backHint: function () {
      if (!page || preview === null) return undefined;
      var curId = currentId() || 'off';
      return preview !== curId ? T('backPreview', 'Back shows what is on') : undefined;
    },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onClose: function () { page = null; preview = null; clearSub(); },
    onStatus: safe(function () { refresh(false); })
  };
  Object.defineProperty(w, 'title', {
    get: function () { return T('title', 'Moods'); }, enumerable: true, configurable: true
  });
  // For tests: what the widget holds (never sent anywhere).
  window.HUB_MOODS_DEBUG = function () {
    return { pending: pending && pending.id, preview: preview, current: currentId(), localPair: localPair, note: note && note.text };
  };
  return w;
})());
