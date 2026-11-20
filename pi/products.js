/*
 * The products catalog: what a barcode (UPC / EAN) is, kept on the Pi and
 * shared by every widget that scans (the grocery list now, a pantry later).
 * A scan is only a lookup here; where the product goes is the caller's choice.
 *
 *   normalize(code, format)  digits -> canonical key: 13-digit EAN-13 (UPC-A
 *                            gets a leading 0), or the 8 digits of an EAN-8.
 *                            format is the detector's hint: 'upc_e' expands an
 *                            8-digit UPC-E first, 'ean_8' keeps the 8 digits.
 *   toKey(code, has)         the same, but an 8-digit key already in the catalog
 *                            (has(key)) stays as it is, so a stored EAN-8 round-trips
 *   createCatalog(opt)       { lookup, save, get, forUpcs, imageFile, size, close }
 *
 *   product  { upc, brand, name, size, source, image, addedAt, updatedAt }
 *            source: off | opf | upcitemdb | manual
 *            image: '/products/image/<upc>?v=<n>' (a thumbnail saved on the Pi,
 *            never a link to another site) or ''
 *
 * Lookup order: the catalog, then Open Food Facts, Open Products Facts and
 * UPCitemdb's free trial (100 a day). A web hit is saved with its thumbnail;
 * a miss is remembered in memory for 24 hours. A manual entry always wins and
 * a web lookup never overwrites it. Each source has its own rate limit (OFF
 * and OPF 15 a minute, one at a time; UPCitemdb 6 a minute and 100 a day):
 * a source at its limit is skipped, and one source failing never fails the
 * lookup.
 *
 * Pictures from the web: https only, a host name (not an address) that
 * resolves only to public addresses (the connection is pinned to the checked
 * address), no redirects, an image type with matching magic bytes, at most
 * 400 KB. Files: <dataDir>/products.json and <dataDir>/products/<upc>.<ext>.
 *
 * Logs counts and source names only, never a code or a product name.
 * Node 14 or newer, no npm packages. Tests: node pi/products-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');

const MAX_PRODUCTS = 5000;
const MAX_BRAND = 40;
const MAX_NAME = 80;
const MAX_SIZE = 30;
const MAX_LINE = 60; // a grocery item's name
const MISS_MS = 24 * 60 * 60 * 1000;
const MAX_MISSES = 5000;
const REFILL_MS = 6 * 60 * 60 * 1000; // a saved web item missing a brand or picture is looked up again at most this often
const TIMEOUT_MS = 6000;
const BUDGET_MS = 20000; // one lookup in all, queue waits included (the phone gives up at 25 s)
const DNS_MS = 3000;
const IMAGE_MS = 4000; // one thumbnail try
const CLIENT_PER_MIN = 10; // web lookups per phone (address) a minute
const JSON_MAX = 1024 * 1024;
const WEB_IMAGE_MAX = 400 * 1024;
const PHOTO_MAX = 150 * 1024;
const USER_AGENT = 'HomeHub/1.0 (personal home dashboard)';
const INVALID = "that isn't a valid barcode number";
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const IMAGE_EXTS = ['jpg', 'png', 'webp'];
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const SOURCES = ['off', 'opf', 'upcitemdb', 'manual'];

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/* ---------- codes ---------- */

// GS1 check digit over every digit but the last.
function checkOk(d) {
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}

// 8-digit UPC-E (number system 0 or 1, six digits, check) -> 12-digit UPC-A.
function expandUpcE(e) {
  if (!/^[01]\d{7}$/.test(e)) return null;
  const ns = e[0];
  const d = e.slice(1, 7);
  const c = e[7];
  const last = Number(d[5]);
  let body;
  if (last <= 2) body = d[0] + d[1] + d[5] + '0000' + d[2] + d[3] + d[4];
  else if (last === 3) body = d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
  else if (last === 4) body = d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
  else body = d[0] + d[1] + d[2] + d[3] + d[4] + '0000' + d[5];
  return ns + body + c;
}

