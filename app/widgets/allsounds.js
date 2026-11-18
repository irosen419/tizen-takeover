/*
 * All sounds (test widget): whatever is playing in the house, from any
 * source, on the tile and on a page. A copy of Now Playing (nowplaying.js)
 * with the Spotify-only parts taken out, for trying on its own in the
 * "All sounds test" layout before anything joins the real Now Playing.
 *
 * Everything comes from the Pi (pi/allsounds.js), through the live line, as
 * the resource "allsounds": the state (playing, paused, idle, off, notset,
 * error), the app or service it comes from ("TuneIn", "Spotify"), the
 * speaker ("Living room Echo"), the title, artist, album and a picture
 * address. The Pi reads Home Assistant (the Echo speakers) and folds in
 * Spotify; the TV never sees a Home Assistant token or address.
 *
 * Same tile layouts and sizing as Now Playing (art only, a row, a column),
 * plus the platform as a quiet "(Pandora)" after the "Now playing" label (only
 * when the Pi knows it) and the speaker's name on one line under the words.
 * A radio show often has no artist: the show is the main line and the
 * station the second. No progress bar (Echo speakers do not say where they
 * are in a show) and no visualizer.
 *
 * Every word on screen goes through HUB_I18N ('allsounds.*' keys), and a
 * language change redraws the tile and an open page.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var C = null;            // a ctx, kept from init for the live hooks
  var data = null;         // the last resource data from the Pi, or null
  var tiles = [];          // the drawn tile cards
  var page = null;         // the open page's parts, or null
  var lastSig = '';

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
      try { return String(L.t('allsounds.' + key, en, vars)); } catch (e) { /* English */ }
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
        if (window.console && console.warn) console.warn('All sounds: ' + (e && e.message));
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
      v.hint = T('liveOffHint', 'All sounds needs the Pi. Check HUB_CONFIG.live in config.js.');
      return v;
    }
    if (liveState !== 'live' && !(d && liveState === 'connecting')) {
      v.kind = liveState === 'lost' ? 'offline' : 'waiting';
      v.msg = v.kind === 'offline' ? T('offline', 'Can’t reach the Pi') : T('waiting', 'Waiting for the Pi');
      v.hint = v.kind === 'offline' ? T('offlineHint', 'What is playing shows again when the Pi is back.') : T('waitingHint', 'All sounds comes from the Pi.');
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

  /* ---------- pieces ---------- */

  function artBox(parent, v, cls) {
    var box = el('div', 'as-art ' + cls + (v.kind === 'paused' ? ' is-dim' : ''), parent);
    var face = el('div', 'as-face', box);
    var mark = el('span', 'icon as-mark', face);
    mark.innerHTML = icon('music');
    if (v.art) {
      var img = el('img', 'as-img', face);
      img.alt = '';
      img.onload = function () { img.className = 'as-img is-loaded'; face.className = 'as-face has-img'; };
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = v.art;
    }
    return box;
  }

  function eq(parent, v) {
    var box = el('span', 'as-eq' + (v.kind === 'playing' ? ' is-playing' : ''), parent);
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
    var box = el('span', 'as-plat', parent);
    el('span', 'as-plat-b', box, '(');
    el('span', 'as-plat-name', box, v.source);
    el('span', 'as-plat-b', box, ')');
    return box;
  }

  // The speaker's name on a line of its own, ending in "..." when it is long.
  function meta(parent, v) {
    if (!v.device) return null;
    var row = el('div', 'as-meta', parent);
    el('span', 'as-device', row, v.device);
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
    var root = el('div', 'as-tile as-' + layout + (strip ? ' as-strip' : '') + ' as-k-' + v.kind, body);
    var card = { root: root, v: v, layout: layout, strip: strip };
    tiles.push(card);
    if (v.kind === 'waiting' || v.kind === 'offline' || v.kind === 'update') root.className += ' hub-dormant';

    // Nothing playing (or a problem), two rows or more: the hub's header,
    // the message, then what to do.
    var headed = !v.song && !strip && layout !== 'icon' && typeof ctx.drawHead === 'function';
    if (headed) {
      root.className += ' as-headed';
      ctx.drawHead(root, { icon: 'music', title: T('title', 'All sounds'), badge: badge(v.kind) });
      card.title = el('div', 'as-msg', root, v.msg);
      card.hint = el('div', 'as-hint', root, v.hint);
      fitHeaded(body, card);
      return;
    }

    card.art = artBox(root, v.song ? v : { kind: 'idle' }, 'as-art-tile');
    if (layout === 'icon') {
      root.title = v.song ? v.title : v.msg;
      fitTile(body, card);
      return;
    }
    var text = el('div', 'as-text', root);
    card.text = text;
    if (v.song) {
      card.head = el('div', 'as-label', text);
      eq(card.head, v);
      el('span', 'as-label-text', card.head, v.label);
      platform(card.head, v);
      card.title = el('div', 'as-title', text, v.title);
      card.stale = v.stale ? el('div', 'as-stale', text, T('stale', 'May be out of date')) : null;
      card.sub = v.sub ? el('div', 'as-sub', text, v.sub) : null;
      card.meta = meta(text, v);
    } else {
      card.title = el('div', 'as-title as-quiet-title', text, v.msg);
      card.sub = el('div', 'as-sub as-hint-line', text, v.hint);
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
    var root = el('div', 'as-page as-k-' + v.kind + (full ? ' is-full' : ''), body);
    page = { root: root, v: v, full: full };
    page.art = artBox(root, v.song ? v : { kind: 'idle' }, 'as-art-page');
    var info = el('div', 'as-info', root);
    page.info = info;
    var head = el('div', 'as-label', info);
    page.head = head;
    if (v.song) {
      eq(head, v);
      el('span', 'as-label-text', head, v.label);
      platform(head, v);
      page.title = el('div', 'as-title', info, v.title);
      page.stale = v.stale ? el('div', 'as-stale', info, T('stale', 'May be out of date')) : null;
      page.sub = v.sub ? el('div', 'as-sub', info, v.sub) : null;
      page.album = v.album ? el('div', 'as-album', info, v.album) : null;
      var foot = el('div', 'as-foot', info);
      page.foot = foot;
      var chips = el('div', 'as-chips', foot);
      if (v.device) el('span', 'as-chip as-chip-device', chips, T('on', 'On {device}', { device: v.device }));
    } else {
      el('span', 'as-label-text', head, T('title', 'All sounds'));
      page.title = el('div', 'as-title as-quiet-title', info, v.msg);
      page.sub = el('div', 'as-sub as-hint-line', info, v.hint);
    }
    fitPage(body);
  }

  function fitPage(body) {
    if (!page) return;
    var r = rem();
    var h = body.clientHeight;
    var w = body.clientWidth;
    if (!h || !w) return;
    var px = Math.min(h - 0.4 * r, w * (page.full ? 0.42 : 0.4));
    px = sizeArt(page.art, Math.max(6 * r, px));
    var col = w - r - px - (page.full ? 3.4 : 2) * r;
    page.info.style.width = Math.max(10 * r, col) + 'px';
    page.root.style.height = (h - 0.2 * r) + 'px';
    var roomH = h - 0.2 * r;
    clamp(page.title, page.full ? 3 : 2);
    clamp(page.sub, 2);
    clamp(page.album, 1);
    var used = function () { return outer(page.head) + outer(page.title) + outer(page.stale) + outer(page.sub) + outer(page.album) + outer(page.foot); };
    if (used() > roomH && page.album) page.album.style.display = 'none';
    if (used() > roomH) clamp(page.sub, 1);
    if (used() > roomH) clamp(page.title, 1);
  }

  /* ---------- keeping up ---------- */

  function signature() {
    var v = view();
    var L = window.HUB_I18N;
    var lang = '';
    try { lang = L && L.lang ? L.lang() : ''; } catch (e) { lang = ''; }
    return JSON.stringify([lang, v.kind, v.label, v.title, v.sub, v.album, v.source, v.device, v.art, v.msg, v.hint, !!v.stale]);
  }

  function refresh(force) {
    if (!C) return;
    var sig = signature();
    if (!force && sig === lastSig) return;
    lastSig = sig;
    C.redrawTile();
    if (page && C.isOpen && C.isOpen()) C.redrawPanel();
  }

  function onLang() {
    if (!C) return;
    if (C.isOpen && C.isOpen()) {
      var pt = document.querySelector('#panel .panel-title');
      if (pt) pt.textContent = T('title', 'All sounds');
    }
    refresh(true);
  }

  /* ---------- the widget ---------- */

  var w = {
    id: 'allsounds',
    icon: 'music',
    head: false,

    init: safe(function (ctx) {
      C = ctx;
      if (ctx.live) {
        var held = ctx.live.get('allsounds');
        if (held) data = held;
        ctx.live.on('allsounds', safe(function (d) {
          data = d && typeof d === 'object' ? d : null;
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
      drawTile(body, ctx);
    },

    renderPanel: function (body, ctx) {
      C = ctx;
      page = null;
      try {
        drawPage(body, ctx);
      } catch (e) {
        if (window.console && console.warn) console.warn('All sounds page: ' + (e && e.message));
        page = null;
        body.innerHTML = '';
        el('div', 'as-fallback', body, T('broken', 'All sounds couldn’t be shown.'));
      }
    },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onClose: function () { page = null; },
    onStatus: safe(function () { refresh(false); })
  };
  // Read whenever the hub draws a title, so it follows the language.
  Object.defineProperty(w, 'title', {
    get: function () { return T('title', 'All sounds'); }, enumerable: true, configurable: true
  });
  return w;
})());
