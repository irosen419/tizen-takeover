/*
 * Flashcards: Spanish verb forms with spaced repetition. The first Spanish
 * study widget (plan: docs/spanish-flashcards.md) and the first tile that is
 * used in place on the TV (hub.js, "engage on OK").
 *
 *   front    the verb, who and the tense: "tener", "tú · pretérito", "to have"
 *   back     the form: "tuviste" (and on the page a real sentence, Tatoeba)
 *   deck     app/spanish-cards.js (70 verbs, 4 tenses, 5 persons; built by
 *            dev/build-spanish-cards.js from Conjugate Me); math in
 *            app/flash-math.js; progress on the Pi (pi/spanish.js):
 *            GET /spanish/progress, POST /spanish/ops
 *
 * TV, tile (3x2 or bigger): OK engages it (the hub's ring changes and its
 * hint shows); then OK flips, Left = Again, Right = Got it, Back leaves,
 * holding OK opens the page. A strip or a narrow tile only shows the next
 * card or the counts, and OK opens the page as usual.
 * TV, page: the same keys (Left again, OK flip, Right got it); Up reaches
 * the Full screen button.
 * Wall tablet (tablet mode) and phone (renderTouch): tap the card to flip,
 * tap Again or Got it.
 *
 * Spanish (the learning content) stays Spanish in both hub languages; the
 * labels follow the hub (flash.* in app/i18n.js). Plain ES5, no flex gap.
 */
