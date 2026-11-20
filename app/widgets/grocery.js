/*
 * Groceries: the grocery list kept on the Pi (pi/grocery.js, resource
 * "grocery"). Three parts:
 *
 *   window.HUB_GROCERY   shared logic, no DOM: sort, counts, the add-box
 *                        parser and a local copy of the Pi's ops (for the
 *                        optimistic update). Node can require this file too.
 *   renderTouch(el, ctx) the phone and tablet view (app/touch.js).
 *   the TV tile          renderTile / renderPanel (app/hub.js loads this file
 *                        and app/widgets/grocery.css; the touch app never
 *                        loads that CSS, and the TV never loads touch.css).
 *
 * ctx (from app/touch.js): t(key, english, vars), data() -> { items } or null
 * before the first answer, status() -> 'loading' | 'ok' | 'offline',
 * send(ops, optimisticData, done(err)), reduced() -> true for less motion.
 * Item names are what people typed: never translated, never logged.
 * Plain ES5 throughout: the TV's browser is Chromium 63 class.
 *
 * On the TV the Pi's copy is the only copy (nothing in localStorage): the
 * list comes over the live line (ctx.live 'grocery', app/live.js) and each
 * change is posted to the Pi's POST /grocery/ops (the same route as the
 * touch app; server 0.26.1 answers the TV's preflight). A change shows at
 * once (applyLocal over the Pi's list), the Pi's answer replaces it, and a
 * change the Pi refuses or never gets is taken back with a toast. Nothing is
 * queued for later: the phone may have changed the list meanwhile.
 *
 *   tile, 1 column  the count left to get
 *   tile, strip     "3 left · Milk" (the next item)
 *   tile, 2+ rows   the count big, then the first items that fit (to get
 *                   first, ticked ones dimmed), "+N more" and the cart count
 *   panel           an Add box (commas add several), "To get" rows (OK
 *                   ticks; Right moves to the row's Remove, OK twice
 *                   removes), "In the cart" with Clear ticked
 */