function digitsOf(code) {
  if (typeof code !== 'string' && typeof code !== 'number') throw bad(INVALID);
  const s = String(code).replace(/[\s-]+/g, '');
  if (!/^\d+$/.test(s)) throw bad(INVALID);
  return s;
}

// The canonical key for a scanned or typed code. Throws a 400 error.
function normalize(code, format) {
  let s = digitsOf(code);
  const f = typeof format === 'string' ? format.toLowerCase() : '';
  if (s.length === 14) {
    if (s[0] !== '0') throw bad(INVALID);
    s = s.slice(1);
  }
  if (s.length === 13) {
    if (!checkOk(s)) throw bad(INVALID);
    return s;
  }
  if (s.length === 12) {
    if (!checkOk(s)) throw bad(INVALID);
    return '0' + s;
  }
  if (s.length === 8) {
    if (f === 'ean_8') {
      if (!checkOk(s)) throw bad(INVALID);
      return s;
    }
    const a = expandUpcE(s);
    if (a && checkOk(a)) return '0' + a;
    // No hint (a typed number): a valid EAN-8 is the other reading.
    if (f !== 'upc_e' && checkOk(s)) return s;
    throw bad(INVALID);
  }
  throw bad(INVALID);
}

// The key for a code with no format hint: a key already in the catalog
// (has(key) true) stays as it is, so a stored EAN-8 round-trips; anything
// else goes through normalize (an 8-digit code: UPC-E first, then EAN-8).
function toKey(code, has) {
  const s = digitsOf(code);
  if (s.length === 8 && typeof has === 'function' && checkOk(s) && has(s)) return s;
  return normalize(s);
}

function isKey(s) {
  return typeof s === 'string' && /^(\d{8}|\d{13})$/.test(s) && checkOk(s);
}

/* ---------- product text ---------- */

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, max).join('').trim();
}

function cut(s, max) {
  const a = Array.from(s);
  return a.length > max ? a.slice(0, max).join('').trim() : s;
}

function startsWithWord(text, start) {
  if (!start) return false;
  const t = text.toLowerCase();
  const s = start.toLowerCase();
  return t === s || t.indexOf(s + ' ') === 0;
}

// "Brand Name" for a grocery item (at most 60 characters); the brand is left
// out when the name already starts with it.
function lineName(p) {
  if (!p) return '';
  const name = p.name || '';
  const brand = p.brand || '';
  const t = (startsWithWord(name, brand) ? name : (brand + ' ' + name)).trim();
  return cut(t, MAX_LINE);
}

// The tightest text to search a store for: "Brand Name Size".
function searchText(p, fallback) {
  if (!p) return fallback || '';
  const base = (startsWithWord(p.name || '', p.brand || '') ? p.name : ((p.brand || '') + ' ' + (p.name || ''))).trim();
  const size = p.size || '';
  const low = base.toLowerCase();
  const t = size && low.slice(-size.length) !== size.toLowerCase() ? base + ' ' + size : base;
  return t.trim() || fallback || '';
}

function imageUrl(upc, ver) {
  return '/products/image/' + upc + '?v=' + Number(ver || 0).toString(36);
}

// A saved product of any age, rebuilt from known fields; null if unusable.
function cleanProduct(r, key) {
  if (!isObj(r) || !isKey(key) || r.upc !== key) return null;
  const p = {
    upc: key,
    brand: cleanText(r.brand, MAX_BRAND),
    name: cleanText(r.name, MAX_NAME),
    size: cleanText(r.size, MAX_SIZE),
    source: SOURCES.indexOf(r.source) >= 0 ? r.source : 'manual',
    image: '',
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0
  };
  if (!p.brand && !p.name) return null;
  if (typeof r.image === 'string' && r.image) p.image = imageUrl(key, p.updatedAt);
  return p;
}

/* ---------- export (GET /api/grocery/export) ---------- */

