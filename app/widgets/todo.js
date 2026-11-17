/*
 * To-do: a list kept on this TV (localStorage). Add, tick off, move between
 * Now, Next and Waiting on, and remove, with only the remote. Typing works
 * with the TV's on-screen keyboard or a USB or Bluetooth keyboard.
 *
 * Saved as homeHub.todo.v1 = { v: 1, items: [item] }, where an item is
 * { id, title, section: 'now' | 'next' | 'waiting', done, doneAt, createdAt,
 * due: 'YYYY-MM-DD' (optional), notes: 'plain text' (optional, at most 300
 * characters) }. Fields this file doesn't know are kept as they are.
 *
 * Notes come only from the Pi (./hub todo add --notes, the mailbox's
 * todo.add and todo.notes); the TV shows them under the title, quietly, and
 * shows nothing at all for an item without notes. The TV never edits them,
 * and every change it sends keeps them.
 *
 * Every word is in STRINGS. window.HUB_TODO_STRINGS, when set before this
 * file loads, replaces any of them key by key (the screenshots use it to try
 * Spanish; the TV stays English).
 *
 * With live updates (ctx.live, see docs/live-updates.md) the list is also
 * kept on the hub server on the Pi. The copy on the TV stays the working
 * copy: every change is made here first, then queued in
 * homeHub.todo.outbox = { v: 1, ops: [op], whole } and sent as ops. When the
 * outbox is empty the server's list is taken as it is. The first time this TV
 * meets a server's epoch (homeHub.todo.epoch) it uploads its own items, so
 * neither side's items are lost. Without ctx.live, or before this TV has ever
 * reached the server, nothing is queued and the widget works as before.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  /* Every word the widget shows, in one place for translating. {n} is a
     number, {d} a date. */
  var STRINGS = {
    sub: 'On this TV',
    subSynced: 'In sync',
    subToSend: 'Saved here, {n} to send',
    subSaved: 'Saved here',
    heroOne: 'to do now',
    heroMany: 'to do now',
    allClear: 'All clear for now',
    metaNext: '{n} next',
    metaWaiting: '{n} waiting',
    metaDone: '{n} done today',
    metaSep: ' · ',
    emptyTitle: 'Nothing on the list yet.',
    emptyHint: 'Press OK to add something.',
    more: '+{n} more',
    overdue: 'Overdue',
    dueToday: 'Due today',
    dueOn: 'Due {d}',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    sections: { now: 'Now', next: 'Next', waiting: 'Waiting on', done: 'Done today' },
    moveTo: { now: 'To Now', next: 'To Next', waiting: 'To Waiting on' },
    remove: 'Remove',
    removeArmed: 'Confirm',
    addPlaceholder: 'Add an item',
    hintOk: 'OK to type',
    hintTyping: 'Done or Enter adds it',
    emptyNow: 'Nothing for now.',
    emptySection: 'Nothing here.',
    listFull: 'The list is full. Tick off or remove something first.',
    warnNoStore: 'This TV isn’t saving the list. It stays until the hub closes.',
    warnSaveFail: 'Couldn’t save the last change. Storage on this TV may be full.',
    warnCorrupt: 'The saved list couldn’t be read, so a fresh one was started.',
    error: 'The to-do list ran into a problem.'
  };

  // window.HUB_TODO_STRINGS replaces words key by key (lists as a whole).
  function mergeStrings(dst, src) {
    if (!src || typeof src !== 'object') return;
    for (var k in src) {
      if (!src.hasOwnProperty(k) || !dst.hasOwnProperty(k)) continue;
      var v = src[k];
      var d = dst[k];
      if (d && typeof d === 'object' && !isArray(d)) {
        if (v && typeof v === 'object' && !isArray(v)) mergeStrings(d, v);
      } else if (isArray(d)) {
        if (isArray(v) && v.length === d.length) dst[k] = v;
      } else if (typeof v === 'string') {
        dst[k] = v;
      }
    }
  }
  try { mergeStrings(STRINGS, window.HUB_TODO_STRINGS); } catch (e) { /* keep English */ }

  var STORE_KEY = 'homeHub.todo.v1';
  var BAD_KEY = 'homeHub.todo.v1.bad';
  var MAX_TITLE = 80;
  var MAX_NOTES = 300;
  var MAX_OPEN = 60;
  var TILE_ROWS = 8;
  var SECTIONS = ['now', 'next', 'waiting'];
  var NEXT_SECTION = { now: 'next', next: 'waiting', waiting: 'now' };

  // 24x24 line icons, same style as icons.js.
  function svg(body, width) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (width || 1.75) + '" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  var ICON_PLUS = svg('<path d="M12 5v14"/><path d="M5 12h14"/>', 2);
  var ICON_TICK = svg('<path d="M5.5 12.5l4 4 9-9"/>', 3);
  var ICON_MOVE = svg('<path d="M4.5 12h15"/><path d="M13 5.5l6.5 6.5-6.5 6.5"/>', 2);
  var ICON_BIN = svg('<path d="M4 6.5h16"/><path d="M9.5 6.5V4.5h5v2"/>' +
    '<path d="M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-13"/><path d="M10 10.5v6.5"/><path d="M14 10.5v6.5"/>', 1.9);

  var C = null;              // ctx, kept from init
  var warn = null;           // null | 'nostore' | 'savefail' | 'corrupt'
  var ticked = {};           // ids ticked while the panel is open: they stay in place
  var armedAt = 0;           // when it was armed (a held OK must not count as the second press)
  var armed = null;          // the Remove button waiting for its second press
  var activeRow = null;      // the .todo-row holding panel focus
  var activeId = null;       // its item id, so a redraw keeps it active
  var flash = null;          // id whose tick plays the small pop on the next draw
  var panelBody = null;
  var lastDay = '';
  var idCount = 0;

  /* ---------- small helpers ---------- */

  function el(tag, cls, text, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function fill(text, n) { return text.replace('{n}', String(n)).replace('{d}', String(n)); }

  function tidy(text) { return String(text).replace(/\s+/g, ' ').trim(); }

  function isArray(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function dayOf(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }

  function today() { return dayOf(new Date()); }

  function newId() {
    idCount += 1;
    return 't' + new Date().getTime().toString(36) + idCount.toString(36);
  }

  function closest(node, cls) {
    while (node && node.nodeType === 1) {
      if (node.classList.contains(cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  // '' when the item has no due date or it's in the future past today.
  function dueText(due, now) {
    if (!due) return '';
    if (due < now) return STRINGS.overdue;
    if (due === now) return STRINGS.dueToday;
    var month = STRINGS.months[parseInt(due.substring(5, 7), 10) - 1] || '';
    return fill(STRINGS.dueOn, month + ' ' + parseInt(due.substring(8, 10), 10));
  }

  /* ---------- store ---------- */

  // Everything that touches storage lives here, so a Pi back end can take
  // its place later. Nothing in it throws.
  var store = {
    items: [],
    canSave: true,

    load: function () {
      var raw = null;
      var ls = null;
      try {
        ls = window.localStorage;
        if (ls) raw = ls.getItem(STORE_KEY);
      } catch (e) { ls = null; }
      if (!ls) {
        store.canSave = false;
        store.items = [];
        warn = 'nostore';
        return;
      }
      store.canSave = true;
      if (raw === null || raw === undefined) { store.items = []; return; }
      var data = null;
      try { data = JSON.parse(raw); } catch (e2) { data = null; }
      if (!data || typeof data !== 'object' || !isArray(data.items)) {
        try { ls.setItem(BAD_KEY, String(raw)); } catch (e3) { /* nowhere to keep it */ }
        store.items = [];
        warn = 'corrupt';
        return;
      }
      try {
        store.items = clean(data.items);
      } catch (e4) {
        try { ls.setItem(BAD_KEY, String(raw)); } catch (e5) { /* nowhere to keep it */ }
        store.items = [];
        warn = 'corrupt';
      }
    },

    // Keeps the list in memory whatever happens; the warning says so.
    save: function () {
      if (!store.canSave) return false;
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, items: store.items }));
        warn = null;
        return true;
      } catch (e) {
        warn = 'savefail';
        return false;
      }
    },

    // New items go to the top of Now.
    add: function (title) {
      var item = { id: newId(), title: title, section: 'now', done: false, doneAt: null, createdAt: new Date().getTime() };
      store.items.unshift(item);
      return item;
    },

    toggle: function (item) {
      item.done = !item.done;
      item.doneAt = item.done ? new Date().getTime() : null;
    },

    // Moves to the end of the next section in the cycle.
    move: function (item) {
      var i = store.items.indexOf(item);
      if (i < 0) return;
      store.items.splice(i, 1);
      item.section = NEXT_SECTION[item.section] || 'now';
      store.items.push(item);
    },

    remove: function (item) {
      var i = store.items.indexOf(item);
      if (i >= 0) store.items.splice(i, 1);
    },

    find: function (id) {
      for (var i = 0; i < store.items.length; i++) if (store.items[i].id === id) return store.items[i];
      return null;
    }
  };

  // Drops anything unusable and fixes the rest in place, keeping unknown fields.
  function clean(list) {
    var out = [];
    var seen = {};
    var now = new Date().getTime();
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || typeof it !== 'object' || isArray(it) || typeof it.title !== 'string') continue;
      var title = tidy(it.title).substring(0, MAX_TITLE);
      if (!title) continue;
      it.title = title;
      if (SECTIONS.indexOf(it.section) < 0) it.section = 'now';
      it.done = it.done === true;
      it.doneAt = it.done ? (typeof it.doneAt === 'number' ? it.doneAt : now) : null;
      if (typeof it.createdAt !== 'number') it.createdAt = now;
      // Notes: tidy text, or no field at all (never an empty one).
      if (it.notes !== undefined) {
        var notes = typeof it.notes === 'string' ? tidy(it.notes).substring(0, MAX_NOTES) : '';
        if (notes) it.notes = notes; else delete it.notes;
      }
      if (it.due !== undefined && !(typeof it.due === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(it.due))) delete it.due;
      // "in" also catches ids that clash with built-in names, such as "constructor".
      if (typeof it.id !== 'string' || !it.id || (it.id in seen)) it.id = newId();
      seen[it.id] = true;
      out.push(it);
    }
    return out;
  }

  // Done items last for the day they were ticked. Returns true if any went;
  // each one that went is also queued for the Pi.
  function purge() {
    var now = today();
    var kept = [];
    var gone = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (it.done && dayOf(new Date(it.doneAt)) !== now) { gone.push(it.id); delete ticked[it.id]; continue; }
      kept.push(it);
    }
    store.items = kept;
    for (var j = 0; j < gone.length; j++) queue({ op: 'remove', id: gone[j] });
    return gone.length > 0;
  }

  // The hub stays open for days, so look for a new day once a minute.
  function checkDay() {
    var now = today();
    if (now === lastDay) return;
    lastDay = now;
    if (purge()) store.save();
    refresh();
  }

  /* ---------- sync with the hub server on the Pi ---------- */

  var OUTBOX_KEY = 'homeHub.todo.outbox';
  var EPOCH_KEY = 'homeHub.todo.epoch';
  var MAX_OUTBOX = 300;     // past this, send the whole list instead
  var SEND_BATCH = 100;     // the server takes at most 100 ops at a time
  var SEND_BYTES = 6000;    // and a body of at most 8 KB
  var RETRY_MS = 30000;

  var sync = {
    ops: [],                // changes waiting to be sent, oldest first
    whole: false,           // the outbox overflowed: send the whole list next time
    gen: 0,                 // bumped when ops is replaced, so a late reply can't remove the wrong ones
    sending: false,         // one request at a time
    server: null,           // { epoch, rev, items }: the newest list from the server
    retryTimer: null,
    redrawLater: false,     // a list arrived while typing in the add box
    adopted: false          // a server list has been taken this run (the first is never "new")
  };

  function copy(x) { return JSON.parse(JSON.stringify(x)); }

  function lsGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (e) { /* kept in memory */ }
  }

  function live() { return C && C.live && typeof C.live.status === 'function' ? C.live : null; }

  function liveStatus() {
    var L = live();
    try { return (L && L.status()) || {}; } catch (e) { return {}; }
  }

  // Syncing applies once live updates are running and this TV has reached
  // the server before. Until then the first contact uploads the whole list.
  function syncing() {
    var L = live();
    if (!L) return false;
    try {
      return !!L.everConnected() && (L.status() || {}).state !== 'off';
    } catch (e) { return false; }
  }

  function loadOutbox() {
    var raw = lsGet(OUTBOX_KEY);
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      if (data && isArray(data.ops)) {
        sync.ops = data.ops;
        sync.whole = data.whole === true;
      }
    } catch (e) { /* start empty */ }
  }

  function saveOutbox() {
    lsSet(OUTBOX_KEY, JSON.stringify({ v: 1, ops: sync.ops, whole: sync.whole }));
  }

  function queue(op) {
    if (!syncing()) return;
    if (!sync.whole) {
      sync.ops.push(copy(op));
      if (sync.ops.length > MAX_OUTBOX) {
        sync.ops = [];
        sync.whole = true;
        sync.gen += 1;
      }
    }
    saveOutbox();
    syncStep();
  }

  // Every local item as an add, in list order, so the order holds on the server.
  function wholeList() {
    var ops = [];
    for (var i = 0; i < store.items.length; i++) ops.push({ op: 'add', item: copy(store.items[i]), at: 'end' });
    return ops;
  }

  function replaceOutbox(ops) {
    sync.ops = ops;
    sync.whole = false;
    sync.gen += 1;
    saveOutbox();
  }

  function waiting() { return sync.whole ? store.items.length : sync.ops.length; }

  function noteServer(rev, items) {
    var ep = String(liveStatus().epoch || '');
    var held = sync.server;
    if (held && held.epoch === ep && typeof rev === 'number' && typeof held.rev === 'number' && rev < held.rev) return;
    sync.server = { epoch: ep, rev: rev, items: items };
  }

  // Sends what is waiting, else takes the server's list. Runs on every
  // arrival, every status change and every local change.
  function syncStep() {
    if (!live()) return;
    var st = liveStatus();
    if (st.state === 'live' && syncing()) {
      var ep = st.epoch ? String(st.epoch) : '';
      if (ep && ep !== lsGet(EPOCH_KEY)) {
        replaceOutbox(wholeList());
        lsSet(EPOCH_KEY, ep);
      } else if (sync.whole) {
        replaceOutbox(wholeList());
      }
      if (sync.ops.length) send();
      else if (!sync.sending && sync.server && sync.server.epoch === ep) adopt(sync.server.items);
    }
    updateSubs();
  }

  function retryLater() {
    if (sync.retryTimer) clearTimeout(sync.retryTimer);
    sync.retryTimer = setTimeout(function () {
      sync.retryTimer = null;
      try { syncStep(); } catch (e) { /* the next arrival tries again */ }
    }, RETRY_MS);
  }

  function byteLength(text) {
    try { return unescape(encodeURIComponent(text)).length; } catch (e) { return text.length * 3; }
  }

  // The oldest ops that fit in one request, at least one.
  function nextBatch() {
    var batch = [];
    var bytes = 20;
    for (var i = 0; i < sync.ops.length && batch.length < SEND_BATCH; i++) {
      var size = byteLength(JSON.stringify(sync.ops[i])) + 1;
      if (batch.length && bytes + size > SEND_BYTES) break;
      batch.push(sync.ops[i]);
      bytes += size;
    }
    return batch;
  }

  // The server refused a batch (it is all or nothing). Its error names the op
  // at fault as "(op N)": only that one goes, so the rest can follow. Without
  // a name the whole batch goes, since it would be refused forever.
  function dropRefused(batch, err) {
    var m = /\(op (\d+)\)/.exec(String(err || ''));
    var at = m ? parseInt(m[1], 10) - 1 : -1;
    if (at >= 0 && at < batch.length) sync.ops.splice(at, 1);
    else sync.ops.splice(0, batch.length);
  }

  function send() {
    var L = live();
    if (!L || sync.sending || !sync.ops.length) return;
    var batch = nextBatch();
    var gen = sync.gen;
    sync.sending = true;
    L.post('/todo/ops', { ops: batch }, function (err, data, code) {
      sync.sending = false;
      try {
        if (!err && data && isArray(data.items)) {
          if (gen === sync.gen) sync.ops.splice(0, batch.length);
          saveOutbox();
          noteServer(data.rev, data.items);
          syncStep();
        } else if (code === 400 || code === 413) {
          if (gen === sync.gen) {
            if (code === 413 && batch.length > 1) sync.ops.splice(0, 1);
            else dropRefused(batch, err);
          }
          if (window.console && console.warn) console.warn('To-do: the Pi refused a change (' + err + ')');
          saveOutbox();
          syncStep();
        } else {
          updateSubs();
          retryLater();
        }
      } catch (e) {
        updateSubs();
      }
    });
  }

  // Takes the server's list as the working copy. Open items it has that
  // were nowhere here before are new from a sync: after the first list this
  // run (never on it) the tile says so (ctx.activity). The rows just appear.
  function adopt(items) {
    if (!isArray(items)) return;
    var list = clean(copy(items));
    var first = !sync.adopted;
    sync.adopted = true;
    if (JSON.stringify(list) === JSON.stringify(store.items)) return;
    var had = {};
    var k;
    for (k = 0; k < store.items.length; k++) had[store.items[k].id] = true;
    var fresh = 0;
    for (k = 0; k < list.length; k++) if (!had[list[k].id] && !list[k].done) fresh += 1;
    store.items = list;
    purge();
    store.save();
    refreshQuiet();
    if (!first && fresh && C && typeof C.activity === 'function') {
      try { C.activity('todo'); } catch (e) { /* the rows just show */ }
    }
  }

  function addTyping() {
    var box = addBox();
    return !!box && document.activeElement === box;
  }

  // Like refresh, but never redraws the panel under someone typing in the add
  // box; that waits until the typing stops.
  function refreshQuiet() {
    if (!C) return;
    C.redrawTile();
    if (!C.isOpen()) return;
    if (addTyping()) { sync.redrawLater = true; return; }
    C.redrawPanel();
  }

  function subText() {
    if (!syncing()) return null;
    var n = waiting();
    if (n) return fill(STRINGS.subToSend, n);
    return liveStatus().state === 'live' ? STRINGS.subSynced : STRINGS.subSaved;
  }

  // The small line on the tile and in the panel head says where the list is.
  function updateSubs() {
    if (!C) return;
    var text = subText();
    if (text === null) return;
    if (typeof C.setTileSub === 'function') C.setTileSub(text);
    if (C.isOpen()) C.setSub(text);
  }

  function startSync() {
    var L = live();
    if (!L) return;
    loadOutbox();
    L.on('todo', function (data, rev) {
      try {
        if (!data || !isArray(data.items)) return;
        noteServer(rev, data.items);
        syncStep();
      } catch (e) { /* the next arrival tries again */ }
    });
  }

  function refresh() {
    if (!C) return;
    C.redrawTile();
    if (C.isOpen()) C.redrawPanel();
  }

  function warnText() {
    if (warn === 'nostore') return STRINGS.warnNoStore;
    if (warn === 'savefail') return STRINGS.warnSaveFail;
    if (warn === 'corrupt') return STRINGS.warnCorrupt;
    return '';
  }

  function openCount() {
    var n = 0;
    for (var i = 0; i < store.items.length; i++) if (!store.items[i].done) n++;
    return n;
  }

  // Items in a section as the panel shows them: open ones, plus ones ticked
  // while the panel is open (they stay in place until it closes).
  function inSection(section, panelView) {
    var out = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (it.section !== section) continue;
      if (!it.done || (panelView && ticked[it.id])) out.push(it);
    }
    return out;
  }

  function doneToday(panelView) {
    var out = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (it.done && !(panelView && ticked[it.id])) out.push(it);
    }
    return out;
  }

  function renderError(body, e, cls) {
    body.innerHTML = '';
    var box = el('div', 'todo-error ' + cls, '', body);
    el('div', 'todo-error-title', STRINGS.error, box);
    el('div', 'todo-error-detail', String((e && e.message) || e || ''), box);
  }

  /* ---------- home tile ---------- */

  // A one-row strip: the number of open Now items and the first of them,
  // or the one line that says why there are none.
  function drawStrip(body) {
    var wrap = el('div', 'todo-tile todo-strip', '', body);
    var nowItems = inSection('now', false);
    if (!store.items.length) {
      el('div', 'todo-strip-text', STRINGS.emptyTitle, wrap);
    } else if (nowItems.length) {
      el('span', 'todo-strip-num', String(nowItems.length), wrap);
      var first = nowItems[0];
      var late = first.due && first.due < today();
      el('div', 'todo-strip-text' + (late ? ' is-late' : ''), first.title, wrap);
    } else {
      el('div', 'todo-strip-text', STRINGS.allClear, wrap);
    }
  }

  function drawTile(body) {
    var size = C && C.size ? C.size() : null;
    if (size && size.tier === 'strip') return drawStrip(body);
    var wrap = el('div', 'todo-tile', '', body);
    var now = today();
    var nowItems = inSection('now', false);
    var nextN = inSection('next', false).length;
    var waitN = inSection('waiting', false).length;
    var doneN = doneToday(false).length;

    if (!store.items.length) {
      var empty = el('div', 'todo-tile-empty', '', wrap);
      el('div', 'todo-tile-empty-title', STRINGS.emptyTitle, empty);
      el('div', 'todo-tile-empty-hint', STRINGS.emptyHint, empty);
    } else {
      var hero = el('div', 'todo-hero', '', wrap);
      if (nowItems.length) {
        el('span', 'todo-hero-num', String(nowItems.length), hero);
        el('span', 'todo-hero-cap', nowItems.length === 1 ? STRINGS.heroOne : STRINGS.heroMany, hero);
      } else {
        hero.className += ' is-clear';
        el('span', 'todo-hero-clear', STRINGS.allClear, hero);
      }
      var parts = [];
      if (nextN) parts.push(fill(STRINGS.metaNext, nextN));
      if (waitN) parts.push(fill(STRINGS.metaWaiting, waitN));
      if (doneN) parts.push(fill(STRINGS.metaDone, doneN));
      if (parts.length) el('div', 'todo-meta', parts.join(STRINGS.metaSep), wrap);

      if (nowItems.length) {
        var list = el('div', 'todo-tile-list', '', wrap);
        var more = el('div', 'todo-more', '', wrap);
        fitRows(list, more, nowItems, now);
      }
    }

    var w = warnText();
    if (w) el('div', 'todo-warn todo-tile-warn', w, wrap);
  }

  function tileRow(item, now) {
    var row = el('div', 'todo-tile-row');
    row.setAttribute('data-id', String(item.id));
    el('span', 'todo-tick', '', row);
    var text = el('div', 'todo-tile-text', '', row);
    el('div', 'todo-tile-title', item.title, text);
    if (item.notes) el('div', 'todo-tile-notes', item.notes, text);
    if (item.due && item.due < now) el('div', 'todo-flag', STRINGS.overdue, text);
    return row;
  }

  // Adds rows while they fit, then "+N more" for the rest. Measured, so a
  // bigger TV font or a long title just shows fewer rows.
  function fitRows(list, more, items, now) {
    var shown = Math.min(items.length, TILE_ROWS);
    var i;
    for (i = 0; i < shown; i++) list.appendChild(tileRow(items[i], now));
    function overflows() { return list.scrollHeight > list.clientHeight + 1; }
    function setMore() {
      var rest = items.length - shown;
      more.textContent = rest > 0 ? fill(STRINGS.more, rest) : '';
      more.style.display = rest > 0 ? '' : 'none';
    }
    setMore();
    while (shown > 0 && overflows()) {
      list.removeChild(list.lastChild);
      shown -= 1;
      setMore();
    }
    // No row fits (a small tile): the count above already says it all.
    if (!shown) {
      list.style.display = 'none';
      more.style.display = 'none';
    }
  }

  /* ---------- panel ---------- */

  function drawPanel(body) {
    panelBody = body;
    activeRow = null;
    armed = null;
    var now = today();
    var wrap = el('div', 'todo-panel', '', body);
    var cols = el('div', 'todo-cols', '', wrap);
    var main = el('div', 'todo-col todo-col-main', '', cols);
    var side = el('div', 'todo-col todo-col-side', '', cols);

    drawAddRow(main);
    var w = warnText();
    if (w) el('div', 'todo-warn todo-panel-warn', w, main);

    var nowItems = inSection('now', true);
    var focusFirst = null;
    for (var i = 0; i < nowItems.length; i++) {
      if (!nowItems[i].done) { focusFirst = nowItems[i].id; break; }
    }
    drawSection(main, 'now', nowItems, now, STRINGS.emptyNow, focusFirst);
    // In full screen this invisible copy of the add row's box pushes the
    // right column down by exactly the add row's height, so it starts level
    // with Now. Hidden in panel mode.
    var spacer = el('div', 'todo-add todo-add-spacer', '', side);
    spacer.setAttribute('aria-hidden', 'true');
    el('span', 'todo-input todo-spacer-box', ' ', spacer);
    drawSection(side, 'next', inSection('next', true), now, STRINGS.emptySection, null);
    drawSection(side, 'waiting', inSection('waiting', true), now, STRINGS.emptySection, null);
    var done = doneToday(true);
    if (done.length) drawSection(side, 'done', done, now, '', null);
    if (!focusFirst) body.querySelector('input.todo-input').setAttribute('data-autofocus', '');
    flash = null;
  }

  // The input is the focusable; the frame after it draws the box, so CSS can
  // style the whole row from the input's state with sibling selectors. Typed
  // text never runs under the hint: they are side by side.
  function drawAddRow(parent) {
    var row = el('div', 'todo-add', '', parent);
    var plus = el('span', 'todo-add-icon', '', row);
    plus.innerHTML = ICON_PLUS;
    var input = el('input', 'f todo-input', '', row);
    input.setAttribute('type', 'text');
    input.setAttribute('data-key', 'add');
    input.setAttribute('maxlength', String(MAX_TITLE));
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'sentences');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('placeholder', STRINGS.addPlaceholder);
    // A list that arrived while typing is drawn once the typing stops.
    input.addEventListener('blur', function () {
      if (!sync.redrawLater) return;
      sync.redrawLater = false;
      setTimeout(function () {
        try { if (C && C.isOpen() && !addTyping()) C.redrawPanel(); } catch (e) { /* ignore */ }
      }, 0);
    }, false);
    var hint = el('span', 'todo-add-hint', '', row);
    el('span', 'todo-hint-ok', STRINGS.hintOk, hint);
    el('span', 'todo-hint-typing', STRINGS.hintTyping, hint);
    el('span', 'todo-add-frame', '', row);
  }

  function drawSection(parent, key, items, now, emptyText, autofocusId) {
    var openN = 0;
    for (var i = 0; i < items.length; i++) if (!items[i].done || key === 'done') openN++;
    var sec = el('div', 'todo-sec todo-sec-' + key + (items.length || key === 'now' ? '' : ' is-empty'), '', parent);
    var label = el('div', 'todo-sec-label', '', sec);
    el('span', 'todo-sec-name', STRINGS.sections[key], label);
    el('span', 'todo-sec-count', String(openN), label);
    if (!items.length) {
      el('div', 'todo-sec-empty', emptyText, sec);
      return;
    }
    for (var j = 0; j < items.length; j++) sec.appendChild(panelRow(items[j], now, items[j].id === autofocusId));
  }

  // A round icon button. Its label shows as a pill, growing leftward from
  // the button, only while it has focus. armedLabel: Remove's second label.
  function actButton(parent, cls, key, icon, label, armedLabel, focusable) {
    var btn = el('div', 'todo-act ' + cls + (focusable ? ' f' : ''), '', parent);
    btn.setAttribute('data-key', key);
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', label);
    var pill = el('span', 'todo-pill', '', btn);
    el('span', 'todo-pill-label', label, pill);
    if (armedLabel) el('span', 'todo-pill-armed', armedLabel, pill);
    var ic = el('span', 'todo-act-icon', '', btn);
    ic.innerHTML = icon;
    return btn;
  }

  function panelRow(item, now, autofocus) {
    var active = item.id === activeId;
    var row = el('div', 'todo-row' + (item.done ? ' is-done' : '') + (item.id === flash ? ' is-flash' : '') +
      (active ? ' is-active' : ''));
    if (active) activeRow = row;
    var main = el('div', 'todo-main f', '', row);
    main.setAttribute('data-key', 'item:' + item.id);
    if (autofocus) main.setAttribute('data-autofocus', '');
    var tick = el('span', 'todo-tick', '', main);
    tick.innerHTML = ICON_TICK;
    var text = el('span', 'todo-text', '', main);
    el('span', 'todo-title', item.title, text);
    if (item.notes) el('span', 'todo-notes', item.notes, text);
    var due = item.done ? '' : dueText(item.due, now);
    if (due) el('span', 'todo-due' + (item.due < now ? ' is-overdue' : ''), due, text);

    // Every row keeps room for two round buttons; a done row has only the
    // bin, with an empty slot where Move would be. Only the active row's
    // buttons are focusable (class f); arrows skip the rest.
    var acts = el('div', 'todo-acts', '', row);
    if (item.done) el('span', 'todo-act-slot', '', acts);
    else actButton(acts, 'todo-move', 'move:' + item.id, ICON_MOVE, STRINGS.moveTo[NEXT_SECTION[item.section]], '', active);
    actButton(acts, 'todo-del', 'del:' + item.id, ICON_BIN, STRINGS.remove, STRINGS.removeArmed, active);
    return row;
  }

  // Shows a row's buttons and makes them focusable, or hides them again.
  function setActive(row, on) {
    if (on) row.classList.add('is-active'); else row.classList.remove('is-active');
    var acts = row.querySelectorAll('.todo-act');
    for (var i = 0; i < acts.length; i++) {
      if (on) acts[i].classList.add('f'); else acts[i].classList.remove('f');
    }
  }

  /* ---------- arrows (onMove) ---------- */

  function addBox() { return panelBody ? panelBody.querySelector('input.todo-input') : null; }

  function mainsIn(col) {
    var list = col ? col.querySelectorAll('.todo-main') : [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function middle(node) {
    var r = node.getBoundingClientRect();
    return r.top + r.height / 2;
  }

  // The main in list whose vertical centre is nearest y, or null.
  function nearest(list, y) {
    var best = null;
    var bestGap = Infinity;
    for (var i = 0; i < list.length; i++) {
      var gap = Math.abs(middle(list[i]) - y);
      if (gap < bestGap) { bestGap = gap; best = list[i]; }
    }
    return best;
  }

  // The steered moves. Anything not listed returns nothing, so the hub moves
  // by position.
  function onMove(dir, from, ctx) {
    if (!panelBody || !from) return undefined;
    var full = ctx.mode() === 'full';
    // The head's Full screen button: Down goes to the add box in panel mode.
    if (!panelBody.contains(from)) return dir === 'down' && !full ? addBox() || undefined : undefined;

    var mainCol = panelBody.querySelector('.todo-col-main');
    var sideCol = panelBody.querySelector('.todo-col-side');
    var row = closest(from, 'todo-row');
    var col = closest(from, 'todo-col');

    // Up and Down from a row's button go to the row above or below, in the
    // same column (in panel mode the columns are one list).
    if (row && hasCls(from, 'todo-act') && (dir === 'up' || dir === 'down')) {
      var mains = mainsIn(full ? col : panelBody);
      var at = mains.indexOf(row.querySelector('.todo-main'));
      if (dir === 'up') {
        if (at > 0) return mains[at - 1];
        return !full || col === mainCol ? addBox() || undefined : undefined;
      }
      return at >= 0 && at < mains.length - 1 ? mains[at + 1] : true;
    }

    if (!full) return undefined;
    // Full screen: crossing between the columns, to the level row.
    if (dir === 'right' && col === mainCol) {
      var acts = row ? row.querySelectorAll('.todo-act') : [];
      if (from === addBox() || (acts.length && from === acts[acts.length - 1])) {
        return nearest(mainsIn(sideCol), middle(from)) || true;
      }
    }
    if (dir === 'left' && col === sideCol && hasCls(from, 'todo-main')) {
      return nearest(mainsIn(mainCol), middle(from)) || addBox() || undefined;
    }
    return undefined;
  }

  function hasCls(node, cls) { return node.nodeType === 1 && node.classList.contains(cls); }

  function disarm() {
    if (armed) {
      armed.classList.remove('is-armed');
      armed.setAttribute('aria-label', STRINGS.remove);
    }
    armed = null;
  }

  function idOf(key, prefix) { return key.indexOf(prefix) === 0 ? key.substring(prefix.length) : null; }

  // Where focus goes once a row is removed: the row that takes its place,
  // else the one before it, else the add box.
  function focusAfterRemove(id) {
    var mains = panelBody ? panelBody.querySelectorAll('.todo-main') : [];
    var keys = [];
    var at = -1;
    for (var i = 0; i < mains.length; i++) {
      var k = mains[i].getAttribute('data-key');
      if (k === 'item:' + id) at = keys.length;
      else keys.push(k);
    }
    if (at < 0) return 'add';
    if (at < keys.length) return keys[at];
    if (at > 0) return keys[at - 1];
    return 'add';
  }

  function byKey(key) {
    if (!panelBody) return null;
    var list = panelBody.querySelectorAll('.f');
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-key') === key) return list[i];
    return null;
  }

  function onSelect(target, ctx) {
    var key = target.getAttribute('data-key') || '';
    var id = idOf(key, 'item:');
    var item;
    if (id !== null) {
      item = store.find(id);
      if (!item) return;
      if (item.done && openCount() >= MAX_OPEN) { ctx.toast(STRINGS.listFull, 4500); return; }
      store.toggle(item);
      if (item.done) { ticked[id] = true; flash = id; } else delete ticked[id];
      store.save();
      queue({ op: 'set', id: id, fields: { done: item.done, doneAt: item.doneAt } });
      refresh();
      return;
    }
    id = idOf(key, 'move:');
    if (id !== null) {
      item = store.find(id);
      if (!item || item.done) return;
      store.move(item);
      store.save();
      queue({ op: 'set', id: id, fields: { section: item.section }, to: 'end' });
      refresh();
      return;
    }
    id = idOf(key, 'del:');
    if (id !== null) {
      if (armed !== target) {
        disarm();
        armedAt = new Date().getTime();
        armed = target;
        target.classList.add('is-armed');
        target.setAttribute('aria-label', STRINGS.removeArmed);
        return;
      }
      // A held OK repeats; the second press has to be a new one.
      if (new Date().getTime() - armedAt < 400) return;
      item = store.find(id);
      armed = null;
      if (!item) return;
      var nextKey = focusAfterRemove(id);
      store.remove(item);
      delete ticked[id];
      store.save();
      queue({ op: 'remove', id: id });
      ctx.redrawTile();
      ctx.redrawPanel();
      var node = byKey(nextKey) || byKey('add');
      if (node) ctx.focus(node);
    }
  }

  function onSubmit(target, ctx) {
    if (target.getAttribute('data-key') !== 'add') return;
    var title = tidy(target.value).substring(0, MAX_TITLE);
    if (!title) { target.value = ''; return; }
    if (openCount() >= MAX_OPEN) { ctx.toast(STRINGS.listFull, 4500); return; }
    var item = store.add(title);
    flash = item.id;
    target.value = '';
    store.save();
    queue({ op: 'add', item: item, at: 'top' });
    refresh();
  }

  /* ---------- widget ---------- */

  return {
    id: 'todo',
    title: 'To-do',
    icon: 'check-list',
    sub: STRINGS.sub,
    expandable: true,
    stagger: '.todo-col-main > .todo-add, .todo-sec',   // the parts arrive one by one as the panel opens

    init: function (ctx) {
      C = ctx;
      store.load();
      try { startSync(); } catch (e) { /* works as a list on this TV */ }
      lastDay = today();
      if (purge()) store.save();
      setInterval(function () {
        try { checkDay(); } catch (e) { /* try again next minute */ }
      }, 60000);
    },

    renderTile: function (body, ctx) {
      C = ctx;
      try {
        drawTile(body);
      } catch (e) {
        renderError(body, e, 'todo-tile-error');
      }
      try { updateSubs(); } catch (e2) { /* keep the line as it is */ }
    },

    renderPanel: function (body) {
      try {
        drawPanel(body);
      } catch (e) {
        panelBody = null;
        renderError(body, e, 'todo-panel-error');
      }
      try { updateSubs(); } catch (e2) { /* keep the line as it is */ }
    },

    // Live updates changed state: send what waits, or take the server's list.
    onStatus: function () {
      try { syncStep(); } catch (e) { /* the next change tries again */ }
    },

    onFocus: function (target) {
      if (armed && armed !== target) disarm();
      var row = closest(target, 'todo-row');
      if (row === activeRow) return;
      if (activeRow) setActive(activeRow, false);
      activeRow = row;
      activeId = null;
      if (row) {
        setActive(row, true);
        activeId = idOf(row.querySelector('.todo-main').getAttribute('data-key'), 'item:');
      }
    },

    onMove: onMove,
    onSelect: onSelect,
    onSubmit: onSubmit,

    onBack: function () {
      if (!armed) return false;
      disarm();
      return true;
    },

    // Items ticked this time move to Done today when the panel next opens.
    onClose: function () {
      ticked = {};
      armed = null;
      activeRow = null;
      activeId = null;
      panelBody = null;
      flash = null;
      sync.redrawLater = false;
    },

    // How many items are done (ticked here or arriving from the Pi), for
    // app/clay.js to notice one more. Read-only.
    doneCount: function () {
      var n = 0;
      for (var i = 0; i < store.items.length; i++) if (store.items[i].done) n++;
      return n;
    }
  };
})());
