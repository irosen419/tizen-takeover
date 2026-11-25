/*
 * The pantry: what is at home, and the shopping lists, in SQLite
 * (<dataDir>/pantry.db) through Node's built-in node:sqlite (Node 22.13 or
 * newer, no npm package). WAL journal, foreign keys on, STRICT tables.
 *
 *   brands(id, name, key UNIQUE)            key = keyOf(name): lowercase,
 *   categories(id, name, key UNIQUE, sort)  accents and punctuation stripped,
 *   category_products(category_id, product_id)   so "Heinz" and "heinz" are
 *                                           one brand; name keeps the first spelling
 *   products(...)                           every thing ever bought or kept;
 *                                           the pantry is a filter (owned = 1)
 *   replacements(product_id, replacement_id, rank 1-5)
 *   lists(id, status open|ordered, ...)     one open list at a time
 *   list_items(list_id, product_id, quantity, mode_override, source, added_at, grocery_id, checked)
 *                                           checked = ticked while shopping; it follows the
 *                                           grocery row's tick both ways
 *
 * The grocery list (pi/grocery.js, resource "grocery" in state.json) stays
 * the list the TV, the phone, ./hub and the mailbox change; every change is
 * mirrored into the open list here (syncGrocery), one list_items row per
 * grocery row (grocery_id), so a grocery row always points at a product.
 * Pantry ops that put something on the list (want, auto-add) answer with the
 * grocery ops to run; server.js runs them and mirrors the result back.
 *
 * Auto-add: when a quantity drops to or under restock_at (it was above it
 * before the change), an owned, not archived product with auto_add = 1 gets
 * one grocery row (source auto), never a second. The add that first puts a
 * product in the pantry never adds a row, even at its restock point. When an auto row leaves the list while the
 * product is still low, auto_held = 1 and it is not added again until the
 * quantity has gone above restock_at once.
 *
 * Nothing here logs a product name, a brand or a barcode: counts only.
 * Tests: node pi/pantrydb-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Loaded on first use, so ./hub (which only needs keyOf) never touches it.
let sqlite;
function loadSqlite() {
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }
  }
  return sqlite;
}

const UNITS = ['oz', 'fl_oz', 'lb', 'g', 'kg', 'ml', 'l', 'gal', 'count', 'pack'];
const MODES = ['similar', 'preselected', 'refund', 'contact_me'];
const LOCATIONS = ['fridge', 'freezer', 'pantry', 'bathroom', 'other'];
const SOURCES = ['manual', 'auto'];
const MAX_PRODUCTS = 5000;
const MAX_OPS = 50;
const MAX_BRAND = 40;
const MAX_CATEGORY = 40;
const MAX_NAME = 80;
const MAX_NOTES = 300;
const MAX_STORE = 40;
const MAX_QTY = 9999;
const MAX_RESTOCK = 999;
const MAX_BUY = 99;
const MAX_VIEW = 1000;
const LINE_MAX = 60; // a grocery row's name (grocery.js MAX_NAME)
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

// Starting "buy more at" by kind of item; every product can change its own.
const KINDS = {
  eggs: 6, dairy: 1, bread: 1, produce: 1, meat: 1,
  frozen: 2, canned: 2, 'dry goods': 2, snacks: 2, drinks: 2,
  'paper goods': 1, cleaning: 1, other: 1
};
// The categories a new database starts with (one per kind), in this order.
const SEED_CATEGORIES = ['Eggs', 'Dairy', 'Bread', 'Produce', 'Meat', 'Frozen', 'Canned', 'Dry goods', 'Snacks', 'Drinks', 'Paper goods', 'Cleaning', 'Other'];
// Words that guess a kind from a product's name (English and Spanish).
const KIND_WORDS = {
  eggs: ['egg', 'eggs', 'huevo', 'huevos'],
  dairy: ['dairy', 'milk', 'leche', 'creamer', 'half and half', 'yogurt', 'yoghurt', 'cheese', 'queso', 'butter', 'mantequilla', 'sour cream', 'cream cheese'],
  bread: ['bread', 'bagel', 'bagels', 'bun', 'buns', 'tortilla', 'tortillas', 'pan', 'muffins'],
  produce: ['apple', 'apples', 'banana', 'bananas', 'lettuce', 'spinach', 'tomato', 'tomatoes', 'onion', 'onions', 'potato', 'potatoes', 'avocado', 'avocados', 'lemon', 'lemons', 'lime', 'limes', 'berries', 'strawberries', 'carrot', 'carrots', 'pepper', 'peppers', 'fruit', 'garlic', 'cilantro'],
  meat: ['chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'ham', 'steak', 'salmon', 'fish', 'shrimp', 'pollo', 'carne'],
  frozen: ['frozen', 'ice cream', 'pizza'],
  canned: ['canned', 'can', 'beans', 'soup', 'tuna'],
  'dry goods': ['peanut butter', 'almond butter', 'cashew butter', 'apple butter', 'nut butter', 'mantequilla de mani', 'rice', 'pasta', 'flour', 'sugar', 'cereal', 'oats', 'oatmeal', 'arroz', 'noodles'],
  snacks: ['chips', 'crackers', 'cookies', 'snack', 'snacks', 'popcorn', 'nuts', 'pretzels'],
  drinks: ['water', 'juice', 'soda', 'coffee', 'tea', 'beer', 'wine', 'sparkling', 'cola'],
  'paper goods': ['paper towels', 'paper towel', 'toilet paper', 'napkins', 'tissues', 'paper'],
  cleaning: ['detergent', 'soap', 'bleach', 'cleaner', 'sponges', 'dish', 'trash bags', 'wipes']
};

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/* ---------- text ---------- */

