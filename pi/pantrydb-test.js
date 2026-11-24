/*
 * Tests for the pantry (SQLite): node pi/pantrydb-test.js
 *
 * pantrydb.js on its own (schema and enums, name keys, brands and categories
 * never doubled, the one-time move from products.json and the grocery list,
 * auto-add when low with no doubles and the hold after a removal), then the
 * real server over HTTP: /api/pantry*, the touch route POST /pantry/ops with
 * the grocery Origin rules, /touch/state carrying the pantry, the grocery
 * list mirrored into the open list, the export's fromPantry and reason, and
 * a log that never names a product. Only Node, no packages.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pantrydb = require('./pantrydb');
const hubServer = require('./server');

const TOKEN = 'pantry-test-token-0123456789abcdef';
let passed = 0;
let failed = 0;
const dirs = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pantry-'));
  dirs.push(d);
  return d;
}

function mem(extra) { return pantrydb.createPantry(Object.assign({ file: ':memory:' }, extra || {})); }

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    const body = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function start(extra) {
  const lines = [];
  const opts = Object.assign({
    port: 0, token: TOKEN, dataDir: tmp(), log: (s) => lines.push(String(s)), products: { web: false },
    clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress
  }, extra || {});
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.lines = lines; h.dataDir = opts.dataDir; return h; });
}
const stop = (h) => new Promise((r) => h.close(r));

const COLA = '0036000291452';
const CHIPS = '0012345678905';

async function main() {
  if (!pantrydb.available()) {
    console.log('FAIL this Node has no node:sqlite (needs Node 22.13 or newer)');
    process.exit(1);
  }

  /* ---------- pantrydb.js ---------- */

  await check('keyOf: case, accents, "&" and punctuation fold to one key', () => {
    assert.strictEqual(pantrydb.keyOf('Heinz'), pantrydb.keyOf('  heinz '));
    assert.strictEqual(pantrydb.keyOf('Ben & Jerry’s'), pantrydb.keyOf("ben and jerrys"));
    assert.strictEqual(pantrydb.keyOf('Café Bustelo'), 'cafe bustelo');
    assert.strictEqual(pantrydb.keyOf('Coca-Cola'), pantrydb.keyOf('coca cola'));
    assert.strictEqual(pantrydb.keyOf('Ñandú'), 'nandu');
    assert.strictEqual(pantrydb.keyOf('!!!'), '');
  });

  await check('parseSize and guessKind (the restock defaults by kind)', () => {
    assert.deepStrictEqual(pantrydb.parseSize('12 fl oz'), { size: 12, unit: 'fl_oz' });
    assert.deepStrictEqual(pantrydb.parseSize('1,5 L'), { size: 1.5, unit: 'l' });
    assert.deepStrictEqual(pantrydb.parseSize('6 ct'), { size: 6, unit: 'count' });
    assert.deepStrictEqual(pantrydb.parseSize('about a pound'), { size: null, unit: null });
    assert.strictEqual(pantrydb.guessKind('Large brown eggs'), 'eggs');
    assert.strictEqual(pantrydb.guessKind('Bounty paper towels'), 'paper goods');
    assert.strictEqual(pantrydb.guessKind('Huevos'), 'eggs');
    assert.strictEqual(pantrydb.guessKind('Widget'), 'other');
    assert.strictEqual(pantrydb.guessKind('Anything', ['frozen']), 'frozen');
    assert.strictEqual(pantrydb.KINDS.eggs, 6);
    assert.strictEqual(pantrydb.KINDS['paper goods'], 1);
  });

  await check('schema: STRICT types, enums and ranges are enforced by the database itself', () => {
    const p = mem();
    p.applyOps([{ op: 'add', name: 'Rice' }], []);
    p.syncGrocery([], []);
    const db = p.db;
    const bad = [
      "UPDATE products SET unit = 'cup'", "UPDATE products SET location = 'garage'", "UPDATE products SET substitution_mode = 'any'",
      'UPDATE products SET purchase_quantity = 1.5', 'UPDATE products SET purchase_quantity = 0', 'UPDATE products SET quantity_remaining = -1',
      'UPDATE products SET quantity_remaining = 1.5', 'UPDATE products SET restock_at = 0.5',
      "UPDATE products SET quantity_remaining = 'lots'", 'UPDATE products SET owned = 2', "UPDATE products SET barcode = '12ab5678'",
      "INSERT INTO brands (name, key) VALUES ('X', '')", "INSERT INTO lists (status, created_at) VALUES ('open', 1)",
      "INSERT INTO lists (status, created_at) VALUES ('shipped', 1)", 'INSERT INTO category_products (category_id, product_id) VALUES (999, 1)'
    ];
    bad.forEach((sql) => assert.throws(() => db.prepare(sql).run(), /CHECK|cannot store|UNIQUE|FOREIGN KEY/, sql));
    assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepStrictEqual(pantrydb.UNITS, ['oz', 'fl_oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'count', 'pack']);
    const cats = p.view([]).data.categories.map((c) => c.name);
    assert.strictEqual(cats[0], 'Eggs');
    assert.strictEqual(cats.length, 13);
    p.close();
  });

  await check('an old "Milk" category becomes Dairy in place, keeping its products; yogurt and cheese guess Dairy', () => {
    const dir = tmp();
    let p = pantrydb.createPantry({ dataDir: dir });
    const cats = p.view([]).data.categories;
    assert(cats.some((c) => c.key === 'dairy' && c.name === 'Dairy') && !cats.some((c) => c.key === 'milk'), 'new database says Dairy');
    // Put a database back as the first build left it: Milk with a yogurt in it.
    const dairyId = cats.find((c) => c.key === 'dairy').id;
    p.applyOps([{ op: 'add', name: 'Greek yogurt', qty: 1, categoryIds: [dairyId] }], []);
    p.db.prepare("UPDATE categories SET name = 'Milk', key = 'milk' WHERE id = ?").run(dairyId);
    p.db.prepare("DELETE FROM meta WHERE key = 'dairyMigrated'").run();
    p.close();
    p = pantrydb.createPantry({ dataDir: dir });
    const after = p.view([]).data;
    assert.strictEqual(after.categories.filter((c) => c.key === 'dairy').length, 1);
    assert(!after.categories.some((c) => c.key === 'milk'), 'Milk is gone');
    const y = after.products.find((x) => x.name === 'Greek yogurt');
    assert.deepStrictEqual(y.categoryIds, [dairyId], 'the yogurt kept its category');
    p.close();
    // A Milk category made after the rename is left alone on the next start.
    p = pantrydb.createPantry({ dataDir: dir });
    p.applyOps([{ op: 'category', name: 'Milk' }], []);
    p.close();
    p = pantrydb.createPantry({ dataDir: dir });
    assert(p.view([]).data.categories.some((c) => c.key === 'milk'), 'own Milk kept');
    p.db.prepare("DELETE FROM categories WHERE key = 'milk'").run();
    p.close();
    // A second start changes nothing.
    p = pantrydb.createPantry({ dataDir: dir });
    assert.strictEqual(p.view([]).data.categories.length, 13);
    p.applyOps([{ op: 'add', name: 'Cheddar cheese', qty: 1 }, { op: 'add', name: 'Peanut butter', qty: 1 }], []);
    const v = p.view([]).data;
    const catOf = (n) => v.categories.filter((c) => v.products.find((x) => x.name === n).categoryIds.indexOf(c.id) >= 0).map((c) => c.key);
    assert.deepStrictEqual(catOf('Cheddar cheese'), ['dairy']);
    assert.deepStrictEqual(catOf('Peanut butter'), ['dry goods']);
    p.close();
  });

  await check('a file database uses WAL', () => {
    const p = pantrydb.createPantry({ dataDir: tmp() });
    assert.strictEqual(p.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    p.close();
  });

  await check('brands and categories: create or pick by key, never a second spelling', () => {
    const p = mem();
    let r = p.applyOps([{ op: 'brand', name: 'Heinz' }, { op: 'brand', name: ' heinz ' }, { op: 'brand', name: 'HEINZ!' }], []);
    assert.strictEqual(new Set(r.results.map((x) => x.id)).size, 1);
    r = p.applyOps([{ op: 'add', name: 'Ketchup', brand: 'heinz' }, { op: 'category', name: 'condiments' }, { op: 'category', name: 'Condiments' }], []);
    const v = p.view([]).data;
    assert.deepStrictEqual(v.brands.map((b) => b.name).filter((n) => n !== '***'), ['Heinz'], 'the first spelling is kept');
    assert.strictEqual(v.categories.filter((c) => c.key === 'condiments').length, 1);
    assert.strictEqual(v.products[0].brand, 'Heinz');
    const star = p.applyOps([{ op: 'brand', name: '***' }, { op: 'brand', name: ' *** ' }], []).results;
    assert.strictEqual(star[0].id, star[1].id, 'a brand of symbols only gets one stable key');
    assert.throws(() => p.applyOps([{ op: 'brand', name: '   ' }], []), /must not be empty/);
    assert.throws(() => p.applyOps([{ op: 'brand', name: 'x'.repeat(41) }], []), /at most 40/);
    // The same brand and name is one product: a second add counts up.
    r = p.applyOps([{ op: 'add', name: 'KETCHUP', brand: 'Heinz', qty: 2 }], []);
    assert.strictEqual(r.results[0].existed, true);
    assert.strictEqual(p.view([]).data.products.length, 1);
    assert.strictEqual(p.view([]).data.products[0].qty, 3);
    p.close();
  });

  await check('ops: adjust, set, edit with typed numbers and enums; wrong ops throw 400 and change nothing', () => {
    const p = mem();
    p.applyOps([{ op: 'add', name: 'Flour', qty: 3, location: 'pantry' }], []);
    const id = p.view([]).data.products[0].id;
    p.applyOps([{ op: 'adjust', id: id, by: -1 }, { op: 'edit', id: id, unit: 'lb', size: 5, purchaseQuantity: 2, substitutionMode: 'contact_me', category: 'Baking' }], []);
    let f = p.view([]).data.products[0];
    assert.strictEqual(f.qty, 2);
    assert.strictEqual(f.unit, 'lb');
    assert.strictEqual(f.buy, 2);
    assert.strictEqual(f.mode, 'contact_me');
    const cases = [
      [{ op: 'edit', id: id, unit: 'cup' }, /must be one of/], [{ op: 'edit', id: id, location: 'garage' }, /must be one of/],
      [{ op: 'edit', id: id, purchaseQuantity: 1.5 }, /whole number/], [{ op: 'set', id: id, qty: -1 }, /from 0/],
      [{ op: 'set', id: id, qty: '3' }, /must be a number/], [{ op: 'adjust', id: 999, by: 1 }, /no pantry product/],
      [{ op: 'edit', id: id, autoAdd: 'yes' }, /true or false/], [{ op: 'zap' }, /unknown op/], [{ op: 'set', id: id }, /needs "qty"/]
    ];
    cases.forEach(([o, re]) => {
      assert.throws(() => p.applyOps([{ op: 'adjust', id: id, by: 5 }, o], []), (e) => e.status === 400 && re.test(e.message), JSON.stringify(o));
    });
    f = p.view([]).data.products[0];
    assert.strictEqual(f.qty, 2, 'a failed batch is rolled back whole');
    assert.throws(() => p.applyOps(Array(51).fill({ op: 'brand', name: 'x' }), []), /at most 50/);
    p.close();
  });

  await check('auto-add: low -> one grocery row (no doubles); a removed auto row is held until stock rises once', () => {
    const p = mem();
    let r = p.applyOps([{ op: 'add', name: 'Eggs', qty: 12, location: 'fridge' }, { op: 'add', name: 'Paper towels', qty: 2 }], []);
    assert.strictEqual(r.auto, 0);
    const v = p.view([]).data.products;
    const eggs = v.find((x) => x.name === 'Eggs');
    const towels = v.find((x) => x.name === 'Paper towels');
    assert.strictEqual(eggs.restockAt, 6, 'eggs default to 6');
    assert.strictEqual(towels.restockAt, 1, 'paper towels default to 1: two rolls is not low');
    assert.strictEqual(towels.low, false);
    r = p.applyOps([{ op: 'set', id: eggs.id, qty: 2 }], []);
    assert.strictEqual(r.auto, 1);
    assert.deepStrictEqual(r.grocery, [{ op: 'add', name: 'Eggs' }]);
    const g = [{ id: 'g1', name: 'Eggs', done: false, addedAt: 5, upc: '' }];
    p.syncGrocery(g, r.hints);
    r = p.applyOps([{ op: 'adjust', id: eggs.id, by: -1 }], g);
    assert.strictEqual(r.auto, 0, 'already on the list');
    let e = p.view(g).data.products.find((x) => x.id === eggs.id);
    assert.strictEqual(e.onList, true);
    assert.strictEqual(e.listSource, 'auto');
    // The row leaves the list while still low: held, no nagging.
    assert.strictEqual(p.syncGrocery([], []), 1);
    r = p.applyOps([{ op: 'adjust', id: eggs.id, by: -1 }], []);
    assert.strictEqual(r.auto, 0, 'held');
    // Stock rises above 6 once, then drops: added again.
    p.applyOps([{ op: 'set', id: eggs.id, qty: 12 }], []);
    r = p.applyOps([{ op: 'set', id: eggs.id, qty: 6 }], []);
    assert.strictEqual(r.auto, 1);
    // auto_add off: low but never added.
    r = p.applyOps([{ op: 'edit', id: towels.id, autoAdd: false }, { op: 'set', id: towels.id, qty: 0 }], []);
    assert.strictEqual(r.auto, 0);
    assert.strictEqual(p.lowList().length, 2);
    p.close();
  });

  await check('want on and off; listQty and listMode on the open list', () => {
    const p = mem();
    p.applyOps([{ op: 'add', name: 'Salsa', brand: 'Herdez', qty: 3 }], []);
    const id = p.view([]).data.products[0].id;
    let r = p.applyOps([{ op: 'want', id: id, on: true }, { op: 'want', id: id, on: true }], []);
    assert.deepStrictEqual(r.grocery, [{ op: 'add', name: 'Herdez Salsa' }]);
    const g = [{ id: 'g7', name: 'Herdez Salsa', done: false, addedAt: 1, upc: '' }];
    p.syncGrocery(g, r.hints);
    p.applyOps([{ op: 'listQty', id: id, quantity: 3 }, { op: 'listMode', id: id, mode: 'refund' }], g);
    const s = p.view(g).data.products[0];
    assert.strictEqual(s.listQty, 3);
    assert.strictEqual(s.modeOverride, 'refund');
    assert.strictEqual(s.listSource, 'manual');
    r = p.applyOps([{ op: 'want', id: id, on: false }], g);
    assert.deepStrictEqual(r.grocery, [{ op: 'remove', id: 'g7' }]);
    assert.throws(() => p.applyOps([{ op: 'listMode', id: id, mode: 'swap' }], g), /must be one of/);
    p.close();
  });

  await check('list_items.checked: op check ticks a row and its grocery row; a grocery tick is mirrored back', () => {
    const p = mem();
    p.applyOps([{ op: 'add', name: 'Rice', qty: 1 }], []);
    const id = p.view([]).data.products[0].id;
    const r = p.applyOps([{ op: 'want', id: id, on: true }], []);
    let g = [{ id: 'g1', name: 'Rice', done: false, addedAt: 1, upc: '' }];
    p.syncGrocery(g, r.hints);
    let v = p.view(g).data;
    assert.strictEqual(v.list.length, 1);
    assert.strictEqual(v.list[0].checked, false);
    const li = v.list[0].id;
    assert.strictEqual(v.products[0].listItemId, li);
    const c = p.applyOps([{ op: 'check', list_item_id: li, checked: true }], g);
    assert.deepStrictEqual(c.grocery, [{ op: 'check', id: 'g1', done: true }]);
    v = p.view(g).data;
    assert.strictEqual(v.list[0].checked, true);
    assert.strictEqual(v.products[0].inCart, true);
    // The grocery list unticks it (phone or TV): mirrored back.
    g = [{ id: 'g1', name: 'Rice', done: false, addedAt: 1, upc: '' }];
    p.syncGrocery(g, []);
    assert.strictEqual(p.view(g).data.list[0].checked, false);
    g[0].done = true;
    p.syncGrocery(g, []);
    assert.strictEqual(p.view(g).data.list[0].checked, true);
    assert.throws(() => p.applyOps([{ op: 'check', list_item_id: 999, checked: true }], g), /no row on the open list/);
    assert.throws(() => p.applyOps([{ op: 'check', list_item_id: li, checked: 1 }], g), /true or false/);
    assert.throws(() => p.db.prepare('UPDATE list_items SET checked = 2').run(), /CHECK/);
    p.close();
  });

  await check('an older pantry.db without list_items.checked gets the column', () => {
    const dir = tmp();
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(path.join(dir, 'pantry.db'));
    old.exec('CREATE TABLE list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, mode_override TEXT, source TEXT NOT NULL DEFAULT \'manual\', added_at INTEGER NOT NULL, grocery_id TEXT UNIQUE) STRICT');
    old.close();
    const p = pantrydb.createPantry({ dataDir: dir });
    assert.ok(p.db.prepare('PRAGMA table_info(list_items)').all().some((c) => c.name === 'checked'));
    p.close();
  });

  await check('syncGrocery: typed rows link to one product by key, scanned rows by code; export info', () => {
    const p = mem({ catalogGet: (upc) => (upc === COLA ? { upc: COLA, brand: 'Fizz Co', name: 'Cola', size: '12 fl oz', image: '' } : null) });
    p.applyOps([{ op: 'add', name: 'Café', qty: 1 }], []);
    const g = [
      { id: 'a', name: 'cafe', done: false, addedAt: 1, upc: '' },
      { id: 'b', name: 'Fizz Co Cola', done: true, addedAt: 2, upc: COLA },
      { id: 'c', name: 'Bread', done: false, addedAt: 3, upc: '' }
    ];
    p.syncGrocery(g, []);
    const v = p.view(g).data;
    assert.strictEqual(v.products.filter((x) => pantrydb.keyOf(x.name) === 'cafe').length, 1, 'cafe matched Café');
    const cola = v.products.find((x) => x.upc === COLA);
    assert.strictEqual(cola.brand, 'Fizz Co');
    assert.strictEqual(cola.size, 12);
    assert.strictEqual(cola.unit, 'fl_oz');
    assert.strictEqual(cola.inCart, true);
    assert.strictEqual(cola.owned, false, 'on the list is not in the pantry');
    const info = p.groceryInfo();
    assert.deepStrictEqual(info.a, { store: '', fromPantry: true, reason: 'manual' });
    assert.deepStrictEqual(info.c, { store: '', fromPantry: false, reason: '' });
    // A preferred store set on the phone shows in the view and on the export row's info.
    const cafe = v.products.find((x) => pantrydb.keyOf(x.name) === 'cafe');
    p.applyOps([{ op: 'edit', id: cafe.id, preferredStore: '  CVS ' }], g);
    assert.strictEqual(p.view(g).data.products.find((x) => x.id === cafe.id).store, 'CVS');
    assert.strictEqual(p.groceryInfo().a.store, 'CVS');
    p.syncGrocery(g, []);
    assert.strictEqual(p.db.prepare('SELECT COUNT(*) AS n FROM list_items').get().n, 3, 'mirroring again adds nothing');
    p.close();
  });

  await check('migrate: products.json and the grocery list move once; the JSON is kept as a backup', () => {
    const dir = tmp();
    const productsFile = path.join(dir, 'products.json');
    fs.writeFileSync(productsFile, JSON.stringify({ v: 1, products: {
      [COLA]: { upc: COLA, brand: 'Fizz Co', name: 'Cola', size: '12 fl oz', source: 'off', image: '/products/image/x', addedAt: 1, updatedAt: 1 },
      [CHIPS]: { upc: CHIPS, brand: 'fizz co', name: 'Chips', size: '', source: 'manual', image: '', addedAt: 1, updatedAt: 1 },
      bad: { name: 'x' }
    } }));
    const before = fs.readFileSync(productsFile, 'utf8');
    const items = [{ id: 'g1', name: 'Milk', done: false, addedAt: 1, upc: '' }, { id: 'g2', name: 'Fizz Co Cola', done: false, addedAt: 2, upc: COLA }];
    let p = pantrydb.createPantry({ dataDir: dir });
    const m = p.migrate({ productsFile: productsFile, groceryItems: items, backupDir: path.join(dir, 'pantry-backup') });
    assert.deepStrictEqual(m, { products: 2, grocery: 2, skipped: false });
    const v = p.view(items).data;
    assert.strictEqual(v.brands.length, 1, '"Fizz Co" and "fizz co" are one brand');
    assert.strictEqual(v.products.length, 2, 'the list rows; catalog-only products stay out of the view');
    assert.ok(fs.existsSync(path.join(dir, 'pantry-backup', 'products.json')));
    assert.ok(fs.existsSync(path.join(dir, 'pantry-backup', 'grocery.json')));
    assert.strictEqual(fs.readFileSync(productsFile, 'utf8'), before, 'products.json is never changed');
    p.close();
    p = pantrydb.createPantry({ dataDir: dir });
    assert.strictEqual(p.migrate({ productsFile: productsFile, groceryItems: items }).skipped, true, 'once only');
    assert.strictEqual(p.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 3);
    p.close();
  });

  await check('review 1: non-Latin and emoji names get a key; one bad row never stops a mirror or the move', () => {
    assert.strictEqual(pantrydb.keyOf('牛奶'), '牛奶');
    assert.strictEqual(pantrydb.keyOf('Молоко!'), 'молоко');
    assert.strictEqual(pantrydb.keyOf('🥚'), '');
    const p = mem();
    let r = p.applyOps([{ op: 'add', name: '🥚', qty: 3 }, { op: 'add', name: '牛奶', qty: 2 }, { op: 'add', name: ' 🥚 ' }], []);
    assert.strictEqual(r.results[2].existed, true, 'the emoji name has a stable key');
    assert.strictEqual(p.view([]).data.products.length, 2);
    assert.ok(p.find('牛奶'));
    const g = [{ id: 'g1', name: '🍞', done: false, addedAt: 1, upc: '' }, { id: 'g2', name: 42, done: false, addedAt: 2, upc: '' }, { id: 'g3', name: 'Milk', done: false, addedAt: 3, upc: '' }];
    assert.doesNotThrow(() => p.syncGrocery(g, []));
    const rows = p.db.prepare('SELECT grocery_id FROM list_items ORDER BY grocery_id').all().map((x) => x.grocery_id);
    assert.deepStrictEqual(rows, ['g1', 'g3'], 'the bad row is skipped, the rest mirror');
    p.close();
    // The move: an emoji-only catalog name moves too.
    const dir = tmp();
    const file = path.join(dir, 'products.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, products: { [COLA]: { name: '🥤', brand: '' }, [CHIPS]: { name: 'Chips', brand: '' } } }));
    const q = pantrydb.createPantry({ dataDir: dir });
    const m = q.migrate({ productsFile: file, groceryItems: [{ id: 'g1', name: '🥤', done: false, addedAt: 1, upc: '' }, { id: 'g2', name: null, done: false, addedAt: 1, upc: '' }] });
    assert.strictEqual(m.products, 2);
    assert.strictEqual(q.db.prepare("SELECT value FROM meta WHERE key = 'migrated.grocery'").get() !== undefined, true);
    q.close();
  });

  await check('review 2: no auto-add on the add that makes a product, nor when it was already low; a drop adds it', () => {
    const p = mem();
    let r = p.applyOps([{ op: 'add', name: 'Rice', qty: 1 }], []);
    assert.strictEqual(r.auto, 0, 'qty 1 at restock 1 on creation: low badge, no row');
    const rice = p.view([]).data.products[0];
    assert.strictEqual(rice.low, true);
    r = p.applyOps([{ op: 'edit', id: rice.id, location: 'other' }, { op: 'add', name: 'Rice', qty: 0 }], []);
    assert.strictEqual(r.auto, 0, 'already low: no transition');
    r = p.applyOps([{ op: 'add', name: 'Eggs', qty: 2 }], []);
    assert.strictEqual(r.auto, 0, 'eggs at 2 (restock 6) on creation: low, not added');
    const eggs = p.view([]).data.products.find((x) => x.name === 'Eggs');
    assert.strictEqual(eggs.low, true);
    p.applyOps([{ op: 'set', id: eggs.id, qty: 8 }], []);
    r = p.applyOps([{ op: 'adjust', id: eggs.id, by: -2 }], []);
    assert.strictEqual(r.auto, 1, '8 -> 6 drops to the restock point');
    // Removed then added again: a fresh add, no row.
    p.applyOps([{ op: 'set', id: rice.id, qty: 5 }, { op: 'remove', id: rice.id }], []);
    r = p.applyOps([{ op: 'add', name: 'Rice', qty: 1 }], []);
    assert.strictEqual(r.auto, 0);
    p.close();
  });

  await check('review 3: a damaged products.json is backed up, logged without names and left for the next start', () => {
    const dir = tmp();
    const file = path.join(dir, 'products.json');
    const lines = [];
    fs.writeFileSync(file, '{"v":1,"products":{"' + COLA + '":{"name":"Secret Cola"');
    let p = pantrydb.createPantry({ dataDir: dir, log: (x) => lines.push(x) });
    let m = p.migrate({ productsFile: file, groceryItems: [], backupDir: path.join(dir, 'pantry-backup') });
    assert.strictEqual(m.products, 0);
    assert.strictEqual(p.db.prepare("SELECT value FROM meta WHERE key = 'migrated.products'").get(), undefined, 'not marked');
    assert.ok(fs.existsSync(path.join(dir, 'pantry-backup', 'products.json')), 'the copy is made before the parse');
    assert.ok(lines.some((x) => /damaged/.test(x)) && !lines.some((x) => /Secret|Cola|0036/.test(x)));
    // Fixed by the next start: it moves then.
    fs.writeFileSync(file, JSON.stringify({ v: 1, products: { [COLA]: { name: 'Cola', brand: '' } } }));
    m = p.migrate({ productsFile: file, groceryItems: [] });
    assert.strictEqual(m.products, 1);
    assert.ok(p.db.prepare("SELECT value FROM meta WHERE key = 'migrated.products'").get());
    p.close();
    // No file at all: nothing to move, marked done.
    const d2 = tmp();
    p = pantrydb.createPantry({ dataDir: d2 });
    p.migrate({ productsFile: path.join(d2, 'products.json'), groceryItems: [] });
    assert.ok(p.db.prepare("SELECT value FROM meta WHERE key = 'migrated.products'").get());
    p.close();
  });

  await check('review 4: counts and restock points are whole numbers (INTEGER); sizes stay decimal, half gallons read', () => {
    const p = mem();
    const bad = [{ op: 'add', name: 'Milk', qty: 1.5 }, { op: 'add', name: 'Milk', restockAt: 0.5 }];
    bad.forEach((o) => assert.throws(() => p.applyOps([o], []), /whole number/, JSON.stringify(o)));
    p.applyOps([{ op: 'add', name: 'Milk', qty: 2 }], []);
    const id = p.view([]).data.products[0].id;
    [{ op: 'adjust', id: id, by: -0.5 }, { op: 'set', id: id, qty: 1.25 }, { op: 'set', id: id, restockAt: 2.5 }, { op: 'edit', id: id, restockAt: 0.1 }]
      .forEach((o) => assert.throws(() => p.applyOps([o], []), /whole number/, JSON.stringify(o)));
    p.applyOps([{ op: 'edit', id: id, size: 0.5, unit: 'gal' }], []);
    assert.strictEqual(p.view([]).data.products[0].size, 0.5);
    const cols = p.db.prepare('PRAGMA table_info(products)').all();
    assert.strictEqual(cols.find((c) => c.name === 'quantity_remaining').type, 'INTEGER');
    assert.strictEqual(cols.find((c) => c.name === 'restock_at').type, 'INTEGER');
    assert.deepStrictEqual(pantrydb.parseSize('½ gal'), { size: 0.5, unit: 'gal' });
    assert.deepStrictEqual(pantrydb.parseSize('1/2 gallon'), { size: 0.5, unit: 'gal' });
    assert.deepStrictEqual(pantrydb.parseSize('1 1/2 lb'), { size: 1.5, unit: 'lb' });
    assert.deepStrictEqual(pantrydb.parseSize('1/0 gal'), { size: null, unit: null });
    p.close();
  });

  await check('review 5: a 60-character name counts code points the same in grocery.js and lineName', () => {
    const grocery = require('./grocery');
    const name = '🥚'.repeat(grocery.MAX_NAME);
    assert.strictEqual(pantrydb.lineName('', name), name);
    const l = grocery.applyOps([], [{ op: 'add', name: name }], 1);
    assert.strictEqual(l[0].name, name, 'grocery takes what lineName makes');
    assert.throws(() => grocery.applyOps([], [{ op: 'add', name: name + '🥚' }], 1), /at most 60/);
    const long = pantrydb.lineName('Brand', '🥚'.repeat(70));
    assert.doesNotThrow(() => grocery.applyOps([], [{ op: 'add', name: long }], 1));
  });

  /* ---------- the server ---------- */

  const h = await start();
  const P = h.port;
  const phone = { 'x-test-ip': '192.168.1.30', Host: '192.168.1.219:8097', Origin: 'http://192.168.1.219:8097' };

  await check('control API: /api/pantry, /api/pantry/ops, /api/pantry/low need the token', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/pantry')).status, 401);
    let r = await request(P, 'POST', '/api/pantry/ops', { token: TOKEN, body: { ops: [{ op: 'add', name: 'Eggs', qty: 12, location: 'fridge' }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.data.products[0].restockAt, 6);
    r = await request(P, 'POST', '/api/pantry/ops', { token: TOKEN, body: { ops: [{ op: 'add', name: 'Eggs', location: 'garage' }] } });
    assert.strictEqual(r.status, 400);
    r = await request(P, 'GET', '/api/pantry', { token: TOKEN });
    assert.strictEqual(r.json.data.counts.items, 1);
    r = await request(P, 'GET', '/api/pantry/low', { token: TOKEN });
    assert.deepStrictEqual(r.json.items, []);
    assert.strictEqual((await request(P, 'POST', '/api/pantry', { token: TOKEN, body: {} })).status, 405);
  });

  await check('touch: POST /pantry/ops (Origin rules as grocery), auto-add lands on the grocery list, /touch/state carries both', async () => {
    let r = await request(P, 'GET', '/touch/state', { headers: phone });
    const eggs = r.json.pantry.data.products.find((x) => x.name === 'Eggs');
    assert.ok(r.json.pantry.rev > 0);
    r = await request(P, 'POST', '/pantry/ops', { headers: Object.assign({}, phone, { Origin: 'http://evil.example' }), body: { ops: [{ op: 'set', id: eggs.id, qty: 1 }] } });
    assert.strictEqual(r.status, 403);
    r = await request(P, 'POST', '/pantry/ops', { headers: Object.assign({}, phone, { 'x-test-ip': '8.8.8.8' }), body: { ops: [{ op: 'set', id: eggs.id, qty: 1 }] } });
    assert.strictEqual(r.status, 403);
    r = await request(P, 'OPTIONS', '/pantry/ops', { headers: { Origin: 'http://127.0.0.1:8081', 'x-test-ip': '192.168.1.50' } });
    assert.strictEqual(r.status, 204);
    r = await request(P, 'POST', '/pantry/ops', { headers: phone, body: { ops: [{ op: 'set', id: eggs.id, qty: 2 }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.auto, 1);
    r = await request(P, 'GET', '/touch/state', { headers: phone });
    assert.deepStrictEqual(r.json.grocery.data.items.map((i) => i.name), ['Eggs']);
    const e2 = r.json.pantry.data.products.find((x) => x.id === eggs.id);
    assert.strictEqual(e2.onList, true);
    assert.strictEqual(e2.low, true);
    assert.strictEqual(r.json.pantry.data.counts.low, 1);
  });

  await check('grocery changes mirror into the open list; the export gains fromPantry and reason only', async () => {
    let r = await request(P, 'POST', '/grocery/ops', { headers: phone, body: { ops: [{ op: 'add', name: 'Bread' }] } });
    assert.strictEqual(r.status, 200);
    r = await request(P, 'GET', '/api/grocery/export', { token: TOKEN });
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['counts', 'generatedAt', 'items', 'ok']);
    assert.deepStrictEqual(r.json.counts, { left: 2, ticked: 0, fromPantry: 1 });
    const eggs = r.json.items.find((i) => i.name === 'Eggs');
    const bread = r.json.items.find((i) => i.name === 'Bread');
    assert.deepStrictEqual([eggs.fromPantry, eggs.reason], [true, 'low']);
    assert.deepStrictEqual([bread.fromPantry, bread.reason], [false, '']);
    assert.deepStrictEqual(Object.keys(bread).sort(), ['addedAt', 'brand', 'done', 'fromPantry', 'id', 'imagePath', 'name', 'productName', 'reason', 'search', 'size', 'source', 'store', 'upc']);
    // Removing the auto row while low holds it: the next drop does not re-add.
    r = await request(P, 'POST', '/grocery/ops', { headers: phone, body: { ops: [{ op: 'remove', id: eggs.id }] } });
    const pid = (await request(P, 'GET', '/api/pantry', { token: TOKEN })).json.data.products.find((x) => x.name === 'Eggs').id;
    r = await request(P, 'POST', '/pantry/ops', { headers: phone, body: { ops: [{ op: 'adjust', id: pid, by: -1 }] } });
    assert.strictEqual(r.json.auto, 0);
    r = await request(P, 'POST', '/pantry/ops', { headers: phone, body: { ops: [{ op: 'want', id: pid, on: true }] } });
    assert.strictEqual(r.json.groceryAdded, 1, 'the cart button still adds it by hand');
  });

  await check('the TV: POST /pantry/screen-ops (no token, listed Origin, preflight), pantry is a live resource in /live/state and /live/poll', async () => {
    const tv = { Origin: 'http://127.0.0.1:8081', 'x-test-ip': '192.168.1.50' };
    let r = await request(P, 'OPTIONS', '/pantry/screen-ops', { headers: tv });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
    assert.ok(/POST/.test(r.headers['access-control-allow-methods']));
    r = await request(P, 'OPTIONS', '/pantry/screen-ops', { headers: { Origin: 'http://evil.example', 'x-test-ip': '192.168.1.50' } });
    assert.ok(!r.headers['access-control-allow-origin'], 'no CORS header for a foreign site');
    r = await request(P, 'GET', '/live/state', { headers: { 'x-test-ip': '192.168.1.50' } });
    assert.strictEqual(r.status, 200);
    const live = r.json.resources.pantry;
    assert.ok(live && typeof live.rev === 'number' && Array.isArray(live.data.products) && Array.isArray(live.data.list), 'pantry resource');
    const rice = live.data.products.find((x) => x.name === 'Eggs');
    const before = r.json.rev;
    r = await request(P, 'POST', '/pantry/screen-ops', { headers: Object.assign({}, tv, { Origin: 'http://evil.example' }), body: { ops: [{ op: 'adjust', id: rice.id, by: 1 }] } });
    assert.strictEqual(r.status, 403);
    r = await request(P, 'POST', '/pantry/screen-ops', { headers: Object.assign({}, tv, { 'x-test-ip': '8.8.8.8' }), body: { ops: [{ op: 'adjust', id: rice.id, by: 1 }] } });
    assert.strictEqual(r.status, 403);
    r = await request(P, 'POST', '/pantry/screen-ops', { headers: tv, body: { ops: [{ op: 'adjust', id: rice.id, by: 1 }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.headers['access-control-allow-origin'], 'http://127.0.0.1:8081');
    assert.ok(r.json.rev > before, 'rev moved');
    r = await request(P, 'GET', '/live/poll?rev=' + before + '&epoch=' + encodeURIComponent((await request(P, 'GET', '/live/state', { headers: { 'x-test-ip': '192.168.1.50' } })).json.epoch) + '&wait=0', { headers: { 'x-test-ip': '192.168.1.50' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.resources && r.json.resources.pantry, 'the poll carries the changed pantry: ' + Object.keys(r.json.resources || {}).join(','));
    // A list row ticked from the TV ticks the grocery row too.
    const p2 = r.json.resources.pantry.data.products.find((x) => x.listItemId);
    r = await request(P, 'POST', '/pantry/screen-ops', { headers: tv, body: { ops: [{ op: 'check', list_item_id: p2.listItemId, checked: true }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const g = (await request(P, 'GET', '/api/grocery', { token: TOKEN })).json.items;
    const row = r.json.data.list.find((x) => x.id === p2.listItemId);
    assert.ok(row.checked && g.find((i) => i.id === row.groceryId).done, 'grocery row ticked');
    assert.ok(h.lines.some((l) => /screen changed the pantry/.test(l)), 'logged as a screen');
  });

  await check('review 6: when the live copy cannot be saved, the answer still carries the fresh pantry and the next read catches up', async () => {
    const hx = await start();
    const P2 = hx.port;
    let r = await request(P2, 'POST', '/api/pantry/ops', { token: TOKEN, body: { ops: [{ op: 'add', name: 'Flour', qty: 4 }] } });
    const id = r.json.data.products[0].id;
    // Block the state file's save: its temp name is a folder now.
    const block = path.join(hx.dataDir, 'state.json.tmp-' + process.pid);
    fs.mkdirSync(block);
    r = await request(P2, 'POST', '/api/pantry/ops', { token: TOKEN, body: { ops: [{ op: 'set', id: id, qty: 3 }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.data.products[0].qty, 3, 'the answer has the database as it is');
    assert.ok(hx.lines.some((x) => /live copy could not be saved/.test(x)));
    fs.rmdirSync(block);
    r = await request(P2, 'GET', '/api/pantry', { token: TOKEN });
    assert.strictEqual(r.json.data.products[0].qty, 3);
    const live = JSON.parse(fs.readFileSync(path.join(hx.dataDir, 'state.json'), 'utf8'));
    assert.strictEqual(live.resources.pantry.data.products[0].qty, 3, 'the retry saved the live copy');
    await stop(hx);
  });

  await check('the log counts pantry changes, never a product or brand name', async () => {
    await request(P, 'POST', '/pantry/ops', { headers: phone, body: { ops: [{ op: 'add', name: 'Secret Sauce', brand: 'Hidden Brand', qty: 0 }] } });
    const text = h.lines.join('\n');
    assert.ok(/touch app changed the pantry/.test(text));
    assert.ok(/pantry: 1 low item added to grocery/.test(text), text);
    ['Secret Sauce', 'Hidden Brand', 'Eggs', 'Bread'].forEach((w) => assert.ok(text.indexOf(w) < 0, w + ' in the log'));
  });

  await check('a restart keeps the pantry; a server with pantry off still runs grocery', async () => {
    const dir = h.dataDir;
    await stop(h);
    const h2 = await start({ dataDir: dir });
    const r = await request(h2.port, 'GET', '/api/pantry', { token: TOKEN });
    assert.ok(r.json.data.products.some((x) => x.name === 'Eggs'));
    await stop(h2);
    const h3 = await start({ pantry: false });
    assert.strictEqual((await request(h3.port, 'GET', '/api/pantry', { token: TOKEN })).status, 503);
    assert.strictEqual((await request(h3.port, 'POST', '/grocery/ops', { headers: phone, body: { ops: [{ op: 'add', name: 'Milk' }] } })).status, 200);
    const s = await request(h3.port, 'GET', '/touch/state', { headers: phone });
    assert.strictEqual(s.json.pantry.off, true);
    await stop(h3);
  });

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