(function (root) {
  'use strict';

  var MIN_ENGAGE_COLS = 3;
  var MIN_ENGAGE_ROWS = 2;
  var RETRY_MS = 60000;

  function M() { return root.HUB_FLASH_MATH; }

  function T(key, en, vars) {
    var L = root.HUB_I18N;
    if (L && typeof L.t === 'function') { try { return String(L.t(key, en, vars)); } catch (e) { /* English below */ } }
    return String(en).replace(/\{(\w+)\}/g, function (all, n) { return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all; });
  }

  function title() { return T('flash.title', 'Flashcards'); }

  /* ---------- the session (one per page: the TV, the tablet or the phone) ---------- */

  var S = {
    list: null, byId: {}, progress: {}, today: '', intro: 0, reviewed: 0, counted: {},
    queue: [], pos: 0, flipped: false, requeued: {}, answered: 0, extra: 0,
    loaded: false, loading: false, failed: false, pending: [], sending: false, inflight: 0, retry: null, dayChanged: false,
    transport: null, listeners: [], localDay: ''
  };

  function cards() {
    if (S.list) return S.list;
    var m = M();
    S.list = m ? m.cards(root.HUB_SPANISH_CARDS) : [];
    for (var i = 0; i < S.list.length; i++) S.byId[S.list[i].id] = S.list[i];
    return S.list;
  }

  function today() { return S.today || (M() ? M().dayOf(new Date()) : ''); }

  function notify(what) {
    for (var i = 0; i < S.listeners.length; i++) {
      try { S.listeners[i](what || 'all'); } catch (e) { /* one view never stops the rest */ }
    }
  }

  function rebuild() {
    var m = M();
    if (!m) return;
    S.queue = m.queue(cards(), S.progress, today(), { intro: S.intro, newPerDay: m.NEW_PER_DAY + S.extra });
    S.pos = 0;
    S.flipped = false;
    S.requeued = {};
    S.answered = 0;
  }

  function current() { return S.pos < S.queue.length ? S.byId[S.queue[S.pos]] || null : null; }

  // What the views draw: 'card', 'done' (a round finished) or 'clear' (nothing due, no new left).
  function state() {
    if (!cards().length) return 'none';
    if (current()) return 'card';
    return S.answered ? 'done' : 'clear';
  }

  function load() {
    if (!S.transport || S.loading) return;
    S.loading = true;
    S.transport.load(function (err, j) {
      S.loading = false;
      if (err || !j || !j.cards) { S.failed = !!err && S.loaded; notify(); return; }
      var newDay = S.dayChanged || (S.today && j.today !== S.today);
      S.dayChanged = false;
      S.progress = j.cards;
      S.today = j.today;
      S.intro = j.intro || 0;
      S.reviewed = j.reviewed || 0;
      S.counted = {};
      // Answers not sent yet stay on top of what the Pi had.
      // (Not the batch on its way: the Pi may already have it.)
      for (var i = S.sending ? S.inflight : 0; i < S.pending.length; i++) {
        var p = S.pending[i];
        S.progress[p.id] = M().apply(S.progress[p.id] || null, p.r, today());
      }
      var first = !S.loaded;
      S.loaded = true;
      S.failed = false;
      // A fresh round only when nothing is in hand: never under a card being read.
      var idle = !S.answered && !S.flipped && S.pos === 0;
      if (newDay) { S.extra = 0; rebuild(); } else if ((first && idle) || (!current() && !S.answered)) rebuild();
      notify();
    });
  }

  function send() {
    if (!S.transport || S.sending || !S.pending.length) return;
    var ops = S.pending.slice(0, 50);
    S.sending = true;
    S.inflight = ops.length;
    S.transport.send(ops, function (err, j) {
      S.sending = false;
      S.inflight = 0;
      if (err) {
        S.failed = true;
        notify('saved');
        if (!S.retry) S.retry = setTimeout(function () { S.retry = null; send(); }, RETRY_MS);
        return;
      }
      S.pending.splice(0, ops.length);
      var wasFailed = S.failed;
      S.failed = false;
      if (j) {
        if (j.today) S.today = j.today;
        if (typeof j.intro === 'number') S.intro = Math.max(S.intro, j.intro);
        if (typeof j.reviewed === 'number') S.reviewed = j.reviewed;
      }
      if (wasFailed) notify('saved');
      if (S.pending.length) send();
    });
  }

  function flip() {
    if (!current()) return;
    S.flipped = !S.flipped;
    notify('flip');
  }

  // r: 'got' or 'again'. A missed card comes back a few cards later (twice at most).
  function answer(r) {
    var c = current();
    var m = M();
    if (!c || !m) return;
    var rec = S.progress[c.id] || null;
    if (!rec) S.intro++;
    if (!S.counted[c.id]) { S.counted[c.id] = 1; S.reviewed++; }
    S.progress[c.id] = m.apply(rec, r, today());
    S.answered++;
    if (r === 'again' && (S.requeued[c.id] || 0) < 2) {
      S.requeued[c.id] = (S.requeued[c.id] || 0) + 1;
      S.queue.splice(Math.min(S.pos + 4, S.queue.length), 0, c.id);
    }
    S.pos++;
    S.flipped = false;
    S.pending.push({ id: c.id, r: r });
    send();
    notify(r);
  }

  // Ten more new cards today, after a round.
  function more() {
    S.extra += 10;
    rebuild();
    notify('more');
  }

  // A new local day: ask the Pi again (it sets today and a fresh round).
  function tick() {
    var m = M();
    if (!m) return;
    var d = m.dayOf(new Date());
    if (S.localDay && d !== S.localDay) {
      S.today = '';
      S.dayChanged = true;
      if (S.transport) load(); else { S.dayChanged = false; S.extra = 0; rebuild(); notify(); }
    }
    S.localDay = d;
  }

  function counts() { return M() ? M().counts(cards(), S.progress, today()) : { due: 0, fresh: 0, total: 0 }; }

  /* ---------- small DOM helpers ---------- */

  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  // A tap that is only this element's (the tile's own click would open the page).
  function onTap(node, fn) {
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      fn();
    });
  }

  function cue(c) { return c.personWord + ' · ' + c.tenseWord; }

  function metaText() {
    var st = state();
    if (st === 'card') return T('flash.count', 'Card {n} of {total}', { n: S.pos + 1, total: S.queue.length });
    var k = counts();
    return T('flash.counts', '{due} due · {fresh} new', { due: k.due, fresh: k.fresh });
  }

  // The card: both faces, the back over the front (opacity and transform only).
  function drawCard(parent, c, o) {
    var card = el('div', 'fc-card' + (S.flipped ? ' is-flipped' : '') + (o.enter ? ' fc-in' : ''), parent);
    var front = el('div', 'fc-face fc-front', card);
    el('div', 'fc-big fc-verb', front, c.verb);
    el('div', 'fc-cue', front, cue(c));
    if (o.gloss !== false) el('div', 'fc-gloss', front, c.en);
    var back = el('div', 'fc-face fc-back', card);
    el('div', 'fc-big fc-form', back, c.form);
    el('div', 'fc-cue', back, cue(c) + ' · ' + c.verb);
    if (o.example && c.ex) {
      var ex = el('div', 'fc-ex', back);
      el('div', 'fc-ex-es', ex, c.ex[0]);
      el('div', 'fc-ex-en', ex, c.ex[1] + ' · Tatoeba');
    } else if (o.gloss !== false) {
      el('div', 'fc-gloss', back, c.en);
    }
    return card;
  }

  function drawEmpty(parent, st) {
    var box = el('div', 'fc-card fc-empty', parent);
    if (st === 'none') { el('div', 'fc-big fc-done', box, T('flash.noCards', 'No cards')); return box; }
    el('div', 'fc-big fc-done', box, st === 'done' ? T('flash.done', 'Done for now') : T('flash.clear', 'All caught up'));
    el('div', 'fc-cue', box, T('flash.answered', '{n} answered today', { n: S.reviewed }));
    return box;
  }

  function arrowL() { return '◀ '; }
  function arrowR() { return ' ▶'; }

  /* ---------- the TV tile ---------- */

  var tileCtx = null;
  var lastDraw = '';

  function bigEnough(ctx) {
    var z = ctx.size();
    return z.cols >= MIN_ENGAGE_COLS && z.rows >= MIN_ENGAGE_ROWS;
  }

  function renderTile(body, ctx) {
    tileCtx = ctx;
    body.classList.add('fc-tile');
    body.classList.remove('fc-small');
    var z = ctx.size();
    var c = current();
    var st = state();
    var arrows = !ctx.tablet;
    if (!bigEnough(ctx)) {
      body.classList.add('fc-small');
      if (c && z.rows === 1 && z.cols >= 3) {
        var line = el('div', 'fc-line', body);
        el('span', 'fc-line-verb', line, c.verb);
        line.appendChild(document.createTextNode(' · ' + cue(c)));
      } else {
        var k = counts();
        el('div', 'fc-small-n', body, String(k.due + Math.min(k.fresh, M() ? M().NEW_PER_DAY : 0)));
        el('div', 'fc-small-l', body, T('flash.toStudy', 'to study'));
      }
      return;
    }
    // Where the round stands goes in the head's badge ("3/10"), leaving the card the room.
    if (ctx.setBadge) ctx.setBadge(st === 'card' ? (S.pos + 1) + '/' + S.queue.length : '');
    var stage = el('div', 'fc-stage', body);
    var enter = lastDraw && lastDraw !== (c ? c.id : st);
    lastDraw = c ? c.id : st;
    if (c) {
      var card = drawCard(stage, c, { enter: enter, gloss: z.rows >= 2 });
      onTap(card, flip);
      var row = el('div', 'fc-row', body);
      var again = el('div', 'fc-btn fc-again', row, (arrows ? arrowL() : '') + T('flash.again', 'Again'));
      var got = el('div', 'fc-btn fc-got', row, T('flash.got', 'Got it') + (arrows ? arrowR() : ''));
      onTap(again, function () { answer('again'); });
      onTap(got, function () { answer('got'); });
    } else {
      drawEmpty(stage, st);
      if (st === 'done' || st === 'clear') {
        var row2 = el('div', 'fc-row', body);
        var btn = el('div', 'fc-btn fc-more', row2, T('flash.more', 'Ten more'));
        onTap(btn, more);
      }
    }
    var foot = el('div', 'fc-foot' + (S.failed ? ' is-warn' : ''), body,
      S.failed ? T('flash.notSavedShort', 'Not saved yet') : ctx.tablet ? T('flash.tapFlip', 'Tap the card to flip') : T('flash.okStart', 'OK to start'));
    foot.setAttribute('data-k', 'foot');
    fitCard(stage);
  }

  function contentHeight(face) {
    var sum = 0;
    for (var k = 0; k < face.children.length; k++) {
      var cs = window.getComputedStyle(face.children[k]);
      sum += face.children[k].offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }
    return sum;
  }

  // A card taller than its stage gives up the English, then the cue (measured once per draw).
  function fitCard(stage) {
    var h = stage.clientHeight;
    if (!h) return;
    var faces = stage.querySelectorAll('.fc-face');
    for (var i = 0; i < faces.length; i++) {
      var drop = ['.fc-gloss', '.fc-cue'];
      for (var d = 0; d < drop.length && contentHeight(faces[i]) > h + 1; d++) {
        var n = faces[i].querySelector(drop[d]);
        if (n) n.parentNode.removeChild(n);
      }
    }
  }

  // A flip changes classes only (the faces cross-fade); everything else redraws.
  function flipTile() {
    var cards = document.querySelectorAll('.fc-tile .fc-card, #panel .fc-pcard');
    for (var i = 0; i < cards.length; i++) {
      if (S.flipped) cards[i].classList.add('is-flipped'); else cards[i].classList.remove('is-flipped');
    }
  }

  /* ---------- the TV page ---------- */

  function renderPanel(body, ctx) {
    var c = current();
    var st = state();
    var arrows = !ctx.tablet;
    var page = el('div', 'fc-page', body);
    el('div', 'fc-meta', page, metaText());
    var stage = el('div', 'fc-stage', page);
    if (c) {
      var card = drawCard(stage, c, { example: true });
      card.className += ' fc-pcard';
      onTap(card, flip);
      var row = el('div', 'fc-row', page);
      var again = el('div', 'fc-btn fc-again f', row, (arrows ? arrowL() : '') + T('flash.again', 'Again'));
      again.setAttribute('data-key', 'again');
      var fl = el('div', 'fc-btn fc-flip f', row, T('flash.flip', 'Flip'));
      fl.setAttribute('data-key', 'flip');
      fl.setAttribute('data-autofocus', '1');
      var got = el('div', 'fc-btn fc-got f', row, T('flash.got', 'Got it') + (arrows ? arrowR() : ''));
      got.setAttribute('data-key', 'got');
    } else {
      drawEmpty(stage, st);
      if (st === 'done' || st === 'clear') {
        var row2 = el('div', 'fc-row', page);
        var m = el('div', 'fc-btn fc-more f', row2, T('flash.more', 'Ten more'));
        m.setAttribute('data-key', 'more');
        m.setAttribute('data-autofocus', '1');
      }
    }
    if (S.failed) el('div', 'fc-note', page, T('flash.notSaved', 'Not saved yet: the Pi is out of reach. It tries again by itself.'));
    if (ctx.setSub) ctx.setSub(T('flash.sub', 'Spanish verbs · {due} due', { due: counts().due }));
  }

  function hasCls(n, c) { return !!n && (' ' + n.className + ' ').indexOf(' ' + c + ' ') >= 0; }

  /* ---------- the phone (app/touch.js) ---------- */

  function renderTouch(host, ctx) {
    useTransport({
      load: function (cb) { ctx.call('GET', '/spanish/progress').then(function (j) { cb(null, j); }, function (e) { cb(e.message || 'offline'); }); },
      send: function (ops, cb) { ctx.call('POST', '/spanish/ops', { ops: ops }).then(function (j) { cb(null, j); }, function (e) { cb(e.message || 'offline'); }); }
    });
    var view = el('div', 'fc-touch', host);
    function draw() {
      view.innerHTML = '';
      var c = current();
      var st = state();
      el('div', 'fc-meta', view, metaText());
      var stage = el('div', 'fc-stage', view);
      if (c) {
        var card = drawCard(stage, c, { example: true });
        card.className += ' fc-pcard';
        onTap(card, flip);
        var row = el('div', 'fc-row', view);
        var again = el('button', 'fc-btn fc-again', row, T('flash.again', 'Again'));
        var got = el('button', 'fc-btn fc-got', row, T('flash.got', 'Got it'));
        again.type = 'button';
        got.type = 'button';
        onTap(again, function () { answer('again'); });
        onTap(got, function () { answer('got'); });
        el('div', 'fc-foot', view, T('flash.tapFlip', 'Tap the card to flip'));
      } else {
        drawEmpty(stage, st);
        if (st === 'done' || st === 'clear') {
          var b = el('button', 'fc-btn fc-more', el('div', 'fc-row', view), T('flash.more', 'Ten more'));
          b.type = 'button';
          onTap(b, more);
        }
      }
      if (S.failed) el('div', 'fc-note', view, T('flash.notSaved', 'Not saved yet: the Pi is out of reach. It tries again by itself.'));
    }
    function listen(what) {
      if (what === 'flip') {
        var card = view.querySelector('.fc-card');
        if (card) { if (S.flipped) card.classList.add('is-flipped'); else card.classList.remove('is-flipped'); }
        return;
      }
      draw();
    }
    S.listeners.push(listen);
    draw();
    load();
    var timer = setInterval(tick, 60000);
    return {
      update: function () {},
      destroy: function () {
        clearInterval(timer);
        var at = S.listeners.indexOf(listen);
        if (at >= 0) S.listeners.splice(at, 1);
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  function useTransport(t) {
    if (!S.transport) S.transport = t;
  }

  /* ---------- the widget ---------- */

  var widget = {
    id: 'flashcards',
    icon: 'cards',
    titleKey: 'flash.title',
    touchIcon: 'M5 7.5h12.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V9A1.5 1.5 0 0 1 5 7.5zM8 4.5h11a1.5 1.5 0 0 1 1.5 1.5v9',

    engage: function (ctx) { return bigEnough(ctx); },
    engageHint: function () { return T('flash.hint', 'OK: flip · Hold OK: open · Back: done'); },

    onEngagedKey: function (key, ctx) {
      var st = state();
      if (st === 'card') {
        if (key === 'ok') flip();
        else answer(key === 'left' ? 'again' : 'got');
      } else if (key === 'ok' && (st === 'done' || st === 'clear')) {
        more();
      }
    },

    init: function (ctx) {
      cards();
      S.localDay = M() ? M().dayOf(new Date()) : '';
      var live = ctx.live;
      if (live && typeof live.fetch === 'function' && typeof live.post === 'function') {
        useTransport({
          load: function (cb) { live.fetch('/spanish/progress', function (err, j) { cb(err, j); }); },
          send: function (ops, cb) { live.post('/spanish/ops', { ops: ops }, function (err, j) { cb(err, j); }); }
        });
      }
      rebuild();
      S.listeners.push(function (what) {
        if (what === 'flip') { flipTile(); return; }
        ctx.redrawTile();
        if (ctx.isOpen()) ctx.redrawPanel();
      });
      var L = root.HUB_I18N;
      if (L && typeof L.onChange === 'function') {
        L.onChange(function () { ctx.redrawTile(); if (ctx.isOpen()) ctx.redrawPanel(); });
      }
      setTimeout(load, 1200);
      setInterval(tick, 60000);
    },

    // The Pi came back (or live updates started): the progress if it is missing, and anything unsent.
    onStatus: function (ctx) {
      var st = ctx.live && ctx.live.status ? ctx.live.status() : null;
      if (!st || st.state !== 'live') return;
      if (!S.loaded || S.dayChanged) load();
      send();
    },

    renderTile: renderTile,
    renderPanel: renderPanel,

    // OK on a page button.
    onSelect: function (target) {
      if (hasCls(target, 'fc-flip')) flip();
      else if (hasCls(target, 'fc-again')) answer('again');
      else if (hasCls(target, 'fc-got')) answer('got');
      else if (hasCls(target, 'fc-more')) more();
    },

    // On the page, Left and Right answer (as on the tile); Up and Down move as usual.
    onMove: function (dir, from) {
      if ((dir !== 'left' && dir !== 'right') || !from || !hasCls(from, 'fc-btn') || state() !== 'card') return undefined;
      answer(dir === 'left' ? 'again' : 'got');
      return true;
    },

    onMode: function (mode, ctx) { ctx.redrawPanel(); },

    renderTouch: renderTouch,
    summary: function () { var k = counts(); return T('flash.counts', '{due} due · {fresh} new', { due: k.due, fresh: k.fresh }); }
  };

  try {
    Object.defineProperty(widget, 'title', { get: title, enumerable: true, configurable: true });
  } catch (e) {
    widget.title = 'Flashcards';
  }

  // For the tests: the session, and a way to start it over.
  root.HUB_FLASHCARDS_TEST = {
    state: function () { return { st: state(), pos: S.pos, queue: S.queue.slice(), flipped: S.flipped, today: today(), loaded: S.loaded, failed: S.failed, pending: S.pending.length, reviewed: S.reviewed, card: current() }; },
    progress: function () { return S.progress; }
  };

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push(widget);
})(typeof window !== 'undefined' ? window : this);
