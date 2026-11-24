/*
 * Pantry and List: two TV widgets over the pantry on the Pi (pi/pantrydb.js,
 * SQLite). Both share this file and app/widgets/pantry-tv.css. The phone's
 * pantry view is a different file (app/widgets/pantry.js, window.HUB_PANTRY);
 * hub.html loads only this one, touch.html only that one, so the widget id
 * 'pantry' is never registered twice on one page.
 *
 *   pantry   the products owned and not archived. 0 left = out (an "Out"
 *            chip), at or under the restock point = low.
 *   list     the open list (product, quantity, Auto when the pantry added
 *            it): to get first, then ticked rows, dimmed, under In the cart.
 *
 * In full screen, OK on a pantry row opens that product's page: brand, name,
 * size, unit, remaining, restock point, how many to buy, auto-add,
 * substitution, where it lives and notes, each editable with the remote
 * (number boxes with - and + beside them, choice pills, text boxes). Changes
 * save as they are made. Back closes the page and focus goes back to the row.
 * OK on a row in the small panel switches to full screen and opens the page.
 * A List row is two stops: the row itself (OK ticks or unticks it, the
 * Pi's op "check") and a Details button on its right (OK opens the page).
 *
 *   tile, 1 column  pantry: the out count; list: the count still to get
 *   tile, strip     "3 out · 2 low" / "8 to buy · Whole milk"
 *   tile, 2+ rows   the count big, then the first rows that fit, "+N more"
 *   panel           rows grouped (pantry: Out, Low, In stock; list: To get,
 *                   In the cart). Under the tip, filter chips (panel and
 *                   full screen only, never the tile): Pantry has Place
 *                   (when two or more are in use) and Store, List has Store.
 *                   One pick per row, All clears it; they reset on close.
 *                   Each row's meta ends with its preferred store.
 *
 * DATA: HUB_PANTRY_TV.api below is the one place that knows where the data
 * comes from: the live resource "pantry" (ctx.live.get / on) and POST
 * /pantry/screen-ops (ctx.live.post) for edits and ticks. A change shows at
 * once; the Pi's answer replaces it, a refusal takes it back with a toast.
 * Tests stub the live line with dev/pantry-tv-live-stub.js.
 *
 * Product and brand names are data, never translated and never logged.
 * Plain ES5: the TV's browser is Chromium 63 class.
 */