// items: the grocery list; get(upc): a catalog product or null.
function exportList(items, get, now) {
  const out = (items || []).map((i) => {
    const p = i.upc ? get(i.upc) : null;
    return {
      id: i.id, name: i.name, done: !!i.done, addedAt: i.addedAt,
      upc: i.upc || '',
      brand: p ? p.brand : '', productName: p ? p.name : '', size: p ? p.size : '',
      source: p ? p.source : '',
      imagePath: p && p.image ? '/api/products/image?upc=' + p.upc : '',
      search: searchText(p, i.name)
    };
  });
  const left = out.filter((i) => !i.done).length;
  return { ok: true, generatedAt: new Date(now || Date.now()).toISOString(), counts: { left: left, ticked: out.length - left }, items: out };
}

/* ---------- addresses (for pictures from the web) ---------- */

function v4Parts(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function v4Public(p) {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT / Tailscale
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

// True only for a public unicast address.
function isPublicIp(ip) {
  const a = String(ip || '').toLowerCase().replace(/%.*$/, '');
  const p4 = v4Parts(a);
  if (p4) return v4Public(p4);
  if (a.indexOf(':') < 0 || !/^[0-9a-f:.]+$/.test(a)) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) { const p = v4Parts(mapped[1]); return !!p && v4Public(p); }
  if (/^::/.test(a)) return false; // ::, ::1, ::a.b.c.d and the like
  const first = parseInt(a.split(':')[0], 16);
  if (isNaN(first)) return false;
  if ((first & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  if (first === 0x2001 && /^2001:0*db8:/.test(a)) return false; // documentation
  if (first === 0x2002) return false; // 6to4 can wrap a private v4 address
  return true;
}

// A picture address we may fetch: https, default port, a name not an address.
function imageUrlOk(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const h = u.hostname.toLowerCase();
  if (!h || h[0] === '[' || h.indexOf(':') >= 0 || v4Parts(h) || /^[\d.]+$/.test(h) || /^0x/i.test(h)) return null;
  if (h.indexOf('.') < 0 || h === 'localhost' || /\.(local|localhost|internal|lan|home|ts\.net|arpa)$/.test(h)) return null;
  return u;
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/* ---------- the network (replaced in tests) ---------- */

// GET over https, no redirects followed, at most maxBytes read.
// o.address pins the connection to an address already checked.
function httpsGet(url, o) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); if (err) reject(err); else resolve(v); };
    const opts = { method: 'GET', agent: false, headers: Object.assign({ 'User-Agent': USER_AGENT }, o.headers || {}) };
    if (o.address) {
      opts.lookup = (host, lo, cb) => {
        if (lo && lo.all) cb(null, [{ address: o.address, family: o.family }]);
        else cb(null, o.address, o.family);
      };
    }
    let req;
    const timer = setTimeout(() => { finish(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })); if (req) req.destroy(); }, o.timeoutMs || TIMEOUT_MS);
    try {
      req = https.request(url, opts, (res) => {
        const len = Number(res.headers['content-length']);
        if (len > o.maxBytes) { res.destroy(); return finish(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > o.maxBytes) { res.destroy(); finish(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return; }
          chunks.push(c);
        });
        res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish(e));
        return undefined;
      });
      req.on('error', (e) => finish(e));
      req.end();
    } catch (e) {
      finish(e);
    }
  });
}

function dnsResolve(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, list) => (err ? reject(err) : resolve(list || [])));
  });
}

/* ---------- rate limits ---------- */

// Sliding windows: { perMin, perDay }. take() is false when a window is full
// or the source is blocked (after a 429).
function limiter(lim, now) {
  const stamps = [];
  let blockedUntil = 0;
  return {
    take() {
      const t = now();
      if (t < blockedUntil) return false;
      while (stamps.length && t - stamps[0] >= 24 * 3600 * 1000) stamps.shift();
      const minute = stamps.filter((s) => t - s < 60000).length;
      if (lim.perMin && minute >= lim.perMin) return false;
      if (lim.perDay && stamps.length >= lim.perDay) return false;
      stamps.push(t);
      return true;
    },
    block(ms) { blockedUntil = Math.max(blockedUntil, now() + ms); },
    used() { return stamps.length; }
  };
}

/* ---------- the sources ---------- */

const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,quantity,image_front_small_url,image_small_url,image_front_url';