// The matching key: lowercase, accents stripped, "&" read as "and",
// apostrophes dropped, other punctuation and spaces folded to one space.
// Letters and digits of any script stay ("牛奶", "молоко").
function keyOf(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/['\u2018\u2019`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// The key a store is matched by: keyOf without spaces, so "TomThumb" and
// "Tom Thumb" are one store. Empty for text with no letter or digit.
function storeKey(s) { return keyOf(s).replace(/ /g, ''); }

// keyOf, or a stable key from the text itself when it has no letter or
// digit (an emoji-only name): never empty for non-empty text.
function nameKey(s) {
  const k = keyOf(s);
  if (k) return k;
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t ? 'u' + crypto.createHash('sha1').update(t).digest('hex').slice(0, 12) : '';
}

function cleanText(raw, max, what) {
  if (typeof raw !== 'string') throw bad('"' + what + '" must be text');
  const t = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (Array.from(t).length > max) throw bad('"' + what + '" is at most ' + max + ' characters');
  return t;
}

function cleanName(raw, max, what) {
  const t = cleanText(raw, max, what);
  if (!t) throw bad('"' + what + '" must not be empty');
  return t;
}

function startsWithWord(text, start) {
  if (!start) return false;
  const t = text.toLowerCase();
  const s = start.toLowerCase();
  return t === s || t.indexOf(s + ' ') === 0;
}

// "Brand Name" for a grocery row (at most 60 characters), as products.js lineName.
function lineName(brand, name) {
  const t = (startsWithWord(name || '', brand || '') ? name : ((brand || '') + ' ' + (name || ''))).trim();
  const a = Array.from(t);
  return a.length > LINE_MAX ? a.slice(0, LINE_MAX).join('').trim() : t;
}

// "12 oz", "16.9 fl oz", "1.5 L", "6 ct" -> { size, unit }, else nulls.
const UNIT_WORDS = {
  oz: 'oz', ounce: 'oz', ounces: 'oz', 'fl oz': 'fl_oz', floz: 'fl_oz', 'fl_oz': 'fl_oz', 'fluid ounces': 'fl_oz', 'fluid ounce': 'fl_oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', g: 'g', gr: 'g', gram: 'g', grams: 'g', kg: 'kg',
  ml: 'ml', l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l', gal: 'gal', gallon: 'gal', gallons: 'gal',
  ct: 'count', count: 'count', pc: 'count', pcs: 'count', each: 'count', pack: 'pack', pk: 'pack', packs: 'pack'
};
// "1/2 gal", "½ gal" and "1 1/2 lb" read as decimals (size is a REAL).
const VULGAR = { '\u00bc': ' 1/4', '\u00bd': ' 1/2', '\u00be': ' 3/4' };
function parseSize(text) {
  const t = String(text || '').replace(/[\u00bc\u00bd\u00be]/g, (c) => VULGAR[c]);
  const m = /^\s*(\d+(?:[.,]\d+)?|(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+))\s*([a-z][a-z _.]*?)\.?\s*$/i.exec(t);
  if (!m) return { size: null, unit: null };
  const n = m[4] ? Math.round(((m[2] ? Number(m[2]) : 0) + Number(m[3]) / Number(m[4])) * 1000) / 1000 : Number(m[1].replace(',', '.'));
  const u = UNIT_WORDS[m[5].toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()];
  if (!(n > 0) || !isFinite(n) || !u) return { size: null, unit: null };
  return { size: n, unit: u };
}

// A kind from category keys first, then words in the name; 'other' when none.
function guessKind(name, categoryKeys) {
  const cats = categoryKeys || [];
  for (let i = 0; i < cats.length; i++) if (KINDS[cats[i]] !== undefined) return cats[i];
  const k = ' ' + keyOf(name) + ' ';
  const kinds = Object.keys(KIND_WORDS);
  // Longer words first, so "paper towels" wins over "paper".
  let best = 'other', bestLen = 0;
  kinds.forEach((kind) => {
    KIND_WORDS[kind].forEach((w) => {
      if (w.length > bestLen && k.indexOf(' ' + w + ' ') >= 0) { best = kind; bestLen = w.length; }
    });
  });
  return best;
}

/* ---------- numbers ---------- */

function num(v, what, min, max) {
  if (typeof v !== 'number' || !isFinite(v)) throw bad('"' + what + '" must be a number');
  if (v < min || v > max) throw bad('"' + what + '" must be from ' + min + ' to ' + max);
  return Math.round(v * 1000) / 1000;
}
function int(v, what, min, max) {
  const n = num(v, what, min, max);
  if (Math.floor(n) !== n) throw bad('"' + what + '" must be a whole number');
  return n;
}
function bool(v, what) {
  if (typeof v !== 'boolean') throw bad('"' + what + '" must be true or false');
  return v ? 1 : 0;
}
function oneOf(v, list, what) {
  if (list.indexOf(v) < 0) throw bad('"' + what + '" must be one of ' + list.join(', '));
  return v;
}
function idOf(v, what) {
  if (typeof v !== 'number' || !isFinite(v) || v < 1 || Math.floor(v) !== v) throw bad('"' + (what || 'id') + '" must be a product id');
  return v;
}
function upcOf(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^(\d{8}|\d{13})$/.test(v)) throw bad('"upc" must be a product code of 8 or 13 digits');
  return v;
}

/* ---------- the database ---------- */

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  `CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${MAX_BRAND}),
    key TEXT NOT NULL UNIQUE CHECK (length(key) >= 1)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${MAX_CATEGORY}),
    key TEXT NOT NULL UNIQUE CHECK (length(key) >= 1),
    sort INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${MAX_STORE}),
    key TEXT NOT NULL UNIQUE CHECK (length(key) >= 1)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${MAX_NAME}),
    name_key TEXT NOT NULL CHECK (length(name_key) >= 1),
    barcode TEXT UNIQUE CHECK (barcode IS NULL OR (length(barcode) IN (8, 13) AND barcode NOT GLOB '*[^0-9]*')),
    size REAL CHECK (size IS NULL OR size > 0),
    unit TEXT CHECK (unit IS NULL OR unit IN (${UNITS.map((u) => "'" + u + "'").join(', ')})),
    photo TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= ${MAX_NOTES}),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    quantity_remaining INTEGER NOT NULL DEFAULT 0 CHECK (quantity_remaining >= 0 AND quantity_remaining <= ${MAX_QTY}),
    restock_at INTEGER NOT NULL DEFAULT 1 CHECK (restock_at >= 0 AND restock_at <= ${MAX_RESTOCK}),
    purchase_quantity INTEGER NOT NULL DEFAULT 1 CHECK (purchase_quantity BETWEEN 1 AND ${MAX_BUY}),
    auto_add INTEGER NOT NULL DEFAULT 1 CHECK (auto_add IN (0, 1)),
    auto_held INTEGER NOT NULL DEFAULT 0 CHECK (auto_held IN (0, 1)),
    substitution_mode TEXT NOT NULL DEFAULT 'similar' CHECK (substitution_mode IN (${MODES.map((u) => "'" + u + "'").join(', ')})),
    last_price REAL CHECK (last_price IS NULL OR last_price >= 0),
    preferred_store TEXT NOT NULL DEFAULT '' CHECK (length(preferred_store) <= ${MAX_STORE}),
    location TEXT NOT NULL DEFAULT 'pantry' CHECK (location IN (${LOCATIONS.map((u) => "'" + u + "'").join(', ')})),
    owned INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS products_name_key ON products(name_key)',
  `CREATE TABLE IF NOT EXISTS category_products (
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    PRIMARY KEY (category_id, product_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS replacements (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    replacement_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
    PRIMARY KEY (product_id, replacement_id),
    UNIQUE (product_id, rank),
    CHECK (product_id <> replacement_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ordered')),
    created_at INTEGER NOT NULL,
    ordered_at INTEGER
  ) STRICT`,
  "CREATE UNIQUE INDEX IF NOT EXISTS lists_one_open ON lists(status) WHERE status = 'open'",
  `CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND ${MAX_BUY}),
    mode_override TEXT CHECK (mode_override IS NULL OR mode_override IN (${MODES.map((u) => "'" + u + "'").join(', ')})),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
    added_at INTEGER NOT NULL,
    grocery_id TEXT UNIQUE,
    checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1))
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS list_items_product ON list_items(product_id)'
];

