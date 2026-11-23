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
    const db = p.db;
    const bad = [
      "UPDATE products SET unit = 'cup'", "UPDATE products SET location = 'garage'", "UPDATE products SET substitution_mode = 'any'",
      'UPDATE products SET purchase_quantity = 1.5', 'UPDATE products SET purchase_quantity = 0', 'UPDATE products SET quantity_remaining = -1',
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
    assert.deepStrictEqual(v.brands.map((b) => b.name), ['Heinz'], 'the first spelling is kept');
    assert.strictEqual(v.categories.filter((c) => c.key === 'condiments').length, 1);
    assert.strictEqual(v.products[0].brand, 'Heinz');
    assert.throws(() => p.applyOps([{ op: 'brand', name: '***' }], []), /letter or a number/);
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
    assert.deepStrictEqual(info.a, { fromPantry: true, reason: 'manual' });
    assert.deepStrictEqual(info.c, { fromPantry: false, reason: '' });
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
    assert.deepStrictEqual(Object.keys(bread).sort(), ['addedAt', 'brand', 'done', 'fromPantry', 'id', 'imagePath', 'name', 'productName', 'reason', 'search', 'size', 'source', 'upc']);
    // Removing the auto row while low holds it: the next drop does not re-add.
    r = await request(P, 'POST', '/grocery/ops', { headers: phone, body: { ops: [{ op: 'remove', id: eggs.id }] } });
    const pid = (await request(P, 'GET', '/api/pantry', { token: TOKEN })).json.data.products.find((x) => x.name === 'Eggs').id;
    r = await request(P, 'POST', '/pantry/ops', { headers: phone, body: { ops: [{ op: 'adjust', id: pid, by: -1 }] } });
    assert.strictEqual(r.json.auto, 0);
    r = await request(P, 'POST', '/pantry/ops', { headers: phone, body: { ops: [{ op: 'want', id: pid, on: true }] } });
    assert.strictEqual(r.json.groceryAdded, 1, 'the cart button still adds it by hand');
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
