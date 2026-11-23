/*
 * Pantry and List: two TV widgets over the pantry database planned for the
 * Pi (/mnt/project-files/pantry/plan-v2.md: SQLite products, brands, lists,
 * list items). Both share this file and app/widgets/pantry.css.
 *
 *   pantry   the pantry is a FILTER of products: owned before and not
 *            archived. quantity_remaining 0 = out (an "Out" chip), at or
 *            under restock_at = low.
 *   list     the open list's items (product, quantity, auto or manual).
 *
 * In full screen, OK on a row (in either widget) opens that product's page:
 * brand, name, size, unit, remaining, restock at, buy quantity, auto-add,
 * substitution, where it lives and notes, each editable with the remote
 * (number boxes with - and + beside them, choice pills, text boxes). Changes
 * save as they are made. Back closes the page and focus goes back to the row.
 * OK on a row in the small panel switches to full screen and opens the page.
 *
 *   tile, 1 column  pantry: the out count; list: the count to buy
 *   tile, strip     "3 out · 2 low" / "8 to buy · Whole milk"
 *   tile, 2+ rows   the count big, then the first rows that fit, "+N more"
 *   panel           rows grouped (pantry: Out, Low, In stock); OK opens the page
 *
 * DATA: HUB_PANTRY.api below is the ONLY place that knows where the data
 * comes from. Today it serves MOCK data from memory (nothing is saved
 * anywhere). When the Pi's pantry routes land, replace the bodies of
 * api.load and api.saveProduct (see the comments there); the widgets only
 * call api.load, api.snapshot, api.saveProduct and api.on.
 *
 * Product and brand names are data, never translated and never logged.
 * Plain ES5: the TV's browser is Chromium 63 class.
 */