function offLike(id, host) {
  return {
    id: id,
    url: (key) => 'https://' + host + '/api/v2/product/' + key + '.json?fields=' + OFF_FIELDS,
    parse: (status, json) => {
      if (status === 404) return { found: false };
      if (status === 429) return { limited: 60000 };
      if (status !== 200 || !isObj(json)) return { error: 'status ' + status };
      if (json.status !== 1 || !isObj(json.product)) return { found: false };
      const p = json.product;
      const name = cleanText(p.product_name || p.product_name_en || p.generic_name, MAX_NAME);
      const brand = cleanText(String(p.brands || '').split(',')[0], MAX_BRAND);
      if (!name && !brand) return { found: false };
      return {
        found: true,
        product: { brand: brand, name: name || brand, size: cleanText(p.quantity, MAX_SIZE) },
        images: [p.image_front_small_url, p.image_small_url, p.image_front_url].filter((x) => typeof x === 'string' && x)
      };
    }
  };
}

const UPCITEMDB = {
  id: 'upcitemdb',
  // A 13-digit key with a leading 0 is a UPC-A: send the 12 digits.
  url: (key) => 'https://api.upcitemdb.com/prod/trial/lookup?upc=' + (key.length === 13 && key[0] === '0' ? key.slice(1) : key),
  parse: (status, json) => {
    if (status === 429) {
      const code = isObj(json) ? json.code : '';
      return { limited: code === 'TOO_FAST' ? 60000 : 24 * 3600 * 1000 };
    }
    if (status === 400 || status === 404) return { found: false };
    if (status !== 200 || !isObj(json)) return { error: 'status ' + status };
    const it = Array.isArray(json.items) ? json.items.find(isObj) : null;
    if (!it) return { found: false };
    let name = cleanText(it.title, MAX_NAME);
    const brand = cleanText(it.brand, MAX_BRAND);
    if (!name && !brand) return { found: false };
    if (brand && startsWithWord(name, brand) && name.length > brand.length) name = name.slice(brand.length).trim();
    return {
      found: true,
      product: { brand: brand, name: name || brand, size: cleanText(it.size, MAX_SIZE) },
      images: (Array.isArray(it.images) ? it.images : []).filter((x) => typeof x === 'string' && x).slice(0, 2)
    };
  }
};

/* ---------- the catalog ---------- */