(function (root) {
  'use strict';

  var MAX_NAME = 60;
  var tmpSeq = 0;

  function norm(name) {
    return String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function key(name) { return norm(name).toLowerCase(); }

  function find(items, name) {
    var k = key(name);
    for (var i = 0; i < items.length; i++) if (items[i].name.toLowerCase() === k) return items[i];
    return null;
  }

  function byId(items, id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
    return -1;
  }

  // Unticked first, newest first (the Pi's order); then ticked, last ticked first.
  function sorted(items) {
    var left = [], done = [];
    for (var i = 0; i < items.length; i++) (items[i].done ? done : left).push(items[i]);
    done.sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
    return left.concat(done);
  }

  function counts(items) {
    var left = 0;
    for (var i = 0; i < items.length; i++) if (!items[i].done) left++;
    return { left: left, ticked: items.length - left, total: items.length };
  }

  // "milk, Eggs; milk" -> { names: ['milk', 'Eggs'], already: [...], tooLong: [...] }.
  // already: names on the list and not ticked (adding them changes nothing).
  function parseAdd(text, items) {
    var parts = String(text || '').split(/[,;\n]+/);
    var out = { names: [], already: [], tooLong: [] };
    var seen = {};
    for (var i = 0; i < parts.length; i++) {
      var n = norm(parts[i]);
      if (!n || seen[n.toLowerCase()]) continue;
      seen[n.toLowerCase()] = 1;
      if (n.length > MAX_NAME) { out.tooLong.push(n); continue; }
      var hit = find(items || [], n);
      if (hit && !hit.done) out.already.push(hit.name);
      else out.names.push(n);
    }
    return out;
  }

  // The Pi's ops (pi/grocery.js applyOps), applied to a copy for the
  // optimistic view. New items get a temporary id until the Pi answers.
  function applyLocal(items, ops, now) {
    var list = items.slice();
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i], at;
      if (o.op === 'add') {
        var hit = find(list, o.name);
        if (hit) {
          at = byId(list, hit.id);
          if (hit.done) list[at] = copy(hit, { done: false, doneAt: null });
        } else {
          tmpSeq += 1;
          list.unshift({ id: 'tmp-' + tmpSeq, name: norm(o.name), done: false, doneAt: null, addedAt: now, pending: true });
        }
      } else if (o.op === 'check') {
        at = byId(list, o.id);
        if (at >= 0) list[at] = copy(list[at], { done: !!o.done, doneAt: o.done ? now : null });
      } else if (o.op === 'remove') {
        at = byId(list, o.id);
        if (at >= 0) list.splice(at, 1);
      } else if (o.op === 'clear') {
        list = list.filter(function (x) { return !x.done; });
      }
    }
    return list;
  }

  function copy(item, over) {
    var o = {}, k;
    for (k in item) if (Object.prototype.hasOwnProperty.call(item, k)) o[k] = item[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) o[k] = over[k];
    return o;
  }

  var Logic = {
    MAX_NAME: MAX_NAME, norm: norm, key: key, find: find, sorted: sorted,
    counts: counts, parseAdd: parseAdd, applyLocal: applyLocal
  };
  root.HUB_GROCERY = Logic;
  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof document === 'undefined') return;

  /* ---------- the touch view ---------- */

  var SVG = 'http://www.w3.org/2000/svg';
  var PATHS = {
    check: 'M5 12.5l4.2 4.2L19 7',
    cross: 'M7 7l10 10M17 7L7 17',
    plus: 'M12 5v14M5 12h14',
    basket: 'M4 9h16l-1.6 9.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8z M8.5 9l3.5-5 3.5 5 M9.5 13v3 M14.5 13v3'
  };

  function icon(name, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'gx-ic ' + (cls || ''));
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', PATHS[name]);
    s.appendChild(p);
    return s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // This device's own memory of names it added (most recent first), for the
  // Buy again chips. Browser storage may be missing; then there are no chips.
  var RECENT_KEY = 'homeHub.grocery.recent';
  function recent() {
    try { var r = JSON.parse(root.localStorage.getItem(RECENT_KEY) || '[]'); return r instanceof Array ? r : []; } catch (e) { return []; }
  }
  function remember(names) {
    var list = recent();
    for (var i = names.length - 1; i >= 0; i--) {
      var k = key(names[i]);
      list = list.filter(function (n) { return key(n) !== k; });
      list.unshift(norm(names[i]));
    }
    try { root.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 24))); } catch (e) { /* no storage */ }
  }

  function renderTouch(host, ctx) {
    var T = ctx.t;
    var view = el('div', 'gx');
    host.appendChild(view);

    // Attribute first: the count leads, the words recede.
    var head = el('div', 'gx-head');
    var big = el('span', 'gx-big');
    var bigWord = el('span', 'gx-big-word');
    var cart = el('span', 'gx-cart');
    var lead = el('div', 'gx-lead');
    lead.appendChild(big);
    lead.appendChild(bigWord);
    head.appendChild(lead);
    head.appendChild(cart);
    view.appendChild(head);

    var form = el('form', 'gx-add');
    form.setAttribute('autocomplete', 'off');
    var label = el('label', 'gx-sr', T('grocery.addLabel', 'Add to the list'));
    var input = el('input', 'gx-input');
    input.type = 'text';
    input.id = 'gx-input-' + Math.floor(Math.random() * 1e6);
    label.setAttribute('for', input.id);
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('autocapitalize', 'sentences');
    input.placeholder = T('grocery.addPlaceholder', 'Milk, eggs, bread');
    var addBtn = el('button', 'gx-add-btn');
    addBtn.type = 'submit';
    addBtn.appendChild(icon('plus'));
    addBtn.appendChild(el('span', 'gx-add-word', T('grocery.addButton', 'Add')));
    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(addBtn);
    view.appendChild(form);
    var note = el('p', 'gx-note', T('grocery.addHint', 'Commas add several at once.'));
    note.setAttribute('aria-live', 'polite');
    view.appendChild(note);

    var banner = el('p', 'gx-banner');
    banner.setAttribute('role', 'status');
    view.appendChild(banner);

    var again = el('div', 'gx-again');
    view.appendChild(again);

    var list = el('ul', 'gx-list');
    view.appendChild(list);
    var empty = el('div', 'gx-empty');
    view.appendChild(empty);

    var doneHead = el('div', 'gx-done-head');
    var doneLabel = el('span', 'gx-label');
    var clearBtn = el('button', 'gx-clear', T('grocery.clear', 'Clear ticked'));
    clearBtn.type = 'button';
    doneHead.appendChild(doneLabel);
    doneHead.appendChild(clearBtn);
    view.appendChild(doneHead);
    var doneList = el('ul', 'gx-list gx-list-done');
    view.appendChild(doneList);

    var toast = el('div', 'gx-toast');
    toast.setAttribute('role', 'status');
    var toastText = el('span', 'gx-toast-text');
    var undoBtn = el('button', 'gx-undo', T('grocery.undo', 'Undo'));
    undoBtn.type = 'button';
    toast.appendChild(toastText);
    toast.appendChild(undoBtn);
    view.appendChild(toast);

    var noteTimer = null, toastTimer = null, lastRemoved = null, failMsg = '';
    var rows = {};

    function items() { var d = ctx.data(); return d && d.items ? d.items : []; }

    function send(ops) {
      failMsg = '';
      ctx.send(ops, { items: applyLocal(items(), ops, Date.now()) }, function (err) {
        if (err) { failMsg = T('grocery.saveFailed', 'That didn’t save: {why}', { why: err }); render(); }
      });
    }

    function say(text) {
      note.textContent = text;
      note.className = 'gx-note is-said';
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(function () {
        note.className = 'gx-note';
        note.textContent = T('grocery.addHint', 'Commas add several at once.');
      }, 4000);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var p = parseAdd(input.value, items());
      if (p.tooLong.length) { say(T('grocery.tooLong', 'At most {n} characters per item', { n: MAX_NAME })); return; }
      if (p.already.length) say(T('grocery.already', 'Already on the list: {names}', { names: p.already.join(', ') }));
      input.value = '';
      remember(p.names);
      if (p.names.length) send(p.names.slice(0, 20).map(function (n) { return { op: 'add', name: n }; }));
    });

    clearBtn.addEventListener('click', function () { send([{ op: 'clear' }]); });

    undoBtn.addEventListener('click', function () {
      if (lastRemoved) send([{ op: 'add', name: lastRemoved }]);
      hideToast();
    });

    function hideToast() {
      lastRemoved = null;
      toast.className = 'gx-toast';
    }

    function showToast(name) {
      lastRemoved = name;
      toastText.textContent = T('grocery.removed', 'Removed {name}', { name: name });
      toast.className = 'gx-toast is-on';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 6000);
    }

    function row(item) {
      var li = rows[item.id] || el('li', 'gx-row');
      li.innerHTML = '';
      li.className = 'gx-row' + (item.done ? ' is-done' : '') + (item.pending ? ' is-pending' : '');
      li.setAttribute('data-id', item.id);
      var tick = el('button', 'gx-tick');
      tick.type = 'button';
      tick.setAttribute('aria-pressed', item.done ? 'true' : 'false');
      tick.setAttribute('aria-label', item.done ? T('grocery.untick', 'Untick {name}', { name: item.name }) : T('grocery.tick', 'Tick {name}', { name: item.name }));
      var box = el('span', 'gx-box');
      box.appendChild(icon('check'));
      tick.appendChild(box);
      tick.appendChild(el('span', 'gx-name', item.name));
      var del = el('button', 'gx-del');
      del.type = 'button';
      del.setAttribute('aria-label', T('grocery.remove', 'Remove {name}', { name: item.name }));
      del.appendChild(icon('cross'));
      if (item.pending) { tick.disabled = true; del.disabled = true; }
      tick.addEventListener('click', function () { send([{ op: 'check', id: item.id, done: !item.done }]); });
      del.addEventListener('click', function () {
        send([{ op: 'remove', id: item.id }]);
        showToast(item.name);
      });
      li.appendChild(tick);
      li.appendChild(del);
      rows[item.id] = li;
      return li;
    }

    // Rows that moved glide to their new place (transform only).
    function flip(before) {
      if (ctx.reduced()) return;
      Object.keys(rows).forEach(function (id) {
        var r = rows[id], b = before[id];
        if (!r.parentNode) return;
        var now = r.getBoundingClientRect().top;
        if (b === undefined) {
          r.style.transition = 'none';
          r.style.opacity = '0';
          r.style.transform = 'translateY(-6px)';
        } else if (Math.abs(b - now) > 1) {
          r.style.transition = 'none';
          r.style.transform = 'translateY(' + (b - now) + 'px)';
        } else return;
        r.getBoundingClientRect();
        r.style.transition = '';
        r.style.transform = '';
        r.style.opacity = '';
      });
    }

    function render() {
      var st = ctx.status();
      var data = ctx.data();
      var all = sorted(items());
      var c = counts(all);
      var before = {};
      Object.keys(rows).forEach(function (id) { if (rows[id].parentNode) before[id] = rows[id].getBoundingClientRect().top; });

      big.textContent = data ? String(c.left) : '–';
      bigWord.textContent = T('grocery.toGet', 'to get');
      cart.textContent = c.ticked ? T('grocery.inCart', 'In the cart') + ' · ' + c.ticked : '';

      var msg = failMsg || (st === 'offline' ? T('grocery.offline', 'Can’t reach the hub. Showing the last list; changes won’t save.') : '');
      banner.textContent = msg;
      banner.className = 'gx-banner' + (msg ? ' is-on' : '');
      view.className = 'gx' + (st === 'offline' ? ' is-offline' : '');

      var keep = {};
      var left = all.filter(function (i) { return !i.done; });
      var done = all.filter(function (i) { return i.done; });
      list.innerHTML = '';
      left.forEach(function (i) { keep[i.id] = 1; list.appendChild(row(i)); });
      doneList.innerHTML = '';
      done.forEach(function (i) { keep[i.id] = 1; doneList.appendChild(row(i)); });
      Object.keys(rows).forEach(function (id) { if (!keep[id]) delete rows[id]; });

      empty.innerHTML = '';
      if (!data) {
        empty.appendChild(el('p', 'gx-empty-text', st === 'offline' ? '' : T('grocery.loading', 'Loading the list…')));
      } else if (!left.length) {
        empty.appendChild(icon('basket', 'gx-empty-ic'));
        empty.appendChild(el('p', 'gx-empty-title', done.length ? T('grocery.allDone', 'All in the cart') : T('grocery.emptyTitle', 'Nothing to get')));
        if (!done.length) empty.appendChild(el('p', 'gx-empty-text', T('grocery.emptyText', 'Add what you need above, or ask Claude to add it.')));
      }
      empty.style.display = empty.childNodes.length ? '' : 'none';

      doneHead.style.display = done.length ? '' : 'none';
      doneLabel.textContent = T('grocery.inCart', 'In the cart');

      // Buy again: names this device added before that are not on the list
      // now; one tap adds one back.
      again.innerHTML = '';
      var back = recent().filter(function (n) { var h = find(all, n); return !h || h.done; }).slice(0, 8);
      if (back.length) {
        again.appendChild(el('span', 'gx-label', T('grocery.again', 'Buy again')));
        var chips = el('div', 'gx-chips');
        back.forEach(function (n) {
          var b = el('button', 'gx-chip');
          b.type = 'button';
          b.appendChild(icon('plus'));
          b.appendChild(el('span', '', n));
          b.addEventListener('click', function () { remember([n]); send([{ op: 'add', name: n }]); });
          chips.appendChild(b);
        });
        again.appendChild(chips);
      }
      again.style.display = back.length ? '' : 'none';
      flip(before);
    }

    render();
    return {
      update: render,
      destroy: function () {
        if (noteTimer) clearTimeout(noteTimer);
        if (toastTimer) clearTimeout(toastTimer);
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  // The menu's line for this widget: '7 to get'.
  function summary(data, t) {
    if (!data || !data.items) return '';
    var c = counts(data.items);
    return c.left ? t('grocery.summary', '{n} to get', { n: c.left }) : t('grocery.emptyTitle', 'Nothing to get');
  }

  /* ---------- the TV tile and panel ---------- */

  function tr(k, english, vars) {
    var L = root.HUB_I18N;
    if (L && typeof L.t === 'function') {
      try { return String(L.t(k, english, vars)); } catch (e) { /* English below */ }
    }
    return String(english).replace(/\{(\w+)\}/g, function (all, n) {
      return vars && Object.prototype.hasOwnProperty.call(vars, n) ? String(vars[n]) : all;
    });
  }

  function svgHTML(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + PATHS[name] + '"/></svg>';
  }

  // The TV's state. server: the Pi's last list (null before the first one);
  // pending: changes posted and not yet answered, drawn over it.
  var tv = {
    C: null, server: null, serverRev: -1, pending: [], panel: null,
    armed: null, armedAt: 0, redrawLater: false, ownAdds: {}, fitTimer: null, fitH: 0, fitCount: 0
  };

  function live() { return tv.C && tv.C.live ? tv.C.live : null; }

  function liveState() {
    var L = live();
    try { return L ? (L.status() || {}).state || 'off' : 'off'; } catch (e) { return 'off'; }
  }

  function cleanItems(list) {
    var out = [];
    if (!(list instanceof Array)) return null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it && typeof it.id === 'string' && typeof it.name === 'string') out.push(it);
    }
    return out;
  }

  // What the TV shows: the Pi's list with the changes on their way applied.
  // A new item's temporary id is its name, so its row keeps one key until
  // the Pi gives it a real id.
  function view() {
    if (!tv.server) return null;
    var list = tv.server;
    for (var i = 0; i < tv.pending.length; i++) list = applyLocal(list, tv.pending[i].ops, tv.pending[i].at);
    var out = [];
    for (var j = 0; j < list.length; j++) {
      out.push(list[j].pending ? copy(list[j], { id: 'new:' + key(list[j].name) }) : list[j]);
    }
    return out;
  }

  function addBox() { return tv.panel ? tv.panel.querySelector('input.gt-input') : null; }
  function typing() { var b = addBox(); return !!b && document.activeElement === b; }

  // Redraws the tile, and the open panel unless someone is typing in its Add
  // box (then once the typing stops).
  function refresh() {
    var C = tv.C;
    if (!C) return;
    C.redrawTile();
    if (!C.isOpen()) return;
    if (typing()) { tv.redrawLater = true; return; }
    C.redrawPanel();
  }

  // An item someone else added (the phone, Claude) is news: the tile's
  // arrival chip. Never for the first list, a tick, or this TV's own adds.
  function isNews(before, after) {
    var had = {}, i, now = new Date().getTime();
    for (i = 0; i < before.length; i++) had[before[i].id] = 1;
    for (i = 0; i < after.length; i++) {
      var it = after[i];
      if (it.done || had[it.id]) continue;
      var own = tv.ownAdds[key(it.name)];
      if (own && now - own < 60000) continue;
      return true;
    }
    return false;
  }

  function takeServer(items, rev, fromLive) {
    var list = cleanItems(items);
    if (!list) return;
    if (typeof rev === 'number') {
      if (rev < tv.serverRev) return;
      tv.serverRev = rev;
    }
    var before = tv.server;
    tv.server = list;
    if (fromLive && before && tv.C && typeof tv.C.activity === 'function' && isNews(before, list)) {
      try { tv.C.activity('grocery'); } catch (e) { /* the rows just show */ }
    }
    refresh();
  }

  function why(err, code) {
    if (!code) return tr('grocery.tvUnreachable', 'the Pi didn’t answer');
    return String(err || ('HTTP ' + code));
  }

  // Posts ops to the Pi. Shown at once; the Pi's answer replaces the view, a
  // refusal or no answer takes the change back with a toast.
  function send(ops) {
    var L = live();
    var C = tv.C;
    if (!tv.server) return;
    if (!L || typeof L.post !== 'function') {
      if (C) C.toast(tr('grocery.saveFailed', 'That didn’t save: {why}', { why: tr('grocery.tvUnreachable', 'the Pi didn’t answer') }), 4500);
      return;
    }
    var entry = { ops: ops, at: new Date().getTime() };
    tv.pending.push(entry);
    refresh();
    L.post('/grocery/ops', { ops: ops }, function (err, data, code) {
      var at = tv.pending.indexOf(entry);
      if (at >= 0) tv.pending.splice(at, 1);
      try {
        if (!err && data && data.items instanceof Array) {
          takeServer(data.items, typeof data.rev === 'number' ? data.rev : undefined, false);
          return;
        }
        if (window.console && console.warn) console.warn('Groceries: the Pi did not take a change (' + (code || 'no answer') + ')');
        if (C) C.toast(tr('grocery.saveFailed', 'That didn’t save: {why}', { why: why(err, code) }), 4500);
      } catch (e) { /* drawn below */ }
      refresh();
    });
  }

  function div(cls, parent, text) {
    var n = el('div', cls, text);
    if (parent) parent.appendChild(n);
    return n;
  }

  function sizeOf(ctx) {
    try { return ctx.size() || {}; } catch (e) { return {}; }
  }

  /* --- the tile --- */

  function tileRow(item, parent) {
    var r = div('gt-trow' + (item.done ? ' is-done' : '') + (item.pending ? ' is-pending' : ''), parent);
    var box = el('span', 'gt-tbox');
    if (item.done) box.innerHTML = svgHTML('check');
    r.appendChild(box);
    r.appendChild(el('span', 'gt-tname', item.name));
    return r;
  }

  function footText(c, hidden) {
    var parts = [];
    if (hidden) parts.push(tr('grocery.more', '+{n} more', { n: hidden }));
    if (c.ticked) parts.push(tr('grocery.inCartN', '{n} in the cart', { n: c.ticked }));
    if (liveState() !== 'live' && live()) parts.push(tr('grocery.notLive', 'Not live'));
    return parts.join(' · ');
  }

  // Rows leave from the bottom until the foot line fits inside the body.
  function fitRows(body, list, foot, rows, c) {
    var limit = body.getBoundingClientRect().bottom;
    var shown = rows.length;
    while (shown > 0 && foot.getBoundingClientRect().bottom > limit + 0.5) {
      shown -= 1;
      list.removeChild(rows[shown]);
      foot.textContent = footText(c, c.total - shown);
    }
    if (!shown) list.style.display = 'none';
  }

  function refitSoon(body) {
    tv.fitH = body.clientHeight;
    if (tv.fitTimer) clearTimeout(tv.fitTimer);
    tv.fitTimer = setTimeout(function () {
      tv.fitTimer = null;
      try {
        var h = body.clientHeight;
        if (h && Math.abs(h - tv.fitH) > 1 && tv.fitCount < 2 && tv.C) { tv.fitCount += 1; tv.C.redrawTile(); } else tv.fitCount = 0;
      } catch (e) { tv.fitCount = 0; }
    }, 400);
  }

  function renderTile(body, ctx) {
    body.innerHTML = '';
    var s = sizeOf(ctx);
    var tier = s.tier || 'standard';
    var one = s.cols === 1;
    var box = div('gt-tile gt-tile-' + tier + (one ? ' gt-tile-one' : ''), body);
    var items = view();
    if (!items) {
      box.className += ' hub-dormant';
      var wait = live() && liveState() !== 'off' ? tr('grocery.loading', 'Loading the list…') : tr('grocery.noPi', 'The list lives on the Pi');
      div('gt-msg', box, one ? '–' : wait);
      return;
    }
    var all = sorted(items);
    var c = counts(all);
    if (one) {
      div('gt-one-num', box, String(c.left));
      return;
    }
    if (tier === 'strip') {
      var line = div('gt-strip', box);
      if (!c.total) { line.appendChild(el('span', 'gt-strip-word', tr('grocery.listEmpty', 'List is empty'))); return; }
      if (!c.left) { line.appendChild(el('span', 'gt-strip-word', tr('grocery.allDone', 'All in the cart'))); return; }
      line.appendChild(el('span', 'gt-strip-num', tr('grocery.left', '{n} left', { n: c.left })));
      line.appendChild(el('span', 'gt-strip-dot', '·'));
      line.appendChild(el('span', 'gt-strip-next gt-tname', all[0].name));
      return;
    }
    var hero = div('gt-hero', box);
    if (!c.total) {
      hero.appendChild(el('span', 'gt-hero-word', tr('grocery.listEmpty', 'List is empty')));
      div('gt-hint', box, tr('grocery.tvEmptyHint', 'Open it to add, or add from a phone.'));
      return;
    }
    if (!c.left) {
      hero.appendChild(el('span', 'gt-hero-word', tr('grocery.allDone', 'All in the cart')));
    } else {
      hero.appendChild(el('span', 'gt-hero-num', String(c.left)));
      hero.appendChild(el('span', 'gt-hero-cap', tr('grocery.toGet', 'to get')));
    }
    var list = div('gt-tlist', box);
    var rows = [];
    for (var i = 0; i < all.length; i++) rows.push(tileRow(all[i], list));
    var foot = div('gt-foot', box, footText(c, 0));
    fitRows(body, list, foot, rows, c);
    if (!foot.textContent) foot.style.display = 'none';
    refitSoon(body);
  }

  /* --- the panel --- */

  function panelRow(item, parent) {
    var row = div('gt-row' + (item.done ? ' is-done' : '') + (item.pending ? ' is-pending' : ''), parent);
    var main = div('gt-main f', row);
    main.setAttribute('data-key', 'item:' + item.id);
    main.setAttribute('role', 'button');
    main.setAttribute('aria-label', item.done ? tr('grocery.untick', 'Untick {name}', { name: item.name }) : tr('grocery.tick', 'Tick {name}', { name: item.name }));
    var tick = el('span', 'gt-box');
    tick.innerHTML = svgHTML('check');
    main.appendChild(tick);
    main.appendChild(el('span', 'gt-name', item.name));
    var del = div('gt-del f', row);
    del.setAttribute('data-key', 'del:' + item.id);
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', tr('grocery.remove', 'Remove {name}', { name: item.name }));
    var pill = el('span', 'gt-pill');
    pill.appendChild(el('span', 'gt-pill-label', tr('grocery.removeBtn', 'Remove')));
    pill.appendChild(el('span', 'gt-pill-armed', tr('grocery.removeArmed', 'OK again to remove')));
    del.appendChild(pill);
    var ic = el('span', 'gt-del-ic');
    ic.innerHTML = svgHTML('cross');
    del.appendChild(ic);
    if (tv.armed === item.id) del.className += ' is-armed';
    return row;
  }

  function section(parent, cls, label, n) {
    var sec = div('gt-sec ' + cls, parent);
    var head = div('gt-sec-head', sec);
    head.appendChild(el('span', 'gt-sec-name', label));
    head.appendChild(el('span', 'gt-sec-count', String(n)));
    return { sec: sec, head: head };
  }

  function renderPanel(body, ctx) {
    body.innerHTML = '';
    tv.panel = body;
    var full = ctx.mode() === 'full';
    var box = div('gt-panel' + (full ? ' is-full' : ''), body);
    var items = view();
    if (!items) {
      ctx.setSub('');
      var wait = live() && liveState() !== 'off' ? tr('grocery.loading', 'Loading the list…') : tr('grocery.noPi', 'The list lives on the Pi');
      div('gt-msg gt-panel-msg hub-dormant', box, wait);
      return;
    }
    var all = sorted(items);
    var c = counts(all);
    var sub = c.left ? tr('grocery.summary', '{n} to get', { n: c.left }) : tr('grocery.allDone', 'All in the cart');
    if (!c.total) sub = tr('grocery.listEmpty', 'List is empty');
    if (liveState() !== 'live') sub += ' · ' + tr('grocery.notLive', 'Not live');
    ctx.setSub(sub);

    var add = div('gt-add', box);
    var plus = el('span', 'gt-add-icon');
    plus.innerHTML = svgHTML('plus');
    add.appendChild(plus);
    var input = el('input', 'f gt-input');
    input.setAttribute('type', 'text');
    input.setAttribute('data-key', 'add');
    input.setAttribute('maxlength', '400');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'sentences');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('placeholder', tr('grocery.addPlaceholder', 'Milk, eggs, bread'));
    input.setAttribute('aria-label', tr('grocery.addLabel', 'Add to the list'));
    if (!c.left) input.setAttribute('data-autofocus', '');
    input.addEventListener('blur', function () {
      if (!tv.redrawLater) return;
      tv.redrawLater = false;
      setTimeout(function () {
        try { if (tv.C && tv.C.isOpen() && !typing()) tv.C.redrawPanel(); } catch (e) { /* ignore */ }
      }, 0);
    }, false);
    add.appendChild(input);
    var hint = el('span', 'gt-add-hint');
    hint.appendChild(el('span', 'gt-hint-ok', tr('grocery.hintOk', 'OK to type')));
    hint.appendChild(el('span', 'gt-hint-typing', tr('grocery.hintTyping', 'Commas add several')));
    add.appendChild(hint);
    add.appendChild(el('span', 'gt-add-frame'));

    var left = [], done = [], i;
    for (i = 0; i < all.length; i++) (all[i].done ? done : left).push(all[i]);
    var s1 = section(box, 'gt-sec-left', tr('grocery.secLeft', 'To get'), left.length);
    if (!left.length) div('gt-empty', s1.sec, c.total ? tr('grocery.allDone', 'All in the cart') : tr('grocery.listEmpty', 'List is empty'));
    for (i = 0; i < left.length; i++) {
      var r = panelRow(left[i], s1.sec);
      if (i === 0) r.firstChild.setAttribute('data-autofocus', '');
    }
    if (done.length) {
      var s2 = section(box, 'gt-sec-done', tr('grocery.inCart', 'In the cart'), done.length);
      var clear = el('span', 'gt-clear f', tr('grocery.clear', 'Clear ticked'));
      clear.setAttribute('data-key', 'clear');
      clear.setAttribute('role', 'button');
      s2.head.appendChild(clear);
      for (i = 0; i < done.length; i++) panelRow(done[i], s2.sec);
    }
  }

  /* --- the remote --- */

  function byKey(k) {
    if (!tv.panel) return null;
    var list = tv.panel.querySelectorAll('.f');
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-key') === k) return list[i];
    return null;
  }

  function idOf(k, prefix) { return k && k.indexOf(prefix) === 0 ? k.substring(prefix.length) : null; }

  function findItem(id) {
    var items = view() || [];
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function mains() {
    var list = tv.panel ? tv.panel.querySelectorAll('.gt-main') : [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function disarm() {
    if (tv.armed === null) return;
    var d = byKey('del:' + tv.armed);
    if (d) d.className = d.className.replace(/\s*is-armed/g, '');
    tv.armed = null;
  }

  // Where focus goes once a row leaves: the row that takes its place, else
  // the one before it, else the Add box.
  function keyAfter(id) {
    var list = mains(), keys = [], at = -1;
    for (var i = 0; i < list.length; i++) {
      var k = list[i].getAttribute('data-key');
      if (k === 'item:' + id) at = keys.length;
      else keys.push(k);
    }
    if (at < 0) return 'add';
    if (at < keys.length) return keys[at];
    return at > 0 ? keys[at - 1] : 'add';
  }

  function onSelect(target, ctx) {
    var k = target.getAttribute('data-key') || '';
    var id = idOf(k, 'item:');
    if (k !== 'del:' + tv.armed) disarm();
    if (id !== null) {
      if (id.indexOf('new:') === 0) return;
      var item = findItem(id);
      if (item) send([{ op: 'check', id: id, done: !item.done }]);
      return;
    }
    id = idOf(k, 'del:');
    if (id !== null) {
      if (id.indexOf('new:') === 0) return;
      var now = new Date().getTime();
      if (tv.armed !== id) {
        tv.armed = id;
        tv.armedAt = now;
        target.className += ' is-armed';
        return;
      }
      // A held OK repeats; the second press has to be a new one.
      if (now - tv.armedAt < 400) return;
      tv.armed = null;
      var next = keyAfter(id);
      send([{ op: 'remove', id: id }]);
      var node = byKey(next) || byKey('add');
      if (node) ctx.focus(node);
      return;
    }
    if (k === 'clear') {
      send([{ op: 'clear' }]);
      var n2 = byKey('add');
      if (n2) ctx.focus(n2);
    }
  }

  function onSubmit(target, ctx) {
    if (target.getAttribute('data-key') !== 'add') return;
    var p = parseAdd(target.value, view() || []);
    if (p.tooLong.length) { ctx.toast(tr('grocery.tooLong', 'At most {n} characters per item', { n: MAX_NAME }), 4500); return; }
    target.value = '';
    if (p.already.length) ctx.toast(tr('grocery.already', 'Already on the list: {names}', { names: p.already.join(', ') }), 4500);
    if (!p.names.length) { refresh(); return; }
    var now = new Date().getTime(), ops = [];
    for (var i = 0; i < p.names.length && i < 20; i++) {
      tv.ownAdds[key(p.names[i])] = now;
      ops.push({ op: 'add', name: p.names[i] });
    }
    send(ops);
  }

  // Up and Down walk one list: the Add box, the rows to get, Clear ticked,
  // the rows in the cart (from a row's Remove too, so Down never jumps to the
  // next Remove). Right from a row goes to its Remove, Left back. Down from
  // the head's Full screen button goes to the Add box. Up from the Add box
  // is left to the hub (to the head).
  function stops() {
    var out = [], b = addBox(), c = byKey('clear');
    if (b) out.push(b);
    var list = mains();
    for (var i = 0; i < list.length; i++) {
      if (c && list[i].parentNode.parentNode.className.indexOf('gt-sec-done') >= 0 && out.indexOf(c) < 0) out.push(c);
      out.push(list[i]);
    }
    if (c && out.indexOf(c) < 0) out.push(c);
    return out;
  }

  function has(node, cls) { return !!node && typeof node.className === 'string' && (' ' + node.className + ' ').indexOf(' ' + cls + ' ') >= 0; }

  function onMove(dir, from, ctx) {
    if (!tv.panel || !from) return undefined;
    if (!tv.panel.contains(from)) return dir === 'down' ? addBox() || undefined : undefined;
    var isDel = has(from, 'gt-del'), isMain = has(from, 'gt-main');
    if (dir === 'left' || dir === 'right') {
      if (isDel && dir === 'left') { disarm(); return from.parentNode.querySelector('.gt-main') || true; }
      if (isMain && dir === 'right') return from.parentNode.querySelector('.gt-del') || true;
      return isDel || isMain ? true : undefined;
    }
    disarm();
    var list = stops();
    var at = list.indexOf(isDel ? from.parentNode.querySelector('.gt-main') : from);
    if (at < 0) return undefined;
    if (dir === 'up') return at > 0 ? list[at - 1] : undefined;
    return at < list.length - 1 ? list[at + 1] : true;
  }

  var tvWidget = {
    id: 'grocery',
    titleKey: 'grocery.title',
    icon: 'basket',               // HUB_ICONS (app/icons.js) on the TV
    touchIcon: PATHS.basket,      // a path for app/touch.js
    resource: 'grocery',
    summary: summary,
    renderTouch: renderTouch,
    expandable: true,
    activity: 'grocery',
    stagger: '.gt-add, .gt-sec',

    init: function (ctx) {
      tv.C = ctx;
      var L = ctx.live;
      if (L) {
        try {
          var d = L.get('grocery');
          if (d && d.items) takeServer(d.items, undefined, false);
          L.on('grocery', function (data, rev) {
            if (data && data.items) takeServer(data.items, rev, true);
          });
        } catch (e) { /* the tile says it waits */ }
      }
      var I = root.HUB_I18N;
      if (I && typeof I.onChange === 'function') {
        I.onChange(function () {
          try {
            if (typeof ctx.retitle === 'function') ctx.retitle();
            refresh();
          } catch (e) { /* next draw */ }
        });
      }
    },
    renderTile: renderTile,
    renderPanel: renderPanel,
    onSelect: onSelect,
    onSubmit: onSubmit,
    onMove: onMove,
    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onStatus: function (ctx) { ctx.redrawTile(); },
    onClose: function () { disarm(); tv.panel = null; tv.redrawLater = false; }
  };
  try {
    Object.defineProperty(tvWidget, 'title', { get: function () { return tr('grocery.title', 'Groceries'); }, enumerable: true, configurable: true });
    Object.defineProperty(tvWidget, 'shortTitle', { get: function () { return tr('grocery.titleShort', 'Grocery'); }, enumerable: true, configurable: true });
  } catch (e) {
    tvWidget.title = 'Groceries';
  }

  // For the tests (dev/grocery-test.js).
  root.HUB_GROCERY_TV = { state: tv, view: view };

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push(tvWidget);
})(typeof window !== 'undefined' ? window : this);