(function (root) {
  'use strict';

  var UNITS = ['oz', 'fl_oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'count', 'pack'];
  var MODES = ['similar', 'preselected', 'refund', 'contact_me'];
  var LOCATIONS = ['fridge', 'freezer', 'pantry', 'bathroom', 'other'];

  function has(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i] === v) return true;
    return false;
  }

  // The brands table's key: lowercase, accents and punctuation stripped, so
  // "Heinz" and "heinz" are one brand (as the Pi's brands.key).
  function brandKey(name) {
    var s = String(name == null ? '' : name);
    try { if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engine */ }
    return s.toLowerCase().replace(/[^a-z0-9\s]+/g, '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function copy(o, over) {
    var out = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    return out;
  }

  /* ---------- pure logic (Node can require it) ---------- */

  // 'out' | 'low' | 'ok' | 'new' (never owned).
  function stateOf(p) {
    if (!p.owned) return 'new';
    var q = Number(p.quantity_remaining) || 0;
    if (q <= 0) return 'out';
    if (q <= (Number(p.restock_at) || 0)) return 'low';
    return 'ok';
  }

  // The pantry: owned, not archived. Out first, then low, then by name.
  var RANK = { out: 0, low: 1, ok: 2, 'new': 3 };
  function pantryOf(products) {
    var out = [];
    for (var i = 0; i < products.length; i++) if (products[i].owned && !products[i].archived) out.push(products[i]);
    out.sort(function (a, b) {
      var r = RANK[stateOf(a)] - RANK[stateOf(b)];
      if (r) return r;
      return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
    });
    return out;
  }

  function pantryCounts(products) {
    var p = pantryOf(products), c = { total: p.length, out: 0, low: 0 };
    for (var i = 0; i < p.length; i++) {
      var s = stateOf(p[i]);
      if (s === 'out') c.out++;
      else if (s === 'low') c.low++;
    }
    return c;
  }

  // One field from the product page, checked and typed: { value } or { error }.
  // error is an i18n key's tail (pantry.err.<error>).
  function clean(field, raw) {
    var s = typeof raw === 'string' ? raw.replace(/^\s+|\s+$/g, '') : raw;
    var n;
    switch (field) {
      case 'name':
        s = String(s || '').replace(/\s+/g, ' ');
        if (!s) return { error: 'name' };
        return s.length > 80 ? { error: 'long' } : { value: s };
      case 'brand':
        s = String(s || '').replace(/\s+/g, ' ');
        return s.length > 40 ? { error: 'long' } : { value: s };
      case 'notes':
        s = String(s || '').replace(/\s+/g, ' ');
        return s.length > 200 ? { error: 'long' } : { value: s };
      case 'size':
        if (s === '' || s === null) return { value: null };
        n = Number(s);
        return isFinite(n) && n >= 0.01 && n < 100000 ? { value: Math.round(n * 100) / 100 } : { error: 'number' };
      // Whole numbers on the Pi (pantrydb.js): 0 to 9999 left, restock at 0 to 999.
      case 'quantity_remaining':
      case 'restock_at':
        n = Number(s);
        return s !== '' && isFinite(n) && n >= 0 && n <= (field === 'restock_at' ? 999 : 9999) && Math.floor(n) === n ? { value: n } : { error: 'whole0' };
      case 'purchase_quantity':
        n = Number(s);
        return s !== '' && isFinite(n) && n >= 1 && n <= 99 && Math.floor(n) === n ? { value: n } : { error: 'whole' };
      case 'unit': return has(UNITS, s) ? { value: s } : { error: 'choice' };
      case 'substitution_mode': return has(MODES, s) ? { value: s } : { error: 'choice' };
      case 'location': return has(LOCATIONS, s) ? { value: s } : { error: 'choice' };
      case 'auto_add': return { value: s === true || s === 1 || s === '1' || s === 'on' ? 1 : 0 };
    }
    return { error: 'field' };
  }

  /* ---------- the data: the Pi's live resource "pantry" ---------- */

  // The Pi (pi/pantrydb.js view(), resource "pantry" over the live line)
  // sends { products: [{ id, name, brand, brandId, size, unit, notes, qty,
  // restockAt, buy, autoAdd, mode, location, owned, low, onList, listItemId,
  // checked, ... }], brands, categories, list: [{ id, productId, quantity,
  // source, checked, ... }], counts }. The widgets draw from the shape below
  // (the columns' own names), so this is the one place that maps them.
  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function fromServer(d) {
    if (!d || !isArray(d.products)) return null;
    var products = [], items = [], i;
    for (i = 0; i < d.products.length; i++) {
      var p = d.products[i];
      if (!p || typeof p.id !== 'number' || typeof p.name !== 'string') continue;
      products.push({
        id: p.id, name: p.name, brand: typeof p.brand === 'string' ? p.brand : '', brand_id: p.brandId || null,
        size: typeof p.size === 'number' ? p.size : null, unit: p.unit || null, notes: p.notes || '',
        location: p.location || 'pantry', store: typeof p.store === 'string' ? p.store : '', quantity_remaining: Number(p.qty) || 0, restock_at: Number(p.restockAt) || 0,
        purchase_quantity: Number(p.buy) || 1, auto_add: p.autoAdd ? 1 : 0, substitution_mode: p.mode || 'similar',
        owned: p.owned ? 1 : 0, archived: 0
      });
    }
    var list = isArray(d.list) ? d.list : [];
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.id !== 'number' || typeof r.productId !== 'number') continue;
      items.push({ id: r.id, product_id: r.productId, quantity: Number(r.quantity) || 1, source: r.source === 'auto' ? 'auto' : 'manual', checked: !!r.checked });
    }
    var stores = [];
    if (isArray(d.stores)) for (i = 0; i < d.stores.length; i++) if (d.stores[i] && typeof d.stores[i].name === 'string') stores.push(d.stores[i].name);
    return { brands: isArray(d.brands) ? d.brands : [], stores: stores, products: products, list: { items: items } };
  }

  // A product page change as the Pi's ops (POST /pantry/screen-ops):
  // Remaining is "set" (qty), the rest one "edit".
  var EDIT_NAME = { restock_at: 'restockAt', purchase_quantity: 'purchaseQuantity', substitution_mode: 'substitutionMode',
    location: 'location', name: 'name', size: 'size', unit: 'unit', notes: 'notes' };
  function opsFor(id, changes) {
    var ops = [], edit = { op: 'edit', id: id }, any = false;
    for (var k in changes) {
      if (!Object.prototype.hasOwnProperty.call(changes, k)) continue;
      var v = changes[k];
      if (k === 'quantity_remaining') ops.push({ op: 'set', id: id, qty: v });
      else if (k === 'auto_add') { edit.autoAdd = !!v; any = true; }
      else if (k === 'brand') { if (v) edit.brand = v; else edit.brandId = null; any = true; }
      else if (EDIT_NAME[k]) { edit[EDIT_NAME[k]] = v; any = true; }
    }
    if (any) ops.push(edit);
    return ops;
  }

  // The TV's guess at what the Pi will answer, drawn until it does.
  function applyLocal(data, ops) {
    var out = { brands: data.brands, stores: data.stores || [], products: data.products.slice(0), list: { items: data.list.items.slice(0) } };
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i], j;
      if (o.op === 'check') {
        for (j = 0; j < out.list.items.length; j++) {
          if (out.list.items[j].id === o.list_item_id) out.list.items[j] = copy(out.list.items[j], { checked: !!o.checked });
        }
        continue;
      }
      for (j = 0; j < out.products.length; j++) {
        var p = out.products[j];
        if (p.id !== o.id) continue;
        var n = copy(p);
        if (o.op === 'set') { n.quantity_remaining = o.qty; n.owned = 1; }
        if (o.op === 'edit') {
          for (var k in EDIT_NAME) if (o[EDIT_NAME[k]] !== undefined) n[k] = o[EDIT_NAME[k]];
          if (o.autoAdd !== undefined) n.auto_add = o.autoAdd ? 1 : 0;
          if (o.brand !== undefined) {
            // A brand the Pi knows keeps its first spelling (pantrydb.js brands.key).
            n.brand_id = brandIdFor(data, o.brand);
            n.brand = n.brand_id ? brandName(data, { brand_id: n.brand_id }) : o.brand;
          }
          if (o.brandId === null) { n.brand = ''; n.brand_id = null; }
        }
        out.products[j] = n;
      }
    }
    return out;
  }

  function brandIdFor(data, name) {
    var k = brandKey(name);
    for (var i = 0; i < data.brands.length; i++) if (brandKey(data.brands[i].name) === k) return data.brands[i].id;
    return null;
  }

  // server: the Pi's last pantry (mapped); pending: ops posted and not yet answered.
  var store = { server: null, pending: [], subs: [], L: null, hooked: false };

  function emit() {
    for (var i = 0; i < store.subs.length; i++) {
      try { store.subs[i](); } catch (e) { /* one listener's problem */ }
    }
  }

  function take(raw) {
    var d = fromServer(raw);
    if (!d) return false;
    store.server = d;
    return true;
  }

  var api = {
    // Hooks the live line once (both widgets call it); cb(err) when there is data or none yet.
    load: function (ctx, cb) {
      var L = ctx && ctx.live;
      if (L && !store.hooked) {
        store.hooked = true;
        store.L = L;
        try {
          take(L.get('pantry'));
          L.on('pantry', function (data) { if (take(data)) emit(); });
        } catch (e) { /* the tile says it waits */ }
      }
      setTimeout(function () { cb(store.server ? null : 'no pantry yet'); }, 0);
    },

    // What the TV shows: the Pi's pantry with the changes on their way applied. null before any.
    snapshot: function () {
      var d = store.server;
      if (!d) return null;
      for (var i = 0; i < store.pending.length; i++) d = applyLocal(d, store.pending[i].ops);
      return d;
    },

    // 'live' | 'connecting' | 'off' ... from the live line, for the waiting text.
    liveState: function () {
      try { return store.L ? (store.L.status() || {}).state || 'off' : 'off'; } catch (e) { return 'off'; }
    },

    // Posts ops to the Pi. Shown at once; the Pi's answer replaces the view,
    // a refusal or no answer takes the change back: cb(null) or cb({ code, text }),
    // code 0 when the Pi did not answer.
    send: function (ops, cb) {
      var L = store.L;
      if (!store.server || !ops.length) return;
      if (!L || typeof L.post !== 'function') { setTimeout(function () { cb({ code: 0, text: '' }); }, 0); return; }
      var entry = { ops: ops };
      store.pending.push(entry);
      emit();
      L.post('/pantry/screen-ops', { ops: ops }, function (err, data, code) {
        var at = store.pending.indexOf(entry);
        if (at >= 0) store.pending.splice(at, 1);
        var ok = !err && data && data.ok !== false && take(data.data);
        emit();
        cb(ok ? null : { code: code || 0, text: String(err || (code ? 'HTTP ' + code : '')) });
      });
    },

    // changes: { field: value } already checked with clean(); brand is a name.
    saveProduct: function (id, changes, cb) { api.send(opsFor(id, changes), cb); },

    // A list row ticked or unticked while shopping (the grocery row follows on the Pi).
    check: function (itemId, checked, cb) { api.send([{ op: 'check', list_item_id: itemId, checked: !!checked }], cb); },

    // fn() after every change.
    on: function (fn) { store.subs.push(fn); }
  };

  function brandName(data, p) {
    if (!p) return '';
    if (p.brand) return p.brand;
    if (!data || !p.brand_id) return '';
    for (var i = 0; i < data.brands.length; i++) if (data.brands[i].id === p.brand_id) return data.brands[i].name;
    return '';
  }

  function productById(data, id) {
    if (!data) return null;
    for (var i = 0; i < data.products.length; i++) if (data.products[i].id === id) return data.products[i];
    return null;
  }

  function listRowFor(data, productId) {
    if (!data) return null;
    for (var i = 0; i < data.list.items.length; i++) if (data.list.items[i].product_id === productId) return data.list.items[i];
    return null;
  }

  // The open list: unticked first, then ticked, each in the Pi's order.
  function listOf(data) {
    var a = [], b = [];
    for (var i = 0; i < data.list.items.length; i++) (data.list.items[i].checked ? b : a).push(data.list.items[i]);
    return a.concat(b);
  }

  // The filter chips of the expanded views. Rows are [{ product }]. Places:
  // the ones in use, in LOCATIONS order, only when there are two or more.
  // Stores: the Pi's store list order (then any other spelling in use),
  // only the ones a row carries. '' is All.
  function filterChoices(rows, storeList) {
    var places = [], stores = [], seenP = {}, seenS = {}, i;
    for (i = 0; i < rows.length; i++) {
      seenP[rows[i].product.location] = 1;
      if (rows[i].product.store) seenS[rows[i].product.store] = 1;
    }
    for (i = 0; i < LOCATIONS.length; i++) if (seenP[LOCATIONS[i]]) places.push(LOCATIONS[i]);
    var list = (storeList || []).slice();
    for (var k in seenS) if (seenS.hasOwnProperty(k) && !has(list, k)) list.push(k);
    for (i = 0; i < list.length; i++) if (seenS[list[i]] && !has(stores, list[i])) stores.push(list[i]);
    return { places: places.length > 1 ? places : [], stores: stores };
  }

  function filterRows(rows, place, storeName) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i].product;
      if (place && p.location !== place) continue;
      if (storeName && p.store !== storeName) continue;
      out.push(rows[i]);
    }
    return out;
  }

  var Logic = {
    UNITS: UNITS, MODES: MODES, LOCATIONS: LOCATIONS, api: api, brandKey: brandKey, stateOf: stateOf,
    pantryOf: pantryOf, pantryCounts: pantryCounts, clean: clean, brandName: brandName, productById: productById,
    fromServer: fromServer, opsFor: opsFor, applyLocal: applyLocal, listOf: listOf, filterChoices: filterChoices, filterRows: filterRows,
    // For tests: forget the Pi's copy and the live line.
    reset: function () { store.server = null; store.pending = []; store.L = null; store.hooked = false; }
  };
  root.HUB_PANTRY_TV = Logic;
  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof document === 'undefined') return;

  /* ---------- drawing helpers ---------- */

  function tr(k, english, vars) {
    var L = root.HUB_I18N;
    if (L && typeof L.t === 'function') {
      try { return String(L.t(k, english, vars)); } catch (e) { /* English below */ }
    }
    return String(english).replace(/\{(\w+)\}/g, function (all, n) {
      return vars && Object.prototype.hasOwnProperty.call(vars, n) ? String(vars[n]) : all;
    });
  }

  function el(tag, cls, text, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function num(n) {
    var v = Number(n) || 0;
    return String(Math.round(v * 100) / 100);
  }

  var UNIT_EN = { oz: 'oz', fl_oz: 'fl oz', lb: 'lb', g: 'g', kg: 'kg', ml: 'ml', l: 'l', gal: 'gal', count: 'count', pack: 'pack' };
  function unitWord(u) { return tr('pantry.unit.' + u, UNIT_EN[u] || u); }
  function sizeText(p) { return p.size ? num(p.size) + ' ' + unitWord(p.unit) : ''; }

  var LOC_EN = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry', bathroom: 'Bathroom', other: 'Other' };
  function locWord(l) { return tr('pantry.place.' + l, LOC_EN[l] || l); }
  var MODE_EN = { similar: 'Something similar', preselected: 'My picks', refund: 'Refund it', contact_me: 'Ask me' };
  function modeWord(m) { return tr('pantry.mode.' + m, MODE_EN[m] || m); }

  function chip(kind, parent) {
    var text = kind === 'out' ? tr('pantry.out', 'Out') : kind === 'low' ? tr('pantry.low', 'Low')
      : kind === 'auto' ? tr('pantry.auto', 'Auto') : kind === 'new' ? tr('pantry.never', 'New') : tr('pantry.inStock', 'In stock');
    return el('span', 'pn-chip pn-chip-' + kind, text, parent);
  }

  function sizeOf(ctx) {
    try { return ctx.size() || {}; } catch (e) { return {}; }
  }

  // Rows leave from the bottom until the foot line fits inside the body.
  function fitRows(body, list, foot, rows, footFor) {
    var limit = body.getBoundingClientRect().bottom;
    var shown = rows.length;
    while (shown > 0 && foot.getBoundingClientRect().bottom > limit + 0.5) {
      shown -= 1;
      list.removeChild(rows[shown]);
      foot.textContent = footFor(rows.length - shown);
    }
    if (!shown) list.style.display = 'none';
  }

  /* ---------- one widget (pantry or list) ---------- */

  function make(w) {
    var kind = w.id;
    var S = { C: null, panel: null, page: null, back: null, fitTimer: null, fitH: 0, fitCount: 0, saving: 0,
      place: '', store: '', storeVals: [], focusChip: null };

    function data() { return api.snapshot(); }

    function typing() {
      var a = document.activeElement;
      return !!(S.panel && a && a.tagName === 'INPUT' && S.panel.contains(a));
    }

    function refresh() {
      var C = S.C;
      if (!C) return;
      C.redrawTile();
      if (C.isOpen() && !typing()) C.redrawPanel();
    }

    /* --- rows: what each widget lists --- */

    // [{ key, product, qty text, chips: [...] }]
    function rows() {
      var d = data();
      if (!d) return null;
      var out = [], i, p;
      if (kind === 'pantry') {
        var list = pantryOf(d.products);
        for (i = 0; i < list.length; i++) {
          p = list[i];
          var st = stateOf(p);
          out.push({ key: 'prod:' + p.id, product: p, state: st,
            qty: st === 'out' ? '' : tr('pantry.left', '{n} left', { n: num(p.quantity_remaining) }) });
        }
      } else {
        var items = listOf(d);
        for (i = 0; i < items.length; i++) {
          var it = items[i];
          p = productById(d, it.product_id);
          if (!p) continue;
          out.push({ key: 'item:' + it.id, product: p, state: stateOf(p), item: it, ticked: it.checked, qty: '×' + it.quantity });
        }
      }
      return out;
    }

    // The rows the expanded view shows: the chips' place and store. A chip
    // whose value is no longer in use goes back to All.
    function shown(all) {
      var ch = filterChoices(all, (data() || {}).stores);
      if (kind !== 'pantry') ch.places = [];
      if (!has(ch.places, S.place)) S.place = '';
      if (!has(ch.stores, S.store)) S.store = '';
      S.storeVals = ch.stores;
      return { rows: filterRows(all, S.place, S.store), choices: ch };
    }

    // The list's rows still to get (not ticked).
    function toGet(all) {
      var n = 0;
      for (var i = 0; i < all.length; i++) if (!all[i].ticked) n++;
      return n;
    }

    // Before any data: Loading while the live line is on its way, else where the pantry lives.
    function waitWord() {
      var st = api.liveState();
      return st === 'off' || st === 'refused' || st === 'needsupdate' ? tr('pantry.tvNoPi', 'The pantry lives on the Pi') : tr('pantry.tvLoading', 'Loading…');
    }

    function title(p) {
      var b = brandName(data(), p);
      return b ? b + ' ' + p.name : p.name;
    }

    /* --- the tile --- */

    function tileRow(r, parent) {
      var row = el('div', 'pn-trow' + (r.ticked ? ' is-ticked' : ''), null, parent);
      el('span', 'pn-tname', title(r.product), row);
      if (kind === 'list' && r.state === 'out' && !r.ticked) { chip('out', row); el('span', 'pn-tqty', r.qty, row); }
      else if (kind === 'pantry' && r.state === 'out') chip('out', row);
      else if (kind === 'pantry' && r.state === 'low') { chip('low', row); el('span', 'pn-tqty', r.qty, row); }
      else el('span', 'pn-tqty', r.qty, row);
      return row;
    }

    function renderTile(body, ctx) {
      body.innerHTML = '';
      var s = sizeOf(ctx);
      var tier = s.tier || 'standard';
      var one = s.cols === 1;
      var box = el('div', 'pn-tile pn-tile-' + tier + (one ? ' pn-tile-one' : ''), null, body);
      var all = rows();
      if (!all) {
        box.className += ' hub-dormant';
        el('div', 'pn-msg', one ? '–' : waitWord(), box);
        return;
      }
      var d = data();
      var c = pantryCounts(d.products);
      var left = kind === 'list' ? toGet(all) : 0;
      var big = kind === 'pantry' ? c.out : left;
      if (one) { el('div', 'pn-one-num', String(big), box); return; }
      if (tier === 'strip') {
        var line = el('div', 'pn-strip', null, box);
        if (kind === 'pantry') {
          el('span', 'pn-strip-num', tr('pantry.outN', '{n} out', { n: c.out }), line);
          var dot = el('span', 'pn-strip-dot', '·', line);
          var rest = el('span', 'pn-strip-rest', tr('pantry.lowN', '{n} low', { n: c.low }), line);
          // No room for both: the out count alone.
          if (line.scrollWidth > line.clientWidth + 1) { line.removeChild(dot); line.removeChild(rest); }
        } else if (!all.length) {
          el('span', 'pn-strip-rest', tr('pantry.listEmpty', 'Nothing to buy'), line);
        } else if (!left) {
          el('span', 'pn-strip-rest', tr('pantry.allInCart', 'All in the cart'), line);
        } else {
          el('span', 'pn-strip-num', tr('pantry.toBuyN', '{n} to buy', { n: left }), line);
          el('span', 'pn-strip-dot', '·', line);
          el('span', 'pn-strip-rest pn-tname', title(all[0].product), line);
        }
        return;
      }
      var hero = el('div', 'pn-hero', null, box);
      if (kind === 'pantry') {
        el('span', 'pn-hero-num', String(c.total), hero);
        el('span', 'pn-hero-cap', tr('pantry.inPantry', 'in the pantry'), hero);
        var sum = el('div', 'pn-sum', null, box);
        if (c.out) { chip('out', sum); el('span', 'pn-sum-n', String(c.out), sum); }
        if (c.low) { chip('low', sum); el('span', 'pn-sum-n', String(c.low), sum); }
        if (!c.out && !c.low) el('span', 'pn-sum-ok', tr('pantry.allStocked', 'All stocked'), sum);
      } else {
        el('span', 'pn-hero-num', String(left), hero);
        el('span', 'pn-hero-cap', tr('pantry.toBuy', 'to buy'), hero);
        if (!all.length) { el('div', 'pn-hint', tr('pantry.listEmptyHint', 'Out items with auto-add on land here.'), box); return; }
      }
      var list = el('div', 'pn-tlist', null, box);
      var made = [];
      var show = kind === 'pantry' ? all.slice(0) : all;
      for (var i = 0; i < show.length; i++) made.push(tileRow(show[i], list));
      var cart = kind === 'list' ? all.length - left : 0;
      var footFor = function (n) {
        var parts = [];
        if (n) parts.push(tr('pantry.moreN', '+{n} more', { n: n }));
        if (cart) parts.push(tr('pantry.inCartN', '{n} in the cart', { n: cart }));
        return parts.join(' · ');
      };
      var foot = el('div', 'pn-foot', footFor(0), box);
      fitRows(body, list, foot, made, footFor);
      if (!foot.textContent) foot.style.display = 'none';
      refitSoon(body);
    }

    function refitSoon(body) {
      S.fitH = body.clientHeight;
      if (S.fitTimer) clearTimeout(S.fitTimer);
      S.fitTimer = setTimeout(function () {
        S.fitTimer = null;
        try {
          var h = body.clientHeight;
          if (h && Math.abs(h - S.fitH) > 1 && S.fitCount < 2 && S.C) { S.fitCount += 1; S.C.redrawTile(); } else S.fitCount = 0;
        } catch (e) { S.fitCount = 0; }
      }, 400);
    }

    /* --- the panel: rows --- */

    function tickKey(r) { return (r.ticked ? 'untick:' : 'tick:') + r.item.id; }

    // Pantry: the row is one focusable (OK opens the product). List: the row
    // is a tick box (OK ticks or unticks it) and a Details button on its right
    // (OK opens the product). Returns the focusable that takes first focus.
    function panelRow(r, parent) {
      var list = kind === 'list';
      var row = el('div', 'pn-row' + (list ? ' pn-lrow' : ' f') + (r.ticked ? ' is-ticked' : ''), null, parent);
      var hit = row;
      if (list) {
        hit = el('div', 'pn-tick f', null, row);
        hit.setAttribute('data-key', tickKey(r));
        hit.setAttribute('aria-pressed', r.ticked ? 'true' : 'false');
        hit.setAttribute('aria-label', tr(r.ticked ? 'pantry.untick' : 'pantry.tick', r.ticked ? 'Untick {name}' : 'Tick {name}', { name: title(r.product) }));
        el('span', 'pn-box', null, hit);
      } else {
        row.setAttribute('data-key', r.key);
      }
      hit.setAttribute('role', 'button');
      var main = el('div', 'pn-row-main', null, hit);
      var b = brandName(data(), r.product);
      el('span', 'pn-name', r.product.name, main);
      var meta = [];
      if (b) meta.push(b);
      if (sizeText(r.product)) meta.push(sizeText(r.product));
      if (!list) meta.push(locWord(r.product.location));
      var metaEl = el('span', 'pn-meta', meta.join(' · '), main);
      if (r.product.store) {
        if (meta.length) metaEl.appendChild(document.createTextNode(' · '));
        el('span', 'pn-store', r.product.store, metaEl);
      }
      var side = el('div', 'pn-row-side', null, hit);
      if (list && r.item.source === 'auto') chip('auto', side);
      if (r.state === 'out' || r.state === 'low') chip(r.state, side);
      if (r.qty) el('span', 'pn-qty', r.qty, side);
      if (list) {
        var det = btn(row, r.key, tr('pantry.details', 'Details'), 'pn-det', tr('pantry.detailsOf', 'Details of {name}', { name: title(r.product) }));
        if (S.back === r.key) det.setAttribute('data-autofocus', '');
        if (S.focusAfter === tickKey(r)) hit.setAttribute('data-autofocus', '');
      } else if (S.back === r.key) {
        row.setAttribute('data-autofocus', '');
      }
      return hit;
    }

    // One chip row: a label, All, then each value. OK picks one (single-select).
    function chipRow(parent, label, name, values, current, word) {
      var row = el('div', 'pn-frow', null, parent);
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', label);
      el('span', 'pn-flabel', label, row);
      var pills = el('div', 'pn-fchips', null, row);
      var all = [''].concat(values);
      for (var i = 0; i < all.length; i++) {
        var on = all[i] === current;
        var k = 'f' + name + ':' + (all[i] === '' ? 'all' : name === 'store' ? i - 1 : all[i]);
        var c = btn(pills, k, all[i] === '' ? word('') : word(all[i]), 'pn-pill pn-fchip' + (on ? ' is-on' : ''));
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (S.focusChip === k) c.setAttribute('data-autofocus', '');
      }
    }

    function filterBar(box, ch) {
      if (!ch.places.length && !ch.stores.length) return;
      var bar = el('div', 'pn-filters', null, box);
      if (ch.places.length) {
        chipRow(bar, tr('pantry.placeFilter', 'Place'), 'place', ch.places, S.place,
          function (v) { return v ? locWord(v) : tr('pantry.allPlaces', 'All'); });
      }
      if (ch.stores.length) {
        chipRow(bar, tr('pantry.storeFilter', 'Store'), 'store', ch.stores, S.store,
          function (v) { return v || tr('pantry.allStores', 'All'); });
      }
    }

    function renderList(box, ctx) {
      var everything = rows();
      var d = data();
      var list = kind === 'list';
      var left = list ? toGet(everything) : 0;
      var all = everything;
      if (!list) {
        var c = pantryCounts(d.products);
        ctx.setSub(tr('pantry.sub', '{n} items · {out} out · {low} low', { n: c.total, out: c.out, low: c.low }));
      } else if (!all.length) {
        ctx.setSub(tr('pantry.listEmpty', 'Nothing to buy'));
      } else {
        var sub = left ? tr('pantry.toBuyN', '{n} to buy', { n: left }) : tr('pantry.allInCart', 'All in the cart');
        if (left && everything.length > left) sub += ' · ' + tr('pantry.inCartN', '{n} in the cart', { n: everything.length - left });
        ctx.setSub(sub);
      }
      var tip = list ? tr('pantry.tipList', 'OK ticks or unticks · Right, then OK on Details, for the product.')
        : ctx.mode() === 'full' ? tr('pantry.tipFull', 'OK on a product to see and edit it.') : tr('pantry.tipPanel', 'OK on a product opens it full screen.');
      el('div', 'pn-tip', tip, box);
      var view = shown(everything);
      all = view.rows;
      filterBar(box, view.choices);
      var groups = !list
        ? [['out', tr('pantry.secOut', 'Out')], ['low', tr('pantry.secLow', 'Running low')], ['ok', tr('pantry.secOk', 'In stock')]]
        : [['get', tr('pantry.secList', 'To get')], ['cart', tr('pantry.secCart', 'In the cart')]];
      var first = true;
      var steered = !!S.back || !!S.focusAfter || !!S.focusChip;
      for (var g = 0; g < groups.length; g++) {
        var mine = [];
        var gk = groups[g][0];
        for (var i = 0; i < all.length; i++) {
          var r = all[i];
          if (list ? (gk === 'cart') === !!r.ticked : r.state === gk) mine.push(r);
        }
        if (!mine.length) continue;
        var sec = el('div', 'pn-sec pn-sec-' + gk, null, box);
        var head = el('div', 'pn-sec-head', null, sec);
        el('span', 'pn-sec-name', groups[g][1], head);
        el('span', 'pn-sec-count', String(mine.length), head);
        var wrap = el('div', 'pn-rows', null, sec);
        for (var j = 0; j < mine.length; j++) {
          var hit = panelRow(mine[j], wrap);
          if (first && !steered) hit.setAttribute('data-autofocus', '');
          first = false;
        }
      }
      if (first) {
        el('div', 'pn-empty', everything.length ? tr('pantry.noneForFilter', 'Nothing matches these filters')
          : !list ? tr('pantry.pantryEmpty', 'Nothing in the pantry yet') : tr('pantry.listEmpty', 'Nothing to buy'), box);
      }
      S.back = null;
      S.focusAfter = null;
      S.focusChip = null;
    }

    /* --- the product page --- */

    function field(parent, label, cls) {
      var f = el('div', 'pn-field' + (cls ? ' ' + cls : ''), null, parent);
      el('div', 'pn-label', label, f);
      return el('div', 'pn-control', null, f);
    }

    function input(parent, name, type, value, label) {
      var box = el('span', 'pn-input-box' + (type === 'number' ? ' is-number' : ''), null, parent);
      var n = el('input', 'f pn-input', null, box);
      n.setAttribute('type', type);
      n.setAttribute('data-key', 'in:' + name);
      n.setAttribute('autocomplete', 'off');
      n.setAttribute('spellcheck', 'false');
      n.setAttribute('aria-label', label);
      if (type === 'number') { n.setAttribute('inputmode', 'decimal'); n.setAttribute('min', '0'); n.setAttribute('step', 'any'); }
      n.value = value == null ? '' : String(value);
      return n;
    }

    function btn(parent, key, text, cls, label) {
      var b = el('span', 'f pn-btn ' + (cls || ''), text, parent);
      b.setAttribute('data-key', key);
      b.setAttribute('role', 'button');
      if (label) b.setAttribute('aria-label', label);
      return b;
    }

    function stepper(parent, name, value, label) {
      btn(parent, 'step:' + name + ':-1', '−', 'pn-step', tr('pantry.lessOf', 'Less: {what}', { what: label }));
      input(parent, name, 'number', num(value), label);
      btn(parent, 'step:' + name + ':1', '+', 'pn-step', tr('pantry.moreOf', 'More: {what}', { what: label }));
    }

    function pills(parent, name, values, current, word) {
      var row = el('div', 'pn-pills', null, parent);
      for (var i = 0; i < values.length; i++) {
        var p = btn(row, 'pick:' + name + ':' + values[i], word(values[i]), 'pn-pill' + (values[i] === current ? ' is-on' : ''));
        p.setAttribute('aria-pressed', values[i] === current ? 'true' : 'false');
      }
      return row;
    }

    function renderPage(box, ctx) {
      var d = data();
      var p = productById(d, S.page);
      if (!p) { S.page = null; renderList(box, ctx); return; }
      var page = el('div', 'pn-page', null, box);
      var head = el('div', 'pn-ph', null, page);
      var b = brandName(d, p);
      if (b) el('div', 'pn-ph-brand', b, head);
      el('div', 'pn-ph-name', p.name, head);
      var meta = el('div', 'pn-ph-meta', null, head);
      var st = stateOf(p);
      chip(st, meta);
      var bits = [];
      if (sizeText(p)) bits.push(sizeText(p));
      bits.push(locWord(p.location));
      var onList = listRowFor(d, p.id);
      if (onList) bits.push(tr('pantry.onListN', 'On the list ×{n}', { n: onList.quantity }));
      el('span', 'pn-ph-bits', bits.join(' · '), meta);
      ctx.setSub(tr('pantry.pageSub', 'Product · changes save as you go'));

      var cols = el('div', 'pn-cols', null, page);
      var left = el('div', 'pn-col pn-col-a', null, cols);
      var right = el('div', 'pn-col pn-col-b', null, cols);

      var Lrem = tr('pantry.f.remaining', 'Remaining');
      stepper(field(left, Lrem, 'is-step'), 'quantity_remaining', p.quantity_remaining, Lrem);
      var Lres = tr('pantry.restockAt', 'Buy more when I have');
      stepper(field(left, Lres, 'is-step'), 'restock_at', p.restock_at, Lres);
      var Lbuy = tr('pantry.buyQty', 'How many to buy');
      stepper(field(left, Lbuy, 'is-step'), 'purchase_quantity', p.purchase_quantity, Lbuy);
      pills(field(left, tr('pantry.f.auto', 'Add to the list when low')), 'auto_add', ['1', '0'], p.auto_add ? '1' : '0',
        function (v) { return v === '1' ? tr('pantry.on', 'On') : tr('pantry.off', 'Off'); });
      pills(field(left, tr('pantry.f.location', 'Where it lives')), 'location', LOCATIONS, p.location, locWord);

      var Lb = tr('pantry.brand', 'Brand');
      input(field(right, Lb, 'is-text'), 'brand', 'text', b, Lb);
      var Ln = tr('pantry.f.name', 'Name');
      input(field(right, Ln, 'is-text'), 'name', 'text', p.name, Ln);
      var Ls = tr('pantry.size', 'Size');
      var sz = field(right, Ls, 'is-size');
      input(sz, 'size', 'number', p.size == null ? '' : num(p.size), Ls);
      pills(sz, 'unit', UNITS, p.unit, unitWord);
      pills(field(right, tr('pantry.modeLabel', 'If it is out')), 'substitution_mode', MODES, p.substitution_mode, modeWord);
      var Lno = tr('pantry.f.notes', 'Notes');
      var notes = input(field(right, Lno, 'is-text'), 'notes', 'text', p.notes || '', Lno);
      notes.setAttribute('placeholder', tr('pantry.notesHint', 'Anything to remember'));

      var first = page.querySelector('[data-key="in:quantity_remaining"]');
      if (first) first.setAttribute('data-autofocus', '');
      el('div', 'pn-page-foot', tr('pantry.pageFoot', 'OK to type in a box, Enter to save · Back for the list'), page);
    }

    function renderPanel(body, ctx) {
      body.innerHTML = '';
      S.panel = body;
      var full = ctx.mode() === 'full';
      var box = el('div', 'pn-panel pn-panel-' + kind + (full ? ' is-full' : ''), null, body);
      if (!data()) {
        ctx.setSub('');
        el('div', 'pn-msg pn-panel-msg hub-dormant', waitWord(), box);
        return;
      }
      if (S.page !== null && full) renderPage(box, ctx);
      else renderList(box, ctx);
    }

    /* --- the remote --- */

    function productOfKey(k) {
      var d = data();
      if (!d || !k) return null;
      if (k.indexOf('prod:') === 0) return Number(k.substring(5));
      if (k.indexOf('item:') === 0) {
        var id = Number(k.substring(5));
        for (var i = 0; i < d.list.items.length; i++) if (d.list.items[i].id === id) return d.list.items[i].product_id;
      }
      return null;
    }

    function openPage(id, fromKey, ctx) {
      S.page = id;
      S.from = fromKey;
      if (ctx.mode() === 'full') ctx.redrawPanel();
      else ctx.setMode('full');
    }

    function closePage(ctx) {
      S.back = S.from || null;
      S.page = null;
      ctx.redrawPanel();
    }

    // A refusal or no answer: the change is already taken back, say why.
    function failed(ctx, err) {
      if (!err) return;
      var why = err.code ? err.text : tr('grocery.tvUnreachable', 'the Pi didn’t answer');
      if (window.console && console.warn) console.warn('Pantry: the Pi did not take a change (' + (err.code || 'no answer') + ')');
      ctx.toast(tr('pantry.saveFailed', 'That didn’t save: {why}', { why: why }), 4500);
    }

    function save(ctx, changes) {
      var id = S.page;
      S.saving += 1;
      api.saveProduct(id, changes, function (err) {
        S.saving -= 1;
        failed(ctx, err);
      });
    }

    // OK on a list row: tick or untick it. Focus goes to the next row of the
    // same section (the row itself moves to the other section).
    function tick(itemId, ctx) {
      var all = shown(rows() || []).rows, me = null, i;
      for (i = 0; i < all.length; i++) if (all[i].item && all[i].item.id === itemId) me = all[i];
      if (!me) return;
      var same = [];
      for (i = 0; i < all.length; i++) if (!!all[i].ticked === !!me.ticked) same.push(all[i]);
      var at = same.indexOf(me);
      var next = same[at + 1] || same[at - 1] || null;
      S.focusAfter = next ? tickKey(next) : (me.ticked ? 'tick:' : 'untick:') + itemId;
      api.check(itemId, !me.ticked, function (err) { failed(ctx, err); });
    }

    function onSelect(target, ctx) {
      var k = target.getAttribute('data-key') || '';
      if (S.page === null) {
        var f = /^f(place|store):(.+)$/.exec(k);
        if (f) {
          var v = f[2] === 'all' ? '' : f[1] === 'store' ? (S.storeVals[Number(f[2])] || '') : f[2];
          if (f[1] === 'place') S.place = v; else S.store = v;
          S.focusChip = k;
          ctx.redrawPanel();
          return;
        }
        var t = /^(un)?tick:(\d+)$/.exec(k);
        if (t) { tick(Number(t[2]), ctx); return; }
        var pid = productOfKey(k);
        if (pid !== null) openPage(pid, k, ctx);
        return;
      }
      var p = productById(data(), S.page);
      if (!p) return;
      var m = /^step:(\w+):(-?1)$/.exec(k);
      if (m) {
        var v = Number(p[m[1]]) + Number(m[2]);
        // A fraction steps to the next whole number first (0.5 -> 1 or 0).
        if (Math.floor(p[m[1]]) !== Number(p[m[1]])) v = m[2] === '1' ? Math.ceil(p[m[1]]) : Math.floor(p[m[1]]);
        var c = clean(m[1], String(v));
        if (c.error) return;
        var ch = {};
        ch[m[1]] = c.value;
        save(ctx, ch);
        return;
      }
      m = /^pick:(\w+):(\w+)$/.exec(k);
      if (m) {
        var c2 = clean(m[1], m[1] === 'auto_add' ? m[2] === '1' : m[2]);
        if (c2.error) return;
        var ch2 = {};
        ch2[m[1]] = c2.value;
        save(ctx, ch2);
      }
    }

    var ERR = {
      name: ['pantry.err.name', 'A product needs a name'],
      long: ['pantry.err.long', 'That’s too long'],
      number: ['pantry.err.number', 'Type a number, 0 or more'],
      whole: ['pantry.err.whole', 'Type a whole number, 1 or more'],
      whole0: ['pantry.err.whole0', 'Type a whole number, 0 or more']
    };

    function onSubmit(target, ctx) {
      var m = /^in:(\w+)$/.exec(target.getAttribute('data-key') || '');
      if (!m || S.page === null) return;
      var c = clean(m[1], target.value);
      if (c.error) {
        var e = ERR[c.error] || ERR.number;
        ctx.toast(tr(e[0], e[1]), 4500);
        ctx.redrawPanel();
        return;
      }
      var ch = {};
      ch[m[1]] = c.value;
      save(ctx, ch);
    }

    var widget = copy(w, {
      expandable: true,
      stagger: '.pn-sec, .pn-field',
      init: function (ctx) {
        S.C = ctx;
        api.on(function () { try { refresh(); } catch (e) { /* next draw */ } });
        // No data yet is normal (the live line is on its way); the tile waits quietly.
        api.load(ctx, function () { refresh(); });
        var I = root.HUB_I18N;
        if (I && typeof I.onChange === 'function') {
          I.onChange(function () {
            try { if (typeof ctx.retitle === 'function') ctx.retitle(); refresh(); } catch (e) { /* next draw */ }
          });
        }
      },
      renderTile: renderTile,
      renderPanel: renderPanel,
      onSelect: onSelect,
      onSubmit: onSubmit,
      // The hub's Back chip: on the product page Back goes to the list, not out of full screen.
      backHint: function () { return S.page !== null ? tr('pantry.backList', 'Back for the list') : null; },
      onBack: function (ctx) {
        if (S.page === null) return false;
        closePage(ctx);
        return true;
      },
      onMode: function (mode, ctx) {
        if (mode !== 'full' && S.page !== null) { S.back = S.from || null; S.page = null; }
        ctx.redrawPanel();
      },
      onStatus: function (ctx) { ctx.redrawTile(); },
      onClose: function () { S.panel = null; S.page = null; S.back = null; S.focusAfter = null; S.focusChip = null; S.place = ''; S.store = ''; }
    });
    var en = w.titleEn, enShort = w.shortEn;
    try {
      Object.defineProperty(widget, 'title', { get: function () { return tr(w.titleKey, en); }, enumerable: true, configurable: true });
      Object.defineProperty(widget, 'shortTitle', { get: function () { return tr(w.titleKey + 'Short', enShort); }, enumerable: true, configurable: true });
    } catch (e) {
      widget.title = en;
    }
    widget._state = S;
    return widget;
  }

  var pantryWidget = make({
    id: 'pantry',
    titleKey: 'pantry.title',
    titleEn: 'Pantry',
    shortEn: 'Pantry',
    icon: 'jar'
  });
  var listWidget = make({
    id: 'list',
    titleKey: 'pantry.listTitle',
    titleEn: 'List',
    shortEn: 'List',
    icon: 'basket'
  });

  // For the tests (dev/pantry-tv-test.js).
  Logic.state = { pantry: pantryWidget._state, list: listWidget._state };

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push(pantryWidget, listWidget);
})(typeof window !== 'undefined' ? window : this);
