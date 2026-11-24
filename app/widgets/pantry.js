/*
 * Pantry: what is at home, kept on the Pi (pi/pantrydb.js, SQLite; the
 * touch app reads it as "pantry" in GET /touch/state and posts changes to
 * POST /pantry/ops). Phone and tablet only in this first part: no TV tile
 * (hub.html loads pantry.css for the loader's list, never this file).
 *
 *   window.HUB_PANTRY   shared logic, no DOM: fold (search key), sorting,
 *                       counts and the local copy of a few ops (optimistic).
 *   renderTouch         Stock | Usual items, place chips, rows (photo, brand
 *                       over name, a - n + stepper, an "Add to list" /
 *                       "On list" pill with a toast and Undo, a Low badge
 *                       with the restock value, "Added to list for you" when
 *                       the hub put it there) and a bottom sheet to
 *                       edit place, "buy more at", auto-add, substitution,
 *                       brand and category (picked from the Pi's lists or
 *                       created once, never typed twice), size and unit.
 *
 * ctx (app/touch.js): t, data() -> { products, brands, categories, counts },
 * status(), send(ops, optimistic, done), call(), refresh(), reduced().
 * Scan (app/scan.js) is registered as the 'pantry' destination: a scan adds
 * one (a known product counts up, a new one is made from the catalog).
 * Product names and brands are the owner's: never translated, never logged.
 * Touch only, so grid and flex gap are fine in pantry.css. Plain ES5.
 */
