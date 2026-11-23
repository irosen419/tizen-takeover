/*
 * TEST FIXTURE ONLY (dev/pantry-tv-test.js): a stand-in for app/live.js that
 * serves the Pi's live resource "pantry" in the shape pi/pantrydb.js view()
 * sends, and answers POST /pantry/screen-ops like pi/server.js (set, edit,
 * check, with auto-add after a quantity change). Never loaded by the hub
 * itself: the test serves it in place of live.js. Sample products only.
 *
 * window.PANTRY_STUB: data (the resource), posts (every body posted),
 * refuse ('' or the error the next posts get, HTTP 400), silent (no answer),
 * push() (send the resource to the listeners again).
 */
(function () {
  'use strict';

  var brands = [[1, 'Organic Valley'], [2, 'Kerrygold'], [3, 'Chobani'], [4, 'Barilla'], [5, 'Rao’s'], [6, 'King Arthur'],
    [7, 'Heinz'], [8, 'La Colombe'], [9, 'Goya'], [10, 'Cholula'], [11, 'Kirkland Signature'], [12, 'Dave’s Killer Bread'],
    [13, 'Simply'], [14, 'Tide'], [15, 'Mutti'], [16, 'Oatly']];
  // id, brandId, name, size, unit, location, qty, restockAt, buy, autoAdd, mode, owned, notes
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
  // list rows: id, productId, quantity, source, checked
  var list = [[1, 1, 2, 'auto', 0], [2, 4, 1, 'auto', 0], [3, 15, 6, 'manual', 0], [4, 14, 1, 'auto', 0], [5, 16, 1, 'auto', 0],
    [6, 19, 1, 'manual', 0], [7, 6, 2, 'manual', 0], [8, 20, 1, 'manual', 0]];

  var B = brands.map(function (b) { return { id: b[0], name: b[1], key: b[1].toLowerCase().replace(/[^a-z0-9 ]+/g, '') }; });
  var P = rows.map(function (r) {
    return { id: r[0], name: r[2], brand: r[1] ? brands[r[1] - 1][1] : '', brandId: r[1] || null, categoryIds: [], upc: '',
      size: r[3], unit: r[4], photo: '', notes: r[12], qty: r[6], restockAt: r[7], buy: r[8], autoAdd: !!r[9], held: false,
      mode: r[10], location: r[5], owned: !!r[11], low: false, onList: false, listItemId: null, checked: false, inCart: false,
      listSource: '', listQty: 0, modeOverride: null, replacements: [], updatedAt: 1763900000000 };
  });
  var L = list.map(function (l, i) {
    return { id: l[0], productId: l[1], quantity: l[2], modeOverride: null, source: l[3], addedAt: 1763900000000 - i * 3600000, groceryId: 'g' + l[0], checked: !!l[4] };
  });
  var seq = 100;

  function find(id) { for (var i = 0; i < P.length; i++) if (P[i].id === id) return P[i]; return null; }
  function rowOf(pid) { for (var i = 0; i < L.length; i++) if (L[i].productId === pid) return L[i]; return null; }

  // The derived fields pantrydb.js rowOut() fills in.
  function derive() {
    P.forEach(function (p) {
      var li = rowOf(p.id);
      p.low = p.owned && p.qty <= p.restockAt;
      p.onList = !!li; p.listItemId = li ? li.id : null; p.checked = !!(li && li.checked); p.inCart = p.checked;
      p.listSource = li ? li.source : ''; p.listQty = li ? li.quantity : 0;
    });
    var owned = P.filter(function (p) { return p.owned; });
    return {
      products: JSON.parse(JSON.stringify(P)), brands: B, categories: [], kinds: {}, list: JSON.parse(JSON.stringify(L)),
      counts: { items: owned.length, low: P.filter(function (p) { return p.low; }).length, onList: L.length }
    };
  }

  function bad(msg) { var e = new Error(msg); e.status = 400; return e; }

  function apply(ops) {
    var touched = [];
    ops.forEach(function (o) {
      var p;
      if (o.op === 'set') {
        p = find(o.id);
        if (!p) throw bad('no product has that id');
        if (typeof o.qty !== 'number' || o.qty < 0) throw bad('"qty" must be a number');
        p.qty = o.qty; p.owned = true; touched.push(p);
      } else if (o.op === 'edit') {
        p = find(o.id);
        if (!p) throw bad('no product has that id');
        ['name', 'size', 'unit', 'notes', 'location', 'restockAt', 'autoAdd'].forEach(function (k) { if (o[k] !== undefined) p[k] = o[k]; });
        if (o.purchaseQuantity !== undefined) p.buy = o.purchaseQuantity;
        if (o.substitutionMode !== undefined) p.mode = o.substitutionMode;
        if (o.brandId === null) { p.brand = ''; p.brandId = null; }
        if (o.brand !== undefined) {
          var k = String(o.brand).toLowerCase().replace(/[^a-z0-9 ]+/g, '');
          var hit = B.filter(function (b) { return b.key === k; })[0];
          if (!hit) { seq += 1; hit = { id: seq, name: o.brand, key: k }; B.push(hit); }
          p.brand = hit.name; p.brandId = hit.id;
        }
        touched.push(p);
      } else if (o.op === 'check') {
        var r = L.filter(function (x) { return x.id === o.list_item_id; })[0];
        if (!r) throw bad('no row on the open list has that id');
        r.checked = !!o.checked;
      } else {
        throw bad('unknown op');
      }
    });
    // Auto-add: owned, auto-add on, at or under the restock point, not on the list.
    touched.forEach(function (p) {
      if (p.owned && p.autoAdd && p.qty <= p.restockAt && !rowOf(p.id)) {
        seq += 1;
        L.push({ id: seq, productId: p.id, quantity: p.buy, modeOverride: null, source: 'auto', addedAt: Date.now(), groceryId: 'g' + seq, checked: false });
      }
    });
  }

  var listeners = {};
  var rev = 1;
  var stub = { data: derive(), posts: [], refuse: '', silent: false };

  function push() {
    rev += 1;
    stub.data = derive();
    (listeners.pantry || []).forEach(function (fn) { try { fn(stub.data, rev); } catch (e) { /* the widget's problem */ } });
  }
  stub.push = push;
  window.PANTRY_STUB = stub;

  window.HUB_LIVE = {
    version: 1,
    start: function () { return true; },
    stop: function () {},
    status: function () { return { state: 'live', text: 'Live', since: 0, epoch: 'stub' }; },
    get: function (name) { return name === 'pantry' ? stub.data : undefined; },
    rev: function () { return rev; },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () {}; },
    onCommand: function () {},
    onStatus: function () {},
    everConnected: function () { return true; },
    fetch: function (path, cb) { setTimeout(function () { cb('not in the stub', null, 404); }, 0); },
    post: function (path, body, cb) {
      stub.posts.push({ path: path, body: JSON.parse(JSON.stringify(body)) });
      if (stub.silent) { setTimeout(function () { cb('not reachable', null, 0); }, 150); return; }
      setTimeout(function () {
        if (path !== '/pantry/screen-ops') return cb('not found', { ok: false, error: 'not found' }, 404);
        if (stub.refuse) return cb(stub.refuse, { ok: false, error: stub.refuse }, 400);
        try { apply(body.ops || []); } catch (e) { return cb(e.message, { ok: false, error: e.message }, e.status || 500); }
        push();
        cb(null, { ok: true, rev: rev, data: stub.data, results: [], auto: 0, groceryAdded: 0 }, 200);
      }, 150);
    }
  };
})();