function available() { const s = loadSqlite(); return !!(s && s.DatabaseSync); }

// opt: { file, dataDir, log, now, catalogGet(upc) -> catalog product or null }
function createPantry(options) {
  const opt = options || {};
  if (!available()) throw new Error('this Node has no node:sqlite (Node 22.13 or newer)');
  const file = opt.file || path.join(opt.dataDir, 'pantry.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const now = typeof opt.now === 'function' ? opt.now : Date.now;
  const catalogGet = typeof opt.catalogGet === 'function' ? opt.catalogGet : () => null;

  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 2000');
  SCHEMA.forEach((s) => db.exec(s));
  // A database made before "bathroom" was a place has the old list in its
  // CHECK: SQLite cannot change one, so the table is rebuilt (the steps
  // from the SQLite docs: no foreign keys, copy, drop, rename).
  const prodSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();
  if (prodSql && prodSql.sql.indexOf("'bathroom'") < 0) {
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name).join(', ');
    const fresh = SCHEMA.filter((x) => x.indexOf('IF NOT EXISTS products (') > 0)[0]
      .replace('CREATE TABLE IF NOT EXISTS products (', 'CREATE TABLE products_new (');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(fresh);
      db.exec('INSERT INTO products_new (' + cols + ') SELECT ' + cols + ' FROM products');
      db.exec('DROP TABLE products');
      db.exec('ALTER TABLE products_new RENAME TO products');
      db.exec('CREATE INDEX IF NOT EXISTS products_name_key ON products(name_key)');
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign key check failed');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* already gone */ }
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  // A database made before list_items.checked gets the column.
  if (!db.prepare('PRAGMA table_info(list_items)').all().some((c) => c.name === 'checked')) {
    db.exec('ALTER TABLE list_items ADD COLUMN checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1))');
  }

  const q = {};
  function st(sql) { if (!q[sql]) q[sql] = db.prepare(sql); return q[sql]; }
  function one(sql) { const a = Array.prototype.slice.call(arguments, 1); return st(sql).get.apply(st(sql), a); }
  function all(sql) { const a = Array.prototype.slice.call(arguments, 1); return st(sql).all.apply(st(sql), a); }
  function run(sql) { const a = Array.prototype.slice.call(arguments, 1); return st(sql).run.apply(st(sql), a); }

  function metaGet(k) { const r = one('SELECT value FROM meta WHERE key = ?', k); return r ? r.value : null; }
  function metaSet(k, v) { run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v)); }

  let depth = 0;
  function tx(fn) {
    if (depth) return fn();
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* already gone */ }
      throw e;
    } finally {
      depth--;
    }
  }

  // fn inside a savepoint: on a throw only its own changes go back, and
  // the caller's transaction carries on. True when fn finished.
  let spN = 0;
  function guarded(fn) {
    const sp = 'sp' + (++spN);
    db.exec('SAVEPOINT ' + sp);
    try {
      fn();
      db.exec('RELEASE ' + sp);
      return true;
    } catch (e) {
      db.exec('ROLLBACK TO ' + sp);
      db.exec('RELEASE ' + sp);
      return false;
    }
  }

  if (metaGet('schema') === null) {
    tx(() => {
      metaSet('schema', 1);
      metaSet('rev', 0);
      SEED_CATEGORIES.forEach((n, i) => run('INSERT OR IGNORE INTO categories (name, key, sort) VALUES (?, ?, ?)', n, keyOf(n), i + 1));
    });
  }

  let revNow = Number(metaGet('rev')) || 0;
  function bump() { revNow += 1; metaSet('rev', revNow); }

  // Older databases started with a "Milk" category (yogurt, creamer and
  // cheese all went there). It becomes "Dairy", keeping every product link.
  // Runs once (a meta flag), so a "Milk" category made later is left alone.
  tx(() => {
    if (metaGet('dairyMigrated') !== null) return;
    metaSet('dairyMigrated', 1);
    const old = one("SELECT id FROM categories WHERE key = 'milk'");
    if (!old) return;
    const dairy = one("SELECT id FROM categories WHERE key = 'dairy'");
    if (!dairy) {
      run("UPDATE categories SET name = 'Dairy', key = 'dairy' WHERE id = ?", old.id);
    } else {
      run('INSERT OR IGNORE INTO category_products (category_id, product_id) SELECT ?, product_id FROM category_products WHERE category_id = ?', dairy.id, old.id);
      run('DELETE FROM categories WHERE id = ?', old.id);
    }
    bump();
  });

  // Stores were free text. The distinct spellings become the store list;
  // ones that differ only in case, accents, punctuation or spaces ("Tom
  // Thumb", "tom thumb", "TomThumb") merge into the most used spelling, and
  // every product is rewritten to it. Runs once.
  tx(() => {
    if (metaGet('storesMigrated') !== null) return;
    metaSet('storesMigrated', 1);
    const groups = {};
    all("SELECT preferred_store AS s, COUNT(*) AS n FROM products WHERE preferred_store <> '' GROUP BY preferred_store ORDER BY n DESC, preferred_store").forEach((r) => {
      const k = storeKey(r.s);
      if (!k) return;
      if (!groups[k]) groups[k] = { name: r.s, spellings: [] };
      groups[k].spellings.push(r.s);
    });
    Object.keys(groups).forEach((k) => {
      const g = groups[k];
      run('INSERT OR IGNORE INTO stores (name, key) VALUES (?, ?)', g.name, k);
      g.spellings.forEach((sp) => { if (sp !== g.name) run('UPDATE products SET preferred_store = ? WHERE preferred_store = ?', g.name, sp); });
    });
    bump();
  });

  /* --- brands and categories: create or pick, never a second spelling --- */

  // The store named, from the list (matched ignoring case, accents,
  // punctuation and spaces), or added to it. '' means no store.
  function storeName(raw) {
    const name = cleanText(raw, MAX_STORE, 'preferredStore');
    const k = storeKey(name);
    if (!k) return '';
    const hit = one('SELECT name FROM stores WHERE key = ?', k);
    if (hit) return hit.name;
    run('INSERT INTO stores (name, key) VALUES (?, ?)', name, k);
    return name;
  }

  function brandId(raw) {
    if (raw === null || raw === '') return null;
    if (typeof raw === 'number') {
      if (!one('SELECT id FROM brands WHERE id = ?', idOf(raw, 'brandId'))) throw bad('no brand has that id');
      return raw;
    }
    const name = cleanName(raw, MAX_BRAND, 'brand');
    const k = nameKey(name);
    const hit = one('SELECT id FROM brands WHERE key = ?', k);
    if (hit) return hit.id;
    return Number(run('INSERT INTO brands (name, key) VALUES (?, ?)', name, k).lastInsertRowid);
  }

  function categoryId(raw) {
    if (typeof raw === 'number') {
      if (!one('SELECT id FROM categories WHERE id = ?', idOf(raw, 'categoryId'))) throw bad('no category has that id');
      return raw;
    }
    const name = cleanName(raw, MAX_CATEGORY, 'category');
    const k = nameKey(name);
    const hit = one('SELECT id FROM categories WHERE key = ?', k);
    if (hit) return hit.id;
    const max = one('SELECT COALESCE(MAX(sort), 0) AS m FROM categories').m;
    return Number(run('INSERT INTO categories (name, key, sort) VALUES (?, ?, ?)', name, k, max + 1).lastInsertRowid);
  }

  function categoryKeys(pid) {
    return all('SELECT c.key FROM categories c JOIN category_products cp ON cp.category_id = c.id WHERE cp.product_id = ? ORDER BY c.sort', pid).map((r) => r.key);
  }

  function setCategories(pid, ids) {
    run('DELETE FROM category_products WHERE product_id = ?', pid);
    ids.forEach((cid) => run('INSERT OR IGNORE INTO category_products (category_id, product_id) VALUES (?, ?)', cid, pid));
  }

  /* --- lists --- */

  function openListId() {
    const r = one("SELECT id FROM lists WHERE status = 'open'");
    if (r) return r.id;
    return Number(run("INSERT INTO lists (status, created_at) VALUES ('open', ?)", now()).lastInsertRowid);
  }

  function onList(pid) {
    return one('SELECT li.* FROM list_items li WHERE li.list_id = ? AND li.product_id = ? ORDER BY li.id LIMIT 1', openListId(), pid) || null;
  }

  /* --- products --- */

  function product(pid) { return one('SELECT * FROM products WHERE id = ?', pid) || null; }

  function mustProduct(pid) {
    const p = product(idOf(pid));
    if (!p) throw bad('no pantry product has that id');
    return p;
  }

  function findByName(bid, nk) {
    return one('SELECT * FROM products WHERE name_key = ? AND brand_id IS ?', nk, bid) || null;
  }

  function findByBarcode(upc) { return upc ? one('SELECT * FROM products WHERE barcode = ?', upc) || null : null; }

  // A new product row. f: { name, brandId, barcode, size, unit, photo, categoryIds, ... }
  function insertProduct(f) {
    if (one('SELECT COUNT(*) AS n FROM products').n >= MAX_PRODUCTS) throw bad('the pantry is full (' + MAX_PRODUCTS + ' products)');
    const t = now();
    const cats = f.categoryIds || [];
    let restock = f.restockAt;
    let catIds = cats;
    if (restock === undefined || restock === null) {
      const keys = cats.map((cid) => (one('SELECT key FROM categories WHERE id = ?', cid) || {}).key).filter(Boolean);
      const kind = guessKind(f.name, keys);
      restock = KINDS[kind];
      // A guessed kind also files it in that category, when it has none.
      if (!cats.length && kind !== 'other') {
        const c = one('SELECT id FROM categories WHERE key = ?', keyOf(kind));
        if (c) catIds = [c.id];
      }
    }
    const r = run(`INSERT INTO products (brand_id, name, name_key, barcode, size, unit, photo, notes, quantity_remaining, restock_at,
      purchase_quantity, auto_add, substitution_mode, location, owned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.brandId || null, f.name, nameKey(f.name), f.barcode || null, f.size || null, f.unit || null, f.photo || '', f.notes || '',
    f.quantity || 0, restock, f.purchaseQuantity || 1, f.autoAdd === 0 ? 0 : 1, f.substitutionMode || 'similar',
    f.location || 'pantry', f.owned ? 1 : 0, t, t);
    const pid = Number(r.lastInsertRowid);
    if (catIds.length) setCategories(pid, catIds);
    return pid;
  }

  // Fields from a catalog product (products.js): brand, name, size, picture.
  function catalogFields(cp) {
    const name = (cp.name || cp.brand || '').trim();
    const sz = parseSize(cp.size);
    return {
      name: Array.from(name).slice(0, MAX_NAME).join('').trim() || cp.upc,
      brandId: cp.brand && cp.brand.trim() ? brandId(Array.from(cp.brand).slice(0, MAX_BRAND).join('').trim()) : null,
      barcode: cp.upc, size: sz.size, unit: sz.unit, photo: cp.image || ''
    };
  }

  // The product for a barcode: the pantry's row, else one made from the catalog.
  function productForUpc(upc, fallbackName) {
    const hit = findByBarcode(upc);
    if (hit) return hit.id;
    const cp = catalogGet(upc);
    if (cp) return insertProduct(catalogFields(cp));
    if (!fallbackName) throw bad("that barcode isn't in the product catalog yet");
    return insertProduct({ name: fallbackName, barcode: upc });
  }

  // A catalog product was corrected by hand (POST /products/save): the
  // pantry row with that code takes the new brand, name, size and picture.
  function fromCatalog(cp) {
    if (!cp || !cp.upc) return false;
    const p = findByBarcode(cp.upc);
    if (!p) return false;
    return tx(() => {
      const f = catalogFields(cp);
      run('UPDATE products SET brand_id = ?, name = ?, name_key = ?, size = COALESCE(?, size), unit = COALESCE(?, unit), photo = ?, updated_at = ? WHERE id = ?',
        f.brandId, f.name, nameKey(f.name), f.size, f.unit, f.photo, now(), p.id);
      bump();
      return true;
    });
  }

  function isLow(p) { return !!p && p.owned === 1 && p.archived === 0 && p.quantity_remaining <= p.restock_at; }

  // After a change: a product above its restock point is no longer held.
  function settle(pid) {
    const p = product(pid);
    if (p && p.auto_held && p.quantity_remaining > p.restock_at) run('UPDATE products SET auto_held = 0 WHERE id = ?', pid);
  }

  /* --- the grocery mirror --- */

  // items: the grocery list (grocery.js items). hints: [{ productId, source,
  // upc, nameKey }] from the pantry op that asked for the rows. Returns the
  // number of products held back from auto-add.
  function syncGrocery(items, hints) {
    const list = Array.isArray(items) ? items : [];
    const h = Array.isArray(hints) ? hints.slice() : [];
    return tx(() => {
      const lid = openListId();
      const rows = all('SELECT * FROM list_items WHERE list_id = ?', lid);
      const byG = {};
      rows.forEach((r) => { if (r.grocery_id) byG[r.grocery_id] = r; });
      const present = {};
      let changed = false;
      let held = 0;
      let skipped = 0;
      list.forEach((it) => {
        if (!it || typeof it.id !== 'string') return;
        present[it.id] = 1;
        // One row that does not fit never stops the rest of the mirror.
        if (!guarded(() => {
        const nk = nameKey(it.name);
        if (byG[it.id]) {
          const tick = it.done ? 1 : 0;
          if (byG[it.id].checked !== tick) {
            run('UPDATE list_items SET checked = ? WHERE id = ?', tick, byG[it.id].id);
            changed = true;
          }
          // A code added to a typed row later: point the row at that product.
          const cur = product(byG[it.id].product_id);
          if (it.upc && cur && cur.barcode !== it.upc) {
            const pid = productForUpc(it.upc, it.name);
            run('UPDATE list_items SET product_id = ? WHERE id = ?', pid, byG[it.id].id);
            changed = true;
          }
          return;
        }
        let at = h.findIndex((x) => (x.upc && it.upc === x.upc) || (!x.upc && x.nameKey === nk) || (x.upc && !it.upc && x.nameKey === nk));
        let pid, source = 'manual';
        if (at >= 0) {
          pid = h[at].productId;
          source = h[at].source === 'auto' ? 'auto' : 'manual';
          h.splice(at, 1);
        } else if (it.upc) {
          pid = productForUpc(it.upc, it.name);
        } else {
          const p = findByName(null, nk) || one('SELECT * FROM products WHERE name_key = ? ORDER BY owned DESC, id LIMIT 1', nk);
          pid = p ? p.id : insertProduct({ name: Array.from(it.name).slice(0, MAX_NAME).join('') });
        }
        const pp = product(pid);
        run('INSERT INTO list_items (list_id, product_id, quantity, source, added_at, grocery_id, checked) VALUES (?, ?, ?, ?, ?, ?, ?)',
          lid, pid, pp ? pp.purchase_quantity : 1, source, typeof it.addedAt === 'number' ? Math.round(it.addedAt) : now(), it.id, it.done ? 1 : 0);
        changed = true;
        })) skipped++;
      });
      if (skipped) log('pantry: ' + skipped + ' grocery rows could not be mirrored');
      // A hint whose row was already there (the grocery list did not double
      // it): that row now belongs to the pantry product, when it pointed at a
      // typed placeholder that is not in the pantry.
      h.forEach((x) => {
        const it = list.find((g) => g && ((x.upc && g.upc === x.upc) || nameKey(g.name) === x.nameKey));
        const row = it ? one('SELECT li.id, p.owned, p.id AS pid FROM list_items li JOIN products p ON p.id = li.product_id WHERE li.grocery_id = ?', it.id) : null;
        if (row && row.pid !== x.productId && row.owned === 0) {
          run('UPDATE list_items SET product_id = ?, source = ? WHERE id = ?', x.productId, x.source === 'auto' ? 'auto' : 'manual', row.id);
          changed = true;
        }
      });
      rows.forEach((r) => {
        if (!r.grocery_id || present[r.grocery_id]) return;
        run('DELETE FROM list_items WHERE id = ?', r.id);
        changed = true;
        const p = product(r.product_id);
        if (r.source === 'auto' && isLow(p) && !onList(p.id)) {
          run('UPDATE products SET auto_held = 1 WHERE id = ?', p.id);
          held++;
        }
      });
      if (changed) bump();
      return held;
    });
  }

  /* --- ops --- */

  function want(p, source, out) {
    const line = lineName(p.brand_id ? (one('SELECT name FROM brands WHERE id = ?', p.brand_id) || {}).name : '', p.name);
    const op = { op: 'add', name: line };
    if (p.barcode) op.upc = p.barcode;
    out.grocery.push(op);
    out.hints.push({ productId: p.id, source: source, upc: p.barcode || '', nameKey: nameKey(line) });
  }

  // Auto-add for the products an op batch touched.
  // before: { pid: { fresh, low, qty } } from the start of the batch. Only a
  // drop to or under the restock point adds a row: never the add that puts a
  // product in the pantry, nor one that was already low.
  function autoCheck(ids, out, before) {
    ids.forEach((pid) => {
      const p = product(pid);
      const b = before[pid];
      if (!p || !b || b.fresh || b.low || p.quantity_remaining >= b.qty) return;
      if (!isLow(p) || !p.auto_add || p.auto_held) return;
      if (onList(pid) || out.hints.some((x) => x.productId === pid)) return;
      want(p, 'auto', out);
      out.auto++;
    });
  }

  function editFields(p, o) {
    const set = {};
    if (o.name !== undefined) { set.name = cleanName(o.name, MAX_NAME, 'name'); set.name_key = nameKey(set.name); }
    if (o.brand !== undefined) set.brand_id = brandId(o.brand);
    if (o.brandId !== undefined) set.brand_id = o.brandId === null ? null : brandId(idOf(o.brandId, 'brandId'));
    if (o.size !== undefined) set.size = o.size === null ? null : num(o.size, 'size', 0.001, 100000);
    if (o.unit !== undefined) set.unit = o.unit === null ? null : oneOf(o.unit, UNITS, 'unit');
    if (o.notes !== undefined) set.notes = o.notes === null ? '' : cleanText(o.notes, MAX_NOTES, 'notes');
    if (o.location !== undefined) set.location = oneOf(o.location, LOCATIONS, 'location');
    if (o.restockAt !== undefined) set.restock_at = int(o.restockAt, 'restockAt', 0, MAX_RESTOCK);
    if (o.purchaseQuantity !== undefined) set.purchase_quantity = int(o.purchaseQuantity, 'purchaseQuantity', 1, MAX_BUY);
    if (o.autoAdd !== undefined) set.auto_add = bool(o.autoAdd, 'autoAdd');
    if (o.substitutionMode !== undefined) set.substitution_mode = oneOf(o.substitutionMode, MODES, 'substitutionMode');
    if (o.lastPrice !== undefined) set.last_price = o.lastPrice === null ? null : num(o.lastPrice, 'lastPrice', 0, 100000);
    if (o.preferredStore !== undefined) set.preferred_store = o.preferredStore === null ? '' : storeName(o.preferredStore);
    if (o.archived !== undefined) set.archived = bool(o.archived, 'archived');
    if (set.name !== undefined || set.brand_id !== undefined) {
      const nk = set.name_key !== undefined ? set.name_key : p.name_key;
      const bid = set.brand_id !== undefined ? set.brand_id : p.brand_id;
      const other = findByName(bid, nk);
      if (other && other.id !== p.id) throw bad('another product already has that brand and name');
    }
    return set;
  }

  function update(pid, set) {
    const keys = Object.keys(set);
    if (!keys.length) return;
    keys.push('updated_at');
    set.updated_at = now();
    // Column names come from editFields only, never from the request.
    const sql = 'UPDATE products SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?';
    run.apply(null, [sql].concat(keys.map((k) => set[k]), [pid]));
  }

  function categoryList(o) {
    const ids = [];
    if (o.categoryIds !== undefined) {
      if (!Array.isArray(o.categoryIds) || o.categoryIds.length > 5) throw bad('"categoryIds" is a list of at most 5 ids');
      o.categoryIds.forEach((c) => ids.push(categoryId(idOf(c, 'categoryIds'))));
    }
    if (o.category !== undefined && o.category !== null && o.category !== '') ids.push(categoryId(o.category));
    if (o.categoryId !== undefined && o.categoryId !== null) ids.push(categoryId(idOf(o.categoryId, 'categoryId')));
    return ids.filter((x, i) => ids.indexOf(x) === i);
  }

  // Applies a list of ops in one transaction. Returns { changed, grocery
  // (ops for grocery.js), hints (for syncGrocery), auto (count), results }.
  // Throws a 400 error and changes nothing when an op is wrong.
  // groceryItems: the grocery list now (to find a product's row for want off).
  function applyOps(ops, groceryItems) {
    if (!Array.isArray(ops) || !ops.length) throw bad('send { "ops": [ ... ] }');
    if (ops.length > MAX_OPS) throw bad('at most ' + MAX_OPS + ' ops at a time');
    const out = { changed: false, grocery: [], hints: [], auto: 0, results: [] };
    const touched = [];
    const before = {};
    // The product as it was before this batch first changed it.
    function mark(pid) {
      if (before[pid]) return;
      const p = product(pid);
      before[pid] = { fresh: !p || p.owned !== 1 || p.archived !== 0, low: isLow(p), qty: p ? p.quantity_remaining : 0 };
    }
    const gItems = Array.isArray(groceryItems) ? groceryItems : [];
    tx(() => {
      ops.forEach((o) => {
        if (!isObj(o) || typeof o.op !== 'string') throw bad('each op needs an "op"');
        if (o.op === 'add') {
          const upc = upcOf(o.upc);
          const qty = o.qty === undefined ? 1 : int(o.qty, 'qty', 0, MAX_QTY);
          let pid;
          if (upc) {
            pid = productForUpc(upc, o.name ? cleanName(o.name, MAX_NAME, 'name') : '');
          } else {
            const name = cleanName(o.name, MAX_NAME, 'name');
            const bid = o.brandId !== undefined && o.brandId !== null ? brandId(idOf(o.brandId, 'brandId')) : (o.brand ? brandId(o.brand) : null);
            const hit = findByName(bid, nameKey(name));
            pid = hit ? hit.id : insertProduct({ name: name, brandId: bid, categoryIds: categoryList(o), restockAt: o.restockAt === undefined ? undefined : int(o.restockAt, 'restockAt', 0, MAX_RESTOCK) });
          }
          mark(pid);
          const p = product(pid);
          const set = editFields(p, { location: o.location, restockAt: o.restockAt, autoAdd: o.autoAdd, size: o.size, unit: o.unit, purchaseQuantity: o.purchaseQuantity, substitutionMode: o.substitutionMode });
          const wasHere = p.owned === 1 && p.archived === 0;
          // onlyNew (a pasted list of codes): a product at home already (one
          // or more left) is left as it is, so a phone with an old copy never
          // counts it twice. One run out (0 left) is restocked.
          if (o.onlyNew !== undefined && bool(o.onlyNew, 'onlyNew') && wasHere && p.quantity_remaining > 0) {
            out.results.push({ op: 'add', id: pid, existed: true, skipped: true });
            return;
          }
          set.owned = 1;
          set.archived = 0;
          set.quantity_remaining = Math.min(MAX_QTY, (wasHere ? p.quantity_remaining : 0) + qty);
          update(pid, set);
          const cats = upc ? categoryList(o) : [];
          if (cats.length) setCategories(pid, cats);
          touched.push(pid);
          out.results.push({ op: 'add', id: pid, existed: wasHere });
        } else if (o.op === 'adjust') {
          const p = mustProduct(o.id);
          mark(p.id);
          const by = int(o.by, 'by', -MAX_QTY, MAX_QTY);
          update(p.id, { quantity_remaining: Math.max(0, Math.min(MAX_QTY, p.quantity_remaining + by)), owned: 1, archived: 0 });
          touched.push(p.id);
        } else if (o.op === 'set') {
          const p = mustProduct(o.id);
          mark(p.id);
          const set = editFields(p, { restockAt: o.restockAt });
          if (o.qty !== undefined) { set.quantity_remaining = int(o.qty, 'qty', 0, MAX_QTY); set.owned = 1; set.archived = 0; }
          if (!Object.keys(set).length) throw bad('"set" needs "qty" or "restockAt"');
          update(p.id, set);
          touched.push(p.id);
        } else if (o.op === 'edit') {
          const p = mustProduct(o.id);
          mark(p.id);
          const fields = {};
          ['name', 'brand', 'brandId', 'size', 'unit', 'notes', 'location', 'restockAt', 'purchaseQuantity', 'autoAdd', 'substitutionMode', 'lastPrice', 'preferredStore', 'archived'].forEach((k) => { if (o[k] !== undefined) fields[k] = o[k]; });
          update(p.id, editFields(p, fields));
          if (o.categoryIds !== undefined || o.category !== undefined || o.categoryId !== undefined) setCategories(p.id, categoryList(o));
          if (o.replacements !== undefined) {
            if (!Array.isArray(o.replacements) || o.replacements.length > 5) throw bad('"replacements" is a list of at most 5 product ids');
            run('DELETE FROM replacements WHERE product_id = ?', p.id);
            o.replacements.forEach((rid, i) => {
              const r = mustProduct(rid);
              if (r.id === p.id) throw bad('a product cannot replace itself');
              run('INSERT OR IGNORE INTO replacements (product_id, replacement_id, rank) VALUES (?, ?, ?)', p.id, r.id, i + 1);
            });
          }
          touched.push(p.id);
        } else if (o.op === 'want') {
          const p = mustProduct(o.id);
          const on = bool(o.on, 'on');
          if (on) {
            if (!onList(p.id) && !out.hints.some((x) => x.productId === p.id)) want(p, 'manual', out);
          } else {
            all('SELECT grocery_id FROM list_items WHERE list_id = ? AND product_id = ?', openListId(), p.id).forEach((r) => {
              if (r.grocery_id && gItems.some((g) => g.id === r.grocery_id)) out.grocery.push({ op: 'remove', id: r.grocery_id });
            });
          }
        } else if (o.op === 'remove') {
          const p = mustProduct(o.id);
          mark(p.id);
          update(p.id, { owned: 0, archived: 1, quantity_remaining: 0, auto_held: 0 });
        } else if (o.op === 'brand') {
          out.results.push({ op: 'brand', id: brandId(o.name) });
        } else if (o.op === 'category') {
          out.results.push({ op: 'category', id: categoryId(o.name) });
        } else if (o.op === 'check') {
          // A list row ticked or unticked while shopping; the grocery row follows.
          const lid = o.list_item_id !== undefined ? o.list_item_id : o.listItemId;
          if (typeof lid !== 'number' || !isFinite(lid) || lid < 1 || Math.floor(lid) !== lid) throw bad('"list_item_id" must be a list row id');
          const checked = bool(o.checked, 'checked');
          const row = one('SELECT * FROM list_items WHERE id = ? AND list_id = ?', lid, openListId());
          if (!row) throw bad('no row on the open list has that id');
          run('UPDATE list_items SET checked = ? WHERE id = ?', checked, row.id);
          if (row.grocery_id && gItems.some((g) => g.id === row.grocery_id)) out.grocery.push({ op: 'check', id: row.grocery_id, done: !!checked });
        } else if (o.op === 'listQty' || o.op === 'listMode') {
          const p = mustProduct(o.id);
          const row = onList(p.id);
          if (!row) throw bad('that product is not on the list');
          if (o.op === 'listQty') run('UPDATE list_items SET quantity = ? WHERE id = ?', int(o.quantity, 'quantity', 1, MAX_BUY), row.id);
          else run('UPDATE list_items SET mode_override = ? WHERE id = ?', o.mode === null ? null : oneOf(o.mode, MODES, 'mode'), row.id);
        } else {
          throw bad('unknown op (use add, adjust, set, edit, want, remove, brand, category, check, listQty or listMode)');
        }
      });
      touched.forEach(settle);
      autoCheck(touched.filter((x, i) => touched.indexOf(x) === i), out, before);
      bump();
      out.changed = true;
    });
    return out;
  }

  /* --- reading --- */

  function brandName(bid) { const b = bid ? one('SELECT name FROM brands WHERE id = ?', bid) : null; return b ? b.name : ''; }

  function rowOut(p, listed, groceryById) {
    const cp = p.barcode ? catalogGet(p.barcode) : null;
    const li = listed[p.id] || null;
    const g = li && li.grocery_id ? groceryById[li.grocery_id] : null;
    return {
      id: p.id, name: p.name, brand: brandName(p.brand_id), brandId: p.brand_id,
      categoryIds: all('SELECT category_id FROM category_products WHERE product_id = ?', p.id).map((r) => r.category_id),
      upc: p.barcode || '', size: p.size, unit: p.unit, photo: cp && cp.image ? cp.image : p.photo, notes: p.notes,
      qty: p.quantity_remaining, restockAt: p.restock_at, buy: p.purchase_quantity, autoAdd: !!p.auto_add, held: !!p.auto_held,
      mode: p.substitution_mode, location: p.location, store: p.preferred_store || '', owned: !!p.owned, low: isLow(p),
      onList: !!li, listItemId: li ? li.id : null, checked: !!(li && li.checked), inCart: !!((g && g.done) || (li && li.checked)), listSource: li ? li.source : '', listQty: li ? li.quantity : 0, modeOverride: li ? li.mode_override : null,
      replacements: all('SELECT replacement_id FROM replacements WHERE product_id = ? ORDER BY rank', p.id).map((r) => r.replacement_id),
      updatedAt: p.updated_at
    };
  }

  function listedMap() {
    const m = {};
    all('SELECT * FROM list_items WHERE list_id = ? ORDER BY id', openListId()).forEach((r) => { if (!m[r.product_id]) m[r.product_id] = r; });
    return m;
  }

  // What the phone shows: the pantry (owned) and the usual items (owned, or
  // ever on a list), not archived; every brand and category for the pickers.
  function view(groceryItems) {
    const gById = {};
    (groceryItems || []).forEach((g) => { gById[g.id] = g; });
    const listed = listedMap();
    const rows = all(`SELECT * FROM products p WHERE p.archived = 0 AND (p.owned = 1 OR EXISTS (SELECT 1 FROM list_items li WHERE li.product_id = p.id))
      ORDER BY p.updated_at DESC LIMIT ${MAX_VIEW}`);
    const products = rows.map((p) => rowOut(p, listed, gById));
    return {
      rev: revNow,
      data: {
        products: products,
        brands: all('SELECT id, name, key FROM brands ORDER BY name COLLATE NOCASE'),
        categories: all('SELECT id, name, key, sort FROM categories ORDER BY sort, id'),
        stores: all('SELECT id, name FROM stores ORDER BY name COLLATE NOCASE'),
        kinds: KINDS,
        list: all('SELECT id, product_id AS productId, quantity, mode_override AS modeOverride, source, added_at AS addedAt, grocery_id AS groceryId, checked FROM list_items WHERE list_id = ? ORDER BY id', openListId())
          .map((r) => Object.assign(r, { checked: !!r.checked })),
        counts: { items: products.filter((p) => p.owned).length, low: products.filter((p) => p.low).length, onList: products.filter((p) => p.onList).length }
      }
    };
  }

  function lowList() {
    const listed = listedMap();
    return all('SELECT * FROM products WHERE owned = 1 AND archived = 0 AND quantity_remaining <= restock_at ORDER BY location, name COLLATE NOCASE')
      .map((p) => rowOut(p, listed, {}));
  }

  function ownedList() {
    const listed = listedMap();
    return all('SELECT * FROM products WHERE owned = 1 AND archived = 0 ORDER BY location, name COLLATE NOCASE').map((p) => rowOut(p, listed, {}));
  }

  // A product by id, or by name ("Brand Name" or just the name), owned first.
  function find(what) {
    if (typeof what === 'number' || /^\d+$/.test(String(what))) {
      const p = product(Number(what));
      return p ? rowOut(p, listedMap(), {}) : null;
    }
    const k = nameKey(what);
    if (!k) return null;
    const hits = all('SELECT p.*, b.key AS bkey FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.archived = 0 ORDER BY p.owned DESC, p.updated_at DESC')
      .filter((p) => p.name_key === k || (p.bkey && keyOf(p.bkey + ' ' + p.name) === k));
    if (!hits.length) return null;
    const owned = hits.filter((p) => p.owned === 1);
    if (owned.length > 1) throw bad('more than one pantry item is called that; use its id');
    return rowOut(owned[0] || hits[0], listedMap(), {});
  }

  // For the export (GET /api/grocery/export): why a grocery row is there.
  function groceryInfo() {
    const m = {};
    all('SELECT li.grocery_id, li.source, p.owned, p.preferred_store FROM list_items li JOIN products p ON p.id = li.product_id WHERE li.list_id = ?', openListId()).forEach((r) => {
      if (!r.grocery_id) return;
      const fromPantry = r.owned === 1;
      m[r.grocery_id] = { store: r.preferred_store || '', fromPantry: fromPantry, reason: r.source === 'auto' ? 'low' : (fromPantry ? 'manual' : '') };
    });
    return m;
  }

  // Codes the products catalog must keep (owned products).
  function barcodes() {
    return all('SELECT barcode FROM products WHERE barcode IS NOT NULL AND owned = 1').map((r) => r.barcode);
  }

  /* --- the one-time move from the JSON files --- */

  // productsFile: data/products.json (the catalog); groceryItems: the grocery
  // list. Each part runs once (marked in meta); the JSON files are copied to
  // <dataDir>/pantry-backup/ and never changed here.
  function migrate(m) {
    const o = m || {};
    const res = { products: 0, grocery: 0, skipped: true };
    if (metaGet('migrated.products') === null) {
      res.skipped = false;
      let list = {};
      let ready = true;
      if (o.productsFile) {
        let text = null;
        try {
          text = fs.readFileSync(o.productsFile, 'utf8');
        } catch (e) {
          if (e.code !== 'ENOENT') { ready = false; log('pantry: the catalog could not be read for the move (' + (e.code || 'error') + '); trying again next start'); }
        }
        if (text !== null) {
          // The copy comes first, so even a file that will not parse is kept.
          if (o.backupDir) {
            try {
              fs.mkdirSync(o.backupDir, { recursive: true });
              const dest = path.join(o.backupDir, 'products.json');
              if (!fs.existsSync(dest)) fs.writeFileSync(dest, text);
            } catch (e) { ready = false; log('pantry: could not keep a copy of the catalog (' + (e.code || 'error') + '); trying again next start'); }
          }
          try {
            const raw = JSON.parse(text);
            if (!isObj(raw) || (raw.products !== undefined && !isObj(raw.products))) throw new Error('shape');
            list = isObj(raw.products) ? raw.products : {};
          } catch (e) {
            ready = false;
            log('pantry: the catalog is damaged, left for the next start');
          }
        }
      }
      if (ready) tx(() => {
        Object.keys(list).forEach((k) => {
          const cp = list[k];
          if (!isObj(cp) || !/^(\d{8}|\d{13})$/.test(k) || findByBarcode(k)) return;
          if (typeof cp.name !== 'string' && typeof cp.brand !== 'string') return;
          if (!nameKey(cp.name) && !nameKey(cp.brand)) return;
          if (guarded(() => insertProduct(catalogFields({ upc: k, brand: typeof cp.brand === 'string' ? cp.brand.replace(CONTROL_RE, ' ').trim() : '', name: typeof cp.name === 'string' ? cp.name.replace(CONTROL_RE, ' ').trim() : '', size: cp.size, image: cp.image ? '/products/image/' + k : '' })))) res.products++;
          else res.failed = (res.failed || 0) + 1;
        });
        if (res.failed) log('pantry: ' + res.failed + ' catalog products were left out of the move');
        metaSet('migrated.products', now());
      });
    }
    if (metaGet('migrated.grocery') === null) {
      res.skipped = false;
      const items = Array.isArray(o.groceryItems) ? o.groceryItems : [];
      if (o.backupDir && items.length) {
        try {
          fs.mkdirSync(o.backupDir, { recursive: true });
          const dest = path.join(o.backupDir, 'grocery.json');
          if (!fs.existsSync(dest)) fs.writeFileSync(dest, JSON.stringify({ items: items }) + '\n');
        } catch (e) { log('pantry: could not keep a copy of the grocery list (' + (e.code || 'error') + ')'); }
      }
      syncGrocery(items, []);
      res.grocery = items.length;
      metaSet('migrated.grocery', now());
    }
    if (!res.skipped) bump();
    return res;
  }

  return {
    applyOps: applyOps,
    syncGrocery: syncGrocery,
    migrate: migrate,
    view: view,
    lowList: lowList,
    ownedList: ownedList,
    find: find,
    groceryInfo: groceryInfo,
    barcodes: barcodes,
    fromCatalog: fromCatalog,
    rev: () => revNow,
    db: db,
    close: () => { try { db.close(); } catch (e) { /* already closed */ } }
  };
}

module.exports = {
  UNITS: UNITS,
  MODES: MODES,
  LOCATIONS: LOCATIONS,
  SOURCES: SOURCES,
  KINDS: KINDS,
  MAX_OPS: MAX_OPS,
  available: available,
  keyOf: keyOf,
  storeKey: storeKey,
  parseSize: parseSize,
  guessKind: guessKind,
  lineName: lineName,
  createPantry: createPantry
};