(function (root) {
  'use strict';

  var PLACES = ['fridge', 'freezer', 'pantry', 'other'];
  var MODES = ['similar', 'preselected', 'refund', 'contact_me'];
  var UNITS = ['oz', 'fl_oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'count', 'pack'];
  // The categories the Pi starts with get Spanish names; ones made later stay as typed.
  var SEEDED = { eggs: 1, dairy: 1, bread: 1, produce: 1, meat: 1, frozen: 1, canned: 1, 'dry goods': 1, snacks: 1, drinks: 1, 'paper goods': 1, cleaning: 1, other: 1 };

  /* ---------- logic ---------- */

  // The same key the Pi uses (pantrydb.js keyOf): case, accents and punctuation
  // folded; letters and digits of any script kept. An engine without Unicode
  // property escapes (older TVs) keeps every non-ASCII character instead.
  var NOT_WORD = /[^a-z0-9\u00aa-\uffff]+/g, MARKS = /[\u0300-\u036f]/g;
  try { NOT_WORD = new RegExp('[^\\p{L}\\p{N}]+', 'gu'); MARKS = new RegExp('\\p{M}', 'gu'); } catch (e) { /* keep the fallback */ }
  function fold(s) {
    var t = String(s == null ? '' : s);
    if (t.normalize) t = t.normalize('NFD').replace(MARKS, '');
    return t.toLowerCase().replace(/&/g, ' and ').replace(/['\u2018\u2019\u0060]/g, '').replace(NOT_WORD, ' ').replace(/^\s+|\s+$/g, '');
  }

  function matches(p, q) {
    var k = fold(q);
    if (!k) return true;
    return fold(p.name).indexOf(k) >= 0 || fold(p.brand).indexOf(k) >= 0 || fold((p.brand || '') + ' ' + p.name).indexOf(k) >= 0;
  }

  function byName(a, b) {
    var x = fold(a.name), y = fold(b.name);
    return x < y ? -1 : x > y ? 1 : a.id - b.id;
  }

  // Stock: owned items, low first, then by name. Usual: everything, by name.
  function stock(products, place) {
    return products.filter(function (p) { return p.owned && (!place || p.location === place); })
      .sort(function (a, b) { return (b.low ? 1 : 0) - (a.low ? 1 : 0) || byName(a, b); });
  }
  function usual(products, place, q) {
    return products.filter(function (p) { return (!place || p.location === place) && matches(p, q); }).sort(byName);
  }

  function counts(data) {
    var c = { items: 0, low: 0 };
    ((data && data.products) || []).forEach(function (p) { if (p.owned) { c.items++; if (p.low) c.low++; } });
    return c;
  }

  function copy(o, over) {
    var r = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    for (k in over || {}) if (Object.prototype.hasOwnProperty.call(over, k)) r[k] = over[k];
    return r;
  }

  function isLow(p) { return !!p.owned && p.qty <= p.restockAt; }

  // The phone's guess at an op's result, shown until the Pi answers.
  function applyLocal(data, ops) {
    if (!data) return data;
    var list = (data.products || []).slice();
    ops.forEach(function (o) {
      var at = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === o.id) at = i;
      if (o.op === 'add' && !o.upc) {
        list.unshift({ id: -Date.now(), name: o.name, brand: '', qty: o.qty || 1, restockAt: 1, owned: true, low: false, location: o.location || 'pantry', onList: false, autoAdd: true, pending: true, categoryIds: [] });
        return;
      }
      if (at < 0) return;
      var p = list[at], n;
      if (o.op === 'adjust') n = copy(p, { qty: Math.max(0, p.qty + o.by), owned: true });
      else if (o.op === 'set') n = copy(p, { qty: o.qty, owned: true });
      else if (o.op === 'want') n = copy(p, { onList: o.on, inCart: false });
      else if (o.op === 'remove') { list.splice(at, 1); return; } else if (o.op === 'edit') {
        n = copy(p, {});
        if (o.location) n.location = o.location;
        if (typeof o.restockAt === 'number') n.restockAt = o.restockAt;
        if (typeof o.autoAdd === 'boolean') n.autoAdd = o.autoAdd;
        if (o.substitutionMode) n.mode = o.substitutionMode;
        if (typeof o.preferredStore === 'string') n.store = o.preferredStore;
        if (o.replacements) n.replacements = o.replacements.slice();
      } else return;
      n.low = isLow(n);
      list[at] = n;
    });
    return copy(data, { products: list });
  }

  var MAX_SUBS = 5;

  // Products that could stand in for p: not p, not already picked, sharing a
  // category first (then by name). q narrows by name or brand; with no q only
  // same-category ones are offered, so the list stays short.
  function subCandidates(products, p, picked, q) {
    var mine = p.categoryIds || [];
    function shares(x) { return (x.categoryIds || []).some(function (c) { return mine.indexOf(c) >= 0; }); }
    var out = (products || []).filter(function (x) {
      return x.id !== p.id && (picked || []).indexOf(x.id) < 0 && (fold(q) ? matches(x, q) : shares(x));
    });
    out.sort(function (a, b) {
      var sa = shares(a) ? 0 : 1, sb = shares(b) ? 0 : 1;
      return sa !== sb ? sa - sb : byName(a, b);
    });
    return out;
  }

  // A number typed in a box: null when empty, NaN when not a number in range.
  function readNumber(text, min, max, whole) {
    var t = String(text == null ? '' : text).replace(',', '.').replace(/^\s+|\s+$/g, '');
    if (!t) return null;
    var n = Number(t);
    if (!isFinite(n) || n < min || n > max || (whole && Math.floor(n) !== n)) return NaN;
    return n;
  }

  function amount(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return String(Math.round(n * 100) / 100);
  }

  var Logic = { PLACES: PLACES, MODES: MODES, UNITS: UNITS, fold: fold, matches: matches, subCandidates: subCandidates, MAX_SUBS: MAX_SUBS, stock: stock, usual: usual, counts: counts, applyLocal: applyLocal, readNumber: readNumber };
  root.HUB_PANTRY = Logic;
  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof document === 'undefined') return;

  /* ---------- the touch view ---------- */

  var SVG = 'http://www.w3.org/2000/svg';
  var PATHS = {
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    cross: 'M7 7l10 10M17 7L7 17',
    camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z M12 10a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z',
    cart: 'M3 4h2.2l2.2 10.5a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.2 M9.5 20.2a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6z M17 20.2a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6z',
    search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.5 15.5L20 20',
    barcode: 'M3 7V5.5A1.5 1.5 0 0 1 4.5 4H7 M17 4h2.5A1.5 1.5 0 0 1 21 5.5V7 M21 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17 M7 20H4.5A1.5 1.5 0 0 1 3 18.5V17 M7 8.5v7 M9.5 8.5v7 M12 8.5v7 M14 8.5v7 M17 8.5v7',
    bars: 'M5 6v12 M8 6v12 M10.5 6v12 M14 6v12 M16.5 6v12 M19 6v12',
    shelf: 'M4 4h16v16H4z M4 10h16 M4 15h16 M8 7h2 M13 12h3 M7 17.5h4',
    check: 'M5 12.5l4.2 4.2L19 7',
    up: 'M6 14l6-6 6 6',
    down: 'M6 10l6 6 6-6'
  };

  function icon(name, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'px-ic' + (cls ? ' ' + cls : ''));
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

  function btn(cls, text, ic) {
    var b = el('button', cls);
    b.type = 'button';
    if (ic) b.appendChild(icon(ic));
    if (text != null) b.appendChild(el('span', 'px-btn-word', text));
    return b;
  }

  var uid = 0;
  function newId(p) { uid += 1; return 'px-' + p + '-' + uid + '-' + Math.floor(Math.random() * 1e5); }

  function placeName(T, id) {
    var en = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry', other: 'Other' };
    return T('pantry.place.' + id, en[id] || id);
  }
  function modeName(T, id) {
    var en = { similar: 'Something similar', preselected: 'My picks', refund: 'Refund it', contact_me: 'Ask me' };
    return T('pantry.mode.' + id, en[id] || id);
  }
  function unitName(T, id) {
    var en = { oz: 'oz', fl_oz: 'fl oz', lb: 'lb', g: 'g', kg: 'kg', ml: 'ml', l: 'L', gal: 'gal', count: 'count', pack: 'pack' };
    return T('pantry.unit.' + id, en[id] || id);
  }
  function categoryName(T, c) {
    return SEEDED[c.key] ? T('pantry.cat.' + c.key.replace(/ /g, '_'), c.name) : c.name;
  }

  // The pantry this page saw last, for the scan card's note from another view.
  var lastData = null;

  function storeGet(k) { try { return root.localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function storeSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* no storage */ } }

  function renderTouch(host, ctx) {
    var T = ctx.t;
    var view = el('div', 'px');
    host.appendChild(view);
    var tab = storeGet('homeHub.pantry.tab') === 'usual' ? 'usual' : 'stock';
    var place = '';
    var query = '';
    var failMsg = '';

    // Attribute first: the low count leads.
    var head = el('div', 'px-head');
    var lead = el('div', 'px-lead');
    var big = el('span', 'px-big');
    var bigWord = el('span', 'px-big-word');
    lead.appendChild(big);
    lead.appendChild(bigWord);
    var total = el('span', 'px-total');
    head.appendChild(lead);
    head.appendChild(total);
    view.appendChild(head);

    // Stock | Usual items
    var seg = el('div', 'px-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', T('pantry.viewLabel', 'Show'));
    var segStock = btn('px-seg-btn', T('pantry.stock', 'Stock'));
    var segUsual = btn('px-seg-btn', T('pantry.usual', 'Usual items'));
    segStock.addEventListener('click', function () { setTab('stock'); });
    segUsual.addEventListener('click', function () { setTab('usual'); });
    seg.appendChild(segStock);
    seg.appendChild(segUsual);
    view.appendChild(seg);

    // Search (Usual items only).
    var searchBox = el('div', 'px-search');
    var searchId = newId('search');
    var searchLabel = el('label', 'px-sr', T('pantry.search', 'Search usual items'));
    searchLabel.setAttribute('for', searchId);
    var searchIn = el('input', 'px-input px-search-input');
    searchIn.id = searchId;
    searchIn.type = 'search';
    searchIn.setAttribute('autocomplete', 'off');
    searchIn.setAttribute('enterkeyhint', 'search');
    searchIn.placeholder = T('pantry.searchPlaceholder', 'Search by name or brand');
    searchBox.appendChild(icon('search', 'px-search-ic'));
    searchBox.appendChild(searchLabel);
    searchBox.appendChild(searchIn);
    searchIn.addEventListener('input', function () { query = searchIn.value; render(); });
    view.appendChild(searchBox);

    // Place chips (wrap to a second row; no fixed widths).
    var chips = el('div', 'px-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', T('pantry.placeLabel', 'Place'));
    view.appendChild(chips);

    // Add an item: type a name, or scan.
    var form = el('form', 'px-add');
    form.setAttribute('autocomplete', 'off');
    var addId = newId('add');
    var addLabel = el('label', 'px-sr', T('pantry.addLabel', 'Add to the pantry'));
    addLabel.setAttribute('for', addId);
    var addIn = el('input', 'px-input');
    addIn.id = addId;
    addIn.type = 'text';
    addIn.setAttribute('enterkeyhint', 'done');
    addIn.setAttribute('autocapitalize', 'sentences');
    addIn.setAttribute('maxlength', '80');
    addIn.placeholder = T('pantry.addPlaceholder', 'Add an item');
    form.appendChild(addLabel);
    form.appendChild(addIn);
    var scanBtn = null;
    if (root.HUB_SCAN && ctx.call) {
      scanBtn = btn('px-scan', T('pantry.scan', 'Scan'), 'barcode');
      scanBtn.setAttribute('aria-label', T('pantry.scanLabel', 'Scan a barcode'));
      scanBtn.addEventListener('click', function () {
        root.HUB_SCAN.open(ctx, { destination: 'pantry', destinations: ['pantry', 'grocery'], returnFocus: scanBtn });
      });
      form.appendChild(scanBtn);
    }
    var addBtn = el('button', 'px-add-btn');
    addBtn.type = 'submit';
    addBtn.appendChild(icon('plus'));
    addBtn.appendChild(el('span', 'px-btn-word', T('pantry.addButton', 'Add')));
    form.appendChild(addBtn);
    view.appendChild(form);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = addIn.value.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      if (!name) return;
      addIn.value = '';
      send([{ op: 'add', name: name, qty: 1, location: place || 'pantry' }]);
    });

    var banner = el('p', 'px-banner');
    banner.setAttribute('role', 'status');
    view.appendChild(banner);

    var list = el('ul', 'px-list');
    view.appendChild(list);
    var empty = el('div', 'px-empty');
    view.appendChild(empty);

    // One toast at a time, after the list pill or its Undo: says what changed.
    var toast = el('div', 'px-toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    var toastText = el('span', 'px-toast-text');
    var undoBtn = el('button', 'px-undo', T('pantry.undo', 'Undo'));
    undoBtn.type = 'button';
    toast.appendChild(toastText);
    toast.appendChild(undoBtn);
    view.appendChild(toast);
    var toastTimer = null, lastWant = null;

    function data() { var d = ctx.data(); if (d) lastData = d; return d; }
    function products() { var d = data(); return d && d.products ? d.products : []; }
    function productById(id) { var l = products(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }

    function send(ops) {
      failMsg = '';
      ctx.send(ops, applyLocal(data(), ops), function (err) {
        if (err) { hideToast(); failMsg = T('pantry.saveFailed', 'That didn’t save: {why}', { why: err }); render(); }
      });
    }

    // Put on or take off the grocery list, then say so with an Undo.
    function want(id, name, on) {
      send([{ op: 'want', id: id, on: on }]);
      lastWant = { id: id, name: name, on: on };
      toastText.textContent = on ? T('pantry.toastOn', '{name} put on the list', { name: name }) : T('pantry.toastOff', '{name} taken off the list', { name: name });
      toast.className = 'px-toast is-on' + (ctx.reduced && ctx.reduced() ? ' is-calm' : '');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 5000);
    }
    function hideToast() {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = null;
      lastWant = null;
      toast.className = toast.className.replace(/ ?\bis-on\b/g, '');
    }
    undoBtn.addEventListener('click', function () {
      var w = lastWant;
      if (w) want(w.id, w.name, !w.on);
    });

    function setTab(t) {
      tab = t;
      storeSet('homeHub.pantry.tab', t);
      render();
    }

    function paintChips() {
      chips.innerHTML = '';
      [''].concat(PLACES).forEach(function (id) {
        var b = btn('px-chip' + (place === id ? ' is-on' : ''), id ? placeName(T, id) : T('pantry.all', 'All'));
        b.setAttribute('aria-pressed', place === id ? 'true' : 'false');
        b.addEventListener('click', function () { place = id; render(); });
        chips.appendChild(b);
      });
    }

    function thumb(p) {
      var th = el('span', 'px-thumb');
      if (p.photo) {
        var img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = function () { th.innerHTML = ''; th.className = 'px-thumb is-none'; th.appendChild(icon('shelf')); };
        img.src = p.photo;
        th.appendChild(img);
      } else {
        th.className = 'px-thumb is-none';
        th.appendChild(icon(p.upc ? 'bars' : 'shelf'));
      }
      return th;
    }

    function row(p) {
      var li = el('li', 'px-row' + (p.low ? ' is-low' : '') + (p.pending ? ' is-pending' : '') + (p.owned ? '' : ' is-out'));
      li.setAttribute('data-id', String(p.id));
      var open = el('button', 'px-open');
      open.type = 'button';
      open.setAttribute('aria-label', T('pantry.edit', 'Edit {name}', { name: p.name }));
      open.appendChild(thumb(p));
      var text = el('span', 'px-text');
      if (p.brand) text.appendChild(el('span', 'px-brand', p.brand));
      text.appendChild(el('span', 'px-name', p.name));
      open.appendChild(text);
      if (p.pending) open.disabled = true;
      open.addEventListener('click', function () { openSheet(p.id, open); });
      li.appendChild(open);

      var meta = el('div', 'px-meta');
      if (p.low) meta.appendChild(el('span', 'px-badge', T('pantry.lowAt', 'Low · buy at {n}', { n: amount(p.restockAt) })));
      else if (p.owned) meta.appendChild(el('span', 'px-at', T('pantry.buyAt', 'Buy at {n}', { n: amount(p.restockAt) })));
      else meta.appendChild(el('span', 'px-at', T('pantry.notHere', 'Not at home')));
      if (p.onList && p.listSource === 'auto') meta.appendChild(el('span', 'px-badge px-auto', T('pantry.autoAdded', 'Added to list for you')));
      if (!place && p.owned) meta.appendChild(el('span', 'px-where', placeName(T, p.location)));
      if (p.store) meta.appendChild(el('span', 'px-where px-store', p.store));
      li.appendChild(meta);

      var ctl = el('div', 'px-ctl');
      var step = el('div', 'px-step');
      step.setAttribute('role', 'group');
      step.setAttribute('aria-label', T('pantry.howMany', 'How many {name}', { name: p.name }));
      var minus = btn('px-step-btn', null, 'minus');
      minus.setAttribute('aria-label', T('pantry.less', 'One less'));
      minus.disabled = !!p.pending || !p.owned || p.qty <= 0;
      minus.addEventListener('click', function () { send([{ op: 'adjust', id: p.id, by: -1 }]); });
      var qty = el('span', 'px-qty', p.owned ? amount(p.qty) : '0');
      qty.setAttribute('aria-live', 'polite');
      var plus = btn('px-step-btn', null, 'plus');
      plus.setAttribute('aria-label', T('pantry.more', 'One more'));
      plus.disabled = !!p.pending;
      plus.addEventListener('click', function () { send([{ op: 'adjust', id: p.id, by: 1 }]); });
      step.appendChild(minus);
      step.appendChild(qty);
      step.appendChild(plus);
      ctl.appendChild(step);
      var cart = btn('px-cart' + (p.onList ? ' is-on' : ''), p.onList ? T('pantry.listOn', 'On list') : T('pantry.listAdd', 'Add to list'), p.onList ? 'check' : 'plus');
      cart.setAttribute('aria-pressed', p.onList ? 'true' : 'false');
      cart.setAttribute('aria-label', p.onList ? T('pantry.cartOff', 'On list: {name}. Tap to take it off the grocery list', { name: p.name }) : T('pantry.cartOn', 'Add to list: {name}. Tap to put it on the grocery list', { name: p.name }));
      cart.disabled = !!p.pending;
      cart.addEventListener('click', function () { want(p.id, p.name, !p.onList); });
      ctl.appendChild(cart);
      li.appendChild(ctl);
      return li;
    }

    function render() {
      var st = ctx.status();
      var d = data();
      var all = products();
      var c = counts(d);
      big.textContent = d ? String(c.low) : '–';
      bigWord.textContent = T('pantry.lowWord', 'low');
      total.textContent = d ? T('pantry.total', '{n} at home', { n: c.items }) : '';
      segStock.setAttribute('aria-pressed', tab === 'stock' ? 'true' : 'false');
      segUsual.setAttribute('aria-pressed', tab === 'usual' ? 'true' : 'false');
      segStock.className = 'px-seg-btn' + (tab === 'stock' ? ' is-on' : '');
      segUsual.className = 'px-seg-btn' + (tab === 'usual' ? ' is-on' : '');
      searchBox.style.display = tab === 'usual' ? '' : 'none';
      paintChips();

      var msg = failMsg || (st === 'offline' ? T('pantry.offline', 'Can’t reach the hub. Showing the last copy; changes won’t save.') : '');
      banner.textContent = msg;
      banner.className = 'px-banner' + (msg ? ' is-on' : '');
      view.className = 'px' + (st === 'offline' ? ' is-offline' : '');

      var shown = tab === 'usual' ? usual(all, place, query) : stock(all, place);
      list.innerHTML = '';
      shown.forEach(function (p) { list.appendChild(row(p)); });
      empty.innerHTML = '';
      if (!d) {
        empty.appendChild(el('p', 'px-empty-text', st === 'offline' ? '' : T('pantry.loading', 'Loading the pantry…')));
      } else if (!shown.length) {
        empty.appendChild(icon('shelf', 'px-empty-ic'));
        if (tab === 'usual' && fold(query)) {
          empty.appendChild(el('p', 'px-empty-title', T('pantry.noMatch', 'Nothing matches')));
        } else {
          empty.appendChild(el('p', 'px-empty-title', place ? T('pantry.emptyPlace', 'Nothing here yet') : T('pantry.emptyTitle', 'Nothing in the pantry yet')));
          empty.appendChild(el('p', 'px-empty-text', T('pantry.emptyText', 'Scan or type what you keep at home. When something runs low, it goes on the grocery list.')));
        }
      }
      empty.style.display = empty.childNodes.length ? '' : 'none';
      if (sheet) sheet.refresh();
    }

    /* --- the bottom sheet: one product's settings --- */

    var sheet = null;

    function openSheet(id, from) {
      if (sheet) sheet.close();
      var p0 = productById(id);
      if (!p0) return;
      var d0 = data() || {};
      var draft = {
        store: p0.store || '',
        location: p0.location, restockAt: amount(p0.restockAt), buy: String(p0.buy || 1), autoAdd: p0.autoAdd !== false,
        mode: p0.mode || 'similar', size: p0.size == null ? '' : String(p0.size), unit: p0.unit || '',
        brand: p0.brandId ? { id: p0.brandId, name: p0.brand } : null,
        category: null,
        subs: (p0.replacements || []).slice(0, MAX_SUBS)
      };
      (d0.categories || []).forEach(function (c) { if (!draft.category && (p0.categoryIds || []).indexOf(c.id) >= 0) draft.category = { id: c.id, name: categoryName(T, c) }; });

      var scrim = el('div', 'px-scrim');
      var box = el('section', 'px-sheet');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      var titleId = newId('title');
      box.setAttribute('aria-labelledby', titleId);
      var top = el('header', 'px-sheet-head');
      var tt = el('div', 'px-sheet-titles');
      if (p0.brand) tt.appendChild(el('p', 'px-brand', p0.brand));
      var h = el('h2', 'px-sheet-title', p0.name);
      h.id = titleId;
      tt.appendChild(h);
      top.appendChild(tt);
      var x = btn('px-round', null, 'cross');
      x.setAttribute('aria-label', T('pantry.close', 'Close'));
      top.appendChild(x);
      box.appendChild(top);

      var bodyEl = el('div', 'px-sheet-body');
      box.appendChild(bodyEl);

      function fieldHead(text, forId) {
        var l = el(forId ? 'label' : 'p', 'px-field-label', text);
        if (forId) l.setAttribute('for', forId);
        return l;
      }

      // Place
      var placeWrap = el('div', 'px-field');
      placeWrap.appendChild(fieldHead(T('pantry.placeLabel', 'Place')));
      var placeChips = el('div', 'px-chips');
      placeChips.setAttribute('role', 'group');
      function paintPlaces() {
        placeChips.innerHTML = '';
        PLACES.forEach(function (id) {
          var b = btn('px-chip' + (draft.location === id ? ' is-on' : ''), placeName(T, id));
          b.setAttribute('aria-pressed', draft.location === id ? 'true' : 'false');
          b.addEventListener('click', function () { draft.location = id; paintPlaces(); });
          placeChips.appendChild(b);
        });
      }
      paintPlaces();
      placeWrap.appendChild(placeChips);
      bodyEl.appendChild(placeWrap);

      // Numbers: buy more at, how many to buy.
      function numberField(labelText, hint, value, min, max, whole, cls) {
        var w = el('div', 'px-field ' + cls);
        var id = newId('n');
        w.appendChild(fieldHead(labelText, id));
        var inp = el('input', 'px-input px-num');
        inp.id = id;
        inp.type = 'number';
        inp.min = String(min);
        inp.max = String(max);
        inp.step = whole ? '1' : 'any';
        inp.setAttribute('inputmode', whole ? 'numeric' : 'decimal');
        inp.value = value;
        w.appendChild(inp);
        if (hint) w.appendChild(el('p', 'px-hint', hint));
        var err = el('p', 'px-error');
        err.setAttribute('aria-live', 'polite');
        w.appendChild(err);
        return { wrap: w, input: inp, err: err, min: min, max: max, whole: whole };
      }
      var nums = el('div', 'px-pair');
      var fRestock = numberField(T('pantry.restockAt', 'Buy more when I have'), T('pantry.restockHint', 'At this many or fewer it shows Low.'), draft.restockAt, 0, 999, true, 'px-restock');
      var fBuy = numberField(T('pantry.buyQty', 'How many to buy'), '', draft.buy, 1, 99, true, 'px-buy');
      nums.appendChild(fRestock.wrap);
      nums.appendChild(fBuy.wrap);
      bodyEl.appendChild(nums);

      // Auto-add switch.
      var sw = el('div', 'px-field px-switch-row');
      var swId = newId('sw');
      var swText = el('span', 'px-switch-text');
      var swLabel = el('span', 'px-field-label', T('pantry.autoAdd', 'Add to groceries automatically'));
      swLabel.id = swId;
      swText.appendChild(swLabel);
      swText.appendChild(el('span', 'px-hint', T('pantry.autoHint', 'When it gets low, once.')));
      sw.appendChild(swText);
      var swBtn = el('button', 'px-switch');
      swBtn.type = 'button';
      swBtn.setAttribute('role', 'switch');
      swBtn.setAttribute('aria-labelledby', swId);
      swBtn.appendChild(el('span', 'px-switch-knob'));
      function paintSwitch() { swBtn.setAttribute('aria-checked', draft.autoAdd ? 'true' : 'false'); swBtn.className = 'px-switch' + (draft.autoAdd ? ' is-on' : ''); }
      paintSwitch();
      swBtn.addEventListener('click', function () { draft.autoAdd = !draft.autoAdd; paintSwitch(); });
      sw.appendChild(swBtn);
      bodyEl.appendChild(sw);

      // Substitution: a select (fixed choices).
      function selectField(labelText, options, value, cls) {
        var w = el('div', 'px-field ' + cls);
        var id = newId('s');
        w.appendChild(fieldHead(labelText, id));
        var sel = el('select', 'px-input px-select');
        sel.id = id;
        options.forEach(function (o) {
          var op = el('option', '', o[1]);
          op.value = o[0];
          if (o[0] === value) op.selected = true;
          sel.appendChild(op);
        });
        w.appendChild(sel);
        return { wrap: w, select: sel };
      }
      var fMode = selectField(T('pantry.modeLabel', 'If it is out'), MODES.map(function (m) { return [m, modeName(T, m)]; }), draft.mode, 'px-mode');
      bodyEl.appendChild(fMode.wrap);

      // Preferred store: where to get it (Tom Thumb, CVS); stores already used are suggested.
      var storeWrap = el('div', 'px-field px-storefield');
      var storeId = newId('st');
      storeWrap.appendChild(fieldHead(T('pantry.storeLabel', 'Preferred store'), storeId));
      var storeIn = el('input', 'px-input px-store-in');
      storeIn.id = storeId;
      storeIn.type = 'text';
      storeIn.setAttribute('maxlength', '40');
      storeIn.setAttribute('autocapitalize', 'words');
      storeIn.placeholder = T('pantry.storePlaceholder', 'e.g. Tom Thumb, CVS');
      storeIn.value = draft.store;
      var listId = storeId + '-list';
      storeIn.setAttribute('list', listId);
      var dl = el('datalist');
      dl.id = listId;
      var seenStore = {};
      ((d0.products || [])).forEach(function (x) { if (x.store && !seenStore[x.store]) { seenStore[x.store] = 1; var o = el('option'); o.value = x.store; dl.appendChild(o); } });
      storeWrap.appendChild(storeIn);
      storeWrap.appendChild(dl);
      bodyEl.appendChild(storeWrap);

      // My picks: up to five other products, in the order to try them.
      var subsWrap = el('div', 'px-field px-subs');
      var subsId = newId('subs');
      subsWrap.appendChild(fieldHead(T('pantry.subsLabel', 'My picks, in order'), subsId));
      var subsList = el('ol', 'px-sublist');
      subsList.id = subsId;
      subsWrap.appendChild(subsList);
      var subsFind = el('input', 'px-input');
      subsFind.type = 'text';
      subsFind.setAttribute('autocomplete', 'off');
      subsFind.setAttribute('maxlength', '40');
      subsFind.setAttribute('aria-label', T('pantry.subsFind', 'Find a product to add'));
      subsFind.placeholder = T('pantry.subsFind', 'Find a product to add');
      subsWrap.appendChild(subsFind);
      var subsOpts = el('div', 'px-options');
      subsWrap.appendChild(subsOpts);
      subsWrap.appendChild(el('p', 'px-hint', T('pantry.subsHint', 'Up to {n}. The store tries them from the top.', { n: MAX_SUBS })));
      function subName(pid) {
        var q = productById(pid);
        return q ? (q.brand ? q.brand + ' ' : '') + q.name : T('pantry.subGone', 'A product no longer in the pantry');
      }
      function paintSubs() {
        subsWrap.style.display = fMode.select.value === 'preselected' ? '' : 'none';
        subsList.innerHTML = '';
        draft.subs.forEach(function (pid, i) {
          var li = el('li', 'px-subrow');
          li.appendChild(el('span', 'px-subnum', String(i + 1)));
          li.appendChild(el('span', 'px-subname', subName(pid)));
          function tool(label, ic, fn, off) {
            var b = btn('px-round px-subtool', null, ic);
            b.setAttribute('aria-label', label);
            if (off) b.disabled = true;
            b.addEventListener('click', fn);
            li.appendChild(b);
          }
          tool(T('pantry.subUp', 'Move up'), 'up', function () { draft.subs.splice(i - 1, 0, draft.subs.splice(i, 1)[0]); paintSubs(); }, i === 0);
          tool(T('pantry.subDown', 'Move down'), 'down', function () { draft.subs.splice(i + 1, 0, draft.subs.splice(i, 1)[0]); paintSubs(); }, i === draft.subs.length - 1);
          tool(T('pantry.subRemove', 'Remove'), 'cross', function () { draft.subs.splice(i, 1); paintSubs(); });
          subsList.appendChild(li);
        });
        subsOpts.innerHTML = '';
        if (draft.subs.length >= MAX_SUBS) return;
        var q = subsFind.value.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        subCandidates(products(), p0, draft.subs, q).slice(0, 6).forEach(function (x) {
          var b = btn('px-option', (x.brand ? x.brand + ' ' : '') + x.name, 'plus');
          b.addEventListener('click', function () { draft.subs.push(x.id); subsFind.value = ''; paintSubs(); });
          subsOpts.appendChild(b);
        });
      }
      subsFind.addEventListener('input', paintSubs);
      fMode.select.addEventListener('change', paintSubs);
      bodyEl.appendChild(subsWrap);
      paintSubs();

      // Brand and category: pick one of the Pi's, or create one (never a second spelling).
      function picker(kind, labelText, listFn, nameFn, current) {
        var w = el('div', 'px-field px-picker px-picker-' + kind);
        var id = newId('p');
        w.appendChild(fieldHead(labelText, id));
        var cur = el('div', 'px-picked');
        w.appendChild(cur);
        var inp = el('input', 'px-input');
        inp.id = id;
        inp.type = 'text';
        inp.setAttribute('autocomplete', 'off');
        inp.setAttribute('maxlength', '40');
        inp.placeholder = kind === 'brand' ? T('pantry.brandFind', 'Find or add a brand') : T('pantry.categoryFind', 'Find or add a category');
        w.appendChild(inp);
        var opts = el('div', 'px-options');
        w.appendChild(opts);
        var state = { value: current };
        function paint() {
          cur.innerHTML = '';
          cur.appendChild(el('span', 'px-picked-name' + (state.value ? '' : ' is-none'), state.value ? state.value.name : T('pantry.none', 'None')));
          if (state.value && state.value.isNew) cur.appendChild(el('span', 'px-new', T('pantry.newTag', 'new')));
          if (state.value) {
            var clr = btn('px-link', T('pantry.clear', 'Clear'));
            clr.addEventListener('click', function () { state.value = null; paint(); });
            cur.appendChild(clr);
          }
          opts.innerHTML = '';
          var q = inp.value.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
          var k = fold(q);
          if (!k) return;
          var exact = null;
          var hits = listFn().filter(function (x) {
            var nk = fold(nameFn(x));
            if (fold(x.name) === k || nk === k) exact = x;
            return nk.indexOf(k) >= 0 || fold(x.name).indexOf(k) >= 0;
          }).slice(0, 6);
          hits.forEach(function (x) {
            var b = btn('px-option', nameFn(x));
            b.addEventListener('click', function () { state.value = { id: x.id, name: nameFn(x) }; inp.value = ''; paint(); });
            opts.appendChild(b);
          });
          if (!exact) {
            var add = btn('px-option is-add', T('pantry.create', 'Add “{name}”', { name: q }), 'plus');
            add.addEventListener('click', function () { state.value = { name: q, isNew: true }; inp.value = ''; paint(); });
            opts.appendChild(add);
          }
        }
        inp.addEventListener('input', paint);
        paint();
        return { wrap: w, state: state };
      }
      var pBrand = picker('brand', T('pantry.brand', 'Brand'), function () { return (data() || {}).brands || []; }, function (b) { return b.name; }, draft.brand);
      var pCat = picker('category', T('pantry.category', 'Category'), function () { return (data() || {}).categories || []; }, function (c) { return categoryName(T, c); }, draft.category);
      bodyEl.appendChild(pBrand.wrap);
      bodyEl.appendChild(pCat.wrap);

      // Size: a number and a unit.
      var sizeRow = el('div', 'px-pair');
      var fSize = numberField(T('pantry.size', 'Size'), '', draft.size, 0, 100000, false, 'px-size');
      var fUnit = selectField(T('pantry.unit', 'Unit'), [['', T('pantry.unitNone', '—')]].concat(UNITS.map(function (u) { return [u, unitName(T, u)]; })), draft.unit, 'px-unit');
      sizeRow.appendChild(fSize.wrap);
      sizeRow.appendChild(fUnit.wrap);
      bodyEl.appendChild(sizeRow);

      var foot = el('div', 'px-sheet-foot');
      var save = btn('px-btn px-primary', T('pantry.save', 'Save'));
      var del = btn('px-btn px-danger', T('pantry.removeItem', 'Remove from the pantry'));
      foot.appendChild(save);
      if (p0.owned) foot.appendChild(del);
      box.appendChild(foot);

      function check(f) {
        var n = readNumber(f.input.value, f.min, f.max, f.whole);
        var bad = n !== n; // NaN
        f.err.textContent = bad ? (f.whole ? T('pantry.wholeRange', 'Use a whole number from {min} to {max}', { min: f.min, max: f.max }) : T('pantry.numRange', 'Use a number from {min} to {max}', { min: f.min, max: f.max })) : '';
        f.wrap.className = f.wrap.className.replace(/ ?is-bad/g, '') + (bad ? ' is-bad' : '');
        return bad ? undefined : n;
      }

      save.addEventListener('click', function () {
        var restock = check(fRestock), buy = check(fBuy), size = check(fSize);
        if (restock === undefined || buy === undefined || size === undefined) return;
        var p = productById(id) || p0;
        var op = { op: 'edit', id: id };
        if (draft.location !== p.location) op.location = draft.location;
        if (restock !== null && restock !== p.restockAt) op.restockAt = restock;
        if (buy !== null && buy !== p.buy) op.purchaseQuantity = buy;
        if (draft.autoAdd !== p.autoAdd) op.autoAdd = draft.autoAdd;
        var store = storeIn.value.replace(/\s+/g, ' ').replace(/^ | $/g, '');
        if (store !== (p.store || '')) op.preferredStore = store;
        if (fMode.select.value !== p.mode) op.substitutionMode = fMode.select.value;
        var was = (p.replacements || []).join(',');
        if (fMode.select.value === 'preselected' && draft.subs.join(',') !== was) op.replacements = draft.subs.slice();
        var unit = fUnit.select.value || null;
        if ((size === null ? null : size) !== (p.size == null ? null : p.size)) op.size = size === 0 ? null : size;
        if (unit !== (p.unit || null)) op.unit = unit;
        var b = pBrand.state.value;
        if (!b && p.brandId) op.brandId = null;
        else if (b && b.isNew) op.brand = b.name;
        else if (b && b.id !== p.brandId) op.brandId = b.id;
        var c = pCat.state.value;
        var had = (p.categoryIds || [])[0] || null;
        if (!c && had) op.categoryIds = [];
        else if (c && c.isNew) op.category = c.name;
        else if (c && c.id !== had) op.categoryIds = [c.id];
        if (Object.keys(op).length > 2) send([op]);
        close();
      });
      del.addEventListener('click', function () { send([{ op: 'remove', id: id }]); close(); });
      x.addEventListener('click', function () { close(); });
      scrim.addEventListener('click', function () { close(); });
      function onKey(e) { if (e.key === 'Escape' || e.keyCode === 27) close(); }
      document.addEventListener('keydown', onKey);

      document.body.appendChild(scrim);
      document.body.appendChild(box);
      document.body.className += ' px-open';
      box.getBoundingClientRect();
      scrim.className = 'px-scrim is-on';
      box.className = 'px-sheet is-on' + (ctx.reduced && ctx.reduced() ? ' is-calm' : '');
      x.focus();

      var closed = false;
      function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        document.body.className = document.body.className.replace(/ ?\bpx-open\b/g, '');
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        if (box.parentNode) box.parentNode.removeChild(box);
        if (sheet && sheet.box === box) sheet = null;
        if (from && from.focus) { try { from.focus(); } catch (e) { /* gone */ } }
      }
      sheet = {
        box: box,
        close: close,
        // The product went away (removed elsewhere): the sheet closes.
        refresh: function () { if (!productById(id)) close(); }
      };
    }

    render();
    return {
      update: render,
      destroy: function () {
        if (sheet) sheet.close();
        if (toastTimer) clearTimeout(toastTimer);
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  // The menu's line: '4 low' or '41 at home'.
  function summary(data, t) {
    if (!data || !data.products) return '';
    var c = counts(data);
    return c.low ? t('pantry.summaryLow', '{n} low', { n: c.low }) : t('pantry.total', '{n} at home', { n: c.items });
  }

  // The pantry row for a scanned product when it is at home (owned), else null.
  function homeHit(product, ctx) {
    var d = ctx.id === 'pantry' && ctx.data ? ctx.data() : (ctx.peek ? ctx.peek('pantry') : null) || lastData;
    var list = d && d.products ? d.products : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].upc === product.upc && list[i].owned) return list[i];
    }
    return null;
  }

  // Where a scan can go (app/scan.js): into the pantry, one more of it.
  if (root.HUB_SCAN) {
    root.HUB_SCAN.register('pantry', {
      label: function (t) { return t('pantry.destLabel', 'Pantry'); },
      chip: function (t) { return t('pantry.destChip', 'Pantry'); },
      note: function (product, ctx, t) {
        var hit = homeHit(product, ctx);
        return hit ? t('pantry.scanHave', 'At home: {n}. Adding counts one more.', { n: amount(hit.qty) }) : '';
      },
      // Pasting a list skips what is at home already.
      has: function (product, ctx) { return !!homeHit(product, ctx); },
      add: function (product, ctx, done) {
        var ops = [{ op: 'add', upc: product.upc, qty: 1 }];
        if (ctx.id === 'pantry') {
          ctx.send(ops, applyLocal(ctx.data(), ops), done);
          return;
        }
        ctx.call('POST', '/pantry/ops', { ops: ops }).then(function () {
          if (ctx.refresh) ctx.refresh();
          done(null);
        }, function (e) { done(e && e.message ? e.message : 'error'); });
      }
    });
  }

  var widget = { id: 'pantry', titleKey: 'pantry.title', title: 'Pantry', touchIcon: PATHS.shelf, resource: 'pantry', summary: summary, renderTouch: renderTouch };
  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push(widget);
})(typeof window !== 'undefined' ? window : this);
