/*
 * Now Playing: what is playing on Spotify, on the tile and on a page.
 *
 * Everything comes from the Pi (pi/spotify.js), through the live line, as
 * the resource "nowplaying": the track, artist, album, three picture
 * addresses, the song's length and where it was when the Pi last looked,
 * and a state: off, signin, idle, playing, paused or error. The TV holds no
 * Spotify secret or token and never talks to Spotify itself; only the album
 * picture is fetched from Spotify's picture servers.
 *
 * The song's position is worked out here from the moment the data arrived
 * (the Pi's clock and the TV's may differ), so the Pi only has to speak when
 * something changes: a new song, pause, resume, a jump. The tile and page
 * move the progress bar once a second, with a transform.
 *
 * The tile has four layouts picked from its size (ctx.size()): art only (a
 * strip 1-2 columns wide, or any tile one column wide), a row (art beside
 * the words), a column (art over the words, in a narrow or tall tile) and
 * the same row in a wide tall tile. The words wrap, then end in "...", and
 * the picture is sized from the room that is left, measured, so a long
 * (or longer, in another language) title never pushes anything out.
 *
 * When nothing plays the tile and page say so, show the last song dimmed
 * ("Last played"), and say what to do when Spotify is not connected yet or
 * the Pi cannot be reached. The last song is also kept on this TV
 * (localStorage) for the times the Pi is away.
 *
 * The page (expanded and full screen, never the tile) also shows sound
 * that is not Spotify: what the TV itself plays (window.HUB_AUDIO.now(),
 * ./hub play, ./hub news) and the Pi's "allsounds" resource (an Echo, TuneIn,
 * Pandora...; pi/allsounds.js), read by the same rules as the All sounds
 * widget it replaced (allsounds.js, removed). Spotify playing or paused wins; otherwise
 * another sound playing or paused shows instead, and a playing one beats a
 * paused Spotify. It shows the picture, the label, the title, the artist and
 * album lines, the platform as a quiet "(Pandora)", a quiet note ("Started
 * from the hub", "May be out of date") and an "On {device}" chip, with no
 * progress bar or times (no length is known). pageView() picks; its own
 * signature (pageSignature()) redraws only the page when it changes.
 *
 * The visualizer (nowplaying-viz.js) runs only when asked: while a sound
 * plays or is paused, the page has a "Visualizer" button (role=button,
 * data-autofocus, OK goes through onSelect). On the expanded page it sets
 * vizWanted and switches to full screen, so the visualizer always opens full
 * screen; in full screen it turns it on and off ("Hide visualizer"). It runs
 * only while vizWanted, full screen and a sound plays or is paused; leaving
 * full screen or closing the page forgets vizWanted. With it on, the album's
 * colors and the song's tempo drive it (a sound without a vibe gets a calm
 * middle, without a readable picture the mood's colors), and the page
 * shrinks to a small card in the upper left (fitCard). At the still wash
 * level the page keeps its big picture layout. HUB_CONFIG.widgets.nowplaying
 * .visualizer false (or ?viz=off) is a hard off: no button. The Pi adds the
 * song's "vibe" (data.vibe) a moment after the song; it is not part of
 * signature(), so it changes the visualizer in place, never redraws the page.
 *
 * A new song (another track id or title than the last one this run) shows
 * the tile's "New song" activity chip (ctx.activity('nowplaying'), see
 * app/motion.js): never for the first data after the hub starts, a pause,
 * resume, seek, the vibe arriving or nothing playing, and at most one chip
 * in SONG_CHIP_GAP_MS however fast the songs are skipped. Whether it shows
 * (motion speed, a panel or the wanderers covering the home screen) is
 * motion.js's to say, as for every chip.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var CACHE_KEY = 'homeHub.nowplaying.v1';

  var C = null;            // a ctx, kept from init for the live hooks
  var data = null;         // the last resource data from the Pi, or null
  var gotAt = 0;           // TV time the data arrived
  var cached = null;       // { track, playedAt } kept on this TV
  var tiles = [];          // the drawn tile cards: { root, bar, fill, ... }
  var page = null;         // the open page's parts, or null
  var timer = null;
  var lastSig = '';
  var SONG_CHIP_GAP_MS = 8000;
  var songKey = null;      // the song of the last data this run with one ('' none yet); null before any data
  var songChipAt = -Infinity;   // when the last "New song" chip was asked for
  var sounds = null;       // the Pi's "allsounds" data (any sound in the house), or null
  var lastPageSig = '';    // pageSignature() when the page was last drawn
  var vizWanted = false;   // the Visualizer button asked for it (full screen only)
  var vizPress = 0;        // counts presses, so an old press's check never undoes a new one
  var otherAt = { key: '', pos: 0, at: 0, playing: false };   // where a non-Spotify sound is, counted here

  /* ---------- small helpers ---------- */

  function now() { return new Date().getTime(); }

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function rem() {
    return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  }

  function lsGet(key) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* not kept; fine */ }
  }

  function icon(name) { return (window.HUB_ICONS && window.HUB_ICONS[name]) || ''; }

  // "3:07", or "1:02:09" past an hour.
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }

  // Height of a node with its vertical margins, 0 if it is not drawn.
  function outer(node) {
    if (!node || node.offsetHeight === 0) return 0;
    var cs = window.getComputedStyle(node);
    return node.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }

  // Like outer(), but without the top margin: the page's foot has an auto
  // one that stretches to fill the room, which is not space it needs.
  function outerFoot(node) {
    if (!node || node.offsetHeight === 0) return 0;
    var cs = window.getComputedStyle(node);
    return node.offsetHeight + (parseFloat(cs.marginBottom) || 0);
  }

  function lineHeight(node) {
    return parseFloat(window.getComputedStyle(node).lineHeight) || 20;
  }

  // Ends a text in "..." after n lines (old WebKit's line clamp). n of 0
  // hides it. Clears an earlier clamp first.
  function clamp(node, n) {
    node.style.display = '';
    node.style.webkitLineClamp = '';
    node.style.webkitBoxOrient = '';
    node.style.overflow = '';
    node.style.visibility = '';
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
        if (window.console && console.warn) console.warn('Now Playing: ' + (e && e.message));
        return undefined;
      }
    };
  }

  /* ---------- what to show ---------- */


  // The hub's language (Spanish in app/i18n.js under 'nowplaying.*').
  function T(key, english, vars) {
    var L = window.HUB_I18N;
    if (L && typeof L.t === 'function') { try { return String(L.t(key, english, vars)); } catch (e) { /* English below */ } }
    return String(english).replace(/\{(\w+)\}/g, function (all, n) { return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all; });
  }

  // The words and the picture for the data and the line to the Pi now.
  // kind: playing, paused, idle, signin, off, error, offline, waiting, update.
  function view() {
    var live = C && C.live ? C.live : null;
    var liveState = 'off';
    try { liveState = live ? live.status().state : 'off'; } catch (e) { liveState = 'off'; }
    var d = data;
    var v = { kind: 'waiting', track: null, label: T('nowplaying.label.now', 'Now playing'), title: '', sub: '', hint: '', dim: false, device: '', shuffle: false, repeat: 'off', moving: false };

    if (!live || liveState === 'off') {
      v.kind = 'update';
      v.title = T('nowplaying.liveOff', 'Live updates are off');
      v.hint = T('nowplaying.liveOffHint', 'Now Playing needs the Pi. Check HUB_CONFIG.live in config.js.');
      return fromCache(v);
    }
    if (liveState !== 'live' && !(d && liveState === 'connecting')) {
      v.kind = liveState === 'connecting' || liveState === 'quiet' || liveState === 'off' ? 'waiting' : 'offline';
      if (liveState === 'lost') v.kind = 'offline';
      v.label = v.kind === 'offline' ? T('nowplaying.label.last', 'Last played') : T('nowplaying.label.now', 'Now playing');
      v.title = v.kind === 'offline' ? T('nowplaying.offline', 'Can’t reach the Pi') : T('nowplaying.waiting', 'Waiting for the Pi');
      v.hint = v.kind === 'offline' ? T('nowplaying.offlineHint', 'What is playing shows again when the Pi is back.') : T('nowplaying.waitingHint', 'Now Playing comes from the Pi.');
      return fromCache(v);
    }
    if (!d) {
      v.kind = 'update';
      v.title = T('nowplaying.update', 'The Pi needs an update');
      v.hint = T('nowplaying.updateHint', 'On the Pi: git pull, then docker compose restart hub.');
      return fromCache(v);
    }

    v.track = d.track || null;
    v.device = d.device ? d.device.name : '';
    v.shuffle = d.shuffle === true;
    v.repeat = d.repeat || 'off';
    if (d.state === 'playing' || d.state === 'paused') {
      v.kind = d.state;
      v.label = d.state === 'playing' ? T('nowplaying.label.now', 'Now playing') : T('nowplaying.label.paused', 'Paused');
      v.moving = d.state === 'playing';
      return v;
    }
    if (d.state === 'idle') {
      v.kind = 'idle';
      v.dim = true;
      if (v.track) {
        v.label = T('nowplaying.label.last', 'Last played');
      } else {
        v.label = 'Spotify';
        v.title = T('nowplaying.idle', 'Nothing playing');
        v.hint = T('nowplaying.idleHint', 'Start something on Spotify and it shows up here.');
      }
      return v;
    }
    if (d.state === 'signin') {
      v.kind = 'signin';
      v.label = 'Spotify';
      v.title = T('nowplaying.signin', 'Not connected yet');
      v.hint = T('nowplaying.signinHint', 'Connect it once from the Pi: ./hub spotify login');
      return v;
    }
    if (d.state === 'error') {
      v.kind = 'error';
      v.dim = true;
      v.label = v.track ? T('nowplaying.label.last', 'Last played') : 'Spotify';
      v.title = v.track ? '' : T('nowplaying.cantReach', 'Can’t reach Spotify');
      v.hint = d.problem || T('nowplaying.errorHint', 'Spotify could not be reached. It keeps trying.');
      return v;
    }
    // off: the Pi has no Spotify settings.
    v.kind = 'off';
    v.label = 'Spotify';
    v.title = T('nowplaying.off', 'Not set up');
    v.hint = d.problem || T('nowplaying.offHint', 'Add the Spotify ID and secret to pi/.env on the Pi.');
    return v;
  }

  // Fills in the last song kept on this TV when the Pi has none to give.
  function fromCache(v) {
    if (!v.track && cached && cached.track) {
      v.track = cached.track;
      v.dim = true;
      if (v.kind === 'offline' || v.kind === 'update') v.label = T('nowplaying.label.last', 'Last played');
    }
    return v;
  }

  /* ---------- other sounds (the page only) ---------- */

  function str(x, max) {
    var s = typeof x === 'string' ? x : '';
    return s.length > max ? s.slice(0, max) : s;
  }

  // Only absolute https pictures (http on a laptop preview), as allsounds.js.
  function artUrl(s) {
    s = str(s, 600);
    if (/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return s;
    if (/^http:\/\/127\.0\.0\.1[:\/][^\s"'<>\\]*$/i.test(s)) return s;
    return '';
  }

  // A sound playing or paused that is not Spotify's own data, by the rules
  // of allsounds.js view(): the TV's own sound first, then the Pi's
  // "allsounds". null when there is none.
  function otherView() {
    var tv = null;
    try { tv = window.HUB_AUDIO && typeof window.HUB_AUDIO.now === 'function' ? window.HUB_AUDIO.now() : null; } catch (e) { tv = null; }
    if (tv && tv.state) {
      // "NPR News Now, 8pm ET": the show as the title, the rest below it.
      var whole = str(tv.title, 200);
      var cut = whole.indexOf(', ');
      return {
        kind: tv.state === 'playing' ? 'playing' : 'paused',
        title: (cut > 0 ? whole.substring(0, cut) : whole) || T('nowplaying.tvSound', 'Sound on the TV'),
        sub: cut > 0 ? whole.substring(cut + 2) : '', album: '', source: '', art: '',
        device: T('nowplaying.tv', 'Living room TV'),
        note: tv.state === 'waiting' ? T('nowplaying.tvWaiting', 'Press any button to start it') : ''
      };
    }
    var live = C && C.live ? C.live : null;
    if (!live) return null;
    var liveState = 'off';
    try { liveState = live.status().state; } catch (e) { liveState = 'off'; }
    var d = sounds;
    if (liveState !== 'live' && !(d && liveState === 'connecting')) return null;
    if (!d || typeof d !== 'object') return null;
    if ((d.state !== 'playing' && d.state !== 'paused') || !(d.title || d.source || d.device)) return null;
    var o = { kind: d.state, source: str(d.source, 30), device: str(d.device, 60) };
    var title = str(d.title, 200);
    var artist = str(d.artist, 120);
    var album = str(d.album, 120);
    // A radio show: the show, then the station. No title at all: the app, or plain words.
    o.title = title || o.source || (d.state === 'playing' ? T('nowplaying.unknown', 'Something is playing') : T('nowplaying.unknownPaused', 'Something is paused'));
    o.sub = title ? artist || album : '';
    o.album = title && artist && album ? album : '';
    o.art = title ? artUrl(d.art) : '';
    var stale = d.state === 'playing' && d.from === 'echo' && d.stale === true && !!title;
    var started = d.from === 'echo' && d.started === true;
    o.note = stale ? T('nowplaying.stale', 'May be out of date') : started ? T('nowplaying.started', 'Started from the hub') : '';
    return o;
  }

  // Counts where a non-Spotify sound is from when this TV first saw it
  // (nobody says), so the visualizer's scenes still move along.
  function noteOther(o) {
    var key = o.title + '\n' + o.device + '\n' + o.source;
    var t = now();
    var playing = o.kind === 'playing';
    if (key !== otherAt.key) { otherAt = { key: key, pos: 0, at: t, playing: playing }; return; }
    if (playing !== otherAt.playing) {
      if (otherAt.playing) otherAt.pos += Math.max(0, t - otherAt.at);
      otherAt.at = t;
      otherAt.playing = playing;
    }
  }

  // What the page shows: Spotify playing or paused wins, then another sound
  // (a playing one beats a paused Spotify), then Spotify's own words.
  function pageView() {
    var v = view();
    var o = otherView();
    if (!o) return v;
    var sp = v.kind === 'playing' || v.kind === 'paused';
    if (sp && !(v.kind === 'paused' && o.kind === 'playing' && o.source !== 'Spotify')) return v;
    noteOther(o);
    return {
      kind: o.kind, other: o, label: o.kind === 'playing' ? T('nowplaying.label.now', 'Now playing') : T('nowplaying.label.paused', 'Paused'),
      track: { id: null, kind: 'sound', title: o.title, artist: o.sub, album: o.album, art: o.art, artSmall: o.art, artTiny: o.art, durationMs: 0 },
      title: '', sub: '', hint: '', dim: false, device: o.device, shuffle: false, repeat: 'off', moving: o.kind === 'playing'
    };
  }

  // The song's position now, in ms, going by when the data arrived.
  function position(v) {
    if (v && v.other) return otherAt.pos + (otherAt.playing ? Math.max(0, now() - otherAt.at) : 0);
    if (!data || !v.track) return 0;
    var p = data.progressMs || 0;
    if (v.kind === 'playing') p += Math.max(0, now() - gotAt);
    if (v.kind !== 'playing' && v.kind !== 'paused') return 0;
    var d = v.track.durationMs || 0;
    return d ? Math.min(p, d) : p;
  }

  // The song's vibe from the Pi (pi/vibe.js), checked again here: null when
  // there is none (an older Pi, a podcast, not known yet) or it belongs to
  // another song.
  function genreList(g) {
    var out = [];
    if (!g || typeof g.length !== 'number') return out;
    for (var i = 0; i < g.length && out.length < 8; i++) if (typeof g[i] === 'string' && g[i].length <= 60) out.push(g[i]);
    return out;
  }

  function vibeOf(v) {
    var x = data && data.vibe;
    if (!x || typeof x !== 'object' || !v.track || v.other || v.track.kind === 'episode') return null;
    if (v.kind !== 'playing' && v.kind !== 'paused') return null;
    if (x.id && x.id !== v.track.id) return null;
    if ((x.source !== 'features' && x.source !== 'genres') || typeof x.energy !== 'number' || typeof x.valence !== 'number') return null;
    function u(n, d) { return typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1, n)) : d; }
    return {
      source: x.source,
      tempo: typeof x.tempo === 'number' && x.tempo >= 40 && x.tempo <= 220 ? x.tempo : 0,
      energy: u(x.energy, 0.5), valence: u(x.valence, 0.5), dance: u(x.dance, 0.5), acoustic: u(x.acoustic, 0.3),
      genres: genreList(x.genres)
    };
  }

  function fraction(v) {
    var d = v.track && v.track.durationMs;
    if (!d || (v.kind !== 'playing' && v.kind !== 'paused')) return 0;
    return Math.max(0, Math.min(1, position(v) / d));
  }

  /* ---------- pieces drawn on the tile and on the page ---------- */

  // The album picture in a square, with the music icon until it loads (or if
  // it never does).
  function artBox(parent, v, cls, glow) {
    var box = el('div', 'np-art ' + cls + (v.dim ? ' is-dim' : ''), parent);
    // The cover with a song is one picture wherever it shows: the hub's
    // motion extras fly it between the page and the full-screen card.
    if (v.track) box.setAttribute('data-share', 'np-cover');
    var face = el('div', 'np-face', box);
    var mark = el('span', 'icon np-mark', face);
    mark.innerHTML = icon('music');
    var src = v.track ? (cls.indexOf('np-art-page') >= 0 ? v.track.art : (v.track.artSmall || v.track.art)) : '';
    if (src) {
      var img = el('img', 'np-img', face);
      img.alt = '';
      img.onload = function () { img.className = 'np-img is-loaded'; };
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = src;
    }
    return box;
  }

  // "Now playing" is the longest label; in a narrow column it ends in "...",
  // so it gives way to "Playing" first.
  function shortLabel(card, v) {
    var t = card.head && card.head.querySelector('.np-label-text');
    if (!t || t.scrollWidth <= t.clientWidth + 1) return;
    if (v.kind === 'playing') t.textContent = T('nowplaying.label.playing', 'Playing');
  }

  function eq(parent, v) {
    var box = el('span', 'np-eq' + (v.moving ? ' is-playing' : ''), parent);
    el('i', '', box);
    el('i', '', box);
    el('i', '', box);
    return box;
  }

  function sizeArt(box, px) {
    px = Math.max(0, Math.floor(px));
    box.style.width = px + 'px';
    box.style.height = px + 'px';
    return px;
  }

  /* ---------- the tile ---------- */

  // The header badge: the state in a word or two (Spanish in app/i18n.js).
  var BADGES = { off: 'Not set up', signin: 'Not connected', idle: 'Nothing playing', error: 'No Spotify',
    waiting: 'Waiting', offline: 'No Pi', update: 'Needs the Pi' };
  function badgeWord(kind) {
    var en = BADGES[kind] || '';
    var L = window.HUB_I18N;
    if (en && L && typeof L.t === 'function') { try { return String(L.t('nowplaying.badge.' + kind, en)); } catch (e) { /* English */ } }
    return en;
  }

  // Which layout this size gets.
  function layoutFor(size) {
    if (!size) return 'row';
    if (size.cols <= 1) return 'icon';
    if (size.tier === 'strip') return size.width === 'narrow' ? 'icon' : 'row';
    if (size.width === 'narrow') return 'col';
    if (size.tier === 'tall' && size.width !== 'wide') return 'col';
    return 'row';
  }

  function drawTile(body, ctx) {
    var size = ctx.size ? ctx.size() : null;
    var v = view();
    var layout = layoutFor(size);
    var strip = !!size && size.tier === 'strip';
    var root = el('div', 'np-tile np-' + layout + (strip ? ' np-strip' : '') + ' np-k-' + v.kind, body);
    var card = { root: root, v: v, layout: layout, strip: strip };
    tiles.push(card);

    // Only waiting for the Pi, with no song to show: the hub may draw the
    // tile quietly (motion extras, quietTiles): a small mark and one line.
    var waiting = !v.track && (v.kind === 'waiting' || v.kind === 'offline' || v.kind === 'update');
    if (waiting) root.className += ' hub-dormant';
    // Without a song, a tile of two rows or more has the hub's header (the
    // music icon, "Spotify", the state as a badge) instead of a lone label.
    var headed = !strip && layout !== 'icon' && typeof ctx.drawHead === 'function';
    if (waiting && layout !== 'icon' && document.body.classList.contains('fx-quiet')) {
      root.className += ' np-quiet' + (headed ? ' np-headed' : '');
      if (headed) ctx.drawHead(root, { icon: 'music', title: 'Spotify' });
      else {
        var qhead = el('div', 'np-quiet-head', root);
        var qmark = el('span', 'icon np-quiet-mark', qhead);
        qmark.innerHTML = icon('music');
        el('span', 'np-label-text np-quiet-label', qhead, v.label);
      }
      el('div', 'np-title hub-quiet-line', root, v.title);
      root.title = v.hint;
      card.hasBar = false;
      return;
    }

    var hasSong = !!v.track && v.kind !== 'signin' && v.kind !== 'off';
    if (!hasSong && headed) {
      root.className += ' np-headed';
      var hd = ctx.drawHead(root, { icon: 'music', title: 'Spotify', badge: badgeWord(v.kind) });
      // The whole state in words, for a mouse on a laptop.
      var badge = hd && hd.querySelector('.tile-badge');
      if (badge) badge.setAttribute('title', v.title);
      card.artist = el('div', 'np-artist np-hint np-headed-hint', root, v.hint);
      card.hasBar = false;
      return;
    }
    card.art = hasSong || layout === 'icon' ? artBox(root, v, 'np-art-tile', layout === 'col' && size.tier === 'tall') : null;
    if (!card.art && layout !== 'icon') {
      // No song: a quiet mark instead of a picture.
      card.art = artBox(root, { track: null, dim: true }, 'np-art-tile', false);
    }

    if (layout !== 'icon') {
      var text = el('div', 'np-text', root);
      var head = el('div', 'np-label', text);
      eq(head, v);
      el('span', 'np-label-text', head, v.label);
      if (hasSong) {
        card.title = el('div', 'np-title', text, v.track.title);
        card.artist = el('div', 'np-artist', text, v.track.artist || v.track.album || '');
        if (v.kind === 'error' || v.kind === 'offline' || v.kind === 'update') {
          // The reason, small, under the last song.
          card.note = el('div', 'np-note', text, v.kind === 'error' ? T('nowplaying.cantBeReached', 'Spotify can’t be reached') : v.title);
        }
      } else {
        card.title = el('div', 'np-title', text, v.title);
        card.artist = el('div', 'np-artist np-hint', text, v.hint);
      }
      card.text = text;
      card.head = head;
    } else if (!hasSong) {
      // Art only and nothing to show: the mark alone, so say it in a tooltip.
      root.title = v.title;
    }

    card.bar = el('div', 'np-bar', root);
    card.fill = el('div', 'np-fill', card.bar);
    card.hasBar = hasSong && (v.kind === 'playing' || v.kind === 'paused');
    card.bar.style.visibility = card.hasBar ? '' : 'hidden';
    paintBar(card);
    fitTile(body, card, size);
    if (card.head) shortLabel(card, v);
  }

  function paintBar(card) {
    if (!card.hasBar) return;
    card.fill.style.transform = 'scaleX(' + fraction(card.v).toFixed(4) + ')';
  }

  // Sizes the picture from the room, then lets the words use what is left.
  function fitTile(body, card, size) {
    var room = { w: body.clientWidth, h: body.clientHeight };
    if (!room.w || !room.h || !card.art) return;
    var r = rem();
    var barRoom = card.hasBar ? 0.9 * r : 0;     // the bar and the gap above it
    var px;
    if (card.layout === 'icon') {
      px = Math.min(room.w, room.h - barRoom);
      sizeArt(card.art, Math.max(2 * r, px));
      return;
    }
    if (card.layout === 'row') {
      px = Math.min(room.h - barRoom, room.w * (card.strip ? 0.4 : 0.46));
      px = sizeArt(card.art, Math.max(2.4 * r, px));
      var col = room.w - px - 1.1 * r;
      card.text.style.width = Math.max(0, col) + 'px';
      fitRowText(card, room.h - barRoom);
      return;
    }
    // col: the picture over the words. Try two lines of title, then one.
    var tries = [2, 1];
    for (var i = 0; i < tries.length; i++) {
      clamp(card.title, tries[i]);
      clamp(card.artist, 1);
      var textH = outer(card.head) + outer(card.title) + outer(card.artist) + outer(card.note);
      px = Math.min(room.w, room.h - barRoom - textH - 0.7 * r);
      if (px >= 4 * r || i === tries.length - 1) break;
    }
    if (px < 3 * r) {
      // Not enough height for a picture and words: the words go, the picture stays.
      card.text.style.display = 'none';
      px = Math.min(room.w, room.h - barRoom);
    }
    sizeArt(card.art, Math.max(2.4 * r, px));
  }

  // In a row the title takes the lines that are left beside the picture.
  function fitRowText(card, roomH) {
    var text = card.text;
    clamp(card.artist, 1);
    if (card.note) clamp(card.note, 1);
    var others = outer(card.head) + outer(card.artist) + outer(card.note);
    if (card.strip) {
      // One line: the title and the artist, nothing else.
      card.head.style.display = 'none';
      if (card.note) card.note.style.display = 'none';
      others = outer(card.artist);
    }
    var lines = Math.max(1, Math.floor((roomH - others) / lineHeight(card.title)));
    clamp(card.title, card.strip ? 1 : Math.min(lines, 3));
    // Still too tall (a big font on the TV): drop the artist before the title.
    if (outer(card.head) + outer(card.title) + outer(card.artist) + outer(card.note) > roomH + 1) {
      if (card.note) card.note.style.display = 'none';
      if (outer(card.head) + outer(card.title) + outer(card.artist) > roomH + 1) clamp(card.title, 1);
    }
    text.style.maxHeight = roomH + 'px';
  }

  /* ---------- the page ---------- */

  function drawPage(body, ctx) {
    var v = pageView();
    lastPageSig = pageSignature(v);
    var full = ctx.mode && ctx.mode() === 'full';
    var hasSong = !!v.track && v.kind !== 'signin' && v.kind !== 'off';
    var sounding = hasSong && (v.kind === 'playing' || v.kind === 'paused');
    var root = el('div', 'np-page np-k-' + v.kind + (v.other ? ' np-other' : '') + (full ? ' is-full' : ''), body);
    page = { root: root, v: v, full: full, hasSong: hasSong };

    var art = hasSong ? artBox(root, v, 'np-art-page', true) : artBox(root, { track: null, dim: true }, 'np-art-page', false);
    page.art = art;
    var info = el('div', 'np-info', root);
    page.info = info;

    var head = el('div', 'np-label', info);
    eq(head, v);
    el('span', 'np-label-text', head, v.label);
    if (v.kind === 'offline') el('span', 'np-tag', head, T('nowplaying.tagOffline', 'Offline'));
    if (v.other && v.other.source) {
      // The platform, quiet, after the label: only its name gives way.
      var plat = el('span', 'np-plat', head);
      el('span', 'np-plat-b', plat, '(');
      el('span', 'np-plat-name', plat, v.other.source);
      el('span', 'np-plat-b', plat, ')');
    }

    if (v.other) {
      page.title = el('div', 'np-title', info, v.track.title);
      page.note = v.other.note ? el('div', 'np-quiet-note', info, v.other.note) : null;
      page.artist = v.track.artist ? el('div', 'np-artist', info, v.track.artist) : null;
      page.album = v.track.album ? el('div', 'np-album', info, v.track.album) : null;
    } else if (hasSong) {
      page.title = el('div', 'np-title', info, v.track.title);
      page.artist = el('div', 'np-artist', info, v.track.artist || '');
      page.album = el('div', 'np-album', info, v.track.album || (v.track.kind === 'episode' ? T('nowplaying.podcast', 'Podcast') : ''));
      if (v.kind === 'error' || v.kind === 'offline' || v.kind === 'update') {
        page.note = el('div', 'np-note', info, v.kind === 'error' ? (v.hint || T('nowplaying.cantBeReached', 'Spotify can’t be reached')) : v.title + '. ' + v.hint);
      }
    } else {
      page.title = el('div', 'np-title', info, v.title);
      page.artist = el('div', 'np-artist np-hint', info, v.hint);
    }

    var foot = el('div', 'np-foot', info);
    page.foot = foot;
    if (v.other) {
      // No length is known: no times, no bar; the speaker as a chip.
      page.chips = el('div', 'np-chips', foot);
      if (v.device) el('span', 'np-chip', page.chips, T('nowplaying.chipOn', 'On {device}', { device: v.device }));
    } else if (sounding) {
      var times = el('div', 'np-times', foot);
      page.elapsed = el('span', 'np-elapsed', times);
      page.total = el('span', 'np-total', times, clock(v.track.durationMs || 0));
      page.bar = el('div', 'np-bar np-bar-page', foot);
      page.fill = el('div', 'np-fill', page.bar);
      var chips = el('div', 'np-chips', foot);
      page.chips = chips;
      if (v.device) el('span', 'np-chip', chips, T('nowplaying.chipOn', 'On {device}', { device: v.device }));
      if (v.shuffle) el('span', 'np-chip', chips, T('nowplaying.chipShuffle', 'Shuffle'));
      if (v.repeat === 'track') el('span', 'np-chip', chips, T('nowplaying.chipRepeatOne', 'Repeat one'));
      else if (v.repeat === 'context') el('span', 'np-chip', chips, T('nowplaying.chipRepeat', 'Repeat'));
      if (v.track.explicit) el('span', 'np-chip', chips, T('nowplaying.chipExplicit', 'Explicit'));
    } else if (hasSong && v.kind === 'idle') {
      el('div', 'np-chips', foot);
    }
    // The Visualizer button, while something plays or is paused.
    if (sounding && canViz(v)) vizButton(foot, full && vizWanted);
    // Full screen with the visualizer moving: a small card in the upper left.
    page.compact = full && sounding && vizWanted && safe(vizCompact)() === true;
    if (page.compact) root.className += ' np-card';
    pageTick();
    fitPage(body);
    safe(vizSync)();
        safe(bandSync)();
  }

  // The picture as large as the room allows, then the words in what is left.
  function fitPage(body) {
    if (!page) return;
    if (page.compact) { fitCard(body); return; }
    var r = rem();
    var h = body.clientHeight;
    var w = body.clientWidth;
    if (!h || !w) return;
    var px = Math.min(h - 0.4 * r, w * (page.full ? 0.46 : 0.44));
    px = sizeArt(page.art, Math.max(6 * r, px));
    // The body has half a rem of padding on each side for focus rings.
    var col = w - r - px - (page.full ? 3.4 : 2) * r;
    page.info.style.width = Math.max(10 * r, col) + 'px';
    page.root.style.height = (h - 0.2 * r) + 'px';
    // The title may take three lines (two in the small page), the artist two,
    // the album two; whatever still does not fit is trimmed from the bottom up.
    var roomH = h - 0.2 * r;
    clamp(page.title, page.full ? 3 : 2);
    if (page.artist) clamp(page.artist, 2);
    if (page.album) clamp(page.album, 1);
    var used = function () {
      return outer(page.info.firstChild) + outer(page.title) + outer(page.artist) + outer(page.album) + outer(page.note) + outerFoot(page.foot);
    };
    if (used() > roomH && page.album) page.album.style.display = 'none';
    if (used() > roomH && page.artist) clamp(page.artist, 1);
    if (used() > roomH) clamp(page.title, 1);
    if (used() > roomH && page.note) page.note.style.display = 'none';
  }

  // The small card: a 7.5rem picture, the words beside it, at most about a
  // third of the screen wide. Title two lines, artist and album one each;
  // when it runs tall the album goes first, then the chips, then the
  // title's second line.
  function fitCard(body) {
    var r = rem();
    page.root.style.height = '';
    var px = sizeArt(page.art, 7.5 * r);
    var maxW = Math.min(27 * r, Math.max(18 * r, body.clientWidth * 0.36));
    page.info.style.width = Math.max(8 * r, maxW - 2 * r - px - 1.1 * r) + 'px';
    clamp(page.title, 2);
    if (page.artist) clamp(page.artist, 1);
    if (page.album) clamp(page.album, 1);
    var limit = 15.5 * r + outer(page.vizRow);
    if (page.root.offsetHeight > limit && page.album) page.album.style.display = 'none';
    if (page.root.offsetHeight > limit && page.chips) page.chips.style.display = 'none';
    if (page.root.offsetHeight > limit) clamp(page.title, 1);
    trimChips();
  }

  // The card's chips stay on one row: those that do not fit are hidden.
  function trimChips() {
    if (!page || !page.compact || !page.chips) return;
    var list = page.chips.children;
    var i;
    for (i = 0; i < list.length; i++) list[i].style.display = '';
    var room = page.chips.clientWidth;
    for (i = 0; i < list.length; i++) {
      if (list[i].offsetLeft - page.chips.offsetLeft + list[i].offsetWidth > room + 1) list[i].style.display = 'none';
    }
  }

  function pageTick() {
    if (!page || !page.elapsed) return;
    var v = page.v;
    var t = clock(position(v));
    if (page.elapsed.textContent !== t) page.elapsed.textContent = t;
    page.fill.style.transform = 'scaleX(' + fraction(v).toFixed(4) + ')';
  }

  /* ---------- the Visualizer button ---------- */

  // False when the visualizer is off for good here (HUB_CONFIG.widgets.
  // nowplaying.visualizer false, ?viz=off) or not loaded: no button then.
  function canViz(v) {
    var V = window.HUB_NP_VIZ;
    if (!V || !V.sync || !v || !v.track) return false;
    if (C && C.config && C.config.visualizer === false) return false;
    try { return !V.plan || V.plan(vizChoice(v)) !== 'off'; } catch (e) { return false; }
  }

  // A pill under the chips: a small waveform mark and a word. OK goes
  // through onSelect (data-np="viz"); data-key keeps the focus on it when
  // the page is drawn again, data-autofocus puts it there when it opens.
  function vizButton(parent, on) {
    var row = el('div', 'np-actions', parent);
    var b = el('div', 'f np-viz-btn' + (on ? ' is-on' : ''), row);
    b.setAttribute('data-key', 'np:viz');
    b.setAttribute('data-np', 'viz');
    b.setAttribute('data-autofocus', '');
    b.setAttribute('role', 'button');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    var word = on ? T('nowplaying.vizHide', 'Hide visualizer') : T('nowplaying.viz', 'Visualizer');
    b.setAttribute('aria-label', word);
    var mark = el('span', 'np-viz-ic', b);
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false">' +
      '<path d="M3.5 12h1.5M7.5 8v8M11 5v14M14.5 9v6M18 7v10M20.5 12h.5"/></svg>';
    el('span', 'np-viz-tx', b, word);
    page.vizRow = row;
    page.vizBtn = b;
    return b;
  }

  // OK on the button: from the expanded page the visualizer always opens
  // full screen; in full screen it is turned on or off.
  function pressViz(ctx) {
    if (!page || !page.vizBtn) return;
    var mode = ctx.mode ? ctx.mode() : null;
    if (mode === 'full') {
      vizWanted = !vizWanted;
      ctx.redrawPanel();
      return;
    }
    vizWanted = true;
    if (ctx.setMode) ctx.setMode('full');
    // The hub ignores a switch while it is still moving: forget it then
    // (only this press's own check counts).
    var n = ++vizPress;
    setTimeout(function () { if (n === vizPress && (!ctx.isOpen || !ctx.isOpen() || ctx.mode() !== 'full')) vizWanted = false; }, 1500);
  }

  /* ---------- the visualizer (full screen only) ---------- */

  // Shows, updates or stops the visualizer for the page as it is now. It
  // lives in the panel itself, behind the body, so a redraw of the page does
  // not touch it.
  // What the visualizer needs to choose its level (before any layout).
  function vizChoice(v) {
    return {
      id: v.track.id || v.track.title,
      vibe: vibeOf(v),
      config: (C && C.config) || {},
      motionFade: !!document.body && document.body.classList.contains('motion-fade')
    };
  }

  // True when the visualizer will run at a level that goes with the card.
  function vizCompact() {
    var V = window.HUB_NP_VIZ;
    if (!V || !V.plan || !V.compact || !page || !page.v.track) return false;
    return V.compact(V.plan(vizChoice(page.v))) === true;
  }

  function vizSync() {
    var V = window.HUB_NP_VIZ;
    if (!V || !V.sync) return;
    var v = page && page.v;
    // A hard off (config, ?viz=off) still goes to V.sync, which only notes
    // it (the About panel says "off (config)") and draws nothing.
    var ok = (vizWanted || (!!page && !canViz(v))) && !!page && page.full && page.hasSong && (v.kind === 'playing' || v.kind === 'paused') &&
      !!C && C.isOpen && C.isOpen() && C.mode && C.mode() === 'full';
    var body = page && page.root.parentNode;
    var host = body && body.parentNode;
    if (!ok || !host) {
      V.sync(null);
      if (page) { page.root.classList.remove('npv-on'); page.vizOn = false; bpmChip(); }
      return;
    }
    var hr = host.getBoundingClientRect();
    var ar = page.art.getBoundingClientRect();
    var ir = page.info.getBoundingClientRect();
    var k = host.offsetWidth ? hr.width / host.offsetWidth : 1;     // a panel still scaling in
    var info = vizChoice(v);
    info.art = v.track.artTiny || v.track.artSmall || '';
    info.playing = v.kind === 'playing';
    info.positionMs = position(v);
    info.durationMs = v.track.durationMs || 0;
    info.center = { x: (ar.left - hr.left + ar.width / 2) / k, y: (ar.top - hr.top + ar.height / 2) / k, size: ar.width / k };
    // The card has its own dark backing: no shade under the words then.
    info.textLeft = page.compact ? host.offsetWidth : (ir.left - hr.left) / k;
    // A step down to the still wash brings the big picture back.
    info.relayout = function () { if (page && C && C.isOpen && C.isOpen() && C.redrawPanel) C.redrawPanel(); };
    var on = V.sync(host, info);
    if (on) page.root.classList.add('npv-on');
    else page.root.classList.remove('npv-on');
    page.vizOn = !!on;
    bpmChip();
    // The level it settled on wants the other layout (say a saved answer
    // arrived): lay the page out again, once.
    var want = !!on && V.compact(V.plan(info)) === true;
    if (want !== !!page.compact && C && C.redrawPanel && !page.relaid) {
      page.relaid = true;
      setTimeout(function () { if (page && C.isOpen && C.isOpen()) C.redrawPanel(); }, 0);
    }
  }

  // A small "124 BPM" among the chips while the visualizer shows and the
  // tempo is measured (not guessed from genres). Kept up to date in place.
  function bpmChip() {
    if (!page || !page.chips) return;
    var vb = page.full && page.vizOn ? vibeOf(page.v) : null;
    var text = vb && vb.source === 'features' && vb.tempo ? Math.round(vb.tempo) + ' BPM' : '';
    var chip = page.chips.querySelector('.np-chip-bpm');
    if (!text) { if (chip) chip.parentNode.removeChild(chip); return; }
    if (!chip) chip = el('span', 'np-chip np-chip-bpm', page.chips);
    if (chip.textContent !== text) chip.textContent = text;
    trimChips();
  }

  /* ---------- Ian and Ember (nowplaying-band.js) ---------- */

  // Full screen with the visualizer and the small card: the stage. The
  // expanded page, or full screen without the visualizer: the corner, if the
  // bottom right has room beside the chips and the button.
  function bandSync() {
    var B = window.HUB_NP_BAND;
    if (!B || !B.sync) return;
    var v = page && page.v;
    var body = page && page.root.parentNode;
    var host = body && body.parentNode;
    var open = !!page && !!C && !!C.isOpen && C.isOpen();
    if (!open || !host || !page.hasSong || !v.track || v.track.kind === 'episode' || (v.kind !== 'playing' && v.kind !== 'paused')) {
      B.sync(null);
      bandChip('');
      return;
    }
    var stage = !!(page.full && page.vizOn && page.compact);
    var vb = vibeOf(v);
    var level = '';
    if (stage) { try { level = window.HUB_NP_VIZ.plan(vizChoice(v)); } catch (e) { level = ''; } }
    var info = {
      mode: stage ? 'stage' : 'corner',
      playing: v.kind === 'playing',
      tempo: vb ? vb.tempo : 0,
      level: level,
      genres: vb ? vb.genres : [],
      artist: v.track.artist || '',
      trackId: String(v.track.id || v.track.title || ''),
      config: (C && C.config) || {},
      chip: bandChip
    };
    if (!stage) {
      info.corner = bandCorner(host);
      if (!info.corner) { B.sync(null); bandChip(''); return; }
    }
    B.sync(host, info);
  }

  // The free bottom-right corner of the page, in the panel's own px: right
  // of anything in the bottom 170 px (times the zoom). The feet stand just
  // above the panel's bottom edge.
  function bandCorner(host) {
    var r = rem();
    var hr = host.getBoundingClientRect();
    var k = host.offsetWidth ? hr.width / host.offsetWidth : 1;
    if (!k) return null;
    var H = host.offsetHeight, W = host.offsetWidth;
    var z = page.full ? 1.3 : 1;
    var floor = H - 0.35 * r;
    var top = floor - 170 * z;
    var left = 0;
    var parts = [page.art];
    var kids = page.foot ? page.foot.querySelectorAll('.np-chips, .np-chip, .np-actions, .np-viz-btn, .np-times, .np-bar') : [];
    for (var i = 0; i < kids.length; i++) parts.push(kids[i]);
    for (var j = 0; j < parts.length; j++) {
      var n = parts[j];
      if (!n || !n.getBoundingClientRect || n.offsetHeight === 0) continue;
      var b = n.getBoundingClientRect();
      var bt = (b.top - hr.top) / k, bb = (b.bottom - hr.top) / k, br = (b.right - hr.left) / k;
      if (n.className.indexOf('np-chips') >= 0) {
        // A chips row is as wide as its column; only its chips count.
        continue;
      }
      if (bb > top && bt < floor && br > left) left = br;
    }
    var right = W - 1.4 * r;
    return { right: right, floor: floor, room: right - left - 0.8 * r, z: z };
  }

  var OUTFIT_WORDS = { punk: 'punk', rock: 'rock', country: 'country', hiphop: 'hip hop', synth: 'synth-pop' };

  // "Dressed for punk" among the chips while the outfit scene plays.
  function bandChip(word) {
    if (!page || !page.chips) return;
    var chip = page.chips.querySelector('.np-chip-band');
    if (!word || !OUTFIT_WORDS[word]) { if (chip) { chip.parentNode.removeChild(chip); trimChips(); } return; }
    var text = T('nowplaying.bandChip', 'Dressed for {genre}', { genre: T('nowplaying.outfit.' + word, OUTFIT_WORDS[word]) });
    if (!chip) {
      // First in the row: while it plays it is the news, and a full card row
      // drops chips from the end.
      chip = el('span', 'np-chip np-chip-band');
      page.chips.insertBefore(chip, page.chips.firstChild);
    }
    if (chip.textContent !== text) chip.textContent = text;
    trimChips();
  }

  /* ---------- keeping up ---------- */

  function tick() {
    var i;
    for (i = 0; i < tiles.length; i++) {
      var card = tiles[i];
      // A tile that has been redrawn is no longer in the page.
      if (card.root.parentNode && card.hasBar) {
        if (card.v.kind === 'playing') {
          // A song that has run to its end: the Pi will say what is next.
          paintBar(card);
        }
      }
    }
    if (page && page.v.kind === 'playing') {
      pageTick();
      if (page.full && window.HUB_NP_VIZ) window.HUB_NP_VIZ.tick(position(page.v));
    }
  }

  // The part of the data that changes how the tile looks, not where the song is.
  function signature() {
    var v = view();
    return JSON.stringify([v.kind, v.label, v.title, v.hint, v.track && [v.track.id, v.track.title, v.track.artist, v.track.art, v.track.artSmall],
      v.dim, v.device, v.shuffle, v.repeat, data && data.problem]);
  }

  // The part of what the page shows that needs it drawn again (the tile has
  // signature()): which sound, its words, and whether the button can show.
  function pageSignature(pv) {
    var v = pv || pageView();
    var o = v.other;
    return JSON.stringify([o ? 1 : 0, v.kind, v.label, o && [o.title, o.sub, o.album, o.source, o.device, o.art, o.note], v.track ? canViz(v) : false]);
  }

  // What makes a song this song: its id and title ('' when none plays).
  function songOf(d) {
    var t = d && typeof d === 'object' ? d.track : null;
    if (!t || typeof t !== 'object') return '';
    var id = t.id === undefined || t.id === null ? '' : String(t.id);
    var title = typeof t.title === 'string' ? t.title : '';
    return id || title ? id + '\n' + title : '';
  }

  // True when d brings another song than the last one seen this run. The
  // first data only sets what was playing; data without a song (idle, an
  // advert, the Pi away) keeps it, so the same song again is not news.
  function songChanged(d) {
    var key = songOf(d);
    var first = songKey === null;
    var news = !first && key !== '' && songKey !== '' && key !== songKey;
    if (key !== '' || first) songKey = key;
    return news;
  }

  function songChip() {
    var t = now();
    if (t - songChipAt < SONG_CHIP_GAP_MS) return;
    songChipAt = t;
    if (C && typeof C.activity === 'function') {
      try { C.activity('nowplaying'); } catch (e) { /* the song just shows */ }
    }
  }

  function changed(newData, rev, nowAt) {
    data = newData && typeof newData === 'object' ? newData : null;
    gotAt = nowAt || now();
    var news = songChanged(data);
    if (data && data.track) {
      cached = { track: data.track, playedAt: data.playedAt || 0 };
      lsSet(CACHE_KEY, cached);
    }
    refresh(false);
    // After the redraw, so the chip goes on the tile as it is now.
    if (news) songChip();
  }

  // Redraws the tile and the page when what they show changed. A seek or a
  // resume only needs the bar moved to the new place.
  function refresh(force) {
    if (!C) return;
    var sig = signature();
    var open = !!page && !!C.isOpen && C.isOpen();
    if (!force && sig === lastSig) {
      var i;
      for (i = 0; i < tiles.length; i++) { tiles[i].v = view(); paintBar(tiles[i]); }
      if (page) {
        var pv = pageView();
        // Another sound came or went, or changed: the page only.
        if (open && pageSignature(pv) !== lastPageSig) { C.redrawPanel(); return; }
        page.v = pv;
        pageTick();
        safe(vizSync)();
        safe(bandSync)();
      }
      return;
    }
    lastSig = sig;
    C.redrawTile();
    if (page && C.isOpen && C.isOpen()) C.redrawPanel();
  }

  /* ---------- the widget ---------- */

  return {
    id: 'nowplaying',
    get title() { return T('nowplaying.title', 'Now Playing'); },
    icon: 'music',
    head: false,
    activity: 'nowplaying',    // its activity kind, "New song" (app/motion.js)

    init: safe(function (ctx) {
      C = ctx;
      cached = lsGet(CACHE_KEY);
      if (cached && !(cached.track && typeof cached.track.title === 'string')) cached = null;
      if (ctx.live) {
        var held = ctx.live.get('nowplaying');
        if (held) { data = held; gotAt = now(); songChanged(held); }
        ctx.live.on('nowplaying', safe(function (d, rev) { changed(d, rev); }));
        // Any other sound in the house (the page shows it when Spotify is quiet).
        var heldSounds = ctx.live.get('allsounds');
        if (heldSounds && typeof heldSounds === 'object') sounds = heldSounds;
        ctx.live.on('allsounds', safe(function (d) {
          sounds = d && typeof d === 'object' ? d : null;
          refresh(false);
        }));
        // The line to the Pi going or coming changes what is true to say.
        ctx.live.onStatus(safe(function () { refresh(false); }));
      }
      // Sound the TV itself plays (./hub play, ./hub news).
      try {
        if (window.HUB_AUDIO && typeof window.HUB_AUDIO.onChange === 'function') window.HUB_AUDIO.onChange(safe(function () { refresh(false); }));
      } catch (e) { /* the TV's own sound simply doesn't show */ }
      timer = setInterval(safe(tick), 1000);
      // A language change: the words are drawn again.
      try {
        if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') {
          window.HUB_I18N.onChange(safe(function () {
            ctx.redrawTile();
            if (ctx.isOpen && ctx.isOpen()) ctx.redrawPanel();
          }));
        }
      } catch (e) { /* the words change at the next draw */ }
    }),

    renderTile: function (body, ctx) {
      C = ctx;
      // Forget cards whose tile was cleared by this redraw.
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
        if (window.console && console.warn) console.warn('Now Playing page: ' + (e && e.message));
        page = null;
        body.innerHTML = '';
        el('div', 'np-fallback', body, T('nowplaying.broken', 'Now Playing couldn’t be shown.'));
        safe(vizSync)();
        safe(bandSync)();
      }
    },

    // OK on the page's Visualizer button.
    onSelect: safe(function (target, ctx) {
      if (target && target.getAttribute && target.getAttribute('data-np') === 'viz') pressViz(ctx);
    }),

    onMode: function (mode, ctx) {
      // Out of full screen the visualizer is forgotten: the button asks again.
      if (mode !== 'full') { vizWanted = false; vizPress++; }
      ctx.redrawPanel();
    },

    onClose: function (ctx) {
      vizWanted = false;
      vizPress++;
      page = null;
      safe(vizSync)();
        safe(bandSync)();
    },

    onStatus: safe(function () { refresh(false); })
  };
})());
