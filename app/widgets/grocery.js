/*
 * Groceries: the grocery list kept on the Pi (pi/grocery.js, resource
 * "grocery"). Two parts:
 *
 *   window.HUB_GROCERY   shared logic, no DOM: sort, counts, the add-box
 *                        parser and a local copy of the Pi's ops (for the
 *                        optimistic update). Node can require this file too.
 *   renderTouch(el, ctx) the phone and tablet view (app/touch.js). No TV tile
 *                        yet: the TV does not load this file (PR 2 adds one).
 *
 * ctx (from app/touch.js): t(key, english, vars), data() -> { items } or null
 * before the first answer, status() -> 'loading' | 'ok' | 'offline',
 * send(ops, optimisticData, done(err)), reduced() -> true for less motion,
 * products() -> { upc: product } for scanned items (brand, size, thumbnail).
 * Scan (app/scan.js) is registered as the 'grocery' destination: a scanned
 * product is added as { op: 'add', upc } and the Pi fills in the name.
 * Item names are what people typed: never translated, never logged.
 * Plain ES5: the logic may run on the TV later.
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

  function byUpc(items, upc) {
    if (!upc) return null;
    for (var i = 0; i < items.length; i++) if (items[i].upc === upc) return items[i];
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
        // As the Pi (pi/grocery.js applyOps): the same code first; then the
        // same name with no code (it takes this one) or the same code; a
        // different product under the same name gets its own row.
        var hit = byUpc(list, o.upc);
        if (!hit) {
          var k = key(o.name);
          for (var j = 0; j < list.length && !hit; j++) {
            if (list[j].name.toLowerCase() === k && (!o.upc || !list[j].upc || list[j].upc === o.upc)) hit = list[j];
          }
        }
        if (hit) {
          at = byId(list, hit.id);
          if (hit.done) list[at] = copy(list[at], { done: false, doneAt: null });
          if (o.upc && !hit.upc) list[at] = copy(list[at], { upc: o.upc });
        } else {
          tmpSeq += 1;
          var item = { id: 'tmp-' + tmpSeq, name: norm(o.name).slice(0, MAX_NAME), done: false, doneAt: null, addedAt: now, pending: true };
          if (o.upc) item.upc = o.upc;
          list.unshift(item);
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
    counts: counts, parseAdd: parseAdd, applyLocal: applyLocal, byUpc: byUpc
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
    camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z M12 10a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z',
    bars: 'M5 6v12 M8 6v12 M10.5 6v12 M14 6v12 M16.5 6v12 M19 6v12',
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

  // Products this page just scanned, so a new row shows its picture before
  // the next /touch/state brings the Pi's copy.
  var scanned = {};
  function productOf(ctx, upc) {
    if (!upc) return null;
    var all = ctx.products ? ctx.products() || {} : {};
    return all[upc] || scanned[upc] || null;
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
    var scanBtn = null;
    if (root.HUB_SCAN && ctx.call) {
      scanBtn = el('button', 'gx-scan');
      scanBtn.type = 'button';
      scanBtn.setAttribute('aria-label', T('grocery.scanLabel', 'Scan a barcode'));
      scanBtn.appendChild(icon('camera'));
      scanBtn.appendChild(el('span', 'gx-scan-word', T('grocery.scan', 'Scan')));
      scanBtn.addEventListener('click', function () { root.HUB_SCAN.open(ctx, { destination: 'grocery', returnFocus: scanBtn }); });
      form.appendChild(scanBtn);
    }
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
      var p = productOf(ctx, item.upc);
      if (item.upc) {
        // A scanned product: its picture, then the name, then "Brand · size".
        var th = el('span', 'gx-thumb');
        if (p && p.image) {
          var img = el('img');
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = function () { th.innerHTML = ''; th.className = 'gx-thumb is-none'; th.appendChild(icon('bars')); };
          img.src = p.image;
          th.appendChild(img);
        } else {
          th.className = 'gx-thumb is-none';
          th.appendChild(icon('bars'));
        }
        tick.appendChild(th);
        li.className += ' has-product';
      }
      var text = el('span', 'gx-text');
      text.appendChild(el('span', 'gx-name', item.name));
      var sub = p ? [p.brand, p.size].filter(function (x) { return x; }).join(' · ') : '';
      if (sub) text.appendChild(el('span', 'gx-sub', sub));
      tick.appendChild(text);
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

  // Where a scan can go (app/scan.js): onto this list, by code.
  if (root.HUB_SCAN) {
    root.HUB_SCAN.register('grocery', {
      label: function (t) { return t('grocery.destLabel', 'Groceries'); },
      note: function (product, ctx, t) {
        var d = ctx.data && ctx.data();
        var hit = byUpc(d && d.items ? d.items : [], product.upc);
        if (!hit) return '';
        return hit.done ? t('grocery.scanTicked', 'In the cart already; adding puts it back on the list.') : t('grocery.scanAlready', 'Already on the list.');
      },
      add: function (product, ctx, done) {
        scanned[product.upc] = product;
        var d = ctx.data && ctx.data();
        var items = d && d.items ? d.items : [];
        var name = root.HUB_SCAN.line(product) || product.upc;
        ctx.send([{ op: 'add', upc: product.upc }], { items: applyLocal(items, [{ op: 'add', name: name, upc: product.upc }], Date.now()) }, done);
      }
    });
  }

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push({
    id: 'grocery',
    title: 'Groceries',
    titleKey: 'grocery.title',
    icon: PATHS.basket,
    resource: 'grocery',
    summary: summary,
    renderTouch: renderTouch
  });
})(typeof window !== 'undefined' ? window : this);
