/*
 * To-do: a list kept on this TV (localStorage). Add, tick off, change an
 * item's level and remove, with only the remote. Typing works with the TV's
 * on-screen keyboard or a USB or Bluetooth keyboard.
 *
 * Saved as homeHub.todo.v1 = { v: 1, items: [item] }, where an item is
 * { id, title, level: 'must' | 'optional' | 'passive' (optional; missing
 * means optional), section: 'now' | 'next' | 'waiting' (kept for older Pi
 * servers, no longer shown), done, doneAt, createdAt, due: 'YYYY-MM-DD'
 * (optional), notes: 'plain text' (optional, at most 300 characters),
 * lead: 0 to 30 (optional; a passive item's "Coming up" lead in days) }.
 * Fields this file doesn't know are kept as they are.
 *
 * Levels: "Must today" (red, with a MUST pill), "If you can" (yellow) and
 * passive ones, which have no tick box: they show as a dimmed "Coming up"
 * footnote, only from their lead (COMING_UP_DAYS, 2, unless the item says
 * otherwise; 0 means only on the day) before their due date (always when
 * they have none). A line says when: Today, Tomorrow, or the day and how far
 * off it is ("Thu · in 3 days"). While a must-do due today (or earlier, or with no date) is
 * open, a red strip at the top of the tile and the panel says so; from 5 PM
 * it pulses slowly, a little stronger each hour until midnight, and at full
 * strength once the must-do is late. Only opacity animates.
 *
 * Completed: a ticked item stays on the list until midnight, then purge()
 * removes it (checked every minute). The panel lists them in "Completed".
 * The home tile shows a small "Completed" section (the newest 2, then
 * "+N more") between the open rows and "Coming up", only if the open rows
 * keep every row they would have had without it and the tile does not
 * overflow; then the "{n} done today" line is left out, as it would say the
 * same. Without room the newest one takes that line's place (check, struck
 * title, "+N more"), then just "{n} done today", then nothing at all;
 * completed items are always the first thing to give way. On a strip the
 * tile is as it was.
 *
 * A Pi server older than 0.6.0 can't take a level through ./hub or the
 * mailbox, so a level may also come as a tag in the notes: "[level:must]",
 * "[level:passive]" (a "level" field always wins). The lead likewise:
 * "[lead:3]" in the notes, for a Pi server older than 0.7.0 (a "lead" field
 * always wins). Tags in square brackets that start with "level:", "lead:" or
 * "cal:" (the calendar converter's own marks) are never shown, in notes or
 * in titles.
 *
 * The calendar converter keeps its prefix in the title: "TODO!:" (must),
 * "TODO:" (optional), "TODO~:" (passive), as in "TODO!: Take weekly shot".
 * The saved title keeps it; the TV never shows it (shownTitle), and an item
 * without a "level" field takes its level from it (before any notes tag).
 *
 * Notes come only from the Pi (./hub todo add --notes, the mailbox's
 * todo.add and todo.notes); the TV shows them under the title, quietly, and
 * shows nothing at all for an item without notes. The TV never edits them,
 * and every change it sends keeps them.
 *
 * Every word is in EN. window.HUB_TODO_STRINGS, when set before this file
 * loads, replaces any of them key by key (the screenshots use it); the hub's
 * language (app/i18n.js, keys 'todo.*') then turns them into Spanish.
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
     number, {d} a date, {t} a title. */
  var EN = {
    title: 'To-do',
    sub: 'On this TV',
    subSynced: 'In sync',
    subToSend: 'Saved here, {n} to send',
    subSaved: 'Saved here',
    heroOne: 'to do now',
    heroMany: 'to do now',
    allClear: 'All clear for now',
    metaDone: '{n} done today',
    yesterday: 'Yesterday',
    metaSep: ' · ',
    emptyTitle: 'Nothing on the list yet.',
    emptyHint: 'Press OK to add something.',
    more: '+{n} more',
    overdue: 'Overdue',
    dueToday: 'Due today',
    dueOn: 'Due {d}',
    today: 'Today',
    tomorrow: 'Tomorrow',
    dateShort: '{mon} {d}',
    inDays: 'in {n} days',
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    sections: { must: 'Must today', optional: 'If you can', done: 'Completed' },
    comingUp: 'Coming up',
    mustPill: 'MUST',
    alertOne: '{n} must-do today: {t}',
    alertMany: '{n} must-dos today: {t}',
    moveTo: { must: 'To Must today', optional: 'To If you can', passive: 'To Coming up' },
    remove: 'Remove',
    removeArmed: 'Confirm',
    addPlaceholder: 'Add an item',
    hintOk: 'OK to type',
    hintTyping: 'Done or Enter adds it',
    emptyMust: 'Nothing you must do today.',
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
  try { mergeStrings(EN, window.HUB_TODO_STRINGS); } catch (e) { /* keep English */ }

  // The words in the hub's language; set again when the language changes.
  var STRINGS = EN;
  function localizeStrings() {
    var x = window.HUB_I18N;
    try { STRINGS = x && typeof x.localize === 'function' ? x.localize(EN, 'todo') : EN; } catch (e) { STRINGS = EN; }
  }
  localizeStrings();

  var STORE_KEY = 'homeHub.todo.v1';
  var BAD_KEY = 'homeHub.todo.v1.bad';
  var MAX_TITLE = 80;
  var MAX_NOTES = 300;
  var MAX_OPEN = 60;
  var TILE_ROWS = 8;
  var TILE_FOOT = 2;          // "Coming up" lines on the home tile
  var TILE_DONE = 2;          // "Completed" lines on the home tile
  var SECTIONS = ['now', 'next', 'waiting'];
  var LEVELS = ['must', 'optional', 'passive'];
  var NEXT_LEVEL = { must: 'optional', optional: 'passive', passive: 'must' };
  // A passive item shows from this many days before its due date, unless
  // its own lead (0 to MAX_LEAD) says otherwise.
  var COMING_UP_DAYS = 2;
  var MAX_LEAD = 30;
  // The must-do strip pulses from 5 PM, from a faint swing to a stronger one
  // at midnight, and at the strongest once a must-do is late.
  var PULSE_FROM_HOUR = 17;
  var PULSE_MIN = 0.15;
  var PULSE_MAX = 0.55;
  var TAG_LEVEL = /\[level:(must|optional|passive)\]/;
  var TAG_LEAD = /\[lead:(\d{1,2})\]/;
  var TAGS = /\s*\[(?:level|lead|cal):[^\]]*\]/g;
  // A leading "TODO!:", "TODO:" or "TODO~:" (any case, spaces after the colon).
  var PREFIX = /^\s*todo([!~]?):\s*/i;
  var PREFIX_LEVEL = { '!': 'must', '': 'optional', '~': 'passive' };

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

  function shortDate(day) {
    var month = STRINGS.monthsShort[parseInt(day.substring(5, 7), 10) - 1] || '';
    return STRINGS.dateShort.replace('{mon}', month).replace('{d}', String(parseInt(day.substring(8, 10), 10)));
  }

  // '' when the item has no due date.
  function dueText(due, now) {
    if (!due) return '';
    if (due < now) return STRINGS.overdue;
    if (due === now) return STRINGS.dueToday;
    return fill(STRINGS.dueOn, shortDate(due));
  }

  // When a passive item is: Today, Tomorrow, "Thu · in 3 days" within the
  // week, "Dec 12 · in 25 days" further off (or Overdue).
  function whenText(due, now) {
    if (!due) return '';
    if (due < now) return STRINGS.overdue;
    var n = daysBetween(now, due);
    if (n === 0) return STRINGS.today;
    if (n === 1) return STRINGS.tomorrow;
    var label = n < 7 ? (STRINGS.daysShort[dateOf(due).getDay()] || shortDate(due)) : shortDate(due);
    return label + STRINGS.metaSep + fill(STRINGS.inDays, n);
  }

  function dateOf(day) {
    return new Date(parseInt(day.substring(0, 4), 10), parseInt(day.substring(5, 7), 10) - 1, parseInt(day.substring(8, 10), 10));
  }

  // Whole days from one 'YYYY-MM-DD' to another (by the calendar, so a
  // daylight saving change in between does not matter).
  function daysBetween(from, to) {
    var a = Date.UTC(parseInt(from.substring(0, 4), 10), parseInt(from.substring(5, 7), 10) - 1, parseInt(from.substring(8, 10), 10));
    var b = Date.UTC(parseInt(to.substring(0, 4), 10), parseInt(to.substring(5, 7), 10) - 1, parseInt(to.substring(8, 10), 10));
    return Math.round((b - a) / 86400000);
  }

  // 'YYYY-MM-DD' n days after day, in local time.
  function addDays(day, n) {
    var d = new Date(parseInt(day.substring(0, 4), 10), parseInt(day.substring(5, 7), 10) - 1, parseInt(day.substring(8, 10), 10) + n);
    return dayOf(d);
  }

  // An item's level: its level field, else the calendar prefix of its
  // title, else a "[level:...]" tag in its notes (from a Pi too old to take
  // the field), else optional.
  function levelOf(item) {
    if (LEVELS.indexOf(item.level) >= 0) return item.level;
    var p = typeof item.title === 'string' ? PREFIX.exec(item.title) : null;
    if (p) return PREFIX_LEVEL[p[1]];
    var m = typeof item.notes === 'string' ? TAG_LEVEL.exec(item.notes) : null;
    return m ? m[1] : 'optional';
  }

  function isLead(n) { return typeof n === 'number' && n >= 0 && n <= MAX_LEAD && Math.floor(n) === n; }

  // How many days before its due date a passive item shows: its lead
  // field, else a "[lead:3]" tag in its notes, else COMING_UP_DAYS.
  function leadOf(item) {
    if (isLead(item.lead)) return item.lead;
    var m = typeof item.notes === 'string' ? TAG_LEAD.exec(item.notes) : null;
    var n = m ? parseInt(m[1], 10) : -1;
    return isLead(n) ? n : COMING_UP_DAYS;
  }

  // Owner-typed text in the hub's language (display only; app/i18n-dyn.js).
  function dyn(s) { return (window.HUB_I18N && window.HUB_I18N.dyn) ? window.HUB_I18N.dyn(s) : s; }

  // The title as shown: without a leading calendar prefix (the saved title
  // keeps it). A title that is only a prefix shows as it is.
  function shownTitle(item) {
    var title = typeof item.title === 'string' ? item.title : '';
    var rest = tidy(title.replace(PREFIX, '').replace(TAGS, ' '));
    return dyn(rest || title);
  }

  // Notes as shown: without the machine tags.
  function shownNotes(item) {
    return typeof item.notes === 'string' ? dyn(tidy(item.notes.replace(TAGS, ' '))) : '';
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

    // New items go to the top, as "If you can".
    add: function (title) {
      var item = { id: newId(), title: title, level: 'optional', section: 'now', done: false, doneAt: null, createdAt: new Date().getTime() };
      store.items.unshift(item);
      return item;
    },

    toggle: function (item) {
      item.done = !item.done;
      item.doneAt = item.done ? new Date().getTime() : null;
    },

    // Moves to the end of the next level in the cycle: must, optional, passive.
    move: function (item) {
      var i = store.items.indexOf(item);
      if (i < 0) return;
      store.items.splice(i, 1);
      item.level = NEXT_LEVEL[levelOf(item)];
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
      // A level this file doesn't know goes; no level means optional.
      if (it.level !== undefined && LEVELS.indexOf(it.level) < 0) delete it.level;
      // A lead that is not a whole number of days from 0 to MAX_LEAD goes.
      if (it.lead !== undefined && !isLead(it.lead)) delete it.lead;
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

  // Done items last until midnight: one ticked on an earlier day goes.
  // Returns true if any went; each one that went is also queued for the Pi.
  function purge() {
    var d = new Date();
    var cut = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var kept = [];
    var gone = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (it.done && !(new Date(it.doneAt).getTime() >= cut)) { gone.push(it.id); delete ticked[it.id]; continue; }
      kept.push(it);
    }
    store.items = kept;
    for (var j = 0; j < gone.length; j++) queue({ op: 'remove', id: gone[j] });
    return gone.length > 0;
  }

  // The hub stays open for days, so once a minute: clear what was done
  // before today, and draw again if something went or the day changed (a
  // "Yesterday" label appears at midnight).
  function checkDay() {
    var now = today();
    var gone = purge();
    if (gone) store.save();
    if (!gone && now === lastDay) return;
    lastDay = now;
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

  // The fields of an item that its row shows (not done: a tick is not news).
  var SHOWN = ['title', 'notes', 'due', 'section'];

  function shownChanged(a, b) {
    for (var i = 0; i < SHOWN.length; i++) if (a[SHOWN[i]] !== b[SHOWN[i]]) return true;
    return false;
  }

  // Takes the server's list as the working copy. Open items it has that
  // were nowhere here before, or whose shown words (title, notes, due date,
  // section) differ from the copy here, are news from a sync: after the
  // first list this run (never on it) the tile says so (ctx.activity). A
  // done flag alone is not news, and changes made on this TV are already in
  // the copy here (the server's list is only taken once they are sent), so
  // they never count. The rows just appear.
  function adopt(items) {
    if (!isArray(items)) return;
    var list = clean(copy(items));
    var first = !sync.adopted;
    sync.adopted = true;
    if (JSON.stringify(list) === JSON.stringify(store.items)) return;
    var had = {};
    var k;
    for (k = 0; k < store.items.length; k++) had[store.items[k].id] = store.items[k];
    var fresh = 0;
    for (k = 0; k < list.length; k++) {
      if (list[k].done) continue;
      if (!had.hasOwnProperty(list[k].id) || shownChanged(had[list[k].id], list[k])) fresh += 1;
    }
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
    // Not syncing: "On this TV" in the hub's language, unless config.js says otherwise.
    if (!syncing()) return C && C.config && C.config.sub && C.config.sub !== EN.sub ? null : STRINGS.sub;
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

  // Items of a level as the panel shows them: open ones, plus ones ticked
  // while the panel is open (they stay in place until it closes).
  function inLevel(level, panelView) {
    var out = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (levelOf(it) !== level) continue;
      if (!it.done || (panelView && ticked[it.id])) out.push(it);
    }
    return out;
  }

  // Passive items for the "Coming up" footnote: no due date, or due within
  // the item's lead (and late ones, until they are cleared).
  function comingUp(panelView) {
    var now = today();
    var list = inLevel('passive', panelView);
    var out = [];
    for (var i = 0; i < list.length; i++) if (!list[i].due || list[i].due <= addDays(now, leadOf(list[i]))) out.push(list[i]);
    return out;
  }

  // Done items still kept (see purge); on the tile, the newest first.
  function doneToday(panelView) {
    var out = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (it.done && !(panelView && ticked[it.id])) out.push(it);
    }
    if (!panelView) {
      out.sort(function (a, b) { return (Number(b.doneAt) || 0) - (Number(a.doneAt) || 0); });
    }
    return out;
  }

  /* ---------- the must-do strip ---------- */

  // Open must-dos for today: due today or earlier, or with no date (a
  // must-do due later is in the list, but the strip waits for its day).
  function mustToday() {
    var now = today();
    var out = [];
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      if (it.done || levelOf(it) !== 'must') continue;
      if (!it.due || it.due <= now) out.push(it);
    }
    return out;
  }

  // A must-do is late once its day has gone by: its due date, or for one
  // without a date, the day it was made.
  function anyLate(list) {
    var now = today();
    for (var i = 0; i < list.length; i++) {
      var day = list[i].due || dayOf(new Date(list[i].createdAt));
      if (day < now) return true;
    }
    return false;
  }

  // How strongly the strip pulses now: 0 (still) before 5 PM, then from
  // PULSE_MIN to PULSE_MAX by midnight; PULSE_MAX when a must-do is late.
  function pulseLevel(list) {
    if (!list.length) return 0;
    if (anyLate(list)) return PULSE_MAX;
    var d = new Date();
    var mins = d.getHours() * 60 + d.getMinutes();
    var from = PULSE_FROM_HOUR * 60;
    if (mins < from) return 0;
    var t = (mins - from) / (24 * 60 - 1 - from);
    return Math.round((PULSE_MIN + (PULSE_MAX - PULSE_MIN) * Math.min(1, t)) * 100) / 100;
  }

  // The glow layer: its opacity is how strong the pulse is; its ::after
  // breathes (opacity only, CSS). Hidden while the strip is still.
  function setGlow(node, level) {
    if (!node) return;
    node.style.opacity = String(level);
    node.style.display = level > 0 ? '' : 'none';
  }

  // bare: just the count, as the rows below name each must-do.
  function drawAlert(parent, list, cls, bare) {
    var box = el('div', 'todo-alert ' + cls, '', parent);
    setGlow(el('span', 'todo-glow', '', box), pulseLevel(list));
    var tpl = list.length === 1 ? STRINGS.alertOne : STRINGS.alertMany;
    if (bare) tpl = tpl.replace(/\s*[:\uFF1A]\s*\{t\}\s*$/, '');
    var text = fill(tpl, list.length).replace('{t}', shownTitle(list[0]));
    var line = el('div', 'todo-alert-text', '', box);
    el('span', 'todo-alert-dot', '', line);
    line.appendChild(document.createTextNode(text));
    return box;
  }

  // The tile's red edge while a must-do is open (it pulses with the strip).
  function markTile(body, list) {
    var tile = body && body.parentNode;
    if (!tile || !tile.classList || !tile.classList.contains('tile')) return;
    var old = tile.querySelector('.todo-tile-glow');
    if (old) tile.removeChild(old);
    if (!list.length) return;
    var edge = el('span', 'todo-tile-glow', '', tile);
    edge.setAttribute('aria-hidden', 'true');
    setGlow(el('span', 'todo-glow', '', edge), pulseLevel(list));
  }

  // Once a minute: the pulse grows through the evening without a redraw.
  function updatePulse() {
    var level = pulseLevel(mustToday());
    var list = document.querySelectorAll('.todo-glow');
    for (var i = 0; i < list.length; i++) setGlow(list[i], level);
  }

  function renderError(body, e, cls) {
    body.innerHTML = '';
    var box = el('div', 'todo-error ' + cls, '', body);
    el('div', 'todo-error-title', STRINGS.error, box);
    el('div', 'todo-error-detail', String((e && e.message) || e || ''), box);
  }

  // The MUST pill after a title, so a must-do is not told by color alone.
  function mustPill(parent) {
    el('span', 'todo-must-pill', STRINGS.mustPill, parent);
  }

  /* ---------- home tile ---------- */

  // A one-row strip: the number of open must-dos for today and the first of
  // them (red), else the open items and the first of them, or the one line
  // that says why there are none.
  function drawStrip(body) {
    var wrap = el('div', 'todo-tile todo-strip', '', body);
    var must = mustToday();
    var open = inLevel('must', false).concat(inLevel('optional', false));
    if (must.length) {
      wrap.className += ' has-must';
      el('span', 'todo-strip-num', String(must.length), wrap);
      var late = anyLate(must);
      el('div', 'todo-strip-text is-must' + (late ? ' is-late' : ''), shownTitle(must[0]), wrap);
    } else if (!store.items.length) {
      el('div', 'todo-strip-text', STRINGS.emptyTitle, wrap);
    } else if (open.length) {
      el('span', 'todo-strip-num', String(open.length), wrap);
      var first = open[0];
      el('div', 'todo-strip-text' + (first.due && first.due < today() ? ' is-late' : ''), shownTitle(first), wrap);
    } else {
      el('div', 'todo-strip-text', STRINGS.allClear, wrap);
    }
  }

  function drawTile(body) {
    var size = C && C.size ? C.size() : null;
    var must = mustToday();
    markTile(body, must);
    if (size && size.tier === 'strip') return drawStrip(body);
    var doneList = doneToday(false);
    // The open rows come first, at any size. If the big count leaves no
    // room for all of them, drop it (and the title in the red strip, which
    // the rows repeat) whenever that shows more rows.
    // Still short of the must-dos: drop the red strip too, but only if then
    // every must-do has its row (the tile's red edge and each row's MUST
    // pill still say it).
    var lean = 0;
    var base = fillTile(body, must, doneList, 'none', 0).__fit;
    body.removeChild(body.lastChild);
    for (var k = 1; k <= 2 && base.shown < base.total; k++) {
      if (k === 2 && !(must.length && base.shown < must.length)) break;
      var bare = fillTile(body, must, doneList, 'none', k).__fit;
      body.removeChild(body.lastChild);
      if (bare.shown > base.shown && (k === 1 || bare.shown >= must.length)) { lean = k; base = bare; }
    }
    // Completed is the first thing to give way: the fullest form that keeps
    // every open row and stays inside the tile, else nothing about it (the
    // panel still lists them).
    if (doneList.length && store.items.length) {
      var modes = ['full', 'line', 'meta'];
      for (var i = 0; i < modes.length; i++) {
        var f = fillTile(body, must, doneList, modes[i], lean).__fit;
        if (f.shown >= base.shown && !f.over) return;
        body.removeChild(body.lastChild);
      }
    }
    fillTile(body, must, doneList, 'none', lean);
  }

  // The tile's content; wrap.__fit says how many open rows fit and whether
  // the tile overflows. mode: 'meta' (the "{n} done today" line), 'line'
  // (the newest completed item on that line), 'full' (the Completed section)
  // or 'none' (no word of the completed items). lean, to give the rows room:
  // 1 = no big count and the red strip without the first must-do's title,
  // 2 = no big count and no red strip.
  function fillTile(body, must, doneList, mode, lean) {
    var wrap = el('div', 'todo-tile', '', body);
    var now = today();
    var open = inLevel('must', false).concat(inLevel('optional', false));
    var coming = comingUp(false);
    var shown = 0;

    if (must.length && lean < 2) drawAlert(wrap, must, 'todo-tile-alert', lean === 1);
    if (!store.items.length) {
      var empty = el('div', 'todo-tile-empty', '', wrap);
      el('div', 'todo-tile-empty-title', STRINGS.emptyTitle, empty);
      el('div', 'todo-tile-empty-hint', STRINGS.emptyHint, empty);
    } else {
      // With the strip above, the number steps down so rows keep their room.
      var hero = el('div', 'todo-hero' + (must.length ? ' is-compact' : ''), '', wrap);
      if (lean) hero.style.display = 'none';
      if (open.length) {
        el('span', 'todo-hero-num', String(open.length), hero);
        el('span', 'todo-hero-cap', open.length === 1 ? STRINGS.heroOne : STRINGS.heroMany, hero);
      } else {
        hero.className += ' is-clear';
        el('span', 'todo-hero-clear', STRINGS.allClear, hero);
      }
      var parts = [];
      if (doneList.length && mode === 'line') drawDoneLine(wrap, doneList);
      else if (doneList.length && mode === 'meta') parts.push(fill(STRINGS.metaDone, doneList.length));
      if (parts.length) el('div', 'todo-meta', parts.join(STRINGS.metaSep), wrap);

      var list = open.length ? el('div', 'todo-tile-list', '', wrap) : null;
      var more = open.length ? el('div', 'todo-more', '', wrap) : null;
      // The sections under the rows first, so the rows are fitted to the
      // room they leave.
      if (mode === 'full') drawDoneFoot(wrap, doneList);
      if (coming.length) drawFoot(wrap, coming, now, false);
      if (list) shown = fitRows(list, more, open, now);
    }

    var w = warnText();
    if (w) el('div', 'todo-warn todo-tile-warn', w, wrap);
    var over = wrap.scrollHeight > wrap.clientHeight + 1;
    if (!over) over = pastTile(wrap);
    wrap.__fit = { shown: shown, over: over, total: open.length };
    return wrap;
  }

  // Tablet mode (Chrome 52): the tile's flex box can grow with its content
  // instead of holding it, so scrollHeight never says it overflows and the
  // Completed section ran past the tile's bottom. Measure against the tile.
  function pastTile(wrap) {
    var tile = wrap.parentNode && wrap.parentNode.parentNode;
    var last = wrap.lastChild;
    if (!tile || !last || !tile.getBoundingClientRect) return false;
    var cs = window.getComputedStyle(tile);
    var limit = tile.getBoundingClientRect().bottom - (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.borderBottomWidth) || 0);
    return last.getBoundingClientRect().bottom > limit + 1;
  }

  // The compact Completed: on the meta line's row, a small green check, the
  // newest done title struck through in gray, and "+N more" at the right.
  function drawDoneLine(parent, items) {
    var line = el('div', 'todo-meta todo-meta-done', '', parent);
    var tick = el('span', 'todo-tick', '', line);
    tick.innerHTML = ICON_TICK;
    el('span', 'todo-done-title', shownTitle(items[0]), line);
    if (items.length > 1) el('span', 'todo-meta-more', fill(STRINGS.more, items.length - 1), line);
    return line;
  }

  // "Completed" on the tile: the newest done items, one line each (a green
  // check, the title struck through in gray), "+N more" beside the label.
  function drawDoneFoot(parent, items) {
    var sec = el('div', 'todo-foot todo-tile-done', '', parent);
    var head = el('div', 'todo-done-head', '', sec);
    el('div', 'todo-foot-label', STRINGS.sections.done, head);
    var n = Math.min(items.length, TILE_DONE);
    // "+N more" shares the label's line, to spare the tile a row.
    if (n < items.length) el('div', 'todo-foot-more', fill(STRINGS.more, items.length - n), head);
    for (var i = 0; i < n; i++) {
      var line = el('div', 'todo-done-line', '', sec);
      line.setAttribute('data-id', String(items[i].id));
      var tick = el('span', 'todo-tick', '', line);
      tick.innerHTML = ICON_TICK;
      el('span', 'todo-done-title', shownTitle(items[i]), line);
    }
    return sec;
  }

  function tileRow(item, now) {
    var level = levelOf(item);
    var row = el('div', 'todo-tile-row lv-' + level);
    row.setAttribute('data-id', String(item.id));
    el('span', 'todo-lv', '', row);
    el('span', 'todo-tick', '', row);
    var text = el('div', 'todo-tile-text', '', row);
    var title = el('div', 'todo-tile-title', shownTitle(item), text);
    if (level === 'must') mustPill(title);
    var notes = shownNotes(item);
    if (notes) el('div', 'todo-tile-notes', notes, text);
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
    } else {
      // Where a character works when the list changes (app/agents.js): where
      // a new to-do shows, the first optional row (new items go to the top of
      // their level), else the first row.
      (list.querySelector('.lv-optional') || list.firstChild).setAttribute('data-agent-spot', '');
    }
    return shown;
  }

  // "Coming up": passive items, dimmed, one line each, with a small green
  // dot and no tick box. In the panel each line can take focus (OK clears
  // it, and it has Move and Remove like any row).
  function drawFoot(parent, items, now, panelView) {
    var foot = el('div', 'todo-foot' + (panelView ? ' todo-panel-foot' : ' todo-tile-foot'), '', parent);
    el('div', 'todo-foot-label', STRINGS.comingUp, foot);
    var n = panelView ? items.length : Math.min(items.length, TILE_FOOT);
    for (var i = 0; i < n; i++) {
      if (panelView) { foot.appendChild(panelRow(items[i], now, false)); continue; }
      var line = el('div', 'todo-foot-line', '', foot);
      line.setAttribute('data-id', String(items[i].id));
      el('span', 'todo-dot', '', line);
      el('span', 'todo-foot-title', shownTitle(items[i]), line);
      var when = whenText(items[i].due, now);
      if (when) el('span', 'todo-foot-when', '· ' + when, line);
    }
    if (n < items.length) el('div', 'todo-foot-more', fill(STRINGS.more, items.length - n), foot);
    return foot;
  }

  /* ---------- panel ---------- */

  function drawPanel(body) {
    panelBody = body;
    activeRow = null;
    armed = null;
    var now = today();
    var wrap = el('div', 'todo-panel', '', body);
    var must = mustToday();
    if (must.length) drawAlert(wrap, must, 'todo-panel-alert');
    var cols = el('div', 'todo-cols', '', wrap);
    var main = el('div', 'todo-col todo-col-main', '', cols);
    var side = el('div', 'todo-col todo-col-side', '', cols);

    drawAddRow(main);
    var w = warnText();
    if (w) el('div', 'todo-warn todo-panel-warn', w, main);

    var mustItems = inLevel('must', true);
    var optItems = inLevel('optional', true);
    var focusFirst = firstOpen(mustItems) || firstOpen(optItems);
    drawSection(main, 'must', mustItems, now, STRINGS.emptyMust, focusFirst);
    // In full screen this invisible copy of the add row's box pushes the
    // right column down by exactly the add row's height, so it starts level
    // with Must today. Hidden in panel mode.
    var spacer = el('div', 'todo-add todo-add-spacer', '', side);
    spacer.setAttribute('aria-hidden', 'true');
    el('span', 'todo-input todo-spacer-box', '\u00a0', spacer);
    drawSection(side, 'optional', optItems, now, mustItems.length ? STRINGS.emptySection : STRINGS.emptyNow, focusFirst);
    var done = doneToday(true);
    if (done.length) drawSection(side, 'done', done, now, '', null);
    var coming = comingUp(true);
    if (coming.length) drawFoot(wrap, coming, now, true);
    if (!focusFirst) body.querySelector('input.todo-input').setAttribute('data-autofocus', '');
    flash = null;
  }

  function firstOpen(items) {
    for (var i = 0; i < items.length; i++) if (!items[i].done) return items[i].id;
    return null;
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
    var sec = el('div', 'todo-sec todo-sec-' + key + (items.length || key === 'optional' ? '' : ' is-empty'), '', parent);
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

  // A row: the level's colored edge, the tick (a green dot for a passive
  // line, which has no tick box), the title (with the MUST pill for a
  // must-do), notes and the due date.
  function panelRow(item, now, autofocus) {
    var active = item.id === activeId;
    var level = levelOf(item);
    var passive = level === 'passive';
    var row = el('div', 'todo-row lv-' + level + (item.done ? ' is-done' : '') + (item.id === flash ? ' is-flash' : '') +
      (active ? ' is-active' : ''));
    if (active) activeRow = row;
    var main = el('div', 'todo-main f', '', row);
    main.setAttribute('data-key', 'item:' + item.id);
    if (autofocus) main.setAttribute('data-autofocus', '');
    el('span', 'todo-lv', '', main);
    if (passive && !item.done) {
      el('span', 'todo-dot', '', main);
    } else {
      var tick = el('span', 'todo-tick', '', main);
      tick.innerHTML = ICON_TICK;
    }
    var text = el('span', 'todo-text', '', main);
    var title = el('span', 'todo-title', shownTitle(item), text);
    if (level === 'must' && !item.done) mustPill(title);
    var notes = shownNotes(item);
    if (notes) el('span', 'todo-notes', notes, text);
    var due = item.done ? '' : (passive ? whenText(item.due, now) : dueText(item.due, now));
    if (due) el('span', 'todo-due' + (item.due < now ? ' is-overdue' : ''), due, text);
    // A done item kept past midnight says so, where an open one has its date.
    if (item.done && dayOf(new Date(item.doneAt)) < now) el('span', 'todo-due todo-yday', STRINGS.yesterday, text);

    // Every row keeps room for two round buttons; a done row has only the
    // bin, with an empty slot where Move would be. Only the active row's
    // buttons are focusable (class f); arrows skip the rest.
    var acts = el('div', 'todo-acts', '', row);
    if (item.done) el('span', 'todo-act-slot', '', acts);
    else actButton(acts, 'todo-move', 'move:' + item.id, ICON_MOVE, STRINGS.moveTo[NEXT_LEVEL[level]], '', active);
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
    // The "Coming up" footnote runs under both columns: in full screen,
    // Down from a column's last row goes there, and Up from its first line
    // goes back to the main column.
    var foot = panelBody.querySelector('.todo-panel-foot');
    var inFoot = !!foot && foot.contains(from);
    if (row && hasCls(from, 'todo-act') && (dir === 'up' || dir === 'down')) {
      var mains = mainsIn(full && col ? col : (full && inFoot ? foot : panelBody));
      var at = mains.indexOf(row.querySelector('.todo-main'));
      if (dir === 'up') {
        if (at > 0) return mains[at - 1];
        if (full && inFoot) return mainsIn(mainCol).pop() || addBox() || undefined;
        return !full || col === mainCol ? addBox() || undefined : undefined;
      }
      if (at >= 0 && at < mains.length - 1) return mains[at + 1];
      if (full && !inFoot && foot) return mainsIn(foot)[0] || true;
      return true;
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
      queue({ op: 'set', id: id, fields: { level: item.level }, to: 'end' });
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

  // The first draw happens before the hub has settled the tile's head, so the
  // rows may have been fitted to a body that then shrank. A moment later, if
  // the body's height changed, draw again (at most twice in a row).
  var fitHeight = 0;
  var fitTimer = null;
  var fitCount = 0;
  function refitSoon(body) {
    fitHeight = body.clientHeight;
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      fitTimer = null;
      try {
        var h = body.clientHeight;
        if (h && Math.abs(h - fitHeight) > 1 && fitCount < 2 && C) {
          fitCount += 1;
          C.redrawTile();
        } else {
          fitCount = 0;
        }
      } catch (e) { fitCount = 0; }
    }, 400);
  }

  var widget = {
    id: 'todo',
    icon: 'check-list',
    sub: STRINGS.sub,
    expandable: true,
    activity: 'todo',          // its working chip (app/motion.js)
    stagger: '.todo-panel-alert, .todo-col-main > .todo-add, .todo-sec, .todo-panel-foot',   // the parts arrive one by one as the panel opens

    init: function (ctx) {
      C = ctx;
      store.load();
      try { startSync(); } catch (e) { /* works as a list on this TV */ }
      lastDay = today();
      if (purge()) store.save();
      setInterval(function () {
        try { checkDay(); } catch (e) { /* try again next minute */ }
        try { updatePulse(); } catch (e2) { /* try again next minute */ }
      }, 60000);
      // A language change: new words, the tile and an open panel drawn again
      // (the hub then draws the title again itself).
      try {
        if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') {
          window.HUB_I18N.onChange(function () {
            localizeStrings();
            try { refresh(); } catch (e) { /* the next redraw has the words */ }
          });
        }
      } catch (e3) { /* stays in the language it started in */ }
      // Spanish for the owner's own words arrived: draw again, once for a
      // batch, never while the add box or an edit field has the keys.
      try {
        if (window.HUB_I18N && typeof window.HUB_I18N.onDyn === 'function') {
          var dynTimer = null;
          window.HUB_I18N.onDyn(function () {
            if (dynTimer) return;
            dynTimer = setTimeout(function () {
              dynTimer = null;
              try {
                var ae = document.activeElement;
                if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && C && C.isOpen()) { C.redrawTile(); return; }
                refresh();
              } catch (e) { /* the next redraw has them */ }
            }, 120);
          });
        }
      } catch (e4) { /* stays as typed */ }
    },

    renderTile: function (body, ctx) {
      C = ctx;
      try {
        drawTile(body);
      } catch (e) {
        renderError(body, e, 'todo-tile-error');
      }
      try { updateSubs(); } catch (e2) { /* keep the line as it is */ }
      try { refitSoon(body); } catch (e3) { /* the next redraw fits */ }
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

    // Items ticked this time move to Completed when the panel next opens.
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
  // Read when the hub draws the tile head, so it follows the language.
  Object.defineProperty(widget, 'title', { get: function () { return STRINGS.title; }, enumerable: true, configurable: true });
  return widget;
})());