function createCatalog(options) {
  const opt = options || {};
  const dataDir = opt.dataDir;
  const file = path.join(dataDir, 'products.json');
  const imgDir = path.join(dataDir, 'products');
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const now = typeof opt.now === 'function' ? opt.now : Date.now;
  const request = typeof opt.request === 'function' ? opt.request : httpsGet;
  const resolve = typeof opt.resolve === 'function' ? opt.resolve : dnsResolve;
  const timeoutMs = opt.timeoutMs || TIMEOUT_MS;
  const budgetMs = opt.budgetMs || BUDGET_MS;
  const dnsMs = opt.dnsMs || DNS_MS;
  const imageMs = opt.imageMs || IMAGE_MS;
  // Wall time for the budget (tests move now() for the rate limits).
  const clock = typeof opt.clock === 'function' ? opt.clock : Date.now;
  // keep(): the codes that must never be dropped to make room (the grocery list's).
  const keep = typeof opt.keep === 'function' ? opt.keep : () => [];
  const clientLims = new Map();
  const maxProducts = opt.maxProducts || MAX_PRODUCTS;
  const enabled = opt.web !== false;

  const sources = [
    Object.assign(offLike('off', 'world.openfoodfacts.org'), { lim: limiter({ perMin: 15 }, now), serial: true }),
    Object.assign(offLike('opf', 'world.openproductsfacts.org'), { lim: limiter({ perMin: 15 }, now), serial: true }),
    Object.assign({}, UPCITEMDB, { lim: limiter({ perMin: 6, perDay: 100 }, now), serial: true })
  ];
  sources.forEach((s) => { s.queue = Promise.resolve(); });

  let products = {};
  const misses = new Map(); // key -> time the miss expires
  const refills = new Map(); // key -> time a saved item may be looked up again
  const inflight = new Map();
  let closed = false;

  // Load.
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = isObj(raw) && isObj(raw.products) ? raw.products : {};
    Object.keys(list).forEach((k) => {
      const p = cleanProduct(list[k], k);
      if (p && Object.keys(products).length < maxProducts) products[k] = p;
    });
  } catch (e) {
    if (e.code !== 'ENOENT') log('products: the catalog file could not be read (' + (e.code || 'damaged') + '); starting empty');
  }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, products: products }) + '\n');
    fs.renameSync(tmp, file);
  }

  function imageFile(key) {
    if (!isKey(key)) return null;
    for (let i = 0; i < IMAGE_EXTS.length; i++) {
      const f = path.join(imgDir, key + '.' + IMAGE_EXTS[i]);
      if (fs.existsSync(f)) return { file: f, type: IMAGE_TYPES[IMAGE_EXTS[i]] };
    }
    return null;
  }

  function dropImages(key) {
    IMAGE_EXTS.forEach((x) => { try { fs.unlinkSync(path.join(imgDir, key + '.' + x)); } catch (e) { /* none */ } });
  }

  function writeImage(key, buf, ext) {
    fs.mkdirSync(imgDir, { recursive: true });
    dropImages(key);
    const f = path.join(imgDir, key + '.' + ext);
    const tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, f);
  }

  // Room for one more: the oldest web product goes (manual ones and those
  // on the grocery list stay).
  function makeRoom() {
    if (Object.keys(products).length < maxProducts) return true;
    let kept = [];
    try { kept = keep() || []; } catch (e) { kept = []; }
    let oldest = null;
    Object.keys(products).forEach((k) => {
      const p = products[k];
      if (p.source !== 'manual' && kept.indexOf(k) < 0 && (!oldest || p.updatedAt < oldest.updatedAt)) oldest = p;
    });
    if (!oldest) return false;
    delete products[oldest.upc];
    dropImages(oldest.upc);
    return true;
  }

  function get(key) {
    return Object.prototype.hasOwnProperty.call(products, key) ? products[key] : null;
  }

  function forUpcs(keys) {
    const out = {};
    (keys || []).forEach((k) => { const p = get(k); if (p) out[k] = p; });
    return out;
  }

  const left = (deadline) => deadline - clock();

  function timeLimit(promise, ms, code) {
    let t;
    const late = new Promise((res, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timed out'), { code: code || 'TIMEOUT' })), Math.max(0, ms)); });
    return Promise.race([promise, late]).then((v) => { clearTimeout(t); return v; }, (e) => { clearTimeout(t); throw e; });
  }

  async function fetchJson(src, key, deadline) {
    const ms = Math.min(timeoutMs, left(deadline));
    if (ms < 250) return { skipped: true };
    const r = await timeLimit(Promise.resolve(request(src.url(key), { timeoutMs: ms, maxBytes: JSON_MAX, headers: { Accept: 'application/json' } })), ms);
    let json = null;
    try { json = JSON.parse(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : String(r.body || '')); } catch (e) { /* not JSON */ }
    return src.parse(r.status, json);
  }

  // One source, one at a time per source; the wait in the queue counts
  // against the lookup's budget. Never rejects.
  function ask(src, key, deadline) {
    if (left(deadline) < 250 || !src.lim.take()) return Promise.resolve({ skipped: true });
    const run = src.queue.then(() => fetchJson(src, key, deadline)).then((r) => {
      if (r.limited) { src.lim.block(r.limited); return { skipped: true }; }
      return r;
    }, (e) => ({ error: (e && e.code) || 'failed' }));
    src.queue = run.then(() => {}, () => {});
    return timeLimit(run, left(deadline)).catch(() => ({ skipped: true }));
  }

  async function downloadImage(raw, msIn) {
    const ms = Math.min(imageMs, msIn === undefined ? imageMs : msIn);
    if (ms < 250) throw Object.assign(new Error('no time left'), { code: 'TIMEOUT' });
    const until = clock() + ms;
    const u = imageUrlOk(raw);
    if (!u) throw Object.assign(new Error('picture address refused'), { code: 'REFUSED' });
    const list = await timeLimit(Promise.resolve(resolve(u.hostname)), Math.min(dnsMs, ms), 'DNS_TIMEOUT');
    const addrs = (list || []).filter((a) => a && typeof a.address === 'string');
    if (!addrs.length || !addrs.every((a) => isPublicIp(a.address))) {
      throw Object.assign(new Error('picture host is not public'), { code: 'PRIVATE' });
    }
    const rest = until - clock();
    if (rest < 250) throw Object.assign(new Error('no time left'), { code: 'TIMEOUT' });
    const r = await timeLimit(Promise.resolve(request(u.toString(), {
      timeoutMs: rest, maxBytes: WEB_IMAGE_MAX, address: addrs[0].address, family: addrs[0].family || (addrs[0].address.indexOf(':') >= 0 ? 6 : 4),
      headers: { Accept: 'image/jpeg, image/png, image/webp' }
    })), rest);
    if (r.status !== 200) throw Object.assign(new Error('picture status ' + r.status), { code: 'STATUS' });
    const ct = String((r.headers || {})['content-type'] || '').toLowerCase().split(';')[0].trim();
    const ext = sniffImage(r.body);
    if (!ext || ct !== IMAGE_TYPES[ext] && !(ext === 'jpg' && ct === 'image/jpg')) {
      throw Object.assign(new Error('not a picture'), { code: 'TYPE' });
    }
    if (r.body.length > WEB_IMAGE_MAX) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
    return { buf: r.body, ext: ext };
  }

  // A web item saved without a brand or a picture (a source had none, or a
  // picture failed) is worth one more look on a rescan; a manual one is not.
  function needsRefill(p) {
    return !!p && p.source !== 'manual' && (!p.brand || !p.image || !imageFile(p.upc));
  }

  // old: the saved item a rescan fills in (only its empty fields change).
  async function webLookup(key, old) {
    const deadline = clock() + budgetMs;
    // A change while we waited (a manual entry, another fill) wins.
    const changed = () => (old ? get(key) !== old : !!get(key));
    const oldPic = !!(old && old.image && imageFile(key));
    const said = {}; // source id -> 'none' | 'skipped' | 'error'
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const r = await ask(src, key, deadline);
      if (r.found) {
        if (changed()) return get(key);
        // A hit with no brand or no picture borrows them from the sources
        // after it (inside the same budget), so a row can say "Brand · size".
        let prod = r.product, images = oldPic ? [] : r.images.slice();
        if (old && old.brand) prod = Object.assign({}, prod, { brand: old.brand });
        for (let j = i + 1; j < sources.length && (!prod.brand || (!oldPic && !images.length)) && left(deadline) > 500; j++) {
          // UPCitemdb's 100 a day is for real misses and missing brands, not for a missing picture alone.
          if (sources[j].id === 'upcitemdb' && prod.brand) continue;
          let more = null;
          try { more = await ask(sources[j], key, deadline); } catch (e) { more = null; }
          if (!more || !more.found) continue;
          if (!prod.brand && more.product.brand) { prod = Object.assign({}, prod, { brand: more.product.brand }); }
          if (!prod.size && more.product.size) prod = Object.assign({}, prod, { size: more.product.size });
          if (!images.length) images = more.images.slice();
        }
        // The first picture that downloads, inside the budget.
        let image = null, why = images.length ? 'failed' : 'none offered';
        for (let k = 0; k < images.length && !image; k++) {
          try { image = await downloadImage(images[k], left(deadline)); } catch (e) { why = (e && e.code) || 'error'; }
        }
        if (changed()) return get(key);
        if (old) return refill(key, old, prod, image, oldPic, why);
        if (!makeRoom()) return null;
        const t = now();
        const p = { upc: key, brand: prod.brand, name: prod.name, size: prod.size, source: src.id, image: '', addedAt: t, updatedAt: t };
        if (image) {
          try { writeImage(key, image.buf, image.ext); p.image = imageUrl(key, t); } catch (e) { why = 'not saved'; log('products: could not save a picture (' + (e.code || 'error') + ')'); }
        }
        products[key] = p;
        persist();
        log('products: found on ' + src.id + ' (' + (p.brand ? 'brand' : 'no brand') + ', ' + (p.image ? 'picture' : 'no picture: ' + why) + '); catalog has ' + Object.keys(products).length);
        return p;
      }
      if (r.skipped) said[src.id] = 'skipped';
      else if (r.error) { said[src.id] = 'error'; log('products: ' + src.id + ' did not answer (' + r.error + ')'); }
      else said[src.id] = 'none';
    }
    if (old) {
      log('products: a saved item was looked up again; not found on the web');
      return get(key);
    }
    // Remembered when both open databases said no; UPCitemdb may have been
    // skipped (its limits), but not have failed.
    const trouble = Object.keys(said).some((k) => said[k] !== 'none');
    if (said.off === 'none' && said.opf === 'none' && said.upcitemdb !== 'error') {
      if (misses.size >= MAX_MISSES) {
        const t = now();
        misses.forEach((exp, k) => { if (exp <= t) misses.delete(k); });
        if (misses.size >= MAX_MISSES) misses.delete(misses.keys().next().value);
      }
      misses.set(key, now() + MISS_MS);
    }
    log('products: not found on the web' + (trouble ? ' (a source was skipped or failed)' : ''));
    return null;
  }

  // Fills only the saved item's empty brand, size and picture; its name,
  // source and added time stay.
  function refill(key, old, prod, image, oldPic, why) {
    const t = now();
    const p = Object.assign({}, old, {
      brand: old.brand || prod.brand || '',
      size: old.size || prod.size || '',
      image: oldPic ? old.image : '',
      updatedAt: t
    });
    if (image) {
      try { writeImage(key, image.buf, image.ext); p.image = imageUrl(key, t); } catch (e) { why = 'not saved'; log('products: could not save a picture (' + (e.code || 'error') + ')'); }
    }
    const gained = [];
    if (p.brand && !old.brand) gained.push('brand');
    if (p.image && !oldPic) gained.push('picture');
    if (gained.length || p.size !== old.size || p.image !== old.image) {
      products[key] = p;
      persist();
    }
    log('products: a saved item was looked up again (' + (gained.length ? 'added ' + gained.join(' and ') : 'nothing new') +
      '; ' + (p.brand ? 'brand' : 'no brand') + ', ' + (p.image ? 'picture' : 'no picture: ' + why) + ')');
    return get(key);
  }

  const has = (k) => !!get(k);

  // Per phone: at most CLIENT_PER_MIN web lookups a minute (catalog hits and
  // remembered misses are free).
  function clientOk(client) {
    if (!client) return true;
    let lim = clientLims.get(client);
    if (!lim) {
      if (clientLims.size >= 200) clientLims.delete(clientLims.keys().next().value);
      lim = limiter({ perMin: opt.clientPerMin || CLIENT_PER_MIN }, now);
      clientLims.set(client, lim);
    }
    return lim.take();
  }

  // { ok, upc, found, product }. Throws a 400 error for a bad code and a 429
  // when this client asked the web too often. o.client: the caller's address.
  function lookup(code, format, o) {
    const key = format ? normalize(code, format) : toKey(code, has);
    const have = get(key);
    if (have) {
      // A rescan of a web item missing a brand or picture looks again, at most
      // once per REFILL_MS per item and within the phone's own limit.
      const due = refills.get(key);
      if (!enabled || closed || !needsRefill(have) || (due && due > now()) || inflight.has(key) || !clientOk(o && o.client)) {
        if (inflight.has(key)) return inflight.get(key).then((prod) => ({ ok: true, upc: key, found: true, product: prod || get(key) || have }));
        return Promise.resolve({ ok: true, upc: key, found: true, product: have });
      }
      if (refills.size >= MAX_MISSES) refills.delete(refills.keys().next().value);
      refills.set(key, now() + REFILL_MS);
      const p = webLookup(key, have).catch((e) => { log('products: lookup failed (' + ((e && e.code) || 'error') + ')'); return null; })
        .then((prod) => { inflight.delete(key); return prod; });
      inflight.set(key, p);
      return p.then((prod) => ({ ok: true, upc: key, found: true, product: prod || get(key) || have }));
    }
    const miss = misses.get(key);
    if (miss && miss > now()) return Promise.resolve({ ok: true, upc: key, found: false, product: null });
    if (miss) misses.delete(key);
    if (!enabled || closed) return Promise.resolve({ ok: true, upc: key, found: false, product: null });
    if (!inflight.has(key)) {
      if (!clientOk(o && o.client)) {
        const e = new Error('too many lookups; try again in a minute');
        e.status = 429;
        throw e;
      }
      const p = webLookup(key).catch((e) => { log('products: lookup failed (' + ((e && e.code) || 'error') + ')'); return null; })
        .then((prod) => { inflight.delete(key); return prod; });
      inflight.set(key, p);
    }
    return inflight.get(key).then((prod) => ({ ok: true, upc: key, found: !!prod, product: prod }));
  }

  // A photo from the phone: data:image/jpeg;base64,..., JPEG, at most 150 KB.
  function decodePhoto(photo) {
    if (typeof photo !== 'string') throw bad('"photo" must be a data:image/jpeg;base64 address');
    const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=\s]+)$/.exec(photo);
    if (!m) throw bad('"photo" must be a data:image/jpeg;base64 address');
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    if (buf.length > PHOTO_MAX) throw bad('the photo is too large (at most 150 KB)');
    if (sniffImage(buf) !== 'jpg') throw bad('the photo is not a JPEG picture');
    return buf;
  }

  // POST /products/save: { upc, brand, name, size?, photo? } -> product.
  function save(body) {
    if (!isObj(body)) throw bad('the body must be a JSON object');
    const key = toKey(body.upc, has);
    ['brand', 'name', 'size'].forEach((f) => {
      if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') throw bad('"' + f + '" must be text');
    });
    const brand = cleanText(body.brand, MAX_BRAND);
    const name = cleanText(body.name, MAX_NAME);
    const size = cleanText(body.size, MAX_SIZE);
    if (!name) throw bad('"name" must not be empty');
    const photo = body.photo !== undefined && body.photo !== null && body.photo !== '' ? decodePhoto(body.photo) : null;
    const old = get(key);
    if (!old && !makeRoom()) throw bad('the product catalog is full (' + maxProducts + ')');
    const t = Math.max(now(), old ? old.updatedAt + 1 : 0);
    const p = { upc: key, brand: brand, name: name, size: size, source: 'manual', image: '', addedAt: old ? old.addedAt : t, updatedAt: t };
    if (photo) {
      writeImage(key, photo, 'jpg');
      p.image = imageUrl(key, t);
    } else if (old && old.image && imageFile(key)) {
      p.image = imageUrl(key, t);
    }
    products[key] = p;
    misses.delete(key);
    persist();
    log('products: saved one by hand' + (photo ? ' with a photo' : '') + '; catalog has ' + Object.keys(products).length);
    return p;
  }

  return {
    lookup: lookup,
    save: save,
    get: get,
    forUpcs: forUpcs,
    imageFile: imageFile,
    toKey: (code) => toKey(code, has),
    size: () => Object.keys(products).length,
    _sources: sources,
    _misses: misses,
    _downloadImage: downloadImage,
    close: () => { closed = true; }
  };
}

module.exports = {
  MAX_PRODUCTS: MAX_PRODUCTS,
  MAX_LINE: MAX_LINE,
  USER_AGENT: USER_AGENT,
  INVALID: INVALID,
  normalize: normalize,
  toKey: toKey,
  isKey: isKey,
  checkOk: checkOk,
  expandUpcE: expandUpcE,
  lineName: lineName,
  searchText: searchText,
  exportList: exportList,
  isPublicIp: isPublicIp,
  imageUrlOk: imageUrlOk,
  sniffImage: sniffImage,
  createCatalog: createCatalog
};
