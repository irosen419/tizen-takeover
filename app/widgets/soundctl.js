/*
 * Sound control (test widget): All sounds (allsounds.js, kept as it is) plus
 * a control panel for the Echo speakers. The tile is the All sounds tile,
 * drawn the same way; the page and full screen add, under what is playing, a
 * speaker row, Play/Pause, Next, Volume down and up, Stop, and a few quick
 * starts (an audiobook, KERA, the news, Pandora, Amazon Music).
 *
 * It reads the same "allsounds" resource from the Pi (pi/allsounds.js), which
 * now also carries `echos` (the speakers: key, name, state, volume, app) and
 * `target` (the speaker shown). Buttons send POST /echo/run through the live
 * line (ctx.live.post), as Ambience sends its scenes: "Sending..." at once,
 * then what happened, in our own words (the Pi's English is never shown).
 * The Pi only accepts presets from the TV, and the TV never sees a Home
 * Assistant address or token. Without `echos` (an older Pi, or not set up)
 * the page is just All sounds.
 *
 * Every word on screen goes through HUB_I18N ('soundctl.*' keys), and a
 * language change redraws the tile and an open page.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var C = null;            // a ctx, kept from init for the live hooks
  var data = null;         // the last resource data from the Pi, or null
  var tiles = [];          // the drawn tile cards
  var page = null;         // the open page's parts, or null
  var lastSig = '';
  var lastCtlSig = '';
  var sel = null;          // the speaker the person picked (a key), until the page closes
  var pend = null;         // { key, state, at }: Play/Pause shown before the Pi confirms
  var pendVol = null;      // { key, value, at }: the volume shown before the Pi confirms
  var note = null;         // { text, kind: 'ok'|'bad', at } shown in the panel head
  var noteTimer = null;
  var pendTimer = null;
  var seq = 0;             // the newest send; an older reply never overwrites its note
  var PENDING_MS = 12000;
  var NOTE_MS = 6000;
  var APP_KEY = /^[a-z0-9-]{1,20}$/;

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
      try { return String(L.t('soundctl.' + key, en, vars)); } catch (e) { /* English */ }
    }
    return en.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m; });
  }

  function rem() {
    return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  }

  function icon(name) { return (window.HUB_ICONS && window.HUB_ICONS[name]) || ''; }

  function str(v, max) {
    var s = typeof v === 'string' ? v : '';
    return s.length > max ? s.slice(0, max) : s;
  }

  function outer(node) {
    if (!node || node.offsetHeight === 0) return 0;
    var cs = window.getComputedStyle(node);
    return node.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }

  function lineHeight(node) {
    return parseFloat(window.getComputedStyle(node).lineHeight) || 20;
  }

  // Ends a text in "..." after n lines (old WebKit's line clamp); 0 hides it.
  function clamp(node, n) {
    if (!node) return;
    node.style.display = '';
    node.style.webkitLineClamp = '';
    node.style.webkitBoxOrient = '';
    node.style.overflow = '';
    if (n <= 0) { node.style.display = 'none'; return; }
    node.style.display = '-webkit-box';
    node.style.webkitBoxOrient = 'vertical';
    node.style.webkitLineClamp = String(n);
    node.style.overflow = 'hidden';
  }

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        if (window.console && console.warn) console.warn('Sound control: ' + (e && e.message));
        return undefined;
      }
    };
  }

  /* ---------- what to show ---------- */

  // Only absolute https pictures (http on a laptop preview, never a relative
  // address, which would be the Pi's or Home Assistant's).
  function artUrl(s) {
    s = str(s, 600);
    if (/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return s;
    if (/^http:\/\/127\.0\.0\.1[:\/][^\s"'<>\\]*$/i.test(s)) return s;
    return '';
  }

  // kind: playing, paused, idle, notset, error, waiting, offline, update.
  // A view with "song" true has words to show; one without has a message.
  function view() {
    var live = C && C.live ? C.live : null;
    var liveState = 'off';
    try { liveState = live ? live.status().state : 'off'; } catch (e) { liveState = 'off'; }
    var d = data;
    var v = { kind: 'waiting', song: false, label: '', title: '', sub: '', album: '', source: '', device: '', art: '', msg: '', hint: '' };

    if (!live || liveState === 'off') {
      v.kind = 'update';
      v.msg = T('liveOff', 'Live updates are off');
      v.hint = T('liveOffHint', 'Sound control needs the Pi. Check HUB_CONFIG.live in config.js.');
      return v;
    }
    if (liveState !== 'live' && !(d && liveState === 'connecting')) {
      v.kind = liveState === 'lost' ? 'offline' : 'waiting';
      v.msg = v.kind === 'offline' ? T('offline', 'Can’t reach the Pi') : T('waiting', 'Waiting for the Pi');
      v.hint = v.kind === 'offline' ? T('offlineHint', 'What is playing shows again when the Pi is back.') : T('waitingHint', 'Sound control comes from the Pi.');
      return v;
    }
    if (!d || typeof d !== 'object') {
      v.kind = 'update';
      v.msg = T('update', 'The Pi needs an update');
      v.hint = T('updateHint', 'On the Pi: git pull, then docker compose restart hub.');
      return v;
    }

    v.source = str(d.source, 30);
    v.device = str(d.device, 60);
    if ((d.state === 'playing' || d.state === 'paused') && (d.title || d.source || d.device)) {
      v.kind = d.state;
      v.song = true;
      v.label = d.state === 'playing' ? T('playing', 'Now playing') : T('paused', 'Paused');
      var title = str(d.title, 200);
      var artist = str(d.artist, 120);
      var album = str(d.album, 120);
      // A radio show: the show, then the station. No title at all (TuneIn on
      // an Echo says nothing about what plays): the app, or plain words; the
      // speaker's name stays on the line below, and the music mark shows.
      v.title = title || v.source || (d.state === 'playing' ? T('unknown', 'Something is playing') : T('unknownPaused', 'Something is paused'));
      v.unknown = !title;
      v.sub = artist || album;
      v.album = artist && album ? album : '';
      if (!title) { v.sub = ''; v.album = ''; }
      v.art = title ? artUrl(d.art) : '';
      // An Echo still "playing" a song that should have ended a while ago
      // (the Pi decides): a small quiet line under the title.
      v.stale = d.state === 'playing' && d.from === 'echo' && d.stale === true && !!title;
      // The hub started this on an Echo (Audible, an Alexa briefing...): the
      // Pi shows the app, not Alexa's old title. Same quiet line, own words.
      v.started = (d.state === 'playing' || d.state === 'paused') && d.from === 'echo' && d.started === true;
      v.note = v.stale ? T('stale', 'May be out of date') : v.started ? T('started', 'Started from the hub') : '';
      return v;
    }
    if (d.state === 'notset') {
      v.kind = 'notset';
      v.msg = T('notset', 'Not set up yet');
      v.hint = T('notsetHint', 'Add a Home Assistant token (HA_TOKEN) to pi/.env on the Pi.');
      return v;
    }
    if (d.state === 'error') {
      v.kind = 'error';
      v.msg = T('error', 'Can’t reach Home Assistant');
      v.hint = d.problem === 'auth' ? T('errorAuth', 'Home Assistant refused the token. Make a new one and put it in pi/.env.')
        : T('errorHint', 'It keeps trying by itself.');
      return v;
    }
    v.kind = 'idle';
    v.msg = T('idle', 'Nothing playing');
    v.hint = T('idleHint', 'Play something on an Echo or on Spotify and it shows up here.');
    return v;
  }

  // The header badge: the state in a word or two.
  function badge(kind) {
    var words = {
      idle: ['badge.idle', 'Quiet'], notset: ['badge.notset', 'Not set up'], error: ['badge.error', 'No connection'],
      waiting: ['badge.waiting', 'Waiting'], offline: ['badge.offline', 'No Pi'], update: ['badge.update', 'Needs the Pi']
    };
    var w = words[kind];
    return w ? T(w[0], w[1]) : '';
  }

  /* ---------- the Echo controls: what they know ---------- */

  function now() { return new Date().getTime(); }

  // The speakers the Pi lists, checked again here (an older Pi sends none).
  function echosOf(d) {
    var out = [];
    var list = d && d.echos;
    if (!list || !list.length) return out;
    for (var i = 0; i < list.length && out.length < 8; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object' || typeof e.key !== 'string' || !APP_KEY.test(e.key)) continue;
      var st = e.state === 'playing' || e.state === 'paused' || e.state === 'idle' ? e.state : 'off';
      var vol = typeof e.volume === 'number' && e.volume >= 0 && e.volume <= 100 ? Math.round(e.volume) : -1;
      out.push({ key: e.key, name: str(e.name, 60) || e.key, state: st, volume: vol });
    }
    return out;
  }

  // "Ian's Echo Show" -> "Echo Show"; the group is "Everywhere" in our words.
  function shortName(e) {
    if (e.key === 'everywhere' || e.name === 'Everywhere') return T('everywhere', 'Everywhere');
    var n = e.name.replace(/^\S+['’]s\s+/, '');
    return n || e.name;
  }

  // The controls' picture, or null when they do not show (no speakers, not live).
  function ctlView(v) {
    if (!v || (v.kind !== 'playing' && v.kind !== 'paused' && v.kind !== 'idle')) return null;
    var list = echosOf(data);
    if (!list.length) return null;
    var key = null;
    var i;
    if (sel) for (i = 0; i < list.length; i++) if (list[i].key === sel) key = sel;
    if (!key && data && typeof data.target === 'string') for (i = 0; i < list.length; i++) if (list[i].key === data.target) key = data.target;
    if (!key) for (i = 0; i < list.length; i++) if (list[i].state === 'playing') { key = list[i].key; break; }
    if (!key) key = list[0].key;
    var cur = null;
    for (i = 0; i < list.length; i++) if (list[i].key === key) cur = list[i];
    var state = cur.state;
    if (pend && pend.key === key && now() - pend.at < PENDING_MS) state = pend.state;
    var vol = cur.volume;
    if (pendVol && pendVol.key === key && now() - pendVol.at < PENDING_MS) vol = pendVol.value;
    return { echos: list, key: key, cur: cur, name: shortName(cur), playing: state === 'playing', vol: vol };
  }

  var QUICK = [
    ['audible', 'qAudible', 'Resume audiobook', 'appAudible', 'Audible', 'audible'],
    ['kera', 'qKera', 'KERA 90.1', 'appKera', 'KERA 90.1', 'kera'],
    ['news', 'qNews', 'News briefing', 'appNews', 'the news', 'news'],
    ['pandora', 'qPandora', 'Pandora', 'appPandora', 'Pandora', 'music'],
    ['amazon-music', 'qAmazon', 'Amazon Music', 'appAmazon', 'Amazon Music', 'music']
  ];

  var GLYPH = {
    play: '<path d="M8 5.2v13.6L19.2 12z"/>',
    pause: '<rect x="6.2" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.6" y="5" width="4.2" height="14" rx="1.2"/>',
    next: '<path d="M5.5 5.4v13.2L15 12z"/><rect x="16.6" y="5.4" width="2.8" height="13.2" rx="1.2"/>',
    volDown: '<path d="M3.5 9.6h3.4L11.5 5.6v12.8l-4.6-4H3.5z"/><path fill="none" d="M15.5 12h5"/>',
    volUp: '<path d="M3.5 9.6h3.4L11.5 5.6v12.8l-4.6-4H3.5z"/><path fill="none" d="M15 12h5.6M17.8 9.2v5.6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.2"/>'
  };

  // Line glyphs for the quick starts (no brand marks): a book, radio waves, a newspaper, a note.
  var LINE = {
    audible: '<path d="M5 4.5h10.5a2 2 0 0 1 2 2V19.5H7a2 2 0 0 1-2-2z"/><path d="M5 17.5a2 2 0 0 1 2-2h10.5"/>',
    kera: '<circle cx="12" cy="12" r="1.6"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>',
    news: '<path d="M5 5h11v14H7a2 2 0 0 1-2-2z"/><path d="M16 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 12h5M8 15h3"/>',
    music: '<path d="M9 18V5.5l11-2v12.5"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'
  };

  function lineGlyph(name, cls, parent) {
    var n = el('span', 'icon ' + cls, parent);
    n.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + LINE[name] + '</svg>';
    return n;
  }

  function glyph(name, cls, parent) {
    var n = el('span', 'icon ' + cls, parent);
    n.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + GLYPH[name] + '</svg>';
    return n;
  }

  function hasClass(n, c) { return (' ' + n.className + ' ').indexOf(' ' + c + ' ') >= 0; }

  /* ---------- pieces ---------- */

  function artBox(parent, v, cls) {
    var box = el('div', 'sc-art ' + cls + (v.kind === 'paused' ? ' is-dim' : ''), parent);
    var face = el('div', 'sc-face', box);
    var mark = el('span', 'icon sc-mark', face);
    mark.innerHTML = icon('music');
    if (v.art) {
      var img = el('img', 'sc-img', face);
      img.alt = '';
      img.onload = function () { img.className = 'sc-img is-loaded'; face.className = 'sc-face has-img'; };
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = v.art;
    }
    return box;
  }

  function eq(parent, v) {
    var box = el('span', 'sc-eq' + (v.kind === 'playing' ? ' is-playing' : ''), parent);
    el('i', '', box);
    el('i', '', box);
    el('i', '', box);
    return box;
  }

  // The platform as a quiet "(Pandora)" after the label, in the same line, so
  // nothing moves when it comes or goes. Only the name gives way ("...") when
  // there is not room; the brackets stay. Nothing at all when it is unknown.
  function platform(parent, v) {
    if (!v.source) return null;
    var box = el('span', 'sc-plat', parent);
    el('span', 'sc-plat-b', box, '(');
    el('span', 'sc-plat-name', box, v.source);
    el('span', 'sc-plat-b', box, ')');
    return box;
  }

  // The speaker's name on a line of its own, ending in "..." when it is long.
  function meta(parent, v) {
    if (!v.device) return null;
    var row = el('div', 'sc-meta', parent);
    el('span', 'sc-device', row, v.device);
    return row;
  }

  function sizeArt(box, px) {
    px = Math.max(0, Math.floor(px));
    box.style.width = px + 'px';
    box.style.height = px + 'px';
    return px;
  }

  function layoutFor(size) {
    if (!size) return 'row';
    if (size.cols <= 1) return 'icon';
    if (size.tier === 'strip') return size.width === 'narrow' ? 'icon' : 'row';
    if (size.width === 'narrow') return 'col';
    if (size.tier === 'tall' && size.width !== 'wide') return 'col';
    return 'row';
  }

  /* ---------- the tile ---------- */

  function drawTile(body, ctx) {
    var size = ctx.size ? ctx.size() : null;
    var v = view();
    var layout = layoutFor(size);
    var strip = !!size && size.tier === 'strip';
    var root = el('div', 'sc-tile sc-' + layout + (strip ? ' sc-strip' : '') + ' sc-k-' + v.kind, body);
    var card = { root: root, v: v, layout: layout, strip: strip };
    tiles.push(card);
    if (v.kind === 'waiting' || v.kind === 'offline' || v.kind === 'update') root.className += ' hub-dormant';

    // Nothing playing (or a problem), two rows or more: the hub's header,
    // the message, then what to do.
    var headed = !v.song && !strip && layout !== 'icon' && typeof ctx.drawHead === 'function';
    if (headed) {
      root.className += ' sc-headed';
      ctx.drawHead(root, { icon: 'music', title: T('title', 'Sound control'), badge: badge(v.kind) });
      card.title = el('div', 'sc-msg', root, v.msg);
      card.hint = el('div', 'sc-hint', root, v.hint);
      fitHeaded(body, card);
      return;
    }

    card.art = artBox(root, v.song ? v : { kind: 'idle' }, 'sc-art-tile');
    if (layout === 'icon') {
      root.title = v.song ? v.title : v.msg;
      fitTile(body, card);
      return;
    }
    var text = el('div', 'sc-text', root);
    card.text = text;
    if (v.song) {
      card.head = el('div', 'sc-label', text);
      eq(card.head, v);
      el('span', 'sc-label-text', card.head, v.label);
      platform(card.head, v);
      card.title = el('div', 'sc-title', text, v.title);
      card.stale = v.note ? el('div', 'sc-stale', text, v.note) : null;
      card.sub = v.sub ? el('div', 'sc-sub', text, v.sub) : null;
      card.meta = meta(text, v);
    } else {
      card.title = el('div', 'sc-title sc-quiet-title', text, v.msg);
      card.sub = el('div', 'sc-sub sc-hint-line', text, v.hint);
    }
    fitTile(body, card);
  }

  // The message takes up to two lines, the hint what is left (at most three).
  function fitHeaded(body, card) {
    var room = body.clientHeight;
    if (!room) return;
    clamp(card.title, 2);
    clamp(card.hint, 3);
    var head = card.root.querySelector('.tile-head');
    var used = function () { return outer(head) + outer(card.title) + outer(card.hint); };
    if (used() > room + 1) clamp(card.hint, 2);
    if (used() > room + 1) clamp(card.hint, 1);
    if (used() > room + 1) clamp(card.title, 1);
    if (used() > room + 1) clamp(card.hint, 0);
  }

  // Sizes the picture from the room, then lets the words use what is left.
  function fitTile(body, card) {
    var room = { w: body.clientWidth, h: body.clientHeight };
    if (!room.w || !room.h || !card.art) return;
    var r = rem();
    var px;
    if (card.layout === 'icon') {
      sizeArt(card.art, Math.max(2 * r, Math.min(room.w, room.h)));
      return;
    }
    if (card.layout === 'row') {
      px = Math.min(room.h, room.w * (card.strip ? 0.4 : 0.42));
      px = sizeArt(card.art, Math.max(2.4 * r, px));
      card.text.style.width = Math.max(0, room.w - px - 1.1 * r) + 'px';
      fitRowText(card, room.h);
      return;
    }
    // col: the picture over the words. Two lines of title, then one.
    var tries = [2, 1];
    for (var i = 0; i < tries.length; i++) {
      clamp(card.title, tries[i]);
      clamp(card.sub, 1);
      if (card.meta) card.meta.style.display = '';
      var textH = outer(card.head) + outer(card.title) + outer(card.stale) + outer(card.sub) + outer(card.meta);
      px = Math.min(room.w, room.h - textH - 0.7 * r);
      if (px >= 4 * r || i === tries.length - 1) break;
    }
    if (px < 4 * r && card.meta) {
      card.meta.style.display = 'none';
      px = Math.min(room.w, room.h - (outer(card.head) + outer(card.title) + outer(card.stale) + outer(card.sub)) - 0.7 * r);
    }
    if (px < 3 * r) {
      card.text.style.display = 'none';
      px = Math.min(room.w, room.h);
    }
    sizeArt(card.art, Math.max(2.4 * r, px));
  }

  // In a row the title takes the lines left beside the picture; when it runs
  // tall the speaker line goes first, then the second line, then the label.
  function fitRowText(card, roomH) {
    clamp(card.sub, 1);
    var used = function () { return outer(card.head) + outer(card.title) + outer(card.stale) + outer(card.sub) + outer(card.meta); };
    if (card.strip) {
      if (card.head) card.head.style.display = 'none';
      if (card.stale) card.stale.style.display = 'none';
      if (card.meta) card.meta.style.display = 'none';
      clamp(card.title, 1);
      card.text.style.maxHeight = roomH + 'px';
      return;
    }
    var others = outer(card.head) + outer(card.stale) + outer(card.sub) + outer(card.meta);
    var lines = Math.max(1, Math.floor((roomH - others) / lineHeight(card.title)));
    clamp(card.title, Math.min(lines, 3));
    if (used() > roomH + 1 && card.meta) card.meta.style.display = 'none';
    if (used() > roomH + 1) clamp(card.title, 1);
    if (used() > roomH + 1 && card.head) card.head.style.display = 'none';
    if (used() > roomH + 1 && card.stale) card.stale.style.display = 'none';
    if (used() > roomH + 1) clamp(card.sub, 0);
    card.text.style.maxHeight = roomH + 'px';
  }

  /* ---------- the page ---------- */

  function drawPage(body, ctx) {
    var v = view();
    var full = ctx.mode && ctx.mode() === 'full';
    var cv = ctlView(v);
    var root = el('div', 'sc-page sc-k-' + v.kind + (full ? ' is-full' : '') + (cv ? ' has-ctl' : ''), body);
    page = { root: root, v: v, full: full, cv: cv, hint: '', spk: [], btns: [], qk: [] };
    var main = cv ? el('div', 'sc-main', root) : root;
    page.main = main;
    page.art = artBox(main, v.song ? v : { kind: 'idle' }, 'sc-art-page');
    var info = el('div', 'sc-info', main);
    page.info = info;
    var head = el('div', 'sc-label', info);
    page.head = head;
    if (v.song) {
      eq(head, v);
      el('span', 'sc-label-text', head, v.label);
      platform(head, v);
      page.title = el('div', 'sc-title', info, v.title);
      page.stale = v.note ? el('div', 'sc-stale', info, v.note) : null;
      page.sub = v.sub ? el('div', 'sc-sub', info, v.sub) : null;
      page.album = v.album ? el('div', 'sc-album', info, v.album) : null;
      // With the controls the speaker row already says which speaker it is
      // (unless the sound is on a speaker that is not one of its chips).
      var known = false;
      if (cv) for (var ki = 0; ki < cv.echos.length; ki++) if (cv.echos[ki].name === v.device) known = true;
      if (!known) {
        var foot = el('div', 'sc-foot', info);
        page.foot = foot;
        var chips = el('div', 'sc-chips', foot);
        if (v.device) el('span', 'sc-chip sc-chip-device', chips, T('on', 'On {device}', { device: v.device }));
      }
    } else {
      el('span', 'sc-label-text', head, T('title', 'Sound control'));
      page.title = el('div', 'sc-title sc-quiet-title', info, v.msg);
      page.sub = el('div', 'sc-sub sc-hint-line', info, v.hint);
    }
    if (cv) drawCtl(root, cv);
    // The head's line first, so the room the controls get is the final room.
    if (cv) paintStatus();
    fitPage(body);
  }

  // The Echo controls, one deck under what plays: the speaker picker (one
  // segmented track), the transport (Play/Pause, Next, a volume stepper,
  // Stop) and the quick starts on a rail. Every row starts at the same text
  // column; the first row and the last carry a quiet label.
  function drawCtl(root, cv) {
    var deck = el('div', 'sc-ctl', root);
    page.ctl = deck;
    var i;
    var r1 = el('div', 'sc-drow sc-row-spk', deck);
    el('div', 'sc-rlabel', r1, T('speaker', 'Speaker'));
    var seg = el('div', 'sc-seg', el('div', 'sc-rbody', r1));
    for (i = 0; i < cv.echos.length; i++) {
      var e = cv.echos[i];
      var chip = el('div', 'f sc-spk' + (e.key === cv.key ? ' is-sel' : ''), seg);
      chip.setAttribute('data-key', 'spk:' + e.key);
      chip.setAttribute('data-spk', e.key);
      if (e.state === 'playing') el('i', 'sc-dot', chip);
      el('span', 'sc-spk-name', chip, shortName(e));
      page.spk.push(chip);
    }

    var r2 = el('div', 'sc-drow sc-row-tr', deck);
    el('div', 'sc-rlabel', r2, '');
    var bar = el('div', 'sc-trans sc-rbody', r2);
    page.trans = bar;
    var vol = cv.vol >= 0 ? cv.vol + '%' : '—';
    var toggleLabel = cv.playing ? T('pause', 'Pause') : T('play', 'Play');
    // One transport item: a circle (the focusable) over a caption on its own line.
    function item(cls, act, glyphName, label, caption) {
      var it = el('div', 'sc-titem', bar);
      var box = el('div', 'sc-tbox', it);
      var c = el('div', 'f sc-tc ' + cls, box);
      c.setAttribute('data-key', 'act:' + act);
      c.setAttribute('data-act', act);
      c.setAttribute('aria-label', label);
      c.setAttribute('role', 'button');
      glyph(glyphName, 'sc-tc-icon', c);
      page.btns.push(c);
      if (caption !== null) el('div', 'sc-tcap', it, caption);
      return { it: it, c: c };
    }
    var main = item('sc-tc-main', 'toggle', cv.playing ? 'pause' : 'play', toggleLabel, toggleLabel);
    main.c.setAttribute('data-autofocus', '');
    item('sc-tc-next', 'next', 'next', T('next', 'Next'), T('next', 'Next'));
    // The volume stepper: one pill, only the minus and the plus take focus.
    var st = el('div', 'sc-titem', bar);
    var sbox = el('div', 'sc-tbox', st);
    var pill = el('div', 'sc-step', sbox);
    glyph('volDown', 'sc-step-ic', pill).innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 9.6h3.6L12.6 5.6v12.8l-5-4H4z"/><path fill="none" d="M16 9a4.2 4.2 0 0 1 0 6"/></svg>';
    var mk = function (act, txt, label) {
      var b = el('div', 'f sc-sb', pill);
      b.setAttribute('data-key', 'act:' + act);
      b.setAttribute('data-act', act);
      b.setAttribute('aria-label', label);
      b.setAttribute('role', 'button');
      el('span', 'sc-sb-t', b, txt);
      page.btns.push(b);
    };
    mk('volDown', '−', T('volDown', 'Volume down'));
    el('span', 'sc-vol' + (cv.vol >= 0 ? '' : ' is-unknown'), pill, vol);
    mk('volUp', '+', T('volUp', 'Volume up'));
    el('div', 'sc-tcap', st, T('volume', 'Volume'));
    var stop = item('sc-tc-stop', 'stop', 'stop', T('stop', 'Stop'), T('stop', 'Stop'));
    stop.it.className += ' is-capfocus';
    page.stopItem = stop.it;

    var r3 = el('div', 'sc-drow sc-row-quick', deck);
    el('div', 'sc-rlabel', r3, T('quick', 'Start'));
    var rail = el('div', 'sc-rail sc-rbody', r3);
    var track = el('div', 'sc-track', rail);
    page.rail = rail;
    page.track = track;
    for (i = 0; i < QUICK.length; i++) {
      var q = el('div', 'f sc-q', track);
      q.setAttribute('data-key', 'q:' + QUICK[i][0]);
      q.setAttribute('data-q', QUICK[i][0]);
      lineGlyph(QUICK[i][5], 'sc-q-ic', q);
      el('span', 'sc-q-text', q, T(QUICK[i][1], QUICK[i][2]));
      page.qk.push(q);
    }
  }

  // Keeps the focused quick start on the rail in view (instant: focus never animates).
  function railTo(chip) {
    if (!page || !page.rail || !chip) return;
    var railW = page.rail.clientWidth;
    var left = chip.offsetLeft;
    var right = left + chip.offsetWidth;
    var shift = page.shift || 0;
    var pad = 0.4 * rem();
    if (right - shift > railW - pad) shift = right - railW + pad;
    if (left - shift < pad) shift = Math.max(0, left - pad);
    var max = Math.max(0, page.track.scrollWidth - railW);
    shift = Math.max(0, Math.min(max, shift));
    page.shift = shift;
    page.track.style.webkitTransform = 'translateX(' + (-shift) + 'px)';
    page.track.style.transform = 'translateX(' + (-shift) + 'px)';
  }

  function fitPage(body) {
    if (!page) return;
    var r = rem();
    var h = body.clientHeight;
    var w = body.clientWidth;
    if (!h || !w) return;
    var pageH = h - 0.2 * r;
    var ctlH = 0;
    if (page.ctl) {
      fitCtl(pageH);
      ctlH = outer(page.ctl);
    }
    // What plays keeps the room above the deck: the cover is the hero, and
    // the words give way before it does. With very little room the song gives
    // way whole to the controls, never half a line.
    var roomH = Math.max(0, pageH - ctlH);
    var hide = !!page.ctl && roomH < 3.4 * r;
    if (page.main) page.main.style.display = hide ? 'none' : '';
    page.root.style.height = pageH + 'px';
    if (hide) return;
    var px = Math.min(page.ctl ? roomH : h - 0.4 * r, w * (page.full ? (page.ctl ? 0.36 : 0.42) : 0.4));
    var minArt = page.ctl ? 6.5 * r : 6 * r;
    var noArt = page.ctl && px < minArt;
    if (noArt) {
      page.art.style.display = 'none';
      px = 0;
    } else {
      page.art.style.display = '';
      px = sizeArt(page.art, Math.max(minArt, px));
    }
    var col = w - r - px - (noArt ? 0 : (page.full ? 3.4 : 2) * r);
    page.info.style.width = Math.max(10 * r, col) + 'px';
    var room = page.ctl ? roomH : pageH;
    if (page.main) page.main.style.height = room + 'px';
    if (page.ctl) page.info.style.height = room + 'px';
    clamp(page.title, page.full ? 3 : 2);
    clamp(page.sub, 2);
    clamp(page.album, 1);
    var used = function () { return outer(page.head) + outer(page.title) + outer(page.stale) + outer(page.sub) + outer(page.album) + outer(page.foot); };
    if (used() > room && page.album) page.album.style.display = 'none';
    if (used() > room) clamp(page.sub, 1);
    if (used() > room) clamp(page.title, 1);
    if (used() > room && page.foot) page.foot.style.display = 'none';
    if (used() > room && page.stale) page.stale.style.display = 'none';
    if (used() > room) clamp(page.sub, 0);
    if (used() > room && page.head) page.head.style.display = 'none';
  }

  // The deck has to leave room for the song: when it does not, it tightens
  // (smaller circles), and when its captions do not fit in a row they go.
  function fitCtl(h) {
    var ctl = page.ctl;
    var r = rem();
    var stages = ['sc-ctl', 'sc-ctl is-tight', 'sc-ctl is-tight is-tighter'];
    for (var i = 0; i < stages.length; i++) {
      ctl.className = stages[i];
      if (h - outer(ctl) >= 7.5 * r) break;
    }
    if (page.trans && page.trans.scrollWidth > page.trans.clientWidth + 1) ctl.className += ' is-nocap';
  }

  /* ---------- sending ---------- */

  // The panel head's small line: what was just sent or went wrong, else what
  // OK does on the focused chip. It always takes its one line (a no-break
  // space when empty) and never wraps, so the line coming and going never
  // moves the controls below it.
  function paintStatus() {
    if (!page || !C || !C.setSub) return;
    var text = page.hint || '';
    var kind = '';
    if (note && now() - note.at < NOTE_MS) { text = note.text; kind = note.kind; }
    C.setSub(text || (page.ctl ? '\u00a0' : ''));
    var sub = document.querySelector('#panel .panel-sub');
    if (sub) {
      sub.classList.remove('sc-sub-bad');
      if (page.ctl) sub.classList.add('sc-sub');
      if (kind === 'bad') sub.classList.add('sc-sub-bad');
    }
  }

  function clearSub() {
    var sub = document.querySelector('#panel .panel-sub');
    if (sub) { sub.classList.remove('sc-sub'); sub.classList.remove('sc-sub-bad'); }
  }

  function setNote(text, kind) {
    note = { text: text, kind: kind || 'ok', at: now() };
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { noteTimer = null; note = null; paintStatus(); }, NOTE_MS);
    paintStatus();
  }

  function post(path, body, cb) {
    if (!C || !C.live || typeof C.live.post !== 'function') { cb('live updates are off', null, 0); return; }
    C.live.post(path, body, cb);
  }

  // The reply's outcome as our own words. The Pi's English is only read to
  // tell the kinds apart, never shown.
  function failText(err, r, code) {
    if (code === 429) return T('errBusy', 'Too many presses. Try again in a moment.');
    if (code === 200 && r && r.ok === false) {
      var m = typeof r.message === 'string' ? r.message : '';
      if (/too many/i.test(m)) return T('errBusy', 'Too many presses. Try again in a moment.');
      if (/could not be reached/i.test(m)) return T('errEcho', 'Couldn’t reach the Echo');
      return T('errHa', 'Home Assistant refused the request');
    }
    if (code === 400) return T('errHa', 'Home Assistant refused the request');
    return T('errPi', 'Couldn’t reach the Pi. Nothing changed.');
  }

  function schedulePend() {
    if (pendTimer) clearTimeout(pendTimer);
    pendTimer = setTimeout(function () {
      pendTimer = null;
      var stale = false;
      if (pend && now() - pend.at >= PENDING_MS) { pend = null; stale = true; }
      if (pendVol && now() - pendVol.at >= PENDING_MS) { pendVol = null; stale = true; }
      if (stale) refresh(true);
    }, PENDING_MS + 100);
  }

  // body: what to send (target is added); okText: our words for a success;
  // optimistic: the state to show on the Play/Pause button meanwhile, or ''.
  function send(body, okText, optimistic, optVol) {
    var cv = ctlView(view());
    if (!cv) return;
    body.target = cv.key;
    var mine = ++seq;
    var pmine = null;
    setNote(T('sending', 'Sending…'), 'ok');
    var vmine = null;
    if (optimistic) { pmine = { key: cv.key, state: optimistic, at: now() }; pend = pmine; }
    if (typeof optVol === 'number') { vmine = { key: cv.key, value: optVol, at: now() }; pendVol = vmine; }
    if (pmine || vmine) { schedulePend(); refresh(true); }
    post('/echo/run', body, safe(function (err, r, code) {
      if (err) {
        var back = false;
        if (pmine && pend === pmine) { pend = null; back = true; }
        if (vmine && pendVol === vmine) { pendVol = null; back = true; }
        if (back) refresh(true);
        if (mine === seq) setNote(failText(err, r, code), 'bad');
        return;
      }
      if (mine === seq) setNote(okText, 'ok');
    }));
  }

  function act(name) {
    var cv = ctlView(view());
    if (!cv) return;
    var dev = { device: cv.name };
    if (name === 'toggle') {
      if (cv.playing) send({ action: 'pause' }, T('donePaused', 'Paused on {device}', dev), 'paused');
      else send({ action: 'resume' }, T('donePlaying', 'Playing on {device}', dev), 'playing');
    } else if (name === 'next') send({ action: 'next' }, T('doneNext', 'Skipped'), '');
    else if (name === 'volUp') volume(cv, 1);
    else if (name === 'volDown') volume(cv, -1);
    else if (name === 'stop') send({ action: 'stop' }, T('doneStopped', 'Stopped'), '');
  }

  // One press of the stepper: the volume this speaker should reach (10 up or
  // down from what is shown), sent as that level so the shown number is the
  // number asked for; a speaker with no known volume gets the plain step.
  function volume(cv, dir) {
    if (cv.vol >= 0) {
      var to = Math.max(0, Math.min(100, cv.vol + dir * 10));
      send({ action: 'volume', level: to }, dir > 0 ? T('doneUp', 'Volume up') : T('doneDown', 'Volume down'), '', to);
    } else {
      send({ action: 'volume', step: dir > 0 ? 'up' : 'down' }, dir > 0 ? T('doneUp', 'Volume up') : T('doneDown', 'Volume down'), '');
    }
  }

  function quick(app) {
    var cv = ctlView(view());
    if (!cv) return;
    for (var i = 0; i < QUICK.length; i++) {
      if (QUICK[i][0] !== app) continue;
      send({ action: 'start', app: app }, T('doneStart', 'Starting {app} on {device}', { app: T(QUICK[i][3], QUICK[i][4]), device: cv.name }), '');
      return;
    }
  }

  function paintFoot(target) {
    if (!page) return;
    var text = '';
    var cv = page.cv;
    if (target && target.getAttribute) {
      if (target.getAttribute('data-spk')) text = T('hintSpeaker', 'OK controls this speaker');
      else if (target.getAttribute('data-q') && cv) text = T('hintQuick', 'OK starts it on {device}', { device: cv.name });
    }
    page.hint = text;
    paintStatus();
  }

  /* ---------- keeping up ---------- */

  function langOf() {
    var L = window.HUB_I18N;
    try { return L && L.lang ? L.lang() : ''; } catch (e) { return ''; }
  }

  // What the tile draws (as All sounds did) and, separately, what only the
  // page's controls draw: a new volume redraws the page, not the tile.
  function signature() {
    var v = view();
    return JSON.stringify([langOf(), v.kind, v.label, v.title, v.sub, v.album, v.source, v.device, v.art, v.msg, v.hint, v.note || '']);
  }

  function ctlSignature() {
    var cv = ctlView(view());
    if (!cv) return '';
    return JSON.stringify([langOf(), cv.key, cv.playing, cv.echos, sel, cv.vol]);
  }

  function refresh(force) {
    if (!C) return;
    var sig = signature();
    var csig = ctlSignature();
    var tileChanged = force === true || sig !== lastSig;
    var ctlChanged = force === true || csig !== lastCtlSig;
    if (!tileChanged && !ctlChanged) return;
    lastSig = sig;
    lastCtlSig = csig;
    if (tileChanged) C.redrawTile();
    if (page && C.isOpen && C.isOpen()) C.redrawPanel();
  }

  function onLang() {
    if (!C) return;
    if (C.isOpen && C.isOpen()) {
      var pt = document.querySelector('#panel .panel-title');
      if (pt) pt.textContent = T('title', 'Sound control');
    }
    refresh(true);
  }

  // The nearest button of a row to where the focus was (by its middle).
  function nearest(list, from) {
    if (!list.length) return null;
    var fr = from.getBoundingClientRect();
    var mid = fr.left + fr.width / 2;
    var best = list[0];
    var bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var rc = list[i].getBoundingClientRect();
      var d = Math.abs(rc.left + rc.width / 2 - mid);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  /* ---------- the widget ---------- */

  var w = {
    id: 'soundctl',
    icon: 'music',
    head: false,

    init: safe(function (ctx) {
      C = ctx;
      if (ctx.live) {
        var held = ctx.live.get('allsounds');
        if (held) data = held;
        ctx.live.on('allsounds', safe(function (d) {
          data = d && typeof d === 'object' ? d : null;
          // The Pi's push confirms a Play/Pause that was on its way.
          if (pend && data) {
            var es = echosOf(data);
            for (var i = 0; i < es.length; i++) if (es[i].key === pend.key && es[i].state === pend.state) pend = null;
          }
          if (pendVol && data) {
            var ev = echosOf(data);
            for (var k = 0; k < ev.length; k++) if (ev[k].key === pendVol.key && ev[k].volume === pendVol.value) pendVol = null;
          }
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
      tiles = [];
      lastSig = signature();
      lastCtlSig = ctlSignature();
      drawTile(body, ctx);
    },

    renderPanel: function (body, ctx) {
      C = ctx;
      page = null;
      lastCtlSig = ctlSignature();
      try {
        drawPage(body, ctx);
      } catch (e) {
        if (window.console && console.warn) console.warn('Sound control page: ' + (e && e.message));
        page = null;
        body.innerHTML = '';
        el('div', 'sc-fallback', body, T('broken', 'Sound control couldn’t be shown.'));
      }
    },

    onFocus: safe(function (target) {
      paintFoot(target);
      if (!page) return;
      if (target && target.getAttribute && target.getAttribute('data-q')) railTo(target);
      // Stop is a quiet circle: its word shows only while it has the focus.
      if (page.stopItem) {
        var on = !!(target && target.getAttribute && target.getAttribute('data-act') === 'stop');
        page.stopItem.className = 'sc-titem is-capfocus' + (on ? ' is-on' : '');
      }
    }),

    onSelect: safe(function (target) {
      if (!page || !target || !target.getAttribute) return;
      var k = target.getAttribute('data-spk');
      var a = target.getAttribute('data-act');
      var q = target.getAttribute('data-q');
      if (k) { sel = k; refresh(true); }
      else if (a) act(a);
      else if (q) quick(q);
    }),

    onMove: safe(function (dir, from) {
      if (!page || !page.ctl || !from || !from.getAttribute) return undefined;
      var rows = [page.spk, page.btns, page.qk];
      var ri = -1;
      var at = -1;
      for (var i = 0; i < rows.length; i++) {
        var k = rows[i].indexOf(from);
        if (k >= 0) { ri = i; at = k; }
      }
      if (ri < 0) {
        // From the Full screen button: Down goes to Play/Pause.
        return dir === 'down' ? (page.btns[0] || undefined) : undefined;
      }
      var row = rows[ri];
      if (dir === 'left') return at > 0 ? row[at - 1] : true;
      if (dir === 'right') return at < row.length - 1 ? row[at + 1] : true;
      if (dir === 'up') return ri > 0 ? nearest(rows[ri - 1], from) : (document.querySelector('#panel .panel-btn') || undefined);
      if (dir === 'down') return ri < rows.length - 1 ? nearest(rows[ri + 1], from) : true;
      return undefined;
    }),

    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onClose: function () { page = null; sel = null; pend = null; pendVol = null; note = null; clearSub(); },
    onStatus: safe(function () { refresh(false); })
  };
  // Read whenever the hub draws a title, so it follows the language.
  Object.defineProperty(w, 'title', {
    get: function () { return T('title', 'Sound control'); }, enumerable: true, configurable: true
  });
  return w;
})());