(function (root) {
  'use strict';

  var UNITS = ['oz', 'fl_oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'count', 'pack'];
  var MODES = ['similar', 'preselected', 'refund', 'contact_me'];
  var LOCATIONS = ['fridge', 'freezer', 'pantry', 'other'];

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
        return s.length > 60 ? { error: 'long' } : { value: s };
      case 'notes':
        s = String(s || '').replace(/\s+/g, ' ');
        return s.length > 200 ? { error: 'long' } : { value: s };
      case 'size':
        if (s === '' || s === null) return { value: null };
        n = Number(s);
        return isFinite(n) && n > 0 && n < 100000 ? { value: Math.round(n * 100) / 100 } : { error: 'number' };
      case 'quantity_remaining':
      case 'restock_at':
        n = Number(s);
        return s !== '' && isFinite(n) && n >= 0 && n < 10000 ? { value: Math.round(n * 100) / 100 } : { error: 'number' };
      case 'purchase_quantity':
        n = Number(s);
        return s !== '' && isFinite(n) && n >= 1 && n < 1000 && Math.floor(n) === n ? { value: n } : { error: 'whole' };
      case 'unit': return has(UNITS, s) ? { value: s } : { error: 'choice' };
      case 'substitution_mode': return has(MODES, s) ? { value: s } : { error: 'choice' };
      case 'location': return has(LOCATIONS, s) ? { value: s } : { error: 'choice' };
      case 'auto_add': return { value: s === true || s === 1 || s === '1' || s === 'on' ? 1 : 0 };
    }
    return { error: 'field' };
  }

  /* ---------- the data adapter: MOCK today, the Pi later ---------- */

  // Realistic sample data in the shape of plan-v2's tables (brands,
  // products, the open list and its items). MOCK ONLY.
  function mockData() {
    var brands = [
      [1, 'Organic Valley'], [2, 'Kerrygold'], [3, 'Chobani'], [4, 'Barilla'], [5, 'Rao’s'], [6, 'King Arthur'],
      [7, 'Heinz'], [8, 'La Colombe'], [9, 'Goya'], [10, 'Cholula'], [11, 'Kirkland Signature'], [12, 'Dave’s Killer Bread'],
      [13, 'Simply'], [14, 'Tide'], [15, 'Mutti'], [16, 'Oatly']
    ];
    // id, brand_id, name, size, unit, location, remaining, restock_at, buy, auto, mode, owned, notes
    var rows = [
      [1, 1, 'Whole milk', 0.5, 'gal', 'fridge', 0, 1, 2, 1, 'similar', 1, ''],
      [2, 2, 'Salted butter', 8, 'oz', 'fridge', 1, 1, 2, 1, 'similar', 1, ''],
      [3, 3, 'Plain Greek yogurt', 32, 'oz', 'fridge', 2, 1, 1, 1, 'preselected', 1, ''],
      [4, 1, 'Large brown eggs', 12, 'count', 'fridge', 0, 1, 1, 1, 'similar', 1, 'Pasture raised if they have it'],
      [5, 4, 'Spaghetti', 16, 'oz', 'pantry', 3, 1, 2, 1, 'similar', 1, ''],
      [6, 5, 'Marinara sauce', 24, 'oz', 'pantry', 1, 1, 2, 1, 'contact_me', 1, 'Only Rao’s'],
      [7, 6, 'All-purpose flour', 5, 'lb', 'pantry', 1, 0, 1, 0, 'similar', 1, ''],
      [8, 7, 'Tomato ketchup', 32, 'oz', 'fridge', 1, 0, 1, 1, 'similar', 1, ''],
      [9, 8, 'Whole bean coffee', 12, 'oz', 'pantry', 0, 1, 2, 0, 'refund', 1, 'Corsica blend'],
      [10, 9, 'Black beans', 15.5, 'oz', 'pantry', 6, 2, 4, 1, 'similar', 1, ''],
      [11, 10, 'Hot sauce', 5, 'fl_oz', 'pantry', 1, 0, 1, 0, 'similar', 1, ''],
      [12, 11, 'Frozen blueberries', 3, 'lb', 'freezer', 1, 0, 1, 1, 'similar', 1, ''],
      [13, 11, 'Chicken thighs', 4, 'lb', 'freezer', 2, 1, 1, 1, 'contact_me', 1, ''],
      [14, 12, '21 Whole Grains bread', 27, 'oz', 'pantry', 0, 0, 1, 1, 'similar', 1, ''],
      [15, 0, 'Bananas', 1, 'count', 'other', 0, 2, 6, 1, 'similar', 1, ''],
      [16, 13, 'Orange juice', 52, 'fl_oz', 'fridge', 1, 1, 1, 1, 'similar', 1, 'No pulp'],
      [17, 14, 'Pods laundry detergent', 42, 'count', 'other', 1, 0, 1, 0, 'preselected', 1, ''],
      [18, 15, 'Tomato paste', 4.5, 'oz', 'pantry', 2, 1, 2, 1, 'similar', 1, ''],
      [19, 16, 'Oat milk', 64, 'fl_oz', 'fridge', 0, 0, 1, 0, 'similar', 0, ''],
      [20, 0, 'Sourdough boule', 1, 'count', 'pantry', 0, 0, 1, 0, 'refund', 0, '']
    ];
    var products = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      products.push({
        id: r[0], brand_id: r[1] || null, name: r[2], barcode: null, size: r[3], unit: r[4], photo: null, notes: r[12],
        archived: 0, quantity_remaining: r[6], restock_at: r[7], purchase_quantity: r[8], auto_add: r[9],
        substitution_mode: r[10], last_price: null, preferred_store: null, location: r[5], owned: r[11]
      });
    }
    var b = [];
    for (var j = 0; j < brands.length; j++) b.push({ id: brands[j][0], name: brands[j][1], key: brandKey(brands[j][1]) });
    // list_items: id, product_id, quantity, source
    var items = [[1, 1, 2, 'auto'], [2, 4, 1, 'auto'], [3, 15, 6, 'manual'], [4, 14, 1, 'auto'], [5, 16, 1, 'auto'],
      [6, 19, 1, 'manual'], [7, 6, 2, 'manual'], [8, 20, 1, 'manual']];
    var li = [];
    for (var k = 0; k < items.length; k++) {
      li.push({ id: items[k][0], list_id: 1, product_id: items[k][1], quantity: items[k][2], mode_override: null, source: items[k][3], added_at: 1763900000000 - k * 3600000 });
    }
    return { brands: b, products: products, list: { id: 1, status: 'open', items: li } };
  }

  var store = { data: null, subs: [], seq: 100 };

  function emit() {
    for (var i = 0; i < store.subs.length; i++) {
      try { store.subs[i](store.data); } catch (e) { /* one listener's problem */ }
    }
  }

  function brandFor(data, name) {
    var k = brandKey(name);
    if (!k) return null;
    for (var i = 0; i < data.brands.length; i++) if (data.brands[i].key === k) return data.brands[i].id;
    store.seq += 1;
    data.brands.push({ id: store.seq, name: name, key: k });
    return store.seq;
  }

  // plan-v2's auto-add: an owned, live product with auto_add on and at or
  // under restock_at gets one open-list row (source auto), never two.
  function autoAdd(data, p) {
    if (!p.owned || p.archived || !p.auto_add || p.quantity_remaining > p.restock_at) return;
    for (var i = 0; i < data.list.items.length; i++) if (data.list.items[i].product_id === p.id) return;
    store.seq += 1;
    data.list.items.unshift({ id: store.seq, list_id: data.list.id, product_id: p.id, quantity: p.purchase_quantity || 1,
      mode_override: null, source: 'auto', added_at: new Date().getTime() });
  }

  var api = {
    mock: true,

    // Fetch everything once; cb(err, data). data = { brands, products, list: { id, status, items } }.
    // REAL: read ctx.live.get('pantry') (and ctx.live.on('pantry', ...) to
    // keep store.data fresh and call emit()), or GET the Pi's screen route
    // for the pantry with ctx.getJSON(ctx.pi('/pantry/state')).
    load: function (ctx, cb) {
      if (!store.data) store.data = mockData();
      setTimeout(function () { cb(null, store.data); }, 0);
    },

    // The last data, or null before load.
    snapshot: function () { return store.data; },

    // changes: { field: value } already checked with clean(); brand is a name
    // (the Pi resolves it to brand_id by key). cb(err, product).
    // REAL: ctx.live.post('/pantry/products/' + id, changes, cb) and take
    // the answer's product (and list) into store.data, then emit().
    saveProduct: function (id, changes, cb) {
      var data = store.data;
      var p = null, i;
      for (i = 0; data && i < data.products.length; i++) if (data.products[i].id === id) p = data.products[i];
      if (!p) { setTimeout(function () { cb('not found'); }, 0); return; }
      var next = copy(p);
      for (var k in changes) {
        if (!Object.prototype.hasOwnProperty.call(changes, k)) continue;
        if (k === 'brand') next.brand_id = brandFor(data, changes[k]);
        else next[k] = changes[k];
      }
      if (changes.hasOwnProperty('quantity_remaining') && next.quantity_remaining > 0) next.owned = 1;
      data.products[data.products.indexOf(p)] = next;
      autoAdd(data, next);
      setTimeout(function () { cb(null, next); emit(); }, 0);
    },

    // fn(data) after every change.
    on: function (fn) { store.subs.push(fn); }
  };

  function brandName(data, p) {
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

  var Logic = {
    UNITS: UNITS, MODES: MODES, LOCATIONS: LOCATIONS, api: api, brandKey: brandKey, stateOf: stateOf,
    pantryOf: pantryOf, pantryCounts: pantryCounts, clean: clean, brandName: brandName, productById: productById,
    // For tests: start again from the mock data.
    reset: function () { store.data = mockData(); emit(); }
  };
  root.HUB_PANTRY = Logic;
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

  var LOC_EN = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry', other: 'Other' };
  function locWord(l) { return tr('pantry.loc.' + l, LOC_EN[l] || l); }
  var MODE_EN = { similar: 'Something similar', preselected: 'My pick', refund: 'Refund it', contact_me: 'Ask me' };
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
    var S = { C: null, panel: null, page: null, back: null, fitTimer: null, fitH: 0, fitCount: 0, saving: 0 };

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
        for (i = 0; i < d.list.items.length; i++) {
          var it = d.list.items[i];
          p = productById(d, it.product_id);
          if (!p) continue;
          out.push({ key: 'item:' + it.id, product: p, state: stateOf(p), item: it, qty: '×' + it.quantity });
        }
      }
      return out;
    }

    function title(p) {
      var b = brandName(data(), p);
      return b ? b + ' ' + p.name : p.name;
    }

    /* --- the tile --- */

    function tileRow(r, parent) {
      var row = el('div', 'pn-trow', null, parent);
      el('span', 'pn-tname', title(r.product), row);
      if (kind === 'pantry' && r.state === 'out') chip('out', row);
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
        el('div', 'pn-msg', one ? '–' : tr('pantry.loading', 'Loading…'), box);
        return;
      }
      var d = data();
      var c = pantryCounts(d.products);
      var big = kind === 'pantry' ? c.out : all.length;
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
        } else {
          el('span', 'pn-strip-num', tr('pantry.toBuyN', '{n} to buy', { n: all.length }), line);
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
        el('span', 'pn-hero-num', String(all.length), hero);
        el('span', 'pn-hero-cap', tr('pantry.toBuy', 'to buy'), hero);
        if (!all.length) { el('div', 'pn-hint', tr('pantry.listEmptyHint', 'Out items with auto-add on land here.'), box); return; }
      }
      var list = el('div', 'pn-tlist', null, box);
      var made = [];
      var show = kind === 'pantry' ? all.slice(0) : all;
      for (var i = 0; i < show.length; i++) made.push(tileRow(show[i], list));
      var footFor = function (n) { return n ? tr('pantry.more', '+{n} more', { n: n }) : ''; };
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

    function panelRow(r, parent) {
      var row = el('div', 'pn-row f', null, parent);
      row.setAttribute('data-key', r.key);
      row.setAttribute('role', 'button');
      var main = el('div', 'pn-row-main', null, row);
      var b = brandName(data(), r.product);
      el('span', 'pn-name', r.product.name, main);
      var meta = [];
      if (b) meta.push(b);
      if (sizeText(r.product)) meta.push(sizeText(r.product));
      if (kind === 'pantry') meta.push(locWord(r.product.location));
      el('span', 'pn-meta', meta.join(' · '), main);
      var side = el('div', 'pn-row-side', null, row);
      if (kind === 'list' && r.item.source === 'auto') chip('auto', side);
      if (r.state === 'out' || r.state === 'low') chip(r.state, side);
      if (r.qty) el('span', 'pn-qty', r.qty, side);
      if (S.back === r.key) row.setAttribute('data-autofocus', '');
      return row;
    }

    function renderList(box, ctx) {
      var all = rows();
      var d = data();
      if (kind === 'pantry') {
        var c = pantryCounts(d.products);
        ctx.setSub(tr('pantry.sub', '{n} items · {out} out · {low} low', { n: c.total, out: c.out, low: c.low }));
      } else {
        ctx.setSub(all.length ? tr('pantry.toBuyN', '{n} to buy', { n: all.length }) : tr('pantry.listEmpty', 'Nothing to buy'));
      }
      if (api.mock) el('div', 'pn-mock', tr('pantry.mock', 'Sample data: the pantry on the Pi is on its way.'), box);
      el('div', 'pn-tip', ctx.mode() === 'full' ? tr('pantry.tipFull', 'OK on a product to see and edit it.') : tr('pantry.tipPanel', 'OK on a product opens it full screen.'), box);
      var groups = kind === 'pantry'
        ? [['out', tr('pantry.secOut', 'Out')], ['low', tr('pantry.secLow', 'Running low')], ['ok', tr('pantry.secOk', 'In stock')]]
        : [['all', tr('pantry.secList', 'On the list')]];
      var first = true;
      for (var g = 0; g < groups.length; g++) {
        var mine = [];
        for (var i = 0; i < all.length; i++) if (groups[g][0] === 'all' || all[i].state === groups[g][0]) mine.push(all[i]);
        if (!mine.length) continue;
        var sec = el('div', 'pn-sec pn-sec-' + groups[g][0], null, box);
        var head = el('div', 'pn-sec-head', null, sec);
        el('span', 'pn-sec-name', groups[g][1], head);
        el('span', 'pn-sec-count', String(mine.length), head);
        var wrap = el('div', 'pn-rows', null, sec);
        for (var j = 0; j < mine.length; j++) {
          var row = panelRow(mine[j], wrap);
          if (first && !S.back) row.setAttribute('data-autofocus', '');
          first = false;
        }
      }
      if (first) el('div', 'pn-empty', kind === 'pantry' ? tr('pantry.pantryEmpty', 'Nothing in the pantry yet') : tr('pantry.listEmpty', 'Nothing to buy'), box);
      S.back = null;
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
      btn(parent, 'step:' + name + ':-1', '−', 'pn-step', tr('pantry.less', 'Less: {what}', { what: label }));
      input(parent, name, 'number', num(value), label);
      btn(parent, 'step:' + name + ':1', '+', 'pn-step', tr('pantry.more1', 'More: {what}', { what: label }));
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
      var Lres = tr('pantry.f.restock', 'Restock at');
      stepper(field(left, Lres, 'is-step'), 'restock_at', p.restock_at, Lres);
      var Lbuy = tr('pantry.f.buy', 'Buy quantity');
      stepper(field(left, Lbuy, 'is-step'), 'purchase_quantity', p.purchase_quantity, Lbuy);
      pills(field(left, tr('pantry.f.auto', 'Add to the list when low')), 'auto_add', ['1', '0'], p.auto_add ? '1' : '0',
        function (v) { return v === '1' ? tr('pantry.on', 'On') : tr('pantry.off', 'Off'); });
      pills(field(left, tr('pantry.f.location', 'Where it lives')), 'location', LOCATIONS, p.location, locWord);

      var Lb = tr('pantry.f.brand', 'Brand');
      input(field(right, Lb, 'is-text'), 'brand', 'text', b, Lb);
      var Ln = tr('pantry.f.name', 'Name');
      input(field(right, Ln, 'is-text'), 'name', 'text', p.name, Ln);
      var Ls = tr('pantry.f.size', 'Size');
      var sz = field(right, Ls, 'is-size');
      input(sz, 'size', 'number', p.size == null ? '' : num(p.size), Ls);
      pills(sz, 'unit', UNITS, p.unit, unitWord);
      pills(field(right, tr('pantry.f.mode', 'If the store is out')), 'substitution_mode', MODES, p.substitution_mode, modeWord);
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
        el('div', 'pn-msg pn-panel-msg hub-dormant', tr('pantry.loading', 'Loading…'), box);
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

    function save(ctx, changes) {
      var id = S.page;
      S.saving += 1;
      api.saveProduct(id, changes, function (err) {
        S.saving -= 1;
        if (err) ctx.toast(tr('pantry.saveFailed', 'That didn’t save: {why}', { why: String(err) }), 4500);
      });
    }

    function onSelect(target, ctx) {
      var k = target.getAttribute('data-key') || '';
      if (S.page === null) {
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
      whole: ['pantry.err.whole', 'Type a whole number, 1 or more']
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
        api.load(ctx, function (err) {
          if (err) { if (window.console && console.warn) console.warn('Pantry: no data (' + err + ')'); return; }
          refresh();
        });
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
      onClose: function () { S.panel = null; S.page = null; S.back = null; }
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

  // For the tests (dev/pantry-test.js).
  root.HUB_PANTRY_TV = { pantry: pantryWidget._state, list: listWidget._state };

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push(pantryWidget, listWidget);
})(typeof window !== 'undefined' ? window : this);
